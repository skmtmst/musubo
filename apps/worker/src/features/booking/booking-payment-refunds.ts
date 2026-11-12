import type { BookingPaymentRecord } from '@line-crm/db';

export interface RefundInput {
  amount?: number;
  reason: string;
  notifyLine: boolean;
  idempotencyKey: string;
  expectedRevision?: number;
}
export interface PaymentRefund {
  id: string; amount: number; reason: string; actorLabel: string; createdAt: string;
  notifyLine: boolean; notificationStatus: 'not_requested' | 'simulated' | 'unavailable';
  simulation: true; sent: false;
}
interface RefundRow {
  id: string; payment_id: string; amount: number; requested_amount: number | null;
  reason: string; actor_id: string; actor_label: string; created_at: string;
  notify_line: number; notification_status: PaymentRefund['notificationStatus'];
}
export class PaymentActionError extends Error {
  constructor(public code: string, public status: 400 | 404 | 409 | 503) { super(code); }
}
export function parseRefundInput(body: unknown): RefundInput | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const v = body as Record<string, unknown>;
  if (typeof v.reason !== 'string' || !v.reason.trim() || v.reason.trim().length > 500
    || typeof v.idempotencyKey !== 'string' || !/^[A-Za-z0-9:_-]{1,200}$/.test(v.idempotencyKey)
    || (v.amount !== undefined && (!Number.isSafeInteger(v.amount) || Number(v.amount) <= 0))
    || (v.notifyLine !== undefined && typeof v.notifyLine !== 'boolean')
    || (v.expectedRevision !== undefined && (!Number.isSafeInteger(v.expectedRevision) || Number(v.expectedRevision) < 1))) return null;
  return { reason: v.reason.trim(), idempotencyKey: v.idempotencyKey, notifyLine: v.notifyLine === true,
    ...(v.amount === undefined ? {} : { amount: v.amount as number }),
    ...(v.expectedRevision === undefined ? {} : { expectedRevision: v.expectedRevision as number }) };
}
export function refundDto(row: RefundRow): PaymentRefund {
  return { id: row.id, amount: row.amount, reason: row.reason, actorLabel: row.actor_label,
    createdAt: row.created_at, notifyLine: Boolean(row.notify_line), notificationStatus: row.notification_status,
    simulation: true, sent: false };
}
export async function refundHistory(db: D1Database, account: string, paymentId: string) {
  const rows = await db.prepare(`SELECT * FROM booking_payment_refunds WHERE line_account_id=? AND payment_id=?
    ORDER BY created_at DESC,id`).bind(account, paymentId).all<RefundRow>();
  return rows.results.map(refundDto);
}

