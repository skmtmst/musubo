import { tracedFetch as fetch } from '@line-crm/shared/server';
import { API_RETRY_WAIT, createCallState, createExternalCall } from '../lib/external-call/index.js';
import { type CallScope, type CircuitStore } from '../lib/external-call/types.js';
import { boundedHttpRequest } from '../lib/external-call/bounded-http.js';


const GCAL_BASE = 'https://www.googleapis.com/calendar/v3';
const TIMEZONE = 'Asia/Tokyo';

export interface GoogleCalendarConfig {
  calendarId: string;
  accessToken: string;
  transport?: typeof fetch;
  external?: {scope:CallScope;circuits:CircuitStore};
}

export interface BusyInterval {
  start: string;
  end: string;
}

export class GoogleCalendarReadError extends Error {
  constructor(readonly status: number) { super('calendar_read_failed'); }
}

export class GoogleCalendarWriteError extends Error {
  constructor(readonly status: number) { super('calendar_write_failed'); this.name = 'GoogleCalendarWriteError'; }
}
export interface CalendarEventEvidence {
  id: string; summary?: string; description?: string;
  start?: { dateTime?: string }; end?: { dateTime?: string };
}

export interface CreateEventInput {
  summary: string;
  start: string;   // ISO 形式の日時。
  end: string;     // ISO 形式の日時。
  description?: string;
  // こちらで採番したイベント ID。渡すと Google 側もこの ID で登録される。
  // 外部作成とDB保存の間で障害が起きても再送が別 ID を生まない。
  id?: string;
}

export class GoogleCalendarClient {
  constructor(private config: GoogleCalendarConfig) {}

  /** 単発の通信。本文の読取りまで同じ期限とsignalを使い、SDK内では再試行しない。 */
  private async request<T>(url: string, init: RequestInit, read: (response: Response) => Promise<T>, signal?: AbortSignal, effect: 'read'|'write' = 'read'): Promise<T> {
    const perform=async(deadlineSignal?:AbortSignal)=>{
      const response=await boundedHttpRequest(url,{...init,signal:deadlineSignal},
        {timeoutMs:10_000,maxResponseBytes:1024*1024,fetch:this.config.transport??fetch});
      return await read(response);
    };
    if(effect==='write'||!this.config.external)return perform(signal);
    // 読取りだけの単発予算。業務の書込みは呼出し側の永続journalを通す。
    const now=Date.now(),id=crypto.randomUUID(),context=this.config.external;
    let state=createCallState({scope:context.scope,operationId:id,idempotencyKey:id,snapshotId:id,effect:'read'},
      {category:'api',maxAttempts:1,timeoutMs:10_000,deadlineAt:now+10_000,wait:API_RETRY_WAIT},now);
    const outcome=await createExternalCall({circuits:context.circuits})<T>({state,signal,
      journal:{compareAndSwap:async(previous,next)=>{if(previous.revision!==state.revision)return false;state=structuredClone(next);return true;}},
      authorize:async()=>true,
      execute:async deadlineSignal=>{
        try{return {kind:'success',value:await perform(deadlineSignal)};}
        catch(error){return error instanceof GoogleCalendarReadError
          ? {kind:error.status===408||error.status===429||error.status>=500?'transient':'permanent',reason:'http',status:error.status}
          : {kind:'transient',reason:'network'};}
      },
    });
    if(outcome.kind==='success')return outcome.value;
    throw new GoogleCalendarReadError(outcome.state.status??503);
  }

  private json<T>(url: string, init: RequestInit): Promise<T> {
    return this.request(url,init,async response=>{
      if(!response.ok){void response.body?.cancel().catch(()=>{});throw new GoogleCalendarReadError(response.status);}
      return await response.json().catch(()=>{throw new GoogleCalendarReadError(502);}) as T;
    });
  }

  /** 不明な書込みを同じIDの読取りで照合する。予定は増やさない。 */
  async getEvent(eventId: string): Promise<CalendarEventEvidence | null> {
    return this.request(`${GCAL_BASE}/calendars/${encodeURIComponent(this.config.calendarId)}/events/${encodeURIComponent(eventId)}`,
      { headers: { Authorization: `Bearer ${this.config.accessToken}` } }, async res => {
        if (res.status === 404 || res.status === 410) return null;
        if (!res.ok) throw new GoogleCalendarReadError(res.status);
        return await res.json() as CalendarEventEvidence;
      });
  }

