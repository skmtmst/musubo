import {decryptCredential} from '@line-crm/db';
import type {CleanupPlanItem} from './booking-external-cleanup-plan.js';

export type CleanupOutcome = 'done' | 'retry' | 'wait' | 'review';
export type CleanupExecutor = (accountId:string,item:CleanupPlanItem)=>Promise<CleanupOutcome>;
const RETAIN_UNTIL = "CASE WHEN json_valid(result_json) THEN COALESCE(CAST(json_extract(result_json,'$.retainUntil') AS INTEGER),created_at+63072000000) ELSE created_at+63072000000 END";

export async function notifyExternalCleanupReview(db:D1Database,accountId:string):Promise<void>{
 const count=await db.prepare("SELECT COUNT(*) n FROM workflow_steps WHERE scope_id=? AND process_kind='booking_external_cleanup' AND status='unknown'").bind(`line:${accountId}`).first<{n:number}>();
 const id=`external-cleanup-review:${accountId}`,n=count?.n??0;
 if(!n){await db.prepare("UPDATE notifications SET body='外部の予定・会議の確認は完了しました。',category='info',metadata='{}' WHERE id=?").bind(id).run();return;}
 await db.batch([
  db.prepare("DELETE FROM staff_notification_reads WHERE notification_id=? AND ?>COALESCE((SELECT json_extract(metadata,'$.count') FROM notifications WHERE id=?),0)").bind(id,n,id),
  db.prepare(`INSERT INTO notifications(id,event_type,title,body,channel,status,metadata,line_account_id,category)
   VALUES(?,'booking_external_cleanup_review','外部の予定の確認が必要です',?,'dashboard','sent',?,?,'error')
   ON CONFLICT(id) DO UPDATE SET body=excluded.body,metadata=excluded.metadata,category='error'`)
   .bind(id,`外部の予定・会議 ${n} 件を確認してください。`,JSON.stringify({count:n}),accountId),
 ]);
}

