import type { DeliveryMenuItemRow } from './restaurant-delivery-types.js';
import { sqlIdSet } from '@line-crm/db/id-queries';
import type { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../worker-env.js';
import { requireIrreversibleConfirmation, requireRole } from '../middleware/role-guard.js';
import { auditLog } from '../lib/audit-log.js';
import type { AuditAction } from '../lib/audit-log.js';
import { dbFor } from '../services/db-router.js';
import { fail } from './restaurant-google.js';
import type { StoreContext } from './restaurant-google.js';
import { DELIVERY_SERVICES, DELIVERY_SERVICE_LABELS, isDeliveryService, isIntakeStopPreset, deliveryTargetFingerprint, intakeStopUntil, nowSec } from '../services/restaurant-delivery.js';
import type { DeliveryAction, DeliveryDispatchResult } from '../services/restaurant-delivery.js';
import type { DeliveryService } from '../services/delivery-service-types.js';
import { upsertIntake, INTAKE_STOP_CONFIRM_TOKEN, isoOrNull, deliveryStore, sendWithLedger, serviceStates, menuTargetFingerprint } from './restaurant-delivery-common.js';

export function registerDeliveryControls(restaurantDelivery: Hono<Env>): void {
  // ---------- D-5 `h7OeT` 商品と品切れ一括 ----------

  /** サービスごとの商品ID。連携していないサービスへは送らない。 */
  function externalItemIds(row: DeliveryMenuItemRow): Partial<Record<DeliveryService, string>> {
    if (!row.external_item_ids_json) return {};
    try {
      const parsed = JSON.parse(row.external_item_ids_json) as Record<string, unknown>;
      const ids: Partial<Record<DeliveryService, string>> = {};
      for (const service of DELIVERY_SERVICES) {
        const value = parsed[service];
        if (typeof value === 'string' && value.trim()) ids[service] = value.trim();
      }
      return ids;
    } catch {
      // 壊れた記録で画面を止めない。連携なしとして扱う。
      return {};
    }
  }

  async function menuItemsFor(
    c: Context<Env>,
    store: StoreContext,
    ids?: string[],
  ): Promise<DeliveryMenuItemRow[]> {
    const db = dbFor(c.env, store.id);
    if (!ids) {
      const rows = await db
        .prepare(
          `SELECT id, store_id, name, category, price, sold_out, sold_out_at,
                sort_order, external_item_ids_json, version
           FROM rt_delivery_menu_items WHERE store_id = ?
          ORDER BY sort_order, name`,
        )
        .bind(store.id)
        .all<DeliveryMenuItemRow>();
      return rows.results ?? [];
    }
    if (ids.length === 0) return [];
    const placeholders = sqlIdSet(ids).sql;
    const rows = await db
      .prepare(
        `SELECT id, store_id, name, category, price, sold_out, sold_out_at,
              sort_order, external_item_ids_json, version
         FROM rt_delivery_menu_items WHERE store_id = ? AND id IN (${placeholders})
        ORDER BY sort_order, name`,
      )
      .bind(store.id, ...(ids.length ? sqlIdSet(ids).binds : []))
      .all<DeliveryMenuItemRow>();
    return rows.results ?? [];
  }

  restaurantDelivery.get(
    '/api/restaurant-test/delivery/menu-items',
    requireRole('owner', 'admin', 'staff'),
    async (c) => {
      const store = await deliveryStore(c);
      if (!store) return fail(c, 404, 'このLINEアカウントに店舗が紐付いていません');
      const rows = await menuItemsFor(c, store);
      return c.json({
        success: true,
        store: { id: store.id, name: store.name },
        items: await Promise.all(rows.map(async (row) => {
          const ids = externalItemIds(row);
          return {
            id: row.id,
            version: row.version,
            target: await menuTargetFingerprint(c.env, row.external_item_ids_json),
            name: row.name,
            category: row.category,
            price: row.price,
            soldOut: row.sold_out === 1,
            soldOutAt: isoOrNull(row.sold_out_at),
            // 連携済みのサービスだけを画面に出す。未連携の商品は一括操作の対象外。
            services: DELIVERY_SERVICES.filter((service) => ids[service]).map((service) => ({
              service,
              label: DELIVERY_SERVICE_LABELS[service],
            })),
          };
        })),
      });
    },
  );

  /**
   * 品切れ・再開の一括設定。1商品ごとに連携済みサービスへ順に送り、
   * すべて通った商品だけD1を更新する。1つでも失敗した商品は元の状態で残す。
   */
  restaurantDelivery.post(
    '/api/restaurant-test/delivery/menu-items/bulk-sold-out',
    requireRole('owner', 'admin'),
    async (c) => {
      const store = await deliveryStore(c);
      if (!store) return fail(c, 404, 'このLINEアカウントに店舗が紐付いていません');
      const body = await c.req
        .json<{ item_ids?: unknown; sold_out?: unknown; expectedStoreId?: unknown; expectedItems?: unknown }>()
        .catch(() => ({}) as { item_ids?: unknown; sold_out?: unknown; expectedStoreId?: unknown; expectedItems?: unknown });
      const requestedIds = Array.isArray(body.item_ids)
        ? body.item_ids.filter((value): value is string => typeof value === 'string' && !!value.trim())
        : [];
      if (requestedIds.length === 0) return fail(c, 400, '対象の商品を選んでください');
      if (requestedIds.length > 200) return fail(c, 400, '一度に設定できる商品は200件までです');
      if (typeof body.sold_out !== 'boolean') {
        return fail(c, 400, '品切れにするか、再開するかを選んでください');
      }
      const soldOut = body.sold_out;
      const rows = await menuItemsFor(c, store, requestedIds);
      if (rows.length === 0 && body.expectedItems !== undefined) return fail(c, 409, '商品が変わりました。画面を読み直してください', { code: 'STALE_MENU', storeId: store.id, items: [] });
      if (rows.length === 0) return fail(c, 404, '対象の商品が見つかりません');
      let expected: Array<{ id: string; version: number; target: string }> | null = null;
      if (body.expectedItems !== undefined) {
        if (typeof body.expectedStoreId !== 'string' || !Array.isArray(body.expectedItems) || body.expectedItems.length !== requestedIds.length || body.expectedItems.some((item: any) => !item || typeof item.id !== 'string' || !Number.isSafeInteger(item.version) || item.version < 1 || typeof item.target !== 'string')) return fail(c, 400, '確認した商品を読み直してください');
        expected = body.expectedItems as Array<{ id: string; version: number; target: string }>;
        if (new Set(requestedIds).size !== requestedIds.length || new Set(expected.map((item) => item.id)).size !== requestedIds.length || requestedIds.some((id) => !expected?.some((item) => item.id === id))) return fail(c, 400, '確認した商品を読み直してください');
        const current = await Promise.all(rows.map(async (row) => ({ id: row.id, name: row.name, soldOut: row.sold_out === 1, services: DELIVERY_SERVICES.filter((service) => externalItemIds(row)[service]), version: row.version, target: await menuTargetFingerprint(c.env, row.external_item_ids_json) })));
        if (body.expectedStoreId !== store.id || current.length !== expected.length || current.some((entry) => !expected?.some((item) => item.id === entry.id && item.version === entry.version && item.target === entry.target))) return fail(c, 409, '商品が変わりました。画面を読み直してください', { code: 'STALE_MENU', storeId: store.id, items: current });
      }

      const now = nowSec();
      const action: DeliveryAction = soldOut ? 'menu_sold_out' : 'menu_resume';
      const audit: AuditAction = soldOut
        ? 'restaurant.delivery.menu.sold_out'
        : 'restaurant.delivery.menu.resume';
      const updated: string[] = [];
      const failed: Array<{ id: string; name: string; code: string; retryable: boolean }> = [];
      const skipped: Array<{ id: string; name: string }> = [];

      for (const row of rows) {
        const ids = externalItemIds(row);
        const services = DELIVERY_SERVICES.filter((service) => ids[service]);
        if (services.length === 0) {
          skipped.push({ id: row.id, name: row.name });
          continue;
        }
        let firstError: Extract<DeliveryDispatchResult, { ok: false }> | null = null;
        for (const service of services) {
          const result = await sendWithLedger(c, store, {
            service,
            action,
            targetKind: 'menu_item',
            targetId: row.id,
            expectedMenu: expected?.find((item) => item.id === row.id),
            externalId: ids[service] ?? null,
            body: { sold_out: soldOut },
            now,
          });
          if (!result.ok) {
            if (expected && result.error.code === 'delivery_menu_conflict') {
              const latest = await menuItemsFor(c, store, requestedIds);
              const current = await Promise.all(latest.map(async (item) => ({ id: item.id, name: item.name, soldOut: item.sold_out === 1, services: DELIVERY_SERVICES.filter((service) => externalItemIds(item)[service]), version: item.version, target: await menuTargetFingerprint(c.env, item.external_item_ids_json) })));
              return fail(c, 409, '商品が変わりました。一部は反映済みの可能性があります。画面を読み直してください', { code: 'STALE_MENU', storeId: store.id, items: current, updated });
            }
            firstError = result;
            break;
          }
        }
        if (firstError) {
          failed.push({
            id: row.id,
            name: row.name,
            code: firstError.error.code,
            retryable: firstError.error.retryable,
          });
          continue;
        }
        const written = await dbFor(c.env, store.id)
          .prepare(
            `UPDATE rt_delivery_menu_items
              SET sold_out = ?, sold_out_at = ?, version = version + 1, updated_at = ?
            WHERE id = ? AND store_id = ? AND (? IS NULL OR version = ?)`,
          )
          .bind(soldOut ? 1 : 0, soldOut ? now : null, now, row.id, store.id, expected ? row.version : null, expected ? row.version : null)
          .run();
        if (expected && (written.meta?.changes ?? 0) !== 1) {
          const latest = await menuItemsFor(c, store, requestedIds);
          const current = await Promise.all(latest.map(async (item) => ({ id: item.id, name: item.name, soldOut: item.sold_out === 1, services: DELIVERY_SERVICES.filter((service) => externalItemIds(item)[service]), version: item.version, target: await menuTargetFingerprint(c.env, item.external_item_ids_json) })));
          return fail(c, 409, '商品が変わりました。一部は反映済みの可能性があります。画面を読み直してください', { code: 'STALE_MENU', storeId: store.id, items: current, updated });
        }
        updated.push(row.id);
      }

      auditLog(
        c,
        audit,
        { id: store.id, kind: 'rt_store' },
        {
          result: updated.length > 0 ? 'success' : 'failed',
          lineAccountId: store.lineAccountId,
        },
      );
      if (updated.length === 0 && failed.length > 0) {
        const first = failed[0];
        return fail(
          c,
          first.retryable ? 503 : 502,
          '各サービスへ送れませんでした。しばらくしてからもう一度お試しください',
          { code: first.code, retryable: first.retryable, failed, skipped },
        );
      }
      return c.json({ success: true, soldOut, updated, failed, skipped });
    },
  );

  // ---------- D-6 `XCVGd` 受付の一括停止と再開 ----------

  /** 対象サービス。指定が無ければ3サービスすべて。 */
  function targetServices(value: unknown): DeliveryService[] | null {
    if (value === undefined || value === null) return [...DELIVERY_SERVICES];
    if (!Array.isArray(value) || value.length === 0) return null;
    const services: DeliveryService[] = [];
    for (const entry of value) {
      if (!isDeliveryService(entry)) return null;
      if (!services.includes(entry)) services.push(entry);
    }
    return services;
  }

  // 受付を止めると新しい注文が入らなくなる。確認手順（428）を通し、店舗管理者以上だけが押せる。
  restaurantDelivery.post(
    '/api/restaurant-test/delivery/intake/stop',
    requireRole('owner', 'admin'),
    requireIrreversibleConfirmation(INTAKE_STOP_CONFIRM_TOKEN),
    async (c) => {
      const store = await deliveryStore(c);
      if (!store) return fail(c, 404, 'このLINEアカウントに店舗が紐付いていません');
      const body = await c.req
        .json<{ services?: unknown; preset?: unknown; expectedStoreId?: unknown; expectedStates?: unknown }>()
        .catch(() => ({}) as { services?: unknown; preset?: unknown; expectedStoreId?: unknown; expectedStates?: unknown });
      if (!isIntakeStopPreset(body.preset)) {
        return fail(c, 400, '停止する長さを選んでください');
      }
      const services = targetServices(body.services);
      if (!services) return fail(c, 400, '対象のサービスが選べていません');
      let expected: Array<{ service: DeliveryService; version: number; target: string }> | null = null;
      if (body.expectedStates !== undefined) {
        if (typeof body.expectedStoreId !== 'string' || !Array.isArray(body.expectedStates) || body.expectedStates.length !== services.length || body.expectedStates.some((entry: any) => !entry || !isDeliveryService(entry.service) || !Number.isSafeInteger(entry.version) || entry.version < 0 || typeof entry.target !== 'string')) return fail(c, 400, '確認したサービスを読み直してください');
        expected = body.expectedStates as Array<{ service: DeliveryService; version: number; target: string }>;
        if (!expected || new Set(expected.map((entry) => entry.service)).size !== services.length || services.some((service) => !expected?.some((entry) => entry.service === service))) return fail(c, 400, '確認したサービスを読み直してください');
        const states = await serviceStates(c, store);
        const current = await Promise.all(services.map(async (service) => ({ service, version: states.find((state) => state.service === service)?.version ?? 0, intakeStatus: states.find((state) => state.service === service)?.intake_status ?? 'open', connectionStatus: states.find((state) => state.service === service)?.connection_status ?? 'disconnected', target: await deliveryTargetFingerprint(c.env, service) })));
        if (body.expectedStoreId !== store.id || current.some((entry) => !expected?.some((item) => item.service === entry.service && item.version === entry.version && item.target === entry.target))) return fail(c, 409, '対象の状態が変わりました。画面を読み直してください', { code: 'STALE_INTAKE', storeId: store.id, states: current });
      }

      const now = nowSec();
      const stopUntil = intakeStopUntil(body.preset, now);
      const stopped: DeliveryService[] = [];
      const failed: Array<{ service: DeliveryService; code: string; retryable: boolean }> = [];
      for (const service of services) {
        const result = await sendWithLedger(c, store, {
          service,
          action: 'intake_stop',
          targetKind: 'service',
          targetId: service,
          expectedIntake: expected?.find((entry) => entry.service === service),
          body: { stop_until: stopUntil },
          now,
        });
        if (!result.ok) {
          if (expected && result.error.code === 'delivery_intake_conflict') {
            const states = await serviceStates(c, store);
            const current = await Promise.all(services.map(async (item) => ({ service: item, version: states.find((state) => state.service === item)?.version ?? 0, intakeStatus: states.find((state) => state.service === item)?.intake_status ?? 'open', connectionStatus: states.find((state) => state.service === item)?.connection_status ?? 'disconnected', target: await deliveryTargetFingerprint(c.env, item) })));
            return fail(c, 409, '対象の状態が変わりました。一部は停止済みの可能性があります。画面を読み直してください', { code: 'STALE_INTAKE', storeId: store.id, states: current, stopped });
          }
          failed.push({
            service,
            code: result.error.code,
            retryable: result.error.retryable,
          });
          continue;
        }
        const written = await upsertIntake(c, store, service, {
          intake: 'stopped',
          stopUntil,
          requestedBy: c.get('staff')?.id ?? 'unknown',
          now,
          expectedVersion: expected?.find((entry) => entry.service === service)?.version,
        });
        if (expected && written !== true) {
          const states = await serviceStates(c, store);
          const current = await Promise.all(services.map(async (item) => ({ service: item, version: states.find((state) => state.service === item)?.version ?? 0, intakeStatus: states.find((state) => state.service === item)?.intake_status ?? 'open', connectionStatus: states.find((state) => state.service === item)?.connection_status ?? 'disconnected', target: await deliveryTargetFingerprint(c.env, item) })));
          return fail(c, 409, '受付状態が変わりました。一部は停止済みの可能性があります。画面を読み直してください', { code: 'STALE_INTAKE', storeId: store.id, states: current, stopped });
        }
        stopped.push(service);
      }

      auditLog(
        c,
        'restaurant.delivery.intake.stop',
        { id: store.id, kind: 'rt_store' },
        {
          result: stopped.length > 0 ? 'success' : 'failed',
          lineAccountId: store.lineAccountId,
        },
      );
      if (stopped.length === 0) {
        const first = failed[0];
        return fail(
          c,
          first?.retryable ? 503 : 502,
          '各サービスへ送れませんでした。しばらくしてからもう一度お試しください',
          { code: first?.code ?? 'delivery_send_failed', retryable: first?.retryable ?? false, failed },
        );
      }
      return c.json({
        success: true,
        preset: body.preset,
        stopUntil: isoOrNull(stopUntil),
        stopped,
        failed,
      });
    },
  );

  restaurantDelivery.post(
    '/api/restaurant-test/delivery/intake/resume',
    requireRole('owner', 'admin'),
    async (c) => {
      const store = await deliveryStore(c);
      if (!store) return fail(c, 404, 'このLINEアカウントに店舗が紐付いていません');
      const body = await c.req
        .json<{ services?: unknown }>()
        .catch(() => ({}) as { services?: unknown });
      const services = targetServices(body.services);
      if (!services) return fail(c, 400, '対象のサービスが選べていません');

      const now = nowSec();
      const resumed: DeliveryService[] = [];
      const failed: Array<{ service: DeliveryService; code: string; retryable: boolean }> = [];
      for (const service of services) {
        const result = await sendWithLedger(c, store, {
          service,
          action: 'intake_resume',
          targetKind: 'service',
          targetId: service,
          now,
        });
        if (!result.ok) {
          failed.push({
            service,
            code: result.error.code,
            retryable: result.error.retryable,
          });
          continue;
        }
        await upsertIntake(c, store, service, { intake: 'open', now });
        resumed.push(service);
      }

      auditLog(
        c,
        'restaurant.delivery.intake.resume',
        { id: store.id, kind: 'rt_store' },
        {
          result: resumed.length > 0 ? 'success' : 'failed',
          lineAccountId: store.lineAccountId,
        },
      );
      if (resumed.length === 0) {
        const first = failed[0];
        return fail(
          c,
          first?.retryable ? 503 : 502,
          '各サービスへ送れませんでした。しばらくしてからもう一度お試しください',
          { code: first?.code ?? 'delivery_send_failed', retryable: first?.retryable ?? false, failed },
        );
      }
      return c.json({ success: true, resumed, failed });
    },
  );
}
