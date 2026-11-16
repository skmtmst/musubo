import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { gapApp, gapCall, gapFixture, gapOwner, seedGapBooking } from '../test-utils/gap1.js';
import { readAccountAttention } from '../services/hq-account-attention.js';
import { styles } from './styles.js';
import { getInboxStatusCounts } from '@line-crm/db';

let d: ReturnType<typeof gapFixture>;
const path = '/api/hq/style-attention';
beforeEach(() => { d = gapFixture(); });
afterEach(() => { vi.restoreAllMocks(); d.raw.close(); });

async function read(staff = { ...gapOwner }) {
  const response = await gapCall(gapApp(d, [styles], staff), path);
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json() as Promise<{
    success: boolean;
    data: { asOf: string; items: Array<{
      accountId: string; name: string; style: string;
      counts: Record<string, number>;
      details: Record<string, Array<{ id: string; href?: string }>>;
    }> };
  }>;
}

function chat(id: string, account = 'a', status = 'unread') {
  d.raw.prepare('INSERT INTO friends(id,line_user_id,line_account_id,display_name) VALUES(?,?,?,?)')
    .run('friend-' + id, 'user-' + id, account, id);
  d.raw.prepare(`INSERT INTO chats(id,friend_id,line_account_id,status,created_at,updated_at) VALUES(?,?,?,?, 'now','now')`)
    .run(id, 'friend-' + id, account, status);
}

function eventBooking(account: string) {
  d.raw.prepare('INSERT INTO events(id,line_account_id,name) VALUES(?,?,?)').run('event-' + account, account, '催し');
  d.raw.prepare(`INSERT INTO event_slots(id,event_id,starts_at,ends_at) VALUES(?,?,'2026-11-01T01:00:00Z','2026-11-01T02:00:00Z')`)
    .run('slot-' + account, 'event-' + account);
  d.raw.prepare(`INSERT INTO event_bookings(id,line_account_id,event_id,slot_id,friend_id,identity_key,status,requested_at) VALUES(?,?,?,?,'f','friend:f','requested','now')`)
    .run('booking-' + account, account, 'event-' + account, 'slot-' + account);
}

test('同じ予約でも承認と未払いは別のやることとして数え、表と詳細を揃える', async () => {
  seedGapBooking(d, 'requested-overlap', 'requested');
  seedGapBooking(d, 'confirmed-unpaid', 'confirmed');
  d.raw.exec(`INSERT INTO booking_payments(id,line_account_id,booking_id,amount,status,provider,idempotency_key,created_at,updated_at) VALUES
    ('overlap','a','requested-overlap',100,'unpaid','test','overlap','now','now'),
    ('other','a','confirmed-unpaid',100,'unpaid','test','other','now','now')`);
  const summary = await readAccountAttention(d.db, 'a', false);
  const details = await readAccountAttention(d.db, 'a', true);
  expect(summary.counts.pendingBookings).toBe(1);
  expect(summary.counts.unpaid).toBe(2);
  expect(details.counts).toEqual(summary.counts);
  expect(details.details.unpaid).toEqual(expect.arrayContaining([{ id: 'overlap' }, { id: 'other' }]));
  expect(summary.targets.unpaid).toEqual([{ href: '/booking/menus?tab=payments&view=records', count: 2 }]);
});

