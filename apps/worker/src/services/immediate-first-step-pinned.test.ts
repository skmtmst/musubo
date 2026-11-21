import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createTestD1, insertFriend, type SqliteD1 } from '../test-utils/d1-sqlite';
import {
  createScenario,
  createScenarioStep,
  enrollFriendInScenario,
  publishScenarioVersion,
  updateScenarioStep,
  type FriendScenario,
} from '@line-crm/db';

import { pushImmediateFirstStep } from './immediate-first-step';

// cron との文面パリティ装飾だけモック（中身の同一性は既存の decoration
// テストが保証）。DB は本物で、版固定の読みを検証する。
vi.mock('./auto-track.js', () => ({
  decorateForFriendPush: vi.fn(async (_db: unknown, messageType: string, content: string) => ({
    messageType,
    content,
  })),
}));

const ctx = { defaultAccessToken: 'default-token', workerUrl: 'https://worker.example.com' };

function replyHarness() {
  const sent: Array<{ token: string; messages: unknown[] }> = [];
  const client = {
    replyMessage: vi.fn(async (replyToken: string, messages: unknown[]) => {
      sent.push({ token: replyToken, messages });
      return {};
    }),
  };
  return { sent, client };
}

async function seedScenario(db: D1Database) {
  const scenario = await createScenario(db, { name: '案内', triggerType: 'manual' });
  const step1 = await createScenarioStep(db, {
    scenarioId: scenario.id,
    stepOrder: 0,
    messageType: 'text',
    messageContent: '1通目',
  });
  await createScenarioStep(db, {
    scenarioId: scenario.id,
    stepOrder: 1,
    messageType: 'text',
    messageContent: '2通目',
  });
  return { scenario, step1 };
}

/**
 * 即時1通目の版固定の実D1テスト。
 *
 * 友だち追加・タグ・LIFF はすべて pushImmediateFirstStep に集約されるので、
 * ここで「参加時に固定した公開版だけを読む」ことを実DBで確かめる。
 * reply 経路を使うので LINE への通信は出ない。
 */
