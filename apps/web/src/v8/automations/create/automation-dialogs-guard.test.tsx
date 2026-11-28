// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AutomationDialogs } from './automation-dialogs'

beforeEach(() => {
  vi.resetAllMocks()
})

afterEach(() => {
  cleanup()
})

function baseProps(over: Partial<Parameters<typeof AutomationDialogs>[0]> = {}): Parameters<typeof AutomationDialogs>[0] {
  return {
    conditionOpen: false,
    setConditionOpen: vi.fn(),
    condition: null,
    setCondition: vi.fn(),
    activateConfirmOpen: false,
    saving: false,
    setActivateConfirmOpen: vi.fn(),
    save: vi.fn().mockResolvedValue(true),
    error: '',
    name: 'テストルール',
    selectedEvent: { value: 'friend_add', label: '友だち追加', note: '' },
    triggerConfigSummary: '指定なし',
    targetSummary: '全員',
    previewCount: 10,
    actionSummary: 'タグを付ける',
    eventType: 'friend_add',
    compareOpen: false,
    conflict: null,
    setCompareOpen: vi.fn(),
    leaveTarget: null,
    leaveBusy: false,
    confirmLeave: vi.fn(),
    cancelLeave: vi.fn(),
    ...over,
  }
}

describe('automations/create/automation-dialogs ガード', () => {
  it('見込み人数や保存済みの処理件数が負数・NaN でも壊れた件数表示を出さない', () => {
    const { rerender } = render(
      <AutomationDialogs
        {...baseProps({
          activateConfirmOpen: true,
          previewCount: -3,
        })}
      />,
    )
    expect(screen.queryByText(/見込み -3 人/)).toBeNull()
    expect(screen.queryByText(/見込み — 人/)).toBeNull()

    rerender(
      <AutomationDialogs
        {...baseProps({
          compareOpen: true,
          conflict: {
            draftId: 'd1',
            serverVersionId: 'v2',
            serverName: '別の変更',
            serverEventLabel: '友だち追加',
            serverActionCount: -1,
          },
        })}
      />,
    )
    expect(screen.queryByText(/処理 -1 件/)).toBeNull()
    expect(screen.getByText('処理件数を確認できません')).toBeTruthy()
  })

  it('保存中（saving=true）は比較確認ダイアログのキャンセル・保存を再実行しない', () => {
    const save = vi.fn().mockResolvedValue(true)
    const setCompareOpen = vi.fn()
    render(
      <AutomationDialogs
        {...baseProps({
          compareOpen: true,
          saving: true,
          save,
          setCompareOpen,
          conflict: {
            draftId: 'd1',
            serverVersionId: 'v2',
            serverName: '別の変更',
            serverEventLabel: '友だち追加',
            serverActionCount: 2,
          },
        })}
      />,
    )
    const closeButtons = screen.getAllByRole('button', { name: '閉じる' })
    expect(closeButtons.length).toBeGreaterThan(0)
    for (const btn of closeButtons) fireEvent.click(btn)
    expect(setCompareOpen).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
  })
})
