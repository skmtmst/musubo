// @vitest-environment happy-dom
/*
 * R180: 独自マーク1件・使用0人でも置換先なしで保管できる。
 * 以前は置き換え先が必須で候補が空のまま保管実行を押せなかった。
 * 候補なし・0人の保管窓で「保管する」が押せ、置換先なしで送られる。
 */
import React from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'

const mockState = vi.hoisted(() => ({
  archivePayload: null as Record<string, unknown> | null,
}))

const mark = {
  id: 'mark-solo',
  name: '独自マーク',
  color: '#3B82F6',
  isDefault: false,
  autoOnInbound: false,
  displayOrder: 0,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  version: 1,
  isInherited: false,
  automationRules: [],
  friendCount: 0,
}

vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: {
    supportMarks: {
      list: () => Promise.resolve({ success: true, data: [mark] }),
      reorder: () => Promise.resolve({ success: true, data: null }),
      archiveImpact: () => Promise.resolve({
        success: true,
        data: {
          mark,
          friendCount: 0,
          usedIn: { broadcasts: 0, scenarios: 0, autoReplies: 0, savedSearches: 0, automations: 0 },
          automationRules: [],
          displayTargets: [],
          replacementOptions: [],
          canArchive: true,
          impactRevision: 'mark-solo:1:0:0:0:0:0:0',
          checkedAt: '2026-09-27T00:00:00+09:00',
          expectedVersion: 1,
        },
      }),
      archive: (_id: string, _account: string, data: Record<string, unknown>) => {
        mockState.archivePayload = data
        return Promise.resolve({ success: true, data: { archived: true, replacedFriendCount: 0, replacementMark: null } })
      },
    },
    listStats: {
      get: () => Promise.resolve({ success: true, data: { marks: { unanswered: 0, inProgress: 0, resolved: 0, changedLast7: 0 } } }),
    },
  },
}))

vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) =>
    React.createElement('a', { href, ...rest }, children),
}))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'a1', selectedAccount: { id: 'a1', name: '店舗A' } }),
}))

beforeEach(() => {
  mockState.archivePayload = null
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('R180 独自マークの保管（使用0人）', () => {
  test('候補なしでも「保管する」が押せ、置換先なしで送られる', async () => {
    const { default: SupportMarkList } = await import('@/v8/tags/marks-tab')
    render(<SupportMarkList accountId="a1" canEdit />)
    // 表とスマホカードの両方に同じ行が出る。表側で操作する。
    const table = await screen.findByRole('table')
    within(table).getByText('独自マーク')

    // 行の「…」から保管を開く。
    await act(async () => {
      fireEvent.click(within(table).getByRole('button', { name: '対応マーク「独自マーク」の操作' }))
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: '保管する' }))
    })

    const dialog = await screen.findByRole('alertdialog', { name: '「独自マーク」を保管しますか' })
    expect(dialog.textContent).toContain('そのまま保管できます')
    expect(dialog.textContent).not.toContain('対応マークが未設定へ戻ります')
    // 置き換え先の選択欄は出ない（0人には要らない）。
    expect(dialog.textContent).not.toContain('置き換え先')

    const confirm = screen.getByRole('button', { name: '保管する' })
    expect(confirm.hasAttribute('disabled')).toBe(false)
    await act(async () => {
      fireEvent.click(confirm)
    })
    expect(mockState.archivePayload).not.toBeNull()
    expect(mockState.archivePayload?.replacementMarkId).toBeNull()
  })
})
