/** 個人の視聴履歴は owner/admin に限り、staff の分析には集計だけを残す。CSV 以外の入口も同じ境界を守ることを実 route・認証・SQLite で確かめる。 */
import { Hono } from 'hono';
import { beforeEach, describe, expect, test } from 'vitest';
import type { Env } from '../worker-env.js';
import { authMiddleware } from '../middleware/auth.js';
import { createTestD1, insertFriend, type SqliteD1 } from '../test-utils/d1-sqlite.js';

const TENANT = 'tenant-1';
const ACC_A = 'acc-a';
const ACC_B = 'acc-b';
const KEY_OWNER = 'key-owner-aaa';
const KEY_ADMIN = 'key-admin-aaa';
const KEY_STAFF_A = 'key-staff-aaa';
const KEY_STAFF_B = 'key-staff-bbb';
const KEY_STAFF_NOPERM = 'key-staff-noperm';

const WEBINAR_A = 'webinar-a';
const WEBINAR_B = 'webinar-b';
const FRIEND_A = 'friend-a1';
const FRIEND_B = 'friend-b1';
const FRIEND_NAME_A = '参加者 甲';

function seed(sqlite: SqliteD1['raw']) {
  sqlite.prepare(`INSERT INTO tenants (id, name) VALUES ('tenant-1', '統括1')`).run();
  for (const id of [ACC_A, ACC_B]) {
    sqlite.prepare(
      `INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret, tenant_id)
       VALUES (?, ?, ?, 'token', 'secret', 'tenant-1')`,
    ).run(id, `channel-${id}`, id);
  }
  sqlite.prepare(
    `INSERT INTO staff_members (id, name, role, api_key, tenant_id, account_scope)
     VALUES ('owner-1', 'オーナー', 'owner', ?, 'tenant-1', 'all')`,
  ).run(KEY_OWNER);
  sqlite.prepare(
    `INSERT INTO staff_members (id, name, role, api_key, tenant_id, account_scope)
     VALUES ('admin-1', '管理者', 'admin', ?, 'tenant-1', 'all')`,
  ).run(KEY_ADMIN);
  // /webinars 権限を持つ現場staff。見られるのは acc-a だけ。
  sqlite.prepare(
    `INSERT INTO staff_members (id, name, role, api_key, tenant_id, account_scope, permission_keys)
     VALUES ('staff-a', '担当A', 'staff', ?, 'tenant-1', 'accounts', '["/webinars"]')`,
  ).run(KEY_STAFF_A);
  sqlite.prepare(
    `INSERT INTO staff_account_scopes (staff_id, line_account_id, created_at)
     VALUES ('staff-a', ?, '2026-09-01T00:00:00.000Z')`,
  ).run(ACC_A);
  // 同じく /webinars 権限を持つが、見られるのは acc-b だけ。
  sqlite.prepare(
    `INSERT INTO staff_members (id, name, role, api_key, tenant_id, account_scope, permission_keys)
     VALUES ('staff-b', '担当B', 'staff', ?, 'tenant-1', 'accounts', '["/webinars"]')`,
  ).run(KEY_STAFF_B);
  sqlite.prepare(
    `INSERT INTO staff_account_scopes (staff_id, line_account_id, created_at)
     VALUES ('staff-b', ?, '2026-09-01T00:00:00.000Z')`,
  ).run(ACC_B);
  // /webinars 権限を持たないstaff。認証middlewareが 403 で止めるはず。
  sqlite.prepare(
    `INSERT INTO staff_members (id, name, role, api_key, tenant_id, account_scope)
     VALUES ('staff-noperm', '権限なし', 'staff', ?, 'tenant-1', 'all')`,
  ).run(KEY_STAFF_NOPERM);

  for (const [id, accountId] of [[WEBINAR_A, ACC_A], [WEBINAR_B, ACC_B]] as const) {
    sqlite.prepare(
      `INSERT INTO webinars (id, account_id, title, slug, status, duration_seconds, schedule_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', 1800, '[]', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`,
    ).run(id, accountId, `ウェビナー${id}`, `slug-${id}`);
  }

  insertFriend(sqlite, FRIEND_A, { line_account_id: ACC_A, display_name: FRIEND_NAME_A });
  insertFriend(sqlite, FRIEND_B, { line_account_id: ACC_B, display_name: '見本 49' });

  // 視聴履歴: 個人を特定できる行（名前・視聴秒数・CTA まで出る）。
  sqlite.prepare(
    `INSERT INTO webinar_viewers (id, webinar_id, friend_id, session_start_at, joined_at, last_position_seconds, cta_clicked_at)
     VALUES ('wv-a1', ?, ?, 1000, '2026-09-10T20:00:00.000Z', 900, '2026-09-10T20:30:00.000Z')`,
  ).run(WEBINAR_A, FRIEND_A);
  sqlite.prepare(
    `INSERT INTO webinar_viewers (id, webinar_id, friend_id, session_start_at, joined_at, last_position_seconds)
     VALUES ('wv-b1', ?, ?, 1000, '2026-09-10T21:00:00.000Z', 300)`,
  ).run(WEBINAR_B, FRIEND_B);
  sqlite.prepare(
    `INSERT INTO webinar_registrations (id, webinar_id, friend_id, session_start_at, created_at, status)
     VALUES ('wr-a1', ?, ?, 1000, '2026-09-09T00:00:00.000Z', 'active')`,
  ).run(WEBINAR_A, FRIEND_A);
}

