// @vitest-environment happy-dom
/*
 * お知らせの記録：LINE が受け付けた行は「LINEが受け付けました」と書く。
 * 受け付けただけで、届いた・開いたとは言わない。
 */
import React from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
  usePathname: () => '/line-notifications',
}))
const fixture = vi.hoisted(() => ({ status: 'future' }))
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  const page = {
    success: true,
    data: {
      items: [{
        id: 'r1', recipientType: 'customer', notificationName: '見本の通知', source: 'other', sourceEventId: 'e', friendId: 'f', friendName: '見本',
        orderNumber: null, channel: 'line', status: fixture.status, reason: null, receivedAt: '2026-10-01T00:00:00Z', acceptedAt: '2026-10-01T00:00:05Z', attemptCount: 1,
        retryAvailable: false, nextRetryAt: null, clickedAt: null, version: 1, executionMode: 'automatic',
      }],
      summary: { accepted: 1 },
      coverage: { source: 'notification_delivery_ledger' },
    },
    pagination: { total: 1, limit: 20, offset: 0 },
  }
  return {
    ...actual,
    api: {
      ...actual.api,
      staff: { ...actual.api.staff, me: async () => ({ success: true, data: { role: 'owner' } }) },
      lineNotifications: { ...actual.api.lineNotifications, deliveries: async () => page, notificationRuns: async () => page },
      ecCommerce: { ...actual.api.ecCommerce, notificationRuns: async () => page },
    },
  }
})

import RunsTab from './runs-tab'
afterEach(cleanup)

test.each(['future', 'toString', 'constructor', '__proto__'])('未知の通知状態 %s を一覧と詳細で示す', async status => {
  fixture.status = status
  render(<RunsTab lineAccountId="acc" mode="history" />)
  const row = (await screen.findByRole('button', { name: '見本の通知' })).closest('tr')!
  expect(within(row).getByText('状態不明')).toBeTruthy()
  fireEvent.click(within(row).getByRole('button', { name: '見本の通知' }))
  const dialog = await screen.findByRole('dialog', { name: '記録の詳細' })
  expect(within(dialog).getByText(/状態：状態不明/)).toBeTruthy()
})
