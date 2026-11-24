import { parseOffsetPaging, buildOffsetListResponse } from '../lib/list-paging.js';
import { tracedFetch as fetch } from '@line-crm/shared/server';
import { sqlIdSet } from '@line-crm/db/id-queries';
import { isCalendarDate as isExistingCalendarDate } from '@line-crm/shared';
import { inputError, inputJsonBoundary } from '../lib/input-errors.js';
import { Hono, type Context } from 'hono';
import { LineClient, type Message } from '@line-crm/line-sdk';

import {
  LineNotificationError,
  createCustomerNotificationDefinition,
  getCustomerNotificationDefinition,
  getNotificationDeliveryForRetry,
  claimNotificationDeliveryRetry,
  finishNotificationDeliveryRetry,
  getLineAccountById,
  listCustomerNotificationDefinitions,
  listNotificationDeliveryAttempts,
  listNotificationDeliveries,
  listNotificationMetrics,
  publishCustomerNotificationDefinition,
  stopCustomerNotificationDefinition,
  setNotificationDeliveryResolution,
  updateCustomerNotificationDraft,
  getNotificationDelivery,
  insertNotificationResendDelivery,
  finishNotificationResendDelivery,
  createCustomerTestInstance,
  failCustomerTestInstance,
  recordCustomerTestDelivery,
  recordCustomerTestAudit,
  jstDateString,
  nextDateString,
  type CustomerNotificationDefinitionRow,
  type CustomerNotificationVersionRow,
  type NotificationDeliveryListRow,
  type NotificationDeliveryAttemptRow,
} from '@line-crm/db';

import type { Env } from '../worker-env.js';
import { requireDeliveryAccess, requireRole } from '../middleware/role-guard.js';
import { canAccessAllLineAccounts } from '../services/account-access.js';
import { auditLog } from '../lib/audit-log.js';
import {
  releaseQuotaSlot,
  tryReserveQuotaSlot,
} from '../features/broadcasts/broadcast-quota-guard/index.js';

const lineNotifications = new Hono<Env>();

type CustomerDraft = Record<string, unknown> & {
  lineTemplate?: unknown;
  aggregationRule?: unknown;
  emailFallbackPolicy?: unknown;
};

function jsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function serializeVersion(row: CustomerNotificationVersionRow) {
  return {
    id: row.id,
    versionNumber: Number(row.version_number),
    config: jsonObject(row.config_json),
    aggregationRule: row.aggregation_rule,
    emailFallbackPolicy: row.email_fallback_policy,
    publishedBy: row.published_by,
    publishedAt: row.published_at,
  };
}

function serializeDefinition(
  row: CustomerNotificationDefinitionRow,
  versions?: CustomerNotificationVersionRow[],
) {
  return {
    id: row.id,
    lineAccountId: row.line_account_id,
    key: row.key,
    name: row.name,
    category: row.category,
    sourceEventType: row.source_event_type,
    status: row.status,
    draft: jsonObject(row.draft_config_json),
    currentVersionId: row.current_version_id,
    currentVersionNumber: row.current_version_number == null
      ? null
      : Number(row.current_version_number),
    transactionalOnly: true,
    version: Number(row.version),
    updatedAt: row.updated_at,
    ...(versions ? { versions: versions.map(serializeVersion) } : {}),
  };
}

function bodyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function bodyVersion(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function bodyDraft(value: unknown): CustomerDraft | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as CustomerDraft
    : null;
}

function validateCustomerDraft(draft: CustomerDraft): string | null {
  const text = (key: string): string | null => {
    const value = draft[key];
    return value === undefined || typeof value === 'string' ? value ?? null : null;
  };
  const hasInvalidText = (key: string): boolean => draft[key] !== undefined && typeof draft[key] !== 'string';
  if (hasInvalidText('title') || hasInvalidText('introText') || hasInvalidText('outroText')
      || hasInvalidText('buttonLabel') || hasInvalidText('buttonUrl') || hasInvalidText('imageUrl')) {
    return '通知文面は文字列で入力してください';
  }
  const title = text('title')?.trim();
  if (title !== undefined && title !== null && (!title || title.length > 80)) {
    return '通知の見出しは1〜80文字で入力してください';
  }
  if ((text('introText')?.trim().length ?? 0) > 800 || (text('outroText')?.trim().length ?? 0) > 800) {
    return '通知の本文は800文字以内で入力してください';
  }
  if ((text('buttonLabel')?.trim().length ?? 0) > 20) {
    return 'ボタン名は20文字以内で入力してください';
  }
  for (const key of ['buttonUrl', 'imageUrl']) {
    const value = text(key)?.trim() ?? '';
    if (!value) continue;
    try {
      if (new URL(value).protocol !== 'https:') return 'URLはhttpsで始まるものを入力してください';
    } catch {
      return 'URLはhttpsで始まるものを入力してください';
    }
  }
  return null;
}

async function requireAccount(c: Context<Env>, lineAccountId: string): Promise<Response | null> {
  if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [lineAccountId])) {
    return c.json({ success: false, error: 'このLINEアカウントを表示する権限がありません' }, 403);
  }
  return null;
}

function definitionError(c: Context<Env>, error: unknown): Response | null {
  if (!(error instanceof LineNotificationError)) return null;
  if (error.code === 'not_found') {
    return c.json({ success: false, code: error.code, error: error.message }, 404);
  }
  return c.json({ success: false, code: error.code, error: error.message }, 409);
}

lineNotifications.get(
  '/api/line-notifications/customer-definitions',
  requireRole('owner', 'admin', 'staff'),
  async (c) => {
    const lineAccountId = c.req.query('lineAccountId')?.trim();
    if (!lineAccountId) {
      return c.json({ success: false, error: 'LINEアカウントを選択してください' }, 400);
    }
    const denied = await requireAccount(c, lineAccountId);
    if (denied) return denied;
    const rows = await listCustomerNotificationDefinitions(c.env.DB, lineAccountId);
    return c.json({ success: true, data: rows.map((row) => serializeDefinition(row)) });
  },
);

