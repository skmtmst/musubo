import { stripeApi, type StripeEnv, type StripeSubscription } from './stripe-api.js';

export interface ResumptionSubscriptionInput {
  customerId: string;
  tenantId: string;
  productId: string;
  purpose: 'core' | 'options';
  interval: 'month' | 'year';
  unitAmountYen: number;
  generation: number;
  chargeAtEpoch?: number;
}

function matches(subscription: StripeSubscription, input: ResumptionSubscriptionInput): boolean {
  const price = subscription.items?.data?.[0]?.price;
  return subscription.customer === input.customerId
    && subscription.metadata?.tenant_id === input.tenantId
    && subscription.metadata?.purpose === `musubo_${input.purpose}`
    && subscription.metadata?.resumption_generation === String(input.generation)
    && subscription.items?.data?.length === 1
    && price?.product === input.productId && price.unit_amount === input.unitAmountYen
    && price.currency === 'jpy' && price.tax_behavior === 'inclusive'
    && price.recurring?.interval === input.interval;
}

/** A generation is stable across retries even after Stripe's idempotency cache expires. */
export async function ensureMusuboResumptionSubscription(env: StripeEnv,
  input: ResumptionSubscriptionInput): Promise<StripeSubscription> {
  let cursor: string | undefined;
  let found: StripeSubscription | null = null;
  for (let pageIndex = 0; pageIndex < 6; pageIndex += 1) {
    const page = await stripeApi.listCustomerSubscriptions(env, input.customerId, cursor);
    for (const item of page.data) {
      if (item.metadata?.tenant_id !== input.tenantId
        || item.metadata?.purpose !== `musubo_${input.purpose}`
        || item.metadata?.resumption_generation !== String(input.generation)) continue;
      if (item.status === 'canceled' || item.status === 'incomplete_expired') {
        throw new Error('A previous resumption contract requires manual payment reconciliation');
      }
      if (found || !matches(item, input)) throw new Error('Resumption subscription conflicts with the accepted offer');
      found = item;
    }
    if (!page.has_more) break;
    cursor = page.data.at(-1)?.id;
    if (!cursor || pageIndex === 5) throw new Error('Stripe subscription search is incomplete');
  }
  const subscription = found ?? await stripeApi.createMusuboResumptionSubscription(env, {
    ...input,
    idempotencyKey: `musubo-resume-${input.tenantId}-${input.generation}-${input.purpose}`,
  });
  if (!matches(subscription, input) || !['active', 'trialing'].includes(subscription.status)) {
    throw new Error('Resumption subscription has not become payable');
  }
  if (input.chargeAtEpoch && subscription.trial_end !== input.chargeAtEpoch) {
    throw new Error('Prepaid coverage deadline did not match the new Stripe contract');
  }
  if (!input.chargeAtEpoch && input.unitAmountYen > 0) {
    if (!subscription.latest_invoice) throw new Error('Immediate resumption invoice is unavailable');
    const invoice = await stripeApi.retrieveInvoice(env, subscription.latest_invoice);
    if (invoice.status !== 'paid' || invoice.customer !== input.customerId
      || invoice.subscription !== subscription.id || invoice.currency !== 'jpy'
      || invoice.amount_paid < input.unitAmountYen) {
      throw new Error('Immediate resumption payment is not confirmed');
    }
  }
  return subscription;
}
