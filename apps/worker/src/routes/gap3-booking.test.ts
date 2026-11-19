import { useSqliteClock } from '../test-utils/sqlite-clock.js';
import {beforeEach,afterEach,test,expect,vi} from 'vitest';
import {gapFixture,gapApp,gapCall,gapOwner,seedGapBooking} from '../test-utils/gap1.js';
import {bookingGap3} from './booking-gap3.js';
import booking from './booking.js';
import {depositEstimate} from '../features/booking/booking-deposit.js';
let d:ReturnType<typeof gapFixture>;
beforeEach(()=>{vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-11-16T00:00:00Z'));d=gapFixture();useSqliteClock(d.raw,()=>new Date());d.raw.exec("UPDATE menus SET max_party_size=6,customer_recurring_enabled=1,recurring_freqs_json='[\"weekly\"]',recurring_max_count=12; UPDATE booking_settings SET max_active_bookings_per_friend=52,approval_mode='automatic'; INSERT INTO staff_menus(staff_id,menu_id,is_offered) VALUES('bs2','menu',1)");for(const s of ['bs','bs2'])for(const date of ['2026-11-20','2026-11-27','2026-12-04'])d.raw.prepare("INSERT INTO staff_shifts(id,staff_id,work_date,start_time,end_time) VALUES(?,?,?,'09:00','18:00')").run(s+date,s,date);vi.stubGlobal('fetch',vi.fn(()=>{throw new Error('external_forbidden');}));});
afterEach(()=>{d.raw.close();vi.useRealTimers();vi.unstubAllGlobals();});
const app=()=>gapApp(d,[booking,bookingGap3]);
const input={friendId:'f',members:[{menuId:'menu',staffId:'bs'},{menuId:'menu',staffId:'bs2'}],starts_at:'2026-11-20T05:00:00.000Z',startMode:'parallel'};
test('B5-04/06/08/14: 組は別の担当に同時・二重送信でも一組・人ごとに読める',async()=>{
 const r=await gapCall(app(),'/api/booking/admin/groups?account_id=a','POST',input,'group');const body=await r.json() as any;expect(r.status,JSON.stringify(body)).toBe(201);
 expect(body.data.bookings).toHaveLength(2);expect(body.data.total).toBe(16800);expect((await gapCall(app(),'/api/booking/admin/groups?account_id=a','POST',input,'group')).status).toBe(201);
 expect(d.raw.prepare('SELECT count(*) n FROM bookings').get()).toEqual({n:2});expect((await gapCall(app(),`/api/booking/admin/bookings/${body.data.bookings[0].id}/group?account_id=a`)).status).toBe(200);expect(fetch).not.toHaveBeenCalled();
});
test('B5-07: 2人目の競合で1人目も組も残さない',async()=>{
 d.raw.exec("CREATE TRIGGER force_group_conflict BEFORE INSERT ON bookings WHEN NEW.group_index=1 BEGIN SELECT RAISE(ABORT,'CHECK constraint failed: concurrent'); END;");
 const r=await gapCall(app(),'/api/booking/admin/groups?account_id=a','POST',input);expect(r.status).toBe(409);expect((await r.json() as {alternatives:string[]}).alternatives).toHaveLength(3);expect(d.raw.prepare('SELECT count(*) n FROM bookings').get()).toEqual({n:0});expect(d.raw.prepare('SELECT count(*) n FROM booking_groups').get()).toEqual({n:0});
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

test('B5-04: 同時の組では片方の担当が埋まった時刻を候補にしない',async()=>{
 const {partyInput,previewParty}=await import('../features/booking/booking-bulk.js');
 const members=await partyInput(d.db,'a','f',[{menuId:'menu'},{menuId:'menu'}]);
 const before=await previewParty(d.db,'a',members,'parallel','2026-11-20','2026-11-20',{});
 expect(before.slots.some(s=>Date.parse(s.startsAt)===Date.parse('2026-11-20T05:00:00Z'))).toBe(true);
 d.raw.exec("INSERT INTO bookings(id,line_account_id,friend_id,staff_id,menu_id,starts_at,ends_at,block_ends_at,status,price_at_booking,requested_at) VALUES('busy','a','f2','bs2','menu','2026-11-20T05:00:00.000Z','2026-11-20T06:00:00.000Z','2026-11-20T06:00:00.000Z','confirmed',8400,'2026-11-16T00:00:00Z')");
 const result=await previewParty(d.db,'a',members,'parallel','2026-11-20','2026-11-20',{});
 expect(result.slots.some(s=>Date.parse(s.startsAt)===Date.parse('2026-11-20T05:00:00Z'))).toBe(false);
});

function seedGroupAddon(){
 d.raw.exec(`UPDATE menus SET base_price=5000,addon_menu_ids_json='["spa"]' WHERE id='menu';
 INSERT INTO menus(id,line_account_id,name,duration_minutes,base_price,addon_only) VALUES('spa','a','ヘッドスパ',15,2500,1)`);
}
test('B5-02: 2人分と1人目の追加メニューの料金を合算する',async()=>{
 seedGroupAddon();
 const members=[{menuId:'menu',staffId:'bs',addonIds:['spa']},{menuId:'menu',staffId:'bs2'}];
 const r=await gapCall(app(),'/api/booking/admin/groups?account_id=a','POST',{...input,members});
 expect(r.status,await r.clone().text()).toBe(201);
 const data=(await r.json() as any).data;expect(data.total).toBe(12500);
 expect(data.bookings.map((b:any)=>b.price_at_booking)).toEqual([7500,5000]);
});
test('B5-05: 追加15分を含む同じ担当の75分と60分を続ける',async()=>{
 seedGroupAddon();
 const members=[{menuId:'menu',staffId:'bs',addonIds:['spa']},{menuId:'menu',staffId:'bs'}];
 const r=await gapCall(app(),'/api/booking/admin/groups?account_id=a','POST',{...input,members,startMode:'sequential'});
 expect(r.status,await r.clone().text()).toBe(201);
 const rows=(await r.json() as any).data.bookings;
 expect(rows.map((b:any)=>b.staff_id)).toEqual(['bs','bs']);
 expect(rows.map((b:any)=>[new Date(b.starts_at).toISOString(),new Date(b.ends_at).toISOString()])).toEqual([['2026-11-20T05:00:00.000Z','2026-11-20T06:15:00.000Z'],['2026-11-20T06:15:00.000Z','2026-11-20T07:15:00.000Z']]);
});
test('B5-06: 指名なしの2人には重ならない別々の担当を割り当てる',async()=>{
 const members=[{menuId:'menu'},{menuId:'menu'}];
 const r=await gapCall(app(),'/api/booking/admin/groups?account_id=a','POST',{...input,members});
 expect(r.status,await r.clone().text()).toBe(201);
 const rows=(await r.json() as any).data.bookings;
 expect(rows).toHaveLength(2);expect(new Set(rows.map((b:any)=>b.staff_id))).toEqual(new Set(['bs','bs2']));
 expect(rows.map((b:any)=>new Date(b.starts_at).toISOString())).toEqual([input.starts_at,input.starts_at]);
});
test('B5-08: 同じキーでの組予約再送は同じ組と2人を返す',async()=>{
 const first=await gapCall(app(),'/api/booking/admin/groups?account_id=a','POST',input,'retry-group');
 const second=await gapCall(app(),'/api/booking/admin/groups?account_id=a','POST',input,'retry-group');
 expect(first.status).toBe(201);expect(second.status).toBe(201);
 const a=(await first.json() as any).data,b=(await second.json() as any).data;
 expect(b.groupId).toBe(a.groupId);expect(b.replayed).toBe(true);
 expect(d.raw.prepare('SELECT count(*) n FROM booking_groups').get()).toEqual({n:1});
 expect(d.raw.prepare('SELECT count(*) n FROM bookings').get()).toEqual({n:2});
});
test('B5-16: 人数上限を1に下げても既存の組は残り新しい組は拒否する',async()=>{
 const first=await gapCall(app(),'/api/booking/admin/groups?account_id=a','POST',input,'old-group');expect(first.status).toBe(201);
 const groupId=(await first.json() as any).data.groupId;
 const saved=await gapCall(app(),'/api/booking/admin/menus/menu?account_id=a','PUT',{name:'相談',duration_minutes:60,base_price:8400,expectedVersion:1,maxPartySize:1});
 expect(saved.status,await saved.clone().text()).toBe(200);
 const next=await gapCall(app(),'/api/booking/admin/groups?account_id=a','POST',{...input,starts_at:'2026-11-27T05:00:00.000Z'},'new-group');
 expect(next.status).toBe(400);expect(await next.json()).toMatchObject({error:'party_size_not_allowed'});
 expect(d.raw.prepare('SELECT count(*) n FROM booking_groups WHERE id=?').get(groupId)).toEqual({n:1});
 expect(d.raw.prepare('SELECT count(*) n FROM bookings WHERE group_id=? AND status=\'confirmed\'').get(groupId)).toEqual({n:2});
});

test('G4-19: 来店を2回押しても印と状態の変更は一度だけ',async()=>{
 const created=await gapCall(app(),'/api/booking/admin/groups?account_id=a','POST',input,'visit-once');
 const bookingId=(await created.json() as any).data.bookings[0].id;expect(created.status).toBe(201);
 vi.setSystemTime(new Date('2026-11-20T05:00:00Z'));
 const path=`/api/booking/admin/bookings/${bookingId}/visit?account_id=a`;
 const initial=d.raw.prepare('SELECT lock_version FROM bookings WHERE id=?').get(bookingId) as {lock_version:number};
 const first=await gapCall(app(),path,'POST',{kind:'visited'}),second=await gapCall(app(),path,'POST',{kind:'visited'});
 expect(first.status).toBe(200);expect([200,409]).toContain(second.status);
 expect(d.raw.prepare('SELECT COUNT(*) n FROM booking_visit_marks WHERE booking_id=?').get(bookingId)).toEqual({n:1});
 expect(d.raw.prepare('SELECT status,lock_version FROM bookings WHERE id=?').get(bookingId)).toEqual({status:'completed',lock_version:initial.lock_version+1});
});

test('B5-03: 人数を許さない2人目のメニューで組を作らない',async()=>{
 d.raw.exec("INSERT INTO menus(id,line_account_id,name,duration_minutes,base_price,max_party_size) VALUES('single','a','1人用',60,5000,1); INSERT INTO staff_menus(staff_id,menu_id,is_offered) VALUES('bs2','single',1)");
 const r=await gapCall(app(),'/api/booking/admin/groups?account_id=a','POST',{...input,members:[{menuId:'menu',staffId:'bs'},{menuId:'single',staffId:'bs2'}]});
 expect(r.status).toBe(400);expect(await r.json()).toMatchObject({error:'party_size_not_allowed'});
 expect(d.raw.prepare('SELECT COUNT(*) n FROM booking_groups').get()).toEqual({n:0});expect(d.raw.prepare('SELECT COUNT(*) n FROM bookings').get()).toEqual({n:0});
});
test('B5-14: 組の来店は人ごとに記録し、残りの人を変更しない',async()=>{
 const r=await gapCall(app(),'/api/booking/admin/groups?account_id=a','POST',input,'individual-visit');expect(r.status).toBe(201);
 const rows=(await r.json() as any).data.bookings;expect(rows).toHaveLength(2);
 expect((await gapCall(app(),`/api/booking/admin/bookings/${rows[0].id}/visit?account_id=a`,'POST',{kind:'visited'})).status).toBe(200);
 const view=await gapCall(app(),`/api/booking/admin/bookings/${rows[0].id}/group?account_id=a`);expect(view.status).toBe(200);
 expect((await view.json() as any).data.members.map((m:any)=>[m.bookingId,m.staffName,m.status])).toEqual([[rows[0].id,'担当','completed'],[rows[1].id,'別担当','confirmed']]);
});

test('B5-15: 閲覧のみは組の詳細を読めるが取消できない',async()=>{
 const made=await gapCall(app(),'/api/booking/admin/groups?account_id=a','POST',input,'readonly-group');expect(made.status).toBe(201);
 const data=(await made.json() as any).data;const a=gapApp(d,[booking,bookingGap3],{...gapOwner,readOnly:true});
 expect((await gapCall(a,`/api/booking/admin/bookings/${data.bookings[0].id}/group?account_id=a`)).status).toBe(200);
 const cancel=await gapCall(a,`/api/booking/admin/groups/${data.groupId}/cancel?account_id=a`,'POST',{reason:'取消',expectedVersion:1});
 expect(cancel.status).toBe(403);expect(d.raw.prepare("SELECT COUNT(*) n FROM bookings WHERE status='cancelled'").get()).toEqual({n:0});
});

function seedPartyPass(remaining:number){
 d.raw.exec(`INSERT INTO booking_pass_plans(id,line_account_id,kind,name,price,count,valid_days,target_scope_json,allow_without_pass,status,created_by,created_at,idempotency_key,request_json) VALUES('plan','a','ticket','券',1000,5,180,'["menu"]',1,'on_sale','o','2026-11-01','plan','{}');
 INSERT INTO booking_entitlements(id,line_account_id,friend_id,kind,name,remaining,valid_from,expires_at,created_at,updated_at,plan_id) VALUES('pass','a','f','ticket','券',${remaining},'2026-11-01T00:00:00Z','2026-12-31T00:00:00Z','2026-11-01','2026-11-01','plan')`);
}
test('B5-12: 1人目だけ券を使い2人目は店頭払いの組を作る',async()=>{
 seedPartyPass(2);
 const r=await gapCall(app(),'/api/booking/admin/groups?account_id=a','POST',{...input,entitlement_id:'pass'});expect(r.status,await r.clone().text()).toBe(201);
 const rows=(await r.json() as any).data.bookings;expect(rows).toHaveLength(2);
 expect(d.raw.prepare('SELECT booking_id FROM booking_entitlement_uses').all()).toEqual([{booking_id:rows[0].id}]);
 expect(d.raw.prepare("SELECT remaining FROM booking_entitlements WHERE id='pass'").get()).toEqual({remaining:1});
 expect(rows[1].price_at_booking).toBe(8400);
});
test('B5-12: 使い切った券で組を作らず2人目も残さない',async()=>{
 seedPartyPass(0);
 const r=await gapCall(app(),'/api/booking/admin/groups?account_id=a','POST',{...input,entitlement_id:'pass'});
 expect(r.status).toBe(409);expect(await r.json()).toMatchObject({error:'entitlement_unavailable'});expect(d.raw.prepare('SELECT COUNT(*) n FROM booking_groups').get()).toEqual({n:0});expect(d.raw.prepare('SELECT COUNT(*) n FROM bookings').get()).toEqual({n:0});
});
test('G4-21: 今日の予約は指定した担当だけを返す',async()=>{
 const made=await gapCall(app(),'/api/booking/admin/groups?account_id=a','POST',input,'my-today');expect(made.status).toBe(201);
 const rows=(await made.json() as any).data.bookings;
 vi.setSystemTime(new Date('2026-11-20T00:00:00Z'));
 const r=await gapCall(app(),'/api/booking/admin/today?account_id=a&staff_id=bs');expect(r.status).toBe(200);
 expect((await r.json() as any).bookings.map((b:any)=>b.id)).toEqual([rows[0].id]);
});

test('B5-14: 組の無断記録は本人だけに付き他の人を変えない',async()=>{
 const r=await gapCall(app(),'/api/booking/admin/groups?account_id=a','POST',input,'individual-noshow');expect(r.status).toBe(201);
 const rows=(await r.json() as any).data.bookings;
 expect((await gapCall(app(),`/api/booking/admin/bookings/${rows[1].id}/visit?account_id=a`,'POST',{kind:'no_show'})).status).toBe(200);
 const view=await gapCall(app(),`/api/booking/admin/bookings/${rows[0].id}/group?account_id=a`);
 expect((await view.json() as any).data.members.map((m:any)=>[m.bookingId,m.status])).toEqual([[rows[0].id,'confirmed'],[rows[1].id,'no_show']]);
 expect(d.raw.prepare('SELECT booking_id,kind FROM booking_visit_marks').all()).toEqual([{booking_id:rows[1].id,kind:'no_show'}]);
});
test('G4-21: 指定した担当に当日の予約がなければ空の一覧を返す',async()=>{
 const made=await gapCall(app(),'/api/booking/admin/groups?account_id=a','POST',input,'empty-today');expect(made.status).toBe(201);
 const rows=(await made.json() as any).data.bookings;
 d.raw.prepare("UPDATE bookings SET starts_at='2026-11-27T05:00:00.000Z',ends_at='2026-11-27T06:00:00.000Z',block_ends_at='2026-11-27T06:00:00.000Z' WHERE id=?").run(rows[1].id);
 vi.setSystemTime(new Date('2026-11-27T00:00:00Z'));
 const other=await gapCall(app(),'/api/booking/admin/today?account_id=a&staff_id=bs2');expect((await other.json() as any).bookings.map((b:any)=>b.id)).toEqual([rows[1].id]);
 const r=await gapCall(app(),'/api/booking/admin/today?account_id=a&staff_id=bs');expect(r.status).toBe(200);expect((await r.json() as any).bookings).toEqual([]);
});

test('B5-01: 人数上限1のメニューでは2人の予約を作れない',async()=>{
 d.raw.prepare("UPDATE menus SET max_party_size=1 WHERE id='menu'").run();
 const response=await gapCall(app(),'/api/booking/admin/groups?account_id=a','POST',input);
 expect(response.status).toBe(400);
 expect(await response.json()).toMatchObject({error:'party_size_not_allowed'});
 expect(d.raw.prepare('SELECT COUNT(*) n FROM bookings').get()).toEqual({n:0});
 expect(d.raw.prepare('SELECT COUNT(*) n FROM booking_groups').get()).toEqual({n:0});
});

test('B5-13: スタッフは2人分の予約を同じ組で作れる',async()=>{
 const staff={...gapOwner,id:'s',role:'staff' as const,permissionKeys:['/booking/bookings']};
 const response=await gapCall(gapApp(d,[booking,bookingGap3],staff),'/api/booking/admin/groups?account_id=a','POST',input);
 expect(response.status,await response.clone().text()).toBe(201);
 const data=(await response.json() as {data:{groupId:string;bookings:Array<{staff_id:string}>}}).data;
 expect(data.bookings.map(x=>x.staff_id)).toEqual(['bs','bs2']);
 expect(d.raw.prepare('SELECT COUNT(*) n FROM bookings WHERE group_id=?').get(data.groupId)).toEqual({n:2});
});


test('B5-07: 満席は組を作らず14日以内の近い3時刻を返す',async()=>{
 seedGapBooking(d,'occupied');d.raw.prepare("UPDATE bookings SET staff_id='bs2' WHERE id='occupied'").run();
 const prepare=d.db.prepare.bind(d.db);let queries=0;
 const spy=vi.spyOn(d.db,'prepare').mockImplementation(sql=>{queries++;return prepare(sql);});
 try {
  const response=await gapCall(app(),'/api/booking/admin/groups?account_id=a','POST',input);
  expect(response.status).toBe(409);
  const result=await response.json() as {alternatives:string[]};
  expect(result.alternatives).toHaveLength(3);
  expect(result.alternatives.every(x=>Date.parse(x)!==Date.parse(input.starts_at))).toBe(true);
  const distance=result.alternatives.map(x=>Math.abs(Date.parse(x)-Date.parse(input.starts_at)));
  expect(distance).toEqual([...distance].sort((a,b)=>a-b));
  expect(result.alternatives.every(x=>Date.parse(x)<=Date.parse(input.starts_at)+14*86400000)).toBe(true);
  expect(d.raw.prepare('SELECT COUNT(*) n FROM booking_groups').get()).toEqual({n:0});
  expect(d.raw.prepare('SELECT COUNT(*) n FROM bookings').get()).toEqual({n:1});
  const alternative=await gapCall(app(),'/api/booking/admin/groups?account_id=a','POST',{...input,starts_at:result.alternatives[0]});
  expect(alternative.status,await alternative.clone().text()).toBe(201);
  expect((await alternative.json() as {data:{bookings:unknown[]}}).data.bookings).toHaveLength(2);
  expect(d.raw.prepare('SELECT COUNT(*) n FROM booking_groups').get()).toEqual({n:1});
  expect(d.raw.prepare('SELECT COUNT(*) n FROM bookings').get()).toEqual({n:3});
  expect(queries).toBeLessThanOrEqual(1000);
 } finally {spy.mockRestore();}
});

test('B5-07: 店の受付期間より後を代替候補に出さない',async()=>{
 d.raw.prepare("UPDATE booking_settings SET booking_window_days=4 WHERE line_account_id='a'").run();
 for(const staff of ['bs','bs2'])d.raw.prepare("INSERT INTO staff_shifts(id,staff_id,work_date,start_time,end_time) VALUES(?,?, '2026-11-21','09:00','18:00')").run(`next-${staff}`,staff);
 seedGapBooking(d,'occupied');d.raw.prepare("UPDATE bookings SET staff_id='bs2',starts_at='2026-11-20T00:00:00.000Z',ends_at='2026-11-20T10:00:00.000Z',block_ends_at='2026-11-20T10:00:00.000Z' WHERE id='occupied'").run();
 const call=()=>gapCall(app(),'/api/booking/admin/groups?account_id=a','POST',input);
 const blocked=await call();expect(blocked.status).toBe(409);
 expect((await blocked.json() as {alternatives:string[]}).alternatives).toEqual([]);
 d.raw.prepare("UPDATE booking_settings SET booking_window_days=60 WHERE line_account_id='a'").run();
 const available=await call();expect(available.status).toBe(409);
 const candidates=(await available.json() as {alternatives:string[]}).alternatives;
 expect(candidates.length).toBeGreaterThan(0);expect(candidates.every(x=>x.slice(0,10)==='2026-11-21')).toBe(true);
});

test('B5-07: LIFFの組予約競合にも候補を返す',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({sub:'Uf'}))));
 seedGapBooking(d,'occupied');d.raw.prepare("UPDATE bookings SET staff_id='bs2' WHERE id='occupied'").run();
 const response=await app().request('/api/liff/booking/requests?liffId=liff-a',{method:'POST',headers:{Authorization:'Bearer token','Idempotency-Key':'group-conflict','Content-Type':'application/json'},body:JSON.stringify(input)},undefined,{waitUntil:()=>{},passThroughOnException:()=>{}} as any);
 expect(response.status,await response.clone().text()).toBe(409);
 expect((await response.json() as {alternatives:string[]}).alternatives).toHaveLength(3);
 expect(d.raw.prepare('SELECT COUNT(*) n FROM booking_groups').get()).toEqual({n:0});
});

