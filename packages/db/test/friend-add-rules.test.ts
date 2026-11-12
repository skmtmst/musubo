import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  archiveFriendAddRule,
  createFriendAddRuleDraft,
  getFriendAddRule,
  listFriendAddRules,
  listFriendAddRuleOrderIds,
  listFriendAddRulesPage,
  publishFriendAddRule,
  recordFriendAddRuleTest,
  reorderFriendAddRulePriorities,
  saveFriendAddRuleDraft,
  stopFriendAddRule,
  type FriendAddRuleDefinition,
} from '../src/friend-add-rules.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const benign = /duplicate column name|already exists/i;

function execSafe(sqlite: Database.Database, sql: string): void {
  for (const statement of sql.split(/;\s*(?:\r?\n|$)/).map((value) => value.trim()).filter(Boolean)) {
    try { sqlite.exec(statement); } catch (error) {
      if (!benign.test(error instanceof Error ? error.message : String(error))) throw error;
    }
  }
}

function setup(): Database.Database {
  const sqlite = new Database(':memory:');
  execSafe(sqlite, readFileSync(join(root, 'schema.sql'), 'utf8'));
  for (const file of readdirSync(join(root, 'migrations')).filter((name) => name.endsWith('.sql')).sort()) {
    execSafe(sqlite, readFileSync(join(root, 'migrations', file), 'utf8'));
  }
  sqlite.prepare(
    `INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
     VALUES ('account-1', 'channel-1', 'Account 1', 'token', 'secret'),
            ('account-2', 'channel-2', 'Account 2', 'token', 'secret')`,
  ).run();
  return sqlite;
}

function asD1(sqlite: Database.Database): D1Database {
  const prepare = (query: string) => {
    const make = (params: unknown[]) => ({
      async run() {
        const info = sqlite.prepare(query).run(...params);
        return { results: [], success: true, meta: { changes: info.changes } };
      },
      async first<T>() { return (sqlite.prepare(query).get(...params) as T) ?? null; },
      async all<T>() { return { results: sqlite.prepare(query).all(...params) as T[], success: true, meta: {} }; },
    });
    return { bind: (...params: unknown[]) => make(params), ...make([]) };
  };
  return {
    prepare,
    async batch(statements: D1PreparedStatement[]) {
      return sqlite.transaction(() => statements.map((statement) => (statement as unknown as { run(): Promise<unknown> }).run()))();
    },
  } as unknown as D1Database;
}

const definition: FriendAddRuleDefinition = {
  routeIds: ['route-1'],
  scenarioId: 'scenario-1',
  messageType: 'text',
  messageText: '友だち追加ありがとうございます。',
  timing: 'immediate',
  actions: [{ type: 'add_tag', targetId: 'tag-1', label: 'タグを付ける' }],
  friendCondition: '',
  activeFrom: null,
  activeUntil: null,
};

