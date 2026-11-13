import {beforeEach,afterEach,test,expect,vi} from 'vitest';
import {gapFixture,gapApp,gapCall,gapOwner} from '../test-utils/gap1.js';
import {bookingGap3} from './booking-gap3.js';
import booking from './booking.js';
import {depositEstimate} from '../features/booking/booking-deposit.js';
let d:ReturnType<typeof gapFixture>;
beforeEach(()=>{d=gapFixture();d.raw.exec("UPDATE menus SET max_party_size=6,customer_recurring_enabled=1,recurring_freqs_json='[\"weekly\"]',recurring_max_count=12; UPDATE booking_settings SET max_active_bookings_per_friend=52,approval_mode='automatic'; INSERT INTO staff_menus(staff_id,menu_id,is_offered) VALUES('bs2','menu',1)");for(const s of ['bs','bs2'])for(const date of ['2026-11-20','2026-11-27','2026-12-04'])d.raw.prepare("INSERT INTO staff_shifts(id,staff_id,work_date,start_time,end_time) VALUES(?,?,?,'09:00','18:00')").run(s+date,s,date);vi.stubGlobal('fetch',vi.fn(()=>{throw new Error('external_forbidden');}));});
afterEach(()=>{d.raw.close();vi.unstubAllGlobals();});
const app=()=>gapApp(d,[booking,bookingGap3]);
const input={friendId:'f',members:[{menuId:'menu',staffId:'bs'},{menuId:'menu',staffId:'bs2'}],starts_at:'2026-11-20T05:00:00.000Z',startMode:'parallel'};
test('B5-04/06/08/14: 組は別の担当に同時・二重送信でも一組・人ごとに読める',async()=>{
 const r=await gapCall(app(),'/api/booking/admin/groups?account_id=a','POST',input,'group');const body=await r.json() as any;expect(r.status,JSON.stringify(body)).toBe(201);
 expect(body.data.bookings).toHaveLength(2);expect(body.data.total).toBe(16800);expect((await gapCall(app(),'/api/booking/admin/groups?account_id=a','POST',input,'group')).status).toBe(201);
 expect(d.raw.prepare('SELECT count(*) n FROM bookings').get()).toEqual({n:2});expect((await gapCall(app(),`/api/booking/admin/bookings/${body.data.bookings[0].id}/group?account_id=a`)).status).toBe(200);expect(fetch).not.toHaveBeenCalled();
});
test('B5-07: 2人目の競合で1人目も組も残さない',async()=>{
 d.raw.exec("CREATE TRIGGER force_group_conflict BEFORE INSERT ON bookings WHEN NEW.group_index=1 BEGIN SELECT RAISE(ABORT,'CHECK constraint failed: concurrent'); END;");
 const r=await gapCall(app(),'/api/booking/admin/groups?account_id=a','POST',input);expect(r.status).toBe(409);expect(d.raw.prepare('SELECT count(*) n FROM bookings').get()).toEqual({n:0});expect(d.raw.prepare('SELECT count(*) n FROM booking_groups').get()).toEqual({n:0});
});
test('B5-05/15: 同じ担当は続けて、閲覧・代理は作らない',async()=>{
 const r=await gapCall(app(),'/api/booking/admin/groups?account_id=a','POST',{...input,members:[{menuId:'menu',staffId:'bs'},{menuId:'menu',staffId:'bs'}],startMode:'sequential'});expect(r.status,JSON.stringify(await r.clone().json())).toBe(201);
 const data=(await r.json() as any).data;expect(data.bookings[0].ends_at).toBe(data.bookings[1].starts_at);
 for(const [s,im]of [[{...gapOwner,readOnly:true},false],[gapOwner,true]]as const)expect((await gapCall(gapApp(d,[bookingGap3],s,im),'/api/booking/admin/groups?account_id=a','POST',input)).status).toBe(403);
});
test('B1-16: デポジットの条件をすべて満たすと8400の30%=2520、店の時刻で判定・上書きと409',async()=>{
 const b={kind:'percent',value:30,conditions:{always:false,minPeople:2,weekdays:[5],timeBand:'13:00-18:00'},expectedVersion:0};
 expect((await gapCall(app(),'/api/booking/admin/deposit-rules?account_id=a','PUT',b)).status).toBe(200);
 expect((await depositEstimate(d.db,'a','menu',8400,input.starts_at,2)).amount).toBe(2520);expect((await depositEstimate(d.db,'a','menu',8400,input.starts_at,1)).amount).toBe(0);
 expect((await gapCall(app(),'/api/booking/admin/deposit-rules?account_id=a','PUT',b)).status).toBe(409);
 expect((await gapCall(gapApp(d,[bookingGap3],gapOwner,true),'/api/booking/admin/deposit-rules?account_id=a','PUT',b)).status).toBe(403);
});

