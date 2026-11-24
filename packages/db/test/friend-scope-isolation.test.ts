import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, test } from 'vitest';

import {
  getFriendByLineUserIdForAccount,
  isFriendLineUserIdConflict,
  updateFriendFollowStatus,
  upsertFriend,
} from '../src/friends/index.js';

/**
 * 同一 LINE user ID が複数アカウントに存在するとき、
 * アカウントAの解決がアカウントBの friend 行を返したり、Bの行を
 * Aへ「移動」したりしてはいけない。
 *
 * 現行スキーマは line_user_id がグローバル UNIQUE で1ユーザー1行しか
 * 持てない（複合一意制約へは別の段で移る）。その制約の下で:
 * - 別アカウント所有の行は解決・更新・移動の対象にしない
 * - 未割当 (NULL) の行だけは、受信したアカウントへ明示的に引き当てる
 */

type BeforeWrite = (sql: string, sqlite: Database.Database) => void;

function asD1(sqlite: Database.Database, beforeWrite?: BeforeWrite): D1Database {
  const wrap = (sql: string, params: unknown[]) => ({
    async first<T>() {
      return (sqlite.prepare(sql).get(...params) as T) ?? null;
    },
    async run() {
      beforeWrite?.(sql, sqlite);
      return { success: true, meta: sqlite.prepare(sql).run(...params) };
    },
  });
  return {
    prepare(sql: string) {
      return { bind: (...params: unknown[]) => wrap(sql, params), ...wrap(sql, []) };
    },
  } as unknown as D1Database;
}

const FRIENDS_COLUMNS = `
  id TEXT PRIMARY KEY,
  display_name TEXT,
  picture_url TEXT,
  status_message TEXT,
  is_following INTEGER NOT NULL DEFAULT 1,
  first_followed_at TEXT,
  current_follow_started_at TEXT,
  last_followed_at TEXT,
  last_unfollowed_at TEXT,
  unfollow_count INTEGER NOT NULL DEFAULT 0,
  user_id TEXT,
  line_account_id TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  first_tracked_link_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
`;

const databases: Database.Database[] = [];

function makeDb(opts: { globalUniqueLineUserId: boolean; beforeWrite?: BeforeWrite }) {
  const sqlite = new Database(':memory:');
  databases.push(sqlite);
  const lineUserIdColumn = opts.globalUniqueLineUserId
    ? 'line_user_id TEXT NOT NULL UNIQUE'
    : 'line_user_id TEXT NOT NULL';
  sqlite.exec(`CREATE TABLE line_accounts(id TEXT PRIMARY KEY, tenant_id TEXT);
    INSERT INTO line_accounts(id,tenant_id) VALUES ('account-a',NULL),('account-b',NULL),('account-c',NULL);
    CREATE TABLE friends (${lineUserIdColumn}, ${FRIENDS_COLUMNS});`);
  return { sqlite, db: asD1(sqlite, opts.beforeWrite) };
}

function insertFriend(
  sqlite: Database.Database,
  row: { id: string; lineUserId: string; accountId: string | null; displayName?: string },
) {
  sqlite
    .prepare(
      `INSERT INTO friends
        (id, line_user_id, display_name, line_account_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, '2026-08-23T00:00:00Z', '2026-08-23T00:00:00Z')`,
    )
    .run(row.id, row.lineUserId, row.displayName ?? row.id, row.accountId);
}

