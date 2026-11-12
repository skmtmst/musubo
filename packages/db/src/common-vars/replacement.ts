import { jstNow } from '../utils.js';
import { type ReplacementSource, type CommonVarReplacementPlan, type CommonVarReplacementTarget } from './types.js';
import { type CommonVar } from './record-types.js';
import { getCommonVarUsageImpact, CommonVarReasonRequiredError, CommonVarVersionConflictError } from './definitions.js';


export const COMMON_VAR_REPLACEMENT_SOURCES: ReplacementSource[] = [
  { table: 'templates', kind: 'template', columns: ['message_content', 'question_json', 'carousel_actions_json'], sql: `SELECT id, message_content, question_json, carousel_actions_json FROM templates WHERE line_account_id = ?` },
  { table: 'broadcasts', kind: 'broadcast', columns: ['message_content', 'message_bubbles_json'], sql: `SELECT id, message_content, message_bubbles_json FROM broadcasts WHERE status != 'sent' AND (line_account_id = ? OR EXISTS (SELECT 1 FROM json_each(coalesce(account_ids, '[]')) WHERE value = ?))` },
  { table: 'scenario_steps', kind: 'scenario', columns: ['message_content', 'message_bubbles_json', 'question_json'], sql: `SELECT ss.id, ss.message_content, ss.message_bubbles_json, ss.question_json FROM scenario_steps ss JOIN scenarios s ON s.id = ss.scenario_id WHERE s.line_account_id = ?` },
  { table: 'scenario_actions', kind: 'scenario', columns: ['config_json'], sql: `SELECT sa.id, sa.config_json FROM scenario_actions sa JOIN scenarios s ON s.id = sa.scenario_id WHERE s.line_account_id = ? AND sa.action_type = 'common_var'` },
  { table: 'reminder_steps', kind: 'reminder', columns: ['message_content'], sql: `SELECT rs.id, rs.message_content FROM reminder_steps rs JOIN reminders r ON r.id = rs.reminder_id WHERE r.line_account_id = ?` },
  { table: 'auto_replies', kind: 'auto_reply', columns: ['response_content', 'actions_json'], sql: `SELECT id, response_content, actions_json FROM auto_replies WHERE line_account_id = ? AND deleted_at IS NULL` },
  { table: 'forms', kind: 'form', columns: ['on_submit_message_content', 'fields', 'layout'], sql: `SELECT DISTINCT f.id, f.on_submit_message_content, f.fields, f.layout, pv.on_submit_message_content AS published_on_submit_message_content, pv.fields AS published_fields, pv.layout AS published_layout FROM forms f JOIN form_accounts fa ON fa.form_id = f.id LEFT JOIN form_versions pv ON pv.id = f.current_published_version_id WHERE fa.line_account_id = ?` },
  { table: 'automations', kind: 'automation', columns: ['conditions', 'actions'], sql: `SELECT id, conditions, actions FROM automations WHERE line_account_id = ?` },
  { table: 'automation_versions', kind: 'automation', columns: ['trigger_config', 'condition_config', 'action_config'], sql: `SELECT v.id, v.trigger_config, v.condition_config, v.action_config FROM automation_versions v JOIN automation_definitions d ON d.id = v.automation_id WHERE d.line_account_id = ? AND v.id IN (d.current_draft_version_id, d.current_published_version_id)` },
  { table: 'account_settings', kind: 'friend_add', columns: ['value'], sql: `SELECT id, value FROM account_settings WHERE line_account_id = ? AND key = 'friend_add_routing'` },
  { table: 'common_action_versions', kind: 'common_action', columns: ['action_config'], sql: `SELECT v.id, v.action_config FROM common_action_versions v JOIN common_actions a ON a.id = v.common_action_id WHERE a.line_account_id = ? AND v.id IN (a.current_draft_version_id, a.current_published_version_id)` },
];

export function replaceStructuredCommonVar(value: unknown, sourceKey: string, replacementKey: string): boolean {
  let changed = false;
  if (Array.isArray(value)) {
    for (const item of value) changed = replaceStructuredCommonVar(item, sourceKey, replacementKey) || changed;
    return changed;
  }
  if (!value || typeof value !== 'object') return false;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'varKey' && item === sourceKey) {
      (value as Record<string, unknown>)[key] = replacementKey;
      changed = true;
    } else {
      changed = replaceStructuredCommonVar(item, sourceKey, replacementKey) || changed;
    }
  }
  return changed;
}

