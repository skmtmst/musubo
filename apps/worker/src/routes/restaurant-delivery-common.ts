import type { DeliveryOrderRow, DeliveryOrderItemRow, DeliveryServiceStateRow } from './restaurant-delivery-types.js';
import { sqlIdSet } from '@line-crm/db/id-queries';
import type { Context, MiddlewareHandler } from 'hono';
import type { Env } from '../worker-env.js';
import { auditLog } from '../lib/audit-log.js';
import { restaurantTestEnabled } from '../lib/environment-features.js';
import { getVisibleLineAccountScope } from '../services/account-access.js';
import { dbFor } from '../services/db-router.js';
import { tenantHasFeaturePack } from '../services/tenant-features.js';
import { accountId, fail, staffTenantId, storeFor } from './restaurant-google.js';
import type { StoreContext } from './restaurant-google.js';
import { DELIVERY_SERVICES, dispatchToDeliveryService, deliveryTargetFingerprint } from '../services/restaurant-delivery.js';
import type { DeliveryAction, DeliveryDispatchResult, DeliveryOrderStatus } from '../services/restaurant-delivery.js';
import type { DeliveryService } from '../services/delivery-service-types.js';

/** 署名で守る外部受信の入口。管理画面の認証・統括ゲートは通さない。 */
export const WEBHOOK_PREFIX = '/api/restaurant-test/delivery/webhooks/';

/** 取り消せない操作の確認合言葉（画面の確認手順を経た印）。 */
export const CANCEL_CONFIRM_TOKEN = 'delivery-order-cancel';
export const INTAKE_STOP_CONFIRM_TOKEN = 'delivery-intake-stop';

/** CSVの返す上限。超えた分は打ち切りヘッダで知らせる。 */
export const CSV_MAX_ROWS = 5000;

// ---------- 画面へ返す共通の形 ----------

/**
 * CSVの1マス。`=`『+』『-』『@』始まりは表計算の式として実行されるため、
 * 先頭に `'` を付けて式にしない（automations.ts と同じ守り方）。
 */
export function csvCell(value: string | number | null | undefined): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

/**
 * 画面に出す状態の名前。英語の符号は出さない。
 *
 * `ready` は商品の準備が終わり、まだ受け渡しを待っている状態。
 * `handed_over` と同じ名前にすると、未完了の注文を見落とすため別の名前で見せる。
 */
export const ORDER_STATUS_LABELS: Record<DeliveryOrderStatus, string> = {
  new: '新着',
  cooking: '調理中',
  ready: '準備完了',
  handed_over: '受け渡し済み',
  canceled: 'キャンセル',
  rejected: '拒否',
};

/** 日時はエポック秒で持ち、画面向けにISO文字列へ直す。 */
export function isoOrNull(seconds: number | null | undefined): string | null {
  if (seconds === null || seconds === undefined) return null;
  return new Date(seconds * 1000).toISOString();
}

/**
 * Uber 接続（636 の表）だけは時刻をミリ秒で持つ。書き込み側が `Date.now` のため、
 * 秒を前提にした上の `isoOrNull` と混ぜると1970年になる。読み取り口はこちらを使う。
 */
export function isoFromMs(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined) return null;
  return new Date(ms).toISOString();
}

// ---------- 入口の検査（restaurant-google.ts と同じ3点検査） ----------

export const deliveryAccessGuard: MiddlewareHandler<Env> = async (c, next) => {
  if (!restaurantTestEnabled(c.env)) return fail(c, 404, 'Not found');
  // 署名検証で守る外部受信は管理画面の認証を通さない。
  if (c.req.path.startsWith(WEBHOOK_PREFIX)) return next();
  // 統括ゲート。パック無しは環境無効と同じ404。
  if (!(await tenantHasFeaturePack(dbFor(c.env), staffTenantId(c), 'restaurant'))) {
    return fail(c, 404, 'Not found');
  }
  const requestedTenant = c.req.query('tenant_id');
  if (requestedTenant && requestedTenant !== staffTenantId(c)) {
    return fail(c, 403, 'この統括を操作する権限がありません');
  }
  const selectedAccount = accountId(c);
  if (!selectedAccount) return next();
  const scope = await getVisibleLineAccountScope(dbFor(c.env), c.get('staff'));
  if (!scope.ids.includes(selectedAccount)) {
    return fail(c, 403, 'このLINEアカウントを操作する権限がありません');
  }
  return next();
};

