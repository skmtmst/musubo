// @vitest-environment happy-dom
/*
 * #983 追加監査 LAY-09/LAY-10: 権限詳細の説明欄を実データから生成する。
 *
 * 実物の StaffPage をマウントして確かめる。
 *   - 項目数・名前・人数が固定文ではなく選択中のかたまりと実集計から出る
 *   - 項目を触ると「変更後の予定」と差分が出る
 *   - 「つながる先」はリンク（hrefを持つ）で、見た目だけの矢印ではない
 */
import '@/test-utils/staff-location-reset'
import React from 'react'
import { act } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StaffMember } from '@line-crm/shared'

vi.mock('@/components/layout/settings-inner-nav', () => ({ default: () => <nav aria-label="設定の中のメニュー" /> }))
vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => '/staff',
  useSearchParams: () => new URLSearchParams('tab=members'),
}))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'account-a' }) }))
vi.mock('@/components/layout/merged-tabs', () => ({
  default: () => <nav aria-label="ログインユーザーのタブ" />,
  useMergedTab: () => 'members',
}))
vi.mock('@/components/shell/page-chrome', async () => ({ ...(await import('@/test-utils/page-chrome-mock')).pageChromeMock(), usePageTitle: () => undefined }))
vi.mock('@/components/staff/login-audit', () => ({ default: () => <div /> }))
vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn().mockResolvedValue('') } }))

function member(overrides: Partial<StaffMember>): StaffMember {
  return {
    id: 'target', name: '対象者', email: 'target@example.test', role: 'staff',
    lineLinked: false, twoFactorEnabled: false, isActive: true, permissionKeys: ['/chats'],
    notificationPreferences: {}, inviteStatus: 'active',
    createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z',
    assignedLineAccountId: null, canAccessDescendantAccounts: false, ...overrides,
  }
}

function accessUser(overrides: Record<string, unknown>) {
  return {
    id: 'target', name: '対象者', email: 'target@example.test', jobTitle: null,
    roleBundle: 'operations', featureCount: 3, hasFieldMasks: false,
    accountScope: { type: 'all', assignedLineAccountId: null, lineAccountIds: [], includesDescendants: false },
    lastLoginAt: '2026-09-01T00:00:00.000Z', lastActionAt: null, mfaEnabled: false,
    status: 'active', policyVersion: 1,
    createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z',
    ...overrides,
  }
}

