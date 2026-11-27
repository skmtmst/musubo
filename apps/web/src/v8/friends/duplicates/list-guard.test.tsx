// @vitest-environment happy-dom
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fx = vi.hoisted(() => ({
  hookState: null as Record<string, unknown> | null,
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/friends',
  useSearchParams: () => new URLSearchParams('tab=duplicates'),
}))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('@/lib/use-narrow-viewport', () => ({ useNarrowViewport: () => false }))
vi.mock('../shared/head', () => ({
  FriendsTabs: ({ action }: { action?: React.ReactNode }) => <div>{action}</div>,
}))
vi.mock('./use-duplicates-data', () => ({
  CANDIDATE_PAGE_SIZE: 25,
  useDuplicatesData: () => fx.hookState,
}))

import DuplicatesListV8 from './list'

function baseHookState(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      computedAt: '2026-11-20T00:00:00Z',
      overlappingDeliveryCount: Number.NaN,
      perAccount: [
        { accountId: 'a1', accountName: '本店', friends: Number.NaN, dups: -1, dupRate: Number.NaN },
        { accountId: 'a2', accountName: '支店', friends: 10, dups: 2, dupRate: 0.2 },
      ],
      pairwiseOverlap: [
        // Worker 仕様どおり 0 件の組（a1 -> a2）は配列から省かれ、明示された a2 -> a1 のみ不正値（NaN）
        { fromAccountId: 'a2', toAccountId: 'a1', overlap: Number.NaN },
      ],
    },
    loading: false,
    error: null,
    statsFailure: null,
    candidates: [],
    candidateTotal: Number.NaN,
    candidatesLoading: false,
    candidateError: null,
    statusCounts: { pending: 0, linked: 0, deferred: 0, different: 0 },
    lowConfidenceCount: 0,
    unfilteredCandidates: true,
    duplicateTotalText: '0組',
    duplicateDetail: '未確認 0',
    page: 1,
    setPage: vi.fn(),
    query: '',
    setQuery: vi.fn(),
    status: 'all',
    setStatus: vi.fn(),
    clearFilters: vi.fn(),
    refreshing: false,
    load: vi.fn(),
    loadCandidates: vi.fn(),
    detect: vi.fn(),
    ...overrides,
  }
}

describe('DuplicatesListV8 ガード', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    fx.hookState = baseHookState()
  })

  afterEach(() => {
    cleanup()
  })

  it('アカウント別の不正数値や明示された不正ペアを「—」で表示し、配列から省かれた 0 件の組は「0」で表示する', () => {
    render(<DuplicatesListV8 />)

    // 重なって届いた配信は NaN を出さず未取得表示
    expect(screen.queryByText(/NaN/)).toBeNull()

    // アカウントごとの重なり表: 本店の不正値行に NaN% や -1 が出ない
    const accountsTable = screen.getByRole('heading', { name: 'アカウントごとの重なり' }).parentElement!.parentElement!
    expect(within(accountsTable).queryByText(/NaN%/)).toBeNull()
    expect(within(accountsTable).queryByText('-1')).toBeNull()
    expect(within(accountsTable).getByText('20%')).toBeTruthy()

    // マトリクス: 配列から省かれた 0 件の組（本店→支店）は「0」、明示された NaN ペア（支店→本店）は「—」
    const matrixHeading = screen.getByRole('heading', { name: 'アカウント間 重複マトリクス' })
    const matrixCard = matrixHeading.parentElement!.parentElement!
    const bodyRows = matrixCard.querySelectorAll('tbody tr')
    const hontenCells = bodyRows[0].querySelectorAll('td')
    const shitenCells = bodyRows[1].querySelectorAll('td')
    // 本店行: [本店, 対角(—), 支店(0)]
    expect(hontenCells[2].textContent).toBe('0')
    // 支店行: [支店, 本店(—), 対角(—)]
    expect(shitenCells[1].textContent).toBe('—')
  })

  it('Worker と同じ形（0 件の組を省き重複ありの組のみ含む pairwiseOverlap）で 0 件の組が 0、重複ありの組がその数値になる', () => {
    fx.hookState = baseHookState({
      data: {
        computedAt: '2026-11-20T00:00:00Z',
        overlappingDeliveryCount: 3,
        perAccount: [
          { accountId: 'a1', accountName: '本店', friends: 20, dups: 2, dupRate: 0.1 },
          { accountId: 'a2', accountName: '支店', friends: 10, dups: 2, dupRate: 0.2 },
          { accountId: 'a3', accountName: 'EC店', friends: 5, dups: 0, dupRate: 0 },
        ],
        pairwiseOverlap: [
          { fromAccountId: 'a1', toAccountId: 'a2', overlap: 2 },
          { fromAccountId: 'a2', toAccountId: 'a1', overlap: 2 },
        ],
      },
    })

    render(<DuplicatesListV8 />)
    const matrixCard = screen.getByRole('heading', { name: 'アカウント間 重複マトリクス' }).parentElement!.parentElement!
    const bodyRows = matrixCard.querySelectorAll('tbody tr')
    // 本店行: [本店, 対角(—), 支店(2), EC店(0)]
    expect(bodyRows[0].querySelectorAll('td')[2].textContent).toBe('2')
    expect(bodyRows[0].querySelectorAll('td')[3].textContent).toBe('0')
    // EC店行: [EC店, 本店(0), 支店(0), 対角(—)]
    expect(bodyRows[2].querySelectorAll('td')[1].textContent).toBe('0')
    expect(bodyRows[2].querySelectorAll('td')[2].textContent).toBe('0')
  })
})
