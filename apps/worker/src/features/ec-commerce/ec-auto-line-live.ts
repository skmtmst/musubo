import type { Message } from '@line-crm/line-sdk';
import { tzHHMM, tzDateStr, getAccountTimeZone } from '../../services/availability.js';
import { restaurantCivilTime } from '../../services/restaurant-booking.js';
import { isStagingTestRecipient } from '../../services/staging-test-recipient.js';
import { NotificationDeliveryBlocked } from '../../services/recorded-notification-send.js';
import { prepareAutoLineLiveCap } from './ec-auto-line-live-cap.js';
import { reconcileLiveIntent, sendLiveIntent, type LiveIntent } from './ec-auto-line-live-ledger.js';

type Row={id:string;account_id:string;kind:LiveIntent['kind'];occurrence_key:string;friend_id:string;product_id:string;due_at:string;payload_json:string;line_user_id:string};
type Transmit=(input:{intentId:string;accountId:string;friendId:string;to:string;messages:Message[];retryKey:string})=>Promise<void>;

/** All eligibility is checked again after the claim and immediately before the request. */
async function eligible(db:D1Database,id:string,now:Date):Promise<Row|null>{
 const row=await db.prepare(`SELECT i.*,f.line_user_id FROM ec_auto_line_live_intents i
 JOIN friends f ON f.id=i.friend_id AND f.line_account_id=i.account_id AND f.is_following=1 AND f.is_hidden=0 AND length(trim(f.line_user_id))>0
 JOIN ec_behavior_events e ON e.id=i.occurrence_key AND e.account_id=i.account_id AND e.product_id=i.product_id
 JOIN line_accounts a ON a.id=i.account_id AND a.is_active=1 AND a.archived_at IS NULL
 JOIN tenants t ON t.id=a.tenant_id AND t.status='active'
 JOIN ec_connectors c ON c.line_account_id=i.account_id AND c.status='connected'
 JOIN ec_auto_line_rules r ON r.account_id=i.account_id AND r.kind=i.kind AND r.enabled=1
 WHERE i.id=? AND i.state IN ('scheduled','sending')
 AND julianday(COALESCE(i.original_due_at,i.due_at))<=julianday(?,'-10 minutes') AND julianday(i.due_at)>julianday(?,'-3 hours') AND (i.kind!='cart' OR julianday(COALESCE(i.original_due_at,i.due_at))>=julianday(?,'-12 hours'))
 AND EXISTS(SELECT 1 FROM friend_delivery_consents d WHERE d.line_account_id=i.account_id AND d.friend_id=i.friend_id AND d.purpose IN('promotion','marketing','advertising','宣伝') AND d.state='granted')
 AND NOT EXISTS(SELECT 1 FROM friend_delivery_consents d WHERE d.line_account_id=i.account_id AND d.friend_id=i.friend_id AND d.purpose IN('promotion','marketing','advertising','宣伝') AND d.state!='granted')
 AND NOT EXISTS(SELECT 1 FROM ec_behavior_events p WHERE p.account_id=i.account_id AND p.friend_id=i.friend_id AND p.type='purchase' AND julianday(p.occurred_at)>=julianday(e.occurred_at))
 AND NOT EXISTS(SELECT 1 FROM ec_orders o WHERE o.line_account_id=i.account_id AND o.friend_id=i.friend_id AND o.normalized_status='current' AND julianday(o.ordered_at)>=julianday(e.occurred_at))
 AND (i.kind!='cart' OR i.occurrence_key=(SELECT b.id FROM ec_behavior_events b WHERE b.account_id=i.account_id AND b.friend_id=i.friend_id AND b.product_id=i.product_id AND b.type IN('cart_add','cart_remove') ORDER BY julianday(b.occurred_at) DESC,b.received_at DESC,b.id DESC LIMIT 1))
 AND (i.kind!='browse' OR NOT EXISTS(SELECT 1 FROM ec_behavior_events b WHERE b.account_id=i.account_id AND b.friend_id=i.friend_id AND b.product_id=i.product_id AND b.type='cart_add' AND julianday(b.occurred_at)>=julianday(e.occurred_at)))
 AND (i.kind!='restock' OR COALESCE((SELECT json_extract(b.product_snapshot_json,'$.stock') FROM ec_behavior_events b WHERE b.account_id=i.account_id AND b.product_id=i.product_id AND b.type='restock' ORDER BY julianday(b.occurred_at) DESC,b.id DESC LIMIT 1),0)>0)
 LIMIT 1`).bind(id,now.toISOString(),now.toISOString(),now.toISOString()).first<Row>();
 if(!row)return null;
 const hour=tzHHMM(await getAccountTimeZone(db,row.account_id),now);
 if(hour<'08:00'||hour>='21:00')return null;
 return await isStagingTestRecipient(db,row.account_id,row.friend_id,row.line_user_id)?row:null;
}

