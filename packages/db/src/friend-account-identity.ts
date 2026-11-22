import type { Friend } from './friends/types/index.js';
import { DEFAULT_TENANT_ID } from '@line-crm/shared';

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
  if (lineAccountId) {
    // UNIQUE(line_account_id, line_user_id) へ移行すると同一スコープと
    // 未割当の行が並存し得るため、厳密一致の行を優先して返す。
    return db
      .prepare(
        `SELECT * FROM friends
          WHERE line_user_id = ? AND data_purged_at IS NULL
            AND EXISTS (SELECT 1 FROM line_accounts requested_owner WHERE requested_owner.id = ? AND requested_owner.data_purged_at IS NULL)
            AND (line_account_id = ? OR (line_account_id IS NULL AND EXISTS (
              SELECT 1 FROM line_accounts legacy_owner WHERE legacy_owner.id = ?
                AND COALESCE(legacy_owner.tenant_id, '${DEFAULT_TENANT_ID}') = '${DEFAULT_TENANT_ID}'
            )))
          ORDER BY (line_account_id = ?) DESC
          LIMIT 1`,
      )
      .bind(lineUserId, lineAccountId, lineAccountId, lineAccountId, lineAccountId)
      .first<Friend>();
  }
  return db.prepare('SELECT * FROM friends WHERE line_user_id = ? AND line_account_id IS NULL AND data_purged_at IS NULL LIMIT 1').bind(lineUserId).first<Friend>();
}
