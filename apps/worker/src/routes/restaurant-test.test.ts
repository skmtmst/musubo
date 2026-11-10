import { seedRestaurantFixture as seedRestaurantData } from '../test-utils/restaurant-fixture.js';
import { publishScenarioVersion } from '@line-crm/db';
import { checkRestaurantMenuMedia, checkRestaurantMenuPrice } from '../test-utils/restaurant-menu-media.js';
import { seedNoticeFriend } from '../test-utils/restaurant-test-fixture-helpers.js';
import { requestRestaurantFollowupApproval } from '../services/restaurant-followup.js';
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

const { authMiddleware, sha256Hex } = await import('../middleware/auth.js');
const { restaurantTest } = await import('./restaurant-test.js');
const { scenarios } = await import('./scenarios.js');
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

async function createAdminSession(token = 'restaurant-session'): Promise<string> {
  authMocks.getStaffByAdminSession.mockResolvedValue({
    id: 'owner-session', name: 'Owner', role: 'owner', access_level: 'full',
    permission_keys: '[]', assigned_line_account_id: null,
    can_access_descendant_accounts: 1,
  });
  testDb.raw.prepare(
    'INSERT INTO admin_sessions (token_hash, staff_id, expires_at) VALUES (?, ?, ?)',
  ).run(await sha256Hex(token), 'owner-session', '2099-01-01T00:00:00.000Z');
  return `${ADMIN_SESSION_PREFIX}${token}`;
}

const ADMIN_SESSION_PREFIX = 'lh_session:';

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

