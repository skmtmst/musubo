import { describe, expect, it } from 'vitest'
import { formatDelay } from './schedule-label'

describe('scenario-detail/schedule-label の経過時間ガード', () => {
  it('負数や非数が渡っても壊れた経過表示を出さず「即時」にする', () => {
    expect(formatDelay(-15)).toBe('即時')
    expect(formatDelay(Number.NaN)).toBe('即時')
    expect(formatDelay(Number.POSITIVE_INFINITY)).toBe('即時')
  })

  it('通常の分・時間・日数は従来どおり整形する', () => {
    expect(formatDelay(0)).toBe('即時')
    expect(formatDelay(45)).toBe('45分後')
    expect(formatDelay(90)).toBe('1時間30分後')
    expect(formatDelay(1440)).toBe('1日後')
  })
})
