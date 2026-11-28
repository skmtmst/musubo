import { describe, expect, it } from 'vitest'
import { hm, mdhm, minutesOf, shortCourse, slotLabel } from './format'

describe('restaurant/reservations/format のUTC正規化・コース名・枠ラベルガード', () => {
  it('SQLite 形式のオフセットなし UTC 日時を端末の地域に依存せず日本時間でそろえる', () => {
    expect(hm('2026-10-02 10:00:00')).toBe('19:00')
    expect(mdhm('2026-10-01 09:00:00')).toBe('2026/10/01 18:00')
    expect(minutesOf('2026-10-02 10:00:00')).toBe(19 * 60)
  })

  it('空白コース名は「席のみ」にし、「コース」単体で空文字に潰さない', () => {
    expect(shortCourse('   ')).toBe('席のみ')
    expect(shortCourse('コース')).toBe('コース')
    expect(shortCourse('秋の鹿肉コース')).toBe('秋の鹿肉')
  })

  it('slotLabel は非有限値や負数で NaN:NaN を出さず — にし、24時以降も扱える', () => {
    expect(slotLabel(Number.NaN)).toBe('—')
    expect(slotLabel(Number.POSITIVE_INFINITY)).toBe('—')
    expect(slotLabel(-10)).toBe('—')
    expect(slotLabel(24 * 60)).toBe('24:00')
    expect(slotLabel(19 * 60 + 30)).toBe('19:30')
  })
})
