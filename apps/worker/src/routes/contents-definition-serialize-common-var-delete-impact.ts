import { jstNow, type CommonVar, type CommonVarUsageImpact, type CommonVarReplacementPlan } from '@line-crm/db';


import type { CommonVarDeleteImpact, CommonVarUsageKind } from '@line-crm/shared';
import { COMMON_VAR_USAGE_KIND_LABELS, commonVarUsageStatus, commonVarUsageHref, commonVarUsageChangesOnSave, readableCommonVarUsage } from './contents-definition-replacement-revision.js';

export function serializeCommonVarDeleteImpact(
  variable: CommonVar,
  impact: CommonVarUsageImpact,
): CommonVarDeleteImpact {
  const token = `{{var.${variable.var_key}}}`;
  const canDelete = impact.blockingTotal === 0;
  return {
    variable: { id: variable.id, name: variable.name, varKey: variable.var_key },
    total: impact.total,
    blockingTotal: impact.blockingTotal,
    historicalTotal: impact.historicalTotal,
    unscopedFormTotal: impact.unscopedFormTotal,
    canDelete,
    byKind: impact.byKind,
    // sending_fixed は「配信中だが値が固定済み」。消してもその配信は壊れない。
    sendingFixedTotal: impact.items.filter(
      (item) => item.source_status === 'sending_fixed',
    ).length,
    items: impact.items.map((item) => ({
      kind: item.kind,
      kindLabel: COMMON_VAR_USAGE_KIND_LABELS[item.kind],
      name: item.source_name,
      status: commonVarUsageStatus(item),
      href: commonVarUsageHref(item),
      blocksDeletion: commonVarUsageChangesOnSave(item),
      referenceMode: item.source_status === 'sending_fixed' ? 'pinned' as const
        : item.is_historical === 1 || ['scenario_actions', 'automations', 'automation_definitions', 'common_actions', 'account_settings'].includes(item.source_table)
          ? 'unknown' as const : 'live' as const,
      referencedVersion: item.source_status === 'sending_fixed' ? item.fixed_version ?? null
        : item.is_historical === 1 || ['scenario_actions', 'automations', 'automation_definitions', 'common_actions', 'account_settings'].includes(item.source_table)
          ? null : variable.version,
      currentPreview: readableCommonVarUsage(item.source_content, token)
        .replaceAll(token, variable.value),
    })),
    unavailableReferences: impact.unscopedFormTotal > 0
      ? [{
          kind: 'form',
          kindLabel: COMMON_VAR_USAGE_KIND_LABELS.form,
          count: impact.unscopedFormTotal,
          reason: '所属するLINEアカウントを確認できないため、名前と内容は表示しません',
        }]
      : [],
    checkedAt: jstNow(),
    recommendedAction: canDelete ? 'delete' : 'review_references',
  };
}

export const LINE_TEXT_USAGE_KINDS = new Set<CommonVarUsageKind>([
  'template', 'broadcast', 'scenario', 'reminder', 'auto_reply', 'form',
]);

export const LINE_TEXT_CHARACTER_LIMIT = 5_000;

export /** 値を保存する前に、表示文の差分と検査結果だけを安全な形で返す。 */
function serializeCommonVarChangeImpact(
  variable: CommonVar,
  impact: CommonVarUsageImpact,
  nextValue: string,
) {
  const base = serializeCommonVarDeleteImpact(variable, impact);
  const token = `{{var.${variable.var_key}}}`;
  const items = impact.items.map((item, index) => {
    const safeSource = readableCommonVarUsage(item.source_content, token);
    const previewAvailable = safeSource.includes(token);
    // base.items は impact.items と同じ順で作る。同じ位置の要素を使う前提を
    // 型で守れないので、無いときは安全な文へ倒す（非null断言を使わない）。
    const currentPreview = previewAvailable
      ? safeSource.replaceAll(token, variable.value)
      : (base.items.at(index)?.currentPreview ?? safeSource);
    const changesOnSave = commonVarUsageChangesOnSave(item);
    const nextPreview = !changesOnSave
      ? currentPreview
      : previewAvailable
        ? safeSource.replaceAll(token, nextValue)
        : null;
    const characterLimit = LINE_TEXT_USAGE_KINDS.has(item.kind)
      ? LINE_TEXT_CHARACTER_LIMIT
      : null;
    const nextCharacterCount = nextPreview === null ? null : [...nextPreview].length;
    const errors: string[] = [];
    const warnings: string[] = [];
    if (changesOnSave && nextValue.length === 0) errors.push('変更後の値が空になります');
    if (characterLimit !== null && nextCharacterCount !== null
      && nextCharacterCount > characterLimit) {
      errors.push(`変更後の文が${characterLimit.toLocaleString('ja-JP')}文字を超えます`);
    }
    if (changesOnSave && !previewAvailable) {
      warnings.push('変更後の文は使用先を開いて確認してください');
    }
    return {
      ...base.items[index],
      changesOnSave,
      previewAvailable,
      currentPreview,
      nextPreview,
      currentCharacterCount: [...currentPreview].length,
      nextCharacterCount,
      characterLimit,
      exceedsCharacterLimit: characterLimit !== null && nextCharacterCount !== null
        ? nextCharacterCount > characterLimit
        : false,
      errors,
      warnings,
    };
  });
  return {
    ...base,
    variable: {
      ...base.variable,
      currentValue: variable.value,
      nextValue,
    },
    items,
    errorTotal: items.reduce((sum, item) => sum + item.errors.length, 0),
    warningTotal: items.reduce((sum, item) => sum + item.warnings.length, 0),
    canSave: items.every((item) => item.errors.length === 0),
    recommendedAction: items.some((item) => item.errors.length > 0)
      ? 'fix_errors'
      : impact.blockingTotal > 0
        ? 'confirm_changes'
        : 'save',
  };
}

