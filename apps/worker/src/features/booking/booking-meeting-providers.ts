import type { MeetingCreator, MeetingProvider, MeetingCreateResult } from './booking-meeting-create.js';
import type { MeetingRemover } from './booking-meeting-lifecycle.js';
import type { MeetingVerifier } from './booking-meeting-verify.js';

/** accountId は接続行ではなく、外部サービスが返す主催者本人の不変ID。 */
type TokenSource = (staffId:string)=>Promise<{token:string;accountId:string}|null>;
function packId(accountId:string,remoteId:string):string{return JSON.stringify([accountId,remoteId]);}
function unpackId(value:string):[string,string]|null {try{const x:unknown=JSON.parse(value);return Array.isArray(x)&&x.length===2&&x.every(v=>typeof v==='string'&&v.length>0)?[x[0],x[1]]:null;}catch{return null;}}
type Json = Record<string,unknown>;
function obj(value:unknown):Json {return value&&typeof value==='object'&&!Array.isArray(value)?value as Json:{};}
function text(value:unknown):string {return typeof value==='string'?value:'';}
function validUrl(provider:MeetingProvider,value:string):boolean {
 try {const u=new URL(value),h=u.hostname.toLowerCase();return u.protocol==='https:' && !u.username && !u.password && (provider==='google_meet'?h==='meet.google.com':provider==='zoom'?(h==='zoom.us'||h.endsWith('.zoom.us')):(h==='teams.microsoft.com'||h==='teams.live.com'));}catch{return false;}
}
async function googleEventId(key:string):Promise<string>{
 const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(key));
 return Array.from(new Uint8Array(hash),v=>v.toString(16).padStart(2,'0')).join('');
}
/** I/O は注入可能。credential は呼び出しごとに取得し、ログや結果には含めない。 */
export function meetingProvider(provider:MeetingProvider,tokenForStaff:TokenSource,request:typeof fetch=fetch):MeetingCreator & MeetingRemover & MeetingVerifier {
 async function call(staffId:string,url:string,method:string,body:unknown,signal:AbortSignal,expectedAccount?:string):Promise<{response:Response;accountId:string}|null>{
  const credential=await tokenForStaff(staffId);if(!credential?.token||!credential.accountId||(expectedAccount!==undefined&&credential.accountId!==expectedAccount))return null;
  const response=await request(url,{method,headers:{Authorization:`Bearer ${credential.token}`,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal});
  return {response,accountId:credential.accountId};
 }
 async function create(input:Parameters<MeetingCreator['create']>[0]):Promise<MeetingCreateResult>{
  const eventId=provider==='google_meet'?await googleEventId(input.idempotencyKey):'';
  const url=provider==='google_meet'?'https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1&sendUpdates=none':provider==='teams'?'https://graph.microsoft.com/v1.0/me/onlineMeetings/createOrGet':'https://api.zoom.us/v2/users/me/meetings';
  const body=provider==='google_meet'?{id:eventId,summary:'予約',transparency:'transparent',start:{dateTime:input.startsAt},end:{dateTime:input.endsAt},extendedProperties:{private:{bookingKey:input.idempotencyKey}},conferenceData:{createRequest:{requestId:eventId,conferenceSolutionKey:{type:'hangoutsMeet'}}}}:provider==='teams'?{subject:'予約',startDateTime:input.startsAt,endDateTime:input.endsAt,externalId:input.idempotencyKey}:{topic:'予約',type:2,start_time:input.startsAt,duration:Math.ceil((Date.parse(input.endsAt)-Date.parse(input.startsAt))/60000),agenda:input.idempotencyKey};
  let callResult:Awaited<ReturnType<typeof call>>;
  try{callResult=await call(input.staffId,url,'POST',body,input.signal);}catch{return {kind:'unknown'};}
  if(!callResult)return {kind:'failed',code:'not_connected'};
  const {response,accountId}=callResult;
  if(!response.ok) {
   if(response.status===401||response.status===403)return {kind:'failed',code:'authorization_failed'};
   if(response.status>=400&&response.status<500&&![408,409].includes(response.status))return {kind:'failed',code:'provider_rejected'};
   return {kind:'unknown'};
  }
  let data:Json;try{data=obj(await response.json());}catch{return {kind:'unknown'};}
  const meetingId=text(data.id)|| (typeof data.id==='number'?String(data.id):'');
  const meetingUrl=provider==='google_meet'?text(data.hangoutLink):provider==='teams'?text(data.joinWebUrl):text(data.join_url);
  return meetingId&&validUrl(provider,meetingUrl)&&(provider!=='google_meet'||meetingId===eventId)?{kind:'created',meetingId:packId(accountId,meetingId),url:meetingUrl}:{kind:'unknown'};
 }
 async function remove(input:Parameters<MeetingRemover['remove']>[0]):Promise<'deleted'|'failed'|'unknown'>{
  const identity=unpackId(input.meetingId);if(!identity)return 'failed';
  const id=encodeURIComponent(identity[1]);
  const url=provider==='google_meet'?`https://www.googleapis.com/calendar/v3/calendars/primary/events/${id}?sendUpdates=none`:provider==='teams'?`https://graph.microsoft.com/v1.0/me/onlineMeetings/${id}`:`https://api.zoom.us/v2/meetings/${id}`;
  try{const result=await call(input.staffId,url,'DELETE',undefined,input.signal,identity[0]);if(!result)return 'failed';const r=result.response;if(r.ok||r.status===404||r.status===410)return 'deleted';return r.status===401||r.status===403?'failed':'unknown';}catch{return 'unknown';}
 }
 async function verifyCreate(input:Parameters<MeetingVerifier['verifyCreate']>[0]):ReturnType<MeetingVerifier['verifyCreate']>{
  if(provider==='zoom'){
   // 一覧は agenda が250文字に切られるため、候補は詳細で鍵を照合する。不在を再送に使うのは確実に失敗した行だけ。
   if(!input.idempotencyKey||input.idempotencyKey.length>250)return {kind:'unknown'};
   try{
    let page='',accountId='',found:{meetingId:string;url:string}|null=null;
    const seen=new Set<string>();
    for(let n=0;n<10;n++){
     const query=new URLSearchParams({type:'upcoming',page_size:'100'});if(page)query.set('next_page_token',page);
     const result=await call(input.staffId,`https://api.zoom.us/v2/users/me/meetings?${query}`,'GET',undefined,input.signal,accountId||undefined);
     if(!result||!result.response.ok)return {kind:'unknown'};
     accountId=result.accountId;
     const data=obj(await result.response.json());if(!Array.isArray(data.meetings))return {kind:'unknown'};
     for(const item of data.meetings){
      const candidate=obj(item);if(text(candidate.agenda)!==input.idempotencyKey)continue;
      const id=text(candidate.id)||(typeof candidate.id==='number'&&Number.isSafeInteger(candidate.id)?String(candidate.id):'');
      if(!id)return {kind:'unknown'};
      const detail=await call(input.staffId,`https://api.zoom.us/v2/meetings/${encodeURIComponent(id)}`,'GET',undefined,input.signal,accountId);
      if(!detail||!detail.response.ok)return {kind:'unknown'};
      const meeting=obj(await detail.response.json()),remoteId=text(meeting.id)||(typeof meeting.id==='number'&&Number.isSafeInteger(meeting.id)?String(meeting.id):''),url=text(meeting.join_url);
      if(remoteId!==id||text(meeting.agenda)!==input.idempotencyKey||!validUrl(provider,url)||found)return {kind:'unknown'};
      found={meetingId:packId(accountId,id),url};
     }
     if(data.next_page_token!==undefined&&typeof data.next_page_token!=='string')return {kind:'unknown'};
     page=text(data.next_page_token);if(!page)return found?{kind:'found',...found,idempotencyKey:input.idempotencyKey}:{kind:'absent'};
     if(seen.has(page))return {kind:'unknown'};seen.add(page);
    }
   }catch{return {kind:'unknown'};}
   return {kind:'unknown'};
  }
  // Graph の読み取り API は externalId での検索を提供しない。createOrGet は新規作成し得るため使わない。
  if(provider==='teams')return {kind:'unknown'};
  const id=await googleEventId(input.idempotencyKey);
  try{const result=await call(input.staffId,`https://www.googleapis.com/calendar/v3/calendars/primary/events/${id}`,'GET',undefined,input.signal);if(!result)return {kind:'unknown'};if(result.response.status===404)return {kind:'absent'};if(!result.response.ok)return {kind:'unknown'};
   const data=obj(await result.response.json()),privateData=obj(obj(data.extendedProperties).private);const key=text(privateData.bookingKey),meetingId=text(data.id),url=text(data.hangoutLink);
   return data.status!=='cancelled'&&key===input.idempotencyKey&&meetingId===id&&validUrl(provider,url)?{kind:'found',meetingId:packId(result.accountId,meetingId),url,idempotencyKey:key}:{kind:'unknown'};
  }catch{return {kind:'unknown'};}
 }
 async function verifyDelete(input:Parameters<MeetingVerifier['verifyDelete']>[0]):ReturnType<MeetingVerifier['verifyDelete']>{
  const identity=unpackId(input.meetingId);if(!identity)return 'unknown';
  const id=encodeURIComponent(identity[1]),url=provider==='google_meet'?`https://www.googleapis.com/calendar/v3/calendars/primary/events/${id}`:provider==='teams'?`https://graph.microsoft.com/v1.0/me/onlineMeetings/${id}`:`https://api.zoom.us/v2/meetings/${id}`;
  try{const result=await call(input.staffId,url,'GET',undefined,input.signal,identity[0]);if(!result)return 'unknown';const r=result.response;if(r.status===404||r.status===410)return 'deleted';if(!r.ok)return 'unknown';if(provider==='google_meet'&&obj(await r.json()).status==='cancelled')return 'deleted';return 'present';}catch{return 'unknown';}
 }
 return {provider,create,remove,verifyCreate,verifyDelete};
}
