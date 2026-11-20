import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { gapApp, gapFixture, seedGapBooking } from '../test-utils/gap1.js';
import { chargeCancellation } from '../features/booking/booking-card-charge.js';
import { refundCancellationCharge } from '../features/booking/booking-charge-refund.js';
import type { Env } from '../worker-env.js';
import { bookingCancellation } from './booking-cancellation.js';
import { bookingStripeWebhook } from './booking-stripe-webhook.js';

let fixture:ReturnType<typeof gapFixture>;
const secret='whsec_fixture';
const key='checkout-key';
const input={menuId:'menu',staffId:'bs',startsAt:'2026-12-01T05:00:00Z',partySize:2,policyAccepted:true};
const app=()=>gapApp(fixture,[bookingCancellation,bookingStripeWebhook],undefined,false,{
  BOOKING_STRIPE_TEST_SECRET_KEY:'sk_test_example',BOOKING_STRIPE_TEST_CONNECT_WEBHOOK_SECRET:secret,
});
async function notify(type:'checkout.session.completed'|'setup_intent.succeeded',requestId:string) {
  const object=type==='checkout.session.completed'
    ? {id:'cs_test_abc',object:'checkout.session',livemode:false,status:'complete',mode:'setup',customer:'cus_person',setup_intent:'seti_card'}
    : {id:'seti_card',object:'setup_intent',livemode:false,status:'succeeded',customer:'cus_person',payment_method:'pm_card',metadata:{booking_payment_method_id:requestId}};
  const body=JSON.stringify({id:type==='checkout.session.completed'?'evt_checkout':'evt_setup',account:'acct_original',api_version:'2024-06-20',created:Math.floor(Date.now()/1000),livemode:false,type,data:{object}});
  const t=Math.floor(Date.now()/1000),signature=createHmac('sha256',secret).update(`${t}.${body}`).digest('hex');
  return app().request('/api/booking/stripe-test/webhook',{method:'POST',headers:{'stripe-signature':`t=${t},v1=${signature}`},body});
}
async function start() {
  return app().request('/api/liff/booking/setup-intent?liffId=1234567890-abcdef',{method:'POST',headers:{Authorization:'Bearer token','Content-Type':'application/json','Idempotency-Key':key},body:JSON.stringify(input)});
}
beforeEach(()=>{
  fixture=gapFixture();
  if (!fixture.raw.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='booking_card_checkout_requests'").get()) fixture.raw.exec(readFileSync('../../packages/db/migrations/774_booking_card_checkout_requests.sql','utf8'));
  fixture.raw.exec("UPDATE line_accounts SET liff_id='1234567890-abcdef' WHERE id='a'");
  fixture.raw.exec("INSERT INTO booking_payment_connections(line_account_id,provider,provider_account_id,test_mode,connected_at) VALUES('a','stripe','acct_original',1,datetime('now'))");
});
afterEach(()=>{fixture.raw.close();vi.unstubAllGlobals();});
for (const early of [false,true]) it(early?'通知が先でもCheckoutの保存後に結び付く':'Checkoutを保存してから通知を結び付ける',async()=>{
  let requestId='';
  vi.stubGlobal('fetch',vi.fn(async (url:RequestInfo | URL,init?:RequestInit)=>{
    if(String(url).includes('oauth2/v2.1/verify')) return Response.json({sub:'Uf'});
    if(String(url).endsWith('/customers')) { requestId=new URLSearchParams(String(init?.body)).get('metadata[booking_payment_method_id]')!; return Response.json({id:'cus_person',livemode:false}); }
    if(String(url).endsWith('/checkout/sessions')) {
      const body=new URLSearchParams(String(init?.body));
      expect(body.get('success_url')).toBe('https://liff.line.me/1234567890-abcdef/booking?liffId=1234567890-abcdef&card_setup=success');
      expect(body.get('cancel_url')).toBe('https://liff.line.me/1234567890-abcdef/booking?liffId=1234567890-abcdef&card_setup=cancelled');
      if(early) { expect((await notify('setup_intent.succeeded',requestId)).status).toBe(202);expect((await notify('checkout.session.completed',requestId)).status).toBe(202); }
      return Response.json({id:'cs_test_abc',url:'https://checkout.stripe.com/c/pay/cs_test_abc',livemode:false});
    }
    throw new Error('unexpected fetch');
  }));
  const response=await start(); expect(response.status).toBe(201);
  if (!early) { expect((await notify('checkout.session.completed',requestId)).status).toBe(200);expect((await notify('setup_intent.succeeded',requestId)).status).toBe(200); }
  expect(fixture.raw.prepare('SELECT setup_id,status,stripe_customer_id,stripe_payment_method_id FROM booking_payment_methods').get()).toEqual({setup_id:'seti_card',status:'ready',stripe_customer_id:'cus_person',stripe_payment_method_id:'pm_card'});
  const row=fixture.raw.prepare('SELECT booking_json,checkout_id FROM booking_card_checkout_requests').get() as {booking_json:string;checkout_id:string};
  expect(JSON.parse(row.booking_json)).toEqual(input);expect(row.checkout_id).toBe('cs_test_abc');
  expect((await start()).status).toBe(201);
  expect(fixture.raw.prepare('SELECT COUNT(*) n FROM booking_card_checkout_requests').get()).toEqual({n:1});
});
it('関連付けの保存後に処理が止まっても定時の回収で登録される',async()=>{
  const {normalizeBookingStripeEvent,storeBookingStripeReceipt,stripeReceiptDigest,prepareBookingStripeBinding,recoverCardSetupReceipts}=await import('../features/booking/booking-stripe-webhooks/index.js');
  fixture.raw.exec("INSERT INTO booking_payment_methods(id,friend_id,line_account_id,setup_id,idempotency_key,created_at) VALUES('request1','f','a','seti_card','key',datetime('now')); INSERT INTO booking_card_checkout_requests(id,line_account_id,friend_id,idempotency_key,booking_json,connect_account,customer_id,checkout_id,created_at) VALUES('request1','a','f','key','{}','acct_original','cus_person','cs_test_abc',datetime('now'))");
  const event={id:'evt_recover',account:'acct_original',api_version:'2024-06-20',created:Math.floor(Date.now()/1000),type:'setup_intent.succeeded',livemode:false,data:{object:{id:'seti_card',object:'setup_intent',livemode:false,status:'succeeded',customer:'cus_person',payment_method:'pm_card'}}};
  await storeBookingStripeReceipt(fixture.db,normalizeBookingStripeEvent(event),await stripeReceiptDigest(JSON.stringify(event)));
  await fixture.db.batch(prepareBookingStripeBinding(fixture.db,{tenantId:'t',accountId:'a',friendId:'f',purpose:'payment_method',targetId:'request1',connectAccount:'acct_original',objectId:'seti_card',objectKind:'setup_intent',amount:null,currency:null,customerId:'cus_person'}));
  fixture.raw.exec("CREATE TRIGGER recovery_failure BEFORE UPDATE OF status ON booking_payment_methods BEGIN SELECT RAISE(ABORT,'test failure'); END");
  expect(await recoverCardSetupReceipts(fixture.db)).toEqual({failed:1});
  expect(fixture.raw.prepare("SELECT error_code FROM workflow_steps WHERE subject_id='evt_recover'").get()).toEqual({error_code:'stripe_card_recovery_failed'});
  fixture.raw.exec('DROP TRIGGER recovery_failure');
  expect(await recoverCardSetupReceipts(fixture.db)).toEqual({failed:0});
  expect(fixture.raw.prepare('SELECT status FROM booking_payment_methods WHERE id=?').get('request1')).toEqual({status:'pending'});
  fixture.raw.exec("UPDATE workflow_steps SET error_code=NULL WHERE subject_id='evt_recover'");
  expect(await recoverCardSetupReceipts(fixture.db)).toEqual({failed:0});
  expect(fixture.raw.prepare('SELECT status FROM booking_payment_methods WHERE id=?').get('request1')).toEqual({status:'ready'});
});

it('模擬Stripeでカード登録から請求と返金まで同じカードで進む',async()=>{
 let requestId='';const calls:string[]=[];const sends:RequestInit[]=[];
 vi.stubGlobal('fetch',vi.fn(async(url:RequestInfo | URL,init?:RequestInit)=>{
  const path=String(url);calls.push(path);const fields=new URLSearchParams(String(init?.body));
  if(path.includes('oauth2/v2.1/verify'))return Response.json({sub:'Uf'});
  if(path.endsWith('/customers')){requestId=fields.get('metadata[booking_payment_method_id]')!;return Response.json({id:'cus_person',livemode:false});}
  if(path.endsWith('/checkout/sessions'))return Response.json({id:'cs_test_abc',url:'https://checkout.stripe.com/c/pay/cs_test_abc',livemode:false});
  if(path.endsWith('/payment_intents')){expect(fields.get('amount')).toBe('4200');expect(fields.get('customer')).toBe('cus_person');expect(fields.get('payment_method')).toBe('pm_card');expect(fields.get('off_session')).toBe('true');expect((init?.headers as Record<string,string>)['Idempotency-Key']).toBe('booking_charge_charge1');return Response.json({id:'pi_charge1',livemode:false,status:'succeeded',amount:4200,currency:'jpy',customer:'cus_person',payment_method:'pm_card',metadata:{booking_charge_id:'charge1'}});}
  if(path.endsWith('/refunds')){sends.push(init!);return Response.json({id:'re_refund1',status:'succeeded',amount:4200,currency:'jpy',payment_intent:'pi_charge1',metadata:{booking_refund_request_id:fields.get('metadata[booking_refund_request_id]')}});}
  throw new Error('unexpected mock request');
 }));
 expect((await start()).status).toBe(201);expect((await notify('checkout.session.completed',requestId)).status).toBe(200);expect((await notify('setup_intent.succeeded',requestId)).status).toBe(200);
 seedGapBooking(fixture);fixture.raw.prepare("UPDATE bookings SET booking_payment_method_id=?,status='cancelled' WHERE id='bk'").run(requestId);
 fixture.raw.exec("INSERT INTO booking_charges(id,booking_id,line_account_id,kind,amount,policy_snapshot_json,status,created_at,updated_at) VALUES('charge1','bk','a','cancellation_fee',4200,'{}','pending',datetime('now'),datetime('now'))");
 const env={DB:fixture.db,BOOKING_STRIPE_TEST_SECRET_KEY:'sk_test_example'} as Env['Bindings'];
 const charged=await chargeCancellation(env,'a','bk','charge-key',{kind:'cancellation_fee',amount:4200},1,'o');expect(charged.row.status).toBe('succeeded');
 expect((await refundCancellationCharge(env,'a','charge1','refund-key',charged.row.version,'店の都合','o')).status).toBe('refunded');
 expect(calls.filter(path=>path.endsWith('/payment_intents'))).toHaveLength(1);expect(calls.filter(path=>path.endsWith('/refunds'))).toHaveLength(1);
 const refundId=(fixture.raw.prepare('SELECT id FROM booking_charge_refund_requests WHERE charge_id=?').get('charge1') as {id:string}).id;
 expect(new URLSearchParams(String(sends[0].body)).get('amount')).toBe('4200');expect(new URLSearchParams(String(sends[0].body)).get('payment_intent')).toBe('pi_charge1');expect((sends[0].headers as Record<string,string>)['Idempotency-Key']).toBe(`booking_refund_${refundId}`);
});
