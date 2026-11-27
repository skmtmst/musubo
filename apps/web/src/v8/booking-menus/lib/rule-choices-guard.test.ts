import { describe, expect, it } from 'vitest'
import { beforeLabel, withCurrent } from './rule-choices'

describe('booking rule-choices defensive guards', () => {
  it('does not append NaN, Infinity, or non-numeric current values into choices', () => {
    expect(withCurrent([7, 30, 90], Number.NaN)).toEqual([7, 30, 90])
    expect(withCurrent([7, 30, 90], Number.POSITIVE_INFINITY)).toEqual([7, 30, 90])
    expect(withCurrent([7, 30, 90], undefined as unknown as number)).toEqual([7, 30, 90])
    expect(withCurrent(null as unknown as number[], 14)).toEqual([14])
  })

  it('returns — instead of NaN 分前まで / Infinity 分前まで on invalid minutes', () => {
    expect(beforeLabel(Number.NaN)).toBe('—')
    expect(beforeLabel(Number.POSITIVE_INFINITY)).toBe('—')
    expect(beforeLabel(null as unknown as number)).toBe('—')
    expect(beforeLabel(0)).toBe('直前まで')
    expect(beforeLabel(30)).toBe('30 分前まで')
    expect(beforeLabel(180)).toBe('3 時間前まで')
  })
})
