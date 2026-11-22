import { useSqliteClock } from '../../../test-utils/sqlite-clock.js';
import { createHmac } from 'node:crypto';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tenantScopeCondition } from '@line-crm/db';
import {redactCustomerWorkflows} from '../../../services/customer-workflow-redaction.js';
import { gapFixture } from '../../../test-utils/gap1.js';
import { bookingStripeWebhook } from '../../../routes/booking-stripe-webhook.js';
import { authMiddleware } from '../../../middleware/auth.js';
import { isPublicApiBoundary } from '../../../middleware/public-api-boundary.js';
import { applyBookingStripeReceipt, listPendingBookingStripeReceipts, normalizeBookingStripeEvent,
  prepareBookingStripeBinding, purgeUnboundBookingStripeReceipts, markOverdueBookingStripeReceipts, storeBookingStripeReceipt, stripeReceiptDigest,
  type BookingStripeBinding } from './index.js';
import type { Env } from '../../../worker-env.js';
const secret = 'whsec_connect_fixture_only';
const path = '/api/booking/stripe-test/webhook';
let f: ReturnType<typeof gapFixture>;
const event = () => ({id:'evt_paid',account:'acct_original',api_version:'2024-06-20',created:Math.floor(Date.now()/1000),
  type:'invoice.paid',livemode:false,data:{object:{id:'in_month',object:'invoice',livemode:false,status:'paid',
    amount_due:4200,currency:'jpy',customer:'cus_person',period_start:1793491200,period_end:1796083200,
    customer_email:'private@example.invalid',metadata:{credential:'do-not-save'}}}});
const binding = (): BookingStripeBinding => ({tenantId:'t',accountId:'a',friendId:'f',purpose:'monthly_invoice',targetId:'month',
  connectAccount:'acct_original',objectId:'in_month',objectKind:'invoice',amount:4200,currency:'jpy',customerId:'cus_person'});
