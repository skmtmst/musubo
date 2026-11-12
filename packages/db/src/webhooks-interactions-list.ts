import { logger } from '@line-crm/shared/server';
import { toJstString } from './utils.js';
import { type WebhookInteractionDirection, type WebhookInteractionListRow, type WebhookInteractionSummary } from './webhooks-types.js';
import { markStalePendingWebhookInteractions } from './webhooks-interactions-claims.js';
import { RETRYABLE_FAILURE_CORE } from './webhooks-interactions-retry-reads.js';


export async function listWebhookInteractions(
  db: D1Database,
  input: {
    lineAccountId: string;
    periodDays?: number;
    direction?: WebhookInteractionDirection;
    status?: 'succeeded' | 'failed';
    search?: string;
    page?: number;
    limit?: number;
    /** Internal export only. The HTTP list route never passes this option. */
    exportAll?: boolean;
  },
): Promise<{
  items: WebhookInteractionListRow[];
  total: number;
  page: number;
  limit: number;
  summary: WebhookInteractionSummary;
}> {
  const integerOr = (value: number | undefined, fallback: number) =>
    Number.isFinite(value) ? Math.floor(value as number) : fallback;
  const periodDays = Math.min(365, Math.max(1, integerOr(input.periodDays, 30)));
  const cutoff = toJstString(new Date(Date.now() - periodDays * 86_400_000));
  const page = input.exportAll ? 1 : Math.max(1, integerOr(input.page, 1));
  const limit = input.exportAll ? 5001 : Math.min(50, Math.max(10, integerOr(input.limit, 20)));
  // 結果を書く途中で止まった「処理中」を先に回収する。
  // 一覧を開いた時点で回収すれば、滞留分はここで失敗として見える。
  try {
    await markStalePendingWebhookInteractions(db, input.lineAccountId);
  } catch (error) {
    // 回収だけの失敗で一覧そのものを止めない。
    logger.error("src_webhooks_failed");
  }
  const clauses = ['l.line_account_id=?', 'l.created_at>=?', "l.status!='retried'"];
  const binds: unknown[] = [input.lineAccountId, cutoff];
  if (input.direction) {
    clauses.push('l.direction=?');
    binds.push(input.direction);
  }
  if (input.status) {
    clauses.push('l.status=?');
    binds.push(input.status);
  }
  if (input.search?.trim()) {
    clauses.push('(l.webhook_name LIKE ? OR l.trigger_summary LIKE ? OR l.event_type LIKE ?)');
    const like = `%${input.search.trim().slice(0, 100)}%`;
    binds.push(like, like, like);
  }
  const where = clauses.join(' AND ');
  // 送り先の現状と、同じ通知の自動配送の現状を添える。
  // 画面は「消えた・止まった・自動で動いている」理由を行ごとに出せる。
  // 削除印のある送り先は「無い」として扱う。
  const joinedTables = `webhook_interaction_logs l
    LEFT JOIN outgoing_webhooks ow
           ON ow.id = l.webhook_id AND ow.deleted_at IS NULL
    LEFT JOIN outgoing_webhook_deliveries d
           ON d.webhook_id = l.webhook_id AND d.idempotency_key = l.idempotency_key`;
  const [rows, totalRow, summaryRow] = await Promise.all([
    db.prepare(
      `SELECT l.*,
              ow.is_active AS linked_webhook_active,
              ow.confirmation_revision AS linked_webhook_revision,
              d.status AS delivery_status,
              d.next_retry_at AS delivery_next_retry_at
         FROM ${joinedTables}
        WHERE ${where}
        ORDER BY l.created_at DESC,l.id DESC LIMIT ? OFFSET ?`,
    ).bind(...binds, limit, (page - 1) * limit).all<WebhookInteractionListRow>(),
    db.prepare(`SELECT COUNT(*) AS count FROM webhook_interaction_logs l WHERE ${where}`)
      .bind(...binds).first<{ count: number }>(),
    db.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN l.direction='outgoing' THEN 1 ELSE 0 END) AS outgoing,
              SUM(CASE WHEN l.direction='incoming' THEN 1 ELSE 0 END) AS incoming,
              SUM(CASE WHEN l.status='succeeded' THEN 1 ELSE 0 END) AS succeeded,
              SUM(CASE WHEN l.status='failed' THEN 1 ELSE 0 END) AS failed,
              SUM(CASE WHEN l.direction='outgoing' AND l.status='failed' THEN 1 ELSE 0 END) AS outgoing_failed,
              SUM(CASE WHEN ${RETRYABLE_FAILURE_CORE} THEN 1 ELSE 0 END) AS retryable,
              SUM(CASE WHEN l.status='failed' AND l.failure_reason='unknown' THEN 1 ELSE 0 END) AS result_unknown,
              AVG(CASE WHEN l.status IN ('succeeded','failed') THEN l.duration_ms END) AS average_duration_ms
         FROM ${joinedTables}
        WHERE l.line_account_id=? AND l.created_at>=? AND l.status!='retried'`,
    ).bind(input.lineAccountId, cutoff).first<Record<string, number | null>>(),
  ]);
  return {
    items: rows.results ?? [],
    total: totalRow?.count ?? 0,
    page,
    limit,
    summary: {
      total: summaryRow?.total ?? 0,
      outgoing: summaryRow?.outgoing ?? 0,
      incoming: summaryRow?.incoming ?? 0,
      succeeded: summaryRow?.succeeded ?? 0,
      failed: summaryRow?.failed ?? 0,
      outgoingFailed: summaryRow?.outgoing_failed ?? 0,
      retryable: summaryRow?.retryable ?? 0,
      resultUnknown: summaryRow?.result_unknown ?? 0,
      averageDurationMs: summaryRow?.average_duration_ms == null
        ? null
        : Math.round(summaryRow.average_duration_ms),
    },
  };
}
