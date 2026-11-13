import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';

type MockStaff = {
  id: string;
  name: string;
  role: 'owner' | 'admin' | 'staff';
  access_level: 'full' | 'read_only';
  permission_keys: string;
  assigned_line_account_id: string | null;
  can_access_descendant_accounts: number;
  tenant_id?: string | null;
};

/*
 * Googleのルートは長期APIキーでは通さない（restaurant-google.ts の googleAccessGuard）。
 * Google Business Profile APIのポリシーが「End users of your Business Profile APIs need
 * to manually sign in to use it.」と定めているため、このファイルのテストも本番と同じ
 * 「管理画面に人がログインした状態」＝管理セッションで呼ぶ。
 *
 * 管理セッションは生のトークンではなくハッシュで引き当てるので、登録したトークンを
 * 順に照合して返す。
 */
const authMocks = vi.hoisted(() => {
  const sessions = new Map<string, unknown>();
  async function sha256Hex(value: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  return {
    sessions,
    getStaffByApiKey: vi.fn(async (): Promise<unknown> => null),
    getStaffByAdminSession: vi.fn(async (_db: unknown, tokenHash: string): Promise<unknown> => {
      for (const [token, staff] of sessions) if ((await sha256Hex(token)) === tokenHash) return staff;
      return null;
    }),
    lineAccounts: [] as Array<Record<string, unknown>>,
  };
});

/** 管理画面にログインしたオーナー。既定のテスト利用者。 */
const OWNER_SESSION: MockStaff = {
  id: 'owner-1', name: 'オーナー', role: 'owner', access_level: 'full',
  permission_keys: '[]', assigned_line_account_id: null, can_access_descendant_accounts: 1,
};

vi.mock('@line-crm/db', async () => {
  const actual = await vi.importActual<typeof import('@line-crm/db')>('@line-crm/db');
  return {
    ...actual,
    getStaffByApiKey: authMocks.getStaffByApiKey,
    getStaffByAdminSession: authMocks.getStaffByAdminSession,
    getLineAccounts: vi.fn(async () => authMocks.lineAccounts),
    getLineAccountScopeEntries: vi.fn(async () => authMocks.lineAccounts),
  };
});

const { authMiddleware, ADMIN_SESSION_BEARER_PREFIX } = await import('../middleware/auth.js');
const { restaurantGooglePosts } = await import('./restaurant-google-posts.js');
const { encryptCredential } = await import('@line-crm/db');
type Env = import('../index.js').Env;

const TENANT = '00000000-0000-4000-8000-000000000001';
const LOCATION = 'accounts/111/locations/222';
const ENC_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
/** 2026-09-23（水）12:00 JST。 */
const NOW = new Date('2026-09-23T03:00:00.000Z');

let testDb: SqliteD1;
let env: Env['Bindings'];
let googleCalls: Array<{ url: string; init?: RequestInit }>;
let googlePostsOnGoogle: Array<Record<string, unknown>>;
let createFailStatus: number | null;
let logSpy: ReturnType<typeof vi.spyOn>;
let createSeq = 0;
/** Instagram（Graph API）側の呼び出し。本物のMetaへはつながず、ぜんぶここで受ける。 */
let instagramCalls: Array<{ url: string; init?: RequestInit }>;
/** null 以外にすると、コンテナ作成（`/media`）がそのHTTP状態で落ちる。 */
let instagramFailStatus: number | null;
/** R2 の `IMAGES` の代わり。キーごとのバイト列を持つだけ。 */
let imageStore: Map<string, Uint8Array>;
let cfImagesEnabled: boolean;
let imageTransforms: unknown[];

/**
 * instagramConfig の必須条件（v形式のバージョン・base64で32バイトの鍵・httpsのredirect）を
 * 満たす値にする。接続に使うのは Instagram アプリ側の `INSTAGRAM_*`、Webhook の署名照合に
 * 使うのが Facebook アプリ側の `META_APP_*` で、番号は互いに別。
 */
const META_ENV = {
  META_APP_ID: '100',
  META_APP_SECRET: 'secret_mock',
  INSTAGRAM_APP_ID: '200',
  INSTAGRAM_APP_SECRET: 'ig_secret_mock',
  META_REDIRECT_URI: 'https://worker.example.test/api/instagram/oauth/callback',
  META_GRAPH_API_VERSION: 'v24.0',
  META_TOKEN_ENCRYPTION_KEY: btoa('x'.repeat(32)),
} as const;

/** detectImageMeta が読める最小のJPEG（SOI + SOF0 に縦横だけ入れたもの）。 */
function jpegBytes(width = 1080, height = 1080): Uint8Array {
  const bytes = new Uint8Array(20);
  bytes.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff], 0);
  return bytes;
}

