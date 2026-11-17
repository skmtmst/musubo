import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestD1, insertFriend, type SqliteD1 } from '../../test-utils/d1-sqlite.js';
import { createTemplate, publishTemplate } from '@line-crm/db';
import { LineClient } from '@line-crm/line-sdk';
import { buildStepMessages, testSendSteps } from './scenario-test-send.js';

/**
 * 送信元アカウントを必須とし、未公開・別アカウントの参照は step の控えへ戻すことを実 DB で確かめる。
 */
describe('実DB: テスト送信は送る側のアカウントで解決する', () => {
  let store: SqliteD1;

  beforeEach(() => {
    store = createTestD1();
    for (const [id, channel] of [['account-1', 'channel-1'], ['account-2', 'channel-2']] as const) {
      store.raw.prepare(
        `INSERT INTO line_accounts
           (id, channel_id, name, channel_access_token, channel_secret, is_active)
         VALUES (?, ?, ?, '', '', 1)`,
      ).run(id, channel, id);
    }
    insertFriend(store.raw, 'friend-1', { line_user_id: 'U1', line_account_id: 'account-1' });
  });

  const stepFor = (templateId: string | null) => ({
    id: 'step-1',
    scenario_id: 'scenario-1',
    step_order: 0,
    delay_minutes: 0,
    message_type: 'text',
    message_content: 'step の控え',
    condition_type: null,
    condition_value: null,
    next_step_on_false: null,
    offset_days: null,
    offset_minutes: null,
    delivery_time: null,
    template_id: templateId,
    question_json: null,
  });

  async function publishedTemplate(accountId: string, content: string): Promise<string> {
    const tpl = await createTemplate(store.db, {
      name: `tpl-${content}`, messageType: 'text', messageContent: content, lineAccountId: accountId,
    });
    await publishTemplate(store.db, tpl.id, { idempotencyKey: `testsend-${tpl.id}` });
    return tpl.id;
  }

  it('公開版の同一アカウントはテンプレートを送る', async () => {
    const id = await publishedTemplate('account-1', '公開版の本文');
    const messages = await buildStepMessages(store.db, stepFor(id) as never, 'friend-1', 'account-1');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ type: 'text', text: '公開版の本文' });
  });

  it('未公開・別アカウントは step の控えに落とす', async () => {
    const unpublished = await createTemplate(store.db, {
      name: '未公開', messageType: 'text', messageContent: '未公開の本文', lineAccountId: 'account-1',
    });
    const fallbackUnpublished = await buildStepMessages(
      store.db, stepFor(unpublished.id) as never, 'friend-1', 'account-1',
    );
    expect(fallbackUnpublished[0]).toMatchObject({ type: 'text', text: 'step の控え' });

    const other = await publishedTemplate('account-2', '別の本文');
    const fallbackCross = await buildStepMessages(
      store.db, stepFor(other) as never, 'friend-1', 'account-1',
    );
    expect(fallbackCross[0]).toMatchObject({ type: 'text', text: 'step の控え' });
  });

  it('テスト送信は未解決の共通情報では止め、登録済みの値を送る', async () => {
    const push = vi.spyOn(LineClient.prototype, 'pushMessage').mockResolvedValue(undefined as never);
    try {
      const step = { ...stepFor(null), message_content: '営業時間: {{var.hours}}' };
      const send = () => testSendSteps(store.db, new LineClient('dummy-token'), [step as never], 'friend-1', 'account-1');
      await expect(send()).rejects.toThrow();
      expect(push).not.toHaveBeenCalled();
      store.raw.prepare("INSERT INTO common_vars(id,line_account_id,name,var_key,type,value) VALUES ('var','account-1','営業時間','hours','text','10時')").run();
      await expect(send()).resolves.toMatchObject({ ok: true, sent: 1 });
      expect(push).toHaveBeenCalledWith('U1', [{ type: 'text', text: '営業時間: 10時' }]);
    } finally { push.mockRestore(); }
  });

  it('持ち主未定では送らず、送り先の持ち主にも送らない', async () => {
    const id = await publishedTemplate('account-1', '公開版の本文');
    const result = await testSendSteps(
      store.db,
      new LineClient('dummy-token'),
      [stepFor(id) as never],
      'friend-1',
      null,
    );
    expect(result).toMatchObject({ ok: false, sent: 0 });
  });
});

