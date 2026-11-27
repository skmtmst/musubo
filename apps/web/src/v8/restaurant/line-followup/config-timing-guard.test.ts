import { describe, expect, it } from 'vitest'
import { exactTiming, timingError, timingLabel } from './config'

describe('restaurant/line-followup/config の非有限・不正時期ガード', () => {
  it('timingLabel は非有限の分数で NaN や Infinity を出さず未確定の案内を返す', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(timingLabel('reservation_24h', value)).toBe('時期を確認できません')
      expect(timingLabel('post_visit', value)).toBe('時期を確認できません')
      expect(timingLabel('anniversary_before', value)).toBe('時期を確認できません')
    }
    expect(timingLabel('post_visit', null)).toBe('時期がまだありません')
    expect(timingLabel('reservation_24h', -1440)).toBe('1日前')
  })

  it('exactTiming と timingError は非有限や負の値を不正文字列・誤った理由にしない', () => {
    expect(exactTiming(Number.NaN, ['minutes', 'hours', 'days'])).toEqual({ amount: '', unit: 'minutes' })
    expect(exactTiming(Number.POSITIVE_INFINITY, ['hours', 'days'])).toEqual({ amount: '', unit: 'hours' })
    expect(exactTiming(-60, ['minutes', 'hours'])).toEqual({ amount: '', unit: 'minutes' })
    expect(exactTiming(1440, ['minutes', 'hours', 'days'])).toEqual({ amount: '1', unit: 'days' })

    expect(timingError('anniversary_before', Number.NaN)).toBe('時期は525600分（365日）以内で入れてください')
    expect(timingError('anniversary_before', Number.POSITIVE_INFINITY)).toBe('時期は525600分（365日）以内で入れてください')
    expect(timingError('anniversary_before', -60)).toBe('記念日は日単位で入れてください')
  })
})
