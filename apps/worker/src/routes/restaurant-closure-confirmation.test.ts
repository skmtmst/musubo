import { seedRestaurantFixture as seedRestaurantData } from '../test-utils/restaurant-fixture.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';

const authMocks = vi.hoisted(() => ({
  getPlatformSetting: async () => 'false',
  getStaffByApiKey: vi.fn(async (): Promise<null> => null),
  getStaffByAdminSession: vi.fn(async (): Promise<null> => null),
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

const { authMiddleware } = await import('../middleware/auth.js');
const { restaurantTest } = await import('./restaurant-test.js');
type Env = import('../index.js').Env;

const here = dirname(fileURLToPath(import.meta.url));
let testDb: SqliteD1;
let env: Env['Bindings'];

function app() {
  const instance = new Hono<Env>();
  instance.use('*', authMiddleware);
  instance.route('/', restaurantTest);
  return instance;
}
const versionOf = (id: string) => (testDb.raw.prepare(
  'SELECT customer_version FROM rt_reservations WHERE id=?').get(id) as { customer_version: number }).customer_version;
beforeEach(() => {
  authMocks.lineAccounts = [
    { id: 'account-1', name: '統括', is_active: 1, channel_access_token: 'token-1' },
    { id: 'account-2', name: '店舗A', is_active: 1, channel_access_token: 'token-2' },
    { id: 'account-3', name: '店舗B', is_active: 1, channel_access_token: 'token-3' },
    { id: 'account-4', name: '予備', is_active: 1, channel_access_token: 'token-4' },
  ];
  testDb = createTestD1({ loginPolicy: 'off' });
  testDb.raw.exec(readFileSync(join(here, '../../../../packages/db/migrations/168_restaurant_test_foundation.sql'), 'utf8'));
  testDb.raw.exec(readFileSync(join(here, '../../../../packages/db/migrations/175_restaurant_terms_agreement.sql'), 'utf8'));
  testDb.raw.prepare(`UPDATE tenants SET feature_packs = '["restaurant"]' WHERE id = '00000000-0000-4000-8000-000000000001'`).run();
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


const seedRestaurantFixture = () => seedRestaurantData(testDb);
function request(path: string, body: unknown) {
  return app().request(path, { method: 'POST', headers: { Authorization: 'Bearer owner-key', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, env);
}
function requestWithMethod(path: string, method: string, body: Record<string, unknown>) {
  const id = path.match(/reservations\/([^/?]+)/)?.[1];
  const expectedVersion = id ? versionOf(id) : undefined;
  return app().request(path, { method, headers: { Authorization: 'Bearer owner-key', 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, expectedVersion }) }, env);
}

describe('休業の確認', () => {
 it('休業の確認後に飲食予約が変われば409、一致なら登録できる',async()=>{
  seedRestaurantFixture();
  testDb.raw.prepare("INSERT INTO rt_reservations(id,store_id,source,customer_name,guest_count,starts_at,ends_at,status) VALUES('future-confirm','store-ginza','manual','予約',2,'2099-01-01T04:00:00Z','2099-01-01T05:00:00Z','confirmed')").run();
  const input={storeId:'store-ginza',startDate:'2099-01-01',endDate:'2099-01-01',allDay:true,kind:'temporary_closed',tableIds:[]};
  const preview=await request('/api/restaurant-test/closures/preview?account_id=account-1',input);
  expect(preview.status).toBe(200);const first=(await preview.json() as any).data;
  expect(first.reservations).toHaveLength(1);expect(typeof first.confirmationSnapshot).toBe('string');
  expect((await requestWithMethod('/api/restaurant-test/reservations/future-confirm?account_id=account-1','PATCH',{note:'変更'})).status).toBe(200);
  expect((await request('/api/restaurant-test/closures?account_id=account-1',{...input,expectedSnapshot:first.confirmationSnapshot})).status).toBe(409);
  expect(testDb.raw.prepare("SELECT COUNT(*) n FROM rt_closures WHERE start_date='2099-01-01'").get()).toEqual({n:0});
  const latest=(await (await request('/api/restaurant-test/closures/preview?account_id=account-1',input)).json() as any).data;
  expect((await request('/api/restaurant-test/closures?account_id=account-1',{...input,expectedSnapshot:latest.confirmationSnapshot})).status).toBe(201);
 });

 it('休業編集は予約の変更を409で拒み、一致と旧呼び出しを受け付ける',async()=>{
  seedRestaurantFixture();
  testDb.raw.prepare("INSERT INTO rt_reservations(id,store_id,source,customer_name,guest_count,starts_at,ends_at,status) VALUES('future-edit','store-ginza','manual','予約',2,'2099-01-02T04:00:00Z','2099-01-02T05:00:00Z','confirmed')").run();
  const input={storeId:'store-ginza',startDate:'2099-01-02',endDate:'2099-01-02',allDay:true,kind:'temporary_closed',tableIds:[]};
  const created=(await (await request('/api/restaurant-test/closures?account_id=account-1',input)).json() as any).data.closure;
  const preview=async()=> (await (await request('/api/restaurant-test/closures/preview?account_id=account-1',{...input,excludeId:created.id})).json() as any).data;
  const patch=async(body:unknown)=>app().request(`/api/restaurant-test/closures/${created.id}?account_id=account-1`,{method:'PATCH',headers:{Authorization:'Bearer owner-key','Content-Type':'application/json'},body:JSON.stringify(body)},env);
  const first=await preview();
  expect((await requestWithMethod('/api/restaurant-test/reservations/future-edit?account_id=account-1','PATCH',{note:'変更'})).status).toBe(200);
  expect((await patch({...input,expectedVersion:created.version,expectedSnapshot:first.confirmationSnapshot})).status).toBe(409);
  expect(testDb.raw.prepare('SELECT version FROM rt_closures WHERE id=?').get(created.id)).toEqual({version:created.version});
  const latest=await preview();
  expect((await patch({...input,expectedVersion:created.version,expectedSnapshot:latest.confirmationSnapshot})).status).toBe(200);
  expect((await patch({...input,expectedVersion:created.version+1})).status).toBe(200);
 });

 it('予約を編集すると確認専用の版が進む',async()=>{
  seedRestaurantFixture();const url='/api/restaurant-test/reservations/reservation-ginza?account_id=account-1';
  expect((await requestWithMethod(url,'PATCH',{note:'確認用の編集'})).status).toBe(200);
  expect(testDb.raw.prepare("SELECT confirmation_revision FROM rt_reservations WHERE id='reservation-ginza'").get()).toEqual({confirmation_revision:2});
 });

});
