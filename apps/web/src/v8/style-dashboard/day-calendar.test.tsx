// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { IndustryStyle, StyleBooking, StyleSchedule, StyleSnapshot } from '@line-crm/shared'
import type { eventsApi } from '@/lib/api'
import type { ButtonProps } from '@/components/shared/button'
import { STYLE_CONFIG } from './config'
import { PERMISSION_LOCK_REASON } from '@/components/shared/permission-lock'
import { toToday } from './adapter'
import { DayList, WeekCalendar } from './calendar'
import { StaffBoard } from './staff-board'
import StyleDashboard from './style-dashboard'
import { setTestReducedMotion } from '@/test-utils/reduced-motion'

const state = vi.hoisted(() => ({ search: 'view=calendar', role: 'admin' as string | null, directGuardProbe: false, unsafeAddNew: vi.fn(), buttons: [] as ButtonProps[], push: vi.fn(), replace: vi.fn(), summary: vi.fn(), schedule: vi.fn(), bookings: vi.fn<typeof eventsApi.listBookings>() }))
vi.mock('@/components/shared/button', async importOriginal => {
  const actual = await importOriginal<typeof import('@/components/shared/button')>()
  return { ...actual, default: (props: ButtonProps) => {
    const id = state.buttons.push(props) - 1
    return <actual.default {...props} data-test-button-id={id} />
  } }
})
vi.mock('./use-style-dashboard', async importOriginal => {
  const actual = await importOriginal<typeof import('./use-style-dashboard')>()
  return { ...actual, useStyleDashboard: (...args: Parameters<typeof actual.useStyleDashboard>) => {
    const data = actual.useStyleDashboard(...args)
    return state.directGuardProbe ? { ...data, addNew: state.unsafeAddNew } : data
  } }
})
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: state.push, replace: state.replace }), usePathname: () => '/', useSearchParams: () => new URLSearchParams(state.search) }))
vi.mock('next/link', () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'calendar-account' }) }))
vi.mock('@/lib/staff-role', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/staff-role')>(), useStaffRole: () => state.role }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('@/v8/restaurant/dashboard/public/use-store-today/index', async () => {
  const { snapshotOf, store } = await import('@/v8/restaurant/booking-kit/test-data')
  const snapshot = snapshotOf({ stores: [store] })
  return { useStoreToday: () => ({ accountId: 'calendar-account', snapshot, store: snapshot.stores[0], tableDefinition: { accountId: 'calendar-account', snapshot }, loading: false, error: null }) }
})
vi.mock('@/lib/api/helpers/styles', () => ({ styleApi: { get: vi.fn().mockResolvedValue({ success: false, error: 'unavailable' }), warnings: vi.fn().mockResolvedValue({ success: true, data: { items: [] } }), starterItems: vi.fn().mockResolvedValue({ success: true, data: { items: [] } }), summary: state.summary, schedule: state.schedule } }))
vi.mock('@/components/shared/preparing-dialog', async importOriginal => ({ ...await importOriginal<typeof import('@/components/shared/preparing-dialog')>(), PREPARING_TITLE: 'preparing', usePreparingDialog: () => ({ open: vi.fn(), dialog: null }) }))
vi.mock('./date-range', async importOriginal => ({ ...await importOriginal<typeof import('./date-range')>(), jstToday: () => '2026-10-21' }))
vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return { ...actual, bookingApi: { ...actual.bookingApi, getPaymentConfig: vi.fn().mockResolvedValue({ data: {} }) }, eventsApi: { ...actual.eventsApi, listBookings: state.bookings } }
})

