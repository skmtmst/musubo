import { normalizeFriendLineUserId, type Friend } from '@line-crm/db';
import { DEFAULT_TENANT_ID } from '@line-crm/shared';

// D1 のバインド数上限に当てないよう、友だち照会を100件単位に分ける。
export const LOOKUP_CHUNK = 90;
type StoredFriend = Friend & { line_platform_user_id: string };

const LEGACY_ACCOUNT_SCOPE = `EXISTS (
  SELECT 1 FROM line_accounts legacy_owner
  WHERE legacy_owner.id = ? AND COALESCE(legacy_owner.tenant_id, ?) = ?
)`;

/** userId の集合を、各100バインド以内の IN 句で取得する。 */
export async function getFriendsByLineUserIds(
  db: D1Database,
  userIds: string[],
  lineAccountId: string | null,
): Promise<Map<string, Friend>> {
  const found = new Map<string, Friend>();
  for (let i = 0; i < userIds.length; i += LOOKUP_CHUNK) {
    const chunk = userIds.slice(i, i + LOOKUP_CHUNK);
    const placeholders = chunk.map(() => '?').join(',');
    if (lineAccountId) {
      const scoped = await db
        .prepare(
          `SELECT * FROM friends
            WHERE line_account_id = ?
              AND line_platform_user_id IN (${placeholders})`,
        )
        .bind(lineAccountId, ...chunk)
        .all<StoredFriend>();
      for (const row of scoped.results ?? []) found.set(row.line_platform_user_id, normalizeFriendLineUserId(row));
    }

    // 別アカウント所有の行には触れない。拾うのは未割当
    // (line_account_id IS NULL) の行だけ。他アカウントの友だちへ送信を
    // 記録する場合は、行を移す代わりにこのアカウント用の行を作る側へ回す。
    const unresolved = chunk.filter((lineUserId) => !found.has(lineUserId));
    if (unresolved.length > 0) {
      const unresolvedPlaceholders = unresolved.map(() => '?').join(',');
      const fallback = await db
        .prepare(
          `SELECT * FROM friends
            WHERE line_account_id IS NULL
              AND line_platform_user_id IN (${unresolvedPlaceholders})
              AND (? IS NULL OR ${LEGACY_ACCOUNT_SCOPE})`,
        )
        .bind(...unresolved, lineAccountId, lineAccountId, DEFAULT_TENANT_ID, DEFAULT_TENANT_ID)
        .all<StoredFriend>();
      for (const row of fallback.results ?? []) found.set(row.line_platform_user_id, normalizeFriendLineUserId(row));
    }
  }
  return found;
}

/** 成功した push の履歴保存でも、送信時の解決結果を再利用する。 */
export async function readProxyPushRecipient(db: D1Database, accountId: string, uid: string) {
  const row = await db.prepare(`SELECT f.*, EXISTS (
      SELECT 1 FROM friend_delivery_consents c JOIN friends recipient
        ON recipient.id=c.friend_id AND recipient.line_account_id=c.line_account_id
      WHERE c.state<>'granted' AND c.line_account_id=? AND recipient.line_platform_user_id=?
    ) AS delivery_suppressed FROM friends f
    WHERE f.line_platform_user_id=? AND (f.line_account_id=? OR (f.line_account_id IS NULL AND ${LEGACY_ACCOUNT_SCOPE}))
    ORDER BY (f.line_account_id=?) DESC LIMIT 1`)
    .bind(accountId, uid, uid, accountId, accountId, DEFAULT_TENANT_ID, DEFAULT_TENANT_ID, accountId)
    .first<StoredFriend & { delivery_suppressed: number }>();
  if (!row) return { friend: null, suppressed: false };
  const { delivery_suppressed, ...friend } = row;
  return { friend: normalizeFriendLineUserId(friend), suppressed: delivery_suppressed === 1 };
}
