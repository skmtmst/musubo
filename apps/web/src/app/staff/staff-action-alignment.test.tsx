// @vitest-environment happy-dom
/*
 * N-428/N-429/N-431 (#834): 表示している操作と実際の処理を一致させる。
 *
 * ソース文字列ではなく実物の StaffPage をマウントし、次を確かめる。
 *   - 別ユーザーの権限のかたまりは下書きへコピーするだけで、保存前は更新しない
 *   - 二段階認証の操作はログイン中の本人にだけ出す
 *   - 「この人を外す」は確認後に一度だけ停止口を呼び、失敗理由を窓に残す
 */

import { act } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StaffMember } from '@line-crm/shared'

const fixture = vi.hoisted(() => ({
  updateStaff: vi.fn(),
  deleteStaff: vi.fn(),
  disableTwoFactor: vi.fn(),
}))

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
  members: [
    member({}),
    member({ id: 'source', name: 'コピー元さん', email: 'source@example.test', role: 'viewer' }),
    member({ id: 'me', name: 'ログイン中の人', email: 'me@example.test', role: 'admin' }),
  ],
  users: [
    accessUser({}),
    accessUser({ id: 'source', name: 'コピー元さん', email: 'source@example.test', roleBundle: 'view_only' }),
    accessUser({ id: 'me', name: 'ログイン中の人', email: 'me@example.test', roleBundle: 'administrator' }),
  ],
}

