/*
 * シナリオのアクションを、本物の SQLite に当てて確かめる。
 *
 * 見るのは「実行したか」ではなく「**データがどう変わったか**」。
 * 実行回数だけ見ていると、条件で弾いたつもりが弾けていない、
 * タグが違う人に付いた、といった間違いを素通しする。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import type Database from 'better-sqlite3'
import { applyDueCommonVarSchedules, updateCommonVar } from '@line-crm/db'
import { createTestD1, insertFriend } from '../../test-utils/d1-sqlite.js'
import { publishScenarioVersion } from '@line-crm/db'
import { runScenarioActions, runScenarioOp } from './scenario-actions.js'

let db: D1Database
let raw: Database.Database

const SCENARIO = 's1'
const STEP = 'st1'

function addAction(
  id: string,
  actionType: string,
  config: unknown,
  opts: { condition?: unknown; repeat?: boolean; sortOrder?: number; hook?: string } = {},
) {
  raw
    .prepare(
      `INSERT INTO scenario_actions
         (id, scenario_id, hook, step_id, choice_index, sort_order, action_type, config_json, condition_json, repeat_on_refire)
       VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      SCENARIO,
      opts.hook ?? 'step_sent',
      opts.hook === 'scenario_completed' ? null : STEP,
      opts.sortOrder ?? 0,
      actionType,
      JSON.stringify(config),
      opts.condition ? JSON.stringify(opts.condition) : null,
      opts.repeat === false ? 0 : 1,
    )
}

function tagsOf(friendId: string): string[] {
  return raw
    .prepare(`SELECT tag_id FROM friend_tags WHERE friend_id = ? ORDER BY tag_id`)
    .all(friendId)
    .map((r) => (r as { tag_id: string }).tag_id)
}

function fieldValue(friendId: string, fieldId: string): string | null {
  const row = raw
    .prepare(`SELECT value FROM friend_field_values WHERE friend_id = ? AND field_id = ?`)
    .get(friendId, fieldId) as { value: string } | undefined
  return row?.value ?? null
}

beforeEach(async () => {
  const created = createTestD1()
  db = created.db
  raw = created.raw

  insertFriend(raw, 'f1', { line_account_id: 'account-1' })
  insertFriend(raw, 'f2', { line_account_id: 'account-2' })

  raw
    .prepare(
      `INSERT INTO scenarios (id, name, trigger_type, delivery_mode) VALUES ('s1','テスト','manual','relative'), ('s2','移動先','manual','relative')`,
    )
    .run()
  raw
    .prepare(
      `INSERT INTO scenario_steps (id, scenario_id, step_order, delay_minutes, message_type, message_content)
       VALUES ('st1','s1',1,0,'text','こんにちは'),
              ('st2','s2',1,0,'text','移動先の1通目')`,
    )
    .run()
  // 参加には明示公開が要る（351）。
  await publishScenarioVersion(db, 's1', { staffId: null, idempotencyKey: 'actions-s1' })
  await publishScenarioVersion(db, 's2', { staffId: null, idempotencyKey: 'actions-s2' })
  raw
    .prepare(
      `INSERT INTO tags (id, name, color, group_id) VALUES ('t1','犬','#000',NULL), ('t2','猫','#000','g1'), ('t3','鳥','#000','g1')`,
    )
    .run()
  raw
    .prepare(`INSERT INTO friend_fields (id, name, field_key, type) VALUES ('fld1','来店','visits','number')`)
    .run()
  raw.prepare(`INSERT INTO common_vars (id, line_account_id, name, var_key, type, value) VALUES ('v1','account-1','在庫','stock','number','10')`).run()
})

describe('タグ操作', () => {
  it('付ける・外す', async () => {
    addAction('a1', 'tag', { op: 'add', tagIds: ['t1'] })
    await runScenarioActions(db, { scenarioId: SCENARIO, hook: 'step_sent', friendId: 'f1', stepId: STEP })
    expect(tagsOf('f1')).toEqual(['t1'])

    raw.prepare(`DELETE FROM scenario_actions`).run()
    addAction('a2', 'tag', { op: 'remove', tagIds: ['t1'] })
    await runScenarioActions(db, { scenarioId: SCENARIO, hook: 'step_sent', friendId: 'f1', stepId: STEP })
    expect(tagsOf('f1')).toEqual([])
  })

  it('タグフォルダ指定で、中のタグをまとめて付ける', async () => {
    addAction('a1', 'tag', { op: 'add', tagIds: [], folderId: 'g1' })
    await runScenarioActions(db, { scenarioId: SCENARIO, hook: 'step_sent', friendId: 'f1', stepId: STEP })
    expect(tagsOf('f1')).toEqual(['t2', 't3'])
  })

  it('対象の友だちにだけ付く', async () => {
    addAction('a1', 'tag', { op: 'add', tagIds: ['t1'] })
    await runScenarioActions(db, { scenarioId: SCENARIO, hook: 'step_sent', friendId: 'f1', stepId: STEP })
    expect(tagsOf('f2')).toEqual([])
  })
})

describe('条件', () => {
  it('条件に合わない人には実行しない', async () => {
    addAction('a1', 'tag', { op: 'add', tagIds: ['t1'] }, {
      condition: { operator: 'AND', rules: [{ type: 'tag_exists', value: 't2' }] },
    })
    const result = await runScenarioActions(db, {
      scenarioId: SCENARIO,
      hook: 'step_sent',
      friendId: 'f1',
      stepId: STEP,
    })
    expect(result.skippedByCondition).toBe(1)
    expect(tagsOf('f1')).toEqual([])
  })

  it('条件に合えば実行する', async () => {
    raw.prepare(`INSERT INTO friend_tags (friend_id, tag_id) VALUES ('f1','t2')`).run()
    addAction('a1', 'tag', { op: 'add', tagIds: ['t1'] }, {
      condition: { operator: 'AND', rules: [{ type: 'tag_exists', value: 't2' }] },
    })
    await runScenarioActions(db, { scenarioId: SCENARIO, hook: 'step_sent', friendId: 'f1', stepId: STEP })
    expect(tagsOf('f1')).toEqual(['t1', 't2'])
  })

  it('壊れた条件はそもそも保存できない（列の CHECK が弾く）', () => {
    addAction('a1', 'tag', { op: 'add', tagIds: ['t1'] })
    expect(() =>
      raw.prepare(`UPDATE scenario_actions SET condition_json = '{壊れ' WHERE id = 'a1'`).run(),
    ).toThrow(/json_valid/)
  })

  it('それでも読めない条件が入っていたら、実行せず失敗として数える', async () => {
    // CHECK を通る JSON だが、条件の形になっていない（古い行や手で入れた行）。
    addAction('a1', 'tag', { op: 'add', tagIds: ['t1'] })
    raw.prepare(`UPDATE scenario_actions SET condition_json = '"ただの文字列"' WHERE id = 'a1'`).run()
    const result = await runScenarioActions(db, {
      scenarioId: SCENARIO,
      hook: 'step_sent',
      friendId: 'f1',
      stepId: STEP,
    })
    expect(result.failed).toBe(1)
    expect(tagsOf('f1')).toEqual([])
  })
})

describe('発動2回目以降', () => {
  it('外していれば1度しか実行しない', async () => {
    addAction('a1', 'friend_field', { fieldId: 'fld1', op: 'add', value: '1' }, { repeat: false })
    await runScenarioActions(db, { scenarioId: SCENARIO, hook: 'step_sent', friendId: 'f1', stepId: STEP })
    await runScenarioActions(db, { scenarioId: SCENARIO, hook: 'step_sent', friendId: 'f1', stepId: STEP })
    expect(fieldValue('f1', 'fld1')).toBe('1')
  })

  it('付けていれば毎回実行する', async () => {
    addAction('a1', 'friend_field', { fieldId: 'fld1', op: 'add', value: '1' })
    await runScenarioActions(db, { scenarioId: SCENARIO, hook: 'step_sent', friendId: 'f1', stepId: STEP })
    await runScenarioActions(db, { scenarioId: SCENARIO, hook: 'step_sent', friendId: 'f1', stepId: STEP })
    expect(fieldValue('f1', 'fld1')).toBe('2')
  })

  it('1度きりの記録は友だちごとに別（他の人まで止めない）', async () => {
    addAction('a1', 'friend_field', { fieldId: 'fld1', op: 'add', value: '1' }, { repeat: false })
    await runScenarioActions(db, { scenarioId: SCENARIO, hook: 'step_sent', friendId: 'f1', stepId: STEP })
    await runScenarioActions(db, { scenarioId: SCENARIO, hook: 'step_sent', friendId: 'f2', stepId: STEP })
    expect(fieldValue('f2', 'fld1')).toBe('1')
  })
})

describe('友だち情報欄', () => {
  it('代入・加算・減算・消去', async () => {
    addAction('a1', 'friend_field', { fieldId: 'fld1', op: 'set', value: '5' })
    await runScenarioActions(db, { scenarioId: SCENARIO, hook: 'step_sent', friendId: 'f1', stepId: STEP })
    expect(fieldValue('f1', 'fld1')).toBe('5')

    raw.prepare(`DELETE FROM scenario_actions`).run()
    addAction('a2', 'friend_field', { fieldId: 'fld1', op: 'sub', value: '2' })
    await runScenarioActions(db, { scenarioId: SCENARIO, hook: 'step_sent', friendId: 'f1', stepId: STEP })
    expect(fieldValue('f1', 'fld1')).toBe('3')

    raw.prepare(`DELETE FROM scenario_actions`).run()
    addAction('a3', 'friend_field', { fieldId: 'fld1', op: 'clear', value: '' })
    await runScenarioActions(db, { scenarioId: SCENARIO, hook: 'step_sent', friendId: 'f1', stepId: STEP })
    expect(fieldValue('f1', 'fld1')).toBeNull()
  })

  it('数でない値に加算しても落ちない（0とみなす）', async () => {
    raw
      .prepare(`INSERT INTO friend_field_values (friend_id, field_id, value) VALUES ('f1','fld1','あいう')`)
      .run()
    addAction('a1', 'friend_field', { fieldId: 'fld1', op: 'add', value: '3' })
    const result = await runScenarioActions(db, {
      scenarioId: SCENARIO,
      hook: 'step_sent',
      friendId: 'f1',
      stepId: STEP,
    })
    expect(result.failed).toBe(0)
    expect(fieldValue('f1', 'fld1')).toBe('3')
  })
})

describe('シナリオの動作で更新する友だち情報を型に合わせて検証する', () => {
  function addSelectField() {
    raw
      .prepare(
        `INSERT INTO friend_fields (id, name, field_key, type, options_json)
         VALUES ('fld-sel','プラン','plan','select','["松","竹"]')`,
      )
      .run()
  }

  it('S1 数値項目へ文字の代入は保存せず失敗に数える', async () => {
    addAction('a1', 'friend_field', { fieldId: 'fld1', op: 'set', value: 'あいう' })
    const result = await runScenarioActions(db, {
      scenarioId: SCENARIO,
      hook: 'step_sent',
      friendId: 'f1',
      stepId: STEP,
    })
    expect(result.failed).toBe(1)
    expect(result.executed).toBe(0)
    expect(fieldValue('f1', 'fld1')).toBeNull()
  })

  it('S1 数値のカンマは正規化して保存する', async () => {
    addAction('a1', 'friend_field', { fieldId: 'fld1', op: 'set', value: '1,000' })
    const result = await runScenarioActions(db, {
      scenarioId: SCENARIO,
      hook: 'step_sent',
      friendId: 'f1',
      stepId: STEP,
    })
    expect(result.failed).toBe(0)
    expect(fieldValue('f1', 'fld1')).toBe('1000')
  })

  it('S1 空の代入は行を消す（中央の口の意味に統一）', async () => {
    raw
      .prepare(`INSERT INTO friend_field_values (friend_id, field_id, value) VALUES ('f1','fld1','5')`)
      .run()
    addAction('a1', 'friend_field', { fieldId: 'fld1', op: 'set', value: '' })
    const result = await runScenarioActions(db, {
      scenarioId: SCENARIO,
      hook: 'step_sent',
      friendId: 'f1',
      stepId: STEP,
    })
    expect(result.failed).toBe(0)
    expect(fieldValue('f1', 'fld1')).toBeNull()
  })

  it('S1 選択肢外の値は保存しない', async () => {
    addSelectField()
    addAction('a1', 'friend_field', { fieldId: 'fld-sel', op: 'set', value: '梅' })
    const result = await runScenarioActions(db, {
      scenarioId: SCENARIO,
      hook: 'step_sent',
      friendId: 'f1',
      stepId: STEP,
    })
    expect(result.failed).toBe(1)
    expect(fieldValue('f1', 'fld-sel')).toBeNull()
  })

  it('S1 選択肢内の値は保存する', async () => {
    addSelectField()
    addAction('a1', 'friend_field', { fieldId: 'fld-sel', op: 'set', value: '松' })
    const result = await runScenarioActions(db, {
      scenarioId: SCENARIO,
      hook: 'step_sent',
      friendId: 'f1',
      stepId: STEP,
    })
    expect(result.failed).toBe(0)
    expect(fieldValue('f1', 'fld-sel')).toBe('松')
  })

  it('S1 項目が無ければ孤立した行を作らない', async () => {
    addAction('a1', 'friend_field', { fieldId: 'fld-gone', op: 'set', value: '5' })
    const result = await runScenarioActions(db, {
      scenarioId: SCENARIO,
      hook: 'step_sent',
      friendId: 'f1',
      stepId: STEP,
    })
    expect(result.failed).toBe(1)
    expect(fieldValue('f1', 'fld-gone')).toBeNull()
  })

  it('S1 数値以外への加算結果は保存しない', async () => {
    addSelectField()
    addAction('a1', 'friend_field', { fieldId: 'fld-sel', op: 'add', value: '1' })
    const result = await runScenarioActions(db, {
      scenarioId: SCENARIO,
      hook: 'step_sent',
      friendId: 'f1',
      stepId: STEP,
    })
    expect(result.failed).toBe(1)
    expect(fieldValue('f1', 'fld-sel')).toBeNull()
  })
})

describe('並び順と失敗', () => {
  it('並び順のとおりに動く（前のアクションの結果を次の条件で使える）', async () => {
    addAction('a1', 'tag', { op: 'add', tagIds: ['t1'] }, { sortOrder: 0 })
    addAction('a2', 'tag', { op: 'add', tagIds: ['t2'] }, {
      sortOrder: 1,
      condition: { operator: 'AND', rules: [{ type: 'tag_exists', value: 't1' }] },
    })
    await runScenarioActions(db, { scenarioId: SCENARIO, hook: 'step_sent', friendId: 'f1', stepId: STEP })
    expect(tagsOf('f1')).toEqual(['t1', 't2'])
  })

  it('1つ失敗しても残りは動く', async () => {
    addAction('a1', 'common_var', { varKey: 'ないキー', op: 'add', value: '1' }, { sortOrder: 0 })
    addAction('a2', 'tag', { op: 'add', tagIds: ['t1'] }, { sortOrder: 1 })
    const result = await runScenarioActions(db, {
      scenarioId: SCENARIO,
      hook: 'step_sent',
      friendId: 'f1',
      stepId: STEP,
    })
    expect(result.failed).toBe(1)
    expect(result.executed).toBe(1)
    expect(tagsOf('f1')).toEqual(['t1'])
  })
})

describe('中身が埋まっていないアクション', () => {
  /*
   * 画面はカードを1枚置いてから埋める作り。埋まっていない状態でも保存
   * できるが、実行はしない。実行しても何も起きないだけだが、設定した
   * つもりで効いていないことに気づけないため。
   */
  it('タグを1つも選んでいないタグ操作は実行しない', async () => {
    addAction('a1', 'tag', { op: 'add', tagIds: [] })
    const result = await runScenarioActions(db, {
      scenarioId: SCENARIO,
      hook: 'step_sent',
      friendId: 'f1',
      stepId: STEP,
    })
    expect(result.skippedIncomplete).toBe(1)
    expect(result.executed).toBe(0)
    expect(tagsOf('f1')).toEqual([])
  })

  it('項目を選んでいない友だち情報操作は実行しない', async () => {
    addAction('a1', 'friend_field', { fieldId: '', op: 'set', value: '5' })
    const result = await runScenarioActions(db, {
      scenarioId: SCENARIO,
      hook: 'step_sent',
      friendId: 'f1',
      stepId: STEP,
    })
    expect(result.skippedIncomplete).toBe(1)
  })

  it('埋まっていないものだけ飛ばして、埋まっているものは動く', async () => {
    addAction('a1', 'tag', { op: 'add', tagIds: [] }, { sortOrder: 0 })
    addAction('a2', 'tag', { op: 'add', tagIds: ['t1'] }, { sortOrder: 1 })
    const result = await runScenarioActions(db, {
      scenarioId: SCENARIO,
      hook: 'step_sent',
      friendId: 'f1',
      stepId: STEP,
    })
    expect(result.skippedIncomplete).toBe(1)
    expect(result.executed).toBe(1)
    expect(tagsOf('f1')).toEqual(['t1'])
  })

  it('対応マークの null は「外す」なので実行する', async () => {
    raw.prepare(`INSERT INTO support_marks (id, name, color) VALUES ('m1','未対応','#000')`).run()
    raw.prepare(`UPDATE friends SET support_mark_id = 'm1' WHERE id = 'f1'`).run()
    addAction('a1', 'support_mark', { markId: null })
    const result = await runScenarioActions(db, {
      scenarioId: SCENARIO,
      hook: 'step_sent',
      friendId: 'f1',
      stepId: STEP,
    })
    expect(result.executed).toBe(1)
    const row = raw.prepare(`SELECT support_mark_id FROM friends WHERE id = 'f1'`).get() as {
      support_mark_id: string | null
    }
    expect(row.support_mark_id).toBeNull()
  })
})

