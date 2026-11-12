import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { waitlistFixture, futureSlot } from '../test-utils/waitlist-fixture.js';
import type { SqliteD1 } from '../test-utils/d1-sqlite.js';
import { promoteSeatWaitlist } from './restaurant-seat-waitlist.js';
import { insertSeatWaitlistEntry } from '../routes/restaurant-test-definition.js';
let test: SqliteD1, slot: string; beforeEach(() => { test = waitlistFixture(); slot = futureSlot(); }); afterEach(() => test.raw.close());
function add(id: string, count = 2, uid = 'test-user-0', start = slot) { test.raw.prepare(`INSERT INTO rt_seat_waitlist(id,store_id,starts_at,guest_count,customer_name,line_uid,identity_key) VALUES(?,'store',?,?,'試験の組',?,?)`).run(id, start, count, uid, 'line:' + uid); }
function promote(table = 't') { return promoteSeatWaitlist(test.db, { storeId: 'store', startsAt: slot, tableId: table }); }
function reserve(id: string, uid: string, waitlistId: string | null = null, table = 't') { test.raw.prepare(`INSERT INTO rt_reservations(id,store_id,source,customer_name,line_uid,guest_count,starts_at,ends_at,table_id,status,waitlist_entry_id) VALUES(?,'store','line','試験の組',?,2,?,?,?,'confirmed',?)`).run(id, uid, slot, new Date(Date.parse(slot) + 7200000).toISOString(), table, waitlistId); }
describe('席のキャンセル待ち・先着順', () => {
  it('文字列で保存された待機が3件あっても、採番時に待機人数の上限を守る', async () => {
    const phones=['090-0000-5678','０９０－００００－５６７８','090 0000 5678'];
    for (const [index,phone] of phones.entries()) test.raw.prepare(`INSERT INTO rt_seat_waitlist(id,store_id,starts_at,guest_count,customer_name,customer_phone,identity_key) VALUES(?,'store',?,2,'電話の組',?,?)`).run(`old-${index}`,futureSlot(index+3),phone,`phone:${phone}`);
    const before=test.raw.prepare('SELECT * FROM rt_seat_waitlist ORDER BY id').all();
    expect(await insertSeatWaitlistEntry(test.db,{storeId:'store',startsAt:slot,guestCount:2,customerName:'電話の組',customerPhone:'09000005678',lineUid:null})).toEqual({ok:false,error:'waitlist_limit'});
    expect(test.raw.prepare('SELECT * FROM rt_seat_waitlist ORDER BY id').all()).toEqual(before);
  });
  it('電話は数字だけ保存し、表記を替えた再登録と旧行への重複を拒否する', async () => {
    const input={storeId:'store',startsAt:slot,guestCount:2,customerName:'電話の組',customerPhone:'０９０－００００－５６７８',lineUid:null};
    expect(await insertSeatWaitlistEntry(test.db,input)).toMatchObject({ok:true});
    expect(test.raw.prepare('SELECT customer_phone,identity_key FROM rt_seat_waitlist').get()).toEqual({customer_phone:'09000005678',identity_key:'phone:09000005678'});
    test.raw.exec("UPDATE rt_seat_waitlist SET customer_phone='０９０－００００－５６７８',identity_key='phone:０９０－００００－５６７８'");
    expect(await insertSeatWaitlistEntry(test.db,{...input,customerPhone:'090 0000 5678'})).toEqual({ok:false,error:'already_waiting'});
    expect(test.raw.prepare('SELECT customer_phone FROM rt_seat_waitlist').get()).toEqual({customer_phone:'０９０－００００－５６７８'});
    expect(await insertSeatWaitlistEntry(test.db,{...input,customerPhone:'090abc12345678'})).toEqual({ok:false,error:'invalid_phone'});
    expect(test.raw.prepare('SELECT COUNT(*) n FROM rt_seat_waitlist').get()).toEqual({n:1});
  });
  it('先頭に入らない卓では後ろの小さい組も追い越さない', async () => { add('first', 6); add('second', 2, 'test-user-1'); expect(await promote()).toMatchObject({ promoted: false, reason: 'no_fitting_table' }); expect((await promote('large')).promoted).toBe(true); expect((await promote()).promoted).toBe(true); });
  it('卓の滞在時間を仮押さえし、別の人の予約は拒否する', async () => { add('w0'); await promote(); expect(() => reserve('steal', 'test-user-1')).toThrow('restaurant_table_conflict'); expect(() => reserve('ok', 'test-user-0', 'w0')).not.toThrow(); expect(test.raw.prepare("SELECT status FROM rt_seat_waitlist WHERE id='w0'").get()).toMatchObject({ status: 'converted' }); });
  it('予約が残る卓には案内を出さない', async () => { reserve('full', 'test-user-7'); add('w0'); expect((await promote()).promoted).toBe(false); });
  it('仮押さえ期限が切れた組を終わりにして次の組へ', async () => { add('w0'); add('w1', 2, 'test-user-1'); await promote(); test.raw.prepare("UPDATE rt_seat_waitlist SET hold_expires_at=? WHERE id='w0'").run(new Date(Date.now() - 1000).toISOString()); await promote(); expect(test.raw.prepare("SELECT status FROM rt_seat_waitlist WHERE id='w0'").get()).toMatchObject({ status: 'finished' }); expect(test.raw.prepare("SELECT status FROM rt_seat_waitlist WHERE id='w1'").get()).toMatchObject({ status: 'invited' }); });
  it('止めた卓には案内しない', async () => { add('w0'); test.raw.exec("UPDATE rt_tables SET is_active=0 WHERE id='t'"); expect(await promote()).toMatchObject({ promoted: false, reason: 'no_fitting_table' }); });
  it('人と席を合わせて同時3件まで、同時要求をDBで止める', () => { test.raw.prepare(`INSERT INTO booking_waitlist(id,line_account_id,staff_id,menu_id,starts_at,friend_id,identity_key) VALUES('human','a','s','m',?,'f0','friend:f0')`).run(slot); add('one'); add('two', 2, 'test-user-0', futureSlot(3)); expect(() => add('four', 2, 'test-user-0', futureSlot(4))).toThrow('waitlist_limit'); });
  it('開始まで1時間の席は登録できない', () => { expect(() => add('closed', 2, 'test-user-0', new Date(Date.now() + 59 * 60000).toISOString())).toThrow('waitlist_registration_closed'); });
  it('時刻変更でも別の組の仮押さえへ割り込めない', async () => { add('w0'); await promote(); const later = new Date(Date.parse(slot) + 14400000).toISOString(); test.raw.prepare(`INSERT INTO rt_reservations(id,store_id,source,customer_name,guest_count,starts_at,ends_at,table_id,status) VALUES('later','store','manual','試験の組',2,?,?,'t','confirmed')`).run(later, new Date(Date.parse(later) + 7200000).toISOString()); expect(() => test.raw.prepare("UPDATE rt_reservations SET starts_at=?,ends_at=? WHERE id='later'").run(slot, new Date(Date.parse(slot) + 7200000).toISOString())).toThrow('restaurant_table_conflict'); });
});
