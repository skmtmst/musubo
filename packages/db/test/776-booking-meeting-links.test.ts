import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const migration = readFileSync(new URL('../migrations/776_booking_meeting_links.sql', import.meta.url), 'utf8');

it('776は既存の予約を保ち、会議の記録と一意な操作キーを保存する', () => {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys=ON');
    db.exec("CREATE TABLE bookings(id TEXT PRIMARY KEY, meeting_url_source TEXT CHECK(meeting_url_source IN ('staff','menu','manual'))); INSERT INTO bookings VALUES('b','staff')");
    db.exec(migration);
    expect(db.prepare('SELECT * FROM bookings').get()).toEqual({ id: 'b', meeting_url_source: 'staff' });
    const insert = db.prepare(`INSERT INTO booking_meeting_links
      (id,booking_id,provider,external_meeting_id,meeting_url,status,idempotency_key,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)`);
    insert.run('l', 'b', 'zoom', 'remote', 'https://example.test/meeting', 'active', 'key', 'now', 'now');
    expect(() => insert.run('l2', 'b', 'teams', 'remote', 'https://example.test/meeting', 'active', 'key', 'now', 'now')).toThrow(/UNIQUE/);
    expect(() => insert.run('l2', 'missing', 'teams', 'remote', 'https://example.test/meeting', 'active', 'other', 'now', 'now')).toThrow(/FOREIGN KEY/);
    expect(() => insert.run('l2', 'b', 'other', null, null, 'pending', 'other', 'now', 'now')).toThrow(/CHECK/);
    expect(() => insert.run('l2', 'b', 'teams', null, null, 'active', 'other', 'now', 'now')).toThrow(/CHECK/);
    expect(() => insert.run('l2', 'b', 'teams', 'other', 'https://example.test/other', 'active', 'other', 'now', 'now')).toThrow(/UNIQUE/);
    db.exec("INSERT INTO bookings VALUES('b2',NULL)");
    expect(() => insert.run('l2', 'b2', 'zoom', 'remote', 'https://example.test/other', 'active', 'other', 'now', 'now')).toThrow(/UNIQUE/);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.exec("DELETE FROM bookings WHERE id='b'");
    expect(db.prepare('SELECT COUNT(*) AS n FROM booking_meeting_links').get()).toEqual({ n: 0 });
  } finally { db.close(); }
});
