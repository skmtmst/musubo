import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../worker-env.js';
import { tzDateStr } from '../services/availability.js';
import { restaurantCivilTime } from '../services/restaurant-booking.js';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';
import { seedRestaurantFixture } from '../test-utils/restaurant-fixture.js';
import { restaurantTest } from './restaurant-test.js';

let testDb: SqliteD1;

beforeEach(() => {
  testDb = createTestD1();
  seedRestaurantFixture(testDb);
  testDb.raw.exec(`INSERT INTO line_accounts(id,name,channel_id,channel_secret,channel_access_token,liff_id)
    VALUES('account-1','管理','one','','',''),('account-2','店1','two','','','store-liff'),('account-3','店2','three','','','other-liff')`);
});

afterEach(() => testDb.raw.close());

const requestWithMethod = (path: string, method: string, body?: unknown) => {
  const app = new Hono<Env>();
  app.use('*', async (c, next) => {
    c.set('staff', { id: 'env-owner', name: '試験', role: 'owner', readOnly: false });
    return next();
  });
  app.route('/', restaurantTest);
  return app.request(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, { DB: testDb.db, DEPLOY_ENV: 'test', RESTAURANT_TEST_ENABLED: 'true' } as Env['Bindings']);
};
const request = (path: string) => requestWithMethod(path, 'GET');