describe('発火点', () => {
  it('シナリオ完了時のアクションは、通のアクションと混ざらない', async () => {
    addAction('a1', 'tag', { op: 'add', tagIds: ['t1'] }, { hook: 'step_sent' })
    addAction('a2', 'tag', { op: 'add', tagIds: ['t2'] }, { hook: 'scenario_completed' })

    await runScenarioActions(db, { scenarioId: SCENARIO, hook: 'step_sent', friendId: 'f1', stepId: STEP })
    expect(tagsOf('f1')).toEqual(['t1'])

    await runScenarioActions(db, { scenarioId: SCENARIO, hook: 'scenario_completed', friendId: 'f1' })
    expect(tagsOf('f1')).toEqual(['t1', 't2'])
  })
})

describe('共通情報', () => {
  it('加算・減算がアカウント単位の値に効く', async () => {
    addAction('a1', 'common_var', { varKey: 'stock', op: 'sub', value: '3' })
    await runScenarioActions(db, { scenarioId: SCENARIO, hook: 'step_sent', friendId: 'f1', stepId: STEP })
    expect(commonVarValue('account-1', 'stock')).toBe('7')
  })

  it('同じ共通情報への並行した2更新は両方反映される', async () => {
    addAction('a1', 'common_var', { varKey: 'stock', op: 'sub', value: '3' })
    const sdb = serializedDb()
    const input = { scenarioId: SCENARIO, hook: 'step_sent' as const, friendId: 'f1', stepId: STEP }
    const [first, second] = await Promise.all([
      runScenarioActions(sdb, input),
      runScenarioActions(sdb, input),
    ])
    expect(first.failed).toBe(0)
    expect(second.failed).toBe(0)
    // 10 - 3 - 3。片方が消えると '7' になる。
    expect(commonVarValue('account-1', 'stock')).toBe('4')
  })

  it('他のアカウントの同名キーには触れない', async () => {
    raw
      .prepare(
        `INSERT INTO common_vars (id, line_account_id, name, var_key, type, value)
         VALUES ('v2','account-2','在庫','stock','number','100')`,
      )
      .run()
    addAction('a1', 'common_var', { varKey: 'stock', op: 'sub', value: '3' })
    await runScenarioActions(db, { scenarioId: SCENARIO, hook: 'step_sent', friendId: 'f2', stepId: STEP })
    expect(commonVarValue('account-2', 'stock')).toBe('97')
    expect(commonVarValue('account-1', 'stock')).toBe('10')
  })

  it('自分のアカウントに無いキーは失敗し、他のアカウントの値は変わらない', async () => {
    raw
      .prepare(
        `INSERT INTO common_vars (id, line_account_id, name, var_key, type, value)
         VALUES ('v2','account-2','予約枠','seats','number','5')`,
      )
      .run()
    addAction('a1', 'common_var', { varKey: 'seats', op: 'sub', value: '1' })
    const result = await runScenarioActions(db, {
      scenarioId: SCENARIO,
      hook: 'step_sent',
      friendId: 'f1',
      stepId: STEP,
    })
    expect(result.failed).toBe(1)
    expect(commonVarValue('account-2', 'seats')).toBe('5')
  })

  it('数でない値に加算しても落ちない（0とみなす）', async () => {
    raw.prepare(`UPDATE common_vars SET value = 'あいう' WHERE var_key = 'stock'`).run()
    addAction('a1', 'common_var', { varKey: 'stock', op: 'add', value: '3' })
    const result = await runScenarioActions(db, {
      scenarioId: SCENARIO,
      hook: 'step_sent',
      friendId: 'f1',
      stepId: STEP,
    })
    expect(result.failed).toBe(0)
    expect(commonVarValue('account-1', 'stock')).toBe('3')
  })

  it('加算・減算で版番号と履歴が進む', async () => {
    seedV1History()
    addAction('a1', 'common_var', { varKey: 'stock', op: 'sub', value: '3' })
    await runScenarioActions(db, { scenarioId: SCENARIO, hook: 'step_sent', friendId: 'f1', stepId: STEP })
    expect(commonVarValue('account-1', 'stock')).toBe('7')
    expect(commonVarVersion('v1')).toBe(2)

    raw.prepare(`DELETE FROM scenario_actions`).run()
    addAction('a2', 'common_var', { varKey: 'stock', op: 'add', value: '2' })
    await runScenarioActions(db, { scenarioId: SCENARIO, hook: 'step_sent', friendId: 'f1', stepId: STEP })
    expect(commonVarValue('account-1', 'stock')).toBe('9')
    expect(commonVarVersion('v1')).toBe(3)
    expect(versionHistory('v1')).toEqual([
      { version_no: 1, value: '10', change_reason: '作成' },
      { version_no: 2, value: '7', change_reason: 'シナリオ減算' },
      { version_no: 3, value: '9', change_reason: 'シナリオ加算' },
    ])
  })

  it('引ききれなくても負の数で残る（下限で止めない）', async () => {
    raw.prepare(`UPDATE common_vars SET value = '2' WHERE id = 'v1'`).run()
    addAction('a1', 'common_var', { varKey: 'stock', op: 'sub', value: '5' })
    const result = await runScenarioActions(db, {
      scenarioId: SCENARIO,
      hook: 'step_sent',
      friendId: 'f1',
      stepId: STEP,
    })
    expect(result.failed).toBe(0)
    expect(commonVarValue('account-1', 'stock')).toBe('-3')
  })

  it('加算と減算の並行でも両方反映され、版と履歴が連番になる', async () => {
    seedV1History()
    addAction('a1', 'common_var', { varKey: 'stock', op: 'add', value: '5' })
    raw
      .prepare(
        `INSERT INTO scenario_actions
           (id, scenario_id, hook, step_id, choice_index, sort_order, action_type, config_json, condition_json, repeat_on_refire)
         VALUES ('b1', 's2', 'step_sent', NULL, NULL, 0, 'common_var', ?, NULL, 1)`,
      )
      .run(JSON.stringify({ varKey: 'stock', op: 'sub', value: '3' }))
    const sdb = serializedDb()
    const [first, second] = await Promise.all([
      runScenarioActions(sdb, { scenarioId: 's1', hook: 'step_sent', friendId: 'f1', stepId: STEP }),
      runScenarioActions(sdb, { scenarioId: 's2', hook: 'step_sent', friendId: 'f1' }),
    ])
    expect(first.failed).toBe(0)
    expect(second.failed).toBe(0)
    // 10 + 5 - 3。順番がどちらでも '12'。
    expect(commonVarValue('account-1', 'stock')).toBe('12')
    expect(commonVarVersion('v1')).toBe(3)
    const history = versionHistory('v1')
    expect(history.map((h) => h.version_no)).toEqual([1, 2, 3])
    expect(history[2]?.value).toBe('12')
  })

  it('10件の連続した並行更新がすべて最終値・版・履歴に残る', async () => {
    seedV1History()
    addAction('a1', 'common_var', { varKey: 'stock', op: 'add', value: '1' })
    const sdb = serializedDb()
    const input = { scenarioId: SCENARIO, hook: 'step_sent' as const, friendId: 'f1', stepId: STEP }
    // 再試行も上限もない。競合は起きず、10件すべてが順に当たる。
    const results = await Promise.all(
      Array.from({ length: 10 }, () => runScenarioActions(sdb, input)),
    )
    for (const result of results) {
      expect(result.failed).toBe(0)
      expect(result.executed).toBe(1)
    }
    expect(commonVarValue('account-1', 'stock')).toBe('20')
    expect(commonVarVersion('v1')).toBe(11)
    assertVersionHistoryConsistent('v1')
  })

  it('先頭に数字がある文字列は先頭の数として読む（SQL数値化）', async () => {
    // 計算を SQL の中で行うため、数の読み方は SQLite に従う。
    // '12abc' は従来の Number 扱いだと0だが、ここでは12として足す。
    raw.prepare(`UPDATE common_vars SET value = '12abc' WHERE id = 'v1'`).run()
    addAction('a1', 'common_var', { varKey: 'stock', op: 'add', value: '3' })
    const result = await runScenarioActions(db, {
      scenarioId: SCENARIO,
      hook: 'step_sent',
      friendId: 'f1',
      stepId: STEP,
    })
    expect(result.failed).toBe(0)
    expect(commonVarValue('account-1', 'stock')).toBe('15')
  })

  it('画面編集と並行しても版契約が壊れない', async () => {
    seedV1History()
    addAction('a1', 'common_var', { varKey: 'stock', op: 'add', value: '5' })
    const sdb = serializedDb()
    const screen = updateCommonVar(sdb, 'v1', 'account-1', { value: '100', changeReason: '在庫補正' }).then(
      () => ({ ok: true as const }),
      () => ({ ok: false as const }),
    )
    const [scenarioResult, screenResult] = await Promise.all([
      runScenarioActions(sdb, { scenarioId: SCENARIO, hook: 'step_sent', friendId: 'f1', stepId: STEP }),
      screen,
    ])
    expect(scenarioResult.failed).toBe(0)
    assertVersionHistoryConsistent('v1')
    if (screenResult.ok) {
      // 画面が先なら105、後なら100。どちらも版どおり。
      expect(['100', '105']).toContain(commonVarValue('account-1', 'stock'))
    } else {
      // 画面が古い版で負けた。シナリオの加算だけが残る。
      expect(commonVarValue('account-1', 'stock')).toBe('15')
    }
  })

  it('予約適用と並行しても版契約が壊れない', async () => {
    seedV1History()
    raw
      .prepare(
        `INSERT INTO common_var_schedules (id, var_id, effective_from, value, applied_at)
         VALUES ('sch1', 'v1', '2026-01-01T00:00:00.000', '50', NULL)`,
      )
      .run()
    addAction('a1', 'common_var', { varKey: 'stock', op: 'sub', value: '3' })
    const sdb = serializedDb()
    const schedule = applyDueCommonVarSchedules(sdb, '2026-06-01T00:00:00.000').then(
      () => ({ ok: true as const }),
      () => ({ ok: false as const }),
    )
    const [scenarioResult] = await Promise.all([
      runScenarioActions(sdb, { scenarioId: SCENARIO, hook: 'step_sent', friendId: 'f1', stepId: STEP }),
      schedule,
    ])
    expect(scenarioResult.failed).toBe(0)
    assertVersionHistoryConsistent('v1')
    const applied = (
      raw.prepare(`SELECT applied_at FROM common_var_schedules WHERE id = 'sch1'`).get() as {
        applied_at: string | null
      }
    ).applied_at
    if (applied) {
      // 予約が当たった。先なら47、シナリオの後なら絶対値50のまま。
      expect(['47', '50']).toContain(commonVarValue('account-1', 'stock'))
    } else {
      // 予約は版で負けて次回送り。シナリオの減算だけが残る。
      expect(commonVarValue('account-1', 'stock')).toBe('7')
    }
  })
})

