import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
const sql = (name:string) => readFileSync(new URL(`../migrations/${name}`,import.meta.url),'utf8');
it('予定変更と取消は既存会議を削除待ちにするが、メモ変更では維持する',()=>{
 const db=new Database(':memory:');
 try {
  db.pragma('foreign_keys=ON');
  db.exec(`CREATE TABLE bookings(id TEXT PRIMARY KEY,status TEXT,staff_id TEXT,starts_at TEXT,ends_at TEXT,note TEXT,meeting_mode TEXT,meeting_url TEXT,meeting_url_source TEXT);
   INSERT INTO bookings VALUES('b','confirmed','s','start','end','memo','online',NULL,NULL);`);
  db.exec(sql('776_booking_meeting_links.sql'));
  db.exec(`INSERT INTO booking_meeting_links(id,booking_id,provider,external_meeting_id,meeting_url,status,idempotency_key,created_at,updated_at)
   VALUES('l','b','zoom','remote','https://example.test','active','key','now','now')`);
  db.exec(sql('777_booking_meeting_lifecycle.sql'));
  expect(db.prepare('SELECT staff_id,starts_at,ends_at FROM booking_meeting_links').get()).toEqual({staff_id:'s',starts_at:'start',ends_at:'end'});
  db.exec("UPDATE bookings SET note='changed' WHERE id='b'");
  expect(db.prepare('SELECT status FROM booking_meeting_links').get()).toEqual({status:'active'});
  db.exec("UPDATE bookings SET starts_at='later' WHERE id='b'");
  expect(db.prepare('SELECT status FROM booking_meeting_links').get()).toEqual({status:'cancel_pending'});
  db.exec("UPDATE booking_meeting_links SET status='active'; UPDATE bookings SET status='cancelled' WHERE id='b'");
  expect(db.prepare('SELECT status FROM booking_meeting_links').get()).toEqual({status:'cancel_pending'});
  expect(db.pragma('foreign_key_check')).toEqual([]);
 } finally { db.close(); }
});
