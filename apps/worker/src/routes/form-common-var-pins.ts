import type { Context } from 'hono';
import { getFormAccountIds } from '@line-crm/db';
import type { Env } from '../worker-env.js';
import { validatedInputBody } from '../lib/input-errors.js';
import { accountOpeningHours } from '../services/account-opening-hours.js';
import { commonVarKeysInContent } from '../services/common-var-snapshot.js';
import { canUseFormFromAccount, requireFormManage } from './forms-definition.js';

/** 公開済みのフォームは変えず、次に公開する版の参照だけを変更する。 */
export async function putFormCommonVarPin(c: Context<Env, '/api/forms/:id/common-var-pins/:varId'>) {
  const formId = c.req.param('id');
  const gate = await requireFormManage(c, await getFormAccountIds(c.env.DB, formId));
  if (gate) return gate;
  const body = validatedInputBody(c);
  if (!body || typeof body.accountId !== 'string' || !body.accountId.trim()
    || !(body.versionId === null || (typeof body.versionId === 'string' && body.versionId.trim()))
    || typeof body.expectedVersion !== 'number' || !Number.isInteger(body.expectedVersion) || body.expectedVersion < 1) {
    return c.json({ success: false, error: 'アカウント、版と更新番号を指定してください' }, 400);
  }
  const accountId = body.accountId.trim();
  if (!await canUseFormFromAccount(c, formId, accountId)) return c.json({ success: false, error: 'フォームが見つかりません' }, 404);
  const varId = c.req.param('varId');
  const row = await c.env.DB.prepare(`SELECT f.content_revision, f.fields, f.layout, f.on_submit_message_content, cv.var_key
    FROM forms f JOIN form_accounts fa ON fa.form_id=f.id AND fa.line_account_id=?
    JOIN common_vars cv ON cv.id=? AND cv.line_account_id=fa.line_account_id AND cv.archived_at IS NULL
    WHERE f.id=? AND f.status='active'`).bind(accountId, varId, formId)
    .first<{ content_revision: number; fields: string | null; layout: string | null; on_submit_message_content: string | null; var_key: string }>();
  if (!row) return c.json({ success: false, error: '使用先を確認できません' }, 404);
  if (row.content_revision !== body.expectedVersion) return c.json({ success: false, code: 'VERSION_CONFLICT', error: 'フォームが更新されました。読み直してください' }, 409);
  const direct = commonVarKeysInContent(`${row.fields ?? ''}\n${row.layout ?? ''}\n${row.on_submit_message_content ?? ''}`).includes(row.var_key);
  const inReference = await c.env.DB.prepare(`SELECT 1 FROM json_tree(CASE WHEN json_valid(?) THEN ? ELSE '{}' END, '$.references')
    WHERE key='varKey' AND value=? LIMIT 1`).bind(row.layout ?? '', row.layout ?? '', row.var_key).first();
  if (!direct && !inReference) return c.json({ success: false, error: '使用先または版を確認できません' }, 409);
  const remove = body.versionId === null;
  if (!remove && row.var_key === 'business_hours' && (await accountOpeningHours(c.env.DB, accountId)).source !== 'manual') {
    return c.json({ success: false, code: 'GOOGLE_VALUE_LIVE_ONLY', error: 'Google と連携した値は、いつも最新を使います' }, 409);
  }
  const guard = `EXISTS (SELECT 1 FROM forms f JOIN form_accounts fa ON fa.form_id=f.id AND fa.line_account_id=?
    JOIN common_vars cv ON cv.id=? AND cv.line_account_id=fa.line_account_id AND cv.archived_at IS NULL
    WHERE f.id=? AND f.status='active' AND f.content_revision=?)`;
  const write = remove
    ? c.env.DB.prepare(`DELETE FROM form_common_var_pins WHERE form_id=? AND common_var_id=? AND ${guard}`)
      .bind(formId, varId, accountId, varId, formId, body.expectedVersion)
    : c.env.DB.prepare(`INSERT INTO form_common_var_pins(form_id,common_var_id,version_id)
      SELECT ?,cv.id,v.id FROM common_vars cv JOIN common_var_versions v ON v.common_var_id=cv.id AND v.id=?
      WHERE cv.id=? AND cv.line_account_id=? AND cv.archived_at IS NULL AND ${guard}
      AND (cv.var_key <> 'business_hours' OR NOT EXISTS (
        SELECT 1 FROM rt_stores s JOIN rt_google_connections c ON c.store_id=s.id
        WHERE s.line_account_id=cv.line_account_id AND c.status IS NOT NULL
        AND s.id=(SELECT s2.id FROM rt_stores s2 WHERE s2.line_account_id=cv.line_account_id ORDER BY s2.id LIMIT 1)))
      ON CONFLICT(form_id,common_var_id) DO UPDATE SET version_id=excluded.version_id`)
      .bind(formId, String(body.versionId).trim(), varId, accountId, accountId, varId, formId, body.expectedVersion);
  const result = await c.env.DB.batch([write, c.env.DB.prepare(`UPDATE forms SET revision=revision+1,content_revision=content_revision+1 WHERE id=? AND changes()>0`).bind(formId)]);
  if (!result[0].meta.changes) {
    const current = await c.env.DB.prepare('SELECT content_revision FROM forms WHERE id=?').bind(formId).first<{ content_revision: number }>();
    if (current && current.content_revision !== body.expectedVersion) return c.json({ success: false, code: 'VERSION_CONFLICT', error: 'フォームが更新されました。読み直してください' }, 409);
    return c.json({ success: false, error: '使用先または版を確認できません' }, 409);
  }
  return c.json({ success: true, data: { versionId: body.versionId, version: body.expectedVersion + 1 } });
}
