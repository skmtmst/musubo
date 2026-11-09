import {
  getMusuboIndividualQuote, getMusuboTenantBilling, getTenantBilling, musuboQuoteFromRecord,
} from '@line-crm/db';
import type { AppliedMusuboCondition } from '@line-crm/shared';
import { friendAllowanceForLineCount } from '@line-crm/shared';
import type { WorkerBindings } from '../worker-bindings.js';
import { firstMusuboCoreTerms } from './musubo-contract-terms.js';
import { ensureMusuboSubscription } from './musubo-subscription-reconciliation.js';

/** Reconcile Stripe first, then claim its ID in D1. A failed D1 write can safely retry. */
export async function ensureMusuboCoreContract(env: WorkerBindings, tenantId: string): Promise<string> {
  const productId = env.STRIPE_PRODUCT_MUSUBO_CORE;
  if (!productId || !/^prod_[A-Za-z0-9]+$/.test(productId)) {
    throw new Error('Musubo core product is not configured');
  }
  const billing = await getMusuboTenantBilling(env.DB, tenantId);
  if (!billing?.first_line_activated_at || !billing.first_charge_date || billing.status === 'ended') {
    throw new Error('First LINE is not active');
  }
  if (billing.core_subscription_id) return billing.core_subscription_id;
  const legacy = await getTenantBilling(env.DB, tenantId);
  if (!legacy?.stripe_customer_id) throw new Error('Stripe customer is unavailable');
  let quote = null;
  if (billing.quote_id) {
    const row = await getMusuboIndividualQuote(env.DB, billing.quote_id);
    if (!row || row.tenant_id !== tenantId || row.status !== 'accepted') {
      throw new Error('Accepted quote is unavailable');
    }
    quote = musuboQuoteFromRecord(row);
  } else if (!billing.pricing_consented_at) {
    throw new Error('Pricing consent is unavailable');
  }
  const condition = JSON.parse(billing.pricing_snapshot_json) as AppliedMusuboCondition;
  const terms = firstMusuboCoreTerms({
    condition, quote, interval: billing.billing_interval,
    firstChargeDate: billing.first_charge_date,
  });
  const subscription = await ensureMusuboSubscription(env, {
    customerId: legacy.stripe_customer_id, tenantId, productId,
    purpose: 'core', interval: terms.interval, unitAmountYen: terms.amountYen,
    firstChargeDateJst: billing.first_charge_date,
    idempotencyKey: `musubo-core-${tenantId}`,
  });
  const claimed = await env.DB.prepare(`UPDATE musubo_tenant_billing
    SET core_subscription_id=?,updated_at=?
    WHERE tenant_id=? AND core_subscription_id IS NULL AND status IN ('trialing','active','past_due')`)
    .bind(subscription.id, new Date().toISOString(), tenantId).run();
  if ((claimed.meta?.changes ?? 0) === 1) return subscription.id;
  const current = await getMusuboTenantBilling(env.DB, tenantId);
  if (current?.core_subscription_id === subscription.id) return subscription.id;
  throw new Error('Core subscription claim conflicts with the current contract');
}

