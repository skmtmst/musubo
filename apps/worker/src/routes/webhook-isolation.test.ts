import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import { recordIncomingLineMessage, recordLineMessageUnsend, listLineAccountsWithTenantStatus } from '@line-crm/db';
import { DEFAULT_TENANT_ID } from '@line-crm/shared';
import type { LineClient } from '@line-crm/line-sdk';
import { ensureFriendFromWebhookUser } from './webhook-definition-is-friend-scope-conflict.js';
import { webhook } from './webhook.js';
import { isPublicApiBoundary } from '../middleware/public-api-boundary.js';
import { createTestD1, insertFriend, type SqliteD1 } from '../test-utils/d1-sqlite.js';
import type { Env } from '../index.js';

let item: SqliteD1;
beforeEach(() => {
  item = createTestD1();
  for (const [id, channel] of [['a', '1001'], ['b', '1002']]) {
    item.raw.prepare("INSERT INTO tenants (id,name,status) VALUES (?,?,'suspended')").run(`tenant-${id}`, id);
    item.raw.prepare(`INSERT INTO line_accounts (id,channel_id,name,channel_secret,channel_access_token,tenant_id)
      VALUES (?,?,?,?,?,?)`).run(id, channel, id, `secret-${id}`, `token-${id}`, `tenant-${id}`);
    insertFriend(item.raw, `friend-${id}`, { line_account_id: id, line_user_id: `U-${id}` });
  }
});
afterEach(() => item.raw.close());

async function post(path: string, secret: string, body: unknown) {
  const app = new Hono<Env>(); app.route('/', webhook);
  const raw = JSON.stringify(body);
  const waitUntil = vi.fn();
  const response = await app.request(path, { method: 'POST', body: raw, headers: {
    'X-Line-Signature': createHmac('sha256', secret).update(raw).digest('base64'),
    'Content-Type': 'application/json',
  } }, { DB: item.db, LINE_CHANNEL_SECRET: 'secret-a', LINE_CHANNEL_ACCESS_TOKEN: 'wrong-default-token' } as Env['Bindings'],
  { waitUntil, passThroughOnException: vi.fn(), props: {} } as unknown as ExecutionContext);
  for (const [promise] of waitUntil.mock.calls) await promise;
  return { response, scheduled: waitUntil.mock.calls.length };
}
const unsend = (id: string) => ({ destination: 'forged-other-bot', events: [{ type: 'unsend', webhookEventId: id,
  timestamp: Date.now(), source: { type: 'user', userId: 'U-shared' }, unsend: { messageId: 'same-message' } }] });
const message = (id: string, text: string) => ({ destination: 'same-destination', events: [{ type: 'message', webhookEventId: id,
  timestamp: Date.now(), source: { type: 'user', userId: 'U-shared' }, message: { type: 'text', id: 'same-message', text } }] });
async function seedMessage(account: string, key = `account:${account}`) {
  return recordIncomingLineMessage(item.db, { id: `message-${account}`, friendId: `friend-${account}`,
    lineAccountId: account, lineMessageAccountKey: key, lineMessageId: 'same-message', messageType: 'text',
    content: `private-${account}`, createdAt: '2026-10-19T12:00:00+09:00' });
}

