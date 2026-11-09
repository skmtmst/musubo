import { Hono } from 'hono';
import { getTenantBilling } from '@line-crm/db';
import type { Env } from '../worker-env.js';
import { DEFAULT_TENANT_ID } from '../lib/tenant.js';
import { inputJsonBoundary } from '../lib/input-errors.js';
import { sensitiveStepUpSatisfied, stepUpRequiredResponse } from '../lib/step-up.js';
import { denyReadOnly, requireRole } from '../middleware/role-guard.js';
import { collectMusuboLineAddition, getPendingMusuboLineAddition, quoteMusuboLineAddition,
  reconcilePaidMusuboLine, reserveMusuboLineAddition } from '../services/musubo-line-addition.js';
import { stripeApi } from '../services/stripe-api.js';

export const hqMusuboLineAddition = new Hono<Env>();

hqMusuboLineAddition.get('/api/hq/billing/musubo/line-addition', requireRole('owner', 'admin'), async (c) => {
  const tenantId = c.get('staff').tenantId ?? DEFAULT_TENANT_ID;
  try {
    const pending = await getPendingMusuboLineAddition(c.env.DB, tenantId);
    if (pending && pending.status === 'awaiting_payment' && pending.expires_at <= new Date().toISOString()) {
      const quote = await quoteMusuboLineAddition(c.env, tenantId);
      return c.json({ success: true, data: { price: quote.price, activeLineCount: quote.activeLineCount,
        recurringAfter: quote.recurringAfter, monthlyPeriod: quote.monthlyPeriod,
        annualPeriod: quote.annualPeriod, expired: true } });
    }
    if (pending) {
      const snapshot = JSON.parse(pending.price_snapshot_json) as { price: unknown; recurringAfter: unknown; activeLineCount: number };
      const invoice = pending.stripe_invoice_id
        ? await stripeApi.retrieveInvoice(c.env, pending.stripe_invoice_id) : null;
      return c.json({ success: true, data: { pending: {
      id: pending.id, status: pending.status, amountDueYen: pending.amount_due_yen,
      expiresAt: pending.expires_at, canConnect: pending.line_account_id === null,
      activationPending: pending.status === 'paid' && pending.line_account_id !== null,
      paymentUrl: invoice?.hosted_invoice_url ?? null,
    }, price: snapshot.price, recurringAfter: snapshot.recurringAfter,
      activeLineCount: snapshot.activeLineCount } });
    }
    const quote = await quoteMusuboLineAddition(c.env, tenantId);
    return c.json({ success: true, data: {
      price: quote.price, activeLineCount: quote.activeLineCount,
      recurringAfter: quote.recurringAfter,
      monthlyPeriod: quote.monthlyPeriod, annualPeriod: quote.annualPeriod,
    } });
  } catch {
    return c.json({ success: false, error: '追加料金を確認できませんでした。時間をおいて再度お試しください' }, 409);
  }
});

hqMusuboLineAddition.post('/api/hq/billing/musubo/line-addition',
  requireRole('owner', 'admin'), denyReadOnly(), inputJsonBoundary(), async (c) => {
    if (!await sensitiveStepUpSatisfied(c, 'line_account.connect')) {
      return stepUpRequiredResponse(c, 'LINE追加料金の確定には本人確認が必要です');
    }
    const body = await c.req.json<unknown>().catch(() => null);
    const value = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null;
    if (value?.consent !== true || !Number.isSafeInteger(value?.amountDueYen)
      || !Number.isSafeInteger(value?.activeLineCount)) {
      return c.json({ success: false, error: '画面の料金をご確認のうえ、同意してください' }, 400);
    }
    const tenantId = c.get('staff').tenantId ?? DEFAULT_TENANT_ID;
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
      const invoice = pending.stripe_invoice_id
        ? await stripeApi.retrieveInvoice(c.env, pending.stripe_invoice_id) : null;
      return c.json({ success: true, data: {
        id: pending.id, status: activated ? 'activated' : pending.status,
        amountDueYen: pending.amount_due_yen,
        expiresAt: pending.expires_at, canConnect: pending.line_account_id === null,
        activationPending: pending.status === 'paid' && pending.line_account_id !== null && !activated,
        paymentUrl: invoice?.hosted_invoice_url ?? null,
      } });
    } catch {
      return c.json({ success: false,
        error: '追加料金または決済の状態が変わりました。料金を再表示してからお試しください' }, 409);
    }
  });
