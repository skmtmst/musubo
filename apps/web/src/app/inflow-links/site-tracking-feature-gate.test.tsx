// @vitest-environment happy-dom
/*
 * #859: site_tracking が流入計測の画面と一致することを本物のReactで見る。
 * - off で「サイトスクリプト」タブが出ない
 * - ?tab=script の直URLでも本文へ進まず停止画面を出す
 * - on なら従来どおりタブが出て計測APIを呼ぶ
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let currentParams = ''
let selectedAccount = 'acc-1'
let trackingKey: (url: URL) => Promise<unknown> = async () => ({ success: true, data: { trackingKey: 'key-one' } })

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: selectedAccount, selectedAccount: null, loading: false }),
}))

vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(),
  usePathname: () => '/inflow-links',
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(currentParams),
}))

import InflowLinksPage from './page'
import { clearFeatureVisibilityCache } from '@/lib/feature-visibility-cache'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
const fetchUrls: string[] = []

function stubFetch(features: Record<string, boolean>) {
  fetchUrls.length = 0
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    const href = String(url)
    fetchUrls.push(href)
    if (href.includes('/api/settings/features/visibility')) {
      return { ok: true, status: 200, json: async () => ({ success: true, data: { features } }) }
    }
    if (href.includes('/api/site/tracking-key')) return { ok: true, status: 200, json: async () => trackingKey(new URL(href, 'http://localhost')) }
    if (href.includes('/api/site/pages')) return { ok: true, status: 200, json: async () => ({ success: true, data: [{ host: 'shop.example', path: '/orders', views: 17, visitors: 9 }, { host: null, path: '/help', views: 4, visitors: 3 }] }) }
    return { ok: true, status: 200, json: async () => ({ success: true, data: [] }) }
  }))
}

async function settle(milliseconds: number) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, milliseconds))
  })
}

const ALL_ON: Record<string, boolean> = { site_tracking: true, inflow_tracking: true }

describe('site_tracking の画面ゲート(#859)', () => {
  beforeEach(() => {
    // 表示可否は画面間で共有される（V6R-S0-b）。試験ごとに応答を替えるので毎回捨てる。
    clearFeatureVisibilityCache()
    selectedAccount = 'acc-1'
    trackingKey = async () => ({ success: true, data: { trackingKey: 'key-one' } })
    stubFetch(ALL_ON)
    currentParams = ''
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    host.remove()
    vi.unstubAllGlobals()
  })

  it('onのときサイトスクリプトのタブが出て、?tab=script で計測APIを呼ぶ', async () => {
    currentParams = 'tab=script'
    await act(async () => {
      root.render(<InflowLinksPage />)
    })
    await settle(200)

    expect(host.textContent).toContain('サイトスクリプト')
    expect(host.querySelector('[data-feature-disabled]')).toBeNull()
    expect(fetchUrls.some((u) => u.includes('/api/site/summary'))).toBe(true)
  })

  it('鍵の取得中はコードを見せず、取得した店舗の鍵をコードに入れる', async () => {
    let resolve!: (value: unknown) => void
    trackingKey = () => new Promise(done => { resolve = done })
    currentParams = 'tab=script'
    await act(async () => { root.render(<InflowLinksPage />) })
    await settle(100)
    expect(host.textContent).toContain('あなたのアカウントのコードを取得しています')
    expect(host.textContent).not.toContain('data-key=')
    const request = fetchUrls.find(url => url.includes('/api/site/tracking-key'))!
    expect(new URL(request, 'http://localhost').searchParams.get('account_id')).toBe('acc-1')
    await act(async () => { resolve({ success: true, data: { trackingKey: 'key-one' } }) })
    await settle(50)
    expect(host.textContent).toContain('data-key="key-one"')
    expect(host.textContent).not.toContain('hk_9f3a2c81b4')
    expect(host.querySelector('table[aria-label="ページごとの表示"]')).toBeTruthy()
    const page = host.querySelector('[title="shop.example/orders"]')!
    expect(page.textContent).toBe('/orders')
    expect(host.querySelector('[title="/help"]')?.textContent).toBe('/help')
  })

  it('鍵の失敗はコードを隠して再取得できる', async () => {
    trackingKey = async () => ({ success: false, error: 'private error' })
    currentParams = 'tab=script'
    await act(async () => { root.render(<InflowLinksPage />) })
    await settle(100)
    expect(host.textContent).toContain('計測コードを読み込めませんでした')
    expect(host.textContent).not.toContain('data-key=')
    expect(host.textContent).not.toContain('private error')
    trackingKey = async () => ({ success: true, data: { trackingKey: 'recovered-key' } })
    const retry = [...host.querySelectorAll('button')].find(button => button.textContent?.includes('コードをもう一度取得する'))!
    await act(async () => { retry.click() })
    await settle(50)
    expect(host.textContent).toContain('data-key="recovered-key"')
  })

  it('店を切り替えたら前の鍵を隠し、新しい店の鍵を使う', async () => {
    let resolve!: (value: unknown) => void
    trackingKey = url => url.searchParams.get('account_id') === 'acc-2'
      ? new Promise(done => { resolve = done })
      : Promise.resolve({ success: true, data: { trackingKey: 'key-one' } })
    currentParams = 'tab=script'
    await act(async () => { root.render(<InflowLinksPage />) })
    await settle(100)
    expect(host.textContent).toContain('data-key="key-one"')
    selectedAccount = 'acc-2'
    await act(async () => { root.render(<InflowLinksPage />) })
    await settle(50)
    expect(host.textContent).toContain('あなたのアカウントのコードを取得しています')
    expect(host.textContent).not.toContain('key-one')
    await act(async () => { resolve({ success: true, data: { trackingKey: 'key-two' } }) })
    await settle(50)
    expect(host.textContent).toContain('data-key="key-two"')
    expect(host.textContent).not.toContain('key-one')
  })

  it('offのときサイトスクリプトのタブが消え、他のタブは残る', async () => {
    stubFetch({ site_tracking: false, inflow_tracking: true })
    await act(async () => {
      root.render(<InflowLinksPage />)
    })
    await settle(200)

    expect(host.textContent).not.toContain('サイトスクリプト')
    expect(host.textContent).toContain('流入と計測')
    expect(host.textContent).toContain('広告とのつなぎ')
  })

  it('offで ?tab=script の直URLは停止画面へ切り替わり、計測APIを呼ばない', async () => {
    stubFetch({ site_tracking: false, inflow_tracking: true })
    currentParams = 'tab=script'
    await act(async () => {
      root.render(<InflowLinksPage />)
    })
    await settle(200)

    expect(host.querySelector('[data-feature-disabled="site_tracking"]')).not.toBeNull()
    expect(fetchUrls.some((u) => u.includes('/api/site/summary'))).toBe(false)
    expect(fetchUrls.some((u) => u.includes('/api/site/pages'))).toBe(false)
  })
})
