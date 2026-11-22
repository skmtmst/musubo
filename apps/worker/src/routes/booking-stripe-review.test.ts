import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../worker-env.js';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';
import { seedAssignmentFixture } from '../test-utils/assignment-fixture.js';
vi.mock('../services/account-access.js',()=>({canAccessAllLineAccounts:vi.fn(async (_db, _staff, ids:string[])=>ids[0]==='a')}));
import { bookingPaymentAdmin } from './booking-payment-admin.js';
type ReviewResponse={data:{items:Array<Record<string,unknown>>;nextCursor:string|null}};
let db:SqliteD1;
let role='owner';
const url='/api/booking/admin/stripe-review?account_id=a';
function app(){const app=new Hono<Env>();app.use('*',async(c,next)=>{c.set('staff',{id:'s1',name:'試験',role:role as 'owner',readOnly:false});await next();});app.route('/',bookingPaymentAdmin);return app;}
function request(path=url){return app().request(path,{}, {DB:db.db} as Env['Bindings']);}
function seed(id:string,input:unknown,result:unknown,code:string|null,status='pending'){
 db.raw.prepare(`INSERT INTO workflow_steps(scope_id,process_kind,subject_id,step_key,status,retry_key,input_json,result_json,error_code,created_at,updated_at)
 VALUES('stripe-test:acct_test','booking_stripe_webhook',?,'apply',?,?,?,?,?,1,1)`).run(id,status,id,JSON.stringify(input),result===null?null:JSON.stringify(result),code);
}
beforeEach(()=>{db=createTestD1();seedAssignmentFixture(db);db.raw.prepare("UPDATE line_accounts SET tenant_id='00000000-0000-4000-8000-000000000001' WHERE id='a'").run();role='owner';});
describe('決済通知の要確認一覧',()=>{
 it('削除時と削除後の会計情報を出し、個人情報・秘密値を返さない',async()=>{
  seed('evt_before',{redacted:true,retentionAccountId:'a',retentionTenantId:'00000000-0000-4000-8000-000000000001'}, {accounting:{eventType:'invoice.paid',objectId:'in_123',objectKind:'invoice',amount:1200,currency:'jpy',created:1700000000},secret:'hidden'},'customer_deleted','canceled');
  seed('evt_after',{redacted:true,retentionAccountId:'a',retentionTenantId:'00000000-0000-4000-8000-000000000001',accounting:{eventType:'payment_intent.succeeded',objectId:'pi_123',objectKind:'payment_intent',amount:900,currency:'jpy',created:1700000010},customer:'cus_secret'},null,'customer_deleted','canceled');
  seed('evt_other',{retentionAccountId:'b',accounting:{objectId:'pi_other'}},null,'customer_deleted','canceled');
  seed('evt_cross',{retentionAccountId:'a',retentionTenantId:'tenant_other',accounting:{objectId:'pi_cross'}},null,'customer_deleted','canceled');
  seed('evt_pending',{retentionAccountId:'a',event:{object:{id:'pi_pending'}}},null,null);
  const res=await request();expect(res.status).toBe(200);const body=await res.json() as ReviewResponse;expect(body.data.items).toHaveLength(2);expect(body.data.items).toEqual(expect.arrayContaining([expect.objectContaining({paymentId:'in_123',amount:1200,currency:'jpy',reason:'customer_deleted'}),expect.objectContaining({paymentId:'pi_123',amount:900})]));expect(JSON.stringify(body)).not.toMatch(/cus_secret|hidden|pi_other|pi_pending|pi_cross/);
 });
 it('owner・admin以外は拒否し、担当外の店舗は隠す',async()=>{role='staff';expect((await request()).status).toBe(403);role='viewer';expect((await request()).status).toBe(403);role='admin';expect((await request()).status).toBe(200);expect((await request('/api/booking/admin/stripe-review?account_id=b')).status).toBe(404);});
 it('自動再試行中は除き、上限到達は要確認にする。読み取りで書き換えない',async()=>{
  seed('evt_failed',{retentionAccountId:'a',event:{object:{id:'pi_failed'}}},null,null,'failed');
  seed('evt_failed_reason',{retentionAccountId:'a',event:{object:{id:'pi_failed_reason'}}},null,'stripe_binding_mismatch','failed');
  seed('evt_exhausted',{retentionAccountId:'a',event:{object:{id:'pi_exhausted'}}},null,null,'exhausted');
  const before=db.raw.prepare("SELECT * FROM workflow_steps ORDER BY subject_id").all();
  const body=await (await request()).json() as ReviewResponse;expect(body.data.items).toHaveLength(1);
  expect(body.data.items[0]).toMatchObject({paymentId:'pi_exhausted',reason:'review_required'});
  expect(db.raw.prepare("SELECT * FROM workflow_steps ORDER BY subject_id").all()).toEqual(before);
 });
 it('削除時に結果不明だった通知は理由を区別する',async()=>{
  seed('evt_unknown',{retentionAccountId:'a'}, {accounting:{objectId:'pi_unknown'}},'customer_deleted_unknown','canceled');
  const body=await (await request()).json() as ReviewResponse;expect(body.data.items[0]).toMatchObject({paymentId:'pi_unknown',reason:'customer_deleted_unknown'});
 });
 it('ページの途中で上位の通知が片付いても残りを飛ばさない',async()=>{
  for(let i=0;i<101;i++)seed(`evt_${i}`,{retentionAccountId:'a',accounting:{objectId:`pi_${i}`}},null,'customer_deleted','canceled');
  const first=await (await request()).json() as ReviewResponse;expect(first.data.items).toHaveLength(100);expect(first.data.nextCursor).toBeTruthy();
  db.raw.prepare("UPDATE workflow_steps SET status='succeeded' WHERE subject_id='evt_100'").run();
  const next=await (await request(url+'&cursor='+encodeURIComponent(first.data.nextCursor!))).json() as ReviewResponse;expect(next.data.items).toHaveLength(1);expect(next.data.nextCursor).toBeNull();expect(next.data.items[0]).toMatchObject({paymentId:'pi_0'});
  expect((await request(url+'&cursor=-1')).status).toBe(400);
 });
 it('削除前に処理が完了していた通知は要確認に含めない',async()=>{
  seed('evt_done',{retentionAccountId:'a'}, {previousStatus:'succeeded',accounting:{objectId:'pi_done'}},'customer_deleted','canceled');
  const body=await (await request()).json() as ReviewResponse;expect(body.data.items).toHaveLength(0);
 });
 it('未知の理由と文字列は外へ出さず、照合不能な通知も一覧に載せる',async()=>{
  seed('evt_bad',{retentionAccountId:'a',event:{type:'customer.secret',created:1700000000,object:{id:'cus_person',kind:'invoice',amount:1,currency:'jpy'}}},null,'private details');
  const res=await request();const body=await res.json() as ReviewResponse;expect(body.data.items[0]).toMatchObject({paymentId:null,reason:'review_required',eventType:null});expect(JSON.stringify(body)).not.toMatch(/cus_person|private details|customer.secret/);
 });
});
