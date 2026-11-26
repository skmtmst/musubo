import { describe, expect, test, vi } from 'vitest';
import { createTestD1 } from '../test-utils/d1-sqlite.js';
import {
  detectFollowerImportCapability,
  getFollowerImportState,
  processFollowerImportStep,
  startFollowerImport,
} from './follower-import.js';

const uid = (hex: string) => `U${hex.repeat(32)}`;

type StoredFriend = {
  id: string;
  line_user_id: string;
  line_account_id: string | null;
  is_following: number;
  display_name: string | null;
  picture_url: string | null;
  status_message: string | null;
};

/** 連番から LINE の利用者IDを作る。`/^U[0-9a-f]{32}$/` に合わせる。 */
const userIdFor = (index: number) => `U${index.toString(16).padStart(32, '0')}`;

/** プロフィール未取得（display_name が NULL）の友だち行を count 件作る。 */
const seedFriends = (count: number, accountId = 'acc-1'): StoredFriend[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `f-${String(i).padStart(3, '0')}`,
    line_user_id: userIdFor(i),
    line_account_id: accountId,
    is_following: 1,
    display_name: null,
    picture_url: null,
    status_message: null,
  }));

/**
 * 書き戻しの失敗を差し込むための口。
 * `failProfileWriteFor` に friends.id を入れておくと、その行を含む
 * プロフィール書き戻しの `db.batch` が落ちる。テスト中に出し入れできる。
 */
interface DbControl {
  failProfileWriteFor?: Set<string>;
  /** プロフィール未取得の行を読みにきたときに、その時点の保存済み状態を渡す。 */
  onProfilePageQuery?: (stored: string | null) => void;
}

