import { orderFor } from './restaurant-delivery-common.js';
import type { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../worker-env.js';
import { requireIrreversibleConfirmation, requireRole } from '../middleware/role-guard.js';
import { auditLog } from '../lib/audit-log.js';
import type { AuditAction } from '../lib/audit-log.js';
import { dbFor } from '../services/db-router.js';
import { advanceUberOrderLocally, runUberOrderMutation } from '../features/uber-delivery/index.js';
import { fail } from './restaurant-google.js';

import { canTransitionOrder, nowSec } from '../services/restaurant-delivery.js';
import type { DeliveryAction, DeliveryOrderStatus } from '../services/restaurant-delivery.js';
import { CANCEL_CONFIRM_TOKEN, ORDER_STATUS_LABELS, isoOrNull, deliveryStore, sendWithLedger, dispatchFailure } from './restaurant-delivery-common.js';

export function registerDeliveryOrderActions(restaurantDelivery: Hono<Env>): void {
  // ---------- D-2/D-3 注文の操作（受注→調理中→準備完了→受け渡し済み／拒否／キャンセル） ----------

  /** D-3のキャンセル理由。自由文は各サービスへ送らず、分類済みの符号だけを扱う。 */
  const CANCEL_REASON_CODES = [
    'out_of_stock',
    'store_busy',
    'equipment_trouble',
    'customer_request',
    'other',
  ] as const;
  type CancelReasonCode = (typeof CANCEL_REASON_CODES)[number];

  function isCancelReasonCode(value: unknown): value is CancelReasonCode {
    return typeof value === 'string' && (CANCEL_REASON_CODES as readonly string[]).includes(value);
  }

  /**
   * 注文の状態を1つ進める共通処理。
   *
   * 外部操作は「台帳へ記録 → サービスへ送信 → 成功した時だけD1を進める」。
   * 現在のUber Restaurant連携契約では、準備完了・受け渡し済みを競合を塞いで店舗内の進行として記録する。
   */
  async function runOrderMutation(
    c: Context<Env>,
    input: {
      to: DeliveryOrderStatus;
      action: DeliveryAction;
      audit: AuditAction;
      timeColumn: 'accepted_at' | 'ready_at' | 'handed_over_at' | 'canceled_at' | null;
      cancel?: { reasonCode: CancelReasonCode; canceledBy: 'store' };
    },
  ) {
    const store = await deliveryStore(c);
    if (!store) return fail(c, 404, 'このLINEアカウントに店舗が紐付いていません');
    const body = await c.req.json<{ expectedVersion?: unknown }>().catch(() => ({} as { expectedVersion?: unknown }));
    if (body.expectedVersion !== undefined && (!Number.isSafeInteger(body.expectedVersion) || Number(body.expectedVersion) < 1)) return fail(c, 400, '注文の版を確認してください');
    const orderId = c.req.param('id');
    const order = orderId ? await orderFor(c, store, orderId) : null;
    if (!order) return fail(c, 404, 'この注文は見つかりません');
    const target = { id: order.id, kind: 'rt_delivery_order' };
    if (body.expectedVersion !== undefined && body.expectedVersion !== order.version) return fail(c, 409, '注文が変わりました。画面を開き直してください', { code: 'STALE_ORDER', order: { id: order.id, status: order.status, version: order.version } });
    if (!canTransitionOrder(order.status, input.to)) {
      auditLog(c, input.audit, target, { result: 'denied', lineAccountId: order.account_id });
      return fail(
        c,
        409,
        `この注文は${ORDER_STATUS_LABELS[order.status]}のため、この操作はできません`,
        { code: 'INVALID_STATUS', status: order.status },
      );
    }

    const now = nowSec();
    const localUberProgress = order.service === 'ubereats'
      && (input.action === 'ready' || input.action === 'handed_over');
    const result = localUberProgress ? await advanceUberOrderLocally({
      db: dbFor(c.env, store.id),
      env: c.env,
      store,
      order,
      to: input.action === 'ready' ? 'ready' : 'handed_over',
      timeColumn: input.action === 'ready' ? 'ready_at' : 'handed_over_at',
      now,
    }) : order.service === 'ubereats' ? await runUberOrderMutation({
      db: dbFor(c.env, store.id),
      env: c.env,
      store,
      order,
      action: input.action,
      to: input.to,
      timeColumn: input.timeColumn,
      reasonCode: input.cancel?.reasonCode,
      now,
    }) : await sendWithLedger(c, store, {
      service: order.service,
      action: input.action,
      targetKind: 'order',
      targetId: order.id,
      externalId: order.external_order_id,
      expectedOrderVersion: body.expectedVersion === undefined ? undefined : order.version,
      body: input.cancel ? { reason_code: input.cancel.reasonCode } : undefined,
      now,
    });
    if (!result.ok) {
      auditLog(c, input.audit, target, { result: 'failed', lineAccountId: order.account_id });
      if (body.expectedVersion !== undefined && result.error.code === 'delivery_order_conflict') {
        const latest = await orderFor(c, store, order.id);
        return fail(c, 409, '注文が変わりました。画面を開き直してください', { code: 'STALE_ORDER', order: latest ? { id: latest.id, status: latest.status, version: latest.version } : null });
      }
      return dispatchFailure(c, result);
    }

    // Uber は専用経路で注文の更新と送信台帳の確定を同じトランザクションに含める。
    if (order.service !== 'ubereats') {
      const sets = ['status = ?', 'updated_at = ?', 'version = version + 1'];
      const binds: unknown[] = [input.to, now];
      if (input.timeColumn) {
        sets.push(`${input.timeColumn} = ?`);
        binds.push(now);
      }
      if (input.cancel) {
        sets.push('cancel_reason_code = ?', 'canceled_by = ?');
        binds.push(input.cancel.reasonCode, input.cancel.canceledBy);
      }
      // 版と元の状態で絞る。同じ注文を2つの端末から進めた時は先の操作だけを通す。
      const updated = await dbFor(c.env, store.id)
        .prepare(
          `UPDATE rt_delivery_orders SET ${sets.join(', ')}
          WHERE id = ? AND store_id = ? AND status = ? AND version = ?`,
        )
        .bind(...binds, order.id, store.id, order.status, order.version)
        .run();
      if ((updated.meta?.changes ?? 0) === 0) {
        return fail(c, 409, 'ほかの端末がこの注文を進めました。画面を開き直してください', {
          code: 'STALE_ORDER',
        });
      }
    }

    auditLog(c, input.audit, target, { lineAccountId: order.account_id });
    return c.json({
      success: true,
      ...(localUberProgress ? { synchronization: 'local' as const } : {}),
      order: {
        id: order.id,
        status: input.to,
        statusLabel: ORDER_STATUS_LABELS[input.to],
        updatedAt: isoOrNull(now),
      },
    });
  }

  restaurantDelivery.post(
    '/api/restaurant-test/delivery/orders/:id/accept',
    // 書き込みは店舗管理者以上だけ。担当者には画面にも出さない（BEHAVIOR.mdの「閲覧のみ」）。
    requireRole('owner', 'admin'),
    async (c) =>
      runOrderMutation(c, {
        to: 'cooking',
        action: 'accept',
        audit: 'restaurant.delivery.order.accept',
        timeColumn: 'accepted_at',
      }),
  );

  restaurantDelivery.post(
    '/api/restaurant-test/delivery/orders/:id/ready',
    requireRole('owner', 'admin'),
    async (c) =>
      runOrderMutation(c, {
        to: 'ready',
        action: 'ready',
        audit: 'restaurant.delivery.order.ready',
        timeColumn: 'ready_at',
      }),
  );

  restaurantDelivery.post(
    '/api/restaurant-test/delivery/orders/:id/handed-over',
    requireRole('owner', 'admin'),
    async (c) =>
      runOrderMutation(c, {
        to: 'handed_over',
        action: 'handed_over',
        audit: 'restaurant.delivery.order.handed_over',
        timeColumn: 'handed_over_at',
      }),
  );

  // 拒否は注文そのものを断る操作。担当者には出さず、店舗管理者以上だけが押せる。
  restaurantDelivery.post(
    '/api/restaurant-test/delivery/orders/:id/reject',
    requireRole('owner', 'admin'),
    async (c) =>
      runOrderMutation(c, {
        to: 'rejected',
        action: 'reject',
        audit: 'restaurant.delivery.order.reject',
        timeColumn: 'canceled_at',
      }),
  );

  // D-3 `dgeTy` キャンセル。取り消せないため確認手順（428）を必ず通す。
  restaurantDelivery.post(
    '/api/restaurant-test/delivery/orders/:id/cancel',
    requireRole('owner', 'admin'),
    requireIrreversibleConfirmation(CANCEL_CONFIRM_TOKEN),
    async (c) => {
      const body: { reason_code?: unknown } = await c.req
        .json<{ reason_code?: unknown }>()
        .catch(() => ({}));
      const reasonCode = body.reason_code;
      if (!isCancelReasonCode(reasonCode)) {
        return fail(c, 400, 'キャンセルの理由を選んでください', { code: 'REASON_REQUIRED' });
      }
      return runOrderMutation(c, {
        to: 'canceled',
        action: 'cancel',
        audit: 'restaurant.delivery.order.cancel',
        timeColumn: 'canceled_at',
        cancel: { reasonCode, canceledBy: 'store' },
      });
    },
  );
}
