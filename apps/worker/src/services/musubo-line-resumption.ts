import { getLineAccountsByIds, getMusuboTenantBilling, getTenantBilling } from '@line-crm/db';
import { jstDate } from '@line-crm/shared';
import type { WorkerBindings } from '../worker-bindings.js';
import { fetchPreConnectFollowerInsight } from './musubo-large-line-consultation.js';
import { verifyLineMessagingIdentity } from './line-messaging-identity.js';
import { acceptedMusuboLineResumption,
  type MusuboLineResumptionOffer } from './musubo-line-resumption-review.js';
import { ensureMusuboResumptionSubscription } from './musubo-resumption-subscription.js';
import { stripeApi, type StripeSubscription } from './stripe-api.js';

interface EndedLine {
  line_account_id: string;
  google_business_count: number;
  instagram_count: number;
}

async function endedLine(env: WorkerBindings, tenantId: string): Promise<EndedLine> {
  const row = await env.DB.prepare(`SELECT line_account_id,google_business_count,instagram_count
    FROM musubo_line_usage WHERE tenant_id=? AND status='ended'
    ORDER BY ended_at DESC LIMIT 1`).bind(tenantId).first<EndedLine>();
  if (!row) throw new Error('The previous LINE is unavailable');
  return row;
}

function futureEpoch(value: string | undefined, now: Date): number | undefined {
  if (!value) return undefined;
  const epoch = Math.floor(Date.parse(value) / 1000);
  if (!Number.isSafeInteger(epoch)) throw new Error('Resumption charge date is invalid');
  return epoch > Math.floor(now.getTime() / 1000) ? epoch : undefined;
}

function periodEnd(subscription: StripeSubscription): string {
  const seconds = subscription.current_period_end ?? subscription.items?.data?.[0]?.current_period_end;
  if (!Number.isSafeInteger(seconds) || !seconds) throw new Error('Next billing date is unavailable');
  return jstDate(new Date(seconds * 1000));
}

/** Verify the stored LINE and reserve a durable intent before any Stripe mutation. */
export async function requestMusuboLineResumption(env: WorkerBindings, tenantId: string,
  now = new Date()): Promise<void> {
  const billing = await getMusuboTenantBilling(env.DB, tenantId);
  if (!billing || billing.status !== 'ended') throw new Error('The contract is not ended');
  if (billing.resumption_requested_at) {
    if (billing.resumption_line_account_id) return;
    throw new Error('Resumption is already in progress');
  }
  const { generation, review } = await acceptedMusuboLineResumption(env, tenantId, now);
  const legacy = await getTenantBilling(env.DB, tenantId);
  if (!legacy?.stripe_customer_id) throw new Error('Stripe customer is unavailable');
  const customer = await stripeApi.retrieveCustomer(env, legacy.stripe_customer_id);
  if (!customer.invoice_settings?.default_payment_method) throw new Error('A registered card is required');
  const line = await endedLine(env, tenantId);
  const [account] = await getLineAccountsByIds(env.DB, [line.line_account_id],
    env.LINE_CREDENTIAL_ENCRYPTION_KEY);
  if (!account || account.tenant_id !== tenantId || account.archived_at || account.is_active
    || !account.channel_access_token || !account.channel_secret) {
    throw new Error('The previous LINE connection must be updated');
  }
  if (!await verifyLineMessagingIdentity({ channelId: account.channel_id,
    channelSecret: account.channel_secret, channelAccessToken: account.channel_access_token })) {
    throw new Error('The previous LINE credentials could not be verified');
  }
  const insight = await fetchPreConnectFollowerInsight(account.channel_access_token, now);
  if (!insight || insight.followers > 500_000) {
    throw new Error('LINE statistics require a new review or individual consultation');
  }
  if (insight.friendsExcludingBlocked !== review.options.friendCount
    || insight.measuredOn !== review.options.measuredOn
    || line.google_business_count !== review.options.googleBusinessCount
    || line.instagram_count !== review.options.instagramCount) {
    throw new Error('Resumption price changed; review and consent again');
  }
  const requestedAt = now.toISOString();
  const result = await env.DB.prepare(`UPDATE musubo_tenant_billing
    SET resumption_requested_at=?,resumption_line_account_id=?,
      resumption_friend_count=?,resumption_friend_measured_on=?,updated_at=?
    WHERE tenant_id=? AND status='ended' AND resumption_generation=?
      AND resumption_requested_at IS NULL AND resumption_consented_at IS NOT NULL`)
    .bind(requestedAt, line.line_account_id, insight.friendsExcludingBlocked,
      insight.measuredOn, requestedAt, tenantId, generation).run();
  if ((result.meta?.changes ?? 0) !== 1) throw new Error('Resumption intent changed');
}

