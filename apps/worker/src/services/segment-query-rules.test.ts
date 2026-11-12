/*
 * 条件ビルダーで増やした絞り込みを、本物の SQLite に当てて確かめる。
 *
 * 組み立てた SQL の文字列を見るテストにはしない。文字列が想定どおりでも
 * 意味が違えば配信先がずれる。**誰が残るか**で見る。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import type Database from 'better-sqlite3'
import { createTestD1, insertFriend } from '../test-utils/d1-sqlite.js'
import { buildPublicSegmentQuery, buildSegmentQuery, matchesCondition } from './segment-query.js';
import { type SegmentCondition } from '@line-crm/shared';

let db: D1Database
let raw: Database.Database

async function idsMatching(condition: SegmentCondition): Promise<string[]> {
  const { sql, bindings } = buildSegmentQuery(condition)
  const rows = await db.prepare(sql).bind(...bindings).all<{ id: string }>()
  return rows.results.map((r) => r.id).sort()
}

beforeEach(() => {
  const created = createTestD1()
  db = created.db
  raw = created.raw

  insertFriend(raw, 'a', { display_name: '見本 167', real_name: '見本太郎', created_at: '2026-01-10T10:00:00.000' })
  insertFriend(raw, 'b', { display_name: '見本 184', private_memo: 'VIP のお客様', created_at: '2026-02-10T10:00:00.000' })
  insertFriend(raw, 'c', { display_name: 'Carol', status_message: 'よろしく', created_at: '2026-03-10T10:00:00.000' })

  raw.prepare(`INSERT INTO tags (id, name, color) VALUES ('t1','犬','#000000'), ('t2','猫','#000000')`).run()
  raw.prepare(`INSERT INTO friend_tags (friend_id, tag_id) VALUES ('a','t1'), ('a','t2'), ('b','t1')`).run()

  raw
    .prepare(
      `INSERT INTO friend_fields (id, name, field_key, type) VALUES ('f1','来店回数','visit_count','number')`,
    )
    .run()
  raw
    .prepare(
      `INSERT INTO friend_field_values (friend_id, field_id, value) VALUES ('a','f1','12'), ('b','f1','3')`,
    )
    .run()
})

describe('タグ', () => {
  it('全部含む人だけを返す（いずれか1つ、とは違う）', async () => {
    expect(await idsMatching({ operator: 'AND', rules: [{ type: 'tag_all', value: ['t1', 't2'] }] })).toEqual(['a'])
    expect(await idsMatching({ operator: 'OR', rules: [{ type: 'tag_exists', value: 't1' }] })).toEqual(['a', 'b'])
  })

  it('全部含む人を除外する', async () => {
    expect(
      await idsMatching({ operator: 'AND', rules: [{ type: 'tag_not_all', value: ['t1', 't2'] }] }),
    ).toEqual(['b', 'c'])
  })

  it('タグが空の配列なら組み立てを断る（全員一致を作らせない）', () => {
    expect(() => buildSegmentQuery({ operator: 'AND', rules: [{ type: 'tag_all', value: [] }] })).toThrow()
  })
})

describe('固定した配信対象', () => {
  it('確認時点のIDだけを1 bindで固定し、多数でもD1のbind上限を越えない', async () => {
    const ids = [...Array.from({ length: 240 }, (_, index) => `other-${index}`), 'a', 'c', 'a']
    const condition: SegmentCondition = { operator: 'AND', rules: [{ type: 'friend_id_in', value: ids }] }
    const { sql, bindings } = buildSegmentQuery(condition)
    expect(sql).toContain('json_each(?)')
    expect(bindings).toHaveLength(1)
    expect(await idsMatching(condition)).toEqual(['a', 'c'])
  })

  it('空の固定対象は全員一致にせず拒否する', () => {
    expect(() => buildSegmentQuery({ operator: 'AND', rules: [{ type: 'friend_id_in', value: [] }] })).toThrow()
  })

  it('一般の条件保存口は内部snapshot用ID列を拒否する', () => {
    expect(() => buildPublicSegmentQuery({ operator: 'AND', rules: [{ type: 'friend_id_in', value: ['a'] }] })).toThrow('reserved')
  })
})

describe('名前', () => {
  it('半角スペース区切りはいずれかに一致（OR）', async () => {
    expect(
      await idsMatching({
        operator: 'AND',
        rules: [{ type: 'name', value: { text: '167 184', targets: ['display'] } }],
      }),
    ).toEqual(['a', 'b'])
  })

  it('探す欄を選べる', async () => {
    // real_name にしか入っていない形で探す
    raw.prepare(`UPDATE friends SET display_name = 'ニックネーム' WHERE id = 'a'`).run()
    expect(
      await idsMatching({
        operator: 'AND',
        rules: [{ type: 'name', value: { text: '見本太郎', targets: ['real'] } }],
      }),
    ).toEqual(['a'])
    expect(
      await idsMatching({
        operator: 'AND',
        rules: [{ type: 'name', value: { text: '見本太郎', targets: ['display'] } }],
      }),
    ).toEqual([])
  })

  /*
   * 検索対象の指定と未指定を区別する。空配列は「選んでいない」
   * 状態のまま保存されたもので、全欄へ広げず作り直しを促す。
   * 未指定（古い保存形）はこれまでどおり全欄で探す。
   */
  it('R258 空配列は全欄へ広がらない（作り直しを促す）', () => {
    const empty: SegmentCondition = {
      operator: 'AND',
      rules: [{ type: 'name', value: { text: '田中', targets: [] } }],
    }
    expect(() => buildSegmentQuery(empty)).toThrow(/at least one target/)
  })

  it('R258 未指定は古い保存形として全欄で探す', async () => {
    raw.prepare(`UPDATE friends SET display_name = 'ニックネーム' WHERE id = 'a'`).run()
    // targets が無い古い形。real_name の値でも当たる。
    expect(
      await idsMatching({
        operator: 'AND',
        rules: [{ type: 'name', value: { text: '見本太郎' } }],
      }),
    ).toEqual(['a'])
  })

  it('R258 複数選択は選んだ欄だけで判定する', async () => {
    raw.prepare(`UPDATE friends SET display_name = 'ニックネーム' WHERE id = 'a'`).run()
    expect(
      await idsMatching({
        operator: 'AND',
        rules: [{ type: 'name', value: { text: '見本太郎', targets: ['display', 'real'] } }],
      }),
    ).toEqual(['a'])
    expect(
      await idsMatching({
        operator: 'AND',
        rules: [{ type: 'name', value: { text: '見本太郎', targets: ['display', 'system'] } }],
      }),
    ).toEqual([])
  })
})

