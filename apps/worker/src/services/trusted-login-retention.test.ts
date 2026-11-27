import { expect, it } from 'vitest';
import { createTestD1 } from '../test-utils/d1-sqlite.js';
import { purgeExpiredTrustedLogins } from './trusted-login-retention.js';

it('90日を過ぎた信頼だけを削除する', async () => {
  const db = createTestD1();
  try {
    db.raw.prepare("INSERT INTO staff_members(id,name,role,api_key) VALUES ('s','Staff','staff','key')").run();
    const insert = db.raw.prepare('INSERT INTO auth_trusted_logins VALUES (?, ?, ?, ?)');
    insert.run('s', 'old', '203.0.*.*', '2026-01-01T00:00:00.000Z');
    insert.run('s', 'new', '203.0.*.*', '2026-10-01T00:00:00.000Z');
    await purgeExpiredTrustedLogins(db.db, new Date('2026-11-25T00:00:00.000Z'));
    expect(db.raw.prepare('SELECT marker_hash FROM auth_trusted_logins').all()).toEqual([{ marker_hash: 'new' }]);
  } finally { db.raw.close(); }
});