function commonVarValue(lineAccountId: string, varKey: string): string | null {
  const row = raw
    .prepare(`SELECT value FROM common_vars WHERE line_account_id = ? AND var_key = ?`)
    .get(lineAccountId, varKey) as { value: string } | undefined
  return row?.value ?? null
}

function commonVarVersion(id: string): number {
  const row = raw.prepare(`SELECT version FROM common_vars WHERE id = ?`).get(id) as {
    version: number
  }
  return row.version
}

interface VersionHistoryRow {
  version_no: number
  value: string
  change_reason: string
}

function versionHistory(varId: string): VersionHistoryRow[] {
  return raw
    .prepare(
      `SELECT version_no, value, change_reason FROM common_var_versions
        WHERE common_var_id = ? ORDER BY version_no ASC`,
    )
    .all(varId) as VersionHistoryRow[]
}

/** 備品の v1 行には履歴が無いので、版1の行を足す。 */
function seedV1History(): void {
  raw
    .prepare(
      `INSERT INTO common_var_versions
         (id, common_var_id, version_no, name, value, memo, change_reason, actor_id, created_at)
       VALUES ('hv1', 'v1', 1, '在庫', '10', '', '作成', NULL, '2026-01-01T00:00:00.000')`,
    )
    .run()
}

/** 版番号と履歴が食い違っていないこと。最後の履歴が今の値を指す。 */
function assertVersionHistoryConsistent(varId: string): void {
  const version = commonVarVersion(varId)
  const history = versionHistory(varId)
  expect(history.map((h) => h.version_no)).toEqual(
    Array.from({ length: version }, (_, i) => i + 1),
  )
  const row = raw.prepare(`SELECT value FROM common_vars WHERE id = ?`).get(varId) as {
    value: string
  }
  expect(history[history.length - 1]?.value).toBe(row.value)
}