lineNotifications.get(
  '/api/line-notifications/customer-definitions/:id',
  requireRole('owner', 'admin', 'staff'),
  async (c) => {
    const lineAccountId = c.req.query('lineAccountId')?.trim();
    if (!lineAccountId) {
      return c.json({ success: false, error: 'LINEアカウントを選択してください' }, 400);
    }
    const denied = await requireAccount(c, lineAccountId);
    if (denied) return denied;
    const found = await getCustomerNotificationDefinition(c.env.DB, c.req.param('id'), lineAccountId);
    if (!found) return c.json({ success: false, error: 'お知らせが見つかりません' }, 404);
    return c.json({
      success: true,
      data: serializeDefinition(found.definition, found.versions),
    });
  },
);

lineNotifications.post(
  '/api/line-notifications/customer-definitions',
  requireDeliveryAccess('lineNotifications'),
  inputJsonBoundary(), async (c) => {
    const body = await c.req.json<Record<string, unknown>>().catch(() => null);
    const lineAccountId = bodyString(body?.lineAccountId);
    const key = bodyString(body?.key);
    const name = bodyString(body?.name);
    const category = bodyString(body?.category);
    const sourceEventType = bodyString(body?.sourceEventType);
    const draft = bodyDraft(body?.draft);
    if (!lineAccountId || !key || !name || !category || !sourceEventType || !draft) {
      return inputError(c, { success: false, error: 'LINEアカウント、キー、名前、区分、きっかけ、下書きは必須です' }, 400, ["lineAccountId","key","name","category","sourceEventType","draft"]);
    }
    const draftError = validateCustomerDraft(draft);
    if (draftError) return inputError(c, { success: false, error: draftError }, 400, ["draft"]);
    const denied = await requireAccount(c, lineAccountId);
    if (denied) return denied;
    try {
      const created = await createCustomerNotificationDefinition(c.env.DB, {
        lineAccountId,
        key,
        name,
        category,
        sourceEventType,
        draftConfig: draft,
        staffId: c.get('staff').id,
      });
      auditLog(c, 'line_notification.definition.create', { kind: 'line_account', id: lineAccountId });
      return c.json({ success: true, data: serializeDefinition(created.definition, created.versions) }, 201);
    } catch (error) {
      const response = definitionError(c, error);
      if (response) return response;
      throw error;
    }
  },
);

lineNotifications.patch(
  '/api/line-notifications/customer-definitions/:id/draft',
  requireDeliveryAccess('lineNotifications'),
  inputJsonBoundary(), async (c) => {
    const body = await c.req.json<Record<string, unknown>>().catch(() => null);
    const lineAccountId = bodyString(body?.lineAccountId);
    const expectedVersion = bodyVersion(body?.expectedVersion);
    const name = bodyString(body?.name);
    const category = bodyString(body?.category);
    const sourceEventType = bodyString(body?.sourceEventType);
    const draft = bodyDraft(body?.draft);
    if (!lineAccountId || !expectedVersion || !name || !category || !sourceEventType || !draft) {
      return inputError(c, { success: false, error: 'LINEアカウント、現在の版、名前、区分、きっかけ、下書きは必須です' }, 400, ["lineAccountId","expectedVersion","name","category","sourceEventType","draft"]);
    }
    const draftError = validateCustomerDraft(draft);
    if (draftError) return inputError(c, { success: false, error: draftError }, 400, ["draft"]);
    const denied = await requireAccount(c, lineAccountId);
    if (denied) return denied;
    try {
      const updated = await updateCustomerNotificationDraft(c.env.DB, {
        id: c.req.param('id'),
        lineAccountId,
        expectedVersion,
        name,
        category,
        sourceEventType,
        draftConfig: draft,
        staffId: c.get('staff').id,
      });
      auditLog(c, 'line_notification.definition.update', { kind: 'customer_notification', id: c.req.param('id') });
      return c.json({ success: true, data: serializeDefinition(updated.definition, updated.versions) });
    } catch (error) {
      const response = definitionError(c, error);
      if (response) return response;
      throw error;
    }
  },
);

lineNotifications.post(
  '/api/line-notifications/customer-definitions/:id/publish',
  requireDeliveryAccess('lineNotifications'),
  inputJsonBoundary(), async (c) => {
    const body = await c.req.json<Record<string, unknown>>().catch(() => null);
    const lineAccountId = bodyString(body?.lineAccountId);
    const expectedVersion = bodyVersion(body?.expectedVersion);
    if (!lineAccountId || !expectedVersion) {
      return inputError(c, { success: false, error: 'LINEアカウントと現在の版は必須です' }, 400, ["lineAccountId","expectedVersion"]);
    }
    const denied = await requireAccount(c, lineAccountId);
    if (denied) return denied;
    const current = await getCustomerNotificationDefinition(c.env.DB, c.req.param('id'), lineAccountId);
    if (!current) return c.json({ success: false, error: 'お知らせが見つかりません' }, 404);
    const draft = jsonObject(current.definition.draft_config_json) as CustomerDraft;
    const draftError = validateCustomerDraft(draft);
    if (draftError) return inputError(c, { success: false, error: draftError }, 400, ["lineAccountId"]);
    //  ECイベントがきっかけの定義は、送信文面をイベント内容
    // から組み立てる(ecFlexMessage)ので、静的なLINEテンプレートは要らない。
    // それ以外の定義は、送る中身が無いまま公開できないようテンプレートを必須にする。
    if (!current.definition.source_event_type.startsWith('ec.')
        && (!Array.isArray(draft.lineTemplate) || draft.lineTemplate.length === 0)) {
      return c.json({ success: false, code: 'incomplete_draft', error: 'LINEで送る内容を設定してください' }, 409);
    }
    try {
      const published = await publishCustomerNotificationDefinition(c.env.DB, {
        id: c.req.param('id'), lineAccountId, expectedVersion, staffId: c.get('staff').id,
      });
      auditLog(c, 'line_notification.definition.publish', { kind: 'customer_notification', id: c.req.param('id') });
      return c.json({ success: true, data: serializeDefinition(published.definition, published.versions) });
    } catch (error) {
      const response = definitionError(c, error);
      if (response) return response;
      throw error;
    }
  },
);

