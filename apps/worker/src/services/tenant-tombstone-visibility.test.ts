import { expect, test } from 'vitest';
import { getFriendById, getFriendByLineUserIdForAccount, getFriends, getFollowingLineUserIdsByTag, getLineAccountById, getLineAccounts, getLineAccountLoginChannels, upsertFriend } from '@line-crm/db';
import { gapFixture } from '../test-utils/gap1.js';
import { friendBreakdown } from '@line-crm/db/src/dashboard-inbox.js';

test('purged accounts and friends are hidden from inventory, identity lookup, login and send candidates', async () => {
  const f = gapFixture();
  f.raw.exec("UPDATE line_accounts SET data_purged_at='2027-05-01',login_channel_id='login-private' WHERE id='a'; UPDATE friends SET data_purged_at='2027-05-01' WHERE id='f'");
  expect(await getLineAccountById(f.db, 'a')).toBeNull();
  expect((await getLineAccounts(f.db)).map(row => row.id)).not.toContain('a');
  expect(await getLineAccountLoginChannels(f.db, { loginChannelId:'login-private' })).toEqual([]);
  expect(await getFriendById(f.db, 'f')).toBeNull();
  // アカウント墓石後、友だち側の掃除が終わる前にも見えない。
  expect(await getFriendById(f.db, 'f2')).toBeNull();
  await expect(upsertFriend(f.db, {lineUserId:'U-new',lineAccountId:'a'})).rejects.toThrow();
  expect(await getFriendByLineUserIdForAccount(f.db, 'Uf', 'a')).toBeNull();
  expect((await getFriends(f.db)).map(row => row.id)).not.toContain('f');
  expect(await getFollowingLineUserIdsByTag(f.db, 'a', null)).not.toContain('Uf');
  expect((await friendBreakdown(f.db, 'a')).total).toBe(0);
});
