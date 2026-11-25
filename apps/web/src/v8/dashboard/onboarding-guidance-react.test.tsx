// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'

const net = vi.hoisted(() => ({
  routes: vi.fn(), progress: vi.fn(), style: vi.fn(), warnings: vi.fn(), items: vi.fn(), features: vi.fn(),
  save: vi.fn(), activate: vi.fn(), starterSet: vi.fn(),
  role: 'owner' as string | null, search: '', replace: vi.fn(), push: vi.fn(), googleHoursComplete: false,
}))
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(net.search), usePathname: () => '/', useRouter: () => ({ replace: net.replace, push: net.push }) }))
vi.mock('@/components/shared/list-navigation', async original => ({ ...await original<typeof import('@/components/shared/list-navigation')>(), useListNavigationRouter: () => ({ replace: net.replace, push: net.push }) }))
vi.mock('@/v8/onboarding/public/style-setup-progress/index', () => ({ useStyleSetupProgress: (_account: string | null, style: import('@line-crm/shared').AccountStyle | null) => ({ progress: style ? { style, steps: net.googleHoursComplete ? { hours: { complete: true } } : {} } : undefined, reload: vi.fn() }) }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ refreshAccounts: vi.fn(), selectedAccountId: 'A', selectedAccount: { channelId: 'channel-A', displayName: 'A' }, loading: false }) }))
vi.mock('@/lib/staff-role', async original => ({ ...await original<typeof import('@/lib/staff-role')>(), useStaffRole: () => net.role, useStaffIdentity: () => null }))
vi.mock('@/lib/api', async original => {
  const actual = await original<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api,
    entryRoutes: { ...actual.api.entryRoutes, list: net.routes },
    gettingStarted: { ...actual.api.gettingStarted, get: net.progress },
    featureSettings: { ...actual.api.featureSettings, get: net.features },
    dashboard: { ...actual.api.dashboard, comparisons: vi.fn().mockResolvedValue({ success: false, error: 'not requested' }) },
  } }
})
vi.mock('@/lib/api/helpers/styles', async original => {
  const actual = await original<typeof import('@/lib/api/helpers/styles')>()
  return { ...actual, styleApi: { ...actual.styleApi, get: net.style, warnings: net.warnings, starterItems: net.items,
    save: net.save, activate: net.activate, starterSet: net.starterSet,
  } }
})
vi.mock('./use-dashboard', async original => ({
  ...await original<typeof import('./use-dashboard')>(),
  useDashboard: () => ({
    bodyRef: { current: null }, supplementGate: false, selectedAccountId: 'A', selectedAccount: null,
    period: 'today', selectPeriod: vi.fn(), editorOpen: false, openEditor: vi.fn(), closeEditor: vi.fn(),
    data: null, displayedPeriod: 'today', periodNotice: '', loading: false, error: '', load: vi.fn(),
    preferences: { main: [], right: [] }, preferenceVersion: 0, preferenceSaving: false, preferenceSaveError: null,
    visibleToday: [], visibleRight: [], handleShipmentSummary: vi.fn(), handleInboxSummary: vi.fn(), shipmentSummary: null, shipmentState: 'ready',
    pendingPhotos: 0, pendingPhotosState: 'ready', bookings: [], bookingsFailed: false, todayActiveBookings: null,
    displayedBookings: [], todayBookings: [], upcomingBookings: [], supplementLoading: false, supplementLoadedAt: null,
    healthFailed: false, healthIssueCount: 0, displayedHealthRisk: 'normal', displayedTwoFactor: null, supportMarkAutoOnInbound: null,
    sectionAvailable: () => true, activeFriends: 0, lineUnread: 0, mailUnread: 0, pendingTotal: 0, pendingDetailState: 'ready',
    pendingOldest: null, notifications: [], notificationFailed: false, staffName: null, today: '2026-10-28', reference: null,
  }),
}))

vi.mock('@/components/dashboard/qr-dialog', () => ({ default: ({ open }: { open: boolean }) => open ? <div role="dialog" aria-label="友だち追加のQRコード" /> : null }))

