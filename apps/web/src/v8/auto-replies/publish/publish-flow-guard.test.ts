import { describe, expect, it } from 'vitest'
import type { AutoReplyConflict, AutoReplyDryRunResult, AutoReplyValidationResult } from '@line-crm/shared'
import { canPublish, conflictTone, publishGates } from './publish-flow'

describe('auto-replies/publish/publish-flow ガード', () => {
  it('validation の conflicts や errors が非配列・欠損・壊れた要素を含む時は ok にせず公開を止める', () => {
    const missingConflicts = {
      errors: [],
      conflicts: null,
    } as unknown as AutoReplyValidationResult
    const dryRun = { draftWon: true, winner: null } as unknown as AutoReplyDryRunResult

    const gates1 = publishGates(missingConflicts, dryRun, new Set())
    expect(gates1[3]).toMatchObject({ state: 'unknown' })
    expect(canPublish(gates1)).toBe(false)

    const malformedConflictItem = {
      errors: [],
      conflicts: [null],
    } as unknown as AutoReplyValidationResult
    const gates2 = publishGates(malformedConflictItem, dryRun, new Set())
    expect(gates2[3]).toMatchObject({ state: 'unknown' })
    expect(canPublish(gates2)).toBe(false)

    const missingErrors = {
      errors: null,
      conflicts: [],
    } as unknown as AutoReplyValidationResult
    const gates3 = publishGates(missingErrors, dryRun, new Set())
    expect(gates3[0]).toMatchObject({ state: 'unknown' })
    expect(gates3[1]).toMatchObject({ state: 'unknown' })
    expect(canPublish(gates3)).toBe(false)
  })

  it('dryRun.draftWon が真偽値以外、または conflict の勝者情報が欠損した時も安全側へ倒す', () => {
    const validValidation = { errors: [], conflicts: [] } as unknown as AutoReplyValidationResult
    const brokenDryRun = { draftWon: 'false', winner: null } as unknown as AutoReplyDryRunResult
    const gates = publishGates(validValidation, brokenDryRun, new Set())
    expect(gates[2]).toMatchObject({ state: 'unknown' })
    expect(canPublish(gates)).toBe(false)

    expect(canPublish(null as unknown as ReturnType<typeof publishGates>)).toBe(false)
    expect(conflictTone({ certainty: 'possible', winnerAutoReplyId: '' } as unknown as AutoReplyConflict, '').losing).toBe(true)
  })
})
