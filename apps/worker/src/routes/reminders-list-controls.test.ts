/** ページ件数・並び順・基準日・本文検索を実データへ接続し、名前の60文字上限を保存側でも守ることを実 route・認証・SQLite で確かめる。 */
import { Hono } from 'hono';
import { beforeEach, describe, expect, test } from 'vitest';
import type { Env } from '../worker-env.js';
import { authMiddleware } from '../middleware/auth.js';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';
import { publicReminder } from './reminder-display.js';

const ACC_A = 'acc-a';
const ACC_B = 'acc-b';
const KEY_OWNER = 'key-owner-aaa';
const KEY_STAFF_B = 'key-staff-bbb';

function draftBody(name: string, lineAccountId = ACC_A) {
  return {
    name,
    description: null,
    lineAccountId,
    triggerType: 'manual',
    deliveryMode: 'time',
    triggerFieldId: null,
    triggerEventId: null,
    repeatYearly: false,
    triggerOffsetMinutes: null,
    sendAtTime: '09:00',
    targetTagId: null,
    folderId: null,
    stopConditions: {
      bookingCancelled: false,
      supportMarkCompleted: false,
      daysAfterTarget: null,
      friendBlocked: false,
    },
    steps: [
      {
        stableStepId: 'step-1',
        offsetMinutes: 0,
        messageType: 'text',
        messageContent: '本文です',
        offsetDays: null,
        sendAtTime: null,
        templateId: null,
        targetCondition: {},
        action: {},
      },
    ],
  };
}

function insertReminder(
  sqlite: SqliteD1['raw'],
  id: string,
  name: string,
  lineAccountId: string,
  extra: { createdAt?: string; updatedAt?: string; displayOrder?: number; lifecycle?: string; draftVersionId?: string } = {},
) {
  sqlite.prepare(
    `INSERT INTO reminders (id, name, line_account_id, trigger_type, lifecycle_status,
       display_order, created_at, updated_at, current_draft_version_id)
     VALUES (?, ?, ?, 'manual', ?, ?, ?, ?, ?)`,
  ).run(
    id,
    name,
    lineAccountId,
    extra.lifecycle ?? 'published',
    extra.displayOrder ?? 0,
    extra.createdAt ?? '2026-09-01T00:00:00.000',
    extra.updatedAt ?? '2026-09-01T00:00:00.000',
    extra.draftVersionId ?? null,
  );
}

