import {accountFeatureOffExclusionSql} from '@line-crm/db';
import {createFeatureJobGate} from '../../services/feature-enforcement.js';
import { notifyMeetingIssue } from './booking-meeting-notice.js';
import { reconcileBookingMeeting, type MeetingRemover } from './booking-meeting-lifecycle.js';
import { verifyUnknownMeeting, type MeetingVerifier } from './booking-meeting-verify.js';
import type { MeetingCreator, MeetingProvider } from './booking-meeting-create.js';

export interface MeetingQueueDependencies {
  resolve(input:{accountId:string;bookingId:string}):Promise<{
    creator?:MeetingCreator;
    deferred?:boolean;
    unavailable?:Array<{staffId:string;provider:MeetingProvider}>;
    removers:Partial<Record<MeetingProvider,MeetingRemover>>;
    verifiers:Partial<Record<MeetingProvider,MeetingVerifier>>;
  } | null>;
}

/** 既存の会議を読み、確定していない結果は先に読み取りで照合する。 */
export async function processMeetingQueue(db:D1Database,deps:MeetingQueueDependencies,limit=50,target?:{bookingId:string;accountId:string}):Promise<number> {
 const gate=createFeatureJobGate();
 const rows=await db.prepare(`SELECT b.id booking_id,b.line_account_id account_id
  FROM bookings b JOIN booking_meeting_links l ON l.booking_id=b.id
  WHERE NOT ${accountFeatureOffExclusionSql('b.line_account_id','booking')} AND (l.status='cancel_pending' OR (l.status='pending' AND l.attempt_count>0))
   AND ((? IS NOT NULL AND b.id=? AND b.line_account_id=?) OR (? IS NULL AND julianday(l.updated_at)<=julianday('now','-1 minute')))
  GROUP BY b.id,b.line_account_id ORDER BY MIN(l.updated_at),b.id LIMIT ?`).bind(target?.bookingId??null,target?.bookingId??null,target?.accountId??null,target?.bookingId??null,Math.max(1,Math.min(100,limit)))
  .all<{booking_id:string;account_id:string}>();
 let processed=0;
 for(const row of rows.results??[]) {
  if(!await gate.canRun(db,row.account_id,'booking','booking meeting recovery'))continue;
  const services=await deps.resolve({accountId:row.account_id,bookingId:row.booking_id});
  if(!services) {
   const link=await db.prepare("SELECT id FROM booking_meeting_links WHERE booking_id=? AND (status='cancel_pending' OR (status='pending' AND attempt_count>0)) ORDER BY created_at,id LIMIT 1").bind(row.booking_id).first<{id:string}>();
   if(link)await notifyMeetingIssue(db,{accountId:row.account_id,bookingId:row.booking_id,linkId:link.id,reason:'failed'});
   await db.prepare("UPDATE booking_meeting_links SET updated_at=? WHERE booking_id=? AND (status='cancel_pending' OR (status='pending' AND attempt_count>0)) AND julianday(updated_at)<=julianday('now','-1 minute')").bind(new Date().toISOString(),row.booking_id).run();
   continue;
  }
  if(services.deferred) {
   await db.prepare("UPDATE booking_meeting_links SET updated_at=? WHERE booking_id=? AND (status='cancel_pending' OR (status='pending' AND attempt_count>0)) AND julianday(updated_at)<=julianday('now','-1 minute')").bind(new Date().toISOString(),row.booking_id).run();
   continue;
  }
  const links=await db.prepare(`SELECT id,provider,staff_id,status FROM booking_meeting_links WHERE booking_id=?
    AND ((status='pending' AND attempt_count>0) OR (status='cancel_pending' AND last_error_code IN ('delete_started','delete_unknown')))`)
    .bind(row.booking_id).all<{id:string;provider:MeetingProvider;staff_id:string|null;status:string}>();
  let unknown=false;
  for(const link of links.results??[]) {
   if(link.status==='cancel_pending' && services.unavailable?.some(item=>item.staffId===link.staff_id && item.provider===link.provider))continue;
   const verifier=services.verifiers[link.provider];
   if(!verifier || await verifyUnknownMeeting(db,{linkId:link.id,accountId:row.account_id,verifier})!=='verified')unknown=true;
  }
  const outcome=unknown?'unknown':await reconcileBookingMeeting(db,{bookingId:row.booking_id,accountId:row.account_id,creator:services.creator,removers:services.removers,unavailable:services.unavailable});
  if(outcome!=='done') {
   const link=await db.prepare("SELECT id FROM booking_meeting_links WHERE booking_id=? AND (status='cancel_pending' OR (status='pending' AND attempt_count>0)) ORDER BY created_at,id LIMIT 1").bind(row.booking_id).first<{id:string}>();
   if(link)await notifyMeetingIssue(db,{accountId:row.account_id,bookingId:row.booking_id,linkId:link.id,reason:outcome});
  }
  if(outcome!=='done')await db.prepare("UPDATE booking_meeting_links SET updated_at=? WHERE booking_id=? AND (status='cancel_pending' OR (status='pending' AND attempt_count>0)) AND julianday(updated_at)<=julianday('now','-1 minute')").bind(new Date().toISOString(),row.booking_id).run();
  processed++;
 }
 return processed;
}
