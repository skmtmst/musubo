import {catalogWarnings} from './catalog.js';
import { canonicalDefinition } from './canonical-definition.js';
import { isCatalogType, parseCatalogDefinition, catalogSnapshot, inspectCatalog, planCatalog } from './catalog.js';
import { listTemplateAccounts, requireTargetAccounts } from './accounts.js';
export { listTemplateAccounts, requireTargetAccounts } from './accounts.js';
import { rethrowR2 } from './distribution-errors.js'
import { isDeliveryType, parseDeliveryDefinition, deliverySnapshot, inspectDelivery, planDelivery, validateDeliveryReferences, deliveryReferenceItems } from './delivery.js';
import { parseFriendFieldDefinition, parseMarkDefinition } from './friend-attributes.js';
import { templateKind, type HqTemplateListDisplay } from '@line-crm/shared'
import type { HqTemplateArchiveStatus } from '@line-crm/shared';

import { parseTextOverrides } from './text-overrides.js';

import { messageListFacts } from './message-list-facts.js';
import { templateContentSummary } from './list-display.js';
import { captureDistributionName, targetDistributionVersion } from './distribution-display.js';
import { parseScenarioDefinition, scenarioSnapshot, inspectScenario, planScenario } from './scenario.js';
import {
  beginHqTemplateDistributionRun, getHqTemplate, listHqTemplateDisplaySources, HQ_TEMPLATE_TYPES, validRestaurantCoursesSql,
  type HqTemplate, type HqTemplatePreflight, type HqTemplatePreflightResolution,
  type HqTemplateDistributionResult, type HqTemplateStatement, type HqTemplateType,
} from '@line-crm/db';

import { type HqTemplateAuthority, type HqTemplateResolution, type HqTemplateAdapterResult, type HqTemplateSnapshotToken, VERSION_CONFLICT_MESSAGE } from './contract.js';
import { getHqTemplateAdapter } from './registry.js';
import { boundedText, HqTemplateError, inspectTags, parseTagDefinition, planTags, tagSnapshot } from './tag.js';
import { parseMessageTemplateDefinition } from './template.js';
import { formTemplateWarnings, FormTemplateError, inspectFormTemplate, inspectFormTemplateReferences, parseFormTemplateDefinition } from './form.js';
import { parseRichMenuTemplateDefinition } from './rich-menu.js';
import { executeFormStore, HqRuntimeError } from './runtime.js';
import { executeR2RuntimeStore, HqR2RuntimeError, inspectR2RuntimeStore, reconcileFailedOwnedImages } from './runtime-r2.js';

