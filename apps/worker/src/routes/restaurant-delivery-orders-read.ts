import { orderFor } from './restaurant-delivery-common.js';
import type { DeliveryOrderRow } from './restaurant-delivery-types.js';
import type { Hono } from 'hono';

import type { Env } from '../worker-env.js';
import { requireRole } from '../middleware/role-guard.js';

import { dbFor } from '../services/db-router.js';
import { fail } from './restaurant-google.js';

import { DELIVERY_SERVICE_LABELS, deliverySendEnabled, deliveryTargetFingerprint, isDeliveryService, judgeUrgency, nowSec, summarizeOrderItems, tokyoDateText, tokyoDayRange, uberOAuthClient } from '../services/restaurant-delivery.js';
import type { DeliveryOrderStatus } from '../services/restaurant-delivery.js';
import type { DeliveryService } from '../services/delivery-service-types.js';
import { ORDER_STATUS_LABELS, isoOrNull, deliveryStore, serviceStates, resumeExpiredIntake, cookingCountFor, itemsForOrders } from './restaurant-delivery-common.js';

export function registerDeliveryOrderReads(restaurantDelivery: Hono<Env>): void {
  // ---------- D-1 `kDQHr` 受注一覧 ----------

  /**
   * 承認済みデザイン D-1 のタブは「新着」「調理中」「受け渡し済み」「すべて」の4つ。
   *
   * 「新着」「調理中」はまだ手が離れていない注文なので、日付で切らずに全部出す。
   * 日をまたいだ注文を画面から消すと、店が気づけないまま残ってしまう。
   * 「受け渡し済み」「すべて」は本日（日本時間）を数える。過去の分はD-4で見る。
   */
  type OrderTab = 'all' | 'new' | 'cooking' | 'handed_over';

  function orderTabFrom(value: string | undefined): OrderTab {
    if (value === 'new' || value === 'cooking' || value === 'handed_over' || value === 'all') {
      return value;
    }
    return 'all';
  }

  /** 1日ぶんの件数と金額をサービス・状態ごとに数えるSQL。本日と前日で同じものを使う。 */
  const DAY_SUMMARY_SQL = `SELECT service,
          status,
          COUNT(*) AS count,
          COALESCE(SUM(total_amount), 0) AS amount
     FROM rt_delivery_orders
    WHERE store_id = ? AND received_at >= ? AND received_at < ?
    GROUP BY service, status`;

  /**
   * 平均準備時間。受け付けてから準備完了（または受け渡し）までの秒数。
   * どちらかの時刻が無い注文は平均に入れない（0分として混ぜると実態より短く出る）。
   */
  const PREP_SECONDS_SQL = `SELECT AVG(COALESCE(ready_at, handed_over_at) - accepted_at) AS seconds
     FROM rt_delivery_orders
    WHERE store_id = ? AND received_at >= ? AND received_at < ?
      AND accepted_at IS NOT NULL
      AND COALESCE(ready_at, handed_over_at) IS NOT NULL`;

  interface DaySummaryRow {
    service: DeliveryService;
    status: DeliveryOrderStatus;
    count: number;
    amount: number;
  }

  interface DaySummary {
    /** 売上に数える注文の件数（キャンセル・拒否を除く）。 */
    count: number;
    amount: number;
    handedOverCount: number;
    /** キャンセル・拒否の件数。件数・売上には混ぜず、「すべて」の数だけに足す。 */
    canceledCount: number;
    byService: Map<DeliveryService, { count: number; amount: number }>;
  }

  function summarizeDay(rows: DaySummaryRow[] | undefined): DaySummary {
    const summary: DaySummary = {
      count: 0,
      amount: 0,
      handedOverCount: 0,
      canceledCount: 0,
      byService: new Map(),
    };
    for (const row of rows ?? []) {
      if (row.status === 'canceled' || row.status === 'rejected') {
        summary.canceledCount += row.count;
        continue;
      }
      summary.count += row.count;
      summary.amount += row.amount;
      if (row.status === 'handed_over') {
        summary.handedOverCount += row.count;
      }
      const current = summary.byService.get(row.service) ?? { count: 0, amount: 0 };
      current.count += row.count;
      current.amount += row.amount;
      summary.byService.set(row.service, current);
    }
    return summary;
  }

  /** 平均の秒を分にする。平均が取れないときは数を作らず null（画面は「—」にする）。 */
  function averageMinutes(seconds: number | null | undefined): number | null {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return null;
    return Math.max(0, Math.round(seconds / 60));
  }

  /** 前日比の割合。前日が0件のときは割合にならないので null を返す。 */
  function percentDelta(today: number, previous: number): number | null {
    if (previous <= 0) return null;
    return Math.round(((today - previous) / previous) * 100);
  }

  restaurantDelivery.get(
    '/api/restaurant-test/delivery/orders',
    requireRole('owner', 'admin', 'staff'),
    async (c) => {
      const store = await deliveryStore(c);
      if (!store) return fail(c, 404, 'このLINEアカウントに店舗が紐付いていません');
      const now = nowSec();
      const today = tokyoDayRange(null, now);
      const db = dbFor(c.env, store.id);
      const tab = orderTabFrom(c.req.query('tab'));
      const serviceFilter = c.req.query('service');
      if (serviceFilter && !isDeliveryService(serviceFilter)) {
        return fail(c, 400, '対象のサービスが選べていません');
      }

      // 前日と比べるために、同じ数え方で前日ぶんも取る（D-1のKPIの札）。
      const yesterday = tokyoDayRange(tokyoDateText(now - 24 * 60 * 60), now);

      const [
        loadedStates,
        cookingCount,
        openCountRows,
        todayRows,
        yesterdayRows,
        todayPrep,
        yesterdayPrep,
        openRows,
      ] = await Promise.all([
        serviceStates(c, store),
        cookingCountFor(c, store),
        // まだ手が離れていない注文の数。日付では切らない。
        db
          .prepare(
            `SELECT status, COUNT(*) AS count FROM rt_delivery_orders
            WHERE store_id = ? AND status IN ('new','cooking','ready')
            GROUP BY status`,
          )
          .bind(store.id)
          .all<{ status: DeliveryOrderStatus; count: number }>(),
        db.prepare(DAY_SUMMARY_SQL).bind(store.id, today.from, today.to).all<DaySummaryRow>(),
        db
          .prepare(DAY_SUMMARY_SQL)
          .bind(store.id, yesterday.from, yesterday.to)
          .all<DaySummaryRow>(),
        db
          .prepare(PREP_SECONDS_SQL)
          .bind(store.id, today.from, today.to)
          .first<{ seconds: number | null }>(),
        db
          .prepare(PREP_SECONDS_SQL)
          .bind(store.id, yesterday.from, yesterday.to)
          .first<{ seconds: number | null }>(),
        // 急ぎ対応の件数を数えるための軽い読み取り。判定はWorker側だけで行う。
        db
          .prepare(
            `SELECT id, status, received_at, wanted_at, item_count FROM rt_delivery_orders
            WHERE store_id = ? AND status IN ('new','cooking')`,
          )
          .bind(store.id)
          .all<
            Pick<DeliveryOrderRow, 'id' | 'status' | 'received_at' | 'wanted_at' | 'item_count'>
          >(),
      ]);

      // 停止の期限が過ぎていたら、一覧を読んだこの時点で受付中へ戻す（D-6の約束）。
      const states = await resumeExpiredIntake(c, store, loadedStates, now);

      const todaySummary = summarizeDay(todayRows.results);
      const yesterdaySummary = summarizeDay(yesterdayRows.results);

      const tabCounts = { all: 0, new: 0, cooking: 0, handed_over: 0 };
      for (const row of openCountRows.results ?? []) {
        if (row.status === 'new') tabCounts.new = row.count;
        if (row.status === 'cooking' || row.status === 'ready') {
          tabCounts.cooking += row.count;
        }
      }
      tabCounts.handed_over = todaySummary.handedOverCount;
      // 「すべて」は本日の注文と、まだ手が離れていない注文の合計。
      tabCounts.all =
        tabCounts.new + tabCounts.cooking + tabCounts.handed_over + todaySummary.canceledCount;

      const urgentCount = (openRows.results ?? []).filter(
        (row) =>
          judgeUrgency({
            status: row.status,
            receivedAt: row.received_at,
            wantedAt: row.wanted_at,
            itemCount: row.item_count,
            cookingCount,
            now,
          }).urgency === 'urgent',
      ).length;

      const todayPrepMinutes = averageMinutes(todayPrep?.seconds);
      const yesterdayPrepMinutes = averageMinutes(yesterdayPrep?.seconds);

      const bindings: unknown[] = [store.id];
      let tabClause: string;
      if (tab === 'new') {
        tabClause = "status = 'new'";
      } else if (tab === 'cooking') {
        tabClause = "status IN ('cooking','ready')";
      } else if (tab === 'handed_over') {
        tabClause = "status = 'handed_over' AND received_at >= ? AND received_at < ?";
        bindings.push(today.from, today.to);
      } else {
        tabClause = "(status IN ('new','cooking','ready') OR (received_at >= ? AND received_at < ?))";
        bindings.push(today.from, today.to);
      }
      let serviceClause = '';
      if (serviceFilter) {
        serviceClause = ' AND service = ?';
        bindings.push(serviceFilter);
      }
      // 承認済みデザインの並びは新しい注文が上。急ぎは「急ぎ度」の列で見せる。
      const orderRows = await db
        .prepare(
          `SELECT * FROM rt_delivery_orders
          WHERE store_id = ? AND (${tabClause})${serviceClause}
          ORDER BY received_at DESC
          LIMIT 200`,
        )
        .bind(...bindings)
        .all<DeliveryOrderRow>();
      const orders = orderRows.results ?? [];
      const items = await itemsForOrders(
        c,
        store,
        orders.map((row) => row.id),
      );

      return c.json({
        success: true,
        store: { id: store.id, name: store.name },
        // D-1上段のサービスカード。接続と受付の状況、本日の件数を出す。
        services: await Promise.all(states.map(async (state) => ({
          service: state.service,
          label: DELIVERY_SERVICE_LABELS[state.service],
          connectionStatus: state.connection_status,
          version: state.version,
          target: await deliveryTargetFingerprint(c.env, state.service),
          ...(state.service === 'ubereats' ? {
            orderActionsEnabled: state.connection_status === 'connected'
              && deliverySendEnabled(c.env) && uberOAuthClient(c.env) !== null
              && Boolean(c.env.LINE_CREDENTIAL_ENCRYPTION_KEY?.trim()),
          } : {}),
          intakeStatus: state.intake_status,
          stopUntil: isoOrNull(state.stop_until),
          todayCount: todaySummary.byService.get(state.service)?.count ?? 0,
          todayAmount: todaySummary.byService.get(state.service)?.amount ?? 0,
        }))),
        /**
         * D-1のKPI4枚。「本日の注文」「本日の売上」「急ぎ対応」「平均準備時間」。
         * 前日と比べられないとき（前日が0件、平均が取れない）は数を作らず null を返し、
         * 画面側で「—」にする。
         */
        kpis: {
          todayCount: todaySummary.count,
          todayCountDelta: todaySummary.count - yesterdaySummary.count,
          handedOverCount: todaySummary.handedOverCount,
          todaySales: todaySummary.amount,
          todaySalesDeltaPercent: percentDelta(todaySummary.amount, yesterdaySummary.amount),
          averageAmount:
            todaySummary.count > 0 ? Math.round(todaySummary.amount / todaySummary.count) : null,
          urgentCount,
          averagePrepMinutes: todayPrepMinutes,
          averagePrepMinutesDelta:
            todayPrepMinutes === null || yesterdayPrepMinutes === null
              ? null
              : todayPrepMinutes - yesterdayPrepMinutes,
        },
        tab,
        tabCounts,
        orders: orders.map((row) => {
          const urgency = judgeUrgency({
            status: row.status,
            receivedAt: row.received_at,
            wantedAt: row.wanted_at,
            itemCount: row.item_count,
            cookingCount,
            now,
          });
          return {
            id: row.id,
            version: row.version,
            service: row.service,
            serviceLabel: DELIVERY_SERVICE_LABELS[row.service],
            orderNumber: row.order_number,
            status: row.status,
            statusLabel: ORDER_STATUS_LABELS[row.status],
            totalAmount: row.total_amount,
            itemCount: row.item_count,
            itemSummary: summarizeOrderItems(items.get(row.id) ?? []),
            urgency: urgency.urgency,
            urgencyReason: urgency.reason,
            receivedAt: isoOrNull(row.received_at),
            wantedAt: isoOrNull(row.wanted_at),
          };
        }),
      });
    },
  );

  // ---------- D-2 `hjdqV` 受注詳細 ----------

  restaurantDelivery.get(
    '/api/restaurant-test/delivery/orders/:id',
    requireRole('owner', 'admin', 'staff'),
    async (c) => {
      const store = await deliveryStore(c);
      if (!store) return fail(c, 404, 'このLINEアカウントに店舗が紐付いていません');
      const order = await orderFor(c, store, c.req.param('id'));
      if (!order) return fail(c, 404, 'この注文は見つかりません');
      const now = nowSec();
      const [items, cookingCount] = await Promise.all([
        itemsForOrders(c, store, [order.id]),
        cookingCountFor(c, store),
      ]);
      // 急ぎ度は読み出しのたびに判定し直す。画面には結果と理由の文だけを出す。
      const urgency = judgeUrgency({
        status: order.status,
        receivedAt: order.received_at,
        wantedAt: order.wanted_at,
        itemCount: order.item_count,
        cookingCount,
        now,
      });
      return c.json({
        success: true,
        order: {
          id: order.id,
          version: order.version,
          service: order.service,
          serviceLabel: DELIVERY_SERVICE_LABELS[order.service],
          orderNumber: order.order_number,
          status: order.status,
          statusLabel: ORDER_STATUS_LABELS[order.status],
          totalAmount: order.total_amount,
          currency: order.currency,
          itemCount: order.item_count,
          urgency: urgency.urgency,
          urgencyReason: urgency.reason,
          // 受け取り情報。
          pickupMethod: order.pickup_method,
          wantedAt: isoOrNull(order.wanted_at),
          customerNote: order.customer_note,
          cancelReasonCode: order.cancel_reason_code,
          canceledBy: order.canceled_by,
          receivedAt: isoOrNull(order.received_at),
          acceptedAt: isoOrNull(order.accepted_at),
          readyAt: isoOrNull(order.ready_at),
          handedOverAt: isoOrNull(order.handed_over_at),
          canceledAt: isoOrNull(order.canceled_at),
        },
        items: (items.get(order.id) ?? []).map((item) => ({
          name: item.name,
          note: item.note,
          quantity: item.quantity,
          amount: item.amount,
        })),
      });
    },
  );

}
