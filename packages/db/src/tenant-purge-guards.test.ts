import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { beforeAll, describe, expect, it } from 'vitest';
import { RETENTION_TABLES } from './data-retention-tables.js';

const migration = readFileSync(join(import.meta.dirname, '../migrations/760_tenant_purge_delete_guards.sql'), 'utf8');
const entries = [...migration.matchAll(/g\.table_name = '([^']+)'/g)].map((m) => m[1]);
let schema: Database.Database;
beforeAll(() => {
  schema = new Database(':memory:');
  schema.exec(readFileSync(join(import.meta.dirname, '../bootstrap.sql'), 'utf8'));
});

describe('契約終了時の削除トリガー', () => {
  it('21表を対象にする', () => expect(new Set(entries).size).toBe(21));
  it.each(entries)('%s: 通常は拒否し、同じ統括・表の削除中だけ通す', (table) => {
    // 実際に生成された trigger を、関係する列だけの小さな SQLite に移して検査する。
    // INSERT時の別の機能用制約は除き、DELETEの条件だけを各表で確実に発火させる。
    const db = new Database(':memory:');
    const made = new Set<string>();
    function create(name: string) {
      if (made.has(name)) return;
      const cols = schema.prepare(`PRAGMA table_info(${name})`).all() as { name: string }[];
      expect(cols.length).toBeGreaterThan(0);
      db.exec(`CREATE TABLE ${name} (${cols.map((c) => `"${c.name}" TEXT`).join(', ')})`);
      made.add(name);
    }
    create('tenants'); create('line_accounts'); create('tenant_purge_guard');
    db.prepare("INSERT INTO tenants (id, plan_status, data_purged_at) VALUES ('t1', 'canceled', NULL), ('t2', 'canceled', NULL), ('active', 'active', NULL)").run();
    db.prepare("INSERT INTO line_accounts (id, tenant_id) VALUES ('account-t1', 't1')").run();
    function seed(name: string): string {
      create(name);
      const scope = RETENTION_TABLES[name].scope!;
      const columns = schema.prepare(`PRAGMA table_info(${name})`).all() as { name: string }[];
      const values: Record<string, string> = { id: `${name}-id` };
      if (columns.some((c) => c.name === 'status')) values.status = 'published';
      if (scope.by === 'tenant') values[scope.column] = 't1';
      else if (scope.by === 'lineAccount') values[scope.column] = 'account-t1';
      else if (scope.by === 'parent') values[scope.column] = seed(scope.parent);
      else throw new Error(`unsupported scope: ${name}`);
      const keys = Object.keys(values).filter((key) => columns.some((c) => c.name === key));
      db.prepare(`INSERT INTO ${name} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map((k) => values[k]));
      return values.id;
    }
    seed(table);
    if (table === 'conversion_points') {
      create('conversion_events'); create('conversion_definition_usages');
      db.prepare("INSERT INTO conversion_events (conversion_point_id) VALUES ('conversion_points-id')").run();
    }
    const trigger = schema.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND tbl_name = ? AND sql LIKE '%tenant_purge_guard%'").get(table) as { sql: string };
    expect(trigger).toBeDefined();
    db.exec(trigger.sql);
    const remove = () => db.prepare(`DELETE FROM ${table}`).run();
    expect(remove).toThrow();
    db.prepare('INSERT INTO tenant_purge_guard (tenant_id, table_name) VALUES (?, ?)').run('t2', table);
    expect(remove).toThrow();
    db.prepare('DELETE FROM tenant_purge_guard').run();
    db.prepare('INSERT INTO tenant_purge_guard (tenant_id, table_name) VALUES (?, ?)').run('t1', 'other_table');
    expect(remove).toThrow();
    db.prepare('DELETE FROM tenant_purge_guard').run();
    db.prepare('INSERT INTO tenant_purge_guard (tenant_id, table_name) VALUES (?, ?)').run('t1', table);
    db.prepare("UPDATE tenants SET plan_status = 'active' WHERE id = 't1'").run();
    expect(remove).toThrow();
    db.prepare("UPDATE tenants SET plan_status = 'canceled' WHERE id = 't1'").run();
    expect(remove().changes).toBe(1);
    db.close();
  });
});
