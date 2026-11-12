import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { DEFAULT_TENANT_ID } from '@line-crm/shared';
import type { Env } from '../worker-env.js';
import type { AuthenticatedStaff } from '../middleware/auth/principal/auth.js';
import { createTestD1, insertFriend, type SqliteD1 } from '../test-utils/d1-sqlite.js';
import { unlinkMergedPersonFriend } from '../services/merged-people.js';
import { friendMigrations } from './friend-migrations.js';
import { mergedPeople } from './merged-people.js';

/*
 * UID 移行の確認読取と書込の間に別担当の操作を差し込み、競合時の境界と保管履歴を実 route・実 SQLite で確かめる。
 */

const executor: AuthenticatedStaff = {
  id: 'owner-2', name: '別担当', role: 'owner', readOnly: false, tenantId: DEFAULT_TENANT_ID,
};

/** サービス呼び出し用の担当（tenantId 必須）。 */
const serviceActor = { id: 'owner-2', name: '別担当', tenantId: DEFAULT_TENANT_ID };

function appFor(db: D1Database, staff: AuthenticatedStaff) {
  const app = new Hono<Env>();
  app.use('*', async (c, next) => {
    c.set('staff', staff);
    await next();
  });
  app.route('/', friendMigrations);
  app.route('/', mergedPeople);
  return app;
}

function envFor(db: D1Database) {
  return { DB: db };
}

function post(path: string) {
  return new Request(`https://example.com${path}`, { method: 'POST' });
}

function seedMigrationRun(testDb: SqliteD1, status = 'ready'): void {
  const { raw } = testDb;
  for (const [id, name] of [['acc-from', '移行元'], ['acc-to', '移行先']]) {
    raw.prepare(`
      INSERT INTO line_accounts (
        id, channel_id, name, channel_access_token, channel_secret, tenant_id
      ) VALUES (?, ?, ?, 'token', 'secret', ?)
    `).run(id, `channel-${id}`, name, DEFAULT_TENANT_ID);
  }
  insertFriend(raw, 'f-old', {
    line_account_id: 'acc-from', line_user_id: 'UOLD-1', display_name: '旧友だち', user_id: null,
  });
  insertFriend(raw, 'f-new', {
    line_account_id: 'acc-to', line_user_id: 'UNEW-1', display_name: '新友だち', user_id: null,
  });
  raw.prepare(`
    INSERT INTO users (
      id, tenant_id, status, display_name, revision, created_by, created_at, updated_at
    ) VALUES ('user-u2', ?, 'active', '別の本人', 1, 'owner-1',
      '2026-08-30T09:00:00.000Z', '2026-08-30T09:00:00.000Z')
  `).run(DEFAULT_TENANT_ID);
  raw.prepare(`
    INSERT INTO uid_migration_runs (
      id, from_account_id, to_account_id, purpose, source_kind, source_filename,
      status, dry_run_revision, total_count, auto_count, review_count,
      unmatched_count, conflict_count, applied_count, failed_count,
      created_by, created_at
    ) VALUES ('run-1', 'acc-from', 'acc-to', '移行A', 'csv', 'map.csv',
      ?, 1, 1, 1, 0, 0, 0, 0, 0, 'owner-1', '2026-08-30T09:00:00.000Z')
  `).run(status);
  raw.prepare(`
    INSERT INTO uid_migration_items (
      id, run_id, old_uid, new_uid, old_friend_id, new_friend_id,
      evidence_type, evidence_json, classification, decision, result,
      created_at, updated_at
    ) VALUES ('item-1', 'run-1', 'UOLD-1', 'UNEW-1', 'f-old', 'f-new',
      'operator_csv', '{}', 'auto', 'link', 'pending',
      '2026-08-30T09:00:00.000Z', '2026-08-30T09:00:00.000Z')
  `).run();
}

/*
 * 対応表の確認読み（SELECT ... friends ... WHERE id IN）の直後に
 * 別担当の再連携を差し込む。確認時と書込時で現在値がずれる競合を再現する。
 */
function raceOnPairPrecheck(db: D1Database, raw: SqliteD1['raw'], moveSql: string): D1Database {
  let armed = true;
  const prepare = (sql: string) => {
    const statement = db.prepare(sql);
    return {
      ...statement,
      bind: (...args: unknown[]) => {
        const bound = (statement as unknown as { bind: (...a: unknown[]) => D1PreparedStatement }).bind(...args);
        if (!armed || !/FROM friends/i.test(sql) || !/WHERE id IN/i.test(sql)) return bound;
        return {
          ...bound,
          all: (async () => {
            const result = await bound.all();
            armed = false;
            raw.exec(moveSql);
            return result;
          }) as D1PreparedStatement['all'],
        };
      },
    };
  };
  return { ...db, prepare } as unknown as D1Database;
}

function friendUserId(testDb: SqliteD1, id: string): string | null {
  return (testDb.raw.prepare('SELECT user_id FROM friends WHERE id = ?').get(id) as { user_id: string | null }).user_id ?? null;
}

