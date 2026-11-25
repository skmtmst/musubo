import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { recordIncomingLineMessage } from '@line-crm/db';
import { createTestD1, insertFriend, type SqliteD1 } from '../test-utils/d1-sqlite.js';
import { getLineRegistrationReceipt } from './line-registration-receipt.js';

const createdAt = '2026-10-20T10:00:00.000+09:00';
let item: SqliteD1;

beforeEach(() => {
  item = createTestD1();
  for (const [id, channel] of [['a', '1001'], ['b', '1002']]) {
    item.raw.prepare(`INSERT INTO line_accounts
      (id, channel_id, name, channel_secret, channel_access_token, created_at)
      VALUES (?, ?, ?, 'secret', 'token', ?)`)
      .run(id, channel, id, createdAt);
    insertFriend(item.raw, `friend-${id}`, { line_account_id: id });
  }
});
afterEach(() => item.raw.close());

function event(id: string, account: string, type: 'follow' | 'message', status: 'succeeded' | 'failed', at: string) {
  item.raw.prepare(`INSERT INTO line_webhook_events
    (webhook_event_id, line_account_id, event_type, status, received_at)
    VALUES (?, ?, ?, ?, ?)`).run(id, account, type, status, at);
}

describe('LINE registration receipt', () => {
  test('an imported friend, another account, and an old follow do not unlock the wizard', async () => {
    event('other', 'b', 'follow', 'succeeded', '2026-10-20T10:01:00.000');
    item.raw.prepare(`INSERT INTO friend_add_events
      (id, line_account_id, friend_id, webhook_event_id, friend_kind, occurred_at)
      VALUES ('other', 'b', 'friend-b', 'other', 'first_time', ?)`)
      .run(createdAt);
    event('old', 'a', 'follow', 'succeeded', '2026-10-20T09:59:59.000');
    item.raw.prepare(`INSERT INTO friend_add_events
      (id, line_account_id, friend_id, webhook_event_id, friend_kind, occurred_at)
      VALUES ('old', 'a', 'friend-a', 'old', 'first_time', ?)`)
      .run(createdAt);
    expect(await getLineRegistrationReceipt(item.db, 'a')).toEqual({ status: 'waiting', receivedAt: null });
  });

  test('a signed follow must complete and persist the right friend before confirmation', async () => {
    event('follow', 'a', 'follow', 'failed', '2026-10-20T10:00:01.000');
    expect(await getLineRegistrationReceipt(item.db, 'a')).toEqual({ status: 'error', receivedAt: null });
    item.raw.prepare(`UPDATE line_webhook_events SET status='succeeded' WHERE webhook_event_id='follow'`).run();
    expect(await getLineRegistrationReceipt(item.db, 'a')).toEqual({ status: 'error', receivedAt: null });
    item.raw.prepare(`INSERT INTO friend_add_events
      (id, line_account_id, friend_id, webhook_event_id, friend_kind, occurred_at)
      VALUES ('follow', 'a', 'friend-a', 'follow', 'first_time', ?)`)
      .run(createdAt);
    expect(await getLineRegistrationReceipt(item.db, 'a'))
      .toEqual({ status: 'confirmed', receivedAt: '2026-10-20T10:00:01.000' });
  });

  test('an existing follower can confirm by sending a new message', async () => {
    await recordIncomingLineMessage(item.db, {
      id: 'message-a', friendId: 'friend-a', lineAccountId: 'a',
      lineMessageAccountKey: 'account:a', lineMessageId: 'line-message-a',
      messageType: 'text', content: '接続テスト', createdAt: '2026-10-20T10:00:02.000+09:00',
    });
    expect(await getLineRegistrationReceipt(item.db, 'a'))
      .toEqual({ status: 'confirmed', receivedAt: '2026-10-20T10:00:02.000+09:00' });
    expect(await getLineRegistrationReceipt(item.db, 'b')).toEqual({ status: 'waiting', receivedAt: null });

    item.raw.prepare("UPDATE line_accounts SET is_active = 0 WHERE id = 'a'").run();
    expect(await getLineRegistrationReceipt(item.db, 'a')).toEqual({ status: 'waiting', receivedAt: null });
    item.raw.prepare("UPDATE line_accounts SET is_active = 1, archived_at = ? WHERE id = 'a'").run(createdAt);
    expect(await getLineRegistrationReceipt(item.db, 'a')).toEqual({ status: 'waiting', receivedAt: null });
  });
});
