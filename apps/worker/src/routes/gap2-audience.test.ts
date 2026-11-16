import { useSqliteClock } from '../test-utils/sqlite-clock.js';
import {beforeEach,afterEach,test,expect,vi} from 'vitest';
import booking from './booking.js';
import {gapFixture,gapApp,gapCall,gapOwner,seedGapBooking} from '../test-utils/gap1.js';
import {menuAudience} from '../features/booking/booking-audience.js';
import type {SqliteD1} from '../test-utils/d1-sqlite.js';
let d:SqliteD1;
const body={name:'相談',duration_minutes:60,base_price:5500,expectedVersion:1,audienceMode:'include_tags',audienceTagIds:['tag']};
const url='/api/booking/admin/menus/menu?account_id=a';
beforeEach(()=>{vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-11-16T00:00:00Z'));d=gapFixture();useSqliteClock(d.raw,()=>new Date());d.raw.exec("INSERT INTO tags(id,name,line_account_id) VALUES('tag','会員','a'); INSERT INTO friend_tags(friend_id,tag_id) VALUES('f','tag')");vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({sub:'Uf2'}))));});
afterEach(()=>{d.raw.close();vi.useRealTimers();vi.unstubAllGlobals();});
test('B9-01 B9-02 B9-03 B9-16: 保存・この人で見る・タグ一致・古い版409',async()=>{
 const a=gapApp(d,[booking]);expect((await gapCall(a,url,'PUT',body)).status).toBe(200);expect((await gapCall(a,url,'PUT',body)).status).toBe(409);
 expect(await menuAudience(d.db,'a','menu','f')).toEqual({visible:true,reason:null});
 const r=await gapCall(a,'/api/booking/admin/menus/preview-as?account_id=a&friend_id=f2');expect(r.status).toBe(200);expect(await r.json()).toMatchObject({data:[{visible:false,reason:'required_tag_missing'}]});
});
test('B9-04 B9-05 B9-06: 直APIで拒否し、除外タグ・保管タグも安全側',async()=>{
 await gapCall(gapApp(d,[booking]),url,'PUT',body);
 const r=await gapApp(d,[booking]).request('/api/liff/booking/requests?liffId=liff-a',{method:'POST',headers:{Authorization:'Bearer token','Content-Type':'application/json','Idempotency-Key':'direct'},body:JSON.stringify({menu_id:'menu',staff_id:'bs',starts_at:'2026-11-20T05:00:00Z'})});
 expect(r.status).toBe(403);expect(await r.json()).toMatchObject({error:'menu_not_available'});
 d.raw.exec("UPDATE menus SET audience_mode='exclude_tags'");expect((await menuAudience(d.db,'a','menu','f')).visible).toBe(false);
 d.raw.exec("UPDATE tags SET status='archived'");expect(await menuAudience(d.db,'a','menu','f2')).toEqual({visible:false,reason:'audience_tags_missing'});
 expect(d.raw.prepare('SELECT count(*) n FROM bookings').get()).toEqual({n:0});
});
test('B9-14 B9-15 Q-01: staff・閲覧のみ・代理の設定禁止。閲覧の見本は許可',async()=>{
 for(const [who,im] of [[{...gapOwner,id:'s',role:'staff' as const,permissionKeys:['/booking/menus'] as string[]},false],[{...gapOwner,readOnly:true},false],[gapOwner,true]] as const)expect((await gapCall(gapApp(d,[booking],who,im),url,'PUT',body)).status).toBe(403);
 expect((await gapCall(gapApp(d,[booking],{...gapOwner,readOnly:true}),'/api/booking/admin/menus/preview-as?account_id=a&friend_id=f')).status).toBe(200);
});
test('B9-11 B9-12 B9-13: 指名料の控えと担当変更の除去、取消計算の元',()=>{
 seedGapBooking(d);d.raw.exec("UPDATE bookings SET nominated=1,nomination_fee_at_booking=500,price_at_booking=6000 WHERE id='bk'; UPDATE staff SET nomination_fee=800 WHERE id='bs'");
 expect(d.raw.prepare("SELECT nomination_fee_at_booking FROM bookings WHERE id='bk'").get()).toEqual({nomination_fee_at_booking:500});
 d.raw.exec("UPDATE bookings SET staff_id='bs2' WHERE id='bk'");expect(d.raw.prepare("SELECT nominated,nomination_fee_at_booking,price_at_booking FROM bookings WHERE id='bk'").get()).toEqual({nominated:0,nomination_fee_at_booking:0,price_at_booking:5500});
});
test('B9-08 B9-09 B9-10: 実予約口でも指名だけ500円、指名なしは加算0',async()=>{
 const {saveBookingAutoAssign}=await import('../features/booking/booking-channels.js');await saveBookingAutoAssign(d.db,'a',true);
 d.raw.exec("UPDATE staff SET nomination_fee=500 WHERE id='bs';UPDATE booking_settings SET approval_mode='automatic',cutoff_minutes_before=0,max_active_bookings_per_friend=52;INSERT INTO staff_shifts(id,staff_id,work_date,start_time,end_time) VALUES('shift','bs','2026-11-20','09:00','18:00')");
 const a=gapApp(d,[booking]),context={waitUntil:()=>{},passThroughOnException:()=>{}} as any;
 const request=(staff:string,start:string,key:string)=>a.request('/api/liff/booking/requests?liffId=liff-a',{method:'POST',headers:{Authorization:'Bearer token','Content-Type':'application/json','Idempotency-Key':key},body:JSON.stringify({menu_id:'menu',staff_id:staff,starts_at:start})},undefined,context);
 expect((await request('bs','2026-11-20T05:00:00Z','nominated')).status).toBe(201);expect((await request('','2026-11-20T07:00:00Z','auto')).status).toBe(201);
 expect(d.raw.prepare('SELECT nominated,nomination_fee_at_booking,price_at_booking FROM bookings ORDER BY starts_at').all()).toEqual([{nominated:1,nomination_fee_at_booking:500,price_at_booking:8900},{nominated:0,nomination_fee_at_booking:0,price_at_booking:8400}]);
});
test('B9-01 B9-07 B9-14: 新規メニューもタグを保存、指名料だけの更新と一覧を使える',async()=>{
 const a=gapApp(d,[booking]);const create=await gapCall(a,'/api/booking/admin/menus?account_id=a','POST',{...body,name:'会員限定'});expect(create.status).toBe(201);const menu=(await create.json() as any).id;expect(await menuAudience(d.db,'a',menu,'f2')).toMatchObject({visible:false});
 const r=await gapCall(a,'/api/booking/admin/staff/bs?account_id=a','PUT',{nominationFee:500});expect(r.status).toBe(200);
 const rows=await (await gapCall(a,'/api/booking/admin/staff?account_id=a')).json() as any;expect(rows.staff.find((s:any)=>s.id==='bs').nomination_fee).toBe(500);
 const list=await (await gapCall(a,'/api/booking/admin/menus?account_id=a')).json() as any;expect(list.menus.find((m:any)=>m.id===menu)).toMatchObject({audience_mode:'include_tags',audience_tag_ids_json:'["tag"]'});
});
