import { liffBookingInputError, liffBookingJson, liffBookingResponse } from '../liff-booking-response.js';
import { logger } from '@line-crm/shared/server';
import type { Env } from '../../worker-env.js';
import type { Hono } from 'hono';
import { bookingCancellationQuote, customerCancellationDeadline } from '../../features/booking/booking-cancellation/index.js';
import { syncSelfBookingMeet } from '../booking-self-meet-sync.js';
import type { SelfBookingChange } from '../booking-self-meet-sync.js';
import { inputJsonBoundary } from '../../lib/input-errors.js';
import { cancelByTrigger } from '../../services/reminder-trigger.js';
import { enqueueCalendarDeleteOperation, removeBookingFromGoogle, runCalendarDeleteOperation } from '../../features/booking/booking-calendar-sync/index.js';
import { type BookingStatus } from '../../features/booking/booking-types/index.js';
import { recordBookingAudit } from '@line-crm/db';
import { promoteBookingWaitlist } from '../../features/booking/booking-waitlist/index.js';
import { resolveSelfBookingCaller, readSelfBookingRules } from './identity.js';
import { updateAdminBooking } from './update.js';
import { runSelfBookingCancelSideEffects, refundSelfBookingPayment, cancelSelfBookingMeet } from './self-effects.js';
import { cancelLegacyBookingReminders, cancelObsoleteConfirmationRuns } from './ledger-input.js';
import { googleCredentials } from './availability.js';

