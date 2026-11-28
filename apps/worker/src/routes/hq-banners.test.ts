import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../worker-env.js';
import { DEFAULT_TENANT_ID } from '../lib/tenant.js';
import type { AuthenticatedStaff } from '../middleware/auth/principal/auth.js';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';
import { STAGING_BANNER_GENERATION_CRON } from '../services/scheduled-job-isolation.js';
import { QA_STAGING_DATABASE } from '../services/staging-qa-safety.js';

const openai = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock('../services/openai-images.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/openai-images.js')>();
  return { ...actual, generateOpenAIImage: openai.generate };
});

const { hqBanners } = await import('./hq-banners.js');
const { OpenAIImageError } = await import('../services/openai-images.js');

let testDb: SqliteD1;

/** R2 のかわり。put した中身を get で返せるだけの入れ物。 */
function fakeBucket() {
  const store = new Map<string, { bytes: Uint8Array; contentType: string }>();
  return {
    store,
    bucket: {
      put: vi.fn(async (key: string, value: Uint8Array | ArrayBuffer, opts?: { httpMetadata?: { contentType?: string } }) => {
        store.set(key, {
          bytes: value instanceof Uint8Array ? value : new Uint8Array(value),
          contentType: opts?.httpMetadata?.contentType ?? 'application/octet-stream',
        });
      }),
      get: vi.fn(async (key: string) => {
        const hit = store.get(key);
        if (!hit) return null;
        return { arrayBuffer: async () => hit.bytes.buffer.slice(hit.bytes.byteOffset, hit.bytes.byteOffset + hit.bytes.byteLength) };
      }),
      delete: vi.fn(async (key: string) => { store.delete(key); }),
    } as unknown as R2Bucket,
  };
}

let r2: ReturnType<typeof fakeBucket>;

const hqAdmin = (overrides: Partial<AuthenticatedStaff> = {}): AuthenticatedStaff => ({
  id: 'staff-1',
  name: '統括管理者',
  role: 'admin',
  readOnly: false,
  tenantId: DEFAULT_TENANT_ID,
  ...overrides,
});

function app(staff: AuthenticatedStaff) {
  const instance = new Hono<Env>();
  instance.use('*', async (c, next) => {
    c.set('staff', staff);
    return next();
  });
  instance.route('/', hqBanners);
  return instance;
}

function env(overrides: Partial<Env['Bindings']> = {}): Env['Bindings'] {
  return {
    DB: testDb.db,
    IMAGES: r2.bucket,
    WORKER_URL: 'https://api.example.com',
    OPENAI_API_KEY: 'sk-test',
    ...overrides,
  } as Env['Bindings'];
}

async function call(
  method: string,
  path: string,
  body?: unknown,
  opts: { staff?: AuthenticatedStaff; env?: Partial<Env['Bindings']>; headers?: Record<string, string> } = {},
) {
  const scopedPath=path+((method==='POST'&&(/\/generations$/.test(path)||/\/run$/.test(path)))?'?account_id=account-1':'');
  return app(opts.staff ?? hqAdmin()).request(scopedPath, {
    method,
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, env(opts.env));
}

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 1, 2, 3]);
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR1sAAAAASUVORK5CYII='), value => value.charCodeAt(0));
const toB64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

async function createProject(name = '春のキャンペーン') {
  const res = await call('POST', '/api/hq/banners/projects', { name, description: '桜' });
  expect(res.status).toBe(201);
  return (await res.json<{ data: { id: string } }>()).data;
}

const GENERATE_BODY = {
  presetKey: 'line_rich_message',
  count: 2,
  textLines: ['春の感謝祭', '今すぐチェック'],
  baseColor: '#FFFFFF',
  mainColor: '#FF6600',
  accentColor: '#FFD400',
  personOption: 'without',
};

beforeEach(() => {
  testDb = createTestD1();
  r2 = fakeBucket();
  openai.generate.mockReset();
  testDb.raw.prepare("INSERT INTO tenants (id, name) VALUES ('tenant-2', '別の統括')").run();
  testDb.raw.prepare(
    `INSERT INTO line_accounts
       (id, channel_id, name, channel_access_token, channel_secret, is_active, tenant_id)
     VALUES ('account-1', 'channel-1', '店舗1', '', '', 1, ?)`,
  ).run(DEFAULT_TENANT_ID);
  testDb.raw.prepare(
    `INSERT INTO line_accounts
       (id, channel_id, name, channel_access_token, channel_secret, is_active, tenant_id)
     VALUES ('account-2', 'channel-2', '店舗2', '', '', 1, ?)`,
  ).run(DEFAULT_TENANT_ID);
  testDb.raw.prepare(
    `INSERT INTO line_accounts
       (id, channel_id, name, channel_access_token, channel_secret, is_active, tenant_id)
     VALUES ('account-other', 'channel-x', 'よその店舗', '', '', 1, 'tenant-2')`,
  ).run();
});

beforeEach(()=>{testDb.raw.exec("INSERT INTO account_ai_features(account_id,feature,enabled,consent_by,consent_at,disclosure_version) VALUES('account-1','banner',1,'staff-1','2026-10-16','2026-10-16')");});

describe('権限', () => {
  it('担当者（staff）は統括のバナー生成に入れない', async () => {
    const res = await call('GET', '/api/hq/banners/projects', undefined, { staff: hqAdmin({ role: 'staff' }) });
    expect(res.status).toBe(403);
  });

  it('別の統括のプロジェクトは見えない', async () => {
    const project = await createProject();
    const res = await call('GET', `/api/hq/banners/projects/${project.id}`, undefined, {
      staff: hqAdmin({ tenantId: 'tenant-2' }),
    });
    expect(res.status).toBe(404);
    const list = await call('GET', '/api/hq/banners/projects', undefined, { staff: hqAdmin({ tenantId: 'tenant-2' }) });
    expect((await list.json<{ data: unknown[] }>()).data).toHaveLength(0);
  });
});

