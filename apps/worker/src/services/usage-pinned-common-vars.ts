import { evaluatePinnedCommonVar, type CommonVarResolutionFailureReason } from '@line-crm/db';
import { accountOpeningHours } from './account-opening-hours.js';
import { resolveMusuboCommonVarsAt } from './google-common-vars.js';

export type PinOwner = { kind: 'scenario'; versionId: string; liveStepId: string }
  | { kind: 'scenarioDraft'; liveStepId: string } | { kind: 'form'; versionId: string };
type PinRow = { common_var_id: string; var_key: string; archived_at: string | null; status: string;
  valid_from: string | null; valid_until: string | null; value: string | null; version_no: number | null };

/** 公開版に写した固定だけを使い、共通情報の現在の停止と期限を確認する。 */
export async function resolveUsagePinnedCommonVars(
  db: D1Database, accountId: string, keys: string[], owner: PinOwner, executionAt: string,
): Promise<{ ok: true; values: Record<string, string> } | { ok: false; failures: Array<{ varKey: string; reason: CommonVarResolutionFailureReason }>; pinnedFailure: boolean }> {
  const selection = owner.kind === 'scenario'
    ? { table: 'scenario_version_common_var_pins', where: 'p.scenario_version_id = ? AND p.live_step_id = ?', params: [owner.versionId, owner.liveStepId] }
    : owner.kind === 'scenarioDraft'
      ? { table: 'scenario_step_common_var_pins', where: 'p.scenario_step_id = ?', params: [owner.liveStepId] }
      : { table: 'form_version_common_var_pins', where: 'p.form_version_id = ?', params: [owner.versionId] };
  const pins = await db.prepare(`SELECT c.id AS common_var_id, c.var_key, c.archived_at, c.status, c.valid_from, c.valid_until,
      v.value, v.version_no FROM ${selection.table} p
      JOIN common_vars c ON c.id = p.common_var_id AND c.line_account_id = ?
      LEFT JOIN common_var_versions v ON v.id = p.version_id AND v.common_var_id = c.id
      WHERE ${selection.where}`).bind(accountId, ...selection.params).all<PinRow>();
  const selected = pins.results.filter(pin => keys.includes(pin.var_key));
  const selectedKeys = new Set(selected.map(pin => pin.var_key));
  const live = await resolveMusuboCommonVarsAt(db, accountId, keys.filter(key => !selectedKeys.has(key)), executionAt);
  const failures: Array<{ varKey: string; reason: CommonVarResolutionFailureReason }> = live.ok ? [] : [...live.failures];
  const values: Record<string, string> = live.ok ? { ...live.values } : {};
  let pinnedFailure = false;
  for (const pin of selected) {
    const google = pin.var_key === 'business_hours' && (await accountOpeningHours(db, accountId)).source !== 'manual';
    const result = evaluatePinnedCommonVar(pin.archived_at !== null || pin.value === null || pin.version_no === null ? null : {
      status: pin.status, var_key: pin.var_key, valid_from: pin.valid_from, valid_until: pin.valid_until,
      value: pin.value, version_no: pin.version_no,
    }, executionAt);
    if (google || !result.ok) { pinnedFailure = true; failures.push({ varKey: pin.var_key, reason: google ? 'missing' : !result.ok ? result.reason : 'missing' }); }
    else values[pin.var_key] = result.value;
  }
  return failures.length ? { ok: false, failures, pinnedFailure } : { ok: true, values };
}
