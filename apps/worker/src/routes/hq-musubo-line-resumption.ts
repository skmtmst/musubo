import { Hono } from 'hono';
import { getMusuboTenantBilling } from '@line-crm/db';
import type { Env } from '../worker-env.js';
import { DEFAULT_TENANT_ID } from '../lib/tenant.js';
import { inputJsonBoundary } from '../lib/input-errors.js';
import { denyReadOnly, requireRole } from '../middleware/role-guard.js';
import { sensitiveStepUpSatisfied, stepUpRequiredResponse } from '../lib/step-up.js';
import { acceptMusuboLineResumption, getMusuboLineResumptionOffer } from
  '../services/musubo-line-resumption-review.js';
import { getMusuboLineResumptionComplete, reconcileMusuboLineResumption, requestMusuboLineResumption } from
  '../services/musubo-line-resumption.js';
import { deliverMusuboResumptionNotice } from '../services/musubo-resumption-notification.js';

export const hqMusuboLineResumption = new Hono<Env>();

hqMusuboLineResumption.get('/api/hq/billing/musubo/resumption', requireRole('owner'), async (c) => {
  const tenantId = c.get('staff').tenantId ?? DEFAULT_TENANT_ID;
  try {
    const billing = await getMusuboTenantBilling(c.env.DB, tenantId);
    if (billing?.status === 'ended' && billing.resumption_requested_at
      && billing.resumption_offer_json) {
      return c.json({ success: true, data: {
        review: JSON.parse(billing.resumption_offer_json),
        consented: true, reconciliationPending: true } });
    }
    const review = await getMusuboLineResumptionOffer(c.env, tenantId);
    return c.json({ success: true, data: { review,
      consented: review.kind !== 'unpaid' && billing?.resumption_offer_json === JSON.stringify(review)
        && Boolean(billing.resumption_consented_at),
      reconciliationPending: Boolean(billing?.resumption_requested_at) } });
  } catch {
    return c.json({ success: false,
      error: '再開時の料金を確認できませんでした。請求の状況を確認してからやり直してください' }, 409);
  }
});

hqMusuboLineResumption.post('/api/hq/billing/musubo/resumption/accept',
  requireRole('owner'), denyReadOnly(), inputJsonBoundary(), async (c) => {
    const tenantId = c.get('staff').tenantId ?? DEFAULT_TENANT_ID;
    try {
      const review = await acceptMusuboLineResumption(c.env, tenantId);
      return c.json({ success: true, data: { review, consented: true,
        reconciliationPending: false } });
    } catch {
      return c.json({ success: false,
        error: '再開時の料金やお支払いの状態が変わりました。最新の内容を確認してください' }, 409);
    }
  });

hqMusuboLineResumption.post('/api/hq/billing/musubo/resumption/connect',
  requireRole('owner'), denyReadOnly(), inputJsonBoundary(), async (c) => {
    if (!await sensitiveStepUpSatisfied(c, 'line_account.connect')) {
      return stepUpRequiredResponse(c, 'LINEの利用再開には本人確認が必要です');
    }
    const tenantId = c.get('staff').tenantId ?? DEFAULT_TENANT_ID;
    try {
      await requestMusuboLineResumption(c.env, tenantId);
    } catch {
      return c.json({ success: false,
        error: 'カードまたは以前のLINE接続を確認できませんでした。再開条件を読み直してください' }, 409);
    }
    try {
      const active = await reconcileMusuboLineResumption(c.env, tenantId);
      if (active) await deliverMusuboResumptionNotice(c.env, tenantId).catch(() => undefined);
      return c.json({ success: true, data: { active } });
    } catch {
      return c.json({ success: true, data: { active: false,
        message: '決済とLINE接続を確認しています。完了まで追加の操作は不要です' } }, 202);
    }
  });

hqMusuboLineResumption.get('/api/hq/billing/musubo/resumption/complete',
  requireRole('owner'), async (c) => {
    const tenantId = c.get('staff').tenantId ?? DEFAULT_TENANT_ID;
    try {
      return c.json({ success: true,
        data: await getMusuboLineResumptionComplete(c.env, tenantId) });
    } catch {
      return c.json({ success: false,
        error: '利用再開の決済結果を確認しています。時間をおいて読み直してください' }, 409);
    }
  });
