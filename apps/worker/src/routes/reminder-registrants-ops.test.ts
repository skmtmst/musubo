/*
 * リマインダ別の登録者操作を実SQLite + 実routeで確認する。
 * 送信済み履歴を消さず、古い未送信だけを止めることまでDBを直接読む。
 */
import { Hono } from 'hono';
import { beforeEach, describe, expect, test } from 'vitest';
import type { Env } from '../worker-env.js';
import { authMiddleware } from '../middleware/auth.js';
import { createTestD1, insertFriend, type SqliteD1 } from '../test-utils/d1-sqlite.js';

const TENANT = 'tenant-registrants';
const ACC_A = 'account-a';
const ACC_B = 'account-b';
const REMINDER_A = 'reminder-a';
const REMINDER_B = 'reminder-b';
const FRIEND_A = 'friend-a';
const FRIEND_B = 'friend-b';
const ENROLLMENT_A = 'registration-a';
const ENROLLMENT_B = 'registration-b';
const OWNER_KEY = 'owner-registrants-key';
const ADMIN_KEY = 'admin-registrants-key';
const STAFF_A_KEY = 'staff-a-registrants-key';
const STAFF_B_KEY = 'staff-b-registrants-key';

let sqlite: SqliteD1;
let remindersRoute: Awaited<typeof import('./reminders.js')>['reminders'];

function seed() {
  sqlite.raw.prepare(`INSERT INTO tenants (id, name) VALUES (?, '統括')`).run(TENANT);
  for (const id of [ACC_A, ACC_B]) {
    sqlite.raw.prepare(`INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret, tenant_id) VALUES (?, ?, ?, 'token', 'secret', ?)`)
      .run(id, `channel-${id}`, id, TENANT);
  }
  sqlite.raw.prepare(`INSERT INTO staff_members (id, name, role, api_key, tenant_id, account_scope) VALUES ('owner', 'オーナー', 'owner', ?, ?, 'all')`)
    .run(OWNER_KEY, TENANT);
  sqlite.raw.prepare(`INSERT INTO staff_members (id, name, role, api_key, tenant_id, account_scope) VALUES ('admin', '管理者', 'admin', ?, ?, 'all')`)
    .run(ADMIN_KEY, TENANT);
  for (const [id, key, accountId] of [['staff-a', STAFF_A_KEY, ACC_A], ['staff-b', STAFF_B_KEY, ACC_B]] as const) {
    sqlite.raw.prepare(`INSERT INTO staff_members (id, name, role, api_key, tenant_id, account_scope, permission_keys) VALUES (?, ?, 'staff', ?, ?, 'accounts', '["/reminders"]')`)
      .run(id, id, key, TENANT);
    sqlite.raw.prepare(`INSERT INTO staff_account_scopes (staff_id, line_account_id, created_at) VALUES (?, ?, '2026-09-15T00:00:00.000Z')`)
      .run(id, accountId);
  }
  insertFriend(sqlite.raw, FRIEND_A, { line_account_id: ACC_A, display_name: '見本 171' });
  insertFriend(sqlite.raw, FRIEND_B, { line_account_id: ACC_B, display_name: '別店舗 太郎' });
  for (const [id, accountId] of [[REMINDER_A, ACC_A], [REMINDER_B, ACC_B]] as const) {
    sqlite.raw.prepare(`INSERT INTO reminders (id, name, line_account_id, trigger_type, lifecycle_status) VALUES (?, ?, ?, 'manual', 'published')`)
      .run(id, `通知-${id}`, accountId);
  }
  for (const [id, friendId, reminderId] of [[ENROLLMENT_A, FRIEND_A, REMINDER_A], [ENROLLMENT_B, FRIEND_B, REMINDER_B]] as const) {
    sqlite.raw.prepare(`INSERT INTO friend_reminders (id, friend_id, reminder_id, target_date, status, reminder_version_id, lock_version) VALUES (?, ?, ?, '2026-10-01T00:00:00.000Z', 'active', 'snapshot-1', 0)`)
      .run(id, friendId, reminderId);
  }
  sqlite.raw.prepare(`INSERT INTO reminder_steps (id, reminder_id, offset_minutes, message_type, message_content) VALUES ('step-sent', ?, 0, 'text', '送信済み')`)
    .run(REMINDER_A);
  sqlite.raw.prepare(`INSERT INTO friend_reminder_deliveries (id, friend_reminder_id, reminder_step_id, delivered_at) VALUES ('delivery-sent', ?, 'step-sent', '2026-09-10T00:00:00.000Z')`)
    .run(ENROLLMENT_A);
  const now = '2026-09-15T00:00:00.000Z';
  for (const [id, status] of [['queued-run', 'queued'], ['retry-run', 'retry_wait'], ['claimed-run', 'claimed'], ['sent-run', 'succeeded']] as const) {
    sqlite.raw.prepare(
      `INSERT INTO reminder_delivery_runs (id, line_account_id, reminder_id, friend_reminder_id, friend_id, reminder_step_id, scheduled_at, idempotency_key, line_retry_key, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, '2026-09-20T00:00:00.000Z', ?, ?, ?, ?, ?)`,
    ).run(id, ACC_A, REMINDER_A, ENROLLMENT_A, FRIEND_A, `step-${id}`, `idem-${id}`, `retry-${id}`, status, now, now);
  }
}

