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
