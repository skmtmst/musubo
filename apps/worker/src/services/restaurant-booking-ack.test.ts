import {afterEach,beforeEach,expect,it} from 'vitest';
import {createStyleScheduleFixture} from '../test-utils/style-schedule-fixture.js';
import {acknowledgeRestaurantBookings,undoRestaurantBookingAcknowledgement} from './restaurant-booking-ack.js';
import {styleSnapshot} from './style-analytics.js';

let f:ReturnType<typeof createStyleScheduleFixture>;
const now=Date.parse('2026-11-01T03:00:00Z');
const ids=['00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000003'];
const action=(operationId:string,bookingId:string|null,actorId='owner',storeId='store')=>({accountId:'a',storeId,actorId,operationId,bookingId,now});
function add(id:string,store='store',source='phone',created='2026-11-01 01:00:00'){
 f.raw.prepare(`INSERT INTO rt_reservations(id,store_id,source,customer_name,guest_count,starts_at,ends_at,status,created_at)
 VALUES(?,?,?,'客',2,'2026-11-02T01:00:00Z','2026-11-02T02:00:00Z','confirmed',?)`).run(id,store,source,created);
}
beforeEach(()=>{f=createStyleScheduleFixture();f.raw.exec("UPDATE rt_reservations SET created_at='2026-11-01 00:00:00' WHERE id='r'");});
afterEach(()=>f.raw.close());
it('単件の確認で予約は変更せず、再送は同じ結果を返す',async()=>{
 const before=f.raw.prepare("SELECT * FROM rt_reservations WHERE id='r'").get();
 expect(await acknowledgeRestaurantBookings(f.db,action(ids[0],'r'))).toMatchObject({acknowledgedCount:1,replayed:false});
 expect(await acknowledgeRestaurantBookings(f.db,action(ids[0],'r'))).toMatchObject({acknowledgedCount:1,replayed:true});
 expect(f.raw.prepare("SELECT * FROM rt_reservations WHERE id='r'").get()).toEqual(before);
});
it('一括の再送では後から届いた予約を巻き込まない',async()=>{
 add('r2');expect((await acknowledgeRestaurantBookings(f.db,action(ids[0],null))).acknowledgedCount).toBe(2);
 add('later');expect((await acknowledgeRestaurantBookings(f.db,action(ids[0],null))).acknowledgedCount).toBe(2);
 expect(f.raw.prepare("SELECT booking_id FROM restaurant_booking_acknowledgements ORDER BY booking_id").all()).toEqual([{booking_id:'r'},{booking_id:'r2'}]);
 expect(f.raw.prepare('SELECT booking_id FROM restaurant_booking_ack_operation_items WHERE operation_id=? ORDER BY booking_id').all(ids[0])).toEqual([{booking_id:'r'},{booking_id:'r2'}]);
});
it('一括確認は別の担当者が確認済みの予約を自分の操作に含めない',async()=>{
 await acknowledgeRestaurantBookings(f.db,action(ids[0],'r'));
 add('unconfirmed');
 expect((await acknowledgeRestaurantBookings(f.db,action(ids[1],null,'other'))).acknowledgedCount).toBe(1);
 expect((await undoRestaurantBookingAcknowledgement(f.db,action(ids[1],null,'other'))).undoneCount).toBe(1);
 expect(f.raw.prepare('SELECT booking_id,actor_id FROM restaurant_booking_acknowledgements').all()).toEqual([{booking_id:'r',actor_id:'owner'}]);
});
it('別の人が確認した分は別操作の取消では消えない',async()=>{
 await acknowledgeRestaurantBookings(f.db,action(ids[0],'r'));
 expect((await undoRestaurantBookingAcknowledgement(f.db,action(ids[0],'r'))).undoneCount).toBe(1);
 await acknowledgeRestaurantBookings(f.db,action(ids[1],'r','other'));
 expect((await undoRestaurantBookingAcknowledgement(f.db,action(ids[0],'r'))).undoneCount).toBe(0);
 expect(f.raw.prepare("SELECT actor_id,operation_id FROM restaurant_booking_acknowledgements").get()).toEqual({actor_id:'other',operation_id:ids[1]});
 await expect(undoRestaurantBookingAcknowledgement(f.db,action(ids[1],'r','owner'))).rejects.toMatchObject({status:404});
});
it('別の人が同じ予約を確認した後は、先の操作を戻しても新しい確認を保つ',async()=>{
 await acknowledgeRestaurantBookings(f.db,action(ids[0],'r'));
 expect((await acknowledgeRestaurantBookings(f.db,action(ids[1],'r','other'))).acknowledgedCount).toBe(1);
 expect((await undoRestaurantBookingAcknowledgement(f.db,action(ids[0],'r'))).undoneCount).toBe(0);
 expect(f.raw.prepare('SELECT actor_id,operation_id FROM restaurant_booking_acknowledgements').get()).toEqual({actor_id:'other',operation_id:ids[1]});
 expect(f.raw.prepare('SELECT operation_id,booking_id FROM restaurant_booking_ack_operation_items ORDER BY operation_id').all()).toEqual([{operation_id:ids[0],booking_id:'r'},{operation_id:ids[1],booking_id:'r'}]);
 expect((await acknowledgeRestaurantBookings(f.db,action(ids[0],'r'))).acknowledgedCount).toBe(1);
});
it('同じ操作IDを別の人や別店舗で使えない',async()=>{
 add('foreign','foreign-store');
 await expect(acknowledgeRestaurantBookings(f.db,action(ids[2],'foreign'))).rejects.toMatchObject({status:404});
 await acknowledgeRestaurantBookings(f.db,action(ids[0],'r'));
 await expect(acknowledgeRestaurantBookings(f.db,action(ids[0],'r','other'))).rejects.toMatchObject({status:409});
 await expect(acknowledgeRestaurantBookings(f.db,action(ids[0],'r','owner','foreign-store'))).rejects.toMatchObject({status:404});
});
it('同時に別の操作で確認しても同じ予約は1件だけ保存する',async()=>{
 const result=await Promise.all([acknowledgeRestaurantBookings(f.db,action(ids[0],'r')),acknowledgeRestaurantBookings(f.db,action(ids[1],'r','other'))]);
 expect(result.map(r=>r.acknowledgedCount).sort()).toEqual([1,1]);
 expect(f.raw.prepare('SELECT COUNT(*) n FROM restaurant_booking_acknowledgements').get()).toEqual({n:1});
});
it('その店の当日・未確認だけを数え、他店や取消と予約経路を区別する',async()=>{
 add('phone');add('hot','store','hotpepper');add('foreign','foreign-store','tabelog');add('yesterday','store','manual','2026-10-30 00:00:00');
 await acknowledgeRestaurantBookings(f.db,action(ids[0],'r'));
 const snapshot=await styleSnapshot(f.db,'a','restaurant',{},undefined,now,{kinds:['restaurant']});
 expect(snapshot.unconfirmedNewBookingsCount).toBe(2);
 expect(snapshot.newBookings.map(r=>[r.id,r.source]).sort()).toEqual([['hot','hotpepper'],['phone','phone']]);
 expect(snapshot.metrics.newBookings.value).toBe(3);
 const filtered=await styleSnapshot(f.db,'a','restaurant',{menu_id:'unrelated'},'another-staff',now,{kinds:['restaurant']});
 expect(filtered.unconfirmedNewBookingsCount).toBe(2);
});
it('1000件を超える一括操作は途中まで確認せず拒否する',async()=>{
 const insert=f.raw.prepare(`INSERT INTO rt_reservations(id,store_id,source,customer_name,guest_count,starts_at,ends_at,status,created_at)
 VALUES(?,'store','phone','客',1,'2026-11-02T01:00:00Z','2026-11-02T02:00:00Z','confirmed','2026-11-01 01:00:00')`);
 f.raw.transaction(()=>{for(let i=0;i<1000;i++)insert.run(`bulk${i}`)})();
 await expect(acknowledgeRestaurantBookings(f.db,action(ids[0],null))).rejects.toMatchObject({status:422});
 expect(f.raw.prepare('SELECT COUNT(*) n FROM restaurant_booking_acknowledgements').get()).toEqual({n:0});
});
it('確認後に予約の内容が変わっても、同じ予約は確認済みのままにする',async()=>{
 await acknowledgeRestaurantBookings(f.db,action(ids[0],'r'));
 f.raw.exec("UPDATE rt_reservations SET guest_count=3,updated_at='2026-11-01 02:00:00' WHERE id='r'");
 const snapshot=await styleSnapshot(f.db,'a','restaurant',{},undefined,now,{kinds:['restaurant']});
 expect(snapshot.newBookings.some(r=>r.id==='r')).toBe(false);
 expect(snapshot.unconfirmedNewBookingsCount).toBe(0);
});
it('店舗の今日の境界はUTC日付ではなく店舗の時間帯で決める',async()=>{
 add('local-today','store','walk_in','2026-10-31 15:05:00');
 add('local-yesterday','store','manual','2026-10-31 14:55:00');
 const snapshot=await styleSnapshot(f.db,'a','restaurant',{},undefined,now,{kinds:['restaurant']});
 expect(snapshot.newBookings.map(r=>r.id)).toContain('local-today');
 expect(snapshot.newBookings.map(r=>r.id)).not.toContain('local-yesterday');
 await acknowledgeRestaurantBookings(f.db,action(ids[0],null));
 expect(f.raw.prepare("SELECT booking_id FROM restaurant_booking_acknowledgements WHERE booking_id LIKE 'local-%'").all()).toEqual([{booking_id:'local-today'}]);
});
