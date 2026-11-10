// @vitest-environment happy-dom
import { rememberStaffIdentity, forgetStaffIdentity } from '@/lib/staff-identity-state'
import type { StaffMember } from '@line-crm/shared'
/*
 * ★V8 統括の上の帯（絵 V8-B/・オーナー 2026-10-07「統括の方が全然良くない」）。
 *
 *   - 統括の画面では、切替の札に「統括」と統括名（/api/tenants/me）、名前の下に「統括」
 *   - パンくずの「ホーム」は統括のホーム（/hq）
 *   - 札から店を選んだら、その店へ入る（/ へ移る）
 *   - 店の画面・管理画面 の統括は今までどおり（「LINEアカウント」・役割の言葉）
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UNSAVED_ACTION_EVENT } from '@/lib/unsaved-action'
import { api } from '@/lib/api'

const fixture = vi.hoisted(() => ({
  pathname: '/hq',
  theme: 'v8' as 'v8' | 'v7',
  push: vi.fn(),
  setSelectedAccountId: vi.fn(),
  tenantsMe: vi.fn(),
  selectedAccountId: null as string | null,
  loading: false,
  error: null as string | null,
  refreshing: false,
  refreshAccounts: vi.fn(),
  accounts: [{ id: 'account-1', name: '然-NEN- 本店', displayName: null }],
  notificationList: vi.fn(),
  followerImportState: vi.fn(),
  restoreApi: undefined as (() => void) | undefined,
}))

const localStorageValues = new Map<string, string>()
const testLocalStorage = {
  getItem: (key: string) => localStorageValues.get(key) ?? null,
  setItem: (key: string, value: string) => { localStorageValues.set(key, String(value)) },
  removeItem: (key: string) => { localStorageValues.delete(key) },
  clear: () => { localStorageValues.clear() },
}
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: testLocalStorage })
Object.defineProperty(window, 'localStorage', { configurable: true, value: testLocalStorage })

vi.mock('next/navigation', () => {
  const router = { push: fixture.push, replace: vi.fn() }
  return { usePathname: () => fixture.pathname, useRouter: () => router }
})
vi.mock('next/link', async () => {
  const React = await import('react')
  return { default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => React.createElement('a', { href, ...props }, children) }
})
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({
    accounts: fixture.accounts,
    selectedAccountId: fixture.selectedAccountId,
    setSelectedAccountId: fixture.setSelectedAccountId,
    clearSelectedAccountId: vi.fn(),
    loading: fixture.loading,
    error: fixture.error,
    refreshing: fixture.refreshing,
    refreshAccounts: fixture.refreshAccounts,
  }),
}))
vi.mock('@/components/shell/page-chrome', () => ({ usePageChrome: () => ({ title: null, crumbs: null, fullWidth: false, settingsNavInline: false }) }))
vi.mock('@/lib/use-manual-href', () => ({ useManualHref: () => null }))
vi.mock('@/lib/use-brand', () => ({ useBrand: () => ({ name: '株式会社 然', iconUrl: null }) }))

import AppTopBar from './app-top-bar'
import TopBar from '@/components/shared/top-bar'
import StoreSelectionGate from '@/components/store-selection-gate'
import RootLandingGate from '@/components/root-landing-gate'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('★V8 統括の上の帯', () => {
  beforeEach(() => {
    const list = vi.spyOn(api.notifications.center, 'list').mockImplementation(fixture.notificationList)
    const tenants = vi.spyOn(api.tenants, 'me').mockImplementation(fixture.tenantsMe)
    const importState = vi.spyOn(api.lineAccounts, 'followerImportState').mockImplementation(fixture.followerImportState)
    fixture.restoreApi = () => { list.mockRestore(); tenants.mockRestore(); importState.mockRestore() }
    forgetStaffIdentity()
    fixture.pathname = '/hq'
    fixture.theme = 'v8'
    fixture.push.mockReset()
    fixture.setSelectedAccountId.mockReset()
    fixture.tenantsMe.mockReset()
    fixture.tenantsMe.mockResolvedValue({ success: true, data: { name: '然 -NEN- 本部' } })
    fixture.selectedAccountId = null
    fixture.loading = false
    fixture.error = null
    fixture.refreshing = false
    fixture.refreshAccounts.mockReset()
    fixture.accounts = [{ id: 'account-1', name: '然-NEN- 本店', displayName: null }]
    fixture.notificationList.mockReset()
    fixture.notificationList.mockResolvedValue({ success: true, data: { items: [], counts: { all: 0, error: 0, update: 0, unread: 0 }, unreadCount: 0 } })
    fixture.followerImportState.mockReset()
    fixture.followerImportState.mockResolvedValue({ success: true, data: { phase: 'not_started' } })
    document.documentElement.dataset.theme = fixture.theme
    window.localStorage.setItem('lh_staff_name', 'Demo Person')
    window.localStorage.setItem('lh_staff_role', 'owner')
    rememberStaffIdentity({ role: 'owner' } as StaffMember)
  })

  afterEach(() => {
    cleanup()
    fixture.restoreApi?.()
    delete document.documentElement.dataset.theme
  })

  it('切り替え一覧は統括一覧と同じ友だち数の多い順に並ぶ', async () => {
    fixture.accounts = [
      Object.assign({ id: 'a', name: '少ない店', displayName: null }, { stats: { friendCount: 2 } }),
      Object.assign({ id: 'b', name: '多い店', displayName: null }, { stats: { friendCount: 50 } }),
      Object.assign({ id: 'c', name: '中くらいの店', displayName: null }, { stats: { friendCount: 10 } }),
    ]
    const view = render(<AppTopBar />)
    fireEvent.click(view.getByRole('button', { name: 'アカウントを切り替える' }))
    const rows = await view.findAllByRole('menuitemradio')
    expect(rows.map(row => row.getAttribute('aria-label'))).toEqual(['多い店', '中くらいの店', '少ない店'])
  })

  it('札は「統括」と統括名、ホームは /hq（自分の名前・ログアウトは左下へ移したので出さない）', async () => {
    const view = render(<AppTopBar />)
    await waitFor(() => expect(view.getAllByText('然 -NEN- 本部').length).toBeGreaterThan(0))
    // 「LINEアカウント」は V8 で隠れる外の見出しだけ（札の中の小さい字は「統括」）。店の画面では札の中にも出て 2 つになる。
    expect(view.getAllByText('LINEアカウント')).toHaveLength(1)
    expect(view.getAllByText('統括').length).toBeGreaterThanOrEqual(1)
    // ★V8 左下の自分とメニュー（オーナー 2026-10-07）：上の帯に名前とログアウトを出さない。
    expect(view.queryAllByText('Demo Person')).toHaveLength(0)
    expect(view.queryAllByRole('button', { name: 'ログアウト' })).toHaveLength(0)
    expect(view.queryAllByText('オーナー')).toHaveLength(0)
    expect(view.getByRole('link', { name: 'ホーム' }).getAttribute('href')).toBe('/hq')
  })

  it('統括名が取れなければ「統括」で出す（帯は壊れない）', async () => {
    fixture.tenantsMe.mockRejectedValue(new Error('down'))
    const view = render(<AppTopBar />)
    await act(async () => { await Promise.resolve() })
    expect(view.queryAllByText('然 -NEN- 本部')).toHaveLength(0)
    expect(view.getAllByText('統括').length).toBeGreaterThanOrEqual(2)
  })

  it.each(['/friends', '/'])('アカウント一覧の失敗は%sの中央1か所で示し、読み直して復旧できる', async (pathname) => {
    fixture.pathname = pathname
    fixture.accounts = []
    fixture.error = 'アカウント一覧を読み込めませんでした'
    const Gate = pathname === '/' ? RootLandingGate : StoreSelectionGate
    const content = () => <><AppTopBar /><Gate><p>取得後の画面本体</p></Gate></>
    const view = render(content())
    await view.findByText('アカウント一覧を読み込めませんでした')
    expect(view.queryByText('LINEアカウントの一覧を読み込めませんでした。')).toBeNull()
    const retries = view.getAllByRole('button', { name: /^(もう一度読み込む|再読み込み)$/ })
    expect(retries).toHaveLength(1)
    expect(view.queryByText('取得後の画面本体')).toBeNull()
    fireEvent.click(retries[0])
    expect(fixture.refreshAccounts).toHaveBeenCalledTimes(1)

    fixture.refreshing = true
    view.rerender(content())
    const retrying = view.getByRole('button', { name: '読み込んでいます' }) as HTMLButtonElement
    expect(retrying.disabled).toBe(true)
    fireEvent.click(retrying)
    expect(fixture.refreshAccounts).toHaveBeenCalledTimes(1)

    fixture.refreshing = false
    fixture.error = null
    fixture.accounts = [{ id: 'account-1', name: '然-NEN- 本店', displayName: null }]
    fixture.selectedAccountId = 'account-1'
    view.rerender(content())
    await view.findByText('取得後の画面本体')
    expect(view.queryByText('アカウント一覧を読み込めませんでした')).toBeNull()
  })

  it.each(['/settings/customer-look', '/staff', '/accounts', '/emergency'])('選択不要の%sでもアカウント一覧の失敗と再読み込みを1か所に残す', async (pathname) => {
    fixture.pathname = pathname
    fixture.accounts = []
    fixture.error = 'アカウント一覧を読み込めませんでした'
    const content = () => <><AppTopBar /><StoreSelectionGate><p>選択不要の画面本体</p></StoreSelectionGate></>
    const view = render(content())
    await view.findByText('LINEアカウントの一覧を読み込めませんでした。')
    expect(view.getAllByText('LINEアカウントの一覧を読み込めませんでした。')).toHaveLength(1)
    expect(view.getAllByRole('button', { name: /^(もう一度読み込む|再読み込み)$/ })).toHaveLength(1)
    expect(view.getByText('選択不要の画面本体')).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: '再読み込み' }))
    expect(fixture.refreshAccounts).toHaveBeenCalledTimes(1)
    fixture.refreshing = true
    view.rerender(content())
    const busy = view.getByRole('button', { name: '読み込んでいます' }) as HTMLButtonElement
    expect(busy.disabled).toBe(true)
    fireEvent.click(busy)
    expect(fixture.refreshAccounts).toHaveBeenCalledTimes(1)
    fixture.refreshing = false
    fixture.error = null
    fixture.accounts = [{ id: 'account-1', name: '然-NEN- 本店', displayName: null }]
    view.rerender(content())
    expect(view.queryByText('LINEアカウントの一覧を読み込めませんでした。')).toBeNull()
    expect(view.queryByRole('button', { name: '再読み込み' })).toBeNull()
    expect(view.getByText('選択不要の画面本体')).toBeTruthy()
  })

  it.each(['/hq', '/friends'])('前の選択が残る%sでも、統括だけ全アカウントの通知を読む', async (pathname) => {
    fixture.pathname = pathname
    fixture.selectedAccountId = 'account-1'
    fixture.accounts = [...fixture.accounts, { id: 'account-2', name: '第2店', displayName: null }]
    const view = render(<AppTopBar />)
    await act(async () => { await Promise.resolve() })
    await act(async () => { fireEvent.click(view.getByRole('button', { name: /^通知/ })) })
    await view.findByRole('dialog', { name: '通知' })
    await waitFor(() => expect(fixture.notificationList).toHaveBeenCalledWith('account-1', { limit: 50 }))
    if (pathname === '/hq') expect(fixture.notificationList).toHaveBeenCalledWith('account-2', { limit: 50 })
    else expect(fixture.notificationList.mock.calls.some(([id]) => id === 'account-2')).toBe(false)
  })

  it.each([null, 'account-1'])('統括の選択%sでも開く前後はA1+B2の合計3件', async (selected) => {
    fixture.selectedAccountId = selected
    fixture.accounts = [...fixture.accounts, { id: 'account-2', name: '第2店', displayName: null }]
    fixture.notificationList.mockImplementation(async (id: string) => ({ success: true, data: { items: [], counts: { all: 3, error: 0, update: 0, unread: id === 'account-1' ? 1 : 2 }, unreadCount: id === 'account-1' ? 1 : 2 } }))
    const view = render(<AppTopBar />)
    const bell = await view.findByRole('button', { name: '通知（未読 3 件）' })
    expect(bell.querySelector('[data-count-unknown]')).toBeNull()
    expect(Array.from(bell.querySelectorAll('span')).map((badge) => badge.textContent)).toContain('3')
    await act(async () => { fireEvent.click(bell) })
    await view.findByText('未読 3')
    expect(bell.getAttribute('aria-label')).toBe('通知（未読 3 件）')
    await act(async () => { fireEvent.click(bell) })
    expect(bell.getAttribute('aria-label')).toBe('通知（未読 3 件）')
  })

  it('個別店の札はその店だけで、切替前の遅い未読結果を採用しない', async () => {
    fixture.pathname = '/friends'
    fixture.selectedAccountId = 'account-1'
    let finish!: (value: unknown) => void
    fixture.notificationList.mockImplementation((id: string) => id === 'account-1' ? new Promise(resolve => { finish = resolve }) : Promise.resolve({ success: true, data: { items: [], counts: { all: 2, error: 0, update: 0, unread: 2 }, unreadCount: 2 } }))
    const view = render(<AppTopBar />)
    await waitFor(() => expect(fixture.notificationList).toHaveBeenCalledWith('account-1', { limit: 1 }))
    fixture.selectedAccountId = 'account-2'
    view.rerender(<AppTopBar />)
    await view.findByRole('button', { name: '通知（未読 2 件）' })
    await act(async () => { finish({ success: true, data: { items: [], counts: { all: 8, error: 0, update: 0, unread: 8 }, unreadCount: 8 } }) })
    expect(view.getByRole('button', { name: '通知（未読 2 件）' })).toBeTruthy()
  })

  it('統括の未読が一部でも取得失敗なら0件ではなく不明として残す', async () => {
    fixture.accounts = [...fixture.accounts, { id: 'account-2', name: '第2店', displayName: null }]
    fixture.notificationList.mockImplementation(async (id: string) => id === 'account-2' ? { success: false, error: 'failed' } : { success: true, data: { items: [], counts: { all: 1, error: 0, update: 0, unread: 1 }, unreadCount: 1 } })
    const view = render(<AppTopBar />)
    await waitFor(() => expect(fixture.notificationList).toHaveBeenCalledTimes(2))
    const bell = view.getByRole('button', { name: '通知（未読数を確認できません）' })
    const unknownBadge = bell.querySelector('[data-count-unknown]')
    expect(unknownBadge?.textContent).toBe('')
    expect(unknownBadge?.getAttribute('aria-hidden')).toBe('true')
    expect(view.queryByRole('button', { name: '通知' })).toBeNull()
  })

  it('個別画面で店未選択なら、届いた店一覧があっても札/小窓は全店を取得しない', async () => {
    fixture.pathname = '/friends'
    fixture.selectedAccountId = null
    fixture.accounts = [...fixture.accounts, { id: 'account-2', name: '第2店', displayName: null }]
    const view = render(<AppTopBar />)
    await act(async () => { await Promise.resolve() })
    const bell = view.getByRole('button', { name: '通知' })
    await act(async () => { fireEvent.click(bell) })
    await view.findByText('LINEアカウントを選ぶと、そのアカウントの通知が出ます。')
    expect(fixture.notificationList).not.toHaveBeenCalled()
    expect(bell.getAttribute('aria-label')).toBe('通知')
  })

  it('最初の未読取得中は取得失敗の印を出さず、失敗した後にだけ不明を出す', async () => {
    let finish!: (value: unknown) => void
    fixture.notificationList.mockReturnValue(new Promise(resolve => { finish = resolve }))
    const view = render(<AppTopBar />)
    await waitFor(() => expect(fixture.notificationList).toHaveBeenCalled())
    expect(view.getByRole('button', { name: '通知' })).toBeTruthy()
    expect(view.queryByRole('button', { name: '通知（未読数を確認できません）' })).toBeNull()
    await act(async () => { finish({ success: false, error: 'failed' }) })
    expect(view.getByRole('button', { name: '通知（未読数を確認できません）' })).toBeTruthy()
  })

  it('統括通知から店へ移るときも未保存の確認で取りやめれば切替/遷移しない', async () => {
    fixture.accounts = [...fixture.accounts, { id: 'account-2', name: '第2店', displayName: null }]
    fixture.notificationList.mockImplementation(async (id: string) => ({ success: true, data: { items: [{ id: 'same', eventType: 'broadcast.failed', category: 'error', title: id, body: '', metadata: null, isRead: true, createdAt: '2026-10-27T00:00:00Z' }], counts: { all: 1, error: 1, update: 0, unread: 0 }, unreadCount: 0 } }))
    const view = render(<AppTopBar />)
    await act(async () => { fireEvent.click(view.getByRole('button', { name: /^通知/ })) })
    const target = await view.findByRole('button', { name: /第2店：account-2/ })
    const refuse = (event: Event) => event.preventDefault()
    window.addEventListener(UNSAVED_ACTION_EVENT, refuse, { once: true })
    try {
      await act(async () => { fireEvent.click(target) })
      expect(fixture.setSelectedAccountId).not.toHaveBeenCalled()
      expect(fixture.push).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener(UNSAVED_ACTION_EVENT, refuse)
    }
  })

  it('札から店を選ぶと、その店へ入る', async () => {
    const view = render(<AppTopBar />)
    await act(async () => { await Promise.resolve() })
    fireEvent.click(view.getByRole('button', { name: 'アカウントを切り替える' }))
    fireEvent.click(await view.findByRole('menuitemradio', { name: /然-NEN- 本店/ }))
    await waitFor(() => expect(fixture.setSelectedAccountId).toHaveBeenCalledWith('account-1'))
    expect(fixture.push).toHaveBeenCalledWith('/')
  })

  it('札から引き継ぎ中の店を選んでも店舗へ入れない', async () => {
    fixture.followerImportState.mockResolvedValue({ success: true, data: { phase: 'hydrating_profiles' } })
    const view = render(<AppTopBar />)
    await act(async () => { await Promise.resolve() })
    fireEvent.click(view.getByRole('button', { name: 'アカウントを切り替える' }))
    fireEvent.click(await view.findByRole('menuitemradio', { name: /然-NEN- 本店/ }))
    await waitFor(() => expect(fixture.push).toHaveBeenCalledWith('/accounts/new/handover?accountId=account-1'))
    expect(fixture.setSelectedAccountId).not.toHaveBeenCalled()
  })

  it('店の画面は今までどおり（「LINEアカウント」・役割はオーナー・ホームは /・選んでも移らない）', async () => {
    fixture.pathname = '/friends'
    const view = render(<AppTopBar />)
    await act(async () => { await Promise.resolve() })
    expect(fixture.tenantsMe).not.toHaveBeenCalled()
    expect(view.getAllByText('LINEアカウント')).toHaveLength(2)
    // ★V8：名前・役割・ログアウトは左下へ移した（オーナー 2026-10-07）。上の帯には出さない。
    expect(view.queryAllByText('Demo Person')).toHaveLength(0)
    expect(view.queryAllByText('オーナー')).toHaveLength(0)
    expect(view.queryAllByRole('button', { name: 'ログアウト' })).toHaveLength(0)
    expect(view.getByRole('link', { name: 'ホーム' }).getAttribute('href')).toBe('/')
    fireEvent.click(view.getByRole('button', { name: 'アカウントを切り替える' }))
    fireEvent.click(await view.findByRole('menuitemradio', { name: /然-NEN- 本店/ }))
    expect(fixture.push).not.toHaveBeenCalled()
  })

  it('店の画面：切り替えの一覧はアカウントだけ。統括に戻るのは左下の自分のメニュー（オーナー 2026-10-08）', async () => {
    fixture.pathname = '/friends'
    const view = render(<AppTopBar />)
    await act(async () => { await Promise.resolve() })
    fireEvent.click(view.getByRole('button', { name: 'アカウントを切り替える' }))
    await waitFor(() => expect(view.getByRole('menuitemradio', { name: /然-NEN- 本店/ })).toBeTruthy())
    expect(view.queryAllByRole('menuitem', { name: /統括に戻る/ })).toHaveLength(0)
    expect(view.queryAllByRole('button', { name: /統括へ/ })).toHaveLength(0)
  })

  it('店の画面：店だけの担当には［統括へ］も「統括に戻る」も出さない', async () => {
    fixture.pathname = '/friends'
    window.localStorage.setItem('lh_staff_role', 'staff')
    rememberStaffIdentity({ role: 'staff' } as StaffMember)
    const view = render(<AppTopBar />)
    await act(async () => { await Promise.resolve() })
    expect(view.queryAllByRole('button', { name: /統括へ/ })).toHaveLength(0)
    fireEvent.click(view.getByRole('button', { name: 'アカウントを切り替える' }))
    await waitFor(() => expect(view.getByRole('menuitemradio', { name: /然-NEN- 本店/ })).toBeTruthy())
    expect(view.queryAllByRole('menuitem', { name: /統括に戻る/ })).toHaveLength(0)
  })

  it('統括の画面には［統括へ］を出さない', async () => {
    const view = render(<AppTopBar />)
    await act(async () => { await Promise.resolve() })
    expect(view.queryAllByRole('button', { name: /統括へ/ })).toHaveLength(0)
  })

  it('旧テーマ指定でも統括名を取り、ホームと切り替えを出す', async () => {
    fixture.theme = 'v7'
    document.documentElement.dataset.theme = 'v7'
    const view = render(<AppTopBar />)
    await act(async () => { await Promise.resolve() })
    await waitFor(() => expect(view.getAllByText('然 -NEN- 本部').length).toBeGreaterThan(0))
    expect(fixture.tenantsMe).toHaveBeenCalledOnce()
    expect(view.getByRole('link', { name: 'ホーム' }).getAttribute('href')).toBe('/hq')
    expect(view.queryAllByText('Demo Person')).toHaveLength(0)
    expect(view.queryAllByRole('button', { name: 'ログアウト' })).toHaveLength(0)
  })

  it('旧テーマ指定でも店の切り替えを出し、自分の操作は左下に任せる', async () => {
    fixture.theme = 'v7'
    document.documentElement.dataset.theme = 'v7'
    fixture.pathname = '/friends'
    const view = render(<AppTopBar />)
    await act(async () => { await Promise.resolve() })
    expect(view.queryAllByText('Demo Person')).toHaveLength(0)
    expect(view.queryAllByText('オーナー')).toHaveLength(0)
    expect(view.queryAllByRole('button', { name: 'ログアウト' })).toHaveLength(0)
    expect(fixture.tenantsMe).not.toHaveBeenCalled()
    fireEvent.click(view.getByRole('button', { name: 'アカウントを切り替える' }))
    fireEvent.click(await view.findByRole('menuitemradio', { name: /然-NEN- 本店/ }))
    expect(fixture.setSelectedAccountId).toHaveBeenCalledWith('account-1')
    expect(fixture.push).not.toHaveBeenCalled()
  })
})


describe('アカウント未選択の共通の呼び名', () => {
  beforeEach(() => { fixture.loading = false; fixture.error = null; fixture.selectedAccountId = null; fixture.pathname = '/friends'; fixture.setSelectedAccountId.mockClear() })
  afterEach(() => { cleanup(); window.history.replaceState(null, '', '/hq') })
  it.each(['オーナー', ''])('上の帯は未選択と全文の案内を出す（役割=%s）', roleLabel => {
    const view = render(<TopBar title="友だち" accounts={[]} selectedAccountId="" onAccountChange={vi.fn()} roleLabel={roleLabel} userName="確認担当" onLogout={vi.fn()} v8Chrome showIdentity={false} />)
    const label = view.container.querySelector('[data-part="account-name"]')!
    expect(label.textContent).toBe('未選択')
    expect(label.getAttribute('title')).toBe('LINE公式アカウントを選んでください')
    expect(view.container.textContent).not.toContain('店舗を選択')
    expect(view.getByRole('button', { name: 'アカウントを切り替える' })).toBeTruthy()
  })

  it('個別画面は公式アカウントの案内にそろえ、元の画面へ戻る行き先を保つ', async () => {
    fixture.pathname = '/friends'
    fixture.selectedAccountId = null
    window.history.replaceState(null, '', '/friends?folder=followup')
    const view = render(<StoreSelectionGate><p>個別のデータ</p></StoreSelectionGate>)
    expect(view.getByRole('heading', { name: 'LINE公式アカウントを選んでください' })).toBeTruthy()
    expect(view.getByText('この画面はLINE公式アカウントごとのデータを扱います。統括のアカウント一覧から選んでください。')).toBeTruthy()
    const action = view.getByRole('link', { name: 'LINE公式アカウントを選ぶ' })
    await waitFor(() => expect(action.getAttribute('href')).toBe('/hq?return=%2Ffriends%3Ffolder%3Dfollowup'))
    expect(view.queryByText('個別のデータ')).toBeNull()
    expect(fixture.setSelectedAccountId).not.toHaveBeenCalled()
  })
})
