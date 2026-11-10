import { logger } from '@line-crm/shared/server';
import { decryptCredential } from '@line-crm/db';
import { getIncomingWebhookById, createWebhookInteraction, finishWebhookInteraction, updateIncomingWebhookMaskedSample, WEBHOOK_SECRET_PREVIOUS_GRACE_MS, isKnownOutgoingEventType, KNOWN_OUTGOING_EVENT_TYPES, WEBHOOK_SECRET_MIN_LENGTH as MIN_SECRET_LENGTH, type IntegrationApiTokenRow, type WebhookInteractionRow, type WebhookInteractionListRow, type IncomingWebhookIdentityMatch, type IncomingWebhookActionRef } from '@line-crm/db';
import { inputError } from '../lib/input-errors.js';
import { type Context } from 'hono';



import type { Env } from '../worker-env.js';
import { stoppedTenantLineAccountSql } from '../services/tenant-runtime-status.js';
import { reserveIncomingWebhook, readIncomingWebhookReceiptPlan, saveIncomingWebhookReceiptPlan, type IncomingWebhookReceiptPlan } from '../services/incoming-webhook-receipts.js';
import { canAccessAllLineAccounts } from '../services/account-access.js';
import { webhookFailureLabel, webhookResponseLabel } from '../services/webhook-interactions.js';
import { executeIncomingWebhookActions, maskedPayloadShape } from '../services/incoming-webhook-actions.js';

export const MATCH_KINDS = new Set([
  'harness_friend_id', 'external_customer_id', 'verified_email', 'verified_phone',
]);
export const NOT_FOUND_ACTIONS = new Set(['do_nothing', 'unmatched_box', 'create_candidate']);
export const INCOMING_ACTION_KINDS = new Set([
  'common_action', 'tag', 'friend_field', 'support_mark', 'template', 'scenario',
  'reminder', 'conversion', 'mileage_rule', 'score_rule', 'outgoing_webhook',
  'operator_notification',
]);

export /*
 * 受信直後に直接動かせる種類。directAction（incoming-webhook-actions.ts）
 * が組み立てられる5種類と、公開済み版を展開する共通アクションだけ。
 * friend_field・reminder・conversion・mileage_rule・score_rule・
 * operator_notification の直接指定は、保存できても試しも実実行も必ず失敗する
 * ため、保存時点で理由つきで止める（接続済み表示もしない）。
 */
const INCOMING_DIRECTLY_EXECUTABLE_KINDS = new Set([
  'common_action', 'tag', 'support_mark', 'template', 'scenario', 'outgoing_webhook',
]);

export const INCOMING_ACTION_KIND_LABELS: Record<string, string> = {
  common_action: '共通アクションを動かす',
  tag: 'タグを付ける',
  friend_field: '友だち情報を更新する',
  support_mark: '対応マークを付ける',
  template: 'テンプレートを送る',
  scenario: 'シナリオを開始する',
  reminder: 'リマインダを開始する',
  conversion: '成果を記録する',
  mileage_rule: 'マイルを付ける',
  score_rule: 'スコアを更新する',
  outgoing_webhook: '別のサービスへ知らせる',
  operator_notification: '担当者へ知らせる',
};

export function incomingUnexecutableReason(refKind: string): string | null {
  if (INCOMING_DIRECTLY_EXECUTABLE_KINDS.has(refKind)) return null;
  const label = INCOMING_ACTION_KIND_LABELS[refKind] ?? '保存済みの処理を動かす';
  return `「${label}」は受信直後の処理として直接実行できないため、保存できません。`
    + 'タグを付ける・対応マークを付ける・テンプレートを送る・シナリオを開始する・'
    + '別のサービスへ知らせる・共通アクションを動かす、から選び直してください。';
}

export function safeJson<T>(raw: string | null | undefined, fallback: T): T {
  try {
    return raw ? JSON.parse(raw) as T : fallback;
  } catch {
    return fallback;
  }
}