function migrationItem(testDb: SqliteD1) {
  return testDb.raw.prepare('SELECT * FROM uid_migration_items WHERE id = ?').get('item-1') as {
    result: string; error_message: string | null; before_json: string | null; after_json: string | null;
  };
}

describe('R395 確認後の再連携を本移行で上書きしない', () => {
  it('競合した行は失敗に記録し、再連携先を残す', async () => {
    const testDb = createTestD1();
    seedMigrationRun(testDb);
    const racyDb = raceOnPairPrecheck(
      testDb.db, testDb.raw, `UPDATE friends SET user_id = 'user-u2' WHERE id = 'f-old'`,
    );
    const response = await appFor(racyDb, executor).fetch(post('/api/friends/migrations/run-1/execute'), envFor(racyDb));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, data: { status: 'failed' } });
    // 再連携先は上書きされない。
    expect(friendUserId(testDb, 'f-old')).toBe('user-u2');
    expect(friendUserId(testDb, 'f-new')).toBeNull();
    // 競合として記録され、before/after は書かれない（何も変えていないため）。
    const item = migrationItem(testDb);
    expect(item.result).toBe('failed');
    expect(item.error_message).toContain('結び付きが変わりました');
    expect(item.before_json).toBeNull();
    expect(item.after_json).toBeNull();
  });

  it('競合がなければ本移行が通り、before_jsonは書込時の現在値になる', async () => {
    const testDb = createTestD1();
    seedMigrationRun(testDb);
    const response = await appFor(testDb.db, executor).fetch(
      post('/api/friends/migrations/run-1/execute'), envFor(testDb.db),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, data: { status: 'completed' } });
    const userId = friendUserId(testDb, 'f-old');
    expect(userId).not.toBeNull();
    expect(friendUserId(testDb, 'f-new')).toBe(userId);
    const item = migrationItem(testDb);
    expect(item.result).toBe('applied');
    expect(JSON.parse(item.before_json!)).toEqual({ oldUserId: null, newUserId: null, deliveryConsents: [] });
    expect(JSON.parse(item.after_json!)).toEqual({ userId, deliveryConsentsRecorded: 1, deliveryConsents: [] });
  });
});

describe('R396 切り戻しの遅い競合はペア全体を変えない', () => {
  function seedApplied(testDb: SqliteD1): void {
    seedMigrationRun(testDb, 'completed');
    testDb.raw.prepare(`UPDATE users SET revision = 1 WHERE id = 'user-u2'`).run();
    testDb.raw.prepare(`
      INSERT INTO users (
        id, tenant_id, status, display_name, revision, created_by, created_at, updated_at
      ) VALUES ('user-u1', ?, 'active', '移行先の本人', 2, 'owner-2',
        '2026-08-30T09:00:00.000Z', '2026-08-30T09:00:00.000Z')
    `).run(DEFAULT_TENANT_ID);
    testDb.raw.prepare(`UPDATE friends SET user_id = 'user-u1' WHERE id IN ('f-old', 'f-new')`).run();
    testDb.raw.prepare(`
      UPDATE uid_migration_runs SET applied_count = 1 WHERE id = 'run-1'
    `).run();
    testDb.raw.prepare(`
      UPDATE uid_migration_items
        SET result = 'applied',
            before_json = '{"oldUserId":null,"newUserId":null}',
            after_json = '{"userId":"user-u1"}'
        WHERE id = 'item-1'
    `).run();
  }

  it('片方だけ戻さず、再試行できる状態で409になる', async () => {
    const testDb = createTestD1();
    seedApplied(testDb);
    const racyDb = raceOnPairPrecheck(
      testDb.db, testDb.raw, `UPDATE friends SET user_id = 'user-u2' WHERE id = 'f-old'`,
    );
    const conflicted = await appFor(racyDb, executor).fetch(
      post('/api/friends/migrations/run-1/rollback'), envFor(racyDb),
    );
    expect(conflicted.status).toBe(409);
    // ペア全体が変わらない（片方だけ戻らない）。
    expect(friendUserId(testDb, 'f-old')).toBe('user-u2');
    expect(friendUserId(testDb, 'f-new')).toBe('user-u1');
    const item = migrationItem(testDb);
    expect(item.result).toBe('applied');
    // 外の変更を戻せば再試行できる。
    testDb.raw.prepare(`UPDATE friends SET user_id = 'user-u1' WHERE id = 'f-old'`).run();
    const retried = await appFor(testDb.db, executor).fetch(
      post('/api/friends/migrations/run-1/rollback'), envFor(testDb.db),
    );
    expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({ success: true, data: { rolledBack: 1 } });
    expect(friendUserId(testDb, 'f-old')).toBeNull();
    expect(friendUserId(testDb, 'f-new')).toBeNull();
    expect(migrationItem(testDb).result).toBe('rolled_back');
  });

  it('競合がなければ切り戻しが通る', async () => {
    const testDb = createTestD1();
    seedApplied(testDb);
    const response = await appFor(testDb.db, executor).fetch(
      post('/api/friends/migrations/run-1/rollback'), envFor(testDb.db),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, data: { rolledBack: 1 } });
  });
});

