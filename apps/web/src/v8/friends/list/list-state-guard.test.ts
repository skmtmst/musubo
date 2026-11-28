// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFriendsListSnapshot, writeFriendsListSnapshot, type FriendsListSnapshot } from './list-state'

const BASE: FriendsListSnapshot = {
  searchInput: '山田',
  searchSubmitted: '山田',
  selectedTagId: '',
  responseFilter: 'all',
  operatorId: '',
  scenarioId: '',
  attentionOnly: false,
  sortMode: 'recent',
  page: 1,
  pageSize: 20,
  advanced: null,
}

describe('friends/list/list-state の詳細検索スナップショット保護', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    window.sessionStorage.clear()
  })

  afterEach(() => {
    window.sessionStorage.clear()
  })

  it('壊れた advanced（配列・params 欠損・summary 非文字配列）を含む保存値を拒否する', () => {
    for (const badAdvanced of [[], {}, { params: null, summary: [] }, { params: {}, summary: [123] }]) {
      window.sessionStorage.setItem(
        'lh_friends_list_state_v1:acc-1',
        JSON.stringify({ ...BASE, advanced: badAdvanced }),
      )
      expect(readFriendsListSnapshot('acc-1')).toBeNull()
    }
  })

  it('正常な advanced を含むスナップショットはそのまま復元できる', () => {
    const valid: FriendsListSnapshot = {
      ...BASE,
      advanced: { params: { query: 'test' }, summary: ['条件A'] } as FriendsListSnapshot['advanced'],
    }
    writeFriendsListSnapshot('acc-1', valid)
    expect(readFriendsListSnapshot('acc-1')).toEqual(valid)
  })
})
