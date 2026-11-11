import { jstCalendar as japanCalendar } from '@line-crm/shared';
import { jstDateOffset as japanDateOffset } from '@line-crm/shared';
export type { OperatorRuleConditions } from './operator-rule-types.js';
import type { OperatorRuleConditions } from './operator-rule-types.js';
import {deliverOperatorPush} from './operator-push.js';
import { ensureOperatorInstance } from './operator-notification-instance.js';
import { accountOpeningHours, openingDay } from './account-opening-hours.js';
//  公開済み運用者通知ルールの自動実行と回復。
//
// 業務イベント → dispatchOperatorEvent → 公開ルールだけ発火 → 台帳へ先に積む
// (durable) → 送る。Worker中断・cron再実行・再送は冪等キーで重複を作らない。
// 送り残し(pending/retry_wait)は sweepOperatorNotifications が回収する。
// event-bus.ts は他PRと重なるため触らず、この専用実行系だけを使う。

import { LineClient } from '@line-crm/line-sdk';
import {
  getActiveNotificationRulesByEvent,
  operatorRuleRecipientIds,
  eligibleTeamStaffIds,
  type NotificationRuleRow,
} from '@line-crm/db';

import { sendOperationEmail } from './operation-notifications.js';
import { isKnownOperatorEventType } from './operator-notification-registry.js';
import {
  classifyExternalDeliveryError,
  externalDeliveryRetryAt,
  EXTERNAL_DELIVERY_MAX_ATTEMPTS,
} from './external-delivery-retry.js';

const OPERATOR_NOTIFICATION_CHANNELS = new Set(['dashboard', 'email', 'line','push']);

/** 共通基盤 §6-2の値をそのまま公開し、独自の回数を持たない。 */
export const OPERATOR_DELIVERY_MAX_ATTEMPTS = EXTERNAL_DELIVERY_MAX_ATTEMPTS;
/** 取り掛かり中の取りこぼしと見なすまでの猶予(分)。in-flightの二重送信を避ける。 */
const STUCK_PENDING_LEASE_MINUTES = 5;

/**
 * cron の1回で回収する送達行の上限。
 *
 * **どのレーンに載せたか**: 既存の delivery レーン(5分ごと。式は
 * `SCHEDULED_CRONS.delivery`)。新しい cron 式は増やしていない。
 *
 * **なぜ5分か**: 再試行の待ち時間は共通基盤 §6-2 の 1分・5分・30分
 * (`EXTERNAL_DELIVERY_RETRY_DELAYS_MINUTES`)で決まる。回収がこれより細かく
 * 回っても待ち時間は縮まないので、意味があるのは最短の1分までである。
 * 1分レーンを新設すると 5分ごとに既存2レーンと重なる。frequentHeavy の式が
 * delivery の式から1分ずらしてあるのは重なりを避けるためなので、それを
 * 崩すことになる。得られるのは「最初の再試行が1〜6分後ではなく
 * ちょうど1分後に出る」だけで、運用者が画面・LINE・メールで読むお知らせに
 * その差は効かない。よって既存の delivery レーンに相乗りする。
 * **代償は明記しておく: 1分の再試行段は最大5分遅れて出る。**
 *
 * **なぜ100件か**: 5分間隔なので毎時12回、12×100 = **毎時1200行**が処理能力。
 * この口に溜まるのは「業務イベント側の同期送信で落ちた行」と「Worker が
 * 途中で止まって pending のまま残った行」だけで、初回送信は cron を通らない。
 * 1行あたりの再試行は最大 `EXTERNAL_DELIVERY_MAX_ATTEMPTS - 1` = 3回で、
 * 1分・5分・30分に散る。100 はこの sweep 自身の上限(`Math.min(..., 100)`)
 * と同じ値で、delivery レーンの他ジョブ(automation・reminder 等)が使っている
 * `limit: 100` にもそろえてある。
 *
 * **溜まる速さが1200行/時を超えたらどうなるか**: 取りこぼしはしない。SELECT は
 * `ORDER BY queued_at, d.id` の先入れ先出しなので、古い行から順に遅れて捌ける
 * だけである。これ以上増やすには sweep 側の clamp も上げる必要がある。
 */
export const OPERATOR_NOTIFICATION_SWEEP_LIMIT = 100;

export class OperatorEventError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export type OperatorExecutionMode = 'automatic' | 'test';

export type OperatorRecipient = {
  id: string;
  name: string;
  email: string | null;
  email_verified_at: string | null;
  line_user_id: string | null;
  notification_preferences: string;
};

export type OperatorDispatchPerRule = {
  ruleId: string;
  ruleVersion: number;
  instanceId: string;
  accepted: number;
  excluded: number;
  failed: number;
  /** 送達結果待ち(retry_wait)。sweep が回収する */
  pending: number;
  duplicate: number;
};

function jsonRecord(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export function ruleConditions(rule: { conditions: string }): OperatorRuleConditions {
  return jsonRecord(rule.conditions) as OperatorRuleConditions;
}

export function ruleChannels(rule: { channels: string }): string[] {
  try {
    const parsed = JSON.parse(rule.channels) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === 'string' && OPERATOR_NOTIFICATION_CHANNELS.has(value))
      : [];
  } catch {
    return [];
  }
}

function ruleVersion(rule: NotificationRuleRow): number {
  const version = Number((rule as { version?: unknown }).version ?? 1);
  return Number.isInteger(version) && version > 0 ? version : 1;
}

