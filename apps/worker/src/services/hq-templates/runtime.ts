import { captureDistributionName } from './distribution-display.js';
import { beginHqTemplateDistributionRun, beginHqTemplateStoreResult, normalizeScopedTagName, type HqTemplateDistributionResult, type HqTemplatePreflight, type HqTemplatePreflightResolution, type HqTemplateStatement } from '@line-crm/db';

import { requireHqTemplateAuthority, type HqTemplateAdapterContext, type HqTemplateAdapterInput, type HqTemplateAdapterResult, type HqTemplateAuthority, type HqTemplateStoreAtomicCommitPlan } from './contract.js';
import { createFormHqTemplateAdapter, type FormReference, type FormTemplateDependencies } from './form.js';
import { bindScenarioGraphRevision, loadScenarioReferenceGraph, readScenarioGraphRevision, remapScenarioJson, scenarioGraphSnapshotToken, scenarioGraphSourceGuardStatements, ScenarioGraphError, type ScenarioGraphReference, type ScenarioGraphRow } from './scenario-graph.js';

export class HqRuntimeError extends Error {
  constructor(public readonly code: string) { super(code); }
}
const fail = (code: string): never => { throw new HqRuntimeError(code); };
const guard = (condition: string, bindings: HqTemplateStatement['bindings']): HqTemplateStatement => ({ sql: `SELECT json(CASE WHEN (${condition}) THEN '{}' ELSE 'HQ_RUNTIME_CONFLICT' END)`, bindings });
const hash = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), n => n.toString(16).padStart(2, '0')).join('');
const ok = <T>(r: HqTemplateAdapterResult<T>): T => r.kind === 'OK' ? r.value : fail('UNSUPPORTED');

type DbRow = ScenarioGraphRow;
type PortableTable = 'scenarios' | 'scenario_steps' | 'scenario_actions' | 'scenario_triggers' | 'templates';
function insertRow(table: PortableTable, row: DbRow): HqTemplateStatement {
  const columns = Object.keys(row);
  return { sql: `INSERT INTO ${table}(${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`, bindings: columns.map(column => row[column]) };
}
function updateScenarioRow(row: DbRow, id: string, accountId: string): HqTemplateStatement {
  const columns = Object.keys(row).filter(column => !['id', 'line_account_id', 'created_at', 'updated_at'].includes(column));
  return { sql: `UPDATE scenarios SET content_revision = content_revision + 1, ${columns.map(column => `${column}=?`).join(',')},updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND line_account_id=?`, bindings: [...columns.map(column => row[column]), id, accountId] };
}
const formReferenceKey = (kind: string, sourceId: string) => `${kind}:${sourceId}`;
function formReferenceSelection(reference: { kind: string; sourceId: string }, context: HqTemplateAdapterContext) {
  const sourceId = formReferenceKey(reference.kind, reference.sourceId);
  const matches = context.resolutions.filter(row => row.sourceId === sourceId && row.itemKind === reference.kind);
  if (matches.length !== 1) fail('SELECTION_REQUIRED');
  return matches[0];
}
function nextAliasName(name: string, existing: readonly string[]): string {
  const normalized = new Set(existing.map(normalizeScopedTagName));
  for (let suffix = 2; suffix < 10000; suffix++) {
    const candidate = `${name} (${suffix})`;
    if (!normalized.has(normalizeScopedTagName(candidate))) return candidate;
  }
  return fail('SELECTION_REQUIRED');
}

