import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(fileURLToPath(new URL('../../../../packages/db/migrations/795_restaurant_reservation_allergies.sql', import.meta.url)), 'utf8');

describe('予約のアレルギーの保存', () => {
  it('既存の自由記述を維持し、旧形式の上書きと新形式の同時更新を区別する', () => {
    const db = new Database(':memory:');
    try {
      db.exec("CREATE TABLE rt_reservations(id TEXT PRIMARY KEY, allergy_note TEXT); INSERT INTO rt_reservations VALUES('r','卵、調味料');");
      db.exec(migration);
      expect(db.prepare('SELECT allergy_note, allergies_json FROM rt_reservations').get()).toEqual({ allergy_note:'卵、調味料', allergies_json:null });
      const first = JSON.stringify([{kind:'option',value:'卵'}]);
      db.prepare('UPDATE rt_reservations SET allergy_note=?, allergies_json=? WHERE id=?').run('卵',first,'r');
      expect(db.prepare('SELECT allergies_json FROM rt_reservations').get()).toEqual({allergies_json:first});
      db.prepare('UPDATE rt_reservations SET allergy_note=? WHERE id=?').run('乳','r');
      expect(db.prepare('SELECT allergy_note, allergies_json FROM rt_reservations').get()).toEqual({allergy_note:'乳',allergies_json:null});
    } finally { db.close(); }
  });
});
