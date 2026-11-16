import { useSqliteClock } from '../test-utils/sqlite-clock.js';
import {beforeEach,afterEach,test,expect,vi} from 'vitest';
import {bookingSeries} from './booking-series.js';
import {gapFixture,gapApp,gapCall,gapOwner,seedGapBooking} from '../test-utils/gap1.js';
import type {SqliteD1} from '../test-utils/d1-sqlite.js';
import {recurrenceDates} from '../features/booking/booking-series.js';
import {deleteCustomerData} from '../services/customer-data-deletion.js';
import {purgeTablesChildFirst,tenantScopeCondition} from '@line-crm/db';
let d:SqliteD1;const url='/api/booking/admin/series?account_id=a';
const body={friendId:'f',menuId:'menu',staffId:'bs',startsAt:'2026-11-20T05:00:00.000Z',rule:{freq:'weekly',count:3}};
beforeEach(()=>{vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-11-16T00:00:00Z'));d=gapFixture();useSqliteClock(d.raw,()=>new Date());d.raw.exec("UPDATE booking_settings SET max_active_bookings_per_friend=52");for(const date of ['2026-11-20','2026-11-27','2026-12-04','2026-12-11'])d.raw.prepare('INSERT INTO staff_shifts(id,staff_id,work_date,start_time,end_time) VALUES(?,\'bs\',?,\'09:00\',\'18:00\')').run(date,date);vi.stubGlobal('fetch',vi.fn(()=>{throw new Error('external_forbidden');}));});
afterEach(()=>{d.raw.close();vi.useRealTimers();vi.unstubAllGlobals();});
const app=()=>gapApp(d,[bookingSeries]);
test('B4-01 B4-02 B4-04: 3回のpreviewと飛ばす1回、二重押しでも2予約1組',async()=>{
 const preview=await gapCall(app(),'/api/booking/admin/series/preview?account_id=a','POST',body);expect(preview.status).toBe(200);expect((await preview.json() as any).data.occurrences.map((x:any)=>x.available)).toEqual([true,true,true]);
 const b={...body,choices:[{index:1,action:'skip'}]};const r=await gapCall(app(),url,'POST',b,'same-key');expect(r.status).toBe(201);
 const replay=await gapCall(app(),url,'POST',b,'same-key');expect(replay.status).toBe(201);expect(d.raw.prepare('SELECT count(*) n FROM bookings').get()).toEqual({n:2});expect(d.raw.prepare('SELECT count(*) n FROM booking_series').get()).toEqual({n:1});expect(fetch).not.toHaveBeenCalled();
});
test('B4-03: 保存直前の競合は全部か無し。batch途中の競合もrollback',async()=>{
 seedGapBooking(d,'busy','confirmed','2026-11-27T05:00:00.000Z');expect((await gapCall(app(),url,'POST',body)).status).toBe(409);expect(d.raw.prepare('SELECT count(*) n FROM booking_series').get()).toEqual({n:0});
 d.raw.exec("DELETE FROM bookings; CREATE TRIGGER force_conflict BEFORE INSERT ON bookings WHEN NEW.series_index=1 BEGIN SELECT RAISE(ABORT,'CHECK constraint failed: concurrent'); END");
 expect((await gapCall(app(),url,'POST',body)).status).toBe(409);expect(d.raw.prepare('SELECT count(*) n FROM bookings').get()).toEqual({n:0});expect(d.raw.prepare('SELECT count(*) n FROM booking_series').get()).toEqual({n:0});
});
test('B4-07 B4-16: この回だけ取消し・古い版は409、後の回を保つ',async()=>{
 const r=await gapCall(app(),url,'POST',body),data=(await r.json() as any).data;expect(r.status).toBe(201);
 const cancel=`/api/booking/admin/series/${data.series.id}/cancel?account_id=a`,b={scope:'this',fromBookingId:data.bookings[1].id,expectedVersion:1};
 expect((await gapCall(app(),cancel,'POST',b)).status).toBe(200);expect((await gapCall(app(),cancel,'POST',b)).status).toBe(409);
 expect(d.raw.prepare("SELECT status FROM bookings ORDER BY series_index").all()).toEqual([{status:'confirmed'},{status:'cancelled'},{status:'confirmed'}]);
});
test('B4-06: この回から後ぜんぶ変更、変更できない回は元のまま返す',async()=>{
 const data=(await (await gapCall(app(),url,'POST',body)).json() as any).data;
 const r=await gapCall(app(),`/api/booking/admin/series/${data.series.id}?account_id=a`,'PATCH',{scope:'following',fromBookingId:data.bookings[1].id,expectedVersion:1,change:{startsAt:'2026-11-27T06:00:00.000Z'}});
 expect(r.status).toBe(200);expect((await r.json() as any).data.changed).toHaveLength(2);expect(d.raw.prepare('SELECT starts_at FROM bookings ORDER BY series_index').all()).toEqual([{starts_at:body.startsAt},{starts_at:'2026-11-27T06:00:00.000Z'},{starts_at:'2026-12-04T06:00:00.000Z'}]);
});
test('B4-17 Q-01: 閲覧のみは一覧だけ、代理も作らない、店をまたげない',async()=>{
 for(const [who,im] of [[{...gapOwner,readOnly:true},false],[gapOwner,true]] as const)expect((await gapCall(gapApp(d,[bookingSeries],who,im),url,'POST',body)).status).toBe(403);
 expect((await gapCall(app(),url.replace('=a','=b'),'POST',body)).status).toBe(404);
});
test('B4-19: 毎月第N曜日と夏時間を店の現地時刻で計算、上限53は拒否',()=>{
 expect(recurrenceDates('2026-11-20T05:00:00Z',{freq:'monthly_nth',count:3},'Asia/Tokyo')).toEqual(['2026-11-20T05:00:00.000Z','2026-12-18T05:00:00.000Z','2027-01-15T05:00:00.000Z']);
 expect(recurrenceDates('2026-10-25T13:00:00Z',{freq:'weekly',count:2},'America/New_York')).toEqual(['2026-10-25T13:00:00.000Z','2026-11-01T14:00:00.000Z']);
 expect(()=>recurrenceDates(body.startsAt,{freq:'weekly',count:53},'Asia/Tokyo')).toThrow();
});
test('B4-17 Q-01: 閲覧だけのスタッフも空きの見本は読めるが予約は作れない',async()=>{
 const who={...gapOwner,id:'s',role:'staff' as const,readOnly:true,permissionKeys:[],viewPermissionKeys:['/booking/bookings']},a=gapApp(d,[bookingSeries],who);
 expect((await gapCall(a,'/api/booking/admin/series/preview?account_id=a','POST',body)).status).toBe(200);expect((await gapCall(a,url,'POST',body)).status).toBe(403);expect(d.raw.prepare('SELECT count(*) n FROM booking_series').get()).toEqual({n:0});
});
test('B4-01 B5-15 AI-29: 顧客データ削除で組・追加分・AI処理権も残さない',async()=>{
 d.raw.pragma('foreign_keys = ON');
 const response=await gapCall(app(),url,'POST',body);expect(response.status).toBe(201);
 const data=(await response.json() as any).data;
 d.raw.prepare('INSERT INTO booking_addons(booking_id,addon_menu_id,duration_min,price_at_booking) VALUES(?,?,30,100)').run(data.bookings[0].id,'menu');
 d.raw.exec("INSERT INTO chats(id,friend_id,created_at,updated_at) VALUES('delete-chat','f','now','now'); INSERT INTO ai_request_claims(chat_id,kind,claim_id,expires_at) VALUES('delete-chat','draft','pending','later')");
 await deleteCustomerData({DB:d.db},{kind:'friend_data',id:'f',friendId:'f',accountId:'a',lineUserId:'Uf'},'o');
 for(const table of ['booking_series','bookings','booking_addons','ai_request_claims'])expect(d.raw.prepare(`SELECT COUNT(*) n FROM ${table}`).get()).toEqual({n:0});
 expect(d.raw.prepare("SELECT id FROM menus WHERE id='menu'").get()).toBeTruthy();
});
test('B4-01 B5-15: 統括の削除順で追加分と予約を消してから組を消す',async()=>{
 d.raw.pragma('foreign_keys = ON');
 const data=(await (await gapCall(app(),url,'POST',body)).json() as any).data;
 d.raw.prepare('INSERT INTO booking_addons(booking_id,addon_menu_id,duration_min,price_at_booking) VALUES(?,?,30,100)').run(data.bookings[0].id,'menu');
 const tables=new Set(['bookings','booking_series','booking_addons']);
 for(const table of purgeTablesChildFirst().filter(t=>tables.has(t)))d.raw.prepare(`DELETE FROM ${table} WHERE ${tenantScopeCondition(table)}`).run('t');
 for(const table of tables)expect(d.raw.prepare(`SELECT COUNT(*) n FROM ${table}`).get()).toEqual({n:0});
});