/** detectImageMeta が読める最小のPNG（署名 + IHDR の縦横だけ）。 */
function pngBytes(width = 1080, height = 1080): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  for (let i = 0; i < 4; i++) {
    bytes[16 + i] = (width >>> ((3 - i) * 8)) & 0xff;
    bytes[20 + i] = (height >>> ((3 - i) * 8)) & 0xff;
  }
  return bytes;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function seedStore(): void {
  for (const [id, name] of [['account-1', '統括'], ['account-2', '渋谷店']]) {
    testDb.raw
      .prepare(`INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret, is_active, tenant_id) VALUES (?, ?, ?, ?, ?, 1, ?)`)
      .run(id, `ch-${id}`, name, 'token', 'secret', TENANT);
  }
  testDb.raw.prepare('INSERT INTO rt_organizations (id, account_id, tenant_id, name) VALUES (?, ?, ?, ?)').run('org-1', 'account-1', TENANT, '飲食店LAB');
  testDb.raw
    .prepare('INSERT INTO rt_stores (id, organization_id, name, code, area, capacity, line_account_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('store-shibuya', 'org-1', 'こもれび食堂 渋谷店', 'SHIBUYA', '東京', 20, 'account-2');
}

async function seedConnection(): Promise<void> {
  testDb.raw
    .prepare(
      `INSERT INTO rt_google_connections
        (id, store_id, line_account_id, google_account_email, location_name, location_title, refresh_token_enc, access_token_enc, access_token_expires_at, status, connected_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run('conn-1', 'store-shibuya', 'account-2', 'owner@example.test', LOCATION, 'こもれび食堂 渋谷店', await encryptCredential('refresh-secret', ENC_KEY), await encryptCredential('access-secret', ENC_KEY), '2099-01-01T00:00:00.000Z', 'connected', '2026-09-23T00:00:00.000Z');
}

function seedMedia(id: string, filename: string, lineAccountId: string, bytes: Uint8Array = jpegBytes()): void {
  testDb.raw
    .prepare(`INSERT INTO media (id, kind, filename, mime_type, size_bytes, r2_key, line_account_id) VALUES (?, 'image', ?, 'image/jpeg', 1000, ?, ?)`)
    .run(id, filename, `images/${filename}`, lineAccountId);
  // Instagram へ出すときは中身まで読むので、R2の代わりにもバイト列を入れておく。
  imageStore.set(`images/${filename}`, bytes);
}

/**
 * Instagram の接続1件。`page_token_encrypted` は META_TOKEN_ENCRYPTION_KEY で包む
 * （Google側の ENC_KEY とは別の鍵。実装も cfg.encryptionKey で開ける）。
 */
async function seedInstagramConnection(options: { scopes?: string; expiresAt?: string; dataAccessExpiresAt?: string | null } = {}): Promise<void> {
  testDb.raw
    .prepare(
      `INSERT INTO instagram_connections
        (line_account_id, page_id, instagram_id, page_name, username, page_token_encrypted, user_token_encrypted,
         expires_at, data_access_expires_at, refreshed_at, connected_by, scopes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'account-2', 'page-1', 'ig-1', 'こもれび食堂 渋谷店', 'komorebi',
      await encryptCredential('page-secret', META_ENV.META_TOKEN_ENCRYPTION_KEY),
      await encryptCredential('user-secret', META_ENV.META_TOKEN_ENCRYPTION_KEY),
      options.expiresAt ?? '2099-01-01T00:00:00.000Z',
      options.dataAccessExpiresAt === undefined ? '2099-01-01T00:00:00.000Z' : options.dataAccessExpiresAt,
      '2026-09-23T00:00:00.000Z', 'owner-1',
      // Instagram直接ログインで保存される許可名。Facebookページ方式の
      // `instagram_basic` / `pages_show_list` は使わない。
      options.scopes ??
        'instagram_business_basic,instagram_business_content_publish',
    );
}

function app() {
  const instance = new Hono<Env>();
  instance.use('*', authMiddleware);
  instance.route('/', restaurantGooglePosts);
  return instance;
}

/** 管理セッションで呼ぶ。token は useStaffRole / OWNER_SESSION で登録したセッショントークン。 */
function call(path: string, init: { method?: string; body?: unknown; token?: string } = {}) {
  const headers: Record<string, string> = { Authorization: `Bearer ${ADMIN_SESSION_BEARER_PREFIX}${init.token ?? 'owner-session'}` };
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  return app().request(`${path}${path.includes('?') ? '&' : '?'}account_id=account-2`, { method: init.method ?? (init.body === undefined ? 'GET' : 'POST'), headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) }, env);
}

function useStaffRole(role: 'admin' | 'staff'): void {
  testDb.raw
    .prepare(`INSERT OR REPLACE INTO staff_members (id, name, role, api_key, tenant_id, account_scope, can_access_descendant_accounts, is_active) VALUES (?, ?, ?, ?, ?, 'all', 1, 1)`)
    .run(`${role}-1`, role, role, `${role}-key`, TENANT);
  authMocks.sessions.set(`${role}-session`, { id: `${role}-1`, name: role, role, access_level: 'full', permission_keys: '[]', assigned_line_account_id: null, can_access_descendant_accounts: 1 });
}

function createCalls() {
  return googleCalls.filter((x) => x.url.endsWith('/localPosts') && x.init?.method === 'POST');
}

const standardBody = { kind: 'standard', summary: '秋のおすすめ定食がはじまります。', mediaId: null };

async function createDraft(body: Record<string, unknown> = standardBody, token?: string) {
  const res = await call('/api/restaurant-test/google/posts', { body, token });
  return { status: res.status, json: (await res.json()) as { success: boolean; post?: { id: string; status: string } } };
}

async function publish(id: string, token?: string, confirmed = true) {
  const res = await call(`/api/restaurant-test/google/posts/${id}/publish`, { body: { confirmed }, token });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> & { post?: { id: string; status: string; googleState: string | null } } };
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  authMocks.getStaffByApiKey.mockReset();
  authMocks.getStaffByApiKey.mockResolvedValue(null);
  authMocks.sessions.clear();
  authMocks.sessions.set('owner-session', OWNER_SESSION);
  authMocks.lineAccounts = [
    { id: 'account-1', name: '統括', is_active: 1, channel_access_token: 'token-1' },
    { id: 'account-2', name: '渋谷店', is_active: 1, channel_access_token: 'token-2' },
  ];
  testDb = createTestD1({ loginPolicy: 'off' });
  testDb.raw.prepare(`UPDATE tenants SET feature_packs = '["restaurant"]' WHERE id = ?`).run(TENANT);
  googleCalls = [];
  googlePostsOnGoogle = [];
  createFailStatus = null;
  createSeq = 0;
  instagramCalls = [];
  instagramFailStatus = null;
  imageStore = new Map();
  imageTransforms = [];
  vi.stubGlobal(
    'fetch',
    // instagramGraph は URL オブジェクトを渡してくるので、文字列に正規化してから見分ける。
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      // Instagram直接ログイン方式の投稿は graph.instagram.com へ出る。
      if (url.startsWith('https://graph.instagram.com/')) {
        instagramCalls.push({ url, init });
        const path = new URL(url).pathname;
        if (path.endsWith('/media')) {
          if (instagramFailStatus) return jsonResponse({ error: { message: 'メタ側の生の本文', code: 190 } }, instagramFailStatus);
          return jsonResponse({ id: 'ig-container-1' });
        }
        if (path.endsWith('/media_publish')) return jsonResponse({ id: 'ig-media-1' });
        if (url.includes('fields=permalink')) return jsonResponse({ permalink: 'https://www.instagram.com/p/abc123/' });
        return jsonResponse({}, 404);
      }
      googleCalls.push({ url, init });
      if (url.endsWith('/localPosts') && init?.method === 'POST') {
        if (createFailStatus) return jsonResponse({ error: { message: 'fail' } }, createFailStatus);
        createSeq += 1;
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        const created = { name: `${LOCATION}/localPosts/p${createSeq}`, ...body, state: 'LIVE', createTime: new Date().toISOString(), searchUrl: `https://g.page/p${createSeq}` };
        googlePostsOnGoogle.push(created);
        return jsonResponse(created);
      }
      if (url.includes('/localPosts') && (!init?.method || init.method === 'GET')) {
        return jsonResponse({ localPosts: googlePostsOnGoogle });
      }
      if (url.includes('/localPosts/') && init?.method === 'DELETE') {
        const name = url.replace('https://mybusiness.googleapis.com/v4/', '');
        googlePostsOnGoogle = googlePostsOnGoogle.filter((p) => p.name !== name);
        return new Response('{}', { status: 200 });
      }
      return jsonResponse({}, 404);
    }),
  );
  env = {
    DB: testDb.db,
    API_KEY: 'owner-key',
    // instagramImageUrl が元画像を読み、変換後を置き直すので get/put だけ用意する。
    IMAGES: {
      get: vi.fn(async (key: string) => {
        const bytes = imageStore.get(key);
        return bytes ? { arrayBuffer: async () => bytes.slice().buffer } : null;
      }),
      put: vi.fn(async (key: string, value: ArrayBuffer) => {
        imageStore.set(key, new Uint8Array(value));
      }),
    } as unknown as R2Bucket,
    RAW_MAIL: {} as R2Bucket,
    ASSETS: {} as Fetcher,
    AI: { run: vi.fn(async () => ({ response: '' })) } as unknown as Ai,
    DEPLOY_ENV: 'test', RESTAURANT_TEST_ENABLED: 'true', GOOGLE_BUSINESS_ENABLED: 'true',
    LINE_CHANNEL_SECRET: 'unused', LINE_CHANNEL_ACCESS_TOKEN: 'unused',
    LIFF_URL: 'https://example.test', LINE_CHANNEL_ID: 'unused',
    LINE_LOGIN_CHANNEL_ID: 'unused', LINE_LOGIN_CHANNEL_SECRET: 'unused',
    WORKER_URL: 'https://worker.example.test',
    ADMIN_PUBLIC_URL: 'https://admin.example.test',
    LINE_CREDENTIAL_ENCRYPTION_KEY: ENC_KEY,
    GOOGLE_BUSINESS_OAUTH_CLIENT_ID: 'client-id',
    GOOGLE_BUSINESS_OAUTH_CLIENT_SECRET: 'client-secret',
    GOOGLE_BUSINESS_WRITE_ENABLED: 'true',
    ...META_ENV,
    // PNG のときだけ通る変換。JPEGのバイト列を返すだけの差し替え。
    CF_IMAGES: {
      input: () => ({
        transform: (options: unknown) => {
          imageTransforms.push(options);
          return ({
          output: async () => ({ image: () => new Blob([jpegBytes()]).stream() }),
          });
        },
      }),
    } as unknown as Env['Bindings']['CF_IMAGES'],
  } as Env['Bindings'];
  seedStore();
  await seedConnection();
});

