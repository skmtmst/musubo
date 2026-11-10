// @vitest-environment happy-dom
/*
 * R600：運用集計だけが失敗しても、取得済みの会員候補と判定入口を残す。
 *
 * `/ec-commerce/identity-candidates` は2本の読み口を持つ。
 *   - 運用集計 `api.ecCommerce.operationIdentityCandidates`（件数・売上見込み・影響）
 *   - 候補一覧 `api.identityCandidates.list`（候補の行・判定入口）
 *
 * 直す前はこうだった。運用集計だけが 503 でも画面全体が汎用エラーに
 * 隠れ、取得済みの候補と「決める」まで消えた。R598と同種だが、
 * こちらは別画面・別取得経路なので独立して守る。
 *
 * 本物の React でマウントする。見るのは主な状態の言い分けだけ:
 *   - 正常 … 候補の行・判定入口・集計の数
 *   - 運用集計だけ503 … 候補は残り、集計欄に取得失敗と再試行
 *   - 運用集計だけ403 … 候補は残り、権限の案内（再試行は出さない）
 *   - 再試行復旧 … 集計の数が戻る
 *   - 候補だけ503 … 全面エラー（従来どおり、候補は出さない）
 *   - 両方0件 … 空の案内
 */
import React from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ApiError } from '@/lib/api'

const mocks = vi.hoisted(() => ({
  operations: vi.fn(),
  overview: vi.fn(),
  list: vi.fn(),
}))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'acc-1' }),
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
      withoutCandidates: 7,
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

const REVIEW_EMPTY = {
  success: true,
  data: { items: [], total: 0, limit: 20, offset: 0 },
}

beforeEach(() => {
  document.documentElement.dataset.theme='v8'; window.history.replaceState({}, '', '/ec-commerce/identity-candidates'); window.dispatchEvent(new Event('popstate'))
  vi.clearAllMocks()
  mocks.overview.mockResolvedValue({ success: true, data: { total: 7, subscriptions: 3 } })
  mocks.operations.mockResolvedValue(OPERATIONS_OK)
  mocks.list.mockResolvedValue(REVIEW_OK)
})

afterEach(() => { cleanup(); delete document.documentElement.dataset.theme })

describe('R600 運用集計の失敗でも会員候補を残す', () => {
  test('正常：候補の行・判定入口・集計の数を出す', async () => {
    render(<EcIdentityCandidatesPage />)
    expect(await screen.findByText('見本 141')).toBeTruthy()
    // 判定入口（1行ごとの操作）は候補と一緒に見える。
    // 行の右端は「…」1つ。判定入口はその中。
    fireEvent.click(screen.getAllByRole('button', { name: /の候補の操作/ })[0])
    expect(await screen.findByRole('menuitem', { name: '決める' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: '候補を見る' })).toBeTruthy()
    // 集計の数はサーバが数えた値を出す（：絵の言葉）。
    expect(screen.getByText('人が決める（5 件のうち）')).toBeTruthy()
    expect(screen.getByText('¥50,000')).toBeTruthy()
  })

  test('運用集計だけ503：候補と判定入口は残し、集計欄に取得失敗と再試行を出す', async () => {
    mocks.operations.mockRejectedValue(new ApiError(503))
    render(<EcIdentityCandidatesPage />)
    // 取得済みの候補と判定入口は隠さない。
    expect(await screen.findByText('見本 141')).toBeTruthy()
    fireEvent.click(screen.getAllByRole('button', { name: /の候補の操作/ })[0])
    expect(await screen.findByRole('menuitem', { name: '決める' })).toBeTruthy()
    // 集計欄はその場所で失敗を言い、やり直せる。
    expect(screen.getAllByText('読み込めませんでした').length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: 'もう一度読み込む' })).toBeTruthy()
    // 候補の読み口の汎用エラー（全面）は出さない。
    expect(screen.queryByText('本人照合の候補を読み込めませんでした')).toBeNull()
    // 読めていない集計を 0件と書かない。
    expect(screen.queryByText('0件')).toBeNull()
  })

  test('運用集計だけ403：候補は残し、権限の案内にする（再試行は出さない）', async () => {
    mocks.operations.mockRejectedValue(new ApiError(403))
    render(<EcIdentityCandidatesPage />)
    expect(await screen.findByText('見本 141')).toBeTruthy()
    fireEvent.click(screen.getAllByRole('button', { name: /の候補の操作/ })[0])
    expect(await screen.findByRole('menuitem', { name: '決める' })).toBeTruthy()
    expect(screen.getAllByText('表示する権限がありません').length).toBeGreaterThan(0)
    // 押しても直らない再試行の口は出さない。
    expect(screen.queryByRole('button', { name: 'もう一度読み込む' })).toBeNull()
  })

  test('再試行で運用集計が戻る', async () => {
    mocks.operations.mockRejectedValue(new ApiError(503))
    render(<EcIdentityCandidatesPage />)
    expect(await screen.findByText('見本 141')).toBeTruthy()
    mocks.operations.mockResolvedValue(OPERATIONS_OK)
    fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
    // 集計の数が戻り、失敗の文言は消える。
    await waitFor(() => expect(screen.getByText('人が決める（5 件のうち）')).toBeTruthy())
    expect(screen.queryByText('読み込めませんでした')).toBeNull()
  })

  test('候補だけ503：従来どおり全面エラーにし、候補は出さない', async () => {
    mocks.list.mockRejectedValue(new ApiError(503))
    render(<EcIdentityCandidatesPage />)
    expect(await screen.findByText('本人照合の候補を読み込めませんでした')).toBeTruthy()
    expect(screen.queryByText('見本 141')).toBeNull()
  })

  test('両方0件：空の案内にする', async () => {
    mocks.list.mockResolvedValue(REVIEW_EMPTY)
    render(<EcIdentityCandidatesPage />)
    expect(await screen.findByText('つき合わせる会員はありません')).toBeTruthy()
  })
})

 test('candidate-free people and revenue come from independent full summaries', async () => {
  render(<EcIdentityCandidatesPage />); await screen.findByText('見本 141');
  expect(screen.getByText('候補なし').closest('[data-kpi-presentation]')?.textContent).toContain('7');
  expect(screen.getByText(/50,000/)).toBeTruthy();
 });

vi.mock('@/components/shell/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())
vi.mock('@/lib/staff-role', async (importOriginal) => ({...await importOriginal<typeof import('@/lib/staff-role')>(),useStaffRole: () => 'owner'}))
