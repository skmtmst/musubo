import { normalizeScopedTagName, type HqTemplateStatement } from '@line-crm/db';

import { unsupportedHqTemplateAdapter, type HqTemplateResolution, type HqTemplateAdapter, type HqTemplateAuthority } from './contract.js';

export class HqTemplateError extends Error {
  readonly fields: Record<string, string>;
  constructor(public code: string, public status: 400 | 403 | 404 | 409 | 422 | 500 = 400, fieldKeys?: readonly string[]) {
    super(code);
    const keys: Record<string, string[]> = {
      INVALID_VERSION: ['version'], INVALID_IMAGE: ['definition'], INVALID_TYPE: ['type'], INVALID_KIND: ['kind'], INVALID_REQUEST_ID: ['requestId'],
      INVALID_DEFINITION: ['definition'], UNSUPPORTED_REFERENCE: ['definition'], UNSUPPORTED: ['definition'],
      INVALID_FOLDER_COLOR: ['color'], INVALID_FOLDER: ['folderId'], INVALID_NAME: ['name'], INVALID_REVISION: ['expectedRevision'],
      INVALID_ACCOUNTS: ['accountIds'], INVALID_SELECTION: ['preflightId', 'resolutions'],
    };
    this.fields = Object.fromEntries((fieldKeys ?? keys[code] ?? []).map(key => [key, '入力内容を確認してください']));
  }
}
export type TagDefinition = {
  schemaVersion: 1;
  tag: {
    name: string; color: string; description: string | null; folderId: string | null;
    isStarred?: boolean; manualAssignmentAllowed?: boolean;
    reapplyPolicy?: 'first_only' | 'every_time'; linkedEnabled?: boolean;
    mileage?: { self: number; referrer: number; multiplier: number | null; priority: number };
    actions?: TagAction[];
  };
  folders: { id: string; name: string; parentId: string | null; color: string | null }[];
};
export type TagAction = { id: string; type: 'send_message' | 'grant_mileage'; params: Record<string, unknown>; onFailure: 'stop' | 'continue' };
export type PreflightItem = { sourceId: string; itemKind: 'tag' | 'folder'; name: string; targetId: string | null; expectedRevision: string | null; duplicate: boolean; allowedModes: ('create' | 'overwrite' | 'alias')[] };
type Snapshot = {
  tags: { id: string; name: string; status: string; updated_at: string | null; version: number; action_id: string | null; draft_id: string | null; binding_version_id: string | null; action_count: number }[];
  folders: { id: string; name: string; parent_id: string | null; updated_at: string }[];
};
function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new HqTemplateError('INVALID_DEFINITION');
  return v as Record<string, unknown>;
}
export function boundedText(v: unknown, max = 200, field = 'definition'): string {
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw new HqTemplateError('INVALID_DEFINITION', 400, [field]);
  return v.trim();
}
function color(v: unknown): string | null {
  if (v == null || v === '') return null;
  if (typeof v !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(v)) throw new HqTemplateError('INVALID_DEFINITION');
  return v;
}
function boolean(v: unknown, fallback: boolean): boolean {
  if (v === undefined) return fallback;
  if (typeof v !== 'boolean') throw new HqTemplateError('INVALID_DEFINITION');
  return v;
}
function integer(v: unknown, min: number, max: number, fallback: number): number {
  if (v === undefined) return fallback;
  if (!Number.isSafeInteger(v) || (v as number) < min || (v as number) > max) throw new HqTemplateError('INVALID_DEFINITION');
  return v as number;
}
function actions(v: unknown): TagAction[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > 50) throw new HqTemplateError('INVALID_DEFINITION');
  const parsed = v.map<TagAction>(value => {
    const action = object(value), params = object(action.params);
    if (Object.keys(action).some(key => !['id', 'type', 'params', 'onFailure'].includes(key))) throw new HqTemplateError('UNSUPPORTED_REFERENCE');
    const id = boundedText(action.id, 80), onFailure: TagAction['onFailure'] | null = action.onFailure === 'continue' ? 'continue' : action.onFailure === 'stop' ? 'stop' : null;
    if (!onFailure || (action.type !== 'send_message' && action.type !== 'grant_mileage')) throw new HqTemplateError('UNSUPPORTED_REFERENCE');
    const common = new Set(['delayMinutes', 'cancelIfTagRemoved']);
    const allowed = action.type === 'send_message' ? new Set([...common, 'content']) : new Set([...common, 'amount']);
    if (Object.keys(params).some(key => !allowed.has(key))) throw new HqTemplateError('UNSUPPORTED_REFERENCE');
    const delayMinutes = integer(params.delayMinutes, 0, 525600, 0);
    const cancelIfTagRemoved = boolean(params.cancelIfTagRemoved, true);
    if (action.type === 'send_message') {
      const content = boundedText(params.content, 5000);
      return { id, type: 'send_message', params: { delayMinutes, cancelIfTagRemoved, content }, onFailure };
    }
    const amount = integer(params.amount, 1, 1_000_000, 1);
    return { id, type: 'grant_mileage', params: { delayMinutes, cancelIfTagRemoved, amount }, onFailure };
  });
  if (new Set(parsed.map(action => action.id)).size !== parsed.length) throw new HqTemplateError('INVALID_DEFINITION');
  return parsed;
}
export function parseTagDefinition(v: unknown): TagDefinition {
  const root = object(v), tag = object(root.tag);
  if (root.schemaVersion !== 1 || !Array.isArray(root.folders) || root.folders.length > 8) throw new HqTemplateError('INVALID_DEFINITION');
  if (Object.keys(root).some(key => !['schemaVersion', 'tag', 'folders'].includes(key))) throw new HqTemplateError('UNSUPPORTED_REFERENCE');
  const folders = root.folders.map(v => {
    const f = object(v);
    if (Object.keys(f).some(key => !['id', 'name', 'parentId', 'color'].includes(key))) throw new HqTemplateError('UNSUPPORTED_REFERENCE');
    return { id: boundedText(f.id, 80), name: boundedText(f.name), parentId: f.parentId == null ? null : boundedText(f.parentId, 80), color: color(f.color) };
  });
  if (new Set(folders.map(f => f.id)).size !== folders.length) throw new HqTemplateError('INVALID_DEFINITION');
  const folderId = tag.folderId == null ? null : boundedText(tag.folderId, 80), ordered: typeof folders = [];
  for (let id = folderId; id !== null;) {
    const f = folders.find(f => f.id === id);
    if (!f || ordered.some(p => p.id === id)) throw new HqTemplateError('INVALID_DEFINITION');
    ordered.unshift(f); id = f.parentId;
  }
  if (ordered.length !== folders.length) throw new HqTemplateError('INVALID_DEFINITION');
  const mileageValue = tag.mileage === undefined ? null : object(tag.mileage);
  const multiplier = mileageValue?.multiplier == null ? null : integer(mileageValue.multiplier, 1000, 100000, 10000);
  const reapplyPolicy = tag.reapplyPolicy;
  if (reapplyPolicy !== undefined && reapplyPolicy !== 'first_only' && reapplyPolicy !== 'every_time') throw new HqTemplateError('INVALID_DEFINITION');
  const parsedActions = tag.actions === undefined ? undefined : actions(tag.actions);
  const allowedTagKeys = new Set(['name','color','description','folderId','isStarred','manualAssignmentAllowed','reapplyPolicy','linkedEnabled','mileage','actions']);
  if (Object.keys(tag).some(key => !allowedTagKeys.has(key))) throw new HqTemplateError('UNSUPPORTED_REFERENCE');
  return { schemaVersion: 1, tag: {
    name: boundedText(tag.name), color: color(tag.color) ?? '#94a3b8',
    description: tag.description == null || tag.description === '' ? null : boundedText(tag.description, 2000), folderId,
    ...(tag.isStarred === undefined ? {} : { isStarred: boolean(tag.isStarred, false) }),
    ...(tag.manualAssignmentAllowed === undefined ? {} : { manualAssignmentAllowed: boolean(tag.manualAssignmentAllowed, true) }),
    ...(reapplyPolicy === undefined ? {} : { reapplyPolicy }),
    ...(tag.linkedEnabled === undefined ? {} : { linkedEnabled: boolean(tag.linkedEnabled, false) }),
    ...(mileageValue === null ? {} : { mileage: {
      self: integer(mileageValue.self, 0, 1_000_000, 0),
      referrer: integer(mileageValue.referrer, 0, 1_000_000, 0),
      multiplier,
      priority: integer(mileageValue.priority, 0, 1000, 0),
    } }),
    ...(parsedActions === undefined ? {} : { actions: parsedActions }),
  }, folders: ordered };
}
// 確認後の競合を防ぐため、書込 batch 内でも同じ状態を照合する。
const SNAPSHOT_SQL = `SELECT json_object(
 'tags',json((SELECT json_group_array(json_object('id',t.id,'name',t.name,'normalized_name',t.normalized_name,'color',t.color,'description',t.description,'folder_id',t.folder_id,'updated_at',t.updated_at,'version',t.version,'status',t.status,'action_id',(SELECT ca.id FROM common_action_bindings b JOIN common_actions ca ON ca.id=b.common_action_id AND ca.line_account_id=b.line_account_id WHERE b.line_account_id=? AND b.consumer_type='tag' AND b.consumer_id=t.id AND b.consumer_path='tag.added' ORDER BY ca.updated_at DESC,ca.id DESC LIMIT 1),'draft_id',(SELECT ca.current_draft_version_id FROM common_action_bindings b JOIN common_actions ca ON ca.id=b.common_action_id AND ca.line_account_id=b.line_account_id WHERE b.line_account_id=? AND b.consumer_type='tag' AND b.consumer_id=t.id AND b.consumer_path='tag.added' ORDER BY ca.updated_at DESC,ca.id DESC LIMIT 1),'binding_version_id',(SELECT b.common_action_version_id FROM common_action_bindings b JOIN common_actions ca ON ca.id=b.common_action_id AND ca.line_account_id=b.line_account_id WHERE b.line_account_id=? AND b.consumer_type='tag' AND b.consumer_id=t.id AND b.consumer_path='tag.added' ORDER BY ca.updated_at DESC,ca.id DESC LIMIT 1),'action_count',(SELECT COUNT(*) FROM common_action_bindings b WHERE b.line_account_id=? AND b.consumer_type='tag' AND b.consumer_id=t.id AND b.consumer_path='tag.added'))) FROM (SELECT * FROM tags WHERE line_account_id=? ORDER BY id) t)),
 'folders',json((SELECT json_group_array(json_object('id',id,'name',name,'parent_id',parent_id,'color',color,'updated_at',updated_at)) FROM (SELECT * FROM folders WHERE kind='tag' AND account_id=? ORDER BY id)))
) AS snapshot`;
export async function tagSnapshot(db: D1Database, accountId: string): Promise<string> {
  const row = await db.prepare(SNAPSHOT_SQL).bind(accountId, accountId, accountId, accountId, accountId, accountId).first<{ snapshot: string }>();
  if (!row) throw new HqTemplateError('SNAPSHOT_UNAVAILABLE', 500);
  return row.snapshot;
}
export function inspectTags(def: TagDefinition, snapshot: string): PreflightItem[] {
  const target = JSON.parse(snapshot) as Snapshot, items: PreflightItem[] = [], matched = new Map<string, string | null>();
  for (const f of def.folders) {
    const parent = f.parentId === null ? null : matched.get(f.parentId);
    const found = f.parentId !== null && !parent ? [] : target.folders.filter(t => t.parent_id === parent && normalizeScopedTagName(t.name) === normalizeScopedTagName(f.name));
    if (found.length > 1) throw new HqTemplateError('AMBIGUOUS_FOLDER', 409);
    const t = found[0]; matched.set(f.id, t?.id ?? null);
    items.push({ sourceId: `folder:${f.id}`, itemKind: 'folder', name: f.name, targetId: t?.id ?? null, expectedRevision: t?.updated_at ?? null, duplicate: Boolean(t), allowedModes: t ? ['overwrite', 'alias'] : ['create'] });
  }
  const found = target.tags.filter(t => normalizeScopedTagName(t.name) === normalizeScopedTagName(def.tag.name));
  if (found.length > 1) throw new HqTemplateError('AMBIGUOUS_TAG', 409);
  const t = found[0];
  if (t && t.action_count > 1 && def.tag.actions !== undefined) throw new HqTemplateError('AMBIGUOUS_ACTION_BINDING', 409);
  items.push({ sourceId: 'tag', itemKind: 'tag', name: def.tag.name, targetId: t?.id ?? null, expectedRevision: t ? `${t.updated_at ?? ''}:${t.version}` : null, duplicate: Boolean(t), allowedModes: t ? t.status === 'archived' ? ['alias'] : ['overwrite', 'alias'] : ['create'] });
  return items;
}
export function nextAlias(name: string, occupied: string[]): string {
  const names = new Set(occupied.map(normalizeScopedTagName));
  for (let i = 2; i < 10000; i++) if (!names.has(normalizeScopedTagName(`${name} (${i})`))) return `${name} (${i})`;
  throw new HqTemplateError('ALIAS_EXHAUSTED', 409);
}
export function planTags(input: { accountId: string; actorId: string; definition: TagDefinition; snapshot: string; resolutions: readonly HqTemplateResolution[] }) {
  const { accountId, definition: def, snapshot } = input, state = JSON.parse(snapshot) as Snapshot;
  const items = inspectTags(def, snapshot);
  if (input.resolutions.length !== items.length || new Set(input.resolutions.map(r => r.sourceId)).size !== items.length) throw new HqTemplateError('SELECTION_REQUIRED', 409);
  const statements: HqTemplateStatement[] = [{ sql: `SELECT json(CASE WHEN (${SNAPSHOT_SQL})=? THEN '{}' ELSE 'VERSION_CONFLICT' END)`, bindings: [accountId, accountId, accountId, accountId, accountId, accountId, snapshot] }];
  const now = new Date().toISOString(), ids = new Map<string, string>(), resolutions: HqTemplateResolution[] = [];
  const counts = { created: 0, overwritten: 0, aliased: 0 };
  for (const item of items) {
    const selection = input.resolutions.find(r => r.sourceId === item.sourceId);
    if (!selection || !item.allowedModes.includes(selection.mode)) throw new HqTemplateError('SELECTION_REQUIRED', 409);
    const id = selection.mode === 'overwrite' ? item.targetId! : crypto.randomUUID();
    const f = def.folders.find(f => `folder:${f.id}` === item.sourceId), parent = f?.parentId ? ids.get(`folder:${f.parentId}`)! : null;
    if (f && selection.mode === 'overwrite' && state.folders.find(f => f.id === id)?.parent_id !== parent) throw new HqTemplateError('FOLDER_SELECTION_CONFLICT', 409);
    const name = selection.mode === 'alias' ? nextAlias(item.name, item.itemKind === 'tag' ? state.tags.map(t => t.name) : state.folders.filter(f => f.parent_id === parent).map(f => f.name)) : item.name;
    ids.set(item.sourceId, id);
    resolutions.push({ sourceId: item.sourceId, itemKind: item.itemKind, mode: selection.mode, targetId: id, aliasName: selection.mode === 'alias' ? name : undefined, expectedRevision: item.expectedRevision ?? undefined });
    if (f) {
      if (selection.mode === 'overwrite') statements.push({ sql: `UPDATE folders SET name=?,color=?,updated_at=? WHERE id=? AND kind='tag' AND account_id=?`, bindings: [name, f.color, now, id, accountId] });
      else statements.push({ sql: `INSERT INTO folders(id,kind,name,parent_id,color,account_id,created_at,updated_at) VALUES (?,'tag',?,?,?,?,?,?)`, bindings: [id, name, parent, f.color, accountId, now, now] });
    } else {
      const folderId = def.tag.folderId ? ids.get(`folder:${def.tag.folderId}`)! : null;
      const mileage = def.tag.mileage;
      if (selection.mode === 'overwrite') statements.push({ sql: `UPDATE tags SET name=?,normalized_name=?,color=?,description=?,folder_id=?,is_starred=CASE WHEN ? THEN ? ELSE is_starred END,manual_assignment_allowed=CASE WHEN ? THEN ? ELSE manual_assignment_allowed END,reapply_policy=CASE WHEN ? THEN ? ELSE reapply_policy END,linked_enabled=CASE WHEN ? THEN ? ELSE linked_enabled END,mileage_reward=CASE WHEN ? THEN ? ELSE mileage_reward END,referral_mileage_reward=CASE WHEN ? THEN ? ELSE referral_mileage_reward END,mileage_multiplier_bps=CASE WHEN ? THEN ? ELSE mileage_multiplier_bps END,mileage_multiplier_priority=CASE WHEN ? THEN ? ELSE mileage_multiplier_priority END,version=version+1,updated_by=?,updated_at=? WHERE id=? AND line_account_id=?`, bindings: [name, normalizeScopedTagName(name), def.tag.color, def.tag.description, folderId, def.tag.isStarred !== undefined ? 1 : 0, def.tag.isStarred ? 1 : 0, def.tag.manualAssignmentAllowed !== undefined ? 1 : 0, def.tag.manualAssignmentAllowed ? 1 : 0, def.tag.reapplyPolicy !== undefined ? 1 : 0, def.tag.reapplyPolicy ?? 'first_only', def.tag.linkedEnabled !== undefined ? 1 : 0, def.tag.linkedEnabled ? 1 : 0, mileage !== undefined ? 1 : 0, mileage?.self ?? 0, mileage !== undefined ? 1 : 0, mileage?.referrer ?? 0, mileage !== undefined ? 1 : 0, mileage?.multiplier ?? null, mileage !== undefined ? 1 : 0, mileage?.priority ?? 0, input.actorId, now, id, accountId] });
      else statements.push({ sql: `INSERT INTO tags(id,name,normalized_name,color,description,folder_id,line_account_id,is_starred,manual_assignment_allowed,reapply_policy,linked_enabled,mileage_reward,referral_mileage_reward,mileage_multiplier_bps,mileage_multiplier_priority,status,version,created_by,updated_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'active',1,?,?,?,?)`, bindings: [id, name, normalizeScopedTagName(name), def.tag.color, def.tag.description, folderId, accountId, def.tag.isStarred ? 1 : 0, def.tag.manualAssignmentAllowed === false ? 0 : 1, def.tag.reapplyPolicy ?? 'first_only', def.tag.linkedEnabled ? 1 : 0, mileage?.self ?? 0, mileage?.referrer ?? 0, mileage?.multiplier ?? null, mileage?.priority ?? 0, input.actorId, input.actorId, now, now] });

      const existing = selection.mode === 'overwrite' ? state.tags.find(tag => tag.id === id) : null;
      if ((def.tag.actions?.length ?? 0) > 0 || (def.tag.actions !== undefined && existing?.action_id)) {
        const actionId = existing?.action_id ?? crypto.randomUUID(), versionId = crypto.randomUUID();
        if (existing?.action_id) {
          statements.push(
            { sql: `INSERT INTO common_action_versions(id,common_action_id,version_number,status,action_config,created_by,created_at) SELECT ?,?,COALESCE(MAX(version_number),0)+1,'draft',?,?,? FROM common_action_versions WHERE common_action_id=?`, bindings: [versionId, actionId, JSON.stringify(def.tag.actions ?? []), input.actorId, now, actionId] },
            { sql: `UPDATE common_actions SET name=?,description=?,status='draft',current_draft_version_id=?,updated_at=? WHERE id=? AND line_account_id=?`, bindings: [`${name} が付いたとき`, `タグ「${name}」の連動アクション`, versionId, now, actionId, accountId] },
            { sql: `UPDATE common_action_bindings SET common_action_version_id=?,updated_at=?,confirmation_revision=confirmation_revision+1 WHERE line_account_id=? AND common_action_id=? AND consumer_type='tag' AND consumer_id=? AND consumer_path='tag.added'`, bindings: [versionId, now, accountId, actionId, id] },
          );
        } else {
          statements.push(
            { sql: `INSERT INTO common_actions(id,line_account_id,name,description,status,current_draft_version_id,created_by,created_at,updated_at) VALUES (?,?,?,?,'draft',?,?,?,?)`, bindings: [actionId, accountId, `${name} が付いたとき`, `タグ「${name}」の連動アクション`, versionId, input.actorId, now, now] },
            { sql: `INSERT INTO common_action_versions(id,common_action_id,version_number,status,action_config,created_by,created_at) VALUES (?,?,1,'draft',?,?,?)`, bindings: [versionId, actionId, JSON.stringify(def.tag.actions ?? []), input.actorId, now] },
            { sql: `INSERT INTO common_action_bindings(id,line_account_id,common_action_id,common_action_version_id,consumer_type,consumer_id,consumer_path,created_by,created_at,updated_at) VALUES (?,?,?,?,'tag',?,'tag.added',?,?,?)`, bindings: [crypto.randomUUID(), accountId, actionId, versionId, id, input.actorId, now, now] },
          );
        }
      }
    }
    if (selection.mode === 'create') counts.created++; else if (selection.mode === 'overwrite') counts.overwritten++; else counts.aliased++;
  }
  return { statements, resolutions, counts };
}
export const tagHqTemplateAdapter = unsupportedHqTemplateAdapter('tag');

