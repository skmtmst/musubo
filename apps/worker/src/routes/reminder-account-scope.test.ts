/*
 * ルールの所属変更で他店の履歴が見えたり元の店の登録が操作不能になったりしないよう、実 route と実 SQLite で境界を確かめる。
 * 履歴・集計・検索は実行行の送信元で、登録操作は友だちの所属で絞る。親も行も見えなければ存在を漏らさず404とする。アカウント権限だけを差し替え、送信はしない。
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';
import type { Env } from '../worker-env.js';
import type { AuthenticatedStaff } from '../middleware/auth/principal/auth.js';

let scope: { allowedAccountIds: string[]; canSeeUnassigned: boolean } = {
  allowedAccountIds: ['acct-b'],
  canSeeUnassigned: false,
};
vi.mock('../services/account-access.js', () => ({
  canAccessAllLineAccounts: async (
    _db: unknown,
    _staff: unknown,
    ids: Array<string | null | undefined>,
  ) => ids.every((id) => id == null
    ? scope.canSeeUnassigned
    : scope.allowedAccountIds.includes(id)),
  getVisibleLineAccountScope: () => scope,
}));

const { reminders } = await import('./reminders.js');

let sqlite: SqliteD1;

const staff: AuthenticatedStaff = {
  id: 'staff-1', name: '担当', role: 'admin', readOnly: false, tenantId: 'tenant-1',
};

function app() {
  const instance = new Hono<Env>();
  instance.use('*', async (c, next) => {
    c.env = { DB: sqlite.db } as Env['Bindings'];
    c.set('staff', staff);
    await next();
  });
  instance.route('/', reminders);
  return instance;
}

function exec(sql: string, params: unknown[] = []) {
  const stmt = (sqlite.db as unknown as {
    prepare: (s: string) => {
      bind: (...p: unknown[]) => { run: () => Promise<unknown> };
    };
  }).prepare(sql);
  return stmt.bind(...params).run();
}

/**
 * ルール R は今は B の所属。版1（A時代）に A の友だちを登録し、
 * 版2（B）で公開ずみ。現行の手順はBだけを見る。
 */
async function seedMovedRule() {
  await exec(`INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
    VALUES ('acct-a','channel-a','A','test','test'), ('acct-b','channel-b','B','test','test'), ('acct-c','channel-c','C','test','test')`);
  await exec(`INSERT INTO friends (id, line_user_id, display_name, line_account_id)
    VALUES ('friend-a', 'U_A', 'A客', 'acct-a'), ('friend-b', 'U_B', 'B客', 'acct-b')`);
  await exec(`INSERT INTO reminders (id, name, line_account_id) VALUES ('rem-1', '来店前日', 'acct-b')`);
  await exec(`INSERT INTO reminder_versions (id, reminder_id, version_number, status, settings_snapshot, created_at, updated_at)
    VALUES ('rv-1', 'rem-1', 1, 'draft', '{}', '2026-09-01T00:00:00', '2026-09-01T00:00:00')`);
  await exec(`INSERT INTO reminder_version_steps
    (id, reminder_version_id, stable_step_id, offset_minutes, message_type, message_content, created_at)
    VALUES ('rvs-1', 'rv-1', 'step-1', 60, 'text', '控え', '2026-09-01T00:00:00')`);
  await exec(`UPDATE reminder_versions SET status = 'published' WHERE id = 'rv-1'`);
  await exec(`INSERT INTO reminder_versions (id, reminder_id, version_number, status, settings_snapshot, created_at, updated_at)
    VALUES ('rv-2', 'rem-1', 2, 'draft', '{}', '2026-09-02T00:00:00', '2026-09-02T00:00:00')`);
  await exec(`INSERT INTO reminder_version_steps
    (id, reminder_version_id, stable_step_id, offset_minutes, message_type, message_content, created_at)
    VALUES ('rvs-2', 'rv-2', 'step-1', 60, 'text', '現行', '2026-09-02T00:00:00')`);
  await exec(`UPDATE reminder_versions SET status = 'superseded' WHERE id = 'rv-1'`);
  await exec(`UPDATE reminder_versions SET status = 'published' WHERE id = 'rv-2'`);
  await exec(`INSERT INTO reminder_steps (id, reminder_id, offset_minutes, message_type, message_content)
    VALUES ('rs-now', 'rem-1', 60, 'text', '現行')`);
  await exec(`INSERT INTO friend_reminders (id, friend_id, reminder_id, reminder_version_id, target_date, status)
    VALUES ('fr-a', 'friend-a', 'rem-1', 'rv-1', '2026-10-05', 'active'),
           ('fr-b', 'friend-b', 'rem-1', 'rv-2', '2026-10-06', 'active')`);
  // A の送信待ち（queued）と B の送信ずみ。送信元は行ごとに残る。
  await exec(`INSERT INTO reminder_delivery_runs
    (id, line_account_id, reminder_id, friend_reminder_id, friend_id, reminder_step_id,
     scheduled_at, idempotency_key, line_retry_key, status, created_at, updated_at)
    VALUES ('run-a', 'acct-a', 'rem-1', 'fr-a', 'friend-a', 'rs-now',
      '2026-10-05T10:00:00', 'idem-a', 'retry-a', 'queued', '2026-09-03T00:00:00', '2026-09-03T00:00:00'),
           ('run-b', 'acct-b', 'rem-1', 'fr-b', 'friend-b', 'rs-now',
      '2026-09-02T10:00:00', 'idem-b', 'retry-b', 'succeeded', '2026-09-02T00:00:00', '2026-09-02T00:00:00')`);
}

