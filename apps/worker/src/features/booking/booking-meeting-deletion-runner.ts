import {auditEventStatement,retentionCutoff,toJstString} from '@line-crm/db';
import type {Env} from '../../worker-env.js';
import {meetingOAuthConfig} from './booking-meeting-oauth-config.js';
import {revokeMeetingAuthorization} from './booking-meeting-oauth-client.js';
import {meetingRevokeDecision,type DeletedMeetingCredential} from './booking-meeting-revoke-decision.js';
import {acquireMeetingRevokeLock,ownsMeetingRevokeLock,releaseMeetingRevokeLock} from './booking-meeting-revoke-lock.js';
import {encryptMeetingCredential,meetingCredentialKeys} from './booking-meeting-crypto.js';

const SCOPE='global:meeting-revoke-queue', KIND='booking_meeting_deleted_revoke';
type Item={accountId:string;staffId:string;provider:'google_meet'|'zoom'|'teams'|'outlook'|'google_calendar';connectionId:string;credentialEnc:string|null;tenantId:string|null;source:'staff'|'account'|'tenant';needsManual:number;authType?:string};
type Row={subject_id:string;input_json:string|null;lease_owner:string|null;created_at:number};
/** 削除の後に認可の交換が戻った場合、手元へ復活させず、確定済みの台帳へ渡す。 */
export async function queueAbandonedMeetingAuthorization(env:Env['Bindings'],input:{accountId:string;staffId:string;tenantId:string|null;provider:'google_meet'|'zoom'|'teams'|'outlook';credential:{provider:'google_meet'|'zoom'|'teams'|'outlook';externalAccountId:string;refreshToken:string;accessToken:string;accessExpiresAt:string}}):Promise<void>{
 const state=await env.DB.prepare(`SELECT a.id,a.archived_at,t.plan_status,t.purge_requested_at,t.data_purged_at,t.retention_anchor_at FROM line_accounts a LEFT JOIN tenants t ON t.id=a.tenant_id WHERE a.id=?`).bind(input.accountId).first<{id:string;archived_at:string|null;plan_status:string|null;purge_requested_at:string|null;data_purged_at:string|null;retention_anchor_at:string|null}>();
 const purgeDue=!!state && ['canceled','trialing'].includes(state.plan_status??'') && (!!state.purge_requested_at || (!!state.retention_anchor_at && state.retention_anchor_at<retentionCutoff(toJstString(new Date()))));
 const source=(!state?.id||purgeDue)?'tenant':state.archived_at?'account':'staff';
 let manual=input.provider==='teams'||input.provider==='outlook';const id=crypto.randomUUID(),now=Date.now();
 let credentialEnc:string|null=null;
 if(!manual){try{credentialEnc=await encryptMeetingCredential(JSON.stringify(input.credential),meetingCredentialKeys(env),input);}catch{manual=true;}}
 const data={accountId:input.accountId,staffId:input.staffId,tenantId:input.tenantId,provider:input.provider,connectionId:id,credentialEnc,source,needsManual:manual?1:0};
 await env.DB.prepare(`INSERT INTO workflow_steps(scope_id,process_kind,subject_id,step_key,status,retry_key,input_json,created_at,updated_at,next_attempt_at) VALUES(?,?,?,'current','pending',?,?,?,?,?)`)
  .bind(SCOPE,KIND,id,id,JSON.stringify(data),now,now,manual?now+15*60000:null).run();
}
function parse(raw:string|null):Item|null{
 try{const v=JSON.parse(raw??'null') as Item;if(!v||!['google_meet','zoom','teams','outlook','google_calendar'].includes(v.provider)||typeof v.accountId!=='string'||typeof v.staffId!=='string'||typeof v.connectionId!=='string'||!['staff','account','tenant'].includes(v.source))return null;return v;}catch{return null;}
}
/** 処理済みまたは要確認へ移すときに暗号文を必ず同じ取引で消す。 */
async function finish(db:D1Database,row:Row,owner:string,item:Item|null,result:'done'|'shared'|'review',reason:string):Promise<void>{
 const guard="EXISTS(SELECT 1 FROM workflow_steps WHERE scope_id=? AND process_kind=? AND subject_id=? AND step_key='current' AND status='running' AND lease_owner=?)",params=[SCOPE,KIND,row.subject_id,owner];
 const operations:D1PreparedStatement[]=[];
 if(result==='review'){
  operations.push(auditEventStatement(db,{sourceKind:'booking_deleted_revoke',sourceId:row.subject_id,tenantId:item?.tenantId??undefined,category:'business',action:'booking.meeting.deleted_connection_review',actorPrincipalId:'system:booking',targetKind:'meeting_connection',targetId:row.subject_id,result:'failed',riskLevel:'high',retentionClass:'security',after:{provider:item?.provider??'unknown',reason}}, {sql:guard,params}));
  if(item){const label=item.provider==='teams'||item.provider==='outlook'?'Microsoft':item.provider==='zoom'?'Zoom':'Google';
   const body=item.provider==='teams'||item.provider==='outlook'?'Microsoft 側のアプリ接続を確認してください。他の接続への影響を先に確認し、解除してよい場合は Microsoft アカウントの「アプリとサービス」から対象アプリの接続を解除してください。':item.provider==='google_calendar'?'Google カレンダー側の共有・接続を確認してください。同じアカウントを使う他の連携がないか確認してください。':`${label} 側の接続解除を確認してください。同じアカウントを使う他の連携がないか確認してください。`;
   operations.push(db.prepare(`INSERT OR IGNORE INTO notifications(id,event_type,title,body,channel,status,metadata,line_account_id,category)
    SELECT ?,'booking_meeting_disconnect_review','外部サービスの接続解除を確認してください',?,'dashboard','sent','{}',a.id,'error' FROM line_accounts a WHERE a.id=? AND ${guard}`)
    .bind(`deleted-meeting-review:${row.subject_id}`,body,item.accountId,...params));
  }
 }
 operations.push(db.prepare("UPDATE workflow_steps SET status=?,input_json=NULL,result_json=?,lease_owner=NULL,lease_expires_at=NULL,error_code=?,updated_at=? WHERE scope_id=? AND process_kind=? AND subject_id=? AND step_key='current' AND status='running' AND lease_owner=?")
  .bind(result==='review'?'unknown':result==='shared'?'canceled':'succeeded',result==='review'?JSON.stringify({provider:item?.provider??'unknown',authType:item?.authType??null,tenantId:item?.tenantId??null,accountId:item?.accountId??null,staffId:item?.staffId??null}):null,result==='review'?reason:null,Date.now(),...params));
 await db.batch(operations);
}
/** 削除のトランザクション確定後にのみ実行。結果が不明なら再送せず秘密を消す。 */
export async function processDeletedMeetingRevocations(env:Env['Bindings'],options:{now?:number;limit?:number}={}):Promise<number>{
 const now=options.now??Date.now(),limit=Math.min(Math.max(options.limit??20,1),50);
 const expired=await env.DB.prepare("SELECT subject_id,input_json,lease_owner,created_at FROM workflow_steps WHERE scope_id=? AND process_kind=? AND status='running' AND lease_expires_at<=? LIMIT ?").bind(SCOPE,KIND,now,limit).all<Row>();
 for(const row of expired.results){if(row.lease_owner)await finish(env.DB,row,row.lease_owner,parse(row.input_json),'review','interrupted');}
 const candidates=await env.DB.prepare(`SELECT subject_id,input_json,lease_owner,created_at FROM workflow_steps WHERE scope_id=? AND process_kind=? AND status='pending' AND COALESCE(next_attempt_at,0)<=?
  AND CASE WHEN json_valid(input_json) THEN CASE WHEN json_extract(input_json,'$.source')='tenant' AND created_at>?
   THEN EXISTS(SELECT 1 FROM tenants t WHERE t.id=json_extract(workflow_steps.input_json,'$.tenantId') AND t.data_purged_at IS NOT NULL) ELSE 1 END ELSE 1 END
  ORDER BY created_at,subject_id LIMIT ?`).bind(SCOPE,KIND,now,now-30*86400000,limit).all<Row>();
 let processed=0;
 for(const row of candidates.results){
  const item=parse(row.input_json);
  // 統括 purge は全表と監査を確定した後まで外部へ触らない。
  let purgeUnconfirmed=false,eligibleAt=row.created_at;
  if(item?.source==='tenant'){
   const tenant=item.tenantId?await env.DB.prepare('SELECT data_purged_at FROM tenants WHERE id=?').bind(item.tenantId).first<{data_purged_at:string|null}>():null;
   if(!tenant?.data_purged_at){if(now-row.created_at<30*86400000)continue;purgeUnconfirmed=true;}
   else {const completed=Date.parse(tenant.data_purged_at);if(!Number.isFinite(completed))purgeUnconfirmed=true;else eligibleAt=completed;}
  }
  const owner=crypto.randomUUID(),claimed=await env.DB.prepare("UPDATE workflow_steps SET status='running',lease_owner=?,lease_expires_at=?,updated_at=? WHERE scope_id=? AND process_kind=? AND subject_id=? AND step_key='current' AND status='pending' AND input_json IS ?")
   .bind(owner,now+60000,now,SCOPE,KIND,row.subject_id,row.input_json).run();if(claimed.meta.changes!==1)continue;processed++;
  if(purgeUnconfirmed){await finish(env.DB,row,owner,item,'review','purge_unconfirmed');continue;}
  if(item&&(item.provider==='teams'||item.provider==='outlook')){const active=await env.DB.prepare('SELECT 1 FROM booking_meeting_connections WHERE line_account_id=? AND staff_id=? AND provider=? LIMIT 1').bind(item.accountId,item.staffId,item.provider).first();if(active){await finish(env.DB,row,owner,item,'shared','shared');continue;}}
  if(!item||item.needsManual||!item.credentialEnc||item.provider==='teams'||item.provider==='outlook'||item.provider==='google_calendar'){await finish(env.DB,row,owner,item,'review','manual');continue;}
  if(now-eligibleAt>=86400000){await finish(env.DB,row,owner,item,'review','expired');continue;}
  const scope={accountId:item.accountId,staffId:item.staffId,provider:item.provider},lock=await acquireMeetingRevokeLock(env.DB,scope);
  if(!lock){await env.DB.prepare("UPDATE workflow_steps SET status='pending',lease_owner=NULL,lease_expires_at=NULL,next_attempt_at=?,updated_at=? WHERE scope_id=? AND process_kind=? AND subject_id=? AND step_key='current' AND status='running' AND lease_owner=?").bind(now+60000,now,SCOPE,KIND,row.subject_id,owner).run();continue;}
  try{
   const decision=await meetingRevokeDecision(env,item as DeletedMeetingCredential);
   if(decision.decision==='shared'){await finish(env.DB,row,owner,item,'shared','shared');continue;}
   const config=meetingOAuthConfig(env,item.provider);
   if(decision.decision!=='revoke'||!decision.token||!config||!await ownsMeetingRevokeLock(env.DB,scope,lock)){await finish(env.DB,row,owner,item,'review','unverified');continue;}
   const result=await revokeMeetingAuthorization(config,{token:decision.token,signal:AbortSignal.timeout(15000)});
   await finish(env.DB,row,owner,item,result==='done'?'done':'review',result==='done'?'done':'external_failure');
  }finally{await releaseMeetingRevokeLock(env.DB,scope,lock);}
 }
 return processed;
}
