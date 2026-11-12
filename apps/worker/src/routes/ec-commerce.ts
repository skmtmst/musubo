import { parseOffsetPaging, buildOffsetListResponse } from '../lib/list-paging.js';
import { jstDate } from '@line-crm/shared';
import { logger } from '@line-crm/shared/server';
import { sqlIdSet } from '@line-crm/db/id-queries';
import { inputError, inputJsonBoundary } from '../lib/input-errors.js';
import { Hono } from 'hono';
import { classifyEcErrorCode, encryptCredential, getLineAccountById, jstDateString, jstNow, nextDateString } from '@line-crm/db';
import { EC_EVENT_TYPES, ecEventLabel, addDays, resolveShipDate, toJstMoment } from '@line-crm/shared';
import { LineClient } from '@line-crm/line-sdk';
import type { Env } from '../worker-env.js';
import { requireRole } from '../middleware/role-guard.js';
import { requireEcPermission } from './ec-operations.js';
import { logOutgoingMessage } from '../services/event-bus.js';
import type { EcEvent } from '../features/ec-commerce/member-snapshot/index.js';
import { ecFlexMessage } from '../features/ec-commerce/ec-notification-message/index.js';
import { canAccessAllLineAccounts, getVisibleLineAccountScope } from '../services/account-access.js';
import { auditLog } from '../lib/audit-log.js';
import { notificationDeliveriesResponse } from './line-notifications.js';
import { fail } from '../lib/fail.js';
const ecCommerce = new Hono<Env>();
// テスト送信の連打防止。同一の店・種別は30秒に1回だけ。全体の rateLimit とは
// 別に、LINE API へ直接届く口だけ短いクールダウンを置く。
// in-memory のため isolate ごとに数え直し、厳密な回数制限ではない（連打の抑止用）。
const TEST_SEND_COOLDOWN_MS = 30_000;
const testSendAt = new Map<string, number>();
const EVENT_TYPE_SET = new Set<string>(EC_EVENT_TYPES);
const STATUS_SET = new Set(['received', 'identity_pending', 'processing', 'processed', 'skipped', 'failed']);
const ACTION_STATUS_SET = new Set([
  'pending', 'processing', 'succeeded', 'skipped', 'retryable_failed', 'permanent_failed',
]);
const CONNECTOR_PROVIDERS = new Set(['ec_cube', 'shopify']);
const CONNECTOR_STATUSES = new Set(['connected', 'degraded', 'paused', 'auth_expired', 'rate_limited']);
const IDENTITY_RULES = new Set(['verified_email', 'verified_phone', 'manual_name_postal']);

const FIXED_FIELDS: Record<string, string[]> = {
  'ec.order.confirmed': ['注文番号', '商品名・数量', '合計金額', 'お届け予定', '注文詳細URL'],
  'ec.order.payment_received': ['注文番号', '入金額', '注文詳細URL'],
  'ec.order.bank_transfer_reminder': ['注文番号', 'お振込期限', '振込先口座', '注文詳細URL'],
  'ec.order.shipped': ['注文番号', '商品名・数量', '配送会社', '送り状番号', '配送確認URL'],
  'ec.order.cancelled': ['注文番号', 'キャンセル受付の案内', '注文詳細URL'],
  'ec.order.refunded': ['注文番号', '返金額', '返金完了の案内'],
  'ec.subscription.upcoming': ['次回確定日', '変更期限', '商品名・数量', '予定金額', '定期便管理URL'],
  'ec.subscription.payment_failed': ['決済失敗の案内', '支払い方法確認の案内', '定期便管理URL'],
  'ec.subscription.card_updated': ['定期便番号', 'カード変更・再決済結果', 'お支払い金額', '定期便管理URL'],
  'ec.subscription.cancelled': ['解約受付の案内', '定期便番号'],
};

function stringList(value: unknown, allowed: ReadonlySet<string>): string[] | null {
  if (!Array.isArray(value)) return null;
  const result = value.filter((item): item is string => typeof item === 'string');
  if (result.length !== value.length || new Set(result).size !== result.length) return null;
  return result.every((item) => allowed.has(item)) ? result : null;
}

function storedStringList(value: unknown, allowed: ReadonlySet<string>): string[] {
  try { return stringList(JSON.parse(String(value || '[]')), allowed) ?? []; } catch { return []; }
}

export type SubscriptionState = 'active' | 'paused' | 'at_risk' | 'cancelled';

/**
 * 定期便の状態をどう読むかの表。**上から順に見て、先に当たったものが勝つ。**
 *
 * 同じ判定を JS(`subscriptionState`)と SQL(`subscriptionStateSql`)の両方で
 * 使うので、**表はここ1か所だけに置く。**値が増えたときに片方だけ増える事故を
 * 防ぐため。ただし表を共有しても**順序までは揃わない**(「解約」と「休止」の
 * 両方を含む文字列はどちらが勝つか)ので、両者へ同じ入力を食わせて一致を見張る
 * 試験を別に置いている(`ec-commerce-subscription-state.test.ts`)。
 *
 * 判定語はすべて小文字・記号なしにすること。SQL 側は `lower(...) LIKE '%語%'`
 * へ展開するので、`%` や `_` を含む語を足すと LIKE のワイルドカードとして
 * 解釈される。日本語は `lower` で変わらないのでそのまま比べられる。
 */
export const SUBSCRIPTION_STATE_RULES: ReadonlyArray<{
  readonly state: SubscriptionState;
  readonly needles: readonly string[];
}> = [
  { state: 'cancelled', needles: ['cancel', '解約', '停止'] },
  { state: 'paused', needles: ['pause', '休止'] },
  { state: 'at_risk', needles: ['failed', '決済'] },
];

/** どの語にも当たらなかったときの状態。 */
export const SUBSCRIPTION_STATE_FALLBACK: SubscriptionState = 'active';

export function subscriptionState(value: unknown): SubscriptionState {
  const status = String(value || '').toLowerCase();
  for (const rule of SUBSCRIPTION_STATE_RULES) {
    if (rule.needles.some((needle) => status.includes(needle))) return rule.state;
  }
  return SUBSCRIPTION_STATE_FALLBACK;
}

/**
 * 上の表から SQL の `CASE` を組み立てる。`expr` は状態の文字列を返す SQL 式。
 *
 * `LIKE` は SQLite では ASCII の大小を区別しないが、JS 側が `toLowerCase`
 * してから比べているので、ここでも `lower` を掛けて条件を揃える。
 */
export function subscriptionStateSql(expr: string): string {
  const whens = SUBSCRIPTION_STATE_RULES.map((rule) => {
    const conditions = rule.needles
      .map((needle) => `lower(${expr}) LIKE '%${needle}%'`)
      .join(' OR ');
    return `WHEN ${conditions} THEN '${rule.state}'`;
  }).join('\n           ');
  return `CASE ${whens}\n           ELSE '${SUBSCRIPTION_STATE_FALLBACK}' END`;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function subscriptionItems(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const labels = value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const record = item as Record<string, unknown>;
    const name = typeof record.name === 'string' ? record.name.trim().slice(0, 80) : '';
    if (!name) return [];
    const quantity = finiteNumber(record.quantity);
    return [quantity === null ? name : `${name} × ${quantity}`];
  });
  return labels.length ? labels.join('、') : null;
}

function monthKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = value.match(/^(\d{4})-(\d{1,2})/);
  return match ? `${match[1]}-${match[2].padStart(2, '0')}` : null;
}

