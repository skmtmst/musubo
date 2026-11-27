// @vitest-environment happy-dom
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), useSearchParams: () => new URLSearchParams(''), usePathname: () => '/line-notifications' }))
vi.mock('@/lib/api', async original => {
  const actual = await original<typeof import('@/lib/api')>()
  const page = async () => ({ success: true, data: { items: [{ id: 'r1', recipientType: 'customer', notificationName: 'テスト通知', source: 'ec', sourceEventId: 'e', friendId: 'f', friendName: '田中', orderNumber: 'A-1', channel: 'line', status: 'failed', reason: 'ブロック', receivedAt: '2026-10-01T00:00:00Z', acceptedAt: null, attemptCount: 1, retryAvailable: false, recordVersion: 7, nextRetryAt: null, clickedAt: null, version: 1, executionMode: 'automatic' }], summary: { failed: 1 }, coverage: { source: 'notification_delivery_ledger' } }, pagination: { total: 1, limit: 20, offset: 0 } })
  return { ...actual, api: { ...actual.api, staff: { ...actual.api.staff, me: async () => ({ success: true, data: { role: 'owner' } }) }, lineNotifications: { ...actual.api.lineNotifications, deliveries: page, notificationRuns: page }, ecCommerce: { ...actual.api.ecCommerce, notificationRuns: page } } }
})
import RunsTab from '@/v8/settings/line-notifications/runs-tab'
afterEach(cleanup)

it('送れなかった記録では個人の既読が見られないと案内する', async () => {
  render(<RunsTab lineAccountId="acc" mode="failures" />)
  await screen.findByTitle('田中')
  expect(screen.getByText(/個人の既読は見られません/)).toBeTruthy()
})
