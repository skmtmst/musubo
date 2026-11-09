import { musuboIndividualQuotePrice, musuboPrice,
  type AppliedMusuboCondition, type MusuboPriceBreakdown } from '@line-crm/shared';
import { getMusuboIndividualQuote, musuboQuoteFromRecord,
  type MusuboTenantBillingRecord } from '@line-crm/db';

interface ActiveLineRow {
  id: string;
  name: string;
  google_business_count: number;
  instagram_count: number;
}

export interface MusuboBillingOverview {
  status: MusuboTenantBillingRecord['status'];
  billingInterval: MusuboTenantBillingRecord['billing_interval'];
  activeLines: Array<{ id: string; name: string }>;
  trialLastFreeDate: string | null;
  firstChargeDate: string | null;
  /** The saved signup friend count is only an estimate until LINE insight is ready. */
  estimatedPrice: MusuboPriceBreakdown | null;
  contractedCore: { lineCapacity: number; amountYen: number; interval: 'month' | 'year' } | null;
  quoteId: string | null;
}

/** Read-only view. No saved signup number becomes a final Stripe charge here. */
export async function musuboBillingOverview(
  db: D1Database,
  tenantId: string,
  billing: MusuboTenantBillingRecord,
): Promise<MusuboBillingOverview> {
  const response = await db.prepare(`SELECT a.id,a.name,u.google_business_count,u.instagram_count
    FROM musubo_line_usage u JOIN line_accounts a ON a.id=u.line_account_id
    WHERE u.tenant_id=? AND u.status IN ('active','ending')
    ORDER BY u.activated_at,a.id`).bind(tenantId).all<ActiveLineRow>();
  const active = response.results ?? [];
  let estimatedPrice: MusuboPriceBreakdown | null = null;
  let contractedCore: MusuboBillingOverview['contractedCore'] = null;
  if (billing.quote_id) {
    const row = await getMusuboIndividualQuote(db, billing.quote_id);
    if (!row || row.tenant_id !== tenantId || row.status !== 'accepted') {
      throw new Error('Accepted individual quote is unavailable');
    }
    const quote = musuboQuoteFromRecord(row);
    if (quote.plannedLineCount > 10) {
      const amount = musuboIndividualQuotePrice(quote);
      contractedCore = {
        lineCapacity: quote.plannedLineCount,
        amountYen: quote.interval === 'year' ? amount.finalAnnualLineChargeYen! : amount.finalLineBasicMonthlyYen,
        interval: quote.interval,
      };
    }
  }
  if (!billing.quote_id && billing.pricing_selection_json && active.length > 0) {
    const condition = JSON.parse(billing.pricing_snapshot_json) as AppliedMusuboCondition;
    const planned = JSON.parse(billing.pricing_selection_json) as {
      selection: { lineCount: number; friendCountExcludingBlocked: number };
    };
    if (planned.selection.lineCount === active.length) estimatedPrice = musuboPrice({
      lineCount: active.length,
      friendCountExcludingBlocked: planned.selection.friendCountExcludingBlocked,
      linkedAccountsByLine: active.map((row) => ({
        googleBusiness: row.google_business_count,
        instagram: row.instagram_count,
      })),
      interval: billing.billing_interval,
      lineBasicDiscountPercent: condition.lineBasicDiscountPercent,
      schedule: condition.schedule,
    });
  }
  return {
    status: billing.status,
    billingInterval: billing.billing_interval,
    activeLines: active.map(({ id, name }) => ({ id, name })),
    trialLastFreeDate: billing.trial_last_free_date,
    firstChargeDate: billing.first_charge_date,
    estimatedPrice,
    contractedCore,
    quoteId: billing.quote_id,
  };
}
