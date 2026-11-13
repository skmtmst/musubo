import { logger } from '@line-crm/shared/server';
import { activeTenantLineAccountSql, accountFeatureOffExclusionSql } from '@line-crm/db';
import { reconcileLateBookingPayment } from './booking-late-payment.js';
import { confirmationWorkflowStatement, runConfirmedBookingSideEffects } from './booking-confirmed-effects.js';
import type { GoogleServiceAccountCredentials } from '../../services/google-service-account.js';

// 現在のメニュー設定や料金だけでは、申込時の店払いとオンライン払いを区別できない。
// 完了応答に保存した支払いID・期限だけを証拠にする。記録のない旧予約は消さない。
const orphanedOnlineBookingSql = `price_at_booking > 0
  AND NOT EXISTS (SELECT 1 FROM booking_payments p
    WHERE p.booking_id = bookings.id AND p.line_account_id = bookings.line_account_id)
  AND EXISTS (
    SELECT 1 FROM (
      SELECT line_account_id, friend_id, response_status,
        CASE WHEN json_valid(response_body) THEN response_body ELSE '{}' END AS body
      FROM booking_idempotency_keys
    ) snapshot
    WHERE snapshot.line_account_id = bookings.line_account_id
      AND snapshot.friend_id = bookings.friend_id AND snapshot.response_status = 201
      AND json_extract(snapshot.body, '$.booking_id') = bookings.id
      AND json_extract(snapshot.body, '$.payment_required') IS NOT 0
      AND json_type(snapshot.body, '$.payment.id') = 'text'
      AND length(json_extract(snapshot.body, '$.payment.id')) > 0
      AND json_type(snapshot.body, '$.payment.holdUntil') = 'text'
      AND julianday(json_extract(snapshot.body, '$.payment.holdUntil')) <= julianday(?)
  )`;

/** 申込時の支払い期限が残っている孤児だけを解放する。判断できない予約は保つ。 */
export async function recoverOrphanedOnlineBookings(db: D1Database, now: Date): Promise<void> {
  await db.batch([
    db.prepare(`UPDATE bookings SET confirmation_revision = confirmation_revision + 1, status = 'expired', decided_at = ?, updated_at = ?
      WHERE status = 'requested' AND ${orphanedOnlineBookingSql}`)
      .bind(now.toISOString(), now.toISOString(), now.toISOString()),
    db.prepare(`INSERT INTO booking_audit_logs
      (id,booking_id,line_account_id,action,after_json,reason,actor_type,occurred_at)
      SELECT 'orphan-payment:' || id,id,line_account_id,'expired','{"status":"expired"}',
        'payment_record_missing','system',? FROM bookings WHERE status='expired' AND decided_at=?
        AND ${orphanedOnlineBookingSql}
        AND NOT EXISTS (SELECT 1 FROM booking_audit_logs a WHERE a.id='orphan-payment:' || bookings.id)`)
      .bind(now.toISOString(), now.toISOString(), now.toISOString()),
  ]);
}

/** 決済と予約の状態・確定回収の記録を同じ取引でそろえる。 */
export async function reconcilePaidBookingPayment(
  db: D1Database,
  paymentId: string,
  now = new Date(),
  applyPaid = false,
  credentials: GoogleServiceAccountCredentials = {},
): Promise<{ duplicate: boolean } | null> {
  const row = await db.prepare(`SELECT id, line_account_id, booking_id, status
    FROM booking_payments WHERE id = ?`).bind(paymentId).first<{
      id: string; line_account_id: string; booking_id: string | null; status: string;
    }>();
  if (!row) return null;
  if (row.status !== 'paid' && (!applyPaid || !['unpaid', 'pending', 'expired'].includes(row.status))) {
    return { duplicate: true };
  }
  const nowIso = now.toISOString();
  const statements = paidBookingPaymentStatements(db, row, nowIso, applyPaid);
  const result = statements.length ? await db.batch(statements) : [];
  await reconcileLateBookingPayment(db,paymentId,now,credentials);
  if (row.booking_id && await db.prepare(`SELECT id FROM booking_operation_runs
      WHERE booking_id = ? AND line_account_id = ? AND idempotency_key = ? AND status IN ('queued','retry_wait')`)
      .bind(row.booking_id, row.line_account_id, `${row.booking_id}:confirmation-effects`).first()) {
    try { await runConfirmedBookingSideEffects(db, row.booking_id, { now, credentials }); }
    catch { logger.error("paid_booking_confirmation_incomplete"); }
  }
  return { duplicate: !applyPaid || (result[0]?.meta?.changes ?? 0) === 0 };
}

export interface PaidPaymentRow {
  id: string; line_account_id: string; booking_id: string | null; status: string;
}

