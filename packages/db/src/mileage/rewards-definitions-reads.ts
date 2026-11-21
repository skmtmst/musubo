import { sqlIdSet } from '../id-queries.js';
import { type MileageRewardSummary, type RewardRow, type MileageRewardAdminOverview } from './rewards-types.js';
import { rewardSelect, mapReward, MileageRewardError } from './rewards-validation.js';
import { collectBeneficiaryKeysForLimit } from './rewards-redemptions.js';



export async function listMileageRewards(
  db: D1Database,
  input: { lineAccountId: string; customerVisible?: boolean },
): Promise<MileageRewardSummary[]> {
  const now = new Date().toISOString();
  const visibleClause = input.customerVisible
    ? `AND r.status = 'published' AND v.status = 'published'
       AND (v.starts_at IS NULL OR v.starts_at <= ?)
       AND (v.ends_at IS NULL OR v.ends_at > ?)`
    : '';
  const binds: unknown[] = [input.lineAccountId];
  if (input.customerVisible) binds.push(now, now);
  const result = await db.prepare(
    `${rewardSelect(input.customerVisible
      ? 'r.current_published_version_id'
      : 'COALESCE(r.current_draft_version_id, r.current_published_version_id)')}
      WHERE r.line_account_id = ? ${visibleClause}
      ORDER BY r.sort_order, r.updated_at DESC, r.id`,
  ).bind(...binds).all<RewardRow>();
  return result.results.map(mapReward);
}

export async function getMileageReward(
  db: D1Database,
  input: { id: string; lineAccountId: string },
): Promise<MileageRewardSummary | null> {
  const row = await db.prepare(
    `${rewardSelect('COALESCE(r.current_draft_version_id, r.current_published_version_id)')}
      WHERE r.id = ? AND r.line_account_id = ?`,
  ).bind(input.id, input.lineAccountId).first<RewardRow>();
  return row ? mapReward(row) : null;
}

