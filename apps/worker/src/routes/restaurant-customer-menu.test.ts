import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../worker-env.js';
import { applyDueRestaurantMenuPrices } from '../services/restaurant-booking.js';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';
import { restaurantCustomerBooking } from './restaurant-customer-booking.js';

const checks = vi.hoisted(() => ({
  feature: vi.fn(async () => true),
  media: vi.fn(async (): Promise<{ allowed: boolean }> => ({ allowed: true })),
}));

vi.mock('@line-crm/db', async original => ({
  ...(await original<typeof import('@line-crm/db')>()),
  isAccountFeatureEnabled: checks.feature,
}));

vi.mock('../services/file-scan.js', async original => ({
  ...(await original<typeof import('../services/file-scan.js')>()),
  checkMediaGate: checks.media,
}));

type MenuResponse = {
  data: {
    storeId: string;
    storeName: string;
    bookingUrl: string | null;
    items: Array<{ id: string; price: number; photos: Array<{ id: string; url: string; x: number; y: number }> }>;
  };
};

let sql: SqliteD1;
const menu = '/api/liff/restaurant/menu';
const bucket = {
  get: vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))),
};

function request(path: string, authorization = false) {
  const app = new Hono<Env>();
  app.route('/', restaurantCustomerBooking);
  return app.request(path, authorization ? { headers: { Authorization: 'Bearer verified-line' } } : {}, {
    DB: sql.db,
    IMAGES: bucket as unknown as R2Bucket,
    API_KEY: 'local test photo signing key',
    WORKER_PUBLIC_URL: 'https://fixture.example',
    DEPLOY_ENV: 'test',
    RESTAURANT_TEST_ENABLED: 'true',
  } as Env['Bindings']);
}

async function readMenu(selector = 'token=main-entry') {
  const result = await request(menu + '?' + selector + '&liffId=liff-one', true);
  expect(result.status).toBe(200);
  return (await result.json() as MenuResponse).data;
}

beforeEach(() => {
  vi.clearAllMocks();
  checks.feature.mockResolvedValue(true);
  checks.media.mockResolvedValue({ allowed: true });
  sql = createTestD1();
  sql.raw.exec(`
    INSERT INTO tenants(id,name) VALUES ('tenant-one','同行'),('tenant-two','別の契約先');
    INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret,login_channel_id,liff_id,tenant_id)
      VALUES ('line-one','1','店舗用','','','login-one','liff-one','tenant-one'),('line-two','2','別アカウント','','','login-two','liff-two','tenant-two');
    INSERT INTO friends(id,line_user_id,line_account_id,display_name) VALUES ('friend','Ufixture','line-one','本人');
    INSERT INTO rt_organizations(id,account_id,name) VALUES ('org-one','line-one','飲食店'),('org-two','line-two','別契約');
    INSERT INTO rt_stores(id,organization_id,name,code,line_account_id)
      VALUES ('main','org-one','渋谷店','main','line-one'),('branch','org-one','支店','branch',NULL),
      ('foreign','org-two','別アカウント店','foreign','line-two');
    INSERT INTO rt_reservation_links(store_id,token) VALUES ('main','main-entry'),('foreign','foreign-entry');
    INSERT INTO media(id,line_account_id,kind,filename,mime_type,size_bytes,r2_key)
      VALUES ('p1','line-one','image','first.jpg','image/jpeg',3,'media/first.jpg'),
        ('p2','line-one','image','second.jpg','image/jpeg',3,'media/second.jpg'),
        ('p-foreign','line-two','image','private.jpg','image/jpeg',3,'media/private.jpg');
    INSERT INTO rt_menu_items(id,store_id,name,kind,price,status,description,duration_minutes,service_periods_json,image_media_id,photo_gallery_json)
      VALUES ('course','main','季節のコース','course',8800,'active','旬の前菜',120,'["dinner"]','p2',
      '[{"mediaId":"p2","x":71,"y":20},{"mediaId":"p-foreign","x":50,"y":50},{"mediaId":"p1","x":31,"y":90}]');
    INSERT INTO rt_menu_items(id,store_id,name,kind,price,status,image_media_id)
      VALUES ('single','main','単品','a_la_carte',680,'active','p1'),('draft','main','下書き','course',9900,'draft','p1'),
      ('archived','main','非公開','course',7700,'archived',NULL),('foreign-item','foreign','別アカウント','course',1,'active',NULL);
    INSERT INTO rt_approval_requests(id,organization_id,store_id,kind,title,status)
      VALUES ('approval','org-one','main','menu_change','価格変更申請','pending');
    INSERT INTO rt_menu_change_requests(id,approval_id,menu_id,store_id,before_price,after_price,requested_by,effective_at)
      VALUES ('price-change','approval','course','main',8800,10000,'operator','2100-05-01T09:00:00Z');
  `);
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({
    sub: 'Ufixture', aud: 'login-one', exp: Math.floor(Date.now() / 1000) + 900,
  })));
});

afterEach(() => {
  sql.raw.close();
  vi.unstubAllGlobals();
});

