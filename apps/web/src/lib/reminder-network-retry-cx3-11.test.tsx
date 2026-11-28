// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import RemindersPage from '@/app/reminders/page'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }), usePathname: () => '/reminders', useSearchParams: () => new URLSearchParams() }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'account-a', selectedAccount: null, loading: false }) }))
const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } })
let reminderCalls = 0
beforeEach(() => {
  reminderCalls = 0
  window.history.replaceState(null, '', '/reminders')
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (url.pathname === '/api/reminders') {
      reminderCalls += 1
      if (reminderCalls === 1) throw new Error('network offline')
      return json({ success: true, data: { items: [], total: 0, limit: 20 } })
    }
    if (url.pathname === '/api/staff/me') return json({ success: true, data: { role: 'admin' } })
    if (url.pathname === '/api/folders') return json({ success: true, data: [], unfiledCount: 0 })
    if (url.pathname === '/api/list-stats') return json({ success: true, data: { reminders: { total: 0, active: 0, waiting: 0, sentThisMonth: 0, failed: 0 } } })
    return json({ success: true, data: {} })
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('通信が切れた後、読み直して0件なら空の案内に切り替える', async () => {
  render(<RemindersPage />)
  await screen.findByText('リマインダを読み込めませんでした')
  expect(screen.queryByText('まだリマインダがありません')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: /もう一度/ }))
  await screen.findByText('まだリマインダがありません')
  await waitFor(() => expect(screen.queryByText('リマインダを読み込めませんでした')).toBeNull())
  expect(reminderCalls).toBe(2)
})