export async function incomingActionDisplayName(db: D1Database, action: IncomingWebhookActionRef): Promise<string> {
  const table = ({
    common_action: 'common_actions', tag: 'tags', friend_field: 'friend_fields',
    support_mark: 'support_marks', template: 'templates', scenario: 'scenarios',
    reminder: 'reminders', conversion: 'conversion_definitions', outgoing_webhook: 'outgoing_webhooks',
  } as Record<string, string>)[action.refKind];
  if (!table) return '保存済みの設定';
  try {
    //  送信Webhookの削除は履歴を残す印なので、印のある行は
    // 名づけの参照先としても使わない。他の表に deleted_at は無い。
    const notDeleted = table === 'outgoing_webhooks' ? ' AND deleted_at IS NULL' : '';
    const row = await db.prepare(`SELECT name FROM ${table} WHERE id = ?${notDeleted}`).bind(action.refId).first<{ name: string }>();
    return row?.name?.trim() || '保存済みの設定';
  } catch {
    return '保存済みの設定';
  }
}

export function readIncomingConfig(body: unknown):
  | { ok: true; expectedVersion: number; identityMatching: IncomingWebhookIdentityMatch; actions: IncomingWebhookActionRef[] }
  | { ok: false; error: string; field?: string } {
  if (!body || typeof body !== 'object') return { ok: false, error: 'JSON本文が正しくありません' };
  const input = body as Record<string, unknown>;
  const expectedVersion = Number(input.expectedVersion);
  const identity = input.identityMatching as Record<string, unknown> | undefined;
  const methods = identity?.methods;
  const onNotFound = identity?.onNotFound;
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    return { ok: false, error: 'expectedVersionは1以上の整数で指定してください' , field: "expectedVersion" };
  }
  if (!Array.isArray(methods) || methods.length > 4 || !NOT_FOUND_ACTIONS.has(String(onNotFound))) {
    return { ok: false, field: 'identityMatching', error: '人の照合方法または未照合時の扱いが正しくありません' };
  }
  const normalizedMethods: IncomingWebhookIdentityMatch['methods'] = [];
  const seenKinds = new Set<string>();
  for (const raw of methods) {
    if (!raw || typeof raw !== 'object') return { ok: false, field: 'identityMatching', error: '人の照合方法が正しくありません' };
    const item = raw as Record<string, unknown>;
    const kind = String(item.kind);
    const path = typeof item.path === 'string' ? item.path.trim() : '';
    if (!MATCH_KINDS.has(kind) || seenKinds.has(kind)
      || path.length > 200 || !/^\$(?:\.[A-Za-z_][A-Za-z0-9_-]*|\[\d+\])+$/.test(path)) {
      return { ok: false, field: 'identityMatching', error: '名前照合は使わず、許可された識別子とJSONPathを指定してください' };
    }
    seenKinds.add(kind);
    normalizedMethods.push({
      kind: kind as IncomingWebhookIdentityMatch['methods'][number]['kind'], path,
    });
  }
  if (!Array.isArray(input.actions) || input.actions.length > 20) {
    return { ok: false, field: 'actions', error: '実行処理は20件以内で指定してください' };
  }
  const actions: IncomingWebhookActionRef[] = [];
  for (const raw of input.actions) {
    if (!raw || typeof raw !== 'object') return { ok: false, field: 'actions', error: '実行処理が正しくありません' };
    const item = raw as Record<string, unknown>;
    const refKind = String(item.refKind);
    const refId = typeof item.refId === 'string' ? item.refId.trim() : '';
    const refVersionId = item.refVersionId === null || item.refVersionId === undefined
      ? null : typeof item.refVersionId === 'string' ? item.refVersionId.trim() : '';
    if (!INCOMING_ACTION_KINDS.has(refKind) || !refId || refId.length > 200
      || (refVersionId !== null && (!refVersionId || refVersionId.length > 200))) {
      return { ok: false, field: 'actions', error: '実行処理は許可された種類と構造化IDで指定してください' };
    }
    // 直接実行できない種類は保存200にしない。試しも実実行も必ず失敗するため。
    const unexecutable = incomingUnexecutableReason(refKind);
    if (unexecutable) return { ok: false, field: 'actions', error: unexecutable };
    actions.push({ refKind, refId, refVersionId });
  }
  return {
    ok: true,
    expectedVersion,
    identityMatching: {
      methods: normalizedMethods,
      onNotFound: String(onNotFound) as IncomingWebhookIdentityMatch['onNotFound'],
    },
    actions,
  };
}

