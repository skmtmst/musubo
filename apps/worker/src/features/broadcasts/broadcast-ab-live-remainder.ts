import type {Message} from '@line-crm/line-sdk';
import type {Env} from '../../worker-env.js';
import {GapError} from '../../services/gap-common.js';
import {broadcastQuietHoursShift} from '../../services/gap-send-preview.js';
import {sendRecordedNotification,NotificationDeliveryIncomplete} from '../../services/recorded-notification-send.js';
import {createBroadcastRetryKey} from './broadcast-retry-key.js';
import {resolveLiveVariantMessages,liveTestAudience} from './broadcast-ab-live.js';
import {createStagingAbTransmit} from './broadcast-ab-live-transport.js';
import {reserveAbLiveQuota} from './broadcast-ab-live-quota.js';
import {releaseQuotaSlot} from './broadcast-quota-guard.js';

/** 決められない結果からの選択を、版と状態を条件に一度だけ受け付ける。 */
export async function chooseAbLive(db:D1Database,id:string,accountId:string,staffId:string,key:string,variant:'A'|'B'|'none',count:number,now=new Date()){
 const current=await db.prepare("SELECT status,choice_key,choice_value,json_extract(stats_json,'$.choice_confirmed_count') choice_confirmed_count FROM broadcast_ab_live_tests WHERE broadcast_id=?").bind(id).first<{status:string;choice_key:string|null;choice_value:string|null;choice_confirmed_count:number|null}>();
 if(!current)throw new GapError('not_found',404);
 if(current.choice_key===key){if(current.choice_value!==variant||current.choice_confirmed_count!==count)throw new GapError('idempotency_conflict',409);return {variant,replayed:true};}
 const remaining=await db.prepare("SELECT COUNT(*) n FROM broadcast_ab_live_recipients WHERE broadcast_id=? AND variant_key='R' AND state='pending'").bind(id).first<{n:number}>();
 if(!Number.isSafeInteger(count)||count!==remaining?.n)throw new GapError('SEND_PREVIEW_CHANGED',409);
 const at=now.toISOString(),scheduled=variant==='none'?null:(await broadcastQuietHoursShift(db,accountId,at)??at);
 const update=await db.prepare(`UPDATE broadcast_ab_live_tests SET status=?,winner=?,choice_key=?,choice_value=?,decided_by=?,remainder_scheduled_at=?,stats_json=json_set(COALESCE(stats_json,'{}'),'$.choice_confirmed_count',?),version=version+1
  WHERE broadcast_id=? AND status='live_undecided' AND julianday(decided_at,'+1 day')>julianday(?)
   AND EXISTS(SELECT 1 FROM broadcasts WHERE id=? AND stopped_at IS NULL)
   AND (SELECT COUNT(*) FROM broadcast_ab_live_recipients WHERE broadcast_id=? AND variant_key='R' AND state='pending')=?`)
  .bind(variant==='none'?'live_finished':'live_decided',variant==='none'?null:variant,key,variant,staffId,scheduled,count,id,at,id,id,count).run();
 if(update.meta.changes!==1)throw new GapError('already_chosen',409);
 return {variant,scheduledAt:scheduled,replayed:false};
}