/**
 * 送信先単位のデバウンス。
 *
 * 画面の送信中フラグだけでは、連打・別タブ・同時リクエストの重複実送信を
 * 止められない。送る前にサーバー側で claim を取り、窓の内側では実送信も
 * 記録もしない。
 */
describe('実DB: テスト送信の送信先デバウンス（N-057）', () => {
  let store: SqliteD1;

  beforeEach(() => {
    vi.restoreAllMocks();
    store = createTestD1();
    store.raw.prepare(
      `INSERT INTO line_accounts
         (id, channel_id, name, channel_access_token, channel_secret, is_active)
       VALUES ('account-1', 'channel-1', 'account-1', '', '', 1)`,
    ).run();
    insertFriend(store.raw, 'friend-1', { line_user_id: 'U1', line_account_id: 'account-1' });
    insertFriend(store.raw, 'friend-2', { line_user_id: 'U2', line_account_id: 'account-1' });
    vi.spyOn(LineClient.prototype, 'pushMessage').mockResolvedValue(undefined as never);
  });

  const step = {
    id: 'step-1',
    scenario_id: 'scenario-1',
    step_order: 0,
    delay_minutes: 0,
    message_type: 'text',
    message_content: 'テスト本文',
    condition_type: null,
    condition_value: null,
    next_step_on_false: null,
    offset_days: null,
    offset_minutes: null,
    delivery_time: null,
    template_id: null,
    question_json: null,
  } as never;

  const send = (friendId = 'friend-1', dedupeKey = 'scenario-1:all') =>
    testSendSteps(
      store.db,
      new LineClient('dummy-token'),
      [step],
      friendId,
      'account-1',
      undefined,
      { dedupeKey },
    );

  it('同じ送信先・同じ対象への連続送信は2回目を控える', async () => {
    const first = await send();
    expect(first).toMatchObject({ ok: true, sent: 1 });
    expect(LineClient.prototype.pushMessage).toHaveBeenCalledTimes(1);

    const second = await send();
    expect(second).toMatchObject({ ok: false, sent: 0, deduped: true });
    expect(LineClient.prototype.pushMessage).toHaveBeenCalledTimes(1);

    // 控えたぶんは記録にも残さない（scenario_test の行が増えない）。
    const logs = store.raw.prepare(
      `SELECT COUNT(*) AS n FROM messages_log WHERE source = 'scenario_test'`,
    ).get() as { n: number };
    expect(logs.n).toBe(1);
  });

  it('別の友だち・別の対象は制限しない', async () => {
    expect((await send('friend-1')).ok).toBe(true);
    expect((await send('friend-2')).ok).toBe(true);
    expect((await send('friend-1', 'scenario-1:step-1')).ok).toBe(true);
    expect(LineClient.prototype.pushMessage).toHaveBeenCalledTimes(3);
  });

  it('窓を過ぎると同じ送信先へまた送れる', async () => {
    expect((await send()).ok).toBe(true);
    store.raw.prepare(
      `UPDATE scenario_test_send_claims SET claimed_at = '2020-01-01T00:00:00.000+09:00'`,
    ).run();
    expect((await send()).ok).toBe(true);
    expect(LineClient.prototype.pushMessage).toHaveBeenCalledTimes(2);
  });

  it('dedupeKey を渡さない呼び出しは従来どおり制限しない', async () => {
    const plain = () => testSendSteps(
      store.db, new LineClient('dummy-token'), [step], 'friend-1', 'account-1',
    );
    expect((await plain()).ok).toBe(true);
    expect((await plain()).ok).toBe(true);
    expect(LineClient.prototype.pushMessage).toHaveBeenCalledTimes(2);
  });
});
