// @vitest-environment happy-dom
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
/*
 * 設定 › SNS 連携の画面（★`設定SNS連携_複数接続_第1段_v7.pen` F1〜F8／2026-11-16 利用者承認）。
 * 守るのは BEHAVIOR.md に書いた決めごと：
 *  - 段の頭に「連携 n個（契約枠 m個）」と［接続を追加する］を出す（接続が無いときは状態の札）。
 *  - 接続は一覧の行で出し、つなぎ直す・解除するは行の操作（`RowMenu`）の中。
 *  - 未接続は公式ロゴつきの［Google／Instagram アカウントを接続する］。ページを選ぶ段は出さない。
 *  - 「設定がありません」は注記だけ。押せないボタンは置かない。
 *  - 閲覧のみは操作を消さず、押せない状態にして理由を添える（F8・AGENTS.md §15）。
 *  - 解除は F6 の確認の小窓をはさみ、いまの版の番号を渡す。
 *  - 戻り先 `?instagram=connected|failed` の帯。
 */
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { InstagramConnectionStatus, SnsConnectionPorts } from '@line-crm/shared'
import type { GoogleConnectionData } from '@/lib/restaurant-google-api'
import SnsSettingsPage from './sns'

/** 閲覧のみに添える理由（sns.tsx の LOCKED_REASON と同じ文）。 */
const LOCKED_REASON = 'オーナーか管理者だけが接続を変更できます'
/** 閲覧のみの帯（この画面だけの言い回し）。 */
const READ_ONLY_NOTICE = '閲覧のみの権限です。接続の追加・解除・主連携の変更はオーナーか管理者だけができます。'

const fixture = vi.hoisted(() => {
  /** `@/lib/api` の ApiError と同じ形。画面は `status === 409` で版の競合を見分ける。 */
  class MockApiError extends Error {
    status: number
    constructor(status: number, message = '') {
      super(message)
      this.status = status
    }
  }
  return {
    googleConnection: vi.fn(),
    googleConnectStart: vi.fn(),
    googleSelectLocation: vi.fn(),
    googleDisconnect: vi.fn(),
    igConnection: vi.fn(),
    igStart: vi.fn(),
    igDisconnect: vi.fn(),
    igRefresh: vi.fn(),
    snsPorts: vi.fn(),
    snsSetPrimary: vi.fn(),
    ApiError: MockApiError,
    replace: vi.fn(),
    role: { value: 'owner' as string | null },
    style: { value: 'restaurant' as string },
    search: { value: '' },
    account: { selected: 'acc-1', accounts: [] as Array<{ id: string; name?: string }> },
    selectAccount: vi.fn(),
  }
})

vi.mock('@/lib/restaurant-google-api', () => ({
  restaurantGoogleApi: { connection: fixture.googleConnection, connectStart: fixture.googleConnectStart, selectLocation: fixture.googleSelectLocation, disconnect: fixture.googleDisconnect },
}))

