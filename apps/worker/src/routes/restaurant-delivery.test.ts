/** 飲食店の送信は台帳へ先に記録し、成功時だけ状態を進める。署名・5分の時刻制限・一意制約で受信を守り、取消などの不可逆操作は確認票と owner/admin を必須にする。実 SQLite で版と重複を検証し、外部通信だけを差し替える。設計図 kDQHr・hjdqV・dgeTy・OzHLO・h7OeT・XCVGd と照合する。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { currentInvocation, withInvocation } from '@line-crm/shared/server';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';
import {
  orderCreatedPayload as deliveryOrderCreatedPayload,
  uberIgnoredNotification,
  type DeliveryOrderCreatedOverrides,
} from '../test-utils/delivery-webhook-fixtures.js';
import { stubUberStoresApi, type UberStoresApiOptions } from '../test-utils/uber-stores-api.js';
type MockStaff = {
  id: string;
  name: string;
  role: 'owner' | 'admin' | 'staff';
  access_level: 'full' | 'read_only';
  permission_keys: string;
  assigned_line_account_id: string | null;
  can_access_descendant_accounts: number;
  tenant_id?: string | null;
};
/* 管理セッションは生のトークンではなくハッシュで引き当てるので、登録した順に照合して返す。 */
const authMocks = vi.hoisted(() => {
  const sessions = new Map<string, unknown>();
  async function sha256Hex(value: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
  }
  return {
    sessions,
    getStaffByApiKey: vi.fn(async (): Promise<unknown> => null),
    getStaffByAdminSession: vi.fn(async (_db: unknown, tokenHash: string): Promise<unknown> => {
      for (const [token, staff] of sessions) if ((await sha256Hex(token)) === tokenHash) return staff;
      return null;
    }),
    lineAccounts: [] as Array<Record<string, unknown>>,
  };
});
/** 管理画面にログインしたオーナー。既定のテスト利用者。 */
const OWNER_SESSION: MockStaff = {
  id: 'owner-1',
  name: 'オーナー',
  role: 'owner',
  access_level: 'full',
  permission_keys: '[]',
  assigned_line_account_id: null,
  can_access_descendant_accounts: 1,
};
vi.mock('@line-crm/db', async () => {
  const actual = await vi.importActual<typeof import('@line-crm/db')>('@line-crm/db');
  return {
    ...actual,
    getStaffByApiKey: authMocks.getStaffByApiKey,
    getStaffByAdminSession: authMocks.getStaffByAdminSession,
    getLineAccounts: vi.fn(async () => authMocks.lineAccounts),
    getLineAccountScopeEntries: vi.fn(async () => authMocks.lineAccounts),
  };
});
const { authMiddleware, ADMIN_SESSION_BEARER_PREFIX } = await import('../middleware/auth.js');
const { restaurantDelivery } = await import('./restaurant-delivery.js');
const { signSupportRelay } = await import('../services/support-relay.js');
const { UBER_PROBE_LAST_RUN_KEY } = await import('../services/ubereats-token-probe.js');
const { MAX_WEBHOOK_BODY_BYTES } = await import('../services/delivery-webhook-payload.js');
type Env = import('../index.js').Env;
const TENANT = '00000000-0000-4000-8000-000000000001';
const ENC_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
/** 2026-10-09（金）12:00 JST。 */
const NOW = new Date('2026-10-09T03:00:00.000Z');
const NOW_SEC = Math.floor(NOW.getTime() / 1000);
/** 受信口の鍵は32文字以上でないと使われない（deliveryWebhookSecret）。 */
const UBEREATS_WEBHOOK_SECRET = 'ubereats-webhook-secret-0123456789ab';
const DEMAECAN_WEBHOOK_SECRET = 'demaecan-webhook-secret-0123456789ab';
/** Uber の受信口の鍵は同じアプリの Secret。本物の値ではない。 */
const UBEREATS_CLIENT_SECRET = 'test-client-secret';
const CANCEL_CONFIRM_TOKEN = 'delivery-order-cancel';
const INTAKE_STOP_CONFIRM_TOKEN = 'delivery-intake-stop';
/** サービスが返してくる自由文。台帳にも画面にも出てはいけない。 */
const PROVIDER_FREE_TEXT = 'merchant token expired for partner store 99812';
let testDb: SqliteD1;
let env: Env['Bindings'];
let deliveryCalls: Array<{ url: string; init?: RequestInit }>;
/** null 以外にすると、外部サービスへの送信がそのHTTP状態で落ちる。 */
let sendFailStatus: number | null;
let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
function seedStore(): void {
  for (const [id, name] of [
    ['account-1', '統括'],
    ['account-2', '渋谷店'],
  ]) {
    testDb.raw
      .prepare(
        `INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret, is_active, tenant_id) VALUES (?, ?, ?, ?, ?, 1, ?)`,
      )
      .run(id, `ch-${id}`, name, 'token', 'secret', TENANT);
  }
  testDb.raw
    .prepare('INSERT INTO rt_organizations (id, account_id, tenant_id, name) VALUES (?, ?, ?, ?)')
    .run('org-1', 'account-1', TENANT, '飲食店LAB');
  testDb.raw
    .prepare(
      `INSERT INTO rt_stores (id, organization_id, name, code, area, capacity, status, line_account_id)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`,
    )
    .run('store-shibuya', 'org-1', 'こもれび食堂 渋谷店', 'SHIBUYA', '東京', 20, 'account-2');
}
/** D-1の表に出る注文を1件置く。状態と版を指定して、版での絞り込みも確かめられるようにする。 */
function seedOrder(
  overrides: {
    id?: string;
    status?: string;
    service?: string;
    externalOrderId?: string;
    version?: number;
  } = {},
): string {
  const id = overrides.id ?? 'order-1';
  testDb.raw
    .prepare(
      `INSERT INTO rt_delivery_orders
         (id, account_id, store_id, service, external_order_id, order_number, status,
          total_amount, currency, item_count, pickup_method, wanted_at, urgency,
          received_at, version, created_at, updated_at)
       VALUES (?, 'account-2', 'store-shibuya', ?, ?, ?, ?, 3200, 'JPY', 2,
               '配達（出前館 配達員）', ?, 'normal', ?, ?, ?, ?)`,
    )
    .run(
      id,
      overrides.service ?? 'demaecan',
      overrides.externalOrderId ?? `DM-${id}`,
      `#DM-${id}`,
      overrides.status ?? 'new',
      NOW_SEC + 1800,
      NOW_SEC - 60,
      overrides.version ?? 1,
      NOW_SEC - 60,
      NOW_SEC - 60,
    );
  return id;
}
function app() {
  const instance = new Hono<Env>();
  instance.use('*', authMiddleware);
  instance.route('/', restaurantDelivery);
  return instance;
}
/** 管理セッションで呼ぶ。token は useStaffRole / OWNER_SESSION で登録したセッショントークン。 */
function call(
  path: string,
  init: { method?: string; body?: unknown; token?: string; confirm?: string } = {},
) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${ADMIN_SESSION_BEARER_PREFIX}${init.token ?? 'owner-session'}`,
  };
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  if (init.confirm !== undefined) headers['x-confirm-irreversible'] = init.confirm;
  return app().request(
    `${path}${path.includes('?') ? '&' : '?'}account_id=account-2`,
    {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    },
    env,
  );
}
function useStaffRole(role: 'admin' | 'staff'): void {
  testDb.raw
    .prepare(
      `INSERT OR REPLACE INTO staff_members (id, name, role, api_key, tenant_id, account_scope, can_access_descendant_accounts, is_active)
       VALUES (?, ?, ?, ?, ?, 'all', 1, 1)`,
    )
    .run(`${role}-1`, role, role, `${role}-key`, TENANT);
  authMocks.sessions.set(`${role}-session`, {
    id: `${role}-1`,
    name: role,
    role,
    access_level: 'full',
    permission_keys: '[]',
    assigned_line_account_id: null,
    can_access_descendant_accounts: 1,
  });
}
/* ------------------------------ 受信口の署名 ------------------------------ */
/** HMAC-SHA256 の小文字16進。受信口が求める形をそのまま作る。 */
async function hmacHex(secret: string, message: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
/** 自社方式（出前館・ロケットナウ）の署名。材料は本番と同じ `${timestamp}.${rawBody}`。 */
async function signWebhook(timestamp: number, rawBody: string, secret = DEMAECAN_WEBHOOK_SECRET) {
  return hmacHex(secret, `${timestamp}.${rawBody}`);
}
/**
 * Uber Eats の方式。公式仕様どおり**本文だけ**の署名で、鍵は同じアプリの Secret。
 * Uber は時刻の見出しを送らないので、ここでも作らない。
 */
async function signUberWebhook(rawBody: string, secret = UBEREATS_CLIENT_SECRET) {
  return hmacHex(secret, rawBody);
}
function orderCreatedPayload(
  overrides: DeliveryOrderCreatedOverrides = {},
) {
  return deliveryOrderCreatedPayload(NOW_SEC, overrides);
}
/** 署名付きで受信口を叩く。既定は正しい署名・正しい時刻。 */
async function postWebhook(
  payload: unknown,
  init: {
    service?: string;
    timestamp?: number;
    signature?: string;
    secret?: string;
    rawBody?: string;
    /** 送信元IPの見え方。Cloudflare が付ける見出しと同じ名前で渡す。 */
    headers?: Record<string, string>;
  } = {},
) {
  const service = init.service ?? 'demaecan';
  const rawBody = init.rawBody ?? JSON.stringify(payload);
  const timestamp = init.timestamp ?? NOW_SEC;
  // 署名の作り方はサービスごとに違う。Uber は本文だけ・時刻の見出しなし。
  const signed: Record<string, string> =
    service === 'ubereats'
      ? { 'x-uber-signature': init.signature ?? (await signUberWebhook(rawBody, init.secret)) }
      : {
          'x-nen-timestamp': String(timestamp),
          'x-nen-signature': init.signature ?? (await signWebhook(timestamp, rawBody, init.secret)),
        };
  return app().request(
    `/api/restaurant-test/delivery/webhooks/${service}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...signed, ...(init.headers ?? {}) },
      body: rawBody,
    },
    env,
  );
}
/* ------------------------------ 台帳の読み出し ------------------------------ */
function dispatchRows(): Array<Record<string, unknown>> {
  return testDb.raw
    .prepare('SELECT * FROM rt_delivery_dispatches ORDER BY created_at, id')
    .all() as Array<Record<string, unknown>>;
}
function eventRows(): Array<Record<string, unknown>> {
  return testDb.raw.prepare('SELECT * FROM rt_delivery_events ORDER BY received_at, id').all() as Array<
    Record<string, unknown>
  >;
}
function orderRow(id = 'order-1'): Record<string, unknown> | undefined {
  return testDb.raw.prepare('SELECT * FROM rt_delivery_orders WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  authMocks.getStaffByApiKey.mockReset();
  authMocks.getStaffByApiKey.mockResolvedValue(null);
  authMocks.sessions.clear();
  authMocks.sessions.set('owner-session', OWNER_SESSION);
  authMocks.lineAccounts = [
    { id: 'account-1', name: '統括', is_active: 1, channel_access_token: 'token-1' },
    { id: 'account-2', name: '渋谷店', is_active: 1, channel_access_token: 'token-2' },
  ];
  testDb = createTestD1({ loginPolicy: 'off' });
  testDb.raw.prepare(`UPDATE tenants SET feature_packs = '["restaurant"]' WHERE id = ?`).run(TENANT);
  deliveryCalls = [];
  sendFailStatus = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      deliveryCalls.push({ url, init });
      if (sendFailStatus !== null) {
        // サービスは自由文つきで落ちてくる。この本文はどこにも残ってはいけない。
        return new Response(JSON.stringify({ message: PROVIDER_FREE_TEXT }), {
          status: sendFailStatus,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  env = {
    DB: testDb.db,
    API_KEY: 'owner-key',
    IMAGES: {} as unknown as R2Bucket,
    RAW_MAIL: {} as R2Bucket,
    ASSETS: {} as Fetcher,
    AI: { run: vi.fn(async () => ({ response: '' })) } as unknown as Ai,
    DEPLOY_ENV: 'test', RESTAURANT_TEST_ENABLED: 'true',
    LINE_CHANNEL_SECRET: 'unused',
    LINE_CHANNEL_ACCESS_TOKEN: 'unused',
    LIFF_URL: 'https://example.test',
    LINE_CHANNEL_ID: 'unused',
    LINE_LOGIN_CHANNEL_ID: 'unused',
    LINE_LOGIN_CHANNEL_SECRET: 'unused',
    WORKER_URL: 'https://worker.example.test',
    // 戻り先URLはこの配備の設定から組み立てる。呼び出し元のホストからは作らない。
    WORKER_PUBLIC_URL: 'https://worker.example.test',
    ADMIN_PUBLIC_URL: 'https://admin.example.test',
    LINE_CREDENTIAL_ENCRYPTION_KEY: ENC_KEY,
    // 本物の値ではない。試験の中だけで使う作り物。
    RT_DELIVERY_UBEREATS_CLIENT_ID: 'test-client-id',
    RT_DELIVERY_UBEREATS_CLIENT_SECRET: 'test-client-secret',
    RT_DELIVERY_SEND_ENABLED: 'true',
    RT_DELIVERY_DEMAECAN_API_BASE_URL: 'https://demaecan.example.test',
    RT_DELIVERY_DEMAECAN_API_TOKEN: 'demaecan-token',
    RT_DELIVERY_UBEREATS_WEBHOOK_SECRET: UBEREATS_WEBHOOK_SECRET,
    RT_DELIVERY_DEMAECAN_WEBHOOK_SECRET: DEMAECAN_WEBHOOK_SECRET,
  } as unknown as Env['Bindings'];
  seedStore();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  logSpy.mockRestore();
  errorSpy.mockRestore();
});
/* ============================== 受入条件2 ============================== */
describe('送信台帳（受入条件2）', () => {
  it('外部操作の直前に注文が変わっても送らない', async () => {
    seedOrder({ status: 'new', version: 1 });
    const original = testDb.db.prepare.bind(testDb.db);
    let changed = false;
    const spy = vi.spyOn(testDb.db, 'prepare').mockImplementation((sql: string) => {
      if (!changed && sql.startsWith('SELECT version FROM rt_delivery_orders')) {
        changed = true;
        testDb.raw.prepare("UPDATE rt_delivery_orders SET version = 2 WHERE id = 'order-1'").run();
      }
      return original(sql);
    });
    try {
      const response = await call('/api/restaurant-test/delivery/orders/order-1/accept', { body: { expectedVersion: 1 } });
      expect(changed).toBe(true);
      expect(response.status).toBe(409);
      expect(deliveryCalls).toHaveLength(0);
      expect(orderRow()).toMatchObject({ status: 'new', version: 2 });
    } finally { spy.mockRestore(); }
  });
  it('確認した版が一致する注文取消は送れる', async () => {
    seedOrder({ status: 'cooking', version: 1 });
    const response = await call('/api/restaurant-test/delivery/orders/order-1/cancel', {
      body: { reason_code: 'out_of_stock', expectedVersion: 1 }, confirm: CANCEL_CONFIRM_TOKEN,
    });
    expect(response.status).toBe(200);
    expect(deliveryCalls).toHaveLength(1);
    expect(orderRow()?.status).toBe('canceled');
  });
  it('確認後に注文版が変わったら外部操作を開始しない', async () => {
    seedOrder({ status: 'new', version: 2 });
    const response = await call('/api/restaurant-test/delivery/orders/order-1/accept', { body: { expectedVersion: 1 } });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'STALE_ORDER', order: { id: 'order-1', status: 'new', version: 2 } });
    expect(deliveryCalls).toHaveLength(0);
    expect(dispatchRows()).toHaveLength(0);
    expect(orderRow()).toMatchObject({ status: 'new', version: 2 });
  });
  it('送信が成功したときだけD1の状態を進め、台帳に成功として残す', async () => {
    seedOrder({ status: 'new' });
    const response = await call('/api/restaurant-test/delivery/orders/order-1/accept', { body: {} });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      order: { id: 'order-1', status: 'cooking' },
    });
    // 外へ出たのは1回だけ。宛先は各サービスの店舗向け窓口（受注一元化サービスは経由しない）。
    expect(deliveryCalls).toHaveLength(1);
    expect(deliveryCalls[0]?.url).toBe('https://demaecan.example.test/orders/accept');
    const rows = dispatchRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      service: 'demaecan',
      action: 'accept',
      target_kind: 'order',
      target_id: 'order-1',
      status: 'succeeded',
      error_code: null,
    });
    expect(rows[0]?.completed_at).toBe(NOW_SEC);
    const order = orderRow();
    expect(order?.status).toBe('cooking');
    expect(order?.accepted_at).toBe(NOW_SEC);
    expect(order?.version).toBe(2);
  });
  it('送信が一時的に失敗したら状態は進めず、台帳には分類済み符号だけを残す', async () => {
    seedOrder({ status: 'new' });
    sendFailStatus = 500;
    const response = await call('/api/restaurant-test/delivery/orders/order-1/accept', { body: {} });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      code: 'delivery_temporary_failure',
      retryable: true,
    });
    const rows = dispatchRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'retryable_failed', error_code: 'delivery_temporary_failure' });
    // サービスから返った自由文は台帳のどこにも入れない。
    expect(JSON.stringify(rows[0])).not.toContain(PROVIDER_FREE_TEXT);
    // D1の状態は動かさない。再送は台帳の next_attempt_at から行う。
    const order = orderRow();
    expect(order?.status).toBe('new');
    expect(order?.accepted_at).toBeNull();
    expect(order?.version).toBe(1);
    expect(rows[0]?.next_attempt_at).not.toBeNull();
  });
  it('認証が通らない失敗は再試行しない符号で残し、502を返す', async () => {
    seedOrder({ status: 'cooking' });
    sendFailStatus = 401;
    const response = await call('/api/restaurant-test/delivery/orders/order-1/ready', { body: {} });
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      code: 'delivery_authentication_failed',
      retryable: false,
    });
    const rows = dispatchRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'ready',
      status: 'failed',
      error_code: 'delivery_authentication_failed',
    });
    expect(orderRow()?.status).toBe('cooking');
    expect(orderRow()?.ready_at).toBeNull();
  });
  it('送信が止められている設定でも台帳には記録し、状態は進めない', async () => {
    seedOrder({ status: 'new' });
    env = { ...env, RT_DELIVERY_SEND_ENABLED: 'false' } as Env['Bindings'];
    const response = await call('/api/restaurant-test/delivery/orders/order-1/accept', { body: {} });
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({ code: 'delivery_send_disabled' });
    // 外へは一歩も出ない。
    expect(deliveryCalls).toHaveLength(0);
    const rows = dispatchRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'failed', error_code: 'delivery_send_disabled' });
    expect(orderRow()?.status).toBe('new');
  });
  it('進められない状態の注文は送信もせず409で返す', async () => {
    seedOrder({ status: 'handed_over' });
    const response = await call('/api/restaurant-test/delivery/orders/order-1/accept', { body: {} });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: 'INVALID_STATUS', status: 'handed_over' });
    expect(deliveryCalls).toHaveLength(0);
    expect(dispatchRows()).toHaveLength(0);
  });
});
/* ============================== 受入条件3 ============================== */
describe('受信口（受入条件3）', () => {
  it('署名が正しい通知を取り込み、受信台帳へ残す', async () => {
    const response = await postWebhook(orderCreatedPayload());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true, result: 'created' });
    const events = eventRows();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      service: 'demaecan',
      external_event_id: 'evt-1',
      event_type: 'order.created',
      external_order_id: 'DM-9001',
      status: 'processed',
      error_code: null,
    });
    const orders = testDb.raw
      .prepare('SELECT * FROM rt_delivery_orders WHERE external_order_id = ?')
      .all('DM-9001') as Array<Record<string, unknown>>;
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ store_id: 'store-shibuya', status: 'new', item_count: 3 });
    const items = testDb.raw
      .prepare('SELECT name, quantity FROM rt_delivery_order_items WHERE order_id = ? ORDER BY position')
      .all(orders[0]?.id) as Array<Record<string, unknown>>;
    expect(items.map((item) => item.name)).toEqual(['鶏の唐揚げ弁当', '味噌汁']);
  });
  it('署名が違う通知は401で断り、何も取り込まない', async () => {
    const response = await postWebhook(orderCreatedPayload(), { signature: 'f'.repeat(64) });
    expect(response.status).toBe(401);
    expect(eventRows()).toHaveLength(0);
    expect(testDb.raw.prepare('SELECT COUNT(*) AS n FROM rt_delivery_orders').get()).toMatchObject({ n: 0 });
  });
  it('本文を書き換えた通知は署名が合わず401になる', async () => {
    const payload = uberIgnoredNotification();
    const signed = JSON.stringify(payload);
    const tampered = JSON.stringify({ ...payload, event_type: 'orders.other_future_notification' });
    const signature = await signUberWebhook(signed);
    const response = await postWebhook(null, { service: 'ubereats', rawBody: tampered, signature });
    expect(response.status).toBe(401);
    expect(eventRows()).toHaveLength(0);
  });
  // Uber は公式仕様で時刻の見出しを送らないため、Uber の受信口では時刻を見ない。
  // 見ると本物の通知を落としてしまうので、ここでそのことを固定する。
  it('Uber からの通知は時刻の見出しが無くても受け付ける', async () => {
    const rawBody = JSON.stringify(uberIgnoredNotification());
    const response = await app().request(
      '/api/restaurant-test/delivery/webhooks/ubereats',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-uber-signature': await signUberWebhook(rawBody),
        },
        body: rawBody,
      },
      env,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
    expect(eventRows()).toHaveLength(0);
    expect(deliveryCalls).toHaveLength(0);
  });
  it('Uber の受信口に自社方式の見出しだけで送っても401になる', async () => {
    const rawBody = JSON.stringify(uberIgnoredNotification());
    const response = await app().request(
      '/api/restaurant-test/delivery/webhooks/ubereats',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-nen-timestamp': String(NOW_SEC),
          'x-nen-signature': await signWebhook(NOW_SEC, rawBody, UBEREATS_CLIENT_SECRET),
        },
        body: rawBody,
      },
      env,
    );
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: 'Invalid signature' });
    expect(eventRows()).toHaveLength(0);
  });
  it('Uber の受信口は静的なトークン用の合言葉では通らない', async () => {
    const response = await postWebhook(uberIgnoredNotification(), {
      service: 'ubereats',
      secret: UBEREATS_WEBHOOK_SECRET,
    });
    expect(response.status).toBe(401);
    expect(eventRows()).toHaveLength(0);
  });
  it('自社方式のサービスで5分より古い通知は401で断る', async () => {
    const response = await postWebhook(orderCreatedPayload(), {
      service: 'demaecan',
      timestamp: NOW_SEC - 301,
    });
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: 'Expired request' });
    expect(eventRows()).toHaveLength(0);
  });
  it('自社方式のサービスで5分より先の時刻の通知も401で断る', async () => {
    const response = await postWebhook(orderCreatedPayload(), {
      service: 'demaecan',
      timestamp: NOW_SEC + 301,
    });
    expect(response.status).toBe(401);
    expect(eventRows()).toHaveLength(0);
  });
  it('自社方式のサービスで5分以内のずれは受け付ける', async () => {
    const response = await postWebhook(orderCreatedPayload(), {
      service: 'demaecan',
      timestamp: NOW_SEC - 299,
    });
    expect(response.status).toBe(200);
    expect(eventRows()).toHaveLength(1);
  });
  it('同じ通知が二度届いても二重処理しない', async () => {
    const payload = orderCreatedPayload();
    const first = await postWebhook(payload);
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toEqual({ success: true, result: 'created' });
    const second = await postWebhook(payload);
    expect(second.status).toBe(200);
    // 再送でも同じ200を返して相手の再試行を止める。
    await expect(second.json()).resolves.toEqual({ success: true, duplicate: true });
    expect(eventRows()).toHaveLength(1);
    expect(testDb.raw.prepare('SELECT COUNT(*) AS n FROM rt_delivery_orders').get()).toMatchObject({ n: 1 });
    expect(testDb.raw.prepare('SELECT COUNT(*) AS n FROM rt_delivery_order_items').get()).toMatchObject({ n: 2 });
  });
  it('通知IDが違えば別の注文として取り込む', async () => {
    await postWebhook(orderCreatedPayload());
    const response = await postWebhook(
      orderCreatedPayload({ eventId: 'evt-2', externalOrderId: 'DM-9002', orderNumber: '#DM-9002' }),
    );
    expect(response.status).toBe(200);
    expect(eventRows()).toHaveLength(2);
    expect(testDb.raw.prepare('SELECT COUNT(*) AS n FROM rt_delivery_orders').get()).toMatchObject({ n: 2 });
  });
  it('同じ注文IDの別通知は注文を増やさず duplicate として返す', async () => {
    await postWebhook(orderCreatedPayload());
    const response = await postWebhook(orderCreatedPayload({ eventId: 'evt-3' }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true, result: 'duplicate' });
    expect(testDb.raw.prepare('SELECT COUNT(*) AS n FROM rt_delivery_orders').get()).toMatchObject({ n: 1 });
  });
  it('知らないサービスの受信口は404', async () => {
    const response = await postWebhook(orderCreatedPayload(), { service: 'menu' });
    expect(response.status).toBe(404);
    expect(eventRows()).toHaveLength(0);
  });
  // Uber の受信口の鍵は同じアプリの Secret なので、欠けを見るのもそちら。
  it('Uber の鍵が設定されていなければ503で断り、署名の判定へ進まない', async () => {
    env = { ...env, RT_DELIVERY_UBEREATS_CLIENT_SECRET: undefined } as Env['Bindings'];
    const response = await postWebhook(uberIgnoredNotification(), { service: 'ubereats' });
    expect(response.status).toBe(503);
    expect(eventRows()).toHaveLength(0);
  });
  it('お客様からのキャンセル通知で注文を終わらせる', async () => {
    seedOrder({ status: 'cooking', externalOrderId: 'DM-7001' });
    const response = await postWebhook({
      event_id: 'evt-cancel-1',
      event_type: 'order.canceled',
      store_id: 'store-shibuya',
      cancel: { external_order_id: 'DM-7001', canceled_by: 'customer' },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true, result: 'canceled' });
    const order = orderRow();
    expect(order?.status).toBe('canceled');
    expect(order?.canceled_by).toBe('customer');
    expect(order?.cancel_reason_code).toBe('customer_request');
    // 外へ送り返す操作ではないので送信台帳は使わない。
    expect(dispatchRows()).toHaveLength(0);
  });
});
/* ====================== 受信口の送信元IPの制限（出前館QA#7） ====================== */
describe('受信口の送信元IPの制限（出前館QA#7）', () => {
  it('許可リストが未設定なら、いまと同じようにIPを見ずに受け取る', async () => {
    const response = await postWebhook(orderCreatedPayload(), {
      headers: { 'cf-connecting-ip': '203.0.113.99' },
    });
    expect(response.status).toBe(200);
    expect(eventRows()).toHaveLength(1);
  });
  it('許可リストにあるIPからの通知はそのまま取り込む', async () => {
    env = { ...env, RT_DELIVERY_WEBHOOK_IP_ALLOWLIST: '203.0.113.5' } as Env['Bindings'];
    const response = await postWebhook(orderCreatedPayload(), {
      headers: { 'cf-connecting-ip': '203.0.113.5' },
    });
    expect(response.status).toBe(200);
    expect(eventRows()).toHaveLength(1);
  });
  it('許可リストにないIPは403で断り、本文も受信台帳も残さない', async () => {
    env = { ...env, RT_DELIVERY_WEBHOOK_IP_ALLOWLIST: '203.0.113.5' } as Env['Bindings'];
    const response = await postWebhook(orderCreatedPayload(), {
      headers: { 'cf-connecting-ip': '198.51.100.9' },
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ success: false, error: 'Forbidden' });
    expect(eventRows()).toHaveLength(0);
    expect(testDb.raw.prepare('SELECT COUNT(*) AS n FROM rt_delivery_orders').get()).toMatchObject({ n: 0 });
  });
  it('送信元が分からない通知も、許可リストがあるときは403で断る', async () => {
    env = { ...env, RT_DELIVERY_WEBHOOK_IP_ALLOWLIST: '203.0.113.5' } as Env['Bindings'];
    const response = await postWebhook(orderCreatedPayload());
    expect(response.status).toBe(403);
    expect(eventRows()).toHaveLength(0);
  });
  it('まとまりでの指定（203.0.113.0/24）は範囲の中なら通す', async () => {
    env = { ...env, RT_DELIVERY_WEBHOOK_IP_ALLOWLIST: '203.0.113.0/24' } as Env['Bindings'];
    const inside = await postWebhook(orderCreatedPayload(), {
      headers: { 'cf-connecting-ip': '203.0.113.240' },
    });
    expect(inside.status).toBe(200);
    const outside = await postWebhook(orderCreatedPayload({ eventId: 'evt-outside' }), {
      headers: { 'cf-connecting-ip': '203.0.114.1' },
    });
    expect(outside.status).toBe(403);
    expect(eventRows()).toHaveLength(1);
  });
  it('サービスごとの指定は共通の指定より先に効く', async () => {
    env = {
      ...env,
      RT_DELIVERY_WEBHOOK_IP_ALLOWLIST: '192.0.2.1',
      RT_DELIVERY_DEMAECAN_WEBHOOK_IP_ALLOWLIST: '198.51.100.7',
    } as Env['Bindings'];
    // 共通側のIPはこのサービスでは通らない。
    const common = await postWebhook(orderCreatedPayload(), {
      headers: { 'cf-connecting-ip': '192.0.2.1' },
    });
    expect(common.status).toBe(403);
    const perService = await postWebhook(orderCreatedPayload(), {
      headers: { 'cf-connecting-ip': '198.51.100.7' },
    });
    expect(perService.status).toBe(200);
    expect(eventRows()).toHaveLength(1);
  });
  it('IPの確認は鍵と署名より先。許可外なら署名が正しくても403', async () => {
    env = {
      ...env,
      RT_DELIVERY_WEBHOOK_IP_ALLOWLIST: '203.0.113.5',
      RT_DELIVERY_DEMAECAN_WEBHOOK_SECRET: undefined,
    } as Env['Bindings'];
    // 鍵が無ければ本来は503だが、IPで断る方が先なので403になる。
    const response = await postWebhook(orderCreatedPayload(), {
      headers: { 'cf-connecting-ip': '198.51.100.9' },
    });
    expect(response.status).toBe(403);
  });
  it('cf-connecting-ip が無い配備では x-forwarded-for の先頭を見る', async () => {
    env = { ...env, RT_DELIVERY_WEBHOOK_IP_ALLOWLIST: '203.0.113.5' } as Env['Bindings'];
    const response = await postWebhook(orderCreatedPayload(), {
      headers: { 'x-forwarded-for': '203.0.113.5, 198.51.100.9' },
    });
    expect(response.status).toBe(200);
    expect(eventRows()).toHaveLength(1);
  });
});
/* ====================== 受信口の本文の大きさの上限（413） ====================== */
describe('受信口の本文の大きさの上限（413）', () => {
  it('申告された大きさが上限を超えていれば、本文を読まずに413で断る', async () => {
    const response = await postWebhook(orderCreatedPayload(), {
      headers: { 'content-length': String(MAX_WEBHOOK_BODY_BYTES + 1) },
    });
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ success: false, error: 'Payload too large' });
    expect(eventRows()).toHaveLength(0);
  });
  it('申告が無くても実測が上限を超えた本文は413で断り、受信台帳に残さない', async () => {
    const response = await postWebhook(null, {
      rawBody: JSON.stringify({ event_id: 'evt-big', pad: 'x'.repeat(MAX_WEBHOOK_BODY_BYTES) }),
    });
    expect(response.status).toBe(413);
    expect(eventRows()).toHaveLength(0);
  });
  it('上限ちょうどまでの本文は大きさでは断らない', async () => {
    const response = await postWebhook(orderCreatedPayload(), {
      headers: { 'content-length': String(MAX_WEBHOOK_BODY_BYTES) },
    });
    expect(response.status).toBe(200);
    expect(eventRows()).toHaveLength(1);
  });
  it('大きさの確認は署名より先。署名が違っても大きすぎれば413', async () => {
    const response = await postWebhook(orderCreatedPayload(), {
      signature: 'broken',
      headers: { 'content-length': String(MAX_WEBHOOK_BODY_BYTES + 1) },
    });
    expect(response.status).toBe(413);
    expect(eventRows()).toHaveLength(0);
  });
  it('鍵が無いときは大きさより先に503。設定不足の方を先に伝える', async () => {
    env = { ...env, RT_DELIVERY_DEMAECAN_WEBHOOK_SECRET: undefined } as Env['Bindings'];
    const response = await postWebhook(orderCreatedPayload(), {
      headers: { 'content-length': String(MAX_WEBHOOK_BODY_BYTES + 1) },
    });
    expect(response.status).toBe(503);
    expect(eventRows()).toHaveLength(0);
  });
});
/* ============================== 受入条件4 ============================== */
describe('取り消せない操作（受入条件4）', () => {
  it('注文キャンセルは確認手順がないと428で止まる', async () => {
    seedOrder({ status: 'cooking' });
    const response = await call('/api/restaurant-test/delivery/orders/order-1/cancel', {
      body: { reason_code: 'out_of_stock' },
    });
    expect(response.status).toBe(428);
    await expect(response.json()).resolves.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    expect(deliveryCalls).toHaveLength(0);
    expect(dispatchRows()).toHaveLength(0);
    expect(orderRow()?.status).toBe('cooking');
  });
  it('確認のしるしが違っても428で止まる', async () => {
    seedOrder({ status: 'cooking' });
    const response = await call('/api/restaurant-test/delivery/orders/order-1/cancel', {
      body: { reason_code: 'out_of_stock' },
      confirm: INTAKE_STOP_CONFIRM_TOKEN,
    });
    expect(response.status).toBe(428);
    expect(orderRow()?.status).toBe('cooking');
  });
  it('確認手順を経た注文キャンセルは理由を残して通る', async () => {
    seedOrder({ status: 'cooking' });
    const response = await call('/api/restaurant-test/delivery/orders/order-1/cancel', {
      body: { reason_code: 'out_of_stock' },
      confirm: CANCEL_CONFIRM_TOKEN,
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ order: { status: 'canceled' } });
    const order = orderRow();
    expect(order?.cancel_reason_code).toBe('out_of_stock');
    expect(order?.canceled_by).toBe('store');
    expect(order?.canceled_at).toBe(NOW_SEC);
    expect(dispatchRows()[0]).toMatchObject({ action: 'cancel', status: 'succeeded' });
  });
  it('理由を選んでいないキャンセルは400で返す', async () => {
    seedOrder({ status: 'cooking' });
    const response = await call('/api/restaurant-test/delivery/orders/order-1/cancel', {
      body: {},
      confirm: CANCEL_CONFIRM_TOKEN,
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: 'REASON_REQUIRED' });
    expect(orderRow()?.status).toBe('cooking');
  });
  it('担当者（staff）は注文キャンセルできない', async () => {
    seedOrder({ status: 'cooking' });
    useStaffRole('staff');
    const response = await call('/api/restaurant-test/delivery/orders/order-1/cancel', {
      body: { reason_code: 'out_of_stock' },
      confirm: CANCEL_CONFIRM_TOKEN,
      token: 'staff-session',
    });
    expect(response.status).toBe(403);
    expect(orderRow()?.status).toBe('cooking');
  });
  it('受付一括停止は確認手順がないと428で止まる', async () => {
    const response = await call('/api/restaurant-test/delivery/intake/stop', {
      body: { preset: '30m' },
    });
    expect(response.status).toBe(428);
    await expect(response.json()).resolves.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    expect(deliveryCalls).toHaveLength(0);
    expect(dispatchRows()).toHaveLength(0);
  });
  it('担当者（staff）は受付一括停止できない', async () => {
    useStaffRole('staff');
    const response = await call('/api/restaurant-test/delivery/intake/stop', {
      body: { preset: '30m' },
      confirm: INTAKE_STOP_CONFIRM_TOKEN,
      token: 'staff-session',
    });
    expect(response.status).toBe(403);
    expect(dispatchRows()).toHaveLength(0);
  });
  it('一覧で確認した受付の版と接続先なら停止できる', async () => {
    const preview = await call('/api/restaurant-test/delivery/orders');
    const data = await preview.json() as { services: Array<{ service: string; version: number; target: string }> };
    const state = data.services.find((item) => item.service === 'demaecan')!;
    const response = await call('/api/restaurant-test/delivery/intake/stop', { body: { preset: '30m', services: ['demaecan'], expectedStoreId: 'store-shibuya', expectedStates: [state] }, confirm: INTAKE_STOP_CONFIRM_TOKEN });
    expect(response.status).toBe(200);
    expect(deliveryCalls).toHaveLength(1);
  });
  it('接続先の認証が別のものに変われば停止しない', async () => {
    const preview = await call('/api/restaurant-test/delivery/orders');
    const data = await preview.json() as { services: Array<{ service: string; version: number; target: string }> };
    const state = data.services.find((item) => item.service === 'demaecan')!;
    env.RT_DELIVERY_DEMAECAN_API_TOKEN = 'different-token';
    const response = await call('/api/restaurant-test/delivery/intake/stop', { body: { preset: '30m', services: ['demaecan'], expectedStoreId: 'store-shibuya', expectedStates: [state] }, confirm: INTAKE_STOP_CONFIRM_TOKEN });
    expect(response.status).toBe(409);
    expect(deliveryCalls).toHaveLength(0);
  });
  it('途中で別の受付が変われば、済んだサービスを返して残りを送らない', async () => {
    env.RT_DELIVERY_ROCKETNOW_API_BASE_URL = 'https://rocket.example.test';
    env.RT_DELIVERY_ROCKETNOW_API_TOKEN = 'fake-rocket-token';
    const preview = await call('/api/restaurant-test/delivery/orders');
    const data = await preview.json() as { services: Array<{ service: string; version: number; target: string }> };
    const selected = data.services.filter((item) => ['demaecan', 'rocketnow'].includes(item.service));
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      deliveryCalls.push({ url: String(input), init });
      testDb.raw.prepare(`INSERT INTO rt_delivery_service_states (account_id, store_id, service, connection_status, intake_status, created_at, updated_at) VALUES ('account-2', 'store-shibuya', 'rocketnow', 'connected', 'open', 1, 1)`).run();
      return new Response('{}', { status: 200 });
    }));
    const response = await call('/api/restaurant-test/delivery/intake/stop', { body: { preset: '30m', services: ['demaecan', 'rocketnow'], expectedStoreId: 'store-shibuya', expectedStates: selected }, confirm: INTAKE_STOP_CONFIRM_TOKEN });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'STALE_INTAKE', stopped: ['demaecan'] });
    expect(deliveryCalls).toHaveLength(1);
  });
  it('既存の受付状態も一致する版なら停止できる', async () => {
    testDb.raw.prepare(`INSERT INTO rt_delivery_service_states (account_id, store_id, service, connection_status, intake_status, version, created_at, updated_at) VALUES ('account-2', 'store-shibuya', 'demaecan', 'connected', 'open', 3, 1, 1)`).run();
    const preview = await call('/api/restaurant-test/delivery/orders');
    const data = await preview.json() as { services: Array<{ service: string; version: number; target: string }> };
    const state = data.services.find((item) => item.service === 'demaecan')!;
    const response = await call('/api/restaurant-test/delivery/intake/stop', { body: { preset: '30m', services: ['demaecan'], expectedStoreId: 'store-shibuya', expectedStates: [state] }, confirm: INTAKE_STOP_CONFIRM_TOKEN });
    expect(response.status).toBe(200);
    expect(testDb.raw.prepare("SELECT version, intake_status FROM rt_delivery_service_states WHERE store_id = 'store-shibuya' AND service = 'demaecan'").get()).toMatchObject({ version: 4, intake_status: 'stopped' });
  });
  it('受付送信中に変わった状態を上書きせず、停止の可能性を知らせる', async () => {
    const preview = await call('/api/restaurant-test/delivery/orders');
    const data = await preview.json() as { services: Array<{ service: string; version: number; target: string }> };
    const state = data.services.find((item) => item.service === 'demaecan')!;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      deliveryCalls.push({ url: String(input), init });
      testDb.raw.prepare(`INSERT INTO rt_delivery_service_states (account_id, store_id, service, connection_status, intake_status, created_at, updated_at) VALUES ('account-2', 'store-shibuya', 'demaecan', 'connected', 'open', 1, 1)`).run();
      return new Response('{}', { status: 200 });
    }));
    const response = await call('/api/restaurant-test/delivery/intake/stop', { body: { preset: '30m', services: ['demaecan'], expectedStoreId: 'store-shibuya', expectedStates: [state] }, confirm: INTAKE_STOP_CONFIRM_TOKEN });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'STALE_INTAKE', states: [{ service: 'demaecan', version: 1, intakeStatus: 'open' }] });
    expect(deliveryCalls).toHaveLength(1);
  });
  it('受付送信の直前に版が変わったら外部へ送らない', async () => {
    const preview = await call('/api/restaurant-test/delivery/orders');
    const data = await preview.json() as { services: Array<{ service: string; version: number; target: string }> };
    const state = data.services.find((item) => item.service === 'demaecan')!;
    const original = testDb.db.prepare.bind(testDb.db);
    let reads = 0;
    const spy = vi.spyOn(testDb.db, 'prepare').mockImplementation((sql: string) => {
      if (sql.includes('FROM rt_delivery_service_states WHERE store_id = ?') && ++reads === 2) {
        testDb.raw.prepare(`INSERT INTO rt_delivery_service_states (account_id, store_id, service, connection_status, intake_status, created_at, updated_at) VALUES ('account-2', 'store-shibuya', 'demaecan', 'connected', 'open', 1, 1)`).run();
      }
      return original(sql);
    });
    try {
      const response = await call('/api/restaurant-test/delivery/intake/stop', { body: { preset: '30m', services: ['demaecan'], expectedStoreId: 'store-shibuya', expectedStates: [state] }, confirm: INTAKE_STOP_CONFIRM_TOKEN });
      expect(reads).toBeGreaterThanOrEqual(2);
      expect(response.status).toBe(409);
      expect(deliveryCalls).toHaveLength(0);
    } finally { spy.mockRestore(); }
  });
  it('確認した商品と接続先が一致すれば品切れを送れる', async () => {
    testDb.raw.prepare(`INSERT INTO rt_delivery_menu_items (id, account_id, store_id, name, external_item_ids_json, version, created_at, updated_at) VALUES ('item-1', 'account-2', 'store-shibuya', '商品', '{"demaecan":"remote-1"}', 1, 1, 1)`).run();
    const preview = await call('/api/restaurant-test/delivery/menu-items');
    const data = await preview.json() as { items: Array<{ id: string; version: number; target: string }> };
    const response = await call('/api/restaurant-test/delivery/menu-items/bulk-sold-out', { body: { item_ids: ['item-1'], sold_out: true, expectedStoreId: 'store-shibuya', expectedItems: data.items } });
    expect(response.status).toBe(200);
    expect(deliveryCalls).toHaveLength(1);
  });
  it('商品送信中の変更を後から上書きせず、反映の可能性を知らせる', async () => {
    testDb.raw.prepare(`INSERT INTO rt_delivery_menu_items (id, account_id, store_id, name, external_item_ids_json, version, created_at, updated_at) VALUES ('item-1', 'account-2', 'store-shibuya', '商品', '{"demaecan":"remote-1"}', 1, 1, 1)`).run();
    const preview = await call('/api/restaurant-test/delivery/menu-items');
    const data = await preview.json() as { items: Array<{ id: string; version: number; target: string }> };
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      deliveryCalls.push({ url: String(input), init });
      testDb.raw.prepare("UPDATE rt_delivery_menu_items SET name = '変更済み', version = version + 1 WHERE id = 'item-1'").run();
      return new Response('{}', { status: 200 });
    }));
    const response = await call('/api/restaurant-test/delivery/menu-items/bulk-sold-out', { body: { item_ids: ['item-1'], sold_out: true, expectedStoreId: 'store-shibuya', expectedItems: data.items } });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'STALE_MENU', items: [{ id: 'item-1', name: '変更済み', soldOut: false }] });
    expect(deliveryCalls).toHaveLength(1);
  });
  it('商品送信の直前に宛先が変われば外部へ送らない', async () => {
    testDb.raw.prepare(`INSERT INTO rt_delivery_menu_items (id, account_id, store_id, name, external_item_ids_json, version, created_at, updated_at) VALUES ('item-1', 'account-2', 'store-shibuya', '商品', '{"demaecan":"remote-1"}', 1, 1, 1)`).run();
    const preview = await call('/api/restaurant-test/delivery/menu-items');
    const data = await preview.json() as { items: Array<{ id: string; version: number; target: string }> };
    const original = testDb.db.prepare.bind(testDb.db);
    const spy = vi.spyOn(testDb.db, 'prepare').mockImplementation((sql: string) => {
      if (sql.startsWith('SELECT version, external_item_ids_json FROM rt_delivery_menu_items')) testDb.raw.prepare(`UPDATE rt_delivery_menu_items SET external_item_ids_json = '{"demaecan":"remote-2"}' WHERE id = 'item-1'`).run();
      return original(sql);
    });
    try {
      const response = await call('/api/restaurant-test/delivery/menu-items/bulk-sold-out', { body: { item_ids: ['item-1'], sold_out: true, expectedStoreId: 'store-shibuya', expectedItems: data.items } });
      expect(response.status).toBe(409);
      expect(deliveryCalls).toHaveLength(0);
    } finally { spy.mockRestore(); }
  });
  it('確認後に商品が変われば品切れを外部へ送らない', async () => {
    testDb.raw.prepare(`INSERT INTO rt_delivery_menu_items (id, account_id, store_id, name, external_item_ids_json, version, created_at, updated_at) VALUES ('item-1', 'account-2', 'store-shibuya', '商品', '{"demaecan":"remote-1"}', 2, 1, 1)`).run();
    const response = await call('/api/restaurant-test/delivery/menu-items/bulk-sold-out', { body: { item_ids: ['item-1'], sold_out: true, expectedStoreId: 'store-shibuya', expectedItems: [{ id: 'item-1', version: 1, target: 'old' }] } });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ items: [{ id: 'item-1', version: 2, soldOut: false }] });
    expect(deliveryCalls).toHaveLength(0);
    expect(dispatchRows()).toHaveLength(0);
  });
  it('確認後に受付の版が変われば外部へ停止を送らない', async () => {
    const response = await call('/api/restaurant-test/delivery/intake/stop', {
      body: { preset: '30m', services: ['demaecan'], expectedStoreId: 'store-shibuya', expectedStates: [{ service: 'demaecan', version: 5, target: 'old' }] }, confirm: INTAKE_STOP_CONFIRM_TOKEN,
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ states: [{ service: 'demaecan', version: 0, intakeStatus: 'open' }] });
    expect(deliveryCalls).toHaveLength(0);
    expect(dispatchRows()).toHaveLength(0);
  });
  it('確認手順を経た受付一括停止は送れたサービスだけ停止にする', async () => {
    const response = await call('/api/restaurant-test/delivery/intake/stop', {
      body: { preset: '30m', services: ['demaecan'] },
      confirm: INTAKE_STOP_CONFIRM_TOKEN,
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      preset: '30m',
      stopped: ['demaecan'],
      failed: [],
    });
    expect(dispatchRows()[0]).toMatchObject({
      action: 'intake_stop',
      target_kind: 'service',
      target_id: 'demaecan',
      status: 'succeeded',
    });
    const state = testDb.raw
      .prepare('SELECT * FROM rt_delivery_service_states WHERE store_id = ? AND service = ?')
      .get('store-shibuya', 'demaecan') as Record<string, unknown> | undefined;
    expect(state).toMatchObject({ intake_status: 'stopped' });
    expect(state?.stop_until).toBe(NOW_SEC + 30 * 60);
  });
  it('停止する長さを選んでいないときは400で返す', async () => {
    const response = await call('/api/restaurant-test/delivery/intake/stop', {
      body: { services: ['demaecan'] },
      confirm: INTAKE_STOP_CONFIRM_TOKEN,
    });
    expect(response.status).toBe(400);
    expect(dispatchRows()).toHaveLength(0);
  });
  it('送信が全部失敗したら受付状態は変えない', async () => {
    sendFailStatus = 429;
    const response = await call('/api/restaurant-test/delivery/intake/stop', {
      body: { preset: '60m', services: ['demaecan'] },
      confirm: INTAKE_STOP_CONFIRM_TOKEN,
    });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ code: 'delivery_rate_limited', retryable: true });
    expect(dispatchRows()[0]).toMatchObject({ status: 'retryable_failed', error_code: 'delivery_rate_limited' });
    expect(
      testDb.raw.prepare('SELECT COUNT(*) AS n FROM rt_delivery_service_states').get(),
    ).toMatchObject({ n: 0 });
  });
  it('受付の再開は確認手順を求めない（元に戻す操作なので）', async () => {
    const stopped = await call('/api/restaurant-test/delivery/intake/stop', {
      body: { preset: '30m', services: ['demaecan'] },
      confirm: INTAKE_STOP_CONFIRM_TOKEN,
    });
    expect(stopped.status).toBe(200);
    const response = await call('/api/restaurant-test/delivery/intake/resume', {
      body: { services: ['demaecan'] },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ success: true, resumed: ['demaecan'] });
    const state = testDb.raw
      .prepare('SELECT * FROM rt_delivery_service_states WHERE store_id = ? AND service = ?')
      .get('store-shibuya', 'demaecan') as Record<string, unknown> | undefined;
    expect(state).toMatchObject({ intake_status: 'open', stop_until: null });
  });
  it('担当者（staff）は受付の再開もできない', async () => {
    useStaffRole('staff');
    const response = await call('/api/restaurant-test/delivery/intake/resume', {
      body: { services: ['demaecan'] },
      token: 'staff-session',
    });
    expect(response.status).toBe(403);
  });
});
describe('書き込みは店舗管理者以上だけ（受入条件1）', () => {
  it('担当者（staff）は注文を受け付けられない', async () => {
    seedOrder();
    useStaffRole('staff');
    const response = await call('/api/restaurant-test/delivery/orders/order-1/accept', {
      body: {},
      token: 'staff-session',
    });
    expect(response.status).toBe(403);
    expect(orderRow()?.status).toBe('new');
    expect(deliveryCalls).toHaveLength(0);
    expect(dispatchRows()).toHaveLength(0);
  });
  it('担当者（staff）は準備完了にできない', async () => {
    seedOrder({ status: 'cooking' });
    useStaffRole('staff');
    const response = await call('/api/restaurant-test/delivery/orders/order-1/ready', {
      body: {},
      token: 'staff-session',
    });
    expect(response.status).toBe(403);
    expect(orderRow()?.status).toBe('cooking');
    expect(deliveryCalls).toHaveLength(0);
  });
  it('担当者（staff）は受け渡し済みにできない', async () => {
    seedOrder({ status: 'cooking' });
    useStaffRole('staff');
    const response = await call('/api/restaurant-test/delivery/orders/order-1/handed-over', {
      body: {},
      token: 'staff-session',
    });
    expect(response.status).toBe(403);
    expect(orderRow()?.status).toBe('cooking');
    expect(deliveryCalls).toHaveLength(0);
  });
  it('担当者（staff）は注文を拒否できない', async () => {
    seedOrder();
    useStaffRole('staff');
    const response = await call('/api/restaurant-test/delivery/orders/order-1/reject', {
      body: { reason_code: 'out_of_stock' },
      token: 'staff-session',
    });
    expect(response.status).toBe(403);
    expect(orderRow()?.status).toBe('new');
  });
  it('担当者（staff）は品切れをまとめて切り替えられない', async () => {
    useStaffRole('staff');
    const response = await call('/api/restaurant-test/delivery/menu-items/bulk-sold-out', {
      body: { item_ids: ['item-1'], sold_out: true },
      token: 'staff-session',
    });
    expect(response.status).toBe(403);
    expect(deliveryCalls).toHaveLength(0);
    expect(dispatchRows()).toHaveLength(0);
  });
  it('見るだけの一覧・履歴・CSV・商品一覧は担当者（staff）でも使える', async () => {
    seedOrder();
    useStaffRole('staff');
    for (const path of [
      '/api/restaurant-test/delivery/orders',
      '/api/restaurant-test/delivery/orders/order-1',
      '/api/restaurant-test/delivery/history',
      '/api/restaurant-test/delivery/history.csv',
      '/api/restaurant-test/delivery/menu-items',
    ]) {
      const response = await call(path, { token: 'staff-session' });
      expect(response.status, path).toBe(200);
    }
  });
});
describe('期限が過ぎた受付停止の自動再開（受入条件2）', () => {
  /** 30分の停止をかける。D-6の窓から送られる形と同じ。 */
  async function stopFor30m() {
    const response = await call('/api/restaurant-test/delivery/intake/stop', {
      body: { preset: '30m', services: ['demaecan'] },
      confirm: INTAKE_STOP_CONFIRM_TOKEN,
    });
    expect(response.status).toBe(200);
    deliveryCalls = [];
    return response;
  }
  function stateRow(service = 'demaecan'): Record<string, unknown> | undefined {
    return testDb.raw
      .prepare('SELECT * FROM rt_delivery_service_states WHERE store_id = ? AND service = ?')
      .get('store-shibuya', service) as Record<string, unknown> | undefined;
  }
  async function servicesFromOrders(): Promise<
    Array<{ service: string; intakeStatus: string; stopUntil: string | null }>
  > {
    const response = await call('/api/restaurant-test/delivery/orders');
    expect(response.status).toBe(200);
    const data = (await response.json()) as {
      services: Array<{ service: string; intakeStatus: string; stopUntil: string | null }>;
    };
    return data.services;
  }
  it('期限が過ぎたら一覧を読んだ時点で受付中へ戻り、再開も送られる', async () => {
    await stopFor30m();
    vi.setSystemTime(new Date(NOW.getTime() + 31 * 60 * 1000));
    const services = await servicesFromOrders();
    expect(services.find((state) => state.service === 'demaecan')).toMatchObject({
      intakeStatus: 'open',
      stopUntil: null,
    });
    expect(deliveryCalls.some((request) => request.url.endsWith('/intake/resume'))).toBe(true);
    expect(stateRow()).toMatchObject({ intake_status: 'open', stop_until: null });
    expect(dispatchRows().at(-1)).toMatchObject({
      action: 'intake_resume',
      target_kind: 'service',
      target_id: 'demaecan',
      status: 'succeeded',
    });
  });
  it('期限内はそのまま停止で残り、再開は送らない', async () => {
    await stopFor30m();
    vi.setSystemTime(new Date(NOW.getTime() + 29 * 60 * 1000));
    const services = await servicesFromOrders();
    expect(services.find((state) => state.service === 'demaecan')?.intakeStatus).toBe('stopped');
    expect(deliveryCalls).toHaveLength(0);
    expect(stateRow()).toMatchObject({ intake_status: 'stopped' });
  });
  it('再開を送れなかったサービスは停止のまま残り、次に読んだ時にもう一度試す', async () => {
    await stopFor30m();
    vi.setSystemTime(new Date(NOW.getTime() + 31 * 60 * 1000));
    sendFailStatus = 429;
    const failed = await servicesFromOrders();
    expect(failed.find((state) => state.service === 'demaecan')?.intakeStatus).toBe('stopped');
    expect(stateRow()).toMatchObject({ intake_status: 'stopped' });
    expect(dispatchRows().at(-1)).toMatchObject({ action: 'intake_resume', status: 'retryable_failed' });
    sendFailStatus = null;
    const retried = await servicesFromOrders();
    expect(retried.find((state) => state.service === 'demaecan')?.intakeStatus).toBe('open');
    expect(stateRow()).toMatchObject({ intake_status: 'open', stop_until: null });
  });
  it('手で再開した後は自動再開を重ねて送らない', async () => {
    await stopFor30m();
    const resumed = await call('/api/restaurant-test/delivery/intake/resume', {
      body: { services: ['demaecan'] },
    });
    expect(resumed.status).toBe(200);
    deliveryCalls = [];
    vi.setSystemTime(new Date(NOW.getTime() + 31 * 60 * 1000));
    const services = await servicesFromOrders();
    expect(services.find((state) => state.service === 'demaecan')?.intakeStatus).toBe('open');
    expect(deliveryCalls).toHaveLength(0);
  });
});
describe('Uber Eats のログイン連携（受入条件1・2・3・4・5）', () => {
  const START_PATH = '/api/restaurant-test/delivery/ubereats/connect/start';
  const CALLBACK_PATH = '/api/restaurant-test/delivery/ubereats/oauth/callback';
  /** 認可画面から戻ってきた作り物の応答。本物のトークンではない。 */
  const FAKE_ACCESS_TOKEN = 'fake-user-access-token';
  function stateRows(): Array<Record<string, unknown>> {
    return testDb.raw
      .prepare('SELECT * FROM rt_delivery_uber_oauth_states ORDER BY created_at, state')
      .all() as Array<Record<string, unknown>>;
  }
  function connectionRows(): Array<Record<string, unknown>> {
    return testDb.raw.prepare('SELECT * FROM rt_delivery_uber_connections ORDER BY store_id').all() as Array<
      Record<string, unknown>
    >;
  }
  function seedState(overrides: Record<string, unknown> = {}): string {
    const row = {
      state: 'state-1',
      account_id: 'account-2',
      store_id: 'store-shibuya',
      staff_id: 'owner-1',
      mode: 'connect',
      expires_at: NOW.getTime() + 600_000,
      used_at: null,
      created_at: NOW.getTime(),
      ...overrides,
    };
    testDb.raw
      .prepare(
        `INSERT INTO rt_delivery_uber_oauth_states
           (state, account_id, store_id, staff_id, mode, expires_at, used_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.state,
        row.account_id,
        row.store_id,
        row.staff_id,
        row.mode,
        row.expires_at,
        row.used_at,
        row.created_at,
      );
    return row.state as string;
  }
  function seedConnection(overrides: Record<string, unknown> = {}): void {
    const row = {
      store_id: 'store-shibuya',
      account_id: 'account-2',
      status: 'connected',
      uber_store_id: 'uber-store-1', uber_store_name: null,
      connected_at: null,
      provisioned_at: null,
      last_error: null,
      updated_at: NOW.getTime(),
      ...overrides,
    };
    testDb.raw
      .prepare(
        `INSERT INTO rt_delivery_uber_connections
           (store_id, account_id, status, uber_store_id, uber_store_name, connected_at, provisioned_at,
            last_error, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        row.store_id, row.account_id,
        row.status,
        row.uber_store_id,
        row.uber_store_name,
        row.connected_at,
        row.provisioned_at,
        row.last_error,
        NOW.getTime(),
        row.updated_at,
      );
  }
  /**
   * 戻り先の受け口は統括の指定を付けずに呼ぶ。
   * call は必ず account_id を足してしまうので、ここでは直接組み立てる。
   */
  async function callback(
    query: Record<string, string>,
    init: { token?: string; cookie?: string } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${ADMIN_SESSION_BEARER_PREFIX}${init.token ?? 'owner-session'}`,
    };
    if (init.cookie !== undefined) headers.Cookie = `lh_uber_state=${init.cookie}`;
    const search = new URLSearchParams(query).toString();
    return await app().request(`${CALLBACK_PATH}?${search}`, { method: 'GET', headers }, env);
  }
  /** 戻り先URLの ubereats= に入った符号。 */
  function resultCodeOf(response: Response): string | null {
    const location = response.headers.get('location');
    expect(location).not.toBeNull();
    return new URL(location!).searchParams.get('ubereats');
  }
  /** 認可の符号をトークンに替える口の作り物。許された権限まで含めて返す。 */
  function stubTokenEndpoint(
    payload: Record<string, unknown> = {
      access_token: FAKE_ACCESS_TOKEN,
      scope: 'eats.pos_provisioning',
      expires_in: 2_592_000,
      refresh_token: '',
    },
    status = 200,
  ): Array<{ url: string; body: string }> {
    const calls: Array<{ url: string; body: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), body: String(init?.body ?? '') });
        return new Response(JSON.stringify(payload), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    return calls;
  }
  it('IDとSecretが無い環境では認可の入口を開けない（受入条件5）', async () => {
    delete (env as Record<string, unknown>).RT_DELIVERY_UBEREATS_CLIENT_ID;
    delete (env as Record<string, unknown>).RT_DELIVERY_UBEREATS_CLIENT_SECRET;
    const res = await call(START_PATH, { body: {} });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ success: false, code: 'oauth_not_configured' });
    expect(stateRows()).toHaveLength(0);
  });
  it('認可の入口は配備の設定から戻り先を組み立て、1回使い切りのstateを10分だけ残す（受入条件2・3）', async () => {
    const res = await call(START_PATH, { body: {} });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mode: string; authorizeUrl: string };
    expect(body.mode).toBe('connect');
    const authorize = new URL(body.authorizeUrl);
    expect(authorize.origin + authorize.pathname).toBe('https://auth.uber.com/oauth/v2/authorize');
    expect(authorize.searchParams.get('client_id')).toBe('test-client-id');
    expect(authorize.searchParams.get('response_type')).toBe('code');
    expect(authorize.searchParams.get('scope')).toBe('eats.pos_provisioning');
    // 呼び出し元のホストではなく WORKER_PUBLIC_URL から作る。
    expect(authorize.searchParams.get('redirect_uri')).toBe(
      'https://worker.example.test/api/restaurant-test/delivery/ubereats/oauth/callback',
    );
    const rows = stateRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      state: authorize.searchParams.get('state'),
      account_id: 'account-2',
      store_id: 'store-shibuya',
      staff_id: 'owner-1',
      mode: 'connect',
      expires_at: NOW.getTime() + 600_000,
      used_at: null,
    });
    expect(String(rows[0].state).length).toBeGreaterThanOrEqual(32);
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('lh_uber_state=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Max-Age=600');
  });
  it('つながっている店舗からの開始は「つなぎ直し」になる（受入条件3）', async () => {
    seedConnection({ status: 'connected' });
    const res = await call(START_PATH, { body: {} });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ mode: 'reconnect' });
    expect(stateRows()[0]).toMatchObject({ mode: 'reconnect' });
  });
  it('担当者の権限では認可の入口を開けない（受入条件3）', async () => {
    useStaffRole('staff');
    const res = await call(START_PATH, { body: {}, token: 'staff-session' });
    expect(res.status).toBe(403);
    expect(stateRows()).toHaveLength(0);
  });
  it('知らないstateでは接続せず、接続情報も作らない（受入条件4）', async () => {
    const calls = stubTokenEndpoint();
    const res = await callback({ state: 'unknown-state', code: 'auth-code' });
    expect(res.status).toBe(302);
    expect(resultCodeOf(res)).toBe('error:invalid_state');
    expect(connectionRows()).toHaveLength(0);
    // 符号の交換そのものを試さない。
    expect(calls).toHaveLength(0);
  });
  it('10分を過ぎたstateでは接続しない（受入条件2・4）', async () => {
    const state = seedState();
    vi.setSystemTime(new Date(NOW.getTime() + 11 * 60 * 1000));
    const calls = stubTokenEndpoint();
    const res = await callback({ state, code: 'auth-code' });
    expect(resultCodeOf(res)).toBe('error:invalid_state');
    expect(connectionRows()).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });
  it('一度使ったstateは二度目では接続しない（受入条件2・4）', async () => {
    const state = seedState({ used_at: NOW.getTime() });
    const calls = stubTokenEndpoint();
    const res = await callback({ state, code: 'auth-code' });
    expect(resultCodeOf(res)).toBe('error:invalid_state');
    expect(connectionRows()).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });
  /**
   * 「読んだ時はまだ未使用、更新しようとしたら既に使われていた」並びを作る。
   * 同じstateのcallbackが2つ同時に来たときの、負けた側の経路そのもの。
   */
  function markUsedByOtherCallbackRightAfterRead(): void {
    const real = env.DB;
    (env as Record<string, unknown>).DB = {
      ...real,
      prepare: (sql: string) => {
        const statement = real.prepare(sql);
        if (!/FROM rt_delivery_uber_oauth_states/i.test(sql)) return statement;
        return {
          ...statement,
          bind: (...args: unknown[]) => {
            const bound = statement.bind(...args);
            return {
              ...bound,
              first: async () => {
                const row = await bound.first();
                // ここで、もう一方のcallbackが先に使い切る。
                testDb.raw
                  .prepare('UPDATE rt_delivery_uber_oauth_states SET used_at = ? WHERE used_at IS NULL')
                  .run(NOW.getTime());
                return row;
              },
            } as unknown as D1PreparedStatement;
          },
        } as unknown as D1PreparedStatement;
      },
    } as unknown as D1Database;
  }
  it('同じstateのcallbackが同時に二度来ても、接続は1件・符号の交換も1回だけ（受入条件3）', async () => {
    const state = seedState();
    const calls = stubTokenEndpoint();
    const [first, second] = await Promise.all([
      callback({ state, code: 'auth-code' }, { cookie: state }),
      callback({ state, code: 'auth-code' }, { cookie: state }),
    ]);
    // どちらが先に着くかは決まらないが、通るのは必ず片方だけ。
    expect([resultCodeOf(first), resultCodeOf(second)].sort()).toEqual([
      'error:invalid_state',
      'pending_store',
    ]);
    expect(connectionRows()).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });
  it('読み取った後に別のcallbackが使い切ったstateでは、符号の交換へ進まない（受入条件3）', async () => {
    const state = seedState();
    const calls = stubTokenEndpoint();
    markUsedByOtherCallbackRightAfterRead();
    const res = await callback({ state, code: 'auth-code' }, { cookie: state });
    expect(resultCodeOf(res)).toBe('error:invalid_state');
    expect(connectionRows()).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });
  it('別の担当者が始めたstateでは接続しない（受入条件4）', async () => {
    useStaffRole('admin');
    const state = seedState({ staff_id: 'admin-1' });
    const calls = stubTokenEndpoint();
    const res = await callback({ state, code: 'auth-code' });
    expect(resultCodeOf(res)).toBe('error:invalid_state');
    expect(connectionRows()).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });
  it('Cookieのstateが食い違うときは接続しない（受入条件4）', async () => {
    const state = seedState();
    const calls = stubTokenEndpoint();
    const res = await callback({ state, code: 'auth-code' }, { cookie: 'state-other' });
    expect(resultCodeOf(res)).toBe('error:invalid_state');
    expect(connectionRows()).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });
  it('店舗が許可しなかったときは使い切ったstateを残し、接続情報は作らない（受入条件4）', async () => {
    const state = seedState();
    const res = await callback({ state, error: 'access_denied' });
    expect(resultCodeOf(res)).toBe('error:denied');
    expect(connectionRows()).toHaveLength(0);
    expect(stateRows()[0].used_at).toBe(NOW.getTime());
  });
  it('認可が通るとトークンを暗号化して1件だけ保存する（受入条件1）', async () => {
    const state = seedState();
    const calls = stubTokenEndpoint();
    const res = await callback({ state, code: 'auth-code' }, { cookie: state });
    expect(res.status).toBe(302);
    expect(resultCodeOf(res)).toBe('pending_store');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://auth.uber.com/oauth/v2/token');
    expect(calls[0].body).toContain('grant_type=authorization_code');
    expect(calls[0].body).toContain(
      'redirect_uri=https%3A%2F%2Fworker.example.test%2Fapi%2Frestaurant-test%2Fdelivery%2Fubereats%2Foauth%2Fcallback',
    );
    const rows = connectionRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      store_id: 'store-shibuya',
      account_id: 'account-2',
      status: 'pending_store',
      granted_scope: 'eats.pos_provisioning',
      connected_by_staff_id: 'owner-1',
      access_token_expires_at: NOW.getTime() + 2_592_000 * 1000,
      version: 1,
      last_error: null,
    });
    // 暗号化した形式だけを保存する。生のトークンはどの欄にも現れない。
    expect(String(rows[0].access_token_enc).startsWith('v1.')).toBe(true);
    expect(JSON.stringify(rows[0])).not.toContain(FAKE_ACCESS_TOKEN);
    // 更新用トークンの欄は作らない。
    expect(Object.keys(rows[0])).not.toContain('refresh_token_enc');
    // 使い切ったstateは二度使えない。
    expect(stateRows()[0].used_at).toBe(NOW.getTime());
  });
  it('つなぎ直しは行を増やさず、同じ店舗の1件を書き換える（受入条件1）', async () => {
    seedConnection({ status: 'expired' });
    const state = seedState({ mode: 'reconnect' });
    stubTokenEndpoint();
    const res = await callback({ state, code: 'auth-code' }, { cookie: state });
    expect(resultCodeOf(res)).toBe('reauthorized');
    const rows = connectionRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'pending_store', uber_store_id: 'uber-store-1',
      last_error: 'pos_disconnect_reauthorization_pending', version: 2 });
  });
  it('権限が足りないときは接続情報を作らず、符号だけを残す（受入条件4）', async () => {
    const state = seedState();
    stubTokenEndpoint({ access_token: FAKE_ACCESS_TOKEN, scope: 'eats.store', expires_in: 2_592_000 });
    const res = await callback({ state, code: 'auth-code' }, { cookie: state });
    expect(resultCodeOf(res)).toBe('error:no_permission');
    expect(connectionRows()).toHaveLength(0);
    // サービスからの自由文は台帳にも記録にも出さない。
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(FAKE_ACCESS_TOKEN);
  });
  it('交換に失敗したときは既にある接続に理由だけを残す（受入条件4）', async () => {
    seedConnection({ status: 'connected' });
    const state = seedState({ mode: 'reconnect' });
    stubTokenEndpoint({ error: 'invalid_grant', message: PROVIDER_FREE_TEXT }, 400);
    const res = await callback({ state, code: 'auth-code' }, { cookie: state });
    expect(resultCodeOf(res)).toBe('error:auth_expired');
    const rows = connectionRows();
    expect(rows).toHaveLength(1);
    // 状態は勝手に変えず、理由の符号だけを足す。
    expect(rows[0]).toMatchObject({ status: 'connected', last_error: 'auth_expired', version: 2 });
    expect(JSON.stringify(rows[0])).not.toContain(PROVIDER_FREE_TEXT);
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(PROVIDER_FREE_TEXT);
  });
  /* ---------------------- いまの接続の状態を読む口 ---------------------- */

  describe('接続状態の読み取り（受入条件4）', () => {
    const CONNECTION_PATH = '/api/restaurant-test/delivery/ubereats/connection';

    it('まだつないでいない店舗は未接続を返し、この環境に設定があることも伝える', async () => {
      const res = await call(CONNECTION_PATH);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        success: true,
        store: { id: 'store-shibuya' },
        oauthConfigured: true,
        connection: { status: 'disconnected', storeName: null, connectedAt: null, lastError: null },
      });
    });

    it('つないだあとは状態と日時を返す。日時はミリ秒から直す', async () => {
      seedConnection({
        status: 'connected',
        uber_store_name: '渋谷店',
        connected_at: NOW.getTime(),
        provisioned_at: NOW.getTime(),
      });

      const res = await call(CONNECTION_PATH);
      const body = (await res.json()) as { connection: Record<string, unknown> };
      expect(body.connection).toMatchObject({ status: 'connected', storeName: '渋谷店' });
      // 秒前提の変換と混ぜると1970年になるため、ここは必ず今の時刻になること。
      expect(body.connection.connectedAt).toBe(NOW.toISOString());
      expect(body.connection.provisionedAt).toBe(NOW.toISOString());
      expect(body.connection.checkedAt).toBe(NOW.toISOString());
    });

    it('ログイン済み・つなぐお店は未選択の段もそのまま返す', async () => {
      seedConnection({ status: 'pending_store' });

      const res = await call(CONNECTION_PATH);
      expect(await res.json()).toMatchObject({
        connection: { status: 'pending_store', storeName: null, provisionedAt: null },
      });
    });

    it('IDとSecretが無い環境では、つなげないことを画面へ伝える', async () => {
      delete (env as Record<string, unknown>).RT_DELIVERY_UBEREATS_CLIENT_ID;
      delete (env as Record<string, unknown>).RT_DELIVERY_UBEREATS_CLIENT_SECRET;

      const res = await call(CONNECTION_PATH);
      expect(await res.json()).toMatchObject({ success: true, oauthConfigured: false });
    });

    it('読み取りのために Uber へ問い合わせない。トークンも返さない', async () => {
      const calls = stubTokenEndpoint();
      seedConnection({ status: 'connected', uber_store_name: '渋谷店' });

      const res = await call(CONNECTION_PATH);
      expect(res.status).toBe(200);
      // トークンの口は1時間100回までなので、画面を開くたびに使ってはいけない。
      expect(calls).toHaveLength(0);
      expect(JSON.stringify(await res.json())).not.toContain('access_token');
    });
  });

  /* ------------------- つなぐお店を選ぶ（フレーム X5d8UF） ------------------- */

  describe('つなぐお店を選ぶ（受入条件1・2・3）', () => {
    const STORES_PATH = '/api/restaurant-test/delivery/ubereats/stores';
    const SELECT_PATH = '/api/restaurant-test/delivery/ubereats/stores/select';
    /** 設定が無ければ本番側のホストになる。この試験環境は環境名を置いていない。 */
    const API_BASE = 'https://api.uber.com';
    const UBER_STORE_ID = 'ue-store-1';

    /** Uber が返す店舗1件分の作り。 */
    function uberStore(overrides: Record<string, unknown> = {}): Record<string, unknown> {
      return {
        store_id: UBER_STORE_ID,
        name: '渋谷店',
        external_store_id: 'EXT-1',
        location: {
          address: '道玄坂1-2-3',
          city: '渋谷区',
          postal_code: '150-0043',
          country: 'JP',
        },
        ...overrides,
      };
    }

    /**
     * ログイン済みの接続を置く。トークンは本物の暗号化で入れる。
     * 復号の経路まで通したいので、ここだけは作り物の文字列を入れない。
     */
    async function seedLoggedIn(
      overrides: { status?: string; expiresAt?: number; connected_at?: number | null } = {},
    ): Promise<void> {
      const { encryptCredential } = await import('@line-crm/db');
      seedConnection({
        status: overrides.status ?? 'pending_store',
        connected_at: overrides.connected_at ?? null,
      });
      testDb.raw
        .prepare(
          `UPDATE rt_delivery_uber_connections
              SET access_token_enc = ?, access_token_expires_at = ?
            WHERE store_id = 'store-shibuya'`,
        )
        .run(
          await encryptCredential(FAKE_ACCESS_TOKEN, ENC_KEY),
          // 既定は取得直後の30日。3日前を切ると取り直しの扱いになる。
          overrides.expiresAt ?? NOW.getTime() + 2_592_000 * 1000,
        );
    }

    function candidateRows(): Array<Record<string, unknown>> {
      return testDb.raw
        .prepare('SELECT * FROM rt_delivery_uber_store_candidates ORDER BY uber_store_id')
        .all() as Array<Record<string, unknown>>;
    }

    function seedCandidate(overrides: Record<string, unknown> = {}): void {
      const row = {
        id: 'cand-old',
        store_id: 'store-shibuya',
        uber_store_id: 'ue-old',
        uber_store_name: '前回の候補',
        external_store_id: null,
        address_text: null,
        ...overrides,
      };
      testDb.raw
        .prepare(
          `INSERT INTO rt_delivery_uber_store_candidates
             (id, store_id, uber_store_id, uber_store_name, external_store_id, address_text, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.id,
          row.store_id,
          row.uber_store_id,
          row.uber_store_name,
          row.external_store_id,
          row.address_text,
          NOW.getTime(),
        );
    }

    function stubUberApi(options: UberStoresApiOptions = {}): ReturnType<typeof stubUberStoresApi> {
      return stubUberStoresApi({ store: uberStore, providerFreeText: PROVIDER_FREE_TEXT }, options);
    }

    it('候補は加盟店のトークンで取り、選べるように控える', async () => {
      await seedLoggedIn();
      const calls = stubUberApi({
        stores: [uberStore(), uberStore({ store_id: 'ue-store-2', name: '新宿店', location: null })],
      });

      const res = await call(STORES_PATH);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        success: true,
        stores: [
          { id: UBER_STORE_ID, name: '渋谷店', address: '150-0043 渋谷区 道玄坂1-2-3' },
          { id: 'ue-store-2', name: '新宿店', address: '' },
        ],
      });

      // 店舗の代理で使うトークンで、一覧の口だけを1回呼ぶ。
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ url: `${API_BASE}/v1/eats/stores`, method: 'GET' });

      // あとで「選べるお店」を照合するため、サーバ側に控えが残る。
      const rows = candidateRows();
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        store_id: 'store-shibuya',
        uber_store_id: UBER_STORE_ID,
        uber_store_name: '渋谷店',
        external_store_id: 'EXT-1',
        address_text: '150-0043 渋谷区 道玄坂1-2-3',
      });
      expect(JSON.stringify(rows)).not.toContain(FAKE_ACCESS_TOKEN);
    });

    it('店舗IDが無い行は候補にしない', async () => {
      await seedLoggedIn();
      stubUberApi({ stores: [{ name: 'IDの無いお店' }, uberStore()] });

      const res = await call(STORES_PATH);
      expect((await res.json()) as unknown).toMatchObject({
        stores: [{ id: UBER_STORE_ID }],
      });
      expect(candidateRows()).toHaveLength(1);
    });

    it('取り直すと前回の候補は残らない', async () => {
      await seedLoggedIn();
      seedCandidate();
      stubUberApi();

      await call(STORES_PATH);

      const rows = candidateRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].uber_store_id).toBe(UBER_STORE_ID);
    });

    it('まだログインしていない店舗には一覧を出さない', async () => {
      seedConnection({ status: 'disconnected' });
      const calls = stubUberApi();

      const res = await call(STORES_PATH);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'not_connected' });
      expect(calls).toHaveLength(0);
    });

    it('期限が近いトークンは使わず、つなぎ直しを促して状態も入れ替える', async () => {
      // 30日のうち残り1日。取り直しの境目（3日）を切っている。
      await seedLoggedIn({ status: 'connected', expiresAt: NOW.getTime() + 86_400_000 });
      const calls = stubUberApi();

      const res = await call(STORES_PATH);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'auth_expired' });
      expect(calls).toHaveLength(0);
      const rows = connectionRows();
      expect(rows[0]).toMatchObject({ status: 'expired', last_error: 'auth_expired', version: 2 });
    });
    it('鍵が無い環境では、復号できないことだけを伝える', async () => {
      await seedLoggedIn();
      // 置いたあとで鍵を外す。鍵が変わった場合も同じ道を通る。
      delete (env as Record<string, unknown>).LINE_CREDENTIAL_ENCRYPTION_KEY;
      const calls = stubUberApi();
      const res = await call(STORES_PATH);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'encryption_key_missing' });
      expect(calls).toHaveLength(0);
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(ENC_KEY);
    });
    it('一覧が取れないときは分類済みの符号だけを残す', async () => {
      await seedLoggedIn({ status: 'connected' });
      // 401は再試行しない相手の拒否。権限切れとして扱う。
      stubUberApi({ listStatus: 401 });
      const { res, trace } = await withInvocation('http', async () => ({
        res: await call(STORES_PATH), trace: currentInvocation()!,
      }));
      expect(errorSpy.mock.calls.map((args: unknown[]) => JSON.parse(String(args[0])))).toContainEqual(expect.objectContaining({
        code: 'restaurant_delivery.restaurant_test_delivery_ubereats_stores_list_failed', level: 'error', source: 'http',
        requestId: trace.requestId, invocationId: trace.invocationId,
      }));
      expect(res.status).toBe(502);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toMatchObject({ code: 'auth_expired' });
      expect(JSON.stringify(body)).not.toContain(PROVIDER_FREE_TEXT);
      const rows = connectionRows();
      expect(rows[0]).toMatchObject({ status: 'expired', last_error: 'auth_expired' });
      expect(JSON.stringify(rows)).not.toContain(PROVIDER_FREE_TEXT);
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(PROVIDER_FREE_TEXT);
      // 取れなかったときに古い候補を消したままにしない（画面が空にならないこと）。
      expect(candidateRows()).toHaveLength(0);
    });
    it('一覧取得の一時的な失敗も接続の版を進める', async () => {
      await seedLoggedIn({ status: 'connected' });
      stubUberApi({ listStatus: 500 });
      expect((await call(STORES_PATH)).status).toBe(502);
      expect(connectionRows()[0]).toMatchObject({ status: 'connected', version: 2 });
    });

    it('IDとSecretが無い環境では一覧も確定も止める', async () => {
      await seedLoggedIn();
      delete (env as Record<string, unknown>).RT_DELIVERY_UBEREATS_CLIENT_ID;
      delete (env as Record<string, unknown>).RT_DELIVERY_UBEREATS_CLIENT_SECRET;
      const calls = stubUberApi();

      const list = await call(STORES_PATH);
      expect(list.status).toBe(503);
      expect(await list.json()).toMatchObject({ code: 'oauth_not_configured' });

      const select = await call(SELECT_PATH, { body: { storeId: UBER_STORE_ID } });
      expect(select.status).toBe(503);
      expect(calls).toHaveLength(0);
    });

    it('控えていないお店は Uber へ送らない', async () => {
      await seedLoggedIn();
      seedCandidate({ uber_store_id: 'ue-other' });
      const calls = stubUberApi();

      const res = await call(SELECT_PATH, { body: { storeId: UBER_STORE_ID } });
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ code: 'store_not_candidate' });
      // 画面から来たIDをそのまま相手へ渡さない。
      expect(calls).toHaveLength(0);
      expect(connectionRows()[0]).toMatchObject({ status: 'pending_store', provisioned_at: null });
    });

    it('お店を選ばずに確定しようとしたら止める', async () => {
      await seedLoggedIn();
      const calls = stubUberApi();

      const res = await call(SELECT_PATH, { body: { storeId: '  ' } });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'store_id_required' });
      expect(calls).toHaveLength(0);
    });

    it('確定すると Uber 側の連携を有効にし、接続中として残して候補を消す', async () => {
      const connectedAt = NOW.getTime() - 60_000;
      await seedLoggedIn({ status: 'pending_store', connected_at: connectedAt });
      const calls = stubUberApi();
      await call(STORES_PATH);

      const res = await call(SELECT_PATH, { body: { storeId: UBER_STORE_ID } });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        success: true,
        connection: {
          status: 'connected',
          storeName: '渋谷店',
          provisionedAt: NOW.toISOString(),
          lastError: null,
        },
      });

      // 一覧の1回と、連携の有効化の1回だけ。重ねて送らない。
      const posCalls = calls.filter((entry) => entry.url.endsWith('/pos_data'));
      expect(posCalls).toHaveLength(1);
      expect(posCalls[0]).toMatchObject({
        url: `${API_BASE}/v1/eats/stores/${UBER_STORE_ID}/pos_data`,
        method: 'POST',
      });
      expect(JSON.parse(posCalls[0].body)).toEqual({
        integrator_store_id: 'store-shibuya',
        is_order_manager: true,
      });

      const rows = connectionRows();
      expect(rows[0]).toMatchObject({
        uber_store_id: UBER_STORE_ID,
        uber_store_name: '渋谷店',
        external_store_id: 'EXT-1',
        status: 'connected',
        // ログインした時刻は上書きしない。
        connected_at: connectedAt,
        provisioned_at: NOW.getTime(),
        last_error: null,
        version: 3,
      });
      // 選び終わった候補は残さない。
      expect(candidateRows()).toHaveLength(0);
      expect(JSON.stringify(rows)).not.toContain(FAKE_ACCESS_TOKEN);
    });

    it('連携の有効化が失敗したら理由の符号だけを残し、接続中にしない', async () => {
      await seedLoggedIn();
      const calls = stubUberApi({ posStatus: 503 });
      await call(STORES_PATH);

      const { res, trace } = await withInvocation('http', async () => ({
        res: await call(SELECT_PATH, { body: { storeId: UBER_STORE_ID } }), trace: currentInvocation()!,
      }));
      expect(errorSpy.mock.calls.map((args: unknown[]) => JSON.parse(String(args[0])))).toContainEqual(expect.objectContaining({
        code: 'restaurant_delivery.restaurant_test_delivery_ubereats_stores_select_create_failed', level: 'error', source: 'http',
        requestId: trace.requestId, invocationId: trace.invocationId,
      }));
      expect(res.status).toBe(502);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toMatchObject({ code: 'pos_activation_unknown' });
      expect(JSON.stringify(body)).not.toContain(PROVIDER_FREE_TEXT);

      // 二重に送ると連携が重なるので、失敗しても自動で送り直さない。
      expect(calls.filter((entry) => entry.url.endsWith('/pos_data'))).toHaveLength(1);

      const rows = connectionRows();
      expect(rows[0]).toMatchObject({
        status: 'pending_store',
        provisioned_at: null,
        last_error: 'pos_activation_unknown', version: 3,
      });
      expect(JSON.stringify(rows)).not.toContain(PROVIDER_FREE_TEXT);
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(PROVIDER_FREE_TEXT);
      // 取り直さずに選び直せるよう、候補は残す。
      expect(candidateRows()).toHaveLength(1);
    });
    it('外部が503なら再表示・候補再取得・再認可でも送信開始を消さない', async () => {
      await seedLoggedIn();
      const calls = stubUberApi({ posStatus: 503 });
      await call(STORES_PATH);
      const first = await call(SELECT_PATH, { body: { storeId: UBER_STORE_ID } });
      expect(first.status).toBe(502);
      expect(await first.json()).toMatchObject({ code: 'pos_activation_unknown' });
      for (const path of [SELECT_PATH, STORES_PATH, '/api/restaurant-test/delivery/ubereats/connect/start']) {
        const res = await call(path, path === STORES_PATH ? {} : { body: { storeId: UBER_STORE_ID } });
        expect(res.status).toBe(409);
        expect(await res.json()).toMatchObject({ code: 'pos_activation_unknown' });
      }
      expect(calls.filter((entry) => entry.url.endsWith('/pos_data'))).toHaveLength(1);
      expect(connectionRows()[0]).toMatchObject({ status: 'pending_store', last_error: 'pos_activation_unknown', uber_store_id: UBER_STORE_ID });
    });

    it('外部受理後にD1保存が失敗してもstartedを残し、再送しない', async () => {
      await seedLoggedIn();
      const calls = stubUberApi();
      await call(STORES_PATH);
      testDb.raw.exec(`CREATE TRIGGER stop_activation_save BEFORE UPDATE OF status ON rt_delivery_uber_connections
        WHEN NEW.status = 'connected' BEGIN SELECT RAISE(ABORT, 'test storage failure'); END;`);
      const first = await call(SELECT_PATH, { body: { storeId: UBER_STORE_ID } });
      expect(first.status).toBe(502);
      expect(await first.json()).toMatchObject({ code: 'pos_activation_unknown' });
      expect(connectionRows()[0]).toMatchObject({ status: 'pending_store', last_error: 'pos_activation_started' });
      testDb.raw.exec('DROP TRIGGER stop_activation_save');
      const second = await call(SELECT_PATH, { body: { storeId: UBER_STORE_ID } });
      expect(second.status).toBe(409);
      expect(calls.filter((entry) => entry.url.endsWith('/pos_data'))).toHaveLength(1);
    });

    it('通信断は不明として止め、外部の自由文や秘密値を残さない', async () => {
      await seedLoggedIn();
      seedCandidate({ uber_store_id: UBER_STORE_ID });
      const external = vi.fn(async () => { throw new Error(PROVIDER_FREE_TEXT); });
      vi.stubGlobal('fetch', external);
      const first = await call(SELECT_PATH, { body: { storeId: UBER_STORE_ID } });
      expect(first.status).toBe(502);
      expect(await first.json()).toMatchObject({ code: 'pos_activation_unknown' });
      const second = await call(SELECT_PATH, { body: { storeId: UBER_STORE_ID } });
      expect(second.status).toBe(409);
      expect(external).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(connectionRows()) + JSON.stringify(errorSpy.mock.calls)).not.toContain(PROVIDER_FREE_TEXT);
    });

    it('同じ店舗を並行して確定しても外部へは1回しか送らない', async () => {
      await seedLoggedIn();
      seedCandidate({ uber_store_id: UBER_STORE_ID });
      const calls = stubUberApi();
      let markStarted!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => { markStarted = resolve; });
      const released = new Promise<void>((resolve) => { release = resolve; });
      const respond = fetch;
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const response = await respond(input, init);
        if (String(input).endsWith('/pos_data')) { markStarted(); await released; }
        return response;
      }));
      const first = Promise.resolve(call(SELECT_PATH, { body: { storeId: UBER_STORE_ID } }));
      try {
        // 外部の応答前に重ね、成功後の候補削除とは別の競合を確かめる。
        await Promise.race([started, first.then(() => { throw new Error('POS response was not reached'); })]);
        const second = await call(SELECT_PATH, { body: { storeId: UBER_STORE_ID } });
        expect(second.status).toBe(409);
      } finally { release(); }
      expect((await first).status).toBe(200);
      expect(calls.filter((entry) => entry.url.endsWith('/pos_data'))).toHaveLength(1);
      expect(connectionRows()[0]).toMatchObject({ status: 'connected', last_error: null });
      const late = await call(SELECT_PATH, { body: { storeId: UBER_STORE_ID } });
      expect(late.status).toBe(404);
      expect(await late.json()).toMatchObject({ code: 'store_not_candidate' });
      expect(calls.filter((entry) => entry.url.endsWith('/pos_data'))).toHaveLength(1);
    });

    it('POSの確定拒否401は期限切れと分かる形で止め、再送しない', async () => {
      await seedLoggedIn();
      seedCandidate({ uber_store_id: UBER_STORE_ID });
      const calls = stubUberApi({ posStatus: 401 });
      const res = await call(SELECT_PATH, { body: { storeId: UBER_STORE_ID } });
      expect(res.status).toBe(502);
      expect(await res.json()).toMatchObject({ code: 'auth_expired' });
      expect(connectionRows()[0]).toMatchObject({ status: 'expired', last_error: 'auth_expired' });
      expect(calls).toHaveLength(1);
    });

    it('入力の誤りは項目を返し、外部へ送らない', async () => {
      const calls = stubUberApi();
      const res = await call(SELECT_PATH, { body: {} });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'store_id_required', fields: { storeId: 'つなぐお店を選んでください' } });
      expect(calls).toHaveLength(0);
    });

  });
});

