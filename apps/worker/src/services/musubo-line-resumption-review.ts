import { getMusuboIndividualQuote, getMusuboTenantBilling, musuboQuoteFromRecord } from '@line-crm/db';
import { jstDate, type AppliedMusuboCondition } from '@line-crm/shared';
import { firstMusuboCoreTerms } from './musubo-contract-terms.js';

interface InvoiceRow {
  subscription_id: string | null;
  status: string | null;
  amount_due: number;
  amount_paid: number;
  created_at: string;
  period_start: string | null;
  period_end: string | null;
}

export type MusuboLineResumptionReview =
  | { kind: 'trial_remaining'; conditionName: string; freeUntil: string; nextChargeAt: string;
    nextLineBaseYen: number; trialPeriodLabel: string; interval: 'month' | 'year' }
  | { kind: 'monthly_paid'; conditionName: string; paidThrough: string; renewalAt: string;
    nextLineBaseYen: number }
  | { kind: 'annual_paid'; conditionName: string; paidThrough: string; renewalAt: string;
    nextAnnualLineBaseYen: number }
  | { kind: 'paid_expired'; conditionName: string; interval: 'month' | 'year';
    dueOnConnectionYen: number; nextLineBaseYen: number }
  | { kind: 'unpaid'; amountDueYen: number; invoiceAt: string; periodStart: string; periodEnd: string };

function asInstant(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Billing date is invalid');
  const instant = `${value}T00:00:00+09:00`;
  if (!Number.isFinite(Date.parse(instant))) throw new Error('Billing date is invalid');
  return instant;
}

/** Only a paid core invoice with a covering service period proves prepaid access. */
export async function getMusuboLineResumptionReview(db: D1Database, tenantId: string,
  now = new Date()): Promise<MusuboLineResumptionReview> {
  const billing = await getMusuboTenantBilling(db, tenantId);
  if (!billing || billing.status !== 'ended' || !billing.ended_at || !billing.first_line_activated_at
    || !billing.first_charge_date) throw new Error('An ended musubo contract is required');
  const active = await db.prepare(`SELECT line_account_id FROM musubo_line_usage
    WHERE tenant_id=? AND status IN ('active','ending','pending') LIMIT 1`)
    .bind(tenantId).first<{ line_account_id: string }>();
  if (active) throw new Error('A LINE is already active or awaiting payment');
  const unsettled = await db.prepare(`SELECT status,amount_due,amount_paid,created_at,period_start,period_end
    FROM billing_invoices WHERE tenant_id=? AND status IN ('open','uncollectible')
      AND amount_due>amount_paid ORDER BY created_at DESC`)
    .bind(tenantId).all<InvoiceRow>();
  const unpaid = unsettled.results ?? [];
  if (unpaid.length) {
    const amountDueYen = unpaid.reduce((sum, row) => sum + row.amount_due - row.amount_paid, 0);
    if (!Number.isSafeInteger(amountDueYen) || !unpaid[0]?.period_start || !unpaid[0].period_end) {
      throw new Error('Unpaid invoice detail is incomplete');
    }
    return { kind: 'unpaid', amountDueYen, invoiceAt: unpaid[0].created_at,
      periodStart: unpaid[0].period_start, periodEnd: unpaid[0].period_end };
  }
  const invoices = await db.prepare(`SELECT subscription_id,status,amount_due,amount_paid,created_at,period_start,period_end
    FROM billing_invoices WHERE tenant_id=? AND subscription_id=?
    ORDER BY created_at DESC LIMIT 100`)
    .bind(tenantId, billing.core_subscription_id ?? '').all<InvoiceRow>();
  if (!billing.core_subscription_id && invoices.results?.length) throw new Error('Core invoice identity is unavailable');
  const condition = JSON.parse(billing.pricing_snapshot_json) as AppliedMusuboCondition;
  const quoteRow = billing.quote_id ? await getMusuboIndividualQuote(db, billing.quote_id) : null;
  if (billing.quote_id && (!quoteRow || quoteRow.tenant_id !== tenantId || quoteRow.status !== 'accepted')) {
    throw new Error('Accepted quote is unavailable');
  }
  const quote = quoteRow ? musuboQuoteFromRecord(quoteRow) : null;
  const nextBase = (chargeDate: string) => firstMusuboCoreTerms({ condition, quote,
    interval: billing.billing_interval, firstChargeDate: chargeDate }).amountYen;
  const conditionName = quote ? '個別見積もり' : condition.internalName;
  const nowEpoch = now.getTime();
  const firstChargeAt = asInstant(billing.first_charge_date);
  const paidBefore = (invoices.results ?? []).some((row) => row.subscription_id === billing.core_subscription_id && row.status === 'paid'
    && row.amount_due > 0 && row.amount_paid >= row.amount_due);
  if (!paidBefore && Date.parse(firstChargeAt) > nowEpoch) {
    if (!billing.trial_last_free_date) throw new Error('Original trial end is unavailable');
    return { kind: 'trial_remaining', conditionName,
      freeUntil: `${billing.trial_last_free_date}T23:59:59+09:00`, nextChargeAt: firstChargeAt,
      nextLineBaseYen: nextBase(billing.first_charge_date),
      trialPeriodLabel: `${condition.trialPeriod.value}${condition.trialPeriod.unit === 'days' ? '日間' : 'か月間'}`,
      interval: billing.billing_interval };
  }
  const covering = (invoices.results ?? []).find((row) => row.subscription_id === billing.core_subscription_id && row.status === 'paid'
    && row.amount_due > 0 && row.amount_paid >= row.amount_due
    && row.period_start && row.period_end
    && Date.parse(row.period_start) <= nowEpoch && Date.parse(row.period_end) > nowEpoch);
  if (covering?.period_end) {
    const renewalAt = covering.period_end;
    const paidThrough = new Date(Date.parse(renewalAt) - 1).toISOString();
    const amount = nextBase(jstDate(new Date(renewalAt)));
    return billing.billing_interval === 'year'
      ? { kind: 'annual_paid', conditionName, paidThrough, renewalAt,
        nextAnnualLineBaseYen: amount }
      : { kind: 'monthly_paid', conditionName, paidThrough, renewalAt,
        nextLineBaseYen: amount };
  }
  const recordedNext = billing.billing_interval === 'year'
    ? billing.next_annual_renewal_at : billing.next_monthly_charge_at;
  if (recordedNext && Date.parse(asInstant(recordedNext)) > nowEpoch) {
    throw new Error('The paid period must be reconciled before resumption');
  }
  const amount = nextBase(jstDate(now));
  return { kind: 'paid_expired', conditionName, interval: billing.billing_interval,
    dueOnConnectionYen: amount, nextLineBaseYen: amount };
}

