// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/ops/announcements',
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('next/link', () => ({ default: ({ children, ...props }: React.ComponentProps<'a'>) => <a {...props}>{children}</a> }))

import OpsAnnouncementsV8 from './announcements'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })

const ME = { id: 'ops-1', name: '検証 太郎', email: null, readOnly: false, totpEnabled: true, lineLinked: false, legacy: false, impersonation: null }

const ROWS = [
  {
    id: 'ann-bad',
    subject: '数値異常テスト',
    status: 'sent',
    statusLabel: '配信済み',
    channels: ['screen', 'line'],
    channelLabels: ['画面', 'LINE'],
    audienceKind: 'all',
    audienceLabel: 'すべて',
    screenRead: -1,
    screenTotal: 10,
    lineSent: Number.NaN,
    recipientsTotal: 10,
    sentAt: '2026-11-27T01:00:00Z',
    publishAt: null,
    lastError: null,
    updatedAt: '2026-11-27T01:00:00Z',
  },
  {
    id: 'ann-draft-1',
    subject: '下書きA',
    status: 'draft',
    statusLabel: '下書き',
    channels: ['screen'],
    channelLabels: ['画面'],
    audienceKind: 'all',
    audienceLabel: 'すべて',
    screenRead: 0,
    screenTotal: 0,
    lineSent: 0,
    recipientsTotal: 0,
    sentAt: null,
    publishAt: null,
    lastError: null,
    updatedAt: '2026-11-27T02:00:00Z',
  },
  {
    id: 'ann-draft-2',
    subject: '下書きB',
    status: 'draft',
    statusLabel: '下書き',
    channels: ['screen'],
    channelLabels: ['画面'],
    audienceKind: 'all',
    audienceLabel: 'すべて',
    screenRead: 0,
    screenTotal: 0,
    lineSent: 0,
    recipientsTotal: 0,
    sentAt: null,
    publishAt: null,
    lastError: null,
    updatedAt: '2026-11-27T03:00:00Z',
  },
]

let host: HTMLDivElement
let root: Root

async function settle(turns = 12) {
  for (let i = 0; i < turns; i += 1) await act(async () => { await Promise.resolve() })
}

beforeEach(() => {
  document.documentElement.dataset.theme = 'v8'
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    if (url.endsWith('/api/ops/me')) return json({ success: true, data: ME })
    if (url.endsWith('/api/ops/announcements') && method === 'GET') {
      return json({
        success: true,
        data: ROWS,
        linked: { linked: -2, total: 10 },
        noticeLineConfigured: true,
      })
    }
    if (url.includes('/api/ops/announcements/ann-draft-1') && method === 'DELETE') {
      return json({ success: false, error: '下書きAの削除に失敗しました' }, 500)
    }
    return json({ success: true, data: null })
  })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  delete document.documentElement.dataset.theme
  vi.unstubAllGlobals()
})

describe('OpsAnnouncementsV8 不正数値と削除失敗エラーの残り防止', () => {
  it('負数や不正な件数は NaN や負の比率を出さず未確認表示にし、別行の削除確認へ前回の失敗文を引き継がない', async () => {
    await act(async () => { root.render(<OpsAnnouncementsV8 />) })
    await settle()

    const badRow = host.querySelector('[data-row-id="ann-bad"]') as HTMLElement
    expect(badRow).toBeTruthy()
    expect(badRow.textContent).not.toContain('-1/10')
    expect(badRow.textContent).not.toContain('NaN')
    expect(badRow.textContent).not.toContain('null/10')

    // 1件目の削除で失敗させたあと、キャンセルして2件目の削除確認を開く
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '「下書きA」の操作' }))
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: '削除する' }))
    })
    const dialog1 = screen.getByRole('alertdialog')
    await act(async () => {
      fireEvent.click(within(dialog1).getByRole('button', { name: '削除する' }))
    })
    await settle()
    expect(dialog1.textContent).toContain('サーバーでエラーが起きました')

    await act(async () => {
      fireEvent.click(within(dialog1).getByRole('button', { name: 'キャンセル' }))
    })
    await settle()
    expect(host.textContent).not.toContain('サーバーでエラーが起きました')

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '「下書きB」の操作' }))
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: '削除する' }))
    })
    const dialog2 = screen.getByRole('alertdialog')
    expect(dialog2.textContent).not.toContain('サーバーでエラーが起きました')
  })
})