export /**
 * 送り直しの回数を検証する。
 *
 *  以降、再送はリクエスト内の sleep ではなく配送台帳の
 * next_retry_at（1分→5分→30分…の指数待ち）で行う。待ち時間が
 * Worker の実行時間を食わなくなったため、上限は要件26 §6-4 の
 * 送信Webhook上限（最大8試行 = 初回 + 再送7回）にそろえる。
 */
function readMaxRetries(raw: unknown): { ok: true; value: number } | { ok: false } {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 7) return { ok: false };
  return { ok: true, value: n };
}

export const MAX_WEBHOOK_NAME_LENGTH = 120;
export const MAX_EVENT_TYPES = 20;
export const MAX_EVENT_TYPE_LENGTH = 100;
export //  受信本文の上限と、受信口ごとの短時間回数制限。
const MAX_INCOMING_BODY_BYTES = 256 * 1024;
export const RECEIVE_RATE_LIMIT = 60;
export const RECEIVE_RATE_WINDOW_MS = 60_000;
export /*
 *  (-26 §7-1): 署名時刻の受付窓。過去15分・未来5分（時計ずれ分）。
 * 時刻を送ってきた受信だけを検査し、送らない古い送信元は壊さない。
 */
const RECEIVE_TIMESTAMP_PAST_MS = 15 * 60_000;
export const RECEIVE_TIMESTAMP_FUTURE_MS = 5 * 60_000;

export /**
 * 名前と種別の上限。極端な値で一覧表示が崩れる・DBが膨らむのを防ぐ( 軽)。
 */
function validateWebhookName(name: unknown): string | null {
  if (typeof name !== 'string' || !name.trim()) return 'name is required';
  if (name.trim().length > MAX_WEBHOOK_NAME_LENGTH) {
    return `name must be ${MAX_WEBHOOK_NAME_LENGTH} characters or less`;
  }
  return null;
}

export function validateEventTypes(eventTypes: unknown): string | null {
  if (eventTypes === undefined) return null;
  if (!Array.isArray(eventTypes) || eventTypes.length > MAX_EVENT_TYPES) {
    return `eventTypes must be an array of at most ${MAX_EVENT_TYPES} items`;
  }
  for (const item of eventTypes) {
    if (typeof item !== 'string' || !item.trim() || item.trim().length > MAX_EVENT_TYPE_LENGTH) {
      return `each eventType must be 1-${MAX_EVENT_TYPE_LENGTH} characters`;
    }
    // 実際に発火する種別だけを受け付ける。誤記や不発パターンは
    // 無音の不達になるため、有効な種別の一覧を添えて拒否する。
    if (!isKnownOutgoingEventType(item.trim())) {
      return `unknown eventType "${item.trim()}". available: ${KNOWN_OUTGOING_EVENT_TYPES.join(', ')}, incoming_webhook.<source_type>, *`;
    }
  }
  return null;
}

export function generateWebhookSecret(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), value=>value.toString(16).padStart(2,'0')).join('');
}

export function validateSecret(secret: unknown): string | null {
  if (typeof secret !== 'string' || secret.length < 32) {
    return `secret must be at least ${MIN_SECRET_LENGTH} characters`;
  }
  return null;
}

export function validateHttpsUrl(url: unknown): string | null {
  if (typeof url !== 'string' || url.length === 0) {
    return 'url is required';
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'url must be a valid absolute URL';
  }
  if (parsed.protocol !== 'https:') {
    return 'url must use https:// scheme';
  }
  return null;
}

export /**
 * 暗号化の鍵がない・壊れているときの保存失敗を見分ける。
 *
 * secret を平文で書き残さないため、鍵なしの新規・更新は止める。
 * 判定は名前で行う(DB層はモック差し替えのため型では縛らない)。
 */
function isEncryptionKeyError(err: unknown): boolean {
  return err instanceof Error && err.name === 'CredentialEncryptionKeyError';
}

export /**
 * 送受信 secret 用の鍵束。現行鍵に加え、併用期間の旧鍵を
 * LINE_CREDENTIAL_PREVIOUS_KEYS(カンマ区切り)で渡せる。
 */
