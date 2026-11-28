import { beforeEach, describe, expect, it, vi } from 'vitest'
import { inEvaluationOrder, movePriorityUpdates, PRIORITY_MAX, PRIORITY_MIN, type OrderedRule } from './auto-reply-order'

describe('auto-replies/auto-reply-order の NaN 優先度・欠損 createdAt 保護', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('priority が NaN や createdAt が欠損していても落ちずに安定した順へ並べる', () => {
    const ordered = inEvaluationOrder([
      { id: 'nan', priority: Number.NaN, createdAt: undefined as unknown as string },
      { id: 'b', priority: 10, createdAt: '2026-01-02T00:00:00Z' },
      { id: 'a', priority: 10, createdAt: undefined as unknown as string },
    ])
    expect(ordered.map((r) => r.id)).toEqual(['a', 'b', 'nan'])
  })

  it('範囲外・NaN の priority を入れ替えても不正な priority を返さず安全範囲へ振り直す', () => {
    const ordered: OrderedRule[] = [
      { id: 'a', priority: Number.NaN, createdAt: '2026-01-01T00:00:00Z' },
      { id: 'b', priority: 99999, createdAt: '2026-01-02T00:00:00Z' },
    ]
    const updates = movePriorityUpdates(ordered, 'b', -1)
    expect(updates).not.toBeNull()
    expect(updates!.every((u) => Number.isInteger(u.priority) && u.priority >= PRIORITY_MIN && u.priority <= PRIORITY_MAX)).toBe(true)
    expect(updates).toEqual([
      { id: 'b', priority: 0 },
      { id: 'a', priority: 1 },
    ])
  })
})