/** 模擬決済だけを1取引で返金する。外部送金と通知の配送は実行しない。 */
export async function simulatePaymentRefund(db: D1Database, payment: BookingPaymentRecord,
  input: RefundInput, actor: { id: string; name: string }) {
  const account = payment.line_account_id;
  const read = () => db.prepare(`SELECT * FROM booking_payment_refunds
    WHERE payment_id=? AND line_account_id=? AND idempotency_key=?`)
    .bind(payment.id, account, input.idempotencyKey).first<RefundRow>();
  const validate = (row: RefundRow) => {
    if (row.requested_amount !== (input.amount ?? null) || row.reason !== input.reason
      || Boolean(row.notify_line) !== input.notifyLine || row.actor_id !== actor.id) {
      throw new PaymentActionError('refund_idempotency_conflict', 409);
    }
  };
  const attemptId = crypto.randomUUID();
  const existing = await read();
  if (existing) validate(existing);
  else {
    if (payment.provider !== 'stripe' || !payment.provider_payment_id?.startsWith('pi_test_')) {
      throw new PaymentActionError('simulation_only', 409);
    }
    const id = attemptId, at = new Date().toISOString();
    await db.batch([
      db.prepare(`INSERT INTO booking_payment_refunds
        (id,payment_id,line_account_id,idempotency_key,amount,requested_amount,reason,actor_id,actor_label,
          notify_line,notification_status,created_at)
        SELECT ?,p.id,p.line_account_id,?,COALESCE(?,p.amount-p.refunded_amount),?,?,?, ?,?,
          CASE WHEN ?=0 THEN 'not_requested' WHEN EXISTS(
            SELECT 1 FROM bookings b JOIN friends f ON f.id=b.friend_id AND f.line_account_id=b.line_account_id
              WHERE b.id=p.booking_id AND b.line_account_id=p.line_account_id AND f.is_following=1
                AND f.line_user_id IS NOT NULL) THEN 'simulated' ELSE 'unavailable' END,?
        FROM booking_payments p WHERE p.id=? AND p.line_account_id=? AND p.status='paid'
          AND p.provider='stripe' AND substr(p.provider_payment_id,1,8)='pi_test_'
          AND p.currency='JPY' AND p.amount-p.refunded_amount>0
          AND (? IS NULL OR p.confirmation_revision=?)
          AND COALESCE(?,p.amount-p.refunded_amount)<=p.amount-p.refunded_amount
          AND NOT EXISTS(SELECT 1 FROM booking_payment_connections c WHERE c.line_account_id=p.line_account_id
            AND c.provider='stripe' AND c.disconnected_at IS NULL AND c.test_mode=0)
          AND NOT EXISTS(SELECT 1 FROM booking_payment_refunds r WHERE r.payment_id=p.id AND r.idempotency_key=?)`)
        .bind(id, input.idempotencyKey, input.amount ?? null, input.amount ?? null, input.reason, actor.id,
          actor.name, input.notifyLine ? 1 : 0, input.notifyLine ? 1 : 0, at, payment.id, account,
          input.expectedRevision ?? null, input.expectedRevision ?? null, input.amount ?? null, input.idempotencyKey),
      db.prepare(`UPDATE booking_payments SET confirmation_revision=confirmation_revision+1, refunded_amount=refunded_amount+(SELECT amount FROM booking_payment_refunds WHERE id=?),
        status=CASE WHEN refunded_amount+(SELECT amount FROM booking_payment_refunds WHERE id=?)=amount THEN 'refunded' ELSE 'paid' END,
        refunded_at=?,updated_at=?,actor_label=?,action_reason=?
        WHERE id=? AND line_account_id=? AND EXISTS(SELECT 1 FROM booking_payment_refunds WHERE id=?)`)
        .bind(id, id, at, at, actor.name, input.reason, payment.id, account, id),
    ]);
  }
  const saved = await read();
  if (!saved) {
    const current = await db.prepare('SELECT confirmation_revision FROM booking_payments WHERE id=? AND line_account_id=?')
      .bind(payment.id, account).first<{confirmation_revision:number}>();
    if (input.expectedRevision !== undefined && current && current.confirmation_revision !== input.expectedRevision) {
      throw new PaymentActionError('stale_confirmation', 409);
    }
    const liveConnection = await db.prepare(`SELECT 1 FROM booking_payment_connections WHERE line_account_id=?
      AND provider='stripe' AND disconnected_at IS NULL AND test_mode=0`).bind(account).first();
    if (liveConnection) throw new PaymentActionError('simulation_only', 409);
    throw new PaymentActionError('refund_not_available', 409);
  }
  validate(saved);
  const current = await db.prepare('SELECT * FROM booking_payments WHERE id=? AND line_account_id=?')
    .bind(payment.id, account).first<BookingPaymentRecord>();
  return { payment: current, refund: refundDto(saved), duplicate: saved.id !== attemptId, simulation: true as const, sent: false as const };
}

/** 未連結の支払いを同じ店の予約に結ぶ。入金や予約の確定は変更しない。 */
export async function linkPaymentBooking(db: D1Database, payment: BookingPaymentRecord,
  bookingId: string, reason: string, actor: { id: string; name: string }) {
  const account = payment.line_account_id;
  const booking = await db.prepare('SELECT id FROM bookings WHERE id=? AND line_account_id=?')
    .bind(bookingId, account).first();
  if (!booking) throw new PaymentActionError('not_found', 404);
  if (payment.booking_id && payment.booking_id !== bookingId) throw new PaymentActionError('payment_already_linked', 409);
  const id = crypto.randomUUID(), at = new Date().toISOString();
  await db.batch([
    db.prepare(`INSERT INTO booking_payment_booking_links(id,payment_id,line_account_id,booking_id,reason,actor_id,actor_label,created_at)
      SELECT ?,p.id,p.line_account_id,?,?,?, ?,? FROM booking_payments p
      WHERE p.id=? AND p.line_account_id=? AND p.booking_id IS NULL
      AND EXISTS(SELECT 1 FROM bookings b WHERE b.id=? AND b.line_account_id=p.line_account_id)
      AND NOT EXISTS(SELECT 1 FROM booking_payments other WHERE other.booking_id=? AND other.line_account_id=p.line_account_id AND other.id<>p.id)
      AND NOT EXISTS(SELECT 1 FROM booking_payment_choices ch WHERE ch.booking_id=? AND ch.mode='onsite')
      AND NOT EXISTS(SELECT 1 FROM booking_entitlement_uses u WHERE u.booking_id=?)`)
      .bind(id, bookingId, reason, actor.id, actor.name, at, payment.id, account, bookingId, bookingId, bookingId, bookingId),
    db.prepare(`UPDATE booking_payments SET confirmation_revision=confirmation_revision+1, booking_id=?,actor_label=?,action_reason=?,updated_at=?
      WHERE id=? AND line_account_id=? AND booking_id IS NULL
      AND EXISTS(SELECT 1 FROM booking_payment_booking_links WHERE id=?)`)
      .bind(bookingId, actor.name, reason, at, payment.id, account, id),
  ]);
  const saved = await db.prepare('SELECT * FROM booking_payments WHERE id=? AND line_account_id=?')
    .bind(payment.id, account).first<BookingPaymentRecord>();
  if (saved?.booking_id !== bookingId) throw new PaymentActionError('payment_link_conflict', 409);
  return { payment: saved };
}
