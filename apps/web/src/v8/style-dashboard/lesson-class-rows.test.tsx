// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { StyleBooking, StyleSchedule, StyleSnapshot } from '@line-crm/shared'
import { toToday } from './adapter'
import { TodayList } from './today-list'

const date = '2026-11-01', startsAt = `${date}T10:00:00+09:00`, endsAt = `${date}T11:00:00+09:00`
const snapshot: StyleSnapshot = {
  style: 'lesson', asOf: startsAt, from: `${date}T00:00:00+09:00`, to: '2026-11-02T00:00:00+09:00', timeZone: 'Asia/Tokyo',
  dateBasis: 'visit', range: 'today', metrics: { bookings: { value: 2, unit: '件', status: 'available' }, classes: { value: 1, unit: '回', status: 'available' } },
  previous: {}, items: [], newBookings: [], resultId: 'lesson-result',
}
const booking = (id: string, name: string): StyleBooking => ({
  id, name, kind: 'event', friendId: id, personKey: id, startsAt, endsAt, requestedAt: startsAt, status: 'confirmed',
  staffId: 'teacher', menuId: 'yoga', slotId: 'morning', storeId: null, partySize: 1, price: 0, visited: false, attendance: null,
  held: false, meetingMode: null, meetingUrl: null, location: null, outcome: null, source: 'line', entryPoint: null, refCode: null,
  designation: null, cancelledAt: null, confirmedResponse: null, participationMode: 'classroom',
})
function fixture(): StyleSchedule {
  const bookings = [booking('student-a', '受講者 花子'), booking('student-b', '受講者 太郎')]
  return {
    style: 'lesson', asOf: startsAt, from: snapshot.from, to: snapshot.to, timeZone: snapshot.timeZone, range: 'today', display: 'list', calendarView: 'day',
    columns: [{ id: 'teacher', kind: 'staff', name: '山田先生' }],
    entries: [
      ...bookings.map(b => ({ id: `event:${b.id}`, kind: 'event' as const, columnIds: ['teacher'], startsAt, endsAt, title: b.name, booking: b })),
      { id: 'class:morning', kind: 'class', classId: 'yoga', columnIds: ['teacher'], startsAt, endsAt, title: '朝のヨガ', booking: null },
    ],
    days: [{ date, entryIds: ['event:student-a', 'event:student-b', 'class:morning'], bookings: 2, people: 2 }], closures: [],
    availability: { status: 'available', reason: null, resources: [], closedDates: [], slots: [
      { columnId: 'teacher', menuId: 'yoga', date, startsAt, endsAt, remaining: 8, mode: 'classroom', entryId: 'class:morning' },
    ] },
  }
}
afterEach(cleanup)

it('クラスの列は開催回を1行にし、受講者を混ぜず実際の回の名簿を開く', () => {
  const data = toToday('lesson', snapshot, fixture(), date, 'today'), select = vi.fn()
  render(<TodayList style="lesson" rows={data.rows} note={data.rowsNote} canWrite={false} busyId="" menuFor={() => []} onVisit={() => {}} onUndo={() => {}} onSelect={select} />)
  const table = screen.getByRole('table', { name: '一覧' })
  expect(within(table).getAllByRole('row')).toHaveLength(2)
  expect(table.textContent).not.toMatch(/受講者 花子|受講者 太郎/)
  fireEvent.click(within(table).getByRole('button', { name: '朝のヨガ', exact: true }))
  expect(select).toHaveBeenCalledWith(expect.objectContaining({ id: 'class:morning', reservationId: 'yoga', remaining: 8 }))
  expect(data.rowsNote).toBe('1件中 1〜1件')
})

