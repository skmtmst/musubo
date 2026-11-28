import { beforeEach, describe, expect, it, vi } from 'vitest'
import { formatHourMinute, usageTone, utcToJstLocalInput } from './edit-model'

describe('common-vars-edit/edit-model の SQLite UTC 統一と異常値保護', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('オフセットなし SQLite UTC 文字列を端末タイムゾーンによらず日本時間の入力値・時刻へ変換する', () => {
    expect(utcToJstLocalInput('2026-06-30 16:05:00')).toBe('2026-07-01T01:05')
    expect(utcToJstLocalInput('2026-06-30T16:05:00Z')).toBe('2026-07-01T01:05')
    expect(formatHourMinute('2026-06-30 16:05:00')).toBe('01:05')
    expect(formatHourMinute('2026-06-30T16:05:00Z')).toBe('01:05')
  })

  it('4桁年を超える極端な日付や非文字列で壊れた文字列を返さない', () => {
    expect(utcToJstLocalInput('+010000-01-01T00:00:00Z')).toBe('')
    expect(utcToJstLocalInput(null)).toBe('')
    expect(formatHourMinute('invalid')).toBeNull()
    expect(usageTone(null as unknown as string)).toBe('info')
  })
})