describe('お客さま用の料理メニュー', () => {
  it('同店舗の公開中の料理、適用済み価格、登録順の写真を返す', async () => {
    const data = await readMenu();
    expect(data.storeName).toBe('渋谷店');
    expect(data.bookingUrl).toBeNull();
    expect(data.items).toMatchObject([
      { id: 'course', kind: 'course', name: '季節のコース', price: 8800, description: '旬の前菜',
        durationMinutes: 120, servicePeriods: ['dinner'], photos: [{ id: 'p2', x: 71, y: 20 }, { id: 'p1', x: 31, y: 90 }] },
      { id: 'single', kind: 'a_la_carte', durationMinutes: null, photos: [{ id: 'p1', x: 50, y: 50 }] },
    ]);
    const urls = data.items[0]!.photos.map(photo => new URL(photo.url));
    expect(urls.map(url => url.pathname.split('/').at(-1))).toEqual(['p2', 'p1']);
    expect(urls[0]?.origin).toBe('https://fixture.example');
    expect(urls[0]?.searchParams.has('signature')).toBe(true);
    sql.raw.exec("UPDATE rt_approval_requests SET status='approved' WHERE id='approval'");
    expect((await readMenu()).items[0]?.price).toBe(8800);
    sql.raw.exec("UPDATE rt_menu_change_requests SET effective_at='2000-01-01T00:00:00Z' WHERE id='price-change'");
    await applyDueRestaurantMenuPrices(sql.db, 'org-one', 'main');
    expect((await readMenu()).items[0]?.price).toBe(10000);
  });

  it('同じアカウントの店舗指定は予約リンクがなくても開き、別アカウントは返さない', async () => {
    sql.raw.exec("DELETE FROM rt_reservation_links WHERE store_id='main'");
    expect(await readMenu('storeId=main')).toMatchObject({ storeId: 'main', storeName: '渋谷店', bookingUrl: null });
    expect((await request(menu + '?storeId=branch&liffId=liff-one', true)).status).toBe(404);
    expect((await request(menu + '?token=foreign-entry&liffId=liff-one', true)).status).toBe(404);
    expect((await request(menu + '?storeId=foreign&liffId=liff-one', true)).status).toBe(404);
    expect((await request(menu + '?storeId=main&token=main-entry&liffId=liff-one', true)).status).toBe(404);
    expect((await request(menu + '?token=main-entry&liffId=liff-one')).status).toBe(401);
  });

  it('予約の受付設定に合わせて、予約ボタンの行き先だけを切り替える', async () => {
    sql.raw.exec(`
      INSERT INTO rt_tables(id,store_id,code,label,seat_type,max_capacity) VALUES ('table','main','1','卓','table',4);
      INSERT INTO rt_opening_hours_settings(store_id,hours_json,updated_by)
      VALUES ('main','[{"weekday":0,"periods":[{"opensAt":"12:00","closesAt":"16:00"}]}]','staff');
      INSERT INTO account_settings(id,line_account_id,key,value) VALUES ('allocation','line-one','restaurant.inventory_allocation:main',
      '{"version":1,"standard":{"otaCapacity":0,"lineCapacity":4,"walkInCapacity":0},"days":{},"slots":{}}');
    `);
    expect((await readMenu()).bookingUrl).toBe('https://liff.line.me/liff-one?page=restaurant&token=main-entry');
    sql.raw.exec("UPDATE rt_opening_hours_settings SET hours_json=json_set(hours_json,'$[0].periods[0].closesAt','12:00') WHERE store_id='main'");
    expect((await readMenu()).bookingUrl).toBeNull();
    sql.raw.exec("UPDATE rt_opening_hours_settings SET hours_json=json_set(hours_json,'$[0].periods[0].closesAt','16:00') WHERE store_id='main'");
    sql.raw.exec("UPDATE account_settings SET value=json_set(value,'$.standard.lineCapacity',0) WHERE id='allocation'");
    expect(await readMenu()).toMatchObject({ bookingUrl: null, items: [{ id: 'course' }, { id: 'single' }] });
  });

  it('署名付き写真だけを検査済みのメディアから配信し、別の品や写真に転用できない', async () => {
    const photo = new URL((await readMenu()).items[0]!.photos[1]!.url);
    const ok = await request(photo.href);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('Content-Type')).toBe('image/jpeg');
    expect(ok.headers.get('Cache-Control')).toBe('private, no-store');
    expect(new Uint8Array(await ok.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(bucket.get).toHaveBeenCalledExactlyOnceWith('media/first.jpg');
    const other = new URL(photo.href);
    other.pathname = other.pathname.replace('/course/', '/single/');
    expect((await request(other.href)).status).toBe(404);
    other.pathname = photo.pathname;
    other.searchParams.set('expires', '1000000000');
    expect((await request(other.href)).status).toBe(404);
    expect((await request(photo.origin + photo.pathname)).status).toBe(404);
    expect(bucket.get).toHaveBeenCalledTimes(1);
  });

  it('取り外し・非公開・検査の保留があれば、発行済みURLからも写真を出さない', async () => {
    const data = await readMenu();
    const first = data.items[0]!.photos[0]!.url;
    checks.media.mockResolvedValueOnce({ allowed: false });
    expect((await request(first)).status).toBe(404);
    sql.raw.exec("UPDATE rt_menu_items SET image_media_id='p1',photo_gallery_json='[]' WHERE id='course'");
    expect((await request(first)).status).toBe(404);
    sql.raw.exec("UPDATE rt_menu_items SET status='draft' WHERE id='single'");
    expect((await request(data.items[1]!.photos[0]!.url)).status).toBe(404);
    expect(bucket.get).not.toHaveBeenCalled();
  });
});
