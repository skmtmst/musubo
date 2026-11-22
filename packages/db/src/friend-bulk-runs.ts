import type {
  FriendBulkItemStatus,
  FriendBulkOperation,
  FriendBulkRunDetail,
  FriendBulkRunItem,
  FriendBulkRunStatus,
  FriendBulkRunSummary,
  FriendBulkSelection,
} from '@line-crm/shared';
import { idChunks } from './id-queries.js';

const liveBulkRun = (alias:string) => `EXISTS (SELECT 1 FROM tenants t WHERE t.id=${alias}.tenant_id AND t.purge_started_at IS NULL AND t.data_purged_at IS NULL) AND NOT EXISTS (SELECT 1 FROM tenant_purge_tombstone_progress p WHERE p.tenant_id=${alias}.tenant_id AND p.table_name='friend_bulk_runs' AND p.row_id=${alias}.id)`;

interface RunRow {
  id: string;
  tenant_id: string;
  created_by: string;
  selection_json: string;
  operation_json: string;
  execution_plan_json: string | null;
  status: FriendBulkRunStatus;
  target_count: number;
  excluded_count: number;
  success_count: number;
  skipped_count: number;
  temporary_failure_count: number;
  permanent_failure_count: number;
  reversible: number;
  scheduled_at: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
}

interface ItemRow {
  id: string;
  run_id: string;
  friend_id: string;
  line_account_id: string | null;
  status: FriendBulkItemStatus;
  attempt_count: number;
  before_json: string | null;
  after_json: string | null;
  error_code: string | null;
  error_message: string | null;
  retry_at: string | null;
  lease_expires_at: string | null;
  completed_at: string | null;
  display_name?: string | null;
  picture_url?: string | null;
}

export interface FriendBulkSnapshotItem {
  friendId: string;
  lineAccountId: string | null;
}

export class FriendBulkIdempotencyConflictError extends Error {
  constructor() {
    super('同じIdempotency-Keyに異なる一括操作が指定されました');
    this.name = 'FriendBulkIdempotencyConflictError';
  }
}

function parseJson<T>(text: string): T {
  return JSON.parse(text) as T;
}

function serializeRun(row: RunRow): FriendBulkRunSummary {
  return {
    id: row.id,
    status: row.status,
    selection: parseJson<FriendBulkSelection>(row.selection_json),
    operation: parseJson<FriendBulkOperation>(row.operation_json),
    targetCount: Number(row.target_count),
    excludedCount: Number(row.excluded_count),
    successCount: Number(row.success_count),
    skippedCount: Number(row.skipped_count),
    temporaryFailureCount: Number(row.temporary_failure_count),
    permanentFailureCount: Number(row.permanent_failure_count),
    reversible: row.reversible === 1,
    scheduledAt: row.scheduled_at,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at,
  };
}

function serializeItem(row: ItemRow): FriendBulkRunItem {
  return {
    id: row.id,
    friendId: row.friend_id,
    displayName: row.display_name ?? null,
    pictureUrl: row.picture_url ?? null,
    lineAccountId: row.line_account_id,
    status: row.status,
    attemptCount: Number(row.attempt_count),
    errorMessage: row.error_message,
    retryAt: row.retry_at,
    completedAt: row.completed_at,
  };
}

