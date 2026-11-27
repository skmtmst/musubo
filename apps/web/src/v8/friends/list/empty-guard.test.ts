import { beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyMessageOf, hasAnyFilter, type EmptyFilters } from './empty'

describe('friends/list/empty の空白 tagId・欠損オブジェクト保護', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('空白だけの tagId や欠損 search でも絞り込み中と誤認したり落ちたりしない', () => {
    expect(hasAnyFilter({ search: '   ', tagId: '   ', advanced: false, others: false })).toBe(false)
    expect(emptyMessageOf({ search: '', tagId: '   ', advanced: false, others: false }).title).toBe('まだ友だちがいません')
    expect(hasAnyFilter({ search: null, tagId: undefined, advanced: false, others: false } as unknown as EmptyFilters)).toBe(false)
    expect(hasAnyFilter(null as unknown as EmptyFilters)).toBe(false)
    expect(hasAnyFilter({ search: '', tagId: 'tag-1', advanced: false, others: false })).toBe(true)
  })
})
