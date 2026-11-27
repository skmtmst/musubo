import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommonActionResources, CommonActionStep } from '@/lib/api'
import { stepSummary } from './common-action-summary'

const resources = {
  tags: [{ id: 't1', name: '購入済み' }, { id: '', name: '壊れたタグ' }],
  scenarios: [],
  templates: [{ id: 'm1', name: '購入のお礼' }],
  webhooks: [],
  richMenus: [],
  commonActions: [],
} as unknown as CommonActionResources

describe('stepSummary の不正 params・リソース欠損保護', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('params や resources が欠損・非配列でも落ちずに既定文言を返す', () => {
    const brokenStep = { id: 's1', type: 'add_tag', params: null, onFailure: 'stop' } as unknown as CommonActionStep
    expect(stepSummary(brokenStep, resources)).toBe('タグを選ぶ')
    expect(stepSummary({ id: 's2', type: 'add_tag', params: { tagId: 't1' }, onFailure: 'stop' } as CommonActionStep, {} as CommonActionResources)).toBe('タグを選ぶ')
    expect(stepSummary(null as unknown as CommonActionStep, resources)).toBe('')
  })

  it('set_metadata の values が文字列・配列のとき添字を出さず、send_message の非文字列 content で [object Object] を出さない', () => {
    expect(
      stepSummary({ id: 's3', type: 'set_metadata', params: { values: 'abc' }, onFailure: 'stop' } as CommonActionStep, resources),
    ).toBe('友だち情報を選ぶ')
    expect(
      stepSummary({ id: 's4', type: 'set_metadata', params: { values: ['x', 'y'] }, onFailure: 'stop' } as CommonActionStep, resources),
    ).toBe('友だち情報を選ぶ')
    expect(
      stepSummary({ id: 's5', type: 'set_metadata', params: { values: { rank: 'gold' } }, onFailure: 'stop' } as CommonActionStep, resources),
    ).toBe('友だち情報「rank」')
    expect(
      stepSummary({ id: 's6', type: 'send_message', params: { content: { bad: 1 } }, onFailure: 'stop' } as CommonActionStep, resources),
    ).toBe('送る文を入れる')
  })
})
