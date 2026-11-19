import { beforeEach,afterEach,expect,it,vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { gapFixture,seedGapBooking } from '../../test-utils/gap1.js';
import type { Env } from '../../worker-env.js';
import { chargeCancellation } from './booking-card-charge.js';
let f:ReturnType<typeof gapFixture>;
const body={kind:'cancellation_fee',amount:4200};
const response=()=>({id:'pi_charge1',livemode:false,status:'succeeded',amount:4200,currency:'jpy',customer:'cus_person',payment_method:'pm_card',metadata:{booking_charge_id:'charge1'}});
const run=(key='key')=>chargeCancellation({DB:f.db,BOOKING_STRIPE_TEST_SECRET_KEY:'sk_test_example'} as Env['Bindings'],'a','bk',key,body,1,'o');
beforeEach(()=>{
 f=gapFixture();
 const columns=f.raw.pragma('table_info(booking_charges)') as {name:string}[];
 if(!columns.some(x=>x.name==='stripe_connected_account_id'))f.raw.exec(readFileSync('../../packages/db/migrations/775_booking_charge_stripe_identity.sql','utf8'));
 seedGapBooking(f);f.raw.exec(`INSERT INTO booking_payment_connections(line_account_id,provider,provider_account_id,test_mode,connected_at) VALUES('a','stripe','acct_original',1,datetime('now'));
 INSERT INTO booking_payment_methods(id,friend_id,line_account_id,setup_id,idempotency_key,created_at,status,stripe_customer_id,stripe_payment_method_id) VALUES('card','f','a','seti_card','cardkey',datetime('now'),'ready','cus_person','pm_card');
 INSERT INTO booking_card_checkout_requests(id,line_account_id,friend_id,idempotency_key,booking_json,connect_account,customer_id,created_at) VALUES('card','a','f','cardkey','{}','acct_original','cus_person',datetime('now'));
 UPDATE bookings SET booking_payment_method_id='card',status='cancelled' WHERE id='bk';
 INSERT INTO booking_charges(id,booking_id,line_account_id,kind,amount,policy_snapshot_json,status,created_at,updated_at) VALUES('charge1','bk','a','cancellation_fee',4200,'{}','pending',datetime('now'),datetime('now'));`);
});
afterEach(()=>{f.raw.close();vi.unstubAllGlobals();});
it('同じキーの再送では外部への請求を一度にする',async()=>{
 const fetchMock=vi.fn(async()=>Response.json(response()));vi.stubGlobal('fetch',fetchMock);
 expect((await run()).row.status).toBe('succeeded');expect((await run()).replayed).toBe(true);
 expect(fetchMock).toHaveBeenCalledTimes(1);
 expect((fetchMock.mock.calls[0] as unknown as [string,RequestInit])[1].headers).toMatchObject({'Idempotency-Key':'booking_charge_charge1'});
});
it('通信結果が不明なら同じ申込をStripeに照会し、請求をもう一度作らない',async()=>{
 const calls:string[]=[];vi.stubGlobal('fetch',vi.fn(async (url:string)=>{calls.push(url);if(calls.length===1)throw new Error('timeout');return Response.json({data:[response()],has_more:false});}));
 await expect(run()).rejects.toMatchObject({code:'charge_result_unknown'});
 expect(f.raw.prepare("SELECT status FROM booking_charges WHERE id='charge1'").get()).toEqual({status:'unknown'});
 expect((await run()).row.status).toBe('succeeded');expect(calls).toHaveLength(2);expect(calls[1]).toContain('/payment_intents/search?');
});
it('検索で見つからないときは同じStripeキーの再送だけで確定する',async()=>{
 const calls:Array<{url:string;options:RequestInit}>=[];vi.stubGlobal('fetch',vi.fn(async(url:string,options:RequestInit)=>{calls.push({url,options});if(calls.length===1)throw new Error('timeout');if(url.includes('/search?'))return Response.json({data:[],has_more:false});return Response.json(response());}));
 await expect(run()).rejects.toMatchObject({code:'charge_result_unknown'});expect((await run()).row.status).toBe('succeeded');
 expect(calls).toHaveLength(3);expect(calls[1].url).toContain('/search?');
 expect(calls[0].options.body).toEqual(calls[2].options.body);
 expect(calls[0].options.headers).toEqual(calls[2].options.headers);
});
it('カード拒否の確定結果は失敗で保存し、再請求は作らない',async()=>{
 const declined={...response(),status:'requires_payment_method',payment_method:null,last_payment_error:{payment_method:{id:'pm_card'}}};
 const mock=vi.fn(async()=>Response.json({error:{type:'card_error',payment_intent:declined}},{status:402}));vi.stubGlobal('fetch',mock);
 await expect(run()).rejects.toMatchObject({code:'card_payment_failed'});
 expect(f.raw.prepare("SELECT status,stripe_payment_intent_id FROM booking_charges WHERE id='charge1'").get()).toEqual({status:'failed',stripe_payment_intent_id:'pi_charge1'});
 await expect(run('another-key')).rejects.toMatchObject({code:'already_charged'});expect(mock).toHaveBeenCalledTimes(1);
});
it('接続が解除されても、送信済みの結果は元の接続先へ照会する',async()=>{
 let first=true;const calls:string[]=[];
 vi.stubGlobal('fetch',vi.fn(async(url:string)=>{calls.push(url);if(first){first=false;throw new Error('timeout');}return Response.json({data:[response()],has_more:false});}));
 await expect(run()).rejects.toMatchObject({code:'charge_result_unknown'});
 f.raw.exec("UPDATE booking_payment_connections SET disconnected_at=datetime('now') WHERE line_account_id='a'");
 expect((await run()).row.status).toBe('succeeded');expect(calls[1]).toContain('/search?');
});

it('請求中・結果不明・請求済みの無断や取消は競合で戻せない',async()=>{
 let release!:(value:Response)=>void;let started!:()=>void;
 const began=new Promise<void>(resolve=>{started=resolve;});
 vi.stubGlobal('fetch',vi.fn(async()=>{started();return await new Promise<Response>(resolve=>{release=resolve;});}));
 const pending=run();await began;
 expect(()=>f.raw.exec("UPDATE bookings SET status='confirmed' WHERE id='bk'")).toThrow('booking_charge_in_progress');
 release(Response.json(response()));expect((await pending).row.status).toBe('succeeded');
 expect(()=>f.raw.exec("UPDATE bookings SET status='confirmed' WHERE id='bk'")).toThrow('booking_charge_in_progress');
});
it('23時間を過ぎた不明な請求は検索だけにし、Stripeへ作成を再送しない',async()=>{
 const calls:string[]=[];vi.stubGlobal('fetch',vi.fn(async(url:string)=>{calls.push(url);if(calls.length===1)throw new Error('timeout');return Response.json({data:[],has_more:false});}));
 await expect(run()).rejects.toMatchObject({code:'charge_result_unknown'});
 f.raw.exec("UPDATE booking_charges SET stripe_call_started_at='2000-01-01T00:00:00.000Z' WHERE id='charge1'");
 await expect(run()).rejects.toMatchObject({code:'charge_result_unknown'});
 expect(calls).toHaveLength(2);expect(calls[1]).toContain('/search?');
});
