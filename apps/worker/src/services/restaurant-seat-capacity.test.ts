import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';
import { seedAssignmentFixture } from '../test-utils/assignment-fixture.js';
import { restaurantSeatCapacity } from './restaurant-seat-capacity.js';
import { readTableAutomation, saveTableAutomation } from './restaurant-table-automation.js';

let f: SqliteD1;
const startsAt = '2030-01-08T01:00:00Z', endsAt = '2030-01-08T03:00:00Z';
const input = { startsAt, endsAt, guestCount: 2 };
beforeEach(() => { f = createTestD1(); seedAssignmentFixture(f); f.raw.exec("UPDATE rt_tables SET is_active=0 WHERE id='big'"); });
afterEach(() => f.raw.close());
function insert(id: string) {
  return f.db.prepare("INSERT INTO rt_reservations(id,store_id,source,customer_name,guest_count,starts_at,ends_at,status) VALUES(?,'store','manual','試験',2,?,?,'confirmed')").bind(id, startsAt, endsAt);
}
describe('未配席を含む空席の確保', () => {
  it('最小の卓を固定順で選び、設定は読むだけで保存しない', async () => {
    const capacity = await restaurantSeatCapacity(f.db, 'store', startsAt, endsAt);
    expect(capacity.select(input)?.id).toBe('t1');
    expect(capacity.settings).toEqual({ enabled: true, version: 0 });
    expect(f.raw.prepare("SELECT COUNT(*) n FROM account_settings WHERE key LIKE 'restaurant.table_auto_assignment:%'").get()).toEqual({ n: 0 });
    await f.db.batch([capacity.guard, insert('first')]);
  });
  it('未配席でも1組につき卓が必要で、席数だけを合計して相席させない', async () => {
    f.raw.exec("UPDATE rt_tables SET is_active=0 WHERE id='t2'");
    f.raw.prepare("INSERT INTO rt_reservations(id,store_id,source,customer_name,guest_count,starts_at,ends_at,status) VALUES('one','store','manual','1人',1,?,?,'confirmed')").run(startsAt, endsAt);
    const capacity = await restaurantSeatCapacity(f.db, 'store', startsAt, endsAt);
    expect(capacity.select({ ...input, guestCount: 1 })).toBeNull();
  });
  it('同時に読んだ未配席の受付を一つのbatchで照合し、古い結果を使わせない', async () => {
    const first = await restaurantSeatCapacity(f.db, 'store', startsAt, endsAt);
    const second = await restaurantSeatCapacity(f.db, 'store', startsAt, endsAt);
    await f.db.batch([first.guard, insert('first')]);
    await expect(f.db.batch([second.guard, insert('stale')])).rejects.toThrow();
    expect(f.raw.prepare("SELECT id FROM rt_reservations WHERE id='stale'").get()).toBeUndefined();
    const refreshed = await restaurantSeatCapacity(f.db, 'store', startsAt, endsAt);
    expect(refreshed.select(input)).not.toBeNull();
    await f.db.batch([refreshed.guard, insert('second')]);
    expect((await restaurantSeatCapacity(f.db, 'store', startsAt, endsAt)).select(input)).toBeNull();
  });
  it('別の時間には同じ卓を使え、取消・期限切れ・退店済みは塞がない', async () => {
    await insert('first').run();
    const later = { ...input, startsAt: endsAt, endsAt: '2030-01-08T05:00:00Z' };
    expect((await restaurantSeatCapacity(f.db, 'store', later.startsAt, later.endsAt)).select(later)?.id).toBe('t1');
    f.raw.exec("UPDATE rt_reservations SET status='cancelled' WHERE id='first'");
    expect((await restaurantSeatCapacity(f.db, 'store', startsAt, endsAt)).select(input)?.id).toBe('t1');
  });
  it('オフを店舗ごとに版つきで保存し、別店舗や古い版を上書きしない', async () => {
    expect(await saveTableAutomation(f.db, 'a', 'store', { enabled: false, expectedVersion: 0 })).toEqual({ enabled: false, version: 1 });
    expect(await readTableAutomation(f.db, 'other-store')).toEqual({ enabled: true, version: 0 });
    expect(await saveTableAutomation(f.db, 'a', 'store', { enabled: true, expectedVersion: 0 })).toBeNull();
    await expect(saveTableAutomation(f.db, 'b', 'store', { enabled: true, expectedVersion: 1 })).rejects.toThrow();
    expect((await restaurantSeatCapacity(f.db, 'store', startsAt, endsAt)).settings.enabled).toBe(false);
  });
  it('配席設定や卓の状態が読取後に変わったら、古い条件で予約を保存しない',async()=>{
    const capacity=await restaurantSeatCapacity(f.db,'store',startsAt,endsAt);
    await saveTableAutomation(f.db,'a','store',{enabled:false,expectedVersion:0});
    await expect(capacity.commit([insert('stale')])).rejects.toThrow('RESTAURANT_CAPACITY_CHANGED');
    expect(f.raw.prepare("SELECT id FROM rt_reservations WHERE id='stale'").get()).toBeUndefined();
  });
  it('結合卓を必要とする未配席の組があると、構成卓を別の組へ二重に数えない',async()=>{
    f.raw.exec("UPDATE rt_tables SET join_group='pair' WHERE id IN('t1','t2')");
    f.raw.prepare("INSERT INTO rt_reservations(id,store_id,source,customer_name,guest_count,starts_at,ends_at,status) VALUES('group','store','manual','4名',4,?,?,'confirmed')").run(startsAt,endsAt);
    expect((await restaurantSeatCapacity(f.db,'store',startsAt,endsAt)).select(input)).toBeNull();
  });
  it('結合卓のどちらの卓をスタッフが指定しても、組全体の空きを検査する',async()=>{
    f.raw.exec("UPDATE rt_tables SET join_group='pair' WHERE id IN('t1','t2')");
    const capacity=await restaurantSeatCapacity(f.db,'store',startsAt,endsAt);
    expect(capacity.select({...input,guestCount:4,tableId:'t2'})).toMatchObject({tableIds:['t1','t2']});
  });
  it('未配席の滞在時間全体を検査し、照会時刻の外にある配席済み予約も守る',async()=>{
    f.raw.exec("UPDATE rt_tables SET is_active=0 WHERE id='t2'");
    await insert('unassigned').run();
    f.raw.prepare("INSERT INTO rt_reservations(id,store_id,source,customer_name,guest_count,starts_at,ends_at,table_id,status) VALUES('fixed','store','manual','固定',2,'2030-01-08T02:30:00Z','2030-01-08T04:00:00Z','t1','confirmed')").run();
    const short={...input,endsAt:'2030-01-08T02:00:00Z'};
    expect((await restaurantSeatCapacity(f.db,'store',short.startsAt,short.endsAt)).select(short)).toBeNull();
  });
  it('未配席で案内済みのキャンセル待ちも、滞在時間全体の空席を確保する',async()=>{
    f.raw.exec("UPDATE rt_tables SET is_active=0 WHERE id='t2'");
    f.raw.prepare("INSERT INTO rt_seat_waitlist(id,store_id,starts_at,ends_at,guest_count,customer_name,identity_key,status,hold_expires_at) VALUES('invited','store',?,?,2,'案内済み','phone:09012345678','invited',?)").run(startsAt,endsAt,startsAt);
    f.raw.prepare("INSERT INTO rt_reservations(id,store_id,source,customer_name,guest_count,starts_at,ends_at,table_id,status) VALUES('fixed','store','manual','固定',2,'2030-01-08T02:30:00Z','2030-01-08T04:00:00Z','t1','confirmed')").run();
    const short={...input,endsAt:'2030-01-08T02:00:00Z'};
    expect((await restaurantSeatCapacity(f.db,'store',short.startsAt,short.endsAt)).select(short)).toBeNull();
  });
});
