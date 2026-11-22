import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';

it('adds a durable marker without updating old reservations or firing update triggers', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`CREATE TABLE rt_reservations(id TEXT PRIMARY KEY, customer_name TEXT NOT NULL);
      CREATE TABLE update_count(n INTEGER NOT NULL);
      CREATE TRIGGER reservation_updated AFTER UPDATE ON rt_reservations BEGIN INSERT INTO update_count VALUES(1); END;
      INSERT INTO rt_reservations VALUES('old','削除済みのお客さま');`);
    db.exec(readFileSync(new URL('../migrations/791_restaurant_reservation_anonymized.sql', import.meta.url), 'utf8'));
    expect(db.prepare('SELECT id,customer_anonymized FROM rt_reservations').all()).toEqual([{ id: 'old', customer_anonymized: 0 }]);
    expect(db.prepare('SELECT count(*) n FROM update_count').get()).toEqual({ n: 0 });
    expect(() => db.prepare('UPDATE rt_reservations SET customer_anonymized=2').run()).toThrow();
  } finally { db.close(); }
});
