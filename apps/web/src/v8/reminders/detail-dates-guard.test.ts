import { describe, expect, it } from 'vitest'
import { dateTimeLocalJst } from './detail-dates'
import { dateTimeLocalJstToUtcIso } from './detail'

describe('reminders/detail-dates のオフセットなしUTC正規化ガード', () => {
  it('SQLite 形式のオフセットなし UTC 文字列を端末のタイムゾーンに依存せず日本時間へ変換する', () => {
    expect(dateTimeLocalJst('2026-08-22 09:22:00')).toBe('2026-08-22T18:22')
    expect(dateTimeLocalJst(' 2026-08-22T09:22:00 ')).toBe('2026-08-22T18:22')
    expect(dateTimeLocalJstToUtcIso(dateTimeLocalJst('2026-08-22 09:22:00'))).toBe('2026-08-22T09:22:00.000Z')
  })

  it('オフセット付き ISO 日時は前どおり変換し、空文字や不正値は空文字を返す', () => {
    expect(dateTimeLocalJst('2026-08-22T15:00:00.000Z')).toBe('2026-08-23T00:00')
    expect(dateTimeLocalJst('2026-08-22T16:30:00-07:00')).toBe('2026-08-23T08:30')
    expect(dateTimeLocalJst('   ')).toBe('')
    expect(dateTimeLocalJst('not-a-date')).toBe('')
  })
})
