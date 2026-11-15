import type { Context } from 'hono';
import { getBroadcastById } from '@line-crm/db';
import { BROADCAST_DEFINITION_EDIT_KEY } from '@line-crm/shared';
import type { Env } from '../worker-env.js';
import { broadcastAccountIds, broadcastWriteBoundary, canAccessBroadcast, UUID_PATTERN } from './broadcasts-definition.js';

const SAMPLE = '先ほどのメッセージに誤りがありました。正しくは次のとおりです。〈ここに正しい内容〉';
const CONDITIONS = JSON.stringify({ operator: 'AND', rules: [{ type: 'is_following', value: true }] });

export async function createBroadcastCorrection(c: Context<Env, '/api/broadcasts/:id/correction'>) {
  const source = await getBroadcastById(c.env.DB, c.req.param('id'));
  if (!source || !await canAccessBroadcast(c.env.DB, c.get('staff'), source)) return c.json({ success: false, error: 'not_found' }, 404);
  const staff = c.get('staff');
  const permission = await broadcastWriteBoundary(c, broadcastAccountIds(source), { operationKey: BROADCAST_DEFINITION_EDIT_KEY });
  if (staff?.readOnly || c.get('impersonation') || !permission.allowed) return c.json({ success: false, error: 'forbidden' }, 403);
  const key = c.req.header('Idempotency-Key')?.trim();
  if (!key || !UUID_PATTERN.test(key)) return c.json({ success: false, error: 'Idempotency-Key must be a UUID' }, 400);
  const replay = async () => {
    const existing = await getBroadcastById(c.env.DB, key);
    if (!existing) return null;
    if (existing.correction_of_broadcast_id !== source.id) return c.json({ success: false, error: 'idempotency_key_conflict' }, 409);
    c.header('Idempotency-Replayed', 'true');
    return c.json({ success: true, data: { id: existing.id } }, 200);
  };
  const previous = await replay();
  if (previous) return previous;
  if (source.status !== 'sent') return c.json({ success: false, error: 'broadcast_not_sent' }, 409);
  if (!source.line_account_id || !['segment', 'tag'].includes(source.target_type) || source.hq_run_id) return c.json({ success: false, error: 'audience_unavailable' }, 409);
  const counts = await c.env.DB.prepare("SELECT COUNT(*) AS total, SUM(state='sent') AS sent FROM broadcast_send_claims WHERE broadcast_id=?").bind(source.id).first<{ total: number; sent: number }>();
  if (!counts || !counts.sent || counts.sent !== source.success_count || counts.total !== source.total_count) return c.json({ success: false, error: 'audience_unavailable' }, 409);
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(`INSERT INTO broadcasts(id,title,message_type,message_content,target_type,status,line_account_id,segment_conditions,total_count,correction_of_broadcast_id,draft_step)
        SELECT ?,?,'text',?,'segment','draft',line_account_id,?,?,id,'message' FROM broadcasts
        WHERE id=? AND status='sent' AND total_count=? AND success_count=?
        AND (SELECT COUNT(*) FROM broadcast_send_claims WHERE broadcast_id=broadcasts.id)=?
        AND (SELECT COUNT(*) FROM broadcast_send_claims WHERE broadcast_id=broadcasts.id AND state='sent')=?`).bind(key, `訂正：${source.title}`, SAMPLE, CONDITIONS, counts.sent, source.id, counts.total, counts.sent, counts.total, counts.sent),
      c.env.DB.prepare(`INSERT INTO broadcast_send_claims(broadcast_id,friend_id,line_account_id,attempt_no,state)
        SELECT ?,friend_id,line_account_id,1,'claimed' FROM broadcast_send_claims
        WHERE broadcast_id=? AND state='sent' AND EXISTS (SELECT 1 FROM broadcasts WHERE id=? AND correction_of_broadcast_id=?)`)
        .bind(key, source.id, key, source.id),
    ]);
  } catch (error) {
    const existing = await replay();
    if (existing) return existing;
    throw error;
  }
  const created = await getBroadcastById(c.env.DB, key);
  if (!created) return c.json({ success: false, error: 'audience_changed' }, 409);
  return c.json({ success: true, data: { id: created.id } }, 201);
}
