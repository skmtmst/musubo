import {afterEach,beforeEach,expect,test,vi} from 'vitest';
import {gapFixture,gapApp,gapCall,gapOwner,seedGapBooking} from '../test-utils/gap1.js';
import {bookingPassPlans} from './booking-pass-plans.js';
import {bookingEntitlements} from './booking-entitlements.js';
import {entitlementUseStatement,entitlementViews} from '../features/booking/booking-entitlements.js';
import {assertPassRequirement,passUnusable} from '../features/booking/booking-pass-plans.js';
let d:ReturnType<typeof gapFixture>;
beforeEach(()=>{d=gapFixture();vi.stubGlobal('fetch',vi.fn(()=>{throw new Error('external_forbidden');}));});
afterEach(()=>{d.raw.close();vi.unstubAllGlobals();});
const app=(s=gapOwner,im=false)=>gapApp(d,[bookingPassPlans,bookingEntitlements],s,im);
const plan={kind:'ticket',name:'5回券',price:20000,count:5,monthlyLimit:null,validDays:180,menuIds:['menu'],allowWithoutPass:false};
test('ページを送っても全体件数・順序・店の境界と既存の集計を保つ',async()=>{
 const insert=d.raw.prepare(`INSERT INTO booking_pass_plans
   (id,line_account_id,kind,name,price,count,valid_days,created_by,created_at,idempotency_key,request_json)
   VALUES (?,?,'ticket',?,20000,5,180,'o','2026-10-23T00:00:00Z',?,'{}')`);
 for(let i=0;i<21;i++){const id=`plan-${String(i).padStart(2,'0')}`;insert.run(id,'a','対象の券',id);}
 insert.run('foreign','b','他店の券','foreign');
 insert.run('not-matched','a','別の名前','not-matched');
 const first=await ok('/api/booking/admin/pass-plans?account_id=a&q=対象&limit=20');
 const second=await ok('/api/booking/admin/pass-plans?account_id=a&q=対象&limit=20&offset=20');
 expect(first.items.map((x:{id:string})=>x.id)).toEqual(Array.from({length:20},(_,i)=>`plan-${String(i).padStart(2,'0')}`));
 expect(second.items.map((x:{id:string})=>x.id)).toEqual(['plan-20']);
 for(const page of [first,second]){
   expect(page).toMatchObject({total:21,limit:20,sort:[{field:'created_at',direction:'desc'},{field:'id',direction:'asc'}]});
   expect(page.summary).toEqual(first.summary);
   expect(page.items.every((x:{name:string})=>x.name==='対象の券')).toBe(true);
 }
 const empty=await ok('/api/booking/admin/pass-plans?account_id=a&q=対象&limit=20&offset=40');
 expect(empty).toMatchObject({items:[],total:21,limit:20});
 const noMatches=await ok('/api/booking/admin/pass-plans?account_id=a&q=該当なし&limit=10');
 expect(noMatches).toMatchObject({items:[],total:0,limit:10});
 expect((await gapCall(app(),'/api/booking/admin/pass-plans?account_id=b&limit=20&offset=20')).status).toBe(404);
 expect((await gapCall(app(),'/api/booking/admin/pass-plans?account_id=a&limit=7')).status).toBe(400);
 expect(fetch).not.toHaveBeenCalled();
});
test('種類で全件を絞ってからページと件数を返し、店の境界と入力を守る',async()=>{
 const insert=d.raw.prepare(`INSERT INTO booking_pass_plans
   (id,line_account_id,kind,name,price,count,valid_days,created_by,created_at,idempotency_key,request_json)
   VALUES (?,?,?,?,20000,CASE WHEN ?='ticket' THEN 5 ELSE NULL END,180,'o','2026-10-23T00:00:00Z',?,'{}')`);
 for(let i=0;i<24;i++){const id=`plan-${String(i).padStart(2,'0')}`;const kind=i%2?'monthly':'ticket';insert.run(id,'a',kind,'対象の券',kind,id);}
 insert.run('foreign','b','monthly','対象の券','monthly','foreign');
 const base='/api/booking/admin/pass-plans?account_id=a&q=対象&kind=monthly&limit=10';
 const first=await ok(base),second=await ok(`${base}&offset=10`);
 expect(first.total).toBe(12);expect(second.total).toBe(12);
 expect(first.items.map((x:{id:string})=>x.id)).toEqual(Array.from({length:10},(_,i)=>`plan-${String(i*2+1).padStart(2,'0')}`));
 expect(second.items.map((x:{id:string})=>x.id)).toEqual(['plan-21','plan-23']);
 expect((await ok(`${base}&status=on_sale`)).total).toBe(0);
 expect((await ok('/api/booking/admin/pass-plans?account_id=a&kind=ticket&limit=10')).total).toBe(12);
 expect((await ok('/api/booking/admin/pass-plans?account_id=a&limit=10')).total).toBe(24);
 expect((await gapCall(app(),'/api/booking/admin/pass-plans?account_id=a&kind=other')).status).toBe(400);
 expect((await gapCall(app(),'/api/booking/admin/pass-plans?account_id=b&kind=monthly')).status).toBe(404);
 expect(fetch).not.toHaveBeenCalled();
});
async function ok(path:string,method='GET',b?:unknown,key='same'){const r=await gapCall(app(),path,method,b,key);const body=await r.json() as any;expect(r.status,JSON.stringify(body)).toBeLessThan(300);return body.data;}
async function issue(kind='ticket'){
 const p=await ok('/api/booking/admin/pass-plans?account_id=a','POST',kind==='ticket'?plan:{...plan,kind:'monthly',count:null,monthlyLimit:2});
 await ok(`/api/booking/admin/pass-plans/${p.id}/start?account_id=a`,'POST',{expectedVersion:1});
 const grant=await ok('/api/booking/admin/entitlements?account_id=a','POST',{planId:p.id,friendId:'f',reason:'店頭で受け取り',validFrom:'2026-01-01T00:00:00Z'},'grant');return {p,e:grant};
}
test('B2-01/02/05/06/07/08: 種類・版・販売停止と手動付与、再送しても一枚・履歴は残す',async()=>{
 const {p,e}=await issue();expect(e.remaining).toBe(5);expect(d.raw.prepare('SELECT plan_id FROM booking_entitlements').get()).toEqual({plan_id:p.id});
 await ok('/api/booking/admin/entitlements?account_id=a','POST',{planId:p.id,friendId:'f',reason:'店頭で受け取り',validFrom:'2026-01-01T00:00:00Z'},'grant');expect(d.raw.prepare('SELECT count(*) n FROM booking_entitlements').get()).toEqual({n:1});
 expect((await gapCall(app(),`/api/booking/admin/pass-plans/${p.id}?account_id=a`,'PUT',{...plan,expectedVersion:1})).status).toBe(409);
 await ok(`/api/booking/admin/pass-plans/${p.id}/stop?account_id=a`,'POST',{expectedVersion:2});
 expect((await gapCall(app(),'/api/booking/admin/entitlements?account_id=a','POST',{planId:p.id,friendId:'f',reason:'停止後'},'other')).status).toBe(409);
 expect(d.raw.prepare('SELECT status FROM booking_entitlements').get()).toEqual({status:'active'});expect((await ok('/api/booking/admin/pass-plans?account_id=a')).total).toBe(1);expect(fetch).not.toHaveBeenCalled();
});
test('B2-03/04/09: 閲覧・代理・別店・使えないメニューを拒否、券が必須なら持たずに通せない',async()=>{
 const {e}=await issue();for(const [s,im]of [[{...gapOwner,readOnly:true},false],[gapOwner,true]]as const)expect((await gapCall(app(s,im),'/api/booking/admin/pass-plans?account_id=a','POST',plan)).status).toBe(403);
 expect((await gapCall(app(),'/api/booking/admin/pass-plans?account_id=b')).status).toBe(404);
 await expect(assertPassRequirement(d.db,'a','menu',undefined)).rejects.toThrow('pass_required');
 const view=(await entitlementViews(d.db,'a','f','2026-02-01T00:00:00Z'))[0];expect(await passUnusable(d.db,view,'a','other','2026-02-01T00:00:00Z')).toBe('menu_out_of_scope');
 d.raw.prepare("UPDATE booking_entitlements SET billing_status='stopped' WHERE id=?").run(e.id);expect(await passUnusable(d.db,view,'a','menu','2026-02-01T00:00:00Z')).toBe('billing_stopped');
});
test('B2-10/15/16/17: 確定で1回、期限内取消で1回だけ戻り、期限後と無断は戻らない',async()=>{
 const {e}=await issue();for(const id of ['cancel','late','no_show']){seedGapBooking(d,id,'requested','2026-02-10T01:00:00Z');await entitlementUseStatement(d.db,id,e.id,'2026-02-10T01:00:00Z','Asia/Tokyo').run();d.raw.prepare("UPDATE bookings SET status='confirmed' WHERE id=?").run(id);}
 expect(d.raw.prepare('SELECT remaining FROM booking_entitlements').get()).toEqual({remaining:2});
 d.raw.exec("UPDATE bookings SET status='cancelled',decided_at='2026-02-08T00:00:00Z' WHERE id='cancel'; UPDATE bookings SET status='cancelled',decided_at='2026-02-08T00:00:00Z' WHERE id='cancel'; UPDATE bookings SET status='cancelled',decided_at='2026-02-10T00:59:00Z' WHERE id='late'; UPDATE bookings SET status='no_show' WHERE id='no_show'");
 expect(d.raw.prepare('SELECT remaining FROM booking_entitlements').get()).toEqual({remaining:3});expect(d.raw.prepare("SELECT count(*) n FROM booking_entitlement_events WHERE reason='取消で戻した'").get()).toEqual({n:1});
});
test('B2-11/12/15: 月謝も期限内取消の利用を戻し、同時の最後の枠は1件だけ',async()=>{
 const {e}=await issue('monthly');for(const id of ['b1','b2','b3']){seedGapBooking(d,id,'requested','2026-02-10T01:00:00Z');await entitlementUseStatement(d.db,id,e.id,'2026-02-10T01:00:00Z','Asia/Tokyo').run();}
 d.raw.exec("UPDATE bookings SET status='confirmed' WHERE id='b1';UPDATE bookings SET status='confirmed' WHERE id='b2'");expect(()=>d.raw.exec("UPDATE bookings SET status='confirmed' WHERE id='b3'")).toThrow('entitlement_unavailable');
 d.raw.exec("UPDATE bookings SET status='cancelled',decided_at='2026-02-08T00:00:00Z' WHERE id='b1';UPDATE bookings SET status='confirmed' WHERE id='b3'");
 expect((await entitlementViews(d.db,'a','f','2026-02-01T00:00:00Z'))[0].monthRemaining).toBe(0);
});
