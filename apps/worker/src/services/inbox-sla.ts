import {getAccountTimeZone,tzDateStr} from './availability.js';
import { accountOpeningHours, openingDay } from './account-opening-hours.js';
export interface SlaSettings {enabled:boolean;firstResponseMinutes:number;businessHoursOnly:boolean;version:number;escalateTeamId:string|null}
export async function inboxSlaSettings(db:D1Database,account:string):Promise<SlaSettings> {
 const r=await db.prepare('SELECT * FROM inbox_routing_settings WHERE account_id=?').bind(account).first<Record<string,unknown>>();
 return {enabled:!!r?.sla_enabled,firstResponseMinutes:Number(r?.sla_first_response_minutes??30),businessHoursOnly:r?.sla_business_hours_only!==0,version:Number(r?.version??0),escalateTeamId:r?.escalate_team_id as string??null};
}
function utc(tz:string,date:string,time:string) {
 const desired=Date.parse(`${date}T${time}:00Z`);let guess=desired;
 for(let i=0;i<4;i++) {const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(guess).map(p=>[p.type,p.value]));guess+=desired-Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute,+p.second);}
 return guess;
}
export async function businessWindows(db:D1Database,account:string,from:string) {
 const source=await accountOpeningHours(db,account);
 const settings=await db.prepare('SELECT id,business_hours_configured FROM booking_settings WHERE line_account_id=?').bind(account).first<{id:string;business_hours_configured:number}>();
 const hours=settings?.business_hours_configured ? (await db.prepare('SELECT weekday,start_time,end_time FROM booking_business_hours WHERE booking_settings_id=?').bind(settings.id).all<{weekday:number;start_time:string;end_time:string}>()).results
  : Array.from({length:7},(_,weekday)=>({weekday,start_time:'09:00',end_time:'18:00'}));
 const holidays=new Set((await db.prepare('SELECT date FROM style_holidays WHERE line_account_id=?').bind(account).all<{date:string}>()).results.map(r=>r.date));
 const exceptions=(await db.prepare("SELECT date_from,date_to,kind,hours_json FROM booking_availability_exceptions WHERE line_account_id=? AND scope_kind='store'").bind(account).all<{date_from:string;date_to:string;kind:string;hours_json:string}>()).results;
 const tz=await getAccountTimeZone(db,account),day=Date.parse(`${tzDateStr(tz,new Date(from))}T00:00:00Z`),windows:Array<[number,number]>=[];
 for(let n=0;n<370;n++) {const d=new Date(day+n*86400000),date=d.toISOString().slice(0,10);if(source.source==='manual'&&holidays.has(date))continue;
  const ex=source.source==='manual'?exceptions.find(e=>e.date_from<=date&&date<=e.date_to):null;if(ex?.kind==='closed')continue;
  const google=openingDay(source,date);
  const intervals=google!==null?google.map(h=>({start_time:h.start,end_time:h.end})):ex?.kind==='custom_hours' ? (JSON.parse(ex.hours_json) as Array<{start:string;end:string}>).map(h=>({start_time:h.start,end_time:h.end})) : hours.filter(h=>h.weekday===d.getUTCDay());
  for(const h of intervals) windows.push([utc(tz,date,h.start_time),utc(tz,date,h.end_time)]);
 }
 return windows.sort((a,b)=>a[0]-b[0]);
}
export function slaDeadline(start:string,minutes:number,windows:Array<[number,number]>|null):string|null {
 const at=Date.parse(start);let remaining=minutes*60000;
 if(!windows) return new Date(at+remaining).toISOString();
 for(const [open,close] of windows){const begin=Math.max(at,open);if(close<=begin)continue;const duration=close-begin;if(remaining<=duration)return new Date(begin+remaining).toISOString();remaining-=duration;}
 return null; // 全休なら架空の期限を作らない。
}
export function slaState(due:string|null,enabled:boolean,responded:unknown,now=Date.now(),windows:Array<[number,number]>|null=null) {
 if(!enabled||responded)return 'none';
 if(windows&&!windows.some(([s,e])=>s<=now&&now<e))return 'outside_hours';
 if(!due)return 'none';const delta=Date.parse(due)-now;return delta<=0?'overdue':delta<=15*60000?'soon':'ok';
}
export async function refreshInboxSla(db:D1Database,account:string) {
 const settings=await inboxSlaSettings(db,account);
 if(!settings.enabled)return;
 const rows=(await db.prepare(`SELECT c.id,c.pending_since FROM chats c JOIN friends f ON f.id=c.friend_id
   WHERE f.line_account_id=? AND c.pending_since IS NOT NULL AND c.first_response_at IS NULL AND c.sla_due_at IS NULL AND c.status!='resolved' LIMIT 500`).bind(account).all<{id:string;pending_since:string}>()).results;
 if(!rows.length)return;
 const earliest=rows.reduce((v,r)=>Date.parse(r.pending_since)<Date.parse(v)?r.pending_since:v,rows[0].pending_since);
 const windows=settings.businessHoursOnly?await businessWindows(db,account,earliest):null;
 await db.batch(rows.map(r=>db.prepare('UPDATE chats SET sla_due_at=? WHERE id=? AND pending_since=? AND first_response_at IS NULL AND sla_due_at IS NULL')
  .bind(slaDeadline(r.pending_since,settings.firstResponseMinutes,windows),r.id,r.pending_since)));
}
export async function processInboxSla(db:D1Database,now=new Date()) {
 const accounts=(await db.prepare(`SELECT s.account_id FROM inbox_routing_settings s JOIN line_accounts a ON a.id=s.account_id WHERE s.sla_enabled=1 AND a.is_active=1`).all<{account_id:string}>()).results;
 for(const {account_id:account} of accounts){await refreshInboxSla(db,account);
 const rows=(await db.prepare(`SELECT c.id,c.friend_id,c.assignee_staff_id AS operator_id,c.pending_since,c.sla_due_at,c.sla_notified_stage,s.escalate_team_id
   FROM chats c JOIN friends f ON f.id=c.friend_id JOIN inbox_routing_settings s ON s.account_id=f.line_account_id
   WHERE f.line_account_id=? AND c.first_response_at IS NULL AND c.status!='resolved' AND c.sla_due_at IS NOT NULL
    AND julianday(c.sla_due_at)<=julianday(?)+15.0/1440 LIMIT 500`).bind(account,now.toISOString())
  .all<{id:string;friend_id:string;operator_id:string|null;pending_since:string;sla_due_at:string;sla_notified_stage:number;escalate_team_id:string|null}>()).results;
 for(const r of rows){const minutes=(now.getTime()-Date.parse(r.sla_due_at))/60000,stage=minutes>=30?3:minutes>=0?2:1;if(stage<=r.sla_notified_stage)continue;
  const notificationId=`sla:${r.id}:${r.pending_since}:${stage}`;
  await db.batch([
   db.prepare(`INSERT OR IGNORE INTO notifications(id,event_type,title,body,channel,status,metadata,line_account_id,category)
    SELECT ?,'inbox_sla',?,'受信箱で会話を確認してください','in_app','sent',?,?,'info' FROM chats
    WHERE id=? AND sla_notified_stage=? AND pending_since=? AND first_response_at IS NULL AND status!='resolved'`)
    .bind(notificationId,stage===1?'返事の期限が近づいています':'返事の期限を過ぎています',JSON.stringify({chatId:r.friend_id,staffId:r.operator_id,teamId:stage===3?r.escalate_team_id:null,stage}),account,r.id,r.sla_notified_stage,r.pending_since),
   db.prepare('UPDATE chats SET sla_notified_stage=? WHERE id=? AND pending_since=? AND first_response_at IS NULL AND EXISTS(SELECT 1 FROM notifications WHERE id=?)')
    .bind(stage,r.id,r.pending_since,notificationId)
  ]);
 }
 }
}
