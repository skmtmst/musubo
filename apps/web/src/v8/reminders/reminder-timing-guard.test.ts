import { describe, expect, it } from 'vitest'
import { formatTriggerOffset } from './reminder-timing'

describe('reminders/reminder-timing の非数ガード', () => {
  it('非数や無限大のオフセットでは NaN や Infinity を出さず「当日」を返す', () => {
    expect(formatTriggerOffset(Number.NaN)).toBe('当日')
    expect(formatTriggerOffset(Number.POSITIVE_INFINITY)).toBe('当日')
    expect(formatTriggerOffset(Number.NEGATIVE_INFINITY)).toBe('当日')
  })

  it('通常の前・後・当日は従来どおり整形する', () => {
    expect(formatTriggerOffset(0)).toBe('当日')
    expect(formatTriggerOffset(-1440)).toBe('1日前')
    expect(formatTriggerOffset(120)).toBe('2時間後')
  })
})