function setScope(allowedAccountIds: string[]) {
  scope = { allowedAccountIds, canSeeUnassigned: false };
}

beforeEach(() => {
  vi.clearAllMocks();
  sqlite = createTestD1();
});

describe('R349 履歴は実行行の送信元アカウントで絞る', () => {
  test('Bだけの担当者にAの実行行・集計を返さない', async () => {
    await seedMovedRule();
    setScope(['acct-b']);

    const response = await app().request('/api/reminders/rem-1/runs');
    const body = await response.json() as {
      success: boolean;
      data: { reminder: { lineAccountId: string | null }; items: Array<{ id: string; friendName: string }>; summary: { sent: number; scheduled: number } };
    };

    expect(response.status).toBe(200);
    expect(body.data.reminder.lineAccountId).toBe('acct-b');
    expect(body.data.items.map((row) => row.id)).toEqual(['run-b']);
    expect(body.data.summary).toMatchObject({ sent: 1, scheduled: 0 });
  });

  test('Bだけの担当者がAの顧客名で検索しても出ない', async () => {
    await seedMovedRule();
    setScope(['acct-b']);

    const response = await app().request('/api/reminders/rem-1/runs?search=A%E5%AE%A2');
    const body = await response.json() as { data: { items: unknown[] } };

    expect(response.status).toBe(200);
    expect(body.data.items).toEqual([]);
  });

  test('Bを明示してもA行は混ざらない', async () => {
    await seedMovedRule();
    setScope(['acct-b']);

    const response = await app().request('/api/reminders/rem-1/runs?account_id=acct-b');
    const body = await response.json() as { data: { reminder: { lineAccountId: string | null }; items: Array<{ id: string }> } };

    expect(response.status).toBe(200);
    expect(body.data.items.map((row) => row.id)).toEqual(['run-b']);
  });

  test('両方見える担当者は両方の履歴を読める', async () => {
    await seedMovedRule();
    setScope(['acct-a', 'acct-b']);

    const response = await app().request('/api/reminders/rem-1/runs');
    const body = await response.json() as { data: { items: Array<{ id: string }> } };

    expect(response.status).toBe(200);
    expect(body.data.items.map((row) => row.id).sort()).toEqual(['run-a', 'run-b']);
  });
});

