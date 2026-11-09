import type { BillingWriteCondition } from './tenant-billing.js';
import { jstNow } from './utils.js';

export const BILLING_INVOICES_LAST_SYNCED_KEY = 'billing_invoices_last_synced_at';

export type BillingInvoiceInterval = 'month' | 'year';

export interface BillingInvoice {
  id: string;
  tenant_id: string;
  stripe_customer_id: string | null;
  subscription_id: string | null;
  status: string | null;
  amount_paid: number;
  amount_due: number;
  amount_refunded: number;
  currency: string;
  interval: BillingInvoiceInterval | null;
  period_start: string | null;
  period_end: string | null;
  paid_at: string | null;
  hosted_invoice_url: string | null;
  raw_updated_at: string | null;
  synced_at: string;
  created_at: string;
}

export interface BillingInvoiceInput {
  id: string;
  tenantId: string;
  stripeCustomerId?: string | null;
  subscriptionId?: string | null;
  status?: string | null;
  amountPaid?: number;
  amountDue?: number;
  amountRefunded?: number;
  currency?: string;
  interval?: BillingInvoiceInterval | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  paidAt?: string | null;
  hostedInvoiceUrl?: string | null;
  rawUpdatedAt?: string | null;
  syncedAt?: string;
  createdAt?: string;
}

/** Webhook と同期の両方から同じ請求書を安全に更新する。 */
export async function upsertBillingInvoice(db: D1Database, input: BillingInvoiceInput): Promise<void> {
  await prepareBillingInvoice(db, input).run();
}

export function prepareBillingInvoice(db: D1Database, input: BillingInvoiceInput, condition?: BillingWriteCondition): D1PreparedStatement {
  const now = input.syncedAt ?? jstNow();
  const createdAt = input.createdAt ?? now;
  const refunded = input.amountRefunded;
  return db.prepare(
    `INSERT INTO billing_invoices (
       id, tenant_id, stripe_customer_id, subscription_id, status,
       amount_paid, amount_due, amount_refunded, currency, interval,
       period_start, period_end, paid_at, hosted_invoice_url, raw_updated_at,
       synced_at, created_at
     ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${condition?.sql ?? '1'}
     ON CONFLICT(id) DO UPDATE SET
       tenant_id = excluded.tenant_id,
       stripe_customer_id = COALESCE(excluded.stripe_customer_id, billing_invoices.stripe_customer_id),
       subscription_id = COALESCE(excluded.subscription_id, billing_invoices.subscription_id),
       status = COALESCE(excluded.status, billing_invoices.status),
       amount_paid = excluded.amount_paid,
       amount_due = excluded.amount_due,
       amount_refunded = CASE WHEN ? = 1 THEN excluded.amount_refunded ELSE billing_invoices.amount_refunded END,
       currency = excluded.currency,
       interval = COALESCE(excluded.interval, billing_invoices.interval),
       period_start = COALESCE(excluded.period_start, billing_invoices.period_start),
       period_end = COALESCE(excluded.period_end, billing_invoices.period_end),
       paid_at = COALESCE(excluded.paid_at, billing_invoices.paid_at),
       hosted_invoice_url = COALESCE(excluded.hosted_invoice_url, billing_invoices.hosted_invoice_url),
       raw_updated_at = COALESCE(excluded.raw_updated_at, billing_invoices.raw_updated_at),
       synced_at = excluded.synced_at
     WHERE billing_invoices.status NOT IN ('paid', 'void')
       OR excluded.status IN ('paid', 'void')`,
  ).bind(
    input.id,
    input.tenantId,
    input.stripeCustomerId ?? null,
    input.subscriptionId ?? null,
    input.status ?? null,
    input.amountPaid ?? 0,
    input.amountDue ?? 0,
    refunded ?? 0,
    (input.currency ?? 'jpy').toLowerCase(),
    input.interval ?? null,
    input.periodStart ?? null,
    input.periodEnd ?? null,
    input.paidAt ?? null,
    input.hostedInvoiceUrl ?? null,
    input.rawUpdatedAt ?? null,
    now,
    createdAt,
    ...(condition?.values ?? []),
    refunded === undefined ? 0 : 1,
  );
}

