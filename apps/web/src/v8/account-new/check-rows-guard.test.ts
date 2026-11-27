import { describe, expect, it } from 'vitest'
import { latestFollowerImportState, nextCursor, type V06CheckRow } from './check-rows'

describe('account-new/check-rows 不正カーソル・未知フェーズ・NaN件数の防御', () => {
  it('nextCursor は負数や NaN・小数カーソルでも例外を投げず null を返す', () => {
    const rows: V06CheckRow[] = [
      { key: 'channel', title: '接続', detail: 'ok', phase: 'ok' },
    ]
    expect(nextCursor(rows, -1)).toBeNull()
    expect(nextCursor(rows, Number.NaN)).toBeNull()
    expect(nextCursor(rows, 0.5)).toBeNull()
    expect(nextCursor(rows, 0)).toBe(1)
  })

  it('latestFollowerImportState は未知フェーズや NaN/負の件数で現在の正常状態を上書きしない', () => {
    const current = {
      phase: 'hydrating_profiles' as const,
      received: 120,
      profilesProcessed: 80,
      profilesUpdated: 75,
    }

    const withUnknownPhase = latestFollowerImportState(current, {
      ...current,
      phase: 'unknown_phase' as typeof current.phase,
    })
    expect(withUnknownPhase).toBe(current)

    const withNaN = latestFollowerImportState(current, {
      ...current,
      received: Number.NaN,
    })
    expect(withNaN).toBe(current)

    const withNegative = latestFollowerImportState(current, {
      ...current,
      profilesProcessed: -5,
    })
    expect(withNegative).toBe(current)

    const validNext = latestFollowerImportState(current, {
      phase: 'completed' as const,
      received: 120,
      profilesProcessed: 120,
      profilesUpdated: 118,
    })
    expect(validNext.phase).toBe('completed')
  })
})
