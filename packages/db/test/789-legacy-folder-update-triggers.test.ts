import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const bootstrap = readFileSync(new URL('../bootstrap.sql', import.meta.url), 'utf8');
const previousMigration = readFileSync(new URL('../migrations/617_store_common_folders.sql', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../migrations/789_limit_legacy_folder_update_triggers.sql', import.meta.url), 'utf8');
const changedTriggers = ['folders_friend_add_rule_legacy_update', 'folders_mileage_reward_legacy_update'];

const starterInserts = [
  "INSERT INTO templates(id,line_account_id,name,message_type,message_content) VALUES('template','a','見本','text','本文')",
  "INSERT INTO scenarios(id,line_account_id,name,trigger_type) VALUES('scenario','a','見本','manual')",
  "INSERT OR IGNORE INTO friend_add_rules(id,line_account_id,friend_kind,name,priority,is_unknown_route_fallback,status,created_at,updated_at) VALUES('rule','a','first_time','見本',9999,1,'published','now','now')",
];

it('初期データの挿入から旧フォルダー同期の連鎖を減らし、従来の名前・色・順序の同期を保つ', () => {
  const db = new Database(':memory:');
  try {
    db.exec(bootstrap);
    db.pragma('foreign_keys = ON');
    db.pragma('recursive_triggers = ON');
    const readTriggers = () => db.prepare(
      'SELECT name, sql FROM sqlite_schema WHERE name IN (?, ?) ORDER BY name',
    ).all(...changedTriggers);
    const freshTriggers = readTriggers();
    for (const name of changedTriggers) {
      const original = previousMigration.split('\n').find(line => line.startsWith(`CREATE TRIGGER ${name} `));
      if (!original) throw new Error(`Original trigger missing: ${name}`);
      db.exec(`DROP TRIGGER ${name}`);
      db.exec(original);
    }
    db.exec(`
      INSERT INTO line_accounts(id,name,channel_id,channel_secret,channel_access_token)
        VALUES('a','A','fixture','fixture','fixture');
      INSERT INTO folders(id,kind,name,account_id) VALUES
        ('parent','template','親','a'),('friend','friend_add_rule','友だち','a'),
        ('mileage','mileage_reward','特典','a');
    `);
    db.exec("INSERT INTO folders(id,kind,name,account_id,parent_id) VALUES('child','template','子','a','parent')");
    const folderRows = () => db.prepare('SELECT * FROM folders ORDER BY id').all();
    const foldersBefore = folderRows();
    const programCounts = () => starterInserts.map(statement =>
      (db.prepare(`EXPLAIN ${statement}`).all() as { opcode: string }[]).filter(row => row.opcode === 'Program').length,
    );
    const originalCounts = programCounts();

    db.exec(migration);

    expect(readTriggers()).toEqual(freshTriggers);
    expect(folderRows()).toEqual(foldersBefore);
    for (const [index, count] of programCounts().entries()) {
      expect(count).toBeLessThan(originalCounts[index]!);
    }

    for (const statement of starterInserts) db.exec(statement);
    const readRevisions = () => db.prepare("SELECT revision FROM folders WHERE id IN ('parent','child') ORDER BY id").all() as { revision: number }[];
    const before = readRevisions();
    db.exec("UPDATE templates SET folder_id = 'child' WHERE id = 'template'");
    expect(readRevisions()).toEqual(before.map(row => ({ revision: row.revision + 1 })));

    db.exec(`
      UPDATE folders SET name = '店頭', color = '#3b82f6' WHERE id = 'friend';
      UPDATE folders SET name = '来店特典', display_order = 7 WHERE id = 'mileage';
    `);
    expect(db.prepare("SELECT name, color FROM friend_add_rule_folders WHERE id = 'friend'").get())
      .toEqual({ name: '店頭', color: '#3b82f6' });
    expect(db.prepare("SELECT name, display_order FROM mileage_reward_folders WHERE id = 'mileage'").get())
      .toEqual({ name: '来店特典', display_order: 7 });
    expect(db.pragma('foreign_key_check')).toEqual([]);
  } finally {
    db.close();
  }
});
