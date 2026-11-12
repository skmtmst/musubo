import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../worker-env.js';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';
import { seedAssignmentFixture } from '../test-utils/assignment-fixture.js';
import { paymentRecords, paymentSummary } from '../features/booking/booking-payment-admin.js';
import { customerBookingPayments } from '../features/booking/booking-payment-history.js';
import { receivePaymentEvent, processPaymentEvent } from '../features/booking/booking-payment-events.js';
import { unhandledWorkerError } from '../lib/unhandled-error.js';
const report = vi.hoisted(() => vi.fn(async () => false));
vi.mock('../services/codex-slack-relay.js', () => ({ reportHarnessErrorToSlack: report }));
const scope=vi.hoisted(()=>({allowed:true}));
vi.mock('../services/account-access.js',()=>({canAccessAllLineAccounts:vi.fn(async()=>scope.allowed)}));
import { bookingPayments } from './booking-payments.js';
let f:SqliteD1, role:'owner'|'admin'|'staff'='owner', readOnly=false;
const input={amount:300,reason:'一部の提供を取り消し',notifyLine:true,idempotencyKey:'request-1'};
const now=new Date('2026-10-16T05:00:00Z');
function request(part='refund',body:unknown=input,method='POST',payment='p') {
  const app=new Hono<Env>();
  app.use('*',async(c,next)=>{c.set('staff',{id:'s1',name:'担当 甲',role,readOnly});await next();});
  app.route('/',bookingPayments);
  app.onError(unhandledWorkerError);
  return app.request(`/api/booking/payments/${payment}/${part}`,{method,
    ...(method==='GET'?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})},{DB:f.db} as Env['Bindings']);
}
function booking(id='bk',account='a',start='2030-01-01T03:00:00Z') {
  f.raw.prepare(`INSERT INTO bookings(id,line_account_id,friend_id,staff_id,menu_id,starts_at,ends_at,block_ends_at,status,price_at_booking,requested_at)
    VALUES(?,?,?,?,?,?,?,?,'confirmed',1000,'2026-10-16T00:00:00Z')`)
    .run(id,account,'f','s1','m',start,start,start);
}
function payment(id='p',bookingId:string|null='bk') {
  f.raw.prepare(`INSERT INTO booking_payments(id,line_account_id,booking_id,amount,status,provider,provider_payment_id,idempotency_key,created_at,updated_at,paid_at)
    VALUES(?,'a',?,1000,'paid','stripe',?,?,'2026-10-16T00:00:00Z','2026-10-16T00:00:00Z','2026-10-16T00:00:00Z')`)
    .run(id,bookingId,'pi_test_'+id,id);
}
const state=()=>f.raw.prepare('SELECT status,refunded_amount FROM booking_payments WHERE id=\'p\'').get();
beforeEach(()=>{
  vi.useFakeTimers();vi.setSystemTime(now);vi.stubGlobal('fetch',vi.fn(()=>{throw new Error('外部通信は禁止');}));
  f=createTestD1({foreignKeys:true});seedAssignmentFixture(f);
  f.raw.exec("INSERT INTO friends(id,line_user_id,line_account_id,is_following) VALUES('f','Uf','a',1)");
  booking();payment();role='owner';readOnly=false;scope.allowed=true;
});
afterEach(()=>{f.raw.close();vi.useRealTimers();vi.unstubAllGlobals();});