/*
 * 影響確認の確認値。対象ID・版番号・使用先集合の写しを `.` でつなぐ。
 * 使い回しは保存で版が進むため自然に無効になる。署名は付けない——正しさは
 * 保存時に使用先を組み直して確かめるため、写しの偽造では通らない。
 */
export function buildCommonVarImpactProof(varId: string, version: number, usageHex: string): string {
  return `${varId}.${version}.${usageHex}`;
}

export function parseCommonVarImpactProof(presented: unknown): {
  varId: string; version: number; hex: string;
} | null {
  if (typeof presented !== 'string') return null;
  const parts = presented.split('.');
  if (parts.length !== 3 || !parts[0] || !/^[0-9a-f]{64}$/.test(parts[2])) return null;
  const version = Number(parts[1]);
  if (!Number.isInteger(version) || version < 1) return null;
  return { varId: parts[0], version, hex: parts[2] };
}

export async function commonVarUsageRevision(
  variable: CommonVar,
  impact: CommonVarUsageImpact,
): Promise<string> {
  const raw = [
    `${variable.id}:${variable.version}`,
    ...impact.items.map((item) => [
      item.kind, item.source_id, item.source_parent_id ?? '', item.source_status ?? '', item.source_content,
    ].join(':')).sort(),
    `unscoped:${impact.unscopedFormTotal}`,
  ].join('\n');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function commonVarReplacementRevision(plan: CommonVarReplacementPlan): Promise<string> {
  const raw = [
    `${plan.source.id}:${plan.source.version}:${plan.replacement.id}:${plan.replacement.version}`,
    ...plan.targets.map((target) =>
      `${target.table}:${target.id}:${target.fingerprint}`).sort(),
    `blocked:${plan.blockedTotal}`,
  ].join('\n');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function serializeCommonVarReplacementPlan(plan: CommonVarReplacementPlan, revision: string) {
  const byKind = Object.fromEntries(Object.keys(COMMON_VAR_USAGE_KIND_LABELS).map((kind) => [
    kind,
    plan.targets.filter((target) => target.kind === kind).length,
  ]));
  return {
    source: { id: plan.source.id, name: plan.source.name, type: plan.source.type, version: plan.source.version },
    replacement: {
      id: plan.replacement.id,
      name: plan.replacement.name,
      type: plan.replacement.type,
      version: plan.replacement.version,
    },
    usageTotal: plan.usageTotal,
    replaceableTotal: plan.replaceableTotal,
    blockedTotal: plan.blockedTotal,
    historicalTotal: plan.historicalTotal,
    unscopedFormTotal: plan.unscopedFormTotal,
    byKind,
    canReplace: plan.blockedTotal === 0,
    revision,
    checkedAt: jstNow(),
  };
}

/**
 * 切替日時の実在検査。正規表現だけでは月13・99日が通る。
 * JSTの壁時計として組み立て直し、月日時刻の範囲を確かめる。
 */
export function isValidScheduleDateTime(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  if (month < 1 || month > 12 || hour > 23 || minute > 59) return false;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day >= 1 && day <= lastDay;
}
