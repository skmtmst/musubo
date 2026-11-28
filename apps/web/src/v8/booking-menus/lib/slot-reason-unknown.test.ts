import { describe, expect, it } from 'vitest'
import { slotReasonLabel } from './slot-reason'

describe('予約できない理由', () => {
  it.each(['constructor', 'toString', '__proto__', 'future'])('%s を安全に表示する', reason => {
    expect(slotReasonLabel(reason as Parameters<typeof slotReasonLabel>[0])).toBe('この日時は受け付けられません')
  })
  it('既知の理由は前と同じ表示を保つ', () => {
    expect(slotReasonLabel('google_busy')).toBe('外部カレンダーの予定と重なっています')
  })
})
