// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AutoReplyDryRunResult } from '@line-crm/shared'
import type { FriendListItem } from '@/lib/api'
import type { RuleRow } from './wizard-model'
import { WizardPriorityStep } from './wizard-priority-step'

function makeRule(id: string, name: string): RuleRow {
  return {
    id,
    name,
    isActive: true,
    lifecycleStatus: 'active',
    triggerType: 'keyword',
    keyword: name,
    keywords: [],
    priority: 10,
  } as unknown as RuleRow
}

function makeFriend(id: string, displayName: string): FriendListItem {
  return {
    id,
    displayName,
    pictureUrl: null,
  } as unknown as FriendListItem
}

function baseProps(overrides: Partial<Parameters<typeof WizardPriorityStep>[0]> = {}): Parameters<typeof WizardPriorityStep>[0] {
  const conflictRule = makeRule('rule-1', '先に動くルール')
  const selfRule = makeRule('rule-self', 'この応答')
  return {
    canEdit: true,
    conflictsReadable: true,
    permissionPending: false,
    autoReplyId: 'rule-self',
    conflicts: [{ autoReplyId: 'rule-1', certainty: 'certain' } as unknown as Parameters<typeof WizardPriorityStep>[0]['conflicts'][number]],
    dryRun: null,
    effectiveKeywords: [{ keyword: '予約', matchType: 'contains' } as unknown as Parameters<typeof WizardPriorityStep>[0]['effectiveKeywords'][number]],
    firstConflictAbove: conflictRule,
    friendLoadState: 'ready',
    friendQuery: '',
    friends: [makeFriend('friend-1', '田中 太郎')],
    friendTotal: 10,
    loadPriorityData: vi.fn().mockResolvedValue(undefined),
    matchedAccountId: 'acc-1',
    moveBeforeFirstConflict: vi.fn(),
    moveUp: vi.fn(),
    myIndex: 1,
    myPositionLabel: '上から2番目',
    orderedRules: [conflictRule, selfRule],
    priorityState: 'ready',
    runTest: vi.fn().mockResolvedValue(undefined),
    saving: false,
    searchFriends: vi.fn().mockResolvedValue(undefined),
    selectedFriendId: 'friend-1',
    setFriendQuery: vi.fn(),
    setSelectedFriendId: vi.fn(),
    setTestMessage: vi.fn(),
    testMessage: '予約したい',
    thisRuleName: 'この応答',
    ...overrides,
  }
}

describe('WizardPriorityStep ガード', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  afterEach(() => {
    cleanup()
  })

  it('保存中は「上へ」と「より前へ」の順番変更ボタンが押せない', () => {
    const moveUp = vi.fn()
    const moveBeforeFirstConflict = vi.fn()
    render(<WizardPriorityStep {...baseProps({ saving: true, moveUp, moveBeforeFirstConflict })} />)

    const upButton = screen.getByRole('button', { name: '上へ' }) as HTMLButtonElement
    const beforeButton = screen.getByRole('button', { name: '「先に動くルール」より前へ' }) as HTMLButtonElement

    expect(upButton.disabled).toBe(true)
    expect(beforeButton.disabled).toBe(true)

    fireEvent.click(upButton)
    fireEvent.click(beforeButton)
    expect(moveUp).not.toHaveBeenCalled()
    expect(moveBeforeFirstConflict).not.toHaveBeenCalled()
  })

  it('候補人数が不正な数値のときは件数を捏造せず「確認できません」と出す', () => {
    render(<WizardPriorityStep {...baseProps({ friendTotal: Number.NaN })} />)
    expect(screen.getByText(/候補の人数を確認できません/)).toBeTruthy()
    expect(screen.queryByText(/候補 —人中/)).toBeNull()

    cleanup()
    render(<WizardPriorityStep {...baseProps({ friendTotal: -3 })} />)
    expect(screen.getByText(/候補の人数を確認できません/)).toBeTruthy()
    expect(screen.queryByText(/-3人中/)).toBeNull()
  })

  it('キーワードや試し送信の配列項目が壊れていても落ちずに表示できる', () => {
    const brokenDryRun = {
      draftWon: false,
      winner: { autoReplyId: 'rule-1', name: '先に動くルール' },
      candidates: null,
    } as unknown as AutoReplyDryRunResult

    render(
      <WizardPriorityStep
        {...baseProps({
          effectiveKeywords: [{ keyword: null } as unknown as Parameters<typeof WizardPriorityStep>[0]['effectiveKeywords'][number]],
          dryRun: brokenDryRun,
        })}
      />,
    )

    const input = screen.getByLabelText('届いたメッセージ') as HTMLInputElement
    expect(input.placeholder).toBe('例：予約変更したいです')
    expect(screen.getByText(/当たったルール：「先に動くルール」/)).toBeTruthy()
    expect(screen.queryByText(/見送った理由：/)).toBeNull()
  })
})