import { canAssignChatTo } from './chat-assignees.js';

async function assignedReplyChat(db: D1Database, accountId: string, sourceEventId: string) {
  return db.prepare(`SELECT c.assignee_staff_id, c.operator_id FROM messages_log m
    JOIN chats c ON c.friend_id = m.friend_id JOIN friends f ON f.id = c.friend_id
    WHERE m.id = ? AND m.line_account_id = ? AND f.line_account_id = ?`)
    .bind(sourceEventId, accountId, accountId).first<{assignee_staff_id:string|null;operator_id:string|null}>();
}

async function assignedReplyRecipient(db: D1Database, accountId: string, sourceEventId: string): Promise<string | null> {
  const id = (await assignedReplyChat(db, accountId, sourceEventId))?.assignee_staff_id;
  return id && await canAssignChatTo(db, id, accountId) ? id : null;
}

export async function operatorRecipients(
  db: D1Database,
  lineAccountId: string,
  recipientIds?: string[],
): Promise<OperatorRecipient[]> {
  const result = await db.prepare(`
    SELECT sm.id, sm.name, sm.email, sm.email_verified_at, sm.line_user_id,
           sm.notification_preferences
      FROM staff_members sm
      JOIN line_accounts la ON la.id = ?
     WHERE sm.is_active = 1
       AND COALESCE(sm.tenant_id, 'default') = COALESCE(la.tenant_id, 'default')
       AND (COALESCE(sm.account_scope, 'all') = 'all' OR sm.assigned_line_account_id = ?
         OR EXISTS (SELECT 1 FROM staff_account_scopes sas WHERE sas.staff_id = sm.id AND sas.line_account_id = la.id))
     ORDER BY sm.name, sm.id
  `).bind(lineAccountId, lineAccountId).all<OperatorRecipient>();
  const requested = recipientIds !== undefined ? new Set(recipientIds) : null;
  return (result.results ?? []).filter((recipient) => !requested || requested.has(recipient.id));
}

export function recipientPreview(recipient: OperatorRecipient, channels: string[]) {
  const preferences = jsonRecord(recipient.notification_preferences);
  const operator = preferences.operator && typeof preferences.operator === 'object'
    ? preferences.operator as Record<string, unknown>
    : {};
  const line = channels.includes('line') && Boolean(recipient.line_user_id) && operator.line !== false;
  const email = channels.includes('email') && Boolean(recipient.email && recipient.email_verified_at) && operator.email !== false;
  const dashboard = channels.includes('dashboard');
  return {
    id: recipient.id,
    name: recipient.name,
    lineLinked: Boolean(recipient.line_user_id),
    emailVerified: Boolean(recipient.email && recipient.email_verified_at),
    channels: { line, email, dashboard },
    canReceive: line || email || dashboard,
  };
}

async function accountToken(db: D1Database, lineAccountId: string): Promise<string | null> {
  const row = await db.prepare(
    `SELECT channel_access_token FROM line_accounts WHERE id = ? AND is_active = 1`,
  ).bind(lineAccountId).first<{ channel_access_token: string | null }>();
  return row?.channel_access_token?.trim() || null;
}

function operatorMessage(
  rule: { name: string; event_type: string; conditions: string },
  override?: string,
): string {
  const conditions = ruleConditions(rule);
  return override?.trim() || conditions.message?.trim()
    || `【運用者へのお知らせ】${rule.name}\n管理画面で内容を確認してください。`;
}

async function claimOperatorDelivery(
  db: D1Database,
  input: {
    lineAccountId: string;
    instanceId: string;
    ruleId: string;
    ruleVersion: number;
    recipientId: string;
    channel: 'line' | 'email' | 'in_app';
    executionMode: OperatorExecutionMode;
  },
): Promise<{ id: string; retryKey: string } | null> {
  const id = crypto.randomUUID();
  const seed = `${input.ruleId}:${input.instanceId}:${input.recipientId}:${input.channel}`;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(seed)));
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = [...digest.slice(0, 16)].map((value) => value.toString(16).padStart(2, '0')).join('');
  const retryKey = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  const now = new Date().toISOString();
  try {
    await db.prepare(`
      INSERT INTO notification_deliveries
        (id, line_account_id, instance_id, audience_type, recipient_type, recipient_id,
         channel, idempotency_key, status, retryable, attempts, queued_at,
         execution_mode, version, updated_at, source)
      VALUES (?, ?, ?, 'operator', 'staff', ?, ?, ?, 'pending', 0, 0, ?, ?, ?, ?,
              (SELECT i.source_event_type FROM notification_instances i
                WHERE i.id = ? AND i.line_account_id = ?))
    `).bind(
      id, input.lineAccountId, input.instanceId, input.recipientId, input.channel,
      retryKey, now, input.executionMode, input.ruleVersion, now,
      input.instanceId, input.lineAccountId,
    ).run();
    return { id, retryKey };
  } catch (error) {
    if (error instanceof Error && /UNIQUE/i.test(error.message)) return null;
    throw error;
  }
}

type DeliveryFinish =
  | { kind: 'accepted'; providerRequestId?: string | null }
  | { kind: 'excluded'; errorCode: string; errorMessage: string }
  | { kind: 'retry'; errorCode: string; errorMessage: string; providerError?: unknown }
  | { kind: 'failed'; errorCode: string; errorMessage: string };

