import { logger } from '@line-crm/shared/server';
import type { Env } from '../../worker-env.js';
import type { Hono } from 'hono';
import { notifyForBooking } from '../../features/booking/booking-notification/index.js';
import { confirmationWorkflowStatement, runConfirmedBookingSideEffects } from '../../features/booking/booking-confirmed-effects/index.js';
import { inputError, inputJsonBoundary } from '../../lib/input-errors.js';
import { requireRole } from '../../middleware/role-guard.js';
import { cancelByTrigger } from '../../services/reminder-trigger.js';
import { canTransition, nextStatus, type BookingAction } from '../../features/booking/booking-state/index.js';
import { enqueueCalendarDeleteOperation, removeBookingFromGoogle, runCalendarDeleteOperation } from '../../features/booking/booking-calendar-sync/index.js';
import { fireOutgoingWebhooks } from '../../services/event-bus.js';
import { type BookingStatus } from '../../features/booking/booking-types/index.js';
import { recordBookingAudit } from '@line-crm/db';
import { promoteBookingWaitlist } from '../../features/booking/booking-waitlist/index.js';
import { resolveAccountIdAdmin } from './identity.js';
import { cancelLegacyBookingReminders, cancelObsoleteConfirmationRuns } from './ledger-input.js';
import { googleCredentials } from './availability.js';
import { staffAuditActor } from './notification-input.js';

