import { describe, expect, it } from 'vitest'
import type { SavedSearchConditions } from '@line-crm/shared'

import type { AdvancedSearchResult } from '@/components/friends/advanced-search-dialog'
import type { SegmentCondition } from './segment-condition'
import { buildBroadcastHandoff } from './friends-broadcast-condition'

/*
 * IDEA-03「検索から配信等へ進むときは対象条件を引き継ぐ」。
 * 一覧の絞り込み → 配信対象条件の変換を固定する。
 * 大事な決めごと:
 *  - 「条件なし」は none（リンクを出さない）。空の条件はサーバーで
 *    全員一致(1=1)になるため、リンク自体を作らない。
 *  - 写せない条件が1つでもあれば blocked。部分的に落とすと対象が
 *    広がって誤配信になる。
 */

const EMPTY_INPUT = {
  searchSubmitted: '',
  selectedTagId: '',
  responseFilter: 'all' as const,
  operatorId: '',
  scenarioId: '',
  attentionOnly: false,
  audienceId: '',
  advanced: null,
}

function ready(input: Partial<Parameters<typeof buildBroadcastHandoff>[0]>): SegmentCondition {
  const result = buildBroadcastHandoff({ ...EMPTY_INPUT, ...input })
  if (result.kind !== 'ready') throw new Error(`expected ready, got ${result.kind}`)
  return result.condition
}

function advanced(params: AdvancedSearchResult['params']): AdvancedSearchResult {
  return { params, summary: ['詳細条件'] }
}

describe('絞り込みなし・写せない条件', () => {
  it('何も絞っていないときは none（リンクを出さない）', () => {
    expect(buildBroadcastHandoff(EMPTY_INPUT)).toEqual({ kind: 'none' })
  })

  it('空白だけの検索語は blocked（検索した形跡はあるが写せない）', () => {
    expect(buildBroadcastHandoff({ ...EMPTY_INPUT, searchSubmitted: '  ' })).toEqual({ kind: 'blocked' })
  })

  it('スペースを含む検索語は blocked（name ルールへ完全一致で写せない）', () => {
    expect(buildBroadcastHandoff({ ...EMPTY_INPUT, searchSubmitted: '見本 167' })).toEqual({ kind: 'blocked' })
  })

  it('LIKEの特殊文字を含む検索語は blocked', () => {
    expect(buildBroadcastHandoff({ ...EMPTY_INPUT, searchSubmitted: '100%' })).toEqual({ kind: 'blocked' })
  })

  it('保存検索の適用中は blocked（中身はサーバー保管で画面に無い）', () => {
    expect(
      buildBroadcastHandoff({ ...EMPTY_INPUT, advanced: advanced({ savedSearchId: 'ss-1' }) }),
    ).toEqual({ kind: 'blocked' })
  })

  it('写せない条件種別（メモ）が混ざると blocked', () => {
    const conditions: SavedSearchConditions = {
      all: [
        { kind: 'tag', op: 'includes', value: 'tag-1' },
        { kind: 'memo', op: 'contains', value: '連絡' },
      ],
    }
    expect(
      buildBroadcastHandoff({ ...EMPTY_INPUT, advanced: advanced({ conditions }) }),
    ).toEqual({ kind: 'blocked' })
  })
})

describe('上段の絞り込み', () => {
  it('名前検索1語は name ルールへ', () => {
    expect(ready({ searchSubmitted: 'たなか' }).rules).toEqual([
      { type: 'name', value: { text: 'たなか', targets: ['display'] } },
    ])
  })

  it('タグ・対応・担当者・シナリオ・行動スコア・対象者をまとめてANDで引き継ぐ', () => {
    const condition = ready({
      selectedTagId: 'tag-1',
      responseFilter: 'unhandled',
      operatorId: 'op-1',
      scenarioId: 'sc-1',
      scoreMin: 10,
      scoreMax: 80,
      audienceId: 'aud-1',
    })
    expect(condition.operator).toBe('AND')
    expect(condition.rules).toEqual([
      { type: 'tag_exists', value: 'tag-1' },
      { type: 'chat_status', value: 'unread' },
      { type: 'operator_id', value: 'op-1' },
      { type: 'scenario_state', value: { scenarioId: 'sc-1', state: 'subscribed' } },
      { type: 'score_range', value: { min: 10, max: 80 } },
      { type: 'analytics_audience', value: { audienceId: 'aud-1' } },
    ])
  })

  it('R300: 帯の引き継ぎは scoredOnly を付けて未採点の0点を除く', () => {
    expect(ready({ scoreMax: 29, scoredOnly: true }).rules).toEqual([
      { type: 'score_range', value: { min: undefined, max: 29, scoredOnly: true } },
    ])
  })

  it('R300: scoredOnly が無ければ従来どおり（点数範囲だけ）', () => {
    expect(ready({ scoreMax: 29 }).rules).toEqual([
      { type: 'score_range', value: { min: undefined, max: 29 } },
    ])
  })

  it('注目のみは注目フラグの友だち情報条件へ', () => {
    expect(ready({ attentionOnly: true }).rules).toContainEqual({
      type: 'metadata_equals',
      value: { key: '__attention', value: '1' },
    })
  })
})

