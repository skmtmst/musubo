import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';

it('785 は既存の承認履歴を保ち、配信削除時は参照だけ外す', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec('CREATE TABLE broadcasts (id TEXT PRIMARY KEY)');
  const migrationDir = join(import.meta.dirname, '../migrations');
  db.exec(readFileSync(join(migrationDir, '455_broadcast_approval_events.sql'), 'utf8'));
  db.exec("INSERT INTO broadcasts VALUES ('b1'), ('b2'); INSERT INTO broadcast_approval_events(id,broadcast_id,actor_staff_id,action,reason,created_at) VALUES ('e1','b1','staff','approved','reason','2026-01-01'),('e2','b2','staff','rejected',NULL,'2026-01-02')");
  db.exec(readFileSync(join(migrationDir, '785_broadcast_approval_retention.sql'), 'utf8'));
  db.exec("DELETE FROM broadcasts WHERE id='b1'");
  expect(db.prepare('SELECT id,broadcast_id,actor_staff_id,action,reason,created_at FROM broadcast_approval_events ORDER BY id').all()).toEqual([
    { id: 'e1', broadcast_id: null, actor_staff_id: 'staff', action: 'approved', reason: 'reason', created_at: '2026-01-01' },
    { id: 'e2', broadcast_id: 'b2', actor_staff_id: 'staff', action: 'rejected', reason: null, created_at: '2026-01-02' },
  ]);
  expect(db.pragma('foreign_key_check')).toEqual([]);
  db.close();
});
