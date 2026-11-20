import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(fileURLToPath(new URL('../migrations/783_booking_assignment_method.sql', import.meta.url)), 'utf8');

describe('783 booking assignment method', () => {
  it('keeps existing bookings unknown and records only valid methods', () => {
    const db = new Database(':memory:');
    try {
      db.exec("CREATE TABLE bookings (id TEXT PRIMARY KEY, staff_id TEXT NOT NULL); INSERT INTO bookings VALUES ('old','s'), ('old2','t')");
      db.exec(migration);
      expect(db.prepare("SELECT id, staff_id, assignment_method, assignment_reviewed_at FROM bookings WHERE id LIKE 'old%' ORDER BY id").all()).toEqual([
        { id: 'old', staff_id: 's', assignment_method: 'unknown', assignment_reviewed_at: null },
        { id: 'old2', staff_id: 't', assignment_method: 'unknown', assignment_reviewed_at: null },
      ]);
      for (const method of ['designated', 'automatic', 'manual']) {
        db.prepare('INSERT INTO bookings (id,staff_id,assignment_method) VALUES (?,?,?)').run(method, 's', method);
      }
      db.prepare("UPDATE bookings SET assignment_reviewed_at='2026-01-01', staff_id='t' WHERE id='automatic'").run();
      expect(db.prepare("SELECT assignment_method, assignment_reviewed_at FROM bookings WHERE id='automatic'").get()).toEqual({ assignment_method: 'manual', assignment_reviewed_at: null });
      expect(() => db.prepare("INSERT INTO bookings (id,staff_id,assignment_method) VALUES ('bad','s','other')").run()).toThrow();
    } finally { db.close(); }
  });
});