vi.mock('@/lib/api', async importOriginal => {
  class ApiError extends Error {}
  return { ...(await importOriginal<typeof import('@/lib/api')>()),
    ApiError,
    fetchApi: vi.fn(),
    // R497-SAVE-WORDING: page が保存catchで使う。本物（api.ts）の
    // 非ApiError分岐と同一。この画面が流す入力は全てこの分岐に落ちる。
    describeSaveFailure: (err: unknown) => {
      if (err instanceof Error && /[ぁ-んァ-ヶ一-龠]/u.test(err.message)) return err.message
      return '保存できませんでした。通信が切れている可能性があります。接続を確かめて、もう一度お試しください。'
    },
    api: {
      staff: {
        list: async () => ({ success: true, data: state.members }),
        me: async () => ({ success: true, data: state.members.find((item) => item.id === 'me')! }),
        update: fixture.updateStaff,
        delete: fixture.deleteStaff,
        disableTwoFactor: fixture.disableTwoFactor,
        loginSummary: async () => ({ success: true, data: { loginCount: 1 } }),
      },
      lineAccounts: { list: async () => ({ success: true, data: [] }) },
      access: {
        users: async () => ({
          success: true,
          data: {
            items: state.users,
            summary: {
              active: state.users.filter((user) => user.status === 'active').length, invited: 0, expiredInvitations: 0, unused90Days: 0, mfaEnabled: 0, mfaRate: 0,
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
const { default: ToastHost, clearToastsForTest } = await import('@/components/shared/toast')

async function mount() {
  // 保存の知らせは Toast（右下・4秒）で出す。置き場所も一緒に描く。
  await act(async () => { render(<><StaffPage /><ToastHost /></>) })
  await waitFor(() => expect(screen.getByRole('button', { name: '対象者の中身を見る' })).toBeTruthy())
}

function rowFor(name: string): HTMLTableRowElement {
  return screen.getByRole('button', { name: `${name}の中身を見る` }).closest('[role="row"]') as HTMLElement
}

beforeEach(() => {
  fixture.updateStaff.mockReset().mockResolvedValue({ success: true, data: state.members[0] })
  fixture.deleteStaff.mockReset().mockResolvedValue({ success: true, data: state.members[0] })
  fixture.disableTwoFactor.mockReset()
  clearToastsForTest()
})

afterEach(() => cleanup())

describe('ログインユーザー操作の表示と実処理 (#834)', () => {
  it('別ユーザーの権限のかたまりは保存前APIなしで下書きへコピーする', async () => {
    await mount()
    fireEvent.click(within(rowFor('対象者')).getByRole('button', { name: /の中身を見る$/ }))

    fireEvent.click(screen.getByRole('button', { name: 'ほかの人と同じにする' }))
    fireEvent.click(screen.getByRole('button', { name: 'コピー元のログインユーザー' }))
    fireEvent.click(screen.getByRole('radio', { name: 'コピー元さん（閲覧のみ）' }))
    fireEvent.click(screen.getByRole('button', { name: '選択する' }))

    expect(fixture.updateStaff).not.toHaveBeenCalled()
    // 画面の中の知らせ（role=status）。置き場所の知らせの入れ物も role=status なので、全部の中から文で見る
    expect(screen.getAllByRole('status').map((el) => el.textContent).join('\n')).toContain('コピー元さんの「閲覧のみ」を下書きに反映しました')

    fireEvent.click(screen.getByRole('button', { name: /見せる範囲を保存/ }))
    expect(fixture.updateStaff).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '保存する' }))
    await waitFor(() => expect(fixture.updateStaff).toHaveBeenCalledTimes(1))
    // N-424: bundle名をそのまま送る（roleへ潰すと受付/運用が区別できない）。
    // R498/R499: 同じ保存の送り直しに備えて要求キー、同時編集の競合検出に版を付ける。
    expect(fixture.updateStaff).toHaveBeenCalledWith('target', expect.objectContaining({ roleBundle: 'view_only', permissionScope: undefined, emailMask: undefined }), undefined)
    const sent = fixture.updateStaff.mock.calls[0][1] as Record<string, unknown>
    expect(typeof sent.idempotencyKey).toBe('string')
    expect(sent.expectedPolicyVersion).toBe(1)
  })

  it('「項目ごとに決める」を触ると3択表ごと更新口へ送る（N-424）', async () => {
    await mount()
    fireEvent.click(within(rowFor('対象者')).getByRole('button', { name: /の中身を見る$/ }))

    // 対象者は「運用」。プリセットでは「設定」は出さない → 「変えられる」へ直すと個別設定になる。
    fireEvent.click(screen.getByRole('button', { name: '設定：変えられる（変更できる）' }))
    fireEvent.click(screen.getByRole('button', { name: /見せる範囲を保存/ }))
    fireEvent.click(screen.getByRole('button', { name: '保存する' }))
    await waitFor(() => expect(fixture.updateStaff).toHaveBeenCalledTimes(1))
    const [, payload] = fixture.updateStaff.mock.calls[0] as unknown as [string, { roleBundle?: string; permissionScope?: Record<string, string>; emailMask?: string }]
    expect(payload.roleBundle).toBe('operations')
    expect(payload.permissionScope?.settings).toBe('edit')
    // 個人情報行はプリセットのまま伏せ字
    expect(payload.emailMask).toBe('masked')
  })

  it('コピー元には対象本人を出さない', async () => {
    await mount()
    fireEvent.click(within(rowFor('対象者')).getByRole('button', { name: /の中身を見る$/ }))
    fireEvent.click(screen.getByRole('button', { name: 'ほかの人と同じにする' }))
    fireEvent.click(screen.getByRole('button', { name: 'コピー元のログインユーザー' }))

    expect(screen.queryByRole('radio', { name: '対象者（スタッフ）' })).toBeNull()
    expect(screen.getByRole('radio', { name: 'コピー元さん（閲覧のみ）' })).toBeTruthy()
  })

  it('見せる範囲の保存を同一render内で二度押ししても更新は1回だけになる', async () => {
    let release: (() => void) | null = null
    fixture.updateStaff.mockImplementation(() => new Promise((resolve) => {
      release = () => resolve({ success: true, data: state.members[0] })
    }))
    await mount()
    fireEvent.click(within(rowFor('対象者')).getByRole('button', { name: /の中身を見る$/ }))
    // R497: 何も変えない保存は更新要求を送らない。二度押しの検証は変更ありで行う。
    fireEvent.click(screen.getByRole('button', { name: '設定：変えられる（変更できる）' }))

    const save = screen.getByRole('button', { name: /見せる範囲を保存/ })
    await act(async () => {
      fireEvent.click(save)
      fireEvent.click(save)
    })

    expect(fixture.updateStaff).not.toHaveBeenCalled()
    const confirm = screen.getByRole('button', { name: '保存する' })
    await act(async () => {
      fireEvent.click(confirm)
      fireEvent.click(confirm)
    })

    expect(fixture.updateStaff).toHaveBeenCalledTimes(1)
    await act(async () => { release?.() })
    await waitFor(() => expect(screen.queryByRole('button', { name: /見せる範囲を保存/ })).toBeNull())
  })

  it('二段階認証は本人だけ操作でき、他人は状態表示だけになる', async () => {
    await mount()

    expect(within(rowFor('対象者')).getByTitle('確認が必要')).toBeTruthy()
    fireEvent.click(within(rowFor('対象者')).getByRole('button', { name: '対象者の操作' }))
    expect(screen.queryByRole('menuitem', { name: '二段階認証を設定する' })).toBeNull()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    fireEvent.click(within(rowFor('ログイン中の人')).getByRole('button', { name: 'ログイン中の人の操作' }))
    expect(screen.getByRole('menuitem', { name: '二段階認証を設定する' })).toBeTruthy()
  })

  it('二段階認証を解除する前に設定し直せると説明し、取消では解除しない', async () => {
    const me = state.members.find(member => member.id === 'me')!
    const old = me.twoFactorEnabled
    me.twoFactorEnabled = true
    try {
      await mount()
      fireEvent.click(within(rowFor('ログイン中の人')).getByRole('button', { name: 'ログイン中の人の操作' }))
      fireEvent.click(screen.getByRole('menuitem', { name: '二段階認証を解除する' }))
      const dialog = screen.getByRole('dialog', { name: /二段階認証を解除しますか/ })
      expect(dialog.textContent).toContain('LINEログインだけでログインできるようになります。')
      expect(dialog.textContent).toContain('あとから「二段階認証を設定する」で、設定し直せます。')
      expect(fixture.disableTwoFactor).not.toHaveBeenCalled()
      expect(fixture.updateStaff).not.toHaveBeenCalled()
      fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }))
      expect(screen.queryByRole('dialog', { name: /二段階認証を解除しますか/ })).toBeNull()
      expect(fixture.disableTwoFactor).not.toHaveBeenCalled()
    } finally { me.twoFactorEnabled = old }
  })

  it('外す操作は確認前に呼ばず、確認後の素早い二度押しでも1回だけ呼ぶ', async () => {
    let release: (() => void) | null = null
    fixture.deleteStaff.mockImplementation(() => new Promise((resolve) => {
      release = () => resolve({ success: true, data: state.members[0] })
    }))
    await mount()

    /* 外すは行の「…」の中。開いてから項目を押す（確認フロー自体は変えない）。
       項目は最上層（MenuPortal→document.body）に出るので画面全体で探す。 */
    fireEvent.click(within(rowFor('対象者')).getByRole('button', { name: '対象者の操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '削除' }))
    expect(fixture.deleteStaff).not.toHaveBeenCalled()

    const confirm = screen.getByRole('button', { name: '外す' })
    await act(async () => {
      fireEvent.click(confirm)
      fireEvent.click(confirm)
    })
    expect(fixture.deleteStaff).toHaveBeenCalledTimes(1)
    expect(fixture.deleteStaff).toHaveBeenCalledWith('target', undefined)

    await act(async () => { release?.() })
    await waitFor(() => expect(screen.queryByRole('button', { name: '外す' })).toBeNull())
  })

  it('外す操作の失敗理由を確認窓に残し、押し直せる', async () => {
    fixture.deleteStaff.mockRejectedValue(new Error('最後の管理者は外せません'))
    await mount()

    fireEvent.click(within(rowFor('対象者')).getByRole('button', { name: '対象者の操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '削除' }))
    fireEvent.click(screen.getByRole('button', { name: '外す' }))

    await waitFor(() => expect(screen.getByText('最後の管理者は外せません')).toBeTruthy())
    expect(fixture.deleteStaff).toHaveBeenCalledTimes(1)
    expect((screen.getByRole('button', { name: '外す' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('いまいる人には利用停止中の人を混ぜず、件数と行をactiveだけに揃える', async () => {
    state.members.push(member({ id: 'suspended', name: '利用停止中の人', email: 'suspended@example.test', isActive: false }))
    state.users.push(accessUser({ id: 'suspended', name: '利用停止中の人', email: 'suspended@example.test', status: 'suspended' }))
    try {
      await mount()

      expect(screen.getByRole('tab', { name: 'ユーザー' })).toBeTruthy()
      expect(screen.queryByText('利用停止中の人')).toBeNull()
      expect(screen.getByText('ユーザー 3 人中 3 人を表示')).toBeTruthy()
    } finally {
      state.members.pop()
      state.users.pop()
    }
  })

  it('見せる範囲の保存は再ログインを確認し、取消・成功・失敗を正しく出す', async () => {
    await mount()
    fireEvent.click(within(rowFor('対象者')).getByRole('button', { name: /の中身を見る$/ }))
    // R497: 何も変えない保存は確認窓を出さず閉じるだけ。確認の検証は変更ありで行う。
    fireEvent.click(screen.getByRole('button', { name: '設定：変えられる（変更できる）' }))
    fireEvent.click(screen.getByRole('button', { name: /見せる範囲を保存/ }))

    expect(screen.getByText('保存すると、対象者のすべてのログインが終了します。新しい権限で使うには、対象者がもう一度ログインする必要があります。')).toBeTruthy()
    expect(screen.getByText('保存すると、対象者はもう一度ログインする必要があります。')).toBeTruthy()
    expect(screen.queryByText('権限を変えると、その場で効きます。')).toBeNull()
    expect(fixture.updateStaff).not.toHaveBeenCalled()
    fireEvent.click(within(screen.getByRole('dialog', { name: /見せる範囲を保存しますか/ })).getByRole('button', { name: 'キャンセル' }))
    expect(fixture.updateStaff).not.toHaveBeenCalled()

    fixture.updateStaff.mockRejectedValueOnce(new Error('保存できません'))
    fireEvent.click(screen.getByRole('button', { name: /見せる範囲を保存/ }))
    fireEvent.click(screen.getByRole('button', { name: '保存する' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('失敗：保存できません'))
    expect(screen.getByRole('button', { name: '保存する' })).toBeTruthy()

    fixture.updateStaff.mockResolvedValueOnce({ success: true, data: state.members[0] })
    fireEvent.click(screen.getByRole('button', { name: '保存する' }))
    await waitFor(() => expect(screen.getByRole('status', { name: '知らせ' }).textContent).toContain('対象者のすべてのログインを終了したため、新しい権限で使うにはもう一度ログインが必要です。'))
  })
})
