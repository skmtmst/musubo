import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  precheckBlocked,
  precheckNext,
  precheckStateLabel,
  precheckSummary,
  readPrecheckAnswers,
  type PrecheckAnswers,
  type PrecheckAt,
} from './precheck'

describe('account-new/precheck の未知キー・プロトタイプ鍵保護', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('未知の質問キーで「質問 0」を出さず、次遷移も null で止める', () => {
    expect(precheckStateLabel('q3' as unknown as PrecheckAt)).toBe('')
    expect(precheckNext('q3' as unknown as PrecheckAt, { q3: 'yes' } as unknown as PrecheckAnswers)).toBeNull()
    expect(precheckBlocked('q2', { q2: 'yes' }, null as unknown as Record<string, boolean>)).toBe(true)
    expect(readPrecheckAnswers(['yes'])).toEqual({})
  })

  it('precheckSummary は toString などのプロトタイプ鍵や未知の答えを行として出さない', () => {
    const rows = precheckSummary('done', {
      q1: 'toString' as unknown as PrecheckAnswers['q1'],
      q2: 'yes',
      q4: 'unknown' as unknown as PrecheckAnswers['q4'],
    })
    expect(rows).toEqual([{ key: 'q2', label: 'Q2. 友だちの引き継ぎ', value: 'はい、引き継ぎます' }])
  })
})