export async function getMileageRewardAdminOverview(
  db: D1Database,
  lineAccountId: string,
): Promise<MileageRewardAdminOverview> {
  const rewards = await listMileageRewards(db, { lineAccountId });
  const summary = await db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM mileage_rewards
         WHERE line_account_id = ? AND status = 'published') AS published_count,
       COALESCE((SELECT SUM(v.required_miles)
         FROM mileage_redemptions mr
         JOIN mileage_reward_versions v ON v.id = mr.reward_version_id
        WHERE mr.line_account_id = ? AND mr.status = 'succeeded'
          AND mr.delivered_at >= datetime('now', 'start of month')), 0) AS redeemed_miles_this_month,
       (SELECT COUNT(*) FROM friends f
         WHERE f.line_account_id = ? AND f.is_following = 1
           AND NOT EXISTS (
             SELECT 1 FROM mileage_redemptions mr
              WHERE mr.line_account_id = ? AND mr.status != 'refunded'
                AND ((f.user_id IS NOT NULL AND mr.beneficiary_key = 'user:' || f.user_id)
                  OR (f.user_id IS NULL AND mr.beneficiary_key = 'friend:' || f.id))
           )) AS never_redeemed_friend_count,
       (SELECT r.name FROM mileage_rewards r
         JOIN mileage_redemptions mr ON mr.reward_id = r.id AND mr.status = 'succeeded'
       WHERE r.line_account_id = ?
        GROUP BY r.id ORDER BY COUNT(*) DESC, r.name LIMIT 1) AS most_redeemed_reward_name,
       (SELECT COUNT(*) FROM mileage_redemptions mr
         JOIN mileage_rewards r ON r.id = mr.reward_id
        WHERE r.line_account_id = ? AND mr.status = 'succeeded'
        GROUP BY r.id ORDER BY COUNT(*) DESC, r.name LIMIT 1) AS most_redeemed_reward_count`,
  ).bind(lineAccountId, lineAccountId, lineAccountId, lineAccountId, lineAccountId, lineAccountId).first<{
    published_count: number;
    redeemed_miles_this_month: number;
    never_redeemed_friend_count: number;
    most_redeemed_reward_name: string | null;
    most_redeemed_reward_count: number | null;
  }>();
  return {
    rewards,
    summary: {
      publishedCount: summary?.published_count ?? 0,
      redeemedMilesThisMonth: summary?.redeemed_miles_this_month ?? 0,
      neverRedeemedFriendCount: Number(summary?.never_redeemed_friend_count ?? 0),
      mostRedeemedRewardName: summary?.most_redeemed_reward_name ?? null,
      mostRedeemedRewardCount: summary?.most_redeemed_reward_count ?? null,
    },
  };
}

/**
 * 顧客向け一覧で「交換できる」と言い切る前に、実際の交換回数をまとめて確認する。
 * 0件と未取得を混ぜないため、友だちが存在しない場合は空のMapではなく例外にする。
 */
export async function getMileageRewardRedemptionCounts(
  db: D1Database,
  input: { lineAccountId: string; friendId: string },
): Promise<{
  beneficiaryKey: string;
  byRewardId: Map<string, number>;
  byVersionId: Map<string, number>;
}> {
  const friend = await db.prepare(
    `SELECT id, user_id FROM friends WHERE id = ? AND line_account_id = ?`,
  ).bind(input.friendId, input.lineAccountId).first<{ id: string; user_id: string | null }>();
  if (!friend) throw new MileageRewardError('friend_not_found', '友だち情報を確認できませんでした', 404);
  const beneficiaryKey = friend.user_id ? `user:${friend.user_id}` : `friend:${friend.id}`;
  /*
   * 交換済みの表示も上限と同じ本人キー集合で数える。統合後に
   * 「交換できる」と出して上限で止める食い違いを出さない。
   */
  const limitKeys = await collectBeneficiaryKeysForLimit(db, input.friendId, friend.user_id, beneficiaryKey);
  const limitPlaceholders = sqlIdSet(limitKeys).sql;
  const rows = await db.prepare(
    `SELECT reward_id, reward_version_id, COUNT(*) AS count
       FROM mileage_redemptions
      WHERE line_account_id = ? AND beneficiary_key IN (${limitPlaceholders}) AND status != 'refunded' AND (status != 'reserved' OR anonymized_at IS NULL)
      GROUP BY reward_id, reward_version_id`,
  ).bind(input.lineAccountId, ...(limitKeys.length ? sqlIdSet(limitKeys).binds : [])).all<{
    reward_id: string;
    reward_version_id: string;
    count: number;
  }>();
  const byRewardId = new Map<string, number>();
  const byVersionId = new Map<string, number>();
  for (const row of rows.results) {
    byRewardId.set(row.reward_id, (byRewardId.get(row.reward_id) ?? 0) + row.count);
    byVersionId.set(row.reward_version_id, row.count);
  }
  return { beneficiaryKey, byRewardId, byVersionId };
}

export async function requirePublishedActionVersion(
  db: D1Database,
  lineAccountId: string,
  versionId: string | null,
): Promise<void> {
  if (!versionId) return;
  const row = await db.prepare(
    `SELECT cav.action_config
       FROM common_action_versions cav
       JOIN common_actions ca ON ca.id = cav.common_action_id
      WHERE cav.id = ? AND cav.status = 'published' AND ca.line_account_id = ?`,
  ).bind(versionId, lineAccountId).first<{ action_config: string }>();
  if (!row) throw new MileageRewardError('action_not_published', '公開済みの交換後アクションを選んでください');
  let actions: unknown;
  try { actions = JSON.parse(row.action_config); } catch { actions = null; }
  if (!Array.isArray(actions) || actions.some((action) => {
    if (!action || typeof action !== 'object') return true;
    const type = (action as { type?: unknown }).type;
    return type === 'wait' || type === 'common_action';
  })) {
    throw new MileageRewardError(
      'action_not_immediate',
      '待ち時間または別の共通アクションを含む処理は、交換後の動きに使えません',
    );
  }
}
