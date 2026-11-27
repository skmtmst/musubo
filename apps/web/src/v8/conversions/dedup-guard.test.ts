import { beforeEach, describe, expect, it, vi } from 'vitest'
import { deduplicationLabel } from './dedup'

describe('deduplicationLabel の日数保護', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('正の整数日数だけを「N日に1回まで」として表示する', () => {
    expect(deduplicationLabel('window', 30)).toBe('30日に1回まで')
    expect(deduplicationLabel('window', 1)).toBe('1日に1回まで')
    expect(deduplicationLabel('once_per_friend', 30)).toBe('1人1回だけ')
    expect(deduplicationLabel('every', null)).toBe('何回でも数える')
  })

  it('Infinity・小数・0以下・NaN のときは安全な既定文言へ戻す', () => {
    expect(deduplicationLabel('window', Number.POSITIVE_INFINITY)).toBe('決めた日数に1回まで')
    expect(deduplicationLabel('window', Number.NaN)).toBe('決めた日数に1回まで')
    expect(deduplicationLabel('window', 7.5)).toBe('決めた日数に1回まで')
    expect(deduplicationLabel('window', 0)).toBe('決めた日数に1回まで')
    expect(deduplicationLabel('window', -3)).toBe('決めた日数に1回まで')
  })
})
