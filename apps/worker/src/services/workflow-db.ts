import {
  claimWorkflowStep,ensureWorkflowStep,failWorkflowStep,getWorkflowStep,finishWorkflowStep,
  workflowFence,workflowJson,type WorkflowStepRef,
} from '@line-crm/db';

import { WorkflowDeferred } from './workflow-error.js';
import { classifySingleStatement } from './incoming-webhook-fenced-db.js';

const aliasesForDb=new WeakMap<D1Database,Map<string,string>>();
const rawForDb=new WeakMap<D1Database,D1Database>();
/** 送信直前の最新状態は、再生される SQL 計画とは別に読み取る。 */
export function rawWorkflowDb(db:D1Database):D1Database { return rawForDb.get(db) ?? db; }
export function normalizeWorkflowResult<T>(db:D1Database,value:T):T{
  const aliases=aliasesForDb.get(db);
  return JSON.parse(JSON.stringify(value ?? null,(_key,item)=>typeof item==='string'?(aliases?.get(item) ?? item):item)) as T;
}
/** 読取で処理計画を固定し、各書込と SQL の受領票を原子的に確定する。 */
export function workflowMutationDb(db:D1Database,root:WorkflowStepRef,owner:string,prefix:string):D1Database {
  let writes=0,reads=0;
  const aliases=new Map<string,string>();
  const originals=new WeakMap<D1PreparedStatement,{sql:string;args:unknown[]}>();
  const mapped=(args:unknown[])=>args.map(arg=>typeof arg==='string'?(aliases.get(arg) ?? arg):arg);
  const execute=async(items:Array<{sql:string;args:unknown[]}>)=>{
    const ref={...root,stepKey:`${prefix}:sql:${writes++}`};
    if(items.some(item=>/\b(channel_access_token|channel_secret|reply_token|password|api_key)\b/i.test(item.sql)))
      throw new Error('workflow_secret_write_unsupported');
    const previous=await ensureWorkflowStep(db,ref,{maxAttempts:50,input:items});
    const plan=JSON.parse(previous.input_json!) as Array<{sql:string;args:unknown[]}>;
    if(plan.length!==items.length || plan.some((item,i)=>item.sql!==items[i]!.sql))throw new Error('workflow_plan_changed');
    // INSERT 前に作る一時 UUID を再試行でも同じ保存 ID に対応させ、後続の照会先を変えない。
    for(let i=0;i<items.length;i++)for(let j=0;j<items[i]!.args.length;j++){
      const current=items[i]!.args[j],original=plan[i]!.args[j];
      if(typeof current==='string' && typeof original==='string' && current!==original
        && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(current) && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(original))aliases.set(current,original);
    }
    if(previous.status==='succeeded')return JSON.parse(previous.result_json!) as D1Result[];
    const claimed=await claimWorkflowStep(db,ref);
    if(!claimed)throw new WorkflowDeferred((await getWorkflowStep(db,ref))?.status ?? 'busy');
    try{
      const statements=[workflowFence(db,root,owner),workflowFence(db,ref,claimed.lease_owner!),
        db.prepare(`UPDATE workflow_steps SET result_json='[]' WHERE scope_id=? AND process_kind=? AND subject_id=? AND step_key=?`)
          .bind(ref.scopeId,ref.processKind,ref.subjectId,ref.stepKey)];
      for(const item of plan){
        statements.push(db.prepare(item.sql).bind(...mapped(item.args)),db.prepare(`UPDATE workflow_steps SET result_json=json_insert(result_json,'$[#]',
          json_object('meta',json_object('changes',changes(),'last_row_id',last_insert_rowid())))
          WHERE scope_id=? AND process_kind=? AND subject_id=? AND step_key=?`).bind(ref.scopeId,ref.processKind,ref.subjectId,ref.stepKey));
      }
      statements.push(db.prepare(`UPDATE workflow_steps SET status='succeeded',lease_owner=NULL,lease_expires_at=NULL,updated_at=?
        WHERE scope_id=? AND process_kind=? AND subject_id=? AND step_key=? AND lease_owner=?`)
        .bind(Date.now(),ref.scopeId,ref.processKind,ref.subjectId,ref.stepKey,claimed.lease_owner));
      const results=await db.batch(statements);
      return plan.map((_item,i)=>results[3+2*i]!);
    }catch(error){await failWorkflowStep(db,ref,claimed.lease_owner!,{delayMs:0});throw error;}
  };
  const read=async(sql:string,args:unknown[],method:'first'|'all',column?:string)=>{
    const statement=db.prepare(sql).bind(...mapped(args));
    // 資格情報は常に現在値を使い、アカウントや秘密値を含む問い合わせを写しやキャッシュへ残さない。
    if(/\b(line_accounts|.*credentials.*|.*secrets.*|.*tokens.*|staff_sessions)\b/i.test(sql))return column===undefined?statement[method]():statement.first(column);
    const ref={...root,stepKey:`${prefix}:read:${reads++}`};
    const previous=await ensureWorkflowStep(db,ref,{maxAttempts:50});
    if(previous.status==='succeeded')return JSON.parse(previous.result_json ?? 'null');
    const claimed=await claimWorkflowStep(db,ref);
    if(!claimed)throw new WorkflowDeferred('read_busy');
    try{
      const result=column===undefined?await statement[method]():await statement.first(column);
      workflowJson(result);
      await finishWorkflowStep(db,ref,claimed.lease_owner!,{result,statements:[workflowFence(db,root,owner)]});return result;
    }catch(error){await failWorkflowStep(db,ref,claimed.lease_owner!,{delayMs:0});throw error;}
  };
  const wrap=(sql:string,args:unknown[]=[]):D1PreparedStatement=>{
    const classified=classifySingleStatement(sql,{withAsMutation:true}),item=db.prepare(classified.sql);
    const proxy=new Proxy(item,{get(_target,key){
      if(key==='bind')return(...values:unknown[])=>wrap(classified.sql,values);
      if(key==='run')return async()=>(await execute([{sql:classified.sql,args}]))[0];
      if((key==='first'||key==='all') && classified.readOnly)return(column?:string)=>read(classified.sql,args,key,column);
      throw new Error(`workflow_statement_api_unsupported:${String(key)}`);
    }});
    originals.set(proxy,{sql:classified.sql,args});return proxy;
  };
  const wrapped=new Proxy(db,{get(_target,key){
    if(key==='prepare')return wrap;
    if(key==='batch')return(items:D1PreparedStatement[])=>{
      const plan=items.map(item=>{const original=originals.get(item);if(!original)throw new Error('workflow_foreign_statement');return original});
      if(plan.every(item=>classifySingleStatement(item.sql,{withAsMutation:true}).readOnly))return Promise.all(plan.map(item=>read(item.sql,item.args,'all')));
      if(plan.some(item=>classifySingleStatement(item.sql,{withAsMutation:true}).readOnly))throw new Error('workflow_mixed_batch_unsupported');
      return execute(plan);
    };
    throw new Error(`workflow_database_api_unsupported:${String(key)}`);
  }});
  aliasesForDb.set(wrapped,aliases);rawForDb.set(wrapped,db);return wrapped;
}
