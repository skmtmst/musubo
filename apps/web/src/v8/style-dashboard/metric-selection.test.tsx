import { getPageAction } from '@/test-utils/page-action'
// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { STYLE_METRIC_IDS, type StyleSchedule, type StyleSnapshot } from '@line-crm/shared'
const state = vi.hoisted(() => ({ account: 'a', role: 'admin', params: '', get: vi.fn(), save: vi.fn(), reset: vi.fn(), summary: vi.fn(), version: 2, customized: false as boolean | undefined, ids: ['bookings', 'attention', 'nextBookingRate', 'paidAmount', 'newBookings'], error: null as unknown }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => '/', useSearchParams: () => new URLSearchParams(state.params) }))
vi.mock('next/link', () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: state.account }) }))
vi.mock('@/lib/staff-role', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/staff-role')>(), useStaffRole: () => state.role }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('@/v8/restaurant/dashboard/public/use-store-today/index', () => ({ useStoreToday: () => ({}) }))
vi.mock('@/components/shared/preparing-dialog', async importOriginal => ({ ...await importOriginal<typeof import('@/components/shared/preparing-dialog')>(), PREPARING_TITLE: 'preparing', usePreparingDialog: () => ({ open: vi.fn(), dialog: null }) }))
vi.mock('@/lib/api/helpers/styles', () => ({ styleApi: { warnings: vi.fn().mockResolvedValue({ success: true, data: { items: [] } }), starterItems: vi.fn().mockResolvedValue({ success: true, data: { items: [] } }), summary: state.summary, schedule: vi.fn(), get: state.get, saveCards: state.save, resetCards: state.reset } }))
vi.mock('@/lib/api', async importOriginal => { const actual = await importOriginal<typeof import('@/lib/api')>(); return { ...actual, bookingApi: { ...actual.bookingApi, getPaymentConfig: vi.fn().mockResolvedValue({ data: {} }) } } })
import StyleDashboard from './style-dashboard'
import { styleApi } from '@/lib/api/helpers/styles'
import { firstRunPopupDismissedKey } from '@/v8/dashboard/first-run-popup'
const cards = [{ id: 'connection-alert', visible: true }, { id: 'ledger', visible: true }, { id: 'analytics', visible: true }]
const profile = () => ({ data: { cards, version: state.version, metricIds: [...state.ids], metricsCustomized: state.customized } })
const metric = (value: number, unit = '件') => ({ value, status: 'available' as const, unit, formula: '選択した期間の実集計' })
const snapshot: StyleSnapshot = { style: 'salon', from: '2026-10-20T15:00:00Z', to: '2026-10-21T15:00:00Z', timeZone: 'Asia/Tokyo', asOf: '2026-10-21T05:00:00Z', dateBasis: 'visit', range: 'today', metrics: { bookings: metric(4), attention: metric(2), nextBookingRate: metric(0.2, '%'), recall: metric(9), noShowRate: metric(0.1, '%'), visits: metric(3, '人') }, previous: {}, items: [], newBookings: [], resultId: 'real' }
const schedule: StyleSchedule = { style: 'salon', from: snapshot.from, to: snapshot.to, timeZone: snapshot.timeZone, asOf: snapshot.asOf, range: 'today', display: 'list', calendarView: 'day', entries: [], columns: [], days: [], closures: [], availability: { status: 'available', reason: null, resources: [], slots: [], closedDates: [] } }
function labels() { return Array.from(document.querySelectorAll('[data-style-dashboard] [data-kpi-label]')).map(node => node.getAttribute('title')) }
async function open() { await waitFor(() => expect(state.summary).toHaveBeenCalled()); fireEvent.click(getPageAction({ name: '表示を変更する' })); const drawer = await screen.findByRole('dialog', { name: /表示を変える/ }); await within(drawer).findByRole('switch', { name: '分析', exact: true }); return drawer }
beforeEach(() => {
  /* ここは数の帯の選択だけを見る。初回ポップアップ（枠02）は閉じた後の状態にして見出しの操作に重ねない。 */
  for (const id of ['a', 'b']) localStorage.setItem(firstRunPopupDismissedKey(id), '1')
  vi.clearAllMocks(); state.params = ''; state.account = 'a'; state.role = 'admin'; state.version = 2; state.customized = false; state.ids = ['bookings', 'attention', 'nextBookingRate', 'paidAmount', 'newBookings']; state.error = null
  state.get.mockImplementation(async () => profile()); state.summary.mockResolvedValue({ data: snapshot }); vi.mocked(styleApi.schedule).mockResolvedValue({ success: true, data: schedule })
  state.save.mockImplementation(async (_account, version, _cards, ids) => {
    if (state.error) throw state.error
    expect(version).toBe(state.version); state.version++
    if (ids !== undefined) { state.ids = ids; state.customized = true }
    return profile()
  })
  state.reset.mockImplementation(async () => { state.customized = false; state.version++; state.ids = ['bookings', 'attention', 'nextBookingRate', 'paidAmount', 'newBookings']; return profile() })
})
afterEach(() => { cleanup(); localStorage.clear() })

it('未選択は呼び戻し・無断率を保ち、変更した数だけ版付き保存して再読込後も順番を復元する', async () => {
  const view = render(<StyleDashboard style="salon" />)
  // 本線形：帯は5枚（5つ目の無断キャンセル率も帯の中）。
  await waitFor(() => expect(labels()).toEqual(['今日の予約', '対応待ち', '次回予約率', '呼び戻し待ち', '無断キャンセル率']))
  const drawer = await open()
  fireEvent.click(within(drawer).getByRole('switch', { name: '数の帯：無断キャンセル率' }))
  fireEvent.click(within(drawer).getByRole('switch', { name: '数の帯：来店数' }))
  fireEvent.click(within(drawer).getByRole('button', { name: '数の帯：来店数を上へ' }))
  fireEvent.click(within(drawer).getByRole('button', { name: '保存する', exact: true }))
  await waitFor(() => expect(state.save).toHaveBeenCalledWith('a', 2, cards, ['bookings', 'attention', 'nextBookingRate', 'visits', 'recall']))
  await waitFor(() => expect(labels()).toEqual(['今日の予約', '対応待ち', '次回予約率', '来店数', '呼び戻し待ち']))
  expect(state.summary.mock.calls.length).toBeGreaterThan(1)
  view.unmount(); render(<StyleDashboard style="salon" />)
  await waitFor(() => expect(labels()).toEqual(['今日の予約', '対応待ち', '次回予約率', '来店数', '呼び戻し待ち']))
})

it('明示customがserver defaultと同値でも保持し、カードのみ保存でmetricIdsを送らない', async () => {
  state.customized = true
  render(<StyleDashboard style="salon" />)
  await waitFor(() => expect(labels()).toEqual(['今日の予約', '対応待ち', '次回予約率', '入金額', '新着予約']))
  const drawer = await open()
  fireEvent.click(within(drawer).getByRole('switch', { name: '分析', exact: true }))
  fireEvent.click(within(drawer).getByRole('button', { name: '保存する', exact: true }))
  await waitFor(() => expect(state.save).toHaveBeenCalledWith('a', 2, [{ ...cards[0] }, { ...cards[1] }, { id: 'analytics', visible: false }], undefined))
  expect(state.customized).toBe(true)
  expect(state.ids).toEqual(['bookings', 'attention', 'nextBookingRate', 'paidAmount', 'newBookings'])
})

it('metadata省略時はdefaultと推測せず数編集を止め、カード保存で既存選択を上書きしない', async () => {
  state.customized = undefined
  render(<StyleDashboard style="salon" />)
  const drawer = await open()
  await within(drawer).findByText(/数の表示設定を確認できない/)
  expect(within(drawer).queryByRole('switch', { name: '数の帯：呼び戻し待ち' })).toBeNull()
  expect(screen.getByText(/保存した表示設定を確認できないため/)).toBeTruthy()
  expect(labels()).toContain('呼び戻し待ち')
  fireEvent.click(within(drawer).getByRole('switch', { name: '分析', exact: true }))
  fireEvent.click(within(drawer).getByRole('button', { name: '保存する', exact: true }))
  await waitFor(() => expect(state.save).toHaveBeenCalledWith('a', 2, [{ ...cards[0] }, { ...cards[1] }, { id: 'analytics', visible: false }], undefined))
  expect(state.ids).toContain('paidAmount')
})

it('取消・破棄は0保存、409後も選択入力を保持する', async () => {
  render(<StyleDashboard style="salon" />)
  let drawer = await open()
  fireEvent.click(within(drawer).getByRole('switch', { name: '数の帯：呼び戻し待ち' }))
  fireEvent.click(within(drawer).getByRole('button', { name: 'キャンセル', exact: true }))
  fireEvent.click(await screen.findByRole('button', { name: '破棄する', exact: true }))
  expect(state.save).not.toHaveBeenCalled()
  drawer = await open()
  expect(within(drawer).getByRole('switch', { name: '数の帯：呼び戻し待ち' }).getAttribute('aria-checked')).toBe('true')
  fireEvent.click(within(drawer).getByRole('switch', { name: '数の帯：呼び戻し待ち' }))
  state.error = { status: 409, code: 'version_conflict' }
  fireEvent.click(within(drawer).getByRole('button', { name: '保存する', exact: true }))
  await waitFor(() => expect(state.save).toHaveBeenCalledTimes(1))
  await waitFor(() => expect((within(drawer).getByRole('button', { name: '保存する', exact: true }) as HTMLButtonElement).disabled).toBe(false))
  expect(within(drawer).getByRole('switch', { name: '数の帯：呼び戻し待ち' }).getAttribute('aria-checked')).toBe('false')
  expect(state.customized).toBe(false)
})

it('resetだけdefaultへ戻し、空のcustomを未選択へ読み替えない', async () => {
  state.customized = true; state.ids = []
  render(<StyleDashboard style="salon" />)
  await waitFor(() => expect(state.get).toHaveBeenCalled())
  await waitFor(() => expect(labels()).toEqual([]))
  const drawer = await open()
  fireEvent.click(within(drawer).getByRole('button', { name: '型に戻す', exact: true }))
  await waitFor(() => expect(state.reset).toHaveBeenCalledWith('a', 2))
  await waitFor(() => expect(labels()).toContain('呼び戻し待ち'))
  // 本線形：5つ目の無断キャンセル率も帯の中の札。
  expect(labels()).toEqual(['今日の予約', '対応待ち', '次回予約率', '呼び戻し待ち', '無断キャンセル率'])
  for (const go of screen.getAllByRole('link', { name: '友だち一覧' })) expect(go.closest('[data-kpi-strip]')).not.toBeNull()
  expect(state.customized).toBe(false)
  expect(state.save).not.toHaveBeenCalled()
})

it('アカウント切替後の遅いGETと保存応答を新しい選択へ適用しない', async () => {
  let finishGet!: (value: unknown) => void
  state.get.mockImplementationOnce(() => new Promise(resolve => { finishGet = resolve }))
  const view = render(<StyleDashboard style="salon" />)
  state.account = 'b'; view.rerender(<StyleDashboard style="salon" />)
  await waitFor(() => expect(state.get).toHaveBeenCalledWith('b'))
  await waitFor(() => expect(labels()).toContain('呼び戻し待ち'))
  await act(async () => finishGet({ data: { ...profile().data, metricsCustomized: true, metricIds: [] } }))
  await waitFor(() => expect(labels()).toContain('呼び戻し待ち'))
  const drawer = await open()
  fireEvent.click(within(drawer).getByRole('switch', { name: '数の帯：呼び戻し待ち' }))
  let finishSave!: (value: unknown) => void
  state.save.mockImplementationOnce(() => new Promise(resolve => { finishSave = resolve }))
  fireEvent.click(within(drawer).getByRole('button', { name: '保存する', exact: true }))
  await waitFor(() => expect(state.save).toHaveBeenCalled())
  state.account = 'c'; view.rerender(<StyleDashboard style="salon" />)
  await waitFor(() => expect(screen.queryByRole('dialog', { name: /表示を変える/ })).toBeNull())
  await act(async () => finishSave({ data: { ...profile().data, version: 9, metricsCustomized: true, metricIds: [] } }))
  await waitFor(() => expect(labels()).toContain('呼び戻し待ち'))
  expect(state.get).toHaveBeenCalledWith('c')
})

it('閲覧のみには表示設定の変更入口を出さず、保存もしない', async () => {
  state.role = 'viewer'; state.customized = true; state.ids = ['recall', 'bookings']
  render(<StyleDashboard style="salon" />)
  await waitFor(() => expect(labels()).toEqual(['呼び戻し待ち', '今日の予約']))
  expect(screen.queryByRole('button', { name: '表示を変更する' })).toBeNull()
  expect(state.save).not.toHaveBeenCalled()
})

it('5超の既存customを切り捨てず共通の複数段へ復元する', async () => {
  state.customized = true; state.ids = ['bookings', 'attention', 'nextBookingRate', 'recall', 'noShowRate', 'visits']
  render(<StyleDashboard style="salon" />)
  await waitFor(() => expect(labels()).toEqual(['今日の予約', '対応待ち', '次回予約率', '呼び戻し待ち', '無断キャンセル率', '来店数']))
  const rows = document.querySelectorAll('[data-style-dashboard] > [data-kpi-strip]')
  // 本線形：段は5枚ずつ。
  expect(Array.from(rows).map(row => row.children.length)).toEqual([5, 1])
  expect(state.save).not.toHaveBeenCalled()
})

it('32項目の閲覧だけでも内容と順序を保ち、未取得を0にせず変更操作を出さない', async () => {
  state.role = 'viewer'; state.customized = true; state.ids = [...STYLE_METRIC_IDS]
  render(<StyleDashboard style="salon" />)
  await waitFor(() => expect(labels()).toHaveLength(32))
  const rows = document.querySelectorAll('[data-style-dashboard] > [data-kpi-strip]')
  // 本線形：段は5枚ずつ。
  expect(Array.from(rows).map(row => row.children.length)).toEqual([5, 5, 5, 5, 5, 5, 2])
  const pending = (await screen.findByRole('button', { name: '支払い待ちの説明' })).closest('[data-design-version]')!
  expect(within(pending as HTMLElement).getByText('—', { exact: true })).toBeTruthy()
  expect(screen.queryByRole('button', { name: '表示を変更する' })).toBeNull()
  expect(state.save).not.toHaveBeenCalled()
})

it('R11: 業種盤は5枚を帯に並べる（本線形）', async () => {
  render(<StyleDashboard style="salon" />)
  await waitFor(() => expect(labels()).toEqual(['今日の予約', '対応待ち', '次回予約率', '呼び戻し待ち', '無断キャンセル率']))
  // 5つ目の無断キャンセル率も帯の中の札。項目名・値・行き先を残す。
  const goes = await screen.findAllByRole('link', { name: '友だち一覧' })
  expect(goes.length).toBeGreaterThan(0)
  for (const go of goes) { expect(go.closest('[data-kpi-strip]')).not.toBeNull(); expect(go.getAttribute('href')).toBe('/friends') }
})

it('R11: 並べ替え後の5つ目も帯の中の札', async () => {
  state.customized = true; state.ids = ['bookings', 'attention', 'nextBookingRate', 'visits', 'recall']
  render(<StyleDashboard style="salon" />)
  await waitFor(() => expect(labels()).toEqual(['今日の予約', '対応待ち', '次回予約率', '来店数', '呼び戻し待ち']))
  const goes = await screen.findAllByRole('link', { name: '友だち一覧' })
  expect(goes.length).toBeGreaterThan(0)
  for (const go of goes) expect(go.closest('[data-kpi-strip]')).not.toBeNull()
})

it('追加決まり1: 読み直すは日付の段の中（本線B28形）', async () => {
  render(<StyleDashboard style="salon" />)
  await waitFor(() => expect(labels()).toHaveLength(5))
  // 題の操作には無い。
  const heading = document.querySelector('[data-page-heading-actions]')
  expect(heading).not.toBeNull()
  expect(within(heading as HTMLElement).queryByRole('button', { name: '読み直す' })).toBeNull()
  // 日付の段（期間の切り替えの行）の中にある。
  const read = await screen.findByRole('button', { name: '読み直す' })
  const period = document.querySelector('[role="group"][aria-label="期間"], [role="radiogroup"][aria-label="期間"]')
  expect(period).not.toBeNull()
  expect(period!.parentElement!.contains(read)).toBe(true)
})

it('追加決まり1: 右の列の開閉はタブの段に入り単独の段を作らない', async () => {
  render(<StyleDashboard style="salon" />)
  await waitFor(() => expect(labels()).toHaveLength(5))
  const toggle = await screen.findByRole('button', { name: '今日の確認を見る' })
  const columns = document.querySelector('[data-detail-columns]')!
  // タブの段（タブの後・本文の前）にあり、本文の2列の下の段には無い。
  expect(toggle.closest('[data-detail-columns]')).toBeNull()
  expect(toggle.compareDocumentPosition(columns) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
})

it('面談の結果待ちタブでも、狭い板で畳む「今日の確認」をタブの段から開け閉めできる', async () => {
  state.params = 'tab=bookings'
  state.summary.mockResolvedValue({ data: { ...snapshot, style: 'consult' } })
  vi.mocked(styleApi.schedule).mockResolvedValue({ success: true, data: { ...schedule, style: 'consult' } })
  render(<StyleDashboard style="consult" />)
  const toggle = await screen.findByRole('button', { name: '今日の確認を見る' })
  const aside = await waitFor(() => { const node = document.querySelector<HTMLElement>('[data-detail-columns="style-dashboard"] aside'); expect(node).not.toBeNull(); return node! })
  expect(within(aside).getByRole('region', { name: '今日の確認' })).toBeTruthy()
  expect(aside.hasAttribute('data-expanded')).toBe(false)
  fireEvent.click(toggle)
  expect(aside.hasAttribute('data-expanded')).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: '右の列を畳む' }))
  expect(aside.hasAttribute('data-expanded')).toBe(false)
})

