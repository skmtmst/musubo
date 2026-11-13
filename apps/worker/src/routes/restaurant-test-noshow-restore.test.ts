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
let seq = 0;

function app() {
  const instance = new Hono<Env>();
  instance.use('*', authMiddleware);
  instance.route('/', restaurantTest);
  return instance;
}
const versionOf = (id: string) => (testDb.raw.prepare(
  'SELECT customer_version FROM rt_reservations WHERE id=?').get(id) as { customer_version: number }).customer_version;
const attend = (id: string, action: string) => app().request(
  `/api/restaurant-test/reservations/${id}/attendance?account_id=account-1`, {
    method: 'POST',
    headers: { Authorization: 'Bearer owner-key', 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, expectedVersion: versionOf(id), requestId: `noshow-restore-${(seq += 1)}` }),
  }, env);
const restore = (id: string) => app().request(
  `/api/restaurant-test/reservations/${id}?account_id=account-1`, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer owner-key', 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'confirmed', expectedVersion: versionOf(id) }),
  }, env);
const patch = (id: string, body: Record<string, unknown>) => app().request(
  `/api/restaurant-test/reservations/${id}?account_id=account-1`, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer owner-key', 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedVersion: versionOf(id), ...body }),
  }, env);
const row = (id: string) => testDb.raw.prepare(
  'SELECT status,customer_version FROM rt_reservations WHERE id=?').get(id) as { status: string; customer_version: number };
const marks = (id: string) => testDb.raw.prepare(
  'SELECT kind,undone_at IS NOT NULL AS undone FROM rt_seat_visit_marks WHERE reservation_id=? ORDER BY marked_at,rowid').all(id);

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

