import { beforeEach, describe, expect, it, vi } from 'vitest'
import { formatDateTime, formatTime } from '@/lib/format'
import { formatJpDateTime, formatJpSlotRange } from './edit-format'

describe('events/edit-format の SQLite UTC 統一と年跨ぎ判定', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('オフセットなし SQLite UTC 文字列を端末タイムゾーンに依存せず ISO UTC と同じ日本時間で出す', () => {
    expect(formatJpDateTime('2026-06-30 16:00:00')).toBe(formatDateTime('2026-06-30T16:00:00Z'))
    expect(formatJpSlotRange('2026-06-30 16:00:00', '2026-06-30 17:30:00')).toBe(
      `${formatDateTime('2026-06-30T16:00:00Z')} 〜 ${formatTime('2026-06-30T17:30:00Z')}`,
    )
  })

  it('日跨ぎ・不正時刻のときは終了側を時刻だけに省略しない', () => {
    expect(formatJpSlotRange('2026-09-20T14:30:00Z', '2026-09-20T16:00:00Z')).toBe(
      `${formatDateTime('2026-09-20T14:30:00Z')} 〜 ${formatDateTime('2026-09-20T16:00:00Z')}`,
    )
    expect(formatJpSlotRange('bad-start', 'bad-end')).toBe('— 〜 —')
  })
})
