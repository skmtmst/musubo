/*
 * 契約枠の列（migration 769・受入条件5）。
 *
 * 契約枠は LINEアカウントごとに1つの数で、既定は 1。
 * すでに動いている単一接続のLINEは、列が増えても 1 のまま従来どおり動く。
 */

import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const sql = (name: string) => readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8');

it('769は契約枠の列を1つだけ足し、既存のLINEは既定の1個で動く', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`CREATE TABLE tenants(id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL,
        plan_key TEXT, plan_status TEXT NOT NULL, trial_ends_at TEXT, plan_updated_at TEXT,
        signup_device_marker TEXT, created_at TEXT, updated_at TEXT);
      CREATE TABLE line_accounts(id TEXT PRIMARY KEY, tenant_id TEXT);
      CREATE TABLE registration_applications(id TEXT PRIMARY KEY, status TEXT NOT NULL, tenant_id TEXT);
      INSERT INTO tenants(id,name,status,plan_status) VALUES('t-1','然カフェ','active','exempt');
      INSERT INTO line_accounts VALUES('line-1','t-1');`);
    db.exec(sql('756_musubo_pricing_onboarding.sql'));

    // 列が増える前からある「Google 1件・Instagram 1件」のLINE。
    db.exec(`INSERT INTO musubo_line_usage
      (line_account_id,tenant_id,status,google_business_count,instagram_count,updated_at)
      VALUES('line-1','t-1','active',1,1,'2026-11-16T00:00:00Z')`);

    db.exec(sql('769_musubo_contracted_linked_slots.sql'));

    // 既存の行は既定の1個。サービス別の2つめの列は作らない。
    expect(db.prepare('SELECT contracted_linked_slots FROM musubo_line_usage').get())
      .toEqual({ contracted_linked_slots: 1 });
    const columns = db.prepare('SELECT name FROM pragma_table_info(?)').all('musubo_line_usage') as { name: string }[];
    expect(columns.filter((c) => c.name.includes('contracted')).map((c) => c.name))
      .toEqual(['contracted_linked_slots']);

    // 追加枠を2枠買ったLINEは契約枠3個（Google・Instagram が各3個まで）。
    db.exec("UPDATE musubo_line_usage SET contracted_linked_slots=3 WHERE line_account_id='line-1'");
    expect(db.prepare('SELECT contracted_linked_slots FROM musubo_line_usage').get())
      .toEqual({ contracted_linked_slots: 3 });

    // 0以下は入らない（基本料金ぶんの1個は必ずある）。
    expect(() => db.exec('UPDATE musubo_line_usage SET contracted_linked_slots=0')).toThrow(/CHECK/);
  } finally { db.close(); }
});
