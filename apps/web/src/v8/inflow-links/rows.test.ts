/*
 * 監査 WEB033：すぐ送るテンプレートだけを設定した経路を「動きが未設定」と数えない。
 */
import { describe, expect, it } from 'vitest'
import type { EntryRoute } from '@line-crm/shared'
import { becameLines, buildRows, isUnconfigured, matchesFilter } from './rows'

const route = (overrides: Partial<EntryRoute>): EntryRoute => ({
  id: 'er-1', refCode: 'r1', genre: null, name: '経路', tagId: null, scenarioId: null,
  redirectUrl: null, poolId: null, introTemplateId: null, runAccountFriendAddScenarios: true, isActive: true,
  stoppedAt: null, stoppedReason: null, createdAt: '', updatedAt: '',
  ...overrides,
} as EntryRoute)

describe('流入経路の「動き」（WEB033）', () => {
  it('テンプレートだけの経路は未設定ではなく、「テンプレートを送る」と出す', () => {
    const [row] = buildRows([route({ introTemplateId: 'tpl-1' })], [], null)
    expect(isUnconfigured(row)).toBe(false)
    expect(becameLines(row, undefined, undefined, 'ようこそ')).toEqual(['—', 'テンプレート「ようこそ」を送る'])
  })

  it('何も無い経路は今までどおり未設定（対照）', () => {
    const [row] = buildRows([route({})], [], null)
    expect(isUnconfigured(row)).toBe(true)
    expect(becameLines(row, undefined, undefined)).toEqual(['—', '何も付けない'])
  })
})

it('集計を取得できたとき、記録のない経路は0人として絞り込む', () => {
  const [zero] = buildRows([route({})], [], { routes: [], totalFriends: 0, friendsWithRef: 0, friendsWithoutRef: 0 })
  expect(zero.stats).toBeUndefined()
  expect(matchesFilter(zero, 'no-friends', true)).toBe(true)
  expect(matchesFilter(zero, 'has-friends', true)).toBe(false)
})

it('集計を取得できない経路は追加ありにも追加なしにも含めない', () => {
  const [unknown] = buildRows([route({})], [], null)
  expect(matchesFilter(unknown, 'no-friends', false)).toBe(false)
  expect(matchesFilter(unknown, 'has-friends', false)).toBe(false)
  const stale = { ...unknown, stats: { refCode: 'r1', name: null, friendCount: 3, clickCount: 0, latestAt: null } }
  expect(matchesFilter(stale, 'has-friends', false)).toBe(false)
  expect(matchesFilter(stale, 'has-friends', true)).toBe(true)
  expect(matchesFilter(stale, 'no-friends', true)).toBe(false)
})