export async function updateBillingInvoiceRefund(
  db: D1Database,
  input: { invoiceId: string; amountRefunded: number; syncedAt?: string },
): Promise<boolean> {
  const result = await db.prepare(
    'UPDATE billing_invoices SET amount_refunded = ?, synced_at = ? WHERE id = ?',
  ).bind(Math.max(0, Math.floor(input.amountRefunded)), input.syncedAt ?? jstNow(), input.invoiceId).run();
  return (result.meta?.changes ?? 0) > 0;
}

export interface BillingSyncTenant {
  id: string;
  stripe_customer_id: string;
}

export async function listBillingSyncTenants(db: D1Database, excludeTenantId: string): Promise<BillingSyncTenant[]> {
  const { results } = await db.prepare(
    `SELECT id, stripe_customer_id FROM tenants
      WHERE id <> ? AND status <> 'archived'
        AND (plan_status <> 'exempt' OR EXISTS (
          SELECT 1 FROM musubo_tenant_billing mb
          WHERE mb.tenant_id=tenants.id AND mb.core_subscription_id IS NOT NULL))
        AND stripe_customer_id IS NOT NULL AND stripe_customer_id <> ''
      ORDER BY id`,
  ).bind(excludeTenantId).all<BillingSyncTenant>();
  return results ?? [];
}

export async function countBillingInvoices(db: D1Database, excludeTenantId: string): Promise<number> {
  const row = await db.prepare(
    `SELECT COUNT(*) AS n FROM billing_invoices bi
      JOIN tenants t ON t.id = bi.tenant_id
      WHERE t.id <> ? AND t.status <> 'archived'
        AND (t.plan_status <> 'exempt' OR EXISTS (
          SELECT 1 FROM musubo_tenant_billing mb
          WHERE mb.tenant_id=t.id AND mb.core_subscription_id IS NOT NULL))`,
  ).bind(excludeTenantId).first<{ n: number }>();
  return row?.n ?? 0;
}

export interface BillingRevenueTotals {
  revenue: number;
  refunds: number;
}

export async function billingRevenueTotals(
  db: D1Database,
  input: { excludeTenantId: string; from: string; to: string },
): Promise<BillingRevenueTotals> {
  const row = await db.prepare(
    `SELECT
       COALESCE(SUM(bi.amount_paid - bi.amount_refunded), 0) AS revenue,
       COALESCE(SUM(bi.amount_refunded), 0) AS refunds
     FROM billing_invoices bi
     JOIN tenants t ON t.id = bi.tenant_id
     WHERE bi.status = 'paid' AND lower(bi.currency) = 'jpy'
       AND bi.paid_at >= ? AND bi.paid_at < ?
       AND t.id <> ? AND t.status <> 'archived'
       AND (t.plan_status <> 'exempt' OR EXISTS (
         SELECT 1 FROM musubo_tenant_billing mb
         WHERE mb.tenant_id=t.id AND mb.core_subscription_id IS NOT NULL))`,
  ).bind(input.from, input.to, input.excludeTenantId).first<{ revenue: number; refunds: number }>();
  return { revenue: row?.revenue ?? 0, refunds: row?.refunds ?? 0 };
}

export async function latestPaidBillingInvoices(
  db: D1Database,
  input: { excludeTenantId: string },
): Promise<Map<string, BillingInvoice>> {
  const { results } = await db.prepare(
    `SELECT * FROM (
       SELECT bi.*, ROW_NUMBER() OVER (PARTITION BY bi.tenant_id ORDER BY bi.paid_at DESC, bi.id DESC) AS rn
       FROM billing_invoices bi
       JOIN tenants t ON t.id = bi.tenant_id
       WHERE bi.status = 'paid' AND lower(bi.currency) = 'jpy'
         AND t.id <> ? AND t.status <> 'archived'
         AND (t.plan_status <> 'exempt' OR EXISTS (
           SELECT 1 FROM musubo_tenant_billing mb
           WHERE mb.tenant_id=t.id AND mb.core_subscription_id IS NOT NULL))
     ) WHERE rn = 1`,
  ).bind(input.excludeTenantId).all<BillingInvoice & { rn: number }>();
  return new Map((results ?? []).map((row) => [row.tenant_id, row]));
}
