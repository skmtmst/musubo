import { describe, expect, it } from 'vitest'
import type { Scenario } from '@line-crm/shared'
import { startChecklist } from './start-checklist'

const makeScenario = (overrides: Record<string, unknown>) =>
  ({ triggerType: 'friend_add', stepCount: 2, ...overrides }) as unknown as Pick<Scenario, 'triggerType'> & {
    stepCount?: number
  }

describe('startChecklist の異常値ガード', () => {
  it('開始条件が空白だけのときは確認済みにせず warn にする', () => {
    const out = startChecklist(makeScenario({ triggerType: '   ' }))
    expect(out[0].state).toBe('warn')
    expect(out[0].detail).toContain('きっかけが決まっていません')
  })

  it('通数が非数や負数のときは「通が1つもありません」と誤判定せず未取得にする', () => {
    for (const badSteps of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const out = startChecklist(makeScenario({ stepCount: badSteps }))
      expect(out[1].state).toBe('unknown')
      expect(out[1].detail).toBe('—（未取得）通数を確認できませんでした')
    }
  })
})
