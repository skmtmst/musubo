import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {createTestD1,type SqliteD1} from '../test-utils/d1-sqlite.js';
import {acquireWorkflow} from './workflow-execution.js';
import {workflowLineClient} from './workflow-line-client.js';
import {ensureWorkflowStep,getWorkflowStep} from '@line-crm/db';
import type {LineClient} from '@line-crm/line-sdk';
import {customerDestinationBlocked,customerDestinationDigest} from './customer-deletion-destination.js';
import {CUSTOMER_WORKFLOW_WAIT_MS,redactCustomerWorkflows} from './customer-workflow-redaction.js';
let item:SqliteD1;
const ref={scopeId:'line:a',processKind:'line_event',subjectId:'event'};
beforeEach(()=>{item=createTestD1();item.raw.exec('CREATE TABLE effects(n INTEGER);INSERT INTO effects VALUES(0)')});
afterEach(()=>item.raw.close());
describe('PKG67 shared workflow recovery',()=>{
 it('同じLINE IDでも別のアカウントの削除受付では止めない',async()=>{
  const digest=await customerDestinationDigest('a','U1');
  item.raw.prepare(`INSERT INTO operation_audit(id,target_kind,target_id,action,actor_id,friend_id,detail_json)
    VALUES ('customer-delete:friend_data:f','customer_deletion','f','deleting','owner','f',?)`)
   .run(JSON.stringify({accountId:'a',recipientDigest:digest}));
  expect(await customerDestinationBlocked(item.db,digest,'a','U1')).toBe(true);
  expect(await customerDestinationBlocked(item.db,await customerDestinationDigest('b','U1'),'b','U1')).toBe(false);
 });
 it('7日を過ぎても送信中の借受期限が残る間は本文の消去を待つ',async()=>{
  const step={...ref,stepKey:'send'},now=Date.now();
  await ensureWorkflowStep(item.db,step,{input:{to:'U1',messages:[{type:'text',text:'private'}]}});
  item.raw.prepare("UPDATE workflow_steps SET status='running',lease_owner='owner',lease_expires_at=?,customer_redaction_requested_at=? WHERE step_key='send'")
   .run(now+CUSTOMER_WORKFLOW_WAIT_MS+60_000,now);
  expect(await redactCustomerWorkflows(item.db,now+CUSTOMER_WORKFLOW_WAIT_MS)).toBe(0);
  expect((await getWorkflowStep(item.db,step))?.input_json).toContain('private');
  expect(await redactCustomerWorkflows(item.db,now+CUSTOMER_WORKFLOW_WAIT_MS+60_001)).toBe(1);
  expect((await getWorkflowStep(item.db,step))?.input_json).toBe('{"redacted":true}');
 });
 it('削除受付前から実行中のクリックは受付後も結果を記録できる',async()=>{
  const click={scopeId:'line:a',processKind:'tracked_click',subjectId:'click'};
  const execution=(await acquireWorkflow(item.db,click,{input:{friendId:'f'}}))!;
  let accept!:()=>void, started!:()=>void;
  const sending=new Promise<void>(resolve=>{started=resolve});
  const response=new Promise<{requestId:string}>(resolve=>{accept=()=>resolve({requestId:'line-accepted'})});
  const send=vi.fn(async()=>{started();return response});
  const operation=workflowLineClient({pushMessage:send} as unknown as LineClient,execution).pushMessage('U1',[{type:'text',text:'private'}]);
  await sending;
  item.raw.prepare(`INSERT INTO operation_audit(id,target_kind,target_id,action,actor_id,friend_id,detail_json)
    VALUES ('customer-delete:friend_data:f','customer_deletion','f','deleting','owner','f',?)`)
   .run(JSON.stringify({accountId:'a'}));
  accept();await operation;
  await execution.complete({accepted:true});
  expect((await getWorkflowStep(item.db,{...click,stepKey:'__run'}))?.status).toBe('succeeded');
  expect(item.raw.prepare("SELECT status FROM workflow_steps WHERE step_key LIKE 'line:%'").get()).toEqual({status:'succeeded'});
 });
 it('顧客削除後に新しい工程を作ろうとしても同じ宛先へ送らない',async()=>{
  const execution=(await acquireWorkflow(item.db,ref))!;
  const digest=await customerDestinationDigest('a','U1');
  item.raw.prepare(`INSERT INTO operation_audit(id,target_kind,target_id,action,actor_id,friend_id,detail_json)
    VALUES ('customer-delete:friend_data:f','customer_deletion','f','deleted','owner','f',?)`)
   .run(JSON.stringify({accountId:'a',recipientDigest:digest}));
  const send=vi.fn().mockResolvedValue(undefined);
  await expect(workflowLineClient({pushMessage:send} as unknown as LineClient,execution)
   .pushMessage('U1',[{type:'text',text:'private'}])).rejects.toThrow('customer_deleted');
  expect(send).not.toHaveBeenCalled();
  expect(item.raw.prepare("SELECT count(*) n FROM workflow_steps WHERE step_key LIKE 'line:%'").get()).toEqual({n:0});
 });
 it('削除が完了し別の友だちとして再登録された宛先には新しい送信を許す',async()=>{
  item.raw.prepare("INSERT INTO line_accounts(id,name,channel_id,channel_access_token,channel_secret) VALUES ('a','A','channel','token','secret')").run();
  item.raw.prepare("INSERT INTO friends(id,line_user_id,line_account_id) VALUES ('new-f','U1','a')").run();
  const execution=(await acquireWorkflow(item.db,ref))!;
  const digest=await customerDestinationDigest('a','U1');
  item.raw.prepare(`INSERT INTO operation_audit(id,target_kind,target_id,action,actor_id,friend_id,detail_json)
    VALUES ('customer-delete:friend_data:old-f','customer_deletion','old-f','deleted','owner','old-f',?)`)
   .run(JSON.stringify({accountId:'a',recipientDigest:digest}));
  const send=vi.fn().mockResolvedValue(undefined);
  await workflowLineClient({pushMessage:send} as unknown as LineClient,execution).pushMessage('U1',[{type:'text',text:'hello'}]);
  expect(send).toHaveBeenCalledOnce();
 });
 it('顧客削除受付後は実行中の親から新しい送信工程を作らない',async()=>{
  const execution=(await acquireWorkflow(item.db,ref))!;
  item.raw.prepare("UPDATE workflow_steps SET customer_redaction_requested_at=? WHERE step_key='__run'").run(Date.now());
  const send=vi.fn().mockResolvedValue(undefined);
  await expect(workflowLineClient({pushMessage:send} as unknown as LineClient,execution)
   .pushMessage('U1',[{type:'text',text:'private'}])).rejects.toThrow();
  expect(send).not.toHaveBeenCalled();
 });
 it('顧客削除受付後は停止中の送信工程を再取得しない',async()=>{
  const step={...ref,stepKey:'customer_notification'};
  await ensureWorkflowStep(item.db,step,{input:{to:'U1',messages:[{type:'text',text:'private'}]}});
  item.raw.prepare('UPDATE workflow_steps SET customer_redaction_requested_at=? WHERE step_key=?').run(Date.now(),step.stepKey);
  const execution=(await acquireWorkflow(item.db,ref))!;
  const send=vi.fn().mockResolvedValue(undefined);
  await expect(workflowLineClient({pushMessage:send} as unknown as LineClient,execution,{stepKey:step.stepKey})
   .pushMessage('U1',[{type:'text',text:'private'}])).rejects.toThrow();
  expect(send).not.toHaveBeenCalled();
 });
 it('結果不明の削除対象は手動再開でも送信を始められない',async()=>{
  const root={...ref,stepKey:'__run'};
  await ensureWorkflowStep(item.db,root,{status:'unknown',input:{private:'body'},now:123});
  item.raw.prepare("UPDATE workflow_steps SET customer_redaction_requested_at=? WHERE step_key='__run'").run(124);
  await expect(acquireWorkflow(item.db,ref,{resume:{expectedUpdatedAt:123}})).rejects.toThrow();
  expect((await getWorkflowStep(item.db,root))?.status).toBe('unknown');
 });
 it('取消済みの送信工程は同じキーで再開しても送らない',async()=>{
  const execution=(await acquireWorkflow(item.db,ref))!;
  const step={...ref,stepKey:'customer_notification'};
  await ensureWorkflowStep(item.db,step,{input:{to:'U1',messages:[{type:'text',text:'private'}]}});
  item.raw.prepare("UPDATE workflow_steps SET status='canceled',input_json=?,result_json=?,error_code='customer_deleted' WHERE step_key=?")
   .run('{"redacted":true}','{"redacted":true}',step.stepKey);
  const send=vi.fn().mockResolvedValue(undefined);
  const client=workflowLineClient({pushMessage:send} as unknown as LineClient,execution,{stepKey:step.stepKey});
  await expect(client.pushMessage('U1',[{type:'text',text:'private'}])).rejects.toThrow('canceled');
  expect(send).not.toHaveBeenCalled();
  expect((await getWorkflowStep(item.db,step))?.status).toBe('canceled');
 });
 it('replays a frozen read/write plan after interruption without repeating increments',async()=>{
  const one=(await acquireWorkflow(item.db,ref))!;
  await one.step('done',async()=>{await one.mutationDb('done').prepare('UPDATE effects SET n=n+1').run()});
  let interrupted=true;
  const work=async(execution:NonNullable<Awaited<ReturnType<typeof acquireWorkflow>>>)=>execution.step('partial',async()=>{
    const db=execution.mutationDb('partial');
    const before=await db.prepare('SELECT n FROM effects').first<{n:number}>();
    if(before!.n===1)await db.prepare('UPDATE effects SET n=n+10').run();
    if(interrupted){interrupted=false;throw new Error('crash after database mutation')}
    await db.prepare('UPDATE effects SET n=n+100').run();
  });
  await expect(work(one)).rejects.toThrow();await one.fail();
  const two=(await acquireWorkflow(item.db,ref))!;
  const done=vi.fn();await two.step('done',done);await work(two);await two.complete();
  expect(done).not.toHaveBeenCalled();expect(item.raw.prepare('SELECT n FROM effects').get()).toEqual({n:111});
  expect((await getWorkflowStep(item.db,{...ref,stepKey:'__run'}))!.status).toBe('succeeded');
 });
 it('keeps an unacknowledged push unknown and never resends its frozen payload',async()=>{
  const one=(await acquireWorkflow(item.db,ref))!;
  const send=vi.fn().mockRejectedValue(new Error('lost response'));
  const client=workflowLineClient({pushMessage:send} as unknown as LineClient,one);
  await expect(client.pushMessage('U1',[{type:'text',text:'original'}])).rejects.toThrow();
  const retry=workflowLineClient({pushMessage:send} as unknown as LineClient,one);
  await expect(retry.pushMessage('U1',[{type:'text',text:'changed'}])).rejects.toThrow('delivery_unknown');
  expect(send).toHaveBeenCalledOnce();
  const rows=item.raw.prepare("SELECT * FROM workflow_steps WHERE step_key LIKE 'line:%'").all() as Array<{status:string;input_json:string}>;
  expect(rows[0].status).toBe('unknown');expect(rows[0].input_json).toContain('original');expect(rows[0].input_json).not.toContain('changed');
 });
 it('does not replay an accepted push after its success checkpoint cannot be saved',async()=>{
  const one=(await acquireWorkflow(item.db,ref))!;
  const send=vi.fn().mockResolvedValue({requestId:'accepted-before-db-failure'});
  item.raw.exec("CREATE TRIGGER fail_push_completion BEFORE UPDATE ON workflow_steps WHEN NEW.status='succeeded' AND NEW.step_key LIKE 'line:%' BEGIN SELECT RAISE(ABORT,'injected'); END");
  await expect(workflowLineClient({pushMessage:send} as unknown as LineClient,one).pushMessage('U1',[{type:'text',text:'original'}])).rejects.toThrow();
  item.raw.exec('DROP TRIGGER fail_push_completion');
  await expect(workflowLineClient({pushMessage:send} as unknown as LineClient,one).pushMessage('U1',[{type:'text',text:'changed'}])).rejects.toThrow('delivery_unknown');
  expect(send).toHaveBeenCalledOnce();
  const checkpoint=item.raw.prepare("SELECT result_json,retry_key,status FROM workflow_steps WHERE step_key LIKE 'line:%'").get() as {result_json:string,status:string};
  expect(checkpoint.status).toBe('unknown');
  expect(JSON.parse(checkpoint.result_json)).toEqual({requestId:'accepted-before-db-failure'});
 });
 it('does not reclaim a started push after its lease expires',async()=>{
  const one=(await acquireWorkflow(item.db,ref))!;
  const send=vi.fn().mockResolvedValue(undefined);
  await workflowLineClient({pushMessage:send} as unknown as LineClient,one).pushMessage('U1',[{type:'text',text:'original'}]);
  item.raw.exec("UPDATE workflow_steps SET status='running',error_code='delivery_started',lease_owner='stopped-owner',lease_expires_at=0 WHERE step_key LIKE 'line:%'");
  await expect(workflowLineClient({pushMessage:send} as unknown as LineClient,one).pushMessage('U1',[{type:'text',text:'changed'}])).rejects.toThrow('delivery_unknown');
  expect(send).toHaveBeenCalledOnce();
 });
 it('limits old persisted LINE retry budgets to four physical requests',async()=>{
  const one=(await acquireWorkflow(item.db,ref))!;
  const send=vi.fn().mockRejectedValue(Object.assign(new Error('not accepted'),{status:429}));
  for(let n=0;n<5;n++) {
    await workflowLineClient({pushMessage:send} as unknown as LineClient,one).pushMessage('U1',[{type:'text',text:'original'}]).catch(()=>{});
    item.raw.exec("UPDATE workflow_steps SET next_attempt_at=0,max_attempts=5 WHERE step_key LIKE 'line:%'");
  }
  expect(send).toHaveBeenCalledTimes(4);
 });
 it('never uses a reply token twice after a lost response and never stores the token',async()=>{
  const one=(await acquireWorkflow(item.db,ref))!;
  const send=vi.fn().mockRejectedValue(new Error('lost response'));
  const client=workflowLineClient({replyMessage:send} as unknown as LineClient,one);
  await expect(client.replyMessage('private-reply-token',[{type:'text',text:'answer'}])).rejects.toThrow();
  const replay=workflowLineClient({replyMessage:send} as unknown as LineClient,one);
  await expect(replay.replyMessage('new-private-token',[{type:'text',text:'answer'}])).rejects.toThrow('reply_unknown');
  expect(send).toHaveBeenCalledOnce();
  expect(JSON.stringify(item.raw.prepare('SELECT input_json,result_json FROM workflow_steps').all())).not.toContain('private');
 });
 it('rejects mutation RETURNING from an expired owner without changing domain data',async()=>{
  const one=(await acquireWorkflow(item.db,ref))!;
  item.raw.prepare("UPDATE workflow_steps SET lease_expires_at=0 WHERE step_key='__run'").run();
  const two=(await acquireWorkflow(item.db,ref))!;
  await expect(one.db.prepare('UPDATE effects SET n=n+1 RETURNING n').first()).rejects.toThrow();
  expect(await two.db.prepare('UPDATE effects SET n=n+1 RETURNING n').first()).toEqual({n:1});
 });
 it('keeps a swallowed write failure retryable instead of completing its parent stage',async()=>{
  item.raw.exec("CREATE TRIGGER interrupted_effect BEFORE UPDATE ON effects BEGIN SELECT RAISE(ABORT,'temporary storage failure');END");
  const first=(await acquireWorkflow(item.db,ref))!;
  const bestEffort=async(execution:NonNullable<Awaited<ReturnType<typeof acquireWorkflow>>>)=>execution.step('mileage',async()=>{
    try{await execution.mutationDb('mileage').prepare('UPDATE effects SET n=n+1').run()}catch{/* Existing projection helpers swallow the error. */}
  });
  await expect(bestEffort(first)).rejects.toThrow('unfinished_step');await first.fail();
  item.raw.exec('DROP TRIGGER interrupted_effect');
  const resumed=(await acquireWorkflow(item.db,ref))!;await bestEffort(resumed);await resumed.complete();
  expect(item.raw.prepare('SELECT n FROM effects').get()).toEqual({n:1});
  expect((await getWorkflowStep(item.db,{...ref,stepKey:'__run'}))!.status).toBe('succeeded');
 });
 it('caps a repeatedly failing root instead of replaying forever',async()=>{
  for(let n=0;n<2;n++){const e=(await acquireWorkflow(item.db,ref,{maxAttempts:2}))!;await e.fail()}
  expect(await acquireWorkflow(item.db,ref,{maxAttempts:2})).toBeNull();
  expect((await getWorkflowStep(item.db,{...ref,stepKey:'__run'}))!.status).toBe('exhausted');
 });
 it.each(['delivery_failed','processing_failed'])('holds ambiguous historical LINE failure %s without allocating a new key',async code=>{
  const one=(await acquireWorkflow(item.db,ref))!;const send=vi.fn().mockResolvedValue({requestId:'accepted'});
  const options={stepKey:'legacy_notification'};
  await workflowLineClient({pushMessage:send} as unknown as LineClient,one,options).pushMessage('U1',[{type:'text',text:'original'}]);
  item.raw.prepare("UPDATE workflow_steps SET status='failed',error_code=?,result_json=NULL,max_attempts=5 WHERE step_key='legacy_notification'").run(code);
  const key=item.raw.prepare("SELECT retry_key FROM workflow_steps WHERE step_key='legacy_notification'").get();
  await expect(workflowLineClient({pushMessage:send} as unknown as LineClient,one,options).pushMessage('U1',[{type:'text',text:'changed'}])).rejects.toThrow('delivery_unknown');
  expect(send).toHaveBeenCalledOnce();expect(item.raw.prepare("SELECT retry_key FROM workflow_steps WHERE step_key='legacy_notification'").get()).toEqual(key);
  expect(item.raw.prepare("SELECT status,error_code,attempt_count FROM workflow_steps WHERE step_key='legacy_notification'").get()).toEqual({status:'unknown',error_code:'delivery_unknown',attempt_count:1});
 });

});

