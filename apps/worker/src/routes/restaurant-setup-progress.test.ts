import { afterEach, beforeEach, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../worker-env.js';
import type { AuthenticatedStaff } from '../middleware/auth/principal/auth.js';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';
import { seedRestaurantFixture } from '../test-utils/restaurant-fixture.js';
import { restaurantTest } from './restaurant-test.js';

let database: SqliteD1;
let staff: AuthenticatedStaff;
beforeEach(() => {
  database = createTestD1();
  seedRestaurantFixture(database);
  database.raw.exec(`INSERT INTO line_accounts(id,name,channel_id,channel_secret,channel_access_token,liff_id)
    VALUES('account-1','管理','one','','',''),('account-2','店1','two','','','store-liff'),('account-3','店2','three','','','other-liff')`);
  staff = { id: 'env-owner', name: '試験', role: 'owner', readOnly: false };
});
afterEach(() => database.raw.close());
const request = (store = 'store-ginza', query = '', account = 'account-1') => {
  const app = new Hono<Env>();
  app.use('*', async (c, next) => { c.set('staff', { ...staff }); return next(); });
  app.route('/', restaurantTest);
  return app.request(`/api/restaurant-test/setup-progress?account_id=${account}&storeId=${store}${query}`, {},
    { DB: database.db, DEPLOY_ENV: 'test', RESTAURANT_TEST_ENABLED: 'true' } as Env['Bindings']);
};
async function progress(store?: string) {
  const response = await request(store);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  return (await response.json() as { data: Record<string, unknown> }).data;
}
function hours(store = 'store-ginza') {
  database.raw.prepare('INSERT INTO rt_opening_hours_settings(store_id,hours_json,updated_by) VALUES(?,?,?)')
    .run(store, JSON.stringify([{ weekday: 1, periods: [{ opensAt: '09:00', closesAt: '18:00' }] }]), 'owner');
}
function googleHours(store = 'store-ginza') {
  const location = `accounts/111/locations/${store}`;
  const weekly = Object.fromEntries(['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY']
    .map(day => [day, day === 'MONDAY' ? [{ open: '09:00', close: '18:00' }] : []]));
  database.raw.prepare(`INSERT INTO rt_google_connections
    (id,store_id,line_account_id,location_name,refresh_token_enc,status) VALUES(?,?,?,?,?,?)`)
    .run(`connection-${store}`, store, 'account-2', location, 'encrypted', 'connected');
  database.raw.prepare(`INSERT INTO rt_google_profiles
    (store_id,location_name,profile_json,fingerprint,fetched_at,updated_at) VALUES(?,?,?,?,?,?)`)
    .run(store, location, JSON.stringify({ profile: { name: `locations/${store}`, openStatus: 'OPEN', regularHours: weekly, specialHours: [] } }), 'fingerprint', '2026-11-10T00:00:00Z', '2026-11-10T00:00:00Z');
}
it('卓が無くても営業時間を独立に判定し、他店のメニューを混ぜない', async () => {
  database.raw.exec("UPDATE rt_tables SET is_active=0 WHERE store_id='store-ginza'; UPDATE rt_menu_items SET status='archived' WHERE store_id='store-ginza'");
  hours();
  expect(await progress()).toMatchObject({ hours: false, reception: false });
  googleHours();
  expect(await progress()).toMatchObject({ tables: false, hours: true, menus: false, reception: false, followup: false });
  expect(await progress('store-yokohama')).toMatchObject({ tables: false, hours: false, menus: false });
});
it('過去300件の後ろにある未来の設定も数え、満席の自動停止を未設定にしない', async () => {
  hours();
  googleHours();
  const insert = database.raw.prepare('INSERT INTO rt_inventory_slots(id,store_id,starts_at,total_capacity,line_capacity) VALUES(?,?,?,?,?)');
  for (let index = 0; index < 301; index++) insert.run(`old-${index}`, 'store-ginza', new Date(Date.UTC(2020, 0, 1, index)).toISOString(), 4, 4);
  insert.run('future', 'store-ginza', '2099-01-01T00:00:00Z', 4, 4);
  database.raw.exec("UPDATE rt_inventory_slots SET line_capacity=0,auto_line_original=4 WHERE id='future'");
  expect(await progress()).toMatchObject({ tables: true, hours: true, menus: true, reception: true });
  database.raw.exec("DELETE FROM rt_inventory_slots WHERE id='future'");
  expect(await progress()).toMatchObject({ reception: false });
});
it('前日通知を使わない答えで来店フォローを済みにしない', async () => {
  database.raw.exec(`INSERT INTO account_styles(line_account_id,style,updated_at,answers_json) VALUES('account-2','restaurant','2026-10-31T00:00:00Z','{"reminders":{"mode":"configured","value":false}}')`);
  expect(await progress()).toMatchObject({ followup: false });
  expect(database.raw.prepare('SELECT sending_status FROM rt_store_followup_templates WHERE store_id=?').get('store-ginza')).toMatchObject({ sending_status: 'stopped' });
});
it('別統括・見えない店舗・存在しない店舗を読ませず、閲覧のみのGETは保つ', async () => {
  expect((await request('missing')).status).toBe(404);
  expect((await request('store-ginza', '&tenant_id=outside')).status).toBe(403);
  staff = { ...staff, featureEnabledLineAccountIds: ['account-1', 'account-3'] };
  expect((await request()).status).toBe(404);
  staff = { id: 'read-only', name: '閲覧', role: 'staff', readOnly: true };
  expect((await request()).status).toBe(200);
});

it('店に絞られたアカウントから同じ統括の別店舗を読ませない', async () => {
 expect((await request('store-yokohama', '', 'account-2')).status).toBe(404);
 expect((await request('store-ginza', '', 'account-2')).status).toBe(200);
});

it('未確認・使わない保存・送り方オンの根拠を同じ店舗の初期設定へ返す', async () => {
  database.raw.exec('UPDATE rt_store_followup_step_bindings SET enabled=0; UPDATE rt_store_followup_targets SET enabled=0');
  expect(await progress()).toMatchObject({ followupSetup: { notUsing: false, decidedAt: null, version: 0, anyEnabled: false } });
  database.raw.exec(`INSERT INTO rt_store_followup_preferences(store_id,not_using,decided_at,decided_by)
    VALUES('store-ginza',1,'2026-10-31T00:00:00Z','owner')`);
  expect(await progress()).toMatchObject({ followupSetup: { notUsing: true, version: 1, anyEnabled: false } });
  expect(await progress('store-yokohama')).toMatchObject({ followupSetup: { notUsing: false, version: 0, anyEnabled: false } });
  database.raw.exec(`INSERT INTO automation_definitions(id,line_account_id,name) VALUES('setup-target','account-2','お礼');
    INSERT INTO rt_store_followup_targets(store_id,trigger,engine,automation_id,enabled)
    VALUES('store-ginza','post_visit','automation','setup-target',1)`);
  expect(await progress()).toMatchObject({ followupSetup: { notUsing: false, decidedAt: null, version: 2, anyEnabled: true } });
});

it('フォームの破損を他店へ混ぜず、最小項目で受付中の知らせと修復先を読み取りだけで返す',async()=>{
 database.raw.exec("UPDATE rt_stores SET line_account_id='account-2' WHERE id='store-ginza'");
 database.raw.exec("INSERT INTO account_settings(id,line_account_id,key,value) VALUES('broken-form','account-2','restaurant.reservation_form:store-ginza','{broken')");
 const before=database.raw.prepare('SELECT count(*) n FROM account_settings').get();
 expect((await progress()).reservationForm).toMatchObject({available:false,repairPath:'/restaurant-test/line-followup?store_id=store-ginza&repair_form=1'});
 expect(database.raw.prepare('SELECT count(*) n FROM account_settings').get()).toEqual(before);
});
