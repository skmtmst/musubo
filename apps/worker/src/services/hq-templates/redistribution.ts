import type { HqCatalogTemplateType } from '@line-crm/shared';
import type { HqTemplateStatement } from '@line-crm/db';
import { parseCatalogDefinition } from './catalog.js';
import { bindingUnchangedCondition, readCatalogBinding, type CatalogBinding } from './catalog-binding.js';
import { CATALOG_HASH_VERSION } from './catalog-record.js';
import { bindingAppliedStatement, catalogApplyPlan, readCatalogTarget, targetUnchangedCondition, type CatalogVersionInput } from './catalog-target.js';
import { decideRedistribution, redistributionNotices, type RedistributionDecision, type RedistributionNotice } from './redistribution-decision.js';
import { HqTemplateError } from './tag.js';

export type RedistributionOutcome = RedistributionDecision | 'unbound';

export interface RedistributionPlan {
  outcome: RedistributionOutcome;
  /** 書かなかった理由。店の文・個人情報は入れない。 */
  code: string | null;
  notices: RedistributionNotice[];
  statements: HqTemplateStatement[];
  binding: CatalogBinding | null;
}

export function guardStatement(condition: { sql: string; bindings: ReadonlyArray<string | number | null> }): HqTemplateStatement {
  return { sql: `SELECT json(CASE WHEN (${condition.sql}) THEN '{}' ELSE 'HQ_GUARD_FAILED' END)`, bindings: [...condition.bindings] };
}

export async function loadCatalogVersions(db: D1Database, tenantId: string, templateId: string, kind: HqCatalogTemplateType, ids: ReadonlyArray<string | null>): Promise<Map<string, CatalogVersionInput>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (!unique.length) return new Map();
  const rows = (await db.prepare(`SELECT id,version,definition_json FROM hq_template_versions WHERE tenant_id=? AND template_id=? AND id IN (${unique.map(() => '?').join(',')})`)
    .bind(tenantId, templateId, ...unique).all<{ id: string; version: number; definition_json: string }>()).results;
  return new Map(rows.map(row => [row.id, { id: row.id, version: Number(row.version), definition: parseCatalogDefinition(kind, JSON.parse(row.definition_json)) }]));
}

const empty = (outcome: RedistributionOutcome, code: string | null, binding: CatalogBinding | null = null): RedistributionPlan => ({ outcome, code, notices: [], statements: [], binding });

/** 当てられない時の理由。どれも店の物を書き換えずに統括へ返す。 */
const conflictCodes: Record<string, string> = {
  HANDGIFT_PROTECTED: 'handgift_protected', REFERENCE_UNAVAILABLE: 'reference_unavailable', REWARD_KIND_CHANGED: 'reward_kind_changed',
  BOOKING_NOT_USED: 'booking_not_used', VERSION_CONFLICT: 'target_changed', INVALID_DEFINITION: 'definition_invalid',
};

/*
 * 対応表に記録がある店だけ、名前ではなく対応表の店の物で配り直しを決める。
 * 書き込み文は、読んだ時の対応表の行の版と店の物の中身が変わっていない時だけ通る guard を先頭に置く。
 * 版の新旧は数で比べ、古い版で新しい版を戻さない。
 */
export async function planRedistribution(db: D1Database, input: { tenantId: string; templateId: string; kind: HqCatalogTemplateType; accountId: string; candidate: CatalogVersionInput }): Promise<RedistributionPlan> {
  const { tenantId, templateId, kind, accountId, candidate } = input;
  let binding: CatalogBinding | null;
  try { binding = await readCatalogBinding(db, tenantId, templateId, accountId, kind); }
  catch (error) {
    // 出所の欄と対応表が食い違う時は、どちらも正しいと決められないので書かない。
    if (error instanceof HqTemplateError && error.code === 'VERSION_CONFLICT') return empty('conflict', 'origin_mismatch');
    throw error;
  }
  if (!binding) return empty('unbound', null);
  const target = await readCatalogTarget(db, kind, accountId, binding.targetId);
  // 店が削除した物の対応は残し、配り直しは失敗として記録する。消すかどうかは店と統括が判断する。
  if (!target) return empty('missing', 'target_missing', binding);
  const versions = await loadCatalogVersions(db, tenantId, templateId, kind, [binding.appliedVersionId, binding.pendingVersionId, binding.dismissedVersionId, candidate.id]);
  const applied = versions.get(binding.appliedVersionId);
  if (!applied) return empty('conflict', 'origin_mismatch', binding);
  const reward = kind === 'mileage_reward';
  const state = {
    bindingTemplateId: templateId, bindingVersionId: binding.appliedVersionId, originTemplateId: target.originTemplateId, originVersionId: target.originVersionId,
    appliedVersion: applied.version, candidateVersion: candidate.version,
    pendingVersion: binding.pendingVersionId ? versions.get(binding.pendingVersionId)?.version ?? null : null,
    dismissedVersion: binding.dismissedVersionId ? versions.get(binding.dismissedVersionId)?.version ?? null : null,
    targetExists: true, targetActive: true,
    // 指紋の作り方が違う版どうしは比べられない。店が変えたかもしれないとして知らせる側に倒す。
    appliedHash: binding.appliedSnapshotHash, currentHash: binding.hashVersion === CATALOG_HASH_VERSION ? target.hash : `incomparable:${target.hash}`,
    publishedReward: target.published,
    previousRequiredMiles: reward ? Number((applied.definition.settings as { requiredMiles: number }).requiredMiles) : null,
    nextRequiredMiles: reward ? Number((candidate.definition.settings as { requiredMiles: number }).requiredMiles) : null,
    customized: target.customized, protectedTarget: target.protectedTarget,
  };
  const decision = decideRedistribution(state);
  if (decision === 'conflict') return empty('conflict', target.protectedTarget ? 'handgift_protected' : 'origin_mismatch', binding);
  if (decision === 'unchanged') return empty('unchanged', 'unchanged', binding);
  if (decision === 'missing') return empty('missing', 'target_missing', binding);
  const keep = [guardStatement(bindingUnchangedCondition({ tenantId, templateId, accountId, rowVersion: binding.rowVersion })), guardStatement(targetUnchangedCondition(target))];
  if (decision === 'pending') {
    return { outcome: 'pending', code: 'store_review_pending', notices: redistributionNotices(state), binding, statements: [...keep, {
      sql: `UPDATE hq_template_store_bindings SET pending_version_id=?,row_version=row_version+1,updated_at=? WHERE tenant_id=? AND template_id=? AND target_account_id=? AND row_version=?`,
      bindings: [candidate.id, new Date().toISOString(), tenantId, templateId, accountId, binding.rowVersion],
    }] };
  }
  try {
    const plan = await catalogApplyPlan(db, { tenantId, templateId, target, applied, candidate });
    return { outcome: 'apply', code: null, notices: [], binding, statements: [...keep, ...plan.statements,
      bindingAppliedStatement({ tenantId, templateId, accountId, rowVersion: binding.rowVersion, versionId: candidate.id, hash: plan.hash })] };
  } catch (error) {
    if (error instanceof HqTemplateError && conflictCodes[error.code]) return empty('conflict', conflictCodes[error.code], binding);
    throw error;
  }
}
