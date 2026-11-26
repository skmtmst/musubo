import { jstCalendar as japanCalendar } from '@line-crm/shared';
import { readNotificationStyle } from './notification-words.js';
import { workflowBindings, workflowJson } from '@line-crm/db';
import { bookingLinePlan } from '../features/booking/booking-line-delivery/index.js';
import { renderEventNotificationText, type EventNotificationContext, type EventNotificationKind } from './event-booking-notifier.js';
import type { EventNotificationSubject } from './event-notification-subject.js';
import { computeRemindersForBooking } from './event-reminder-schedule.js';
import { prepareEventReminders } from './event-reminder-plan.js';

/** 予約のINSERT/状態CASと同じbatchへ積む。成立しなかった予約の通知は作らない。 */
export async function prepareEventNotification(db:D1Database,input:{accountId:string;operationId:string;to:string;
  kind:EventNotificationKind;ctx:EventNotificationContext;subject:EventNotificationSubject;now?:Date}) {
  const now=(input.now??new Date()).getTime();
  const ctx={...input.ctx,style:input.ctx.style??await readNotificationStyle(db,input.accountId)};
  const snapshot={to:input.to,kind:input.kind,ctx,
    messages:[{type:'text' as const,text:renderEventNotificationText(input.kind,ctx)}],subject:input.subject};
  const plan=await bookingLinePlan({...input,snapshot,now:()=>now});
  return db.prepare(`INSERT OR IGNORE INTO workflow_steps
    (scope_id,process_kind,subject_id,step_key,retry_key,input_json,max_attempts,status,created_at,updated_at,attempt_count)
    SELECT ?,?,?,?,?,?,?,'pending',?,?,0 WHERE EXISTS(SELECT 1 FROM event_bookings b
      WHERE b.id=? AND b.line_account_id=? AND b.slot_id=? AND b.status=? AND (? IS NULL OR b.lock_version=?))`)
    .bind(...workflowBindings(plan.ref),plan.identity.idempotencyKey,
      workflowJson({identity:plan.identity,policy:plan.policy,snapshot}),plan.policy.maxAttempts,now,now,
      input.subject.bookingId,input.accountId,input.subject.slotId,input.subject.status,input.subject.version??null,input.subject.version??null);
}

/** 管理者の確定CASと同じ取引へ、通知と2種のリマインダを積む。 */
export async function prepareConfirmedEventBooking(db:D1Database,bookingId:string,now:Date):Promise<D1PreparedStatement[]> {
  const row=await db.prepare(`SELECT e.name AS event_name,e.venue_name,e.venue_url,e.confirmation_message_extra,
      e.reminder_day_before_enabled,e.reminder_hours_before,s.starts_at AS slot_starts_at,
      b.line_account_id,b.slot_id,b.lock_version,f.line_platform_user_id AS line_user_id
    FROM event_bookings b JOIN events e ON e.id=b.event_id JOIN event_slots s ON s.id=b.slot_id
    JOIN friends f ON f.id=b.friend_id AND f.line_account_id=b.line_account_id WHERE b.id=?`)
    .bind(bookingId).first<{event_name:string;venue_name:string|null;venue_url:string|null;confirmation_message_extra:string|null;
      reminder_day_before_enabled:number;reminder_hours_before:number|null;slot_starts_at:string;
      line_account_id:string;slot_id:string;lock_version:number;line_user_id:string|null}>();
  if(!row?.line_user_id)return [];
  const starts=japanCalendar(new Date(Date.parse(row.slot_starts_at))).toISOString();
  const notification=await prepareEventNotification(db,{accountId:row.line_account_id,
    operationId:`event-transition:${bookingId}:${row.lock_version+1}`,to:row.line_user_id,kind:'confirmed',
    ctx:{eventName:row.event_name,startsAtJst:`${starts.slice(0,10)} ${starts.slice(11,16)}`,
      venueName:row.venue_name,venueUrl:row.venue_url,confirmationExtra:row.confirmation_message_extra},
    subject:{version:row.lock_version+1,bookingId,slotId:row.slot_id,status:'confirmed',startsAt:row.slot_starts_at},now});
  return [notification,...prepareEventReminders(db,bookingId,computeRemindersForBooking({
    starts_at_utc:row.slot_starts_at,reminder_day_before_enabled:row.reminder_day_before_enabled===1,
    reminder_hours_before:row.reminder_hours_before??null,now}),true)];
}
