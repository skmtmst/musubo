import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';

it('757 は既存の引き継ぎを保ち、移動記録を友だちと引き継ぎの組で一意にする', () => {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys=ON');
    db.exec("CREATE TABLE account_handovers(id TEXT PRIMARY KEY); INSERT INTO account_handovers VALUES('old'),('new')");
    db.exec(readFileSync(new URL('../migrations/758_account_handover_moves.sql', import.meta.url), 'utf8'));
    expect(db.prepare('SELECT count(*) n FROM account_handovers').get()).toEqual({n:2});
    db.prepare('INSERT INTO account_handover_moves VALUES(?,?,?,?,?,?)').run('new','friend','source','target','tenant','now');
    expect(() => db.prepare('INSERT INTO account_handover_moves VALUES(?,?,?,?,?,?)').run('new','friend','source','target','tenant','later')).toThrow();
    expect(() => db.prepare('INSERT INTO account_handover_moves VALUES(?,?,?,?,?,?)').run('new','friend2','source','target',null,'now')).toThrow();
    expect(() => db.prepare('INSERT INTO account_handover_moves VALUES(?,?,?,?,?,?)').run('missing','friend','source','target','tenant','now')).toThrow();
  } finally { db.close(); }
});