test('複数アカウントの名前・スタイル・件数と先頭の行き先を保ち、他の統括は返さない', async () => {
  d.raw.exec(`INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret,tenant_id) VALUES('a2','ch-a2','二号店','token','secret','t');
    INSERT INTO account_styles(line_account_id,style,selection_mode,updated_at) VALUES('a','salon','configured','now');
    INSERT INTO booking_payments(id,line_account_id,amount,status,provider,idempotency_key,created_at,updated_at) VALUES('payment','a',100,'unpaid','test','payment','now','now');
    INSERT INTO line_account_connection_checks(id,line_account_id,check_kind,result,checked_at,checked_by,correlation_id,idempotency_key,account_revision) VALUES('old','a','webhook_test','failed','2026-10-01','o','old','old',1),('ok','a','webhook_test','ok','2026-10-02','o','ok','ok',1),('bad','a','bot_info','mismatched','2026-10-02','o','bad','bad',1);`);
  seedGapBooking(d, 'requested', 'requested');
  seedGapBooking(d, 'confirmed');
  eventBooking('a');
  eventBooking('a2');
  chat('first'); chat('second', 'a', 'on_hold'); chat('done', 'a', 'resolved');
  chat('another', 'a2', 'in_progress'); chat('private', 'b');
  const response = await read();
  expect(Object.keys(response).sort()).toEqual(['data', 'success']);
  expect(response.success).toBe(true);
  expect(Object.keys(response.data).sort()).toEqual(['asOf', 'items']);
  expect(Number.isFinite(Date.parse(response.data.asOf))).toBe(true);
  expect(response.data.items).toEqual([
    { accountId: 'a', name: '店', style: 'salon',
      counts: { unhandledChats: 2, pendingBookings: 2, unpaid: 1, connections: 1, stoppedDeliveries: 0 },
      details: { unhandledChats: [{ id: expect.stringMatching(/^(first|second)$/), href: '/chats' }], pendingBookings: [{ id: 'requested', href: '/booking/bookings' }],
        unpaid: [{ id: 'payment' }], connections: [{ id: 'bad', href: '/accounts' }], stoppedDeliveries: [] } },
    { accountId: 'a2', name: '二号店', style: 'standard',
      counts: { unhandledChats: 1, pendingBookings: 1, unpaid: 0, connections: 0, stoppedDeliveries: 0 },
      details: { unhandledChats: [{ id: 'another', href: '/chats' }], pendingBookings: [{ id: 'booking-a2', href: '/events/bookings' }],
        unpaid: [], connections: [], stoppedDeliveries: [] } },
  ]);
});

test('担当範囲と機能の可視範囲の交差だけを読み、閲覧専用も使える', async () => {
  d.raw.exec(`INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret,tenant_id) VALUES('a2','ch-a2','二号店','token','secret','t');
    UPDATE staff_members SET account_scope='accounts',access_level='read_only' WHERE id='o';
    INSERT INTO staff_account_scopes(staff_id,line_account_id,created_at) VALUES('o','a','now'),('o','b','now');`);
  chat('visible'); chat('unassigned', 'a2'); chat('foreign', 'b');
  const result = await read({ ...gapOwner, readOnly: true, featureEnabledLineAccountIds: ['a', 'a2', 'b'] });
  expect(result.data.items.map(item => item.accountId)).toEqual(['a']);
  expect(result.data.items[0].counts.unhandledChats).toBe(1);
  const empty = await read({ ...gapOwner, featureEnabledLineAccountIds: ['a2'] });
  expect(empty.data.items).toEqual([]);
});

test('可視アカウントが空なら集計も名前も問い合わせない', async () => {
  d.raw.exec("UPDATE staff_members SET account_scope='accounts' WHERE id='o'");
  const batch = vi.spyOn(d.db, 'batch');
  const prepare = vi.spyOn(d.db, 'prepare');
  expect((await read()).data.items).toEqual([]);
  expect(batch).not.toHaveBeenCalled();
  expect(prepare.mock.calls).toHaveLength(5); // 権限2、scope3だけ。
});

test.each(['staff', 'inactive', 'foreign'] as const)('権限がない利用者を拒否する: %s', async mode => {
  const staff = { ...gapOwner };
  if (mode === 'staff') staff.role = 'staff';
  if (mode === 'inactive') d.raw.exec("UPDATE staff_members SET is_active=0 WHERE id='o'");
  if (mode === 'foreign') d.raw.exec("UPDATE staff_members SET tenant_id='other' WHERE id='o'");
  const batch = vi.spyOn(d.db, 'batch');
  expect((await gapCall(gapApp(d, [styles], staff), path)).status).toBe(403);
  expect(batch).not.toHaveBeenCalled();
});

test('5アカウントは集計5batchと名前1読取で開始し、先のアカウントの応答を待たない', async () => {
  for (let i = 2; i <= 5; i++) {
    d.raw.prepare(`INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret,tenant_id) VALUES(?,?,?,'token','secret','t')`)
      .run('a' + i, 'channel-' + i, '店' + i);
    chat('chat-' + i, 'a' + i);
  }
  const originalBatch = d.db.batch.bind(d.db);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const batch = vi.spyOn(d.db, 'batch').mockImplementation(async statements => {
    await gate;
    return originalBatch(statements);
  });
  const prepare = vi.spyOn(d.db, 'prepare');
  const pending = read();
  try {
    await vi.waitFor(() => expect(batch).toHaveBeenCalledTimes(5));
    expect(batch.mock.calls.every(([statements]) => statements.length === 10)).toBe(true);
    expect(prepare.mock.calls).toHaveLength(55); // 集計50文＋名前1文＋権限/scope4文。
  } finally { release(); }
  expect((await pending).data.items).toHaveLength(5);
});