function signature(raw: string, time = Math.floor(Date.now()/1000), key = secret) {
  return `t=${time},v1=${createHmac('sha256',key).update(`${time}.${raw}`).digest('hex')}`;
}
function app() { const a = new Hono<Env>(); a.use('*',authMiddleware); a.route('/',bookingStripeWebhook); return a; }
async function send(value: unknown, options: {raw?: string; signature?: string; key?: string; configured?: boolean} = {}) {
  const raw = options.raw ?? JSON.stringify(value);
  return app().request(path,{method:'POST',headers:{'stripe-signature':options.signature ?? signature(raw,undefined,options.key)},body:raw},
    {DB:f.db,STRIPE_TEST_WEBHOOK_SECRET:secret,...(options.configured === false ? {} : {BOOKING_STRIPE_TEST_CONNECT_WEBHOOK_SECRET:secret})} as never);
}
async function store(value = event()) { return storeBookingStripeReceipt(f.db,normalizeBookingStripeEvent(value),await stripeReceiptDigest(JSON.stringify(value))); }
async function bind(value = binding()) { await f.db.batch(prepareBookingStripeBinding(f.db,value)); }
async function effect({event:e}: {event: {type:string}}) {
  return [f.db.prepare(`UPDATE effects SET state=CASE WHEN state='paid' THEN state ELSE ? END,uses=CASE WHEN state='paid' OR ?<>'paid' THEN uses ELSE uses+1 END WHERE id='month'`)
    .bind(e.type==='invoice.paid'?'paid':'failed',e.type==='invoice.paid'?'paid':'failed')];
}
function rows() { return f.raw.prepare("SELECT status,attempt_count,error_code,input_json FROM workflow_steps WHERE process_kind='booking_stripe_webhook'").all() as {status:string;attempt_count:number;error_code:string|null;input_json:string}[]; }
beforeEach(() => {
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-10-31T03:00:00Z'));
  f=gapFixture();useSqliteClock(f.raw,()=>new Date());
  f.raw.exec("INSERT INTO booking_payment_connections(line_account_id,provider,provider_account_id,test_mode,connected_at) VALUES('a','stripe','acct_original',1,'2026-10-31'); CREATE TABLE effects(id TEXT PRIMARY KEY,state TEXT,uses INTEGER); INSERT INTO effects VALUES('month','pending',0)");
  vi.stubGlobal('fetch',vi.fn(async()=>{throw new Error('external_forbidden');}));
});
afterEach(()=>{expect(fetch).not.toHaveBeenCalled();f.raw.close();vi.unstubAllGlobals();vi.useRealTimers();});
describe('Connect試験受信の署名と保存',()=>{
  it('専用口のPOSTだけを公開し、管理認証なしでも署名は必須',async()=>{
    expect(isPublicApiBoundary('POST',path)).toBe(true);
    for(const method of ['GET','PUT','DELETE'])expect(isPublicApiBoundary(method,path)).toBe(false);
    expect(isPublicApiBoundary('POST',path+'/other')).toBe(false);
    expect((await send(event(),{signature:''})).status).toBe(401);
    expect((await send(event())).status).toBe(202);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({status:'pending',attempt_count:0});
    expect(rows()[0].input_json).not.toMatch(/private@example|do-not-save|metadata|customer_email/);
  });
  it('対象外の通知は対象objectのmodeが無くても保存せず受け流す',async()=>{
    const e={...event(),type:'customer.updated',data:{object:{id:'cus_person',object:'customer'}}};
    expect(await (await send(e)).json()).toMatchObject({data:{status:'ignored'}});expect(rows()).toHaveLength(0);
  });
  it('専用鍵が無ければ模擬の鍵へ戻さず、他の鍵の署名も拒む',async()=>{
    expect((await send(event(),{configured:false})).status).toBe(503);
    expect((await send(event(),{key:'whsec_other'})).status).toBe(401);
    expect(rows()).toHaveLength(0);
  });
  it.each([-301,301])('署名時刻が許容外なら保存しない %s',async offset=>{
    const e=event(),raw=JSON.stringify(e);
    expect((await send(e,{signature:signature(raw,Math.floor(Date.now()/1000)+offset)})).status).toBe(401);
    expect(rows()).toHaveLength(0);
  });
  it('生本文の改変・JSON不正を区別し、複数v1で鍵の切替を検証する',async()=>{
    const raw=JSON.stringify(event());
    expect((await send(null,{raw:raw+' ',signature:signature(raw)})).status).toBe(401);
    expect((await send(null,{raw:'{bad json'})).status).toBe(400);
    expect((await send(null,{raw,signature:signature(raw)+',v1='+'0'.repeat(64)})).status).toBe(202);
  });
  it.each([[true,false],[false,true],[undefined,false],[false,undefined]])('外側と対象のfalseが揃わなければ拒む %j %j',async(outer,inner)=>{
    const e=event();const v={...e,livemode:outer,data:{object:{...e.data.object,livemode:inner}}};
    expect((await send(v)).status).toBe(409);expect(rows()).toHaveLength(0);
  });
  it('本文は長さヘッダに頼らずstreamの256KiBで止める',async()=>{
    const response=await app().request(path,{method:'POST',headers:{'content-length':'1'},
      body:new ReadableStream({start(c){c.enqueue(new Uint8Array(256*1024));c.enqueue(new Uint8Array(1));c.close();}}),duplex:'half'} as RequestInit,{DB:f.db} as never);
    expect(response.status).toBe(413);expect(rows()).toHaveLength(0);
  });
  it('対応先が無い再送は回数を使わず、本文が違う同じIDだけ409',async()=>{
    const e=event();for(let i=0;i<8;i++){expect((await send(e)).status).toBe(202);expect(await applyBookingStripeReceipt(f.db,e.account,e.id,effect)).toBe('pending');}
    expect(rows()).toHaveLength(1);expect(rows()[0].attempt_count).toBe(0);
    expect((await send({...e,type:'invoice.payment_failed'})).status).toBe(409);
    expect((await listPendingBookingStripeReceipts(f.db,e.account,e.data.object.id))).toEqual([e.id]);
  });
  it('未知のAPI版は要確認を保存して反映せず、期間の欠落を30日で補わない',async()=>{
    const e={...event(),api_version:'2099-01-01'};
    expect(await (await send(e)).json()).toMatchObject({data:{status:'review_required'}});
    expect(await applyBookingStripeReceipt(f.db,e.account,e.id,effect)).toBe('review_required');
    expect(rows()[0].error_code).toBe('stripe_api_version_unsupported');
    expect(await listPendingBookingStripeReceipts(f.db,e.account,e.data.object.id)).toEqual([]);
    const o={...event().data.object,period_start:undefined,period_end:undefined};
    expect(normalizeBookingStripeEvent({...event(),data:{object:o}}).object).toMatchObject({periodStart:null,periodEnd:null});
  });
});
describe('保存済みの関連・lease・原子的な反映',()=>{
  it('決済関連に統括が無い時、接続先が変わっても別の統括のIDを混ぜない',async()=>{
    await bind();
    f.raw.exec(`UPDATE workflow_steps SET status='canceled',input_json=json_set(input_json,'$.tenantId',NULL),
      error_code='customer_deleted',customer_redaction_requested_at=1 WHERE process_kind='booking_stripe_object';
      UPDATE booking_payment_connections SET line_account_id='b' WHERE provider_account_id='acct_original'`);
    expect((await store()).status).toBe('review_required');
    const receipt=rows()[0]!;
    expect(JSON.parse(receipt.input_json)).toMatchObject({retentionAccountId:'a',retentionTenantId:null});
    expect(f.raw.prepare(`SELECT count(*) AS n FROM workflow_steps WHERE ${tenantScopeCondition('workflow_steps')}`).get('other')).toEqual({n:0});
  });
  it('顧客削除済みの決済関連への再受信は本文を保存せず要確認にする',async()=>{
    await bind();await store();
    f.raw.exec(`UPDATE workflow_steps SET customer_redaction_requested_at=1 WHERE process_kind IN ('booking_stripe_object','booking_stripe_webhook')`);
    await redactCustomerWorkflows(f.db,Date.now());
    expect((await store()).status).toBe('review_required');
    expect(await applyBookingStripeReceipt(f.db,'acct_original','evt_paid',effect)).toBe('review_required');
    expect((await store({...event(),id:'evt_after_delete'})).status).toBe('review_required');
    expect(await applyBookingStripeReceipt(f.db,'acct_original','evt_after_delete',effect)).toBe('review_required');
    const received=await send({...event(),id:'evt_http_after_delete'});
    expect(received.status).toBe(202);
    expect(await received.json()).toMatchObject({data:{status:'review_required'}});
    const review=f.raw.prepare("SELECT input_json FROM workflow_steps WHERE subject_id='evt_after_delete'").get() as {input_json:string};
    expect(JSON.parse(review.input_json)).toMatchObject({redacted:true,accounting:{eventType:'invoice.paid',objectId:'in_month',amount:4200,currency:'jpy'}});
    expect(review.input_json).not.toContain('cus_person');
    expect(JSON.parse(review.input_json)).toMatchObject({retentionAccountId:'a',retentionTenantId:'t'});
    expect(f.raw.prepare(`SELECT count(*) AS n FROM workflow_steps WHERE ${tenantScopeCondition('workflow_steps')}`).get('t')).toEqual({n:4});
    const saved=rows().find(row=>row.input_json.includes('redacted'))!;
    expect(saved.input_json).not.toContain('cus_person');
    expect(f.raw.prepare('SELECT uses FROM effects').get()).toEqual({uses:0});
  });
  it('顧客削除受付と決済の再受信が重なっても受信本文を残さない',async()=>{
    await bind();
    f.raw.prepare(`INSERT INTO operation_audit(id,target_kind,target_id,action,actor_id,friend_id,detail_json)
      VALUES ('customer-delete:friend_data:f','customer_deletion','f','deleting','owner','f',?)`).run(JSON.stringify({accountId:'a'}));
    expect((await store()).status).toBe('review_required');
    expect(rows()[0]).toMatchObject({status:'canceled',error_code:'customer_deleted'});
    expect(rows()[0]!.input_json).not.toContain('cus_person');
    expect(await applyBookingStripeReceipt(f.db,'acct_original','evt_paid',effect)).toBe('review_required');
  });
  it('受信が先でも、関連を保存してから同じ受信を一度だけ反映する',async()=>{
    await store();await bind();expect(await applyBookingStripeReceipt(f.db,'acct_original','evt_paid',effect)).toBe('applied');
    expect(await applyBookingStripeReceipt(f.db,'acct_original','evt_paid',effect)).toBe('duplicate');
    expect(f.raw.prepare('SELECT state,uses FROM effects').get()).toEqual({state:'paid',uses:1});
    expect((await send(event())).status).toBe(200);
  });
  it.each([{amount:1},{currency:'usd'},{customer:'cus_other'}])('金額・通貨・本人の不一致を適用しない %j',async change=>{
    await bind();const e=event();await store({...e,data:{object:{...e.data.object,...change,...('amount' in change?{amount_due:change.amount}:{})}}});
    expect(await applyBookingStripeReceipt(f.db,'acct_original','evt_paid',effect)).toBe('review_required');
    expect(f.raw.prepare('SELECT uses FROM effects').get()).toEqual({uses:0});
  });
  it('別のConnectへ届いた同じIDは元の店へ反映せず、再接続しても元の照合先を保つ',async()=>{
    await bind();await store({...event(),account:'acct_other'});
    expect(await applyBookingStripeReceipt(f.db,'acct_other','evt_paid',effect)).toBe('pending');
    f.raw.exec("UPDATE booking_payment_connections SET provider_account_id='acct_reconnected'");await store();
    expect(await applyBookingStripeReceipt(f.db,'acct_original','evt_paid',effect)).toBe('applied');
  });
  it('別のtenant・本人の関連を保存せず、同じ外部IDの用途や対象の付け替えも拒む',async()=>{
    await expect(bind({...binding(),tenantId:'other'})).rejects.toThrow();
    await expect(bind({...binding(),friendId:'missing'})).rejects.toThrow();
    await bind();await expect(bind({...binding(),targetId:'another'})).rejects.toThrow();
    expect(f.raw.prepare("SELECT count(*) n FROM workflow_steps WHERE process_kind='booking_stripe_object'").get()).toEqual({n:1});
  });
  it('DB障害では業務と完了が共に戻り、復元後に同じ受信を再開する',async()=>{
    await bind();await store();f.raw.exec("CREATE TRIGGER effect_fail BEFORE UPDATE ON effects BEGIN SELECT RAISE(ABORT,'fault');END");
    await expect(applyBookingStripeReceipt(f.db,'acct_original','evt_paid',effect)).rejects.toThrow('fault');
    expect(rows()[0]).toMatchObject({status:'pending',attempt_count:0});
    expect(f.raw.prepare('SELECT uses FROM effects').get()).toEqual({uses:0});
    f.raw.exec('DROP TRIGGER effect_fail');expect(await applyBookingStripeReceipt(f.db,'acct_original','evt_paid',effect)).toBe('applied');
  });
  it('leaseが切れた旧処理は、新しい処理の後で反映も完了もできない',async()=>{
    await bind();await store();let release!:()=>void,started!:()=>void;
    const wait=new Promise<void>(r=>{release=r;}),ready=new Promise<void>(r=>{started=r;});const now=Date.now();
    const first=applyBookingStripeReceipt(f.db,'acct_original','evt_paid',async c=>{started();await wait;return effect(c);},{now,owner:'old',leaseMs:10});
    const rejected=expect(first).rejects.toThrow();await ready;
    expect(await applyBookingStripeReceipt(f.db,'acct_original','evt_paid',effect,{now:now+11,owner:'new'})).toBe('applied');
    release();await rejected;expect(f.raw.prepare('SELECT uses FROM effects').get()).toEqual({uses:1});
  });
  it('別IDでpaidが再送されても権利は一度だけ、後の古い失敗で戻さない',async()=>{
    await bind();for(const [id,type] of [['evt_paid','invoice.paid'],['evt_paid_again','invoice.paid'],['evt_failed_late','invoice.payment_failed']]){
      await store({...event(),id,type});await applyBookingStripeReceipt(f.db,'acct_original',id,effect);
    }
    expect(f.raw.prepare('SELECT state,uses FROM effects').get()).toEqual({state:'paid',uses:1});
  });
});
describe('受信の保持と削除',()=>{
  it('店が分かる未対応は30日で一度だけ要確認に数え、消さない',async()=>{
    await store();f.raw.exec('UPDATE workflow_steps SET created_at=0');
    expect(await markOverdueBookingStripeReceipts(f.db,31*86400000)).toBe(1);
    expect(await markOverdueBookingStripeReceipts(f.db,31*86400000)).toBe(0);
    expect(rows()[0].error_code).toBe('stripe_binding_overdue');
  });
  it('接続が無い隔離受信だけ30日後に削除でき、紐付いた別の記録を残す',async()=>{
    await store({...event(),account:'acct_unknown',id:'evt_orphan'});await store();
    f.raw.exec("UPDATE workflow_steps SET created_at=0");
    expect(await purgeUnboundBookingStripeReceipts(f.db,31*86400000)).toBe(1);
    expect(rows()).toHaveLength(1);
  });
  it('紐付いた受信と関連だけをtenant削除で消し、他tenant・未対応の隔離を残す',async()=>{
    await bind();await store();await store({...event(),account:'acct_unknown',id:'evt_orphan'});
    f.raw.exec("UPDATE booking_payment_connections SET provider_account_id='acct_reconnected'");
    const condition=tenantScopeCondition('workflow_steps');
    expect((await f.db.prepare(`DELETE FROM workflow_steps WHERE ${condition}`).bind('other').run()).meta.changes).toBe(0);
    expect((await f.db.prepare(`DELETE FROM workflow_steps WHERE ${condition}`).bind('t').run()).meta.changes).toBe(2);
    expect(rows()).toHaveLength(1);expect(JSON.parse(rows()[0].input_json).event.account).toBe('acct_unknown');
  });
});

