// @vitest-environment happy-dom
/*
 * N-427 (#850) 本人の端末一覧・失効と、権限変更の直前再認証を、実物の画面で確かめる。
 *
 *   - 「ログイン中の端末」に自分のセッションが並び、今の端末に印が付く
 *   - 他の端末は1件ずつ終了でき、現在の端末は確認を挟んで /login へ戻る
 *   - 「この端末以外をすべて終了」が一括失効口を叩く
 *   - 権限の保存が 428 STEP_UP_REQUIRED で止まったとき、本人確認の窓が立ち、
 *     6桁コード → grant 取得 → 同じ保存に grant を付けてやり直す
 */
import '@/test-utils/staff-location-reset'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { StaffMember } from '@line-crm/shared'

const fixture = vi.hoisted(() => ({
  tab: 'members',
  sessionsList: vi.fn(),
  sessionsRevoke: vi.fn(),
  sessionsRevokeOthers: vi.fn(),
  staffUpdate: vi.fn(),
  staffStepUp: vi.fn(),
}))

vi.mock('@/components/layout/settings-inner-nav', () => ({ default: () => <nav aria-label="設定の中のメニュー" /> }))
vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(),
  useRouter: (await import('@/test-utils/staff-navigation-mock')).staffTestRouter,
  usePathname: () => '/staff',
  useSearchParams: () => new URLSearchParams(window.location.search),
}))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'account-a' }) }))
vi.mock('@/components/layout/merged-tabs', () => ({
  default: () => <nav aria-label="ログインユーザーのタブ" />,
  useMergedTab: () => fixture.tab,
}))
vi.mock('@/components/shell/page-chrome', async () => ({ ...(await import('@/test-utils/page-chrome-mock')).pageChromeMock(), usePageTitle: () => undefined }))
vi.mock('@/components/staff/login-audit', () => ({ default: () => <div /> }))
vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn().mockResolvedValue('') } }))

const SESSIONS = [
  { id: 'hash-current', current: true, createdAt: '2026-09-08T01:00:00.000Z', expiresAt: '2026-09-09T01:00:00.000Z', userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/120', ipPrefix: '203.0.*.*' },
  { id: 'hash-phone', current: false, createdAt: '2026-09-07T01:00:00.000Z', expiresAt: '2026-09-14T01:00:00.000Z', userAgent: 'Mozilla/5.0 (iPhone) Safari/604', ipPrefix: null },
]

function member(overrides: Partial<StaffMember>): StaffMember {
  return {
    id: 'member-1', name: '対象の人', email: 'member@example.test', role: 'staff',
    lineLinked: false, twoFactorEnabled: false, isActive: true, permissionKeys: [],
    notificationPreferences: {}, inviteStatus: 'active',
    createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z',
    assignedLineAccountId: null, canAccessDescendantAccounts: false, ...overrides,
  } as StaffMember
}
function accessUser(overrides: Record<string, unknown>) {
  return {
    id: 'member-1', name: '対象の人', email: 'member@example.test', jobTitle: null,
    roleBundle: 'operations', featureCount: null, hasFieldMasks: null,
    accountScope: { type: 'all', assignedLineAccountId: null, lineAccountIds: [], includesDescendants: false },
    lastLoginAt: null, lastActionAt: null, mfaEnabled: false, status: 'active', policyVersion: 1,
    createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z', ...overrides,
  }
}

const state = {
  members: [] as StaffMember[],
  users: [] as ReturnType<typeof accessUser>[],
}

class MockApiError extends Error {
  status: number
  code: string | undefined
  constructor(status: number, message?: string, code?: string) {
    super(message || `API error: ${status}`)
    this.status = status
    this.code = code
  }
}

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  ApiError: MockApiError,
  fetchApi: vi.fn().mockResolvedValue({ success: true, data: [] }),
  api: {
    auth: {
      stepUp: (...args: unknown[]) => fixture.staffStepUp(...args),
    },
    staff: {
      list: async () => ({ success: true, data: state.members }),
      me: async () => ({ success: true, data: member({ id: 'me-1', name: '管理者', email: 'me@example.test', role: 'admin' }) }),
      update: (...args: unknown[]) => fixture.staffUpdate(...args),
      loginSummary: async () => ({ success: true, data: { loginCount: 0 } }),
      lastLogins: async () => ({ success: true, data: {} }),
    },
    sessions: {
      list: () => fixture.sessionsList(),
      revoke: (...args: unknown[]) => fixture.sessionsRevoke(...args),
      revokeOthers: () => fixture.sessionsRevokeOthers(),
    },
    lineAccounts: { list: async () => ({ success: true, data: [] }) },
    access: {
      users: async () => ({
        success: true,
        data: {
          items: state.users,
          summary: { active: 1, invited: 0, expiredInvitations: 0, unused90Days: 0, mfaEnabled: 0, mfaRate: null, roleCounts: { administrator: 0, operations: 1, reception: 0, view_only: 0, custom: 0 } },
          pagination: { total: state.users.length, limit: 200, offset: 0 },
        },
      }),
      roles: async () => ({ success: true, data: { items: [] } }),
    },
    audit: { events: async () => ({ success: true, data: { items: [] } }) },
  },
}))

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { default: StaffPage } = await import('@/test-utils/staff-test-routes')
const { default: ToastHost, clearToastsForTest } = await import('@/components/shared/toast')

const locationAssign = vi.fn()

async function mount() {
  // 保存の知らせは Toast（右下・4秒）で出す。置き場所も一緒に描く。
  await act(async () => { render(<><StaffPage /><ToastHost /></>) })
  await waitFor(() => expect(screen.getByRole('button', { name: '対象の人の中身を見る' })).toBeTruthy())
  await waitFor(() => expect(screen.getByText('ログイン中の端末を確認')).toBeTruthy())
  fireEvent.click(screen.getByText('ログイン中の端末を確認'))
}

