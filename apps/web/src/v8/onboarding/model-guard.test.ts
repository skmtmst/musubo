import { describe, expect, it } from 'vitest'
import type { SetupAnswer } from '@line-crm/shared'
import { changedAnswers, featureHref, featureName, settingsChanges } from './model'

describe('onboarding/model のキー順非依存比較・プロトタイプ安全参照ガード', () => {
  it('同じ答えでオブジェクトのキー順だけ違うときは変更扱いしない', () => {
    const saved: Record<string, SetupAnswer> = {
      approval: { mode: 'configured', value: 'automatic' },
      reminders: { mode: 'configured', value: true },
    }
    const reordered: Record<string, SetupAnswer> = {
      approval: { value: 'automatic', mode: 'configured' } as SetupAnswer,
      reminders: { value: true, mode: 'configured' } as SetupAnswer,
    }
    expect(changedAnswers(saved, reordered)).toEqual({})
    expect(settingsChanges(saved, reordered)).toEqual([])
  })

  it('Object.prototype のキー名でも関数を返さず安全にフォールバックする', () => {
    expect(featureName('toString')).toBe('toString')
    expect(featureName('constructor')).toBe('constructor')
    expect(featureHref('toString', '/settings')).toBe('/settings')
    expect(settingsChanges(
      { approval: { mode: 'configured', value: 'toString' } },
      { approval: { mode: 'configured', value: 'manual' } },
    )).toEqual(['予約の確定の仕方：お店が承認してから確定する'])
  })
})
