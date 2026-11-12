import { paidBookingPaymentStatements, type PaidPaymentRow } from './booking-payment-recovery.js';
import type { WebhookOutcome } from '../../services/payment-providers.js';
import { paymentPeriod } from './booking-payment-admin.js';

interface EventRow {
  id: string; line_account_id: string; provider: string; payment_id: string | null;
  provider_payment_id: string; outcome: string; kind: string; amount: number | null; currency: string | null;
  receipt_url: string | null; refunded_amount: number | null; result: string; version: number; attempts: number;
}
const eventGate = 'EXISTS (SELECT 1 FROM booking_payment_events e WHERE e.id=? AND e.lease_token=? AND e.result<>\'failed\')';

export async function paymentEvent(db: D1Database, account: string, id: string) {
  const row = await db.prepare(`SELECT e.id,e.received_at AS receivedAt,e.kind,e.amount,e.repeat_count,e.attempts,
    p.booking_id AS bookingId,m.name AS bookingLabel,e.result,e.error_code
    FROM booking_payment_events e LEFT JOIN booking_payments p ON p.id=e.payment_id AND p.line_account_id=e.line_account_id
    LEFT JOIN bookings b ON b.id=p.booking_id AND b.line_account_id=e.line_account_id
    LEFT JOIN menus m ON m.id=b.menu_id AND m.line_account_id=e.line_account_id
    WHERE e.id=? AND e.line_account_id=?`).bind(id, account).first<{
      id: string; receivedAt: string; kind: string; amount: number | null; repeat_count: number; attempts: number;
      bookingId: string | null; bookingLabel: string | null; result: string; error_code: string | null;
    }>();
  if (!row) return null;
  const { repeat_count, attempts, error_code, ...dto } = row;
  return { ...dto, repeat: repeat_count > 0 || attempts > 1, note: error_code };
}

export function paymentEventFilter(query: Record<string, string>) {
  const result = query.result ?? '';
  const period = query.period ?? '30d';
  const limit = query.limit === undefined ? 20 : /^\d+$/.test(query.limit) ? Number(query.limit) : NaN;
  return ['', 'applied', 'duplicate', 'failed'].includes(result) && ['7d', '30d', '90d'].includes(period)
    && Number.isSafeInteger(limit) && limit >= 1 && limit <= 100 ? { result, period, limit } : null;
}

export async function paymentEventList(db: D1Database, account: string, filter: NonNullable<ReturnType<typeof paymentEventFilter>>) {
  const { from, to } = await paymentPeriod(db, account, filter.period);
  const where = `line_account_id=? AND julianday(received_at)>=julianday(?) AND julianday(received_at)<=julianday(?) AND (?='' OR result=?)`;
  const args = [account, from, to, filter.result, filter.result];
  const rows = await db.prepare(`SELECT id FROM booking_payment_events WHERE ${where} ORDER BY julianday(received_at) DESC,id LIMIT ?`)
    .bind(...args, filter.limit).all<{ id: string }>();
  const count = await db.prepare(`SELECT COUNT(*) AS total FROM booking_payment_events WHERE ${where}`).bind(...args).first<{ total: number }>();
  return { items: await Promise.all(rows.results.map(row => paymentEvent(db, account, row.id))), total: count?.total ?? 0 };
}

