import { describe, expect, it } from 'vitest'
import { orderTargetingGroups, withNormalizedPriority } from './targeting-order'

const groups = [
  { id: 'g1', targetingPriority: 1, createdAt: '2026-10-01T00:00:00Z' },
  { id: 'g2', targetingPriority: 2, createdAt: '2026-10-02T00:00:00Z' },
]

describe('rich-menus/targeting-order の正規化ガード', () => {
  it('未知IDや重複IDが混ざっても連番 0,1,... を保ち同じグループを二重追加しない', () => {
    const result = withNormalizedPriority(groups, ['missing', 'g2', 'g2', 'g1'])
    expect(result.map((g) => [g.id, g.targetingPriority])).toEqual([
      ['g2', 0],
      ['g1', 1],
    ])
  })

  it('優先度が非数の要素が混ざっても末尾へ寄せて安定して並べる', () => {
    const ordered = orderTargetingGroups([
      { id: 'nan', targetingPriority: Number.NaN, createdAt: '2026-10-01T00:00:00Z' },
      { id: 'first', targetingPriority: 0, createdAt: '2026-10-03T00:00:00Z' },
      { id: 'second', targetingPriority: 1, createdAt: '2026-10-02T00:00:00Z' },
    ])
    expect(ordered.map((g) => g.id)).toEqual(['first', 'second', 'nan'])
  })
})