function makeDb(initialFriends: StoredFriend[] = [], control: DbControl = {}) {
  let setting: string | null = null;
  const friends = new Map(initialFriends.map((f) => [f.line_user_id, { ...f }]));

  /**
   * friends への書き込み文に付いている所有権の条件を、本物と同じに判定する。
   * 条件の値は bind の末尾に足されるので、最後の引数が保存済みの状態と
   * 一致しているかを見る。一致しなければ「交代済み」で、その文は 1 行も書けない。
   */
  const ownershipHolds = (sql: string, args: unknown[]) =>
    !sql.includes('FROM account_settings') || setting === args[args.length - 1];

  const execute = (sql: string, args: unknown[]) => {
    if (sql.includes('INSERT INTO account_settings')) {
      setting = args[3] as string;
      return { meta: { changes: 1 } };
    }
    if (sql.includes('UPDATE account_settings')) {
      if (setting !== args[4]) return { meta: { changes: 0 } };
      setting = args[0] as string;
      return { meta: { changes: 1 } };
    }
    if (sql.includes('UPDATE friends SET line_account_id')) {
      if (!ownershipHolds(sql, args)) return { meta: { changes: 0 } };
      const [accountId, , lineUserId] = args as [string, string, string];
      const existing = friends.get(lineUserId);
      if (!existing || existing.line_account_id !== null) return { meta: { changes: 0 } };
      existing.line_account_id = accountId;
      existing.is_following = 1;
      return { meta: { changes: 1 } };
    }
    if (sql.includes('INSERT INTO friends')) {
      if (!ownershipHolds(sql, args)) return { meta: { changes: 0 } };
      const [id, storedUserId, accountId] = args as [string, string, string];
      const lineUserId = storedUserId.replace(`musubo-scope:${id}:`, '');
      const existing = friends.get(lineUserId);
      if (!existing) {
        friends.set(lineUserId, {
          id,
          line_user_id: lineUserId,
          line_account_id: accountId,
          is_following: 1,
          display_name: null,
          picture_url: null,
          status_message: null,
        });
        return { meta: { changes: 1 }, results: [{ id }] };
      }
      if (existing.is_following === 1) return { meta: { changes: 0 }, results: [] };
      existing.is_following = 1;
      return { meta: { changes: 1 }, results: [{ id: existing.id }] };
    }
    if (sql.includes('UPDATE friends') && sql.includes('display_name')) {
      if (!ownershipHolds(sql, args)) return { meta: { changes: 0 } };
      const [displayName, pictureUrl, statusMessage, , id, accountId] = args;
      const row = [...friends.values()].find((f) => f.id === id && f.line_account_id === accountId
        && f.is_following === 1 && f.display_name === null);
      if (row) {
        row.display_name = displayName as string | null;
        row.picture_url = pictureUrl as string | null;
        row.status_message = statusMessage as string | null;
      }
      return { meta: { changes: row ? 1 : 0 } };
    }
    throw new Error(`Unhandled run SQL: ${sql}`);
  };

  const db = {
    prepare: vi.fn((sql: string) => ({
      bind: (...args: unknown[]) => ({
        sql,
        args,
        first: vi.fn().mockImplementation(async () => {
          if (sql.includes('SELECT value FROM account_settings')) {
            return setting === null ? null : { value: setting };
          }
          throw new Error(`Unhandled first SQL: ${sql}`);
        }),
        all: vi.fn().mockImplementation(async () => {
          if (sql.includes('AND display_name IS NULL')) {
            const [accountId, afterId, limit] = args as [string, string, number];
            control.onProfilePageQuery?.(setting);
            return {
              results: [...friends.values()]
                .filter((f) => f.line_account_id === accountId && f.is_following === 1 &&
                  f.display_name === null && f.id > afterId)
                .sort((a, b) => a.id.localeCompare(b.id))
                .slice(0, limit)
                .map(({ id, line_user_id }) => ({ id, line_user_id })),
            };
          }
          throw new Error(`Unhandled all SQL: ${sql}`);
        }),
        run: vi.fn().mockImplementation(async () => execute(sql, args)),
      }),
    })),
    batch: vi.fn().mockImplementation(async (statements: Array<{ sql: string; args: unknown[] }>) => {
      const blocked = control.failProfileWriteFor;
      const hits = blocked && blocked.size > 0 && statements.some((statement) =>
        statement.sql.includes('UPDATE friends') && statement.sql.includes('display_name')
        // 所有権の条件の値が bind の末尾に足されたので、friends.id は
        // 末尾ではなく 5 番目（display_name, picture_url, status_message,
        // updated_at の次）で見る。
        && blocked.has(String(statement.args[4])));
      // D1 の batch は 1 文でも失敗すると塊ごと巻き戻る。落ちた塊の行は
      // display_name が NULL のまま残るので、ここでも何も書かずに投げる。
      if (hits) throw new Error('D1_ERROR: write failed');
      return statements.map((statement) => execute(statement.sql, statement.args));
    }),
  } as unknown as D1Database;

  return {
    db,
    friends,
    getSetting: () => setting,
    /** 別の実行が横から状態を書き換えた状況を作るための口。 */
    setSetting: (value: string) => { setting = value; },
  };
}

