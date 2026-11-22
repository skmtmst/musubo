import {meetingRevokeDecision} from '../features/booking/booking-meeting-revoke-decision.js';
import {meetingCredentialKeys,validateMeetingEncryptionKey} from '../features/booking/booking-meeting-crypto.js';
import {acquireMeetingRevokeLock,meetingRevokeLocked,ownsMeetingRevokeLock,releaseMeetingRevokeLock} from '../features/booking/booking-meeting-revoke-lock.js';
import {revokeMeetingAuthorization} from '../features/booking/booking-meeting-oauth-client.js';
import {queueAbandonedMeetingAuthorization} from '../features/booking/booking-meeting-deletion-runner.js';
import {Hono,type Context} from 'hono';
import {recordAuditEvent} from '@line-crm/db';
import {BOOKING_STAFF_OWN_KEY} from '@line-crm/shared';
import type {Env} from '../worker-env.js';
import {gapAccount,gapWrite,GapError} from '../services/gap-common.js';
import {beginMeetingAuthorization,consumeMeetingAuthorization} from '../features/booking/booking-meeting-oauth-state/index.js';
import {deleteMeetingCredential,finishAuthorizedMeetingConnection,meetingConnectionState,rotateMeetingCredentials,type ConnectionProvider} from '../features/booking/booking-meeting-credentials/index.js';
import {exchangeMeetingAuthorization,meetingAuthorizationUrl,newMeetingVerifier} from '../features/booking/booking-meeting-oauth-client/index.js';
import {auditLog} from '../lib/audit-log.js';
import {preferredMeetingProvider,setPreferredMeetingProvider} from '../features/booking/booking-meeting-preference/index.js';
import {outlookStaffIsTestRecipient} from '../features/booking/booking-outlook-busy-runtime/index.js';
import {calendarSwitch} from '../features/booking/booking-calendar-settings/index.js';
import {meetingOAuthConfig} from '../features/booking/booking-meeting-oauth-config/index.js';

