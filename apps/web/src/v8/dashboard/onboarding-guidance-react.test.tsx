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
import { setTestReducedMotion } from '@/test-utils/reduced-motion'

const ok = (data: unknown) => ({ success: true, data })
const keys = ['accounts', 'featureSet', 'attributes', 'friendAdd', 'scenario', 'firstMessage']
const basic = (done = false) => ok({ steps: keys.map(key => ({ key, state: done || key !== 'firstMessage' ? 'done' : 'todo', href: '/settings/getting-started', reason: null })), firstRun: null, starter: null })
const style = (deferred = true) => ok({ style: 'standard', styleSelected: true, styleMode: 'configured', version: 7, answers: deferred ? { image: { mode: 'later' } } : {} })
const guide = () => screen.getByRole('region', { name: 'はじめにやること' })
const retry = (title: string) => within(screen.getByText(title).closest('[data-list-state="error"]') as HTMLElement).getByRole('button', { name: 'もう一度読み込む', exact: true })
const pendingSetup = () => screen.findByRole('button', { name: '使い方の設定を開く', exact: true })

beforeAll(async () => { await import('@/v8/onboarding/wizard') })

beforeEach(() => {
  vi.clearAllMocks()
  net.role = 'owner'; net.search = ''; net.googleHoursComplete = false
  net.routes.mockReset().mockResolvedValue(ok([]))
  window.localStorage.clear(); window.sessionStorage.clear(); window.history.replaceState(null, '', '/')
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
] as const)('保存済みの畳む状態（%s・基本完了%s）でも残りの設定と入口を残す', async (key, complete) => {
  window.localStorage.setItem(key, '1')
  net.progress.mockResolvedValue(basic(complete))
  render(<DashboardV8 />)
  const basicProgress = await screen.findByRole('progressbar', { name: 'はじめにやることの進み' })
  expect(basicProgress.getAttribute('aria-valuenow')).toBe(complete ? '6' : '5')
  expect(within(guide()).getByRole('button', { name: '開く', exact: true }).getAttribute('aria-expanded')).toBe('false')
  expect((document.getElementById('first-steps-list') as HTMLElement).hidden).toBe(true)
  const configure = await pendingSetup()
  expect(within(guide()).getByText('リッチメニューなどの見た目を決める').closest('[hidden]')).toBeNull()
  expect(within(guide()).getByRole('heading', { name: '選んだ機能の設定' })).toBeTruthy()
  fireEvent.click(configure)
  expect(await screen.findByRole('dialog', { name: '最初のリッチメニューを選ぶ' })).toBeTruthy()
  expect(net.save).not.toHaveBeenCalled(); expect(net.activate).not.toHaveBeenCalled()
})

it('カードの進みは基本6段の1つだけにし、選んだ機能の設定と操作を残す', async () => {
  net.progress.mockResolvedValue(basic(true))
  render(<DashboardV8 />)
  await pendingSetup()
  expect(within(guide()).getByText('6 / 7 済み')).toBeTruthy()
  expect(within(guide()).getAllByRole('progressbar')).toHaveLength(1)
  expect(within(guide()).queryByRole('progressbar', { name: '使い方の設定の進み' })).toBeNull()
  expect(guide().textContent).not.toMatch(/質問 \d|済み \d+件/)
  expect(within(guide()).getByText('リッチメニューなどの見た目を決める')).toBeTruthy()
  expect(within(guide()).getByRole('button', { name: '設定を確認する' })).toBeTruthy()
})

it('基本GETだけ失敗しても取得済みの設定入口と独立した再試行を残す', async () => {
  net.progress.mockRejectedValueOnce(new Error('progress unavailable'))
  render(<DashboardV8 />)
  expect(await pendingSetup()).toBeTruthy()
  expect(screen.getByText('リッチメニューなどの見た目を決める')).toBeTruthy()
  expect(screen.queryByRole('progressbar', { name: 'はじめにやることの進み' })).toBeNull()
  const styleReads = net.style.mock.calls.length
  fireEvent.click(retry('はじめの設定の状態を確認できませんでした'))
  await waitFor(() => expect(net.progress).toHaveBeenCalledTimes(2))
  expect(await screen.findByRole('progressbar', { name: 'はじめにやることの進み' })).toBeTruthy()
  expect(net.style).toHaveBeenCalledTimes(styleReads)
  expect(net.progress).toHaveBeenCalledWith('A', 'v8')
  expect(net.save).not.toHaveBeenCalled(); expect(net.activate).not.toHaveBeenCalled()
})

