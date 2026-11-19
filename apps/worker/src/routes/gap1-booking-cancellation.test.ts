import {readFileSync} from 'node:fs';
import {beforeEach,afterEach,expect,test,vi} from 'vitest';
import {bookingCancellation} from './booking-cancellation.js';
import {gapFixture,gapApp,gapCall,gapOwner,seedGapBooking} from '../test-utils/gap1.js';
import type {SqliteD1} from '../test-utils/d1-sqlite.js';
import {cancellationQuote,cancellationPolicy} from '../features/booking/booking-cancellation.js';
let d:SqliteD1;
const policy={enabled:true,tiers:[{beforeHours:24,percent:0},{beforeHours:0,percent:50}],noShowPercent:100,expectedVersion:0};

test('端数の取消料は見積もりと実際に作る請求行が一致する', async () => {
 connect();await save();seedGapBooking(d);
 d.raw.exec("UPDATE bookings SET price_at_booking=1001 WHERE id='bk'");cancel();
 const snapshot=JSON.parse((d.raw.prepare('SELECT policy_snapshot_json FROM bookings WHERE id=?').get('bk') as {policy_snapshot_json:string}).policy_snapshot_json);
 const quote=cancellationQuote(snapshot,'2026-11-20T05:00:00Z',1001,new Date('2026-11-20T04:00:00Z'));
 expect(quote.feeNow).toBe(500);
 expect(quote.text).toContain('50%（¥500）');
 expect(d.raw.prepare('SELECT amount FROM booking_charges WHERE booking_id=?').get('bk')).toEqual({amount:quote.feeNow});
 expect(fetch).not.toHaveBeenCalled();
});
const app=()=>gapApp(d,[bookingCancellation]);
const path='/api/booking/admin/cancellation-policy?account_id=a';
async function save(){return gapCall(app(),path,'PUT',policy);}
function connect(){d.raw.exec("INSERT INTO booking_payment_connections(line_account_id,provider,provider_account_id,test_mode,connected_at) VALUES('a','stripe','acct_test_123',1,datetime('now'))");}
function cancel(at='2026-11-20T04:00:00Z'){d.raw.prepare("UPDATE bookings SET status='cancelled',decided_at=? WHERE id='bk'").run(at);}
function chargeBody(){return {kind:'cancellation_fee',amount:4200,expectedVersion:1};}
beforeEach(()=>{d=gapFixture();vi.stubGlobal('fetch',vi.fn(async(input:unknown)=>{if(String(input).includes('oauth2/v2.1/verify'))return new Response(JSON.stringify({sub:'Uf'}));throw new Error('unexpected_external_request');}));});
afterEach(()=>{d.raw.close();vi.useRealTimers();vi.unstubAllGlobals();});
test('B1-01 B1-03 B1-29 B1-32: 試験接続だけ有効化、版を守りliveを拒否',async()=>{
 expect((await save()).status).toBe(409);connect();expect((await save()).status).toBe(200);expect((await save()).status).toBe(409);
 d.raw.exec('UPDATE booking_payment_connections SET test_mode=0');expect((await gapCall(app(),path,'PUT',{...policy,expectedVersion:1})).status).toBe(409);
});
test.each([
 [{beforeHours:24,percent:0},{beforeHours:12,percent:50}],
 [{beforeHours:24,percent:0},{beforeHours:24,percent:50},{beforeHours:0,percent:100}],
 [{beforeHours:24,percent:0},{beforeHours:0,percent:101}],
].map(tiers=>({tiers})))('B1-02: 穴・重複・100パーセント超の段を保存しない %j',async ({tiers})=>{connect();expect((await gapCall(app(),path,'PUT',{...policy,tiers})).status).toBe(400);expect(d.raw.prepare('SELECT COUNT(*) n FROM booking_cancellation_policies').get()).toEqual({n:0});});
test('B1-12 B1-13 B1-24: 無料の取消は請求なし、期限後は予約時の50パーセント',async()=>{
 connect();await save();seedGapBooking(d,'free');d.raw.exec("UPDATE bookings SET status='cancelled',decided_at='2026-11-18T05:00:00Z' WHERE id='free'");expect(d.raw.prepare('SELECT COUNT(*) n FROM booking_charges').get()).toEqual({n:0});
 seedGapBooking(d);await gapCall(app(),path,'PUT',{...policy,tiers:[{beforeHours:24,percent:0},{beforeHours:0,percent:100}],expectedVersion:1});cancel();
 expect(d.raw.prepare('SELECT amount,status FROM booking_charges WHERE booking_id=?').get('bk')).toEqual({amount:4200,status:'pending'});
 const snapshot=JSON.parse((d.raw.prepare('SELECT policy_snapshot_json FROM bookings WHERE id=?').get('bk') as any).policy_snapshot_json);
 expect(cancellationQuote(snapshot,'2026-11-20T05:00:00Z',8400,new Date('2026-11-20T04:00:00Z')).feeNow).toBe(4200);
});
test('B1-14 B1-15 B1-17: 計算以上の額を拒否、2人同時でも模擬請求は1回',async()=>{
 connect();await save();seedGapBooking(d);cancel();
 const chargePath='/api/booking/admin/bookings/bk/charges?account_id=a';
 expect((await gapCall(app(),chargePath,'POST',{...chargeBody(),amount:8400})).status).toBe(400);
 expect((await gapCall(app(),chargePath,'POST',chargeBody())).status).toBe(409);
 d.raw.exec("INSERT INTO booking_payment_methods(id,friend_id,line_account_id,setup_id,idempotency_key,status,created_at) VALUES('pm','f','a','seti_test','key','ready',datetime('now'))");
 const rs=await Promise.all([gapCall(app(),chargePath,'POST',chargeBody()),gapCall(app(),chargePath,'POST',chargeBody())]);expect(rs.map(r=>r.status).sort()).toEqual([200,409]);
 expect(d.raw.prepare('SELECT COUNT(*) n FROM booking_cancellation_events').get()).toEqual({n:1});expect(vi.mocked(fetch)).not.toHaveBeenCalled();
});
test('B1-16 B1-18 B1-19: 理由つき免除・全額模擬返金・スタッフの返金禁止',async()=>{
 connect();await save();seedGapBooking(d);cancel();let row=d.raw.prepare('SELECT id FROM booking_charges').get() as any;
 expect((await gapCall(app(),`/api/booking/admin/charges/${row.id}/waive?account_id=a`,'POST',{reason:'',expectedVersion:1})).status).toBe(400);
 expect((await gapCall(app(),`/api/booking/admin/charges/${row.id}/waive?account_id=a`,'POST',{reason:'店の判断',expectedVersion:1})).status).toBe(200);
 d.raw.prepare("UPDATE booking_charges SET status='succeeded' WHERE id=?").run(row.id);
 const refund=`/api/booking/admin/charges/${row.id}/refund?account_id=a`,body={reason:'返金',expectedVersion:2,confirmed:true,confirmedIrreversible:true};
 expect((await gapCall(gapApp(d,[bookingCancellation],{...gapOwner,id:'s',role:'staff'}),refund,'POST',body)).status).toBe(403);
 expect((await gapCall(app(),refund,'POST',{...body,confirmedIrreversible:false})).status).toBe(400);
 expect((await gapCall(app(),refund,'POST',body)).status).toBe(200);expect((await gapCall(app(),refund,'POST',body)).status).toBe(409);
});
test('B1-08 B1-11: 本人のカード登録を1件にし、署名なしの完了は拒否',async()=>{
 connect();await save();
 if (!d.raw.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='booking_card_checkout_requests'").get()) d.raw.exec(readFileSync('../../packages/db/migrations/774_booking_card_checkout_requests.sql','utf8'));
 d.raw.exec("UPDATE booking_payment_connections SET provider_account_id='acct_test123'; UPDATE line_accounts SET liff_id='1234567890-abcdef' WHERE id='a'");
 vi.stubGlobal('fetch',vi.fn(async(input:unknown)=>{if(String(input).includes('oauth2/v2.1/verify'))return Response.json({sub:'Uf'});if(String(input).endsWith('/customers'))return Response.json({id:'cus_card',livemode:false});if(String(input).endsWith('/checkout/sessions'))return Response.json({id:'cs_test_abc',url:'https://checkout.stripe.com/c/pay/cs_test_abc',livemode:false});throw new Error('unexpected_external_request');}));
 const key=crypto.randomUUID(),url='/api/liff/booking/setup-intent?liffId=1234567890-abcdef',body={menuId:'menu',staffId:'bs',startsAt:'2026-12-01T05:00:00Z',partySize:1,policyAccepted:true};
 const request=()=>gapApp(d,[bookingCancellation],gapOwner,false,{BOOKING_STRIPE_TEST_SECRET_KEY:'sk_test_example'}).request(url,{method:'POST',headers:{Authorization:'Bearer token','Content-Type':'application/json','Idempotency-Key':key},body:JSON.stringify(body)});
 expect((await request()).status).toBe(201);expect((await request()).status).toBe(201);expect(d.raw.prepare('SELECT COUNT(*) n FROM booking_payment_methods').get()).toEqual({n:1});
 expect((await gapCall(app(),'/api/liff/booking/setup-webhook','POST',{livemode:false})).status).toBe(401);
 expect(d.raw.prepare('SELECT status FROM booking_payment_methods').get()).toEqual({status:'pending'});
});
test('B1-04 B1-05 Q-01: 閲覧のみ・スタッフ・代理で設定を変えず、お金は代理で操作不可',async()=>{
 connect();for(const [who,im] of [[{...gapOwner,readOnly:true},false],[{...gapOwner,id:'s',role:'staff' as const},false],[gapOwner,true]] as const){expect((await gapCall(gapApp(d,[bookingCancellation],who,im),path,'PUT',policy)).status).toBe(403);}
 expect((await gapCall(app(),'/api/booking/admin/cancellation-policy?account_id=b')).status).toBe(404);
});
test('B1-26: 店が断った取消には請求を作らない、取消の巻戻しでも請求しない',async()=>{
 connect();await save();seedGapBooking(d);d.raw.exec("UPDATE bookings SET cancellation_reason='store',status='cancelled',decided_at='2026-11-20T04:00:00Z' WHERE id='bk'");expect(d.raw.prepare('SELECT COUNT(*) n FROM booking_charges').get()).toEqual({n:0});
 seedGapBooking(d,'revert');d.raw.exec("UPDATE bookings SET status='cancelled',decided_at='2026-11-20T04:00:00Z' WHERE id='revert'; UPDATE bookings SET status='confirmed' WHERE id='revert'");expect(d.raw.prepare('SELECT status,reason FROM booking_charges WHERE booking_id=?').get('revert')).toEqual({status:'waived',reason:'cancellation_reverted'});
});
test('B1-08: 署名が正しい試験の完了通知だけでカードを登録済みにする',async()=>{
 const {createHmac}=await import('node:crypto');connect();await save();d.raw.exec("INSERT INTO booking_payment_methods(id,friend_id,line_account_id,setup_id,idempotency_key,created_at) VALUES('pm','f','a','seti_test_callback','key',datetime('now'))");
 const body=JSON.stringify({livemode:false,type:'setup_intent.succeeded',data:{object:{livemode:false,id:'seti_test_callback',customer:'cus_test',payment_method:'pm_test',status:'succeeded'}}});
 const t=Math.floor(Date.now()/1000),sig=createHmac('sha256','test-webhook-secret').update(`${t}.${body}`).digest('hex');
 const r=await app().request('/api/liff/booking/setup-webhook',{method:'POST',headers:{'stripe-signature':`t=${t},v1=${sig}`},body});expect(r.status).toBe(200);expect(d.raw.prepare('SELECT status FROM booking_payment_methods').get()).toEqual({status:'ready'});
});
test('B1-07 B1-08 B1-24: 実際のLIFF予約口も同意なしと古い決まりの版を拒否する',async()=>{
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-11-16T00:00:00Z'));
 connect();await save();const {default:booking}=await import('./booking.js');
 const a=gapApp(d,[booking]);const request=(b:unknown)=>a.request('/api/liff/booking/requests?liffId=liff-a',{method:'POST',headers:{Authorization:'Bearer token','Content-Type':'application/json','Idempotency-Key':crypto.randomUUID()},body:JSON.stringify(b)});
 const b={menu_id:'menu',staff_id:'bs',starts_at:'2026-11-20T05:00:00Z'};
 const r=await request(b);expect(r.status).toBe(400);expect(await r.json()).toMatchObject({error:'policy_acceptance_required'});
 const old=await request({...b,policyAccepted:true,policyVersion:0,setupIntentId:'not-ready'});expect(old.status).toBe(409);expect(await old.json()).toMatchObject({error:'policy_changed'});expect(d.raw.prepare('SELECT COUNT(*) n FROM bookings').get()).toEqual({n:0});
});
test('B1-12 B1-13: LIFFで金額への同意前は取消せず、期限後も同意付きで取り消せる',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-20T04:00:00Z'));
 try {
 connect();await save();seedGapBooking(d);const {default:booking}=await import('./booking.js');const a=gapApp(d,[booking]);
 const cancel=(extra:Record<string,unknown>)=>a.request('/api/liff/booking/bk/cancel?liffId=liff-a',{method:'POST',headers:{Authorization:'Bearer token','Content-Type':'application/json'},body:JSON.stringify({lock_version:0,...extra})});
 const no=await cancel({});expect(no.status).toBe(409);expect(await no.json()).toMatchObject({error:'cancellation_fee_confirmation_required',data:{feeNow:4200}});
 const stale=await cancel({feeAccepted:true,expectedFeeAmount:0});expect(stale.status).toBe(409);
 for(const feeAccepted of [false,'true',undefined])expect((await cancel({feeAccepted,expectedFeeAmount:4200})).status).toBe(409);
 expect(d.raw.prepare("SELECT COUNT(*) n FROM booking_charges WHERE booking_id='bk'").get()).toEqual({n:0});
 expect((d.raw.prepare("SELECT status FROM bookings WHERE id='bk'").get() as any).status).toBe('confirmed');
 const yes=await cancel({feeAccepted:true,expectedFeeAmount:4200});expect(yes.status).toBe(200);expect(await yes.json()).toMatchObject({status:'cancelled',feeNow:4200});
 expect(d.raw.prepare("SELECT amount,status FROM booking_charges WHERE booking_id='bk'").get()).toEqual({amount:4200,status:'pending'});
 }finally{vi.useRealTimers();}
});
test('取消の見積もりは本人の版と有料の期限を返し、他人の予約を見せない',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-20T04:00:00Z'));
 try{
  connect();await save();seedGapBooking(d);const a=app();
  const read=(id:string)=>a.request(`/api/liff/booking/cancellation-quote?liffId=liff-a&booking_id=${id}`,{headers:{Authorization:'Bearer token'}});
  const res=await read('bk');expect(res.status).toBe(200);expect(await res.json()).toMatchObject({data:{feeNow:4200,canCancel:true,lockVersion:0,cancelDeadlineAt:'2026-11-20T05:00:00Z'}});
  d.raw.exec("UPDATE bookings SET friend_id='f2' WHERE id='bk'");expect((await read('bk')).status).toBe(404);
 }finally{vi.useRealTimers();}
});
test('見積もりと取消は開始ちょうどを期限切れとし、同意不足へ誘導しない',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-20T05:00:00Z'));
 try{
  connect();await save();seedGapBooking(d);const {default:booking}=await import('./booking.js');const a=gapApp(d,[booking,bookingCancellation]);
  const read=await a.request('/api/liff/booking/cancellation-quote?liffId=liff-a&booking_id=bk',{headers:{Authorization:'Bearer token'}});
  expect(await read.json()).toMatchObject({data:{canCancel:false}});
  const res=await a.request('/api/liff/booking/bk/cancel?liffId=liff-a',{method:'POST',headers:{Authorization:'Bearer token','Content-Type':'application/json'},body:JSON.stringify({lock_version:0})});
  expect(res.status).toBe(403);expect(await res.json()).toMatchObject({error:'self_deadline_passed'});
  expect(d.raw.prepare("SELECT status FROM bookings WHERE id='bk'").get()).toEqual({status:'confirmed'});
 }finally{vi.useRealTimers();}
});
test('料金なしの見積もりは店の取消期限を守り、期限ちょうどだけ許す',async()=>{
 vi.useFakeTimers();
 try{
  connect();await save();seedGapBooking(d);d.raw.exec("UPDATE bookings SET policy_snapshot_json=NULL WHERE id='bk'");
  const read=()=>app().request('/api/liff/booking/cancellation-quote?liffId=liff-a&booking_id=bk',{headers:{Authorization:'Bearer token'}});
  vi.setSystemTime(new Date('2026-11-19T05:00:00Z'));expect(await (await read()).json()).toMatchObject({data:{feeNow:0,canCancel:true,cancelDeadlineAt:'2026-11-19T05:00:00.000Z'}});
  vi.setSystemTime(new Date('2026-11-19T05:00:00.001Z'));expect(await (await read()).json()).toMatchObject({data:{feeNow:0,canCancel:false}});
 }finally{vi.useRealTimers();}
});
test('B1-13 B1-24: 期限ちょうどは無料、開始後の取消と巻戻し後の再取消も同じ計算',async()=>{
 connect();await save();seedGapBooking(d,'edge');d.raw.exec("UPDATE bookings SET status='cancelled',decided_at='2026-11-19T05:00:00Z' WHERE id='edge'");expect(d.raw.prepare("SELECT COUNT(*) n FROM booking_charges WHERE booking_id='edge'").get()).toEqual({n:0});
 seedGapBooking(d);cancel('2026-11-20T06:00:00Z');expect((d.raw.prepare("SELECT amount FROM booking_charges WHERE booking_id='bk'").get() as any).amount).toBe(4200);
 d.raw.exec("UPDATE bookings SET status='confirmed' WHERE id='bk'");cancel('2026-11-20T06:30:00Z');expect(d.raw.prepare("SELECT amount,status FROM booking_charges WHERE booking_id='bk'").get()).toEqual({amount:4200,status:'pending'});
});
test('B1-13 B7-24 GAP3-INTEGRATION-02: 本人の予約履歴に取消前の額・支払い・会議URL・終了を返し、申込中のURLを隠す',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-20T04:00:00Z'));
 try{
 connect();await save();d.raw.exec("UPDATE menus SET meeting_mode='online',fixed_meeting_url='https://example.test/meeting' WHERE id='menu'");seedGapBooking(d);seedGapBooking(d,'pending','requested');
 d.raw.exec(`INSERT INTO booking_payments(id,line_account_id,booking_id,amount,status,provider,provider_payment_id,idempotency_key,created_at,updated_at,refunded_amount)
   VALUES('paid','a','bk',8400,'paid','stripe','pi_test_history','history','2026-11-19T00:00:00Z','2026-11-19T00:00:00Z',300)`);
 const {default:booking}=await import('./booking.js');const r=await gapApp(d,[booking]).request('/api/liff/booking/me?liffId=liff-a',{headers:{Authorization:'Bearer token'}});
 expect(r.status).toBe(200);const data=await r.json() as any,confirmed=data.upcoming.find((r:any)=>r.id==='bk'),pending=data.upcoming.find((r:any)=>r.id==='pending');
 expect(confirmed).toMatchObject({meeting_url:'https://example.test/meeting',ends_at:'2026-11-20T06:00:00.000Z',cancellationQuote:{feeNow:4200},cancel_deadline_at:'2026-11-20T05:00:00Z'});
 expect(confirmed.payment).toMatchObject({method:'online',status:'partially_refunded',amount:8400,refundedAmount:300});
 expect(pending.meeting_url).toBeNull();expect(confirmed).not.toHaveProperty('policy_snapshot_json');
 expect(confirmed).not.toHaveProperty('price_at_booking');expect(confirmed).not.toHaveProperty('ticket');
 }finally{vi.useRealTimers();}
});
test('B7-14 B7-15: カレンダーが切れた知らせは1回、つなぎ直すと解決にする',async()=>{
 const {evaluateBookingSyncNotices}=await import('../features/booking/booking-sync-rules.js');
 d.raw.exec("INSERT INTO booking_calendar_switches(line_account_id,scope_id,read_enabled,updated_by,updated_at) VALUES('a','',1,'o',datetime('now')),('a','bs',1,'o',datetime('now'));INSERT INTO booking_calendar_read_health(line_account_id,staff_id,failed_since,error_code) VALUES('a','bs',datetime('now'),'calendar_disconnected')");
 const env={DB:d.db} as import('../index.js').Env['Bindings'];await evaluateBookingSyncNotices(env,'a');await evaluateBookingSyncNotices(env,'a');
 expect(d.raw.prepare("SELECT status,generation FROM booking_sync_notices WHERE notice_key='calendar-read:bs'").get()).toEqual({status:'open',generation:1});expect(d.raw.prepare('SELECT COUNT(*) n FROM booking_sync_notice_outbox').get()).toEqual({n:1});
 d.raw.exec('UPDATE booking_calendar_read_health SET error_code=NULL,failed_since=NULL');await evaluateBookingSyncNotices(env,'a');expect(d.raw.prepare("SELECT status FROM booking_sync_notices WHERE notice_key='calendar-read:bs'").get()).toEqual({status:'resolved'});
});
