import { Hono, type Context } from 'hono';
import { getTenantBilling } from '@line-crm/db';
import type { Env } from '../worker-env.js';
import { DEFAULT_TENANT_ID } from '../lib/tenant.js';
import { inputJsonBoundary } from '../lib/input-errors.js';
import { sensitiveStepUpSatisfied, stepUpRequiredResponse } from '../lib/step-up.js';
import { denyReadOnly, requireRole } from '../middleware/role-guard.js';
import { collectMusuboLineAddition, getPendingMusuboLineAddition, quoteMusuboLineAddition,
  reconcilePaidMusuboLine, reserveMusuboLineAddition, type MusuboPendingLineAddition } from '../services/musubo-line-addition.js';
import {
  getMusuboLineAddition,
  resumePaidMusuboLineAddition,
  type MusuboLineAdditionTarget,
} from '../services/musubo-line-addition-recovery.js';
import { stripeApi } from '../services/stripe-api.js';
import { getVisibleLineAccountEntry } from './line-account-access.js';

export const hqMusuboLineAddition = new Hono<Env>();

function additionTarget(additionId: unknown, accountId: unknown): MusuboLineAdditionTarget | null {
  const valid = (value: unknown): value is string =>
    typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
  if (valid(additionId) && accountId === undefined) return { additionId };
  if (valid(accountId) && additionId === undefined) return { accountId };
  return null;
}

function isExpired(addition: MusuboPendingLineAddition): boolean {
  return addition.status === 'expired' || addition.status === 'cancelled'
    || ((addition.status === 'awaiting_payment'
      || (addition.status === 'paid' && addition.amount_due_yen === 0 && addition.line_account_id === null))
      && addition.expires_at <= new Date().toISOString());
}

function presentAddition(addition: MusuboPendingLineAddition, lineAccountId: string | null, paymentUrl: string | null) {
  return {
    id: addition.id,
    lineAccountId,
    status: addition.status,
    amountDueYen: addition.amount_due_yen,
    expiresAt: addition.expires_at,
    canConnect: addition.line_account_id === null && !isExpired(addition)
      && (addition.status === 'awaiting_payment' || addition.status === 'paid'),
    activationPending: addition.status === 'paid' && addition.line_account_id !== null,
    paymentUrl,
  };
}

function savedPrice(addition: MusuboPendingLineAddition) {
  type Quote = Awaited<ReturnType<typeof quoteMusuboLineAddition>>;
  type SavedQuote = Pick<Quote, 'price' | 'recurringAfter' | 'activeLineCount' | 'monthlyPeriod' | 'annualPeriod'>;
  const { price, recurringAfter, activeLineCount, monthlyPeriod, annualPeriod } =
    JSON.parse(addition.price_snapshot_json) as SavedQuote;
  return { price, recurringAfter, activeLineCount: activeLineCount + (addition.status === 'activated' ? 1 : 0),
    monthlyPeriod, annualPeriod };
}

async function visibleAccountId(c: Context<Env>, addition: MusuboPendingLineAddition) {
  const account = addition.line_account_id ? await getVisibleLineAccountEntry(c, addition.line_account_id) : null;
  return account && !account.archived_at ? account.id : null;
}

async function getAuthorizedAddition(c: Context<Env>, tenantId: string, target: MusuboLineAdditionTarget) {
  const addition = await getMusuboLineAddition(c.env.DB, tenantId, target);
  if (addition?.line_account_id && !await visibleAccountId(c, addition)) return null;
  return addition;
}

async function savedPaymentUrl(c: Context<Env>, addition: MusuboPendingLineAddition) {
  if (addition.status !== 'awaiting_payment' || isExpired(addition) || !addition.stripe_invoice_id) return null;
  const invoice = await stripeApi.retrieveInvoice(c.env, addition.stripe_invoice_id);
  return invoice.status === 'open' ? invoice.hosted_invoice_url ?? null : null;
}

