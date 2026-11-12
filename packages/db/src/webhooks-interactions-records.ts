import type { WebhookInteractionFailureReason } from './webhook-failure-types.js';
import { EC_EVENT_TYPES } from '@line-crm/shared';
import { jstNow } from './utils.js';
import { type WebhookInteractionDirection, type WebhookInteractionRow } from './webhooks-types.js';


// Webhook IN/OUT クエリヘルパー

/**
 * 受信・送信Webhookの secret の最低文字数。API の入力検査と旧平文の表示判定は
 * この値だけを見る。apps/worker/src/routes/webhooks.ts はこれを読み替えて使う。
 */
export const WEBHOOK_SECRET_MIN_LENGTH = 32;

/**
 * 送信WebhookのeventTypesに指定できる種別の正本。
 * 実際にイベントバスへ発火され送信Webhookへ届く種別だけを載せる。
 * `*` は全種別を受け取る明示規約。受信口の発火は `incoming_webhook.<source_type>` で届く。
 */
export const KNOWN_OUTGOING_EVENT_TYPES: readonly string[] = [
  'friend_add',
  'friend_unfollow',
  'message_received',
  'postback_received',
  'tag_change',
  'cv_fire',
  'staff_assigned',
  'manual_reply_sent',
  // 見本にある出来事は実際に購読できるようにする。
  // 送信側は forms.ts / booking.ts の発火点。
  'form_submitted',
  'booking_created',
  ...EC_EVENT_TYPES,
];

export const INCOMING_WEBHOOK_EVENT_PREFIX = 'incoming_webhook.';

/**
 * 送信Webhookの購読種別として有効か。
 * `*` は全件、`incoming_webhook.<source>` は受信口ごとの発火に一致する。
 * `incoming_webhook.*` は照合規約上どの発火にも一致しないので通さない。
 */
export function isKnownOutgoingEventType(eventType: string): boolean {
  if (eventType === '*') return true;
  if (KNOWN_OUTGOING_EVENT_TYPES.includes(eventType)) return true;
  if (!eventType.startsWith(INCOMING_WEBHOOK_EVENT_PREFIX)) return false;
  const sourceType = eventType.slice(INCOMING_WEBHOOK_EVENT_PREFIX.length);
  return sourceType.length > 0 && !sourceType.includes('*');
}

export async function createWebhookInteraction(
  db: D1Database,
  input: {
    id?: string;
    lineAccountId: string;
    direction: WebhookInteractionDirection;
    webhookId?: string | null;
    webhookName: string;
    eventType: string;
    triggerSummary: string;
    requestBodyJson?: string | null;
    idempotencyKey?: string;
    retryOfId?: string | null;
    startedAt?: string;
  },
): Promise<WebhookInteractionRow> {
  const id = input.id ?? crypto.randomUUID();
  const now = input.startedAt ?? jstNow();
  await db.prepare(
    `INSERT INTO webhook_interaction_logs
       (id, line_account_id, direction, webhook_id, webhook_name, event_type,
        trigger_summary, status, request_body_json, response_status,
        attempt_count, duration_ms, failure_reason, idempotency_key,
        retry_of_id, started_at, completed_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, 0, NULL, NULL, ?, ?, ?, NULL, ?)`,
  ).bind(
    id,
    input.lineAccountId,
    input.direction,
    input.webhookId ?? null,
    input.webhookName,
    input.eventType,
    input.triggerSummary,
    input.requestBodyJson ?? null,
    input.idempotencyKey ?? crypto.randomUUID(),
    input.retryOfId ?? null,
    now,
    now,
  ).run();
  return (await getWebhookInteractionById(db, id, input.lineAccountId))!;
}

export async function finishWebhookInteraction(
  db: D1Database,
  id: string,
  lineAccountId: string,
  input: {
    status: 'succeeded' | 'failed';
    responseStatus?: number | null;
    attemptCount: number;
    durationMs: number;
    failureReason?: WebhookInteractionFailureReason | null;
    completedAt?: string;
  },
): Promise<void> {
  await db.prepare(
    `UPDATE webhook_interaction_logs
        SET status=?, response_status=?, attempt_count=?, duration_ms=?,
            failure_reason=?, completed_at=?, confirmation_revision=confirmation_revision+1
      WHERE id=? AND line_account_id=? AND status='pending'`,
  ).bind(
    input.status,
    input.responseStatus ?? null,
    input.attemptCount,
    Math.max(0, Math.round(input.durationMs)),
    input.failureReason ?? null,
    input.completedAt ?? jstNow(),
    id,
    lineAccountId,
  ).run();
}

export async function getWebhookInteractionById(
  db: D1Database,
  id: string,
  lineAccountId: string,
): Promise<WebhookInteractionRow | null> {
  return db.prepare(
    'SELECT * FROM webhook_interaction_logs WHERE id=? AND line_account_id=?',
  ).bind(id, lineAccountId).first<WebhookInteractionRow>();
}

export async function claimWebhookInteractionRetry(
  db: D1Database,
  id: string,
  lineAccountId: string,
): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE webhook_interaction_logs SET status='retried', confirmation_revision=confirmation_revision+1
      WHERE id=? AND line_account_id=? AND direction='outgoing' AND status='failed'`,
  ).bind(id, lineAccountId).run();
  return (result.meta.changes ?? 0) > 0;
}

export async function restoreWebhookInteractionFailure(
  db: D1Database,
  id: string,
  lineAccountId: string,
): Promise<void> {
  await db.prepare(
    `UPDATE webhook_interaction_logs SET status='failed', confirmation_revision=confirmation_revision+1
      WHERE id=? AND line_account_id=? AND status='retried'`,
  ).bind(id, lineAccountId).run();
}