/** 1回だけ送信処理を確保し、途中不明を自動で送り直さない。 */
export async function processAbLiveRemainders(env:Env['Bindings'],now=new Date()){
 if(env.DEPLOY_ENV!=='staging'||env.AB_LIVE_DELIVERY_ENABLED!=='true')return;
 const db=env.DB,at=now.toISOString();
 await db.prepare(`UPDATE broadcast_ab_live_tests SET status='live_stopped',stats_json=json_set(COALESCE(stats_json,'{}'),'$.remainderError','interrupted'),version=version+1
  WHERE status='live_decided' AND remainder_started_at IS NOT NULL AND julianday(remainder_started_at)<=julianday(?,'-15 minutes')`).bind(at).run();
 const rows=(await db.prepare(`SELECT t.broadcast_id,t.winner,t.remainder_scheduled_at,b.line_account_id
  FROM broadcast_ab_live_tests t JOIN broadcasts b ON b.id=t.broadcast_id
  WHERE t.status='live_decided' AND t.remainder_started_at IS NULL AND b.stopped_at IS NULL AND julianday(t.remainder_scheduled_at)<=julianday(?)
  ORDER BY t.remainder_scheduled_at,t.broadcast_id LIMIT 20`).bind(at).all<{broadcast_id:string;winner:'A'|'B';remainder_scheduled_at:string;line_account_id:string}>()).results;
 for(const row of rows){
  const id=row.broadcast_id,claimed=await db.prepare("UPDATE broadcast_ab_live_tests SET remainder_started_at=?,version=version+1 WHERE broadcast_id=? AND status='live_decided' AND remainder_started_at IS NULL AND EXISTS(SELECT 1 FROM broadcasts WHERE id=? AND stopped_at IS NULL)").bind(at,id,id).run();
  if(claimed.meta.changes!==1)continue;
  try{
   if(now.getTime()-Date.parse(row.remainder_scheduled_at)>=12*3600000)throw new GapError('ab_remainder_overdue',409);
   if(await broadcastQuietHoursShift(db,row.line_account_id,at))throw new GapError('ab_quiet_hours',409);
   const pendingCount=await db.prepare("SELECT COUNT(*) n FROM broadcast_ab_live_recipients WHERE broadcast_id=? AND variant_key='R' AND state='pending'").bind(id).first<{n:number}>();
   await reserveAbLiveQuota(env,`ab-remainder:${id}`,row.line_account_id,pendingCount?.n??0);
   const content=await db.prepare('SELECT messages_json FROM broadcast_variants WHERE broadcast_id=? AND variant_key=?').bind(id,row.winner).first<{messages_json:string}>();
   if(!content)throw new GapError('two_variants_required',409);
   const messages=await resolveLiveVariantMessages(db,row.line_account_id,id,JSON.parse(content.messages_json) as Message[],now);
   const targets=(await db.prepare("SELECT r.friend_id,f.line_user_id FROM broadcast_ab_live_recipients r LEFT JOIN friends f ON f.id=r.friend_id AND f.line_account_id=? WHERE r.broadcast_id=? AND r.variant_key='R' AND r.state='pending' ORDER BY r.friend_id").bind(row.line_account_id,id).all<{friend_id:string;line_user_id:string|null}>()).results;
   const transmit=createStagingAbTransmit(env,id,row.line_account_id);
   for(const target of targets){
    const active=await db.prepare("SELECT 1 FROM broadcast_ab_live_tests t JOIN broadcasts b ON b.id=t.broadcast_id WHERE t.broadcast_id=? AND t.status='live_decided' AND t.remainder_started_at=? AND b.stopped_at IS NULL").bind(id,at).first();
    if(!active)throw new GapError('ab_delivery_stopped',409);
    const current=await liveTestAudience(db,id);
    if(!target.line_user_id||!current.ids.includes(target.friend_id)){
     await db.prepare("UPDATE broadcast_ab_live_recipients SET state='failed' WHERE broadcast_id=? AND friend_id=? AND variant_key='R' AND state='pending'").bind(id,target.friend_id).run();
     continue;
    }
    const reserved=await db.prepare("UPDATE broadcast_ab_live_recipients SET state='unknown',attempt_count=attempt_count+1 WHERE broadcast_id=? AND friend_id=? AND variant_key='R' AND state='pending'").bind(id,target.friend_id).run();
    if(reserved.meta.changes!==1)throw new GapError('ab_delivery_already_claimed',409);
    const source=`ab-live:${id}:${target.friend_id}`;
    try{await sendRecordedNotification(db,{sourceId:source,channel:'line',recipient:target.friend_id,lineAccountId:row.line_account_id,payload:JSON.stringify(messages),send:retryKey=>transmit({broadcastId:id,variantKey:row.winner,friendId:target.friend_id,to:[target.line_user_id!],messages,retryKey})});}
    catch(error){
     const retryKey=await createBroadcastRetryKey('notification',source,'line',target.friend_id);
     if(error instanceof NotificationDeliveryIncomplete&&error.blockedReason==='recipient_changed'){
      await db.batch([db.prepare("UPDATE outbound_send_requests SET retryable=0,next_retry_at=NULL WHERE idempotency_key=? AND status='failed'").bind(retryKey),db.prepare("UPDATE broadcast_ab_live_recipients SET state='failed' WHERE broadcast_id=? AND friend_id=? AND variant_key='R' AND state='unknown'").bind(id,target.friend_id)]);
      continue;
     }
     await db.prepare("UPDATE outbound_send_requests SET status='unknown',retryable=0,next_retry_at=NULL WHERE idempotency_key=? AND status='failed'").bind(retryKey).run();throw new GapError('ab_delivery_unknown',409);
    }
    await db.prepare("UPDATE broadcast_ab_live_recipients SET state='sent',sent_at=? WHERE broadcast_id=? AND friend_id=? AND variant_key='R' AND state='unknown'").bind(new Date().toISOString(),id,target.friend_id).run();
   }
   const remaining=await db.prepare("SELECT COUNT(*) n FROM broadcast_ab_live_recipients WHERE broadcast_id=? AND variant_key='R' AND state IN ('pending','unknown')").bind(id).first<{n:number}>();
   if(remaining?.n)throw new GapError('ab_remainder_incomplete',409);
   await db.prepare("UPDATE broadcast_ab_live_tests SET status='live_finished',remainder_sent_at=?,version=version+1 WHERE broadcast_id=? AND status='live_decided' AND remainder_started_at=?").bind(new Date().toISOString(),id,at).run();
   await releaseQuotaSlot(db,row.line_account_id,`ab-remainder:${id}`);
  }catch(error){
   const reason=error instanceof GapError?error.code:'ab_delivery_unknown';
   await db.batch([
    db.prepare("UPDATE broadcast_ab_live_tests SET status='live_stopped',stats_json=json_set(COALESCE(stats_json,'{}'),'$.remainderError',?),version=version+1 WHERE broadcast_id=? AND status='live_decided' AND remainder_started_at=?").bind(reason,id,at),
    db.prepare("INSERT INTO notifications(id,event_type,title,body,channel,status,line_account_id,category) SELECT ?,'broadcast_ab_remainder_stopped','A/Bの残りを送れませんでした',?,'dashboard','sent',?,'error' WHERE changes()=1").bind(crypto.randomUUID(),reason==='ab_quota_exceeded'?'送信枠が足りないため残りを送れませんでした。':reason==='ab_quota_unknown'?'送信枠を確認できなかったため残りを送れませんでした。':'残りの送信を停止しました。内容を確認してください。',row.line_account_id),
   ]);
  }
 }
}