const state = {
  members: [member({}), member({ id: 'me', name: 'ログイン中の人', email: 'me@example.test', role: 'admin' })],
  users: [
    accessUser({}),
    accessUser({ id: 'me', name: 'ログイン中の人', email: 'me@example.test', roleBundle: 'administrator' }),
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
        update: vi.fn(async () => ({ success: true, data: state.members[0] })),
        loginSummary: async () => ({ success: true, data: { loginCount: 1 } }),
      },
      lineAccounts: { list: async () => ({ success: true, data: [] }) },
      access: {
        users: async () => ({
          success: true,
          data: {
            items: state.users,
            summary: {
              active: 2, invited: 0, expiredInvitations: 0, unused90Days: 0, mfaEnabled: 0, mfaRate: 0,
              roleCounts: { administrator: 1, operations: 1, reception: 0, view_only: 0, custom: 0 },
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

async function openPermissionView() {
  await act(async () => { render(<StaffPage />) })
  await waitFor(() => expect(screen.getByRole('button', { name: '対象者の中身を見る' })).toBeTruthy())
  fireEvent.click(within(screen.getByRole('button', { name: '対象者の中身を見る' }).closest('[role="row"]') as HTMLElement).getByRole('button', { name: /の中身を見る$/ }))
  await waitFor(() => expect(screen.getByText('この決め方で、この人にはこう見えます')).toBeTruthy())
}

beforeEach(() => {
  state.users[0] = accessUser({})
})

afterEach(() => cleanup())

describe('権限詳細の説明欄は選択中の権限から生成する (#983)', () => {
  it('「スタッフ」の説明はプリセットから項目数と名前を組み立て、人数は実集計を使う', async () => {
    await openPermissionView()

    // 運用プリセット: settings だけ none。feature行11件（来店スタンプを含む）のうち出るのは10項目。
    expect(screen.getByText(/メニューに出るのは10項目/)).toBeTruthy()
    expect(screen.getByText(/出さないのは1項目/)).toBeTruthy()
    expect(screen.queryByText(/サイドメニューに出るのは4項目/)).toBeNull()

    // かたまりの人数は固定文ではなく roleCounts（administrator=1）から出る
    const adminButton = screen.getAllByRole('button').find((button) => button.textContent?.includes('管理者'))
    expect(adminButton?.textContent).toContain('1 人')

    // 個人情報はプリセットの view（伏せて表示）と一致する
    expect(screen.getByText(/電話番号・住所・メールは伏せて表示します/)).toBeTruthy()
    // 未変更なので「いまの設定と同じ」
    expect(screen.getByText(/いまの設定と同じ内容です/)).toBeTruthy()
    expect(screen.queryByText('変更後の予定')).toBeNull()
  })

  it('項目を触ると「変更後の予定」と差分項目が出る', async () => {
    await openPermissionView()

    fireEvent.click(screen.getByRole('button', { name: '設定：変えられる（変更できる）' }))

    await waitFor(() => expect(screen.getByText('変更後の予定')).toBeTruthy())
    expect(screen.getByRole('button', { name: '見せる範囲を保存する' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'キャンセル' })).toBeTruthy()
    expect(screen.getByText(/いまの設定から変わるのは1項目/)).toBeTruthy()
    expect(screen.getAllByText(/出さない項目はありません/).length).toBeGreaterThan(0)
  })

  it('個別設定の人は保存済みをそのまま出し、差分も保存済みと比べる（R497）', async () => {
    // 保存済みは受信箱だけ変えられる（member の permissionKeys）。
    // 受付プリセットへの当てはめはせず、未確認にもしない。
    state.users[0] = accessUser({ roleBundle: 'custom' })
    await openPermissionView()

    expect(screen.queryByText(/内訳は取得できていません/)).toBeNull()
    expect(screen.queryByText(/変わる項目の内訳は未確認です/)).toBeNull()
    expect(screen.getByText(/いまの設定と同じ内容です/)).toBeTruthy()
    expect(screen.queryByText('変更後の予定')).toBeNull()
  })

  it('保存済みの内訳が不明な個別設定は未確認と伝える', async () => {
    const originalMembers = state.members
    state.users[0] = accessUser({ roleBundle: 'custom' })
    state.members = originalMembers.filter((member) => member.id === 'me')
    try {
      await openPermissionView()
      expect(screen.getByText(/項目ごとの内訳は取得できていません（未確認）/)).toBeTruthy()
    } finally { state.members = originalMembers }
  })

  it('「つながる先」は実リンクで遷移先を持つ', async () => {
    await openPermissionView()

    expect(screen.getByRole('link', { name: '→ 機能設定' }).getAttribute('href')).toBe('/settings')
    expect(screen.getByRole('link', { name: '→ 入った記録' }).getAttribute('href')).toBe('/staff?tab=audit')
    expect(screen.getByRole('link', { name: '→ 運用状態' }).getAttribute('href')).toBe('/emergency')
    expect(screen.getByRole('link', { name: '→ 予約設定' }).getAttribute('href')).toBe('/booking/menus')
  })
})

describe('ログインユーザーの右欄に作る人のメモを出さない (B1)', () => {
  it('開発用のメモ欄は出さず、役割の案内は残す', async () => {
    await act(async () => { render(<StaffPage />) })
    await waitFor(() => expect(screen.getByRole('button', { name: '対象者の中身を見る' })).toBeTruthy())
    expect(screen.queryByText('直したあとの列')).toBeNull()
    expect(screen.queryByText(/表に足す列/)).toBeNull()
    expect(screen.queryByText('役割でできること')).toBeNull()
    expect(screen.getByRole('region', { name: '自分の設定' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: '役割と権限' })).toBeTruthy()
  })
})

// Self-security loading is covered separately; retain this suite’s original operation assertions.
vi.mock('@/v8/settings/staff/self-mfa', () => ({ default: () => null }))
