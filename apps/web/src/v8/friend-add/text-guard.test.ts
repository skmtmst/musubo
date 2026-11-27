import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FriendAddRuleOptions } from '@/lib/api'
import type { SegmentCondition } from '@/lib/segment-condition'
import { conditionSummary, localInputValue, resendSuppressionText } from './text'

describe('friend-add/text の非有限時間・壊れた条件オブジェクト保護', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('resendSuppressionText は NaN・Infinity で異常文字列を出さず既定の 24時間に1回 へ戻す', () => {
    expect(resendSuppressionText(Number.NaN)).toBe('24時間に1回')
    expect(resendSuppressionText(Number.POSITIVE_INFINITY)).toBe('24時間に1回')
    expect(resendSuppressionText(168)).toBe('7日に1回')
    expect(resendSuppressionText(0)).toBe('制限しない')
    expect(localInputValue(123 as unknown as string)).toBe('')
  })

  it('conditionSummary は rules/tags 欠損や null 要素でも落ちずに要約を返す', () => {
    const missingRules = { operator: 'AND', groups: [{ operator: 'AND', rules: [] }] } as unknown as SegmentCondition
    expect(conditionSummary(missingRules, null as unknown as FriendAddRuleOptions['tags'])).toBe('友だち条件：1つ')
    const withNullRule = { operator: 'AND', rules: [null] } as unknown as SegmentCondition
    expect(conditionSummary(withNullRule, [])).toBe('友だち条件：1つ')
    const valid = { operator: 'AND', rules: [{ type: 'tag_exists', value: 't1' }] } as unknown as SegmentCondition
    expect(conditionSummary(valid, [{ id: 't1', name: 'VIP' }] as FriendAddRuleOptions['tags'])).toBe('友だち条件：タグ「VIP」が付いている')
  })
})