export { HqTemplateError } from './tag.js';
export type DistributionSelection = { accountId: string; sourceId: string; mode: 'create' | 'overwrite' | 'alias' };
export async function digest(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('');
}
function guard(sql: string, bindings: HqTemplateStatement['bindings']): HqTemplateStatement {
  return { sql: `SELECT json(CASE WHEN (${sql}) THEN '{}' ELSE 'HQ_GUARD_FAILED' END)`, bindings };
}
async function batch(db: D1Database, statements: HqTemplateStatement[]) {
  return db.batch(statements.map(s => db.prepare(s.sql).bind(...s.bindings)));
}
function audit(authority: HqTemplateAuthority, action: string, targetId: string, accountId: string | null = null, result = 'success', runId: string | null = null): HqTemplateStatement {
  return { sql: `INSERT INTO audit_events(id,tenant_id,line_account_id,category,actor_principal_id,actor_role,action,target_kind,target_id,result,after_json) VALUES (?,?,?,'business',?, ?,?,'hq_template',?,?,?)`,
    bindings: [crypto.randomUUID(), authority.tenantId, accountId, authority.actorId, authority.role, `hq_template.${action}`, targetId, result, runId ? JSON.stringify({ runId }) : null] };
}
export async function templateDetail(db: D1Database, authority: HqTemplateAuthority, id: string, versionId?: string) {
  const template = await getHqTemplate(db, authority.tenantId, id);
  if (!template || template.archived_at) throw new HqTemplateError('NOT_FOUND', 404);
  if (versionId) template.current_version_id = versionId;
  const version = await db.prepare(`SELECT definition_json FROM hq_template_versions WHERE tenant_id=? AND template_id=? AND id=?`)
    .bind(authority.tenantId, id, template.current_version_id).first<{ definition_json: string }>();
  if (!version) throw new HqTemplateError('VERSION_UNAVAILABLE', 409);
  return { template, definition: JSON.parse(version.definition_json) as unknown };
}
/** 作成キーは統括に限定し、運用状態確認の受領票とは名前空間を分ける。 */
export function templateCreationRequestId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(value)) throw new HqTemplateError('INVALID_REQUEST_ID');
  return value;
}
function canonicalCreationBody(body: Record<string, unknown>): string {
  const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([key,v]) => [key,stable(v)])) : value;
  return JSON.stringify(stable(Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'requestId'))));
}
async function replayTemplateCreation(db: D1Database, authority: HqTemplateAuthority, key: string, requestHash: string, templateId: string, name: string, description: string | null, folderId: string | null) {
  const receipt = await db.prepare(`SELECT request_hash,resource_id FROM operation_request_receipts WHERE action='hq_template.create' AND actor_id=? AND idempotency_key=?`).bind(`tenant:${authority.tenantId}`, key).first<{ request_hash: string; resource_id: string }>();
  if (!receipt) return null;
  if (receipt.request_hash !== requestHash) throw new HqTemplateError('IDEMPOTENCY_CONFLICT', 409);
  if (receipt.resource_id !== templateId) throw new HqTemplateError('CREATE_RECEIPT_UNAVAILABLE', 409);
  const initial = await db.prepare(`SELECT COALESCE(t.catalog_type,t.delivery_type,t.friend_attribute_type,t.extended_type,t.template_type) AS template_type,t.created_at AS template_created_at,v.id,v.created_at,v.created_by,v.definition_json FROM hq_templates t JOIN hq_template_versions v ON v.tenant_id=t.tenant_id AND v.template_id=t.id AND v.version=1 WHERE t.id=? AND t.tenant_id=?`).bind(templateId, authority.tenantId).first<{ template_type:HqTemplateType; template_created_at:string; id:string; created_at:string; created_by:string|null; definition_json:string }>();
  if (!initial) throw new HqTemplateError('CREATE_RECEIPT_UNAVAILABLE', 409);
  // 現在の行が編集・保管済みでも、同じ作成には最初の応答を返す。
  return { template: { id: templateId, tenant_id: authority.tenantId, template_type: initial.template_type, name, description, current_version_id: initial.id, revision: 2, created_by: initial.created_by, created_at: initial.template_created_at, updated_at: initial.created_at, archived_at: null, folder_id: folderId }, definition: JSON.parse(initial.definition_json) as unknown };
}
export async function saveTemplate(db: D1Database, authority: HqTemplateAuthority, body: Record<string, unknown>, id?: string) {
  const requestId = id ? null : templateCreationRequestId(body.requestId);
  const requestHash = await digest(canonicalCreationBody(body));
  if (requestId) {
    const receipt = await db.prepare(`SELECT request_hash FROM operation_request_receipts WHERE action='hq_template.create' AND actor_id=? AND idempotency_key=?`).bind(`tenant:${authority.tenantId}`,requestId).first<{ request_hash:string }>();
    if (receipt && receipt.request_hash !== requestHash) throw new HqTemplateError('IDEMPOTENCY_CONFLICT',409);
  }
  const current = id ? await templateDetail(db, authority, id) : null;
  const type = current?.template.template_type ?? body.type;
  if (!HQ_TEMPLATE_TYPES.includes(type as HqTemplateType) || (body.type !== undefined && body.type !== type)) throw new HqTemplateError('INVALID_TYPE');
  const definition = await canonicalDefinition(db,type as HqTemplateType, body.definition, authority), json = JSON.stringify(definition);
  if(isDeliveryType(String(type))) for(const ref of (definition as import('@line-crm/shared').HqDeliveryTemplateDefinition).references ?? []) if(ref.accountId) {
    if(!await db.prepare('SELECT id FROM line_accounts WHERE id=? AND tenant_id=? AND is_active=1 AND archived_at IS NULL').bind(ref.accountId,authority.tenantId).first()) throw new HqTemplateError('REFERENCE_UNAVAILABLE',422);
    await deliveryReferenceItems(db,ref.accountId,{...(definition as import('@line-crm/shared').HqDeliveryTemplateDefinition),references:[ref]});
  }
  const name = boundedText(body.name, 200, 'name'), description = body.description == null || body.description === '' ? null : boundedText(body.description, 2000, 'description');
  const templateId = id ?? `hqt_${await digest(JSON.stringify([authority.tenantId, requestId]))}`;
  const versionId = crypto.randomUUID(), revision = current?.template.revision ?? 0, createdAt = new Date().toISOString();
  if (requestId) {
    const replay = await replayTemplateCreation(db, authority, requestId, requestHash, templateId, name, description, body.folderId as string | null ?? null);
    if (replay) return replay;
  }
  if (id && (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision !== revision)) throw new HqTemplateError('VERSION_CONFLICT', 409);
  const folderId = body.folderId === undefined ? current?.template.folder_id ?? null : body.folderId;
  if (folderId !== null && (typeof folderId !== 'string' || !(await db.prepare('SELECT id FROM hq_template_folders WHERE id=? AND tenant_id=? AND archived_at IS NULL').bind(folderId,authority.tenantId).first()))) throw new HqTemplateError('INVALID_FOLDER',422);
  const statements: HqTemplateStatement[] = [];
  if (current) statements.push(guard(`EXISTS(SELECT 1 FROM hq_templates WHERE id=? AND tenant_id=? AND revision=? AND archived_at IS NULL)`, [id!, authority.tenantId, revision]));
  else statements.push(
    { sql: `INSERT INTO operation_request_receipts(action,actor_id,idempotency_key,request_hash,resource_id,created_at) VALUES ('hq_template.create',?,?,?,?,?)`, bindings: [`tenant:${authority.tenantId}`, requestId!, requestHash, templateId, createdAt] },
    { sql: `INSERT INTO hq_templates(id,tenant_id,template_type,extended_type,friend_attribute_type,delivery_type,catalog_type,name,description,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, bindings: [templateId, authority.tenantId, (type === 'scenario' || isDeliveryType(String(type)) || isCatalogType(String(type))) ? 'template' : type === 'friend_field' || type === 'mark' ? 'tag' : type as HqTemplateType, type === 'scenario' ? 'scenario' : null, type === 'friend_field' || type === 'mark' ? type : null, isDeliveryType(String(type))?String(type):null, isCatalogType(String(type))?String(type):null, name, description, authority.actorId, createdAt, createdAt] });
  if (type === 'form') statements.push(guard(validRestaurantCoursesSql, [json, null]));
  statements.push({ sql: `INSERT INTO hq_template_versions(id,tenant_id,template_id,version,definition_json,content_hash,created_by,created_at) VALUES (?,?,?,(SELECT COALESCE(MAX(version),0)+1 FROM hq_template_versions WHERE tenant_id=? AND template_id=?),?,?,?,?)`, bindings: [versionId, authority.tenantId, templateId, authority.tenantId, templateId, json, await digest(json), authority.actorId, createdAt] });
  statements.push({ sql: `UPDATE hq_templates SET name=?,description=?,current_version_id=?,revision=revision+1,updated_at=? WHERE id=? AND tenant_id=?`, bindings: [name, description, versionId, createdAt, templateId, authority.tenantId] }, audit(authority, current ? 'edited' : 'created', templateId));
  statements.push({ sql: 'UPDATE hq_templates SET folder_id=? WHERE id=? AND tenant_id=?', bindings: [folderId as string | null, templateId, authority.tenantId] });
  try { await batch(db, statements); }
  catch {
    if (type === 'form') {
      const valid = await db.prepare(`SELECT ${validRestaurantCoursesSql} AS valid`).bind(json, null).first<{valid:number}>();
      if (!valid?.valid) throw new HqTemplateError('restaurant_course_unavailable', 409);
    }
    if (requestId) {
      const replay = await replayTemplateCreation(db, authority, requestId, requestHash, templateId, name, description, body.folderId as string | null ?? null);
      if (replay) return replay;
      // 受領票が手動削除されても、同じキーで別のリソースを作らない。
      if (await getHqTemplate(db, authority.tenantId, templateId)) throw new HqTemplateError('CREATE_RECEIPT_UNAVAILABLE', 409);
      throw new HqTemplateError('CREATE_UNAVAILABLE', 500);
    }
    throw new HqTemplateError('VERSION_CONFLICT', 409);
  }
  return requestId ? (await replayTemplateCreation(db, authority, requestId, requestHash, templateId, name, description, body.folderId as string | null ?? null))! : templateDetail(db, authority, templateId);
}
export async function deleteTemplate(db: D1Database, authority: HqTemplateAuthority, id: string, revision: unknown) {
  if (!Number.isSafeInteger(revision)) throw new HqTemplateError('INVALID_REVISION');
  await templateDetail(db, authority, id);
  try {
    await batch(db, [guard(`EXISTS(SELECT 1 FROM hq_templates WHERE id=? AND tenant_id=? AND revision=? AND archived_at IS NULL)`, [id, authority.tenantId, revision as number]),
      { sql: `UPDATE hq_templates SET archived_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),revision=revision+1 WHERE id=? AND tenant_id=?`, bindings: [id, authority.tenantId] }, audit(authority, 'deleted', id)]);
  } catch { throw new HqTemplateError('VERSION_CONFLICT', 409); }
  return { id, archived: true };
}
export async function listTemplates(db: D1Database, authority: HqTemplateAuthority, type?: HqTemplateType, status: HqTemplateArchiveStatus = 'active'): Promise<(HqTemplate & HqTemplateListDisplay)[]> {
  const rows = await listHqTemplateDisplaySources(db, authority.tenantId, type, status);
  return rows.map(({ definition_json, distributed_account_names_json, display_type: _displayType, ...template }) => {
    const names = JSON.parse(distributed_account_names_json) as string[];
    return {
      ...template,
      message_type: null,
      ...(template.template_type === 'template' ? messageListFacts(definition_json) : {}),
      ...(() => {
        try {
          if(template.template_type==='template'&&definition_json) {
            const definition=parseMessageTemplateDefinition(JSON.parse(definition_json));
            return {message_type:definition.card?.format??definition.template.messageType};
          }
          if(template.template_type==='tag'&&definition_json) {
            const tag=parseTagDefinition(JSON.parse(definition_json)).tag;
            return {manual_assignment_allowed:tag.manualAssignmentAllowed!==false,
              assignment_method:tag.manualAssignmentAllowed!==false?'手動・自動':'自動'};
          }
          if(template.template_type==='friend_field'&&definition_json) {
            const field=parseFriendFieldDefinition(JSON.parse(definition_json)).field;
            return {assignment_method:({manual:'手動',form:'フォーム',ec:'EC連携',automation:'自動'} as const)[field.source??'manual'],manual_assignment_allowed:!field.ecIsMaster};
          }
          if(template.template_type==='mark'&&definition_json) {
            const mark=parseMarkDefinition(JSON.parse(definition_json)).mark;
            return {display_locations:mark.displayLocations??['inbox','friends','friend_detail'],assignment_method:mark.autoOnInbound?'受信時に自動':'手動',manual_assignment_allowed:true};
          }
          if(template.template_type==='rich_menu'&&definition_json) {
            const menu=parseRichMenuTemplateDefinition({templateVersionId:'list',definitionJson:definition_json},authority.tenantId).richMenu;
            return {display_order:menu.displayOrder??0,display_audience:menu.displayAudience==='all'?'全員':menu.displayAudience==='tag'?`タグが付いた人（${menu.displayTagName}）`:'配布先で店が決める'};
          }
        } catch { /* 壊れた版は未取得。 */ }
        return {message_type:null,manual_assignment_allowed:null,assignment_method:null,display_order:null,display_audience:null};
      })(),
      distributed_account_names: names,
      distributed_account_more: Math.max(0, template.distributed_account_count - names.length),
      kind: template.template_type==='template' && definition_json ? (()=>{try{return templateKind(parseMessageTemplateDefinition(JSON.parse(definition_json)))}catch{return null}})() : null,
      content_summary: templateContentSummary(template.template_type, definition_json, authority.tenantId),
    };
  });
}
export async function preflightDistribution(db: D1Database, authority: HqTemplateAuthority, id: string, accountIds: string[], bucket?: R2Bucket, textOverrides?: unknown, initial?: { versionId: string }) {
  const accounts = await requireTargetAccounts(db, authority, accountIds);
  const { template, definition } = await templateDetail(db, authority, id, initial?.versionId);
  const latest = await db.prepare('SELECT version FROM hq_template_versions WHERE id=? AND tenant_id=? AND template_id=?')
    .bind(template.current_version_id!, authority.tenantId, id).first<{ version: number }>();
  if (!latest) throw new HqTemplateError('NOT_FOUND', 404);
  const overrides = parseTextOverrides(textOverrides,accountIds,template.template_type);
  const input = { templateVersionId: template.current_version_id!, definitionJson: JSON.stringify(definition) };
  const catalogDefinition = isCatalogType(template.template_type) ? parseCatalogDefinition(template.template_type,definition) : null;
  const tagDefinition = template.template_type === 'tag' ? parseTagDefinition(definition) : null;
  const scenarioDefinition = template.template_type === 'scenario' ? parseScenarioDefinition(definition) : null;
  const deliveryDefinition = isDeliveryType(template.template_type) ? await parseDeliveryDefinition(db,template.template_type,definition) : null;
  if(deliveryDefinition && (1+(deliveryDefinition.references?.length??0))*accountIds.length>270) throw new HqTemplateError('INVALID_ACCOUNTS');
  const preflightId = crypto.randomUUID(), expiresAt = new Date(Date.now() + (isCatalogType(template.template_type)?30:15) * 60_000).toISOString();
  const statements: HqTemplateStatement[] = [], stores = [];
  for (const account of accounts) {
    const snapshot = catalogDefinition ? await catalogSnapshot(db,account.id,template.template_type as import('@line-crm/shared').HqCatalogTemplateType) : tagDefinition ? await tagSnapshot(db, account.id) : scenarioDefinition ? await scenarioSnapshot(db,account.id) : deliveryDefinition ? await deliverySnapshot(db,account.id,template.template_type as import('@line-crm/shared').HqDeliveryTemplateType) : null;
    if(deliveryDefinition) await validateDeliveryReferences(db,account.id,template.template_type as import('@line-crm/shared').HqDeliveryTemplateType,deliveryDefinition,Boolean(initial));
    let form: Awaited<ReturnType<typeof inspectFormTemplate>> | null = null;
    let formReferences: Awaited<ReturnType<typeof inspectFormTemplateReferences>> = [];
    if (template.template_type === 'form') {
      try {
        form = await inspectFormTemplate(db, authority, account.id, input);
        formReferences = await inspectFormTemplateReferences(db, authority, account.id, input, form.snapshot);
      } catch (error) {
        if (!(error instanceof FormTemplateError)) throw error;
        if (error.code === 'PUBLIC_IMAGE_REFERENCE_UNSUPPORTED' || error.code === 'FORM_STORE_REFERENCE_UNAVAILABLE') throw new HqTemplateError(error.code, 422, ['definition']);
        if (error.code === 'FORBIDDEN') throw new HqTemplateError('FORBIDDEN', 403);
        if (error.code === 'SELECTION_REQUIRED' || error.code === 'VERSION_CONFLICT' || error.code === 'REFERENCE_UNAVAILABLE') throw new HqTemplateError(error.code === 'SELECTION_REQUIRED' ? 'SELECTION_REQUIRED' : 'VERSION_CONFLICT', 409);
        if (error.code === 'UNSUPPORTED_REFERENCE') throw new HqTemplateError('UNSUPPORTED', 422);
        throw new HqTemplateError('INVALID_DEFINITION');
      }
    }
    let r2: Awaited<ReturnType<typeof inspectR2RuntimeStore>> | null = null;
    if (template.template_type === 'template' || template.template_type === 'rich_menu') {
      if (!bucket) throw new HqTemplateError('UNSUPPORTED', 422);
      try { r2 = await inspectR2RuntimeStore({ db, bucket, authority, templateId: id, templateVersionId: template.current_version_id!, initialDraft: Boolean(initial), textOverride: overrides.get(account.id) }, account.id); }
      catch (error) { rethrowR2(error); }
    }
    const items = catalogDefinition ? inspectCatalog(catalogDefinition,snapshot!,template.template_type as import('@line-crm/shared').HqCatalogTemplateType) : deliveryDefinition ? [...inspectDelivery(deliveryDefinition,snapshot!,template.template_type as import('@line-crm/shared').HqDeliveryTemplateType),...await deliveryReferenceItems(db,account.id,deliveryDefinition,Boolean(initial))] : scenarioDefinition ? inspectScenario(scenarioDefinition,snapshot!) : tagDefinition ? inspectTags(tagDefinition, snapshot!) : form
      ? [{ sourceId: form.sourceId, itemKind: form.itemKind, name: form.name, targetId: form.targetId, expectedRevision: form.expectedRevision, duplicate: form.duplicate, allowedModes: [...form.allowedModes] }, ...formReferences.map(item => ({ ...item, allowedModes: [...item.allowedModes] }))]
      : r2!.items;
    const storeId = crypto.randomUUID(), token = tagDefinition || scenarioDefinition || deliveryDefinition || catalogDefinition ? `hqts1.${await digest(snapshot!)}` : form?.snapshotToken ?? r2!.snapshotToken;
    statements.push({ sql: `INSERT INTO hq_template_preflights(id,tenant_id,template_id,template_version_id,target_account_id,distribution_mode,idempotency_fingerprint,snapshot_token,status,created_by,expires_at,text_override) VALUES (?,?,?,?,?,'create',?,?,'ready',?,?,?)`, bindings: [storeId, authority.tenantId, id, template.current_version_id!, account.id, preflightId, token, authority.actorId, expiresAt, overrides.get(account.id) ?? null] });
    for (const item of items) {
      const fixedRichReferenceMode = (isCatalogType(template.template_type) && item.sourceId!==template.template_type) || (isDeliveryType(template.template_type) && item.sourceId!==template.template_type) || (template.template_type === 'rich_menu' && item.itemKind !== 'rich_menu') || (template.template_type === 'template' && item.sourceId !== `template:${(definition as {template:{id:string}}).template.id}` && item.itemKind !== 'media') ? item.allowedModes[0] : 'create';
      statements.push({ sql: `INSERT INTO hq_template_preflight_resolutions(preflight_id,tenant_id,template_id,template_version_id,target_account_id,idempotency_fingerprint,snapshot_token,source_id,item_kind,resolution_mode,target_id,expected_revision) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, bindings: [storeId, authority.tenantId, id, template.current_version_id!, account.id, preflightId, token, item.sourceId, item.itemKind, fixedRichReferenceMode, item.targetId, item.expectedRevision] });
    }
    const targetVersion = await targetDistributionVersion(db, authority.tenantId, id, account.id, latest.version);
    stores.push({ accountId: account.id, accountName: account.name, items, targetVersion,...(catalogDefinition?{warnings:catalogWarnings(catalogDefinition,snapshot!,template.template_type as import('@line-crm/shared').HqCatalogTemplateType)}:{}), ...(form ? {warnings: await formTemplateWarnings(db, account.id, input)} : {}), ...(overrides.has(account.id) ? {textOverride:overrides.get(account.id)} : {}) });
  }
  for (const account of accounts) statements.unshift(guard(`EXISTS(SELECT 1 FROM line_accounts WHERE id=? AND tenant_id=? AND is_active=1 AND archived_at IS NULL)`, [account.id, authority.tenantId]));
  if (initial) statements.push({ sql: 'UPDATE hq_template_preflights SET initial_insert=1 WHERE tenant_id=? AND idempotency_fingerprint=?', bindings: [authority.tenantId, preflightId] });
  await batch(db, statements);
  return { preflightId, expiresAt, stores };
}
function resultReason(status: string): string | null {
  if (status === 'version_conflict') return VERSION_CONFLICT_MESSAGE;
  if (status === 'failed') return 'この店舗には配布できませんでした。もう一度確認してください';
  if (status === 'unsupported') return 'この種類の配布はまだ利用できません';
  return null;
}
export async function distributionResult(db: D1Database, authority: HqTemplateAuthority, templateId: string, runId: string, bucket?: R2Bucket) {
  const run = await db.prepare(`SELECT id,status FROM hq_template_distribution_runs WHERE id=? AND tenant_id=? AND template_id=?`).bind(runId, authority.tenantId, templateId).first<{ id: string; status: string }>();
  if (!run) throw new HqTemplateError('NOT_FOUND', 404);
  const rows = (await db.prepare(`SELECT * FROM hq_template_distribution_results WHERE run_id=? AND tenant_id=? ORDER BY target_account_id`).bind(runId, authority.tenantId).all<HqTemplateDistributionResult>()).results;
  const stores = [];
  for (const row of rows) {
    if (bucket && row.status !== 'pending' && row.status !== 'staged') {
      await reconcileFailedOwnedImages({ db, bucket, authority, templateId, templateVersionId: row.template_version_id }, runId, row.target_account_id);
    }
    const cleanup = await db.prepare(`SELECT COUNT(*) AS count FROM hq_template_owned_r2_keys WHERE run_id=? AND tenant_id=? AND target_account_id=? AND state IN ('staged','cleanup_pending')`).bind(runId, authority.tenantId, row.target_account_id).first<{ count: number }>();
    const resolutions = (await db.prepare(`SELECT r.resolution_mode,r.item_kind,r.source_id,v.definition_json,COALESCE(t.catalog_type,t.delivery_type,t.friend_attribute_type,t.extended_type,t.template_type) AS template_type FROM hq_template_preflight_resolutions r JOIN hq_templates t ON t.id=r.template_id AND t.tenant_id=r.tenant_id JOIN hq_template_versions v ON v.id=r.template_version_id AND v.tenant_id=r.tenant_id WHERE r.preflight_id=? AND r.tenant_id=?`).bind(row.preflight_id, authority.tenantId).all<{ resolution_mode: string; item_kind: string; template_type: string;source_id:string;definition_json:string }>()).results;
    const counts: { created: number; overwritten: number; aliased: number; reused?: number } = { created: 0, overwritten: 0, aliased: 0 };
    if (row.status === 'succeeded') for (const r of resolutions) {
      if((isDeliveryType(r.template_type)||isCatalogType(r.template_type)) && r.source_id!==r.template_type) { counts.reused=(counts.reused??0)+1; continue; }
      if ((r.template_type === 'rich_menu' && r.item_kind !== 'rich_menu') || (r.template_type === 'template' && r.item_kind!=='media' && r.source_id!==`template:${JSON.parse(r.definition_json).template?.id}`)) {
        if (r.resolution_mode === 'create') counts.created++;
        else counts.reused = (counts.reused ?? 0) + 1;
        continue;
      }
      if (r.resolution_mode === 'create') counts.created++; else if (r.resolution_mode === 'overwrite') counts.overwritten++; else counts.aliased++;
    }
    stores.push({ accountId: row.target_account_id, status: row.status, reason: row.error_code==='PREFLIGHT_EXPIRED'?'確かめの期限が切れました。もう一度確かめてください':resultReason(row.status), cleanupPending: Number(cleanup?.count ?? 0) > 0, counts,
      createdName: row.status === 'succeeded' ? row.created_name ?? null : null });
  }
  const targets = (await db.prepare(`SELECT target_account_id FROM hq_template_preflights WHERE tenant_id=? AND template_id=? AND idempotency_fingerprint=? ORDER BY target_account_id`).bind(authority.tenantId, templateId, runId).all<{ target_account_id: string }>()).results;
  for (const p of targets) if (!stores.some(s => s.accountId === p.target_account_id)) stores.push({ accountId: p.target_account_id, status: 'pending', reason: null, counts: { created: 0, overwritten: 0, aliased: 0 }, createdName: null });
  stores.sort((a,b) => a.accountId.localeCompare(b.accountId));
  return { runId, status: run.status, stores };
}

