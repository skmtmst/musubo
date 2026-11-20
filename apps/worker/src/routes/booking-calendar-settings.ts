import {Hono,type Context} from 'hono';
import type { Env } from '../worker-env.js';
import {gapAccount,gapBody,gapKey,gapVersion,gapWrite,GapError} from '../services/gap-common.js';
import {calendarSwitch,validMeetingUrl} from '../features/booking/booking-calendar-settings/index.js';
import {outlookStaffIsTestRecipient} from '../features/booking/booking-outlook-busy-runtime/index.js';
import {bookingChannelBounds} from '../features/booking/booking-channels/index.js';
import {getAccountTimeZone} from '../services/availability.js';
import {BOOKING_STAFF_OWN_KEY} from '@line-crm/shared';
import {auditLog} from '../lib/audit-log.js';
import {meetingCreatorForBooking} from '../features/booking/booking-meeting-runtime/index.js';
import {retryFailedMeeting} from '../features/booking/booking-meeting-retry.js';
import {featureJobCanRun} from '../services/feature-enforcement.js';
export const bookingCalendarSettings=new Hono<Env>();
bookingCalendarSettings.onError((e,c)=>c.json({success:false,error:e instanceof GapError?e.code:'calendar_settings_unavailable'},e instanceof GapError?e.status:503));
async function staffTarget(c:Context<Env>,account:string,id:string,write:boolean){
 const s=await c.env.DB.prepare('SELECT staff_member_id FROM staff WHERE id=? AND line_account_id=? AND deleted_at IS NULL').bind(id,account).first<{staff_member_id:string|null}>();
 if(!s)throw new GapError('not_found',404);
 const me=c.get('staff');if(write&&me.role==='staff'&&(s.staff_member_id!==me.id||!me.permissionKeys?.includes(BOOKING_STAFF_OWN_KEY)))throw new GapError('forbidden',403);
}
async function switches(c:Context<Env>,id='') {
 const account=await gapAccount(c);if(id)await staffTarget(c,account,id,c.req.method!=='GET');
 const before=await calendarSwitch(c.env.DB,account,id),cutoff=bookingChannelBounds(await getAccountTimeZone(c.env.DB,account),new Date()).todayTo;
 if(c.req.method==='GET') {
  const store=await calendarSwitch(c.env.DB,account),connection=id?await c.env.DB.prepare("SELECT id FROM google_calendar_connections WHERE line_account_id=? AND staff_id=? AND is_active=1 UNION ALL SELECT id FROM booking_meeting_connections WHERE line_account_id=? AND staff_id=? AND provider='outlook' LIMIT 1").bind(account,id,account,id).first():null;
  const health=id?await c.env.DB.prepare('SELECT last_success_at,failed_since,error_code FROM booking_calendar_read_health WHERE line_account_id=? AND staff_id=?').bind(account,id).first():null;
  const pending=await c.env.DB.prepare("SELECT COALESCE(SUM(status='pending'),0) pending,COALESCE(SUM(status='failed'),0) failed FROM booking_calendar_switch_jobs WHERE line_account_id=? AND (?='' OR staff_id=?)").bind(account,id,id).first();
  const future=await c.env.DB.prepare("SELECT COUNT(*) n FROM bookings WHERE line_account_id=? AND (?='' OR staff_id=?) AND starts_at>=? AND status='confirmed' AND (external_event_id IS NOT NULL OR EXISTS(SELECT 1 FROM workflow_steps w WHERE w.scope_id='line:'||bookings.line_account_id AND w.process_kind='booking_outlook_sync' AND w.subject_id=bookings.id AND w.step_key='current' AND json_extract(w.result_json,'$.eventId') IS NOT NULL))").bind(account,id,id,cutoff).first<{n:number}>();
  return c.json({success:true,data:{...before,effectiveReadEnabled:store.readEnabled&&before.readEnabled,effectiveWriteEnabled:store.writeEnabled&&before.writeEnabled,connected:!!connection,health,jobs:pending,futureEventCount:future?.n??0}});
 }
 gapWrite(c,{admin:!id});const b=await gapBody(c),v=gapVersion(b.expectedVersion);
 if(typeof b.readEnabled!=='boolean'||typeof b.writeEnabled!=='boolean'||(b.removeFutureEvents!==undefined&&typeof b.removeFutureEvents!=='boolean')||(b.includeBacklog!==undefined&&typeof b.includeBacklog!=='boolean'))throw new GapError('invalid_switches');
 if((before.readEnabled&&!b.readEnabled||before.writeEnabled&&!b.writeEnabled)&&b.confirmed!==true)throw new GapError('confirmation_required');
 if(id&&(b.readEnabled||b.writeEnabled)){
  const google=await c.env.DB.prepare('SELECT id FROM google_calendar_connections WHERE line_account_id=? AND staff_id=? AND is_active=1').bind(account,id).first();
  const outlook=await c.env.DB.prepare("SELECT id,refresh_state FROM booking_meeting_connections WHERE line_account_id=? AND staff_id=? AND provider='outlook'").bind(account,id).first<{id:string;refresh_state:string}>();
  if(b.readEnabled&&outlook&&!await outlookStaffIsTestRecipient(c.env.DB,{lineAccountId:account,staffId:id}))throw new GapError('outlook_test_staff_required',409);
  if(b.readEnabled&&outlook?.refresh_state==='unknown')throw new GapError('outlook_reconnect_required',409);
  if(b.readEnabled&&!google&&!outlook)throw new GapError('calendar_not_connected',409);
  if(b.writeEnabled&&!google&&(!outlook||outlook.refresh_state==='unknown'))throw new GapError('calendar_not_connected',409);
 }
 if(!id&&b.readEnabled){
  const staff=await c.env.DB.prepare(`SELECT c.staff_id FROM booking_meeting_connections c JOIN booking_calendar_switches s
   ON s.line_account_id=c.line_account_id AND s.scope_id=c.staff_id AND s.read_enabled=1
   WHERE c.line_account_id=? AND c.provider='outlook'`).bind(account).all<{staff_id:string}>();
  for(const row of staff.results??[])if(!await outlookStaffIsTestRecipient(c.env.DB,{lineAccountId:account,staffId:row.staff_id}))throw new GapError('outlook_test_staff_required',409);
 }
 const token=crypto.randomUUID(),now=new Date().toISOString();
 const ops=[c.env.DB.prepare(`INSERT INTO booking_calendar_switches(line_account_id,scope_id,read_enabled,write_enabled,updated_by,updated_at,mutation_token)
  SELECT ?,?,?,?,?,?,? WHERE ?=0 OR EXISTS(SELECT 1 FROM booking_calendar_switches WHERE line_account_id=? AND scope_id=? AND version=?)
  ON CONFLICT(line_account_id,scope_id) DO UPDATE SET read_enabled=excluded.read_enabled,write_enabled=excluded.write_enabled,version=version+1,updated_by=excluded.updated_by,updated_at=excluded.updated_at,mutation_token=excluded.mutation_token WHERE version=?`)
 .bind(account,id,b.readEnabled?1:0,b.writeEnabled?1:0,c.get('staff').id,now,token,v,account,id,v,v),
 c.env.DB.prepare(`INSERT INTO booking_calendar_switch_audit(id,line_account_id,scope_id,actor_id,before_json,after_json,created_at)
  SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM booking_calendar_switches WHERE line_account_id=? AND scope_id=? AND mutation_token=?)`)
 .bind(token,account,id,c.get('staff').id,JSON.stringify(before),JSON.stringify(b),now,account,id,token)];
 if(b.writeEnabled || b.removeFutureEvents===true)ops.push(c.env.DB.prepare(`INSERT OR IGNORE INTO booking_calendar_switch_jobs(id,line_account_id,staff_id,booking_id,action,external_event_id,calendar_id,switch_scope,switch_version,created_at)
  SELECT lower(hex(randomblob(16))),line_account_id,staff_id,id,?,external_event_id,external_calendar_id,?,?,? FROM bookings
  WHERE line_account_id=? AND (?='' OR staff_id=?) AND starts_at>=? AND status='confirmed'
   AND (?=1 OR external_event_id IS NOT NULL) AND ?=1
   AND EXISTS(SELECT 1 FROM booking_calendar_switches WHERE line_account_id=? AND scope_id=? AND mutation_token=?)`)
 .bind(b.writeEnabled?'write':'delete',id,v+1,now,account,id,id,cutoff,b.writeEnabled?1:0,b.writeEnabled?b.includeBacklog===true?1:0:1,account,id,token));
 if(b.writeEnabled || b.removeFutureEvents===true)ops.push(c.env.DB.prepare(`INSERT OR IGNORE INTO booking_calendar_switch_jobs(id,line_account_id,staff_id,booking_id,action,external_event_id,calendar_id,switch_scope,switch_version,created_at)
  SELECT lower(hex(randomblob(16))),b.line_account_id,b.staff_id,b.id,?,NULL,NULL,'outlook:'||?, ?,? FROM bookings b
  WHERE b.line_account_id=? AND (?='' OR b.staff_id=?) AND b.starts_at>=? AND b.status='confirmed'
   AND (?=1 OR EXISTS(SELECT 1 FROM workflow_steps w WHERE w.scope_id='line:'||b.line_account_id AND w.process_kind='booking_outlook_sync' AND w.subject_id=b.id AND w.step_key='current' AND json_extract(w.result_json,'$.eventId') IS NOT NULL))
   AND EXISTS(SELECT 1 FROM booking_meeting_connections c WHERE c.line_account_id=b.line_account_id AND c.staff_id=b.staff_id AND c.provider='outlook')
   AND ?=1 AND EXISTS(SELECT 1 FROM booking_calendar_switches WHERE line_account_id=? AND scope_id=? AND mutation_token=?)`)
 .bind(b.writeEnabled?'write':'delete',id,v+1,now,account,id,id,cutoff,b.writeEnabled?1:0,b.writeEnabled?b.includeBacklog===true?1:0:1,account,id,token));
 const r=await c.env.DB.batch(ops);if(!r[0].meta.changes)throw new GapError('version_conflict',409);
 return c.json({success:true,data:await calendarSwitch(c.env.DB,account,id)});
}
bookingCalendarSettings.on(['GET','PUT'],'/api/booking/admin/calendar-sync',c=>switches(c));
bookingCalendarSettings.on(['GET','PUT'],'/api/booking/admin/staff/:id/calendar-sync',c=>switches(c,c.req.param('id')));
bookingCalendarSettings.on(['GET','PUT'],'/api/booking/admin/staff/:id/meeting-url',async (c:Context<Env>):Promise<Response>=>{
 const account=await gapAccount(c),id=c.req.param('id')!;await staffTarget(c,account,id,c.req.method!=='GET');
 if(c.req.method==='GET')return c.json({success:true,data:await c.env.DB.prepare('SELECT fixed_meeting_url url,meeting_url_version version FROM staff WHERE id=? AND line_account_id=?').bind(id,account).first()});
 gapWrite(c);const b=await gapBody(c);if(!validMeetingUrl(b.url)||!Number.isSafeInteger(b.expectedVersion))throw new GapError('invalid_meeting_url');
 const r=await c.env.DB.prepare("UPDATE staff SET fixed_meeting_url=?,updated_at=?,meeting_url_version=meeting_url_version+1 WHERE id=? AND line_account_id=? AND meeting_url_version=?").bind(b.url,new Date().toISOString(),id,account,b.expectedVersion).run();
 if(!r.meta.changes)throw new GapError('version_conflict',409);
 return c.json({success:true,data:await c.env.DB.prepare('SELECT fixed_meeting_url url,meeting_url_version version FROM staff WHERE id=?').bind(id).first()});
});
bookingCalendarSettings.on(['GET','PUT'],'/api/booking/admin/menus/:id/meeting-url',async (c:Context<Env>):Promise<Response>=>{
 const account=await gapAccount(c),id=c.req.param('id')!,settingKey=`booking.meeting.automatic:${id}`;
 const row=await c.env.DB.prepare(`SELECT m.fixed_meeting_url url,m.version,COALESCE(s.value,'manual') issuance FROM menus m
  LEFT JOIN account_settings s ON s.line_account_id=m.line_account_id AND s.key=?
  WHERE m.id=? AND m.line_account_id=? AND m.deleted_at IS NULL`).bind(settingKey,id,account).first<{url:string|null;version:number;issuance:string}>();
 if(!row)throw new GapError('not_found',404);if(c.req.method==='GET')return c.json({success:true,data:row});
 gapWrite(c,{admin:true});const b=await gapBody(c),v=gapVersion(b.expectedVersion);
 if(!validMeetingUrl(b.url))throw new GapError('invalid_meeting_url');
 if(b.issuance!==undefined&&b.issuance!=='manual'&&b.issuance!=='automatic')throw new GapError('invalid_meeting_issuance');
 const issuance=b.issuance??row.issuance;
 const results=await c.env.DB.batch([
  c.env.DB.prepare('UPDATE menus SET fixed_meeting_url=?,version=version+1 WHERE id=? AND line_account_id=? AND version=? AND deleted_at IS NULL').bind(b.url,id,account,v),
  c.env.DB.prepare(`INSERT INTO account_settings(id,line_account_id,key,value) SELECT ?,?,?,? WHERE changes()=1
   ON CONFLICT(line_account_id,key) DO UPDATE SET value=excluded.value,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`).bind(crypto.randomUUID(),account,settingKey,issuance)
 ]);
 if(!results[0].meta.changes)throw new GapError('version_conflict',409);
 return c.json({success:true,data:{url:b.url,version:v+1,issuance}});
});
bookingCalendarSettings.post('/api/booking/admin/bookings/:id/meeting',async (c:Context<Env>):Promise<Response>=>{
 gapWrite(c);const a=await gapAccount(c),b=await gapBody(c),id=c.req.param('id'),v=gapVersion(b.expectedVersion);
 if(b.action!=='set_manual'&&b.action!=='refresh_fixed')throw new GapError('automatic_meeting_not_available',409);
 if(b.action==='set_manual'&&(!validMeetingUrl(b.url)||b.url===null))throw new GapError('invalid_meeting_url');
 const r=await c.env.DB.prepare(`UPDATE bookings SET confirmation_revision = confirmation_revision + 1, meeting_url=CASE WHEN ?='set_manual' THEN ? ELSE COALESCE((SELECT fixed_meeting_url FROM staff WHERE id=bookings.staff_id),(SELECT fixed_meeting_url FROM menus WHERE id=bookings.menu_id)) END,
  meeting_url_source=CASE WHEN ?='set_manual' THEN 'manual' WHEN (SELECT fixed_meeting_url FROM staff WHERE id=bookings.staff_id) IS NOT NULL THEN 'staff' ELSE 'menu' END,
  lock_version=lock_version+1 WHERE id=? AND line_account_id=? AND status='confirmed' AND meeting_mode='online' AND lock_version=?`)
 .bind(b.action,b.url??null,b.action,id,a,v).run();
 if(!r.meta.changes)throw new GapError('version_conflict',409);
 return c.json({success:true,data:await c.env.DB.prepare('SELECT meeting_url url,meeting_url_source source,lock_version version FROM bookings WHERE id=? AND line_account_id=?').bind(id,a).first()});
});