export function registerDecisions(booking: Hono<Env>): void {
booking.patch('/api/booking/admin/requests/:id', requireRole('owner', 'admin', 'staff'), inputJsonBoundary({"action":["string"]}), async (c) => {
  const accountId = await resolveAccountIdAdmin(c);
  if (!accountId) return inputError(c, { error: 'missing_account_id' }, 400, ["account_id"]);
  const id = c.req.param('id');
  const b = await c.req.json<{ action: BookingAction; cancellationReason?:'store'|'customer' }>();
  if(b.cancellationReason!==undefined&&!['store','customer'].includes(b.cancellationReason))return c.json({error:'invalid_cancellation_reason'},400);
  const row = await c.env.DB
    .prepare(
      `SELECT id, status, starts_at, friend_id, menu_id, staff_id, decided_at
         FROM bookings WHERE id = ? AND line_account_id = ?`,
    )
    .bind(id, accountId)
    .first<{
      id: string;
      status: BookingStatus;
      starts_at: string;
      friend_id: string | null;
      menu_id: string;
      staff_id: string;
      decided_at: string | null;
    }>();
  if (!row) return c.json({ error: 'not_found' }, 404);
  // 再試行の受付: 取消が投げた直後の再送は、業務が済みでも だけ直す (409 にしない)。
  // Calendar 削除も同じ鍵の台帳で再試行する (ずみなら触らず、一時失敗なら再実行)。
  // 却下ずみの再送も受け付ける (却下は終端のため通常遷移では 409 になる)。
  const isCancelRetry =
    (b.action === 'cancel' || b.action === 'expire') &&
    (row.status === 'cancelled' || row.status === 'expired');
  const isRejectRetry = b.action === 'reject' && row.status === 'rejected';
  if (isCancelRetry || isRejectRetry) {
    try {
      await cancelByTrigger(c.env.DB, {
        triggerType: 'booking',
        sourceId: id,
        sourceEventId: id,
        friendId: row.friend_id,
        startsAtIso: row.starts_at,
        lineAccountId: accountId,
        cancelReason: `booking_${row.status}:${id}:by:${c.get('staff')?.id ?? 'admin'}-retry`,
        failOnSendInFlight: true,
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'REMINDER_SEND_IN_FLIGHT') {
        return c.json({ error: 'send_in_flight_retry' }, 409);
      }
      throw error;
    }
    // 却下では Calendar 予定を作らないため削除の再試行は要らない。
    if (isCancelRetry) {
      // 初回の途中失敗で旧表だけ未取消のまま残ることがある。同じ取消要求の
      // 再送でそろえる (fence 成功後なので 409 で巻き戻す物は無い)。
      await cancelLegacyBookingReminders(c.env.DB, id);
      // 台帳行が durable に残るまで成功応答しない。enqueue の DB 失敗は
      // 落とさず投げ (連続失敗でも台帳なし200にしない)、再送で回復する。
      // 行さえあれば実行の一時失敗は retry_wait に残り cron が拾う。
      await enqueueCalendarDeleteOperation(c.env.DB, { bookingId: id, lineAccountId: accountId });
      await runCalendarDeleteOperation(c.env.DB, {
        bookingId: id,
        lineAccountId: accountId,
        remove: () => removeBookingFromGoogle(c.env.DB, googleCredentials(c.env), id),
      });
    }
    return c.json({ status: row.status });
  }
  if (!canTransition(row.status, b.action)) {
    return c.json({ error: 'invalid_transition' }, 409);
  }
  const next = nextStatus(row.status, b.action);
  // 条件付き UPDATE: 同時 PATCH の race を防ぐ。changes=0 のときは別オペレータが先に
  // 状態を変えたので 409 を返し、副作用（reminders 作成・通知）は走らせない。
  const updateStatement = c.env.DB
    .prepare(
      `UPDATE bookings SET confirmation_revision = confirmation_revision + 1, status = ?, decided_at = ?, cancellation_reason=COALESCE(?,cancellation_reason),
                            updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')
        WHERE id = ? AND status = ?`,
    )
    .bind(next, new Date().toISOString(), next==='cancelled'?b.cancellationReason??null:null, id, row.status);
  let updateResult: D1Result;
  try { [updateResult] = await c.env.DB.batch([
    updateStatement, ...(next === 'confirmed' ? [confirmationWorkflowStatement(c.env.DB, id, true)] : []),
  ]); } catch(error) {
    if(error instanceof Error && error.message.includes('entitlement_unavailable'))return c.json({error:'entitlement_unavailable'},409);
    throw error;
  }
  if ((updateResult.meta?.changes ?? 0) === 0) {
    return c.json({ error: 'concurrent_update' }, 409);
  }

  if (next === 'confirmed') {
    await runConfirmedBookingSideEffects(c.env.DB, id, { credentials: googleCredentials(c.env) });
    // 「予約が入ったとき」の送信Webhook購読者へも届ける。
    c.executionCtx.waitUntil(
      fireOutgoingWebhooks(c.env.DB, 'booking_created', {
        friendId: row.friend_id ?? undefined,
        sourceKind: 'booking',
        sourceEventId: id,
        occurredAt: new Date().toISOString(),
        eventData: {
          bookingId: id,
          bookingType: 'salon',
          menuId: row.menu_id,
          staffId: row.staff_id,
          startsAt: row.starts_at,
        },
      }, accountId).catch((err) => logger.error("booking.admin_requests_by_id_update_failed")),
    );
  } else if (next === 'rejected') {
    // 却下でも の未送信予定は止める (通知だけでは送り続ける)。
    // 送信権の貸出中は 409 で再試行させる (取消確定後の送信を起こさない)。
    try {
      await cancelByTrigger(c.env.DB, {
        triggerType: 'booking',
        sourceId: id,
        sourceEventId: id,
        friendId: row.friend_id,
        startsAtIso: row.starts_at,
        lineAccountId: accountId,
        cancelReason: `booking_rejected:${id}:by:${c.get('staff')?.id ?? 'admin'}`,
        failOnSendInFlight: true,
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'REMINDER_SEND_IN_FLIGHT') {
        // 状態更新を巻き戻して 409 にする。貸出中の送信は確定ずみの予約への
        // 送信になるため正当で、再試行は巻き戻し後の状態から再開する。
        // 巻き戻しが 0 件 (同時更新あり) なら相手の処理に任せる。
        await c.env.DB.batch([
          c.env.DB.prepare(
            `UPDATE bookings SET confirmation_revision = confirmation_revision + 1, status = ?, decided_at = ?,
                                  updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')
              WHERE id = ? AND status = ?`,
          ).bind(row.status, row.decided_at, id, next),
          c.env.DB.prepare(`UPDATE booking_groups SET version=version+1 WHERE id=(SELECT group_id FROM bookings WHERE id=? AND line_account_id=?) AND line_account_id=? AND changes()=1`).bind(id, accountId, accountId),
        ]);
        return c.json({ error: 'send_in_flight_retry' }, 409);
      }
      throw error;
    }
    // 却下が確定したら古い確定案内などの未成功行を止める。
    // これから送る rejected 通知の行はまだ無いため巻き込まない。
    await cancelObsoleteConfirmationRuns(c.env.DB, id, accountId);
    c.executionCtx.waitUntil(
      notifyForBooking(c.env.DB, id, 'rejected').catch((err) =>
        logger.error("booking.admin_requests_by_id_update_failed"),
      ),
    );
  } else if (next === 'cancelled' || next === 'expired') {
    // の未送信予定だけを止める。送信済み履歴は残す。
    // 旧表の取消は fence 成功の後に回す: fence の 409 では旧表も
    // 含めて完全 rollback する (先に止めると巻き戻せない)。
    // 送信権の貸出中は状態更新を巻き戻して 409 にする
    // (取消確定後の送信を起こさない)。
    try {
      await cancelByTrigger(c.env.DB, {
        triggerType: 'booking',
        sourceId: id,
        sourceEventId: id,
        friendId: row.friend_id,
        startsAtIso: row.starts_at,
        lineAccountId: accountId,
        cancelReason: `booking_${next}:${id}:by:${c.get('staff')?.id ?? 'admin'}`,
        failOnSendInFlight: true,
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'REMINDER_SEND_IN_FLIGHT') {
        // 状態更新を巻き戻して 409 にする (却下分岐と同趣旨)。
        await c.env.DB.batch([
          c.env.DB.prepare(
            `UPDATE bookings SET confirmation_revision = confirmation_revision + 1, status = ?, decided_at = ?,
                                  updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')
              WHERE id = ? AND status = ?`,
          ).bind(row.status, row.decided_at, id, next),
          c.env.DB.prepare(`UPDATE booking_groups SET version=version+1 WHERE id=(SELECT group_id FROM bookings WHERE id=? AND line_account_id=?) AND line_account_id=? AND changes()=1`).bind(id, accountId, accountId),
        ]);
        return c.json({ error: 'send_in_flight_retry' }, 409);
      }
      throw error;
    }
    await cancelLegacyBookingReminders(c.env.DB, id);
    // 取消・期限切れが確定したら古い確定案内などの未成功行を止める。
    await cancelObsoleteConfirmationRuns(c.env.DB, id, accountId);
    // Calendar 削除は台帳駆動 (安定キーで1行)。の fence 成功後に登録する:
    // 送信権の貸出中で巻き戻した 409 の後に queued 行が残ると、cron が確定
    // ずみの予約の予定を消してしまう。登録の失敗は落とさず投げる
    // (取消再試行で回復できる)。一時失敗は retry_wait に残し、
    // 次の取消再試行で同じ鍵で再実行する。
    // 却下では Calendar 予定を作らないため登録しない。
    await enqueueCalendarDeleteOperation(c.env.DB, { bookingId: id, lineAccountId: accountId });
    c.executionCtx.waitUntil(
      runCalendarDeleteOperation(c.env.DB, {
        bookingId: id,
        lineAccountId: accountId,
        remove: () => removeBookingFromGoogle(c.env.DB, googleCredentials(c.env), id),
      }).catch((error) => logger.error("booking.admin_requests_by_id_update_failed")),
    );
    // キャンセル待ち：空いた枠を登録の早い順で1人に知らせる。
    // 知らせの失敗で取り消し自体を失敗させない。
    try {
      await promoteBookingWaitlist(c.env.DB, {
        lineAccountId: accountId,
        staffId: row.staff_id,
        startsAt: row.starts_at,
      }, undefined, c.env.LIFF_URL ?? '',c.env);
    } catch {
      logger.error("booking.promote_waitlist_failed");
    }
  }

  // 成功履歴は取消ガードと状態確定の後に残す。送信中の 409 で
  // 巻き戻したときはここへ来ないため、成立していない取消・拒否の
  // 履歴は残らない。
  // 状態遷移も監査へ残す。誰が・いつ・何へ変えたかを後から追えるようにする。
  await recordBookingAudit(c.env.DB, {
    bookingId: id,
    lineAccountId: accountId,
    action: 'status_changed',
    before: { status: row.status },
    after: { status: next },
    reason: b.action,
    ...staffAuditActor(c),
    occurredAt: new Date().toISOString(),
  });

  return c.json({ status: next });
});


booking.get('/api/booking/admin/pending-count', async (c) => {
  const accountId = await resolveAccountIdAdmin(c);
  if (!accountId) return c.json({ error: 'missing_account_id' }, 400);
  const row = await c.env.DB
    .prepare(
      `SELECT COUNT(*) AS cnt FROM bookings
        WHERE line_account_id = ? AND status = 'requested'`,
    )
    .bind(accountId)
    .first<{ cnt: number }>();
  return c.json({ count: row?.cnt ?? 0 });
});
}