function fixture(style: IndustryStyle, date = '2026-10-21', range: 'today' | 'week' | 'month' = 'today') {
  const from = `${date}T00:00:00+09:00`, startsAt = `${date}T10:00:00+09:00`, endsAt = `${date}T11:00:00+09:00`
  const booking: StyleBooking = { id: 'real-booking', kind: 'booking', friendId: 'friend-real', personKey: 'friend-real', name: '予約者', startsAt, endsAt, requestedAt: startsAt, status: 'confirmed', staffId: 'staff-real', version: 3, updatedAt: startsAt, menuId: null, storeId: null, slotId: null, partySize: 2, price: 0, visited: false, attendance: null, held: false, meetingMode: null, meetingUrl: null, location: null, outcome: null, source: 'line', entryPoint: null, refCode: null, designation: null, cancelledAt: null, confirmedResponse: null, participationMode: null }
  const snapshot: StyleSnapshot = { style, asOf: startsAt, timeZone: 'Asia/Tokyo', from, to: `${date}T23:59:59+09:00`, dateBasis: 'visit', range, metrics: {}, previous: {}, items: [], newBookings: [], resultId: 'real-result' }
  const schedule: StyleSchedule = { style, asOf: startsAt, from, to: snapshot.to, timeZone: snapshot.timeZone, range, display: 'calendar', calendarView: range === 'today' ? 'day' : range,
    columns: [{ id: 'staff-real', kind: 'staff', name: '担当者' }],
    entries: [{ id: style === 'lesson' ? 'class:slot-real' : 'booking:real-booking', kind: style === 'lesson' ? 'class' : 'booking', ...(style === 'lesson' ? { classId: 'event-real' } : {}), columnIds: ['staff-real'], startsAt, endsAt, title: '朝の予約', booking: style === 'lesson' ? null : booking }],
    days: [{ date, entryIds: [style === 'lesson' ? 'class:slot-real' : 'booking:real-booking'], bookings: 1, people: 2 }], closures: [],
    availability: { status: 'available', reason: null, resources: [], slots: [{ columnId: 'staff-real', menuId: 'menu-real', date, startsAt: `${date}T12:00:00+09:00`, endsAt: `${date}T12:30:00+09:00`, remaining: 1 }], closedDates: [] },
  }
  return { snapshot, schedule }
}
beforeEach(() => {
  vi.clearAllMocks(); state.search = 'view=calendar'; state.role = 'admin'; state.directGuardProbe = false; state.buttons = []
  state.summary.mockImplementation((_account, query) => Promise.resolve({ data: fixture(query.style, query.date, query.range).snapshot }))
  state.schedule.mockImplementation((_account, query) => Promise.resolve({ data: fixture(query.style, query.date, query.range).schedule }))
  state.bookings.mockResolvedValue({ items: [], total: 0, limit: 50, sort: [] })
})
afterEach(cleanup)

it('実画面の月移動は読み込み後に1回だけ滑り、同月の日選択では滑らない', async () => {
  state.search = 'view=calendar&range=month'
  setTestReducedMotion(false)
  document.documentElement.style.setProperty('--motion-base', '200ms')
  document.documentElement.style.setProperty('--polish-space-card', '20px')
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'animate')
  const animate = vi.fn((_frames: Keyframe[], _options: KeyframeAnimationOptions) => ({ cancel: vi.fn() }))
  Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: animate })
  try {
    render(<StyleDashboard style="salon" />)
    const month = await screen.findByRole('region', { name: '1か月のカレンダー' })
    expect(animate).not.toHaveBeenCalled()
    fireEvent.click(within(month).getByRole('button', { name: '次へ', exact: true }))
    await screen.findByRole('region', { name: '1か月のカレンダー' })
    await waitFor(() => expect(animate).toHaveBeenCalledOnce())
    const calendar = screen.getByRole('grid')
    const day = calendar.querySelector<HTMLButtonElement>('[role="gridcell"]:not([data-out]):not([data-selected])')!
    fireEvent.click(day)
    await screen.findByRole('region', { name: '1か月のカレンダー' })
    expect(animate).toHaveBeenCalledOnce()
  } finally {
    if (original) Object.defineProperty(HTMLElement.prototype, 'animate', original)
    else Reflect.deleteProperty(HTMLElement.prototype, 'animate')
    document.documentElement.style.cssText = ''
  }
})