export async function processLiveAutoLine(db:D1Database,now:Date,transmit:Transmit):Promise<{processed:number}>{
 // Recover only confirmed accepts; uncertain and interrupted claims remain held.
 await db.prepare("UPDATE ec_auto_line_cap_reservations SET state='accepted' WHERE mode='live' AND state IN('reserved','started','unknown') AND live_intent_id IN (SELECT id FROM ec_auto_line_live_intents WHERE state='sent')").run();
 await db.prepare(`UPDATE ec_auto_line_cap_reservations SET state='released',release_actor='system',release_reason='unclaimed_reservation_expired',released_at=?
  WHERE id IN (SELECT c.id FROM ec_auto_line_cap_reservations c JOIN ec_auto_line_live_intents i ON i.id=c.live_intent_id
   WHERE c.mode='live' AND c.state='reserved' AND julianday(c.reserved_at)<=julianday(?,'-5 minutes') AND i.state IN('scheduled','failed')
   AND NOT EXISTS(SELECT 1 FROM outbound_send_requests o WHERE o.resource_id='ec-live:'||i.id) LIMIT 100) AND state='reserved'`).bind(now.toISOString(),now.toISOString()).run();
 const pending=(await db.prepare("SELECT i.id FROM ec_auto_line_live_intents i WHERE i.state='sending' AND EXISTS(SELECT 1 FROM outbound_send_requests o WHERE o.resource_id='ec-live:'||i.id AND o.status='succeeded') ORDER BY i.updated_at LIMIT 100").all<{id:string}>()).results;
 for(const item of pending)if(await reconcileLiveIntent(db,item.id,now))await db.prepare("UPDATE ec_auto_line_cap_reservations SET state='accepted' WHERE mode='live' AND live_intent_id=? AND state IN('reserved','started','unknown')").bind(item.id).run();
 await db.prepare("UPDATE ec_auto_line_live_intents SET state='failed',updated_at=? WHERE id IN (SELECT id FROM ec_auto_line_live_intents WHERE state='scheduled' AND julianday(due_at)<=julianday(?,'-3 hours') ORDER BY due_at,id LIMIT 100) AND state='scheduled'").bind(now.toISOString(),now.toISOString()).run();
 const rows=(await db.prepare(`SELECT i.id FROM ec_auto_line_live_intents i
 WHERE i.state='scheduled' AND julianday(i.due_at)<=julianday(?,'-10 minutes')
 AND EXISTS(SELECT 1 FROM account_settings s JOIN json_each(CASE WHEN json_valid(s.value) THEN CASE WHEN json_type(s.value)='array' THEN s.value ELSE '[]' END ELSE '[]' END) recipient
 WHERE s.line_account_id=i.account_id AND s.key='test_recipients' AND recipient.type='text' AND recipient.value=i.friend_id
 AND NOT EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(s.value) THEN CASE WHEN json_type(s.value)='array' THEN s.value ELSE '[]' END ELSE '[]' END) invalid WHERE invalid.type!='text' OR length(trim(invalid.value))=0))
 ORDER BY i.due_at,i.id LIMIT 100`).bind(now.toISOString()).all<{id:string}>()).results;
 let processed=0;
 for(const item of rows){
  const timing=await db.prepare("SELECT account_id,due_at FROM ec_auto_line_live_intents WHERE id=? AND state='scheduled'").bind(item.id).first<{account_id:string;due_at:string}>();
  if(!timing)continue;
  const tz=await getAccountTimeZone(db,timing.account_id),hour=tzHHMM(tz,now);
  if(hour<'08:00'||hour>='21:00'){
   const day=tzDateStr(tz,now),nextDay=hour<'08:00'?day:tzDateStr('UTC',new Date(Date.parse(day+'T00:00:00Z')+86400000));
   await db.prepare("UPDATE ec_auto_line_live_intents SET due_at=?,updated_at=? WHERE id=? AND state='scheduled' AND due_at=?").bind(restaurantCivilTime(nextDay,480,tz),now.toISOString(),item.id,timing.due_at).run();
   continue;
  }
  const row=await eligible(db,item.id,now);if(!row)continue;
  let messages:Message[];try{messages=JSON.parse(row.payload_json) as Message[];if(!Array.isArray(messages)||!messages.length)continue;}catch{continue;}
  const reservation=crypto.randomUUID();
  if((await prepareAutoLineLiveCap(db,row.account_id,row.id,now,reservation).run()).meta.changes!==1)continue;
  const intent:LiveIntent={id:row.id,accountId:row.account_id,kind:row.kind,occurrenceKey:row.occurrence_key,friendId:row.friend_id,productId:row.product_id,dueAt:row.due_at,payload:row.payload_json};
  let state:Awaited<ReturnType<typeof sendLiveIntent>>;
  try{state=await sendLiveIntent(db,intent,async retryKey=>{
   const fresh=await eligible(db,row.id,new Date());
   if(!fresh||fresh.line_user_id!==row.line_user_id||fresh.payload_json!==row.payload_json)throw new NotificationDeliveryBlocked('ec_delivery_changed');
   const started=await db.prepare("UPDATE ec_auto_line_cap_reservations SET state='started' WHERE id=? AND mode='live' AND state='reserved' AND live_intent_id=?").bind(reservation,row.id).run();
   if(started.meta.changes!==1)throw new NotificationDeliveryBlocked('ec_cap_changed');
   const last=await eligible(db,row.id,new Date());
   if(!last||last.line_user_id!==row.line_user_id||last.payload_json!==row.payload_json)throw new NotificationDeliveryBlocked('ec_delivery_changed');
   await transmit({intentId:row.id,accountId:row.account_id,friendId:row.friend_id,to:row.line_user_id,messages,retryKey});
  },now);}catch{console.error('ec_live_intent_completion_failed');continue;}
  if(state==='unclaimed')await db.prepare("UPDATE ec_auto_line_cap_reservations SET state='released',release_actor='system',release_reason='intent_not_claimed',released_at=? WHERE id=? AND state='reserved' AND EXISTS(SELECT 1 FROM ec_auto_line_live_intents WHERE id=? AND state IN('scheduled','failed')) AND NOT EXISTS(SELECT 1 FROM outbound_send_requests WHERE resource_id=?)").bind(now.toISOString(),reservation,row.id,`ec-live:${row.id}`).run();
  if(state==='sent')await db.prepare("UPDATE ec_auto_line_cap_reservations SET state='accepted' WHERE id=? AND state='started'").bind(reservation).run();
  else if(state==='unknown')await db.prepare("UPDATE ec_auto_line_cap_reservations SET state='unknown' WHERE id=? AND state IN('reserved','started')").bind(reservation).run();
  else if(state==='failed')await db.prepare(`UPDATE ec_auto_line_cap_reservations SET state='released',release_actor='system',release_reason='delivery_failed_before_acceptance',released_at=?
   WHERE id=? AND state IN('reserved','started') AND EXISTS(SELECT 1 FROM outbound_send_requests WHERE resource_id=? AND status='failed' AND failure_code IN ('NOTIFICATION_PRECONDITION_CHANGED','LINE_RATE_LIMITED','LINE_REQUEST_REJECTED'))`)
   .bind(now.toISOString(),reservation,`ec-live:${row.id}`).run();
  if(state!=='unclaimed')processed++;
 }
 return {processed};
}