export const bookingMeetingOAuth=new Hono<Env>();
bookingMeetingOAuth.onError((e,c)=>c.json({success:false,error:e instanceof GapError?e.code:'meeting_oauth_unavailable'},e instanceof GapError?e.status:503));
function providerOf(value:string):ConnectionProvider {
 if(value==='google_meet'||value==='zoom'||value==='teams'||value==='outlook')return value;
 throw new GapError('invalid_provider');
}
async function staffTarget(c:Context<Env>,accountId:string,staffId:string,write:boolean){
 const target=await c.env.DB.prepare('SELECT staff_member_id FROM staff WHERE id=? AND line_account_id=? AND deleted_at IS NULL').bind(staffId,accountId).first<{staff_member_id:string|null}>();
 if(!target)throw new GapError('not_found',404);
 const actor=c.get('staff');
 if(write&&(!['owner','admin','staff'].includes(actor.role)||(actor.role==='staff'&&(target.staff_member_id!==actor.id||!actor.permissionKeys?.includes(BOOKING_STAFF_OWN_KEY)))))throw new GapError('forbidden',403);
}
const callbackPath='/api/booking/admin/meeting-oauth/callback';
const cookieName='booking_meeting_oauth_state';
function stateCookie(value:string,maxAge=600):string{return `${cookieName}=${encodeURIComponent(value)}; Path=${callbackPath}; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;}
function returnedState(cookie:string|undefined):string|null {
 const match=cookie?.split(';').map(v=>v.trim()).find(v=>v.startsWith(`${cookieName}=`));
 if(!match)return null;try{return decodeURIComponent(match.slice(cookieName.length+1));}catch{return '';}
}
function adminReturn(c:Context<Env>,accountId:string,staffId:string,result:'connected'|'denied'|'failed'):string {
 const origin=new URL(c.env.ADMIN_PUBLIC_URL??c.env.WORKER_URL);if(origin.protocol!=='https:'||origin.username||origin.password)throw new GapError('oauth_not_configured',503);
 const target=new URL('/booking/menus',origin);target.searchParams.set('tab','staff');target.searchParams.set('staff',staffId);target.searchParams.set('account_id',accountId);target.searchParams.set('meeting_connection',result);return target.toString();
}
const base='/api/booking/admin/staff/:id/connections/:provider';
bookingMeetingOAuth.post('/api/booking/admin/meeting-credentials/rotate',async c=>{
 gapWrite(c);const accountId=await gapAccount(c);if(c.get('staff').role!=='owner')throw new GapError('forbidden',403);
 let body:unknown;try{body=await c.req.json();}catch{throw new GapError('invalid_input',400);}
 if(!body||typeof body!=='object'||Array.isArray(body))throw new GapError('invalid_input',400);
 const value=body as Record<string,unknown>;
 if((value.dryRun!==undefined&&typeof value.dryRun!=='boolean')||(value.afterId!==undefined&&(typeof value.afterId!=='string'||value.afterId.length>128))||(value.limit!==undefined&&(!Number.isInteger(value.limit)||Number(value.limit)<1||Number(value.limit)>100)))throw new GapError('invalid_input',400);
 const key=meetingCredentialKeys(c.env);await validateMeetingEncryptionKey(key);
 if(!key.writeV2||key.rejectLegacy)throw new GapError('meeting_rotation_not_available',409);
 const result=await rotateMeetingCredentials(c.env.DB,{accountId,encryptionKey:key,dryRun:value.dryRun!==false,afterId:value.afterId as string|undefined,limit:value.limit as number|undefined});
 if(value.dryRun===false)auditLog(c,'booking.meeting.credentials.rotate',{kind:'meeting'},{lineAccountId:accountId});
 return c.json({success:true,data:result});
});
bookingMeetingOAuth.get(base,async c=>{
 const accountId=await gapAccount(c),staffId=c.req.param('id')!,provider=providerOf(c.req.param('provider')!);await staffTarget(c,accountId,staffId,false);
 const state=await meetingConnectionState(c.env.DB,{accountId,staffId,provider});
 const preferred=provider==='outlook'?false:(await preferredMeetingProvider(c.env.DB,{accountId,staffId}))===provider;
 return c.json({success:true,data:{state,preferred,mode:meetingOAuthConfig(c.env,provider)?'configured':'mock'}});
});
bookingMeetingOAuth.post(base+'/prefer',async c=>{
 gapWrite(c);const accountId=await gapAccount(c),staffId=c.req.param('id')!,provider=providerOf(c.req.param('provider')!);await staffTarget(c,accountId,staffId,true);
 if(provider==='outlook')throw new GapError('invalid_provider');
 if(!await setPreferredMeetingProvider(c.env.DB,{accountId,staffId,provider}))throw new GapError('meeting_not_connected',409);
 auditLog(c,'booking.meeting.preferred',{id:staffId,kind:provider},{lineAccountId:accountId});
 return c.json({success:true,data:{preferred:true}});
});
bookingMeetingOAuth.post(base+'/connect',async c=>{
 gapWrite(c);const accountId=await gapAccount(c),staffId=c.req.param('id')!,provider=providerOf(c.req.param('provider')!);await staffTarget(c,accountId,staffId,true);
 const config=meetingOAuthConfig(c.env,provider);if(!config)return c.json({success:true,data:{mode:'mock',authorizationUrl:null}});
 if(provider==='outlook'&&(await calendarSwitch(c.env.DB,accountId,staffId)).readEnabled&&!await outlookStaffIsTestRecipient(c.env.DB,{lineAccountId:accountId,staffId}))throw new GapError('outlook_test_staff_required',409);
 if(!c.env.LINE_CREDENTIAL_ENCRYPTION_KEY)throw new GapError('oauth_not_configured',503);
 if(await meetingRevokeLocked(c.env.DB,{accountId,staffId,provider}))return c.json({success:false,error:'meeting_disconnect_in_progress',message:'解除の処理中です。少し待ってからつなぎ直してください。'},409);
 await validateMeetingEncryptionKey(meetingCredentialKeys(c.env));
 const verifier=newMeetingVerifier();let state:string;
 try{state=await beginMeetingAuthorization(c.env.DB,{accountId,staffId,actorId:c.get('staff').id,provider,verifier,encryptionKey:c.env.LINE_CREDENTIAL_ENCRYPTION_KEY});}catch(error){if(await meetingRevokeLocked(c.env.DB,{accountId,staffId,provider}))return c.json({success:false,error:'meeting_disconnect_in_progress',message:'解除の処理中です。少し待ってからつなぎ直してください。'},409);throw error;}
 c.header('Set-Cookie',stateCookie(state));
 auditLog(c,'booking.meeting.connect.start',{id:staffId,kind:provider},{lineAccountId:accountId});
 return c.json({success:true,data:{mode:'configured',authorizationUrl:await meetingAuthorizationUrl(config,state,verifier)}});
});
bookingMeetingOAuth.delete(base,async c=>{
 gapWrite(c);const accountId=await gapAccount(c),staffId=c.req.param('id')!,provider=providerOf(c.req.param('provider')!);await staffTarget(c,accountId,staffId,true);
 const scope={accountId,staffId,provider};
 if(provider==='google_meet'||provider==='zoom'){
  const row=await c.env.DB.prepare('SELECT id,version,credential_enc FROM booking_meeting_connections WHERE line_account_id=? AND staff_id=? AND provider=?').bind(accountId,staffId,provider).first<{id:string;version:number;credential_enc:string}>();
  const expected=row?{id:row.id,version:row.version}:null;
  const lease=await acquireMeetingRevokeLock(c.env.DB,scope);
  if(!lease){
   if(await meetingRevokeLocked(c.env.DB,scope))throw new GapError('meeting_disconnect_in_progress',409);
   if(!await deleteMeetingCredential(c.env.DB,{...scope,expected,externalManualReview:true}))throw new GapError('meeting_connection_changed',409);
   auditLog(c,'booking.meeting.disconnect',{id:staffId,kind:provider},{lineAccountId:accountId});
   return c.json({success:true,data:{disconnected:true}});
  }
  try{
   const config=meetingOAuthConfig(c.env,provider);
   const {decision,token}=row?await meetingRevokeDecision(c.env,{...scope,provider,connectionId:row.id,credentialEnc:row.credential_enc}):{decision:'review' as const,token:undefined};
   const reviewId=crypto.randomUUID();
   if(!await deleteMeetingCredential(c.env.DB,{...scope,expected,externalManualReview:decision!=='shared',reviewId}))throw new GapError('meeting_connection_changed',409);
   if(row&&decision==='revoke'&&token&&config&&await ownsMeetingRevokeLock(c.env.DB,scope,lease)){const outcome=await revokeMeetingAuthorization(config,{token,signal:AbortSignal.timeout(15000)});if(outcome==='done')await c.env.DB.prepare("DELETE FROM notifications WHERE id=? AND event_type='booking_meeting_disconnect_review'").bind(reviewId).run();}
  }finally{await releaseMeetingRevokeLock(c.env.DB,scope,lease);}
 }else if(!await deleteMeetingCredential(c.env.DB,{...scope,microsoftManualReview:true}))throw new GapError('meeting_connection_changed',409);
 if(provider==='outlook')await c.env.DB.prepare("UPDATE booking_calendar_read_health SET error_code=NULL,failed_since=NULL WHERE line_account_id=? AND staff_id=? AND error_code LIKE 'outlook_%'").bind(accountId,staffId).run();
 auditLog(c,'booking.meeting.disconnect',{id:staffId,kind:provider},{lineAccountId:accountId});
 return c.json({success:true,data:{disconnected:true}});
});
bookingMeetingOAuth.get('/api/booking/admin/meeting-oauth/callback',async c=>{
 gapWrite(c);const state=c.req.query('state')??'',actorId=c.get('staff').id;
 const cookie=returnedState(c.req.header('cookie'));c.header('Set-Cookie',stateCookie('',0));
 if(cookie!==null&&cookie!==state)throw new GapError('invalid_state',401);
 if(!/^[0-9a-f-]{72}$/.test(state))throw new GapError('invalid_state',401);
 const row=await c.env.DB.prepare('SELECT line_account_id,staff_id,provider FROM booking_meeting_oauth_states WHERE state=? AND actor_id=?').bind(state,actorId).first<{line_account_id:string;staff_id:string;provider:ConnectionProvider}>();
 if(!row)throw new GapError('invalid_state',401);
 const accountId=await gapAccount(c,row.line_account_id);await staffTarget(c,accountId,row.staff_id,true);
 const account=await c.env.DB.prepare('SELECT tenant_id FROM line_accounts WHERE id=?').bind(accountId).first<{tenant_id:string|null}>();
 if(await meetingRevokeLocked(c.env.DB,{accountId,staffId:row.staff_id,provider:row.provider}))return c.json({success:false,error:'meeting_disconnect_in_progress',message:'解除の処理中です。少し待ってからつなぎ直してください。'},409);
 const key=c.env.LINE_CREDENTIAL_ENCRYPTION_KEY;if(!key)throw new GapError('oauth_not_configured',503);
 await validateMeetingEncryptionKey(meetingCredentialKeys(c.env));
 const consumed=await consumeMeetingAuthorization(c.env.DB,{accountId,state,actorId,encryptionKey:key});if(!consumed)throw new GapError('invalid_state',401);
 if(c.req.query('error')||!c.req.query('code'))return c.redirect(adminReturn(c,accountId,consumed.staffId,'denied'));
 const config=meetingOAuthConfig(c.env,consumed.provider);if(!config)throw new GapError('oauth_not_configured',503);
 if(consumed.provider==='outlook'&&(await calendarSwitch(c.env.DB,accountId,consumed.staffId)).readEnabled&&!await outlookStaffIsTestRecipient(c.env.DB,{lineAccountId:accountId,staffId:consumed.staffId}))return c.redirect(adminReturn(c,accountId,consumed.staffId,'failed'));
 let tokens:Awaited<ReturnType<typeof exchangeMeetingAuthorization>>;
 try{tokens=await exchangeMeetingAuthorization(config,{code:c.req.query('code')!,verifier:consumed.verifier,signal:AbortSignal.timeout(15000)});}catch{return c.redirect(adminReturn(c,accountId,consumed.staffId,'failed'));}
 const credential={provider:consumed.provider,externalAccountId:tokens.externalAccountId,refreshToken:tokens.refreshToken,accessToken:tokens.accessToken,accessExpiresAt:tokens.expiresAt};
 const connected=await finishAuthorizedMeetingConnection(c.env.DB,{accountId,staffId:consumed.staffId,provider:consumed.provider,actorId,state,encryptionKey:meetingCredentialKeys(c.env),credential});
 if(!connected){try{await queueAbandonedMeetingAuthorization(c.env,{accountId,staffId:consumed.staffId,tenantId:account?.tenant_id??null,provider:consumed.provider,credential});}catch{await recordAuditEvent(c.env.DB,{tenantId:account?.tenant_id??undefined,category:'business',action:'booking.meeting.deleted_connection_review',actorPrincipalId:'system:booking',targetKind:'meeting_connection',targetId:consumed.staffId,result:'failed',riskLevel:'high',retentionClass:'security',after:{provider:consumed.provider,reason:'queue_failed'}});}return c.redirect(adminReturn(c,accountId,consumed.staffId,'failed'));}
 if(consumed.provider==='outlook')await c.env.DB.prepare(`UPDATE workflow_steps SET status='pending',error_code=NULL,next_attempt_at=NULL,updated_at=?
  WHERE scope_id=? AND process_kind='booking_outlook_sync' AND status='failed'
   AND (json_extract(result_json,'$.staffId')=? OR json_extract(input_json,'$.booking.staff_id')=?)`)
  .bind(Date.now(),`line:${accountId}`,consumed.staffId,consumed.staffId).run();
 if(consumed.provider==='outlook')await c.env.DB.prepare(`UPDATE workflow_steps SET next_attempt_at=0,updated_at=?
  WHERE scope_id=? AND process_kind='booking_outlook_sync' AND status='unknown' AND error_code='outlook_account_changed'
   AND json_extract(input_json,'$.booking.staff_id')=?`)
  .bind(Date.now(),`line:${accountId}`,consumed.staffId).run();
 await c.env.DB.prepare("UPDATE booking_meeting_links SET last_error_code=NULL,updated_at=? WHERE staff_id=? AND provider=? AND status='cancel_pending' AND last_error_code='manual_review' AND booking_id IN (SELECT id FROM bookings WHERE line_account_id=?)").bind(new Date().toISOString(),consumed.staffId,consumed.provider,accountId).run();
 auditLog(c,'booking.meeting.connect',{id:consumed.staffId,kind:consumed.provider},{lineAccountId:accountId});
 return c.redirect(adminReturn(c,accountId,consumed.staffId,'connected'));
});
