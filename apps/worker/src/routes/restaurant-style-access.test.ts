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

function request(path: string, options: { staff?: Env['Variables']['staff']; environment?: string; featureEnabled?: boolean; body?: unknown; method?: string } = {}) {
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
  }, { DB: db.db, DEPLOY_ENV: options.environment ?? 'test', RESTAURANT_TEST_ENABLED: String(options.featureEnabled ?? true) } as Env['Bindings']);
}

function selectRestaurant(accountId = 'restaurant', options: { staff?: Env['Variables']['staff']; featureEnabled?: boolean; expectedVersion?: number } = {}) {
  return request(`/api/dashboard/style?account_id=${accountId}`, {
    ...options,
    method: 'PUT', body: { expectedVersion: options.expectedVersion ?? 0, style: 'restaurant', answers: { image: { mode: 'later' } } },
  });
}

it('保存済みの飲食店スタイルが店舗画面と機能設定を有効にし、古い統括設定を必要としない', async () => {
  expect((await request(`${snapshot}?account_id=restaurant`)).status).toBe(404);
  db.raw.exec(`UPDATE rt_stores SET capacity=12,google_status='connected' WHERE id='own-store'`);
  db.raw.prepare(`INSERT INTO account_settings(id,line_account_id,key,value)
    VALUES ('features','restaurant','feature.settings_bundle_v1',?)`).run(JSON.stringify({
      version: 7, data: { features: { restaurant_test: false, analytics: true }, favoriteItemIds: ['custom'] },
    }));
  expect((await selectRestaurant()).status).toBe(200);
  expect(db.raw.prepare('SELECT name,capacity,google_status FROM rt_stores WHERE id=?').get('own-store'))
    .toEqual({ name: 'Own', capacity: 12, google_status: 'connected' });
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

it('飲食店の保存から統括と空の内部店舗を用意し、座席管理を開ける', async () => {
  db.raw.exec(`INSERT INTO staff_members(id,name,role,api_key,tenant_id,account_scope)
    VALUES ('outside-owner','Outside Owner','owner','fixture-outside-owner','outside','all')`);
  const staff = { ...owner, id: 'outside-owner', tenantId: 'outside' };
  expect((await selectRestaurant('outside')).status).toBe(404);
  expect((await selectRestaurant('outside', { staff, expectedVersion: 1 })).status).toBe(409);
  expect(db.raw.prepare('SELECT id FROM rt_organizations WHERE tenant_id=?').get('outside')).toBeUndefined();

  expect((await selectRestaurant('outside', { staff })).status).toBe(200);
  const store = db.raw.prepare(`SELECT s.id,s.name,s.code,s.capacity,s.line_status,s.google_status,o.tenant_id
    FROM rt_stores s JOIN rt_organizations o ON o.id=s.organization_id WHERE s.line_account_id=?`).get('outside') as { id: string };
  expect(store).toEqual({ id: expect.any(String), name: 'Outside', code: 'line-outside', capacity: 0,
    line_status: 'unconfigured', google_status: 'unconfigured', tenant_id: 'outside' });
  const result = await request(`${snapshot}?account_id=outside`, { staff });
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({ data: { stores: [{ id: store.id, capacity: 0 }], tables: [] } });
  expect((await request('/api/restaurant-test/tables?account_id=outside', {
    staff, method: 'POST',
    body: { storeId: store.id, code: '01', label: 'テーブル1', seatType: 'table', minCapacity: 1, maxCapacity: 2 },
  })).status).toBe(201);
  expect((await selectRestaurant('outside', { staff, expectedVersion: 1 })).status).toBe(200);
  expect(db.raw.prepare('SELECT COUNT(*) AS count FROM rt_stores WHERE line_account_id=?').get('outside')).toEqual({ count: 1 });
  expect(db.raw.prepare('SELECT COUNT(*) AS count FROM line_accounts WHERE tenant_id=?').get('outside')).toEqual({ count: 1 });
  expect(db.raw.prepare('SELECT COUNT(*) AS count FROM rt_organization_agreements').get()).toEqual({ count: 0 });
  expect(fetch).not.toHaveBeenCalled();
});

it('並行する飲食店の保存は同じ版を一度だけ確定する', async () => {
  db.raw.exec(`INSERT INTO line_accounts(id,tenant_id,channel_id,name,channel_access_token,channel_secret)
    VALUES ('fresh','tenant','test-fresh','Fresh','','')`);
  const results = await Promise.all([selectRestaurant('fresh'), selectRestaurant('fresh')]);
  expect(results.map(result => result.status).sort()).toEqual([200, 409]);
  expect(db.raw.prepare('SELECT COUNT(*) AS count FROM rt_stores WHERE line_account_id=?').get('fresh')).toEqual({ count: 1 });
  expect(db.raw.prepare('SELECT version FROM account_styles WHERE line_account_id=?').get('fresh')).toEqual({ version: 1 });
});

it('あとで選ぶを保存しても内部店舗を作らない', async () => {
  db.raw.exec(`INSERT INTO line_accounts(id,tenant_id,channel_id,name,channel_access_token,channel_secret)
    VALUES ('fresh','tenant','test-fresh','Fresh','','')`);
  expect((await request('/api/dashboard/style?account_id=fresh', {
    method: 'PUT', body: { expectedVersion: 0, style: 'restaurant', styleMode: 'later' },
  })).status).toBe(200);
  expect(db.raw.prepare('SELECT 1 FROM rt_stores WHERE line_account_id=?').get('fresh')).toBeUndefined();
});

it('内部店舗を保存できない場合は飲食店スタイルも確定しない', async () => {
  db.raw.exec(`INSERT INTO staff_members(id,name,role,api_key,tenant_id,account_scope)
    VALUES ('outside-owner','Outside Owner','owner','fixture-outside-owner','outside','all');
    CREATE TEMP TRIGGER reject_outside_store BEFORE INSERT ON rt_stores WHEN NEW.line_account_id='outside'
    BEGIN SELECT RAISE(ABORT, 'fixture_store_insert_failed'); END`);
  const staff = { ...owner, id: 'outside-owner', tenantId: 'outside' };
  expect((await selectRestaurant('outside', { staff })).status).toBe(503);
  expect(db.raw.prepare('SELECT id FROM rt_organizations WHERE tenant_id=?').get('outside')).toBeUndefined();
  expect(db.raw.prepare('SELECT style FROM account_styles WHERE line_account_id=?').get('outside')).toBeUndefined();
});

it.each([false, true])('新規店舗のウィザードで同じ登録済みLINEを結び、卓を作成できる（従来設定あり: %s）', async (legacy) => {
  if (legacy) db.raw.exec(`UPDATE tenants SET feature_packs='["restaurant"]' WHERE id='tenant'`);
  db.raw.exec(`INSERT INTO line_accounts(id,tenant_id,channel_id,name,channel_access_token,channel_secret)
    VALUES ('fresh','tenant','test-fresh','Fresh','','')`);
  expect((await selectRestaurant('fresh', { featureEnabled: false })).status).toBe(200);
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

it('削除済み統括と店舗を再利用せず、現在のアカウントに新しい店舗を用意する', async () => {
  db.raw.exec(`UPDATE rt_organizations SET data_purged_at='2026-01-01', account_id='purged:org' WHERE id='org';
    UPDATE rt_stores SET data_purged_at='2026-01-01' WHERE organization_id='org';
    UPDATE line_accounts SET data_purged_at='2026-01-01' WHERE id IN ('restaurant','sibling');
    INSERT INTO line_accounts(id,tenant_id,channel_id,name,channel_access_token,channel_secret)
      VALUES ('new-restaurant','tenant','new-restaurant','New Restaurant','','');`);
  expect((await selectRestaurant('new-restaurant')).status).toBe(200);
  const live = db.raw.prepare(`SELECT s.id, o.id AS organization_id FROM rt_stores s
    JOIN rt_organizations o ON o.id=s.organization_id
    WHERE s.line_account_id='new-restaurant' AND s.data_purged_at IS NULL AND o.data_purged_at IS NULL`).all();
  expect(live).toHaveLength(1);
  expect(live[0]).not.toMatchObject({ id: 'own-store' });
  expect(live[0]).not.toMatchObject({ organization_id: 'org' });
});
