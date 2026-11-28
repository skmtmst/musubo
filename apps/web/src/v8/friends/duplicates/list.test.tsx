// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const actions = vi.hoisted(() => ({ setStatus: vi.fn(), clearFilters: vi.fn(), loadCandidates: vi.fn(), filtering: false, failure: '', stats: null as import('./use-duplicates-data').DuplicatesStatsData | null, candidates: [] as import('@line-crm/shared').IdentityCandidateListItem[] }))

vi.mock('@/components/shell/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())
vi.mock('@/lib/staff-role', () => ({ useStaffIdentity: () => ({ id: 'staff-test' }) }))
vi.mock('@/lib/use-narrow-viewport', () => ({ useNarrowViewport: () => false }))
vi.mock('./use-duplicates-data', () => ({
  CANDIDATE_PAGE_SIZE: 50,
  useDuplicatesData: () => ({
    candidateTotal: actions.candidates.length, unfilteredCandidates: !actions.filtering, statusCounts: null,
    duplicateTotalText: '—', duplicateDetail: '読み込めませんでした', lowConfidenceCount: null,
    candidates: actions.candidates, data: actions.stats, query: '', status: '', page: 1,
    statsFailure: null, error: '', candidateError: actions.failure, candidatesLoading: false,
    setQuery: vi.fn(), setStatus: actions.setStatus, setPage: vi.fn(), clearFilters: actions.clearFilters, loadCandidates: actions.loadCandidates, load: vi.fn(), detect: vi.fn(),
  }),
}))

import DuplicatesList from './list'

beforeEach(() => { actions.filtering = false; actions.failure = ''; actions.stats = null; actions.candidates = [] })

afterEach(() => { cleanup(); vi.clearAllMocks() })

it('未知の状態と確からしさを一覧とCSVで安全な表示にする', async () => {
  actions.candidates = [{ id: 'candidate', status: '__proto__', confidence: { label: 'constructor', score: 0 },
    left: { label: '見本A', lineAccountName: '本店' }, right: { label: '見本B', lineAccountName: '支店' }, evidenceSummary: [], detectedAt: '2026-10-26T00:00:00Z', reviewedAt: null,
  }] as unknown as typeof actions.candidates
  const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fixture')
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  try {
    render(<DuplicatesList />)
    expect(screen.getByText('状態を確認できません')).toBeTruthy()
    expect(screen.getByText('未確認', { selector: 'span' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '表示中をCSVで書き出す' }))
    const text = await (create.mock.calls[0][0] as Blob).text()
    expect(text).toContain('状態を確認できません')
    expect(text).toContain('未確認')
  } finally { create.mockRestore(); revoke.mockRestore(); click.mockRestore() }
})

it('題から安全説明を開閉し、用語説明と候補の操作を保つ', () => {
  render(<DuplicatesList />)
  const toggle = screen.getByRole('button', { name: 'この画面の説明' })
  // 決まり2: 安全説明は帯に出さず題の「？」へ。
  expect(screen.queryByText(/自動では結び付けません/)).toBeNull()
  expect(toggle.closest('header')).not.toBeNull()
  expect(screen.queryByRole('button', { name: '友だちの説明' })).toBeNull()
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  fireEvent.click(toggle)
  const tip = () => document.getElementById(toggle.getAttribute('aria-describedby') ?? '')
  expect(tip()?.textContent).toContain('同じ人が2人に分かれていないか')
  expect(tip()?.textContent).toContain('結び付けるか決めます')
  expect(tip()?.textContent).toContain('自動では結び付けません')
  expect(tip()?.textContent).toContain('元の友だちと履歴は残ります')
  expect(tip()?.textContent).toMatch(/同じ人が別のアカウント/)
  fireEvent.click(toggle)
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  expect(screen.getByRole('button', { name: 'もう一度見直す' })).toBeTruthy()
})

it('状態の札は元の絞り込みの値を送る', () => {
  render(<DuplicatesList />)
  for (const [label, value] of [['未確認', 'pending'], ['保留', 'deferred'], ['結び付けた', 'linked'], ['別人', 'different'], ['すべて', '']]) {
    fireEvent.click(screen.getByRole('button', { name: label, exact: true }))
    expect(actions.setStatus).toHaveBeenLastCalledWith(value)
  }
})

it('候補0件を1〜0組と表示せず、検索の0件は条件を外せる', () => {
  actions.filtering = true
  render(<DuplicatesList />)
  expect(screen.getByText('条件に合う候補はありません')).toBeTruthy()
  expect(document.body.textContent).not.toContain('1〜0')
  fireEvent.click(screen.getByRole('button', { name: '条件を外す', exact: true }))
  expect(actions.clearFilters).toHaveBeenCalledOnce()
})
it('候補の取得失敗を0件にせず、候補だけ読み直す', () => {
  actions.failure = 'offline'
  render(<DuplicatesList />)
  expect(screen.queryByText('重複の候補はありません')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
  expect(actions.loadCandidates).toHaveBeenCalledOnce()
})


it('確認候補0と同じIDの重なりを区別し、登録の重なりの実数を保つ', () => {
  actions.stats = { totalFollowing: 4, uniquePeople: 2, friendDups: 2, duplicateGroups: 2, wastedPerBroadcastYen: 0, msgUnitYen: 0, perAccount: [{ accountId: 'a', accountName: '本店', friends: 4, dups: 2, dupRate: .5 }] }
  render(<DuplicatesList />)
  expect(screen.getByText('重複の候補はありません')).toBeTruthy()
  expect(screen.getByText('同じIDの登録を数えたものです。上の確認対象の候補の組数とは別の集計です。')).toBeTruthy()
  const cells = [...screen.getByText('本店').closest('tr')!.querySelectorAll('td')].map(cell => cell.textContent)
  expect(cells).toEqual(['本店', '4', '2', '50%'])
})