function friendRow(sqlite: Database.Database, id: string) {
  return sqlite.prepare('SELECT * FROM friends WHERE id = ?').get(id) as {
    id: string;
    line_account_id: string | null;
    is_following: number;
    display_name: string | null;
  };
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe('現行スキーマ (line_user_id グローバルUNIQUE) でのスコープ分離', () => {
  test('アカウントB所有の行はアカウントAの解決で返さない', async () => {
    const { sqlite, db } = makeDb({ globalUniqueLineUserId: true });
    insertFriend(sqlite, { id: 'friend-b', lineUserId: 'U-shared', accountId: 'account-b' });

    const friend = await getFriendByLineUserIdForAccount(db, 'U-shared', 'account-a');

    expect(friend).toBeNull();
    expect(friendRow(sqlite, 'friend-b').line_account_id).toBe('account-b');
  });

  test('アカウントB所有の行があるとき、アカウントAの upsertFriend は競合で失敗しBの行を変えない', async () => {
    const { sqlite, db } = makeDb({ globalUniqueLineUserId: true });
    insertFriend(sqlite, { id: 'friend-b', lineUserId: 'U-shared', accountId: 'account-b' });

    // 複合一意制約が無いうちは A 用の行を作れない。失敗が呼出側へ
    // 返ることで「friend=B・送信元=A」の履歴が作られない。
    const error = await upsertFriend(db, {
      lineUserId: 'U-shared',
      lineAccountId: 'account-a',
      displayName: '乗っ取り名',
    }).then(
      () => null,
      (err: unknown) => err,
    );

    expect(error).not.toBeNull();
    expect(isFriendLineUserIdConflict(error)).toBe(true);

    const row = friendRow(sqlite, 'friend-b');
    expect(row.line_account_id).toBe('account-b');
    expect(row.display_name).toBe('friend-b');
    expect(row.is_following).toBe(1);
    expect(
      (sqlite.prepare('SELECT COUNT(*) AS c FROM friends').get() as { c: number }).c,
    ).toBe(1);
  });

  test('アカウントB所有の行への unfollow (アカウントA受信) はBの行を変えない', async () => {
    const { sqlite, db } = makeDb({ globalUniqueLineUserId: true });
    insertFriend(sqlite, { id: 'friend-b', lineUserId: 'U-shared', accountId: 'account-b' });

    await updateFriendFollowStatus(db, 'U-shared', false, 'account-a');

    expect(friendRow(sqlite, 'friend-b').is_following).toBe(1);
  });

  test('古いフォローイベントは未割当の所有権とフォロー状態を変えない', async () => {
    const { sqlite, db } = makeDb({ globalUniqueLineUserId: true });
    insertFriend(sqlite, { id: 'friend-u', lineUserId: 'U-free', accountId: null });
    sqlite.prepare(`UPDATE friends SET is_following = 0, last_unfollowed_at = ?
      WHERE id = 'friend-u'`).run('2026-08-25T00:00:00.000+09:00');

    const friend = await upsertFriend(db, {
      lineUserId: 'U-free',
      lineAccountId: 'account-a',
      followOccurredAt: '2026-08-24T00:00:00.000+09:00',
      displayName: '以前の名前',
    });

    expect(friend).toMatchObject({ id: 'friend-u', line_account_id: null, is_following: 0, display_name: 'friend-u' });
    expect(friendRow(sqlite, 'friend-u')).toMatchObject({ line_account_id: null, is_following: 0 });
  });

  test('未割当の行は upsertFriend が受信アカウントへ引き当てる', async () => {
    const { sqlite, db } = makeDb({ globalUniqueLineUserId: true });
    insertFriend(sqlite, { id: 'friend-u', lineUserId: 'U-free', accountId: null });

    const friend = await upsertFriend(db, {
      lineUserId: 'U-free',
      lineAccountId: 'account-a',
      displayName: '未割当だった人',
    });

    expect(friend.id).toBe('friend-u');
    expect(friend.line_account_id).toBe('account-a');
    expect(
      (sqlite.prepare('SELECT COUNT(*) AS c FROM friends').get() as { c: number }).c,
    ).toBe(1);
  });
});

function assignToAccountBBeforeUpdate(sql: string, sqlite: Database.Database) {
  if (sql.startsWith('UPDATE friends')) {
    sqlite.prepare("UPDATE friends SET line_account_id = 'account-b' WHERE id = 'friend-u' AND line_account_id IS NULL").run();
  }
}

describe('未割当の行を別アカウントが先に引き当てた場合', () => {
  test('別々の店舗が同時に追加しても、移行済みDBではどちらも保存される', async () => {
    const sqlite = new Database(':memory:');
    databases.push(sqlite);
    sqlite.exec(readFileSync(new URL('../bootstrap.sql', import.meta.url), 'utf8'));
    sqlite.exec(`INSERT INTO line_accounts(id, name, channel_id, channel_secret, channel_access_token)
      VALUES ('account-a', 'A', '1001', 'fixture', 'fixture'), ('account-b', 'B', '1002', 'fixture', 'fixture')`);
    insertFriend(sqlite, { id: 'legacy', lineUserId: 'U-shared', accountId: null });
    const db = asD1(sqlite);

    const [a, b] = await Promise.all([
      upsertFriend(db, { lineUserId: 'U-shared', lineAccountId: 'account-a', displayName: 'Aでの表示名' }),
      upsertFriend(db, { lineUserId: 'U-shared', lineAccountId: 'account-b', displayName: 'Bでの表示名' }),
    ]);

    expect(a).toMatchObject({ line_user_id: 'U-shared', line_account_id: 'account-a', display_name: 'Aでの表示名' });
    expect(b).toMatchObject({ line_user_id: 'U-shared', line_account_id: 'account-b', display_name: 'Bでの表示名' });
    expect(a.id).not.toBe(b.id);
    expect([a.id, b.id]).toContain('legacy');
  });

  test('upsertFriend は引き当て先のプロフィールを変更せず、行を返さない', async () => {
    const { sqlite, db } = makeDb({ globalUniqueLineUserId: true, beforeWrite: assignToAccountBBeforeUpdate });
    insertFriend(sqlite, { id: 'friend-u', lineUserId: 'U-free', accountId: null });

    await expect(upsertFriend(db, {
      lineUserId: 'U-free',
      lineAccountId: 'account-a',
      displayName: 'A経由の名前',
    })).rejects.toThrow('friend_account_scope_changed');

    expect(friendRow(sqlite, 'friend-u')).toMatchObject({ line_account_id: 'account-b', display_name: 'friend-u' });
  });

  test.each([true, false])('フォロー状態を別アカウントから変更しない（isFollowing=%s）', async (isFollowing) => {
    const { sqlite, db } = makeDb({ globalUniqueLineUserId: true, beforeWrite: assignToAccountBBeforeUpdate });
    insertFriend(sqlite, { id: 'friend-u', lineUserId: 'U-free', accountId: null });
    const previous = isFollowing ? 0 : 1;
    sqlite.prepare("UPDATE friends SET is_following = ? WHERE id = 'friend-u'").run(previous);

    expect(await updateFriendFollowStatus(db, 'U-free', isFollowing, 'account-a')).toBe(false);

    expect(friendRow(sqlite, 'friend-u')).toMatchObject({ line_account_id: 'account-b', is_following: previous });
  });
});

describe('同一 line_user_id の行がアカウントごとに並存する場合 (C-2b後の形)', () => {
  test('AとBそれぞれの行が独立して解決される', async () => {
    const { sqlite, db } = makeDb({ globalUniqueLineUserId: false });
    insertFriend(sqlite, { id: 'friend-a', lineUserId: 'U-shared', accountId: 'account-a' });
    insertFriend(sqlite, { id: 'friend-b', lineUserId: 'U-shared', accountId: 'account-b' });

    expect((await getFriendByLineUserIdForAccount(db, 'U-shared', 'account-a'))?.id).toBe('friend-a');
    expect((await getFriendByLineUserIdForAccount(db, 'U-shared', 'account-b'))?.id).toBe('friend-b');
    expect(await getFriendByLineUserIdForAccount(db, 'U-shared', 'account-c')).toBeNull();
  });

  test('同じアカウントの同時登録は複合一意制約のもとで1件に収束する', async () => {
    const { sqlite, db } = makeDb({ globalUniqueLineUserId: false });
    sqlite.exec('CREATE UNIQUE INDEX friends_account_uid ON friends (line_account_id, line_user_id)');
    const input = { lineUserId: 'U-shared', lineAccountId: 'account-a' };

    const [one, two] = await Promise.all([upsertFriend(db, input), upsertFriend(db, input)]);

    expect(one.id).toBe(two.id);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM friends').get()).toEqual({ count: 1 });
  });

  test('同じアカウントの行が並行して作られたとき、未割当の履歴を混ぜない', async () => {
    const { sqlite, db } = makeDb({
      globalUniqueLineUserId: false,
      beforeWrite(sql, raw) {
        if (sql.startsWith('UPDATE friends')) {
          insertFriend(raw, { id: 'friend-a', lineUserId: 'U-shared', accountId: 'account-a' });
        }
      },
    });
    sqlite.exec('CREATE UNIQUE INDEX friends_account_uid ON friends (line_account_id, line_user_id)');
    insertFriend(sqlite, { id: 'friend-u', lineUserId: 'U-shared', accountId: null });

    const friend = await upsertFriend(db, { lineUserId: 'U-shared', lineAccountId: 'account-a' });

    expect(friend.id).toBe('friend-a');
    expect(friendRow(sqlite, 'friend-u').line_account_id).toBeNull();
  });

  test('upsertFriend は自分のアカウントの行だけを更新する', async () => {
    const { sqlite, db } = makeDb({ globalUniqueLineUserId: false });
    insertFriend(sqlite, { id: 'friend-a', lineUserId: 'U-shared', accountId: 'account-a' });
    insertFriend(sqlite, { id: 'friend-b', lineUserId: 'U-shared', accountId: 'account-b' });

    const updated = await upsertFriend(db, {
      lineUserId: 'U-shared',
      lineAccountId: 'account-a',
      displayName: 'A経由の名前',
    });

    expect(updated.id).toBe('friend-a');
    expect(friendRow(sqlite, 'friend-a').display_name).toBe('A経由の名前');
    expect(friendRow(sqlite, 'friend-b').display_name).toBe('friend-b');
    expect(friendRow(sqlite, 'friend-b').line_account_id).toBe('account-b');
  });

  test('unfollow も自分のアカウントの行だけに効く', async () => {
    const { sqlite, db } = makeDb({ globalUniqueLineUserId: false });
    insertFriend(sqlite, { id: 'friend-a', lineUserId: 'U-shared', accountId: 'account-a' });
    insertFriend(sqlite, { id: 'friend-b', lineUserId: 'U-shared', accountId: 'account-b' });

    await updateFriendFollowStatus(db, 'U-shared', false, 'account-a');

    expect(friendRow(sqlite, 'friend-a').is_following).toBe(0);
    expect(friendRow(sqlite, 'friend-b').is_following).toBe(1);
  });
});