function seed(sqlite: SqliteD1['raw']) {
  sqlite.prepare(`INSERT INTO tenants (id, name) VALUES ('tenant-1', '統括1')`).run();
  for (const id of [ACC_A, ACC_B]) {
    sqlite.prepare(
      `INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret, tenant_id)
       VALUES (?, ?, ?, 'token', 'secret', 'tenant-1')`,
    ).run(id, `channel-${id}`, id === ACC_A ? '本店' : '二号店');
  }
  sqlite.prepare(
    `INSERT INTO staff_members (id, name, role, api_key, tenant_id, account_scope)
     VALUES ('owner-1', 'オーナー', 'owner', ?, 'tenant-1', 'all')`,
  ).run(KEY_OWNER);
  // acc-b だけを見られるstaff。
  sqlite.prepare(
    `INSERT INTO staff_members (id, name, role, api_key, tenant_id, account_scope, permission_keys)
     VALUES ('staff-b', '担当B', 'staff', ?, 'tenant-1', 'accounts', '["/reminders"]')`,
  ).run(KEY_STAFF_B);
  sqlite.prepare(
    `INSERT INTO staff_account_scopes (staff_id, line_account_id, created_at)
     VALUES ('staff-b', ?, '2026-09-01T00:00:00.000Z')`,
  ).run(ACC_B);

  // 並びと検索を確かめるための3件。名前・作った日・更新した日を全部ずらす。
  insertReminder(sqlite, 'r-1', 'うどんの案内', ACC_A, { createdAt: '2026-09-03T00:00:00.000', updatedAt: '2026-09-01T00:00:00.000', displayOrder: 0 });
  insertReminder(sqlite, 'r-2', 'あいさつ通知', ACC_A, { createdAt: '2026-09-01T00:00:00.000', updatedAt: '2026-09-03T00:00:00.000', displayOrder: 1 });
  insertReminder(sqlite, 'r-3', 'かき氷の案内', ACC_A, { createdAt: '2026-09-02T00:00:00.000', updatedAt: '2026-09-02T00:00:00.000', displayOrder: 2 });

  // r-1 の公開済み通にだけ入っている本文フレーズ。
  sqlite.prepare(
    `INSERT INTO reminder_steps (id, reminder_id, offset_minutes, message_type, message_content)
     VALUES ('step-r1', 'r-1', 0, 'text', '明日は予約日です。忘れ物に注意')`,
  ).run();

  // 下書きだけのリマインダ。本文は reminder_version_steps にしかない。
  insertReminder(sqlite, 'r-draft', '下書きのリマインダ', ACC_A, {
    lifecycle: 'draft',
    draftVersionId: 'ver-draft',
    displayOrder: 3,
  });
  sqlite.prepare(
    `INSERT INTO reminder_versions
       (id, reminder_id, version_number, status, settings_snapshot, created_at, updated_at)
     VALUES ('ver-draft', 'r-draft', 1, 'draft', ?, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`,
  ).run(JSON.stringify(draftBody('下書きのリマインダ')));
  sqlite.prepare(
    `INSERT INTO reminder_version_steps
       (id, reminder_version_id, stable_step_id, position, offset_minutes, message_type, message_content, created_at)
     VALUES ('vstep-draft', 'ver-draft', 'step-1', 0, 0, 'text', '七五三の撮影予約を承ります', '2026-09-01T00:00:00.000Z')`,
  ).run();

  // 別アカウントのリマインダ（本文に同じフレーズを入れて、範囲外に出ないことを確かめる）。
  insertReminder(sqlite, 'r-b', '別アカウントの件', ACC_B);
  sqlite.prepare(
    `INSERT INTO reminder_steps (id, reminder_id, offset_minutes, message_type, message_content)
     VALUES ('step-rb', 'r-b', 0, 'text', '忘れ物に注意してください')`,
  ).run();

  // 「次の送信が近い順」用の予定行。r-3 が一番近く、r-1 がその次。
  // r-2 は送信済みだけ（待ち行列には数えない）、r-draft は予定なし。
  for (const [id, reminderId, scheduledAt, status] of [
    ['run-r3', 'r-3', '2026-09-20 09:00:00', 'queued'],
    ['run-r1', 'r-1', '2026-09-25 09:00:00', 'queued'],
    ['run-r2', 'r-2', '2026-09-10 09:00:00', 'succeeded'],
  ] as const) {
    sqlite.prepare(
      `INSERT INTO reminder_delivery_runs
         (id, reminder_id, friend_reminder_id, friend_id, reminder_step_id,
          scheduled_at, idempotency_key, line_retry_key, status, created_at, updated_at)
       VALUES (?, ?, 'fr-1', 'friend-1', 'step-1', ?, ?, ?, ?, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`,
    ).run(id, reminderId, scheduledAt, `idem-${id}`, `retry-${id}`, status);
  }
}

let sqlite: SqliteD1;
let remindersRoute: Awaited<typeof import('./reminders.js')>['reminders'];

function app() {
  const instance = new Hono<Env>();
  instance.use('*', authMiddleware);
  instance.route('/', remindersRoute);
  return instance;
}

const env = () => ({ DB: sqlite.db }) as unknown as Env['Bindings'];