it.each<IndustryStyle>(['restaurant', 'salon', 'consult', 'lesson'])('%sの今日カレンダーに正規day予約を表示し、実予約・教室の名簿へ接続する', async style => {
  render(<StyleDashboard style={style} />)
  const calendar = await screen.findByRole('region', { name: '1日のカレンダー' })
  expect(screen.queryByText('カレンダーに出す予約はまだありません')).toBeNull()
  expect(within(calendar).getByRole('button', { name: '今日' })).toBeTruthy()
  expect(state.schedule).toHaveBeenCalledWith('calendar-account', expect.objectContaining({ style, range: 'today', calendar_view: 'day', display: 'calendar' }))
  const entry = within(calendar).getByRole('button', { name: style === 'lesson' ? '10:00〜11:00 朝の予約' : '10:00〜11:00 朝の予約 予約者' })
  if (style === 'lesson') expect(screen.queryByRole('region', { name: '朝の予約の名簿' })).toBeNull()
  fireEvent.click(entry)
  if (style === 'lesson') {
    expect(await screen.findByRole('region', { name: '朝の予約の名簿' })).toBeTruthy()
    expect(state.bookings).toHaveBeenCalledOnce()
    expect(state.bookings).toHaveBeenCalledWith('calendar-account', 'event-real', { slot_id: 'slot-real', limit: 50, page: 1 }, { signal: expect.any(AbortSignal) })
  } else expect(state.push).toHaveBeenCalledWith(style === 'restaurant' ? '/restaurant-test/reservations?id=real-booking' : '/booking/bookings?booking=real-booking')
})

it('日送りは1日、今日は当日に戻し、週間の送りは7日を保つ', async () => {
  const view = render(<StyleDashboard style="salon" />)
  const calendar = await screen.findByRole('region', { name: '1日のカレンダー' })
  fireEvent.click(within(calendar).getByRole('button', { name: '次へ', exact: true }))
  await waitFor(() => expect(state.schedule).toHaveBeenLastCalledWith('calendar-account', expect.objectContaining({ date: '2026-10-22', range: 'today' })))
  fireEvent.click(within(await screen.findByRole('region', { name: '1日のカレンダー' })).getByRole('button', { name: '今日', exact: true }))
  await waitFor(() => expect(state.schedule).toHaveBeenLastCalledWith('calendar-account', expect.objectContaining({ date: '2026-10-21' })))
  state.search = 'view=calendar&range=week'; view.rerender(<StyleDashboard style="salon" />)
  fireEvent.click(within(await screen.findByRole('region', { name: '1週間のカレンダー' })).getByRole('button', { name: '次へ', exact: true }))
  await waitFor(() => expect(state.schedule).toHaveBeenLastCalledWith('calendar-account', expect.objectContaining({ date: '2026-10-28', calendar_view: 'week' })))
})

it.each<IndustryStyle>(['restaurant', 'salon', 'consult', 'lesson'])('%sの閲覧のみは日予約を読め、空き枠作成を出さない', async style => {
  state.role = 'viewer'
  render(<StyleDashboard style={style} />)
  const calendar = await screen.findByRole('region', { name: '1日のカレンダー' })
  expect(within(calendar).getByRole('button', { name: /10:00〜11:00/ })).toBeTruthy()
  expect(within(calendar).queryByRole('button', { name: /に予約を入れる/ })).toBeNull()
})

it('日表示も実APIの取消記録ID・空き候補を落とさず、週/月のモデルはそのまま保つ', () => {
  const { snapshot, schedule } = fixture('salon')
  const cancelled = { ...schedule.entries[0], id: 'booking:cancelled-real', booking: { ...schedule.entries[0].booking!, status: 'cancelled' } }
  const data = toToday('salon', snapshot, { ...schedule, entries: [...schedule.entries, cancelled] }, '2026-10-21', 'today')
  expect(data.week?.days.map(day => day.date)).toEqual(['2026-10-21'])
  expect(data.week?.title).toBe('10月21日（水）')
  expect(data.week?.entries.map(entry => entry.id)).toEqual(['booking:real-booking', 'booking:cancelled-real'])
  expect(data.week?.free).toEqual([{ day: '2026-10-21', start: '12:00', end: '12:30' }])
  expect(data.month).toBeNull()
  const monthly = fixture('salon', '2026-10-01', 'month')
  expect(toToday('salon', monthly.snapshot, monthly.schedule, '2026-10-01', 'month').week).toBeNull()
  expect(toToday('salon', monthly.snapshot, monthly.schedule, '2026-10-01', 'month').month).toBeTruthy()
})

it.each([
  ['confirmed', false, null, 'confirmed'],
  ['seated', false, null, 'active'],
  ['confirmed', true, null, 'completed'],
  ['requested', false, null, 'pending'],
  ['no_show', false, null, 'no_show'],
] as const)('日週表示も%sの実状態を札へ渡し、予定時刻だけで来店扱いしない', (status, visited, attendance, expected) => {
  const { snapshot, schedule } = fixture('salon')
  const entry = schedule.entries[0]
  const next = { ...schedule, entries: [{ ...entry, booking: { ...entry.booking!, status, visited, attendance } }] }
  expect(toToday('salon', snapshot, next, '2026-10-21', 'today').week?.entries[0].state).toBe(expected)
  expect(toToday('salon', snapshot, next, '2026-10-21', 'today').board?.entries[0].state).toBe(({ confirmed: 'booked', completed: 'done' } as Record<string, string>)[expected] ?? expected)
})

