import { beforeEach, expect, it, vi } from 'vitest';

const getFollowersInsight = vi.hoisted(() => vi.fn());
vi.mock('@line-crm/line-sdk', () => ({
  LineClient: vi.fn().mockImplementation(function () { return { getFollowersInsight }; }),
}));
const { fetchPreConnectFollowerInsight, fetchPreConnectFollowerTotal, musuboLargeLineConsultation } =
  await import('./musubo-large-line-consultation.js');

beforeEach(() => getFollowersInsight.mockReset());

it('asks for consultation only above the conservative 500,000 cumulative threshold', async () => {
  getFollowersInsight.mockResolvedValueOnce({ status: 'ready', followers: 500_000 });
  expect(await musuboLargeLineConsultation('token')).toBe(false);
  getFollowersInsight.mockResolvedValueOnce({ status: 'ready', followers: 500_001 });
  expect(await musuboLargeLineConsultation('token')).toBe(true);
});

it('does not treat an unfinished or invalid LINE insight as a settled count', async () => {
  getFollowersInsight.mockResolvedValueOnce({ status: 'unready', followers: 600_000 });
  expect(await fetchPreConnectFollowerTotal('token')).toBeNull();
  getFollowersInsight.mockResolvedValueOnce({ status: 'ready', followers: -1 });
  expect(await fetchPreConnectFollowerTotal('token')).toBeNull();
});

it('requires a ready, nonnegative blocked-excluded count before the first LINE is billed', async () => {
  getFollowersInsight.mockResolvedValueOnce({ status: 'ready', followers: 3_100, blocks: 100 });
  expect(await fetchPreConnectFollowerInsight('token')).toMatchObject({
    followers: 3_100, friendsExcludingBlocked: 3_000,
  });
  getFollowersInsight.mockResolvedValueOnce({ status: 'ready', followers: 3_100, blocks: null });
  expect(await fetchPreConnectFollowerInsight('token')).toBeNull();
  getFollowersInsight.mockResolvedValueOnce({ status: 'unready', followers: 3_100, blocks: 100 });
  expect(await fetchPreConnectFollowerInsight('token')).toBeNull();
});