vi.mock('@/lib/api', () => ({
  api: {
    instagram: {
      connection: fixture.igConnection,
      start: fixture.igStart,
      disconnect: fixture.igDisconnect,
      refresh: fixture.igRefresh,
    },
    snsConnections: {
      get: fixture.snsPorts,
      setGooglePrimary: fixture.snsSetPrimary,
    },
  },
  ApiError: fixture.ApiError,
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: fixture.replace }),
  usePathname: () => '/settings/sns',
  useSearchParams: () => new URLSearchParams(fixture.search.value),
}))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: fixture.account.selected, accounts: fixture.account.accounts, setSelectedAccountId: fixture.selectAccount }),
}))
vi.mock('@/hooks/use-account-style', () => ({
  useAccountStyle: () => ({ status: 'ready', data: { style: fixture.style.value } }),
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

/**
 * 契約枠・主連携・請求の段（`GET /api/settings/sns/connections`）の返事。
 * 契約枠は両サービス共通の1つの数。金額は画面で数え直さないので、ここでも増分は入れない。
 */
function portsData(overrides: Partial<SnsConnectionPorts> = {}): { success: true; data: SnsConnectionPorts } {
  return {
    success: true,
    data: {
      lineAccountId: 'acc-1',
      contracted: 1,
      counts: { googleBusiness: 0, instagram: 0 },
      linkedSlots: 0,
      billing: null,
      googleConnections: [],
      primaryVersion: 1,
      ...overrides,
    },
  }
}

beforeEach(() => {
  /* 既定は「契約枠の記録が無い LINEアカウント」（404）。口が入る前と同じ表示になることを保つ。 */
  fixture.snsPorts.mockRejectedValue(new fixture.ApiError(404, 'not_found'))
})

function setup(state: InstagramConnectionStatus['state'], connection?: InstagramConnectionStatus['connection']) {
  fixture.googleConnection.mockResolvedValue(googleData())
  fixture.igConnection.mockResolvedValue({ success: true, data: status(state, connection) })
  render(<SnsSettingsPage />)
}

/* Googleのカードにも同じことば（「未接続」など）が出るので、カードの中だけを見る。 */
function igCard() {
  return within(screen.getByRole('region', { name: 'Instagram' }))
}

function googleCard() {
  return within(screen.getByRole('region', { name: 'Google ビジネス' }))
}

/* つなぎ直す・解除するは行の操作（「<接続の名前>の操作」）の中。 */
async function openIgMenu() {
  fireEvent.click(await igCard().findByRole('button', { name: '@nen_cafeの操作' }))
}

afterEach(() => {
  cleanup()
  fixture.role.value = 'owner'
  fixture.style.value = 'restaurant'
  fixture.search.value = ''
  fixture.account.selected = 'acc-1'
  fixture.account.accounts = []
  vi.resetAllMocks()
})

describe('Instagram のカード（★v7 F1・F2・F7・F8）', () => {
  it('未接続では公式ロゴつきの接続ボタンと注記を出し、ページを選ぶ段は出さない', async () => {
    setup('disconnected')

    expect(await igCard().findByText('未接続')).toBeTruthy()
    expect(igCard().getByText('つなぐとできること')).toBeTruthy()
    expect(screen.getByText('Instagram のビジネスアカウント（またはクリエイターアカウント）でログインしてください。個人のアカウントは接続できません。')).toBeTruthy()
    expect(igCard().getByRole('button', { name: 'Instagram アカウントを接続する' })).toBeTruthy()
    // ページを選ぶ段（利用者の決めで出さない）
    expect(screen.queryByText(/ページを選/)).toBeNull()
    // 接続が1件も無いので個数と［接続を追加する］は出さない（札だけ）。
    expect(igCard().queryByText(/^連携 /)).toBeNull()
    expect(igCard().queryByRole('button', { name: '接続を追加する' })).toBeNull()
  })

  it('接続済みでは一覧の行に名前と札を出し、個数と追加・行の操作を出す', async () => {
    setup('connected', CONNECTED)

    const card = () => igCard()
    expect(await card().findByText('接続済み')).toBeTruthy()
    expect(card().getByText('@nen_cafe')).toBeTruthy()
    expect(card().getByText(/^ビジネスアカウント・接続した日/)).toBeTruthy()
    expect(card().getByText('連携 1個（契約枠 1個）')).toBeTruthy()
    expect(card().getAllByRole('button', { name: '接続を追加する' }).length).toBeGreaterThan(0)
    expect(card().getByText('できること')).toBeTruthy()
    // 接続済みでもログインの但し書きは残す（v7 F1）。
    expect(card().getByText(/個人のアカウントは接続できません/)).toBeTruthy()
    // 前からある［接続を確かめる］は残す（理由は BEHAVIOR.md）。
    expect(card().getByRole('button', { name: '接続を確かめる' })).toBeTruthy()

    await openIgMenu()
    expect(screen.getAllByRole('menuitem', { name: 'つなぎ直す' }).length).toBeGreaterThan(0)
    expect(screen.getAllByRole('menuitem', { name: '解除する' }).length).toBeGreaterThan(0)
    // 主連携は Google 接続だけの考え方なので、Instagram には出さない（要件 §4-3）。
    expect(screen.queryByRole('menuitem', { name: '主連携にする' })).toBeNull()
    expect(screen.queryByRole('button', { name: '主連携にする' })).toBeNull()
  })

  it('［接続を確かめる］は認可をやり直さず、いまの接続をサーバーに確かめ直す', async () => {
    fixture.igRefresh.mockResolvedValue({ success: true })
    setup('connected', CONNECTED)

    fireEvent.click(await igCard().findByRole('button', { name: '接続を確かめる' }))

    await waitFor(() => expect(fixture.igRefresh).toHaveBeenCalledWith('acc-1'))
    // 認可画面には行かない（つなぎ直しとは別の操作）。
    expect(fixture.igStart).not.toHaveBeenCalled()
    // 確かめ終わったら状態を読み直す。
    await waitFor(() => expect(fixture.igConnection.mock.calls.length).toBeGreaterThan(1))
  })

  it('確かめられなかったときは画面に理由を出す', async () => {
    fixture.igRefresh.mockRejectedValue(new Error('network'))
    setup('connected', CONNECTED)

    fireEvent.click(await igCard().findByRole('button', { name: '接続を確かめる' }))

    expect(await screen.findByText('接続を確かめられませんでした。もう一度お試しください。')).toBeTruthy()
  })

  it('認可が切れているときも行として出し、行の中の［つなぎ直す］でつなぎ直せる', async () => {
    setup('expired', CONNECTED)

    expect((await screen.findAllByText('接続の異常')).length).toBeGreaterThan(0)
    // 直せる状態の行は絵（v7 F1）のとおり行の中に［つなぎ直す］を出す。
    expect(screen.getAllByRole('button', { name: 'つなぎ直す' }).length).toBeGreaterThan(0)
    await openIgMenu()
    // 同じ操作は「⋯」に重ねない。残るのは解除だけ。
    expect(screen.queryByRole('menuitem', { name: 'つなぎ直す' })).toBeNull()
    expect(screen.getAllByRole('menuitem', { name: '解除する' }).length).toBeGreaterThan(0)
  })

  it('「設定がありません」のときは注記だけで、押せるボタンを置かない', async () => {
    setup('unconfigured')

    expect((await screen.findAllByText('未設定')).length).toBeGreaterThan(0)
    expect(screen.getByText('この環境には Instagram 接続の設定がありません。')).toBeTruthy()
    expect(igCard().queryByRole('button', { name: 'Instagram アカウントを接続する' })).toBeNull()
    expect(igCard().queryByRole('button', { name: '接続を追加する' })).toBeNull()
  })

  it('閲覧のみには帯を出し、操作は消さずに押せない状態で置く（F8）', async () => {
    fixture.role.value = verifiedStaffRole('staff')
    setup('connected', CONNECTED)

    expect(await screen.findByText(READ_ONLY_NOTICE)).toBeTruthy()
    expect(await screen.findByText('接続済み')).toBeTruthy()

    const add = igCard().getAllByRole('button', { name: '接続を追加する' })
    expect(add.length).toBeGreaterThan(0)
    expect(add[0].getAttribute('aria-disabled')).toBe('true')
    expect(igCard().getAllByText(LOCKED_REASON).length).toBeGreaterThan(0)

    // ［接続を確かめる］も消さず、押せない状態にして理由を添える。
    const check = igCard().getByRole('button', { name: '接続を確かめる' })
    expect(check.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(check)
    expect(fixture.igRefresh).not.toHaveBeenCalled()

    // 行の操作も残すが、押しても開かない。
    const menu = igCard().getByRole('button', { name: '@nen_cafeの操作' })
    expect(menu.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(menu)
    expect(screen.queryByRole('menuitem')).toBeNull()
  })

  it.each(['disconnected', 'expired'] as const)('%s の閲覧のみも操作を押せない状態で置き、口を呼ばない', async (state) => {
    fixture.role.value = verifiedStaffRole('staff')
    setup(state, state === 'expired' ? CONNECTED : undefined)

    await screen.findByText(READ_ONLY_NOTICE)
    if (state === 'expired') {
      const menu = await igCard().findByRole('button', { name: '@nen_cafeの操作' })
      expect(menu.getAttribute('aria-disabled')).toBe('true')
    } else {
      const connect = await igCard().findByRole('button', { name: 'Instagram アカウントを接続する' })
      expect(connect.getAttribute('aria-disabled')).toBe('true')
      fireEvent.click(connect)
    }
    expect(igCard().getAllByText(LOCKED_REASON).length).toBeGreaterThan(0)
    expect(fixture.igStart).not.toHaveBeenCalled()
  })

  it('契約枠の中の追加は料金の確認をはさまず認可へ進み、処理中は操作を止める', async () => {
    let rejectStart!: (reason: Error) => void
    fixture.igStart.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectStart = reject }))
    setup('disconnected')

    const start = await igCard().findByRole('button', { name: 'Instagram アカウントを接続する' })
    fireEvent.click(start)
    // 料金の確認の小窓は出さない（契約枠の中・要件 §4-1）。
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(start.hasAttribute('disabled')).toBe(true)
    fireEvent.click(start)
    expect(fixture.igStart).toHaveBeenCalledTimes(1)
    expect(fixture.igStart).toHaveBeenCalledWith('acc-1')

    rejectStart(new Error('offline'))
    await screen.findByText('Instagram のログイン画面を開けませんでした。もう一度お試しください。')
    expect(start.hasAttribute('disabled')).toBe(false)
    expect(igCard().getByText(/個人のアカウントは接続できません/)).toBeTruthy()
    expect(fixture.igDisconnect).not.toHaveBeenCalled()
  })

  it('［解除する］は確認の小窓をはさみ、いまの版の番号を渡す', async () => {
    fixture.igDisconnect.mockResolvedValue({ success: true })
    setup('connected', CONNECTED)

    await openIgMenu()
    fireEvent.click(screen.getAllByRole('menuitem', { name: '解除する' })[0])
    const dialog = within(await screen.findByRole('dialog'))
    expect(dialog.getByText('Instagramの接続を解除しますか？')).toBeTruthy()
    fireEvent.click(dialog.getByRole('button', { name: '解除する' }))
    await waitFor(() => expect(fixture.igDisconnect).toHaveBeenCalledWith('acc-1', 3))
  })

  it('解除の小窓は対象と枠数の減りを示す（契約枠は変わらない）', async () => {
    fixture.account.accounts = [{ id: 'acc-1', name: '移行前の店' }, { id: 'acc-2', name: '移行先の店' }]
    fixture.igDisconnect.mockResolvedValue({ success: true })
    setup('connected', CONNECTED)

    await openIgMenu()
    fireEvent.click(screen.getAllByRole('menuitem', { name: '解除する' })[0])
    const dialog = within(await screen.findByRole('dialog'))
    expect(dialog.getByText('LINEアカウント')).toBeTruthy()
    expect(dialog.getByText('移行前の店')).toBeTruthy()
    expect(dialog.getByText('@nen_cafe（Instagram）')).toBeTruthy()
    expect(dialog.getByText('Instagramの連携数')).toBeTruthy()
    expect(dialog.getByText('1個 → 0個')).toBeTruthy()
    expect(dialog.getByText('契約枠')).toBeTruthy()
    expect(dialog.getByText('1個（変わりません）')).toBeTruthy()
    expect(dialog.getByText('有料の追加連携枠')).toBeTruthy()
    expect(dialog.getByText('0枠 → 0枠')).toBeTruthy()
    // 請求の段に次回の請求日は入っていないので、減額の箱は出さない（日付を画面で作らない）。
    expect(dialog.queryByText(/次回の月次請求から/)).toBeNull()
  })

  it('版が読めない接続は解除せず、読み込み直しを案内する', async () => {
    const { version: _version, ...noVersion } = CONNECTED
    setup('connected', noVersion as typeof CONNECTED)

    await openIgMenu()
    fireEvent.click(screen.getAllByRole('menuitem', { name: '解除する' })[0])
    const dialog = within(await screen.findByRole('dialog'))
    fireEvent.click(dialog.getByRole('button', { name: '解除する' }))
    expect(await screen.findByText('接続の版を読み取れませんでした。画面を読み込み直してからもう一度お試しください。')).toBeTruthy()
    expect(fixture.igDisconnect).not.toHaveBeenCalled()
  })

  it('［戻る］で閉じれば解除しない', async () => {
    fixture.igDisconnect.mockResolvedValue({ success: true })
    setup('connected', CONNECTED)
    await openIgMenu()
    fireEvent.click(screen.getAllByRole('menuitem', { name: '解除する' })[0])
    const dialog = within(await screen.findByRole('dialog'))
    fireEvent.click(dialog.getByRole('button', { name: '戻る' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(fixture.igDisconnect).not.toHaveBeenCalled()
  })

  it('LINEアカウントが変わると元の確認を実行できない', async () => {
    fixture.account.accounts = [{ id: 'acc-1', name: '移行前の店' }, { id: 'acc-2', name: '移行先の店' }]
    fixture.googleConnection.mockResolvedValue(googleData())
    fixture.igConnection.mockResolvedValue({ success: true, data: status('connected', CONNECTED) })
    const view = render(<SnsSettingsPage />)
    await openIgMenu()
    fireEvent.click(screen.getAllByRole('menuitem', { name: '解除する' })[0])
    const dialog = within(await screen.findByRole('dialog'))
    const staleConfirm = dialog.getByRole('button', { name: '解除する' })
    fixture.account.selected = 'acc-2'
    view.rerender(<SnsSettingsPage />)
    fireEvent.click(staleConfirm)
    expect(fixture.igDisconnect).not.toHaveBeenCalled()
    fixture.account.selected = 'acc-1'
    view.rerender(<SnsSettingsPage />)
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(staleConfirm)
    expect(fixture.igDisconnect).not.toHaveBeenCalled()
  })
})

describe('Google のカード（★v7 F1・F7）', () => {
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

  it('LINEアカウントを切り替えた直後に前のアカウントの接続を出さない', async () => {
    fixture.googleConnection.mockResolvedValueOnce({ ...googleData(), connection: { status: 'connected', locationTitle: '旧店舗' } })
      .mockImplementationOnce(() => new Promise(() => {}))
    fixture.igConnection.mockResolvedValue({ success: true, data: status('disconnected') })
    const view = render(<SnsSettingsPage />)
    expect(await screen.findByRole('button', { name: '旧店舗の操作' })).toBeTruthy()
    fixture.account.selected = 'acc-2'
    view.rerender(<SnsSettingsPage />)
    expect(screen.queryByRole('button', { name: '旧店舗の操作' })).toBeNull()
    expect(screen.queryByText('旧店舗')).toBeNull()
  })

  it('未接続なら公式ロゴつきの接続ボタンを出し、接続開始APIを呼ぶ', async () => {
    fixture.googleConnectStart.mockRejectedValueOnce(new Error('offline'))
    setup('disconnected')
    expect((await googleCard().findAllByText('未接続')).length).toBe(1)
    expect(googleCard().getByText(/11個目からは個別見積もりです/)).toBeTruthy()
    fireEvent.click(googleCard().getByRole('button', { name: 'Google アカウントを接続する' }))
    await waitFor(() => expect(fixture.googleConnectStart).toHaveBeenCalledWith('acc-1'))
    expect(await screen.findByText('Google の許可画面を開けませんでした。もう一度お試しください。')).toBeTruthy()
    // 口コミ・投稿・プロフィールへの移動は接続していないときは出さない。
    expect(googleCard().queryByRole('link', { name: '口コミへ' })).toBeNull()
    expect(googleCard().queryByRole('link', { name: '投稿へ' })).toBeNull()
    expect(googleCard().queryByRole('link', { name: 'プロフィールへ' })).toBeNull()
  })

  it('接続済みなら一覧の行と営業時間への移動を出し、行の操作から解除できる', async () => {
    fixture.googleDisconnect.mockResolvedValue({ success: true })
    fixture.googleConnection.mockResolvedValue({ ...googleData(), connection: { status: 'connected', locationName: 'locations/1', locationTitle: '然カフェ 本店' } })
    fixture.igConnection.mockResolvedValue({ success: true, data: status('disconnected') })
    render(<SnsSettingsPage />)

    expect(await googleCard().findByText('接続済み')).toBeTruthy()
    expect(googleCard().getByText('連携 1個（契約枠 1個）')).toBeTruthy()
    expect(screen.getByRole('link', { name: '営業時間へ' }).getAttribute('href')).toBe('/settings/google-hours')

    fireEvent.click(googleCard().getByRole('button', { name: '然カフェ 本店の操作' }))
    expect(screen.getAllByRole('menuitem', { name: 'つなぎ直す' }).length).toBeGreaterThan(0)
    fireEvent.click(screen.getAllByRole('menuitem', { name: '解除する' })[0])
    const dialog = within(await screen.findByRole('dialog'))
    expect(dialog.getByText('Google ビジネスの接続を解除しますか？')).toBeTruthy()
    expect(fixture.googleDisconnect).not.toHaveBeenCalled()
    fireEvent.click(dialog.getByRole('button', { name: '解除する' }))
    await waitFor(() => expect(fixture.googleDisconnect).toHaveBeenCalledWith('acc-1', undefined))
  })

  it('接続済みなら前からある口コミ・投稿の件数と、口コミ・投稿・プロフィールへの移動を残す', async () => {
    fixture.googleConnection.mockResolvedValue({
      ...googleData(),
      connection: { status: 'connected', locationName: 'locations/1', locationTitle: '然カフェ 本店' },
      summary: { unrepliedCount: 2, draftCount: 0, attentionCount: 0, newCount: 0, storedCount: 12, postsAttentionCount: 1, syncStale: false },
    })
    fixture.igConnection.mockResolvedValue({ success: true, data: status('disconnected') })
    render(<SnsSettingsPage />)

    expect(await googleCard().findByText('接続済み')).toBeTruthy()
    expect(googleCard().getByText('12件・未返信 2件')).toBeTruthy()
    expect(googleCard().getByText('要対応 1件')).toBeTruthy()
    expect(googleCard().getByRole('link', { name: '口コミへ' }).getAttribute('href')).toBe('/restaurant-test/google?tab=reviews')
    expect(googleCard().getByRole('link', { name: '投稿へ' }).getAttribute('href')).toBe('/restaurant-test/google?tab=posts')
    expect(googleCard().getByRole('link', { name: 'プロフィールへ' }).getAttribute('href')).toBe('/restaurant-test/google?tab=profile')
  })

  it('飲食店の作りでないLINEアカウントには口コミ・投稿の段を出さない', async () => {
    fixture.style.value = 'general'
    fixture.googleConnection.mockResolvedValue({
      ...googleData(),
      connection: { status: 'connected', locationName: 'locations/1', locationTitle: '然カフェ 本店' },
      summary: { unrepliedCount: 2, draftCount: 0, attentionCount: 0, newCount: 0, storedCount: 12, postsAttentionCount: 1, syncStale: false },
    })
    fixture.igConnection.mockResolvedValue({ success: true, data: status('disconnected') })
    render(<SnsSettingsPage />)

    expect(await googleCard().findByText('接続済み')).toBeTruthy()
    expect(googleCard().queryByRole('link', { name: '口コミへ' })).toBeNull()
    expect(googleCard().queryByText('12件・未返信 2件')).toBeNull()
    // 営業時間への移動は作りに関わらず残す。
    expect(googleCard().getByRole('link', { name: '営業時間へ' })).toBeTruthy()
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

describe('契約枠・主連携・請求の口（★v9 F3・F4／GET /api/settings/sns/connections）', () => {
  /** 接続済みのGoogle 1件（主連携の札を見るため id を揃える）。 */
  function connectedGoogle(id = 'conn-1') {
    return {
      ...googleData(),
      connection: { status: 'connected' as const, id, locationName: 'locations/1', locationTitle: '然カフェ 本店' },
    }
  }

  it('契約枠はサーバーの値を出す（画面で 1 を決め打ちしない）', async () => {
    fixture.snsPorts.mockResolvedValue(portsData({ contracted: 3, counts: { googleBusiness: 1, instagram: 1 } }))
    setup('connected', CONNECTED)

    expect(await igCard().findByText('連携 1個（契約枠 3個）')).toBeTruthy()
    expect(fixture.snsPorts).toHaveBeenCalledWith('acc-1')
  })

  it('口が取れないLINEアカウントでは今までの表示（契約枠1）へ戻す', async () => {
    fixture.snsPorts.mockRejectedValue(new fixture.ApiError(404, 'not_found'))
    setup('connected', CONNECTED)

    expect(await igCard().findByText('連携 1個（契約枠 1個）')).toBeTruthy()
    // 読めないことを画面の失敗として出さない（契約枠の記録が無いだけ）。
    expect(screen.queryByText(/連携の状態を読み取れませんでした/)).toBeNull()
  })

  it('請求の段が取れると、枠を超える追加で料金の確認をはさむ', async () => {
    fixture.snsPorts.mockResolvedValue(portsData({
      contracted: 1,
      counts: { googleBusiness: 0, instagram: 1 },
      billing: { kind: 'trialing' },
    }))
    setup('connected', CONNECTED)

    /* 広い画面と細い画面の両方に出るので先頭を押す（F2）。 */
    const add = await igCard().findAllByRole('button', { name: '接続を追加する' })
    expect(add[0].getAttribute('aria-disabled')).not.toBe('true')
    fireEvent.click(add[0])

    // 無料期間中（trialing）は F4。認可画面へは確認してから進む。
    const dialog = within(await screen.findByRole('dialog'))
    expect(dialog.getByText('追加料金はかかりません')).toBeTruthy()
    expect(fixture.igStart).not.toHaveBeenCalled()
  })

  it('請求の段が取れないときは枠を超える追加を押せない状態にして理由を添える', async () => {
    fixture.snsPorts.mockResolvedValue(portsData({
      contracted: 1,
      counts: { googleBusiness: 0, instagram: 1 },
      billing: null,
    }))
    setup('connected', CONNECTED)

    const add = await igCard().findAllByRole('button', { name: '接続を追加する' })
    expect(add[0].getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(add[0])
    // 金額を画面で作らないため、小窓も認可画面も開かない（AGENTS.md §15）。
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(fixture.igStart).not.toHaveBeenCalled()
    expect(igCard().getAllByText('追加の料金を確かめられないため、いまは枠を超える追加ができません。しばらくしてからもう一度お試しください。').length).toBeGreaterThan(0)
  })

  it('主連携の札はサーバーの isPrimary で出す', async () => {
    fixture.googleConnection.mockResolvedValue(connectedGoogle())
    fixture.igConnection.mockResolvedValue({ success: true, data: status('disconnected') })
    fixture.snsPorts.mockResolvedValue(portsData({
      counts: { googleBusiness: 1, instagram: 0 },
      googleConnections: [{ id: 'conn-1', label: '然カフェ 本店', state: 'connected', version: 2, isPrimary: true }],
      primaryVersion: 4,
    }))
    render(<SnsSettingsPage />)

    expect(await googleCard().findByText('接続済み')).toBeTruthy()
    expect(googleCard().getByText('主連携')).toBeTruthy()
  })

  it('サーバーが別の接続を主連携としているときは札を出さない（先頭を主連携と決め打ちしない）', async () => {
    fixture.googleConnection.mockResolvedValue(connectedGoogle('conn-1'))
    fixture.igConnection.mockResolvedValue({ success: true, data: status('disconnected') })
    fixture.snsPorts.mockResolvedValue(portsData({
      counts: { googleBusiness: 2, instagram: 0 },
      googleConnections: [
        { id: 'conn-2', label: '渋谷店', state: 'connected', version: 1, isPrimary: true },
        { id: 'conn-1', label: '然カフェ 本店', state: 'connected', version: 2, isPrimary: false },
      ],
      primaryVersion: 4,
    }))
    render(<SnsSettingsPage />)

    expect(await googleCard().findByText('接続済み')).toBeTruthy()
    expect(googleCard().queryByText('主連携')).toBeNull()
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

describe('契約枠・主連携・請求の口の返事の形が違うとき', () => {
  it('成功でも別の形の中身なら画面を止めず、既定（契約枠1）で出す', async () => {
    fixture.googleConnection.mockResolvedValue(googleData())
    fixture.igConnection.mockResolvedValue({ success: true, data: status('connected', CONNECTED) })
    /* 口を持たないサーバーが一覧の形で返す場合。主連携を探すところで画面を止めない。 */
    fixture.snsPorts.mockResolvedValue({ success: true, data: { items: [], total: 0, page: 1, limit: 20 } })
    render(<SnsSettingsPage />)

    expect(await igCard().findByText('連携 1個（契約枠 1個）')).toBeTruthy()
    expect(screen.queryByText(/連携の状態を読み取れませんでした/)).toBeNull()
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
