// @vitest-environment happy-dom
/*
 * Issue #620: ログインユーザー検索が不存在語で0件にならない。
 *
 * メンバー一覧の検索欄は「名前・メールで探す」。実物の StaffPage を
 * マウントし、次を確かめる。
 *   - 不存在語では空状態（条件に合うログインユーザーはいません）が出る
 *   - 名前とメールを ' ' で繋いだ文字列への跨ぎ一致（別フィールド一致）をしない
 *   - 空白だけ・長文でも正しく動く
 */
import '@/test-utils/staff-location-reset'
import React from 'react'
import { act } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StaffMember } from '@line-crm/shared'

vi.mock('@/components/layout/settings-inner-nav', () => ({ default: () => <nav aria-label="設定の中のメニュー" /> }))
vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => '/staff',
  useSearchParams: () => new URLSearchParams('tab=members'),
}))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'account-a' }) }))
vi.mock('@/components/layout/merged-tabs', () => ({
  default: ({ tabs }: { tabs: Array<{ key: string; label: string }> }) => <nav aria-label="ログインユーザーのタブ">{tabs.map((tab) => <span key={tab.key}>{tab.label}</span>)}</nav>,
  useMergedTab: () => 'members',
}))
vi.mock('@/components/shell/page-chrome', async () => ({ ...(await import('@/test-utils/page-chrome-mock')).pageChromeMock(), usePageTitle: () => undefined }))
vi.mock('@/components/staff/login-audit', () => ({ default: () => <div /> }))
vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn().mockResolvedValue('') } }))

function member(overrides: Partial<StaffMember>): StaffMember {
  return {
    id: 'me', name: 'ログイン中の人', email: 'me@example.test', role: 'admin',
    lineLinked: false, twoFactorEnabled: true, isActive: true, permissionKeys: [],
    notificationPreferences: {}, inviteStatus: 'active',
    createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z',
    assignedLineAccountId: null, canAccessDescendantAccounts: false, ...overrides,
  }
}

function accessUser(overrides: Record<string, unknown>) {
  return {
    id: 'me', name: 'ログイン中の人', email: 'me@example.test', jobTitle: null,
    roleBundle: 'administrator', featureCount: null, hasFieldMasks: null,
    accountScope: { type: 'all', assignedLineAccountId: null, lineAccountIds: [], includesDescendants: false },
    lastLoginAt: '2026-09-01T00:00:00.000Z', lastActionAt: null, mfaEnabled: true,
    status: 'active', policyVersion: 1,
    createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z',
    ...overrides,
  }
}

const state = {
  members: [
    member({}),
    member({ id: 'yamada', name: '見本 141', email: 'yamada@mail.test', role: 'staff' }),
    member({ id: 'sato', name: '見本 122', email: 'x-sato@mail.test', role: 'staff' }),
  ],
  users: [
    accessUser({}),
    accessUser({ id: 'yamada', name: '見本 141', email: 'yamada@mail.test', roleBundle: 'operations', featureCount: 3 }),
    accessUser({ id: 'sato', name: '見本 122', email: 'x-sato@mail.test', roleBundle: 'view_only', featureCount: 2 }),
  ],
}

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  class ApiError extends Error {}
  return {
    ...actual,
    ApiError,
    fetchApi: vi.fn().mockResolvedValue({ success: true, data: [] }),
    api: {
      staff: {
        list: async () => ({ success: true, data: state.members }),
        me: async () => ({ success: true, data: state.members.find((item) => item.id === 'me')! }),
      },
      lineAccounts: { list: async () => ({ success: true, data: [] }) },
      access: {
        users: async () => ({
          success: true,
          data: {
            items: state.users,
            summary: {
              active: state.users.length, invited: 0, expiredInvitations: 0, unused90Days: 0, mfaEnabled: 3, mfaRate: 100,
              roleCounts: { administrator: 1, operations: 1, reception: 0, view_only: 1, custom: 0 },
            },
            pagination: { total: state.users.length, limit: 200, offset: 0 },
          },
        }),
        roles: async () => ({ success: true, data: { items: [] } }),
      },
      audit: { events: async () => ({ success: true, data: { items: [] } }) },
    },
  }
})

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { default: StaffPage } = await import('./page')

