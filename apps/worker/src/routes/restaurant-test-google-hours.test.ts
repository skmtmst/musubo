import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';
import { seedRestaurantFixture } from '../test-utils/restaurant-fixture.js';

const accounts = [
  { id: 'account-1', name: '統括', is_active: 1, channel_access_token: 'token-1' },
  { id: 'account-2', name: '店舗A', is_active: 1, channel_access_token: 'token-2' },
];
vi.mock('@line-crm/db', async () => {
  const actual = await vi.importActual<typeof import('@line-crm/db')>('@line-crm/db');
  return { ...actual, getStaffByApiKey: vi.fn(async () => null), getStaffByAdminSession: vi.fn(async () => null),
    getLineAccounts: vi.fn(async () => accounts), getLineAccountScopeEntries: vi.fn(async () => accounts) };
});

const { authMiddleware } = await import('../middleware/auth.js');
const { restaurantTest } = await import('./restaurant-test.js');
type Env = import('../index.js').Env;
let database: SqliteD1;
let env: Env['Bindings'];
beforeEach(() => {
  database = createTestD1({ loginPolicy: 'off' });
  database.raw.prepare(`UPDATE tenants SET feature_packs='["restaurant"]' WHERE id=?`)
    .run('00000000-0000-4000-8000-000000000001');
  seedRestaurantFixture(database);
  env = { DB: database.db, API_KEY: 'owner-key', DEPLOY_ENV: 'test', RESTAURANT_TEST_ENABLED: 'true' } as Env['Bindings'];
});
afterEach(() => database.raw.close());

function request(path: string, method = 'GET', body?: unknown) {
  const app = new Hono<Env>();
  app.use('*', authMiddleware);
  app.route('/', restaurantTest);
  return app.request(path, { method, headers: { Authorization: 'Bearer owner-key', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) }, env);
}

it('Google接続後は特別営業時間を指定日の正として返し、旧時間への編集と失効時の代用を止める', async () => {
  const path = '/api/restaurant-test/opening-hours?account_id=account-1&storeId=store-ginza';
  const oldHours = Array.from({ length: 7 }, (_, weekday) => ({ weekday, periods: weekday === 0 ? [] : [{ opensAt: '17:00', closesAt: '23:00' }] }));
  expect((await request(path, 'PUT', { storeId: 'store-ginza', hours: oldHours, expectedVersion: 0 })).status).toBe(200);
  const location = 'accounts/111/locations/222';
  database.raw.prepare(`INSERT INTO rt_google_connections(id,store_id,line_account_id,location_name,refresh_token_enc,status)
    VALUES(?,?,?,?,?,?)`).run('google-1', 'store-ginza', 'account-2', location, 'encrypted', 'connected');
  const regularHours = Object.fromEntries(['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY']
    .map(day => [day, [{ open: '10:00', close: '19:00' }]]));
  database.raw.prepare(`INSERT INTO rt_google_profiles(store_id,location_name,profile_json,fingerprint,fetched_at,updated_at)
    VALUES(?,?,?,?,?,?)`).run('store-ginza', location, JSON.stringify({ profile: {
      name: 'locations/222', openStatus: 'OPEN', regularHours,
      specialHours: [{ date: '2026-11-10', closed: true, periods: [] }],
    } }), 'fingerprint', '2026-11-10T00:00:00Z', '2026-11-10T00:00:00Z');
  const weekly = (await (await request(path)).json() as any).data;
  expect(weekly.hours[2].periods).toEqual([{ opensAt: '10:00', closesAt: '19:00' }]);
  const special = (await (await request(`${path}&date=2026-11-10`)).json() as any).data;
  expect(special.hours[2].periods).toEqual([]);
  expect((await request(path, 'PUT', { storeId: 'store-ginza', hours: oldHours, expectedVersion: 1 })).status).toBe(409);
  expect((await request(`${path}&date=invalid`)).status).toBe(400);
  database.raw.prepare("UPDATE rt_google_connections SET status='expired' WHERE store_id='store-ginza'").run();
  expect((await (await request(path)).json() as any).data.hours).toBeNull();
});
