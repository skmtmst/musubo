import { Hono } from 'hono';
import { auditLog } from '../lib/audit-log.js';
import type { Env } from '../worker-env.js';
import { requireRole } from '../middleware/role-guard.js';
import { inputJsonBoundary } from '../lib/input-errors.js';
import { canUseMileageAccount } from './scoring-definition.js';
import { blockEcMileageWrite } from '../services/mileage-write-guard.js';
import { cancelHandgift, deliverHandgift } from '../features/mileage/index.js';

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


mileageHandgift.post('/api/mileage/redemptions/:id/hand-cancel', requireRole('owner', 'admin'), inputJsonBoundary(), async (c) => {
  if (c.get('staff').readOnly) return c.json({ success: false, error: 'この操作を実行する権限がありません' }, 403);
  const body = await c.req.json<{ accountId?: unknown; reason?: unknown; expectedStatus?: unknown }>();
  const accountId = typeof body.accountId === 'string' ? body.accountId.trim() : '';
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (!await canUseMileageAccount(c, accountId)) return c.json({ success: false, error: '交換履歴が見つかりません' }, 404);
  if (!['reserved', 'succeeded'].includes(String(body.expectedStatus))) return c.json({ success: false, error: '交換の状態を確認してください' }, 400);
  if (body.expectedStatus === 'succeeded' && !reason) return c.json({ success: false, error: '訂正理由を入力してください' }, 400);
  if (reason.length > 500) return c.json({ success: false, error: '取消理由を500字以内で入力してください' }, 400);
  const blocked = await blockEcMileageWrite(c, accountId);
  if (blocked) return blocked;
  const cancelled = await cancelHandgift(c.env.DB, { accountId, redemptionId: c.req.param('id'), actorId: c.get('staff').id, reason: reason || '手渡し前の取消', expectedStatus: body.expectedStatus as 'reserved' | 'succeeded' });
  if (cancelled !== 'conflict') auditLog(c, 'mileage.redemption.hand_cancel', { kind: 'mileage_redemption', id: c.req.param('id') });
  if (cancelled === 'pending') return c.json({ success: false, error: '取消は確定しました。マイルを戻す処理を再試行してください' }, 202);
  return cancelled === 'completed' ? c.json({ success: true }) : c.json({ success: false, error: '取り消せない交換です。最新の状態を確認してください' }, 409);
});
