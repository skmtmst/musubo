import { useSqliteClock } from '../test-utils/sqlite-clock.js';
import {beforeEach,afterEach,test,expect,vi} from 'vitest';
import {bookingMakeup} from './booking-makeup.js';
import events from './events.js';
import {absence,makeupOptions,useMakeup,expireMakeup} from '../features/booking/booking-makeup.js';
import {gapFixture,gapApp,gapCall,gapOwner} from '../test-utils/gap1.js';
import type {SqliteD1} from '../test-utils/d1-sqlite.js';
import {deleteCustomerData} from '../services/customer-data-deletion.js';
import {purgeTablesChildFirst,tenantScopeCondition} from '@line-crm/db';
let d:SqliteD1;
beforeEach(()=>{vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-11-16T00:00:00Z'));d=gapFixture();useSqliteClock(d.raw,()=>new Date());d.raw.exec(`INSERT INTO events(id,line_account_id,name,is_published,lifecycle_status,makeup_rule_json) VALUES('lesson','a','教室',1,'published','{"enabled":true,"cutoffHours":3,"validDays":30,"monthlyCap":2,"target":"same_kind","targetIds":[]}');
 INSERT INTO event_slots(id,event_id,starts_at,ends_at,capacity) VALUES('src','lesson','2026-11-20T05:00:00Z','2026-11-20T06:00:00Z',1),('dst','lesson','2026-11-27T05:00:00Z','2026-11-27T06:00:00Z',1),('late','lesson','2027-01-27T05:00:00Z','2027-01-27T06:00:00Z',1);
 INSERT INTO event_bookings(id,line_account_id,event_id,slot_id,friend_id,status,requested_at,identity_key) VALUES('eb','a','lesson','src','f','confirmed','2026-10-16T00:00:00Z','solo:f');`);vi.stubGlobal('fetch',vi.fn(()=>{throw new Error('external_forbidden');}));});
afterEach(()=>{d.raw.close();vi.useRealTimers();vi.unstubAllGlobals();});
test('B3-01 B3-03 B3-05 B3-06 B3-07: 欠席と振替先の選択は別。二重でも各1件',async()=>{
 const first=await absence(d.db,'a','f','eb','customer');expect(first.eventBooking.status).toBe('absent');expect(first.makeupCredit).toBeTruthy();
 await absence(d.db,'a','f','eb','customer');expect(d.raw.prepare('SELECT count(*) n FROM booking_makeup_credits').get()).toEqual({n:1});
 const id=(first.makeupCredit as any).id;expect((await makeupOptions(d.db,'a','f',id)).map(x=>x.id)).toContain('dst');expect((await makeupOptions(d.db,'a','f',id)).map(x=>x.id)).not.toContain('late');
 const used=await useMakeup(d.db,'a','f',id,'dst','use1');expect(await useMakeup(d.db,'a','f',id,'dst','use1')).toMatchObject({bookingId:used.bookingId,replayed:true});expect(d.raw.prepare("SELECT count(*) n FROM event_bookings WHERE slot_id='dst'").get()).toEqual({n:1});expect(fetch).not.toHaveBeenCalled();
});
test('B3-02 B3-09: 締め後は欠席だけ、手渡しには理由が必要',async()=>{
 const start=new Date(Date.now()+3600000).toISOString();d.raw.prepare("UPDATE event_slots SET starts_at=? WHERE id='src'").run(start);
 await expect(absence(d.db,'a','f','eb','s',true)).rejects.toThrow('reason_required');const r=await absence(d.db,'a','f','eb','customer');expect(r.makeupCredit).toBeNull();expect(r.reasonIfNone).toBe('cutoff_passed');
});
test('B3-04: 保存時の満席とbatch途中の失敗でも券は残り定員超えしない',async()=>{
 const cr=(await absence(d.db,'a','f','eb','customer')).makeupCredit as any;
 d.raw.exec("CREATE TRIGGER race_makeup BEFORE INSERT ON event_bookings WHEN NEW.slot_id='dst' BEGIN SELECT RAISE(ABORT,'CHECK constraint failed: seat_race'); END");
 await expect(useMakeup(d.db,'a','f',cr.id,'dst','use')).rejects.toThrow('makeup_slot_unavailable');expect(d.raw.prepare('SELECT status FROM booking_makeup_credits').get()).toEqual({status:'open'});expect(d.raw.prepare("SELECT count(*) n FROM event_bookings WHERE slot_id='dst'").get()).toEqual({n:0});
});
test('B3-08 B3-13 B3-15: 月上限・期限切れ・期限内取消で元の期限へ戻す',async()=>{
 const cr=(await absence(d.db,'a','f','eb','customer')).makeupCredit as any,used=await useMakeup(d.db,'a','f',cr.id,'dst','u');
 d.raw.prepare("UPDATE event_bookings SET status='cancelled',cancelled_by='friend' WHERE id=?").run(used.bookingId);expect(d.raw.prepare('SELECT status,expires_at FROM booking_makeup_credits').get()).toEqual({status:'open',expires_at:cr.expires_at});
 await expireMakeup(d.db,new Date('2027-01-01T00:00:00Z'));expect(d.raw.prepare('SELECT status FROM booking_makeup_credits').get()).toEqual({status:'expired'});await expect(useMakeup(d.db,'a','f',cr.id,'dst','late')).rejects.toThrow();
});
test('B3-12 Q-01: 閲覧のみ・代理は欠席を変えず、他店の予約も触れない',async()=>{
 const url='/api/events/admin/bookings/eb/absence?account_id=a';for(const [who,im] of [[{...gapOwner,readOnly:true},false],[gapOwner,true]] as const)expect((await gapCall(gapApp(d,[bookingMakeup],who,im),url,'POST',{})).status).toBe(403);
 expect((await gapCall(gapApp(d,[bookingMakeup]),url.replace('=a','=b'),'POST',{})).status).toBe(404);
});
test('B3-01 B3-08: 決まりの設定は管理者だけ、月の上限でも欠席はできる',async()=>{
 const url='/api/events/admin/lesson/makeup-rule?account_id=a',rule={enabled:true,cutoffHours:3,validDays:30,monthlyCap:1,target:'same_kind',targetIds:[]};
 expect((await gapCall(gapApp(d,[bookingMakeup]),url,'PUT',{rule,expectedRevision:1})).status).toBe(200);expect((await gapCall(gapApp(d,[bookingMakeup]),url,'PUT',{rule,expectedRevision:1})).status).toBe(409);
 await absence(d.db,'a','f','eb','customer');d.raw.exec("INSERT INTO event_bookings(id,line_account_id,event_id,slot_id,friend_id,status,requested_at) VALUES('eb2','a','lesson','dst','f','confirmed',datetime('now'))");
 const other=await absence(d.db,'a','f','eb2','customer');expect(other.makeupCredit).toBeNull();expect(other.eventBooking.status).toBe('absent');expect(d.raw.prepare('SELECT count(*) n FROM booking_makeup_credits').get()).toEqual({n:1});
});
test('B3-05 B3-07: 顧客データ削除で使用済み振替券と元の申込を残さない',async()=>{
 d.raw.pragma('foreign_keys = ON');
 const credit=(await absence(d.db,'a','f','eb','customer')).makeupCredit as any;
 await useMakeup(d.db,'a','f',credit.id,'dst','delete-used');
 await deleteCustomerData({DB:d.db},{kind:'friend_data',id:'f',friendId:'f',accountId:'a',lineUserId:'Uf'},'o');
 expect(d.raw.prepare('SELECT COUNT(*) n FROM booking_makeup_credits').get()).toEqual({n:0});
 expect(d.raw.prepare('SELECT COUNT(*) n FROM event_bookings').get()).toEqual({n:0});
 expect(d.raw.prepare("SELECT id FROM events WHERE id='lesson'").get()).toBeTruthy();
});
test('B3-05 B3-07: 統括の削除順は使用済み券を消してから元の申込を消す',async()=>{
 d.raw.pragma('foreign_keys = ON');
 const credit=(await absence(d.db,'a','f','eb','customer')).makeupCredit as any;
 await useMakeup(d.db,'a','f',credit.id,'dst','purge-used');
 const tables=new Set(['booking_makeup_credits','event_booking_reminders','event_bookings']);
 for(const table of purgeTablesChildFirst().filter(t=>tables.has(t)))d.raw.prepare(`DELETE FROM ${table} WHERE ${tenantScopeCondition(table)}`).run('t');
 for(const table of tables)expect(d.raw.prepare(`SELECT COUNT(*) n FROM ${table}`).get()).toEqual({n:0});
});

test('B3-01: 欠席した席のキャンセル待ち繰上げを一度だけ予約する',async()=>{
 await absence(d.db,'a','f','eb','customer');
 await absence(d.db,'a','f','eb','customer');
 expect(d.raw.prepare('SELECT event_id,slot_id,source_key,status FROM event_waitlist_promotion_jobs').all()).toEqual([{event_id:'lesson',slot_id:'src',source_key:'absence:eb',status:'pending'}]);
});

test('B3-02: 締め後の欠席を保存し振替券を発行しない',async()=>{
 d.raw.prepare("UPDATE event_slots SET starts_at=? WHERE id='src'").run(new Date(Date.now()+3600000).toISOString());
 const result=await absence(d.db,'a','f','eb','customer');
 expect(result.reasonIfNone).toBe('cutoff_passed');
 expect(d.raw.prepare("SELECT status,absence_reported_at FROM event_bookings WHERE id='eb'").get()).toEqual({status:'cancelled',absence_reported_at:'2026-11-16T00:00:00.000Z'});
 expect(d.raw.prepare('SELECT count(*) n FROM booking_makeup_credits').get()).toEqual({n:0});
});

test('B3-03: 同一の教室以外の空き回は振替先に含めない',async()=>{
 d.raw.exec("INSERT INTO events(id,line_account_id,name,is_published,lifecycle_status) VALUES('other','a','別教室',1,'published'); INSERT INTO event_slots(id,event_id,starts_at,ends_at,capacity) VALUES('other-slot','other','2026-11-27T05:00:00Z','2026-11-27T06:00:00Z',1)");
 const credit=(await absence(d.db,'a','f','eb','customer')).makeupCredit as any;
 const ids=(await makeupOptions(d.db,'a','f',credit.id)).map(x=>x.id);
 expect(ids).toContain('dst');expect(ids).not.toContain('other-slot');
});

test('B3-09: 締め後の手動付与は理由を記録する',async()=>{
 d.raw.prepare("UPDATE event_slots SET starts_at=? WHERE id='src'").run(new Date(Date.now()+3600000).toISOString());
 const result=await absence(d.db,'a','f','eb','staff',true,'休講の補填');
 expect(result.makeupCredit).toMatchObject({status:'open',reason:'休講の補填',granted_by:'staff'});
 expect(d.raw.prepare("SELECT status FROM event_bookings WHERE id='eb'").get()).toEqual({status:'cancelled'});
});

test('B3-13: 期限切れの券は履歴に残り選択や使用はできない',async()=>{
 const credit=(await absence(d.db,'a','f','eb','customer')).makeupCredit as any;
 vi.setSystemTime(new Date('2027-01-01T00:00:00Z'));
 await expireMakeup(d.db,new Date());
 expect(d.raw.prepare('SELECT id,status,expires_at FROM booking_makeup_credits').get()).toEqual({id:credit.id,status:'expired',expires_at:credit.expires_at});
 await expect(makeupOptions(d.db,'a','f',credit.id)).rejects.toThrow('credit_unavailable');
});

test.each(['admin','system'] as const)('振替先の個別取消（%s）で使用済み券を元の期限で戻す',async cancelledBy=>{
 const credit=(await absence(d.db,'a','f','eb','customer')).makeupCredit as any;
 const used=await useMakeup(d.db,'a','f',credit.id,'dst',`cancel-${cancelledBy}`);
 vi.setSystemTime(new Date('2026-11-27T04:00:00Z'));
 if(cancelledBy==='admin'){
  const response=await gapCall(gapApp(d,[events]),`/api/events/admin/events/lesson/bookings/${used.bookingId}/cancel?account_id=a`,'POST',{});
  expect(response.status,await response.clone().text()).toBe(200);
 }else d.raw.prepare("UPDATE event_bookings SET status='cancelled',cancelled_by=? WHERE id=?").run(cancelledBy,used.bookingId);
 expect(d.raw.prepare('SELECT status,expires_at,used_event_booking_id FROM booking_makeup_credits WHERE id=?').get(credit.id)).toEqual({status:'open',expires_at:credit.expires_at,used_event_booking_id:null});
});

test.each(['sequential','concurrent'] as const)('欠席を2回送っても振替券は1件（%s）',async mode=>{
 d.raw.exec("UPDATE line_accounts SET login_channel_id='login' WHERE id='a'");
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({sub:'Uf'}),{status:200})));
 const a=gapApp(d,[bookingMakeup]);
 const request=()=>a.request('/api/liff/events/bookings/eb/absence?liffId=liff-a',{method:'POST',headers:{Authorization:'Bearer fixture','Idempotency-Key':'same-absence','Content-Type':'application/json'},body:'{}'});
 const responses=mode==='sequential'?[await request(),await request()]:await Promise.all([request(),request()]);
 expect(responses.map(r=>r.status)).toEqual([200,200]);
 expect(d.raw.prepare('SELECT COUNT(*) n FROM booking_makeup_credits').get()).toEqual({n:1});
 expect(d.raw.prepare("SELECT absence_reported_at IS NOT NULL AS absent FROM event_bookings WHERE id='eb'").get()).toEqual({absent:1});
});

test('B3-10 B3-11: 管理者だけが理由付きで延長し、古い版は上書きできない',async()=>{
 const credit=(await absence(d.db,'a','f','eb','customer')).makeupCredit as {id:string;expires_at:string;version:number};
 const url=`/api/booking/admin/makeup-credits/${credit.id}/operations?account_id=a`;
 const body={operation:'extend',expiresAt:'2027-01-20T05:00:00Z',expectedVersion:credit.version,reason:'休講'};
 for(const [who,im] of [[{...gapOwner,role:'staff' as const},false],[{...gapOwner,readOnly:true},false],[gapOwner,true]] as const) expect((await gapCall(gapApp(d,[bookingMakeup],who,im),url,'POST',body)).status).toBe(403);
 expect((await gapCall(gapApp(d,[bookingMakeup]),url,'POST',{...body,reason:'  '})).status).toBe(400);
 expect((await gapCall(gapApp(d,[bookingMakeup]),url,'POST',{...body,expiresAt:credit.expires_at})).status).toBe(400);
 expect((await gapCall(gapApp(d,[bookingMakeup]),url.replace('=a','=b'),'POST',body)).status).toBe(404);
 expect((await gapCall(gapApp(d,[bookingMakeup]),url,'POST',body)).status).toBe(200);
 expect((await gapCall(gapApp(d,[bookingMakeup]),url,'POST',{...body,expiresAt:'2027-02-20T05:00:00Z'})).status).toBe(409);
 expect(d.raw.prepare('SELECT expires_at,version FROM booking_makeup_credits WHERE id=?').get(credit.id)).toEqual({expires_at:'2027-01-20T05:00:00.000Z',version:credit.version+1});
 expect(d.raw.prepare("SELECT reason,actor_principal_id FROM audit_events WHERE action='makeup.extend'").all()).toEqual([{reason:'休講',actor_principal_id:'o'}]);
});

test('B3-04: 満席なら券を保ち、予約可能な近い3回を返す',async()=>{
 const credit=(await absence(d.db,'a','f','eb','customer')).makeupCredit as {id:string};
 d.raw.exec(`INSERT INTO event_slots(id,event_id,starts_at,ends_at,capacity) VALUES
 ('n1','lesson','2026-11-26T05:00:00Z','2026-11-26T06:00:00Z',1),('n2','lesson','2026-11-28T05:00:00Z','2026-11-28T06:00:00Z',1),('n3','lesson','2026-11-29T05:00:00Z','2026-11-29T06:00:00Z',1),('n4','lesson','2026-11-30T05:00:00Z','2026-11-30T06:00:00Z',1);
 INSERT INTO event_bookings(id,line_account_id,event_id,slot_id,friend_id,status,requested_at,identity_key) VALUES('full','a','lesson','dst','f2','confirmed','2026-11-16','solo:f2');`);
 try {await useMakeup(d.db,'a','f',credit.id,'dst','new');throw Error('expected conflict');}catch(error){expect(error).toMatchObject({code:'makeup_slot_unavailable',status:409,alternatives:[{id:'n1'},{id:'n2'},{id:'n3'}]});}
 expect(d.raw.prepare('SELECT status FROM booking_makeup_credits WHERE id=?').get(credit.id)).toEqual({status:'open'});
});