describe('詳細条件（平たい引数）', () => {
  it('タグAND・除外タグ・情報欄・登録日・対応状況・表示設定を写す', () => {
    const condition = ready({
      advanced: advanced({
        tagIds: ['tag-1', 'tag-2'],
        excludeTagIds: ['tag-9'],
        metadata: { 会員区分: 'ゴールド' },
        metadataNot: { 住所: '未定' },
        createdFrom: '2026-01-01',
        createdTo: '2026-01-31',
        chatStatus: 'in_progress',
        visibility: 'following',
      }),
    })
    expect(condition.rules).toEqual([
      { type: 'tag_all', value: ['tag-1', 'tag-2'] },
      { type: 'tag_not_exists', value: 'tag-9' },
      { type: 'metadata_equals', value: { key: '会員区分', value: 'ゴールド' } },
      { type: 'metadata_not_equals', value: { key: '住所', value: '未定' } },
      { type: 'registered_at', value: { from: '2026-01-01', to: '2026-01-31' } },
      { type: 'chat_status', value: 'in_progress' },
      { type: 'is_following', value: true },
    ])
  })

  it('ブロックした人の表示設定は is_following=false へ', () => {
    expect(
      ready({ advanced: advanced({ visibility: 'blocked' }) }).rules,
    ).toContainEqual({ type: 'is_following', value: false })
  })
})

describe('詳細条件（AND/OR 条件セット）', () => {
  it('all はAND・any はORグループへ分けて写す', () => {
    const conditions: SavedSearchConditions = {
      all: [{ kind: 'tag', op: 'includes', value: 'tag-1' }],
      any: [
        { kind: 'name', op: 'contains', value: 'たなか' },
        { kind: 'name', op: 'contains', value: 'さとう' },
      ],
    }
    const condition = ready({ advanced: advanced({ conditions }) })
    expect(condition.rules).toEqual([{ type: 'tag_exists', value: 'tag-1' }])
    expect(condition.groups).toEqual([
      {
        operator: 'OR',
        rules: [
          { type: 'name', value: { text: 'たなか', targets: ['display'] } },
          { type: 'name', value: { text: 'さとう', targets: ['display'] } },
        ],
      },
    ])
  })

  it('表示設定（visible_only / hidden_only）は is_hidden ルールへ', () => {
    const visible = ready({
      advanced: advanced({ conditions: { visibility: 'visible_only' } }),
    })
    expect(visible.rules).toEqual([{ type: 'is_hidden', value: false }])
    const hidden = ready({
      advanced: advanced({ conditions: { visibility: 'hidden_only' } }),
    })
    expect(hidden.rules).toEqual([{ type: 'is_hidden', value: true }])
  })

  it('担当者・対応状況・フォーム回答の条件種別を写す', () => {
    const conditions: SavedSearchConditions = {
      all: [
        { kind: 'assignee', op: 'eq', value: 'op-1' },
        { kind: 'chat_status', op: 'eq', value: 'on_hold' },
        { kind: 'form', op: 'exists', formId: 'form-1' },
      ],
    }
    const condition = ready({ advanced: advanced({ conditions }) })
    expect(condition.rules).toEqual([
      { type: 'operator_id', value: 'op-1' },
      { type: 'chat_status', value: 'on_hold' },
      { type: 'form_answered', value: 'form-1' },
    ])
  })

  it('対応状況に一覧に無い値が来たら blocked', () => {
    const conditions: SavedSearchConditions = {
      all: [{ kind: 'chat_status', op: 'eq', value: 'closed' }],
    }
    expect(
      buildBroadcastHandoff({ ...EMPTY_INPUT, advanced: advanced({ conditions }) }),
    ).toEqual({ kind: 'blocked' })
  })
})