it('tenant削除は通常scopeとStripeの範囲を索引で絞り、全工程を走査しない',()=>{
  const plan=f.raw.prepare(`EXPLAIN QUERY PLAN DELETE FROM workflow_steps WHERE ${tenantScopeCondition('workflow_steps')}`).all('t') as {detail:string}[];
  expect(plan.some(row=>/SEARCH w .*scope_id/.test(row.detail))).toBe(true);
  expect(plan.filter(row=>/SCAN w$|SCAN workflow_steps$/.test(row.detail))).toEqual([]);
});

it('隔離の後から関連を保存しても保持先を固定し、30日削除の対象から外す',async()=>{
  f.raw.exec('DELETE FROM booking_payment_connections');await store();
  expect(JSON.parse(rows()[0].input_json).retentionAccountId).toBeNull();
  f.raw.exec("INSERT INTO booking_payment_connections(line_account_id,provider,provider_account_id,test_mode,connected_at) VALUES('a','stripe','acct_original',1,'2026-10-31')");
  await bind();f.raw.exec('UPDATE workflow_steps SET created_at=0');
  expect(JSON.parse(rows()[0].input_json).retentionAccountId).toBe('a');
  expect(await purgeUnboundBookingStripeReceipts(f.db,31*86400000)).toBe(0);
});