function list(query: string, apiKey = KEY_OWNER) {
  return app().request(`/api/reminders?${query}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  }, env());
}

beforeEach(async () => {
  sqlite = createTestD1({ loginPolicy: 'off' });
  seed(sqlite.raw);
  ({ reminders: remindersRoute } = await import('./reminders.js'));
});

test('一覧と詳細は各リマインダの実際の所属先を返す', async () => {
  const paged = await list('limit=20');
  expect(paged.status).toBe(200);
  const pagedBody = await paged.json() as { data: { items: Array<{ id: string; lineAccountId: string | null; lineAccount: { id: string; name: string | null } | null }> } };
  expect(pagedBody.data.items.find(row => row.id === 'r-1')?.lineAccountId).toBe(ACC_A);
  expect(pagedBody.data.items.find(row => row.id === 'r-b')?.lineAccountId).toBe(ACC_B);
  expect(pagedBody.data.items.find(row => row.id === 'r-1')?.lineAccount).toEqual({ id: ACC_A, name: '本店' });
  expect(pagedBody.data.items.find(row => row.id === 'r-b')?.lineAccount).toEqual({ id: ACC_B, name: '二号店' });
  const scoped = await (await list('limit=20', KEY_STAFF_B)).json() as { data: { items: Array<{ id: string; lineAccount: unknown }> } };
  expect(scoped.data.items.map(row => row.id)).toEqual(['r-b']);
  expect(scoped.data.items[0].lineAccount).toEqual({ id: ACC_B, name: '二号店' });
  const legacy = await list('');
  const legacyBody = await legacy.json() as { data: Array<{ id: string; lineAccountId: string | null; lineAccount: { id: string; name: string | null } | null }> };
  expect(legacyBody.data.find(row => row.id === 'r-b')?.lineAccountId).toBe(ACC_B);
  expect(legacyBody.data.find(row => row.id === 'r-b')?.lineAccount).toEqual({ id: ACC_B, name: '二号店' });
  for (const suffix of ['', '/runs']) {
    const response = await app().request(`/api/reminders/r-b${suffix}`, { headers: { Authorization: `Bearer ${KEY_OWNER}` } }, env());
    expect(response.status).toBe(200);
    const body = await response.json() as { data: { lineAccountId?: string; lineAccount?: unknown; reminder?: { lineAccountId: string } } };
    expect(suffix ? body.data.reminder?.lineAccountId : body.data.lineAccountId).toBe(ACC_B);
    if (!suffix) expect(body.data.lineAccount).toEqual({ id: ACC_B, name: '二号店' });
    const forbidden = await app().request(`/api/reminders/r-1${suffix}`, { headers: { Authorization: `Bearer ${KEY_STAFF_B}` } }, env());
    expect(forbidden.status).toBe(404);
  }
});

test('所属先のないリマインダは null とし、権限がなければ表示しない', async () => {
  sqlite.raw.prepare('UPDATE reminders SET line_account_id = NULL WHERE id = ?').run('r-1');
  const row = sqlite.raw.prepare('SELECT * FROM reminders WHERE id = ?').get('r-1') as Parameters<typeof publicReminder>[0];
  expect(publicReminder(row).lineAccountId).toBeNull();
  const paged = await list('limit=20');
  const body = await paged.json() as { data: { items: Array<{ id: string; lineAccountId: string | null; lineAccount: { id: string; name: string | null } | null }> } };
  expect(body.data.items.find(item => item.id === 'r-1')).toBeUndefined();
  const detail = await app().request('/api/reminders/r-1', { headers: { Authorization: `Bearer ${KEY_OWNER}` } }, env());
  expect(detail.status).toBe(404);
});

describe('一覧の検索 (N-077)', () => {
  test('通知本文だけに含まれる語で公開済みが見つかる', async () => {
    const res = await list(`limit=20&lineAccountId=${ACC_A}&q=` + encodeURIComponent('忘れ物'));
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { total: number; items: Array<{ id: string }> } };
    // r-1（本文に「忘れ物に注意」）と r-b（本文に同フレーズ）は見つかる。
    // 名前にも説明にも入っていないので、本文を見ていなければ 0 件だった。
    expect(body.data.items.map((i) => i.id).sort()).toEqual(['r-1']);
    expect(body.data.total).toBe(1);
  });

  test('下書きの通知本文でも見つかる', async () => {
    const res = await list(`limit=20&lineAccountId=${ACC_A}&q=` + encodeURIComponent('七五三'));
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { items: Array<{ id: string }> } };
    expect(body.data.items.map((i) => i.id)).toEqual(['r-draft']);
  });

  test('どこにも無い語は0件', async () => {
    const res = await list(`limit=20&lineAccountId=${ACC_A}&q=` + encodeURIComponent('存在しない語'));
    const body = await res.json() as { data: { total: number; items: unknown[] } };
    expect(body.data.total).toBe(0);
    expect(body.data.items).toEqual([]);
  });

  test('担当外アカウントの本文には届かない', async () => {
    // staff-b は acc-b しか見られない。「忘れ物」は acc-a の r-1 にもあるが
    // 範囲外なので acc-b の r-b だけが返る。
    const res = await list('limit=20&q=' + encodeURIComponent('忘れ物'), KEY_STAFF_B);
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { items: Array<{ id: string }> } };
    expect(body.data.items.map((i) => i.id)).toEqual(['r-b']);
  });
});

describe('一覧の並び順と表示件数 (N-072)', () => {
  test('sort=name は名前順で返す', async () => {
    const res = await list(`limit=20&lineAccountId=${ACC_A}&sort=name`);
    const body = await res.json() as { data: { items: Array<{ id: string }>; sort: Array<{ field: string }> } };
    // あいさつ通知 / うどんの案内 / かき氷の案内 / 下書きのリマインダ（unicode順）
    expect(body.data.items.map((i) => i.id)).toEqual(['r-2', 'r-1', 'r-3', 'r-draft']);
    expect(body.data.sort[0].field).toBe('name');
  });

  test('sort=created は作成日の新しい順で返す', async () => {
    const res = await list(`limit=20&lineAccountId=${ACC_A}&sort=created`);
    const body = await res.json() as { data: { items: Array<{ id: string }> } };
    expect(body.data.items.map((i) => i.id)).toEqual(['r-1', 'r-3', 'r-2', 'r-draft']);
  });

  test('sort=updated は更新日の新しい順で返す', async () => {
    const res = await list(`limit=20&lineAccountId=${ACC_A}&sort=updated`);
    const body = await res.json() as { data: { items: Array<{ id: string }> } };
    expect(body.data.items.map((i) => i.id)).toEqual(['r-2', 'r-3', 'r-1', 'r-draft']);
  });

  test('sort=next は次の送信が近い順（予定なしは後ろ）で返す', async () => {
    const res = await list(`limit=20&lineAccountId=${ACC_A}&sort=next`);
    const body = await res.json() as { data: { items: Array<{ id: string }>; sort: Array<{ field: string }> } };
    // 予定あり: r-3(9/20) → r-1(9/25)。r-2は送信済みだけなので待ちなし。
    // 予定なし: r-2, r-draft（id順）。
    expect(body.data.items.map((i) => i.id)).toEqual(['r-3', 'r-1', 'r-2', 'r-draft']);
    expect(body.data.sort[0].field).toBe('nextScheduledAt');
  });

  test('sort 省略時は並び替え順（display_order）のまま', async () => {
    const res = await list(`limit=20&lineAccountId=${ACC_A}`);
    const body = await res.json() as { data: { items: Array<{ id: string }> } };
    expect(body.data.items.map((i) => i.id)).toEqual(['r-1', 'r-2', 'r-3', 'r-draft']);
  });

  test('知らない sort は構造化された400を返す', async () => {
    const res = await list('lineAccountId=' + ACC_A + '&sort=' + encodeURIComponent('; DROP TABLE reminders'));
    expect(res.status).toBe(400);
    const body = await res.json() as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(typeof body.error).toBe('string');
    // テーブルは残っている。
    const alive = await list('limit=20&lineAccountId=' + ACC_A);
    expect(alive.status).toBe(200);
  });

  test('limit で1ページの件数を変えられる', async () => {
    const res = await list(`limit=2&page=2&lineAccountId=${ACC_A}&sort=created`);
    const body = await res.json() as { data: { total: number; limit: number; items: Array<{ id: string }> } };
    expect(body.data.limit).toBe(2);
    expect(body.data.total).toBe(4);
    // created順の2ページ目 = r-2, r-draft
    expect(body.data.items.map((i) => i.id)).toEqual(['r-2', 'r-draft']);
  });
});

describe('リマインダ名の上限 (N-078)', () => {
  const name60 = 'あ'.repeat(60);
  const name61 = 'あ'.repeat(61);

  test('作成は61文字を構造化された4xxで止め、60文字は通す', async () => {
    const over = await app().request('/api/reminders', {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY_OWNER}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name61, lineAccountId: ACC_A }),
    }, env());
    expect(over.status).toBeGreaterThanOrEqual(400);
    expect(over.status).toBeLessThan(500);
    const overBody = await over.json() as { success: boolean; error: string };
    expect(overBody.success).toBe(false);
    expect(overBody.error).toContain('60文字');

    const ok = await app().request('/api/reminders', {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY_OWNER}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name60, lineAccountId: ACC_A }),
    }, env());
    expect(ok.status).toBe(201);
  });

  test('作成は前後の空白を落として保存する', async () => {
    const res = await app().request('/api/reminders', {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY_OWNER}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '  余白つきの名前  ', lineAccountId: ACC_A }),
    }, env());
    expect(res.status).toBe(201);
    const body = await res.json() as { data: { name: string } };
    expect(body.data.name).toBe('余白つきの名前');
  });

  test('作成は空白だけの名前を止める', async () => {
    const res = await app().request('/api/reminders', {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY_OWNER}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '   ', lineAccountId: ACC_A }),
    }, env());
    expect(res.status).toBe(400);
  });

  test('Idempotency-Key付きの作成も同じ上限で止める', async () => {
    const res = await app().request('/api/reminders', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${KEY_OWNER}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': '123e4567-e89b-42d3-a456-426614174000',
      },
      body: JSON.stringify({ name: name61, lineAccountId: ACC_A }),
    }, env());
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  test('下書きの一括作成は61文字を止める', async () => {
    const res = await app().request('/api/reminders/drafts', {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY_OWNER}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(draftBody(name61)),
    }, env());
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    const body = await res.json() as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain('60文字');
  });

  test('下書き保存は61文字を止め、60文字は通す', async () => {
    const over = await app().request(`/api/reminders/r-draft/draft`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${KEY_OWNER}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(draftBody(name61)),
    }, env());
    expect(over.status).toBeGreaterThanOrEqual(400);
    expect(over.status).toBeLessThan(500);

    const ok = await app().request(`/api/reminders/r-draft/draft`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${KEY_OWNER}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(draftBody(name60)),
    }, env());
    expect(ok.status).toBe(200);
  });

  test('名前の更新も61文字で止め、空白を落とす', async () => {
    const over = await app().request('/api/reminders/r-1', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${KEY_OWNER}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name61 }),
    }, env());
    expect(over.status).toBeGreaterThanOrEqual(400);
    expect(over.status).toBeLessThan(500);

    const ok = await app().request('/api/reminders/r-1', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${KEY_OWNER}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '  改名しました  ' }),
    }, env());
    expect(ok.status).toBe(200);
    const row = sqlite.raw.prepare(`SELECT name FROM reminders WHERE id = 'r-1'`).get() as { name: string };
    expect(row.name).toBe('改名しました');
  });

  test('空白だけの名前への更新は止める', async () => {
    const res = await app().request('/api/reminders/r-1', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${KEY_OWNER}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '   ' }),
    }, env());
    expect(res.status).toBe(400);
  });
});

/*
 * REMINDER-10: 下書き一覧の日時・通数は、編集画面と同じ下書き版から組み立てる。
 * reminder_steps は公開時の複製なので、未公開の下書きでは作成時の既定値と
 * 0通しか返らず、保存した「1日前の18:00・1通」と食い違っていた。
 */
describe('一覧の副題は編集中の版を見る (REMINDER-10)', () => {
  test('下書きだけの行は下書き版の日時と通数を返す', async () => {
    sqlite.raw.prepare(`UPDATE reminders SET delivery_mode = 'time' WHERE id = 'r-draft'`).run();
    sqlite.raw.prepare(
      `UPDATE reminder_version_steps SET offset_days = -1, send_at_time = '18:00'
        WHERE reminder_version_id = 'ver-draft'`,
    ).run();

    const res = await list(`limit=20&lineAccountId=${ACC_A}&status=draft`);
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { items: Array<{ id: string; stepCount: number; timingSummary: string | null }> } };
    const item = body.data.items.find((i) => i.id === 'r-draft');
    expect(item?.stepCount).toBe(1);
    expect(item?.timingSummary).toBe('1日前の18:00 ／ テキスト 1通');
  });

  test('通知0件の下書きは「通知なし ／ テキスト 0通」と返す', async () => {
    sqlite.raw.prepare(`DELETE FROM reminder_version_steps WHERE reminder_version_id = 'ver-draft'`).run();

    const res = await list(`limit=20&lineAccountId=${ACC_A}&status=draft`);
    const body = await res.json() as { data: { items: Array<{ id: string; stepCount: number; timingSummary: string | null }> } };
    const item = body.data.items.find((i) => i.id === 'r-draft');
    expect(item?.stepCount).toBe(0);
    expect(item?.timingSummary).toBe('通知なし ／ テキスト 0通');
  });

  test('公開版と下書きが両方ある行は、下書きの値に版の印を付ける', async () => {
    sqlite.raw.prepare(
      `INSERT INTO reminder_versions
         (id, reminder_id, version_number, status, settings_snapshot, created_at, updated_at)
       VALUES ('ver-pub', 'r-1', 1, 'published', '{}', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`,
    ).run();
    sqlite.raw.prepare(
      `INSERT INTO reminder_versions
         (id, reminder_id, version_number, status, settings_snapshot, created_at, updated_at)
       VALUES ('ver-draft2', 'r-1', 2, 'draft', '{}', '2026-09-02T00:00:00.000Z', '2026-09-02T00:00:00.000Z')`,
    ).run();
    sqlite.raw.prepare(
      `INSERT INTO reminder_version_steps
         (id, reminder_version_id, stable_step_id, position, offset_minutes, message_type, message_content, created_at)
       VALUES
         ('vstep-2a', 'ver-draft2', 's-a', 0, -60, 'text', '直前です', '2026-09-02T00:00:00.000Z'),
         ('vstep-2b', 'ver-draft2', 's-b', 1, -120, 'text', '前々です', '2026-09-02T00:00:00.000Z')`,
    ).run();
    sqlite.raw.prepare(
      `UPDATE reminders
          SET current_published_version_id = 'ver-pub', current_draft_version_id = 'ver-draft2'
        WHERE id = 'r-1'`,
    ).run();

    const res = await list(`limit=20&lineAccountId=${ACC_A}`);
    const body = await res.json() as { data: { items: Array<{ id: string; stepCount: number; timingSummary: string | null }> } };
    const item = body.data.items.find((i) => i.id === 'r-1');
    // r-1 の公開済み reminder_steps は1件だが、再編集中の下書き版は2通。
    expect(item?.stepCount).toBe(2);
    expect(item?.timingSummary).toBe('下書き: 1時間前・2時間前 ／ テキスト 2通');
  });

  test('版を持たない行は従来どおり reminder_steps の数を返す', async () => {
    const res = await list(`limit=20&lineAccountId=${ACC_A}`);
    const body = await res.json() as { data: { items: Array<{ id: string; stepCount: number; timingSummary: string | null }> } };
    const item = body.data.items.find((i) => i.id === 'r-1');
    expect(item?.stepCount).toBe(1);
    expect(item?.timingSummary).toBeNull();
  });
});
