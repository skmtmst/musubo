import type { RichMenuAdapterOptions, RichMenuReferenceResolver } from './rich-menu-contract.js';
export type { RichMenuReferenceResolver, RichMenuAdapterOptions } from './rich-menu-contract.js';
import { resolvePortableMenuActions } from './rich-menu-portable-actions.js';
import { normalizeScopedTagName } from '@line-crm/db';
import { HqTemplateError } from './tag.js';
import { resolveHqLiffActions } from './liff-actions.js';
import { RICH_MENU_DB_ACTION_TYPE_BY_INTENT, isLiffActionKind, liffActionUrl, liffActionFromUrl, type LiffAction, type HqRichMenuDefinition } from '@line-crm/shared';


import { resolveSwitcherActions, validateRichMenuGroupForPublish, type AreaInput } from '../../lib/rich-menu-publisher.js';
import { buildTapPostbackData } from '../../lib/rich-menu-tap.js';
import { unsupportedHqTemplateAdapter, requireHqTemplateAuthority, createHqTemplateSnapshotToken, type HqTemplateAdapter, type HqTemplateAdapterInput, type HqTemplateAdapterContext, type HqTemplateAuthority, type HqTemplateReference, type HqTemplateMatchedReference, type HqTemplateSnapshotToken, type HqTemplateStoreAtomicCommitPlan } from './contract.js';
import { type HqTemplateStatement } from '@line-crm/db';

/** 店舗の組立元が DB・R2・参照を接続するまで、安全側で拒む。 */
export const richMenuHqTemplateAdapter = unsupportedHqTemplateAdapter('rich_menu');

