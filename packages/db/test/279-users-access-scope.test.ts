import Database from 'better-sqlite3';
import { beforeEach, describe, expect, test } from 'vitest';
import { DEFAULT_TENANT_ID } from '@line-crm/shared';
import {
  getUserByEmailForAccess,
  getUserByIdForAccess,
  getUserByPhoneForAccess,
  getUsersForAccess,
  type UserAccessScope,
} from '../src/users.js';
import { asD1 } from './d1-test-helper.js';

describe('users tenant and account access scope', () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        tenant_id TEXT,
        email TEXT,
        phone TEXT,
        external_id TEXT,
        display_name TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        archived_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE line_accounts (id TEXT PRIMARY KEY, tenant_id TEXT);
      CREATE TABLE friends (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        line_account_id TEXT
      );

      INSERT INTO line_accounts VALUES
        ('account-a1', '${DEFAULT_TENANT_ID}'),
        ('account-a2', '${DEFAULT_TENANT_ID}'),
        ('account-b', 'tenant-b');
      INSERT INTO users
        (id, tenant_id, email, phone, external_id, display_name, created_at, updated_at)
        VALUES
        ('user-a1', '${DEFAULT_TENANT_ID}', 'a1@example.com', '09000000001', NULL, 'A1', '2026-09-01', '2026-09-01'),
        ('user-a2', '${DEFAULT_TENANT_ID}', 'a2@example.com', '09000000002', NULL, 'A2', '2026-09-02', '2026-09-02'),
        ('user-b', 'tenant-b', 'secret@example.com', '09000009999', NULL, 'B', '2026-09-03', '2026-09-03'),
        ('user-legacy', NULL, 'legacy@example.com', '09000000003', NULL, 'Legacy', '2026-09-04', '2026-09-04'),
        ('user-mixed', NULL, 'mixed@example.com', '09000000004', NULL, 'Mixed', '2026-09-05', '2026-09-05'),
        ('user-unlinked', '${DEFAULT_TENANT_ID}', 'unlinked@example.com', '09000000005', NULL, 'Unlinked', '2026-09-06', '2026-09-06');
      INSERT INTO friends VALUES
        ('friend-a1', 'user-a1', 'account-a1'),
        ('friend-a2', 'user-a2', 'account-a2'),
        ('friend-b', 'user-b', 'account-b'),
        ('friend-legacy', 'user-legacy', 'account-a1'),
        ('friend-mixed-a', 'user-mixed', 'account-a1'),
        ('friend-mixed-b', 'user-mixed', 'account-b');
    `);
  });

  const scope = (overrides: Partial<UserAccessScope> = {}): UserAccessScope => ({
    tenantId: DEFAULT_TENANT_ID,
    allowedAccountIds: ['account-a1', 'account-a2'],
    includeUnlinked: true,
    ...overrides,
  });

  test('tenant-wide access excludes another tenant and mixed-tenant users', async () => {
    const rows = await getUsersForAccess(asD1(sqlite), scope());
    expect(rows.map((row) => row.id).sort()).toEqual([
      'user-a1', 'user-a2', 'user-legacy', 'user-unlinked',
    ]);
    expect(rows.map((row) => row.email)).not.toContain('secret@example.com');
  });

  test('account-scoped access excludes other accounts and unlinked users', async () => {
    const rows = await getUsersForAccess(asD1(sqlite), scope({
      allowedAccountIds: ['account-a1'],
      includeUnlinked: false,
    }));
    expect(rows.map((row) => row.id).sort()).toEqual(['user-a1', 'user-legacy']);
  });

  test('detail and matching never return a user outside the same access scope', async () => {
    const db = asD1(sqlite);
    const accountA1 = scope({ allowedAccountIds: ['account-a1'], includeUnlinked: false });
    await expect(getUserByIdForAccess(db, 'user-b', accountA1)).resolves.toBeNull();
    await expect(getUserByEmailForAccess(db, 'secret@example.com', accountA1)).resolves.toBeNull();
    await expect(getUserByPhoneForAccess(db, '09000000002', accountA1)).resolves.toBeNull();
    await expect(getUserByIdForAccess(db, 'user-a1', accountA1)).resolves.toMatchObject({
      id: 'user-a1',
      email: 'a1@example.com',
    });
  });
});
