// @vitest-environment happy-dom
/*
 * 統括のメンバー画面の補助取得失敗（最終ログイン・担当アカウント一覧）と再試行の振る舞い。
 * - 最終ログインの取得が失敗しても黙って「—」にせず、案内・取得失敗表示・再読み込みを出し、連打を抑えて復旧できる
 * - 担当アカウント一覧だけが失敗してもメンバー一覧を落とさず、案内と再読み込みを出す
 * - 本体一覧の取得失敗時も再読み込み連打で二重通信にならない
 */
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  me: vi.fn(),
  staffList: vi.fn(),
  accountsList: vi.fn(),
  lastLogins: vi.fn(),
}))

vi.mock('@/lib/staff-role', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/staff-role')>()
  return {
    ...actual,
    loadStaffIdentity: (...args: unknown[]) => mocks.me(...args),
    useTenantAdministratorAccess: () => true,
  }
})
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      staff: {
        ...actual.api.staff,
        list: (...args: unknown[]) => mocks.staffList(...args),
        lastLogins: (...args: unknown[]) => mocks.lastLogins(...args),
        resendInvite: vi.fn(),
      },
      lineAccounts: {
        ...actual.api.lineAccounts,
        list: (...args: unknown[]) => mocks.accountsList(...args),
      },
      lineAccountFolders: {
        ...actual.api.lineAccountFolders,
        list: vi.fn(async () => ({ success: true, data: { folders: [] } })),
      },
    },
  }
})
vi.mock('next/link', () => ({
  default: ({ children, ...props }: React.ComponentProps<'a'>) => <a {...props}>{children}</a>,
}))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
  usePathname: () => '/hq/members',
}))
vi.mock('./settings-nav', () => ({ default: () => null, useHqSettingsFolderNav: () => undefined }))
vi.mock('@/v8/settings/staff', () => ({ SelfSecurity: () => null }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))

import HqMembersV8 from './members'

const MEMBER = {
  id: 'stf-1',
  name: '山田 太郎',
  email: 'yamada@example.com',
  role: 'admin' as const,
  isActive: true,
  inviteStatus: 'active',
  accountScope: 'all',
  scopedLineAccountIds: [],
  assignedLineAccountId: null,
  permissionKeys: [],
  notificationPreferences: {},
  lineLinked: true,
  twoFactorEnabled: true,
  canAccessDescendantAccounts: true,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.me.mockResolvedValue({ success: true, data: { id: 'owner-1', name: 'Kenta', role: 'owner', accountScope: 'all' } })
  mocks.staffList.mockResolvedValue({ success: true, data: [MEMBER] })
  mocks.accountsList.mockResolvedValue({ success: true, data: [{ id: 'acc-1', name: '本店', displayOrder: 0 }] })
  mocks.lastLogins.mockResolvedValue({ success: true, data: { 'stf-1': '2026-10-01T01:00:00Z' } })
})

afterEach(() => {
  cleanup()
})

describe('統括のメンバーの失敗表示と再試行', () => {
  it('最終ログインの取得に失敗したら案内と「取得失敗」を出し、再読み込み連打を抑えて復旧できる', async () => {
    let resolveRetry!: (value: unknown) => void
    mocks.lastLogins
      .mockRejectedValueOnce(new Error('last logins failed'))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveRetry = resolve }))

    render(<HqMembersV8 />)

    await screen.findByText('山田 太郎')
    await screen.findByText(/最終ログインを読み込めませんでした/)
    expect(screen.getByText('取得失敗')).toBeTruthy()

    const retryBtn = screen.getByRole('button', { name: 'もう一度読み込む' })
    fireEvent.click(retryBtn)
    fireEvent.click(retryBtn)

    await waitFor(() => expect(mocks.lastLogins).toHaveBeenCalledTimes(2))

    resolveRetry({ success: true, data: { 'stf-1': '2026-10-01T01:00:00Z' } })
    await waitFor(() => expect(screen.queryByText(/最終ログインを読み込めませんでした/)).toBeNull())
    expect(screen.queryByText('取得失敗')).toBeNull()
    expect(mocks.lastLogins).toHaveBeenCalledTimes(2)
  })

  it('担当アカウント一覧だけが失敗してもメンバー一覧を残し、案内と再読み込みを出す', async () => {
    mocks.accountsList
      .mockRejectedValueOnce(new Error('accounts offline'))
      .mockResolvedValueOnce({ success: true, data: [{ id: 'acc-1', name: '本店', displayOrder: 0 }] })

    render(<HqMembersV8 />)

    await screen.findByText('山田 太郎')
    await screen.findByText(/担当アカウント一覧を読み込めませんでした/)
    expect(screen.queryByText('権限者を読み込めませんでした')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
    await waitFor(() => expect(screen.queryByText(/担当アカウント一覧を読み込めませんでした/)).toBeNull())
  })

  it('本体一覧の取得失敗後に再読み込みを連打しても二重通信にならない', async () => {
    let resolveRetry!: (value: unknown) => void
    mocks.staffList
      .mockRejectedValueOnce(new Error('staff offline'))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveRetry = resolve }))

    render(<HqMembersV8 />)

    await screen.findByText('権限者を読み込めませんでした')
    const retryBtn = screen.getByRole('button', { name: 'もう一度読み込む' })
    fireEvent.click(retryBtn)
    fireEvent.click(retryBtn)

    await waitFor(() => expect(mocks.staffList).toHaveBeenCalledTimes(2))

    resolveRetry({ success: true, data: [MEMBER] })
    await screen.findByText('山田 太郎')
    expect(mocks.staffList).toHaveBeenCalledTimes(2)
  })
})