const EMPTY_MESSAGE = '条件に合うログインユーザーはいません。条件を変えてお試しください。'

async function mount() {
  await act(async () => { render(<StaffPage />) })
  await waitFor(() => expect(list().getByText('見本 141')).toBeTruthy())
}

const list = () => within(screen.getByRole('table', { name: 'ユーザーの一覧' }))

function searchBox(): HTMLElement {
  return screen.getByRole('searchbox', { name: '名前・メールで探す' })
}

function typeQuery(value: string) {
  fireEvent.change(searchBox(), { target: { value } })
}

afterEach(() => cleanup())

describe('ログインユーザー検索 (#620)', () => {
  it('不存在語は0件になり空状態と件数0を出す', async () => {
    await mount()
    typeQuery('存在しない語zzz')
    await waitFor(() => expect(screen.getByText(EMPTY_MESSAGE)).toBeTruthy())
    expect(screen.getByText('ユーザー 0 人中 0 人を表示')).toBeTruthy()
    expect(list().queryByText('見本 141')).toBeNull()
    expect(list().queryByText('見本 122')).toBeNull()
  })

  it('名前・メールの部分一致は従来どおり効く', async () => {
    await mount()
    typeQuery('141')
    await waitFor(() => expect(screen.getByText('ユーザー 1 人中 1 人を表示')).toBeTruthy())
    expect(list().getByText('見本 141')).toBeTruthy()
    expect(list().queryByText('見本 122')).toBeNull()

    typeQuery('x-sato@mail')
    await waitFor(() => expect(list().getByText('見本 122')).toBeTruthy())
    expect(list().queryByText('見本 141')).toBeNull()
  })

  it('名前とメールをまたいだ語では一致しない（フィールドごとに照合する）', async () => {
    await mount()
    // 旧実装は "名前 メール" を1本の文字列へ繋げて照合していたため、
    // 「122 x-sato」のような跨ぎ語でも行を返していた。
    typeQuery('122 x-sato')
    await waitFor(() => expect(screen.getByText(EMPTY_MESSAGE)).toBeTruthy())
    expect(screen.getByText('ユーザー 0 人中 0 人を表示')).toBeTruthy()
  })

  it('空白だけの検索語は絞り込みなしとして全件を返す', async () => {
    await mount()
    typeQuery('  　 ')
    await waitFor(() => expect(screen.getByText('ユーザー 3 人中 3 人を表示')).toBeTruthy())
    expect(screen.queryByText(EMPTY_MESSAGE)).toBeNull()
  })

  it('長文の検索語でも0件の空状態になり、画面は壊れない', async () => {
    await mount()
    typeQuery('な'.repeat(2000))
    await waitFor(() => expect(screen.getByText(EMPTY_MESSAGE)).toBeTruthy())
    expect(screen.getByText('ユーザー 0 人中 0 人を表示')).toBeTruthy()
  })

  it('検索語を消すと全件へ戻る', async () => {
    await mount()
    typeQuery('存在しない語zzz')
    await waitFor(() => expect(screen.getByText(EMPTY_MESSAGE)).toBeTruthy())
    typeQuery('')
    await waitFor(() => expect(screen.getByText('ユーザー 3 人中 3 人を表示')).toBeTruthy())
    expect(list().getByText('見本 141')).toBeTruthy()
    expect(list().getByText('見本 122')).toBeTruthy()
  })
})

// Self-security loading is covered separately; retain this suite’s original operation assertions.
vi.mock('@/v8/settings/staff/self-mfa', () => ({ default: () => null }))