/**
 * batch だけを直列にする D1。
 *
 * テスト用の D1 は接続が1つなので、2つの batch が重なると BEGIN が
 * 入れ子になって落ちる。本物の D1 では batch は原子単位で直列に確定
 * されるので、その動きをここで再現する。
 */
function serializedDb(): D1Database {
  let tail: Promise<unknown> = Promise.resolve()
  const batch = async (statements: D1PreparedStatement[]) => {
    const run = tail.then(() =>
      (db as unknown as { batch: (s: D1PreparedStatement[]) => Promise<unknown> }).batch(statements),
    )
    tail = run.catch(() => undefined)
    return run
  }
  return {
    prepare: db.prepare.bind(db),
    batch: batch as unknown as D1Database['batch'],
  } as unknown as D1Database
}



describe('シナリオ操作', () => {
  it('購読を始める', async () => {
    await runScenarioOp(db, 'f1', SCENARIO, { op: 'start', scenarioId: 's2' })
    const row = raw
      .prepare(`SELECT status FROM friend_scenarios WHERE friend_id = 'f1' AND scenario_id = 's2'`)
      .get() as { status: string } | undefined
    expect(row?.status).toBe('active')
  })

  it('割り込みで前のシナリオを控えて、完了時に戻せる', async () => {
    // s1 を読んでいる途中に s2 へ割り込む
    raw
      .prepare(
        `INSERT INTO friend_scenarios (id, friend_id, scenario_id, current_step_order, status, started_at)
         VALUES ('e1','f1','s1',0,'active','2026-01-01T00:00:00.000')`,
      )
      .run()

    await runScenarioOp(db, 'f1', 's1', { op: 'start', scenarioId: 's2', rememberPrevious: true })

    const paused = raw
      .prepare(`SELECT status FROM friend_scenarios WHERE friend_id = 'f1' AND scenario_id = 's1'`)
      .get() as { status: string }
    expect(paused.status).toBe('paused')

    const interrupt = raw
      .prepare(`SELECT previous_scenario_id FROM friend_scenarios WHERE friend_id = 'f1' AND scenario_id = 's2'`)
      .get() as { previous_scenario_id: string | null }
    expect(interrupt.previous_scenario_id).toBe('s1')

    const { resumePreviousScenario } = await import('./scenario-actions.js')
    expect(await resumePreviousScenario(db, 'f1', 's2')).toBe(true)

    const resumed = raw
      .prepare(`SELECT status FROM friend_scenarios WHERE friend_id = 'f1' AND scenario_id = 's1'`)
      .get() as { status: string }
    expect(resumed.status).toBe('active')
  })

  it('控えが無ければ、適当なシナリオを再開しない', async () => {
    raw
      .prepare(
        `INSERT INTO friend_scenarios (id, friend_id, scenario_id, current_step_order, status, started_at)
         VALUES ('e1','f1','s1',0,'paused','2026-01-01T00:00:00.000'),
                ('e2','f1','s2',0,'completed','2026-01-01T00:00:00.000')`,
      )
      .run()
    const { resumePreviousScenario } = await import('./scenario-actions.js')
    expect(await resumePreviousScenario(db, 'f1', 's2')).toBe(false)
    const still = raw
      .prepare(`SELECT status FROM friend_scenarios WHERE friend_id = 'f1' AND scenario_id = 's1'`)
      .get() as { status: string }
    expect(still.status).toBe('paused')
  })
})
