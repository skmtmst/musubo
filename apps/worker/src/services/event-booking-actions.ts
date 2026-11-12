import { computeIdentityKey } from '../lib/identity-key.js'
import { AutomationActionError, type AutomationActionContext } from '../features/automations/automation-engine/index.js'
import { getSlotsWithRemaining } from './event-availability.js'
import { computeRemindersForBooking, insertRemindersForBooking, cancelPendingRemindersFor } from './event-booking-reminders.js'
import { cancelByTrigger, enrollByTrigger } from './reminder-trigger.js'
import { enqueueEventWaitlistPromotion } from './event-waitlist.js'

function stop(code: string, reason: string): never {
  throw new AutomationActionError(code, reason, false)
}

interface EventConfig {
  id: string; name: string; image_url: string | null; description: string | null
  venue_name: string | null; venue_address: string | null; venue_url: string | null
  requires_approval: number; approval_deadline_hours: number; current_published_version_id: string | null
  max_bookings_per_friend: number | null; reminder_day_before_enabled: number; reminder_hours_before: number | null
  cancel_deadline_hours_before: number | null; confirmation_message_extra: string | null
  entry_cutoff_hours_before: number | null; visible_tag_id: string | null
}

/** 回の指定が無ければ、開始時刻順で次に空いている回へ1人分申し込む。 */
export async function executeEventBookingAction(context: AutomationActionContext): Promise<void> {
  const { db, friendId, lineAccountId, idempotencyKey } = context
  const params = context.action.params
  const eventId = typeof params.eventId === 'string' ? params.eventId : ''
  const op = params.op ?? 'register'
  if (!eventId) stop('event_id_missing', 'イベントが選ばれていません')
  if (!['register', 'book', 'cancel'].includes(String(op))) stop('event_operation_invalid', 'イベント予約の操作が不正です')
  if (params.slotId != null && (typeof params.slotId !== 'string' || !params.slotId)) {
    stop('event_slot_invalid', 'イベントの回の指定が不正です')
  }
  const friend = await db.prepare(`SELECT id, user_id, picture_url FROM friends WHERE id = ? AND line_account_id = ?`)
    .bind(friendId, lineAccountId).first<{ id: string; user_id: string | null; picture_url: string | null }>()
  if (!friend) stop('friend_not_found', '対象の友だちがこのアカウントにいません')
  // 取消は非公開になったイベントにも行える。別アカウントには行わない。
  const event = await db.prepare(`SELECT * FROM events WHERE id = ? AND (
    (target_type = 'single' AND line_account_id = ?) OR
    (target_type = 'multi-account-dedup' AND EXISTS (SELECT 1 FROM json_each(account_ids) WHERE value = ?)))
    ${op === 'cancel' ? '' : "AND deleted_at IS NULL AND is_published = 1 AND (lifecycle_status IS NULL OR lifecycle_status = 'published')"}`)
    .bind(eventId, lineAccountId, lineAccountId).first<EventConfig>()
  if (!event) stop('event_unavailable', 'イベントが見つからないか、申し込めません')
  const now = new Date().toISOString()
  const bookingId = `event-action:${idempotencyKey}`

  if (op === 'cancel') {
    const marker = `[event-action:${idempotencyKey}]`
    const targets = await db.prepare(`SELECT b.id, b.slot_id, b.status, s.starts_at FROM event_bookings b
      JOIN event_slots s ON s.id = b.slot_id WHERE b.event_id = ? AND b.friend_id = ? AND b.line_account_id = ?
      AND (b.status IN ('requested','confirmed') OR (b.status = 'cancelled' AND instr(COALESCE(b.internal_note,''), ?) > 0))`)
      .bind(eventId, friend.id, lineAccountId, marker)
      .all<{ id: string; slot_id: string; status: string; starts_at: string }>()
    if (!targets.results?.length) stop('event_booking_missing', '取り消す申し込みがありません')
    for (const target of targets.results) {
      if (target.status !== 'cancelled') {
        const changed = await db.prepare(`UPDATE event_bookings SET confirmation_revision = confirmation_revision + 1, status = 'cancelled', cancelled_at = ?, cancelled_by = 'system', updated_at = ?,
          internal_note = COALESCE(internal_note || char(10), '') || ? WHERE id = ? AND status = ?`)
          .bind(now, now, marker, target.id, target.status).run()
        if (!changed.meta?.changes) stop('event_booking_changed', '申し込みが変更されたため取り消せません')
      }
      try {
        await cancelByTrigger(db, { triggerType: 'event', sourceId: target.id, sourceEventId: target.id,
          friendId: friend.id, startsAtIso: target.starts_at, lineAccountId, cancelReason: marker, failOnSendInFlight: true })
      } catch (error) {
        if (error instanceof Error && error.message === 'REMINDER_SEND_IN_FLIGHT' && target.status !== 'cancelled') {
          await db.prepare(`UPDATE event_bookings SET confirmation_revision = confirmation_revision + 1, status = ?, cancelled_at = NULL, cancelled_by = NULL,
            internal_note = replace(internal_note, ?, '') WHERE id = ? AND status = 'cancelled'`)
            .bind(target.status, marker, target.id).run()
        }
        throw error
      }
      await cancelPendingRemindersFor(db, target.id)
      await enqueueEventWaitlistPromotion(db, { lineAccountId, eventId, occurrenceId: target.slot_id, sourceKey: `booking:${target.id}:cancelled` })
    }
    return
  }

  // 同じ出来事の再送は先に成立した回を保つ。後処理だけ失敗していたら補う。
  let booking = await db.prepare(`SELECT b.id, b.slot_id, b.status, s.starts_at FROM event_bookings b
    JOIN event_slots s ON s.id = b.slot_id WHERE b.id = ? AND b.friend_id = ? AND b.event_id = ? AND b.line_account_id = ?`)
    .bind(bookingId, friend.id, eventId, lineAccountId).first<{ id: string; slot_id: string; status: string; starts_at: string }>()
  if (!booking) {
    if (event.visible_tag_id && !await db.prepare('SELECT 1 FROM friend_tags WHERE friend_id = ? AND tag_id = ?')
      .bind(friend.id, event.visible_tag_id).first()) stop('event_unavailable', 'この友だちはイベントの申込対象ではありません')
    const identity = computeIdentityKey(friend)
    const slots = (await getSlotsWithRemaining(db, eventId, { only_future: true, only_active: true }))
      .filter(slot => !params.slotId || slot.id === params.slotId)
      .filter(slot => Date.parse(slot.starts_at) > Date.parse(now) + (event.entry_cutoff_hours_before ?? 0) * 3600000)
      .sort((a, b) => a.starts_at.localeCompare(b.starts_at) || a.id.localeCompare(b.id))
    for (const slot of slots) {
      if (slot.remaining != null && slot.remaining < 1) continue
      const status = event.requires_approval === 1 ? 'requested' : 'confirmed'
      const snapshot = JSON.stringify({ eventName: event.name, eventImageUrl: event.image_url, eventDescription: event.description,
        venueName: event.venue_name, venueAddress: event.venue_address, venueUrl: event.venue_url,
        cancelDeadlineHoursBefore: event.cancel_deadline_hours_before, confirmationMessageExtra: event.confirmation_message_extra,
        approvalDeadlineHours: event.approval_deadline_hours, slotStartsAt: slot.starts_at, slotEndsAt: slot.ends_at })
      // 空き・友だち上限・仮押さえ・二重申込の判定と作成を1つのSQLで行う。
      const inserted = await db.prepare(`INSERT OR IGNORE INTO event_bookings
        (id,line_account_id,event_id,slot_id,friend_id,status,requested_at,identity_key,party_size,
         event_version_id,event_snapshot_json,approval_expires_at,first_participation,first_participation_attended_count,first_participation_checked_at)
        SELECT ?1,?2,?3,s.id,?4,?5,?6,?7,1,?8,?9,?10,
          NOT EXISTS (SELECT 1 FROM event_bookings WHERE friend_id=?4 AND status='attended'),
          (SELECT COUNT(*) FROM event_bookings WHERE friend_id=?4 AND status='attended'),?6
        FROM event_slots s WHERE s.id=?11 AND s.event_id=?3 AND s.is_active=1 AND s.deleted_at IS NULL
        AND s.starts_at > ?12
        AND (s.capacity IS NULL OR s.capacity >
          COALESCE((SELECT SUM(party_size) FROM event_bookings WHERE slot_id=s.id AND status IN ('requested','confirmed')),0)
          + COALESCE((SELECT SUM(party_size) FROM event_waitlist WHERE slot_id=s.id AND status IN ('offered','accepted')),0))
        AND NOT EXISTS (SELECT 1 FROM event_bookings WHERE event_id=?3 AND slot_id=s.id AND identity_key=?7 AND status IN ('requested','confirmed'))
        AND NOT EXISTS (SELECT 1 FROM event_waitlist WHERE event_id=?3 AND slot_id=s.id AND identity_key=?7 AND status IN ('waiting','offered','accepted'))
        AND (?13 IS NULL OR ?13 >
          (SELECT COUNT(*) FROM event_bookings WHERE event_id=?3 AND identity_key=?7 AND status IN ('requested','confirmed'))
          + (SELECT COUNT(*) FROM event_waitlist WHERE event_id=?3 AND identity_key=?7 AND status IN ('offered','accepted')))`)
        .bind(bookingId, lineAccountId, eventId, friend.id, status, now, identity, event.current_published_version_id, snapshot,
          status === 'requested' ? new Date(Date.parse(now) + (event.approval_deadline_hours ?? 24) * 3600000).toISOString() : null,
          slot.id, new Date(Date.parse(now) + (event.entry_cutoff_hours_before ?? 0) * 3600000).toISOString(), event.max_bookings_per_friend).run()
      if (inserted.meta?.changes) { booking = { id: bookingId, slot_id: slot.id, status, starts_at: slot.starts_at }; break }
      // 同時再送が先に同じ申込を作った場合も成功として同じ回を使う。
      booking = await db.prepare(`SELECT b.id,b.slot_id,b.status,s.starts_at FROM event_bookings b JOIN event_slots s ON s.id=b.slot_id WHERE b.id=?`)
        .bind(bookingId).first<typeof booking>()
      if (booking) break
    }
    if (!booking) {
      booking = await db.prepare(`SELECT b.id,b.slot_id,b.status,s.starts_at FROM event_bookings b
        JOIN event_slots s ON s.id=b.slot_id WHERE b.id=? AND b.friend_id=? AND b.event_id=? AND b.line_account_id=?`)
        .bind(bookingId, friend.id, eventId, lineAccountId).first<typeof booking>()
    }
    if (!booking) stop('event_booking_unavailable', '申し込める空きがありません（満席・締切・重複・申込上限を確認してください）')
  }
  if (booking.status === 'confirmed') {
    await insertRemindersForBooking(db, booking.id, computeRemindersForBooking({ starts_at_utc: booking.starts_at,
      reminder_day_before_enabled: event.reminder_day_before_enabled === 1, reminder_hours_before: event.reminder_hours_before }))
    await enrollByTrigger(db, { triggerType: 'event', friendId: friend.id, startsAtIso: booking.starts_at,
      sourceId: booking.id, sourceEventId: booking.id, eventId, lineAccountId })
  }
}
