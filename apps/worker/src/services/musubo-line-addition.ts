import {
  getLineAccountsByIds, getMusuboIndividualQuote, getMusuboTenantBilling, getTenantBilling, musuboQuoteFromRecord,
} from '@line-crm/db';
import {
  ADDITION_HOLD_DAYS, friendAllowanceForLineCount, jstDate, lineBasicDiscountForDate,
  linkedAccountSlots, musuboIndividualQuotePrice, musuboPrice, type AppliedMusuboCondition,
} from '@line-crm/shared';
import type { WorkerBindings } from '../worker-bindings.js';
import { musuboLineAdditionPrice } from './musubo-line-addition-price.js';
import { StripeApiError, stripeApi, type StripeInvoice, type StripeSubscription } from './stripe-api.js';
import { fetchPreConnectFollowerInsight } from './musubo-large-line-consultation.js';

export interface MusuboPendingLineAddition {
  id: string;
  tenant_id: string;
  kind: 'line';
  line_account_id: string | null;
  status: 'awaiting_payment' | 'paid' | 'activated' | 'expired' | 'cancelled';
  amount_due_yen: number;
  price_snapshot_json: string;
  stripe_invoice_id: string | null;
  expires_at: string;
  paid_at: string | null;
  activated_at: string | null;
  created_at: string;
  updated_at: string;
}

function period(subscription: StripeSubscription): { start: string; end: string } {
  const item = subscription.items?.data?.[0];
  const start = subscription.current_period_start ?? item?.current_period_start;
  const end = subscription.current_period_end ?? item?.current_period_end;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || !start || !end || start >= end) {
    throw new Error('Stripe billing period is unavailable');
  }
  return { start: jstDate(new Date(start * 1000)), end: jstDate(new Date(end * 1000)) };
}

function assertContract(subscription: StripeSubscription, tenantId: string, customerId: string, purpose: string): void {
  if (subscription.customer !== customerId || subscription.metadata?.tenant_id !== tenantId
    || subscription.metadata?.purpose !== purpose || !['trialing', 'active'].includes(subscription.status)) {
    throw new Error('The current Stripe contract could not be verified');
  }
}