/** 店舗範囲の計画だけを作り、参照作成はすべてフォームの batch で行う。 */
export function createFormReferenceResolver({ db, authority }: { db: D1Database; authority: HqTemplateAuthority }): FormTemplateDependencies['resolveReference'] {
  const resolved = new Map<string, { targetId: string; aliasName?: string; planned?: boolean }>();
  const emitted = new Set<string>();
  const emitOnce = (keys: readonly string[], statements: HqTemplateStatement[]) => {
    const fresh = keys.filter(key => !emitted.has(key));
    if (!fresh.length) return [];
    fresh.forEach(key => emitted.add(key));
    return statements;
  };
  const targetAccount = async (context: HqTemplateAdapterContext) => {
    const target = await db.prepare(`SELECT id FROM line_accounts WHERE id=? AND tenant_id=? AND is_active=1 AND archived_at IS NULL`).bind(context.targetAccountId, authority.tenantId).first();
    if (!target) fail('FORBIDDEN');
  };
  const validateSelection = (reference: ScenarioGraphReference, context: HqTemplateAdapterContext, match: { id: string; updated_at: string | null; version?: number; draft_revision?: number; published_version?: number } | null, sourceGraphToken?: string) => {
    const selection = formReferenceSelection(reference, context);
    const targetRevision = !match ? null : reference.kind === 'tag'
      ? JSON.stringify([match.version, match.updated_at])
      : reference.kind === 'template'
        ? JSON.stringify([match.draft_revision, match.published_version, match.updated_at])
        : JSON.stringify([match.updated_at]);
    const expectedRevision = sourceGraphToken ? bindScenarioGraphRevision(targetRevision, sourceGraphToken) : targetRevision ?? undefined;
    if (sourceGraphToken && selection.expectedRevision !== expectedRevision) fail('VERSION_CONFLICT');
    const boundGraphRevision = reference.kind === 'scenario' ? readScenarioGraphRevision(selection.expectedRevision) : null;
    const selectedTargetRevision = boundGraphRevision ? boundGraphRevision.targetRevision ?? undefined : selection.expectedRevision;
    if (!match
      ? selection.mode !== 'create' || selection.targetId || selectedTargetRevision !== (targetRevision ?? undefined)
      : selection.mode === 'create' || selection.targetId !== match.id || selectedTargetRevision !== targetRevision) fail('SELECTION_REQUIRED');
    return selection;
  };
  const destination = async (reference: ScenarioGraphReference, name: string, context: HqTemplateAdapterContext) => {
    const table = reference.kind === 'tag' ? 'tags' : reference.kind === 'template' ? 'templates' : 'scenarios';
    const columns = reference.kind === 'tag' ? 'id,name,updated_at,version,status' : reference.kind === 'template' ? 'id,name,updated_at,draft_revision,published_version' : 'id,name,updated_at';
    const rows = (await db.prepare(`SELECT ${columns} FROM ${table} WHERE line_account_id=? ORDER BY id`).bind(context.targetAccountId).all<{ id: string; name: string; updated_at: string | null; version?: number; status?: string; draft_revision?: number; published_version?: number }>()).results;
    const matches = rows.filter(row => normalizeScopedTagName(row.name) === normalizeScopedTagName(name));
    if (matches.length > 1 || (reference.kind === 'tag' && matches.some(row => row.status !== 'active'))) fail('REFERENCE_UNAVAILABLE');
    return { rows, match: matches[0] ?? null };
  };
  const resolveTag = async (reference: FormReference, context: HqTemplateAdapterContext) => {
    const key = formReferenceKey(reference.kind, reference.sourceId), cached = resolved.get(key);
    if (cached) return { ...cached, dbCommit: [] };
    const source = await db.prepare(`SELECT t.id,t.name,t.color,t.description,t.version,t.updated_at,t.line_account_id FROM tags t JOIN line_accounts a ON a.id=t.line_account_id WHERE t.id=? AND t.status='active' AND a.tenant_id=? AND a.is_active=1 AND a.archived_at IS NULL`).bind(reference.sourceId, authority.tenantId).first<{ id: string; name: string; color: string; description: string | null; version: number; updated_at: string | null; line_account_id: string }>();
    if (!source) fail('REFERENCE_UNAVAILABLE');
    await targetAccount(context);
    const { rows, match } = await destination(reference, source!.name, context);
    const selection = validateSelection(reference, context, match);
    const sourceGuard = guard(`EXISTS(SELECT 1 FROM tags t JOIN line_accounts a ON a.id=t.line_account_id WHERE t.id=? AND t.line_account_id=? AND t.name=? AND t.color IS ? AND t.description IS ? AND t.version=? AND t.updated_at IS ? AND t.status='active' AND a.tenant_id=? AND a.is_active=1 AND a.archived_at IS NULL)`, [source!.id, source!.line_account_id, source!.name, source!.color, source!.description, source!.version, source!.updated_at, authority.tenantId]);
    if (match && source!.line_account_id === context.targetAccountId && match.id === reference.sourceId && selection.mode === 'overwrite') {
      resolved.set(key, { targetId: match.id });
      return { targetId: match.id, dbCommit: emitOnce([key], [sourceGuard]) };
    }
    if (match && selection.mode === 'overwrite') {
      resolved.set(key, { targetId: match.id });
      return { targetId: match.id, dbCommit: emitOnce([key], [sourceGuard, guard(`EXISTS(SELECT 1 FROM tags WHERE id=? AND line_account_id=? AND version=? AND updated_at IS ? AND status='active')`, [match.id, context.targetAccountId, match.version!, match.updated_at]), { sql: `UPDATE tags SET name=?,normalized_name=?,color=?,description=?,version=version+1,updated_by=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND line_account_id=?`, bindings: [source!.name, normalizeScopedTagName(source!.name), source!.color, source!.description, authority.actorId, match.id, context.targetAccountId] }]) };
    }
    const name = match ? nextAliasName(source!.name, rows.map(row => row.name)) : source!.name;
    const targetId = crypto.randomUUID();
    resolved.set(key, { targetId, aliasName: match ? name : undefined });
    return { targetId, aliasName: match ? name : undefined, dbCommit: emitOnce([key], [sourceGuard, { sql: `INSERT INTO tags(id,name,normalized_name,color,description,line_account_id,created_by,updated_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'))`, bindings: [targetId, name, normalizeScopedTagName(name), source!.color, source!.description, context.targetAccountId, authority.actorId, authority.actorId] }]) };
  };
  const resolveScenarioGraph = async (reference: FormReference, context: HqTemplateAdapterContext) => {
    const rootKey = formReferenceKey(reference.kind, reference.sourceId), cached = resolved.get(rootKey);
    await targetAccount(context);
    let graph;
    try { graph = await loadScenarioReferenceGraph(db, authority.tenantId, [reference.sourceId]); }
    catch (error) { if (error instanceof ScenarioGraphError) fail(error.code); throw error; }
    const sourceGraphToken = await scenarioGraphSnapshotToken(graph.snapshot);
    if (cached) {
      const root = graph.scenarios.get(reference.sourceId)?.row;
      if (!root) fail('REFERENCE_UNAVAILABLE');
      const { match } = await destination(reference, String(root!.name), context);
      validateSelection(reference, context, match, sourceGraphToken);
      return { ...cached, dbCommit: [] };
    }
    const statements: HqTemplateStatement[] = [], ids = new Map<string, string>(), names = new Map<string, string>(), modes = new Map<string, string>(), preResolved = new Set<string>();
    for (const ref of graph.references) {
      const resourceKey = formReferenceKey(ref.kind, ref.sourceId), existing = resolved.get(resourceKey);
      const source = ref.kind === 'tag' ? graph.tags.get(ref.sourceId) : ref.kind === 'template' ? graph.templates.get(ref.sourceId) : graph.scenarios.get(ref.sourceId)?.row;
      if (!source) fail('REFERENCE_UNAVAILABLE');
      const safeSource = source as DbRow;
      const { rows, match } = await destination(ref, String(safeSource.name), context);
      const selection = validateSelection(ref, context, match, ref.kind === 'scenario' && ref.sourceId === reference.sourceId ? sourceGraphToken : undefined);
      const name = existing?.aliasName ?? (match && selection.mode === 'alias' ? nextAliasName(String(safeSource.name), rows.map(row => row.name)) : String(safeSource.name));
      const targetId = existing?.targetId ?? (match && selection.mode === 'overwrite' ? match.id : crypto.randomUUID());
      if (match && selection.mode === 'overwrite' && targetId !== match.id) fail('SELECTION_REQUIRED');
      ids.set(ref.sourceId, targetId); names.set(resourceKey, name); modes.set(resourceKey, selection.mode);
      const exactSourceReuse = selection.mode === 'overwrite' && match?.id === ref.sourceId && safeSource.line_account_id === context.targetAccountId;
      if (existing || exactSourceReuse) preResolved.add(resourceKey);
      if (!existing) resolved.set(resourceKey, { targetId, aliasName: selection.mode === 'alias' ? name : undefined, planned: !exactSourceReuse });
      if (!existing && !exactSourceReuse && match && selection.mode === 'overwrite') {
        const targetGuard = ref.kind === 'tag'
          ? guard(`EXISTS(SELECT 1 FROM tags WHERE id=? AND line_account_id=? AND version=? AND updated_at IS ? AND status='active')`, [match.id, context.targetAccountId, match.version!, match.updated_at])
          : ref.kind === 'template'
            ? guard(`EXISTS(SELECT 1 FROM templates WHERE id=? AND line_account_id=? AND draft_revision=? AND published_version=? AND updated_at IS ?)`, [match.id, context.targetAccountId, match.draft_revision!, match.published_version!, match.updated_at])
            : guard(`EXISTS(SELECT 1 FROM scenarios WHERE id=? AND line_account_id=? AND updated_at IS ?)`, [match.id, context.targetAccountId, match.updated_at]);
        statements.push(targetGuard);
      }
    }
    statements.push(...scenarioGraphSourceGuardStatements(graph));
    for (const row of graph.tags.values()) {
      const key = formReferenceKey('tag', String(row.id)), mode = modes.get(key)!, targetId = ids.get(String(row.id))!, name = names.get(key)!;
      if (preResolved.has(key)) continue;
      if (mode === 'overwrite') statements.push({ sql: `UPDATE tags SET name=?,normalized_name=?,color=?,description=?,version=version+1,updated_by=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND line_account_id=?`, bindings: [name, normalizeScopedTagName(name), row.color, row.description, authority.actorId, targetId, context.targetAccountId] });
      else statements.push({ sql: `INSERT INTO tags(id,name,normalized_name,color,description,line_account_id,created_by,updated_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'))`, bindings: [targetId, name, normalizeScopedTagName(name), row.color, row.description, context.targetAccountId, authority.actorId, authority.actorId] });
    }
    for (const row of graph.templates.values()) {
      const key = formReferenceKey('template', String(row.id)), mode = modes.get(key)!, targetId = ids.get(String(row.id))!;
      if (preResolved.has(key)) continue;
      const clone: DbRow = { ...row, id: targetId, name: names.get(key)!, line_account_id: context.targetAccountId, folder_id: null, created_from_recipe_id: null, recipe_clone_run_id: null, published_version: 0, published_at: null, publish_idempotency_key: null };
      for (const field of ['message_content','carousel_actions_json','question_json','draft_message_content','draft_carousel_actions_json','draft_question_json']) if (clone[field] != null) clone[field] = remapScenarioJson(clone[field], ids);
      delete clone.created_at; delete clone.updated_at;
      if (mode === 'overwrite') {
        const columns = Object.keys(clone).filter(column => !['id','line_account_id'].includes(column));
        statements.push({ sql: `UPDATE templates SET confirmation_revision=confirmation_revision+1, ${columns.map(column => `${column}=?`).join(',')},updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND line_account_id=?`, bindings: [...columns.map(column => clone[column]), targetId, context.targetAccountId] });
      } else statements.push(insertRow('templates', clone));
    }
    const ordered: string[] = [], seen = new Set<string>();
    const order = (id: string) => { if (seen.has(id)) return; seen.add(id); const node = graph.scenarios.get(id)!; for (const ref of node.references) if (ref.kind === 'scenario') order(ref.sourceId); ordered.push(id); };
    order(reference.sourceId);
    for (const sourceId of graph.scenarios.keys()) order(sourceId);
    for (const sourceId of ordered) {
      const node = graph.scenarios.get(sourceId)!, key = formReferenceKey('scenario', sourceId), mode = modes.get(key)!, targetId = ids.get(sourceId)!;
      if (preResolved.has(key)) continue;
      const clone: DbRow = { ...node.row, id: targetId, name: names.get(key)!, line_account_id: context.targetAccountId, is_active: 0, trigger_tag_id: node.row.trigger_tag_id ? ids.get(String(node.row.trigger_tag_id)) ?? fail('REFERENCE_UNAVAILABLE') : null, on_complete_scenario_id: node.row.on_complete_scenario_id ? ids.get(String(node.row.on_complete_scenario_id)) ?? fail('REFERENCE_UNAVAILABLE') : null, folder_id: null, created_from_recipe_id: null, recipe_clone_run_id: null, current_published_version_id: null };
      delete clone.created_at; delete clone.updated_at;
      if (mode === 'overwrite') {
        statements.push({ sql: `DELETE FROM scenario_actions WHERE scenario_id=?`, bindings: [targetId] }, { sql: `DELETE FROM scenario_triggers WHERE scenario_id=?`, bindings: [targetId] }, { sql: `DELETE FROM scenario_steps WHERE scenario_id=?`, bindings: [targetId] }, updateScenarioRow(clone, targetId, context.targetAccountId));
      } else statements.push(insertRow('scenarios', clone));
      const stepIds = new Map<string,string>();
      for (const step of node.steps) stepIds.set(String(step.id), crypto.randomUUID());
      const remapIds = new Map([...ids, ...stepIds]);
      for (const step of node.steps) {
        const copy: DbRow = { ...step, id: stepIds.get(String(step.id))!, scenario_id: targetId, template_id: step.template_id ? ids.get(String(step.template_id)) ?? fail('REFERENCE_UNAVAILABLE') : null, on_reach_tag_id: step.on_reach_tag_id ? ids.get(String(step.on_reach_tag_id)) ?? fail('REFERENCE_UNAVAILABLE') : null, is_draft: 1 };
        if (/^\s*[\[{]/.test(String(copy.message_content))) copy.message_content = remapScenarioJson(copy.message_content, remapIds);
        for (const field of ['message_bubbles_json','target_condition_json','question_json']) if (copy[field] != null) copy[field] = remapScenarioJson(copy[field], remapIds);
        delete copy.created_at; statements.push(insertRow('scenario_steps', copy));
      }
      for (const action of node.actions) {
        const copy: DbRow = { ...action, id: crypto.randomUUID(), scenario_id: targetId, step_id: action.step_id ? stepIds.get(String(action.step_id)) ?? fail('REFERENCE_UNAVAILABLE') : null, config_json: remapScenarioJson(action.config_json, remapIds), condition_json: remapScenarioJson(action.condition_json, remapIds) };
        delete copy.created_at; statements.push(insertRow('scenario_actions', copy));
      }
      for (const trigger of node.triggers) {
        const copy: DbRow = { ...trigger, id: crypto.randomUUID(), scenario_id: targetId, tag_id: trigger.tag_id ? ids.get(String(trigger.tag_id)) ?? fail('REFERENCE_UNAVAILABLE') : null };
        delete copy.created_at; statements.push(insertRow('scenario_triggers', copy));
      }
    }
    const allKeys = graph.references.map(ref => formReferenceKey(ref.kind, ref.sourceId));
    const result = resolved.get(rootKey)!;
    return { ...result, dbCommit: emitOnce(allKeys, statements) };
  };
  return async (reference, context) => {
    if (requireHqTemplateAuthority(authority).kind !== 'AUTHORIZED' || context.tenantId !== authority.tenantId) fail('FORBIDDEN');
    if (reference.kind === 'tag') return resolveTag(reference, context);
    if (reference.kind === 'scenario') return resolveScenarioGraph(reference, context);
    return fail('UNSUPPORTED_REFERENCE');
  };
}
export const createFormTagReferenceResolver = createFormReferenceResolver;

export async function buildFormRuntimePlan({ db, authority, input, context }: { db: D1Database; authority: HqTemplateAuthority; input: HqTemplateAdapterInput; context: HqTemplateAdapterContext }): Promise<HqTemplateStoreAtomicCommitPlan> {
  const adapter = createFormHqTemplateAdapter({ db, authority, resolveReference: createFormReferenceResolver({ db, authority }) });
  const refs = ok(await adapter.extractReferences(input));
  const verified = ok(await adapter.verifyReferences(context, refs));
  const duplicates = ok(await adapter.detectDuplicates(context, verified));
  const ids = ok(await adapter.buildIdMap(context, verified, duplicates));
  return ok(await adapter.buildCommitPlan(context, input, ids));
}

export interface AtomicStoreOptions {
  initialResourceCommit?: import('./contract.js').HqInitialResourceCommit;
  db: D1Database;
  authority: HqTemplateAuthority;
  templateId: string;
  runId: string;
  context: HqTemplateAdapterContext;
  /** SQL やこのコールバックを要求 JSON から受け取らず、信頼済みサーバーだけが計画する。 */
  buildPlan: (context: HqTemplateAdapterContext, input: HqTemplateAdapterInput) => Promise<HqTemplateStoreAtomicCommitPlan>;
}
export type AtomicStoreOutcome = { status: HqTemplateDistributionResult['status']; reused: boolean };

const MAX_DB_COMMIT_ATTEMPTS = 3;

/** DB の確定は原子的かつ有限の再試行とし、古い実行権は安全に終了する。 */
export async function executeHqAtomicStore(options: AtomicStoreOptions): Promise<AtomicStoreOutcome> {
  const { db, authority, templateId, runId } = options;
  if (requireHqTemplateAuthority(authority).kind !== 'AUTHORIZED' || options.context.tenantId !== authority.tenantId) fail('FORBIDDEN');
  const p = await db.prepare(`SELECT p.* FROM hq_template_preflights p JOIN hq_templates t ON t.id=p.template_id AND t.tenant_id=p.tenant_id JOIN line_accounts a ON a.id=p.target_account_id AND a.tenant_id=p.tenant_id WHERE p.id=? AND p.tenant_id=? AND p.template_id=? AND p.created_by=? AND t.template_type='form' AND t.archived_at IS NULL AND a.is_active=1 AND a.archived_at IS NULL`).bind(options.context.preflightId, authority.tenantId, templateId, authority.actorId).first<HqTemplatePreflight>();
  if (!p || p.target_account_id !== options.context.targetAccountId || p.idempotency_fingerprint !== runId || options.context.idempotencyFingerprint !== runId || p.snapshot_token !== options.context.snapshotToken) fail('INVALID_PREFLIGHT');
  const rows = (await db.prepare(`SELECT * FROM hq_template_preflight_resolutions WHERE preflight_id=? AND tenant_id=? ORDER BY source_id`).bind(p!.id, authority.tenantId).all<HqTemplatePreflightResolution>()).results;
  if (!rows.length || rows.length !== options.context.resolutions.length || new Set(options.context.resolutions.map(r => r.sourceId)).size !== rows.length) fail('SELECTION_REQUIRED');
  const resolutions = rows.map(row => {
    const selected = options.context.resolutions.find(r => r.sourceId === row.source_id);
    if (!selected || selected.itemKind !== row.item_kind || !['create', 'overwrite', 'alias'].includes(selected.mode) || (selected.targetId !== undefined && selected.targetId !== row.target_id) || (selected.expectedRevision !== undefined && selected.expectedRevision !== row.expected_revision)) fail('SELECTION_REQUIRED');
    return { sourceId: row.source_id, itemKind: row.item_kind, mode: selected!.mode, targetId: row.target_id ?? undefined, expectedRevision: row.expected_revision ?? undefined };
  });
  if (!['create', 'overwrite', 'alias'].includes(options.context.mode)) fail('SELECTION_REQUIRED');
  const context = { ...options.context, resolutions };
  const version = await db.prepare(`SELECT definition_json FROM hq_template_versions WHERE id=? AND template_id=? AND tenant_id=?`).bind(p!.template_version_id, templateId, authority.tenantId).first<{ definition_json: string }>();
  if (!version) fail('VERSION_CONFLICT');
  const input = { templateVersionId: p!.template_version_id, definitionJson: version!.definition_json };
  const read = async () => db.prepare(`SELECT * FROM hq_template_distribution_results WHERE run_id=? AND tenant_id=? AND target_account_id=?`).bind(runId, authority.tenantId, context.targetAccountId).first<HqTemplateDistributionResult>();
  const sourceId = JSON.stringify([authority.tenantId, runId, context.targetAccountId]);
  const requestHash = await hash(JSON.stringify([templateId, p!.template_version_id, p!.snapshot_token, context.mode, resolutions.map(r => [r.sourceId, r.itemKind, r.mode])]));
  const checkReceipt = async () => {
    const receipt = await db.prepare(`SELECT after_json,actor_principal_id FROM audit_events WHERE source_kind='hq_template_store_request' AND source_id=? AND tenant_id=?`).bind(sourceId, authority.tenantId).first<{ after_json: string; actor_principal_id: string }>();
    if (!receipt || receipt.actor_principal_id !== authority.actorId || receipt.after_json !== JSON.stringify({ requestHash })) fail('SELECTION_CHANGED');
  };
  const previous = await read();
  if (previous && (previous.template_id !== templateId || previous.template_version_id !== p!.template_version_id || previous.preflight_id !== p!.id || previous.snapshot_token !== p!.snapshot_token || previous.idempotency_fingerprint !== runId)) fail('INVALID_PREFLIGHT');
  if (previous) {
    await checkReceipt();
    if (previous.status === 'staged' && Date.parse(previous.started_at) <= Date.now() - 2 * 60_000) {
      await db.prepare(`UPDATE hq_template_distribution_results SET status='failed',error_code='INTERRUPTED',finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE run_id=? AND tenant_id=? AND target_account_id=? AND status='staged' AND started_at=?`).bind(runId, authority.tenantId, context.targetAccountId, previous.started_at).run();
      const recovered = await read();
      if (!recovered) fail('RESULT_UNAVAILABLE');
      return { status: recovered!.status, reused: true };
    }
    if (previous.status !== 'pending') return { status: previous.status, reused: true };
  }
  if (!p!.expires_at || !Number.isFinite(Date.parse(p!.expires_at)) || Date.parse(p!.expires_at) <= Date.now()) fail('VERSION_CONFLICT');
  const run = await beginHqTemplateDistributionRun(db, { id: runId, tenantId: authority.tenantId, templateId, templateVersionId: p!.template_version_id, idempotencyFingerprint: runId, createdBy: authority.actorId });
  if (run.run.status !== 'running' || run.run.created_by !== authority.actorId) fail('INVALID_RUN');
  // pending 中の中断でも判断が変わらないよう、最初の実行権取得前に受領票を保存する。
  await db.prepare(`INSERT OR IGNORE INTO audit_events(id,source_kind,source_id,tenant_id,category,actor_principal_id,actor_role,action,target_kind,target_id,result,after_json) VALUES (?,'hq_template_store_request',?,?,'business',?,?,'hq_template.store_requested','hq_template',?,'success',?)`).bind(crypto.randomUUID(), sourceId, authority.tenantId, authority.actorId, authority.role, templateId, JSON.stringify({ requestHash })).run();
  await checkReceipt();
  const begun = await beginHqTemplateStoreResult(db, { runId, tenantId: authority.tenantId, templateId, templateVersionId: p!.template_version_id, targetAccountId: context.targetAccountId, preflightId: p!.id, idempotencyFingerprint: runId, snapshotToken: p!.snapshot_token });
  if (begun.kind === 'conflict_or_missing') fail('INVALID_PREFLIGHT');
  const claimed = await db.prepare(`UPDATE hq_template_distribution_results SET status='staged',attempt_count=attempt_count+1,started_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),finished_at=NULL,error_code=NULL WHERE run_id=? AND tenant_id=? AND target_account_id=? AND status='pending'`).bind(runId, authority.tenantId, context.targetAccountId).run();
  if (claimed.meta.changes !== 1) { const row = await read(); if (!row) fail('RESULT_UNAVAILABLE'); return { status: row!.status, reused: true }; }
  const claimedRow = await read();
  if (!claimedRow || claimedRow.status !== 'staged') fail('RESULT_UNAVAILABLE');
  const attempt = claimedRow!.attempt_count;
  const claimCondition = `EXISTS(SELECT 1 FROM hq_template_distribution_results WHERE run_id=? AND tenant_id=? AND target_account_id=? AND status='staged' AND attempt_count=?)`;
  const claimBindings = [runId, authority.tenantId, context.targetAccountId, attempt];
  try {
    const plan = await options.buildPlan(context, input);
    if (plan.stage.length || plan.compensateOnDbFailure.length || plan.reconcile.length) fail('UNSUPPORTED_R2');
    if (plan.tenantId !== authority.tenantId || plan.targetAccountId !== context.targetAccountId || plan.preflightId !== p!.id || plan.idempotencyFingerprint !== runId || plan.snapshotToken !== p!.snapshot_token || plan.mode !== context.mode || JSON.stringify(plan.resolutions.map(r => [r.sourceId, r.itemKind, r.mode]).sort()) !== JSON.stringify(resolutions.map(r => [r.sourceId, r.itemKind, r.mode]).sort())) fail('INVALID_PLAN');
    const statements: HqTemplateStatement[] = [guard(claimCondition, claimBindings), guard(`EXISTS(SELECT 1 FROM hq_template_preflights WHERE id=? AND tenant_id=? AND status='consumed' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))`, [p!.id, authority.tenantId]), guard(`EXISTS(SELECT 1 FROM line_accounts WHERE id=? AND tenant_id=? AND is_active=1 AND archived_at IS NULL)`, [context.targetAccountId, authority.tenantId]), guard(`EXISTS(SELECT 1 FROM hq_template_versions v JOIN hq_templates t ON t.id=v.template_id AND t.tenant_id=v.tenant_id WHERE v.id=? AND v.tenant_id=? AND v.template_id=? AND v.definition_json=? AND t.archived_at IS NULL)`, [input.templateVersionId, authority.tenantId, templateId, input.definitionJson]), guard(`EXISTS(SELECT 1 FROM hq_template_distribution_runs WHERE id=? AND tenant_id=? AND status='running' AND created_by=?)`, [runId, authority.tenantId, authority.actorId]), ...plan.dbCommit];
    for (const r of plan.resolutions) statements.push({ sql: `UPDATE hq_template_preflight_resolutions SET resolution_mode=?,target_id=?,expected_revision=?,alias_name=? WHERE preflight_id=? AND tenant_id=? AND source_id=?`, bindings: [r.mode, r.targetId ?? null, r.expectedRevision ?? null, r.aliasName ?? null, p!.id, authority.tenantId, r.sourceId] });
    statements.push({ sql: `UPDATE hq_template_distribution_results SET status='succeeded',finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),error_code=NULL WHERE run_id=? AND tenant_id=? AND target_account_id=? AND status='staged' AND attempt_count=?`, bindings: claimBindings }, { sql: `INSERT INTO audit_events(id,tenant_id,line_account_id,category,actor_principal_id,actor_role,action,target_kind,target_id,result,after_json) VALUES (?,?,?,'business',?,?,'hq_template.distributed','hq_template',?,'success',?)`, bindings: [crypto.randomUUID(), authority.tenantId, context.targetAccountId, authority.actorId, authority.role, templateId, JSON.stringify({ runId })] });
    if(options.initialResourceCommit) statements.push(...await options.initialResourceCommit(context.targetAccountId,plan.resolutions));
    statements.push(captureDistributionName(runId, authority.tenantId, context.targetAccountId));
    for (let commitAttempt = 1; commitAttempt <= MAX_DB_COMMIT_ATTEMPTS; commitAttempt++) {
      try {
        await db.batch(statements.map(s => db.prepare(s.sql).bind(...s.bindings)));
        return { status: 'succeeded', reused: false };
      } catch (error) {
        const row = await read().catch(() => null);
        if (!row) fail('RESULT_UNAVAILABLE');
        if (row!.status !== 'staged' || row!.attempt_count !== attempt) return { status: row!.status, reused: true };
        if (commitAttempt === MAX_DB_COMMIT_ATTEMPTS) throw error;
      }
    }
    return fail('STORE_COMMIT_FAILED');
  } catch (error) {
    // batch が成功して応答だけ失われても、業務の書込を再実行しない。
    const row = await read().catch(() => null);
    if (!row) fail('RESULT_UNAVAILABLE');
    if (row!.status !== 'staged' || row!.attempt_count !== attempt) return { status: row!.status, reused: true };
    const code = error instanceof Error && 'code' in error ? String(error.code) : '';
    const status = code.includes('UNSUPPORTED') ? 'unsupported' : code === 'VERSION_CONFLICT' ? 'version_conflict' : 'failed';
    await db.prepare(`UPDATE hq_template_distribution_results SET status=?,error_code=?,finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE run_id=? AND tenant_id=? AND target_account_id=? AND status='staged' AND attempt_count=?`).bind(status, status === 'unsupported' ? 'UNSUPPORTED_REFERENCE' : status === 'version_conflict' ? 'VERSION_CONFLICT' : code ? 'STORE_PLAN_FAILED' : 'STORE_COMMIT_FAILED', ...claimBindings).run();
    return { status, reused: false };
  }
}

export async function executeFormStore(options: Omit<AtomicStoreOptions, 'buildPlan'>): Promise<AtomicStoreOutcome> {
  return executeHqAtomicStore({ ...options, buildPlan: (context, input) => buildFormRuntimePlan({ db: options.db, authority: options.authority, context, input }) });
}
