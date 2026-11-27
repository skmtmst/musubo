import { describe, expect, it } from 'vitest'
import { scoreBoundary, validAdvancedSearch } from './list-search-validation'

describe('list-search-validation defensive guards', () => {
  it('rejects non-string inputs and normalizes -0 to 0 in scoreBoundary', () => {
    expect(scoreBoundary(123 as unknown as string)).toBeUndefined()
    expect(scoreBoundary(['42'] as unknown as string)).toBeUndefined()
    expect(scoreBoundary(undefined as unknown as string)).toBeUndefined()
    expect(Object.is(scoreBoundary('-0'), 0)).toBe(true)
    expect(scoreBoundary('-5')).toBe(-5)
    expect(scoreBoundary('99')).toBe(99)
  })

  it('rejects non-plain params objects and sparse summary arrays in validAdvancedSearch', () => {
    expect(validAdvancedSearch({ params: new Date(), summary: [] })).toBe(false)
    expect(validAdvancedSearch({ params: new Map(), summary: [] })).toBe(false)
    const sparse = new Array<string>(2)
    sparse[1] = 'タグA'
    expect(validAdvancedSearch({ params: {}, summary: sparse })).toBe(false)
    expect(validAdvancedSearch({ params: { tag: 'a' }, summary: ['タグA'] })).toBe(true)
    expect(validAdvancedSearch(null)).toBe(true)
  })
})
