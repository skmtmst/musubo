import { beforeEach,afterEach,expect,it,vi } from 'vitest';
import { gapFixture } from '../../test-utils/gap1.js';
import type { Env } from '../../worker-env.js';
const finish=vi.hoisted(()=>vi.fn(async()=>{}));
const featureEnabled=vi.hoisted(()=>vi.fn(async()=>true));
vi.mock('../../services/feature-enforcement.js',async original=>({...await original<typeof import('../../services/feature-enforcement.js')>(),accountFeatureIsEnabled:featureEnabled}));
vi.mock('./restaurant-payment-finish.js',()=>({finishRestaurantPaidReservation:finish}));
import { startRestaurantPayment } from './restaurant-payment-start.js';
import { applyRestaurantPaymentReceipt } from './booking-stripe-webhooks/restaurant-payment.js';
import { normalizeBookingStripeEvent,storeBookingStripeReceipt,stripeReceiptDigest } from './booking-stripe-webhooks/index.js';
let f:ReturnType<typeof gapFixture>;
const env=()=>({DB:f.db,BOOKING_STRIPE_TEST_SECRET_KEY:'sk_test_example',DEPLOY_ENV:'test',RESTAURANT_TEST_ENABLED:'true'} as Env['Bindings']);
const start=(id='r1',form='form1')=>startRestaurantPayment(env(),'a','Uf',id,1,{formSubmissionId:form,formId:'form',paymentMethod:'online'});
function event(){return {id:'evt_restaurant',account:'acct_original',api_version:'2024-06-20',created:Math.floor(Date.now()/1000),type:'checkout.session.completed',livemode:false,data:{object:{id:'cs_test_abc',object:'checkout.session',livemode:false,status:'complete',mode:'payment',payment_status:'paid',amount_total:25200,currency:'jpy',customer:'cus_person',payment_intent:'pi_restaurant'}}};}
async function save(){const e=event();return storeBookingStripeReceipt(f.db,normalizeBookingStripeEvent(e),await stripeReceiptDigest(JSON.stringify(e)));}
beforeEach(()=>{
 f=gapFixture();finish.mockClear();featureEnabled.mockResolvedValue(true);
 f.raw.exec(`UPDATE line_accounts SET liff_id='1234567890-abcdef' WHERE id='a';
 INSERT INTO rt_organizations(id,account_id,name) VALUES('org','a','組織'); INSERT INTO rt_stores(id,organization_id,name,code,line_account_id) VALUES('store','org','店','s','a');
 INSERT INTO rt_menu_items(id,store_id,kind,name,price,duration_minutes,allergens_json) VALUES('course','store','course','コース',8400,90,'[]');
 INSERT INTO booking_payment_configs(line_account_id,mode,provider,hold_minutes,created_at,updated_at) VALUES('a','online','stripe',10,datetime('now'),datetime('now'));
 INSERT INTO booking_payment_connections(line_account_id,provider,provider_account_id,test_mode,connected_at) VALUES('a','stripe','acct_original',1,datetime('now'));
 INSERT INTO rt_reservations(id,store_id,source,customer_name,line_uid,guest_count,starts_at,ends_at,status,hold_expires_at,customer_request_id,course_id)
 VALUES('r1','store','line','本人','Uf',3,'2099-10-20T01:00:00.000Z','2099-10-20T02:30:00.000Z','pending','2999-01-01T00:00:00.000Z','request_1','course'),
       ('r2','store','line','本人','Uf',3,'2099-10-21T01:00:00.000Z','2099-10-21T02:30:00.000Z','pending','2999-01-01T00:00:00.000Z','request_2','course');`);
});
afterEach(()=>{f.raw.close();vi.unstubAllGlobals();});
for(const early of [false,true])it(early?'入金通知が先でも金額と本人を照合して反映':'支払いURLの保存後に入金通知を反映',async()=>{
 vi.stubGlobal('fetch',vi.fn(async(url:string,init:RequestInit)=>{
  if(url.endsWith('/customers'))return Response.json({id:'cus_person',livemode:false});
  if(url.endsWith('/checkout/sessions')){const form=new URLSearchParams(String(init.body));expect(form.get('line_items[0][price_data][unit_amount]')).toBe('25200');if(early)expect((await save()).status).toBe('pending');return Response.json({id:'cs_test_abc',url:'https://checkout.stripe.com/c/pay/cs_test_abc',livemode:false});}
  throw new Error('unexpected fetch');
 }));
 const result=await start();expect(result.required).toBe(true);
 if(!early){expect((await save()).status).toBe('pending');expect(await applyRestaurantPaymentReceipt(env(),'acct_original','evt_restaurant')).toBe('applied');}
 expect(f.raw.prepare('SELECT status,total_amount,amount FROM restaurant_payment_requests').get()).toEqual({status:'paid',total_amount:25200,amount:25200});
 expect(finish).toHaveBeenCalledTimes(1);
});
it('一つのフォーム回答から別の有料予約を作れない',async()=>{
 const mock=vi.fn(async(url:string)=>url.endsWith('/customers')?Response.json({id:'cus_person',livemode:false}):Response.json({id:'cs_test_abc',url:'https://checkout.stripe.com/c/pay/cs_test_abc',livemode:false}));vi.stubGlobal('fetch',mock);
 await start();await expect(start('r2')).rejects.toMatchObject({code:'paid_form_or_reservation_conflict'});expect(mock).toHaveBeenCalledTimes(2);
});
it('顧客が削除されても保存済みの決済と照合し入金を回収する',async()=>{
 vi.stubGlobal('fetch',vi.fn(async(url:string)=>url.endsWith('/customers')?Response.json({id:'cus_person',livemode:false}):Response.json({id:'cs_test_abc',url:'https://checkout.stripe.com/c/pay/cs_test_abc',livemode:false})));
 await start();await save();
 f.raw.exec("DELETE FROM restaurant_payment_details; DELETE FROM friends WHERE id='f'");
 expect(await applyRestaurantPaymentReceipt(env(),'acct_original','evt_restaurant')).toBe('applied');
 expect(f.raw.prepare('SELECT status FROM restaurant_payment_requests').get()).toEqual({status:'refund_pending'});
 expect(finish).toHaveBeenCalledTimes(1);
});
it('店が停止した後の入金は返金に進める',async()=>{
 vi.stubGlobal('fetch',vi.fn(async(url:string)=>url.endsWith('/customers')?Response.json({id:'cus_person',livemode:false}):Response.json({id:'cs_test_abc',url:'https://checkout.stripe.com/c/pay/cs_test_abc',livemode:false})));
 await start();await save();f.raw.exec("UPDATE line_accounts SET is_active=0 WHERE id='a'");
 expect(await applyRestaurantPaymentReceipt(env(),'acct_original','evt_restaurant')).toBe('applied');
 expect(f.raw.prepare('SELECT status FROM restaurant_payment_requests').get()).toEqual({status:'refund_pending'});
 expect(finish).toHaveBeenCalledTimes(1);
});
it('停止中の入金通知は入金を記録するだけで新たな返金を始めない',async()=>{
 vi.stubGlobal('fetch',vi.fn(async(url:string)=>url.endsWith('/customers')?Response.json({id:'cus_person',livemode:false}):Response.json({id:'cs_test_abc',url:'https://checkout.stripe.com/c/pay/cs_test_abc',livemode:false})));
 await start();await save();featureEnabled.mockResolvedValue(false);
 expect(await applyRestaurantPaymentReceipt(env(),'acct_original','evt_restaurant')).toBe('applied');
 expect(f.raw.prepare('SELECT status FROM restaurant_payment_requests').get()).toEqual({status:'paid'});
 expect(finish).not.toHaveBeenCalled();
});
it('通知の一時的な保存エラーは回収対象から外さず、次回に入金を反映する',async()=>{
 const {recoverRestaurantPayments}=await import('./restaurant-payment-recovery.js');
 vi.stubGlobal('fetch',vi.fn(async(url:string)=>url.endsWith('/customers')?Response.json({id:'cus_person',livemode:false}):Response.json({id:'cs_test_abc',url:'https://checkout.stripe.com/c/pay/cs_test_abc',livemode:false})));
 await start();await save();
 f.raw.exec("CREATE TRIGGER payment_temp_failure BEFORE UPDATE OF status ON restaurant_payment_requests WHEN NEW.status='paid' BEGIN SELECT RAISE(ABORT,'temporary'); END");
 expect(await recoverRestaurantPayments(env())).toEqual({failed:1});
 expect(f.raw.prepare("SELECT error_code FROM workflow_steps WHERE subject_id='evt_restaurant'").get()).toEqual({error_code:null});
 f.raw.exec("DROP TRIGGER payment_temp_failure; UPDATE restaurant_payment_requests SET recovery_retry_at=NULL");
 expect(await recoverRestaurantPayments(env())).toEqual({failed:0});
 expect(f.raw.prepare('SELECT status FROM restaurant_payment_requests').get()).toEqual({status:'paid'});
});
