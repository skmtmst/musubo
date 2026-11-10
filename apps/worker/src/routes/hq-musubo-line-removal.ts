import { Hono } from 'hono';
import type { Env } from '../worker-env.js';
import { DEFAULT_TENANT_ID } from '../lib/tenant.js';
import { inputJsonBoundary } from '../lib/input-errors.js';
import { sensitiveStepUpSatisfied, stepUpRequiredResponse } from '../lib/step-up.js';
import { denyReadOnly, requireRole } from '../middleware/role-guard.js';
import { getMusuboLineRemoval, requestMusuboLineRemoval } from '../services/musubo-line-removal.js';
import { deliverLatestMusuboLineRemovalNotice } from '../services/musubo-line-removal-notification.js';

export const hqMusuboLineRemoval = new Hono<Env>();

const path = '/api/hq/billing/musubo/line-removal/:lineId';

hqMusuboLineRemoval.get(path, requireRole('owner'), async (c) => {
  const tenantId = c.get('staff').tenantId ?? DEFAULT_TENANT_ID;
  try {
    return c.json({ success: true, data: await getMusuboLineRemoval(c.env, tenantId,
      c.req.param('lineId')) });
  } catch {
    return c.json({ success: false,
      error: 'LINEの利用終了日と料金を確認できませんでした。請求画面を読み直してください' }, 409);
  }
});

hqMusuboLineRemoval.post(path, requireRole('owner'), denyReadOnly(), inputJsonBoundary(), async (c) => {
  const body = await c.req.json<unknown>().catch(() => null);
  const action = body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>).action : null;
  if (action !== 'schedule' && action !== 'now' && action !== 'cancel') {
    return c.json({ success: false, error: '利用終了日を選んでください' }, 400);
  }
  if (!await sensitiveStepUpSatisfied(c, 'line_account.archive')) {
    return stepUpRequiredResponse(c, 'LINEの利用終了には本人確認が必要です');
  }
  const tenantId = c.get('staff').tenantId ?? DEFAULT_TENANT_ID;
  try {
    const phase = await requestMusuboLineRemoval(c.env, tenantId, c.req.param('lineId'), action);
    if (phase === 'scheduled' || phase === 'ended' || phase === 'cancelled') {
      await deliverLatestMusuboLineRemovalNotice(c.env, tenantId, phase)
        .catch(() => undefined);
    }
    return c.json({ success: true, data: { phase } });
  } catch (error) {
    return c.json({ success: false,
      error: error instanceof Error && error.message === 'A revised individual quote is required'
        ? '個別見積もりの契約枠を減らすには、運営との再見積もりが必要です'
        : '利用終了の処理を確認中です。料金と状態を読み直してから再度お試しください' }, 409);
  }
});
