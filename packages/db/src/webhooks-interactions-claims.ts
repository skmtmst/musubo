import { logger } from '@line-crm/shared/server';
import { jstNow, toJstString } from './utils.js';
import { type WebhookInteractionRow } from './webhooks-types.js';


/**
 * 元の失敗記録を「やり直し済み」に畳むのと、やり直し用の記録を
 * 作るのを1つのDBバッチで行う。どちらかだけ残る中途半端な形（元は
 * retried なのにやり直し行が無い等）を作らない。
 *
 * 元の行がすでに畳まれている(別のやり直しが先に動いた)ときは、INSERT 側の
 * NOT EXISTS(retry_of_id) が通らず、UPDATE 側も status='failed' でないので
 * 0件になる。やり直し行が一度作られていれば、その後の重複した申込は
 * どちらも何もしない。片方だけ失敗したときはバッチごと巻き戻される。
 */
export async function claimWebhookInteractionRetryAndInsert(
  db: D1Database,
  original: Pick<WebhookInteractionRow, 'id' | 'line_account_id'>,
  input: {
    id?: string;
    expectedInteractionRevision?: number;
    expectedWebhookRevision?: number;
    webhookId: string;
    webhookName: string;
    eventType: string;
    triggerSummary: string;
    requestBodyJson: string;
    idempotencyKey: string;
  },
): Promise<{ claimed: boolean; retryId: string }> {
  const retryId = input.id ?? crypto.randomUUID();
  const now = jstNow();
  const [claim, insert] = await db.batch([
    db.prepare(
      `UPDATE webhook_interaction_logs SET status='retried', confirmation_revision=confirmation_revision+1
        WHERE id=? AND line_account_id=? AND direction='outgoing' AND status='failed'
          AND (? IS NULL OR confirmation_revision=?)
          AND (? IS NULL OR EXISTS (SELECT 1 FROM outgoing_webhooks w WHERE w.id=webhook_interaction_logs.webhook_id AND w.line_account_id=webhook_interaction_logs.line_account_id AND w.deleted_at IS NULL AND w.is_active=1 AND w.confirmation_revision=?))`,
    ).bind(original.id, original.line_account_id, input.expectedInteractionRevision ?? null, input.expectedInteractionRevision ?? null, input.expectedWebhookRevision ?? null, input.expectedWebhookRevision ?? null),
    db.prepare(
      `INSERT INTO webhook_interaction_logs
         (id, line_account_id, direction, webhook_id, webhook_name, event_type,
          trigger_summary, status, request_body_json, response_status,
          attempt_count, duration_ms, failure_reason, idempotency_key,
          retry_of_id, started_at, completed_at, created_at)
       SELECT ?, ?, 'outgoing', ?, ?, ?, ?, 'pending', ?, NULL, 0, NULL, NULL, ?, ?, ?, NULL, ?
        WHERE changes()=1 AND EXISTS (
          SELECT 1 FROM webhook_interaction_logs WHERE id = ? AND status = 'retried'
        )
        AND NOT EXISTS (
          SELECT 1 FROM webhook_interaction_logs WHERE retry_of_id = ?
        )`,
    ).bind(
      retryId, original.line_account_id, input.webhookId, input.webhookName,
      input.eventType, input.triggerSummary, input.requestBodyJson,
      input.idempotencyKey, original.id, now, now, original.id, original.id,
    ),
  ]);
  const claimChanged = Number(claim.meta?.changes ?? 0) > 0;
  const insertChanged = Number(insert.meta?.changes ?? 0) > 0;
  if (!claimChanged && insertChanged) {
    // まれな割り込み(先のやり直しが claim 済みだが行がまだ無い瞬間)で
    // 孤児の pending 行が残らないよう、自分が作った分だけ消す。
    try {
      await deletePendingWebhookInteraction(db, retryId, original.line_account_id);
    } catch (error) {
      logger.error("src_webhooks_failed");
    }
  }
  return { claimed: claimChanged && insertChanged, retryId };
}

/**
 * 送る前に止まったやり直しの記録を消す。
 * まだ外部へ一度も出ていない pending の行だけを消す。確定済みの行は
 * 履歴なので消さない。
 */
export async function deletePendingWebhookInteraction(
  db: D1Database,
  id: string,
  lineAccountId: string,
): Promise<void> {
  await db.prepare(
    `DELETE FROM webhook_interaction_logs
      WHERE id=? AND line_account_id=? AND status='pending'`,
  ).bind(id, lineAccountId).run();
}

/**
 * 「処理中」のまま放置された記録を「届いたか分からない失敗」へ
 * 直す。始まった時刻から一定時間(既定15分)が過ぎた pending は、結果を書く
 * 途中で止まったものとみなす。一覧から永久に消えない・処理中のままに
 * しないための回収。
 */
export async function markStalePendingWebhookInteractions(
  db: D1Database,
  lineAccountId: string,
  staleBeforeMs = 15 * 60 * 1000,
): Promise<number> {
  const cutoff = toJstString(new Date(Date.now() - staleBeforeMs));
  const result = await db.prepare(
    `UPDATE webhook_interaction_logs
        SET status='failed', failure_reason='unknown', completed_at=?, confirmation_revision=confirmation_revision+1
      WHERE line_account_id=? AND status='pending' AND started_at < ?`,
  ).bind(jstNow(), lineAccountId, cutoff).run();
  return Number(result.meta?.changes ?? 0);
}

/**
 * 同じ通知（同じ送り先＋同じ冪等キー）の失敗記録をまとめて
 * 「やり直し済み」へ畳む。手動・自動のどちらかで届いたとき、残っている
 * 失敗記録をそのまま「やり直せる」状態で残さない。
 */
export async function markFailedInteractionsRetried(
  db: D1Database,
  lineAccountId: string,
  webhookId: string,
  idempotencyKey: string,
): Promise<void> {
  await db.prepare(
    `UPDATE webhook_interaction_logs SET status='retried', confirmation_revision=confirmation_revision+1
      WHERE line_account_id=? AND webhook_id=? AND idempotency_key=?
        AND direction='outgoing' AND status='failed'`,
  ).bind(lineAccountId, webhookId, idempotencyKey).run();
}

/**
 * 同じ通知がすでに届いた記録があるか。
 * 自動配送の回収が送る前に確かめ、手動のやり直しで届いた分を
 * 二重に送らない。
 */
export async function hasSucceededInteractionForKey(
  db: D1Database,
  lineAccountId: string,
  webhookId: string,
  idempotencyKey: string,
): Promise<boolean> {
  const row = await db.prepare(
    `SELECT 1 AS yes FROM webhook_interaction_logs
      WHERE line_account_id=? AND webhook_id=? AND idempotency_key=?
        AND direction='outgoing' AND status='succeeded'
      LIMIT 1`,
  ).bind(lineAccountId, webhookId, idempotencyKey).first<{ yes: number }>();
  return Boolean(row?.yes);
}
