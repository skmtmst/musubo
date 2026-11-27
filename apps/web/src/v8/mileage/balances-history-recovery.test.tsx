// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MileageShell } from './frame'
import BalancesTab from './balances'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <>{children}</> }))
vi.mock('next/navigation', async () => ({
  ...(await import('@/test-utils/navigation-mock')).navigationMock(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams('tab=balances'),
  usePathname: () => '/mileage',
}))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'account-1', accounts: [{ id: 'account-1', name: '公式A' }], loading: false }),
}))
vi.mock('@/lib/staff-role', async (importOriginal: () => Promise<typeof import('@/lib/staff-role')>) => {
  const actual = await importOriginal()
  return { ...actual, useStaffRole: () => 'owner' }
})

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })

const okFriends = {
  success: true,
  data: {
    balanceSource: 'musubo',
    items: [{
      friendId: 'friend-1',
      displayName: '山田 太郎',
      pictureUrl: null,
      rank: 'gold',
      rankReason: '',
      rankThreshold: null,
      nextRank: null,
      nextRankThreshold: null,
      milesToNextRank: null,
      monthChange: 428,
      available: 2340,
      pending: 0,
      expiringMiles30d: 120,
      nextExpiringAt: null,
      lifetimeEarned: 3000,
      spent: 660,
      lastChangedAt: '2026-09-30T00:00:00.000Z',
      walletScope: 'friend',
      lineAccount: { id: 'account-1', name: '公式A' },
    }],
    summary: {
      totalMembers: 1284,
      withBalanceCount: 1102,
      available: 286400,
      pending: 0,
      monthChange: 7700,
      rankCounts: [],
      expiringMiles30d: null,
      nextExpiringAt: null,
    },
    pagination: { total: 1, limit: 20, offset: 0 },
    measuredAt: '2026-10-02T00:00:00.000Z',
  },
}

const okHistory = {
  success: true,
  data: {
    items: [],
    pagination: { total: 0, limit: 1, offset: 0 },
    summary: {
      byType: [
        { entryType: 'grant', count: 1, amount: 40800 },
        { entryType: 'spend', count: 1, amount: -12500 },
      ],
      totalAmount: 28300,
      manualCount: 0,
    },
  },
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  document.documentElement.dataset.theme = 'v8'
  window.history.replaceState(null, '', '/mileage?tab=balances')
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

function renderBalances() {
  act(() => {
    root.render(
      <MileageShell.Provider value={{ tab: 'balances', readonly: false, narrow: false, counts: {}, setCount: () => {} }}>
        <BalancesTab />
      </MileageShell.Provider>,
    )
  })
}

describe('V8 マイル残高一覧の30日集計失敗分離と読み込み表示', () => {
  it('初回読み込み中は数の帯4マスに読み込み骨格を出し、完了後に数値へ切り替える', async () => {
    let resolveFriends!: (response: Response) => void
    vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.pathname === '/api/mileage/friends') return new Promise<Response>((resolve) => { resolveFriends = resolve })
      if (url.pathname === '/api/mileage/history') return Promise.resolve(json(okHistory))
      if (url.pathname === '/api/mileage/adjustment-approvals') return Promise.resolve(json({ success: true, data: [] }))
      return Promise.resolve(json({ success: true, data: null }))
    })

    renderBalances()
    await flush()

    const stats = host.querySelector('[data-template-region="stats"]')!
    expect(stats.querySelectorAll('[data-kpi-skeleton]').length).toBe(4)

    await act(async () => { resolveFriends(json(okFriends)) })
    await flush()

    expect(stats.querySelectorAll('[data-kpi-skeleton]').length).toBe(0)
    expect(stats.textContent).toContain('40,800')
    expect(stats.textContent).toContain('12,500')
  })

  it('30日履歴の取得が success:false でも 0 に見せず、残高表を保ったままその場で再取得できる', async () => {
    let friendsCalls = 0
    let historyCalls = 0
    vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.pathname === '/api/mileage/friends') {
        friendsCalls += 1
        return Promise.resolve(json(okFriends))
      }
      if (url.pathname === '/api/mileage/history') {
        historyCalls += 1
        if (historyCalls === 1) return Promise.resolve(json({ success: false, error: 'temporary history failure' }, 200))
        return Promise.resolve(json(okHistory))
      }
      if (url.pathname === '/api/mileage/adjustment-approvals') return Promise.resolve(json({ success: true, data: [] }))
      return Promise.resolve(json({ success: true, data: null }))
    })

    renderBalances()
    await flush()

    expect(host.textContent).toContain('山田 太郎')
    const stats = host.querySelector('[data-template-region="stats"]') as HTMLElement
    const cards = [...stats.querySelectorAll('[data-kpi-presentation="band"]')]
    const grantedCard = cards.find((card) => card.textContent?.includes('直近30日 増えた'))!
    const decreasedCard = cards.find((card) => card.textContent?.includes('直近30日 減った'))!
    expect(grantedCard.textContent).toContain('—')
    expect(grantedCard.textContent).toContain('集計を読み込めませんでした')
    expect(decreasedCard.textContent).toContain('—')
    expect(decreasedCard.textContent).toContain('集計を読み込めませんでした')

    const retryButtons = within(stats).getAllByRole('button', { name: 'もう一度読み込む' })
    expect(retryButtons).toHaveLength(2)

    const friendsBefore = friendsCalls
    await act(async () => { retryButtons[0].click() })
    await flush()

    expect(historyCalls).toBe(2)
    expect(friendsCalls).toBe(friendsBefore)
    expect(stats.textContent).toContain('40,800')
    expect(stats.textContent).toContain('12,500')
    expect(stats.textContent).not.toContain('集計を読み込めませんでした')
  })

  it('30日履歴の取得が500エラーで失敗しても残高一覧全体を失敗表示にしない', async () => {
    vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.pathname === '/api/mileage/friends') return Promise.resolve(json(okFriends))
      if (url.pathname === '/api/mileage/history') return Promise.resolve(json({ success: false, error: 'server error' }, 500))
      if (url.pathname === '/api/mileage/adjustment-approvals') return Promise.resolve(json({ success: true, data: [] }))
      return Promise.resolve(json({ success: true, data: null }))
    })

    renderBalances()
    await flush()

    expect(host.textContent).toContain('山田 太郎')
    expect(host.textContent).not.toContain('マイルの残高を読み込めませんでした')
    expect(host.textContent).toContain('集計を読み込めませんでした')
  })
})
