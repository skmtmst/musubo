// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { PagePendingLayout } from './templates/page-pending'
import { forgetStaffIdentity, rememberStaffIdentity, readStaffIdentity } from '@/lib/staff-identity-state'
import type { StaffMember } from '@line-crm/shared'
import { REGISTRATION_STYLE_KEY, registrationStorageKey } from '@/v8/account-new/registration-storage'
import StoreSelectionGate from './store-selection-gate'

const mocks = vi.hoisted(() => ({ state: vi.fn(), replace: vi.fn(), pathname: '/chats', loading: false }))
vi.mock('next/navigation', () => {
  const router = { replace: mocks.replace }
  return { usePathname: () => mocks.pathname, useRouter: () => router }
})
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({
  loading: mocks.loading, selectedAccountId: 'the-shed', accounts: [{ id: 'the-shed' }],
  error: null, refreshing: false, refreshAccounts: vi.fn(),
}) }))
vi.mock('@/lib/api', () => ({ api: { lineAccounts: { accountEntry: mocks.state } } }))

beforeEach(() => { vi.clearAllMocks(); mocks.pathname = '/chats'; mocks.loading = false })
afterEach(() => { cleanup(); forgetStaffIdentity(); sessionStorage.clear() })

describe('保存済みの店舗選択からの再訪', () => {
  it('店舗一覧の待機は共通の骨組みにし、検証台本が識別できる印を保つ', () => {
    mocks.loading = true
    render(<StoreSelectionGate><div>店舗画面</div></StoreSelectionGate>)
    expect(document.querySelector('[data-page-pending="store"] [aria-busy="true"]')).toBeTruthy()
    expect(screen.queryByText('店舗画面')).toBeNull()
  })

  it('引き継ぎ中なら店舗画面をマウントせずPenの進捗画面へ戻す', async () => {
    mocks.state.mockResolvedValue({ success: true, data: { destination: 'handover', canResume: false } })
    render(<StoreSelectionGate><div>店舗画面</div></StoreSelectionGate>)
    expect(screen.queryByText('店舗画面')).toBeNull()
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith('/accounts/new/handover?accountId=the-shed'))
    expect(screen.queryByText('店舗画面')).toBeNull()
  })

  it('状態確認に失敗しても店舗画面を開かない', async () => {
    mocks.state.mockRejectedValue(new Error('network error'))
    render(<StoreSelectionGate><div>店舗画面</div></StoreSelectionGate>)
    await screen.findByText('登録の状態を確認できませんでした')
    expect(screen.queryByText('店舗画面')).toBeNull()
  })

  it('ホームの引き継ぎ失敗と再試行にも同じ題を残す', async () => {
    mocks.pathname = '/'
    mocks.state.mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ success: true, data: { destination: 'dashboard', canResume: false } })
    render(<PagePendingLayout variant="dashboard"><StoreSelectionGate><div>店舗画面</div></StoreSelectionGate></PagePendingLayout>)
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('ダッシュボード')
    await screen.findByText('登録の状態を確認できませんでした')
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('ダッシュボード')
    expect(screen.queryByText('店舗画面')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
    await screen.findByText('店舗画面')
    expect(mocks.state).toHaveBeenCalledTimes(2)
  })

  it('受信箱の権限を持つstaffが状態を読めれば店舗画面を表示する', async () => {
    rememberStaffIdentity({ id: 'staff-1', role: 'staff', permissionKeys: ['/chats'] } as StaffMember)
    expect(readStaffIdentity()?.role).toBe('staff')
    mocks.state.mockResolvedValue({ success: true, data: { destination: 'dashboard', canResume: false } })
    render(<StoreSelectionGate><div>担当者の受信箱</div></StoreSelectionGate>)
    await screen.findByText('担当者の受信箱')
    expect(mocks.state).toHaveBeenCalledWith('the-shed')
    expect(mocks.replace).not.toHaveBeenCalled()
    expect(screen.queryByText('登録の状態を確認できませんでした')).toBeNull()
  })

  it.each([
    ['registration', '/accounts/new?resume=the-shed'],
    ['billing', '/hq/billing/line-addition?accountId=the-shed'],
  ])('古い画面URLでも確定した%sだけへ案内する', async (destination, href) => {
    mocks.pathname = '/getting-started'
    mocks.state.mockResolvedValue({ success: true, data: { destination, canResume: destination === 'registration' } })
    render(<StoreSelectionGate><div>店舗画面</div></StoreSelectionGate>)
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith(href))
    expect(screen.queryByText('店舗画面')).toBeNull()
  })

  it.each([
    [true, 'the-shed', true],
    [true, 'other-account', false],
    [false, 'the-shed', false],
  ])('保存済みの⑤は権限と同じアカウントが確認できたときだけ復元する', async (canResume, stored, resume) => {
    const staff = { id: 'owner-1', tenantId: 'org-1', role: 'owner', accountScope: 'all' } as StaffMember
    rememberStaffIdentity(staff)
    sessionStorage.setItem(registrationStorageKey(REGISTRATION_STYLE_KEY, staff)!, stored)
    mocks.state.mockResolvedValue({ success: true, data: { destination: 'dashboard', canResume } })
    render(<StoreSelectionGate><div>店舗画面</div></StoreSelectionGate>)
    if (resume) {
      await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith('/accounts/new?resume=the-shed'))
      expect(screen.queryByText('店舗画面')).toBeNull()
    } else {
      await screen.findByText('店舗画面')
      expect(mocks.replace).not.toHaveBeenCalled()
    }
  })

  it('選んだアカウントの登録を再開できないときは別アカウントを勝手に表示しない', async () => {
    mocks.state.mockResolvedValue({ success: true, data: { destination: 'unavailable', canResume: false } })
    render(<StoreSelectionGate><div>店舗画面</div></StoreSelectionGate>)
    expect(await screen.findByText('登録を再開できませんでした')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'アカウント一覧へ' }).getAttribute('href')).toBe('/hq')
    expect(screen.queryByText('店舗画面')).toBeNull()
    expect(mocks.replace).not.toHaveBeenCalled()
  })

  it('完了後だけ店舗画面を開く', async () => {
    mocks.state.mockResolvedValue({ success: true, data: { destination: 'dashboard', canResume: false } })
    render(<StoreSelectionGate><div>店舗画面</div></StoreSelectionGate>)
    await screen.findByText('店舗画面')
  })

  it('統括と引き継ぎ画面では入店ガードをかけず、進捗を表示できる', () => {
    for (const pathname of ['/hq', '/accounts/new/handover']) {
      mocks.pathname = pathname
      const view = render(<StoreSelectionGate><div>引き継ぎ画面</div></StoreSelectionGate>)
      expect(screen.getByText('引き継ぎ画面')).toBeTruthy()
      view.unmount()
    }
    expect(mocks.state).not.toHaveBeenCalled()
    expect(mocks.replace).not.toHaveBeenCalled()
  })
})
