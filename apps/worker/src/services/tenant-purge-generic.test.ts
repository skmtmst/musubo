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
