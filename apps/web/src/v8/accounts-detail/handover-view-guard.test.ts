import { beforeEach, describe, expect, it, vi } from 'vitest'
import { totalsMatch, type MatchCounts } from './handover-view'

describe('accounts-detail/handover-view の件数整合チェック保護', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('負数・小数・Infinity・欠損区分が含まれるときは合計が見かけ上一致しても false を返す', () => {
    expect(totalsMatch({ auto: 15, review: -5, unmatched: 0, lookalike: 0 }, 10)).toBe(false)
    expect(totalsMatch({ auto: 1.5, review: 0.5, unmatched: 0, lookalike: 0 }, 2)).toBe(false)
    expect(totalsMatch({ auto: Number.POSITIVE_INFINITY, review: 0, unmatched: 0, lookalike: 0 }, Number.POSITIVE_INFINITY)).toBe(false)
    expect(totalsMatch({ auto: 10, review: 0, unmatched: 0 } as unknown as MatchCounts, 10)).toBe(false)
    expect(totalsMatch({ auto: 0, review: 0, unmatched: 0, lookalike: 0 }, -0)).toBe(true)
    expect(totalsMatch({ auto: 10, review: 2, unmatched: 1, lookalike: 1 }, 14)).toBe(true)
  })
})
