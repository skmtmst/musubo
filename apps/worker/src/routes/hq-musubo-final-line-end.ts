import { Hono } from 'hono';
import type { Env } from '../worker-env.js';
import { DEFAULT_TENANT_ID } from '../lib/tenant.js';
import { inputJsonBoundary } from '../lib/input-errors.js';
import { sensitiveStepUpSatisfied, stepUpRequiredResponse } from '../lib/step-up.js';
import { denyReadOnly, requireRole } from '../middleware/role-guard.js';
import { getMusuboFinalLineEnd, requestMusuboFinalLineEnd } from '../services/musubo-final-line-end.js';
import { deliverLatestMusuboFinalLineNotice } from '../services/musubo-final-line-notification.js';

export const hqMusuboFinalLineEnd = new Hono<Env>();

hqMusuboFinalLineEnd.get('/api/hq/billing/musubo/last-line-end',
  requireRole('owner'), async (c) => {
    const tenantId = c.get('staff').tenantId ?? DEFAULT_TENANT_ID;
    try {
      return c.json({ success: true, data: await getMusuboFinalLineEnd(c.env, tenantId) });
    } catch {
      return c.json({ success: false, error: '最後のLINEの利用状態を確認できませんでした' }, 409);
    }
  });

hqMusuboFinalLineEnd.post('/api/hq/billing/musubo/last-line-end',
  requireRole('owner'), denyReadOnly(), inputJsonBoundary(), async (c) => {
    const body = await c.req.json<unknown>().catch(() => null);
    const action = body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>).action : null;
    if (action !== 'schedule' && action !== 'now' && action !== 'cancel') {
      return c.json({ success: false, error: '終了方法を選んでください' }, 400);
    }
    if (!await sensitiveStepUpSatisfied(c, 'line_account.archive')) {
      return stepUpRequiredResponse(c, 'LINEの利用終了には本人確認が必要です');
    }
    const tenantId = c.get('staff').tenantId ?? DEFAULT_TENANT_ID;
    try {
      const phase = await requestMusuboFinalLineEnd(c.env, tenantId, action);
      await deliverLatestMusuboFinalLineNotice(c.env, tenantId,
        action === 'schedule' ? 'scheduled' : action === 'cancel' ? 'cancelled' : 'immediate')
        .catch(() => undefined);
      return c.json({ success: true, data: { phase,
        end: await getMusuboFinalLineEnd(c.env, tenantId) } });
    } catch (error) {
      if (error instanceof Error && error.message === 'PENDING_ADDITION') {
        return c.json({ success: false,
          error: 'LINEの追加手続き中です。追加分の決済を確認してから利用終了をお申し込みください' }, 409);
      }
      return c.json({ success: false,
        error: '終了手続きの確認が完了していません。状態を読み直してから再度お試しください' }, 409);
    }
  });
