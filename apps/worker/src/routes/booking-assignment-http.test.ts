import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../worker-env.js';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';
import { seedAssignmentFixture } from '../test-utils/assignment-fixture.js';
const access = vi.hoisted(() => ({ allow: true }));
vi.mock('../services/account-access.js', () => ({
  canAccessAllLineAccounts: vi.fn(async () => access.allow),
  getVisibleLineAccountScope: vi.fn(async () => ({ ids: access.allow ? ['a'] : [], isAccountScoped: true })),
  canAccessLineAccount: vi.fn(async () => access.allow),
}));
vi.mock('../features/booking/booking-automatic-line.js', () => ({ sendAutomaticBookingLine: vi.fn(async () => false) }));
import booking from './booking.js';
import { restaurantTest } from './restaurant-test.js';
let f: SqliteD1;
let role: 'owner' | 'staff' = 'owner', readOnly = false, edit = false;
const input = { method: 'balanced', balancePeriod: 'day', expectedVersion: 0,
  resources: [{ resourceId: 's1', priority: 'preferred', dailyLimit: 3, sortOrder: 0 }] };
const people = '/api/booking/admin/assignment-settings?account_id=a';
const tables = '/api/restaurant-test/assignment-settings?account_id=a&storeId=store';
const automation = '/api/restaurant-test/table-auto-assignment-settings?account_id=a&storeId=store';
function request(path: string, body?: unknown, method = 'PUT') {
  const app = new Hono<Env>();
  app.use('*', async (c, next) => { c.set('staff', { id: 'login', name: '試験', role, readOnly,
    permissionKeys: edit ? ['booking.settings'] : [], viewPermissionKeys: ['booking.settings'] }); await next(); });
  app.route('/', booking); app.route('/', restaurantTest);
  return app.request(path, body === undefined ? {} : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    { DB: f.db, DEPLOY_ENV: 'test', RESTAURANT_TEST_ENABLED: 'true' } as Env['Bindings']);
}
beforeEach(() => { f = createTestD1(); seedAssignmentFixture(f); role = 'owner'; readOnly = false; edit = false; access.allow = true; });
afterEach(() => f.raw.close());
describe('割り当て設定API', () => {
  it('オフでもスタッフ指定の卓を保ち、保存直前に設定が変われば来店記録ごと残さない',async()=>{
    f.raw.exec("UPDATE rt_tables SET is_active=0 WHERE id IN('t2','big')");
    expect((await request(automation,{enabled:false,expectedVersion:0})).status).toBe(200);
    const path='/api/restaurant-test/reservations/walk-in?account_id=a';
    const body={storeId:'store',guestCount:2,tableId:'t1'};
    const prepare=f.db.prepare.bind(f.db);
    const race=vi.spyOn(f.db,'prepare').mockImplementation(sql=>{
      if(sql.includes('RESTAURANT_CAPACITY_CHANGED'))f.raw.exec("UPDATE account_settings SET value=json_set(value,'$.version',2,'$.data.enabled',json('true')) WHERE key='restaurant.table_auto_assignment:store'");
      return prepare(sql);
    });
    expect((await request(path,body,'POST')).status).toBe(409);
    race.mockRestore();
    expect(f.raw.prepare('SELECT COUNT(*) n FROM rt_reservations').get()).toEqual({n:0});
    expect(f.raw.prepare('SELECT COUNT(*) n FROM rt_seat_visit_marks').get()).toEqual({n:0});
    expect((await request(automation,{enabled:false,expectedVersion:2})).status).toBe(200);
    expect((await request(path,body,'POST')).status).toBe(201);
    expect(f.raw.prepare('SELECT table_id FROM rt_reservations').get()).toEqual({table_id:'t1'});
    expect((await request(path,body,'POST')).status).toBe(409);
  });
  it('シンプルな自動配席を読み、版付きでオフにし、同時保存と別店舗を守る', async () => {
    expect(await (await request(automation)).json()).toEqual({success:true,data:{enabled:true,version:0}});
    const result=await Promise.all([request(automation,{enabled:false,expectedVersion:0}),request(automation,{enabled:true,expectedVersion:0})]);
    expect(result.map(r=>r.status).sort()).toEqual([200,409]);
    expect((await request(automation.replace('storeId=store','storeId=other-store'))).status).toBe(404);
    expect((await request(automation,{enabled:'false',expectedVersion:1})).status).toBe(400);
    expect((await request(automation,{enabled:false,expectedVersion:0})).status).toBe(409);
  });
  it('自動配席も閲覧のみと予約設定権限を検査し、破損した設定を黙って上書きしない', async()=>{
    role='staff';
    expect((await request(automation)).status).toBe(200);
    expect((await request(automation,{enabled:false,expectedVersion:0})).status).toBe(403);
    edit=true;readOnly=true;
    expect((await request(automation,{enabled:false,expectedVersion:0})).status).toBe(403);
    readOnly=false;
    expect((await request(automation,{enabled:false,expectedVersion:0})).status).toBe(200);
    f.raw.exec("UPDATE account_settings SET value='broken' WHERE key='restaurant.table_auto_assignment:store'");
    expect((await request(automation)).status).toBe(503);
    expect((await request(automation,{enabled:true,expectedVersion:0})).status).toBe(503);
  });
  it('未移行は初期値と従来方式を明示し、保存は503で断る', async () => {
    f.raw.exec('DROP TABLE booking_assignment_settings');
    expect(await (await request(people)).json()).toMatchObject({ success: true, data: {
      method: 'balanced', balancePeriod: 'day', storageReady: false, effectiveMethod: 'legacy_first', version: 0,
      resources: [{ resourceId: 's1', priority: 'normal', dailyLimit: null }, { resourceId: 's2' }],
    } });
    expect((await request(people, input)).status).toBe(503);
    expect((await request(tables, { ...input, resources: [] })).status).toBe(503);
  });
  it('移行後は保存・再読込・古い版の拒否と新しい版の保存ができる', async () => {
    expect((await request(people, input)).status).toBe(200);
    expect(await (await request(people)).json()).toMatchObject({ data: { storageReady: true, effectiveMethod: 'balanced', version: 1,
      resources: [expect.objectContaining({ resourceId: 's1', dailyLimit: 3, priority: 'preferred' }), expect.objectContaining({resourceId:'s2'})] } });
    expect((await request(people, input)).status).toBe(409);
    expect((await request(people, { ...input, method: 'priority', balancePeriod: 'week', expectedVersion: 1 })).status).toBe(200);
    expect(await (await request(people)).json()).toMatchObject({ data: { method: 'priority', balancePeriod: 'week', version: 2 } });
  });
  it('未作成の設定に0以外の版を渡しても新しく保存しない', async () => {
    expect((await request(people, { ...input, expectedVersion: 1 })).status).toBe(409);
    expect(await (await request(people)).json()).toMatchObject({ data: { version: 0 } });
  });
  it('同じ版の同時保存は片方だけを通す', async () => {
    const results = await Promise.all([request(people, input), request(people, { ...input, method: 'random' })]);
    expect(results.map(r => r.status).sort()).toEqual([200, 409]);
  });
  it('卓の設定は店ごとに保存し、担当者の設定と混ざらない', async () => {
    const body = { ...input, method: 'random', resources: [{ ...input.resources[0], resourceId: 't1' }] };
    expect((await request(tables, body)).status).toBe(200);
    expect(await (await request(tables)).json()).toMatchObject({ data: { method: 'random', version: 1, resources: expect.arrayContaining([{ ...body.resources[0] }]) } });
    expect(await (await request(people)).json()).toMatchObject({ data: { method: 'balanced', version: 0 } });
  });
  it.each([people, tables])('閲覧のみ・編集キーなしは保存できず、編集キーを持つスタッフは保存できる: %s', async path => {
    role = 'staff';
    const body = { ...input, resources: [] };
    expect((await request(path)).status).toBe(200);
    expect((await request(path, body)).status).toBe(403);
    edit = true; readOnly = true;
    expect((await request(path, body)).status).toBe(403);
    readOnly = false;
    expect((await request(path, body)).status).toBe(200);
  });
  it('担当外アカウントと別店舗は読めず、別担当者・卓の設定は保存できない', async () => {
    access.allow = false;
    expect((await request(people)).status).toBe(403);
    expect((await request(tables)).status).toBe(403);
    access.allow = true;
    expect((await request(tables.replace('storeId=store', 'storeId=other-store'))).status).toBe(404);
    expect((await request(people, { ...input, resources: [{ ...input.resources[0], resourceId: 'other' }] })).status).toBe(400);
    expect((await request(tables, { ...input, resources: [{ ...input.resources[0], resourceId: 'other-table' }] })).status).toBe(400);
  });
  it.each([
    { method: 'first' }, { balancePeriod: 'month' }, { expectedVersion: -1 }, { expectedVersion: '0' },
    { resources: [{ ...input.resources[0], priority: 'urgent' }] },
    { resources: [{ ...input.resources[0], dailyLimit: 0 }] },
    { resources: [{ ...input.resources[0], dailyLimit: '' }] },
    { resources: [{ ...input.resources[0], sortOrder: 0.5 }] },
    { resources: [input.resources[0], input.resources[0]] },
  ])('不正な設定は欄のエラーで返す: %j', async patch => {
    const result = await request(people, { ...input, ...patch });
    expect(result.status).toBe(400);
    expect(await result.json()).toMatchObject({ code: 'invalid_assignment_settings', fields: expect.any(Object) });
  });
  it('DBの障害を未移行の初期値にすり替えない', async () => {
    f.raw.exec('ALTER TABLE booking_assignment_settings RENAME COLUMN resources_json TO broken');
    expect((await request(people)).status).toBe(503);
  });
});