/* ====================== 受信口の応答時間（出前館QA#10） ====================== */

/**
 * 出前館QA#10「出前館からのリクエストに対して1秒以内での応答が可能である」の実測。
 *
 * 測るのは受信口に入ってから応答を返すまでの処理だけ。
 * 署名の検証・受信台帳への記録・注文（またはキャンセル）の取り込み・受信台帳の締めが含まれる。
 * 署名を作るのは相手の仕事なので、要求は測る前に組み立てておく。
 *
 * この数字は同じコードを手元の SQLite に当てた値である。回線の往復と D1 の遠隔呼び出しは
 * 含まれないため、配備後にもう一度測り直す前提の下限として読む。
 * 1秒という約束に対して手元で桁違いに余裕があることを確かめ、
 * 外への送信を応答の前に挟まない（受け取って即返す）作りを固定するのがここの役目。
 */
describe('受信口の応答時間（出前館QA#10）', () => {
  /** 出前館との約束。1件の応答がこれを超えてはいけない。 */
  const BUDGET_MS = 1000;
  /** 測る回数。1回だけだと最初の読み込みの重さに引きずられる。 */
  const SAMPLES = 20;

  function percentile(sorted: number[], ratio: number): number {
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
    return sorted[index] ?? 0;
  }

  /**
   * 署名まで作り終えた呼び出しを並べる。
   * 署名づくり（相手側の仕事）を測ってしまわないよう、ここで先に済ませる。
   */
  async function prepared(
    count: number,
    make: (index: number) => unknown,
  ): Promise<Array<() => Promise<Response>>> {
    const instance = app();
    const calls: Array<() => Promise<Response>> = [];
    for (let index = 0; index < count; index += 1) {
      const rawBody = JSON.stringify(make(index));
      const timestamp = String(NOW_SEC);
      const signature = await signWebhook(NOW_SEC, rawBody);
      calls.push(async () =>
        instance.request(
          '/api/restaurant-test/delivery/webhooks/demaecan',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-nen-timestamp': timestamp,
              'x-nen-signature': signature,
            },
            body: rawBody,
          },
          env,
        ),
      );
    }
    return calls;
  }

  /** 1件ずつ順番に叩いて、かかった時間を集める。時計は偽物にしていない performance を使う。 */
  async function measure(
    label: string,
    calls: Array<() => Promise<Response>>,
  ): Promise<{ p50: number; p95: number; max: number }> {
    const durations: number[] = [];
    for (const call of calls) {
      const startedAt = performance.now();
      const response = await call();
      durations.push(performance.now() - startedAt);
      // 速いだけで中身が落ちていては意味がない。全件 200 で返ること。
      expect(response.status).toBe(200);
    }
    durations.sort((left, right) => left - right);
    const stats = {
      p50: percentile(durations, 0.5),
      p95: percentile(durations, 0.95),
      max: durations[durations.length - 1] ?? 0,
    };
    // QAの備考欄へ書き写すための実測値。console.info は試験の中で差し替えていない。
    console.info(
      `[QA#10] ${label} n=${calls.length} p50=${stats.p50.toFixed(1)}ms`
      + ` p95=${stats.p95.toFixed(1)}ms max=${stats.max.toFixed(1)}ms budget=${BUDGET_MS}ms`,
    );
    return stats;
  }

  it('注文の取り込みは1件ずつ1秒以内に応答する', async () => {
    // 最初の1回は読み込みと組み立ての重さが乗る。測る前に捨てる。
    await postWebhook(
      orderCreatedPayload({ eventId: 'evt-warmup', externalOrderId: 'DM-WARM', orderNumber: '#DM-WARM' }),
    );
    const calls = await prepared(SAMPLES, (index) =>
      orderCreatedPayload({
        eventId: `evt-perf-${index}`,
        externalOrderId: `DM-${8000 + index}`,
        orderNumber: `#DM-${8000 + index}`,
      }),
    );

    const stats = await measure('order.created', calls);
    expect(stats.max).toBeLessThan(BUDGET_MS);
    // 取りこぼしがないこと。暖機の1件を足した数になる。
    expect(testDb.raw.prepare('SELECT COUNT(*) AS n FROM rt_delivery_orders').get()).toMatchObject({
      n: SAMPLES + 1,
    });
  });

  it('品数が上限（100品）の注文でも1秒以内に応答する', async () => {
    // 受信口が受け付ける品数の上限。手元で測れる最も重い取り込み。
    const items = Array.from({ length: 100 }, (_unused, index) => ({
      name: `品目${index + 1}`,
      quantity: 1,
      amount: 500,
    }));
    const calls = await prepared(5, (index) => ({
      event_id: `evt-bulk-${index}`,
      event_type: 'order.created',
      store_id: 'store-shibuya',
      order: {
        external_order_id: `DM-${8500 + index}`,
        order_number: `#DM-${8500 + index}`,
        total_amount: 50_000,
        pickup_method: '配達（出前館 配達員）',
        wanted_at: NOW_SEC + 1500,
        received_at: NOW_SEC - 30,
        items,
      },
    }));

    const stats = await measure('order.created(100品)', calls);
    expect(stats.max).toBeLessThan(BUDGET_MS);
    expect(testDb.raw.prepare('SELECT COUNT(*) AS n FROM rt_delivery_order_items').get()).toMatchObject({
      n: 500,
    });
  });

  it('キャンセルの取り込みも1件ずつ1秒以内に応答する', async () => {
    for (let index = 0; index < SAMPLES; index += 1) {
      seedOrder({ id: `order-perf-${index}`, status: 'cooking', externalOrderId: `DM-${7000 + index}` });
    }
    const calls = await prepared(SAMPLES, (index) => ({
      event_id: `evt-cancel-perf-${index}`,
      event_type: 'order.canceled',
      store_id: 'store-shibuya',
      cancel: { external_order_id: `DM-${7000 + index}`, canceled_by: 'customer' },
    }));

    const stats = await measure('order.canceled', calls);
    expect(stats.max).toBeLessThan(BUDGET_MS);
    expect(
      testDb.raw.prepare(`SELECT COUNT(*) AS n FROM rt_delivery_orders WHERE status = 'canceled'`).get(),
    ).toMatchObject({ n: SAMPLES });
  });

  it('再送された通知は取り込みへ進まず、取り込みより速く返す', async () => {
    const payload = orderCreatedPayload({
      eventId: 'evt-dup-perf',
      externalOrderId: 'DM-7900',
      orderNumber: '#DM-7900',
    });
    expect((await postWebhook(payload)).status).toBe(200);
    const calls = await prepared(SAMPLES, () => payload);

    const stats = await measure('order.created(再送)', calls);
    expect(stats.max).toBeLessThan(BUDGET_MS);
    // 受信台帳の一意制約で弾くだけ。注文は増えない。
    expect(testDb.raw.prepare('SELECT COUNT(*) AS n FROM rt_delivery_orders').get()).toMatchObject({ n: 1 });
  });

  it('応答を返す前に相手のサービスへ送信しない。外向きの通信は応答に乗らない', async () => {
    // 1秒の約束を守れる根拠は「受け取って即返す」こと。
    // 受信の処理の中で外へ繋ぎに行くと、相手の遅さがそのまま応答時間になる。
    await postWebhook(orderCreatedPayload({ eventId: 'evt-no-egress', externalOrderId: 'DM-7800' }));
    expect(deliveryCalls).toHaveLength(0);
  });
});