lineNotifications.post(
  '/api/line-notifications/customer-definitions/:id/stop',
  requireDeliveryAccess('lineNotifications'),
  inputJsonBoundary(), async (c) => {
    const body = await c.req.json<Record<string, unknown>>().catch(() => null);
    const lineAccountId = bodyString(body?.lineAccountId);
    const expectedVersion = bodyVersion(body?.expectedVersion);
    if (!lineAccountId || !expectedVersion) {
      return inputError(c, { success: false, error: 'LINEアカウントと現在の版は必須です' }, 400, ["lineAccountId","expectedVersion"]);
    }
    const denied = await requireAccount(c, lineAccountId);
    if (denied) return denied;
    try {
      const stopped = await stopCustomerNotificationDefinition(c.env.DB, {
        id: c.req.param('id'), lineAccountId, expectedVersion, staffId: c.get('staff').id,
      });
      auditLog(c, 'line_notification.definition.stop', { kind: 'customer_notification', id: c.req.param('id') });
      return c.json({ success: true, data: serializeDefinition(stopped.definition, stopped.versions) });
    } catch (error) {
      const response = definitionError(c, error);
      if (response) return response;
      throw error;
    }
  },
);

function publicDeliveryStatus(status: NotificationDeliveryListRow['status']) {
  if (status === 'provider_accepted') return 'accepted' as const;
  if (status === 'excluded') return 'excluded' as const;
  if (status === 'retry_wait' || status === 'failed') return 'failed' as const;
  return 'pending' as const;
}

function sourceLabel(sourceEventType: string): string {
  return sourceEventType.startsWith('ec.') || sourceEventType.startsWith('ec_') ? 'EC連携' : '共通通知';
}

function sourceMetadata(value: string | null): Record<string, unknown> {
  if (!value) return {};
  return jsonObject(value);
}

function serializeDeliveryItem(
  row: NotificationDeliveryListRow,
  attemptHistory: NotificationDeliveryAttemptRow[],
) {
  const metadata = sourceMetadata(row.source_metadata_json);
  return {
    id: row.id,
    recipientType: row.audience_type,
    notificationName: row.definition_name ?? row.source_event_type,
    source: sourceLabel(row.source_event_type),
    sourceEventId: row.source_event_id,
    friendId: row.recipient_type === 'friend' ? row.recipient_id : null,
    friendName: row.friend_name,
    orderNumber: typeof metadata.orderNumber === 'string' ? metadata.orderNumber : null,
    channel: row.channel,
    status: publicDeliveryStatus(row.status),
    reason: row.error_message_safe,
    receivedAt: row.queued_at,
    acceptedAt: row.accepted_at,
    attemptCount: Number(row.attempts),
    nextRetryAt: row.next_retry_at,
    clickedAt: row.clicked_at,
    version: row.definition_version == null ? null : Number(row.definition_version),
    executionMode: row.execution_mode,
    retryAvailable: row.resolution_action !== 'resolved' && Number(row.retryable) === 1
      && (row.status === 'retry_wait' || row.status === 'failed'),
    recordVersion: Number(row.version),
    providerStatus: row.provider_status,
    resolved: row.resolution_action === 'resolved',
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by_name,
    attemptHistory: attemptHistory.map((attempt) => ({
      number: Number(attempt.attempt_number),
      outcome: attempt.outcome,
      attemptedAt: attempt.attempted_at,
      providerRequestId: attempt.provider_request_id,
      errorCode: attempt.error_code,
      error: attempt.error_message_safe,
    })),
  };
}

/** 画面と互換APIが共有する、アカウント限定の送信台帳レスポンス。 */
export async function notificationDeliveriesResponse(c: Context<Env>): Promise<Response> {
  const lineAccountId = c.req.query('lineAccountId')?.trim();
  if (!lineAccountId) {
    return inputError(c, { success: false, error: 'LINEアカウントを選択してください' }, 400, ["lineAccountId"]);
  }
  const denied = await requireAccount(c, lineAccountId);
  if (denied) return denied;
  const { limit, offset } = parseOffsetPaging({ limit: c.req.query('limit'), offset: c.req.query('offset') }, { defaultLimit: 20, limitPolicy: { fallback: 'integer', minimum: 1, maximum: 100 }, offsetPolicy: { fallback: 'integer', minimum: 0 } });
  const view = c.req.query('view') ?? 'all';
  if (view !== 'all' && view !== 'failures') {
    return inputError(c, { success: false, error: '表示条件が正しくありません' }, 400, ["view"]);
  }
  const result = await listNotificationDeliveries(c.env.DB, { lineAccountId, view, limit, offset });
  const attempts = await listNotificationDeliveryAttempts(
    c.env.DB,
    lineAccountId,
    result.items.map((row) => row.id),
  );
  const attemptsByDelivery = new Map<string, typeof attempts>();
  for (const attempt of attempts) {
    const current = attemptsByDelivery.get(attempt.delivery_id) ?? [];
    current.push(attempt);
    attemptsByDelivery.set(attempt.delivery_id, current);
  }
  const quota = c.req.query('includeQuota') === '1'
    ? await notificationQuotaForAccount(c, lineAccountId)
    : null;
  return c.json({
    success: true,
    data: buildOffsetListResponse({ items: result.items.map((row) => serializeDeliveryItem(row, attemptsByDelivery.get(row.id) ?? [])),
      summary: result.summary,
      coverage: {
        source: 'notification_delivery_ledger',
        unassignedHistoricalRowsExcluded: true,
        attemptHistoryAvailable: true,
        retryAvailable: true,
      },
      ...(quota ? { quota } : {}), total: result.total, paging: { limit, offset }, sort: [] }),
    pagination: { total: result.total, limit, offset },
  });
}

lineNotifications.get(
  '/api/line-notifications/deliveries',
  requireRole('owner', 'admin', 'staff'),
  notificationDeliveriesResponse,
);

type NotificationQuota =
  | { state: 'available'; total: number; used: number; remaining: number; asOf: string }
  | { state: 'unlimited'; total: null; used: number; remaining: null; asOf: string }
  | { state: 'unavailable'; total: null; used: null; remaining: null; asOf: null; reason: string };