it('preserves the full provider deadline even when the LINE step exhausts its wait budget',async()=>{
 const one=(await acquireWorkflow(item.db,ref))!;
 const before=Date.now();
 const send=vi.fn().mockRejectedValue(Object.assign(new Error('not accepted'),{status:429,retryAfter:'7200'}));
 await expect(workflowLineClient({pushMessage:send} as unknown as LineClient,one).pushMessage('U1',[{type:'text',text:'original'}])).rejects.toThrow();
 const row=item.raw.prepare("SELECT status,error_code,next_attempt_at FROM workflow_steps WHERE step_key LIKE 'line:%'").get() as {next_attempt_at:number};
 expect(row).toMatchObject({status:'exhausted',error_code:'retry_after_exceeds_budget'});
 expect(row.next_attempt_at).toBeGreaterThanOrEqual(before+7200_000);
 await expect(workflowLineClient({pushMessage:send} as unknown as LineClient,one).pushMessage('U1',[{type:'text',text:'original'}])).rejects.toThrow();
 expect(send).toHaveBeenCalledOnce();
});

it('preserves the stricter EC retry-key age fence without another wire request',async()=>{
 const one=(await acquireWorkflow(item.db,ref))!;
 const send=vi.fn().mockRejectedValue(Object.assign(new Error('not accepted'),{status:429}));
 const options={stepKey:'customer_notification',retryKeyValidityMs:23*3600_000};
 await expect(workflowLineClient({pushMessage:send} as unknown as LineClient,one,options).pushMessage('U1',[{type:'text',text:'original'}])).rejects.toThrow();
 item.raw.prepare("UPDATE workflow_steps SET next_attempt_at=0,first_attempt_at=? WHERE step_key='customer_notification'").run(Date.now()-23*3600_000);
 await expect(workflowLineClient({pushMessage:send} as unknown as LineClient,one,options).pushMessage('U1',[{type:'text',text:'changed'}])).rejects.toThrow('delivery_unknown');
 expect(send).toHaveBeenCalledOnce();
 expect(item.raw.prepare("SELECT status,error_code FROM workflow_steps WHERE step_key='customer_notification'").get()).toEqual({status:'unknown',error_code:'delivery_unknown'});
});
