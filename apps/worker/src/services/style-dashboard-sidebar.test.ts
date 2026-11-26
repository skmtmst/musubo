import { expect, it } from 'vitest';
import { createStyleScheduleFixture } from '../test-utils/style-schedule-fixture.js';
import { styleRows } from './style-booking-rows.js';
import { styleDashboardSidebar } from './style-dashboard-sidebar.js';
import { eligible, instant, civilDate } from './style-analytics-core.js';
import type { StyleBooking } from '@line-crm/shared';

/** 元の1件ずつの読み方を比較用に残す。テナント境界と注意理由も比較する。 */
async function reference(db: D1Database, rows: StyleBooking[], now: number) {
 const today = civilDate(now, 'Asia/Tokyo');
 const out = [];
 for (const r of rows.filter(x => eligible(x) && x.status !== 'no_show' && x.kind === 'restaurant' && civilDate(instant(x.startsAt), 'Asia/Tokyo') === today)) {
  const d = await db.prepare('SELECT allergy_note allergy FROM rt_reservations WHERE id=? AND store_id IN(SELECT id FROM rt_stores WHERE line_account_id=?)').bind(r.id, 'a').first<{allergy: string | null}>();
  const fields = r.friendId ? (await db.prepare("SELECT k.fixed_key,COALESCE(v.value,v.value_text,v.value_date) value FROM friend_field_values v JOIN friend_fixed_fields k ON k.field_id=v.field_id JOIN friends f ON f.id=v.friend_id WHERE f.line_account_id=? AND f.id=? AND k.fixed_key IN('allergy','anniversary')").bind('a',r.friendId).all<{fixed_key: string; value: string | null}>()).results : [];
  const allergy = d?.allergy || fields.find(f => f.fixed_key === 'allergy')?.value || null;
  const anniversary = fields.find(f => f.fixed_key === 'anniversary')?.value;
  const noShowHistory = rows.some(p => p.personKey === r.personKey && p.status === 'no_show' && instant(p.startsAt) < instant(r.startsAt));
  const isAnniversary = !!anniversary && anniversary.slice(5,10) === today.slice(5);
  if (allergy || isAnniversary || noShowHistory) out.push({id:r.id,name:r.name,friendId:r.friendId,startsAt:r.startsAt,allergy,anniversary:isAnniversary,noShowHistory});
 }
 return out;
}

it('予約と友だちの情報を分割取得しても注意理由と権限境界を保つ', async () => {
 const f = createStyleScheduleFixture();
 try {
  const addFriend = f.raw.prepare('INSERT INTO friends(id,line_user_id,line_account_id,display_name) VALUES(?,?,?,?)');
  const addReservation = f.raw.prepare("INSERT INTO rt_reservations(id,store_id,source,customer_name,line_uid,guest_count,starts_at,ends_at,status,allergy_note) VALUES(?,'store','line','fixture',?,2,'2026-11-01T01:00:00Z','2026-11-01T02:00:00Z','confirmed',?)");
  const addField = f.raw.prepare("INSERT INTO friend_field_values(friend_id,field_id,value) VALUES(?,?,?)");
  f.raw.transaction(() => { for(let i=0;i<165;i++) {const id=`f${i}`, uid=`U${i}`;addFriend.run(id,uid,'a','fixture');addReservation.run(`r${i}`,uid,i%4===0?'予約側':null);if(i%3===0)addField.run(id,'fixed-allergy','友だち側');if(i%7===0)addField.run(id,'fixed-anniversary','2020-11-01');} })();
  f.raw.exec("INSERT INTO rt_reservations(id,store_id,source,customer_name,line_uid,guest_count,starts_at,ends_at,status) VALUES('past-no-show','store','line','fixture','U1',2,'2026-10-01T01:00:00Z','2026-10-01T02:00:00Z','no_show')");
  f.raw.exec(`INSERT INTO friends(id,line_user_id,line_account_id,display_name) VALUES('foreign-f','Uforeign','b','other');
    INSERT INTO friend_field_values(friend_id,field_id,value) VALUES('foreign-f','fixed-allergy','secret');
    INSERT INTO rt_reservations(id,store_id,source,customer_name,line_uid,guest_count,starts_at,ends_at,status,allergy_note) VALUES('foreign','foreign-store','line','other','Uforeign',2,'2026-11-01T01:00:00Z','2026-11-01T02:00:00Z','confirmed','secret');`);
  const rows = await styleRows(f.db,'a','restaurant',['restaurant']);
  // 不正に別アカウントのIDが紛れ込んでも詳細を返さない。
  rows.push({ ...rows.find(r => r.id === 'r0')!, id:'foreign', friendId:'foreign-f', personKey:'foreign-f' });
  const now = Date.parse('2026-11-01T01:30:00Z');
  const expected = await reference(f.db,rows,now);
  let detailQueries = 0, fieldQueries = 0;
  const db = new Proxy(f.db,{ get(target,key) { if(key==='prepare')return (sql:string) => {if(sql.includes('allergy_note allergy'))detailQueries++;if(sql.includes('friend_field_values'))fieldQueries++;return target.prepare(sql)};return Reflect.get(target,key,target) } });
  const actual = await styleDashboardSidebar(db,'a','restaurant',rows,'Asia/Tokyo',now,{});
  expect(actual.attention).toEqual(expected);
  expect(actual.attention).toEqual(expect.arrayContaining([expect.objectContaining({id:'r1',noShowHistory:true}),expect.objectContaining({id:'r0',allergy:'予約側',anniversary:true})]));
  expect(detailQueries).toBe(3);
  expect(fieldQueries).toBe(3);
  expect(actual.attention.every(x => x.id !== 'foreign')).toBe(true);
 } finally { f.raw.close(); }
});