function isValidHttpsUrl(value: string): boolean {
  if (!value) return true;
  try { return new URL(value).protocol === 'https:'; } catch { return false; }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function testEvent(eventType: string): EcEvent {
  const base: EcEvent = {
    event_id: `test-${crypto.randomUUID()}`,
    event_type: eventType,
    occurred_at: new Date().toISOString(),
    line_user_id: 'U00000000000000000000000000000000',
    order: {
      number: 'NEN-TEST-001',
      total: 2860,
      items: [{ name: '鹿肉ミンチ', quantity: 2 }],
      delivery_date: '2026年8月15日',
      delivery_time: '18:00〜20:00',
      detail_url: 'https://stg.nen-petfood.com/mypage',
      payment_method: '銀行振込',
      payment_deadline: '2026年8月25日',
    },
    shipping: {
      carrier: 'ヤマト運輸',
      tracking_number: '1234-5678-9012',
      tracking_url: 'https://stg.nen-petfood.com/mypage',
    },
    subscription: {
      id: 'NEN-SUB-TEST',
      next_order_date: '2026年9月1日',
      change_deadline: '2026年8月28日',
      manage_url: 'https://stg.nen-petfood.com/mypage',
      contract_number: 'NEN-SUB-TEST',
      amount: 2860,
      retry_status: '再決済に成功しました',
    },
    refund: { amount: 2860, full_refund: true },
  };
  return base;
}

ecCommerce.get(
  '/api/ec-commerce/overview',
  requireRole('owner', 'admin', 'staff'),
  requireEcPermission('ec.event.view'),
  async (c) => {
  const lineAccountId = c.req.query('lineAccountId')?.trim();
  if (lineAccountId && !await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [lineAccountId])) {
    return c.json({ success: false, error: 'このLINEアカウントを表示する権限がありません' }, 403);
  }
  const scope = lineAccountId ? null : await getVisibleLineAccountScope(c.env.DB, c.get('staff'));
  const accountWhere = lineAccountId
    ? 'line_account_id = ?'
    : scope?.allowedAccountIds.length
      ? `(line_account_id IN (${sqlIdSet(scope.allowedAccountIds).sql})${scope.canSeeUnassigned ? ' OR line_account_id IS NULL' : ''})`
      : scope?.canSeeUnassigned ? 'line_account_id IS NULL' : '1 = 0';
  const accountBindings = lineAccountId ? [lineAccountId] : (scope?.allowedAccountIds.length ? sqlIdSet(scope.allowedAccountIds).binds : []);
  /*
   * 「今日」はJSTの0時から。`received_at` はJST文字列（`jstNow`）で入るので、
   * 頭の日付で半開区間を切る。SQLiteの `datetime('now', '-1 day')` はUTCの
   * 直前24時間で、前日夜の分が「今日」に混ざっていた。遅延の平均だけは
   * 画面が「直近24時間」と書いているので、UTCの直前24時間のまま残す。
   */
  const todayStart = jstDateString(0);
  const tomorrowStart = nextDateString(todayStart);
  const summary = await c.env.DB.prepare(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN status = 'processed' THEN 1 ELSE 0 END) AS processed,
       SUM(CASE WHEN status = 'identity_pending' THEN 1 ELSE 0 END) AS identity_pending,
       SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
       SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped,
       SUM(CASE WHEN received_at >= ? AND received_at < ? THEN 1 ELSE 0 END) AS last_24h,
       MAX(received_at) AS last_received_at,
       AVG(CASE
         WHEN datetime(received_at) >= datetime('now', '-1 day')
          AND json_type(payload, '$.occurred_at') = 'text'
          AND julianday(received_at) >= julianday(json_extract(payload, '$.occurred_at'))
         THEN (julianday(received_at) - julianday(json_extract(payload, '$.occurred_at'))) * 86400
       END) AS average_delivery_seconds,
       SUM(CASE
         WHEN datetime(received_at) >= datetime('now', '-1 day')
          AND json_type(payload, '$.occurred_at') = 'text'
          AND julianday(received_at) >= julianday(json_extract(payload, '$.occurred_at'))
         THEN 1 ELSE 0
       END) AS latency_sample_count
     FROM ec_events WHERE ${accountWhere}`,
  ).bind(todayStart, tomorrowStart, ...accountBindings).first<{
    total: number; processed: number; identity_pending: number; failed: number; skipped: number;
    last_24h: number; last_received_at: string | null;
    average_delivery_seconds: number | null; latency_sample_count: number;
  }>();
  /* 種類別の内訳も「今日」の範囲にそろえる。EC画面の「今日 取り込んだ」の明細になる。 */
  const types = await c.env.DB.prepare(
    `SELECT event_type, COUNT(*) AS count FROM ec_events
      WHERE ${accountWhere} AND received_at >= ? AND received_at < ?
      GROUP BY event_type ORDER BY count DESC`,
  ).bind(...accountBindings, todayStart, tomorrowStart).all<{ event_type: string; count: number }>();
  /*
   * タブの契約数だけを得るために行一覧を読み込まない。
   * 一覧と同じ json_type の検証で、形式の異なるスナップショットが json_each 全体を失敗させるのを防ぐ。
   */
  const friendAccountWhere = lineAccountId
    ? 'f.line_account_id = ?'
    : scope?.allowedAccountIds.length
      ? `(f.line_account_id IN (${sqlIdSet(scope.allowedAccountIds).sql})${scope.canSeeUnassigned ? ' OR f.line_account_id IS NULL' : ''})`
      : scope?.canSeeUnassigned ? 'f.line_account_id IS NULL' : '1 = 0';
  const subscriptionCount = await c.env.DB.prepare(
    `SELECT COUNT(*) AS count
       FROM nen_ec_member_snapshots s
       JOIN friends f ON f.id = s.friend_id,
            json_each(json_extract(s.subscription_json, '$.contracts')) c
      WHERE ${friendAccountWhere}
        AND json_type(s.subscription_json, '$.contracts') = 'array'`,
  ).bind(...accountBindings).first<{ count: number }>();

  return c.json({
    success: true,
    data: {
      total: summary?.total ?? 0,
      processed: summary?.processed ?? 0,
      identityPending: summary?.identity_pending ?? 0,
      failed: summary?.failed ?? 0,
      skipped: summary?.skipped ?? 0,
      /** JSTの今日0時から取り込んだ件数。名は互換のため残す。 */
      last24h: summary?.last_24h ?? 0,
      lastReceivedAt: summary?.last_received_at ?? null,
      averageDeliverySeconds: summary?.average_delivery_seconds == null
        ? null
        : Math.max(0, Math.round(Number(summary.average_delivery_seconds))),
      latencySampleCount: Number(summary?.latency_sample_count ?? 0),
      byType: types.results.map((row) => ({
        eventType: row.event_type,
        label: ecEventLabel(row.event_type, row.event_type),
        count: row.count,
      })),
      /** 定期便の契約数。タブの数字用。 */
      subscriptions: Number(subscriptionCount?.count ?? 0),
    },
  });
});

ecCommerce.get(
  '/api/ec-commerce/events',
  requireRole('owner', 'admin', 'staff'),
  requireEcPermission('ec.event.view'),
  async (c) => {
  const lineAccountId = c.req.query('lineAccountId')?.trim();
  if (lineAccountId && !await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [lineAccountId])) {
    return c.json({ success: false, error: 'このLINEアカウントを表示する権限がありません' }, 403);
  }
  const scope = lineAccountId ? null : await getVisibleLineAccountScope(c.env.DB, c.get('staff'));
  const accountClause = lineAccountId
    ? 'e.line_account_id = ?'
    : scope?.allowedAccountIds.length
      ? `(e.line_account_id IN (${sqlIdSet(scope.allowedAccountIds).sql})${scope.canSeeUnassigned ? ' OR e.line_account_id IS NULL' : ''})`
      : scope?.canSeeUnassigned ? 'e.line_account_id IS NULL' : '1 = 0';
  const { limit, offset } = parseOffsetPaging({ limit: c.req.query('limit') || undefined, offset: c.req.query('offset') || undefined }, { defaultLimit: 30, limitPolicy: { fallback: 'integer', minimum: 1, maximum: 100 }, offsetPolicy: { fallback: 'integer', minimum: 0 } });
  const eventType = c.req.query('eventType') || '';
  const status = c.req.query('status') || '';
  const view = c.req.query('view') || '';

  if (view === 'actions') {
    const statusGroup = c.req.query('statusGroup') || '';
    const search = c.req.query('query')?.trim().slice(0, 100) || '';
    const sort = c.req.query('sort') === 'oldest' ? 'oldest' : 'newest';
    if (status && !ACTION_STATUS_SET.has(status)) {
      return c.json({ success: false, error: '処理の状態が正しくありません' }, 400);
    }
    const groupedStatuses: Record<string, string[]> = {
      processing: ['pending', 'processing'],
      failed: ['retryable_failed', 'permanent_failed'],
    };
    if (statusGroup && !(statusGroup in groupedStatuses)) {
      return c.json({ success: false, error: '処理の状態が正しくありません' }, 400);
    }

    const actionClauses: string[] = [accountClause];
    const actionBindings: Array<string | number> = lineAccountId ? [lineAccountId] : (scope?.allowedAccountIds.length ? sqlIdSet(scope.allowedAccountIds).binds : []);
    if (status) {
      actionClauses.push('a.status = ?');
      actionBindings.push(status);
    }
    if (statusGroup) {
      const statuses = groupedStatuses[statusGroup];
      actionClauses.push(`a.status IN (${statuses.map(() => '?').join(',')})`);
      actionBindings.push(...statuses);
    }
    if (search) {
      const like = `%${escapeLike(search)}%`;
      const matchingEventTypes = EC_EVENT_TYPES.filter((type) => (
        ecEventLabel(type, type).toLocaleLowerCase('ja-JP').includes(search.toLocaleLowerCase('ja-JP'))
      ));
      actionClauses.push(`(
        e.event_type LIKE ? ESCAPE '\\'
        OR COALESCE(json_extract(e.payload, '$.order.number'), '') LIKE ? ESCAPE '\\'
        OR COALESCE(f.display_name, '') LIKE ? ESCAPE '\\'
        OR EXISTS (
          SELECT 1 FROM ec_order_lines search_line
           WHERE search_line.order_id = o.id
             AND search_line.product_name LIKE ? ESCAPE '\\'
        )
        ${matchingEventTypes.length ? `OR e.event_type IN (${matchingEventTypes.map(() => '?').join(',')})` : ''}
      )`);
      actionBindings.push(like, like, like, like, ...matchingEventTypes);
    }
    const actionWhere = `WHERE ${actionClauses.join(' AND ')}`;
    const joins = `
      FROM ec_action_executions a
      JOIN ec_events e ON e.id = a.event_id
      LEFT JOIN friends f ON f.id = e.friend_id
      LEFT JOIN ec_orders o
        ON o.line_account_id = e.line_account_id
       AND o.source_key = e.source
       AND o.external_order_id = json_extract(e.payload, '$.order.number')`;
    const actionRowsQuery = c.env.DB.prepare(
      `SELECT a.id, a.event_id, a.action_type, a.rule_version, a.status,
              a.attempt_count, a.max_attempts, a.error_code, a.error_message_safe,
              a.last_attempted_at, a.next_retry_at, a.version,
              e.event_type, e.received_at, e.friend_id, f.display_name AS customer_name,
              json_extract(e.payload, '$.order.number') AS order_number,
              o.id AS order_id, o.line_account_id AS order_line_account_id,
              o.external_order_id, o.customer_id AS order_customer_id,
              o.friend_id AS order_friend_id, o.normalized_status AS order_status,
              o.provider_status, o.currency, o.total_amount_minor, o.refunded_amount_minor,
              o.ordered_at, o.detail_url, o.version AS order_version
         ${joins}
         ${actionWhere}
        ORDER BY e.received_at ${sort === 'oldest' ? 'ASC' : 'DESC'}, a.created_at ${sort === 'oldest' ? 'ASC' : 'DESC'}
        LIMIT ? OFFSET ?`,
    ).bind(...actionBindings, limit, offset);
    const [actionRows, actionCount, summaryRows] = await Promise.all([
      actionRowsQuery.all<Record<string, unknown>>(),
      c.env.DB.prepare(`SELECT COUNT(*) AS count ${joins} ${actionWhere}`)
        .bind(...actionBindings).first<{ count: number }>(),
      c.env.DB.prepare(
        `SELECT a.status, COUNT(*) AS count
           FROM ec_action_executions a
           JOIN ec_events e ON e.id = a.event_id
          WHERE ${accountClause}
          GROUP BY a.status`,
      ).bind(...(lineAccountId ? [lineAccountId] : (scope?.allowedAccountIds.length ? sqlIdSet(scope.allowedAccountIds).binds : [])))
        .all<{ status: string; count: number }>(),
    ]);
    const orderIds = [...new Set(actionRows.results.flatMap((row) => (
      row.order_id == null ? [] : [String(row.order_id)]
    )))];
    const orderLines = orderIds.length
      ? await c.env.DB.prepare(
        `SELECT id, order_id, external_product_id, product_name, quantity,
                unit_amount_minor, line_amount_minor, product_url
           FROM ec_order_lines
          WHERE order_id IN (${sqlIdSet(orderIds).sql})
          ORDER BY order_id, line_index`,
      ).bind(...(orderIds.length ? sqlIdSet(orderIds).binds : [])).all<Record<string, unknown>>()
      : { results: [] as Record<string, unknown>[] };
    const linesByOrder = new Map<string, Array<Record<string, unknown>>>();
    for (const line of orderLines.results) {
      const orderId = String(line.order_id);
      const lines = linesByOrder.get(orderId) ?? [];
      lines.push({
        id: String(line.id),
        productId: line.external_product_id == null ? null : String(line.external_product_id),
        productName: String(line.product_name),
        quantity: Number(line.quantity),
        unitAmount: line.unit_amount_minor == null ? null : Number(line.unit_amount_minor),
        lineAmount: line.line_amount_minor == null ? null : Number(line.line_amount_minor),
        productUrl: line.product_url == null ? null : String(line.product_url),
      });
      linesByOrder.set(orderId, lines);
    }
    const actionSummary: Record<string, number> = {
      pending: 0, processing: 0, succeeded: 0, skipped: 0, retryable_failed: 0, permanent_failed: 0,
    };
    for (const row of summaryRows.results) {
      if (ACTION_STATUS_SET.has(row.status)) actionSummary[row.status] = Number(row.count);
    }
    return c.json({
      success: true,
      data: buildOffsetListResponse({ items: actionRows.results.map((row) => {
          const orderId = row.order_id == null ? null : String(row.order_id);
          return {
            id: String(row.id),
            eventId: String(row.event_id),
            eventType: String(row.event_type),
            eventLabel: ecEventLabel(String(row.event_type), String(row.event_type)),
            actionType: String(row.action_type),
            ruleVersion: String(row.rule_version),
            status: String(row.status),
            attemptCount: Number(row.attempt_count),
            maxAttempts: Number(row.max_attempts),
            errorCode: row.error_code == null ? null : String(row.error_code),
            errorMessage: row.error_message_safe == null ? null : String(row.error_message_safe),
            lastAttemptedAt: row.last_attempted_at == null ? null : String(row.last_attempted_at),
            nextRetryAt: row.next_retry_at == null ? null : String(row.next_retry_at),
            version: Number(row.version),
            receivedAt: String(row.received_at),
            orderNumber: row.order_number == null ? null : String(row.order_number),
            customerName: row.customer_name == null ? null : String(row.customer_name),
            friendId: row.friend_id == null ? null : String(row.friend_id),
            retryAvailable: row.status === 'retryable_failed' && Number(row.attempt_count) < Number(row.max_attempts),
            /* 「未連携／権限不足／通信失敗」を一覧でも分けるための分類。 */
            failureKind: classifyEcErrorCode(row.error_code == null ? null : String(row.error_code)),
            order: orderId == null ? null : {
              id: orderId,
              lineAccountId: String(row.order_line_account_id),
              externalOrderId: String(row.external_order_id),
              orderNumber: String(row.order_number),
              customerId: row.order_customer_id == null ? null : String(row.order_customer_id),
              friendId: row.order_friend_id == null ? null : String(row.order_friend_id),
              customerName: row.customer_name == null ? null : String(row.customer_name),
              status: String(row.order_status),
              providerStatus: String(row.provider_status),
              currency: String(row.currency),
              totalAmount: row.total_amount_minor == null ? null : Number(row.total_amount_minor),
              refundedAmount: row.refunded_amount_minor == null ? null : Number(row.refunded_amount_minor),
              orderedAt: String(row.ordered_at),
              detailUrl: row.detail_url == null ? null : String(row.detail_url),
              version: Number(row.order_version),
              orderLines: linesByOrder.get(orderId) ?? [],
            },
          };
        }),
        total: Number(actionCount?.count ?? 0),
        summary: actionSummary, paging: { limit, offset }, sort: [{field:'receivedAt',direction:sort === 'oldest' ? 'asc' : 'desc'},{field:'createdAt',direction:sort === 'oldest' ? 'asc' : 'desc'}] }),
      pagination: { total: Number(actionCount?.count ?? 0), limit, offset },
    });
  }

  if (view) return c.json({ success: false, error: '表示方法が正しくありません' }, 400);
  if (eventType && !EVENT_TYPE_SET.has(eventType)) return c.json({ success: false, error: 'Invalid eventType' }, 400);
  if (status && !STATUS_SET.has(status)) return c.json({ success: false, error: 'Invalid status' }, 400);

  const clauses: string[] = [accountClause];
  const bindings: Array<string | number> = lineAccountId ? [lineAccountId] : (scope?.allowedAccountIds.length ? sqlIdSet(scope.allowedAccountIds).binds : []);
  if (eventType) { clauses.push('e.event_type = ?'); bindings.push(eventType); }
  if (status) { clauses.push('e.status = ?'); bindings.push(status); }
  const where = `WHERE ${clauses.join(' AND ')}`;
  const query = c.env.DB.prepare(
    `SELECT e.id, e.external_event_id, e.event_type, e.customer_id, e.friend_id,
            e.status, e.error_message, e.received_at, e.processed_at,
            json_extract(e.payload, '$.order.number') AS order_number,
            f.display_name AS friend_name
       FROM ec_events e
       LEFT JOIN friends f ON f.id = e.friend_id
       ${where}
      ORDER BY e.received_at DESC
      LIMIT ? OFFSET ?`,
  ).bind(...bindings, limit, offset);
  const [rows, countRow] = await Promise.all([
    query.all<{
      id: string; external_event_id: string; event_type: string; customer_id: string | null;
      friend_id: string | null; status: string; error_message: string | null;
      received_at: string; processed_at: string | null; order_number: string | null;
      friend_name: string | null;
    }>(),
    c.env.DB.prepare(`SELECT COUNT(*) AS count FROM ec_events e ${where}`).bind(...bindings).first<{ count: number }>(),
  ]);

  const responseItems = rows.results.map((row) => ({
      id: row.id,
      externalEventId: row.external_event_id,
      eventType: row.event_type,
      eventLabel: ecEventLabel(row.event_type, row.event_type),
      customerId: row.customer_id,
      friendId: row.friend_id,
      friendName: row.friend_name,
      orderNumber: row.order_number,
      status: row.status,
      errorMessage: row.error_message,
      receivedAt: row.received_at,
      processedAt: row.processed_at,
    }));
  return c.json(buildOffsetListResponse({ success: true,
    data: responseItems,
    pagination: { total: countRow?.count ?? 0, limit, offset }, items: responseItems, total: countRow?.count ?? 0, paging: { limit, offset }, sort: [{ field: 'receivedAt', direction: 'desc' }] }));
});

/**
 * ページ送りを指定せずに呼ばれたときに返す件数。
 *
 *  と同じ考え方で、古い呼び出し側を壊さずに上限を置き、`Warning` で
 * ページ送りへ誘導する。ページ送りを指定した呼び出しにはこの上限はかからない。
 */
const SUBSCRIPTIONS_NON_PAGINATED_MAX = 100;

/**
 * 契約の状態を読む元の値。JS 側は `contract.status_code || contract.status` で、
 * 空文字も次へ送るので、SQL でも `nullif(..., '')` で空文字を NULL に倒す。
 */
const SUBSCRIPTION_STATUS_EXPR = `coalesce(nullif(json_extract(c.value, '$.status_code'), ''), nullif(json_extract(c.value, '$.status'), ''), '')`;

/**
 * `monthKey` と同じ月キーを SQL で作る。`2026-9-01` のような1桁月も
 * `2026-09` に揃える。文字列でない値は NULL(集計から外れる)。
 */
function monthKeySql(expr: string): string {
  return `CASE
    WHEN json_type(${expr}) != 'text' THEN NULL
    WHEN json_extract(${expr}) GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]*'
      THEN substr(json_extract(${expr}), 1, 7)
    WHEN json_extract(${expr}) GLOB '[0-9][0-9][0-9][0-9]-[0-9]*'
      THEN substr(json_extract(${expr}), 1, 5) || '0' || substr(json_extract(${expr}), 6, 1)
    ELSE NULL END`;
}

/** 文字列として取り出す。JS 側が `typeof === 'string'` を見ているのに合わせる。 */
function jsonTextSql(path: string): string {
  return `CASE WHEN json_type(c.value, '${path}') = 'text' THEN json_extract(c.value, '${path}') END`;
}

/** 数として取り出す。JS 側の `finiteNumber`(有限の number だけ)に合わせる。 */
function jsonNumberSql(path: string): string {
  return `CASE WHEN json_type(c.value, '${path}') IN ('integer', 'real') THEN json_extract(c.value, '${path}') END`;
}

ecCommerce.get(
  '/api/ec-commerce/subscriptions',
  requireRole('owner', 'admin', 'staff'),
  requireEcPermission('ec.event.view'),
  async (c) => {
  const lineAccountId = c.req.query('lineAccountId')?.trim() || '';
  if (!lineAccountId) return c.json({ success: false, error: 'LINEアカウントを選択してください' }, 400);
  if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [lineAccountId])) {
    return c.json({ success: false, error: 'このLINEアカウントを表示する権限がありません' }, 403);
  }
  const filter = c.req.query('status') || 'all';
  if (!['all', 'active', 'paused', 'at_risk', 'cancelled'].includes(filter)) {
    return c.json({ success: false, error: '表示条件が正しくありません' }, 400);
  }
  const hasPagination = c.req.query('limit') !== undefined || c.req.query('offset') !== undefined;
  const { limit: requestedLimit, offset: requestedOffset } = parseOffsetPaging({ limit: c.req.query('limit') || undefined, offset: c.req.query('offset') || undefined }, { defaultLimit: SUBSCRIPTIONS_NON_PAGINATED_MAX, limitPolicy: {}, offsetPolicy: {} });
  const limit = Number.isInteger(requestedLimit)
    ? Math.min(Math.max(requestedLimit, 1), 100)
    : SUBSCRIPTIONS_NON_PAGINATED_MAX;
  const offset = Number.isInteger(requestedOffset) ? Math.max(requestedOffset, 0) : 0;

  /*
   * 契約は1行の JSON 配列に入っているので、`json_each` で行へ展開してから
   * 数える。行(=定期便を持つ友だち)を 500 で切って JS で数えていた
   * ころは、501人目以降の契約が一覧にも集計にも入らず、切ったことを知らせる
   * 手がかりも無かった。
   *
   * **`json_type` の守りは外さないこと。**`contracts` が配列でない行が1つでも
   * あると `json_each` は `malformed JSON` でクエリ全体を落とす。JS 側は
   * `try/catch` と `Array.isArray` で守っていたので、SQL へ移すとその守りが
   * 消える。弾いた行の数は下で別に数えて、応答と記録に残す。
   */
  const currentMonth = jstDate().slice(0, 7);
  const contractsCte = `
    WITH contracts AS (
      SELECT s.friend_id AS friend_id,
             s.synced_at AS synced_at,
             f.display_name AS owner_name,
             c.key AS contract_index,
             c.value AS contract_json,
             ${subscriptionStateSql(SUBSCRIPTION_STATUS_EXPR)} AS state,
             coalesce(${jsonTextSql('$.next_shipping_date')}, ${jsonTextSql('$.scheduled_shipping_date')}) AS next_shipping_at,
             ${jsonNumberSql('$.amount')} AS amount,
             ${monthKeySql("c.value, '$.started_at'")} AS started_month,
             ${monthKeySql("c.value, '$.cancelled_at'")} AS cancelled_month,
             ${jsonTextSql('$.cancellation_reason')} AS cancellation_reason
        FROM nen_ec_member_snapshots s
        JOIN friends f ON f.id = s.friend_id,
             json_each(json_extract(s.subscription_json, '$.contracts')) c
       WHERE f.line_account_id = ?
         AND json_type(s.subscription_json, '$.contracts') = 'array'
    )`;

  /*
   * 同じ結果を安定して返すため、次回発送日の昇順、日付なしは末尾とし、同日の場合は同期の新しい行と行内の順序を保つ。
   */
  const orderBy = 'ORDER BY (next_shipping_at IS NULL), next_shipping_at ASC, synced_at DESC, friend_id ASC, contract_index ASC';
  const stateWhere = filter === 'all' ? '' : 'WHERE state = ?';
  const stateBindings = filter === 'all' ? [] : [filter];

  const [rows, countRow, stateRows, amountRow, monthRows, cancelRow, reasonRow, malformedRow, syncedRow] = await Promise.all([
    // 一覧。**ページの行にだけ**ペットの名前を引く。500行ぶん引いていたのをやめる。
    c.env.DB.prepare(
      `${contractsCte}
       SELECT friend_id, owner_name, contract_json, synced_at, state, next_shipping_at,
              (SELECT p.name FROM nen_pet_profiles p
                WHERE p.friend_id = contracts.friend_id ORDER BY p.created_at LIMIT 1) AS pet_name,
              contract_index
         FROM contracts ${stateWhere} ${orderBy} LIMIT ? OFFSET ?`,
    ).bind(lineAccountId, ...stateBindings, limit, offset).all<{
      friend_id: string; owner_name: string | null; contract_json: string; synced_at: string;
      state: SubscriptionState; next_shipping_at: string | null; pet_name: string | null;
      contract_index: number;
    }>(),
    // 絞り込みに合う総数。ここが正しくないと「N件中M件」が嘘になる。
    c.env.DB.prepare(`${contractsCte} SELECT COUNT(*) AS count FROM contracts ${stateWhere}`)
      .bind(lineAccountId, ...stateBindings).first<{ count: number }>(),
    // 集計は**絞り込みの前**。元の実装と同じ。
    c.env.DB.prepare(`${contractsCte} SELECT state, COUNT(*) AS count FROM contracts GROUP BY state`)
      .bind(lineAccountId).all<{ state: SubscriptionState; count: number }>(),
    c.env.DB.prepare(
      `${contractsCte}
       SELECT COUNT(*) AS total, COUNT(amount) AS with_amount, coalesce(SUM(amount), 0) AS sum_amount
         FROM contracts`,
    ).bind(lineAccountId).first<{ total: number; with_amount: number; sum_amount: number }>(),
    c.env.DB.prepare(
      `${contractsCte}
       SELECT started_month AS month, COUNT(*) AS count, coalesce(SUM(amount), 0) AS amount
         FROM contracts WHERE started_month IS NOT NULL GROUP BY started_month ORDER BY started_month ASC`,
    ).bind(lineAccountId).all<{ month: string; count: number; amount: number }>(),
    c.env.DB.prepare(
      `${contractsCte} SELECT COUNT(*) AS count FROM contracts WHERE cancelled_month = ?`,
    ).bind(lineAccountId, currentMonth).first<{ count: number }>(),
    c.env.DB.prepare(
      `${contractsCte}
       SELECT cancellation_reason AS reason, COUNT(*) AS count FROM contracts
        WHERE cancellation_reason IS NOT NULL AND cancellation_reason != ''
        GROUP BY cancellation_reason ORDER BY count DESC, reason ASC LIMIT 1`,
    ).bind(lineAccountId).first<{ reason: string; count: number }>(),
    // 弾いた行。**黙って数から落とさない**ための数。
    c.env.DB.prepare(
      `SELECT COUNT(*) AS count
         FROM nen_ec_member_snapshots s JOIN friends f ON f.id = s.friend_id
        WHERE f.line_account_id = ? AND s.subscription_json IS NOT NULL
          AND json_type(s.subscription_json, '$.contracts') != 'array'`,
    ).bind(lineAccountId).first<{ count: number }>(),
    c.env.DB.prepare(
      `SELECT s.synced_at FROM nen_ec_member_snapshots s JOIN friends f ON f.id = s.friend_id
        WHERE f.line_account_id = ? AND s.subscription_json IS NOT NULL
        ORDER BY s.synced_at DESC LIMIT 1`,
    ).bind(lineAccountId).first<{ synced_at: string }>(),
  ]);

  const malformedSnapshots = Number(malformedRow?.count ?? 0);
  if (malformedSnapshots > 0) {
    // 運用者が「なぜ数が合わないのか」を後から追えるようにする。
    logger.warn("ec_subscriptions_malformed_snapshots_skipped");
  }

  const items = rows.results.map((row) => {
    const contract = JSON.parse(row.contract_json || '{}') as Record<string, unknown>;
    const id = String(contract.id || contract.contract_number || `${row.friend_id}:${row.contract_index}`);
    return {
      id,
      friendId: row.friend_id,
      ownerName: row.owner_name,
      petName: row.pet_name,
      contractNumber: typeof contract.contract_number === 'string' ? contract.contract_number : null,
      status: row.state,
      statusLabel: row.state === 'active' ? '続いています' : row.state === 'paused' ? '休止中です'
        : row.state === 'at_risk' ? '決済の確認が必要です' : '止まりました',
      riskReason: row.state === 'at_risk' ? '定期便のお支払いを確認できませんでした' : null,
      nextShippingAt: row.next_shipping_at,
      /*
       * 定期便の変更先。ECが契約ごとに渡すマイページURLをそのまま出す。
       * https 以外や形の違う値は出さない（クリック先を偽装しない）。
       */
      manageUrl: [contract.manage_url, contract.mypage_subscription_url]
        .map((value) => (typeof value === 'string' ? value.trim() : ''))
        .find((value) => value !== '' && isValidHttpsUrl(value)) ?? null,
      cycle: typeof contract.cycle === 'string' ? contract.cycle : null,
      items: subscriptionItems(contract.items),
      amount: finiteNumber(contract.amount),
      continuedCount: finiteNumber(contract.continued_count),
      startedAt: typeof contract.started_at === 'string' ? contract.started_at : null,
      cancelledAt: typeof contract.cancelled_at === 'string' ? contract.cancelled_at : null,
      cancellationReason: typeof contract.cancellation_reason === 'string' ? contract.cancellation_reason : null,
      syncedAt: row.synced_at,
    };
  });

  const stateCount = (state: SubscriptionState): number =>
    Number(stateRows.results.find((row) => row.state === state)?.count ?? 0);
  const total = Number(amountRow?.total ?? 0);
  const withAmount = Number(amountRow?.with_amount ?? 0);

  if (!hasPagination) {
    // Header 値は ASCII のみ。日本語の案内は PR と票に残す( と同じ)。
    c.header(
      'Warning',
      `299 - "non-paginated subscriptions are limited to ${SUBSCRIPTIONS_NON_PAGINATED_MAX} rows; use limit/offset"`,
    );
  }

  return c.json({
    success: true,
    data: buildOffsetListResponse({ items,
      summary: {
        total,
        active: stateCount('active'),
        paused: stateCount('paused'),
        atRisk: stateCount('at_risk'),
        cancelled: stateCount('cancelled'),
        // 元の実装と同じく、**全件に金額があるときだけ**合計を出す。
        monthlyAmount: total > 0 && withAmount === total ? Number(amountRow?.sum_amount ?? 0) : null,
        startedThisMonth: Number(
          monthRows.results.find((row) => row.month === currentMonth)?.count ?? 0,
        ),
        cancelledThisMonth: Number(cancelRow?.count ?? 0),
        cancellationTopReason: reasonRow?.reason ?? null,
        monthlyStats: monthRows.results.map((row) => ({
          month: row.month,
          count: Number(row.count),
          amount: Number(row.amount),
        })),
      },
      /** 形が違って読めなかったスナップショットの数。0 でも必ず返す。 */
      skipped: { malformedSnapshots },
      risk: {
        source: 'payment_status',
        ruleVersion: 'subscription-payment-status-v1',
        calculatedAt: syncedRow?.synced_at ?? null,
        predictiveScoreAvailable: false,
      }, total: Number(countRow?.count ?? 0), paging: { limit, offset }, sort: [] }),
    pagination: { total: Number(countRow?.count ?? 0), limit, offset },
  });
});

ecCommerce.get(
  '/api/ec-commerce/connector',
  requireRole('owner', 'admin', 'staff'),
  requireEcPermission('ec.event.view'),
  async (c) => {
  const lineAccountId = c.req.query('lineAccountId')?.trim() || '';
  if (!lineAccountId) return c.json({ success: false, error: 'LINEアカウントを選択してください' }, 400);
  if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [lineAccountId])) {
    return c.json({ success: false, error: 'このLINEアカウントを表示する権限がありません' }, 403);
  }
  /*
   * health の今日・この30日は JST の暦日で切る。UTC の date('now') では日本時間の朝9時前や月末の境界がずれる。
   */
  const healthTodayStart = jstDateString(0);
  const healthWindowStart = jstDateString(-29);
  const healthWindowEnd = nextDateString(healthTodayStart);
  const [connector, health, impactRows] = await Promise.all([
    c.env.DB.prepare(
      `SELECT id, provider, shop_domain, status, inbound_secret_encrypted,
              inbound_secret_last4, secret_updated_at, event_types_json,
              identity_rules_json, version, updated_at
         FROM ec_connectors WHERE line_account_id = ? LIMIT 1`,
    ).bind(lineAccountId).first<Record<string, unknown>>(),
    c.env.DB.prepare(
      `SELECT
         SUM(CASE WHEN received_at >= ? AND received_at < ? THEN 1 ELSE 0 END) AS today,
         SUM(CASE WHEN received_at >= ? AND received_at < ? THEN 1 ELSE 0 END) AS last_30_days,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
         MAX(received_at) AS last_received_at,
         MAX(CASE WHEN status = 'processed' THEN processed_at END) AS last_succeeded_at
       FROM ec_events WHERE line_account_id = ?`,
    ).bind(healthTodayStart, healthWindowEnd, healthWindowStart, healthWindowEnd, lineAccountId).first<Record<string, unknown>>(),
    /*
     *  「止めると影響する数」は EC の出来事を起点にする設定だけを
     * 数える。コラム・誕生日など EC と無関係なNEN配信、手動のマイル・項目を
     * 全体件数として混ぜると、止めても変わらないものまで影響に見える。
     * conversion_events と analytics_saved_analyses は EC 起点かを判定する
     * 列を持たないため、アカウント全体の記録数として返す（画面側で区別して
     * 表示する）。
     */
    Promise.all([
      c.env.DB.prepare(`SELECT COUNT(*) AS count FROM nen_campaign_settings WHERE trigger_event LIKE 'ec.%'`).first<{ count: number }>(),
      c.env.DB.prepare('SELECT COUNT(*) AS count FROM conversion_events e JOIN friends f ON f.id = e.friend_id WHERE f.line_account_id = ?').bind(lineAccountId).first<{ count: number }>(),
      c.env.DB.prepare(`SELECT COUNT(*) AS count FROM mileage_rules WHERE source = 'ec'`).first<{ count: number }>(),
      c.env.DB.prepare(`SELECT COUNT(*) AS count FROM friend_fields WHERE source = 'ec'`).first<{ count: number }>(),
      c.env.DB.prepare('SELECT COUNT(*) AS count FROM analytics_saved_analyses WHERE line_account_id = ?').bind(lineAccountId).first<{ count: number }>(),
    ]),
  ]);
  const [nenCampaigns, conversions, mileageRules, friendFields, analytics] = impactRows;
  return c.json({
    success: true,
    data: {
      configured: Boolean(connector),
      connector: connector ? {
        id: connector.id,
        provider: connector.provider,
        shopDomain: connector.shop_domain,
        status: connector.status,
        secretConfigured: Boolean(connector.inbound_secret_encrypted),
        secretLastFour: connector.inbound_secret_last4,
        secretUpdatedAt: connector.secret_updated_at,
        eventTypes: storedStringList(connector.event_types_json, EVENT_TYPE_SET),
        identityRules: storedStringList(connector.identity_rules_json, IDENTITY_RULES),
        version: connector.version,
        updatedAt: connector.updated_at,
      } : null,
      health: {
        today: Number(health?.today ?? 0),
        last30Days: Number(health?.last_30_days ?? 0),
        failed: Number(health?.failed ?? 0),
        lastReceivedAt: health?.last_received_at ?? null,
        lastSucceededAt: health?.last_succeeded_at ?? null,
      },
      impact: {
        nenCampaigns: nenCampaigns?.count ?? 0,
        conversions: conversions?.count ?? 0,
        mileageRules: mileageRules?.count ?? 0,
        friendFields: friendFields?.count ?? 0,
        analytics: analytics?.count ?? 0,
      },
      retryPolicy: null,
    },
  });
});

ecCommerce.put('/api/ec-commerce/connector', requireRole('owner', 'admin'), inputJsonBoundary({"provider":["string"],"shopDomain":["string"],"status":["string"],"inboundSecret":["string"],"expectedVersion":["number"]}), async (c) => {
  const lineAccountId = c.req.query('lineAccountId')?.trim() || '';
  if (!lineAccountId) return inputError(c, { success: false, error: 'LINEアカウントを選択してください' }, 400, ["lineAccountId"]);
  if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [lineAccountId])) {
    return c.json({ success: false, error: 'このLINEアカウントを操作する権限がありません' }, 403);
  }
  const body = await c.req.json<{
    provider?: string;
    shopDomain?: string;
    status?: string;
    inboundSecret?: string;
    eventTypes?: unknown;
    identityRules?: unknown;
    expectedVersion?: number;
  }>().catch(() => null);
  const provider = String(body?.provider || '');
  const shopDomain = String(body?.shopDomain || '').trim().toLowerCase();
  const status = String(body?.status || 'connected');
  const eventTypes = stringList(body?.eventTypes, EVENT_TYPE_SET);
  const identityRules = stringList(body?.identityRules, IDENTITY_RULES);
  const expectedVersion = Number(body?.expectedVersion);
  if (!CONNECTOR_PROVIDERS.has(provider) || !CONNECTOR_STATUSES.has(status)
    || !/^(?=.{3,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])$/.test(shopDomain)
    || eventTypes === null || identityRules === null
    || !Number.isInteger(expectedVersion) || expectedVersion < 0) {
    return inputError(c, { success: false, error: 'つなぎ先の設定を確認してください' }, 400, ["provider","status","shopDomain","eventTypes","identityRules","expectedVersion"]);
  }
  const inboundSecret = typeof body?.inboundSecret === 'string' ? body.inboundSecret.trim() : '';
  if (inboundSecret && inboundSecret.length < 32) {
    return inputError(c, { success: false, error: 'つなぐための鍵は32文字以上で入力してください' }, 400, ["inboundSecret"]);
  }
  const current = await c.env.DB.prepare(
    `SELECT id, version, status, inbound_secret_encrypted, inbound_secret_last4, secret_updated_at
       FROM ec_connectors WHERE line_account_id = ? LIMIT 1`,
  ).bind(lineAccountId).first<Record<string, unknown>>();
  if ((current ? Number(current.version) : 0) !== expectedVersion) {
    return c.json({ success: false, error: 'ほかの担当者が先に設定を変更しました' }, 409);
  }
  const now = jstNow();
  let encrypted = current?.inbound_secret_encrypted ?? null;
  let lastFour = current?.inbound_secret_last4 ?? null;
  let secretUpdatedAt = current?.secret_updated_at ?? null;
  if (inboundSecret) {
    try {
      encrypted = await encryptCredential(inboundSecret, c.env.LINE_CREDENTIAL_ENCRYPTION_KEY);
    } catch {
      return c.json({ success: false, error: 'つなぐための鍵を安全に保存できませんでした' }, 503);
    }
    lastFour = inboundSecret.slice(-4);
    secretUpdatedAt = now;
  }
  const nextVersion = Number(expectedVersion) + 1;
  if (current) {
    const result = await c.env.DB.prepare(
      `UPDATE ec_connectors
          SET provider = ?, shop_domain = ?, status = ?, inbound_secret_encrypted = ?,
              inbound_secret_last4 = ?, secret_updated_at = ?, event_types_json = ?,
              identity_rules_json = ?, version = ?, updated_at = ?
        WHERE id = ? AND line_account_id = ? AND version = ?`,
    ).bind(
      provider, shopDomain, status, encrypted, lastFour, secretUpdatedAt,
      JSON.stringify(eventTypes), JSON.stringify(identityRules), nextVersion, now,
      current.id, lineAccountId, expectedVersion,
    ).run();
    if (!result.meta.changes) return c.json({ success: false, error: 'ほかの担当者が先に設定を変更しました' }, 409);
  } else {
    try {
      await c.env.DB.prepare(
        `INSERT INTO ec_connectors
          (id, line_account_id, provider, shop_domain, status, inbound_secret_encrypted,
           inbound_secret_last4, secret_updated_at, event_types_json, identity_rules_json,
           version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        crypto.randomUUID(), lineAccountId, provider, shopDomain, status, encrypted,
        lastFour, secretUpdatedAt, JSON.stringify(eventTypes), JSON.stringify(identityRules),
        nextVersion, now, now,
      ).run();
    } catch {
      return c.json({ success: false, error: 'ほかの担当者が先に設定を追加しました' }, 409);
    }
  }
  // 停止から再開したときは、止めていた分の受信を待ち行列へ戻す。
  // 再試行の定期回収が拾って処理する（上限つき・失敗は dead letter）。
  if (String(current?.status ?? '') === 'paused' && status !== 'paused') {
    await c.env.DB.prepare(
      `UPDATE ec_events SET status = 'received', error_message = NULL, updated_at = ?
        WHERE line_account_id = ? AND status = 'skipped' AND error_message = 'connector_paused'`,
    ).bind(now, lineAccountId).run();
    await c.env.DB.prepare(
      `UPDATE ec_action_executions
          SET status = 'retryable_failed', error_code = 'connector_paused',
              error_message_safe = '取り込み再開のため再試行します', next_retry_at = ?, updated_at = ?
        WHERE line_account_id = ? AND status = 'skipped' AND error_code = 'connector_paused'`,
    ).bind(now, now, lineAccountId).run();
  }
  auditLog(c, 'ec.connector.update', { kind: 'line_account', id: lineAccountId });
  return c.json({ success: true, data: { version: nextVersion } });
});

