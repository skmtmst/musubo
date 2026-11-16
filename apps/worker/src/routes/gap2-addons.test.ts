import { useSqliteClock } from '../test-utils/sqlite-clock.js';
import {beforeEach,afterEach,test,expect,vi} from 'vitest';
import booking from './booking.js';
import {bookingAddons} from '../features/booking/booking-addons.js';
import {gapFixture,gapApp,gapCall,gapOwner} from '../test-utils/gap1.js';
import type {SqliteD1} from '../test-utils/d1-sqlite.js';
let d:SqliteD1;
beforeEach(()=>{vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-11-16T00:00:00Z'));d=gapFixture();useSqliteClock(d.raw,()=>new Date());d.raw.exec(`INSERT INTO menus(id,line_account_id,name,duration_minutes,base_price,addon_only) VALUES('addon','a','追加',15,1500,1);
 UPDATE menus SET addon_menu_ids_json='["addon"]' WHERE id='menu';
 INSERT INTO staff_shifts(id,staff_id,work_date,start_time,end_time) VALUES('shift','bs','2026-11-20','09:00','18:00');
 UPDATE booking_settings SET approval_mode='automatic',cutoff_minutes_before=0,booking_window_days=60;`);vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({sub:'Uf'}))));});
afterEach(()=>{d.raw.close();vi.useRealTimers();vi.unstubAllGlobals();});
test('B5-02: 追加1つで料金と時間を足し、予約に額を保存する',async()=>{
 const addons=await bookingAddons(d.db,'a','menu',['addon'],'f');expect(addons[0]).toMatchObject({duration_minutes:15,base_price:1500});
 const app=gapApp(d,[booking]);const r=await app.request('/api/liff/booking/requests?liffId=liff-a',{method:'POST',headers:{Authorization:'Bearer token','Idempotency-Key':'addon-book','Content-Type':'application/json'},body:JSON.stringify({menu_id:'menu',staff_id:'bs',starts_at:'2026-11-20T05:00:00Z',addonIds:['addon']})},undefined,{waitUntil:()=>{},passThroughOnException:()=>{}} as any);
 expect(r.status).toBe(201);expect(d.raw.prepare('SELECT price_at_booking,ends_at FROM bookings').get()).toEqual({price_at_booking:9900,ends_at:'2026-11-20T06:15:00.000Z'});expect(d.raw.prepare('SELECT duration_min,price_at_booking FROM booking_addons').get()).toEqual({duration_min:15,price_at_booking:1500});
 d.raw.exec("UPDATE menus SET base_price=2000 WHERE id='addon'");expect(d.raw.prepare('SELECT price_at_booking FROM booking_addons').get()).toEqual({price_at_booking:1500});
});
test('B5-01 B5-17: 許可外・追加だけ・重複・4つを拒否、組の人数は2〜6人で保存',async()=>{
 for(const ids of [['menu'],['addon','addon'],['a','b','c','d']])await expect(bookingAddons(d.db,'a','menu',ids,'f')).rejects.toThrow();
 await expect(bookingAddons(d.db,'a','addon',[],'f')).rejects.toThrow('addon_only_menu');
 const r=await gapCall(gapApp(d,[booking]),'/api/booking/admin/menus/menu?account_id=a','PUT',{name:'相談',duration_minutes:60,base_price:8400,expectedVersion:1,maxPartySize:2});expect(r.status).toBe(200);
 const invalid=await gapCall(gapApp(d,[booking]),'/api/booking/admin/menus/menu?account_id=a','PUT',{name:'相談',duration_minutes:60,base_price:8400,expectedVersion:2,maxPartySize:7});expect(invalid.status).toBe(400);
});
test('B5-15 Q-01: 追加メニューの設定は閲覧のみ・代理・スタッフでは変えられない',async()=>{
 for(const [staff,im] of [[{...gapOwner,readOnly:true},false],[gapOwner,true],[{...gapOwner,role:'staff' as const,permissionKeys:['/booking/menus'] as string[]},false]] as const){expect((await gapCall(gapApp(d,[booking],staff,im),'/api/booking/admin/menus/menu?account_id=a','PUT',{name:'相談',duration_minutes:60,base_price:8400,expectedVersion:1,addonMenuIds:['addon']})).status).toBe(403);}
});
