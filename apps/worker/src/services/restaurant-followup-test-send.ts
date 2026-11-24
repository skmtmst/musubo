import { activeTenantLineAccountSql,getFriendById,getLineAccountById,isOperationCapabilityStopped,type ReminderDraftSettings,type ReminderStepRow } from '@line-crm/db';
import { LineClient,type Message } from '@line-crm/line-sdk';
import type { RestaurantFollowupTrigger } from '@line-crm/shared';
import { buildReminderStepMessage } from './reminder-delivery.js';
import { resolveReminderTestRecipient } from './reminder-draft.js';
import { readFollowupEngineDraftSnapshot,followupTestResource } from './restaurant-followup-engine-start.js';
import { sendRecordedNotification,NotificationDeliveryBlocked } from './recorded-notification-send.js';
import { createBroadcastRetryKey } from '../features/broadcasts/broadcast-retry-key/index.js';
import { completeOutboundSendStatement,hashOutboundPayload,reserveOutboundSend } from './outbound-idempotency.js';
import { getSendPermissionForAccount } from './send-entitlements.js';
import { featureJobCanRun } from './feature-enforcement.js';
import type { RestaurantBookingContext } from './restaurant-booking-context.js';

/** 任意の友だちは受け取らず、本人か登録済み宛先へ、保存した版の全内容を試す。 */
export async function testRestaurantFollowupEngine(db:D1Database,input:{storeId:string;trigger:RestaurantFollowupTrigger;expectedTargetVersion:number;staffId:string},dependencies?:{
 credentialEncryptionKey?:string;createClient?:(token:string)=>Pick<LineClient,'pushMessageWithRequestId'>;
}){
 if(!input.staffId)throw new Error('restaurant_followup_test_operator_required');
 const {target,targetId,snapshot}=await readFollowupEngineDraftSnapshot(db,input.storeId,input.trigger,input.expectedTargetVersion);
 const accountId=target.line_account_id;
 const recipient=await resolveReminderTestRecipient(db,accountId,{staffId:input.staffId});
 if(recipient.state!=='ready'||!recipient.recipient)throw new Error('REMINDER_TEST_RECIPIENT_NOT_AVAILABLE');
 const friend=await getFriendById(db,recipient.recipient.id);
 const store=await db.prepare('SELECT name,timezone FROM rt_stores WHERE id=? AND line_account_id=?').bind(input.storeId,accountId).first<{name:string;timezone:string}>();
 if(!friend||!store)throw new Error('REMINDER_TEST_RECIPIENT_NOT_AVAILABLE');
 const account=await getLineAccountById(db,accountId,dependencies?.credentialEncryptionKey);
 if(!account)throw new Error('REMINDER_LINE_ACCOUNT_NOT_FOUND');
 const client=dependencies?.createClient?.(account.channel_access_token)??new LineClient(account.channel_access_token);
 // 見本の予約と無効な返事を使い、実際の予約・招待・確認の状態は変えない。
 const sample:RestaurantBookingContext={reservation_id:'test',store_id:input.storeId,line_account_id:accountId,friend_id:friend.id,
  starts_at:'2030-04-01T18:00:00',ends_at:'2030-04-01T20:00:00',guest_count:2,status:'confirmed',departed_at:null,customer_version:0,
  line_uid:friend.line_user_id,timezone:store.timezone,store_name:store.name,course_name:'見本のコース'};
 const variables={restaurant_going:'test:restaurant_going',restaurant_change:'test:restaurant_change',restaurant_cancel:'test:restaurant_cancel',
  waitlist_book_url:'https://example.com/?test=reservation',waitlist_decline_url:'https://example.com/?test=decline'};
 const steps:ReminderStepRow[]=[];
 if(target.engine==='reminder'){
  const settings=JSON.parse((JSON.parse(snapshot.sourceContentJson) as {settings:string}).settings) as ReminderDraftSettings;
  for(const step of settings.steps)steps.push({id:step.stableStepId,reminder_id:targetId,offset_minutes:step.offsetMinutes,offset_days:step.offsetDays??null,send_at_time:step.sendAtTime??null,
   message_type:step.messageType,message_content:step.messageContent,template_id:step.templateId??null,message_parts_json:step.messageParts?JSON.stringify(step.messageParts):null,created_at:''});
 }else for(const action of snapshot.plan??[]){
  if(action.type==='wait')continue;
  if(action.type!=='send_message')throw new Error('restaurant_followup_test_message_actions_required');
  steps.push({id:action.id,reminder_id:targetId,offset_minutes:0,offset_days:null,send_at_time:null,template_id:typeof(action.params.templateId??action.params.template_id)==='string'?String(action.params.templateId??action.params.template_id):null,
   message_type:String(action.params.messageType??'text'),message_content:String(action.params.content??''),created_at:''});
 }
 const built=await Promise.all(steps.map(step=>buildReminderStepMessage(db,step,friend,new Date('2030-04-01T00:00:00Z'),'test_send',{
  previewOnly:true,restaurantContext:sample,restaurantVariables:variables,approvedTemplates:snapshot.templates})));
 const messages:Message[]=[{type:'text',text:'【テスト送信】予約日時・人数・リンクは見本です。お客さまには送っていません。'},...built.flatMap(item=>item.messages??[item.message])];
 if(messages.length<2)throw new Error('REMINDER_TEST_STEP_NOT_FOUND');
 const resource=followupTestResource(targetId,snapshot),chunkResources:string[]=[];
 for(let index=0;index<messages.length;index+=5){
  const chunk=messages.slice(index,index+5),chunkResource=`${resource}:${friend.id}:${index/5}`;
  chunkResources.push(chunkResource);
  await sendRecordedNotification(db,{sourceId:chunkResource,channel:'line',recipient:friend.id,lineAccountId:accountId,payload:JSON.stringify(chunk),send:async key=>{
   if(!(await getSendPermissionForAccount(db,accountId)).allowed||await isOperationCapabilityStopped(db,accountId,target.engine==='reminder'?'reminder_dispatch':'automation_actions')||!await featureJobCanRun(db,{accountId,featureId:'restaurant_test',job:'LINE来店フォローのテスト送信'}))throw new NotificationDeliveryBlocked('sending_stopped');
   const current=await resolveReminderTestRecipient(db,accountId,{staffId:input.staffId});
   if(current.state!=='ready'||current.recipient?.id!==friend.id||current.recipientKind!==recipient.recipientKind)throw new NotificationDeliveryBlocked('REMINDER_TEST_RECIPIENT_NOT_AVAILABLE');
   const ready=await db.prepare(`SELECT 1 FROM friends f JOIN line_accounts la ON la.id=f.line_account_id
    WHERE f.id=? AND f.line_account_id=? AND f.line_platform_user_id=? AND f.is_following=1 AND f.is_hidden=0 AND la.is_active=1 AND la.archived_at IS NULL
    AND ${activeTenantLineAccountSql('la.id')} AND (${snapshot.publicationGuard!.sql})
    AND EXISTS(SELECT 1 FROM rt_store_followup_targets WHERE store_id=? AND trigger=? AND version=? AND enabled=1)`)
    .bind(friend.id,accountId,friend.line_user_id,...snapshot.publicationGuard!.binds,input.storeId,input.trigger,input.expectedTargetVersion).first();
   if(!ready)throw new NotificationDeliveryBlocked('restaurant_followup_test_content_changed');
   return client.pushMessageWithRequestId(friend.line_user_id,chunk,key);
  }});
 }
 const now=new Date().toISOString(),proofKey=await createBroadcastRetryKey(resource,'complete',friend.id);
 const proof=await reserveOutboundSend(db,{key:proofKey,channel:'line',resourceId:resource,lineAccountId:accountId,payloadHash:await hashOutboundPayload(JSON.stringify(chunkResources)),retryInProgress:true,now});
 if(proof.kind!=='replay'&&proof.kind!=='acquired'&&proof.kind!=='retry')throw new Error('REMINDER_TEST_DELIVERY_UNCONFIRMED');
 if(proof.kind==='acquired'||proof.kind==='retry'){
  const allSucceeded="NOT EXISTS(SELECT 1 FROM json_each(?) chunk WHERE NOT EXISTS(SELECT 1 FROM outbound_send_requests request WHERE request.resource_id=chunk.value AND request.line_account_id=? AND request.status='succeeded'))";
  await db.batch([
   db.prepare(`SELECT json(CASE WHEN (${snapshot.publicationGuard!.sql}) AND ${allSucceeded} AND EXISTS(SELECT 1 FROM outbound_send_requests WHERE idempotency_key=? AND status='in_progress' AND lease_token=?) THEN '{}' ELSE 'FOLLOWUP_TEST_CHANGED' END)`)
    .bind(...snapshot.publicationGuard!.binds,JSON.stringify(chunkResources),accountId,proofKey,proof.leaseToken),
   ...built.flatMap(item=>(item.messageParts??[item]).map(part=>db.prepare(`INSERT INTO messages_log(id,friend_id,direction,message_type,content,delivery_type,source,line_account_id,created_at)
     VALUES(?,?,'outgoing',?,?,'test','restaurant_followup_test',?,?)`).bind(crypto.randomUUID(),friend.id,part.messageType,part.messageContent,accountId,now))),
   ...(target.engine==='reminder'?[db.prepare(`UPDATE reminder_versions SET last_test_status='succeeded',last_tested_at=?,last_tested_by_staff_id=? WHERE id=? AND status='draft'`).bind(now,input.staffId,snapshot.versionId)]:[]),
   completeOutboundSendStatement(db,{key:proofKey,responseId:proofKey,leaseToken:proof.leaseToken,now}),
  ]);
 }
 return {recipientName:recipient.recipient.displayName,recipientKind:recipient.recipientKind,contentHash:snapshot.contentHash,versionId:snapshot.versionId,sent:messages.length-1,replayed:proof.kind==='replay'};
}
