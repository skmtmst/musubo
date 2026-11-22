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
  expect(()=>validateTombstonePolicies(['parent'],inventory,{parent:{columns:{email:{action:'clear',reason:'private'}}}})).toThrow('tombstone_column_policy_missing:parent.request_key');
  expect(()=>validateTombstonePolicies(['parent'],inventory,{parent:{columns:{email:{action:'clear',reason:'private'},request_key:{action:'retain',reason:'required for reconciliation'}}}})).not.toThrow();
});
