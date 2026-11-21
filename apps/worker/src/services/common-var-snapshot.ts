import { normalizeStoreInterpolations } from '@line-crm/shared';
import {
  resolvePinnedCommonVarAt,
  evaluatePinnedCommonVar,
  type CommonVarResolutionEntry,
  type CommonVarResolutionFailureReason,
} from '@line-crm/db';
import { accountOpeningHours } from './account-opening-hours.js';
import { resolveMusuboCommonVarsAt } from './google-common-vars.js';


export interface BroadcastCommonVarSnapshot {
  executionAt: string;
  accounts: Record<string, {
    values: Record<string, string>;
    entries: CommonVarResolutionEntry[];
  }>;
}

export class BroadcastCommonVarResolutionError extends Error {
  constructor(
    readonly failures: Array<{
      accountId: string;
      varKey: string;
      reason: CommonVarResolutionFailureReason;
    }>,
  ) {
    super('Broadcast common variable resolution failed');
  }
}

export function commonVarKeysInContent(content: string): string[] {
  return [...new Set(
    [...normalizeStoreInterpolations(content).matchAll(/\{\{\s*var\.([a-z][a-z0-9_]*)\s*\}\}/g)].map((match) => match[1]),
  )];
}

export function parseBroadcastCommonVarSnapshot(value: unknown): BroadcastCommonVarSnapshot | null {
  if (typeof value !== 'string' || value === '') return null;
  try {
    const parsed = JSON.parse(value) as BroadcastCommonVarSnapshot;
    if (!parsed || typeof parsed.executionAt !== 'string' || !parsed.accounts
      || typeof parsed.accounts !== 'object' || Array.isArray(parsed.accounts)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function commonVarValuesForAccount(
  snapshot: BroadcastCommonVarSnapshot | null,
  accountId: string | null,
): Record<string, string> | undefined {
  if (!snapshot || !accountId) return undefined;
  return snapshot.accounts[accountId]?.values;
}

export async function validateSavedPins(db: D1Database, broadcastId: string, snapshot: BroadcastCommonVarSnapshot, keys: string[], now: string): Promise<void> {
  const pins = (await db.prepare(`SELECT p.common_var_id, p.version_id, c.var_key, c.line_account_id, c.status, c.valid_from, c.valid_until, c.archived_at, v.value, v.version_no
    FROM broadcast_common_var_pins p JOIN common_vars c ON c.id = p.common_var_id
    LEFT JOIN common_var_versions v ON v.id = p.version_id AND v.common_var_id = c.id WHERE p.broadcast_id = ?`)
    .bind(broadcastId).all<{ common_var_id: string; version_id: string; var_key: string; line_account_id: string; status: string; valid_from: string | null; valid_until: string | null; archived_at: string | null; value: string | null; version_no: number | null }>()).results;
  const failures: BroadcastCommonVarResolutionError['failures'] = [];
  for (const pin of pins) {
    if (!keys.includes(pin.var_key) || !snapshot.accounts[pin.line_account_id]) continue;
    if (pin.var_key === 'business_hours' && (await accountOpeningHours(db, pin.line_account_id)).source !== 'manual') {
      failures.push({ accountId: pin.line_account_id, varKey: pin.var_key, reason: 'missing' });
      continue;
    }
    const result = evaluatePinnedCommonVar(pin.archived_at !== null || pin.version_no === null || pin.value === null ? null : {
      status: pin.status, var_key: pin.var_key, valid_from: pin.valid_from, valid_until: pin.valid_until,
      value: pin.value, version_no: pin.version_no,
    }, now);
    if (!result.ok) failures.push({ accountId: pin.line_account_id, varKey: pin.var_key, reason: result.reason });
    else if (!snapshot.accounts[pin.line_account_id].entries.some((entry) => entry.id === pin.common_var_id && entry.version === result.version && entry.value === result.value)) {
      failures.push({ accountId: pin.line_account_id, varKey: pin.var_key, reason: 'missing' });
    }
  }
  if (!failures.length) return;
  await db.batch([
    db.prepare(`UPDATE broadcasts SET
      stopped_at = CASE WHEN status = 'sending' THEN COALESCE(stopped_at, ?) ELSE stopped_at END,
      status = CASE WHEN status = 'scheduled' THEN 'draft' ELSE status END,
      scheduled_at = CASE WHEN status = 'scheduled' THEN NULL ELSE scheduled_at END
      WHERE id = ? AND status IN ('scheduled','sending')`).bind(now, broadcastId),
    ...failures.map((failure) => db.prepare(`INSERT OR IGNORE INTO common_var_resolution_failures
      (id, line_account_id, source_kind, source_id, var_key, reason, execution_at, created_at)
      VALUES (?, ?, 'broadcast', ?, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), failure.accountId, broadcastId, failure.varKey, failure.reason, now, now)),
  ]);
  throw new BroadcastCommonVarResolutionError(failures);
}

type SnapshotBroadcast = {
  id: string;
  line_account_id?: string | null;
  account_ids?: string | null;
  common_var_snapshot?: string | null;
  common_var_snapshot_at?: string | null;
};

function broadcastAccountIds(broadcast: SnapshotBroadcast): string[] {
  if (broadcast.line_account_id) return [broadcast.line_account_id];
  if (!broadcast.account_ids) return [];
  try {
    const parsed = JSON.parse(broadcast.account_ids) as unknown;
    return Array.isArray(parsed)
      ? [...new Set(parsed.filter((value): value is string => typeof value === 'string' && value !== ''))]
      : [];
  } catch {
    return [];
  }
}

/**
 * 外部送信より前に、実行時刻と共通情報の値・版をbroadcast行へ固定する。
 *
 * 時刻を先にCASで保存するため、その直後にWorkerが停止しても再試行は同じ時刻を使う。
 * 値の保存時はsnapshot内の全ID・account・versionを1文で照合し、途中更新を混ぜない。
 */
export async function prepareBroadcastCommonVarSnapshot(
  db: D1Database,
  broadcast: SnapshotBroadcast,
  content: string,
  proposedExecutionAt = new Date().toISOString(),
): Promise<BroadcastCommonVarSnapshot | null> {
  const varKeys = commonVarKeysInContent(content);
  if (varKeys.length === 0) return null;
  const stored = parseBroadcastCommonVarSnapshot(broadcast.common_var_snapshot);
  if (stored) {
    await validateSavedPins(db, broadcast.id, stored, varKeys, proposedExecutionAt);
    return stored;
  }

  await db.prepare(
    `UPDATE broadcasts
        SET common_var_snapshot_at = ?
      WHERE id = ? AND common_var_snapshot_at IS NULL AND common_var_snapshot IS NULL`,
  ).bind(proposedExecutionAt, broadcast.id).run();
  const claimed = await db.prepare(
    `SELECT line_account_id, account_ids, common_var_snapshot, common_var_snapshot_at
       FROM broadcasts WHERE id = ?`,
  ).bind(broadcast.id).first<SnapshotBroadcast>();
  if (!claimed) throw new Error(`Broadcast ${broadcast.id} not found while preparing common variables`);
  const winner = parseBroadcastCommonVarSnapshot(claimed.common_var_snapshot);
  if (winner) {
    await validateSavedPins(db, broadcast.id, winner, varKeys, proposedExecutionAt);
    return winner;
  }
  const executionAt = claimed.common_var_snapshot_at;
  if (!executionAt) throw new Error('Broadcast common variable execution time was not fixed');

  const accountIds = broadcastAccountIds(claimed);
  const snapshot: BroadcastCommonVarSnapshot = { executionAt, accounts: {} };
  const failures: BroadcastCommonVarResolutionError['failures'] = [];
  for (const accountId of accountIds) {
    const pins = (await db.prepare(`SELECT p.common_var_id, p.version_id, c.var_key
      FROM broadcast_common_var_pins p JOIN common_vars c ON c.id = p.common_var_id
      WHERE p.broadcast_id = ? AND c.line_account_id = ?`).bind(broadcast.id, accountId)
      .all<{ common_var_id: string; version_id: string; var_key: string }>()).results
      .filter((pin) => varKeys.includes(pin.var_key));
    const pinnedKeys = new Set(pins.map((pin) => pin.var_key));
    const resolved = await resolveMusuboCommonVarsAt(db, accountId, varKeys.filter((key) => !pinnedKeys.has(key)), executionAt);
    if (!resolved.ok) {
      failures.push(...resolved.failures.map((failure) => ({ accountId, ...failure })));
      continue;
    }
    const values = { ...resolved.values };
    const entries = [...resolved.entries];
    for (const pin of pins) {
      if (pin.var_key === 'business_hours' && (await accountOpeningHours(db, accountId)).source !== 'manual') {
        failures.push({ accountId, varKey: pin.var_key, reason: 'missing' });
        continue;
      }
      const pinned = await resolvePinnedCommonVarAt(db, accountId, pin.common_var_id, pin.version_id, executionAt);
      if (!pinned.ok) {
        failures.push({ accountId, varKey: pin.var_key, reason: pinned.reason });
      } else {
        values[pin.var_key] = pinned.value;
        entries.push({ id: pin.common_var_id, varKey: pin.var_key, value: pinned.value, version: pinned.version, source: 'primary' });
      }
    }
    snapshot.accounts[accountId] = { values, entries };
  }
  if (accountIds.length === 0) {
    failures.push(...varKeys.map((varKey) => ({
      accountId: '',
      varKey,
      reason: 'missing' as const,
    })));
  }

  if (failures.length > 0) {
    const now = new Date().toISOString();
    await db.batch([
      db.prepare(
        `UPDATE broadcasts
            SET status = 'draft', scheduled_at = NULL
          WHERE id = ? AND common_var_snapshot IS NULL AND common_var_snapshot_at = ?
            AND status IN ('scheduled', 'sending')`,
      ).bind(broadcast.id, executionAt),
      ...failures.filter((failure) => failure.accountId !== '').map((failure) => db.prepare(
        `INSERT OR IGNORE INTO common_var_resolution_failures
           (id, line_account_id, source_kind, source_id, var_key, reason, execution_at, created_at)
         SELECT ?, ?, 'broadcast', ?, ?, ?, ?, ?
          WHERE EXISTS (
            SELECT 1 FROM broadcasts
             WHERE id = ? AND status = 'draft' AND common_var_snapshot IS NULL
               AND common_var_snapshot_at = ?
          )`,
      ).bind(
        crypto.randomUUID(), failure.accountId, broadcast.id, failure.varKey,
        failure.reason, executionAt, now, broadcast.id, executionAt,
      )),
    ]);
    throw new BroadcastCommonVarResolutionError(failures);
  }

  const encoded = JSON.stringify(snapshot);
  await db.batch([
    db.prepare(
      `WITH snapshot_accounts AS (
         SELECT key AS account_id, value AS account_snapshot
           FROM json_each(?, '$.accounts')
       ), snapshot_entries AS (
         SELECT snapshot_accounts.account_id AS account_id, entry.value AS entry
           FROM snapshot_accounts
           JOIN json_each(snapshot_accounts.account_snapshot, '$.entries') entry
       )
       SELECT CASE WHEN NOT EXISTS (
         SELECT 1
           FROM snapshot_entries se
           LEFT JOIN common_vars cv ON cv.id = json_extract(se.entry, '$.id')
          WHERE cv.id IS NULL OR cv.archived_at IS NOT NULL
             OR cv.line_account_id != se.account_id
             OR cv.var_key != json_extract(se.entry, '$.varKey')
             OR (cv.version != json_extract(se.entry, '$.version') AND NOT EXISTS (
               SELECT 1 FROM broadcast_common_var_pins p JOIN common_var_versions v ON v.id = p.version_id
               WHERE p.broadcast_id = ? AND p.common_var_id = cv.id AND v.common_var_id = cv.id
                 AND v.version_no = json_extract(se.entry, '$.version')
             ))
       ) THEN 1 ELSE json('') END AS versions_are_current`,
    ).bind(encoded, broadcast.id),
    db.prepare(
      `UPDATE broadcasts
          SET common_var_snapshot = ?
        WHERE id = ? AND common_var_snapshot IS NULL AND common_var_snapshot_at = ?`,
    ).bind(encoded, broadcast.id, executionAt),
  ]);
  const persisted = await db.prepare(
    `SELECT common_var_snapshot FROM broadcasts WHERE id = ?`,
  ).bind(broadcast.id).first<{ common_var_snapshot: string | null }>();
  const result = parseBroadcastCommonVarSnapshot(persisted?.common_var_snapshot);
  if (!result) throw new Error('Broadcast common variable snapshot was not persisted');
  await validateSavedPins(db, broadcast.id, result, varKeys, new Date().toISOString());
  return result;
}