async function notificationQuota(channelAccessToken: string): Promise<NotificationQuota> {
  const headers = { Authorization: `Bearer ${channelAccessToken}` };
  try {
    const [quotaResponse, consumptionResponse] = await Promise.all([
      fetch('https://api.line.me/v2/bot/message/quota', {
        headers,
        signal: AbortSignal.timeout(10_000),
      }),
      fetch('https://api.line.me/v2/bot/message/quota/consumption', {
        headers,
        signal: AbortSignal.timeout(10_000),
      }),
    ]);
    if (!quotaResponse.ok || !consumptionResponse.ok) {
      return { state: 'unavailable', total: null, used: null, remaining: null, asOf: null, reason: 'LINEから送信枠を取得できませんでした' };
    }
    const quota = await quotaResponse.json() as { type?: unknown; value?: unknown };
    const consumption = await consumptionResponse.json() as { totalUsage?: unknown };
    const used = typeof consumption.totalUsage === 'number'
      && Number.isFinite(consumption.totalUsage) && consumption.totalUsage >= 0
      ? Math.floor(consumption.totalUsage)
      : null;
    if (used === null) {
      return { state: 'unavailable', total: null, used: null, remaining: null, asOf: null, reason: '今月の送信数を取得できませんでした' };
    }
    const asOf = new Date().toISOString();
    if (quota.type === 'none') {
      return { state: 'unlimited', total: null, used, remaining: null, asOf };
    }
    const total = quota.type === 'limited' && typeof quota.value === 'number'
      && Number.isFinite(quota.value) && quota.value >= 0
      ? Math.floor(quota.value)
      : null;
    if (total === null) {
      return { state: 'unavailable', total: null, used: null, remaining: null, asOf: null, reason: '送信枠の総量を取得できませんでした' };
    }
    return { state: 'available', total, used, remaining: Math.max(0, total - used), asOf };
  } catch {
    return { state: 'unavailable', total: null, used: null, remaining: null, asOf: null, reason: 'LINEから送信枠を取得できませんでした' };
  }
}

async function notificationQuotaForAccount(
  c: Context<Env>,
  lineAccountId: string,
): Promise<NotificationQuota> {
  try {
    const account = await getLineAccountById(
      c.env.DB,
      lineAccountId,
      c.env.LINE_CREDENTIAL_ENCRYPTION_KEY,
    );
    const token = account?.channel_access_token?.trim();
    if (!token) {
      return { state: 'unavailable', total: null, used: null, remaining: null, asOf: null, reason: 'LINEの接続設定を確認してください' };
    }
    return notificationQuota(token);
  } catch {
    return { state: 'unavailable', total: null, used: null, remaining: null, asOf: null, reason: 'LINEの接続設定を確認してください' };
  }
}

lineNotifications.get(
  '/api/line-notifications/metrics',
  requireRole('owner', 'admin', 'staff'),
  async (c) => {
    const lineAccountId = c.req.query('lineAccountId')?.trim();
    if (!lineAccountId) {
      return c.json({ success: false, error: 'LINEアカウントを選択してください' }, 400);
    }
    const denied = await requireAccount(c, lineAccountId);
    if (denied) return denied;
    const from = c.req.query('from')?.trim();
    const to = c.req.query('to')?.trim();
    if ((from && !isExistingCalendarDate(from)) || (to && !isExistingCalendarDate(to)) || (from && to && from > to)) {
      return c.json({ success: false, error: '集計期間が正しくありません' }, 400);
    }
    const items = await listNotificationMetrics(c.env.DB, { lineAccountId, from, to });
    return c.json({
      success: true,
      data: {
        items: items.map((item) => ({
          definitionId: item.definition_id,
          notificationName: item.definition_name,
          accepted: { value: Number(item.accepted_count) },
          displayed: {
            // DBの4状態を画面の3状態へ寄せる。waiting のまま返すと画面が
            // 「— 未取得」を出し、集計待ちが壊れたように見える。
            state: item.state === 'ready'
              ? 'available'
              : item.state === 'waiting'
                ? 'pending'
                : 'unavailable',
            value: item.display_count == null ? null : Number(item.display_count),
            reason: item.reason,
          },
          clicked: { value: Number(item.click_count) },
        })),
        coverage: {
          individualOpenAvailable: false,
          lineAggregateOnly: true,
          unavailableIsNull: true,
        },
      },
    });
  },
);

/*
 * 顧客へのお知らせの「今日」「この30日」は、実際の送信履歴（共通送信台帳の
 * 受け付け済み）から数える。ECの出来事の取り込み件数（`ec_events`）や、
 * LINE集計の全期間合計（`metrics` の無期間呼び出し）は混ぜない。
 *
 * 期間はJSTの暦日。`accepted_at` はJST文字列で入るので頭の日付で切る。
 * 試し送り（`execution_mode = 'test'`）はお客さまへの送信ではないので除く。
 */
lineNotifications.get(
  '/api/line-notifications/send-counts',
  requireRole('owner', 'admin', 'staff'),
  async (c) => {
    const lineAccountId = c.req.query('lineAccountId')?.trim();
    if (!lineAccountId) {
      return c.json({ success: false, error: 'LINEアカウントを選択してください' }, 400);
    }
    const denied = await requireAccount(c, lineAccountId);
    if (denied) return denied;
    const today = jstDateString(0);
    const tomorrow = nextDateString(today);
    const windowStart = jstDateString(-29);
    const [rows, failures] = await Promise.all([c.env.DB.prepare(
      `SELECT i.source_event_type AS event_type,
         SUM(CASE WHEN d.accepted_at >= ? AND d.accepted_at < ? THEN 1 ELSE 0 END) AS today_count,
         SUM(CASE WHEN d.accepted_at >= ? AND d.accepted_at < ? THEN 1 ELSE 0 END) AS last_30d_count
       FROM notification_deliveries d
       JOIN notification_instances i ON i.id = d.instance_id
      WHERE d.line_account_id = ?
        AND d.audience_type = 'customer'
        AND d.status = 'provider_accepted'
        AND d.execution_mode != 'test'
      GROUP BY i.source_event_type
      ORDER BY last_30d_count DESC, event_type ASC`,
    ).bind(today, tomorrow, windowStart, tomorrow, lineAccountId)
      .all<{ event_type: string; today_count: number; last_30d_count: number }>(),
      c.env.DB.prepare(`SELECT COUNT(*) AS total,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN status = 'retry_wait' THEN 1 ELSE 0 END) AS retry_waiting
        FROM notification_deliveries
        WHERE line_account_id = ? AND audience_type = 'customer'
          AND execution_mode != 'test' AND status IN ('failed', 'retry_wait')`)
        .bind(lineAccountId).first<{ total: number; failed: number; retry_waiting: number }>(),
    ]);
    const byEventType = rows.results.map((row) => ({
      eventType: row.event_type,
      today: Number(row.today_count ?? 0),
      last30d: Number(row.last_30d_count ?? 0),
    }));
    return c.json({
      success: true,
      data: {
        failures: { scope: 'all_time_unresolved' as const, total: Number(failures?.total ?? 0),
          failed: Number(failures?.failed ?? 0), retryWaiting: Number(failures?.retry_waiting ?? 0) },
        sentToday: byEventType.reduce((sum, item) => sum + item.today, 0),
        sentLast30d: byEventType.reduce((sum, item) => sum + item.last30d, 0),
        byEventType,
        period: { today, from30d: windowStart, to: today },
      },
    });
  },
);

