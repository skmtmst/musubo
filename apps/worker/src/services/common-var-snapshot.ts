import { normalizeStoreInterpolations } from '@line-crm/shared';
import {
  type CommonVarResolutionEntry,
  type CommonVarResolutionFailureReason,
} from '@line-crm/db';
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
  if (stored) return stored;

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
  if (winner) return winner;
  const executionAt = claimed.common_var_snapshot_at;
  if (!executionAt) throw new Error('Broadcast common variable execution time was not fixed');

  const accountIds = broadcastAccountIds(claimed);
  const snapshot: BroadcastCommonVarSnapshot = { executionAt, accounts: {} };
  const failures: BroadcastCommonVarResolutionError['failures'] = [];
  for (const accountId of accountIds) {
    const resolved = await resolveMusuboCommonVarsAt(db, accountId, varKeys, executionAt);
    if (!resolved.ok) {
      failures.push(...resolved.failures.map((failure) => ({ accountId, ...failure })));
      continue;
    }
    snapshot.accounts[accountId] = { values: resolved.values, entries: resolved.entries };
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
             OR cv.version != json_extract(se.entry, '$.version')
       ) THEN 1 ELSE json('') END AS versions_are_current`,
    ).bind(encoded),
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
  return result;
}