import DashboardV8 from './dashboard'
import { firstRunPopupDismissedKey } from './first-run-popup'
import { setTestReducedMotion } from '@/test-utils/reduced-motion'

const ok = (data: unknown) => ({ success: true, data })
const keys = ['accounts', 'featureSet', 'attributes', 'friendAdd', 'scenario', 'firstMessage']
const basic = (done = false) => ok({ steps: keys.map(key => ({ key, state: done || key !== 'firstMessage' ? 'done' : 'todo', href: '/settings/getting-started', reason: null })), firstRun: null, starter: null })
const style = (deferred = true) => ok({ style: 'standard', styleSelected: true, styleMode: 'configured', version: 7, answers: deferred ? { image: { mode: 'later' } } : {} })
const guide = () => screen.getByRole('region', { name: 'はじめにやること' })
const retry = (title: string) => within(screen.getByText(title).closest('[data-list-state="error"]') as HTMLElement).getByRole('button', { name: 'もう一度読み込む', exact: true })
/*
  カードには「使い方の設定を開く」入口と「選んだ機能の設定」ブロックを置かない。
  そのため取得が終わったことは、画面上の入口ではなく呼び出しの落ち着きで見る。
*/
async function pendingSetup() {
  await waitFor(() => { expect(net.style).toHaveBeenCalled(); expect(net.warnings).toHaveBeenCalled(); expect(net.items).toHaveBeenCalled() })
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
  return true
}

beforeAll(async () => { await import('@/v8/onboarding/wizard') })

beforeEach(() => {
  vi.clearAllMocks()
  net.role = 'owner'; net.search = ''; net.googleHoursComplete = false
  net.routes.mockReset().mockResolvedValue(ok([]))
  window.localStorage.clear(); window.sessionStorage.clear(); window.history.replaceState(null, '', '/')
  /*
    ここは案内の読み込み失敗の見え方を見張る所。初回ポップアップ（枠02）は
    別のテストで見ているので、一度閉じた人として出さない（dialog の数え方を濁さないため）。
  */
  window.localStorage.setItem(firstRunPopupDismissedKey('A'), '1')
  setTestReducedMotion(true)
  net.progress.mockReset().mockResolvedValue(basic())
  net.style.mockReset().mockResolvedValue(style())
  net.warnings.mockReset().mockResolvedValue(ok({ items: [] }))
  net.items.mockReset().mockResolvedValue(ok({ items: [] }))
  net.features.mockReset().mockResolvedValue(ok({ version: 0, features: {} }))
  net.starterSet.mockReset().mockResolvedValue(ok({ definition: { items: [] }, preview: [] }))
  net.save.mockReset().mockResolvedValue(ok({ version: 8 }))
  net.activate.mockReset().mockResolvedValue(ok({}))
})
afterEach(() => { cleanup(); window.localStorage.clear(); window.sessionStorage.clear() })

it('使い方の確認中も基本の案内は使え、本文は並行して読みながら表示を待つ', async () => {
  let resolve!: (value: unknown) => void
  net.style.mockImplementationOnce(() => new Promise(value => { resolve = value }))
  render(<DashboardV8 />)
  expect(await screen.findByRole('progressbar', { name: 'はじめにやることの進み' })).toBeTruthy()
  expect(document.querySelector('[data-design="TodayTasks"]')?.closest('[inert][aria-hidden="true"]')).toBeTruthy()
  await act(async () => { resolve(style()) })
  expect(await pendingSetup()).toBeTruthy()
  expect(document.querySelector('[data-design="TodayTasks"]')?.closest('[inert]')).toBeNull()
})