function webhookKeysOf(c: Context<Env>): { current?: string; previous?: string } {
  const env = c.env as unknown as Record<string, unknown>;
  const previous = env.LINE_CREDENTIAL_PREVIOUS_KEYS;
  return {
    current: c.env.LINE_CREDENTIAL_ENCRYPTION_KEY,
    previous: typeof previous === 'string' ? previous : undefined,
  };
}

export /**
 * S ( 機能26): 前の合言葉があといつまで受け付けるか。
 * 併用期間(24時間)を過ぎた・前の値が無い行は null。
 */
function previousSecretUsableUntil(
  row: { secret_previous_encrypted?: string | null; secret_rotated_at?: string | null },
  now = Date.now(),
): string | null {
  if (!row.secret_previous_encrypted || !row.secret_rotated_at) return null;
  const rotatedAt = Date.parse(row.secret_rotated_at);
  if (!Number.isFinite(rotatedAt)) return null;
  const until = rotatedAt + WEBHOOK_SECRET_PREVIOUS_GRACE_MS;
  return until > now ? new Date(until).toISOString() : null;
}

export function serializeInteraction(row: WebhookInteractionRow) {
  return {
    id: row.id,
    confirmationRevision: row.confirmation_revision,
    webhookRevision: (row as WebhookInteractionListRow).linked_webhook_revision ?? null,
    direction: row.direction,
    webhookName: row.webhook_name,
    eventType: row.event_type,
    triggerSummary: row.trigger_summary,
    status: row.status,
    responseLabel: webhookResponseLabel(row),
    responseStatus: row.response_status,
    attemptCount: row.attempt_count,
    durationMs: row.duration_ms,
    failureReason: webhookFailureLabel(row.failure_reason),
    // 判定用の記号も返す。'unknown' は無条件に再送せず、
    // 相手先で確かめてからの1件ずつ復旧として画面が扱う。
    failureReasonCode: row.failure_reason,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    retryOfId: row.retry_of_id,
    ...retryBlockFields(row),
  };
}

export /** 再送可否とその理由は、取得できた配送状態から判定する。一覧にだけある情報は個別行で推測せず、不明のまま扱う。 */
function retryBlockFields(row: WebhookInteractionRow) {
  const list = row as Partial<WebhookInteractionListRow>;
  const hasJoin = 'linked_webhook_active' in row;
  const outgoingFailed = row.direction === 'outgoing' && row.status === 'failed';
  // webhook_id が無い記録は連携先が消えたもの。一覧行で送り先が
  // 見つからない（削除印あり含む）ものも同じ扱い。
  const webhookDeleted = row.direction === 'outgoing'
    && (row.webhook_id == null || (hasJoin && list.linked_webhook_active == null));
  const webhookInactive = hasJoin && row.direction === 'outgoing' && list.linked_webhook_active === 0;
  const deliveryStatus = hasJoin ? (list.delivery_status ?? null) : null;
  const autoRetryOpen = deliveryStatus === 'pending' || deliveryStatus === 'sending' || deliveryStatus === 'retry_wait';
  const autoDelivered = deliveryStatus === 'delivered';
  const retryBlockReason =
    webhookDeleted ? 'webhook_deleted'
    : webhookInactive ? 'webhook_inactive'
    : autoRetryOpen ? 'auto_retry_scheduled'
    : autoDelivered ? 'already_delivered'
    : null;
  return {
    // つなぎ先が消えたもの・止まったもの・送った内容が残っていないもの、
    // 自動の送り直しが動いている・届き済みのものは送り直せない。
    canRetry: outgoingFailed && Boolean(row.webhook_id) && row.request_body_json != null
      && !webhookDeleted && !webhookInactive && !autoRetryOpen && !autoDelivered,
    retryBlockReason,
    autoRetryNextAt: autoRetryOpen ? (list.delivery_next_retry_at ?? null) : null,
  };
}

export async function requireInteractionAccount(c: Context<Env>) {
  const lineAccountId = c.req.query('lineAccountId')?.trim();
  if (!lineAccountId) return { error: inputError(c, { success: false, error: 'LINEアカウントを選択してください' }, 400, ["lineAccountId"]) };
  if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [lineAccountId])) {
    return { error: c.json({ success: false, error: 'このLINEアカウントを表示する権限がありません' }, 403) };
  }
  return { lineAccountId };
}

