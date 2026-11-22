import { beforeEach,afterEach,expect,it,vi } from 'vitest';
import { gapFixture,seedGapBooking } from '../../test-utils/gap1.js';
import type { Env } from '../../worker-env.js';
import { refundCancellationCharge } from './booking-charge-refund.js';
let f:ReturnType<typeof gapFixture>;
const env=()=>({DB:f.db,BOOKING_STRIPE_TEST_SECRET_KEY:'sk_test_example'} as Env['Bindings']);
const run=(version=1,key='refund-key',reason='店の都合')=>refundCancellationCharge(env(),'a','charge1',key,version,reason,'o');
function result(id:string){return {id:'re_refund1',status:'succeeded',amount:4200,currency:'jpy',payment_intent:'pi_charge1',metadata:{booking_refund_request_id:id}};}
beforeEach(()=>{
 f=gapFixture();seedGapBooking(f);f.raw.exec(`INSERT INTO booking_payment_connections(line_account_id,provider,provider_account_id,test_mode,connected_at) VALUES('a','stripe','acct_original',1,datetime('now'));
 UPDATE bookings SET status='cancelled' WHERE id='bk';
 INSERT INTO booking_charges(id,booking_id,line_account_id,kind,amount,policy_snapshot_json,status,version,stripe_payment_intent_id,stripe_connected_account_id,created_at,updated_at) VALUES('charge1','bk','a','cancellation_fee',4200,'{}','succeeded',1,'pi_charge1','acct_original',datetime('now'),datetime('now'));`);
});
afterEach(()=>{f.raw.close();vi.unstubAllGlobals();});
it('版の違う返金を拒否し、同時操作でもStripeに返すのは1回',async()=>{
 const mock=vi.fn(async(_url:string,options:RequestInit)=>{const form=new URLSearchParams(String(options.body));return Response.json(result(form.get('metadata[booking_refund_request_id]')!));});vi.stubGlobal('fetch',mock);
 await expect(run(0)).rejects.toMatchObject({code:'version_conflict'});
 await expect(run(1,'empty','   ')).rejects.toMatchObject({code:'reason_required'});
 const attempts=await Promise.allSettled([run(1,'key1'),run(1,'key2')]);
 expect(attempts.filter(x=>x.status==='fulfilled')).toHaveLength(1);expect(attempts.filter(x=>x.status==='rejected')).toHaveLength(1);expect(mock).toHaveBeenCalledTimes(1);
 expect(f.raw.prepare("SELECT status,version,reason FROM booking_charges WHERE id='charge1'").get()).toEqual({status:'refunded',version:3,reason:'店の都合'});
 expect(f.raw.prepare('SELECT count(*) n FROM booking_charge_refund_requests').get()).toEqual({n:1});
 const saved=f.raw.prepare('SELECT idempotency_key FROM booking_charge_refund_requests').get() as {idempotency_key:string};
 expect((await run(1,saved.idempotency_key)).replayed).toBe(true);expect(mock).toHaveBeenCalledTimes(1);
 await expect(run(1,'different')).rejects.toMatchObject({code:'refund_idempotency_conflict'});
});
it('結果不明の後は元の返金を照会し、同じ送金を二重に作らない',async()=>{
 const calls:string[]=[];vi.stubGlobal('fetch',vi.fn(async(url:string)=>{calls.push(url);if(calls.length===1)throw new Error('timeout');const row=f.raw.prepare('SELECT id FROM booking_charge_refund_requests').get() as {id:string};return Response.json({data:[result(row.id)],has_more:false});}));
 await expect(run()).rejects.toMatchObject({code:'refund_result_unknown'});
 expect(f.raw.prepare("SELECT status,version FROM booking_charges WHERE id='charge1'").get()).toEqual({status:'succeeded',version:2});
 expect((await run()).status).toBe('refunded');expect(calls).toHaveLength(2);expect(calls[1]).toContain('/refunds?');
});
it('結果不明で見つからなければ同じStripeキー・同じ内容だけを再送する',async()=>{
 const calls:Array<{url:string;init:RequestInit}>=[];vi.stubGlobal('fetch',vi.fn(async(url:string,init:RequestInit)=>{calls.push({url,init});if(calls.length===1)throw new Error('timeout');if(url.includes('/refunds?'))return Response.json({data:[],has_more:false});const form=new URLSearchParams(String(init.body));return Response.json(result(form.get('metadata[booking_refund_request_id]')!));}));
 await expect(run()).rejects.toMatchObject({code:'refund_result_unknown'});expect((await run()).status).toBe('refunded');
 expect(calls).toHaveLength(3);expect(calls[0].init.headers).toEqual(calls[2].init.headers);expect(calls[0].init.body).toEqual(calls[2].init.body);
});
it('管理画面の返金口は理由と二段階確認が必須で、古い版を拒む',async()=>{
 const {gapApp,gapCall,gapOwner}=await import('../../test-utils/gap1.js');
 const {bookingCancellation}=await import('../../routes/booking-cancellation.js');
 const app=gapApp(f,[bookingCancellation],gapOwner,false,{BOOKING_STRIPE_TEST_SECRET_KEY:'sk_test_example'});
 const path='/api/booking/admin/charges/charge1/refund?account_id=a';
 const body={reason:'店の都合',expectedVersion:1,confirmed:true,confirmedIrreversible:true};
 const fetchMock=vi.fn(async(_url:string,options:RequestInit)=>{const form=new URLSearchParams(String(options.body));return Response.json(result(form.get('metadata[booking_refund_request_id]')!));});vi.stubGlobal('fetch',fetchMock);
 expect((await gapCall(app,path,'POST',{...body,reason:''},'key')).status).toBe(400);
 expect((await gapCall(app,path,'POST',{...body,confirmedIrreversible:false},'key')).status).toBe(400);
 expect((await gapCall(app,path,'POST',{...body,expectedVersion:0},'key')).status).toBe(409);
 expect(fetchMock).not.toHaveBeenCalled();
 expect((await gapCall(app,path,'POST',body,'key')).status).toBe(200);
 expect((await gapCall(app,path,'POST',body,'key')).status).toBe(200);expect(fetchMock).toHaveBeenCalledTimes(1);
});
