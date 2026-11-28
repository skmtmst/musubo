// @vitest-environment happy-dom
import React, { act } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import RemindersPage from '@/app/reminders/page'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }), usePathname: () => '/reminders', useSearchParams: () => new URLSearchParams() }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'account-a', selectedAccount: null, loading: false }) }))
const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } })
const reminder = { id: 'r-1', name: '確認用のお知らせ', description: null, isActive: true, lifecycleStatus: 'published', triggerType: 'friend_field', deliveryMode: 'time', triggerOffsetMinutes: 0, sendAtTime: '09:00', folderId: null, stepCount: 1, timingSummary: '基準日の当日', hasFailure: false, plannedDeliveries: 0, failedCount: 0, nextScheduledAt: null, displayOrder: 0, createdAt: '2026-09-01 00:00', updatedAt: '2026-09-02 00:00' }
let deletes: number
let finish: (value: Response) => void
beforeEach(() => {
  deletes = 0
  window.history.replaceState(null, '', '/reminders')
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (url.pathname === '/api/reminders/r-1' && init?.method === 'DELETE') { deletes += 1; return new Promise<Response>(resolve => { finish = resolve }) }
    if (url.pathname === '/api/reminders') return json({ success: true, data: { items: [reminder], total: 1, limit: 20 } })
    if (url.pathname === '/api/staff/me') return json({ success: true, data: { role: 'admin' } })
    if (url.pathname === '/api/folders') return json({ success: true, data: [], unfiledCount: 0 })
    if (url.pathname === '/api/list-stats') return json({ success: true, data: { reminders: { total: 1, active: 1, waiting: 0, sentThisMonth: 0, failed: 0 } } })
    return json({ success: true, data: {} })
  }))
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('削除は確認を経て一度だけ送られ、失敗したら窓に理由を残す', async () => {
  const browserConfirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
  render(<RemindersPage />)
  fireEvent.click(await screen.findByRole('button', { name: 'リマインダ「確認用のお知らせ」の操作' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: '削除する' }))
  const dialog = await screen.findByRole('alertdialog')
  expect(deletes).toBe(0)
  expect(browserConfirm).not.toHaveBeenCalled()
  fireEvent.click(within(dialog).getByRole('button', { name: '削除する' }))
  await waitFor(() => expect(deletes).toBe(1))
  const busy = within(dialog).getByRole('button', { name: '削除しています…' }) as HTMLButtonElement
  expect(busy.disabled).toBe(true)
  fireEvent.click(busy)
  expect(deletes).toBe(1)
  await act(async () => { finish(json({ success: false, error: 'failed' })) })
  expect(await within(dialog).findByText(/このリマインダを削除できませんでした/)).toBeTruthy()
  expect(screen.getByRole('alertdialog')).toBeTruthy()
  expect(deletes).toBe(1)
  browserConfirm.mockRestore()
})