async function recordDeliveryAttempt(
  db: D1Database,
  input: {
    deliveryId: string;
    attemptNumber: number;
    retryKey: string;
    outcome: 'provider_accepted' | 'retry_wait' | 'failed';
    providerRequestId?: string | null;
    errorCode?: string | null;
    errorMessage?: string | null;
    attemptedAt: string;
  },
): Promise<void> {
  await db.prepare(`
    INSERT INTO notification_delivery_attempts
      (id, delivery_id, attempt_number, retry_key, outcome,
       provider_request_id, error_code, error_message_safe, attempted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    crypto.randomUUID(), input.deliveryId, input.attemptNumber, input.retryKey,
    input.outcome, input.providerRequestId ?? null, input.errorCode ?? null,
    input.errorMessage ?? null, input.attemptedAt,
  ).run();
}

/** 送達行を確定する。retry は試行上限まで retry_wait、超えたら failed(恒久)にする。 */
async function finishOperatorDelivery(
  db: D1Database,
  input: {
    id: string;
    lineAccountId: string;
    retryKey: string;
    finish: DeliveryFinish;
  },
): Promise<'accepted' | 'excluded' | 'failed' | 'pending'> {
  const now = new Date().toISOString();
  const current = await db.prepare(`
    SELECT attempts FROM notification_deliveries WHERE id = ? AND line_account_id = ?
  `).bind(input.id, input.lineAccountId).first<{ attempts: number }>();
  if (!current) return 'failed';
  const attemptNumber = Number(current.attempts ?? 0) + 1;
  const recordedAttempts = input.finish.kind === 'excluded' ? current.attempts : attemptNumber;
  let status: 'provider_accepted' | 'excluded' | 'retry_wait' | 'failed';
  let retryable = 0;
  let nextRetryAt: string | null = null;
  let outcome: 'accepted' | 'excluded' | 'failed' | 'pending';
  let providerRequestId: string | null = null;
  let errorCode: string | null = null;
  let errorMessage: string | null = null;
  if (input.finish.kind === 'accepted') {
    status = 'provider_accepted';
    outcome = 'accepted';
    providerRequestId = input.finish.providerRequestId ?? null;
  } else if (input.finish.kind === 'excluded') {
    status = 'excluded';
    outcome = 'excluded';
    errorCode = input.finish.errorCode;
    errorMessage = input.finish.errorMessage;
  } else {
    errorCode = input.finish.errorCode;
    errorMessage = input.finish.errorMessage;
    const retryAt = input.finish.kind === 'retry'
      ? externalDeliveryRetryAt(input.finish.providerError, attemptNumber, new Date(now), true)
      : null;
    if (input.finish.kind === 'failed' || !retryAt) {
      status = 'failed';
      outcome = 'failed';
      if (input.finish.kind === 'retry') {
        errorCode = 'retry_exhausted';
        errorMessage = '自動再試行の上限に達しました。連携設定を確認し、必要なら手動で再試行してください。';
      }
    } else {
      status = 'retry_wait';
      outcome = 'pending';
      retryable = 1;
      nextRetryAt = retryAt.toISOString();
    }
  }
  const updated = await db.prepare(`
    UPDATE notification_deliveries
       SET status = ?, attempts = ?, retryable = ?, next_retry_at = ?,
           provider_request_id = ?, provider_status = ?,
           error_code = ?, error_message_safe = ?,
           accepted_at = CASE WHEN ? = 'provider_accepted' THEN ? ELSE accepted_at END,
           failed_at = CASE WHEN ? = 'failed' THEN ? ELSE failed_at END,
           updated_at = ?
     WHERE id = ? AND line_account_id = ?
       AND status IN ('pending', 'retry_wait') AND attempts = ?
  `).bind(
    status, recordedAttempts, retryable, nextRetryAt,
    providerRequestId, status === 'retry_wait' && errorCode === 'provider_response_unknown' ? 'unknown' : status,
    errorCode, errorMessage,
    status, now, status, now, now, input.id, input.lineAccountId, current.attempts,
  ).run();
  if (Number(updated.meta?.changes ?? 0) !== 1) return 'pending';
  if (status !== 'excluded') {
    await recordDeliveryAttempt(db, {
      deliveryId: input.id,
      attemptNumber,
      retryKey: input.retryKey,
      outcome: status === 'provider_accepted' ? 'provider_accepted'
        : status === 'retry_wait' ? 'retry_wait' : 'failed',
      providerRequestId,
      errorCode,
      errorMessage,
      attemptedAt: now,
    });
  }
  return outcome;
}

async function sendLineDelivery(
  db: D1Database,
  input: {
    deliveryId: string;
    lineAccountId: string;
    retryKey: string;
    token: string | null;
    lineUserId: string | null;
    canUseLine: boolean;
    text: string;
  },
): Promise<'accepted' | 'excluded' | 'failed' | 'pending'> {
  if (!input.canUseLine || !input.lineUserId || !input.token) {
    return finishOperatorDelivery(db, {
      id: input.deliveryId,
      lineAccountId: input.lineAccountId,
      retryKey: input.retryKey,
      finish: {
        kind: 'excluded',
        errorCode: !input.token ? 'line_account_not_connected' : 'staff_line_not_connected',
        errorMessage: !input.token ? 'LINEアカウントの接続を確認してください' : 'スタッフがLINEログインを完了していません',
      },
    });
  }
  // 運用者が書く通知文にも {{var.*}} を置ける。消えた共通情報は生の
  // 差し込み名のままスタッフへ届けず、この配送を失敗として残す。
  let text = input.text;
  try {
    const { expandSendCommonVars } = await import('./interpolation-context.js');
    text = await expandSendCommonVars(
      db, input.text,
      { kind: 'notification', id: input.deliveryId },
      { lineAccountId: input.lineAccountId },
    );
  } catch (error) {
    const { CommonVarResolutionFailedError } = await import('./interpolation-context.js');
    if (!(error instanceof CommonVarResolutionFailedError)) throw error;
    return finishOperatorDelivery(db, {
      id: input.deliveryId,
      lineAccountId: input.lineAccountId,
      retryKey: input.retryKey,
      finish: {
        kind: 'failed',
        errorCode: 'common_var_unresolved',
        errorMessage: `共通情報を解決できません: ${error.failures.map((f) => `{{var.${f.varKey}}}`).join(', ')}`,
      },
    });
  }
  try {
    const result = await new LineClient(input.token).pushMessageWithRequestId(
      input.lineUserId, [{ type: 'text', text }], input.retryKey,
    );
    const requestId = (result as { requestId?: unknown } | null | undefined)?.requestId;
    if (typeof requestId === 'string' && requestId.length > 0) {
      return finishOperatorDelivery(db, {
        id: input.deliveryId,
        lineAccountId: input.lineAccountId,
        retryKey: input.retryKey,
        finish: { kind: 'accepted', providerRequestId: requestId },
      });
    }
    // 応答消失: 送達不明として追跡し、再送で回収する(LINE側はretryKeyで重複防止)。
    return finishOperatorDelivery(db, {
      id: input.deliveryId,
      lineAccountId: input.lineAccountId,
      retryKey: input.retryKey,
      finish: {
        kind: 'retry',
        errorCode: 'provider_response_unknown',
        errorMessage: 'LINEの応答を確認できませんでした。送達不明として再送します',
      },
    });
  } catch (error) {
    const safe = classifyExternalDeliveryError(error, 'OPERATOR_LINE_ACCOUNT_NOT_FOUND');
    return finishOperatorDelivery(db, {
      id: input.deliveryId,
      lineAccountId: input.lineAccountId,
      retryKey: input.retryKey,
      finish: {
        kind: safe.retryable ? 'retry' : 'failed',
        errorCode: safe.code,
        errorMessage: safe.message,
        ...(safe.retryable ? { providerError: error } : {}),
      },
    });
  }
}

async function sendEmailDelivery(
  db: D1Database,
  env: { CONTACT_EMAIL?: string; XSERVER_RELAY_URL?: string; XSERVER_RELAY_SECRET?: string; XSERVER_MAIL_USER?: string },
  input: {
    deliveryId: string;
    lineAccountId: string;
    retryKey: string;
    to: string | null;
    canUseEmail: boolean;
    subject: string;
    text: string;
  },
): Promise<'accepted' | 'excluded' | 'failed' | 'pending'> {
  if (!input.canUseEmail || !input.to) {
    return finishOperatorDelivery(db, {
      id: input.deliveryId,
      lineAccountId: input.lineAccountId,
      retryKey: input.retryKey,
      finish: {
        kind: 'excluded',
        errorCode: 'staff_email_not_available',
        errorMessage: '確認済みのメールアドレスがありません',
      },
    });
  }
  try {
    await sendOperationEmail(env as Parameters<typeof sendOperationEmail>[0], {
      to: input.to,
      subject: input.subject,
      body: input.text,
    });
    return finishOperatorDelivery(db, {
      id: input.deliveryId,
      lineAccountId: input.lineAccountId,
      retryKey: input.retryKey,
      finish: { kind: 'accepted' },
    });
  } catch (error) {
    return finishOperatorDelivery(db, {
      id: input.deliveryId,
      lineAccountId: input.lineAccountId,
      retryKey: input.retryKey,
      finish: {
        kind: 'retry',
        errorCode: 'email_provider_error',
        errorMessage: 'メールが送信を受け付けませんでした',
        providerError: error,
      },
    });
  }
}

async function refreshOperatorInstanceStatus(
  db: D1Database,
  input: { lineAccountId: string; instanceId: string },
): Promise<void> {
  const totals = await db.prepare(`
    SELECT SUM(CASE WHEN status = 'provider_accepted' THEN 1 ELSE 0 END) AS accepted,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
           SUM(CASE WHEN status IN ('pending', 'retry_wait') THEN 1 ELSE 0 END) AS waiting
      FROM notification_deliveries
     WHERE instance_id = ? AND line_account_id = ?
  `).bind(input.instanceId, input.lineAccountId).first<{
    accepted: number | null; failed: number | null; waiting: number | null;
  }>();
  const failed = Number(totals?.failed ?? 0);
  const accepted = Number(totals?.accepted ?? 0);
  const waiting = Number(totals?.waiting ?? 0);
  // 恒久失敗が1件でもあれば failed。送達待ちが残れば pending(回収対象)。
  const instanceStatus = failed > 0 ? 'failed'
    : accepted > 0 && waiting === 0 ? 'completed'
    : accepted > 0 || waiting > 0 ? 'pending'
    : 'excluded';
  await db.prepare(`
    UPDATE notification_instances SET status = ?, updated_at = ?
     WHERE id = ? AND line_account_id = ?
  `).bind(instanceStatus, new Date().toISOString(), input.instanceId, input.lineAccountId).run();
}

/**
 * 業務イベントを公開済みルールへ自動発火する。
 * fail-close: このLINEアカウントの公開ルール・受信者・トークンだけ使う。
 * 登録簿に無いきっかけは OperatorEventError(unknown_event_type) で拒否する。
 */
export async function dispatchOperatorEvent(
  db: D1Database,
  env: Parameters<typeof sendOperationEmail>[0],
  input: {
    lineAccountId: string;
    eventType: string;
    sourceEventId: string;
    message?: string;
    executionMode: OperatorExecutionMode;
  },
): Promise<OperatorDispatchPerRule[]> {
  if (!isKnownOperatorEventType(input.eventType)) {
    throw new OperatorEventError(
      'unknown_event_type',
      `未登録のきっかけは自動発火しません: ${input.eventType}`,
    );
  }
  const rules = await getActiveNotificationRulesByEvent(db, input.eventType, input.lineAccountId);
  const results: OperatorDispatchPerRule[] = [];
  for (const rule of rules) {
    results.push(await dispatchOperatorRule(db, env, rule, {
      lineAccountId: input.lineAccountId,
      sourceEventId: input.sourceEventId,
      message: input.message,
      executionMode: input.executionMode,
    }));
  }
  return results;
}

export async function operatorRuleDeferredUntil(db: D1Database, accountId: string, conditions: OperatorRuleConditions, instanceId: string, now = new Date()): Promise<string|null> {
  const instance = await db.prepare('SELECT created_at,occurrence_count FROM notification_instances WHERE id=? AND line_account_id=?').bind(instanceId,accountId).first<{created_at:string;occurrence_count:number}>();
  const count = conditions.threshold === 'ten' ? 10 : conditions.threshold === 'three' ? 3 : 1;
  if (Number(instance?.occurrence_count ?? 0) < count) return new Date(now.getTime()+60_000).toISOString();
  if (conditions.schedule === 'morning_digest') {
    const setting = await db.prepare("SELECT value FROM account_settings WHERE line_account_id=? AND key='notifications.digest_time'").bind(accountId).first<{value:string}>();
    const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(setting?.value ?? '') ? setting!.value : '09:00';
    const day = japanDateOffset(1, new Date(instance!.created_at));
    const due = new Date(`${day}T${time}:00+09:00`);
    if (due > now) return due.toISOString();
  }
  if (conditions.schedule === 'business_hours') {
    const setting = await db.prepare('SELECT timezone FROM booking_settings WHERE line_account_id=?').bind(accountId).first<{timezone:string}>();
    let weekday:number,time:string,date:string;
    try {
      const parts=new Intl.DateTimeFormat('en-US',{timeZone:setting?.timezone??'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit',weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now);
      const part=(kind:string)=>parts.find(value=>value.type===kind)?.value??'';
      weekday=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(part('weekday'));
      time=`${part('hour')}:${part('minute')}`;
      date=`${part('year')}-${part('month')}-${part('day')}`;
    } catch {return new Date(now.getTime()+60_000).toISOString();}
    const source = await accountOpeningHours(db, accountId);
    const google = openingDay(source, date!);
    const open = google !== null ? google.some(period => period.start <= time && time < period.end) : await db.prepare(`SELECT 1 FROM booking_business_hours h JOIN booking_settings s ON s.id=h.booking_settings_id
      WHERE s.line_account_id=? AND s.business_hours_configured=1 AND h.weekday=? AND h.start_time<=? AND h.end_time>?`).bind(accountId,weekday,time,time).first();
    if (!open) return new Date(now.getTime()+60_000).toISOString();
  }
  return null;
}

async function operatorIsOnShift(db: D1Database, accountId: string, recipientId: string, now=new Date()): Promise<boolean> {
  const local=japanCalendar(now).toISOString();
  return Boolean(await db.prepare(`SELECT 1 FROM staff_shifts sh JOIN staff s ON s.id=sh.staff_id
    WHERE s.staff_member_id=? AND s.line_account_id=? AND s.is_active=1 AND s.deleted_at IS NULL
      AND sh.work_date=? AND sh.start_time<=? AND sh.end_time>?`).bind(recipientId,accountId,local.slice(0,10),local.slice(11,16),local.slice(11,16)).first());
}

export async function dispatchOperatorRule(
  db: D1Database,
  env: Parameters<typeof sendOperationEmail>[0],
  rule: NotificationRuleRow,
  input: {
    lineAccountId: string;
    sourceEventId: string;
    message?: string;
    executionMode: OperatorExecutionMode;
    /** 指定時はルールの受信者条件の代わりに使う(本人テスト送信用) */
    recipientIds?: string[];
  },
): Promise<OperatorDispatchPerRule> {
  const channels = ruleChannels(rule);if(channels.includes('push')&&!channels.includes('dashboard'))channels.push('dashboard');
  const conditions = ruleConditions(rule);
  const version = ruleVersion(rule);
  const text = operatorMessage(rule, input.message);
  const instanceId = await ensureOperatorInstance(db, {
    lineAccountId: input.lineAccountId,
    ruleId: rule.id,
    ruleVersion: version,
    ruleName: rule.name,
    message: text,
    sourceEventType: rule.event_type,
    sourceEventId: input.sourceEventId,
    dedupeMinutes: input.executionMode === 'test' ? 0 : Number(conditions.dedupeMinutes ?? 0),
    conditions,
    channels,
  });
  const configuredRecipients = input.recipientIds ?? await operatorRuleRecipientIds(db, input.lineAccountId, conditions);
  let recipients = await operatorRecipients(db, input.lineAccountId, configuredRecipients);
  let assignedRecipient: string | null = null;
  if (rule.event_type === 'inbox_assigned_reply' && input.executionMode !== 'test') {
    const chat = await assignedReplyChat(db, input.lineAccountId, input.sourceEventId);
    assignedRecipient = chat?.assignee_staff_id && await canAssignChatTo(db, chat.assignee_staff_id, input.lineAccountId)
      ? chat.assignee_staff_id : null;
    const legacy = Boolean(chat && !chat.assignee_staff_id && chat.operator_id);
    if (!chat) recipients = [];
    else if (configuredRecipients === undefined && !legacy) recipients = recipients.filter(recipient => recipient.id === assignedRecipient);
    const allowed = await Promise.all(recipients.map(recipient => canAssignChatTo(db, recipient.id, input.lineAccountId)));
    recipients = recipients.filter((_, index) => allowed[index]);
  }
  const token = channels.includes('line') ? await accountToken(db, input.lineAccountId) : null;
  let accepted = 0;
  let excluded = 0;
  let failed = 0;
  let pending = 0;
  let duplicate = 0;

  const deferUntil = input.executionMode === 'test' ? null : await operatorRuleDeferredUntil(db,input.lineAccountId,conditions,instanceId);
  for (const recipient of recipients) {
    const preview = recipientPreview(recipient, channels);
    for (const requestedChannel of channels) {
      if (rule.event_type === 'inbox_assigned_reply' && input.executionMode !== 'test'
        && requestedChannel === 'push' && recipient.id !== assignedRecipient) continue;
      if(requestedChannel==='push'){
        const message=await db.prepare('SELECT c.id,c.operator_id FROM messages_log m JOIN chats c ON c.friend_id=m.friend_id WHERE m.id=? AND m.line_account_id=?').bind(input.sourceEventId,input.lineAccountId).first<{id:string;operator_id:string|null}>();
        if(message&&['inbox_new_inquiry','inbox_assigned_reply'].includes(rule.event_type)){
          const result=await deliverOperatorPush(db,env,{staffId:recipient.id,account:input.lineAccountId,kind:rule.event_type==='inbox_new_inquiry'?'new_inquiry':'assigned_reply',refId:input.sourceEventId,chatId:message.id});accepted+=result.sent;failed+=result.failed;
        }
        continue;
      }

      const channel = requestedChannel === 'dashboard' ? 'in_app' : requestedChannel as 'line' | 'email';
      const claimed = await claimOperatorDelivery(db, {
        lineAccountId: input.lineAccountId,
        instanceId,
        ruleId: rule.id,
        ruleVersion: version,
        recipientId: recipient.id,
        channel,
        executionMode: input.executionMode,
      });
      if (!claimed) {
        duplicate += 1;
        continue;
      }
      if (deferUntil) {
        await db.prepare("UPDATE notification_deliveries SET status='retry_wait',retryable=1,error_code='schedule_wait',error_message_safe='通知条件を満たすまで待っています',next_retry_at=? WHERE id=?").bind(deferUntil,claimed.id).run();
        pending++; continue;
      }
      if (input.executionMode !== 'test' && conditions.onlyAvailable && !await operatorIsOnShift(db,input.lineAccountId,recipient.id)) {
        await finishOperatorDelivery(db,{id:claimed.id,lineAccountId:input.lineAccountId,retryKey:claimed.retryKey,finish:{kind:'excluded',errorCode:'staff_off_shift',errorMessage:'勤務時間外です'}});
        excluded++; continue;
      }
      if (channel === 'in_app') {
        /*
         * 通知センターの行は「同じ事象」1件につき1行。送達は受信者ごとに
         * 分かれるが、画面には宛先の区別が無いため、送達idを主キーにすると
         * 受信者の人数だけ同じ通知が並んでしまう。instance id を主キーにして
         * INSERT OR IGNORE で畳む。
         */
        await db.prepare(`
          INSERT OR IGNORE INTO notifications
            (id, rule_id, event_type, title, body, channel, status, metadata,
             line_account_id, category, created_at)
          VALUES (?, ?, ?, ?, ?, 'dashboard', 'sent', ?, ?, ?, ?)
        `).bind(
          instanceId, rule.id, rule.event_type, rule.name, text,
          JSON.stringify({ sourceEventId: input.sourceEventId, executionMode: input.executionMode }),
          input.lineAccountId, conditions.importance === 'urgent' ? 'error' : 'info',
          new Date().toISOString(),
        ).run();
        await finishOperatorDelivery(db, {
          id: claimed.id,
          lineAccountId: input.lineAccountId,
          retryKey: claimed.retryKey,
          finish: { kind: 'accepted' },
        });
        accepted += 1;
        continue;
      }
      const outcome = channel === 'line'
        ? await sendLineDelivery(db, {
          deliveryId: claimed.id,
          lineAccountId: input.lineAccountId,
          retryKey: claimed.retryKey,
          token,
          lineUserId: recipient.line_user_id,
          canUseLine: preview.channels.line,
          text,
        })
        : await sendEmailDelivery(db, env, {
          deliveryId: claimed.id,
          lineAccountId: input.lineAccountId,
          retryKey: claimed.retryKey,
          to: recipient.email,
          canUseEmail: preview.channels.email,
          subject: `【運用者へのお知らせ】${rule.name}`,
          text,
        });
      if (outcome === 'accepted') accepted += 1;
      else if (outcome === 'excluded') excluded += 1;
      else if (outcome === 'failed') failed += 1;
      else pending += 1;
    }
  }

  await refreshOperatorInstanceStatus(db, { lineAccountId: input.lineAccountId, instanceId });
  return { ruleId: rule.id, ruleVersion: version, instanceId, accepted, excluded, failed, pending, duplicate };
}

type SweepRow = {
  id: string;
  line_account_id: string;
  instance_id: string;
  recipient_id: string;
  channel: string;
  idempotency_key: string;
  status: string;
  attempts: number;
  updated_at: string;
  execution_mode: OperatorExecutionMode;
};

export type OperatorSweepResult = {
  swept: number;
  accepted: number;
  excluded: number;
  failed: number;
  pending: number;
};

/**
 * 送り残し(durable outbox)の回収。Worker中断・cron再実行の後に呼ぶ。
 * - status=pending で猶予を過ぎた行(確保したまま送れなかった分)
 * - status=retry_wait で再送時刻を過ぎた行
 * を楽観ロックで1件ずつ引き取り、同じ冪等キーで送り直す。
 */
export async function sweepOperatorNotifications(
  db: D1Database,
  env: Parameters<typeof sendOperationEmail>[0],
  input: { lineAccountId?: string; limit?: number; now?: Date } = {},
): Promise<OperatorSweepResult> {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const stuckBefore = new Date(now.getTime() - STUCK_PENDING_LEASE_MINUTES * 60_000).toISOString();
  const limit = Math.max(1, Math.min(input.limit ?? 20, 100));
  const accountFilter = input.lineAccountId ? 'AND d.line_account_id = ?' : '';
  const values: unknown[] = input.lineAccountId ? [input.lineAccountId] : [];
  const rows = await db.prepare(`
    SELECT d.id, d.line_account_id, d.instance_id, d.recipient_id, d.channel,
           d.idempotency_key, d.status, d.attempts, d.updated_at, d.execution_mode
      FROM notification_deliveries d
     WHERE d.audience_type = 'operator'
       AND (
             (d.status = 'pending' AND d.queued_at <= ?)
          OR (d.status = 'retry_wait' AND d.retryable = 1 AND d.next_retry_at <= ?)
           )
       ${accountFilter}
     ORDER BY d.queued_at, d.id
     LIMIT ?
  `).bind(stuckBefore, nowIso, ...values, limit).all<SweepRow>();

  const result: OperatorSweepResult = { swept: 0, accepted: 0, excluded: 0, failed: 0, pending: 0 };
  for (const row of rows.results ?? []) {
    // 楽観ロック: 誰も触っていない行だけ引き取る(2接続の競合防止)。
    const leaseToken = `lease:${crypto.randomUUID()}`;
    const leaseUntil = new Date(now.getTime() + STUCK_PENDING_LEASE_MINUTES * 60_000).toISOString();
    const claimed = await db.prepare(`
      UPDATE notification_deliveries
         SET status = 'retry_wait', retryable = 1, next_retry_at = ?, updated_at = ?
       WHERE id = ? AND line_account_id = ? AND status = ? AND attempts = ? AND updated_at = ?
    `).bind(
      leaseUntil, leaseToken,
      row.id, row.line_account_id, row.status, row.attempts, row.updated_at,
    ).run();
    if (Number(claimed.meta?.changes ?? 0) !== 1) continue;
    result.swept += 1;

    const instance = await db.prepare(`
      SELECT definition_id, source_event_type, source_event_id, source_metadata_json, line_account_id
        FROM notification_instances WHERE id = ? AND line_account_id = ?
    `).bind(row.instance_id, row.line_account_id).first<{
      definition_id: string | null; source_event_type: string; source_event_id: string;
      source_metadata_json: string | null; line_account_id: string;
    }>();
    const metadata = jsonRecord(instance?.source_metadata_json ?? '');
    const text = typeof metadata.message === 'string' && metadata.message.length > 0
      ? metadata.message
      : '【運用者へのお知らせ】\n管理画面で内容を確認してください。';
    const ruleName = typeof metadata.ruleName === 'string' ? metadata.ruleName : '運用者へのお知らせ';

    if (!instance?.definition_id) {
      await finishOperatorDelivery(db, {
        id: row.id,
        lineAccountId: row.line_account_id,
        retryKey: row.idempotency_key,
        finish: { kind: 'failed', errorCode: 'instance_not_found', errorMessage: '通知の発生元が見つかりません' },
      });
      result.failed += 1;
      continue;
    }
    const recipient = await db.prepare(`
      SELECT id, email, email_verified_at, line_user_id, notification_preferences,
             is_active, tenant_id, account_scope, assigned_line_account_id
        FROM staff_members WHERE id = ?
    `).bind(row.recipient_id).first<OperatorRecipient & {
      is_active: number; tenant_id: string | null;
      account_scope: string | null; assigned_line_account_id: string | null;
    }>();
    const account = await db.prepare(`
      SELECT tenant_id FROM line_accounts WHERE id = ?
    `).bind(row.line_account_id).first<{ tenant_id: string | null }>();
    const sameTenant = Boolean(recipient && account
      && (recipient.tenant_id ?? 'default') === (account.tenant_id ?? 'default'));
    const inScope = (await eligibleTeamStaffIds(db, row.line_account_id, [row.recipient_id])).length === 1;
    const teamConditions = metadata.conditions as OperatorRuleConditions | undefined;
    const inTeam = row.execution_mode === 'test' || !teamConditions?.teamId
      || (await operatorRuleRecipientIds(db, row.line_account_id, teamConditions))?.includes(row.recipient_id);
    let assigned = true;
    if (instance.source_event_type === 'inbox_assigned_reply' && row.execution_mode !== 'test') {
      const chat = await assignedReplyChat(db, row.line_account_id, instance.source_event_id);
      const legacy = Boolean(chat && !chat.assignee_staff_id && chat.operator_id);
      const specified = Boolean(teamConditions?.teamId) || Array.isArray(teamConditions?.recipientIds);
      const mustMatch = !specified && !legacy;
      assigned = Boolean(chat) && await canAssignChatTo(db, row.recipient_id, row.line_account_id)
        && (!mustMatch || await assignedReplyRecipient(db, row.line_account_id, instance.source_event_id) === row.recipient_id);
    }
    if (!recipient || recipient.is_active !== 1 || !sameTenant || !inScope || !inTeam || !assigned) {
      await finishOperatorDelivery(db, {
        id: row.id,
        lineAccountId: row.line_account_id,
        retryKey: row.idempotency_key,
        finish: { kind: 'excluded', errorCode: 'staff_not_available', errorMessage: '受け取るスタッフが無効です' },
      });
      result.excluded += 1;
      continue;
    }
    const channels = Array.isArray(metadata.channels)
      ? metadata.channels.filter((value): value is string => (
        typeof value === 'string' && OPERATOR_NOTIFICATION_CHANNELS.has(value)
      ))
      : [];
    const conditions = metadata.conditions as OperatorRuleConditions ?? {};
    const deferUntil = await operatorRuleDeferredUntil(db,row.line_account_id,conditions,row.instance_id,now);
    if (deferUntil) {
      await db.prepare("UPDATE notification_deliveries SET status='retry_wait',retryable=1,error_code='schedule_wait',error_message_safe='通知条件を満たすまで待っています',next_retry_at=? WHERE id=? AND updated_at=?").bind(deferUntil,row.id,leaseToken).run();
      result.pending++; continue;
    }
    if (conditions.onlyAvailable && !await operatorIsOnShift(db,row.line_account_id,row.recipient_id,now)) {
      await finishOperatorDelivery(db,{id:row.id,lineAccountId:row.line_account_id,retryKey:row.idempotency_key,finish:{kind:'excluded',errorCode:'staff_off_shift',errorMessage:'勤務時間外です'}});
      result.excluded++; continue;
    }
    const preview = recipientPreview(recipient, channels);
    const ruleConditionsSnapshot = metadata.conditions
      && typeof metadata.conditions === 'object'
      && !Array.isArray(metadata.conditions)
      ? metadata.conditions as OperatorRuleConditions
      : {};
    const token = row.channel === 'line' ? await accountToken(db, row.line_account_id) : null;
    if (row.channel === 'in_app') {
      // 発火時と同じく instance id を主キーにする。回収経路で別idを付けると
      // 同じ事象が2行に割れる。
      await db.prepare(`
        INSERT OR IGNORE INTO notifications
          (id, rule_id, event_type, title, body, channel, status, metadata,
           line_account_id, category, created_at)
        VALUES (?, ?, ?, ?, ?, 'dashboard', 'sent', ?, ?, ?, ?)
      `).bind(
        row.instance_id, instance.definition_id, instance.source_event_type, ruleName, text,
        JSON.stringify({ sourceEventId: instance.source_event_id, executionMode: row.execution_mode, recovered: true }),
        row.line_account_id,
        ruleConditionsSnapshot.importance === 'urgent' ? 'error' : 'info',
        nowIso,
      ).run();
    }
    const outcome = row.channel === 'line'
      ? await sendLineDelivery(db, {
        deliveryId: row.id,
        lineAccountId: row.line_account_id,
        retryKey: row.idempotency_key,
        token,
        lineUserId: recipient.line_user_id,
        canUseLine: preview.channels.line,
        text,
      })
      : row.channel === 'email'
        ? await sendEmailDelivery(db, env, {
          deliveryId: row.id,
          lineAccountId: row.line_account_id,
          retryKey: row.idempotency_key,
          to: recipient.email,
          canUseEmail: preview.channels.email,
          subject: `【運用者へのお知らせ】${ruleName}`,
          text,
        })
        : await finishOperatorDelivery(db, {
          id: row.id,
          lineAccountId: row.line_account_id,
          retryKey: row.idempotency_key,
          finish: { kind: 'accepted' },
        });
    if (outcome === 'accepted') result.accepted += 1;
    else if (outcome === 'excluded') result.excluded += 1;
    else if (outcome === 'failed') result.failed += 1;
    else result.pending += 1;
    await refreshOperatorInstanceStatus(db, {
      lineAccountId: row.line_account_id,
      instanceId: row.instance_id,
    });
  }
  return result;
}
