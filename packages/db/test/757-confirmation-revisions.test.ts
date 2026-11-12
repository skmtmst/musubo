import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const tables = [
  'funnels', 'rt_menu_items', 'auto_replies', 'automation_definitions',
  'common_action_bindings', 'rt_google_posts', 'rt_google_connections',
  'rt_seat_waitlist', 'rt_tables', 'templates', 'traffic_pools',
  'account_handovers', 'friend_scenarios', 'scenarios', 'media_file_scans',
  'file_scan_configs', 'webhook_interaction_logs', 'booking_payments',
  'meet_consultations', 'rich_menu_groups', 'outgoing_webhooks', 'incoming_webhooks',
  'bookings', 'event_bookings', 'rt_reservations', 'account_settings',
] as const;
const revision = (table: string) => table === 'scenarios' ? 'content_revision' : 'confirmation_revision';
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
type Column = { name: string; type: string; notnull: number; dflt_value: string | null; pk: number; hidden: number };
type SchemaObject = { type: string; name: string; sql: string };

it('既存行を保ち、指定した版の列と購読の検索索引を追加する', () => {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys = OFF');
    db.pragma('ignore_check_constraints = ON');
    const bootstrap = readFileSync(new URL('../bootstrap.sql', import.meta.url), 'utf8');
    // 実スキーマの対象表だけを使い、数百の無関係な表とトリガーの構築を避ける。
    for (const table of [...tables, 'rt_menu_change_requests']) {
      const sql = bootstrap.match(new RegExp(`^CREATE TABLE\\s+(?:IF NOT EXISTS\\s+)?["\\x60\\[]?${table}["\\x60\\]]?\\s*\\([\\s\\S]*?;(?=\\s*\\n\\s*\\n|\\s*$)`, 'm'))?.[0];
      if (!sql) throw new Error(`テーブル定義が見つかりません: ${table}`);
      db.exec(sql);
    }
    const fixtureTables = new Set<string>([...tables, 'rt_menu_change_requests']);
    for (const match of bootstrap.matchAll(/^CREATE (?:UNIQUE )?INDEX\s+[^\s]+\s+ON\s+["`\[]?(\w+)["`\]]?\s*\([\s\S]*?;(?=\s*\n\s*\n|\s*$)/gm)) {
      if (fixtureTables.has(match[1])) db.exec(match[0]);
    }
    for (const name of ['rt_menu_change_apply', 'rt_menu_published_insert', 'rt_menu_published_update']) {
      const sql = bootstrap.split('\n').find((line) => line.startsWith(`CREATE TRIGGER ${name} `));
      if (!sql) throw new Error(`トリガーが見つかりません: ${name}`);
      db.exec(sql);
    }
    db.exec('CREATE TABLE untouched_fixture (id INTEGER PRIMARY KEY, value TEXT); CREATE INDEX untouched_fixture_value ON untouched_fixture(value); CREATE TRIGGER untouched_fixture_trigger AFTER INSERT ON untouched_fixture BEGIN UPDATE untouched_fixture SET value = NEW.value WHERE id = NEW.id; END;');
    db.exec('DROP INDEX idx_friend_scenarios_scenario_status');
    const originalTriggers = [
      ['rt_menu_change_apply', '569_restaurant_booking_policy.sql'],
    ] as const;
    for (const [name, file] of originalTriggers) {
      db.exec(`DROP TRIGGER ${quote(name)}`);
      const sql = readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8')
        .split('\n').find((line) => line.startsWith(`CREATE TRIGGER ${name} `));
      if (!sql) throw new Error(`元のトリガーが見つかりません: ${name}`);
      db.exec(sql);
    }
    // 最新 bootstrap から対象列を外し、直前の実スキーマを再現する。
    for (const table of tables) db.exec(`ALTER TABLE ${quote(table)} DROP COLUMN ${quote(revision(table))}`);
    const triggers = db.prepare("SELECT type, name, sql FROM sqlite_master WHERE type = 'trigger' AND sql IS NOT NULL").all() as SchemaObject[];
    // 既存行の準備中だけトリガーを外し、その後元どおりに戻す。
    for (const trigger of triggers) db.exec(`DROP TRIGGER ${quote(trigger.name)}`);
    const beforeRows = new Map<string, unknown[]>();
    const beforeColumns = new Map<string, Column[]>();
    for (const table of tables) {
      const columns = db.pragma(`table_xinfo(${quote(table)})`) as Column[];
      beforeColumns.set(table, columns);
      const writable = columns.filter((column) => column.hidden === 0);
      const values = writable.map((column) => /INT|REAL|NUMERIC|DECIMAL/i.test(column.type) ? 1 : 'null');
      db.prepare(`INSERT INTO ${quote(table)} (${writable.map((c) => quote(c.name)).join(', ')}) VALUES (${writable.map(() => '?').join(', ')})`).run(...values);
      beforeRows.set(table, db.prepare(`SELECT * FROM ${quote(table)}`).all());
    }
    for (const trigger of triggers) db.exec(trigger.sql);
    const otherObjects = () => db.prepare("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND type != 'table' ORDER BY type, name").all();
    const beforeOtherObjects = otherObjects();
    const otherTables = () => db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name").all().filter((row) => !tables.includes((row as { name: typeof tables[number] }).name));
    const beforeOtherTables = otherTables();
    db.exec(readFileSync(new URL('../migrations/757_confirmation_revisions.sql', import.meta.url), 'utf8'));
    expect(otherTables()).toEqual(beforeOtherTables);
    const afterOtherObjects = otherObjects() as SchemaObject[];
    const addedIndex = afterOtherObjects.filter((object) => object.name === 'idx_friend_scenarios_scenario_status');
    expect(addedIndex).toHaveLength(1);
    expect(addedIndex[0].type).toBe('index');
    expect(db.pragma('index_info(idx_friend_scenarios_scenario_status)')).toMatchObject([{ name: 'scenario_id' }, { name: 'status' }]);
    const changedNames = originalTriggers.map(([name]) => name as string);
    const unrelated = (objects: SchemaObject[]) => objects.filter((object) => object.name !== 'idx_friend_scenarios_scenario_status' && !changedNames.includes(object.name));
    expect(unrelated(afterOtherObjects)).toEqual(unrelated(beforeOtherObjects as SchemaObject[]));
    for (const [name] of originalTriggers) {
      const previous = (beforeOtherObjects as SchemaObject[]).find((object) => object.name === name)!;
      const current = afterOtherObjects.find((object) => object.name === name)!;
      const restored = current.sql.replace(/,\s*confirmation_revision\s*=\s*confirmation_revision\s*\+\s*1/i, '');
      expect(restored).toBe(previous.sql);
    }
    const plan = db.prepare("EXPLAIN QUERY PLAN SELECT id FROM friend_scenarios WHERE scenario_id = ? AND status = ?").all('scenario', 'active');
    expect(plan).toEqual(expect.arrayContaining([expect.objectContaining({ detail: expect.stringContaining('idx_friend_scenarios_scenario_status') })]));
    for (const table of tables) {
      const columns = db.pragma(`table_xinfo(${quote(table)})`) as Column[];
      const added = columns.find((column) => column.name === revision(table));
      expect(added).toMatchObject({ type: 'INTEGER', notnull: 1, dflt_value: '1', pk: 0, hidden: 0 });
      expect(columns.filter((column) => column.name !== revision(table))).toEqual(beforeColumns.get(table));
      const oldNames = beforeColumns.get(table)!.filter((column) => column.hidden === 0).map((column) => quote(column.name));
      expect(db.prepare(`SELECT ${oldNames.join(', ')} FROM ${quote(table)}`).all()).toEqual(beforeRows.get(table));
      expect(db.prepare(`SELECT ${quote(revision(table))} AS revision FROM ${quote(table)}`).all()).toEqual([{ revision: 1 }]);
    }
    db.exec(`INSERT INTO rt_menu_items(id, store_id, kind, name, price, status) VALUES ('menu-new','store-new','course','新',1000,'active');`);
    expect(db.prepare("SELECT price, published_once, confirmation_revision FROM rt_menu_items WHERE id='menu-new'").get()).toEqual({ price: 1000, published_once: 1, confirmation_revision: 1 });
    db.exec("UPDATE rt_menu_items SET status='active' WHERE id='menu-new'");
    expect(db.prepare("SELECT published_once, confirmation_revision FROM rt_menu_items WHERE id='menu-new'").get()).toEqual({ published_once: 1, confirmation_revision: 1 });
    db.exec("UPDATE rt_menu_items SET status='active', confirmation_revision=confirmation_revision+1 WHERE id='menu-new'");
    expect(db.prepare("SELECT confirmation_revision FROM rt_menu_items WHERE id='menu-new'").get()).toEqual({ confirmation_revision: 2 });
    db.exec(`INSERT INTO rt_menu_change_requests(id,approval_id,menu_id,store_id,before_price,after_price,requested_by,status) VALUES ('change-ok','approval-ok','menu-new','store-new',1000,1200,'staff','pending');
      UPDATE rt_menu_change_requests SET status='approved' WHERE id='change-ok';`);
    expect(db.prepare("SELECT price, confirmation_revision FROM rt_menu_items WHERE id='menu-new'").get()).toEqual({ price: 1200, confirmation_revision: 3 });
    expect(db.prepare("SELECT status, failure_reason FROM rt_menu_change_requests WHERE id='change-ok'").get()).toEqual({ status: 'applied', failure_reason: null });
    db.exec(`INSERT INTO rt_menu_change_requests(id,approval_id,menu_id,store_id,before_price,after_price,requested_by,status) VALUES ('change-old','approval-old','menu-new','store-new',1000,1500,'staff','pending');
      UPDATE rt_menu_change_requests SET status='approved' WHERE id='change-old';`);
    expect(db.prepare("SELECT price, confirmation_revision FROM rt_menu_items WHERE id='menu-new'").get()).toEqual({ price: 1200, confirmation_revision: 3 });
    expect(db.prepare("SELECT status FROM rt_menu_change_requests WHERE id='change-old'").get()).toEqual({ status: 'failed' });
    db.exec(`INSERT INTO rt_menu_change_requests(id,approval_id,menu_id,store_id,before_price,after_price,requested_by,status,effective_at) VALUES ('change-future','approval-future','menu-new','store-new',1200,1600,'staff','pending','2999-01-01');
      UPDATE rt_menu_change_requests SET status='approved' WHERE id='change-future';`);
    expect(db.prepare("SELECT price, confirmation_revision FROM rt_menu_items WHERE id='menu-new'").get()).toEqual({ price: 1200, confirmation_revision: 3 });
    expect(db.prepare("SELECT status FROM rt_menu_change_requests WHERE id='change-future'").get()).toEqual({ status: 'approved' });
  } finally {
    db.close();
  }
});
