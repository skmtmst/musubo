import { describe, expect, it } from 'vitest'
import { followupTimingLabel } from './board-model'

describe('restaurant/line-followup/board-model のタイミング表記ガード', () => {
  it('時刻指定で正の日数を「前」と誤表記せず、非数や空時刻で壊れた文を出さない', () => {
    expect(followupTimingLabel('reservation_24h', { mode: 'time', offsetDays: 2, sendAtTime: '18:00' })).toBe('予約の2日後 18:00 に送る')
    expect(followupTimingLabel('reservation_24h', { mode: 'time', offsetDays: Number.NaN, sendAtTime: '18:00' })).toBe('送るタイミング未設定')
    expect(followupTimingLabel('reservation_24h', { mode: 'time', offsetDays: -1, sendAtTime: '   ' })).toBe('送るタイミング未設定')
  })

  it('経過分数が非数や負数のときに NaN やマイナス表記を出さない', () => {
    expect(followupTimingLabel('reservation_2h', { mode: 'countdown', offsetMinutes: Number.NaN })).toBe('送るタイミング未設定')
    expect(followupTimingLabel('post_visit', { mode: 'countdown', offsetMinutes: -30 })).toBe('退店からすぐに送る')
    expect(followupTimingLabel('post_visit', { mode: 'next_day', sendAtTime: '   ' })).toBe('退店の翌日に送る')
  })
})
