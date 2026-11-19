import type { Message } from '@line-crm/line-sdk';
import type { Env } from '../../worker-env.js';
import { getAccountTimeZone, tzDateStr, tzHHMM } from '../../services/availability.js';
import { NotificationDeliveryBlocked, NotificationDeliveryIncomplete, sendRecordedNotification } from '../../services/recorded-notification-send.js';

type Candidate={id:string;account_id:string;friend_id:string;line_user_id:string;kind:'remaining_one'|'expiry_14_days';name:string;expires_at:string};
type Transmit=(input:{id:string;accountId:string;friendId:string;to:string;messages:Message[];retryKey:string})=>Promise<void>;

/** 配信先・券・同意と設定を送信の直前にも照合する。 */
async function eligible(db:D1Database,id:string,now:Date):Promise<{row:Candidate;messages:Message[]}|null>{
 const row=await db.prepare(`SELECT n.id,n.line_account_id account_id,n.friend_id,f.line_user_id,n.kind,e.name,e.expires_at
 FROM booking_entitlement_notices n JOIN booking_entitlements e ON e.id=n.entitlement_id AND e.line_account_id=n.line_account_id AND e.friend_id=n.friend_id
 JOIN booking_pass_plans p ON p.id=n.plan_id AND p.line_account_id=n.line_account_id AND p.id=e.plan_id
 JOIN friends f ON f.id=n.friend_id AND f.line_account_id=n.line_account_id AND f.is_following=1 AND f.is_hidden=0 AND length(trim(f.line_user_id))>0
 JOIN line_accounts a ON a.id=n.line_account_id AND a.is_active=1 AND a.archived_at IS NULL JOIN tenants t ON t.id=a.tenant_id AND t.status='active'
 WHERE n.id=? AND n.status='scheduled' AND julianday(n.scheduled_at)<=julianday(?) AND julianday(n.scheduled_at)>=julianday(?,'-3 hours')
 AND e.status='active' AND e.billing_status!='stopped' AND (e.billing_status!='grace' OR julianday(e.grace_until)>julianday(?))
 AND julianday(e.valid_from)<=julianday(?) AND julianday(e.expires_at)>julianday(?)
 AND (n.kind='remaining_one' AND p.notify_remaining_one=1 AND e.remaining=1 OR n.kind='expiry_14_days' AND p.notify_expiry_14_days=1 AND e.expires_at=n.dedupe_key)
 AND NOT EXISTS(SELECT 1 FROM friend_delivery_consents d WHERE d.line_account_id=n.line_account_id AND d.friend_id=n.friend_id AND d.purpose IN('transaction','transactional','reservation','booking_reminders') AND d.state!='granted')
 AND EXISTS(SELECT 1 FROM account_settings s,json_each(CASE WHEN json_valid(s.value) THEN CASE WHEN json_type(s.value)='array' THEN s.value ELSE '[]' END ELSE '[]' END) r
  WHERE s.line_account_id=n.line_account_id AND s.key='test_recipients' AND r.type='text' AND r.value=n.friend_id
  AND NOT EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(s.value) THEN CASE WHEN json_type(s.value)='array' THEN s.value ELSE '[]' END ELSE '[]' END) bad WHERE bad.type!='text' OR length(trim(bad.value))=0))`)
 .bind(id,now.toISOString(),now.toISOString(),now.toISOString(),now.toISOString(),now.toISOString()).first<Candidate>();
 if(!row)return null;
 const zone=await getAccountTimeZone(db,row.account_id),hour=tzHHMM(zone,now);
 if(hour<'08:00'||hour>='21:00')return null;
 const day=tzDateStr(zone,new Date(row.expires_at));
 return {row,messages:[{type:'text',text:row.kind==='remaining_one'?`${row.name}の残りは1回です（期限 ${day}）`:`${row.name}の期限は${day}です（あと14日）`}]};
}

