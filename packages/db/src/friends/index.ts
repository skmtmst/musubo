export type { Friend } from './types.js';
import type { Friend } from './types.js';
import { DEFAULT_TENANT_ID } from '@line-crm/shared';
import { getFriendByLineUserIdForAccount } from '../friend-account-identity.js';
import { sqlIdSet } from '../id-queries.js';
import { boundedListLimit, followTimeSql, jstNow, nonNegativeListOffset } from '../utils.js';

export interface GetFriendsOptions {
  limit?: number;
  offset?: number;
  tagId?: string;
}

export async function getFriends(
  db: D1Database,
  opts: GetFriendsOptions = {},
): Promise<Friend[]> {
  const { tagId } = opts;
  const limit = boundedListLimit(opts.limit, 50);
  const offset = nonNegativeListOffset(opts.offset);

  if (tagId) {
    const result = await db
      .prepare(
        `SELECT f.*
         FROM friends f
         INNER JOIN friend_tags ft ON ft.friend_id = f.id
         WHERE ft.tag_id = ? AND f.data_purged_at IS NULL AND (f.line_account_id IS NULL OR EXISTS (SELECT 1 FROM line_accounts a WHERE a.id=f.line_account_id AND a.data_purged_at IS NULL))
         ORDER BY f.created_at DESC
         LIMIT ? OFFSET ?`,
      )
      .bind(tagId, limit, offset)
      .all<Friend>();
    return result.results;
  }

  const result = await db
    .prepare(
      `SELECT * FROM friends WHERE data_purged_at IS NULL AND (line_account_id IS NULL OR EXISTS (SELECT 1 FROM line_accounts a WHERE a.id=friends.line_account_id AND a.data_purged_at IS NULL))
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
    )
    .bind(limit, offset)
    .all<Friend>();
  return result.results;
}

/**
 * 指定 LINE アカウント内で、指定タグを持ち、現在 friend 状態 (is_following = 1)
 * の友だちの line_user_id 配列を返す。リッチメニューの bulk link 用。
 *
 * - tagId が省略された場合は account 内全員の following を返す
 * - line_user_id は LINE bulk link API の userIds に直接渡す形式 (U... 始まり)
 * - 重複は無いはず (friends.line_user_id は UNIQUE)
 */
export async function getFollowingLineUserIdsByTag(
  db: D1Database,
  accountId: string,
  tagId: string | null,
): Promise<string[]> {
  if (tagId) {
    const result = await db
      .prepare(
        `SELECT DISTINCT f.line_user_id
           FROM friends f
           INNER JOIN friend_tags ft ON ft.friend_id = f.id
          WHERE ft.tag_id = ?
            AND f.line_account_id = ?
            AND f.is_following = 1 AND f.data_purged_at IS NULL AND EXISTS (SELECT 1 FROM line_accounts a WHERE a.id=f.line_account_id AND a.data_purged_at IS NULL)`,
      )
      .bind(tagId, accountId)
      .all<{ line_user_id: string }>();
    return (result.results ?? []).map((r) => r.line_user_id);
  }
  const result = await db
    .prepare(
      `SELECT line_user_id
         FROM friends
        WHERE line_account_id = ? AND is_following = 1 AND data_purged_at IS NULL AND EXISTS (SELECT 1 FROM line_accounts a WHERE a.id=friends.line_account_id AND a.data_purged_at IS NULL)`,
    )
    .bind(accountId)
    .all<{ line_user_id: string }>();
  return (result.results ?? []).map((r) => r.line_user_id);
}

export { getFriendByLineUserIdForAccount } from '../friend-account-identity.js';

export async function getFriendByLineUserId(
  db: D1Database,
  lineUserId: string,
): Promise<Friend | null> {
  return db
    .prepare(`SELECT * FROM friends WHERE line_user_id = ? AND data_purged_at IS NULL AND (line_account_id IS NULL OR EXISTS (SELECT 1 FROM line_accounts a WHERE a.id=friends.line_account_id AND a.data_purged_at IS NULL))`)
    .bind(lineUserId)
    .first<Friend>();
}

export async function getFriendById(
  db: D1Database,
  id: string,
): Promise<Friend | null> {
  return db
    .prepare(`SELECT * FROM friends WHERE id = ? AND data_purged_at IS NULL AND (line_account_id IS NULL OR EXISTS (SELECT 1 FROM line_accounts a WHERE a.id=friends.line_account_id AND a.data_purged_at IS NULL))`)
    .bind(id)
    .first<Friend>();
}

/**
 * 友だち詳細用の1件取得。一覧（GET /api/friends?includeChatStatus=true）
 * と同じ `first_tracked_link_id → tracked_links.name` の LEFT JOIN で
 * 流入元名を添える。リンクが無い・消えている場合は null になる。
 */
export interface FriendWithFirstTrackedLinkName extends Friend {
  first_tracked_link_name: string | null;
}

export async function getFriendWithFirstTrackedLinkName(
  db: D1Database,
  id: string,
): Promise<FriendWithFirstTrackedLinkName | null> {
  return db
    .prepare(
      `SELECT f.*, tl.name AS first_tracked_link_name
         FROM friends f
         LEFT JOIN tracked_links tl ON tl.id = f.first_tracked_link_id
        WHERE f.id = ? AND f.data_purged_at IS NULL AND (f.line_account_id IS NULL OR EXISTS (SELECT 1 FROM line_accounts a WHERE a.id=f.line_account_id AND a.data_purged_at IS NULL))`,
    )
    .bind(id)
    .first<FriendWithFirstTrackedLinkName>();
}

/**
 * Set friend.first_tracked_link_id ONLY if it is currently NULL.
 * Used to authoritatively pin a friend to the campaign they entered through,
 * without ever overwriting once set. The conditional `WHERE ... IS NULL` clause
 * makes this safe against client-side ref tampering: an existing friend cannot
 * change their attribution by replaying /auth/callback or /api/liff/send-form-link
 * with a different ref.
 */
export async function setFriendFirstTrackedLinkIfNull(
  db: D1Database,
  friendId: string,
  trackedLinkId: string,
): Promise<void> {
  const now = jstNow();
  await db
    .prepare(
      `UPDATE friends
       SET first_tracked_link_id = ?, updated_at = ?
       WHERE id = ? AND first_tracked_link_id IS NULL`,
    )
    .bind(trackedLinkId, now, friendId)
    .run();
}

export interface UpsertFriendInput {
  lineUserId: string;
  /** 検索対象のLINE公式アカウント。複合 UNIQUE へ移るまでは未割当行へのフォールバックを残す。 */
  lineAccountId?: string | null;
  displayName?: string | null;
  pictureUrl?: string | null;
  statusMessage?: string | null;
  /** Signed LINE follow occurrence time; guard against older relationship events. */
  followOccurredAt?: string;
}

function isMissingFollowLifecycleColumn(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:no such column:|has no column named) (first_followed_at|current_follow_started_at|last_followed_at|last_unfollowed_at|unfollow_count)/i.test(message);
}

/**
 * friends.line_user_id のグローバル UNIQUE 違反。
 * グローバル UNIQUE 制約がある環境では、別アカウント所有の行が
 * あるとこのスコープ用の行を INSERT できない。呼出側は
 * 「このアカウントでは友だち行を作れない」として扱う。相手アカウントの行を
 * 更新したり返したりして履歴を混線させてはいけない。
 */
export function isFriendLineUserIdConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /unique constraint failed: friends\.line_user_id/i.test(message);
}

export async function upsertFriend(
  db: D1Database,
  input: UpsertFriendInput,
): Promise<Friend> {
  const now = jstNow();
  const followAt = input.followOccurredAt ?? now;
  if (input.lineAccountId) {
    const account = await db.prepare('SELECT id FROM line_accounts WHERE id=? AND data_purged_at IS NULL').bind(input.lineAccountId).first();
    if (!account) throw new Error('friend_account_unavailable');
  }
  let existing = await getFriendByLineUserIdForAccount(
    db,
    input.lineUserId,
    input.lineAccountId ?? null,
  );

  if (!existing) {
    const id = crypto.randomUUID();
    try {
      try {
        const inserted = await db.prepare(
          `INSERT INTO friends
             (id, line_user_id, line_account_id, display_name, picture_url, status_message, is_following,
              first_followed_at, current_follow_started_at, last_followed_at,
              created_at, updated_at)
           SELECT ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?
           WHERE ? IS NULL OR EXISTS (SELECT 1 FROM line_accounts a WHERE a.id=? AND a.data_purged_at IS NULL)`,
        ).bind(
          id,
          input.lineUserId,
          input.lineAccountId ?? null,
          input.displayName ?? null,
          input.pictureUrl ?? null,
          input.statusMessage ?? null,
          followAt,
          followAt,
          followAt,
          now,
          now,
          input.lineAccountId ?? null,
          input.lineAccountId ?? null,
        ).run();
        if (Number(inserted.meta.changes ?? 0) !== 1) throw new Error('friend_account_unavailable');
      } catch (error) {
        if (input.followOccurredAt || !isMissingFollowLifecycleColumn(error)) throw error;
        const inserted = await db.prepare(
          `INSERT INTO friends
             (id, line_user_id, line_account_id, display_name, picture_url, status_message, is_following,
              created_at, updated_at)
           SELECT ?, ?, ?, ?, ?, ?, 1, ?, ?
           WHERE ? IS NULL OR EXISTS (SELECT 1 FROM line_accounts a WHERE a.id=? AND a.data_purged_at IS NULL)`,
        ).bind(
          id,
          input.lineUserId,
          input.lineAccountId ?? null,
          input.displayName ?? null,
          input.pictureUrl ?? null,
          input.statusMessage ?? null,
          now,
          now,
          input.lineAccountId ?? null,
          input.lineAccountId ?? null,
        ).run();
        if (Number(inserted.meta.changes ?? 0) !== 1) throw new Error('friend_account_unavailable');
      }
      const created = await getFriendById(db, id);
      if (!created) throw new Error('friend_account_unavailable');
      return created;
    } catch (error) {
      if (!isFriendLineUserIdConflict(error)) throw error;
      // UNIQUE(line_user_id) に当たった = 別アカウント所有の行が占有しているか、
      // 並行して同じ行が作られた。同一スコープ(または未割当)の行だけを拾い直し、
      // 見つからなければこのスコープでは作れないので元のエラーを投げる。
      existing = await getFriendByLineUserIdForAccount(
        db,
        input.lineUserId,
        input.lineAccountId ?? null,
      );
      if (!existing) throw error;
    }
  }

  try {
    await db.prepare(
      `UPDATE friends
       SET display_name = ?,
           picture_url = ?,
           status_message = ?,
           line_account_id = COALESCE(line_account_id, ?),
           first_followed_at = COALESCE(first_followed_at, created_at),
           current_follow_started_at = CASE
             WHEN is_following = 0 OR current_follow_started_at IS NULL THEN ?
             ELSE current_follow_started_at
           END,
           last_followed_at = CASE
             WHEN ? IS NOT NULL OR is_following = 0 THEN ?
             ELSE COALESCE(last_followed_at, created_at)
           END,
           is_following = 1,
           updated_at = ?
       WHERE id = ? AND data_purged_at IS NULL
       AND (line_account_id IS NULL OR EXISTS (SELECT 1 FROM line_accounts a WHERE a.id=friends.line_account_id AND a.data_purged_at IS NULL))
       AND (? IS NULL OR EXISTS (SELECT 1 FROM line_accounts a WHERE a.id=? AND a.data_purged_at IS NULL))
       AND (? IS NULL OR julianday(?) > MAX(
         COALESCE(${followTimeSql('last_followed_at')},0), COALESCE(${followTimeSql('last_unfollowed_at')},0)))`,
    ).bind(
      'displayName' in input ? (input.displayName ?? null) : existing.display_name,
      'pictureUrl' in input ? (input.pictureUrl ?? null) : existing.picture_url,
      'statusMessage' in input ? (input.statusMessage ?? null) : existing.status_message,
      input.lineAccountId ?? null,
      followAt,
      input.followOccurredAt ?? null,
      followAt,
      now,
      existing.id,
      input.lineAccountId ?? null,
      input.lineAccountId ?? null,
      input.followOccurredAt ?? null,
      followAt,
    ).run();
  } catch (error) {
    if (input.followOccurredAt || !isMissingFollowLifecycleColumn(error)) throw error;
    // Deployments can briefly run newer Worker code before migration 065 is
    // applied. Preserve the friend-add/OAuth path using the legacy columns;
    // the lifecycle fields are backfilled when the migration is applied.
    await db.prepare(
      `UPDATE friends
       SET display_name = ?, picture_url = ?, status_message = ?,
           line_account_id = COALESCE(line_account_id, ?),
           is_following = 1, updated_at = ?
       WHERE id = ? AND data_purged_at IS NULL
         AND (line_account_id IS NULL OR EXISTS (SELECT 1 FROM line_accounts a WHERE a.id=friends.line_account_id AND a.data_purged_at IS NULL))
         AND (? IS NULL OR EXISTS (SELECT 1 FROM line_accounts a WHERE a.id=? AND a.data_purged_at IS NULL))`,
    ).bind(
      'displayName' in input ? (input.displayName ?? null) : existing.display_name,
      'pictureUrl' in input ? (input.pictureUrl ?? null) : existing.picture_url,
      'statusMessage' in input ? (input.statusMessage ?? null) : existing.status_message,
      input.lineAccountId ?? null,
      now,
      existing.id,
      input.lineAccountId ?? null,
      input.lineAccountId ?? null,
    ).run();
  }

  const current = await getFriendById(db, existing.id);
  if (!current) throw new Error('friend_account_unavailable');
  return current;
}

export async function updateFriendFollowStatus(
  db: D1Database,
  lineUserId: string,
  isFollowing: boolean,
  lineAccountId: string | null = null,
  occurredAt?: string,
): Promise<boolean | void> {
  const now = occurredAt ?? jstNow();
  let existing = await getFriendByLineUserIdForAccount(db, lineUserId, lineAccountId);
  if (!existing && !isFollowing && occurredAt) {
    const inserted = await db.prepare(`INSERT OR IGNORE INTO friends
      (id,line_user_id,line_account_id,is_following,last_unfollowed_at,created_at,updated_at)
      VALUES (?,?,?,0,?,?,?)`).bind(crypto.randomUUID(),lineUserId,lineAccountId,now,jstNow(),jstNow()).run();
    if (Number(inserted.meta?.changes ?? 0) === 1) return true;
    existing = await getFriendByLineUserIdForAccount(db, lineUserId, lineAccountId);
  }
  if (!existing) return false;
  if (isFollowing) {
    const applied = await db
      .prepare(
        `UPDATE friends
            SET first_followed_at = COALESCE(first_followed_at, created_at),
                current_follow_started_at = CASE
                  WHEN is_following = 0 OR current_follow_started_at IS NULL THEN ?
                  ELSE current_follow_started_at
                END,
                last_followed_at = CASE WHEN ? IS NOT NULL OR is_following = 0 THEN ? ELSE last_followed_at END,
                is_following = 1, updated_at = ?
          WHERE id = ? AND (? IS NULL OR julianday(?) > MAX(
            COALESCE(${followTimeSql('last_followed_at')},0),COALESCE(${followTimeSql('last_unfollowed_at')},0)))`,
      )
      .bind(now, occurredAt ?? null, now, now, existing.id, occurredAt ?? null, now)
      .run();
    return Number(applied.meta?.changes ?? 0) === 1;
  }
  const applied = await db
    .prepare(
      `UPDATE friends
          SET is_following = 0,
              current_follow_started_at = NULL,
              last_unfollowed_at = CASE WHEN ? IS NOT NULL OR is_following = 1 THEN ? ELSE last_unfollowed_at END,
              unfollow_count = unfollow_count + CASE WHEN is_following = 1 THEN 1 ELSE 0 END,
              updated_at = ?
        WHERE id = ? AND (? IS NULL OR julianday(?) > MAX(
            COALESCE(${followTimeSql('last_followed_at')},0),COALESCE(${followTimeSql('last_unfollowed_at')},0)))`,
    )
    .bind(occurredAt ?? null, now, now, existing.id, occurredAt ?? null, now)
    .run();
  return Number(applied.meta?.changes ?? 0) === 1;
}

/** Get merged metadata across all friend records sharing the same user_id (UUID). */
export async function getMergedMetadataByUserId(
  db: D1Database,
  userId: string,
  lineAccountId?: string | null,
): Promise<Record<string, unknown>> {
  if (!lineAccountId) return {};
  const result = await db
    .prepare(
      `SELECT f.metadata FROM friends f JOIN line_accounts a ON a.id=f.line_account_id
       WHERE f.user_id = ? AND COALESCE(a.tenant_id, ?) = (SELECT COALESCE(tenant_id, ?) FROM line_accounts WHERE id=?)
         AND f.metadata IS NOT NULL AND f.metadata != '{}'
       ORDER BY f.updated_at DESC`,
    )
    .bind(userId, DEFAULT_TENANT_ID, DEFAULT_TENANT_ID, lineAccountId)
    .all<{ metadata: string }>();
  const merged: Record<string, unknown> = {};
  for (const row of result.results) {
    try {
      const meta = JSON.parse(row.metadata);
      for (const [k, v] of Object.entries(meta)) {
        if (v != null && v !== '' && !(merged[k] != null && merged[k] !== '')) {
          merged[k] = v;
        }
      }
    } catch { /* skip invalid JSON */ }
  }
  return merged;
}

/**
 * 直近N日に友だち追加された人を「はじめて」と「以前から」で分けて数える
 * （設計 V2 4-6）。
 *
 * 分ける手がかりは `unfollow_count`。1回でもブロックされたことがあれば、
 * 今回の追加は「以前からの友だち」による再追加。
 *
 * 設計は「初回フォロー日が未記録なら、はじめて」と書いているが、
 * この基準はこのデータでは使えない。マイグレーション 065 が既存の行すべてに
 * `first_followed_at = created_at` を埋めたので、未記録の人はもういない。
 *
 * これは「以前からのお客さまに『はじめまして』が届いた数」でもある。
 * 追加時の配信を1本しか持てないうちは、returning の人数がそのまま
 * 誤って挨拶を送った人数になる。
 */
export async function getFriendAddBreakdown(
  db: D1Database,
  days: number,
  scope: { allowedAccountIds: readonly string[]; includeUnassigned: boolean } | { allTenants: true },
): Promise<{ days: number; firstTime: number; returning: number; unblocked: number }> {
  const allTenants = 'allTenants' in scope;
  const accountBinds = allTenants || !scope.allowedAccountIds.length ? [] : sqlIdSet(scope.allowedAccountIds).binds;
  const placeholders = accountBinds.length ? sqlIdSet((scope as { allowedAccountIds: readonly string[] }).allowedAccountIds).sql : '';
  const accountPredicate = allTenants
    ? '1 = 1'
    : placeholders
      ? `(line_account_id IN (${placeholders})${scope.includeUnassigned ? ' OR line_account_id IS NULL' : ''})`
      : scope.includeUnassigned ? 'line_account_id IS NULL' : '1 = 0';
  const accountClause = `AND ${accountPredicate}`;
  const binds: unknown[] = [days];
  binds.push(...accountBinds);
  const row = await db
    .prepare(
      `SELECT
         SUM(CASE WHEN COALESCE(unfollow_count, 0) = 0 THEN 1 ELSE 0 END) AS first_time,
         SUM(CASE WHEN COALESCE(unfollow_count, 0) > 0 THEN 1 ELSE 0 END) AS returning_count
       FROM friends
       WHERE data_purged_at IS NULL AND julianday('now', '+9 hours') - julianday(created_at) <= ?
         ${accountClause}`,
    )
    .bind(...binds)
    .first<{ first_time: number | null; returning_count: number | null }>();

  // ブロック解除で戻ってきた人。いまフォロー中で、外れたことがある人。
  const unblockBinds: unknown[] = [days];
  unblockBinds.push(...accountBinds);
  const unblockRow = await db
    .prepare(
      `SELECT COUNT(*) AS count
         FROM friends
        WHERE is_following = 1 AND data_purged_at IS NULL
          AND COALESCE(unfollow_count, 0) > 0
          AND last_followed_at IS NOT NULL
          AND julianday('now', '+9 hours') - julianday(last_followed_at) <= ?
          ${accountClause}`,
    )
    .bind(...unblockBinds)
    .first<{ count: number | null }>();

  return {
    days,
    firstTime: Number(row?.first_time ?? 0),
    returning: Number(row?.returning_count ?? 0),
    unblocked: Number(unblockRow?.count ?? 0),
  };
}