test('通常の明細100件とincludeDetails=falseの件数別行き先は変えない', async () => {
  for (let i = 0; i < 105; i++) chat('chat-' + i, 'a', i < 3 ? 'on_hold' : 'unread');
  eventBooking('a & b');
  // 行き先の定義IDはURLとして符号化され、予約自体のIDは含めない。
  d.raw.exec(`UPDATE event_bookings SET line_account_id='a'; UPDATE events SET line_account_id='a'`);
  const full = await readAccountAttention(d.db, 'a');
  expect(full.counts.unhandledChats).toBe(105);
  expect(full.details.unhandledChats).toHaveLength(100);
  expect(full.targets).toEqual({});
  const targets = await readAccountAttention(d.db, 'a', false);
  expect(targets.counts).toEqual(full.counts);
  expect(targets.details).toEqual({});
  expect(targets.targets.unhandledChats).toEqual([{ href: '/chats?status=on_hold', count: 3 }, { href: '/chats?status=unread', count: 102 }]);
  expect(targets.targets.pendingBookings).toEqual([{ href: '/events/bookings?id=event-a%20%26%20b', count: 1 }]);
  const slim = (await read()).data.items[0];
  expect(slim.counts).toEqual(full.counts);
  expect(slim.details.unhandledChats).toEqual(full.details.unhandledChats.slice(0, 1));
});

test('飲食予約は保留枠を除いた承認待ちだけ数え、既存の行き先を返す', async () => {
  d.raw.exec(`INSERT INTO rt_stores(id,organization_id,name,code,line_account_id) VALUES('restaurant','org','食堂','shop','a');
    INSERT INTO rt_reservations(id,store_id,source,customer_name,guest_count,starts_at,ends_at,status,hold_expires_at) VALUES
    ('request','restaurant','manual','お客さま',2,'2026-11-01T01:00:00Z','2026-11-01T02:00:00Z','pending',NULL),
    ('hold','restaurant','manual','お客さま',2,'2026-11-01T01:00:00Z','2026-11-01T02:00:00Z','pending','2026-11-01T00:00:00Z'),
    ('confirmed','restaurant','manual','お客さま',2,'2026-11-01T01:00:00Z','2026-11-01T02:00:00Z','confirmed',NULL)`);
  const item = (await read()).data.items[0];
  expect(item.counts.pendingBookings).toBe(1);
  expect(item.details.pendingBookings).toEqual([{ id: 'request', href: '/restaurant-test/reservations' }]);
});

test('集計に失敗したら0件の成功応答にせず、取得失敗を返す', async () => {
  d.raw.exec('ALTER TABLE line_account_connection_checks RENAME TO unavailable_checks');
  const response = await gapCall(gapApp(d, [styles], { ...gapOwner }), path);
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ success: false, code: 'style_unavailable' });
});

test('統括のトーク数と受信箱の状態別数は友だちの所属で一致する', async () => {
  chat('unread-a','a','unread'); chat('progress-a','a','in_progress'); chat('hold-a','a','on_hold');
  chat('resolved-a','a','resolved'); chat('private-b','b','unread');
  d.raw.exec("UPDATE chats SET line_account_id=NULL WHERE id IN ('unread-a','progress-a'); UPDATE chats SET line_account_id='a' WHERE id='private-b'");
  const inbox = await getInboxStatusCounts(d.db, { allowedAccountIds:['a'], includeUnassigned:false });
  const attention = await readAccountAttention(d.db, 'a', false);
  expect(attention.counts.unhandledChats).toBe(inbox.line.unanswered + inbox.line.inProgress + inbox.line.onHold);
  expect(attention.targets.unhandledChats).toEqual(expect.arrayContaining([
    {href:'/chats?status=unread',count:1}, {href:'/chats?status=in_progress',count:1}, {href:'/chats?status=on_hold',count:1},
  ]));
})
