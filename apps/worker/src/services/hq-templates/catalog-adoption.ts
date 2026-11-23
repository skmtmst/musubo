import type { HqCatalogTemplateType } from '@line-crm/shared';
import type { HqTemplateStatement } from '@line-crm/db';
import { bindingUnchangedCondition, findBindingForTarget, type CatalogBindingByTarget } from './catalog-binding.js';
import { CATALOG_HASH_VERSION } from './catalog-record.js';
import { bindingAppliedStatement, catalogApplyPlan, readCatalogTarget, targetUnchangedCondition, type CatalogTargetState, type CatalogVersionInput } from './catalog-target.js';
import { guardStatement, loadCatalogVersions } from './redistribution.js';
import { redistributionNotices } from './redistribution-decision.js';
import { HqTemplateError } from './tag.js';

/** 店の画面へ返す業務エラー。店の文・個人情報は入れない。 */
export class CatalogAdoptionError extends Error {
  constructor(public code: string, public status: 400 | 403 | 404 | 409 | 422) { super(code); }
}

export interface CatalogActor { id: string; role: string }

const adoptionCodes: Record<string, { code: string; status: 409 | 422 }> = {
  HANDGIFT_PROTECTED: { code: 'handgift_protected', status: 409 }, REFERENCE_UNAVAILABLE: { code: 'reference_unavailable', status: 409 },
  REWARD_KIND_CHANGED: { code: 'reward_kind_changed', status: 409 }, BOOKING_NOT_USED: { code: 'booking_not_used', status: 422 },
  VERSION_CONFLICT: { code: 'hq_target_changed', status: 409 }, INVALID_DEFINITION: { code: 'hq_version_invalid', status: 409 },
};

async function templateActive(db: D1Database, binding: CatalogBindingByTarget): Promise<boolean> {
  return Boolean(await db.prepare('SELECT 1 AS active FROM hq_templates WHERE id=? AND tenant_id=? AND archived_at IS NULL').bind(binding.templateId, binding.tenantId).first());
}

function storeEdited(binding: CatalogBindingByTarget, target: CatalogTargetState): boolean {
  return binding.hashVersion !== CATALOG_HASH_VERSION || binding.appliedSnapshotHash !== target.hash || target.customized;
}

/** 店の物が本部のどの版から来て、新しい版が届いているか。画面の「統括から」「この店専用」「新しい版があります」の元。 */
export async function catalogHqStatus(db: D1Database, kind: HqCatalogTemplateType, accountId: string, targetId: string) {
  const binding = await findBindingForTarget(db, accountId, kind, targetId);
  const target = await readCatalogTarget(db, kind, accountId, targetId);
  if (!target) throw new CatalogAdoptionError('not_found', 404);
  if (!binding) return { bound: false as const, detached: null };
  // 本部でひな形を削除した後と、出所の欄が対応表と食い違う物は店の物として扱い、「統括から」の札も新しい版の知らせも出さない。
  const active = await templateActive(db, binding);
  if (!active) return { bound: false as const, detached: 'template_archived' as const };
  if (target.originTemplateId !== binding.templateId || target.originVersionId !== binding.appliedVersionId) return { bound: false as const, detached: 'origin_mismatch' as const };
  const versions = await loadCatalogVersions(db, binding.tenantId, binding.templateId, kind, [binding.appliedVersionId, binding.pendingVersionId, binding.dismissedVersionId]);
  const applied = versions.get(binding.appliedVersionId), pending = binding.pendingVersionId ? versions.get(binding.pendingVersionId) ?? null : null;
  const dismissed = binding.dismissedVersionId ? versions.get(binding.dismissedVersionId) ?? null : null;
  const miles = (version: CatalogVersionInput | null | undefined) => kind === 'mileage_reward' && version ? Number((version.definition.settings as { requiredMiles: number }).requiredMiles) : null;
  return {
    bound: true as const, templateId: binding.templateId,
    customized: storeEdited(binding, target), published: target.published,
    appliedVersion: applied ? { id: applied.id, version: applied.version } : null,
    dismissedVersion: dismissed ? { id: dismissed.id, version: dismissed.version } : null,
    pendingVersion: pending ? { id: pending.id, version: pending.version, notices: redistributionNotices({
      bindingTemplateId: binding.templateId, bindingVersionId: binding.appliedVersionId, originTemplateId: target.originTemplateId, originVersionId: target.originVersionId,
      appliedVersion: applied?.version ?? 0, candidateVersion: pending.version, pendingVersion: null, dismissedVersion: null, targetExists: true, targetActive: true,
      appliedHash: binding.appliedSnapshotHash, currentHash: binding.hashVersion === CATALOG_HASH_VERSION ? target.hash : `incomparable:${target.hash}`,
      publishedReward: target.published, previousRequiredMiles: miles(applied), nextRequiredMiles: miles(pending), customized: target.customized,
    }) } : null,
    rowVersion: binding.rowVersion,
  };
}

function auditStatement(binding: CatalogBindingByTarget, kind: HqCatalogTemplateType, accountId: string, targetId: string, actor: CatalogActor, action: string, versionId: string): HqTemplateStatement {
  return { sql: `INSERT INTO audit_events(id,tenant_id,line_account_id,category,actor_principal_id,actor_role,action,target_kind,target_id,result,after_json) VALUES (?,?,?,'business',?,?,?,?,?,'success',?)`,
    bindings: [crypto.randomUUID(), binding.tenantId, accountId, actor.id, actor.role, action, kind, targetId, JSON.stringify({ templateId: binding.templateId, versionId })] };
}