it.each(['phone', 'line', 'manual'])('正規APIの%sを日週の盤へ保ち、電話だけ札と読み上げに出す', source => {
  const { snapshot, schedule } = fixture('salon')
  const first = schedule.entries[0]
  const next = { ...schedule, entries: [{ ...first, booking: { ...first.booking!, source } }] }
  const data = toToday('salon', snapshot, next, '2026-10-21', 'today')
  expect(data.week!.entries[0].source).toBe(source)
  expect(data.board!.entries[0].source).toBe(source)
  render(<><WeekCalendar period="day" week={data.week!} canWrite={false} onMove={() => {}} onSlot={() => {}} onOpen={() => {}} /><StaffBoard board={data.board!} search="" onSearch={() => {}} canWrite={false} entryItems={() => []} onSlot={() => {}} /></>)
  for (const name of ['1日のカレンダー', '台帳の盤']) {
    const region = screen.getByRole('region', { name, exact: true })
    const button = within(region).getByRole('button', { name: /予約者/ })
    expect(!!within(button).queryByText('電話')).toBe(source === 'phone')
    expect(button.getAttribute('aria-description')).toBe(source === 'phone' ? '確定・電話' : '確定')
  }
  expect(screen.queryByRole('button', { name: /予約を入れる/ })).toBeNull()
})