/** The server and Stripe dates, never a client price, determine the incremental charge. */
export async function quoteMusuboLineAddition(env: WorkerBindings, tenantId: string, now = new Date()) {
  const billing = await getMusuboTenantBilling(env.DB, tenantId);
  if (!billing || !['trialing', 'active'].includes(billing.status)
    || !billing.core_subscription_id || !billing.options_subscription_id) {
    throw new Error('The musubo contract is not ready for an addition');
  }
  const legacy = await getTenantBilling(env.DB, tenantId);
  if (!legacy?.stripe_customer_id) throw new Error('Stripe customer is unavailable');
  const rows = await env.DB.prepare(`SELECT line_account_id FROM musubo_line_usage
    WHERE tenant_id=? AND status IN ('active','ending') ORDER BY activated_at`)
    .bind(tenantId).all<{ line_account_id: string }>();
  const activeLineCount = rows.results?.length ?? 0;
  if (activeLineCount < 1) throw new Error('At least one LINE must be active');
  const [core, options] = await Promise.all([
    stripeApi.retrieveSubscription(env, billing.core_subscription_id),
    stripeApi.retrieveSubscription(env, billing.options_subscription_id),
  ]);
  assertContract(core, tenantId, legacy.stripe_customer_id, 'musubo_core');
  assertContract(options, tenantId, legacy.stripe_customer_id, 'musubo_options');
  const condition = JSON.parse(billing.pricing_snapshot_json) as AppliedMusuboCondition;
  const quoteRow = billing.quote_id ? await getMusuboIndividualQuote(env.DB, billing.quote_id) : null;
  if (billing.quote_id && (!quoteRow || quoteRow.tenant_id !== tenantId || quoteRow.status !== 'accepted')) {
    throw new Error('Accepted quote is unavailable');
  }
  const quote = quoteRow ? musuboQuoteFromRecord(quoteRow) : null;
  const today = jstDate(now);
  const trialing = billing.status === 'trialing';
  const monthlyPeriod = trialing
    ? { start: today, end: billing.first_charge_date ?? '' }
    : period(options);
  const annualPeriod = billing.billing_interval === 'year' && !trialing ? period(core) : null;
  const price = musuboLineAdditionPrice({
    condition, quote, interval: billing.billing_interval, activeLineCount,
    activationDateJst: today, monthlyPeriodStartJst: monthlyPeriod.start,
    nextMonthlyChargeDateJst: monthlyPeriod.end,
    annualPeriodStartJst: annualPeriod?.start, nextAnnualRenewalDateJst: annualPeriod?.end,
    trialing, firstChargeDateJst: billing.first_charge_date ?? undefined,
  });
  const currentCoreYen = core.items?.data?.[0]?.price.unit_amount;
  const currentOptionsYen = options.items?.data?.[0]?.price.unit_amount;
  if (typeof currentCoreYen !== 'number' || typeof currentOptionsYen !== 'number'
    || !Number.isSafeInteger(currentCoreYen) || !Number.isSafeInteger(currentOptionsYen)) {
    throw new Error('Current Stripe prices are unavailable');
  }
  const schedule = quote?.finalSchedule ?? condition.schedule;
  const expectedCoreYen = quote && quote.plannedLineCount > 10
    ? (() => { const agreed = musuboIndividualQuotePrice(quote);
      return billing.billing_interval === 'year' ? agreed.finalAnnualLineChargeYen! : agreed.finalLineBasicMonthlyYen; })()
    : (() => { const agreed = musuboPrice({
      lineCount: activeLineCount, friendCountExcludingBlocked: 0,
      interval: billing.billing_interval, schedule,
      lineBasicDiscountPercent: quote ? 0 : lineBasicDiscountForDate(condition,
        trialing ? billing.first_charge_date! : today),
      individualQuoteContext: Boolean(quote),
    });
      return billing.billing_interval === 'year' ? agreed.annualLineChargeYen : agreed.lineBasicMonthlyYen; })();
  if (currentCoreYen !== expectedCoreYen) {
    throw new Error('The current Stripe basic price must be reconciled before adding a LINE');
  }
  return { price, activeLineCount, customerId: legacy.stripe_customer_id, billing,
    monthlyPeriod, annualPeriod, quotedAt: now.toISOString(),
    recurringAfter: {
      coreYen: currentCoreYen + price.coreIncrementYen,
      coreInterval: billing.billing_interval,
      optionsYen: currentOptionsYen + price.headquartersIncrementMonthlyYen,
    } };
}

export async function getPendingMusuboLineAddition(db: D1Database, tenantId: string): Promise<MusuboPendingLineAddition | null> {
  return db.prepare(`SELECT * FROM musubo_pending_additions
    WHERE tenant_id=? AND kind='line' AND status IN ('awaiting_payment','paid')
    ORDER BY created_at DESC LIMIT 1`).bind(tenantId).first<MusuboPendingLineAddition>();
}

async function findInvoice(env: WorkerBindings, customerId: string, tenantId: string, additionId: string): Promise<StripeInvoice | null> {
  let after: string | undefined;
  for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
    const page = await stripeApi.listInvoices(env, customerId, { limit: 100, startingAfter: after });
    const matches = page.data.filter((invoice) => invoice.metadata?.tenant_id === tenantId
      && invoice.metadata?.purpose === 'musubo_addition' && invoice.metadata.addition_id === additionId);
    if (matches.length > 1) throw new Error('Multiple Stripe invoices belong to one addition');
    if (matches.length === 1) return matches[0]!;
    if (!page.has_more) return null;
    after = page.data.at(-1)?.id;
    if (!after) break;
  }
  throw new Error('Stripe invoice list is incomplete');
}

function verifiedInvoice(invoice: StripeInvoice, addition: MusuboPendingLineAddition, customerId: string): void {
  if (invoice.customer !== customerId || invoice.metadata?.tenant_id !== addition.tenant_id
    || invoice.metadata?.purpose !== 'musubo_addition' || invoice.metadata.addition_id !== addition.id
    || invoice.currency !== 'jpy') throw new Error('Addition invoice does not match the approved request');
}

