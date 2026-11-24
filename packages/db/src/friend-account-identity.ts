import type { Friend } from './friends/types/index.js';
import { DEFAULT_TENANT_ID } from '@line-crm/shared';

export type FriendIdentityColumn = 'line_platform_user_id' | 'line_user_id';

export type StoredFriend<T extends Friend = Friend> = T & { line_platform_user_id?: string };

/** LINE/API へ公開する友だちには、保存用のキーを含めない。 */
export function normalizeFriendLineUserId<T extends Friend>(row: StoredFriend<T>): T {
  const { line_platform_user_id, ...friend } = row;
  return { ...friend, line_user_id: line_platform_user_id ?? friend.line_user_id } as T;
}

export function encodeScopedFriendLineUserId(friendId: string, userId: string, accountId: string | null): string {
  return accountId ? `musubo-scope:${friendId}:${userId}` : userId;
}

/** 既存DBでは旧キーを使い、追加列があるDBではアカウント単位の識別へ切り替える。 */
export async function withFriendIdentityColumn<T>(query: (column: FriendIdentityColumn) => Promise<T>): Promise<T> {
  try {
    return await query('line_platform_user_id');
  } catch (error) {
    if (!/no such column:\s*(?:\w+\.)?line_platform_user_id\b/i.test(String(error))) throw error;
    return query('line_user_id');
  }
}

/**
 * アカウントスコープの friend 解決。同一プロバイダー配下の複数アカウントでは
 * line_user_id が同一になるため、無指定の先頭一致だと別アカウントの friend 行に
 * 吸われて「friend=別アカウント・送信元=受信アカウント」の履歴が作られる。
 *
 * - lineAccountId 指定時: そのアカウントの行か、まだどのアカウントにも
 *   紐づいていない未割当 (NULL) の行だけを返す（未割当は既定統括の店のみ）。**別アカウント所有の行は
 *   絶対に返さない**（跨ぎフォールバックは廃止）。
 * - lineAccountId が null の場合: アカウント文脈を持たないレガシー呼出として
 *   未割当の行だけを返す。他店の所属を推測しない。
 *
 * 未割当行を受信アカウントへ引き当てるかは各呼出側の明示的な判断に委ねる
 * （例: webhook は受信時に NULL 行を自アカウントへ引き当てる）。
 */
export async function getFriendByLineUserIdForAccount(
  db: D1Database,
  lineUserId: string,
  lineAccountId: string | null,
): Promise<Friend | null> {
  return (await findFriendAccountIdentity(db, lineUserId, lineAccountId)).friend;
}

export async function findFriendAccountIdentity(
  db: D1Database,
  lineUserId: string,
  lineAccountId: string | null,
): Promise<{ friend: Friend | null; column: FriendIdentityColumn }> {
  return withFriendIdentityColumn(async column => {
    // 同じLINEユーザーの未割当行が残っていても、指定アカウントの行を優先する。
    const row = lineAccountId ? await db
      .prepare(
        `SELECT * FROM friends
          WHERE ${column} = ?
            AND (line_account_id = ? OR (line_account_id IS NULL AND EXISTS (
              SELECT 1 FROM line_accounts legacy_owner WHERE legacy_owner.id = ?
                AND COALESCE(legacy_owner.tenant_id, '${DEFAULT_TENANT_ID}') = '${DEFAULT_TENANT_ID}'
            )))
          ORDER BY (line_account_id = ?) DESC
          LIMIT 1`,
      )
      .bind(lineUserId, lineAccountId, lineAccountId, lineAccountId)
      .first<StoredFriend>()
      : await db.prepare(`SELECT * FROM friends WHERE ${column} = ? AND line_account_id IS NULL LIMIT 1`)
        .bind(lineUserId).first<StoredFriend>();
    return { friend: row ? normalizeFriendLineUserId(row) : null, column };
  });
}
