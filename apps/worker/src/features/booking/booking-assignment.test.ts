import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestD1, type SqliteD1 } from '../../test-utils/d1-sqlite.js';
import { seedAssignmentFixture } from '../../test-utils/assignment-fixture.js';
import { assignBookingStaff, assignRestaurantTable, assignmentWindows } from './booking-assignment.js';
import { d1AssignmentSettingsStore } from './booking-assignment-settings.js';
import { seededAssignmentRandom } from './booking-assignment-selector.js';
import { promoteSeatWaitlist } from '../../services/restaurant-seat-waitlist.js';
let f: SqliteD1;
const start = '2030-01-08T01:00:00Z';
const tables = ['t1', 't2'].map(id => ({ id, label: id, minCapacity: 1, maxCapacity: 2 }));
beforeEach(() => { f = createTestD1(); seedAssignmentFixture(f); });
afterEach(() => f.raw.close());
function booking(id: string, staffId: string, status = 'confirmed', startsAt = start, account = 'a') {
  f.raw.prepare(`INSERT INTO bookings(id,friend_id,line_account_id,staff_id,menu_id,starts_at,ends_at,block_ends_at,status,price_at_booking,requested_at)
    VALUES(?,'test-friend',?,?,'m',?,datetime(?,'+30 minutes'),datetime(?,'+30 minutes'),?,0,?)`).run(id, account, staffId, startsAt, startsAt, startsAt, status, start);
}
function seat(id: string, tableId: string, status = 'confirmed', extra = '') {
  f.raw.prepare(`INSERT INTO rt_reservations(id,store_id,source,customer_name,table_id,guest_count,starts_at,ends_at,status)
    VALUES(?,'store','manual','試験',?,2,?,datetime(?,'+30 minutes'),?)`).run(id, tableId, start, start, status);
  if (extra) f.raw.exec(extra);
}
describe('実績を読み直す割り当て', () => {
  it('保存先がない間は人も卓も従来の先頭を選び、保存したふりをしない', async () => {
    f.raw.exec('DROP TABLE booking_assignment_settings');
    booking('old', 's1');
    expect(await assignBookingStaff(f.db, 'a', start, 'Asia/Tokyo', ['s1', 's2'])).toBe('s1');
    expect((await assignRestaurantTable(f.db, 'store', start, 2, tables))?.id).toBe('t1');
    expect(await d1AssignmentSettingsStore(f.db).save({ kind: 'staff', id: 'a' }, { method: 'balanced', balancePeriod: 'day', resources: [], expectedVersion: 0 })).toBe('unavailable');
  });
  it('同じ枠に順に入れると交互になり、申込中・確定・完了を数える', async () => {
    const selected: string[] = [];
    for (let i = 0; i < 6; i++) {
      const id = await assignBookingStaff(f.db, 'a', start, 'Asia/Tokyo', ['s1', 's2'], { random: () => 0 });
      selected.push(id!); booking(`r${i}`, id!, ['requested', 'confirmed', 'completed'][i % 3]);
    }
    expect(selected).toEqual(['s1', 's2', 's1', 's2', 's1', 's2']);
  });
  it('取消・却下・期限切れ・別アカウント・翌日は件数に入れない', async () => {
    await d1AssignmentSettingsStore(f.db).save({kind:'staff',id:'a'},{method:'balanced',balancePeriod:'day',expectedVersion:0,resources:[{resourceId:'s1',priority:'preferred',dailyLimit:null,sortOrder:0}]});
    ['cancelled', 'rejected', 'expired', 'no_show'].forEach((status, i) => booking(`skip${i}`, 's1', status));
    booking('elsewhere', 's1', 'confirmed', start, 'b');
    booking('tomorrow', 's1', 'confirmed', '2030-01-09T01:00:00Z');
    expect(await assignBookingStaff(f.db, 'a', start, 'Asia/Tokyo', ['s1', 's2'], { random: () => 0 })).toBe('s1');
  });
  it('集計期間の外でも最後に予約を受けた時刻を比較し、件数と優先度が同じなら古い人から',async()=>{
    booking('old-s1','s1','completed','2029-12-01T01:00:00Z');booking('old-s2','s2','completed','2029-12-01T02:00:00Z');
    f.raw.exec("UPDATE bookings SET requested_at=CASE staff_id WHEN 's1' THEN '2029-11-02T00:00:00Z' ELSE '2029-11-01T00:00:00Z' END");
    expect(await assignBookingStaff(f.db,'a',start,'Asia/Tokyo',['s1','s2'],{random:()=>0})).toBe('s2');
  });
  it('週で均等にしても上限は当日だけで判定する', async () => {
    await d1AssignmentSettingsStore(f.db).save({ kind: 'staff', id: 'a' }, { method: 'balanced', balancePeriod: 'week', expectedVersion: 0,
      resources: [{ resourceId: 's1', priority: 'normal', dailyLimit: 1, sortOrder: 0 }] });
    booking('monday', 's1', 'confirmed', '2030-01-07T01:00:00Z');
    expect(await assignBookingStaff(f.db, 'a', start, 'Asia/Tokyo', ['s1', 's2'])).toBe('s2');
    booking('today', 's2');
    expect(await assignBookingStaff(f.db, 'a', start, 'Asia/Tokyo', ['s1', 's2'], { random: () => 0 })).toBe('s1');
    booking('limit', 's1');
    expect(await assignBookingStaff(f.db, 'a', start, 'Asia/Tokyo', ['s1', 's2'])).toBe('s2');
  });
  it('卓は過去の件数に左右されず、最小の空き候補から固定順で選ぶ', async () => {
    seat('r1', 't1');
    expect((await assignRestaurantTable(f.db, 'store', start, 2, [...tables, { id: 'big', label: '大', minCapacity: 1, maxCapacity: 6 }], { random: seededAssignmentRandom(7) }))?.id).toBe('t1');
    expect((await assignRestaurantTable(f.db, 'store', start, 2, [tables[0], { id: 'big', label: '大', minCapacity: 1, maxCapacity: 6 }]))?.id).toBe('t1');
  });
  it('卓の過去の予約件数で選び方を変えない', async () => {
    seat('visited', 't1', 'visited', "INSERT INTO rt_seat_visit_marks(id,reservation_id,store_id,kind,marked_at) VALUES('mark','visited','store','visited','2030-01-08T01:00:00Z'); UPDATE rt_reservations SET departed_at=ends_at WHERE id='visited'");
    seat('expired', 't2', 'pending', "UPDATE rt_reservations SET hold_expires_at='2000-01-01T00:00:00Z' WHERE id='expired'");
    expect((await assignRestaurantTable(f.db, 'store', start, 2, tables))?.id).toBe('t1');
  });
  it('廃止した卓ごとの日別上限を自動配席へ残さない', async () => {
    seat('r1', 't2');
    await d1AssignmentSettingsStore(f.db).save({ kind: 'table', id: 'store' }, { method: 'balanced', balancePeriod: 'day', expectedVersion: 0,
      resources: [{ resourceId: 't2', priority: 'normal', dailyLimit: 1, sortOrder: 0 }] });
    expect((await assignRestaurantTable(f.db, 'store', start, 4, [{ ...tables[0], tableIds: ['t1', 't2'], maxCapacity: 4 }]))?.tableIds).toEqual(['t1','t2']);
  });
  it('空き待ちは先着順を保ち、廃止した優先度で順番を変えない', async () => {
    await d1AssignmentSettingsStore(f.db).save({ kind: 'table', id: 'store' }, { method: 'priority', balancePeriod: 'day', expectedVersion: 0,
      resources: [{ resourceId: 't2', priority: 'preferred', dailyLimit: null, sortOrder: 0 }] });
    f.raw.prepare(`INSERT INTO rt_seat_waitlist(id,store_id,starts_at,ends_at,guest_count,customer_name,identity_key)
      VALUES('waiting','store',?,datetime(?,'+30 minutes'),2,'先頭の組','name:first')`).run(start,start);
    expect(await promoteSeatWaitlist(f.db, {storeId:'store',startsAt:start,tableId:'t1'})).toMatchObject({promoted:true,entry:{id:'waiting',table_id:'t1'}});
  });
  it('日・週の境界を店舗時間で決め、夏時間の23時間の日も正しく数える', () => {
    const w = assignmentWindows('2030-01-07T15:01:00Z', 'Asia/Tokyo', 'week');
    expect(w.dayFrom).toBe('2030-01-07T15:00:00.000Z');
    expect(w.from).toBe('2030-01-06T15:00:00.000Z');
    const dst = assignmentWindows('2026-03-08T15:00:00Z', 'America/New_York', 'day');
    expect((Date.parse(dst.dayTo) - Date.parse(dst.dayFrom)) / 3600000).toBe(23);
  });
});