async function batch(db: D1Database, statements: readonly HqTemplateStatement[]) {
  return db.batch(statements.map(statement => db.prepare(statement.sql).bind(...statement.bindings)));
}

async function requirePending(db: D1Database, kind: HqCatalogTemplateType, accountId: string, targetId: string, versionId: unknown): Promise<CatalogBindingByTarget> {
  if (typeof versionId !== 'string' || !versionId) throw new CatalogAdoptionError('hq_version_required', 400);
  const binding = await findBindingForTarget(db, accountId, kind, targetId);
  if (!binding) throw new CatalogAdoptionError('hq_binding_not_found', 404);
  // 画面が見ていた版と違えば、どちらも書かずに読み直してもらう。
  if (binding.pendingVersionId !== versionId) throw new CatalogAdoptionError('hq_version_conflict', 409);
  return binding;
}

/*
 * ［取り込む］本部の新しい版を店の物へ当てる。店が変えた所も本部の中身に戻し「統括から」にする。
 * 受付中か・並び順・担当・在庫・引換コード・既存の予約と交換の記録はそのまま残す。
 * 公開中の景品は下書きに入れ、お客さまに出すかは店が公開で決める（公開の確かめと代理ログインの制限は既存の公開の口に従う）。
 */
export async function adoptCatalogVersion(db: D1Database, input: { kind: HqCatalogTemplateType; accountId: string; targetId: string; versionId: unknown; actor: CatalogActor }) {
  const { kind, accountId, targetId } = input;
  const binding = await requirePending(db, kind, accountId, targetId, input.versionId);
  if (!await templateActive(db, binding)) throw new CatalogAdoptionError('hq_template_unavailable', 409);
  const target = await readCatalogTarget(db, kind, accountId, targetId);
  if (!target) throw new CatalogAdoptionError('not_found', 404);
  // 正本は対応表。出所の欄が食い違う時は、どちらが正しいか決められないので書かない。
  if (target.originTemplateId !== binding.templateId || target.originVersionId !== binding.appliedVersionId) throw new CatalogAdoptionError('hq_origin_conflict', 409);
  const versions = await loadCatalogVersions(db, binding.tenantId, binding.templateId, kind, [binding.appliedVersionId, binding.pendingVersionId]);
  const applied = versions.get(binding.appliedVersionId), candidate = versions.get(binding.pendingVersionId!);
  if (!applied || !candidate) throw new CatalogAdoptionError('hq_version_conflict', 409);
  let plan: Awaited<ReturnType<typeof catalogApplyPlan>>;
  try { plan = await catalogApplyPlan(db, { tenantId: binding.tenantId, templateId: binding.templateId, target, applied, candidate }); }
  catch (error) {
    const mapped = error instanceof HqTemplateError ? adoptionCodes[error.code] : undefined;
    if (mapped) throw new CatalogAdoptionError(mapped.code, mapped.status);
    throw error;
  }
  try {
    await batch(db, [
      guardStatement(bindingUnchangedCondition({ tenantId: binding.tenantId, templateId: binding.templateId, accountId, rowVersion: binding.rowVersion })),
      guardStatement(targetUnchangedCondition(target)),
      guardStatement({ sql: 'EXISTS(SELECT 1 FROM hq_templates WHERE id=? AND tenant_id=? AND archived_at IS NULL)', bindings: [binding.templateId, binding.tenantId] }),
      ...plan.statements,
      bindingAppliedStatement({ tenantId: binding.tenantId, templateId: binding.templateId, accountId, rowVersion: binding.rowVersion, versionId: candidate.id, hash: plan.hash }),
      auditStatement(binding, kind, accountId, targetId, input.actor, 'hq_template.store_adopted', candidate.id),
    ]);
  } catch {
    throw new CatalogAdoptionError('hq_version_conflict', 409);
  }
  return { adoptedVersionId: candidate.id, version: candidate.version, publishRequired: plan.publishRequired };
}

/** ［今のまま］その版の知らせだけを消す。次の版が届けばまた知らせる。店の物は書き換えない。 */
export async function dismissCatalogVersion(db: D1Database, input: { kind: HqCatalogTemplateType; accountId: string; targetId: string; versionId: unknown; actor: CatalogActor }) {
  const { kind, accountId, targetId } = input;
  const binding = await requirePending(db, kind, accountId, targetId, input.versionId);
  const versionId = binding.pendingVersionId!;
  try {
    await batch(db, [
      guardStatement({ sql: 'EXISTS(SELECT 1 FROM hq_template_store_bindings WHERE tenant_id=? AND template_id=? AND target_account_id=? AND row_version=? AND pending_version_id=?)',
        bindings: [binding.tenantId, binding.templateId, accountId, binding.rowVersion, versionId] }),
      { sql: `UPDATE hq_template_store_bindings SET dismissed_version_id=pending_version_id,pending_version_id=NULL,row_version=row_version+1,updated_at=?
          WHERE tenant_id=? AND template_id=? AND target_account_id=? AND row_version=? AND pending_version_id=?`,
        bindings: [new Date().toISOString(), binding.tenantId, binding.templateId, accountId, binding.rowVersion, versionId] },
      auditStatement(binding, kind, accountId, targetId, input.actor, 'hq_template.store_dismissed', versionId),
    ]);
  } catch {
    throw new CatalogAdoptionError('hq_version_conflict', 409);
  }
  return { dismissedVersionId: versionId };
}
