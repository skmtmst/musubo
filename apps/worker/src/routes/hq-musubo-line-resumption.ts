import { Hono } from 'hono';
import { getMusuboTenantBilling } from '@line-crm/db';
import type { Env } from '../worker-env.js';
import { DEFAULT_TENANT_ID } from '../lib/tenant.js';
import { inputJsonBoundary } from '../lib/input-errors.js';
import { denyReadOnly, requireRole } from '../middleware/role-guard.js';
import { acceptMusuboLineResumption, getMusuboLineResumptionReview } from
  '../services/musubo-line-resumption-review.js';

export const hqMusuboLineResumption = new Hono<Env>();

hqMusuboLineResumption.get('/api/hq/billing/musubo/resumption', requireRole('owner'), async (c) => {
  const tenantId = c.get('staff').tenantId ?? DEFAULT_TENANT_ID;
  try {
    const review = await getMusuboLineResumptionReview(c.env.DB, tenantId);
    const billing = await getMusuboTenantBilling(c.env.DB, tenantId);
    return c.json({ success: true, data: { review,
      consented: review.kind !== 'unpaid' && billing?.resumption_offer_json === JSON.stringify(review)
        && Boolean(billing.resumption_consented_at) } });
  } catch {
    return c.json({ success: false,
      error: '再開時の料金を確認できませんでした。請求の状況を確認してからやり直してください' }, 409);
  }
});

hqMusuboLineResumption.post('/api/hq/billing/musubo/resumption/accept',
  requireRole('owner'), denyReadOnly(), inputJsonBoundary(), async (c) => {
    const tenantId = c.get('staff').tenantId ?? DEFAULT_TENANT_ID;
    try {
      const review = await acceptMusuboLineResumption(c.env.DB, tenantId);
      return c.json({ success: true, data: { review, consented: true } });
    } catch {
      return c.json({ success: false,
        error: '再開時の料金やお支払いの状態が変わりました。最新の内容を確認してください' }, 409);
    }
  });
