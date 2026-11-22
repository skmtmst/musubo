import { Hono } from 'hono';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { sha256Hex } from '../middleware/auth.js';
import { featureEnforcementMiddleware } from '../middleware/feature-enforcement.js';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';
import type { Env } from '../worker-env.js';
import { featureSettings } from './feature-settings.js';
import { restaurantTest } from './restaurant-test.js';
import { styles } from './styles.js';

let db: SqliteD1;
const owner: Env['Variables']['staff'] = {
  id: 'owner', name: 'Owner', role: 'owner', readOnly: false, tenantId: 'tenant',
};
const snapshot = '/api/restaurant-test/snapshot';
const settings = '/api/settings/features';

beforeEach(async () => {
  db = createTestD1({ foreignKeys: true });
  db.raw.exec(`
    INSERT INTO tenants(id,name) VALUES ('tenant','Tenant'), ('outside','Outside');
    INSERT INTO staff_members(id,name,role,api_key,tenant_id,account_scope)
      VALUES ('owner','Owner','owner','fixture-owner','tenant','all'),
             ('limited','Limited','admin','fixture-limited','tenant','accounts');
    INSERT INTO line_accounts(id,tenant_id,channel_id,name,channel_access_token,channel_secret)
      VALUES ('restaurant','tenant','test-restaurant','Restaurant','',''),
             ('sibling','tenant','test-sibling','Sibling','',''),
             ('outside','outside','test-outside','Outside','','');
    INSERT INTO staff_account_scopes(staff_id,line_account_id,created_at) VALUES ('limited','sibling','now');
    INSERT INTO rt_organizations(id,account_id,tenant_id,name) VALUES ('org','tenant','tenant','Org');
    INSERT INTO rt_stores(id,organization_id,name,code,line_account_id)
      VALUES ('own-store','org','Own','own','restaurant'), ('sibling-store','org','Sibling','sibling','sibling');
  `);
  db.raw.prepare(`INSERT INTO admin_sessions(token_hash,staff_id,expires_at,selected_restaurant_store_id)
    VALUES (?,'owner','2099-01-01T00:00:00Z','sibling-store')`).run(await sha256Hex('fixture-session'));
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('Unexpected external request'))));
});

afterEach(() => { vi.unstubAllGlobals(); db.raw.close(); });

