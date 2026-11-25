import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../worker-env.js';
import { waitlistFixture, futureSlot } from '../test-utils/waitlist-fixture.js';
import type { SqliteD1 } from '../test-utils/d1-sqlite.js';
import { promoteBookingWaitlist } from '../features/booking/booking-waitlist.js';
import { promoteSeatWaitlist } from '../services/restaurant-seat-waitlist.js';
import { saveInventoryAllocation } from '../services/restaurant-inventory-allocation.js';
vi.mock('../features/booking/booking-automatic-line.js', () => ({ sendAutomaticBookingLine: vi.fn(async () => true) }));
vi.mock('../services/account-access.js', () => ({ canAccessAllLineAccounts: vi.fn(async () => true) }));
vi.mock('../features/booking/booking-notifier.js', async () => ({ ...await vi.importActual<typeof import('../features/booking/booking-notifier.js')>('../features/booking/booking-notifier.js'), sendBookingNotification: vi.fn(async () => { }) }));
import booking from './booking.js';
let test: SqliteD1, slot: string, app: Hono<Env>, env: Env['Bindings'], user: string;
beforeEach(() => { test = waitlistFixture(); slot = futureSlot(); user = 'test-user-0'; app = new Hono<Env>(); app.use('*', async (c, next) => { c.set('staff', { id: 'test-owner', name: '試験管理者', role: 'owner', readOnly: false, permissionKeys: [], viewPermissionKeys: [] }); await next(); }); app.route('/', booking); env = { DB: test.db, DEPLOY_ENV: 'test', RESTAURANT_TEST_ENABLED: 'true', LIFF_URL: 'https://liff.example.test' } as Env['Bindings']; vi.stubGlobal('fetch', async (url: unknown) => { if (String(url).includes('oauth2/v2.1/verify')) return new Response(JSON.stringify({ sub: user }), { status: 200 }); throw new Error('試験では外部送信しない'); }); });
afterEach(() => { vi.unstubAllGlobals(); test.raw.close(); });
function request(path: string, method = 'GET', body?: unknown, key = 'test-idempotency') { return app.request(path + (path.includes('?') ? '&' : '?') + 'liffId=test-liff', { method, headers: { Authorization: 'Bearer test-id-token', 'Content-Type': 'application/json', 'Idempotency-Key': key }, ...(body ? { body: JSON.stringify(body) } : {}) }, env, { waitUntil: () => { }, passThroughOnException: () => { }, props: {} } as ExecutionContext); }
function waitPerson() { test.raw.prepare(`INSERT INTO booking_waitlist(id,line_account_id,staff_id,menu_id,starts_at,friend_id,identity_key) VALUES('human','a','s','m',?,'f0','friend:f0')`).run(slot); }
function waitSeat() { test.raw.prepare(`INSERT INTO rt_seat_waitlist(id,store_id,starts_at,guest_count,customer_name,line_uid,identity_key) VALUES('seat','store',?,2,'試験の組','test-user-0','line:test-user-0')`).run(slot); }
describe('F-6 本人確認付きの案内確定', () => {
  it('人の案内は通常の予約口で確定し、再送で増えない', async () => { waitPerson(); await promoteBookingWaitlist(test.db, { lineAccountId: 'a', staffId: 's', startsAt: slot }); const input = { menu_id: 'm', staff_id: 's', starts_at: slot, waitlist_id: 'human' }; const result = await request('/api/liff/booking/requests', 'POST', input); expect(result.status, await result.clone().text()).toBe(201); expect(test.raw.prepare("SELECT status FROM booking_waitlist WHERE id='human'").get()).toMatchObject({ status: 'converted' }); const again = await request('/api/liff/booking/requests', 'POST', input); expect(again.status).toBe(201); expect(test.raw.prepare('SELECT COUNT(*) n FROM bookings').get()).toMatchObject({ n: 1 }); });
  it('開始まで2時間を切った案内は10分押さえ、通常の受付締切を越えて確定できる',async()=>{
    // 夜に回すと90分後が営業時間の外になり案内が出ない（落ちる）。時計だけを明日の日本時間12時に止める。
    vi.useFakeTimers({toFake:['Date'],now:new Date(Math.ceil(Date.now()/86400000)*86400000+3*3600000)});
    try{
    slot=new Date(Math.ceil((Date.now()+90*60000)/900000)*900000).toISOString();waitPerson();
    await promoteBookingWaitlist(test.db,{lineAccountId:'a',staffId:'s',startsAt:slot});
    expect(test.raw.prepare("SELECT hold_minutes FROM booking_waitlist WHERE id='human'").get()).toMatchObject({hold_minutes:10});
    const result=await request('/api/liff/booking/requests','POST',{menu_id:'m',staff_id:'s',starts_at:slot,waitlist_id:'human'});
    expect(result.status,await result.clone().text()).toBe(201);
    }finally{vi.useRealTimers();}
  });
  it('別の人は人の案内を使えない', async () => { waitPerson(); await promoteBookingWaitlist(test.db, { lineAccountId: 'a', staffId: 's', startsAt: slot }); user = 'test-user-1'; const result = await request('/api/liff/booking/requests', 'POST', { menu_id: 'm', staff_id: 's', starts_at: slot, waitlist_id: 'human' }); expect(result.status).toBe(409); expect(test.raw.prepare('SELECT COUNT(*) n FROM bookings').get()).toMatchObject({ n: 0 }); });
  it('期限切れの人の案内を拒否する', async () => { waitPerson(); await promoteBookingWaitlist(test.db, { lineAccountId: 'a', staffId: 's', startsAt: slot }); test.raw.prepare("UPDATE booking_waitlist SET hold_expires_at=? WHERE id='human'").run(new Date(Date.now() - 1000).toISOString()); expect((await request('/api/liff/booking/requests', 'POST', { menu_id: 'm', staff_id: 's', starts_at: slot, waitlist_id: 'human' })).status).toBe(409); });
  it('空き枠・開始1時間前は人の待ちに登録できない', async () => { const result = await request('/api/liff/booking/waitlist', 'POST', { menu_id: 'm', staff_id: 's', starts_at: slot }); expect(result.status).toBe(409); const near = await request('/api/liff/booking/waitlist', 'POST', { menu_id: 'm', staff_id: 's', starts_at: new Date(Date.now() + 59 * 60000).toISOString() }); expect(near.status).toBe(409); });
  it('席の案内を本人が確定し、再送では同じ予約を返す', async () => { waitSeat(); await promoteSeatWaitlist(test.db, { storeId: 'store', startsAt: slot, tableId: 't' }); const result = await request('/api/liff/booking/seat-waitlist/seat/accept', 'POST', {}); expect(result.status, await result.clone().text()).toBe(201); const again = await request('/api/liff/booking/seat-waitlist/seat/accept', 'POST', {}); expect(again.status).toBe(200); expect(test.raw.prepare('SELECT COUNT(*) n FROM rt_reservations').get()).toMatchObject({ n: 1 }); expect(test.raw.prepare("SELECT status FROM rt_seat_waitlist WHERE id='seat'").get()).toMatchObject({ status: 'converted' }); });
  it('2席の卓を2つつないだ案内で4人の予約を確定する', async () => {
    test.raw.exec("UPDATE rt_tables SET max_capacity=2, join_group='joined' WHERE id IN ('t','large')");
    waitSeat();
    test.raw.exec("UPDATE rt_seat_waitlist SET guest_count=4 WHERE id='seat'");
    const joinedTables = [{ table_id: 'large' }, { table_id: 't' }];
    expect(await promoteSeatWaitlist(test.db, { storeId: 'store', startsAt: slot, tableId: 't' })).toMatchObject({ promoted: true });
    expect(test.raw.prepare("SELECT table_id FROM rt_seat_waitlist_table_links WHERE waitlist_id='seat' ORDER BY table_id").all())
      .toEqual(joinedTables);
    const result = await request('/api/liff/booking/seat-waitlist/seat/accept', 'POST', {});
    expect(result.status, await result.clone().text()).toBe(201);
    const { reservation_id } = await result.json() as { reservation_id: string };
    expect(test.raw.prepare("SELECT table_id FROM rt_reservation_table_links WHERE reservation_id=? ORDER BY table_id").all(reservation_id))
      .toEqual(joinedTables);
  });
  it('LINEの基本配分を案内前とお客さまの予約確定前に確かめる', async () => {
    const hours = Array.from({length:7}, (_, weekday) => ({ weekday, periods: [{ opensAt: '00:00', closesAt: '24:00' }] }));
    test.raw.prepare("INSERT INTO rt_opening_hours_settings(store_id,hours_json,updated_by) VALUES('store',?,'owner')")
      .run(JSON.stringify(hours));
    const save = (version: number, lineCapacity: number) => saveInventoryAllocation(test.db, 'store', 'owner', version, {
      scope: 'standard', allocation: { otaCapacity: 0, lineCapacity, walkInCapacity: 0 },
    });
    const promote = () => promoteSeatWaitlist(test.db, { storeId: 'store', startsAt: slot, tableId: 't' });
    const accept = () => request('/api/liff/booking/seat-waitlist/seat/accept', 'POST', {});
    waitSeat();
    expect(await save(0, 1)).toEqual({ version: 1 });
    expect(await promote()).toEqual({ promoted: false, reason: 'unavailable' });
    expect(await save(1, 2)).toEqual({ version: 2 });
    expect(await promote()).toMatchObject({ promoted: true });
    expect(await save(2, 1)).toEqual({ version: 3 });
    expect((await accept()).status).toBe(409);
    expect(test.raw.prepare('SELECT COUNT(*) n FROM rt_reservations').get()).toMatchObject({ n: 0 });
    expect(await save(3, 2)).toEqual({ version: 4 });
    const result = await accept();
    expect(result.status, await result.clone().text()).toBe(201);
  });
  it('基本配分がない店舗も時間帯のLINE受付上限を守る', async () => {
    const insertSlot = test.raw.prepare(`INSERT INTO rt_inventory_slots(id,store_id,starts_at,total_capacity,line_capacity)
      VALUES('physical','store',?,8,0)`);
    const promote = () => promoteSeatWaitlist(test.db, { storeId: 'store', startsAt: slot, tableId: 't' });
    const accept = () => request('/api/liff/booking/seat-waitlist/seat/accept', 'POST', {});
    waitSeat();
    insertSlot.run(slot);
    expect(await promote()).toEqual({ promoted: false, reason: 'unavailable' });

    test.raw.exec("DELETE FROM rt_inventory_slots WHERE id='physical'");
    expect(await promote()).toMatchObject({ promoted: true });
    insertSlot.run(slot);
    expect((await accept()).status).toBe(409);

    test.raw.exec("UPDATE rt_inventory_slots SET line_capacity=2 WHERE id='physical'");
    const endsAt = new Date(Date.parse(slot) + 120 * 60_000).toISOString();
    test.raw.prepare(`INSERT INTO rt_reservations(id,store_id,source,customer_name,guest_count,starts_at,ends_at,table_id,status)
      VALUES('other-line','store','line','別の組',2,?,?,'large','confirmed')`).run(slot, endsAt);
    expect((await accept()).status).toBe(409);
    expect(test.raw.prepare("SELECT status FROM rt_seat_waitlist WHERE id='seat'").get()).toEqual({ status: 'invited' });

    test.raw.exec("UPDATE rt_inventory_slots SET line_capacity=4 WHERE id='physical'");
    expect((await accept()).status).toBe(201);
  });
  it('別人の席の一覧・確定・取り消しを拒否する', async () => { waitSeat(); await promoteSeatWaitlist(test.db, { storeId: 'store', startsAt: slot, tableId: 't' }); user = 'test-user-1'; const list = await request('/api/liff/booking/seat-waitlist'); expect(await list.json()).toEqual({ success: true, waitlist: [] }); expect((await request('/api/liff/booking/seat-waitlist/seat/accept', 'POST', {})).status).toBe(404); expect((await request('/api/liff/booking/seat-waitlist/seat', 'DELETE')).status).toBe(404); });
  it('席の全卓が満席なら登録でき、空いている卓があれば登録を断る', async () => { const body = { store_id: 'store', starts_at: slot, guest_count: 2 }; expect((await request('/api/liff/booking/seat-waitlist', 'POST', body)).status).toBe(409); test.raw.exec("UPDATE rt_tables SET is_active=0 WHERE id='large'"); test.raw.prepare(`INSERT INTO rt_reservations(id,store_id,source,customer_name,guest_count,starts_at,ends_at,table_id,status) VALUES('full','store','manual','試験の組',2,?,?,'t','confirmed')`).run(slot, new Date(Date.parse(slot) + 7200000).toISOString()); const result = await request('/api/liff/booking/seat-waitlist', 'POST', body); expect(result.status, await result.clone().text()).toBe(201); });
  it('管理の口で人・席の人数を読み、店が席の待ちを取り消せる', async () => { waitPerson(); waitSeat(); const list = await app.request('/api/booking/admin/waitlist?account_id=a', {}, env); expect(list.status).toBe(200); expect(await list.json()).toMatchObject({ slots: [{ waiting: 1, invited: 0, finished: 0 }], seatSlots: [{ waiting: 1, invited: 0, finished: 0 }] }); const cancel = await app.request('/api/booking/admin/waitlist/seat?account_id=a&kind=seat', { method: 'DELETE' }, env); expect(cancel.status).toBe(200); });
});
