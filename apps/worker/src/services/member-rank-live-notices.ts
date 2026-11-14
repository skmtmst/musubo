import type { Message } from '@line-crm/line-sdk';
import { NotificationDeliveryBlocked, NotificationDeliveryIncomplete, sendRecordedNotification } from './recorded-notification-send.js';

type Candidate={id:string;account_id:string;friend_id:string;line_user_id:string|null;scheduled_at:string;status:string;gate:string|null;messages:string;original_messages:string;base_messages:string};
type Transmit=(input:{accountId:string;friendId:string;noticeId:string;to:string;messages:Message[];retryKey:string})=>Promise<unknown>;

/** 送信直前の判定。同意の読取と停止の判定を予約のたびにやり直す。 */
async function candidate(db:D1Database,id:string,now:Date):Promise<Candidate|null>{
 return db.prepare(`SELECT n.id,n.account_id,n.friend_id,f.line_user_id,n.scheduled_at,n.status,n.messages_json original_messages,n.base_messages_json base_messages,
 CASE WHEN NOT EXISTS(SELECT 1 FROM member_rank_programs p WHERE p.account_id=n.account_id AND p.status='active' AND CASE WHEN n.kind='upgrade' THEN p.notify_upgrade ELSE p.notify_downgrade END=1) THEN 'skipped_disabled'
 WHEN julianday(?)>julianday(n.scheduled_at,'+3 hours') THEN 'skipped_late'
 WHEN f.id IS NULL OR f.is_following<>1 OR f.is_hidden=1 OR f.line_user_id IS NULL OR trim(f.line_user_id)='' THEN 'skipped_blocked'
 WHEN EXISTS(SELECT 1 FROM friend_delivery_consents c WHERE c.friend_id=n.friend_id AND c.line_account_id=n.account_id AND c.purpose IN('notice','notification') AND c.state='revoked') THEN 'skipped_opted_out'
 WHEN n.kind='downgrade_warning' AND NOT EXISTS(SELECT 1 FROM member_ranks r WHERE r.account_id=n.account_id AND r.friend_id=n.friend_id AND r.downgrade_due_at=n.change_key) THEN 'cancelled'
 ELSE NULL END gate,
 CASE WHEN EXISTS(SELECT 1 FROM friend_delivery_consents c WHERE c.friend_id=n.friend_id AND c.line_account_id=n.account_id AND c.purpose IN('marketing','promotion','advertising','宣伝') AND c.state='revoked') THEN n.base_messages_json ELSE n.messages_json END messages
 FROM member_rank_notices n LEFT JOIN friends f ON f.id=n.friend_id AND f.line_account_id=n.account_id WHERE n.id=?`).bind(now.toISOString(),id).first<Candidate>();
}

/** テスト用の送信口を注入できる。実送信の設定を持たない限り呼び出されない。 */
export async function processLiveRankNotices(db:D1Database,now:Date,options:{transmit:Transmit}){
 const rows=(await db.prepare(`SELECT n.id FROM member_rank_notices n WHERE n.status='scheduled' AND julianday(n.scheduled_at)<=julianday(?)
 AND NOT EXISTS(SELECT 1 FROM outbound_send_requests o WHERE o.resource_id='rank-notice:'||n.id AND (o.status IN('in_progress','unknown','succeeded') OR (o.status='failed' AND (o.retryable=0 OR o.next_retry_at>?))))
 ORDER BY n.scheduled_at,n.id LIMIT 100`).bind(now.toISOString(),now.toISOString()).all<{id:string}>()).results;
 let processed=0;
 for(const row of rows){
  const item=await candidate(db,row.id,now);if(!item||item.status!=='scheduled')continue;
  if(item.gate){await db.prepare("UPDATE member_rank_notices SET status=?,processed_at=? WHERE id=? AND status='scheduled'").bind(item.gate,now.toISOString(),item.id).run();processed++;continue;}
  // 日本時間の夜間には送らない。期限を過ぎたものは上記の skipped_late で閉じる。
  const hour=(now.getUTCHours()+9)%24;if(hour<10||hour>=21||!item.line_user_id||(!Number.isFinite(Date.parse(item.scheduled_at))||Date.parse(item.scheduled_at)>now.getTime()))continue;
  let messages:Message[];try{messages=JSON.parse(item.messages) as Message[];if(!Array.isArray(messages)||messages.length===0)continue;}catch{continue;}
  // 送信直前に同意が変わって一度も送らなかった場合も、同じ通知として再照合できる。
  // 予約時に作った両方の本文を固定し、送信可能な本文は毎回別途確かめる。
  const to=item.line_user_id,payload=JSON.stringify({to,original:item.original_messages,base:item.base_messages});
  try{
   await sendRecordedNotification(db,{sourceId:`rank-notice:${item.id}`,channel:'line',recipient:item.friend_id,lineAccountId:item.account_id,payload,send:async retryKey=>{
    const latest=await candidate(db,item.id,new Date());
    if(!latest||latest.status!=='scheduled'||latest.gate||latest.line_user_id!==to||latest.messages!==item.messages||(!Number.isFinite(Date.parse(latest.scheduled_at))||Date.parse(latest.scheduled_at)>Date.now())||((new Date().getUTCHours()+9)%24)<10||((new Date().getUTCHours()+9)%24)>=21)throw new NotificationDeliveryBlocked('rank_notice_changed');
    await options.transmit({accountId:item.account_id,friendId:item.friend_id,noticeId:item.id,to,messages,retryKey});
   }});
   // 既存の通知行は test_mode=1 という制約があるため、送信の真実は共通台帳で保持する。
   // API は共通台帳を優先して sent / delivery_unknown を表示する。
   await db.prepare("UPDATE member_rank_notices SET status='simulated',processed_at=?,purpose=CASE WHEN ?=base_messages_json THEN 'notice' ELSE purpose END,messages_json=? WHERE id=? AND status='scheduled'").bind(now.toISOString(),item.messages,item.messages,item.id).run();processed++;
  }catch(error){if(!(error instanceof NotificationDeliveryIncomplete))throw error;}
 }
 return {processed};
}

