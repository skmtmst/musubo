import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
    getPlatformSetting: async () => 'false', // Explicit Off fixture for route authorization.
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
  id: 'owner-1',
  name: 'オーナー',
  role: 'owner',
  access_level: 'full',
  permission_keys: '[]',
  assigned_line_account_id: null,
  can_access_descendant_accounts: 1,
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
const { restaurantGoogle } = await import('./restaurant-google.js');
const { restaurantTest } = await import('./restaurant-test.js');
const { restaurantDelivery } = await import('./restaurant-delivery.js');
const { restaurantGoogleProfile } = await import('./restaurant-google-profile.js');
const { restaurantGooglePosts } = await import('./restaurant-google-posts.js');
const { restaurantGooglePerformance } = await import('./restaurant-google-performance.js');
const { decryptCredential, encryptCredential } = await import('@line-crm/db');
type Env = import('../index.js').Env;

const TENANT = '00000000-0000-4000-8000-000000000001';
const LOCATION = 'accounts/111/locations/222';
const ENC_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

let testDb: SqliteD1;
let env: Env['Bindings'];
let googleCalls: Array<{ url: string; init?: RequestInit }>;
let googleHandler: (url: string, init?: RequestInit) => Response | Promise<Response>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function seedStore(): void {
  testDb.raw.prepare('INSERT INTO rt_organizations (id, account_id, tenant_id, name) VALUES (?, ?, ?, ?)').run('org-1', 'account-1', TENANT, '飲食店LAB');
  testDb.raw
    .prepare('INSERT INTO rt_stores (id, organization_id, name, code, area, capacity, line_account_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('store-shibuya', 'org-1', 'こもれび食堂 渋谷店', 'SHIBUYA', '東京', 20, 'account-2');
}

async function seedConnection(overrides: Partial<{ status: string; location_name: string | null; expires: string }> = {}): Promise<void> {
  testDb.raw
    .prepare(
      `INSERT INTO rt_google_connections
        (id, store_id, line_account_id, google_account_email, location_name, location_title, refresh_token_enc, access_token_enc, access_token_expires_at, status, connected_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'conn-1',
      'store-shibuya',
      'account-2',
      'owner@example.test',
      overrides.location_name === undefined ? LOCATION : overrides.location_name,
      'こもれび食堂 渋谷店',
      await encryptCredential('refresh-secret', ENC_KEY),
      await encryptCredential('access-secret', ENC_KEY),
      overrides.expires ?? '2099-01-01T00:00:00.000Z',
      overrides.status ?? 'connected',
      '2026-09-23T00:00:00.000Z',
    );
}

function app() {
  const instance = new Hono<Env>();
  instance.use('*', authMiddleware);
  instance.route('/', restaurantTest);
  instance.route('/', restaurantGoogle);
  instance.route('/', restaurantGoogleProfile);
  instance.route('/', restaurantGooglePosts);
  instance.route('/', restaurantGooglePerformance);
  instance.route('/', restaurantDelivery);
  return instance;
}

/** 管理セッションで呼ぶ。token は useStaffRole / OWNER_SESSION で登録したセッショントークン。 */
function call(path: string, init: { method?: string; body?: unknown; token?: string; cookie?: string } = {}) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${ADMIN_SESSION_BEARER_PREFIX}${init.token ?? 'owner-session'}`,
  };
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  if (init.cookie) headers.cookie = init.cookie;
  return app().request(
    path,
    { method: init.method ?? (init.body === undefined ? 'GET' : 'POST'), headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) },
    env,
  );
}

