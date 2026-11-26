import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LineApiError, type LineClient, type WebhookEvent } from '@line-crm/line-sdk';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';
import {
  handleFirstMessageTestEvent,
  hasReceivedFirstMessageTest,
  issueFirstMessageIdentity,
  readFirstMessageTest,
  sendFirstMessageTest,
} from './getting-started-first-message.js';

vi.mock('./send-entitlements.js', () => ({
  getSendPermissionForAccount: async () => ({ allowed: true }),
}));

type Push = LineClient['pushMessageWithRequestId'];

const first = { accountId: 'account-a', staffId: 'staff-a' };
const second = { accountId: 'account-b', staffId: 'staff-a' };
const alternative = { accountId: 'account-a', staffId: 'staff-b' };
const baseEvent = {
  mode: 'active',
  source: { type: 'user', userId: 'U-shop-per-provider' },
  webhookEventId: 'event-a',
  deliveryContext: { isRedelivery: false },
  replyToken: 'reply',
} as const;

function postback(data: string, userId = 'U-shop-per-provider', timestamp = Date.now() + 100): WebhookEvent {
  return { ...baseEvent, type: 'postback', timestamp, source: { type: 'user', userId }, postback: { data } };
}

function textEvent(text: string, timestamp = Date.now() + 100): WebhookEvent {
  return { ...baseEvent, type: 'message', timestamp, message: { id: 'message-a', type: 'text', text } };
}