describe('予約枠の配分範囲', () => {
  const hours = Array.from({ length: 7 }, (_, weekday) => ({ weekday, periods: [{ opensAt: '17:00', closesAt: '19:00' }] }));
  const alloc = { otaCapacity: 1, lineCapacity: 1, walkInCapacity: 1 };

  it('営業日の基本配分を仮想枠へ適用し、日と時間帯の配分を優先する', async () => {
    const date = tzDateStr('Asia/Tokyo', new Date());
    const base = '/api/restaurant-test/inventory';
    const query = '?account_id=account-1&storeId=store-ginza&date=' + date;
    const put = (payload: Record<string, unknown>) => requestWithMethod(base + '/allocation?account_id=account-1', 'PUT', { storeId: 'store-ginza', ...payload });
    await requestWithMethod('/api/restaurant-test/opening-hours?account_id=account-1','PUT',{storeId:'store-ginza',hours,expectedVersion:0});
    expect(await (await put({ scope:'standard',expectedVersion:0,allocation:alloc })).json())
      .toEqual({ success: true, data: { version: 1 } });
    expect((await put({ scope:'standard',expectedVersion:0,allocation:alloc })).status).toBe(409);
    const dayResult = await (await request(base + '/day' + query)).json() as {
      allocation: unknown; data: Array<{starts_at:string;line_capacity:number;allocationSource:string}>
    };
    expect(dayResult.allocation).toMatchObject({ version:1,standard:alloc,day:null,hoursStatus:'open' });
    expect(dayResult.data).toHaveLength(4);
    expect(dayResult.data.every(slot => slot.line_capacity === 1 && slot.allocationSource === 'standard')).toBe(true);
    const startsAt = dayResult.data[1].starts_at;
    expect((await put({ scope:'day',date,expectedVersion:1,allocation:{...alloc,lineCapacity:2} })).status).toBe(200);
    expect((await put({ scope:'slot',startsAt,expectedVersion:2,allocation:{...alloc,lineCapacity:0} })).status).toBe(200);
    expect((await (await request(base + '/day' + query)).json() as typeof dayResult).data).toMatchObject([
      {line_capacity:2,allocationSource:'day'}, {line_capacity:0,allocationSource:'slot'},
      {line_capacity:2,allocationSource:'day'}, {line_capacity:2,allocationSource:'day'},
    ]);
    expect((await put({ scope:'slot',startsAt,expectedVersion:3,allocation:null })).status).toBe(200);
    expect((await (await request(base + '/day' + query)).json() as typeof dayResult).data[1]).toMatchObject({line_capacity:2,allocationSource:'day'});
    expect((await requestWithMethod('/api/restaurant-test/inventory-rules?account_id=account-1','PUT',{
      storeId:'store-ginza', threshold:4, stopLine:true, stopSameDay:false, notify:false, expectedVersion:0,
    })).status).toBe(200);
    expect((await (await request(base + '/day' + query)).json() as typeof dayResult).data[1]).toMatchObject({line_capacity:0, auto_line_original:2});
    expect(await (await request('/api/restaurant-test/inventory-rules' + query)).json()).toMatchObject({state:{stoppedTotal:4}});
    expect(testDb.raw.prepare('SELECT COUNT(*) AS n FROM rt_inventory_slots').get()).toEqual({ n:0 });
  });
  it('将来の日付で全店休業と一部の卓の休止を区別する', async () => {
    const date = '2099-10-10';
    const storeId = 'store-ginza';
    const base = '/api/restaurant-test/inventory';
    const account = '?account_id=account-1';
    const dayUrl = `${base}/day${account}&storeId=${storeId}&date=${date}`;
    const insert = testDb.raw.prepare(`INSERT INTO rt_closures
      (id,store_id,start_date,end_date,all_day,kind,table_ids_json,periods_json) VALUES(?,?,?,?,1,'temporary_closed',?,?)`);
    const periods = JSON.stringify([{
      startsAt: restaurantCivilTime(date, 0, 'Asia/Tokyo'),
      endsAt: restaurantCivilTime(date, 1440, 'Asia/Tokyo'),
    }]);
    await requestWithMethod('/api/restaurant-test/opening-hours' + account, 'PUT', { storeId, hours, expectedVersion: 0 });
    await requestWithMethod(base + '/allocation' + account, 'PUT', { storeId, scope: 'standard', expectedVersion: 0, allocation: alloc });
    insert.run('closed-table', storeId, date, date, '["table-ginza"]', periods);
    expect(await (await request(dayUrl)).json()).toMatchObject({
      allocation: { hoursStatus: 'open' },
      data: Array.from({ length: 4 }, () => ({ freeSeats: 0, closedTableIds: ['table-ginza'] })),
    });
    testDb.raw.exec("UPDATE rt_closures SET archived_at=datetime('now') WHERE id='closed-table'");
    insert.run('closed-store', storeId, date, date, '[]', periods);
    expect(await (await request(dayUrl)).json()).toMatchObject({
      allocation: { hoursStatus: 'closed' },
      data: [],
      closures: expect.arrayContaining([expect.objectContaining({ id: 'closed-store' })]),
    });
    const result = await requestWithMethod(base + '/allocation' + account, 'PUT', { storeId, scope: 'day', date, expectedVersion: 1, allocation: alloc });
    expect(result.status).toBe(409);
    expect(await result.json()).toMatchObject({ code: 'inventory_closed' });
  });
  it('停止中の枠を個別に戻すと当日受付の席数を保つ', async () => {
    const url = '/api/restaurant-test/inventory/allocation?account_id=account-1';
    const startsAt = '2099-10-10T08:30:00.000Z';
    testDb.raw.prepare(`INSERT INTO rt_inventory_slots
      (id,store_id,starts_at,total_capacity,ota_capacity,line_capacity,walk_in_capacity,same_day_capacity)
      VALUES('legacy','store-ginza',?,4,0,0,0,1)`).run(startsAt);
    const put = (payload: Record<string, unknown>) => requestWithMethod(url, 'PUT', { storeId:'store-ginza', ...payload });
    const readSlot = () => testDb.raw.prepare('SELECT line_capacity, same_day_capacity FROM rt_inventory_slots WHERE id=\'legacy\'').get();
    expect((await put({scope:'standard',expectedVersion:0,allocation:alloc})).status).toBe(200);
    expect(readSlot()).toEqual({line_capacity:0,same_day_capacity:1});
    expect((await put({scope:'slot',expectedVersion:1,startsAt,allocation:null})).status).toBe(200);
    expect(readSlot()).toEqual({line_capacity:1,same_day_capacity:1});
    expect((await put({scope:'standard',expectedVersion:2,allocation:{...alloc,otaCapacity:0,lineCapacity:2}})).status).toBe(200);
    expect(readSlot()).toEqual({line_capacity:2,same_day_capacity:1});
  });
});
