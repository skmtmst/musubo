import { replacementEventTransition } from '../../services/event-transition-plan.js';
import { transferEventEntitlement } from '../../services/event-entitlements.js';
import { logger } from '@line-crm/shared/server';
import type { Env } from '../../worker-env.js';
import type { Hono } from 'hono';
import { bad } from '../../services/event-input-error.js';
import { inputJsonBoundary } from '../../lib/input-errors.js';
import { cancelByTrigger, enrollByTrigger } from '../../services/reminder-trigger.js';
import { EVENT_IDEMPOTENCY_TTL_MINUTES } from '../../services/event-booking-types.js';
import { verifyCallerLineUserId } from '../../services/liff-auth.js';
import { reserveEventIdempotency, finalizeEventIdempotencyResponse } from '../../services/event-booking-idempotency.js';
import { computeRemindersForBooking, insertRemindersForBooking, cancelPendingRemindersFor } from '../../services/event-booking-reminders.js';
import { enqueueEventWaitlistPromotion, getEventOccurrenceUsedSeats } from '../../services/event-waitlist.js';
import { writeEventChangeLog } from '../../services/event-change-review.js';
import { resolveAccountIdFromLiff, eventBookingSnapshot } from './input.js';
import { EventDbRow, SlotDbRow } from './time-input.js';

