import type { GoogleServiceAccountCredentials } from '../../services/google-service-account.js';
import type { BusyInterval } from '../../services/google-calendar.js';
import { GoogleCalendarReadError } from '../../services/google-calendar.js';
import { calendarDirectionEnabled } from './calendar-switch-state.js';
import { getStaffCalendarConnection, clientForConnection } from './calendar-connection.js';
export async function readGoogleCalendarBusy(db:D1Database,credentials:GoogleServiceAccountCredentials,input:{lineAccountId:string;staffId:string;timeMin:string;timeMax:string;fresh?:boolean}):Promise<BusyInterval[]|null> {
 if(!await calendarDirectionEnabled(db,input.lineAccountId,input.staffId,'read'))return null;
 const conn=await getStaffCalendarConnection(db,input.lineAccountId,input.staffId);
 if(!conn)return null; // 明示的な接続解除後は勤務の枠へ戻る。
 const health=await db.prepare('SELECT error_code FROM booking_calendar_read_health WHERE line_account_id=? AND staff_id=?').bind(input.lineAccountId,input.staffId).first<{error_code:string|null}>();
 if(!input.fresh&&health?.error_code==='calendar_disconnected')throw new GoogleCalendarReadError(403);
 const cache=await db.prepare('SELECT * FROM booking_calendar_busy_cache WHERE line_account_id=? AND staff_id=? AND connection_id=? AND calendar_id=?').bind(input.lineAccountId,input.staffId,conn.id,conn.calendar_id)
  .first<{busy_json:string;time_min:string;time_max:string;last_read_at:string}>();
 const usable=cache&&Date.parse(cache.last_read_at)>Date.now()-15*60000&&Date.parse(cache.time_min)<=Date.parse(input.timeMin)&&Date.parse(cache.time_max)>=Date.parse(input.timeMax);
 if(!input.fresh&&usable)return JSON.parse(cache.busy_json);
 try {
  const client=await clientForConnection(conn,credentials,{db,accountId:input.lineAccountId}),busy=await client.getTimedBusy(input.timeMin,input.timeMax);
  const own=new Set((await db.prepare('SELECT external_event_id FROM bookings WHERE line_account_id=? AND external_calendar_id=? AND external_event_id IS NOT NULL').bind(input.lineAccountId,conn.calendar_id).all<{external_event_id:string}>()).results.map(r=>r.external_event_id));
  if(credentials.cleanupEventIds)for(const id of await credentials.cleanupEventIds({lineAccountId:input.lineAccountId,staffId:input.staffId,calendarId:conn.calendar_id,connectionId:conn.id}))own.add(id);
  else if(await db.prepare("SELECT 1 FROM workflow_steps WHERE scope_id=? AND process_kind='booking_external_cleanup' LIMIT 1").bind(`line:${input.lineAccountId}`).first())throw new GoogleCalendarReadError(503);
  const intervals=busy.filter(r=>!own.has(r.id)).map(({start,end})=>({start,end}));
  await db.prepare(`INSERT INTO booking_calendar_busy_cache(line_account_id,staff_id,connection_id,calendar_id,time_min,time_max,busy_json,last_read_at)
   VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(line_account_id,staff_id) DO UPDATE SET connection_id=excluded.connection_id,calendar_id=excluded.calendar_id,
   time_min=excluded.time_min,time_max=excluded.time_max,busy_json=excluded.busy_json,last_read_at=excluded.last_read_at`)
   .bind(input.lineAccountId,input.staffId,conn.id,conn.calendar_id,input.timeMin,input.timeMax,JSON.stringify(intervals),new Date().toISOString()).run();
  await db.prepare(`INSERT INTO booking_calendar_read_health(line_account_id,staff_id,last_success_at) VALUES(?,?,?) ON CONFLICT(line_account_id,staff_id) DO UPDATE SET last_success_at=excluded.last_success_at,failed_since=CASE WHEN booking_calendar_read_health.error_code LIKE 'outlook_%' THEN booking_calendar_read_health.failed_since ELSE NULL END,error_code=CASE WHEN booking_calendar_read_health.error_code LIKE 'outlook_%' THEN booking_calendar_read_health.error_code ELSE NULL END`).bind(input.lineAccountId,input.staffId,new Date().toISOString()).run();
  return intervals;
 } catch(e) {
  await db.prepare(`INSERT INTO booking_calendar_read_health(line_account_id,staff_id,failed_since,error_code) VALUES(?,?,?,?) ON CONFLICT(line_account_id,staff_id) DO UPDATE SET failed_since=COALESCE(failed_since,excluded.failed_since),error_code=excluded.error_code`)
   .bind(input.lineAccountId,input.staffId,new Date().toISOString(),e instanceof GoogleCalendarReadError&&[401,403].includes(e.status)?'calendar_disconnected':'calendar_unavailable').run();
  if(!input.fresh&&usable&&!(e instanceof GoogleCalendarReadError&&[401,403].includes(e.status)))return JSON.parse(cache.busy_json);
  throw e;
 }
}