/** Reconcile both new-generation contracts; LINE access starts only after both are payable. */
export async function reconcileMusuboLineResumption(env: WorkerBindings, tenantId: string,
  now = new Date()): Promise<boolean> {
  const billing = await getMusuboTenantBilling(env.DB, tenantId);
  if (!billing?.resumption_requested_at || !billing.resumption_line_account_id
    || billing.resumption_friend_count === null || !billing.resumption_friend_measured_on
    || !billing.resumption_offer_json || !billing.resumption_consented_at) {
    throw new Error('Resumption intent is unavailable');
  }
  const generation = billing.resumption_generation;
  const review = JSON.parse(billing.resumption_offer_json) as MusuboLineResumptionOffer;
  if (review.kind === 'unpaid' || billing.resumption_friend_count !== review.options.friendCount
    || billing.resumption_friend_measured_on !== review.options.measuredOn) {
    throw new Error('Saved resumption offer is invalid');
  }
  const legacy = await getTenantBilling(env.DB, tenantId);
  if (!legacy?.stripe_customer_id || !env.STRIPE_PRODUCT_MUSUBO_CORE
    || !env.STRIPE_PRODUCT_MUSUBO_OPTIONS) throw new Error('Stripe billing is unavailable');
  const customer = await stripeApi.retrieveCustomer(env, legacy.stripe_customer_id);
  if (!customer.invoice_settings?.default_payment_method) throw new Error('A registered card is required');
  const line = await endedLine(env, tenantId);
  if (line.line_account_id !== billing.resumption_line_account_id) {
    throw new Error('The previous LINE changed');
  }
  if (line.google_business_count !== review.options.googleBusinessCount
    || line.instagram_count !== review.options.instagramCount) {
    throw new Error('Linked accounts changed after consent');
  }
  const optionsYen = review.options.optionsMonthlyYen;
  if (review.options.optionsDueNowYen !== (review.options.optionsChargeAt ? 0 : optionsYen)
    || review.options.totalDueNowYen !== review.options.optionsDueNowYen
      + (review.kind === 'paid_expired' ? review.dueOnConnectionYen : 0)) {
    throw new Error('Accepted resumption charge does not match the saved offer');
  }
  const coreYen = review.kind === 'annual_paid' ? review.nextAnnualLineBaseYen
    : review.nextLineBaseYen;
  const coreChargeAt = review.kind === 'trial_remaining' ? review.nextChargeAt
    : review.kind === 'monthly_paid' || review.kind === 'annual_paid' ? review.renewalAt : undefined;
  const optionsChargeAt = review.options.optionsChargeAt ?? undefined;
  const coreDeferred = futureEpoch(coreChargeAt, now);
  const optionsDeferred = futureEpoch(optionsChargeAt, now);
  const core = await ensureMusuboResumptionSubscription(env, {
    customerId: legacy.stripe_customer_id, tenantId, productId: env.STRIPE_PRODUCT_MUSUBO_CORE,
    purpose: 'core', interval: billing.billing_interval, unitAmountYen: coreYen, generation,
    chargeAtEpoch: coreDeferred,
  });
  const options = await ensureMusuboResumptionSubscription(env, {
    customerId: legacy.stripe_customer_id, tenantId, productId: env.STRIPE_PRODUCT_MUSUBO_OPTIONS,
    purpose: 'options', interval: 'month', unitAmountYen: optionsYen, generation,
    chargeAtEpoch: optionsDeferred,
  });
  const activatedAt = now.toISOString();
  const nextMonthly = optionsDeferred ? jstDate(new Date(optionsDeferred * 1000)) : periodEnd(options);
  const nextAnnual = billing.billing_interval === 'year'
    ? coreDeferred ? jstDate(new Date(coreDeferred * 1000)) : periodEnd(core) : null;
  const updates = await env.DB.batch([
    env.DB.prepare(`UPDATE musubo_tenant_billing SET status=?,core_subscription_id=?,
      options_subscription_id=?,next_monthly_charge_at=?,next_annual_renewal_at=?,
      resumed_at=?,resumption_consented_at=NULL,
      resumption_requested_at=NULL,resumption_line_account_id=NULL,
      resumption_friend_count=NULL,resumption_friend_measured_on=NULL,updated_at=?
      WHERE tenant_id=? AND status='ended'
      AND resumption_generation=? AND resumption_requested_at=?`)
      .bind(review.kind === 'trial_remaining' ? 'trialing' : 'active', core.id,
        options.id, nextMonthly, nextAnnual, activatedAt, activatedAt, tenantId,
        generation, billing.resumption_requested_at),
    env.DB.prepare(`UPDATE musubo_line_usage SET status='active',activated_at=?,
      friend_count_excluding_blocked=?,friend_count_measured_on=?,updated_at=?
      WHERE tenant_id=? AND line_account_id=? AND status='ended' AND changes()=1`)
      .bind(activatedAt, billing.resumption_friend_count,
        billing.resumption_friend_measured_on, activatedAt, tenantId, line.line_account_id),
    env.DB.prepare(`UPDATE line_accounts SET is_active=1,is_default=1,
      inactive_reason=NULL,inactive_reason_detail=NULL,inactivated_at=NULL,updated_at=?
      WHERE id=? AND tenant_id=? AND is_active=0 AND archived_at IS NULL AND changes()=1`)
      .bind(activatedAt, line.line_account_id, tenantId),
  ]);
  if (updates.some((result) => (result.meta?.changes ?? 0) !== 1)) {
    throw new Error('LINE resumption was not committed');
  }
  return true;
}

