import { afterEach, beforeEach, expect, it } from 'vitest';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';
import { expandVariables } from './message-interpolation.js';
import { readRestaurantBookingContext, restaurantBookingVariables, substituteRestaurantBooking } from './restaurant-booking-context.js';

let t: SqliteD1;
beforeEach(() => {
  t = createTestD1();
  t.raw.exec(`INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret) VALUES('a','a','店','t','s'),('b','b','別','t','s');
    INSERT INTO friends(id,line_account_id,line_user_id,display_name) VALUES('f','a','musubo-scope:f:UID','友だち'),('g','a','OTHER','別の人'),('h','b','UID','他社');
    INSERT INTO rt_organizations(id,account_id,name) VALUES('org','a','組織');
    INSERT INTO rt_stores(id,organization_id,name,code,line_account_id,timezone) VALUES('store','org','食堂','S','a','Asia/Tokyo');
    INSERT INTO rt_reservations(id,store_id,source,customer_name,line_uid,guest_count,starts_at,ends_at,status)
    VALUES('r1','store','line','友だち','UID',2,'2026-11-01T09:00:00Z','2026-11-01T11:00:00Z','confirmed'),
          ('r2','store','line','友だち','UID',4,'2026-11-02T10:00:00Z','2026-11-02T12:00:00Z','confirmed');`);
});
afterEach(() => t.raw.close());

it('同じ人の予約が複数あっても指定された予約番号から日時・人数・店名を差し込む',async()=>{
  const context=await readRestaurantBookingContext(t.db,{reservationId:'r2',lineAccountId:'a',friendId:'f'});
  expect(context?.reservation_id).toBe('r2');
  const text=expandVariables(substituteRestaurantBooking('{{reservation_datetime}} / {{var.guest_count}}名 / {{var.store_name}} / {{meet_url}}',context!),{id:'f',display_name:'友だち',user_id:'UID'},undefined,'text',{vars:restaurantBookingVariables(context!)});
  expect(text).toContain('19:00');
  expect(text).toContain('4名 / 食堂 / ');
  expect(text).not.toContain('18:00');
});
it.each([['b','f'],['a','g'],['a','h']])('別アカウント・別本人の予約番号では取得しない: %s %s',async(lineAccountId,friendId)=>{
  expect(await readRestaurantBookingContext(t.db,{reservationId:'r1',lineAccountId,friendId})).toBeNull();
});
it('店の時刻帯に合わせて日時を差し込み、客のほかの予約へ逃げない',async()=>{
  t.raw.exec("UPDATE rt_stores SET timezone='America/New_York'");
  const context=await readRestaurantBookingContext(t.db,{reservationId:'r1',lineAccountId:'a',friendId:'f'});
  expect(substituteRestaurantBooking('{{reservation_datetime}}',context!)).toContain('04:00');
  expect(await readRestaurantBookingContext(t.db,{reservationId:'missing',lineAccountId:'a',friendId:'f'})).toBeNull();
});

it('店名の引用符・改行や差し込みに似た文字列を、共通のJSON展開で安全に扱う',async()=>{
  const name='食堂\"本店\"\n{{name}}';
  t.raw.prepare('UPDATE rt_stores SET name=?').run(name);
  const context=await readRestaurantBookingContext(t.db,{reservationId:'r1',lineAccountId:'a',friendId:'f'});
  const content=expandVariables('{"type":"text","text":"{{var.store_name}}"}',{id:'f',display_name:'友だち',user_id:'UID'},undefined,'flex',{vars:restaurantBookingVariables(context!)});
  expect(JSON.parse(content).text).toBe(name);
});
