import { describe, expect, it } from 'vitest'
import { friendNamesOf, nextWeeklyRunText, normalizeFriendIds, normalizeWeekdays, weekdayNames } from './trigger-helpers'

describe('automations/create/trigger-helpers ガード', () => {
  it('重複・非整数・指数表記の曜日を安全に正規化し、重複曜日名を繰り返さない', () => {
    expect(normalizeWeekdays(['1', '1.0', '2e0', '3'])).toEqual([1, 3])
    expect(weekdayNames([1, 1, 3, 9, Number.NaN])).toBe('月・水')
    expect(weekdayNames(null as unknown as number[])).toBe('')
  })

  it('非文字列の友だちIDや null の triggerConfig・プロトタイプキーで壊れない', () => {
    expect(normalizeFriendIds([{ bad: true }, ' f-1 ', 'f-1', ''])).toEqual(['f-1'])
    expect(friendNamesOf(null as unknown as Record<string, unknown>)).toEqual({})
    expect(
      friendNamesOf({
        friendNames: {
          'f-1': '山田',
          constructor: 'bad',
        },
      }),
    ).toEqual({ 'f-1': '山田' })
    expect(nextWeeklyRunText(null as unknown as number[], '09:00')).toBeNull()
    expect(nextWeeklyRunText([1], null as unknown as string)).toBeNull()
  })
})
