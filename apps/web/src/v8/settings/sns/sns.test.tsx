import { PERMISSION_LOCK_SUMMARY } from '@/components/shared/permission-lock'
// @vitest-environment happy-dom
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
/*
 * 設定 › SNS 連携の Instagram のカード（★V8-B `YINmJ`・`DFnll`／2026-10-07 利用者承認）。
 * 守るのは BEHAVIOR.md に書いた決めごと：
 *  - 状態のことばは4つ（接続しています／未接続／認可が切れています／設定がありません）。
 *  - 未接続・認可切れは注記＋［接続する］。ページを選ぶ段は出さない。
 *  - 接続済みは `@ユーザー名（ビジネス）`・「写真つき投稿の同時公開」＋［接続を確かめる］［接続を解除する］。
 *  - 「設定がありません」は注記だけ。押せないボタンは置かない。
 *  - 閲覧のみにはボタンを置かない。
 *  - 戻り先 `?instagram=connected|failed` の帯。
 */
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { InstagramConnectionStatus } from '@line-crm/shared'
import type { GoogleConnectionData } from '@/lib/restaurant-google-api'
import SnsSettingsPage from './sns'

const fixture = vi.hoisted(() => ({
  googleConnection: vi.fn(),
  googleConnectStart: vi.fn(),
  googleSelectLocation: vi.fn(),
  googleDisconnect: vi.fn(),
  igConnection: vi.fn(),
  igStart: vi.fn(),
  igRefresh: vi.fn(),
  igDisconnect: vi.fn(),
  replace: vi.fn(),
  role: { value: 'owner' as string | null },
  search: { value: '' },
  account: { selected: 'acc-1', accounts: [] as Array<{ id: string }> },
  selectAccount: vi.fn(),
}))

vi.mock('@/lib/restaurant-google-api', () => ({
  restaurantGoogleApi: { connection: fixture.googleConnection, connectStart: fixture.googleConnectStart, selectLocation: fixture.googleSelectLocation, disconnect: fixture.googleDisconnect },
}))

vi.mock('@/lib/api', () => ({
  api: {
    instagram: {
      connection: fixture.igConnection,
      start: fixture.igStart,
      refresh: fixture.igRefresh,
      disconnect: fixture.igDisconnect,
    },
  },
  ApiError: class ApiError extends Error {},
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: fixture.replace }),
  usePathname: () => '/settings/sns',
  useSearchParams: () => new URLSearchParams(fixture.search.value),
}))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: fixture.account.selected, accounts: fixture.account.accounts, setSelectedAccountId: fixture.selectAccount }),
}))
vi.mock('@/lib/use-running-version', () => ({ useRunningVersion: () => ({ detail: { deploy_env: 'staging' }, statusText: '稼働版を確認' }) }))
vi.mock('@/lib/line-accounts-cache', () => ({ loadLineAccounts: vi.fn(async () => ({ success: true, data: [{ id: 'acc-1', name: '移行前の店' }, { id: 'acc-2', name: '移行先の店' }] })) }))

vi.mock('@/lib/staff-role', () => ({
  useStaffRole: () => fixture.role.value,
  canManageRole: (role: string | null) => role === 'owner' || role === 'admin',
}))

vi.mock('@/components/shell/page-chrome', () => ({
  usePageTitle: () => {},
  usePageCrumbs: () => {},
  useHideSettingsNav: () => { throw new Error('SNS連携では設定メニューを隠さない') },
}))

function googleData(): GoogleConnectionData {
  return {
    success: true,
    store: { id: 'store-1', name: '然カフェ 本店', lineAccountId: 'acc-1' },
    connection: { status: 'disconnected', locationTitle: null },
    candidates: [],
    summary: {
      unrepliedCount: 0, draftCount: 0, attentionCount: 0, newCount: 0,
      storedCount: 0, postsAttentionCount: 0, syncStale: false,
    },
    writeEnabled: true,
    oauthConfigured: true,
    aiAvailable: false,
    permissions: { canManageConnection: true, canPublishReply: true },
  }
}

function status(state: InstagramConnectionStatus['state'], connection?: InstagramConnectionStatus['connection']): InstagramConnectionStatus {
  return { state, replyEnabled: false, ...(connection ? { connection } : {}) }
}