afterEach(() => {
  vi.useRealTimers();
  logSpy.mockRestore();
});

describe('下書き（GB-4/5/6/7）', () => {
  it('下書き作成はGoogleへ通信しない', async () => {
    const r = await createDraft();
    expect(r.status).toBe(200);
    expect(r.json.post).toMatchObject({ status: 'draft' });
    expect(googleCalls).toHaveLength(0);
  });

  it('GB-8：登録メディアの画像だけを選べる（他アカウントの画像は404）', async () => {
    seedMedia('media-1', 'gaikan.jpg', 'account-2');
    seedMedia('media-other', 'other.jpg', 'account-1');
    const other = await createDraft({ ...standardBody, mediaId: 'media-other' });
    expect(other.status).toBe(404);
    const ok = await createDraft({ ...standardBody, mediaId: 'media-1' });
    expect(ok.status).toBe(200);
    const get = await call(`/api/restaurant-test/google/posts/${ok.json.post!.id}`);
    const body = (await get.json()) as { post: { media: Array<{ sourceUrl: string }> } };
    expect(body.post.media).toMatchObject([{ mediaId: 'media-1', filename: 'gaikan.jpg', sourceUrl: 'https://worker.example.test/images/images/gaikan.jpg' }]);
  });
});

describe('権限', () => {
  it('担当者は下書きを作れるが公開はできない。店舗管理者以上は公開できる', async () => {
    useStaffRole('staff');
    const draft = await createDraft(standardBody, 'staff-session');
    expect(draft.status).toBe(200);
    const staffPublish = await publish(draft.json.post!.id, 'staff-session');
    expect(staffPublish.status).toBe(403);

    useStaffRole('admin');
    const p = await publish(draft.json.post!.id, 'admin-session');
    expect(p.status).toBe(200);
  });
});

describe('書き込みガード', () => {
  it('GOOGLE_BUSINESS_WRITE_ENABLED が有効でなければ403、Googleへは接続しない', async () => {
    env.GOOGLE_BUSINESS_WRITE_ENABLED = 'false';
    const draft = await createDraft();
    const r = await publish(draft.json.post!.id);
    expect(r.status).toBe(403);
    expect((r.json as { code?: string }).code).toBe('write_disabled');
    expect(createCalls()).toHaveLength(0);
  });

  it('confirmed:false は write_disabled より先に400', async () => {
    env.GOOGLE_BUSINESS_WRITE_ENABLED = 'false';
    const draft = await createDraft();
    const r = await publish(draft.json.post!.id, undefined, false);
    expect(r.status).toBe(400);
    expect((r.json as { code?: string }).code).toBe('confirmation_required');
  });

  it('検証環境では指定アカウントの投稿作成だけを許可し、削除は止める', async () => {
    env.DEPLOY_ENV = 'staging';
    env.GOOGLE_BUSINESS_WRITE_ENABLED = 'false';
    env.GOOGLE_BUSINESS_POST_TEST_LINE_ACCOUNT_ID = 'account-2';
    const draft = await createDraft();
    const detail = await call(`/api/restaurant-test/google/posts/${draft.json.post!.id}`);
    expect(await detail.json()).toMatchObject({ writeEnabled: true });
    const published = await publish(draft.json.post!.id);
    expect(published.status).toBe(200);
    expect(createCalls()).toHaveLength(1);
    const removed = await call(`/api/restaurant-test/google/posts/${draft.json.post!.id}/remove`, {
      body: { confirmed: true },
    });
    expect(removed.status).toBe(403);
    expect((await removed.json()) as { code: string }).toMatchObject({ code: 'write_disabled' });
  });

  it.each([
    ['staging', ''],
    ['staging', 'account-1'],
    ['production', 'account-2'],
  ])('対象外では投稿も停止する（環境=%s、許可先=%s）', async (deployEnv, accountId) => {
    env.DEPLOY_ENV = deployEnv;
    env.GOOGLE_BUSINESS_WRITE_ENABLED = 'false';
    env.GOOGLE_BUSINESS_POST_TEST_LINE_ACCOUNT_ID = accountId;
    const draft = await createDraft();
    const detail = await call(`/api/restaurant-test/google/posts/${draft.json.post!.id}`);
    expect(await detail.json()).toMatchObject({ writeEnabled: false });
    const result = await publish(draft.json.post!.id);
    expect(result.status).toBe(403);
    expect(createCalls()).toHaveLength(0);
  });
});