it('同じConnectに別店の行があってもtenant削除はその店の行だけ',async()=>{
  await bind();await store();
  f.raw.exec("INSERT INTO friends(id,line_user_id,display_name,line_account_id) VALUES('fb','Ub','他店の人','b');INSERT INTO booking_payment_connections(line_account_id,provider,provider_account_id,test_mode,connected_at) VALUES('b','stripe','acct_original',1,'2026-10-31')");
  await bind({...binding(),tenantId:'other',accountId:'b',friendId:'fb',objectId:'in_other',targetId:'other_month'});
  const e=event();await store({...e,id:'evt_other',data:{object:{...e.data.object,id:'in_other'}}});
  expect((await f.db.prepare(`DELETE FROM workflow_steps WHERE ${tenantScopeCondition('workflow_steps')}`).bind('t').run()).meta.changes).toBe(2);
  expect(rows()).toHaveLength(1);expect(JSON.parse(rows()[0].input_json).retentionAccountId).toBe('b');
});

it('受信の保存障害は2xxにせず、復元後に同じ本文を保存できる',async()=>{
  const e=event();f.raw.exec("CREATE TRIGGER receipt_fail BEFORE INSERT ON workflow_steps BEGIN SELECT RAISE(ABORT,'receipt_fault');END");
  expect((await send(e)).status).toBe(500);expect(rows()).toHaveLength(0);
  f.raw.exec('DROP TRIGGER receipt_fail');expect((await send(e)).status).toBe(202);
});