test('B2-03/B5-14: 券が必須の組は未選択を400で伝え、予約を一部だけ残さない',async()=>{
 d.raw.exec(`INSERT INTO booking_pass_plans(id,line_account_id,kind,name,price,count,valid_days,target_scope_json,allow_without_pass,status,created_by,created_at,idempotency_key,request_json) VALUES('plan','a','ticket','券',1000,5,180,'["menu"]',0,'on_sale','o','now','plan','{}')`);
 const r=await gapCall(app(),'/api/booking/admin/groups?account_id=a','POST',input);expect(r.status).toBe(400);expect(await r.json()).toMatchObject({error:'pass_required'});expect(d.raw.prepare('SELECT count(*) n FROM bookings').get()).toEqual({n:0});
});

test('確認した組の予約集合と各版が変わったら一件も取り消さない',async()=>{
 const created=await gapCall(app(),'/api/booking/admin/groups?account_id=a','POST',input,'group-check');
 const data=(await created.json() as any).data;expect(created.status).toBe(201);
 const viewResponse=await gapCall(app(),`/api/booking/admin/bookings/${data.bookings[0].id}/group?account_id=a`);
 const view=(await viewResponse.json() as any).data;
 const expectedMembers=view.members.map((m:any)=>({bookingId:m.bookingId,version:m.version,status:m.status}));
 expect(expectedMembers).toHaveLength(2);expect(expectedMembers.every((m:any)=>Number.isInteger(m.version))).toBe(true);
 d.raw.prepare('UPDATE bookings SET lock_version=lock_version+1 WHERE id=?').run(expectedMembers[1].bookingId);
 const cancel=await gapCall(app(),`/api/booking/admin/groups/${view.groupId}/cancel?account_id=a`,'POST',{reason:'確認済み',expectedVersion:view.version,expectedMembers});
 expect(cancel.status).toBe(409);
 expect((await cancel.json() as any).data.members[1].version).toBe(expectedMembers[1].version+1);
 expect(d.raw.prepare("SELECT COUNT(*) n FROM bookings WHERE status='cancelled'").get()).toEqual({n:0});
 expect(d.raw.prepare('SELECT version FROM booking_groups WHERE id=?').get(view.groupId)).toEqual({version:view.version});
 expect(fetch).not.toHaveBeenCalled();
});

test('確認後に来店を記録して解除した予約も古い確認では組取消しない',async()=>{
 const created=await gapCall(app(),'/api/booking/admin/groups?account_id=a','POST',input,'group-aba');
 const data=(await created.json() as any).data;expect(created.status).toBe(201);
 const bookingId=data.bookings[0].id;
 const view=(await (await gapCall(app(),`/api/booking/admin/bookings/${bookingId}/group?account_id=a`)).json() as any).data;
 const expectedMembers=view.members.map((m:any)=>({bookingId:m.bookingId,version:m.version,status:m.status}));
 expect((await gapCall(app(),`/api/booking/admin/bookings/${bookingId}/visit?account_id=a`,'POST',{kind:'visited'})).status).toBe(200);
 expect((await gapCall(app(),`/api/booking/admin/bookings/${bookingId}/visit?account_id=a`,'DELETE')).status).toBe(200);
 const response=await gapCall(app(),`/api/booking/admin/groups/${view.groupId}/cancel?account_id=a`,'POST',{reason:'確認済み',expectedVersion:view.version,expectedMembers});
 expect(response.status).toBe(409);
 expect(d.raw.prepare("SELECT COUNT(*) n FROM bookings WHERE status='cancelled'").get()).toEqual({n:0});
 expect(fetch).not.toHaveBeenCalled();
});

