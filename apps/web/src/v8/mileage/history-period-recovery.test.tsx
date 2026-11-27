// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  accountId: 'acc-1',
  history: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams('tab=history'),
  usePathname: () => '/mileage',
}))
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children?: React.ReactNode }) => <a href={href}>{children}</a>,
}))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: state.accountId, loading: false }),
}))
vi.mock('@/components/shell/page-chrome', () => ({
  usePageTitle: () => undefined,
  usePageCrumbs: () => undefined,
}))
vi.mock('./frame', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./frame')>()
  return {
    ...actual,
    useMileageShell: () => ({ tab: 'history', readonly: false, narrow: false, balanceSource: 'line' }),
  }
})
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      mileage: {
        ...actual.api.mileage,
        history: (params: Record<string, unknown>) => state.history(params),
      },
    },
  }
})

import HistoryTab from './history'
import { flushListUrlState } from '@/components/shared/list-url-state'

function makeListResponse(name = '山田花子') {
  return {
    success: true,
    data: {
      items: [
        {
          id: 'h-1',
          friendId: 'f-1',
          primaryFriendId: 'f-1',
          displayName: name,
          pictureUrl: null,
          entryType: 'grant',
          status: 'available',
          amount: 120,
          reason: '来店',
          source: 'rule',
          hasSourceEvent: true,
          sourceReferenceId: null,
          ruleName: '来店特典',
          mode: 'automatic',
          executedByStaffName: null,
          lineAccountName: '本店',
          balanceAfter: 320,
          occurredAt: '2026-10-01T00:00:00.000Z',
        },
      ],
      summary: { byType: [], manualCount: 1, pendingCount: 0 },
      pagination: { total: 1, limit: 20, offset: 0 },
    },
  }
}

function makePeriodResponse(overrides?: { total?: number; grantAmount?: number; spendAmount?: number; spendCount?: number }) {
  const total = overrides?.total ?? 42
  const grantAmount = overrides?.grantAmount ?? 1500
  const spendAmount = overrides?.spendAmount ?? -600
  const spendCount = overrides?.spendCount ?? 7
  return {
    success: true,
    data: {
      items: [],
      summary: {
        byType: [
          { entryType: 'grant', count: 30, amount: grantAmount },
          { entryType: 'spend', count: spendCount, amount: spendAmount },
          { entryType: 'reversal', count: 5, amount: -100 },
        ],
      },
      pagination: { total, limit: 1, offset: 0 },
    },
  }
}

