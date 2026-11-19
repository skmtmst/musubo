/** Outlook は予定の題名や参加者を取得しない。読み取り失敗は例外にし、空き扱いにしない。 */
export interface OutlookBusy {start:string;end:string;eventId:string}
export class OutlookCalendarError extends Error {constructor(){super('outlook_calendar_unavailable');}}
export function outlookCalendar(tokenForStaff:(staffId:string)=>Promise<string|null>,request:typeof fetch=fetch) {
 async function busy(input:{staffId:string;start:string;end:string;ownEventIds:string[];signal:AbortSignal}):Promise<OutlookBusy[]> {
  const token=await tokenForStaff(input.staffId);if(!token)throw new OutlookCalendarError();
  const from=Date.parse(input.start),to=Date.parse(input.end);if(!Number.isFinite(from)||!Number.isFinite(to)||from>=to)throw new OutlookCalendarError();
  const url=new URL('https://graph.microsoft.com/v1.0/me/calendarView');
  url.searchParams.set('startDateTime',new Date(from).toISOString());url.searchParams.set('endDateTime',new Date(to).toISOString());
  url.searchParams.set('$select','id,start,end,showAs,isAllDay');url.searchParams.set('$top','100');
  const result:OutlookBusy[]=[];let next:string|null=url.toString();let page=0;
  while(next){
   const u=new URL(next);if(u.protocol!=='https:'||u.hostname!=='graph.microsoft.com'||u.pathname!=='/v1.0/me/calendarView'||++page>20)throw new OutlookCalendarError();
   let r:Response;try{r=await request(u.toString(),{headers:{Authorization:`Bearer ${token}`,Prefer:'outlook.timezone="UTC", IdType="ImmutableId"'},signal:input.signal});}catch{throw new OutlookCalendarError();}
   if(!r.ok)throw new OutlookCalendarError();
   let raw:unknown;try{raw=await r.json();}catch{throw new OutlookCalendarError();}
   if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new OutlookCalendarError();
   const data=raw as Record<string,unknown>;if(!Array.isArray(data.value))throw new OutlookCalendarError();
   for(const entry of data.value){
    if(!entry||typeof entry!=='object'||Array.isArray(entry))throw new OutlookCalendarError();
    const event=entry as Record<string,unknown>;if(typeof event.id!=='string'||typeof event.isAllDay!=='boolean'||typeof event.showAs!=='string')throw new OutlookCalendarError();
    // B7 A-1: 終日の予定と予定なしは塞がない。
    if(event.isAllDay||event.showAs==='free'||input.ownEventIds.includes(event.id))continue;
    const start=event.start as {dateTime?:unknown;timeZone?:unknown}|null,end=event.end as {dateTime?:unknown;timeZone?:unknown}|null;
    if(!start||!end||start.timeZone!=='UTC'||end.timeZone!=='UTC'||typeof start.dateTime!=='string'||typeof end.dateTime!=='string')throw new OutlookCalendarError();
    const a=Date.parse(`${start.dateTime}Z`),b=Date.parse(`${end.dateTime}Z`);if(!Number.isFinite(a)||!Number.isFinite(b)||a>=b)throw new OutlookCalendarError();
    result.push({start:new Date(a).toISOString(),end:new Date(b).toISOString(),eventId:event.id});
   }
   const n=data['@odata.nextLink'];if(n!==undefined&&typeof n!=='string')throw new OutlookCalendarError();next=typeof n==='string'?n:null;
  }
  return result;
 }
 /** 予定作成は安定した transactionId を使い、参加者を含めない。 */
 async function create(input:{staffId:string;calendarId:string;start:string;end:string;title:string;description:string;transactionId:string;signal:AbortSignal}):Promise<{kind:'created';eventId:string}|{kind:'failed'}|{kind:'unknown'}> {
  let token:string|null;try{token=await tokenForStaff(input.staffId);}catch{return {kind:'failed'};}if(!token)return {kind:'failed'};
  if(!input.calendarId||!input.transactionId||!input.title||!Number.isFinite(Date.parse(input.start))||!Number.isFinite(Date.parse(input.end))||Date.parse(input.start)>=Date.parse(input.end))return {kind:'failed'};
  const id=encodeURIComponent(input.calendarId);
  const event={subject:input.title,body:{contentType:'text',content:input.description},start:{dateTime:new Date(input.start).toISOString().slice(0,-1),timeZone:'UTC'},end:{dateTime:new Date(input.end).toISOString().slice(0,-1),timeZone:'UTC'},transactionId:input.transactionId};
  try {
   const response=await request(`https://graph.microsoft.com/v1.0/me/calendars/${id}/events`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',Prefer:'IdType="ImmutableId"'},body:JSON.stringify(event),signal:input.signal});
   if(!response.ok)return response.status>=400&&response.status<500&&![408,409].includes(response.status)?{kind:'failed'}:{kind:'unknown'};
   const data:unknown=await response.json();
   if(!data||typeof data!=='object'||Array.isArray(data)||typeof (data as Record<string,unknown>).id!=='string'||!(data as Record<string,string>).id)return {kind:'unknown'};
   return {kind:'created',eventId:(data as Record<string,string>).id};
  }catch{return {kind:'unknown'};}
 }
 return {busy,create};
}
