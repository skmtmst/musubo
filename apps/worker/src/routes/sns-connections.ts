import { Hono } from 'hono';
import type { SetSnsGooglePrimaryInput } from '@line-crm/shared';
import type { Env } from '../worker-env.js';
import { DEFAULT_TENANT_ID } from '../lib/tenant.js';
import { fail } from '../lib/fail.js';
import { inputJsonBoundary } from '../lib/input-errors.js';
import { denyReadOnly, requireRole } from '../middleware/role-guard.js';
import { canAccessAllLineAccounts } from '../services/account-access.js';
import { readSnsConnectionPorts, setSnsGooglePrimary } from '../services/sns-connection-ports.js';

export const snsConnections = new Hono<Env>();

snsConnections.get('/api/settings/sns/connections', requireRole('owner', 'admin'), async (c) => {
  const lineAccountId = c.req.query('lineAccountId');
  if (!lineAccountId) return fail(c, 400, 'LINEアカウントを選んでください', {}, ['lineAccountId']);
  if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [lineAccountId])) {
    return fail(c, 403, 'このLINEアカウントのSNS連携は表示できません');
  }
  const tenantId = c.get('staff').tenantId ?? DEFAULT_TENANT_ID;
  const data = await readSnsConnectionPorts(c.env, { tenantId, lineAccountId });
  if (!data) return fail(c, 404, 'このLINEアカウントの契約枠が見つかりません');
  c.header('Cache-Control', 'no-store');
  return c.json({ success: true, data });
});

snsConnections.put(
  '/api/settings/sns/google-primary',
  requireRole('owner', 'admin'),
  denyReadOnly(),
  inputJsonBoundary({
    lineAccountId: ['string'], connectionId: ['string'], expectedVersion: ['number'],
  }),
  async (c) => {
    const body = await c.req.json<SetSnsGooglePrimaryInput>();
    if (!body.lineAccountId || !body.connectionId || !Number.isSafeInteger(body.expectedVersion)
      || body.expectedVersion < 0) {
      return fail(c, 400, '接続先と確認した版を指定してください', {}, [
        'lineAccountId', 'connectionId', 'expectedVersion',
      ]);
    }
    if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [body.lineAccountId])) {
      return fail(c, 403, 'このLINEアカウントの主連携は変更できません');
    }
    const tenantId = c.get('staff').tenantId ?? DEFAULT_TENANT_ID;
    const result = await setSnsGooglePrimary(c.env.DB, {
      tenantId, lineAccountId: body.lineAccountId,
      connectionId: body.connectionId, expectedVersion: body.expectedVersion,
    });
    if (result.status === 'not_found') return fail(c, 404, 'Google接続が見つかりません');
    if (result.status === 'conflict') {
      return fail(c, 409, 'ほかの人が先に主連携を変更しました。最新の状態を読み直してください', {
        code: 'VERSION_CONFLICT', current: result.current,
      });
    }
    c.header('Cache-Control', 'no-store');
    return c.json({ success: true, data: result.data });
  },
);
