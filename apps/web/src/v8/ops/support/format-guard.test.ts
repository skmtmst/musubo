import { describe, expect, it } from 'vitest'
import { compareLabel, elapsedLabel } from './format'

describe('ops/support/format の非数・異常値ガード', () => {
  it('今月または先月の値が非数・無限大・不正な負の基準時間のときは記録なしへフォールバックする', () => {
    expect(compareLabel(Number.NaN, 100, 'time')).toBe('今月の記録なし')
    expect(compareLabel(Number.POSITIVE_INFINITY, 80, 'rate')).toBe('今月の記録なし')
    expect(compareLabel(50, Number.NaN, 'rate')).toBe('先月の記録なし')
    expect(compareLabel(50, -10, 'time')).toBe('先月の記録なし')
    expect(compareLabel(80, 100, 'time')).toBe('先月より 20% 早い')
  })

  it('経過時間の基準時刻が非数なら壊れた表記を出さず「—」を返す', () => {
    expect(elapsedLabel('2026-11-27T00:00:00Z', Number.NaN)).toBe('—')
  })
})