  /** 顧客削除後の予定処理。参加者が無いことと版を確かめ、通知を抑止する。 */
  async cleanupEvent(eventId:string,action:'delete'|'redact',signal?:AbortSignal,authorize?:()=>Promise<boolean>):Promise<'done'|'retry'|'review'> {
    const base=`${GCAL_BASE}/calendars/${encodeURIComponent(this.config.calendarId)}/events/${encodeURIComponent(eventId)}`;
    let evidence:{id?:unknown;status?:unknown;etag?:unknown;attendees?:unknown;attendeesOmitted?:unknown;organizer?:{self?:unknown}};
    try {
      const result=await this.request(`${base}?fields=id,status,etag,attendees,attendeesOmitted,organizer(self)`,{headers:{Authorization:`Bearer ${this.config.accessToken}`}},async res=>{
        if(res.status===404||res.status===410)return null;
        if(!res.ok)throw new GoogleCalendarReadError(res.status);
        return await res.json() as typeof evidence;
      },signal);
      if(result===null)return !authorize||await authorize()?'done':'review';
      evidence=result;
    }catch(error){return error instanceof GoogleCalendarReadError && error.status>=400 && error.status<500 && error.status!==408 && error.status!==429?'review':'retry';}
    // Google can retain event details even when status is cancelled; do not assume personal data is gone.
    if(evidence.status!==undefined&&evidence.status!=='confirmed'&&evidence.status!=='tentative')return 'review';
    if(evidence.id!==eventId||typeof evidence.etag!=='string'||!evidence.etag||evidence.organizer?.self!==true||(evidence.attendeesOmitted!==undefined&&evidence.attendeesOmitted!==false)||(evidence.attendees!==undefined&&(!Array.isArray(evidence.attendees)||evidence.attendees.length!==0)))return 'review';
    try {
      if(authorize && !await authorize())return 'review';
      return await this.request(`${base}?sendUpdates=none`,{method:action==='delete'?'DELETE':'PATCH',headers:{Authorization:`Bearer ${this.config.accessToken}`,'Content-Type':'application/json','If-Match':evidence.etag},...(action==='redact'?{body:JSON.stringify({summary:'予約',description:''})}:{})},async res=>{
        if(res.ok||res.status===404||res.status===410)return 'done' as const;
        void res.body?.cancel().catch(()=>{});
        return 'review' as const;
      },signal,'write');
    }catch{return 'review';}
  }

  /** 件数は FreeBusy の結合された区間数ではなく、個々の予定から数える。 */
  async listEventIds(timeMin: string, timeMax: string): Promise<string[]> {
    const ids: string[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 100; page++) {
      const query = new URLSearchParams({ timeMin, timeMax, singleEvents: 'true', showDeleted: 'false', maxResults: '2500', fields: 'items(id,status),nextPageToken' });
      if (pageToken) query.set('pageToken', pageToken);
      const data = await this.json<{ items?: Array<{ id: string; status?: string }>; nextPageToken?: string }>(
        `${GCAL_BASE}/calendars/${encodeURIComponent(this.config.calendarId)}/events?${query}`,
        {headers:{Authorization:`Bearer ${this.config.accessToken}`}});
      ids.push(...(data.items ?? []).filter((event) => event.status !== 'cancelled').map((event) => event.id));
      pageToken = data.nextPageToken;
      if (!pageToken) return [...new Set(ids)];
    }
    throw new GoogleCalendarReadError(502);
  }