describe('R348 旧所属の送信待ちは見える担当が操作できる', () => {
  test('Aだけの担当者が履歴を開ける（A行だけ）', async () => {
    await seedMovedRule();
    setScope(['acct-a']);

    const response = await app().request('/api/reminders/rem-1/runs');
    const body = await response.json() as { data: { reminder: { lineAccountId: string | null }; items: Array<{ id: string }> } };

    expect(response.status).toBe(200);
    expect(body.data.reminder.lineAccountId).toBeNull();
    expect(body.data.items.map((row) => row.id)).toEqual(['run-a']);
  });

  test('Aだけの担当者の登録一覧に旧登録が出る', async () => {
    await seedMovedRule();
    setScope(['acct-a']);

    const response = await app().request('/api/reminders/rem-1/registrants');
    const body = await response.json() as { data: Array<{ id: string }> };

    expect(response.status).toBe(200);
    expect(body.data.map((row) => row.id)).toEqual(['fr-a']);
  });

  test('Aだけの担当者が旧登録の日時を変えられる', async () => {
    await seedMovedRule();
    setScope(['acct-a']);

    const response = await app().request('/api/reminders/rem-1/registrants/fr-a', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetDate: '2026-10-07T00:00:00+09:00', expectedLockVersion: 0 }),
    });
    const body = await response.json() as { success: boolean; data: { targetDate: string } };

    expect(response.status).toBe(200);
    expect(body.data.targetDate).toBe('2026-10-06T15:00:00.000Z');
  });

  test('Aだけの担当者が旧登録を取り消せる', async () => {
    await seedMovedRule();
    setScope(['acct-a']);

    const response = await app().request('/api/reminders/rem-1/registrants/fr-a/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedLockVersion: 0 }),
    });

    expect(response.status).toBe(200);
  });

  test('Aだけの担当者がA行の失敗を再試行できる', async () => {
    await seedMovedRule();
    await exec(`UPDATE reminder_delivery_runs SET status = 'permanent_failed' WHERE id = 'run-a'`);
    setScope(['acct-a']);

    const response = await app().request('/api/reminder-runs/run-a/retry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': '123e4567-e89b-42d3-a456-426614174000' },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(200);
  });

  test('Bだけの担当者は旧登録を変えられない（見つからない）', async () => {
    await seedMovedRule();
    setScope(['acct-b']);

    const patch = await app().request('/api/reminders/rem-1/registrants/fr-a', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetDate: '2026-10-07T00:00:00+09:00', expectedLockVersion: 0 }),
    });
    expect(patch.status).toBe(404);

    const cancel = await app().request('/api/reminders/rem-1/registrants/fr-a/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedLockVersion: 0 }),
    });
    expect(cancel.status).toBe(404);
  });

  test('関係ない担当者にはあるなしを区別せず404', async () => {
    await seedMovedRule();
    setScope(['acct-c']);

    const response = await app().request('/api/reminders/rem-1/runs');
    expect(response.status).toBe(404);
  });
});

describe('R350 個別登録の取消は一覧側と同じ結果になる', () => {
  test('両方見える担当者が取り消すと送信待ちが止まる', async () => {
    await seedMovedRule();
    setScope(['acct-a', 'acct-b']);

    const response = await app().request('/api/friend-reminders/fr-a', { method: 'DELETE' });
    expect(response.status).toBe(200);

    const enrollment = await sqlite.db.prepare('SELECT status, cancel_reason FROM friend_reminders WHERE id = ?')
      .bind('fr-a').first<{ status: string; cancel_reason: string | null }>();
    expect(enrollment?.status).toBe('cancelled');
    expect(enrollment?.cancel_reason).toBe('manual_registration_cancelled');
    // 一覧側の取消と同じく、未送信の実行行が止まる。
    const run = await sqlite.db.prepare('SELECT status FROM reminder_delivery_runs WHERE id = ?')
      .bind('run-a').first<{ status: string }>();
    expect(run?.status).toBe('cancelled');
  });

  test('削除済みアカウントの登録は操作できない', async () => {
    await seedMovedRule();
    setScope(['acct-a', 'acct-b']);
    await exec("UPDATE line_accounts SET data_purged_at='2027-01-01' WHERE id='acct-a'");
    const response = await app().request('/api/friend-reminders/fr-a', { method: 'DELETE' });
    expect(response.status).toBe(404);
    expect(await sqlite.db.prepare('SELECT status FROM friend_reminders WHERE id=?').bind('fr-a').first()).toEqual({status:'active'});
  });

  test('片方だけの担当者には見つからない', async () => {
    await seedMovedRule();
    setScope(['acct-a']);

    const response = await app().request('/api/friend-reminders/fr-a', { method: 'DELETE' });
    expect(response.status).toBe(404);
  });

  test('存在しない登録は404', async () => {
    await seedMovedRule();
    setScope(['acct-a', 'acct-b']);

    const response = await app().request('/api/friend-reminders/fr-missing', { method: 'DELETE' });
    expect(response.status).toBe(404);
  });
});
