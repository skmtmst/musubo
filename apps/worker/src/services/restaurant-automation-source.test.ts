import { afterEach, beforeEach, expect, it } from 'vitest';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';
import { readRestaurantAutomationSource } from './restaurant-automation-source.js';
import type { RestaurantEvent } from './restaurant-event-types.js';

let t:SqliteD1;
const now='2026-11-03T00:00:00Z';
beforeEach(()=>{
  t=createTestD1({ now: () => new Date(now) });
  t.raw.exec(`INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret) VALUES('a','a','店舗','t','s');
    INSERT INTO friends(id,line_account_id,line_user_id,display_name) VALUES('f','a','UID','友だち'),('g','a','OTHER','別の人');
    INSERT INTO rt_organizations(id,account_id,name) VALUES('org','a','組織');
    INSERT INTO rt_stores(id,organization_id,name,code,line_account_id,timezone) VALUES('store','org','食堂','S','a','Asia/Tokyo');
    INSERT INTO rt_reservations(id,store_id,source,customer_name,line_uid,guest_count,starts_at,ends_at,status)
    VALUES('r','store','line','友だち','UID',2,'2026-11-02T09:00:00Z','2026-11-02T11:00:00Z','confirmed');
    INSERT INTO rt_seat_visit_marks(id,reservation_id,store_id,kind,marked_at) VALUES('visit','r','store','visited','2026-11-02T10:00:00Z');
    UPDATE rt_reservations SET status='visited',departed_at='2026-11-02T11:30:00Z',customer_version=customer_version+1 WHERE id='r';`);
});
afterEach(()=>t.raw.close());
function event(){return t.raw.prepare("SELECT * FROM rt_reservation_events WHERE event_type='restaurant.departed'").get() as RestaurantEvent;}
function input(){const e=event();return {eventId:e.id,eventType:e.event_type,lineAccountId:'a',friendId:'f',now};}
it('保存済みの退店の出来事と本人と予約が現在も一致する時だけ通る',async()=>{
  const state=await readRestaurantAutomationSource(t.db,input());
  expect(state).toMatchObject({restaurant:true,allowed:true,context:{reservation_id:'r',guest_count:2}});
  if(state.restaurant&&state.allowed)expect(await t.db.prepare(`SELECT 1 WHERE ${state.guard.sql}`).bind(...state.guard.binds).first()).not.toBeNull();
});
it.each(['cancelled','no_show','departure_undone','changed'] as const)('待機中の取消・不来店・訂正・予約変更で元の送り方を止める: %s',async(kind)=>{
  const captured=input();
  if(kind==='departure_undone')t.raw.exec("UPDATE rt_reservations SET departed_at=NULL,customer_version=customer_version+1 WHERE id='r'");
  else if(kind==='changed')t.raw.exec("UPDATE rt_reservations SET guest_count=3,customer_version=customer_version+1 WHERE id='r'");
  else {t.raw.exec("UPDATE rt_reservations SET departed_at=NULL,customer_version=customer_version+1 WHERE id='r'");t.raw.prepare('UPDATE rt_reservations SET status=?,customer_version=customer_version+1 WHERE id=?').run(kind,'r');}
  expect(await readRestaurantAutomationSource(t.db,captured)).toEqual({restaurant:true,allowed:false});
});
it('送信準備を読んだ後に取消が確定しても、送信直前のSQLで止まる',async()=>{
  const state=await readRestaurantAutomationSource(t.db,input());
  t.raw.exec("UPDATE rt_reservations SET departed_at=NULL,customer_version=customer_version+1 WHERE id='r'; UPDATE rt_reservations SET status='cancelled',customer_version=customer_version+1 WHERE id='r'");
  if(state.restaurant&&state.allowed)expect(await t.db.prepare(`SELECT 1 WHERE ${state.guard.sql}`).bind(...state.guard.binds).first()).toBeNull();
  else throw new Error('先に有効な候補が必要');
});
it.each(['account','friend','type','missing'] as const)('別の出来事や別本人のIDを混ぜたら通らない: %s',async(kind)=>{
  const value=input();
  if(kind==='account')value.lineAccountId='other';
  if(kind==='friend')value.friendId='g';
  if(kind==='type')value.eventType='restaurant.arrived';
  if(kind==='missing')value.eventId='missing';
  expect(await readRestaurantAutomationSource(t.db,value)).toEqual({restaurant:true,allowed:false});
});
it('取消をきっかけにしたルールでは、その取消自体が現在の状態と合えば通る',async()=>{
  t.raw.exec("UPDATE rt_reservations SET departed_at=NULL,customer_version=customer_version+1 WHERE id='r'; UPDATE rt_reservations SET status='cancelled',customer_version=customer_version+1 WHERE id='r'");
  const e=t.raw.prepare("SELECT * FROM rt_reservation_events WHERE event_type='restaurant.reservation.cancelled'").get() as RestaurantEvent;
  expect(await readRestaurantAutomationSource(t.db,{...input(),eventId:e.id,eventType:e.event_type})).toMatchObject({restaurant:true,allowed:true});
});
it('飲食以外の出来事には予約の条件を付けない',async()=>{
  expect(await readRestaurantAutomationSource(t.db,{...input(),eventType:'friend_add',eventId:'ordinary'})).toEqual({restaurant:false,allowed:true});
});
it('キャンセル待ちは同じ招待・本人・有効期限だけを通す',async()=>{
  const startsAt=new Date(Date.parse(now)+2*24*60*60*1000).toISOString();
  const endsAt=new Date(Date.parse(startsAt)+60*60*1000).toISOString();
  t.raw.prepare(`INSERT INTO rt_seat_waitlist(id,store_id,starts_at,ends_at,guest_count,customer_name,line_uid,identity_key,status)
    VALUES('w','store',?,?,2,'友だち','UID','uid','waiting')`).run(startsAt,endsAt);
  t.raw.exec(`UPDATE rt_seat_waitlist SET status='invited',invited_at='2026-11-02T23:00:00Z',hold_expires_at='2026-11-03T00:10:00Z',notification_retry_key='invite' WHERE id='w'`);
  const e=t.raw.prepare("SELECT * FROM rt_reservation_events WHERE event_type='restaurant.waitlist.invited'").get() as RestaurantEvent;
  const value={...input(),eventId:e.id,eventType:e.event_type};
  expect(await readRestaurantAutomationSource(t.db,value)).toMatchObject({restaurant:true,allowed:true,waitlistId:'w'});
  expect(await readRestaurantAutomationSource(t.db,{...value,now:'2026-11-03T00:10:00Z'})).toEqual({restaurant:true,allowed:false});
  t.raw.exec("UPDATE rt_seat_waitlist SET notification_retry_key='another' WHERE id='w'");
  expect(await readRestaurantAutomationSource(t.db,value)).toEqual({restaurant:true,allowed:false});
});