describe('R391 保管状態の本人は詳細と履歴を開ける', () => {
  function seedPerson(testDb: SqliteD1): void {
    const { raw } = testDb;
    for (const [id, name] of [['account-a', '本店'], ['account-b', '支店']]) {
      raw.prepare(`
        INSERT INTO line_accounts (
          id, channel_id, name, channel_access_token, channel_secret, tenant_id
        ) VALUES (?, ?, ?, 'token', 'secret', ?)
      `).run(id, `channel-${id}`, name, DEFAULT_TENANT_ID);
    }
    insertFriend(raw, 'friend-a', {
      line_account_id: 'account-a', display_name: '見本 171', user_id: 'user-a',
    });
    insertFriend(raw, 'friend-b', {
      line_account_id: 'account-b', display_name: '見本 161', user_id: 'user-a',
    });
    // の被害形: 本人は統括を持たない行（移行・判定で作られる形）。
    raw.prepare(`
      INSERT INTO users (
        id, tenant_id, status, display_name, primary_display_name, revision,
        created_by, created_at, updated_at
      ) VALUES ('user-a', NULL, 'active', '見本 171', '見本 171', 1,
        'owner-1', '2026-08-30T09:00:00.000Z', '2026-08-30T09:00:00.000Z')
    `).run();
    raw.prepare(`
      INSERT INTO identity_candidates (
        id, tenant_id, kind, status, version, confidence_score, detector_version,
        left_subject_kind, left_subject_id, left_line_account_id, left_snapshot_json,
        right_subject_kind, right_subject_id, right_line_account_id, right_snapshot_json,
        evidence_fingerprint, evidence_json, impact_json, detected_at, reviewed_at,
        created_at, updated_at
      ) VALUES ('candidate-a', ?, 'friend_duplicate', 'linked', 2, 92, 'v1',
        'friend', 'friend-a', 'account-a', '{}', 'friend', 'friend-b', 'account-b',
        '{}', 'fingerprint-a', '[]', '[]', '2026-08-30T09:00:00.000Z',
        '2026-08-30T09:10:00.000Z', '2026-08-30T09:00:00.000Z',
        '2026-08-30T09:10:00.000Z')
    `).run(DEFAULT_TENANT_ID);
    for (const [id, friendId] of [['link-a', 'friend-a'], ['link-b', 'friend-b']]) {
      raw.prepare(`
        INSERT INTO friend_identity_links (
          id, tenant_id, candidate_id, user_id, friend_id, link_method,
          evidence_snapshot_json, confidence_score, linked_by, linked_at
        ) VALUES (?, ?, 'candidate-a', 'user-a', ?, 'operator_review', '[]', 92,
          'owner-1', '2026-08-30T09:10:00.000Z')
      `).run(id, DEFAULT_TENANT_ID, friendId);
    }
  }

  it('統括全体のownerは最後の解除後も詳細と履歴を見られる', async () => {
    const testDb = createTestD1();
    seedPerson(testDb);
    await unlinkMergedPersonFriend(testDb.db, serviceActor, 'user-a', 'friend-a', {
      expectedRevision: 1, reason: '本店の結び付きを解除します',
    });
    await unlinkMergedPersonFriend(testDb.db, serviceActor, 'user-a', 'friend-b', {
      expectedRevision: 2, reason: '支店の結び付きを解除します',
    });
    const response = await appFor(testDb.db, executor).fetch(
      new Request('https://example.com/api/friends/people/user-a'), envFor(testDb.db),
    );
    expect(response.status).toBe(200);
    const body = await response.json() as {
      success: boolean; data: { linkedFriends: unknown[]; history: unknown[] };
    };
    expect(body.success).toBe(true);
    expect(body.data.linkedFriends).toEqual([]);
    expect(body.data.history.length).toBeGreaterThanOrEqual(2);
  });

  it('担当店だけの管理者には保管履歴を開示しない', async () => {
    const testDb = createTestD1();
    seedPerson(testDb);
    await unlinkMergedPersonFriend(testDb.db, serviceActor, 'user-a', 'friend-a', {
      expectedRevision: 1, reason: '本店の結び付きを解除します',
    });
    await unlinkMergedPersonFriend(testDb.db, serviceActor, 'user-a', 'friend-b', {
      expectedRevision: 2, reason: '支店の結び付きを解除します',
    });
    testDb.raw.prepare(`
      INSERT INTO staff_members (id, name, role, api_key, tenant_id, account_scope)
      VALUES ('admin-a', '本店だけの管理者', 'admin', 'key-admin-a', ?, 'accounts')
    `).run(DEFAULT_TENANT_ID);
    testDb.raw.prepare(`
      INSERT INTO staff_account_scopes (staff_id, line_account_id, created_at)
      VALUES ('admin-a', 'account-a', '2026-08-30T09:00:00.000Z')
    `).run();
    const scoped: AuthenticatedStaff = {
      id: 'admin-a', name: '本店だけの管理者', role: 'admin', readOnly: false, tenantId: DEFAULT_TENANT_ID,
    };
    const response = await appFor(testDb.db, scoped).fetch(
      new Request('https://example.com/api/friends/people/user-a'), envFor(testDb.db),
    );
    expect(response.status).toBe(403);
  });
});