/** Keep monthly options independent from the annual or monthly LINE core. */
export async function ensureMusuboOptionsContract(env: WorkerBindings, tenantId: string): Promise<string> {
  const productId = env.STRIPE_PRODUCT_MUSUBO_OPTIONS;
  if (!productId || !/^prod_[A-Za-z0-9]+$/.test(productId)) {
    throw new Error('Musubo options product is not configured');
  }
  const billing = await getMusuboTenantBilling(env.DB, tenantId);
  if (!billing?.first_line_activated_at || !billing.first_charge_date || billing.status === 'ended') {
    throw new Error('First LINE is not active');
  }
  if (billing.options_subscription_id) return billing.options_subscription_id;
  if (!billing.core_subscription_id) throw new Error('Core contract must be ready first');
  const legacy = await getTenantBilling(env.DB, tenantId);
  if (!legacy?.stripe_customer_id) throw new Error('Stripe customer is unavailable');
  const active = await env.DB.prepare(`SELECT friend_count_excluding_blocked FROM musubo_line_usage
    WHERE tenant_id=? AND status IN ('active','ending') ORDER BY activated_at`)
    .bind(tenantId).all<{ friend_count_excluding_blocked: number | null }>();
  if (!active.results?.length || active.results.some((row) => row.friend_count_excluding_blocked === null)) {
    throw new Error('Verified LINE friend count is unavailable');
  }
  const condition = JSON.parse(billing.pricing_snapshot_json) as AppliedMusuboCondition;
  const quote = billing.quote_id ? await getMusuboIndividualQuote(env.DB, billing.quote_id) : null;
  if (billing.quote_id && (!quote || quote.status !== 'accepted' || quote.tenant_id !== tenantId)) {
    throw new Error('Accepted quote is unavailable');
  }
  const acceptedQuote = quote ? musuboQuoteFromRecord(quote) : null;
  const schedule = acceptedQuote?.finalSchedule ?? condition.schedule;
  const contractedCapacity = acceptedQuote?.plannedLineCount ?? active.results.length;
  const allowance = friendAllowanceForLineCount(
    contractedCapacity > 10 ? contractedCapacity : active.results.length, schedule);
  const friends = active.results.reduce((sum, row) => sum + row.friend_count_excluding_blocked!, 0);
  const friendBlocks = Math.ceil(Math.max(friends - allowance, 0) / schedule.extraFriendBlockSize);
  const optionsAmountYen = friendBlocks * schedule.extraFriendBlockYen
    + (active.results.length > 1 ? schedule.headquartersYen : 0);
  if (!Number.isSafeInteger(optionsAmountYen)) throw new RangeError('Musubo options amount exceeds the safe range');
  const subscription = await ensureMusuboSubscription(env, {
    customerId: legacy.stripe_customer_id, tenantId, productId,
    purpose: 'options', interval: 'month', unitAmountYen: optionsAmountYen,
    firstChargeDateJst: billing.first_charge_date,
    idempotencyKey: `musubo-options-${tenantId}`,
  });
  const claimed = await env.DB.prepare(`UPDATE musubo_tenant_billing
    SET options_subscription_id=?,updated_at=?
    WHERE tenant_id=? AND options_subscription_id IS NULL AND core_subscription_id IS NOT NULL
      AND status IN ('trialing','active','past_due')`)
    .bind(subscription.id, new Date().toISOString(), tenantId).run();
  if ((claimed.meta?.changes ?? 0) === 1) return subscription.id;
  const current = await getMusuboTenantBilling(env.DB, tenantId);
  if (current?.options_subscription_id === subscription.id) return subscription.id;
  throw new Error('Options subscription claim conflicts with the current contract');
}

/** Small bounded retry batch prevents a temporary Stripe outage from leaving free trials unbilled. */
export async function sweepMusuboContracts(env: WorkerBindings): Promise<{ attempted: number; failed: number }> {
  if (!env.STRIPE_PRODUCT_MUSUBO_CORE || !env.STRIPE_PRODUCT_MUSUBO_OPTIONS) {
    return { attempted: 0, failed: 0 };
  }
  const rows = await env.DB.prepare(`SELECT tenant_id FROM musubo_tenant_billing
    WHERE status IN ('trialing','active','past_due')
      AND (core_subscription_id IS NULL OR options_subscription_id IS NULL)
    AND first_line_activated_at IS NOT NULL ORDER BY first_line_activated_at LIMIT 20`)
    .all<{ tenant_id: string }>();
  let failed = 0;
  for (const row of rows.results ?? []) {
    try {
      await ensureMusuboCoreContract(env, row.tenant_id);
      await ensureMusuboOptionsContract(env, row.tenant_id);
    }
    catch { failed += 1; }
  }
  return { attempted: rows.results?.length ?? 0, failed };
}