function emptySchedule() {
  state.schedule.mockImplementation((_account, query) => {
    const data = fixture(query.style, query.date, query.range).schedule
    return Promise.resolve({ data: { ...data, entries: [], days: data.days.map(day => ({ ...day, entryIds: [], bookings: 0, people: 0 })) } })
  })
}
it.each(['salon', 'consult'] as const)('%sの空日の案内と予約導線を一覧・盤・日表示で1回だけ出す', async style => {
  emptySchedule()
  for (const view of ['list', 'board', 'calendar']) {
    state.search = 'view=' + view
    const result = render(<StyleDashboard style={style} />)
    await screen.findByText('今日の予約はありません')
    expect(await screen.findAllByRole('button', { name: '予約を入れる', exact: true })).toHaveLength(1)
    if (view === 'calendar') expect(screen.getByRole('region', { name: '1日のカレンダー' })).toBeTruthy()
    if (view === 'board') expect(screen.getByRole('region', { name: '台帳の盤' })).toBeTruthy()
    state.push.mockClear()
    fireEvent.click(screen.getByRole('button', { name: '予約を入れる', exact: true }))
    expect(state.push).toHaveBeenCalledWith('/booking/bookings/new?date=2026-10-21')
    result.unmount()
  }
})
it.each(['salon', 'consult'] as const)('%sの閲覧のみも空日操作を灰色と共通理由で残し、動かさない', async style => {
  state.role = 'viewer'; emptySchedule()
  for (const view of ['list', 'board', 'calendar']) {
    state.search = 'view=' + view
    const result = render(<StyleDashboard style={style} />)
    await screen.findByText('今日の予約はありません')
    const action = await screen.findByRole('button', { name: '予約を入れる', exact: true })
    expect(action.getAttribute('aria-disabled')).toBe('true')
    expect(action.getAttribute('data-permission-locked')).not.toBeNull()
    state.push.mockClear(); fireEvent.click(action)
    expect(state.push).not.toHaveBeenCalled()
    result.unmount()
  }
})
it.each(['list', 'board'])('検索結果0は%sでも予約なしとせず、検索を外せる', async view => {
  state.search = 'view=' + view
  render(<StyleDashboard style="salon" />)
  const searchbox = await screen.findByRole('searchbox') as HTMLInputElement
  await screen.findByText('予約者')
  // 初回の値同期エフェクトを完了してから、検索の時計を進める。
  await act(async () => {})
  expect(searchbox.value).toBe('')
  // SearchField は入力後 300ms に絞り込む。実時間と CPU 負荷に依存させず、通知まで進める。
  vi.useFakeTimers()
  try {
    fireEvent.change(searchbox, { target: { value: '検索に一致しない名前' } })
    expect(searchbox.value).toBe('検索に一致しない名前')
    await act(async () => { await vi.advanceTimersByTimeAsync(299) })
    expect(screen.queryByRole('button', { name: '検索を外す', exact: true })).toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
  } finally {
    vi.useRealTimers()
  }
  const clear = await screen.findByRole('button', { name: '検索を外す', exact: true })
  expect(screen.queryByText('今日の予約はありません')).toBeNull()
  fireEvent.click(clear)
  await waitFor(() => expect(screen.queryByRole('button', { name: '検索を外す', exact: true })).toBeNull())
})
it('取得失敗は空日扱いにせず、非空の閲覧者には頭の予約操作を灰色で示す', async () => {
  state.schedule.mockRejectedValueOnce(new Error('offline'))
  const view = render(<StyleDashboard style="salon" />)
  await screen.findByText('ダッシュボードを読み込めませんでした')
  expect(screen.queryByText('今日の予約はありません')).toBeNull()
  view.unmount(); state.role = 'viewer'
  render(<StyleDashboard style="salon" />)
  await screen.findByRole('region', { name: '1日のカレンダー' })
  expect(screen.queryByText('今日の予約はありません')).toBeNull()
  expect(screen.getByRole('button', { name: '予約を入れる', exact: true }).getAttribute('aria-disabled')).toBe('true')
})
it('盤と日カレンダーのempty口は省略時に案内を足さず、指定した内容だけ1回表示する', () => {
  const { snapshot, schedule } = fixture('salon')
  const data = toToday('salon', snapshot, schedule, '2026-10-21', 'today')
  const renderViews = (empty?: React.ReactNode) => <><WeekCalendar week={data.week!} period="day" canWrite={false} onMove={() => {}} onSlot={() => {}} onOpen={() => {}} empty={empty} /><StaffBoard board={data.board!} search="" onSearch={() => {}} canWrite={false} entryItems={() => []} onSlot={() => {}} empty={empty} /></>
  const view = render(renderViews())
  expect(screen.queryByText('空日の案内')).toBeNull()
  expect(screen.getAllByRole('button', { name: /予約者/ })).toHaveLength(2)
  view.rerender(renderViews(<p>空日の案内</p>))
  expect(screen.getAllByText('空日の案内')).toHaveLength(2)
  view.rerender(renderViews())
  expect(screen.queryByText('空日の案内')).toBeNull()
  expect(screen.getAllByRole('button', { name: /予約者/ })).toHaveLength(2)
})