describe('persisted one-time follower import', () => {
  test('claims preserved friends only when LINE returns their IDs for the reconnected account', async () => {
    const retained = seedFriends(4).map((friend) => ({
      ...friend,
      line_account_id: null,
      display_name: '保存済みの友だち',
    }));
    const { db, friends } = makeDb(retained);
    const returnedIds = retained.slice(0, 3).map((friend) => friend.line_user_id);
    const client = {
      getFollowerIds: vi.fn()
        .mockResolvedValueOnce({ userIds: [] })
        .mockResolvedValueOnce({ userIds: returnedIds }),
      getProfile: vi.fn(),
    };

    await detectFollowerImportCapability(db, client, 'new-account');
    await startFollowerImport(db, 'new-account');
    const run = await processFollowerImportStep(db, client, 'new-account');

    expect(run.state.phase).toBe('completed');
    expect(run.state.received).toBe(3);
    expect(run.state.claimedUnassigned).toBe(3);
    expect(run.state.imported).toBe(0);
    expect(client.getFollowerIds).toHaveBeenCalledTimes(2);
    expect(client.getProfile).not.toHaveBeenCalled();
    expect(retained.map((friend) => friends.get(friend.line_user_id)?.line_account_id))
      .toEqual(['new-account', 'new-account', 'new-account', null]);
    expect(friends.get(retained[0].line_user_id)?.id).toBe(retained[0].id);
    expect(friends.get(retained[0].line_user_id)?.display_name).toBe('保存済みの友だち');
  });

  test('detects an unavailable account once and stores the result', async () => {
    const { db, getSetting } = makeDb();
    const client = {
      getFollowerIds: vi.fn().mockRejectedValue(new Error('LINE API error: 403 Forbidden')),
    };

    const state = await detectFollowerImportCapability(db, client, 'acc-1');

    expect(client.getFollowerIds).toHaveBeenCalledWith(1);
    expect(state.capability).toBe('unavailable');
    expect(JSON.parse(getSetting()!).capability).toBe('unavailable');
  });

  test('runs ids and profiles to the end in one go and cannot restart after completion', async () => {
    const { db, friends } = makeDb();
    const lineUserId = uid('a');
    const client = {
      getFollowerIds: vi.fn()
        .mockResolvedValueOnce({ userIds: [] })
        .mockResolvedValueOnce({ userIds: [lineUserId] }),
      getProfile: vi.fn().mockResolvedValue({
        displayName: '移行患者',
        pictureUrl: 'https://example.com/profile.jpg',
      }),
    };

    await detectFollowerImportCapability(db, client, 'acc-1');
    await startFollowerImport(db, 'acc-1');

    // 時間と人数の予算が残っている限り、1 回の呼び出しで ID とプロフィールを
    // 1回で複数ページ進み、続きの取得を継続できることを確かめる。
    const run = await processFollowerImportStep(db, client, 'acc-1');
    expect(run.state.phase).toBe('completed');
    expect(run.state.imported).toBe(1);
    expect(run.state.profilesUpdated).toBe(1);
    expect(run.profilesFetched).toBe(1);
    expect(friends.get(lineUserId)?.display_name).toBe('移行患者');

    const completed = await startFollowerImport(db, 'acc-1');
    expect(completed.phase).toBe('completed');
    expect(client.getFollowerIds).toHaveBeenCalledTimes(2);
    expect((await getFollowerImportState(db, 'acc-1')).completedAt).not.toBeNull();
  });

  test('stops at the profile allowance and resumes from the stored cursor', async () => {
    const { db, friends } = makeDb();
    const lineUserIds = [uid('a'), uid('b'), uid('c')];
    const client = {
      getFollowerIds: vi.fn()
        .mockResolvedValueOnce({ userIds: [] })
        .mockResolvedValueOnce({ userIds: lineUserIds }),
      getProfile: vi.fn().mockImplementation(async (id: string) => ({ displayName: `名前${id.slice(1, 2)}` })),
    };

    await detectFollowerImportCapability(db, client, 'acc-1');
    await startFollowerImport(db, 'acc-1');

    // 人数の取り分を使い切ったところで止まり、残りは次の呼び出しが拾う。
    const first = await processFollowerImportStep(db, client, 'acc-1', { maxProfiles: 2 });
    expect(first.profilesFetched).toBe(2);
    expect(first.state.phase).toBe('hydrating_profiles');
    expect(first.state.profilesUpdated).toBe(2);

    const second = await processFollowerImportStep(db, client, 'acc-1', { maxProfiles: 2 });
    expect(second.profilesFetched).toBe(1);
    expect(second.state.phase).toBe('completed');
    expect(second.state.profilesUpdated).toBe(3);
    expect(client.getProfile).toHaveBeenCalledTimes(3);
    for (const lineUserId of lineUserIds) {
      expect(friends.get(lineUserId)?.display_name).not.toBeNull();
    }
  });
});