type RefKind = 'tag' | 'form' | 'scenario' | 'template';
type Area = HqRichMenuDefinition['richMenu']['pages'][number]['areas'][number];
export type RichMenuHqDefinition = HqRichMenuDefinition;
type RichMenuBoundReference = HqTemplateMatchedReference & { operation: 'reuse' | 'create'; expectedRevision?: string };
function fail(code: string): never { throw new Error(code); }
const ident = (value: unknown): string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : fail('INVALID_ID');
const text = (value: unknown, max = 200): string => typeof value === 'string' && value.trim() && value.length <= max ? value : fail('INVALID_DEFINITION');
function keys(value: unknown, allowed: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k))) fail('INVALID_DEFINITION');
}
async function digest(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value);
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(v => v.toString(16).padStart(2, '0')).join('');
}
const referenceKey = (r: HqTemplateReference) => `${r.kind}:${r.sourceId}`;
function validateTextPostback(area: Area, targetAreaId: string): void {
  // タグ操作は URL 符号化した postback になるため、表示文だけでなく最終 data が LINE の300文字以内か検査する。
  if (area.intent === 'text' && area.tagIds?.length
    && buildTapPostbackData(targetAreaId, area.actionData.text).length > 300) fail('INVALID_ACTION');
}
function assertPublicUri(value: unknown): void {
  const decode = (raw: string): string => {
    let current = raw;
    for (let i = 0; i < 3; i++) {
      if (!/%[0-9a-f]{2}/i.test(current)) return current;
      try {
        const next = decodeURIComponent(current);
        if (next === current) return current;
        current = next;
      } catch { fail('INVALID_ACTION'); }
    }
    // 制限付きの検査でも、符号化したアカウント参照を残さない。
    if (/%[0-9a-f]{2}/i.test(current)) fail('OPAQUE_REFERENCE_UNSUPPORTED');
    return current;
  };
  let url: URL;
  try {
    url = new URL(String(value));
  } catch { fail('INVALID_ACTION'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) fail('INVALID_ACTION');
  const path = decode(url.pathname);
  const query = decode(url.search);
  const hash = decode(url.hash);
  const queryKeys = [...url.searchParams.keys()].map(decode);
  const referenceParameter = /^(?:form|template|scenario|tag|(?:line)?account)(?:s|ids?)?$/;
  const referencePath = /(?:^|\/)(?:forms?|templates?|scenarios?|tags?|accounts?)\//i;
  const referenceFragment = /(?:^|[?&#\/=])(?:forms?|templates?|scenarios?|tags?|accounts?)(?:[_-]?ids?)?[=\/]/i;
  const liff = /(?:^|\/\/)(?:liff|miniapp)\.line\.me(?:[./:?#]|$)/i;
  if (['liff.line.me', 'miniapp.line.me'].includes(url.hostname.replace(/\.$/, ''))
    || queryKeys.some(k => referenceParameter.test(k.replace(/[_-]/g, '').toLowerCase()) || k.toLowerCase() === 'liff.state')
    || [path, query, hash].some(part => referencePath.test(part) || referenceFragment.test(part) || liff.test(part))) fail('OPAQUE_REFERENCE_UNSUPPORTED');
}
export function parseRichMenuTemplateDefinition(input: HqTemplateAdapterInput, tenantId: string): RichMenuHqDefinition {
  if (input.definitionJson.length > 128_000) fail('DEFINITION_TOO_LARGE');
  const d: unknown = JSON.parse(input.definitionJson);
  keys(d, ['schemaVersion', 'richMenu']);
  if (d.schemaVersion !== 1) fail('INVALID_DEFINITION');
  const g = d.richMenu;
  keys(g, ['id', 'name', 'chatBarText', 'size', 'defaultPageId', 'pages', 'displayOrder', 'displayAudience', 'displayTagName', 'defaultOpen']);
  if(g.displayOrder!==undefined&&(!Number.isSafeInteger(g.displayOrder)||Number(g.displayOrder)<0))fail('INVALID_DEFINITION');
  if(g.displayAudience!==undefined&&!['all','store','tag'].includes(String(g.displayAudience)))fail('INVALID_DEFINITION');
  if(g.defaultOpen!==undefined&&typeof g.defaultOpen!=='boolean')fail('INVALID_DEFINITION');
  if(g.displayAudience==='tag') text(g.displayTagName,100);
  else if(g.displayTagName!==undefined)fail('INVALID_DEFINITION');
  ident(g.id); text(g.name); text(g.chatBarText, 14); ident(g.defaultPageId);
  if (g.size !== 'large' && g.size !== 'compact') fail('INVALID_DEFINITION');
  if (!Array.isArray(g.pages) || !g.pages.length || g.pages.length > 10) fail('INVALID_DEFINITION');
  const ids = new Set<string>([String(g.id)]);
  const addId = (id: unknown) => { const key = ident(id); if (ids.has(key)) fail('DUPLICATE_SOURCE_ID'); ids.add(key); };
  for (const p of g.pages as unknown[]) {
    keys(p, ['id', 'name', 'imageR2Key', 'areas']); addId(p.id); text(p.name);
    const imageKey = text(p.imageR2Key, 1024);
    if (!imageKey.startsWith(`hq-templates/${tenantId}/`) || imageKey.split('/').some(s => !s || s === '.' || s === '..') || /[%\\\u0000-\u001f]/.test(imageKey)) fail('IMAGE_SCOPE_MISMATCH');
    if (!Array.isArray(p.areas) || p.areas.length > 20) fail('INVALID_DEFINITION');
    for (const a of p.areas as unknown[]) {
      keys(a, ['id', 'bounds', 'actionType', 'actionData', 'intent', 'label', 'tagIds', 'formId', 'templateId', 'scenarioId', 'bookingMenuName', 'useTrackedLink', 'dataBindings']); addId(a.id);
      keys(a.bounds, ['x', 'y', 'width', 'height']);
      const b = a.bounds;
      for (const v of Object.values(b)) if (!Number.isInteger(v) || (v as number) < 0) fail('INVALID_BOUNDS');
      if (!(Number(b.width) > 0 && Number(b.height) > 0 && Number(b.x) + Number(b.width) <= 2500 && Number(b.y) + Number(b.height) <= (g.size === 'large' ? 1686 : 843))) fail('INVALID_BOUNDS');
      if (!['uri', 'message', 'postback', 'richmenuswitch'].includes(String(a.actionType))) fail('INVALID_ACTION');
      if (a.intent !== undefined) {
        if (!['url', 'tel', 'text', 'form', 'booking', 'booking_history', 'visit_stamp', 'template', 'switch', 'postback', 'datetime', 'clipboard'].includes(String(a.intent))) fail('INVALID_ACTION');
        const expected = RICH_MENU_DB_ACTION_TYPE_BY_INTENT[a.intent as keyof typeof RICH_MENU_DB_ACTION_TYPE_BY_INTENT];
        if (a.actionType !== expected) fail('INVALID_ACTION');
      }
      // 不透明な postback に元アカウント ID が隠れるため、構造化した参照だけを受け付ける。
      const allowed = a.intent === 'tel' ? ['uri'] : a.intent === 'datetime' ? ['mode','initial','min','max'] : a.intent === 'clipboard' ? ['text'] : a.intent === 'postback' ? ['data','displayText'] : a.intent === 'booking' ? ['menuId'] : a.intent === 'visit_stamp' ? ['cardId'] : isLiffActionKind(a.intent) ? [] : a.actionType === 'richmenuswitch' ? ['targetPageId'] : a.actionType === 'uri' ? ['uri'] : a.actionType === 'message' ? ['text'] : [];
      keys(a.actionData, allowed);
      if(a.dataBindings!==undefined) {
        keys(a.dataBindings,allowed.filter(k=>['uri','text','initial','min','max'].includes(k)));
        if(isLiffActionKind(a.intent)||a.actionType==='richmenuswitch')fail('INVALID_ACTION');
        for(const name of Object.values(a.dataBindings))text(name,200);
      }
      for (const key of ['menuId', 'cardId']) if (a.actionData[key] !== undefined) ident(a.actionData[key]);
      for (const v of Object.values(a.actionData)) text(v, 2000);
      if (a.intent === 'tel') { if (!/^tel:\+?[0-9() -]{3,30}$/.test(String(a.actionData.uri))) fail('INVALID_ACTION'); }
      else if (a.actionType === 'uri' && !isLiffActionKind(a.intent)) assertPublicUri(a.actionData.uri);
      if (a.bookingMenuName !== undefined && (a.intent !== 'booking' || a.actionData.menuId !== undefined)) fail('INVALID_REFERENCE');
      if (a.bookingMenuName !== undefined) text(a.bookingMenuName,200);
      if (a.useTrackedLink !== undefined && typeof a.useTrackedLink !== 'boolean') fail('INVALID_ACTION');
      if (a.useTrackedLink && (!['url','booking','booking_history','visit_stamp','form'].includes(String(a.intent)) || ((a.tagIds as unknown[] | undefined)?.length ?? 0)>1)) fail('INVALID_ACTION');
      if (a.actionType === 'message' && !a.actionData.text) fail('INVALID_ACTION');
      if (a.actionType === 'richmenuswitch') ident(a.actionData.targetPageId);
      if (a.actionType === 'postback' && !['template','postback','datetime','clipboard'].includes(String(a.intent))) fail('OPAQUE_REFERENCE_UNSUPPORTED');
      if (a.label !== undefined) text(a.label);
      for (const key of ['formId', 'templateId', 'scenarioId']) if (a[key] !== undefined) ident(a[key]);
      if (a.intent === 'form' && !a.formId || a.intent === 'template' && !a.templateId) fail('MISSING_REFERENCE');
      if (a.formId !== undefined && a.intent !== 'form' || a.templateId !== undefined && a.intent !== 'template') fail('INVALID_REFERENCE');
      if (a.tagIds !== undefined && (!Array.isArray(a.tagIds) || a.tagIds.length > 30)) fail('INVALID_REFERENCE');
      for (const tag of (a.tagIds ?? []) as unknown[]) ident(tag);
      // handleRichMenuTap が受ける領域 postback は、これらの操作だけが作る。
      if ((a.tagIds as unknown[] | undefined)?.length && !['text', 'template','postback','datetime'].includes(String(a.intent)) && !a.useTrackedLink) fail('UNSUPPORTED_TAG_ACTION');
      if (a.scenarioId !== undefined && !['text', 'template'].includes(String(a.intent))) fail('UNSUPPORTED_SCENARIO_ACTION');
    }
  }
  const definition = d as unknown as RichMenuHqDefinition;
  // 生成 ID は32文字とし、確定時にも実際の対応関係を再確認する。
  for (const p of definition.richMenu.pages) for (const a of p.areas) validateTextPostback(a, '0'.repeat(32));
  const pageIds = new Set(definition.richMenu.pages.map(p => p.id));
  if (!pageIds.has(definition.richMenu.defaultPageId)) fail('INVALID_DEFAULT_PAGE');
  for (const p of definition.richMenu.pages) for (const a of p.areas) if (a.actionType === 'richmenuswitch' && !pageIds.has(a.actionData.targetPageId)) fail('INVALID_SWITCH_TARGET');
  // LINE/R2 を呼ばず公開と同じ操作検証を使う。実際の公開では対象アカウントの LIFF URL を別途必須とする。
  const pages = definition.richMenu.pages.map((p, orderIndex) => ({ ...p, orderIndex, imageContentType: null, lineRichMenuId: null, areas: p.areas as AreaInput[] }));
  try {
    validateRichMenuGroupForPublish({ id: definition.richMenu.id, size: definition.richMenu.size, chatBarText: definition.richMenu.chatBarText, isDefaultForAll: false, formBaseUrl: 'https://liff.line.me/fixture-hq', pages: resolveSwitcherActions(pages, definition.richMenu.id) });
  } catch { fail('INVALID_ACTION'); }
  return definition;
}

export function richMenuReferences(d: RichMenuHqDefinition): HqTemplateReference[] {
  const result = new Map<string, HqTemplateReference>();
  for (const page of d.richMenu.pages) for (const a of page.areas) {
    const refs: [RefKind, string | undefined][] = [['form', a.formId], ['template', a.templateId], ['scenario', a.scenarioId], ...(a.tagIds ?? []).map(id => ['tag', id] as [RefKind, string])];
    for (const [kind, sourceId] of refs) if (sourceId) result.set(`${kind}:${sourceId}`, { kind, sourceId });
  }
  return [...result.values()].sort((a, b) => referenceKey(a).localeCompare(referenceKey(b)));
}
const jsonRows = (columns: string[], from: string, where: string, order = 'id') => `(SELECT json_group_array(json_array(${columns.join(',')})) FROM (SELECT * FROM ${from} WHERE ${where} ORDER BY ${order}))`;
const GROUP_COLUMNS = ['id', 'name', 'chat_bar_text', 'size', 'default_page_id', 'status', 'publishing_at', 'publishing_owner', 'publishing_expires_at', 'publishing_generation', 'updated_at', 'folder_id', 'targeting_condition', 'targeting_enabled', 'is_default_for_all', 'targeting_priority', 'display_order', 'default_open', 'created_at'];
const PAGE_COLUMNS = ['id', 'group_id', 'order_index', 'name', 'image_r2_key', 'line_richmenu_id', 'updated_at', 'alias_id', 'image_content_type', 'created_at'];
const AREA_COLUMNS = ['id', 'page_id', 'action_type', 'action_data', 'intent', 'tag_ids', 'form_id', 'template_id', 'tracked_link_id', 'bounds_x', 'bounds_y', 'bounds_width', 'bounds_height', 'updated_at', 'label', 'score_change', 'created_at'];

/** スナップショットは事前確認側が保存し、適用時に再計算しない。 */
export function createRichMenuHqTemplateAdapter(options: RichMenuAdapterOptions): HqTemplateAdapter & {
  snapshot(targetAccountId: string): Promise<HqTemplateSnapshotToken>;
} {
  const { db, bucket, resolveReference } = options;
  const authority = { ...options.authority };
  const input = { ...options.input };
  if (requireHqTemplateAuthority(authority).kind !== 'AUTHORIZED') fail('FORBIDDEN');
  ident(authority.tenantId); ident(input.templateVersionId);
  const d = parseRichMenuTemplateDefinition(input, authority.tenantId); const g = d.richMenu; const refs = richMenuReferences(d);
  // D1 の100バインド内に、ルート7項目・参照・期待スナップショットの検証を収める。
  if (8 + (g.displayAudience === 'tag' ? 1 : 0) + refs.reduce((count, ref) => count + (ref.kind === 'form' ? 3 : 2), 0) > 100) fail('UNSUPPORTED_REFERENCE_LIMIT');
  const assertContext = (c: Pick<HqTemplateAdapterContext, 'tenantId' | 'targetAccountId'>) => {
    if (c.tenantId !== authority.tenantId) fail('FORBIDDEN'); ident(c.targetAccountId);
  };
  async function targetRefs(accountId: string): Promise<RichMenuBoundReference[]> {
    return Promise.all(refs.map(async r => {
      const resolved = await resolveReference(r, accountId);
      if (!resolved) fail('REFERENCE_UNRESOLVED');
      return typeof resolved === 'string'
        ? { ...r, targetId: ident(resolved), operation: 'reuse' as const }
        : { ...r, targetId: ident(resolved.targetId), operation: resolved.operation, expectedRevision: resolved.expectedRevision };
    }));
  }
  async function capture(accountId: string) {
    ident(accountId);
    const matched = await targetRefs(accountId);
    const actions = new Map<string, LiffAction>();
    for (const p of g.pages) for (const a of p.areas) {
      if (!isLiffActionKind(a.intent)) continue;
      actions.set(`area:${a.id}`, a.intent === 'booking' ? { kind: 'booking', ...(a.actionData.menuId ? { menuId: a.actionData.menuId } : {}) }
        : a.intent === 'visit_stamp' ? { kind: 'visit_stamp', ...(a.actionData.cardId ? { cardId: a.actionData.cardId } : {}) }
        : { kind: 'booking_history' }); // フォームは既存の参照計画で配り先IDを解決する。
    }
    const parts = [jsonRows(['id', 'tenant_id', 'revision', 'is_active', 'archived_at'], 'line_accounts', 'id = ? AND tenant_id = ? AND is_active = 1 AND archived_at IS NULL')];
    const bindings: (string | number | null)[] = [accountId, authority.tenantId];
    parts.push(jsonRows(['id', 'definition_json'], 'hq_template_versions', "id=? AND tenant_id=? AND EXISTS (SELECT 1 FROM hq_templates t WHERE t.id=hq_template_versions.template_id AND t.tenant_id=hq_template_versions.tenant_id AND t.template_type='rich_menu' AND t.archived_at IS NULL)"));
    bindings.push(input.templateVersionId, authority.tenantId);
    parts.push(jsonRows(GROUP_COLUMNS, 'rich_menu_groups', 'account_id=?')); bindings.push(accountId);
    parts.push(jsonRows(PAGE_COLUMNS, 'rich_menu_pages', 'group_id IN (SELECT id FROM rich_menu_groups WHERE account_id=?)')); bindings.push(accountId);
    parts.push(jsonRows(AREA_COLUMNS, 'rich_menu_areas', 'page_id IN (SELECT p.id FROM rich_menu_pages p JOIN rich_menu_groups g ON g.id=p.group_id WHERE g.account_id=?)')); bindings.push(accountId);
    for (const r of matched) {
      if (r.kind === 'form') {
        parts.push(jsonRows(['id', 'content_revision', 'updated_at'], 'forms', 'id=? AND EXISTS (SELECT 1 FROM form_accounts WHERE form_id=forms.id AND line_account_id=?) AND NOT EXISTS (SELECT 1 FROM form_accounts WHERE form_id=forms.id AND line_account_id<>?)'));
        bindings.push(r.targetId, accountId, accountId);
      } else {
        const table = { tag: 'tags', scenario: 'scenarios', template: 'templates' }[r.kind as Exclude<RefKind, 'form'>];
        if (!table) fail('INVALID_REFERENCE');
        parts.push(jsonRows(['id', 'updated_at', ...(r.kind === 'tag' ? ['version'] : r.kind === 'template' ? ['draft_revision'] : [])], table, 'id=? AND line_account_id=?'));
        bindings.push(r.targetId, accountId);
      }
    }
    if (g.displayAudience === 'tag') {
      parts.push(jsonRows(['id', 'name', 'status', 'version', 'updated_at'], 'tags', 'line_account_id=?'));
      bindings.push(accountId);
    }
    const sql = `SELECT json_array(${parts.join(',')}) AS snapshot`;
    const row = await db.prepare(sql).bind(...bindings).first<{ snapshot: string }>();
    if (!row) fail('VERSION_CONFLICT');
    const values = JSON.parse(row.snapshot) as unknown[][][];
    if (values[0].length !== 1 || values[1].length !== 1 || values[1][0][1] !== input.definitionJson) fail('SOURCE_OR_TARGET_SCOPE_MISMATCH');
    if (values.slice(5, 5 + matched.length).some((v, index) => v.length !== (matched[index].operation === 'reuse' ? 1 : 0))) fail('REFERENCE_SCOPE_MISMATCH');
    const audienceTags = g.displayAudience === 'tag' ? values[5 + matched.length].filter(row => normalizeScopedTagName(String(row[1])) === normalizeScopedTagName(g.displayTagName!)) : [];
    if (g.displayAudience === 'tag' && (audienceTags.length !== 1 || audienceTags[0][2] !== 'active')) throw new HqTemplateError('DISPLAY_TAG_UNAVAILABLE', 409);
    const audienceTagId = audienceTags[0]?.[0] as string | undefined;
    const portable = await resolvePortableMenuActions(db, authority, accountId, g.pages.flatMap(p=>p.areas));
    for (const [key,value] of portable.actions) actions.set(key,value);
    const liff = await resolveHqLiffActions(db, authority, accountId, actions);
    liff.snapshot.push(...portable.snapshot); liff.statements.push(...portable.statements);
    const media = await Promise.all(g.pages.map(async p => {
      const obj = await bucket.head(p.imageR2Key);
      if (!obj || obj.size < 1 || obj.size > 1024 * 1024 || !['image/png', 'image/jpeg'].includes(obj.httpMetadata?.contentType ?? '')) fail('INVALID_IMAGE');
      return { key: p.imageR2Key, etag: obj.etag, size: obj.size, contentType: obj.httpMetadata!.contentType! };
    }));
    const token = await createHqTemplateSnapshotToken({ schemaVersion: 1, rootHash: await digest(row.snapshot), referenceHash: await digest(JSON.stringify([matched, liff.snapshot])), childHash: await digest(input.definitionJson), mediaKeyHash: await digest(JSON.stringify(media)) }, digest);
    return { sql, bindings, raw: row.snapshot, token, matched, media, liff, audienceTagId, portable };
  }
  return {
    type: 'rich_menu',
    snapshot: async accountId => (await capture(accountId)).token,
    extractReferences: async candidate => {
      if (candidate.templateVersionId !== input.templateVersionId || candidate.definitionJson !== input.definitionJson) fail('VERSION_CONFLICT');
      return { kind: 'OK', value: refs };
    },
    verifyReferences: async (c, requested) => {
      assertContext(c);
      if (JSON.stringify(requested) !== JSON.stringify(refs)) fail('REFERENCE_MISMATCH');
      const s = await capture(c.targetAccountId); if (s.token !== c.snapshotToken) fail('VERSION_CONFLICT');
      return { kind: 'OK', value: s.matched };
    },
    detectDuplicates: async c => {
      assertContext(c);
      const rows = await db.prepare('SELECT id FROM rich_menu_groups WHERE account_id=? AND name=? ORDER BY id').bind(c.targetAccountId, g.name).all<{ id: string }>();
      return { kind: 'OK', value: rows.results.map(r => ({ sourceId: g.id, targetId: r.id, reason: 'same_name' })) };
    },
    buildIdMap: async (c, matched) => {
      assertContext(c);
      const actual = await targetRefs(c.targetAccountId);
      if (JSON.stringify(matched) !== JSON.stringify(actual)) fail('REFERENCE_MISMATCH');
      const entries = await Promise.all([g.id, ...g.pages.flatMap(p => [p.id, ...p.areas.map(a => a.id)])].map(async id => [id, (await digest(JSON.stringify([authority.tenantId, c.targetAccountId, c.preflightId, input.templateVersionId, id]))).slice(0, 32)]));
      return { kind: 'OK', value: Object.fromEntries([...entries, ...actual.map(r => [referenceKey(r), r.targetId])]) };
    },
    buildCommitPlan: async (c, candidate, idMap) => {
      assertContext(c); ident(c.preflightId); text(c.idempotencyFingerprint, 256);
      if (!['create', 'overwrite', 'alias'].includes(c.mode)) fail('INVALID_MODE');
      if (candidate.templateVersionId !== input.templateVersionId || candidate.definitionJson !== input.definitionJson) fail('VERSION_CONFLICT');
      const s = await capture(c.targetAccountId); if (s.token !== c.snapshotToken) fail('VERSION_CONFLICT');
      for (const r of s.matched) if (idMap[referenceKey(r)] !== r.targetId) fail('REFERENCE_MISMATCH');
      const resolve = (id: string) => ident(idMap[id]);
      for (const p of g.pages) for (const a of p.areas) validateTextPostback(a, resolve(a.id));
      const decisions = c.resolutions.filter(r => r.sourceId === g.id && r.itemKind === 'rich_menu');
      if (decisions.length !== 1 || c.resolutions.length !== refs.length + 1 || decisions[0].mode !== c.mode) fail('RESOLUTION_REQUIRED');
      for (const matched of s.matched) {
        const selected = c.resolutions.filter(r => r.sourceId === referenceKey(matched) && r.itemKind === matched.kind);
        const mode = matched.operation === 'reuse' ? 'overwrite' : 'create';
        if (selected.length !== 1 || selected[0].mode !== mode || selected[0].targetId !== matched.targetId || (matched.expectedRevision !== undefined && selected[0].expectedRevision !== matched.expectedRevision)) fail('RESOLUTION_REQUIRED');
      }
      const choice = decisions[0];
      const groupId = c.mode === 'overwrite' ? ident(choice.targetId) : resolve(g.id);
      const target = await db.prepare('SELECT * FROM rich_menu_groups WHERE id=? AND account_id=?').bind(groupId, c.targetAccountId).first<Record<string, unknown>>();
      if (c.mode === 'overwrite' && (!target || target.status !== 'draft' || target.name !== g.name || target.publishing_owner || target.publishing_at || target.publishing_expires_at || target.updated_at !== choice.expectedRevision)) fail('OVERWRITE_FORBIDDEN_OR_CONFLICT');
      if (c.mode === 'overwrite' && await db.prepare('SELECT id FROM rich_menu_pages WHERE group_id=? AND line_richmenu_id IS NOT NULL LIMIT 1').bind(groupId).first()) fail('OVERWRITE_FORBIDDEN_OR_CONFLICT');
      if (c.mode !== 'overwrite' && target) fail('VERSION_CONFLICT');
      const name = c.mode === 'alias' ? text(choice.aliasName) : g.name;
      if (c.mode === 'alias' && (!name.startsWith(`${g.name} (`) || !/^[2-9][0-9]*\)$|^1[0-9]+\)$/.test(name.slice(g.name.length + 2)))) fail('ALIAS_REQUIRED');
      const nameMatch = await db.prepare('SELECT id FROM rich_menu_groups WHERE account_id=? AND name=? AND id<>?').bind(c.targetAccountId, name, groupId).first();
      if (nameMatch) fail('DUPLICATE_NAME');
      const ownerToken = await digest(JSON.stringify([c.tenantId, c.targetAccountId, c.preflightId, c.idempotencyFingerprint, c.executionAttempt ?? 0]));
      const stage = await Promise.all(g.pages.map(async (p, i) => {
        const obj = await bucket.get(p.imageR2Key, { onlyIf: { etagMatches: s.media[i].etag } });
        if (!obj || !('body' in obj)) fail('IMAGE_CHANGED');
        const bytes = new Uint8Array(await obj.arrayBuffer()); if (bytes.length !== s.media[i].size) fail('IMAGE_CHANGED');
        return { key: `rich-menus/${c.targetAccountId}/hq/${ownerToken}/${resolve(p.id)}`, ownerToken, bytes, contentType: s.media[i].contentType };
      }));
      const dbCommit: HqTemplateStatement[] = [{ sql: `SELECT json(CASE WHEN (${s.sql}) = ? THEN '{}' ELSE 'VERSION_CONFLICT' END)`, bindings: [...s.bindings, s.raw] }, ...s.liff.statements];
      const add = (sql: string, ...bindings: (string | number | null)[]) => dbCommit.push({ sql, bindings });
      if (c.mode === 'overwrite') {
        // 外部キーが無効の既存試験環境でも動くよう、子行を明示的に削除する。
        add('DELETE FROM rich_menu_areas WHERE page_id IN (SELECT id FROM rich_menu_pages WHERE group_id=?)', groupId);
        add('DELETE FROM rich_menu_pages WHERE group_id=?', groupId);
        add("UPDATE rich_menu_groups SET name=?, chat_bar_text=?, size=?, default_page_id=?, status='draft', is_default_for_all=0, targeting_enabled=0, targeting_condition=NULL, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND account_id=?", name, g.chatBarText, g.size, resolve(g.defaultPageId), groupId, c.targetAccountId);
      } else add('INSERT INTO rich_menu_groups (id,account_id,name,chat_bar_text,size,default_page_id,status) VALUES (?,?,?,?,?,?,\'draft\')', groupId, c.targetAccountId, name, g.chatBarText, g.size, resolve(g.defaultPageId));
      add('UPDATE rich_menu_groups SET default_open=?, confirmation_revision=confirmation_revision+1 WHERE id=? AND account_id=?', g.defaultOpen === true ? 1 : 0, groupId, c.targetAccountId);
      if (g.displayAudience === 'tag') add('UPDATE rich_menu_groups SET targeting_enabled=1,targeting_condition=? WHERE id=? AND account_id=?', JSON.stringify({operator:'AND',rules:[{type:'tag_exists',value:s.audienceTagId}]}), groupId, c.targetAccountId);
      if(g.displayOrder!==undefined)add('UPDATE rich_menu_groups SET display_order=? WHERE id=? AND account_id=?',g.displayOrder,groupId,c.targetAccountId);
      // 下書きを配るだけで公開はしない。全員向けの指定も、店での公開を経て反映する。
      if(g.displayAudience==='all')add('UPDATE rich_menu_groups SET is_default_for_all=1 WHERE id=? AND account_id=?',groupId,c.targetAccountId);
      g.pages.forEach((p, i) => {
        add('INSERT INTO rich_menu_pages (id,group_id,order_index,name,alias_id,line_richmenu_id,image_r2_key,image_content_type) VALUES (?,?,?,?,?,NULL,?,?)', resolve(p.id), groupId, i, p.name, `lhx-${groupId.slice(0, 8)}-${i}`, stage[i].key, stage[i].contentType);
        for (const a of p.areas) {
          const ref = (kind: RefKind, id?: string) => id ? ident(idMap[`${kind}:${id}`]) : null;
          const data: Record<string, string | null> = { ...a.actionData, ...(s.portable.data[a.id] ?? {}), ...(a.scenarioId ? { scenarioId: ref('scenario', a.scenarioId) } : {}) };
          if (isLiffActionKind(a.intent)) {
            const uri = s.liff.targets[`area:${a.id}`];
            if (a.intent === 'form') {
              const liffId = new URL(uri).pathname.replace(/\//g, '');
              data.uri = liffActionUrl({ liffId, kind: 'form', formId: ref('form', a.formId)! });
            } else {
              data.uri = uri;
              const selected = liffActionFromUrl(uri);
              if (selected?.kind === 'booking' && selected.menuId) data.menuId = selected.menuId;
              if (selected?.kind === 'visit_stamp' && selected.cardId) data.cardId = selected.cardId;
            }
          }
          if (a.actionType === 'richmenuswitch') data.targetPageId = resolve(a.actionData.targetPageId);
          let trackedId: string | null = null;
          if (a.useTrackedLink) {
            trackedId = ownerToken.slice(0,16)+resolve(a.id).slice(0,16);
            add('INSERT INTO tracked_links(id,name,original_url,tag_id,line_account_id,short_code) VALUES (?,?,?,?,?,?)',trackedId,a.label ?? g.name,String(data.uri),(a.tagIds?.[0] ? ref('tag',a.tagIds[0]) : null),c.targetAccountId,trackedId);
          }
          add('INSERT INTO rich_menu_areas (id,page_id,bounds_x,bounds_y,bounds_width,bounds_height,action_type,action_data,intent,label,tag_ids,form_id,template_id,tracked_link_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)', resolve(a.id), resolve(p.id), a.bounds.x, a.bounds.y, a.bounds.width, a.bounds.height, a.actionType, JSON.stringify(data), a.intent ?? null, a.label ?? null, JSON.stringify((a.tagIds ?? []).map(id => ref('tag', id))), ref('form', a.formId), ref('template', a.templateId),trackedId);
        }
      });
      const owned = stage.map(({ key, ownerToken }) => ({ key, ownerToken }));
      return { kind: 'OK', value: { tenantId: c.tenantId, targetAccountId: c.targetAccountId, preflightId: c.preflightId, idempotencyFingerprint: c.idempotencyFingerprint, snapshotToken: c.snapshotToken, mode: c.mode, resolutions: c.resolutions, stage, dbCommit, compensateOnDbFailure: owned, reconcile: owned } };
    },
  };
}

/** 準備・確定・照合と再試行まで店舗の実行権を保持する。計画と事前確認の受領票・結果・監査は1つの D1 batch で確定する。結果不明では確定済みメニューの画像を削除しない。 */
export async function executeRichMenuHqPlan(
  plan: HqTemplateStoreAtomicCommitPlan,
  dependencies: {
    bucket: Pick<R2Bucket, 'head' | 'put' | 'delete'>;
    commit: (statements: readonly HqTemplateStatement[]) => Promise<void>;
    reconcile: () => Promise<'committed' | 'not_committed' | 'unknown'>;
  },
): Promise<'committed' | 'cleanup_pending'> {
  const { bucket, commit, reconcile } = dependencies;
  for (const obj of plan.stage) {
    if (!/^[a-f0-9]{64}$/.test(obj.ownerToken) || !new RegExp(`^rich-menus/${ident(plan.targetAccountId)}/hq/${obj.ownerToken}/[a-f0-9]{32}$`).test(obj.key)) fail('IMAGE_SCOPE_MISMATCH');
  }
  let commitStarted = false;
  try {
    for (const obj of plan.stage) {
      if (!obj.key.startsWith(`rich-menus/${ident(plan.targetAccountId)}/hq/${obj.ownerToken}/`) || !/^[a-f0-9]{64}$/.test(obj.ownerToken)) fail('IMAGE_SCOPE_MISMATCH');
      const contentHash = await digest(obj.bytes);
      const existing = await bucket.head(obj.key);
      if (existing) {
        if (existing.customMetadata?.ownerToken !== obj.ownerToken || existing.customMetadata?.contentHash !== contentHash) fail('IMAGE_OWNER_CONFLICT');
        continue;
      }
      const written = await bucket.put(obj.key, obj.bytes, { onlyIf: { etagDoesNotMatch: '*' }, customMetadata: { ownerToken: obj.ownerToken, contentHash }, httpMetadata: { contentType: obj.contentType } });
      if (!written) fail('IMAGE_OWNER_CONFLICT');
    }
    commitStarted = true;
    await commit(plan.dbCommit);
    return 'committed';
  } catch (error) {
    // 応答を失った成功処理の画像が、再試行時に既に存在する場合がある。
    const outcome = await reconcile().catch(() => 'unknown' as const);
    if (outcome === 'committed') return 'committed';
    if (outcome === 'unknown') return 'cleanup_pending';
    let cleanupFailed = false;
    for (const obj of plan.stage) {
      try {
        const current = await bucket.head(obj.key);
        if (current?.customMetadata?.ownerToken === obj.ownerToken) await bucket.delete(obj.key);
      } catch { cleanupFailed = true; }
    }
    if (cleanupFailed) return 'cleanup_pending';
    // DB/R2 の本文にはキーや SQL 引数が含まれ得るため、応答へ出さない。
    fail(commitStarted ? 'STORE_COMMIT_FAILED' : 'IMAGE_STAGE_FAILED');
  }
}