export function replaceCommonVarText(text: string, sourceKey: string, replacementKey: string): string | null {
  const sourceToken = `{{var.${sourceKey}}}`;
  const replacementToken = `{{var.${replacementKey}}}`;
  let next = text.replaceAll(sourceToken, replacementToken);
  let structuredChanged = false;
  try {
    const parsed = JSON.parse(next) as unknown;
    structuredChanged = replaceStructuredCommonVar(parsed, sourceKey, replacementKey);
    if (structuredChanged) next = JSON.stringify(parsed);
  } catch {
    // 通常本文はJSONではない。厳密な従来トークンだけを置換する。
  }
  return next !== text || structuredChanged ? next : null;
}

export function replacementQueryValues(source: ReplacementSource, accountId: string): string[] {
  return source.table === 'broadcasts' ? [accountId, accountId] : [accountId];
}

export async function getCommonVarReplacementCandidates(
  db: D1Database,
  source: CommonVar,
): Promise<CommonVar[]> {
  const result = await db.prepare(
    `SELECT * FROM common_vars
      WHERE line_account_id = ? AND id != ? AND type = ? AND archived_at IS NULL
      ORDER BY name ASC, id ASC`,
  ).bind(source.line_account_id, source.id, source.type).all<CommonVar>();
  return result.results;
}

export async function getCommonVarReplacementPlan(
  db: D1Database,
  source: CommonVar,
  replacement: CommonVar,
): Promise<CommonVarReplacementPlan> {
  if (!source.line_account_id || source.line_account_id !== replacement.line_account_id
    || source.type !== replacement.type || source.id === replacement.id) {
    throw new Error('Incompatible common variable replacement');
  }
  const targets: CommonVarReplacementTarget[] = [];
  for (const descriptor of COMMON_VAR_REPLACEMENT_SOURCES) {
    const result = await db.prepare(descriptor.sql)
      .bind(...replacementQueryValues(descriptor, source.line_account_id))
      .all<Record<string, string | null>>();
    for (const row of result.results) {
      if (descriptor.table === 'forms' && [
        row.published_on_submit_message_content,
        row.published_fields,
        row.published_layout,
      ].some((value) => typeof value === 'string'
        && replaceCommonVarText(value, source.var_key, replacement.var_key) !== null)) {
        // 現在の公開版は不変。下書きだけ差し替えて元変数を消すと公開URLが壊れる。
        continue;
      }
      const columns: Record<string, string> = {};
      const originalColumns: Record<string, string> = {};
      const before: string[] = [];
      for (const column of descriptor.columns) {
        const current = row[column];
        if (typeof current !== 'string') continue;
        const next = replaceCommonVarText(current, source.var_key, replacement.var_key);
        if (next !== null) {
          columns[column] = next;
          originalColumns[column] = current;
          before.push(`${column}:${current}`);
        }
      }
      if (Object.keys(columns).length > 0) {
        targets.push({
          table: descriptor.table,
          id: String(row.id),
          kind: descriptor.kind,
          columns,
          originalColumns,
          fingerprint: before.join('\n'),
        });
      }
    }
  }
  const impact = await getCommonVarUsageImpact(db, source.var_key, source.line_account_id);
  const blockedTotal = Math.max(0, impact.blockingTotal - targets.length);
  return {
    source,
    replacement,
    targets,
    usageTotal: impact.total,
    replaceableTotal: targets.length,
    blockedTotal,
    historicalTotal: impact.historicalTotal,
    unscopedFormTotal: impact.unscopedFormTotal,
  };
}

