// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { StyleSchedule, StyleSnapshot } from '@line-crm/shared'

const state = vi.hoisted(() => ({ account: 'a', role: 'admin' as string | null, search: '', replace: vi.fn(), push: vi.fn(), get: vi.fn(), save: vi.fn(), reset: vi.fn(), summary: vi.fn(), schedule: vi.fn(), warnings: vi.fn(), items: vi.fn() }))
type Store = { id: string; line_account_id: string }
type Snapshot = { stores: Store[] }
const storeState = vi.hoisted(() => ({ store: null as Store | null, snapshot: null as Snapshot | null, tableDefinition: undefined as { accountId: string; snapshot: Snapshot } | undefined, loading: true, error: null as Error | null }))
const firstRun = vi.hoisted(() => ({ steps: [] as unknown[], watch: vi.fn(), notices: undefined as {message:string;href:string}[]|undefined }))
vi.mock('@/v8/onboarding/public/use-first-run/index', () => ({ useFirstRun: (_account: string, _enabled: boolean, watch: boolean) => { firstRun.watch(watch); return { status: 'ready', steps: firstRun.steps, firstRun: null, starter: null, error: null, reload: vi.fn(), watchExpired: false, rewatch: vi.fn() } } }))
vi.mock('@/v8/onboarding/public/style-setup-progress/index', () => ({ useStyleSetupProgress: (_id: string, style: string) => ({ progress: { style, steps: {}, notices: firstRun.notices }, reload: vi.fn() }) }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: state.push, replace: state.replace }), usePathname: () => '/', useSearchParams: () => new URLSearchParams(state.search) }))
vi.mock('next/link', () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: state.account, selectedAccount: { channelId: state.account, basicId: '@same-store', displayName: '同じ店' } }) }))
vi.mock('@/lib/staff-role', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/staff-role')>(), useStaffRole: () => state.role }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('@/v8/restaurant/dashboard/public/use-store-today/index', () => ({ useStoreToday: () => ({ accountId: state.account, today: null, closeTasks: [], media: [], ...storeState }) }))
vi.mock('@/components/shared/preparing-dialog', () => ({ PREPARING_TITLE: 'preparing', PREPARING_WORD: '準備中', usePreparingDialog: () => ({ open: vi.fn(), dialog: null }) }))
vi.mock('@/lib/api/helpers/styles', () => ({ styleApi: { summary: state.summary, schedule: state.schedule, get: state.get, saveCards: state.save, resetCards: state.reset, warnings: state.warnings, starterItems: state.items, starterSet: vi.fn().mockResolvedValue({ success: true, data: { definition: { items: [] } } }) } }))
vi.mock('@/lib/api', async importOriginal => { const actual = await importOriginal<typeof import('@/lib/api')>(); return { ...actual, api: { ...actual.api, entryRoutes: { ...actual.api.entryRoutes, list: vi.fn().mockResolvedValue({ success: true, data: [] }) } }, bookingApi: { ...actual.bookingApi, getPaymentConfig: vi.fn().mockResolvedValue({ data: {} }) } } })

vi.mock('@/components/dashboard/qr-dialog', () => ({ default: ({ open }: { open: boolean }) => open ? <div role="dialog" aria-label="友だち追加のQRコード" /> : null }))

vi.mock('@/v8/restaurant/front-desk/public/phone-drawer/index', () => ({ PhoneReservationDrawer: ({ open, storeId }: { open: boolean; storeId: string }) => open ? <div role="dialog" aria-label="電話予約">{storeId}</div> : null }))
vi.mock('@/v8/restaurant/front-desk/public/walk-in-dialog/index', () => ({ WalkInDialog: ({ open, storeId }: { open: boolean; storeId: string }) => open ? <div role="dialog" aria-label="ウォークイン受付">{storeId}</div> : null }))

import StyleDashboard from './style-dashboard'
import { firstRunPopupDismissedKey } from '@/v8/dashboard/first-run-popup'
import { buildStepsFromApi } from '@/v8/settings/getting-started/steps'

const metric = (value: number, unit = '件') => ({ value, status: 'available' as const, unit, formula: '選択した期間の実集計' })
const snapshot: StyleSnapshot = { style: 'restaurant', from: '2026-10-29T15:00:00Z', to: '2026-10-30T15:00:00Z', timeZone: 'Asia/Tokyo', asOf: '2026-10-30T05:00:00Z', dateBasis: 'visit', range: 'today', metrics: { bookings: metric(4), guests: metric(23, '人'), firstTime: metric(2), regular: metric(3), unseated: metric(1), mediaCloseTasks: metric(2), attention: metric(3), freeTables: metric(5, '卓'), noShowRate: metric(0.05, '%') }, previous: {}, items: [], newBookings: [], resultId: 'real' }
const schedule: StyleSchedule = { style: 'restaurant', from: snapshot.from, to: snapshot.to, timeZone: snapshot.timeZone, asOf: snapshot.asOf, range: 'today', display: 'list', calendarView: 'day', entries: [], columns: [], days: [], closures: [], availability: { status: 'available', reason: null, resources: [], slots: [], closedDates: [] } }

beforeEach(() => {
  vi.clearAllMocks()
  /* ここは見出しの操作だけを見る。初回ポップアップ（枠02/02b）は閉じた後の状態にして重ねない。 */
  for (const id of ['a', 'b']) localStorage.setItem(firstRunPopupDismissedKey(id), '1')
  storeState.store = null; storeState.snapshot = null; storeState.tableDefinition = undefined; storeState.loading = true; storeState.error = null
  state.role = 'admin'
  state.search = ''
  firstRun.notices = undefined
  firstRun.steps = buildStepsFromApi(['accounts', 'featureSet', 'attributes', 'friendAdd', 'scenario', 'firstMessage'].map(key => ({ key, state: 'todo', href: '/getting-started', reason: null })) as Parameters<typeof buildStepsFromApi>[0])
  state.account = 'a'
  state.get.mockResolvedValue({ success: true, data: { style: 'restaurant', styleSelected: true, answers: { image: { mode: 'configured', value: 'simple' } }, cards: [], version: 2, metricIds: ['bookings', 'attention', 'freeTables', 'noShowRate', 'newBookings'] } })
  state.warnings.mockResolvedValue({ success: true, data: { count: 0, items: [] } })
  state.items.mockResolvedValue({ success: true, data: { items: [{ target_id: 'notice', kind: 'automation', is_sample: 1, status: 'draft', draftRevision: 'draft' }, { target_id: 'menu', kind: 'rich_menu', is_sample: 1, status: 'draft', draftRevision: null }] } })
  state.summary.mockResolvedValue({ data: snapshot })
  state.schedule.mockResolvedValue({ success: true, data: schedule })
})
afterEach(() => { cleanup(); localStorage.clear() })

const heading = () => within(document.querySelector('[data-template-region="heading"]') as HTMLElement)
const actions = () => document.querySelector('[data-page-heading-actions]')!
const labels = () => [...actions().querySelectorAll('button,a')].map(node => node.textContent)
const readyStore = (id = 'a') => {
  storeState.store = { id: `store-${id}`, line_account_id: `linked-${id}` }
  storeState.snapshot = { stores: [storeState.store] }
  storeState.tableDefinition = { accountId: id, snapshot: storeState.snapshot }
  storeState.loading = false
}

it('店を待つ間も同じ操作を残し、取得後だけウォークインを開く', async () => {
  const view = render(<StyleDashboard style="restaurant" />)
  const button = heading().getByRole('button', { name: 'ウォークイン', exact: true })
  expect(button.getAttribute('aria-disabled')).toBe('true')
  expect(document.getElementById(button.getAttribute('aria-describedby')!)?.textContent).toContain('店舗情報')
  fireEvent.click(button)
  expect(screen.queryByRole('dialog')).toBeNull()
  await waitFor(() => expect(state.summary).toHaveBeenCalledWith('a', expect.anything()))
  const before = labels()
  readyStore(); view.rerender(<StyleDashboard style="restaurant" />)
  expect(heading().getByRole('button', { name: 'ウォークイン', exact: true })).toBe(button)
  expect(labels()).toEqual(before)
  expect(button.getAttribute('aria-disabled')).toBeNull()
  fireEvent.click(button)
  expect(screen.getByRole('dialog', { name: 'ウォークイン受付' }).textContent).toBe('store-a')
  expect(state.save).not.toHaveBeenCalled()
})

it('数字の取得中も主操作の場所を取り、完了前には予約を開かない', async () => {
  let finish!: (value: unknown) => void
  state.summary.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  readyStore()
  render(<StyleDashboard style="restaurant" />)
  const button = heading().getByRole('button', { name: '予約を入れる', exact: true })
  const before = labels()
  expect(button.getAttribute('aria-disabled')).toBe('true')
  fireEvent.click(button)
  expect(screen.queryByRole('dialog')).toBeNull()
  await waitFor(() => expect(finish).toBeTypeOf('function'))
  await act(async () => finish({ data: snapshot }))
  await waitFor(() => expect(button.getAttribute('aria-disabled')).toBeNull())
  expect(labels()).toEqual(before)
  expect(heading().getByRole('button', { name: '予約を入れる', exact: true })).toBe(button)
  fireEvent.click(button)
  expect(screen.getByRole('dialog', { name: '電話予約' }).textContent).toBe('store-a')
})

it('店の取得失敗でも操作を置換せず、理由を示して止める', async () => {
  const view = render(<StyleDashboard style="restaurant" />)
  const before = labels()
  storeState.loading = false; storeState.error = new Error('unavailable')
  view.rerender(<StyleDashboard style="restaurant" />)
  await waitFor(() => expect(state.summary).toHaveBeenCalled())
  expect(labels()).toEqual(before)
  for (const name of ['ウォークイン', '予約を入れる']) {
    const button = heading().getByRole('button', { name, exact: true })
    expect(button.getAttribute('aria-disabled')).toBe('true')
    expect(document.getElementById(button.getAttribute('aria-describedby')!)?.textContent).toContain('店舗情報を確認できません')
    fireEvent.click(button)
  }
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(state.push).not.toHaveBeenCalled()
})

it('店を切り替えた直後に前の店の情報では操作を開かない', async () => {
  readyStore()
  const view = render(<StyleDashboard style="restaurant" />)
  await waitFor(() => expect(heading().getByRole('button', { name: '予約を入れる', exact: true }).getAttribute('aria-disabled')).toBeNull())
  const before = labels()
  state.account = 'b'; view.rerender(<StyleDashboard style="restaurant" />)
  for (const name of ['ウォークイン', '予約を入れる']) {
    const button = heading().getByRole('button', { name, exact: true })
    expect(button.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(button)
  }
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(labels()).toEqual(before)
  await waitFor(() => expect(state.summary).toHaveBeenCalledWith('b', expect.anything()))
  readyStore('b'); view.rerender(<StyleDashboard style="restaurant" />)
  await waitFor(() => expect(heading().getByRole('button', { name: '予約を入れる', exact: true }).getAttribute('aria-disabled')).toBeNull())
  fireEvent.click(heading().getByRole('button', { name: 'ウォークイン', exact: true }))
  expect(screen.getByRole('dialog', { name: 'ウォークイン受付' }).textContent).toBe('store-b')
})

it.each(['owner', 'admin', 'staff', 'viewer', null])('役割%sの許可を取得後も変えない', async role => {
  state.role = role
  readyStore()
  render(<StyleDashboard style="restaurant" />)
  await waitFor(() => expect(state.summary).toHaveBeenCalled())
  const button = heading().getByRole('button', { name: 'ウォークイン', exact: true })
  fireEvent.click(button)
  if (role && role !== 'viewer') expect(screen.getByRole('dialog', { name: 'ウォークイン受付' })).toBeTruthy()
  else expect(screen.queryByRole('dialog')).toBeNull()
})

it('予約が0の飲食でも取得後のヘッダー操作は同じ並びを保つ', async () => {
  state.summary.mockResolvedValue({ data: { ...snapshot, metrics: { ...snapshot.metrics, bookings: metric(0) } } })
  readyStore()
  render(<StyleDashboard style="restaurant" />)
  const before = labels()
  await waitFor(() => expect(heading().getByRole('button', { name: '予約を入れる', exact: true }).getAttribute('aria-disabled')).toBeNull())
  expect(labels()).toEqual(before)
})

it.each(['salon', 'consult', 'lesson'] as const)('%sに飲食の操作を加えない', async style => {
  render(<StyleDashboard style={style} />)
  expect(heading().queryByRole('button', { name: 'ウォークイン', exact: true })).toBeNull()
  await waitFor(() => expect(state.summary).toHaveBeenCalled())
  expect(heading().queryByRole('button', { name: 'ウォークイン', exact: true })).toBeNull()
})

it('統括の要求で取得した組織内の店は、店のLINEアカウントが違っても開ける', async () => {
  readyStore()
  expect(storeState.store!.line_account_id).not.toBe(state.account)
  render(<StyleDashboard style="restaurant" />)
  const button = heading().getByRole('button', { name: 'ウォークイン', exact: true })
  expect(button.getAttribute('aria-disabled')).toBeNull()
  fireEvent.click(button)
  expect((await screen.findByRole('dialog', { name: 'ウォークイン受付' })).textContent).toBe('store-a')
})

it.each(['no-receipt', 'old-account', 'old-reference', 'outside-snapshot', 'loading', 'failed'] as const)('取得元の確認が%sなら保持した店では開かない', async condition => {
  readyStore()
  if (condition === 'no-receipt') storeState.tableDefinition = undefined
  if (condition === 'old-account') storeState.tableDefinition!.accountId = 'other'
  if (condition === 'old-reference') storeState.snapshot = { stores: [storeState.store!] }
  if (condition === 'outside-snapshot') storeState.snapshot!.stores = []
  if (condition === 'loading') storeState.loading = true
  if (condition === 'failed') storeState.error = new Error('unavailable')
  render(<StyleDashboard style="restaurant" />)
  await waitFor(() => expect(state.summary).toHaveBeenCalled())
  for (const name of ['ウォークイン', '予約を入れる']) {
    const button = heading().getByRole('button', { name, exact: true })
    expect(button.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(button)
  }
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(state.push).not.toHaveBeenCalled()
})

it('同じ店の読み直しも取得元の確認が戻るまで停止し、位置は保つ', async () => {
  readyStore()
  const view = render(<StyleDashboard style="restaurant" />)
  await waitFor(() => expect(heading().getByRole('button', { name: '予約を入れる', exact: true }).getAttribute('aria-disabled')).toBeNull())
  const before = labels()
  storeState.loading = true; storeState.tableDefinition = undefined
  view.rerender(<StyleDashboard style="restaurant" />)
  for (const name of ['ウォークイン', '予約を入れる']) {
    const button = heading().getByRole('button', { name, exact: true })
    expect(button.getAttribute('aria-disabled')).toBe('true'); fireEvent.click(button)
  }
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(labels()).toEqual(before)
  readyStore(); view.rerender(<StyleDashboard style="restaurant" />)
  expect(heading().getByRole('button', { name: '予約を入れる', exact: true }).getAttribute('aria-disabled')).toBeNull()
  expect(labels()).toEqual(before)
})