let sqlite: SqliteD1;
let webinarRoutes: Awaited<typeof import('./webinars.js')>['webinarRoutes'];

function app() {
  const instance = new Hono<Env>();
  // 認証は実物。Bearer APIキー → staff_members → 役割・権限・account境界まで本番通り。
  instance.use('*', authMiddleware);
  instance.route('/', webinarRoutes);
  return instance;
}

const env = () => ({ DB: sqlite.db }) as unknown as Env['Bindings'];

function get(path: string, apiKey: string | null) {
  return app().request(path, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
  }, env());
}

beforeEach(async () => {
  sqlite = createTestD1({ loginPolicy: 'off' });
  seed(sqlite.raw);
  ({ webinarRoutes } = await import('./webinars.js'));
});

describe('ウェビナー個人視聴履歴の owner/admin 境界 (N-118)', () => {
  test('閲覧権限があるstaffは参加者を見られる', async () => {
    const res = await get(`/api/webinars/${WEBINAR_A}/participants`, KEY_STAFF_A);
    expect(res.status).toBe(200);
  });

  test('staffは参加者CSVを書き出せない', async () => {
    const res = await get(`/api/webinars/${WEBINAR_A}/participants.csv`, KEY_STAFF_A);
    expect(res.status).toBe(403);
  });

  test('staffのanalyticsは集計を返し個人履歴を含まない', async () => {
    const res = await get(`/api/webinars/${WEBINAR_A}/analytics`, KEY_STAFF_A);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      data: {
        summary: { viewers: number };
        participants: unknown[];
      };
    };
    // 集計（視聴者数・離脱など）は従来どおり見られる。
    expect(body.data.summary.viewers).toBe(1);
    // 担当アカウントの個人履歴を返す。
    expect(body.data.participants).toEqual([]);
    expect(JSON.stringify(body)).not.toContain(FRIEND_NAME_A);
  });

  test('owner は participants JSON と analytics の個人履歴を見られる', async () => {
    const list = await get(`/api/webinars/${WEBINAR_A}/participants`, KEY_OWNER);
    expect(list.status).toBe(200);
    const listBody = await list.json() as { data: { items: Array<{ friendName: string | null; maxWatchedSeconds: number }> } };
    expect(listBody.data.items).toHaveLength(1);
    expect(listBody.data.items[0].friendName).toBe(FRIEND_NAME_A);
    expect(listBody.data.items[0].maxWatchedSeconds).toBe(900);

    const analytics = await get(`/api/webinars/${WEBINAR_A}/analytics`, KEY_OWNER);
    expect(analytics.status).toBe(200);
    const analyticsBody = await analytics.json() as { data: { participants: Array<{ friendName: string | null }> } };
    expect(analyticsBody.data.participants[0]?.friendName).toBe(FRIEND_NAME_A);
  });

  test('admin も participants JSON と CSV を使える', async () => {
    const list = await get(`/api/webinars/${WEBINAR_A}/participants`, KEY_ADMIN);
    expect(list.status).toBe(200);
    const csv = await get(`/api/webinars/${WEBINAR_A}/participants.csv`, KEY_ADMIN);
    expect(csv.status).toBe(200);
    expect(await csv.text()).toContain(FRIEND_NAME_A);
  });

  test('別アカウントのウェビナーへは owner/admin でない staff が届かない (404)', async () => {
    // staff-b は acc-b だけ見られる。acc-a の webinar-a を指定しても
    // requireVisibleWebinar が 404 で止め、個人データを漏らさない。
    const list = await get(`/api/webinars/${WEBINAR_A}/participants`, KEY_STAFF_B);
    expect(list.status).toBe(404);
    const analytics = await get(`/api/webinars/${WEBINAR_A}/analytics`, KEY_STAFF_B);
    expect(analytics.status).toBe(404);
    const csv = await get(`/api/webinars/${WEBINAR_A}/participants.csv`, KEY_STAFF_B);
    expect(csv.status).toBe(404);
  });

  test('担当外アカウントのウェビナーでも owner は従来どおり見られる', async () => {
    const res = await get(`/api/webinars/${WEBINAR_B}/participants`, KEY_OWNER);
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { items: Array<{ friendId: string }> } };
    expect(body.data.items[0]?.friendId).toBe(FRIEND_B);
  });

  test('/webinars 権限を持たない staff は認証middlewareが 403 で止める', async () => {
    const res = await get(`/api/webinars/${WEBINAR_A}/participants`, KEY_STAFF_NOPERM);
    expect(res.status).toBe(403);
  });

  test('未認証は 401', async () => {
    const res = await get(`/api/webinars/${WEBINAR_A}/participants`, null);
    expect(res.status).toBe(401);
  });
});