bookingCalendarSettings.get('/api/booking/admin/bookings/:id/meeting-status',async c=>{
 const account=await gapAccount(c),id=c.req.param('id');
 const booking=await c.env.DB.prepare('SELECT id,lock_version FROM bookings WHERE id=? AND line_account_id=?').bind(id,account).first<{id:string;lock_version:number}>();if(!booking)throw new GapError('not_found',404);
 const row=await c.env.DB.prepare(`SELECT l.status,l.provider FROM booking_meeting_links l JOIN bookings b ON b.id=l.booking_id
  WHERE b.id=? AND b.line_account_id=? AND l.idempotency_key='booking-meeting:'||b.id||':'||b.lock_version ORDER BY l.created_at DESC,l.id DESC LIMIT 1`).bind(id,account).first<{status:string;provider:string}>();
 return c.json({success:true,data:{state:row?.status==='failed'?'failed':row?.status==='pending'?'unknown':row?.status==='active'?'active':'none',provider:row?.provider??null,version:booking.lock_version}});
});
bookingCalendarSettings.post('/api/booking/admin/bookings/:id/meeting-retry',async c=>{
 gapWrite(c,{admin:true});const accountId=await gapAccount(c),bookingId=c.req.param('id')!,requestKey=gapKey(c);
 const booking=await c.env.DB.prepare('SELECT id FROM bookings WHERE id=? AND line_account_id=?').bind(bookingId,accountId).first();if(!booking)throw new GapError('not_found',404);
 if(!await featureJobCanRun(c.env.DB,{accountId,featureId:'booking',job:'booking meeting retry'}))throw new GapError('booking_disabled',409);
 const outcome=await retryFailedMeeting(c.env.DB,{accountId,bookingId,requestKey,resolve:async()=>{const adapter=await meetingCreatorForBooking(c.env,bookingId);return adapter && typeof adapter!=='string'?adapter:null;}});
 auditLog(c,'booking.meeting.retry',{id:bookingId,kind:'booking_meeting_retry'},{lineAccountId:accountId});
 return c.json({success:true,data:{outcome}});
});

