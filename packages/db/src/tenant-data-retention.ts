import { DATA_RETENTION_MS } from '@line-crm/shared';
import { jstNow, toJstString } from './utils.js';

/**
 * 統括(テナント)の顧客データ保存期限（★36-2）。
 *
 * 解約または無料体験の終了を起点に数え、期限が切れた統括の顧客データを消す。
 * ここは「誰をいつ消すか」を決める部分で、実際に表を消す処理は
 * apps/worker 側（tenant-data-purge）が持つ。
 *
 * 時刻は全てJST表記（`jstNow` の `+09:00` 付き）で揃っているので、
 * 期限の判定は文字列の大小比較で正しく動く。
 */

export interface TenantRetention {
  id: string;
  name: string;
  plan_status: string;
  trial_ends_at: string | null;
  retention_anchor_at: string | null;
  purge_requested_at: string | null;
  data_purged_at: string | null;
}

const RETENTION_COLUMNS =
  'id, name, plan_status, trial_ends_at, retention_anchor_at, purge_requested_at, data_purged_at';

export async function getTenantRetention(
  db: D1Database,
  tenantId: string,
): Promise<TenantRetention | null> {
  return db
    .prepare(`SELECT ${RETENTION_COLUMNS} FROM tenants WHERE id = ?`)
    .bind(tenantId)
    .first<TenantRetention>();
}

/**
 * 無料体験が終わったまま契約されていない統括に、保存期限の起点を入れる。
 *
 * 無料体験の終了はStripeから通知が来ないことがある（そもそも支払い方法を
 * 登録せずに始めた統括にはサブスクリプションが無い）。解約と違って
 * 「終わった瞬間」に動く処理がないので、6時間毎の点検で拾う。
 *
 * 起点は点検した時刻ではなく、実際に体験が終わった時刻 `trial_ends_at` を使う。
 * 点検が止まっていた分だけ削除が遅れるのを防ぐ。
 * すでに起点があるものは触らない（`retention_anchor_at IS NULL` の条件）。
 */
export async function markExpiredTrialRetentionAnchors(
  db: D1Database,
  now: string = jstNow(),
): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE tenants
          SET retention_anchor_at = trial_ends_at,
              updated_at = ?
        WHERE plan_status = 'trialing'
          AND trial_ends_at IS NOT NULL
          AND trial_ends_at < ?
          AND retention_anchor_at IS NULL
          AND data_purged_at IS NULL`,
    )
    .bind(now, now)
    .run();
  return result.meta?.changes ?? 0;
}

/**
 * 利用者からの早期削除の要請を記録する。90日を待たずに削除対象になる。
 * 二度目の要請では最初の時刻を残す。
 */
export async function requestTenantDataPurge(
  db: D1Database,
  tenantId: string,
  now: string = jstNow(),
): Promise<void> {
  await db
    .prepare(
      `UPDATE tenants
          SET purge_requested_at = COALESCE(purge_requested_at, ?),
              updated_at = ?
        WHERE id = ?`,
    )
    .bind(now, now, tenantId)
    .run();
}

/** 保存期限が切れたと判定する時刻。これより前の起点は期限切れ。 */
export function retentionCutoff(now: string | Date = new Date()): string {
  const base = typeof now === 'string' ? new Date(now) : now;
  return toJstString(new Date(base.getTime() - DATA_RETENTION_MS));
}

/**
 * 顧客データを消すべき統括を取り出す。
 *
 * 対象は2通り。
 *   - 早期削除の要請がある（90日を待たない）
 *   - 保存起点から90日が過ぎた
 * どちらも、まだ削除が終わっていない（`data_purged_at IS NULL`）ものだけ。
 *
 * 1回のcronで扱う統括の数に上限を置く。削除の途中で時間切れになっても、
 * 次の回が同じ統括をもう一度拾って続きから消す。
 */
export async function listTenantsDueForPurge(
  db: D1Database,
  options: { now?: string; limit?: number } = {},
): Promise<TenantRetention[]> {
  const now = options.now ?? jstNow();
  const cutoff = retentionCutoff(now);
  const retryCutoff = toJstString(new Date(new Date(now).getTime() - 24 * 60 * 60 * 1000));
  const result = await db
    .prepare(
      `SELECT ${RETENTION_COLUMNS}
         FROM tenants
        WHERE data_purged_at IS NULL
          AND (plan_status = 'canceled' OR (plan_status = 'trialing' AND trial_ends_at IS NOT NULL AND trial_ends_at < ?))
          AND (purge_requested_at IS NOT NULL
               OR (retention_anchor_at IS NOT NULL AND retention_anchor_at < ?))
        ORDER BY CASE WHEN EXISTS (
          SELECT 1 FROM audit_events ae WHERE ae.tenant_id = tenants.id
            AND ae.action = 'tenant_data.purge_failed' AND ae.created_at >= ?
        ) THEN 1 ELSE 0 END, COALESCE(purge_requested_at, retention_anchor_at) ASC, id ASC
        LIMIT ?`,
    )
    .bind(now, cutoff, retryCutoff, options.limit ?? 5)
    .all<TenantRetention>();
  return result.results ?? [];
}

/** 全ての表を消し終えた統括に印を付ける。次の回からは対象にならない。 */
export async function markTenantDataPurged(
  db: D1Database,
  tenantId: string,
  now: string = jstNow(),
): Promise<void> {
  await db
    .prepare('UPDATE tenants SET data_purged_at = ?, updated_at = ? WHERE id = ?')
    .bind(now, now, tenantId)
    .run();
}

export interface TenantDataPurgeAuditInput {
  id: string;
  tenantId: string;
  /** immediate: 早期削除の要請 / expired: 保存期限の満了 */
  reason: 'immediate' | 'expired';
  retentionAnchorAt: string | null;
  startedAt: string;
  /** 全部消し終えた回だけ入れる。上限で止まった回は null。 */
  finishedAt: string | null;
  deletedRows: number;
  deletedRowsByTable: Record<string, number>;
  deletedObjects: number;
}

/**
 * 削除の実績を監査表に残す。この表は削除対象に入れないので、
 * 顧客データが消えた後も「いつ・何を・何件消したか」を示せる。
 */
export async function recordTenantDataPurgeAudit(
  db: D1Database,
  input: TenantDataPurgeAuditInput,
  now: string = jstNow(),
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO tenant_data_purge_audit
         (id, tenant_id, reason, retention_anchor_at, started_at, finished_at,
          deleted_rows, deleted_rows_by_table, deleted_objects, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.id,
      input.tenantId,
      input.reason,
      input.retentionAnchorAt,
      input.startedAt,
      input.finishedAt,
      input.deletedRows,
      JSON.stringify(input.deletedRowsByTable),
      input.deletedObjects,
      now,
    )
    .run();
}