export function registerLiffChanges(booking: Hono<Env>): void {
booking.post('/api/liff/booking/:id/reschedule', inputJsonBoundary(), async (c) => {
  const caller = await resolveSelfBookingCaller(c);
  if (!caller.ok) return liffBookingInputError(c, { error: caller.error }, caller.status, []);
  const bookingId = c.req.param('id');
  const body = await c.req.json<{
    starts_at?: unknown;
    lock_version?: unknown;
    reason?: unknown;
  }>().catch(() => null);
  if (!body) return liffBookingInputError(c, { error: 'invalid_json' }, 400, []);
  if (!Number.isInteger(body.lock_version) || Number(body.lock_version) < 0) {
    return liffBookingInputError(c, { error: 'missing_lock_version' }, 400, ["lock_version"]);
  }
  const self: SelfBookingChange = {
    accountId: caller.accountId,
    friendId: caller.friendId,
    lineUserId: caller.lineUserId,
  };
  // Meet 連携のため変更前の外部予定IDを先に読む (Google 同期で変わることがある)。
  const before = await c.env.DB
    .prepare(`SELECT external_event_id FROM bookings WHERE id = ? AND line_account_id = ?`)
    .bind(bookingId, caller.accountId)
    .first<{ external_event_id: string | null }>();
  const res = await updateAdminBooking(c, {
    lock_version: body.lock_version,
    starts_at: typeof body.starts_at === 'string' ? body.starts_at : undefined,
    reason: typeof body.reason === 'string' ? body.reason : undefined,
  }, self);
  if (res.status !== 200) return liffBookingResponse(c, res);
  const after = await c.env.DB
    .prepare(`SELECT external_event_id FROM bookings WHERE id = ? AND line_account_id = ?`)
    .bind(bookingId, caller.accountId)
    .first<{ external_event_id: string | null }>();
  const out = await res.json<Record<string, unknown>>();
  const meetSync = await syncSelfBookingMeet(
    c,
    self,
    bookingId,
    before?.external_event_id ?? after?.external_event_id ?? null,
    Number(out.lock_version),
  );
  return liffBookingJson(c, { ...out, meet_sync: meetSync });
});

booking.post('/api/liff/booking/:id/cancel', inputJsonBoundary(), async (c) => {
  const caller = await resolveSelfBookingCaller(c);
  if (!caller.ok) return liffBookingInputError(c, { error: caller.error }, caller.status, []);
  const accountId = caller.accountId;
  const bookingId = c.req.param('id');
  const body = await c.req.json<{ lock_version?: unknown; feeAccepted?:unknown;expectedFeeAmount?:unknown }>().catch(() => null);
  if (!body || !Number.isInteger(body.lock_version) || Number(body.lock_version) < 0) {
    return liffBookingInputError(c, { error: 'missing_lock_version' }, 400, ["lock_version"]);
  }
  const expectedVersion = Number(body.lock_version);
  const row = await c.env.DB
    .prepare(
      `SELECT id, status, friend_id, lock_version, starts_at, menu_id, staff_id,
              decided_at, external_event_id
         FROM bookings WHERE id = ? AND line_account_id = ?`,
    )
    .bind(bookingId, accountId)
    .first<{
      id: string;
      status: BookingStatus;
      friend_id: string | null;
      lock_version: number;
      starts_at: string;
      menu_id: string;
      staff_id: string;
      decided_at: string | null;
      external_event_id: string | null;
    }>();
  if (!row || row.friend_id !== caller.friendId) {
    return liffBookingJson(c, { error: 'booking_not_found' }, 404);
  }
  const self: SelfBookingChange = {
    accountId, friendId: caller.friendId, lineUserId: caller.lineUserId,
  };
  const cancelReason = `booking_cancelled:${bookingId}:by:self:${caller.lineUserId}`;
  // 取消ずみの再送: 版が合えば副作用をそろえて 200 (冪等再送)。
  // 所有権は cancel_claim_id (uuid) の単文 CAS で主張する。主張と状態変更が
  // 同じ UPDATE のため、claim→監査の別 await 窓は存在しない。時計の同msでも区別できる。
  if (row.status === 'cancelled' || row.status === 'expired') {
    if (Number(row.lock_version) !== expectedVersion) {
      return liffBookingJson(c, { error: 'version_conflict' }, 409);
    }
    const claimAt = new Date().toISOString();
    const claimId = crypto.randomUUID();
    const claim = await c.env.DB
      .prepare(
        `UPDATE bookings SET confirmation_revision = confirmation_revision + 1, decided_at = COALESCE(decided_at, ?), cancel_claim_id = ?,
                              updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')
          WHERE id = ? AND line_account_id = ?
            AND status IN ('cancelled','expired')
            AND lock_version = ? AND friend_id = ?`,
      )
      .bind(claimAt, claimId, bookingId, accountId, expectedVersion, caller.friendId)
      .run();
    if ((claim.meta?.changes ?? 0) === 0) {
      const current = await c.env.DB
        .prepare(`SELECT lock_version, status FROM bookings WHERE id = ? AND line_account_id = ?`)
        .bind(bookingId, accountId)
        .first<{ lock_version: number; status: string }>();
      if (!current) return liffBookingJson(c, { error: 'booking_not_found' }, 404);
      return liffBookingJson(c, { error: 'version_conflict' }, 409);
    }
    // 主張の証跡 (排他には使わない。所有権は上の単文 CAS の cancel_claim_id)。
    await recordBookingAudit(c.env.DB, {
      bookingId,
      lineAccountId: accountId,
      action: 'cancel_retry_claimed',
      before: { status: row.status },
      after: { status: row.status, decided_at: row.decided_at ?? claimAt, cancel_claim_id: claimId },
      reason: 'self_cancel_retry',
      actorType: 'customer',
      actorId: caller.friendId,
      actorName: null,
      occurredAt: new Date().toISOString(),
    });
    // 送信中は 409 で再試行させる。未実施の副作用を適用対象外にしない。
    try {
      const retry = await runSelfBookingCancelSideEffects(c, self, row);
      return liffBookingJson(c, {
        status: row.status,
        lock_version: Number(row.lock_version),
        retried: true,
        ...retry,
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'REMINDER_SEND_IN_FLIGHT') {
        return liffBookingJson(c, { error: 'send_in_flight_retry' }, 409);
      }
      throw error;
    }
  }
  if (row.status !== 'requested' && row.status !== 'confirmed') {
    return liffBookingJson(c, { error: 'not_editable' }, 409);
  }
  if (Number(row.lock_version) !== expectedVersion) {
    return liffBookingJson(c, { error: 'version_conflict' }, 409);
  }
  const cancellationAt=new Date();
  const quote=await bookingCancellationQuote(c.env.DB,bookingId,accountId,cancellationAt);
  const rules = await readSelfBookingRules(c.env.DB, accountId, row.menu_id);
  if (cancellationAt.getTime() >= Date.parse(row.starts_at) || cancellationAt.getTime() > Date.parse(customerCancellationDeadline(row.starts_at,quote.policyAcceptedRequired,rules.cancelDeadlineMinutesBefore))) {
    return liffBookingJson(c, { error: 'self_deadline_passed' }, 403);
  }
  if(quote.feeNow>0 && (body.feeAccepted!==true||body.expectedFeeAmount!==quote.feeNow))return liffBookingJson(c, {error:'cancellation_fee_confirmation_required',data:quote},409);
  // 条件付き確定: 同時取消の race では片方だけが通る。副作用は通った方だけ走る。
  // 所有権は cancel_claim_id (uuid) を同じ UPDATE で書く単文 CAS。
  // 確定と主張が不可分のため、確定→監査の別 await 窓は存在しない。
  const decidedAt = cancellationAt.toISOString();
  const claimId = crypto.randomUUID();
  const updateResult = await c.env.DB
    .prepare(
      `UPDATE bookings SET confirmation_revision = confirmation_revision + 1, status = 'cancelled', decided_at = ?, cancel_claim_id = ?,
                            updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')
        WHERE id = ? AND line_account_id = ?
          AND lock_version = ? AND status IN ('requested','confirmed')`,
    )
    .bind(decidedAt, claimId, bookingId, accountId, expectedVersion)
    .run();
  if ((updateResult.meta?.changes ?? 0) === 0) {
    const current = await c.env.DB
      .prepare(`SELECT lock_version, status FROM bookings WHERE id = ? AND line_account_id = ?`)
      .bind(bookingId, accountId)
      .first<{ lock_version: number; status: string }>();
    if (!current) return liffBookingJson(c, { error: 'booking_not_found' }, 404);
    return liffBookingJson(c, { error: 'version_conflict' }, 409);
  }
  try {
    await cancelByTrigger(c.env.DB, {
      triggerType: 'booking',
      sourceId: bookingId,
      sourceEventId: bookingId,
      friendId: row.friend_id,
      startsAtIso: row.starts_at,
      lineAccountId: accountId,
      cancelReason,
      failOnSendInFlight: true,
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'REMINDER_SEND_IN_FLIGHT') {
      // 送信中の 409 では確定を取り消して再試行させる (取消確定後の送信を起こさない)。
      // 自分の claim_id と一致するときだけ戻す。後発の再送が主張を上書き
      // ずみなら 0 件になり、後発の成功予約は cancelled のまま残る。
      await c.env.DB.batch([
        c.env.DB.prepare(
          `UPDATE bookings SET confirmation_revision = confirmation_revision + 1, status = ?, decided_at = ?, cancel_claim_id = NULL,
                                updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')
            WHERE id = ? AND line_account_id = ? AND status = ?
              AND decided_at = ? AND lock_version = ? AND friend_id = ?
              AND cancel_claim_id = ?`,
        ).bind(row.status, row.decided_at, bookingId, accountId, 'cancelled',
          decidedAt, expectedVersion, caller.friendId, claimId),
        c.env.DB.prepare(`UPDATE booking_groups SET version=version+1 WHERE id=(SELECT group_id FROM bookings WHERE id=? AND line_account_id=?) AND line_account_id=? AND changes()=1`).bind(bookingId, accountId, accountId),
      ]);
      return liffBookingJson(c, { error: 'send_in_flight_retry' }, 409);
    }
    throw error;
  }
  await refundSelfBookingPayment(c.env.DB, self, bookingId);
  await cancelLegacyBookingReminders(c.env.DB, bookingId);
  await cancelObsoleteConfirmationRuns(c.env.DB, bookingId, accountId);
  await enqueueCalendarDeleteOperation(c.env.DB, { bookingId, lineAccountId: accountId });
  const calResult = await runCalendarDeleteOperation(c.env.DB, {
    bookingId,
    lineAccountId: accountId,
    remove: () => removeBookingFromGoogle(c.env.DB, googleCredentials(c.env), bookingId),
  });
  const meetSync = await cancelSelfBookingMeet(c, self, bookingId, row.external_event_id);
  await recordBookingAudit(c.env.DB, {
    bookingId,
    lineAccountId: accountId,
    action: 'status_changed',
    before: { status: row.status },
    after: { status: 'cancelled' },
    reason: 'self_cancel',
    actorType: 'customer',
    actorId: caller.friendId,
    actorName: null,
    occurredAt: new Date().toISOString(),
  });
  // キャンセル待ち：空いた枠を登録の早い順で1人に知らせる。
  // 知らせの失敗で取り消し自体を失敗させない。
  try {
    await promoteBookingWaitlist(c.env.DB, {
      lineAccountId: accountId,
      staffId: row.staff_id,
      startsAt: row.starts_at,
    }, undefined, c.env.LIFF_URL ?? '',c.env);
  } catch (error) {
    logger.error("booking.promote_waitlist_failed");
  }
  return liffBookingJson(c, {
    ...(await bookingCancellationQuote(c.env.DB,bookingId,accountId)),
    status: 'cancelled',
    lock_version: expectedVersion,
    calendar_sync: calResult === 'succeeded' ? 'synced' : calResult === 'retry_wait' ? 'failed' : 'not_applicable',
    meet_sync: meetSync,
  });
});
}
