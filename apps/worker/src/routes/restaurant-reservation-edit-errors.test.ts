import { seedRestaurantFixture as seedRestaurantData } from '../test-utils/restaurant-fixture.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';

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

const authMocks = vi.hoisted(() => ({
  getPlatformSetting: async () => 'false', // Explicit Off fixture for route authorization.
  getStaffByApiKey: vi.fn(async (): Promise<MockStaff | null> => null),
  getStaffByAdminSession: vi.fn(async (): Promise<MockStaff | null> => null),
  lineAccounts: [] as Array<Record<string, unknown>>,
}));

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

const { authMiddleware, sha256Hex } = await import('../middleware/auth.js');
const { restaurantTest } = await import('./restaurant-test.js');
const { apiContractMiddleware } = await import('../middleware/api-contract.js');
type Env = import('../index.js').Env;

const here = dirname(fileURLToPath(import.meta.url));
let testDb: SqliteD1;
let env: Env['Bindings'];

const seedRestaurantFixture = (options?: Parameters<typeof seedRestaurantData>[1]) => seedRestaurantData(testDb, options);

function app() {
  const instance = new Hono<Env>();
  instance.use('*', apiContractMiddleware);
  instance.use('*', authMiddleware);
  instance.route('/', restaurantTest);
  return instance;
}

function requestWithMethod(path: string, method: string, body?: unknown, token = 'owner-key') {
  if((method==='PUT'&&path.includes('/tables/layout')||method==='PATCH'&&path.includes('/tables/'))&&body&&typeof body==='object'&&!('expectedVersion' in body)){const table=path.match(/\/tables\/([^/?]+)/)?.[1];const floor=table?testDb.raw.prepare('SELECT f.version FROM rt_floors f JOIN rt_tables t ON t.floor_id=f.id WHERE t.id=?').get(table):testDb.raw.prepare("SELECT version FROM rt_floors WHERE store_id=?").get((body as {storeId:string}).storeId);body={...body,expectedVersion:(floor as {version:number}|undefined)?.version??1}}

  const id=path.match(/^\/api\/restaurant-test\/reservations\/([^/?]+)(?:\?|$)/)?.[1];
  if(method==='PATCH'&&id&&body&&typeof body==='object'&&!('expectedVersion' in body))body={...body,expectedVersion:((testDb.raw.prepare('SELECT customer_version FROM rt_reservations WHERE id=?').get(id)) as {customer_version:number}|undefined)?.customer_version??1};

  return app().request(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, env);
}

beforeEach(() => {
  authMocks.getStaffByApiKey.mockReset();
  authMocks.getStaffByApiKey.mockResolvedValue(null);
  authMocks.getStaffByAdminSession.mockReset();
  authMocks.getStaffByAdminSession.mockResolvedValue(null);
  authMocks.lineAccounts = [
    { id: 'account-1', name: '統括', is_active: 1, channel_access_token: 'token-1' },
    { id: 'account-2', name: '店舗A', is_active: 1, channel_access_token: 'token-2' },
    { id: 'account-3', name: '店舗B', is_active: 1, channel_access_token: 'token-3' },
    { id: 'account-4', name: '予備', is_active: 1, channel_access_token: 'token-4' },
  ];
  testDb = createTestD1({ loginPolicy: 'off' });
  testDb.raw.exec(readFileSync(join(here, '../../../../packages/db/migrations/168_restaurant_test_foundation.sql'), 'utf8'));
  testDb.raw.exec(readFileSync(join(here, '../../../../packages/db/migrations/175_restaurant_terms_agreement.sql'), 'utf8'));
  // 統括ゲート（飲食店機能パック）。このAPI群自体を検証するファイルなので
  // 既定の統括には常にパックを付けておく。ゲート自体の検証（無し→404）は
  // 別のdescribeで明示的に上書きする。
  testDb.raw.prepare(`UPDATE tenants SET feature_packs = '["restaurant"]' WHERE id = '00000000-0000-4000-8000-000000000001'`).run();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    endpoint: 'https://worker.example.test/webhook',
    active: true,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
  env = {
    DB: testDb.db,
    API_KEY: 'owner-key',
    IMAGES: {} as R2Bucket,
    RAW_MAIL: {} as R2Bucket,
    ASSETS: {} as Fetcher,
    RESTAURANT_INTAKE_DOMAIN: 'intake.example.test',
    DEPLOY_ENV: 'test', RESTAURANT_TEST_ENABLED: 'true',
    LINE_CHANNEL_SECRET: 'unused', LINE_CHANNEL_ACCESS_TOKEN: 'unused',
    LIFF_URL: 'https://example.test', LINE_CHANNEL_ID: 'unused',
    LINE_LOGIN_CHANNEL_ID: 'unused', LINE_LOGIN_CHANNEL_SECRET: 'unused',
    WORKER_URL: 'https://worker.example.test',
    LINE_CREDENTIAL_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  };
});


afterEach(() => { vi.unstubAllGlobals(); testDb.raw.close() })
it('空き卓の衝突符号と理由は認証と外側の応答契約を通っても届く', async () => {
  seedRestaurantFixture()
  const response = await requestWithMethod('/api/restaurant-test/reservations/reservation-ginza?account_id=account-1', 'PATCH', { guestCount: 99, expectedVersion: 1 })
  expect(response.status).toBe(409)
  const body = await response.json() as { error: { code: string; message: string; fieldErrors: unknown[]; requestId: string } }
  expect(body.error).toMatchObject({ code: 'availability_conflict', message: '人数・休業・卓の停止を確認してください', fieldErrors: [] })
  expect(body.error.requestId).toBe(response.headers.get('X-Request-ID'))
  expect(testDb.raw.prepare("SELECT guest_count,customer_version FROM rt_reservations WHERE id='reservation-ginza'").get()).toMatchObject({ guest_count: 2, customer_version: 1 })
  expect(fetch).not.toHaveBeenCalled()
})
it('入力の失敗は実際の欄名を応答する', async () => {
  seedRestaurantFixture()
  const response = await requestWithMethod('/api/restaurant-test/reservations/reservation-ginza?account_id=account-1', 'PATCH', { tableId: 'other-store-table', expectedVersion: 1 })
  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({ error: { fieldErrors: [{ field: 'tableId', message: '卓が正しくありません' }] } })
  expect(fetch).not.toHaveBeenCalled()
})

it('予約の取消理由を取消状態と同時に保存し、通常の編集では保持する', async () => {
  seedRestaurantFixture()
  const path = '/api/restaurant-test/reservations/reservation-ginza?account_id=account-1'
  const invalid = await requestWithMethod(path, 'PATCH', { status: 'cancelled', cancellationReason: '  ' })
  expect(invalid.status).toBe(400)
  expect(testDb.raw.prepare('SELECT status, cancel_reason FROM rt_reservations WHERE id=?').get('reservation-ginza')).toEqual({ status: 'confirmed', cancel_reason: null })
  const cancelled = await requestWithMethod(path, 'PATCH', { status: 'cancelled', cancellationReason: '  店舗の都合  ', cancellationCause:'store' })
  expect(cancelled.status).toBe(200)
  expect(testDb.raw.prepare('SELECT status, cancel_reason FROM rt_reservations WHERE id=?').get('reservation-ginza')).toEqual({ status: 'cancelled', cancel_reason: '店舗の都合' })
  const edit = await requestWithMethod(path, 'PATCH', { note: '確認済み' })
  expect(edit.status).toBe(200)
  expect(testDb.raw.prepare('SELECT cancel_reason FROM rt_reservations WHERE id=?').get('reservation-ginza')).toEqual({ cancel_reason: '店舗の都合' })
})
