/*
 * 送信予約のdispatcher。固定時計・実DBで確かめる。
 *
 *   - 期限到来だけがclaimされ、leaseが付く
 *   - claimした分だけLINEへpush(冪等キー同じ)し、messages_logへ残る
 *   - lease切れのsending滞留は回収される
 *   - 一時的な失敗は予定をずらしてscheduledへ戻す
 *   - 恒久的・送達不明の失敗はfailedへ確定して再送しない
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';
import {
  claimDueScheduledChatSends,
  createScheduledChatSend,
} from '@line-crm/db';

const pushMessage = vi.fn().mockResolvedValue({ sentMessages: [{}] });
vi.mock('@line-crm/line-sdk', () => ({
  LineClient: vi.fn().mockImplementation(function () { return ({ pushMessage }); }),
}));

const { processDueScheduledChatSends } = await import('./scheduled-chat-sends.js');

let sqlite: SqliteD1;

const NOW = '2026-01-10T00:00:00.000Z';
const env = () => ({
  DB: sqlite.db,
  LINE_CHANNEL_ACCESS_TOKEN: 'default-token',
});

function seed() {
  const raw = sqlite.raw;
  raw.prepare(`INSERT INTO tenants (id, name) VALUES ('tenant-1', '統括1')`).run();
  raw.prepare(
    `INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret, is_active, tenant_id)
     VALUES ('acc-1', 'channel-acc-1', 'acc-1', 'token-acc-1', 'secret', 1, 'tenant-1')`,
  ).run();
  raw.prepare(
    `INSERT INTO staff_members (id, name, role, api_key, tenant_id, account_scope, permission_keys)
     VALUES ('owner-1', 'オーナー', 'owner', 'key-owner', 'tenant-1', 'all', '[]')`,
  ).run();
  raw.prepare(
    `INSERT INTO friends (id, line_user_id, display_name, line_account_id) VALUES ('fr-1', 'U-1', '利用者1', 'acc-1')`,
  ).run();
}

async function schedule(input: {
  id: string;
  key: string;
  at: string;
  content?: string;
  quotedMessageId?: string | null;
}) {
  await createScheduledChatSend(sqlite.db, {
    id: input.id,
    friendId: 'fr-1',
    lineAccountId: 'acc-1',
    staffId: 'owner-1',
    messageType: 'text',
    content: input.content ?? `本文${input.id}`,
    quotedMessageId: input.quotedMessageId ?? null,
    idempotencyKey: input.key,
    scheduledAt: input.at,
    now: NOW,
  });
}

function row(id: string) {
  return sqlite.raw.prepare(`SELECT * FROM scheduled_chat_sends WHERE id = ?`).get(id) as Record<string, unknown>;
}

function allRows() {
  return sqlite.raw.prepare(`SELECT * FROM scheduled_chat_sends ORDER BY created_at`).all() as Array<Record<string, unknown>>;
}

beforeEach(() => {
  vi.clearAllMocks();
  pushMessage.mockResolvedValue({ sentMessages: [{}] });
  sqlite = createTestD1();
  seed();
});

// サーバー側の冪等照合。同じ版(対象・内容・送信予定時刻)の
// 処理中予約は、別の冪等キーが来ても新しい行を作らず再利用する。
describe('送信予約の重複登録の拒否(#977)', () => {
  test('別キーで同じ版を登録しても既存行が返り、行は1件のまま', async () => {
    await schedule({ id: 's-1', key: '11111111-2222-4333-8444-555555555555', at: '2026-01-10T01:00:00.000Z', content: '同じ文面' });

    const second = await createScheduledChatSend(sqlite.db, {
      id: 's-2',
      friendId: 'fr-1',
      lineAccountId: 'acc-1',
      staffId: 'owner-1',
      messageType: 'text',
      content: '同じ文面',
      quotedMessageId: null,
      idempotencyKey: '22222222-2222-4333-8444-555555555555',
      scheduledAt: '2026-01-10T01:00:00.000Z',
      now: NOW,
    });
    expect(second.created).toBe(false);
    expect(second.row.id).toBe('s-1');
    expect(allRows()).toHaveLength(1);
  });

  test('同一ペイロードを2連続で呼んでも行は1件(先着のみ挿入)', async () => {
    const input = {
      friendId: 'fr-1',
      lineAccountId: 'acc-1',
      staffId: 'owner-1',
      messageType: 'text',
      content: '連打',
      quotedMessageId: null,
      scheduledAt: '2026-01-10T01:00:00.000Z',
      now: NOW,
    };
    const [a, b] = await Promise.all([
      createScheduledChatSend(sqlite.db, { ...input, id: 's-a', idempotencyKey: '11111111-2222-4333-8444-555555555555' }),
      createScheduledChatSend(sqlite.db, { ...input, id: 's-b', idempotencyKey: '22222222-2222-4333-8444-555555555555' }),
    ]);
    expect([a.created, b.created].sort()).toEqual([false, true]);
    expect(allRows()).toHaveLength(1);
  });

  test('時刻・内容・引用が違えば別の予約になり、終了済みの行は照合しない', async () => {
    await schedule({ id: 's-1', key: '11111111-2222-4333-8444-555555555555', at: '2026-01-10T01:00:00.000Z', content: '同じ文面' });
    // 別時刻・別文面・別引用はすべて別の版。
    await schedule({ id: 's-2', key: '22222222-2222-4333-8444-555555555555', at: '2026-01-10T02:00:00.000Z', content: '同じ文面' });
    await schedule({ id: 's-3', key: '33333333-2222-4333-8444-555555555555', at: '2026-01-10T01:00:00.000Z', content: '別の文面' });
    expect(allRows()).toHaveLength(3);

    // 取消済みの行は照合対象から外れ、同じ版を立て直せる。
    sqlite.raw.prepare(`UPDATE scheduled_chat_sends SET status = 'cancelled' WHERE id = 's-1'`).run();
    const again = await createScheduledChatSend(sqlite.db, {
      id: 's-4',
      friendId: 'fr-1',
      lineAccountId: 'acc-1',
      staffId: 'owner-1',
      messageType: 'text',
      content: '同じ文面',
      quotedMessageId: null,
      idempotencyKey: '44444444-2222-4333-8444-555555555555',
      scheduledAt: '2026-01-10T01:00:00.000Z',
      now: NOW,
    });
    expect(again.created).toBe(true);
    expect(again.row.id).toBe('s-4');
    expect(allRows()).toHaveLength(4);
  });
});

describe('送信予約のdispatcher(N-025)', () => {
  test('停止中に期限を過ぎた予約は未送信のまま取消し、復帰後も自動送信しない', async () => {
    await schedule({ id: 's-stopped', key: '00000000-2222-4333-8444-555555555555', at: '2026-01-09T23:00:00.000Z' });
    sqlite.raw.prepare(`UPDATE tenants SET status = 'suspended' WHERE id = 'tenant-1'`).run();

    const stopped = await processDueScheduledChatSends(env(), { now: NOW });
    expect(stopped).toEqual({ claimed: 0, sent: 0, failed: 0 });
    expect(row('s-stopped')).toMatchObject({
      status: 'cancelled', last_error_code: 'tenant_suspended', sent_at: null,
    });
    expect(pushMessage).not.toHaveBeenCalled();

    sqlite.raw.prepare(`UPDATE tenants SET status = 'active' WHERE id = 'tenant-1'`).run();
    const restored = await processDueScheduledChatSends(env(), { now: '2026-01-10T01:00:00.000Z' });
    expect(restored.claimed).toBe(0);
    expect(pushMessage).not.toHaveBeenCalled();
  });

  test('期限が来た予約だけclaimして送り、履歴とsentを残す', async () => {
    await schedule({ id: 's-due', key: '11111111-2222-4333-8444-555555555555', at: '2026-01-09T23:00:00.000Z' });
    await schedule({ id: 's-later', key: '22222222-2222-4333-8444-555555555555', at: '2026-01-10T01:00:00.000Z' });

    const result = await processDueScheduledChatSends(env(), { now: NOW });
    expect(result).toEqual({ claimed: 1, sent: 1, failed: 0 });
    expect(pushMessage).toHaveBeenCalledTimes(1);
    const [to, messages, key] = pushMessage.mock.calls[0] as [string, Array<{ text: string }>, string];
    expect(to).toBe('U-1');
    expect(messages[0].text).toBe('本文s-due');
    expect(key).toBe('11111111-2222-4333-8444-555555555555');

    expect(row('s-due').status).toBe('sent');
    expect(row('s-later').status).toBe('scheduled');

    const logged = sqlite.raw.prepare(
      `SELECT id, content, source, quoted_message_id FROM messages_log WHERE friend_id = 'fr-1'`,
    ).all() as Array<{ id: string; content: string; source: string }>;
    expect(logged).toHaveLength(1);
    expect(logged[0].id).toBe('scheduled:s-due');
    expect(logged[0].source).toBe('scheduled');
  });

  test('引用付き予約はLINEへquoteTokenを付け、引用元が消えていれば引用なしで送る', async () => {
    sqlite.raw.prepare(
      `INSERT INTO messages_log
         (id, friend_id, direction, message_type, content, source, line_account_id, created_at, quote_token, unsent_at)
       VALUES ('m-q', 'fr-1', 'incoming', 'text', '質問です', 'user', 'acc-1', '2026-01-09T00:00:00.000Z', 'QT-1', NULL)`,
    ).run();
    await schedule({ id: 's-q', key: '33333333-2222-4333-8444-555555555555', at: '2026-01-09T23:00:00.000Z', quotedMessageId: 'm-q' });
    await processDueScheduledChatSends(env(), { now: NOW });
    const [, messages] = pushMessage.mock.calls[0] as [string, Array<{ quoteToken?: string }>, string];
    expect(messages[0].quoteToken).toBe('QT-1');

    // 引用元が取消済みなら引用なしで届ける。
    sqlite.raw.prepare(`UPDATE messages_log SET unsent_at = '2026-01-09T12:00:00.000Z' WHERE id = 'm-q'`).run();
    await schedule({ id: 's-q2', key: '44444444-2222-4333-8444-555555555555', at: '2026-01-09T23:30:00.000Z', quotedMessageId: 'm-q' });
    await processDueScheduledChatSends(env(), { now: NOW });
    const [, messages2] = pushMessage.mock.calls[1] as [string, Array<{ quoteToken?: string }>, string];
    expect(messages2[0].quoteToken).toBeUndefined();
    expect(row('s-q2').status).toBe('sent');
  });

  test('恒久的な失敗はfailedへ確定し、次のcronでも送り直さない', async () => {
    await schedule({ id: 's-fail', key: '55555555-2222-4333-8444-555555555555', at: '2026-01-09T23:00:00.000Z' });
    pushMessage.mockRejectedValue(Object.assign(new Error('400 invalid'), { status: 400 }));

    const first = await processDueScheduledChatSends(env(), { now: NOW });
    expect(first.failed).toBe(1);
    expect(row('s-fail').status).toBe('failed');

    const second = await processDueScheduledChatSends(env(), { now: '2026-01-10T01:00:00.000Z' });
    expect(second.claimed).toBe(0);
    expect(pushMessage).toHaveBeenCalledTimes(1);
  });

  test('claimのleaseが切れたsending滞留は回収して再送する', async () => {
    await schedule({ id: 's-stale', key: '66666666-2222-4333-8444-555555555555', at: '2026-01-09T23:00:00.000Z' });
    // まずclaimしてから、lease切れのまま止まった状態を作る。
    const claimed = await claimDueScheduledChatSends(sqlite.db, {
      now: '2026-01-09T23:00:00.000Z',
      leaseToken: 'old-lease',
    });
    expect(claimed).toHaveLength(1);
    expect(row('s-stale').status).toBe('sending');

    // lease(60秒)内では回収しない。
    const inside = await processDueScheduledChatSends(env(), { now: '2026-01-09T23:00:30.000Z' });
    expect(inside.claimed).toBe(0);

    // lease切れ後は回収されて送られる。
    const after = await processDueScheduledChatSends(env(), { now: '2026-01-09T23:02:00.000Z' });
    expect(after.sent).toBe(1);
    expect(row('s-stale').status).toBe('sent');
  });

  test('友だちが消えた予約はfailedへ確定する', async () => {
    await schedule({ id: 's-nofriend', key: '77777777-2222-4333-8444-555555555555', at: '2026-01-09T23:00:00.000Z' });
    sqlite.raw.prepare(`DELETE FROM friends WHERE id = 'fr-1'`).run();
    const result = await processDueScheduledChatSends(env(), { now: NOW });
    expect(result.failed).toBe(1);
    expect(row('s-nofriend').status).toBe('failed');
    expect(row('s-nofriend').last_error_code).toBe('friend_not_found');
  });

  // 差し込みは「送る瞬間」の値で解決する。予約から送信までの間に
  // 表示名が変わっていても、古い値ではなく新しい値が届く。
  test('差し込みは送信時の値で解決され、履歴にも解決後の本文が残る', async () => {
    await schedule({ id: 's-name', key: '88888888-2222-4333-8444-555555555555', at: '2026-01-09T23:00:00.000Z', content: '{{name}}さんへの連絡です' });
    // 予約のあとで表示名が変わった想定。
    sqlite.raw.prepare(`UPDATE friends SET display_name = '改名後' WHERE id = 'fr-1'`).run();

    const result = await processDueScheduledChatSends(env(), { now: NOW });
    expect(result).toEqual({ claimed: 1, sent: 1, failed: 0 });
    const [, messages] = pushMessage.mock.calls[0] as [string, Array<{ text: string }>, string];
    expect(messages[0].text).toBe('改名後さんへの連絡です');
    const logged = sqlite.raw.prepare(
      `SELECT content FROM messages_log WHERE id = 'scheduled:s-name'`,
    ).get() as { content: string };
    expect(logged.content).toBe('改名後さんへの連絡です');
  });

  // 解決しきれない差し込みが残る予約は LINE を呼ばない。
  // 消えた共通情報は運用者が直せば送れる失敗なので、バックオフ付きで
  // 予約へ戻して再試行する(冪等キーは同じなので重複送信にならない)。
  test('解決できない差し込みが残る予約はLINEを呼ばず再試行へ戻る', async () => {
    // {{name}} が残る状態を作るため表示名を消す。
    sqlite.raw.prepare(`UPDATE friends SET display_name = NULL WHERE id = 'fr-1'`).run();
    await schedule({ id: 's-unres', key: '99999999-2222-4333-8444-555555555555', at: '2026-01-09T23:00:00.000Z', content: '{{name}}さんへの連絡です' });

    const result = await processDueScheduledChatSends(env(), { now: NOW });
    expect(result.failed).toBe(0);
    expect(pushMessage).not.toHaveBeenCalled();
    expect(row('s-unres').status).toBe('scheduled');
    expect(row('s-unres').last_error_code).toBe('unresolved_template_variables');
    expect(String(row('s-unres').scheduled_at) > '2026-01-09T23:00:00.000Z').toBe(true);
    // 送信履歴も残らない。
    const logged = sqlite.raw.prepare(
      `SELECT COUNT(*) AS n FROM messages_log WHERE friend_id = 'fr-1'`,
    ).get() as { n: number };
    expect(logged.n).toBe(0);
  });

  test('存在しない共通情報を含む予約は送らず失敗の出所を残す', async () => {
    await schedule({ id: 's-var-missing', key: '99999999-2222-4333-8444-555555555557', at: '2026-01-09T23:00:00.000Z', content: '案内: {{var.missing}}' });
    await processDueScheduledChatSends(env(), { now: NOW });
    expect(pushMessage).not.toHaveBeenCalled();
    expect(row('s-var-missing').status).toBe('scheduled');
    expect(sqlite.raw.prepare('SELECT source_kind, var_key FROM common_var_resolution_failures').all()).toEqual([
      { source_kind: 'chat', var_key: 'missing' },
    ]);
  });

  // 直しても上限回数を超えたら failed へ確定する(無限再試行はしない)。
  test('解決失敗が上限回数を超えた予約はfailedへ確定する', async () => {
    sqlite.raw.prepare(`UPDATE friends SET display_name = NULL WHERE id = 'fr-1'`).run();
    await schedule({ id: 's-unres-max', key: '99999999-2222-4333-8444-555555555556', at: '2026-01-09T23:00:00.000Z', content: '{{name}}さんへの連絡です' });
    sqlite.raw.prepare(
      `UPDATE scheduled_chat_sends SET attempt_count = 3 WHERE id = 's-unres-max'`,
    ).run();

    const result = await processDueScheduledChatSends(env(), { now: NOW });
    expect(result.failed).toBe(1);
    expect(pushMessage).not.toHaveBeenCalled();
    expect(row('s-unres-max').status).toBe('failed');
    expect(row('s-unres-max').last_error_code).toBe('unresolved_template_variables');
  });
});

test('受理後に処理が消え、鍵の有効時間を越えた予約は自動で送り直さない', async () => {
  await schedule({id:'expired',key:'aaaaaaaa-2222-4333-8444-555555555555',at:'2026-01-09T00:00:00Z'});
  sqlite.raw.exec("UPDATE scheduled_chat_sends SET status='sending',attempt_count=1,lease_token='lost',lease_expires_at='2026-01-09T00:01:00Z',updated_at='2026-01-09T00:00:00Z'");
  await processDueScheduledChatSends(env(),{now:NOW});
  expect(pushMessage).not.toHaveBeenCalled();
  expect(row('expired')).toMatchObject({status:'failed',last_error_code:'LINE_RETRY_KEY_EXPIRED'});
});


test('予約後にブロックされた相手は送らず理由を残し、再送しない', async () => {
  await schedule({ id: 'blocked', key: '11111111-2222-4333-8444-555555555555', at: NOW });
  sqlite.raw.prepare("UPDATE friends SET is_following = 0 WHERE id = 'fr-1'").run();
  await processDueScheduledChatSends(env(), { now: NOW });
  expect(row('blocked')).toMatchObject({ status: 'failed', last_error_code: 'friend_not_following' });
  await processDueScheduledChatSends(env(), { now: '2026-01-11T00:00:00.000Z' });
  expect(pushMessage).not.toHaveBeenCalled();
});
