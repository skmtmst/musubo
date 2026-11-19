import {logger} from '@line-crm/shared/server';
import type {Env} from '../../worker-env.js';
import {outlookCalendarForBooking} from './booking-outlook-runtime.js';
import {featureJobCanRun} from '../../services/feature-enforcement.js';
import {calendarSwitch} from './calendar-switch-state.js';
import {meetingOAuthConfig} from './booking-meeting-oauth-config.js';
import {meetingConnectionState} from './booking-meeting-credentials.js';
import {syncOutlookBooking} from './booking-outlook-sync.js';
/** 実通信は runtime で検証環境と試験先に限定する。変更・取消は別の設定で許可する。 */
export async function syncOutlookBookingForEnv(env:Env['Bindings'],bookingId:string,options:{removeOnly?:boolean;switchScope?:string;switchVersion?:number}={}):Promise<'done'|'skipped'|'failed'|'unknown'|'busy'> {
 const row=await env.DB.prepare('SELECT line_account_id FROM bookings WHERE id=?').bind(bookingId).first<{line_account_id:string}>();
 if(env.DEPLOY_ENV!=='staging'||env.BOOKING_MEETING_REAL_ENABLED!=='true'||!env.LINE_CREDENTIAL_ENCRYPTION_KEY||!meetingOAuthConfig(env,'outlook'))return 'skipped';
 if(!row||!await featureJobCanRun(env.DB,{accountId:row.line_account_id,featureId:'booking',job:'booking meeting recovery'}))return 'skipped';
 const eligible=await env.DB.prepare(`SELECT b.friend_id,s.value FROM bookings b JOIN account_settings s ON s.line_account_id=b.line_account_id AND s.key='test_recipients' WHERE b.id=? AND b.line_account_id=?`)
  .bind(bookingId,row.line_account_id).first<{friend_id:string|null;value:string}>();
 try{if(!eligible?.friend_id||!Array.isArray(JSON.parse(eligible.value))||!(JSON.parse(eligible.value) as unknown[]).includes(eligible.friend_id))return 'skipped';}catch{return 'skipped';}
 return syncOutlookBooking(env.DB,{accountId:row.line_account_id,bookingId},{
  resolve:async input=>{
   const calendar=await outlookCalendarForBooking(env,input);if(calendar)return calendar;
   if(env.DEPLOY_ENV==='staging'&&env.BOOKING_MEETING_REAL_ENABLED==='true'){
    const state=await meetingConnectionState(env.DB,{accountId:input.accountId,staffId:input.staffId,provider:'outlook'});
    if(state==='refreshing'||state==='ready')return 'deferred';
   }
   return null;
  },
  allowMutations:env.DEPLOY_ENV==='staging'&&env.BOOKING_OUTLOOK_MUTATIONS_ENABLED==='true',
  removeOnly:options.removeOnly,
  authorizeRemoval:options.removeOnly?async()=>{
   if(options.switchScope===undefined||options.switchVersion===undefined)return false;
   const current=await calendarSwitch(env.DB,row.line_account_id,options.switchScope);
   return !current.writeEnabled&&current.version===options.switchVersion;
  }:undefined,
 });
}

/** 古い時刻や取消を見回す。結果不明の要求は台帳の待機時刻と回数を守る。 */
export async function recoverOutlookBookings(env:Env['Bindings'],now=new Date()):Promise<number> {
 if(env.DEPLOY_ENV!=='staging'||env.BOOKING_MEETING_REAL_ENABLED!=='true')return 0;
 const {accountFeatureOffExclusionSql}=await import('@line-crm/db');
 const allow=env.BOOKING_OUTLOOK_MUTATIONS_ENABLED==='true';
 const rows=await env.DB.prepare(`SELECT b.id,b.line_account_id FROM bookings b JOIN workflow_steps w
  ON w.scope_id='line:'||b.line_account_id AND w.subject_id=b.id AND w.process_kind='booking_outlook_sync' AND w.step_key='current'
  WHERE NOT ${accountFeatureOffExclusionSql('b.line_account_id','booking')} AND
   (COALESCE(json_extract(w.input_json,'$.removeOnly'),0)<>1 OR (w.status='unknown' AND EXISTS(
    SELECT 1 FROM booking_calendar_switch_jobs j WHERE j.line_account_id=b.line_account_id AND j.booking_id=b.id
     AND j.switch_scope LIKE 'outlook:%' AND j.action='delete' AND j.status='cancelled'))) AND w.updated_at<=?
   AND ((w.status='pending') OR (w.status='running' AND w.lease_expires_at<=?)
    OR (w.status='unknown' AND (w.attempt_count<3 OR json_extract(w.input_json,'$.removeOnly')=1) AND COALESCE(w.next_attempt_at,0)<=?)
    OR (w.status='failed' AND json_extract(w.input_json,'$.booking.lock_version') IS NOT b.lock_version)
    OR (w.status='succeeded' AND json_extract(w.result_json,'$.eventId') IS NOT NULL AND ?=1 AND
      (b.status!='confirmed' OR json_extract(w.result_json,'$.staffId') IS NOT b.staff_id
       OR json_extract(w.result_json,'$.startsAt') IS NOT b.starts_at OR json_extract(w.result_json,'$.endsAt') IS NOT b.ends_at)))
   AND (?=1 OR json_extract(w.result_json,'$.eventId') IS NULL OR (w.status='unknown' AND json_extract(w.input_json,'$.removeOnly')=1))
  ORDER BY w.updated_at,b.id LIMIT 50`).bind(now.getTime()-60000,now.getTime(),now.getTime(),allow?1:0,allow?1:0).all<{id:string;line_account_id:string}>();
 for(const row of rows.results??[]){
  try{await syncOutlookBookingForEnv(env,row.id);}catch{logger.warn('booking_outlook_recovery_failed');}
  // 通信できない行も順番を譲り、後ろの予約が詰まらないようにする。
  await env.DB.prepare("UPDATE workflow_steps SET updated_at=? WHERE scope_id=? AND process_kind='booking_outlook_sync' AND subject_id=? AND status!='running' AND updated_at<=?")
   .bind(now.getTime(),`line:${row.line_account_id}`,row.id,now.getTime()-60000).run();
 }
 return rows.results?.length??0;
}
