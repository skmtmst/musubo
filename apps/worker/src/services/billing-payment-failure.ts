import type { TenantBilling } from '@line-crm/db';

const GRACE_MS = 7 * 24 * 60 * 60 * 1000;

interface OpenInvoiceRow {
  id: string;
  amount_due: number;
  amount_paid: number;
  created_at: string;
  hosted_invoice_url: string | null;
}

export interface BillingPaymentFailure {
  invoiceId: string;
  amountYen: number;
  invoiceCreatedAt: string;
  failedAt: string;
  graceDeadlineAt: string;
  state: 'grace' | 'suspended';
  paymentUrl: string | null;
}

export interface BillingPaymentRecovery {
  invoiceId: string;
  amountYen: number;
  invoiceCreatedAt: string;
  graceDeadlineAt: string;
  paidAt: string;
  nextChargeAt: string | null;
  state: 'recovered';
  paymentUrl: null;
}

export function trustedHostedInvoiceUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'invoice.stripe.com' ? value : null;
  } catch {
    return null;
  }
}

function invoiceCreatedIso(value: string, fallback: Date): string {
  const normalized = value.includes(' ') ? `${value.replace(' ', 'T')}+09:00` : value;
  const parsed = new Date(normalized);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : fallback.toISOString();
}

/**
 * Stripe の失敗イベント発生時刻を正本にする。請求書の作成日を使うと、
 * 作成から決済まで間が空いた請求を7日より早く停止してしまう。
 */
export function paymentFailureState(
  invoice: OpenInvoiceRow,
  firstFailureSeconds: number,
  now: Date,
): BillingPaymentFailure | null {
  if (!Number.isSafeInteger(firstFailureSeconds) || firstFailureSeconds <= 0
    || !Number.isFinite(now.getTime()) || invoice.amount_due <= invoice.amount_paid) return null;
  const failedAt = new Date(firstFailureSeconds * 1000);
  if (!Number.isFinite(failedAt.getTime())) return null;
  const deadline = new Date(failedAt.getTime() + GRACE_MS);
  return {
    invoiceId: invoice.id,
    amountYen: Math.max(0, Math.floor(invoice.amount_due - invoice.amount_paid)),
    invoiceCreatedAt: invoiceCreatedIso(invoice.created_at, failedAt),
    failedAt: failedAt.toISOString(),
    graceDeadlineAt: deadline.toISOString(),
    state: now.getTime() < deadline.getTime() ? 'grace' : 'suspended',
    paymentUrl: trustedHostedInvoiceUrl(invoice.hosted_invoice_url),
  };
}

/** A completed, signed webhook is the only source for the first failure time. */
export async function firstInvoiceFailureSeconds(db: D1Database, tenantId: string, invoiceId: string): Promise<number | null> {
  const row = await db.prepare(`SELECT MIN(CAST(json_extract(safe_summary,'$.created') AS INTEGER)) AS first_failure
    FROM (SELECT CASE WHEN json_valid(summary) THEN summary ELSE '{}' END AS safe_summary
      FROM billing_events WHERE tenant_id=? AND type='invoice.payment_failed')
    WHERE json_extract(safe_summary,'$.state')='completed'
      AND CAST(json_extract(safe_summary,'$.created') AS INTEGER)>0
      AND json_extract(safe_summary,'$.subjectId')=?`)
    .bind(tenantId, invoiceId).first<{ first_failure: number | null }>();
  return row?.first_failure ?? null;
}

/**
 * 現在の契約に属する未払い請求だけを調べる。古いイベントで請求書IDを記録して
 * いないものは失敗日時を確定できないため、停止の根拠にしない。
 */