function isTransientLineError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b429\b|\b5\d\d\b|timeout|timed out|network|fetch|connection|socket/i.test(message);
}

function lineErrorStatus(error: unknown): number | null {
  if (typeof error !== 'object' || error === null || !('status' in error)) return null;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' && Number.isInteger(status) ? status : null;
}

lineNotifications.post(
  '/api/line-notifications/deliveries/:id/retry',
  requireDeliveryAccess('lineNotifications'),
  inputJsonBoundary(), async (c) => {
    const body = await c.req.json<Record<string, unknown>>().catch(() => null);
    const lineAccountId = bodyString(body?.lineAccountId);
    const expectedVersion = bodyVersion(body?.expectedVersion);
    if (!lineAccountId || !expectedVersion) {
      return inputError(c, { success: false, error: 'LINEアカウントと現在の版は必須です' }, 400, ["lineAccountId","expectedVersion"]);
    }
    const denied = await requireAccount(c, lineAccountId);
    if (denied) return denied;
    const action = bodyString(body?.action);
    if (action === 'resolve' || action === 'reopen') {
      const resolved = action === 'resolve';
      const result = await setNotificationDeliveryResolution(c.env.DB, {
        id: c.req.param('id'), lineAccountId, expectedVersion, resolved, staffId: c.get('staff').id,
      });
      if (result === 'not_found') return c.json({ success: false, error: '送信記録が見つかりません' }, 404);
      if (result === 'unavailable') {
        return c.json({ success: false, code: 'resolution_unavailable', error: '失敗または送信対象外の記録だけ対応状況を変更できます' }, 409);
      }
      if (result === 'version_conflict') {
        return c.json({ success: false, code: 'version_conflict', error: 'ほかの担当者が先に変更しました' }, 409);
      }
      return c.json({ success: true, data: { id: c.req.param('id'), resolved, version: expectedVersion + 1 } });
    }
    if (action !== null) {
      return inputError(c, { success: false, error: '操作の種類が正しくありません' }, 400, ["action"]);
    }
    if (c.get('staff').role !== 'owner') {
      return c.json({ success: false, error: '送信の再試行は店長だけができます' }, 403);
    }
    const delivery = await getNotificationDeliveryForRetry(c.env.DB, c.req.param('id'), lineAccountId);
    if (!delivery) return c.json({ success: false, error: '送信記録が見つかりません' }, 404);
    if (delivery.channel !== 'line' || delivery.recipient_type !== 'friend'
      || !delivery.line_user_id || Number(delivery.friend_is_following) !== 1
      || !delivery.line_template_json) {
      return c.json({ success: false, code: 'retry_unavailable', error: 'この記録はLINEで再試行できません' }, 409);
    }
    if (delivery.resolution_action === 'resolved') {
      return c.json({ success: false, code: 'retry_unavailable', error: '対応済みを未対応に戻してから再試行してください' }, 409);
    }
    if (!Number(delivery.retryable)
      || (delivery.status !== 'retry_wait' && delivery.status !== 'failed')) {
      return c.json({ success: false, code: 'retry_unavailable', error: '一時的な失敗だけ再試行できます' }, 409);
    }
    let messages: Message[];
    try {
      const parsed = JSON.parse(delivery.line_template_json) as unknown;
      if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('invalid template');
      messages = parsed as Message[];
    } catch {
      return c.json({ success: false, code: 'invalid_template', error: '送信内容を確認してください' }, 409);
    }

    let account;
    try {
      account = await getLineAccountById(c.env.DB, lineAccountId, c.env.LINE_CREDENTIAL_ENCRYPTION_KEY);
    } catch {
      account = null;
    }
    const token = account?.channel_access_token?.trim();
    if (!account || !account.is_active || account.archived_at || !token) {
      return c.json({ success: false, code: 'retry_unavailable', error: 'LINEの接続設定を確認してください' }, 409);
    }
    const quota = await notificationQuota(token);
    if (quota.state === 'unavailable') {
      return c.json({ success: false, code: 'quota_unavailable', error: '送信枠を確認できないため、再試行を止めました' }, 503);
    }
    if (quota.state === 'available' && quota.remaining < 1) {
      return c.json({ success: false, code: 'quota_insufficient', error: '今月の送信枠が残っていないため、再試行できません' }, 409);
    }
    const reservationId = `notification:${delivery.id}:${expectedVersion}`;
    const reserved = quota.state === 'available'
      ? await tryReserveQuotaSlot(c.env.DB, lineAccountId, reservationId, 1, quota.used, quota.total)
      : false;
    if (quota.state === 'available' && !reserved) {
      return c.json({ success: false, code: 'quota_insufficient', error: '同時送信を含めると送信枠が足りないため、再試行できません' }, 409);
    }
    try {
      if (Number(delivery.version) !== expectedVersion
        || !await claimNotificationDeliveryRetry(c.env.DB, {
          id: delivery.id, lineAccountId, expectedVersion,
        })) {
        return c.json({ success: false, code: 'version_conflict', error: 'ほかの担当者が先に再試行しました' }, 409);
      }

      let result: { data: unknown; requestId: string | null };
      try {
        result = await new LineClient(token)
        .pushMessageWithRequestId(delivery.line_user_id, messages, delivery.idempotency_key);
      } catch (error) {
        const responseUnknown = lineErrorStatus(error) === null;
        const transient = responseUnknown || isTransientLineError(error);
        const nextRetryAt = transient ? new Date(Date.now() + 5 * 60 * 1000).toISOString() : null;
        const finished = await finishNotificationDeliveryRetry(c.env.DB, {
          delivery,
          outcome: transient ? 'retry_wait' : 'failed',
          errorCode: responseUnknown
            ? 'provider_response_unknown'
            : transient ? 'provider_temporary_error' : 'provider_permanent_error',
          errorMessageSafe: responseUnknown
            ? 'LINEの応答を確認できません。同じ通知として再試行を待っています'
            : transient
              ? 'LINEへの再試行を待っています'
              : 'LINEが送信を受け付けませんでした。設定と送信内容を確認してください',
          nextRetryAt,
        });
        if (!finished) throw new Error('notification retry result was not recorded');
        return inputError(c, {
          success: false,
          code: transient ? 'retry_scheduled' : 'retry_failed',
          error: transient ? '一時的な失敗のため、再試行待ちに戻しました' : '再試行できませんでした',
        }, transient ? 503 : 422, []);
      }
      const finished = await finishNotificationDeliveryRetry(c.env.DB, {
        delivery,
        outcome: 'provider_accepted',
        providerRequestId: result.requestId,
      });
      if (!finished) throw new Error('notification retry result was not recorded');
      auditLog(c, 'line_notification.delivery.retry', { kind: 'notification_delivery', id: delivery.id });
      return c.json({
        success: true,
        data: {
          id: delivery.id,
          status: 'accepted',
          attemptCount: Number(delivery.attempts) + 1,
          version: expectedVersion + 1,
        },
      });
    } finally {
      if (reserved) await releaseQuotaSlot(c.env.DB, lineAccountId, reservationId);
    }
  },
);

