import {decryptMeetingCredential,meetingCredentialKeys} from './booking-meeting-crypto.js';
import {meetingOAuthConfig} from './booking-meeting-oauth-config.js';
import type {ConnectionProvider} from './booking-meeting-credentials.js';
import type {Env} from '../../worker-env.js';

type Provider=Extract<ConnectionProvider,'google_meet'|'zoom'>;
export type DeletedMeetingCredential={accountId:string;staffId:string;provider:Provider;connectionId:string;credentialEnc:string};
/** provider ごとの借受を持つ間だけ呼ぶ。本人を確かめられないものは外部へ触れない。 */
export async function meetingRevokeDecision(env:Env['Bindings'],item:DeletedMeetingCredential):Promise<{decision:'revoke'|'shared'|'review';token?:string}>{
 const {accountId,staffId,provider,connectionId,credentialEnc}=item,config=meetingOAuthConfig(env,provider);
 if(!config)return {decision:'review'};
 try{
  const keys=meetingCredentialKeys(env),value=JSON.parse((await decryptMeetingCredential(credentialEnc,keys,{accountId,staffId,provider})).plaintext) as {provider?:unknown;externalAccountId?:unknown;refreshToken?:unknown;accessToken?:unknown};
  if(value.provider!==provider||typeof value.externalAccountId!=='string'||!value.externalAccountId||typeof value.refreshToken!=='string'||!value.refreshToken)return {decision:'review'};
  const token=provider==='zoom'?(typeof value.accessToken==='string'?value.accessToken:undefined):value.refreshToken;
  let decision:'revoke'|'shared'|'review'=token?'revoke':'review';
  if(provider==='google_meet'){
   const ambiguous=await env.DB.prepare("SELECT 1 FROM google_calendar_connections WHERE is_active=1 AND auth_type='oauth' UNION ALL SELECT 1 FROM rt_google_connections WHERE refresh_token_enc IS NOT NULL UNION ALL SELECT 1 FROM google_sheets_integrations WHERE refresh_token_enc IS NOT NULL UNION ALL SELECT 1 FROM workflow_steps WHERE scope_id='global:meeting-revoke-queue' AND process_kind='booking_meeting_deleted_revoke' AND status IN ('pending','running','unknown') AND ((json_valid(input_json) AND json_extract(input_json,'$.provider')='google_calendar' AND COALESCE(json_extract(input_json,'$.authType'),'')<>'service_account') OR (json_valid(result_json) AND json_extract(result_json,'$.provider')='google_calendar' AND COALESCE(json_extract(result_json,'$.authType'),'')<>'service_account')) LIMIT 1").first();
   if(ambiguous||env.GOOGLE_BUSINESS_OAUTH_CLIENT_ID||env.GOOGLE_SHEETS_OAUTH_CLIENT_ID)decision='review';
  }
  const others=await env.DB.prepare('SELECT id,line_account_id,staff_id,credential_enc FROM booking_meeting_connections WHERE provider=? AND id<>? LIMIT 501').bind(provider,connectionId).all<{id:string;line_account_id:string;staff_id:string;credential_enc:string}>();
  if(others.results.length>500)decision='review';
  for(const other of others.results){
   const scope={accountId:other.line_account_id,staffId:other.staff_id,provider};
   const otherValue=JSON.parse((await decryptMeetingCredential(other.credential_enc,keys,scope)).plaintext) as {externalAccountId?:unknown;provider?:unknown};
   if(otherValue.provider!==provider||typeof otherValue.externalAccountId!=='string'||!otherValue.externalAccountId){decision='review';break;}
   if(otherValue.externalAccountId===value.externalAccountId){decision='shared';break;}
  }
  const queued=await env.DB.prepare(`SELECT input_json FROM workflow_steps WHERE scope_id='global:meeting-revoke-queue' AND process_kind='booking_meeting_deleted_revoke' AND subject_id<>? AND status IN ('pending','running') AND json_valid(input_json) AND json_extract(input_json,'$.provider')=? LIMIT 501`).bind(connectionId,provider).all<{input_json:string}>();
  if(queued.results.length>500&&decision!=='shared')decision='review';
  for(const pending of queued.results){
   const other=JSON.parse(pending.input_json) as {accountId?:unknown;staffId?:unknown;credentialEnc?:unknown};
   if(typeof other.accountId!=='string'||typeof other.staffId!=='string'||typeof other.credentialEnc!=='string'){if(decision!=='shared')decision='review';continue;}
   const otherValue=JSON.parse((await decryptMeetingCredential(other.credentialEnc,keys,{accountId:other.accountId,staffId:other.staffId,provider})).plaintext) as {provider?:unknown;externalAccountId?:unknown};
   if(otherValue.provider!==provider||typeof otherValue.externalAccountId!=='string'||!otherValue.externalAccountId){if(decision!=='shared')decision='review';continue;}
   if(otherValue.externalAccountId===value.externalAccountId){decision='shared';break;}
  }
  return {decision,token};
 }catch{return {decision:'review'};}
}
