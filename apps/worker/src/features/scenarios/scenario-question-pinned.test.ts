import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createTestD1, insertFriend, type SqliteD1 } from '../../test-utils/d1-sqlite'
import { useSqliteClock } from '../../test-utils/sqlite-clock.js'
import {
  createScenario,
  createScenarioStep,
  deleteScenarioStep,
  enrollFriendInScenario,
  getScenarioPublishedVersion,
  publishScenarioVersion,
  updateScenarioStep,
  jstNow,
} from '@line-crm/db'
import { buildQuestionMessages, parseQuestionPostback } from './scenario-question'
import { handleQuestionAnswer, resumeQuestionAnswer } from './scenario-question-answer'

/**
 * 下書き通の削除後も質問へ回答できるよう、版所有の通 ID を解析し、購読が固定した版の返信・アクション・選択肢を実行する。
 * 別の LINE 公式アカウントのタグ・遷移先はサーバーで拒む。実 SQLite で質問押下の経路を検証する。
 */
describe('質問の押下を版へ結びつける（実D1）', () => {
  let testDb: SqliteD1

  beforeEach(() => {
    testDb = createTestD1()
    vi.clearAllMocks()
  })

  function replyHarness() {
    const replied: string[] = []
    const pushed: string[] = []
    const client = {
      replyMessage: vi.fn(async (_token: string, messages: Array<{ text?: string }>) => {
        for (const m of messages) replied.push(m.text ?? '')
        return {}
      }),
      pushMessage: vi.fn(async (_target: string, messages: Array<{ text?: string }>) => {
        for (const m of messages) pushed.push(m.text ?? '')
        return {}
      }),
    }
    return { replied, pushed, client }
  }

  function question(reply: string, tagIds: string[] = []): string {
    return JSON.stringify({
      text: 'どちらにしますか',
      tapMode: 'single',
      choices: [{ label: 'はい', behavior: 'none', reply, addTagIds: tagIds }],
    })
  }

  function insertAccount(id: string): void {
    testDb.raw
      .prepare(
        `INSERT OR IGNORE INTO line_accounts
           (id, channel_id, name, channel_access_token, channel_secret)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, `channel-${id}`, id, `token-${id}`, `secret-${id}`)
  }

  function insertTag(id: string, accountId: string | null): void {
    testDb.raw
      .prepare(
        `INSERT INTO tags (id, name, created_at, line_account_id) VALUES (?, ?, ?, ?)`,
      )
      .run(id, `タグ-${id}`, jstNow(), accountId)
  }

  function tagsOf(friendId: string): string[] {
    return (
      testDb.raw
        .prepare(`SELECT tag_id FROM friend_tags WHERE friend_id = ?`)
        .all(friendId) as Array<{ tag_id: string }>
    ).map((r) => r.tag_id)
  }

  async function seedPublishedQuestion(options?: { accountId?: string | null; reply?: string }) {
    const scenario = await createScenario(testDb.db, { name: '案内', triggerType: 'manual' })
    if (options?.accountId !== undefined) {
      insertAccount(options.accountId!)
      testDb.raw
        .prepare(`UPDATE scenarios SET line_account_id = ? WHERE id = ?`)
        .run(options.accountId, scenario.id)
    }
    const step = await createScenarioStep(testDb.db, {
      scenarioId: scenario.id,
      stepOrder: 0,
      messageType: 'text',
      messageContent: '質問',
    })
    testDb.raw
      .prepare(`UPDATE scenario_steps SET question_json = ? WHERE id = ?`)
      .run(question(options?.reply ?? '公開時の返信'), step.id)

    insertFriend(testDb.raw, 'friend-1', { line_user_id: 'U-friend-1', ...(options?.accountId ? {line_account_id:options.accountId} : {}) })
    await publishScenarioVersion(testDb.db, scenario.id, {
      staffId: null,
      idempotencyKey: 'q-k1',
    })
    const enrollment = (await enrollFriendInScenario(testDb.db, 'friend-1', scenario.id))!
    const version = (await getScenarioPublishedVersion(testDb.db, scenario.id))!
    return { scenario, step, enrollment, version, versionStepId: `${version.id}:0` }
  }

  const friend = { id: 'friend-1', line_user_id: 'U-friend-1' }

  // ---------------------------------------------------------------
  // 1. 押し口の解析
  // ---------------------------------------------------------------

  it('版所有の通ID（コロンを含む）を載せた押し口を読み戻せる', () => {
    const versionStepId = '3a0e2b6c-1111-4222-8333-444455556666:12'
    const messages = buildQuestionMessages(
      { text: 'Q', tapMode: 'single', choices: [{ label: 'はい', behavior: 'none' }] },
      { kind: 'version', stepId: versionStepId },
    )
    const data = JSON.stringify(messages)
    const match = data.match(/"data":"([^"]+)"/)
    expect(match).not.toBeNull()

    const parsed = parseQuestionPostback(match![1]!)
    expect(parsed).toEqual({ kind: 'version', stepId: versionStepId, choiceIndex: 0 })
    // 300文字の上限に収まる。
    expect(match![1]!.length).toBeLessThan(300)
  })

  it('壊れた押し口は受け取らない', () => {
    expect(parseQuestionPostback('sq:2::0')).toBeNull()
    expect(parseQuestionPostback('sq:2:no-colon:0')).toBeNull()
    expect(parseQuestionPostback('sq:with:colon:0')).toBeNull()
    expect(parseQuestionPostback('sq:step:x')).toBeNull()
    expect(parseQuestionPostback('other:step:0')).toBeNull()
  })

  // ---------------------------------------------------------------
  // 2. 版の写しから実行する
  // ---------------------------------------------------------------

  it('質問の返信は未解決の共通情報を送らず、登録後は値を入れる', async () => {
    vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-11-18T01:00:00Z'));useSqliteClock(testDb.raw,()=>new Date());
    try {
      const {scenario,versionStepId}=await seedPublishedQuestion({accountId:'account',reply:'営業時間: {{var.hours}}'});
      const {replied,client}=replyHarness();
      const answer=(friendId:string)=>handleQuestionAnswer(testDb.db,client as never,{id:friendId,line_user_id:'U-'+friendId},
        {kind:'version',stepId:versionStepId,choiceIndex:0},'reply-token');
      await answer('friend-1');
      expect(replied).toEqual([]);
      expect(testDb.raw.prepare('SELECT var_key,reason FROM common_var_resolution_failures').all()).toEqual([{var_key:'hours',reason:'missing'}]);
      testDb.raw.prepare("INSERT INTO common_vars(id,line_account_id,name,var_key,type,value) VALUES('hours','account','営業時間','hours','text','10時')").run();
      insertFriend(testDb.raw,'friend-2',{line_user_id:'U-friend-2',line_account_id:'account'});
      await enrollFriendInScenario(testDb.db,'friend-2',scenario.id);
      await answer('friend-2');
      expect(replied).toEqual(['営業時間: 10時']);
    } finally {vi.useRealTimers()}
  })

  it('固定した値が停止中なら返信を送らず、未送信を確認して再開したときだけ送る', async () => {
    const { scenario, step } = await seedPublishedQuestion({ accountId: 'account', reply: '営業時間: {{var.hours}}' })
    testDb.raw.exec(`INSERT INTO common_vars(id,line_account_id,name,var_key,value,status) VALUES('hours','account','営業時間','hours','新','stopped');
      INSERT INTO common_var_versions(id,common_var_id,version_no,name,value,change_reason) VALUES('hours-old','hours',1,'営業時間','旧','test');`)
    testDb.raw.prepare('INSERT INTO scenario_step_common_var_pins VALUES(?,?,?)').run(step.id,'hours','hours-old')
    const version = await publishScenarioVersion(testDb.db, scenario.id, { staffId: null, idempotencyKey: 'question-pinned' })
    const { replied, pushed, client } = replyHarness()
    await handleQuestionAnswer(testDb.db, client as never, friend, {kind:'version',stepId:`${version.id}:0`,choiceIndex:0}, 'reply-token')
    expect(replied).toEqual([])
    const root = testDb.raw.prepare("SELECT subject_id FROM workflow_steps WHERE process_kind='question_answer' AND step_key='__run'").get() as {subject_id:string}
    expect(testDb.raw.prepare("SELECT status FROM workflow_steps WHERE subject_id=? AND step_key='reply_waiting_common_var'").get(root.subject_id)).toEqual({status:'succeeded'})
    testDb.raw.prepare("UPDATE common_vars SET status='active' WHERE id='hours'").run()
    await resumeQuestionAnswer(testDb.db, {scopeId:'line:account',executionId:root.subject_id,actorId:'owner',reason:'共通情報を確認',lineClient:client as never})
    expect(pushed).toEqual(['営業時間: 旧'])
  })

  it('下書きの通を消してもボタンが効く（版の写しから答える）', async () => {
    const { step, versionStepId } = await seedPublishedQuestion()
    await deleteScenarioStep(testDb.db, step.id)

    const { replied, client } = replyHarness()
    const result = await handleQuestionAnswer(
      testDb.db,
      client as never,
      friend,
      { kind: 'version', stepId: versionStepId, choiceIndex: 0 },
      'reply-token',
    )

    expect(result.handled).toBe(true)
    expect(replied).toEqual(['公開時の返信'])
  })

  it('live の通が残っていても、公開後に直した返信は旧版の購読へ混ざらない', async () => {
    const { step, versionStepId } = await seedPublishedQuestion()
    // 公開後に下書きだけ直す（まだ公開していない）。
    await updateScenarioStep(testDb.db, step.id, { question_json: question('直したあとの返信') })

    const { replied, client } = replyHarness()
    await handleQuestionAnswer(
      testDb.db,
      client as never,
      friend,
      { kind: 'version', stepId: versionStepId, choiceIndex: 0 },
      'reply-token',
    )

    expect(replied).toEqual(['公開時の返信'])
  })

  it('旧形の押し口（下書き通ID）でも、その人が固定している版の写しで答える', async () => {
    const { step } = await seedPublishedQuestion()
    await updateScenarioStep(testDb.db, step.id, { question_json: question('直したあとの返信') })

    const { replied, client } = replyHarness()
    const result = await handleQuestionAnswer(
      testDb.db,
      client as never,
      friend,
      { kind: 'live', stepId: step.id, choiceIndex: 0 },
      'reply-token',
    )

    expect(result.handled).toBe(true)
    expect(replied).toEqual(['公開時の返信'])
  })

  it('2度目の押下は版へ移したあとも2度目のまま数える', async () => {
    const { step, versionStepId } = await seedPublishedQuestion()

    const first = replyHarness()
    await handleQuestionAnswer(
      testDb.db,
      first.client as never,
      friend,
      { kind: 'live', stepId: step.id, choiceIndex: 0 },
      'token-1',
    )
    expect(first.replied).toEqual(['公開時の返信'])

    // 同じ通を、版所有の通IDで押し直す。1度目には戻さない。
    const second = replyHarness()
    const result = await handleQuestionAnswer(
      testDb.db,
      second.client as never,
      friend,
      { kind: 'version', stepId: versionStepId, choiceIndex: 0 },
      'token-2',
    )
    expect(result.repeat).toBe(true)
    expect(second.replied).toEqual(['すでに押されています！'])
  })

  // ---------------------------------------------------------------
  // 3. アクションを版の写しから実行する
  // ---------------------------------------------------------------

  async function addChoiceAction(
    scenarioId: string,
    stepId: string,
    tagId: string,
    options?: { repeatOnRefire?: number; id?: string },
  ): Promise<string> {
    const id = options?.id ?? crypto.randomUUID()
    testDb.raw
      .prepare(
        `INSERT INTO scenario_actions
           (id, scenario_id, hook, step_id, choice_index, sort_order, action_type, config_json, repeat_on_refire, created_at)
         VALUES (?, ?, 'choice_selected', ?, 0, 0, 'tag', ?, ?, ?)`,
      )
      .run(
        id,
        scenarioId,
        stepId,
        JSON.stringify({ op: 'add', tagIds: [tagId] }),
        options?.repeatOnRefire ?? 1,
        jstNow(),
      )
    return id
  }

  it('公開後に足したアクションは旧版の購読で動かない', async () => {
    const { scenario, step, versionStepId } = await seedPublishedQuestion()
    insertTag('tag-after', null)
    // 公開したあとに live へアクションを足す。まだ公開していない。
    await addChoiceAction(scenario.id, step.id, 'tag-after')

    const { client } = replyHarness()
    await handleQuestionAnswer(
      testDb.db,
      client as never,
      friend,
      { kind: 'version', stepId: versionStepId, choiceIndex: 0 },
      'reply-token',
    )

    expect(tagsOf('friend-1')).toEqual([])
  })

  it('公開時にあったアクションは、live から消えたあとも版の写しで動く', async () => {
    const scenario = await createScenario(testDb.db, { name: '案内', triggerType: 'manual' })
    const step = await createScenarioStep(testDb.db, {
      scenarioId: scenario.id,
      stepOrder: 0,
      messageType: 'text',
      messageContent: '質問',
    })
    testDb.raw
      .prepare(`UPDATE scenario_steps SET question_json = ? WHERE id = ?`)
      .run(question('公開時の返信'), step.id)
    insertTag('tag-pinned', null)
    const actionId = await addChoiceAction(scenario.id, step.id, 'tag-pinned')

    insertFriend(testDb.raw, 'friend-1', { line_user_id: 'U-friend-1' })
    await publishScenarioVersion(testDb.db, scenario.id, { staffId: null, idempotencyKey: 'q-k2' })
    await enrollFriendInScenario(testDb.db, 'friend-1', scenario.id)
    const version = (await getScenarioPublishedVersion(testDb.db, scenario.id))!

    // 下書きからアクションを消す。旧版の購読にはまだ効いているべき。
    testDb.raw.prepare(`DELETE FROM scenario_actions WHERE id = ?`).run(actionId)

    const { client } = replyHarness()
    await handleQuestionAnswer(
      testDb.db,
      client as never,
      friend,
      { kind: 'version', stepId: `${version.id}:0`, choiceIndex: 0 },
      'reply-token',
    )

    expect(tagsOf('friend-1')).toEqual(['tag-pinned'])
    // 「1回だけ」ではないので台帳は増えない。
    expect(
      (
        testDb.raw
          .prepare(`SELECT COUNT(*) AS n FROM scenario_pinned_action_fires`)
          .get() as { n: number }
      ).n,
    ).toBe(0)
  })

  it('「1回だけ」のアクションは、版が増えても1回のまま', async () => {
    const scenario = await createScenario(testDb.db, { name: '案内', triggerType: 'manual' })
    const step = await createScenarioStep(testDb.db, {
      scenarioId: scenario.id,
      stepOrder: 0,
      messageType: 'text',
      messageContent: '質問',
    })
    testDb.raw
      .prepare(`UPDATE scenario_steps SET question_json = ? WHERE id = ?`)
      .run(question('公開時の返信'), step.id)
    insertTag('tag-once', null)
    await addChoiceAction(scenario.id, step.id, 'tag-once', { repeatOnRefire: 0, id: 'act-once' })

    insertFriend(testDb.raw, 'friend-1', { line_user_id: 'U-friend-1' })
    const v1 = await publishScenarioVersion(testDb.db, scenario.id, {
      staffId: null,
      idempotencyKey: 'q-once-1',
    })
    await enrollFriendInScenario(testDb.db, 'friend-1', scenario.id)

    const first = replyHarness()
    await handleQuestionAnswer(
      testDb.db,
      first.client as never,
      friend,
      { kind: 'version', stepId: `${v1.id}:0`, choiceIndex: 0 },
      'token-1',
    )
    expect(tagsOf('friend-1')).toEqual(['tag-once'])
    testDb.raw.prepare(`DELETE FROM friend_tags WHERE friend_id = 'friend-1'`).run()

    // 文面を直して公開し直す。版は増えるが、「1回だけ」の鍵は公開時点の
    // live のアクションIDなので、同じ人には2度目は動かない。
    await updateScenarioStep(testDb.db, step.id, { message_content: '直した質問' })
    const v2 = await publishScenarioVersion(testDb.db, scenario.id, {
      staffId: null,
      idempotencyKey: 'q-once-2',
    })
    expect(v2.id).not.toBe(v1.id)

    const second = replyHarness()
    await handleQuestionAnswer(
      testDb.db,
      second.client as never,
      friend,
      { kind: 'version', stepId: `${v2.id}:0`, choiceIndex: 1 },
      'token-2',
    )
    // 選択肢1は無いので何も起きない。選択肢0で押し直しても2度目扱い。
    const third = replyHarness()
    await handleQuestionAnswer(
      testDb.db,
      third.client as never,
      friend,
      { kind: 'version', stepId: `${v2.id}:0`, choiceIndex: 0 },
      'token-3',
    )
    expect(tagsOf('friend-1')).toEqual([])
  })

  // ---------------------------------------------------------------
  // 4. アカウント境界
  // ---------------------------------------------------------------

  it('別アカウントのタグは選択肢からでも付けない', async () => {
    const scenario = await createScenario(testDb.db, { name: '案内', triggerType: 'manual' })
    for (const acc of ['acc-a', 'acc-b']) insertAccount(acc)
    testDb.raw.prepare(`UPDATE scenarios SET line_account_id = 'acc-a' WHERE id = ?`).run(scenario.id)
    const step = await createScenarioStep(testDb.db, {
      scenarioId: scenario.id,
      stepOrder: 0,
      messageType: 'text',
      messageContent: '質問',
    })
    insertTag('tag-a', 'acc-a')
    insertTag('tag-b', 'acc-b')
    insertTag('tag-common', null)
    testDb.raw
      .prepare(`UPDATE scenario_steps SET question_json = ? WHERE id = ?`)
      .run(question('返信', ['tag-a', 'tag-b', 'tag-common']), step.id)

    insertFriend(testDb.raw, 'friend-1', { line_user_id: 'U-friend-1' })
    const version = await publishScenarioVersion(testDb.db, scenario.id, {
      staffId: null,
      idempotencyKey: 'q-acc-1',
    })
    await enrollFriendInScenario(testDb.db, 'friend-1', scenario.id)

    const { client } = replyHarness()
    await handleQuestionAnswer(
      testDb.db,
      client as never,
      friend,
      { kind: 'version', stepId: `${version.id}:0`, choiceIndex: 0 },
      'reply-token',
    )

    // 同じアカウントのタグと共通タグだけ付く。よそのアカウントのタグは
    // ID を直接書いても付かない。
    expect(tagsOf('friend-1').sort()).toEqual(['tag-a', 'tag-common'])
  })

  it('別アカウントの遷移先シナリオへは動かさない', async () => {
    const scenario = await createScenario(testDb.db, { name: '案内', triggerType: 'manual' })
    const other = await createScenario(testDb.db, { name: 'よそ', triggerType: 'manual' })
    for (const acc of ['acc-a', 'acc-b']) insertAccount(acc)
    testDb.raw.prepare(`UPDATE scenarios SET line_account_id = 'acc-a' WHERE id = ?`).run(scenario.id)
    testDb.raw.prepare(`UPDATE scenarios SET line_account_id = 'acc-b' WHERE id = ?`).run(other.id)
    const step = await createScenarioStep(testDb.db, {
      scenarioId: scenario.id,
      stepOrder: 0,
      messageType: 'text',
      messageContent: '質問',
    })
    testDb.raw.prepare(`UPDATE scenario_steps SET question_json = ? WHERE id = ?`).run(
      JSON.stringify({
        text: 'どちらにしますか',
        tapMode: 'single',
        choices: [
          {
            label: '移る',
            behavior: 'scenario',
            scenario: { op: 'start', scenarioId: other.id },
          },
        ],
      }),
      step.id,
    )

    insertFriend(testDb.raw, 'friend-1', { line_user_id: 'U-friend-1' })
    const version = await publishScenarioVersion(testDb.db, scenario.id, {
      staffId: null,
      idempotencyKey: 'q-acc-2',
    })
    await enrollFriendInScenario(testDb.db, 'friend-1', scenario.id)

    const { client } = replyHarness()
    await handleQuestionAnswer(
      testDb.db,
      client as never,
      friend,
      { kind: 'version', stepId: `${version.id}:0`, choiceIndex: 0 },
      'reply-token',
    )

    const enrolled = testDb.raw
      .prepare(`SELECT scenario_id FROM friend_scenarios WHERE friend_id = 'friend-1'`)
      .all() as Array<{ scenario_id: string }>
    expect(enrolled.map((r) => r.scenario_id)).toEqual([scenario.id])
  })
})