function bodyReason(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length >= 1 && trimmed.length <= 200 ? trimmed : null;
}

function bodyFriendIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 5) return null;
  const ids = value.map((item) => (typeof item === 'string' ? item.trim() : ''));
  if (ids.some((id) => !id || id.length > 100)) return null;
  return [...new Set(ids)];
}

/**
 * 要件 -24 §6 `GET deliveries/:id`。一覧と同じ1件の形で返す。
 * アカウント境界の外側は 404 に倒して存在を明かさない。
 */
lineNotifications.get(
  '/api/line-notifications/deliveries/:id',
  requireRole('owner', 'admin', 'staff'),
  async (c) => {
    const lineAccountId = c.req.query('lineAccountId')?.trim();
    if (!lineAccountId) {
      return c.json({ success: false, error: 'LINEアカウントを選択してください' }, 400);
    }
    const denied = await requireAccount(c, lineAccountId);
    if (denied) return denied;
    const row = await getNotificationDelivery(c.env.DB, c.req.param('id'), lineAccountId);
    if (!row) return c.json({ success: false, error: '送信記録が見つかりません' }, 404);
    const attempts = await listNotificationDeliveryAttempts(c.env.DB, lineAccountId, [row.id]);
    return c.json({ success: true, data: serializeDeliveryItem(row, attempts) });
  },
);

/**
 * 要件 -24 §6 `GET quota`。一覧の `includeQuota=1` と同じ送信枠を単体で返す。
 */
lineNotifications.get(
  '/api/line-notifications/quota',
  requireRole('owner', 'admin', 'staff'),
  async (c) => {
    const lineAccountId = c.req.query('lineAccountId')?.trim();
    if (!lineAccountId) {
      return c.json({ success: false, error: 'LINEアカウントを選択してください' }, 400);
    }
    const denied = await requireAccount(c, lineAccountId);
    if (denied) return denied;
    const quota = await notificationQuotaForAccount(c, lineAccountId);
    return c.json({ success: true, data: quota });
  },
);

/**
 * 要件 -24 §6 `POST deliveries/:id/resend`。
 * retry（未完了の試行を続ける）と分け、新規通知として送り直す。
 * 元の行は残し、新しい送達行・新しい冪等キーで送る。理由は必須で監査に残す。
 * 除外（送信対象外）の記録は送り直さない。対象外の判定を覆す操作だからだ。
 */