export async function getBillingPaymentFailure(
  db: D1Database,
  billing: Pick<TenantBilling, 'id' | 'plan_status' | 'stripe_subscription_id'> | null,
  now = new Date(),
): Promise<BillingPaymentFailure | null> {
  if (billing?.plan_status !== 'past_due' || !billing.stripe_subscription_id) return null;
  const invoices = await db.prepare(`SELECT id, amount_due, amount_paid, created_at, hosted_invoice_url
    FROM billing_invoices
    WHERE tenant_id=? AND subscription_id=? AND status IN ('open','uncollectible') AND amount_due>amount_paid
    ORDER BY created_at ASC LIMIT 30`)
    .bind(billing.id, billing.stripe_subscription_id).all<OpenInvoiceRow>();
  let earliest: BillingPaymentFailure | null = null;
  for (const invoice of invoices.results ?? []) {
    const firstFailure = await firstInvoiceFailureSeconds(db, billing.id, invoice.id);
    const failure = paymentFailureState(invoice, firstFailure ?? 0, now);
    if (failure && (!earliest || failure.failedAt < earliest.failedAt)) earliest = failure;
  }
  return earliest;
}

/** Show a recent, verified recovery after Stripe has restored this tenant's current subscription. */
export async function getRecentBillingPaymentRecovery(
  db: D1Database,
  billing: Pick<TenantBilling, 'id' | 'plan_status' | 'stripe_subscription_id' | 'current_period_ends_at'> | null,
  now = new Date(),
): Promise<BillingPaymentRecovery | null> {
  if (billing?.plan_status !== 'active' || !billing.stripe_subscription_id || !Number.isFinite(now.getTime())) return null;
  const since = new Date(now.getTime() - GRACE_MS).toISOString();
  const row = await db.prepare(`SELECT bi.id, bi.amount_due, bi.amount_paid, bi.created_at, bi.paid_at
    FROM billing_invoices bi
    WHERE bi.tenant_id=? AND bi.subscription_id=? AND bi.status='paid'
      AND bi.amount_due>0 AND bi.amount_paid>=bi.amount_due
      AND bi.paid_at IS NOT NULL AND julianday(bi.paid_at)>=julianday(?)
      AND NOT EXISTS (SELECT 1 FROM billing_invoices open_invoice
        WHERE open_invoice.tenant_id=bi.tenant_id AND open_invoice.subscription_id=bi.subscription_id
          AND open_invoice.status IN ('open','uncollectible') AND open_invoice.amount_due>open_invoice.amount_paid)
      AND EXISTS (SELECT 1 FROM billing_events failed
        WHERE failed.tenant_id=bi.tenant_id AND failed.type='invoice.payment_failed'
          AND json_valid(failed.summary) AND json_extract(failed.summary,'$.state')='completed'
          AND json_extract(failed.summary,'$.subjectId')=bi.id)
      AND EXISTS (SELECT 1 FROM billing_events paid
        WHERE paid.tenant_id=bi.tenant_id AND paid.type='invoice.paid'
          AND json_valid(paid.summary) AND json_extract(paid.summary,'$.state')='completed'
          AND json_extract(paid.summary,'$.subjectId')=bi.id
          AND json_extract(paid.summary,'$.applied')=1)
    ORDER BY julianday(bi.paid_at) DESC, bi.id DESC LIMIT 1`)
    .bind(billing.id, billing.stripe_subscription_id, since)
    .first<{ id: string; amount_due: number; amount_paid: number; created_at: string; paid_at: string }>();
  if (!row) return null;
  const paid = new Date(row.paid_at);
  if (!Number.isFinite(paid.getTime()) || paid.getTime() > now.getTime()) return null;
  const firstFailure = await firstInvoiceFailureSeconds(db, billing.id, row.id);
  if (!firstFailure || paid.getTime() < firstFailure * 1000) return null;
  return {
    invoiceId: row.id,
    amountYen: row.amount_paid,
    invoiceCreatedAt: invoiceCreatedIso(row.created_at, paid),
    graceDeadlineAt: new Date(firstFailure * 1000 + GRACE_MS).toISOString(),
    paidAt: paid.toISOString(),
    nextChargeAt: billing.current_period_ends_at,
    state: 'recovered', paymentUrl: null,
  };
}
