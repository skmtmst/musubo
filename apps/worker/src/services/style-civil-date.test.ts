import { describe, expect, it } from 'vitest'
import { civilDate } from './style-analytics-core.js'

describe('スタイル集計の日付', () => {
  it.each([
    ['2026-01-01T00:30:00Z', 'Asia/Tokyo', '2026-01-01'],
    ['2026-01-01T00:30:00Z', 'America/Los_Angeles', '2025-12-31'],
    ['2026-03-08T09:59:00Z', 'America/Los_Angeles', '2026-03-08'],
    ['2026-03-08T10:01:00Z', 'America/Los_Angeles', '2026-03-08'],
    ['2026-12-31T23:30:00Z', 'Pacific/Kiritimati', '2027-01-01'],
  ])('%s を %s の日付にする', (instant, timezone, expected) => {
    expect(civilDate(Date.parse(instant), timezone)).toBe(expected)
    expect(civilDate(Date.parse(instant), timezone)).toBe(expected)
  })
  it('不正なタイムゾーンを推測せず拒否する', () => {
    expect(() => civilDate(Date.now(), 'not/a-zone')).toThrow(RangeError)
  })
})