/** 選んだLINEアカウントに紐付く店舗。無ければ404の文を返す。 */
export async function deliveryStore(c: Context<Env>): Promise<StoreContext | null> {
  return storeFor(c);
}

/** 店舗×サービスの状態を、無ければ既定値で埋めて全サービス分そろえる。 */
export async function serviceStates(
  c: Context<Env>,
  store: StoreContext,
): Promise<DeliveryServiceStateRow[]> {
  const rows = await dbFor(c.env, store.id)
    .prepare(
      `SELECT store_id, service, connection_status, intake_status, stop_until,
              stop_requested_at, resumed_at, version
         FROM rt_delivery_service_states WHERE store_id = ?`,
    )
    .bind(store.id)
    .all<DeliveryServiceStateRow>();
  const byService = new Map((rows.results ?? []).map((row) => [row.service, row]));
  const uber = await dbFor(c.env, store.id).prepare(
    `SELECT status, uber_store_id, provisioned_at, last_error,
       (SELECT COUNT(*) FROM rt_delivery_uber_connections other
         WHERE other.uber_store_id = connection.uber_store_id AND other.status = 'connected'
           AND other.provisioned_at IS NOT NULL) AS connected_count
       FROM rt_delivery_uber_connections connection WHERE store_id = ? AND account_id = ?`,
  ).bind(store.id, store.lineAccountId).first<{
    status: string; uber_store_id: string | null; provisioned_at: number | null; last_error: string | null; connected_count: number;
  }>();
  const uberUnresolved = ['pos_activation_started', 'pos_activation_unknown',
    'pos_deactivation_started', 'pos_deactivation_unknown',
    'pos_disconnect_reauthorization_pending',
    'store_provision_review_required', 'store_menu_refresh_review_required'].includes(uber?.last_error ?? '');
  const uberAmbiguous = (uber?.connected_count ?? 0) > 1;
  const uberStatus = uber?.status === 'connected' && uber.uber_store_id && uber.provisioned_at !== null && !uberUnresolved && !uberAmbiguous
    ? 'connected' as const
    : uber?.status === 'expired' || uber?.status === 'no_permission' || uberUnresolved || uberAmbiguous
      ? 'error' as const : 'disconnected' as const;
  const uberState = byService.get('ubereats');
  if (uberState) byService.set('ubereats', { ...uberState, connection_status: uberStatus });
  return DELIVERY_SERVICES.map(
    (service) =>
      byService.get(service) ?? {
        store_id: store.id,
        service,
        connection_status: service === 'ubereats' ? uberStatus : 'disconnected' as const,
        intake_status: 'open' as const,
        stop_until: null,
        stop_requested_at: null,
        resumed_at: null,
        version: 0,
      },
  );
}

/**
 * 期限の過ぎた受付停止を自動で戻す（D-6 `XCVGd` の「過ぎると自動で再開します」）。
 *
 * 時刻起動（cron）は検証環境で使えないため、注文一覧を読むたびに確かめる形にする。
 * 各サービスへ再開を送り、**通ったサービスだけ** D1 を受付中へ戻す。
 * 送れなかったサービスは停止のまま残し、次に読み直した時にもう一度試す。
 */