const CONNECTED = {
  pageId: 'page-1',
  instagramId: 'ig-1',
  pageName: '然カフェ',
  username: 'nen_cafe',
  expiresAt: '2026-12-31T00:00:00.000Z',
  dataAccessExpiresAt: null,
  version: 3,
  syncedAt: '2026-10-07T01:00:00.000Z',
}

function setup(state: InstagramConnectionStatus['state'], connection?: InstagramConnectionStatus['connection']) {
  fixture.googleConnection.mockResolvedValue(googleData())
  fixture.igConnection.mockResolvedValue({ success: true, data: status(state, connection) })
  render(<SnsSettingsPage />)
}

/* Googleのカードにも同じことば（「未接続」など）が出るので、Instagramのカードの中だけを見る。 */
function igCard() {
  return within(screen.getByRole('region', { name: 'Instagram' }))
}

/* 解除は見出しの右の「…」の中。 */
async function openIgMenu() {
  fireEvent.click(await igCard().findByRole('button', { name: 'Instagram の連携のその他操作' }))
}

afterEach(() => {
  cleanup()
  fixture.role.value = 'owner'
  fixture.search.value = ''
  fixture.account.selected = 'acc-1'
  fixture.account.accounts = []
  vi.resetAllMocks()
})

describe('Instagram のカード（★V8-B `YINmJ`・`DFnll`）', () => {
  it('未接続では注記と［接続する］を出し、ページを選ぶ段は出さない', async () => {
    setup('disconnected')

    expect(await igCard().findByText('未接続')).toBeTruthy()
    expect(screen.getByText('Instagram のビジネスアカウント（またはクリエイターアカウント）でログインしてください。個人のアカウントは接続できません。')).toBeTruthy()
    expect(igCard().getByRole('button', { name: '接続する' })).toBeTruthy()
    // ページを選ぶ段（利用者の決めで出さない）
    expect(screen.queryByText(/ページを選/)).toBeNull()
    // 未接続では解除・確認のボタンは出ない。
    expect(screen.queryByRole('button', { name: '接続を確かめる' })).toBeNull()
  })

  it('接続済みではアカウント名とできることを出し、確かめる・解除のボタンを出す', async () => {
    setup('connected', CONNECTED)

    expect(await screen.findByText('接続済み')).toBeTruthy()
    expect(screen.getByText('接続しているアカウント')).toBeTruthy()
    expect(screen.getByText('@nen_cafe（ビジネス）')).toBeTruthy()
    expect(screen.getByText('できること')).toBeTruthy()
    expect(screen.getByText('投稿を予約する')).toBeTruthy()
    expect(screen.getByRole('button', { name: /接続を確かめる/ })).toBeTruthy()
    await openIgMenu()
    expect(screen.getAllByRole('menuitem', { name: '接続を解除する' }).length).toBeGreaterThan(0)
    // 接続済みにはログインを促す注記を出さない。
    expect(screen.queryByText(/個人のアカウントは接続できません/)).toBeNull()
  })

  it('認可が切れているときはログインのボタンと解除のボタンを並べる', async () => {
    setup('expired', CONNECTED)

    expect((await screen.findAllByText('接続の異常')).length).toBeGreaterThan(0)
    expect(igCard().getByRole('button', { name: '接続する' })).toBeTruthy()
    await openIgMenu()
    expect(screen.getAllByRole('menuitem', { name: '接続を解除する' }).length).toBeGreaterThan(0)
  })

  it('「設定がありません」のときは注記だけで、押せるボタンを置かない', async () => {
    setup('unconfigured')

    expect((await screen.findAllByText('未設定')).length).toBeGreaterThan(0)
    expect(screen.getByText('この環境には Instagram 接続の設定がありません。')).toBeTruthy()
    expect(igCard().queryByRole('button', { name: '接続する' })).toBeNull()
    expect(screen.queryByRole('button', { name: /接続を確かめる/ })).toBeNull()
  })

  it('閲覧のみには閲覧のみの帯を出し、接続・解除・確認のボタンを置かない', async () => {
    fixture.role.value = verifiedStaffRole('staff')
    setup('connected', CONNECTED)

    expect(await screen.findByText(PERMISSION_LOCK_SUMMARY.feature)).toBeTruthy()
    expect(await screen.findByText('接続済み')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /接続を確かめる/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /その他操作/ })).toBeNull()
    expect(igCard().queryByRole('button', { name: '接続する' })).toBeNull()
  })

  it('［接続を確かめる］で確かめの口を呼び、読み直す', async () => {
    setup('connected', CONNECTED)

    fireEvent.click(await screen.findByRole('button', { name: /接続を確かめる/ }))
    await waitFor(() => expect(fixture.igRefresh).toHaveBeenCalledWith('acc-1'))
    await waitFor(() => expect(fixture.igConnection.mock.calls.length).toBeGreaterThan(1))
  })

  it.each(['disconnected', 'expired'] as const)('%s の閲覧のみには接続操作とログイン案内を出さない', async (state) => {
    fixture.role.value = verifiedStaffRole('staff')
    setup(state, state === 'expired' ? CONNECTED : undefined)

    await screen.findByText(PERMISSION_LOCK_SUMMARY.feature)
    await igCard().findByText(state === 'expired' ? '接続の異常' : '未接続')
    expect(igCard().queryByRole('button', { name: '接続する' })).toBeNull()
    expect(igCard().queryByText(/個人のアカウントは接続できません/)).toBeNull()
    expect(fixture.igStart).not.toHaveBeenCalled()
  })

  it('接続開始の処理中は操作を止め、失敗後も案内を保って再試行できる', async () => {
    let rejectStart!: (reason: Error) => void
    fixture.igStart.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectStart = reject }))
    setup('disconnected')

    const start = await igCard().findByRole('button', { name: '接続する' })
    fireEvent.click(start)
    expect(start.hasAttribute('disabled')).toBe(true)
    expect(igCard().getByText(/個人のアカウントは接続できません/)).toBeTruthy()
    fireEvent.click(start)
    expect(fixture.igStart).toHaveBeenCalledTimes(1)
    expect(fixture.igStart).toHaveBeenCalledWith('acc-1')

    rejectStart(new Error('offline'))
    await screen.findByText('Instagram のログイン画面を開けませんでした。もう一度お試しください。')
    expect(start.hasAttribute('disabled')).toBe(false)
    expect(igCard().getByText(/個人のアカウントは接続できません/)).toBeTruthy()
    expect(fixture.igDisconnect).not.toHaveBeenCalled()
  })

  it('［接続を解除する］は確認の小窓をはさみ、いまの版の番号を渡す', async () => {
    fixture.igDisconnect.mockResolvedValue({ success: true })
    setup('connected', CONNECTED)

    await openIgMenu()
    fireEvent.click(screen.getAllByRole('menuitem', { name: '接続を解除する' })[0])
    expect(await screen.findByText('Instagram の接続を解除しますか？')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '解除する' }))
    await waitFor(() => expect(fixture.igDisconnect).toHaveBeenCalledWith('acc-1', 3))
  })

  it('解除の窓を閉じて開くと古い確定は使えない', async () => {
    fixture.igDisconnect.mockResolvedValue({ success: true })
    setup('connected', CONNECTED)
    await openIgMenu()
    fireEvent.click(screen.getAllByRole('menuitem', { name: '接続を解除する' })[0])
    const dialog = within(await screen.findByRole('alertdialog'))
    const button = dialog.getByRole('button', { name: '解除する' })
    const key = Object.keys(button).find(k => k.startsWith('__reactProps$'))!
    const oldClick = (button as unknown as Record<string, { onClick: (event: unknown) => void }>)[key].onClick
    fireEvent.click(dialog.getByRole('button', { name: 'キャンセル' }))
    await openIgMenu()
    fireEvent.click(screen.getAllByRole('menuitem', { name: '接続を解除する' })[0])
    oldClick({ preventDefault() {}, stopPropagation() {} })
    expect(fixture.igDisconnect).not.toHaveBeenCalled()
  })

  it('確認中に接続先の版が変わると古い窓は使えない', async () => {
    fixture.igRefresh.mockResolvedValue({ success: true })
    setup('connected', CONNECTED)
    const refresh = await igCard().findByRole('button', { name: '接続を確かめる' })
    await openIgMenu()
    fireEvent.click(screen.getAllByRole('menuitem', { name: '接続を解除する' })[0])
    const dialog = within(await screen.findByRole('alertdialog'))
    const stale = dialog.getByRole('button', { name: '解除する' })
    fixture.igConnection.mockResolvedValue({ success: true, data: status('connected', { ...CONNECTED, instagramId: 'ig-2', version: 4 }) })
    fireEvent.click(refresh)
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    fireEvent.click(stale)
    expect(fixture.igDisconnect).not.toHaveBeenCalled()
  })

  it('解除前に対象と環境を示し、アカウントが変わると元の確認を実行できない', async () => {
    fixture.googleConnection.mockResolvedValue(googleData())
    fixture.igConnection.mockResolvedValue({ success: true, data: status('connected', CONNECTED) })
    const view = render(<SnsSettingsPage />)
    await openIgMenu()
    fireEvent.click(screen.getAllByRole('menuitem', { name: '接続を解除する' })[0])
    const dialog = within(await screen.findByRole('alertdialog'))
    expect(dialog.getByText('LINEアカウント')).toBeTruthy()
    expect(dialog.getByText('@nen_cafe')).toBeTruthy()
    expect(await dialog.findByText('移行前の店')).toBeTruthy()
    expect(dialog.getByText('検証環境')).toBeTruthy()
    const staleConfirm = dialog.getByRole('button', { name: '解除する' })
    fixture.account.selected = 'acc-2'
    view.rerender(<SnsSettingsPage />)
    fireEvent.click(staleConfirm)
    expect(fixture.igDisconnect).not.toHaveBeenCalled()
    fixture.account.selected = 'acc-1'
    view.rerender(<SnsSettingsPage />)
    expect(screen.queryByRole('alertdialog')).toBeNull()
    fireEvent.click(staleConfirm)
    expect(fixture.igDisconnect).not.toHaveBeenCalled()
  })
})