lineNotifications.post(
  '/api/line-notifications/deliveries/:id/resend',
  requireDeliveryAccess('lineNotifications'),
  inputJsonBoundary(), async (c) => {
    const body = await c.req.json<Record<string, unknown>>().catch(() => null);
    const lineAccountId = bodyString(body?.lineAccountId);
    const expectedVersion = bodyVersion(body?.expectedVersion);
    const reason = bodyReason(body?.reason);
    if (!lineAccountId || !expectedVersion) {
      return inputError(c, { success: false, error: 'LINEアカウントと現在の版は必須です' }, 400, ["lineAccountId","expectedVersion"]);
    }
    if (!reason) {
      return inputError(c, { success: false, error: '再送する理由を1〜200文字で入力してください' }, 400, ["reason"]);
    }
    const denied = await requireAccount(c, lineAccountId);
    if (denied) return denied;
    if (c.get('staff').role !== 'owner') {
      return c.json({ success: false, error: '送信の再送は店長だけができます' }, 403);
    }
    const delivery = await getNotificationDeliveryForRetry(c.env.DB, c.req.param('id'), lineAccountId);
    if (!delivery) return c.json({ success: false, error: '送信記録が見つかりません' }, 404);
    if (delivery.channel !== 'line' || delivery.recipient_type !== 'friend'
      || !delivery.line_user_id || Number(delivery.friend_is_following) !== 1
      || !delivery.line_template_json) {
      return c.json({ success: false, code: 'resend_unavailable', error: 'この記録はLINEで送り直せません' }, 409);
    }
    if (delivery.resolution_action === 'resolved') {
      return c.json({ success: false, code: 'resend_unavailable', error: '対応済みを未対応に戻してから送り直してください' }, 409);
    }
    if (delivery.status === 'excluded') {
      return c.json({ success: false, code: 'resend_unavailable', error: '送信対象外の記録は送り直せません' }, 409);
    }
    if (!Number(delivery.retryable)
      || (delivery.status !== 'retry_wait' && delivery.status !== 'failed')) {
      return c.json({ success: false, code: 'resend_unavailable', error: '送れなかった通知だけ送り直せます' }, 409);
    }
    let messages: Message[];
    try {
      const parsed = JSON.parse(delivery.line_template_json) as unknown;
      if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('invalid template');
      messages = parsed as Message[];
    } catch {
      return c.json({ success: false, code: 'invalid_template', error: '送信内容を確認してください' }, 409);
    }
    let account;
    try {
      account = await getLineAccountById(c.env.DB, lineAccountId, c.env.LINE_CREDENTIAL_ENCRYPTION_KEY);
    } catch {
      account = null;
    }
    const token = account?.channel_access_token?.trim();
    if (!account || !account.is_active || account.archived_at || !token) {
      return c.json({ success: false, code: 'resend_unavailable', error: 'LINEの接続設定を確認してください' }, 409);
    }
    const quota = await notificationQuota(token);
    if (quota.state === 'unavailable') {
      return c.json({ success: false, code: 'quota_unavailable', error: '送信枠を確認できないため、再送を止めました' }, 503);
    }
    if (quota.state === 'available' && quota.remaining < 1) {
      return c.json({ success: false, code: 'quota_insufficient', error: '今月の送信枠が残っていないため、再送できません' }, 409);
    }
    if (Number(delivery.version) !== expectedVersion) {
      return c.json({ success: false, code: 'version_conflict', error: 'ほかの担当者が先に変更しました' }, 409);
    }
    const created = await insertNotificationResendDelivery(c.env.DB, {
      lineAccountId,
      sourceDelivery: delivery,
      staffId: c.get('staff').id,
      reason,
    });
    const reservationId = `notification-resend:${created.id}`;
    const reserved = quota.state === 'available'
      ? await tryReserveQuotaSlot(c.env.DB, lineAccountId, reservationId, 1, quota.used, quota.total)
      : false;
    if (quota.state === 'available' && !reserved) {
      // 枠の予約より先に作った再送行を、未送信のまま(pending)に残さない。
      // 送らなかった理由つきの失敗で確定し、履歴に残す。
      const finalized = await finishNotificationResendDelivery(c.env.DB, {
        id: created.id,
        lineAccountId,
        idempotencyKey: created.idempotencyKey,
        outcome: 'failed',
        errorCode: 'quota_insufficient',
        errorMessageSafe: '同時送信を含めると送信枠が足りないため、再送できません',
      });
      if (!finalized) throw new Error('notification resend result was not recorded');
      return c.json({
        success: false,
        code: 'quota_insufficient',
        error: '同時送信を含めると送信枠が足りないため、再送できません',
        data: { id: created.id },
      }, 409);
    }
    try {
      let result: { data: unknown; requestId: string | null };
      try {
        result = await new LineClient(token)
          .pushMessageWithRequestId(delivery.line_user_id, messages, created.idempotencyKey);
      } catch (error) {
        const responseUnknown = lineErrorStatus(error) === null;
        const transient = responseUnknown || isTransientLineError(error);
        const nextRetryAt = transient ? new Date(Date.now() + 5 * 60 * 1000).toISOString() : null;
        const finished = await finishNotificationResendDelivery(c.env.DB, {
          id: created.id,
          lineAccountId,
          idempotencyKey: created.idempotencyKey,
          outcome: transient ? 'retry_wait' : 'failed',
          errorCode: responseUnknown
            ? 'provider_response_unknown'
            : transient ? 'provider_temporary_error' : 'provider_permanent_error',
          errorMessageSafe: responseUnknown
            ? 'LINEの応答を確認できません。同じ通知として再試行を待っています'
            : transient
              ? 'LINEへの再試行を待っています'
              : 'LINEが送信を受け付けませんでした。設定と送信内容を確認してください',
          nextRetryAt,
        });
        if (!finished) throw new Error('notification resend result was not recorded');
        return inputError(c, {
          success: false,
          code: transient ? 'resend_scheduled' : 'resend_failed',
          error: transient ? '一時的な失敗のため、新しい送信を再試行待ちにしました' : '再送できませんでした',
          data: { id: created.id },
        }, transient ? 503 : 422, []);
      }
      const finished = await finishNotificationResendDelivery(c.env.DB, {
        id: created.id,
        lineAccountId,
        idempotencyKey: created.idempotencyKey,
        outcome: 'provider_accepted',
        providerRequestId: result.requestId,
      });
      if (!finished) throw new Error('notification resend result was not recorded');
      auditLog(c, 'line_notification.delivery.resend', { kind: 'notification_delivery', id: created.id });
      return c.json({
        success: true,
        data: { id: created.id, status: 'accepted', attemptCount: 1, version: 1 },
      });
    } finally {
      if (reserved) await releaseQuotaSlot(c.env.DB, lineAccountId, reservationId);
    }
  },
);

const CUSTOMER_TEST_SEND_NOTICE =
  '【テスト送信】公開前の確認用です。実際の注文情報は含みません。';

/**
 * 要件 -24 §6 `POST customer-definitions/:id/test`。
 * いま編集中の下書き文面を、指定した友だちだけに試し送りする。
 * 実注文・住所・クーポンは使わず、先頭に確認用の断りを付けて送る。
 * 記録は `test` 扱いで、再試行の対象にしない。
 */
