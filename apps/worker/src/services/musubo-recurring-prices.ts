import {
  getLineAccountsByIds, getMusuboIndividualQuote, getMusuboTenantBilling, getTenantBilling,
  musuboQuoteFromRecord,
} from '@line-crm/db';
import {
  friendAllowanceForLineCount, jstDate, jstDateOffset, lineBasicDiscountForDate,
  linkedAccountSlots, musuboIndividualQuotePrice, musuboPrice,
  type AppliedMusuboCondition,
} from '@line-crm/shared';
import type { WorkerBindings } from '../worker-bindings.js';
import { fetchPreConnectFollowerInsight } from './musubo-large-line-consultation.js';
import { stripeApi, type StripeSubscription } from './stripe-api.js';

interface Usage {
  line_account_id: string;
  friend_count_excluding_blocked: number | null;
  friend_count_measured_on: string | null;
  google_business_count: number;
  instagram_count: number;
}

function currentPrice(subscription: StripeSubscription, input: {
  tenantId: string; customerId: string; purpose: 'core' | 'options'; productId?: string;
  interval: 'month' | 'year';
}): { itemId: string; amountYen: number } {
  const item = subscription.items.data[0];
  if (subscription.customer !== input.customerId
    || subscription.metadata?.tenant_id !== input.tenantId
    || subscription.metadata?.purpose !== `musubo_${input.purpose}`
    || !['trialing', 'active'].includes(subscription.status)
    || subscription.items.data.length !== 1 || !item?.id
    || item.price.product !== input.productId
    || item.price.recurring?.interval !== input.interval
    || !Number.isSafeInteger(item.price.unit_amount)) {
    throw new Error('The Stripe contract does not match the agreed musubo terms');
  }
  return { itemId: item.id, amountYen: item.price.unit_amount! };
}

/** Refresh only completed LINE statistics; never estimate an unconfirmed friend count. */
async function currentUsage(env: WorkerBindings, tenantId: string): Promise<Usage[]> {
  const rows = await env.DB.prepare(`SELECT line_account_id,friend_count_excluding_blocked,
    friend_count_measured_on,google_business_count,instagram_count
    FROM musubo_line_usage WHERE tenant_id=? AND status IN ('active','ending')
    ORDER BY activated_at LIMIT 100`).bind(tenantId).all<Usage>();
  const usage = rows.results ?? [];
  if (!usage.length || usage.length >= 100) throw new Error('Active LINE usage is unavailable');
  const yesterday = jstDateOffset(-1);
  const stale = usage.filter((row) => row.friend_count_measured_on !== yesterday);
  if (stale.length) {
    const accounts = await getLineAccountsByIds(env.DB, stale.map((row) => row.line_account_id),
      env.LINE_CREDENTIAL_ENCRYPTION_KEY);
    if (accounts.length !== stale.length) throw new Error('LINE credentials are incomplete');
    for (const account of accounts) {
      const insight = await fetchPreConnectFollowerInsight(account.channel_access_token);
      if (!insight || insight.measuredOn !== yesterday) throw new Error('Completed LINE statistics are unavailable');
      const updated = await env.DB.prepare(`UPDATE musubo_line_usage SET friend_count_excluding_blocked=?,
        friend_count_measured_on=?,updated_at=? WHERE line_account_id=? AND tenant_id=?
          AND status IN ('active','ending')`)
        .bind(insight.friendsExcludingBlocked, yesterday, new Date().toISOString(), account.id, tenantId).run();
      if ((updated.meta?.changes ?? 0) !== 1) throw new Error('LINE usage changed during refresh');
      const row = usage.find((entry) => entry.line_account_id === account.id)!;
      row.friend_count_excluding_blocked = insight.friendsExcludingBlocked;
      row.friend_count_measured_on = yesterday;
    }
  }
  if (usage.some((row) => row.friend_count_excluding_blocked === null
    || row.friend_count_measured_on !== yesterday)) throw new Error('LINE usage is not verified');
  return usage;
}

