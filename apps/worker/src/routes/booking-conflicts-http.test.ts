import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BookingConflictsResponse } from '@line-crm/shared';
import type { Env } from '../worker-env.js';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';

const access = vi.hoisted(() => ({ allowed: true }));
vi.mock('../services/account-access.js', () => ({ canAccessAllLineAccounts: vi.fn(async () => access.allowed) }));
import booking from './booking.js';

let db: SqliteD1;
function request(role: 'owner' | 'admin' | 'staff' | null = 'owner', options: { account?: string; view?: boolean; edit?: boolean } = {}) {
  const app = new Hono<Env>();
  app.use('*', async (c, next) => {
    if (role) c.set('staff', { id: 'login', name: '試験', role, readOnly: options.view ?? false,
      permissionKeys: options.edit ? ['/booking/bookings'] : [],
      viewPermissionKeys: options.view ? ['/booking/bookings'] : [] });
    await next();
  });
  app.route('/', booking);
  return app.request(`/api/booking/admin/conflicts${options.account === '' ? '' : `?account_id=${options.account ?? 'a'}`}`, {}, { DB: db.db });
}
async function conflicts() {
  const res = await request();
  expect(res.status).toBe(200);
  return (await res.json() as { data: BookingConflictsResponse }).data.conflicts;
}

beforeEach(() => {
  access.allowed = true;
  db = createTestD1({ foreignKeys: true });
  db.raw.exec(`INSERT INTO line_accounts(id,name,channel_id,channel_secret,channel_access_token)
      VALUES('a','試験店','a','secret','token'),('b','別店','b','secret','token');
    INSERT INTO staff(id,line_account_id,name,display_name) VALUES('s','a','担当','佐野'),('s2','a','担当2','中川');
    INSERT INTO menus(id,line_account_id,name,duration_minutes,base_price) VALUES('m','a','トリミング',60,0),('m2','a','シャンプー',45,0);
    INSERT INTO friends(id,line_user_id,display_name,line_account_id) VALUES('f','Utest','見本 143','a'),('foreign-f','Uforeign','別店のお客さま','b');
    INSERT INTO booking_customers(id,line_account_id,display_name,phone_normalized_hash,phone_encrypted,phone_last4)
      VALUES('c','a','見本 178','hash','private-cipher','1234'),('foreign-c','b','別店の電話客','hash2','private-other','5678');
    INSERT INTO bookings(id,line_account_id,friend_id,booking_customer_id,staff_id,menu_id,starts_at,ends_at,block_ends_at,status,price_at_booking,requested_at,source,lock_version)
      VALUES('b1','a','f',NULL,'s','m','2027-10-03T04:00:00Z','2027-10-03T05:00:00Z','2027-10-03T05:10:00Z','confirmed',0,'2027-10-01T00:00:00Z','liff',2),
        ('b2','a',NULL,'c','s','m2','2027-10-03T04:00:00Z','2027-10-03T04:45:00Z','2027-10-03T04:55:00Z','requested',0,'2027-10-01T00:00:00Z','phone',3);`);
});
afterEach(() => { db.raw.close(); vi.restoreAllMocks(); });

