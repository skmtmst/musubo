/*
 * 質問メッセージ（分岐）。
 *
 * 押された選択肢を取り違えると、まったく別のシナリオへ移してしまう。
 * postback の往復と、2度押しの扱いを重点的に見る。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { createTestD1, insertFriend } from '../../test-utils/d1-sqlite.js'
import {
  parseQuestion,
  buildQuestionMessages,
  buildQuestionPostbackData,
  parseQuestionPostback,
  hasAnsweredBefore,
  type ScenarioQuestion,
} from './scenario-question.js'
import { handleQuestionAnswer } from './scenario-question-answer.js'
import type { LineClient } from '@line-crm/line-sdk'

const QUESTION: ScenarioQuestion = {
  intro: '{{name}}様、確認です。',
  text: '体調はいかがですか？',
  tapMode: 'single',
  choices: [
    { label: 'よい', behavior: 'none', reply: 'ありがとうございます！', addTagIds: ['t1'] },
    { label: 'わるい', behavior: 'none', reply: 'お大事に。', addTagIds: ['t2'] },
  ],
}

describe('postback の往復', () => {
  it('組み立てた data をそのまま読み戻せる', () => {
    const data = buildQuestionPostbackData('step-abc', 3)
    expect(parseQuestionPostback(data)).toEqual({
      kind: 'live',
      stepId: 'step-abc',
      choiceIndex: 3,
    })
  })

  it('関係のない postback は拾わない', () => {
    expect(parseQuestionPostback('menu:compare')).toBeNull()
    expect(parseQuestionPostback('sq:only-two-parts')).toBeNull()
    expect(parseQuestionPostback('sq:step:notanumber')).toBeNull()
    expect(parseQuestionPostback('sq::0')).toBeNull()
  })

  it('LINE の 300 文字制限に収まる', () => {
    expect(buildQuestionPostbackData(crypto.randomUUID(), 12).length).toBeLessThan(300)
  })
})

describe('組み立て', () => {
  it('前文があると2通になる', () => {
    const messages = buildQuestionMessages(QUESTION, 'st1')
    expect(messages).toHaveLength(2)
    expect(messages[0].type).toBe('text')
    expect(messages[1].type).toBe('flex')
  })

  it('前文が無ければ1通', () => {
    const messages = buildQuestionMessages({ ...QUESTION, intro: undefined }, 'st1')
    expect(messages).toHaveLength(1)
  })

  it('選択肢は postback になり、押した文がトークに残る', () => {
    const flex = buildQuestionMessages({ ...QUESTION, intro: undefined }, 'st1')[0] as unknown as {
      contents: { body: { contents: Array<{ contents?: Array<{ action: Record<string, unknown> }> }> } }
    }
    const buttons = flex.contents.body.contents[1].contents!
    expect(buttons[0].action).toMatchObject({
      type: 'postback',
      data: 'sq:st1:0',
      displayText: 'よい',
    })
  })

  it('URLを開く選択肢は uri になる（postback にしない）', () => {
    const q: ScenarioQuestion = {
      text: 'どうぞ',
      tapMode: 'single',
      choices: [{ label: '見る', behavior: 'url', url: 'https://example.com' }],
    }
    const flex = buildQuestionMessages(q, 'st1')[0] as unknown as {
      contents: { body: { contents: Array<{ contents?: Array<{ action: Record<string, unknown> }> }> } }
    }
    expect(flex.contents.body.contents[1].contents![0].action).toMatchObject({
      type: 'uri',
      uri: 'https://example.com',
    })
  })

  it('URLが空なら uri にせず postback に落とす（押せないボタンを作らない）', () => {
    const q: ScenarioQuestion = {
      text: 'どうぞ',
      tapMode: 'single',
      choices: [{ label: '見る', behavior: 'url' }],
    }
    const flex = buildQuestionMessages(q, 'st1')[0] as unknown as {
      contents: { body: { contents: Array<{ contents?: Array<{ action: Record<string, unknown> }> }> } }
    }
    expect(flex.contents.body.contents[1].contents![0].action.type).toBe('postback')
  })
})

describe('parseQuestion', () => {
  it('質問文が空、選択肢が空なら質問として扱わない', () => {
    expect(parseQuestion(JSON.stringify({ text: '', choices: [{ label: 'a' }] }))).toBeNull()
    expect(parseQuestion(JSON.stringify({ text: 'あ', choices: [] }))).toBeNull()
    expect(parseQuestion('{壊れ')).toBeNull()
    expect(parseQuestion(null)).toBeNull()
  })
})

describe('押されたとき', () => {
  let db: D1Database
  let raw: Database.Database
  let pushed: string[]
  let client: LineClient

  beforeEach(() => {
    const created = createTestD1()
    db = created.db
    raw = created.raw
    pushed = []
    client = {
      replyMessage: vi.fn(async (_token: string, messages: Array<{ text?: string }>) => {
        pushed.push(messages[0]?.text ?? '')
      }),
      pushMessage: vi.fn(async (_to: string, messages: Array<{ text?: string }>) => {
        pushed.push(messages[0]?.text ?? '')
      }),
    } as unknown as LineClient

    insertFriend(raw, 'f1')
    raw
      .prepare(`INSERT INTO scenarios (id, name, trigger_type, delivery_mode) VALUES ('s1','テスト','manual','relative')`)
      .run()
    raw
      .prepare(
        `INSERT INTO scenario_steps (id, scenario_id, step_order, delay_minutes, message_type, message_content, question_json)
         VALUES ('st1','s1',1,0,'text','', ?)`,
      )
      .run(JSON.stringify(QUESTION))
    raw.prepare(`INSERT INTO tags (id, name, color) VALUES ('t1','よい','#000'), ('t2','わるい','#000')`).run()
  })

  const friend = { id: 'f1', line_user_id: 'Uf1' }

  it('選んだ選択肢のタグだけが付き、返信が返る', async () => {
    const result = await handleQuestionAnswer(db, client, friend, { stepId: 'st1', choiceIndex: 0 }, 'tok')
    expect(result.handled).toBe(true)
    expect(result.repeat).toBe(false)
    expect(pushed).toEqual(['ありがとうございます！'])
    const tags = raw.prepare(`SELECT tag_id FROM friend_tags WHERE friend_id = 'f1'`).all()
    expect(tags).toEqual([{ tag_id: 't1' }])
  })

  it('選択肢の合計点を1回だけ足し、別の選択肢の点は足さない', async () => {
    const q = { ...QUESTION, choices: QUESTION.choices.map((choice, i) => ({ ...choice, scoreChange: i === 0 ? 10 : 100 })) }
    raw.prepare("UPDATE scenario_steps SET question_json=? WHERE id='st1'").run(JSON.stringify(q))
    await handleQuestionAnswer(db, client, friend, { stepId: 'st1', choiceIndex: 0 }, 'tok')
    await handleQuestionAnswer(db, client, friend, { stepId: 'st1', choiceIndex: 1 }, 'tok')
    expect(raw.prepare("SELECT score FROM friends WHERE id='f1'").get()).toEqual({ score: 10 })
    expect(raw.prepare("SELECT COUNT(*) n FROM friend_scores WHERE friend_id='f1'").get()).toEqual({ n: 1 })
  })

  it('別店舗の質問を指定してもタグ・合計点・押下記録を変えない', async () => {
    raw.prepare("UPDATE friends SET line_account_id='friend-store' WHERE id='f1'").run()
    raw.prepare("UPDATE scenarios SET line_account_id='other-store' WHERE id='s1'").run()
    raw.prepare("UPDATE scenario_steps SET question_json=? WHERE id='st1'").run(JSON.stringify({
      text: '質問', tapMode: 'single', choices: [{ label: '回答', behavior: 'none', addTagIds: ['t1'], scoreChange: 100 }],
    }))
    expect((await handleQuestionAnswer(db, client, friend, { stepId: 'st1', choiceIndex: 0, lineAccountId: 'friend-store' }, 'tok')).handled).toBe(false)
    expect(raw.prepare("SELECT score FROM friends WHERE id='f1'").get()).toEqual({ score: 0 })
    expect(raw.prepare("SELECT COUNT(*) n FROM friend_scores WHERE friend_id='f1'").get()).toEqual({ n: 0 })
    expect(raw.prepare("SELECT COUNT(*) n FROM friend_tags WHERE friend_id='f1'").get()).toEqual({ n: 0 })
    expect(raw.prepare("SELECT COUNT(*) n FROM messages_log WHERE friend_id='f1'").get()).toEqual({ n: 0 })
  })

  it('2度目は二度押しの返事になり、タグは増えない', async () => {
    await handleQuestionAnswer(db, client, friend, { stepId: 'st1', choiceIndex: 0 }, 'tok')
    const second = await handleQuestionAnswer(db, client, friend, { stepId: 'st1', choiceIndex: 1 }, 'tok')
    expect(second.repeat).toBe(true)
    expect(pushed[1]).toBe('すでに押されています！')
    const tags = raw.prepare(`SELECT tag_id FROM friend_tags WHERE friend_id = 'f1'`).all()
    expect(tags).toEqual([{ tag_id: 't1' }])
  })

  it('両方タップ可能なら、別の選択肢は1度目として扱う', async () => {
    raw
      .prepare(`UPDATE scenario_steps SET question_json = ? WHERE id = 'st1'`)
      .run(JSON.stringify({ ...QUESTION, tapMode: 'multiple' }))

    await handleQuestionAnswer(db, client, friend, { stepId: 'st1', choiceIndex: 0 }, 'tok')
    const second = await handleQuestionAnswer(db, client, friend, { stepId: 'st1', choiceIndex: 1 }, 'tok')
    expect(second.repeat).toBe(false)
    const tags = raw
      .prepare(`SELECT tag_id FROM friend_tags WHERE friend_id = 'f1' ORDER BY tag_id`)
      .all()
    expect(tags).toEqual([{ tag_id: 't1' }, { tag_id: 't2' }])
  })

  it('質問ではない通、無い選択肢は触らない', async () => {
    raw.prepare(`UPDATE scenario_steps SET question_json = NULL WHERE id = 'st1'`).run()
    expect((await handleQuestionAnswer(db, client, friend, { stepId: 'st1', choiceIndex: 0 }, 'tok')).handled).toBe(false)

    raw.prepare(`UPDATE scenario_steps SET question_json = ? WHERE id = 'st1'`).run(JSON.stringify(QUESTION))
    expect((await handleQuestionAnswer(db, client, friend, { stepId: 'st1', choiceIndex: 9 }, 'tok')).handled).toBe(false)
  })

  it('押した記録が残る（あとから集計できる）', async () => {
    expect(await hasAnsweredBefore(db, 'f1', 'st1', 0)).toBe(false)
    await handleQuestionAnswer(db, client, friend, { stepId: 'st1', choiceIndex: 0 }, 'tok')
    expect(await hasAnsweredBefore(db, 'f1', 'st1', 0)).toBe(true)
    expect(await hasAnsweredBefore(db, 'f1', 'st1', 1)).toBe(false)
  })
})

describe('シナリオの質問への回答を保存先の型に合わせて検証する', () => {
  let db: D1Database
  let raw: Database.Database
  let client: LineClient

  const friend = { id: 'f1', line_user_id: 'Uf1' }

  function fieldValue(fieldId: string): string | null {
    const row = raw
      .prepare(`SELECT value FROM friend_field_values WHERE friend_id = 'f1' AND field_id = ?`)
      .get(fieldId) as { value: string } | undefined
    return row?.value ?? null
  }

  beforeEach(() => {
    const created = createTestD1()
    db = created.db
    raw = created.raw
    client = {
      replyMessage: vi.fn(async () => undefined),
      pushMessage: vi.fn(async () => undefined),
    } as unknown as LineClient

    insertFriend(raw, 'f1')
    raw
      .prepare(`INSERT INTO scenarios (id, name, trigger_type, delivery_mode) VALUES ('s1','テスト','manual','relative')`)
      .run()
    raw
      .prepare(
        `INSERT INTO friend_fields (id, name, field_key, type) VALUES ('fld-num','来店','visits','number')`,
      )
      .run()
  })

  function setQuestion(field: { fieldId: string; value: string }) {
    raw
      .prepare(
        `INSERT INTO scenario_steps (id, scenario_id, step_order, delay_minutes, message_type, message_content, question_json)
         VALUES ('st1','s1',1,0,'text','', ?)`,
      )
      .run(JSON.stringify({
        text: '教えてください',
        tapMode: 'single',
        choices: [{ label: '送る', behavior: 'none', field }],
      }))
  }

  it('S2 正しい値は保存する', async () => {
    setQuestion({ fieldId: 'fld-num', value: '5' })
    const result = await handleQuestionAnswer(db, client, friend, { stepId: 'st1', choiceIndex: 0 }, 'tok')
    expect(result.handled).toBe(true)
    expect(fieldValue('fld-num')).toBe('5')
  })

  it('S2 型に合わない値は保存せず、回答自体は処理する', async () => {
    setQuestion({ fieldId: 'fld-num', value: 'あいう' })
    const result = await handleQuestionAnswer(db, client, friend, { stepId: 'st1', choiceIndex: 0 }, 'tok')
    expect(result.handled).toBe(true)
    expect(fieldValue('fld-num')).toBeNull()
  })

  it('S2 項目が無ければ孤立した行を作らない', async () => {
    setQuestion({ fieldId: 'fld-gone', value: '5' })
    const result = await handleQuestionAnswer(db, client, friend, { stepId: 'st1', choiceIndex: 0 }, 'tok')
    expect(result.handled).toBe(true)
    expect(fieldValue('fld-gone')).toBeNull()
  })
})