describe('real signatures + real database: customer isolation', () => {
  test.each(['/webhook/1001', '/webhook'])('same destination and message ID stay separate at %s', async (path) => {
    const a = message('event-a', 'private-a'); a.events[0]!.source.userId = 'U-a';
    await post(path, 'secret-a', a);
    const b = message('event-b', 'private-b'); b.events[0]!.source.userId = 'U-b';
    await post(path === '/webhook' ? path : '/webhook/1002', 'secret-b', b);
    expect(item.raw.prepare('SELECT line_account_id,content FROM messages_log ORDER BY line_account_id').all())
      .toEqual([{ line_account_id: 'a', content: 'private-a' }, { line_account_id: 'b', content: 'private-b' }]);
  });
  test('a valid B signature cannot use A URL, query parameters or the env default', async () => {
    const out = await post('/webhook/1001?lineAccountId=b', 'secret-b', unsend('wrong-path'));
    expect(out.response.status).toBe(200); expect(out.scheduled).toBe(0);
    expect(item.raw.prepare('SELECT * FROM line_message_unsends').all()).toEqual([]);
    expect(item.raw.prepare('SELECT last_webhook_received_at FROM line_accounts WHERE id=?').get('a')).toEqual({ last_webhook_received_at: null });
  });
  test.each(['/webhook', '/webhook/1002'])('forged destination cannot cancel another customer at %s, including historical rows', async (path) => {
    await seedMessage('a', 'destination:forged-other-bot'); await seedMessage('b');
    await post(path, 'secret-b', unsend('cancel-b'));
    expect(item.raw.prepare('SELECT line_account_id,content FROM messages_log ORDER BY line_account_id').all())
      .toEqual([{ line_account_id: 'a', content: 'private-a' }, { line_account_id: 'b', content: '' }]);
    await post('/webhook/1001', 'secret-a', unsend('cancel-a'));
    expect(item.raw.prepare('SELECT content FROM messages_log WHERE line_account_id=?').get('a')).toEqual({ content: '' });
  });
  test('a pre-arrival cancellation affects only its authenticated account', async () => {
    await post('/webhook/1002', 'secret-b', unsend('early-b'));
    await seedMessage('a'); const b = await seedMessage('b');
    expect(b.isUnsent).toBe(true);
    expect(item.raw.prepare('SELECT content FROM messages_log WHERE line_account_id=?').get('a')).toEqual({ content: 'private-a' });
  });
  test('a historical message is not duplicated or resurrected on migration/redelivery', async () => {
    await seedMessage('a', 'destination:old-bot');
    await recordLineMessageUnsend(item.db, { lineAccountId: 'a', lineMessageAccountKey: 'account:a',
      lineMessageId: 'same-message', sourceUserId: 'U-shared', unsentAt: '2026-10-19T12:01:00+09:00' });
    const retried = await recordIncomingLineMessage(item.db, { id: 'retry', friendId: 'friend-a', lineAccountId: 'a',
      lineMessageAccountKey: 'account:a', lineMessageId: 'same-message', messageType: 'text', content: 'must-not-return', createdAt: '2026-10-19T12:02:00+09:00' });
    expect(retried).toMatchObject({ id: 'message-a', inserted: false, isUnsent: true });
    expect(item.raw.prepare('SELECT count(*) AS n FROM messages_log').get()).toEqual({ n: 1 });
  });
  test('a pre-upgrade cancellation keeps a late message hidden without mutating the old receipt', async () => {
    item.raw.prepare("INSERT INTO line_message_unsends(line_message_account_key,line_message_id,source_user_id,unsent_at) VALUES('destination:same-destination','same-message','U-a','2026-10-19T12:00:00+09:00')").run();
    const body = message('late-a', 'must-stay-hidden'); body.events[0]!.source.userId='U-a';
    await post('/webhook/1001', 'secret-a', body);
    expect(item.raw.prepare("SELECT content,unsent_at FROM messages_log WHERE line_account_id='a'").get())
      .toEqual({content:'',unsent_at:'2026-10-19T12:00:00+09:00'});
    expect(item.raw.prepare('SELECT count(*) AS n FROM line_message_unsends').get()).toEqual({n:1});
  });
  test('ambiguous legacy credentials fail closed rather than choosing the first customer', async () => {
    item.raw.prepare("UPDATE line_accounts SET channel_secret='secret-a' WHERE id='b'").run();
    expect((await post('/webhook', 'secret-a', unsend('ambiguous'))).scheduled).toBe(0);
    expect(item.raw.prepare('SELECT * FROM line_message_unsends').all()).toEqual([]);
  });
  test.each(['unknown', 'inactive', 'archived', 'invalid-signature', 'invalid-body'])('%s has no persistence side effects', async (mode) => {
    if (mode === 'inactive') item.raw.prepare("UPDATE line_accounts SET is_active=0 WHERE id='a'").run();
    if (mode === 'archived') item.raw.prepare("UPDATE line_accounts SET archived_at='2026-10-19' WHERE id='a'").run();
    const out = await post(mode === 'unknown' ? '/webhook/9999' : '/webhook/1001', mode === 'invalid-signature' ? 'wrong' : 'secret-a', mode === 'invalid-body' ? { events: [] } : unsend('invalid'));
    expect(out.scheduled).toBe(0); expect(item.raw.prepare('SELECT * FROM line_webhook_events').all()).toEqual([]);
  });
  test('the legacy global user-ID constraint never moves another customer\'s friend', async () => {
    const body = { destination: 'same-destination', events: [{ type: 'unfollow', webhookEventId: 'foreign-user',
      timestamp: Date.now(), source: { type: 'user', userId: 'U-a' } }] };
    await post('/webhook/1002', 'secret-b', body);
    expect(item.raw.prepare("SELECT line_account_id,is_following FROM friends WHERE id='friend-a'").get())
      .toEqual({ line_account_id: 'a', is_following: 1 });
  });
  test('a racing account creates its own friend when the legacy row was claimed first', async () => {
    item.raw.prepare("UPDATE line_accounts SET tenant_id = ? WHERE id IN ('a','b')").run(DEFAULT_TENANT_ID);
    insertFriend(item.raw, 'legacy-friend', { line_account_id: null, line_user_id: 'U-shared', display_name: 'Legacy profile' });
    const prepare = item.db.prepare.bind(item.db);
    const race = vi.spyOn(item.db, 'prepare').mockImplementation(sql => {
      if (sql.startsWith('UPDATE friends SET line_account_id = ?')) {
        item.raw.prepare("UPDATE friends SET line_account_id = 'a' WHERE id = 'legacy-friend' AND line_account_id IS NULL").run();
      }
      return prepare(sql);
    });
    const getProfile = vi.fn().mockResolvedValue({ displayName: 'Profile from account B' });
    const friend = await ensureFriendFromWebhookUser(item.db, { getProfile } as unknown as LineClient, 'U-shared', 'b')
      .finally(() => race.mockRestore());

    expect(getProfile).toHaveBeenCalledExactlyOnceWith('U-shared');
    expect(friend).toMatchObject({ line_account_id: 'b', line_user_id: 'U-shared', display_name: 'Profile from account B' });
    expect(friend?.id).not.toBe('legacy-friend');
    expect(item.raw.prepare(
      'SELECT id, line_account_id, display_name FROM friends WHERE line_platform_user_id = ? ORDER BY line_account_id',
    ).all('U-shared')).toEqual([
      { id: 'legacy-friend', line_account_id: 'a', display_name: 'Legacy profile' },
      { id: friend?.id, line_account_id: 'b', display_name: 'Profile from account B' },
    ]);
  });

  test('scoped lookup reads only the specified channel and preserves tenant suspension', async () => {
    const rows = await listLineAccountsWithTenantStatus(item.db, undefined, '1002');
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ id: 'b', tenant_status: 'suspended' });
    expect(isPublicApiBoundary('POST', '/webhook/1002')).toBe(true);
    expect(isPublicApiBoundary('POST', '/webhook/1002/extra')).toBe(false);
  });
});
