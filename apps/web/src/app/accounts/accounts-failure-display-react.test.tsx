// @vitest-environment happy-dom
/*
 * R520: アカウント一覧の取得失敗中も上部の集計を 0 件と表示する。
 *
 * 本物の React で本物の `AccountsPage` を mount し、差し替えるのは通信だけ。
 * - 取得失敗中は 3 つの集計と一覧合計を 0 と出さず「—」にする。
 * - 成功した空一覧だけ 0 を出す（ここでは 2 件の成功で件数が戻ることを見る）。
 * - 再読み込み後は実際の件数を表示する。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AccountsPage from './page'
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'acc-a', loading: false }) }))

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

vi.mock('next/link', () => ({
  default: ({ children, ...props }: React.ComponentProps<'a'>) => <a {...props}>{children}</a>,
}))
vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(),
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/accounts',
}))

vi.mock('@/components/shell/page-chrome', async () => ({ ...(await import('@/test-utils/page-chrome-mock')).pageChromeMock(),
  usePageTitle: () => {},
  usePageChrome: () => ({}),
}))

const ACCOUNTS = [
  {
    id: 'acc-a', channelId: '2007000001', name: '本店',
    loginChannelId: null, liffId: null, isActive: true, archivedAt: null,
    isDefault: true, timezone: 'Asia/Tokyo',
    createdAt: '', updatedAt: '', country: null, role: null, displayOrder: 0,
    ogSiteName: null, ogDefaultDescription: null, ogDefaultImageUrl: null,
    parentLineAccountId: null,
    stats: { friendCount: 10, activeScenarios: 1, messagesThisMonth: 5 },
    webhook: { expectedUrl: 'https://example.test/hook', actualUrl: 'https://example.test/hook', active: true, status: 'matched' },
  },
  {
    id: 'acc-b', channelId: '2007000002', name: '支店',
    loginChannelId: null, liffId: null, isActive: false, archivedAt: null,
    isDefault: false, timezone: 'Asia/Tokyo',
    createdAt: '', updatedAt: '', country: null, role: null, displayOrder: 0,
    ogSiteName: null, ogDefaultDescription: null, ogDefaultImageUrl: null,
    parentLineAccountId: null,
    stats: { friendCount: 0, activeScenarios: 0, messagesThisMonth: 0 },
    webhook: { expectedUrl: 'https://example.test/hook', actualUrl: null, active: null, status: 'unknown' },
  },
]

const net = vi.hoisted(() => ({
  /** true の間だけ一覧 GET を通信断にする。 */
  down: true,
}))

function stubFetch() {
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input)
    if (url.includes('/api/line-accounts') && net.down) throw new TypeError('fetch failed')
    if (url.includes('/api/line-accounts')) {
      return new Response(JSON.stringify({ success: true, data: ACCOUNTS }), { status: 200 })
    }
    return new Response(JSON.stringify({ success: true, data: [] }), { status: 200 })
  }) as typeof globalThis.fetch
}

let container: HTMLDivElement
let root: Root
const originalFetch = globalThis.fetch

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeEach(() => {
  document.documentElement.dataset.theme='v8'
  window.history.replaceState(null,'','/accounts')
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  net.down = true
  stubFetch()
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  container.remove()
  document.documentElement.removeAttribute('data-theme')
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

async function flush(times = 5) {
  for (let i = 0; i < times; i += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  }
}

function kpis(): HTMLElement | null {
  return container.querySelector('[data-design="KPIs"]')
}

describe('R520 アカウント一覧の取得失敗中の集計（本物のReact）', () => {
  it('取得失敗中は集計と合計を 0 と出さず「—」にする', async () => {
    await act(async () => { root.render(<AccountsPage />) })
    await flush()

    // 一覧部分は error と再読み込みを示す。
    expect(container.textContent ?? '').toContain('もう一度読み込む')

    // 3 つの集計は未取得と真の 0 件を見分けられる形にする。
    const text = kpis()?.textContent ?? ''
    expect(text).toContain('—')
    expect(container.textContent).toContain('読み込めませんでした')
    expect(text).not.toMatch(/[0-9]/)

    // 一覧の合計も 0 件と出さない。
    expect(container.textContent ?? '').not.toContain('0件')
  })

  it('再読み込みの成功後は実際の件数を表示する', async () => {
    await act(async () => { root.render(<AccountsPage />) })
    await flush()
    expect(container.textContent ?? '').toContain('もう一度読み込む')

    net.down = false
    const retry = [...container.querySelectorAll('button')].find((button) => button.textContent === 'もう一度読み込む')
    expect(retry).toBeTruthy()
    await act(async () => { retry?.click() })
    await flush()

    const text = kpis()?.textContent ?? ''
    // 稼働中 1・停止中 1・アーカイブ 0（板  の3枚だけ）。
    for (const label of ['つないでいる','有効','接続に問題','友だちの合計']) expect(text).toContain(label)
    const cards=kpis()?.children;
    expect(cards?.[0]?.textContent).toContain('2');
    expect(cards?.[1]?.textContent).toContain('1');
    expect(cards?.[2]?.textContent).toContain('0');
    expect(cards?.[3]?.textContent).toContain('10');
  })
})
