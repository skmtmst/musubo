// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const listMock = vi.hoisted(() => vi.fn())
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/line-notifications',
  useSearchParams: () => new URLSearchParams('tab=operator'),
}))
vi.mock('@/lib/api', async (original) => {
  const actual = await original<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, lineNotifications: { ...actual.api.lineNotifications, operatorRules: { ...actual.api.lineNotifications.operatorRules, list: listMock } } } }
})
import { flushListUrlState } from '@/components/shared/list-url-state'
import OperatorTab from '@/v8/settings/line-notifications/operator-tab'

beforeEach(() => {
  window.history.replaceState(null, '', '/line-notifications?tab=operator')
  flushListUrlState()
  listMock.mockReset().mockResolvedValue({ success: true, data: {
    items: [
      { id: 'a', name: '注文のお知らせ', eventType: 'ec.order.paid', status: 'published', recipientCount: 1, occurredToday: 0, conditions: {} },
      { id: 'b', name: '予約のお知らせ', eventType: 'booking.created', status: 'published', recipientCount: 1, occurredToday: 0, conditions: {} },
    ],
    summary: { total: 2, published: 2, stopped: 0, missingRecipients: 0, recipients: 2, acceptedToday: 0, excludedToday: 0 },
  } })
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

it('運用者のお知らせを名前で探し、検索を消すと一覧に戻る', async () => {
  render(<OperatorTab lineAccountId="acc-1" canManage exportOpen={false} onExportClose={() => {}} />)
  await screen.findByText('注文のお知らせ')
  expect(screen.getByText('予約のお知らせ')).toBeTruthy()
  const search = screen.getByRole('searchbox', { name: 'お知らせを検索' })
  fireEvent.change(search, { target: { value: '注文' } })
  expect(screen.getByText('注文のお知らせ')).toBeTruthy()
  await waitFor(() => expect(screen.queryByText('予約のお知らせ')).toBeNull())
  fireEvent.change(search, { target: { value: '' } })
  await screen.findByText('予約のお知らせ')
  expect(listMock).toHaveBeenCalledWith('acc-1')
})
