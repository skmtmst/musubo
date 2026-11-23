import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { purgeTablesChildFirst } from '@line-crm/db';
import { createTestD1, type SqliteD1 } from '../../test-utils/d1-sqlite.js';
import { processTenantDataPurge } from '../tenant-data-purge.js';

/*
 * 配り直しの対応表・ジョブ・店ごとの行は統括の運用データ。統括の削除では子から順に消え、
 * 版の外部キー（RESTRICT）と食い違わないことを、外部キーを有効にした本物のスキーマで確かめる。
 * ひな形の current_version_id と版は互いを参照し、外部キー有効の削除はその組で別に止まるため、
 * ここではひな形から今の版を指さない形にして、新しい表の順番だけを確かめる。
 */
const NOW = '2026-06-01T00:00:00.000Z';
const OLD = '2026-02-01T00:00:00.000Z';
let db: SqliteD1;
beforeEach(() => { db = createTestD1({ foreignKeys: true }); });
afterEach(() => db.raw.close());

function seed(tenant: string, planStatus: string, anchor: string | null) {
  const p = (id: string) => `${tenant}-${id}`;
  db.raw.prepare('INSERT INTO tenants(id,name,plan_status,retention_anchor_at) VALUES(?,?,?,?)').run(tenant, `統括 ${tenant}`, planStatus, anchor);
  db.raw.exec(`
    INSERT INTO line_accounts(id,name,channel_id,channel_secret,channel_access_token,tenant_id) VALUES('${p('acc')}','店','${p('channel')}','x','x','${tenant}');
    INSERT INTO hq_templates(id,tenant_id,template_type,catalog_type,name) VALUES('${p('hq')}','${tenant}','template','booking_menu','配るひな形');
    INSERT INTO hq_template_versions(id,tenant_id,template_id,version,definition_json,content_hash) VALUES
      ('${p('v1')}','${tenant}','${p('hq')}',1,'{}','h1'),('${p('v2')}','${tenant}','${p('hq')}',2,'{}','h2'),('${p('v3')}','${tenant}','${p('hq')}',3,'{}','h3');
    INSERT INTO menus(id,line_account_id,name,duration_minutes,base_price,hq_template_id,hq_template_version_id) VALUES('${p('menu')}','${p('acc')}','初回相談',60,3000,'${p('hq')}','${p('v1')}');
    INSERT INTO hq_template_store_bindings(tenant_id,template_id,target_account_id,kind,target_id,applied_version_id,pending_version_id,dismissed_version_id,applied_snapshot_hash,created_at,updated_at)
      VALUES('${tenant}','${p('hq')}','${p('acc')}','booking_menu','${p('menu')}','${p('v1')}','${p('v3')}','${p('v2')}','hqb1.x','${OLD}','${OLD}');
    INSERT INTO hq_template_preflights(id,tenant_id,template_id,template_version_id,target_account_id,distribution_mode,idempotency_fingerprint,snapshot_token,status,created_by,expires_at)
      VALUES('${p('pre')}','${tenant}','${p('hq')}','${p('v3')}','${p('acc')}','create','${p('fp')}','hqts1.x','ready','owner','${OLD}');
    INSERT INTO hq_template_preflight_resolutions(preflight_id,tenant_id,template_id,template_version_id,target_account_id,idempotency_fingerprint,snapshot_token,source_id,item_kind,resolution_mode)
      VALUES('${p('pre')}','${tenant}','${p('hq')}','${p('v3')}','${p('acc')}','${p('fp')}','hqts1.x','booking_menu','booking_menu','create');
    INSERT INTO hq_template_distribution_jobs(id,tenant_id,template_id,template_version_id,request_key,request_hash,status,created_by,notification_id,created_at,updated_at,finished_at)
      VALUES('${p('job')}','${tenant}','${p('hq')}','${p('v3')}','${p('key')}','hash','completed','owner','${p('notice')}','${OLD}','${OLD}','${OLD}');
    INSERT INTO hq_template_distribution_job_items(tenant_id,job_id,target_account_id,preflight_id,status,attempt_count,error_code,created_at,updated_at,finished_at)
      VALUES('${tenant}','${p('job')}','${p('acc')}','${p('pre')}','succeeded',1,'store_review_pending','${OLD}','${OLD}','${OLD}');`);
}
const counts = (tenant: string) => Object.fromEntries(['hq_template_store_bindings', 'hq_template_distribution_job_items', 'hq_template_distribution_jobs', 'hq_template_preflight_resolutions', 'hq_template_preflights', 'hq_template_versions', 'hq_templates']
  .map(table => [table, (db.raw.prepare(`SELECT COUNT(*) n FROM ${table} WHERE tenant_id=?`).get(tenant) as { n: number }).n]));

test('統括の削除は配り直しの店ごとの行・ジョブ・対応表を版より先に消し、別の統括の行は残す', async () => {
  seed('gone', 'canceled', '2026-02-20T00:00:00.000Z');
  seed('keep', 'active', null);
  expect(db.raw.pragma('foreign_key_check')).toEqual([]);
  // 対応表・ジョブが参照している版は、削除の順番を飛ばしては消せない。
  expect(() => db.raw.prepare("DELETE FROM hq_template_versions WHERE id='gone-v2'").run()).toThrow();
  const order = purgeTablesChildFirst();
  for (const [child, parent] of [['hq_template_distribution_job_items', 'hq_template_distribution_jobs'], ['hq_template_distribution_job_items', 'hq_template_preflights'],
    ['hq_template_distribution_jobs', 'hq_template_versions'], ['hq_template_store_bindings', 'hq_template_versions'], ['hq_template_store_bindings', 'line_accounts']] as const) {
    expect(order.indexOf(child), `${child} は ${parent} より先`).toBeLessThan(order.indexOf(parent));
  }
  const r2 = { delete: vi.fn(async () => {}) } as unknown as R2Bucket;
  const result = await processTenantDataPurge({ DB: db.db, IMAGES: r2 }, { now: NOW });
  expect(result).toMatchObject({ tenants: 1, completed: 1, failedTenants: 0 });
  expect(counts('gone')).toEqual({ hq_template_store_bindings: 0, hq_template_distribution_job_items: 0, hq_template_distribution_jobs: 0,
    hq_template_preflight_resolutions: 0, hq_template_preflights: 0, hq_template_versions: 0, hq_templates: 0 });
  expect(db.raw.prepare("SELECT COUNT(*) n FROM menus WHERE id='gone-menu'").get()).toEqual({ n: 0 });
  expect(counts('keep')).toEqual({ hq_template_store_bindings: 1, hq_template_distribution_job_items: 1, hq_template_distribution_jobs: 1,
    hq_template_preflight_resolutions: 1, hq_template_preflights: 1, hq_template_versions: 3, hq_templates: 1 });
  expect(db.raw.pragma('foreign_key_check')).toEqual([]);
});