/**
 * Uber Sandbox への接続確認（トークン1回）の口。
 * 配備先の秘密設定を外へ出さずに「中から1回だけ送る」ための運用の口なので、
 * 管理画面の認証ではなく合言葉の署名で守る。ここでは守りの側を確かめる。
 */
describe('Uber Sandbox 接続確認の口', () => {
  const PROBE_PATH = '/internal/ubereats/sandbox-token-probe';
  /** 32文字以上でないと口は開かない（uberProbeSecret）。本物の値ではない。 */
  const PROBE_SECRET = 'ubereats-probe-secret-0123456789ab';

  /** 合言葉で署名して投げる。`署名なし` のときは見出しを付けない。 */
  async function postProbe(options: { secret?: string | null; skew?: number; body?: string } = {}) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const body = options.body ?? '{}';
    if (options.secret) {
      const timestamp = String(Math.floor(Date.now() / 1000) + (options.skew ?? 0));
      headers['x-nen-timestamp'] = timestamp;
      headers['x-nen-signature'] = await signSupportRelay(options.secret, timestamp, body);
    }
    return app().request(PROBE_PATH, { method: 'POST', headers, body }, env);
  }

  it('合言葉が届いていないときは口は開かない。署名があっても実行しない', async () => {
    const response = await postProbe({ secret: PROBE_SECRET });
    expect(response.status).toBe(503);
    // 「届いていない」と「短すぎる」を分けて返す。配備先の切り分けに使う。
    await expect(response.json()).resolves.toMatchObject({ code: 'probe_secret_missing' });
    expect(deliveryCalls).toHaveLength(0);
  });

  it('合言葉が短すぎるときは、その理由を分けて返す。長さと値は返さない', async () => {
    const short = 'too-short-probe-secret';
    env = { ...env, RT_DELIVERY_UBEREATS_PROBE_SECRET: short } as Env['Bindings'];
    const response = await postProbe({ secret: short });
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ success: false, code: 'probe_secret_too_short' });
    expect(body).not.toContain(String(short.length));
    expect(body).not.toContain(short);
    expect(deliveryCalls).toHaveLength(0);
  });

  it('下見の本文は Uber へ送らず、冷却時間も使わない', async () => {
    env = {
      ...env,
      RT_DELIVERY_UBEREATS_PROBE_SECRET: PROBE_SECRET,
      RT_DELIVERY_UBEREATS_ENVIRONMENT: 'sandbox',
    } as Env['Bindings'];

    const response = await postProbe({ secret: PROBE_SECRET, body: '{"mode":"check"}' });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({
      success: true,
      mode: 'check',
      environment: 'sandbox',
      oauthConfigured: true,
    });
    expect(body).not.toContain('test-client-secret');
    expect(body).not.toContain(PROBE_SECRET);
    // Uber へは1回も送らず、1回分として数えもしない。
    expect(deliveryCalls).toHaveLength(0);
    const rows = testDb.raw
      .prepare('SELECT value FROM platform_settings WHERE key = ?')
      .all(UBER_PROBE_LAST_RUN_KEY);
    expect(rows).toHaveLength(0);
  });

  it('署名がない・違う・時刻がずれている依頼は実行しない', async () => {
    env = { ...env, RT_DELIVERY_UBEREATS_PROBE_SECRET: PROBE_SECRET } as Env['Bindings'];

    const noSignature = await postProbe();
    expect(noSignature.status).toBe(401);
    await expect(noSignature.json()).resolves.toMatchObject({ code: 'probe_unauthorized' });

    const wrongSecret = await postProbe({ secret: 'wrong-probe-secret-0123456789abcdef' });
    expect(wrongSecret.status).toBe(401);

    // 署名は正しいが時刻が10分先。使い回しを防ぐため受け取らない。
    const stale = await postProbe({ secret: PROBE_SECRET, skew: 600 });
    expect(stale.status).toBe(401);

    expect(deliveryCalls).toHaveLength(0);
  });

  it('接続先が Sandbox でないときは実行しない。本番の Uber へは送らない', async () => {
    env = { ...env, RT_DELIVERY_UBEREATS_PROBE_SECRET: PROBE_SECRET } as Env['Bindings'];
    const response = await postProbe({ secret: PROBE_SECRET });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: 'probe_sandbox_only' });
    expect(deliveryCalls).toHaveLength(0);
  });

  it('成功したら権限の名と残り秒だけを返す。トークンの値・秘密値は返さない', async () => {
    env = {
      ...env,
      RT_DELIVERY_UBEREATS_PROBE_SECRET: PROBE_SECRET,
      RT_DELIVERY_UBEREATS_ENVIRONMENT: 'sandbox',
    } as Env['Bindings'];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        deliveryCalls.push({ url, init });
        return new Response(
          JSON.stringify({ access_token: 'probe-access-token', expires_in: 2_592_000, scope: 'eats.order' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );

    const response = await postProbe({ secret: PROBE_SECRET });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({
      success: true,
      environment: 'sandbox',
      scope: ['eats.order'],
      expiresInSec: 2_592_000,
    });
    expect(body).not.toContain('probe-access-token');
    expect(body).not.toContain('test-client-secret');
    expect(body).not.toContain(PROBE_SECRET);
    // 外へ出たのは Sandbox のトークンの口へ1回だけ。
    expect(deliveryCalls).toHaveLength(1);
    expect(deliveryCalls[0]?.url).toBe('https://sandbox-login.uber.com/oauth/v2/token');
  });

  it('冷却時間の中の2回目は実行せず、待ち秒を返す', async () => {
    env = {
      ...env,
      RT_DELIVERY_UBEREATS_PROBE_SECRET: PROBE_SECRET,
      RT_DELIVERY_UBEREATS_ENVIRONMENT: 'sandbox',
    } as Env['Bindings'];
    testDb.raw
      .prepare('INSERT OR REPLACE INTO platform_settings (key, value) VALUES (?, ?)')
      .run(UBER_PROBE_LAST_RUN_KEY, String(Date.now()));

    const response = await postProbe({ secret: PROBE_SECRET });
    expect(response.status).toBe(429);
    const body = (await response.json()) as { code: string; retryAfterSec: number };
    expect(body.code).toBe('probe_cooldown');
    expect(body.retryAfterSec).toBeGreaterThan(0);
    expect(deliveryCalls).toHaveLength(0);
  });
});
