import { LineClient } from '@line-crm/line-sdk';
import { jstDateOffset } from '@line-crm/shared';

/** LINE publishes completed statistics for the previous JST day. */
export function insightDateJst(now: Date = new Date()): string {
  return jstDateOffset(-1, now).replaceAll('-', '');
}

/** The cumulative number is conservative: deleted users can keep it above the live count. */
export async function fetchPreConnectFollowerTotal(channelAccessToken: string): Promise<number | null> {
  try {
    const insight = await new LineClient(channelAccessToken).getFollowersInsight(insightDateJst());
    return insight.status === 'ready' && typeof insight.followers === 'number'
      && Number.isSafeInteger(insight.followers) && insight.followers >= 0 ? insight.followers : null;
  } catch {
    return null;
  }
}

export async function musuboLargeLineConsultation(channelAccessToken: string): Promise<boolean> {
  const count = await fetchPreConnectFollowerTotal(channelAccessToken);
  return count !== null && count > 500_000;
}
