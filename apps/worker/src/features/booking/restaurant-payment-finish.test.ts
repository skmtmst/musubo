import { beforeEach,afterEach,expect,it,vi } from 'vitest';
import { gapFixture } from '../../test-utils/gap1.js';
import type { Env } from '../../worker-env.js';
import { tzDateStr } from '../../services/availability.js';
const featureEnabled=vi.hoisted(()=>vi.fn(async()=>true));
vi.mock('../../services/feature-enforcement.js',async original=>({...await original<typeof import('../../services/feature-enforcement.js')>(),accountFeatureIsEnabled:featureEnabled}));
import { cancelPaidRestaurantReservation,finishRestaurantPaidReservation,refundRestaurantPayment } from './restaurant-payment-finish.js';
import { recoverRestaurantPayments } from './restaurant-payment-recovery.js';
let f:ReturnType<typeof gapFixture>;
const env=()=>({DB:f.db,BOOKING_STRIPE_TEST_SECRET_KEY:'sk_test_example',DEPLOY_ENV:'test',RESTAURANT_TEST_ENABLED:'true'} as Env['Bindings']);
const refund=()=>({id:'re_restaurant',status:'succeeded',amount:7560,currency:'jpy',payment_intent:'pi_restaurant',metadata:{restaurant_payment_id:'pay'}});
let starts:string,ends:string;
beforeEach(()=>{
 featureEnabled.mockResolvedValue(true);
 f=gapFixture();const date=tzDateStr('Asia/Tokyo',new Date(Date.now()+2*86400000));starts=new Date(`${date}T12:00:00+09:00`).toISOString();ends=new Date(Date.parse(starts)+90*60000).toISOString();
 f.raw.exec(`INSERT INTO rt_organizations(id,account_id,name) VALUES('org','a','組織'); INSERT INTO rt_stores(id,organization_id,name,code,line_account_id) VALUES('store','org','店','s','a');
 INSERT INTO rt_tables(id,store_id,code,label,seat_type,max_capacity) VALUES('table','store','1','卓','table',6);
 INSERT INTO rt_menu_items(id,store_id,kind,name,price,duration_minutes,allergens_json) VALUES('course','store','course','コース',8400,90,'[]');
 UPDATE booking_settings SET booking_window_days=365,cutoff_minutes_before=0,cancel_deadline_minutes_before=0 WHERE line_account_id='a';
 INSERT INTO booking_payment_connections(line_account_id,provider,provider_account_id,test_mode,connected_at) VALUES('a','stripe','acct_original',1,datetime('now'));`);
 const hours=Array.from({length:7},(_,weekday)=>({weekday,periods:[{opensAt:'12:00',closesAt:'16:00'}]}));
 f.raw.prepare("INSERT INTO rt_opening_hours_settings(store_id,hours_json,updated_by) VALUES('store',?,'staff')").run(JSON.stringify(hours));
 f.raw.prepare(`INSERT INTO rt_reservations(id,store_id,source,customer_name,line_uid,guest_count,starts_at,ends_at,table_id,status,hold_expires_at,customer_request_id,course_id)
 VALUES('r','store','line','本人','Uf',3,?,?,'table','pending',?,'request_1','course')`).run(starts,ends,new Date(Date.now()+600000).toISOString());
 f.raw.exec(`INSERT INTO restaurant_payment_requests(id,line_account_id,tenant_id,store_id,reservation_id,connect_account,request_json,total_amount,amount,customer_id,checkout_id,payment_intent_id,status,created_at,updated_at)
 VALUES('pay','a','t','store','r','acct_original','{}',25200,7560,'cus_person','cs_test_abc','pi_restaurant','paid',datetime('now'),datetime('now'));
 INSERT INTO restaurant_payment_details(request_id,friend_id,customer_name,form_version) VALUES('pay','f','本人',0);`);
});
it('機能停止中は返金結果を照会するが新しい返金を送らない',async()=>{
 featureEnabled.mockResolvedValue(false);
 f.raw.exec("UPDATE restaurant_payment_requests SET status='refund_pending',refund_started_at=datetime('now') WHERE id='pay'");
 const fetchMock=vi.fn(async()=>Response.json({data:[],has_more:false}));vi.stubGlobal('fetch',fetchMock);
 await recoverRestaurantPayments(env());
 expect(fetchMock).toHaveBeenCalledTimes(1);
 expect((fetchMock.mock.calls[0] as unknown as [string,RequestInit?])[1]?.method ?? 'GET').toBe('GET');
 expect(f.raw.prepare("SELECT status FROM restaurant_payment_requests WHERE id='pay'").get()).toEqual({status:'refund_pending'});
});
it('機能停止中は未返金の入金から返金を始めない',async()=>{
 featureEnabled.mockResolvedValue(false);const fetchMock=vi.fn();vi.stubGlobal('fetch',fetchMock);
 await recoverRestaurantPayments(env());expect(fetchMock).not.toHaveBeenCalled();
 expect(f.raw.prepare("SELECT status FROM restaurant_payment_requests WHERE id='pay'").get()).toEqual({status:'paid'});
});
it('返金の直前に停止された場合も Stripe へ送らない',async()=>{
 featureEnabled.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
 const fetchMock=vi.fn();vi.stubGlobal('fetch',fetchMock);
 expect(await refundRestaurantPayment(env(),'pay')).toBe('pending');
 expect(fetchMock).not.toHaveBeenCalled();
});
it('機能停止中でも照会で確認できた返金は確定する',async()=>{
 featureEnabled.mockResolvedValue(false);
 f.raw.exec("UPDATE restaurant_payment_requests SET status='refund_pending',refund_started_at=datetime('now') WHERE id='pay'");
 const fetchMock=vi.fn(async()=>Response.json({data:[refund()],has_more:false}));vi.stubGlobal('fetch',fetchMock);
 await recoverRestaurantPayments(env());expect(fetchMock).toHaveBeenCalledTimes(1);
 expect(f.raw.prepare("SELECT status FROM restaurant_payment_requests WHERE id='pay'").get()).toEqual({status:'refunded'});
});
afterEach(()=>{f.raw.close();vi.unstubAllGlobals();});
it('支払い済みの予約を席と営業時間を再検査して確定する',async()=>{
 expect(()=>f.raw.exec("UPDATE rt_reservations SET guest_count=4 WHERE id='r'")).toThrow('restaurant_payment_change_requires_refund');
 expect(()=>f.raw.exec("UPDATE rt_reservations SET note='後から変更' WHERE id='r'")).toThrow('restaurant_payment_details_locked');
 await finishRestaurantPaidReservation(env(),'pay');
 expect(f.raw.prepare("SELECT status FROM rt_reservations WHERE id='r'").get()).toEqual({status:'confirmed'});
 f.raw.exec("UPDATE rt_reservations SET note='確定後の連絡' WHERE id='r'");
 expect(f.raw.prepare("SELECT COUNT(*) n FROM rt_customer_notice_outbox WHERE reservation_id='r'").get()).toEqual({n:1});
});
it('期限後に席が埋まっていたら自動で全額返金し、予約を確定しない',async()=>{
 f.raw.prepare("UPDATE rt_reservations SET hold_expires_at=? WHERE id='r'").run(new Date(Date.now()-60000).toISOString());
 f.raw.prepare(`INSERT INTO rt_reservations(id,store_id,source,customer_name,guest_count,starts_at,ends_at,table_id,status) VALUES('occupied','store','manual','別の予約',3,?,?,'table','confirmed')`).run(starts,ends);
 const mock=vi.fn(async()=>Response.json(refund()));vi.stubGlobal('fetch',mock);
 await finishRestaurantPaidReservation(env(),'pay');
 expect(f.raw.prepare("SELECT status FROM restaurant_payment_requests WHERE id='pay'").get()).toEqual({status:'refunded'});
 expect(f.raw.prepare("SELECT status FROM rt_reservations WHERE id='r'").get()).toEqual({status:'pending'});expect(mock).toHaveBeenCalledTimes(1);
});
it('取消の返金が不明でも予約の状態を固定し、回収後に取消を完了する',async()=>{
 f.raw.exec("UPDATE rt_reservations SET status='confirmed' WHERE id='r'");
 let call=0;vi.stubGlobal('fetch',vi.fn(async(url:string)=>{call++;if(call===1 && url.includes('/refunds?'))return Response.json({data:[],has_more:false});if(call===2)throw new Error('timeout');if(url.includes('/refunds?'))return Response.json({data:[refund()],has_more:false});throw new Error('unexpected');}));
 expect(await cancelPaidRestaurantReservation(env(),'pay',2)).toBe('pending');
 expect(f.raw.prepare("SELECT status FROM rt_reservations WHERE id='r'").get()).toEqual({status:'confirmed'});
 expect(()=>f.raw.exec("UPDATE rt_reservations SET customer_version=customer_version+1 WHERE id='r'")).toThrow('restaurant_refund_pending');
 expect(await recoverRestaurantPayments(env())).toEqual({failed:0});
 expect(f.raw.prepare("SELECT status FROM rt_reservations WHERE id='r'").get()).toEqual({status:'cancelled'});
 expect(f.raw.prepare("SELECT status FROM restaurant_payment_requests WHERE id='pay'").get()).toEqual({status:'refunded'});
});
it.each(['seated','visited','no_show'])('来店・無断の状態 %s は自動返金しない',async status=>{
 f.raw.prepare('UPDATE rt_reservations SET status=? WHERE id=?').run(status,'r');
 const mock=vi.fn();vi.stubGlobal('fetch',mock);
 await finishRestaurantPaidReservation(env(),'pay');await recoverRestaurantPayments(env());
 expect(f.raw.prepare("SELECT status FROM restaurant_payment_requests WHERE id='pay'").get()).toEqual({status:'paid'});expect(mock).not.toHaveBeenCalled();
});
