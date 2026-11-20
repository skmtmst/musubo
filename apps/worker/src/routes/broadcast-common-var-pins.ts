import type { Context } from 'hono';
import { getBroadcastById } from '@line-crm/db';
import { BROADCAST_DEFINITION_EDIT_KEY } from '@line-crm/shared';
import type { Env } from '../worker-env.js';
import { validatedInputBody } from '../lib/input-errors.js';
import { simulationContext } from '../features/broadcasts/broadcast-simulation/index.js';
import { broadcastAccountIds, broadcastWriteBoundary, canAccessBroadcast } from './broadcasts-definition.js';
import { accountOpeningHours } from '../services/account-opening-hours.js';
import { commonVarKeysInContent } from '../services/common-var-snapshot.js';

/** 送信開始前の下書きだけ、承認を取り消して固定版を変更する。 */
export async function putBroadcastCommonVarPin(c: Context<Env, '/api/broadcasts/:id/common-var-pins/:varId'>) {
  const existing = await getBroadcastById(c.env.DB, c.req.param('id'));
  if (!existing || !await canAccessBroadcast(c.env.DB, c.get('staff'), existing)) {
    return c.json({ success: false, error: 'Not found' }, 404);
  }
  if (existing.hq_run_id) return c.json({ success: false, error: '統括の配信画面で操作してください' }, 403);
  if (await simulationContext(c.env.DB, existing.id)) return c.json({ success: false, error: 'use_simulation_draft_endpoint' }, 409);
  const boundary = await broadcastWriteBoundary(c, broadcastAccountIds(existing), { operationKey: BROADCAST_DEFINITION_EDIT_KEY });
  if (!boundary.allowed) return c.json({ success: false, error: '操作する権限がありません' }, 403);
  const body = validatedInputBody(c);
  if (!body || typeof body.accountId !== 'string' || !body.accountId.trim()
      || typeof body.versionId !== 'string' || !body.versionId.trim()
      || typeof body.expectedVersion !== 'number' || !Number.isInteger(body.expectedVersion) || body.expectedVersion < 1) {
    return c.json({ success: false, error: 'アカウント、版と配信の更新番号を指定してください' }, 400);
  }
  if (body.expectedVersion !== (existing.lock_version ?? 1)) {
    return c.json({ success: false, code: 'VERSION_CONFLICT', error: '配信が更新されました。読み直してください' }, 409);
  }
  const variable = await c.env.DB.prepare('SELECT var_key FROM common_vars WHERE id = ? AND line_account_id = ? AND archived_at IS NULL')
    .bind(c.req.param('varId'), body.accountId.trim()).first<{ var_key: string }>();
  const content = `${existing.message_content ?? ''}\n${existing.message_bubbles_json ?? ''}`;
  if (!variable || !commonVarKeysInContent(content).includes(variable.var_key)) {
    return c.json({ success: false, error: '使用先または版を確認できません' }, 409);
  }
  if (variable.var_key === 'business_hours' && (await accountOpeningHours(c.env.DB, body.accountId.trim())).source !== 'manual') {
    return c.json({ success: false, code: 'GOOGLE_VALUE_LIVE_ONLY', error: 'Google と連携した値は、いつも最新を使います' }, 409);
  }
  const results = await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO broadcast_common_var_pins (broadcast_id, common_var_id, version_id)
      SELECT b.id, cv.id, v.id FROM broadcasts b
      JOIN common_vars cv ON cv.id = ? AND cv.line_account_id = ? AND cv.archived_at IS NULL
      JOIN common_var_versions v ON v.id = ? AND v.common_var_id = cv.id
      WHERE b.id = ? AND b.status = 'draft' AND b.common_var_snapshot IS NULL AND b.lock_version = ?
        AND (cv.var_key <> 'business_hours' OR NOT EXISTS (
          SELECT 1 FROM rt_stores s JOIN rt_google_connections c ON c.store_id = s.id
          WHERE s.line_account_id = cv.line_account_id AND c.status IS NOT NULL
            AND s.id = (SELECT s2.id FROM rt_stores s2 WHERE s2.line_account_id = cv.line_account_id ORDER BY s2.id LIMIT 1)
        ))
        AND ((b.target_type <> 'multi-account-dedup' AND b.line_account_id = ?) OR (b.target_type = 'multi-account-dedup' AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(b.account_ids) THEN b.account_ids ELSE '[]' END) WHERE value = ?)))
      ON CONFLICT(broadcast_id, common_var_id) DO UPDATE SET version_id = excluded.version_id`)
      .bind(c.req.param('varId'), body.accountId.trim(), body.versionId.trim(), existing.id, body.expectedVersion, body.accountId.trim(), body.accountId.trim()),
    c.env.DB.prepare(`UPDATE broadcasts SET lock_version = lock_version + 1,
      approval_status = CASE WHEN approval_status IN ('pending','approved') THEN 'none' ELSE approval_status END,
      approval_decided_by_staff_id = NULL, approval_decided_at = NULL,
      approval_reject_reason = NULL, approval_confirmed_count = NULL
      WHERE id = ? AND changes() > 0`).bind(existing.id),
  ]);
  if (!results[0].meta.changes) {
    const current = await getBroadcastById(c.env.DB, existing.id);
    if (current && current.lock_version !== body.expectedVersion) return c.json({ success: false, code: 'VERSION_CONFLICT', error: '配信が更新されました。読み直してください' }, 409);
    return c.json({ success: false, error: '使用先または版を確認できません' }, 409);
  }
  return c.json({ success: true, data: { versionId: body.versionId.trim(), version: body.expectedVersion + 1 } });
}
