// @vitest-environment happy-dom
/*
 * R600 残件（独立オラクル由来）：アカウント切替と運用集計の新旧管理。
 *
 * この画面は運用集計を2か所から読む。ページ本体の集計欄
 * （`loadOperations`・`limit: 100`）と、上部タブの件数バッジ
 * （`EcTabs`・`limit: 1`・`alive` ガード済み）である。残件は本体側の
 * 新旧管理の欠落なので、mock は `limit` で両者を分け、タブ側は即時・
 * 別番号（901/902）で返して本体の数値判定に混ざらないようにする。
 *
 * - アカウントAの本体集計が保留中にBへ切り替わり、Bの集計（222件）が
 *   確定したあと、遅れて届いたAの成功（111件）がBの集計を上書きしない。
 *   候補一覧はBのまま残る。
 * - A→B→Aと戻っても、最初のAの遅延応答が今のA（333件）を上書きしない。
 * - 遅れて届いたAの失敗がBの確定集計（222件）を壊さない。
 *
 * 本物の React でマウントし、数値と候補行の見え方だけを見る。
 */
import React from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { ApiError } from '@/lib/api'

const mocks = vi.hoisted(() => ({
  operations: vi.fn(),
  overview: vi.fn(),
  list: vi.fn(),
  accountId: 'acc-1',
}))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: mocks.accountId }),
}))

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) =>
    React.createElement('a', { href }, children),
}))

vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), forward: vi.fn() }),
  usePathname: () => '/ec-commerce/identity-candidates',
  useSearchParams: () => new URLSearchParams(),
}))

vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  return {
    ...actual,
    api: {
      ...actual.api,
      ecCommerce: {
        ...actual.api.ecCommerce,
        overview: mocks.overview,
        operationIdentityCandidates: mocks.operations,
      },
      identityCandidates: {
        ...actual.api.identityCandidates,
        list: mocks.list,
      },
    },
  }
})

import EcIdentityCandidatesPage from './page'

const REVIEW_ITEM = {
  id: 'ec-cand-1',
  kind: 'ec_member',
  status: 'pending',
  version: 1,
  confidence: { score: 82, label: 'high' },
  left: {
    kind: 'ec_event', id: 'ec-left-1', label: '見本 141', detail: '注文 #1001',
    lineAccountId: 'acc-1', lineAccountName: 'テスト店', shopKey: null,
    attributes: [{ label: 'メールアドレス', valuePreview: 'ya***@example.com', verified: true }],
  },
  right: {
    kind: 'friend', id: 'friend-right-1', label: '山田 たろう', detail: null,
    lineAccountId: 'acc-1', lineAccountName: 'テスト店', shopKey: null,
    attributes: [],
  },
  evidenceSummary: ['メールアドレスが同じ'],
  detectedAt: '2026-09-20T10:00:00.000Z',
  reviewedAt: null,
}

const OPERATIONS_OK = {
  success: true,
  data: {
    items: [],
    total: 0,
    summary: {
      unmatched: 5,
      candidates: 2,
      candidateExternalCustomers: 2,
      duplicateSuspicions: 1,
      linked: 10,
      potentialRevenue: 50000,
    },
  },
}

const REVIEW_OK = {
  success: true,
  data: { items: [REVIEW_ITEM], total: 1, limit: 20, offset: 0 },
}

function opsWithUnmatched(n: number) {
  return {
    ...OPERATIONS_OK,
    data: { ...OPERATIONS_OK.data, summary: { ...OPERATIONS_OK.data.summary, unmatched: n } },
  }
}

function reviewFor(accountId: string, label: string) {
  return {
    ...REVIEW_OK,
    data: {
      ...REVIEW_OK.data,
      items: [{
        ...REVIEW_ITEM,
        id: `${accountId}-candidate`,
        left: { ...REVIEW_ITEM.left, label, lineAccountId: accountId },
      }],
    },
  }
}

/*
 * 上部タブ（`limit: 1`）は即時・別番号で返し、本体の数値判定に混ざらない
 * ようにする。タブ側は `alive` ガード済みで、この試験の対象外。
 */
function mockOperationsTabsPassthrough() {
  mocks.overview.mockResolvedValue({ success: true, data: { total: 7, subscriptions: 3 } })
}

function isTabsCall(args: { limit?: number }): boolean {
  return args.limit === 1
}

function tabsResponse(accountId: string) {
  return Promise.resolve(opsWithUnmatched(accountId === 'acc-1' ? 901 : 902))
}

beforeEach(() => {
  document.documentElement.dataset.theme='v8'; window.history.replaceState({}, '', '/ec-commerce/identity-candidates'); window.dispatchEvent(new Event('popstate'))
  vi.clearAllMocks()
  mocks.accountId = 'acc-1'
  mockOperationsTabsPassthrough()
  mocks.list.mockResolvedValue(REVIEW_OK)
})

afterEach(() => { cleanup(); delete document.documentElement.dataset.theme })