describe('公開（GB-14）', () => {
  it('成功時はlocalPostsへのPOSTが1回、状態がpublishedになる', async () => {
    const draft = await createDraft();
    const r = await publish(draft.json.post!.id);
    expect(r.status).toBe(200);
    expect(createCalls()).toHaveLength(1);
    expect(JSON.parse(String(createCalls()[0].init?.body))).toMatchObject({ topicType: 'STANDARD', summary: standardBody.summary });
    expect(r.json.post).toMatchObject({ status: 'published', googleState: 'LIVE' });
  });

  it('予約投稿(publish_mode=scheduled)は受け付けない', async () => {
    const draft = await createDraft();
    testDb.raw.prepare(`UPDATE rt_google_posts SET publish_mode = 'scheduled' WHERE id = ?`).run(draft.json.post!.id);
    const r = await publish(draft.json.post!.id);
    expect(r.status).toBe(400);
    expect((r.json as { code?: string }).code).toBe('not_supported');
  });

  it('二重投稿しない：送信結果不明のあとGoogle側に実際は届いていた場合、次の確認で作成し直さない', async () => {
    const draft = await createDraft();
    createFailStatus = 500;
    const first = await publish(draft.json.post!.id);
    expect(first.status).toBe(502);
    expect(createCalls()).toHaveLength(1);

    // Googleには実際は届いていた（結果不明だっただけ）ことを模擬する。
    createFailStatus = null;
    const row = testDb.raw.prepare('SELECT content_fingerprint, sent_at FROM rt_google_posts WHERE id = ?').get(draft.json.post!.id) as { content_fingerprint: string; sent_at: string };
    googlePostsOnGoogle.push({ name: `${LOCATION}/localPosts/silent1`, topicType: 'STANDARD', summary: standardBody.summary, state: 'LIVE', createTime: new Date(Date.parse(row.sent_at) + 1000).toISOString(), searchUrl: 'https://g.page/silent1' });

    const second = await publish(draft.json.post!.id);
    expect(second.status).toBe(200);
    expect(second.json.alreadyPublished).toBe(true);
    expect(second.json.post).toMatchObject({ status: 'published' });
    expect(createCalls()).toHaveLength(1); // 2回目はPOSTしていない
  });

  it('別内容の投稿は、他の送信結果不明な投稿と取り違えない', async () => {
    const draftA = await createDraft({ kind: 'standard', summary: 'Aの本文です', mediaId: null });
    const draftB = await createDraft({ kind: 'standard', summary: 'Bの本文です', mediaId: null });
    createFailStatus = 500;
    await publish(draftA.json.post!.id);
    await publish(draftB.json.post!.id);
    expect(createCalls()).toHaveLength(2);

    createFailStatus = null;
    const rowA = testDb.raw.prepare('SELECT content_fingerprint, sent_at FROM rt_google_posts WHERE id = ?').get(draftA.json.post!.id) as { content_fingerprint: string; sent_at: string };
    const rowB = testDb.raw.prepare('SELECT content_fingerprint, sent_at FROM rt_google_posts WHERE id = ?').get(draftB.json.post!.id) as { content_fingerprint: string; sent_at: string };
    googlePostsOnGoogle.push({ name: `${LOCATION}/localPosts/silentA`, topicType: 'STANDARD', summary: 'Aの本文です', state: 'LIVE', createTime: new Date(Date.parse(rowA.sent_at) + 1000).toISOString() });
    googlePostsOnGoogle.push({ name: `${LOCATION}/localPosts/silentB`, topicType: 'STANDARD', summary: 'Bの本文です', state: 'LIVE', createTime: new Date(Date.parse(rowB.sent_at) + 1000).toISOString() });

    const againA = await publish(draftA.json.post!.id);
    const againB = await publish(draftB.json.post!.id);
    expect(againA.json.post).toMatchObject({ status: 'published' });
    expect(againB.json.post).toMatchObject({ status: 'published' });
    const postedNameOf = (id: string) => (testDb.raw.prepare('SELECT google_post_name FROM rt_google_posts WHERE id = ?').get(id) as { google_post_name: string }).google_post_name;
    expect(postedNameOf(draftA.json.post!.id)).toBe(`${LOCATION}/localPosts/silentA`);
    expect(postedNameOf(draftB.json.post!.id)).toBe(`${LOCATION}/localPosts/silentB`);
    expect(createCalls()).toHaveLength(2); // 追加のPOSTは発生していない
  });

  it('OFFERはevent(title+schedule)を送り、callToActionは送らない', async () => {
    const draft = await createDraft({
      kind: 'offer',
      summary: '週末のディナーで使える、お会計10%OFFの特典です。',
      title: '週末のディナーを、少しお得に',
      schedule: { startDate: '2026-10-01', startTime: '17:00', endDate: '2026-10-02', endTime: '22:00' },
      offer: { couponCode: 'AUTUMN10' },
      mediaId: null,
    });
    const r = await publish(draft.json.post!.id);
    expect(r.status).toBe(200);
    const body = JSON.parse(String(createCalls()[0].init?.body));
    expect(body.topicType).toBe('OFFER');
    expect(body.event).toMatchObject({ title: '週末のディナーを、少しお得に' });
    expect(body.callToAction).toBeUndefined();
    expect(body.offer).toMatchObject({ couponCode: 'AUTUMN10' });
  });

  it('応答に暗号化前の秘密値が含まれない', async () => {
    const draft = await createDraft();
    const r = await publish(draft.json.post!.id);
    expect(JSON.stringify(r.json)).not.toContain('refresh-secret');
    expect(JSON.stringify(r.json)).not.toContain('access-secret');
  });
});

