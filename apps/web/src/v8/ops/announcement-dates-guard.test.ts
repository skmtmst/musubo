import { describe, expect, it } from 'vitest'
import { longPublishAt, shortPublishAt } from './announcement-dates'

describe('ops/announcement-dates の実在日時ガード', () => {
  it('存在しない日付や不正時刻は繰り上げて誤った曜日や日時へ整形しない', () => {
    expect(longPublishAt('2026-02-31T10:00')).toBe('2026-02-31T10:00')
    expect(shortPublishAt('2026-13-45T99:99')).toBe('2026-13-45T99:99')
    expect(longPublishAt('2026-04-31T08:00')).toBe('2026-04-31T08:00')
  })

  it('実在する日時は短い形式と曜日付き形式で整形する', () => {
    expect(shortPublishAt('2026-11-27T09:30')).toBe('11/27 09:30')
    expect(longPublishAt('2026-11-27T09:30')).toBe('11/27（金）09:30')
  })
})
