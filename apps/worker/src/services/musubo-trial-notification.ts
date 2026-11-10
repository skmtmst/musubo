import { getMusuboIndividualQuote, getMusuboTenantBilling, getTenantBilling,
  musuboQuoteFromRecord } from '@line-crm/db';
import { jstDate, lineBasicDiscountForDate, musuboChargeDateEpoch, musuboTrialDates,
  type AppliedMusuboCondition } from '@line-crm/shared';
import type { WorkerBindings } from '../worker-bindings.js';
import { billingRecipient } from './billing-invoice-notifications.js';
import { sendPlainMail } from './plain-mail.js';
import { sendRecordedNotification } from './recorded-notification-send.js';
import { stripeApi, type StripeSubscription } from './stripe-api.js';
import { musuboTrialMail } from './musubo-trial-mail.js';

function url(env: WorkerBindings, path: string): string | null {
  const origin = (env.ADMIN_PUBLIC_URL || env.ADMIN_ORIGIN?.split(',')[0] || '').trim();
  try {
    const result = new URL(origin);
    if (result.protocol !== 'https:') return null;
    result.pathname = path; result.search = ''; result.hash = '';
    return result.toString();
  } catch { return null; }
}

function price(subscription: StripeSubscription, input: {
  customerId: string; tenantId: string; purpose: 'core' | 'options';
  interval: 'month' | 'year'; firstChargeDate: string;
}): number {
  const item = subscription.items?.data?.[0];
  const amount = item?.price.unit_amount;
  if (subscription.status !== 'trialing' || subscription.customer !== input.customerId
    || subscription.metadata?.tenant_id !== input.tenantId
    || subscription.metadata?.purpose !== `musubo_${input.purpose}`
    || subscription.items?.data?.length !== 1 || item?.price.currency !== 'jpy'
    || item.price.tax_behavior !== 'inclusive' || item.price.recurring?.interval !== input.interval
    || subscription.trial_end !== musuboChargeDateEpoch(input.firstChargeDate)
    || typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 0) {
    throw new Error('Trial subscription does not match the approved billing terms');
  }
  return amount;
}