describe('友だち情報欄', () => {
  it('数の比較は文字列ではなく数として行う', async () => {
    // 文字列比較なら '12' < '3' になり a が落ちる
    expect(
      await idsMatching({
        operator: 'AND',
        rules: [{ type: 'friend_field', value: { fieldId: 'f1', op: 'gte', text: '10' } }],
      }),
    ).toEqual(['a'])
  })

  it('登録なしは、行が無い人も拾う', async () => {
    expect(
      await idsMatching({
        operator: 'AND',
        rules: [{ type: 'friend_field', value: { fieldId: 'f1', op: 'not_exists' } }],
      }),
    ).toEqual(['c'])
  })
})

describe('登録日', () => {
  it('日付だけを渡しても、その日の終わりまで含む', async () => {
    expect(
      await idsMatching({
        operator: 'AND',
        rules: [{ type: 'registered_at', value: { from: '2026-02-01', to: '2026-02-10' } }],
      }),
    ).toEqual(['b'])
  })

  it('from も to も無ければ組み立てを断る', () => {
    expect(() =>
      buildSegmentQuery({ operator: 'AND', rules: [{ type: 'registered_at', value: {} }] }),
    ).toThrow()
  })
})

describe('and と or の入れ子', () => {
  it('親が AND、子グループが OR として効く', async () => {
    // 「犬タグがある」かつ「(名前が田中 または 来店3回)」
    const ids = await idsMatching({
      operator: 'AND',
      rules: [{ type: 'tag_exists', value: 't1' }],
      groups: [
        {
          operator: 'OR',
          rules: [
            { type: 'name', value: { text: '167', targets: ['display'] } },
            { type: 'friend_field', value: { fieldId: 'f1', op: 'equals', text: '3' } },
          ],
        },
      ],
    })
    expect(ids).toEqual(['a', 'b'])
  })

  it('空のグループは足さない（OR で全員一致にならない）', async () => {
    const ids = await idsMatching({
      operator: 'AND',
      rules: [{ type: 'tag_all', value: ['t1', 't2'] }],
      groups: [{ operator: 'OR', rules: [] }],
    })
    expect(ids).toEqual(['a'])
  })
})

