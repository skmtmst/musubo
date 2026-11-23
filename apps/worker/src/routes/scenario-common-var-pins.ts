import type { Context } from 'hono';
import type { Env } from '../worker-env.js';
import { validatedInputBody } from '../lib/input-errors.js';
import { accountOpeningHours } from '../services/account-opening-hours.js';
import { commonVarKeysInContent } from '../services/common-var-snapshot.js';

/** 下書きの通だけを変更し、公開済みの版には触れない。 */
export async function putScenarioCommonVarPin(c: Context<Env, '/api/scenarios/:id/steps/:stepId/common-var-pins/:varId'>) {
  const body = validatedInputBody(c);
  if (!body || typeof body.accountId !== 'string' || !body.accountId.trim()
    || !(body.versionId === null || (typeof body.versionId === 'string' && body.versionId.trim()))
    || typeof body.expectedVersion !== 'number' || !Number.isInteger(body.expectedVersion) || body.expectedVersion < 1) {
    return c.json({ success: false, error: 'アカウント、版と更新番号を指定してください' }, 400);
  }
  const scenarioId = c.req.param('id');
  const stepId = c.req.param('stepId');
  const varId = c.req.param('varId');
  const accountId = body.accountId.trim();
  const row = await c.env.DB.prepare(`SELECT s.content_revision, ss.message_content, ss.message_bubbles_json, ss.question_json,
    cv.var_key FROM scenarios s JOIN scenario_steps ss ON ss.scenario_id=s.id AND ss.id=?
    JOIN common_vars cv ON cv.id=? AND cv.line_account_id=s.line_account_id AND cv.archived_at IS NULL
    WHERE s.id=? AND s.line_account_id=?`).bind(stepId, varId, scenarioId, accountId)
    .first<{ content_revision: number; message_content: string; message_bubbles_json: string | null; question_json: string | null; var_key: string }>();
  if (!row) return c.json({ success: false, error: '使用先を確認できません' }, 404);
  if (row.content_revision !== body.expectedVersion) return c.json({ success: false, code: 'VERSION_CONFLICT', error: 'シナリオが更新されました。読み直してください' }, 409);
  if (!commonVarKeysInContent(`${row.message_content}\n${row.message_bubbles_json ?? ''}\n${row.question_json ?? ''}`).includes(row.var_key)) {
    return c.json({ success: false, error: '使用先または版を確認できません' }, 409);
  }
  const remove = body.versionId === null;
  if (!remove && row.var_key === 'business_hours' && (await accountOpeningHours(c.env.DB, accountId)).source !== 'manual') {
    return c.json({ success: false, code: 'GOOGLE_VALUE_LIVE_ONLY', error: 'Google と連携した値は、いつも最新を使います' }, 409);
  }
  const guard = `EXISTS (SELECT 1 FROM scenarios s JOIN scenario_steps ss ON ss.scenario_id=s.id AND ss.id=?
    JOIN common_vars cv ON cv.id=? AND cv.line_account_id=s.line_account_id AND cv.archived_at IS NULL
    WHERE s.id=? AND s.line_account_id=? AND s.content_revision=?)`;
  const write = remove
    ? c.env.DB.prepare(`DELETE FROM scenario_step_common_var_pins WHERE scenario_step_id=? AND common_var_id=? AND ${guard}`)
      .bind(stepId, varId, stepId, varId, scenarioId, accountId, body.expectedVersion)
    : c.env.DB.prepare(`INSERT INTO scenario_step_common_var_pins(scenario_step_id,common_var_id,version_id)
      SELECT ?,cv.id,v.id FROM common_vars cv JOIN common_var_versions v ON v.common_var_id=cv.id AND v.id=?
      WHERE cv.id=? AND cv.line_account_id=? AND cv.archived_at IS NULL AND ${guard}
      AND (cv.var_key <> 'business_hours' OR NOT EXISTS (
        SELECT 1 FROM rt_stores s JOIN rt_google_connections c ON c.store_id=s.id
        WHERE s.line_account_id=cv.line_account_id AND c.status IS NOT NULL
        AND s.id=(SELECT s2.id FROM rt_stores s2 WHERE s2.line_account_id=cv.line_account_id ORDER BY s2.id LIMIT 1)))
      ON CONFLICT(scenario_step_id,common_var_id) DO UPDATE SET version_id=excluded.version_id`)
      .bind(stepId, String(body.versionId).trim(), varId, accountId, stepId, varId, scenarioId, accountId, body.expectedVersion);
  const result = await c.env.DB.batch([write, c.env.DB.prepare(`UPDATE scenarios SET content_revision=content_revision+1 WHERE id=? AND changes()>0`).bind(scenarioId)]);
  if (!result[0].meta.changes) {
    const current = await c.env.DB.prepare('SELECT content_revision FROM scenarios WHERE id=?').bind(scenarioId).first<{ content_revision: number }>();
    if (current && current.content_revision !== body.expectedVersion) return c.json({ success: false, code: 'VERSION_CONFLICT', error: 'シナリオが更新されました。読み直してください' }, 409);
    return c.json({ success: false, error: '使用先または版を確認できません' }, 409);
  }
  return c.json({ success: true, data: { versionId: body.versionId, version: body.expectedVersion + 1 } });
}
