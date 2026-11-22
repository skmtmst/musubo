import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, test } from 'vitest';
import { getAffiliateById, getAffiliates, updateAffiliate } from '../src/affiliates.js';

const ROOT = join(import.meta.dirname, '..');
const MIGRATIONS = join(ROOT, 'migrations');
const DEFAULT_TENANT_ID = '00000000-0000-4000-8000-000000000001';

function execSafe(db: Database.Database, sql: string): void {
  for (const statement of sql.split(/;\s*(?:\r?\n|$)/).map((part) => part.trim()).filter(Boolean)) {
    try {
      db.exec(statement);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/duplicate column name|already exists/i.test(message)) throw error;
    }
  }
}

function setupBefore288(): Database.Database {
  const db = new Database(':memory:');
  execSafe(db, readFileSync(join(ROOT, 'schema.sql'), 'utf8'));
  for (const file of readdirSync(MIGRATIONS).filter((name) => {
    const number = Number.parseInt(name.split('_')[0] ?? '', 10);
    return name.endsWith('.sql') && number <= 286;
  }).sort()) {
    execSafe(db, readFileSync(join(MIGRATIONS, file), 'utf8'));
  }
  return db;
}

function asD1(sqlite: Database.Database): D1Database {
  return {
    prepare(query: string) {
      return {
        bind(...params: unknown[]) {
          const statement = sqlite.prepare(query);
          return {
            async run() {
              statement.run(...params);
              return { results: [], success: true, meta: {} };
            },
            async first<T>() {
              return (statement.get(...params) as T) ?? null;
            },
            async all<T>() {
              return { results: statement.all(...params) as T[], success: true, meta: {} };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

describe('288 affiliate account scope migration', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = setupBefore288();
    db.prepare(`INSERT OR IGNORE INTO tenants (id, name, created_at, updated_at)
      VALUES (?, '既定統括', '2026-09-04', '2026-09-04')`).run(DEFAULT_TENANT_ID);
    db.prepare(`INSERT INTO tenants (id, name, created_at, updated_at)
      VALUES ('tenant-b', '別統括', '2026-09-04', '2026-09-04')`).run();
    const insertAccount = db.prepare(`INSERT INTO line_accounts
      (id, channel_id, name, channel_secret, channel_access_token, tenant_id, created_at, updated_at)
      VALUES (?, ?, ?, 'secret', 'token', ?, '2026-09-04', '2026-09-04')`);
    insertAccount.run('account-a', 'channel-a', 'A店', DEFAULT_TENANT_ID);
    insertAccount.run('account-b', 'channel-b', 'B店', 'tenant-b');

    const insertFriend = db.prepare(`INSERT INTO friends
      (id, line_user_id, display_name, line_account_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, '2026-09-04', '2026-09-04')`);
    insertFriend.run('friend-a', 'Ua', 'Aさん', 'account-a');

    db.exec(`
      INSERT INTO affiliates (id, name, code, is_active, created_at, friend_id) VALUES
        ('aff-friend', '友だちから判定', 'friend-code', 1, '2026-09-04', 'friend-a'),
        ('aff-link', 'リンクから判定', 'link-code', 1, '2026-09-04', NULL),
        ('aff-ambiguous', '複数候補', 'ambiguous-code', 1, '2026-09-04', NULL);
      INSERT INTO affiliate_links
        (id, affiliate_id, ref_code, line_account_id, is_active, created_at) VALUES
        ('link-b', 'aff-link', 'ref-b', 'account-b', 1, '2026-09-04'),
        ('link-a1', 'aff-ambiguous', 'ref-a1', 'account-a', 1, '2026-09-04'),
        ('link-b1', 'aff-ambiguous', 'ref-b1', 'account-b', 1, '2026-09-04');
    `);
  });

  test('候補が一意な既存紹介者だけを同じ統括・アカウントへ補完する', () => {
    execSafe(db, readFileSync(join(MIGRATIONS, '288_affiliate_account_scope.sql'), 'utf8'));

    const rows = db.prepare(`SELECT id, tenant_id, line_account_id FROM affiliates ORDER BY id`)
      .all() as Array<{ id: string; tenant_id: string; line_account_id: string | null }>;
    expect(rows).toEqual([
      { id: 'aff-ambiguous', tenant_id: DEFAULT_TENANT_ID, line_account_id: null },
      { id: 'aff-friend', tenant_id: DEFAULT_TENANT_ID, line_account_id: 'account-a' },
      { id: 'aff-link', tenant_id: 'tenant-b', line_account_id: 'account-b' },
    ]);
  });

  test('一覧・詳細・更新はテナントとLINEアカウントを越えない', async () => {
    execSafe(db, readFileSync(join(MIGRATIONS, '288_affiliate_account_scope.sql'), 'utf8'));
    // 現行の読取処理が参照する、後年の purge 状態だけを補う。
    db.exec('ALTER TABLE tenants ADD COLUMN purge_started_at TEXT; ALTER TABLE tenants ADD COLUMN data_purged_at TEXT; CREATE TABLE tenant_purge_tombstone_progress (tenant_id TEXT,table_name TEXT,row_id TEXT)');
    const d1 = asD1(db);
    const ownScope = {
      tenantId: DEFAULT_TENANT_ID,
      allowedLineAccountIds: ['account-a'],
    };

    expect((await getAffiliates(d1, ownScope)).map((affiliate) => affiliate.id)).toEqual([
      'aff-friend',
    ]);
    expect(await getAffiliateById(d1, 'aff-link', ownScope)).toBeNull();
    expect(await updateAffiliate(d1, 'aff-link', { name: '書き換え不可' }, ownScope)).toBeNull();
    expect(db.prepare(`SELECT name FROM affiliates WHERE id = 'aff-link'`).get()).toEqual({
      name: 'リンクから判定',
    });
  });
});