function seedEightWeeks(){
 for(const date of ['2026-12-18','2026-12-25','2027-01-01','2027-01-08','2027-01-15'])d.raw.prepare("INSERT INTO staff_shifts(id,staff_id,work_date,start_time,end_time) VALUES(?,'bs',?,'09:00','18:00')").run(date,date);
 seedGapBooking(d,'busy1','confirmed','2026-11-27T05:00:00.000Z');
 seedGapBooking(d,'busy2','confirmed','2026-12-04T05:00:00.000Z');
}
test('B4-01: 8回の候補のうち埋まっている2回を明示する',async()=>{
 seedEightWeeks();
 const r=await gapCall(app(),'/api/booking/admin/series/preview?account_id=a','POST',{...body,rule:{freq:'weekly',count:8}});
 expect(r.status).toBe(200);
 const occurrences=(await r.json() as any).data.occurrences;
 expect(occurrences).toHaveLength(8);
 expect(occurrences.filter((x:any)=>!x.available).map((x:any)=>x.index)).toEqual([1,2]);
 expect(occurrences.filter((x:any)=>!x.available).every((x:any)=>x.reason==='slot_unavailable')).toBe(true);
});
test('B4-02: 8回のうち1回を別時刻にし1回を飛ばすと7件と1組',async()=>{
 seedEightWeeks();
 const r=await gapCall(app(),url,'POST',{...body,rule:{freq:'weekly',count:8},choices:[{index:1,action:'keep',alternativeStartsAt:'2026-11-27T06:00:00.000Z'},{index:2,action:'skip'}]});
 expect(r.status,await r.clone().text()).toBe(201);
 const data=(await r.json() as any).data;
 expect(data.bookings).toHaveLength(7);expect(data.skipped.map((x:any)=>x.index)).toEqual([2]);
 expect(data.bookings.find((x:any)=>x.series_index===1).starts_at).toBe('2026-11-27T06:00:00.000Z');
 expect(d.raw.prepare('SELECT count(*) n FROM booking_series').get()).toEqual({n:1});
});

