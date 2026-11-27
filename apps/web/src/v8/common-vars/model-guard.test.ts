import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommonVar, CommonVarDeleteImpact } from '@line-crm/shared'
import {
  blockedReason,
  canDelete,
  consequenceText,
  filterAndSortCommonVars,
  unavailableText,
  usageText,
} from './model'

function makeImpact(overrides: Partial<CommonVarDeleteImpact> = {}): CommonVarDeleteImpact {
  return {
    variable: { id: 'v1', name: '営業時間', varKey: 'shop_hours' },
    total: 2,
    blockingTotal: 0,
    canDelete: true,
    items: [],
    unavailableReferences: [],
    checkedAt: '2026-11-20T00:00:00Z',
    ...overrides,
  } as unknown as CommonVarDeleteImpact
}

describe('common-vars/model ガード', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('影響件数が NaN・負数のときは件数を捏造せず削除不可（fail-closed）にする', () => {
    const broken = makeImpact({ total: Number.NaN, canDelete: true })
    expect(usageText(broken)).toBe('{{var.shop_hours}} の使用先件数を確認できません。')
    expect(consequenceText(broken)).toBe('削除すると、使用中の場所の {{var.shop_hours}} は空欄のまま送られます。')
    expect(canDelete({ impact: broken, typedKey: '{{var.shop_hours}}', reason: '不要になった', busy: false })).toBe(false)
    expect(blockedReason({ impact: broken, typedKey: '{{var.shop_hours}}', reason: '不要になった' })).toContain('使用先件数を確認できないため削除できません')

    const blockedBroken = makeImpact({ canDelete: false, blockingTotal: Number.NaN })
    expect(blockedReason({ impact: blockedBroken, typedKey: '', reason: '' })).toBe('使用先があるため削除できません。使用先から外してから、もう一度お試しください。')
  })

  it('unavailableReferences の件数が不正または配列でない場合も安全に表示する', () => {
    const brokenCount = makeImpact({
      unavailableReferences: [{ kindLabel: '配信予約', count: -2, reason: '権限外' }] as unknown as CommonVarDeleteImpact['unavailableReferences'],
    })
    expect(unavailableText(brokenCount)).toBe('配信予約（件数を確認できません・権限外）')

    const brokenList = makeImpact({
      unavailableReferences: null as unknown as CommonVarDeleteImpact['unavailableReferences'],
    })
    expect(unavailableText(brokenList)).toBe('一部の使用先を確認できませんでした。')
  })

  it('usageCount が NaN でも並び替えが壊れない', () => {
    const vars = [
      { id: 'a', name: 'A', varKey: 'a', value: '1', folderId: null, usageCount: Number.NaN, updatedAt: '2026-11-01T00:00:00Z', validFrom: null, validUntil: null, nextSchedule: null, state: 'active' },
      { id: 'b', name: 'B', varKey: 'b', value: '2', folderId: null, usageCount: 3, updatedAt: '2026-11-02T00:00:00Z', validFrom: null, validUntil: null, nextSchedule: null, state: 'active' },
      { id: 'c', name: 'C', varKey: 'c', value: '3', folderId: null, usageCount: 1, updatedAt: '2026-11-03T00:00:00Z', validFrom: null, validUntil: null, nextSchedule: null, state: 'active' },
    ] as unknown as CommonVar[]
    const sorted = filterAndSortCommonVars(vars, {
      query: '',
      folderId: '',
      ungroupedValue: '__ungrouped__',
      filter: 'all',
      order: 'usage_desc',
    })
    expect(sorted.map((v) => v.id)).toEqual(['b', 'c', 'a'])
  })
})
