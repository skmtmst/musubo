// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const listMock = vi.hoisted(() => vi.fn())

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/line-notifications',
  useSearchParams: () => new URLSearchParams('tab=operator'),
}))
vi.mock('@/lib/api', async (original) => {
  const actual = await original<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      lineNotifications: {
        ...actual.api.lineNotifications,
        operatorRules: {
          ...actual.api.lineNotifications.operatorRules,
          list: listMock,
        },
      },
    },
  }
})

import { flushListUrlState } from '@/components/shared/list-url-state'
import { ApiError } from '@/lib/api'
import OperatorTab from './operator-tab'

const SAMPLE_RULE = {
  id: 'op-1',
  name: '大口注文のお知らせ',
  eventType: 'ec.order.paid',
  status: 'published',
  recipientCount: 3,
  occurredToday: 2,
  conditions: { recipientLabel: '店長・出荷担当', scheduleLabel: 'いつでも', importance: 'important' },
}

const SAMPLE_SUMMARY = {
  total: 1,
  published: 1,
  stopped: 0,
  missingRecipients: 0,
  recipients: 3,
  acceptedToday: 2,
  excludedToday: 0,
}

beforeEach(() => {
  window.history.replaceState(null, '', '/line-notifications?tab=operator')
  flushListUrlState()
  listMock.mockReset().mockResolvedValue({
    success: true,
    data: { items: [SAMPLE_RULE], summary: SAMPLE_SUMMARY },
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('運用者へのお知らせタブの読み込み・失敗・権限・アカウント切替', () => {
  it('読み込み中は4つのKPIカードすべてに「読み込んでいます」を表示する', () => {
    listMock.mockReturnValueOnce(new Promise(() => {}))
    const { container } = render(
      <OperatorTab lineAccountId="acc-1" canManage exportOpen={false} onExportClose={() => {}} />,
    )
    const cards = [...container.querySelectorAll('[data-design="KPIs"] [data-kpi-presentation="band"]')]
    expect(cards).toHaveLength(4)
    expect(cards.every((card) => card.getAttribute('aria-busy') === 'true')).toBe(true)
    expect(cards.every((card) => (card.textContent ?? '').includes('読み込んでいます'))).toBe(true)
  })

  it('取得失敗時は4つのKPIカードすべてに「読み込めませんでした」を表示し、再読み込みで回復できる', async () => {
    listMock.mockRejectedValueOnce(new Error('down'))
    const { container } = render(
      <OperatorTab lineAccountId="acc-1" canManage exportOpen={false} onExportClose={() => {}} />,
    )
    await screen.findByText(/運用者へのお知らせを(表示|読み込め)ませんでした/)

    const cards = [...container.querySelectorAll('[data-design="KPIs"] [data-kpi-presentation="band"]')]
    expect(cards).toHaveLength(4)
    expect(cards.every((card) => (card.textContent ?? '').includes('読み込めませんでした'))).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
    await screen.findByText('大口注文のお知らせ')
    expect(listMock).toHaveBeenCalledTimes(2)
  })

  it('権限不足時は4つのKPIカードすべてに「権限がありません」を表示する', async () => {
    listMock.mockRejectedValueOnce(new ApiError(403, 'forbidden'))
    const { container } = render(
      <OperatorTab lineAccountId="acc-1" canManage exportOpen={false} onExportClose={() => {}} />,
    )
    await waitFor(() => {
      const cards = [...container.querySelectorAll('[data-design="KPIs"] [data-kpi-presentation="band"]')]
      expect(cards).toHaveLength(4)
      expect(cards.every((card) => (card.textContent ?? '').includes('権限がありません'))).toBe(true)
    })
  })

  it('アカウントを切り替えた後に古いアカウントの遅い応答が届いても上書きしない', async () => {
    let resolveOld!: (value: { success: true; data: { items: typeof SAMPLE_RULE[]; summary: typeof SAMPLE_SUMMARY } }) => void
    listMock.mockImplementation((accountId: string) => {
      if (accountId === 'acc-1') {
        return new Promise((resolve) => { resolveOld = resolve })
      }
      return Promise.resolve({
        success: true,
        data: { items: [{ ...SAMPLE_RULE, id: 'op-2', name: '新アカウントのお知らせ' }], summary: SAMPLE_SUMMARY },
      })
    })

    const view = render(<OperatorTab lineAccountId="acc-1" canManage exportOpen={false} onExportClose={() => {}} />)
    view.rerender(<OperatorTab lineAccountId="acc-2" canManage exportOpen={false} onExportClose={() => {}} />)
    await screen.findByText('新アカウントのお知らせ')

    await act(async () => {
      resolveOld({ success: true, data: { items: [{ ...SAMPLE_RULE, id: 'op-old', name: '古いアカウントのお知らせ' }], summary: SAMPLE_SUMMARY } })
    })
    expect(screen.queryByText('古いアカウントのお知らせ')).toBeNull()
    expect(screen.getByText('新アカウントのお知らせ')).toBeTruthy()
  })
})