it('追加決まり1: 一覧の探す欄は左に置く（右に1つ浮かせない）', async () => {
  render(<StyleDashboard style="restaurant" />)
  const box = await screen.findByPlaceholderText('名前・タグ・メモで探す')
  const tools = box.closest('[data-dashboard-list-tools]')
  expect(tools).not.toBeNull()
  // 探す欄が段の最初＝左寄せ。前に余白詰めは無い。
  expect(tools!.firstElementChild!.contains(box)).toBe(true)
})

it('R11: 飲食店も5枚を帯に並べる（本線形）', async () => {
  render(<StyleDashboard style="restaurant" />)
  await waitFor(() => expect(labels()).toEqual(['今日の予約', '対応待ち', '空席（いま）', '無断キャンセル率', '新着予約']))
  // 帯の中に新着予約の札の行き先がある（表示切替の「一覧」は帯の外なので数えない）。
  const strip = document.querySelector('[data-kpi-strip]')!
  const goes = (await within(strip as HTMLElement).findAllByRole('link', { name: '一覧' })).filter((go) => go.getAttribute('href') === '/restaurant-test/reservations')
  expect(goes.length).toBeGreaterThan(0)
})

it('旧応答の非保存fallbackから明示した再読込で真のcustomへ戻る', async () => {
  state.customized = undefined
  render(<StyleDashboard style="salon" />)
  await screen.findByText(/保存した表示設定を確認できないため/)
  expect(labels()).toContain('呼び戻し待ち')
  state.customized = true; state.ids = ['visits', 'bookings']
  fireEvent.click(await screen.findByRole('button', { name: '表示設定を読み直す' }))
  await waitFor(() => expect(labels()).toEqual(['来店数', '今日の予約']))
  expect(screen.queryByText(/保存した表示設定を確認できないため/)).toBeNull()
  expect(state.save).not.toHaveBeenCalled()
})

it('分析には期間と比較を残し、未接続の書き出し・定期メールを置かない', async () => {
  state.params = 'tab=analytics'
  render(<StyleDashboard style="salon" />)
  await waitFor(() => expect(state.summary).toHaveBeenCalled())
  expect(await screen.findByRole('group', { name: '期間' })).toBeTruthy()
  expect(screen.getByRole('button', { name: '比べる', exact: true })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'CSVで書き出す' })).toBeNull()
  expect(screen.queryByRole('button', { name: '毎朝メールで送る' })).toBeNull()
  expect(screen.queryByText('書き出しの口をつなぐと使えます。')).toBeNull()
  expect(screen.queryByText('定期の送信の口をつなぐと使えます。')).toBeNull()
})