describe('follower import uses each official account’s own LINE recipients', () => {
  async function importFollowers(db: D1Database, accountId: string, userIds: string[]) {
    const client = {
      getFollowerIds: vi.fn().mockResolvedValue({ userIds }),
      getProfile: vi.fn().mockResolvedValue({ displayName: `プロフィール ${accountId}` }),
    };
    await detectFollowerImportCapability(db, client, accountId);
    await startFollowerImport(db, accountId);
    return { result: await processFollowerImportStep(db, client, accountId), client };
  }

  test('imports a shared LINE user and hydrates the raw UID without adopting another tenant’s history', async () => {
    const { db, raw } = createTestD1({ foreignKeys: true });
    try {
      raw.exec(`INSERT INTO tenants(id,name) VALUES ('t-b','別の統括');
        INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret,tenant_id) VALUES
        ('a','1001','店舗A','fixture','fixture',NULL),('b','1002','店舗B','fixture','fixture','t-b');`);
      const insert = raw.prepare('INSERT INTO friends(id,line_user_id,line_account_id,display_name,is_following) VALUES (?,?,?,?,?)');
      insert.run('a-friend', uid('a'), 'a', '店舗Aの履歴', 1);
      insert.run('unassigned', uid('b'), null, '未割当の履歴', 1);
      insert.run('b-active', uid('c'), 'b', '店舗Bで登録済み', 1);
      insert.run('b-blocked', uid('d'), 'b', '店舗Bで再登録', 0);

      const { result, client } = await importFollowers(db, 'b', ['a','b','c','d'].map(uid));
      expect(result.state).toMatchObject({ phase: 'completed', imported: 2, claimedUnassigned: 0,
        alreadyPresent: 1, reactivated: 1, conflicts: 0, profilesUpdated: 2 });
      expect(client.getProfile.mock.calls.map(([id]) => id).sort()).toEqual([uid('a'), uid('b')]);
      expect(raw.prepare(`SELECT line_account_id,display_name FROM friends
        WHERE line_platform_user_id=? ORDER BY line_account_id`).all(uid('a'))).toEqual([
        { line_account_id: 'a', display_name: '店舗Aの履歴' },
        { line_account_id: 'b', display_name: 'プロフィール b' },
      ]);
      expect(raw.prepare('SELECT line_account_id FROM friends WHERE id=?').get('unassigned')).toEqual({ line_account_id: null });
    } finally { raw.close(); }
  });

  test('two imports sharing an unassigned friend attach the history once and both finish', async () => {
    const { db, raw } = createTestD1({ foreignKeys: true });
    try {
      raw.exec(`INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret) VALUES
         ('a','1001','店舗A','fixture','fixture'),('b','1002','店舗B','fixture','fixture')`);
      raw.prepare('INSERT INTO friends(id,line_user_id,display_name) VALUES (?,?,?)')
        .run('old-friend', uid('a'), '以前の履歴');
      const outcomes = await Promise.all(['a', 'b'].map((account) => importFollowers(db, account, [uid('a')])));
      expect(outcomes.map(({ result }) => result.state.phase)).toEqual(['completed', 'completed']);
      expect(outcomes.map(({ result }) => result.state.imported).sort()).toEqual([0, 1]);
      expect(outcomes.map(({ result }) => result.state.claimedUnassigned).sort()).toEqual([0, 1]);
      const rows = raw.prepare('SELECT id,line_account_id FROM friends WHERE line_platform_user_id=?').all(uid('a')) as
        Array<{ id: string; line_account_id: string }>;
      expect(rows.map((row) => row.line_account_id).sort()).toEqual(['a', 'b']);
      expect(rows.filter((row) => row.id === 'old-friend')).toHaveLength(1);
    } finally { raw.close(); }
  });
});

/**
 * 書込件数と進捗が一致し、未取得の人を残したまま完了にならないことを故障注入で確かめる。
 */
