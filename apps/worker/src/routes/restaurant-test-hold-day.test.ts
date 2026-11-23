import { seedRestaurantFixture as seedRestaurantData } from '../test-utils/restaurant-fixture.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

const { authMiddleware } = await import('../middleware/auth.js');
const { restaurantTest } = await import('./restaurant-test.js');
type Env = import('../index.js').Env;

const here = dirname(fileURLToPath(import.meta.url));
let testDb: SqliteD1;
let env: Env['Bindings'];

const seedRestaurantFixture = (options?: Parameters<typeof seedRestaurantData>[1]) => seedRestaurantData(testDb, options);

function app() {
  const instance = new Hono<Env>();
  instance.use('*', authMiddleware);
  instance.route('/', restaurantTest);
  return instance;
}

function request(path: string, body?: unknown) {
  return requestAs(path, 'owner-key', body);
}

function requestAs(path: string, token: string, body?: unknown) {
  return app().request(path, body === undefined ? {
    headers: { Authorization: `Bearer ${token}` },
  } : {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, env);
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

describe('V8 仮押さえ・日付・来店履歴', () => {
  const hold = { storeId: 'store-ginza', startsAt: '2099-10-10T10:00:00Z', endsAt: '2099-10-10T12:00:00Z', guestCount: 2, holdMinutes: 15 };
  it('仮押さえのアレルギーを保存・読出し・編集し、従来の文字入力も保持する', async () => {
    seedRestaurantFixture();
    testDb.raw.prepare("INSERT INTO rt_opening_hours_settings (store_id, hours_json, updated_by) VALUES ('store-ginza', '[]', 'test')").run();
    const allergies = [{ kind: 'option', value: '卵' }, { kind: 'other', value: 'キウイ' }];
    const created = await request('/api/restaurant-test/reservations/holds?account_id=account-1', { ...hold, allergies });
    expect(created.status).toBe(201);
    const { id } = (await created.json() as any).data;
    let day = await request('/api/restaurant-test/reservations/day?account_id=account-1&storeId=store-ginza&date=2099-10-10');
    let item = (await day.json() as any).data.reservations.find((row: any) => row.id === id);
    expect(item.allergies).toEqual(allergies);
    expect(item.allergy_note).toBe('卵、その他：キウイ');
    expect((await requestWithMethod(`/api/restaurant-test/reservations/${id}?account_id=account-1`, 'PATCH', { allergies: [{ kind: 'option', value: '乳' }] })).status).toBe(200);
    day = await request('/api/restaurant-test/reservations/day?account_id=account-1&storeId=store-ginza&date=2099-10-10');
    item = (await day.json() as any).data.reservations.find((row: any) => row.id === id);
    expect(item.allergies).toEqual([{ kind: 'option', value: '乳' }]);
    expect((await requestWithMethod(`/api/restaurant-test/reservations/${id}?account_id=account-1`, 'PATCH', { allergyNote: '古い自由記述、区切りを残す' })).status).toBe(200);
    day = await request('/api/restaurant-test/reservations/day?account_id=account-1&storeId=store-ginza&date=2099-10-10');
    item = (await day.json() as any).data.reservations.find((row: any) => row.id === id);
    expect(item.allergies).toBeNull();
    expect(item.allergy_note).toBe('古い自由記述、区切りを残す');
    const longLegacy = '長'.repeat(201);
    expect((await requestWithMethod(`/api/restaurant-test/reservations/${id}?account_id=account-1`, 'PATCH', { allergyNote:longLegacy })).status).toBe(200);
    const preserved = await requestWithMethod(`/api/restaurant-test/reservations/${id}?account_id=account-1`, 'PATCH', { allergies:[{kind:'other',value:longLegacy},{kind:'option',value:'卵'}] });
    expect(preserved.status).toBe(200);
    const row = testDb.raw.prepare('SELECT allergies_json FROM rt_reservations WHERE id=?').get(id) as {allergies_json:string};
    expect(JSON.parse(row.allergies_json)).toEqual([{kind:'other',value:longLegacy},{kind:'option',value:'卵'}]);
    expect((await requestWithMethod(`/api/restaurant-test/reservations/${id}?account_id=account-1`, 'PATCH', { allergies:[{kind:'other',value:longLegacy},{kind:'option',value:'乳'}] })).status).toBe(200);
  });
  it('候補外の値はその他で指定し、権限のない店舗を指定できない', async () => {
    seedRestaurantFixture();
    const endpoint = '/api/restaurant-test/reservations/holds?account_id=account-1';
    expect((await request(endpoint, { ...hold, allergies: [{ kind: 'option', value: '未知の候補' }] })).status).toBe(400);
    expect((await request(endpoint, { ...hold, allergyNote:'乳', allergies:[{kind:'option',value:'卵'}] })).status).toBe(400);
    testDb.raw.exec("INSERT INTO staff_members(id,name,role,api_key,account_scope,tenant_id) VALUES('operator','担当者','staff','operator-key','accounts','00000000-0000-4000-8000-000000000001'); INSERT INTO staff_account_scopes(staff_id,line_account_id,created_at) VALUES('operator','account-2',datetime('now'));");
    authMocks.getStaffByApiKey.mockResolvedValue({ id:'operator', name:'担当者', role:'staff', access_level:'full', permission_keys:'[]', assigned_line_account_id:null, can_access_descendant_accounts:0 });
    const scoped = '/api/restaurant-test/reservations/holds?account_id=account-2';
    expect((await requestAs(scoped, 'operator-key', { ...hold, storeId:'store-yokohama', allergies: [{ kind: 'other', value: 'キウイ' }] })).status).toBe(400);
  });
  it('選択中のアカウントと異なる店舗では店舗側の候補を検証する', async () => {
    seedRestaurantFixture();
    testDb.raw.prepare("INSERT INTO rt_opening_hours_settings (store_id, hours_json, updated_by) VALUES ('store-ginza', '[]', 'test')").run();
    const { saveVersionedAccountSetting } = await import('@line-crm/db');
    for (const [accountId, option] of [['account-1', '大豆'], ['account-2', 'キウイ']]) {
      await saveVersionedAccountSetting(testDb.db, { accountId: accountId!, key: 'friend.allergy_options_v1', data: [option], expectedVersion: 0 });
    }
    const endpoint = '/api/restaurant-test/reservations/holds?account_id=account-1';
    expect((await request(endpoint, { ...hold, allergies: [{kind:'option',value:'大豆'}] })).status).toBe(400);
    expect((await request(endpoint, { ...hold, allergies: [{kind:'option',value:'キウイ'}] })).status).toBe(201);
  });
  it('候補から削除された値も、すでに予約にあるときは編集で保持できる', async () => {
    seedRestaurantFixture();
    testDb.raw.prepare("INSERT INTO rt_opening_hours_settings (store_id, hours_json, updated_by) VALUES ('store-ginza', '[]', 'test')").run();
    const created = await request('/api/restaurant-test/reservations/holds?account_id=account-1', { ...hold, allergies: [{kind:'option',value:'卵'}] });
    expect(created.status).toBe(201);
    const {id} = (await created.json() as any).data;
    const { saveVersionedAccountSetting } = await import('@line-crm/db');
    await saveVersionedAccountSetting(testDb.db, { accountId:'account-2', key:'friend.allergy_options_v1', data:['乳'], expectedVersion:0 });
    const updated = await requestWithMethod(`/api/restaurant-test/reservations/${id}?account_id=account-1`, 'PATCH', { allergies:[{kind:'option',value:'卵'},{kind:'option',value:'乳'}] });
    expect(updated.status).toBe(200);
    const row = testDb.raw.prepare('SELECT allergies_json FROM rt_reservations WHERE id=?').get(id) as {allergies_json:string};
    expect(JSON.parse(row.allergies_json)).toEqual([{kind:'option',value:'卵'},{kind:'option',value:'乳'}]);
  });
  it('閲覧のみの担当者はアレルギーを保存できない', async () => {
    seedRestaurantFixture();
    testDb.raw.exec("INSERT INTO staff_members(id,name,role,api_key,access_level,account_scope,tenant_id) VALUES('viewer','閲覧','staff','viewer-key','read_only','accounts','00000000-0000-4000-8000-000000000001'); INSERT INTO staff_account_scopes(staff_id,line_account_id,created_at) VALUES('viewer','account-2',datetime('now'));");
    authMocks.getStaffByApiKey.mockResolvedValue({ id:'viewer', name:'閲覧', role:'staff', access_level:'read_only', permission_keys:'[]', assigned_line_account_id:null, can_access_descendant_accounts:0 });
    const response = await requestAs('/api/restaurant-test/reservations/holds?account_id=account-2', 'viewer-key', { ...hold, allergies: [{ kind:'option', value:'卵' }] });
    expect(response.status).toBe(403);
    expect(testDb.raw.prepare("SELECT COUNT(*) AS n FROM rt_reservations WHERE allergies_json IS NOT NULL").get()).toEqual({n:0});
  });
  it('電話予約とウォークインに複数のアレルギーを記録する', async () => {
    seedRestaurantFixture();
    testDb.raw.prepare("INSERT INTO rt_opening_hours_settings (store_id, hours_json, updated_by) VALUES ('store-ginza', '[]', 'test')").run();
    const allergies = [{ kind:'option', value:'卵' }, { kind:'other', value:'キウイ' }];
    const manual = await request('/api/restaurant-test/reservations/manual?account_id=account-1', { storeId:'store-ginza', customerName:'見本', guestCount:2, startsAt:'2099-10-10T10:00:00Z', endsAt:'2099-10-10T12:00:00Z', source:'phone', allergies });
    expect(manual.status).toBe(201);
    const manualId = (await manual.json() as any).data.id;
    const walk = await request('/api/restaurant-test/reservations/walk-in?account_id=account-1', { storeId:'store-ginza', tableId:'table-ginza', guestCount:2, customerPhone:'09000000000', allergies });
    expect(walk.status).toBe(201);
    const walkId = (await walk.json() as any).data.id;
    for (const id of [manualId, walkId]) {
      const row = testDb.raw.prepare('SELECT allergy_note, allergies_json FROM rt_reservations WHERE id=?').get(id) as { allergy_note:string; allergies_json:string };
      expect(row.allergy_note).toBe('卵、その他：キウイ');
      expect(JSON.parse(row.allergies_json)).toEqual(allergies);
    }
    const history=await request('/api/restaurant-test/customers/history?account_id=account-1&storeId=store-ginza&phone=09000000000');
    expect(history.status).toBe(200);
    const visit=(await history.json() as any).data.visits.find((item:any)=>item.id===walkId);
    expect(visit.allergies).toEqual(allergies);
    expect(visit.allergy_note).toBe('卵、その他：キウイ');
    const from=encodeURIComponent(new Date(Date.now()-60_000).toISOString());
    const to=encodeURIComponent(new Date(Date.now()+3*60*60_000).toISOString());
    const board=await request(`/api/restaurant-test/board?account_id=account-1&storeId=store-ginza&from=${from}&to=${to}`);
    expect(board.status).toBe(200);
    const entry=(await board.json() as any).data.items.find((item:any)=>item.id===walkId);
    expect(entry.currentAllergy).toBe('卵、その他：キウイ');
    expect(entry.allergies).toEqual(allergies);
  });

  it('仮押さえは期限を保存し、重なる要求を409で止め、解除後は再登録できる', async () => {
    seedRestaurantFixture();
    testDb.raw.prepare("INSERT INTO rt_opening_hours_settings (store_id, hours_json, updated_by) VALUES ('store-ginza', '[]', 'test')").run();
    const res = await request('/api/restaurant-test/reservations/holds?account_id=account-1', hold);
    expect(res.status).toBe(201);
    const saved = (await res.json() as any).data;
    expect(Date.parse(saved.holdExpiresAt)).toBeGreaterThan(Date.now());
    expect((await request('/api/restaurant-test/reservations/holds?account_id=account-1', hold)).status).toBe(409);
    expect((await requestWithMethod(`/api/restaurant-test/reservations/${saved.id}?account_id=account-1`, 'PATCH', { status: 'cancelled' })).status).toBe(200);
    expect((await request('/api/restaurant-test/reservations/holds?account_id=account-1', hold)).status).toBe(201);
  });
  it('期限が切れた押さえを再読込で解除し、確定させない', async () => {
    seedRestaurantFixture();
    testDb.raw.prepare("INSERT INTO rt_opening_hours_settings (store_id, hours_json, updated_by) VALUES ('store-ginza', '[]', 'test')").run();
    const res = await request('/api/restaurant-test/reservations/holds?account_id=account-1', hold);
    const { id } = (await res.json() as any).data;
    testDb.raw.prepare("UPDATE rt_reservations SET hold_expires_at='2000-01-01T00:00:00Z' WHERE id=?").run(id);
    expect((await requestWithMethod(`/api/restaurant-test/reservations/${id}?account_id=account-1`, 'PATCH', { status: 'confirmed' })).status).toBe(409);
    expect(testDb.raw.prepare('SELECT status FROM rt_reservations WHERE id=?').get(id)).toEqual({ status: 'cancelled' });
  });
  it('店の暦日で500件を超えても全予約を返し、別店舗を混ぜない', async () => {
    seedRestaurantFixture();
    const insert = testDb.raw.prepare(`INSERT INTO rt_reservations(id,store_id,source,customer_name,guest_count,starts_at,ends_at) VALUES(?, 'store-ginza','phone','試験',1,'2099-10-09T15:00:00Z','2099-10-09T16:00:00Z')`);
    for (let i=0;i<501;i++) insert.run(`day-${i}`);
    const res = await request('/api/restaurant-test/reservations/day?account_id=account-1&storeId=store-ginza&date=2099-10-10');
    expect(res.status).toBe(200);
    expect((await res.json() as any).data.reservations).toHaveLength(501);
    expect((await request('/api/restaurant-test/reservations/day?account_id=account-1&storeId=store-ginza&date=2099-02-30')).status).toBe(400);
  });
  it('来店履歴はvisitedのみ、名前の一致で別人を混ぜない', async () => {
    seedRestaurantFixture();
    testDb.raw.exec("UPDATE rt_reservations SET customer_phone='090-0000-0000',status='visited' WHERE id='reservation-ginza'");
    let res = await request('/api/restaurant-test/customers/history?account_id=account-1&storeId=store-ginza&phone=09000000000');
    expect((await res.json() as any).data.visitCount).toBe(1);
    res = await request('/api/restaurant-test/customers/history?account_id=account-1&storeId=store-yokohama&phone=09000000000');
    expect((await res.json() as any).data.visitCount).toBe(0);
  });
  it('存在しない店舗・不正な期限では保存しない', async () => {
    seedRestaurantFixture();
    for (const body of [{ ...hold, holdMinutes: 0 }, { ...hold, storeId: 'other' }]) expect((await request('/api/restaurant-test/reservations/holds?account_id=account-1', body)).status).toBe(400);
  });
});
