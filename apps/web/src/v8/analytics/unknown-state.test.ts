import { describe, expect, it } from 'vitest'
import { METRIC_STATE_TEXT } from './parts'

describe('分析結果の状態', () => {
  it.each(['constructor', 'toString', '__proto__', 'future'])('%s は登録された状態として扱わない', value => {
    expect(METRIC_STATE_TEXT[value as keyof typeof METRIC_STATE_TEXT]).toBeUndefined()
  })
  it('既知の状態は同じ表示を保つ', () => {
    expect(METRIC_STATE_TEXT.pending).toBe('集計を待っています')
  })
})