test('B5-07: 指名なしで14日営業していても候補3つで探索を止める',async()=>{
 for(let i=1;i<=14;i++){
  const date=new Date(Date.parse('2026-11-20T00:00:00Z')+i*86400000).toISOString().slice(0,10);
  for(const staff of ['bs','bs2'])d.raw.prepare("INSERT OR IGNORE INTO staff_shifts(id,staff_id,work_date,start_time,end_time) VALUES(?,?,?,'09:00','18:00')").run(`stress-${staff}-${date}`,staff,date);
 }
 seedGapBooking(d,'occupied');
 const prepare=d.db.prepare.bind(d.db);let queries=0;const spy=vi.spyOn(d.db,'prepare').mockImplementation(sql=>{queries++;return prepare(sql);});
 try {
  const response=await gapCall(app(),'/api/booking/admin/groups?account_id=a','POST',{...input,members:[{menuId:'menu'},{menuId:'menu'}]});
  expect(response.status).toBe(409);expect((await response.json() as {alternatives:string[]}).alternatives).toHaveLength(3);
  expect(queries).toBeLessThanOrEqual(1000);
 } finally {spy.mockRestore();}
});

test('B5-07: 指名担当が14日埋まっている順番予約も問い合わせを1000回以内にする',async()=>{
 for(let i=0;i<=14;i++){
  const day=new Date(Date.parse('2026-11-20T00:00:00Z')+i*86400000).toISOString().slice(0,10);
  for(const staff of ['bs','bs2'])d.raw.prepare("INSERT OR IGNORE INTO staff_shifts(id,staff_id,work_date,start_time,end_time) VALUES(?,?,?,'09:00','18:00')").run(`seq-${staff}-${day}`,staff,day);
  seedGapBooking(d,`occupied-${i}`,'confirmed',`${day}T00:00:00.000Z`);
  d.raw.prepare("UPDATE bookings SET staff_id='bs2',ends_at=?,block_ends_at=? WHERE id=?").run(`${day}T10:00:00.000Z`,`${day}T10:00:00.000Z`,`occupied-${i}`);
 }
 const prepare=d.db.prepare.bind(d.db);let queries=0;const spy=vi.spyOn(d.db,'prepare').mockImplementation(sql=>{queries++;return prepare(sql);});
 try {
  const response=await gapCall(app(),'/api/booking/admin/groups?account_id=a','POST',{...input,startMode:'sequential',members:[{menuId:'menu'},{menuId:'menu',staffId:'bs2'}]});
  expect(response.status).toBe(409);expect((await response.json() as {alternatives:string[]}).alternatives).toEqual([]);
  expect(queries).toBeLessThanOrEqual(1000);
 } finally {spy.mockRestore();}
});