describe('Google のカード', () => {
  it('認可後の戻り先で指定されたLINEアカウントの接続状態を読む', async () => {
    fixture.search.value = 'google=connected&account_id=acc-2'
    fixture.account.accounts = [{ id: 'acc-1' }, { id: 'acc-2' }]
    fixture.googleConnection.mockResolvedValue({ ...googleData(), connection: { status: 'connected', locationTitle: '新宿店' } })
    fixture.igConnection.mockResolvedValue({ success: true, data: status('disconnected') })
    render(<SnsSettingsPage />)
    expect(await screen.findByText('新宿店')).toBeTruthy()
    expect(fixture.googleConnection).toHaveBeenCalledWith('acc-2')
    expect(fixture.selectAccount).toHaveBeenCalledWith('acc-2')
  })

  it('LINEアカウントを切り替えた直後に前のアカウントの接続操作を出さない', async () => {
    fixture.googleConnection.mockResolvedValueOnce({ ...googleData(), connection: { status: 'connected', locationTitle: '旧店舗' } })
      .mockImplementationOnce(() => new Promise(() => {}))
    fixture.igConnection.mockResolvedValue({ success: true, data: status('disconnected') })
    const view = render(<SnsSettingsPage />)
    expect(await screen.findByRole('button', { name: 'つなぎ直す' })).toBeTruthy()
    fixture.account.selected = 'acc-2'
    view.rerender(<SnsSettingsPage />)
    expect(screen.queryByRole('button', { name: 'つなぎ直す' })).toBeNull()
    expect(screen.queryByText('旧店舗')).toBeNull()
  })

  it('未接続ならSNS連携内に接続ボタンを表示し、接続開始APIを呼ぶ', async () => {
    fixture.googleConnectStart.mockRejectedValueOnce(new Error('offline'))
    setup('disconnected')
    const card = within(await screen.findByRole('region', { name: 'Google ビジネス' }))
    expect(card.getAllByText('未接続')).toHaveLength(1)
    fireEvent.click(await card.findByRole('button', { name: '接続する' }))
    await waitFor(() => expect(fixture.googleConnectStart).toHaveBeenCalledWith('acc-1'))
    expect(await card.findByText('Googleの認可画面を開けませんでした。')).toBeTruthy()
    expect(card.queryByRole('link', { name: /接続の設定へ/ })).toBeNull()
  })

  it('接続済みならSNS連携内に再接続と解除を表示する', async () => {
    fixture.googleConnection.mockResolvedValue({ ...googleData(), connection: { status: 'connected', locationTitle: '然カフェ 本店' } })
    fixture.igConnection.mockResolvedValue({ success: true, data: status('disconnected') })
    render(<SnsSettingsPage />)

    const card = within(await screen.findByRole('region', { name: 'Google ビジネス' }))
    expect(await card.findByText('接続済み')).toBeTruthy()
    expect(card.getByRole('button', { name: 'つなぎ直す' })).toBeTruthy()
    fireEvent.click(card.getByRole('button', { name: '接続を解除する' }))
    expect(await screen.findByText('Googleアカウントの接続を解除しますか？')).toBeTruthy()
    expect(fixture.googleDisconnect).not.toHaveBeenCalled()
  })

  it('店舗の選択待ちなら候補を選んで接続できる', async () => {
    fixture.googleSelectLocation.mockResolvedValueOnce({ success: true })
    fixture.googleConnection.mockResolvedValue({ ...googleData(), connection: { status: 'pending_location', locationTitle: null }, candidates: [{ locationName: 'accounts/1/locations/2', locationTitle: '渋谷店', addressText: '東京都' }] })
    fixture.igConnection.mockResolvedValue({ success: true, data: status('disconnected') })
    render(<SnsSettingsPage />)
    const card = within(await screen.findByRole('region', { name: 'Google ビジネス' }))
    fireEvent.click(await card.findByText('渋谷店'))
    fireEvent.click(card.getByRole('button', { name: 'この店舗を接続する' }))
    await waitFor(() => expect(fixture.googleSelectLocation).toHaveBeenCalledWith('acc-1', 'accounts/1/locations/2', false, undefined))
  })
})