export async function distributeTemplate(db: D1Database, authority: HqTemplateAuthority, templateId: string, runId: string, selections: DistributionSelection[], bucket?: R2Bucket, publicBaseUrl?: string, initialResourceCommit?: import('./contract.js').HqInitialResourceCommit) {
  const preflights = (await db.prepare(`SELECT * FROM hq_template_preflights WHERE tenant_id=? AND template_id=? AND idempotency_fingerprint=? ORDER BY target_account_id`).bind(authority.tenantId, templateId, runId).all<HqTemplatePreflight>()).results;
  if (!preflights.length || preflights.some(p => p.created_by !== authority.actorId)) throw new HqTemplateError('NOT_FOUND', 404);
  if (preflights.some(p => p.status === 'expired')) throw new HqTemplateError('PREFLIGHT_EXPIRED', 409);
  await requireTargetAccounts(db, authority, preflights.map(p => p.target_account_id));
  const { template } = await templateDetail(db, authority, templateId);
  if (preflights.some(p => p.template_version_id !== preflights[0].template_version_id)) throw new HqTemplateError('INVALID_PREFLIGHT', 409);
  const version = await db.prepare(`SELECT definition_json FROM hq_template_versions WHERE id=? AND tenant_id=? AND template_id=?`).bind(preflights[0].template_version_id, authority.tenantId, templateId).first<{ definition_json: string }>();
  if (!version) throw new HqTemplateError('NOT_FOUND', 404);
  const stored = (await db.prepare(`SELECT * FROM hq_template_preflight_resolutions WHERE tenant_id=? AND template_id=? AND idempotency_fingerprint=? ORDER BY target_account_id,source_id`).bind(authority.tenantId, templateId, runId).all<HqTemplatePreflightResolution>()).results;
  if (selections.length !== stored.length || new Set(selections.map(s => JSON.stringify([s.accountId, s.sourceId]))).size !== stored.length) throw new HqTemplateError('SELECTION_REQUIRED', 409);
  for (const selected of selections) {
    const row = stored.find(r => r.target_account_id === selected.accountId && r.source_id === selected.sourceId);
    if (!row || !['create', 'overwrite', 'alias'].includes(selected.mode)) throw new HqTemplateError('SELECTION_REQUIRED', 409);
    if((isDeliveryType(template.template_type)||isCatalogType(template.template_type)) && selected.sourceId!==template.template_type && selected.mode!=='overwrite') throw new HqTemplateError('SELECTION_CHANGED',409);
    const p = preflights.find(p => p.id === row.preflight_id)!;
    if (p.status === 'consumed') { if ((template.template_type === 'tag' || template.template_type === 'scenario' || isDeliveryType(template.template_type) || isCatalogType(template.template_type)) && row.resolution_mode !== selected.mode) throw new HqTemplateError('SELECTION_CHANGED', 409); }
    else if ((template.template_type === 'rich_menu' && row.item_kind !== 'rich_menu') || (template.template_type === 'template' && row.source_id !== `template:${JSON.parse(version.definition_json).template.id}` && row.item_kind !== 'media')) {
      if (row.resolution_mode !== selected.mode) throw new HqTemplateError('SELECTION_CHANGED', 409);
    } else if (row.target_id ? selected.mode === 'create' : selected.mode !== 'create') throw new HqTemplateError('SELECTION_REQUIRED', 409);
  }
  if (template.template_type !== 'tag' && template.template_type !== 'scenario' && !isDeliveryType(template.template_type) && !isCatalogType(template.template_type)) {
    if ((template.template_type === 'template' || template.template_type === 'rich_menu') && !bucket) throw new HqTemplateError('UNSUPPORTED', 422);
    for (const p of preflights) {
      const selected = selections.filter(selection => selection.accountId === p.target_account_id).map(selection => {
        const row = stored.find(resolution => resolution.preflight_id === p.id && resolution.source_id === selection.sourceId)!;
        const base = { sourceId: selection.sourceId, itemKind: row.item_kind, mode: selection.mode };
        return template.template_type === 'form' || template.template_type === 'rich_menu' || template.template_type === 'template' ? { ...base, targetId: row.target_id ?? undefined, expectedRevision: row.expected_revision ?? undefined } : base;
      });
      const root = selected.find(resolution => resolution.itemKind === template.template_type && (template.template_type!=='template' || resolution.sourceId===`template:${JSON.parse(version.definition_json).template.id}`));
      if (!root) throw new HqTemplateError('SELECTION_REQUIRED', 409);
      try {
        const context = {
          tenantId: authority.tenantId,
          targetAccountId: p.target_account_id,
          preflightId: p.id,
          idempotencyFingerprint: runId,
          snapshotToken: p.snapshot_token as HqTemplateSnapshotToken,
          mode: root.mode,
          resolutions: selected,
        } as const;
        if (template.template_type === 'form') await executeFormStore({ db, authority, templateId, runId, context,initialResourceCommit });
        else await executeR2RuntimeStore({ db, bucket: bucket!, authority, templateId, runId, context, publicBaseUrl,initialResourceCommit });
      } catch (error) {
        if (!(error instanceof HqRuntimeError) && !(error instanceof HqR2RuntimeError)) throw error;
        if (error.code === 'FORBIDDEN') throw new HqTemplateError('FORBIDDEN', 403);
        if (error.code === 'SELECTION_REQUIRED' || error.code === 'SELECTION_CHANGED') throw new HqTemplateError(error.code, 409);
        if (error.code === 'INVALID_PREFLIGHT' || error.code === 'VERSION_CONFLICT') throw new HqTemplateError('VERSION_CONFLICT', 409);
        throw new HqTemplateError('RESULT_UNAVAILABLE', 500);
      }
    }
    const result = await distributionResult(db, authority, templateId, runId, bucket);
    if (result.stores.some(store => store.status === 'pending' || store.status === 'staged')) return result;
    const succeeded = result.stores.filter(store => store.status === 'succeeded').length;
    const status = succeeded === preflights.length ? 'completed' : succeeded ? 'partial' : 'failed';
    await db.prepare(`UPDATE hq_template_distribution_runs SET status=?,finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND tenant_id=? AND status='running'`).bind(status, runId, authority.tenantId).run();
    return distributionResult(db, authority, templateId, runId, bucket);
  }
  const definition = JSON.parse(version.definition_json);
  const storeSnapshot = isCatalogType(template.template_type) ? (db:D1Database,accountId:string)=>catalogSnapshot(db,accountId,template.template_type as import('@line-crm/shared').HqCatalogTemplateType) : isDeliveryType(template.template_type) ? (db:D1Database,accountId:string)=>deliverySnapshot(db,accountId,template.template_type as import('@line-crm/shared').HqDeliveryTemplateType) : template.template_type === 'scenario' ? scenarioSnapshot : tagSnapshot;
  await beginHqTemplateDistributionRun(db, { id: runId, tenantId: authority.tenantId, templateId, templateVersionId: preflights[0].template_version_id, idempotencyFingerprint: runId, createdBy: authority.actorId });
  // 店舗への書込前に選択全体を確保し、同時要求や最初の店舗で中断した実行も同じ判断に固定する。
  const requestHash = await digest(JSON.stringify([...selections].sort((a,b) => JSON.stringify([a.accountId,a.sourceId]).localeCompare(JSON.stringify([b.accountId,b.sourceId]))).map(s => [s.accountId,s.sourceId,s.mode])));
  const sourceId = JSON.stringify([authority.tenantId, runId]);
  await db.prepare(`INSERT OR IGNORE INTO audit_events(id,source_kind,source_id,tenant_id,category,actor_principal_id,actor_role,action,target_kind,target_id,result,after_json) VALUES (?,'hq_template_distribution_request',?,?,'business',?,?,'hq_template.distribution_started','hq_template',?,'success',?)`).bind(crypto.randomUUID(), sourceId, authority.tenantId, authority.actorId, authority.role, templateId, JSON.stringify({ runId, requestHash })).run();
  const claim = await db.prepare(`SELECT after_json FROM audit_events WHERE source_kind='hq_template_distribution_request' AND source_id=? AND tenant_id=? AND actor_principal_id=?`).bind(sourceId, authority.tenantId, authority.actorId).first<{ after_json: string }>();
  if (!claim || JSON.parse(claim.after_json).requestHash !== requestHash) throw new HqTemplateError('SELECTION_CHANGED', 409);
  for (const p of preflights) {
    const existing = await db.prepare(`SELECT status FROM hq_template_distribution_results WHERE run_id=? AND tenant_id=? AND target_account_id=?`).bind(runId, authority.tenantId, p.target_account_id).first();
    if (existing) continue;
    const selected: HqTemplateResolution[] = selections.filter(s => s.accountId === p.target_account_id).map(s => ({ sourceId: s.sourceId, itemKind: stored.find(r => r.preflight_id === p.id && r.source_id === s.sourceId)!.item_kind, mode: s.mode }));
    const snapshot = await storeSnapshot(db, p.target_account_id);
    let expired = p.expires_at === null || p.expires_at <= new Date().toISOString();
    const conflict = expired || `hqts1.${await digest(snapshot)}` !== p.snapshot_token;
    let status = conflict ? 'version_conflict' : 'succeeded';
    let plan: ReturnType<typeof planTags> | null = null;
    if (!conflict) {
      try {
        if(template.template_type==='booking_menu'){
          const adapter=getHqTemplateAdapter('booking_menu',{db,authority}),input={templateVersionId:p.template_version_id,definitionJson:version.definition_json};
          const context={tenantId:authority.tenantId,targetAccountId:p.target_account_id,preflightId:p.id,idempotencyFingerprint:runId,mode:p.distribution_mode,snapshotToken:p.snapshot_token as HqTemplateSnapshotToken,resolutions:selected};
          const refs=await adapter.extractReferences(input);if(refs.kind!=='OK')throw new HqTemplateError('UNSUPPORTED',422);
          await adapter.verifyReferences(context,refs.value);const commit=await adapter.buildCommitPlan(context,input,{});if(commit.kind!=='OK')throw new HqTemplateError('UNSUPPORTED',422);
          plan={statements:[...commit.value.dbCommit],resolutions:[...commit.value.resolutions],counts:{created:1,overwritten:0,aliased:0}};
        }
        else if(isCatalogType(template.template_type)) plan = planCatalog(p.target_account_id,parseCatalogDefinition(template.template_type,definition),snapshot,template.template_type,selected,{templateId,versionId:p.template_version_id});
        else if(isDeliveryType(template.template_type)) plan = await planDelivery(db,p.target_account_id,await parseDeliveryDefinition(db,template.template_type,definition),snapshot,template.template_type,selected,p.initial_insert===1);
        else if (template.template_type === 'scenario') plan = planScenario(p.target_account_id,parseScenarioDefinition(definition),snapshot,selected);
        else {
        const adapter = getHqTemplateAdapter('tag', { db, authority });
        const ok = <T>(result: HqTemplateAdapterResult<T>): T => { if (result.kind !== 'OK') throw new HqTemplateError('UNSUPPORTED', 422); return result.value; };
        const input = { templateVersionId: p.template_version_id, definitionJson: JSON.stringify(definition) };
        const context = { tenantId: authority.tenantId, targetAccountId: p.target_account_id, preflightId: p.id, idempotencyFingerprint: runId, mode: p.distribution_mode, snapshotToken: p.snapshot_token as HqTemplateSnapshotToken, resolutions: selected };
        const refs = ok(await adapter.extractReferences(input));
        const verified = ok(await adapter.verifyReferences(context, refs));
        const duplicates = ok(await adapter.detectDuplicates(context, verified));
        const ids = ok(await adapter.buildIdMap(context, verified, duplicates));
        const commit = ok(await adapter.buildCommitPlan(context, input, ids));
        plan = { statements: [...commit.dbCommit], resolutions: [...commit.resolutions], counts: { created: 0, overwritten: 0, aliased: 0 } };
        }
      }
      catch (error) { status = error instanceof HqTemplateError && error.code === 'VERSION_CONFLICT' ? 'version_conflict' : 'failed'; }
    }
    const persist = async (finalStatus: string, commit: HqTemplateStatement[], resolutions: readonly HqTemplateResolution[]) => {
      const statements = [guard(`EXISTS(SELECT 1 FROM hq_template_preflights WHERE id=? AND tenant_id=? AND status='ready') AND NOT EXISTS(SELECT 1 FROM hq_template_distribution_results WHERE run_id=? AND tenant_id=? AND target_account_id=?)`, [p.id, authority.tenantId, runId, authority.tenantId, p.target_account_id])];
      if (finalStatus === 'succeeded') statements.push(guard(`EXISTS(SELECT 1 FROM hq_template_preflights WHERE id=? AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))`, [p.id]));
      // 各店舗の原子的トランザクション内でも統括の所有権を確認する。
      statements.push(guard(`EXISTS(SELECT 1 FROM line_accounts WHERE id=? AND tenant_id=? AND is_active=1 AND archived_at IS NULL)`, [p.target_account_id, authority.tenantId]));
      for (const r of resolutions) statements.push({ sql: `UPDATE hq_template_preflight_resolutions SET resolution_mode=?,target_id=COALESCE(?,target_id),alias_name=?,expected_revision=COALESCE(?,expected_revision) WHERE preflight_id=? AND tenant_id=? AND source_id=?`, bindings: [r.mode, r.targetId ?? null, r.mode === 'alias' ? r.aliasName ?? 'pending' : null, r.expectedRevision ?? null, p.id, authority.tenantId, r.sourceId] });
      statements.push({ sql: `INSERT INTO hq_template_distribution_results(run_id,tenant_id,template_id,template_version_id,target_account_id,preflight_id,idempotency_fingerprint,snapshot_token,status,error_code,finished_at) VALUES (?,?,?,?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))`, bindings: [runId, authority.tenantId, templateId, p.template_version_id, p.target_account_id, p.id, runId, p.snapshot_token, finalStatus, expired?'PREFLIGHT_EXPIRED':null] }, ...commit, audit(authority, 'distributed', templateId, p.target_account_id, finalStatus === 'succeeded' ? 'success' : 'failed', runId));
      if (finalStatus === 'succeeded' && initialResourceCommit) statements.push(...await initialResourceCommit(p.target_account_id,resolutions));
      if (finalStatus === 'succeeded') statements.push(captureDistributionName(runId, authority.tenantId, p.target_account_id));
      return batch(db, statements);
    };
    try { await persist(status, plan?.statements ?? [], plan?.resolutions ?? selected); }
    catch {
      const committed = await db.prepare(`SELECT status FROM hq_template_distribution_results WHERE run_id=? AND tenant_id=? AND target_account_id=?`).bind(runId, authority.tenantId, p.target_account_id).first();
      if (committed) continue;
      expired = !p.expires_at || p.expires_at <= new Date().toISOString();
      status = expired || `hqts1.${await digest(await storeSnapshot(db, p.target_account_id))}` !== p.snapshot_token ? 'version_conflict' : 'failed';
      try { await persist(status, [], plan?.resolutions ?? selected); } catch { throw new HqTemplateError('RESULT_UNAVAILABLE', 500); }
    }
  }
  const result = await distributionResult(db, authority, templateId, runId);
  if (result.stores.some(s => s.status === 'pending' || s.status === 'staged')) return result;
  const succeeded = result.stores.filter(s => s.status === 'succeeded').length;
  const status = succeeded === preflights.length ? 'completed' : succeeded ? 'partial' : 'failed';
  await db.prepare(`UPDATE hq_template_distribution_runs SET status=?,finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND tenant_id=? AND status='running'`).bind(status, runId, authority.tenantId).run();
  return distributionResult(db, authority, templateId, runId);
}

