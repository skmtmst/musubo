import { musuboChargeDateEpoch } from '@line-crm/shared';
import { stripeApi, type MusuboSubscriptionInput, type StripeEnv, type StripeSubscription } from './stripe-api.js';

function matchesTerms(subscription: StripeSubscription, input: MusuboSubscriptionInput): boolean {
  const price = subscription.items?.data?.[0]?.price;
  return subscription.customer === input.customerId
    && subscription.metadata?.tenant_id === input.tenantId
    && subscription.metadata?.purpose === `musubo_${input.purpose}`
    && subscription.items?.data?.length === 1
    && price?.product === input.productId
    && price.unit_amount === input.unitAmountYen
    && price.currency === 'jpy'
    && price.recurring?.interval === input.interval
    && price.tax_behavior === 'inclusive'
    && subscription.trial_end === musuboChargeDateEpoch(input.firstChargeDateJst);
}

/** Stripeの冪等キーは永久保存ではないため、再試行前に顧客の全契約を照合する。 */
export async function findMusuboSubscription(
  env: StripeEnv,
  input: MusuboSubscriptionInput,
  fetchImpl?: typeof fetch,
): Promise<StripeSubscription | null> {
  let after: string | undefined;
  let found: StripeSubscription | null = null;
  const seenPages = new Set<string>();
  for (let pageIndex = 0; pageIndex < 6; pageIndex += 1) {
    const page = await stripeApi.listCustomerSubscriptions(env, input.customerId, after, fetchImpl);
    if (!Array.isArray(page.data) || typeof page.has_more !== 'boolean') {
      throw new Error('Stripe subscription list is incomplete');
    }
    for (const subscription of page.data) {
      if (subscription.customer !== input.customerId
        || subscription.metadata?.tenant_id !== input.tenantId
        || subscription.metadata?.purpose !== `musubo_${input.purpose}`
        || subscription.status === 'canceled' || subscription.status === 'incomplete_expired') continue;
      if (found || !matchesTerms(subscription, input)) {
        throw new Error('Stripe subscription does not match the accepted musubo terms');
      }
      found = subscription;
    }
    if (!page.has_more) return found;
    const last = page.data.at(-1)?.id;
    if (!last || last === after || seenPages.has(last)) throw new Error('Stripe subscription pagination did not advance');
    seenPages.add(last);
    after = last;
  }
  throw new Error('Stripe subscription list exceeds reconciliation limit');
}

/** Never create a second contract after an unknown first response without reading Stripe. */
export async function ensureMusuboSubscription(
  env: StripeEnv,
  input: MusuboSubscriptionInput,
  fetchImpl?: typeof fetch,
): Promise<StripeSubscription> {
  const existing = await findMusuboSubscription(env, input, fetchImpl);
  if (existing) return existing;
  const created = await stripeApi.createMusuboSubscription(env, input, fetchImpl);
  if (!matchesTerms(created, input)) {
    throw new Error('Created Stripe subscription could not be verified');
  }
  return created;
}
