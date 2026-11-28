import { describe, expect, it } from 'vitest'
import { displayRange } from './display-range'
import { hoursText } from '@/v8/restaurant/google/hours-model'

describe('時刻・日付の範囲', () => {
  it('ダッシュの左右に半角空白を入れる', () => {
    expect(displayRange('10月1日', '10月3日')).toBe('10月1日 – 10月3日')
    expect(displayRange('17:00', '翌0:00')).toBe('17:00 – 翌0:00')
  })
  it('翌日をまたぐ営業時間も同じ表記にする', () => {
    expect(hoursText([{ open: '17:00', close: '00:00' }])).toBe('17:00 – 翌0:00')
    expect(hoursText([{ open: '22:00', close: '02:00' }])).toBe('22:00 – 翌02:00')
    expect(hoursText([])).toBe('休業')
  })
})
