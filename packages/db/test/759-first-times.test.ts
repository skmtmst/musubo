import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('758 backfills first selection and earliest surviving starter application', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`CREATE TABLE account_styles(line_account_id TEXT PRIMARY KEY, selected_at TEXT);
      CREATE TABLE style_starter_items(line_account_id TEXT, applied_at TEXT);
      CREATE TABLE style_starter_catalog_items(line_account_id TEXT, state TEXT, updated_at TEXT);
      INSERT INTO account_styles VALUES ('a','2026-01-01'), ('b',NULL), ('c','2026-01-03');
      INSERT INTO style_starter_items VALUES ('a','2026-01-05'),('a','2026-01-04');
      INSERT INTO style_starter_catalog_items VALUES ('c','succeeded','2026-01-06'),('b','failed','2026-01-01');`);
    db.exec(readFileSync(new URL('../migrations/759_first_onboarding_times.sql', import.meta.url), 'utf8'));
    expect(db.prepare('SELECT line_account_id,first_selected_at,first_starter_at FROM account_styles ORDER BY line_account_id').all()).toEqual([
      {line_account_id:'a',first_selected_at:'2026-01-01',first_starter_at:'2026-01-04'},
      {line_account_id:'b',first_selected_at:null,first_starter_at:null},
      {line_account_id:'c',first_selected_at:'2026-01-03',first_starter_at:'2026-01-06'},
    ]);
  } finally { db.close(); }
});