/** Repeated calls reconcile Stripe before any create/pay operation. No second charge on retry. */
export async function collectMusuboLineAddition(env: WorkerBindings, addition: MusuboPendingLineAddition,
  customerId: string): Promise<MusuboPendingLineAddition> {
  const now = new Date().toISOString();
  if (addition.status !== 'awaiting_payment' || addition.amount_due_yen === 0) return addition;
  if (addition.expires_at <= now) throw new Error('The addition hold has expired');
  let invoice = addition.stripe_invoice_id
    ? await stripeApi.retrieveInvoice(env, addition.stripe_invoice_id)
    : await findInvoice(env, customerId, addition.tenant_id, addition.id);
  if (!invoice) invoice = await stripeApi.createMusuboAdditionInvoice(env, {
    customerId, tenantId: addition.tenant_id, additionId: addition.id,
  });
  verifiedInvoice(invoice, addition, customerId);
  if (!addition.stripe_invoice_id) {
    await env.DB.prepare(`UPDATE musubo_pending_additions SET stripe_invoice_id=?,updated_at=?
      WHERE id=? AND stripe_invoice_id IS NULL AND status='awaiting_payment'`)
      .bind(invoice.id, now, addition.id).run();
  } else if (addition.stripe_invoice_id !== invoice.id) {
    throw new Error('The addition is associated with a different Stripe invoice');
  }
  if (invoice.status === 'draft') {
    const lines = await stripeApi.listInvoiceLines(env, invoice.id);
    if (lines.has_more || lines.data.length > 1) throw new Error('Addition invoice contains unexpected lines');
    if (lines.data.length === 0) {
      await stripeApi.createMusuboAdditionInvoiceItem(env, {
        customerId, invoiceId: invoice.id, additionId: addition.id,
        amountYen: addition.amount_due_yen, description: 'musubo LINE追加分（日割り・税込）',
      });
    } else if (lines.data[0]?.amount !== addition.amount_due_yen
      || lines.data[0]?.metadata?.addition_id !== addition.id) {
      throw new Error('Addition invoice line does not match the approved price');
    }
    invoice = await stripeApi.finalizeMusuboAdditionInvoice(env, invoice.id, addition.id);
  }
  if (invoice.amount_due !== addition.amount_due_yen) {
    throw new Error('Finalized addition invoice differs from the confirmed price');
  }
  if (invoice.status === 'open') {
    try { invoice = await stripeApi.payMusuboAdditionInvoice(env, invoice.id, addition.id); }
    catch (error) {
      if (!(error instanceof StripeApiError) || error.resultUnknown) throw error;
      invoice = await stripeApi.retrieveInvoice(env, invoice.id);
    }
  }
  if (invoice.status === 'paid' && invoice.amount_paid >= addition.amount_due_yen) {
    await env.DB.prepare(`UPDATE musubo_pending_additions SET status='paid',paid_at=?,updated_at=?
      WHERE id=? AND status='awaiting_payment' AND stripe_invoice_id=? AND expires_at>?`)
      .bind(now, now, addition.id, invoice.id, now).run();
  }
  const current = await getPendingMusuboLineAddition(env.DB, addition.tenant_id);
  if (!current || current.id !== addition.id) throw new Error('Addition state changed during payment');
  return current;
}