test('B5-07: 順番予約で指名担当が最終日だけ空いても問い合わせは1000回以内',async()=>{
 for(let i=0;i<=14;i++){
  const day=new Date(Date.parse('2026-11-20T00:00:00Z')+i*86400000).toISOString().slice(0,10);
  for(const staff of ['bs','bs2'])d.raw.prepare("INSERT OR IGNORE INTO staff_shifts(id,staff_id,work_date,start_time,end_time) VALUES(?,?,?,'09:00','18:00')").run(`last-${staff}-${day}`,staff,day);
  if(i<14){seedGapBooking(d,`busy-${i}`,'confirmed',`${day}T00:00:00.000Z`);d.raw.prepare("UPDATE bookings SET staff_id='bs2',ends_at=?,block_ends_at=? WHERE id=?").run(`${day}T10:00:00.000Z`,`${day}T10:00:00.000Z`,`busy-${i}`);}
 }
 const prepare=d.db.prepare.bind(d.db);let queries=0;const spy=vi.spyOn(d.db,'prepare').mockImplementation(sql=>{queries++;return prepare(sql);});
 try {
  const response=await gapCall(app(),'/api/booking/admin/groups?account_id=a','POST',{...input,startMode:'sequential',members:[{menuId:'menu'},{menuId:'menu',staffId:'bs2'}]});
  expect(response.status).toBe(409);expect((await response.json() as {alternatives:string[]}).alternatives).toHaveLength(3);expect(queries).toBeLessThanOrEqual(1000);
 } finally {spy.mockRestore();}
});

