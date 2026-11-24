import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { getLinkClicks } from '@line-crm/db';
import { trackedLinkFriendMatches } from './tracked-link-identity.js';
import { applyTapExtras } from './tap-extras.js';
import { recordTrackedClick } from './tracked-click-steps.js';

let raw: Database.Database;
let db: D1Database;
beforeEach(() => {
  raw = new Database(':memory:');
  // 複合一意制約への移行後も、同じLINE利用者の所属一致を未割当より優先する。
  raw.exec(`CREATE TABLE line_accounts(id TEXT PRIMARY KEY,tenant_id TEXT);
    CREATE TABLE friends(id TEXT PRIMARY KEY,line_user_id TEXT,line_account_id TEXT,display_name TEXT,line_platform_user_id TEXT AS (line_user_id) VIRTUAL);
    CREATE TABLE tracked_links(id TEXT PRIMARY KEY,line_account_id TEXT,scenario_id TEXT);
    CREATE TABLE scenarios(id TEXT PRIMARY KEY,line_account_id TEXT);
    CREATE TABLE link_clicks(id TEXT,tracked_link_id TEXT,friend_id TEXT,clicked_at TEXT);
    INSERT INTO line_accounts VALUES('a',NULL),('b','other');
    INSERT INTO friends VALUES('legacy','Ushared',NULL,'Legacy');
    INSERT INTO tracked_links VALUES('link','a',NULL);
    INSERT INTO link_clicks VALUES('click','link','legacy','2026-01-01');`);
  db = {prepare(sql: string) {
    let args: unknown[] = [];
    const statement = {
      bind(...values: unknown[]) { args = values; return statement; },
      async first<T>() { return (raw.prepare(sql).get(...args) as T | undefined) ?? null; },
      async all<T>() { return {results: raw.prepare(sql).all(...args) as T[]}; },
    };
    return statement;
  }} as unknown as D1Database;
});
afterEach(() => raw.close());

it('prefers an exact account identity over an older NULL row before saving and when displaying history', async () => {
  expect(await trackedLinkFriendMatches(db,'legacy','a')).toBe(true);
  expect((await getLinkClicks(db,'link'))[0].friend_id).toBe('legacy');
  raw.exec("INSERT INTO friends VALUES('exact','Ushared','a','Exact')");
  expect(await trackedLinkFriendMatches(db,'legacy','a')).toBe(false);
  expect(await trackedLinkFriendMatches(db,'exact','a')).toBe(true);
  expect((await getLinkClicks(db,'link'))[0]).toMatchObject({friend_id:null,friend_display_name:null});
  await expect(recordTrackedClick(db,{linkId:'link',friendId:'legacy',identityVerified:true,accountId:'a',tagId:null,scenarioId:null,linkName:'Link',conversionPointIds:[]}))
    .rejects.toThrow('tracked_click_account_changed');
  await expect(applyTapExtras(db,'legacy','a',{scoreChange:1},'event')).rejects.toThrow('tap_extra_account_mismatch');
  raw.exec("INSERT INTO link_clicks VALUES('exact-click','link','exact','2026-01-02')");
  expect((await getLinkClicks(db,'link'))[0]).toMatchObject({friend_id:'exact',friend_display_name:'Exact'});
});
it('never resolves a legacy NULL row for a nondefault tenant or a foreign assigned identity', async () => {
  expect(await trackedLinkFriendMatches(db,'legacy','b')).toBe(false);
  raw.exec("UPDATE friends SET line_account_id='b' WHERE id='legacy'");
  expect(await trackedLinkFriendMatches(db,'legacy','a')).toBe(false);
  expect((await getLinkClicks(db,'link'))[0].friend_id).toBeNull();
});