export function registerLiffChange(events: Hono<Env>): void {
// ----------------------------------------------------------------
// U-3 LIFF: my booking occurrence change (atomic)
// -29 §7-3。本人の開催回変更は「新しい席を確保できた時だけ元の申込を
// 取り消す」まとめて1つの操作。確保に失敗したら旧予約を維持する。
// ----------------------------------------------------------------
events.post('/api/events/liff/bookings/:id/change', inputJsonBoundary(), async (c) => {
  const account_id = await resolveAccountIdFromLiff(c);
  if (!account_id) return bad(c, 'liff_account_resolution_failed', 400, []);
  const idemKey = c.req.header('Idempotency-Key');
  if (!idemKey) return bad(c, 'idempotency_key_required', 400, []);
  const callerLineUserId = await verifyCallerLineUserId(c.req.header('Authorization'), c.env, account_id);
  if (!callerLineUserId) return bad(c, 'unauthorized', 401);
  const friend = await c.env.DB
    .prepare(
      `SELECT id, user_id, picture_url FROM friends
        WHERE line_user_id = ? AND line_account_id = ? AND is_following = 1`,
    )
    .bind(callerLineUserId, account_id)
    .first<{ id: string; user_id: string | null; picture_url: string | null }>();
  if (!friend) return bad(c, 'friend_not_found', 404);

  const reservation = await reserveEventIdempotency(c.env.DB, {
    key: idemKey,
    lineAccountId: account_id,
    friendId: friend.id,
    ttlMinutes: EVENT_IDEMPOTENCY_TTL_MINUTES,
    now: new Date(),
  });
  if (reservation.kind === 'cached') {
    if (reservation.status >= 500) throw new Error('event_booking_change_cached_failure');
    return c.json(
      reservation.body as Record<string, unknown>,
      reservation.status as 200 | 201 | 400 | 409 | 410 | 422,
    );
  }
  if (reservation.kind === 'in_progress') {
    return bad(c, 'idempotent_in_progress', 429);
  }
  const finalize = async (status: number, body: unknown): Promise<Response> => {
    await finalizeEventIdempotencyResponse(c.env.DB, {
      key: idemKey,
      lineAccountId: account_id,
      friendId: friend.id,
      status,
      body,
    });
    return c.json(body as Record<string, unknown>, status as 200 | 201 | 400 | 409 | 410 | 422);
  };
  try {
    return await runChangeFlow();
  } catch (e) {
    if(e instanceof Error&&e.message.includes('entitlement_unavailable'))return finalize(409,{error:'entitlement_unavailable'});
    await finalize(500, { error: 'internal_error' });
    throw e;
  }

  async function runChangeFlow(): Promise<Response> {
    if (friend == null) throw new Error('runChangeFlow: friend missing');
    if (callerLineUserId == null) throw new Error('runChangeFlow: callerLineUserId missing');
    if (account_id == null) throw new Error('runChangeFlow: line account missing');

    const bookingId = c.req.param('id');
    const current = await c.env.DB
      .prepare(
        `SELECT b.id,b.lock_version, b.status, b.line_account_id, b.event_id, b.slot_id, b.friend_id,
                b.party_size, b.identity_key, b.customer_note, b.answer_snapshot_json,
                CASE WHEN b.event_snapshot_json IS NOT NULL THEN json_extract(b.event_snapshot_json, '$.cancelDeadlineHoursBefore') ELSE e.cancel_deadline_hours_before END AS cancel_deadline_hours_before,
                CASE WHEN b.event_snapshot_json IS NOT NULL THEN json_extract(b.event_snapshot_json, '$.slotStartsAt') ELSE s.starts_at END AS slot_starts_at
           FROM event_bookings b
           JOIN events e ON e.id = b.event_id
           JOIN event_slots s ON s.id = b.slot_id
          WHERE b.id = ? AND b.friend_id = ? AND b.line_account_id = ?`,
      )
      .bind(bookingId, friend.id, account_id)
      .first<{
        id: string;
        status: string;
        lock_version:number;
        line_account_id: string;
        event_id: string;
        slot_id: string;
        friend_id: string;
        party_size: number;
        identity_key: string;
        customer_note: string | null;
        answer_snapshot_json: string | null;
        cancel_deadline_hours_before: number | null;
        slot_starts_at: string;
      }>();
    if (!current) return finalize(404, { error: 'not_found' });
    if (current.status !== 'requested' && current.status !== 'confirmed') {
      return finalize(409, { error: 'invalid_state' });
    }

    const body = (await c.req.json().catch(() => ({}))) as { to_slot_id?: unknown };
    if (typeof body.to_slot_id !== 'string' || body.to_slot_id.length === 0) {
      return finalize(422, { error: 'invalid_slot_id' });
    }
    if (body.to_slot_id === current.slot_id) return finalize(422, { error: 'same_slot' });

    const event = await c.env.DB
      .prepare(
        `SELECT id, name, image_url, description, venue_name, venue_address, venue_url,
                confirmation_message_extra, cancel_deadline_hours_before,
                requires_approval, approval_deadline_hours, current_published_version_id,
                max_bookings_per_friend,
                reminder_day_before_enabled, reminder_hours_before,
                entry_cutoff_hours_before
           FROM events
          WHERE id = ? AND deleted_at IS NULL AND is_published = 1
            AND (lifecycle_status IS NULL OR lifecycle_status = 'published') AND (
            (target_type = 'single' AND line_account_id = ?)
            OR (target_type = 'multi-account-dedup'
                AND EXISTS (SELECT 1 FROM json_each(account_ids) WHERE value = ?))
          )`,
      )
      .bind(current.event_id, account_id, account_id)
      .first<EventDbRow & { entry_cutoff_hours_before: number | null }>();
    if (!event) return finalize(409, { error: 'event_unpublished' });

    // 変更締切は取消締切と同じ決め方（申込時の版があればそれを優先）。
    if (current.cancel_deadline_hours_before == null) {
      return finalize(403, { error: 'change_not_allowed' });
    }
    const deadlineMs =
      new Date(current.slot_starts_at).getTime() - current.cancel_deadline_hours_before * 3600_000;
    if (deadlineMs <= Date.now()) return finalize(409, { error: 'change_deadline_passed' });

    const target = await c.env.DB
      .prepare(
        `SELECT id, event_id, starts_at, ends_at, is_active, capacity, deleted_at
           FROM event_slots WHERE id = ? AND event_id = ? AND deleted_at IS NULL`,
      )
      .bind(body.to_slot_id, event.id)
      .first<SlotDbRow & { capacity: number | null }>();
    if (!target || target.is_active !== 1) return finalize(409, { error: 'slot_inactive' });
    if (new Date(target.starts_at).getTime() <= Date.now()) {
      return finalize(410, { error: 'slot_started' });
    }
    if (event.entry_cutoff_hours_before != null) {
      const cutoffAt =
        new Date(target.starts_at).getTime() - event.entry_cutoff_hours_before * 3600_000;
      if (Date.now() >= cutoffAt) return finalize(410, { error: 'entry_closed' });
    }

    // 本人上限は「移動後」の姿で見る。旧予約は取り消すので数えない。
    if (event.max_bookings_per_friend != null) {
      const others = await c.env.DB
        .prepare(
          `SELECT COUNT(*) AS c FROM event_bookings
            WHERE event_id = ? AND identity_key = ?
              AND status IN ('requested','confirmed') AND id != ?`,
        )
        .bind(event.id, current.identity_key, current.id)
        .first<{ c: number }>();
      if ((others?.c ?? 0) >= event.max_bookings_per_friend) {
        return finalize(409, { error: 'over_friend_limit' });
      }
    }

    const nowIso = new Date().toISOString();
    const newId = crypto.randomUUID();
    const bookingSnapshotJson = eventBookingSnapshot(event, {
      starts_at: target.starts_at,
      ends_at: target.ends_at,
    });
    // 新しい席の確保。満席なら旧予約を維持したまま 409 で返す。
    if (target.capacity != null) {
      const usedSeats = await getEventOccurrenceUsedSeats(c.env.DB, target.id);
      if (usedSeats + current.party_size > target.capacity) {
        return finalize(409, { error: 'slot_full' });
      }
    }
    // 新行の確保と旧行の取消は D1 の原子的 batch にする。
    // 席数と旧行の状態も INSERT 内で再確認し、並走する変更に負けたら何も作らない。
    const moved = await c.env.DB.batch([
      c.env.DB.prepare(`INSERT INTO event_bookings
           (id, line_account_id, event_id, slot_id, friend_id, status, customer_note,
            requested_at, identity_key, party_size, answer_snapshot_json,
            event_version_id, event_snapshot_json)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE EXISTS (SELECT 1 FROM event_bookings WHERE id = ? AND status IN ('requested','confirmed') AND lock_version=?)
            AND (? IS NULL OR
              COALESCE((SELECT SUM(party_size) FROM event_bookings WHERE slot_id = ? AND status IN ('requested','confirmed')), 0)
              + COALESCE((SELECT SUM(party_size) FROM event_waitlist WHERE slot_id = ? AND status IN ('offered','accepted')), 0)
              + ? <= ?)`)
        .bind(newId, account_id, event.id, target.id, friend.id, current.status,
          current.customer_note, nowIso, current.identity_key, current.party_size,
          current.answer_snapshot_json, event.current_published_version_id, bookingSnapshotJson,
          current.id,current.lock_version, target.capacity, target.id, target.id, current.party_size, target.capacity),
      c.env.DB.prepare(`UPDATE event_bookings
            SET confirmation_revision = confirmation_revision + 1, status = 'cancelled', cancelled_at = ?, cancelled_by = 'friend', updated_at = ?
          WHERE id = ? AND status IN ('requested', 'confirmed') AND lock_version=?
            AND EXISTS (SELECT 1 FROM event_bookings WHERE id = ?)`)
        .bind(nowIso, nowIso, current.id,current.lock_version, newId),
      await transferEventEntitlement(c.env.DB,account_id,current.id,newId,target.starts_at),
      c.env.DB.prepare("UPDATE event_booking_transition_runs SET action='change_from',input_snapshot=json_set(input_snapshot,'$.replacementId',?) WHERE booking_id=? AND booking_version=(SELECT lock_version FROM event_bookings WHERE id=?) AND status='pending'").bind(newId,current.id,current.id),
      replacementEventTransition(c.env.DB,current.id,newId),
    ]);
    if ((moved[0].meta?.changes ?? 0) === 0) {
      const latest = await c.env.DB.prepare('SELECT status FROM event_bookings WHERE id = ?')
        .bind(current.id).first<{ status: string }>();
      return finalize(409, { error: latest && ['requested','confirmed'].includes(latest.status) ? 'slot_full' : 'invalid_state' });
    }

    // 旧回の未送信予定を止める。送信権の貸出中は新旧とも巻き戻して 409。
    try {
      await cancelByTrigger(c.env.DB, {
        triggerType: 'event',
        sourceId: current.id,
        sourceEventId: current.id,
        friendId: friend.id,
        startsAtIso: current.slot_starts_at,
        lineAccountId: current.line_account_id,
        cancelReason: `event_change:${current.id}:by:friend`,
        failOnSendInFlight: true,
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'REMINDER_SEND_IN_FLIGHT') {
        await c.env.DB.batch([
          await transferEventEntitlement(c.env.DB,account_id,newId,current.id,current.slot_starts_at),
          c.env.DB.prepare(`DELETE FROM event_bookings WHERE id = ?`).bind(newId),
          c.env.DB.prepare(
            `UPDATE event_bookings
                SET confirmation_revision = confirmation_revision + 1, status = ?, cancelled_at = NULL, cancelled_by = NULL, updated_at = ?
              WHERE id = ? AND status = 'cancelled' AND lock_version=?`,
          )
          .bind(current.status, nowIso, current.id,current.lock_version+1),
        ]);
        return finalize(409, { error: 'send_in_flight_retry' });
      }
      throw error;
    }
    await cancelPendingRemindersFor(c.env.DB, current.id);
    if (current.status === 'confirmed') {
      const reminders = computeRemindersForBooking({
        starts_at_utc: target.starts_at,
        reminder_day_before_enabled: event.reminder_day_before_enabled === 1,
        reminder_hours_before: event.reminder_hours_before,
      });
      await insertRemindersForBooking(c.env.DB, newId, reminders);
      await enrollByTrigger(c.env.DB, {
        triggerType: 'event',
        friendId: friend.id,
        startsAtIso: target.starts_at,
        sourceId: newId,
        sourceEventId: newId,
        eventId: event.id,
        lineAccountId: account_id,
      }).catch((err) => logger.error("events.run_change_flow_failed"));
    }
    // 空いた旧回の席を待ちへ回す（取消と同じ1回だけの起動）。
    await enqueueEventWaitlistPromotion(c.env.DB, {
      lineAccountId: current.line_account_id,
      eventId: current.event_id,
      occurrenceId: current.slot_id,
      sourceKey: `booking-change:${newId}`,
    });
    await writeEventChangeLog(c.env.DB, {
      lineAccountId: account_id,
      eventId: event.id,
      slotId: target.id,
      actorId: friend.id,
      actorRole: 'friend',
      action: 'booking_change',
      beforeJson: JSON.stringify({ booking_id: current.id, slot_id: current.slot_id }),
      afterJson: JSON.stringify({ booking_id: newId, slot_id: target.id }),
      idempotencyKey: idemKey,
      nowIso,
    });
    return finalize(200, { id: newId, status: current.status });
  }
});
}
