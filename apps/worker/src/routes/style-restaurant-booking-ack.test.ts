import {Hono} from 'hono';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {createStyleScheduleFixture} from '../test-utils/style-schedule-fixture.js';
import type {Env} from '../worker-env.js';
import {styles} from './styles.js';
vi.mock('../services/account-access.js',()=>({canAccessAllLineAccounts:async(_db:unknown,_staff:unknown,ids:string[])=>ids.every(id=>id==='a')}));
vi.mock('../services/tenant-features.js',async original=>({...await original<Record<string,unknown>>(),restaurantEffectivelyEnabledForAccount:async()=>true}));
let f:ReturnType<typeof createStyleScheduleFixture>,app:Hono<Env>;
let actor={id:'owner',name:'店長',role:'owner',readOnly:false,tenantId:'tenant',permissionKeys:[] as string[],viewPermissionKeys:[] as string[]};
const root='/api/dashboard/style/new-bookings/acknowledgements';
const id='00000000-0000-4000-8000-000000000001';
const post=(path:string,body:unknown)=>app.request(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)},{DB:f.db} as Env['Bindings']);
beforeEach(()=>{f=createStyleScheduleFixture();actor={id:'owner',name:'店長',role:'owner',readOnly:false,tenantId:'tenant',permissionKeys:[],viewPermissionKeys:[]};
 app=new Hono<Env>();app.use('*',async(c,next)=>{c.set('staff',actor as Env['Variables']['staff']);await next()});app.route('/',styles);
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-11-01T03:00:00Z'));f.raw.exec("UPDATE rt_reservations SET created_at='2026-11-01 00:00:00' WHERE id='r'");});
afterEach(()=>{f.raw.close();vi.useRealTimers()});
it('単件を登録して同じ操作を戻す',async()=>{
 const a=await post(root+'?account_id=a',{storeId:'store',operationId:id,bookingId:'r'});expect(a.status).toBe(200);
 expect(await a.json()).toMatchObject({success:true,data:{acknowledgedCount:1}});
 const b=await post(root+'/'+id+'/undo?account_id=a',{storeId:'store'});expect(b.status).toBe(200);
 expect(await b.json()).toMatchObject({success:true,data:{undoneCount:1}});
});
it('閲覧のみは確認も取消もできない',async()=>{
 actor.readOnly=true;
 expect((await post(root+'?account_id=a',{storeId:'store',operationId:id,bookingId:null})).status).toBe(403);
 expect((await post(root+'/'+id+'/undo?account_id=a',{storeId:'store'})).status).toBe(403);
 expect(f.raw.prepare('SELECT COUNT(*) n FROM restaurant_booking_ack_operations').get()).toEqual({n:0});
});
it('別のアカウントや店舗を指定すると404となる',async()=>{
 expect((await post(root+'?account_id=b',{storeId:'foreign-store',operationId:id,bookingId:null})).status).toBe(404);
 expect((await post(root+'?account_id=a',{storeId:'foreign-store',operationId:id,bookingId:null})).status).toBe(404);
});
it('担当者は予約の書き込み権限がある場合だけ操作できる',async()=>{
 actor.role='staff';actor.viewPermissionKeys=['/restaurant-test/reservations'];
 expect((await post(root+'?account_id=a',{storeId:'store',operationId:id,bookingId:'r'})).status).toBe(403);
 actor.permissionKeys=['/restaurant-test/reservations'];
 expect((await post(root+'?account_id=a',{storeId:'store',operationId:id,bookingId:'r'})).status).toBe(200);
});
