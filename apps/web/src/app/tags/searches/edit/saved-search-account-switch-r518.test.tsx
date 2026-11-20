import { getPageAction } from '@/test-utils/page-action'
// @vitest-environment happy-dom
/*
 * R518: 保存検索の編集でアカウントを切り替えたら、前のアカウントの
 * 内容と操作を消す。取得に失敗したら理由と再読み込みだけを出す。
 * 以前は失敗しても前の名前・条件と複製・保存・削除が残り、Bの読込再試行も
 * 出なかった（Aの条件でBへ複製する恐れがあった）。
 */
import React from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

const mockState = vi.hoisted(() => ({
  accountId: 'a1',
  /** b1 の詳細取得の応答。ok 以外はすべて失敗。 */
  bMode: 'network-error' as 'network-error' | 'forbidden' | 'not-found' | 'ok',
}))

const detailFor = (accountId: string, name: string) => ({
  id: 's1',
  name,
  scope: 'friends' as const,
  conditions: { all: [{ kind: 'name', op: 'contains', value: 'QA' }], any: [] },
  createdBy: 'staff-1',
  lineAccountId: accountId,
  isShared: false,
  displayOrder: 0,
  createdAt: '2026-09-01T00:00:00.000Z',
  revision: 1,
  matchCount: 0,
  usedIn: [],
  canDelete: true,
  accountScope: { type: 'line_account' as const, id: accountId },
  owner: { id: 'staff-1', isCurrentUser: true },
  match: {
    total: 0,
    byChannel: { line: 0, mail: 0 },
    calculatedAt: '2026-09-27T00:00:00.000Z',
  },
})

class MockApiError extends Error {
  status: number
  constructor(status: number, message?: string) {
    super(message)
    this.status = status
  }
}

vi.mock('@/lib/api', () => ({
  ApiError: MockApiError,
  api: {
    staff: { me: async () => ({ success: true, data: { role: 'owner' } }) },
    savedSearches: {
      detail: (id: string, accountId: string) => {
        if (accountId === 'a1') return Promise.resolve({ success: true, data: detailFor('a1', 'Aの検索') })
        if (mockState.bMode === 'ok') return Promise.resolve({ success: true, data: detailFor('b1', 'Bの検索') })
        if (mockState.bMode === 'not-found') return Promise.reject(new MockApiError(404, 'not found'))
        if (mockState.bMode === 'forbidden') return Promise.reject(new MockApiError(403, 'forbidden'))
        return Promise.reject(new Error('network down'))
      },
      list: () => Promise.resolve({
        success: true,
        items: [],
        summary: { total: 1, usedInBroadcasts: 0, zeroMatches: 1, callsThisMonth: 0 },
      }),
      update: () => Promise.resolve({ success: true, data: detailFor(mockState.accountId, 'x') }),
      preview: () => Promise.resolve({
        success: true,
        data: { match: { total: 0, byChannel: { line: 0, mail: 0 }, calculatedAt: '2026-09-27T01:00:00.000Z' } },
      }),
      create: () => Promise.resolve({ success: false, error: '使わない' }),
      delete: () => Promise.resolve({ success: true, data: null }),
    },
    tags: { list: () => Promise.resolve({ success: true, data: [] }) },
    supportMarks: { list: () => Promise.resolve({ success: true, data: [] }) },
    scenarios: { list: () => Promise.resolve({ success: true, data: [] }) },
    friendFields: { list: () => Promise.resolve({ success: true, data: [] }) },
    forms: { list: () => Promise.resolve({ success: true, data: [] }) },
    operators: { list: () => Promise.resolve({ success: true, data: [] }) },
    featureSettings: {
      visibility: () => Promise.resolve({ success: true, data: { features: {} } }),
    },
  },
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams('id=s1'),
  usePathname: () => '/tags/searches/edit',
}))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({
    selectedAccountId: mockState.accountId,
    selectedAccount: { id: mockState.accountId, name: mockState.accountId === 'a1' ? '店舗A' : '店舗B' },
  }),
}))

vi.mock('@/lib/use-feature-visibility', () => ({
  useFeatureVisibility: () => ({ status: 'ready', features: { saved_searches: true }, enabled: () => true }),
}))

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-18T00:00:00.000Z')) })
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  mockState.accountId = 'a1'
  mockState.bMode = 'network-error'
  vi.useRealTimers()
})

describe('R518 アカウント切替後の取得失敗', () => {
  test('通信断でAの内容を表示せず、複製・保存・削除できない。再試行でBだけ表示する', async () => {
    const { default: SavedSearchEditPage } = await import('./page')
    const { rerender } = render(<SavedSearchEditPage />)
    await screen.findByDisplayValue('Aの検索')

    // Bへ切り替えて詳細取得を通信断にする。
    mockState.accountId = 'b1'
    mockState.bMode = 'network-error'
    rerender(<SavedSearchEditPage />)

    await screen.findByText('保存した検索を読み込めませんでした')
    // 前のアカウントの内容は残さない。
    expect(screen.queryByDisplayValue('Aの検索')).toBeNull()
    // 編集画面の操作は出さない。
    expect(screen.queryByRole('button', { name: '複製して保存する' })).toBeNull()
    expect(screen.queryByRole('button', { name: '保存する' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'この条件を削除する' })).toBeNull()
    // Bの読込再試行は出す。
    const retry = screen.getByRole('button', { name: 'もう一度読み込む' })
    expect(retry).not.toBeNull()

    // 通信回復後の再試行でBの内容だけ表示する。
    mockState.bMode = 'ok'
    await act(async () => {
      fireEvent.click(retry)
    })
    await screen.findByDisplayValue('Bの検索')
    expect(screen.queryByDisplayValue('Aの検索')).toBeNull()
    expect(getPageAction({ name: '複製して保存する' })).not.toBeNull()
  })

  test('403でAの内容を表示せず、再試行だけ出す', async () => {
    const { default: SavedSearchEditPage } = await import('./page')
    const { rerender } = render(<SavedSearchEditPage />)
    await screen.findByDisplayValue('Aの検索')

    mockState.accountId = 'b1'
    mockState.bMode = 'forbidden'
    rerender(<SavedSearchEditPage />)

    await screen.findByText('保存した検索を読み込めませんでした')
    expect(screen.queryByDisplayValue('Aの検索')).toBeNull()
    expect(screen.queryByRole('button', { name: '複製して保存する' })).toBeNull()
    expect(screen.getByRole('button', { name: 'もう一度読み込む' })).not.toBeNull()
  })

  test('404でAの内容を表示せず、一覧へ戻る道を出す', async () => {
    const { default: SavedSearchEditPage } = await import('./page')
    const { rerender } = render(<SavedSearchEditPage />)
    await screen.findByDisplayValue('Aの検索')

    mockState.accountId = 'b1'
    mockState.bMode = 'not-found'
    rerender(<SavedSearchEditPage />)

    await screen.findByText('保存した検索が見つかりません')
    expect(screen.queryByDisplayValue('Aの検索')).toBeNull()
    expect(screen.queryByRole('button', { name: '複製して保存する' })).toBeNull()
    expect(screen.getByRole('link', { name: '保存した検索の一覧へ戻る' }).getAttribute('href')).toBe('/tags?tab=searches')
  })
})