describe('プロジェクト', () => {
  it('作成・一覧・名前変更・お気に入り・アーカイブ・復元ができる', async () => {
    const project = await createProject();
    let res = await call('GET', '/api/hq/banners/projects');
    let list = (await res.json<{ data: Array<{ id: string; name: string; imageCount: number }> }>()).data;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: project.id, name: '春のキャンペーン', imageCount: 0 });

    res = await call('PATCH', `/api/hq/banners/projects/${project.id}`, { name: '夏のキャンペーン', isFavorite: true });
    expect(res.status).toBe(200);
    expect((await res.json<{ data: { name: string; isFavorite: boolean } }>()).data).toMatchObject({ name: '夏のキャンペーン', isFavorite: true });

    res = await call('PATCH', `/api/hq/banners/projects/${project.id}`, { archived: true });
    expect(res.status).toBe(200);
    res = await call('GET', '/api/hq/banners/projects');
    expect((await res.json<{ data: unknown[] }>()).data).toHaveLength(0);
    res = await call('GET', '/api/hq/banners/projects?archived=1');
    list = (await res.json<{ data: Array<{ id: string; name: string; imageCount: number }> }>()).data;
    expect(list).toHaveLength(1);

    res = await call('PATCH', `/api/hq/banners/projects/${project.id}`, { archived: false });
    res = await call('GET', '/api/hq/banners/projects');
    expect((await res.json<{ data: unknown[] }>()).data).toHaveLength(1);
  });

  it('名前が空か長すぎると断る', async () => {
    expect((await call('POST', '/api/hq/banners/projects', { name: '' })).status).toBe(400);
    expect((await call('POST', '/api/hq/banners/projects', { name: 'あ'.repeat(101) })).status).toBe(400);
  });

  it('検索は名前と説明の部分一致', async () => {
    await createProject('春のキャンペーン');
    await createProject('新規友だち向け');
    const res = await call('GET', '/api/hq/banners/projects?q=%E6%98%A5');
    const list = (await res.json<{ data: Array<{ name: string }> }>()).data;
    expect(list.map((p) => p.name)).toEqual(['春のキャンペーン']);
  });
});

