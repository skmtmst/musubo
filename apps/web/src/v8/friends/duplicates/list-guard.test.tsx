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
        // a1 -> a2 は欠損、a2 -> a1 は NaN
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

  it('アカウント別の不正数値や欠損ペアを NaN% や 0 件と偽装せず「—」で表示する', () => {
    render(<DuplicatesListV8 />)

    // 重なって届いた配信は NaN を出さず未取得表示
    expect(screen.queryByText(/NaN/)).toBeNull()

    // アカウントごとの重なり表: 本店の不正値行に NaN% や -1 が出ない
    const accountsTable = screen.getByRole('heading', { name: 'アカウントごとの重なり' }).parentElement!.parentElement!
    expect(within(accountsTable).queryByText(/NaN%/)).toBeNull()
    expect(within(accountsTable).queryByText('-1')).toBeNull()
    expect(within(accountsTable).getByText('20%')).toBeTruthy()

    // マトリクス: 欠損ペアと NaN ペアが「0」に捏造されず「—」表示
    const matrixHeading = screen.getByRole('heading', { name: 'アカウント間 重複マトリクス' })
    const matrixCard = matrixHeading.parentElement!.parentElement!
    expect(within(matrixCard).queryByText('0')).toBeNull()
    expect(within(matrixCard).getAllByText('—').length).toBeGreaterThanOrEqual(2)
  })
})
