import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createTestD1, insertFriend, type SqliteD1 } from '../test-utils/d1-sqlite';
import { useSqliteClock } from '../test-utils/sqlite-clock.js';
import {
  createScenario,
  createScenarioStep,
  enrollFriendInScenario,
  publishScenarioVersion,
  updateScenarioStep,
} from '@line-crm/db';
import { processStepDeliveries } from './step-delivery';
import { parseQuestionPostback } from '../features/scenarios/scenario-question';

// 文面パリティ装飾だけモック（中身の同一性は既存の decoration テストが
// 保証）。LINE 送信は偽クライアントで受け、DB は本物を使う。
vi.mock('./auto-track.js', () => ({
  decorateForFriendPush: vi.fn(async (_db: unknown, messageType: string, content: string) => ({
    messageType,
    content,
  })),
}));

/*
 * シナリオに持ち主アカウントがあるときは、配信がそのアカウントの資格情報で
 * 新しい LineClient を作る（渡した偽クライアントを通らない）。外へ通信させ
 * ないよう、そちらの送信も受け取れるようにする。
 */
const accountSends = vi.hoisted(() => [] as Array<{ target: string; messages: unknown[] }>);
vi.mock('@line-crm/line-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@line-crm/line-sdk')>();
  return {
    ...actual,
    LineClient: class {
      async pushMessage(target: string, messages: unknown[]) {
        accountSends.push({ target, messages });
        return {};
      }
    },
  };
});

function pushHarness() {
  const sent: Array<{ target: string; messages: unknown[] }> = [];
  const client = {
    pushMessage: vi.fn(async (target: string, messages: unknown[]) => {
      sent.push({ target, messages });
      return {};
    }),
  };
  return { sent, client };
}

/**
 * cron 配信の版固定の実D1テスト。
 *
 * 既存購読・同時公開・部分失敗・通削除・欠損参照・template 編集を、
 * 本物の SQLite（bootstrap 適用）で確かめる。
 */
