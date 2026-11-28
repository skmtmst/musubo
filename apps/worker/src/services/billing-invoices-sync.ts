import { logger } from '@line-crm/shared/server';
import {
  BILLING_INVOICES_LAST_SYNCED_KEY,
  getPlatformSetting,
  listBillingSyncTenants,
  setPlatformSetting,
  toJstString,
  upsertBillingInvoice,
  type BillingInvoiceInput,
  type BillingInvoiceInterval,
} from '@line-crm/db';

import { DEFAULT_TENANT_ID } from '../lib/tenant.js';
import { stripeApi, stripeExpandableId, stripeInvoiceSubscriptionId, type StripeEnv, type StripeInvoice } from './stripe-api.js';

const DAY_SECONDS = 24 * 60 * 60;
const INITIAL_MONTHS = 12;
const SYNC_BUDGET_MS = 55_000;

export interface BillingInvoiceSyncEnv extends StripeEnv {
  DB: D1Database;
}

export interface BillingInvoiceSyncResult {
  tenants: number;
  imported: number;
  failed: number;
  completed: boolean;
  since: string;
  syncedAt: string | null;
}

function timestampIso(value: unknown): string | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? toJstString(new Date(value * 1000))
    : null;
}

function invoiceInterval(invoice: StripeInvoice): BillingInvoiceInterval | null {
  const interval = invoice.lines?.data?.[0]?.price?.recurring?.interval;
  return interval === 'month' || interval === 'year' ? interval : null;
}

function refundedAmount(invoice: StripeInvoice): number | undefined {
  return invoice.charge && typeof invoice.charge === 'object'
    ? Math.max(0, Math.floor(invoice.charge.amount_refunded ?? 0))
    : undefined;
}

/** Stripe の請求書から、保存してよい非PII項目だけを取り出す。 */
export function billingInvoiceInput(
  invoice: StripeInvoice,
  input: { tenantId: string; fallbackPaidAt?: string | null; syncedAt?: string },
): BillingInvoiceInput {
  const createdAt = timestampIso(invoice.created) ?? input.syncedAt ?? toJstString(new Date());
  const paidAt = timestampIso(invoice.status_transitions?.paid_at)
    ?? (invoice.status === 'paid' ? input.fallbackPaidAt ?? createdAt : null);
  return {
    id: invoice.id,
    tenantId: input.tenantId,
    stripeCustomerId: stripeExpandableId(invoice.customer),
    subscriptionId: stripeInvoiceSubscriptionId(invoice),
    status: invoice.status,
    amountPaid: Math.max(0, Math.floor(invoice.amount_paid ?? 0)),
    amountDue: Math.max(0, Math.floor(invoice.amount_due ?? 0)),
    amountRefunded: refundedAmount(invoice),
    currency: (invoice.currency || 'jpy').toLowerCase(),
    interval: invoiceInterval(invoice),
    periodStart: timestampIso(invoice.period_start),
    periodEnd: timestampIso(invoice.period_end),
    paidAt,
    hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
    rawUpdatedAt: createdAt,
    syncedAt: input.syncedAt,
    createdAt,
  };
}

function errorKind(error: unknown): string {
  if (error instanceof Error && error.name) return error.name;
  return 'unknown';
}

export async function syncBillingInvoices(
  env: BillingInvoiceSyncEnv,
  input: { since: Date; tenantId?: string; now?: Date; budgetMs?: number },
): Promise<BillingInvoiceSyncResult> {
  if (!env.STRIPE_SECRET_KEY) throw new Error('STRIPE_NOT_CONFIGURED');
  const started = Date.now();
  const now = input.now ?? new Date();
  const syncedAt = toJstString(now);
  const sinceSeconds = Math.floor(input.since.getTime() / 1000);
  const allTenants = await listBillingSyncTenants(env.DB, DEFAULT_TENANT_ID);
  const tenants = input.tenantId ? allTenants.filter((tenant) => tenant.id === input.tenantId) : allTenants;
  let imported = 0;
  let failed = 0;
  let completed = true;

  for (const tenant of tenants) {
    if (Date.now() - started >= (input.budgetMs ?? SYNC_BUDGET_MS)) {
      completed = false;
      break;
    }
    let startingAfter: string | undefined;
    let tenantImported = 0;
    try {
      do {
        const page = await stripeApi.listInvoices(env, tenant.stripe_customer_id, {
          limit: 100,
          startingAfter,
          createdGte: sinceSeconds,
        });
        for (const invoice of page.data) {
          await upsertBillingInvoice(env.DB, billingInvoiceInput(invoice, {
            tenantId: tenant.id,
            syncedAt,
          }));
          imported += 1;
          tenantImported += 1;
        }
        startingAfter = page.has_more ? page.data.at(-1)?.id : undefined;
        if (page.has_more && !startingAfter) throw new Error('STRIPE_PAGING_CURSOR_MISSING');
      } while (startingAfter);
    } catch (error) {
      failed += 1;
      logger.warn("billing_invoice_sync_failed");
    }
  }

  if (failed > 0) completed = false;
  if (completed && !input.tenantId) {
    await setPlatformSetting(env.DB, BILLING_INVOICES_LAST_SYNCED_KEY, syncedAt, 'system');
  }
  return {
    tenants: tenants.length,
    imported,
    failed,
    completed,
    since: toJstString(input.since),
    syncedAt: completed ? syncedAt : null,
  };
}

export async function syncBillingInvoicesDaily(
  env: BillingInvoiceSyncEnv,
  now = new Date(),
): Promise<BillingInvoiceSyncResult | null> {
  // Stripe を使わない環境では定期ジョブ自体を静かに止める。手動同期は明示的な 503 にする。
  if (!env.STRIPE_SECRET_KEY) return null;
  const last = await getPlatformSetting(env.DB, BILLING_INVOICES_LAST_SYNCED_KEY);
  if (last && now.getTime() - new Date(last).getTime() < DAY_SECONDS * 1000) return null;
  const since = last
    ? new Date(new Date(last).getTime() - 7 * DAY_SECONDS * 1000)
    : new Date(now);
  if (!last) since.setUTCMonth(since.getUTCMonth() - INITIAL_MONTHS);
  return syncBillingInvoices(env, { since, now });
}
