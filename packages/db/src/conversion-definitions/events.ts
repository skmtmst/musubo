import { hasConversionApprovalRevision } from '../conversion-approval-revision.js';
import { type ConversionDefinitionScope, type ConversionDefinitionEventItem, type DefinitionEventRow } from './types.js';
import { currentDefinitionForMutation } from './revisions.js';


export function readEventMetadataSource(metadata: string | null): {
  source: string | null;
  sourceEventId: string | null;
} {
  if (!metadata) return { source: null, sourceEventId: null };
  try {
    const parsed: unknown = JSON.parse(metadata);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { source: null, sourceEventId: null };
    }
    const record = parsed as Record<string, unknown>;
    const source = typeof record.source === 'string'
      ? record.source
      : typeof record.sourceType === 'string' ? record.sourceType : null;
    const sourceEventId = typeof record.sourceEventId === 'string' ? record.sourceEventId : null;
    return { source, sourceEventId };
  } catch {
    return { source: null, sourceEventId: null };
  }
}

/**
 * 成果地点ごとの成果1件ずつの一覧(新しい順)。
 *
 * 「検知・確認待ち・確定・取消」を業務の言葉で画面へ渡すため、
 * 承認状態と取消台帳(affiliate_adjustments の cancel)から状態を導出する。
 * 重複通知・再送は冪等キーで1件に潰れているため、この一覧の確定件数と
 * 集計(netCount)は同じ台帳から数えて一致する。
 *
 * 取消台帳が無い環境(移行293より前の構成)では取消判定を0に倒し、
 * 「取消かどうか分からない」を「取消でない」と偽らないため
 * cancelled 判定だけを無効化して返す。
 */
export async function listConversionDefinitionEvents(
  db: D1Database,
  input: { id: string; scope: ConversionDefinitionScope; limit?: number },
): Promise<ConversionDefinitionEventItem[] | null> {
  const current = await currentDefinitionForMutation(db, input.id, input.scope);
  if (!current) return null;
  const limit = Math.min(100, Math.max(1, input.limit ?? 50));

  const tables = await db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('affiliate_adjustments','affiliate_reward_entries','conversion_event_reversals')")
    .all<{ name: string }>();
  const names = new Set(tables.results.map((row) => row.name));
  const ledgerChecks: string[] = [];
  if (names.has('affiliate_adjustments') && names.has('affiliate_reward_entries')) {
    ledgerChecks.push(`EXISTS(SELECT 1 FROM affiliate_reward_entries re
              JOIN affiliate_adjustments aa ON aa.source_entry_id = re.id
             WHERE re.conversion_event_id = ce.id AND aa.reason_type = 'cancel')`);
  }
  // 成果の取消は追記台帳。最新の追記が 'reverse' の成果を取消扱いにする。
  const reversedSql = names.has('conversion_event_reversals')
    ? `EXISTS(SELECT 1 FROM conversion_event_reversals r
             WHERE r.conversion_event_id = ce.id AND r.kind = 'reverse'
               AND NOT EXISTS (SELECT 1 FROM conversion_event_reversals newer
                                WHERE newer.conversion_event_id = r.conversion_event_id
                                  AND (newer.created_at > r.created_at
                                    OR (newer.created_at = r.created_at AND newer.rowid > r.rowid))))`
    : '0';
  if (names.has('conversion_event_reversals')) {
    ledgerChecks.push(reversedSql);
  }
  const latestReversalSql = names.has('conversion_event_reversals')
    ? `(SELECT r.id FROM conversion_event_reversals r WHERE r.conversion_event_id = ce.id ORDER BY r.created_at DESC, r.rowid DESC LIMIT 1)`
    : 'NULL';
  const cancelledSql = ledgerChecks.length > 0 ? `(${ledgerChecks.join(' OR ')})` : '0';

  const hasRevision = await hasConversionApprovalRevision(db);
  const rows = await db
    .prepare(
      `SELECT ce.id, ce.friend_id, f.display_name AS friend_name,
              ce.approval_status, ${hasRevision ? 'ce.approval_revision' : 'NULL AS approval_revision'}, ce.value_snapshot, ce.metadata, ce.created_at,
              ${cancelledSql} AS cancelled,
              ${reversedSql} AS reversed,
              ${latestReversalSql} AS latest_reversal_id
         FROM conversion_events ce
         LEFT JOIN friends f ON f.id = ce.friend_id
        WHERE ce.conversion_point_id = ?
        ORDER BY ce.created_at DESC, ce.id DESC
        LIMIT ?`,
    )
    .bind(input.id, limit)
    .all<DefinitionEventRow>();

  return rows.results.map((row) => {
    const { source, sourceEventId } = readEventMetadataSource(row.metadata);
    const cancelled = row.cancelled === 1;
    return {
      id: row.id,
      friendId: row.friend_id,
      friendName: row.friend_name,
      status: cancelled
        ? 'cancelled'
        : row.approval_status === 'pending'
          ? 'pending'
          : row.approval_status === 'rejected' ? 'rejected' : 'confirmed',
      approvalStatus: row.approval_status,
      approvalRevision: row.approval_revision,
      cancelled,
      reversed: row.reversed === 1,
      latestReversalId: row.latest_reversal_id,
      value: row.value_snapshot,
      source,
      sourceEventId,
      createdAt: row.created_at,
    };
  });
}
