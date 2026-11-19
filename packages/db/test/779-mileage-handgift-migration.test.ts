import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { purgeTablesChildFirst, tenantScopeCondition } from '../src/data-retention-tables.js';

const migration = readFileSync(new URL('../migrations/779_mileage_handgift.sql', import.meta.url), 'utf8');
function database() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE tenants(id TEXT PRIMARY KEY, plan_status TEXT, data_purged_at TEXT, trial_ends_at TEXT, retention_anchor_at TEXT);
    CREATE TABLE tenant_purge_guard(tenant_id TEXT, table_name TEXT);
    CREATE TABLE line_accounts(id TEXT PRIMARY KEY, tenant_id TEXT REFERENCES tenants(id));
    CREATE TABLE mileage_rewards(id TEXT PRIMARY KEY, line_account_id TEXT REFERENCES line_accounts(id), reward_kind TEXT CHECK(reward_kind IN ('tag','coupon')));
    CREATE TABLE mileage_redemptions(id TEXT PRIMARY KEY, line_account_id TEXT REFERENCES line_accounts(id), reward_id TEXT REFERENCES mileage_rewards(id));`);
  return db;
}

describe('779 手渡し景品の移行', () => {
  it('空の DB に外部キーを有効にして適用できる', () => {
    const db = database();
    try {
      db.transaction(() => db.exec(migration))();
      expect(db.pragma('foreign_key_check')).toEqual([]);
      expect(db.prepare("SELECT name FROM sqlite_schema WHERE name = 'mileage_handgift_rewards'").get()).toBeTruthy();
      expect(db.prepare("SELECT name FROM sqlite_schema WHERE name = 'mileage_handgifts'").get()).toBeTruthy();
    } finally { db.close(); }
  });

  it('手渡し履歴を保護し、正式な退会処理では子から消す', () => {
    const db = database();
    try {
      db.exec(migration);
      db.exec(`INSERT INTO tenants(id,plan_status) VALUES('t','canceled');
        INSERT INTO line_accounts VALUES('a','t');
        INSERT INTO mileage_rewards VALUES('r','a','tag');
        INSERT INTO mileage_redemptions VALUES('x','a','r');
        INSERT INTO mileage_handgift_rewards(reward_id) VALUES('r');
        INSERT INTO mileage_handgifts(redemption_id,reward_id,delivered_at,delivered_by) VALUES('x','r','now','staff');`);
      expect(() => db.exec("UPDATE mileage_handgifts SET delivered_at=NULL,delivered_by=NULL WHERE redemption_id='x'")).toThrow();
      expect(() => db.exec("DELETE FROM mileage_handgifts WHERE redemption_id='x'")).toThrow();
      const order = purgeTablesChildFirst();
      expect(order.indexOf('mileage_handgifts')).toBeLessThan(order.indexOf('mileage_handgift_rewards'));
      expect(order.indexOf('mileage_handgifts')).toBeLessThan(order.indexOf('mileage_redemptions'));
      db.exec("INSERT INTO tenant_purge_guard VALUES('t','mileage_handgifts')");
      for (const table of ['mileage_handgifts', 'mileage_handgift_rewards', 'mileage_redemptions', 'mileage_rewards']) {
        db.prepare(`DELETE FROM ${table} WHERE ${tenantScopeCondition(table)}`).run('t');
      }
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally { db.close(); }
  });
});
