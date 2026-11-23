import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {Miniflare} from 'miniflare';
import {expect,it} from 'vitest';
import {acknowledgeRestaurantBookings,undoRestaurantBookingAcknowledgement} from './restaurant-booking-ack.js';
it('実D1のbatchで同じ一括操作は後着分を巻き込まず、取消も元の対象だけに効く',async()=>{
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',d1Databases:['DB']});
 try{
  const native=await mf.getD1Database('DB');const db=native as unknown as D1Database;
  const setup=["CREATE TABLE line_accounts(id TEXT PRIMARY KEY)","CREATE TABLE rt_stores(id TEXT PRIMARY KEY,line_account_id TEXT,timezone TEXT)","CREATE TABLE rt_reservations(id TEXT PRIMARY KEY,store_id TEXT,status TEXT,created_at TEXT)","INSERT INTO line_accounts VALUES('a')","INSERT INTO rt_stores VALUES('s','a','Asia/Tokyo')","INSERT INTO rt_reservations VALUES('r','s','confirmed','2026-11-01 00:00:00')"];
  await native.batch(setup.map(sql=>native.prepare(sql)));
  const migration=readFileSync(resolve(import.meta.dirname,'../../../../packages/db/migrations/794_restaurant_new_booking_ack.sql'),'utf8').split(/;\s*(?:\r?\n|$)/).map(s=>s.trim()).filter(Boolean);
  await native.batch(migration.map(sql=>native.prepare(sql)));
  const input={accountId:'a',storeId:'s',actorId:'owner',operationId:'00000000-0000-4000-8000-000000000001',bookingId:null,now:Date.parse('2026-11-01T03:00:00Z')};
  expect((await acknowledgeRestaurantBookings(db,input)).acknowledgedCount).toBe(1);
  await native.prepare("INSERT INTO rt_reservations VALUES('late','s','confirmed','2026-11-01 01:00:00')").run();
  expect(await acknowledgeRestaurantBookings(db,input)).toMatchObject({acknowledgedCount:1,replayed:true});
  expect((await undoRestaurantBookingAcknowledgement(db,input)).undoneCount).toBe(1);
  expect((await native.prepare('SELECT COUNT(*) n FROM restaurant_booking_acknowledgements').first<{n:number}>())?.n).toBe(0);
  expect((await native.prepare('SELECT COUNT(*) n FROM restaurant_booking_ack_operation_items WHERE operation_id=?').bind(input.operationId).first<{n:number}>())?.n).toBe(1);
  const first={...input,bookingId:'r',operationId:'00000000-0000-4000-8000-000000000002'};
  const second={...first,actorId:'other',operationId:'00000000-0000-4000-8000-000000000003'};
  await acknowledgeRestaurantBookings(db,first);await acknowledgeRestaurantBookings(db,second);
  expect((await undoRestaurantBookingAcknowledgement(db,first)).undoneCount).toBe(0);
  expect(await native.prepare('SELECT actor_id,operation_id FROM restaurant_booking_acknowledgements').first()).toEqual({actor_id:'other',operation_id:second.operationId});
 }finally{await mf.dispose();}
},30000);