/** 署名済み通知の正規化結果だけを受け取る。原文はハッシュによる再送キー以外には使わない。 */
export async function receivePaymentEvent(db: D1Database, provider: string, outcome: NonNullable<WebhookOutcome>, rawBody: string): Promise<{ status: string; result?: string }> {
  const payments = await db.prepare(`SELECT id,line_account_id,amount,currency FROM booking_payments
    WHERE provider=? AND provider_payment_id=? LIMIT 2`).bind(provider, outcome.providerPaymentId)
    .all<{ id: string; line_account_id: string; amount: number; currency: string }>();
  // 相手のIDが店をまたいで重なっている場合は、どちらにも反映しない。
  if (payments.results.length !== 1) return { status: 'unknown_payment' };
  const payment = payments.results[0];
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rawBody));
  const eventId = outcome.providerEventId ?? 'sha256:' + Array.from(new Uint8Array(digest), x => x.toString(16).padStart(2, '0')).join('');
  const kind = outcome.status === 'failed' ? 'other' : outcome.status;
  await db.prepare(`INSERT INTO booking_payment_events
    (id,line_account_id,provider,provider_event_id,payment_id,provider_payment_id,kind,outcome,amount,currency,receipt_url,received_at,refunded_amount)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(provider,line_account_id,provider_event_id) DO NOTHING`)
    .bind(crypto.randomUUID(), payment.line_account_id, provider, eventId, payment.id, outcome.providerPaymentId,
      kind, outcome.status, outcome.amount ?? payment.amount, (outcome.currency ?? payment.currency).toUpperCase(),
      outcome.receiptUrl ?? null, new Date().toISOString(), outcome.status==='refunded' ? outcome.refundedAmount ?? outcome.amount ?? payment.amount : null).run();
  const event = await db.prepare(`SELECT * FROM booking_payment_events WHERE provider=? AND line_account_id=? AND provider_event_id=?`)
    .bind(provider, payment.line_account_id, eventId).first<EventRow>();
  if (!event) throw new Error('payment_event_missing');
  if (event.refunded_amount !== (outcome.status==='refunded' ? outcome.refundedAmount ?? outcome.amount ?? payment.amount : null) || event.payment_id !== payment.id || event.outcome !== outcome.status
    || event.amount !== (outcome.amount ?? payment.amount) || event.currency !== (outcome.currency ?? payment.currency).toUpperCase()) {
    return { status: 'event_conflict' };
  }
  if (event.attempts > 0) {
    await db.prepare('UPDATE booking_payment_events SET repeat_count=repeat_count+1 WHERE id=?').bind(event.id).run();
    if (event.result !== 'failed') return { status: 'duplicate' };
  }
  return processPaymentEvent(db, payment.line_account_id, event.id);
}