describe('生成', () => {
  it('接続設定が無いときは生成を503で断る', async () => {
    const project = await createProject();
    const res = await call('POST', `/api/hq/banners/projects/${project.id}/generations`, GENERATE_BODY, {
      env: { OPENAI_API_KEY: undefined },
    });
    expect(res.status).toBe(503);
  });

  it('条件を保存し、1回の実行で1枚ずつ作って統括のメディアに保存する', async () => {
    const project = await createProject();
    let res = await call('POST', `/api/hq/banners/projects/${project.id}/generations`, GENERATE_BODY);
    expect(res.status).toBe(201);
    const generation = (await res.json<{ data: { id: string; status: string; finalPrompt: string; unitsPerImage: number; requestedCount: number; quality: string } }>()).data;
    expect(generation.status).toBe('queued');
    expect(generation.unitsPerImage).toBe(1);
    expect(generation.quality).toBe('medium');
    expect(generation.requestedCount).toBe(2);
    expect(generation.finalPrompt).toContain('「春の感謝祭」');

    openai.generate.mockResolvedValue({ bytes: JPEG, mimeType: 'image/jpeg', model: 'gpt-image-1' });

    res = await call('POST', `/api/hq/banners/generations/${generation.id}/run`);
    expect(res.status).toBe(200);
    let run = (await res.json<{ data: { generation: { status: string; doneCount: number }; image: { id: string; sequence: number; media: { url: string; width: number } } | null; finished: boolean } }>()).data;
    expect(run.finished).toBe(false);
    expect(run.generation).toMatchObject({ status: 'running', doneCount: 1 });
    expect(run.image?.sequence).toBe(1);
    expect(run.image?.media.width).toBe(1024);
    expect(run.image?.media.url).toMatch(/^https:\/\/api\.example\.com\/images\/banner\/.+\.jpg$/);

    // 呼び出しに渡した条件が保存したプロンプトと同じ
    const sent = openai.generate.mock.calls[0][0] as { prompt: string; size: string; quality: string };
    expect(sent.prompt).toBe(generation.finalPrompt);
    expect(sent).toMatchObject({ size: '1024x1024', quality: 'medium' });

    res = await call('POST', `/api/hq/banners/generations/${generation.id}/run`);
    run = (await res.json<typeof run extends infer T ? { data: T } : never>()).data;
    expect(run.finished).toBe(true);
    expect(run.generation).toMatchObject({ status: 'done', doneCount: 2 });

    // 3回目は何もせず「終わっている」と返す
    res = await call('POST', `/api/hq/banners/generations/${generation.id}/run`);
    run = (await res.json<{ data: typeof run }>()).data;
    expect(run.finished).toBe(true);
    expect(run.image).toBeNull();
    expect(openai.generate).toHaveBeenCalledTimes(2);

    // 統括のメディアとして保存されている（店舗には属さない）
    const media = testDb.raw.prepare('SELECT line_account_id, kind, mime_type, r2_key FROM media').all() as Array<{ line_account_id: string | null; kind: string; r2_key: string }>;
    expect(media).toHaveLength(2);
    expect(media.every((m) => m.line_account_id === null && m.kind === 'image' && m.r2_key.startsWith('banner/'))).toBe(true);
    expect(r2.store.size).toBe(2);

    // 利用量は 2枚（品質は数えない）
    res = await call('GET', '/api/hq/banners/usage');
    const usage = (await res.json<{ data: { month: { used: number; limit: number }; today: { used: number; limit: number }; paused: boolean } }>()).data;
    expect(usage.month).toMatchObject({ used: 2, limit: 150 });
    expect(usage.today).toMatchObject({ used: 2, limit: 30 });
    expect(usage.paused).toBe(false);

    // プロジェクト詳細に画像と生成条件が並ぶ
    res = await call('GET', `/api/hq/banners/projects/${project.id}`);
    const detail = (await res.json<{ data: { project: { imageCount: number }; images: Array<{ generation: { textLines: string[] } }> } }>()).data;
    expect(detail.project.imageCount).toBe(2);
    expect(detail.images[0].generation.textLines).toEqual(['春の感謝祭', '今すぐチェック']);
  });

  it('AIが安全基準で断ったら、その生成は止めて理由を残す。利用量は減らない', async () => {
    const project = await createProject();
    let res = await call('POST', `/api/hq/banners/projects/${project.id}/generations`, { ...GENERATE_BODY, count: 3 });
    const generation = (await res.json<{ data: { id: string } }>()).data;
    openai.generate.mockRejectedValue(new OpenAIImageError('safety', 'rejected by safety system', 400));

    res = await call('POST', `/api/hq/banners/generations/${generation.id}/run`);
    expect(res.status).toBe(422);
    const body = await res.json<{ success: boolean; error: string; data: { generation: { status: string; failedCount: number; errorMessage: string } } }>();
    expect(body.success).toBe(false);
    expect(body.error).toContain('安全基準');
    expect(body.data.generation).toMatchObject({ status: 'failed', failedCount: 1 });
    expect(body.data.generation.errorMessage).toContain('安全基準');

    res = await call('GET', '/api/hq/banners/usage');
    expect((await res.json<{ data: { month: { used: number } } }>()).data.month.used).toBe(0);
    expect(r2.store.size).toBe(0);
  });

  it('1枚成功したあとで失敗しても、成功分は残して done で締める', async () => {
    const project = await createProject();
    let res = await call('POST', `/api/hq/banners/projects/${project.id}/generations`, GENERATE_BODY);
    const generation = (await res.json<{ data: { id: string } }>()).data;
    openai.generate
      .mockResolvedValueOnce({ bytes: JPEG, mimeType: 'image/jpeg', model: 'gpt-image-1' })
      .mockRejectedValueOnce(new OpenAIImageError('timeout', 'timed out'));

    await call('POST', `/api/hq/banners/generations/${generation.id}/run`);
    res = await call('POST', `/api/hq/banners/generations/${generation.id}/run`);
    expect(res.status).toBe(502);
    const body = await res.json<{ data: { generation: { status: string; doneCount: number; failedCount: number } } }>();
    expect(body.data.generation).toMatchObject({ status: 'done', doneCount: 1, failedCount: 1 });
    expect(r2.store.size).toBe(1);
  });

  it('月の上限を超える生成は受け付けない', async () => {
    const project = await createProject();
    const res = await call('POST', `/api/hq/banners/projects/${project.id}/generations`, { ...GENERATE_BODY, count: 4 }, {
      env: { BANNER_MONTHLY_IMAGES: '3' },
    });
    expect(res.status).toBe(409);
    expect((await res.json<{ error: string }>()).error).toContain('今月の生成上限');
  });

  it('1日の上限（月の1/5）も見る', async () => {
    const project = await createProject();
    // 月 10枚 → 1日 2枚。3枚は断る
    const res = await call('POST', `/api/hq/banners/projects/${project.id}/generations`, { ...GENERATE_BODY, count: 3 }, {
      env: { BANNER_MONTHLY_IMAGES: '10' },
    });
    expect(res.status).toBe(409);
    expect((await res.json<{ error: string }>()).error).toContain('今日の生成上限');
  });

  it('短時間に失敗が3回続いたら自動で一時停止する', async () => {
    const project = await createProject();
    openai.generate.mockRejectedValue(new OpenAIImageError('server', 'boom', 500));
    for (let i = 0; i < 3; i += 1) {
      const res = await call('POST', `/api/hq/banners/projects/${project.id}/generations`, { ...GENERATE_BODY, count: 1 });
      const g = (await res.json<{ data: { id: string } }>()).data;
      await call('POST', `/api/hq/banners/generations/${g.id}/run`);
    }
    const res = await call('POST', `/api/hq/banners/projects/${project.id}/generations`, { ...GENERATE_BODY, count: 1 });
    expect(res.status).toBe(409);
    expect((await res.json<{ error: string }>()).error).toContain('失敗が続いた');
    const usage = await call('GET', '/api/hq/banners/usage');
    expect((await usage.json<{ data: { paused: boolean } }>()).data.paused).toBe(true);
  });

  it('品質を指定しても無視して固定値で作る', async () => {
    const project = await createProject();
    const res = await call('POST', `/api/hq/banners/projects/${project.id}/generations`, { ...GENERATE_BODY, quality: 'high' }, {
      env: { BANNER_IMAGE_QUALITY: 'low' },
    });
    expect(res.status).toBe(201);
    expect((await res.json<{ data: { quality: string } }>()).data.quality).toBe('low');
  });

  it('用途は LINE と SNS の規格を網羅している', async () => {
    const res = await call('GET', '/api/hq/banners/presets');
    const data = (await res.json<{ data: { presets: Array<{ key: string; group: string; targetWidth: number; targetHeight: number }>; maxCount: number; usage: { month: { limit: number }; today: { limit: number } } } }>()).data;
    const keys = data.presets.map((p) => p.key);
    expect(keys).toEqual(expect.arrayContaining(['line_rich_message', 'line_rich_menu_large', 'line_rich_menu_small', 'line_card', 'sns_instagram_feed', 'sns_story', 'sns_ogp', 'sns_youtube_thumbnail']));
    expect(data.presets.find((p) => p.key === 'line_rich_menu_large')).toMatchObject({ group: 'line', targetWidth: 2500, targetHeight: 1686 });
    expect(data.maxCount).toBe(4);
    expect(data.usage.month.limit).toBe(150);
    expect(data.usage.today.limit).toBe(30);
  });

  it('無料トライアル中は月 20枚、期限が過ぎたら課金プランの案内つきで断る', async () => {
    testDb.raw.prepare("UPDATE tenants SET plan_status = 'trialing', trial_ends_at = '2999-01-01T00:00:00.000' WHERE id = ?").run(DEFAULT_TENANT_ID);
    let res = await call('GET', '/api/hq/banners/usage');
    let usage = (await res.json<{ data: { month: { limit: number }; blocked: boolean; planState: string } }>()).data;
    expect(usage.month.limit).toBe(20);
    expect(usage.blocked).toBe(false);
    expect(usage.planState).toBe('trialing');

    testDb.raw.prepare("UPDATE tenants SET trial_ends_at = '2020-01-01T00:00:00.000' WHERE id = ?").run(DEFAULT_TENANT_ID);
    res = await call('GET', '/api/hq/banners/usage');
    usage = (await res.json<{ data: { month: { limit: number }; blocked: boolean; planState: string } }>()).data;
    expect(usage.blocked).toBe(true);
    expect(usage.planState).toBe('trial_expired');
    const project = await createProject();
    res = await call('POST', `/api/hq/banners/projects/${project.id}/generations`, GENERATE_BODY);
    expect(res.status).toBe(409);
    expect((await res.json<{ error: string }>()).error).toContain('無料トライアルが終了');
  });

  it('契約中はプランの枚数が上限になる', async () => {
    testDb.raw.prepare("UPDATE tenants SET plan_status = 'active', plan_key = 'pro' WHERE id = ?").run(DEFAULT_TENANT_ID);
    const res = await call('GET', '/api/hq/banners/usage');
    expect((await res.json<{ data: { month: { limit: number } } }>()).data.month.limit).toBe(500);
  });

  it('アーカイブ済みのプロジェクトでは生成できない', async () => {
    const project = await createProject();
    await call('PATCH', `/api/hq/banners/projects/${project.id}`, { archived: true });
    const res = await call('POST', `/api/hq/banners/projects/${project.id}/generations`, GENERATE_BODY);
    expect(res.status).toBe(409);
  });

  it('途中でキャンセルすると、それ以上は作らない', async () => {
    const project = await createProject();
    let res = await call('POST', `/api/hq/banners/projects/${project.id}/generations`, GENERATE_BODY);
    const generation = (await res.json<{ data: { id: string } }>()).data;
    res = await call('POST', `/api/hq/banners/generations/${generation.id}/cancel`);
    expect((await res.json<{ data: { status: string } }>()).data.status).toBe('canceled');
    res = await call('POST', `/api/hq/banners/generations/${generation.id}/run`);
    expect((await res.json<{ data: { finished: boolean } }>()).data.finished).toBe(true);
    expect(openai.generate).not.toHaveBeenCalled();
  });
});

