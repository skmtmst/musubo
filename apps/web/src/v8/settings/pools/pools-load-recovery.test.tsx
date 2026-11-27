// @vitest-environment happy-dom
/*
 * プール管理の補助取得失敗・読み込み中表示と再試行の振る舞い。
 * - LINEアカウント一覧だけが失敗してもプール一覧を残し、案内と再読み込みを出して復旧できる
 * - 所属アカウントの読み込み中は「所属アカウントなし」と誤表示せず、読み込み中表示を出す
 * - 所属アカウントの再読み込み連打・一覧の再読み込み連打で二重通信にならない
 */
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  poolsList: vi.fn(),
  lineAccountsList: vi.fn(),
  poolAccountsList: vi.fn(),
}))

vi.mock('@/lib/staff-role', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/staff-role')>()),
  useStaffRole: () => 'owner',
}))
vi.mock('@/components/shell/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())
vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
vi.mock('@/lib/pools-availability', () => ({ isPoolsFeatureAvailable: async () => true }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'acc-1' }) }))
vi.mock('@/components/layout/settings-inner-nav', () => ({ default: () => null }))
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      pools: {
        ...actual.api.pools,
        list: (...args: unknown[]) => mocks.poolsList(...args),
        accounts: {
          ...actual.api.pools.accounts,
          list: (...args: unknown[]) => mocks.poolAccountsList(...args),
        },
      },
      lineAccounts: {
        ...actual.api.lineAccounts,
        list: (...args: unknown[]) => mocks.lineAccountsList(...args),
      },
    },
  }
})

import PoolsV8 from './pools'

const POOLS = [
  { id: 'p1', name: 'メインの入り口', slug: 'main', isMain: true, updatedAt: '2026-10-10T00:00:00Z', confirmationRevision: 1 },
]

const ACCOUNTS = [
  { id: 'acc-1', name: '然 -NEN- 本店', stats: { friendCount: 120 } },
  { id: 'acc-2', name: '然 -NEN- 渋谷店', stats: { friendCount: 45 } },
]

beforeEach(() => {
  vi.clearAllMocks()
  mocks.poolsList.mockResolvedValue({ success: true, data: POOLS })
  mocks.lineAccountsList.mockResolvedValue({ success: true, data: ACCOUNTS })
  mocks.poolAccountsList.mockResolvedValue({ success: true, data: [{ id: 'm1', lineAccountId: 'acc-1' }] })
})

afterEach(() => {
  cleanup()
})

describe('プール管理の読み込み失敗表示と再試行', () => {
  it('LINEアカウント一覧だけが失敗してもプール一覧を残し、案内から再読み込みして復旧できる', async () => {
    let resolveAccountsRetry!: (value: unknown) => void
    mocks.lineAccountsList
      .mockRejectedValueOnce(new Error('accounts offline'))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveAccountsRetry = resolve }))

    render(<PoolsV8 />)

    await screen.findByText('メインの入り口')
    await screen.findByText(/LINEアカウント一覧を読み込めませんでした/)
    expect(screen.queryByText('プール一覧を表示できませんでした')).toBeNull()

    const retryBtn = screen.getByRole('button', { name: 'もう一度読み込む' })
    fireEvent.click(retryBtn)
    fireEvent.click(retryBtn)

    await waitFor(() => expect(mocks.lineAccountsList).toHaveBeenCalledTimes(2))

    resolveAccountsRetry({ success: true, data: ACCOUNTS })
    await screen.findByText('然 -NEN- 本店')
    expect(screen.queryByText(/LINEアカウント一覧を読み込めませんでした/)).toBeNull()
    expect(mocks.lineAccountsList).toHaveBeenCalledTimes(2)
  })

  it('所属アカウントの読み込み中は「所属アカウントなし」と出さず、失敗後の再試行連打も二重通信にならない', async () => {
    let resolveFirst!: (value: unknown) => void
    let resolveRetry!: (value: unknown) => void
    mocks.poolAccountsList
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveRetry = resolve }))

    render(<PoolsV8 />)

    await screen.findByText('メインの入り口')
    expect((await screen.findByLabelText('所属アカウントを読み込んでいます…')).getAttribute('aria-busy')).toBe('true')
    expect(screen.queryByText('所属アカウントなし')).toBeNull()

    resolveFirst({ success: false, error: 'temporary' })
    await screen.findByText(/所属アカウントを読み込めませんでした/)

    const retryBtn = screen.getByRole('button', { name: 'もう一度読み込む' })
    fireEvent.click(retryBtn)
    fireEvent.click(retryBtn)

    await waitFor(() => expect(mocks.poolAccountsList).toHaveBeenCalledTimes(2))

    resolveRetry({ success: true, data: [{ id: 'm1', lineAccountId: 'acc-1' }] })
    await screen.findByText('然 -NEN- 本店')
    expect(screen.queryByText(/所属アカウントを読み込めませんでした/)).toBeNull()
    expect(mocks.poolAccountsList).toHaveBeenCalledTimes(2)
  })
})