/** Consent captures the server's current offer; reactivation must compare it again. */
export async function acceptMusuboLineResumption(db: D1Database, tenantId: string,
  now = new Date()): Promise<Exclude<MusuboLineResumptionReview, { kind: 'unpaid' }>> {
  const review = await getMusuboLineResumptionReview(db, tenantId, now);
  if (review.kind === 'unpaid') throw new Error('Past invoices must be paid before resumption');
  const billing = await getMusuboTenantBilling(db, tenantId);
  if (!billing || billing.status !== 'ended') throw new Error('An ended musubo contract is required');
  const offer = JSON.stringify(review);
  if (billing.resumption_consented_at && billing.resumption_offer_json === offer) return review;
  const result = await db.prepare(`UPDATE musubo_tenant_billing
    SET resumption_generation=resumption_generation+1,
      resumption_offer_json=?,resumption_consented_at=?,updated_at=?
    WHERE tenant_id=? AND status='ended' AND resumption_generation=?`)
    .bind(offer, now.toISOString(), now.toISOString(), tenantId, billing.resumption_generation).run();
  if ((result.meta?.changes ?? 0) !== 1) throw new Error('Resumption offer changed');
  return review;
}

export async function acceptedMusuboLineResumption(db: D1Database, tenantId: string,
  now = new Date()): Promise<{ generation: number; review: Exclude<MusuboLineResumptionReview,
  { kind: 'unpaid' }> }> {
  const billing = await getMusuboTenantBilling(db, tenantId);
  if (!billing || billing.status !== 'ended' || !billing.resumption_consented_at
    || !billing.resumption_offer_json) throw new Error('Resumption consent is unavailable');
  const review = await getMusuboLineResumptionReview(db, tenantId, now);
  if (review.kind === 'unpaid' || JSON.stringify(review) !== billing.resumption_offer_json) {
    throw new Error('Resumption price or payment status changed');
  }
  return { generation: billing.resumption_generation, review };
}