/** 支払い・予約・通知の結果・再読込監査を1取引で確定する。leaseは版とトークンで保護する。 */
export async function processPaymentEvent(db: D1Database, account: string, id: string, actorId?: string): Promise<{ status: string; result?: string }> {
  const token = crypto.randomUUID();
  const now = new Date(); const at = now.toISOString();
  const event = await db.prepare(`UPDATE booking_payment_events SET lease_token=?,lease_until=?,version=version+1,attempts=attempts+1
    WHERE id=? AND line_account_id=? AND (lease_token IS NULL OR julianday(lease_until)<=julianday(?)) RETURNING *`)
    .bind(token, new Date(now.getTime() + 300000).toISOString(), id, account, at).first<EventRow>();
  if (!event) return { status: 'busy_or_missing' };
  const fence = { sql: eventGate, args: [id, token] };
  const audit = () => db.prepare(`INSERT INTO booking_payment_event_replays
    (id,event_id,actor_id,occurred_at,source_version,result,error_code)
    SELECT ?,id,?,?,version-1,result,error_code FROM booking_payment_events WHERE id=? AND lease_token=?`)
    .bind(crypto.randomUUID(), actorId!, at, id, token);
  try {
    const payment = await db.prepare(`SELECT id,line_account_id,booking_id,status FROM booking_payments
      WHERE id=? AND line_account_id=? AND provider=? AND provider_payment_id=?`)
      .bind(event.payment_id, account, event.provider, event.provider_payment_id).first<PaidPaymentRow>();
    const writes = [db.prepare(`UPDATE booking_payment_events AS e SET result=CASE
      WHEN NOT EXISTS(SELECT 1 FROM booking_payments p WHERE p.id=e.payment_id AND p.line_account_id=e.line_account_id
        AND p.provider=e.provider AND p.provider_payment_id=e.provider_payment_id
        AND p.amount=e.amount AND upper(p.currency)=e.currency) THEN 'failed'
      WHEN EXISTS(SELECT 1 FROM booking_payments p WHERE p.id=e.payment_id AND
        ((e.outcome='refunded' AND p.status='paid' AND COALESCE(e.refunded_amount,e.amount)>p.refunded_amount) OR (e.outcome IN ('paid','failed','expired') AND p.status IN ('unpaid','pending')) OR (e.outcome='paid' AND p.status='expired'))) THEN 'applied'
      WHEN e.outcome='refunded' AND EXISTS(SELECT 1 FROM booking_payments p WHERE p.id=e.payment_id AND p.status NOT IN ('paid','refunded')) THEN 'failed'
      ELSE 'duplicate' END,error_code=NULL WHERE id=? AND lease_token=?`).bind(id, token)];
    if (payment && event.outcome === 'paid') writes.push(...paidBookingPaymentStatements(db, payment, at, true, fence));
    else if (payment && event.outcome==='refunded') {
      writes.push(db.prepare(`INSERT INTO booking_payment_refunds
        (id,payment_id,line_account_id,idempotency_key,amount,requested_amount,reason,actor_id,actor_label,notify_line,notification_status,created_at)
        SELECT ?,p.id,p.line_account_id,?,COALESCE(e.refunded_amount,e.amount)-p.refunded_amount,NULL,
          'provider_refund','system','Stripe',0,'not_requested',?
        FROM booking_payments p JOIN booking_payment_events e ON e.payment_id=p.id
        WHERE e.id=? AND e.lease_token=? AND e.result='applied' AND e.outcome='refunded'
          AND COALESCE(e.refunded_amount,e.amount)>p.refunded_amount AND p.status='paid'
          AND NOT EXISTS(SELECT 1 FROM booking_payment_refunds r WHERE r.id=?)`)
        .bind('event:'+id,'event:'+id,at,id,token,'event:'+id));
      writes.push(db.prepare(`UPDATE booking_payments SET
        confirmation_revision=confirmation_revision+1, status=CASE WHEN ?=amount THEN 'refunded' ELSE 'paid' END,refunded_amount=?,refunded_at=?,updated_at=?,
        receipt_url=COALESCE(?,receipt_url),actor_label='Stripe',action_reason='provider_refund'
        WHERE id=? AND status='paid' AND refunded_amount<? AND (${eventGate})`)
        .bind(event.refunded_amount ?? event.amount,event.refunded_amount ?? event.amount,at,at,event.receipt_url,payment.id,
          event.refunded_amount ?? event.amount,id,token));
    }
    else if (payment) {
      writes.push(db.prepare(`UPDATE booking_payments SET confirmation_revision=confirmation_revision+1, status=?,updated_at=?,
        refunded_at=CASE WHEN ?='refunded' THEN COALESCE(refunded_at,?) ELSE refunded_at END,
        receipt_url=COALESCE(?,receipt_url)
        WHERE id=? AND (${eventGate}) AND
        ((?='refunded' AND status='paid') OR (? IN ('failed','expired') AND status IN ('unpaid','pending')))`)
        .bind(event.outcome, at, event.outcome, at, event.receipt_url, payment.id, id, token, event.outcome, event.outcome));
      if (event.outcome === 'expired') {
        writes.push(db.prepare(`UPDATE bookings SET confirmation_revision = confirmation_revision + 1, status='expired',decided_at=?,updated_at=? WHERE id=? AND line_account_id=?
          AND status='requested' AND (${eventGate}) AND EXISTS(SELECT 1 FROM booking_payments WHERE id=? AND status='expired')`)
          .bind(at, at, payment.booking_id, account, id, token, payment.id));
        writes.push(db.prepare(`INSERT INTO booking_audit_logs(id,booking_id,line_account_id,action,after_json,reason,actor_type,occurred_at)
          SELECT ?,?,?,'expired','{"status":"expired"}','payment_hold_expired','system',? WHERE changes()=1`)
          .bind(crypto.randomUUID(), payment.booking_id, account, at));
      }
    }
    if (payment && event.receipt_url) writes.push(db.prepare(`UPDATE booking_payments SET confirmation_revision=confirmation_revision+1, receipt_url=?
      WHERE id=? AND (${eventGate})`).bind(event.receipt_url,payment.id,id,token));
    writes.push(db.prepare(`UPDATE booking_payment_events SET applied_at=CASE WHEN result='applied' THEN COALESCE(applied_at,?) ELSE applied_at END,
      error_code=CASE WHEN result='failed' THEN 'payment_state_mismatch' WHEN outcome='failed' THEN 'payment_failed' ELSE NULL END
      WHERE id=? AND lease_token=?`).bind(at, id, token));
    if (actorId) writes.push(audit());
    writes.push(db.prepare('UPDATE booking_payment_events SET lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=?').bind(id, token));
    await db.batch(writes);
  } catch {
    // 詳細なDB例外・顧客本文を画面やログへ出さない。失敗も誰が再試行したか残す。
    const failure = [db.prepare(`UPDATE booking_payment_events SET result='failed',error_code='payment_event_apply_failed'
      WHERE id=? AND lease_token=?`).bind(id, token)];
    if (actorId) failure.push(audit());
    failure.push(db.prepare('UPDATE booking_payment_events SET lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=?').bind(id, token));
    await db.batch(failure);
  }
  const result = await db.prepare('SELECT result,outcome,lease_token FROM booking_payment_events WHERE id=? AND line_account_id=?')
    .bind(id, account).first<{ result: string; outcome: string; lease_token: string | null }>();
  if (result?.lease_token) return { status: 'busy_or_missing' };
  return { status: result?.result === 'applied' ? result.outcome : result?.result ?? 'failed', result: result?.result };
}