describe('アカウント切替でも今のアカウントの集計を保つ（R600残件）', () => {
  test('遅れて届いたAの成功がBの集計を上書きしない', async () => {
    let finishPageA!: (value: typeof OPERATIONS_OK) => void
    const pendingPageA = new Promise<typeof OPERATIONS_OK>((resolve) => { finishPageA = resolve })
    let pageAUsed = false
    mocks.operations.mockImplementation((args: { lineAccountId: string; limit?: number }) => {
      if (isTabsCall(args)) return tabsResponse(args.lineAccountId)
      if (args.lineAccountId === 'acc-1' && !pageAUsed) {
        pageAUsed = true
        return pendingPageA
      }
      return Promise.resolve(opsWithUnmatched(222))
    })
    mocks.list.mockImplementation(({ lineAccountId }: { lineAccountId: string }) =>
      Promise.resolve(reviewFor(lineAccountId, lineAccountId === 'acc-1' ? 'Current A candidate' : 'Current B candidate')),
    )
    const view = render(<EcIdentityCandidatesPage />)
    expect(await screen.findByText('Current A candidate')).toBeTruthy()

    mocks.accountId = 'acc-2'
    view.rerender(<EcIdentityCandidatesPage />)
    expect(await screen.findByText('Current B candidate')).toBeTruthy()
    expect(await screen.findByText('人が決める（222 件のうち）')).toBeTruthy()

    await act(async () => { finishPageA(opsWithUnmatched(111)); await pendingPageA })

    expect(screen.queryByText('Current A candidate')).toBeNull()
    expect(screen.queryByText('人が決める（111 件のうち）')).toBeNull()
    expect(screen.getByText('人が決める（222 件のうち）')).toBeTruthy()
  })

  test('A→B→Aと戻っても最初のAの遅延成功が今のAを上書きしない', async () => {
    let finishFirstPageA!: (value: typeof OPERATIONS_OK) => void
    const pendingFirstPageA = new Promise<typeof OPERATIONS_OK>((resolve) => { finishFirstPageA = resolve })
    let firstPageAUsed = false
    mocks.operations.mockImplementation((args: { lineAccountId: string; limit?: number }) => {
      if (isTabsCall(args)) return tabsResponse(args.lineAccountId)
      if (args.lineAccountId === 'acc-1') {
        if (!firstPageAUsed) {
          firstPageAUsed = true
          return pendingFirstPageA
        }
        return Promise.resolve(opsWithUnmatched(333))
      }
      return Promise.resolve(opsWithUnmatched(222))
    })
    mocks.list.mockImplementation(({ lineAccountId }: { lineAccountId: string }) =>
      Promise.resolve(reviewFor(lineAccountId, lineAccountId === 'acc-1' ? 'Current A candidate' : 'Current B candidate')),
    )
    const view = render(<EcIdentityCandidatesPage />)
    expect(await screen.findByText('Current A candidate')).toBeTruthy()

    mocks.accountId = 'acc-2'
    view.rerender(<EcIdentityCandidatesPage />)
    expect(await screen.findByText('Current B candidate')).toBeTruthy()
    expect(await screen.findByText('人が決める（222 件のうち）')).toBeTruthy()

    mocks.accountId = 'acc-1'
    view.rerender(<EcIdentityCandidatesPage />)
    expect(await screen.findByText('Current A candidate')).toBeTruthy()
    expect(await screen.findByText('人が決める（333 件のうち）')).toBeTruthy()

    await act(async () => { finishFirstPageA(opsWithUnmatched(111)); await pendingFirstPageA })

    expect(screen.getByText('Current A candidate')).toBeTruthy()
    expect(screen.queryByText('人が決める（111 件のうち）')).toBeNull()
    expect(screen.getByText('人が決める（333 件のうち）')).toBeTruthy()
  })

  test('遅れて届いたAの失敗がBの確定集計を壊さない', async () => {
    let failPageA!: (err: unknown) => void
    const pendingPageA = new Promise<typeof OPERATIONS_OK>((_, reject) => { failPageA = reject })
    // 未処理の rejection で試験自体を落とさない。
    pendingPageA.catch(() => {})
    let pageAUsed = false
    mocks.operations.mockImplementation((args: { lineAccountId: string; limit?: number }) => {
      if (isTabsCall(args)) return tabsResponse(args.lineAccountId)
      if (args.lineAccountId === 'acc-1' && !pageAUsed) {
        pageAUsed = true
        return pendingPageA
      }
      return Promise.resolve(opsWithUnmatched(222))
    })
    mocks.list.mockImplementation(({ lineAccountId }: { lineAccountId: string }) =>
      Promise.resolve(reviewFor(lineAccountId, lineAccountId === 'acc-1' ? 'Current A candidate' : 'Current B candidate')),
    )
    const view = render(<EcIdentityCandidatesPage />)
    expect(await screen.findByText('Current A candidate')).toBeTruthy()

    mocks.accountId = 'acc-2'
    view.rerender(<EcIdentityCandidatesPage />)
    expect(await screen.findByText('Current B candidate')).toBeTruthy()
    expect(await screen.findByText('人が決める（222 件のうち）')).toBeTruthy()

    await act(async () => {
      failPageA(new ApiError(503))
      await pendingPageA.catch(() => {})
    })

    expect(screen.getByText('Current B candidate')).toBeTruthy()
    expect(screen.getByText('人が決める（222 件のうち）')).toBeTruthy()
    expect(screen.queryByText('読み込めませんでした')).toBeNull()
  })
})

vi.mock('@/components/shell/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())
vi.mock('@/lib/staff-role', async (importOriginal) => ({...await importOriginal<typeof import('@/lib/staff-role')>(),useStaffRole: () => 'owner'}))