/** 通知台帳も同じbatchで確定できるよう、原子的な更新を組み立てる。 */
export function paidBookingPaymentStatements(
  db: D1Database, row: PaidPaymentRow, nowIso: string, applyPaid: boolean,
  gate: { sql: string; args: (string | number)[] } = { sql: '1', args: [] },
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  if (applyPaid) {
    statements.push(db.prepare(`UPDATE booking_payments
      SET confirmation_revision=confirmation_revision+1, status = 'paid', paid_at = COALESCE(paid_at, ?), updated_at = ?
      WHERE id = ? AND status IN ('unpaid', 'pending', 'expired') AND (${gate.sql})`).bind(nowIso, nowIso, row.id, ...gate.args));
  }
  if (row.booking_id !== null) {
    statements.push(db.prepare(`UPDATE bookings
      SET confirmation_revision = confirmation_revision + 1, status = 'confirmed', decided_at = ?, updated_at = ?
      WHERE id = ? AND line_account_id = ? AND status = 'requested' AND (${gate.sql})
        AND EXISTS (SELECT 1 FROM booking_payments p WHERE p.id = ? AND p.status = 'paid'
          AND p.booking_id = bookings.id AND p.line_account_id = bookings.line_account_id)
        AND COALESCE((SELECT approval_mode FROM booking_settings
          WHERE line_account_id = bookings.line_account_id), 'automatic') = 'automatic'`)
      .bind(nowIso, nowIso, row.booking_id, row.line_account_id, ...gate.args, row.id));
    // changes は直前の予約更新だけを見る。並走・重複通知でも履歴を重ねない。
    statements.push(db.prepare(`INSERT INTO booking_audit_logs
      (id, booking_id, line_account_id, action, after_json, actor_type, occurred_at)
      SELECT ?, ?, ?, 'confirmed', '{"status":"confirmed","payment":"paid"}', 'system', ?
      WHERE changes() = 1`).bind(crypto.randomUUID(), row.booking_id, row.line_account_id, nowIso));
    statements.push(confirmationWorkflowStatement(db, row.booking_id, true));
  }
  return statements;
}

/** 人の確認待ちでバッチが埋まらないよう、実行可能な回復処理だけを有限件取得する。 */
export async function recoverPaidBookingPayments(db: D1Database, now: Date, credentials: GoogleServiceAccountCredentials = {}): Promise<void> {
  const rows = await db.prepare(`SELECT p.id FROM booking_payments p
    JOIN bookings b ON b.id = p.booking_id AND b.line_account_id = p.line_account_id
    LEFT JOIN workflow_steps w ON w.scope_id = 'line:' || p.line_account_id
      AND w.process_kind = 'booking_late_payment' AND w.subject_id = p.id AND w.step_key = 'resolve'
    WHERE p.status = 'paid' AND (
      (b.status = 'requested' AND COALESCE((SELECT approval_mode FROM booking_settings
        WHERE line_account_id = b.line_account_id), 'automatic') = 'automatic')
      OR (b.status IN ('expired','cancelled')
        AND ${activeTenantLineAccountSql('p.line_account_id')}
        AND NOT ${accountFeatureOffExclusionSql('p.line_account_id', 'booking')}
        AND (w.subject_id IS NULL OR (
          w.attempt_count < w.max_attempts AND (w.next_attempt_at IS NULL OR w.next_attempt_at <= ?)
          AND (w.status IN ('pending','failed') OR (w.status = 'running' AND w.lease_expires_at <= ?))
        )))
    )
    ORDER BY CASE WHEN b.status = 'requested' THEN 0 ELSE 1 END, p.id LIMIT 200`)
    .bind(now.getTime(), now.getTime()).all<{ id: string }>();
  for (const row of rows.results ?? []) {
    try { await reconcilePaidBookingPayment(db, row.id, now, false, credentials); }
    catch { logger.error("paid_booking_recovery_failed"); }
  }
}

export async function reconcileExpiredBookingPayment(
  db: D1Database, paymentId: string, now = new Date(),
): Promise<void> {
  const nowIso = now.toISOString();
  await db.batch([
    db.prepare(`UPDATE booking_payments SET confirmation_revision=confirmation_revision+1, status = 'expired', updated_at = ?
      WHERE id = ? AND status IN ('unpaid', 'pending') AND hold_until <= ?`)
      .bind(nowIso, paymentId, nowIso),
    db.prepare(`UPDATE bookings SET confirmation_revision = confirmation_revision + 1, status = 'expired', decided_at = ?, updated_at = ?
      WHERE status = 'requested' AND EXISTS (
        SELECT 1 FROM booking_payments p WHERE p.id = ? AND p.status = 'expired'
          AND p.booking_id = bookings.id AND p.line_account_id = bookings.line_account_id)`)
      .bind(nowIso, nowIso, paymentId),
    db.prepare(`INSERT INTO booking_audit_logs
      (id, booking_id, line_account_id, action, after_json, reason, actor_type, occurred_at)
      SELECT ?, booking_id, line_account_id, 'expired', '{"status":"expired"}',
        'payment_hold_expired', 'system', ? FROM booking_payments
      WHERE id = ? AND booking_id IS NOT NULL AND changes() = 1`)
      .bind(crypto.randomUUID(), nowIso, paymentId),
  ]);
}

/** 10分等の支払い期限は24時間の承認期限とは別に回収する。 */
export async function recoverExpiredBookingPayments(db: D1Database, now: Date): Promise<void> {
  const rows = await db.prepare(`SELECT p.id FROM booking_payments p
    LEFT JOIN bookings b ON b.id = p.booking_id AND b.line_account_id = p.line_account_id
    WHERE (p.status IN ('unpaid', 'pending') AND p.hold_until <= ?)
      OR (p.status = 'expired' AND b.status = 'requested')
    ORDER BY p.id LIMIT 200`).bind(now.toISOString()).all<{ id: string }>();
  for (const row of rows.results ?? []) await reconcileExpiredBookingPayment(db, row.id, now);
}
