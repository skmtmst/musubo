import { cancelByTrigger, enrollByTrigger } from './reminder-trigger.js';
import { computeIdentityKey } from '../lib/identity-key.js';
import { computeRemindersForBooking, insertRemindersForBooking, cancelPendingRemindersFor } from './event-booking-reminders.js';
import { enqueueEventWaitlistPromotion } from './event-waitlist.js';

export interface EventBookingActionConfig { eventId: string; op?: 'register' | 'cancel'; slotId?: string | null }
export function validEventBookingAction(value: unknown): value is EventBookingActionConfig {
  const c = value as EventBookingActionConfig | null;
  return !!c && typeof c.eventId === 'string' && !!c.eventId &&
    (c.op === undefined || c.op === 'register' || c.op === 'cancel') &&
    (c.slotId == null || (typeof c.slotId === 'string' && !!c.slotId));
}
type Receipt = { reason: string | null; bookingIds: string[] };
const SOURCE = 'event_booking_action';
/** 空き無しも終わった工程として記録する。再送で別の回を予約しない。 */
export async function runEventBookingAction(db: D1Database, config: EventBookingActionConfig, friendId: string, effectKey: string): Promise<Receipt> {
  if (!validEventBookingAction(config)) throw new Error('イベントに行うことの設定を確認してください');
  const friend = await db.prepare(`SELECT f.id,f.user_id,f.picture_url,f.line_account_id FROM friends f
    JOIN line_accounts a ON a.id=f.line_account_id AND a.is_active=1 AND a.archived_at IS NULL
    WHERE f.id=?`).bind(friendId).first<{ id:string;user_id:string|null;picture_url:string|null;line_account_id:string }>();
  if (!friend) throw new Error('イベントの申し込み元を確認できませんでした');
  const sourceId = JSON.stringify([friend.line_account_id, friendId, effectKey]);
  const readReceipt = async () => {
    const row = await db.prepare('SELECT after_json FROM audit_events WHERE source_kind=? AND source_id=? AND line_account_id=?')
      .bind(SOURCE,sourceId,friend.line_account_id).first<{after_json:string}>();
    return row ? JSON.parse(row.after_json) as Receipt : null;
  };
  const finish = async (result: Receipt): Promise<Receipt> => {
    for (const id of result.bookingIds) {
      const booking = await db.prepare(`SELECT b.status,b.slot_id,s.starts_at,e.reminder_day_before_enabled,e.reminder_hours_before
        FROM event_bookings b JOIN event_slots s ON s.id=b.slot_id JOIN events e ON e.id=b.event_id
        WHERE b.id=? AND b.friend_id=? AND b.line_account_id=?`).bind(id,friendId,friend.line_account_id)
        .first<{status:string;slot_id:string;starts_at:string;reminder_day_before_enabled:number;reminder_hours_before:number|null}>();
      if (!booking) throw new Error('イベントの処理記録を確認できませんでした');
      if (booking.status === 'confirmed') {
        await insertRemindersForBooking(db,id,computeRemindersForBooking({starts_at_utc:booking.starts_at,reminder_day_before_enabled:booking.reminder_day_before_enabled===1,reminder_hours_before:booking.reminder_hours_before}));
        await enrollByTrigger(db,{triggerType:'event',friendId,sourceId:id,sourceEventId:id,eventId:config.eventId,lineAccountId:friend.line_account_id,startsAtIso:booking.starts_at});
      } else if (booking.status === 'cancelled') {
        await cancelByTrigger(db,{triggerType:'event',friendId,sourceId:id,sourceEventId:id,lineAccountId:friend.line_account_id,startsAtIso:booking.starts_at,cancelReason:`event_action:${id}`,failOnSendInFlight:true});
        await cancelPendingRemindersFor(db,id);
        await enqueueEventWaitlistPromotion(db,{lineAccountId:friend.line_account_id,eventId:config.eventId,occurrenceId:booking.slot_id,sourceKey:`booking:${id}:cancelled`});
      }
    }
    return result;
  };
  const replay = await readReceipt();
  if (replay) return finish(replay);
  const now = new Date().toISOString();
  const identity = computeIdentityKey(friend);
  const event = await db.prepare(`SELECT * FROM events WHERE id=? AND deleted_at IS NULL AND
    ((target_type='single' AND line_account_id=?) OR (target_type='multi-account-dedup' AND EXISTS(SELECT 1 FROM json_each(account_ids) WHERE value=?)))`)
    .bind(config.eventId,friend.line_account_id,friend.line_account_id).first<Record<string, any>>();
  if (!event) throw new Error('このアカウントで使えるイベントを選んでください');
  const writes: D1PreparedStatement[] = [];
  let reason: string | null = null;
  let ids: string[] = [];
  if (config.op === 'cancel') {
    ids = (await db.prepare(`SELECT id FROM event_bookings WHERE event_id=? AND friend_id=? AND line_account_id=?
      AND status IN ('requested','confirmed') AND (? IS NULL OR slot_id=?) ORDER BY id`)
      .bind(config.eventId,friendId,friend.line_account_id,config.slotId??null,config.slotId??null).all<{id:string}>()).results.map(r=>r.id);
    if (!ids.length) reason = '申し込みがありません';
    // 配信権が貸出中なら確定せず再試行する。予約を戻す必要のある半端な取消を作らない。
    for (const id of ids) {
      const row = await db.prepare('SELECT s.starts_at FROM event_bookings b JOIN event_slots s ON s.id=b.slot_id WHERE b.id=?').bind(id).first<{starts_at:string}>();
      await cancelByTrigger(db,{triggerType:'event',friendId,sourceId:id,sourceEventId:id,lineAccountId:friend.line_account_id,startsAtIso:row!.starts_at,cancelReason:`event_action:${id}`,failOnSendInFlight:true});
      writes.push(db.prepare(`UPDATE event_bookings SET confirmation_revision = confirmation_revision + 1, status='cancelled',cancelled_at=?,cancelled_by='system',updated_at=?
        WHERE id=? AND friend_id=? AND line_account_id=? AND status IN ('requested','confirmed')`).bind(now,now,id,friendId,friend.line_account_id));
    }
  } else {
    if (event.is_published!==1 || (event.lifecycle_status && event.lifecycle_status!=='published')) reason='イベントは公開されていません';
    if (!reason && event.visible_tag_id && !await db.prepare('SELECT 1 FROM friend_tags WHERE friend_id=? AND tag_id=?').bind(friendId,event.visible_tag_id).first()) reason='申し込み対象ではありません';
    if (!reason && JSON.parse(event.questions_json??'[]').some((q:{required?:boolean})=>q.required)) reason='イベントの必須質問への回答が必要です';
    if (!reason) {
      const id = crypto.randomUUID();
      // 回の選択・人数・同一人物の上限を1つのINSERTで確かめる。待ちの仮押さえも席に含める。
      writes.push(db.prepare(`INSERT INTO event_bookings(id,line_account_id,event_id,slot_id,friend_id,status,requested_at,identity_key,
        event_version_id,event_snapshot_json,approval_expires_at,first_participation,first_participation_attended_count,first_participation_checked_at)
        SELECT ?,?,e.id,s.id,?,CASE WHEN e.requires_approval=1 THEN 'requested' ELSE 'confirmed' END,?,?,e.current_published_version_id,
          json_object('eventName',e.name,'eventImageUrl',e.image_url,'eventDescription',e.description,'venueName',e.venue_name,'venueAddress',e.venue_address,'venueUrl',e.venue_url,
            'cancelDeadlineHoursBefore',e.cancel_deadline_hours_before,'confirmationMessageExtra',e.confirmation_message_extra,'approvalDeadlineHours',e.approval_deadline_hours,'slotStartsAt',s.starts_at,'slotEndsAt',s.ends_at),
          CASE WHEN e.requires_approval=1 THEN strftime('%Y-%m-%dT%H:%M:%fZ',?, '+' || e.approval_deadline_hours || ' hours') ELSE NULL END,
          NOT EXISTS(SELECT 1 FROM event_bookings WHERE friend_id=? AND status='attended'),
          (SELECT COUNT(*) FROM event_bookings WHERE friend_id=? AND status='attended'),?
        FROM event_slots s JOIN events e ON e.id=s.event_id
        WHERE e.id=? AND e.updated_at=? AND e.is_published=1 AND e.deleted_at IS NULL AND (e.lifecycle_status IS NULL OR e.lifecycle_status='published')
          AND s.is_active=1 AND s.deleted_at IS NULL AND julianday(s.starts_at)>julianday(?)
          AND (e.entry_cutoff_hours_before IS NULL OR julianday(s.starts_at)-e.entry_cutoff_hours_before/24.0>julianday(?))
          AND (? IS NULL OR s.id=?)
          AND (s.capacity IS NULL OR s.capacity>(SELECT COALESCE(SUM(party_size),0) FROM event_bookings WHERE slot_id=s.id AND status IN ('requested','confirmed'))+
            (SELECT COALESCE(SUM(party_size),0) FROM event_waitlist WHERE slot_id=s.id AND status IN ('offered','accepted')))
          AND (e.max_bookings_per_friend IS NULL OR e.max_bookings_per_friend>(SELECT COUNT(*) FROM event_bookings WHERE event_id=e.id AND identity_key=? AND status IN ('requested','confirmed'))+
            (SELECT COUNT(*) FROM event_waitlist WHERE event_id=e.id AND identity_key=? AND status IN ('offered','accepted')))
          AND NOT EXISTS(SELECT 1 FROM event_bookings WHERE event_id=e.id AND slot_id=s.id AND identity_key=? AND status IN ('requested','confirmed'))
          AND NOT EXISTS(SELECT 1 FROM event_waitlist WHERE event_id=e.id AND slot_id=s.id AND identity_key=? AND status IN ('waiting','offered','accepted'))
        ORDER BY julianday(s.starts_at),s.id LIMIT 1`)
        .bind(id,friend.line_account_id,friendId,now,identity,now,friendId,friendId,now,event.id,event.updated_at,now,now,config.slotId??null,config.slotId??null,identity,identity,identity,identity));
      ids=[id];
    }
  }
  const result: Receipt = {reason,bookingIds:ids};
  const resultJson = JSON.stringify(result);
  const bookingId = config.op!=='cancel' && ids.length ? ids[0] : null;
  const receiptSql = bookingId
    ? `SELECT CASE WHEN EXISTS(SELECT 1 FROM event_bookings WHERE id=?) THEN ? ELSE json_object('reason','申し込める空きがありません','bookingIds',json('[]')) END`
    : 'SELECT ?';
  const receiptBindings = bookingId ? [bookingId,resultJson] : [resultJson];
  try {
    await db.batch([
      db.prepare(`SELECT json(CASE WHEN NOT EXISTS(SELECT 1 FROM audit_events WHERE source_kind=? AND source_id=?) THEN '{}' ELSE 'ALREADY_DONE' END)`).bind(SOURCE,sourceId),
      ...writes,
      db.prepare(`INSERT INTO audit_events(id,source_kind,source_id,tenant_id,line_account_id,category,actor_role,action,target_kind,target_id,result,after_json)
        SELECT ?,?,?,COALESCE(a.tenant_id,'00000000-0000-4000-8000-000000000001'),a.id,'business','system',?,'event',?,'success',(${receiptSql}) FROM line_accounts a WHERE a.id=?`)
        .bind(crypto.randomUUID(),SOURCE,sourceId,config.op==='cancel'?'event.action_cancel':'event.action_register',config.eventId,...receiptBindings,friend.line_account_id),
    ]);
  } catch (error) {
    const concurrent = await readReceipt();
    if (!concurrent) throw error;
    return finish(concurrent);
  }
  return finish((await readReceipt())!);
}