export // ========== 公開APIトークン ==========
//
// 外部システムが /api/public/v1/* を呼ぶための合言葉。管理画面の認証とは
// 別の台帳で、ここで作ったトークンは公開APIだけに効く。
// 平文は保存しない。発行・再発行の応答にだけ1回だけ乗せる。

function serializeApiToken(row: IntegrationApiTokenRow) {
  return {
    id: row.id,
    name: row.name,
    tokenPrefix: row.token_prefix,
    scopes: safeJson<string[]>(row.scopes, []),
    createdBy: row.created_by,
    lastUsedAt: row.last_used_at,
    rotatedFromId: row.rotated_from_id,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}

/** 受信時に認証し固定した計画だけを、配信 cron が実行する。 */
export async function processIncomingWebhookQueue(env: Env['Bindings'], limit = 50): Promise<number> {
  const rows = await env.DB.prepare(`SELECT * FROM incoming_webhook_queue WHERE status='pending'
    AND datetime(next_attempt_at)<=datetime('now') ORDER BY created_at LIMIT ?`).bind(limit).all<{
      source_event_id:string;webhook_id:string;signature_hash:string;body_hash:string;payload_encrypted:string;attempts:number;
    }>();
  let completed = 0;
  for (const row of rows.results) {
    const wh = await getIncomingWebhookById(env.DB, row.webhook_id);
    if (!wh?.is_active || !env.LINE_CREDENTIAL_ENCRYPTION_KEY) continue;
    if(wh.line_account_id && await env.DB.prepare(`SELECT 1 FROM line_accounts WHERE id=? AND ${stoppedTenantLineAccountSql('line_accounts.id')}`).bind(wh.line_account_id).first()) continue;
    const reserved = await reserveIncomingWebhook(env.DB,wh.id,row.signature_hash,{limit:RECEIVE_RATE_LIMIT,windowMs:RECEIVE_RATE_WINDOW_MS},row.body_hash);
    if (reserved.kind === 'busy' || reserved.kind === 'rate_limited') continue;
    if (reserved.kind === 'completed') {
      await env.DB.prepare("UPDATE incoming_webhook_queue SET status='completed',payload_encrypted=NULL WHERE source_event_id=?").bind(row.source_event_id).run();
      continue;
    }
    const execution = reserved.execution;
    if(row.attempts>=4) {
      await execution.fail();
      await env.DB.prepare("UPDATE incoming_webhook_queue SET status='failed',updated_at=? WHERE source_event_id=?").bind(new Date().toISOString(),row.source_event_id).run();
      continue;
    }
    await env.DB.prepare('UPDATE incoming_webhook_queue SET attempts=attempts+1 WHERE source_event_id=?').bind(row.source_event_id).run();
    try {
      const payload: unknown = JSON.parse(await decryptCredential(row.payload_encrypted,env.LINE_CREDENTIAL_ENCRYPTION_KEY));
      if (wh.line_account_id) {
        try {
          await updateIncomingWebhookMaskedSample(
            execution.db,
            wh.id,
            wh.line_account_id,
            maskedPayloadShape(payload),
          );
        } catch {
          logger.error("incoming_webhooks.update_masked_sample_failed");
        }
      }

      const { fireEvent } = await import('../services/event-bus.js');
      const eventType = `incoming_webhook.${wh.source_type}`;
      const started = Date.now();
      let interaction: Pick<WebhookInteractionRow, 'id'> | null = null;
      if (wh.line_account_id) {
        try {
          interaction = await execution.step('interaction', async () => ({ id: (await createWebhookInteraction(execution!.db, {
            lineAccountId: wh.line_account_id!,
            direction: 'incoming',
            webhookId: wh.id,
            webhookName: wh.name,
            eventType,
            triggerSummary: `${wh.name}から受け取った`,
            // 受信は送り直さないため本文を保管しない。顧客情報を台帳へ複製しない。
            requestBodyJson: null,
          })).id }));
        } catch (logError) {
          // 台帳の一時障害で、署名確認済みの受信処理まで止めない。
          logger.error("webhooks.process_incoming_webhook_queue_failed");
        }
      }
      let actionResult: { matchedFriendId: string | null; executed: number; failed: number;
        matchStatus: 'matched' | 'not_found' | 'ambiguous' | 'skipped' } =
        { matchedFriendId: null, executed: 0, failed: 0, matchStatus: 'skipped' };
      try {
        /*
         * 受領時に照合方法・未一致時の扱い・処理配列全体・参照版を
         * 一つの実行計画として保存する。再試行はその計画を最後まで使い、
         * 後日の設定変更は新規受信へだけ適用する。既存受信を別計画へ変える
         * 場合は差分と未処理分を明示する（現状は計画の固定のみ行う）。
         */
        let receiptPlan = await readIncomingWebhookReceiptPlan(env.DB, execution.sourceEventId);
        if (!receiptPlan) {
          const fresh: IncomingWebhookReceiptPlan = {
            configVersion: typeof wh.version === 'number' ? wh.version : null,
            identityMatching: safeJson<IncomingWebhookIdentityMatch>(wh.identity_match_json, {
              methods: [], onNotFound: 'do_nothing',
            }),
            actions: safeJson<IncomingWebhookActionRef[]>(wh.action_refs_json, []),
          };
          /*
           * 計画の確定は賃借柵の外で行う。内容は受領行の1行に先勝ちで書き、
           * 同じ受領の並行・再試行が上書きしない。柵内の行動実行はこの後。
           */
          await saveIncomingWebhookReceiptPlan(env.DB, execution.sourceEventId, fresh);
          receiptPlan = await readIncomingWebhookReceiptPlan(env.DB, execution.sourceEventId) ?? fresh;
        }
        if (wh.line_account_id) {
          actionResult = await execution.step('actions', async () => {
            const result = await executeIncomingWebhookActions(execution!.db, {
            lineAccountId: wh.line_account_id!,
            webhookId: wh.id,
            sourceEventId: execution!.sourceEventId,
            payload,
            identityMatching: receiptPlan!.identityMatching,
            actions: receiptPlan!.actions,
            dependencies: { credentialEncryptionKey: env.LINE_CREDENTIAL_ENCRYPTION_KEY },
            execution,
            });
            if (result.failed > 0) throw new Error('incoming_actions_failed');
            return result;
          });
        }
        await execution.step('event', () => fireEvent(execution!.db, eventType, {
          sourceEventId: execution!.sourceEventId,
          sourceKind: 'incoming_webhook_receipt',
          occurredAt: execution!.occurredAt,
          friendId: actionResult.matchedFriendId ?? undefined,
          eventData: { webhookId: wh.id, source: wh.source_type, payload, actionResult },
        }, undefined, wh.line_account_id ?? null, execution));
        if (actionResult.failed > 0) throw new Error('受信Webhookの処理に失敗しました');
      } catch (eventError) {
        if (interaction && wh.line_account_id) {
          try {
            await finishWebhookInteraction(execution.db, interaction.id, wh.line_account_id, {
              status: 'failed',
              responseStatus: 500,
              attemptCount: 1,
              durationMs: Date.now() - started,
              failureReason: 'processing_failed',
            });
          } catch (logError) {
            logger.error("webhooks.process_incoming_webhook_queue_failed");
          }
        }
        throw eventError;
      }
      if (interaction && wh.line_account_id) {
        try {
          await finishWebhookInteraction(execution.db, interaction.id, wh.line_account_id, {
            status: 'succeeded',
            responseStatus: 200,
            attemptCount: 1,
            durationMs: Date.now() - started,
          });
        } catch (logError) {
          // 受信処理は完了している。台帳の一時障害だけで送信元へ500を返さない。
          logger.error("webhooks.process_incoming_webhook_queue_failed");
        }
      }

      await execution.complete();

      await env.DB.prepare("UPDATE incoming_webhook_queue SET status='completed',payload_encrypted=NULL,updated_at=? WHERE source_event_id=?").bind(new Date().toISOString(),row.source_event_id).run();
      completed++;
    } catch {
      await execution.fail();
      await env.DB.prepare(`UPDATE incoming_webhook_queue SET next_attempt_at=?,updated_at=? WHERE source_event_id=?`).bind(new Date(Date.now()+300_000).toISOString(),new Date().toISOString(),row.source_event_id).run();
    }
  }
  return completed;
}
