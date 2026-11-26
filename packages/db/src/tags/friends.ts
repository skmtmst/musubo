import { tagReadPredicate, type TagReadScope } from '../tag-lists.js';
import type { Friend } from '../friends/types/index.js';
import { normalizeFriendLineUserId, type StoredFriend } from '../friend-account-identity.js';
import { type Tag } from './types.js';


export async function removeTagFromFriend(
  db: D1Database,
  friendId: string,
  tagId: string,
): Promise<void> {
  await db
    .prepare(
      `DELETE FROM friend_tags WHERE friend_id = ? AND tag_id = ?`,
    )
    .bind(friendId, tagId)
    .run();
}

export async function getFriendTags(
  db: D1Database,
  friendId: string,
): Promise<Tag[]> {
  const result = await db
    .prepare(
      `SELECT t.*, fo.color AS folder_color
       FROM tags t
       INNER JOIN friend_tags ft ON ft.tag_id = t.id
       LEFT JOIN folders fo ON fo.id = t.folder_id
       WHERE ft.friend_id = ?
       ORDER BY t.name ASC`,
    )
    .bind(friendId)
    .all<Tag>();
  return result.results;
}

/**
 * 表示中の友だちのタグを1回で取得する。
 * ID配列はjson_eachへ1バインドで渡し、D1のバインド数上限にも依存しない。
 */
export async function getFriendTagsByFriendIds(
  db: D1Database,
  friendIds: string[],
): Promise<Map<string, Tag[]>> {
  if (friendIds.length === 0) return new Map();
  const result = await db
    .prepare(
      `SELECT ft.friend_id, t.*, fo.color AS folder_color
       FROM friend_tags ft
       INNER JOIN tags t ON t.id = ft.tag_id
       LEFT JOIN folders fo ON fo.id = t.folder_id
       WHERE ft.friend_id IN (SELECT CAST(value AS TEXT) FROM json_each(?))
       ORDER BY ft.friend_id ASC, t.name ASC`,
    )
    .bind(JSON.stringify(friendIds))
    .all<Tag & { friend_id: string }>();

  const byFriendId = new Map<string, Tag[]>();
  for (const row of result.results) {
    const tags = byFriendId.get(row.friend_id) ?? [];
    tags.push(row);
    byFriendId.set(row.friend_id, tags);
  }
  return byFriendId;
}

export async function getFriendsByTag(
  db: D1Database,
  tagId: string,
  lineAccountId?: string | null,
  scope?: TagReadScope,
): Promise<Friend[]> {
  const predicate = scope ? tagReadPredicate(scope, 'f') : undefined;
  const friendSource = predicate ? `(SELECT * FROM friends f WHERE ${predicate.sql}) f` : 'friends f';
  const accountClause = lineAccountId ? ' AND f.line_account_id = ?' : '';
  const bindings = lineAccountId ? [tagId, lineAccountId] : [tagId];
  const result = await db
    .prepare(
      `SELECT f.*
       FROM ${friendSource}
       INNER JOIN friend_tags ft ON ft.friend_id = f.id
       WHERE ft.tag_id = ?${accountClause}
       ORDER BY f.created_at DESC`,
    )
    .bind(...(predicate?.binds ?? []), ...bindings)
    .all<StoredFriend>();
  return result.results.map(normalizeFriendLineUserId);
}