export async function createFriendBulkRun(
  db: D1Database,
  input: {
    tenantId: string;
    createdBy: string;
    selection: FriendBulkSelection;
    operation: FriendBulkOperation;
    executionPlan?: unknown;
    targets: FriendBulkSnapshotItem[];
    excludedCount: number;
    reversible: boolean;
    idempotencyKey: string;
    scheduledAt?: string | null;
    undoOfRunId?: string | null;
    messageApprovalThreshold?: number;
    now: string;
  },
): Promise<{ run: FriendBulkRunSummary; created: boolean }> {
  const selectionJson = JSON.stringify(input.selection);
  const operationJson = JSON.stringify(input.operation);
  const executionPlanJson = input.executionPlan === undefined ? null : JSON.stringify(input.executionPlan);
  const scheduledAt = input.scheduledAt ?? null;
  const undoOfRunId = input.undoOfRunId ?? null;

  const matchesRequest = (row: RunRow & { undo_of_run_id?: string | null }): boolean => (
    row.selection_json === selectionJson
    && row.operation_json === operationJson
    && row.execution_plan_json === executionPlanJson
    && row.scheduled_at === scheduledAt
    && (row.undo_of_run_id ?? null) === undoOfRunId
  );
  const findExisting = () => db.prepare(
    `SELECT * FROM friend_bulk_runs
      WHERE tenant_id = ? AND created_by = ? AND idempotency_key = ? AND ${liveBulkRun('friend_bulk_runs')}`,
  ).bind(input.tenantId, input.createdBy, input.idempotencyKey).first<RunRow & { undo_of_run_id: string | null }>();
  const existing = await findExisting();
  if (existing && !matchesRequest(existing)) {
    throw new FriendBulkIdempotencyConflictError();
  }
  if (existing) return { run: serializeRun(existing), created: false };

  const runId = crypto.randomUUID();
  const statements: D1PreparedStatement[] = [
    db.prepare(
      `INSERT INTO friend_bulk_runs
         (id, tenant_id, created_by, selection_json, operation_json, execution_plan_json, status,
          target_count, excluded_count, reversible, idempotency_key, scheduled_at,
          undo_of_run_id, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, 'preparing', 0, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM tenants WHERE id=? AND purge_started_at IS NULL AND data_purged_at IS NULL)`,
    ).bind(
      runId,
      input.tenantId,
      input.createdBy,
      selectionJson,
      operationJson,
      executionPlanJson,
      input.excludedCount,
      input.reversible ? 1 : 0,
      input.idempotencyKey,
      scheduledAt,
      undoOfRunId,
      input.now,
      input.now,
      input.tenantId,
    ),
    db.prepare("SELECT json(CASE WHEN changes()=1 THEN 'true' ELSE 'BULK_TENANT_UNAVAILABLE' END)"),
  ];
  if (input.messageApprovalThreshold !== undefined) {
    statements.push(db.prepare(`INSERT INTO friend_bulk_message_approvals
      (run_id, status, recipient_count, threshold, requested_by, requested_at)
      VALUES (?, 'pending', ?, ?, ?, ?)`)
      .bind(runId, input.targets.length, input.messageApprovalThreshold, input.createdBy, input.now));
    statements.push(db.prepare(`INSERT INTO friend_bulk_message_approval_events
      (id, run_id, actor_staff_id, action, created_at) VALUES (?, ?, ?, 'requested', ?)`)
      .bind(crypto.randomUUID(), runId, input.createdBy, input.now));
  }
  let offset = 0;
  for (const chunk of idChunks(input.targets, 0, 7)) {
    const values: unknown[] = [];
    const rows = chunk.map((target, index) => {
      const ordinal = offset + index;
      values.push(
        crypto.randomUUID(), runId, target.friendId, target.lineAccountId, ordinal,
        `${runId}:${target.friendId}`, input.now,
      );
      return `(?, ?, ?, ?, ?, 'queued', ?, ?)`;
    });
    statements.push(db.prepare(
      `INSERT INTO friend_bulk_run_items
         (id, run_id, friend_id, line_account_id, ordinal, status, idempotency_key, updated_at)
       VALUES ${rows.join(',')}`,
    ).bind(...values));
    offset += chunk.length;
  }
  statements.push(db.prepare(
    `UPDATE friend_bulk_runs SET status = ?, target_count = ?, updated_at = ?
      WHERE id = ? AND status = 'preparing'`,
  ).bind(input.messageApprovalThreshold === undefined ? 'queued' : 'waiting', input.targets.length, input.now, runId));
  try {
    // D1 の batch は全体が1トランザクションになる。実行台帳だけ、または対象の
    // 一部だけが残る中間状態を外から観測させない。
    await db.batch(statements);
  } catch (error) {
    // 同じキーが同時に来た競合は、先に確定した実行を返して冪等にする。
    const winner = await findExisting();
    if (winner) {
      if (!matchesRequest(winner)) throw new FriendBulkIdempotencyConflictError();
      return { run: serializeRun(winner), created: false };
    }
    throw error;
  }
  const created = await getFriendBulkRun(db, runId, input.tenantId);
  if (!created) throw new Error('一括操作の実行台帳を作成できませんでした');
  return { run: created, created: true };
}