test('B4-08: 4回目から取消の見込みは期限後の回だけ料金を出す',async()=>{
 d.raw.exec(`INSERT INTO booking_cancellation_policies(line_account_id,enabled,tiers_json,no_show_percent,updated_by,updated_at) VALUES('a',1,'[{"beforeHours":24,"percent":0},{"beforeHours":0,"percent":50}]',100,'o','2026-11-16')`);
 d.raw.prepare("INSERT INTO staff_shifts(id,staff_id,work_date,start_time,end_time) VALUES('fifth','bs','2026-12-18','09:00','18:00')").run();
 const made=await gapCall(app(),url,'POST',{...body,rule:{freq:'weekly',count:5}});expect(made.status,await made.clone().text()).toBe(201);
 const data=(await made.json() as any).data;vi.setSystemTime(new Date('2026-12-11T04:00:00Z'));
 const r=await gapCall(app(),`/api/booking/admin/series/${data.series.id}/impact?account_id=a`,'POST',{scope:'following',fromBookingId:data.bookings[3].id,expectedVersion:1});
 expect(r.status).toBe(200);const items=(await r.json() as any).data.items;
 expect(items.map((item:any)=>item.fee.amount)).toEqual([4200,0]);expect(items.map((item:any)=>item.bookingId)).toEqual(data.bookings.slice(3).map((b:any)=>b.id));
});

test('B4-17: 閲覧のみの担当は繰り返しの一覧を読み取消できない',async()=>{
 const made=await gapCall(app(),url,'POST',body);expect(made.status).toBe(201);const data=(await made.json() as any).data;
 const viewer={...gapOwner,id:'s',role:'staff' as const,readOnly:true,permissionKeys:[],viewPermissionKeys:['/booking/bookings']};const a=gapApp(d,[bookingSeries],viewer);
 const detail=await gapCall(a,`/api/booking/admin/series/${data.series.id}?account_id=a`);expect(detail.status).toBe(200);expect((await detail.json() as any).data.bookings).toHaveLength(3);
 const cancel=await gapCall(a,`/api/booking/admin/series/${data.series.id}/cancel?account_id=a`,'POST',{scope:'this',fromBookingId:data.bookings[0].id,expectedVersion:1});
 expect(cancel.status).toBe(403);expect(d.raw.prepare("SELECT COUNT(*) n FROM bookings WHERE status='cancelled'").get()).toEqual({n:0});
});
