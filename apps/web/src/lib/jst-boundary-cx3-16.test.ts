import { afterEach, expect, it } from 'vitest'
import { jstDateOffset, jstDayStartIso } from './jst-datetime'

const originalTz = process.env.TZ
afterEach(() => { if (originalTz === undefined) delete process.env.TZ; else process.env.TZ = originalTz })

it.each(['UTC', 'Pacific/Honolulu'])('端末が%sでも日本のうるう日と年越しを正しくまたぐ', timezone => {
  process.env.TZ = timezone
  const leapDay = new Date('2024-02-28T15:00:00Z')
  expect(jstDateOffset(-1, leapDay)).toBe('2024-02-28')
  expect(jstDateOffset(0, leapDay)).toBe('2024-02-29')
  expect(jstDateOffset(1, leapDay)).toBe('2024-03-01')
  const newYear = new Date('2024-12-31T15:00:00Z')
  expect(jstDateOffset(-1, newYear)).toBe('2024-12-31')
  expect(jstDateOffset(0, newYear)).toBe('2025-01-01')
  expect(jstDayStartIso(newYear)).toBe('2024-12-31T15:00:00.000Z')
  expect(jstDayStartIso(newYear, -1)).toBe('2024-12-30T15:00:00.000Z')
})