describe('画像ライブラリと店舗への受け渡し', () => {
  async function generatedImage() {
    const project = await createProject();
    let res = await call('POST', `/api/hq/banners/projects/${project.id}/generations`, { ...GENERATE_BODY, count: 1 });
    const generation = (await res.json<{ data: { id: string } }>()).data;
    openai.generate.mockResolvedValue({ bytes: JPEG, mimeType: 'image/jpeg', model: 'gpt-image-1' });
    res = await call('POST', `/api/hq/banners/generations/${generation.id}/run`);
    const image = (await res.json<{ data: { image: { id: string } } }>()).data.image;
    return { project, image };
  }

  it('取り込んだ画像も一覧に並び、お気に入り・検索・用途で絞れる', async () => {
    const { project, image } = await generatedImage();
    let res = await call('POST', `/api/hq/banners/projects/${project.id}/uploads`, {
      filename: 'chirashi.png',
      data: `data:image/png;base64,${toB64(PNG)}`,
    });
    expect(res.status).toBe(201);
    const uploaded = (await res.json<{ data: { id: string; source: string; generation: unknown } }>()).data;
    expect(uploaded.source).toBe('upload');
    expect(uploaded.generation).toBeNull();

    res = await call('GET', '/api/hq/banners/images');
    expect((await res.json<{ data: unknown[] }>()).data).toHaveLength(2);

    await call('PATCH', `/api/hq/banners/images/${image.id}`, { isFavorite: true });
    res = await call('GET', '/api/hq/banners/images?favorite=1');
    const favorites = (await res.json<{ data: Array<{ id: string; isFavorite: boolean }> }>()).data;
    expect(favorites).toHaveLength(1);
    expect(favorites[0]).toMatchObject({ id: image.id, isFavorite: true });

    res = await call('GET', '/api/hq/banners/images?q=%E6%84%9F%E8%AC%9D%E7%A5%AD');
    expect((await res.json<{ data: Array<{ id: string }> }>()).data.map((i) => i.id)).toEqual([image.id]);

    res = await call('GET', '/api/hq/banners/images?preset=line_rich_menu_large');
    expect((await res.json<{ data: unknown[] }>()).data).toHaveLength(0);
  });

  it('配布状態の絞り込みをページ切り前にかけ、同じ画像は1件で返す', async () => {
    const { image } = await generatedImage();
    expect((await call('GET', '/api/hq/banners/images?delivered=1')).status).toBe(200);
    expect((await (await call('GET', '/api/hq/banners/images?delivered=1')).json<{ data: unknown[] }>()).data).toHaveLength(0);
    expect((await (await call('GET', '/api/hq/banners/images?delivered=0')).json<{ data: unknown[] }>()).data).toHaveLength(1);
    await call('POST', `/api/hq/banners/images/${image.id}/deliver`, { lineAccountIds: ['account-1', 'account-2'] });
    expect((await (await call('GET', '/api/hq/banners/images?delivered=1&limit=1')).json<{ data: { id: string }[] }>()).data.map(x => x.id)).toEqual([image.id]);
    expect((await (await call('GET', '/api/hq/banners/images?delivered=0')).json<{ data: unknown[] }>()).data).toHaveLength(0);
    expect((await call('GET', '/api/hq/banners/images?delivered=yes')).status).toBe(400);
  });

  it('全件を検索し、同時刻の画像を漏らさず次ページへ進み、分類の総数を返す', async () => {
    const { project, image } = await generatedImage();
    for (let i = 0; i < 3; i++) {
      expect((await call('POST', `/api/hq/banners/projects/${project.id}/uploads`, {
        filename: `extra-${i}.png`, data: `data:image/png;base64,${toB64(PNG)}`,
      })).status).toBe(201);
    }
    testDb.raw.prepare("UPDATE banner_images SET created_at='2026-10-04T10:00:00Z'").run();
    await call('PATCH', `/api/hq/banners/images/${image.id}`, { isFavorite: true });
    const ids: string[] = [];
    let before: string | null = null;
    for (let i = 0; i < 5; i++) {
      const response = await call('GET', `/api/hq/banners/images?limit=1&withCounts=1${before ? `&before=${encodeURIComponent(before)}` : ''}`);
      expect(response.status).toBe(200);
      const page = await response.json<{ data: {id:string}[]; nextBefore:string|null; counts: { all: number; favorite: number } }>();
      expect(page.counts).toMatchObject({ all: 4, favorite: 1 });
      ids.push(...page.data.map(x => x.id)); before = page.nextBefore;
      if (!before) break;
    }
    expect(ids).toHaveLength(4); expect(new Set(ids).size).toBe(4);
    const byProject = await call('GET', `/api/hq/banners/images?q=${encodeURIComponent('春のキャンペーン')}&withCounts=1&limit=1`);
    expect(await byProject.json()).toMatchObject({ counts: { all: 4 } });
    const shaped = await call('GET', '/api/hq/banners/images?shape=square');
    expect((await shaped.json<{data:{id:string}[]}>()).data.map(x => x.id)).toEqual([image.id]);
    expect((await call('GET', '/api/hq/banners/images?shape=bad')).status).toBe(400);
    expect((await call('GET', '/api/hq/banners/images?before=%7Bbad')).status).toBe(400);
  });

  it('形式の合わないファイルは取り込まない', async () => {
    const { project } = await generatedImage();
    const res = await call('POST', `/api/hq/banners/projects/${project.id}/uploads`, {
      filename: 'fake.png',
      data: `data:image/png;base64,${toB64(JPEG)}`,
    });
    expect(res.status).toBe(400);
  });

  it('店舗へ渡すと店舗の登録メディアが作られ、同じ店舗へは二度作らない', async () => {
    const { image } = await generatedImage();
    let res = await call('POST', `/api/hq/banners/images/${image.id}/deliver`, { lineAccountIds: ['account-1', 'account-2'] });
    expect(res.status).toBe(200);
    let body = (await res.json<{ data: { deliveries: Array<{ lineAccountId: string; alreadyDelivered: boolean }>; image: { deliveredAccountIds: string[] } } }>()).data;
    expect(body.deliveries.map((d) => d.alreadyDelivered)).toEqual([false, false]);
    expect(body.image.deliveredAccountIds.sort()).toEqual(['account-1', 'account-2']);

    const storeMedia = testDb.raw.prepare("SELECT line_account_id, r2_key, kind FROM media WHERE line_account_id IS NOT NULL ORDER BY line_account_id").all() as Array<{ line_account_id: string; r2_key: string; kind: string }>;
    expect(storeMedia.map((m) => m.line_account_id)).toEqual(['account-1', 'account-2']);
    expect(storeMedia.every((m) => m.r2_key.startsWith('media/') && m.kind === 'image')).toBe(true);
    expect(r2.store.size).toBe(3);

    res = await call('POST', `/api/hq/banners/images/${image.id}/deliver`, { lineAccountIds: ['account-1'] });
    body = (await res.json<{ data: typeof body }>()).data;
    expect(body.deliveries[0].alreadyDelivered).toBe(true);
    expect(r2.store.size).toBe(3);

    // 数値カード帯の数。画像1枚を2店舗へ渡したので、画像1・店舗2。
    const stats = await call('GET', '/api/hq/banners/stats');
    expect((await stats.json<{ data: unknown }>()).data).toEqual({
      projects: { active: 1, archived: 0 },
      deliveredImages: 1,
      deliveredAccounts: 2,
    });
  });

  it('別の統括の店舗へは渡せない', async () => {
    const { image } = await generatedImage();
    const res = await call('POST', `/api/hq/banners/images/${image.id}/deliver`, { lineAccountIds: ['account-other'] });
    expect(res.status).toBe(404);
    expect(r2.store.size).toBe(1);
  });

  it('一覧から外しても、渡した先の店舗メディアは残る', async () => {
    const { image } = await generatedImage();
    await call('POST', `/api/hq/banners/images/${image.id}/deliver`, { lineAccountIds: ['account-1'] });
    let res = await call('DELETE', `/api/hq/banners/images/${image.id}`);
    expect(res.status).toBe(200);
    res = await call('GET', '/api/hq/banners/images');
    expect((await res.json<{ data: unknown[] }>()).data).toHaveLength(0);
    const storeMedia = testDb.raw.prepare("SELECT COUNT(*) AS n FROM media WHERE line_account_id = 'account-1'").get() as { n: number };
    expect(storeMedia.n).toBe(1);
  });
});

