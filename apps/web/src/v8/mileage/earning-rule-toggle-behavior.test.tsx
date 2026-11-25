// @vitest-environment happy-dom
/* たまる決めごとの状態切替を、保存中・失敗・成功まで実際に操作して確かめる。 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import V8EarningRulesTab from '@/v8/mileage/earning-rules'
import { MileageShell } from '@/v8/mileage/frame'
import type { MileageEarningRuleV6 } from '@/lib/api'

const calls = vi.hoisted(() => ({ earningRulesV6: vi.fn(), history: vi.fn(), friendsV6: vi.fn(), updateRule: vi.fn(), toast: vi.fn() }))
vi.mock('@/lib/api', () => ({
  api: {
    mileage: {
      earningRulesV6: calls.earningRulesV6,
      history: calls.history,
      friendsV6: calls.friendsV6,
      updateRule: calls.updateRule,
    },
  },
  ApiError: class extends Error { status?: number },
}))
vi.mock('@/components/shared/toast', () => ({ notifyToast: calls.toast }));
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

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-18T00:00:00Z'))
  calls.earningRulesV6.mockReset().mockResolvedValue({ success: true, data: overview([rule('r1', '決めごと', 'published')]) })
  calls.history.mockResolvedValue({ success: true, data: { summary: { byType: [] } } })
  calls.friendsV6.mockResolvedValue({ success: true, data: { balanceSource: 'musubo', items: [], summary: { available: 0, totalMembers: 0, withBalanceCount: 0, pending: 0, monthChange: 0, rankCounts: [], expiringMiles30d: null, nextExpiringAt: null }, pagination: { total: 0, limit: 1, offset: 0 }, measuredAt: '2026-09-01T00:00:00+09:00' } })
  calls.updateRule.mockReset()
  calls.toast.mockReset()
})
afterEach(() => { cleanup(); vi.useRealTimers() })

it('停止を先に表示し、失敗すると戻し、成功しても一覧を読み直さない', async () => {
  let reject!: (reason: Error) => void
  calls.updateRule.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail })).mockResolvedValueOnce({ success: true })
  render(<MileageShell.Provider value={{ tab: 'earning-rules', readonly: false, narrow: false, counts: {}, setCount: () => {} }}><V8EarningRulesTab /></MileageShell.Provider>)
  const name = await screen.findByText('決めごと')
  const row = name.closest('tr')!
  expect(row.textContent).toContain('動いています')
  fireEvent.click(within(row).getByRole('button', { name: /操作/ }))
  fireEvent.click(await screen.findByRole('menuitem', { name: '止める' }))
  expect(calls.updateRule).toHaveBeenCalledWith('r1', { isActive: false })
  expect(row.textContent).toContain('止めています')
  await act(async () => reject(new Error('offline')))
  await waitFor(() => expect(row.textContent).toContain('動いています'))
  expect(calls.toast).toHaveBeenCalledWith(expect.stringContaining('元に戻しました'), expect.objectContaining({ tone: 'error' }))
  fireEvent.click(within(row).getByRole('button', { name: /操作/ }))
  fireEvent.click(await screen.findByRole('menuitem', { name: '止める' }))
  await waitFor(() => expect(calls.updateRule).toHaveBeenCalledTimes(2))
  await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)) })
  expect(row.textContent).toContain('止めています')
  expect(calls.earningRulesV6).toHaveBeenCalledTimes(1)
})


it('EC 管理では空の決めごとの作成を理由付きで止める', async () => {
  calls.earningRulesV6.mockResolvedValue({ success: true, data: overview([]) })
  render(<MileageShell.Provider value={{ tab: 'earning-rules', readonly: false, narrow: false, counts: {}, setCount: () => {}, balanceSource: 'ec' }}><V8EarningRulesTab /></MileageShell.Provider>)
  const button = await screen.findByRole('button', { name: /最初の決めごとを作る/ })
  expect(button.getAttribute('aria-disabled')).toBe('true')
  expect(document.body.textContent).toContain('マイルは EC で管理しています。')
})