describe('Instagram の返事の形が違うとき', () => {
  it('成功でも状態が無ければ読み込み中のまま止めず、失敗の表示を出す', async () => {
    fixture.googleConnection.mockResolvedValue(googleData())
    fixture.igConnection.mockResolvedValue({ success: true, data: {} })
    render(<SnsSettingsPage />)

    await waitFor(() => expect(igCard().queryByRole('button', { name: /もう一度/ })).toBeTruthy())
  })
})

describe('Instagram のログインから戻ったときの帯', () => {
  it('うまくいったことを知らせ、閉じると印を消す', async () => {
    fixture.search.value = 'instagram=connected'
    setup('connected', CONNECTED)

    expect(await screen.findByText('Instagram とつながりました。Googleビジネスの投稿を Instagram にも出せます。')).toBeTruthy()
  })

  it('失敗したときはビジネスアカウントでのログインを促す', async () => {
    fixture.search.value = 'instagram=failed'
    setup('disconnected')

    expect(await screen.findByText('Instagram とつなげませんでした。ビジネスアカウント（またはクリエイターアカウント）でログインして、もう一度お試しください。')).toBeTruthy()
  })

  it('別の統括で使用中なら管理者への確認を案内する', async () => {
    fixture.search.value = 'instagram=failed&instagram_code=instagram_account_other_organization'
    setup('disconnected')

    expect(await screen.findByText('このInstagramは別の統括で使用されています。統括の管理者に確認してください。')).toBeTruthy()
  })

  // その他の診断情報は画面に出さず、通常の失敗案内を保つ。
  it('原因調べの手がかりがURLに付いていても帯の文言は変わらない', async () => {
    fixture.search.value = 'instagram=failed&instagram_code=instagram_business_account_required&instagram_detail=GET+v21.0%2Fme%2Faccounts+status%3D400&instagram_scopes=pages_show_list&instagram_pages=1%2F0%2F1'
    setup('disconnected')

    expect(await screen.findByText('Instagram とつなげませんでした。ビジネスアカウント（またはクリエイターアカウント）でログインして、もう一度お試しください。')).toBeTruthy()
    expect(screen.queryByText(/instagram_business_account_required/)).toBeNull()
    expect(screen.queryByText(/status=400/)).toBeNull()
  })
})

afterEach(() => { verifiedStaffRole(null) })