describe('opening guide first-message test', () => {
  let test: SqliteD1;
  let db: D1Database;
  beforeEach(() => {
    test = createTestD1({ foreignKeys: true });
    db = test.db;
    test.raw.exec(`
      INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret,line_basic_id)
        VALUES('account-a','channel-a','試験店 A','test-token-a','test-secret-a','@shop-a'),
              ('account-b','channel-b','試験店 B','test-token-b','test-secret-b','@shop-b');
      INSERT INTO staff_members(id,name,role,api_key,line_user_id) VALUES
        ('staff-a','担当 A','owner','test-api-a','U-shop-per-provider'),
        ('staff-b','担当 B','owner','test-api-b','U-from-other-provider');
      INSERT INTO friends(id,line_user_id,line_account_id,is_following) VALUES
        ('friend-a','U-shop-per-provider','account-a',1),
        ('friend-b','musubo-scope:friend-b:U-shop-per-provider','account-b',1),
        ('friend-c','U-from-other-provider','account-b',1);
    `);
  });
  afterEach(() => { test?.raw.close(); });

  it('uses the selected official account and sends only once across concurrent clicks and refreshes', async () => {
    const push = vi.fn<Push>(async () => ({ requestId: 'line-accepted', data: {} }));
    const createClient = vi.fn(() => ({ pushMessageWithRequestId: push }));
    expect(await readFirstMessageTest(db, first)).toMatchObject({ status: 'ready', accountName: '試験店 A' });
    const outcomes = await Promise.all([
      sendFirstMessageTest(db, first, { createClient }),
      sendFirstMessageTest(db, first, { createClient }),
    ]);
    expect(outcomes.map(outcome => outcome.status)).toContain('sent');
    expect(createClient).toHaveBeenCalledExactlyOnceWith('test-token-a');
    expect(push).toHaveBeenCalledTimes(1);
    const [recipient, messages, retryKey] = push.mock.calls[0];
    expect(recipient).toBe('U-shop-per-provider');
    const data = 'musubo-first-message-received:' + retryKey;
    expect(messages).toMatchObject([{ type: 'template', template: {
      type: 'buttons', actions: [{ type: 'postback', label: '受け取りました', data }],
    } }]);

    await handleFirstMessageTestEvent(db, 'account-b', postback(data));
    await handleFirstMessageTestEvent(db, 'account-a', postback(data, 'U-other-user'));
    await handleFirstMessageTestEvent(db, 'account-a', postback(data, recipient, 1));
    expect(await hasReceivedFirstMessageTest(db, first)).toBe(false);
    expect((await sendFirstMessageTest(db, first, { createClient })).status).toBe('sent');
    expect(push).toHaveBeenCalledTimes(1);

    await handleFirstMessageTestEvent(db, 'account-a', postback(data));
    await handleFirstMessageTestEvent(db, 'account-a', postback(data));
    expect(await hasReceivedFirstMessageTest(db, first)).toBe(true);
    expect(await hasReceivedFirstMessageTest(db, second)).toBe(false);
    expect(await hasReceivedFirstMessageTest(db, alternative)).toBe(false);
    expect(await readFirstMessageTest(db, first)).toMatchObject({ status: 'received' });
  });

  it('binds the verification to the selected store and waits for a matching active friend', async () => {
    expect(await readFirstMessageTest(db, alternative)).toMatchObject({ status: 'identity_required', verificationPending: false });
    const url = await issueFirstMessageIdentity(db, alternative);
    expect(url).toMatch(/^https:\/\/line\.me\/R\/oaMessage\/%40shop-a\//);
    const command = decodeURIComponent(new URL(url!).search.slice(1));
    expect(await readFirstMessageTest(db, alternative)).toMatchObject({ status: 'identity_required', verificationPending: true });
    await handleFirstMessageTestEvent(db, 'account-b', textEvent(command));
    await handleFirstMessageTestEvent(db, 'account-a', textEvent(command, 1));
    expect((await readFirstMessageTest(db, alternative)).status).toBe('identity_required');

    test.raw.exec("UPDATE friends SET is_following=0 WHERE id='friend-a'");
    await handleFirstMessageTestEvent(db, 'account-a', textEvent(command));
    expect(await readFirstMessageTest(db, alternative)).toMatchObject({ status: 'friend_required', verificationPending: false });
    const push = vi.fn<Push>(async () => ({ requestId: 'line-accepted', data: {} }));
    expect((await sendFirstMessageTest(db, alternative, { createClient: () => ({ pushMessageWithRequestId: push }) })).status).toBe('friend_required');
    expect(push).not.toHaveBeenCalled();
    test.raw.exec("UPDATE friends SET is_following=1 WHERE id='friend-a'");
    expect((await readFirstMessageTest(db, alternative)).status).toBe('ready');
  });

  it('retries a known throttled request after its retry deadline with the same key, and never resends an unknown result', async () => {
    const push = vi.fn<Push>()
      .mockRejectedValueOnce(new LineApiError(429, '3'))
      .mockRejectedValueOnce(new LineApiError(503, null));
    const dependencies = { createClient: () => ({ pushMessageWithRequestId: push }) };
    const now = vi.spyOn(Date, 'now');
    try {
      const busy = await sendFirstMessageTest(db, first, dependencies);
      expect(busy.status).toBe('busy');
      expect((await sendFirstMessageTest(db, first, dependencies)).status).toBe('busy');
      expect(push).toHaveBeenCalledTimes(1);
      now.mockReturnValue(busy.retryAt! + 10);
      expect((await sendFirstMessageTest(db, first, dependencies)).status).toBe('unknown');
      expect((await sendFirstMessageTest(db, first, dependencies)).status).toBe('unknown');
      expect(push).toHaveBeenCalledTimes(2);
      const [, , key] = push.mock.calls[0];
      expect(push.mock.calls[1][2]).toBe(key);
      await handleFirstMessageTestEvent(db, 'account-a', postback('musubo-first-message-received:' + key));
      expect((await readFirstMessageTest(db, first)).status).toBe('received');
    } finally { now.mockRestore(); }
  });

  it('allows an explicit retry with the same key after a definite rejection is corrected', async () => {
    const push = vi.fn<Push>()
      .mockRejectedValueOnce(new LineApiError(400, null))
      .mockResolvedValueOnce({ requestId: 'line-accepted', data: {} });
    const dependencies = { createClient: () => ({ pushMessageWithRequestId: push }) };
    expect((await sendFirstMessageTest(db, first, dependencies)).status).toBe('failed');
    expect((await readFirstMessageTest(db, first)).status).toBe('failed');
    expect(push).toHaveBeenCalledTimes(1);
    expect((await sendFirstMessageTest(db, first, dependencies)).status).toBe('sent');
    expect(push.mock.calls[1][2]).toBe(push.mock.calls[0][2]);
  });

  it('keeps the signed receipt if LINE delivers before the accepted response is recorded', async () => {
    const delivered = vi.fn<Push>(async (_recipient, _messages, key) => {
      await handleFirstMessageTestEvent(db, 'account-a', postback('musubo-first-message-received:' + key));
      return { requestId: 'line-accepted', data: {} };
    });
    const outcome = await sendFirstMessageTest(db, first, { createClient: () => ({ pushMessageWithRequestId: delivered }) });
    expect(outcome.status).toBe('received');
  });
});