describe('pushImmediateFirstStep の版固定（実D1）', () => {
  let testDb: SqliteD1;

  beforeEach(() => {
    testDb = createTestD1();
    vi.clearAllMocks();
  });

  it('下書き編集・再公開のあとも固定版の文面を送る', async () => {
    const { scenario, step1 } = await seedScenario(testDb.db);
    insertFriend(testDb.raw, 'friend-1');
    await publishScenarioVersion(testDb.db, scenario.id, { staffId: null, idempotencyKey: 'pin-k1' });
    const enrollment = (await enrollFriendInScenario(testDb.db, 'friend-1', scenario.id))!;

    await updateScenarioStep(testDb.db, step1.id, { message_content: '書き換えた1通目' });
    await publishScenarioVersion(testDb.db, scenario.id, { staffId: null, idempotencyKey: 'pin-k2' });

    const { sent, client } = replyHarness();
    const ok = await pushImmediateFirstStep(testDb.db, 'friend-1', scenario.id, ctx, {
      enrollment: enrollment as FriendScenario,
      reply: { client, replyToken: 'rt-1' },
    });

    expect(ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent[0].messages)).toContain('1通目');
    expect(JSON.stringify(sent[0].messages)).not.toContain('書き換えた1通目');
  });

  it('初回の即時送信は共通情報が未解決なら送らない', async () => {
    const { scenario, step1 } = await seedScenario(testDb.db);
    testDb.raw.prepare("INSERT INTO line_accounts(id,name,channel_id,channel_access_token,channel_secret) VALUES('acc-1','店','ch','tok','secret')").run();
    testDb.raw.prepare("UPDATE scenarios SET line_account_id='acc-1' WHERE id=?").run(scenario.id);
    insertFriend(testDb.raw, 'friend-1', { line_account_id: 'acc-1' });
    await updateScenarioStep(testDb.db, step1.id, { message_content: '営業時間: {{var.hours}}' });
    await publishScenarioVersion(testDb.db, scenario.id, { staffId: null, idempotencyKey: 'pin-common-var' });
    const enrollment = (await enrollFriendInScenario(testDb.db, 'friend-1', scenario.id))!;
    const { sent, client } = replyHarness();
    expect(await pushImmediateFirstStep(testDb.db, 'friend-1', scenario.id, ctx, {
      enrollment: enrollment as FriendScenario, reply: { client, replyToken: 'rt-1' },
    })).toBe(false);
    expect(sent).toEqual([]);
    expect(testDb.raw.prepare('SELECT var_key,reason FROM common_var_resolution_failures').all()).toEqual([{var_key:'hours',reason:'missing'}]);
    expect(testDb.raw.prepare('SELECT status FROM friend_scenarios WHERE id=?').get(enrollment.id)).toEqual({status:'active'});
  });

  it('固定した共通情報を送り、停止後は送らず要確認にする', async () => {
    const { scenario, step1 } = await seedScenario(testDb.db);
    testDb.raw.exec(`INSERT INTO line_accounts(id,name,channel_id,channel_access_token,channel_secret) VALUES('acc-1','店','ch','tok','secret');
      INSERT INTO common_vars(id,line_account_id,name,var_key,value,version) VALUES('hours','acc-1','営業時間','hours','新',2);
      INSERT INTO common_var_versions(id,common_var_id,version_no,name,value,change_reason) VALUES('old','hours',1,'営業時間','旧','test');`);
    testDb.raw.prepare("UPDATE scenarios SET line_account_id='acc-1' WHERE id=?").run(scenario.id);
    insertFriend(testDb.raw, 'friend-1', { line_account_id: 'acc-1' });
    insertFriend(testDb.raw, 'friend-2', { line_account_id: 'acc-1' });
    await updateScenarioStep(testDb.db, step1.id, { message_content: '営業時間: {{var.hours}}' });
    testDb.raw.prepare('INSERT INTO scenario_step_common_var_pins VALUES (?,?,?)').run(step1.id, 'hours', 'old');
    await publishScenarioVersion(testDb.db, scenario.id, { staffId: null, idempotencyKey: 'fixed-hours' });
    const first = (await enrollFriendInScenario(testDb.db, 'friend-1', scenario.id))!;
    const second = (await enrollFriendInScenario(testDb.db, 'friend-2', scenario.id))!;
    const { sent, client } = replyHarness();
    expect(await pushImmediateFirstStep(testDb.db, 'friend-1', scenario.id, ctx, { enrollment: first as FriendScenario, reply: { client, replyToken: 'first' } })).toBe(true);
    expect(JSON.stringify(sent[0].messages)).toContain('営業時間: 旧');
    testDb.raw.prepare("UPDATE common_vars SET status='stopped' WHERE id='hours'").run();
    expect(await pushImmediateFirstStep(testDb.db, 'friend-2', scenario.id, ctx, { enrollment: second as FriendScenario, reply: { client, replyToken: 'second' } })).toBe(false);
    expect(sent).toHaveLength(1);
    expect(testDb.raw.prepare("SELECT reason FROM common_var_resolution_failures WHERE var_key='hours'").get()).toEqual({ reason: 'stopped' });
  });

  it('文を組み立てた後に固定元が停止したら送る直前に止める', async () => {
    const { scenario, step1 } = await seedScenario(testDb.db);
    testDb.raw.exec(`INSERT INTO line_accounts(id,name,channel_id,channel_access_token,channel_secret) VALUES('acc-1','店','ch','tok','secret');
      INSERT INTO common_vars(id,line_account_id,name,var_key,value) VALUES('hours','acc-1','営業時間','hours','新');
      INSERT INTO common_var_versions(id,common_var_id,version_no,name,value,change_reason) VALUES('old','hours',1,'営業時間','旧','test');`);
    testDb.raw.prepare("UPDATE scenarios SET line_account_id='acc-1' WHERE id=?").run(scenario.id);
    insertFriend(testDb.raw, 'friend-1', { line_account_id: 'acc-1' });
    await updateScenarioStep(testDb.db, step1.id, { message_content: '{{var.hours}}' });
    testDb.raw.prepare('INSERT INTO scenario_step_common_var_pins VALUES(?,?,?)').run(step1.id, 'hours', 'old');
    await publishScenarioVersion(testDb.db, scenario.id, { staffId: null, idempotencyKey: 'before-send' });
    const enrollment = (await enrollFriendInScenario(testDb.db, 'friend-1', scenario.id))!;
    const prepare = testDb.db.prepare.bind(testDb.db);
    let pinReads = 0;
    const spy = vi.spyOn(testDb.db, 'prepare').mockImplementation((query) => {
      if (query.includes('FROM scenario_version_common_var_pins p') && ++pinReads === 2) testDb.raw.prepare("UPDATE common_vars SET status='stopped' WHERE id='hours'").run();
      return prepare(query);
    });
    try {
      const { sent, client } = replyHarness();
      expect(await pushImmediateFirstStep(testDb.db, 'friend-1', scenario.id, ctx, { enrollment: enrollment as FriendScenario, reply: { client, replyToken: 'reply' } })).toBe(false);
      expect(sent).toEqual([]);
      expect(testDb.raw.prepare('SELECT status,pause_reason FROM friend_scenarios WHERE id=?').get(enrollment.id)).toEqual({ status:'paused', pause_reason:'common_var_unavailable' });
    } finally { spy.mockRestore(); }
  });

  it('公開後の template 編集は固定版へ混入しない', async () => {
    const scenario = await createScenario(testDb.db, { name: '案内', triggerType: 'manual' });
    // template の解決は「公開版があり、持ち主が両方はっきりしていて一致する」
    // ときだけ通る。その条件を満たす形で置く。
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
         VALUES ('tpl-9', '案内', 'text', '公開時の文面', 1, 'acc-1')`,
      )
      .run();
    await createScenarioStep(testDb.db, {
      scenarioId: scenario.id,
      stepOrder: 0,
      messageType: 'text',
      messageContent: '控え',
      templateId: 'tpl-9',
    });
    insertFriend(testDb.raw, 'friend-1');
    await publishScenarioVersion(testDb.db, scenario.id, { staffId: null, idempotencyKey: 'pin-t1' });
    const enrollment = (await enrollFriendInScenario(testDb.db, 'friend-1', scenario.id))!;

    testDb.raw.prepare(`UPDATE templates SET message_content = '書き換えた文面' WHERE id = 'tpl-9'`).run();

    const { sent, client } = replyHarness();
    const ok = await pushImmediateFirstStep(testDb.db, 'friend-1', scenario.id, ctx, {
      enrollment: enrollment as FriendScenario,
      reply: { client, replyToken: 'rt-1' },
    });

    expect(ok).toBe(true);
    expect(JSON.stringify(sent[0].messages)).toContain('公開時の文面');
    expect(JSON.stringify(sent[0].messages)).not.toContain('書き換えた文面');
  });

  it('下書きの通を消しても固定版を送り、ログを壊さない', async () => {
    const { scenario, step1 } = await seedScenario(testDb.db);
    insertFriend(testDb.raw, 'friend-1');
    await publishScenarioVersion(testDb.db, scenario.id, { staffId: null, idempotencyKey: 'pin-d1' });
    const enrollment = (await enrollFriendInScenario(testDb.db, 'friend-1', scenario.id))!;

    testDb.raw.prepare(`DELETE FROM scenario_steps WHERE id = ?`).run(step1.id);

    const { sent, client } = replyHarness();
    const ok = await pushImmediateFirstStep(testDb.db, 'friend-1', scenario.id, ctx, {
      enrollment: enrollment as FriendScenario,
      reply: { client, replyToken: 'rt-1' },
    });

    expect(ok).toBe(true);
    expect(JSON.stringify(sent[0].messages)).toContain('1通目');
    const log = testDb.raw
      .prepare(`SELECT scenario_step_id AS live, scenario_version_step_id AS pinned FROM messages_log WHERE friend_id = 'friend-1'`)
      .get() as { live: string | null; pinned: string | null };
    // live の通は消えたので NULL、版所有の通IDは残る（二重送信防止が効く）。
    expect(log.live).toBeNull();
    expect(log.pinned).toBe(`${enrollment.published_version_id}:0`);
  });

  it('版が欠損しているときは送らない', async () => {
    const { scenario } = await seedScenario(testDb.db);
    insertFriend(testDb.raw, 'friend-1');
    await publishScenarioVersion(testDb.db, scenario.id, { staffId: null, idempotencyKey: 'pin-m1' });
    const enrollment = (await enrollFriendInScenario(testDb.db, 'friend-1', scenario.id))!;

    // 版の行だけ壊す（実運用では起こらないが、起きても送らない契約）。
    testDb.raw.exec('DROP TRIGGER trg_scenario_versions_immutable_delete');
    testDb.raw.prepare(`DELETE FROM scenario_versions WHERE id = ?`).run(enrollment.published_version_id);

    const { sent, client } = replyHarness();
    const ok = await pushImmediateFirstStep(testDb.db, 'friend-1', scenario.id, ctx, {
      enrollment: enrollment as FriendScenario,
      reply: { client, replyToken: 'rt-1' },
    });

    expect(ok).toBe(false);
    expect(sent).toHaveLength(0);
  });
});