bookingCalendarSettings.get('/api/booking/admin/bookings/:id/meeting-links',async (c:Context<Env>):Promise<Response>=>{
 const account=await gapAccount(c),id=c.req.param('id');
 const booking=await c.env.DB.prepare('SELECT id FROM bookings WHERE id=? AND line_account_id=?').bind(id,account).first();
 if(!booking)throw new GapError('not_found',404);
 const rows=await c.env.DB.prepare("SELECT l.id,l.provider,l.staff_id,l.starts_at,l.ends_at,l.created_at,s.display_name staff_name FROM booking_meeting_links l LEFT JOIN staff s ON s.id=l.staff_id AND s.line_account_id=? WHERE l.booking_id=? AND l.status='cancel_pending' AND l.last_error_code='manual_review' ORDER BY l.created_at,l.id").bind(account,id).all();
 return c.json({success:true,data:{items:rows.results??[]}});
});

bookingCalendarSettings.post('/api/booking/admin/bookings/:id/meeting-links/:linkId/resolve',async (c:Context<Env>):Promise<Response>=>{
 gapWrite(c,{admin:true});const account=await gapAccount(c),body=await gapBody(c);
 if(body.confirmed!==true)throw new GapError('confirmation_required');
 const result=await c.env.DB.prepare(`UPDATE booking_meeting_links SET status='cancelled',last_error_code='manual_resolved',updated_at=?
  WHERE id=? AND booking_id=? AND status='cancel_pending' AND last_error_code='manual_review'
  AND EXISTS(SELECT 1 FROM bookings b WHERE b.id=booking_meeting_links.booking_id AND b.line_account_id=?)`)
  .bind(new Date().toISOString(),c.req.param('linkId'),c.req.param('id'),account).run();
 if(!result.meta.changes)throw new GapError('not_found',404);
 auditLog(c,'booking.meeting.manual.resolve',{id:c.req.param('linkId')!,kind:'booking_meeting_link'},{lineAccountId:account});
 return c.json({success:true,data:{resolved:true}});
});