function useStaffRole(
  role: 'admin' | 'staff',
  accountScope: 'all' | 'accounts' = 'all',
  canAccessDescendantAccounts = accountScope === 'all',
): void {
  testDb.raw
    .prepare(
      `INSERT OR REPLACE INTO staff_members
         (id, name, role, api_key, tenant_id, account_scope, can_access_descendant_accounts, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
    )
    .run(`${role}-1`, role, role, `${role}-key`, TENANT, accountScope, canAccessDescendantAccounts ? 1 : 0);
  authMocks.sessions.set(`${role}-session`, {
    id: `${role}-1`, name: role, role, access_level: 'full', permission_keys: '[]', assigned_line_account_id: null, can_access_descendant_accounts: 1,
  });
}

const reviewPage = {
  reviews: [
    { name: `${LOCATION}/reviews/r1`, reviewId: 'r1', reviewer: { displayName: 'Aki' }, starRating: 'FIVE', comment: '季節の定食がおいしかった', createTime: '2026-09-23T01:42:00Z' },
    { name: `${LOCATION}/reviews/r2`, reviewId: 'r2', reviewer: { displayName: 'T.K.' }, starRating: 'THREE', comment: '営業中なのに閉まっていた', createTime: '2026-09-22T01:00:00Z' },
    { name: `${LOCATION}/reviews/r3`, reviewId: 'r3', reviewer: { displayName: 'Miki' }, starRating: 'FOUR', createTime: '2026-09-21T01:00:00Z', reviewReply: { comment: '返信済みです', updateTime: '2026-09-21T02:00:00Z' } },
  ],
  averageRating: 4.6,
  totalReviewCount: 3,
};

beforeEach(() => {
  authMocks.getStaffByApiKey.mockReset();
  authMocks.getStaffByApiKey.mockResolvedValue(null);
  authMocks.sessions.clear();
  authMocks.sessions.set('owner-session', OWNER_SESSION);
  authMocks.lineAccounts = [
    { id: 'account-1', name: '統括', is_active: 1, channel_access_token: 'token-1' },
    { id: 'account-2', name: '渋谷店', is_active: 1, channel_access_token: 'token-2' },
    { id: 'account-9', name: '他社', is_active: 1, channel_access_token: 'token-9' },
  ];
  testDb = createTestD1({ loginPolicy: 'off' });
  // 統括ゲート（飲食店機能パック）。このAPI群自体を検証するファイルなので
  // 既定の統括には常にパックを付けておく。
  testDb.raw.prepare(`UPDATE tenants SET feature_packs = '["restaurant"]' WHERE id = ?`).run(TENANT);
  googleCalls = [];
  googleHandler = () => jsonResponse({}, 404);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      googleCalls.push({ url, init });
      return googleHandler(url, init);
    }),
  );
  env = {
    DB: testDb.db,
    API_KEY: 'owner-key',
    IMAGES: {} as R2Bucket,
    RAW_MAIL: {} as R2Bucket,
    ASSETS: {} as Fetcher,
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
  } as Env['Bindings'];
});

/*
 * 受入条件8（タスク6）：お客様のスクリプト・バッチ・外部APIから、musuboの承認済み
 * Google Business Profileプロジェクトを間接的に使える経路を残さない。
 *
 * Google Business Profile APIのポリシー
 * （https://developers.google.com/my-business/content/policies、2026-08-28更新）は
 *   「End users of your Business Profile APIs need to manually sign in to use it.」
 *   「They're not allowed automatic access to make manual or programmatic changes to their accounts.」
 *   「You cannot provide indirect access to your Business Profile project.」
 * と定めている。長期間使えるAPIキー（env の API_KEY / LEGACY_API_KEY、スタッフ個別の
 * APIキー）を1本渡せば、人がログインしないままGoogleへ読み書きできてしまうので、
 * Googleのルートだけはこの入口を閉じる。ほかのAPIの鍵運用は変えない。
 */
describe('Googleビジネス：APIキーによる間接利用の遮断（受入条件8）', () => {
  /** 管理セッションの接頭辞を付けずに、生の鍵をそのままBearerで出す。外部スクリプトと同じ呼び方。 */
  function callWithApiKey(path: string, token: string, init: { method?: string; body?: unknown } = {}) {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';
    return app().request(
      path,
      { method: init.method ?? (init.body === undefined ? 'GET' : 'POST'), headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) },
      env,
    );
  }

  it('環境のAPIキーでは読み取りも書き込みも403にする', async () => {
    seedStore();
    await seedConnection();

    const read = await callWithApiKey('/api/restaurant-test/google/connection?account_id=account-2', 'owner-key');
    expect(read.status).toBe(403);
    expect((await read.json() as { error: string }).error).toContain('ログイン');

    const write = await callWithApiKey('/api/restaurant-test/google/reviews/r1/reply?account_id=account-2', 'owner-key', { body: { text: '返信します', confirmed: true } });
    expect(write.status).toBe(403);
    // Googleへは一度も出ない。
    expect(googleCalls).toHaveLength(0);
  });

  it('スタッフ個別のAPIキーでも403にする', async () => {
    seedStore();
    testDb.raw
      .prepare(
        `INSERT OR REPLACE INTO staff_members
           (id, name, role, api_key, tenant_id, account_scope, can_access_descendant_accounts, is_active)
         VALUES ('owner-2', 'オーナー2', 'owner', 'personal-key', ?, 'all', 1, 1)`,
      )
      .run(TENANT);
    authMocks.getStaffByApiKey.mockResolvedValue({
      id: 'owner-2', name: 'オーナー2', role: 'owner', access_level: 'full',
      permission_keys: '[]', assigned_line_account_id: null, can_access_descendant_accounts: 1, tenant_id: TENANT,
    });

    const response = await callWithApiKey('/api/restaurant-test/google/connection?account_id=account-2', 'personal-key');
    expect(response.status).toBe(403);
    expect(googleCalls).toHaveLength(0);
  });

  it('管理画面にログインした状態なら同じルートを通す', async () => {
    seedStore();
    const response = await call('/api/restaurant-test/google/connection?account_id=account-2');
    expect(response.status).toBe(200);
  });

  /*
   * 4つを1つのアプリに載せると、先に載せたファイルのゲートが残りの道にも掛かり、
   * 1ファイルがゲートを外しても見えない。ファイルごとに単独で載せて叩く。
   */
  it.each([
    ['restaurant-google.ts', () => restaurantGoogle, '/api/restaurant-test/google/connection?account_id=account-2'],
    ['restaurant-google-profile.ts', () => restaurantGoogleProfile, '/api/restaurant-test/google/profile?account_id=account-2'],
    ['restaurant-google-posts.ts', () => restaurantGooglePosts, '/api/restaurant-test/google/posts?account_id=account-2'],
    ['restaurant-google-performance.ts', () => restaurantGooglePerformance, '/api/restaurant-test/google/performance?account_id=account-2&days=7'],
  ] as const)('%s だけを載せても、APIキーは403で止まる', async (_file, routes, path) => {
    seedStore();
    await seedConnection();
    const single = new Hono<Env>();
    single.use('*', authMiddleware);
    single.route('/', routes());
    const response = await single.request(path, { headers: { Authorization: 'Bearer owner-key' } }, env);
    expect(response.status).toBe(403);
    expect((await response.json() as { error: string }).error).toContain('ログイン');
    expect(googleCalls).toHaveLength(0);
  });
});

describe('Googleビジネス：設定（接続）', () => {
  it('統括に飲食店機能パックが無いと、環境が有効でも404にする', async () => {
    testDb.raw.prepare(`UPDATE tenants SET feature_packs = '[]' WHERE id = ?`).run(TENANT);
    seedStore();
    const response = await call('/api/restaurant-test/google/connection?account_id=account-2');
    expect(response.status).toBe(404);
  });

  it('店舗未登録のLINEアカウントは1店舗として初期化し、接続画面を表示できる', async () => {
    testDb.raw
      .prepare(
        `INSERT INTO line_accounts
          (id, channel_id, name, channel_access_token, channel_secret, is_active, tenant_id)
         VALUES (?, ?, ?, ?, ?, 1, ?)`,
      )
      .run('account-1', 'channel-1', '然-NEN-TEST', 'token', 'secret', TENANT);

    const response = await call('/api/restaurant-test/google/connection?account_id=account-1');
    expect(response.status).toBe(200);
    const json = (await response.json()) as { store: { name: string; lineAccountId: string }; connection: { status: string } };
    expect(json.store).toMatchObject({ name: '然-NEN-TEST', lineAccountId: 'account-1' });
    expect(json.connection.status).toBe('disconnected');

    const secondResponse = await call('/api/restaurant-test/google/connection?account_id=account-1');
    expect(secondResponse.status).toBe(200);
    expect(testDb.raw.prepare('SELECT COUNT(*) AS n FROM rt_organizations WHERE tenant_id = ?').get(TENANT)).toEqual({ n: 1 });
    expect(testDb.raw.prepare('SELECT COUNT(*) AS n FROM rt_stores WHERE line_account_id = ?').get('account-1')).toEqual({ n: 1 });
  });

  it('未接続の店舗は disconnected を返し、トークンを含まない', async () => {
    seedStore();
    const response = await call('/api/restaurant-test/google/connection?account_id=account-2');
    expect(response.status).toBe(200);
    const json = (await response.json()) as { connection: { status: string }; writeEnabled: boolean; oauthConfigured: boolean; permissions: { canManageConnection: boolean; canPublishReply: boolean } };
    expect(json.connection.status).toBe('disconnected');
    expect(json.writeEnabled).toBe(true);
    expect(json.oauthConfigured).toBe(true);
    expect(json.permissions).toEqual({ canManageConnection: true, canPublishReply: true });
    expect(JSON.stringify(json)).not.toContain('secret');
  });

  it('接続権限は全店担当の統括管理者へ返し、店舗限定管理者には返さない', async () => {
    seedStore();
    useStaffRole('admin', 'all', false);
    const allowed = await call('/api/restaurant-test/google/connection?account_id=account-2', { token: 'admin-session' });
    expect(allowed.status).toBe(200);
    expect((await allowed.json() as { permissions: { canManageConnection: boolean } }).permissions.canManageConnection).toBe(true);

    useStaffRole('admin', 'accounts', true);
    testDb.raw
      .prepare('INSERT INTO staff_account_scopes (staff_id, line_account_id, created_at) VALUES (?, ?, ?)')
      .run('admin-1', 'account-2', '2026-09-25T00:00:00.000Z');
    const denied = await call('/api/restaurant-test/google/connection?account_id=account-2', { token: 'admin-session' });
    expect(denied.status).toBe(200);
    expect((await denied.json() as { permissions: { canManageConnection: boolean } }).permissions.canManageConnection).toBe(false);
  });

  it('接続開始は state を保存し、Cookie と認可URLを返す（owner と全店担当の統括管理者）', async () => {
    seedStore();
    const denied = await call('/api/restaurant-test/google/connect/start?account_id=account-2', { body: {}, token: 'admin-session' });
    expect(denied.status).toBe(401);
    // 配下アクセスは親子階層の別権限。全アカウント担当の統括管理者なら
    // このフラグが無くてもGoogle接続を管理できる。
    useStaffRole('admin', 'all', false);
    const adminAllowed = await call('/api/restaurant-test/google/connect/start?account_id=account-2', { body: {}, token: 'admin-session' });
    expect(adminAllowed.status).toBe(200);
    useStaffRole('admin', 'accounts');
    const scopedAdminDenied = await call('/api/restaurant-test/google/connect/start?account_id=account-2', { body: {}, token: 'admin-session' });
    expect(scopedAdminDenied.status).toBe(403);
    // 以降は既定のオーナーのセッションで呼ぶ。

    const response = await call('/api/restaurant-test/google/connect/start?account_id=account-2', { body: {} });
    expect(response.status).toBe(200);
    const json = (await response.json()) as { authorizeUrl: string; mode: string };
    const url = new URL(json.authorizeUrl);
    const state = url.searchParams.get('state')!;
    expect(json.mode).toBe('connect');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    // ブラウザが別のGoogleアカウントでログイン済みでも、アカウント選択画面を出す。
    expect(url.searchParams.get('prompt')).toBe('select_account consent');
    expect(response.headers.get('set-cookie')).toContain(`lh_gb_state=${state}`);
    expect(response.headers.get('set-cookie')).toContain('HttpOnly');
    const row = testDb.raw.prepare('SELECT store_id, mode, code_verifier_enc FROM rt_google_oauth_states WHERE state = ?').get(state) as { store_id: string; mode: string; code_verifier_enc: string };
    expect(row.store_id).toBe('store-shibuya');
    expect(row.code_verifier_enc.startsWith('v1.')).toBe(true);
  });

  it('リダイレクトURIは呼び出し元ホストではなく WORKER_PUBLIC_URL に固定する（redirect_uri_mismatch 防止）', async () => {
    seedStore();
    // Workerは独自ドメインでも workers.dev でも開ける。どちらから呼ばれても
    // Googleへ送るURIが1つでないと redirect_uri_mismatch になる。
    env.WORKER_PUBLIC_URL = 'https://api.example.test/';
    const response = await call('/api/restaurant-test/google/connect/start?account_id=account-2', { body: {} });
    expect(response.status).toBe(200);
    const url = new URL(((await response.json()) as { authorizeUrl: string }).authorizeUrl);
    expect(url.searchParams.get('redirect_uri')).toBe('https://api.example.test/api/restaurant-test/google/oauth/callback');
    // 未設定の環境ではこれまでどおりリクエストのoriginへ退避する。
    delete env.WORKER_PUBLIC_URL;
    const fallback = await call('/api/restaurant-test/google/connect/start?account_id=account-2', { body: {} });
    const fallbackUrl = new URL(((await fallback.json()) as { authorizeUrl: string }).authorizeUrl);
    expect(fallbackUrl.searchParams.get('redirect_uri')).toBe('http://localhost/api/restaurant-test/google/oauth/callback');
  });

  async function startAndCallback(callbackQuery: (state: string) => string, cookie?: ((state: string) => string) | null) {
    const start = await call('/api/restaurant-test/google/connect/start?account_id=account-2', { body: {} });
    const state = new URL(((await start.json()) as { authorizeUrl: string }).authorizeUrl).searchParams.get('state')!;
    const cookieHeader = cookie === null ? undefined : cookie ? cookie(state) : `lh_gb_state=${state}`;
    return call(`/api/restaurant-test/google/oauth/callback?${callbackQuery(state)}`, { cookie: cookieHeader });
  }

  it('コールバック：クロスサイト制限でCookieが無くても、DBのstate・担当者が一致すれば接続できる', async () => {
    seedStore();
    googleHandler = (url, init) => {
      if (url === 'https://oauth2.googleapis.com/token') {
        expect(String(init?.body)).toContain('code_verifier=');
        return jsonResponse({ access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600 });
      }
      if (url.startsWith('https://openidconnect.googleapis.com/v1/userinfo')) return jsonResponse({ email: 'owner@example.test' });
      if (url.startsWith('https://mybusinessaccountmanagement.googleapis.com/v1/accounts')) return jsonResponse({ accounts: [{ name: 'accounts/111' }] });
      if (url.includes('/v1/accounts/111/locations')) return jsonResponse({ locations: [{ name: 'locations/222', title: 'こもれび食堂 渋谷店', metadata: { mapsUri: 'https://maps.google.com/?cid=1' } }] });
      return jsonResponse({}, 404);
    };
    const response = await startAndCallback((state) => `state=${state}&code=auth-code`, null);
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location')!);
    expect(location.origin + location.pathname).toBe('https://admin.example.test/settings/sns');
    expect(location.searchParams.get('google')).toBe('connected');
    expect(location.searchParams.get('account_id')).toBe('account-2');

    const row = testDb.raw.prepare('SELECT * FROM rt_google_connections WHERE store_id = ?').get('store-shibuya') as Record<string, string>;
    expect(row.status).toBe('connected');
    expect(row.location_name).toBe(LOCATION);
    expect(row.google_account_email).toBe('owner@example.test');
    expect(row.refresh_token_enc.startsWith('v1.')).toBe(true);
    expect(row.refresh_token_enc).not.toContain('refresh-1');
    expect(await decryptCredential(row.refresh_token_enc, ENC_KEY)).toBe('refresh-1');
    expect(testDb.raw.prepare('SELECT used_at FROM rt_google_oauth_states').get()).toMatchObject({ used_at: expect.any(String) });
    expect(testDb.raw.prepare('SELECT COUNT(*) AS n FROM rt_google_write_log WHERE kind = ?').get('connect')).toEqual({ n: 1 });
  });

  it('コールバック：Cookie の state が違えば保存しない', async () => {
    seedStore();
    const response = await startAndCallback((state) => `state=${state}&code=auth-code`, () => 'lh_gb_state=other');
    expect(response.status).toBe(302);
    expect(new URL(response.headers.get('location')!).searchParams.get('google')).toBe('error:invalid_state');
    expect(googleCalls).toHaveLength(0);
    expect(testDb.raw.prepare('SELECT COUNT(*) AS n FROM rt_google_connections').get()).toEqual({ n: 0 });
  });

  /*
   * 同意画面では権限ごとにチェックを外せる。business.manage を外したまま接続できると
   * 「連携済みなのに全部403」になるので、接続時と更新時の両方で止める。
   */
  it('コールバック：business.manage を外した同意では接続を保存しない', async () => {
    seedStore();
    googleHandler = (url) => {
      if (url === 'https://oauth2.googleapis.com/token') {
        return jsonResponse({ access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600, scope: 'openid email' });
      }
      // 許可の確かめが無ければ接続まで進めてしまう応答をそろえておく。
      if (url.startsWith('https://openidconnect.googleapis.com/v1/userinfo')) return jsonResponse({ email: 'owner@example.test' });
      if (url.startsWith('https://mybusinessaccountmanagement.googleapis.com/v1/accounts')) return jsonResponse({ accounts: [{ name: 'accounts/111' }] });
      if (url.includes('/v1/accounts/111/locations')) return jsonResponse({ locations: [{ name: 'locations/222', title: 'こもれび食堂 渋谷店', metadata: { mapsUri: 'https://maps.google.com/?cid=1' } }] });
      return jsonResponse({}, 404);
    };
    const response = await startAndCallback((state) => `state=${state}&code=auth-code`);
    expect(response.status).toBe(302);
    expect(new URL(response.headers.get('location')!).searchParams.get('google')).toBe('error:no_permission');
    expect(googleCalls.map((entry) => entry.url)).toEqual(['https://oauth2.googleapis.com/token']);
    expect(testDb.raw.prepare("SELECT COUNT(*) AS n FROM rt_google_connections WHERE status = 'connected'").get()).toEqual({ n: 0 });
  });

  it('更新：連携後に business.manage だけ取り消されたら、同期で使わずに止める', async () => {
    seedStore();
    await seedConnection({ expires: '2000-01-01T00:00:00.000Z' });
    googleHandler = (url) => (url === 'https://oauth2.googleapis.com/token'
      ? jsonResponse({ access_token: 'access-2', expires_in: 3600, scope: 'openid email' })
      : jsonResponse({ reviews: [] }));
    const response = await call('/api/restaurant-test/google/reviews/sync?account_id=account-2', { body: {} });
    expect(response.status).not.toBe(200);
    expect(await response.json()).toMatchObject({ code: 'no_permission' });
    expect(googleCalls.filter((entry) => entry.url !== 'https://oauth2.googleapis.com/token')).toHaveLength(0);
  });

  it('コールバック：店舗が複数なら候補を保存して選択待ちにし、選択で接続済みになる', async () => {
    seedStore();
    googleHandler = (url) => {
      if (url === 'https://oauth2.googleapis.com/token') return jsonResponse({ access_token: 'a', refresh_token: 'r', expires_in: 3600 });
      if (url.includes('userinfo')) return jsonResponse({ email: 'owner@example.test' });
      if (url.startsWith('https://mybusinessaccountmanagement.googleapis.com/v1/accounts')) return jsonResponse({ accounts: [{ name: 'accounts/111' }] });
      if (url.includes('/locations')) return jsonResponse({ locations: [{ name: 'locations/222', title: '渋谷店', metadata: { mapsUri: 'https://maps.google.com/?cid=222' } }, { name: 'locations/333', title: '新宿店', metadata: { mapsUri: 'https://maps.google.com/?cid=333' } }] });
      return jsonResponse({}, 404);
    };
    const response = await startAndCallback((state) => `state=${state}&code=c`);
    expect(new URL(response.headers.get('location')!).searchParams.get('google')).toBe('select_location');
    const connection = await call('/api/restaurant-test/google/connection?account_id=account-2');
    const json = (await connection.json()) as { connection: { status: string }; candidates: Array<{ locationName: string }> };
    expect(json.connection.status).toBe('pending_location');
    expect(json.candidates.map((c) => c.locationName)).toEqual(['accounts/111/locations/333', 'accounts/111/locations/222']);

    const bad = await call('/api/restaurant-test/google/connect/select-location?account_id=account-2', { body: { locationName: 'accounts/999/locations/1' } });
    expect(bad.status).toBe(400);
    const ok = await call('/api/restaurant-test/google/connect/select-location?account_id=account-2', { body: { locationName: 'accounts/111/locations/222' } });
    expect(ok.status).toBe(200);
    expect(testDb.raw.prepare('SELECT status, location_title, location_maps_url FROM rt_google_connections').get()).toEqual({ status: 'connected', location_title: '渋谷店', location_maps_url: 'https://maps.google.com/?cid=222' });
    expect(testDb.raw.prepare('SELECT COUNT(*) AS n FROM rt_google_location_candidates').get()).toEqual({ n: 0 });
  });

  it('再接続：以前の店舗を持たないアカウントでも店舗選択へ進み、確認したときだけ切り替えて前の店舗のデータを消す', async () => {
    seedStore();
    await seedConnection();
    testDb.raw.prepare(`UPDATE rt_google_connections SET average_rating = 4.5, total_review_count = 12, last_synced_at = '2026-09-30T00:00:00Z'`).run();
    testDb.raw.prepare(`INSERT INTO rt_google_reviews (id, store_id, review_name, star_rating, create_time) VALUES ('rv-old', 'store-shibuya', ?, 5, '2026-09-01T00:00:00Z')`).run(`${LOCATION}/reviews/r1`);
    googleHandler = (url) => {
      if (url === 'https://oauth2.googleapis.com/token') return jsonResponse({ access_token: 'a2', refresh_token: 'r2', expires_in: 3600 });
      if (url.includes('userinfo')) return jsonResponse({ email: 'other@example.test' });
      if (url.startsWith('https://mybusinessaccountmanagement.googleapis.com/v1/accounts')) return jsonResponse({ accounts: [{ name: 'accounts/555' }] });
      if (url.includes('/locations')) return jsonResponse({ locations: [{ name: 'locations/777', title: '別の店' }] });
      return jsonResponse({}, 404);
    };
    const start = await call('/api/restaurant-test/google/connect/start?account_id=account-2', { body: {} });
    expect(((await start.json()) as { mode: string }).mode).toBe('reconnect');
    const response = await startAndCallback((state) => `state=${state}&code=c`);
    expect(new URL(response.headers.get('location')!).searchParams.get('google')).toBe('select_location');
    const row = testDb.raw.prepare('SELECT status, location_name, location_title, google_account_email, refresh_token_enc FROM rt_google_connections').get() as Record<string, string>;
    // 前の店舗はまだ残したまま「選択待ち」にする（切り替え確認の表示に使う）。
    expect(row.status).toBe('pending_location');
    expect(row.location_name).toBe(LOCATION);
    expect(row.google_account_email).toBe('other@example.test');
    expect(await decryptCredential(row.refresh_token_enc, ENC_KEY)).toBe('r2');
    const candidates = testDb.raw.prepare('SELECT location_name FROM rt_google_location_candidates').all() as Array<{ location_name: string }>;
    expect(candidates.map((candidate) => candidate.location_name)).toEqual(['accounts/555/locations/777']);

    // 確認なしでは切り替えない。
    const unconfirmed = await call('/api/restaurant-test/google/connect/select-location?account_id=account-2', {
      body: { locationName: 'accounts/555/locations/777' },
    });
    expect(unconfirmed.status).toBe(400);
    expect(((await unconfirmed.json()) as { code?: string }).code).toBe('switch_confirmation_required');
    expect(testDb.raw.prepare('SELECT COUNT(*) AS n FROM rt_google_reviews').get()).toEqual({ n: 1 });

    const confirmedConnection = testDb.raw.prepare('SELECT id, confirmation_revision AS revision FROM rt_google_connections').get() as { id: string; revision: number };
    const confirmed = await call('/api/restaurant-test/google/connect/select-location?account_id=account-2', {
      body: { locationName: 'accounts/555/locations/777', confirmSwitch: true, expectedConnectionId: confirmedConnection.id, expectedConfirmationRevision: confirmedConnection.revision },
    });
    expect(confirmed.status).toBe(200);
    expect(
      testDb.raw.prepare('SELECT status, location_name, location_title, average_rating, total_review_count, last_synced_at FROM rt_google_connections').get(),
    ).toEqual({
      status: 'connected',
      location_name: 'accounts/555/locations/777',
      location_title: '別の店',
      average_rating: null,
      total_review_count: null,
      last_synced_at: null,
    });
    // 前の店舗の取り込み済みデータは消す。切り替えの記録は残す。
    expect(testDb.raw.prepare('SELECT COUNT(*) AS n FROM rt_google_reviews').get()).toEqual({ n: 0 });
    expect(testDb.raw.prepare('SELECT COUNT(*) AS n FROM rt_google_location_candidates').get()).toEqual({ n: 0 });
    const log = testDb.raw.prepare(`SELECT kind, target_name, before_text, result FROM rt_google_write_log WHERE result = 'accepted' ORDER BY created_at DESC`).get() as Record<string, string>;
    expect(log).toMatchObject({ kind: 'reconnect', target_name: 'accounts/555/locations/777', before_text: LOCATION });
  });

  it('接続解除は確認が必須。Googleから受け取ったものは消し、自分たちの送信記録は残す', async () => {
    seedStore();
    await seedConnection();
    testDb.raw.prepare(`INSERT INTO rt_google_reviews (id, store_id, review_name, star_rating, create_time) VALUES ('rv-1', 'store-shibuya', ?, 5, '2026-09-01T00:00:00Z')`).run(`${LOCATION}/reviews/r1`);
    testDb.raw
      .prepare(
        `INSERT INTO rt_google_write_log (id, store_id, kind, target_name, before_text, after_text, result)
         VALUES ('wl-1', 'store-shibuya', 'review_reply', ?, '前の返信文', 'ありがとうございます', 'accepted')`,
      )
      .run(`${LOCATION}/reviews/r1`);
    googleHandler = () => jsonResponse({});
    const unconfirmed = await call('/api/restaurant-test/google/disconnect?account_id=account-2', { body: {} });
    expect(unconfirmed.status).toBe(400);
    const response = await call('/api/restaurant-test/google/disconnect?account_id=account-2', { body: { confirmed: true } });
    expect(response.status).toBe(200);
    expect(googleCalls[0].url).toBe('https://oauth2.googleapis.com/revoke');
    // 公開中の個人情報の取扱い第6項「接続を解除した場合は保存している連携情報を削除します」を
    // 実装で満たす。トークンだけでなくGoogleアカウントのメール・店舗名まで消す。
    const row = testDb.raw
      .prepare(
        'SELECT status, refresh_token_enc, access_token_enc, location_name, google_account_email FROM rt_google_connections',
      )
      .get();
    expect(row).toEqual({
      status: 'disconnected',
      refresh_token_enc: null,
      access_token_enc: null,
      location_name: null,
      google_account_email: null,
    });
    expect(testDb.raw.prepare('SELECT COUNT(*) AS n FROM rt_google_reviews').get()).toEqual({ n: 0 });
    // 誰がいつ何を送ったかの記録は残す。送信前のGoogle側スナップショットだけ消す。
    const logs = testDb.raw
      .prepare(`SELECT kind, before_text FROM rt_google_write_log ORDER BY created_at, id`)
      .all() as Array<{ kind: string; before_text: string | null }>;
    expect(logs.map((log) => log.kind).sort()).toEqual(['disconnect', 'review_reply']);
    expect(logs.every((log) => log.before_text === null)).toBe(true);
  });

  it('古い接続の確認では解除せずGoogleへ通知しない', async () => {
    seedStore();
    await seedConnection();
    const conn = testDb.raw.prepare('SELECT id, confirmation_revision AS revision FROM rt_google_connections').get() as { id: string; revision: number };
    testDb.raw.prepare('UPDATE rt_google_connections SET confirmation_revision = confirmation_revision + 1 WHERE id = ?').run(conn.id);
    const result = await call('/api/restaurant-test/google/disconnect?account_id=account-2', { body: { confirmed: true, expectedConnectionId: conn.id, expectedConfirmationRevision: conn.revision } });
    expect(result.status).toBe(409);
    expect(googleCalls).toHaveLength(0);
    expect(testDb.raw.prepare('SELECT status FROM rt_google_connections').get()).toEqual({ status: 'connected' });
  });

  it('古い接続の確認では店舗を切り替えず既存データを消さない', async () => {
    seedStore();
    await seedConnection({ status: 'pending_location' });
    testDb.raw.prepare("INSERT INTO rt_google_location_candidates(id,store_id,location_name,location_title) VALUES('candidate','store-shibuya','accounts/555/locations/777','別の店')").run();
    testDb.raw.prepare("INSERT INTO rt_google_reviews(id,store_id,review_name,star_rating,create_time) VALUES('review','store-shibuya','review/1',5,'2026-01-01')").run();
    const conn = testDb.raw.prepare('SELECT id, confirmation_revision AS revision FROM rt_google_connections').get() as { id: string; revision: number };
    testDb.raw.prepare('UPDATE rt_google_connections SET confirmation_revision=confirmation_revision+1 WHERE id=?').run(conn.id);
    googleHandler = (url) => url.startsWith('https://mybusinessaccountmanagement.googleapis.com/v1/accounts')
      ? jsonResponse({ accounts: [{ name: 'accounts/555' }] })
      : jsonResponse({ locations: [{ name: 'locations/777', title: '別の店' }] });
    const result = await call('/api/restaurant-test/google/connect/select-location?account_id=account-2', {
      body: { locationName: 'accounts/555/locations/777', confirmSwitch: true, expectedConnectionId: conn.id, expectedConfirmationRevision: conn.revision },
    });
    expect(result.status).toBe(409);
    expect(testDb.raw.prepare('SELECT COUNT(*) AS n FROM rt_google_reviews').get()).toEqual({ n: 1 });
  });

  it('店舗確認の途中に接続が変われば古い店舗のデータを消さない', async () => {
    seedStore();
    await seedConnection({ status: 'pending_location' });
    testDb.raw.prepare("INSERT INTO rt_google_location_candidates(id,store_id,location_name,location_title) VALUES('candidate','store-shibuya','accounts/555/locations/777','別の店')").run();
    testDb.raw.prepare("INSERT INTO rt_google_reviews(id,store_id,review_name,star_rating,create_time) VALUES('review','store-shibuya','review/1',5,'2026-01-01')").run();
    const conn = testDb.raw.prepare('SELECT id, confirmation_revision AS revision FROM rt_google_connections').get() as { id: string; revision: number };
    googleHandler = (url) => {
      if (url.startsWith('https://mybusinessaccountmanagement.googleapis.com/v1/accounts')) return jsonResponse({ accounts: [{ name: 'accounts/555' }] });
      testDb.raw.prepare('UPDATE rt_google_connections SET confirmation_revision=confirmation_revision+1 WHERE id=?').run(conn.id);
      return jsonResponse({ locations: [{ name: 'locations/777', title: '別の店' }] });
    };
    const result = await call('/api/restaurant-test/google/connect/select-location?account_id=account-2', {
      body: { locationName: 'accounts/555/locations/777', confirmSwitch: true, expectedConnectionId: conn.id, expectedConfirmationRevision: conn.revision },
    });
    expect(result.status).toBe(409);
    expect(testDb.raw.prepare('SELECT COUNT(*) AS n FROM rt_google_reviews').get()).toEqual({ n: 1 });
  });

  it('確認した接続の版が一致すれば解除できる', async () => {
    seedStore();
    await seedConnection();
    const conn = testDb.raw.prepare('SELECT id, confirmation_revision AS revision FROM rt_google_connections').get() as { id: string; revision: number };
    googleHandler = () => jsonResponse({});
    const body = { confirmed: true, expectedConnectionId: conn.id, expectedConfirmationRevision: conn.revision };
    expect((await call('/api/restaurant-test/google/disconnect?account_id=account-2', { body })).status).toBe(200);
    expect((await call('/api/restaurant-test/google/disconnect?account_id=account-2', { body })).status).toBe(409);
    expect(testDb.raw.prepare('SELECT status FROM rt_google_connections').get()).toEqual({ status: 'disconnected' });
  });

  it('解除の途中で別の接続に変わったら新しい接続を消さない', async () => {
    seedStore();
    await seedConnection();
    const conn = testDb.raw.prepare('SELECT id, confirmation_revision AS revision FROM rt_google_connections').get() as { id: string; revision: number };
    googleHandler = () => {
      testDb.raw.prepare("UPDATE rt_google_connections SET confirmation_revision=confirmation_revision+1, location_name='new-location' WHERE id=?").run(conn.id);
      return jsonResponse({});
    };
    const response = await call('/api/restaurant-test/google/disconnect?account_id=account-2', { body: { confirmed: true, expectedConnectionId: conn.id, expectedConfirmationRevision: conn.revision } });
    expect(response.status).toBe(409);
    expect(testDb.raw.prepare('SELECT status,location_name FROM rt_google_connections').get()).toEqual({ status: 'connected', location_name: 'new-location' });
  });

  it('別テナントの範囲外 LINE アカウントは 403', async () => {
    seedStore();
    authMocks.lineAccounts = authMocks.lineAccounts.filter((account) => account.id !== 'account-2');
    const response = await call('/api/restaurant-test/google/connection?account_id=account-2');
    expect(response.status).toBe(403);
  });
});

describe('Googleビジネス：口コミ', () => {
  it('同期は最後のページまで取得し、2回目でも件数が増えない。★3以下は要確認', async () => {
    seedStore();
    await seedConnection();
    googleHandler = (url) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('/reviews')) {
        if (parsed.searchParams.get('pageToken') === 'p2') return jsonResponse({ reviews: [{ name: `${LOCATION}/reviews/r4`, reviewId: 'r4', starRating: 'ONE', comment: 'x', createTime: '2026-09-20T00:00:00Z' }], averageRating: 4.6, totalReviewCount: 4 });
        return jsonResponse({ ...reviewPage, totalReviewCount: 4, nextPageToken: 'p2' });
      }
      return jsonResponse({}, 404);
    };
    const first = await call('/api/restaurant-test/google/reviews/sync?account_id=account-2', { body: {} });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ fetched: 4, complete: true, averageRating: 4.6, totalReviewCount: 4 });
    expect(googleCalls.every((call) => (call.init?.headers as Record<string, string>).authorization === 'Bearer access-secret')).toBe(true);
    const second = await call('/api/restaurant-test/google/reviews/sync?account_id=account-2', { body: {} });
    expect(second.status).toBe(200);
    expect(testDb.raw.prepare('SELECT COUNT(*) AS n FROM rt_google_reviews').get()).toEqual({ n: 4 });
    expect(testDb.raw.prepare('SELECT COUNT(*) AS n FROM rt_google_reviews WHERE needs_attention = 1').get()).toEqual({ n: 2 });
    expect(testDb.raw.prepare(`SELECT reply_status FROM rt_google_reviews WHERE review_name = ?`).get(`${LOCATION}/reviews/r3`)).toEqual({ reply_status: 'published' });
    expect(testDb.raw.prepare('SELECT average_rating, total_review_count FROM rt_google_connections').get()).toEqual({ average_rating: 4.6, total_review_count: 4 });

    const connection = await call('/api/restaurant-test/google/connection?account_id=account-2');
    expect(await connection.json()).toMatchObject({
      summary: {
        unrepliedCount: 3,
        draftCount: 0,
        attentionCount: 2,
        storedCount: 4,
      },
    });
  });

  it('同期：期限切れのアクセストークンは更新してから使い、invalid_grant なら認可切れにする', async () => {
    seedStore();
    await seedConnection({ expires: '2000-01-01T00:00:00.000Z' });
    googleHandler = (url) => (url === 'https://oauth2.googleapis.com/token' ? jsonResponse({ error: 'invalid_grant' }, 400) : jsonResponse({}, 500));
    const response = await call('/api/restaurant-test/google/reviews/sync?account_id=account-2', { body: {} });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'auth_expired' });
    expect(testDb.raw.prepare('SELECT status FROM rt_google_connections').get()).toEqual({ status: 'expired' });
  });

  it('同期：429 が続いても前回の口コミを消さない', async () => {
    seedStore();
    await seedConnection();
    testDb.raw.prepare(`INSERT INTO rt_google_reviews (id, store_id, review_name, star_rating, create_time) VALUES ('rv-1', 'store-shibuya', ?, 5, '2026-09-01T00:00:00Z')`).run(`${LOCATION}/reviews/r1`);
    googleHandler = () => jsonResponse({}, 429);
    const response = await call('/api/restaurant-test/google/reviews/sync?account_id=account-2', { body: {} });
    expect(response.status).toBe(503);
    expect(testDb.raw.prepare('SELECT COUNT(*) AS n FROM rt_google_reviews').get()).toEqual({ n: 1 });
    expect(testDb.raw.prepare('SELECT status, last_sync_error FROM rt_google_connections').get()).toEqual({ status: 'connected', last_sync_error: 'rate_limited' });
  }, 20_000);

  async function seedReviews(): Promise<void> {
    seedStore();
    await seedConnection();
    googleHandler = (url) => (new URL(url).pathname.endsWith('/reviews') ? jsonResponse(reviewPage) : jsonResponse({}, 404));
    await call('/api/restaurant-test/google/reviews/sync?account_id=account-2', { body: {} });
    googleCalls = [];
  }

  it('一覧：既定は未返信、絞り込みと検索が効く。別店舗のIDは404', async () => {
    await seedReviews();
    const unreplied = (await (await call('/api/restaurant-test/google/reviews?account_id=account-2')).json()) as { reviews: Array<{ reviewName: string }>; total: number };
    expect(unreplied.total).toBe(2);
    const all = (await (await call('/api/restaurant-test/google/reviews?account_id=account-2&filter=all&order=rating_low')).json()) as { reviews: Array<{ starRating: number }> };
    expect(all.reviews.map((r) => r.starRating)).toEqual([3, 4, 5]);
    const searched = (await (await call('/api/restaurant-test/google/reviews?account_id=account-2&filter=all&q=閉まって')).json()) as { total: number };
    expect(searched.total).toBe(1);
    const attention = (await (await call('/api/restaurant-test/google/reviews?account_id=account-2&filter=attention')).json()) as { total: number };
    expect(attention.total).toBe(1);
    const missing = await call('/api/restaurant-test/google/reviews/no-such?account_id=account-2');
    expect(missing.status).toBe(404);
  });

  it('並び替え：編集された口コミは編集後の日時で新しい側に並ぶ', async () => {
    await seedReviews();
    // 2026-09-22 に投稿された口コミが 2026-09-30 に書き直された状態。
    testDb.raw.prepare('UPDATE rt_google_reviews SET update_time = ? WHERE review_name = ?').run('2026-09-30T05:00:00Z', `${LOCATION}/reviews/r2`);
    const list = (await (await call('/api/restaurant-test/google/reviews?account_id=account-2&filter=all')).json()) as { reviews: Array<{ reviewName: string; createTime: string | null; updateTime: string | null }> };
    expect(list.reviews.map((r) => r.reviewName)).toEqual([`${LOCATION}/reviews/r2`, `${LOCATION}/reviews/r1`, `${LOCATION}/reviews/r3`]);
    expect(list.reviews[0]).toMatchObject({ createTime: '2026-09-22T01:00:00Z', updateTime: '2026-09-30T05:00:00Z' });
    const oldest = (await (await call('/api/restaurant-test/google/reviews?account_id=account-2&filter=all&order=oldest')).json()) as { reviews: Array<{ reviewName: string }> };
    expect(oldest.reviews.map((r) => r.reviewName)).toEqual([`${LOCATION}/reviews/r3`, `${LOCATION}/reviews/r1`, `${LOCATION}/reviews/r2`]);
  });

  function reviewIdOf(reviewId: string): string {
    return (testDb.raw.prepare('SELECT id FROM rt_google_reviews WHERE review_name = ?').get(`${LOCATION}/reviews/${reviewId}`) as { id: string }).id;
  }

  beforeEach(()=>{testDb.raw.prepare("INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret,tenant_id) VALUES('account-2','test-2','店','','',?)").run(TENANT);testDb.raw.exec("INSERT INTO account_ai_features(account_id,feature,enabled,consent_by,consent_at,disclosure_version) VALUES('account-2','google_review',1,'owner-1','2026-10-16','2026-10-16')");});

  it('事前設定なしでも、ボタンからの生成要求だけで下書きを作る',async()=>{
    await seedReviews();
    const run=vi.fn(async()=>({response:'ご来店ありがとうございます。'}));env.AI={run} as unknown as Ai;
    testDb.raw.exec("DELETE FROM account_ai_features");googleCalls=[];
    const response=await call(`/api/restaurant-test/google/reviews/${reviewIdOf('r1')}/draft/generate?account_id=account-2`,{body:{}});
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({draft:'ご来店ありがとうございます。',aiGenerated:true});
    expect(run).toHaveBeenCalledTimes(1);
    expect(googleCalls).toHaveLength(0);
    expect(testDb.raw.prepare('SELECT reply_status, reply_draft FROM rt_google_reviews WHERE review_name = ?').get(`${LOCATION}/reviews/r1`)).toEqual({reply_status:'draft',reply_draft:'ご来店ありがとうございます。'});
  });

  it('AI下書き：投稿者名を送らず、生成文を下書きとして保存する。staff も使える', async () => {
    await seedReviews();
    const run = vi.fn(async () => ({ response: 'お客様、このたびはご来店ありがとうございます。' }));
    env.AI = { run } as unknown as Ai;
    useStaffRole('staff');
    const response = await call(`/api/restaurant-test/google/reviews/${reviewIdOf('r1')}/draft/generate?account_id=account-2`, { body: {}, token: 'staff-session' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ draft: 'お客様、このたびはご来店ありがとうございます。', aiGenerated: true });
    const payload = JSON.stringify(run.mock.calls[0]);
    expect(payload).toContain('季節の定食');
    expect(payload).not.toContain('Aki');
    expect(testDb.raw.prepare('SELECT reply_status, reply_draft_ai_generated FROM rt_google_reviews WHERE review_name = ?').get(`${LOCATION}/reviews/r1`)).toEqual({ reply_status: 'draft', reply_draft_ai_generated: 1 });
  });

  it('本文のない従来の生成リクエストも受け付ける',async()=>{
    await seedReviews();env.AI={run:vi.fn(async()=>({response:'ご来店ありがとうございます。'}))} as unknown as Ai;
    expect((await call(`/api/restaurant-test/google/reviews/${reviewIdOf('r1')}/draft/generate?account_id=account-2`,{method:'POST'})).status).toBe(200);
  });

  it.each(['shorten','polite'])('AIで%s：編集中の下書きを使い、Googleへ送らず保存する',async(mode)=>{
    await seedReviews();
    const run=vi.fn(async()=>({response:'ご来店ありがとうございます。'}));env.AI={run} as unknown as Ai;
    const response=await call(`/api/restaurant-test/google/reviews/${reviewIdOf('r1')}/draft/generate?account_id=account-2`,{body:{mode,replyDraft:'ご来店ありがとうございました。またのご来店を心よりお待ちしています。'}});
    expect(response.status).toBe(200);expect(await response.json()).toMatchObject({draft:'ご来店ありがとうございます。'});
    const payload=JSON.stringify(run.mock.calls[0]);
    expect(payload).toContain('整える下書き');expect(payload).toContain(mode==='shorten'?'元の文より短く':'自然で丁寧');
    expect(payload).not.toContain('Aki');
  });

  it('AI整形は不正な入力と生成中の他の保存を拒み、元の文を残す',async()=>{
    await seedReviews();const id=reviewIdOf('r1'),path=`/api/restaurant-test/google/reviews/${id}/draft/generate?account_id=account-2`;
    expect((await call(path,{body:{mode:'other'}})).status).toBe(400);
    expect((await call(path,{body:{mode:'shorten',replyDraft:''}})).status).toBe(400);
    env.AI={run:vi.fn(async()=>{
      testDb.raw.prepare("UPDATE rt_google_reviews SET reply_draft='別の担当の文' WHERE id=?").run(id);
      return {response:'生成した文'};
    })} as unknown as Ai;
    expect((await call(path,{body:{mode:'polite',replyDraft:'お礼の文'}})).status).toBe(409);
    expect(testDb.raw.prepare('SELECT reply_draft FROM rt_google_reviews WHERE id=?').get(id)).toEqual({reply_draft:'別の担当の文'});
  });

  it('短くするAIが元の文より長い文を返したら保存しない',async()=>{
    await seedReviews();const id=reviewIdOf('r1');
    testDb.raw.prepare("UPDATE rt_google_reviews SET reply_draft='お礼の文' WHERE id=?").run(id);
    env.AI={run:vi.fn(async()=>({response:'元よりも長くなったお礼の文章です。'}))} as unknown as Ai;
    const response=await call(`/api/restaurant-test/google/reviews/${id}/draft/generate?account_id=account-2`,{body:{mode:'shorten'}});
    expect(response.status).toBe(502);expect(await response.json()).toMatchObject({code:'ai_not_shorter'});
    expect(testDb.raw.prepare('SELECT reply_draft FROM rt_google_reviews WHERE id=?').get(id)).toEqual({reply_draft:'お礼の文'});
  });

  /** OpenAI の文章生成APIの返事を真似る。 */
  function openAiHandler(body: unknown, status = 200): (url: string, init?: RequestInit) => Response {
    return (url) => (url.startsWith('https://api.openai.com/') ? jsonResponse(body, status) : jsonResponse({}, 404));
  }

  it('AI下書き：鍵があるときは文章の上手な方（OpenAI）で書く', async () => {
    await seedReviews();
    env.OPENAI_API_KEY = 'sk-test';
    const run = vi.fn(async () => ({ response: 'こちらは使われない文章です。' }));
    env.AI = { run } as unknown as Ai;
    googleHandler = openAiHandler({ choices: [{ message: { content: '  この度はご来店いただき、誠にありがとうございました。  ' } }] });
    const response = await call(`/api/restaurant-test/google/reviews/${reviewIdOf('r1')}/draft/generate?account_id=account-2`, { body: {} });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ draft: 'この度はご来店いただき、誠にありがとうございました。', aiGenerated: true });
    expect(run).not.toHaveBeenCalled();
    const sent = googleCalls.find((item) => item.url.startsWith('https://api.openai.com/'));
    expect(sent).toBeDefined();
    const sentBody = JSON.parse(String(sent?.init?.body)) as Record<string, unknown>;
    // gpt-5 系は max_tokens と temperature を受け付けない。
    expect(sentBody).toMatchObject({ model: 'gpt-5-mini', max_completion_tokens: 3000 });
    expect(sentBody).not.toHaveProperty('max_tokens');
    expect(sentBody).not.toHaveProperty('temperature');
    expect(JSON.stringify(sentBody)).toContain('季節の定食');
    expect(JSON.stringify(sentBody)).not.toContain('Aki');
  });

  it('AI下書き：OpenAI が失敗しても Workers AI に切り替えて下書きを作る', async () => {
    await seedReviews();
    env.OPENAI_API_KEY = 'sk-test';
    const run = vi.fn(async () => ({ response: '切り替え後の下書きです。' }));
    env.AI = { run } as unknown as Ai;
    googleHandler = openAiHandler({ error: { message: 'too many requests' } }, 429);
    const response = await call(`/api/restaurant-test/google/reviews/${reviewIdOf('r1')}/draft/generate?account_id=account-2`, { body: {} });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ draft: '切り替え後の下書きです。', aiGenerated: true });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('AI下書き：Workers AI が無く OpenAI も失敗したときは 502', async () => {
    await seedReviews();
    env.OPENAI_API_KEY = 'sk-test';
    googleHandler = openAiHandler({ error: { message: 'bad key' } }, 401);
    const response = await call(`/api/restaurant-test/google/reviews/${reviewIdOf('r1')}/draft/generate?account_id=account-2`, { body: {} });
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ code: 'ai_failed' });
  });

  it('AI下書き：AI が無い環境は 503、返信済みの口コミは 409', async () => {
    await seedReviews();
    // どちらの生成先も無い環境。
    expect(env.AI).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    const unavailable = await call(`/api/restaurant-test/google/reviews/${reviewIdOf('r1')}/draft/generate?account_id=account-2`, { body: {} });
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({ code: 'ai_unavailable' });
    env.AI = { run: vi.fn(async () => ({ response: 'x' })) } as unknown as Ai;
    const replied = await call(`/api/restaurant-test/google/reviews/${reviewIdOf('r3')}/draft/generate?account_id=account-2`, { body: {} });
    expect(replied.status).toBe(409);
  });

  it('下書き保存：空・4,097文字は 400。保存すると draft になる', async () => {
    await seedReviews();
    const id = reviewIdOf('r2');
    expect((await call(`/api/restaurant-test/google/reviews/${id}/draft?account_id=account-2`, { method: 'PUT', body: { replyDraft: ' ' } })).status).toBe(400);
    expect((await call(`/api/restaurant-test/google/reviews/${id}/draft?account_id=account-2`, { method: 'PUT', body: { replyDraft: 'a'.repeat(4097) } })).status).toBe(400);
    const ok = await call(`/api/restaurant-test/google/reviews/${id}/draft?account_id=account-2`, { method: 'PUT', body: { replyDraft: 'ご不便をおかけしました。' } });
    expect(ok.status).toBe(200);
    expect(testDb.raw.prepare('SELECT reply_status, reply_draft, reply_draft_ai_generated FROM rt_google_reviews WHERE id = ?').get(id)).toEqual({ reply_status: 'draft', reply_draft: 'ご不便をおかけしました。', reply_draft_ai_generated: 0 });
  });

  it('返信公開：確認フラグ必須、書き込み無効の環境は 403 で Google を呼ばない', async () => {
    await seedReviews();
    const id = reviewIdOf('r2');
    expect((await call(`/api/restaurant-test/google/reviews/${id}/reply?account_id=account-2`, { body: { comment: 'x' } })).status).toBe(400);
    env.GOOGLE_BUSINESS_WRITE_ENABLED = 'false';
    const response = await call(`/api/restaurant-test/google/reviews/${id}/reply?account_id=account-2`, { body: { confirmed: true, comment: 'ありがとうございます' } });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'write_disabled' });
    expect(googleCalls).toHaveLength(0);
  });

  it('返信公開：送信直前に照合し、Google側に返信が無ければ PUT して replied にする', async () => {
    await seedReviews();
    const id = reviewIdOf('r2');
    googleHandler = (url, init) => {
      if (url.endsWith('/reviews/r2/reply') && init?.method === 'PUT') return jsonResponse({ comment: 'ご指摘ありがとうございます', updateTime: '2026-09-23T03:00:00Z' });
      if (url.endsWith('/reviews/r2')) return jsonResponse({ name: `${LOCATION}/reviews/r2`, reviewId: 'r2', starRating: 'THREE', comment: '営業中なのに閉まっていた', createTime: '2026-09-22T01:00:00Z' });
      return jsonResponse({}, 404);
    };
    const response = await call(`/api/restaurant-test/google/reviews/${id}/reply?account_id=account-2`, { body: { confirmed: true, comment: 'ご指摘ありがとうございます' } });
    expect(response.status).toBe(200);
    expect(googleCalls.map((c) => c.init?.method ?? 'GET')).toEqual(['GET', 'PUT']);
    expect(testDb.raw.prepare('SELECT reply_status, reply_comment FROM rt_google_reviews WHERE id = ?').get(id)).toEqual({ reply_status: 'replied', reply_comment: 'ご指摘ありがとうございます' });
    expect(testDb.raw.prepare('SELECT kind, result, after_text FROM rt_google_write_log').get()).toEqual({ kind: 'review_reply', result: 'accepted', after_text: 'ご指摘ありがとうございます' });
  });

  it('返信公開：別の担当者が先に返信していたら 409 で止め、相手の返信文を返す', async () => {
    await seedReviews();
    const id = reviewIdOf('r2');
    googleHandler = (url) => (url.endsWith('/reviews/r2') ? jsonResponse({ name: `${LOCATION}/reviews/r2`, reviewId: 'r2', starRating: 'THREE', createTime: '2026-09-22T01:00:00Z', reviewReply: { comment: '先に返信しました' } }) : jsonResponse({}, 404));
    const response = await call(`/api/restaurant-test/google/reviews/${id}/reply?account_id=account-2`, { body: { confirmed: true, comment: '別の返信' } });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'already_replied', existingReply: '先に返信しました' });
    expect(googleCalls.some((c) => c.init?.method === 'PUT')).toBe(false);
    expect(testDb.raw.prepare('SELECT reply_status FROM rt_google_reviews WHERE id = ?').get(id)).toEqual({ reply_status: 'published' });
  });

  it('返信公開：通信結果が不明なら pending_confirm のまま残し、記録は unknown にする', async () => {
    await seedReviews();
    const id = reviewIdOf('r2');
    googleHandler = (url, init) => {
      if (init?.method === 'PUT') throw new Error('socket hang up');
      if (url.endsWith('/reviews/r2')) return jsonResponse({ name: `${LOCATION}/reviews/r2`, reviewId: 'r2', starRating: 'THREE', createTime: '2026-09-22T01:00:00Z' });
      return jsonResponse({}, 404);
    };
    const response = await call(`/api/restaurant-test/google/reviews/${id}/reply?account_id=account-2`, { body: { confirmed: true, comment: '返信' } });
    expect(response.status).toBe(502);
    expect(testDb.raw.prepare('SELECT reply_status FROM rt_google_reviews WHERE id = ?').get(id)).toEqual({ reply_status: 'pending_confirm' });
    expect(testDb.raw.prepare('SELECT result FROM rt_google_write_log').get()).toEqual({ result: 'unknown' });
  }, 20_000);

  it('権限：staff は公開・接続・解除ができず、全店担当の統括管理者は接続できる', async () => {
    await seedReviews();
    const id = reviewIdOf('r2');
    useStaffRole('staff');
    expect((await call(`/api/restaurant-test/google/reviews/${id}/reply?account_id=account-2`, { body: { confirmed: true, comment: 'x' }, token: 'staff-session' })).status).toBe(403);
    expect((await call('/api/restaurant-test/google/connect/start?account_id=account-2', { body: {}, token: 'staff-session' })).status).toBe(403);
    expect((await call('/api/restaurant-test/google/disconnect?account_id=account-2', { body: { confirmed: true }, token: 'staff-session' })).status).toBe(403);
    expect((await call('/api/restaurant-test/google/reviews?account_id=account-2', { token: 'staff-session' })).status).toBe(200);
    expect((await call('/api/restaurant-test/google/reviews/sync?account_id=account-2', { body: {}, token: 'staff-session' })).status).toBe(200);
    useStaffRole('admin');
    env.GOOGLE_BUSINESS_WRITE_ENABLED = 'false';
    expect((await call(`/api/restaurant-test/google/reviews/${id}/reply?account_id=account-2`, { body: { confirmed: true, comment: 'x' }, token: 'admin-session' })).status).toBe(403);
    expect(await (await call(`/api/restaurant-test/google/reviews/${id}/reply?account_id=account-2`, { body: { confirmed: true, comment: 'x' }, token: 'admin-session' })).json()).toMatchObject({ code: 'write_disabled' });
    expect((await call('/api/restaurant-test/google/connect/start?account_id=account-2', { body: {}, token: 'admin-session' })).status).toBe(200);
  });
});

describe('実際の本番・検証設定を組み合わせたルート', () => {
  it.each(['production', 'staging'] as const)('%s のGoogle接続は開き、飲食店だけ独立して閉じる', async environment => {
    const { unstable_readConfig } = await import('wrangler');
    const config = unstable_readConfig({ config: fileURLToPath(new URL(environment === 'production' ? '../../wrangler.toml' : '../../wrangler.staging.toml', import.meta.url)) });
    Object.assign(env, config.vars);
    seedStore();
    const google = await call('/api/restaurant-test/google/connection?account_id=account-2');
    expect(google.status).toBe(200);
    const body = await google.json() as { stores: { id: string; line_account_id: string }[] };
    expect(body.stores).toContainEqual({ id: 'store-shibuya', name: 'こもれび食堂 渋谷店', line_account_id: 'account-2' });
    for (const [endpoint, status] of [['reviews', 200], ['profile', 409], ['photos', 409], ['posts', 200], ['performance', 200]] as const) {
      const response = await call(`/api/restaurant-test/google/${endpoint}?account_id=account-2`);
      expect(response.status, endpoint).toBe(status); // 各画面のデータかGoogle未接続の案内まで到達する。
    }
    expect(googleCalls).toHaveLength(0);
    const restaurant = await call('/api/restaurant-test/stores?account_id=account-2');
    expect(restaurant.status).toBe(environment === 'production' ? 404 : 200);
    if (environment === 'production') expect(await restaurant.json()).toEqual({ success: false, error: 'Not found' });
    env.GOOGLE_BUSINESS_ENABLED = 'false';
    const prepare = vi.spyOn(env.DB, 'prepare');
    for (const endpoint of ['connection', 'reviews', 'profile', 'photos', 'posts', 'performance']) {
      expect((await call(`/api/restaurant-test/google/${endpoint}?account_id=account-2`)).status).toBe(404);
    }
    // 共通のログイン確認はDBを読む。機能のデータには到達させない。
    expect(prepare.mock.calls.map(([sql]) => sql).filter(sql => /\brt_/.test(sql))).toEqual([]);
    prepare.mockRestore();
    expect((await call('/api/restaurant-test/stores?account_id=account-2')).status).toBe(environment === 'production' ? 404 : 200);
    expect(googleCalls.filter(call => call.url.includes('googleapis.com'))).toHaveLength(0);
  });
});


it('Googleの店舗選択は同じ統括かつ担当範囲だけを返す', async () => {
  seedStore();
  testDb.raw.prepare("INSERT INTO rt_stores (id,organization_id,name,code,line_account_id) VALUES ('sibling','org-1','同じ統括の店','SIBLING','account-1')").run();
  testDb.raw.prepare("INSERT INTO tenants (id,name) VALUES ('b368-other','別の統括')").run();
  testDb.raw.prepare("INSERT INTO rt_organizations (id,account_id,tenant_id,name) VALUES ('other-org','account-9','b368-other','別の組織')").run();
  testDb.raw.prepare("INSERT INTO rt_stores (id,organization_id,name,code,line_account_id) VALUES ('other-store','other-org','別の統括の店','OTHER','account-9')").run();
  const owner = await call('/api/restaurant-test/google/connection?account_id=account-2');
  expect((await owner.json() as { stores: { id: string }[] }).stores.map(store => store.id).sort()).toEqual(['sibling', 'store-shibuya']);
  useStaffRole('admin', 'accounts', false);
  testDb.raw.prepare("INSERT INTO staff_account_scopes (staff_id,line_account_id,created_at) VALUES ('admin-1','account-2','2026-10-17 00:00:00')").run();
  const admin = await call('/api/restaurant-test/google/connection?account_id=account-2', { token: 'admin-session' });
  expect(admin.status).toBe(200);
  expect((await admin.json() as { stores: { id: string }[] }).stores.map(store => store.id)).toEqual(['store-shibuya']);
});