export async function reserveMusuboLineAddition(env: WorkerBindings, tenantId: string,
  confirmedAmountYen: number, confirmedActiveLineCount: number): Promise<MusuboPendingLineAddition> {
  if (!Number.isSafeInteger(confirmedAmountYen) || confirmedAmountYen < 0
    || !Number.isSafeInteger(confirmedActiveLineCount) || confirmedActiveLineCount < 1) {
    throw new RangeError('The confirmed addition price is invalid');
  }
  const existing = await getPendingMusuboLineAddition(env.DB, tenantId);
  const now = new Date();
  const expiredFreeReservation = Boolean(existing?.status === 'paid' && existing.amount_due_yen === 0
    && existing.line_account_id === null && existing.expires_at <= now.toISOString());
  if (existing && !expiredFreeReservation
    && (existing.status === 'paid' || existing.expires_at > now.toISOString())) {
    const snapshot = JSON.parse(existing.price_snapshot_json) as { activeLineCount: number };
    if (existing.amount_due_yen !== confirmedAmountYen
      || snapshot.activeLineCount !== confirmedActiveLineCount) {
      throw new Error('The confirmed addition price has changed');
    }
    return existing;
  }
  let connectedLineId: string | null = null;
  if (existing) {
    if (expiredFreeReservation) {
      const retired = await env.DB.prepare(`UPDATE musubo_pending_additions SET status='expired',updated_at=?
        WHERE id=? AND status='paid' AND amount_due_yen=0 AND line_account_id IS NULL AND expires_at<=?`)
        .bind(now.toISOString(), existing.id, now.toISOString()).run();
      if ((retired.meta?.changes ?? 0) !== 1) throw new Error('The free reservation changed during renewal');
    } else {
    const legacy = await getTenantBilling(env.DB, tenantId);
    if (!legacy?.stripe_customer_id) throw new Error('Stripe customer is unavailable');
    let invoice = existing.stripe_invoice_id
      ? await stripeApi.retrieveInvoice(env, existing.stripe_invoice_id)
      : await findInvoice(env, legacy.stripe_customer_id, tenantId, existing.id);
    if (invoice) {
      verifiedInvoice(invoice, existing, legacy.stripe_customer_id);
      if (invoice.status === 'paid' && invoice.amount_paid >= existing.amount_due_yen) {
        await env.DB.prepare(`UPDATE musubo_pending_additions SET status='paid',stripe_invoice_id=?,paid_at=?,updated_at=?
          WHERE id=? AND status='awaiting_payment'`).bind(invoice.id, now.toISOString(), now.toISOString(), existing.id).run();
        throw new Error('The prior addition was paid and must be reconciled first');
      }
      if (invoice.status === 'open') invoice = await stripeApi.voidInvoice(env, invoice.id, existing.id);
      if (!invoice.status || !['void', 'draft', 'uncollectible'].includes(invoice.status)) {
        throw new Error('The prior addition invoice is still payable');
      }
    }
    const retired = await env.DB.prepare(`UPDATE musubo_pending_additions SET status='expired',updated_at=?
      WHERE id=? AND status='awaiting_payment' AND expires_at<=?`)
      .bind(now.toISOString(), existing.id, now.toISOString()).run();
    if ((retired.meta?.changes ?? 0) !== 1) throw new Error('The prior addition changed during renewal');
    connectedLineId = existing.line_account_id;
    }
  }
  const quote = await quoteMusuboLineAddition(env, tenantId, now);
  if (quote.price.dueNowYen !== confirmedAmountYen || quote.activeLineCount !== confirmedActiveLineCount) {
    throw new Error('The confirmed addition price has changed');
  }
  const id = crypto.randomUUID();
  const expiresAt = new Date(now.getTime() + ADDITION_HOLD_DAYS * 86_400_000).toISOString();
  const amount = quote.price.dueNowYen;
  await env.DB.prepare(`INSERT INTO musubo_pending_additions
    (id,tenant_id,kind,line_account_id,status,amount_due_yen,price_snapshot_json,expires_at,paid_at,created_at,updated_at)
    VALUES (?,?,'line',?,?,?,?,?,?,?,?)`)
    .bind(id, tenantId, connectedLineId, amount === 0 ? 'paid' : 'awaiting_payment', amount,
      JSON.stringify({ price: quote.price, activeLineCount: quote.activeLineCount,
        monthlyPeriod: quote.monthlyPeriod, annualPeriod: quote.annualPeriod,
        quotedAt: quote.quotedAt, recurringAfter: quote.recurringAfter }),
      expiresAt, amount === 0 ? now.toISOString() : null,
      now.toISOString(), now.toISOString()).run();
  const pending = await getPendingMusuboLineAddition(env.DB, tenantId);
  if (!pending || pending.id !== id) throw new Error('Addition reservation could not be confirmed');
  return pending;
}

interface UsageRow {
  line_account_id: string;
  friend_count_excluding_blocked: number | null;
  google_business_count: number;
  instagram_count: number;
  billed_linked_slots: number;
}

