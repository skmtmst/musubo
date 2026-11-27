// @vitest-environment happy-dom
/*
 * M029: 鍵なし担当者の一覧取得は403だが、画面は一律
 * 「流入経路を読み込めませんでした」＋再読み込みボタンで、
 * 権限不足と分からず通らない再試行を促していた（M021同系統）。
 * 本物のReactで動かして見る。
 * - 403 → 権限の案内。再読み込みの口を出す（押しても直らない）。
 * - 429 → 待ち秒数の案内。再試行の口は残す。
 * - 500 → 今までどおりの1枚。再試行の口は残す。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'acc-1', selectedAccount: null, loading: false }),
}))

vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(),
  usePathname: () => '/inflow-links',
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(''),
}))

import InflowLinksPage from './page'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
let entryRoutesStatus: number
let entryRoutesHeaders: Record<string, string>
let entryRoutesSuccessData: Array<Record<string, unknown>> | null
let pendingRoutes: Promise<Response> | null = null

function stubFetch() {
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const raw = typeof input === 'string' ? input : String(input)
    const url = raw.startsWith('http') ? new URL(raw) : new URL(raw, 'https://test.invalid')
    const path = url.pathname + url.search
    if (path.startsWith('/api/settings/features/visibility')) {
      return new Response(
        JSON.stringify({ success: true, data: { features: { inflow_tracking: true, site_tracking: true } } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }
    if (path.startsWith('/api/entry-routes')) {
      if (pendingRoutes) return pendingRoutes
      if (entryRoutesSuccessData !== null) {
        return new Response(
          JSON.stringify({ success: true, data: entryRoutesSuccessData }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return new Response(
        JSON.stringify({ success: false, error: 'forbidden' }),
        { status: entryRoutesStatus, headers: { 'Content-Type': 'application/json', ...entryRoutesHeaders } },
      )
    }
    if (path.startsWith('/api/scenarios')) {
      return new Response(
        JSON.stringify({ success: true, data: { items: [], total: 0, limit: 200, sort: [] } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }
    return new Response(JSON.stringify({ success: true, data: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }))
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50))
  })
}

function errorCard(): HTMLElement | null {
  return host.querySelector('[data-list-state="error"]')
}

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-18T00:00:00.000Z')) })
afterEach(() => { vi.useRealTimers() })

describe('M029 流入経路一覧の取得失敗は原因どおりに言い分ける', () => {
  beforeEach(() => {
    entryRoutesStatus = 500
    entryRoutesHeaders = {}
    entryRoutesSuccessData = null
    pendingRoutes = null
    stubFetch()
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

  it('取得中は読み込みを表示し、成功した0件と区別する', async () => {
    let resolve!: (response: Response) => void
    pendingRoutes = new Promise(done => { resolve = done })
    await act(async () => { root.render(<InflowLinksPage />) })
    expect(host.querySelector('[data-list-state="loading"]')?.getAttribute('aria-label')).toBe('流入経路を読み込んでいます')
    expect(host.textContent).not.toContain('まだ流入リンクがありません')
    await act(async () => { resolve(new Response(JSON.stringify({ success: true, data: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })) })
    await settle()
    expect(host.textContent).toContain('まだ流入リンクがありません')
    expect(errorCard()).toBeNull()
  })

  it('取得失敗のあと読み直し、成功した0件に戻る', async () => {
    await act(async () => { root.render(<InflowLinksPage />) })
    await settle()
    expect(errorCard()?.textContent).toContain('流入リンクを読み込めませんでした')
    expect(host.textContent).not.toContain('まだ流入リンクがありません')
    entryRoutesSuccessData = []
    await act(async () => { errorCard()!.querySelector('button')!.click() })
    await settle()
    expect(errorCard()).toBeNull()
    expect(host.textContent).toContain('まだ流入リンクがありません')
  })

  it('403は権限の案内にし、再読み込みの口を出す', async () => {
    entryRoutesStatus = 403
    await act(async () => {
      root.render(<InflowLinksPage />)
    })
    await settle()

    const card = errorCard()
    expect(card).not.toBeNull()
    expect(card!.textContent).toContain('見る権限がありません')
    // 権限が追加された後も同じ画面で読み直せる。
    expect(card!.querySelector('button')).toBeTruthy()
    expect(card!.textContent).not.toContain('流入経路を読み込めませんでした')
    expect(card!.textContent).not.toContain('流入経路を再読み込み')
  })

  it('429は待ち秒数を添え、再試行の口を残す', async () => {
    entryRoutesStatus = 429
    entryRoutesHeaders = { 'Retry-After': '45' }
    await act(async () => {
      root.render(<InflowLinksPage />)
    })
    await settle()

    const card = errorCard()
    expect(card).not.toBeNull()
    expect(card!.textContent).toContain('混み合っています')
    expect(card!.textContent).toContain('45秒')
    expect(card!.querySelector('button')).not.toBeNull()
  })

  it('500は今までどおりの1枚で、再試行の口を残す', async () => {
    entryRoutesStatus = 500
    await act(async () => {
      root.render(<InflowLinksPage />)
    })
    await settle()

    const card = errorCard()
    expect(card).not.toBeNull()
    expect(card!.textContent).toContain('流入リンクを読み込めませんでした')
    expect(card!.textContent).not.toContain('リファラルリンクの取得に失敗しました')
    expect(card!.querySelector('button')).not.toBeNull()
    const routeCard = [...host.querySelectorAll('[data-design-version]')].find(element => element.querySelector('[data-kpi-label]')?.textContent?.trim() === '経路')
    expect(routeCard).toBeTruthy()
    expect(routeCard!.textContent).toContain('—')
    expect(routeCard!.textContent).toContain('読み込めませんでした')
    expect(routeCard!.textContent).not.toContain('0件')
  })
})

describe('R173 検索・絞り込みの0件は未登録と混ぜない', () => {
  beforeEach(() => {
    entryRoutesStatus = 200
    entryRoutesHeaders = {}
    entryRoutesSuccessData = [{
      id: 'er-1',
      refCode: 'spring',
      name: '春キャンペーン',
      genre: null,
      poolId: null,
      tagId: null,
      scenarioId: null,
      runAccountFriendAddScenarios: false,
      isActive: true,
    }]
    stubFetch()
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

  it('存在しない検索語では「条件に合う」案内になり、フォルダ作りを出さない', async () => {
    await act(async () => {
      root.render(<InflowLinksPage />)
    })
    await settle()

    // まず登録済みの行が見えること（絞り込みの土台がある）。
    expect(host.textContent).toContain('春キャンペーン')

    const input = host.querySelector('input[placeholder="経路の名前・URLで探す"]') as HTMLInputElement
    expect(input).not.toBeNull()
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'そんざいしないさーち')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 320)) })
    await settle()

    expect(host.textContent).toContain('条件に合うものがありません')
    expect(host.textContent).not.toContain('最初のフォルダ')
    expect(host.textContent).not.toContain('まだ流入経路がありません')
  })
})