it.each(['restaurant', 'lesson'] as const)('%sの頭は閲覧のみを灰色と共通理由、未知の役割を理由なしの無効にする', async style => {
  for (const role of ['viewer', null]) {
    state.role = role
    const view = render(<StyleDashboard style={style} />)
    await screen.findByRole('region', { name: '1日のカレンダー' })
    fireEvent.click(screen.getByRole('button', { name: 'その他の操作', exact: true }))
    for (const name of ['LINE を送る', '休みを入れる', '表示を変える', STYLE_CONFIG[style].primary]) {
      const button = screen.queryByRole('button', { name, exact: true }) ?? screen.getByRole('menuitem', { name, exact: true })
      const reasonId = button.getAttribute('aria-describedby')
      if (role === 'viewer') {
        expect(button.hasAttribute('data-permission-locked')).toBe(true)
        expect(document.getElementById(reasonId!)?.textContent).toBe(PERMISSION_LOCK_REASON.viewer)
      } else {
        expect(button.hasAttribute('data-permission-locked')).toBe(false)
        expect(reasonId).toBeNull()
      }
      expect(button.hasAttribute('disabled')).toBe(role === null)
      expect(button.getAttribute('href')).toBeNull()
      fireEvent.click(button)
    }
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(state.push).not.toHaveBeenCalled()
    view.unmount()
  }
})
it('頭と既定の空状態の作成handlerは、共通ButtonやaddNewの守りが無くても閲覧者を止める', async () => {
  state.directGuardProbe = true
  for (const role of ['viewer', null, 'admin']) {
    state.role = role
    for (const empty of [false, true]) {
      state.search = empty ? 'view=list&range=week' : 'view=list'
      if (empty) emptySchedule()
      else state.schedule.mockImplementation((_account, query) => Promise.resolve({ data: fixture(query.style, query.date, query.range).schedule }))
      const view = render(<StyleDashboard style="salon" />)
      if (empty) await screen.findByText('今週の予約はありません')
      else await screen.findByText('予約者')
      const buttons = screen.getAllByRole('button', { name: '予約を入れる', exact: true })
      state.unsafeAddNew.mockClear()
      for (const button of buttons) state.buttons[Number(button.getAttribute('data-test-button-id'))].onClick?.({} as never)
      expect(state.unsafeAddNew).toHaveBeenCalledTimes(role === 'admin' ? buttons.length : 0)
      view.unmount()
    }
  }
})
it('閲覧のみの面談でも予約URLのコピーは許可し、書込みの鍵を付けない', async () => {
  state.role = 'viewer'; state.search = 'view=list&range=week'; emptySchedule()
  const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard'), writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  try {
    render(<StyleDashboard style="consult" />)
    const button = await screen.findByRole('button', { name: '予約 URL をコピー', exact: true })
    expect(button.hasAttribute('disabled')).toBe(false)
    expect(button.hasAttribute('data-permission-locked')).toBe(false)
    fireEvent.click(button)
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/booking`))
  } finally {
    if (original) Object.defineProperty(navigator, 'clipboard', original)
    else Reflect.deleteProperty(navigator, 'clipboard')
  }
})
it('日送りで今日でない日を開いた時は「この日の予約」と示す', async () => {
  emptySchedule()
  render(<StyleDashboard style="salon" />)
  await screen.findByText('今日の予約はありません')
  fireEvent.click(within(await screen.findByRole('region', { name: '1日のカレンダー' })).getByRole('button', { name: '次へ', exact: true }))
  await screen.findByText('この日の予約はありません')
  expect(screen.queryByText('今日の予約はありません')).toBeNull()
})
it('読み込み中は頭の主操作を出さず、空と分かった後に本文へ1つだけ出す', async () => {
  let finish: (value: { data: StyleSchedule }) => void = () => {}
  state.schedule.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
  render(<StyleDashboard style="salon" />)
  expect(screen.queryByRole('button', { name: '予約を入れる', exact: true })).toBeNull()
  const data = fixture('salon').schedule
  finish({ data: { ...data, entries: [], days: data.days.map(day => ({ ...day, entryIds: [], bookings: 0, people: 0 })) } })
  await screen.findByText('今日の予約はありません')
  expect(await screen.findAllByRole('button', { name: '予約を入れる', exact: true })).toHaveLength(1)
})
it('取消だけの日も記録は消さず、有効な予約がない案内と作成入口を1回残す', async () => {
  state.schedule.mockImplementation((_account, query) => {
    const data = fixture(query.style, query.date, query.range).schedule
    return Promise.resolve({ data: { ...data, entries: data.entries.map(entry => ({ ...entry, booking: { ...entry.booking!, status: 'cancelled' } })) } })
  })
  for (const view of ['list', 'board', 'calendar']) {
    state.search = 'view=' + view
    const result = render(<StyleDashboard style="salon" />)
    await screen.findByText('今日の予約はありません')
    expect(screen.getByText(/取消などの記録は下で確認できます/)).toBeTruthy()
    expect(await screen.findAllByRole('button', { name: '予約を入れる', exact: true })).toHaveLength(1)
    expect(screen.getAllByText(/予約者/).length).toBeGreaterThan(0)
    result.unmount()
  }
})

it.each([
  { status: 'available', value: 0, expected: 0 },
  { status: 'available', value: 3, expected: 3 },
  { status: 'available', value: null, expected: null },
  { status: 'unconfigured', value: 0, expected: null },
  { status: 'insufficient_sample', value: 2, expected: null },
] as const)('教室の予約実集計は$status/$valueを$expectedとして渡す', ({ status, value, expected }) => {
  const { snapshot, schedule } = fixture('lesson')
  snapshot.metrics.bookings = { value, status, unit: '件' }
  expect(toToday('lesson', snapshot, schedule, '2026-10-21', 'today').bookingCount).toBe(expected)
  delete snapshot.metrics.bookings
  expect(toToday('lesson', snapshot, schedule, '2026-10-21', 'today').bookingCount).toBeNull()
})
function lessonDay(noClasses: boolean, count: number | null) {
  state.summary.mockImplementation((_account, query) => {
    const data = fixture(query.style, query.date, query.range).snapshot
    data.metrics.bookings = { value: count, status: count === null ? 'unconfigured' : 'available', unit: '件' }
    return Promise.resolve({ data })
  })
  if (noClasses) emptySchedule()
}
it.each(['list', 'board', 'calendar'])('教室の%sはクラス無しと会員予約0を分け、正しい入口を1回だけ出す', async view => {
  for (const noClasses of [true, false]) {
    lessonDay(noClasses, 0); state.search = 'view=' + view
    if (!noClasses) state.schedule.mockImplementation((_account, query) => Promise.resolve({ data: fixture(query.style, query.date, query.range).schedule }))
    const result = render(<StyleDashboard style="lesson" />)
    const title = noClasses ? '今日のクラスはありません' : '今日の予約はありません'
    await screen.findByText(title)
    expect(screen.getAllByText(title)).toHaveLength(1)
    expect(screen.queryByText(noClasses ? '今日の予約はありません' : '今日のクラスはありません')).toBeNull()
    const button = await screen.findByRole('button', { name: noClasses ? 'クラスを作る' : '会員を予約する', exact: true })
    expect(screen.getAllByRole('button', { name: /^(クラスを作る|会員を予約する)$/ })).toHaveLength(1)
    if (!noClasses) {
      expect(screen.getAllByText(/朝の予約/).length).toBeGreaterThan(0)
      if (view === 'calendar') fireEvent.click(screen.getByRole('button', { name: '10:00〜11:00 朝の予約', exact: true }))
      else if (view === 'list') fireEvent.click(screen.getByRole('button', { name: '朝の予約', exact: true }))
      if (view !== 'board') {
        await screen.findByRole('region', { name: '朝の予約の名簿' })
        expect(state.bookings).toHaveBeenCalledWith('calendar-account', 'event-real', { slot_id: 'slot-real', limit: 50, page: 1 }, { signal: expect.any(AbortSignal) })
      }
    }
    state.push.mockClear(); fireEvent.click(button)
    expect(state.push).toHaveBeenCalledWith(noClasses ? '/events/new' : '/events')
    result.unmount()
  }
})
it.each(['list', 'board', 'calendar'])('教室の%sも閲覧のみと役割未取得の空状態操作を止める', async view => {
  for (const noClasses of [true, false]) for (const role of ['viewer', null]) {
    lessonDay(noClasses, 0); state.search = 'view=' + view; state.role = role
    if (!noClasses) state.schedule.mockImplementation((_account, query) => Promise.resolve({ data: fixture(query.style, query.date, query.range).schedule }))
    const result = render(<StyleDashboard style="lesson" />)
    const button = await screen.findByRole('button', { name: noClasses ? 'クラスを作る' : '会員を予約する', exact: true })
    expect(button.hasAttribute('data-permission-locked')).toBe(role === 'viewer')
    expect(button.hasAttribute('disabled')).toBe(role === null)
    expect(button.getAttribute('aria-describedby') !== null).toBe(role === 'viewer')
    state.push.mockClear(); fireEvent.click(button)
    expect(state.push).not.toHaveBeenCalled()
    result.unmount()
  }
})
it.each([null, 2])('教室の予約数%sなら既存の回を保ち、予約0の主張をしない', async count => {
  lessonDay(false, count)
  render(<StyleDashboard style="lesson" />)
  await screen.findByRole('region', { name: '1日のカレンダー' })
  expect(screen.getByRole('button', { name: '10:00〜11:00 朝の予約', exact: true })).toBeTruthy()
  expect(screen.queryByText('今日の予約はありません')).toBeNull()
  expect(screen.queryByText('今日のクラスはありません')).toBeNull()
  expect(screen.getAllByRole('button', { name: '会員を予約する', exact: true })).toHaveLength(1)
})
it('教室の取得失敗もクラス無しと誤認せず、翌日はこの日のクラスと示す', async () => {
  state.schedule.mockRejectedValueOnce(new Error('offline'))
  const result = render(<StyleDashboard style="lesson" />)
  await screen.findByText('ダッシュボードを読み込めませんでした')
  expect(screen.queryByText('今日のクラスはありません')).toBeNull()
  result.unmount(); lessonDay(true, 0)
  render(<StyleDashboard style="lesson" />)
  await screen.findByText('今日のクラスはありません')
  fireEvent.click(within(await screen.findByRole('region', { name: '1日のカレンダー' })).getByRole('button', { name: '次へ', exact: true }))
  await screen.findByText('この日のクラスはありません')
})

it('教室の日送りは選択日のsummaryを取り直し、今日0件を翌日の予約数へ持ち越さない', async () => {
  state.summary.mockImplementation((_account, query) => {
    const data = fixture(query.style, query.date, query.range).snapshot
    data.metrics.bookings = { value: query.date === '2026-10-21' ? 0 : 2, status: 'available', unit: '件' }
    return Promise.resolve({ data })
  })
  render(<StyleDashboard style="lesson" />)
  await screen.findByText('今日の予約はありません')
  fireEvent.click(within(await screen.findByRole('region', { name: '1日のカレンダー' })).getByRole('button', { name: '次へ', exact: true }))
  await waitFor(() => expect(state.summary).toHaveBeenLastCalledWith('calendar-account', expect.objectContaining({ style: 'lesson', date: '2026-10-22', range: 'today' })))
  await waitFor(() => expect(screen.queryByText('今日の予約はありません')).toBeNull())
  await screen.findByRole('button', { name: '10:00〜11:00 朝の予約', exact: true })
  expect(screen.queryByText('この日の予約はありません')).toBeNull()
  expect(screen.queryByText('この日のクラスはありません')).toBeNull()
  expect(screen.getAllByRole('button', { name: '会員を予約する', exact: true })).toHaveLength(1)
})

it.each<IndustryStyle>(['lesson', 'salon', 'consult', 'restaurant'])('%sのクラスも空きもない日の補足は教室だけクラスなしにする', style => {
  const { snapshot, schedule } = fixture(style)
  schedule.entries = []; schedule.availability.slots = []
  const day = toToday(style, snapshot, schedule, '2026-10-21', 'today').week!.days[0]
  expect(day.sub).toBe(style === 'lesson' ? 'クラスなし' : '満')
})
it('教室のクラスがあって空きがない日は満、空きがある日は空きを保つ', () => {
  const { snapshot, schedule } = fixture('lesson')
  schedule.availability.slots = []
  expect(toToday('lesson', snapshot, schedule, '2026-10-21', 'today').week!.days[0].sub).toBe('満')
  schedule.availability.slots = fixture('lesson').schedule.availability.slots
  expect(toToday('lesson', snapshot, schedule, '2026-10-21', 'today').week!.days[0].sub).toBe('空き 1')
  schedule.entries = []
  expect(toToday('lesson', snapshot, schedule, '2026-10-21', 'today').week!.days[0].sub).toBe('空き 1')
})
it('教室の週は日ごとのクラスを判定し、休業日と日またぎの回も保つ', () => {
  const { snapshot, schedule } = fixture('lesson', '2026-10-21', 'week')
  schedule.availability.slots = []
  schedule.days.push({ date: '2026-10-22', entryIds: [], bookings: 0, people: 0 })
  const weekdays = () => toToday('lesson', snapshot, schedule, '2026-10-21', 'week').week!.days.map(day => day.sub)
  expect(weekdays()).toEqual(['満', 'クラスなし'])
  schedule.availability.closedDates = ['2026-10-22']
  expect(weekdays()).toEqual(['満', '定休日'])
  schedule.availability.closedDates = []
  schedule.entries[0].startsAt = '2026-10-21T23:00:00+09:00'
  schedule.entries[0].endsAt = '2026-10-22T01:00:00+09:00'
  expect(weekdays()).toEqual(['満', '満'])
  schedule.entries[0].endsAt = '2026-10-22T00:00:00+09:00'
  expect(weekdays()).toEqual(['満', 'クラスなし'])
})


it.each([true, false])('月表示の休み操作の案内は編集可否 %s に合う', canWrite => {
  const month = { title: '11月', days: [], selected: { title: '11月1日', total: '0件', rows: [], moreLabel: '一覧へ' } }
  render(<DayList month={month} href="/bookings" canWrite={canWrite} />)
  expect(screen.getByText(/日を押すと、その日の予約がここに出ます/)).toBeTruthy()
  expect(Boolean(screen.queryByText(/休みは［休みを入れる］から/))).toBe(canWrite)
})