describe('follower import keeps progress and the cursor honest under failures', () => {
  test('credits only the chunks that were written and does not complete past a failed write', async () => {
    // 書き戻しは 100 文ずつなので、150 人なら 2 塊。2 塊目を落とす。
    const seeded = seedFriends(150);
    const control: DbControl = { failProfileWriteFor: new Set(['f-100']) };
    const { db, friends } = makeDb(seeded, control);
    const client = {
      getFollowerIds: vi.fn().mockResolvedValue({ userIds: [] }),
      getProfile: vi.fn().mockImplementation(async (id: string) => ({ displayName: `名前${id.slice(-4)}` })),
    };

    await detectFollowerImportCapability(db, client, 'acc-1');
    await startFollowerImport(db, 'acc-1');

    const hydrated = () => [...friends.values()].filter((f) => f.display_name !== null).length;

    const first = await processFollowerImportStep(db, client, 'acc-1');
    // 1 塊目だけが書けている。進捗の数と DB の中身が一致していること。
    expect(hydrated()).toBe(100);
    expect(first.state.profilesUpdated).toBe(100);
    expect(first.state.profilesProcessed).toBe(100);
    // カーソルは書けた最後の人で止まる。落ちた塊の先頭を飛び越えない。
    expect(first.state.profileCursor).toBe('f-099');
    // 取り残しがあるので完了にしない。
    expect(first.state.phase).toBe('hydrating_profiles');
    expect(first.state.completedAt).toBeNull();

    // 書き戻しが通るようになれば、同じカーソルから残りを拾って完了する。
    control.failProfileWriteFor!.clear();
    const second = await processFollowerImportStep(db, client, 'acc-1');
    expect(second.state.phase).toBe('completed');
    expect(second.state.profilesUpdated).toBe(150);
    expect(hydrated()).toBe(150);
  });

  test('sweeps again for a profile that failed once instead of leaving it behind', async () => {
    const seeded = seedFriends(3);
    const { db, friends } = makeDb(seeded);
    const failOnce = new Set([userIdFor(1)]);
    const client = {
      getFollowerIds: vi.fn().mockResolvedValue({ userIds: [] }),
      getProfile: vi.fn().mockImplementation(async (id: string) => {
        // 1 人目だけ 1 回落ちる。429 や 5xx のような一時的な失敗。
        if (failOnce.delete(id)) throw new Error('LINE API error: 429 Too Many Requests');
        return { displayName: `名前${id.slice(-4)}` };
      }),
    };

    await detectFollowerImportCapability(db, client, 'acc-1');
    await startFollowerImport(db, 'acc-1');

    const run = await processFollowerImportStep(db, client, 'acc-1');
    // 落ちた人はカーソルの後ろに取り残されず、巡回をやり直して引き直される。
    expect(run.state.phase).toBe('completed');
    expect(run.state.profilesUpdated).toBe(3);
    expect(run.state.profileRetryPass).toBe(1);
    expect(run.state.profileErrors).toBe(1);
    for (const friend of friends.values()) {
      expect(friend.display_name).not.toBeNull();
    }
  });

  test('gives up on a permanently unreadable profile only after the retry passes', async () => {
    const seeded = seedFriends(3);
    const { db, friends } = makeDb(seeded);
    const blockedUserId = userIdFor(1);
    const client = {
      getFollowerIds: vi.fn().mockResolvedValue({ userIds: [] }),
      getProfile: vi.fn().mockImplementation(async (id: string) => {
        // 退会・ブロックの人は何度引いても 404。巡回の上限で諦める。
        if (id === blockedUserId) throw new Error('LINE API error: 404 Not Found');
        return { displayName: `名前${id.slice(-4)}` };
      }),
    };

    await detectFollowerImportCapability(db, client, 'acc-1');
    await startFollowerImport(db, 'acc-1');

    const run = await processFollowerImportStep(db, client, 'acc-1');
    expect(run.state.phase).toBe('completed');
    // 引けた 2 人は書けている。引けない 1 人は数に残り、黙って消えない。
    expect(run.state.profilesUpdated).toBe(2);
    expect(run.state.profileErrors).toBe(3);
    expect(run.state.profileRetryPass).toBe(2);
    expect(friends.get(blockedUserId)?.display_name).toBeNull();
    // 巡回のたびに対象は「まだ NULL の人」だけへ減るので、全員を
    // 引き直すことはない。3 人 + 引けない 1 人を 2 回 = 5 回。
    expect(client.getProfile).toHaveBeenCalledTimes(5);
  });

  test('stops fetching inside a page when the time budget runs out', async () => {
    const seeded = seedFriends(30);
    const { db, friends } = makeDb(seeded);
    let clock = 1_760_000_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    try {
      const client = {
        getFollowerIds: vi.fn().mockResolvedValue({ userIds: [] }),
        getProfile: vi.fn().mockImplementation(async (id: string) => {
          // 1 人引くたびに 100ms 進む。予算 1 秒ではページを引き切れない。
          clock += 100;
          return { displayName: `名前${id.slice(-4)}` };
        }),
      };

      await detectFollowerImportCapability(db, client, 'acc-1');
      await startFollowerImport(db, 'acc-1');

      const first = await processFollowerImportStep(db, client, 'acc-1', { budgetMs: 1_000 });
      // ページ途中でも時間上限を守るため、友だちごとに残り時間を確認する。
      // 200 人を引き終わるまで止まれずロックの期限を越えることがあった。
      expect(client.getProfile.mock.calls.length).toBeLessThan(30);
      expect(first.profilesFetched).toBeLessThan(30);
      // 投げていない人は決着していない扱い。完了にしない。
      expect(first.state.phase).toBe('hydrating_profiles');
      expect(first.state.completedAt).toBeNull();
      // 書けた数と進捗が一致し、カーソルは書けた最後の人で止まる。
      const hydratedFirst = [...friends.values()].filter((f) => f.display_name !== null).length;
      expect(first.state.profilesUpdated).toBe(hydratedFirst);
      expect(first.state.profilesProcessed).toBe(hydratedFirst);
      expect(first.state.profileCursor).toBe(`f-${String(hydratedFirst - 1).padStart(3, '0')}`);

      // 時間が戻れば残りを拾って完了する。取り残しは出ない。
      const second = await processFollowerImportStep(db, client, 'acc-1');
      expect(second.state.phase).toBe('completed');
      expect(second.state.profilesUpdated).toBe(30);
      expect([...friends.values()].every((f) => f.display_name !== null)).toBe(true);
    } finally {
      nowSpy.mockRestore();
    }
  });

  test('saves the counters and the cursor after every page, not just at the end', async () => {
    // 1 ページは 200 人。300 人なら 2 ページ分動く。
    // 2 ページ目を読みにきた時点で、1 ページ目の結果が DB に入っているか。
    const seeded = seedFriends(300);
    const snapshots: Array<string | null> = [];
    const control: DbControl = { onProfilePageQuery: (stored) => snapshots.push(stored) };
    const { db, friends } = makeDb(seeded, control);
    const client = {
      getFollowerIds: vi.fn().mockResolvedValue({ userIds: [] }),
      getProfile: vi.fn().mockImplementation(async (id: string) => ({ displayName: `名前${id.slice(-4)}` })),
    };

    await detectFollowerImportCapability(db, client, 'acc-1');
    await startFollowerImport(db, 'acc-1');
    snapshots.length = 0;

    const run = await processFollowerImportStep(db, client, 'acc-1');
    expect(run.state.phase).toBe('completed');
    expect(run.state.profilesUpdated).toBe(300);
    expect([...friends.values()].every((f) => f.display_name !== null)).toBe(true);

    expect(snapshots.length).toBeGreaterThanOrEqual(2);
    const atSecondPage = JSON.parse(snapshots[1] ?? '{}');
    expect(atSecondPage.profilesUpdated).toBe(200);
    expect(atSecondPage.profilesProcessed).toBe(200);
    expect(atSecondPage.profileCursor).toBe('f-199');
    // 途中保存でもロックは外さない。他の実行が割り込まないこと。
    expect(atSecondPage.lockToken).toBeTruthy();
  });

  test('does not roll back a newer run that took over after the lock expired', async () => {
    // ロックの期限が切れるほど長引いた実行が、あとから戻ってきて
    // 完了済みの進捗を、遅れて届いた実行が処理中へ上書きしないことを確かめる。
    // ここでは 1 ページ目を処理している間に、別の実行が続きを引き継いで
    // 全員ぶんを書き終えた状況を作る。
    const seeded = seedFriends(300);
    let pageReads = 0;
    let takeOver: (() => void) | null = null;
    const control: DbControl = {
      onProfilePageQuery: () => {
        pageReads += 1;
        if (pageReads === 1) takeOver?.();
      },
    };
    const { db, getSetting, setSetting } = makeDb(seeded, control);
    const client = {
      getFollowerIds: vi.fn().mockResolvedValue({ userIds: [] }),
      getProfile: vi.fn().mockImplementation(async (id: string) => ({ displayName: `名前${id.slice(-4)}` })),
    };

    await detectFollowerImportCapability(db, client, 'acc-1');
    await startFollowerImport(db, 'acc-1');

    // 追い抜く側（別の実行）が書き終えた状態。ロックは解放済み。
    const newer = {
      ...JSON.parse(getSetting()!),
      phase: 'completed',
      profilesUpdated: 300,
      profilesProcessed: 300,
      profileCursor: 'f-299',
      completedAt: '2026-10-15T23:30:00+09:00',
      lockToken: null,
      lockUntil: null,
    };
    takeOver = () => setSetting(JSON.stringify(newer));

    const run = await processFollowerImportStep(db, client, 'acc-1');

    // 追い抜かれた側は保存しない。新しい実行の「300人・完了」が残ること。
    const stored = JSON.parse(getSetting()!);
    expect(stored.phase).toBe('completed');
    expect(stored.profilesUpdated).toBe(300);
    expect(stored.profilesProcessed).toBe(300);
    expect(stored.profileCursor).toBe('f-299');
    expect(stored.completedAt).toBe('2026-10-15T23:30:00+09:00');
    // 自分が持っていないロックを解放しにいかないこと。
    expect(stored.lockToken).toBeNull();
    // 呼び出し側へは DB の最新を busy として返す。古い値を返さない。
    expect(run.busy).toBe(true);
    expect(run.state.phase).toBe('completed');
    expect(run.state.profilesUpdated).toBe(300);
  });

  test('writes no friend rows at all once a newer run has taken over', async () => {
    // 状態の保存だけを守っても、期限切れの旧実行が抱えている古いプロフィールが
    // friends への遅い書込が、完了済みの件数と食い違わないことを確かめる。
    // 気づけない上書きになる。ここでは 1 ページ目のプロフィールを引いている
    // 途中で別の実行が全員ぶんを書き終え、ロックも解放した状況を作る。
    const seeded = seedFriends(201);
    const { db, friends, getSetting, setSetting } = makeDb(seeded);
    let fetches = 0;
    let takeOver: (() => void) | null = null;
    const client = {
      getFollowerIds: vi.fn().mockResolvedValue({ userIds: [] }),
      getProfile: vi.fn().mockImplementation(async (id: string) => {
        fetches += 1;
        // 1 ページ目（200人）の最後を引いたところで追い抜かれる。
        // 書き戻しはこのあとなので、旧実行の値は全部「交代後」に届く。
        if (fetches === 200) takeOver?.();
        return { displayName: `古い名前${id.slice(-4)}`, pictureUrl: 'https://example.com/old.jpg' };
      }),
    };

    await detectFollowerImportCapability(db, client, 'acc-1');
    await startFollowerImport(db, 'acc-1');

    const newer = {
      ...JSON.parse(getSetting()!),
      phase: 'completed',
      profilesUpdated: 201,
      profilesProcessed: 201,
      profileCursor: 'f-200',
      completedAt: '2026-10-15T23:30:00+09:00',
      lockToken: null,
      lockUntil: null,
    };
    takeOver = () => {
      // 追い抜く側が 201 人ぶんの新しい情報を書き終えた状態にする。
      for (const row of friends.values()) {
        row.display_name = `新しい名前${row.id.slice(-3)}`;
        row.picture_url = 'https://example.com/new.jpg';
      }
      setSetting(JSON.stringify(newer));
    };

    const run = await processFollowerImportStep(db, client, 'acc-1');

    // 旧実行は 1 ページ目の 200 人を実際に引き終えている。つまり書き戻しは
    // 試みられていて、「取得前に止まったから書かれていない」のではない。
    expect(client.getProfile).toHaveBeenCalledTimes(200);

    // 本題。旧実行の古い値が 1 行も入っていないこと。
    const stale = [...friends.values()].filter((f) => f.display_name?.startsWith('古い名前'));
    expect(stale).toHaveLength(0);
    expect(friends.size).toBe(201);
    for (const row of friends.values()) {
      expect(row.display_name).toBe(`新しい名前${row.id.slice(-3)}`);
      expect(row.picture_url).toBe('https://example.com/new.jpg');
    }

    // 状態も新しい実行の「201人・完了」のまま。ロックも外さない。
    const stored = JSON.parse(getSetting()!);
    expect(stored.phase).toBe('completed');
    expect(stored.profilesUpdated).toBe(201);
    expect(stored.profileCursor).toBe('f-200');
    expect(stored.lockToken).toBeNull();
    expect(run.busy).toBe(true);
    expect(run.state.phase).toBe('completed');
    expect(run.state.profilesUpdated).toBe(201);
  });
});