it('関連の守りが外れれば、そのbatchの業務の書込も戻る',async()=>{
  await expect(f.db.batch([f.db.prepare("UPDATE effects SET state='paid',uses=1"),...prepareBookingStripeBinding(f.db,{...binding(),friendId:'wrong_person'})])).rejects.toThrow();
  expect(f.raw.prepare('SELECT state,uses FROM effects').get()).toEqual({state:'pending',uses:0});
});

it('対応typeでも不正なobject種類やConnect欠落は保存しない',async()=>{
  for(const kind of ['constructor','__proto__','customer']){
    const e=event();expect((await send({...e,data:{object:{...e.data.object,object:kind}}})).status).toBe(400);
  }
  expect((await send({...event(),account:undefined})).status).toBe(400);expect(rows()).toHaveLength(0);
});

it('月謝のカード保存Checkoutは入金と混ぜず、固定したCustomerとsetupの用途で照合する',async()=>{
  const e=event();const setup={...e,id:'evt_setup',type:'checkout.session.completed',data:{object:{id:'cs_setup',object:'checkout.session',livemode:false,mode:'setup',status:'complete',customer:'cus_person',setup_intent:'seti_card'}}};
  await bind({...binding(),purpose:'payment_method',objectId:'cs_setup',objectKind:'checkout.session',amount:null,currency:null});
  await storeBookingStripeReceipt(f.db,normalizeBookingStripeEvent(setup),await stripeReceiptDigest(JSON.stringify(setup)));
  const prepare=vi.fn(async({event:stored}:{event:{object:{setupIntent:string|null}}})=>{
    expect(stored.object.setupIntent).toBe('seti_card');return [f.db.prepare("UPDATE effects SET state='card_setup' WHERE id='month'")];
  });
  expect(await applyBookingStripeReceipt(f.db,'acct_original','evt_setup',prepare)).toBe('applied');
  expect(f.raw.prepare('SELECT state,uses FROM effects').get()).toEqual({state:'card_setup',uses:0});
});

it('同じCheckoutでもsetupを購入の入金へ読み替えない',async()=>{
  const e=event();const setup={...e,id:'evt_setup',type:'checkout.session.completed',data:{object:{id:'cs_purchase',object:'checkout.session',livemode:false,mode:'setup',status:'complete',customer:'cus_person',amount_total:4200,currency:'jpy'}}};
  await bind({...binding(),purpose:'pass_purchase',objectId:'cs_purchase',objectKind:'checkout.session'});
  await storeBookingStripeReceipt(f.db,normalizeBookingStripeEvent(setup),await stripeReceiptDigest(JSON.stringify(setup)));
  expect(await applyBookingStripeReceipt(f.db,'acct_original','evt_setup',effect)).toBe('review_required');
  expect(f.raw.prepare('SELECT uses FROM effects').get()).toEqual({uses:0});
});