/** 通常の停止・契約判定とプロキシを経由する。 */
export async function processStagingRankNotices(env:import('../worker-env.js').Env['Bindings'],now:Date){
 if(env.DEPLOY_ENV!=='staging'||env.RANK_NOTICE_STAGING_DELIVERY_ENABLED!=='true')throw new Error('rank_notice_delivery_disabled');
 const {activeTenantLineAccountSql,isOperationCapabilityStopped,resolveLineCredential}=await import('@line-crm/db');
 const {getSendPermissionForAccount}=await import('./send-entitlements.js');
 const {featureJobCanRun}=await import('./feature-enforcement.js');
 const {pushViaHarnessProxy}=await import('./line-proxy-send.js');
 const {dispatchLineProxyLocally}=await import('./local-line-proxy.js');
 return processLiveRankNotices(env.DB,now,{transmit:async input=>{
  if(!(await getSendPermissionForAccount(env.DB,input.accountId)).allowed||await isOperationCapabilityStopped(env.DB,input.accountId,'broadcast_dispatch')||!await featureJobCanRun(env.DB,{accountId:input.accountId,featureId:'mileage',job:'rank notices'}))throw new NotificationDeliveryBlocked('sending_stopped');
  const account=await env.DB.prepare(`SELECT channel_access_token,channel_access_token_encrypted FROM line_accounts la WHERE la.id=? AND la.is_active=1 AND la.archived_at IS NULL AND ${activeTenantLineAccountSql('la.id')}`).bind(input.accountId).first<{channel_access_token:string|null;channel_access_token_encrypted:string|null}>();
  if(!account)throw new NotificationDeliveryBlocked('account_unavailable');
  const token=await resolveLineCredential(account.channel_access_token_encrypted,account.channel_access_token,{lineAccountId:input.accountId,field:'channel_access_token'},env.LINE_CREDENTIAL_ENCRYPTION_KEY);
  if(!token)throw new NotificationDeliveryBlocked('account_unavailable');
  const fresh=await candidate(env.DB,input.noticeId,new Date());
  let freshMessages:unknown;try{freshMessages=JSON.parse(fresh?.messages??'');}catch{throw new NotificationDeliveryBlocked('rank_notice_changed');}
  if(!fresh||fresh.status!=='scheduled'||fresh.gate||fresh.line_user_id!==input.to||JSON.stringify(freshMessages)!==JSON.stringify(input.messages)||(!Number.isFinite(Date.parse(fresh.scheduled_at))||Date.parse(fresh.scheduled_at)>Date.now())||((new Date().getUTCHours()+9)%24)<10||((new Date().getUTCHours()+9)%24)>=21)throw new NotificationDeliveryBlocked('rank_notice_changed');
  await pushViaHarnessProxy(env.WORKER_PUBLIC_URL||env.WORKER_URL||'https://worker.invalid',token,input.to,input.messages,input.retryKey,request=>dispatchLineProxyLocally(request,env));
 }});
}