bookingCalendarSettings.post('/api/booking/admin/bookings/:id/calendar/rewrite',async (c:Context<Env>):Promise<Response>=>{
 gapWrite(c);const account=await gapAccount(c),id=c.req.param('id')!,b=await gapBody(c),v=gapVersion(b.expectedVersion);
 const booking=await c.env.DB.prepare("SELECT staff_id,lock_version FROM bookings WHERE id=? AND line_account_id=? AND status='confirmed'").bind(id,account).first<{staff_id:string;lock_version:number}>();
 if(!booking)throw new GapError('not_found',404);
 const sw=await calendarSwitch(c.env.DB,account,booking.staff_id),store=await calendarSwitch(c.env.DB,account);
 if(!sw.writeEnabled||!store.writeEnabled)throw new GapError('calendar_write_disabled',409);
 const token=crypto.randomUUID();
 const r=await c.env.DB.batch([
  c.env.DB.prepare('UPDATE bookings SET confirmation_revision = confirmation_revision + 1, lock_version=lock_version+1 WHERE id=? AND line_account_id=? AND lock_version=?').bind(id,account,v),
  c.env.DB.prepare(`INSERT INTO booking_calendar_switch_jobs(id,line_account_id,staff_id,booking_id,action,switch_scope,switch_version,created_at)
   SELECT ?,?,?,?,'write',?,?,? WHERE changes()=1 ON CONFLICT(booking_id,action,switch_scope,switch_version) DO UPDATE SET status='pending',attempts=0,error_code=NULL`)
   .bind(token,account,booking.staff_id,id,booking.staff_id,sw.version,new Date().toISOString())
 ]);
 if(!r[0].meta.changes)throw new GapError('version_conflict',409);
 return c.json({success:true,data:{queued:true,version:v+1}},202);
});
bookingCalendarSettings.post('/api/booking/admin/calendar-sync/retry',async (c:Context<Env>):Promise<Response>=>{
 gapWrite(c,{admin:true});const account=await gapAccount(c);
 const r=await c.env.DB.prepare("UPDATE booking_calendar_switch_jobs SET status='pending',attempts=0,error_code=NULL WHERE line_account_id=? AND status='failed'").bind(account).run();
 return c.json({success:true,data:{queued:r.meta.changes}},202);
});