export async function processLivePassNotices(db:D1Database,now:Date,transmit:Transmit,clock:()=>Date=()=>new Date()){
 const rows=(await db.prepare(`SELECT n.id FROM booking_entitlement_notices n WHERE n.status='scheduled' AND julianday(n.scheduled_at)<=julianday(?)
 AND NOT EXISTS(SELECT 1 FROM outbound_send_requests o WHERE o.resource_id='pass-notice:'||n.id AND (o.status IN ('succeeded','unknown','in_progress') OR o.status='failed' AND COALESCE(o.failure_code,'')!='NOTIFICATION_PRECONDITION_CHANGED')) ORDER BY n.scheduled_at,n.id LIMIT 100`).bind(now.toISOString()).all<{id:string}>()).results;
 let processed=0;
 for(const item of rows){
  const candidate=await eligible(db,item.id,now);if(!candidate)continue;
  const {row,messages}=candidate,day=tzDateStr('Asia/Tokyo',now);
  const cap=await db.prepare('INSERT INTO booking_pass_notice_cap(notice_id,account_id,friend_id,day_jst,reserved_at) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING')
   .bind(row.id,row.account_id,row.friend_id,day,now.toISOString()).run();
  if(cap.meta.changes!==1&&!await db.prepare('SELECT 1 FROM booking_pass_notice_cap WHERE notice_id=? AND account_id=? AND friend_id=? AND day_jst=?').bind(row.id,row.account_id,row.friend_id,day).first())continue;
  try{
   await sendRecordedNotification(db,{sourceId:`pass-notice:${row.id}`,channel:'line',recipient:row.friend_id,lineAccountId:row.account_id,payload:JSON.stringify(messages),send:async retryKey=>{
    const fresh=await eligible(db,row.id,clock());
    if(!fresh||fresh.row.friend_id!==row.friend_id||fresh.row.line_user_id!==row.line_user_id||JSON.stringify(fresh.messages)!==JSON.stringify(messages))throw new NotificationDeliveryBlocked('pass_notice_changed');
    await transmit({id:row.id,accountId:row.account_id,friendId:row.friend_id,to:row.line_user_id,messages,retryKey});
   }});
   await db.prepare("UPDATE booking_entitlement_notices SET status='simulated',processed_at=?,messages_json=? WHERE id=? AND status='scheduled'").bind(now.toISOString(),JSON.stringify(messages),row.id).run();
   processed++;
  }catch(error){if(!(error instanceof NotificationDeliveryIncomplete))throw error;}
 }
 return {processed};
}

export async function processStagingPassNotices(env:Env['Bindings'],now:Date){
 if(env.DEPLOY_ENV!=='staging'||env.PASS_NOTICE_STAGING_DELIVERY_ENABLED!=='true')return {processed:0};
 const {activeTenantLineAccountSql,isOperationCapabilityStopped,resolveLineCredential}=await import('@line-crm/db');
 const {getSendPermissionForAccount}=await import('../../services/send-entitlements.js');
 const {featureJobCanRun}=await import('../../services/feature-enforcement.js');
 const {pushViaHarnessProxy}=await import('../../services/line-proxy-send.js');
 const {dispatchLineProxyLocally}=await import('../../services/local-line-proxy.js');
 return processLivePassNotices(env.DB,now,async input=>{
  if(!(await getSendPermissionForAccount(env.DB,input.accountId)).allowed||await isOperationCapabilityStopped(env.DB,input.accountId,'reminder_dispatch')||!await featureJobCanRun(env.DB,{accountId:input.accountId,featureId:'booking',job:'pass notice'}))throw new NotificationDeliveryBlocked('sending_stopped');
  const account=await env.DB.prepare(`SELECT channel_access_token,channel_access_token_encrypted FROM line_accounts la WHERE la.id=? AND la.is_active=1 AND la.archived_at IS NULL AND ${activeTenantLineAccountSql('la.id')}`).bind(input.accountId).first<{channel_access_token:string|null;channel_access_token_encrypted:string|null}>();
  if(!account)throw new NotificationDeliveryBlocked('account_unavailable');
  const token=await resolveLineCredential(account.channel_access_token_encrypted,account.channel_access_token,{lineAccountId:input.accountId,field:'channel_access_token'},env.LINE_CREDENTIAL_ENCRYPTION_KEY);
  if(!token||!(await getSendPermissionForAccount(env.DB,input.accountId)).allowed||await isOperationCapabilityStopped(env.DB,input.accountId,'reminder_dispatch')||!await featureJobCanRun(env.DB,{accountId:input.accountId,featureId:'booking',job:'pass notice'}))throw new NotificationDeliveryBlocked('sending_stopped');
  const fresh=await eligible(env.DB,input.id,new Date());
  const cap=await env.DB.prepare('SELECT 1 FROM booking_pass_notice_cap WHERE notice_id=? AND account_id=? AND friend_id=? AND day_jst=?').bind(input.id,input.accountId,input.friendId,tzDateStr('Asia/Tokyo',new Date())).first();
  if(!cap||!fresh||fresh.row.account_id!==input.accountId||fresh.row.friend_id!==input.friendId||fresh.row.line_user_id!==input.to||JSON.stringify(fresh.messages)!==JSON.stringify(input.messages))throw new NotificationDeliveryBlocked('pass_notice_changed');
  await pushViaHarnessProxy(env.WORKER_PUBLIC_URL||env.WORKER_URL||'https://worker.invalid',token,input.to,input.messages,input.retryKey,request=>dispatchLineProxyLocally(request,env));
 });
}