/*
 * 移行先 UID で友だちを作り、名前は移行元から引き継ぐ。同じ UID が対象アカウントにあれば既存行へ収束させ、別アカウントへは越境させない。
 * 切り戻しは作った友だちを残し、結び付けだけを戻す。実 route・実 SQLite で確かめる。
 */
const creator: AuthenticatedStaff = {
  id: 'owner-1', name: '作成者', role: 'owner', readOnly: false, tenantId: DEFAULT_TENANT_ID,
};

function seedCreateRun(
  testDb: SqliteD1,
  options?: {
    status?: string; decision?: string; newUid?: string | null;
    withTarget?: boolean; withElsewhere?: boolean; oldAccount?: string;
  },
): void {
  const { raw } = testDb;
  const status = options?.status ?? 'ready';
  const decision = options?.decision ?? 'create';
  const newUid = options?.newUid === undefined ? 'UNEW-9' : options.newUid;
  for (const [id, name, tenant] of [
    ['acc-from', '移行元', DEFAULT_TENANT_ID],
    ['acc-to', '移行先', DEFAULT_TENANT_ID],
    ['acc-other', '他店', 'tenant-other'],
  ]) {
    raw.prepare(`
      INSERT INTO line_accounts (
        id, channel_id, name, channel_access_token, channel_secret, tenant_id
      ) VALUES (?, ?, ?, 'token', 'secret', ?)
    `).run(id, `channel-${id}`, name, tenant);
  }
  insertFriend(raw, 'f-old', {
    line_account_id: options?.oldAccount ?? 'acc-from', line_user_id: 'UOLD-9',
    display_name: '旧表示', real_name: '旧本名', system_display_name: '旧システム名',
    user_id: null,
  });
  if (options?.withTarget) {
    insertFriend(raw, 'f-made', {
      line_account_id: 'acc-to', line_user_id: 'UNEW-9',
      display_name: '既存表示', user_id: null,
    });
  }
  if (options?.withElsewhere) {
    insertFriend(raw, 'f-other', {
      line_account_id: 'acc-other', line_user_id: 'UNEW-9',
      display_name: '他店表示', user_id: null,
    });
  }
  raw.prepare(`
    INSERT INTO users (
      id, tenant_id, status, display_name, revision, created_by, created_at, updated_at
    ) VALUES ('user-u2', ?, 'active', '別の本人', 1, 'owner-1',
      '2026-08-30T09:00:00.000Z', '2026-08-30T09:00:00.000Z')
  `).run(DEFAULT_TENANT_ID);
  raw.prepare(`
    INSERT INTO uid_migration_runs (
      id, from_account_id, to_account_id, purpose, source_kind, source_filename,
      status, dry_run_revision, total_count, auto_count, review_count,
      unmatched_count, conflict_count, applied_count, failed_count,
      created_by, created_at
    ) VALUES ('run-9', 'acc-from', 'acc-to', '移行F3', 'csv', 'map.csv',
      ?, 1, 1, 0, 0, 1, 0, 0, 0, 'owner-1', '2026-08-30T09:00:00.000Z')
  `).run(status);
  raw.prepare(`
    INSERT INTO uid_migration_items (
      id, run_id, old_uid, new_uid, old_friend_id, new_friend_id,
      evidence_type, evidence_json, classification, decision, result,
      created_at, updated_at
    ) VALUES ('item-9', 'run-9', 'UOLD-9', ?, 'f-old', NULL,
      'operator_csv', '{}', 'unmatched', ?, 'pending',
      '2026-08-30T09:00:00.000Z', '2026-08-30T09:00:00.000Z')
  `).run(newUid, decision);
}

function createItem(testDb: SqliteD1) {
  return testDb.raw.prepare('SELECT * FROM uid_migration_items WHERE id = ?').get('item-9') as {
    result: string; error_message: string | null; new_friend_id: string | null;
    before_json: string | null; after_json: string | null;
  };
}

function countUid(testDb: SqliteD1, accountId: string, lineUserId: string): number {
  return (testDb.raw.prepare(
    'SELECT COUNT(*) AS count FROM friends WHERE line_account_id = ? AND line_user_id = ?',
  ).get(accountId, lineUserId) as { count: number }).count;
}

