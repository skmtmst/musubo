// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { StyleSchedule, StyleSnapshot } from '@line-crm/shared'

const state = vi.hoisted(() => ({ account: 'a', role: 'admin', search: '', replace: vi.fn(), push: vi.fn(), get: vi.fn(), save: vi.fn(), reset: vi.fn(), summary: vi.fn(), schedule: vi.fn(), warnings: vi.fn(), items: vi.fn() }))
const firstRun = vi.hoisted(() => ({ status: 'ready' as 'ready' | 'loading', steps: [] as unknown[], watch: vi.fn(), notices: undefined as {message:string;href:string}[]|undefined }))
vi.mock('@/v8/onboarding/public/use-first-run/index', () => ({ useFirstRun: (_account: string, _enabled: boolean, watch: boolean) => { firstRun.watch(watch); return { status: firstRun.status, steps: firstRun.steps, firstRun: null, starter: null, error: null, reload: vi.fn(), watchExpired: false, rewatch: vi.fn() } } }))
vi.mock('@/v8/onboarding/public/style-setup-progress/index', () => ({ useStyleSetupProgress: (_id: string, style: string) => ({ progress: { style, steps: {}, notices: firstRun.notices }, reload: vi.fn() }) }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: state.push, replace: state.replace }), usePathname: () => '/', useSearchParams: () => new URLSearchParams(state.search) }))
vi.mock('next/link', () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: state.account, selectedAccount: { channelId: state.account, basicId: '@same-store', displayName: '同じ店' } }) }))
vi.mock('@/lib/staff-role', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/staff-role')>(), useStaffRole: () => state.role }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('@/v8/restaurant/dashboard/public/use-store-today/index', () => ({ useStoreToday: () => ({}) }))
vi.mock('@/components/shared/preparing-dialog', () => ({ PREPARING_TITLE: 'preparing', PREPARING_WORD: '準備中', usePreparingDialog: () => ({ open: vi.fn(), dialog: null }) }))
vi.mock('@/lib/api/helpers/styles', () => ({ styleApi: { summary: state.summary, schedule: state.schedule, get: state.get, saveCards: state.save, resetCards: state.reset, warnings: state.warnings, starterItems: state.items, starterSet: vi.fn().mockResolvedValue({ success: true, data: { definition: { items: [] } } }) } }))
vi.mock('@/lib/api', async importOriginal => { const actual = await importOriginal<typeof import('@/lib/api')>(); return { ...actual, api: { ...actual.api, entryRoutes: { ...actual.api.entryRoutes, list: vi.fn().mockResolvedValue({ success: true, data: [] }) } }, bookingApi: { ...actual.bookingApi, getPaymentConfig: vi.fn().mockResolvedValue({ data: {} }) } } })

vi.mock('@/components/dashboard/qr-dialog', () => ({ default: ({ open }: { open: boolean }) => open ? <div role="dialog" aria-label="友だち追加のQRコード" /> : null }))

import StyleDashboard from './style-dashboard'
import { buildStepsFromApi } from '@/v8/settings/getting-started/steps'

const metric = (value: number, unit = '件') => ({ value, status: 'available' as const, unit, formula: '選択した期間の実集計' })
const snapshot: StyleSnapshot = { style: 'restaurant', from: '2026-10-29T15:00:00Z', to: '2026-10-30T15:00:00Z', timeZone: 'Asia/Tokyo', asOf: '2026-10-30T05:00:00Z', dateBasis: 'visit', range: 'today', metrics: { bookings: metric(4), guests: metric(23, '人'), firstTime: metric(2), regular: metric(3), unseated: metric(1), mediaCloseTasks: metric(2), attention: metric(3), freeTables: metric(5, '卓'), noShowRate: metric(0.05, '%') }, previous: {}, items: [], newBookings: [], resultId: 'real' }
const schedule: StyleSchedule = { style: 'restaurant', from: snapshot.from, to: snapshot.to, timeZone: snapshot.timeZone, asOf: snapshot.asOf, range: 'today', display: 'list', calendarView: 'day', entries: [], columns: [], days: [], closures: [], availability: { status: 'available', reason: null, resources: [], slots: [], closedDates: [] } }

beforeEach(() => {
  vi.clearAllMocks()
  state.role = 'admin'
  state.search = ''
  firstRun.notices = undefined
  firstRun.status = 'ready'
  firstRun.steps = buildStepsFromApi(['accounts', 'featureSet', 'attributes', 'friendAdd', 'scenario', 'firstMessage'].map(key => ({ key, state: 'todo', href: '/getting-started', reason: null })) as Parameters<typeof buildStepsFromApi>[0])
  state.account = 'a'
  state.get.mockResolvedValue({ success: true, data: { style: 'restaurant', styleSelected: true, answers: { image: { mode: 'configured', value: 'simple' } }, cards: [], version: 2, metricIds: ['bookings', 'attention', 'freeTables', 'noShowRate', 'newBookings'] } })
  state.warnings.mockResolvedValue({ success: true, data: { count: 0, items: [] } })
  state.items.mockResolvedValue({ success: true, data: { items: [{ target_id: 'notice', kind: 'automation', is_sample: 1, status: 'draft', draftRevision: 'draft' }, { target_id: 'menu', kind: 'rich_menu', is_sample: 1, status: 'draft', draftRevision: null }] } })
  state.summary.mockResolvedValue({ data: snapshot })
  state.schedule.mockResolvedValue({ success: true, data: schedule })
})
afterEach(cleanup)

it('上の段を軽くするため読み直しは文字の押し口にする', async () => {
  render(<StyleDashboard style="restaurant" />)
  const reload = await screen.findByRole('button', { name: '読み直す' })
  expect(reload.getAttribute('data-variant')).toBe('text')
})

it('探す欄は正の包みで220pxの幅を保つ', async () => {
  render(<StyleDashboard style="restaurant" />)
  const input = await screen.findByPlaceholderText('名前・タグ・メモで探す')
  expect(input.closest('[data-toolbar-layout]')).toBeNull()
  expect((input.closest('[data-toolbar-search]') as HTMLElement).style.getPropertyValue('--list-search-width')).toBe('220px')
})

it('数の帯の対応待ちの補足は1行に収まる短さにする', async () => {
  render(<StyleDashboard style="restaurant" />)
  expect(await screen.findByText('未配席 1・枠閉じ 2')).toBeTruthy()
  expect(screen.queryByText(/枠を閉じる/)).toBeNull()
})

it('飲食は初期設定の取得中に数字を先に見せず、案内と一緒に出す', async () => {
  let release!: (value: unknown) => void
  state.items.mockReturnValue(new Promise(resolve => { release = resolve }))
  const view = render(<StyleDashboard style="restaurant" />)
  await waitFor(() => expect(state.summary).toHaveBeenCalled())
  await waitFor(() => expect(state.items).toHaveBeenCalled())
  const kpi = await screen.findByText('未配席 1・枠閉じ 2')
  expect(kpi.closest('[data-pending="true"][aria-hidden="true"][inert]')).not.toBeNull()
  expect(screen.queryByRole('heading', { name: 'はじめにやること' })).toBeNull()
  await act(async () => { release({ success: true, data: { items: [] } }) })
  expect(await screen.findByRole('heading', { name: 'はじめにやること' })).toBeTruthy()
  expect(await screen.findByText('未配席 1・枠閉じ 2')).toBeTruthy()
  expect(view.container.querySelector('[data-pending="true"]')).toBeNull()
})

it('飲食は最初の案内の取得中に数字を先に見せず、案内と一緒に出す', async () => {
  firstRun.status = 'loading'
  const view = render(<StyleDashboard style="restaurant" />)
  await waitFor(() => expect(state.summary).toHaveBeenCalled())
  const kpi = await screen.findByText('未配席 1・枠閉じ 2')
  expect(kpi.closest('[data-pending="true"][aria-hidden="true"][inert]')).not.toBeNull()
  expect(screen.queryByRole('heading', { name: 'はじめにやること' })).toBeNull()
  firstRun.status = 'ready'
  view.rerender(<StyleDashboard style="restaurant" />)
  expect(await screen.findByRole('heading', { name: 'はじめにやること' })).toBeTruthy()
  expect(await screen.findByText('未配席 1・枠閉じ 2')).toBeTruthy()
  expect(view.container.querySelector('[data-pending="true"]')).toBeNull()
})

it('サロンの対応待ちの補足も1行に収まる短さにする', async () => {
  render(<StyleDashboard style="salon" />)
  expect(await screen.findByText('承認待ち・来店未記録')).toBeTruthy()
})

it.each(['restaurant', 'salon', 'consult', 'lesson'] as const)('%sの専用画面も共通の手順を数の帯より先に出す', async style => {
  const view = render(<StyleDashboard style={style} />)
  const title = await screen.findByRole('heading', { name: 'はじめにやること' })
  const card = title.closest('section')!
  expect(card.querySelectorAll('#first-steps-list > li')).toHaveLength(style === 'restaurant' ? 8 : 6)
  const band = view.container.querySelector('[data-style-dashboard]')!
  expect(card.compareDocumentPosition(band) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
})
it('専用画面の閲覧のみでもカードを隠さず、設定の操作を灰色で残す', async () => {
  state.role = 'viewer'
  render(<StyleDashboard style="restaurant" />)
  const card = (await screen.findByRole('heading', { name: 'はじめにやること' })).closest('section')!
  expect(card.querySelectorAll('a')).toHaveLength(0)
  expect(card.querySelectorAll('button[aria-disabled="true"]').length).toBeGreaterThan(0)
})

it.each([
  ['restaurant', '席の予約設定'], ['salon', 'メニュー・料金'], ['consult', '面談の予約設定'], ['lesson', 'クラス・スケジュール'],
] as const)('%sの選んだ機能の設定は同じ口と部品で読み、既存の質問へ開く', async (style, note) => {
  const profile = { style, styleSelected: true, version: 2, cards: [], answers: { image: { mode: 'configured', value: 'simple' } } }
  state.get.mockResolvedValue({ success: true, data: profile })
  render(<StyleDashboard style={style} />)
  expect(await screen.findByRole('heading', { name: '選んだ機能の設定' })).toBeTruthy()
  expect(screen.getByText('入ったお知らせを動かす')).toBeTruthy()
  expect(screen.getByText(new RegExp(note))).toBeTruthy()
  expect(state.warnings).toHaveBeenCalledWith('a')
  expect(state.items).toHaveBeenCalledWith('a')
  fireEvent.click(screen.getByRole('button', { name: '中身を見る' }))
  expect(await screen.findByRole('dialog', { name: '準備ができました' })).toBeTruthy()
  await screen.findByRole('heading', { name: '入った物', exact: true })
  expect(state.push).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '閉じる', exact: true }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  fireEvent.click(screen.getByRole('button', { name: '使い方の設定を開く' }))
  expect(await screen.findByRole('dialog')).toBeTruthy()
  expect(state.push).not.toHaveBeenCalled()
})

it.each(['viewer', 'staff'])('%sは設定の欄を読み、変更と中身を見る操作を理由付きで止める', async role => {
  state.role = role
  render(<StyleDashboard style="restaurant" />)
  const button = await screen.findByRole('button', { name: '使い方の設定を開く' })
  expect(button.getAttribute('aria-disabled')).toBe('true')
  fireEvent.focus(button)
  expect((await screen.findByRole('tooltip')).textContent).toContain('管理者')
  fireEvent.click(button)
  expect(state.push).not.toHaveBeenCalled()
  expect(await screen.findByRole('heading', { name: '選んだ機能の設定' })).toBeTruthy()
  expect(state.warnings).toHaveBeenCalledWith('a')
  expect(state.items).toHaveBeenCalledWith('a')
  const confirm = screen.getByRole('button', { name: '確かめる' })
  expect(confirm.getAttribute('aria-disabled')).toBe('true')
  fireEvent.click(confirm)
  expect(state.push).not.toHaveBeenCalled()
  const read = screen.getByRole('button', { name: '中身を見る' })
  expect(read.getAttribute('aria-disabled')).toBe('true')
  expect(document.getElementById(read.getAttribute('aria-describedby')!)?.textContent).toContain('中身はオーナーか管理者が見られます')
  fireEvent.click(read)
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(state.push).not.toHaveBeenCalled()
  expect(state.save).not.toHaveBeenCalled()
})

it('設定の取得失敗を未設定にせず、同じ口を読み直せる', async () => {
  state.warnings.mockRejectedValueOnce(new Error('unavailable'))
  render(<StyleDashboard style="restaurant" />)
  expect(await screen.findByText('使い方の設定を確認できませんでした')).toBeTruthy()
  expect(screen.queryByRole('button', { name: '使い方の設定を開く' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
  expect(await screen.findByRole('heading', { name: '選んだ機能の設定' })).toBeTruthy()
  await waitFor(() => expect(state.warnings).toHaveBeenCalledTimes(2))
})

it('選んだ機能の設定が遅れたときは案内と数字を一緒に出す', async () => {
  let resolve!: (value: unknown) => void
  state.warnings.mockImplementationOnce(() => new Promise(done => { resolve = done }))
  const view = render(<StyleDashboard style="restaurant" />)
  await waitFor(() => expect(state.warnings).toHaveBeenCalled())
  await waitFor(() => expect(view.container.querySelector('[data-pending="true"]')).not.toBeNull())
  await act(async () => resolve({ success: true, data: { items: [] } }))
  await waitFor(() => expect(view.container.querySelector('[data-pending="true"]')).toBeNull())
  expect(await screen.findByRole('heading', { name: '選んだ機能の設定' })).toBeTruthy()
  expect(await screen.findByText('未配席 1・枠閉じ 2')).toBeTruthy()
})

it.each(['restaurant', 'salon', 'consult', 'lesson'].flatMap(style => ['0', 'summary'].map(step => [style, step])))('%sはsetup=%sを同じ専用画面で開き、閉じても期間を残す', async (style, step) => {
  state.search = `setup=${step}&range=week`
  state.get.mockResolvedValue({ success: true, data: { style, styleSelected: true, version: 2, answers: {} } })
  const view = render(<StyleDashboard style={style as 'restaurant' | 'salon' | 'consult' | 'lesson'} />)
  await screen.findByRole('dialog', { name: step === 'summary' ? '準備ができました' : '使い方のスタイルを選ぶ' })
  if (step === 'summary') await screen.findByRole('heading', { name: '入った物', exact: true })
  expect(view.container.querySelector('[data-style-dashboard]')?.getAttribute('data-style-dashboard')).toBe(style)
  fireEvent.click(screen.getByRole('button', { name: '閉じる', exact: true }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(state.replace).toHaveBeenLastCalledWith('/?range=week')
  expect(state.save).not.toHaveBeenCalled()
})

it.each(['restaurant', 'salon', 'consult', 'lesson'] as const)('%sはQRを1つだけ重ねて最初の1通の読み直しを待つ', async style => {
  state.search = 'qr=base'
  const view = render(<StyleDashboard style={style} />)
  expect(await screen.findAllByRole('dialog', { name: '友だち追加のQRコード' })).toHaveLength(1)
  await waitFor(() => expect(firstRun.watch).toHaveBeenCalledWith(true))
  expect(view.container.querySelector('[data-style-dashboard]')?.getAttribute('data-style-dashboard')).toBe(style)
})

it.each(['viewer', 'staff'])('役割%sでは専用画面のURLでも質問を開かない', async role => {
  state.search = 'setup=0'
  const view = render(<StyleDashboard style="restaurant" />)
  await screen.findByRole('dialog', { name: '使い方のスタイルを選ぶ' })
  state.role = role
  view.rerender(<StyleDashboard style="restaurant" />)
  await screen.findByRole('heading', { name: '選んだ機能の設定' })
  expect(screen.queryByRole('dialog')).toBeNull()
})

it.each(['admin','staff','viewer'])('飲食のホームでも復旧案内を出し、%sの入口の権限を保つ',async role=>{
  state.role=role
  firstRun.notices=[{message:'予約フォームの設定が読めないため、最小の項目で受け付けています。直してください',href:'/restaurant-test/line-followup?store_id=store-a&repair_form=1'}]
  render(<StyleDashboard style="restaurant"/>)
  expect(await screen.findByText(/予約フォームの設定が読めないため/)).toBeTruthy()
  if(role==='admin')expect(screen.getByRole('link',{name:'予約フォームを直す →'}).getAttribute('href')).toBe('/restaurant-test/line-followup?store_id=store-a&repair_form=1')
  else {
    expect(screen.queryByRole('link',{name:'予約フォームを直す →'})).toBeNull()
    const button=screen.getByRole('button',{name:'予約フォームを直す →'})
    expect(button.getAttribute('aria-disabled')).toBe('true')
    const reasonId=button.getAttribute('aria-describedby')
    expect(reasonId).toBeTruthy()
    expect(document.getElementById(reasonId!)?.textContent).toBe(role==='viewer'?'閲覧のみのため変更できません。オーナーか管理者に頼んでください。':'この操作はオーナーか管理者だけができます。')
  }
})