export async function processStagingAutoLine(env:import('../../worker-env.js').Env['Bindings'],now:Date){
 if(env.DEPLOY_ENV!=='staging'||env.EC_AUTO_LINE_LIVE_SEND_ENABLED!=='true')return {processed:0};
 const {activeTenantLineAccountSql,isOperationCapabilityStopped,resolveLineCredential}=await import('@line-crm/db');
 const {getSendPermissionForAccount}=await import('../../services/send-entitlements.js');
 const {featureJobCanRun}=await import('../../services/feature-enforcement.js');
 const {pushViaHarnessProxy}=await import('../../services/line-proxy-send.js');
 const {dispatchLineProxyLocally}=await import('../../services/local-line-proxy.js');
 return processLiveAutoLine(env.DB,now,async input=>{
  if(!(await getSendPermissionForAccount(env.DB,input.accountId)).allowed||await isOperationCapabilityStopped(env.DB,input.accountId,'broadcast_dispatch')||!await featureJobCanRun(env.DB,{accountId:input.accountId,featureId:'ec_commerce',job:'EC auto line'}))throw new NotificationDeliveryBlocked('sending_stopped');
  const account=await env.DB.prepare(`SELECT channel_access_token,channel_access_token_encrypted FROM line_accounts la WHERE la.id=? AND la.is_active=1 AND la.archived_at IS NULL AND ${activeTenantLineAccountSql('la.id')}`).bind(input.accountId).first<{channel_access_token:string|null;channel_access_token_encrypted:string|null}>();
  if(!account)throw new NotificationDeliveryBlocked('account_unavailable');
  const token=await resolveLineCredential(account.channel_access_token_encrypted,account.channel_access_token,{lineAccountId:input.accountId,field:'channel_access_token'},env.LINE_CREDENTIAL_ENCRYPTION_KEY);
  if(!(await getSendPermissionForAccount(env.DB,input.accountId)).allowed||await isOperationCapabilityStopped(env.DB,input.accountId,'broadcast_dispatch')||!await featureJobCanRun(env.DB,{accountId:input.accountId,featureId:'ec_commerce',job:'EC auto line'}))throw new NotificationDeliveryBlocked('sending_stopped');
  const latest=await eligible(env.DB,input.intentId,new Date());
  if(!token||!latest||latest.account_id!==input.accountId||latest.friend_id!==input.friendId||latest.line_user_id!==input.to||JSON.stringify(JSON.parse(latest.payload_json))!==JSON.stringify(input.messages))throw new NotificationDeliveryBlocked('ec_recipient_changed');
  await pushViaHarnessProxy(env.WORKER_PUBLIC_URL||env.WORKER_URL||'https://worker.invalid',token,input.to,input.messages,input.retryKey,request=>dispatchLineProxyLocally(request,env));
 });
}