/*
 * 友だちへの INSERT の直前に別担当の作成を差し込む。先着行を作ってから
 * 制約違反を起こし、並行作成の競合を再現する。
 */
function raceOnFriendInsert(db: D1Database, raw: SqliteD1['raw']): D1Database {
  let armed = true;
  const prepare = (sql: string) => {
    const statement = db.prepare(sql);
    return {
      ...statement,
      bind: (...args: unknown[]) => {
        const bound = (statement as unknown as { bind: (...a: unknown[]) => D1PreparedStatement }).bind(...args);
        if (!armed || !/INSERT INTO friends/i.test(sql)) return bound;
        return {
          ...bound,
          run: (async () => {
            armed = false;
            raw.prepare(`INSERT INTO friends (
              id, line_user_id, line_account_id, display_name, created_at, updated_at
            ) VALUES ('f-rival', 'UNEW-9', 'acc-to', '先着',
              '2026-08-30T09:00:00.000Z', '2026-08-30T09:00:00.000Z')`).run();
            throw new Error('UNIQUE constraint failed: friends.line_user_id');
          }) as D1PreparedStatement['run'],
        };
      },
    };
  };
  return { ...db, prepare } as unknown as D1Database;
}

describe('F-3 移行先UIDの新規作成と名前引継ぎ', () => {
  it('移行先UIDで友だちを作り移行元の名前を引き継ぐ', async () => {
    const testDb = createTestD1();
    seedCreateRun(testDb);
    const response = await appFor(testDb.db, executor).fetch(
      post('/api/friends/migrations/run-9/execute'), envFor(testDb.db),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, data: { status: 'completed' } });
    const made = testDb.raw.prepare(
      'SELECT * FROM friends WHERE line_account_id = ? AND line_user_id = ?',
    ).get('acc-to', 'UNEW-9') as {
      id: string; user_id: string | null; display_name: string | null;
      real_name: string | null; system_display_name: string | null;
    };
    expect(made.display_name).toBe('旧表示');
    expect(made.real_name).toBe('旧本名');
    expect(made.system_display_name).toBe('旧システム名');
    expect(made.user_id).not.toBeNull();
    expect(friendUserId(testDb, 'f-old')).toBe(made.user_id);
    const item = createItem(testDb);
    expect(item.result).toBe('applied');
    expect(item.new_friend_id).toBe(made.id);
    expect(JSON.parse(item.before_json!)).toEqual({ oldUserId: null, newUserId: null, deliveryConsents: [] });
    expect(JSON.parse(item.after_json!)).toEqual({ userId: made.user_id, deliveryConsentsRecorded: 1, deliveryConsents: [] });
  });

  it('同じUIDが対象アカウントにあれば作らず採用する', async () => {
    const testDb = createTestD1();
    seedCreateRun(testDb, { withTarget: true });
    const response = await appFor(testDb.db, executor).fetch(
      post('/api/friends/migrations/run-9/execute'), envFor(testDb.db),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, data: { status: 'completed' } });
    expect(countUid(testDb, 'acc-to', 'UNEW-9')).toBe(1);
    const item = createItem(testDb);
    expect(item.result).toBe('applied');
    expect(item.new_friend_id).toBe('f-made');
    expect(friendUserId(testDb, 'f-old')).toBe(friendUserId(testDb, 'f-made'));
  });

  it('対象外アカウントのUIDは越境させず失敗にし何も書かない', async () => {
    const testDb = createTestD1();
    seedCreateRun(testDb, { withElsewhere: true });
    const before = (testDb.raw.prepare('SELECT COUNT(*) AS count FROM friends').get() as { count: number }).count;
    const response = await appFor(testDb.db, executor).fetch(
      post('/api/friends/migrations/run-9/execute'), envFor(testDb.db),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, data: { status: 'failed' } });
    const item = createItem(testDb);
    expect(item.result).toBe('failed');
    expect(item.error_message).toContain('別のLINEアカウント');
    expect(item.new_friend_id).toBeNull();
    expect(countUid(testDb, 'acc-to', 'UNEW-9')).toBe(0);
    expect((testDb.raw.prepare('SELECT COUNT(*) AS count FROM friends').get() as { count: number }).count).toBe(before);
    expect(friendUserId(testDb, 'f-old')).toBeNull();
  });

  it('並行作成の競合は作り直さず一人に収束させる', async () => {
    const testDb = createTestD1();
    seedCreateRun(testDb);
    const racyDb = raceOnFriendInsert(testDb.db, testDb.raw);
    const response = await appFor(racyDb, executor).fetch(
      post('/api/friends/migrations/run-9/execute'), envFor(racyDb),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, data: { status: 'completed' } });
    expect(countUid(testDb, 'acc-to', 'UNEW-9')).toBe(1);
    const item = createItem(testDb);
    expect(item.result).toBe('applied');
    expect(item.new_friend_id).toBe('f-rival');
    expect(friendUserId(testDb, 'f-old')).toBe(friendUserId(testDb, 'f-rival'));
  });

  it('再送は作り直さず対象アカウントの行を採用する', async () => {
    const testDb = createTestD1();
    seedCreateRun(testDb, { status: 'failed' });
    testDb.raw.prepare(`UPDATE uid_migration_runs SET failed_count = 1 WHERE id = 'run-9'`).run();
    testDb.raw.prepare(`UPDATE uid_migration_items SET result = 'failed' WHERE id = 'item-9'`).run();
    insertFriend(testDb.raw, 'f-made', {
      line_account_id: 'acc-to', line_user_id: 'UNEW-9',
      display_name: '再送前の作成分', user_id: null,
    });
    const response = await appFor(testDb.db, executor).fetch(
      post('/api/friends/migrations/run-9/execute'), envFor(testDb.db),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, data: { status: 'completed' } });
    expect(countUid(testDb, 'acc-to', 'UNEW-9')).toBe(1);
    const item = createItem(testDb);
    expect(item.result).toBe('applied');
    expect(item.new_friend_id).toBe('f-made');
  });

  it('作成者本人の実行は承認規約で止まり副作用は0', async () => {
    const testDb = createTestD1();
    seedCreateRun(testDb);
    const before = (testDb.raw.prepare('SELECT COUNT(*) AS count FROM friends').get() as { count: number }).count;
    const response = await appFor(testDb.db, creator).fetch(
      post('/api/friends/migrations/run-9/execute'), envFor(testDb.db),
    );
    expect(response.status).toBe(409);
    expect(countUid(testDb, 'acc-to', 'UNEW-9')).toBe(0);
    expect((testDb.raw.prepare('SELECT COUNT(*) AS count FROM friends').get() as { count: number }).count).toBe(before);
    expect(createItem(testDb).result).toBe('pending');
  });

  it('CAS失敗時は作った行を消して副作用を0に戻す', async () => {
    const testDb = createTestD1();
    seedCreateRun(testDb);
    const racyDb = raceOnPairPrecheck(
      testDb.db, testDb.raw, `UPDATE friends SET user_id = 'user-u2' WHERE id = 'f-old'`,
    );
    const response = await appFor(racyDb, executor).fetch(
      post('/api/friends/migrations/run-9/execute'), envFor(racyDb),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, data: { status: 'failed' } });
    // 再連携先は残し、今作った行は消える。
    expect(friendUserId(testDb, 'f-old')).toBe('user-u2');
    expect(countUid(testDb, 'acc-to', 'UNEW-9')).toBe(0);
    const item = createItem(testDb);
    expect(item.result).toBe('failed');
    expect(item.new_friend_id).toBeNull();
  });

  it('移行先UIDがなければcreateは選べない', async () => {
    const testDb = createTestD1();
    seedCreateRun(testDb, { status: 'review', decision: 'pending', newUid: null });
    const response = await appFor(testDb.db, executor).fetch(
      new Request('https://example.com/api/friends/migrations/run-9/items/item-9', {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'create' }),
      }), envFor(testDb.db),
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('新規作成できません') });
  });

  it('移行先UIDがあればcreateを選べる', async () => {
    const testDb = createTestD1();
    seedCreateRun(testDb, { status: 'review', decision: 'pending' });
    const response = await appFor(testDb.db, executor).fetch(
      new Request('https://example.com/api/friends/migrations/run-9/items/item-9', {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'create' }),
      }), envFor(testDb.db),
    );
    expect(response.status).toBe(200);
    const decided = testDb.raw.prepare(
      'SELECT decision FROM uid_migration_items WHERE id = ?',
    ).get('item-9') as { decision: string };
    expect(decided.decision).toBe('create');
  });
});