describe('取り込み（sync）', () => {
  it('REJECTEDはrejectedとしてattentionに数え、消えた公開済みはdeletedになる', async () => {
    const deletedDraft = await createDraft({ kind: 'standard', summary: '公開済みだった投稿', mediaId: null });
    await publish(deletedDraft.json.post!.id);
    const rejectedDraft = await createDraft({ kind: 'standard', summary: '不承認になった投稿', mediaId: null });
    await publish(rejectedDraft.json.post!.id);

    // 「公開済みだった投稿」はGoogle側からもう無い（誰かが消した）。「不承認になった投稿」はGoogleの審査でREJECTEDに変わった。
    // 「Googleで直接作った投稿」は社内管理画面を経由していない（Google側で直接作られた）。
    googlePostsOnGoogle = googlePostsOnGoogle
      .filter((p) => p.name !== `${LOCATION}/localPosts/p1`)
      .map((p) => (p.name === `${LOCATION}/localPosts/p2` ? { ...p, state: 'REJECTED' } : p));
    googlePostsOnGoogle.push({ name: `${LOCATION}/localPosts/fromgoogle1`, topicType: 'STANDARD', summary: 'Googleで直接作った投稿', state: 'LIVE', createTime: NOW.toISOString() });
    const s = await call('/api/restaurant-test/google/posts/sync', { method: 'POST' });
    expect(s.status).toBe(200);

    const list = await call('/api/restaurant-test/google/posts');
    const body = (await list.json()) as { posts: Array<{ status: string; origin: string; summary: string }>; counts: Record<string, number> };
    const original = body.posts.find((p) => p.summary === '公開済みだった投稿');
    expect(original?.status).toBe('deleted');
    const rejected = body.posts.find((p) => p.summary === '不承認になった投稿');
    expect(rejected).toMatchObject({ status: 'rejected', origin: 'admin' });
    const fromGoogle = body.posts.find((p) => p.summary === 'Googleで直接作った投稿');
    expect(fromGoogle).toMatchObject({ status: 'published', origin: 'google' });
    expect(body.counts.attention).toBe(1);
  });

  it('Google側で作られた投稿の画像を取り込み、「画像なし」にしない', async () => {
    googlePostsOnGoogle.push({
      name: `${LOCATION}/localPosts/fromgoogle-img`,
      topicType: 'STANDARD',
      summary: '画像つきの投稿',
      state: 'LIVE',
      createTime: NOW.toISOString(),
      media: [{ googleUrl: 'https://lh3.googleusercontent.com/photo1' }],
    });
    const s = await call('/api/restaurant-test/google/posts/sync', { method: 'POST' });
    expect(s.status).toBe(200);

    const list = await call('/api/restaurant-test/google/posts');
    const body = (await list.json()) as { posts: Array<{ summary: string; id: string }> };
    const created = body.posts.find((p) => p.summary === '画像つきの投稿');
    expect(created).toBeTruthy();
    const get = await call(`/api/restaurant-test/google/posts/${created!.id}`);
    const detail = (await get.json()) as { post: { media: Array<{ sourceUrl: string }> } };
    expect(detail.post.media).toMatchObject([{ mediaId: '', filename: '', sourceUrl: 'https://lh3.googleusercontent.com/photo1' }]);

    // 2回目の同期でGoogle側の画像が変わっても最新化される（自己修復）。
    googlePostsOnGoogle = googlePostsOnGoogle.map((p) =>
      p.name === `${LOCATION}/localPosts/fromgoogle-img` ? { ...p, media: [{ googleUrl: 'https://lh3.googleusercontent.com/photo2' }] } : p,
    );
    const s2 = await call('/api/restaurant-test/google/posts/sync', { method: 'POST' });
    expect(s2.status).toBe(200);
    const get2 = await call(`/api/restaurant-test/google/posts/${created!.id}`);
    const detail2 = (await get2.json()) as { post: { media: Array<{ sourceUrl: string }> } };
    expect(detail2.post.media).toMatchObject([{ mediaId: '', filename: '', sourceUrl: 'https://lh3.googleusercontent.com/photo2' }]);
  });

  it('アプリ発の投稿がGoogleに反映された後も、登録メディアの参照を保持する（Google側のmedia_jsonで上書きしない）', async () => {
    seedMedia('media-own', 'mise.jpg', 'account-2');
    const draft = await createDraft({ ...standardBody, mediaId: 'media-own' });
    await publish(draft.json.post!.id);
    // 送信直後のGoogle側の応答に画像情報が含まれない（あるいは異なる）ケースでも、上書きしない。
    const s = await call('/api/restaurant-test/google/posts/sync', { method: 'POST' });
    expect(s.status).toBe(200);
    const get = await call(`/api/restaurant-test/google/posts/${draft.json.post!.id}`);
    const detail = (await get.json()) as { post: { media: Array<{ mediaId: string; sourceUrl: string }> } };
    expect(detail.post.media).toMatchObject([{ mediaId: 'media-own', filename: 'mise.jpg', sourceUrl: 'https://worker.example.test/images/images/mise.jpg' }]);
  });
});

/**
 * 本物の Instagram へ送らず、graph.instagram.com への呼出を差し替えて同時投稿を確かめる。設計図 ★V8-B U1X7T2・HEEN9 と照合する。
 */
