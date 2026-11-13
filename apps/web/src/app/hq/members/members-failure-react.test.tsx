// @vitest-environment happy-dom
/*
 * M026：権限者の失敗は原文のまま出さず、共通の状態別案内（再試行の言葉・統括の頼み先つき）にする。
 * 招待の保存（src/v8/hq/members.tsx）、招待の再送、統括名の保存（src/v8/hq/settings.tsx）を描いて押して見る。
 */
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

vi.mock('@/v8/settings/staff', () => ({ SelfSecurity: () => null }))

const mocks = vi.hoisted(() => ({
  me: vi.fn(), list: vi.fn(), create: vi.fn(), update: vi.fn(), resend: vi.fn(), accounts: vi.fn(),
  tenant: vi.fn(), updateName: vi.fn(), contact: vi.fn(),
}))
vi.mock('@/lib/api', async (original) => {
  const actual = await original<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      staff: { ...actual.api.staff, me: mocks.me, list: mocks.list, create: mocks.create, update: mocks.update, resendInvite: mocks.resend, lastLogins: vi.fn(async () => ({ success: true, data: {} })) },
      lineAccounts: { ...actual.api.lineAccounts, list: mocks.accounts },
      lineAccountFolders: { ...actual.api.lineAccountFolders, list: vi.fn(async () => ({ success: true, data: { folders: [] } })) },
      tenants: { ...actual.api.tenants, me: mocks.tenant, updateName: mocks.updateName, companyContact: mocks.contact, saveCompanyContact: vi.fn() },
      postalCode: { search: vi.fn() },
    },
  }
})
vi.mock('@/lib/staff-role', async (original) => ({ ...await original<typeof import('@/lib/staff-role')>(), useStaffRole: () => 'owner' }))
vi.mock('next/link', () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => React.createElement('a', { href }, children) }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
  usePathname: () => '/hq/members',
}))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))

import { ApiError } from '@/lib/api'
import { describeApiFailure } from '@/components/shared/api-error-message'
import HqMembersV8 from '@/v8/hq/members'
import HqSettingsV8 from '@/v8/hq/settings'

const invited = {
  id: 'stf-new', name: '新人 花子', email: 'new@example.com', role: 'viewer', isActive: false, inviteStatus: 'pending_email',
  accountScope: 'accounts', scopedLineAccountIds: ['acc-1'], assignedLineAccountId: 'acc-1', permissionKeys: [], notificationPreferences: {},
  lineLinked: false, twoFactorEnabled: false, canAccessDescendantAccounts: false, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.me.mockResolvedValue({ success: true, data: { id: 'owner', name: 'Kenta', role: 'owner', accountScope: 'all' } })
  mocks.list.mockResolvedValue({ success: true, data: [invited] })
  mocks.accounts.mockResolvedValue({ success: true, data: [{ id: 'acc-1', name: '然 -NEN- 本店', displayOrder: 0 }] })
  mocks.tenant.mockResolvedValue({ success: true, data: { name: '統括の名前' } })
  mocks.contact.mockResolvedValue({ success: true, data: null })
})
afterEach(cleanup)

const network = () => new TypeError('Failed to fetch')

describe('M026 権限者の失敗表示', () => {
  it('招待の保存が通信で落ちたら、窓の中に再試行の言葉つきの案内を出す', async () => {
    mocks.create.mockRejectedValueOnce(network())
    render(<HqMembersV8 />)
    fireEvent.click(await screen.findByRole('button', { name: '招待する' }))
    const dialog = await screen.findByRole('dialog', { name: '権限者を招待' })
    fireEvent.change(within(dialog).getByRole('textbox', { name: '名前' }), { target: { value: '見本 141' } })
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'メールアドレス' }), { target: { value: 'yamada@example.com' } })
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: '招待メールを送る' })) })
    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1))
    await within(dialog).findByText(describeApiFailure(network(), '保存', { scope: 'hq' }))
    expect(dialog.textContent).toContain('もう一度お試しください')
    expect(dialog.textContent).not.toContain('Failed to fetch')
  })

  it('招待の保存が 403 なら、統括の頼み先つきの権限の案内にする', async () => {
    const forbidden = new ApiError(403, 'API error: 403')
    mocks.create.mockRejectedValueOnce(forbidden)
    render(<HqMembersV8 />)
    fireEvent.click(await screen.findByRole('button', { name: '招待する' }))
    const dialog = await screen.findByRole('dialog', { name: '権限者を招待' })
    fireEvent.change(within(dialog).getByRole('textbox', { name: '名前' }), { target: { value: '見本 141' } })
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'メールアドレス' }), { target: { value: 'yamada@example.com' } })
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: '招待メールを送る' })) })
    await within(dialog).findByText(describeApiFailure(forbidden, '保存', { scope: 'hq' }))
    expect(describeApiFailure(forbidden, '保存', { scope: 'hq' })).not.toBe(describeApiFailure(forbidden, '保存'))
  })

  it('招待の再送が落ちたら、再試行の言葉つきの案内を出す', async () => {
    mocks.resend.mockRejectedValueOnce(network())
    render(<HqMembersV8 />)
    fireEvent.click(await screen.findByRole('button', { name: '新人 花子のその他操作' }))
    await act(async () => { fireEvent.click(await screen.findByRole('menuitem', { name: '招待を再送する' })) })
    expect(mocks.resend).toHaveBeenCalledWith('stf-new')
    await screen.findByText(describeApiFailure(network(), '招待メールの再送', { scope: 'hq' }))
    expect(screen.queryByText('招待メールを送り直せませんでした。')).toBeNull()
  })

  it('統括名の保存が落ちたら、入力を残して再試行の言葉つきの案内を出す', async () => {
    mocks.updateName.mockRejectedValueOnce(network())
    render(<HqSettingsV8 />)
    const name = await screen.findByLabelText(/^統括名/) as HTMLInputElement
    await waitFor(() => expect(name.value).toBe('統括の名前'))
    fireEvent.change(name, { target: { value: '新しい統括名' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存する' })) })
    await screen.findByText(describeApiFailure(network(), '統括名の保存', { scope: 'hq' }))
    expect(mocks.updateName).toHaveBeenCalledWith('新しい統括名')
    expect(name.value).toBe('新しい統括名')
    expect(screen.queryByText('統括名を保存できませんでした。')).toBeNull()
  })
})
