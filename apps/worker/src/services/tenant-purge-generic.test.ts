import { expect, test } from 'vitest';
import { buildTombstoneValues } from './tenant-purge-generic.js';

test('builds redactions without modifying retained values or the source row', () => {
  const row={email:'person@example.test',display_name:'private',external_id:'external',count:4,settings:'{"email":"private","amount":200}'};
  const policy={columns:{email:{action:'null',reason:'private'},display_name:{action:'placeholder',reason:'private'},external_id:{action:'unique',reason:'unique'},count:{action:'retain',reason:'audit'},settings:{action:'json',reason:'private'}}} as const;
  expect(buildTombstoneValues('example','row-1',row,policy)).toEqual({email:null,display_name:'（削除済み）',external_id:'purged:example:external_id:row-1',settings:'{"amount":200}'});
  expect(row.email).toBe('person@example.test');
  expect(buildTombstoneValues('example','row-2',row,policy).external_id).not.toBe(buildTombstoneValues('example','row-1',row,policy).external_id);
});

test('rejects an unresolved policy or a missing column', () => {
  expect(()=>buildTombstoneValues('example','1',{email:'x'},{columns:{email:{action:'review',reason:'pending'}}})).toThrow('tombstone_policy_unresolved');
  expect(()=>buildTombstoneValues('example','1',{}, {columns:{email:{action:'null',reason:'private'}}})).toThrow('invalid_tombstone_column');
});

test('a scoped tombstone is recorded atomically and skipped on retry', async () => {
  const { gapFixture } = await import('../test-utils/gap1.js');
  const { tombstoneRetainedParents } = await import('./tenant-purge-generic.js');
  const f=gapFixture();
  f.raw.exec(`UPDATE tenants SET purge_started_at='2027-01-01' WHERE id='t';
    CREATE TABLE fixture_parent(id TEXT PRIMARY KEY,tenant_id TEXT,name TEXT);
    INSERT INTO fixture_parent(id,tenant_id,name) VALUES ('fold','t','private'),('otherfold','other','other');`);
  const input={tenantId:'t',table:'fixture_parent',scope:'fixture_parent.tenant_id=?',scopeValues:['t'],limit:20,policy:{columns:{name:{action:'placeholder',reason:'private'}}} as const};
  expect(await tombstoneRetainedParents(f.db,input)).toBe(1);
  expect(await tombstoneRetainedParents(f.db,input)).toBe(0);
  expect(f.raw.prepare('SELECT id,name FROM fixture_parent ORDER BY id').all()).toEqual([{id:'fold',name:'（削除済み）'},{id:'otherfold',name:'other'}]);
});

test('real purge keeps and redacts a bulk approval parent', async () => {
  const { gapFixture } = await import('../test-utils/gap1.js');
  const { processTenantDataPurge } = await import('./tenant-data-purge.js');
  const f=gapFixture();
  f.raw.exec(`UPDATE tenants SET plan_status='canceled',retention_anchor_at='2026-01-01' WHERE id='t';
    INSERT INTO friend_bulk_runs(id,tenant_id,created_by,selection_json,operation_json,idempotency_key,created_at,updated_at)
      VALUES('run','t','private-actor','{"email":"private","count":4}','{"name":"private"}','private-key','2026-01-01','2026-01-01');
    INSERT INTO friend_bulk_message_approval_events(id,run_id,actor_staff_id,action,created_at) VALUES('approval','run','o','approved','2026-01-01');`);
  const result=await processTenantDataPurge({DB:f.db},{now:'2027-05-01T00:00:00Z'});
  expect(result.completed).toBe(1);
  expect(f.raw.prepare("SELECT id FROM friend_bulk_message_approval_events WHERE id='approval'").get()).toEqual({id:'approval'});
  const row=f.raw.prepare("SELECT selection_json,operation_json,created_by FROM friend_bulk_runs WHERE id='run'").get() as {selection_json:string;operation_json:string;created_by:string};
  expect(row.selection_json).not.toContain('private');
  expect(row.operation_json).not.toContain('private');
  expect(row.created_by).not.toContain('private');
  const {getFriendBulkRun,getFriendBulkRunRow}=await import('@line-crm/db');
  f.raw.exec("UPDATE tenants SET data_purged_at=NULL,plan_status='active' WHERE id='t'");
  expect(await getFriendBulkRun(f.db,'run','t')).toBeNull();
  expect(await getFriendBulkRunRow(f.db,'run')).toBeNull();
});

test('retained privacy audit survives purge of the session and operator', async () => {
  const { gapFixture }=await import('../test-utils/gap1.js');
  const { processTenantDataPurge }=await import('./tenant-data-purge.js');
  const f=gapFixture(); f.raw.pragma('foreign_keys = ON');
  f.raw.exec(`UPDATE tenants SET plan_status='canceled',retention_anchor_at='2026-01-01' WHERE id='t';
    INSERT INTO impersonation_sessions(id,staff_id,tenant_id,mode,write_reason) VALUES('session','o','t','write','private');
    INSERT INTO pii_reveal_logs(id,impersonation_session_id,staff_id,tenant_id,reason) VALUES('audit','session','o','t','audit');`);
  const result=await processTenantDataPurge({DB:f.db},{now:'2027-05-01T00:00:00Z'});
  expect(result.completed).toBe(1);
  expect(f.raw.prepare("SELECT id FROM pii_reveal_logs WHERE id='audit'").get()).toEqual({id:'audit'});
  expect(f.raw.prepare("SELECT write_reason FROM impersonation_sessions WHERE id='session'").get()).toEqual({write_reason:null});
});
