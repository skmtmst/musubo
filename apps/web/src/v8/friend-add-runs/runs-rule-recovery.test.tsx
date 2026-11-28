// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

const accountState = vi.hoisted(() => ({ id: 'account-a' }))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  usePathname: () => '/friend-add-settings/runs',
  useSearchParams: () => new URLSearchParams(''),
}))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({
    selectedAccountId: accountState.id,
    accounts: [{ id: 'account-a', name: '本店' }, { id: 'account-b', name: '2号店' }],
    loading: false,
  }),
}))
vi.mock('@/components/shell/page-chrome', () => ({
  usePageTitle: () => {},
  usePageCrumbs: () => {},
}))
vi.mock('@/lib/staff-role', async (importOriginal: () => Promise<typeof import('@/lib/staff-role')>) => {
  const actual = await importOriginal()
  return { ...actual, useStaffRole: () => 'owner' }
})

import FriendAddRunsV8 from './runs'

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })

const RUN_ITEM = {
  id: 'run-1',
  receivedAt: '2026-09-07T01:32:00.000Z',
  processedAt: '2026-09-07T01:32:00.800Z',
  friend: { id: 'friend-1', displayName: '山田太郎', redacted: false },
  friendKind: 'first_time',
  attribution: { status: 'captured', routeId: 'route-1', routeName: '店頭QR', reason: null },
  rule: { id: 'rule-shop', name: '店頭QRの初回案内', versionId: 'v1', versionNumber: 1 },
  scenario: null,
  actions: { total: 0, failed: 0 },
  deliveryCount: 1,
  status: 'completed',
  errorCode: null,
}

const SUMMARY = {
  recentFriends: 12,
  recentEvents: 15,
  cumulativeDeliveries: 30,
  scenarioStarts: 8,
  averageSendTimeMs: 700,
  failed: 0,
  totalRuns: 15,
  lastDeliveryAt: '2026-09-07T01:32:00.000Z',
}

beforeEach(() => {
  accountState.id = 'account-a'
  document.documentElement.dataset.theme = 'v8'
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  delete document.documentElement.dataset.theme
})

