import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';

it('既存の成果の承認状態・金額・日時を変えず版1を追加する', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`CREATE TABLE conversion_events (id TEXT PRIMARY KEY, approval_status TEXT, approved_at TEXT, value_snapshot REAL);
      INSERT INTO conversion_events VALUES ('a','approved','2026-01-02',123.45), ('b',NULL,NULL,NULL);`);
    db.exec(readFileSync(new URL('../migrations/761_conversion_approval_revision.sql', import.meta.url), 'utf8'));
    expect(db.prepare('SELECT * FROM conversion_events ORDER BY id').all()).toEqual([
      {id:'a',approval_status:'approved',approved_at:'2026-01-02',value_snapshot:123.45,approval_revision:1},
      {id:'b',approval_status:null,approved_at:null,value_snapshot:null,approval_revision:1},
    ]);
    db.exec("INSERT INTO conversion_events(id) VALUES('c')");
    expect(db.prepare("SELECT approval_revision FROM conversion_events WHERE id='c'").get()).toEqual({approval_revision:1});
  } finally { db.close(); }
});
