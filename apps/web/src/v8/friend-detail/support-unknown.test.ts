import { describe, expect, it } from 'vitest'
import { SUPPORT_LABELS, SUPPORT_TONES, type SupportStatus } from './support'

describe('友だちの対応状況', () => {
  it.each(['constructor', 'toString', '__proto__', 'future'])('未知の %s は表の項目として扱わない', status => {
    expect(SUPPORT_LABELS[status as SupportStatus]).toBeUndefined()
    expect(SUPPORT_TONES[status as SupportStatus]).toBeUndefined()
  })
  it('既知の表示を保つ', () => {
    expect(SUPPORT_LABELS.unread).toBe('未対応')
    expect(SUPPORT_TONES.unread).toBe('danger')
  })
})
