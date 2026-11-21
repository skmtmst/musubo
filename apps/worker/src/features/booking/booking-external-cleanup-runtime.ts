import type {Env} from '../../worker-env.js';
import {featureJobCanRun} from '../../services/feature-enforcement.js';
import {clientForConnection,type StaffCalendarConnection} from './calendar-connection.js';
import {calendarCredentialsForEnv} from './booking-outlook-busy-runtime.js';
import {meetingOAuthConfig} from './booking-meeting-oauth-config.js';
import {meetingAccessToken} from './booking-meeting-access.js';
import {cachedMeetingAccess} from './booking-meeting-credentials.js';
import {meetingProvider} from './booking-meeting-providers.js';
import {outlookCalendar} from './booking-outlook-calendar.js';
import {cleanupRecipientProof} from './booking-external-cleanup-proof.js';
import {processExternalCleanup,type CleanupExecutor} from './booking-external-cleanup-runner.js';

/** 顧客や予約の行に依存せず、担当・接続・対象範囲を送信前に確認する。 */
export function externalCleanupExecutor(env:Env['Bindings']):CleanupExecutor {
 return async(accountId,item)=>{
  // 顧客情報の除去は予約機能が停止していても続ける。その他は機能停止に従う。
  if(item.provider!=='google_calendar'&&!await featureJobCanRun(env.DB,{accountId,featureId:'booking',job:'booking external cleanup'}))return 'wait';
  const staffActive=async()=>!!await env.DB.prepare('SELECT id FROM staff WHERE id=? AND line_account_id=? AND deleted_at IS NULL').bind(item.staffId,accountId).first();
  if(!await staffActive())return 'review';
  if(item.provider==='google_calendar'){
   if(!item.remoteId||!item.calendarId||!item.connectionId)return 'review';
   const connection=()=>env.DB.prepare(`SELECT id,calendar_id,auth_type,access_token FROM google_calendar_connections
    WHERE id=? AND line_account_id=? AND staff_id=? AND calendar_id=? AND is_active=1
    AND EXISTS(SELECT 1 FROM staff WHERE id=? AND line_account_id=? AND deleted_at IS NULL)`).bind(item.connectionId,accountId,item.staffId,item.calendarId,item.staffId,accountId).first<StaffCalendarConnection>();
   const current=await connection();if(!current)return 'review';
   try {
    const client=await clientForConnection(current,calendarCredentialsForEnv(env),{db:env.DB,accountId});
    // 結果不明の 404 は権限喪失との区別ができない。運用者に相手先での確認を依頼する。
    if(item.action==='review')return 'review';
    return await client.cleanupEvent(item.remoteId,item.action==='redact'?'redact':'delete',AbortSignal.timeout(10000),async()=>!!await connection());
   }catch{return 'review';}
  }
  if(env.DEPLOY_ENV!=='staging'||env.BOOKING_MEETING_REAL_ENABLED!=='true')return 'wait';
  if(item.provider==='outlook'&&item.action==='delete'&&env.BOOKING_OUTLOOK_MUTATIONS_ENABLED!=='true')return 'wait';
  if(!env.LINE_CREDENTIAL_ENCRYPTION_KEY||!item.testRecipientProof||(!item.remoteId&&!item.marker))return 'review';
  const eligible=async()=>{
   const setting=await env.DB.prepare("SELECT value FROM account_settings WHERE line_account_id=? AND key='test_recipients'").bind(accountId).first<{value:string}>();
   return !!setting && await cleanupRecipientProof(env.LINE_CREDENTIAL_ENCRYPTION_KEY!,accountId,setting.value)===item.testRecipientProof;
  };
  if(!await eligible())return 'review';
  const provider=item.provider,config=meetingOAuthConfig(env,provider);if(!config)return 'review';
  const access=await meetingAccessToken(env.DB,{accountId,staffId:item.staffId,provider,encryptionKey:env.LINE_CREDENTIAL_ENCRYPTION_KEY,config,signal:new AbortController().signal});
  if(access.kind==='busy'||access.kind==='retryable')return 'wait';
  if(access.kind!=='ready')return 'review';
  const token=async(staffId:string)=>{
   if(staffId!==item.staffId||!await staffActive()||!await eligible())return null;
   const current=await cachedMeetingAccess(env.DB,{accountId,staffId,provider,encryptionKey:env.LINE_CREDENTIAL_ENCRYPTION_KEY!});
   return current?.connectionId===access.connectionId?{token:current.token,accountId:current.externalAccountId}:null;
  };
  if(provider==='outlook'){
   if(!item.remoteId||!item.externalAccountId||item.externalAccountId!==access.externalAccountId)return 'review';
   const calendar=outlookCalendar(token,fetch,{allowMutations:true});
   if(item.action==='review')return await calendar.verify({staffId:item.staffId,accountId:item.externalAccountId,eventId:item.remoteId,signal:AbortSignal.timeout(8000)})==='absent'?'done':'review';
   if(item.action!=='delete')return 'review';
   const result=await calendar.mutate({staffId:item.staffId,accountId:item.externalAccountId,eventId:item.remoteId,action:'delete',signal:AbortSignal.timeout(8000),authorize:async()=>env.BOOKING_OUTLOOK_MUTATIONS_ENABLED==='true'&&await eligible()});
   return result==='done'?'done':'review';
  }
  const adapter=meetingProvider(provider,token);
  let meetingId=item.remoteId;
  if(item.action==='review'){
   if(meetingId){if(item.uncertainty!=='delete')return 'review';const result=await adapter.verifyDelete({staffId:item.staffId,meetingId,signal:AbortSignal.timeout(8000)});return result==='deleted'?'done':'review';}
   if(!item.marker||provider==='teams')return 'review';
   const found=await adapter.verifyCreate({staffId:item.staffId,idempotencyKey:item.marker,signal:AbortSignal.timeout(8000)});
   if(found.kind!=='found'||found.idempotencyKey!==item.marker)return 'review';
   meetingId=found.meetingId;
  }
  if(!meetingId||item.action==='redact')return 'review';
  const result=await adapter.remove({staffId:item.staffId,meetingId,idempotencyKey:'cleanup',signal:AbortSignal.timeout(8000)});
  return result==='deleted'?'done':'review';
 };
}
export async function recoverExternalCleanup(env:Env['Bindings'],now=Date.now()):Promise<number>{
 if(!env.LINE_CREDENTIAL_ENCRYPTION_KEY){
  const rows=await env.DB.prepare("SELECT w.scope_id FROM workflow_steps w WHERE w.process_kind='booking_external_cleanup' AND NOT EXISTS(SELECT 1 FROM notifications n WHERE n.id='external-cleanup-key:'||substr(w.scope_id,6) AND n.category='error') GROUP BY w.scope_id LIMIT 50").all<{scope_id:string}>();
  for(const row of rows.results??[])if(row.scope_id.startsWith('line:')){
   const account=row.scope_id.slice(5);
   await env.DB.prepare(`INSERT OR IGNORE INTO notifications(id,event_type,title,body,channel,status,metadata,line_account_id,category)
    VALUES(?,'booking_external_cleanup_key','外部の予定を確認できません','後片づけの設定を確認してください。','dashboard','sent','{}',?,'error') ON CONFLICT(id) DO UPDATE SET body=excluded.body,category='error'`).bind(`external-cleanup-key:${account}`,account).run();
  }
  return 0;
 }
 await env.DB.prepare("UPDATE notifications SET body='後片づけの設定を確認できました。',category='info' WHERE event_type='booking_external_cleanup_key' AND category='error'").run();
 return processExternalCleanup(env.DB,{encryptionKey:env.LINE_CREDENTIAL_ENCRYPTION_KEY,execute:externalCleanupExecutor(env),now});
}
