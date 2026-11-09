import { prepareBillingInvoice, type MusuboTenantBillingRecord } from '@line-crm/db';
import { jstDate, musuboChargeDateEpoch } from '@line-crm/shared';
import { billingInvoiceInput } from './billing-invoices-sync.js';
import type { StripeInvoice } from './stripe-api.js';

interface MusuboBillingEvent {
  id: string;
  type: string;
  created?: number;
  data: { object: Record<string, unknown> };
}

function stripeId(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string') {
    return (value as { id: string }).id;
  }
  return null;
}

/** The signed event must belong to a stored core/options contract, never only to tenant metadata. */
export async function processMusuboBillingEvent(input: {
  db: D1Database;
  event: MusuboBillingEvent;
  tenantId: string;
  customerId: string;
  billing: MusuboTenantBillingRecord;
}): Promise<'completed' | 'retry'> {
  const { db, event, tenantId, customerId, billing } = input;
  const object = event.data.object;
  const subscriptionId = event.type.startsWith('customer.subscription.')
    ? stripeId(object.id) : stripeId(object.subscription);
  if (!subscriptionId) return 'retry';
  const kind = subscriptionId === billing.core_subscription_id ? 'core'
    : subscriptionId === billing.options_subscription_id ? 'options' : null;
  if (!kind) return 'retry';
  if (stripeId(object.customer) !== customerId) return 'retry';
  if (event.type.startsWith('customer.subscription.')) {
    const metadata = (object.metadata ?? {}) as Record<string, unknown>;
    if (metadata.tenant_id !== tenantId || metadata.purpose !== `musubo_${kind}`) return 'retry';
  }
  const subjectId = event.type.startsWith('invoice.') ? stripeId(object.id) : null;
  const created = Number.isSafeInteger(event.created) && (event.created ?? 0) > 0 ? event.created! : 0;
  if (event.type === 'invoice.payment_failed' && created === 0) return 'retry';
  const pending = { sql: "EXISTS (SELECT 1 FROM billing_events WHERE id=? AND summary='pending')", values: [event.id] };
  const statements: D1PreparedStatement[] = [];
  if (event.type === 'invoice.paid' || event.type === 'invoice.payment_failed'
    || event.type === 'invoice.voided' || event.type === 'invoice.marked_uncollectible') {
    if (!subjectId) return 'retry';
    const invoice = object as unknown as StripeInvoice;
    if (!Number.isSafeInteger(invoice.amount_due) || !Number.isSafeInteger(invoice.amount_paid)
      || (invoice.amount_due ?? 0) < 0 || (invoice.amount_paid ?? 0) < 0) return 'retry';
    const invoiceStatus = event.type === 'invoice.paid' ? 'paid'
      : event.type === 'invoice.payment_failed' ? 'open'
      : event.type === 'invoice.voided' ? 'void' : 'uncollectible';
    statements.push(prepareBillingInvoice(db, billingInvoiceInput({
      ...invoice, customer: customerId, subscription: subscriptionId, status: invoiceStatus,
    }, { tenantId }), pending));
    // A paid renewal is the source of truth for the next billing date. Ignore
    // prorations and stale deliveries so they cannot move the date backwards.
    if (event.type === 'invoice.paid' && invoice.billing_reason === 'subscription_cycle'
      && Number.isSafeInteger(invoice.period_end) && (invoice.period_end ?? 0) > 0) {
      const nextDate = jstDate(new Date(invoice.period_end! * 1000));
      const column = kind === 'options' || billing.billing_interval === 'month'
        ? 'next_monthly_charge_at' : 'next_annual_renewal_at';
      statements.push(db.prepare(`UPDATE musubo_tenant_billing
        SET ${column}=?,updated_at=?
        WHERE tenant_id=? AND ${kind === 'core' ? 'core_subscription_id' : 'options_subscription_id'}=?
          AND (${column} IS NULL OR ${column}<?)
          AND EXISTS (SELECT 1 FROM billing_events WHERE id=? AND summary='pending')`)
        .bind(nextDate, new Date().toISOString(), tenantId, subscriptionId, nextDate, event.id));
    }
    if (kind === 'core' && (event.type === 'invoice.payment_failed'
      || event.type === 'invoice.marked_uncollectible')
      && (invoice.amount_due ?? 0) > (invoice.amount_paid ?? 0)) {
      statements.push(db.prepare(`UPDATE musubo_tenant_billing SET status='past_due',updated_at=?
        WHERE tenant_id=? AND core_subscription_id=? AND status IN ('trialing','active','past_due')
          AND EXISTS (SELECT 1 FROM billing_invoices
            WHERE id=? AND tenant_id=? AND subscription_id=?
              AND status IN ('open','uncollectible') AND amount_due>amount_paid)
          AND EXISTS (SELECT 1 FROM billing_events WHERE id=? AND summary='pending')`)
        .bind(new Date().toISOString(), tenantId, subscriptionId,
          subjectId, tenantId, subscriptionId, event.id));
    } else if (kind === 'core' && event.type === 'invoice.paid'
      && (invoice.amount_due ?? 0) > 0 && (invoice.amount_paid ?? 0) >= (invoice.amount_due ?? 0)
      && billing.first_charge_date && created >= musuboChargeDateEpoch(billing.first_charge_date)) {
      statements.push(db.prepare(`UPDATE musubo_tenant_billing SET status='active',updated_at=?
        WHERE tenant_id=? AND core_subscription_id=? AND status IN ('trialing','active','past_due')
          AND NOT EXISTS (SELECT 1 FROM billing_invoices
            WHERE tenant_id=? AND subscription_id=? AND status IN ('open','uncollectible')
              AND amount_due>amount_paid)
          AND EXISTS (SELECT 1 FROM billing_events WHERE id=? AND summary='pending')`)
        .bind(new Date().toISOString(), tenantId, subscriptionId, tenantId, subscriptionId, event.id));
    }
  } else if (kind === 'core' && event.type === 'customer.subscription.deleted') {
    // Stripe can cancel an unpaid contract independently of a requested account closure.
    // Remove access until operations reconcile it; never report it as a voluntary termination.
    statements.push(db.prepare(`UPDATE musubo_tenant_billing SET status='past_due',updated_at=?
      WHERE tenant_id=? AND core_subscription_id=? AND status IN ('trialing','active')
        AND EXISTS (SELECT 1 FROM billing_events WHERE id=? AND summary='pending')`)
      .bind(new Date().toISOString(), tenantId, subscriptionId, event.id));
  }
  statements.push(db.prepare(`UPDATE billing_events SET summary=json_object(
    'state','completed','created',?,'subscriptionId',?,'subjectId',?,'applied',1)
    WHERE id=? AND summary='pending'`).bind(created, subscriptionId, subjectId, event.id));
  await db.batch(statements);
  return 'completed';
}