test('B5-07: 順番予約の刻みと片付け時間が合わなくても問い合わせを抑える',async()=>{
 d.raw.prepare("UPDATE menus SET buffer_after_minutes=10 WHERE id='menu'").run();
 for(let i=1;i<=14;i++){
  const day=new Date(Date.parse('2026-11-20T00:00:00Z')+i*86400000).toISOString().slice(0,10);
  for(const staff of ['bs','bs2'])d.raw.prepare("INSERT OR IGNORE INTO staff_shifts(id,staff_id,work_date,start_time,end_time) VALUES(?,?,?,'09:00','18:00')").run(`buffer-${staff}-${day}`,staff,day);
 }
 const prepare=d.db.prepare.bind(d.db);let queries=0;const spy=vi.spyOn(d.db,'prepare').mockImplementation(sql=>{queries++;return prepare(sql);});
 try {
  const response=await gapCall(app(),'/api/booking/admin/groups?account_id=a','POST',{...input,startMode:'sequential',members:[{menuId:'menu'},{menuId:'menu',staffId:'bs2'}]});
  expect(response.status).toBe(409);expect((await response.json() as {alternatives:string[]}).alternatives).toEqual([]);expect(queries).toBeLessThanOrEqual(1000);
 } finally {spy.mockRestore();}
});

test('B5-07: メニューごとに担当が違う順番予約は案内された候補で予約できる',async()=>{
 d.raw.exec("INSERT INTO menus(id,line_account_id,name,duration_minutes,base_price,max_party_size) VALUES('menu2','a','別メニュー',60,5000,6); INSERT INTO staff_menus(staff_id,menu_id,is_offered) VALUES('bs2','menu2',1)");
 seedGapBooking(d,'occupied');d.raw.prepare("UPDATE bookings SET staff_id='bs2' WHERE id='occupied'").run();
 const body={...input,startMode:'sequential',members:[{menuId:'menu'},{menuId:'menu2'}]};
 const conflict=await gapCall(app(),'/api/booking/admin/groups?account_id=a','POST',body);
 expect(conflict.status).toBe(409);
 const candidate=(await conflict.json() as {alternatives:string[]}).alternatives[0];expect(candidate).toBeTruthy();
 const retry=await gapCall(app(),'/api/booking/admin/groups?account_id=a','POST',{...body,starts_at:candidate});
 expect(retry.status,await retry.clone().text()).toBe(201);
 expect((await retry.json() as {data:{bookings:Array<{staff_id:string}>}}).data.bookings.map(x=>x.staff_id)).toEqual(['bs2','bs2']);
});