describe('無断→有効に戻す→来店→訂正', () => {
  it('通常の復旧で無断の印と監査を更新し、次の来店を訂正できる', async () => {
    seedRestaurantData(testDb);
    const store = testDb.raw.prepare("SELECT id FROM rt_stores WHERE code = 'GINZA'").get() as { id: string };
    const created = await app().request('/api/restaurant-test/reservations/manual?account_id=account-1', {
      method: 'POST',
      headers: { Authorization: 'Bearer owner-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        storeId: store.id, customerName: '見本 21', guestCount: 2,
        startsAt: '2026-10-10T10:00:00.000Z', endsAt: '2026-10-10T12:00:00.000Z',
      }),
    }, env);
    expect(created.status).toBe(201);
    const { data: { id } } = await created.json() as { data: { id: string } };

    expect((await attend(id, 'no_show')).status).toBe(200);
    expect(row(id)).toEqual({ status: 'no_show', customer_version: 2 });
    expect(marks(id)).toEqual([{ kind: 'no_show', undone: 0 }]);

    const staleRestore = await app().request(`/api/restaurant-test/reservations/${id}?account_id=account-1`, {
      method: 'PATCH', headers: { Authorization: 'Bearer owner-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'confirmed', expectedVersion: 1 }),
    }, env);
    expect(staleRestore.status).toBe(409);
    expect(row(id)).toEqual({ status: 'no_show', customer_version: 2 });
    expect(marks(id)).toEqual([{ kind: 'no_show', undone: 0 }]);

    /* 通常の復旧でも無断の印を取り消す。 */
    expect((await restore(id)).status).toBe(200);
    expect(row(id)).toEqual({ status: 'confirmed', customer_version: 3 });
    expect(marks(id)).toEqual([{ kind: 'no_show', undone: 1 }]);

    const audit = testDb.raw.prepare('SELECT undone_at, undone_request_id, result_version FROM rt_seat_visit_marks WHERE reservation_id=?').get(id) as { undone_at: string | null; undone_request_id: string | null; result_version: number };
    expect(audit.undone_at).not.toBeNull();
    expect(audit.undone_request_id).not.toBeNull();
    expect(audit.result_version).toBe(3);

    /* 復旧だけでは来店数は増えない。 */
    const counted = testDb.raw.prepare(
      `SELECT COUNT(*) AS total FROM rt_reservations r WHERE r.store_id = ? AND r.status IN ('visited','seated')`)
      .get(store.id) as { total: number };
    expect(counted.total).toBe(0);

    expect((await attend(id, 'visited')).status).toBe(200);
    expect(row(id).status).toBe('visited');
    expect((await attend(id, 'undo_visit')).status).toBe(200);
    expect(row(id).status).toBe('confirmed');
    expect((await attend(id, 'undo_visit')).status).toBe(404);
    expect(marks(id)).toEqual([{ kind: 'no_show', undone: 1 }, { kind: 'visited', undone: 1 }]);
  });

  it('承認待ちは無断にできず、状態と版を保つ', async () => {
    seedRestaurantData(testDb);
    const store = testDb.raw.prepare("SELECT id FROM rt_stores WHERE code = 'GINZA'").get() as { id: string };
    const created = await app().request('/api/restaurant-test/reservations/manual?account_id=account-1', {
      method: 'POST', headers: { Authorization: 'Bearer owner-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ storeId: store.id, customerName: '見本 22', guestCount: 2, startsAt: '2026-10-10T10:00:00.000Z', endsAt: '2026-10-10T12:00:00.000Z' }),
    }, env);
    const { data: { id } } = await created.json() as { data: { id: string } };
    expect((await patch(id, { status: 'pending' })).status).toBe(200);
    const response = await attend(id, 'no_show');
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'approval_required' });
    const direct = await patch(id, { status: 'no_show' });
    expect(direct.status).toBe(409);
    expect(await direct.json()).toMatchObject({ code: 'approval_required' });
    expect(row(id)).toEqual({ status: 'pending', customer_version: 2 });
    expect(marks(id)).toEqual([]);
  });

  it('古い未取消の来店印がある予約は無断にせず、記録を保つ', async () => {
    seedRestaurantData(testDb);
    const store = testDb.raw.prepare("SELECT id FROM rt_stores WHERE code = 'GINZA'").get() as { id: string };
    const created = await app().request('/api/restaurant-test/reservations/manual?account_id=account-1', {
      method: 'POST', headers: { Authorization: 'Bearer owner-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ storeId: store.id, customerName: '見本 22', guestCount: 2, startsAt: '2026-10-10T10:00:00.000Z', endsAt: '2026-10-10T12:00:00.000Z' }),
    }, env);
    const { data: { id } } = await created.json() as { data: { id: string } };
    expect((await attend(id, 'visited')).status).toBe(200);
    testDb.raw.prepare("UPDATE rt_reservations SET status='confirmed', customer_version=customer_version+1 WHERE id=?").run(id);
    const response = await attend(id, 'no_show');
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'already_arrived' });
    expect((await patch(id, { status: 'no_show' })).status).toBe(409);
    expect(marks(id)).toEqual([{ kind: 'visited', undone: 0 }]);
  });

  it('来店後に取消・復旧しても来店の印が残らない', async () => {
    seedRestaurantData(testDb);
    const store = testDb.raw.prepare("SELECT id FROM rt_stores WHERE code = 'GINZA'").get() as { id: string };
    const created = await app().request('/api/restaurant-test/reservations/manual?account_id=account-1', {
      method: 'POST', headers: { Authorization: 'Bearer owner-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ storeId: store.id, customerName: '見本 22', guestCount: 2, startsAt: '2026-10-10T10:00:00.000Z', endsAt: '2026-10-10T12:00:00.000Z' }),
    }, env);
    const { data: { id } } = await created.json() as { data: { id: string } };
    expect((await attend(id, 'visited')).status).toBe(200);
    expect((await patch(id, { status: 'cancelled' })).status).toBe(200);
    expect((await restore(id)).status).toBe(200);
    expect(marks(id)).toEqual([{ kind: 'visited', undone: 1 }]);
    expect((await attend(id, 'no_show')).status).toBe(200);
    expect(marks(id)).toEqual([{ kind: 'visited', undone: 1 }, { kind: 'no_show', undone: 0 }]);
  });

  it('無断の復活は既存の来店取消口で印・監査・版を保って戻す', async () => {
    seedRestaurantData(testDb);
    const store = testDb.raw.prepare("SELECT id FROM rt_stores WHERE code = 'GINZA'").get() as { id: string };
    const created = await app().request('/api/restaurant-test/reservations/manual?account_id=account-1', {
      method: 'POST',
      headers: { Authorization: 'Bearer owner-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        storeId: store.id, customerName: '見本 21', guestCount: 2,
        startsAt: '2026-10-10T10:00:00.000Z', endsAt: '2026-10-10T12:00:00.000Z',
      }),
    }, env);
    expect(created.status).toBe(201);
    const { data: { id } } = await created.json() as { data: { id: string } };

    expect((await attend(id, 'no_show')).status).toBe(200);
    const undone = await attend(id, 'undo_visit');
    expect(undone.status).toBe(200);
    expect(row(id)).toEqual({ status: 'confirmed', customer_version: 3 });
    const mark = testDb.raw.prepare(
      'SELECT kind,undone_at,undone_request_id,result_version FROM rt_seat_visit_marks WHERE reservation_id=?')
      .get(id) as { kind: string; undone_at: string | null; undone_request_id: string | null; result_version: number };
    expect(mark.kind).toBe('no_show');
    expect(mark.undone_at).not.toBeNull();
    expect(mark.undone_request_id).toMatch(/^noshow-restore-/);
    expect(mark.result_version).toBe(3);

    /* 印が無い予約の取消は来店取消口では戻せない（通常復活のまま）。 */
    const missing = await app().request(
      `/api/restaurant-test/reservations/no-such-id/attendance?account_id=account-1`, {
        method: 'POST',
        headers: { Authorization: 'Bearer owner-key', 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'undo_visit', expectedVersion: 1, requestId: 'noshow-restore-missing' }),
      }, env);
    expect(missing.status).toBe(404);
  });

  it('印のない無断（PATCH直送・旧記録）も通常の復旧で有効に戻す', async () => {
    seedRestaurantData(testDb);
    const store = testDb.raw.prepare("SELECT id FROM rt_stores WHERE code = 'GINZA'").get() as { id: string };
    const created = await app().request('/api/restaurant-test/reservations/manual?account_id=account-1', {
      method: 'POST',
      headers: { Authorization: 'Bearer owner-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        storeId: store.id, customerName: '見本 21', guestCount: 2,
        startsAt: '2026-10-10T10:00:00.000Z', endsAt: '2026-10-10T12:00:00.000Z',
      }),
    }, env);
    expect(created.status).toBe(201);
    const { data: { id } } = await created.json() as { data: { id: string } };

    /* PATCHで直接無断にした予約には印が無い。 */
    expect((await patch(id, { status: 'no_show' })).status).toBe(200);
    expect(marks(id)).toEqual([]);

    const undone = await restore(id);
    expect(undone.status).toBe(200);
    expect(row(id)).toEqual({ status: 'confirmed', customer_version: 3 });
    expect(marks(id)).toEqual([]);

    /* 取消は来店取消口では戻せない（通常復活のまま）。 */
    expect((await patch(id, { status: 'cancelled' })).status).toBe(200);
    const cancelledUndo = await attend(id, 'undo_visit');
    expect(cancelledUndo.status).toBe(404);

    /* 古い版の取消は競合で拒否する。 */
    const stale = await app().request(
      `/api/restaurant-test/reservations/${id}/attendance?account_id=account-1`, {
        method: 'POST',
        headers: { Authorization: 'Bearer owner-key', 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'undo_visit', expectedVersion: 1, requestId: 'noshow-restore-stale' }),
      }, env);
    expect(stale.status).toBe(409);
  });

  it('複数の履歴があっても最新の印から順に戻す', async () => {
    seedRestaurantData(testDb);
    const store = testDb.raw.prepare("SELECT id FROM rt_stores WHERE code = 'GINZA'").get() as { id: string };
    const created = await app().request('/api/restaurant-test/reservations/manual?account_id=account-1', {
      method: 'POST',
      headers: { Authorization: 'Bearer owner-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        storeId: store.id, customerName: '見本 21', guestCount: 2,
        startsAt: '2026-10-10T10:00:00.000Z', endsAt: '2026-10-10T12:00:00.000Z',
      }),
    }, env);
    expect(created.status).toBe(201);
    const { data: { id } } = await created.json() as { data: { id: string } };

    expect((await attend(id, 'visited')).status).toBe(200);
    expect((await attend(id, 'undo_visit')).status).toBe(200);
    expect((await attend(id, 'no_show')).status).toBe(200);
    expect((await attend(id, 'undo_visit')).status).toBe(200);
    expect(row(id).status).toBe('confirmed');
    expect(marks(id)).toEqual([{ kind: 'visited', undone: 1 }, { kind: 'no_show', undone: 1 }]);
  });
});