/** の共通送信台帳を、既存画面の互換URLでも返す。 */
ecCommerce.get(
  '/api/ec-commerce/notification-runs',
  requireRole('owner', 'admin', 'staff'),
  notificationDeliveriesResponse,
);

ecCommerce.get(
  '/api/ec-commerce/settings',
  requireRole('owner', 'admin', 'staff'),
  requireEcPermission('ec.event.view'),
  async (c) => {
  const lineAccountId = c.req.query('lineAccountId')?.trim();
  if (!lineAccountId) return c.json({ success: false, error: 'LINEアカウントを選択してください' }, 400);
  if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [lineAccountId])) {
    return c.json({ success: false, error: 'このLINEアカウントを表示する権限がありません' }, 403);
  }
  const rows = await c.env.DB.prepare(
    `SELECT s.event_type,
            COALESCE(a.is_enabled, s.is_enabled) AS is_enabled,
            CASE WHEN a.line_account_id IS NULL THEN s.title_override ELSE a.title_override END AS title_override,
            CASE WHEN a.line_account_id IS NULL THEN s.intro_text ELSE a.intro_text END AS intro_text,
            CASE WHEN a.line_account_id IS NULL THEN s.outro_text ELSE a.outro_text END AS outro_text,
            s.category,
            CASE WHEN a.line_account_id IS NULL THEN s.button_label ELSE a.button_label END AS button_label,
            CASE WHEN a.line_account_id IS NULL THEN s.button_url ELSE a.button_url END AS button_url,
            CASE WHEN a.line_account_id IS NULL THEN s.image_url ELSE a.image_url END AS image_url,
            s.display_order,
            COALESCE(a.updated_at, s.updated_at) AS updated_at
       FROM ec_notification_settings s
       LEFT JOIN ec_notification_account_settings a
         ON a.event_type = s.event_type AND a.line_account_id = ?
      ORDER BY s.display_order, s.rowid`,
  ).bind(lineAccountId).all<{
    event_type: string; is_enabled: number; title_override: string | null;
    intro_text: string | null; outro_text: string | null; category: string;
    button_label: string | null; button_url: string | null; image_url: string | null;
    display_order: number; updated_at: string;
  }>();
  return c.json({
    success: true,
    data: rows.results.map((row) => {
      const fixedPreview = (FIXED_FIELDS[row.event_type] || [])
        .map((field) => `${field}：ecデータから自動表示`)
        .join('\n');
      return {
        eventType: row.event_type,
        label: ecEventLabel(row.event_type, row.event_type),
        isEnabled: row.is_enabled === 1,
        title: row.title_override,
        introText: row.intro_text || '',
        outroText: row.outro_text || '',
        category: row.category,
        buttonLabel: row.button_label || '',
        buttonUrl: row.button_url || '',
        imageUrl: row.image_url || '',
        displayOrder: row.display_order,
        fixedFields: FIXED_FIELDS[row.event_type] || [],
        fixedPreview,
        updatedAt: row.updated_at,
      };
    }),
  });
});

