// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  usersList: vi.fn(),
  accountsList: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams('tab=merged'),
  usePathname: () => '/friends',
}))
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children?: React.ReactNode }) => <a href={href}>{children}</a>,
}))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'acc-1', loading: false }),
}))
vi.mock('@/components/shell/page-chrome', () => ({
  usePageTitle: () => undefined,
  usePageCrumbs: () => undefined,
}))
vi.mock('@/lib/staff-role', () => ({
  useStaffRole: () => 'owner',
  canManageRole: () => true,
}))
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      usersGrouped: { ...actual.api.usersGrouped, list: fixture.usersList },
      lineAccounts: { ...actual.api.lineAccounts, list: fixture.accountsList },
    },
  }
})

import MergedUsersV8 from './merged'
import { flushListUrlState } from '@/components/shared/list-url-state'

const ROW = {
  identityKey: 'id-1',
  displayName: '鈴木一郎',
  emails: ['ichiro@example.com'],
  phones: [],
  accounts: [
    {
      friendId: 'f-1',
      accountId: 'acc-1',
      accountName: '渋谷本店',
      lineUserId: 'U001',
      isFollowing: true,
      joinedAt: '2026-09-01T00:00:00Z',
    },
  ],
  identityKeyKind: 'uid',
  lastActivityAt: '2026-10-01T00:00:00Z',
}

beforeEach(() => {
  document.documentElement.dataset.theme = 'v8'
  flushListUrlState()
  window.history.replaceState(null, '', '/friends?tab=merged')
  fixture.usersList.mockReset()
  fixture.accountsList.mockReset()
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  delete document.documentElement.dataset.theme
})

describe('統合ユーザー：アカウント候補取得失敗とその場復旧・KPI状態', () => {
  it('lineAccounts 取得が拒否されても一覧を保ち、注意帯の「候補を読み直す」でアカウント候補を復旧できる', async () => {
    fixture.usersList.mockResolvedValue({
      success: true,
      data: { memberAccountId: 'acc-1', rows: [ROW], total: 1, page: 1, pageSize: 50, computedAt: '' },
    })
    fixture.accountsList
      .mockRejectedValueOnce(new Error('accounts offline'))
      .mockResolvedValueOnce({
        success: true,
        data: [
          { id: 'acc-1', name: '渋谷本店', isActive: true },
          { id: 'acc-2', name: '新宿店', isActive: true },
        ],
      })

    render(<MergedUsersV8 />)
    await screen.findByText('鈴木一郎')
    await screen.findByText(/所属アカウントの候補を読み込めませんでした/)

    const listCallsBefore = fixture.usersList.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: '候補を読み直す' }))

    await waitFor(() => expect(screen.queryByText(/所属アカウントの候補を読み込めませんでした/)).toBeNull())
    expect(fixture.accountsList).toHaveBeenCalledTimes(2)
    // 一覧は読み直さない
    expect(fixture.usersList).toHaveBeenCalledTimes(listCallsBefore)
    expect(screen.getByText('鈴木一郎')).toBeTruthy()
  })

  it('候補を読み直すの二重押しを防ぎ、HTTP 200 success:false も失敗として扱う', async () => {
    let finishAccounts!: (value: unknown) => void
    fixture.usersList.mockResolvedValue({
      success: true,
      data: { memberAccountId: 'acc-1', rows: [ROW], total: 1, page: 1, pageSize: 50, computedAt: '' },
    })
    fixture.accountsList
      .mockResolvedValueOnce({ success: false, error: 'accounts unavailable' })
      .mockImplementationOnce(() => new Promise((resolve) => { finishAccounts = resolve }))

    render(<MergedUsersV8 />)
    await screen.findByText('鈴木一郎')
    const retryBtn = await screen.findByRole('button', { name: '候補を読み直す' })

    fireEvent.click(retryBtn)
    fireEvent.click(retryBtn)
    expect(fixture.accountsList).toHaveBeenCalledTimes(2)

    await act(async () => {
      finishAccounts({ success: true, data: [{ id: 'acc-1', name: '渋谷本店', isActive: true }] })
      await Promise.resolve()
    })

    await waitFor(() => expect(screen.queryByText(/所属アカウントの候補を読み込めませんでした/)).toBeNull())
  })

  it('一覧の読み込み中はKPIカード3枚がローディングになり、一覧失敗時はUID連携済み・複数アカウントのKPIにも失敗文言を出す', async () => {
    let resolveRows!: (value: unknown) => void
    let resolveSummary!: (value: unknown) => void
    fixture.accountsList.mockResolvedValue({ success: true, data: [{ id: 'acc-1', name: '渋谷本店', isActive: true }] })
    fixture.usersList.mockImplementation((input: { pageSize?: number }) => {
      if (input.pageSize === 1) return new Promise((resolve) => { resolveSummary = resolve })
      return new Promise((resolve) => { resolveRows = resolve })
    })

    const { container } = render(<MergedUsersV8 />)
    await waitFor(() => expect(fixture.usersList).toHaveBeenCalledTimes(2))

    const kpiCards = container.querySelectorAll('[data-kpi-presentation="band"] [data-kpi-presentation="band"]')
    expect(kpiCards.length).toBe(3)
    expect(container.querySelectorAll('[data-kpi-presentation="band"] [data-kpi-presentation="band"][aria-busy="true"]').length).toBe(3)

    await act(async () => {
      resolveSummary({ success: true, data: { memberAccountId: 'acc-1', rows: [], total: 5, page: 1, pageSize: 1, computedAt: '' } })
      resolveRows({ success: false, error: 'list down' })
      await Promise.resolve()
    })

    await screen.findByText('統合ユーザーを読み込めませんでした')
    const uidCard = Array.from(kpiCards).find((el) => el.textContent?.includes('UID連携済み'))!
    const multiCard = Array.from(kpiCards).find((el) => el.textContent?.includes('複数アカウントにいる'))!
    expect(uidCard.textContent).toContain('読み込めませんでした')
    expect(multiCard.textContent).toContain('読み込めませんでした')
  })
})
