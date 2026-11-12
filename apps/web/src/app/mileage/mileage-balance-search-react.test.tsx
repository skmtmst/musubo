// @vitest-environment happy-dom
/*
 * 「友だちの残高」タブの検索を本物の React で動かす試験(#816 / N-242)。
 *
 * 監査時点の検索欄は onChange + 300ms デバウンスだけで、Enter も確定ボタンも
 * 無かった。「行動スコア」タブの検索（Enter・「検索」ボタンで確定）と操作が
 * 違うのが指摘だった。ここは実物の MileagePage を mount し、差し替えるのは
 * 通信だけにして、画面本体と `api.ts` は実物を通す。
 *
 * Required gate（`pnpm --filter web test`）は mileage の試験を拾うので、
 * この試験はそのまま必須ゲートに含まれる。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AccountProvider } from '@/contexts/account-context'
import MileagePage from './page'

vi.mock('next/link', () => ({ default: () => null }))
vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams('tab=balances'),
  usePathname: () => '/mileage',
}))

interface Call {
  url: string
  method: string
  body: string | null
}

function memberFixture() {
  return {
    friendId: 'friend-1',
    displayName: '見本 167',
    pictureUrl: null,
    rank: null,
    rankReason: '',
    rankThreshold: null,
    nextRank: null,
    nextRankThreshold: null,
    milesToNextRank: null,
    monthChange: 0,
    available: 100,
    pending: 0,
    expiringMiles30d: null,
    lifetimeEarned: 100,
    spent: 0,
    lastChangedAt: '2026-09-10T00:00:00.000Z',
    walletScope: 'friend',
    lineAccount: { id: 'account-1', name: '公式A' },
  }
}

/*
 * D022: 見本は実APIの形に合わせる（実APIは nextExpiringAt・measuredAt を
 * 必ず返す）。欠けた見本は応答検査で弾かれ、検索欄まで届かない。
 */
const friendsOverview = {
  balanceSource: 'musubo',
  items: [memberFixture()],
  summary: {
    totalMembers: 1,
    withBalanceCount: 1,
    available: 100,
    pending: 0,
    monthChange: 0,
    rankCounts: [],
    expiringMiles30d: null,
    nextExpiringAt: null,
  },
  pagination: { total: 1, limit: 20, offset: 0 },
  measuredAt: '2026-09-10T00:00:00.000Z',
}

/*
 * 通信の差し替え。呼ばれた口を全部残す。
 * friends の口は検索語がクエリに乗るので、呼び出し履歴から確定状態を読む。
 */
function stubFetch() {
  const calls: Call[] = []
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    calls.push({
      url,
      method: (init?.method ?? 'GET').toUpperCase(),
      body: typeof init?.body === 'string' ? init.body : null,
    })
    if (url.includes('/api/mileage/friends')) {
      return new Response(JSON.stringify({ success: true, data: friendsOverview }), { status: 200 })
    }
    if (url.includes('/api/mileage/earning-rules')) {
      return new Response(JSON.stringify({
        success: true,
        data: { items: [], pagination: { total: 0, limit: 100, offset: 0 }, unassignedLegacyCount: 0, measuredAt: '2026-09-10T00:00:00.000Z' },
      }), { status: 200 })
    }
    if (url.includes('/api/mileage/history')) {
      return new Response(JSON.stringify({
        success: true,
        data: { items: [], pagination: { total: 0, limit: 1, offset: 0 }, summary: { byType: [], totalAmount: 0, manualCount: 0 } },
      }), { status: 200 })
    }
    if (url.includes('/api/mileage/rewards')) {
      return new Response(JSON.stringify({ success: true, data: { rewards: [] } }), { status: 200 })
    }
    if (url.includes('/api/staff/me')) {
      return new Response(JSON.stringify({ success: true, data: { id: 'owner-1', role: 'owner' } }), { status: 200 })
    }
    if (url.includes('/api/line-accounts')) {
      return new Response(JSON.stringify({
        success: true,
        data: [{ id: 'account-1', channelId: 'channel-1', name: '公式A', isActive: true, country: null, role: null, displayOrder: 0 }],
      }), { status: 200 })
    }
    return new Response(JSON.stringify({ success: true, data: {} }), { status: 200 })
  }) as typeof globalThis.fetch
  const friendsCalls = () => calls.filter((call) => call.url.includes('/api/mileage/friends'))
  const searchOf = (call: Call) => new URL(call.url, 'https://example.test').searchParams.get('search')
  return { calls, friendsCalls, searchOf }
}

let container: HTMLDivElement
let root: Root
const originalFetch = globalThis.fetch

/*
 * この happy-dom には localStorage が無い。`api.ts` は更新の口で
 * CSRF札を localStorage から読むので、置かないと届く前に落ちる。
 * 画面側の分岐ではなく実行環境の穴なので、最小の実物をここで置く。
 */
function installWebStorage(): void {
  const make = () => {
    const data = new Map<string, string>()
    return {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => { data.set(key, String(value)) },
      removeItem: (key: string) => { data.delete(key) },
      clear: () => { data.clear() },
      key: (index: number) => [...data.keys()][index] ?? null,
      get length() { return data.size },
    }
  }
  for (const name of ['localStorage', 'sessionStorage'] as const) {
    const holder = globalThis as unknown as Record<string, unknown>
    if (!holder[name]) {
      Object.defineProperty(globalThis, name, { value: make(), configurable: true })
    }
  }
}

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeEach(() => {
  installWebStorage()
  globalThis.localStorage.setItem('lh_selected_account', 'account-1')
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  container.remove()
  document.body.innerHTML = ''
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

async function renderPage() {
  await act(async () => {
    root.render(<AccountProvider><MileagePage /></AccountProvider>)
  })
}

async function settle(ticks = 6) {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 320)) })
  for (let i = 0; i < ticks; i += 1) {
    await act(async () => { await Promise.resolve() })
  }
}

async function waitForSearchInput(): Promise<HTMLInputElement> {
  for (let i = 0; i < 40; i += 1) {
    await act(async () => { await Promise.resolve() })
    const input = container.querySelector('input[placeholder="友だちの名前で探す"]')
    if (input) return input as HTMLInputElement
  }
  throw new Error('検索欄が出ませんでした')
}

function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function pressEnter(input: HTMLInputElement) {
  act(() => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
}

describe('友だちの残高タブの検索(本物のReact)', () => {
  it('検索語を入れて300ms待つと自動で一覧を取り直す', async () => {
    const net = stubFetch()
    await renderPage()
    const input = await waitForSearchInput()

    typeInto(input, '田中')
    // Enterなしでも検索を確定する。
    await settle()

    const searched = net.friendsCalls().filter((call) => net.searchOf(call) === '田中')
    expect(searched.length).toBeGreaterThan(0)
    // 確定した条件は入力欄にも残る（打ち直し・中途半端な確定状態にしない）。
    expect(input.value).toBe('田中')
  })

  it('確定した条件は「残高を再読み込み」しても維持される', async () => {
    const net = stubFetch()
    await renderPage()
    const input = await waitForSearchInput()

    typeInto(input, '田中')
    pressEnter(input)
    await settle()

    const reload = [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('残高を再読み込み')) as HTMLButtonElement | undefined
    expect(reload).toBeTruthy()
    await act(async () => { reload!.click() })
    await settle()

    const last = net.friendsCalls().at(-1)
    expect(last).toBeTruthy()
    expect(net.searchOf(last!)).toBe('田中')
  })
})
