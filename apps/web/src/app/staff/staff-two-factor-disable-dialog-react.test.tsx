// @vitest-environment happy-dom
/*
 * ログインユーザー：自分の二段階認証を解除する確認窓。
 * 何が止まり・何が残り・どう戻せるかを、言葉の表の「二段階認証」で書く。
 */
import '@/test-utils/staff-location-reset'
import React from 'react'
import { act } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
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

vi.mock('@/v8/settings/staff/self-mfa', () => ({ default: () => null }))

afterEach(() => cleanup())

it('自分の行の「二段階認証を解除する」で、止まる物と戻し方を書いた確認窓を開く', async () => {
  await act(async () => { render(<StaffPage />) })
  const table = await screen.findByRole('table', { name: 'ユーザーの一覧' })
  await waitFor(() => expect(within(table).getByRole('button', { name: 'ログイン中の人の中身を見る' })).toBeTruthy())
  fireEvent.click(within(table).getByRole('button', { name: 'ログイン中の人の操作' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: '二段階認証を解除する' }))
  const dialog = await screen.findByRole('dialog', { name: 'ログイン中の人 の二段階認証を解除しますか？' })
  expect(dialog.textContent).toContain('ログイン中の人 の二段階認証を解除しますか？')
  expect(dialog.textContent).toContain('LINEログインだけでログインできるようになります。')
  expect(dialog.textContent).toContain('あとから「二段階認証を設定する」で、設定し直せます。')
})
