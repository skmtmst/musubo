import { describe, expect, it } from 'vitest'
import {
  compareEvaluationOrder,
  inEvaluationOrder,
  movePriorityUpdates,
  PRIORITY_MAX,
  PRIORITY_MIN,
  type OrderedRule,
} from './order'

describe('auto-replies/order ガード', () => {
  it('priority が NaN や createdAt が欠損していても例外にならず安定して並べ替える', () => {
    const rules: OrderedRule[] = [
      { id: 'nan-rule', priority: Number.NaN, createdAt: null as unknown as string, lineAccountId: 'acc-1' },
      { id: 'normal-rule', priority: 10, createdAt: '2026-01-01T00:00:00Z', lineAccountId: 'acc-1' },
    ]
    expect(() => compareEvaluationOrder(rules[0], rules[1])).not.toThrow()
    expect(inEvaluationOrder(rules).map((r) => r.id)).toEqual(['normal-rule', 'nan-rule'])
  })

  it('範囲外・NaN の priority をそのまま交換せず、API 許容範囲内の連番へ安全に振り直す', () => {
    const ordered: OrderedRule[] = [
      { id: 'a', priority: 10, createdAt: '2026-01-01T00:00:00Z', lineAccountId: 'acc-1' },
      { id: 'b', priority: PRIORITY_MAX + 50, createdAt: '2026-01-02T00:00:00Z', lineAccountId: 'acc-1' },
    ]
    const updates = movePriorityUpdates(ordered, 'b', -1)
    expect(updates).not.toBeNull()
    expect(updates!.every((u) => Number.isInteger(u.priority) && u.priority >= PRIORITY_MIN && u.priority <= PRIORITY_MAX)).toBe(true)

    const map = new Map(updates!.map((u) => [u.id, u.priority]))
    const rebuilt = inEvaluationOrder(ordered.map((r) => ({ ...r, priority: map.get(r.id) ?? r.priority })))
    expect(rebuilt.map((r) => r.id)).toEqual(['b', 'a'])
  })
})
