// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MileageShell } from './frame'
import Rewards from './rewards'

const calls = vi.hoisted(() => ({ list: vi.fn(), stop: vi.fn(), folders: vi.fn(), toast: vi.fn() }))
vi.mock('@/lib/api', async original => ({
  ...(await original<typeof import('@/lib/api')>()),
  api: { mileage: { rewards: calls.list, stopReward: calls.stop }, folders: { list: calls.folders } },
}))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'account-1', loading: false }) }))
vi.mock('@/components/shared/toast', () => ({ notifyToast: calls.toast }))
vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
type Kind = 'coupon' | 'tag' | 'scenario' | 'template' | 'early_access' | 'rank'

function reward(id: string, name: string, overrides: Record<string, unknown> = {}, version: Record<string, unknown> = {}) {
  return {
    id,
    lineAccountId: 'account-1',
    programId: 'program-1',
    name,
    description: null,
    imageUrl: null,
    rewardKind: 'coupon' as Kind,
    status: 'published',
    sortOrder: 0,
    currentDraftVersionId: null,
    currentPublishedVersionId: 'version-1',
    currentVersion: {
      id: `${id}-version`,
      versionNumber: 1,
      status: 'published',
      revision: 1,
      requiredMiles: 500,
      stockLimit: null,
      perFriendLimit: null,
      startsAt: null,
      endsAt: null,
      benefitExpiresDays: null,
      commonActionVersionId: null,
      targetConditions: null,
      failurePolicy: 'refund',
      customerMessage: '',
      publishedAt: '2026-09-10T00:00:00.000Z',
      ...version,
    },
    exchangedThisMonth: 0,
    availableCodeCount: null,
    benefitName: null,
    createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt: '2026-09-10T00:00:00.000Z',
    ...overrides,
  }
}

function overviewOf(rewards: unknown) {
  return {
    rewards,
    summary: {
      publishedCount: 0,
      redeemedMilesThisMonth: 0,
      neverRedeemedFriendCount: null,
      mostRedeemedRewardName: null,
      mostRedeemedRewardCount: null,
    },
    reachMetrics: [],
    rankBenefits: [],
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-18T00:00:00Z'))
  calls.list.mockReset().mockResolvedValue({ success: true, data: overviewOf([reward('r1', '交換品')]) })
  calls.folders.mockResolvedValue({ success: true, data: [] })
  calls.stop.mockReset()
  calls.toast.mockReset()
})
afterEach(() => { cleanup(); vi.useRealTimers() })

it('使い道の停止を先に表示し、失敗すると戻し、成功しても一覧を読み直さない', async () => {
  let reject!: (reason: Error) => void
  calls.stop.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail })).mockResolvedValueOnce({ success: true })
  render(<MileageShell.Provider value={{ tab: 'rewards', readonly: false, narrow: false, counts: {}, setCount: () => {} }}><Rewards /></MileageShell.Provider>)
  const name = await screen.findByText('交換品')
  const row = name.closest('tr')!
  expect(row.textContent).toContain('出している')
  fireEvent.click(within(row).getByRole('button', { name: /操作/ }))
  fireEvent.click(await screen.findByRole('menuitem', { name: '出すのを止める' }))
  expect(calls.stop).toHaveBeenCalledWith('r1', 'account-1')
  expect(row.textContent).toContain('止めています')
  await act(async () => reject(new Error('offline')))
  await waitFor(() => expect(row.textContent).toContain('出している'))
  expect(calls.toast).toHaveBeenCalledWith(expect.stringContaining('元に戻しました'), expect.objectContaining({ tone: 'error' }))
  fireEvent.click(within(row).getByRole('button', { name: /操作/ }))
  fireEvent.click(await screen.findByRole('menuitem', { name: '出すのを止める' }))
  await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)) })
  expect(calls.stop).toHaveBeenCalledTimes(2)
  expect(row.textContent).toContain('止めています')
  expect(calls.list).toHaveBeenCalledTimes(1)
})


it('EC 管理では空の使い道の作成を理由付きで止める', async () => {
  calls.list.mockResolvedValue({ success: true, data: overviewOf([]) })
  render(<MileageShell.Provider value={{ tab: 'rewards', readonly: false, narrow: false, counts: {}, setCount: () => {}, balanceSource: 'ec' }}><Rewards /></MileageShell.Provider>)
  const button = await screen.findByRole('button', { name: /最初の使い道を作る/ })
  expect(button.getAttribute('aria-disabled')).toBe('true')
  expect(document.body.textContent).toContain('マイルは EC で管理しています。')
})