function app() {
  const instance = new Hono<Env>();
  instance.use('*', authMiddleware);
  instance.route('/', remindersRoute);
  return instance;
}
const env = () => ({ DB: sqlite.db }) as unknown as Env['Bindings'];
const auth = (key: string) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${key}` });
async function request(path: string, key: string, method = 'GET', body?: unknown) {
  return app().request(path, { method, headers: auth(key), body: body === undefined ? undefined : JSON.stringify(body) }, env());
}
function readEnrollment() {
  return sqlite.raw.prepare(`SELECT target_date, status, reminder_version_id, lock_version FROM friend_reminders WHERE id = ?`).get(ENROLLMENT_A) as {
    target_date: string; status: string; reminder_version_id: string | null; lock_version: number;
  };
}
function runStatuses() {
  return sqlite.raw.prepare(`SELECT id, status FROM reminder_delivery_runs WHERE friend_reminder_id = ? ORDER BY id`).all(ENROLLMENT_A) as Array<{ id: string; status: string }>;
}
function deliveredHistoryCount() {
  return (sqlite.raw.prepare(`SELECT COUNT(*) AS count FROM friend_reminder_deliveries WHERE friend_reminder_id = ?`).get(ENROLLMENT_A) as { count: number }).count;
}

beforeEach(async () => {
  sqlite = createTestD1({ loginPolicy: 'off' });
  seed();
  ({ reminders: remindersRoute } = await import('./reminders.js'));
});

describe('リマインダ登録者の変更・取消・再開 (N-064)', () => {
  test('owner と担当accountの staff は一覧と基準日変更を行え、旧未送信だけを止めて送信済みを残す', async () => {
    const listed = await request(`/api/reminders/${REMINDER_A}/registrants`, STAFF_A_KEY);
    expect(listed.status).toBe(200);
    expect((await listed.json() as { data: Array<{ friendName: string; lockVersion: number }> }).data).toEqual([
      expect.objectContaining({ friendName: '見本 171', lockVersion: 0 }),
    ]);
    const moved = await request(`/api/reminders/${REMINDER_A}/registrants/${ENROLLMENT_A}`, STAFF_A_KEY, 'PATCH', {
      targetDate: '2026-10-05T10:00:00+09:00', expectedLockVersion: 0,
    });
    expect(moved.status).toBe(200);
    expect(readEnrollment()).toMatchObject({ target_date: '2026-10-05T01:00:00.000Z', status: 'active', reminder_version_id: 'snapshot-1', lock_version: 1 });
    expect(runStatuses()).toEqual([
      { id: 'claimed-run', status: 'cancelled' }, { id: 'queued-run', status: 'cancelled' },
      { id: 'retry-run', status: 'cancelled' }, { id: 'sent-run', status: 'succeeded' },
    ]);
    expect(deliveredHistoryCount()).toBe(1);
    // 同じ応答だけを失った再送は成功扱いにして、版も実行履歴も増やさない。
    const replay = await request(`/api/reminders/${REMINDER_A}/registrants/${ENROLLMENT_A}`, OWNER_KEY, 'PATCH', {
      targetDate: '2026-10-05T10:00:00+09:00', expectedLockVersion: 0,
    });
    expect(replay.status).toBe(200);
    expect((await replay.json() as { data: { replayed: boolean } }).data.replayed).toBe(true);
    expect(readEnrollment().lock_version).toBe(1);
  });

  test('admin は従来どおり登録者一覧と操作を行える', async () => {
    expect((await request(`/api/reminders/${REMINDER_A}/registrants`, ADMIN_KEY)).status).toBe(200);
    const changed = await request(`/api/reminders/${REMINDER_A}/registrants/${ENROLLMENT_A}`, ADMIN_KEY, 'PATCH', {
      targetDate: '2026-10-03T10:00:00+09:00', expectedLockVersion: 0,
    });
    expect(changed.status).toBe(200);
    expect(readEnrollment()).toMatchObject({ lock_version: 1, status: 'active' });
  });

  test('取消と再開は同じ版を二重変更せず、再開しても過去の送信・旧runを復活させない', async () => {
    const cancelled = await request(`/api/reminders/${REMINDER_A}/registrants/${ENROLLMENT_A}/cancel`, OWNER_KEY, 'POST', { expectedLockVersion: 0 });
    expect(cancelled.status).toBe(200);
    expect(readEnrollment()).toMatchObject({ status: 'cancelled', reminder_version_id: 'snapshot-1', lock_version: 1 });
    expect(runStatuses().find((row) => row.id === 'sent-run')?.status).toBe('succeeded');
    expect(deliveredHistoryCount()).toBe(1);
    expect(runStatuses().filter((row) => row.id !== 'sent-run').every((row) => row.status === 'cancelled')).toBe(true);
    expect(deliveredHistoryCount()).toBe(1);
    const resume = await request(`/api/reminders/${REMINDER_A}/registrants/${ENROLLMENT_A}/resume`, OWNER_KEY, 'POST', { expectedLockVersion: 1 });
    expect(resume.status).toBe(200);
    expect(readEnrollment()).toMatchObject({ status: 'active', reminder_version_id: 'snapshot-1', lock_version: 2 });
    expect(runStatuses().filter((row) => row.id !== 'sent-run').every((row) => row.status === 'cancelled')).toBe(true);
    const stale = await request(`/api/reminders/${REMINDER_A}/registrants/${ENROLLMENT_A}/cancel`, OWNER_KEY, 'POST', { expectedLockVersion: 0 });
    expect(stale.status).toBe(409);
    expect(readEnrollment().status).toBe('active');
  });

  test('担当外accountは存在を漏らさず404、入力不正と競合は状態を変えない', async () => {
    expect((await request(`/api/reminders/${REMINDER_A}/registrants`, STAFF_B_KEY)).status).toBe(404);
    expect((await request(`/api/reminders/${REMINDER_A}/registrants/${ENROLLMENT_A}`, STAFF_B_KEY, 'PATCH', {
      targetDate: '2026-10-05T10:00:00+09:00', expectedLockVersion: 0,
    })).status).toBe(404);
    expect((await request(`/api/reminders/${REMINDER_A}/registrants/${ENROLLMENT_A}`, OWNER_KEY, 'PATCH', {
      targetDate: '2026-10-05', expectedLockVersion: 0,
    })).status).toBe(400);
    expect((await request(`/api/reminders/${REMINDER_A}/registrants/${ENROLLMENT_A}`, OWNER_KEY, 'PATCH', {
      targetDate: '2026-10-05T10:00:00+09:00', expectedLockVersion: 7,
    })).status).toBe(409);
    expect(readEnrollment()).toMatchObject({ target_date: '2026-10-01T00:00:00.000Z', status: 'active', lock_version: 0 });
  });

  test('登録者0件も通常の200で返し、存在しない登録者は404', async () => {
    sqlite.raw.prepare(`DELETE FROM friend_reminders WHERE reminder_id = ?`).run(REMINDER_B);
    const empty = await request(`/api/reminders/${REMINDER_B}/registrants`, OWNER_KEY);
    expect(empty.status).toBe(200);
    expect((await empty.json() as { data: unknown[] }).data).toEqual([]);
    expect((await request(`/api/reminders/${REMINDER_A}/registrants/missing/cancel`, OWNER_KEY, 'POST', { expectedLockVersion: 0 })).status).toBe(404);
  });
});