/** A confirmed reservation can be connected once. The LINE stays inactive until payment and recurring prices match. */
export async function connectReservedMusuboLine(env: WorkerBindings, input: {
  tenantId: string; lineAccountId: string; friendsExcludingBlocked: number; measuredOn: string;
}): Promise<'active' | 'pending_payment' | 'pending_reconciliation'> {
  if (!Number.isSafeInteger(input.friendsExcludingBlocked) || input.friendsExcludingBlocked < 0
    || !/^\d{4}-\d{2}-\d{2}$/.test(input.measuredOn)) throw new RangeError('LINE insight is unavailable');
  const pending = await getPendingMusuboLineAddition(env.DB, input.tenantId);
  if (!pending || !['awaiting_payment', 'paid'].includes(pending.status)
    || pending.line_account_id && pending.line_account_id !== input.lineAccountId
    || (pending.status === 'awaiting_payment' || pending.amount_due_yen === 0)
      && pending.expires_at <= new Date().toISOString()) {
    throw new Error('A confirmed LINE addition is unavailable');
  }
  const now = new Date().toISOString();
  if (!pending.line_account_id) {
    const result = await env.DB.batch([
      env.DB.prepare(`UPDATE musubo_pending_additions SET line_account_id=?,updated_at=?
        WHERE id=? AND tenant_id=? AND status IN ('awaiting_payment','paid') AND line_account_id IS NULL`)
        .bind(input.lineAccountId, now, pending.id, input.tenantId),
      env.DB.prepare(`INSERT INTO musubo_line_usage
        (line_account_id,tenant_id,status,friend_count_excluding_blocked,friend_count_measured_on,updated_at)
        SELECT ?,?,'pending',?,?,? WHERE changes()=1`)
        .bind(input.lineAccountId, input.tenantId, input.friendsExcludingBlocked, input.measuredOn, now),
    ]);
    if ((result[0]?.meta?.changes ?? 0) !== 1 || (result[1]?.meta?.changes ?? 0) !== 1) {
      throw new Error('The paid addition has already been claimed');
    }
  }
  if (pending.status === 'awaiting_payment') {
    const legacy = await getTenantBilling(env.DB, input.tenantId);
    if (!legacy?.stripe_customer_id) throw new Error('Stripe customer is unavailable');
    try {
      const refreshed = await getPendingMusuboLineAddition(env.DB, input.tenantId);
      if (!refreshed || refreshed.id !== pending.id) throw new Error('Addition state changed');
      const collected = await collectMusuboLineAddition(env, refreshed, legacy.stripe_customer_id);
      if (collected.status !== 'paid') return 'pending_payment';
    } catch { return 'pending_payment'; }
  }
  try { await reconcilePaidMusuboLine(env, pending.id, input.tenantId); }
  catch { return 'pending_reconciliation'; }
  return 'active';
}

