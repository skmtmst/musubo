import { readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteCustomerData } from './customer-data-deletion.js';
import { CUSTOMER_WORKFLOW_WAIT_MS, redactCustomerWorkflows } from './customer-workflow-redaction.js';
import {claimWorkflowStep} from '@line-crm/db';

let mf: Miniflare;
let native: Awaited<ReturnType<Miniflare['getD1Database']>>;
let sequence = 0;
let friendId: string, submissionId: string, scanId: string, fileId: string;
let remove: ReturnType<typeof vi.fn<(keys: string | string[]) => Promise<void>>>;
const db = () => native as unknown as D1Database;
const target = (kind: 'friend_data' | 'form_response') => ({ kind, id: kind === 'friend_data' ? friendId : submissionId,
  friendId, accountId: 'account', formId: 'form', lineUserId: `LINE-${friendId}` });
const env = () => ({ DB: db(), IMAGES: { delete: remove } });

describe('local workerd D1 binding', () => {
  beforeAll(async () => {
    mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', d1Databases: ['DB'] });
    native = await mf.getD1Database('DB');
    const sql = readFileSync(new URL('../../../../packages/db/bootstrap.sql', import.meta.url), 'utf8');
    // 実 D1 相当の既存試験と同じ正規化済み bootstrap 分割を使う。
    const statements = sql.split('\n').filter(line => !line.trimStart().startsWith('--')).reduce<string[]>((result, line) => {
      result[result.length - 1] += `\n${line}`;
      if (line.trimEnd().endsWith(';')) result.push('');
      return result;
    }, ['']).map(statement => statement.trim()).filter(Boolean);
    for (let offset = 0; offset < statements.length; offset += 50) await native.batch(statements.slice(offset, offset + 50).map(statement => native.prepare(statement)));
    await native.batch([
      native.prepare("INSERT INTO line_accounts(id,name,channel_id,channel_access_token,channel_secret) VALUES ('account','A','channel','token','secret')"),
      native.prepare("INSERT INTO friends(id,line_user_id,line_account_id) VALUES ('other','LINE-other','account')"),
      native.prepare("INSERT INTO forms(id,name,fields) VALUES ('form','F','[]')"),
    ]);
  }, 120_000);
  afterAll(async () => { await mf?.dispose(); });
  beforeEach(async () => {
    sequence++; friendId = `friend-${sequence}`; submissionId = `submission-${sequence}`; scanId = `scan-${sequence}`; fileId = `file-${sequence}`;
    remove = vi.fn(async () => {});
    await native.batch([
      native.prepare('INSERT INTO friends(id,line_user_id,line_account_id) VALUES (?,?,?)').bind(friendId, `LINE-${friendId}`, 'account'),
      native.prepare('INSERT INTO form_submissions(id,form_id,friend_id,data) VALUES (?,?,?,?)').bind(submissionId, 'form', friendId, '{"private":"customer body"}'),
      native.prepare('INSERT INTO media_file_scans(id,line_account_id,subject_kind,subject_id,filename,mime_type,size_bytes,status) VALUES (?,?,?,?,?,?,?,?)').bind(scanId, 'account', 'form_file', `private/${fileId}`, 'private-name.pdf', 'application/pdf', 10, 'clean'),
      native.prepare('INSERT INTO form_submission_files(id,line_account_id,form_id,block_id,friend_id,submission_id,file_kind,side,r2_key,filename,mime_type,size_bytes,scan_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(fileId, 'account', 'form', 'block', friendId, submissionId, 'identity', 'single', `private/${fileId}`, 'private-name.pdf', 'application/pdf', 10, scanId, 'now'),
    ]);
  });
  it('deletes answer, object, scan and audit atomically and replays once', async () => {
    expect(await deleteCustomerData(env(), target('form_response'), 'owner')).toMatchObject({ deleted: true, replayed: false });
    expect(await native.prepare('SELECT id FROM form_submissions WHERE id=?').bind(submissionId).first()).toBeNull();
    expect(await native.prepare('SELECT id FROM media_file_scans WHERE id=?').bind(scanId).first()).toBeNull();
    expect(await native.prepare('SELECT id FROM friends WHERE id=?').bind(friendId).first()).toBeTruthy();
    const audit = await native.prepare('SELECT * FROM audit_events WHERE source_id=?').bind(`customer-delete:form_response:${submissionId}`).first();
    expect(audit).toMatchObject({ actor_principal_id: 'owner', action: 'customer.form_response.deleted', result: 'success' });
    expect(JSON.stringify(audit)).not.toMatch(/customer body|private-name|LINE-/);
    expect(await deleteCustomerData(env(), target('form_response'), 'owner')).toMatchObject({ replayed: true });
    expect(remove).toHaveBeenCalledExactlyOnceWith([`private/${fileId}`]);
  }, 30_000);
  it('executes the full friend relation graph with D1 numbered bindings', async () => {
    expect(await deleteCustomerData(env(), target('friend_data'), 'owner')).toMatchObject({ deleted: true });
    expect(await native.prepare('SELECT id FROM friends WHERE id=?').bind(friendId).first()).toBeNull();
    expect(await native.prepare("SELECT id FROM friends WHERE id='other'").first()).toBeTruthy();
    expect(await native.prepare('SELECT id FROM form_submission_files WHERE id=?').bind(fileId).first()).toBeNull();
    expect(remove).toHaveBeenCalledExactlyOnceWith([`private/${fileId}`]);
  }, 30_000);
  it('顧客削除で未送信と完了を匿名化し、送信中と結果不明は結果または期限を待つ', async () => {
    const now=Date.now();
    for (const status of ['pending','failed','succeeded','unknown','running']) {
      await native.prepare(`INSERT INTO workflow_steps(scope_id,process_kind,subject_id,step_key,status,lease_owner,lease_expires_at,
        retry_key,input_json,result_json,created_at,updated_at) VALUES ('line:account','tracked_click',?,'__run',?,?,?,?,?,?,?,?)`)
        .bind(`${friendId}-${status}`,status,status==='running'?'owner':null,status==='running'?now+60_000:null,
          `retry-${status}`,JSON.stringify({friendId,private:'body'}),JSON.stringify({requestId:'request_1',private:'result'}),now,now).run();
    }
    await native.prepare(`INSERT INTO workflow_steps(scope_id,process_kind,subject_id,step_key,status,retry_key,input_json,created_at,updated_at)
      VALUES ('line:account','tracked_click',?,'__run','pending','other',?,?,?)`)
      .bind(`${friendId}-other`,JSON.stringify({friendId:'other',private:'other body'}),now,now).run();
    await deleteCustomerData(env(), target('friend_data'), 'owner');
    const rows=(await native.prepare('SELECT subject_id,status,input_json,customer_redaction_requested_at FROM workflow_steps WHERE subject_id LIKE ?')
      .bind(`${friendId}-%`).all<{subject_id:string;status:string;input_json:string;customer_redaction_requested_at:number|null}>()).results;
    const byStatus=new Map(rows.map(row=>[row.subject_id.slice(friendId.length+1),row]));
    expect(byStatus.get('pending')).toMatchObject({status:'canceled',input_json:'{"redacted":true}'});
    expect(byStatus.get('failed')).toMatchObject({status:'canceled',input_json:'{"redacted":true}'});
    expect(byStatus.get('succeeded')).toMatchObject({status:'canceled',input_json:'{"redacted":true}'});
    expect(byStatus.get('unknown')).toMatchObject({status:'unknown'});
    expect(byStatus.get('running')).toMatchObject({status:'running'});
    expect(byStatus.get('other')).toMatchObject({status:'pending',customer_redaction_requested_at:null});
    await native.prepare("UPDATE workflow_steps SET status='succeeded',lease_owner=NULL,lease_expires_at=NULL WHERE subject_id=?")
      .bind(`${friendId}-running`).run();
    const requested=byStatus.get('unknown')!.customer_redaction_requested_at!;
    expect(await redactCustomerWorkflows(db(),requested+1)).toBe(1);
    expect(await redactCustomerWorkflows(db(),requested+CUSTOMER_WORKFLOW_WAIT_MS)).toBe(1);
    const redacted=await native.prepare('SELECT status,input_json,result_json FROM workflow_steps WHERE subject_id=?').bind(`${friendId}-unknown`).first();
    expect(redacted).toMatchObject({status:'canceled',input_json:'{"redacted":true}',result_json:'{"redacted":true,"previousStatus":"unknown","requestId":"request_1"}'});
    expect(await claimWorkflowStep(db(),{scopeId:'line:account',processKind:'tracked_click',subjectId:`${friendId}-unknown`,stepKey:'__run'})).toBeNull();
    const journal=await native.prepare('SELECT detail_json FROM operation_audit WHERE id=?').bind(`customer-delete:friend_data:${friendId}`).first<{detail_json:string}>();
    const detail=JSON.parse(journal!.detail_json);
    expect(detail.recipientDigest).toHaveLength(64);
    expect(detail.workflowPendingAtDeletion).toBe(2);
    await redactCustomerWorkflows(db(),Date.parse(detail.completedAt)+CUSTOMER_WORKFLOW_WAIT_MS+300_001);
    const cleaned=await native.prepare('SELECT detail_json FROM operation_audit WHERE id=?').bind(`customer-delete:friend_data:${friendId}`).first<{detail_json:string}>();
    expect(JSON.parse(cleaned!.detail_json).recipientDigest).toBeUndefined();
  },30_000);
  it('削除受付とR2削除の間に本人の新しい送信工程を作らせない',async()=>{
    remove.mockImplementation(async()=>{
      const create=() => native.prepare(`INSERT INTO workflow_steps(scope_id,process_kind,subject_id,step_key,status,retry_key,input_json,created_at,updated_at)
        VALUES ('line:account','tracked_click',?,'__run','pending','key',?,?,?)`);
      await expect(create().bind(`${friendId}-race`,JSON.stringify({friendId}),Date.now(),Date.now()).run()).rejects.toThrow();
      await create().bind(`${friendId}-other-race`,JSON.stringify({friendId:'other'}),Date.now(),Date.now()).run();
    });
    await deleteCustomerData(env(),target('friend_data'),'owner');
    expect(await native.prepare('SELECT subject_id FROM workflow_steps WHERE subject_id=?').bind(`${friendId}-race`).first()).toBeNull();
    expect(await native.prepare('SELECT subject_id FROM workflow_steps WHERE subject_id=?').bind(`${friendId}-other-race`).first()).toBeTruthy();
  },30_000);
  it('本人と確実に結び付くイベントだけを匿名化し、複数宛先のイベントは残す',async()=>{
    const now=Date.now(),recipient=`LINE-${friendId}`;
    const insert=(kind:string,subject:string,key:string,input:unknown)=>native.prepare(`INSERT INTO workflow_steps
      (scope_id,process_kind,subject_id,step_key,status,retry_key,input_json,created_at,updated_at)
      VALUES ('line:account',?,?,?,'pending',?,?,?,?)`).bind(kind,subject,key,`${subject}-${key}`,JSON.stringify(input),now,now);
    const research=JSON.stringify(['asset',1,friendId,'0','single']);
    await native.batch([
      insert('research_tap',research,'__run',{label:'private answer'}),
      insert('line_event',`${friendId}-single`,'__run',{eventType:'message'}),
      insert('line_event',`${friendId}-single`,'line:reply:0',{to:recipient,messages:['private']}),
      insert('line_event',`${friendId}-multi`,'__run',{eventType:'message'}),
      insert('line_event',`${friendId}-multi`,'line:one:0',{to:recipient,messages:['private']}),
      insert('line_event',`${friendId}-multi`,'line:two:0',{to:'LINE-other',messages:['other']}),
    ]);
    await deleteCustomerData(env(),target('friend_data'),'owner');
    const selected=await native.prepare('SELECT status,input_json FROM workflow_steps WHERE process_kind=? AND subject_id=?').bind('research_tap',research).first();
    expect(selected).toEqual({status:'canceled',input_json:'{"redacted":true}'});
    const single=await native.prepare('SELECT status FROM workflow_steps WHERE subject_id=?').bind(`${friendId}-single`).all<{status:string}>();
    expect(single.results.map(row=>row.status)).toEqual(['canceled','canceled']);
    const multi=await native.prepare('SELECT status FROM workflow_steps WHERE subject_id=?').bind(`${friendId}-multi`).all<{status:string}>();
    expect(multi.results.map(row=>row.status)).toEqual(['pending','pending','pending']);
  },30_000);
  it('アカウントと友だちが一致する決済関連とその受信だけを匿名化する',async()=>{
    const now=Date.now();
    const insert=(kind:string,subject:string,key:string,input:unknown)=>native.prepare(`INSERT INTO workflow_steps
      (scope_id,process_kind,subject_id,step_key,status,retry_key,input_json,created_at,updated_at)
      VALUES ('stripe-test:acct',?,?,?,'pending',?,?,?,?)`).bind(kind,subject,key,subject,JSON.stringify(input),now,now);
    await native.batch([
      insert('booking_stripe_object','in_1','binding',{accountId:'account',friendId,customerId:'cus_private'}),
      insert('booking_stripe_webhook','event-1','apply',{retentionAccountId:'account',event:{type:'invoice.paid',created:123,object:{id:'in_1',kind:'invoice',amount:500,currency:'jpy',customer:'cus_private'}}}),
      insert('booking_stripe_webhook','event-3','apply',{retentionAccountId:'account',event:{type:'invoice.paid',created:124,object:{id:'in_1',kind:'invoice',amount:600,currency:'jpy',customer:'cus_private'}}}),
      insert('booking_stripe_object','invoice-2','binding',{accountId:'account',friendId:'other',customerId:'cus_other'}),
      insert('booking_stripe_webhook','event-2','apply',{retentionAccountId:'account',event:{object:{id:'invoice-2',customer:'cus_other'}}}),
      insert('booking_stripe_object','invoice-4','binding',{accountId:'other-account',friendId,customerId:'cus_other_account'}),
      insert('booking_stripe_webhook','event-4','apply',{retentionAccountId:'other-account',event:{object:{id:'invoice-4',customer:'cus_other_account'}}}),
    ]);
    await native.prepare("UPDATE workflow_steps SET status='unknown' WHERE subject_id='event-3'").run();
    await deleteCustomerData(env(),target('friend_data'),'owner');
    for(const id of ['in_1','event-1']){
      const row=await native.prepare('SELECT status,input_json FROM workflow_steps WHERE subject_id=?').bind(id).first<{status:string;input_json:string}>();
      expect(row?.status).toBe('canceled');
      expect(JSON.parse(row!.input_json)).toMatchObject({redacted:true});
      expect(row!.input_json).not.toContain('cus_private');
    }
    const receipt=await native.prepare('SELECT result_json FROM workflow_steps WHERE subject_id=?').bind('event-1').first<{result_json:string}>();
    expect(JSON.parse(receipt!.result_json)).toMatchObject({accounting:{eventType:'invoice.paid',objectId:'in_1',amount:500,currency:'jpy'}});
    expect(receipt!.result_json).not.toContain('cus_private');
    const waiting=await native.prepare("SELECT status,customer_redaction_requested_at FROM workflow_steps WHERE subject_id='event-3'").first<{status:string;customer_redaction_requested_at:number}>();
    expect(waiting?.status).toBe('unknown');
    await redactCustomerWorkflows(db(),waiting!.customer_redaction_requested_at+CUSTOMER_WORKFLOW_WAIT_MS);
    const later=await native.prepare("SELECT input_json,result_json FROM workflow_steps WHERE subject_id='event-3'").first<{input_json:string;result_json:string}>();
    expect(JSON.parse(later!.input_json)).toMatchObject({redacted:true,retentionAccountId:'account'});
    expect(later!.input_json).not.toContain('cus_private');
    expect(JSON.parse(later!.result_json)).toMatchObject({previousStatus:'unknown',accounting:{objectId:'in_1',amount:600}});
    expect(later!.result_json).not.toContain('cus_private');
    for(const id of ['invoice-2','event-2','invoice-4','event-4'])expect(await native.prepare('SELECT status FROM workflow_steps WHERE subject_id=?').bind(id).first())
      .toEqual({status:'pending'});
  },30_000);
  it('rolls D1 batch back on an error after attachment deletion, then retries', async () => {
    await native.prepare("CREATE TRIGGER fail_customer_delete BEFORE DELETE ON form_submissions BEGIN SELECT RAISE(ABORT,'fail'); END").run();
    await expect(deleteCustomerData(env(), target('form_response'), 'owner')).rejects.toMatchObject({ status: 503 });
    expect(await native.prepare('SELECT id FROM form_submissions WHERE id=?').bind(submissionId).first()).toBeTruthy();
    expect(await native.prepare('SELECT id FROM form_submission_files WHERE id=?').bind(fileId).first()).toBeTruthy();
    expect(await native.prepare('SELECT id FROM media_file_scans WHERE id=?').bind(scanId).first()).toBeTruthy();
    expect(await native.prepare('SELECT id FROM audit_events WHERE source_id=?').bind(`customer-delete:form_response:${submissionId}`).first()).toBeNull();
    await native.prepare('DROP TRIGGER fail_customer_delete').run();
    expect(await deleteCustomerData(env(), target('form_response'), 'owner')).toMatchObject({ deleted: true });
  }, 30_000);
});
