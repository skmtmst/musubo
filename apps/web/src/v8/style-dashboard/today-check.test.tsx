// @vitest-environment happy-dom
/* 業種ダッシュボードの右の列「今日の確認」：初回の開き方・本人／アカウント／スタイルごとの開き方の保存・権限・予約元の札。 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StyleBooking, StyleSchedule, StyleSnapshot } from '@line-crm/shared'
import type { IndustryStyle, StyleSideCard } from './model'
import { toToday } from './adapter'
import { TodayCheck } from './today-check'
import { todayCheckStorageKey } from './use-today-check-open'

const identity = vi.hoisted(() => ({ current: { id: 'staff-a' } as { id: string } | null }))
vi.mock('@/lib/staff-role', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/staff-role')>(),
  useStaffIdentity: () => identity.current,
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => '/', useSearchParams: () => new URLSearchParams() }))
vi.mock('next/link', () => ({ default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => <a href={href} {...rest}>{children}</a> }))

const day = '2026-11-24'
const from = `${day}T00:00:00+09:00`
const to = '2026-11-25T00:00:00+09:00'
const now = new Date(`${day}T10:00:00+09:00`)

const booking = (id: string, source: string, requestedAt: string, startsAt = `${day}T19:00:00+09:00`, name = `見本 ${id}`): StyleBooking => ({
  id, version: 1, updatedAt: null, kind: 'restaurant', friendId: null, personKey: id, name, startsAt, endsAt: startsAt, requestedAt,
  status: 'confirmed', staffId: null, menuId: null, storeId: null, slotId: null, partySize: 2, price: 0, visited: false, attendance: null,
  held: false, meetingMode: null, meetingUrl: null, location: null, outcome: null, source, entryPoint: null, refCode: null, designation: null,
  cancelledAt: null, confirmedResponse: null, participationMode: null,
})

const snapshotOf = (style: IndustryStyle, newBookings: StyleBooking[]): StyleSnapshot => ({
  style, asOf: now.toISOString(), timeZone: 'Asia/Tokyo', from, to, dateBasis: 'visit', range: 'today', metrics: {}, previous: {}, items: [], newBookings, resultId: 'qa',
})
const schedule = (style: IndustryStyle): StyleSchedule => ({
  style, asOf: now.toISOString(), timeZone: 'Asia/Tokyo', range: 'today', display: 'list', calendarView: 'day', from, to,
  columns: [{ id: 's1', kind: 'staff', name: '担当' }], entries: [], days: [], closures: [],
  availability: { status: 'available', reason: null, resources: [], slots: [], closedDates: [] },
} as unknown as StyleSchedule)
const sideOf = (style: IndustryStyle, newBookings: StyleBooking[]) => toToday(style, snapshotOf(style, newBookings), schedule(style), day, 'today', now).side

const WITH_NEW = [
  booking('1', 'line', `${day}T09:05:00+09:00`),
  booking('2', 'manual', `${day}T09:40:00+09:00`),
  booking('3', 'google_business_profile', `${day}T08:20:00+09:00`),
  booking('4', 'hotpepper', `${day}T07:00:00+09:00`),
]

function Check({ cards, accountId = 'account-1', style = 'restaurant', canWrite = true, onAction = () => {} }: {
  cards: StyleSideCard[]; accountId?: string | null; style?: IndustryStyle; canWrite?: boolean; onAction?: (card: StyleSideCard) => void
}) {
  return <TodayCheck cards={cards} accountId={accountId} style={style} canWrite={canWrite} onAction={onAction} />
}

const NEW = '新着予約（今日入った）'
const item = (title: string) => screen.getByRole('button', { name: title })
const expanded = (title: string) => item(title).getAttribute('aria-expanded') === 'true'
const openTitles = () => screen.getAllByRole('button').filter((button) => button.getAttribute('aria-expanded') === 'true' && button.hasAttribute('data-disclosure-toggle')).map((button) => button.textContent)

beforeEach(() => {
  window.localStorage.clear()
  identity.current = { id: 'staff-a' }
})
afterEach(cleanup)

describe('今日の確認：初回の開き方', () => {
  it('覚えた値が無ければ、新着予約があるときは新着予約だけを開く', () => {
    render(<Check cards={sideOf('restaurant', WITH_NEW)} />)
    expect(screen.getByRole('region', { name: '今日の確認' })).toBeTruthy()
    expect(openTitles()).toEqual([NEW])
    expect(expanded('お支払い（今日）')).toBe(false)
    expect(expanded('今日気をつけること')).toBe(false)
    expect(expanded('席のキャンセル待ち')).toBe(false)
  })

  it('新着予約が0件なら全部閉じ、閉じた要約は灰色の「なし」。取れない項目は灰色の「—」', () => {
    render(<Check cards={sideOf('restaurant', [])} />)
    expect(openTitles()).toEqual([])
    const fresh = item(NEW).closest('section')!
    expect(within(fresh).getByText('なし').closest('p')?.hasAttribute('data-empty')).toBe(true)
    for (const title of ['お支払い（今日）', '今日気をつけること', '席のキャンセル待ち']) {
      expect(within(item(title).closest('section')!).getByText('—').closest('p')?.hasAttribute('data-empty')).toBe(true)
    }
  })

  it('閉じた新着予約の要約は本当の件数と、予約が入った新しい順の最新1件', () => {
    const view = render(<Check cards={sideOf('restaurant', WITH_NEW)} />)
    fireEvent.click(item(NEW))
    const fresh = item(NEW).closest('section')!
    const summary = within(fresh).getByText(/^4 件・最新/)
    expect(summary.textContent).toBe('4 件・最新 11/24 19:00 見本 2さま 2 名')
    expect(summary.closest('p')?.hasAttribute('data-empty')).toBe(false)
    view.unmount()
  })
})

describe('今日の確認：開き方の保存', () => {
  it('開閉を本人・アカウント・スタイルの組で覚え、開き直しても同じ形に戻す', () => {
    const cards = sideOf('restaurant', WITH_NEW)
    const view = render(<Check cards={cards} />)
    fireEvent.click(item('今日気をつけること'))
    fireEvent.click(item(NEW))
    expect(openTitles()).toEqual(['今日気をつけること'])
    expect(JSON.parse(window.localStorage.getItem(todayCheckStorageKey('staff-a', 'account-1', 'restaurant'))!)).toEqual({ v: 1, open: ['care'] })
    view.unmount()
    render(<Check cards={cards} />)
    expect(openTitles()).toEqual(['今日気をつけること'])
  })

  it('本人・アカウント・スタイルのどれかが変われば、前の人や店の開き方を使わず、それぞれの覚えに切り替える', () => {
    const cards = sideOf('restaurant', WITH_NEW)
    const view = render(<Check cards={cards} />)
    fireEvent.click(item('お支払い（今日）'))
    expect(openTitles()).toEqual([NEW, 'お支払い（今日）'])

    identity.current = { id: 'staff-b' }
    view.rerender(<Check cards={cards} />)
    expect(openTitles()).toEqual([NEW])
    fireEvent.click(item(NEW))
    expect(openTitles()).toEqual([])

    view.rerender(<Check cards={cards} accountId="account-2" />)
    expect(openTitles()).toEqual([NEW])

    const salon = sideOf('salon', [])
    view.rerender(<Check cards={salon} accountId="account-2" style="salon" />)
    expect(openTitles()).toEqual([])
    fireEvent.click(item('次回予約がまだ'))
    expect(openTitles()).toEqual(['次回予約がまだ'])

    identity.current = { id: 'staff-a' }
    view.rerender(<Check cards={cards} />)
    expect(openTitles()).toEqual([NEW, 'お支払い（今日）'])
    expect(JSON.parse(window.localStorage.getItem(todayCheckStorageKey('staff-b', 'account-1', 'restaurant'))!).open).toEqual([])
    expect(JSON.parse(window.localStorage.getItem(todayCheckStorageKey('staff-b', 'account-2', 'salon'))!).open).toEqual(['rebook'])
    expect(window.localStorage.getItem(todayCheckStorageKey('staff-b', 'account-2', 'restaurant'))).toBeNull()
  })

  it('本人が分からない間は覚えた値を読まず書きもせず、押したとおりにだけ開閉する', () => {
    const cards = sideOf('restaurant', WITH_NEW)
    window.localStorage.setItem(todayCheckStorageKey('staff-a', 'account-1', 'restaurant'), JSON.stringify({ v: 1, open: ['waitlist'] }))
    identity.current = null
    const view = render(<Check cards={cards} />)
    expect(openTitles()).toEqual([NEW])
    fireEvent.click(item('今日気をつけること'))
    expect(openTitles()).toEqual([NEW, '今日気をつけること'])
    expect(window.localStorage.length).toBe(1)

    identity.current = { id: 'staff-a' }
    view.rerender(<Check cards={cards} />)
    expect(openTitles()).toEqual(['席のキャンセル待ち'])
  })

  it('アカウントが分からない間も読まず書かない。形の違う・壊れた値は無かったことにする', () => {
    const cards = sideOf('restaurant', WITH_NEW)
    const view = render(<Check cards={cards} accountId={null} />)
    fireEvent.click(item('お支払い（今日）'))
    expect(window.localStorage.length).toBe(0)
    view.unmount()
    for (const raw of ['{', JSON.stringify({ v: 2, open: ['pay'] }), JSON.stringify({ v: 1, open: [1] }), JSON.stringify(['pay'])]) {
      window.localStorage.setItem(todayCheckStorageKey('staff-a', 'account-1', 'restaurant'), raw)
      const next = render(<Check cards={cards} />)
      expect(openTitles()).toEqual([NEW])
      next.unmount()
    }
  })

  it('キーボードで開閉しても同じように覚える（開閉はネイティブのボタン）', () => {
    const cards = sideOf('restaurant', WITH_NEW)
    render(<Check cards={cards} />)
    const care = item('今日気をつけること')
    care.focus()
    expect(document.activeElement).toBe(care)
    fireEvent.click(care, { detail: 0 })
    expect(document.activeElement).toBe(care)
    expect(expanded('今日気をつけること')).toBe(true)
    expect(JSON.parse(window.localStorage.getItem(todayCheckStorageKey('staff-a', 'account-1', 'restaurant'))!).open).toEqual(['new', 'care'])
  })
})

describe('今日の確認：権限と行き先', () => {
  it('書ける人には書く操作を出し、閉じた時は見出しの右、開くと明細の下に置く。押すと開閉せず操作だけを呼ぶ', () => {
    const onAction = vi.fn()
    render(<Check cards={sideOf('restaurant', WITH_NEW)} onAction={onAction} />)
    const pay = item('お支払い（今日）').closest('section')!
    const headAction = within(pay).getByRole('button', { name: 'お支払いを見る' })
    expect(headAction.closest('[data-disclosure-action]')?.getAttribute('data-disclosure-action')).toBe('head')
    fireEvent.click(headAction)
    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ id: 'pay' }))
    expect(expanded('お支払い（今日）')).toBe(false)

    fireEvent.click(item('お支払い（今日）'))
    const footAction = within(pay).getByRole('button', { name: 'お支払いを見る' })
    expect(footAction.closest('[data-disclosure-action]')?.getAttribute('data-disclosure-action')).toBe('foot')
    const detail = within(pay).getByText('今日の入金・未払い・返金')
    expect(detail.compareDocumentPosition(footAction) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    fireEvent.click(item('今日気をつけること'))
    const care = item('今日気をつけること').closest('section')!
    expect(within(care).getByRole('button', { name: 'くわしく見る' }).closest('[data-disclosure-action]')?.getAttribute('data-disclosure-action')).toBe('foot')
  })

  it('閲覧のみ・役割の確認中（書けない）は書く操作を出さず、一覧へのリンクは残す', () => {
    render(<Check cards={sideOf('restaurant', WITH_NEW)} canWrite={false} />)
    for (const title of ['お支払い（今日）', '今日気をつけること', '席のキャンセル待ち']) fireEvent.click(item(title))
    for (const name of ['お支払いを見る', 'くわしく見る', '空きを知らせる']) expect(screen.queryByRole('button', { name })).toBeNull()
    expect(screen.getByRole('link', { name: '一覧' }).getAttribute('href')).toBe('/restaurant-test/reservations')
  })
})

describe('今日の確認：予約元の札', () => {
  it('飲食は予約台帳と同じ言葉（手入力＝手動・Google）で出し、電話と誤って出さない', () => {
    render(<Check cards={sideOf('restaurant', WITH_NEW)} />)
    const fresh = item(NEW).closest('section')!
    const sources = Array.from(fresh.querySelectorAll('[data-source]')).map((node) => [node.getAttribute('data-source'), node.textContent])
    expect(sources).toEqual([['manual', '手動'], ['line', 'LINE'], ['google_business_profile', 'Google']])
    expect(within(fresh).queryByText('電話')).toBeNull()
    expect(within(fresh).getByText('ほか 1 件は一覧で見られます')).toBeTruthy()
  })

  it('ほかの業種は共通の札の言葉、経路を返さない予約（教室の申込など）には札を出さない', () => {
    const salon = [booking('s1', 'liff', `${day}T09:00:00+09:00`), booking('s2', 'operator', `${day}T08:00:00+09:00`)]
    const view = render(<Check style="salon" cards={sideOf('salon', salon)} />)
    expect(Array.from(document.querySelectorAll('[data-source]')).map((node) => node.textContent)).toEqual(['LINE', '手入力'])
    view.unmount()
    render(<Check style="lesson" cards={sideOf('lesson', [booking('l1', '', `${day}T09:00:00+09:00`)])} />)
    expect(document.querySelectorAll('[data-source]')).toHaveLength(0)
    expect(screen.queryByText('経路不明')).toBeNull()
  })
})


describe('今日の確認のカード全体の開閉', () => {
  it('畳むと確かな正の件数だけを札にし、開くと内容に戻る', () => {
    const cards: StyleSideCard[] = [
      { id: 'new', title: '新着予約', rows: [], count: 3, summary: { text: '3件' } },
      { id: 'pay', title: 'お支払い', rows: [], summary: { text: '未払い 2件' } },
      { id: 'care', title: '今日気をつけること', rows: [], summary: { text: '1件' } },
      { id: 'waitlist', title: '席のキャンセル待ち', rows: [], summary: { text: '2人' } },
    ]
    render(<Check cards={cards} />)
    const panel = screen.getByRole('region', { name: '今日の確認' })
    fireEvent.click(within(panel).getByRole('button', { name: '畳む' }))
    expect(within(panel).queryByRole('button', { name: '新着予約' })).toBeNull()
    expect(within(panel).getByText('新着 3').closest('[data-tone]')?.getAttribute('data-tone')).toBe('danger')
    expect(within(panel).getByText('お支払い 2')).toBeTruthy()
    expect(within(panel).getByText('注意 1')).toBeTruthy()
    expect(within(panel).getByText('キャンセル待ち 2')).toBeTruthy()
    fireEvent.click(within(panel).getByRole('button', { name: '開く' }))
    expect(within(panel).getByRole('button', { name: '新着予約' })).toBeTruthy()
    expect(within(panel).queryByText('新着 3')).toBeNull()
  })

  it('畳んだ状態を本人・アカウント・スタイルごとに覚える', () => {
    const cards = sideOf('restaurant', WITH_NEW)
    const view = render(<Check cards={cards} />)
    fireEvent.click(within(screen.getByRole('region', { name: '今日の確認' })).getByRole('button', { name: '畳む' }))
    view.unmount()
    const next = render(<Check cards={cards} />)
    expect(within(screen.getByRole('region', { name: '今日の確認' })).getByRole('button', { name: '開く' })).toBeTruthy()
    next.rerender(<Check cards={cards} accountId="account-2" />)
    expect(within(screen.getByRole('region', { name: '今日の確認' })).getByRole('button', { name: '畳む' })).toBeTruthy()
    next.rerender(<Check cards={cards} accountId="account-1" style="salon" />)
    expect(within(screen.getByRole('region', { name: '今日の確認' })).getByRole('button', { name: '畳む' })).toBeTruthy()
    identity.current = { id: 'staff-b' }
    next.rerender(<Check cards={cards} accountId="account-1" style="restaurant" />)
    expect(within(screen.getByRole('region', { name: '今日の確認' })).getByRole('button', { name: '畳む' })).toBeTruthy()
  })
})


it('0件・欠測・数え方を特定できない要約には札を出さない', () => {
  const cards: StyleSideCard[] = [
    { id: 'new', title: '新着予約', rows: [], count: 0, summary: { text: 'なし', empty: true } },
    { id: 'pay', title: 'お支払い', rows: [], summary: { text: '—', empty: true } },
    { id: 'care', title: '今日気をつけること', rows: [], summary: { text: '0件' } },
    { id: 'waitlist', title: '席のキャンセル待ち', rows: [], summary: { text: '2件・未確認 —' } },
  ]
  render(<Check cards={cards} />)
  const panel = screen.getByRole('region', { name: '今日の確認' })
  fireEvent.click(within(panel).getByRole('button', { name: '畳む' }))
  expect(panel.querySelectorAll('[data-tone="danger"]')).toHaveLength(0)
})
