/*
 * 1対1トークの差し込み解決のルート対照。
 *
 * 実DB（better-sqlite3 + bootstrap.sql）に実物の chats ルートを当て、
 * LINE clientだけを止める。
 *   - {{name}}/{{field.*}}/{{var.*}} は一斉配信と同じ解決器で置き換わる
 *   - 解決しきれない {{…}} が残る送信は400で、LINE呼び出し0回・保存0件
 *   - プレビュー口は送信と同じ解決結果を返し、送信も書き込みもしない
 *   - 予約の作成・変更はカタログに無い差し込み名を400で拒否する
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';
import type { Env } from '../worker-env.js';
import type { AuthenticatedStaff } from '../middleware/auth/principal/auth.js';

const pushMessage = vi.fn().mockResolvedValue({ sentMessages: [{}] });
vi.mock('@line-crm/line-sdk', () => ({
  LineClient: vi.fn().mockImplementation(function () { return ({ pushMessage }); }),
}));

const { chats } = await import('./chats.js');

let sqlite: SqliteD1;

const owner: AuthenticatedStaff = {
  id: 'owner-1', name: 'オーナー', role: 'owner', readOnly: false, tenantId: 'tenant-1',
};

function app(staff: AuthenticatedStaff = owner) {
  const instance = new Hono<Env>();
  instance.use('*', async (c, next) => {
    c.env = { DB: sqlite.db } as Env['Bindings'];
    c.set('staff', staff);
    await next();
  });
  instance.route('/', chats);
  return instance;
}

const KEY1 = '11111111-2222-4333-8444-555555555555';
const KEY2 = '22222222-2222-4333-8444-555555555555';
const KEY3 = '33333333-2222-4333-8444-555555555555';
const KEY4 = '44444444-2222-4333-8444-555555555555';
const KEY5 = '55555555-2222-4333-8444-555555555555';
const KEY6 = '66666666-2222-4333-8444-555555555555';
const KEY7 = '77777777-2222-4333-8444-555555555555';
const KEY8 = '88888888-2222-4333-8444-555555555555';
const KEY9 = '99999999-2222-4333-8444-555555555555';

function postSend(body: unknown, key: string, chatId = 'fr-1') {
  return app().request(`/api/chats/${chatId}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify(body),
  });
}

function postCombined(body: unknown, key: string, chatId = 'fr-1') {
  return app().request(`/api/chats/${chatId}/send-combined`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify(body),
  });
}

function postPreview(body: unknown, chatId = 'fr-1') {
  return app().request(`/api/chats/${chatId}/render-preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function postSchedule(body: unknown, key: string, chatId = 'fr-1') {
  return app().request(`/api/chats/${chatId}/schedule`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify(body),
  });
}

function patchScheduled(scheduleId: string, body: unknown, chatId = 'fr-1') {
  return app().request(`/api/chats/${chatId}/scheduled/${scheduleId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function outbox(friendId = 'fr-1') {
  return sqlite.raw.prepare(
    `SELECT id, content FROM messages_log
      WHERE friend_id = ? AND direction = 'outgoing' ORDER BY created_at`,
  ).all(friendId) as Array<{ id: string; content: string }>;
}

function scheduledRows() {
  return sqlite.raw.prepare(`SELECT * FROM scheduled_chat_sends ORDER BY created_at`).all() as Array<Record<string, unknown>>;
}

function seed() {
  const raw = sqlite.raw;
  raw.prepare(`INSERT INTO tenants (id, name) VALUES ('tenant-1', '統括1')`).run();
  raw.prepare(
    `INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret, is_active, tenant_id, liff_id)
     VALUES ('acc-1', 'channel-acc-1', 'acc-1', 'token', 'secret', 1, 'tenant-1', 'liff-abc')`,
  ).run();
  raw.prepare(
    `INSERT INTO staff_members (id, name, role, api_key, tenant_id, account_scope, permission_keys)
     VALUES ('owner-1', 'オーナー', 'owner', 'key-owner', 'tenant-1', 'all', '[]')`,
  ).run();
  raw.prepare(
    `INSERT INTO friends (id, line_user_id, display_name, line_account_id) VALUES ('fr-1', 'U-1', '利用者1', 'acc-1')`,
  ).run();
  // 表示名が無い友だち。{{name}} が解決できずに残る状態を作る。
  raw.prepare(
    `INSERT INTO friends (id, line_user_id, display_name, line_account_id) VALUES ('fr-noname', 'U-2', NULL, 'acc-1')`,
  ).run();
  // 友だち情報欄 pet_name = ポチ、未設定項目 unset_field。
  raw.prepare(
    `INSERT INTO friend_fields (id, name, field_key, type) VALUES ('ff-pet', 'ペット名', 'pet_name', 'text')`,
  ).run();
  raw.prepare(
    `INSERT INTO friend_fields (id, name, field_key, type) VALUES ('ff-unset', '未設定項目', 'unset_field', 'text')`,
  ).run();
  raw.prepare(
    `INSERT INTO friend_field_values (friend_id, field_id, value) VALUES ('fr-1', 'ff-pet', 'ポチ')`,
  ).run();
  // 共通情報 var.hours = 9-18時。
  raw.prepare(
    `INSERT INTO common_vars (id, name, var_key, value, line_account_id)
     VALUES ('cv-hours', '営業時間', 'hours', '9-18時', 'acc-1')`,
  ).run();
}

beforeEach(() => {
  vi.clearAllMocks();
  pushMessage.mockResolvedValue({ sentMessages: [{}] });
  sqlite = createTestD1();
  seed();
});

describe('手動送信の差し込み(N-026)', () => {
  test('{{name}}・{{field.*}}・{{var.*}}・{{liff_id}} が解決されてLINEへ渡り、履歴にも解決後の本文が残る', async () => {
    const res = await postSend(
      { content: '{{name}}さん、{{field.pet_name}}の件です。{{var.hours}} {{liff_id}}', revision: 0 },
      KEY1,
    );
    expect(res.status).toBe(200);
    const [, messages] = pushMessage.mock.calls[0] as [string, Array<{ text: string }>, string];
    expect(messages[0].text).toBe('利用者1さん、ポチの件です。9-18時 liff-abc');
    const logged = outbox();
    expect(logged).toHaveLength(1);
    expect(logged[0].content).toBe('利用者1さん、ポチの件です。9-18時 liff-abc');
  });

  test('値の無い field は空文字になる（一斉配信と同じ扱いで送信は止めない）', async () => {
    const res = await postSend({ content: 'あいう{{field.unset_field}}えお', revision: 0 }, KEY2);
    expect(res.status).toBe(200);
    const [, messages] = pushMessage.mock.calls[0] as [string, Array<{ text: string }>, string];
    expect(messages[0].text).toBe('あいうえお');
  });

  test('カタログに無い差し込みは400・LINE呼び出し0回・履歴0件・予約表も0件', async () => {
    const res = await postSend({ content: '{{pet_name}}の件です', revision: 0 }, KEY3);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string; data?: { variables?: string[] } };
    expect(body.code).toBe('UNRESOLVED_TEMPLATE_VARIABLES');
    expect(body.data?.variables).toEqual(['pet_name']);
    expect(pushMessage).not.toHaveBeenCalled();
    expect(outbox()).toHaveLength(0);
    expect(scheduledRows()).toHaveLength(0);
  });

  test('表示名の無い友だちへの {{name}} は400で送らない', async () => {
    const res = await postSend({ content: '{{name}}さん', revision: 0 }, KEY4, 'fr-noname');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('UNRESOLVED_TEMPLATE_VARIABLES');
    expect(pushMessage).not.toHaveBeenCalled();
    expect(outbox('fr-noname')).toHaveLength(0);
  });

  test('結合送信の本文にも同じ解決が効き、未解決なら画像ごと送らない', async () => {
    const ok = await postCombined(
      {
        image: { originalContentUrl: 'https://x/o.jpg', previewImageUrl: 'https://x/p.jpg' },
        text: '{{name}}さんへの写真です',
      },
      KEY5,
    );
    expect(ok.status).toBe(200);
    const [, messages] = pushMessage.mock.calls[0] as [string, Array<{ type: string; text?: string }>, string];
    expect(messages.find((m) => m.type === 'text')?.text).toBe('利用者1さんへの写真です');

    pushMessage.mockClear();
    const ng = await postCombined(
      {
        image: { originalContentUrl: 'https://x/o.jpg', previewImageUrl: 'https://x/p.jpg' },
        text: '{{pet_name}}の写真です',
      },
      KEY6,
    );
    expect(ng.status).toBe(400);
    // 未解決なら画像だけ先に届く部分送信も起きない。
    expect(pushMessage).not.toHaveBeenCalled();
    expect(outbox()).toHaveLength(2); // 成功分の image+text のみ
  });

  test('消えた共通情報は空文字にせず400で止め、失敗台帳へ変数名を残す(N-189)', async () => {
    const res = await postSend({ content: '営業時間: {{var.deleted_key}}', revision: 0 }, KEY5);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string; data?: { variables?: string[] } };
    expect(body.code).toBe('UNRESOLVED_TEMPLATE_VARIABLES');
    expect(body.data?.variables).toEqual(['var.deleted_key']);
    // LINE呼出し0・履歴0・予約0
    expect(pushMessage).not.toHaveBeenCalled();
    expect(outbox()).toHaveLength(0);
    expect(scheduledRows()).toHaveLength(0);
    // 台帳には変数名・送信種別・理由だけ残る（本文や値は残さない）
    const ledger = sqlite.raw.prepare(
      `SELECT source_kind, source_id, var_key, reason FROM common_var_resolution_failures`,
    ).all() as Array<Record<string, string>>;
    expect(ledger).toEqual([
      { source_kind: 'chat', source_id: 'fr-1', var_key: 'deleted_key', reason: 'missing' },
    ]);
  });

  test('プレビューは送信と同じ解決結果を返し、送信も書き込みもしない', async () => {
    const res = await postPreview({ content: '{{name}}さん {{pet_name}}' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { content: string; unresolved: string[] } };
    expect(body.data.content).toBe('利用者1さん {{pet_name}}');
    expect(body.data.unresolved).toEqual(['pet_name']);
    expect(pushMessage).not.toHaveBeenCalled();
    expect(outbox()).toHaveLength(0);
  });

  test('差し込みの無い本文はプレビューでそのまま返る', async () => {
    const res = await postPreview({ content: 'そのままの文' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { content: string; unresolved: string[] } };
    expect(body.data.content).toBe('そのままの文');
    expect(body.data.unresolved).toEqual([]);
  });
});

describe('送信予約の差し込み(N-026)', () => {
  const future = () => new Date(Date.now() + 60 * 60_000).toISOString();

  test('カタログに無い差し込みを含む予約は400で行を作らない', async () => {
    const res = await postSchedule(
      { content: '{{pet_name}}へお薬です', scheduledAt: future() },
      KEY7,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('UNRESOLVED_TEMPLATE_VARIABLES');
    expect(scheduledRows()).toHaveLength(0);
  });

  test('解決可能な差し込みを含む予約は作れる（解決は送信時）', async () => {
    const res = await postSchedule(
      { content: '{{name}}さん、{{field.pet_name}}の予約です', scheduledAt: future() },
      KEY8,
    );
    expect(res.status).toBe(200);
    const rows = scheduledRows();
    expect(rows).toHaveLength(1);
    // 予約行には生の本文が残る（解決はcronが送る直前に行う）。
    expect(rows[0].content).toBe('{{name}}さん、{{field.pet_name}}の予約です');
  });

  test('予約の変更でもカタログに無い差し込みは400', async () => {
    const created = await postSchedule({ content: 'あとで', scheduledAt: future() }, KEY9);
    const { data } = (await created.json()) as { data: { id: string } };
    const res = await patchScheduled(data.id, { content: '{{unknown}}に変える' });
    expect(res.status).toBe(400);
    expect(scheduledRows()[0].content).toBe('あとで');
  });
});

test('友だちのこれからの飲食予約をプレビューと送信に差し込む', async () => {
  sqlite.raw.exec(`INSERT INTO rt_organizations(id,account_id,name) VALUES('org','acc-1','組織');
    INSERT INTO rt_stores(id,organization_id,name,code,line_account_id,timezone) VALUES('store','org','食堂','S','acc-1','Asia/Tokyo');
    INSERT INTO rt_reservations(id,store_id,source,customer_name,line_uid,guest_count,starts_at,ends_at,status) VALUES
    ('later','store','line','利用者1','U-1',5,'2099-11-02T10:00:00Z','2099-11-02T12:00:00Z','confirmed'),
    ('near','store','line','利用者1','U-1',2,'2099-11-01T09:00:00Z','2099-11-01T11:00:00Z','confirmed');`);
  const content = '{{name}} {{account.name}} {{var.reservation_datetime}} {{var.guest_count}}';
  const preview = await postPreview({ content });
  const result = await preview.json() as { data: { content: string; unresolved: string[] } };
  expect(result.data.unresolved).toEqual([]);
  expect(result.data.content).toContain('利用者1 acc-1');
  expect(result.data.content).toContain('18:00');
  expect(result.data.content.endsWith(' 2')).toBe(true);
  const sent = await postSend({ content, revision: 0 }, KEY1);
  expect(sent.status).toBe(200);
  expect((pushMessage.mock.calls[0] as [string, Array<{ text: string }>])[1][0].text).toBe(result.data.content);
});

test('予約がないと予約変数を未解決としてプレビューで示し、送信しない', async () => {
  const content = '{{name}} {{var.reservation_datetime}} {{var.guest_count}}';
  const preview = await postPreview({ content });
  const result = await preview.json() as { data: { content: string; unresolved: string[] } };
  expect(result.data.content).toContain('利用者1');
  expect(result.data.unresolved).toEqual(['var.reservation_datetime', 'var.guest_count']);
  const sent = await postSend({ content, revision: 0 }, KEY2);
  expect(sent.status).toBe(400);
  expect(pushMessage).not.toHaveBeenCalled();
});

test('飲食の予約を優先し、取消・過去・別人を除く。飲食がなければ最も近い通常予約を使う', async () => {
  sqlite.raw.exec(`INSERT INTO staff(id,line_account_id,name,display_name) VALUES('s','acc-1','担当','担当');
    INSERT INTO menus(id,line_account_id,name,duration_minutes,base_price) VALUES('m','acc-1','相談',60,0);
    INSERT INTO bookings(id,line_account_id,friend_id,staff_id,menu_id,starts_at,ends_at,block_ends_at,status,price_at_booking,requested_at)
    VALUES('b','acc-1','fr-1','s','m','2099-01-01T09:00:00Z','2099-01-01T10:00:00Z','2099-01-01T10:00:00Z','confirmed',0,'2026-01-01T00:00:00Z');
    INSERT INTO rt_organizations(id,account_id,name) VALUES('org','acc-1','組織');
    INSERT INTO rt_stores(id,organization_id,name,code,line_account_id,timezone) VALUES('store','org','食堂','S','acc-1','Asia/Tokyo');
    INSERT INTO rt_reservations(id,store_id,source,customer_name,line_uid,guest_count,starts_at,ends_at,status) VALUES
    ('cancelled','store','line','利用者1','U-1',9,'2098-01-01T09:00:00Z','2098-01-01T11:00:00Z','cancelled'),
    ('other','store','line','別人','U-2',8,'2098-01-01T09:00:00Z','2098-01-01T11:00:00Z','confirmed'),
    ('valid','store','line','利用者1','U-1',2,'2099-11-01T09:00:00Z','2099-11-01T11:00:00Z','confirmed');`);
  const content = '{{var.reservation_datetime}} {{var.course_name}}';
  const read = async () => ((await (await postPreview({ content })).json()) as { data: { content: string } }).data.content;
  expect(await read()).toContain('席のみ');
  sqlite.raw.exec("UPDATE rt_reservations SET status='cancelled' WHERE id='valid'");
  sqlite.raw.exec("INSERT INTO booking_settings(id,line_account_id,timezone) VALUES('bs','acc-1','America/New_York') ON CONFLICT(line_account_id) DO UPDATE SET timezone=excluded.timezone");
  const fallback = await read();
  expect(fallback).toContain('04:00');
  expect(fallback).toContain('相談');
  expect(fallback).toContain('2099-01-01');
});
