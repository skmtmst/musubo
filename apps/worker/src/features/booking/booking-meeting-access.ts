import {MeetingKeyConfigurationError,validateMeetingEncryptionKey,type MeetingKeyInput} from './booking-meeting-crypto.js';
import {cachedMeetingAccess,claimMeetingRefresh,failMeetingRefresh,finishMeetingRefresh,meetingConnectionState,recoverStaleMeetingRefresh,releaseMeetingRefresh,type ConnectionProvider} from './booking-meeting-credentials.js';
import {MeetingRefreshError,refreshMeetingAuthorization,type MeetingOAuthConfig} from './booking-meeting-oauth-client.js';
export type MeetingAccessResult={kind:'ready';token:string;externalAccountId:string;expiresAt:string;connectionId:string;version:number}|{kind:'busy'|'missing'|'retryable'|'configuration'|'reconnect'};
/** 更新鍵の競合を直列化する。通信結果不明の鍵は再送せず接続し直す。 */
export async function meetingAccessToken(db:D1Database,input:{accountId:string;staffId:string;provider:ConnectionProvider;encryptionKey:MeetingKeyInput;config:MeetingOAuthConfig|null;signal:AbortSignal},request:typeof fetch=fetch):Promise<MeetingAccessResult>{
 if(!input.config||input.config.provider!==input.provider||!input.config.clientId||!input.config.clientSecret)return {kind:'configuration'};
 const scope={accountId:input.accountId,staffId:input.staffId,provider:input.provider,encryptionKey:input.encryptionKey};
 if(input.signal.aborted)return {kind:'retryable'};
 try{await validateMeetingEncryptionKey(input.encryptionKey);}catch{return {kind:'configuration'};}
 let cached:Awaited<ReturnType<typeof cachedMeetingAccess>>;
 try{cached=await cachedMeetingAccess(db,scope);}catch(error){return {kind:error instanceof MeetingKeyConfigurationError?'configuration':'reconnect'};}
 if(cached)return {kind:'ready',...cached};
 let lease:Awaited<ReturnType<typeof claimMeetingRefresh>>;
 try{lease=await claimMeetingRefresh(db,scope);}catch(error){return {kind:error instanceof MeetingKeyConfigurationError?'configuration':'reconnect'};}
 if(!lease){await recoverStaleMeetingRefresh(db,scope);const state=await meetingConnectionState(db,scope);return {kind:state==='refreshing'?'busy':state==='unknown'?'reconnect':state==='ready'?'retryable':'missing'};}
 try {
  // 会議の8秒制限と独立させ、更新鍵の入れ替えを途中で打ち切らない。
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),20000);
  let token:Awaited<ReturnType<typeof refreshMeetingAuthorization>>;
  try{token=await refreshMeetingAuthorization(input.config,{refreshToken:lease.credential.refreshToken,signal:controller.signal},request);}finally{clearTimeout(timer);}
  const saved=await finishMeetingRefresh(db,{id:lease.id,claim:lease.claim,version:lease.version,credential:{...lease.credential,refreshToken:token.refreshToken,accessToken:token.accessToken,accessExpiresAt:token.expiresAt},encryptionKey:input.encryptionKey});
  // 切断・つなぎ直しが先なら、古い接続で得た access token は使わない。
  if(!saved)return {kind:'reconnect'};
  if(input.signal.aborted)return {kind:'retryable'};
  return {kind:'ready',token:token.accessToken,externalAccountId:lease.credential.externalAccountId,expiresAt:token.expiresAt,connectionId:lease.id,version:lease.version+1};
 } catch(error) {
  const kind=error instanceof MeetingRefreshError?error.kind:'unknown';
  if(kind==='retryable'||kind==='configuration')await releaseMeetingRefresh(db,lease);
  else await failMeetingRefresh(db,lease);
  return {kind:kind==='retryable'?'retryable':kind==='configuration'?'configuration':'reconnect'};
 }
}
