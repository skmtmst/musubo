import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('763 は既存の行を変えず、削除確認を守るトリガーだけを追加する', () => {
  const db = new Database(':memory:');
  try {
    db.exec(readFileSync(new URL('../bootstrap.sql', import.meta.url), 'utf8'));
    const triggers = db.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND (name LIKE 'folder_membership_%' OR name LIKE 'folder_scope_%' OR name LIKE 'folder_child_%')").all() as { name: string }[];
    for (const { name } of triggers) db.exec(`DROP TRIGGER "${name.replaceAll('"', '""')}"`);
    db.exec("INSERT INTO folders(id,kind,name) VALUES('existing','affiliate','既存')");
    const before = db.prepare("SELECT * FROM folders WHERE id='existing'").get();
    const existing = db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE type IN ('table','index','trigger') ORDER BY type,name").all();
    db.exec(readFileSync(new URL('../migrations/763_folder_membership_revisions.sql', import.meta.url), 'utf8'));
    expect(db.prepare("SELECT * FROM folders WHERE id='existing'").get()).toEqual(before);
    const after = db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE type IN ('table','index','trigger') AND name NOT LIKE 'folder_membership_%' AND name NOT LIKE 'folder_scope_%' AND name NOT LIKE 'folder_child_%' ORDER BY type,name").all();
    expect(after).toEqual(existing);
    expect(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type='trigger' AND (name LIKE 'folder_membership_%' OR name LIKE 'folder_scope_%' OR name LIKE 'folder_child_%')").get()).toEqual({ n: 72 });
  } finally { db.close(); }
});

const trackedTables = [
  'affiliate_offers', 'affiliates', 'auto_replies', 'automation_definitions', 'broadcasts', 'common_actions',
  'common_vars', 'conversion_points', 'forms', 'friend_add_rules', 'friend_fields', 'incoming_webhooks',
  'media', 'mileage_rewards', 'outgoing_webhooks', 'reminders', 'rich_menu_groups', 'scenarios', 'tags',
  'templates', 'webinars',
] as const;
function syntheticDatabase() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE folders (id TEXT PRIMARY KEY, parent_id TEXT, account_id TEXT, kind TEXT, revision INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE form_accounts(form_id TEXT,line_account_id TEXT);
    CREATE TABLE friend_field_scopes(field_id TEXT,line_account_id TEXT,tenant_id TEXT);`);
  for (const table of trackedTables) db.exec(`CREATE TABLE ${table} (id TEXT PRIMARY KEY, folder_id TEXT, line_account_id TEXT, account_id TEXT, status TEXT DEFAULT 'active', archived_at TEXT, deleted_at TEXT, note TEXT)`);
  db.exec(readFileSync(new URL('../migrations/763_folder_membership_revisions.sql', import.meta.url), 'utf8'));
  db.exec("INSERT INTO folders(id,parent_id,account_id,kind) VALUES ('root',NULL,'a','test'),('old','root','a','test'),('new','root','a','test')");
  return db;
}
it.each(trackedTables)('%s の追加・移動・削除は確認版を進め、無関係な変更では進めない', (table) => {
  const db = syntheticDatabase();
  try {
    const revisions = () => Object.fromEntries((db.prepare('SELECT id,revision FROM folders').all() as {id:string;revision:number}[]).map(row => [row.id,row.revision]));
    const before = revisions();
    db.prepare(`INSERT INTO ${table}(id,folder_id,line_account_id,account_id) VALUES('item','old','a','a')`).run();
    const inserted = revisions();
    expect(inserted.old).toBeGreaterThan(before.old); expect(inserted.root).toBeGreaterThan(before.root);
    db.prepare(`UPDATE ${table} SET note='内部メモ' WHERE id='item'`).run();
    expect(revisions()).toEqual(inserted);
    db.prepare(`UPDATE ${table} SET folder_id='new' WHERE id='item'`).run();
    const moved = revisions();
    expect(moved.old).toBeGreaterThan(inserted.old); expect(moved.new).toBeGreaterThan(inserted.new); expect(moved.root).toBeGreaterThan(inserted.root);
    db.prepare(`DELETE FROM ${table} WHERE id='item'`).run();
    const removed = revisions();
    expect(removed.new).toBeGreaterThan(moved.new); expect(removed.root).toBeGreaterThan(moved.root);
  } finally { db.close(); }
});
it.each([
  ['auto_replies','deleted_at','削除'], ['automation_definitions','status','archived'],
  ['common_actions','status','archived'], ['common_vars','archived_at','保管'],
  ['forms','archived_at','保管'], ['friend_add_rules','archived_at','保管'],
  ['incoming_webhooks','deleted_at','削除'], ['mileage_rewards','status','archived'],
  ['outgoing_webhooks','deleted_at','削除'], ['reminders','deleted_at','削除'],
  ['templates','deleted_at','削除'], ['webinars','status','archived'],
] as const)('%s の表示対象への出入りで確認版が進む', (table,column,hidden) => {
  const db=syntheticDatabase();
  try {
    db.prepare(`INSERT INTO ${table}(id,folder_id,line_account_id,account_id) VALUES('item','old','a','a')`).run();
    const revision=()=>Number((db.prepare("SELECT revision FROM folders WHERE id='old'").get() as {revision:number}).revision);
    const before=revision();
    db.prepare(`UPDATE ${table} SET ${column}=? WHERE id='item'`).run(hidden);
    expect(revision()).toBeGreaterThan(before);
    const hiddenRevision=revision();
    db.prepare(`UPDATE ${table} SET ${column}=? WHERE id='item'`).run(column==='status'?'active':null);
    expect(revision()).toBeGreaterThan(hiddenRevision);
  } finally { db.close(); }
});
it.each([['forms','form_accounts','form_id'],['friend_fields','friend_field_scopes','field_id']] as const)('%s のアカウント範囲が変わると確認版が進む', (entity,scope,field) => {
  const db=syntheticDatabase();
  try {
    db.prepare(`INSERT INTO ${entity}(id,folder_id,line_account_id,account_id) VALUES('item','old','a','a')`).run();
    const revision=()=>Number((db.prepare("SELECT revision FROM folders WHERE id='old'").get() as {revision:number}).revision);
    const before=revision();
    db.prepare(`INSERT INTO ${scope}(${field},line_account_id) VALUES('item','a')`).run();
    expect(revision()).toBeGreaterThan(before);
    const assigned=revision();
    db.prepare(`DELETE FROM ${scope} WHERE ${field}='item'`).run();
    expect(revision()).toBeGreaterThan(assigned);
  } finally { db.close(); }
});
it('保管済みでも削除時に未分類へ移る対象は確認版を進める', () => {
  const db=syntheticDatabase();
  try {
    const before=Number((db.prepare("SELECT revision FROM folders WHERE id='old'").get() as {revision:number}).revision);
    db.exec("INSERT INTO templates(id,folder_id,line_account_id,deleted_at) VALUES('hidden','old','a','deleted')");
    expect(Number((db.prepare("SELECT revision FROM folders WHERE id='old'").get() as {revision:number}).revision)).toBeGreaterThan(before);
  } finally { db.close(); }
});
