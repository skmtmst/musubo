import { LineClient } from '@line-crm/line-sdk';
import { jstDateOffset, musuboFriendsExcludingBlocked } from '@line-crm/shared';

/** LINE publishes completed statistics for the previous JST day. */
export function insightDateJst(now: Date = new Date()): string {
  return jstDateOffset(-1, now).replaceAll('-', '');
}

export async function fetchPreConnectFollowerInsight(channelAccessToken: string, now = new Date()): Promise<{
  followers: number;
  friendsExcludingBlocked: number;
  measuredOn: string;
} | null> {
  const measuredOn = jstDateOffset(-1, now);
  try {
    const insight = await new LineClient(channelAccessToken).getFollowersInsight(measuredOn.replaceAll('-', ''));
    const friendsExcludingBlocked = musuboFriendsExcludingBlocked(insight);
    return friendsExcludingBlocked === null ? null : {
      followers: insight.followers!, friendsExcludingBlocked, measuredOn,
    };
  } catch { return null; }
}

/** The cumulative number is conservative: deleted users can keep it above the live count. */
export async function fetchPreConnectFollowerTotal(channelAccessToken: string): Promise<number | null> {
  try {
    const insight = await new LineClient(channelAccessToken).getFollowersInsight(insightDateJst());
    return insight.status === 'ready' && typeof insight.followers === 'number'
      && Number.isSafeInteger(insight.followers) && insight.followers >= 0 ? insight.followers : null;
  } catch { return null; }
}

export async function musuboLargeLineConsultation(channelAccessToken: string): Promise<boolean> {
  const count = await fetchPreConnectFollowerTotal(channelAccessToken);
  return count !== null && count > 500_000;
}