describe('用途寸法への整形（R120）', () => {
  /** Cloudflare Images binding の代わり。渡された条件を記録し、JPEG の中身を返す。 */
  function fakeImagesBinding() {
    const calls: Array<{ width: number; height: number; fit: string; gravity: string }> = [];
    const resized = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9]);
    const binding = {
      input: () => ({
        transform: (opts: { width: number; height: number; fit: string; gravity: string }) => {
          calls.push({ ...opts });
          return { output: async () => ({ image: () => new Blob([resized]).stream() }) };
        },
      }),
    };
    return { binding: binding as unknown as ImagesBinding, calls, resized };
  }

  async function queuedGeneration(presetKey = 'line_rich_message') {
    const project = await createProject();
    const res = await call('POST', `/api/hq/banners/projects/${project.id}/generations`, {
      ...GENERATE_BODY,
      presetKey,
      count: 1,
    });
    expect(res.status).toBe(201);
    return (await res.json<{ data: { id: string } }>()).data;
  }

  it('binding があるときは用途の指定寸法で保存し、resized=true を返す', async () => {
    const generation = await queuedGeneration('line_rich_message');
    openai.generate.mockResolvedValue({ bytes: JPEG, mimeType: 'image/jpeg', model: 'gpt-image-1' });
    const { binding, calls, resized } = fakeImagesBinding();

    const res = await call('POST', `/api/hq/banners/generations/${generation.id}/run`, { gravity: 'center' }, {
      env: { CF_IMAGES: binding },
    });
    expect(res.status).toBe(200);
    const run = (await res.json<{
      data: {
        image: { media: { width: number; height: number; mimeType: string; sizeBytes: number } };
        resized: boolean; targetWidth: number; targetHeight: number;
      };
    }>()).data;
    expect(calls).toEqual([{ width: 1040, height: 1040, fit: 'cover', gravity: 'center' }]);
    expect(run.resized).toBe(true);
    expect(run.targetWidth).toBe(1040);
    expect(run.targetHeight).toBe(1040);
    expect(run.image.media).toMatchObject({ width: 1040, height: 1040, mimeType: 'image/jpeg', sizeBytes: resized.byteLength });

    // R2 の実体も整形後の中身
    const stored = [...r2.store.values()];
    expect(stored).toHaveLength(1);
    expect(stored[0].bytes).toEqual(resized);
  });

  it('リッチメニュー（小）は 2500×843 で保存される', async () => {
    const generation = await queuedGeneration('line_rich_menu_small');
    openai.generate.mockResolvedValue({ bytes: JPEG, mimeType: 'image/jpeg', model: 'gpt-image-1' });
    const { binding, calls } = fakeImagesBinding();

    const res = await call('POST', `/api/hq/banners/generations/${generation.id}/run`, undefined, {
      env: { CF_IMAGES: binding },
    });
    expect(res.status).toBe(200);
    expect(calls).toEqual([{ width: 2500, height: 843, fit: 'cover', gravity: 'center' }]);
    const run = (await res.json<{ data: { image: { media: { width: number; height: number } }; resized: boolean } }>()).data;
    expect(run.image.media).toMatchObject({ width: 2500, height: 843 });
    expect(run.resized).toBe(true);
  });

  it('切り抜きの位置（上・下）を binding へ渡す', async () => {
    const generation = await queuedGeneration('sns_story');
    openai.generate.mockResolvedValue({ bytes: JPEG, mimeType: 'image/jpeg', model: 'gpt-image-1' });
    const { binding, calls } = fakeImagesBinding();

    const res = await call('POST', `/api/hq/banners/generations/${generation.id}/run`, { gravity: 'top' }, {
      env: { CF_IMAGES: binding },
    });
    expect(res.status).toBe(200);
    expect(calls).toEqual([{ width: 1080, height: 1920, fit: 'cover', gravity: 'top' }]);
  });

  it('中央・上・下以外は生成前に400で断り、OpenAI は呼ばない', async () => {
    const generation = await queuedGeneration();
    const res = await call('POST', `/api/hq/banners/generations/${generation.id}/run`, { gravity: 'left' });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toContain('切り抜きの位置は中央・上・下から選んでください');
    expect(openai.generate).not.toHaveBeenCalled();
  });

  it('binding が無い環境では元のまま保存し、resized=false を返す（落ちない）', async () => {
    const generation = await queuedGeneration('line_rich_menu_small');
    openai.generate.mockResolvedValue({ bytes: PNG, mimeType: 'image/png', model: 'gpt-image-1' });

    const res = await call('POST', `/api/hq/banners/generations/${generation.id}/run`, { gravity: 'bottom' });
    expect(res.status).toBe(200);
    const run = (await res.json<{
      data: {
        image: { media: { width: number; height: number; mimeType: string } };
        resized: boolean; targetWidth: number; targetHeight: number;
      };
    }>()).data;
    expect(run.resized).toBe(false);
    expect(run.targetWidth).toBe(2500);
    expect(run.targetHeight).toBe(843);
    // 実体は生成APIのままなので、記録も形式・寸法とも元に合わせる
    expect(run.image.media).toMatchObject({ width: 1536, height: 1024, mimeType: 'image/png' });
    expect([...r2.store.values()]).toHaveLength(1);
    expect([...r2.store.values()][0].bytes).toEqual(PNG);
  });
});