export async function deliverMusuboTrialNotice(env: WorkerBindings, tenantId: string,
  event: 'started' | 'ending', now = new Date()): Promise<boolean> {
  const billing = await getMusuboTenantBilling(env.DB, tenantId);
  if (!billing || billing.status !== 'trialing' || billing.termination_requested_at
    || !billing.first_line_activated_at || !billing.first_charge_date
    || !billing.core_subscription_id || !billing.options_subscription_id) return false;
  const today = jstDate(now);
  if (today >= billing.first_charge_date) return false;
  if (event === 'ending') {
    const sevenDaysAhead = jstDate(new Date(now.getTime() + 7 * 86_400_000));
    if (sevenDaysAhead < billing.first_charge_date) return false;
  }
  const sentColumn = event === 'started' ? 'trial_started_mail_sent_at' : 'trial_ending_mail_sent_at';
  const sent = await env.DB.prepare(`SELECT ${sentColumn} AS sent_at FROM musubo_tenant_billing
    WHERE tenant_id=?`).bind(tenantId).first<{ sent_at: string | null }>();
  if (sent?.sent_at) return true;
  const legacy = await getTenantBilling(env.DB, tenantId);
  const recipient = await billingRecipient(env.DB, tenantId);
  const accountUrl = url(env, '/accounts');
  const billingUrl = url(env, '/hq/billing');
  if (!legacy?.stripe_customer_id || !recipient || !accountUrl || !billingUrl) return false;
  const condition = JSON.parse(billing.pricing_snapshot_json) as AppliedMusuboCondition;
  const quoteRow = billing.quote_id ? await getMusuboIndividualQuote(env.DB, billing.quote_id) : null;
  if (billing.quote_id && (!quoteRow || quoteRow.tenant_id !== tenantId || quoteRow.status !== 'accepted')) {
    throw new Error('Accepted quote is unavailable');
  }
  const quote = quoteRow ? musuboQuoteFromRecord(quoteRow) : null;
  const trialPeriod = quote?.trialPeriod ?? condition.trialPeriod;
  const activatedDateJst = jstDate(new Date(billing.first_line_activated_at));
  if (musuboTrialDates(activatedDateJst, trialPeriod).firstChargeDate !== billing.first_charge_date) {
    throw new Error('Saved first charge date differs from the accepted trial period');
  }
  const subscriptions = await Promise.all([
    stripeApi.retrieveSubscription(env, billing.core_subscription_id),
    stripeApi.retrieveSubscription(env, billing.options_subscription_id),
  ]);
  const coreYen = price(subscriptions[0], { customerId: legacy.stripe_customer_id,
    tenantId, purpose: 'core', interval: billing.billing_interval,
    firstChargeDate: billing.first_charge_date });
  const optionsYen = price(subscriptions[1], { customerId: legacy.stripe_customer_id,
    tenantId, purpose: 'options', interval: 'month', firstChargeDate: billing.first_charge_date });
  const lineCount = await env.DB.prepare(`SELECT COUNT(*) AS value FROM musubo_line_usage
    WHERE tenant_id=? AND status IN ('active','ending')`).bind(tenantId).first<{ value: number }>();
  if (!lineCount?.value) return false;
  const mail = musuboTrialMail({ event, activatedDateJst, trialPeriod,
    activeLineCount: lineCount.value, estimatedFirstChargeYen: coreYen + optionsYen,
    billingInterval: billing.billing_interval, estimatedCoreYen: coreYen,
    estimatedOptionsMonthlyYen: optionsYen,
    lineBasicDiscountPercent: quote ? 0 : lineBasicDiscountForDate(condition, billing.first_charge_date),
    accountUrl, billingUrl });
  await sendRecordedNotification(env.DB, {
    sourceId: `musubo-trial:${tenantId}:${billing.first_line_activated_at}:${event}`,
    channel: 'email', recipient, payload: JSON.stringify(mail),
    send: () => sendPlainMail(env, { to: recipient, subject: mail.subject,
      body: mail.text, html: mail.html }),
  });
  await env.DB.prepare(`UPDATE musubo_tenant_billing SET ${sentColumn}=?
    WHERE tenant_id=? AND ${sentColumn} IS NULL`)
    .bind(new Date().toISOString(), tenantId).run();
  return true;
}

/** New trials only; unconfirmed or ended contracts never receive a payment promise. */
export async function sweepMusuboTrialNotices(env: WorkerBindings, now = new Date(), limit = 100): Promise<{
  checked: number; failed: number }> {
  const today = jstDate(now);
  const sevenDaysAhead = jstDate(new Date(now.getTime() + 7 * 86_400_000));
  const rows = await env.DB.prepare(`SELECT tenant_id,first_charge_date,
      trial_started_mail_sent_at,trial_ending_mail_sent_at
    FROM musubo_tenant_billing
    WHERE status='trialing' AND termination_requested_at IS NULL
      AND first_line_activated_at IS NOT NULL AND first_charge_date>?
      AND core_subscription_id IS NOT NULL AND options_subscription_id IS NOT NULL
      AND (trial_started_mail_sent_at IS NULL
        OR (first_charge_date<=? AND trial_ending_mail_sent_at IS NULL))
    ORDER BY first_line_activated_at LIMIT ?`).bind(today, sevenDaysAhead, limit)
    .all<{ tenant_id: string; first_charge_date: string;
      trial_started_mail_sent_at: string | null; trial_ending_mail_sent_at: string | null }>();
  let failed = 0;
  for (const row of rows.results ?? []) {
    try {
      if (!row.trial_started_mail_sent_at) await deliverMusuboTrialNotice(env, row.tenant_id, 'started', now);
      if (!row.trial_ending_mail_sent_at && row.first_charge_date <= sevenDaysAhead) {
        await deliverMusuboTrialNotice(env, row.tenant_id, 'ending', now);
      }
    } catch { failed++; }
  }
  return { checked: rows.results?.length ?? 0, failed };
}