async function noteOutlookReadFailure(db:D1Database,input:{lineAccountId:string;staffId:string},code:string):Promise<void>{
 const now=new Date().toISOString();
 await db.prepare(`INSERT INTO booking_calendar_read_health(line_account_id,staff_id,failed_since,error_code) VALUES(?,?,?,?)
  ON CONFLICT(line_account_id,staff_id) DO UPDATE SET failed_since=COALESCE(failed_since,excluded.failed_since),error_code=excluded.error_code`)
  .bind(input.lineAccountId,input.staffId,now,code).run();
 await db.prepare(`INSERT OR IGNORE INTO notifications(id,event_type,title,body,channel,status,metadata,line_account_id,category)
  SELECT ?,'booking_outlook_read_issue','Outlook の空き確認が必要です',?,'dashboard','sent',?,line_account_id,'error' FROM staff WHERE id=? AND line_account_id=?`)
  .bind(`outlook-read:${JSON.stringify([input.lineAccountId,input.staffId])}`,code==='outlook_test_staff_required'?'担当者本人が試験送信先に登録されていないため、Outlook の予定を読めません。':'Outlook の予定を読めません。担当者の連携を確認してください。',JSON.stringify({staffId:input.staffId}),input.staffId,input.lineAccountId).run();
}

/** 接続されたカレンダーは両方の予定を除き、どちらかが読めない場合は空き扱いにしない。 */
export async function readCalendarBusy(db:D1Database,credentials:GoogleServiceAccountCredentials,input:{lineAccountId:string;staffId:string;timeMin:string;timeMax:string;fresh?:boolean}):Promise<BusyInterval[]|null> {
 if(!await calendarDirectionEnabled(db,input.lineAccountId,input.staffId,'read'))return null;
 const outlook=await db.prepare("SELECT id,refresh_state FROM booking_meeting_connections WHERE line_account_id=? AND staff_id=? AND provider='outlook'")
  .bind(input.lineAccountId,input.staffId).first<{id:string;refresh_state:string}>();
 const google=await readGoogleCalendarBusy(db,credentials,input);
 if(!outlook)return google;
 if(outlook.refresh_state==='unknown'){await noteOutlookReadFailure(db,input,'outlook_disconnected');throw new GoogleCalendarReadError(403);}
 const cache=await db.prepare("SELECT result_json,updated_at FROM workflow_steps WHERE scope_id=? AND process_kind='booking_outlook_busy' AND subject_id=? AND step_key='current' AND status='succeeded'")
  .bind(`line:${input.lineAccountId}`,input.staffId).first<{result_json:string|null;updated_at:number}>();
 let periods:BusyInterval[]|null=null;
 try{
  const saved=JSON.parse(cache?.result_json??'null') as {connectionId?:string;timeMin?:string;timeMax?:string;intervals?:unknown}|null;
  if(!input.fresh&&cache&&cache.updated_at>Date.now()-15*60000&&saved?.connectionId===outlook.id&&
   Date.parse(saved.timeMin??'')<=Date.parse(input.timeMin)&&Date.parse(saved.timeMax??'')>=Date.parse(input.timeMax)&&Array.isArray(saved.intervals)){
   const values=saved.intervals as Array<{start?:unknown;end?:unknown}>;
   if(values.every(value=>value&&typeof value.start==='string'&&typeof value.end==='string'&&Number.isFinite(Date.parse(value.start))&&Date.parse(value.start)<Date.parse(value.end)))periods=values as BusyInterval[];
  }
 }catch{/* 壊れた控えは使わない。 */}
 if(!periods){
  if(!credentials.outlookBusy){await noteOutlookReadFailure(db,input,'outlook_unavailable');throw new GoogleCalendarReadError(503);}
  try{periods=await credentials.outlookBusy(input);}catch(error){
   await noteOutlookReadFailure(db,input,error instanceof Error&&error.message==='outlook_test_staff_required'?'outlook_test_staff_required':'outlook_unavailable');
   throw new GoogleCalendarReadError(503);
  }
 }
 if(!Array.isArray(periods)||!periods.every(value=>value&&typeof value.start==='string'&&typeof value.end==='string'&&Number.isFinite(Date.parse(value.start))&&Date.parse(value.start)<Date.parse(value.end))){await noteOutlookReadFailure(db,input,'outlook_unavailable');throw new GoogleCalendarReadError(503);}
 await db.prepare("UPDATE booking_calendar_read_health SET error_code=NULL,failed_since=NULL,last_success_at=? WHERE line_account_id=? AND staff_id=? AND error_code LIKE 'outlook_%'").bind(new Date().toISOString(),input.lineAccountId,input.staffId).run();
 return [...(google??[]),...periods];
}