describe('参照画像つき生成（35-2）', () => {
  async function uploadedImage(projectId: string) {
    const res = await call('POST', `/api/hq/banners/projects/${projectId}/uploads`, {
      filename: 'chirashi.png',
      data: `data:image/png;base64,${toB64(PNG)}`,
    });
    expect(res.status).toBe(201);
    return (await res.json<{ data: { id: string } }>()).data;
  }

  it('土台に描き直す: 参照画像を R2 から読んで OpenAI に添え、できた画像は source=edited で元をたどれる', async () => {
    const project = await createProject();
    const base = await uploadedImage(project.id);
    let res = await call('POST', `/api/hq/banners/projects/${project.id}/generations`, {
      ...GENERATE_BODY,
      count: 1,
      textLines: [],
      customPrompt: '文字を「秋の感謝祭」に変えて',
      referenceImageId: base.id,
      referenceMode: 'edit',
    });
    expect(res.status).toBe(201);
    const generation = (await res.json<{ data: { id: string; references: { imageId: string; mode: string }[]; finalPrompt: string } }>()).data;
    expect(generation.references).toEqual([{ imageId: base.id, mode: 'edit' }]);
    expect(generation.finalPrompt).toContain('土台にして描き直して');
    expect(generation.finalPrompt).toContain('追加の指示: 文字を「秋の感謝祭」に変えて');

    openai.generate.mockResolvedValue({ bytes: JPEG, mimeType: 'image/jpeg', model: 'gpt-image-2' });
    res = await call('POST', `/api/hq/banners/generations/${generation.id}/run`);
    expect(res.status).toBe(200);
    const run = (await res.json<{ data: { image: { id: string; source: string } } }>()).data;
    expect(run.image.source).toBe('edited');

    const sent = openai.generate.mock.calls[0][0] as { referenceImages?: { bytes: Uint8Array; mimeType: string; filename: string }[] };
    expect(sent.referenceImages?.length).toBe(1);
    expect(sent.referenceImages?.[0].mimeType).toBe('image/png');
    expect(sent.referenceImages?.[0].filename).toBe('chirashi.png');
    expect(sent.referenceImages?.[0].bytes).toEqual(PNG);

    const row = testDb.raw.prepare('SELECT parent_image_id, source FROM banner_images WHERE id = ?').get(run.image.id) as { parent_image_id: string; source: string };
    expect(row.parent_image_id).toBe(base.id);
    expect(testDb.raw.prepare("SELECT reason FROM banner_usage_ledger ORDER BY rowid DESC LIMIT 1").get()).toEqual({ reason: 'edit' });
  });

  it('雰囲気を参考にする: 参考の文がプロンプトに入り、できた画像は generated のまま元をたどれる', async () => {
    const project = await createProject();
    const base = await uploadedImage(project.id);
    let res = await call('POST', `/api/hq/banners/projects/${project.id}/generations`, {
      ...GENERATE_BODY,
      count: 1,
      referenceImageId: base.id,
      referenceMode: 'inspire',
    });
    expect(res.status).toBe(201);
    const generation = (await res.json<{ data: { id: string; finalPrompt: string } }>()).data;
    expect(generation.finalPrompt).toContain('添付した画像は参考です');
    expect(generation.finalPrompt).toContain('「春の感謝祭」');
    openai.generate.mockResolvedValue({ bytes: JPEG, mimeType: 'image/jpeg', model: 'gpt-image-2' });
    res = await call('POST', `/api/hq/banners/generations/${generation.id}/run`);
    const run = (await res.json<{ data: { image: { id: string; source: string } } }>()).data;
    expect(run.image.source).toBe('generated');
    const row = testDb.raw.prepare('SELECT parent_image_id FROM banner_images WHERE id = ?').get(run.image.id) as { parent_image_id: string };
    expect(row.parent_image_id).toBe(base.id);
  });

  it('参照画像は自分の統括の消していない画像だけ。使い方が無いと 400', async () => {
    const project = await createProject();
    const base = await uploadedImage(project.id);
    let res = await call('POST', `/api/hq/banners/projects/${project.id}/generations`, { ...GENERATE_BODY, referenceImageId: base.id });
    expect(res.status).toBe(400);
    res = await call('POST', `/api/hq/banners/projects/${project.id}/generations`, { ...GENERATE_BODY, referenceImageId: 'no-such', referenceMode: 'edit' });
    expect(res.status).toBe(400);
    await call('DELETE', `/api/hq/banners/images/${base.id}`);
    res = await call('POST', `/api/hq/banners/projects/${project.id}/generations`, { ...GENERATE_BODY, referenceImageId: base.id, referenceMode: 'edit' });
    expect(res.status).toBe(400);
  });

  it('実行時に参照画像の実体が消えていたら、分かる言葉で止めて OpenAI は呼ばない', async () => {
    const project = await createProject();
    const base = await uploadedImage(project.id);
    let res = await call('POST', `/api/hq/banners/projects/${project.id}/generations`, { ...GENERATE_BODY, count: 1, referenceImageId: base.id, referenceMode: 'edit' });
    const generation = (await res.json<{ data: { id: string } }>()).data;
    r2.store.clear();
    res = await call('POST', `/api/hq/banners/generations/${generation.id}/run`);
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toContain('参照画像が見つかりません');
    expect(openai.generate).not.toHaveBeenCalled();
  });
});