/** May be retried by the scheduled worker after a Stripe timeout or partial D1 write. */
export async function reconcilePaidMusuboLine(env: WorkerBindings, additionId: string, tenantId: string): Promise<boolean> {
  const pending = await env.DB.prepare(`SELECT * FROM musubo_pending_additions
    WHERE id=? AND tenant_id=? AND kind='line'`).bind(additionId, tenantId).first<MusuboPendingLineAddition>();
  if (!pending || pending.status === 'activated') return Boolean(pending);
  if (pending.status !== 'paid' || !pending.line_account_id) return false;
  const billing = await getMusuboTenantBilling(env.DB, tenantId);
  const legacy = await getTenantBilling(env.DB, tenantId);
  if (!billing || !legacy?.stripe_customer_id || !billing.core_subscription_id
    || !billing.options_subscription_id || !['trialing', 'active'].includes(billing.status)) {
    throw new Error('The musubo contract cannot activate the paid LINE');
  }
  const active = await env.DB.prepare(`SELECT line_account_id,friend_count_excluding_blocked,
    google_business_count,instagram_count,billed_linked_slots FROM musubo_line_usage
    WHERE tenant_id=? AND status IN ('active','ending') ORDER BY activated_at`)
    .bind(tenantId).all<UsageRow>();
  const pendingUsage = await env.DB.prepare(`SELECT line_account_id,friend_count_excluding_blocked,
    google_business_count,instagram_count,billed_linked_slots FROM musubo_line_usage
    WHERE tenant_id=? AND line_account_id=? AND status='pending'`)
    .bind(tenantId, pending.line_account_id).first<UsageRow>();
  if (!pendingUsage || pendingUsage.friend_count_excluding_blocked === null
    || !active.results?.length || active.results.some((line) => line.friend_count_excluding_blocked === null)) {
    throw new Error('Verified LINE usage is unavailable');
  }
  const snapshot = JSON.parse(pending.price_snapshot_json) as { activeLineCount: number };
  if (snapshot.activeLineCount !== active.results.length) {
    throw new Error('The active LINE count changed while the addition was pending');
  }
  const condition = JSON.parse(billing.pricing_snapshot_json) as AppliedMusuboCondition;
  const quoteRow = billing.quote_id ? await getMusuboIndividualQuote(env.DB, billing.quote_id) : null;
  if (billing.quote_id && (!quoteRow || quoteRow.status !== 'accepted' || quoteRow.tenant_id !== tenantId)) {
    throw new Error('Accepted quote is unavailable');
  }
  const quote = quoteRow ? musuboQuoteFromRecord(quoteRow) : null;
  const schedule = quote?.finalSchedule ?? condition.schedule;
  const count = active.results.length + 1;
  const friends = [...active.results, pendingUsage].reduce((sum, line) =>
    sum + line.friend_count_excluding_blocked!, 0);
  const allowance = friendAllowanceForLineCount(quote?.plannedLineCount && quote.plannedLineCount > 10
    ? quote.plannedLineCount : count, schedule);
  const friendBlocks = Math.ceil(Math.max(0, friends - allowance) / schedule.extraFriendBlockSize);
  const linkedSlots = [...active.results, pendingUsage].reduce((sum, line) =>
    sum + Math.max(line.billed_linked_slots,
      linkedAccountSlots({ googleBusiness: line.google_business_count, instagram: line.instagram_count })), 0);
  const optionsAmountYen = friendBlocks * schedule.extraFriendBlockYen
    + (count > 1 ? schedule.headquartersYen : 0) + linkedSlots * schedule.linkedAccountSlotYen;
  const coreAmountYen = quote && quote.plannedLineCount > 10
    ? (() => { const price = musuboIndividualQuotePrice(quote);
      return billing.billing_interval === 'year' ? price.finalAnnualLineChargeYen! : price.finalLineBasicMonthlyYen; })()
    : (() => { const price = musuboPrice({
      lineCount: count, friendCountExcludingBlocked: friends,
      interval: billing.billing_interval, schedule,
      lineBasicDiscountPercent: quote ? 0 : lineBasicDiscountForDate(condition,
        billing.status === 'trialing' ? billing.first_charge_date! : jstDate(new Date())),
      individualQuoteContext: Boolean(quote),
    });
      return billing.billing_interval === 'year' ? price.annualLineChargeYen : price.lineBasicMonthlyYen; })();
  if (!Number.isSafeInteger(optionsAmountYen) || !Number.isSafeInteger(coreAmountYen)) {
    throw new RangeError('Recurring price is out of range');
  }
  const [core, options] = await Promise.all([
    stripeApi.retrieveSubscription(env, billing.core_subscription_id),
    stripeApi.retrieveSubscription(env, billing.options_subscription_id),
  ]);
  assertContract(core, tenantId, legacy.stripe_customer_id, 'musubo_core');
  assertContract(options, tenantId, legacy.stripe_customer_id, 'musubo_options');
  const reconcile = async (subscription: StripeSubscription, amountYen: number,
    productId: string | undefined, interval: 'month' | 'year', purpose: string) => {
    const item = subscription.items.data[0];
    if (!item?.id || !productId) throw new Error('Stripe subscription item is unavailable');
    if (subscription.items.data.length !== 1) throw new Error('Stripe subscription has unexpected items');
    if (item.price.unit_amount === amountYen && item.price.product === productId
      && item.price.recurring?.interval === interval) return;
    const updated = await stripeApi.updateMusuboRecurringAmount(env, {
      subscriptionId: subscription.id, itemId: item.id, productId, interval,
      amountYen, idempotencyKey: `musubo-addition-${additionId}-${purpose}`,
    });
    if (updated.items.data[0]?.price.unit_amount !== amountYen || updated.customer !== legacy.stripe_customer_id) {
      throw new Error('Updated Stripe subscription did not match the approved price');
    }
  };
  await reconcile(core, coreAmountYen, env.STRIPE_PRODUCT_MUSUBO_CORE,
    billing.billing_interval, 'core');
  await reconcile(options, optionsAmountYen, env.STRIPE_PRODUCT_MUSUBO_OPTIONS, 'month', 'options');
  const activatedAt = new Date().toISOString();
  const updates = await env.DB.batch([
    env.DB.prepare(`UPDATE musubo_pending_additions SET status='activated',activated_at=?,updated_at=?
      WHERE id=? AND tenant_id=? AND line_account_id=? AND status='paid'`)
      .bind(activatedAt, activatedAt, additionId, tenantId, pending.line_account_id),
    env.DB.prepare(`UPDATE musubo_line_usage SET status='active',activated_at=?,updated_at=?
      WHERE line_account_id=? AND tenant_id=? AND status='pending' AND changes()=1`)
      .bind(activatedAt, activatedAt, pending.line_account_id, tenantId),
    env.DB.prepare(`UPDATE line_accounts SET is_active=1,updated_at=?
      WHERE id=? AND tenant_id=? AND is_active=0 AND changes()=1`)
      .bind(activatedAt, pending.line_account_id, tenantId),
  ]);
  if (updates.some((result) => (result.meta?.changes ?? 0) !== 1)) {
    throw new Error('Paid LINE activation was not committed');
  }
  return true;
}

