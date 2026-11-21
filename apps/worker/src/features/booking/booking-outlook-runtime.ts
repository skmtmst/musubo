import type {Env} from '../../worker-env.js';
import {meetingAccessToken} from './booking-meeting-access.js';
import {cachedMeetingAccess} from './booking-meeting-credentials.js';
import {meetingOAuthConfig} from './booking-meeting-oauth-config.js';
import {outlookCalendar} from './booking-outlook-calendar.js';

/** 試験宛先の予約に限って Outlook の鍵を準備する。受付前の空き照合には使わない。 */
export async function outlookCalendarForBooking(env:Env['Bindings'],input:{accountId:string;bookingId:string;staffId:string;previous?:boolean}):Promise<(ReturnType<typeof outlookCalendar> & {accountId:string})|null>{
 if(env.DEPLOY_ENV!=='staging'||env.BOOKING_MEETING_REAL_ENABLED!=='true'||!env.LINE_CREDENTIAL_ENCRYPTION_KEY)return null;
 const eligible=async()=>{
  const row=await env.DB.prepare(`SELECT b.friend_id,s.value FROM bookings b JOIN account_settings s ON s.line_account_id=b.line_account_id AND s.key='test_recipients'
   WHERE b.id=? AND b.line_account_id=? AND (b.staff_id=? OR (?=1 AND EXISTS (
    SELECT 1 FROM workflow_steps w WHERE w.scope_id='line:'||b.line_account_id AND w.process_kind='booking_outlook_sync'
     AND w.subject_id=b.id AND w.step_key='current' AND (json_extract(w.result_json,'$.staffId')=? OR (w.status='unknown' AND json_extract(w.input_json,'$.booking.staff_id')=?)))))`)
   .bind(input.bookingId,input.accountId,input.staffId,input.previous?1:0,input.staffId,input.staffId).first<{friend_id:string|null;value:string}>();
  if(!row?.friend_id)return false;try{const ids:unknown=JSON.parse(row.value);return Array.isArray(ids)&&ids.includes(row.friend_id);}catch{return false;}
 };
 if(!await eligible())return null;
 const config=meetingOAuthConfig(env,'outlook');if(!config)return null;
 const access=await meetingAccessToken(env.DB,{accountId:input.accountId,staffId:input.staffId,provider:'outlook',encryptionKey:env.LINE_CREDENTIAL_ENCRYPTION_KEY,config,signal:new AbortController().signal});
 if(access.kind!=='ready')return null;
 const calendar=outlookCalendar(async staffId=>{
  if(staffId!==input.staffId||!await eligible())return null;
  const row=await env.DB.prepare("SELECT id FROM booking_meeting_connections WHERE id=? AND line_account_id=? AND staff_id=? AND provider='outlook' AND version=? AND refresh_state='ready'")
   .bind(access.connectionId,input.accountId,staffId,access.version).first();
  if(row&&Date.parse(access.expiresAt)>Date.now()+10000)return {token:access.token,accountId:access.externalAccountId};
  const refreshed=await cachedMeetingAccess(env.DB,{accountId:input.accountId,staffId,provider:'outlook',encryptionKey:env.LINE_CREDENTIAL_ENCRYPTION_KEY!});
  return refreshed?.connectionId===access.connectionId?{token:refreshed.token,accountId:refreshed.externalAccountId}:null;
 },fetch,{allowMutations:env.BOOKING_OUTLOOK_MUTATIONS_ENABLED==='true'});
 return {...calendar,accountId:access.externalAccountId};
}