/*
 * 項目参照の確定（SET new_friend_id）の直後に別担当の操作を差し込む。
 * pair の確認読み自体がずれる競合を再現する。
 */
function raceBeforePairRead(db: D1Database, raw: SqliteD1['raw'], moveSql: string): D1Database {
  let armed = true;
  const prepare = (sql: string) => {
    const statement = db.prepare(sql);
    return {
      ...statement,
      bind: (...args: unknown[]) => {
        const bound = (statement as unknown as { bind: (...a: unknown[]) => D1PreparedStatement }).bind(...args);
        if (!armed || !/SET new_friend_id/i.test(sql)) return bound;
        return {
          ...bound,
          run: (async () => {
            const result = await bound.run();
            armed = false;
            raw.exec(moveSql);
            return result;
          }) as D1PreparedStatement['run'],
        };
      },
    };
  };
  return { ...db, prepare } as unknown as D1Database;
}

/*
 * 項目参照の確定（SET new_friend_id）を一度だけ落とす。
 * INSERT成立→参照UPDATE故障の把握漏れを再現する。
 */
function throwOnItemPointer(db: D1Database): D1Database {
  let armed = true;
  const prepare = (sql: string) => {
    const statement = db.prepare(sql);
    return {
      ...statement,
      bind: (...args: unknown[]) => {
        const bound = (statement as unknown as { bind: (...a: unknown[]) => D1PreparedStatement }).bind(...args);
        if (!armed || !/SET new_friend_id/i.test(sql)) return bound;
        return {
          ...bound,
          run: (async () => {
            armed = false;
            throw new Error('item pointer update failed');
          }) as D1PreparedStatement['run'],
        };
      },
    };
  };
  return { ...db, prepare } as unknown as D1Database;
}