describe('友だち追加時の実行結果：読み込み失敗表示とその場復旧', () => {
  it('配信設定の取得に失敗しても実行結果は表示し、注意帯と「設定を読み直す」で一時停止と二重送信防止表示を復旧できる', async () => {
    let ruleAttempts = 0
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const target = new URL(String(input))
      if (target.pathname === '/api/staff/me') return json({ success: true, data: { role: 'owner' } })
      if (target.pathname === '/api/friend-add-runs') {
        return json({ success: true, data: { items: [RUN_ITEM], total: 1, nextCursor: null, summary: SUMMARY } })
      }
      if (target.pathname === '/api/friend-add-rules/rule-shop') {
        ruleAttempts += 1
        if (ruleAttempts === 1) return json({ success: false, error: 'temporary rule failure' }, 500)
        return json({
          success: true,
          data: {
            rule: {
              id: 'rule-shop',
              accountId: 'account-a',
              name: '店頭QRの初回案内',
              status: 'published',
              version: 3,
              definition: { resendSuppressionHours: 24 },
            },
          },
        })
      }
      return json({ success: true, data: null })
    })

    render(<FriendAddRunsV8 />)
    await screen.findByText('山田太郎')
    await screen.findByText(/配信設定の状態を読み込めませんでした/)

    const stopBtn = screen.getByRole('button', { name: '一時停止する' }) as HTMLButtonElement
    expect(stopBtn.disabled).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: '設定を読み直す' }))

    await waitFor(() => expect(stopBtn.disabled).toBe(false))
    expect(screen.queryByText(/配信設定の状態を読み込めませんでした/)).toBeNull()
    expect(screen.getByText('有効')).toBeTruthy()
    expect(ruleAttempts).toBe(2)
  })

  it('実行結果の取得中は4つのKPIカードがローディングになり、取得失敗時は「内訳はまだありません」と偽の空表示を出さず失敗を表示する', async () => {
    let resolveRuns!: (value: Response) => void
    let attempts = 0
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const target = new URL(String(input))
      if (target.pathname === '/api/staff/me') return json({ success: true, data: { role: 'owner' } })
      if (target.pathname === '/api/friend-add-runs') {
        attempts += 1
        if (attempts === 1) return new Promise<Response>((resolve) => { resolveRuns = resolve })
        return json({ success: false, error: 'runs unavailable' }, 200)
      }
      if (target.pathname === '/api/friend-add-rules/rule-shop') {
        return json({
          success: true,
          data: {
            rule: {
              id: 'rule-shop',
              accountId: 'account-a',
              name: '店頭QRの初回案内',
              status: 'published',
              version: 3,
              definition: { resendSuppressionHours: 24 },
            },
          },
        })
      }
      return json({ success: true, data: null })
    })

    const { container } = render(<FriendAddRunsV8 />)
    await waitFor(() => expect(attempts).toBe(1))

    const kpiBand = container.querySelector('[data-design="KPIs"]')!
    expect(kpiBand.querySelectorAll('[aria-busy="true"]').length).toBe(4)
    expect(screen.queryByText('内訳はまだありません')).toBeNull()

    await act(async () => {
      resolveRuns(json({ success: false, error: 'runs unavailable' }, 200))
    })

    await screen.findByText('実行結果を読み込めませんでした')
    expect(screen.getByText('内訳を読み込めませんでした')).toBeTruthy()
    expect(screen.queryByText('内訳はまだありません')).toBeNull()
    expect(kpiBand.textContent).toContain('読み込めませんでした')
    expect(kpiBand.textContent).not.toContain('記録を始めてからの合計です')
  })

  it('設定を読み直すの二重押しを防ぎ、アカウント切替後の古い設定応答を破棄する', async () => {
    let resolveOldRetry!: (value: Response) => void
    let accountARuleCalls = 0
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const target = new URL(String(input))
      if (target.pathname === '/api/staff/me') return json({ success: true, data: { role: 'owner' } })
      if (target.pathname === '/api/friend-add-runs') {
        const acc = target.searchParams.get('account_id')
        return json({
          success: true,
          data: {
            items: [{ ...RUN_ITEM, id: `run-${acc}`, friend: { id: `f-${acc}`, displayName: acc === 'account-b' ? '2号店の友だち' : '本店の友だち', redacted: false } }],
            total: 1,
            nextCursor: null,
            summary: SUMMARY,
          },
        })
      }
      if (target.pathname === '/api/friend-add-rules/rule-shop') {
        const acc = target.searchParams.get('account_id') ?? target.searchParams.get('accountId')
        if (acc === 'account-b') {
          return json({
            success: true,
            data: {
              rule: {
                id: 'rule-shop',
                accountId: 'account-b',
                name: '2号店の案内',
                status: 'paused',
                version: 2,
                definition: { resendSuppressionHours: 0 },
              },
            },
          })
        }
        accountARuleCalls += 1
        if (accountARuleCalls === 1) return json({ success: false, error: 'rule fail' }, 500)
        return new Promise<Response>((resolve) => { resolveOldRetry = resolve })
      }
      return json({ success: true, data: null })
    })

    const view = render(<FriendAddRunsV8 />)
    await screen.findByText('本店の友だち')
    const retryBtn = await screen.findByRole('button', { name: '設定を読み直す' })

    fireEvent.click(retryBtn)
    fireEvent.click(retryBtn)
    expect(accountARuleCalls).toBe(2)

    accountState.id = 'account-b'
    view.rerender(<FriendAddRunsV8 />)
    await screen.findByText('2号店の友だち')
    await waitFor(() => expect(screen.getByText('無効')).toBeTruthy())

    await act(async () => {
      resolveOldRetry(json({
        success: true,
        data: {
          rule: {
            id: 'rule-shop',
            accountId: 'account-a',
            name: '古い本店の案内',
            status: 'published',
            version: 9,
            definition: { resendSuppressionHours: 48 },
          },
        },
      }))
      await Promise.resolve()
    })

    expect(screen.getByText('無効')).toBeTruthy()
    expect(screen.queryByText('有効')).toBeNull()
  })
})
