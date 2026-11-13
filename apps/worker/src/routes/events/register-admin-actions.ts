import { logger } from '@line-crm/shared/server';
import type { Env } from '../../worker-env.js';
import type { Hono } from 'hono';
import { prepareConfirmedEventBooking } from '../../services/event-notification-plan.js';
import { bad } from '../../services/event-input-error.js';
import { inputJsonBoundary } from '../../lib/input-errors.js';
import { requireRole } from '../../middleware/role-guard.js';
import { cancelByTrigger, enrollByTrigger } from '../../services/reminder-trigger.js';
import { computeRemindersForBooking, insertRemindersForBooking, cancelPendingRemindersFor } from '../../services/event-booking-reminders.js';
import { canTransition, nextStatus, type EventBookingAction } from '../../services/event-booking-state.js';
import { dispatchAutomationEventWithLogging } from '../../features/automations/automation-triggers/index.js';
import { enqueueEventWaitlistPromotion, getEventOccurrenceUsedSeats } from '../../services/event-waitlist.js';
import { getAccountId, optionalExecutionCtx } from './input.js';
import { ownsEvent } from './slot-input.js';
import { loadBookingForAction, repairRejectedBookingV6, notifyBookingFriend } from './booking-actions.js';

export function registerAdminActions(events: Hono<Env>): void {
events.post('/api/events/admin/events/:id/bookings/:bookingId/decide', requireRole('owner', 'admin', 'staff'), inputJsonBoundary(), async (c) => {
  const account_id = getAccountId(c);
  if (!account_id) return bad(c, 'account_id_required', 400, []);
  const event_id = c.req.param('id');
  if (!(await ownsEvent(c.env.DB, event_id, account_id))) return bad(c, 'not_found', 404);
  const booking = await loadBookingForAction(c.env.DB, account_id, event_id, c.req.param('bookingId'));
  if (!booking) return bad(c, 'not_found', 404);

  const body = (await c.req.json().catch(() => ({}))) as { action?: string; reason?: string };
  if (body.action !== 'confirm' && body.action !== 'reject') {
    return bad(c, 'invalid_action', 422, ["action"]);
  }
  const action: EventBookingAction = body.action;
  if (booking.decided_at != null) {
    // 落選ずみへの却下の再送は 修復を受け付ける (状態更新後の 失敗を
    // 回復するため。修復不能な 409 にしない)。承認の再送・競合敗北は 409。
    if (action === 'reject' && booking.status === 'rejected') {
      try {
        await repairRejectedBookingV6(c.env.DB, booking, `event_reject:${booking.id}:by:${c.get('staff')?.id ?? 'admin'}-retry`);
      } catch (error) {
        if (error instanceof Error && error.message === 'REMINDER_SEND_IN_FLIGHT') {
          return bad(c, 'send_in_flight_retry', 409);
        }
        throw error;
      }
      // 初回の待機者ジョブ登録が失敗したままのとき、同じ却下要求の再送で
      // 再登録する (修復だけの早期returnでは待機者が進まない)。
      // source_key が同じため二重登録にならない。
      await enqueueEventWaitlistPromotion(c.env.DB, {
        lineAccountId: booking.line_account_id,
        eventId: booking.event_id,
        occurrenceId: booking.slot_id,
        sourceKey: `booking:${booking.id}:rejected`,
      });
      const updated = await c.env.DB
        .prepare(`SELECT * FROM event_bookings WHERE id = ?`)
        .bind(booking.id)
        .first();
      return c.json(updated);
    }
    return bad(c, 'already_decided', 409);
  }
  if (!canTransition(booking.status as never, action)) return bad(c, 'invalid_state', 409);
  const next = nextStatus(booking.status as never, action);

  // 承認する前に枠の残席を確かめる。使われている席の数には、この承認待ち
  // 自身が入っている。LIFFの即時予約側は同じ数え方で締めている。管理者が
  // 待ちを全部承認しても定員を超えた確定を作らない。条件付き更新は残す。
  if (action === 'confirm') {
    const slotRow = await c.env.DB
      .prepare(`SELECT capacity FROM event_slots WHERE id = ?`)
      .bind(booking.slot_id)
      .first<{ capacity: number | null }>();
    if (slotRow?.capacity != null) {
      const usedSeats = await getEventOccurrenceUsedSeats(c.env.DB, booking.slot_id);
      if (usedSeats > slotRow.capacity) return bad(c, 'slot_full', 409);
    }
  }

  const nowIso = new Date().toISOString();
  const staff = c.get('staff');
  // 同時に承認されないよう requested を条件に更新する。changes=0 の要求は既に判断済みとして扱う。
  const plans=action==='confirm'?await prepareConfirmedEventBooking(c.env.DB,booking.id,new Date(nowIso)):[];
  const decision = await c.env.DB.batch([c.env.DB
    .prepare(
      `UPDATE event_bookings
          SET confirmation_revision = confirmation_revision + 1, status = ?, decided_at = ?, decided_by_staff_id = ?, updated_at = ?
        WHERE id = ? AND status = ? AND decided_at IS NULL AND lock_version=?`,
    )
    .bind(next, nowIso, staff?.id ?? null, nowIso, booking.id, booking.status,booking.lock_version),...plans]).catch(error=>{if(error instanceof Error&&error.message.includes('entitlement_unavailable'))return null;throw error;});
  if(!decision)return bad(c,'entitlement_unavailable',409);
  const [upd]=decision;
  if ((upd.meta?.changes ?? 0) === 0) {
    // 同時確定との競合敗北は成功にしない。落選ずみへの承認は 409。
    // 落選ずみへの却下の再送だけ 修復を受け付けて 200 にする。
    const current = await c.env.DB
      .prepare(`SELECT status FROM event_bookings WHERE id = ?`)
      .bind(booking.id)
      .first<{ status: string }>();
    if (action === 'reject' && current?.status === 'rejected') {
      try {
        await repairRejectedBookingV6(c.env.DB, booking, `event_reject:${booking.id}:by:${staff?.id ?? 'admin'}-retry`);
      } catch (error) {
        if (error instanceof Error && error.message === 'REMINDER_SEND_IN_FLIGHT') {
          return bad(c, 'send_in_flight_retry', 409);
        }
        throw error;
      }
      // 同時確定の競合敗北後の再送でも、待機者ジョブの再登録を受け付ける
      // (決定ゲートの再送枝と同趣旨。二重登録は source_key で吸収する)。
      await enqueueEventWaitlistPromotion(c.env.DB, {
        lineAccountId: booking.line_account_id,
        eventId: booking.event_id,
        occurrenceId: booking.slot_id,
        sourceKey: `booking:${booking.id}:rejected`,
      });
      const updated = await c.env.DB
        .prepare(`SELECT * FROM event_bookings WHERE id = ?`)
        .bind(booking.id)
        .first();
      return c.json(updated);
    }
    return bad(c, 'already_decided', 409);
  }

  if (action === 'reject' && body.reason) {
    await c.env.DB
      .prepare(
        `UPDATE event_bookings
            SET confirmation_revision = confirmation_revision + 1, internal_note = COALESCE(internal_note || char(10), '') || ?,
                updated_at = ?
          WHERE id = ?`,
      )
      .bind(`[reject reason] ${body.reason}`, nowIso, booking.id)
      .run();
  }

  if (action === 'confirm') {
    const slot = await c.env.DB
      .prepare(`SELECT starts_at FROM event_slots WHERE id = ?`)
      .bind(booking.slot_id)
      .first<{ starts_at: string }>();
    const evRow = await c.env.DB
      .prepare(
        `SELECT reminder_day_before_enabled, reminder_hours_before FROM events WHERE id = ?`,
      )
      .bind(booking.event_id)
      .first<{ reminder_day_before_enabled: number; reminder_hours_before: number | null }>();
    if (slot && evRow) {
      const reminders = computeRemindersForBooking({
        starts_at_utc: slot.starts_at,
        reminder_day_before_enabled: evRow.reminder_day_before_enabled === 1,
        reminder_hours_before: evRow.reminder_hours_before,
      });
      await insertRemindersForBooking(c.env.DB, booking.id, reminders);
      // 承認で確定した予約も へ登録する (source 連動つき)。
      // 登録失敗で承認自体を壊さない。二重登録は enroll 側で吸収する。
      await enrollByTrigger(c.env.DB, {
        triggerType: 'event',
        friendId: booking.friend_id,
        startsAtIso: slot.starts_at,
        sourceId: booking.id,
        sourceEventId: booking.id,
        eventId: booking.event_id,
        lineAccountId: booking.line_account_id,
      }).catch((err) => logger.error("events.admin_events_by_id_bookings_by_booking_id_decide_create_failed"));
    }
    optionalExecutionCtx(c)?.waitUntil(
      dispatchAutomationEventWithLogging(c.env.DB, {
        lineAccountId: booking.line_account_id,
        eventType: 'calendar_booked',
        sourceEventId: booking.id,
        friendId: booking.friend_id,
        eventData: {
          bookingType: 'event', bookingId: booking.id,
          eventId: booking.event_id, slotId: booking.slot_id,
        },
      })
        .catch((error) => logger.error("events.admin_events_by_id_bookings_by_booking_id_decide_create_failed")),
    );
  }
  if (action === 'reject') {
    // 落選した予約の 未送信予定だけを止める。
    // 送信権の貸出中は状態更新を巻き戻して 409 にする。貸出中の送信は
    // 確定ずみの予約への送信になるため正当で、再試行は巻き戻し後の状態から
    // 再開する (再送の修復受付も残す)。
    try {
      await repairRejectedBookingV6(c.env.DB, booking, `event_reject:${booking.id}:by:${c.get('staff')?.id ?? 'admin'}`);
    } catch (error) {
      if (error instanceof Error && error.message === 'REMINDER_SEND_IN_FLIGHT') {
        await c.env.DB
          .prepare(
            `UPDATE event_bookings
                SET confirmation_revision = confirmation_revision + 1, status = 'requested', decided_at = NULL,
                    decided_by_staff_id = NULL, updated_at = ?
              WHERE id = ? AND status = 'rejected' AND lock_version=?`,
          )
          .bind(nowIso, booking.id,booking.lock_version+1)
          .run();
        return bad(c, 'send_in_flight_retry', 409);
      }
      throw error;
    }
    await enqueueEventWaitlistPromotion(c.env.DB, {
      lineAccountId: booking.line_account_id,
      eventId: booking.event_id,
      occurrenceId: booking.slot_id,
      sourceKey: `booking:${booking.id}:rejected`,
    });
  }

  await notifyBookingFriend(c.env.DB, booking.id, action === 'confirm' ? 'confirmed' : 'rejected');
  const updated = await c.env.DB
    .prepare(`SELECT * FROM event_bookings WHERE id = ?`)
    .bind(booking.id)
    .first();
  return c.json(updated);
});

events.post('/api/events/admin/events/:id/bookings/:bookingId/cancel', requireRole('owner', 'admin', 'staff'), inputJsonBoundary(), async (c) => {
  const account_id = getAccountId(c);
  if (!account_id) return bad(c, 'account_id_required', 400, []);
  const event_id = c.req.param('id');
  if (!(await ownsEvent(c.env.DB, event_id, account_id))) return bad(c, 'not_found', 404);
  const booking = await loadBookingForAction(c.env.DB, account_id, event_id, c.req.param('bookingId'));
  if (!booking) return bad(c, 'not_found', 404);
  // 再試行の受付: 取消が投げた直後の再送は だけ直す (409 にしない)。
  // 送信権の貸出中は 409 で再試行させる。
  if (booking.status === 'cancelled') {
    const slot = await c.env.DB
      .prepare(`SELECT starts_at FROM event_slots WHERE id = ?`)
      .bind(booking.slot_id)
      .first<{ starts_at: string }>();
    try {
      await cancelByTrigger(c.env.DB, {
        triggerType: 'event',
        sourceId: booking.id,
        sourceEventId: booking.id,
        friendId: booking.friend_id,
        startsAtIso: slot?.starts_at ?? null,
        lineAccountId: booking.line_account_id,
        cancelReason: `event_cancel:${booking.id}:by:${c.get('staff')?.id ?? 'admin'}-retry`,
        failOnSendInFlight: true,
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'REMINDER_SEND_IN_FLIGHT') {
        return bad(c, 'send_in_flight_retry', 409);
      }
      throw error;
    }
    // 初回の途中失敗で旧表だけ未取消のまま残ることがある。同じ取消要求の
    // 再送でそろえる (fence 成功後なので 409 で巻き戻す物は無い)。
    await cancelPendingRemindersFor(c.env.DB, booking.id);
    // 初回の取消確定後に待機者ジョブ登録だけ失敗しても、
    // 同じ取消要求の再送で復旧する。source_key が重複登録を吸収する。
    await enqueueEventWaitlistPromotion(c.env.DB, {
      lineAccountId: booking.line_account_id,
      eventId: booking.event_id,
      occurrenceId: booking.slot_id,
      sourceKey: `booking:${booking.id}:cancelled`,
    });
    return c.json({ ok: true });
  }
  if (!canTransition(booking.status as never, 'cancel')) return bad(c, 'invalid_state', 409);

  const nowIso = new Date().toISOString();
  // 出席・欠席・本人取消が先に確定した場合を上書きしないよう、状態を条件に更新する。
  const upd = await c.env.DB
    .prepare(
      `UPDATE event_bookings
          SET confirmation_revision = confirmation_revision + 1, status = 'cancelled', cancelled_at = ?, cancelled_by = 'admin', updated_at = ?
        WHERE id = ? AND status = ? AND lock_version=?`,
    )
    .bind(nowIso, nowIso, booking.id, booking.status,booking.lock_version)
    .run();
  if ((upd.meta?.changes ?? 0) === 0) return bad(c, 'invalid_state', 409);
  const slot = await c.env.DB
    .prepare(`SELECT starts_at FROM event_slots WHERE id = ?`)
    .bind(booking.slot_id)
    .first<{ starts_at: string }>();
  // の未送信予定だけを止める。送信済み履歴は残す。
  // 旧表の取消は fence 成功の後に回す (409 の完全 rollback のため)。
  // 送信権の貸出中は状態更新を巻き戻して 409 にする (取消確定後の送信を起こさない)。
  try {
    await cancelByTrigger(c.env.DB, {
      triggerType: 'event',
      sourceId: booking.id,
      sourceEventId: booking.id,
      friendId: booking.friend_id,
      startsAtIso: slot?.starts_at ?? null,
      lineAccountId: booking.line_account_id,
      cancelReason: `event_cancel:${booking.id}:by:${c.get('staff')?.id ?? 'admin'}`,
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
        .bind(booking.status, nowIso, booking.id,booking.lock_version+1)
        .run();
      return bad(c, 'send_in_flight_retry', 409);
    }
    throw error;
  }
  // 旧表の取消は fence 成功の後 (409 では触らない)。
  await cancelPendingRemindersFor(c.env.DB, booking.id);
  await enqueueEventWaitlistPromotion(c.env.DB, {
    lineAccountId: booking.line_account_id,
    eventId: booking.event_id,
    occurrenceId: booking.slot_id,
    sourceKey: `booking:${booking.id}:cancelled`,
  });
  await notifyBookingFriend(c.env.DB, booking.id, 'cancelled_by_admin');
  return c.json({ ok: true });
});

events.put('/api/events/admin/events/:id/bookings/:bookingId', requireRole('owner', 'admin', 'staff'), inputJsonBoundary(), async (c) => {
  const account_id = getAccountId(c);
  if (!account_id) return bad(c, 'account_id_required', 400, []);
  const event_id = c.req.param('id');
  if (!(await ownsEvent(c.env.DB, event_id, account_id))) return bad(c, 'not_found', 404);
  const booking = await loadBookingForAction(c.env.DB, account_id, event_id, c.req.param('bookingId'));
  if (!booking) return bad(c, 'not_found', 404);

  const body = (await c.req.json().catch(() => ({}))) as { internal_note?: string | null; status?: string };
  const setClauses: string[] = [];
  const setValues: unknown[] = [];

  if ('internal_note' in body) {
    // 顧客メモと同等の上限(点検軽14)。無制限だと一覧が重くなる。
    if (typeof body.internal_note === 'string' && body.internal_note.length > 5000) {
      return bad(c, 'invalid_internal_note', 422, ["internal_note"]);
    }
    setClauses.push('internal_note = ?');
    setValues.push(body.internal_note ?? null);
  }
  if (body.status === 'no_show' || body.status === 'attended') {
    const action: EventBookingAction = body.status === 'attended' ? 'mark_attended' : 'mark_no_show';
    if (!canTransition(booking.status as never, action)) return bad(c, 'invalid_state', 409);
    setClauses.push('status = ?');
    setValues.push(body.status);
  } else if (body.status != null) {
    return bad(c, 'invalid_status', 422, ["status"]);
  }
  if (setClauses.length === 0) {
    const row = await c.env.DB.prepare(`SELECT * FROM event_bookings WHERE id = ?`).bind(booking.id).first();
    return c.json(row);
  }
  setClauses.push(`updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`);
  setValues.push(booking.id, booking.status);
  // 承認・取消と同じく、id と状態を更新条件に含めて競合を防ぐ。
  const upd = await c.env.DB
    .prepare(`UPDATE event_bookings SET confirmation_revision = confirmation_revision + 1, ${setClauses.join(', ')} WHERE id = ? AND status = ?`)
    .bind(...setValues)
    .run();
  if ((upd.meta?.changes ?? 0) === 0) return bad(c, 'invalid_state', 409);
  const row = await c.env.DB.prepare(`SELECT * FROM event_bookings WHERE id = ?`).bind(booking.id).first();
  return c.json(row);
});
}
