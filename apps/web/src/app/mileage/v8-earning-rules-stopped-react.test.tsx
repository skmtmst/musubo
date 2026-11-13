// @vitest-environment happy-dom
/*
 * V8 たまる決めごと：「止めているのみ」の見方を選ぶと止めている決めごとだけ出る。
 * 以前は既定と同じ条件で、動いているものも混ざっていた（管理画面 parity-D）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import V8EarningRulesTab from '@/v8/mileage/earning-rules'
import { MileageShell } from '@/v8/mileage/frame'
import type { MileageEarningRuleV6 } from '@/lib/api'

const calls = vi.hoisted(() => ({ earningRulesV6: vi.fn(), history: vi.fn(), friendsV6: vi.fn() }))
vi.mock('@/lib/api', () => ({
  api: {
    mileage: {
      earningRulesV6: calls.earningRulesV6,
      history: calls.history,
      friendsV6: calls.friendsV6,
    },
  },
  ApiError: class extends Error { status?: number },
}))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'acc-1', loading: false }),
}))
vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(),
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/mileage',
}))
vi.mock('@/lib/admin-session', () => ({ adminSessionHeaders: () => ({}) }))

function rule(id: string, name: string, status: 'published' | 'stopped'): MileageEarningRuleV6 {
  return {
    id,
    published: {
      name, eventType: 'purchase', source: null, amount: 10,
      initialStatus: 'available', validFrom: null, validUntil: null,
      status, updatedAt: '2026-09-01T00:00:00+09:00',
    },
    draft: {
      name, eventType: 'purchase', source: null, amount: 10,
      initialStatus: 'available', validFrom: null, validUntil: null,
      expiresAfterDays: null, cancellationEventTypes: [],
      targetConditions: null, sortOrder: 0,
    },
    draftVersion: 1,
    draftUpdatedAt: '2026-09-01T00:00:00+09:00',
    publishedVersion: status === 'published' ? 1 : null,
    metrics30d: { eligible: 0, granted: 0, grantedMiles: 0, excluded: 0 },
  }
}

const overview = (items: MileageEarningRuleV6[]) => ({
  items,
  pagination: { total: items.length, limit: 100, offset: 0 },
  unassignedLegacyCount: 0,
  measuredAt: '2026-09-01T00:00:00+09:00',
})

afterEach(cleanup)

describe('V8 たまる決めごとの「止めているのみ」', () => {
  it.each([true, false])('操作の説明は閲覧のみ %s に合う', async (readonly) => {
    calls.earningRulesV6.mockResolvedValue({ success: true, data: overview([rule('r1', '決めごと', 'published')]) })
    calls.history.mockResolvedValue({ success: true, data: { summary: { byType: [] } } })
    calls.friendsV6.mockResolvedValue({ success: true, data: { balanceSource: 'musubo', items: [], summary: { available: 0, totalMembers: 0, withBalanceCount: 0, pending: 0, monthChange: 0, rankCounts: [], expiringMiles30d: null, nextExpiringAt: null }, pagination: { total: 0, limit: 1, offset: 0 }, measuredAt: '2026-09-01T00:00:00+09:00' } })
    render(<MileageShell.Provider value={{ tab: 'earning-rules', readonly, narrow: false, counts: {}, setCount: () => {} }}><V8EarningRulesTab /></MileageShell.Provider>)
    await screen.findByText('決めごと')
    fireEvent.click(screen.getByRole('button', { name: 'この画面の説明' }))
    expect(screen.getByText(/この決めごとの履歴を見る/)).toBeTruthy()
    expect(Boolean(screen.queryByText(/編集・止める・複製/))).toBe(!readonly)
  })
  it('止めている決めごとだけ出す', async () => {
    const items = [rule('r1', '動いている決めごと', 'published'), rule('r2', '止めている決めごと', 'stopped')]
    calls.earningRulesV6.mockResolvedValue({ success: true, data: overview(items) })
    calls.history.mockResolvedValue({ success: true, data: { summary: { byType: [] } } })
    calls.friendsV6.mockResolvedValue({
      success: true,
      data: {
        balanceSource: 'musubo',
        items: [],
        summary: {
          available: 0, totalMembers: 0, withBalanceCount: 0, pending: 0,
          monthChange: 0, rankCounts: [], expiringMiles30d: null, nextExpiringAt: null,
        },
        pagination: { total: 0, limit: 1, offset: 0 },
        measuredAt: '2026-09-01T00:00:00+09:00',
      },
    })
    render(<V8EarningRulesTab />)
    await waitFor(() => expect(screen.getByText('動いている決めごと')).toBeTruthy())
    expect(screen.getByText('止めている決めごと')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('よく使う絞り込み'))
    fireEvent.click(await screen.findByRole('button', { name: '止めているのみ' }))
    await waitFor(() => expect(screen.queryByText('動いている決めごと')).toBeNull())
    expect(screen.getByText('止めている決めごと')).toBeTruthy()
  })
})

describe('85 題の右は副・主の順', () => {
  it('主ボタン（決めごとを作る）が右端に来る', async () => {
    calls.earningRulesV6.mockReset().mockResolvedValue({ success: true, data: overview([rule('r1', '動いている決めごと', 'published')]) })
    calls.history.mockResolvedValue({ success: true, data: { summary: { byType: [] } } })
    calls.friendsV6.mockResolvedValue({ success: true, data: { balanceSource: 'musubo', items: [], summary: { available: 0, totalMembers: 0, withBalanceCount: 0, pending: 0, monthChange: 0, rankCounts: [], expiringMiles30d: null, nextExpiringAt: null }, pagination: { total: 0, limit: 1, offset: 0 }, measuredAt: '2026-09-01T00:00:00+09:00' } })
    render(<V8EarningRulesTab />)
    await waitFor(() => expect(screen.getByRole('link', { name: '決めごとを作る' })).toBeTruthy())
    const region = document.querySelector('[data-page-heading-actions]')
    expect(region).toBeTruthy()
    const labels = [...region!.querySelectorAll('a, button')].map((el) => (el.textContent ?? '').replace(/\s+/g, ''))
    const csv = labels.findIndex((text) => text.includes('CSVで書き出す'))
    const create = labels.findIndex((text) => text.includes('決めごとを作る'))
    expect(csv).toBeGreaterThanOrEqual(0)
    expect(create).toBeGreaterThan(csv)
  })
})
