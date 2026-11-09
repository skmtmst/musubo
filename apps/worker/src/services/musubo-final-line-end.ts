import { finalLineEndOption } from '@line-crm/shared';
import { getMusuboTenantBilling, getTenantBilling,
  type MusuboTenantBillingRecord } from '@line-crm/db';
import type { WorkerBindings } from '../worker-bindings.js';
import { stripeApi, type StripeSubscription } from './stripe-api.js';
import { cancellationNoticeSnapshot, finalLineNoticeInsert } from './musubo-final-line-notice-record.js';

type EndState = 'choose' | 'scheduled' | 'ending' | 'ended';

interface LastLine {
  line_account_id: string;
  name: string;
}

function chargeInstant(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00+09:00`))) {
    throw new Error('The next billing date is unavailable');
  }
  return `${date}T00:00:00+09:00`;
}

function stateOf(billing: MusuboTenantBillingRecord, now: string): EndState {
  if (billing.status === 'ended') return 'ended';
  if (!billing.termination_requested_at) return 'choose';
  if (!billing.termination_effective_at) return 'ending';
  return billing.termination_effective_at > now && billing.termination_synced_at ? 'scheduled' : 'ending';
}

async function lastLine(env: WorkerBindings, tenantId: string): Promise<LastLine | null> {
  const rows = await env.DB.prepare(`SELECT u.line_account_id,a.name FROM musubo_line_usage u
    JOIN line_accounts a ON a.id=u.line_account_id
    WHERE u.tenant_id=? AND u.status IN ('active','ending')
    ORDER BY u.activated_at LIMIT 2`).bind(tenantId).all<LastLine>();
  if ((rows.results ?? []).length !== 1) return null;
  return rows.results![0];
}

function nextEnd(billing: MusuboTenantBillingRecord, now: string) {
  if (!['trialing', 'active', 'past_due'].includes(billing.status)) throw new Error('The billing state cannot be ended here');
  return finalLineEndOption({
    billingState: billing.status === 'trialing' ? 'trialing' : 'active', interval: billing.billing_interval,
    trialFirstChargeAt: billing.first_charge_date ? chargeInstant(billing.first_charge_date) : undefined,
    nextMonthlyChargeAt: billing.next_monthly_charge_at ? chargeInstant(billing.next_monthly_charge_at) : undefined,
    nextAnnualRenewalAt: billing.next_annual_renewal_at ? chargeInstant(billing.next_annual_renewal_at) : undefined,
  }, now);
}

export async function getMusuboFinalLineEnd(env: WorkerBindings, tenantId: string, now = new Date().toISOString()) {
  const billing = await getMusuboTenantBilling(env.DB, tenantId);
  if (!billing) throw new Error('musubo billing is unavailable');
  const line = await lastLine(env, tenantId);
  if (!line && billing.status !== 'ended') throw new Error('Exactly one active LINE is required');
  const endedLine = billing.status === 'ended' ? await env.DB.prepare(`SELECT a.name
    FROM musubo_line_usage u JOIN line_accounts a ON a.id=u.line_account_id
    WHERE u.tenant_id=? AND u.status='ended' ORDER BY u.ended_at DESC LIMIT 1`)
    .bind(tenantId).first<{ name: string }>() : null;
  let option: ReturnType<typeof nextEnd> | null = null;
  if (stateOf(billing, now) === 'choose') {
    try { option = nextEnd(billing, now); }
    catch { if (billing.status !== 'past_due') throw new Error('The next billing date is unavailable'); }
  }
  const unpaid = await env.DB.prepare(`SELECT COALESCE(SUM(amount_due-amount_paid),0) AS yen
    FROM billing_invoices WHERE tenant_id=? AND status IN ('open','uncollectible')
      AND amount_due>amount_paid`).bind(tenantId).first<{ yen: number }>();
  return {
    phase: stateOf(billing, now), lineAccountId: line?.line_account_id ?? null,
    lineName: line?.name ?? endedLine?.name ?? 'LINE公式アカウント',
    billingState: billing.status, interval: billing.billing_interval,
    firstChargeDate: billing.first_charge_date,
    nextMonthlyChargeDate: billing.next_monthly_charge_at,
    nextAnnualRenewalDate: billing.next_annual_renewal_at,
    defaultEndAt: option?.defaultEndAt ?? null,
    lastUsableDateJst: option?.lastUsableDateJst ?? null,
    scheduledEndAt: billing.termination_effective_at,
    unpaidInvoiceYen: unpaid?.yen ?? 0,
  };
}

function verifySubscription(subscription: StripeSubscription, input: {
  id: string; customerId: string; tenantId: string; purpose: 'core' | 'options';
}): void {
  if (subscription.id !== input.id || subscription.customer !== input.customerId
    || subscription.metadata?.tenant_id !== input.tenantId
    || subscription.metadata?.purpose !== `musubo_${input.purpose}`) {
    throw new Error('The Stripe subscription does not belong to this musubo contract');
  }
}

/** D1 stores the durable intent; Stripe updates can be retried after a timeout or partial success. */
export async function reconcileMusuboFinalLineEnd(env: WorkerBindings, tenantId: string,
  now = new Date().toISOString()): Promise<EndState> {
  const billing = await getMusuboTenantBilling(env.DB, tenantId);
  if (!billing) throw new Error('musubo billing is unavailable');
  if (billing.status === 'ended') return 'ended';
  if (!billing.termination_requested_at) return 'choose';
  const tenant = await getTenantBilling(env.DB, tenantId);
  if (!tenant?.stripe_customer_id) throw new Error('Stripe customer is unavailable');
  const effective = billing.termination_effective_at;
  const cancelRequested = effective === null;
  const due = effective !== null && effective <= now;
  let discovered: StripeSubscription[] = [];
  if (!billing.core_subscription_id || !billing.options_subscription_id) {
    const listed = await stripeApi.listCustomerSubscriptions(env, tenant.stripe_customer_id);
    if (listed.has_more) throw new Error('Stripe subscriptions require paginated reconciliation');
    discovered = listed.data.filter((subscription) => subscription.customer === tenant.stripe_customer_id
      && subscription.metadata?.tenant_id === tenantId);
  }
  const discover = (purpose: 'core' | 'options'): string | null => {
    const found = discovered.filter((subscription) => subscription.metadata?.purpose === `musubo_${purpose}`
      && subscription.status !== 'canceled');
    if (found.length > 1) throw new Error('Multiple active musubo subscriptions require manual reconciliation');
    return found[0]?.id ?? null;
  };
  const subscriptions = [
    { id: billing.core_subscription_id ?? discover('core'), purpose: 'core' as const },
    { id: billing.options_subscription_id ?? discover('options'), purpose: 'options' as const },
  ];
  for (const entry of subscriptions) {
    if (!entry.id) continue;
    const current = await stripeApi.retrieveSubscription(env, entry.id);
    verifySubscription(current, { ...entry, id: entry.id, customerId: tenant.stripe_customer_id, tenantId });
    if (cancelRequested) {
      if (current.status === 'canceled') throw new Error('A canceled subscription cannot be restored');
      if (current.cancel_at || current.cancel_at_period_end) {
        const changed = await stripeApi.undoMusuboTermination(env, entry.id,
          `musubo-end-undo-${tenantId}-${billing.termination_requested_at}-${entry.purpose}`);
        verifySubscription(changed, { ...entry, id: entry.id, customerId: tenant.stripe_customer_id, tenantId });
        if (changed.cancel_at || changed.cancel_at_period_end) throw new Error('Stripe termination remains scheduled');
      }
    } else if (due) {
      if (current.status !== 'canceled') {
        const changed = await stripeApi.cancelMusuboSubscription(env, entry.id,
          `musubo-end-now-${tenantId}-${billing.termination_requested_at}-${entry.purpose}`);
        verifySubscription(changed, { ...entry, id: entry.id, customerId: tenant.stripe_customer_id, tenantId });
        if (changed.status !== 'canceled') throw new Error('Stripe subscription remains active');
      }
    } else {
      const epoch = Math.floor(Date.parse(effective!) / 1000);
      if (current.status === 'canceled') throw new Error('Stripe subscription was canceled before the end date');
      if (current.cancel_at !== epoch) {
        const changed = await stripeApi.scheduleMusuboTermination(env, entry.id, epoch,
          `musubo-end-schedule-${tenantId}-${billing.termination_requested_at}-${entry.purpose}`);
        verifySubscription(changed, { ...entry, id: entry.id, customerId: tenant.stripe_customer_id, tenantId });
        if (changed.cancel_at !== epoch) throw new Error('Stripe did not schedule the termination');
      }
    }
  }
  // Compare the intent once more before changing LINE access. A newer customer action wins.
  const latest = await getMusuboTenantBilling(env.DB, tenantId);
  if (latest?.termination_requested_at !== billing.termination_requested_at
    || latest.termination_effective_at !== effective) return stateOf(latest!, now);
  if (cancelRequested) {
    const line = await lastLine(env, tenantId);
    if (!line) throw new Error('The final LINE is unavailable');
    const snapshot = await cancellationNoticeSnapshot(env.DB, billing, line.name, now);
    const results = await env.DB.batch([
      env.DB.prepare(`UPDATE musubo_tenant_billing SET termination_requested_at=NULL,
        termination_synced_at=NULL,updated_at=?
        WHERE tenant_id=? AND termination_requested_at=? AND termination_effective_at IS NULL`)
        .bind(now, tenantId, billing.termination_requested_at),
      env.DB.prepare(`UPDATE musubo_line_usage SET status='active',updated_at=?
        WHERE tenant_id=? AND status='ending' AND EXISTS (
          SELECT 1 FROM musubo_tenant_billing WHERE tenant_id=?
            AND termination_requested_at IS NULL AND termination_effective_at IS NULL)`)
        .bind(now, tenantId, tenantId),
      finalLineNoticeInsert(env.DB, { tenantId, event: 'cancelled',
        requestedAt: billing.termination_requested_at, createdAt: now, snapshot }),
    ]);
    if ((results[0]?.meta?.changes ?? 0) !== 1) throw new Error('Termination state changed');
    return 'choose';
  }
  if (!due) {
    const line = await lastLine(env, tenantId);
    if (!line) throw new Error('The final LINE is unavailable');
    const lastUsableAt = new Date(Date.parse(effective!) - 1).toISOString();
    const results = await env.DB.batch([
      env.DB.prepare(`UPDATE musubo_tenant_billing SET termination_synced_at=?,updated_at=?
        WHERE tenant_id=? AND termination_requested_at=? AND termination_effective_at=?`)
        .bind(now, now, tenantId, billing.termination_requested_at, effective),
      finalLineNoticeInsert(env.DB, { tenantId, event: 'scheduled',
        requestedAt: billing.termination_requested_at, createdAt: now,
        snapshot: { lineName: line.name, interval: billing.billing_interval,
          endAt: effective!, lastUsableAt } }),
    ]);
    if ((results[0]?.meta?.changes ?? 0) !== 1) throw new Error('Termination state changed');
    return 'scheduled';
  }
  const line = await lastLine(env, tenantId);
  if (!line) throw new Error('The final LINE is unavailable');
  const result = await env.DB.batch([
    env.DB.prepare(`UPDATE musubo_tenant_billing SET status='ended',ended_at=?,updated_at=?
      WHERE tenant_id=? AND termination_requested_at=? AND termination_effective_at=?
        AND status IN ('trialing','active','past_due')`)
      .bind(now, now, tenantId, billing.termination_requested_at, effective),
    env.DB.prepare(`UPDATE musubo_line_usage SET status='ended',ended_at=?,updated_at=?
      WHERE tenant_id=? AND line_account_id=? AND status IN ('active','ending')
        AND EXISTS (SELECT 1 FROM musubo_tenant_billing WHERE tenant_id=? AND status='ended')`)
      .bind(now, now, tenantId, line.line_account_id, tenantId),
    env.DB.prepare(`UPDATE line_accounts SET is_active=0,is_default=0,
      inactive_reason='manual',inactive_reason_detail='musuboの利用終了',inactivated_at=?,updated_at=?
      WHERE id=? AND tenant_id=? AND is_active=1
        AND EXISTS (SELECT 1 FROM musubo_tenant_billing WHERE tenant_id=? AND status='ended')`)
      .bind(now, now, line.line_account_id, tenantId, tenantId),
    finalLineNoticeInsert(env.DB, { tenantId, event: 'immediate',
      requestedAt: billing.termination_requested_at, createdAt: now,
      snapshot: { lineName: line.name, interval: billing.billing_interval, endAt: now } }),
  ]);
  if ((result[0]?.meta?.changes ?? 0) !== 1) throw new Error('Termination state changed');
  return 'ended';
}

/** The requested date is computed on the server; a client-supplied date is never trusted. */
export async function requestMusuboFinalLineEnd(env: WorkerBindings, tenantId: string,
  action: 'schedule' | 'now' | 'cancel', now = new Date().toISOString()): Promise<EndState> {
  const billing = await getMusuboTenantBilling(env.DB, tenantId);
  if (!billing) throw new Error('musubo billing is unavailable');
  if (!await lastLine(env, tenantId)) throw new Error('Exactly one active LINE is required');
  if (action !== 'cancel') {
    const pending = await env.DB.prepare(`SELECT id FROM musubo_pending_additions
      WHERE tenant_id=? AND status IN ('awaiting_payment','paid') LIMIT 1`)
      .bind(tenantId).first<{ id: string }>();
    if (pending) throw new Error('PENDING_ADDITION');
  }
  const current = stateOf(billing, now);
  if (action === 'cancel') {
    if (!billing.termination_effective_at || billing.termination_effective_at <= now
      || billing.status === 'ended') throw new Error('There is no cancellable termination');
    const result = await env.DB.prepare(`UPDATE musubo_tenant_billing SET termination_requested_at=?,
      termination_effective_at=NULL,termination_synced_at=NULL,updated_at=?
      WHERE tenant_id=? AND termination_requested_at=?
        AND termination_effective_at=? AND status IN ('trialing','active','past_due')`)
      .bind(now, now, tenantId, billing.termination_requested_at, billing.termination_effective_at).run();
    if ((result.meta?.changes ?? 0) !== 1) throw new Error('Termination state changed');
  } else {
    if (current !== 'choose') throw new Error('A termination is already requested');
    const effective = action === 'now' ? now : nextEnd(billing, now).defaultEndAt;
    const line = await lastLine(env, tenantId);
    if (!line) throw new Error('Exactly one active LINE is required');
    const result = await env.DB.batch([
      env.DB.prepare(`UPDATE musubo_tenant_billing
        SET termination_requested_at=?,termination_effective_at=?,termination_synced_at=NULL,updated_at=?
        WHERE tenant_id=? AND termination_requested_at IS NULL AND status IN ('trialing','active','past_due')`)
        .bind(now, effective, now, tenantId),
      env.DB.prepare(`UPDATE musubo_line_usage SET status='ending',updated_at=?
        WHERE tenant_id=? AND line_account_id=? AND status='active' AND changes()=1`)
        .bind(now, tenantId, line.line_account_id),
      ...(action === 'now' ? [env.DB.prepare(`UPDATE line_accounts SET is_active=0,is_default=0,
        inactive_reason='manual',inactive_reason_detail='musuboの利用終了',inactivated_at=?,updated_at=?
        WHERE id=? AND tenant_id=? AND is_active=1 AND changes()=1`)
        .bind(now, now, line.line_account_id, tenantId)] : []),
    ]);
    if ((result[0]?.meta?.changes ?? 0) !== 1 || (result[1]?.meta?.changes ?? 0) !== 1
      || (action === 'now' && (result[2]?.meta?.changes ?? 0) !== 1)) {
      throw new Error('Termination state changed');
    }
  }
  return reconcileMusuboFinalLineEnd(env, tenantId, now);
}

export async function sweepMusuboFinalLineEnds(env: WorkerBindings, now = new Date().toISOString(),
  limit = 20): Promise<{ processed: number; failed: number }> {
  const rows = await env.DB.prepare(`SELECT tenant_id FROM musubo_tenant_billing
    WHERE termination_requested_at IS NOT NULL AND status<>'ended'
      AND (termination_synced_at IS NULL OR termination_effective_at<=?)
    ORDER BY termination_requested_at LIMIT ?`).bind(now, limit).all<{ tenant_id: string }>();
  let processed = 0; let failed = 0;
  for (const row of rows.results ?? []) {
    try { await reconcileMusuboFinalLineEnd(env, row.tenant_id, now); processed++; }
    catch { failed++; }
  }
  return { processed, failed };
}
