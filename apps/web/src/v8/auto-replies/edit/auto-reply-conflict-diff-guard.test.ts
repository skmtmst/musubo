import { beforeEach, describe, expect, it, vi } from 'vitest'
import { describeAutoReplyDiff } from './auto-reply-conflict-diff'
import type { WizardForm } from './wizard-model'

function makeForm(overrides: Partial<WizardForm> = {}): WizardForm {
  return {
    ruleName: '営業時間外',
    folderId: '',
    internalMemo: '',
    respondToAll: false,
    keywordRules: [{ keyword: '予約', matchType: 'contains', minLength: '', caseSensitive: true }],
    keywordMatchMode: 'any',
    matchType: 'contains',
    messageKinds: ['text'],
    weekdays: [1, 2, 3, 4, 5],
    holidayRule: 'ignore',
    timeMode: 'always',
    activeFrom: '',
    activeUntil: '',
    friendTarget: 'all',
    friendConditions: null,
    mode: 'inline-text',
    templateId: null,
    responseContent: '承りました',
    actions: [],
    replyDelaySeconds: '0',
    cooldownOn: false,
    cooldownMinutes: '60',
    skipWhenOperatorActive: false,
    oncePerFriend: false,
    unmatchedMode: 'none',
    receiveSources: ['line'],
    priority: 0,
    ...overrides,
  }
}

describe('auto-reply-conflict-diff のキー順独立・循環参照・NaN 保護', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('friendConditions のプロパティ順が異なるだけでも偽の差分を出さない', () => {
    const mine = makeForm({
      friendConditions: { operator: 'AND', rules: [{ type: 'tag_exists', value: 't1' }] },
      priority: Number.NaN,
    })
    const incoming = makeForm({
      friendConditions: { rules: [{ value: 't1', type: 'tag_exists' }], operator: 'AND' },
      priority: Number.NaN,
    })
    expect(describeAutoReplyDiff(mine, incoming)).toEqual([])
  })

  it('循環参照を含む条件オブジェクトでも例外を投げず比較できる', () => {
    const cycA: Record<string, unknown> = { operator: 'AND' }
    cycA.self = cycA
    const cycB: Record<string, unknown> = { operator: 'AND' }
    cycB.self = cycB
    expect(describeAutoReplyDiff(makeForm({ friendConditions: cycA }), makeForm({ friendConditions: cycB }))).toEqual([])
  })
})
