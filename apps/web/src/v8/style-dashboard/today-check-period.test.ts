/* 「今日の確認」の組み立て：見出しの期間の言葉を数えた期間に合わせる・閉じた要約・予約元の名前。 */
import { describe, expect, it } from 'vitest'
import type { StyleBooking, StyleSchedule, StyleSnapshot } from '@line-crm/shared'
import { newBookingsPeriod, periodWord, sideSourceName, toToday } from './adapter'
import type { DashboardRange, IndustryStyle } from './model'

const now = new Date('2026-11-24T10:00:00+09:00')
const periodOf = (fromDate: string, toDate: string, range: DashboardRange) => ({ from: `${fromDate}T00:00:00+09:00`, to: `${toDate}T00:00:00+09:00`, range })

const booking = (id: string, requestedAt: string): StyleBooking => ({
  id, version: 1, updatedAt: null, kind: 'booking', friendId: null, personKey: id, name: `見本 ${id}`, startsAt: '2026-11-24T19:00:00+09:00', endsAt: '2026-11-24T20:00:00+09:00',
  requestedAt, status: 'confirmed', staffId: null, menuId: null, storeId: null, slotId: null, partySize: 1, price: 0, visited: false, attendance: null, held: false,
  meetingMode: null, meetingUrl: null, location: null, outcome: null, source: 'liff', entryPoint: null, refCode: null, designation: null, cancelledAt: null,
  confirmedResponse: null, participationMode: null,
})

const snapshotOf = (style: IndustryStyle, range: DashboardRange, fromDate: string, toDate: string, newBookings: StyleBooking[] = []): StyleSnapshot => ({
  style, asOf: now.toISOString(), timeZone: 'Asia/Tokyo', ...periodOf(fromDate, toDate, range), dateBasis: 'visit', metrics: {}, previous: {}, items: [], newBookings, resultId: 'qa',
})
const scheduleOf = (style: IndustryStyle, range: DashboardRange, fromDate: string, toDate: string, status: 'available' | 'unavailable' = 'available', slots: unknown[] = []): StyleSchedule => ({
  style, asOf: now.toISOString(), timeZone: 'Asia/Tokyo', ...periodOf(fromDate, toDate, range), display: 'list', calendarView: 'day',
  columns: [{ id: 's1', kind: 'staff', name: '山田' }], entries: [], days: [], closures: [],
  availability: { status, reason: null, resources: [], slots, closedDates: [] },
} as unknown as StyleSchedule)

describe('見出しの期間の言葉', () => {
  it('今を含む期間は「今日・今週・今月」、過去や先の期間は「この日・この週・この月」', () => {
    expect(newBookingsPeriod(periodOf('2026-11-24', '2026-11-25', 'today'), 'today', now)).toBe('今日入った')
    expect(newBookingsPeriod(periodOf('2026-11-20', '2026-11-21', 'today'), 'today', now)).toBe('この日に入った')
    expect(newBookingsPeriod(periodOf('2026-11-30', '2026-12-01', 'today'), 'today', now)).toBe('この日に入った')
    expect(newBookingsPeriod(periodOf('2026-11-23', '2026-11-30', 'week'), 'week', now)).toBe('今週入った')
    expect(newBookingsPeriod(periodOf('2026-11-16', '2026-11-23', 'week'), 'week', now)).toBe('この週に入った')
    expect(newBookingsPeriod(periodOf('2026-11-01', '2026-12-01', 'month'), 'month', now)).toBe('今月入った')
    expect(newBookingsPeriod(periodOf('2026-10-01', '2026-11-01', 'month'), 'month', now)).toBe('この月に入った')
  })

  it('範囲は数えた元（口が返した範囲）を使い、読めない期間は「今日」と言い切らない', () => {
    expect(newBookingsPeriod(periodOf('2026-11-23', '2026-11-30', 'week'), 'today', now)).toBe('今週入った')
    expect(periodWord({ from: 'x', to: 'y', range: 'today' }, 'today', now)).toEqual({ word: 'この日', current: false })
    expect(periodWord({ from: '2026-11-24T00:00:00+09:00', to: '2026-11-25T00:00:00+09:00', range: 'other' }, 'week', now)).toEqual({ word: '今週', current: true })
    // 期間の終わりちょうどは含まない（半開区間）。
    expect(periodWord({ from: '2026-11-23T10:00:00+09:00', to: '2026-11-24T10:00:00+09:00', range: 'today' }, 'today', now).current).toBe(false)
  })

  it('右の列の新着予約と面談の空きの見出しは、それぞれ数えた期間に合わせる', () => {
    const past = toToday('consult', snapshotOf('consult', 'today', '2026-11-20', '2026-11-21'), scheduleOf('consult', 'today', '2026-11-20', '2026-11-21'), '2026-11-20', 'today', now)
    expect(past.side.map((card) => card.title)).toEqual(['新着予約（この日に入った）', 'お支払い（今日）', 'この日の空き'])
    const week = toToday('consult', snapshotOf('consult', 'week', '2026-11-23', '2026-11-30'), scheduleOf('consult', 'week', '2026-11-23', '2026-11-30'), '2026-11-24', 'week', now)
    expect(week.side.map((card) => card.title)).toEqual(['新着予約（今週入った）', 'お支払い（今日）', '今週の空き'])
  })
})