export async function getFriendBulkRun(
  db: D1Database,
  id: string,
  tenantId: string,
): Promise<FriendBulkRunSummary | null> {
  const row = await db.prepare(
    `SELECT * FROM friend_bulk_runs WHERE id = ? AND tenant_id = ? AND ${liveBulkRun('friend_bulk_runs')}`,
  ).bind(id, tenantId).first<RunRow>();
  return row ? serializeRun(row) : null;
}

export async function getFriendBulkRunDetail(
  db: D1Database,
  id: string,
  tenantId: string,
  options: { page?: number; limit?: number } = {},
): Promise<FriendBulkRunDetail | null> {
  const run = await getFriendBulkRun(db, id, tenantId);
  if (!run) return null;
  const page = Math.max(1, Math.floor(options.page ?? 1));
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 50)));
  const rows = await db.prepare(
    `SELECT i.*, f.display_name, f.picture_url
       FROM friend_bulk_run_items i
       JOIN friends f ON f.id = i.friend_id
      WHERE i.run_id = ? ORDER BY i.ordinal LIMIT ? OFFSET ?`,
  ).bind(id, limit, (page - 1) * limit).all<ItemRow>();
  return { ...run, items: rows.results.map(serializeItem), page, limit, total: run.targetCount };
}

export async function getFriendBulkRunRow(db: D1Database, id: string): Promise<RunRow | null> {
  return db.prepare(`SELECT * FROM friend_bulk_runs WHERE id = ? AND ${liveBulkRun('friend_bulk_runs')}`).bind(id).first<RunRow>();
}

export async function getFriendBulkRunItemRows(db: D1Database, runId: string): Promise<ItemRow[]> {
  const result = await db.prepare(
    `SELECT * FROM friend_bulk_run_items WHERE run_id = ? ORDER BY ordinal`,
  ).bind(runId).all<ItemRow>();
  return result.results;
}

export async function claimFriendBulkRunItem(
  db: D1Database,
  itemId: string,
  now: string,
  leaseExpiresAt: string,
): Promise<ItemRow | null> {
  const result = await db.prepare(
    `UPDATE friend_bulk_run_items
        SET status = 'running', attempt_count = attempt_count + 1,
            started_at = COALESCE(started_at, ?), lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND (
        status = 'queued'
        OR (status = 'waiting' AND retry_at IS NOT NULL AND retry_at <= ?)
        OR (status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
      )`,
  ).bind(now, leaseExpiresAt, now, itemId, now, now).run();
  if (Number(result.meta?.changes ?? 0) !== 1) return null;
  return db.prepare(`SELECT * FROM friend_bulk_run_items WHERE id = ?`).bind(itemId).first<ItemRow>();
}

export async function updateFriendBulkRunItem(
  db: D1Database,
  itemId: string,
  input: {
    status: FriendBulkItemStatus;
    before?: unknown;
    after?: unknown;
    errorCode?: string | null;
    errorMessage?: string | null;
    retryAt?: string | null;
    now: string;
  },
): Promise<void> {
  const completed = ['success', 'skipped', 'temporary_failure', 'permanent_failure'].includes(input.status)
    ? input.now
    : null;
  await db.prepare(
    `UPDATE friend_bulk_run_items
        SET status = ?, before_json = COALESCE(?, before_json),
            after_json = COALESCE(?, after_json), error_code = ?, error_message = ?,
            retry_at = ?, lease_expires_at = NULL, completed_at = ?, updated_at = ?
      WHERE id = ?`,
  ).bind(
    input.status,
    input.before === undefined ? null : JSON.stringify(input.before),
    input.after === undefined ? null : JSON.stringify(input.after),
    input.errorCode ?? null,
    input.errorMessage ?? null,
    input.retryAt ?? null,
    completed,
    input.now,
    itemId,
  ).run();
}