describe('Instagram 同時投稿', () => {
  const instagramBody = { ...standardBody, mediaId: 'media-ig', instagram: { enabled: true, caption: null } };

  /** Instagram へ出す下書きを作って公開する。既定では接続も画像もそろっている。 */
  async function publishWithInstagram(body: Record<string, unknown> = instagramBody) {
    seedMedia('media-ig', 'ig.jpg', 'account-2');
    const draft = await createDraft(body);
    expect(draft.status).toBe(200);
    const p = await publish(draft.json.post!.id);
    return { id: draft.json.post!.id, status: p.status, json: p.json };
  }

  /** `publicPost` の instagram 部分。 */
  async function instagramOf(id: string) {
    const res = await call(`/api/restaurant-test/google/posts/${id}`);
    const body = (await res.json()) as { post: { status: string; instagram: Record<string, unknown> } };
    return body.post;
  }

  function graphPaths(): string[] {
    return instagramCalls.map((x) => new URL(x.url).pathname.replace('/v24.0/', ''));
  }

  it('画像を選ばずにInstagramへ出す設定にすると下書きで止める', async () => {
    const r = await createDraft({ ...standardBody, mediaId: null, instagram: { enabled: true, caption: null } });
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ error: expect.any(String), fields: { 'instagram.mediaId': expect.any(String) } });
    expect(instagramCalls).toHaveLength(0);
  });

  it.each([
    [{ enabled: true, caption: '文'.repeat(2201) }, 'instagram.caption'],
    [{ enabled: 'true', caption: null }, 'instagram.enabled'],
    [{ enabled: true, caption: 123 }, 'instagram.caption'],
  ])('Instagram の不正な入力を欄へ返し、下書きを増やさない', async (instagram, key) => {
    const r = await createDraft({ ...standardBody, mediaId: 'media-ig', instagram });
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ error: expect.any(String), fields: { [key]: expect.any(String) } });
    expect(testDb.raw.prepare('SELECT COUNT(*) AS n FROM rt_google_posts').get()).toEqual({ n: 0 });
  });

  it('Googleへの公開が成功すると、同じ写真と文章でInstagramへも出す', async () => {
    await seedInstagramConnection();
    const r = await publishWithInstagram();
    expect(r.status).toBe(200);
    // コンテナ作成 → 公開 → 見に行く先の取得、の順で呼ぶ。
    expect(graphPaths()).toEqual(['ig-1/media', 'ig-1/media_publish', 'ig-media-1']);
    const container = new URL(instagramCalls[0].url);
    expect(container.searchParams.get('caption')).toBe(standardBody.summary);
    // Metaが取りに来られる公開URLを渡す（JPEGなので元のURLのまま）。
    expect(container.searchParams.get('image_url')).toBe('https://worker.example.test/images/images/ig.jpg');
    const post = await instagramOf(r.id);
    expect(post.status).toBe('published');
    expect(post.instagram).toEqual({
      enabled: true,
      caption: null,
      mediaId: 'media-ig',
      originalMediaId: null,
      status: 'published',
      permalink: 'https://www.instagram.com/p/abc123/',
      error: null,
    });
  });

  it('GoogleとInstagramに別の画像を保存し、Instagramには専用画像を送る', async () => {
    await seedInstagramConnection();
    seedMedia('media-google', 'google.jpg', 'account-2');
    seedMedia('media-instagram', 'instagram.jpg', 'account-2');
    seedMedia('original-google', 'source-google.jpg', 'account-2');
    seedMedia('original-instagram', 'source-instagram.jpg', 'account-2');
    const draft = await createDraft({ ...standardBody, mediaId: 'media-google', mediaOriginalId: 'original-google', instagram: { enabled: true, caption: null, mediaId: 'media-instagram', originalMediaId: 'original-instagram' } });
    expect(draft.status).toBe(200);
    const detail = await call(`/api/restaurant-test/google/posts/${draft.json.post!.id}`);
    const stored = (await detail.json()) as { post: { media: Array<{ mediaId: string; originalMediaId: string }>; instagram: { mediaId: string; originalMediaId: string } } };
    expect(stored.post.media[0].mediaId).toBe('media-google');
    expect(stored.post.media[0].originalMediaId).toBe('original-google');
    expect(stored.post.instagram.mediaId).toBe('media-instagram');
    expect(stored.post.instagram.originalMediaId).toBe('original-instagram');
    const published = await publish(draft.json.post!.id);
    expect(published.status).toBe(200);
    expect(new URL(instagramCalls[0].url).searchParams.get('image_url')).toBe('https://worker.example.test/images/images/instagram.jpg');
  });

  it('Instagram専用画像が別アカウントのものなら下書きを保存しない', async () => {
    seedMedia('media-google', 'google.jpg', 'account-2');
    seedMedia('media-other', 'other.jpg', 'account-1');
    const result = await createDraft({ ...standardBody, mediaId: 'media-google', instagram: { enabled: true, caption: null, mediaId: 'media-other' } });
    expect(result.status).toBe(404);
    expect(testDb.raw.prepare('SELECT COUNT(*) AS n FROM rt_google_posts').get()).toEqual({ n: 0 });
  });

  it('再切り取り用の元画像も同じアカウントに属していることを確認する', async () => {
    seedMedia('media-google', 'google.jpg', 'account-2');
    seedMedia('media-instagram', 'instagram.jpg', 'account-2');
    seedMedia('media-other', 'source.jpg', 'account-1');
    const result = await createDraft({ ...standardBody, mediaId: 'media-google', instagram: { enabled: true, caption: null, mediaId: 'media-instagram', originalMediaId: 'media-other' } });
    expect(result.status).toBe(404);
    expect(testDb.raw.prepare('SELECT COUNT(*) AS n FROM rt_google_posts').get()).toEqual({ n: 0 });
  });

  it('検証環境の投稿専用許可でもGoogleとInstagramへ1回ずつ出す', async () => {
    env.DEPLOY_ENV = 'staging';
    env.GOOGLE_BUSINESS_WRITE_ENABLED = 'false';
    env.GOOGLE_BUSINESS_POST_TEST_LINE_ACCOUNT_ID = 'account-2';
    await seedInstagramConnection();
    const result = await publishWithInstagram();
    expect(result.status).toBe(200);
    expect(createCalls()).toHaveLength(1);
    expect(graphPaths()).toEqual(['ig-1/media', 'ig-1/media_publish', 'ig-media-1']);
    expect((await instagramOf(result.id)).instagram.status).toBe('published');
  });

  it('Instagram用の文章を入れたときはそちらを使う', async () => {
    await seedInstagramConnection();
    const r = await publishWithInstagram({ ...instagramBody, instagram: { enabled: true, caption: '秋のおすすめ定食 #ランチ' } });
    expect(r.status).toBe(200);
    expect(new URL(instagramCalls[0].url).searchParams.get('caption')).toBe('秋のおすすめ定食 #ランチ');
  });

  it('PNGはJPEGへ変換して置き直し、変換後のURLをMetaへ渡す', async () => {
    await seedInstagramConnection();
    seedMedia('media-ig', 'ig.png', 'account-2', pngBytes());
    const draft = await createDraft({ ...standardBody, mediaId: 'media-ig', instagram: { enabled: true, caption: null } });
    const p = await publish(draft.json.post!.id);
    expect(p.status).toBe(200);
    const imageUrl = new URL(instagramCalls[0].url).searchParams.get('image_url')!;
    expect(imageUrl).toMatch(/^https:\/\/worker\.example\.test\/images\/instagram-jpeg\/[0-9a-f-]+\.jpg$/);
    // 置き直した先はJPEGとして読める。元のPNGは残したまま。
    const key = imageUrl.replace('https://worker.example.test/images/', '');
    expect(imageStore.get(key)?.slice(0, 2)).toEqual(jpegBytes().slice(0, 2));
    expect(imageStore.has('images/ig.png')).toBe(true);
    expect((await instagramOf(draft.json.post!.id)).instagram.status).toBe('published');
  });

  it('縦長JPEGは写真を切らず4:5の余白付き画像にしてMetaへ渡す', async () => {
    await seedInstagramConnection();
    seedMedia('media-ig', 'ig-tall.jpg', 'account-2', jpegBytes(1024, 1536));
    const draft = await createDraft({ ...standardBody, mediaId: 'media-ig', instagram: { enabled: true, caption: null } });
    const p = await publish(draft.json.post!.id);
    expect(p.status).toBe(200);
    expect(imageTransforms).toContainEqual({ width: 1024, height: 1280, fit: 'pad', background: 'white' });
    expect(new URL(instagramCalls[0].url).searchParams.get('image_url')).toMatch(
      /^https:\/\/worker\.example\.test\/images\/instagram-jpeg\/[0-9a-f-]+\.jpg$/,
    );
    expect(imageStore.has('images/ig-tall.jpg')).toBe(true);
    expect((await instagramOf(draft.json.post!.id)).instagram.status).toBe('published');
  });

  it('Instagramだけ失敗してもGoogleの公開は残り、errorには自前のコードだけが入る', async () => {
    await seedInstagramConnection();
    instagramFailStatus = 400;
    const r = await publishWithInstagram();
    // Google側は成功なので200のまま。
    expect(r.status).toBe(200);
    const post = await instagramOf(r.id);
    expect(post.status).toBe('published');
    expect(post.instagram).toMatchObject({ enabled: true, status: 'failed', permalink: null, error: 'meta_request_failed' });
    // Metaの応答本文やトークンを残していないこと。
    expect(JSON.stringify(post.instagram)).not.toContain('メタ側の生の本文');
    expect(JSON.stringify(post.instagram)).not.toContain('page-secret');
  });

  it('Instagramをつないでいないときは instagram_not_connected で失敗に落とす', async () => {
    const r = await publishWithInstagram();
    expect((await instagramOf(r.id)).instagram.error).toBe('instagram_not_connected');
    expect(instagramCalls).toHaveLength(0);
  });

  it('投稿の許可が無い接続は instagram_publish_not_granted で失敗に落とす', async () => {
    await seedInstagramConnection({ scopes: 'instagram_business_basic' });
    const r = await publishWithInstagram();
    expect((await instagramOf(r.id)).instagram.error).toBe('instagram_publish_not_granted');
    expect(instagramCalls).toHaveLength(0);
  });

  it('期限切れの接続は meta_token_expired で失敗に落とす', async () => {
    await seedInstagramConnection({ expiresAt: '2026-09-01T00:00:00.000Z' });
    const r = await publishWithInstagram();
    expect((await instagramOf(r.id)).instagram.error).toBe('meta_token_expired');
    expect(instagramCalls).toHaveLength(0);
  });

  it('データを見に行く許可の期限が切れていても meta_token_expired で失敗に落とす', async () => {
    await seedInstagramConnection({ dataAccessExpiresAt: '2026-09-01T00:00:00.000Z' });
    const r = await publishWithInstagram();
    expect((await instagramOf(r.id)).instagram.error).toBe('meta_token_expired');
    expect(instagramCalls).toHaveLength(0);
  });

  it('「Instagramへ再送」で送り直せる', async () => {
    await seedInstagramConnection();
    instagramFailStatus = 400;
    const r = await publishWithInstagram();
    expect((await instagramOf(r.id)).instagram.status).toBe('failed');

    instagramFailStatus = null;
    instagramCalls = [];
    const retry = await call(`/api/restaurant-test/google/posts/${r.id}/instagram/retry`, { body: {} });
    expect(retry.status).toBe(200);
    const body = (await retry.json()) as { post: { status: string; instagram: Record<string, unknown> } };
    // Googleは触らない。出すのはInstagramだけ。
    expect(graphPaths()).toEqual(['ig-1/media', 'ig-1/media_publish', 'ig-media-1']);
    expect(body.post.status).toBe('published');
    expect(body.post.instagram).toMatchObject({ status: 'published', permalink: 'https://www.instagram.com/p/abc123/', error: null });
    expect(testDb.raw.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='restaurant.google.post.instagram_retry'").get()).toEqual({ n: 1 });
  });

  it('再送できない状態（公開済み・Instagramへ出さない設定・未公開）は409で断る', async () => {
    await seedInstagramConnection();
    const ok = await publishWithInstagram();
    const again = await call(`/api/restaurant-test/google/posts/${ok.id}/instagram/retry`, { body: {} });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { code: string }).code).toBe('not_retryable');

    const plain = await createDraft();
    await publish(plain.json.post!.id);
    const disabled = await call(`/api/restaurant-test/google/posts/${plain.json.post!.id}/instagram/retry`, { body: {} });
    expect(disabled.status).toBe(409);
    expect(((await disabled.json()) as { code: string }).code).toBe('instagram_disabled');

    seedMedia('media-ig2', 'ig2.jpg', 'account-2');
    const draft = await createDraft({ ...standardBody, mediaId: 'media-ig2', instagram: { enabled: true, caption: null } });
    const notPublished = await call(`/api/restaurant-test/google/posts/${draft.json.post!.id}/instagram/retry`, { body: {} });
    expect(notPublished.status).toBe(409);
    expect(((await notPublished.json()) as { code: string }).code).toBe('not_published');
  });

  it('担当者は再送できない', async () => {
    await seedInstagramConnection();
    instagramFailStatus = 400;
    const r = await publishWithInstagram();
    useStaffRole('staff');
    const res = await call(`/api/restaurant-test/google/posts/${r.id}/instagram/retry`, { body: {}, token: 'staff-session' });
    expect(res.status).toBe(403);
  });

  it('Instagramへ出さない投稿ではMetaへ一度も通信しない。返り値の形は5つで変わらない', async () => {
    await seedInstagramConnection();
    const draft = await createDraft();
    await publish(draft.json.post!.id);
    expect(instagramCalls).toHaveLength(0);
    const post = await instagramOf(draft.json.post!.id);
    expect(post.instagram).toEqual({ enabled: false, caption: null, mediaId: null, originalMediaId: null, status: 'none', permalink: null, error: null });
  });
});