it.each([
  ['lh:v8:first-steps-folded:A', true],
  ['lh:v8:first-steps-dismissed:A', true],
  ['lh:v8:first-steps-folded:A', false],
  ['lh:v8:first-steps-dismissed:A', false],
] as const)('保存済みの畳む状態（%s・基本完了%s）でも頭の1行と進みを残す', async (key, complete) => {
  window.localStorage.setItem(key, '1')
  net.progress.mockResolvedValue(basic(complete))
  render(<DashboardV8 />)
  const basicProgress = await screen.findByRole('progressbar', { name: 'はじめにやることの進み' })
  /* 済みの「使う機能」は一覧から外れる（承認済み Pen v09）ので、基本は5段＋営業時間の6段になる。 */
  expect(basicProgress.getAttribute('aria-valuenow')).toBe(complete ? '5' : '4')
  expect(within(guide()).getByRole('button', { name: '開く', exact: true }).getAttribute('aria-expanded')).toBe('false')
  expect((document.getElementById('first-steps-list') as HTMLElement).hidden).toBe(true)
  await pendingSetup()
  expect(within(guide()).queryByRole('heading', { name: '選んだ機能の設定' })).toBeNull()
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(net.save).not.toHaveBeenCalled(); expect(net.activate).not.toHaveBeenCalled()
})

it('カードの進みは基本の段の1つだけにし、選んだ機能の設定と入口は置かない', async () => {
  net.progress.mockResolvedValue(basic(true))
  render(<DashboardV8 />)
  await pendingSetup()
  expect(within(guide()).getByText('5 / 6 済み')).toBeTruthy()
  expect(within(guide()).getAllByRole('progressbar')).toHaveLength(1)
  expect(within(guide()).queryByRole('progressbar', { name: '使い方の設定の進み' })).toBeNull()
  expect(guide().textContent).not.toMatch(/質問 \d|済み \d+件/)
  expect(within(guide()).queryByText('リッチメニューなどの見た目を決める')).toBeNull()
  expect(within(guide()).queryByRole('button', { name: '設定を確認する' })).toBeNull()
  expect(within(guide()).queryByRole('button', { name: '使い方の設定を開く' })).toBeNull()
})

it('基本GETだけ失敗しても独立した再試行を残す', async () => {
  net.progress.mockRejectedValueOnce(new Error('progress unavailable'))
  render(<DashboardV8 />)
  expect(await pendingSetup()).toBeTruthy()
  expect(screen.queryByRole('progressbar', { name: 'はじめにやることの進み' })).toBeNull()
  const styleReads = net.style.mock.calls.length
  fireEvent.click(retry('はじめの設定の状態を確認できませんでした'))
  await waitFor(() => expect(net.progress).toHaveBeenCalledTimes(2))
  expect(await screen.findByRole('progressbar', { name: 'はじめにやることの進み' })).toBeTruthy()
  expect(net.style).toHaveBeenCalledTimes(styleReads)
  expect(net.progress).toHaveBeenCalledWith('A', 'v8')
  expect(net.save).not.toHaveBeenCalled(); expect(net.activate).not.toHaveBeenCalled()
})

it('基本GETが保留でstepsが空でも、0/0を作らない', async () => {
  let resolve!: (value: unknown) => void
  net.progress.mockImplementationOnce(() => new Promise(value => { resolve = value }))
  render(<DashboardV8 />)
  expect(await pendingSetup()).toBeTruthy()
  expect(document.querySelector('[data-design="TodayTasks"]')?.closest('[inert][aria-hidden="true"]')).toBeTruthy()
  expect(screen.queryByRole('progressbar', { name: 'はじめにやることの進み' })).toBeNull()
  expect(screen.queryByRole('progressbar', { name: '使い方の設定の進み' })).toBeNull()
  expect(screen.queryByRole('heading', { name: '選んだ機能の設定' })).toBeNull()
  expect(guide().textContent).not.toContain('0 / 0')
  await act(async () => { resolve(basic()) })
  expect(await screen.findByRole('progressbar', { name: 'はじめにやることの進み' })).toBeTruthy()
  expect(document.querySelector('[data-design="TodayTasks"]')).toBeTruthy()
  expect(document.querySelector('[data-design="TodayTasks"]')?.closest('[inert]')).toBeNull()
  expect(net.progress).toHaveBeenCalledTimes(1)
})

