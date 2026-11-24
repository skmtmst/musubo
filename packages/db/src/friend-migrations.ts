import { sqlIdSet } from './id-queries.js';
import { jstNow } from './utils.js';

export const UID_EVIDENCE_TYPES = [
  'same_provider', 'line_login', 'signed_customer_id',
  'verified_contact', 'operator_csv', 'manual',
] as const;
export type UidEvidenceType = (typeof UID_EVIDENCE_TYPES)[number];
export type UidMigrationClassification = 'auto' | 'review' | 'unmatched' | 'conflict';
export type UidMigrationDecision = 'pending' | 'link' | 'create' | 'exclude';

export interface UidMappingInput {
  oldUid: string;
  newUid?: string | null;
  evidenceType: UidEvidenceType;
  evidence?: Record<string, string | number | boolean | null>;
}

export interface MigrationFriendMatch {
  id: string;
  display_name: string | null;
  user_id: string | null;
}

export interface UidMigrationRunRow {
  id: string;
  from_account_id: string;
  to_account_id: string;
  purpose: string;
  source_kind: 'csv' | 'verified_api' | 'manual';
  source_filename: string | null;
  source_checksum: string | null;
  status: 'dry_run' | 'review' | 'ready' | 'executing' | 'completed' | 'failed' | 'rolled_back';
  dry_run_revision: number;
  total_count: number;
  auto_count: number;
  review_count: number;
  unmatched_count: number;
  conflict_count: number;
  applied_count: number;
  failed_count: number;
  created_by: string;
  approved_by: string | null;
  created_at: string;
  reviewed_at: string | null;
  executed_at: string | null;
  completed_at: string | null;
  rolled_back_at: string | null;
  failure_reason: string | null;
}

