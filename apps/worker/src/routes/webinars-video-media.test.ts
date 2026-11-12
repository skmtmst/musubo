/** 動画指定は自由な R2 prefix を受け付けず、同じアカウントの kind=video の登録メディアからキーを解決する。実 route・認証・SQLite で検証し、R2 自体へは触れない。 */
import { Hono } from 'hono';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { Env } from '../worker-env.js';
import { authMiddleware } from '../middleware/auth.js';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';

const TENANT = 'tenant-1';
const ACC_A = 'acc-a';
const ACC_B = 'acc-b';
const KEY_OWNER = 'key-owner-aaa';
const KEY_STAFF_B = 'key-staff-bbb';

const WEBINAR_A = 'webinar-a';
const WEBINAR_B = 'webinar-b';

const MEDIA_VIDEO_A = 'med-video-a';
const MEDIA_IMAGE_A = 'med-image-a';
const MEDIA_VIDEO_B = 'med-video-b';

function seed(sqlite: SqliteD1['raw']) {
  sqlite.prepare(`INSERT INTO tenants (id, name) VALUES (?, '統括1')`).run(TENANT);
  for (const id of [ACC_A, ACC_B]) {
    sqlite.prepare(
      `INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret, tenant_id)
       VALUES (?, ?, ?, 'token', 'secret', ?)`,
    ).run(id, `channel-${id}`, id, TENANT);
  }
  sqlite.prepare(
    `INSERT INTO staff_members (id, name, role, api_key, tenant_id, account_scope)
     VALUES ('owner-1', 'オーナー', 'owner', ?, ?, 'all')`,
  ).run(KEY_OWNER, TENANT);
  sqlite.prepare(
    `INSERT INTO staff_members (id, name, role, api_key, tenant_id, account_scope, permission_keys)
     VALUES ('staff-b', '担当', 'staff', ?, ?, 'accounts', '["/webinars"]')`,
  ).run(KEY_STAFF_B, TENANT);
  sqlite.prepare(
    `INSERT INTO staff_account_scopes (staff_id, line_account_id, created_at)
     VALUES ('staff-b', ?, '2026-09-01T00:00:00.000Z')`,
  ).run(ACC_B);

  for (const [id, accountId, videoPrefix] of [
    [WEBINAR_A, ACC_A, null],
    [WEBINAR_B, ACC_B, 'webinars/legacy-set'],
  ] as const) {
    sqlite.prepare(
      `INSERT INTO webinars (id, account_id, title, slug, status, video_prefix, duration_seconds, schedule_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'draft', ?, 1800, '[]', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`,
    ).run(id, accountId, `ウェビナー${id}`, `slug-${id}`, videoPrefix);
  }

  for (const [id, accountId, kind, r2Key] of [
    [MEDIA_VIDEO_A, ACC_A, 'video', 'media/acc-a/video-1.mp4'],
    [MEDIA_IMAGE_A, ACC_A, 'image', 'media/acc-a/image-1.png'],
    [MEDIA_VIDEO_B, ACC_B, 'video', 'media/acc-b/video-9.mp4'],
  ] as const) {
    sqlite.prepare(
      `INSERT INTO media (id, line_account_id, kind, filename, mime_type, size_bytes, r2_key, created_at)
       VALUES (?, ?, ?, ?, 'application/octet-stream', 1000, ?, '2026-09-01T00:00:00.000Z')`,
    ).run(id, accountId, kind, `file-${id}`, r2Key);
  }
}

let sqlite: SqliteD1;
let webinarRoutes: Awaited<typeof import('./webinars.js')>['webinarRoutes'];

function app() {
  const instance = new Hono<Env>();
  instance.use('*', authMiddleware);
  instance.route('/', webinarRoutes);
  return instance;
}

const env = () => ({ DB: sqlite.db }) as unknown as Env['Bindings'];

function put(webinarId: string, apiKey: string | null, body: Record<string, unknown>) {
  return app().request(`/api/webinars/${webinarId}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({ expectedVersion: (sqlite.raw.prepare('SELECT version FROM webinar_editor_settings WHERE webinar_id = ?').get(webinarId) as {version:number} | undefined)?.version ?? 0, ...body }),
  }, env());
}

function get(webinarId: string, apiKey: string) {
  return app().request(`/api/webinars/${webinarId}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  }, env());
}

function post(apiKey: string, body: Record<string, unknown>) {
  return app().request('/api/webinars', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  }, env());
}

function savedPrefix(webinarId: string): string | null {
  const row = sqlite.raw
    .prepare('SELECT video_prefix FROM webinars WHERE id = ?')
    .get(webinarId) as { video_prefix: string | null };
  return row.video_prefix;
}

beforeEach(async () => {
  sqlite = createTestD1({ loginPolicy: 'off' });
  seed(sqlite.raw);
  ({ webinarRoutes } = await import('./webinars.js'));
});