describe('模擬の部分返金と監査',()=>{
  it('確認した版が古い返金は記録せず、同一要求の再送は成功する', async()=>{
    const confirmed={...input,expectedRevision:1};
    expect((await request('refund',confirmed)).status).toBe(200);
    expect(f.raw.prepare("SELECT confirmation_revision FROM booking_payments WHERE id='p'").get()).toEqual({confirmation_revision:2});
    expect((await request('refund',confirmed)).status).toBe(200);
    const stale=await request('refund',{...input,idempotencyKey:'stale',expectedRevision:1});
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({code:'stale_confirmation'});
    expect(state()).toEqual({status:'paid',refunded_amount:300});
    expect(f.raw.prepare('SELECT COUNT(*) n FROM booking_payment_refunds').get()).toEqual({n:1});
    expect((await request('refund',{...input,idempotencyKey:'next',expectedRevision:2})).status).toBe(200);
  });
  it('同じ版を見た別の返金は同時に一つだけ通す',async()=>{
    const responses=await Promise.all(['one','two'].map(idempotencyKey=>request('refund',{...input,idempotencyKey,expectedRevision:1})));
    expect(responses.map(r=>r.status).sort()).toEqual([200,409]);
    expect(f.raw.prepare("SELECT confirmation_revision FROM booking_payments WHERE id='p'").get()).toEqual({confirmation_revision:2});
    expect(state()).toEqual({status:'paid',refunded_amount:300});
  });
  it.each([0,-1,1.5,'1',null])('不正な版 %s は受け付けない',async expectedRevision=>{
    expect((await request('refund',{...input,expectedRevision})).status).toBe(400);
    expect(state()).toEqual({status:'paid',refunded_amount:0});
  });
  it('一部返金・理由・操作した人と通知希望を保存し、再送は一度だけ。全額まで残額を返せる',async()=>{
    const first=await request();expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({data:{payment:{status:'paid',refunded_amount:300},
      refund:{amount:300,reason:input.reason,actorLabel:'担当 甲',notificationStatus:'simulated',sent:false},simulation:true,sent:false}});
    expect((await request()).status).toBe(200);expect(state()).toEqual({status:'paid',refunded_amount:300});
    const all=await request('refund',{reason:'残り全部',idempotencyKey:'request-2'});expect(all.status).toBe(200);
    expect(state()).toEqual({status:'refunded',refunded_amount:1000});
    expect((await request('refund',{reason:'残り全部',idempotencyKey:'request-2'})).status).toBe(200);
    expect((await request('refund',{...input,idempotencyKey:'request-3'})).status).toBe(409);
    const history=await request('refunds',undefined,'GET');
    expect(await history.json()).toMatchObject({data:{items:expect.arrayContaining([{id:expect.any(String),amount:300,reason:input.reason,
      actorLabel:'担当 甲',createdAt:now.toISOString(),notifyLine:true,notificationStatus:'simulated',simulation:true,sent:false}])}});
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([{}, {...input,reason:''},{...input,reason:' '.repeat(3)},{...input,reason:'x'.repeat(501)},
    {...input,amount:0},{...input,amount:-1},{...input,amount:1.5},{...input,amount:'300'},
    {...input,notifyLine:'true'},{...input,idempotencyKey:''},null,[]])('入力不正は記録を変更しない（%j）',async body=>{
    expect((await request('refund',body)).status).toBe(400);expect(state()).toEqual({status:'paid',refunded_amount:0});
  });
  it('残額を超えた要求と、同じキーで別の額・理由・通知希望は409',async()=>{
    await request();
    for(const body of [{...input,amount:301},{...input,reason:'違う'},{...input,notifyLine:false},
      {...input,amount:701,idempotencyKey:'next'}]) expect((await request('refund',body)).status).toBe(409);
    expect(state()).toEqual({status:'paid',refunded_amount:300});
  });
  it('同時操作でも残額を超えず、同じ要求も重ねない',async()=>{
    expect((await Promise.all([request(),request()])).map(r=>r.status)).toEqual([200,200]);
    expect(state()).toEqual({status:'paid',refunded_amount:300});
    const results=await Promise.all(['a','b'].map(key=>request('refund',{...input,amount:500,idempotencyKey:key})));
    expect(results.map(r=>r.status).sort()).toEqual([200,409]);expect(state()).toEqual({status:'paid',refunded_amount:800});
    expect(f.raw.prepare('SELECT COUNT(*) n FROM booking_payment_refunds').get()).toEqual({n:2});
  });
  it('履歴または残額の保存が失敗したら両方戻し、再送で回復する',async()=>{
    f.raw.exec("CREATE TRIGGER crash BEFORE UPDATE OF refunded_amount ON booking_payments BEGIN SELECT RAISE(ABORT,'private-customer-error'); END");
    const r=await request();expect(r.status).toBe(500);
    const body = await r.json<{ incidentId: string }>();
    expect(body.incidentId).toMatch(/^[0-9a-f-]{36}$/);
    expect(report).toHaveBeenCalledExactlyOnceWith(expect.anything(), expect.objectContaining({ incidentId: body.incidentId }));
    expect(JSON.stringify(body)).not.toContain('private-customer-error');
    expect(state()).toEqual({status:'paid',refunded_amount:0});
    expect(f.raw.prepare('SELECT COUNT(*) n FROM booking_payment_refunds').get()).toEqual({n:0});
    f.raw.exec('DROP TRIGGER crash');expect((await request()).status).toBe(200);
  });
  it('未移行は503。閲覧のみと一般スタッフは保存不可、別店も不可',async()=>{
    readOnly=true;expect((await request()).status).toBe(403);readOnly=false;
    role='staff';expect((await request()).status).toBe(403);role='owner';
    scope.allowed=false;expect((await request()).status).toBe(404);scope.allowed=true;
    expect((await request('refund',input,'POST','missing')).status).toBe(404);
    f.raw.exec('DROP TABLE booking_payment_refunds');const r=await request();expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({code:'payment_refund_storage_not_ready'});
  });
  it.each(["provider_payment_id='pi_live_real'","currency='USD'","status='pending'",
    "provider='other'"])('本番・別サービス・未入金には模擬返金しない（%s）',async change=>{
    f.raw.exec('UPDATE booking_payments SET '+change);expect((await request()).status).toBe(409);expect(fetch).not.toHaveBeenCalled();
  });
  it('本番の接続情報がある店は拒否し、未連結の支払いは通知先なしで返金できる',async()=>{
    f.raw.exec("INSERT INTO booking_payment_connections(line_account_id,provider,provider_account_id,test_mode,connected_at) VALUES('a','stripe','acct_real',0,'2026-10-01')");
    const live=await request(); expect(live.status).toBe(409); expect(await live.json()).toMatchObject({code:'simulation_only'});
    f.raw.exec('DELETE FROM booking_payment_connections; UPDATE booking_payments SET booking_id=NULL');
    expect(await (await request()).json()).toMatchObject({data:{refund:{notificationStatus:'unavailable',sent:false}}});
  });
  it('GAP3-INTEGRATION-01: 今日・担当別の入金と部分返金を同じ範囲で集計する',async()=>{
    expect((await request()).status).toBe(200);
    expect(await paymentSummary(f.db,'a',now,'today','s1')).toMatchObject({paidAmount:1000,refundedAmount:300,refundedCount:1});
    expect(await paymentSummary(f.db,'a',now,'today','s2')).toMatchObject({paidAmount:0,refundedAmount:0,refundedCount:0});
    expect(await paymentSummary(f.db,'a',new Date('2026-10-17T04:00:00Z'),'today','s1')).toMatchObject({paidAmount:0,refundedAmount:0,refundedCount:0});
    expect(fetch).not.toHaveBeenCalled();
  });
  it('返金額・操作者を一覧/CSV用の値に返し、月次は入金総額と返金増分を分ける',async()=>{
    await request();
    const page=await paymentRecords(f.db,'a',{q:'',status:'partially_refunded',method:'',period:'month',limit:20,offset:0},now);
    expect(page).toMatchObject({total:1,items:[{status:'partially_refunded',refundedAmount:300,actorLabel:'担当 甲',reason:input.reason}]});
    expect(await paymentSummary(f.db,'a',now)).toMatchObject({paidAmount:1000,refundedAmount:300,refundedCount:1});
    vi.setSystemTime(new Date('2026-11-02T00:00:00Z'));
    await request('refund',{reason:'翌月に残額',idempotencyKey:'next'});
    expect(await paymentSummary(f.db,'a',now)).toMatchObject({paidAmount:1000,refundedAmount:300,refundedCount:1});
    expect(await paymentSummary(f.db,'a',new Date())).toMatchObject({paidAmount:0,refundedAmount:700,refundedCount:1});
  });
});

describe('予約連結と本人の支払い表示',()=>{
  it('同じ店の未連結の支払いを予約に結び、履歴に残す。入金・予約状態は変えない',async()=>{
    f.raw.exec('UPDATE booking_payments SET booking_id=NULL');
    const body={bookingId:'bk',reason:'入金を照合'};
    expect((await request('booking',body)).status).toBe(200);
    expect((await request('booking',body)).status).toBe(200);
    expect(f.raw.prepare('SELECT COUNT(*) n FROM booking_payment_booking_links').get()).toEqual({n:1});
    expect(f.raw.prepare('SELECT actor_label,reason FROM booking_payment_booking_links').get()).toEqual({actor_label:'担当 甲',reason:body.reason});
    expect(state()).toEqual({status:'paid',refunded_amount:0});
    expect(f.raw.prepare("SELECT status FROM bookings WHERE id='bk'").get()).toEqual({status:'confirmed'});
  });
  it('別店・重複した支払い・連結済み・店払い・回数券への誤連結を拒否する',async()=>{
    booking('other','b');expect((await request('booking',{bookingId:'other',reason:'照合'})).status).toBe(404);
    booking('new');expect((await request('booking',{bookingId:'new',reason:'照合'})).status).toBe(409);
    payment('standalone',null);
    expect((await request('booking',{bookingId:'bk',reason:'照合'},'POST','standalone')).status).toBe(409);
    f.raw.exec("INSERT INTO booking_payment_choices VALUES('new','a','onsite','onsite',10)");
    expect((await request('booking',{bookingId:'new',reason:'照合'},'POST','standalone')).status).toBe(409);
    readOnly=true;expect((await request('booking',{bookingId:'bk',reason:'照合'})).status).toBe(403);
  });
  it('連結更新の途中失敗は履歴も戻し、理由なしは拒否する',async()=>{
    f.raw.exec("UPDATE booking_payments SET booking_id=NULL; CREATE TRIGGER link_crash BEFORE UPDATE OF booking_id ON booking_payments BEGIN SELECT RAISE(ABORT,'crash'); END");
    const failed = await request('booking',{bookingId:'bk',reason:'照合'});
    expect(failed.status).toBe(500);
    const body = await failed.json<{ incidentId: string }>();
    expect(body.incidentId).toMatch(/^[0-9a-f-]{36}$/);
    expect(report).toHaveBeenCalledExactlyOnceWith(expect.anything(), expect.objectContaining({ incidentId: body.incidentId }));
    expect(f.raw.prepare('SELECT COUNT(*) n FROM booking_payment_booking_links').get()).toEqual({n:0});
    expect((await request('booking',{bookingId:'bk',reason:''})).status).toBe(400);
  });
  it('LIFF用には保存済みの店払い・金額・安全な領収書・部分返金だけを返す',async()=>{
    f.raw.exec("UPDATE booking_payments SET receipt_url='https://pay.stripe.com/receipts/test'");await request();
    booking('onsite');f.raw.exec("INSERT INTO booking_payment_choices VALUES('onsite','a','onsite','onsite',10)");
    const map=await customerBookingPayments(f.db,'a','f');
    expect(map.get('bk')).toEqual({method:'online',status:'partially_refunded',amount:1000,currency:'JPY',refundedAmount:300,receiptUrl:'https://pay.stripe.com/receipts/test'});
    expect(map.get('onsite')).toMatchObject({method:'onsite',status:'onsite',amount:1000,receiptUrl:null});
    expect((await customerBookingPayments(f.db,'b','f')).size).toBe(0);
    expect((await customerBookingPayments(f.db,'a','someone-else')).size).toBe(0);
    f.raw.exec("UPDATE booking_payments SET receipt_url='javascript:secret'");
    expect((await customerBookingPayments(f.db,'a','f')).get('bk')?.receiptUrl).toBeNull();
  });
  it('通知の累計額は順不同・再読込・手動返金後でも重ねず、最後に全額返金となる',async()=>{
    const send=(amount:number,id:string)=>receivePaymentEvent(f.db,'stripe',{providerPaymentId:'pi_test_p',providerEventId:id,status:'refunded',amount:1000,refundedAmount:amount,currency:'JPY'},id);
    expect(await send(300,'e1')).toMatchObject({result:'applied'});
    expect(f.raw.prepare("SELECT confirmation_revision FROM booking_payments WHERE id='p'").get()).toEqual({confirmation_revision:2});
    expect((await request('refund',{...input,idempotencyKey:'before-event',expectedRevision:1})).status).toBe(409);
    expect(await send(200,'e0')).toMatchObject({status:'duplicate'});
    expect(state()).toEqual({status:'paid',refunded_amount:300});
    const event=f.raw.prepare("SELECT id FROM booking_payment_events WHERE provider_event_id='e1'").get() as {id:string};
    await processPaymentEvent(f.db,'a',event.id,'s1');
    expect((await request('refund',{...input,amount:200})).status).toBe(200);
    await send(500,'e2');expect(state()).toEqual({status:'paid',refunded_amount:500});
    await send(1000,'e3');expect(state()).toEqual({status:'refunded',refunded_amount:1000});
    expect(await paymentSummary(f.db,'a',now)).toMatchObject({refundedAmount:1000,refundedCount:1});
  });
});