export async function resumeExpiredIntake(
  c: Context<Env>,
  store: StoreContext,
  states: DeliveryServiceStateRow[],
  now: number,
): Promise<DeliveryServiceStateRow[]> {
  const expired = states.filter(
    (state) =>
      state.intake_status === 'stopped' && state.stop_until !== null && state.stop_until <= now,
  );
  if (expired.length === 0) return states;

  const resumed = new Set<DeliveryService>();
  for (const state of expired) {
    const result = await sendWithLedger(c, store, {
      service: state.service,
      action: 'intake_resume',
      targetKind: 'service',
      targetId: state.service,
      now,
    });
    if (!result.ok) continue;
    await upsertIntake(c, store, state.service, { intake: 'open', now });
    resumed.add(state.service);
  }
  if (resumed.size === 0) return states;

  auditLog(
    c,
    'restaurant.delivery.intake.resume',
    { id: store.id, kind: 'rt_store' },
    { result: 'success', lineAccountId: store.lineAccountId },
  );
  return states.map((state) =>
    resumed.has(state.service)
      ? {
          ...state,
          intake_status: 'open' as const,
          stop_until: null,
          resumed_at: now,
          version: state.version + 1,
        }
      : state,
  );
}

/** 同じ店舗で調理中の件数。急ぎ度の判定に渡す。 */
export async function cookingCountFor(c: Context<Env>, store: StoreContext): Promise<number> {
  const row = await dbFor(c.env, store.id)
    .prepare(
      `SELECT COUNT(*) AS count FROM rt_delivery_orders
        WHERE store_id = ? AND status IN ('new','cooking')`,
    )
    .bind(store.id)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

/**
 * 送信台帳へ1件起こす。送る前に必ず呼び、結果で閉じる。
 * 送信が失敗した時は注文・商品・受付の状態を変えない。
 */
export async function openDispatch(
  c: Context<Env>,
  store: StoreContext,
  input: {
    service: DeliveryService;
    action: DeliveryAction;
    targetKind: 'order' | 'menu_item' | 'service';
    targetId: string | null;
    now: number;
  },
): Promise<string> {
  const id = crypto.randomUUID();
  await dbFor(c.env, store.id)
    .prepare(
      `INSERT INTO rt_delivery_dispatches
         (id, account_id, store_id, service, action, target_kind, target_id,
          status, attempts, requested_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
    )
    .bind(
      id,
      store.lineAccountId,
      store.id,
      input.service,
      input.action,
      input.targetKind,
      input.targetId,
      input.now,
      input.now,
      input.now,
    )
    .run();
  return id;
}

/** 商品の外部IDと接続先を直接見せず、確認した送り先を固定する。 */
export async function menuTargetFingerprint(env: Env['Bindings'], externalIds: string | null): Promise<string | null> {
  const secret = env.LINE_CREDENTIAL_ENCRYPTION_KEY?.trim();
  if (!secret) return null;
  const targets = await Promise.all(DELIVERY_SERVICES.map((service) => deliveryTargetFingerprint(env, service)));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(JSON.stringify([externalIds, targets])));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** 送信結果で台帳を閉じる。失敗は分類済みの符号だけを残す。 */
export async function closeDispatch(
  c: Context<Env>,
  store: StoreContext,
  dispatchId: string,
  result: DeliveryDispatchResult,
  now: number,
): Promise<void> {
  const status = result.ok
    ? 'succeeded'
    : result.error.retryable && result.nextAttemptAt !== null
      ? 'retryable_failed'
      : result.nextAttemptAt === null && result.error.retryable
        ? 'exhausted'
        : 'failed';
  await dbFor(c.env, store.id)
    .prepare(
      `UPDATE rt_delivery_dispatches
          SET status = ?, error_code = ?, attempts = attempts + 1, next_attempt_at = ?,
              completed_at = ?, version = version + 1, updated_at = ?
        WHERE id = ?`,
    )
    .bind(
      status,
      result.ok ? null : result.error.code,
      result.ok ? null : result.nextAttemptAt,
      now,
      now,
      dispatchId,
    )
    .run();
}

/**
 * 「台帳へ起こす → 送る → 台帳を閉じる」をひとまとめにする。
 * 呼び出し側は ok:true のときだけ状態を進める。
 */
export async function sendWithLedger(
  c: Context<Env>,
  store: StoreContext,
  input: {
    service: DeliveryService;
    action: DeliveryAction;
    targetKind: 'order' | 'menu_item' | 'service';
    targetId: string | null;
    externalId?: string | null;
    expectedOrderVersion?: number;
    expectedIntake?: { service: DeliveryService; version: number; target: string };
    expectedMenu?: { id: string; version: number; target: string };
    body?: Record<string, unknown>;
    now: number;
  },
): Promise<DeliveryDispatchResult> {
  const dispatchId = await openDispatch(c, store, input);
  if (input.expectedMenu) {
    const item = await dbFor(c.env, store.id).prepare('SELECT version, external_item_ids_json FROM rt_delivery_menu_items WHERE id = ? AND store_id = ?')
      .bind(input.expectedMenu.id, store.id).first<{ version: number; external_item_ids_json: string | null }>();
    const target = item ? await menuTargetFingerprint(c.env, item.external_item_ids_json) : null;
    if (!item || item.version !== input.expectedMenu.version || target !== input.expectedMenu.target) {
      const conflict: DeliveryDispatchResult = { ok: false, error: { code: 'delivery_menu_conflict', message: '商品の状態が変わりました。', retryable: false }, nextAttemptAt: null };
      await closeDispatch(c, store, dispatchId, conflict, input.now);
      return conflict;
    }
  }
  if (input.expectedIntake) {
    const current = (await serviceStates(c, store)).find((state) => state.service === input.service);
    const target = await deliveryTargetFingerprint(c.env, input.service);
    if (!current || current.version !== input.expectedIntake.version || target !== input.expectedIntake.target) {
      const conflict: DeliveryDispatchResult = { ok: false, error: { code: 'delivery_intake_conflict', message: '受付状態が変わりました。', retryable: false }, nextAttemptAt: null };
      await closeDispatch(c, store, dispatchId, conflict, input.now);
      return conflict;
    }
  }
  if (input.expectedOrderVersion !== undefined && input.targetKind === 'order') {
    const current = await dbFor(c.env, store.id).prepare('SELECT version FROM rt_delivery_orders WHERE id = ? AND store_id = ?')
      .bind(input.targetId, store.id).first<{ version: number }>();
    if (current?.version !== input.expectedOrderVersion) {
      const conflict: DeliveryDispatchResult = { ok: false, error: { code: 'delivery_order_conflict', message: '注文が変わりました。画面を開き直してください。', retryable: false }, nextAttemptAt: null };
      await closeDispatch(c, store, dispatchId, conflict, input.now);
      return conflict;
    }
  }
  const result = await dispatchToDeliveryService(
    c.env,
    {
      service: input.service,
      action: input.action,
      externalId: input.externalId ?? null,
      body: input.body,
    },
    { completedAttempts: 0, now: new Date(input.now * 1000) },
  );
  await closeDispatch(c, store, dispatchId, result, input.now);
  return result;
}

/** 送信に失敗した時の返し方。画面には分類済みの短い文だけを出す。 */
export function dispatchFailure(c: Context<Env>, result: Extract<DeliveryDispatchResult, { ok: false }>) {
  const status = result.error.code === 'delivery_action_unsupported' ? 422
    : ['delivery_result_unknown', 'delivery_order_conflict', 'delivery_operation_failed'].includes(result.error.code) ? 409
      : result.error.retryable ? 503 : 502;
  return fail(c, status, result.error.message, {
    code: result.error.code,
    retryable: result.error.retryable,
  });
}

/** 注文に紐付く品目をまとめて引く。要約文と詳細の両方で使う。 */
export async function itemsForOrders(
  c: Context<Env>,
  store: StoreContext,
  orderIds: string[],
): Promise<Map<string, DeliveryOrderItemRow[]>> {
  const byOrder = new Map<string, DeliveryOrderItemRow[]>();
  if (orderIds.length === 0) return byOrder;
  const placeholders = sqlIdSet(orderIds).sql;
  const rows = await dbFor(c.env, store.id)
    .prepare(
      `SELECT id, order_id, position, name, note, quantity, amount
         FROM rt_delivery_order_items
        WHERE order_id IN (${placeholders})
        ORDER BY order_id, position`,
    )
    .bind(...(orderIds.length ? sqlIdSet(orderIds).binds : []))
    .all<DeliveryOrderItemRow>();
  for (const row of rows.results ?? []) {
    const list = byOrder.get(row.order_id);
    if (list) list.push(row);
    else byOrder.set(row.order_id, [row]);
  }
  return byOrder;
}

export async function upsertIntake(
  c: Context<Env>,
  store: StoreContext,
  service: DeliveryService,
  input:
    | { intake: 'stopped'; stopUntil: number; requestedBy: string; now: number; expectedVersion?: number }
    | { intake: 'open'; now: number },
): Promise<boolean | void> {
  const db = dbFor(c.env, store.id);
  if (input.intake === 'stopped' && input.expectedVersion !== undefined) {
    const result = await db.prepare(`INSERT INTO rt_delivery_service_states
      (account_id, store_id, service, intake_status, stop_until, stop_requested_at, stop_requested_by, created_at, updated_at)
      SELECT ?, ?, ?, 'stopped', ?, ?, ?, ?, ? WHERE ? = 0 OR EXISTS
      (SELECT 1 FROM rt_delivery_service_states WHERE store_id = ? AND service = ? AND version = ?)
      ON CONFLICT(store_id, service) DO UPDATE SET intake_status = 'stopped', stop_until = excluded.stop_until,
        stop_requested_at = excluded.stop_requested_at, stop_requested_by = excluded.stop_requested_by,
        version = rt_delivery_service_states.version + 1, updated_at = excluded.updated_at
      WHERE rt_delivery_service_states.version = ?`)
      .bind(store.lineAccountId, store.id, service, input.stopUntil, input.now, input.requestedBy, input.now, input.now, input.expectedVersion, store.id, service, input.expectedVersion, input.expectedVersion).run();
    return (result.meta?.changes ?? 0) === 1;
  }
  if (input.intake === 'stopped') {
    await db
      .prepare(
        `INSERT INTO rt_delivery_service_states
           (account_id, store_id, service, intake_status, stop_until,
            stop_requested_at, stop_requested_by, created_at, updated_at)
         VALUES (?, ?, ?, 'stopped', ?, ?, ?, ?, ?)
         ON CONFLICT(store_id, service) DO UPDATE SET
           intake_status = 'stopped', stop_until = excluded.stop_until,
           stop_requested_at = excluded.stop_requested_at,
           stop_requested_by = excluded.stop_requested_by,
           version = version + 1, updated_at = excluded.updated_at`,
      )
      .bind(
        store.lineAccountId,
        store.id,
        service,
        input.stopUntil,
        input.now,
        input.requestedBy,
        input.now,
        input.now,
      )
      .run();
    return;
  }
  await db
    .prepare(
      `INSERT INTO rt_delivery_service_states
         (account_id, store_id, service, intake_status, resumed_at, created_at, updated_at)
       VALUES (?, ?, ?, 'open', ?, ?, ?)
       ON CONFLICT(store_id, service) DO UPDATE SET
         intake_status = 'open', stop_until = NULL,
         resumed_at = excluded.resumed_at,
         version = version + 1, updated_at = excluded.updated_at`,
    )
    .bind(store.lineAccountId, store.id, service, input.now, input.now, input.now)
    .run();
}

export async function orderFor(
  c: Context<Env>,
  store: StoreContext,
  id: string,
): Promise<DeliveryOrderRow | null> {
  return dbFor(c.env, store.id)
    .prepare('SELECT * FROM rt_delivery_orders WHERE id = ? AND store_id = ? LIMIT 1')
    .bind(id, store.id)
    .first<DeliveryOrderRow>();
}
