import { seedExistingRestaurantFollowup } from '../test-utils/restaurant-followup-fixture.js';
import { publishScenarioVersion } from '@line-crm/db';
import { requestRestaurantFollowupApproval } from '../services/restaurant-followup.js';
/**
 * 席の空き待ちと席の来店の印（booking-plus 6 の席対応）。
 *
 * - 席の空き待ちの登録・二重登録は409・一覧・取り消し。
 * - 予約の取り消しで卓が空いたら、人数が入る組の早い順に1組だけカードが1通。
 *   先頭の人数に合わない卓では、後ろの組を飛ばして案内しない。
 * - 「来店した」→案内済み、「遅れる」→分数だけ、「来なかった」→無断。
 *   だれがいつ付けたかが残り、取り消せる。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, test, vi } from 'vitest';
import { Hono } from 'hono';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';

const commonSender=vi.hoisted(()=>vi.fn(async(..._args:unknown[])=>({requestId:null})));
vi.mock('../services/line-proxy-send.js',()=>({pushViaHarnessProxy:commonSender}));

const authMocks = vi.hoisted(() => ({
  getPlatformSetting: async () => 'false', // Explicit Off fixture for route authorization.
  getStaffByApiKey: vi.fn(async () => null),
  getStaffByAdminSession: vi.fn(async () => null),
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

vi.mock('../features/booking/booking-automatic-line.js',()=>({sendAutomaticBookingLine:vi.fn(async()=>true)}));
import { sendAutomaticBookingLine } from '../features/booking/booking-automatic-line.js';

const cardSender = vi.mocked(sendAutomaticBookingLine);

const { authMiddleware } = await import('../middleware/auth.js');
const { restaurantTest } = await import('./restaurant-test.js');
type Env = import('../index.js').Env;

const here = dirname(fileURLToPath(import.meta.url));
let testDb: SqliteD1;
let env: Env['Bindings'];

const TENANT = '00000000-0000-4000-8000-000000000001';
const slotStart = new Date(Date.now() + 48 * 60 * 60_000);
slotStart.setUTCHours(9, 0, 0, 0);
const SLOT = slotStart.toISOString();
const SLOT_END = new Date(slotStart.getTime() + 2 * 60 * 60_000).toISOString();

function seedStore() {
  testDb.raw.prepare(`UPDATE tenants SET feature_packs = '["restaurant"]' WHERE id = ?`).run(TENANT);
  testDb.raw.prepare(
    'INSERT INTO rt_organizations (id, account_id, tenant_id, name) VALUES (?, ?, ?, ?)',
  ).run('org-s', 'account-1', TENANT, 'S店');
  testDb.raw.prepare(
    `INSERT INTO rt_stores (id, organization_id, name, code, line_account_id, status)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run('store-s', 'org-s', 'S店', 'S', 'account-9', 'active');
  testDb.raw.prepare(
    `INSERT INTO rt_tables (id, store_id, code, label, seat_type, min_capacity, max_capacity, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('table-1', 'store-s', 'T1', 'テーブル1', 'table', 1, 2, 1);
  testDb.raw.prepare(
    `INSERT INTO rt_tables (id, store_id, code, label, seat_type, min_capacity, max_capacity, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('table-2', 'store-s', 'T2', 'テーブル2', 'table', 2, 6, 1);
  testDb.raw.prepare(
    `INSERT INTO line_accounts (id, name, channel_id, channel_secret, channel_access_token)
     VALUES (?, ?, ?, ?, ?)`,
  ).run('account-9', 'S店', 'channel-s', 'secret-s', 'token-s');
  seedExistingRestaurantFollowup(testDb,'store-s');
}

function seedReservation(id: string, status = 'confirmed', tableId: string | null = 'table-1') {
  testDb.raw.prepare(
    `INSERT INTO rt_reservations
      (id, store_id, source, customer_name, guest_count, starts_at, ends_at, table_id, status)
     VALUES (?, 'store-s', 'manual', '予約客', 2, ?, ?, ?, ?)`,
  ).run(id, SLOT, SLOT_END, tableId, status);
}

function app() {
  const instance = new Hono<Env>();
  instance.use('*', authMiddleware);
  instance.route('/', restaurantTest);
  return instance;
}

function post(path: string, body: unknown) {
  return app().request(`${path}?account_id=account-1`, {
    method: 'POST',
    headers: { Authorization: 'Bearer owner-key', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, env);
}

function get(path: string) {
  const separator = path.includes('?') ? '&' : '?';
  return app().request(`${path}${separator}account_id=account-1`, {
    headers: { Authorization: 'Bearer owner-key' },
  }, env);
}

function patch(path: string, body: unknown) {
  const id=path.match(/^\/api\/restaurant-test\/reservations\/([^/?]+)(?:\?|$)/)?.[1];
  if(id&&body&&typeof body==='object'&&!('expectedVersion' in body))body={...body,expectedVersion:((testDb.raw.prepare('SELECT customer_version FROM rt_reservations WHERE id=?').get(id)) as {customer_version:number}|undefined)?.customer_version??1};

  return app().request(`${path}?account_id=account-1`, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer owner-key', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, env);
}

function del(path: string) {
  return app().request(`${path}${path.includes('?')?'&':'?'}account_id=account-1`, {
    method: 'DELETE',
    headers: { Authorization: 'Bearer owner-key' },
  }, env);
}

beforeEach(() => {
  authMocks.getStaffByApiKey.mockReset();
  authMocks.getStaffByApiKey.mockResolvedValue(null);
  authMocks.getStaffByAdminSession.mockReset();
  authMocks.getStaffByAdminSession.mockResolvedValue(null);
  authMocks.lineAccounts = [
    { id: 'account-1', name: '統括', is_active: 1, channel_access_token: 'token-1' },
    { id: 'account-9', name: 'S店', is_active: 1, channel_access_token: 'token-s' },
  ];
  testDb = createTestD1({ loginPolicy: 'off' });
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
    LIFF_URL: 'https://liff.line.me/test123', LINE_CHANNEL_ID: 'unused',
    LINE_LOGIN_CHANNEL_ID: 'unused', LINE_LOGIN_CHANNEL_SECRET: 'unused',
    WORKER_URL: 'https://worker.example.test',
    LINE_CREDENTIAL_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  };
  cardSender.mockClear();commonSender.mockClear();
  seedStore();
});

async function approveFollowup(){
 await publishScenarioVersion(testDb.db,'restaurant-followup:store-s',{staffId:'owner',idempotencyKey:crypto.randomUUID()});
 const t=testDb.raw.prepare("SELECT template_version FROM rt_store_followup_templates WHERE store_id='store-s'").get() as {template_version:number};
 const a=await requestRestaurantFollowupApproval(testDb.db,'store-s',t.template_version,'owner');expect(a).not.toBeNull();
 testDb.raw.prepare("UPDATE rt_approval_requests SET status='approved' WHERE id=?").run(a!.id);
}

describe('席の空き待ち', () => {
  test('登録・二重登録は409・一覧・取り消し', async () => {
    const body = {
      storeId: 'store-s', startsAt: SLOT, guestCount: 2,
      customerName: '山本', lineUid: 'U-seat-a',
    };
    const first = await post('/api/restaurant-test/seat-waitlist', body);
    expect(first.status).toBe(201);
    const id = (await first.json() as { success: boolean; data: { id: string } }).data.id;

    const duplicate = await post('/api/restaurant-test/seat-waitlist', body);
    expect(duplicate.status).toBe(409);

    const listed = await get(`/api/restaurant-test/seat-waitlist?storeId=store-s&startsAt=${encodeURIComponent(SLOT)}`);
    expect(listed.status).toBe(200);
    const listedBody = await listed.json() as {
      success: boolean; data: { waitlist: Array<{ id: string; status: string }> };
    };
    expect(listedBody.data.waitlist).toHaveLength(1);
    expect(listedBody.data.waitlist[0]).toMatchObject({ id, status: 'waiting' });

    const cancelled = await del(`/api/restaurant-test/seat-waitlist/${id}`);
    expect(cancelled.status).toBe(200);
  });

  test('取り消しで空いた卓に入る組だけカードが1通', async () => {
    seedReservation('res-full');
    testDb.raw.exec("UPDATE rt_tables SET is_active=0 WHERE id='table-2'");
    // 2名の組（テーブル1に入る）と6名の組（テーブル1に入らない）。
    await post('/api/restaurant-test/seat-waitlist', {
      storeId: 'store-s', startsAt: SLOT, guestCount: 2,
      customerName: '入る組', lineUid: 'U-fit',
    });
    await post('/api/restaurant-test/seat-waitlist', {
      storeId: 'store-s', startsAt: SLOT, guestCount: 6,
      customerName: '入らない組', lineUid: 'U-unfit',
    });

    testDb.raw.exec(`INSERT INTO friends(id,line_account_id,line_user_id,display_name,is_following) VALUES('friend-fit','account-9','U-fit','試験の組',1)`);
    await approveFollowup();
    const cancelled = await patch('/api/restaurant-test/reservations/res-full', { status: 'cancelled' });
    expect(cancelled.status).toBe(200);

    expect(cardSender).not.toHaveBeenCalled();expect(commonSender).toHaveBeenCalledTimes(1);
    expect(commonSender.mock.calls[0]?.[2]).toBe('U-fit');
    const card = JSON.stringify(commonSender.mock.calls[0]?.[3]);
    expect(card).toContain('この時間で予約する');
    expect(card).toContain('今回は見送る');
    expect(card).toContain('seat_waitlist=');
    const rows = testDb.raw.prepare(
      `SELECT customer_name, status, table_id FROM rt_seat_waitlist ORDER BY created_at`).all() as Array<{
      customer_name: string; status: string; table_id: string | null;
    }>;
    expect(rows[0]).toMatchObject({ customer_name: '入る組', status: 'invited', table_id: 'table-1' });
    expect(rows[1]).toMatchObject({ customer_name: '入らない組', status: 'waiting' });
  });
});

describe('席の来店の印', () => {
  test('来店→来店済み・遅れる→分数だけ・取り消せる', async () => {
    seedReservation('res-1');
    const visited = await post('/api/restaurant-test/reservations/res-1/visit', { kind: 'visited',expectedVersion:1,requestId:'arrive' });
    expect(visited.status).toBe(200);
    const visitedBody = await visited.json() as {
      success: boolean; data: { status: string; visit_mark: { kind: string; marked_at: string } };
    };
    expect(visitedBody.data.status).toBe('visited');
    expect(visitedBody.data.visit_mark.kind).toBe('visited');

    const undone = await del('/api/restaurant-test/reservations/res-1/visit?expectedVersion=2&requestId=undo');
    expect(undone.status).toBe(200);
    expect(await undone.json()).toMatchObject({ success: true, data: { status: 'confirmed' } });

    const late = await post('/api/restaurant-test/reservations/res-1/visit', {
      kind: 'late', lateMinutes: 10,expectedVersion:3,requestId:'late',
    });
    expect(late.status).toBe(200);
    const lateBody = await late.json() as {
      success: boolean; data: { status: string; visit_mark: { late_minutes: number } };
    };
    expect(lateBody.data.status).toBe('confirmed');
    expect(lateBody.data.visit_mark).toMatchObject({ late_minutes: 10 });

    const noMinutes = await post('/api/restaurant-test/reservations/res-1/visit', { kind: 'late' });
    expect(noMinutes.status).toBe(400);
  });
});


describe('飲食2の共通受付と権限',()=>{
 test('担当者も来店・退店でき、退店後の案内を再送しても1通だけ',async()=>{
  authMocks.getStaffByApiKey.mockResolvedValue({id:'staff-1',name:'担当',role:'staff',tenant_id:TENANT,is_active:1} as never);
  seedReservation('res-depart');
  testDb.raw.exec("UPDATE rt_tables SET is_active=0 WHERE id='table-2'");
  testDb.raw.exec("INSERT INTO friends(id,line_account_id,line_user_id,display_name,is_following) VALUES('friend-w','account-9','U-w','試験客',1)");
  await post('/api/restaurant-test/seat-waitlist',{storeId:'store-s',startsAt:SLOT,guestCount:2,customerName:'待つ組',lineUid:'U-w'});
  expect((await post('/api/restaurant-test/reservations/res-depart/attendance',{action:'visited',expectedVersion:1,requestId:'arrive'})).status).toBe(200);
  await approveFollowup();
  const depart=()=>post('/api/restaurant-test/reservations/res-depart/attendance',{action:'depart',expectedVersion:2,requestId:'depart'});
  expect((await depart()).status).toBe(200);expect((await depart()).status).toBe(200);
  expect(cardSender).not.toHaveBeenCalled();expect(commonSender).toHaveBeenCalledTimes(1);
  expect(testDb.raw.prepare('SELECT status,table_id FROM rt_seat_waitlist').get()).toMatchObject({status:'invited',table_id:'table-1'});
  expect((await get(`/api/restaurant-test/rotation?storeId=store-s&date=${SLOT.slice(0, 10)}`)).status).toBe(200);
 });
 test('閲覧のみは更新できず、別組織の予約と集計は読めない',async()=>{
  seedReservation('res-own');
  authMocks.getStaffByApiKey.mockResolvedValue({id:'viewer-1',name:'閲覧',role:'staff',access_level:'read_only',tenant_id:TENANT,is_active:1} as never);
  expect((await post('/api/restaurant-test/reservations/res-own/attendance',{action:'visited',expectedVersion:1,requestId:'forbidden'})).status).toBe(403);
  authMocks.getStaffByApiKey.mockResolvedValue(null);
  testDb.raw.exec("INSERT INTO rt_organizations(id,account_id,name) VALUES('other-o','other-account','別組織');INSERT INTO rt_stores(id,organization_id,name,code) VALUES('other-s','other-o','別店','X');INSERT INTO rt_reservations(id,store_id,source,customer_name,guest_count,starts_at,ends_at,status) VALUES('other-r','other-s','phone','架空客',1,'2026-11-10T09:00:00Z','2026-11-10T10:00:00Z','confirmed')");
  expect((await post('/api/restaurant-test/reservations/other-r/attendance',{action:'visited',expectedVersion:1,requestId:'other'})).status).toBe(404);
  expect((await get('/api/restaurant-test/rotation?storeId=other-s&date=2026-11-10')).status).toBe(404);
  expect(testDb.raw.prepare("SELECT customer_version FROM rt_reservations WHERE id='other-r'").get()).toEqual({customer_version:1});
 });
});
