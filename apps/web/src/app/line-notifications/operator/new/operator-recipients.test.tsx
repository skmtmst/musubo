// @vitest-environment happy-dom
import { rememberStaffIdentity, forgetStaffIdentity } from '@/lib/staff-identity-state'
import type { StaffMember } from '@line-crm/shared'
/*
 * 全ルート監査 A2（2026-09-25）:
 * `/line-notifications/operator/new` の「受け取る人」が
 * 「読み込めませんでした」になっていた。原因は候補の口が
 * `line-notifications` 名で無く、更新扱い（405）で返っていたこと。
 */
import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const apiMocks = vi.hoisted(() => ({ previewRecipients: vi.fn() }))

// 設定の中のメニュー（共通部品）はこの試験の対象外。localStorage と機能の出し分けを読むので外す。
vi.mock('@/components/layout/settings-inner-nav', () => ({ default: () => null }))
vi.mock('next/navigation', () => ({
  usePathname: () => '/line-notifications/operator/new',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}))
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'account-a', selectedAccount: null, loading: false }),
}))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => undefined, usePageCrumbs: () => undefined, useSettingsNavInline: () => undefined }))
vi.mock('@/lib/api', () => ({
  ApiError: class extends Error {
    status?: number
  },
  api: { notifications: { teams: { list: async () => ({ success: true, data: [] }) } }, lineNotifications: { operatorRules: { previewRecipients: (...args: unknown[]) => apiMocks.previewRecipients(...args) } } },
}))

import Page from './page'

const flush = () => act(async () => { await Promise.resolve() })

beforeEach(() => {
  forgetStaffIdentity(); rememberStaffIdentity({ role: 'owner' } as StaffMember);
  apiMocks.previewRecipients.mockReset()
})
afterEach(cleanup)

describe('operator/new の受け取る人', () => {
  it('R612: 候補0人なら理由と準備・次の画面を案内する', async () => {
    apiMocks.previewRecipients.mockResolvedValue({ success: true, data: { items: [] } })
    render(<Page />)
    await flush()
    expect(await screen.findByText('受け取る人がいません')).toBeTruthy()
    expect(screen.getByText('スタッフを登録し、LINE連携が済んだ人が宛先になります。')).toBeTruthy()
    const guide = screen.getByRole('link', { name: 'ログインユーザー' })
    expect(guide.getAttribute('href')).toBe('/staff')
  })

  it('R612: 候補0人で保存すると準備への案内が出る', async () => {
    apiMocks.previewRecipients.mockResolvedValue({ success: true, data: { items: [] } })
    render(<Page />)
    await flush()
    await screen.findByText('受け取る人がいません')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '下書きを保存' }))
    })
    expect(await screen.findByText('受け取る人がいません。先にログインユーザーでスタッフ登録とLINE連携を済ませてください。')).toBeTruthy()
  })

  it('候補の器（items/summary）で名前が出る', async () => {
    apiMocks.previewRecipients.mockResolvedValue({
      success: true,
      data: {
        items: [
          { id: 'staff-owner', name: '見本 16', lineLinked: true, emailVerified: true, channels: { line: true, email: false, dashboard: true }, canReceive: true },
        ],
        summary: { staff: 1, canReceive: 1, line: 1, email: 0, dashboard: 1, unavailable: 0 },
      },
    })
    render(<Page />)
    await flush()
    expect(await screen.findByText('見本 16')).toBeTruthy()
    expect(screen.queryByText('受け取る人を読み込めませんでした。')).toBeNull()
  })
})