describe('電話予約のLINE確認通知', () => {
  const path = '/api/restaurant-test/reservations/manual?account_id=account-1';
  const body = { storeId: 'store-ginza', customerName: '試験用のお客さま', guestCount: 2,
    startsAt: '2026-11-10T10:00:00.000Z', endsAt: '2026-11-10T12:00:00.000Z', lineUid: 'U' + '1'.repeat(32), notifyLine: true };
  const seedFriend = (following = 1, accountId = 'account-2') => seedNoticeFriend(testDb, seedRestaurantFixture, body.lineUid, following, accountId);
  async function approveFollowup(){
    testDb.raw.prepare("UPDATE scenario_steps SET message_content=? WHERE scenario_id='restaurant-followup:store-ginza' AND step_order=0").run('予約が確定しました。\n店舗: {{var.store_name}}\n日時: {{var.reservation_datetime}}〜{{var.reservation_end}}\n人数: {{var.guest_count}}名\nコース: {{var.course_name}}');
    await publishScenarioVersion(testDb.db,'restaurant-followup:store-ginza',{staffId:'owner',idempotencyKey:crypto.randomUUID()});
    const t=testDb.raw.prepare("SELECT template_version FROM rt_store_followup_templates WHERE store_id='store-ginza'").get() as {template_version:number};
    const a=await requestRestaurantFollowupApproval(testDb.db,'store-ginza',t.template_version,'owner');expect(a).not.toBeNull();
    testDb.raw.prepare("UPDATE rt_approval_requests SET status='approved',reviewed_by='owner' WHERE id=?").run(a!.id);
  }
  async function notice(input: unknown = body) {
    const res = await request(path, input);
    expect(res.status).toBe(201);
    const result = await res.json() as { data: { id: string; tableId: string; syncDirection: string; lineNotice: { sent: boolean; reason: string | null } } };
    expect(result.data.syncDirection).toBe('inbound_only');
    expect(testDb.raw.prepare('SELECT id FROM rt_reservations WHERE id = ?').get(result.data.id)).toBeDefined();
    return result.data;
  }
  it('未承認は送信0で予約を保存する',async()=>{seedFriend();expect((await notice()).lineNotice).toEqual({sent:false,reason:'approval_required'});expect(fetch).not.toHaveBeenCalled();});
  it('確認LINEに店舗・日時・人数・コースを載せ、自動通知として履歴を残す', async () => {
    seedFriend();
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    await approveFollowup();
    const result = await notice({ ...body, courseId: 'menu-ginza' });
    expect(result.lineNotice).toEqual({ sent: true, reason: null });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.line.me/v2/bot/message/push');
    const headers = new Headers(init.headers);
    expect(headers.has('X-Line-Harness-Source')).toBe(false);
    const job=testDb.raw.prepare("SELECT idempotency_key FROM scenario_source_jobs WHERE source_id=? AND status='sent'").get(result.id) as {idempotency_key:string};
    expect(headers.get('X-Line-Retry-Key')).toBe(job.idempotency_key);
    expect(JSON.parse(init.body as string)).toMatchObject({ to: body.lineUid,
      messages: [{ type: 'text', text: expect.stringContaining('予約が確定しました。') }] });
    expect(JSON.parse(init.body as string).messages[0].text).toContain('テストコース');
    expect(JSON.parse(init.body as string).messages[0].text).toContain('2026-11-10 19:00');
    expect(JSON.parse(init.body as string).messages[0].text).toContain('2026-11-10 21:00');
    expect(JSON.parse(init.body as string).messages[0].text).toContain('人数: 2名');
    expect(JSON.parse(init.body as string).messages[0].text).toContain('店舗: 銀座店');
    expect(testDb.raw.prepare("SELECT source FROM messages_log WHERE friend_id = 'friend-fixture'").get()).toEqual({ source: 'external' });
  });
  it('店舗の時間帯で夜をまたぐ終了日と席のみの予約を案内する', async () => {
    seedFriend();
    testDb.raw.prepare("UPDATE rt_stores SET timezone = 'Asia/Bangkok' WHERE id = 'store-ginza'").run();
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    await approveFollowup();
    expect((await notice({ ...body, guestCount: 3, startsAt: '2026-11-10T16:00:00.000Z', endsAt: '2026-11-10T18:00:00.000Z' })).lineNotice.sent).toBe(true);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const text = JSON.parse(init.body as string).messages[0].text;
    expect(text).toContain('日時: 2026-11-10 23:00〜2026-11-11 01:00');
    expect(text).toContain('人数: 3名');
    expect(text).toContain('コース: 席のみ');
  });
  it.each([undefined, false])('notifyLine=%sでは送らず、従来の予約結果を返す', async notifyLine => {
    seedFriend();
    const { notifyLine: _notifyLine, ...oldBody } = body;
    expect((await notice({ ...oldBody, notifyLine })).lineNotice).toEqual({ sent: false, reason: 'not_requested' });
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
  it('ブロック中は送らず、予約は保存する', async () => {
    seedFriend(0);
    expect((await notice()).lineNotice).toEqual({ sent: false, reason: 'blocked' });
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
  it.each([body.lineUid, null])('別アカウントの友だち・UID未入力には送らない (%s)', async lineUid => {
    seedFriend(1, 'account-3');
    expect((await notice({ ...body, lineUid })).lineNotice).toEqual({ sent: false, reason: 'not_friend' });
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
  it.each(['account-2', '*'])('送信停止を守る (%s)', async scope => {
    seedFriend();
    testDb.raw.prepare("INSERT INTO operation_control_sets (scope_key, line_account_id, states_json, updated_at) VALUES (?, ?, ?, '2026-10-02')")
      .run(scope, scope === '*' ? null : scope, '{"broadcast_dispatch":"stopped"}');
    expect((await notice()).lineNotice).toEqual({ sent: false, reason: 'sending_disabled' });
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
  it('送信失敗でも予約と在庫を保存し、例外の本文は返さない', async () => {
    seedFriend();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('試験用の非公開本文', { status: 500 })));
    await approveFollowup();
    const result = await notice();
    expect(result.lineNotice).toEqual({ sent: false, reason: 'send_failed' });
    expect(JSON.stringify(result)).not.toContain('非公開本文');
    expect(testDb.raw.prepare("SELECT status FROM rt_reservations WHERE id = ?").get(result.id)).toEqual({ status: 'confirmed' });
  });
  it('停止中・アーカイブ済みアカウントには送らない', async () => {
    seedFriend();
    testDb.raw.prepare("UPDATE line_accounts SET archived_at = '2026-10-02' WHERE id = 'account-2'").run();
    expect((await notice()).lineNotice).toEqual({ sent: false, reason: 'account_unavailable' });
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
  it('未確定の予約に確定文面を送らず、notifyLineの型を検証する', async () => {
    seedFriend();
    expect((await notice({ ...body, status: 'pending' })).lineNotice).toEqual({ sent: false, reason: 'not_confirmed' });
    expect((await request(path, { ...body, notifyLine: 'true' })).status).toBe(400);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});

describe('飲食店向けテストAPI', () => {
  it('無効な環境では専用APIを404にする', async () => {
    env.RESTAURANT_TEST_ENABLED = 'false';
    const response = await request('/api/restaurant-test/snapshot?account_id=account-1');
    expect(response.status).toBe(404);
  });

  it('統括に飲食店機能パックが無いと、環境が有効でも専用APIを404にする', async () => {
    // beforeEach で既定の統括へ付けたパックを外す。
    testDb.raw.prepare(`UPDATE tenants SET feature_packs = '[]' WHERE id = '00000000-0000-4000-8000-000000000001'`).run();
    seedRestaurantFixture();
    // seedRestaurantFixture は毎回パックを付け直すので、fixture後にも外す。
    testDb.raw.prepare(`UPDATE tenants SET feature_packs = '[]' WHERE id = '00000000-0000-4000-8000-000000000001'`).run();
    const response = await request('/api/restaurant-test/snapshot?account_id=account-1');
    expect(response.status).toBe(404);
  });

  it('既存領域と分離したテストデータを準備してR-1〜R-8の読取モデルを返す', async () => {
    seedRestaurantFixture({ name: '飲食店LAB' });

    const snapshot = await request('/api/restaurant-test/snapshot?account_id=account-1');
    expect(snapshot.status).toBe(200);
    const json = await snapshot.json() as { data: Record<string, unknown[]> & { integrationPolicy: string; organization: { name: string } } };
    expect(json.data.organization.name).toBe('飲食店LAB');
    expect(json.data.integrationPolicy).toBe('inbound_only');
    expect(json.data.stores.length).toBe(2);
    expect(json.data.reservations.length).toBeGreaterThan(0);
    expect(json.data.tables.length).toBeGreaterThan(0);
    expect(json.data.menuItems.length).toBeGreaterThan(0);
    expect(json.data.lineFlows.length).toBe(6);
    expect(JSON.stringify(json)).not.toContain('token-');
  });

  it('従来のaccount_idと新しいtenant_idが同じ組織を返す', async () => {
    seedRestaurantFixture({ name: '二重解決LAB' });
    const byAccount = await request('/api/restaurant-test/snapshot?account_id=account-1');
    const byTenant = await request(
      '/api/restaurant-test/snapshot?tenant_id=00000000-0000-4000-8000-000000000001',
    );
    expect(byAccount.status).toBe(200);
    expect(byTenant.status).toBe(200);
    const accountJson = await byAccount.json() as { data: { organization: unknown; stores: unknown[] } };
    const tenantJson = await byTenant.json() as { data: { organization: unknown; stores: unknown[] } };
    expect(tenantJson.data.organization).toEqual(accountJson.data.organization);
    expect(tenantJson.data.stores).toEqual(accountJson.data.stores);
  });

  it('tenant_idから作る統括はレガシーaccount_idにも同じ値を入れる', async () => {
    const tenant = '00000000-0000-4000-8000-000000000001';
    seedRestaurantFixture({ accountId: tenant, tenantId: tenant, name: 'LINE非依存の統括' });
    expect(testDb.raw.prepare(`SELECT account_id, tenant_id
      FROM rt_organizations`).get()).toEqual({ account_id: tenant, tenant_id: tenant });
  });

  it('認証スタッフと異なるtenant_idは403にする', async () => {
    authMocks.getStaffByApiKey.mockResolvedValue({
      id: 'admin-tenant', name: 'Admin', role: 'admin', access_level: 'full',
      permission_keys: '[]', assigned_line_account_id: null,
      can_access_descendant_accounts: 0,
      tenant_id: '00000000-0000-4000-8000-000000000001',
    });
    const response = await requestAs(
      '/api/restaurant-test/snapshot?tenant_id=00000000-0000-4000-8000-000000000099',
      'admin-key',
    );
    expect(response.status).toBe(403);
  });

  it('tenant_id未設定の認証スタッフも既定以外のtenant_idを拒否する', async () => {
    authMocks.getStaffByApiKey.mockResolvedValue({
      id: 'legacy-admin', name: 'Legacy Admin', role: 'admin', access_level: 'full',
      permission_keys: '[]', assigned_line_account_id: null,
      can_access_descendant_accounts: 0,
      tenant_id: null,
    });
    const response = await requestAs(
      '/api/restaurant-test/snapshot?tenant_id=00000000-0000-4000-8000-000000000099',
      'legacy-admin-key',
    );
    expect(response.status).toBe(403);
  });

  it('店舗未選択の管理画面セッションでは統括組織の全店舗を返す', async () => {
    seedRestaurantFixture();
    const session = await createAdminSession();

    const snapshot = await requestAs('/api/restaurant-test/snapshot?account_id=account-1', session);
    expect(snapshot.status).toBe(200);
    const json = await snapshot.json() as { data: { stores: unknown[] } };
    expect(json.data.stores).toHaveLength(2);
  });

  it('利用規約への同意を組織・現行版ごとに冪等記録する', async () => {
    seedRestaurantFixture();
    const body = { documentKey: 'musubo-terms', version: 'v0.1-draft' };
    const first = await request('/api/restaurant-test/terms-agreement?account_id=account-1', body);
    const second = await request('/api/restaurant-test/terms-agreement?account_id=account-1', body);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({
      success: true,
      data: { documentKey: 'musubo-terms', agreedVersion: 'v0.1-draft' },
    });
    const count = testDb.raw.prepare('SELECT COUNT(*) AS count FROM rt_organization_agreements').get() as { count: number };
    expect(count.count).toBe(1);
    const row = testDb.raw.prepare(`SELECT agreed_by_staff_id, document_key, document_version
      FROM rt_organization_agreements`).get() as Record<string, unknown>;
    expect(row).toEqual({
      agreed_by_staff_id: 'env-owner',
      document_key: 'musubo-terms',
      document_version: 'v0.1-draft',
    });
  });

  it('組織が無くてもGETは未同意を返し、行を作らない', async () => {
    const first = await request('/api/restaurant-test/terms-agreement');
    const second = await request('/api/restaurant-test/terms-agreement');
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toEqual({
      success: true,
      data: { documentKey: 'musubo-terms', agreedVersion: null, agreedAt: null },
    });
    expect(testDb.raw.prepare('SELECT COUNT(*) AS count FROM rt_organizations').get())
      .toMatchObject({ count: 0 });
  });

  it('最初の規約同意時に認証スタッフの統括組織を1件だけ作る', async () => {
    const tenant = '00000000-0000-4000-8000-000000000099';
    testDb.raw.prepare(`INSERT INTO tenants (id, name, feature_packs) VALUES (?, ?, '["restaurant"]')`)
      .run(tenant, '新しい統括');
    authMocks.getStaffByApiKey.mockResolvedValue({
      id: 'new-owner', name: 'New Owner', role: 'owner', access_level: 'full',
      permission_keys: '[]', assigned_line_account_id: null,
      can_access_descendant_accounts: 0, tenant_id: tenant,
    });
    const body = { documentKey: 'musubo-terms', version: 'v0.1-draft' };
    const [first, second] = await Promise.all([
      requestAs('/api/restaurant-test/terms-agreement', 'new-owner-key', body),
      requestAs('/api/restaurant-test/terms-agreement', 'new-owner-key', body),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(testDb.raw.prepare(`SELECT account_id, tenant_id, name, status
      FROM rt_organizations`).all()).toEqual([{
      account_id: tenant,
      tenant_id: tenant,
      name: '新しい統括',
      status: 'active',
    }]);
    expect(testDb.raw.prepare('SELECT COUNT(*) AS count FROM rt_organization_agreements').get())
      .toMatchObject({ count: 1 });
    const state = await requestAs('/api/restaurant-test/terms-agreement', 'new-owner-key');
    expect(state.status).toBe(200);
    await expect(state.json()).resolves.toMatchObject({
      success: true,
      data: { documentKey: 'musubo-terms', agreedVersion: 'v0.1-draft' },
    });
  });

  it('既存組織を作り直さずに規約同意を記録する', async () => {
    seedRestaurantFixture({ name: '既存組織' });
    const response = await request('/api/restaurant-test/terms-agreement', {
      documentKey: 'musubo-terms', version: 'v0.1-draft',
    });
    expect(response.status).toBe(200);
    expect(testDb.raw.prepare('SELECT id, name FROM rt_organizations').all())
      .toEqual([{ id: 'org-fixture', name: '既存組織' }]);
  });

  it('現行版以外の規約同意を拒否し、組織も作らない', async () => {
    const oldVersion = await request('/api/restaurant-test/terms-agreement?account_id=account-1', {
      documentKey: 'musubo-terms', version: 'v0.0-draft',
    });
    expect(oldVersion.status).toBe(400);
    expect(testDb.raw.prepare('SELECT COUNT(*) AS count FROM rt_organizations').get())
      .toMatchObject({ count: 0 });
    expect(testDb.raw.prepare('SELECT COUNT(*) AS count FROM rt_organization_agreements').get())
      .toMatchObject({ count: 0 });
  });

  it('staffは規約状態を読めるが同意記録は作れない', async () => {
    seedRestaurantFixture();
    authMocks.getStaffByApiKey.mockResolvedValue({
      id: 'staff-terms', name: 'Staff', role: 'staff', access_level: 'full',
      permission_keys: '[]', assigned_line_account_id: null,
      can_access_descendant_accounts: 0,
    });
    const state = await requestAs(
      '/api/restaurant-test/terms-agreement?account_id=account-1',
      'staff-key',
    );
    const denied = await requestAs(
      '/api/restaurant-test/terms-agreement?account_id=account-1',
      'staff-key',
      { documentKey: 'musubo-terms', version: 'v0.1-draft' },
    );
    expect(state.status).toBe(200);
    expect(denied.status).toBe(403);
  });

  it('同一組織の店舗だけをセッションへ保存し、統括へ戻すと選択を消す', async () => {
    seedRestaurantFixture();
    testDb.raw.prepare('INSERT INTO rt_organizations (id, account_id, name) VALUES (?, ?, ?)')
      .run('org-other', 'account-other', '別組織');
    testDb.raw.prepare('INSERT INTO rt_stores (id, organization_id, name, code, capacity) VALUES (?, ?, ?, ?, ?)')
      .run('store-other', 'org-other', '別店舗', 'OTHER', 10);
    const own = testDb.raw.prepare("SELECT id FROM rt_stores WHERE code = 'GINZA'").get() as { id: string };
    const session = await createAdminSession();

    const denied = await requestAs(
      '/api/restaurant-test/stores/store-other/select?account_id=account-1',
      session,
      {},
    );
    expect(denied.status).toBe(403);

    const selected = await requestAs(
      `/api/restaurant-test/stores/${own.id}/select?account_id=account-1`,
      session,
      {},
    );
    expect(selected.status).toBe(200);
    const scoped = await requestAs('/api/restaurant-test/snapshot?account_id=account-1', session);
    const scopedJson = await scoped.json() as { data: { stores: Array<{ id: string }> } };
    expect(scopedJson.data.stores.map((store) => store.id)).toEqual([own.id]);

    const cleared = await requestAs(
      '/api/restaurant-test/stores/selection/clear?account_id=account-1',
      session,
      {},
    );
    expect(cleared.status).toBe(200);
    const headquarters = await requestAs('/api/restaurant-test/snapshot?account_id=account-1', session);
    const headquartersJson = await headquarters.json() as { data: { stores: unknown[] } };
    expect(headquartersJson.data.stores).toHaveLength(2);
  });

  it('媒体予約を一方向で冪等取込し、外部書戻しを0件のままにする', async () => {
    seedRestaurantFixture();
    const store = testDb.raw.prepare('SELECT id FROM rt_stores ORDER BY code LIMIT 1').get() as { id: string };
    const payload = {
      storeId: store.id,
      provider: 'restaurant_board',
      eventId: 'event-100',
      reservation: {
        externalId: 'RB-9000', customerName: '検証 太郎', guestCount: 3,
        startsAt: '2026-08-22T09:00:00.000Z', endsAt: '2026-08-22T11:00:00.000Z',
      },
    };
    const first = await request('/api/restaurant-test/inbound/reservations?account_id=account-1', payload);
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({ data: { direction: 'inbound', outboundWrites: 0, duplicate: false } });

    const duplicate = await request('/api/restaurant-test/inbound/reservations?account_id=account-1', payload);
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({ data: { direction: 'inbound', duplicate: true } });
    const count = testDb.raw.prepare("SELECT COUNT(*) AS count FROM rt_reservations WHERE external_id = 'RB-9000'").get() as { count: number };
    expect(count.count).toBe(1);
    const direction = testDb.raw.prepare("SELECT sync_direction FROM rt_reservations WHERE external_id = 'RB-9000'").get() as { sync_direction: string };
    expect(direction.sync_direction).toBe('inbound_only');
  });

  it('双方向を示す未知の媒体値を拒否する', async () => {
    seedRestaurantFixture();
    const store = testDb.raw.prepare('SELECT id FROM rt_stores LIMIT 1').get() as { id: string };
    const response = await request('/api/restaurant-test/inbound/reservations?account_id=account-1', {
      storeId: store.id, provider: 'outbound', eventId: 'event-x', reservation: {},
    });
    expect(response.status).toBe(400);
  });

  it('取り込みアドレスはオーナーだけが発行でき、スタッフは拒否する', async () => {
    seedRestaurantFixture();
    const store = testDb.raw.prepare('SELECT id FROM rt_stores LIMIT 1').get() as { id: string };

    const issued = await request('/api/restaurant-test/intake-addresses?account_id=account-1', { storeId: store.id });
    expect(issued.status).toBe(201);
    expect(await issued.json()).toMatchObject({
      data: { address: expect.stringMatching(/^r-[a-z0-9]{32}@intake\.example\.test$/) },
    });

    authMocks.getStaffByApiKey.mockResolvedValue({
      id: 'staff-1',
      name: 'Staff',
      role: 'staff',
      access_level: 'full',
      permission_keys: '[]',
      assigned_line_account_id: null,
      can_access_descendant_accounts: 0,
    });
    const denied = await requestAs(
      '/api/restaurant-test/intake-addresses?account_id=account-1',
      'staff-key',
      { storeId: store.id },
    );
    expect(denied.status).toBe(403);
  });

  it('発行済みアドレスを管理者だけに一覧し、再発行後も旧アドレスの失効予定を返す', async () => {
    seedRestaurantFixture();
    const store = testDb.raw.prepare('SELECT id FROM rt_stores LIMIT 1').get() as { id: string };
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const first = await request('/api/restaurant-test/intake-addresses?account_id=account-1', { storeId: store.id });
      const firstJson = await first.json() as { data: { address: string } };
      const second = await request('/api/restaurant-test/intake-addresses?account_id=account-1', { storeId: store.id });
      const secondJson = await second.json() as { data: { address: string } };
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(secondJson.data.address).not.toBe(firstJson.data.address);

      authMocks.getStaffByApiKey.mockResolvedValue({
        id: 'admin-1',
        name: 'Admin',
        role: 'admin',
        access_level: 'full',
        permission_keys: '[]',
        assigned_line_account_id: null,
        can_access_descendant_accounts: 0,
      });
      const listed = await requestAs(
        `/api/restaurant-test/intake-addresses?account_id=account-1&storeId=${encodeURIComponent(store.id)}`,
        'admin-key',
      );
      expect(listed.status).toBe(200);
      const listedJson = await listed.json() as { data: Array<Record<string, unknown>> };
      expect(listedJson.data).toHaveLength(2);
      for (const item of listedJson.data) {
        expect(Object.keys(item).sort()).toEqual([
          'address', 'createdAt', 'id', 'localPart', 'revokedAt', 'status', 'storeId',
        ]);
        expect(item.status).toBe('active');
        expect(item.storeId).toBe(store.id);
      }
      const current = listedJson.data.find((item) => item.revokedAt === null);
      const retiring = listedJson.data.find((item) => typeof item.revokedAt === 'string');
      expect(current?.address).toBe(secondJson.data.address);
      expect(retiring?.address).toBe(firstJson.data.address);

      const logged = JSON.stringify([...log.mock.calls, ...warn.mock.calls, ...error.mock.calls]);
      expect(logged).not.toContain(firstJson.data.address);
      expect(logged).not.toContain(secondJson.data.address);

      authMocks.getStaffByApiKey.mockResolvedValue({
        id: 'staff-1',
        name: 'Staff',
        role: 'staff',
        access_level: 'full',
        permission_keys: '[]',
        assigned_line_account_id: null,
        can_access_descendant_accounts: 0,
      });
      const denied = await requestAs(
        `/api/restaurant-test/intake-addresses?account_id=account-1&storeId=${encodeURIComponent(store.id)}`,
        'staff-key',
      );
      expect(denied.status).toBe(403);
    } finally {
      log.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it('別組織の店舗の取り込みアドレスは一覧できない', async () => {
    seedRestaurantFixture();
    testDb.raw.prepare('INSERT INTO rt_organizations (id, account_id, name) VALUES (?, ?, ?)')
      .run('org-other', 'account-other', '別組織');
    testDb.raw.prepare('INSERT INTO rt_stores (id, organization_id, name, code, capacity) VALUES (?, ?, ?, ?, ?)')
      .run('store-other', 'org-other', '別店舗', 'OTHER', 10);

    const response = await request('/api/restaurant-test/intake-addresses?account_id=account-1&storeId=store-other');
    expect(response.status).toBe(400);
  });

  it('取り込みドメイン未設定時は一覧と発行を503にする', async () => {
    seedRestaurantFixture();
    const store = testDb.raw.prepare('SELECT id FROM rt_stores LIMIT 1').get() as { id: string };
    env.RESTAURANT_INTAKE_DOMAIN = undefined;

    const listed = await request(`/api/restaurant-test/intake-addresses?account_id=account-1&storeId=${encodeURIComponent(store.id)}`);
    expect(listed.status).toBe(503);
    const issued = await request('/api/restaurant-test/intake-addresses?account_id=account-1', { storeId: store.id });
    expect(issued.status).toBe(503);
  });

  it('LINEアカウント未指定では店舗を作成できない', async () => {
    seedRestaurantFixture();
    const response = await request('/api/restaurant-test/stores?account_id=account-1', {
      name: '新宿店', code: 'SHINJUKU', area: '東京', capacity: 20,
      timezone: 'Asia/Tokyo',
    });
    expect(response.status).toBe(400);
  });

  it('店舗名が空の場合は店舗を作成できない', async () => {
    seedRestaurantFixture();
    const response = await request('/api/restaurant-test/stores?account_id=account-1', {
      name: '', code: 'EMPTY', area: '東京', capacity: 20,
      timezone: 'Asia/Tokyo', lineAccountId: 'account-4',
    });
    expect(response.status).toBe(400);
  });

  it('不正なチャネルシークレットを接続エラーやログへ含めない', async () => {
    seedRestaurantFixture();
    const secret = 'invalid-secret-must-not-leak';
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/oauth/accessToken')) {
        return new Response(JSON.stringify({ message: secret }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('{}', { status: 500 });
    }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const response = await request('/api/restaurant-test/stores/connect?account_id=account-1', {
        name: '新店舗', alias: 'NEW', channelId: '1234567890', channelSecret: secret,
      });
      expect(response.status).toBe(400);
      expect(await response.text()).not.toContain(secret);
      expect(JSON.stringify([...log.mock.calls, ...warn.mock.calls, ...error.mock.calls])).not.toContain(secret);
    } finally {
      log.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it('接続確認が成功した場合だけLINEアカウントと店舗をまとめて作成する', async () => {
    const secret = 'wizard-test-secret';
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/oauth/accessToken')) {
        return new Response(JSON.stringify({
          access_token: 'wizard-access-token', expires_in: 2_592_000, token_type: 'Bearer',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes('/v2/bot/info')) {
        return new Response(JSON.stringify({ displayName: '新店舗公式LINE', basicId: '@newstore' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('{}', { status: 500 });
    }));

    const response = await request('/api/restaurant-test/stores/connect', {
      name: '新店舗', alias: 'NEW', channelId: '1234567890', channelSecret: secret,
    });
    expect(response.status).toBe(201);
    const payload = await response.text();
    expect(payload).toContain('新店舗公式LINE');
    expect(payload).not.toContain(secret);
    expect(payload).not.toContain('wizard-access-token');
    expect(testDb.raw.prepare("SELECT COUNT(*) AS count FROM rt_stores WHERE code = 'NEW'").get())
      .toMatchObject({ count: 1 });
    expect(testDb.raw.prepare("SELECT COUNT(*) AS count FROM line_accounts WHERE channel_id = '1234567890'").get())
      .toMatchObject({ count: 1 });
    expect(testDb.raw.prepare('SELECT COUNT(*) AS count FROM rt_organizations').get())
      .toMatchObject({ count: 1 });
    expect(testDb.raw.prepare(`SELECT la.tenant_id AS line_tenant, o.tenant_id AS organization_tenant
      FROM line_accounts la
      JOIN rt_stores s ON s.line_account_id = la.id
      JOIN rt_organizations o ON o.id = s.organization_id
      WHERE la.channel_id = '1234567890'`).get()).toEqual({
        line_tenant: '00000000-0000-4000-8000-000000000001',
        organization_tenant: '00000000-0000-4000-8000-000000000001',
      });
  });

  it('LINEアカウントを指定して店舗を作成・編集でき、スタッフは操作できない', async () => {
    seedRestaurantFixture();
    const created = await request('/api/restaurant-test/stores?account_id=account-1', {
      name: '新宿店', code: 'SHINJUKU', area: '東京', capacity: 20,
      timezone: 'Asia/Tokyo', lineAccountId: 'account-4',
    });
    expect(created.status).toBe(201);
    const createdJson = await created.json() as { data: { id: string } };

    const updated = await requestWithMethod(
      `/api/restaurant-test/stores/${createdJson.data.id}?account_id=account-1`,
      'PATCH',
      { name: '新宿本店', status: 'paused', lineAccountId: 'account-4' },
    );
    expect(updated.status).toBe(200);
    expect(testDb.raw.prepare('SELECT name, status, line_account_id FROM rt_stores WHERE id = ?').get(createdJson.data.id))
      .toMatchObject({ name: '新宿本店', status: 'paused', line_account_id: 'account-4' });

    authMocks.getStaffByApiKey.mockResolvedValue({
      id: 'staff-1', name: 'Staff', role: 'staff', access_level: 'full',
      permission_keys: '[]', assigned_line_account_id: null,
      can_access_descendant_accounts: 0,
    });
    const denied = await requestWithMethod(
      `/api/restaurant-test/stores/${createdJson.data.id}?account_id=account-1`,
      'PATCH',
      { status: 'active' },
      'staff-key',
    );
    expect(denied.status).toBe(403);
  });

  it('同じLINEアカウントを2店舗へ割り当てず、同一組織の店舗コード重複も拒否する', async () => {
    seedRestaurantFixture();
    const used = testDb.raw.prepare("SELECT line_account_id FROM rt_stores WHERE code = 'GINZA'").get() as { line_account_id: string };

    const duplicateAccount = await request('/api/restaurant-test/stores?account_id=account-1', {
      name: '新宿店', code: 'SHINJUKU', area: '東京', capacity: 20,
      timezone: 'Asia/Tokyo', lineAccountId: used.line_account_id,
    });
    expect(duplicateAccount.status).toBe(409);

    const duplicateCode = await request('/api/restaurant-test/stores?account_id=account-1', {
      name: '銀座別館', code: 'GINZA', area: '東京', capacity: 12,
      timezone: 'Asia/Tokyo', lineAccountId: 'account-4',
    });
    expect(duplicateCode.status).toBe(409);
  });

  it('他組織の店舗を更新できず、不正な店舗状態も拒否する', async () => {
    seedRestaurantFixture();
    testDb.raw.prepare('INSERT INTO rt_organizations (id, account_id, name) VALUES (?, ?, ?)')
      .run('org-other', 'account-other', '別組織');
    testDb.raw.prepare('INSERT INTO rt_stores (id, organization_id, name, code, capacity, line_account_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run('store-other', 'org-other', '別店舗', 'OTHER', 10, 'account-4');

    const other = await requestWithMethod(
      '/api/restaurant-test/stores/store-other?account_id=account-1',
      'PATCH',
      { status: 'archived' },
    );
    expect(other.status).toBe(400);

    const own = testDb.raw.prepare("SELECT id FROM rt_stores WHERE code = 'GINZA'").get() as { id: string };
    const invalid = await requestWithMethod(
      `/api/restaurant-test/stores/${own.id}?account_id=account-1`,
      'PATCH',
      { status: 'deleted' },
    );
    expect(invalid.status).toBe(400);
  });

  it('店舗LINEアカウントではその店舗だけ、統括アカウントでは全店舗を返す', async () => {
    seedRestaurantFixture();
    const storeView = await request('/api/restaurant-test/snapshot?account_id=account-2');
    expect(storeView.status).toBe(200);
    const storeJson = await storeView.json() as { data: { stores: Array<{ id: string }>; reservations: Array<{ store_id: string }>; tables: Array<{ store_id: string }> } };
    expect(storeJson.data.stores).toHaveLength(1);
    expect(storeJson.data.reservations.every((item) => item.store_id === storeJson.data.stores[0].id)).toBe(true);
    expect(storeJson.data.tables.every((item) => item.store_id === storeJson.data.stores[0].id)).toBe(true);

    const organizationView = await request('/api/restaurant-test/snapshot?account_id=account-1');
    const organizationJson = await organizationView.json() as { data: { stores: unknown[] } };
    expect(organizationJson.data.stores).toHaveLength(2);
  });

  it('LINE未割当はunconfigured、Webhook不一致はwarningとして導出する', async () => {
    seedRestaurantFixture();
    const stores = testDb.raw.prepare('SELECT id, code FROM rt_stores ORDER BY code').all() as Array<{ id: string; code: string }>;
    testDb.raw.prepare('UPDATE rt_stores SET line_account_id = NULL WHERE id = ?').run(stores[0].id);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      endpoint: 'https://different.example.test/webhook', active: true,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })));

    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const response = await request('/api/restaurant-test/snapshot?account_id=account-1');
      const json = await response.json() as { data: { stores: Array<{ id: string; line_status: string }> } };
      expect(json.data.stores.find((item) => item.id === stores[0].id)?.line_status).toBe('unconfigured');
      expect(json.data.stores.find((item) => item.id === stores[1].id)?.line_status).toBe('warning');
      expect(JSON.stringify([...log.mock.calls, ...warn.mock.calls, ...error.mock.calls])).not.toContain('token-');
    } finally {
      log.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it('店舗をarchivedにしても既存予約を削除せず、DELETE経路も持たない', async () => {
    seedRestaurantFixture();
    const store = testDb.raw.prepare("SELECT id FROM rt_stores WHERE code = 'GINZA'").get() as { id: string };
    const before = testDb.raw.prepare('SELECT COUNT(*) AS count FROM rt_reservations WHERE store_id = ?').get(store.id) as { count: number };
    const updated = await requestWithMethod(
      `/api/restaurant-test/stores/${store.id}?account_id=account-1`,
      'PATCH',
      { status: 'archived' },
    );
    expect(updated.status).toBe(200);
    const after = testDb.raw.prepare('SELECT COUNT(*) AS count FROM rt_reservations WHERE store_id = ?').get(store.id) as { count: number };
    expect(after.count).toBe(before.count);

    const deleted = await requestWithMethod(
      `/api/restaurant-test/stores/${store.id}?account_id=account-1`,
      'DELETE',
    );
    expect(deleted.status).toBe(404);
  });

  it('デモ用bootstrap APIを公開しない', async () => {
    // D-3: テストデータ作成を管理画面や公開APIへ戻さないための退行防止。
    const response = await request('/api/restaurant-test/bootstrap?account_id=account-1', {});
    expect(response.status).toBe(404);
  });

  it('この組織に存在しないLINEアカウントの飲食店データへアクセスさせない', async () => {
    const response = await request('/api/restaurant-test/snapshot?account_id=account-unknown');
    expect(response.status).toBe(403);
  });

  it('R100: 同じ卓・重なる時間の予約は2件目を409にし、在庫を人数分だけ増やす', async () => {
    seedRestaurantFixture();
    const store = testDb.raw.prepare("SELECT id FROM rt_stores WHERE code = 'GINZA'").get() as { id: string };
    testDb.raw.prepare(
      'INSERT INTO rt_tables (id, store_id, code, label, seat_type, min_capacity, max_capacity) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('table-2seat', store.id, 'T-02', 'テーブル2', 'table', 1, 2);
    testDb.raw.prepare(
      'INSERT INTO rt_inventory_slots (id, store_id, starts_at, total_capacity, ota_capacity, line_capacity, walk_in_capacity) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('slot-r100', store.id, '2026-09-10T10:00:00.000Z', 10, 4, 4, 2);
    const body = {
      storeId: store.id, customerName: '重複 太郎', guestCount: 2,
      startsAt: '2026-09-10T10:00:00.000Z', endsAt: '2026-09-10T12:00:00.000Z',
    };
    const first = await request('/api/restaurant-test/reservations/manual?account_id=account-1', body);
    expect(first.status).toBe(201);
    const second = await request('/api/restaurant-test/reservations/manual?account_id=account-1', {
      ...body, customerName: '重複 次郎', tableId: 'table-2seat',
    });
    expect(second.status).toBe(409);
    const count = testDb.raw.prepare(
      'SELECT COUNT(*) AS count FROM rt_reservations WHERE store_id = ? AND starts_at = ?',
    ).get(store.id, '2026-09-10T10:00:00.000Z') as { count: number };
    expect(count.count).toBe(1);
    const slot = testDb.raw.prepare(
      'SELECT reserved_count FROM rt_inventory_slots WHERE id = ?',
    ).get('slot-r100') as { reserved_count: number };
    expect(slot.reserved_count).toBe(2);
  });

  it('R100: 重ならない時間・別の卓の予約は登録できる', async () => {
    seedRestaurantFixture();
    const store = testDb.raw.prepare("SELECT id FROM rt_stores WHERE code = 'GINZA'").get() as { id: string };
    const first = await request('/api/restaurant-test/reservations/manual?account_id=account-1', {
      storeId: store.id, customerName: '昼 太郎', guestCount: 2,
      startsAt: '2026-09-10T10:00:00.000Z', endsAt: '2026-09-10T12:00:00.000Z',
    });
    expect(first.status).toBe(201);
    const later = await request('/api/restaurant-test/reservations/manual?account_id=account-1', {
      storeId: store.id, customerName: '夜 花子', guestCount: 2,
      startsAt: '2026-09-10T12:00:00.000Z', endsAt: '2026-09-10T14:00:00.000Z',
    });
    expect(later.status).toBe(201);
  });

  it('R101: 失敗した連携イベントの再送は予約を取り込む', async () => {
    seedRestaurantFixture();
    const store = testDb.raw.prepare("SELECT id FROM rt_stores WHERE code = 'GINZA'").get() as { id: string };
    testDb.raw.prepare(
      'INSERT INTO rt_sync_events (id, store_id, provider, external_event_id, payload_json, status, error_message) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('event-failed', store.id, 'restaurant_board', 'event-retry-1', '{}', 'failed', 'boom');
    const retry = await request('/api/restaurant-test/inbound/reservations?account_id=account-1', {
      storeId: store.id, provider: 'restaurant_board', eventId: 'event-retry-1',
      reservation: {
        externalId: 'RB-RETRY', customerName: '再送 太郎', guestCount: 2,
        startsAt: '2026-09-11T10:00:00.000Z', endsAt: '2026-09-11T12:00:00.000Z',
      },
    });
    expect(retry.status).toBe(201);
    const count = testDb.raw.prepare("SELECT COUNT(*) AS count FROM rt_reservations WHERE external_id = 'RB-RETRY'").get() as { count: number };
    expect(count.count).toBe(1);
    const event = testDb.raw.prepare('SELECT status FROM rt_sync_events WHERE id = ?').get('event-failed') as { status: string };
    expect(event.status).toBe('processed');
  });

  it('R102: 古い連携通知は取消済み予約を確定に戻さない', async () => {
    seedRestaurantFixture();
    const store = testDb.raw.prepare("SELECT id FROM rt_stores WHERE code = 'GINZA'").get() as { id: string };
    const cancel = await request('/api/restaurant-test/inbound/reservations?account_id=account-1', {
      storeId: store.id, provider: 'restaurant_board', eventId: 'event-new-1',
      reservation: {
        externalId: 'RB-STALE', customerName: '取消 太郎', guestCount: 2,
        startsAt: '2026-09-12T10:00:00.000Z', endsAt: '2026-09-12T12:00:00.000Z',
        status: 'cancelled', sourceUpdatedAt: '2026-09-12T10:00:00.000Z',
      },
    });
    expect(cancel.status).toBe(201);
    const stale = await request('/api/restaurant-test/inbound/reservations?account_id=account-1', {
      storeId: store.id, provider: 'restaurant_board', eventId: 'event-old-1',
      reservation: {
        externalId: 'RB-STALE', customerName: '取消 太郎', guestCount: 2,
        startsAt: '2026-09-12T10:00:00.000Z', endsAt: '2026-09-12T12:00:00.000Z',
        status: 'confirmed', sourceUpdatedAt: '2026-09-12T09:00:00.000Z',
      },
    });
    expect(stale.status).toBe(200);
    expect(await stale.json()).toMatchObject({ data: { stale: true } });
    const row = testDb.raw.prepare("SELECT status FROM rt_reservations WHERE external_id = 'RB-STALE'").get() as { status: string };
    expect(row.status).toBe('cancelled');
  });

  it('R103: 予約台帳を期間・状態で絞り込み総件数とページを返す', async () => {
    seedRestaurantFixture();
    const store = testDb.raw.prepare("SELECT id FROM rt_stores WHERE code = 'GINZA'").get() as { id: string };
    const rows = [
      ['past-1', '2026-01-10T10:00:00.000Z', 'visited'],
      ['future-1', '2026-12-10T10:00:00.000Z', 'confirmed'],
      ['future-2', '2026-12-11T10:00:00.000Z', 'cancelled'],
    ] as const;
    for (const [id, startsAt, status] of rows) {
      testDb.raw.prepare(
        'INSERT INTO rt_reservations (id, store_id, source, external_id, customer_name, guest_count, starts_at, ends_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(id, store.id, 'manual', `EXT-${id}`, '絞込 太郎', 2, startsAt, '2026-12-10T12:00:00.000Z', status);
    }
    const upcoming = await request('/api/restaurant-test/snapshot?account_id=account-1&reservationFrom=2026-06-01');
    const upcomingJson = await upcoming.json() as { data: { reservations: Array<{ id: string }>; reservationTotal: number } };
    expect(upcomingJson.data.reservationTotal).toBe(3);
    expect(upcomingJson.data.reservations.map((item) => item.id).sort()).toEqual(['future-1', 'future-2', 'reservation-ginza'].sort());

    const cancelled = await request('/api/restaurant-test/snapshot?account_id=account-1&reservationStatus=cancelled');
    const cancelledJson = await cancelled.json() as { data: { reservations: Array<{ id: string }>; reservationTotal: number } };
    expect(cancelledJson.data.reservationTotal).toBe(1);
    expect(cancelledJson.data.reservations[0].id).toBe('future-2');

    const page = await request('/api/restaurant-test/snapshot?account_id=account-1&reservationFrom=2026-06-01&reservationLimit=1&reservationOffset=1');
    const pageJson = await page.json() as { data: { reservations: unknown[]; reservationTotal: number } };
    expect(pageJson.data.reservationTotal).toBe(3);
    expect(pageJson.data.reservations).toHaveLength(1);

    const bad = await request('/api/restaurant-test/snapshot?account_id=account-1&reservationStatus=deleted');
    expect(bad.status).toBe(400);
  });

  it('R107: 予約の人数・日時・卓の変更と取消で在庫が連動する', async () => {
    seedRestaurantFixture();
    const store = testDb.raw.prepare("SELECT id FROM rt_stores WHERE code = 'GINZA'").get() as { id: string };
    testDb.raw.prepare(
      'INSERT INTO rt_inventory_slots (id, store_id, starts_at, total_capacity, ota_capacity, line_capacity, walk_in_capacity) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('slot-r107', store.id, '2026-10-10T10:00:00.000Z', 10, 4, 4, 2);
    const created = await request('/api/restaurant-test/reservations/manual?account_id=account-1', {
      storeId: store.id, customerName: '変更 太郎', guestCount: 2,
      startsAt: '2026-10-10T10:00:00.000Z', endsAt: '2026-10-10T12:00:00.000Z',
    });
    expect(created.status).toBe(201);
    const { data: createdData } = await created.json() as { data: { id: string } };
    const id = createdData.id;
    const slotOf = () => (testDb.raw.prepare('SELECT reserved_count FROM rt_inventory_slots WHERE id = ?').get('slot-r107') as { reserved_count: number }).reserved_count;
    expect(slotOf()).toBe(2);

    const grown = await requestWithMethod(`/api/restaurant-test/reservations/${id}?account_id=account-1`, 'PATCH', { guestCount: 3 });
    expect(grown.status).toBe(200);
    expect(slotOf()).toBe(3);

    const cancelled = await requestWithMethod(`/api/restaurant-test/reservations/${id}?account_id=account-1`, 'PATCH', { status: 'cancelled' });
    expect(cancelled.status).toBe(200);
    expect(slotOf()).toBe(0);

    const restored = await requestWithMethod(`/api/restaurant-test/reservations/${id}?account_id=account-1`, 'PATCH', { status: 'confirmed' });
    expect(restored.status).toBe(200);
    expect(slotOf()).toBe(3);

    const missing = await requestWithMethod('/api/restaurant-test/reservations/no-such-id?account_id=account-1', 'PATCH', { guestCount: 2 });
    expect(missing.status).toBe(404);
    const badCount = await requestWithMethod(`/api/restaurant-test/reservations/${id}?account_id=account-1`, 'PATCH', { guestCount: 0 });
    expect(badCount.status).toBe(400);
  });

  it('R107: 重なる卓への変更は409にする', async () => {
    seedRestaurantFixture();
    const store = testDb.raw.prepare("SELECT id FROM rt_stores WHERE code = 'GINZA'").get() as { id: string };
    testDb.raw.prepare(
      'INSERT INTO rt_tables (id, store_id, code, label, seat_type, min_capacity, max_capacity) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('table-fixed', store.id, 'T-09', '固定卓', 'table', 1, 8);
    const first = await request('/api/restaurant-test/inbound/reservations?account_id=account-1', {
      storeId: store.id, provider: 'restaurant_board', eventId: 'event-seat-a',
      reservation: {
        externalId: 'RB-SEAT-A', customerName: '先客 太郎', guestCount: 2,
        startsAt: '2026-10-20T10:00:00.000Z', endsAt: '2026-10-20T12:00:00.000Z',
        tableId: 'table-fixed',
      },
    });
    expect(first.status).toBe(201);
    const second = await request('/api/restaurant-test/inbound/reservations?account_id=account-1', {
      storeId: store.id, provider: 'restaurant_board', eventId: 'event-seat-b',
      reservation: {
        externalId: 'RB-SEAT-B', customerName: '後客 次郎', guestCount: 2,
        startsAt: '2026-10-20T10:00:00.000Z', endsAt: '2026-10-20T12:00:00.000Z',
      },
    });
    expect(second.status).toBe(201);
    const { data } = await (await request('/api/restaurant-test/snapshot?account_id=account-1')).json() as { data: { reservations: Array<{ id: string; external_id: string }> } };
    const target = data.reservations.find((item) => item.external_id === 'RB-SEAT-B');
    expect(target).toBeDefined();
    const conflict = await requestWithMethod(`/api/restaurant-test/reservations/${target!.id}?account_id=account-1`, 'PATCH', { tableId: 'table-fixed' });
    expect(conflict.status).toBe(409);
  });

  it('卓の位置と結合を保存し、省略時は保持・nullで結合を解除する', async () => {
    seedRestaurantFixture();
    const path = '/api/restaurant-test/tables/table-ginza?account_id=account-1';
    expect((await requestWithMethod(path, 'PATCH', { floorX: 0, floorY: 120, joinGroup: '組1' })).status).toBe(200);
    expect((await requestWithMethod(path, 'PATCH', { label: '配置済み' })).status).toBe(200);
    expect(testDb.raw.prepare('SELECT floor_x, floor_y, join_group FROM rt_tables WHERE id = ?').get('table-ginza'))
      .toEqual({ floor_x: 0, floor_y: 120, join_group: '組1' });
    expect((await requestWithMethod(path, 'PATCH', { joinGroup: null })).status).toBe(200);
    expect(testDb.raw.prepare('SELECT join_group FROM rt_tables WHERE id = ?').get('table-ginza')).toEqual({ join_group: null });
    for (const body of [{ floorX: 1.5 }, { floorY: null }, { joinGroup: 3 }]) {
      expect((await requestWithMethod(path, 'PATCH', body)).status).toBe(400);
    }
  });

  it('R107: 卓を変更・停止・再開しても予約の参照を残し、別組織の卓は変更しない', async () => {
    seedRestaurantFixture();
    const path = '/api/restaurant-test/tables/table-ginza?account_id=account-1';
    expect((await requestWithMethod(path, 'PATCH', { code: 'T-10', label: '窓際', seatType: 'counter', minCapacity: 1, maxCapacity: 2 })).status).toBe(200);
    expect((await requestWithMethod(path, 'PATCH', { isActive: false })).status).toBe(200);
    expect(testDb.raw.prepare('SELECT code, label, seat_type, is_active FROM rt_tables WHERE id = ?').get('table-ginza')).toEqual({ code: 'T-10', label: '窓際', seat_type: 'counter', is_active: 0 });
    expect(testDb.raw.prepare('SELECT table_id FROM rt_reservations WHERE id = ?').get('reservation-ginza')).toEqual({ table_id: 'table-ginza' });
    const stoppedBooking = await request('/api/restaurant-test/reservations/manual?account_id=account-1', { storeId: 'store-ginza', customerName: '停止確認', guestCount: 2, startsAt: '2026-10-10T10:00:00.000Z', endsAt: '2026-10-10T12:00:00.000Z', tableId: 'table-ginza' });
    expect(stoppedBooking.status).toBe(400);
    const inbound = await request('/api/restaurant-test/inbound/reservations?account_id=account-1', { storeId: 'store-ginza', provider: 'restaurant_board', eventId: 'stopped-table', reservation: { externalId: 'RB-STOP-T', customerName: '停止確認', guestCount: 2, startsAt: '2026-10-10T10:00:00.000Z', endsAt: '2026-10-10T12:00:00.000Z', tableId: 'table-ginza' } });
    expect(inbound.status).toBe(400);
    expect(testDb.raw.prepare("SELECT status FROM rt_sync_events WHERE external_event_id = 'stopped-table'").get()).toEqual({ status: 'failed' });
    expect((await requestWithMethod(path, 'PATCH', { isActive: true })).status).toBe(200);
    expect((await requestWithMethod(path, 'PATCH', { minCapacity: 3, maxCapacity: 2 })).status).toBe(400);
    expect((await requestWithMethod('/api/restaurant-test/tables/table-ginza?account_id=account-4', 'PATCH', { label: '改ざん' })).status).not.toBe(200);
  });

  it('R107: メニューを変更・保管・再開しても予約の参照を残す', async () => {
    seedRestaurantFixture();
    const path = '/api/restaurant-test/menu/menu-ginza?account_id=account-1';
    expect((await requestWithMethod(path, 'PATCH', { name: '新コース', kind: 'course', price: 9900, allergens: ['卵'], servicePeriods: ['lunch'] })).status).toBe(200);
    expect((await requestWithMethod(path, 'PATCH', { status: 'archived' })).status).toBe(200);
    expect(testDb.raw.prepare('SELECT name, price, status, allergens_json FROM rt_menu_items WHERE id = ?').get('menu-ginza')).toEqual({ name: '新コース', price: 9900, status: 'archived', allergens_json: '["卵"]' });
    expect(testDb.raw.prepare('SELECT course_id FROM rt_reservations WHERE id = ?').get('reservation-ginza')).toEqual({ course_id: 'menu-ginza' });
    const stoppedBooking = await request('/api/restaurant-test/reservations/manual?account_id=account-1', { storeId: 'store-ginza', customerName: '停止確認', guestCount: 2, startsAt: '2026-10-10T10:00:00.000Z', endsAt: '2026-10-10T12:00:00.000Z', courseId: 'menu-ginza' });
    expect(stoppedBooking.status).toBe(400);
    const inbound = await request('/api/restaurant-test/inbound/reservations?account_id=account-1', { storeId: 'store-ginza', provider: 'restaurant_board', eventId: 'stopped-course', reservation: { externalId: 'RB-STOP-C', customerName: '停止確認', guestCount: 2, startsAt: '2026-10-10T10:00:00.000Z', endsAt: '2026-10-10T12:00:00.000Z', courseId: 'menu-ginza' } });
    expect(inbound.status).toBe(400);
    expect((await requestWithMethod(path, 'PATCH', { status: 'active' })).status).toBe(200);
    expect((await requestWithMethod(path, 'PATCH', { price: -1 })).status).toBe(400);
  });

  it('R107: 所属ユーザーの変更・停止・再開と権限の境界', async () => {
    seedRestaurantFixture();
    testDb.raw.prepare("INSERT INTO rt_memberships (id, organization_id, store_id, staff_name, role) VALUES ('member-ginza', 'org-fixture', 'store-ginza', '旧名', 'staff')").run();
    const path = '/api/restaurant-test/memberships/member-ginza?account_id=account-1';
    expect((await requestWithMethod(path, 'PATCH', { staffName: '新名', role: 'store_manager', email: 'new@example.test' })).status).toBe(200);
    expect((await requestWithMethod(path, 'PATCH', { status: 'suspended' })).status).toBe(200);
    expect(testDb.raw.prepare('SELECT staff_name, role, status FROM rt_memberships WHERE id = ?').get('member-ginza')).toEqual({ staff_name: '新名', role: 'store_manager', status: 'suspended' });
    expect((await requestWithMethod(path, 'PATCH', { status: 'active' })).status).toBe(200);
    expect((await requestWithMethod(path, 'PATCH', { storeId: 'no-such-store' })).status).toBe(400);
    authMocks.getStaffByApiKey.mockResolvedValue({ id: 'admin-test', name: '管理者', role: 'admin', access_level: 'full', permission_keys: '[]', assigned_line_account_id: null, can_access_descendant_accounts: 1 });
    expect((await requestWithMethod(path, 'PATCH', { role: 'super_admin' }, 'admin-key')).status).toBe(403);
  });

  it('R107: 店舗を選択した管理者は別店舗の卓・メニュー・所属ユーザーを更新できない', async () => {
    seedRestaurantFixture();
    testDb.raw.prepare("INSERT INTO rt_tables (id, store_id, code, label, seat_type, min_capacity, max_capacity) VALUES ('table-yokohama', 'store-yokohama', 'Y1', '横浜卓', 'table', 1, 4)").run();
    testDb.raw.prepare("INSERT INTO rt_menu_items (id, store_id, kind, name, price) VALUES ('menu-yokohama', 'store-yokohama', 'course', '横浜コース', 2000)").run();
    testDb.raw.prepare("INSERT INTO rt_memberships (id, organization_id, store_id, staff_name, role) VALUES ('member-yokohama', 'org-fixture', 'store-yokohama', '横浜スタッフ', 'staff')").run();
    const session = await createAdminSession();
    expect((await requestAs('/api/restaurant-test/stores/store-ginza/select?account_id=account-1', session, {})).status).toBe(200);
    for (const [entity, id, body] of [
      ['tables', 'table-yokohama', { label: '改ざん' }],
      ['menu', 'menu-yokohama', { name: '改ざん' }],
      ['memberships', 'member-yokohama', { staffName: '改ざん' }],
    ] as const) {
      expect((await requestWithMethod(`/api/restaurant-test/${entity}/${id}?account_id=account-1`, 'PATCH', body, session)).status).toBe(404);
    }
    expect((await requestWithMethod('/api/restaurant-test/memberships/member-yokohama?account_id=account-1', 'PATCH', { storeId: 'store-ginza' }, session)).status).toBe(404);
    expect(testDb.raw.prepare("SELECT staff_name FROM rt_memberships WHERE id = 'member-yokohama'").get()).toEqual({ staff_name: '横浜スタッフ' });
  });

  it('R102: 新しい連携通知は予約を更新する', async () => {
    seedRestaurantFixture();
    const store = testDb.raw.prepare("SELECT id FROM rt_stores WHERE code = 'GINZA'").get() as { id: string };
    const base = {
      storeId: store.id, provider: 'restaurant_board',
      reservation: {
        externalId: 'RB-FRESH', customerName: '更新 太郎', guestCount: 2,
        startsAt: '2026-09-13T10:00:00.000Z', endsAt: '2026-09-13T12:00:00.000Z',
        status: 'confirmed', sourceUpdatedAt: '2026-09-13T09:00:00.000Z',
      },
    };
    expect((await request('/api/restaurant-test/inbound/reservations?account_id=account-1', { ...base, eventId: 'event-fresh-1' })).status).toBe(201);
    const newer = await request('/api/restaurant-test/inbound/reservations?account_id=account-1', {
      ...base, eventId: 'event-fresh-2',
      reservation: { ...base.reservation, guestCount: 4, sourceUpdatedAt: '2026-09-13T10:00:00.000Z' },
    });
    expect(newer.status).toBe(201);
    const row = testDb.raw.prepare("SELECT guest_count FROM rt_reservations WHERE external_id = 'RB-FRESH'").get() as { guest_count: number };
    expect(row.guest_count).toBe(4);
  });
});


describe('V8-B 卓から出す予約枠と週の営業時間', () => {
  const slotPath = '/api/restaurant-test/inventory/inventory-test?account_id=account-1';
  function seedCapacity() {
    seedRestaurantFixture();
    testDb.raw.prepare("UPDATE rt_tables SET is_active = 0 WHERE id = 'table-ginza'").run();
    for (const [i, capacity] of [2, 2, 4, 4, 1, 1, 8, 4].entries()) {
      testDb.raw.prepare('INSERT INTO rt_tables (id, store_id, code, label, seat_type, min_capacity, max_capacity) VALUES (?, ?, ?, ?, ?, 1, ?)')
        .run(`v8-${i}`, 'store-ginza', `V8-${i}`, `卓${i}`, 'table', capacity);
    }
    testDb.raw.prepare("INSERT INTO rt_inventory_slots (id, store_id, starts_at, total_capacity) VALUES ('inventory-test', 'store-ginza', '2026-10-20T09:00:00Z', 999)").run();
  }
  const capacities = (expectedVersion = 1) => ({ otaCapacity: 10, lineCapacity: 10, walkInCapacity: 6, expectedVersion });
  const hours = () => Array.from({ length: 7 }, (_, weekday) => ({ weekday, periods: weekday === 0 ? [] : [{ opensAt: '17:00', closesAt: '23:00' }] }));
  it('停止中の卓を除いた合計26席を返し、任意の総数で増やせない', async () => {
    seedCapacity();
    const snapshot = await request('/api/restaurant-test/snapshot?account_id=account-1');
    expect((await snapshot.json() as any).data.inventory.find((row: any) => row.id === 'inventory-test')).toMatchObject({ total_capacity: 26, version: 1 });
    const saved = await requestWithMethod(slotPath, 'PUT', { ...capacities(), totalCapacity: 999 });
    expect(saved.status).toBe(200);
    expect((await saved.json() as any).data).toMatchObject({ totalCapacity: 26, version: 2 });
    expect(testDb.raw.prepare("SELECT total_capacity, updated_by FROM rt_inventory_slots WHERE id = 'inventory-test'").get()).toMatchObject({ total_capacity: 26 });
  });
  it('26席を超える配分と版なしを400、同じ版の再保存を409にする', async () => {
    seedCapacity();
    expect((await requestWithMethod(slotPath, 'PUT', { ...capacities(), walkInCapacity: 7 })).status).toBe(400);
    expect((await requestWithMethod(slotPath, 'PUT', { otaCapacity: 1, lineCapacity: 1, walkInCapacity: 1 })).status).toBe(400);
    expect((await requestWithMethod(slotPath, 'PUT', capacities())).status).toBe(200);
    expect((await requestWithMethod(slotPath, 'PUT', capacities())).status).toBe(409);
  });
  it('卓を止めると総席数と版が変わり、古い配分の保存を拒否する', async () => {
    seedCapacity();
    await requestWithMethod('/api/restaurant-test/tables/v8-6?account_id=account-1', 'PATCH', { isActive: false });
    expect(testDb.raw.prepare("SELECT total_capacity, version FROM rt_inventory_slots WHERE id = 'inventory-test'").get()).toEqual({ total_capacity: 18, version: 2 });
    expect((await requestWithMethod(slotPath, 'PUT', capacities())).status).toBe(409);
    expect((await requestWithMethod(slotPath, 'PUT', capacities(2))).status).toBe(400);
  });
  it('7曜日まとめて保存し、同じ版の保存を409にする', async () => {
    seedCapacity();
    const path = '/api/restaurant-test/opening-hours?account_id=account-1&storeId=store-ginza';
    expect((await (await request(path)).json() as any).data).toMatchObject({ hours: null, version: 0 });
    const body = { storeId: 'store-ginza', hours: hours(), expectedVersion: 0 };
    expect((await requestWithMethod(path, 'PUT', body)).status).toBe(200);
    expect((await requestWithMethod(path, 'PUT', body)).status).toBe(409);
    const get = await request(path);
    expect((await get.json() as any).data).toMatchObject({ hours: hours(), version: 1 });
    expect((await requestWithMethod(path, 'PUT', { ...body, expectedVersion: 1 })).status).toBe(200);
    expect((await requestWithMethod(path, 'PUT', { ...body, expectedVersion: 1 })).status).toBe(409);
    expect((await requestWithMethod(path, 'PUT', { ...body, hours: hours().slice(0, 6), expectedVersion: 2 })).status).toBe(400);
  });
  it('選択中の店舗以外の予約枠と営業時間は変えられない', async () => {
    seedCapacity();
    expect((await requestWithMethod('/api/restaurant-test/opening-hours?account_id=account-2', 'PUT', { storeId: 'store-yokohama', hours: hours(), expectedVersion: 0 })).status).toBe(400);
    const token = await createAdminSession();
    await requestAs('/api/restaurant-test/stores/store-yokohama/select?account_id=account-1', token, {});
    expect((await requestWithMethod(slotPath, 'PUT', capacities(), token)).status).toBe(404);
    expect((await requestWithMethod('/api/restaurant-test/opening-hours?account_id=account-1', 'PUT', { storeId: 'store-ginza', hours: hours(), expectedVersion: 0 }, token)).status).toBe(400);
  });
});

describe('R2-18 飲食メニューの説明と登録画像', () => {
  it('登録済み画像と説明を保存し、読み直せる', () => checkRestaurantMenuMedia({ testDb, seedRestaurantFixture, request, requestWithMethod }));
});
describe('V8-B メニューの価格確定', () => {
  const menuPath = '/api/restaurant-test/menus/menu-ginza?account_id=account-1';
  it('価格の上限は作成と更新の両方で守る', () => checkRestaurantMenuPrice({ testDb, seedRestaurantFixture, request, requestWithMethod }));
  it('権限者の保存で価格を即時確定し、二重承認を受け付けない', async () => {
    seedRestaurantFixture();
    const response = await requestWithMethod(menuPath, 'PATCH', { price: 9900 });
    expect(response.status).toBe(200);
    const { data } = await response.json() as any;
    expect(data.pendingPrice).toBeNull();
    expect(testDb.raw.prepare("SELECT price FROM rt_menu_items WHERE id = 'menu-ginza'").get()).toEqual({ price: 9900 });
    const list = await request('/api/restaurant-test/menus?account_id=account-1&storeId=store-ginza');
    expect((await list.json() as any).data[0].pendingPrice).toBeNull();
    const snapshot = await request('/api/restaurant-test/snapshot?account_id=account-1');
    expect((await snapshot.json() as any).data.menuItems[0].price).toBe(9900);
    const approval = `/api/restaurant-test/approvals/${data.approvalId}?account_id=account-1`;
    expect((await requestWithMethod(approval, 'PATCH', { action: 'approve' })).status).toBe(409);
    expect(testDb.raw.prepare("SELECT before_price, after_price, requested_by, status FROM rt_menu_change_requests").get()).toMatchObject({ before_price: 8800, after_price: 9900, status: 'applied' });
    expect(testDb.raw.prepare('SELECT status, reviewed_by FROM rt_approval_requests WHERE id = ?').get(data.approvalId)).toMatchObject({ status: 'approved', reviewed_by: expect.any(String) });
    expect((await requestWithMethod(menuPath, 'PATCH', { price: 10000 })).status).toBe(200);
    expect(testDb.raw.prepare("SELECT price FROM rt_menu_items WHERE id = 'menu-ginza'").get()).toEqual({ price: 10000 });
  });
  it('以前の申請が残る場合は新しい価格変更を止める', async () => {
    seedRestaurantFixture();
    testDb.raw.prepare("INSERT INTO rt_approval_requests(id,organization_id,store_id,kind,title,status) VALUES('old-approval','org-fixture','store-ginza','menu_change','以前の申請','pending')").run();
    testDb.raw.prepare("INSERT INTO rt_menu_change_requests(id,approval_id,menu_id,store_id,before_price,after_price,requested_by) VALUES('old-change','old-approval','menu-ginza','store-ginza',8800,9900,'test')").run();
    expect((await requestWithMethod(menuPath, 'PATCH', { price: 9500 })).status).toBe(409);
    expect(testDb.raw.prepare("SELECT price FROM rt_menu_items WHERE id = 'menu-ginza'").get()).toEqual({ price: 8800 });
    expect(testDb.raw.prepare('SELECT COUNT(*) AS total FROM rt_menu_change_requests').get()).toEqual({ total: 1 });
  });
  it('参照がなければ公開後に下書きへ戻したメニューも削除できる', async () => {
    seedRestaurantFixture();
    const create = () => request('/api/restaurant-test/menu?account_id=account-1', { storeId: 'store-ginza', kind: 'course', name: '下書き', price: 1000, status: 'draft' });
    const first = (await (await create()).json() as any).data.id;
    expect((await requestWithMethod(`/api/restaurant-test/menus/${first}?account_id=account-1`, 'DELETE')).status).toBe(200);
    const id = (await (await create()).json() as any).data.id;
    const path = `/api/restaurant-test/menus/${id}?account_id=account-1`;
    await requestWithMethod(path, 'PATCH', { status: 'active' });
    await requestWithMethod(path, 'PATCH', { status: 'draft' });
    expect((await requestWithMethod(path, 'DELETE')).status).toBe(200);
    expect((await requestWithMethod(menuPath, 'DELETE')).status).toBe(409);
  });
  it('他店舗からの申請・削除を拒否する', async () => {
    seedRestaurantFixture();
    const token = await createAdminSession();
    expect((await requestAs('/api/restaurant-test/stores/store-yokohama/select?account_id=account-1', token, {})).status).toBe(200);
    expect((await requestWithMethod(menuPath, 'PATCH', { price: 9999 }, token)).status).toBe(404);
    expect((await requestWithMethod(menuPath, 'DELETE', undefined, token)).status).toBe(404);
  });
});

describe('V8-B 予約経路と隔離メール', () => {
  function seedEmails() {
    seedRestaurantFixture();
    testDb.raw.exec(`INSERT INTO rt_media (id, code, name, parser_key) VALUES ('hp', 'hotpepper', 'ホットペッパー', 'hotpepper');
      INSERT INTO rt_media (id, code, name, parser_key, is_active) VALUES ('tc', 'tablecheck', 'TableCheck', 'tablecheck', 0);
      INSERT INTO rt_inbound_emails (id, message_id, store_id, media_id, status, quarantine_reason) VALUES
        ('email-1', 'message-1', 'store-ginza', 'hp', 'quarantined', 'unprocessed:kind_unknown');
      INSERT INTO rt_inbound_emails (id, message_id, store_id, media_id, status, received_at) VALUES
        ('email-2', 'message-2', 'store-ginza', 'hp', 'received', datetime('now', '-3 days')),
        ('email-other', 'message-other', 'store-yokohama', 'hp', 'quarantined', datetime('now'));
      INSERT INTO rt_inventory_slots (id, store_id, starts_at, total_capacity) VALUES ('slot', 'store-ginza', '2026-10-15T10:00:00.000Z', 4);`);
  }
  it('店舗別の今日の受信件数・隔離件数と準備中の媒体を返す', async () => {
    seedEmails();
    const res = await request('/api/restaurant-test/channels?account_id=account-1&storeId=store-ginza');
    expect(res.status).toBe(200);
    const data = (await res.json() as any).data;
    expect(data.find((row: any) => row.code === 'hotpepper')).toMatchObject({ receiveMethod: 'email_forward', todayCount: 1, unreadableCount: 1, status: 'receiving' });
    expect(data.find((row: any) => row.code === 'tablecheck')).toMatchObject({ status: 'preparing', todayCount: 0 });
    expect(data.find((row: any) => row.code === 'restaurant_board')).toMatchObject({ receiveMethod: 'direct' });
    const list = await request('/api/restaurant-test/inbound-emails?account_id=account-1&storeId=store-ginza&status=quarantined');
    const result = await list.json() as any;
    expect(result.total).toBe(1);
    expect(result.data[0]).toMatchObject({ id: 'email-1', reason: 'unprocessed:kind_unknown' });
    expect(result.data[0]).not.toHaveProperty('r2_key');
    expect((await request('/api/restaurant-test/channels?account_id=account-2&storeId=store-yokohama')).status).toBe(400);
    expect((await request('/api/restaurant-test/inbound-emails?account_id=account-2&storeId=store-yokohama')).status).toBe(400);
  });
  it('隔離メールを予約と在庫へ一度だけ取り込む', async () => {
    seedEmails();
    const path = '/api/restaurant-test/inbound-emails/email-1/manual-import?account_id=account-1';
    const body = { customerName: '取り込み確認', guestCount: 2, startsAt: '2026-10-15T19:00:00+09:00' };
    expect((await request(path, { ...body, guestCount: 0 })).status).toBe(400);
    const first = await request(path, body);
    expect(first.status).toBe(201);
    const id = (await first.json() as any).data.id;
    expect(testDb.raw.prepare('SELECT ends_at FROM rt_reservations WHERE id = ?').get(id)).toEqual({ ends_at: '2026-10-15T12:00:00.000Z' });
    const repeated = await request(path, body);
    expect((await repeated.json() as any).data).toMatchObject({ id, duplicate: true });
    expect(testDb.raw.prepare("SELECT COUNT(*) AS n FROM rt_reservations WHERE inbound_email_id = 'email-1'").get()).toEqual({ n: 1 });
    expect(testDb.raw.prepare("SELECT reserved_count FROM rt_inventory_slots WHERE id = 'slot'").get()).toEqual({ reserved_count: 2 });
    expect(testDb.raw.prepare("SELECT status FROM rt_inbound_emails WHERE id = 'email-1'").get()).toEqual({ status: 'received' });
    expect((await request('/api/restaurant-test/inbound-emails/email-2/manual-import?account_id=account-1', body)).status).toBe(409);
  });
  it('予約が埋まっていてもメールを失わず未割当の予約として取り込む', async () => {
    seedEmails();
    const response = await request('/api/restaurant-test/inbound-emails/email-1/manual-import?account_id=account-1', { customerName: '満席確認', guestCount: 10, startsAt: '2026-10-15T10:00:00Z', endsAt: '2026-10-15T12:00:00Z' });
    expect(response.status).toBe(201);
    expect((await response.json() as any).data.tableId).toBeNull();
  });
  it('選択中の店舗以外のメールと経路を見せず、取り込ませない', async () => {
    seedEmails();
    const token = await createAdminSession();
    await requestAs('/api/restaurant-test/stores/store-ginza/select?account_id=account-1', token, {});
    expect((await requestAs('/api/restaurant-test/channels?account_id=account-1&storeId=store-yokohama', token)).status).toBe(400);
    expect((await requestAs('/api/restaurant-test/inbound-emails?account_id=account-1&storeId=store-yokohama', token)).status).toBe(400);
    expect((await requestAs('/api/restaurant-test/inbound-emails/email-other/manual-import?account_id=account-1', token, {})).status).toBe(404);
  });
});

describe('V8 枠の自動生成と全枠の競合', () => {
  const hours = Array.from({length:7}, (_,weekday)=>({weekday,periods:[{opensAt:'17:00',closesAt:'19:00'}]}));
  const alloc={otaCapacity:1,lineCapacity:1,walkInCapacity:1};
  it('店舗時間の営業時間から30分枠を作り、再送で既存枠を上書きしない', async () => {
    seedRestaurantFixture();
    await requestWithMethod('/api/restaurant-test/opening-hours?account_id=account-1','PUT',{storeId:'store-ginza',hours,expectedVersion:0});
    const body={storeId:'store-ginza',date:'2099-10-10',expectedHoursVersion:1,...alloc};
    const res=await request('/api/restaurant-test/inventory/generate?account_id=account-1',body);
    expect(res.status).toBe(200);
    expect((await res.json() as any).data.generated).toBe(4);
    const rows=testDb.raw.prepare('SELECT starts_at FROM rt_inventory_slots ORDER BY starts_at').all();
    expect(rows[0]).toEqual({starts_at:'2099-10-10T08:00:00.000Z'});
    expect((await (await request('/api/restaurant-test/inventory/generate?account_id=account-1',body)).json() as any).data.generated).toBe(0);
    expect((await request('/api/restaurant-test/inventory/generate?account_id=account-1',{...body,expectedHoursVersion:0})).status).toBe(409);
  });
  it('全枠のどれか一つが古いと一件も変更せず、正しい版なら全部更新する', async () => {
    seedRestaurantFixture();
    for(const id of ['s1','s2']) testDb.raw.prepare(`INSERT INTO rt_inventory_slots(id,store_id,starts_at,total_capacity) VALUES(?,'store-ginza',?,4)`).run(id, id==='s1'?'2099-10-10T08:00:00Z':'2099-10-10T08:30:00Z');
    const url='/api/restaurant-test/inventory/allocation?account_id=account-1';
    expect((await requestWithMethod(url,'PUT',{storeId:'store-ginza',slots:[{id:'s1',expectedVersion:1},{id:'s2',expectedVersion:0}],...alloc})).status).toBe(400);
    testDb.raw.exec("UPDATE rt_inventory_slots SET version=2 WHERE id='s2'");
    expect((await requestWithMethod(url,'PUT',{storeId:'store-ginza',slots:[{id:'s1',expectedVersion:1},{id:'s2',expectedVersion:1}],...alloc})).status).toBe(409);
    expect(testDb.raw.prepare("SELECT ota_capacity FROM rt_inventory_slots WHERE id='s1'").get()).toEqual({ota_capacity:0});
    expect((await requestWithMethod(url,'PUT',{storeId:'store-ginza',slots:[{id:'s1',expectedVersion:1},{id:'s2',expectedVersion:2}],...alloc})).status).toBe(200);
    expect(testDb.raw.prepare('SELECT version FROM rt_inventory_slots ORDER BY id').all()).toEqual([{version:2},{version:3}]);
  });
  it('人数ではなく卓の占有席数で空きを返し、枠をまたぐ予約も集計する', async () => {
    seedRestaurantFixture();
    testDb.raw.exec(`INSERT INTO rt_inventory_slots(id,store_id,starts_at,total_capacity) VALUES('slot','store-ginza','2099-10-10T08:30:00Z',4);
      INSERT INTO rt_reservations(id,store_id,source,customer_name,guest_count,starts_at,ends_at,table_id) VALUES('occupy','store-ginza','phone','試験',2,'2099-10-10T08:00:00Z','2099-10-10T10:00:00Z','table-ginza');`);
    const res=await request('/api/restaurant-test/inventory/day?account_id=account-1&storeId=store-ginza&date=2099-10-10');
    expect(res.status).toBe(200);
    const slot=(await res.json() as any).data[0];
    expect(slot).toMatchObject({reserved_count:2,occupied_seats:4,occupiedTableIds:['table-ginza'],freeSeats:0});
  });
  it('夜をまたぐ営業時間も30分枠を作る', async () => {
    seedRestaurantFixture();
    const weekday=new Date('2099-10-10').getUTCDay();
    await requestWithMethod('/api/restaurant-test/opening-hours?account_id=account-1','PUT',{storeId:'store-ginza',hours:Array.from({length:7},(_,w)=>({weekday:w,periods:w===weekday?[{opensAt:'23:00',closesAt:'01:00'}]:[]})),expectedVersion:0});
    const res=await request('/api/restaurant-test/inventory/generate?account_id=account-1',{storeId:'store-ginza',date:'2099-10-10',expectedHoursVersion:1,...alloc});
    expect((await res.json() as any).data.generated).toBe(4);
  });
});

describe('V8 新価格の開始日時',()=>{
 it('保存時に確定しても未来の開始日時までは現行価格を保つ',async()=>{
  seedRestaurantFixture();
  const res=await requestWithMethod('/api/restaurant-test/menu/menu-ginza?account_id=account-1','PATCH',{price:9900,effectiveAt:'2099-10-10T00:00:00Z'});
  const change=(await res.json() as any).data;
  expect(change.pendingPrice).toBe(9900);
  expect(testDb.raw.prepare("SELECT price FROM rt_menu_items WHERE id='menu-ginza'").get()).toEqual({price:8800});
  const snap=await request('/api/restaurant-test/snapshot?account_id=account-1');
  expect((await snap.json() as any).data.menuItems[0]).toMatchObject({pendingPrice:9900,priceChangeStatus:'approved'});
  testDb.raw.prepare("UPDATE rt_menu_change_requests SET effective_at='2000-01-01T00:00:00Z' WHERE id=?").run(change.requestId);
  await request('/api/restaurant-test/snapshot?account_id=account-1');
  expect(testDb.raw.prepare("SELECT price FROM rt_menu_items WHERE id='menu-ginza'").get()).toEqual({price:9900});
  await request('/api/restaurant-test/snapshot?account_id=account-1');
  expect(testDb.raw.prepare('SELECT status FROM rt_menu_change_requests WHERE id=?').get(change.requestId)).toEqual({status:'applied'});
 });
 it('確定済みの開始待ち価格は新しい保存で置き換える',async()=>{
  seedRestaurantFixture();
  const path='/api/restaurant-test/menu/menu-ginza?account_id=account-1';
  const first=await requestWithMethod(path,'PATCH',{price:9900,effectiveAt:'2099-10-10T00:00:00Z'});
  expect(first.status).toBe(200);
  const firstId=(await first.json() as any).data.requestId;
  const second=await requestWithMethod(path,'PATCH',{price:9500,effectiveAt:'2099-11-10T00:00:00Z'});
  expect(second.status).toBe(200);
  expect(testDb.raw.prepare('SELECT status,return_reason FROM rt_menu_change_requests WHERE id=?').get(firstId)).toEqual({status:'returned',return_reason:'新しい価格変更で置き換え'});
  expect(testDb.raw.prepare('SELECT after_price,status FROM rt_menu_change_requests WHERE status=?').get('approved')).toEqual({after_price:9500,status:'approved'});
  expect(testDb.raw.prepare("SELECT price FROM rt_menu_items WHERE id='menu-ginza'").get()).toEqual({price:8800});
 });
 it('価格の開始日時の入力不正では申請を作らない',async()=>{
  seedRestaurantFixture();
  expect((await requestWithMethod('/api/restaurant-test/menu/menu-ginza?account_id=account-1','PATCH',{price:9900,effectiveAt:'bad'})).status).toBe(400);
  expect(testDb.raw.prepare('SELECT COUNT(*) AS total FROM rt_menu_change_requests').get()).toEqual({total:0});
 });
});

describe('V8 店の名簿とログイン権限',()=>{
 function seedLogin(role='staff') {
  seedRestaurantFixture();
  testDb.raw.prepare(`INSERT INTO staff_members(id,name,role,api_key,account_scope,tenant_id) VALUES('login','試験',?,'login-key','accounts','00000000-0000-4000-8000-000000000001')`).run(role);
  testDb.raw.exec("INSERT INTO staff_account_scopes(staff_id,line_account_id,created_at) VALUES('login','account-2',datetime('now')); INSERT INTO rt_memberships(id,organization_id,store_id,staff_name,role) VALUES('member','org-fixture','store-ginza','試験','staff')");
 }
 it('同統括のログインメンバーとつなぎ、実際の役割と版を返す',async()=>{
  seedLogin('admin');
  expect((await requestWithMethod('/api/restaurant-test/memberships/member/login?account_id=account-1','PUT',{staffId:'login'})).status).toBe(200);
  const res=await request('/api/restaurant-test/snapshot?account_id=account-1');
  expect((await res.json() as any).data.memberships[0]).toMatchObject({staff_id:'login',role:'store_manager',loginRole:'admin',loginPolicyVersion:1});
  const list=await request('/api/restaurant-test/login-members?account_id=account-1');
  const text=await list.text(); expect(text).not.toContain('login-key'); expect(text).not.toContain('api_key');
 });
 it('連携後の役割変更は再認証なしで書き込まない',async()=>{
  seedLogin();
  await requestWithMethod('/api/restaurant-test/memberships/member/login?account_id=account-1','PUT',{staffId:'login'});
  const res=await requestWithMethod('/api/restaurant-test/memberships/member?account_id=account-1','PATCH',{role:'store_manager',expectedPolicyVersion:1});
  expect(res.status).toBe(428);
  expect(testDb.raw.prepare("SELECT role FROM staff_members WHERE id='login'").get()).toEqual({role:'staff'});
  expect(testDb.raw.prepare("SELECT role FROM rt_memberships WHERE id='member'").get()).toEqual({role:'staff'});
 });
 it('既存の本人確認を通ると役割を反映し、外側のログイン停止も名簿へ同期する',async()=>{
  seedLogin();
  await requestWithMethod('/api/restaurant-test/memberships/member/login?account_id=account-1','PUT',{staffId:'login'});
  testDb.raw.prepare(`INSERT INTO staff_members(id,name,role,api_key,account_scope,tenant_id)
    VALUES('owner-session','Owner','owner','owner-session-key','all','00000000-0000-4000-8000-000000000001')`).run();
  const token='verified-booking-session'; await createAdminSession(token);
  testDb.raw.prepare('UPDATE admin_sessions SET step_up_at=? WHERE token_hash=?').run(new Date().toISOString(),await sha256Hex(token));
  const res=await requestWithMethod('/api/restaurant-test/memberships/member?account_id=account-1','PATCH',{role:'store_manager',expectedPolicyVersion:1},`${ADMIN_SESSION_PREFIX}${token}`);
  expect(res.status).toBe(200);
  expect(testDb.raw.prepare("SELECT role FROM staff_members WHERE id='login'").get()).toEqual({role:'admin'});
  testDb.raw.exec("UPDATE staff_members SET is_active=0 WHERE id='login'");
  expect(testDb.raw.prepare("SELECT status FROM rt_memberships WHERE id='member'").get()).toEqual({status:'suspended'});
 });
 it('最後のログイン管理者を名簿から停止させない',async()=>{
  seedLogin('admin');
  await requestWithMethod('/api/restaurant-test/memberships/member/login?account_id=account-1','PUT',{staffId:'login'});
  const res=await requestWithMethod('/api/restaurant-test/memberships/member?account_id=account-1','PATCH',{status:'suspended',expectedPolicyVersion:1});
  expect(res.status).toBe(400);
  expect(testDb.raw.prepare("SELECT is_active FROM staff_members WHERE id='login'").get()).toEqual({is_active:1});
 });
 it('別統括のログインメンバーを連携できず、スタッフは連携を変更できない',async()=>{
  seedLogin();
  testDb.raw.exec("INSERT INTO tenants(id,name) VALUES('other-tenant','別'); UPDATE staff_members SET tenant_id='other-tenant' WHERE id='login'");
  expect((await requestWithMethod('/api/restaurant-test/memberships/member/login?account_id=account-1','PUT',{staffId:'login'})).status).toBe(404);
  authMocks.getStaffByApiKey.mockResolvedValue({id:'operator',name:'担当者',role:'staff',access_level:'full',permission_keys:'[]',assigned_line_account_id:null,can_access_descendant_accounts:0});
  expect((await requestWithMethod('/api/restaurant-test/memberships/member/login?account_id=account-1','PUT',{staffId:'login'},'operator-key')).status).toBe(403);
 });
 it('担当者は予約入力と日付読取ができ、設定変更はできない',async()=>{
  seedLogin();
  testDb.raw.prepare("INSERT INTO rt_opening_hours_settings (store_id, hours_json, updated_by) VALUES ('store-ginza', '[]', 'test')").run();
  authMocks.getStaffByApiKey.mockResolvedValue({id:'login',name:'担当者',role:'staff',access_level:'full',permission_keys:'[]',assigned_line_account_id:null,can_access_descendant_accounts:0});
  expect((await requestAs('/api/restaurant-test/reservations/holds?account_id=account-2','operator-key',{storeId:'store-ginza',startsAt:'2099-10-10T10:00:00Z',endsAt:'2099-10-10T12:00:00Z',guestCount:2,holdMinutes:15})).status).toBe(201);
  expect((await requestAs('/api/restaurant-test/reservations/day?account_id=account-2&storeId=store-ginza&date=2099-10-10','operator-key')).status).toBe(200);
  expect((await requestAs('/api/restaurant-test/reservations/day?account_id=account-2&storeId=store-yokohama&date=2099-10-10','operator-key')).status).toBe(400);
  expect((await requestWithMethod('/api/restaurant-test/opening-hours?account_id=account-2','PUT',{},'operator-key')).status).toBe(403);
 });
});

describe('V8 フロア配置と結合グループ',()=>{
 it('空のエリアだけ履歴を残して削除し、同じ名前を作り直せる',async()=>{
  seedRestaurantFixture();
  const path='/api/restaurant-test/floors?account_id=account-1';
  const created=await request(path,{storeId:'store-ginza',name:'テラス',kind:'area',parentFloorId:'floor-store-ginza'});
  expect(created.status).toBe(201);const id=(await created.json() as any).data.id;
  expect((await requestWithMethod(`/api/restaurant-test/floors/${id}?account_id=account-1`,'DELETE',{storeId:'store-ginza',expectedVersion:1})).status).toBe(200);
  const archived=testDb.raw.prepare('SELECT name,archived_name,archived_at FROM rt_floors WHERE id=?').get(id) as {name:string;archived_name:string;archived_at:string};
  expect(archived.name).toBe('__archived__'+id);expect(archived.archived_name).toBe('テラス');expect(archived.archived_at).toBeTruthy();
  const floors=await request('/api/restaurant-test/floors?account_id=account-1&storeId=store-ginza');
  expect((await floors.json() as any).data.some((f:any)=>f.id===id)).toBe(false);
  expect((await request(path,{storeId:'store-ginza',name:'テラス',kind:'area',parentFloorId:'floor-store-ginza'})).status).toBe(201);
 });
 it('卓・子エリア・最後の階が残る場合は削除を拒否する',async()=>{
  seedRestaurantFixture();
  const path='/api/restaurant-test/floors?account_id=account-1';
  const area=await request(path,{storeId:'store-ginza',name:'テラス',kind:'area',parentFloorId:'floor-store-ginza'});
  const areaId=(await area.json() as any).data.id;
  const del=(id:string,version=1)=>requestWithMethod(`/api/restaurant-test/floors/${id}?account_id=account-1`,'DELETE',{storeId:'store-ginza',expectedVersion:version});
  expect((await del('floor-store-ginza')).status).toBe(409);
  const table=await request('/api/restaurant-test/tables?account_id=account-1',{storeId:'store-ginza',floorId:areaId,code:'T-AREA',label:'テラス卓',seatType:'table',minCapacity:1,maxCapacity:2});
  expect(table.status).toBe(201);
  expect((await del(areaId,2)).status).toBe(409);
  expect((await del(areaId,1)).status).toBe(409);
  expect(testDb.raw.prepare('SELECT archived_at FROM rt_floors WHERE id=?').get(areaId)).toEqual({archived_at:null});
 });
 it('Penの階・エリアと卓の席条件を保存し、座席図へ返す',async()=>{
  seedRestaurantFixture();
  const area=await request('/api/restaurant-test/floors?account_id=account-1',{storeId:'store-ginza',name:'テラス',kind:'area',parentFloorId:'floor-store-ginza'});
  expect(area.status).toBe(201);const areaId=(await area.json() as any).data.id;
  const created=await request('/api/restaurant-test/tables?account_id=account-1',{storeId:'store-ginza',floorId:areaId,code:'T-PEN',label:'テラス1',seatType:'table',seatDetailType:'zashiki',minCapacity:1,maxCapacity:5,shape:'long',width:120,height:64,smokingPolicy:'non_smoking',partition:'semi_private',shoesAllowed:false,visibleOnMap:true,chairArrangement:'both',chairSide:null,isActive:false});
  expect(created.status).toBe(201);const id=(await created.json() as any).data.id;
  expect(testDb.raw.prepare('SELECT seat_detail_type,shape,width,height,smoking_policy,partition_type,shoes_allowed,is_active FROM rt_tables WHERE id=?').get(id)).toEqual({seat_detail_type:'zashiki',shape:'long',width:120,height:64,smoking_policy:'non_smoking',partition_type:'semi_private',shoes_allowed:0,is_active:0});
  const floors=await request('/api/restaurant-test/floors?account_id=account-1&storeId=store-ginza');
  const returned=(await floors.json() as any).data.find((f:any)=>f.id===areaId);
  expect(returned).toMatchObject({kind:'area',parentFloorId:'floor-store-ginza',tables:[expect.objectContaining({id,seatDetailType:'zashiki',maxCapacity:5,shoesAllowed:false})]});
 });
 it('座標を省略した卓追加は空き位置に置き、重なり・店の外への変更を保存しない',async()=>{
  seedRestaurantFixture();
  const url='/api/restaurant-test/tables?account_id=account-1';
  const input={storeId:'store-ginza',code:'T2',label:'新しい卓',seatType:'table',minCapacity:1,maxCapacity:2};
  const added=await request(url,input);expect(added.status).toBe(201);
  const id=(await added.json() as any).data.id;
  const placed=testDb.raw.prepare('SELECT floor_x,floor_y FROM rt_tables WHERE id=?').get(id);
  const original=testDb.raw.prepare("SELECT width FROM rt_tables WHERE id='table-ginza'").get() as {width:number};
  expect((placed as {floor_x:number}).floor_x).toBeGreaterThanOrEqual(original.width);
  expect(placed).toMatchObject({floor_y:20});
  const version=testDb.raw.prepare("SELECT version FROM rt_floors WHERE id='floor-store-ginza'").get();
  expect(version).toEqual({version:2});
  expect((await request(url,{...input,code:'T3',floorX:0,floorY:0})).status).toBe(400);
  for(const floorX of [0,10000])expect((await requestWithMethod(`/api/restaurant-test/tables/${id}?account_id=account-1`,'PATCH',{floorX,floorY:0})).status).toBe(400);
  expect((await requestWithMethod('/api/restaurant-test/tables/layout?account_id=account-1','PUT',{storeId:'store-ginza',tables:[{id,floorX:0,floorY:0,joinGroup:null}]})).status).toBe(400);
  expect(testDb.raw.prepare('SELECT floor_x,floor_y FROM rt_tables WHERE id=?').get(id)).toEqual(placed);
  expect(testDb.raw.prepare("SELECT version FROM rt_floors WHERE id='floor-store-ginza'").get()).toEqual(version);
  expect(testDb.raw.prepare("SELECT count(*) n FROM rt_tables WHERE store_id='store-ginza'").get()).toEqual({n:2});
 });

 it('追加と変更で座標・結合を保存し、再取得しても同じ配置を返す',async()=>{
  seedRestaurantFixture();
  const added=await request('/api/restaurant-test/tables?account_id=account-1',{storeId:'store-ginza',code:'T2',label:'試験卓',seatType:'table',minCapacity:1,maxCapacity:2,floorX:200,floorY:100,joinGroup:' A '});
  expect(added.status).toBe(201);const id=(await added.json() as any).data.id;
  const updated=await requestWithMethod(`/api/restaurant-test/tables/${id}?account_id=account-1`,'PATCH',{floorX:0,floorY:120,joinGroup:'B'});
  expect(updated.status).toBe(200);
  const snapshot=await request('/api/restaurant-test/snapshot?account_id=account-1');
  expect((await snapshot.json() as any).data.tables.find((t:any)=>t.id===id)).toMatchObject({floor_x:0,floor_y:120,join_group:'B'});
  await requestWithMethod(`/api/restaurant-test/tables/${id}?account_id=account-1`,'PATCH',{joinGroup:null});
  expect(testDb.raw.prepare('SELECT join_group FROM rt_tables WHERE id=?').get(id)).toEqual({join_group:null});
 });
 it('一括の配置に別店舗の卓が混ざると一件も更新しない',async()=>{
  seedRestaurantFixture();testDb.raw.exec("INSERT INTO rt_tables(id,store_id,code,label,seat_type,min_capacity,max_capacity) VALUES('other-table','store-yokohama','T2','試験','table',1,2)");
  const url='/api/restaurant-test/tables/layout?account_id=account-1';
  const table={id:'table-ginza',floorX:2,floorY:1,joinGroup:'A'};
  expect((await requestWithMethod(url,'PUT',{storeId:'store-ginza',tables:[table,{...table,id:'other-table'}]})).status).toBe(404);
  expect(testDb.raw.prepare("SELECT floor_x,join_group FROM rt_tables WHERE id='table-ginza'").get()).toEqual({floor_x:0,join_group:null});
  expect((await requestWithMethod(url,'PUT',{storeId:'store-ginza',tables:[table]})).status).toBe(200);
  expect(testDb.raw.prepare("SELECT floor_x,floor_y,join_group FROM rt_tables WHERE id='table-ginza'").get()).toEqual({floor_x:2,floor_y:1,join_group:'A'});
 });
 it('不正な座標・重複・スタッフによる配置変更を拒む',async()=>{
  seedRestaurantFixture();
  for(const floorX of [-1,10001,0.5,null]) expect((await requestWithMethod('/api/restaurant-test/tables/table-ginza?account_id=account-1','PATCH',{floorX})).status).toBe(400);
  const table={id:'table-ginza',floorX:0,floorY:0,joinGroup:null};
  expect((await requestWithMethod('/api/restaurant-test/tables/layout?account_id=account-1','PUT',{storeId:'store-ginza',tables:[table,table]})).status).toBe(400);
  authMocks.getStaffByApiKey.mockResolvedValue({id:'operator',name:'担当者',role:'staff',access_level:'full',permission_keys:'[]',assigned_line_account_id:null,can_access_descendant_accounts:0});
  expect((await requestWithMethod('/api/restaurant-test/tables/layout?account_id=account-1','PUT',{storeId:'store-ginza',tables:[table]},'operator-key')).status).toBe(403);
 });
});

describe('枠の自動調整ルールと媒体閉鎖通知のAPI',()=>{
 const input={storeId:'store-ginza',threshold:2,stopLine:true,stopSameDay:true,notify:true,expectedVersion:0};
 it('自動停止中の手変更は409で拒否し、LINE・当日受付の元値と店頭枠を保つ',async()=>{
  seedRestaurantFixture();
  testDb.raw.exec("INSERT INTO rt_inventory_slots(id,store_id,starts_at,total_capacity,line_capacity,same_day_capacity,walk_in_capacity) VALUES('stopped','store-ginza','2027-01-01T10:00:00Z',4,2,1,1)");
  expect((await requestWithMethod('/api/restaurant-test/inventory-rules?account_id=account-1','PUT',{...input,threshold:4,notify:false})).status).toBe(200);
  const version=(testDb.raw.prepare("SELECT version FROM rt_inventory_slots WHERE id='stopped'").get() as {version:number}).version;
  expect((await requestWithMethod('/api/restaurant-test/inventory/stopped?account_id=account-1','PUT',{otaCapacity:0,lineCapacity:1,walkInCapacity:1,sameDayCapacity:1,expectedVersion:version})).status).toBe(409);
  expect(testDb.raw.prepare("SELECT line_capacity,same_day_capacity,walk_in_capacity,auto_line_original,auto_same_day_original FROM rt_inventory_slots WHERE id='stopped'").get()).toEqual({line_capacity:0,same_day_capacity:0,walk_in_capacity:1,auto_line_original:2,auto_same_day_original:1});
  expect((await requestWithMethod('/api/restaurant-test/inventory-rules?account_id=account-1','PUT',{...input,stopLine:false,stopSameDay:false,notify:false,expectedVersion:1})).status).toBe(200);
  expect(testDb.raw.prepare("SELECT line_capacity,same_day_capacity,walk_in_capacity FROM rt_inventory_slots WHERE id='stopped'").get()).toEqual({line_capacity:2,same_day_capacity:1,walk_in_capacity:1});
 });
 it('指定日の停止・復元は店舗の時間帯で読み、顧客・予約の識別子を返さない',async()=>{
  seedRestaurantFixture();
  testDb.raw.exec(`INSERT INTO rt_inventory_rule_log(store_id,slot_id,starts_at,before_line,after_line,before_same_day,after_same_day,cause) VALUES
   ('store-ginza','night','2026-11-01T15:00:00Z',0,2,0,1,'rt_reservations:update:private-reservation'),
   ('store-ginza','boundary','2026-11-02T15:00:00Z',0,2,0,1,'rules_saved'),
   ('store-yokohama','other','2026-11-01T15:00:00Z',0,2,0,1,'rules_saved');`);
  const path='/api/restaurant-test/inventory-rules?account_id=account-1&storeId=store-ginza';
  const body=await (await request(path+'&date=2026-11-02')).json();
  expect(body).toMatchObject({success:true,data:{stopLine:false,stopSameDay:false,version:0},state:{historyTotal:1,history:[{startsAt:'2026-11-01T15:00:00Z',cause:'reservation',beforeLine:0,afterLine:2}]}});
  expect(JSON.stringify(body)).not.toContain('private-reservation');
  expect((await request(path+'&date=2026-02-30')).status).toBe(400);
  expect((await request(path.replace('store-ginza','outside')+'&date=2026-11-02')).status).toBe(404);
  expect(await (await request(path)).json()).not.toHaveProperty('state');
 });
 it('閲覧のみでも状態を読めるが、有効化・しきい値保存は拒否する',async()=>{
  seedRestaurantFixture();
  authMocks.getStaffByApiKey.mockResolvedValue({id:'readonly',name:'閲覧担当',role:'admin',access_level:'read_only',permission_keys:'[]',assigned_line_account_id:null,can_access_descendant_accounts:0});
  expect((await requestWithMethod('/api/restaurant-test/inventory-rules?account_id=account-1&storeId=store-ginza&date=2026-11-01','GET',undefined,'readonly-key')).status).toBe(200);
  expect((await requestWithMethod('/api/restaurant-test/inventory-rules?account_id=account-1','PUT',input,'readonly-key')).status).toBe(403);
  expect(testDb.raw.prepare('SELECT COUNT(*) n FROM rt_inventory_rules').get()).toEqual({n:0});
 });
 it('担当者は閲覧と媒体閉鎖の報告ができるが、在庫画面の権限があってもルールを保存できない',async()=>{
  seedRestaurantFixture();
  testDb.raw.exec(`INSERT INTO rt_inventory_slots(id,store_id,starts_at,total_capacity) VALUES('rules-slot','store-ginza','2027-01-01T10:00:00Z',4);
   INSERT INTO rt_channel_close_tasks(id,store_id,slot_id,channel,status,reason,remaining_seats) VALUES('rules-task','store-ginza','rules-slot','hotpepper','close','full',0);`);
  const staff={id:'operator',name:'担当者',role:'staff' as const,access_level:'full' as const,permission_keys:'[]',assigned_line_account_id:null,can_access_descendant_accounts:0};
  authMocks.getStaffByApiKey.mockResolvedValue(staff);
  for(const path of ['inventory-rules','channel-close-tasks']) {
   expect((await requestWithMethod(`/api/restaurant-test/${path}?account_id=account-1&storeId=store-ginza`,'GET',undefined,'operator-key')).status).toBe(200);
  }
  expect((await requestWithMethod('/api/restaurant-test/channel-close-tasks/rules-task/done?account_id=account-1','POST',{},'operator-key')).status).toBe(200);
  expect(testDb.raw.prepare("SELECT status FROM rt_channel_close_tasks WHERE id='rules-task'").get()).toEqual({status:'done'});
  authMocks.getStaffByApiKey.mockResolvedValue({...staff,permission_keys:'["/restaurant-test/inventory"]'});
  expect((await requestWithMethod('/api/restaurant-test/inventory-rules?account_id=account-1','PUT',input,'operator-key')).status).toBe(403);
  expect(testDb.raw.prepare("SELECT COUNT(*) AS total FROM rt_inventory_rules").get()).toEqual({total:0});
 });
 it('保存・読み直し・古い版409を返す',async()=>{
  seedRestaurantFixture();
  const path='/api/restaurant-test/inventory-rules?account_id=account-1';
  expect((await requestWithMethod(path,'PUT',input)).status).toBe(200);
  const read=await request(path+'&storeId=store-ginza');
  expect(await read.json()).toMatchObject({success:true,data:{storeId:'store-ginza',threshold:2,version:1}});
  expect((await requestWithMethod(path,'PUT',input)).status).toBe(409);
 });
 it('別の組織の店舗・不正なしきい値を拒否する',async()=>{
  seedRestaurantFixture();
  expect((await requestWithMethod('/api/restaurant-test/inventory-rules?account_id=account-1','PUT',{...input,storeId:'outside'})).status).toBe(404);
  expect((await requestWithMethod('/api/restaurant-test/inventory-rules?account_id=account-1','PUT',{...input,threshold:-1})).status).toBe(400);
 });
 it('媒体×枠の一覧と済みを返し、席が戻ったタスクの済みは409',async()=>{
  seedRestaurantFixture();
  testDb.raw.exec(`INSERT INTO rt_inventory_slots(id,store_id,starts_at,total_capacity) VALUES('rules-slot','store-ginza','2027-01-01T10:00:00Z',4);
   INSERT INTO rt_channel_close_tasks(id,store_id,slot_id,channel,status,reason,remaining_seats) VALUES('rules-task','store-ginza','rules-slot','hotpepper','close','full',0);`);
  const list=await request('/api/restaurant-test/channel-close-tasks?account_id=account-1&storeId=store-ginza');
  expect(await list.json()).toMatchObject({success:true,data:[{id:'rules-task',channel:'hotpepper',remainingSeats:0,status:'close'}]});
  const done='/api/restaurant-test/channel-close-tasks/rules-task/done?account_id=account-1';
  expect((await requestWithMethod(done,'POST',{})).status).toBe(200);
  testDb.raw.exec("UPDATE rt_channel_close_tasks SET status='reopen' WHERE id='rules-task'");
  expect((await requestWithMethod(done,'POST',{})).status).toBe(409);
 });
});


describe('提案E 来店記録', () => {
  it('来店の印と取消が履歴に反映され、過去の案内済みも数える', async () => {
    seedRestaurantFixture();
    testDb.raw.exec("UPDATE rt_reservations SET customer_phone='09000000000' WHERE id='reservation-ginza'");
    const version=(testDb.raw.prepare("SELECT customer_version FROM rt_reservations WHERE id='reservation-ginza'").get() as {customer_version:number}).customer_version;
    const path='/api/restaurant-test/reservations/reservation-ginza/visit?account_id=account-1';
    expect((await request(path,{kind:'visited',expectedVersion:version,requestId:'visit'})).status).toBe(200);
    expect((await request(path,{kind:'visited',expectedVersion:version,requestId:'new-visit'})).status).toBe(409);
    const history=()=>request('/api/restaurant-test/customers/history?account_id=account-1&storeId=store-ginza&phone=09000000000');
    expect((await (await history()).json() as any).data.visitCount).toBe(1);
    expect((await requestWithMethod(path+`&expectedVersion=${version+1}&requestId=undo`,'DELETE')).status).toBe(200);
    expect((await (await history()).json() as any).data.visitCount).toBe(0);
    expect(testDb.raw.prepare('SELECT undone_at FROM rt_seat_visit_marks').get()).toMatchObject({undone_at:expect.any(String)});
    testDb.raw.exec("UPDATE rt_reservations SET status='seated' WHERE id='reservation-ginza'");
    expect((await (await history()).json() as any).data.visitCount).toBe(1);
  });
  it('予約なしの来店は名前なしで記録でき、同じ卓の重なり・人数違い・他店を拒否する', async () => {
    seedRestaurantFixture();
    const path='/api/restaurant-test/reservations/walk-in?account_id=account-1';
    const body={storeId:'store-ginza',tableId:'table-ginza',guestCount:2};
    expect((await request(path,{...body,guestCount:5})).status).toBe(400);
    expect((await request(path,{...body,storeId:'store-yokohama'})).status).toBe(400);
    const res=await request(path,body);expect(res.status).toBe(201);
    const data=(await res.json() as any).data;
    expect(data).toMatchObject({status:'visited',source:'walk_in',tableId:'table-ginza'});
    expect(Math.abs(Date.now()-Date.parse(data.startsAt))).toBeLessThan(10000);
    expect((await request(path,body)).status).toBe(409);
  });
});


describe('提案E 媒体リンク',()=>{
  it('HTTPSだけ保存し、店舗ごとに読み直し、版の競合を拒む',async()=>{
    seedRestaurantFixture();testDb.raw.exec("INSERT INTO rt_media(id,code,name,parser_key) VALUES('hp','hotpepper','媒体','hp')");const path='/api/restaurant-test/media-links/hotpepper?account_id=account-1';
    const input={storeId:'store-ginza',pageUrl:'https://example.com/shop',loginUrl:'https://example.com/login',closeOnBooking:true,expectedVersion:0};
    expect((await requestWithMethod(path,'PUT',{...input,pageUrl:'http://example.com'})).status).toBe(400);
    expect((await requestWithMethod(path,'PUT',input)).status).toBe(200);
    expect((await requestWithMethod(path,'PUT',input)).status).toBe(409);
    expect((await requestWithMethod(path,'PUT',{...input,expectedVersion:1})).status).toBe(200);
    const data=(await (await request('/api/restaurant-test/media-links?account_id=account-1&storeId=store-ginza')).json() as any).data;
    expect(data.find((x:any)=>x.code==='hotpepper')).toMatchObject({pageUrl:input.pageUrl,version:2,closeOnBooking:1});
  });
  it('予約を受けないグルメ媒体を追加でき、閉じる対象にはできない',async()=>{
    seedRestaurantFixture();
    expect((await request('/api/restaurant-test/media?account_id=account-1',{code:'gourmet_review',name:'口コミサイト'})).status).toBe(201);
    expect((await requestWithMethod('/api/restaurant-test/media-links/gourmet_review?account_id=account-1','PUT',{storeId:'store-ginza',pageUrl:null,loginUrl:null,closeOnBooking:true,expectedVersion:0})).status).toBe(400);
  });
  it('貼り付けURLは再発行でも同じで、お客さま向け予約を利用可能として返す',async()=>{
    seedRestaurantFixture();env.LIFF_URL='https://liff.line.me/wrong-global';testDb.raw.exec("INSERT INTO line_accounts(id,name,channel_id,channel_secret,channel_access_token,liff_id) VALUES('account-1','統括','hq','','','hq-liff'),('account-2','店','shop','','','shop-liff')");const path='/api/restaurant-test/reservation-link?account_id=account-1';
    const a=(await (await request(path,{storeId:'store-ginza'})).json() as any).data;
    const b=(await (await request(path,{storeId:'store-ginza'})).json() as any).data;
    expect(a).toEqual(b);expect(a.available).toBe(true);expect(a.url).toMatch(/^https:\/\/liff\.line\.me\/shop-liff\?page=restaurant&token=[a-z0-9-]+$/);expect(a.html).toContain('noopener');
  });
});

it('店のLIFF ID未設定と停止アカウントにはリンクを発行しない',async()=>{
  seedRestaurantFixture();const path='/api/restaurant-test/reservation-link?account_id=account-1';
  expect((await request(path,{storeId:'store-ginza'})).status).toBe(503);
  expect(testDb.raw.prepare('SELECT COUNT(*) n FROM rt_reservation_links').get()).toEqual({n:0});
  testDb.raw.exec("INSERT INTO line_accounts(id,name,channel_id,channel_secret,channel_access_token,liff_id,is_active) VALUES('account-2','店','shop','','','shop-liff',0)");
  expect((await request(path,{storeId:'store-ginza'})).status).toBe(503);
});
it('店の遅刻案内を版付きで保存・維持・解除し、他店・閲覧のみ・不正入力を拒否する',async()=>{
  seedRestaurantFixture();const path='/api/restaurant-test/opening-hours?account_id=account-1';
  const hours=Array.from({length:7},(_,weekday)=>({weekday,periods:[{opensAt:'12:00',closesAt:'16:00'}]}));
  const policy={cancelAfterMinutes:15,message:'15分を過ぎたら取消になります'};
  expect((await requestWithMethod(path,'PUT',{storeId:'store-ginza',hours,expectedVersion:0,lateArrivalPolicy:policy})).status).toBe(200);
  const readPolicy=async()=> (await (await request(path+'&storeId=store-ginza')).json() as any).data.lateArrivalPolicy;
  expect(await readPolicy()).toEqual(policy);
  expect((await requestWithMethod(path,'PUT',{storeId:'store-ginza',hours,expectedVersion:1})).status).toBe(200);
  expect(await readPolicy()).toEqual(policy);
  expect((await requestWithMethod(path,'PUT',{storeId:'store-ginza',hours,expectedVersion:1,lateArrivalPolicy:null})).status).toBe(409);
  for(const lateArrivalPolicy of [{...policy,cancelAfterMinutes:0},{...policy,cancelAfterMinutes:1.5},{...policy,message:''}]) expect((await requestWithMethod(path,'PUT',{storeId:'store-ginza',hours,expectedVersion:2,lateArrivalPolicy})).status).toBe(400);
  expect((await requestWithMethod(path,'PUT',{storeId:'store-ginza',hours,expectedVersion:2,lateArrivalPolicy:null})).status).toBe(200);
  expect(await readPolicy()).toBeNull();
  authMocks.getStaffByApiKey.mockResolvedValueOnce({id:'viewer',name:'閲覧',role:'admin',access_level:'read_only',permission_keys:'[]',assigned_line_account_id:null,can_access_descendant_accounts:1});
  expect((await requestWithMethod(path,'PUT',{storeId:'store-ginza',hours,expectedVersion:3,lateArrivalPolicy:policy},'viewer-key')).status).toBe(403);
  expect((await requestWithMethod('/api/restaurant-test/opening-hours?account_id=account-2','PUT',{storeId:'store-yokohama',hours,expectedVersion:0,lateArrivalPolicy:policy})).status).toBe(400);
});

describe('飲食1 共通盤と予約の版',()=>{
 it('読んだ版で一度だけ変更でき、古い画面と版なしは予約を上書きしない',async()=>{
  seedRestaurantFixture();const url='/api/restaurant-test/reservations/reservation-ginza?account_id=account-1';
  const initial=testDb.raw.prepare("SELECT customer_version FROM rt_reservations WHERE id='reservation-ginza'").get() as {customer_version:number};
  expect((await requestWithMethod(url,'PATCH',{expectedVersion:initial.customer_version,note:'先に保存'})).status).toBe(200);
  expect((await requestWithMethod(url,'PATCH',{expectedVersion:initial.customer_version,note:'古い画面'})).status).toBe(409);
  const noVersion=await app().request(url,{method:'PATCH',headers:{Authorization:'Bearer owner-key','Content-Type':'application/json'},body:JSON.stringify({note:'版なし'})},env);
  expect(noVersion.status).toBe(400);expect(testDb.raw.prepare("SELECT note FROM rt_reservations WHERE id='reservation-ginza'").get()).toEqual({note:'先に保存'});
 });
 it('共通表示は日時・店舗を絞り、版と旧予約の注意を返す',async()=>{
  seedRestaurantFixture();const row=testDb.raw.prepare("SELECT starts_at,ends_at FROM rt_reservations WHERE id='reservation-ginza'").get() as {starts_at:string;ends_at:string};
  const query=new URLSearchParams({account_id:'account-1',storeId:'store-ginza',from:row.starts_at,to:row.ends_at});
  const result=await request('/api/restaurant-test/board?'+query);expect(result.status).toBe(200);const body=await result.json() as any;
  expect(body.data.entries).toHaveLength(1);expect(body.data.entries[0]).toMatchObject({kind:'seats',id:'reservation-ginza',version:1,scopeId:'store-ginza',resourceIds:['table-ginza'],dining:{courseId:'menu-ginza'}});
  query.set('from','2090-01-01T00:00:00Z');query.set('to','2090-01-02T00:00:00Z');expect((await (await request('/api/restaurant-test/board?'+query)).json() as any).data.total).toBe(0);
  query.set('storeId','wrong');expect((await request('/api/restaurant-test/board?'+query)).status).toBe(404);
 });
 it('図面の保存は閲覧者・別の店舗を拒み、版ずれでは座標を保つ',async()=>{
  seedRestaurantFixture();const floors=await request('/api/restaurant-test/floors?account_id=account-1&storeId=store-ginza');const f=(await floors.json() as any).data[0];
  const body={...f,expectedVersion:f.version,tables:f.tables.map((t:any)=>({...t,x:100,y:100}))};
  const url='/api/restaurant-test/floors/'+f.id+'?account_id=account-1';
  expect((await requestWithMethod(url,'PUT',body)).status).toBe(200);expect((await requestWithMethod(url,'PUT',{...body,tables:body.tables.map((t:any)=>({...t,x:200}))})).status).toBe(409);
  expect(testDb.raw.prepare("SELECT floor_x FROM rt_tables WHERE id='table-ginza'").get()).toEqual({floor_x:100});
  authMocks.getStaffByApiKey.mockResolvedValue({id:'viewer',role:'admin',name:'閲覧',access_level:'read_only',permission_keys:'[]'} as never);
  expect((await requestWithMethod(url,'PUT',body,'reader-key')).status).toBe(403);
  authMocks.getStaffByApiKey.mockResolvedValue(null);
  expect((await requestWithMethod(url,'PUT',{...body,storeId:'wrong'})).status).toBe(404);
 });
});

describe('飲食3・共通フォローのHTTP境界',()=>{
 const path='/api/restaurant-test/followups/store-ginza';
 const scope='?account_id=account-1';
 const version=()=> (testDb.raw.prepare("SELECT template_version FROM rt_store_followup_templates WHERE store_id='store-ginza'").get() as {template_version:number}).template_version;
 it('1つの共通フォローへテキストとカルーセルを保存し、読込・版競合・停止を守る',async()=>{
  seedRestaurantFixture();
  const step='restaurant-followup:store-ginza:reservation_created',url=path+'/steps/'+step+'/messages'+scope;
  const bubbles=[{id:'text',type:'text',content:{text:'{{name}}さん、ご予約ありがとうございます。'}},{id:'cards',type:'carousel',content:{columnsJson:JSON.stringify([{text:'ご案内',actions:[{type:'uri',label:'詳しく',uri:'https://example.test/guide'}]}])}}];
  const before=version(),body={expectedVersion:before,messageBubbles:bubbles};
  const response=await requestWithMethod(url,'PUT',body);expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({data:{stepId:step,messageBubbles:bubbles,version:before+1,sendingStatus:'stopped'}});
  expect(testDb.raw.prepare('SELECT message_bubbles_json FROM scenario_steps WHERE id=?').get(step)).toEqual({message_bubbles_json:JSON.stringify(bubbles)});
  expect((await requestWithMethod(url,'PUT',body)).status).toBe(409);
  const common=new Hono<Env>();common.use('*',authMiddleware);common.route('/',scenarios);
  const commonUrl='/api/scenarios/restaurant-followup:store-ginza';
  const read=await common.request(commonUrl,{headers:{Authorization:'Bearer owner-key'}},env);
  expect(read.status).toBe(200);expect((await read.json() as any).data.steps.find((s:any)=>s.id===step).messageBubbles).toEqual(bubbles);
  const oldEditor=await common.request(commonUrl+'/steps/'+step,{method:'PUT',headers:{Authorization:'Bearer owner-key','Content-Type':'application/json'},body:JSON.stringify({messageType:'text',messageContent:'旧画面の文'})},env);
  expect(oldEditor.status).toBe(409);expect(await oldEditor.json()).toMatchObject({code:'MULTIPLE_MESSAGES_REQUIRE_EDITOR'});

  expect((await requestWithMethod(path+'/steps/restaurant-followup:store-yokohama:reservation_created/messages'+scope,'PUT',{...body,expectedVersion:version()})).status).toBe(404);
  for(const invalid of [null,[],Array(6).fill(bubbles[0]),[{type:'text',content:{text:''}}],[{type:'image',content:{originalContentUrl:'http://invalid'}}]]) {
   const result=await requestWithMethod(url,'PUT',{expectedVersion:version(),messageBubbles:invalid});expect([400,422]).toContain(result.status);
  }
  expect(version()).toBe(before+1);
  expect((await requestWithMethod(url,'PUT',{messageBubbles:bubbles})).status).toBe(400);
  authMocks.getStaffByApiKey.mockResolvedValue({id:'viewer',role:'admin',name:'閲覧',access_level:'read_only',permission_keys:'[]'} as never);
  expect((await requestWithMethod(url,'PUT',{expectedVersion:version(),messageBubbles:bubbles},'reader-key')).status).toBe(403);
 });
 it('同時保存は片方だけ成功し、他店のテンプレート参照を保存しない',async()=>{
  seedRestaurantFixture();const step='restaurant-followup:store-ginza:reservation_created',url=path+'/steps/'+step+'/messages'+scope;
  const first={expectedVersion:version(),messageBubbles:[{id:'one',type:'text',content:{text:'先の保存'}}]};
  const second={...first,messageBubbles:[{id:'two',type:'text',content:{text:'後の保存'}}]};
  const responses=await Promise.all([requestWithMethod(url,'PUT',first),requestWithMethod(url,'PUT',second)]);
  expect(responses.map(r=>r.status).sort()).toEqual([200,409]);
  const saved=(testDb.raw.prepare('SELECT message_bubbles_json FROM scenario_steps WHERE id=?').get(step) as {message_bubbles_json:string}).message_bubbles_json;
  testDb.raw.exec("INSERT INTO templates(id,name,message_type,message_content,line_account_id) VALUES('foreign-card','他店','text','他店の文','account-3')");
  expect((await requestWithMethod(url,'PUT',{expectedVersion:version(),messageBubbles:[{id:'foreign',type:'text',content:{text:'文',templateId:'foreign-card'}}]})).status).toBe(422);
  expect((testDb.raw.prepare('SELECT message_bubbles_json FROM scenario_steps WHERE id=?').get(step) as {message_bubbles_json:string}).message_bubbles_json).toBe(saved);
 });
 it('公開前の開始と古い版を拒否し、共通の行の追加・解除は停止にする',async()=>{
  seedRestaurantFixture();
  expect((await request(path+'/request-start'+scope,{expectedVersion:version()})).status).toBe(409);
  const step='custom-review';
  testDb.raw.prepare("INSERT INTO scenario_steps(id,scenario_id,step_order,message_type,message_content) SELECT ?,'restaurant-followup:store-ginza',COALESCE(MAX(step_order)+1,0),'text','同じ口コミの案内' FROM scenario_steps WHERE scenario_id='restaurant-followup:store-ginza'").run(step);
  const before=version();
  const binding={expectedVersion:before,trigger:'review_request',offsetMinutes:181,enabled:true};
  expect((await requestWithMethod(path+'/bindings/'+step+scope,'POST',binding)).status).toBe(200);
  expect((await requestWithMethod(path+'/bindings/'+step+scope,'PATCH',binding)).status).toBe(409);
  expect((await requestWithMethod(path+'/bindings/'+step+scope,'DELETE',{expectedVersion:version(),trigger:'review_request'})).status).toBe(200);
  expect(testDb.raw.prepare("SELECT sending_status FROM rt_store_followup_templates WHERE store_id='store-ginza'").get()).toEqual({sending_status:'stopped'});
 });
 it('別店の行を結ばず、所属店の外は読めず、閲覧のみは開始・停止・編集できない',async()=>{
  seedRestaurantFixture();
  const body={expectedVersion:version(),trigger:'post_visit',offsetMinutes:180,enabled:true};
  expect((await requestWithMethod(path+'/bindings/restaurant-followup:store-yokohama:post_visit'+scope,'POST',body)).status).toBe(409);
  testDb.raw.exec("INSERT INTO staff_members(id,name,role,api_key,account_scope) VALUES('viewer','閲覧','staff','viewer-test-key','accounts');INSERT INTO staff_account_scopes(staff_id,line_account_id,created_at) VALUES('viewer','account-2',datetime('now'))");
  authMocks.getStaffByApiKey.mockResolvedValue({id:'viewer',name:'閲覧',role:'staff',access_level:'read_only',permission_keys:'[]',assigned_line_account_id:'account-2',can_access_descendant_accounts:0});
  expect((await requestAs(path+'?account_id=account-2','viewer-key')).status).toBe(200);
  expect((await requestAs('/api/restaurant-test/followups/store-yokohama?account_id=account-2','viewer-key')).status).toBe(404);
  for(const suffix of ['/request-start','/stop'])expect((await requestAs(path+suffix+'?account_id=account-2','viewer-key',{expectedVersion:version()})).status).toBe(403);
  expect((await requestWithMethod(path+'/bindings/restaurant-followup:store-ginza:post_visit?account_id=account-2','PATCH',body,'viewer-key')).status).toBe(403);
 });
 it('共通編集で行を削除でき、登録されたアレルゲンと口コミ依頼の区別を返す',async()=>{
  seedRestaurantFixture();
  testDb.raw.prepare("DELETE FROM scenario_steps WHERE id='restaurant-followup:store-ginza:post_visit'").run();
  expect(testDb.raw.prepare("SELECT COUNT(*) n FROM rt_store_followup_step_bindings WHERE store_id='store-ginza' AND trigger='post_visit'").get()).toEqual({n:0});
  testDb.raw.prepare("UPDATE rt_reservations SET dining_snapshot_json=? WHERE id='reservation-ginza'").run(JSON.stringify({courseAllergens:['乳','小麦'],capturedAt:'2026-08-25T08:00:00Z'}));
  const detail=await request('/api/restaurant-test/reservations/reservation-ginza'+scope);expect(detail.status).toBe(200);
  expect((await detail.json() as {data:unknown}).data).toMatchObject({courseAllergens:['乳','小麦'],allergensSource:'registered_at_booking'});
  const history=await request(path+'/review-history'+scope);expect(history.status).toBe(200);
  expect((await history.json() as {data:unknown}).data).toMatchObject({reviewSelection:'all_customers',origin:'line_invitation',verifiedGoogleReviewAttributions:[]});
 });
});

describe('飲食4 系列の管理と権限',()=>{
 it('案内の組と確認済み座標を管理者だけが変更できる。別店・閲覧のみを拒否',async()=>{
  seedRestaurantFixture();
  const query='?account_id=account-1';
  for(const members of [[null,{}],[{storeId:123},{}]]) {
   expect((await request('/api/restaurant-test/store-groups'+query,{name:'壊れた入力',members})).status).toBe(400);
  }
  expect(testDb.raw.prepare('SELECT count(*) n FROM rt_store_groups').get()).toEqual({n:0});
  const made=await request('/api/restaurant-test/store-groups'+query,{name:'近くの店',members:[{storeId:'store-ginza',referralEnabled:true,maxDistance:5},{storeId:'store-yokohama',referralEnabled:false,maxDistance:5}]});
  expect(made.status).toBe(201);
  const id=(await made.json() as {data:{id:string}}).data.id;
  expect((await requestWithMethod('/api/restaurant-test/stores/store-ginza/referral-location'+query,'PUT',{latitude:35.6,longitude:139.7,confirmed:false})).status).toBe(400);
  expect((await requestWithMethod('/api/restaurant-test/stores/store-ginza/referral-location'+query,'PUT',{latitude:35.6,longitude:139.7,confirmed:true})).status).toBe(200);
  expect((await requestWithMethod(`/api/restaurant-test/store-groups/${id}/members/store-yokohama${query}`,'PATCH',{referralEnabled:true,maxDistance:10})).status).toBe(200);
  expect((await request('/api/restaurant-test/store-groups'+query)).status).toBe(200);
  authMocks.getStaffByApiKey.mockResolvedValue({id:'viewer',role:'admin',name:'閲覧',access_level:'read_only',permission_keys:'[]',assigned_line_account_id:null,can_access_descendant_accounts:1});
  expect((await requestWithMethod(`/api/restaurant-test/store-groups/${id}/members/store-ginza${query}`,'PATCH',{referralEnabled:false,maxDistance:5},'viewer-key')).status).toBe(403);
  authMocks.getStaffByApiKey.mockResolvedValue(null);
  expect((await request('/api/restaurant-test/store-groups'+query,{name:'越境',members:[{storeId:'store-ginza',referralEnabled:true,maxDistance:5},{storeId:'not-owned',referralEnabled:true,maxDistance:5}]})).status).toBe(404);
 });
});

it.each(['reservationFrom','reservationTo'])('API-02 %s rejects impossible dates',async key=>{
 seedRestaurantFixture();
 expect((await request(`/api/restaurant-test/snapshot?account_id=account-1&${key}=2026-02-30`)).status).toBe(400);
});

it('API-01 飲食台帳の暦日も日本の00:30を含めて翌日00:30を除く',async()=>{
 seedRestaurantFixture();
 testDb.raw.exec("UPDATE rt_reservations SET starts_at='2026-08-24T15:30:00.000Z',ends_at='2026-08-24T16:30:00.000Z' WHERE id='reservation-ginza'; INSERT INTO rt_reservations(id,store_id,source,external_id,customer_name,guest_count,starts_at,ends_at,table_id,status) VALUES('next-day','store-ginza','restaurant_board','NEXT-DAY','人工客',2,'2026-08-25T15:30:00.000Z','2026-08-25T16:30:00.000Z','table-ginza','confirmed')");
 const res=await request('/api/restaurant-test/snapshot?account_id=account-1&reservationFrom=2026-08-25&reservationTo=2026-08-25');
 expect(res.status).toBe(200);
 const body=await res.json() as {data:{reservations:Array<{id:string}>}};
 expect(body.data.reservations.map(row=>row.id)).toEqual(['reservation-ginza']);
});

it('電話の全角・区切りを検索で整え、他店を混ぜず旧行も更新しない', async () => {
  seedRestaurantFixture();
  testDb.raw.exec("UPDATE rt_reservations SET customer_phone='０９０－１２３４－５６７８',status='visited' WHERE id='reservation-ginza'");
  const path='/api/restaurant-test/customers/search?account_id=account-1&storeId=store-ginza&q=';
  const rows=(await (await request(path+encodeURIComponent('090 1234 5678'))).json() as {data:Array<{phone:string|null}>}).data;
  expect(rows).toHaveLength(1);expect(rows[0].phone).toBe('09012345678');
  const history='/api/restaurant-test/customers/history?account_id=account-1&storeId=store-ginza&phone=';
  expect((await (await request(history+encodeURIComponent('０９０－１２３４－５６７８'))).json() as {data:{visitCount:number}}).data.visitCount).toBe(1);
  expect((await (await request(path.replace('store-ginza','store-yokohama')+'09012345678')).json() as {data:unknown[]}).data).toEqual([]);
  expect(testDb.raw.prepare("SELECT customer_phone FROM rt_reservations WHERE id='reservation-ginza'").get()).toEqual({customer_phone:'０９０－１２３４－５６７８'});
});

describe('電話予約と押さえの受付条件', () => {
  const manual = '/api/restaurant-test/reservations/manual?account_id=account-1';
  const holds = '/api/restaurant-test/reservations/holds?account_id=account-1';
  const now = Date.now();
  const input = { storeId: 'store-ginza', customerName: '試験客', guestCount: 2, startsAt: new Date(now + 3600000).toISOString(), endsAt: new Date(now + 10800000).toISOString(), source: 'phone' };
  it('未設定の店舗は電話と押さえをコード付きで拒否し、店頭受付は通す', async () => {
    seedRestaurantFixture();
    for (const [path, body] of [[manual, input], [holds, {...input, holdMinutes: 15}]] as const) {
      const res = await request(path, body); expect(res.status).toBe(409);
      expect((await res.json() as {code:string}).code).toBe('opening_hours_unconfigured');
    }
    const res = await request(manual, {...input, source:'manual'}); expect(res.status).toBe(201);
  });
  it('設定済みの店は時刻の小さなずれを許す', async () => {
    seedRestaurantFixture();
    testDb.raw.prepare("INSERT INTO rt_opening_hours_settings (store_id, hours_json, updated_by) VALUES (?, ?, 'test')").run('store-ginza', JSON.stringify([]));
    const body = {...input, startsAt:new Date(Date.now()-30000).toISOString(), endsAt:new Date(Date.now()+3600000).toISOString()};
    expect((await request(manual,body)).status).toBe(201);
  });
  it('未設定でも既存の予約は編集できる', async () => {
    seedRestaurantFixture();
    const res = await requestWithMethod('/api/restaurant-test/reservations/reservation-ginza?account_id=account-1', 'PATCH', { note:'編集の確認' });
    expect(res.status).toBe(200);
  });
  it('設定済みでも過去の電話と押さえを拒否する', async () => {
    seedRestaurantFixture();
    testDb.raw.prepare("INSERT INTO rt_opening_hours_settings (store_id, hours_json, updated_by) VALUES (?, ?, 'test')").run('store-ginza', JSON.stringify(Array.from({length:7},(_,weekday)=>({weekday,periods:[]}))));
    const past = {...input, startsAt:new Date(Date.now()-120000).toISOString(), endsAt:new Date(Date.now()+3600000).toISOString()};
    for (const [path, body] of [[manual,past],[holds,{...past,holdMinutes:15}]] as const) {
      const res = await request(path,body); expect(res.status).toBe(409); expect((await res.json() as {code:string}).code).toBe('reservation_time_past');
    }
  });
});
