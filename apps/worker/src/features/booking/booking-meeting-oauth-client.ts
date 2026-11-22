import type {ConnectionProvider} from './booking-meeting-credentials.js';

export interface MeetingOAuthConfig {provider:ConnectionProvider;clientId:string;clientSecret:string;redirectUri:string}
export interface MeetingOAuthTokens {accessToken:string;refreshToken:string;externalAccountId:string;expiresAt:string}
const urls:Record<ConnectionProvider,{authorize:string;token:string;identity:string;scope:string}>={
 google_meet:{authorize:'https://accounts.google.com/o/oauth2/v2/auth',token:'https://oauth2.googleapis.com/token',identity:'https://openidconnect.googleapis.com/v1/userinfo',scope:'openid https://www.googleapis.com/auth/calendar.events'},
 zoom:{authorize:'https://zoom.us/oauth/authorize',token:'https://zoom.us/oauth/token',identity:'https://api.zoom.us/v2/users/me',scope:'user:read:user meeting:write:meeting meeting:read:meeting meeting:read:list_meetings meeting:delete:meeting'},
 teams:{authorize:'https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize',token:'https://login.microsoftonline.com/organizations/oauth2/v2.0/token',identity:'https://graph.microsoft.com/v1.0/me?$select=id',scope:'offline_access User.Read OnlineMeetings.ReadWrite'},
 outlook:{authorize:'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',token:'https://login.microsoftonline.com/common/oauth2/v2.0/token',identity:'https://graph.microsoft.com/v1.0/me?$select=id',scope:'offline_access User.Read Calendars.ReadWrite'},
};
function base64url(bytes:Uint8Array):string{return btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');}
export function newMeetingVerifier():string {return base64url(crypto.getRandomValues(new Uint8Array(32)));}
export async function meetingAuthorizationUrl(config:MeetingOAuthConfig,state:string,verifier:string):Promise<string>{
 const redirect=new URL(config.redirectUri);if(redirect.protocol!=='https:'||redirect.username||redirect.password||!config.clientId||!state||!verifier)throw new Error('oauth_not_configured');
 const target=new URL(urls[config.provider].authorize),digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier));
 target.searchParams.set('client_id',config.clientId);target.searchParams.set('redirect_uri',config.redirectUri);target.searchParams.set('response_type','code');target.searchParams.set('state',state);
 target.searchParams.set('code_challenge',base64url(new Uint8Array(digest)));target.searchParams.set('code_challenge_method','S256');
 if(urls[config.provider].scope)target.searchParams.set('scope',urls[config.provider].scope);
 if(config.provider==='google_meet'){target.searchParams.set('access_type','offline');target.searchParams.set('prompt','consent');}
 return target.toString();
}
/** 受信コードは一度だけ交換し、取得した本人IDと更新鍵を呼び出し元の暗号保存へ渡す。 */
export async function exchangeMeetingAuthorization(config:MeetingOAuthConfig,input:{code:string;verifier:string;signal:AbortSignal},request:typeof fetch=fetch):Promise<MeetingOAuthTokens>{
 if(!config.clientId||!config.clientSecret||!input.code||!input.verifier)throw new Error('oauth_not_configured');
 const body=new URLSearchParams({grant_type:'authorization_code',code:input.code,redirect_uri:config.redirectUri,code_verifier:input.verifier});
 const headers:Record<string,string>={'Content-Type':'application/x-www-form-urlencoded'};
 if(config.provider==='zoom')headers.Authorization=`Basic ${btoa(`${config.clientId}:${config.clientSecret}`)}`;
 else{body.set('client_id',config.clientId);body.set('client_secret',config.clientSecret);}
 const tokenResponse=await request(urls[config.provider].token,{method:'POST',headers,body:body.toString(),signal:input.signal});
 if(!tokenResponse.ok)throw new Error('oauth_exchange_failed');
 const raw:unknown=await tokenResponse.json();if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('oauth_exchange_failed');
 const data=raw as Record<string,unknown>;
 if(typeof data.access_token!=='string'||!data.access_token||typeof data.refresh_token!=='string'||!data.refresh_token||typeof data.expires_in!=='number'||!Number.isFinite(data.expires_in)||data.expires_in<=0||data.expires_in>86400)throw new Error('oauth_exchange_failed');
 const expiresAt=new Date(Date.now()+data.expires_in*1000).toISOString();
 const expected=config.provider==='google_meet'?['https://www.googleapis.com/auth/calendar.events']:config.provider==='zoom'?['user:read:user','meeting:write:meeting','meeting:read:meeting','meeting:read:list_meetings','meeting:delete:meeting']:config.provider==='teams'?['User.Read','OnlineMeetings.ReadWrite']:['User.Read','Calendars.ReadWrite'];
 const granted=typeof data.scope==='string'?data.scope.split(/\s+/).map(v=>v.replace(/^https:\/\/graph\.microsoft\.com\//i,'')):[];
 if(!expected.every(scope=>granted.some(v=>v.toLowerCase()===scope.toLowerCase())))throw new Error('oauth_scope_missing');
 const identityResponse=await request(urls[config.provider].identity,{headers:{Authorization:`Bearer ${data.access_token}`},signal:input.signal});
 if(!identityResponse.ok)throw new Error('oauth_identity_failed');
 const rawIdentity:unknown=await identityResponse.json();if(!rawIdentity||typeof rawIdentity!=='object'||Array.isArray(rawIdentity))throw new Error('oauth_identity_failed');
 const identity=rawIdentity as Record<string,unknown>,id=config.provider==='google_meet'?identity.sub:identity.id;
 if(typeof id!=='string'||!id)throw new Error('oauth_identity_failed');
 return {accessToken:data.access_token,refreshToken:data.refresh_token,externalAccountId:id,expiresAt};
}

export class MeetingRefreshError extends Error {
 constructor(public readonly kind:'retryable'|'revoked'|'unknown'|'configuration'){super('oauth_refresh_failed');}
}
/** 相手先の解除結果だけを返す。応答や秘密値はログや通知に出さない。 */
export async function revokeMeetingAuthorization(config:MeetingOAuthConfig,input:{token:string;signal:AbortSignal},request:typeof fetch=fetch):Promise<'done'|'review'> {
 if((config.provider!=='google_meet'&&config.provider!=='zoom')||!input.token||!config.clientId||!config.clientSecret)return 'review';
 const headers:Record<string,string>={'Content-Type':'application/x-www-form-urlencoded'};
 if(config.provider==='zoom')headers.Authorization=`Basic ${btoa(`${config.clientId}:${config.clientSecret}`)}`;
 const body=new URLSearchParams({token:input.token});
 try {const response=await request(config.provider==='zoom'?'https://zoom.us/oauth/revoke':'https://oauth2.googleapis.com/revoke',{method:'POST',headers,body:body.toString(),signal:input.signal});return response.ok?'done':'review';}catch{return 'review';}
}
/** Zoom は成功応答を保存できなければ旧鍵が使えない。結果不明時は接続し直す。 */
export async function refreshMeetingAuthorization(config:MeetingOAuthConfig,input:{refreshToken:string;signal:AbortSignal},request:typeof fetch=fetch):Promise<{accessToken:string;refreshToken:string;expiresAt:string}>{
 if(!config.clientId||!config.clientSecret||!input.refreshToken)throw new Error('oauth_not_configured');
 const body=new URLSearchParams({grant_type:'refresh_token',refresh_token:input.refreshToken});
 const headers:Record<string,string>={'Content-Type':'application/x-www-form-urlencoded'};
 if(config.provider==='zoom')headers.Authorization=`Basic ${btoa(`${config.clientId}:${config.clientSecret}`)}`;
 else{body.set('client_id',config.clientId);body.set('client_secret',config.clientSecret);}
 let response:Response;
 try {response=await request(urls[config.provider].token,{method:'POST',headers,body:body.toString(),signal:input.signal});}
 catch {throw new MeetingRefreshError(config.provider==='zoom'?'unknown':'retryable');}
 if(!response.ok){
  let providerError='';try{const value:unknown=await response.json();if(value&&typeof value==='object'&&!Array.isArray(value)&&typeof (value as Record<string,unknown>).error==='string')providerError=(value as Record<string,string>).error;}catch{/* 応答の本文は記録しない */}
  if(['invalid_grant','interaction_required'].includes(providerError))throw new MeetingRefreshError('revoked');
  if(['invalid_client','unauthorized_client'].includes(providerError))throw new MeetingRefreshError('configuration');
  throw new MeetingRefreshError(config.provider!=='zoom'&&(response.status===429||response.status>=500)?'retryable':'unknown');
 }
 let raw:unknown;try{raw=await response.json();}catch{throw new MeetingRefreshError('unknown');}if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new MeetingRefreshError('unknown');
 const data=raw as Record<string,unknown>;
 if(typeof data.access_token!=='string'||!data.access_token||typeof data.expires_in!=='number'||!Number.isFinite(data.expires_in)||data.expires_in<=0||data.expires_in>86400)throw new MeetingRefreshError('unknown');
 if(config.provider==='zoom'&&(typeof data.refresh_token!=='string'||!data.refresh_token))throw new MeetingRefreshError('unknown');
 const refreshToken=typeof data.refresh_token==='string'&&data.refresh_token?data.refresh_token:input.refreshToken;
 return {accessToken:data.access_token,refreshToken,expiresAt:new Date(Date.now()+data.expires_in*1000).toISOString()};
}
