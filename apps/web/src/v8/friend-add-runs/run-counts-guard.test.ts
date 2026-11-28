import { describe, expect, it } from 'vitest'
import { runCounts } from './run-counts'

describe('runCounts defensive guards', () => {
  it('omits negative, non-finite, or fractional counts instead of returning invalid numbers', () => {
    expect(runCounts('all', 'all', Number.NaN, {
      failed: -3,
      returning: 1.5,
      testPending: Number.POSITIVE_INFINITY,
    })).toEqual({
      all: undefined,
      failed: undefined,
      pending: undefined,
      returning: undefined,
    })

    expect(runCounts('all', 'failed', -1, { failed: 5 })).toEqual({
      all: undefined,
      failed: undefined,
      pending: undefined,
      returning: undefined,
    })
  })

  it('keeps valid non-negative integer counts including 0', () => {
    expect(runCounts('all', 'all', 0, { failed: 0, returning: 0, testPending: 0 })).toEqual({
      all: 0,
      failed: 0,
      pending: 0,
      returning: 0,
    })
  })
})