beforeEach(() => {
  fixture.tab = 'members'
  fixture.sessionsList.mockReset().mockResolvedValue({ success: true, data: { sessions: SESSIONS } })
  fixture.sessionsRevoke.mockReset().mockResolvedValue({ success: true, data: { revoked: 1, current: false } })
  fixture.sessionsRevokeOthers.mockReset().mockResolvedValue({ success: true, data: { revoked: 1 } })
  fixture.staffUpdate.mockReset()
  fixture.staffStepUp.mockReset()
  state.members = [member({})]
  state.users = [accessUser({})]
  locationAssign.mockReset()
  vi.spyOn(window.location, 'assign').mockImplementation(locationAssign)
  clearToastsForTest()
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('ログイン中の端末 (N-427)', () => {
  it('自分のセッションが並び、今の端末に印が付く', async () => {
    await mount()
    expect(fixture.sessionsList).toHaveBeenCalledTimes(1)
    expect(screen.getByText('この端末')).toBeTruthy()
    expect(screen.getByText(/iPhone \/ iPad・Safari/)).toBeTruthy()
  })

  it('他の端末は確認なしで1件終了できる', async () => {
    await mount()
    const buttons = screen.getAllByRole('button', { name: 'ログインを終了' })
    // 2件目が他端末
    await act(async () => { fireEvent.click(buttons[1]) })
    expect(fixture.sessionsRevoke).toHaveBeenCalledWith('hash-phone', { confirmCurrent: false })
    await waitFor(() => expect(screen.getByRole('status', { name: '知らせ' }).textContent).toContain('ログインを終了しました'))
  })

  it('今の端末は確認を挟み、確定するとログイン画面へ戻る', async () => {
    await mount()
    const buttons = screen.getAllByRole('button', { name: 'ログインを終了' })
    // 1件目が現在の端末。押してもまだ消さず、確認窓が立つ。
    await act(async () => { fireEvent.click(buttons[0]) })
    expect(fixture.sessionsRevoke).not.toHaveBeenCalled()
    await screen.findByText('この端末のログインを終了しますか？')

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'この端末を終了する' })) })
    expect(fixture.sessionsRevoke).toHaveBeenCalledWith('hash-current', { confirmCurrent: true })
    await waitFor(() => expect(locationAssign).toHaveBeenCalledWith('/login'))
  })

  it('この端末以外をすべて終了できる', async () => {
    await mount()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'この端末以外をすべて終了' })) })
    await screen.findByText('この端末以外のログインをすべて終了しますか？')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'すべて終了する' })) })
    expect(fixture.sessionsRevokeOthers).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.getByRole('status', { name: '知らせ' }).textContent).toContain('1 件のログインを終了しました'))
  })
})

describe('権限変更の直前再認証 (N-427)', () => {
  async function openEditModal() {
    await mount()
    // : 変更するは行の「…」から開く。
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /の操作$/ }))
    })
    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: '役割を変更する' })) })
    await screen.findByText('ログインユーザーを編集する')
  }

  it('保存が 428 で止まったら本人確認の窓が立ち、grant を付けて保存し直す', async () => {
    fixture.staffUpdate
      .mockRejectedValueOnce(new MockApiError(428, '権限の変更には二段階認証による再認証が必要です', 'STEP_UP_REQUIRED'))
      .mockResolvedValueOnce({ success: true, data: member({ role: 'admin' }) })
    fixture.staffStepUp.mockResolvedValue({ success: true, data: { token: 'grant-token-1', purpose: 'staff.permissions.change', expiresAt: '2026-09-08T01:05:00.000Z' } })

    await openEditModal()
    // 役割を「管理者」へ変えて保存
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '管理者' })) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存する' })) })

    // 1回目は grant 無しで止められ、本人確認の窓が立つ
    await screen.findByText('認証アプリで本人確認')
    expect(fixture.staffUpdate).toHaveBeenCalledTimes(1)
    expect(fixture.staffUpdate.mock.calls[0][2]).toBeUndefined()

    // 6桁コードを入れると grant を取り、同じ保存へ token を付けてやり直す
    // 認証コード入力（★管理画面 xHzFK）の1マス目へまとめて入れると、6マスへ振り分けられる。
    // 6桁目が入った瞬間に送られる（動きの点検・6。「本人確認して実行」を押さなくてよい）。
    await act(async () => { fireEvent.change(screen.getByLabelText('1桁目'), { target: { value: '123456' } }) })

    expect(fixture.staffStepUp).toHaveBeenCalledWith({ method: 'totp', value: '123456', purpose: 'staff.permissions.change' })
    await waitFor(() => expect(fixture.staffUpdate).toHaveBeenCalledTimes(2))
    expect(fixture.staffUpdate.mock.calls[1][2]).toBe('grant-token-1')
    expect(screen.queryByText('認証アプリで本人確認')).toBeNull()
  })

  it('権限に触れない変更（メールだけ）は再認証なしで通る', async () => {
    fixture.staffUpdate.mockResolvedValue({ success: true, data: member({}) })
    await openEditModal()
    fireEvent.change(screen.getByDisplayValue('member@example.test'), { target: { value: 'new@example.test' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存する' })) })
    await waitFor(() => expect(fixture.staffUpdate).toHaveBeenCalledTimes(1))
    expect(fixture.staffStepUp).not.toHaveBeenCalled()
    expect(screen.queryByText('認証アプリで本人確認')).toBeNull()
  })
})

// Self-security loading is covered separately; retain this suite’s original operation assertions.
vi.mock('@/v8/settings/staff/self-mfa', () => ({ default: () => null }))