export async function sweepMusuboLineResumptions(env: WorkerBindings, now = new Date(), limit = 20): Promise<{
  processed: number; failed: number }> {
  const rows = await env.DB.prepare(`SELECT tenant_id FROM musubo_tenant_billing
    WHERE status='ended' AND resumption_requested_at IS NOT NULL
    ORDER BY resumption_requested_at LIMIT ?`).bind(limit).all<{ tenant_id: string }>();
  let processed = 0; let failed = 0;
  for (const row of rows.results ?? []) {
    try { await reconcileMusuboLineResumption(env, row.tenant_id, now); processed++; }
    catch { failed++; }
  }
  return { processed, failed };
}

export async function getMusuboLineResumptionComplete(env: WorkerBindings, tenantId: string) {
  const billing = await getMusuboTenantBilling(env.DB, tenantId);
  if (!billing?.resumed_at || !billing.resumption_offer_json
    || !['trialing', 'active'].includes(billing.status)) {
    throw new Error('Confirmed resumption is unavailable');
  }
  const offer = JSON.parse(billing.resumption_offer_json) as MusuboLineResumptionOffer;
  if (offer.kind === 'unpaid') throw new Error('Unpaid resumption cannot be complete');
  const restartedAt = billing.resumed_at;
  const verifiedCharge = async (subscriptionId: string | null, expectedYen: number): Promise<number> => {
    if (!expectedYen) return 0;
    const legacy = await getTenantBilling(env.DB, tenantId);
    if (!legacy?.stripe_customer_id || !subscriptionId) throw new Error('Resumption payment is unavailable');
    const subscription = await stripeApi.retrieveSubscription(env, subscriptionId);
    if (!subscription.latest_invoice || subscription.customer !== legacy.stripe_customer_id) {
      throw new Error('Resumption invoice is unavailable');
    }
    const invoice = await stripeApi.retrieveInvoice(env, subscription.latest_invoice);
    if (invoice.status !== 'paid' || invoice.customer !== legacy.stripe_customer_id
      || invoice.subscription !== subscription.id || invoice.amount_paid !== expectedYen) {
      throw new Error('Resumption payment is unconfirmed');
    }
    return invoice.amount_paid;
  };
  const chargedNowYen = await verifiedCharge(billing.core_subscription_id,
    offer.kind === 'paid_expired' ? offer.dueOnConnectionYen : 0)
    + await verifiedCharge(billing.options_subscription_id, offer.options.optionsDueNowYen);
  const optionsMonthlyYen = offer.options.optionsMonthlyYen;
  if (offer.kind === 'trial_remaining') return {
    kind: offer.kind, restartedAt, freeUntil: offer.freeUntil,
    nextChargeAt: offer.nextChargeAt, nextLineBaseYen: offer.nextLineBaseYen,
    interval: offer.interval, chargedNowYen, optionsMonthlyYen,
  };
  if (offer.kind === 'monthly_paid') return {
    kind: offer.kind, restartedAt, paidThrough: offer.paidThrough,
    renewalAt: offer.renewalAt, nextLineBaseYen: offer.nextLineBaseYen,
    chargedNowYen, optionsMonthlyYen,
  };
  if (offer.kind === 'annual_paid') return {
    kind: offer.kind, restartedAt, paidThrough: offer.paidThrough,
    renewalAt: offer.renewalAt, nextAnnualLineBaseYen: offer.nextAnnualLineBaseYen,
    chargedNowYen, optionsMonthlyYen,
  };
  const nextChargeDate = billing.billing_interval === 'year'
    ? billing.next_annual_renewal_at : billing.next_monthly_charge_at;
  if (!nextChargeDate) throw new Error('Next charge date is unavailable');
  return { kind: 'paid' as const, restartedAt, chargedNowYen,
    nextChargeAt: `${nextChargeDate}T00:00:00+09:00`,
    nextLineBaseYen: offer.nextLineBaseYen, interval: offer.interval, optionsMonthlyYen };
}
