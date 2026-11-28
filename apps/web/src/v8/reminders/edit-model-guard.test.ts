import { describe, expect, it } from 'vitest'
import type { ReminderDraftStep, ReminderValidationResult } from '@line-crm/shared'
import { countLabel, reminderAudienceCounts, stepShortTiming } from './edit-model'

describe('reminders/edit-model の異常値ガード', () => {
  it('対象人数が非数や負数のときは未取得(null)扱いにして合計に NaN を出さない', () => {
    const invalid = {
      audience: { matched: Number.NaN, excluded: -2 },
    } as unknown as ReminderValidationResult
    expect(reminderAudienceCounts(invalid)).toEqual({ matched: null, excluded: null, total: null })

    const valid = {
      audience: { matched: 10, excluded: 3 },
    } as unknown as ReminderValidationResult
    expect(reminderAudienceCounts(valid)).toEqual({ matched: 10, excluded: 3, total: 13 })
  })

  it('countLabel は非数や負数に対して壊れた数値表記を出さない', () => {
    expect(countLabel(Number.NaN, '人')).toBe('—人')
    expect(countLabel(-5, '通')).toBe('—通')
    expect(countLabel(12, '人')).toBe('12 人')
  })

  it('stepShortTiming は空白だけの時刻や非数の日数で壊れた文を返さない', () => {
    const blankTimeStep = {
      offsetDays: -1,
      sendAtTime: '   ',
      offsetMinutes: -60,
    } as unknown as ReminderDraftStep
    const blankResult = stepShortTiming(blankTimeStep, 'time')
    expect(blankResult).not.toContain('1日前  ')

    const nanDayStep = {
      offsetDays: Number.NaN,
      sendAtTime: '18:00',
      offsetMinutes: -60,
    } as unknown as ReminderDraftStep
    const nanResult = stepShortTiming(nanDayStep, 'time')
    expect(nanResult).not.toContain('NaN')
  })
})