export async function templateVersions(db: D1Database, authority: HqTemplateAuthority, id: string) {
  await templateDetail(db, authority, id);
  const rows = await db.prepare(`SELECT v.id,v.version,v.created_by,s.name AS creator_name,v.created_at,
      NOT EXISTS(SELECT 1 FROM hq_template_distribution_results r WHERE r.tenant_id=v.tenant_id AND r.template_id=v.template_id
        AND r.template_version_id=v.id AND r.status='succeeded' AND NOT EXISTS (SELECT 1 FROM hq_template_preflight_resolutions skipped WHERE skipped.preflight_id=r.preflight_id AND skipped.tenant_id=r.tenant_id AND skipped.friend_attribute_mode='skip')) AS is_draft,
      v.id=t.current_version_id AS is_current
    FROM hq_template_versions v JOIN hq_templates t ON t.id=v.template_id AND t.tenant_id=v.tenant_id
    LEFT JOIN staff_members s ON s.id=v.created_by AND s.tenant_id=v.tenant_id
    WHERE v.tenant_id=? AND v.template_id=? ORDER BY v.version DESC`).bind(authority.tenantId,id).all<{
      id:string;version:number;created_by:string|null;creator_name:string|null;created_at:string;is_draft:number;is_current:number
    }>();
  return rows.results.map(r=>({...r,is_draft:!!r.is_draft,is_current:!!r.is_current}));
}
async function historicalVersion(db: D1Database, authority: HqTemplateAuthority, id: string, version: unknown) {
  if (!Number.isSafeInteger(version) || Number(version)<1) throw new HqTemplateError('INVALID_VERSION');
  const row=await db.prepare('SELECT definition_json,content_hash FROM hq_template_versions WHERE tenant_id=? AND template_id=? AND version=?')
    .bind(authority.tenantId,id,Number(version)).first<{definition_json:string;content_hash:string}>();
  if(!row) throw new HqTemplateError('NOT_FOUND',404);
  return row;
}
export async function compareTemplateVersions(db: D1Database, authority: HqTemplateAuthority, id: string, from: number, to: number) {
  const versions=await templateVersions(db,authority,id);
  const a=await historicalVersion(db,authority,id,from),b=await historicalVersion(db,authority,id,to);
  return {from:{version:versions.find(v=>v.version===from)!,definition:JSON.parse(a.definition_json) as unknown},
    to:{version:versions.find(v=>v.version===to)!,definition:JSON.parse(b.definition_json) as unknown},changed:a.content_hash!==b.content_hash};
}
export async function restoreTemplateVersion(db: D1Database, authority: HqTemplateAuthority, id: string, version: unknown, revision: unknown) {
  const current=await templateDetail(db,authority,id);
  const old=await historicalVersion(db,authority,id,version);
  // 過去の版を書き換えず、新しい版として保存する。通常保存と同じ競合・監査・検証を通す。
  return saveTemplate(db,authority,{name:current.template.name,description:current.template.description,
    definition:JSON.parse(old.definition_json),expectedRevision:revision},id);
}
export async function templateReceivedVersions(db: D1Database, authority: HqTemplateAuthority, id: string) {
  const {template}=await templateDetail(db,authority,id);
  const latest=await db.prepare('SELECT version FROM hq_template_versions WHERE tenant_id=? AND template_id=? AND id=?')
    .bind(authority.tenantId,id,template.current_version_id).first<{version:number}>();
  const rows=await db.prepare(`WITH ranked AS (
      SELECT r.*, ROW_NUMBER() OVER (PARTITION BY target_account_id ORDER BY finished_at DESC,started_at DESC,rowid DESC) AS position
      FROM hq_template_distribution_results r WHERE tenant_id=? AND template_id=? AND status='succeeded' AND NOT EXISTS (SELECT 1 FROM hq_template_preflight_resolutions skipped WHERE skipped.preflight_id=r.preflight_id AND skipped.tenant_id=r.tenant_id AND skipped.friend_attribute_mode='skip'))
    SELECT a.id,a.name,r.finished_at,v.version FROM ranked r
    JOIN line_accounts a ON a.id=r.target_account_id AND a.tenant_id=r.tenant_id
    JOIN hq_template_versions v ON v.id=r.template_version_id AND v.tenant_id=r.tenant_id AND v.template_id=r.template_id
    WHERE r.position=1 ORDER BY a.name,a.id`).bind(authority.tenantId,id).all<{id:string;name:string;finished_at:string|null;version:number}>();
  return rows.results.map(r=>({accountId:r.id,accountName:r.name,receivedAt:r.finished_at,
    targetVersion:{version:r.version,latestVersion:latest!.version,status:r.version===latest!.version?'latest' as const:'older' as const,
      label:`版${r.version}${r.version===latest!.version?'（いまの版）':''}`}}));
}