beforeEach(() => {
  state.accountId = 'acc-1'
  state.history.mockReset()
  flushListUrlState()
  window.history.replaceState(null, '', '/mileage?tab=history')
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('マイル履歴の直近30日集計の読み込みとやり直し', () => {
  it('読み込み中は4つのKPIカードすべてがローディング状態になり、偽の「交換 0 件」を出さない', async () => {
    let resolveList!: (value: unknown) => void
    let resolvePeriod!: (value: unknown) => void
    state.history.mockImplementation((params: Record<string, unknown>) => {
      if (params.limit === 1) return new Promise((resolve) => { resolvePeriod = resolve })
      return new Promise((resolve) => { resolveList = resolve })
    })

    const { container } = render(<HistoryTab />)
    await waitFor(() => expect(state.history).toHaveBeenCalledTimes(2))

    const statsRegion = container.querySelector('[data-template-region="stats"]') ?? container
    const busyCards = statsRegion.querySelectorAll('[aria-busy="true"]')
    expect(busyCards.length).toBe(4)
    expect(statsRegion.textContent).not.toContain('交換 0 件')

    await act(async () => {
      resolveList(makeListResponse())
      resolvePeriod(makePeriodResponse())
    })
    await screen.findByText('山田花子')
    expect(statsRegion.textContent).toContain('交換 7 件')
  })

  it('直近30日集計だけが失敗しても一覧を保ち、偽の「交換 0 件」を出さず「集計を読み直す」でその場復旧できる', async () => {
    let periodAttempts = 0
    state.history.mockImplementation(async (params: Record<string, unknown>) => {
      if (params.limit === 1) {
        periodAttempts += 1
        if (periodAttempts === 1) throw new Error('summary down')
        return makePeriodResponse({ total: 88, grantAmount: 2400, spendAmount: -900, spendCount: 11 })
      }
      return makeListResponse('佐藤太郎')
    })

    const { container } = render(<HistoryTab />)
    await screen.findByText('佐藤太郎')

    const statsRegion = container.querySelector('[data-template-region="stats"]') ?? container
    expect(statsRegion.textContent).not.toContain('交換 0 件')
    expect(statsRegion.textContent).toContain('集計を読み込めませんでした')
    expect(screen.getByText(/直近30日の集計を読み込めませんでした/)).toBeTruthy()

    const callsBeforeRetry = state.history.mock.calls.length
    const retryBtn = screen.getByRole('button', { name: '集計を読み直す' })
    fireEvent.click(retryBtn)

    await waitFor(() => expect(statsRegion.textContent).toContain('交換 11 件'))
    expect(statsRegion.textContent).toContain('2,400')
    expect(statsRegion.textContent).toContain('900')
    expect(screen.queryByText(/直近30日の集計を読み込めませんでした/)).toBeNull()
    expect(screen.getByText('佐藤太郎')).toBeTruthy()
    // 一覧は読み直さず、直近30日集計（limit=1）だけを1回呼ぶ
    expect(state.history.mock.calls.length).toBe(callsBeforeRetry + 1)
    expect(state.history.mock.calls.at(-1)?.[0]).toMatchObject({ accountId: 'acc-1', limit: 1 })
  })

  it('直近30日集計のHTTP 200 success:false も失敗として扱い、再試行中の二重押しとアカウント切替後の古い応答を防ぐ', async () => {
    let finishRetry!: (value: unknown) => void
    let retryStarted = false
    state.history.mockImplementation((params: Record<string, unknown>) => {
      if (params.accountId === 'acc-2') {
        if (params.limit === 1) {
          return Promise.resolve(makePeriodResponse({ total: 15, grantAmount: 500, spendAmount: -200, spendCount: 3 }))
        }
        return Promise.resolve(makeListResponse('別アカウントの友だち'))
      }
      if (params.limit === 1) {
        if (!retryStarted) {
          retryStarted = true
          return Promise.resolve({ success: false, error: 'summary unavailable' })
        }
        return new Promise((resolve) => { finishRetry = resolve })
      }
      return Promise.resolve(makeListResponse('最初のアカウント'))
    })

    const view = render(<HistoryTab />)
    await screen.findByText('最初のアカウント')
    const retryBtn = await screen.findByRole('button', { name: '集計を読み直す' })

    const callsBefore = state.history.mock.calls.length
    fireEvent.click(retryBtn)
    fireEvent.click(retryBtn)
    expect(state.history.mock.calls.length).toBe(callsBefore + 1)

    // 再試行中にアカウント切替 → 古い応答が後から返っても新しいアカウントの集計を上書きしない
    state.accountId = 'acc-2'
    view.rerender(<HistoryTab />)
    await screen.findByText('別アカウントの友だち')
    const statsRegion = view.container.querySelector('[data-template-region="stats"]') ?? view.container
    await waitFor(() => expect(statsRegion.textContent).toContain('交換 3 件'))

    await act(async () => {
      finishRetry(makePeriodResponse({ total: 999, grantAmount: 99999, spendAmount: -8888, spendCount: 77 }))
      await Promise.resolve()
    })

    expect(statsRegion.textContent).toContain('交換 3 件')
    expect(statsRegion.textContent).not.toContain('交換 77 件')
    expect(within(statsRegion as HTMLElement).queryByText('99,999')).toBeNull()
  })
})