export async function sweepMusuboLineAdditions(env: WorkerBindings): Promise<{ attempted: number; failed: number }> {
  const now = new Date().toISOString();
  const rows = await env.DB.prepare(`SELECT * FROM musubo_pending_additions
    WHERE kind='line' AND ((status='awaiting_payment' AND expires_at<=?)
      OR (status IN ('awaiting_payment','paid') AND line_account_id IS NULL)
      OR (status='paid' AND line_account_id IS NOT NULL))
    ORDER BY created_at LIMIT 20`).bind(now).all<MusuboPendingLineAddition>();
  let failed = 0;
  for (const row of rows.results ?? []) {
    try {
      if (row.status === 'paid' && row.amount_due_yen === 0
        && row.line_account_id === null && row.expires_at <= now) {
        await env.DB.prepare(`UPDATE musubo_pending_additions SET status='expired',updated_at=?
          WHERE id=? AND status='paid' AND line_account_id IS NULL AND amount_due_yen=0`)
          .bind(now, row.id).run();
        continue;
      }
      if (!row.line_account_id && (row.expires_at > now || row.status === 'paid')) {
        const possible = await env.DB.prepare(`SELECT a.id FROM line_accounts a
          WHERE a.tenant_id=? AND a.is_active=0 AND a.archived_at IS NULL
            AND datetime(a.created_at)>=datetime(?) AND NOT EXISTS
              (SELECT 1 FROM musubo_line_usage u WHERE u.line_account_id=a.id)
          ORDER BY a.created_at LIMIT 2`).bind(row.tenant_id, row.created_at).all<{ id: string }>();
        if (possible.results?.length === 1) {
          const accounts = await getLineAccountsByIds(env.DB, [possible.results[0]!.id],
            env.LINE_CREDENTIAL_ENCRYPTION_KEY);
          const account = accounts[0];
          if (!account?.channel_access_token) throw new Error('Saved LINE credential is unavailable');
          const insight = await fetchPreConnectFollowerInsight(account.channel_access_token);
          if (!insight) throw new Error('Saved LINE statistics are unavailable');
          await connectReservedMusuboLine(env, { tenantId: row.tenant_id,
            lineAccountId: account.id, friendsExcludingBlocked: insight.friendsExcludingBlocked,
            measuredOn: insight.measuredOn });
        } else if (row.status === 'paid' && row.amount_due_yen > 0 && row.expires_at <= now) {
          throw new Error('Paid addition has no unique saved LINE to activate');
        }
        continue;
      }
      if (row.status === 'paid') {
        await reconcilePaidMusuboLine(env, row.id, row.tenant_id);
        continue;
      }
      if (row.stripe_invoice_id) {
        let invoice = await stripeApi.retrieveInvoice(env, row.stripe_invoice_id);
        if (invoice.status === 'paid' && invoice.amount_paid >= row.amount_due_yen) {
          await env.DB.prepare(`UPDATE musubo_pending_additions SET status='paid',paid_at=?,updated_at=?
            WHERE id=? AND tenant_id=? AND status='awaiting_payment'`)
            .bind(now, now, row.id, row.tenant_id).run();
          continue;
        }
        if (invoice.status === 'open') invoice = await stripeApi.voidInvoice(env, invoice.id, row.id);
        if (invoice.status !== 'void' && invoice.status !== 'draft' && invoice.status !== 'uncollectible') {
          throw new Error('Expired addition invoice is still payable');
        }
      }
      await env.DB.prepare(`UPDATE musubo_pending_additions SET status='expired',updated_at=?
        WHERE id=? AND tenant_id=? AND status='awaiting_payment' AND expires_at<=?`)
        .bind(now, row.id, row.tenant_id, now).run();
    } catch { failed += 1; }
  }
  return { attempted: rows.results?.length ?? 0, failed };
}
