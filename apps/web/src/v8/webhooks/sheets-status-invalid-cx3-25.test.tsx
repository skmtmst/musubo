// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

import WebhooksPage from './sheets'
import { fireEvent, waitFor, within } from '@testing-library/react'

/*
 * ★V8-B 外部連携の Google Sheets（板 ）の契約。
 * `<html data-theme="v8">` の下でだけ新しい Sheets タブに切り替わり、
 * 見本が決めた書き出しカード・記録の表が出ることを実DOMで固定する。
 * 互換経路では従来の Sheets タブが出ることも固定する。
 */
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push() {}, replace() {}, prefetch() {} }),
  usePathname: () => '/webhooks',
  useSearchParams: () => new URLSearchParams([['tab', 'sheets']]),
}))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({
  selectedAccountId: 'account-a',
  selectedAccount: { name: 'NEN-TEST' },
  accounts: [],
  loading: false,
}) }))

let root: Root
let host: HTMLDivElement

const connection = {
  status: 'connected',
  googleAccountEmail: 'k***@gmail.com',
  spreadsheetId: 'sheet-1',
  spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/sheet-1',
  spreadsheetTitle: 'musubo 友だち台帳',
  lastSyncedAt: '2026-09-30T03:00:00.000Z',
  lastSyncStatus: 'ok',
  lastSyncError: null,
}

const runs = [
  {
    id: 'run-1', startedAt: '2026-09-30T03:00:00.000Z', kind: 'scheduled',
    dataType: 'friends', rowsWritten: 1284, status: 'ok', error: null, spreadsheetId: 'sheet-1',
  },
  {
    id: 'run-2', startedAt: '2026-09-30T03:00:00.000Z', kind: 'scheduled',
    dataType: 'form_answers', rowsWritten: 312, status: 'ok', error: null, spreadsheetId: 'sheet-1',
  },
]

const json = (data: unknown, status = 200) => new Response(
  JSON.stringify(data),
  { status, headers: { 'Content-Type': 'application/json' } },
)

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/webhooks/outgoing')) return json({ success: true, data: [] })
    if (url.includes('/incoming')) return json({ success: true, data: [] })
    if (url.includes('/interactions')) {
      return json({ success: true, data: { summary: {
        total: 0, outgoing: 0, incoming: 0, succeeded: 0,
        failed: 0, resultUnknown: 0, outgoingFailed: 0, retryable: 0, averageDurationMs: null,
      } } })
    }
    if (url.includes('google-sheets/runs')) {
      return json({ success: true, data: { runs } })
    }
    if (url.includes('google-sheets')) {
      return json({ success: true, data: { connection, canManage: true, oauthConfigured: true, syncRunning: false } })
    }
    return json({ success: false, error: 'not found' }, 404)
  })
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
  vi.unstubAllGlobals()
  document.documentElement.removeAttribute('data-theme')
})

async function renderPage() {
  await act(async () => {
    root.render(<WebhooksPage />)
  })
  await act(async () => {})
}

test('同期記録の一部が未知なら完了と決めつけない', async () => {
  runs[1].status = 'future'
  try {
    document.documentElement.dataset.theme = 'v8'
    await renderPage()
    await waitFor(() => expect(host.textContent).toContain('状態を確認できません'))
    const row = within(host).getByText('状態を確認できません').closest('tr')!
    expect(row.textContent).not.toContain('完了')
  } finally { runs[1].status = 'ok' }
})
test('同期結果が未知なら操作の後に確認できないと知らせる', async () => {
  const baseFetch = globalThis.fetch
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('google-sheets/sync')) return json({ success: true, data: { status: 'future', results: [] } })
    return baseFetch(input, init)
  })
  document.documentElement.dataset.theme = 'v8'
  await renderPage()
  await act(async () => { fireEvent.click(within(host).getByRole('button', { name: '今すぐ同期' })) })
  await waitFor(() => expect(host.textContent).toContain('同期の結果を確認できません'))
})
