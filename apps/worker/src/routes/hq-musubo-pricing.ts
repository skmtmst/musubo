import { Hono, type Context } from 'hono';
import {
  getLatestTenantMusuboIndividualQuote, getMusuboTenantBilling,
  recordMusuboPricingSelection,
} from '@line-crm/db';
import { musuboPrice, type AppliedMusuboCondition } from '@line-crm/shared';
import type { Env } from '../worker-env.js';
import { DEFAULT_TENANT_ID } from '../lib/tenant.js';
import { requireRole } from '../middleware/role-guard.js';
import { inputJsonBoundary } from '../lib/input-errors.js';

export const hqMusuboPricing = new Hono<Env>();

function tenantId(c: Context<Env>): string {
  return c.get('staff').tenantId ?? DEFAULT_TENANT_ID;
}

function selectionFrom(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (!Number.isSafeInteger(raw.lineCount) || (raw.lineCount as number) < 1 || (raw.lineCount as number) > 10
    || !Number.isSafeInteger(raw.friendCountExcludingBlocked) || (raw.friendCountExcludingBlocked as number) < 0
    || (raw.friendCountExcludingBlocked as number) > 999_999_999
    || !Number.isSafeInteger(raw.googleBusinessCount) || (raw.googleBusinessCount as number) < 0
    || (raw.googleBusinessCount as number) > 10
    || !Number.isSafeInteger(raw.instagramCount) || (raw.instagramCount as number) < 0
    || (raw.instagramCount as number) > 10
    || (raw.interval !== 'month' && raw.interval !== 'year')) return null;
  if ((raw.lineCount as number) > 1 && (raw.googleBusinessCount !== 1 || raw.instagramCount !== 1)) return null;
  return {
    lineCount: raw.lineCount as number,
    friendCountExcludingBlocked: raw.friendCountExcludingBlocked as number,
    googleBusinessCount: raw.googleBusinessCount as number,
    instagramCount: raw.instagramCount as number,
    interval: raw.interval as 'month' | 'year',
  };
}

hqMusuboPricing.get('/api/hq/onboarding/pricing', requireRole('owner', 'admin'), async (c) => {
  const billing = await getMusuboTenantBilling(c.env.DB, tenantId(c));
  if (!billing) return c.json({ success: false, error: '利用条件が見つかりません' }, 404);
  const latestQuote = await getLatestTenantMusuboIndividualQuote(c.env.DB, tenantId(c));
  const condition = JSON.parse(billing.pricing_snapshot_json) as AppliedMusuboCondition;
  const saved = billing.pricing_selection_json ? JSON.parse(billing.pricing_selection_json) as { selection: unknown } : null;
  return c.json({ success: true, data: {
    condition: {
      name: condition.internalName, trialPeriod: condition.trialPeriod,
      lineBasicDiscountPercent: condition.lineBasicDiscountPercent, schedule: condition.schedule,
      discountEndsOn: condition.discountEndsOn,
    },
    selection: saved?.selection ?? null,
    consentedAt: billing.pricing_consented_at,
    quoteId: latestQuote?.id ?? billing.quote_id,
  } });
});

hqMusuboPricing.post('/api/hq/onboarding/pricing', requireRole('owner', 'admin'), inputJsonBoundary(), async (c) => {
  const body = await c.req.json<unknown>().catch(() => null);
  const object = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null;
  const selection = selectionFrom(object?.selection);
  if (!selection || object?.consent !== true) {
    return c.json({ success: false, error: '利用予定と料金条件への同意を確認してください' }, 400);
  }
  const id = tenantId(c);
  const billing = await getMusuboTenantBilling(c.env.DB, id);
  if (!billing || billing.status !== 'awaiting_first_line' || billing.quote_id) {
    return c.json({ success: false, error: '料金確認の状態が変わりました。読み直してください' }, 409);
  }
  if (await getLatestTenantMusuboIndividualQuote(c.env.DB, id)) {
    return c.json({ success: false, error: '個別見積もりの内容をご確認ください' }, 409);
  }
  const condition = JSON.parse(billing.pricing_snapshot_json) as AppliedMusuboCondition;
  const price = musuboPrice({
    lineCount: selection.lineCount,
    friendCountExcludingBlocked: selection.friendCountExcludingBlocked,
    linkedAccountsByLine: Array.from({ length: selection.lineCount }, () => ({
      googleBusiness: selection.lineCount === 1 ? selection.googleBusinessCount : 1,
      instagram: selection.lineCount === 1 ? selection.instagramCount : 1,
    })),
    interval: selection.interval,
    lineBasicDiscountPercent: condition.lineBasicDiscountPercent,
    schedule: condition.schedule,
  });
  const saved = await recordMusuboPricingSelection(c.env.DB, {
    tenantId: id, selectionJson: JSON.stringify({ selection, price,
      conditionId: condition.sourceConditionId, conditionVersion: condition.sourceVersion }),
    interval: selection.interval,
  });
  if (!saved) return c.json({ success: false, error: '料金確認の状態が変わりました。読み直してください' }, 409);
  return c.json({ success: true, data: { selection, price, next: '/hq/onboarding/card' } });
});
