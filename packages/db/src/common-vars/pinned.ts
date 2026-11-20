import type { CommonVarResolutionFailureReason } from './resolution-types.js';

export type PinnedResult = { ok: true; value: string; version: number }
  | { ok: false; reason: CommonVarResolutionFailureReason };

/** 版の値は固定し、送信時点の共通情報の状態・有効期間を必ず確認する。 */
export async function resolvePinnedCommonVarAt(
  db: D1Database, lineAccountId: string, commonVarId: string, versionId: string, executionAt: string,
): Promise<PinnedResult> {
  const row = await db.prepare(`SELECT c.status, c.var_key, c.valid_from, c.valid_until, v.value, v.version_no
    FROM common_vars c JOIN common_var_versions v ON v.common_var_id = c.id
    WHERE c.id = ? AND c.line_account_id = ? AND c.archived_at IS NULL AND v.id = ?`)
    .bind(commonVarId, lineAccountId, versionId)
    .first<{ status: string; var_key: string; valid_from: string | null; valid_until: string | null; value: string; version_no: number }>();
  return evaluatePinnedCommonVar(row, executionAt);
}

export function evaluatePinnedCommonVar(row: { status: string; var_key: string; valid_from: string | null; valid_until: string | null; value: string; version_no: number } | null, executionAt: string): PinnedResult {
  if (!row) return { ok: false, reason: 'missing' };
  if (row.status === 'stopped' || row.status === 'draft') return { ok: false, reason: row.status };
  if (row.status !== 'active') return { ok: false, reason: 'missing' };
  const now = Date.parse(executionAt);
  const from = row.valid_from === null ? null : Date.parse(row.valid_from);
  const until = row.valid_until === null ? null : Date.parse(row.valid_until);
  if (!Number.isFinite(now) || (from !== null && !Number.isFinite(from))
    || (until !== null && !Number.isFinite(until)) || (from !== null && until !== null && from >= until)) {
    return { ok: false, reason: 'invalid_window' };
  }
  if (from !== null && now < from) return { ok: false, reason: 'not_started' };
  if (until !== null && now >= until) return { ok: false, reason: 'expired' };
  if (typeof row.value !== 'string' || (['store_phone', 'reservation_url'].includes(row.var_key) && !row.value.trim())) return { ok: false, reason: 'missing' };
  return { ok: true, value: row.value, version: Number(row.version_no) };
}