it.each(['today', 'week', 'month'] as const)('%sの一覧・盤・カレンダーは同じ開催回だけを使い、予約の実数は保つ', range => {
  const schedule = fixture(), original = structuredClone(schedule)
  const data = toToday('lesson', snapshot, { ...schedule, range, calendarView: range === 'today' ? 'day' : range }, date, range)
  expect(data.rows.map(row => row.id)).toEqual(['class:morning'])
  expect(data.board!.entries.map(entry => entry.id)).toEqual(['class:morning'])
  expect(data.board!.columns[0].count).toBe(1)
  if (data.week) expect(data.week.entries.map(entry => entry.id)).toEqual(['class:morning'])
  if (data.month) {
    expect(data.month.selected.rows.map(row => row.name)).toEqual(['朝のヨガ'])
    expect(data.month.selected).toMatchObject({ title: '11月1日（日）のクラス', total: '1回・予約2件（2人）', moreLabel: 'この日の一覧を開く（1回）' })
    expect(data.month.selected.rows[0].state.label).toBe('クラス')
    expect(data.month.days.find(day => day.date === date)).toMatchObject({ groups: 2, people: 2 })
  }
  expect(data.bookingCount).toBe(2)
  expect(data.kpis.find(kpi => kpi.id === 'classes')?.value).toBe(1)
  expect(schedule).toEqual(original)
})

it.each(['2026-10-31T15:00:00.000Z', '2026-11-01T00:00:00+09:00'])('月初の %s を店の日時で11月として表示する', from => {
  const schedule = { ...fixture(), from, range: 'month' as const, calendarView: 'month' as const }
  const month = toToday('lesson', snapshot, schedule, date, 'month').month!
  expect(month.title).toBe('2026年11月')
  expect(month.days.find(day => day.date === '2026-11-01')?.inMonth).toBe(true)
  expect(month.days.find(day => day.date === '2026-10-31')?.inMonth).toBe(false)
})

it('年をまたぐ月初も店の日時で年と月を表示する', () => {
  const schedule = { ...fixture(), from: '2026-12-31T15:00:00Z', range: 'month' as const, calendarView: 'month' as const }
  const month = toToday('lesson', snapshot, schedule, '2027-01-01', 'month').month!
  expect(month.title).toBe('2027年1月')
  expect(month.days.find(day => day.date === '2027-01-01')?.inMonth).toBe(true)
})

it.each([0, 10, null] as const)('満席・予約なし・上限なしの回も残す（残り%s）', remaining => {
  const schedule = fixture()
  schedule.entries = schedule.entries.filter(entry => entry.kind === 'class')
  schedule.availability.slots[0].remaining = remaining
  const data = toToday('lesson', snapshot, schedule, date, 'week')
  expect(data.rows.map(row => row.id)).toEqual(['class:morning'])
  expect(data.week!.entries.map(entry => entry.id)).toEqual(['class:morning'])
  expect(data.rows[0].vacancy).toBe(remaining === 0 ? '×' : '○')
})

it('自店の開催回がない予約もAPIの予約・集計から消さず、クラス管理の行に変えない', () => {
  const schedule = fixture()
  schedule.entries = schedule.entries.filter(entry => entry.kind === 'event')
  schedule.availability.slots = []
  const data = toToday('lesson', { ...snapshot, metrics: { ...snapshot.metrics, classes: { value: 0, unit: '回', status: 'available' } } }, schedule, date, 'week')
  expect(data.rows).toEqual([])
  expect(data.board!.entries).toEqual([])
  expect(data.week!.entries).toEqual([])
  expect(data.bookingCount).toBe(2)
  expect(schedule.entries).toHaveLength(2)
})

it.each(['restaurant', 'salon', 'consult'] as const)('%sの予約行・盤・日週の表示は変えない', style => {
  const schedule = fixture()
  schedule.entries = schedule.entries.filter(entry => entry.kind === 'event')
  const data = toToday(style, { ...snapshot, style }, { ...schedule, style }, date, 'week')
  expect(data.rows.map(row => row.name)).toEqual(['受講者 花子', '受講者 太郎'])
  expect(data.board!.entries).toHaveLength(2)
  expect(data.week!.entries).toHaveLength(2)
})
