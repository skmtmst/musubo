import { liffBookingJson, liffBookingResponse } from '../liff-booking-response.js';
import type { Env } from '../../worker-env.js';
import type { Hono } from 'hono';
import { bad } from '../../services/event-input-error.js';
import { inputJsonBoundary } from '../../lib/input-errors.js';
import { cancelByTrigger } from '../../services/reminder-trigger.js';
import { verifyCallerLineUserId } from '../../services/liff-auth.js';
import { cancelPendingRemindersFor } from '../../services/event-booking-reminders.js';
import { getMyEventWaitlist, cancelMyEventWaitlist, enqueueEventWaitlistPromotion } from '../../services/event-waitlist.js';
import { resolveAccountIdFromLiff } from './input.js';
import { eventWaitlistCaller } from './liff-input.js';
import { eventBookingMakeupView } from './history-makeup.js';

export function registerLiffHistory(events: Hono<Env>): void {
// me が動的 ID と解釈されないよう、本人の履歴と取消を /:id より先に登録する。

events.get('/api/liff/events/me', async (c) => {
  const account_id = await resolveAccountIdFromLiff(c);
  if (!account_id) return liffBookingResponse(c, bad(c, 'liff_account_resolution_failed', 400));
  const callerLineUserId = await verifyCallerLineUserId(c.req.header('Authorization'), c.env, account_id);
  if (!callerLineUserId) return liffBookingResponse(c, bad(c, 'unauthorized', 401));
  const friend = await c.env.DB
    .prepare(`SELECT id FROM friends WHERE line_user_id = ? AND line_account_id = ?`)
    .bind(callerLineUserId, account_id)
    .first<{ id: string }>();
  if (!friend) return liffBookingJson(c, { items: [] });

  const tab = c.req.query('tab') === 'past' ? 'past' : 'upcoming';
  const nowIso = new Date().toISOString();
  const sql =
    tab === 'upcoming'
      ? `SELECT b.id,b.lock_version,(SELECT entitlement_id FROM event_booking_entitlement_uses u WHERE u.event_booking_id=b.id) AS entitlement_id, b.event_id, b.status, b.customer_note, b.requested_at, b.decided_at, b.cancelled_at,
                CASE WHEN b.event_snapshot_json IS NOT NULL THEN json_extract(b.event_snapshot_json, '$.eventName') ELSE e.name END AS event_name,
                CASE WHEN b.event_snapshot_json IS NOT NULL THEN json_extract(b.event_snapshot_json, '$.eventImageUrl') ELSE e.image_url END AS event_image_url,
                CASE WHEN b.event_snapshot_json IS NOT NULL THEN json_extract(b.event_snapshot_json, '$.venueName') ELSE e.venue_name END AS venue_name,
                CASE WHEN b.event_snapshot_json IS NOT NULL THEN json_extract(b.event_snapshot_json, '$.venueAddress') ELSE e.venue_address END AS venue_address,
                CASE WHEN b.status = 'confirmed' THEN CASE WHEN b.event_snapshot_json IS NOT NULL THEN json_extract(b.event_snapshot_json, '$.venueUrl') ELSE e.venue_url END ELSE NULL END AS venue_url,
                CASE WHEN b.event_snapshot_json IS NOT NULL THEN json_extract(b.event_snapshot_json, '$.cancelDeadlineHoursBefore') ELSE e.cancel_deadline_hours_before END AS cancel_deadline_hours_before,
                CASE WHEN b.event_snapshot_json IS NOT NULL THEN json_extract(b.event_snapshot_json, '$.slotStartsAt') ELSE s.starts_at END AS slot_starts_at,
                CASE WHEN b.event_snapshot_json IS NOT NULL THEN json_extract(b.event_snapshot_json, '$.slotEndsAt') ELSE s.ends_at END AS slot_ends_at,
                e.makeup_rule_json AS _makeup_rule_json, s.starts_at AS _makeup_starts_at
           FROM event_bookings b
           JOIN events e ON e.id = b.event_id
           JOIN event_slots s ON s.id = b.slot_id
          WHERE b.friend_id = ?
            AND b.line_account_id = ?
            AND b.status IN ('requested','confirmed')
            AND CASE WHEN b.event_snapshot_json IS NOT NULL THEN json_extract(b.event_snapshot_json, '$.slotStartsAt') ELSE s.starts_at END >= ?
          ORDER BY slot_starts_at ASC`
      : `SELECT b.id,b.lock_version,(SELECT entitlement_id FROM event_booking_entitlement_uses u WHERE u.event_booking_id=b.id) AS entitlement_id, b.event_id, b.status, b.customer_note, b.requested_at, b.decided_at, b.cancelled_at,
                CASE WHEN b.event_snapshot_json IS NOT NULL THEN json_extract(b.event_snapshot_json, '$.eventName') ELSE e.name END AS event_name,
                CASE WHEN b.event_snapshot_json IS NOT NULL THEN json_extract(b.event_snapshot_json, '$.eventImageUrl') ELSE e.image_url END AS event_image_url,
                CASE WHEN b.event_snapshot_json IS NOT NULL THEN json_extract(b.event_snapshot_json, '$.venueName') ELSE e.venue_name END AS venue_name,
                CASE WHEN b.event_snapshot_json IS NOT NULL THEN json_extract(b.event_snapshot_json, '$.venueAddress') ELSE e.venue_address END AS venue_address,
                CASE WHEN b.status = 'confirmed' THEN CASE WHEN b.event_snapshot_json IS NOT NULL THEN json_extract(b.event_snapshot_json, '$.venueUrl') ELSE e.venue_url END ELSE NULL END AS venue_url,
                CASE WHEN b.event_snapshot_json IS NOT NULL THEN json_extract(b.event_snapshot_json, '$.cancelDeadlineHoursBefore') ELSE e.cancel_deadline_hours_before END AS cancel_deadline_hours_before,
                CASE WHEN b.event_snapshot_json IS NOT NULL THEN json_extract(b.event_snapshot_json, '$.slotStartsAt') ELSE s.starts_at END AS slot_starts_at,
                CASE WHEN b.event_snapshot_json IS NOT NULL THEN json_extract(b.event_snapshot_json, '$.slotEndsAt') ELSE s.ends_at END AS slot_ends_at,
                e.makeup_rule_json AS _makeup_rule_json, s.starts_at AS _makeup_starts_at
           FROM event_bookings b
           JOIN events e ON e.id = b.event_id
           JOIN event_slots s ON s.id = b.slot_id
          WHERE b.friend_id = ?
            AND b.line_account_id = ?
            AND (b.status NOT IN ('requested','confirmed') OR CASE WHEN b.event_snapshot_json IS NOT NULL THEN json_extract(b.event_snapshot_json, '$.slotStartsAt') ELSE s.starts_at END < ?)
          ORDER BY slot_starts_at DESC`;
  const { results } = await c.env.DB
    .prepare(sql)
    .bind(friend.id, account_id, nowIso)
    .all();
  const waiting = await getMyEventWaitlist(c.env.DB, { lineAccountId: account_id, callerLineUserId });
  const waitlistItems = waiting.filter(row => {
    // 予約化済みは予約の行に出るため二重に載せない。
    if (row.status === 'converted') return false;
    const upcoming = ['waiting', 'offered', 'accepted'].includes(row.status) && row.slot_starts_at >= nowIso;
    return tab === 'upcoming' ? upcoming : !upcoming;
  });
  // 予約に欠席の案内を足し、待ちの行は元のまま並べる。
  const items = [...(results ?? []).map(row => eventBookingMakeupView(row, Date.parse(nowIso))), ...waitlistItems] as Array<Record<string, unknown> & { slot_starts_at: string }>;
  items.sort((a, b) => tab === 'upcoming'
    ? a.slot_starts_at.localeCompare(b.slot_starts_at)
    : b.slot_starts_at.localeCompare(a.slot_starts_at));
  return liffBookingJson(c, { items });
});

events.get('/api/liff/events/me/waitlist', async (c) => {
  const caller = await eventWaitlistCaller(c);
  if (caller instanceof Response) return liffBookingResponse(c, caller);
  const items = await getMyEventWaitlist(c.env.DB, caller);
  return liffBookingJson(c, { items });
});

events.get('/api/liff/events/me/waitlist/:waitlistId', async (c) => {
  const caller = await eventWaitlistCaller(c);
  if (caller instanceof Response) return liffBookingResponse(c, caller);
  const items = await getMyEventWaitlist(c.env.DB, { ...caller, waitlistId: c.req.param('waitlistId') });
  if (!items[0]) return liffBookingResponse(c, bad(c, 'not_found', 404));
  return liffBookingJson(c, items[0]);
});

events.post('/api/liff/events/me/waitlist/:waitlistId/cancel', inputJsonBoundary(), async (c) => {
  const caller = await eventWaitlistCaller(c);
  if (caller instanceof Response) return liffBookingResponse(c, caller);
  const result = await cancelMyEventWaitlist(c.env.DB, { ...caller, waitlistId: c.req.param('waitlistId') });
  if (result === 'not_found') return liffBookingResponse(c, bad(c, 'not_found', 404));
  if (result === 'conflict') return liffBookingResponse(c, bad(c, 'waitlist_not_cancellable', 409));
  return liffBookingJson(c, { ok: true });
});

events.get('/api/liff/events/me/:bookingId', async (c) => {
  const account_id = await resolveAccountIdFromLiff(c);
  if (!account_id) return liffBookingResponse(c, bad(c, 'liff_account_resolution_failed', 400));
  const callerLineUserId = await verifyCallerLineUserId(c.req.header('Authorization'), c.env, account_id);
  if (!callerLineUserId) return liffBookingResponse(c, bad(c, 'unauthorized', 401));
  const friend = await c.env.DB
    .prepare(`SELECT id FROM friends WHERE line_user_id = ? AND line_account_id = ?`)
    .bind(callerLineUserId, account_id)
    .first<{ id: string }>();
  if (!friend) return liffBookingResponse(c, bad(c, 'not_found', 404));

  const row = await c.env.DB
    .prepare(
      `SELECT b.id,b.lock_version,(SELECT entitlement_id FROM event_booking_entitlement_uses u WHERE u.event_booking_id=b.id) AS entitlement_id, b.event_id, b.status, b.customer_note, b.requested_at, b.decided_at, b.cancelled_at,
              CASE WHEN b.event_snapshot_json IS NOT NULL THEN json_extract(b.event_snapshot_json, '$.eventName') ELSE e.name END AS event_name,
              CASE WHEN b.event_snapshot_json IS NOT NULL THEN json_extract(b.event_snapshot_json, '$.eventImageUrl') ELSE e.image_url END AS event_image_url,
              CASE WHEN b.event_snapshot_json IS NOT NULL THEN json_extract(b.event_snapshot_json, '$.venueName') ELSE e.venue_name END AS venue_name,
                CASE WHEN b.event_snapshot_json IS NOT NULL THEN json_extract(b.event_snapshot_json, '$.venueAddress') ELSE e.venue_address END AS venue_address,
              CASE WHEN b.status = 'confirmed' THEN CASE WHEN b.event_snapshot_json IS NOT NULL THEN json_extract(b.event_snapshot_json, '$.venueUrl') ELSE e.venue_url END ELSE NULL END AS venue_url,
              CASE WHEN b.event_snapshot_json IS NOT NULL THEN json_extract(b.event_snapshot_json, '$.cancelDeadlineHoursBefore') ELSE e.cancel_deadline_hours_before END AS cancel_deadline_hours_before,
              CASE WHEN b.event_snapshot_json IS NOT NULL THEN json_extract(b.event_snapshot_json, '$.eventDescription') ELSE e.description END AS event_description,
              CASE WHEN b.status = 'confirmed' THEN CASE WHEN b.event_snapshot_json IS NOT NULL THEN json_extract(b.event_snapshot_json, '$.confirmationMessageExtra') ELSE e.confirmation_message_extra END ELSE NULL END AS confirmation_message_extra,
              CASE WHEN b.event_snapshot_json IS NOT NULL THEN json_extract(b.event_snapshot_json, '$.slotStartsAt') ELSE s.starts_at END AS slot_starts_at,
              CASE WHEN b.event_snapshot_json IS NOT NULL THEN json_extract(b.event_snapshot_json, '$.slotEndsAt') ELSE s.ends_at END AS slot_ends_at,
                e.makeup_rule_json AS _makeup_rule_json, s.starts_at AS _makeup_starts_at
         FROM event_bookings b
         JOIN events e ON e.id = b.event_id
         JOIN event_slots s ON s.id = b.slot_id
        WHERE b.id = ?
          AND b.friend_id = ?
          AND b.line_account_id = ?`,
    )
    .bind(c.req.param('bookingId'), friend.id, account_id)
    .first();
  if (!row) return liffBookingResponse(c, bad(c, 'not_found', 404));
  return liffBookingJson(c, eventBookingMakeupView(row, Date.now()));
});

events.post('/api/liff/events/me/:bookingId/cancel', inputJsonBoundary(), async (c) => {
  const account_id = await resolveAccountIdFromLiff(c);
  if (!account_id) return liffBookingResponse(c, bad(c, 'liff_account_resolution_failed', 400, []));
  const callerLineUserId = await verifyCallerLineUserId(c.req.header('Authorization'), c.env, account_id);
  if (!callerLineUserId) return liffBookingResponse(c, bad(c, 'unauthorized', 401));
  const friend = await c.env.DB
    .prepare(`SELECT id FROM friends WHERE line_user_id = ? AND line_account_id = ?`)
    .bind(callerLineUserId, account_id)
    .first<{ id: string }>();
  if (!friend) return liffBookingResponse(c, bad(c, 'friend_not_found', 404));

  const row = await c.env.DB
    .prepare(
      `SELECT b.id,b.lock_version, b.status, b.line_account_id, b.event_id, b.slot_id,
              CASE WHEN b.event_snapshot_json IS NOT NULL THEN json_extract(b.event_snapshot_json, '$.cancelDeadlineHoursBefore') ELSE e.cancel_deadline_hours_before END AS cancel_deadline_hours_before,
              CASE WHEN b.event_snapshot_json IS NOT NULL THEN json_extract(b.event_snapshot_json, '$.slotStartsAt') ELSE s.starts_at END AS slot_starts_at
         FROM event_bookings b
         JOIN events e ON e.id = b.event_id
         JOIN event_slots s ON s.id = b.slot_id
        WHERE b.id = ? AND b.friend_id = ? AND b.line_account_id = ?`,
    )
    .bind(c.req.param('bookingId'), friend.id, account_id)
    .first<{
      id: string;
      status: string;
      lock_version:number;
      line_account_id: string;
      event_id: string;
      slot_id: string;
      cancel_deadline_hours_before: number | null;
      slot_starts_at: string;
    }>();
  if (!row) return liffBookingResponse(c, bad(c, 'not_found', 404));
  const nowIso = new Date().toISOString();
  const waitlistParams = {
    lineAccountId: row.line_account_id,
    eventId: row.event_id,
    occurrenceId: row.slot_id,
    sourceKey: `booking:${row.id}:cancelled`,
  };
  // 再試行の受付: 取消が投げた直後の再送は だけ直す。
  // 送信権の貸出中は 409 で再試行させる (strict fence。live claim を残して
  // 成功にしない)。待機者ジョブの再登録も受け付ける (二重登録なし)。
  if (row.status === 'cancelled') {
    try {
      await cancelByTrigger(c.env.DB, {
        triggerType: 'event',
        sourceId: row.id,
        sourceEventId: row.id,
        friendId: friend.id,
        startsAtIso: row.slot_starts_at,
        lineAccountId: row.line_account_id,
        cancelReason: `event_cancel:${row.id}:by:friend-retry`,
        failOnSendInFlight: true,
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'REMINDER_SEND_IN_FLIGHT') {
        return liffBookingResponse(c, bad(c, 'send_in_flight_retry', 409));
      }
      throw error;
    }
    // 初回の途中失敗で旧表だけ未取消のまま残ることがある。同じ取消要求の
    // 再送でそろえる (fence 成功後なので 409 で巻き戻す物は無い)。
    await cancelPendingRemindersFor(c.env.DB, row.id);
    await enqueueEventWaitlistPromotion(c.env.DB, waitlistParams);
    return liffBookingJson(c, { ok: true });
  }
  if (row.status !== 'requested' && row.status !== 'confirmed') return liffBookingResponse(c, bad(c, 'invalid_state', 409));
  if (row.cancel_deadline_hours_before == null) return liffBookingResponse(c, bad(c, 'cancel_not_allowed', 403));
  const deadlineMs =
    new Date(row.slot_starts_at).getTime() - row.cancel_deadline_hours_before * 3600_000;
  if (deadlineMs <= Date.now()) return liffBookingResponse(c, bad(c, 'cancel_deadline_passed', 409));

  // 条件付き状態更新: 同時取消の race を防ぐ。0 件なら相手に任せて再試行させる。
  const priorStatus = row.status;
  const upd = await c.env.DB
    .prepare(
      `UPDATE event_bookings
          SET confirmation_revision = confirmation_revision + 1, status = 'cancelled', cancelled_at = ?, cancelled_by = 'friend', updated_at = ?
        WHERE id = ? AND status IN ('requested', 'confirmed') AND lock_version=?`,
    )
    .bind(nowIso, nowIso, row.id,row.lock_version)
    .run();
  if ((upd.meta?.changes ?? 0) === 0) return liffBookingResponse(c, bad(c, 'invalid_state', 409));
  // の未送信予定だけを止める。送信済み履歴は残す。
  // 旧表の取消は fence 成功の後に回す (409 では旧表も含めて完全 rollback)。
  // 送信権の貸出中は状態更新を巻き戻して 409 にする
  // (取消確定後の送信を起こさない)。
  try {
    await cancelByTrigger(c.env.DB, {
      triggerType: 'event',
      sourceId: row.id,
      sourceEventId: row.id,
      friendId: friend.id,
      startsAtIso: row.slot_starts_at,
      lineAccountId: row.line_account_id,
      cancelReason: `event_cancel:${row.id}:by:friend`,
      failOnSendInFlight: true,
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'REMINDER_SEND_IN_FLIGHT') {
      await c.env.DB
        .prepare(
          `UPDATE event_bookings
              SET confirmation_revision = confirmation_revision + 1, status = ?, cancelled_at = NULL, cancelled_by = NULL, updated_at = ?
            WHERE id = ? AND status = 'cancelled' AND lock_version=? AND NOT EXISTS(SELECT 1 FROM event_booking_transition_runs t WHERE t.booking_id=event_bookings.id AND t.booking_version=event_bookings.lock_version AND t.status='complete') AND NOT EXISTS(SELECT 1 FROM event_booking_entitlement_uses u WHERE u.event_booking_id=event_bookings.id AND u.returned_at IS NOT NULL)`,
        )
        .bind(priorStatus, nowIso, row.id,row.lock_version+1)
        .run();
      return liffBookingResponse(c, bad(c, 'send_in_flight_retry', 409));
    }
    throw error;
  }
  // 旧表の取消は fence 成功の後 (409 では旧表も含めて完全 rollback)。
  await cancelPendingRemindersFor(c.env.DB, row.id);
  await enqueueEventWaitlistPromotion(c.env.DB, waitlistParams);
  return liffBookingJson(c, { ok: true });
});
}