describe('削除', () => {
  it('確認後に投稿の版が変わったらGoogleへ削除を送らず409を返す', async () => {
    const draft = await createDraft();
    const id = draft.json.post!.id;
    await publish(id);
    const current = testDb.raw.prepare('SELECT confirmation_revision AS revision FROM rt_google_posts WHERE id=?').get(id) as { revision: number };
    const connection = testDb.raw.prepare("SELECT id, confirmation_revision AS revision FROM rt_google_connections WHERE store_id='store-shibuya'").get() as { id: string; revision: number };
    testDb.raw.prepare('UPDATE rt_google_posts SET confirmation_revision=confirmation_revision+1 WHERE id=?').run(id);
    const response = await call(`/api/restaurant-test/google/posts/${id}/remove`, { body: { confirmed: true, expectedPostRevision: current.revision, expectedConnectionRevision: connection.revision, expectedConnectionId: connection.id } });
    expect(response.status).toBe(409);
    expect(googleCalls.some((entry) => entry.init?.method === 'DELETE')).toBe(false);
  });
  it('確認後に接続先が変わったらGoogleへ削除を送らない', async () => {
    const draft = await createDraft();
    const id = draft.json.post!.id;
    await publish(id);
    const post = testDb.raw.prepare('SELECT confirmation_revision AS revision FROM rt_google_posts WHERE id=?').get(id) as { revision: number };
    const connection = testDb.raw.prepare("SELECT id, confirmation_revision AS revision FROM rt_google_connections WHERE store_id='store-shibuya'").get() as { id: string; revision: number };
    testDb.raw.prepare("UPDATE rt_google_connections SET confirmation_revision=confirmation_revision+1 WHERE id=?").run(connection.id);
    const response = await call(`/api/restaurant-test/google/posts/${id}/remove`, { body: { confirmed: true, expectedPostRevision: post.revision, expectedConnectionRevision: connection.revision, expectedConnectionId: connection.id } });
    expect(response.status).toBe(409);
    expect(googleCalls.some((entry) => entry.init?.method === 'DELETE')).toBe(false);
  });
  it('古い確認は期限切れのトークン更新より前に断る', async () => {
    const draft = await createDraft(); const id = draft.json.post!.id; await publish(id);
    const post = testDb.raw.prepare('SELECT confirmation_revision AS revision FROM rt_google_posts WHERE id=?').get(id) as { revision: number };
    const connection = testDb.raw.prepare("SELECT id, confirmation_revision AS revision FROM rt_google_connections WHERE store_id='store-shibuya'").get() as { id: string; revision: number };
    testDb.raw.prepare("UPDATE rt_google_connections SET access_token_expires_at='2000-01-01', confirmation_revision=confirmation_revision+1 WHERE id=?").run(connection.id);
    const callsBefore = googleCalls.length;
    const response = await call(`/api/restaurant-test/google/posts/${id}/remove`, { body: { confirmed: true, expectedPostRevision: post.revision, expectedConnectionRevision: connection.revision, expectedConnectionId: connection.id } });
    expect(response.status).toBe(409);
    expect(googleCalls).toHaveLength(callsBefore);
  });
  it('期限切れでも確認した接続ならトークン更新後に削除できる', async () => {
    const draft = await createDraft(); const id = draft.json.post!.id; await publish(id);
    const post = testDb.raw.prepare('SELECT confirmation_revision AS revision FROM rt_google_posts WHERE id=?').get(id) as { revision: number };
    const connection = testDb.raw.prepare("SELECT id, confirmation_revision AS revision FROM rt_google_connections WHERE store_id='store-shibuya'").get() as { id: string; revision: number };
    testDb.raw.prepare("UPDATE rt_google_connections SET access_token_expires_at='2000-01-01' WHERE id=?").run(connection.id);
    const original = fetch;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => String(input).includes('oauth2.googleapis.com/token')
      ? jsonResponse({ access_token: 'refreshed', expires_in: 3600, scope: 'https://www.googleapis.com/auth/business.manage' })
      : original(input, init)));
    const response = await call(`/api/restaurant-test/google/posts/${id}/remove`, { body: { confirmed: true, expectedPostRevision: post.revision, expectedConnectionRevision: connection.revision, expectedConnectionId: connection.id } });
    expect(response.status).toBe(200);
    expect(googleCalls.filter((entry) => entry.init?.method === 'DELETE')).toHaveLength(1);
    expect(testDb.raw.prepare("SELECT confirmation_revision FROM rt_google_connections WHERE id=?").get(connection.id)).toEqual({ confirmation_revision: connection.revision });
  });
  it('削除の読み取り後に投稿が変わると確保できずGoogleへ送らない', async () => {
    const draft = await createDraft(); const id = draft.json.post!.id; await publish(id);
    const post = testDb.raw.prepare('SELECT confirmation_revision AS revision FROM rt_google_posts WHERE id=?').get(id) as { revision: number };
    const connection = testDb.raw.prepare("SELECT id, confirmation_revision AS revision FROM rt_google_connections WHERE store_id='store-shibuya'").get() as { id: string; revision: number };
    const original = testDb.db.prepare.bind(testDb.db);
    const spy = vi.spyOn(testDb.db, 'prepare').mockImplementation(sql => {
      if (sql.includes('UPDATE rt_google_posts SET confirmation_revision = confirmation_revision + 1') && sql.includes('EXISTS (SELECT 1 FROM rt_google_connections')) {
        testDb.raw.prepare('UPDATE rt_google_posts SET confirmation_revision=confirmation_revision+1 WHERE id=?').run(id);
      }
      return original(sql);
    });
    try {
      const response = await call(`/api/restaurant-test/google/posts/${id}/remove`, { body: { confirmed:true, expectedPostRevision:post.revision, expectedConnectionRevision:connection.revision, expectedConnectionId:connection.id } });
      expect(response.status).toBe(409);
      expect(googleCalls.some(entry => entry.init?.method === 'DELETE')).toBe(false);
      expect(testDb.raw.prepare('SELECT confirmation_revision AS revision FROM rt_google_posts WHERE id=?').get(id)).toEqual({ revision: post.revision + 1 });
    } finally { spy.mockRestore(); }
  });
  it('一致する確認は一度だけ削除できる', async () => {
    const draft = await createDraft();
    const id = draft.json.post!.id;
    await publish(id);
    const post = testDb.raw.prepare('SELECT confirmation_revision AS revision FROM rt_google_posts WHERE id=?').get(id) as { revision: number };
    const connection = testDb.raw.prepare("SELECT id, confirmation_revision AS revision FROM rt_google_connections WHERE store_id='store-shibuya'").get() as { id: string; revision: number };
    const body = { confirmed: true, expectedPostRevision: post.revision, expectedConnectionRevision: connection.revision, expectedConnectionId: connection.id };
    expect((await call(`/api/restaurant-test/google/posts/${id}/remove`, { body })).status).toBe(200);
    expect((await call(`/api/restaurant-test/google/posts/${id}/remove`, { body })).status).toBe(409);
    expect(googleCalls.filter((entry) => entry.init?.method === 'DELETE')).toHaveLength(1);
  });
  it('公開済みを削除するとGoogleへDELETEし、statusがdeletedになる', async () => {
    const draft = await createDraft();
    await publish(draft.json.post!.id);
    const r = await call(`/api/restaurant-test/google/posts/${draft.json.post!.id}/remove`, { body: { confirmed: true } });
    expect(r.status).toBe(200);
    expect(googleCalls.some((x) => x.init?.method === 'DELETE')).toBe(true);
    const body = (await r.json()) as { post: { status: string } };
    expect(body.post.status).toBe('deleted');
  });

  it('公開済みの削除も、確認なしは400・担当者は403で、GoogleへDELETEしない', async () => {
    const draft = await createDraft();
    await publish(draft.json.post!.id);
    const unconfirmed = await call(`/api/restaurant-test/google/posts/${draft.json.post!.id}/remove`, { body: { confirmed: false } });
    expect(unconfirmed.status).toBe(400);
    expect(await unconfirmed.json()).toMatchObject({ code: 'confirmation_required' });
    useStaffRole('staff');
    const byStaff = await call(`/api/restaurant-test/google/posts/${draft.json.post!.id}/remove`, { body: { confirmed: true }, token: 'staff-session' });
    expect(byStaff.status).toBe(403);
    expect(googleCalls.some((x) => x.init?.method === 'DELETE')).toBe(false);
  });
});
