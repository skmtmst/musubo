import {getStaffById} from '@line-crm/db';
import type {Env} from '../worker-env.js';
import {toAuthenticatedStaff} from '../middleware/auth/principal/auth.js';
import {canAccessAllLineAccounts} from './account-access.js';
import {pushIsQuiet,type PushSender} from './operator-push.js';
import {sendWebPush} from './web-push.js';
import {canAssignChatTo} from './chat-assignees.js';

type PushEnv=Partial<Env['Bindings']>;
type Candidate={notificationId:string;accountId:string;metadata:string;staffId:string;subscriptionId:string;endpoint:string;p256dh:string;auth:string;chatId:string;assigned:string|null;stage:number;deliveryId:string|null};
function testRecipients(env:PushEnv):string[]{
 if(env.DEPLOY_ENV!=='staging'||env.INBOX_SLA_PUSH_ENABLED!=='true')return [];
 try{const value:unknown=JSON.parse(env.INBOX_SLA_PUSH_TEST_STAFF_IDS??'[]');return Array.isArray(value)?value.filter((x):x is string=>typeof x==='string'&&x.length>0).slice(0,20):[];}catch{return [];}
}
/** 実送信は明示された検証環境と担当者だけ。送達不明の再送は行わない。 */
export async function processInboxSlaPush(db:D1Database,env:PushEnv,now=new Date(),send?:PushSender){
 const allow=testRecipients(env);if(!allow.length)return;
 const rows=(await db.prepare(`SELECT n.id notificationId,n.line_account_id accountId,n.metadata,s.staff_id staffId,s.id subscriptionId,s.endpoint,s.p256dh,s.auth,c.id chatId,c.assignee_staff_id assigned,CAST(json_extract(CASE WHEN json_valid(n.metadata) THEN n.metadata ELSE '{}' END,'$.stage') AS INTEGER) stage,d.id deliveryId
  FROM notifications n JOIN friends f ON f.id=json_extract(CASE WHEN json_valid(n.metadata) THEN n.metadata ELSE '{}' END,'$.chatId') AND f.line_account_id=n.line_account_id
  JOIN chats c ON c.friend_id=f.id JOIN operator_push_subscriptions s ON s.staff_id IN(SELECT value FROM json_each(?)) AND s.revoked_at IS NULL
  LEFT JOIN operator_push_deliveries d ON d.subscription_id=s.id AND d.kind='inbox_sla' AND d.ref_id=n.id
  WHERE n.event_type='inbox_sla' AND n.channel='dashboard' AND n.status='sent' AND json_valid(n.metadata) AND n.line_account_id IS NOT NULL
   AND CAST(json_extract(CASE WHEN json_valid(n.metadata) THEN n.metadata ELSE '{}' END,'$.stage') AS INTEGER) IN (1,2,3)
   AND c.first_response_at IS NULL AND c.status!='resolved' AND c.sla_notified_stage=CAST(json_extract(CASE WHEN json_valid(n.metadata) THEN n.metadata ELSE '{}' END,'$.stage') AS INTEGER)
   AND julianday(c.sla_due_at)>=julianday(?,'-1 day')
   AND n.id='sla:'||c.id||':'||c.pending_since||':'||CAST(json_extract(CASE WHEN json_valid(n.metadata) THEN n.metadata ELSE '{}' END,'$.stage') AS INTEGER)
   AND (d.id IS NULL OR (d.status='failed' AND d.attempts<4 AND d.next_attempt_at IS NOT NULL AND julianday(d.next_attempt_at)<=julianday(?)))
  ORDER BY n.created_at,n.id,s.id LIMIT 20`).bind(JSON.stringify(allow),now.toISOString(),now.toISOString()).all<Candidate>()).results;
 for(const row of rows){
  if(!testRecipients(env).includes(row.staffId))continue;
  const proposedId=row.deliveryId??crypto.randomUUID(),claim=await db.prepare(`INSERT INTO operator_push_deliveries(id,subscription_id,kind,ref_id,line_account_id,status,created_at) VALUES(?,?,'inbox_sla',?,?,'pending',?) ON CONFLICT(subscription_id,kind,ref_id) DO UPDATE SET status='pending',next_attempt_at=NULL WHERE operator_push_deliveries.status='failed' AND operator_push_deliveries.attempts<4 AND operator_push_deliveries.next_attempt_at IS NOT NULL AND julianday(operator_push_deliveries.next_attempt_at)<=julianday(?) RETURNING id`).bind(proposedId,row.subscriptionId,row.notificationId,row.accountId,now.toISOString(),now.toISOString()).first<{id:string}>();if(!claim)continue;
  const id=claim.id;
  const skip=async(code:string)=>{await db.prepare("UPDATE operator_push_deliveries SET status='failed',error_code=? WHERE id=? AND status='pending'").bind(code,id).run();};
  const staff=await getStaffById(db,row.staffId);if(!staff||!staff.is_active||staff.invite_status!=='active'||staff.tenant_status!=='active'){await skip('push_no_longer_authorized');continue;}
  const principal=toAuthenticatedStaff(staff);
  if(!(['owner','admin'].includes(principal.role)||principal.permissionKeys?.includes('/chats')||principal.viewPermissionKeys?.includes('/chats'))||!await canAccessAllLineAccounts(db,principal,[row.accountId])){await skip('push_no_longer_authorized');continue;}
  let meta:{staffId?:unknown;teamId?:unknown};try{meta=JSON.parse(row.metadata);}catch{await skip('push_invalid_notice');continue;}
  const team=typeof meta.teamId==='string'&&await db.prepare(`SELECT 1 FROM operator_notification_teams t,json_each(t.staff_ids) m WHERE t.id=? AND t.line_account_id=? AND t.archived_at IS NULL AND m.value=?`).bind(meta.teamId,row.accountId,row.staffId).first();
  const manager=['owner','admin'].includes(principal.role)||!!team;
  if(row.stage!==3&&row.assigned){if(row.assigned!==row.staffId||meta.staffId!==row.staffId||!await canAssignChatTo(db,row.staffId,row.accountId)){await skip('push_no_longer_authorized');continue;}}else if(!manager){await skip('push_no_longer_authorized');continue;}
  const preference=await db.prepare('SELECT kinds_json,quiet_start,quiet_end FROM operator_push_preferences WHERE staff_id=?').bind(row.staffId).first<{kinds_json:string;quiet_start:string;quiet_end:string}>();
  if(preference){try{if(!(JSON.parse(preference.kinds_json) as string[]).includes('assigned_reply')){await skip('push_preference');continue;}}catch{await skip('push_preference');continue;}}
  if(pushIsQuiet(preference?.quiet_start??'22:00',preference?.quiet_end??'08:00',now)){await db.prepare("UPDATE operator_push_deliveries SET status='failed',error_code='push_quiet' WHERE id=? AND status='pending'").bind(id).run();continue;}
  // 遅延中に担当が変わっていたら通知せず、画面内のお知らせを残す。
  const current=await db.prepare(`SELECT 1 FROM chats c JOIN friends f ON f.id=c.friend_id WHERE c.id=? AND f.line_account_id=? AND c.first_response_at IS NULL AND c.status!='resolved' AND c.sla_notified_stage=? AND (c.assignee_staff_id IS ?) AND julianday(c.sla_due_at)>=julianday(?,'-1 day') AND ?='sla:'||c.id||':'||c.pending_since||':'||CAST(? AS INTEGER) AND EXISTS(SELECT 1 FROM notifications n WHERE n.id=? AND n.line_account_id=? AND n.event_type='inbox_sla' AND n.channel='dashboard' AND n.status='sent' AND n.metadata=?)`)
   .bind(row.chatId,row.accountId,row.stage,row.assigned,now.toISOString(),row.notificationId,row.stage,row.notificationId,row.accountId,row.metadata).first();
  const fresh=await getStaffById(db,row.staffId),freshAuth=fresh?toAuthenticatedStaff(fresh):null;
  const activeSubscription=await db.prepare('SELECT 1 FROM operator_push_subscriptions WHERE id=? AND staff_id=? AND revoked_at IS NULL').bind(row.subscriptionId,row.staffId).first();
  const freshPreference=await db.prepare('SELECT kinds_json,quiet_start,quiet_end FROM operator_push_preferences WHERE staff_id=?').bind(row.staffId).first<{kinds_json:string;quiet_start:string;quiet_end:string}>();
  let freshPreferenceAllows=true;try{if(freshPreference)freshPreferenceAllows=(JSON.parse(freshPreference.kinds_json) as string[]).includes('assigned_reply');}catch{freshPreferenceAllows=false;}
  if(!freshPreferenceAllows){await skip('push_preference');continue;}
  if(pushIsQuiet(freshPreference?.quiet_start??'22:00',freshPreference?.quiet_end??'08:00',now)){await skip('push_quiet');continue;}
  const freshTeam=typeof meta.teamId==='string'&&await db.prepare(`SELECT 1 FROM operator_notification_teams t,json_each(t.staff_ids) m WHERE t.id=? AND t.line_account_id=? AND t.archived_at IS NULL AND m.value=?`).bind(meta.teamId,row.accountId,row.staffId).first();
  const freshRecipient=row.stage!==3&&row.assigned ? row.assigned===row.staffId&&meta.staffId===row.staffId&&await canAssignChatTo(db,row.staffId,row.accountId) : !!freshAuth&&(['owner','admin'].includes(freshAuth.role)||!!freshTeam);
  if(!current||!activeSubscription||!fresh||!fresh.is_active||fresh.invite_status!=='active'||fresh.tenant_status!=='active'||!freshAuth||!(['owner','admin'].includes(freshAuth.role)||freshAuth.permissionKeys?.includes('/chats')||freshAuth.viewPermissionKeys?.includes('/chats'))||!await canAccessAllLineAccounts(db,freshAuth,[row.accountId])||!freshRecipient||!testRecipients(env).includes(row.staffId)){await db.prepare("UPDATE operator_push_deliveries SET status='failed',error_code='push_no_longer_authorized' WHERE id=? AND status='pending'").bind(id).run();continue;}
  const payload={title:row.stage===1?'返事の期限が近づいています':'返事の期限を過ぎています',body:'受信箱で確認してください',url:'/chats'};
  try{
   if(!send&&(!env.OPERATOR_PUSH_VAPID_PUBLIC_KEY||!env.OPERATOR_PUSH_VAPID_PRIVATE_KEY||!env.OPERATOR_PUSH_VAPID_SUBJECT))throw new Error('not_configured');
   const result=send?await send(row,payload):await sendWebPush({endpoint:row.endpoint,p256dh:row.p256dh,auth:row.auth,payload,publicKey:env.OPERATOR_PUSH_VAPID_PUBLIC_KEY!,privateKey:env.OPERATOR_PUSH_VAPID_PRIVATE_KEY!,subject:env.OPERATOR_PUSH_VAPID_SUBJECT!});
   const gone=result.status===404||result.status===410;
   await db.batch([db.prepare("UPDATE operator_push_deliveries SET status=?,error_code=?,attempts=attempts+1,next_attempt_at=CASE WHEN ? AND attempts+1<4 THEN datetime(?,CASE attempts WHEN 0 THEN '+1 minute' WHEN 1 THEN '+5 minutes' ELSE '+30 minutes' END) ELSE NULL END WHERE id=? AND status='pending'").bind(gone?'gone':result.ok?'sent':'failed',result.ok?null:`push_http_${result.status}`,!result.ok&&(result.status===429||result.status>=500)?1:0,now.toISOString(),id),db.prepare('UPDATE operator_push_subscriptions SET last_success_at=CASE WHEN ? THEN ? ELSE last_success_at END,last_error_code=?,revoked_at=CASE WHEN ? THEN ? ELSE revoked_at END WHERE id=?').bind(result.ok?1:0,now.toISOString(),result.ok?null:`push_http_${result.status}`,gone?1:0,now.toISOString(),row.subscriptionId)]);
  }catch{await db.prepare("UPDATE operator_push_deliveries SET status='failed',error_code='push_unavailable',attempts=attempts+1 WHERE id=? AND status='pending'").bind(id).run();}
 }
}
