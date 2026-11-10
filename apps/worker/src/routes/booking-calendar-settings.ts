import {Hono,type Context} from 'hono';
import type { Env } from '../worker-env.js';
import {gapAccount,gapBody,gapVersion,gapWrite,GapError} from '../services/gap-common.js';
import {calendarSwitch,validMeetingUrl} from '../features/booking/booking-calendar-settings/index.js';
import {bookingChannelBounds} from '../features/booking/booking-channels/index.js';
import {getAccountTimeZone} from '../services/availability.js';
import {BOOKING_STAFF_OWN_KEY} from '@line-crm/shared';
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
  const store=await calendarSwitch(c.env.DB,account),connection=id?await c.env.DB.prepare('SELECT id FROM google_calendar_connections WHERE line_account_id=? AND staff_id=? AND is_active=1').bind(account,id).first():null;
  const health=id?await c.env.DB.prepare('SELECT last_success_at,failed_since,error_code FROM booking_calendar_read_health WHERE line_account_id=? AND staff_id=?').bind(account,id).first():null;
  const pending=await c.env.DB.prepare("SELECT COALESCE(SUM(status='pending'),0) pending,COALESCE(SUM(status='failed'),0) failed FROM booking_calendar_switch_jobs WHERE line_account_id=? AND (?='' OR staff_id=?)").bind(account,id,id).first();
  const future=await c.env.DB.prepare("SELECT COUNT(*) n FROM bookings WHERE line_account_id=? AND (?='' OR staff_id=?) AND starts_at>=? AND external_event_id IS NOT NULL AND status='confirmed'").bind(account,id,id,cutoff).first<{n:number}>();
  return c.json({success:true,data:{...before,effectiveReadEnabled:store.readEnabled&&before.readEnabled,effectiveWriteEnabled:store.writeEnabled&&before.writeEnabled,connected:!!connection,health,jobs:pending,futureEventCount:future?.n??0}});
 }
 gapWrite(c,{admin:!id});const b=await gapBody(c),v=gapVersion(b.expectedVersion);
 if(typeof b.readEnabled!=='boolean'||typeof b.writeEnabled!=='boolean'||(b.removeFutureEvents!==undefined&&typeof b.removeFutureEvents!=='boolean')||(b.includeBacklog!==undefined&&typeof b.includeBacklog!=='boolean'))throw new GapError('invalid_switches');
 if((before.readEnabled&&!b.readEnabled||before.writeEnabled&&!b.writeEnabled)&&b.confirmed!==true)throw new GapError('confirmation_required');
 if(id&&(b.readEnabled||b.writeEnabled)&&!await c.env.DB.prepare('SELECT id FROM google_calendar_connections WHERE line_account_id=? AND staff_id=? AND is_active=1').bind(account,id).first())throw new GapError('calendar_not_connected',409);
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
 const account=await gapAccount(c),id=c.req.param('id'),row=await c.env.DB.prepare('SELECT fixed_meeting_url url,version FROM menus WHERE id=? AND line_account_id=? AND deleted_at IS NULL').bind(id,account).first<{url:string|null;version:number}>();
 if(!row)throw new GapError('not_found',404);if(c.req.method==='GET')return c.json({success:true,data:row});
 gapWrite(c,{admin:true});const b=await gapBody(c),v=gapVersion(b.expectedVersion);if(!validMeetingUrl(b.url))throw new GapError('invalid_meeting_url');
 const r=await c.env.DB.prepare('UPDATE menus SET fixed_meeting_url=?,version=version+1 WHERE id=? AND line_account_id=? AND version=?').bind(b.url,id,account,v).run();if(!r.meta.changes)throw new GapError('version_conflict',409);
 return c.json({success:true,data:{url:b.url,version:v+1}});
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