ecCommerce.put('/api/ec-commerce/settings/:eventType', requireRole('owner', 'admin'), inputJsonBoundary(), async (c) => {
  const eventType = c.req.param('eventType');
  if (!EVENT_TYPE_SET.has(eventType)) return inputError(c, { success: false, error: 'Invalid eventType' }, 400, ["eventType"]);
  const lineAccountId = c.req.query('lineAccountId')?.trim();
  if (!lineAccountId) return inputError(c, { success: false, error: 'LINEアカウントを選択してください' }, 400, ["lineAccountId"]);
  if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [lineAccountId])) {
    return c.json({ success: false, error: 'このLINEアカウントを操作する権限がありません' }, 403);
  }
  const body = await c.req.json<{
    isEnabled?: unknown; title?: unknown; introText?: unknown; outroText?: unknown;
    buttonLabel?: unknown; buttonUrl?: unknown; imageUrl?: unknown;
  }>().catch(() => null);
  if (!body || typeof body.isEnabled !== 'boolean' || typeof body.title !== 'string'
      || typeof body.introText !== 'string' || typeof body.outroText !== 'string'
      || typeof body.buttonLabel !== 'string' || typeof body.buttonUrl !== 'string'
      || typeof body.imageUrl !== 'string') {
    return inputError(c, { success: false, error: 'isEnabled, title, introText and outroText are required' }, 400, ["isEnabled","title","introText","outroText","buttonLabel","buttonUrl","imageUrl"]);
  }
  const title = body.title.trim();
  if (!title || title.length > 80) return inputError(c, { success: false, error: 'Title must be 1-80 characters' }, 400, ["title"]);
  const introText = body.introText.trim();
  const outroText = body.outroText.trim();
  if (introText.length > 800 || outroText.length > 800) {
    return inputError(c, { success: false, error: 'Editable copy must be 800 characters or fewer' }, 400, ["introText","outroText"]);
  }
  const buttonLabel = body.buttonLabel.trim();
  const buttonUrl = body.buttonUrl.trim();
  const imageUrl = body.imageUrl.trim();
  if (buttonLabel.length > 20 || !isValidHttpsUrl(buttonUrl) || !isValidHttpsUrl(imageUrl)) {
    return inputError(c, { success: false, error: 'Invalid button or image' }, 400, ["buttonLabel","buttonUrl","imageUrl"]);
  }
  const now = jstNow();
  await c.env.DB.prepare(
    `INSERT INTO ec_notification_account_settings
       (line_account_id, event_type, is_enabled, title_override, intro_text, outro_text,
        button_label, button_url, image_url, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(line_account_id, event_type) DO UPDATE SET is_enabled = excluded.is_enabled,
       title_override = excluded.title_override, intro_text = excluded.intro_text,
       outro_text = excluded.outro_text, button_label = excluded.button_label,
       button_url = excluded.button_url, image_url = excluded.image_url,
       updated_at = excluded.updated_at`,
  ).bind(lineAccountId, eventType, body.isEnabled ? 1 : 0, title, introText, outroText,
    buttonLabel || null, buttonUrl || null, imageUrl || null, now, now).run();
  return c.json({ success: true });
});