export interface UidMigrationItemRow {
  id: string;
  run_id: string;
  old_uid: string;
  new_uid: string | null;
  old_friend_id: string | null;
  new_friend_id: string | null;
  candidate_name: string | null;
  evidence_type: UidEvidenceType;
  evidence_json: string;
  classification: UidMigrationClassification;
  conflict_reason: string | null;
  decision: UidMigrationDecision;
  decided_by: string | null;
  decided_at: string | null;
  result: 'pending' | 'applied' | 'skipped' | 'failed' | 'rolled_back';
  before_json: string | null;
  after_json: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export function classifyUidMapping(input: {
  oldFriend: MigrationFriendMatch | null;
  newFriend: MigrationFriendMatch | null;
  duplicateOldUid?: boolean;
  evidenceType: UidEvidenceType;
}): { classification: UidMigrationClassification; reason: string | null } {
  if (input.duplicateOldUid) {
    return { classification: 'conflict', reason: '同じ旧UIDが対応表に複数あります' };
  }
  if (!input.oldFriend) {
    return { classification: 'unmatched', reason: '移行元に一致する友だちがいません' };
  }
  if (!input.newFriend) {
    return { classification: 'unmatched', reason: '移行先に一致する友だちがいません' };
  }
  if (input.oldFriend.user_id && input.newFriend.user_id && input.oldFriend.user_id !== input.newFriend.user_id) {
    return { classification: 'conflict', reason: '新旧UIDが別の統合ユーザーに結び付いています' };
  }
  if (input.evidenceType === 'operator_csv' || input.evidenceType === 'manual') {
    return { classification: 'review', reason: '運用者が対応関係を確認してください' };
  }
  return { classification: 'auto', reason: null };
}

export async function createUidMigrationRun(
  db: D1Database,
  input: {
    fromAccountId: string;
    toAccountId: string;
    purpose: string;
    sourceKind: 'csv' | 'verified_api' | 'manual';
    sourceFilename?: string | null;
    sourceChecksum?: string | null;
    mappings: UidMappingInput[];
    createdBy: string;
  },
): Promise<UidMigrationRunRow> {
  const now = jstNow();
  const runId = crypto.randomUUID();
  const duplicateOldUids = new Set<string>();
  const seen = new Set<string>();
  for (const mapping of input.mappings) {
    if (seen.has(mapping.oldUid)) duplicateOldUids.add(mapping.oldUid);
    seen.add(mapping.oldUid);
  }
  const items: Array<{
    id: string; input: UidMappingInput;
    oldFriend: MigrationFriendMatch | null; newFriend: MigrationFriendMatch | null;
    classification: UidMigrationClassification; reason: string | null;
  }> = [];
  for (const mapping of input.mappings) {
    const [oldFriend, newFriend] = await Promise.all([
      db.prepare('SELECT id, display_name, user_id FROM friends WHERE line_account_id = ? AND line_platform_user_id = ? LIMIT 1')
        .bind(input.fromAccountId, mapping.oldUid).first<MigrationFriendMatch>(),
      mapping.newUid
        ? db.prepare('SELECT id, display_name, user_id FROM friends WHERE line_account_id = ? AND line_platform_user_id = ? LIMIT 1')
          .bind(input.toAccountId, mapping.newUid).first<MigrationFriendMatch>()
        : Promise.resolve(null),
    ]);
    const result = classifyUidMapping({
      oldFriend, newFriend,
      duplicateOldUid: duplicateOldUids.has(mapping.oldUid),
      evidenceType: mapping.evidenceType,
    });
    items.push({ id: crypto.randomUUID(), input: mapping, oldFriend, newFriend, ...result });
  }
  const counts = {
    auto: items.filter((item) => item.classification === 'auto').length,
    review: items.filter((item) => item.classification === 'review').length,
    unmatched: items.filter((item) => item.classification === 'unmatched').length,
    conflict: items.filter((item) => item.classification === 'conflict').length,
  };
  const status = counts.review + counts.conflict > 0 ? 'review' : 'ready';
  await db.prepare(`INSERT INTO uid_migration_runs (
      id, from_account_id, to_account_id, purpose, source_kind, source_filename,
      source_checksum, status, total_count, auto_count, review_count,
      unmatched_count, conflict_count, created_by, created_at, reviewed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      runId, input.fromAccountId, input.toAccountId, input.purpose, input.sourceKind,
      input.sourceFilename ?? null, input.sourceChecksum ?? null, status, items.length,
      counts.auto, counts.review, counts.unmatched, counts.conflict, input.createdBy,
      now, status === 'ready' ? now : null,
    ).run();
  const itemStatements = items.map((item) => db.prepare(`INSERT INTO uid_migration_items (
      id, run_id, old_uid, new_uid, old_friend_id, new_friend_id, candidate_name,
      evidence_type, evidence_json, classification, conflict_reason, decision,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      item.id, runId, item.input.oldUid, item.input.newUid ?? null,
      item.oldFriend?.id ?? null, item.newFriend?.id ?? null,
      item.newFriend?.display_name ?? null, item.input.evidenceType,
      JSON.stringify(item.input.evidence ?? {}), item.classification, item.reason,
      item.classification === 'auto' ? 'link' : 'pending', now, now,
    ));
  try {
    for (let index = 0; index < itemStatements.length; index += 75) {
      await db.batch(itemStatements.slice(index, index + 75));
    }
  } catch (error) {
    await db.prepare(`UPDATE uid_migration_runs
      SET status = 'failed', failure_reason = ? WHERE id = ?`)
      .bind('対応表を保存できませんでした', runId).run();
    throw error;
  }
  return (await getUidMigrationRun(db, runId))!;
}

export async function getUidMigrationRun(db: D1Database, id: string): Promise<UidMigrationRunRow | null> {
  return db.prepare('SELECT * FROM uid_migration_runs WHERE id = ?').bind(id).first<UidMigrationRunRow>();
}

export async function listUidMigrationRuns(db: D1Database, accountIds: string[], limit = 20): Promise<UidMigrationRunRow[]> {
  if (accountIds.length === 0) return [];
  const placeholders = sqlIdSet(accountIds).sql;
  const result = await db.prepare(`SELECT * FROM uid_migration_runs
    WHERE from_account_id IN (${placeholders}) OR to_account_id IN (${placeholders})
    ORDER BY created_at DESC LIMIT ?`).bind(...(accountIds.length ? sqlIdSet(accountIds).binds : []), ...(accountIds.length ? sqlIdSet(accountIds).binds : []), limit).all<UidMigrationRunRow>();
  return result.results;
}

export interface UidMigrationItemFilter {
  classifications?: UidMigrationClassification[];
  pendingOnly?: boolean;
}

export interface UidMigrationItemPage {
  limit?: number;
  offset?: number;
}

function itemFilterSql(filter: UidMigrationItemFilter, params: unknown[]): string {
  const conditions: string[] = [];
  if (filter.classifications && filter.classifications.length > 0) {
    conditions.push(`classification IN (${filter.classifications.map(() => '?').join(',')})`);
    params.push(...filter.classifications);
  }
  if (filter.pendingOnly) {
    conditions.push(`decision = 'pending'`);
  }
  return conditions.length > 0 ? ` AND ${conditions.join(' AND ')}` : '';
}

const ITEM_ORDER_SQL = `ORDER BY CASE classification WHEN 'conflict' THEN 0 WHEN 'review' THEN 1
      WHEN 'unmatched' THEN 2 ELSE 3 END, created_at`;

export async function listUidMigrationItems(
  db: D1Database,
  runId: string,
  filter: UidMigrationItemFilter = {},
  page: UidMigrationItemPage = {},
): Promise<UidMigrationItemRow[]> {
  const params: unknown[] = [runId];
  const where = itemFilterSql(filter, params);
  let sql = `SELECT * FROM uid_migration_items WHERE run_id = ?${where} ${ITEM_ORDER_SQL}`;
  if (page.limit !== undefined) {
    sql += ' LIMIT ?';
    params.push(page.limit);
  }
  if (page.offset !== undefined) {
    if (page.limit === undefined) sql += ' LIMIT -1';
    sql += ' OFFSET ?';
    params.push(page.offset);
  }
  const result = await db.prepare(sql).bind(...params).all<UidMigrationItemRow>();
  return result.results;
}

export async function countUidMigrationItems(
  db: D1Database,
  runId: string,
  filter: UidMigrationItemFilter = {},
): Promise<number> {
  const params: unknown[] = [runId];
  const where = itemFilterSql(filter, params);
  const result = await db.prepare(
    `SELECT COUNT(*) AS count FROM uid_migration_items WHERE run_id = ?${where}`,
  ).bind(...params).first<{ count: number }>();
  return result?.count ?? 0;
}

export interface UidMigrationDecisionCounts {
  pending: number;
  link: number;
  create: number;
  exclude: number;
}

/**
 * 判断別の件数を1回の集計で返す。
 * 本移行前の確認画面が「結び付け n 件・除外 m 件」を出すために使う
 * （FRIEND-33）。表示中のページだけでは全件を数えられないため。
 */
export async function countUidMigrationItemDecisions(
  db: D1Database,
  runId: string,
): Promise<UidMigrationDecisionCounts> {
  const result = await db.prepare(`SELECT decision, COUNT(*) AS count
    FROM uid_migration_items WHERE run_id = ? GROUP BY decision`)
    .bind(runId).all<{ decision: UidMigrationDecision; count: number }>();
  const counts: UidMigrationDecisionCounts = { pending: 0, link: 0, create: 0, exclude: 0 };
  for (const row of result.results) {
    if (row.decision in counts) counts[row.decision] = row.count;
  }
  return counts;
}

export function protectCsvCell(value: string | null | undefined): string {
  const raw = value ?? '';
  const safe = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
