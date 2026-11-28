import { describe, expect, it } from 'vitest'
import type { EventMakeupRule } from '@/lib/api'
import { makeupRuleSummary, readMakeupRule } from './makeup-rule'

describe('events/makeup-rule ガード', () => {
  it('数値項目が NaN や負数・targetIds が非配列でも壊れた要約文字列を出さない', () => {
    const broken = {
      enabled: true,
      cutoffHours: Number.NaN,
      validDays: 0,
      monthlyCap: -1,
      target: 'list',
      targetIds: null,
    } as unknown as EventMakeupRule

    const summary = makeupRuleSummary(broken)
    expect(summary).not.toContain('NaN')
    expect(summary).toContain('開始前の締切未設定')
    expect(summary).toContain('有効期限未設定')
    expect(summary).toContain('月の上限未設定')
    expect(summary).toContain('指定の 0 クラス')

    expect(
      makeupRuleSummary({
        enabled: true,
        cutoffHours: 3,
        validDays: 30,
        monthlyCap: 2,
        target: 'same_kind',
        targetIds: [],
      }),
    ).toBe('使う・開始の 3 時間前まで・元の回から 30 日間・月 2 回まで・同じクラス')
  })

  it('非文字列や配列 JSON を振替ルールとして誤認しない', () => {
    expect(readMakeupRule('[]')).toBeNull()
    expect(readMakeupRule(123 as unknown as string)).toBeNull()
  })
})
