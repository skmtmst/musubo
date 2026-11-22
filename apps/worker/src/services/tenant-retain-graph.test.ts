import { buildTombstoneValues } from './tenant-purge-generic.js';
import { expect, test } from 'vitest';
import { gapFixture } from '../test-utils/gap1.js';
import { discoverRetainedPurgeAncestors, retainedPurgeAncestors } from './tenant-retain-graph.js';

test('traverses transitive references, including cycles, and fails on unclassified parents', () => {
  const categories={history:{category:'retain'},middle:{category:'retain'},parent:{category:'purge'},other:{category:'purge'}};
  const edges=[{child:'history',parent:'middle'},{child:'middle',parent:'parent'},{child:'parent',parent:'middle'}];
  expect(retainedPurgeAncestors(categories,edges)).toEqual(['parent']);
  expect(()=>retainedPurgeAncestors(categories,[...edges,{child:'parent',parent:'unknown'}])).toThrow('retention_unknown_parent:unknown');
});

test('finds actual purge parents reached by retained rows in the migrated schema', async () => {
  const f=gapFixture();
  const parents=await discoverRetainedPurgeAncestors(f.db);
  expect(parents).toEqual(expect.arrayContaining(['line_accounts','friends','friend_bulk_runs','impersonation_sessions','booking_makeup_credits','events','staff_members']));
});

test('candidate inventory covers every discovered parent and references existing columns', async () => {
  const { default: candidates } = await import('./tenant-retain-column-candidates.json');
  const f=gapFixture();
  const parents=await discoverRetainedPurgeAncestors(f.db);
  expect(Object.keys(candidates).sort()).toEqual(parents);
  for (const [table, policy] of Object.entries(candidates)) {
    const columns = new Set((f.raw.pragma(`table_info("${table}")`) as {name:string}[]).map(c=>c.name));
    for (const candidate of policy.candidates) expect(columns.has(candidate.column), `${table}.${candidate.column}`).toBe(true);
  }
});

test('policy validation rejects missing parent and missing column decisions', async () => {
  const { validateTombstonePolicies } = await import('./tenant-retain-graph.js');
  const inventory={parent:{candidates:[{column:'email'},{column:'request_key'}]}};
  expect(()=>validateTombstonePolicies(['parent'],inventory,{})).toThrow('tombstone_policy_missing:parent');
  expect(()=>validateTombstonePolicies(['parent'],inventory,{parent:{columns:{email:{action:'null',reason:'private'}}}})).toThrow('tombstone_column_policy_missing:parent.request_key');
  expect(()=>validateTombstonePolicies(['parent'],inventory,{parent:{columns:{email:{action:'null',reason:'private'},request_key:{action:'retain',reason:'required for reconciliation'}}}})).not.toThrow();
});


test('actual policies cover all discovered parent candidates', async () => {
  const { default: candidates } = await import('./tenant-retain-column-candidates.json');
  const { default: policies } = await import('./tenant-retain-column-policies.json');
  const { validateTombstonePolicies } = await import('./tenant-retain-graph.js');
  const parents=await discoverRetainedPurgeAncestors(gapFixture().db);
  expect(Object.keys(policies).sort()).toEqual(parents);
  expect(()=>validateTombstonePolicies(parents,candidates,policies as Parameters<typeof validateTombstonePolicies>[2])).not.toThrow();
});

test('every textual column of each retained parent has an explicit documented disposition', async () => {
  const {default: inventory}=await import('./tenant-retain-text-inventory.json');
  const {default: policies}=await import('./tenant-retain-column-policies.json');
  const specialized = new Set(['line_accounts','friends','rt_stores','rt_organizations','broadcasts','menus']);
  const tombstones=await import('./tenant-purge-tombstones.js');
  const captured:Record<string,string>={};
  const functions={line_accounts:tombstones.tombstoneLineAccount,friends:tombstones.tombstoneFriend,
    rt_stores:tombstones.tombstoneRestaurantStore,rt_organizations:tombstones.tombstoneRestaurantOrganization,
    broadcasts:tombstones.tombstoneBroadcast,menus:tombstones.tombstoneBookingMenu};
  for (const [table,fn] of Object.entries(functions)) {
    const db={prepare:(sql:string)=>{captured[table]=sql;return {bind:()=>({run:async()=>({meta:{changes:1}})})};}} as unknown as D1Database;
    await fn(db,'tenant','row','2027-01-01T00:00:00Z');
  }
  const assertColumns = (table:string, expected:Record<string,unknown>) => {
    const actual=(f.raw.pragma(`table_info("${table}")`) as {name:string;type:string}[])
      .filter(column=>/CHAR|CLOB|TEXT|JSON/i.test(column.type)).map(column=>column.name).sort();
    expect(actual,table).toEqual(Object.keys(expected).sort());
  };
  const f=gapFixture();
  const parents=await discoverRetainedPurgeAncestors(f.db);
  expect(Object.keys(inventory).sort()).toEqual(parents);
  for (const table of parents) {
    const declared=inventory[table as keyof typeof inventory] as Record<string,{action:string;reason:string}>;
    assertColumns(table,declared);
    for (const [column,entry] of Object.entries(declared)) {
      expect(['retain','erase'],`${table}.${column}`).toContain(entry.action);
      expect(entry.reason.trim(),`${table}.${column}`).not.toBe('');
      const decision=(policies[table as keyof typeof policies].columns as Record<string,{action:string}>)[column];
      if (!specialized.has(table)) {
        if (entry.action === 'erase') {
          expect(decision,`${table}.${column}`).toBeDefined();
          expect(decision.action,`${table}.${column}`).not.toBe('retain');
          const sample=decision.action==='json' ? (table==='common_action_versions' ? '[{"id":"step","type":"send_message","content":"private"}]' : '{"content":"private"}') : 'private';
          const result=buildTombstoneValues(table,'row',{[column]:sample},{columns:{[column]:decision as never}});
          expect(String(result[column]),`${table}.${column}`).not.toContain('private');
        } else if (decision) expect(decision.action,`${table}.${column}`).toBe('retain');
      } else if (entry.action==='erase') {
        const assignment=captured[table]?.split(`UPDATE ${table} SET`)[1]?.split('WHERE ')[0] ?? '';
        expect(assignment,`${table}.${column}`).toMatch(new RegExp(`\\b${column}\\s*=`));
      }
    }
  }
  f.raw.exec('ALTER TABLE staff ADD COLUMN newly_added_secret TEXT');
  expect(()=>assertColumns('staff',inventory.staff)).toThrow();
});
