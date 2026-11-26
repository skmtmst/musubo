import { expect, test } from 'vitest';
import { encodeScopedFriendLineUserId } from '@line-crm/db';
import { createTestD1, insertFriend } from '../test-utils/d1-sqlite.js';
import { getFriendsByLineUserIds, readProxyPushRecipient } from './line-proxy-recipients.js';

test('only the default tenant can use an unassigned friend as a legacy recipient', async () => {
  const { db, raw } = createTestD1();
  try {
    raw.exec(`
      INSERT INTO tenants(id, name) VALUES ('other', 'Other');
      INSERT INTO line_accounts(id, name, channel_id, channel_secret, channel_access_token, tenant_id)
        VALUES ('default-shop', 'Default', '1001', 'fixture', 'fixture', NULL),
               ('other-shop', 'Other', '1002', 'fixture', 'fixture', 'other');
    `);
    insertFriend(raw, 'legacy');
    insertFriend(raw, 'first-local', { line_user_id: 'Ulocal', line_account_id: 'default-shop' });
    insertFriend(raw, 'local', {
      line_user_id: encodeScopedFriendLineUserId('local', 'Ulocal', 'other-shop'),
      line_account_id: 'other-shop',
    });

    const scoped = await getFriendsByLineUserIds(db, ['Ulegacy', 'Ulocal'], 'other-shop');
    expect([...scoped.keys()]).toEqual(['Ulocal']);
    expect((await readProxyPushRecipient(db, 'other-shop', 'Ulegacy')).friend).toBeNull();
    expect((await readProxyPushRecipient(db, 'other-shop', 'Ulocal')).friend)
      .toMatchObject({ id: 'local', line_user_id: 'Ulocal' });
    expect((await readProxyPushRecipient(db, 'default-shop', 'Ulocal')).friend?.id).toBe('first-local');
    expect((await getFriendsByLineUserIds(db, ['Ulegacy'], 'default-shop')).get('Ulegacy')?.id).toBe('legacy');
    expect((await readProxyPushRecipient(db, 'default-shop', 'Ulegacy')).friend?.id).toBe('legacy');
  } finally {
    raw.close();
  }
});