export async function refreshFriendBulkRunSummary(
  db: D1Database,
  runId: string,
  now: string,
): Promise<FriendBulkRunStatus> {
  const counts = await db.prepare(
    `SELECT
       SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success_count,
       SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped_count,
       SUM(CASE WHEN status = 'temporary_failure' THEN 1 ELSE 0 END) AS temporary_failure_count,
       SUM(CASE WHEN status = 'permanent_failure' THEN 1 ELSE 0 END) AS permanent_failure_count,
       SUM(CASE WHEN status = 'waiting' THEN 1 ELSE 0 END) AS waiting_count,
       SUM(CASE WHEN status IN ('queued','running') THEN 1 ELSE 0 END) AS pending_count
     FROM friend_bulk_run_items WHERE run_id = ?`,
  ).bind(runId).first<{
    success_count: number; skipped_count: number; temporary_failure_count: number;
    permanent_failure_count: number; waiting_count: number; pending_count: number;
  }>();
  const success = Number(counts?.success_count ?? 0);
  const skipped = Number(counts?.skipped_count ?? 0);
  const temporary = Number(counts?.temporary_failure_count ?? 0);
  const permanent = Number(counts?.permanent_failure_count ?? 0);
  const waiting = Number(counts?.waiting_count ?? 0);
  const pending = Number(counts?.pending_count ?? 0);
  let status: FriendBulkRunStatus;
  if (pending > 0) status = 'running';
  else if (waiting > 0) status = 'waiting';
  else if (temporary + permanent === 0) status = 'success';
  else if (success + skipped > 0) status = 'partial';
  else status = 'failed';
  const terminal = ['success', 'partial', 'failed'].includes(status);
  await db.prepare(
    `UPDATE friend_bulk_runs
        SET status = ?, success_count = ?, skipped_count = ?,
            temporary_failure_count = ?, permanent_failure_count = ?,
            started_at = COALESCE(started_at, ?), completed_at = ?, updated_at = ?
      WHERE id = ?`,
  ).bind(status, success, skipped, temporary, permanent, now, terminal ? now : null, now, runId).run();
  return status;
}

export async function resetFriendBulkRunFailures(
  db: D1Database,
  runId: string,
  tenantId: string,
  now: string,
): Promise<number> {
  const run = await getFriendBulkRun(db, runId, tenantId);
  if (!run) return -1;
  const result = await db.prepare(
    `UPDATE friend_bulk_run_items
        SET status = 'queued', error_code = NULL, error_message = NULL,
            retry_at = NULL, completed_at = NULL, updated_at = ?
      WHERE run_id = ? AND status IN ('temporary_failure','permanent_failure')`,
  ).bind(now, runId).run();
  const changes = Number(result.meta?.changes ?? 0);
  if (changes > 0) {
    await db.prepare(
      `UPDATE friend_bulk_runs SET status = 'queued', completed_at = NULL, updated_at = ? WHERE id = ?`,
    ).bind(now, runId).run();
  }
  return changes;
}

export async function listDueFriendBulkRunIds(
  db: D1Database,
  now: string,
  limit = 20,
): Promise<string[]> {
  const rows = await db.prepare(
    `SELECT DISTINCT r.id
       FROM friend_bulk_runs r
       JOIN friend_bulk_run_items i ON i.run_id = r.id
      WHERE r.status IN ('queued','running','waiting') AND ${liveBulkRun('r')}
        AND NOT EXISTS (SELECT 1 FROM friend_bulk_message_approvals a
          WHERE a.run_id = r.id AND a.status IN ('pending', 'expired'))
        AND (r.scheduled_at IS NULL OR r.scheduled_at <= ?)
        AND (
          i.status = 'queued'
          OR (i.status = 'waiting' AND i.retry_at IS NOT NULL AND i.retry_at <= ?)
          OR (i.status = 'running' AND i.lease_expires_at IS NOT NULL AND i.lease_expires_at <= ?)
        )
      ORDER BY r.created_at LIMIT ?`,
  ).bind(now, now, now, Math.max(1, Math.min(limit, 100))).all<{ id: string }>();
  return rows.results.map((row) => row.id);
}

export async function getFriendBulkRunItemState(
  db: D1Database,
  itemId: string,
): Promise<{ before: unknown; after: unknown } | null> {
  const row = await db.prepare(
    `SELECT before_json, after_json FROM friend_bulk_run_items WHERE id = ?`,
  ).bind(itemId).first<{ before_json: string | null; after_json: string | null }>();
  if (!row) return null;
  return {
    before: row.before_json ? parseJson<unknown>(row.before_json) : null,
    after: row.after_json ? parseJson<unknown>(row.after_json) : null,
  };
}
