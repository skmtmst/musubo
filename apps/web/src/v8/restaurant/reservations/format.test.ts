import { describe, it, expect } from 'vitest'
import { addDays, hm, mdhm, minutesOf, dayRange, monthRange, weekRange, sameDay, toYmd, dayTitle, mdWeek } from './format'

describe('予約盤と詳細・印刷の時刻', () => {
  it('同じ瞬間をUTCまたは日本時間で受け取っても19時としてそろえる', () => {
    for (const instant of ['2026-10-02T19:00:00+09:00', '2026-10-02T10:00:00Z']) {
      expect(hm(instant)).toBe('19:00')
      expect(minutesOf(instant)).toBe(19 * 60)
    }
  })

  it.each(['2026-10-11T00:09:00+09:00', '2026-10-11T23:59:00+09:00', '2026-10-11T09:00:00+09:00'])(
    '端末の時間帯によらず日本時間の暦日・期間・日送りを使う（%s）', (instant) => {
      const day = new Date(instant)
      expect(toYmd(day)).toBe('2026-10-11')
      expect(dayTitle(day)).toBe('10月11日（日）')
      expect(sameDay(day, new Date('2026-10-10T15:00:00Z'))).toBe(true)
      expect(dayRange(day)).toEqual({ from: '2026-10-10T15:00:00.000Z', to: '2026-10-11T15:00:00.000Z' })
      expect(weekRange(day)).toEqual({ from: '2026-10-04T15:00:00.000Z', to: '2026-10-11T15:00:00.000Z' })
      expect(monthRange(day)).toEqual({ from: '2026-09-30T15:00:00.000Z', to: '2026-10-31T15:00:00.000Z' })
      expect(toYmd(addDays(day, -1))).toBe('2026-10-10')
      expect(toYmd(addDays(day, 1))).toBe('2026-10-12')
    },
  )

  it('月・年の境目でも翌日と翌月を日本時間で計算する', () => {
    const day = new Date('2026-12-31T23:59:00+09:00')
    expect(toYmd(addDays(day, 1))).toBe('2027-01-01')
    expect(monthRange(day)).toEqual({ from: '2026-11-30T15:00:00.000Z', to: '2026-12-31T15:00:00.000Z' })
  })
})

it('予約詳細と予約台帳は同じ日の表示を揃える', () => {
  const day = new Date('2026-10-01T09:00:00Z')
  expect(mdWeek(day)).toBe(dayTitle(day))
})

it('同じ月日も年を含めて区別し、日本時間の日時を表示する', () => {
  expect(mdhm('2026-10-01T09:00:00Z')).toBe('2026/10/01 18:00')
  expect(mdhm('2027-10-01T09:00:00Z')).toBe('2027/10/01 18:00')
})