it.each(['style', 'warnings', 'items'] as const)('%s GETだけ失敗しても既知の基本手順と該当再試行を残し、未知の設定を開かない', async endpoint => {
  net[endpoint].mockRejectedValueOnce(new Error('setup unavailable'))
  render(<DashboardV8 />)
  expect(await screen.findByRole('progressbar', { name: 'はじめにやることの進み' })).toBeTruthy()
  await screen.findByText('使い方の設定を確認できませんでした')
  expect(screen.queryByRole('button', { name: '使い方の設定を開く', exact: true })).toBeNull()
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.click(retry('使い方の設定を確認できませんでした'))
  await waitFor(() => { expect(net.style).toHaveBeenCalledTimes(2); expect(net.warnings).toHaveBeenCalledTimes(2); expect(net.items).toHaveBeenCalledTimes(2) })
  expect(net.progress).toHaveBeenCalledTimes(1)
  expect(net.save).not.toHaveBeenCalled()
})

it('両GETが失敗したときは各再試行が対応する取得だけをやり直す', async () => {
  net.progress.mockRejectedValueOnce(new Error('progress unavailable'))
  net.style.mockRejectedValueOnce(new Error('setup unavailable'))
  render(<DashboardV8 />)
  await screen.findByText('はじめの設定の状態を確認できませんでした')
  await screen.findByText('使い方の設定を確認できませんでした')
  expect(screen.queryByRole('progressbar')).toBeNull()
  fireEvent.click(retry('はじめの設定の状態を確認できませんでした'))
  await screen.findByRole('progressbar', { name: 'はじめにやることの進み' })
  expect(net.progress).toHaveBeenCalledTimes(2); expect(net.style).toHaveBeenCalledTimes(1)
  fireEvent.click(retry('使い方の設定を確認できませんでした'))
  await waitFor(() => { expect(net.progress).toHaveBeenCalledTimes(2); expect(net.style).toHaveBeenCalledTimes(2) })
})

it('基本の段の進みだけを示し、畳む・開くで一覧だけが切り替わる', async () => {
  net.progress.mockResolvedValue(basic(true))
  render(<DashboardV8 />)
  await pendingSetup()
  expect(screen.getAllByRole('progressbar')).toHaveLength(1)
  expect(within(guide()).getByText('5 / 6 済み')).toBeTruthy()
  fireEvent.click(within(guide()).getByRole('button', { name: '畳む', exact: true }))
  expect((document.getElementById('first-steps-list') as HTMLElement).hidden).toBe(true)
  fireEvent.click(within(guide()).getByRole('button', { name: '開く', exact: true }))
  expect((document.getElementById('first-steps-list') as HTMLElement).hidden).toBe(false)
  expect(window.localStorage.getItem('lh:v8:first-steps-folded:A')).toBe('0')
})

it('基本が全完了で後回しの設定行が無ければカードを隠す', async () => {
  net.googleHoursComplete = true
  net.progress.mockResolvedValue(basic(true)); net.style.mockResolvedValue(style(false))
  render(<DashboardV8 />)
  await waitFor(() => { expect(net.progress).toHaveBeenCalledTimes(1); expect(net.style).toHaveBeenCalledTimes(1) })
  await act(async () => { await Promise.resolve() })
  expect(screen.queryByRole('heading', { name: 'はじめにやること', exact: true })).toBeNull()
  expect(screen.queryByRole('progressbar', { name: 'はじめにやることの進み' })).toBeNull()
})

