import {meetingCredentialKeys} from './booking-meeting-crypto.js';
import type { MeetingQueueDependencies } from './booking-meeting-queue.js';
import type { Env } from '../../worker-env.js';
import type {MeetingProvider} from './booking-meeting-create.js';
import {meetingAccessToken} from './booking-meeting-access.js';
import {cachedMeetingAccess} from './booking-meeting-credentials.js';
import {meetingOAuthConfig} from './booking-meeting-oauth-config.js';
import {meetingProvider} from './booking-meeting-providers.js';
import {preferredMeetingProvider} from './booking-meeting-preference.js';

type Token={token:string;accountId:string;connectionId:string;version:number;expiresAt:string};
async function isTestRecipient(db:D1Database,accountId:string,bookingId:string):Promise<boolean>{
 const row=await db.prepare(`SELECT b.friend_id,s.value FROM bookings b JOIN account_settings s ON s.line_account_id=b.line_account_id AND s.key='test_recipients'
  WHERE b.id=? AND b.line_account_id=?`).bind(bookingId,accountId).first<{friend_id:string|null;value:string}>();
 if(!row?.friend_id)return false;
 try{const ids:unknown=JSON.parse(row.value);return Array.isArray(ids)&&ids.includes(row.friend_id);}catch{return false;}
}
/** 検証環境で明示的に許可され、試験宛先に登録された予約だけ実サービスに接続する。 */
export function meetingQueueDependencies(env:Env['Bindings']):MeetingQueueDependencies {
 return {resolve:async ({accountId,bookingId})=>{
  if(env.DEPLOY_ENV!=='staging'||env.BOOKING_MEETING_REAL_ENABLED!=='true'||!env.LINE_CREDENTIAL_ENCRYPTION_KEY||!await isTestRecipient(env.DB,accountId,bookingId))return null;
  const booking=await env.DB.prepare('SELECT staff_id,status FROM bookings WHERE id=? AND line_account_id=?').bind(bookingId,accountId).first<{staff_id:string;status:string}>();if(!booking)return null;
  const rows=await env.DB.prepare(`SELECT staff_id,provider FROM booking_meeting_links WHERE booking_id=? AND status IN ('pending','active','cancel_pending') ORDER BY created_at DESC,id DESC`)
   .bind(bookingId).all<{staff_id:string|null;provider:MeetingProvider}>();
  const latest=rows.results?.[0];if(!latest)return null;
  const targets=new Map<string,{staffId:string;provider:MeetingProvider}>();
  for(const row of rows.results??[])if(row.staff_id)targets.set(JSON.stringify([row.staff_id,row.provider]),{staffId:row.staff_id,provider:row.provider});
  const selected=booking.status==='confirmed'?await preferredMeetingProvider(env.DB,{accountId,staffId:booking.staff_id}):null;
  if(booking.status==='confirmed'&&!selected)return null;
  if(selected)targets.set(JSON.stringify([booking.staff_id,selected]),{staffId:booking.staff_id,provider:selected});
  const unavailable:Array<{staffId:string;provider:MeetingProvider}>=[];
  const tokens=new Map<string,Token>();
  for(const [mapKey,target] of targets){
   const config=meetingOAuthConfig(env,target.provider);if(!config)return null;
   // 外部会議の8秒の期限の前に鍵を取得し、回転を最後まで保存する。
   const access=await meetingAccessToken(env.DB,{accountId,staffId:target.staffId,provider:target.provider,encryptionKey:meetingCredentialKeys(env),config,signal:new AbortController().signal});
   if(access.kind==='busy'||access.kind==='retryable')return {deferred:true,removers:{},verifiers:{}};
   if(access.kind!=='ready'){
    if((access.kind==='missing'||access.kind==='reconnect') && (target.staffId!==booking.staff_id || target.provider!==selected)){unavailable.push(target);continue;}
    return null;
   }
   tokens.set(mapKey,{token:access.token,accountId:access.externalAccountId,connectionId:access.connectionId,version:access.version,expiresAt:access.expiresAt});
  }
  const byProvider=new Map<MeetingProvider,ReturnType<typeof meetingProvider>>();
  for(const target of targets.values())if(!byProvider.has(target.provider)){
   const p=target.provider;
   byProvider.set(p,meetingProvider(p,async staffId=>{
    if(!await isTestRecipient(env.DB,accountId,bookingId))return null;
    const token=tokens.get(JSON.stringify([staffId,p]));if(!token)return null;
    const current=await env.DB.prepare("SELECT id FROM booking_meeting_connections WHERE id=? AND line_account_id=? AND staff_id=? AND provider=? AND version=? AND refresh_state='ready'")
     .bind(token.connectionId,accountId,staffId,p,token.version).first();
    if(current&&Date.parse(token.expiresAt)>Date.now()+10000)return {token:token.token,accountId:token.accountId};
    // 同じ接続の鍵だけが更新された場合は、新しく保存された鍵を使う。
    const refreshed=await cachedMeetingAccess(env.DB,{accountId,staffId,provider:p,encryptionKey:meetingCredentialKeys(env)});
    return refreshed?.connectionId===token.connectionId?{token:refreshed.token,accountId:refreshed.externalAccountId}:null;
   }));
  }
  const removers:NonNullable<Awaited<ReturnType<MeetingQueueDependencies['resolve']>>>['removers']={};
  const verifiers:NonNullable<Awaited<ReturnType<MeetingQueueDependencies['resolve']>>>['verifiers']={};
  for(const [provider,adapter] of byProvider){removers[provider]=adapter;verifiers[provider]=adapter;}
  return {creator:selected?byProvider.get(selected):undefined,removers,verifiers,unavailable};
 }};
}

