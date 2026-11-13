// @vitest-environment happy-dom
/* 入力の誤りは欄で一度だけ知らせ、保存せず最初の欄へ移動する。 */
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StaffMember } from '@line-crm/shared'

const fixture = vi.hoisted(() => ({
  updateStaff: vi.fn(),
  accountId: 'account-a',
  retry: undefined as undefined | ((token: string) => Promise<void>),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => '/staff',
  useSearchParams: () => new URLSearchParams('tab=members&id=target'),
}))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: fixture.accountId }) }))
vi.mock('@/components/layout/merged-tabs', () => ({
  default: ({ tabs }: { tabs: Array<{ key: string; label: string }> }) => <nav aria-label="ログインユーザーのタブ">{tabs.map((tab) => <span key={tab.key}>{tab.label}</span>)}</nav>,
  useMergedTab: () => 'members',
}))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => undefined, useSettingsNavInline: () => undefined }))
vi.mock('@/components/step-up-prompt', () => ({ default: ({ request }: { request: { retry: (token: string) => Promise<void> } }) => { fixture.retry = request.retry; return <div>本人確認</div> }, isStepUpRequired: (error: unknown) => (error as { code?: string })?.code === 'STEP_UP_REQUIRED' }))
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
    roleBundle: 'operations', featureCount: 9, hasFieldMasks: true,
    accountScope: { type: 'all', assignedLineAccountId: null, lineAccountIds: [], includesDescendants: false },
    lastLoginAt: '2026-09-01T00:00:00.000Z', lastActionAt: null, mfaEnabled: false,
    status: 'active', policyVersion: 1,
    createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z',
    ...overrides,
  }
}

const state = {
  members: [
    member({}),
    member({ id: 'admin-1', name: '管理者さん', email: 'admin@example.test', role: 'admin' }),
    member({ id: 'me', name: 'ログイン中の人', email: 'me@example.test', role: 'admin' }),
  ],
  users: [
    accessUser({}),
    accessUser({ id: 'admin-1', name: '管理者さん', email: 'admin@example.test', roleBundle: 'administrator', featureCount: null }),
    accessUser({ id: 'me', name: 'ログイン中の人', email: 'me@example.test', roleBundle: 'administrator' }),
  ],
  lineAccounts: [] as Array<{ id: string; name: string }>,
}

vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  class ApiError extends Error {}
  return {
    ...actual,
    ApiError,
    fetchApi: vi.fn(),
    api: {
      staff: {
        list: async () => ({ success: true, data: state.members }),
        me: async () => ({ success: true, data: state.members.find((item) => item.id === 'me')! }),
        update: fixture.updateStaff,
        loginSummary: async () => ({ success: true, data: { loginCount: 1 } }),
      },
      lineAccounts: { list: async () => ({ success: true, data: state.lineAccounts }) },
      access: {
        users: async () => ({
          success: true,
          data: {
            items: state.users,
            summary: {
              active: state.users.length, invited: 0, expiredInvitations: 0, unused90Days: 0, mfaEnabled: 0, mfaRate: 0,
              roleCounts: { administrator: 2, operations: 1, reception: 0, view_only: 0, custom: 0 },
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

const { StaffEditV8 } = await import('./staff')


beforeEach(() => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() })
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('V8 ログインユーザーの入力確認', () => {
  it('名前が空なら送信せず、赤い欄へ移動する', async () => {
    fixture.updateStaff.mockReset()
    const scroll = vi.fn()
    const originalScroll = HTMLElement.prototype.scrollIntoView
    HTMLElement.prototype.scrollIntoView = scroll
    try {
      render(<StaffEditV8 />)
      const name = await screen.findByRole('textbox', { name: /^名前/ }) as HTMLInputElement
      fireEvent.change(name, { target: { value: '' } })
      fireEvent.click(screen.getByRole('button', { name: /保存する/ }))
      expect(name.getAttribute('aria-invalid')).toBe('true')
      expect(document.activeElement).toBe(name)
      expect(scroll).toHaveBeenCalledWith({ block: 'center' })
      expect(screen.getAllByText('名前を入力してください')).toHaveLength(1)
      expect(fixture.updateStaff).not.toHaveBeenCalled()
    } finally { HTMLElement.prototype.scrollIntoView = originalScroll }
  })
})

it('保存口が失敗を返したら成功扱いで閉じず、変更した入力を残す', async () => {
  fixture.updateStaff.mockReset().mockResolvedValue({ success: false, error: '保存できませんでした' })
  render(<StaffEditV8 />)
  const name = await screen.findByRole('textbox', { name: /^名前/ }) as HTMLInputElement
  expect(screen.queryByRole('button', { name: '保存する' })).toBeNull()
  fireEvent.change(name, { target: { value: '未保存の名前' } })
  fireEvent.click(screen.getByRole('button', { name: '保存する' }))
  await screen.findByText(/保存できませんでした/)
  expect(fixture.updateStaff).toHaveBeenCalledOnce()
  expect(name.value).toBe('未保存の名前')
  expect(screen.getByRole('button', { name: '保存する' })).toBeTruthy()
})

it('LINE連携解除は確認した相手の版を送り、対象と環境を出す', async () => {
  state.members[0] = member({ lineLinked: true, policyVersion: 7 })
  fixture.updateStaff.mockReset().mockResolvedValue({ success: true, data: state.members[0] })
  try {
    render(<StaffEditV8 />)
    fireEvent.click(await screen.findByRole('button', { name: '連携解除' }))
    const dialog = await screen.findByRole('dialog', { name: /LINE連携を解除しますか/ })
    expect(dialog.textContent).toContain('環境')
    expect(dialog.textContent).toContain('LINEアカウント')
    fireEvent.click(within(dialog).getByRole('button', { name: '解除する' }))
    await waitFor(() => expect(fixture.updateStaff).toHaveBeenCalledWith('target', { lineLinked: false, expectedPolicyVersion: 7 }, undefined))
  } finally { state.members[0] = member({}) }
})

it('LINE連携解除は開いたときの版を Worker に送る', async () => {
  state.members[0] = member({ lineLinked: true, policyVersion: 7 })
  fixture.updateStaff.mockReset().mockResolvedValue({ success: true, data: state.members[0] })
  try {
    render(<StaffEditV8 />)
    fireEvent.click(await screen.findByRole('button', { name: '連携解除' }))
    const dialog = await screen.findByRole('dialog', { name: /LINE連携を解除しますか/ })
    fireEvent.click(within(dialog).getByRole('button', { name: '解除する' }))
    await waitFor(() => expect(fixture.updateStaff).toHaveBeenCalledWith('target', { lineLinked: false, expectedPolicyVersion: 7 }, undefined))
  } finally { state.members[0] = member({}) }
})

it('LINE連携解除の応答待ちには二度目を送らない', async () => {
  state.members[0] = member({ lineLinked: true, policyVersion: 7 })
  let finish!: (value: { success: boolean; data: StaffMember }) => void
  fixture.updateStaff.mockReset().mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
  try {
    render(<StaffEditV8 />)
    fireEvent.click(await screen.findByRole('button', { name: '連携解除' }))
    const dialog = await screen.findByRole('dialog', { name: /LINE連携を解除しますか/ })
    const confirm = within(dialog).getByRole('button', { name: '解除する' })
    fireEvent.click(confirm)
    await waitFor(() => expect(fixture.updateStaff).toHaveBeenCalledTimes(1))
    fireEvent.click(confirm)
    expect(fixture.updateStaff).toHaveBeenCalledTimes(1)
    finish({ success: true, data: state.members[0] })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /LINE連携を解除しますか/ })).toBeNull())
  } finally { state.members[0] = member({}) }
})

it('版が確認できないLINE連携は解除を送らない', async () => {
  state.members[0] = member({ lineLinked: true })
  fixture.updateStaff.mockReset()
  try {
    render(<StaffEditV8 />)
    fireEvent.click(await screen.findByRole('button', { name: '連携解除' }))
    const dialog = await screen.findByRole('dialog', { name: /LINE連携を解除しますか/ })
    fireEvent.click(within(dialog).getByRole('button', { name: '解除する' }))
    expect(await within(dialog).findByText(/対象の版を確認できません/)).toBeTruthy()
    expect(fixture.updateStaff).not.toHaveBeenCalled()
  } finally { state.members[0] = member({}) }
})

it('選択アカウントを切り替えたら古いLINE連携解除は送らない', async () => {
  state.members[0] = member({ lineLinked: true, policyVersion: 7 })
  fixture.accountId = 'account-a'
  fixture.updateStaff.mockReset()
  try {
    const view = render(<StaffEditV8 />)
    fireEvent.click(await screen.findByRole('button', { name: '連携解除' }))
    await screen.findByRole('dialog', { name: /LINE連携を解除しますか/ })
    fixture.accountId = 'account-b'
    view.rerender(<StaffEditV8 />)
    const stale = screen.queryByRole('dialog', { name: /LINE連携を解除しますか/ })
    if (stale) fireEvent.click(within(stale).getByRole('button', { name: '解除する' }))
    expect(fixture.updateStaff).not.toHaveBeenCalled()
  } finally { fixture.accountId = 'account-a'; state.members[0] = member({}) }
})

it('本人確認の途中でアカウントを変えた古いLINE連携解除は再試行しない', async () => {
  state.members[0] = member({ lineLinked: true, policyVersion: 7 })
  fixture.accountId = 'account-a'; fixture.retry = undefined
  fixture.updateStaff.mockReset().mockRejectedValueOnce({ code: 'STEP_UP_REQUIRED' })
  try {
    const view = render(<StaffEditV8 />)
    fireEvent.click(await screen.findByRole('button', { name: '連携解除' }))
    const dialog = await screen.findByRole('dialog', { name: /LINE連携を解除しますか/ })
    fireEvent.click(within(dialog).getByRole('button', { name: '解除する' }))
    await waitFor(() => expect(fixture.retry).toBeTypeOf('function'))
    const retry = fixture.retry!
    fixture.accountId = 'account-b'; view.rerender(<StaffEditV8 />)
    await retry('old-proof')
    expect(fixture.updateStaff).toHaveBeenCalledTimes(1)
  } finally { fixture.accountId = 'account-a'; fixture.retry = undefined; state.members[0] = member({}) }
})
