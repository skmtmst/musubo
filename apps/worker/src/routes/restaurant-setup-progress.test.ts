import { afterEach, beforeEach, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../worker-env.js';
import type { AuthenticatedStaff } from '../middleware/auth/principal/auth.js';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';
import { seedRestaurantFixture } from '../test-utils/restaurant-fixture.js';
import { restaurantTest } from './restaurant-test.js';
import { tzDateStr } from '../services/availability.js';
import { restaurantCivilTime } from '../services/restaurant-booking.js';
import { saveInventoryAllocation } from '../services/restaurant-inventory-allocation.js';

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
const request = (store = 'store-ginza', query = '', account = store === 'store-yokohama' ? 'account-3' : 'account-2') => {
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
function googleHours(store = 'store-ginza', weekdays = ['MONDAY']) {
  const location = `accounts/111/locations/${store}`;
  const weekly = Object.fromEntries(['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY']
    .map(day => [day, weekdays.includes(day) ? [{ open: '09:00', close: '18:00' }] : []]));
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
it('同じ店舗の必須項目がそろった下書きもコース登録済みとして読む', async () => {
  expect(await progress()).toMatchObject({ menus: true, courseRegistered: true });
  database.raw.exec(`
    UPDATE rt_menu_items SET status='archived', duration_minutes=90 WHERE id='menu-ginza';
    INSERT INTO rt_menu_items(id,store_id,kind,name,price,duration_minutes,status) VALUES
      ('legacy-draft','store-ginza','course','以前の下書き',8800,NULL,'draft'),
      ('invalid-draft','store-ginza','course','範囲外の所要時間',8800,10,'draft'),
      ('single-draft','store-ginza','a_la_carte','単品の下書き',1000,90,'draft'),
      ('other-store-draft','store-yokohama','course','横浜のコース',8800,90,'draft');
  `);
  expect(await progress()).toMatchObject({ menus: false, courseRegistered: false });
  expect(await progress('store-yokohama')).toMatchObject({ menus: false, courseRegistered: true });

  database.raw.exec(`INSERT INTO rt_menu_items(id,store_id,kind,name,price,duration_minutes,status)
    VALUES('saved-course','store-ginza','course','登録したコース',0,150,'draft')`);
  expect(await progress()).toMatchObject({ menus: false, courseRegistered: true });
  expect(database.raw.prepare('SELECT status FROM rt_menu_items WHERE id=?').get('saved-course')).toEqual({ status: 'draft' });
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
  expect((await request()).status).toBe(403);
  expect((await request('store-ginza', '', 'account-1')).status).toBe(404);
  staff = { id: 'read-only', name: '閲覧', role: 'staff', readOnly: true };
  expect((await request()).status).toBe(200);
});

it('店に絞られたアカウントから同じ統括の別店舗を読ませない', async () => {
 expect((await request('store-yokohama', '', 'account-2')).status).toBe(404);
 expect((await request('store-ginza', '', 'account-2')).status).toBe(200);
 expect((await request('store-ginza', '', 'account-1')).status).toBe(404);
});

it('受付設定を残しながら現在の予約リンク、公開ボタン、空き枠を別に確認する', async () => {
  hours();
  googleHours();
  const now = new Date();
  const nextMonday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + ((8 - now.getUTCDay()) % 7 || 7)));
  database.raw.prepare('INSERT INTO rt_inventory_slots(id,store_id,starts_at,total_capacity,line_capacity) VALUES(?,?,?,?,?)')
    .run('future-slot', 'store-ginza', nextMonday.toISOString(), 4, 4);
  expect(await progress()).toMatchObject({ reception: true, bookingExposure: {
    reservationLink: false, publicReservationMenu: false, availableCapacity: false,
  } });

  database.raw.exec(`INSERT INTO rt_reservation_links(store_id,token) VALUES ('store-ginza','current-token');
    INSERT INTO rich_menu_groups(id,account_id,name,chat_bar_text,size,status,default_page_id,is_default_for_all)
    VALUES ('menu','account-2','案内','開く','large','published','menu-page',0);
    INSERT INTO rich_menu_pages(id,group_id,order_index,name,alias_id,line_richmenu_id)
    VALUES ('menu-page','menu',0,'案内','menu-alias','line-menu-id');
    INSERT INTO rich_menu_areas(id,page_id,bounds_x,bounds_y,bounds_width,bounds_height,action_type,action_data)
    VALUES ('booking','menu-page',0,0,100,100,'uri','https://liff.line.me/store-liff?page=restaurant&token=current-token')`);
  expect(await progress()).toMatchObject({ bookingExposure: { reservationLink: true, publicReservationMenu: false } });

  database.raw.exec(`UPDATE rich_menu_groups SET is_default_for_all=1 WHERE id='menu';
    UPDATE rich_menu_areas SET action_data='https://liff.line.me/store-liff?page=restaurant&token=old-token' WHERE id='booking'`);
  expect(await progress()).toMatchObject({ bookingExposure: { publicReservationMenu: false } });

  database.raw.exec(`UPDATE rich_menu_areas SET action_data='https://liff.line.me/store-liff?token=current-token&page=restaurant' WHERE id='booking'`);
  expect(await progress()).toMatchObject({ bookingExposure: { publicReservationMenu: true, availableCapacity: true } });

  database.raw.exec(`UPDATE rt_inventory_slots SET line_capacity=0,auto_line_original=4 WHERE id='future-slot'`);
  expect(await progress()).toMatchObject({ reception: true, bookingExposure: { publicReservationMenu: true, availableCapacity: false } });
});

it('基本配分で受付設定を判定し、休業の翌営業日も空き枠を調べる', async () => {
  const timezone = 'Asia/Tokyo';
  const store = 'store-ginza';
  const now = new Date();
  const today = tzDateStr(timezone, now);
  const tomorrow = tzDateStr(timezone, new Date(now.getTime() + 86_400_000));
  const periods = [today, tomorrow].map(date => ({
    startsAt: restaurantCivilTime(date, 0, timezone),
    endsAt: restaurantCivilTime(date, 1440, timezone),
  }));
  hours();
  googleHours(store, ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY']);
  database.raw.prepare(`INSERT INTO rt_closures
    (id,store_id,start_date,end_date,all_day,kind,table_ids_json,periods_json) VALUES('closed',?,?,?,1,'temporary_closed','[]',?)`)
    .run(store, today, tomorrow, JSON.stringify(periods));
  database.raw.exec("INSERT INTO rt_reservation_links(store_id,token) VALUES ('store-ginza','current-token')");
  expect(await progress()).toMatchObject({ reception: false });
  await saveInventoryAllocation(database.db, store, 'owner', 0, {
    scope: 'standard', allocation: { lineCapacity: 2, otaCapacity: 0, walkInCapacity: 0 },
  });
  expect(await progress()).toMatchObject({ reception: true, bookingExposure: { availableCapacity: true } });
  expect(database.raw.prepare('SELECT COUNT(*) AS n FROM rt_inventory_slots').get()).toEqual({ n: 0 });
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
