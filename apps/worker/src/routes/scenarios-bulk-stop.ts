import { jstNow } from '@line-crm/db';
import type { Context } from 'hono';
import type { Env } from '../worker-env.js';
import { getVisibleLineAccountScope } from '../services/account-access.js';
import { resolveRequestBoundary } from '../services/request-boundary.js';
import { scenarioSubscriptionScope } from './scenarios-definition.js';

type StopItem = { id: string; revision: number; activeCount: number; rowIdSum: number; rowIdSquareSum: number };
type ScenarioState = { id: string; line_account_id: string | null; content_revision: number; is_active: number };

/** 最大50件を1文で照合し、どれかが違えばbatch全体を戻す。 */
export async function bulkStopScenarios(c: Context<Env>) {
  const body = await c.req.json<{ items?: unknown }>().catch(() => null);
  const items = body?.items;
  if (!Array.isArray(items) || items.length < 1 || items.length > 50 || items.some(item =>
    !item || typeof item.id !== 'string' || !item.id || !Number.isSafeInteger(item.revision) || item.revision < 1 || ['activeCount', 'rowIdSum', 'rowIdSquareSum'].some(key => !Number.isSafeInteger(item[key]) || item[key] < 0)
  ) || new Set(items.map(item => item.id)).size !== items.length) {
    return c.json({ success: false, error: '停止するシナリオと版を50件以内で指定してください' }, 400);
  }
  const targets = items as StopItem[];
  const db = c.env.DB;
  const ids = JSON.stringify(targets.map(item => item.id));
  const states = async () => (await db.prepare(
    'SELECT id,line_account_id,content_revision,is_active FROM scenarios WHERE id IN (SELECT value FROM json_each(?))',
  ).bind(ids).all<ScenarioState>()).results;
  const visibleRows = async (rows: ScenarioState[]) => {
    const scope = await getVisibleLineAccountScope(db, c.get('staff'));
    const accounts = new Set(scope.allowedAccountIds);
    return rows.filter(row => row.line_account_id === null ? scope.canSeeUnassigned : accounts.has(row.line_account_id));
  };
  const initial = await states();
  if ((await visibleRows(initial)).length !== targets.length || initial.length !== targets.length) {
    return c.json({ success: false, error: 'シナリオが見つかりません' }, 404);
  }
  for (const row of initial) {
    const staff = c.get('staff');
    const decision = await resolveRequestBoundary(db, staff, row.line_account_id, staff?.role === 'owner' || staff?.role === 'admin' ? {} : { requiredPermissionKey: 'scenario.definition.edit' });
    if (!decision.allowed) return c.json({ success: false, error: 'この機能を操作する権限がありません' }, decision.reason === 'forbidden' ? 403 : 404);
    if (!await scenarioSubscriptionScope(c, row.id)) return c.json({ success: false, error: '関連する対象を確認できないため操作できません' }, 403);
  }
  const conflict = async () => {
    const rows = await states();
    const visible = await visibleRows(rows);
    return c.json({ success: false, error: 'シナリオの状態が変わりました。読み直してください', current: visible.map(row => ({ id: row.id, contentRevision: row.content_revision, isActive: !!row.is_active })) }, 409);
  };
  const confirmedTargets = targets.map(item => ({ ...item, accountId: initial.find(row => row.id === item.id)!.line_account_id }));
  const scope = await getVisibleLineAccountScope(db, c.get('staff'));
  const now = jstNow();
  try {
    await db.batch([
      db.prepare(`UPDATE scenarios SET is_active=0,content_revision=content_revision+1,
        stopped_reason=NULL,stopped_by=?,stopped_at=?,updated_at=?
        WHERE id IN (SELECT json_extract(value,'$.id') FROM json_each(?)) AND is_active=1
          AND EXISTS (SELECT 1 FROM json_each(?) item WHERE json_extract(item.value,'$.id')=scenarios.id
            AND json_extract(item.value,'$.revision')=scenarios.content_revision
            AND json_extract(item.value,'$.accountId') IS scenarios.line_account_id
            AND json_extract(item.value,'$.activeCount')=(SELECT COUNT(*) FROM friend_scenarios fs WHERE fs.scenario_id=scenarios.id AND fs.status IN ('active','delivering'))
            AND json_extract(item.value,'$.rowIdSum')=(SELECT COALESCE(SUM(fs.rowid),0) FROM friend_scenarios fs WHERE fs.scenario_id=scenarios.id AND fs.status IN ('active','delivering'))
            AND json_extract(item.value,'$.rowIdSquareSum')=(SELECT COALESCE(SUM((fs.rowid % 104729)*(fs.rowid % 104729)),0) FROM friend_scenarios fs WHERE fs.scenario_id=scenarios.id AND fs.status IN ('active','delivering')))
          AND NOT EXISTS (SELECT 1 FROM friend_scenarios fs LEFT JOIN friends f ON f.id=fs.friend_id WHERE fs.scenario_id=scenarios.id AND (f.id IS NULL OR (f.line_account_id IS NULL AND ?=0) OR (f.line_account_id IS NOT NULL AND f.line_account_id NOT IN (SELECT value FROM json_each(?)))))`)
        .bind(c.get('staff')!.id, now, now, JSON.stringify(confirmedTargets), JSON.stringify(confirmedTargets), scope.canSeeUnassigned ? 1 : 0, JSON.stringify(scope.allowedAccountIds)),
      db.prepare("SELECT json(CASE WHEN changes()=? THEN '{}' ELSE 'SCENARIO_STOP_CONFLICT' END)").bind(targets.length),
    ]);
  } catch (error) {
    if (/malformed JSON/i.test(String(error))) return conflict();
    throw error;
  }
  return c.json({ success: true, data: { stopped: targets.length } });
}
