import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommonActionStep } from '@/lib/api'
import { mergeOrderedActions, stepNumbers } from './action-order'

const step = (id: string, type: CommonActionStep['type']): CommonActionStep =>
  ({ id, type, params: {}, onFailure: 'stop' }) as CommonActionStep

describe('automations/action-order の壊れた要素・プロトタイプ鍵保護', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('mergeOrderedActions は null 要素や非配列でも落ちずに分岐位置を保つ', () => {
    const current = [null, step('a', 'add_tag'), step('b', 'branch')] as unknown as CommonActionStep[]
    const nextPlain = [null, step('c', 'send_message')] as unknown as CommonActionStep[]
    expect(mergeOrderedActions(current, nextPlain).map((s) => s.id)).toEqual(['c', 'b'])
    expect(mergeOrderedActions(null as unknown as CommonActionStep[], [step('x', 'add_tag')]).map((s) => s.id)).toEqual(['x'])
  })

  it('stepNumbers は __proto__/constructor/欠損id を除外して安全に採番する', () => {
    const nums = stepNumbers([
      step('__proto__', 'add_tag'),
      step('constructor', 'add_tag'),
      null as unknown as CommonActionStep,
      step('ok', 'send_message'),
    ])
    expect(Object.prototype.hasOwnProperty.call(nums, '__proto__')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(nums, 'constructor')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(nums, 'undefined')).toBe(false)
    expect(nums.ok).toBe(4)
  })
})
