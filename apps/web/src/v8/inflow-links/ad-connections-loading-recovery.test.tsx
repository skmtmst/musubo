// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/inflow-links',
  useSearchParams: () => new URLSearchParams('tab=connections'),
}))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'account-a', accounts: [{ id: 'account-a', name: '本店' }], loading: false }),
}))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('@/lib/staff-role', async (original) => ({
  ...(await original<typeof import('@/lib/staff-role')>()),
  useStaffRole: () => 'owner',
}))

import AdConnectionsV8 from './ad-connections'

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

beforeEach(() => {
  document.documentElement.dataset.theme = 'v8'
})

describe('広告とのつなぎの読み込み中KPIと対応表再試行', () => {
  it('送信サマリーの読み込み中は3つの数値カードを読み込み中表示にする', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.pathname === '/api/ad-platforms/logs') return new Promise(() => {})
      if (url.pathname === '/api/ad-platforms/mappings') return json({ success: true, data: [] })
      if (url.pathname === '/api/ad-platforms') return json({ success: true, data: [] })
      return json({ success: true, data: null })
    })

    const { container } = render(<AdConnectionsV8 />)
    await screen.findByText('広告とのつなぎ')
    const cards = [...container.querySelectorAll('[aria-label="広告への送信の概要"] [data-kpi-presentation]')]
    expect(cards).toHaveLength(4)
    expect(cards.slice(0, 3).every((card) => card.getAttribute('aria-busy') === 'true')).toBe(true)
    expect(cards.slice(0, 3).every((card) => (card.textContent ?? '').includes('読み込んでいます'))).toBe(true)
  })

  it('対応表の読み込みに失敗したら「もう一度読み込む」から回復できる', async () => {
    let mappingCalls = 0
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.pathname === '/api/ad-platforms/mappings') {
        mappingCalls += 1
        if (mappingCalls === 1) return json({ success: false, error: 'down' }, 500)
        return json({
          success: true,
          data: [{ pointId: 'cp-1', pointName: '初回購入', eventType: 'x', provider: 'google', mode: 'manual', eventName: 'purchase_first', automaticEventName: 'purchase', googleActionId: null, version: 1 }],
        })
      }
      if (url.pathname === '/api/ad-platforms/logs') {
        return json({ success: true, data: { items: [], total: 0, page: 1, limit: 20, summary: { sentLast30Days: 10, pendingLast30Days: 0, failedLast30Days: 0 }, sort: [] } })
      }
      if (url.pathname === '/api/ad-platforms') return json({ success: true, data: [] })
      return json({ success: true, data: null })
    })

    render(<AdConnectionsV8 />)
    expect(await screen.findByText('対応表を読み込めませんでした')).toBeTruthy()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
    })
    await waitFor(() => expect(screen.getByText('初回購入')).toBeTruthy())
    expect(mappingCalls).toBe(2)
  })
})
