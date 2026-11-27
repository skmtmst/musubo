// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'account-a', selectedAccount: null, loading: false }),
}))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('@/lib/staff-role', async (importOriginal: () => Promise<typeof import('@/lib/staff-role')>) => ({
  ...await importOriginal(),
  useStaffRole: () => 'owner',
}))

import AdsV8 from './ads'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })

const samplePlatforms = [
  {
    id: 'plat-google',
    name: 'google',
    displayName: 'Google広告',
    config: {},
    isActive: true,
    lineAccountId: 'account-a',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  },
]

const sampleCosts = {
  success: true,
  data: {
    rows: [{
      sourceLabel: 'Google検索広告',
      adPlatformId: 'plat-google',
      entryRouteId: 'route-1',
      source: 'import',
      totals: [{ currency: 'JPY', amountMinor: 45000 }],
      friendAdds: 30,
      costPerFriendMinor: 1500,
      lastImportedAt: '2026-10-01T00:00:00.000Z',
    }],
    platforms: [],
    manualEntries: [],
    conversionCost: { confirmedConversionCount: 15, costPerConversionMinor: 3000, currency: 'JPY' },
  },
}

const sampleRoutes = [{ id: 'route-1', name: '公式LP', refCode: 'lp-01' }]

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  document.documentElement.dataset.theme = 'v8'
  window.history.replaceState(null, '', '/inflow-links?tab=ads')
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  vi.unstubAllGlobals()
  host.remove()
  delete document.documentElement.dataset.theme
})

async function flush() {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => { await Promise.resolve() })
  }
}

describe('V8 広告連携の費用取得失敗分離とその場再読み込み', () => {
  it('広告費APIが500エラーでも接続媒体を隠し潰さず、0人の誤表示も出さない', async () => {
    vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.pathname === '/api/ad-platforms') return Promise.resolve(json({ success: true, data: samplePlatforms }))
      if (url.pathname === '/api/ad-costs') return Promise.resolve(json({ success: false, error: 'temporary cost failure' }, 500))
      if (url.pathname === '/api/entry-routes') return Promise.resolve(json({ success: true, data: sampleRoutes }))
      return Promise.resolve(json({ success: true, data: null }))
    })

    act(() => { root.render(<AdsV8 />) })
    await flush()

    expect(host.textContent).not.toContain('広告との接続状況を読み込めませんでした')
    expect(host.textContent).not.toContain('広告との接続状況を表示できませんでした')
    expect(host.textContent).toContain('Google広告')
    expect(host.textContent).toContain('つないでいる')
    expect(host.textContent).not.toContain('友だち追加 0 人')
    const band = host.querySelector('[aria-label="広告連携の概要"]') as HTMLElement
    expect(band.textContent).toContain('広告費を読み込めませんでした')
    expect(within(band).getAllByRole('button', { name: 'もう一度読み込む' })).toHaveLength(3)
  })

  it('広告費の再読み込みは媒体一覧を再取得せず費用だけ復帰する', async () => {
    let platformCalls = 0
    let costCalls = 0
    vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.pathname === '/api/ad-platforms') {
        platformCalls += 1
        return Promise.resolve(json({ success: true, data: samplePlatforms }))
      }
      if (url.pathname === '/api/ad-costs') {
        costCalls += 1
        if (costCalls === 1) return Promise.resolve(json({ success: false, error: 'temporary cost failure' }, 500))
        return Promise.resolve(json(sampleCosts))
      }
      if (url.pathname === '/api/entry-routes') return Promise.resolve(json({ success: true, data: sampleRoutes }))
      return Promise.resolve(json({ success: true, data: null }))
    })

    act(() => { root.render(<AdsV8 />) })
    await flush()

    const platformsBefore = platformCalls
    const band = host.querySelector('[aria-label="広告連携の概要"]') as HTMLElement
    const retryBtn = within(band).getAllByRole('button', { name: 'もう一度読み込む' })[0]

    await act(async () => { retryBtn.click() })
    await flush()

    expect(costCalls).toBe(2)
    expect(platformCalls).toBe(platformsBefore)
    expect(band.textContent).toContain('¥45,000')
    expect(band.textContent).toContain('友だち追加 30 人')
    expect(band.textContent).not.toContain('広告費を読み込めませんでした')
  })

  it('計測リンク一覧だけ失敗しても広告連携と費用一覧は表示し続ける', async () => {
    vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.pathname === '/api/ad-platforms') return Promise.resolve(json({ success: true, data: samplePlatforms }))
      if (url.pathname === '/api/ad-costs') return Promise.resolve(json(sampleCosts))
      if (url.pathname === '/api/entry-routes') return Promise.resolve(json({ success: false, error: 'routes down' }, 500))
      return Promise.resolve(json({ success: true, data: null }))
    })

    act(() => { root.render(<AdsV8 />) })
    await flush()

    expect(host.textContent).toContain('Google広告')
    expect(host.textContent).toContain('Google検索広告')
    expect(host.textContent).toContain('¥45,000')
    expect(host.textContent).not.toContain('広告との接続状況を読み込めませんでした')
  })
})