lineNotifications.post(
  '/api/line-notifications/customer-definitions/:id/test',
  requireDeliveryAccess('lineNotifications'),
  inputJsonBoundary(), async (c) => {
    const body = await c.req.json<Record<string, unknown>>().catch(() => null);
    const lineAccountId = bodyString(body?.lineAccountId);
    const friendIds = bodyFriendIds(body?.friendIds);
    if (!lineAccountId) {
      return inputError(c, { success: false, error: 'LINEアカウントを選択してください' }, 400, ["lineAccountId"]);
    }
    if (!friendIds) {
      return inputError(c, { success: false, error: '試し送りする友だちを1〜5人選んでください' }, 400, ["friendIds"]);
    }
    const denied = await requireAccount(c, lineAccountId);
    if (denied) return denied;
    const found = await getCustomerNotificationDefinition(c.env.DB, c.req.param('id'), lineAccountId);
    if (!found) return c.json({ success: false, error: 'お知らせが見つかりません' }, 404);
    const draft = jsonObject(found.definition.draft_config_json) as CustomerDraft;
    const template = draft.lineTemplate;
    if (!Array.isArray(template) || template.length === 0) {
      return c.json({ success: false, code: 'incomplete_draft', error: '試し送りする前にLINEで送る内容を設定してください' }, 409);
    }
    const placeholders = sqlIdSet(friendIds).sql;
    const recipients = await c.env.DB.prepare(`
      SELECT id, line_platform_user_id AS line_user_id FROM friends
       WHERE line_account_id = ? AND id IN (${placeholders})
         AND is_following = 1 AND line_platform_user_id IS NOT NULL AND line_platform_user_id != ''
    `).bind(lineAccountId, ...(friendIds.length ? sqlIdSet(friendIds).binds : [])).all<{ id: string; line_user_id: string }>();
    const recipientById = new Map(recipients.results.map((row) => [row.id, row.line_user_id]));
    const missing = friendIds.filter((id) => !recipientById.has(id));
    if (missing.length > 0) {
      return c.json({ success: false, error: '受け取れない友だちが含まれています。フォロー中の友だちを選び直してください' }, 404);
    }
    let account;
    try {
      account = await getLineAccountById(c.env.DB, lineAccountId, c.env.LINE_CREDENTIAL_ENCRYPTION_KEY);
    } catch {
      account = null;
    }
    const token = account?.channel_access_token?.trim();
    if (!account || !account.is_active || account.archived_at || !token) {
      return c.json({ success: false, code: 'test_unavailable', error: 'LINEの接続設定を確認してください' }, 409);
    }
    const quota = await notificationQuota(token);
    if (quota.state === 'unavailable') {
      return c.json({ success: false, code: 'quota_unavailable', error: '送信枠を確認できないため、試し送りを止めました' }, 503);
    }
    if (quota.state === 'available' && quota.remaining < friendIds.length) {
      return c.json({ success: false, code: 'quota_insufficient', error: '今月の送信枠が残っていないため、試し送りできません' }, 409);
    }
    const messages: Message[] = [
      { type: 'text', text: CUSTOMER_TEST_SEND_NOTICE } as Message,
      ...(template as Message[]),
    ];
    const client = new LineClient(token);
    const { instanceId, sourceEventId } = await createCustomerTestInstance(c.env.DB, {
      lineAccountId,
      definitionId: found.definition.id,
      definitionVersionId: found.definition.current_version_id,
      sourceEventType: found.definition.source_event_type,
      metadata: { recipientCount: friendIds.length },
    });
    const reservedIds: string[] = [];
    try {
      if (quota.state === 'available') {
        for (const friendId of friendIds) {
          const reservationId = `notification-test:${sourceEventId}:${friendId}`;
          const reserved = await tryReserveQuotaSlot(
            c.env.DB, lineAccountId, reservationId, 1, quota.used, quota.total,
          );
          if (!reserved) {
            // 枠の予約より先に作った記録先を、送達のない成功前提のままに
            // 残さない。失敗で確定し、送れなかった理由を監査に残す。
            const finalized = await failCustomerTestInstance(c.env.DB, {
              lineAccountId, instanceId,
            });
            if (!finalized) throw new Error('customer test instance was not recorded');
            await recordCustomerTestAudit(c.env.DB, {
              definitionId: found.definition.id,
              lineAccountId,
              staffId: c.get('staff').id,
              sourceEventId,
              recipientIds: friendIds,
              outcome: 'quota_insufficient',
              errorMessage: '同時送信を含めると送信枠が足りないため、試し送りできません',
            });
            return c.json({
              success: false,
              code: 'quota_insufficient',
              error: '同時送信を含めると送信枠が足りないため、試し送りできません',
              data: { instanceId },
            }, 409);
          }
          reservedIds.push(reservationId);
        }
      }
      const results: Array<{ friendId: string; deliveryId: string; sent: boolean; error?: string }> = [];
      for (const friendId of friendIds) {
        const lineUserId = recipientById.get(friendId) as string;
        const idempotencyKey = `test:${sourceEventId}:${friendId}`;
        try {
          const sent = await client.pushMessageWithRequestId(lineUserId, messages, idempotencyKey);
          const recorded = await recordCustomerTestDelivery(c.env.DB, {
            lineAccountId,
            instanceId,
            recipientId: friendId,
            idempotencyKey,
            outcome: 'provider_accepted',
            providerRequestId: sent.requestId,
          });
          results.push({ friendId, deliveryId: recorded.id, sent: true });
        } catch (error) {
          const message = error instanceof Error ? error.message.slice(0, 200) : '送信できませんでした';
          const recorded = await recordCustomerTestDelivery(c.env.DB, {
            lineAccountId,
            instanceId,
            recipientId: friendId,
            idempotencyKey,
            outcome: 'failed',
            errorCode: 'provider_error',
            errorMessageSafe: '試し送りできませんでした。設定と送信内容を確認してください',
          });
          results.push({ friendId, deliveryId: recorded.id, sent: false, error: message });
        }
      }
      await recordCustomerTestAudit(c.env.DB, {
        definitionId: found.definition.id,
        lineAccountId,
        staffId: c.get('staff').id,
        sourceEventId,
        recipientIds: friendIds,
      });
      auditLog(c, 'line_notification.definition.test', { kind: 'customer_notification', id: found.definition.id });
      return c.json({ success: true, data: { definitionId: found.definition.id, sourceEventId, results } });
    } finally {
      for (const reservationId of reservedIds) {
        await releaseQuotaSlot(c.env.DB, lineAccountId, reservationId);
      }
    }
  },
);

export { lineNotifications };