/** 店舗ごとに新しいアダプターを作り、統括・定義・写しをグローバルへ残さない。 */
export function createTagHqTemplateAdapter(db: D1Database, authority: HqTemplateAuthority): HqTemplateAdapter {
  let definition: TagDefinition | null = null, snapshot: string | null = null;
  let plan: ReturnType<typeof planTags> | null = null;
  let binding: string | null = null, versionId: string | null = null;
  const assertContext = (context: Parameters<HqTemplateAdapter['buildIdMap']>[0]) => {
    if (binding !== JSON.stringify(context)) throw new HqTemplateError('INVALID_PREFLIGHT', 409);
  };
  return {
    type: 'tag',
    async extractReferences(input) {
      snapshot = null; plan = null; binding = null; versionId = input.templateVersionId;
      definition = parseTagDefinition(JSON.parse(input.definitionJson));
      return { kind: 'OK', value: [...definition.folders.map(f => ({ kind: 'folder', sourceId: `folder:${f.id}` })), { kind: 'tag', sourceId: 'tag' }] };
    },
    async verifyReferences(context, references) {
      plan = null; binding = null;
      if (!definition || context.tenantId !== authority.tenantId) throw new HqTemplateError('FORBIDDEN', 403);
      const account = await db.prepare(`SELECT id FROM line_accounts WHERE id=? AND tenant_id=? AND is_active=1 AND archived_at IS NULL`).bind(context.targetAccountId, authority.tenantId).first();
      if (!account) throw new HqTemplateError('FORBIDDEN', 403);
      snapshot = await tagSnapshot(db, context.targetAccountId);
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(snapshot))), b => b.toString(16).padStart(2, '0')).join('');
      if (context.snapshotToken !== `hqts1.${hash}`) throw new HqTemplateError('VERSION_CONFLICT', 409);
      const items = inspectTags(definition, snapshot);
      if (JSON.stringify(references) !== JSON.stringify(items.map(i => ({ kind: i.itemKind, sourceId: i.sourceId })))) throw new HqTemplateError('INVALID_DEFINITION');
      binding = JSON.stringify(context);
      return { kind: 'OK', value: items.map(i => ({ kind: i.itemKind, sourceId: i.sourceId, targetId: i.targetId ?? '' })) };
    },
    async detectDuplicates(context) {
      assertContext(context);
      return { kind: 'OK', value: inspectTags(definition!, snapshot!).filter(i => i.duplicate).map(i => ({ sourceId: i.sourceId, targetId: i.targetId!, reason: 'normalized_name' })) };
    },
    async buildIdMap(context) {
      assertContext(context);
      plan = planTags({ accountId: context.targetAccountId, actorId: authority.actorId, definition: definition!, snapshot: snapshot!, resolutions: context.resolutions });
      return { kind: 'OK', value: Object.fromEntries(plan.resolutions.map(r => [r.sourceId, r.targetId!])) };
    },
    async buildCommitPlan(context, input, idMap) {
      assertContext(context);
      if (!plan || versionId !== input.templateVersionId || JSON.stringify(parseTagDefinition(JSON.parse(input.definitionJson))) !== JSON.stringify(definition) || JSON.stringify(idMap) !== JSON.stringify(Object.fromEntries(plan.resolutions.map(r => [r.sourceId, r.targetId!])))) throw new HqTemplateError('INVALID_DEFINITION');
      return { kind: 'OK', value: { tenantId: context.tenantId, targetAccountId: context.targetAccountId, preflightId: context.preflightId, idempotencyFingerprint: context.idempotencyFingerprint, snapshotToken: context.snapshotToken, mode: context.mode, resolutions: plan.resolutions, stage: [], dbCommit: plan.statements, compensateOnDbFailure: [], reconcile: [] } };
    },
  };
}