describe('WEB205 idempotent generation creation', () => {
  it('simultaneous retries create one record, replay despite mutable limits, and reject changed choices', async () => {
    const project = await createProject();
    const path = `/api/hq/banners/projects/${project.id}/generations`;
    const headers = { 'Idempotency-Key': 'same-operation' };
    const responses = await Promise.all([call('POST',path,GENERATE_BODY,{headers}), call('POST',path,GENERATE_BODY,{headers})]);
    expect(responses.map(r=>r.status)).toEqual([201,201]);
    const ids = await Promise.all(responses.map(async r=>(await r.json() as { data: { id: string } }).data.id));
    expect(ids[0]).toBe(ids[1]);
    expect(testDb.raw.prepare('SELECT COUNT(*) AS n FROM banner_generations').get()).toEqual({ n: 1 });
    const replay = await call('POST',path,GENERATE_BODY,{headers,env:{ OPENAI_API_KEY: undefined }});
    expect(replay.status).toBe(201);
    expect((await replay.json() as { data: { id: string } }).data.id).toBe(ids[0]);
    expect((await call('POST',path,{...GENERATE_BODY,count:1},{headers})).status).toBe(409);
    expect((await call('POST',path,GENERATE_BODY,{headers,staff:hqAdmin({tenantId:'tenant-2'})})).status).toBe(404);
    const other = await createProject('別の試み');
    expect((await call('POST',`/api/hq/banners/projects/${other.id}/generations`,GENERATE_BODY,{headers})).status).toBe(201);
    expect(openai.generate).not.toHaveBeenCalled();
  });
});