test('組取消の書込み直前に予約の版が変わっても一件も取り消さない',async()=>{
 const created=await gapCall(app(),'/api/booking/admin/groups?account_id=a','POST',input,'group-race');
 const data=(await created.json() as any).data;expect(created.status).toBe(201);
 const view=(await (await gapCall(app(),`/api/booking/admin/bookings/${data.bookings[0].id}/group?account_id=a`)).json() as any).data;
 const expectedMembers=view.members.map((m:any)=>({bookingId:m.bookingId,version:m.version,status:m.status}));
 const batch=d.db.batch.bind(d.db);let raced=false;
 vi.spyOn(d.db,'batch').mockImplementation(async statements=>{
  if(!raced){raced=true;d.raw.prepare('UPDATE bookings SET lock_version=lock_version+1 WHERE id=?').run(expectedMembers[0].bookingId);}
  return batch(statements);
 });
 const res=await gapCall(app(),`/api/booking/admin/groups/${view.groupId}/cancel?account_id=a`,'POST',{reason:'確認済み',expectedVersion:view.version,expectedMembers});
 expect(raced).toBe(true);expect(res.status).toBe(409);
 expect(d.raw.prepare("SELECT COUNT(*) n FROM bookings WHERE status='cancelled'").get()).toEqual({n:0});expect(fetch).not.toHaveBeenCalled();
});

test('予約の集合が異なれば拒み、版情報なしの従来の呼び出しは受け付ける',async()=>{
 const created=await gapCall(app(),'/api/booking/admin/groups?account_id=a','POST',input,'group-old');
 const data=(await created.json() as any).data;const view=(await (await gapCall(app(),`/api/booking/admin/bookings/${data.bookings[0].id}/group?account_id=a`)).json() as any).data;
 const path=`/api/booking/admin/groups/${view.groupId}/cancel?account_id=a`;
 const partial=view.members.slice(0,1).map((m:any)=>({bookingId:m.bookingId,version:m.version,status:m.status}));
 expect((await gapCall(app(),path,'POST',{reason:'確認済み',expectedVersion:view.version,expectedMembers:partial})).status).toBe(409);
 expect(d.raw.prepare("SELECT COUNT(*) n FROM bookings WHERE status='cancelled'").get()).toEqual({n:0});
 expect((await gapCall(app(),path,'POST',{reason:'確認済み',expectedVersion:view.version})).status).toBe(200);
 expect(d.raw.prepare("SELECT COUNT(*) n FROM bookings WHERE status='cancelled'").get()).toEqual({n:2});expect(fetch).not.toHaveBeenCalled();
});

test('確認した予約集合と各版が一致すれば全件を取り消す',async()=>{
 const created=await gapCall(app(),'/api/booking/admin/groups?account_id=a','POST',input,'group-matching');
 const data=(await created.json() as any).data;const view=(await (await gapCall(app(),`/api/booking/admin/bookings/${data.bookings[0].id}/group?account_id=a`)).json() as any).data;
 const expectedMembers=view.members.map((m:any)=>({bookingId:m.bookingId,version:m.version,status:m.status}));
 const response=await gapCall(app(),`/api/booking/admin/groups/${view.groupId}/cancel?account_id=a`,'POST',{reason:'確認済み',expectedVersion:view.version,expectedMembers});
 expect(response.status).toBe(200);expect((await response.json() as any).data.cancelled).toBe(2);
 expect(d.raw.prepare("SELECT COUNT(*) n FROM bookings WHERE status='cancelled'").get()).toEqual({n:2});expect(fetch).not.toHaveBeenCalled();
});

test('個別予約の状態だけが変わった場合も組を取り消さない',async()=>{
 const created=await gapCall(app(),'/api/booking/admin/groups?account_id=a','POST',input,'group-status');
 const data=(await created.json() as any).data;const view=(await (await gapCall(app(),`/api/booking/admin/bookings/${data.bookings[0].id}/group?account_id=a`)).json() as any).data;
 const expectedMembers=view.members.map((m:any)=>({bookingId:m.bookingId,version:m.version,status:m.status}));
 d.raw.prepare("UPDATE bookings SET status='completed' WHERE id=?").run(expectedMembers[0].bookingId);
 const response=await gapCall(app(),`/api/booking/admin/groups/${view.groupId}/cancel?account_id=a`,'POST',{reason:'確認済み',expectedVersion:view.version,expectedMembers});
 expect(response.status).toBe(409);expect(d.raw.prepare("SELECT COUNT(*) n FROM bookings WHERE status='cancelled'").get()).toEqual({n:0});expect(fetch).not.toHaveBeenCalled();
});
