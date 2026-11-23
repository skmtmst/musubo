import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { purgeTablesChildFirst } from './data-retention-tables.js';

it('配布の子を親より先に削除でき、版は参照中に削除できない', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE hq_templates(id TEXT,tenant_id TEXT,PRIMARY KEY(id,tenant_id));
    CREATE TABLE hq_template_versions(id TEXT,template_id TEXT,tenant_id TEXT,PRIMARY KEY(id,tenant_id),UNIQUE(id,template_id,tenant_id));
    CREATE TABLE hq_template_preflights(id TEXT,tenant_id TEXT,PRIMARY KEY(id,tenant_id));`);
  db.exec(readFileSync(new URL('../migrations/792_hq_distribution_bindings_jobs.sql', import.meta.url), 'utf8'));
  db.exec(`INSERT INTO hq_templates VALUES('h','t'); INSERT INTO hq_template_versions VALUES('v','h','t');
    INSERT INTO hq_template_preflights VALUES('p','t');
    INSERT INTO hq_template_store_bindings(tenant_id,template_id,target_account_id,kind,target_id,applied_version_id,applied_snapshot_hash,created_at,updated_at) VALUES('t','h','a','booking_menu','m','v','hash','now','now');
    INSERT INTO hq_template_distribution_jobs(id,tenant_id,template_id,template_version_id,request_key,request_hash,status,created_by,created_at,updated_at) VALUES('j','t','h','v','key','hash','pending','staff','now','now');
    INSERT INTO hq_template_distribution_job_items(tenant_id,job_id,target_account_id,preflight_id,status,created_at,updated_at) VALUES('t','j','a','p','pending','now','now');`);
  expect(() => db.exec("DELETE FROM hq_template_versions WHERE id='v'")).toThrow();
  const order = purgeTablesChildFirst();
  for (const table of order.filter((x) => ['hq_template_distribution_job_items','hq_template_distribution_jobs','hq_template_store_bindings','hq_template_preflights','hq_template_versions','hq_templates'].includes(x))) db.exec(`DELETE FROM ${table}`);
  expect(db.prepare('SELECT count(*) n FROM hq_template_versions').get()).toEqual({ n: 0 });
  db.close();
});