function insertPublishedRule(
  sqlite: Database.Database,
  input: {
    id: string;
    accountId?: string;
    kind?: 'first_time' | 'returning';
    fallback?: boolean;
    status?: 'published' | 'stopped';
  },
): void {
  const accountId = input.accountId ?? 'account-1';
  const kind = input.kind ?? 'first_time';
  const status = input.status ?? 'published';
  const versionId = `${input.id}-version`;
  sqlite.prepare(
    `INSERT INTO friend_add_rules
      (id, line_account_id, friend_kind, name, priority, is_unknown_route_fallback,
       status, current_version_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    accountId,
    kind,
    input.id,
    input.fallback ? 9999 : 1,
    input.fallback ? 1 : 0,
    status,
    versionId,
  );
  sqlite.prepare(
    `INSERT INTO friend_add_rule_versions
      (id, rule_id, version_number, definition_snapshot, status)
     VALUES (?, ?, 1, ?, 'published')`,
  ).run(versionId, input.id, JSON.stringify({ ...definition, routeIds: input.fallback ? [] : ['route-1'] }));
}

describe('friend add rules', () => {
  let sqlite: Database.Database;
  let db: D1Database;

  // 土台の当て直し(約1.4秒×8本)を1回にし、試験ごとは巻き戻しで戻す。
  // 376番の試験と同じ理由(worker の onTaskUpdate タイムアウト避け)。
  beforeAll(() => { sqlite = setup(); db = asD1(sqlite); });

  beforeEach(() => { sqlite.exec('BEGIN'); });

  afterEach(() => { sqlite.exec('ROLLBACK'); });

  afterAll(() => { sqlite.close(); });

  test('下書きの作成・更新・テスト・公開を固定版として残す', async () => {
    const created = await createFriendAddRuleDraft(db, {
      lineAccountId: 'account-1', friendKind: 'first_time', name: '店頭QRの初回案内',
      folderName: '店頭', priority: 1, definition, idempotencyKey: 'create-rule-000001',
    });
    expect(created.version_status).toBe('draft');
    const createReplay = await createFriendAddRuleDraft(db, {
      lineAccountId: 'account-1', friendKind: 'first_time', name: '二重作成されない',
      folderName: '店頭', priority: 1, definition, idempotencyKey: 'create-rule-000001',
    });
    expect(createReplay.id).toBe(created.id);

    const saved = await saveFriendAddRuleDraft(db, {
      lineAccountId: 'account-1', ruleId: created.id, name: '店頭QRの初回案内',
      folderName: '店頭', priority: 2, definition: { ...definition, messageText: '更新した案内' },
      idempotencyKey: 'save-rule-0000001',
    });
    expect(saved.priority).toBe(2);
    expect(JSON.parse(saved.definition_snapshot ?? '{}').messageText).toBe('更新した案内');
    const saveReplay = await saveFriendAddRuleDraft(db, {
      lineAccountId: 'account-1', ruleId: created.id, name: '再送で変わらない',
      folderName: null, priority: 99, definition: { ...definition, messageText: '再送の別内容' },
      idempotencyKey: 'save-rule-0000001',
    });
    expect(saveReplay.priority).toBe(2);
    expect(JSON.parse(saveReplay.definition_snapshot ?? '{}').messageText).toBe('更新した案内');

    await recordFriendAddRuleTest(db, {
      lineAccountId: 'account-1', ruleId: created.id, staffId: 'staff-1', succeeded: true,
    });
    const published = await publishFriendAddRule(db, {
      lineAccountId: 'account-1', ruleId: created.id, staffId: 'staff-1',
      idempotencyKey: 'publish-rule-0001',
    });
    expect(published.status).toBe('published');
    expect(published.version_status).toBe('published');

    const replay = await publishFriendAddRule(db, {
      lineAccountId: 'account-1', ruleId: created.id, staffId: 'staff-1',
      idempotencyKey: 'publish-rule-0001',
    });
    expect(replay.version_id).toBe(published.version_id);
  });

  test('アカウントと判定する人で一覧を分離する', async () => {
    await createFriendAddRuleDraft(db, {
      lineAccountId: 'account-1', friendKind: 'first_time', name: '初回', priority: 1, definition,
    });
    await createFriendAddRuleDraft(db, {
      lineAccountId: 'account-1', friendKind: 'returning', name: '再追加', priority: 1, definition,
    });
    await createFriendAddRuleDraft(db, {
      lineAccountId: 'account-2', friendKind: 'first_time', name: '別アカウント', priority: 1, definition,
    });
    const rows = await listFriendAddRules(db, { lineAccountId: 'account-1', friendKind: 'first_time' });
    expect(rows.map((row) => row.name)).toEqual(['初回']);
  });

  test('経路不明の受け皿は削除できず、通常ルールは履歴を残して一覧から外す', async () => {
    const normal = await createFriendAddRuleDraft(db, {
      lineAccountId: 'account-1', friendKind: 'first_time', name: '広告', priority: 1, definition,
    });
    await archiveFriendAddRule(db, { lineAccountId: 'account-1', ruleId: normal.id });
    expect(await getFriendAddRule(db, { lineAccountId: 'account-1', ruleId: normal.id })).toBeNull();

    sqlite.prepare(
      `INSERT INTO friend_add_rules
        (id, line_account_id, friend_kind, name, priority, is_unknown_route_fallback, status)
       VALUES ('fallback', 'account-1', 'first_time', '経路が分からなかった人', 9999, 1, 'published')`,
    ).run();
    await expect(archiveFriendAddRule(db, { lineAccountId: 'account-1', ruleId: 'fallback' }))
      .rejects.toThrow('FRIEND_ADD_RULE_NOT_ARCHIVED');
  });

  test('保管は確認した版と状態が同じ時だけ許し、版なしの旧呼出も動く', async () => {
    for (const mode of ['match', 'version', 'status', 'legacy'] as const) {
      const item = await createFriendAddRuleDraft(db, { lineAccountId: 'account-1', friendKind: 'first_time', name: mode, priority: 1, definition });
      const current = (await getFriendAddRule(db, { lineAccountId: 'account-1', ruleId: item.id }))!;
      const input = { lineAccountId: 'account-1', ruleId: item.id, ...(mode === 'legacy' ? {} : { expectedVersion: current.lock_version + (mode === 'version' ? 1 : 0), expectedStatus: mode === 'status' ? 'published' : current.status }) };
      if (mode === 'version' || mode === 'status') {
        await expect(archiveFriendAddRule(db, input)).rejects.toThrow('FRIEND_ADD_RULE_VERSION_CONFLICT');
        expect(await getFriendAddRule(db, { lineAccountId: 'account-1', ruleId: item.id })).not.toBeNull();
      } else {
        await archiveFriendAddRule(db, input);
        expect(await getFriendAddRule(db, { lineAccountId: 'account-1', ruleId: item.id })).toBeNull();
      }
    }
  });

  test('有効な同一アカウント・同一対象の受け皿がない停止を拒否する', async () => {
    insertPublishedRule(sqlite, { id: 'target' });

    await expect(stopFriendAddRule(db, {
      lineAccountId: 'account-1', ruleId: 'target', staffId: 'staff-1',
      idempotencyKey: 'stop-target-0001', expectedVersion: 1,
    })).rejects.toThrow('FRIEND_ADD_RULE_FALLBACK_REQUIRED');
    expect(sqlite.prepare("SELECT status, lock_version FROM friend_add_rules WHERE id = 'target'").get())
      .toEqual({ status: 'published', lock_version: 1 });
  });

  test('別アカウントと停止済みの受け皿を代替として数えない', async () => {
    insertPublishedRule(sqlite, { id: 'target' });
    insertPublishedRule(sqlite, { id: 'foreign-fallback', accountId: 'account-2', fallback: true });
    insertPublishedRule(sqlite, { id: 'stopped-fallback', fallback: true, status: 'stopped' });

    await expect(stopFriendAddRule(db, {
      lineAccountId: 'account-1', ruleId: 'target', staffId: 'staff-1',
      idempotencyKey: 'stop-target-0002', expectedVersion: 1,
    })).rejects.toThrow('FRIEND_ADD_RULE_FALLBACK_REQUIRED');
    expect(sqlite.prepare("SELECT status FROM friend_add_rules WHERE id = 'target'").get())
      .toEqual({ status: 'published' });
  });

  test('同時停止でも受け皿を公開中に残し、旧経路へ戻る状態を作らない', async () => {
    insertPublishedRule(sqlite, { id: 'target' });
    insertPublishedRule(sqlite, { id: 'fallback', fallback: true });

    const results = await Promise.allSettled([
      stopFriendAddRule(db, {
        lineAccountId: 'account-1', ruleId: 'target', staffId: 'staff-1',
        idempotencyKey: 'stop-target-0003', expectedVersion: 1,
      }),
      stopFriendAddRule(db, {
        lineAccountId: 'account-1', ruleId: 'fallback', staffId: 'staff-1',
        idempotencyKey: 'stop-fallback-001', expectedVersion: 1,
      }),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(sqlite.prepare(
      `SELECT id, status FROM friend_add_rules
        WHERE line_account_id = 'account-1' AND friend_kind = 'first_time'
        ORDER BY id`,
    ).all()).toEqual([
      { id: 'fallback', status: 'published' },
      { id: 'target', status: 'stopped' },
    ]);
  });

  /*
   * ★V8  の並び替え。一覧のつまみで動かした順を優先順位として
   * まとめて書く口（PATCH /api/friend-add-rules/reorder が使う）。
   */
  test('並び順のid一覧は受け皿とアーカイブ済みを外し、優先順位順に返す', async () => {
    insertPublishedRule(sqlite, { id: 'rule-b' });
    insertPublishedRule(sqlite, { id: 'rule-a' });
    insertPublishedRule(sqlite, { id: 'fallback', fallback: true });
    sqlite.prepare(`UPDATE friend_add_rules SET priority = 1 WHERE id = 'rule-b'`).run();
    sqlite.prepare(`UPDATE friend_add_rules SET priority = 2 WHERE id = 'rule-a'`).run();

    const ids = await listFriendAddRuleOrderIds(db, {
      lineAccountId: 'account-1', friendKind: 'first_time',
    });
    expect(ids).toEqual(['rule-b', 'rule-a']);
  });

  test('並び替えは priority を渡された順で書き、受け皿は動かさない', async () => {
    insertPublishedRule(sqlite, { id: 'rule-a' });
    insertPublishedRule(sqlite, { id: 'rule-b' });
    insertPublishedRule(sqlite, { id: 'fallback', fallback: true });

    await reorderFriendAddRulePriorities(db, {
      lineAccountId: 'account-1', friendKind: 'first_time',
      ids: ['rule-b', 'rule-a'],
    });

    expect(sqlite.prepare(
      `SELECT id, priority FROM friend_add_rules
        WHERE line_account_id = 'account-1' AND friend_kind = 'first_time'
        ORDER BY priority`,
    ).all()).toEqual([
      { id: 'rule-b', priority: 1 },
      { id: 'rule-a', priority: 2 },
      { id: 'fallback', priority: 9999 },
    ]);
    // 別区分・別アカウントは触らない
    const kindRows = sqlite.prepare(
      `SELECT COUNT(*) AS count FROM friend_add_rules
        WHERE line_account_id = 'account-1' AND friend_kind = 'returning'`,
    ).get<{ count: number }>();
    expect(kindRows?.count).toBe(0);
  });

  test('並び替えは他アカウントの同名設定を動かさない', async () => {
    insertPublishedRule(sqlite, { id: 'rule-a' });
    insertPublishedRule(sqlite, { id: 'rule-b', accountId: 'account-2' });

    await reorderFriendAddRulePriorities(db, {
      lineAccountId: 'account-1', friendKind: 'first_time', ids: ['rule-a'],
    });

    expect(sqlite.prepare(
      `SELECT priority FROM friend_add_rules WHERE id = 'rule-b'`,
    ).get()).toEqual({ priority: 1 });
  });

  /*
   * 「設定名・流入リンクで探す」。設定名に当たらなくても、一覧が参照する
   * 版に選ばれた流入リンクの名前で当たること。
   */
  test('検索は流入リンクの名前にも当たる', async () => {
    sqlite.prepare(
      `INSERT INTO entry_routes (id, ref_code, name) VALUES ('route-1', 'ref-shop', '店頭QRコード')`,
    ).run();
    insertPublishedRule(sqlite, { id: 'rule-shop' });
    insertPublishedRule(sqlite, { id: 'rule-other' });

    const byRuleName = await listFriendAddRulesPage(db, {
      lineAccountId: 'account-1', friendKind: 'first_time', search: 'rule-other',
    });
    expect(byRuleName.total).toBe(1);

    const byRouteName = await listFriendAddRulesPage(db, {
      lineAccountId: 'account-1', friendKind: 'first_time', search: '店頭',
    });
    expect(byRouteName.total).toBe(2);

    const noHit = await listFriendAddRulesPage(db, {
      lineAccountId: 'account-1', friendKind: 'first_time', search: '存在しない名前',
    });
    expect(noHit.total).toBe(0);
  });
});