export async function applyCommonVarReplacementPlan(
  db: D1Database,
  plan: CommonVarReplacementPlan,
  actorId: string | null,
  changeReason: string,
): Promise<{ runId: string; replacedUsageCount: number; archivedVersion: number }> {
  const reason = changeReason.trim();
  if (!reason) throw new CommonVarReasonRequiredError();
  if (!plan.source.line_account_id || plan.blockedTotal > 0) {
    throw new Error('Common variable replacement is blocked');
  }
  const now = jstNow();
  const runId = crypto.randomUUID();
  const archivedVersion = plan.source.version + 1;
  const assertions = plan.targets.map((target) => {
    const originals = Object.entries(target.originalColumns);
    return db.prepare(
      `SELECT CASE WHEN EXISTS (
         SELECT 1 FROM ${target.table}
          WHERE id = ? AND ${originals.map(([column]) => `${column} IS ?`).join(' AND ')}
       ) THEN 1 ELSE json('') END AS unchanged`,
    ).bind(target.id, ...originals.map(([, value]) => value));
  });
  const updates = plan.targets.map((target) => {
    const entries = Object.entries(target.columns);
    const originals = Object.entries(target.originalColumns);
    const revision = target.table === 'templates' || target.table === 'auto_replies'
      ? ', confirmation_revision = confirmation_revision + 1'
      : target.table === 'account_settings'
        ? ", confirmation_revision = confirmation_revision + CASE WHEN key = 'test_recipients' THEN 1 ELSE 0 END"
        : '';
    return db.prepare(
      `UPDATE ${target.table}
          SET ${entries.map(([column]) => `${column} = ?`).join(', ')}${revision}
        WHERE id = ? AND ${originals.map(([column]) => `${column} IS ?`).join(' AND ')}
          AND EXISTS (
          SELECT 1 FROM common_vars
           WHERE id = ? AND replacement_run_id = ? AND version = ?
        )`,
    ).bind(
      ...entries.map(([, value]) => value), target.id,
      ...originals.map(([, value]) => value),
      plan.source.id, runId, archivedVersion,
    );
  });
  const results = await db.batch([
    ...assertions,
    db.prepare(
      `UPDATE common_vars
          SET archived_at = ?, replacement_run_id = ?, version = ?, updated_by = ?, updated_at = ?
        WHERE id = ? AND line_account_id = ? AND version = ? AND archived_at IS NULL`,
    ).bind(
      now, runId, archivedVersion, actorId, now, plan.source.id,
      plan.source.line_account_id, plan.source.version,
    ),
    ...updates,
    ...plan.targets.filter(target => target.table === 'scenario_steps' || target.table === 'scenario_actions').map(target =>
      db.prepare(`UPDATE scenarios SET content_revision=content_revision+1
        WHERE id=(SELECT scenario_id FROM ${target.table} WHERE id=?) AND EXISTS (
          SELECT 1 FROM common_vars WHERE id=? AND replacement_run_id=? AND version=?
        )`).bind(target.id, plan.source.id, runId, archivedVersion)),
    db.prepare(
      `INSERT INTO common_var_versions
         (id, common_var_id, version_no, name, value, memo, change_reason, actor_id, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM common_vars
           WHERE id = ? AND replacement_run_id = ? AND version = ?
        )`,
    ).bind(
      crypto.randomUUID(), plan.source.id, archivedVersion, plan.source.name,
      plan.source.value, plan.source.memo, `${reason}（「${plan.replacement.name}」へ差し替えてアーカイブ）`,
      actorId, now, plan.source.id, runId, archivedVersion,
    ),
    db.prepare(
      `INSERT INTO common_var_replacement_runs
         (id, line_account_id, source_common_var_id, replacement_common_var_id,
          source_version, expected_usage_count, replaced_usage_count, actor_id, status, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?
        WHERE EXISTS (
          SELECT 1 FROM common_vars
           WHERE id = ? AND replacement_run_id = ? AND version = ?
        )`,
    ).bind(
      runId, plan.source.line_account_id, plan.source.id, plan.replacement.id,
      plan.source.version, plan.replaceableTotal, plan.replaceableTotal, actorId, now,
      plan.source.id, runId, archivedVersion,
    ),
  ]);
  const archiveResult = results[assertions.length];
  if (Number(archiveResult?.meta.changes ?? 0) === 0) {
    throw new CommonVarVersionConflictError(plan.source.version);
  }
  return { runId, replacedUsageCount: plan.replaceableTotal, archivedVersion };
}