it('基本GETが保留でstepsが空でも、取得済みの設定を隠さず0/0を作らない', async () => {
  let resolve!: (value: unknown) => void
  net.progress.mockImplementationOnce(() => new Promise(value => { resolve = value }))
  render(<DashboardV8 />)
  expect(await pendingSetup()).toBeTruthy()
  expect(document.querySelector('[data-design="TodayTasks"]')?.closest('[inert][aria-hidden="true"]')).toBeTruthy()
  expect(screen.queryByRole('progressbar', { name: 'はじめにやることの進み' })).toBeNull()
  expect(screen.queryByRole('progressbar', { name: '使い方の設定の進み' })).toBeNull()
  expect(screen.getByRole('heading', { name: '選んだ機能の設定' })).toBeTruthy()
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
  expect(await pendingSetup()).toBeTruthy()
  expect(net.style).toHaveBeenCalledTimes(2); expect(net.warnings).toHaveBeenCalledTimes(2); expect(net.items).toHaveBeenCalledTimes(2)
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
  expect(await pendingSetup()).toBeTruthy()
  expect(net.progress).toHaveBeenCalledTimes(2); expect(net.style).toHaveBeenCalledTimes(2)
})

it('基本6段の進みだけを示し、畳んでも後回しの設定操作を残す', async () => {
  net.progress.mockResolvedValue(basic(true))
  render(<DashboardV8 />)
  await pendingSetup()
  expect(screen.getAllByRole('progressbar')).toHaveLength(1)
  expect(within(guide()).getByText('6 / 7 済み')).toBeTruthy()
  expect(within(guide()).getByText('リッチメニューなどの見た目を決める')).toBeTruthy()
  fireEvent.click(within(guide()).getByRole('button', { name: '畳む', exact: true }))
  expect(screen.getByRole('button', { name: '使い方の設定を開く', exact: true })).toBeTruthy()
  fireEvent.click(within(guide()).getByRole('button', { name: '開く', exact: true }))
  expect(await pendingSetup()).toBeTruthy()
  expect(window.localStorage.getItem('lh:v8:first-steps-folded:A')).toBe('0')
})

it('基本が全完了で後回しの設定行が無ければ済みの1行へ畳む', async () => {
  net.googleHoursComplete = true
  net.progress.mockResolvedValue(basic(true)); net.style.mockResolvedValue(style(false))
  render(<DashboardV8 />)
  await waitFor(() => { expect(net.progress).toHaveBeenCalledTimes(1); expect(net.style).toHaveBeenCalledTimes(1) })
  await act(async () => { await Promise.resolve() })
  expect(screen.getByRole('heading', { name: 'はじめにやること', exact: true })).toBeTruthy()
  expect(within(guide()).getByText('7 / 7 済み')).toBeTruthy()
  expect(within(guide()).queryByRole('list')).toBeNull()
  expect(screen.getByRole('progressbar', {name:'はじめにやることの進み'})).toBeTruthy()
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
    const configure = screen.getByRole('button', { name: '使い方の設定を開く', exact: true })
    expect(configure.getAttribute('aria-disabled')).toBe('true')
    expect(document.getElementById(configure.getAttribute('aria-describedby')!)?.textContent).toContain('管理者')
    fireEvent.click(configure)
    expect(screen.queryByRole('dialog')).toBeNull()
  }
  if (role === null) expect(screen.queryByRole('button', { name: '使い方の設定を開く', exact: true })).toBeNull()
  if (role === null) {
    expect(net.style).not.toHaveBeenCalled()
    expect(net.warnings).not.toHaveBeenCalled(); expect(net.items).not.toHaveBeenCalled()
  } else {
    expect(await screen.findByRole('heading', { name: '選んだ機能の設定' })).toBeTruthy()
    expect(net.style).toHaveBeenCalledWith('A')
    expect(net.warnings).toHaveBeenCalledWith('A'); expect(net.items).toHaveBeenCalledWith('A')
    const change = within(guide()).getByRole('button', { name: '決める' })
    expect(change.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(change)
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

it('既知の質問入口から実wizardを開き、戻ると閉じるで保存を始めない', async () => {
  render(<DashboardV8 />)
  fireEvent.click(await pendingSetup())
  const dialog = await screen.findByRole('dialog', { name: '最初のリッチメニューを選ぶ' })
  fireEvent.click(within(dialog).getByRole('button', { name: 'スタイルを選び直す', exact: true }))
  const first = await screen.findByRole('dialog', { name: '使い方のスタイルを選ぶ' })
  fireEvent.click(within(first).getByRole('button', { name: '閉じる', exact: true }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(await pendingSetup()).toBeTruthy()
  expect(net.save).not.toHaveBeenCalled(); expect(net.activate).not.toHaveBeenCalled()
})


it('既知の業種を設定取得の失敗で標準へ戻さず、実物が未知の段は済みにしない', async () => {
  net.style.mockRejectedValue(new Error('setup unavailable'))
  render(<DashboardV8 accountStyle="ec" />)
  const progress = await screen.findByRole('progressbar', { name: 'はじめにやることの進み' })
  expect(progress.getAttribute('aria-valuenow')).toBe('2')
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