describe('重なった予約の表示材料', () => {
  it('2件の顧客・メニュー・担当・日時・経路・版と理由を返し、既存項目も保つ', async () => {
    const [pair] = await conflicts();
    expect(pair).toMatchObject({ bookingId: 'b1', otherBookingId: 'b2', staffId: 's', staffName: '佐野',
      reasonCode: 'same_staff_time_overlap', reason: '同じ担当の予約時間が重なっています。', calendarConnected: false });
    expect(pair.bookings).toEqual([
      { bookingId: 'b1', customerName: '見本 143', menuName: 'トリミング', staffId: 's', staffName: '佐野', startsAt: '2027-10-03T04:00:00Z', endsAt: '2027-10-03T05:00:00Z', source: 'liff', sourceLabel: 'LINE（musubo）', version: 2 },
      { bookingId: 'b2', customerName: '見本 178', menuName: 'シャンプー', staffId: 's', staffName: '佐野', startsAt: '2027-10-03T04:00:00Z', endsAt: '2027-10-03T04:45:00Z', source: 'phone', sourceLabel: '電話', version: 3 },
    ]);
    expect(pair.guidance).toContain('Googleカレンダー');
  });
  it('電話の秘密値・LINE識別子・顧客の名前をログへ出さず、応答も秘密値を含めない', async () => {
    const logs = ['log', 'warn', 'error'].map((method) => vi.spyOn(console, method as 'log').mockImplementation(() => {}));
    const res = await request();
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const text = await res.text();
    expect(text).not.toMatch(/private-cipher|Utest|1234|phone_encrypted|channel_access_token/);
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });
  it('有効な同じ店舗・同じ担当の連携設定がある時だけ、未接続の案内を消す', async () => {
    db.raw.exec(`INSERT INTO google_calendar_connections(id,line_account_id,staff_id,calendar_id,is_active)
      VALUES('gc','a','s2','other-calendar',1),('inactive','a','s','inactive',0);`);
    expect((await conflicts())[0].calendarConnected).toBe(false);
    db.raw.exec("UPDATE google_calendar_connections SET is_active=1,line_account_id='b' WHERE id='inactive'");
    expect((await conflicts())[0].calendarConnected).toBe(false);
    db.raw.exec("UPDATE google_calendar_connections SET line_account_id='a' WHERE id='inactive'");
    expect((await conflicts())[0]).toMatchObject({ calendarConnected: true, guidance: null });
  });
  it.each([['counter', '店頭'], ['operator', 'スタッフによる登録'], ['import', '外部取り込み']])('経路 %s は保存値どおりに返す', async (source, label) => {
    db.raw.prepare('UPDATE bookings SET source=?,external_event_id=?,external_calendar_id=? WHERE id=?').run(source, 'synced-event', 'synced-calendar', 'b2');
    expect((await conflicts())[0].bookings[1]).toMatchObject({ source, sourceLabel: label });
  });
  it('別店舗を参照する不整合な顧客IDから名前を漏らさない', async () => {
    db.raw.exec("UPDATE bookings SET friend_id='foreign-f' WHERE id='b1'; UPDATE bookings SET booking_customer_id='foreign-c' WHERE id='b2'");
    const pair = (await conflicts())[0];
    expect(pair.bookings.map((item) => item.customerName)).toEqual(['名前未設定', '名前未設定']);
  });
  it('空の友だち名は予約顧客名を使い、両方なければ名前未設定にする', async () => {
    db.raw.exec("UPDATE friends SET display_name='' WHERE id='f'; UPDATE bookings SET booking_customer_id='c' WHERE id='b1'");
    expect((await conflicts())[0].bookings[0].customerName).toBe('見本 178');
    db.raw.exec("UPDATE bookings SET booking_customer_id=NULL WHERE id='b1'");
    expect((await conflicts())[0].bookings[0].customerName).toBe('名前未設定');
  });
  it('時差表記が違っても同じ瞬間で判定し、隣接する予約は除く', async () => {
    db.raw.exec("UPDATE bookings SET starts_at='2027-10-03T13:30:00+09:00',ends_at='2027-10-03T14:15:00+09:00' WHERE id='b2'");
    expect(await conflicts()).toHaveLength(1);
    db.raw.exec("UPDATE bookings SET starts_at='2027-10-03T14:00:00+09:00' WHERE id='b2'");
    expect(await conflicts()).toEqual([]);
  });
  it.each(['cancelled', 'completed', 'no_show', 'expired', 'rejected'])('状態 %s の予約は除く', async (status) => {
    db.raw.prepare('UPDATE bookings SET status=? WHERE id=?').run(status, 'b2');
    expect(await conflicts()).toEqual([]);
  });
  it('owner/adminと予約管理を閲覧できるstaffが読める', async () => {
    expect((await request('admin')).status).toBe(200);
    expect((await request('staff', { edit: true })).status).toBe(200);
    expect((await request('staff', { view: true })).status).toBe(200);
  });
  it('権限なし・対象外の役割・担当外・account未指定を拒否する', async () => {
    expect((await request('staff')).status).toBe(403);
    expect((await request(null)).status).toBe(403);
    expect((await request('owner', { account: '' })).status).toBe(400);
    expect((await request('owner', { account: 'b' })).status).toBe(200);
    access.allowed = false;
    expect((await request()).status).toBe(403);
  });
});
