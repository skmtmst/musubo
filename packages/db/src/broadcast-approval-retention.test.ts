import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';

const migrationDir = join(import.meta.dirname, '../migrations');
const preflight = readFileSync(join(import.meta.dirname, '../../../scripts/check-785-broadcast-approval-orphans.sql'), 'utf8');

function oldSchema(): Database.Database {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE broadcasts (id TEXT PRIMARY KEY)');
  db.exec(readFileSync(join(migrationDir, '455_broadcast_approval_events.sql'), 'utf8'));
  return db;
}

it('785 の事前点検は空の表では 0 件、孤児を含めるとその件数だけ数える', () => {
  const db = oldSchema();
  expect(db.prepare(preflight).get()).toEqual({ orphan_count: 0 });
  db.pragma('foreign_keys = OFF');
  db.exec("INSERT INTO broadcasts VALUES ('b1'); INSERT INTO broadcast_approval_events(id,broadcast_id,actor_staff_id,action) VALUES ('valid','b1','staff','approved'),('orphan','missing','staff','approved')");
  db.pragma('foreign_keys = ON');
  expect(db.prepare(preflight).get()).toEqual({ orphan_count: 1 });
  db.close();
});

it('孤児がある状態で 785 を実行すると、参照を NULL にせず外部キー違反で止まる', () => {
  const db = oldSchema();
  db.pragma('foreign_keys = OFF');
  db.exec("INSERT INTO broadcast_approval_events(id,broadcast_id,actor_staff_id,action) VALUES ('orphan','missing','staff','approved')");
  db.pragma('foreign_keys = ON');
  expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  expect(() => db.exec(readFileSync(join(migrationDir, '785_broadcast_approval_retention.sql'), 'utf8'))).toThrow(/FOREIGN KEY constraint failed/);
  expect(db.prepare('SELECT id,broadcast_id FROM broadcast_approval_events').all()).toEqual([{ id: 'orphan', broadcast_id: 'missing' }]);
  expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='broadcast_approval_events_new'").get()).toBeDefined();
  db.close();
});

it('トランザクション内の失敗はロールバックで一時表を残さない', () => {
  const db = oldSchema();
  db.pragma('foreign_keys = OFF');
  db.exec("INSERT INTO broadcast_approval_events(id,broadcast_id,actor_staff_id,action) VALUES ('orphan','missing','staff','approved')");
  db.pragma('foreign_keys = ON');
  db.exec('BEGIN');
  expect(() => db.exec(readFileSync(join(migrationDir, '785_broadcast_approval_retention.sql'), 'utf8'))).toThrow(/FOREIGN KEY constraint failed/);
  db.exec('ROLLBACK');
  expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='broadcast_approval_events_new'").get()).toBeUndefined();
  expect(db.prepare('SELECT id,broadcast_id FROM broadcast_approval_events').all()).toEqual([{ id: 'orphan', broadcast_id: 'missing' }]);
  db.close();
});

it('785 は既存の承認履歴を保ち、配信削除時は参照だけ外す', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec('CREATE TABLE broadcasts (id TEXT PRIMARY KEY)');
  db.exec(readFileSync(join(migrationDir, '455_broadcast_approval_events.sql'), 'utf8'));
  db.exec("INSERT INTO broadcasts VALUES ('b1'), ('b2'); INSERT INTO broadcast_approval_events(id,broadcast_id,actor_staff_id,action,reason,created_at) VALUES ('e1','b1','staff','approved','reason','2026-01-01'),('e2','b2','staff','rejected',NULL,'2026-01-02')");
  const beforeColumns = db.pragma('table_info(broadcast_approval_events)') as { name: string; type: string; notnull: number; dflt_value: unknown; pk: number }[];
  const beforeIndexes = db.pragma('index_list(broadcast_approval_events)');
  const beforeIndexDetails = db.pragma('index_xinfo(idx_broadcast_approval_events_broadcast)');
  const beforeForeignKeys = db.pragma('foreign_key_list(broadcast_approval_events)') as { on_delete: string }[];
  const beforeRows = db.prepare('SELECT * FROM broadcast_approval_events ORDER BY id').all();
  db.exec(readFileSync(join(migrationDir, '785_broadcast_approval_retention.sql'), 'utf8'));
  const afterColumns = db.pragma('table_info(broadcast_approval_events)') as typeof beforeColumns;
  expect(afterColumns).toEqual(beforeColumns.map(column => column.name === 'broadcast_id' ? { ...column, notnull: 0 } : column));
  expect(db.pragma('index_list(broadcast_approval_events)')).toEqual(beforeIndexes);
  expect(db.pragma('index_xinfo(idx_broadcast_approval_events_broadcast)')).toEqual(beforeIndexDetails);
  expect(db.pragma('index_info(idx_broadcast_approval_events_broadcast)')).toEqual([
    { seqno: 0, cid: 1, name: 'broadcast_id' }, { seqno: 1, cid: 5, name: 'created_at' },
  ]);
  expect(beforeForeignKeys).toMatchObject([{ table: 'broadcasts', from: 'broadcast_id', to: 'id', on_delete: 'CASCADE' }]);
  expect(db.pragma('foreign_key_list(broadcast_approval_events)')).toEqual(beforeForeignKeys.map(key => ({ ...key, on_delete: 'SET NULL' })));
  expect(db.prepare('SELECT * FROM broadcast_approval_events ORDER BY id').all()).toEqual(beforeRows);
  db.exec("DELETE FROM broadcasts WHERE id='b1'");
  expect(db.prepare('SELECT id,broadcast_id,actor_staff_id,action,reason,created_at FROM broadcast_approval_events ORDER BY id').all()).toEqual([
    { id: 'e1', broadcast_id: null, actor_staff_id: 'staff', action: 'approved', reason: 'reason', created_at: '2026-01-01' },
    { id: 'e2', broadcast_id: 'b2', actor_staff_id: 'staff', action: 'rejected', reason: null, created_at: '2026-01-02' },
  ]);
  expect(db.pragma('foreign_key_check')).toEqual([]);
  db.close();
});