describe('書きかけの条件を断る', () => {
  /*
   * 空のまま通すと「誰にも一致しない条件」が保存できてしまう。
   * タグで絞ったのに1人も届かない、という形で出るので原因に辿りつきにくい。
   */
  it('タグIDが空なら組み立てを断る', () => {
    expect(() =>
      buildSegmentQuery({ operator: 'AND', rules: [{ type: 'tag_exists', value: '' }] }),
    ).toThrow()
    expect(() =>
      buildSegmentQuery({ operator: 'AND', rules: [{ type: 'tag_not_exists', value: '' }] }),
    ).toThrow()
  })

  it('紹介コードが空なら組み立てを断る', () => {
    expect(() =>
      buildSegmentQuery({ operator: 'AND', rules: [{ type: 'ref_code', value: '' }] }),
    ).toThrow()
  })

  it('シナリオ購読中だけは空文字に意味がある（どれか1つでも購読中）', async () => {
    raw
      .prepare(
        `INSERT INTO scenarios (id, name, trigger_type, delivery_mode) VALUES ('s1','x','manual','relative')`,
      )
      .run()
    raw
      .prepare(
        `INSERT INTO friend_scenarios (id, friend_id, scenario_id, current_step_order, status, started_at)
         VALUES ('e1','a','s1',0,'active','2026-01-01T00:00:00.000')`,
      )
      .run()
    expect(
      await idsMatching({ operator: 'AND', rules: [{ type: 'scenario_subscribed', value: '' }] }),
    ).toEqual(['a'])
  })
})

describe('matchesCondition', () => {
  it('一覧に出る人と、1人ずつの判定が一致する', async () => {
    const condition: SegmentCondition = {
      operator: 'AND',
      rules: [{ type: 'tag_exists', value: 't1' }],
    }
    const listed = await idsMatching(condition)
    for (const id of ['a', 'b', 'c']) {
      expect(await matchesCondition(db, id, condition)).toBe(listed.includes(id))
    }
  })

  it('条件が null / 空なら全員あてはまる（絞り込みなしの意味）', async () => {
    expect(await matchesCondition(db, 'c', null)).toBe(true)
    expect(await matchesCondition(db, 'c', { operator: 'AND', rules: [] })).toBe(true)
  })
})