const RECORD_WRITES = Symbol('recordWrites');

/*
 * 成功記録の batch（result='applied' を含む書込み）だけを落とす。
 * pair まで進んで記録が落ちた場合の副作用を再現する。
 */
function failOnRecordWrites(db: D1Database, raw?: SqliteD1['raw'], moveSql?: string): D1Database {
  const prepare = (sql: string) => {
    const statement = db.prepare(sql);
    const tagged = /SET result = 'applied'/i.test(sql);
    return {
      ...statement,
      bind: (...args: unknown[]) => {
        const bound = (statement as unknown as { bind: (...a: unknown[]) => D1PreparedStatement }).bind(...args);
        return (tagged
          ? { ...bound, [RECORD_WRITES]: true }
          : bound) as D1PreparedStatement;
      },
    };
  };
  const batch = async (statements: D1PreparedStatement[]) => {
    if (statements.some((statement) => (statement as unknown as Record<symbol, boolean>)[RECORD_WRITES])) {
      if (raw && moveSql) raw.exec(moveSql);
      throw new Error('recordWrites failed');
    }
    return db.batch(statements);
  };
  return { ...db, prepare, batch } as unknown as D1Database;
}

describe('F-3 障害時の副作用0（監査メモ対応）', () => {
  it('pair確認前に移行元が消えても作った行は残さない', async () => {
    const testDb = createTestD1();
    seedCreateRun(testDb);
    const racyDb = raceBeforePairRead(
      testDb.db, testDb.raw, `DELETE FROM friends WHERE id = 'f-old'`,
    );
    const response = await appFor(racyDb, executor).fetch(
      post('/api/friends/migrations/run-9/execute'), envFor(racyDb),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, data: { status: 'failed' } });
    expect(countUid(testDb, 'acc-to', 'UNEW-9')).toBe(0);
    const item = createItem(testDb);
    expect(item.result).toBe('failed');
    expect(item.new_friend_id).toBeNull();
    expect(item.before_json).toBeNull();
    expect(item.after_json).toBeNull();
  });

  it('記録batchが落ちても結び付き・作成分・本人行を残さない', async () => {
    const testDb = createTestD1();
    seedCreateRun(testDb);
    const usersBefore = (testDb.raw.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }).count;
    const brokenDb = failOnRecordWrites(testDb.db);
    const response = await appFor(brokenDb, executor).fetch(
      post('/api/friends/migrations/run-9/execute'), envFor(brokenDb),
    );
    expect(response.status).toBe(500);
    // 成功記録がないため再試行・切り戻しから取り残される中間状態を残さない。
    expect(friendUserId(testDb, 'f-old')).toBeNull();
    expect(countUid(testDb, 'acc-to', 'UNEW-9')).toBe(0);
    const item = createItem(testDb);
    expect(item.result).toBe('pending');
    expect(item.new_friend_id).toBeNull();
    expect((testDb.raw.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }).count).toBe(usersBefore);
    const run = testDb.raw.prepare('SELECT status FROM uid_migration_runs WHERE id = ?').get('run-9') as { status: string };
    expect(run.status).toBe('failed');
  });

  it('作った行が別処理に紐付いたら消さず参照だけ外す', async () => {
    const testDb = createTestD1();
    seedCreateRun(testDb);
    const racyDb = raceOnPairPrecheck(
      testDb.db, testDb.raw,
      `UPDATE friends SET user_id = 'user-u2' WHERE line_account_id = 'acc-to' AND line_user_id = 'UNEW-9'`,
    );
    const response = await appFor(racyDb, executor).fetch(
      post('/api/friends/migrations/run-9/execute'), envFor(racyDb),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, data: { status: 'failed' } });
    // 別処理の結び付きは残し、項目の参照だけ外す（食い違わせない）。
    expect(countUid(testDb, 'acc-to', 'UNEW-9')).toBe(1);
    const kept = testDb.raw.prepare(
      'SELECT user_id FROM friends WHERE line_account_id = ? AND line_user_id = ?',
    ).get('acc-to', 'UNEW-9') as { user_id: string | null };
    expect(kept.user_id).toBe('user-u2');
    expect(friendUserId(testDb, 'f-old')).toBeNull();
    const item = createItem(testDb);
    expect(item.result).toBe('failed');
    expect(item.new_friend_id).toBeNull();
  });

  it('記録失敗と片側relinkでは他者側を保持し自側だけ戻す', async () => {
    const testDb = createTestD1();
    seedCreateRun(testDb);
    const usersBefore = (testDb.raw.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }).count;
    const brokenDb = failOnRecordWrites(
      testDb.db, testDb.raw, `UPDATE friends SET user_id = 'user-u2' WHERE id = 'f-old'`,
    );
    const response = await appFor(brokenDb, executor).fetch(
      post('/api/friends/migrations/run-9/execute'), envFor(brokenDb),
    );
    expect(response.status).toBe(500);
    // 他処理が結び付け直した旧側は保持し、本操作が設定した新側だけ戻る。
    expect(friendUserId(testDb, 'f-old')).toBe('user-u2');
    expect(countUid(testDb, 'acc-to', 'UNEW-9')).toBe(0);
    const item = createItem(testDb);
    expect(item.result).toBe('pending');
    expect(item.new_friend_id).toBeNull();
    expect((testDb.raw.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }).count).toBe(usersBefore);
    const run = testDb.raw.prepare('SELECT status FROM uid_migration_runs WHERE id = ?').get('run-9') as { status: string };
    expect(run.status).toBe('failed');
  });

  it('項目参照のUPDATEが落ちても作った行を把握して消す', async () => {
    const testDb = createTestD1();
    seedCreateRun(testDb);
    const usersBefore = (testDb.raw.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }).count;
    const brokenDb = throwOnItemPointer(testDb.db);
    const response = await appFor(brokenDb, executor).fetch(
      post('/api/friends/migrations/run-9/execute'), envFor(brokenDb),
    );
    expect(response.status).toBe(500);
    // INSERT成立直後から追跡しているため、参照UPDATE故障でも取り残さない。
    expect(friendUserId(testDb, 'f-old')).toBeNull();
    expect(countUid(testDb, 'acc-to', 'UNEW-9')).toBe(0);
    const item = createItem(testDb);
    expect(item.result).toBe('pending');
    expect(item.new_friend_id).toBeNull();
    expect((testDb.raw.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }).count).toBe(usersBefore);
    const run = testDb.raw.prepare('SELECT status FROM uid_migration_runs WHERE id = ?').get('run-9') as { status: string };
    expect(run.status).toBe('failed');
  });

  it('成功済みの再実行は止まり重複を作らない', async () => {
    const testDb = createTestD1();
    seedCreateRun(testDb);
    const first = await appFor(testDb.db, executor).fetch(
      post('/api/friends/migrations/run-9/execute'), envFor(testDb.db),
    );
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ success: true, data: { status: 'completed' } });
    const second = await appFor(testDb.db, executor).fetch(
      post('/api/friends/migrations/run-9/execute'), envFor(testDb.db),
    );
    expect(second.status).toBe(409);
    expect(countUid(testDb, 'acc-to', 'UNEW-9')).toBe(1);
    expect(createItem(testDb).result).toBe('applied');
  });
});