/** 確定時は対象メニューの自動発行がオンの場合だけ、担当者の接続を用意する。 */
export async function meetingCreatorForBooking(env:Env['Bindings'],bookingId:string):Promise<ReturnType<typeof meetingProvider>|null|'deferred'|'unavailable'> {
 if(env.DEPLOY_ENV!=='staging'||env.BOOKING_MEETING_REAL_ENABLED!=='true'||!env.LINE_CREDENTIAL_ENCRYPTION_KEY)return null;
 const booking=await env.DB.prepare(`SELECT b.line_account_id,b.staff_id FROM bookings b JOIN account_settings a
  ON a.line_account_id=b.line_account_id AND a.key='booking.meeting.automatic:'||b.menu_id AND a.value='automatic'
  WHERE b.id=? AND b.status='confirmed' AND b.meeting_mode='online' AND b.meeting_url_source IS NOT 'manual'`)
  .bind(bookingId).first<{line_account_id:string;staff_id:string}>();
 if(!booking||!await isTestRecipient(env.DB,booking.line_account_id,bookingId))return null;
 const accountId=booking.line_account_id,staffId=booking.staff_id;
 const provider=await preferredMeetingProvider(env.DB,{accountId,staffId});if(!provider)return 'unavailable';
 const config=meetingOAuthConfig(env,provider);if(!config)return 'unavailable';
 const access=await meetingAccessToken(env.DB,{accountId,staffId,provider,encryptionKey:meetingCredentialKeys(env),config,signal:new AbortController().signal});
 if(access.kind==='busy'||access.kind==='retryable')return 'deferred';
 if(access.kind!=='ready')return 'unavailable';
 return meetingProvider(provider,async target=>{
  if(target!==staffId||!await isTestRecipient(env.DB,accountId,bookingId))return null;
  const current=await env.DB.prepare("SELECT id FROM booking_meeting_connections WHERE id=? AND line_account_id=? AND staff_id=? AND provider=? AND version=? AND refresh_state='ready'")
   .bind(access.connectionId,accountId,staffId,provider,access.version).first();
  if(current&&Date.parse(access.expiresAt)>Date.now()+10000)return {token:access.token,accountId:access.externalAccountId};
  const refreshed=await cachedMeetingAccess(env.DB,{accountId,staffId,provider,encryptionKey:meetingCredentialKeys(env)});
  return refreshed?.connectionId===access.connectionId?{token:refreshed.token,accountId:refreshed.externalAccountId}:null;
 });
}