describe('WEB206 server-owned continuation',()=>{
  it('starts only newly accepted staging jobs from the dedicated cron', async () => {
    const { scheduled } = await import('../cron/scheduled.js');
    const project = await createProject();
    const path = `/api/hq/banners/projects/${project.id}/generations`;
    const body = { ...GENERATE_BODY, count: 1 };
    const legacyKey = { 'Idempotency-Key': 'before-staging-cron' };
    const staging = env({
      DEPLOY_ENV: 'staging',
      WORKER_NAME: 'nen-line-stg',
      WORKER_PUBLIC_URL: 'https://stg-api.musubo.jp',
      D1_DATABASE_ID: QA_STAGING_DATABASE,
    });
    const legacyResponse = await call('POST', path, body, { headers: legacyKey });
    const replayResponse = await call('POST', path, body, { headers: legacyKey, env: staging });
    const freshResponse = await call('POST', path, body, { env: staging });
    expect([legacyResponse.status, replayResponse.status, freshResponse.status]).toEqual([201, 201, 201]);
    const legacy = (await legacyResponse.json<{ data: { id: string } }>()).data;
    const replay = (await replayResponse.json<{ data: { id: string } }>()).data;
    const fresh = (await freshResponse.json<{ data: { id: string } }>()).data;
    expect(replay.id).toBe(legacy.id);
    expect(openai.generate).not.toHaveBeenCalled();
    openai.generate.mockResolvedValue({ bytes: JPEG, mimeType: 'image/jpeg' });

    const tick = () => scheduled({ cron: STAGING_BANNER_GENERATION_CRON, scheduledTime: Date.now() } as ScheduledEvent,
      staging, {} as ExecutionContext);
    await tick();
    await tick();

    expect(openai.generate).toHaveBeenCalledOnce();
    const progress = testDb.raw.prepare('SELECT status, done_count FROM banner_generations WHERE id = ?');
    expect(progress.get(fresh.id)).toEqual({ status: 'done', done_count: 1 });
    expect(progress.get(legacy.id)).toEqual({ status: 'queued', done_count: 0 });
  });

 it('finishes every image from the existing cron without any browser run requests',async()=>{
  const {processDueBannerGenerations}=await import('../services/banner-jobs.js');
  const project=await createProject();const created=await call('POST',`/api/hq/banners/projects/${project.id}/generations`,{...GENERATE_BODY,count:3,cropPosition:'top'});
  const g=(await created.json<{data:{id:string}}>()).data;openai.generate.mockResolvedValue({bytes:JPEG,mimeType:'image/jpeg'});
  for(let n=0;n<4;n++)await processDueBannerGenerations(env());
  expect(openai.generate).toHaveBeenCalledTimes(3);
  expect(testDb.raw.prepare('SELECT status,done_count,failed_count,crop_gravity FROM banner_generations WHERE id=?').get(g.id))
   .toEqual({status:'done',done_count:3,failed_count:0,crop_gravity:'top'});
  expect(testDb.raw.prepare('SELECT count(*) AS n FROM banner_usage_ledger').get()).toEqual({n:3});
 });
 it('recovers the saved raw image after the database save fails, without a second paid generation',async()=>{
  const {processBannerGeneration,processDueBannerGenerations}=await import('../services/banner-jobs.js');
  const project=await createProject();const created=await call('POST',`/api/hq/banners/projects/${project.id}/generations`,{...GENERATE_BODY,count:1});
  const g=(await created.json<{data:{id:string}}>()).data;openai.generate.mockResolvedValue({bytes:JPEG,mimeType:'image/jpeg'});
  testDb.raw.exec("CREATE TRIGGER break_save BEFORE INSERT ON banner_images BEGIN SELECT RAISE(ABORT,'database interrupted');END");
  await expect(processBannerGeneration(env(),g.id,DEFAULT_TENANT_ID)).rejects.toThrow();expect(openai.generate).toHaveBeenCalledOnce();
  expect(testDb.raw.prepare('SELECT count(*) AS n FROM banner_usage_ledger').get()).toEqual({n:0});
  testDb.raw.exec("DROP TRIGGER break_save;UPDATE workflow_steps SET next_attempt_at=0 WHERE status='failed'");
  await processDueBannerGenerations(env());expect(openai.generate).toHaveBeenCalledOnce();
  expect(testDb.raw.prepare('SELECT status,done_count FROM banner_generations').get()).toEqual({status:'done',done_count:1});
  expect(testDb.raw.prepare('SELECT count(*) AS n FROM banner_usage_ledger').get()).toEqual({n:1});
 });
 it('keeps a stop request made during generation and never starts the next image',async()=>{
  const {processBannerGeneration,processDueBannerGenerations}=await import('../services/banner-jobs.js');
  const project=await createProject();const created=await call('POST',`/api/hq/banners/projects/${project.id}/generations`,GENERATE_BODY);
  const g=(await created.json<{data:{id:string}}>()).data;let entered!:()=>void,release!:()=>void;
  const started=new Promise<void>(resolve=>entered=resolve),wait=new Promise<void>(resolve=>release=resolve);
  openai.generate.mockImplementation(async()=>{entered();await wait;return {bytes:JPEG,mimeType:'image/jpeg'}});
  const running=processBannerGeneration(env(),g.id,DEFAULT_TENANT_ID);await started;
  await processDueBannerGenerations(env());expect(openai.generate).toHaveBeenCalledOnce();
  expect((await call('POST',`/api/hq/banners/generations/${g.id}/cancel`)).status).toBe(200);release();await running;
  await processDueBannerGenerations(env());expect(openai.generate).toHaveBeenCalledOnce();
  expect(testDb.raw.prepare('SELECT status,stop_requested_at FROM banner_generations').get()).toMatchObject({status:'canceled',stop_requested_at:expect.any(String)});
 });
});


describe('登録画像の検査状態をコピー先へ持ち越す', () => {
  async function quarantinedImage() {
    const project = await createProject();
    const uploaded = await call('POST', `/api/hq/banners/projects/${project.id}/uploads`, { filename: 'reference.png', data: `data:image/png;base64,${toB64(PNG)}` });
    expect(uploaded.status).toBe(201);
    const image = (await uploaded.json<{ data: { id: string } }>()).data;
    const row = testDb.raw.prepare('SELECT media_id FROM banner_images WHERE id=?').get(image.id) as { media_id: string };
    testDb.raw.prepare(`INSERT INTO media_file_scans(id,subject_kind,subject_id,media_id,filename,mime_type,size_bytes,status) VALUES ('source-scan','media',?,?,'reference.png','image/png',?,'quarantined')`).run(row.media_id, row.media_id, PNG.length);
    return { project, image };
  }
  it('しまった画像を店舗へ複製せず、確認済みになれば従来どおり渡す', async () => {
    const { image } = await quarantinedImage();
    const before = r2.store.size;
    expect((await call('POST', `/api/hq/banners/images/${image.id}/deliver`, { lineAccountIds: ['account-1'] })).status).toBe(409);
    expect(r2.store.size).toBe(before);
    expect(testDb.raw.prepare('SELECT count(*) AS n FROM banner_image_deliveries').get()).toEqual({ n: 0 });
    testDb.raw.prepare("UPDATE media_file_scans SET status='clean' WHERE id='source-scan'").run();
    expect((await call('POST', `/api/hq/banners/images/${image.id}/deliver`, { lineAccountIds: ['account-1'] })).status).toBe(200);
    expect(r2.store.size).toBe(before + 1);
  });
  it('しまった画像を生成サービスへ渡さない', async () => {
    const { project, image } = await quarantinedImage();
    const queued = await call('POST', `/api/hq/banners/projects/${project.id}/generations`, { ...GENERATE_BODY, count: 1, referenceImageId: image.id, referenceMode: 'edit' });
    expect(queued.status).toBe(201);
    const generation = (await queued.json<{ data: { id: string } }>()).data;
    expect((await call('POST', `/api/hq/banners/generations/${generation.id}/run`)).status).toBe(400);
    expect(openai.generate).not.toHaveBeenCalled();
  });
});
