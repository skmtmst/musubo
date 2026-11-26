// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ list: vi.fn(), save: vi.fn(), history: vi.fn() }))
vi.mock('@/lib/api/helpers/friend-delivery-consents', () => ({
  friendDeliveryConsentsApi: api,
  friendDeliveryConsentHistoryApi: { list: api.history },
}))

const { default: Drawer } = await import('./delivery-consent')

const ROWS = [
  {
    purpose: 'marketing',
    state: 'revoked',
    reason: '本人の操作',
    source: 'liff',
    updatedBy: null,
    updatedAt: '2026-10-12T05:05:00.000Z',
    version: 3,
  },
]

const HISTORY_OK = {
  success: true as const,
  data: {
    total: 1,
    nextCursor: null,
    items: [
      {
        id: 1,
        purpose: 'marketing',
        operation: 'update',
        before: { state: 'granted', reason: '', source: 'manual', updatedBy: null, updatedAt: '', version: 2 },
        after: { state: 'revoked', reason: '本人の操作', source: 'liff', updatedBy: null, updatedAt: '', version: 3 },
        actor: { kind: 'self', id: null },
        reason: '本人の操作',
        createdAt: '2026-10-12T05:05:00.000Z',
      },
    ],
  },
}

beforeEach(() => {
  api.history.mockReset()
})

afterEach(() => {
  cleanup()
})

describe('DeliveryConsentDrawer の履歴読み込み失敗時再読み込み', () => {
  it('履歴の取得に失敗したら危険帯と再読み込みボタンを出し、押すとその場で履歴を表示できる', async () => {
    api.history
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(HISTORY_OK)

    render(
      <Drawer
        open
        friendId="f1"
        friendName="見本 143"
        rows={ROWS as never}
        canEdit
        onClose={() => {}}
        onSaved={() => {}}
      />,
    )

    const historySection = screen.getByRole('region', { name: '履歴' })
    await within(historySection).findByText(/履歴を読み込めませんでした/)
    const retry = within(historySection).getByRole('button', { name: 'もう一度読み込む' })
    fireEvent.click(retry)

    expect(await within(historySection).findByText('受け取る → 止めている')).toBeTruthy()
    expect(within(historySection).queryByText(/履歴を読み込めませんでした/)).toBeNull()
    expect(api.history).toHaveBeenCalledTimes(2)
  })
})
