import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { expect,it } from 'vitest';
import { asD1 } from './d1-test-helper.js';
import { attachLineAccountRegistrationTags } from '../src/line-account-tags.js';
it('登録前タグは同じ統括だけを原子的に関連付け、版を変えない',async()=>{
 const raw=new Database(':memory:');
 try {
  raw.exec(`PRAGMA foreign_keys=ON; CREATE TABLE tenants(id TEXT PRIMARY KEY,purge_started_at TEXT,data_purged_at TEXT); CREATE TABLE tenant_purge_tombstone_progress(tenant_id TEXT,table_name TEXT,row_id TEXT); INSERT INTO tenants(id) VALUES ('t'),('u'); CREATE TABLE line_accounts(id TEXT PRIMARY KEY,revision INTEGER,tenant_id TEXT); CREATE TABLE line_account_tags(id TEXT PRIMARY KEY,tenant_id TEXT,name TEXT,display_order INTEGER,UNIQUE(id,tenant_id)); CREATE TABLE line_account_tag_links(line_account_id TEXT REFERENCES line_accounts(id) ON DELETE CASCADE,tag_id TEXT,tenant_id TEXT,PRIMARY KEY(line_account_id,tag_id),FOREIGN KEY(tag_id,tenant_id) REFERENCES line_account_tags(id,tenant_id));
   INSERT INTO line_accounts VALUES('a',1,'t'); INSERT INTO line_account_tags VALUES('own','t','自分',0),('other','u','他統括',0);`);
  raw.exec(readFileSync(new URL('../migrations/608_line_account_folders.sql',import.meta.url),'utf8'));
  await expect(attachLineAccountRegistrationTags(asD1(raw),'t','a',['own','other'])).rejects.toThrow();
  expect(raw.prepare('SELECT * FROM line_account_tag_links').all()).toEqual([]);
  await attachLineAccountRegistrationTags(asD1(raw),'t','a',['own']);
  expect(raw.prepare('SELECT * FROM line_account_tag_links').all()).toEqual([{line_account_id:'a',tag_id:'own',tenant_id:'t'}]);
  expect(raw.prepare('SELECT revision,folder_id FROM line_accounts').get()).toEqual({revision:1,folder_id:'own'});
  raw.exec("DELETE FROM line_accounts WHERE id='a'"); expect(raw.prepare('SELECT * FROM line_account_tag_links').all()).toEqual([]);
 } finally {raw.close();}
});
