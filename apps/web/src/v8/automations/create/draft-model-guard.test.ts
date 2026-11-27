import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AutomationDraftDetail } from '@/lib/api'
import {
  blankFormSnapshot,
  canonicalJson,
  draftDetailToForm,
  formatClock,
  formSnapshotHasContent,
  normalizeTriggerConfigFor,
} from './draft-model'

describe('automations/create/draft-model ガード', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('datetime の入力が不正な日時文字列でも RangeError で落ちず元の値を保って返す', () => {
    const out = normalizeTriggerConfigFor('datetime', { at: '2026-99-99T99:99', friendIds: ['f1'] }, '')
    expect(out.at).toBe('2026-99-99T99:99')
    expect(out.friendIds).toEqual(['f1'])

    const valid = normalizeTriggerConfigFor('datetime', { at: '2026-12-01T10:30', friendIds: [] }, '')
    expect(valid.at).toBe('2026-12-01T01:30:00.000Z')
  })

  it('canonicalJson は循環参照や BigInt を含んでも落ちずに文字列化する', () => {
    const cyclic: Record<string, unknown> = { count: BigInt(42) }
    cyclic.self = cyclic
    const result = canonicalJson(cyclic)
    expect(result).toContain('"count":"42"')
    expect(result).toContain('"self":"[Circular]"')
  })

  it('draftDetailToForm は保存済みの actions や triggerConfig が壊れていたら黙って置き換えず例外で止める', () => {
    const brokenActions = {
      id: 'd1',
      name: '見本',
      eventType: 'message_received',
      triggerConfig: {},
      conditions: null,
      actions: null,
    } as unknown as AutomationDraftDetail
    expect(() => draftDetailToForm(brokenActions)).toThrow()

    const brokenTrigger = {
      id: 'd1',
      name: '見本',
      eventType: 'message_received',
      triggerConfig: ['unexpected'],
      conditions: null,
      actions: [],
    } as unknown as AutomationDraftDetail
    expect(() => draftDetailToForm(brokenTrigger)).toThrow()

    expect(formatClock(Number.NaN)).toBe('—')
    expect(formatClock(Number.POSITIVE_INFINITY)).toBe('—')

    const brokenSnap = {
      ...blankFormSnapshot(),
      triggerConfig: null,
      actions: null,
    } as unknown as ReturnType<typeof blankFormSnapshot>
    expect(formSnapshotHasContent(brokenSnap)).toBe(false)
  })
})