/** Prices are changed without prorations so a paid period is never refunded or rebilled. */
export async function reconcileMusuboRecurringPrices(env: WorkerBindings, tenantId: string): Promise<boolean> {
  const billing = await getMusuboTenantBilling(env.DB, tenantId);
  if (!billing || !['trialing', 'active'].includes(billing.status)
    || !billing.core_subscription_id || !billing.options_subscription_id
    || billing.termination_effective_at) return false;
  const pending = await env.DB.prepare(`SELECT id FROM musubo_pending_additions WHERE tenant_id=?
    AND status IN ('awaiting_payment','paid') LIMIT 1`).bind(tenantId).first<{ id: string }>();
  if (pending) return false;
  const legacy = await getTenantBilling(env.DB, tenantId);
  if (!legacy?.stripe_customer_id) throw new Error('Stripe customer is unavailable');
  const usage = await currentUsage(env, tenantId);
  const condition = JSON.parse(billing.pricing_snapshot_json) as AppliedMusuboCondition;
  const quoteRow = billing.quote_id ? await getMusuboIndividualQuote(env.DB, billing.quote_id) : null;
  if (billing.quote_id && (!quoteRow || quoteRow.status !== 'accepted' || quoteRow.tenant_id !== tenantId)) {
    throw new Error('Accepted individual quote is unavailable');
  }
  const quote = quoteRow ? musuboQuoteFromRecord(quoteRow) : null;
  const schedule = quote?.finalSchedule ?? condition.schedule;
  const nextCoreCharge = billing.status === 'trialing' ? billing.first_charge_date
    : billing.billing_interval === 'year' ? billing.next_annual_renewal_at : billing.next_monthly_charge_at;
  const nextOptionsCharge = billing.status === 'trialing' ? billing.first_charge_date
    : billing.next_monthly_charge_at;
  if (!nextCoreCharge || !nextOptionsCharge) throw new Error('Next charge dates are unavailable');
  const coreDate = nextCoreCharge.includes('T') ? jstDate(new Date(nextCoreCharge)) : nextCoreCharge;
  const optionsDate = nextOptionsCharge.includes('T') ? jstDate(new Date(nextOptionsCharge)) : nextOptionsCharge;
  const friends = usage.reduce((sum, row) => sum + row.friend_count_excluding_blocked!, 0);
  const capacity = quote?.plannedLineCount && quote.plannedLineCount > 10
    ? quote.plannedLineCount : usage.length;
  const allowance = friendAllowanceForLineCount(capacity, schedule);
  const blocks = Math.ceil(Math.max(0, friends - allowance) / schedule.extraFriendBlockSize);
  const slots = usage.reduce((sum, row) => sum + linkedAccountSlots({
    googleBusiness: row.google_business_count, instagram: row.instagram_count,
  }), 0);
  const optionsAmount = blocks * schedule.extraFriendBlockYen
    + (usage.length > 1 ? schedule.headquartersYen : 0) + slots * schedule.linkedAccountSlotYen;
  const coreAmount = quote && quote.plannedLineCount > 10
    ? (() => { const price = musuboIndividualQuotePrice(quote);
      return billing.billing_interval === 'year' ? price.finalAnnualLineChargeYen! : price.finalLineBasicMonthlyYen; })()
    : (() => { const price = musuboPrice({
      lineCount: usage.length, friendCountExcludingBlocked: friends,
      interval: billing.billing_interval, schedule,
      lineBasicDiscountPercent: quote ? 0 : lineBasicDiscountForDate(condition, coreDate),
      individualQuoteContext: Boolean(quote),
    });
      return billing.billing_interval === 'year' ? price.annualLineChargeYen : price.lineBasicMonthlyYen; })();
  if (!Number.isSafeInteger(coreAmount) || !Number.isSafeInteger(optionsAmount)) {
    throw new RangeError('Recurring price is out of range');
  }
  for (const [purpose, subscriptionId, productId, interval, amount, chargeDate] of [
    ['core', billing.core_subscription_id, env.STRIPE_PRODUCT_MUSUBO_CORE, billing.billing_interval, coreAmount, coreDate],
    ['options', billing.options_subscription_id, env.STRIPE_PRODUCT_MUSUBO_OPTIONS, 'month', optionsAmount, optionsDate],
  ] as const) {
    const subscription = await stripeApi.retrieveSubscription(env, subscriptionId);
    const current = currentPrice(subscription, { tenantId, customerId: legacy.stripe_customer_id,
      purpose, productId, interval });
    if (current.amountYen === amount) continue;
    const updated = await stripeApi.updateMusuboRecurringAmount(env, {
      subscriptionId, itemId: current.itemId, productId: productId!, interval,
      amountYen: amount,
      idempotencyKey: `musubo-reprice-${tenantId}-${purpose}-${chargeDate}-${amount}`,
    });
    if (currentPrice(updated, { tenantId, customerId: legacy.stripe_customer_id,
      purpose, productId, interval }).amountYen !== amount) {
      throw new Error('Stripe recurring price was not confirmed');
    }
  }
  return true;
}

export async function sweepMusuboRecurringPrices(env: WorkerBindings): Promise<{ attempted: number; failed: number }> {
  if (!env.STRIPE_PRODUCT_MUSUBO_CORE || !env.STRIPE_PRODUCT_MUSUBO_OPTIONS) {
    return { attempted: 0, failed: 0 };
  }
  const rows = await env.DB.prepare(`SELECT tenant_id FROM musubo_tenant_billing
    WHERE status IN ('trialing','active') AND core_subscription_id IS NOT NULL
      AND options_subscription_id IS NOT NULL ORDER BY updated_at LIMIT 10`)
    .all<{ tenant_id: string }>();
  let failed = 0;
  for (const row of rows.results ?? []) {
    try { await reconcileMusuboRecurringPrices(env, row.tenant_id); }
    catch { failed += 1; }
    // Rotate the bounded sweep even when one tenant has a persistent provider error.
    await env.DB.prepare(`UPDATE musubo_tenant_billing SET updated_at=? WHERE tenant_id=?`)
      .bind(new Date().toISOString(), row.tenant_id).run();
  }
  return { attempted: rows.results?.length ?? 0, failed };
}
