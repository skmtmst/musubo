import { describe, expect, it } from 'vitest'
import { timelineStatusLabel, timelineTypeLabel } from './timeline'

describe('友だちの履歴の名前', () => {
  it.each(['constructor', 'toString', '__proto__', 'future'])('未知の種類・状態 %s を安全に扱う', value => {
    expect(timelineTypeLabel(value)).toBe('記録')
    expect(timelineStatusLabel('booking', value)).toBe(value)
    expect(timelineStatusLabel(value, 'confirmed')).toBe('confirmed')
  })
  it('既知と未指定は従来どおり表示する', () => {
    expect(timelineTypeLabel('booking')).toBe('予約')
    expect(timelineStatusLabel('booking', 'confirmed')).toBe('確定')
    expect(timelineStatusLabel('booking', null)).toBeNull()
  })
})