ecCommerce.post('/api/ec-commerce/test-send', requireRole('owner', 'admin'), inputJsonBoundary(), async (c) => {
  const body = await c.req.json<{
    eventType?: unknown; accountId?: unknown; title?: unknown; introText?: unknown; outroText?: unknown;
    buttonLabel?: unknown; buttonUrl?: unknown; imageUrl?: unknown; expectedRecipientIds?: unknown; expectedConfirmationRevision?: unknown;
  }>().catch(() => null);
  if (!body || typeof body.eventType !== 'string' || !EVENT_TYPE_SET.has(body.eventType)) {
    return inputError(c, { success: false, error: 'Invalid eventType' }, 400, ["eventType"]);
  }
  if (typeof body.accountId !== 'string' || !body.accountId) {
    return fail(c, 400, 'ACCOUNT_ID_REQUIRED', {}, ["accountId"]);
  }
  if (typeof body.title !== 'string' || !body.title.trim() || body.title.trim().length > 80
      || typeof body.introText !== 'string' || body.introText.trim().length > 800
      || typeof body.outroText !== 'string' || body.outroText.trim().length > 800
      || typeof body.buttonLabel !== 'string' || typeof body.buttonUrl !== 'string'
      || typeof body.imageUrl !== 'string') {
    return inputError(c, { success: false, error: 'Invalid notification copy' }, 400, ["title","introText","outroText","buttonLabel","buttonUrl","imageUrl"]);
  }
  if (body.buttonLabel.trim().length > 20
      || !isValidHttpsUrl(body.buttonUrl.trim())
      || !isValidHttpsUrl(body.imageUrl.trim())) {
    return inputError(c, { success: false, error: 'Invalid button or image' }, 400, ["buttonLabel","buttonUrl","imageUrl"]);
  }
  if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [body.accountId])) {
    return c.json({ success: false, error: 'このLINEアカウントを操作する権限がありません' }, 403);
  }
  const expectedRecipientIds = body.expectedRecipientIds;
  if (expectedRecipientIds !== undefined && (!Array.isArray(expectedRecipientIds)
    || expectedRecipientIds.length > 20 || expectedRecipientIds.some((id) => typeof id !== 'string' || !id)
    || new Set(expectedRecipientIds).size !== expectedRecipientIds.length)) {
    return inputError(c, { success: false, error: '確認した送信先が不正です' }, 400, ['expectedRecipientIds']);
  }
  const expectedRevision = body.expectedConfirmationRevision;
  if (expectedRevision !== undefined && (!Number.isInteger(expectedRevision) || Number(expectedRevision) < 0)) {
    return inputError(c, { success: false, error: '確認した版が不正です' }, 400, ['expectedConfirmationRevision']);
  }
  const cooldownKey = `${body.accountId}:${body.eventType}`;
  const lastSent = testSendAt.get(cooldownKey) ?? 0;
  const waitMs = lastSent + TEST_SEND_COOLDOWN_MS - Date.now();
  if (waitMs > 0) {
    return c.json({
      success: false,
      error: `テスト送信は${Math.ceil(waitMs / 1000)}秒待ってからもう一度お試しください`,
    }, 429);
  }
  const cooldownStartedAt = Date.now();
  testSendAt.set(cooldownKey, cooldownStartedAt);
  const releaseStaleCooldown = () => {
    if (testSendAt.get(cooldownKey) === cooldownStartedAt) testSendAt.delete(cooldownKey);
  };
  const account = await getLineAccountById(c.env.DB, body.accountId);
  if (!account?.channel_access_token) return inputError(c, { success: false, error: 'LINE account is not configured' }, 400, ["accountId"]);

  const recipientSetting = await c.env.DB.prepare(
    `SELECT value, confirmation_revision FROM account_settings WHERE line_account_id = ? AND key = 'test_recipients'`,
  ).bind(body.accountId).first<{ value: string; confirmation_revision: number }>();
  let friendIds: string[] = [];
  try {
    const parsed = recipientSetting ? JSON.parse(recipientSetting.value) : [];
    if (Array.isArray(parsed)) friendIds = parsed.filter((value): value is string => typeof value === 'string').slice(0, 20);
  } catch {
    friendIds = [];
  }
  if (expectedRevision !== undefined && expectedRevision !== (recipientSetting?.confirmation_revision ?? 0)) {
    releaseStaleCooldown();
    return c.json({ success: false, code: 'recipients_changed', error: 'テスト送信先が変わりました。読み直してください。', data: { recipientIds: friendIds, confirmationRevision: recipientSetting?.confirmation_revision ?? 0 } }, 409);
  }
  if (!friendIds.length) {
    if (Array.isArray(expectedRecipientIds) && expectedRecipientIds.length > 0) {
      releaseStaleCooldown();
      return c.json({ success: false, code: 'recipients_changed', error: 'テスト送信先が変わりました。読み直してください。', data: { recipientIds: [] } }, 409);
    }
    return inputError(c, { success: false, error: 'Test recipients are not configured' }, 400, []);
  }

  const placeholders = sqlIdSet(friendIds).sql;
  const friends = await c.env.DB.prepare(
    `SELECT id, line_user_id FROM friends WHERE line_account_id = ? AND is_following = 1 AND id IN (${placeholders})`,
  ).bind(body.accountId, ...(friendIds.length ? sqlIdSet(friendIds).binds : [])).all<{ id: string; line_user_id: string }>();
  const currentIds = friends.results.map((friend) => friend.id).sort();
  const expectedIds = Array.isArray(expectedRecipientIds) ? [...expectedRecipientIds].sort() : null;
  if (expectedIds && JSON.stringify(expectedIds) !== JSON.stringify(currentIds)) {
    releaseStaleCooldown();
    return c.json({ success: false, code: 'recipients_changed', error: 'テスト送信先が変わりました。読み直してください。', data: { recipientIds: currentIds } }, 409);
  }
  if (!friends.results.length) return inputError(c, { success: false, error: 'No active test recipients' }, 400, ["accountId"]);

  // テスト送信の見出し・前後の文章にも {{var.*}} を書ける。
  // 消えた共通情報は空文字にせず、テスト送信を止める。
  const { expandSendCommonVars } = await import('../services/interpolation-context.js');
  const ecTestSource = { kind: 'test_send' as const, id: `ec-${body.eventType}` };
  const ecTestCtx = { lineAccountId: body.accountId };
  const [testTitle, testIntro, testOutro] = await Promise.all([
    expandSendCommonVars(c.env.DB, body.title.trim(), ecTestSource, ecTestCtx),
    expandSendCommonVars(c.env.DB, body.introText.trim(), ecTestSource, ecTestCtx),
    expandSendCommonVars(c.env.DB, body.outroText.trim(), ecTestSource, ecTestCtx),
  ]);
  const message = ecFlexMessage(testEvent(body.eventType), {
    title: testTitle,
    introText: testIntro,
    outroText: testOutro,
    buttonLabel: body.buttonLabel.trim(),
    buttonUrl: body.buttonUrl.trim(),
    imageUrl: body.imageUrl.trim(),
    test: true,
  });
  // 送信準備中の宛先変更も、LINEへの操作前に拒否する。
  if (expectedIds || expectedRevision !== undefined) {
    const latestSetting = await c.env.DB.prepare(
      `SELECT value, confirmation_revision FROM account_settings WHERE line_account_id = ? AND key = 'test_recipients'`,
    ).bind(body.accountId).first<{ value: string; confirmation_revision: number }>();
    let latestIds: string[] = [];
    try {
      const value: unknown = JSON.parse(latestSetting?.value ?? '[]');
      if (Array.isArray(value)) latestIds = value.filter((id): id is string => typeof id === 'string').slice(0, 20);
    } catch { /* 壊れた設定は空として照合する。 */ }
    if (expectedRevision !== undefined && expectedRevision !== (latestSetting?.confirmation_revision ?? 0)) {
      releaseStaleCooldown();
      return c.json({ success: false, code: 'recipients_changed', error: 'テスト送信先が変わりました。読み直してください。', data: { recipientIds: latestIds, confirmationRevision: latestSetting?.confirmation_revision ?? 0 } }, 409);
    }
    const latestSet = sqlIdSet(latestIds);
    const latest = await c.env.DB.prepare(
      `SELECT id, line_user_id FROM friends WHERE line_account_id = ? AND is_following = 1 AND id IN (${latestSet.sql})`,
    ).bind(body.accountId, ...latestSet.binds).all<{ id: string; line_user_id: string }>();
    const snapshot = (items: Array<{ id: string; line_user_id: string }>) =>
      JSON.stringify(items.map((item) => [item.id, item.line_user_id]).sort((a, b) => a[0].localeCompare(b[0])));
    if (snapshot(latest.results) !== snapshot(friends.results)) {
      releaseStaleCooldown();
      return c.json({ success: false, code: 'recipients_changed', error: 'テスト送信先が変わりました。読み直してください。', data: { recipientIds: latest.results.map((item) => item.id) } }, 409);
    }
  }
  const client = new LineClient(account.channel_access_token);
  let sent = 0;
  for (const friend of friends.results) {
    await client.pushMessage(friend.line_user_id, [message]);
    await logOutgoingMessage(c.env.DB, {
      friendId: friend.id,
      messageType: message.type,
      content: message.type === 'text' ? message.text : JSON.stringify(message),
      deliveryType: 'push',
      source: 'ec_test',
      lineAccountId: account.id,
    });
    sent += 1;
  }
  return c.json({ success: true, data: { sent } });
});