describe('processStepDeliveries の版固定（実D1）', () => {
  let testDb: SqliteD1;

  beforeEach(() => {
    testDb = createTestD1();
    accountSends.length = 0;
    vi.clearAllMocks();
  });

  async function seedPublished() {
    const scenario = await createScenario(testDb.db, { name: '案内', triggerType: 'manual' });
    const step1 = await createScenarioStep(testDb.db, {
      scenarioId: scenario.id,
      stepOrder: 0,
      messageType: 'text',
      messageContent: '1通目',
    });
    await createScenarioStep(testDb.db, {
      scenarioId: scenario.id,
      stepOrder: 1,
      messageType: 'text',
      messageContent: '2通目',
    });
    insertFriend(testDb.raw, 'friend-1', { line_user_id: 'U-friend-1' });
    await publishScenarioVersion(testDb.db, scenario.id, { staffId: null, idempotencyKey: 'cron-k1' });
    const enrollment = (await enrollFriendInScenario(testDb.db, 'friend-1', scenario.id))!;
    return { scenario, step1, enrollment };
  }

  it('シナリオの配信は未解決の共通情報を送らない', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-17T00:00:00Z'));
    useSqliteClock(testDb.raw, () => new Date());
    try {
      testDb.raw.prepare("INSERT INTO line_accounts(id,name,channel_id,channel_access_token,channel_secret) VALUES('account','店','ch','token','secret')").run();
      const scenario = await createScenario(testDb.db, { name: '案内', triggerType: 'manual' });
      testDb.raw.prepare("UPDATE scenarios SET line_account_id='account' WHERE id=?").run(scenario.id);
      await createScenarioStep(testDb.db, { scenarioId: scenario.id, stepOrder: 0, messageType: 'text', messageContent: '営業時間: {{var.hours}}' });
      insertFriend(testDb.raw, 'friend-1', { line_user_id: 'U-friend-1', line_account_id: 'account' });
      await publishScenarioVersion(testDb.db, scenario.id, { staffId: null, idempotencyKey: 'cron-var' });
      const enrollment = (await enrollFriendInScenario(testDb.db, 'friend-1', scenario.id))!;
      const { sent, client } = pushHarness();
      await processStepDeliveries(testDb.db, client as never);
      expect(sent).toEqual([]);
      expect(accountSends).toEqual([]);
      expect(testDb.raw.prepare('SELECT status FROM friend_scenarios WHERE id=?').get(enrollment.id)).toEqual({status:'delivering'});
      expect(testDb.raw.prepare('SELECT var_key,reason FROM common_var_resolution_failures').all()).toEqual([{var_key:'hours',reason:'missing'}]);
    } finally { vi.useRealTimers(); }
  });

  it('配信停止の人には送らず、購読を一時停止する',async()=>{
    const {enrollment}=await seedPublished();
    testDb.raw.exec("INSERT INTO line_accounts(id,name,channel_id,channel_secret,channel_access_token) VALUES('consent-account','試験','consent-channel','secret','token');UPDATE friends SET line_account_id='consent-account' WHERE id='friend-1';INSERT INTO friend_delivery_consents(line_account_id,friend_id,purpose,state,reason,source) VALUES('consent-account','friend-1','marketing','revoked','停止希望','manual')");
    const {sent,client}=pushHarness();await processStepDeliveries(testDb.db,client as never);
    expect(sent).toHaveLength(0);expect(accountSends).toHaveLength(0);
    expect(testDb.raw.prepare('SELECT status FROM friend_scenarios WHERE id=?').get(enrollment.id)).toEqual({status:'paused'});
  });

  it('固定した共通情報が停止したら送信せず要確認にする', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-17T00:00:00Z'));
    useSqliteClock(testDb.raw, () => new Date());
    try {
      testDb.raw.exec(`INSERT INTO line_accounts(id,name,channel_id,channel_access_token,channel_secret) VALUES('account','店','ch','token','secret');
        INSERT INTO common_vars(id,line_account_id,name,var_key,value) VALUES('hours','account','営業時間','hours','新');
        INSERT INTO common_var_versions(id,common_var_id,version_no,name,value,change_reason) VALUES('hours-old','hours',1,'営業時間','旧','test');`);
      const scenario = await createScenario(testDb.db, { name: '案内', triggerType: 'manual' });
      testDb.raw.prepare("UPDATE scenarios SET line_account_id='account' WHERE id=?").run(scenario.id);
      const step = await createScenarioStep(testDb.db, { scenarioId: scenario.id, stepOrder: 0, messageType: 'text', messageContent: '{{var.hours}}' });
      testDb.raw.prepare('INSERT INTO scenario_step_common_var_pins VALUES(?,?,?)').run(step.id, 'hours', 'hours-old');
      insertFriend(testDb.raw, 'friend-1', { line_user_id: 'U-friend-1', line_account_id: 'account' });
      await publishScenarioVersion(testDb.db, scenario.id, { staffId: null, idempotencyKey: 'cron-pinned-var' });
      const enrollment = (await enrollFriendInScenario(testDb.db, 'friend-1', scenario.id))!;
      testDb.raw.prepare("UPDATE common_vars SET status='stopped' WHERE id='hours'").run();
      const { sent, client } = pushHarness();
      await processStepDeliveries(testDb.db, client as never);
      expect(sent).toHaveLength(0);
      expect(accountSends).toHaveLength(0);
      expect(testDb.raw.prepare('SELECT status,pause_reason FROM friend_scenarios WHERE id=?').get(enrollment.id)).toEqual({ status: 'paused', pause_reason: 'common_var_unavailable' });
    } finally { vi.useRealTimers(); }
  });

  it('下書き編集のあとも固定版の文面を送る', async () => {
    const { scenario, step1 } = await seedPublished();
    await updateScenarioStep(testDb.db, step1.id, { message_content: '書き換えた1通目' });

    const { sent, client } = pushHarness();
    await processStepDeliveries(testDb.db, client as never);

    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent[0].messages)).toContain('1通目');
    expect(JSON.stringify(sent[0].messages)).not.toContain('書き換えた1通目');
    void scenario;
  });

  it('下書きの通を消しても固定版を送り、ログと進行を壊さない', async () => {
    const { step1, enrollment } = await seedPublished();
    testDb.raw.prepare(`DELETE FROM scenario_steps WHERE id = ?`).run(step1.id);

    const { sent, client } = pushHarness();
    await processStepDeliveries(testDb.db, client as never);

    // 固定版の1通目が送られる。
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent[0].messages)).toContain('1通目');
    // ログは残り、live の通参照は NULL、版所有の通IDで二重送信防止が効く。
    const log = testDb.raw
      .prepare(
        `SELECT scenario_step_id AS live, scenario_version_step_id AS pinned, source FROM messages_log WHERE friend_id = 'friend-1'`,
      )
      .get() as { live: string | null; pinned: string | null; source: string };
    expect(log.source).toBe('scenario');
    expect(log.live).toBeNull();
    expect(log.pinned).toBe(`${enrollment.published_version_id}:0`);
    // 購読は次へ進んでいる（cron が再送しない）。
    const row = testDb.raw
      .prepare(`SELECT current_step_order AS o, status FROM friend_scenarios WHERE id = ?`)
      .get(enrollment.id) as { o: number; status: string };
    expect(row.o).toBe(0);
    expect(row.status).toBe('active');
  });

  it('版が欠損しているときは送らず一時停止する', async () => {
    const { enrollment } = await seedPublished();
    testDb.raw.exec('DROP TRIGGER trg_scenario_versions_immutable_delete');
    testDb.raw.prepare(`DELETE FROM scenario_versions WHERE id = ?`).run(enrollment.published_version_id);

    const { sent, client } = pushHarness();
    await processStepDeliveries(testDb.db, client as never);

    expect(sent).toHaveLength(0);
    const row = testDb.raw
      .prepare(`SELECT status FROM friend_scenarios WHERE id = ?`)
      .get(enrollment.id) as { status: string };
    expect(row.status).toBe('paused');
  });

  it('公開後の template 編集は固定版へ混入しない', async () => {
    const scenario = await createScenario(testDb.db, { name: '案内', triggerType: 'manual' });
    // template の解決は「公開版があり、持ち主が両方はっきりしていて一致する」
    // ときだけ通る。その条件を満たす形で置く。
    //
    // シナリオ側の持ち主は friends 経由で決まる（scenarios.line_account_id を
    // 直に入れると、cron が実アカウントの資格情報で送りにいってしまい、
    // この検査（文面が固定されるか）と関係ないところで落ちる）。
    testDb.raw
      .prepare(
        `INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
         VALUES ('acc-1', 'ch-1', '店舗1', 'tok-1', 'sec-1')`,
      )
      .run();
    testDb.raw
      .prepare(`UPDATE scenarios SET line_account_id = 'acc-1' WHERE id = ?`)
      .run(scenario.id);
    testDb.raw
      .prepare(
        `INSERT INTO templates (id, name, message_type, message_content, published_version, line_account_id)
         VALUES ('tpl-7', '案内', 'text', '公開時の文面', 1, 'acc-1')`,
      )
      .run();
    await createScenarioStep(testDb.db, {
      scenarioId: scenario.id,
      stepOrder: 0,
      messageType: 'text',
      messageContent: '控え',
      templateId: 'tpl-7',
    });
    insertFriend(testDb.raw, 'friend-1', { line_user_id: 'U-friend-1' });
    await publishScenarioVersion(testDb.db, scenario.id, { staffId: null, idempotencyKey: 'cron-t1' });
    await enrollFriendInScenario(testDb.db, 'friend-1', scenario.id);

    testDb.raw.prepare(`UPDATE templates SET message_content = '書き換えた文面' WHERE id = 'tpl-7'`).run();

    const { client } = pushHarness();
    await processStepDeliveries(testDb.db, client as never);

    // 持ち主アカウントの資格情報で送るので、受け口はこちら。
    expect(accountSends).toHaveLength(1);
    expect(JSON.stringify(accountSends[0].messages)).toContain('公開時の文面');
    expect(JSON.stringify(accountSends[0].messages)).not.toContain('書き換えた文面');
  });

  /*
   * 質問つきの通を1件だけ持つシナリオ。押し口の形だけを見たいので、
   * 2通目は置かない。
   */
  async function seedPublishedQuestion() {
    const scenario = await createScenario(testDb.db, { name: '質問', triggerType: 'manual' });
    const step1 = await createScenarioStep(testDb.db, {
      scenarioId: scenario.id,
      stepOrder: 0,
      messageType: 'text',
      messageContent: '質問の控え',
    });
    testDb.raw
      .prepare(`UPDATE scenario_steps SET question_json = ? WHERE id = ?`)
      .run(
        JSON.stringify({
          text: 'どちらにしますか',
          tapMode: 'single',
          choices: [{ label: 'はい', behavior: 'none', reply: 'ありがとうございます' }],
        }),
        step1.id,
      );
    insertFriend(testDb.raw, 'friend-1', { line_user_id: 'U-friend-1' });
    await publishScenarioVersion(testDb.db, scenario.id, { staffId: null, idempotencyKey: 'cron-q1' });
    const enrollment = (await enrollFriendInScenario(testDb.db, 'friend-1', scenario.id))!;
    return { scenario, step1, enrollment };
  }

  /** 送った質問メッセージから、ボタンが載せた postback の data を取り出す。 */
  function postbackDataOf(messages: unknown[]): string[] {
    const found: string[] = [];
    JSON.stringify(messages, (_key, value) => {
      if (
        value &&
        typeof value === 'object' &&
        (value as { type?: unknown }).type === 'postback' &&
        typeof (value as { data?: unknown }).data === 'string'
      ) {
        found.push((value as { data: string }).data);
      }
      return value as unknown;
    });
    return found;
  }

  /*
   * 下書き削除後も質問押下が反応するよう、固定版の通 ID を押し口へ載せ、コロンを含む ID を受信側が受け付けることを確かめる。
   */
  it('下書きの通を消しても、送る質問の押し口は受信側が読める形になっている', async () => {
    const { step1, enrollment } = await seedPublishedQuestion();
    testDb.raw.prepare(`DELETE FROM scenario_steps WHERE id = ?`).run(step1.id);

    const { sent, client } = pushHarness();
    await processStepDeliveries(testDb.db, client as never);

    expect(sent).toHaveLength(1);
    const datas = postbackDataOf(sent[0].messages);
    expect(datas).toHaveLength(1);

    // ここが要点。受信側（webhook）が使うのと同じ関数で読み戻せること。
    const parsed = parseQuestionPostback(datas[0]);
    expect(parsed).not.toBeNull();
    expect(parsed).toEqual({
      kind: 'version',
      stepId: `${enrollment.published_version_id}:0`,
      choiceIndex: 0,
    });
  });

  it('下書きの通が残っているあいだは、押し口は従来どおり下書きの通IDを載せる', async () => {
    const { step1 } = await seedPublishedQuestion();

    const { sent, client } = pushHarness();
    await processStepDeliveries(testDb.db, client as never);

    const datas = postbackDataOf(sent[0].messages);
    expect(parseQuestionPostback(datas[0])).toEqual({
      kind: 'live',
      stepId: step1.id,
      choiceIndex: 0,
    });
  });
});
