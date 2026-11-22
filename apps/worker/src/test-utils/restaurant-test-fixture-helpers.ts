import type { SqliteD1 } from './d1-sqlite.js';

export function seedNoticeFriend(testDb: SqliteD1, seed: () => void, lineUid: string, following: number, accountId: string): void {
  seed();
  testDb.raw.exec(`INSERT INTO line_accounts (id, name, channel_id, channel_secret, channel_access_token)
    VALUES ('account-2', '試験店舗', 'fixture-channel', 'unused', 'unused-token');`);
  testDb.raw.prepare('INSERT INTO friends (id, line_user_id, line_account_id, is_following) VALUES (?, ?, ?, ?)')
    .run('friend-fixture', lineUid, accountId, following);
}

export type MockStaff = {
  id: string;
  name: string;
  role: 'owner' | 'admin' | 'staff';
  access_level: 'full' | 'read_only';
  permission_keys: string;
  assigned_line_account_id: string | null;
  can_access_descendant_accounts: number;
  tenant_id?: string | null;
};