describe('閉じた時の要約', () => {
  it('新着予約は件数と予約が入った新しい順の最新1件、0件は灰色の「なし」。取れない項目は灰色の「—」', () => {
    const side = toToday('salon', snapshotOf('salon', 'today', '2026-11-24', '2026-11-25', [booking('a', '2026-11-24T08:00:00+09:00'), booking('b', '2026-11-24T09:30:00+09:00')]), scheduleOf('salon', 'today', '2026-11-24', '2026-11-25'), '2026-11-24', 'today', now).side
    expect(side.find((card) => card.id === 'new')?.summary).toEqual({ text: '2 件・最新 11/24 19:00 見本 bさま' })
    expect(side.find((card) => card.id === 'new')?.count).toBe(2)
    expect(side.find((card) => card.id === 'pay')?.summary).toEqual({ text: '—', empty: true })
    expect(side.find((card) => card.id === 'rebook')?.summary).toEqual({ text: '—', empty: true })
    const none = toToday('salon', snapshotOf('salon', 'today', '2026-11-24', '2026-11-25'), scheduleOf('salon', 'today', '2026-11-24', '2026-11-25'), '2026-11-24', 'today', now).side
    expect(none.find((card) => card.id === 'new')?.summary).toEqual({ text: 'なし', empty: true })
  })

  it('面談の空きは、空き0は「なし」、空きを出せない時は「—」（開いた中身は理由の文）', () => {
    const zero = toToday('consult', snapshotOf('consult', 'today', '2026-11-24', '2026-11-25'), scheduleOf('consult', 'today', '2026-11-24', '2026-11-25'), '2026-11-24', 'today', now).side.find((card) => card.id === 'free')!
    expect(zero.summary).toEqual({ text: 'なし', empty: true })
    expect(zero.rows[0].label).toBe('空きはありません')
    const unknown = toToday('consult', snapshotOf('consult', 'today', '2026-11-24', '2026-11-25'), scheduleOf('consult', 'today', '2026-11-24', '2026-11-25', 'unavailable'), '2026-11-24', 'today', now).side.find((card) => card.id === 'free')!
    expect(unknown.summary).toEqual({ text: '—', empty: true })
    expect(unknown.rows[0].label).toBe('空きを出せません')
    const slot = { columnId: 's1', menuId: null, date: '2026-11-24', startsAt: '2026-11-24T13:00:00+09:00', endsAt: '2026-11-24T14:00:00+09:00', remaining: 1 }
    const free = toToday('consult', snapshotOf('consult', 'today', '2026-11-24', '2026-11-25'), scheduleOf('consult', 'today', '2026-11-24', '2026-11-25', 'available', [slot]), '2026-11-24', 'today', now).side.find((card) => card.id === 'free')!
    expect(free.summary).toEqual({ text: '山田 13:00〜14:00' })
  })
})

describe('予約元の名前', () => {
  it('飲食は予約台帳の言葉（手入力＝手動・Google）、台帳に無い値とほかの業種は共通の札に任せる', () => {
    expect(sideSourceName('restaurant', 'manual')).toBe('手動')
    expect(sideSourceName('restaurant', 'google_business_profile')).toBe('Google')
    expect(sideSourceName('restaurant', 'phone')).toBe('電話')
    expect(sideSourceName('restaurant', 'walk_in')).toBeUndefined()
    expect(sideSourceName('restaurant', '')).toBeUndefined()
    expect(sideSourceName('salon', 'manual')).toBeUndefined()
    expect(sideSourceName('consult', 'liff')).toBeUndefined()
  })
})