describe('F-3 切り戻しは作った友だちを残し結び付けだけ戻す', () => {
  function seedAppliedCreate(testDb: SqliteD1): void {
    seedCreateRun(testDb, { status: 'completed' });
    testDb.raw.prepare(`
      INSERT INTO users (
        id, tenant_id, status, display_name, revision, created_by, created_at, updated_at
      ) VALUES ('user-u1', ?, 'active', '移行先の本人', 2, 'owner-2',
        '2026-08-30T09:00:00.000Z', '2026-08-30T09:00:00.000Z')
    `).run(DEFAULT_TENANT_ID);
    insertFriend(testDb.raw, 'f-made', {
      line_account_id: 'acc-to', line_user_id: 'UNEW-9',
      display_name: '旧表示', user_id: 'user-u1',
    });
    testDb.raw.prepare(`UPDATE friends SET user_id = 'user-u1' WHERE id = 'f-old'`).run();
    testDb.raw.prepare(`UPDATE uid_migration_runs SET applied_count = 1 WHERE id = 'run-9'`).run();
    testDb.raw.prepare(`
      UPDATE uid_migration_items
        SET result = 'applied', new_friend_id = 'f-made',
            before_json = '{"oldUserId":null,"newUserId":null}',
            after_json = '{"userId":"user-u1"}'
        WHERE id = 'item-9'
    `).run();
  }

  it('作った行は残し旧友だちの結び付けだけ戻る', async () => {
    const testDb = createTestD1();
    seedAppliedCreate(testDb);
    const response = await appFor(testDb.db, executor).fetch(
      post('/api/friends/migrations/run-9/rollback'), envFor(testDb.db),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, data: { rolledBack: 1 } });
    // 作った友だちは残る（行は消さない）。
    expect(countUid(testDb, 'acc-to', 'UNEW-9')).toBe(1);
    // 結び付けだけ戻る。
    expect(friendUserId(testDb, 'f-old')).toBeNull();
    expect(friendUserId(testDb, 'f-made')).toBeNull();
    expect(createItem(testDb).result).toBe('rolled_back');
  });
});