// ---------------------------------------------------------------------------
// 出荷予定
//
// ec_events.payload には商品・数量・定期便の発送予定日が入っているのに、
// これまで取り出していたのは注文番号だけだった。ダッシュボードで
// 「いつ何を出すのか」を見せるために、payload から必要な値を取り出す。
//
// 出荷予定日そのものは payload に無い（通常注文が持つのはお届け希望日）。
// 業務ルールに沿った算出は @line-crm/shared の shipping-schedule に閉じてあり、
// ここでは呼ぶだけ。将来ロジックを差し替えるときも、この箇所は変わらない。
// 算出結果はDBに保存せず、都度計算する。

/** 出荷予定として扱うイベント。発送済み・解約などは対象外。 */
const SHIPMENT_EVENT_TYPES = ['ec.order.confirmed', 'ec.subscription.upcoming'] as const;

type ShipmentRow = {
  id: string;
  event_type: string;
  friend_id: string | null;
  friend_name: string | null;
  received_at: string;
  order_number: string | null;
  occurred_at: string | null;
  scheduled_shipping_date: string | null;
  order_items: string | null;
  subscription_items: string | null;
};

/** payload の items 配列（JSON文字列）を「商品名 × 数量」の一行にする。 */
function summarizeItems(raw: string | null): { text: string; count: number; quantity: number } {
  if (!raw) return { text: '', count: 0, quantity: 0 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { text: '', count: 0, quantity: 0 };
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return { text: '', count: 0, quantity: 0 };
  const items = parsed
    .filter((item): item is { name?: unknown; quantity?: unknown } => typeof item === 'object' && item !== null)
    .map((item) => ({
      name: typeof item.name === 'string' ? item.name.slice(0, 80) : '',
      quantity: typeof item.quantity === 'number' && Number.isFinite(item.quantity) ? item.quantity : null,
    }))
    .filter((item) => item.name);
  if (items.length === 0) return { text: '', count: 0, quantity: 0 };
  const head = items.slice(0, 2).map((item) => (item.quantity === null ? item.name : `${item.name} × ${item.quantity}`));
  const text = items.length > head.length ? `${head.join('、')} ほか${items.length - head.length}点` : head.join('、');
  return { text, count: items.length, quantity: items.reduce((sum, item) => sum + (item.quantity ?? 0), 0) };
}

ecCommerce.get('/api/ec-commerce/shipments', requireRole('owner', 'admin', 'staff'), async (c) => {
  const limit = parseOffsetPaging({ limit: c.req.query('limit') || undefined }, { defaultLimit: 20, limitPolicy: { fallback: 'integer', minimum: 1, maximum: 100 } }).limit;

  // 出荷予定日は計算値なのでSQLでは並べ替えられない。直近のイベントを多めに
  // 取り出してから、算出した日付で並べ替えて limit で切る。
  // 走査の下限は200件。上部カードの「今日の件数」はこの走査範囲から数えるので、
  // 明細の表示件数（limit）に引っ張られて過少に数えない（DASH-22）。
  const scanLimit = Math.min(Math.max(limit * 5, 200), 500);
  const scope = await getVisibleLineAccountScope(c.env.DB, c.get('staff'));
  /*
   * ダッシュボードの「出荷予定」は選択中アカウントの件数と一致させるため、
   * account_id / lineAccountId で1アカウントへ絞れる。未指定は従来どおり
   * 可視範囲すべて（全アカウント）。権限外の指定は0件にせず403にする
   * （数えられないものを0件として返さない）。
   */
  const requestedAccountId = (
    c.req.query('account_id') ?? c.req.query('lineAccountId')
  )?.trim();
  if (requestedAccountId && !scope.allowedAccountIds.includes(requestedAccountId)) {
    return c.json({ success: false, error: 'このLINEアカウントを表示する権限がありません' }, 403);
  }
  const accountWhere = requestedAccountId
    ? 'AND f.line_account_id = ?'
    : scope.allowedAccountIds.length
      ? `AND (f.line_account_id IN (${sqlIdSet(scope.allowedAccountIds).sql})${scope.canSeeUnassigned ? ' OR f.line_account_id IS NULL' : ''})`
      : scope.canSeeUnassigned
        ? 'AND f.line_account_id IS NULL'
        : 'AND 1 = 0';
  const accountBinds = requestedAccountId ? [requestedAccountId] : scope.allowedAccountIds.length ? sqlIdSet(scope.allowedAccountIds).binds : [];
  const placeholders = SHIPMENT_EVENT_TYPES.map(() => '?').join(', ');
  const rows = await c.env.DB.prepare(
    `SELECT e.id, e.event_type, e.friend_id, e.received_at,
            f.display_name AS friend_name,
            json_extract(e.payload, '$.order.number') AS order_number,
            json_extract(e.payload, '$.occurred_at') AS occurred_at,
            json_extract(e.payload, '$.subscription.scheduled_shipping_date') AS scheduled_shipping_date,
            json_extract(e.payload, '$.order.items') AS order_items,
            json_extract(e.payload, '$.subscription.items') AS subscription_items
       FROM ec_events e
       LEFT JOIN friends f ON f.id = e.friend_id
      WHERE e.event_type IN (${placeholders})
        AND e.status != 'failed'
        ${accountWhere}
      ORDER BY e.received_at DESC
      LIMIT ?`,
  )
    .bind(...SHIPMENT_EVENT_TYPES, ...accountBinds, scanLimit)
    .all<ShipmentRow>();

  const todayJst = toJstMoment(new Date().toISOString())?.date ?? '';
  const tomorrowJst = todayJst ? addDays(todayJst, 1) : '';

  const shipments = rows.results
    .map((row) => {
      const { date, source } = resolveShipDate({
        scheduledShippingDate: row.scheduled_shipping_date,
        // occurred_at が欠けている払い出しもありうるので、受信時刻で代替する。
        orderedAt: row.occurred_at || row.received_at,
      });
      // 型定義上は定期便の商品は subscription.items。実データで order が
      // 入っている可能性があるため、型どおりを優先しつつ order へ落とす。
      const items = summarizeItems(row.subscription_items) ;
      const fallback = items.count > 0 ? items : summarizeItems(row.order_items);
      return {
        id: row.id,
        eventType: row.event_type,
        eventLabel: ecEventLabel(row.event_type, row.event_type),
        orderNumber: row.order_number,
        friendId: row.friend_id,
        friendName: row.friend_name,
        items: fallback.text,
        itemCount: fallback.count,
        quantity: fallback.quantity,
        shipDate: date,
        shipDateSource: source,
        // 今日・明日とそれ以降で分けるための印。日付の比較は文字列で足りる。
        bucket: date && todayJst && date >= todayJst && date <= tomorrowJst
          ? ('soon' as const)
          : ('later' as const),
      };
    })
    // 過去の注文は「出荷予定」ではない。以前は上限だけを見ていたため、
    // 何週間も前の注文まで「今日・明日」に入り続けていた。
    .filter((row) => row.shipDate !== null && (!todayJst || row.shipDate >= todayJst))
    .sort((a, b) => (a.shipDate ?? '').localeCompare(b.shipDate ?? ''));

  const soon = shipments.filter((row) => row.bucket === 'soon');
  const later = shipments.filter((row) => row.bucket === 'later');

  return c.json({
    success: true,
    data: {
      today: todayJst,
      tomorrow: tomorrowJst,
      soon: soon.slice(0, limit),
      later: later.slice(0, limit),
      // 件数は明細の limit とは別に、走査した全件から数える（DASH-22）。
      // 上部カードが soon.slice(0, limit) の先頭だけを数えると、
      // 今日の出荷が limit 件を超えたとき過少表示になる。
      todayCount: shipments.filter((row) => row.shipDate === todayJst).length,
      soonCount: soon.length,
      laterCount: later.length,
      // 走査した件数を返す。上限に張り付いていたら取りこぼしがありうる。
      scanned: rows.results.length,
      scanLimit,
    },
  });
});

export { ecCommerce };
