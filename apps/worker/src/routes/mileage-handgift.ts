import { Hono } from 'hono';
import { auditLog } from '../lib/audit-log.js';
import type { Env } from '../worker-env.js';
import { requireRole } from '../middleware/role-guard.js';
import { inputJsonBoundary } from '../lib/input-errors.js';
import { canUseMileageAccount } from './scoring-definition.js';
import { blockEcMileageWrite } from '../services/mileage-write-guard.js';
import { deliverHandgift } from '../features/mileage/index.js';

export const mileageHandgift = new Hono<Env>();
mileageHandgift.post('/api/mileage/redemptions/:id/hand-delivery', requireRole('owner', 'admin'), inputJsonBoundary(), async (c) => {
  if (c.get('staff').readOnly) return c.json({ success: false, error: 'この操作を実行する権限がありません' }, 403);
  const body = await c.req.json<{ accountId?: unknown }>();
  const accountId = typeof body.accountId === 'string' ? body.accountId.trim() : '';
  if (!await canUseMileageAccount(c, accountId)) return c.json({ success: false, error: '交換履歴が見つかりません' }, 404);
  const blocked = await blockEcMileageWrite(c, accountId);
  if (blocked) return blocked;
  const delivered = await deliverHandgift(c.env.DB, { accountId, redemptionId: c.req.param('id'), actorId: c.get('staff').id });
  if (delivered) auditLog(c, 'mileage.redemption.hand_delivery', { kind: 'mileage_redemption', id: c.req.param('id') });
  return delivered ? c.json({ success: true }) : c.json({ success: false, error: '手渡しできない交換です。最新の状態を確認してください' }, 409);
});
