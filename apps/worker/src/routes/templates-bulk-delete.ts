import type { Context } from 'hono';
import type { Env } from '../worker-env.js';
import { canAccessAllLineAccounts } from '../services/account-access.js';
import { assertChanged, clearAssertions } from '../features/booking/booking-series/index.js';

export async function bulkDeleteTemplates(c: Context<Env>) {
  const body = await c.req.json<{ templates: Array<{ id: string; expectedRevision: number }> }>().catch(() => null);
  if (!body || !Array.isArray(body.templates) || body.templates.length < 1 || body.templates.length > 50
    || body.templates.some(t => !t || typeof t.id !== 'string' || !t.id || !Number.isSafeInteger(t.expectedRevision) || t.expectedRevision < 1)
    || new Set(body.templates.map(t => t.id)).size !== body.templates.length) return c.json({ success: false, error: '削除するテンプレートを確認してください' }, 400);
  const db = c.env.DB;
  const rows = await Promise.all(body.templates.map(t => db.prepare('SELECT id,line_account_id,confirmation_revision,deleted_at FROM templates WHERE id=?').bind(t.id).first<{ id: string; line_account_id: string | null; confirmation_revision: number; deleted_at: string | null }>()));
  if (rows.some(row => !row) || !await canAccessAllLineAccounts(db, c.get('staff'), rows.map(row => row!.line_account_id))) return c.json({ success: false, error: 'Not found' }, 404);
  const steps: D1PreparedStatement[] = [];
  const now = new Date().toISOString();
  for (const item of body.templates) {
    steps.push(db.prepare(`UPDATE templates SET deleted_at=?,updated_at=?,confirmation_revision=confirmation_revision+1
      WHERE id=? AND deleted_at IS NULL AND confirmation_revision=?
      AND NOT EXISTS(SELECT 1 FROM auto_replies a WHERE a.template_id=templates.id AND a.deleted_at IS NULL AND (templates.line_account_id IS NULL OR a.line_account_id IS NULL OR a.line_account_id=templates.line_account_id))
      AND NOT EXISTS(SELECT 1 FROM automations a,json_each(CASE WHEN json_valid(a.actions) THEN a.actions ELSE '[]' END) j WHERE (templates.line_account_id IS NULL OR a.line_account_id IS NULL OR a.line_account_id=templates.line_account_id) AND j.type='object' AND COALESCE(json_extract(CASE WHEN j.type='object' THEN j.value ELSE '{}' END,'$.params.template_id'),json_extract(CASE WHEN j.type='object' THEN j.value ELSE '{}' END,'$.params.templateId'))=templates.id)
      AND NOT EXISTS(SELECT 1 FROM scenario_steps x JOIN scenarios s ON s.id=x.scenario_id WHERE x.template_id=templates.id AND (templates.line_account_id IS NULL OR s.line_account_id IS NULL OR s.line_account_id=templates.line_account_id))
      AND NOT EXISTS(SELECT 1 FROM reminder_steps x JOIN reminders r ON r.id=x.reminder_id WHERE x.template_id=templates.id AND (templates.line_account_id IS NULL OR r.line_account_id IS NULL OR r.line_account_id=templates.line_account_id))
      AND NOT EXISTS(SELECT 1 FROM rich_menu_areas a JOIN rich_menu_pages p ON p.id=a.page_id JOIN rich_menu_groups g ON g.id=p.group_id WHERE a.template_id=templates.id AND (templates.line_account_id IS NULL OR g.account_id IS NULL OR g.account_id=templates.line_account_id))
      AND NOT EXISTS(SELECT 1 FROM tracked_links l WHERE l.template_id=templates.id AND (templates.line_account_id IS NULL OR l.line_account_id IS NULL OR l.line_account_id=templates.line_account_id))
      AND NOT EXISTS(SELECT 1 FROM template_references x JOIN broadcasts b ON b.id=x.consumer_id WHERE x.template_id=templates.id AND x.consumer_kind='broadcast' AND b.status IN ('scheduled','sending'))
      AND NOT EXISTS(SELECT 1 FROM friend_reminders f JOIN reminders r ON r.id=f.reminder_id JOIN reminder_version_steps v ON v.reminder_version_id=f.reminder_version_id WHERE v.template_id=templates.id AND f.status IN ('active','cancelled') AND (templates.line_account_id IS NULL OR r.line_account_id IS NULL OR r.line_account_id=templates.line_account_id))`)
      .bind(now,now,item.id,item.expectedRevision), assertChanged(db), db.prepare("DELETE FROM media_usages WHERE ref_kind='template' AND ref_id=?").bind(item.id));
  }
  steps.push(clearAssertions(db));
  try { await db.batch(steps); }
  catch (error) {
    if (!/CHECK constraint/i.test(String(error))) throw error;
    const current = await Promise.all(body.templates.map(async t => {
      const row = await db.prepare('SELECT id,deleted_at,confirmation_revision FROM templates WHERE id=?').bind(t.id).first();
      return row;
    }));
    return c.json({ success: false, code: 'version_conflict', error: '状態または使用先が変わりました。読み直してください', current }, 409);
  }
  return c.json({ success: true, data: null });
}