describe('分析の一時対象者(N-274)', () => {
  /*
   * audience の中身（friend ID）を条件へ埋めず、audience ID だけを持つ。
   * 評価のたびに所属アカウントと期限を確かめるので、期限切れ・他アカウント・
   * 消えた対象者は誰にもあてはまらない（fail-closed）。
   */
  function seedAudienceRow(
    id: string,
    accountId: string,
    expiresAt: string,
    friendIds: string[],
  ): void {
    raw.prepare(
      `INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret, is_active)
       VALUES (?, ?, ?, 'token', 'secret', 1)`,
    ).run(accountId, `channel-${accountId}`, accountId)
    raw.prepare(
      `INSERT INTO analytics_cross_runs
         (id, line_account_id, query_json, state, period_from, period_to, time_zone, data_cutoff_at, created_at)
       VALUES (?, ?, '{}', 'available', '2026-09-01', '2026-09-30', 'Asia/Tokyo', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
    ).run(`run-${id}`, accountId)
    raw.prepare(
      `INSERT INTO analytics_result_audiences
         (id, line_account_id, source_kind, source_result_id, selection_key, member_count, expires_at, created_at)
       VALUES (?, ?, 'cross', ?, 'a:b', ?, ?, '2026-10-01T00:00:00.000Z')`,
    ).run(id, accountId, `run-${id}`, friendIds.length, expiresAt)
    for (const friendId of friendIds) {
      raw.prepare(
        `INSERT INTO analytics_result_audience_members (audience_id, friend_id) VALUES (?, ?)`,
      ).run(id, friendId)
    }
  }

  it('対象者の友だちだけが残る', async () => {
    seedAudienceRow('aud-1', 'acc-seg', '2999-01-01T00:00:00.000Z', ['a', 'b'])
    raw.prepare(`UPDATE friends SET line_account_id = 'acc-seg'`).run()
    const matched = await idsMatching({
      operator: 'AND',
      rules: [{ type: 'analytics_audience', value: { audienceId: 'aud-1' } }],
    })
    expect(matched).toEqual(['a', 'b'])
  })

  it('期限切れ・他アカウント・不存在は誰にもあてはまらない', async () => {
    seedAudienceRow('aud-expired', 'acc-seg', '2000-01-01T00:00:00.000Z', ['a'])
    seedAudienceRow('aud-other', 'acc-other', '2999-01-01T00:00:00.000Z', ['a'])
    raw.prepare(`UPDATE friends SET line_account_id = 'acc-seg'`).run()
    for (const audienceId of ['aud-expired', 'aud-other', 'aud-none']) {
      const matched = await idsMatching({
        operator: 'AND',
        rules: [{ type: 'analytics_audience', value: { audienceId } }],
      })
      expect(matched).toEqual([])
    }
  })

  it('audienceId の空欄は全員一致にせず組み立てを断る', () => {
    expect(() =>
      buildSegmentQuery({ operator: 'AND', rules: [{ type: 'analytics_audience', value: { audienceId: '' } }] }),
    ).toThrow()
    expect(() =>
      buildSegmentQuery({ operator: 'AND', rules: [{ type: 'analytics_audience', value: {} }] }),
    ).toThrow()
  })

  it('一般の条件保存口でも使える（配信の保存経路が通る）', () => {
    const { sql } = buildPublicSegmentQuery({
      operator: 'AND',
      rules: [{ type: 'analytics_audience', value: { audienceId: 'aud-1' } }],
    })
    expect(sql).toContain('analytics_result_audience_members')
  })
})

describe('友だち一覧からの引継ぎ条件（chat_status / operator_id）', () => {
  /*
   *。一覧の「対応」「担当者」絞り込みを配信条件へ写すための
   * ルール。一覧と同じ chats 台帳を見るので、一覧に出た人と
   * 配信対象がずれない。行が無い人は一覧どおり resolved 扱い。
   */
  beforeEach(() => {
    raw.prepare(
      `INSERT INTO operators (id, name, email) VALUES ('op-1', '佐藤', 'sato@example.com')`,
    ).run()
    raw
      .prepare(
        `INSERT INTO chats (id, friend_id, operator_id, status, created_at, updated_at)
         VALUES ('chat-a', 'a', 'op-1', 'unread', '2026-01-01T00:00:00.000', '2026-01-01T00:00:00.000'),
                ('chat-b', 'b', NULL, 'resolved', '2026-01-01T00:00:00.000', '2026-01-01T00:00:00.000')`,
      )
      .run()
    // c には chats 行を作らない（一覧どおり resolved 扱いになるはず）。
  })

  it('chat_status: 未対応の人だけが残る', async () => {
    expect(
      await idsMatching({ operator: 'AND', rules: [{ type: 'chat_status', value: 'unread' }] }),
    ).toEqual(['a'])
  })

  it('chat_status: 対応済みは行の無い人も含む（一覧と同じ resolved 扱い）', async () => {
    expect(
      await idsMatching({ operator: 'AND', rules: [{ type: 'chat_status', value: 'resolved' }] }),
    ).toEqual(['b', 'c'])
  })

  it('chat_status: 知らない状態は組み立てを断る', () => {
    expect(() =>
      buildSegmentQuery({ operator: 'AND', rules: [{ type: 'chat_status', value: 'closed' }] }),
    ).toThrow()
  })

  it('operator_id: その担当者が付いている人だけが残る', async () => {
    expect(
      await idsMatching({ operator: 'AND', rules: [{ type: 'operator_id', value: 'op-1' }] }),
    ).toEqual(['a'])
  })

  it('operator_id: 空欄は全員一致にせず組み立てを断る', () => {
    expect(() =>
      buildSegmentQuery({ operator: 'AND', rules: [{ type: 'operator_id', value: '' }] }),
    ).toThrow()
  })

  it('一般の条件保存口（配信経路）でも組み立てられる', () => {
    const { sql } = buildPublicSegmentQuery({
      operator: 'AND',
      rules: [{ type: 'chat_status', value: 'unread' }, { type: 'operator_id', value: 'op-1' }],
    })
    expect(sql).toContain('chats')
  })
})