describe('ウェビナー停止時の版競合', () => {
  test('版確認後に設定が変わったら停止しない', async () => {
    expect((await put(WEBINAR_A, KEY_OWNER, { title: '確認前' })).status).toBe(200);
    sqlite.raw.prepare("UPDATE webinars SET status='active' WHERE id=?").run(WEBINAR_A);
    const expected = (sqlite.raw.prepare('SELECT version FROM webinar_editor_settings WHERE webinar_id=?').get(WEBINAR_A) as {version:number}).version;
    const prepare = sqlite.db.prepare.bind(sqlite.db);
    let intercepted = false;
    vi.spyOn(sqlite.db, 'prepare').mockImplementation(sql => {
      if (!intercepted && sql.includes('UPDATE webinars SET account_id')) {
        intercepted = true;
        sqlite.raw.prepare('UPDATE webinar_editor_settings SET version=version+1 WHERE webinar_id=?').run(WEBINAR_A);
      }
      return prepare(sql);
    });
    const response = await app().request(`/api/webinars/${WEBINAR_A}/pause`, {
      method: 'POST', headers: { Authorization: `Bearer ${KEY_OWNER}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedVersion: expected }),
    }, env());
    expect(intercepted).toBe(true);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ currentVersion: expected + 1, currentStatus: 'active' });
    expect((sqlite.raw.prepare('SELECT status FROM webinars WHERE id=?').get(WEBINAR_A) as {status:string}).status).toBe('active');
  });
});

test('停止の直前に保管されたウェビナーは下書きに戻さない', async () => {
  expect((await put(WEBINAR_A, KEY_OWNER, { title: '確認前' })).status).toBe(200);
  sqlite.raw.prepare("UPDATE webinars SET status='active' WHERE id=?").run(WEBINAR_A);
  const version = (sqlite.raw.prepare('SELECT version FROM webinar_editor_settings WHERE webinar_id=?').get(WEBINAR_A) as {version:number}).version;
  const prepare=sqlite.db.prepare.bind(sqlite.db);let intercepted=false;
  vi.spyOn(sqlite.db,'prepare').mockImplementation(sql=>{if(!intercepted&&sql.includes('UPDATE webinars SET account_id')){intercepted=true;sqlite.raw.prepare("UPDATE webinars SET status='archived' WHERE id=?").run(WEBINAR_A)}return prepare(sql)});
  const response=await app().request(`/api/webinars/${WEBINAR_A}/pause`,{method:'POST',headers:{Authorization:`Bearer ${KEY_OWNER}`,'Content-Type':'application/json'},body:JSON.stringify({expectedVersion:version})},env());
  expect(intercepted).toBe(true);expect(response.status).toBe(409);
  expect(sqlite.raw.prepare('SELECT status FROM webinars WHERE id=?').get(WEBINAR_A)).toEqual({status:'archived'});
});

describe('ウェビナー動画のメディア選択 (N-115)', () => {
  test('同じアカウントの動画メディアを選ぶと、保存値はそのr2_keyになる', async () => {
    const res = await put(WEBINAR_A, KEY_OWNER, { videoMediaId: MEDIA_VIDEO_A });
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { videoPrefix: string; videoMediaId: string } };
    expect(body.data.videoPrefix).toBe('media/acc-a/video-1.mp4');
    expect(body.data.videoMediaId).toBe(MEDIA_VIDEO_A);
    expect(savedPrefix(WEBINAR_A)).toBe('media/acc-a/video-1.mp4');

    const got = await get(WEBINAR_A, KEY_OWNER);
    const detail = await got.json() as { data: { videoMediaId: string | null } };
    expect(detail.data.videoMediaId).toBe(MEDIA_VIDEO_A);
  });

  test('動画でないメディアは拒否する', async () => {
    const res = await put(WEBINAR_A, KEY_OWNER, { videoMediaId: MEDIA_IMAGE_A });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string; code: string }).code).toBe('video_media_not_video');
    expect(savedPrefix(WEBINAR_A)).toBeNull();
  });

  test('別アカウントのメディアは選べない', async () => {
    const res = await put(WEBINAR_A, KEY_OWNER, { videoMediaId: MEDIA_VIDEO_B });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string; code: string }).code).toBe('video_media_not_found');
    expect(savedPrefix(WEBINAR_A)).toBeNull();
  });

  test('存在しないメディアIDは拒否する', async () => {
    const res = await put(WEBINAR_A, KEY_OWNER, { videoMediaId: 'missing-media' });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string; code: string }).code).toBe('video_media_not_found');
  });

  test('videoMediaIdとvideoPrefixの同時指定は拒否する', async () => {
    const res = await put(WEBINAR_A, KEY_OWNER, {
      videoMediaId: MEDIA_VIDEO_A,
      videoPrefix: 'hand-written/prefix',
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string; code: string }).code).toBe('ambiguous_video_source');
    expect(savedPrefix(WEBINAR_A)).toBeNull();
  });

  test('videoMediaId: null で動画を解除できる', async () => {
    const res = await put(WEBINAR_B, KEY_OWNER, { videoMediaId: null });
    expect(res.status).toBe(200);
    expect(savedPrefix(WEBINAR_B)).toBeNull();
    const got = await get(WEBINAR_B, KEY_OWNER);
    expect((await got.json() as { data: { videoMediaId: string | null } }).data.videoMediaId).toBeNull();
  });

  test('videoMediaIdを送らなければ既存のprefixはそのまま', async () => {
    const res = await put(WEBINAR_B, KEY_OWNER, { title: '別の題名' });
    expect(res.status).toBe(200);
    expect(savedPrefix(WEBINAR_B)).toBe('webinars/legacy-set');
    // ライブラリ外のprefixはメディアIDに解決できないので null を返す
    const got = await get(WEBINAR_B, KEY_OWNER);
    expect((await got.json() as { data: { videoMediaId: string | null } }).data.videoMediaId).toBeNull();
  });

  test('新規作成でもvideoMediaIdで選べる', async () => {
    const res = await post(KEY_OWNER, {
      accountId: ACC_A,
      title: '新しいウェビナー',
      slug: 'new-webinar',
      status: 'draft',
      durationSeconds: 3600,
      schedule: [],
      videoMediaId: MEDIA_VIDEO_A,
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { id: string; videoPrefix: string; videoMediaId: string } };
    expect(body.data.videoPrefix).toBe('media/acc-a/video-1.mp4');
    expect(body.data.videoMediaId).toBe(MEDIA_VIDEO_A);
  });

  test('staffが自分の範囲外のウェビナーへは変更できない', async () => {
    const res = await put(WEBINAR_A, KEY_STAFF_B, { videoMediaId: MEDIA_VIDEO_B });
    expect(res.status).toBe(404);
    expect(savedPrefix(WEBINAR_A)).toBeNull();
  });
});

describe('ウェビナー公開時の版競合', () => {
  test('更新直前に版が変われば公開状態も公開版も変えない', async () => {
    expect((await put(WEBINAR_A, KEY_OWNER, { title: '確認前' })).status).toBe(200);
    const { publishWebinarAndActivate } = await import('@line-crm/db');
    const version = (sqlite.raw.prepare('SELECT version FROM webinar_editor_settings WHERE webinar_id=?').get(WEBINAR_A) as {version:number}).version;
    const batch = sqlite.db.batch.bind(sqlite.db); let intercepted = false;
    vi.spyOn(sqlite.db, 'batch').mockImplementation(async statements => {
      if (!intercepted) {
        intercepted = true;
        sqlite.raw.prepare('UPDATE webinar_editor_settings SET version=version+1 WHERE webinar_id=?').run(WEBINAR_A);
        sqlite.raw.prepare("INSERT INTO webinar_versions(id,webinar_id,version,state,snapshot_json,created_at) SELECT 'race-snapshot',webinar_id,version+1,'draft',snapshot_json,created_at FROM webinar_versions WHERE webinar_id=? AND version=?").run(WEBINAR_A, version);
      }
      return batch(statements);
    });
    expect(await publishWebinarAndActivate(sqlite.db, WEBINAR_A, version)).toBe(false);
    expect(intercepted).toBe(true);
    expect(sqlite.raw.prepare('SELECT status FROM webinars WHERE id=?').get(WEBINAR_A)).toEqual({status:'draft'});
    expect(sqlite.raw.prepare('SELECT published_version FROM webinar_editor_settings WHERE webinar_id=?').get(WEBINAR_A)).toEqual({published_version:null});
    expect(sqlite.raw.prepare("SELECT COUNT(*) n FROM webinar_versions WHERE webinar_id=? AND state='published'").get(WEBINAR_A)).toEqual({n:0});
  });
  test('一致した公開だけ状態と公開版が同時に進み、同じ確認は再利用できない', async () => {
    expect((await put(WEBINAR_A, KEY_OWNER, { title: '確認前' })).status).toBe(200);
    const { publishWebinarAndActivate } = await import('@line-crm/db');
    const version = (sqlite.raw.prepare('SELECT version FROM webinar_editor_settings WHERE webinar_id=?').get(WEBINAR_A) as {version:number}).version;
    expect(await publishWebinarAndActivate(sqlite.db, WEBINAR_A, version)).toBe(true);
    expect(sqlite.raw.prepare('SELECT status FROM webinars WHERE id=?').get(WEBINAR_A)).toEqual({status:'active'});
    expect(sqlite.raw.prepare('SELECT version,published_version FROM webinar_editor_settings WHERE webinar_id=?').get(WEBINAR_A)).toEqual({version:version+1,published_version:version});
    expect(sqlite.raw.prepare('SELECT version,state FROM webinar_versions WHERE webinar_id=? ORDER BY version').all(WEBINAR_A)).toEqual([{version,state:'published'},{version:version+1,state:'draft'}]);
    expect(await publishWebinarAndActivate(sqlite.db, WEBINAR_A, version)).toBe(false);
  });
});
