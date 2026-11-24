import { jstNow } from './utils.js';
import { DEFAULT_TENANT_ID } from '@line-crm/shared';
// =============================================================================
// Users — Internal UUID Cross-Account System
// =============================================================================

export interface User {
  id: string;
  tenant_id: string | null;
  email: string | null;
  phone: string | null;
  external_id: string | null;
  display_name: string | null;
  /** active / review / archived。archived は一覧・詳細・照合から外す。 */
  status: string;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateUserInput {
  email?: string | null;
  phone?: string | null;
  externalId?: string | null;
  displayName?: string | null;
  tenantId?: string | null;
  createdBy?: string | null;
}

export interface UserAccessScope {
  tenantId: string;
  allowedAccountIds: string[];
  includeUnlinked: boolean;
}

const ACCESSIBLE_USER_PREDICATE = `
  COALESCE(u.status, 'active') <> 'archived'
  AND (
    u.tenant_id = ?
    OR (
      u.tenant_id IS NULL
      AND EXISTS (
        SELECT 1
          FROM friends tenant_friend
          JOIN line_accounts tenant_account ON tenant_account.id = tenant_friend.line_account_id
         WHERE tenant_friend.user_id = u.id
           AND COALESCE(tenant_account.tenant_id, '${DEFAULT_TENANT_ID}') = ?
      )
      AND NOT EXISTS (
        SELECT 1
          FROM friends foreign_friend
          JOIN line_accounts foreign_account ON foreign_account.id = foreign_friend.line_account_id
         WHERE foreign_friend.user_id = u.id
           AND COALESCE(foreign_account.tenant_id, '${DEFAULT_TENANT_ID}') <> ?
      )
    )
  )
  AND (
    (
      ? = 1
      AND u.tenant_id = ?
      AND NOT EXISTS (SELECT 1 FROM friends unlinked_friend WHERE unlinked_friend.user_id = u.id)
    )
    OR (
      EXISTS (SELECT 1 FROM friends linked_friend WHERE linked_friend.user_id = u.id)
      AND NOT EXISTS (
        SELECT 1
          FROM friends scoped_friend
          LEFT JOIN line_accounts scoped_account ON scoped_account.id = scoped_friend.line_account_id
         WHERE scoped_friend.user_id = u.id
           AND (
             COALESCE(scoped_account.tenant_id, '${DEFAULT_TENANT_ID}') <> ?
             OR scoped_friend.line_account_id NOT IN (SELECT value FROM json_each(?))
           )
      )
    )
  )`;

function accessBindings(scope: UserAccessScope): unknown[] {
  return [
    scope.tenantId,
    scope.tenantId,
    scope.tenantId,
    scope.includeUnlinked ? 1 : 0,
    scope.tenantId,
    scope.tenantId,
    JSON.stringify(scope.allowedAccountIds),
  ];
}

export async function createUser(
  db: D1Database,
  input: CreateUserInput,
): Promise<User> {
  const id = crypto.randomUUID();
  const now = jstNow();

  await db
    .prepare(
      `INSERT INTO users (
         id, email, phone, external_id, display_name, tenant_id, created_by, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.email ?? null,
      input.phone ?? null,
      input.externalId ?? null,
      input.displayName ?? null,
      input.tenantId ?? null,
      input.createdBy ?? null,
      now,
      now,
    )
    .run();

  return (await getUserById(db, id))!;
}

export async function getUserByIdForAccess(
  db: D1Database,
  id: string,
  scope: UserAccessScope,
): Promise<User | null> {
  return db.prepare(
    `SELECT u.* FROM users u WHERE u.id = ? AND ${ACCESSIBLE_USER_PREDICATE}`,
  ).bind(id, ...accessBindings(scope)).first<User>();
}

export async function getUsersForAccess(
  db: D1Database,
  scope: UserAccessScope,
): Promise<User[]> {
  const result = await db.prepare(
    `SELECT u.* FROM users u WHERE ${ACCESSIBLE_USER_PREDICATE} ORDER BY u.created_at DESC`,
  ).bind(...accessBindings(scope)).all<User>();
  return result.results;
}

export async function getUserByEmailForAccess(
  db: D1Database,
  email: string,
  scope: UserAccessScope,
): Promise<User | null> {
  return db.prepare(
    `SELECT u.* FROM users u WHERE u.email = ? AND ${ACCESSIBLE_USER_PREDICATE}`,
  ).bind(email, ...accessBindings(scope)).first<User>();
}

export async function getUserByPhoneForAccess(
  db: D1Database,
  phone: string,
  scope: UserAccessScope,
): Promise<User | null> {
  return db.prepare(
    `SELECT u.* FROM users u WHERE u.phone = ? AND ${ACCESSIBLE_USER_PREDICATE}`,
  ).bind(phone, ...accessBindings(scope)).first<User>();
}

export async function getUserById(
  db: D1Database,
  id: string,
): Promise<User | null> {
  return db.prepare(`SELECT * FROM users WHERE id = ?`).bind(id).first<User>();
}

export async function getUsers(db: D1Database): Promise<User[]> {
  const result = await db
    .prepare(`SELECT * FROM users ORDER BY created_at DESC`)
    .all<User>();
  return result.results;
}

export async function getUserByEmail(
  db: D1Database,
  email: string,
): Promise<User | null> {
  return db
    .prepare(`SELECT * FROM users WHERE email = ?`)
    .bind(email)
    .first<User>();
}

export async function getUserByPhone(
  db: D1Database,
  phone: string,
): Promise<User | null> {
  return db
    .prepare(`SELECT * FROM users WHERE phone = ?`)
    .bind(phone)
    .first<User>();
}

export type UpdateUserInput = Partial<
  Pick<User, 'email' | 'phone' | 'external_id' | 'display_name'>
>;

export async function updateUser(
  db: D1Database,
  id: string,
  updates: UpdateUserInput,
): Promise<User | null> {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.email !== undefined) {
    fields.push('email = ?');
    values.push(updates.email);
  }
  if (updates.phone !== undefined) {
    fields.push('phone = ?');
    values.push(updates.phone);
  }
  if (updates.external_id !== undefined) {
    fields.push('external_id = ?');
    values.push(updates.external_id);
  }
  if (updates.display_name !== undefined) {
    fields.push('display_name = ?');
    values.push(updates.display_name);
  }

  if (fields.length === 0) return getUserById(db, id);

  fields.push('updated_at = ?');
  values.push(jstNow());
  values.push(id);

  await db
    .prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`)
    .bind(...values)
    .run();

  return getUserById(db, id);
}

export async function deleteUser(db: D1Database, id: string): Promise<void> {
  await db.prepare(`DELETE FROM users WHERE id = ?`).bind(id).run();
}

export interface UserRelationCounts {
  /** user_id が付いた友だちの件数。 */
  friends: number;
  /** 解除していない名寄せの結びつきの件数。 */
  activeLinks: number;
}

/** 物理削除の前に確かめる関連の件数。孤立した user_id を作らないため。 */
export async function getUserRelationCounts(db: D1Database, id: string): Promise<UserRelationCounts> {
  const friends = await db.prepare(
    `SELECT COUNT(*) AS total FROM friends WHERE user_id = ?`,
  ).bind(id).first<{ total: number }>();
  const links = await db.prepare(
    `SELECT COUNT(*) AS total FROM friend_identity_links WHERE user_id = ? AND unlinked_at IS NULL`,
  ).bind(id).first<{ total: number }>();
  return { friends: Number(friends?.total ?? 0), activeLinks: Number(links?.total ?? 0) };
}

/**
 * 通常の削除操作。行は消さず退避（archive）にする。
 * 履歴・監査・支払の記録が user_id で残っていても壊れない。
 */
export async function archiveUser(db: D1Database, id: string): Promise<User | null> {
  const now = jstNow();
  await db.prepare(
    `UPDATE users SET status = 'archived', archived_at = COALESCE(archived_at, ?), updated_at = ? WHERE id = ?`,
  ).bind(now, now, id).run();
  return getUserById(db, id);
}

export interface RelinkActor {
  id: string | null;
  reason?: string;
}

/*
 * 友だちを本人へ結ぶときは、結び直しの競合対策と
 * マイルの移管の両方を行う。
 * 古い候補の有効な結び付き行も外す（friendsだけ付け替えると古い取消が
 * 新しい結び付きを消す）。外した行は理由付きで残す。
 * 結ぶ前に友だち宛てへ付いた台帳・ロット・財布を本人キーへ移す
 * （行は消さず、再実行しても重複しない）。
 * 両本人の版を付け替え成功時だけ進め、競合時はfalseで409にする。
 */
export async function linkFriendToUser(
  db: D1Database,
  friendId: string,
  userId: string,
  actor: RelinkActor | null = null,
): Promise<boolean> {
  // Identity and wallet operations must share a tenant even for legacy NULL users.
  const boundary = await db.prepare(`SELECT f.id FROM friends f
    LEFT JOIN line_accounts a ON a.id=f.line_account_id
    JOIN users u ON u.id=?
    WHERE f.id=? AND COALESCE(u.status,'active') <> 'archived'
      AND COALESCE(u.tenant_id, COALESCE(a.tenant_id, ?)) = COALESCE(a.tenant_id, ?)
      AND NOT EXISTS (SELECT 1 FROM friends other
        LEFT JOIN line_accounts oa ON oa.id=other.line_account_id
        WHERE other.user_id=u.id AND COALESCE(oa.tenant_id, ?) <> COALESCE(a.tenant_id, ?))
      AND (u.tenant_id IS NOT NULL OR COALESCE(a.tenant_id, ?)=?
        OR EXISTS (SELECT 1 FROM friends own JOIN line_accounts own_a ON own_a.id=own.line_account_id
          WHERE own.user_id=u.id AND COALESCE(own_a.tenant_id,?)=COALESCE(a.tenant_id,?)))
  `).bind(userId,friendId,...Array(8).fill(DEFAULT_TENANT_ID)).first();
  if (!boundary) return false;
  const now = jstNow();
  const userKey = `user:${userId}`;
  const friendKey = `friend:${friendId}`;
  const migrateMileage = async (): Promise<void> => {
    await db.batch([
      db.prepare(
        `UPDATE mileage_ledger SET beneficiary_user_id = ?
          WHERE beneficiary_friend_id = ? AND beneficiary_user_id IS NULL`,
      ).bind(userId, friendId),
      db.prepare(
        `UPDATE mileage_grant_lots SET beneficiary_key = ?
          WHERE beneficiary_key = ?`,
      ).bind(userKey, friendKey),
      // 友だち名義の財布を本人の財布へ足す。本人の財布があれば残高を合算し、
      // なければそのまま本人名義にする。そのあと友だち名義の行を消す。
      db.prepare(
        `INSERT INTO mileage_wallets
           (program_id, beneficiary_key, beneficiary_user_id, beneficiary_friend_id,
            available, pending, version, updated_at)
         SELECT program_id, ?, ?, NULL, available, pending, 1, ?
           FROM mileage_wallets WHERE beneficiary_key = ?
         ON CONFLICT(program_id, beneficiary_key) DO UPDATE SET
           available = mileage_wallets.available + excluded.available,
           pending = mileage_wallets.pending + excluded.pending,
           version = mileage_wallets.version + 1,
           updated_at = excluded.updated_at`,
      ).bind(userKey, userId, now, friendKey),
      db.prepare(`DELETE FROM mileage_wallets WHERE beneficiary_key = ?`).bind(friendKey),
    ]);
  };
  const current = await db
    .prepare(`SELECT user_id FROM friends WHERE id = ?`)
    .bind(friendId)
    .first<{ user_id: string | null }>();
  if (!current) return false;
  const before = current.user_id ?? null;
  if (before === userId) {
    await migrateMileage();
    return true;
  }
  const expectedGuard = `EXISTS (SELECT 1 FROM friends WHERE id = ? AND user_id IS ?)`;
  /*
   * 版進めも付け替えが効いたときだけ行う。競合で付け替えが0件なら
   * 版も触らず、false（変更0）と対にする。
   */
  const movedGuard = `EXISTS (SELECT 1 FROM friends WHERE id = ? AND user_id = ?)`;
  const results = await db.batch([
    db.prepare(
      `UPDATE friend_identity_links
          SET unlinked_by = ?, unlinked_at = ?, unlink_reason = ?
        WHERE friend_id = ? AND unlinked_at IS NULL AND ${expectedGuard}`,
    ).bind(
      actor?.id ?? null, now,
      actor?.reason ?? '別の統合ユーザーへ結び直しました',
      friendId, friendId, before,
    ),
    db.prepare(
      `UPDATE friends SET user_id = ?, updated_at = ? WHERE id = ? AND user_id IS ?`,
    ).bind(userId, now, friendId, before),
    ...(before && before !== userId
      ? [db.prepare(
        `UPDATE users SET revision = revision + 1, updated_at = ? WHERE id = ? AND ${movedGuard}`,
      ).bind(now, before, friendId, userId)]
      : []),
    db.prepare(
      `UPDATE users SET revision = revision + 1, updated_at = ? WHERE id = ? AND ${movedGuard}`,
    ).bind(now, userId, friendId, userId),
  ]);
  /*
   * 結び付きが変わるので両本人の版を進める。後に開いた保存は409になる。
   * friends の付け替えが0件＝別の人が先に動かした＝結び付き行も触っていない
   *（同じ条件のため）ので false で知らせる。マイル移管は成功時だけ行う。
   */
  const moved = Number(results[1]?.meta?.changes ?? 0) === 1;
  if (!moved) return false;
  await migrateMileage();
  return true;
}

export async function getUserFriends(
  db: D1Database,
  userId: string,
): Promise<{ id: string; line_user_id: string; display_name: string | null; is_following: number }[]> {
  const result = await db
    .prepare(`SELECT id, line_platform_user_id AS line_user_id, display_name, is_following FROM friends WHERE user_id = ?`)
    .bind(userId)
    .all<{ id: string; line_user_id: string; display_name: string | null; is_following: number }>();
  return result.results;
}