  /** 題名・参加者・本文を要求しない。終日とfreeは予約枠を塞がない。 */
  async getTimedBusy(timeMin:string,timeMax:string):Promise<Array<BusyInterval & {id:string}>> {
    const result:Array<BusyInterval & {id:string}>=[];let token:string|undefined;
    for(let page=0;page<100;page++) {
      const query=new URLSearchParams({timeMin,timeMax,singleEvents:'true',maxResults:'2500',fields:'items(id,status,transparency,start(dateTime),end(dateTime)),nextPageToken'});
      if(token)query.set('pageToken',token);
      const data=await this.json<{items?:Array<{id:string;status?:string;transparency?:string;start?:{dateTime?:string};end?:{dateTime?:string}}>;nextPageToken?:string}>(
        `${GCAL_BASE}/calendars/${encodeURIComponent(this.config.calendarId)}/events?${query}`,
        {headers:{Authorization:`Bearer ${this.config.accessToken}`}});
      if(!Array.isArray(data.items))throw new GoogleCalendarReadError(502);
      for(const e of data.items){if(e.status==='cancelled'||e.transparency==='transparent'||!e.start?.dateTime||!e.end?.dateTime)continue;
        if(!e.id||!Number.isFinite(Date.parse(e.start.dateTime))||!Number.isFinite(Date.parse(e.end.dateTime))||Date.parse(e.end.dateTime)<=Date.parse(e.start.dateTime))throw new GoogleCalendarReadError(502);
        result.push({id:e.id,start:e.start.dateTime,end:e.end.dateTime});}
      token=data.nextPageToken;if(!token)return result;
    }
    throw new GoogleCalendarReadError(502);
  }


  async getFreeBusy(timeMin: string, timeMax: string): Promise<BusyInterval[]> {
    const url = `${GCAL_BASE}/freeBusy`;
    const body = {
      timeMin,
      timeMax,
      items: [{ id: this.config.calendarId }],
    };

    const data=await this.json<{calendars?:Record<string,{errors?:unknown;busy?:unknown}>}|null>(url,{
      method:'POST',headers:{Authorization:`Bearer ${this.config.accessToken}`,'Content-Type':'application/json'},body:JSON.stringify(body),
    });
    const calendar = data?.calendars?.[this.config.calendarId];
    // HTTP200でもカレンダー単位の失敗がある。未取得を「予定なし」にしない。
    if (!calendar || (calendar.errors !== undefined
      && (!Array.isArray(calendar.errors) || calendar.errors.length > 0))
      || !Array.isArray(calendar.busy)) throw new GoogleCalendarReadError(502);
    return calendar.busy.map((interval: unknown) => {
      if (!interval || typeof interval !== 'object') throw new GoogleCalendarReadError(502);
      const { start, end } = interval as Partial<BusyInterval>;
      if (typeof start !== 'string' || typeof end !== 'string'
        || !Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end))
        || Date.parse(end) <= Date.parse(start)) throw new GoogleCalendarReadError(502);
      return { start, end };
    });
  }


  async createEvent(event: CreateEventInput, signal?: AbortSignal): Promise<{ eventId: string }> {
    const url = `${GCAL_BASE}/calendars/${encodeURIComponent(this.config.calendarId)}/events`;

    const body = {
      summary: event.summary,
      description: event.description,
      start: { dateTime: event.start, timeZone: TIMEZONE },
      end: { dateTime: event.end, timeZone: TIMEZONE },
      ...(event.id ? { id: event.id } : {}),
    };

    return this.request(url, {
      method: 'POST', headers: { Authorization: `Bearer ${this.config.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, async res => {
      // 409だけで元の予定と断定しない。呼出し元がGETで固定IDと内容を照合する。
      if (!res.ok) { void res.body?.cancel().catch(() => {}); throw new GoogleCalendarWriteError(res.status); }
      const data = await res.json() as { id?: string };
      if (!data.id) throw new GoogleCalendarWriteError(502);
      return { eventId: data.id };
    }, signal, 'write');
  }


  async deleteEvent(eventId: string, signal?: AbortSignal): Promise<void> {
    const url = `${GCAL_BASE}/calendars/${encodeURIComponent(this.config.calendarId)}/events/${encodeURIComponent(eventId)}`;

    return this.request(url, { method: 'DELETE', headers: { Authorization: `Bearer ${this.config.accessToken}` } }, async res => {
      if (!res.ok && res.status !== 410 && res.status !== 404) {
        void res.body?.cancel().catch(() => {});
        throw new GoogleCalendarWriteError(res.status);
      }
    }, signal, 'write');
  }
}