hqMusuboLineAddition.get('/api/hq/billing/musubo/line-addition', requireRole('owner', 'admin'), async (c) => {
  c.header('Cache-Control', 'no-store');
  const tenantId = c.get('staff').tenantId ?? DEFAULT_TENANT_ID;
  const additionId = c.req.query('additionId');
  const accountId = c.req.query('accountId');
  try {
    if (additionId !== undefined || accountId !== undefined) {
      const target = additionTarget(additionId, accountId);
      if (!target) return c.json({ success: false, error: 'LINE追加の指定を確認してください' }, 400);
      const addition = await getAuthorizedAddition(c, tenantId, target);
      if (!addition) return c.json({ success: false, error: '対象のLINE追加を確認できませんでした' }, 404);
      const summary = presentAddition(addition, addition.line_account_id, await savedPaymentUrl(c, addition));
      return c.json({ success: true, data: { ...savedPrice(addition), addition: summary,
        ...(isExpired(addition) ? { expired: true } : {}),
        ...(addition.status === 'awaiting_payment' || addition.status === 'paid' ? { pending: summary } : {}),
      } });
    }

    const pending = await getPendingMusuboLineAddition(c.env.DB, tenantId);
    if (pending && !isExpired(pending)) {
      const summary = presentAddition(pending, await visibleAccountId(c, pending), await savedPaymentUrl(c, pending));
      return c.json({ success: true, data: { ...savedPrice(pending), pending: summary } });
    }
    const quote = await quoteMusuboLineAddition(c.env, tenantId);
    return c.json({ success: true, data: {
      price: quote.price, activeLineCount: quote.activeLineCount,
      recurringAfter: quote.recurringAfter,
      monthlyPeriod: quote.monthlyPeriod, annualPeriod: quote.annualPeriod,
      ...(pending ? { expired: true } : {}),
    } });
  } catch {
    return c.json({ success: false, error: '追加料金を確認できませんでした。時間をおいて再度お試しください' }, 409);
  }
});

hqMusuboLineAddition.post('/api/hq/billing/musubo/line-addition',
  requireRole('owner', 'admin'), denyReadOnly(), inputJsonBoundary(), async (c) => {
    c.header('Cache-Control', 'no-store');
    const body = await c.req.json<unknown>().catch(() => null);
    const value = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null;
    const tenantId = c.get('staff').tenantId ?? DEFAULT_TENANT_ID;
    if (value?.action === 'reconcile') {
      const target = additionTarget(value.additionId, value.accountId);
      if (!target) return c.json({ success: false, error: 'LINE追加の指定を確認してください' }, 400);
      try {
        const addition = await getAuthorizedAddition(c, tenantId, target);
        if (!addition) return c.json({ success: false, error: '対象のLINE追加を確認できませんでした' }, 404);
        const recovered = await resumePaidMusuboLineAddition(c.env, addition);
        return c.json({ success: true, data: presentAddition(recovered.addition, addition.line_account_id, recovered.paymentUrl) });
      } catch {
        return c.json({ success: false, error: '追加分の有効化を確認できませんでした。もう一度お試しください' }, 409);
      }
    }
    if (!await sensitiveStepUpSatisfied(c, 'line_account.connect')) {
      return stepUpRequiredResponse(c, 'LINE追加料金の確定には本人確認が必要です');
    }
    if (value?.consent !== true || !Number.isSafeInteger(value?.amountDueYen)
      || !Number.isSafeInteger(value?.activeLineCount)) {
      return c.json({ success: false, error: '画面の料金をご確認のうえ、同意してください' }, 400);
    }
    try {
      let pending = await reserveMusuboLineAddition(c.env, tenantId,
        value.amountDueYen as number, value.activeLineCount as number);
      if (pending.line_account_id && pending.status === 'awaiting_payment') {
        const billing = await getTenantBilling(c.env.DB, tenantId);
        if (!billing?.stripe_customer_id) throw new Error('Stripe customer is unavailable');
        pending = await collectMusuboLineAddition(c.env, pending, billing.stripe_customer_id);
      }
      let activated = false;
      if (pending.line_account_id && pending.status === 'paid') {
        activated = await reconcilePaidMusuboLine(c.env, pending.id, tenantId);
      }
      const summary = presentAddition(activated ? { ...pending, status: 'activated' } : pending,
        await visibleAccountId(c, pending), await savedPaymentUrl(c, pending));
      return c.json({ success: true, data: summary });
    } catch {
      return c.json({ success: false,
        error: '追加料金または決済の状態が変わりました。料金を再表示してからお試しください' }, 409);
    }
  });