function request(path: string, options: { staff?: Env['Variables']['staff']; environment?: string; body?: unknown; method?: string } = {}) {
  const app = new Hono<Env>();
  app.use('*', async (c, next) => { c.set('staff', options.staff ?? owner); await next(); });
  app.use('/api/restaurant-test/*', featureEnforcementMiddleware);
  app.route('/', styles);
  app.route('/', featureSettings);
  app.route('/', restaurantTest);
  return app.request(path, {
    method: options.method ?? 'GET',
    headers: { Authorization: 'Bearer lh_session:fixture-session', 'Content-Type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  }, { DB: db.db, DEPLOY_ENV: options.environment ?? 'test', RESTAURANT_TEST_ENABLED: 'true' } as Env['Bindings']);
}

function selectRestaurant(accountId = 'restaurant') {
  return request(`/api/dashboard/style?account_id=${accountId}`, {
    method: 'PUT', body: { expectedVersion: 0, style: 'restaurant', answers: { image: { mode: 'later' } } },
  });
}

it('保存済みの飲食店スタイルが店舗画面と機能設定を有効にし、古い統括設定を必要としない', async () => {
  expect((await request(`${snapshot}?account_id=restaurant`)).status).toBe(404);
  db.raw.prepare(`INSERT INTO account_settings(id,line_account_id,key,value)
    VALUES ('features','restaurant','feature.settings_bundle_v1',?)`).run(JSON.stringify({
      version: 7, data: { features: { restaurant_test: false, analytics: true }, favoriteItemIds: ['custom'] },
    }));
  expect((await selectRestaurant()).status).toBe(200);
  const route = await request(`${snapshot}?account_id=restaurant&tenant_id=tenant`);
  expect(route.status).toBe(200);
  expect((await route.json<{data:{stores: Array<{id:string}>}}>()).data.stores.map(store => store.id)).toEqual(['own-store']);
  const visibility = await request(`${settings}/visibility?account_id=restaurant`);
  expect((await visibility.json<{ data: { features: { restaurant_test: boolean } } }>()).data.features.restaurant_test).toBe(true);
  const config = await request(`${settings}?account_id=restaurant`);
  expect(await config.json()).toMatchObject({ data: { version: 7, features: { analytics: true, restaurant_test: true }, favoriteItemIds: ['custom'] } });
  expect((await request(`${settings}?account_id=restaurant`, {
    method: 'PUT', body: { expectedVersion: 7, reason: '設定を見直す', features: { restaurant_test: true } },
  })).status).toBe(200);
  expect((await request('/api/dashboard/style/summary?account_id=restaurant&style=restaurant')).status).toBe(200);
});

it.each([false, true])('新規店舗のウィザードで同じ登録済みLINEを結び、卓を作成できる（従来設定あり: %s）', async (legacy) => {
  if (legacy) db.raw.exec(`UPDATE tenants SET feature_packs='["restaurant"]' WHERE id='tenant'`);
  db.raw.exec(`INSERT INTO line_accounts(id,tenant_id,channel_id,name,channel_access_token,channel_secret)
    VALUES ('fresh','tenant','test-fresh','Fresh','','')`);
  expect((await selectRestaurant('fresh')).status).toBe(200);
  const path = '/api/restaurant-test/stores/connect?account_id=fresh';
  const input = { name: '新しい店', alias: 'fresh', channelId: 'test-fresh', channelSecret: 'fixture-correct' };
  if (!legacy) {
    expect((await request(path, { method: 'POST', body: { ...input, channelId: 'test-sibling' } })).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  }

  vi.mocked(fetch).mockImplementation(async (url, init) => {
    if (String(url).endsWith('/v2/oauth/accessToken')) {
      const payload = new URLSearchParams(String(init?.body));
      if (payload.get('client_secret') !== 'fixture-correct') return new Response(null, { status: 401 });
      return Response.json({ access_token: 'fixture-token', expires_in: 600 });
    }
    return Response.json({ displayName: '新しい店のLINE' });
  });
  expect((await request(path, { method: 'POST', body: { ...input, channelSecret: 'fixture-incorrect' } })).status).toBe(400);
  expect(db.raw.prepare('SELECT 1 FROM rt_stores WHERE line_account_id=?').get('fresh')).toBeUndefined();
  const result = await request(path, { method: 'POST', body: input });
  expect(result.status).toBe(201);
  const { data } = await result.json<{ data: { store: { id: string } } }>();
  expect(db.raw.prepare('SELECT line_account_id FROM rt_stores WHERE id=?').get(data.store.id)).toEqual({ line_account_id: 'fresh' });
  expect(db.raw.prepare('SELECT COUNT(*) AS count FROM line_accounts WHERE tenant_id=?').get('tenant')).toEqual({ count: 3 });
  expect((await request(path, { method: 'POST', body: input })).status).toBe(409);
  expect((await request(`/api/restaurant-test/stores/${data.store.id}/select?account_id=fresh`, { method: 'POST' })).status).toBe(200);

  const table = { code: '01', label: 'テーブル1', seatType: 'table', minCapacity: 1, maxCapacity: 2 };
  const tablePath = '/api/restaurant-test/tables?account_id=fresh';
  expect((await request(tablePath, { method: 'POST', body: { ...table, storeId: 'sibling-store' } })).status).toBe(400);
  expect((await request(tablePath, { method: 'POST', body: { ...table, storeId: data.store.id } })).status).toBe(201);
  const saved = await request(`${snapshot}?account_id=fresh`);
  expect(await saved.json()).toMatchObject({ data: { tables: [{ store_id: data.store.id, code: '01' }] } });
});

it('同じ統括でも別のLINEや店舗、セッションに残った別店舗を使えない', async () => {
  expect((await selectRestaurant()).status).toBe(200);
  expect((await request(`${snapshot}?account_id=sibling`)).status).toBe(404);
  expect((await request(`${snapshot}?account_id=restaurant&tenant_id=outside`)).status).toBe(403);
  expect((await request(`${snapshot}?tenant_id=tenant`)).status).toBe(404);
  expect((await request(`${snapshot}?account_id=restaurant`, { staff: { ...owner, id: 'limited', role: 'admin' } })).status).toBe(403);
  const stores = await request('/api/restaurant-test/stores?account_id=restaurant');
  expect((await stores.json<{data:{stores: Array<{id:string}>}}>()).data.stores.map(store => store.id)).toEqual(['own-store']);
  const context = await request('/api/restaurant-test/store-context?account_id=restaurant');
  expect(await context.json()).toMatchObject({ data: { selectedStore: null } });
  expect((await request('/api/restaurant-test/stores/sibling-store/select?account_id=restaurant', { method: 'POST' })).status).toBe(403);
  expect((await request('/api/restaurant-test/seat-waitlist?account_id=restaurant&storeId=sibling-store')).status).toBe(400);
  expect((await request(`${snapshot}?account_id=restaurant`, { environment: 'production' })).status).toBe(404);
});