/** 予約が消えた後も、暗号化した参照を lease 付きで1件ずつ処理する。 */
export async function processExternalCleanup(db:D1Database,input:{encryptionKey:string;execute:CleanupExecutor;now?:number;limit?:number}):Promise<number>{
 const now=input.now??Date.now();
 // 前の Worker が途中で落ちた場合、送信の有無は断定しない。
 const expired=await db.prepare("SELECT DISTINCT scope_id FROM workflow_steps WHERE process_kind='booking_external_cleanup' AND status='running' AND lease_expires_at<=?").bind(now).all<{scope_id:string}>();
 await db.prepare(`UPDATE workflow_steps SET status='unknown',lease_owner=NULL,lease_expires_at=NULL,error_code='cleanup_interrupted',updated_at=?
  WHERE process_kind='booking_external_cleanup' AND status='running' AND lease_expires_at<=?`).bind(now,now).run();
 for(const row of expired.results??[])if(row.scope_id.startsWith('line:'))await notifyExternalCleanupReview(db,row.scope_id.slice(5));
 // 期限の10日前には待機中の行も人の確認へ移し、設定オフのまま失われないよう知らせる。
 await db.prepare(`UPDATE workflow_steps SET status='unknown',error_code='cleanup_retention_expiring',next_attempt_at=NULL,updated_at=? WHERE process_kind='booking_external_cleanup' AND status='pending' AND (${RETAIN_UNTIL})<=?`)
  .bind(now,now+10*86400000).run();
 // 予定日までの空き枠除外も守り、期限後は参照を消して未解決の事実だけ知らせる。
 const old=await db.prepare(`SELECT scope_id FROM workflow_steps WHERE process_kind='booking_external_cleanup' AND status!='running' AND (${RETAIN_UNTIL})<=? GROUP BY scope_id LIMIT 50`).bind(now).all<{scope_id:string}>();
 for(const row of old.results??[]){
  if(!row.scope_id.startsWith('line:'))continue;
  const account=row.scope_id.slice(5);
  await db.batch([
   db.prepare(`INSERT INTO notifications(id,event_type,title,body,channel,status,metadata,line_account_id,category)
    SELECT ?,'booking_external_cleanup_expired','外部の予定を確認してください','後片づけの保管期限が過ぎ、詳細を消しました。相手先を確認してください。','dashboard','sent','{}',?,'error'
    WHERE EXISTS(SELECT 1 FROM workflow_steps WHERE scope_id=? AND process_kind='booking_external_cleanup' AND status!='running' AND (${RETAIN_UNTIL})<=?)
    ON CONFLICT(id) DO UPDATE SET body=excluded.body,category='error'`)
    .bind(`external-cleanup-expired:${account}`,account,row.scope_id,now),
   db.prepare(`DELETE FROM workflow_steps WHERE scope_id=? AND process_kind='booking_external_cleanup' AND status!='running' AND (${RETAIN_UNTIL})<=?`).bind(row.scope_id,now),
  ]);
  await notifyExternalCleanupReview(db,account);
 }
 // 通知の書込みだけが失敗しても、次の回に要確認件数を作り直せる。
 const review=await db.prepare(`WITH groups AS (SELECT scope_id,COUNT(*) n FROM workflow_steps WHERE process_kind='booking_external_cleanup' AND status='unknown' GROUP BY scope_id)
  SELECT g.scope_id FROM groups g LEFT JOIN notifications n ON n.id='external-cleanup-review:'||substr(g.scope_id,6)
  WHERE n.body IS NOT ('外部の予定・会議 '||g.n||' 件を確認してください。') LIMIT 50`).all<{scope_id:string}>();
 for(const row of review.results??[])if(row.scope_id.startsWith('line:'))await notifyExternalCleanupReview(db,row.scope_id.slice(5));
 const rows=await db.prepare(`SELECT scope_id,subject_id,input_json,attempt_count FROM workflow_steps
  WHERE process_kind='booking_external_cleanup' AND status='pending' AND COALESCE(next_attempt_at,0)<=?
  ORDER BY updated_at,subject_id LIMIT ?`).bind(now,Math.min(Math.max(input.limit??25,1),50)).all<{scope_id:string;subject_id:string;input_json:string|null;attempt_count:number}>();
 let processed=0;
 for(const row of rows.results??[]){
  const owner=crypto.randomUUID();
  const claimed=await db.prepare(`UPDATE workflow_steps SET status='running',lease_owner=?,lease_expires_at=?,attempt_count=attempt_count+1,updated_at=?
   WHERE scope_id=? AND process_kind='booking_external_cleanup' AND subject_id=? AND step_key='current' AND status='pending' AND input_json IS ? AND COALESCE(next_attempt_at,0)<=?`)
   .bind(owner,now+60000,now,row.scope_id,row.subject_id,row.input_json,now).run();
  if(!claimed.meta.changes)continue;
  processed++;
  let outcome:CleanupOutcome='review';
  try {
   const payload:unknown=JSON.parse(row.input_json??'null');
   if(typeof payload==='string' && row.scope_id.startsWith('line:')){
    const data:unknown=JSON.parse(await decryptCredential(payload,input.encryptionKey));
    if(data&&typeof data==='object'&&!Array.isArray(data)) {
     const item=data as CleanupPlanItem;
     if(['google_calendar','google_meet','zoom','teams','outlook'].includes(item.provider) && ['delete','redact','review'].includes(item.action) && typeof item.staffId==='string' && item.staffId)
      outcome=await input.execute(row.scope_id.slice(5),item);
    }
   }
  }catch{/* 外部応答や秘密の内容を記録しない。 */}
  if(outcome==='done'){
   await db.prepare(`DELETE FROM workflow_steps WHERE scope_id=? AND process_kind='booking_external_cleanup' AND subject_id=? AND step_key='current' AND status='running' AND lease_owner=?`).bind(row.scope_id,row.subject_id,owner).run();
  }else {
   const wait=outcome==='wait',retry=wait || outcome==='retry' && row.attempt_count+1<3;
   const saved=await db.prepare(`UPDATE workflow_steps SET status=?,lease_owner=NULL,lease_expires_at=NULL,error_code=?,next_attempt_at=?,updated_at=?,attempt_count=CASE WHEN ?=1 THEN MAX(attempt_count-1,0) ELSE attempt_count END
    WHERE scope_id=? AND process_kind='booking_external_cleanup' AND subject_id=? AND step_key='current' AND status='running' AND lease_owner=?`)
    .bind(retry?'pending':'unknown',wait?'cleanup_wait':retry?'cleanup_retry':'cleanup_review',retry?now+300000:null,now,wait?1:0,row.scope_id,row.subject_id,owner).run();
   if(saved.meta.changes&&!retry&&row.scope_id.startsWith('line:'))await notifyExternalCleanupReview(db,row.scope_id.slice(5));
  }
 }
 return processed;
}