it.each(['viewer', 'staff', null])('役割%sは許可された状態だけ読み、使い方の変更を許可しない', async role => {
  net.role = role
  render(<DashboardV8 />)
  await act(async () => { await Promise.resolve() })
  if (role === null) {
    expect(screen.queryByRole('heading', { name: 'はじめにやること', exact: true })).toBeNull()
    expect(net.progress).not.toHaveBeenCalled()
  } else {
    expect(await screen.findByRole('heading', { name: 'はじめにやること', exact: true })).toBeTruthy()
    expect(net.progress).toHaveBeenCalledTimes(1)
    if (role === 'viewer') expect(within(guide()).queryAllByRole('link')).toHaveLength(0)
    /* 使い方の設定の入口はカードに置かない。役割にかかわらず出ない。 */
    expect(screen.queryByRole('button', { name: '使い方の設定を開く', exact: true })).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
  }
  if (role === null) {
    expect(screen.queryByRole('button', { name: '使い方の設定を開く', exact: true })).toBeNull()
    expect(net.style).not.toHaveBeenCalled()
    expect(net.warnings).not.toHaveBeenCalled(); expect(net.items).not.toHaveBeenCalled()
  } else {
    await waitFor(() => { expect(net.style).toHaveBeenCalledWith('A') })
    expect(net.warnings).toHaveBeenCalledWith('A'); expect(net.items).toHaveBeenCalledWith('A')
    expect(screen.queryByRole('heading', { name: '選んだ機能の設定' })).toBeNull()
    if (role === 'viewer') {
      /* 閲覧のみは行の入口も灰色の「開く」になる。 */
      const locked = within(guide()).getAllByRole('button', { name: '開く' })
      expect(locked.length).toBeGreaterThan(0)
      for (const button of locked) expect(button.getAttribute('aria-disabled')).toBe('true')
      fireEvent.click(locked[0])
    }
    expect(screen.queryByRole('dialog')).toBeNull()
  }
  expect(net.save).not.toHaveBeenCalled()
})

it('APIの空stepsは正規化された未確認を表示し、全完了や0/0としない', async () => {
  net.progress.mockResolvedValue(ok({ steps: [], firstRun: null, starter: null }))
  render(<DashboardV8 />)
  await pendingSetup()
  await screen.findByRole('progressbar', { name: 'はじめにやることの進み' })
  expect(guide().textContent).not.toContain('0 / 0')
  expect(within(guide()).getAllByText('未確認').length).toBeGreaterThan(0)
  expect(net.features).toHaveBeenCalledWith('A')
})

/* カードに使い方の設定の入口を置かないので、カードから勝手に質問が開かず保存も始めない。 */
it('カードからは質問が開かず、保存も始めない', async () => {
  render(<DashboardV8 />)
  expect(await pendingSetup()).toBeTruthy()
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(net.save).not.toHaveBeenCalled(); expect(net.activate).not.toHaveBeenCalled()
})


it('既知の業種を設定取得の失敗で標準へ戻さず、実物が未知の段は済みにしない', async () => {
  net.style.mockRejectedValue(new Error('setup unavailable'))
  render(<DashboardV8 accountStyle="ec" />)
  const progress = await screen.findByRole('progressbar', { name: 'はじめにやることの進み' })
  /* 済みの「使う機能」は一覧から外れるので、済みは①接続だけ。 */
  expect(progress.getAttribute('aria-valuenow')).toBe('1')
  const card = guide()
  expect(within(card).getByText('ストアをつなぐ')).toBeTruthy()
  expect(within(card).getByText('ストアの商品を確認する')).toBeTruthy()
  expect(within(card).getAllByText('（未確認）')).toHaveLength(4)
  expect(within(card).getAllByRole('button', { name: /の未確認の理由$/ })).toHaveLength(4)
  expect(within(card).queryByText('友だちの分け方を決める')).toBeNull()
  expect(screen.queryByRole('button', { name: '使い方の設定を開く', exact: true })).toBeNull()
})

it.each(['standard', 'ec'] as const)('%sは友だち追加のカードを隠していても共通のQRを1つだけ開く', async usageStyle => {
  net.search = 'qr=base'
  render(<DashboardV8 usageStyle={usageStyle} />)
  expect(await screen.findAllByRole('dialog', { name: '友だち追加のQRコード' })).toHaveLength(1)
  expect(net.routes).toHaveBeenCalledWith('A')
  expect(screen.queryByRole('dialog', { name: '使い方のスタイルを選ぶ' })).toBeNull()
  expect(net.save).not.toHaveBeenCalled()
})

it('標準の案内、集計期間、数の帯はこの順に並ぶ', async () => {
  const view = render(<DashboardV8 />)
  const card = (await screen.findByRole('heading', { name: 'はじめにやること', exact: true })).closest('section')!
  const controls = screen.getByLabelText('集計期間')
  const band = view.container.querySelector('[data-design="TodayTasks"]')!
  expect(card.compareDocumentPosition(controls) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(controls.compareDocumentPosition(band) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
})
