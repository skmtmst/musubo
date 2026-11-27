// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ list: vi.fn(), summary: vi.fn() }))
vi.mock('@/lib/api', async (original: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await original()
  return { ...actual, eventsApi: { ...actual.eventsApi, listBookings: fixture.list, getBookingSummary: fixture.summary } }
})
import BookingRecords from '@/v8/events/booking-records'

afterEach(() => { cleanup(); vi.clearAllMocks() })

it('予約ごとに通知の種類・予定日時・状態を表示する', async () => {
  fixture.summary.mockResolvedValue({ requested: 0, confirmed: 1 })
  const statuses = ['pending', 'sent', 'cancelled', 'failed', 'failed_permanent']
  fixture.list.mockResolvedValue({ total: 2, items: [
    { id: 'booking-a', friend_id: 'f1', friend_display_name: '予約の太郎', status: 'confirmed', slot_starts_at: '2026-11-28T00:00:00Z', reminders: statuses.map((status, index) => ({ kind: index === 0 ? 'day_before' : 'hours_before', status, scheduled_at: `2026-11-27T0${index}:00:00Z` })) },
    { id: 'booking-b', friend_id: 'f2', friend_display_name: '予約の花子', status: 'confirmed', slot_starts_at: '2026-11-28T00:00:00Z', reminders: [{ kind: 'day_before', status: 'sent', scheduled_at: '2026-11-26T00:00:00Z' }] },
  ] })
  render(<BookingRecords accountId="account-1" eventId="event-1" occurrenceId="slot-1" />)
  fireEvent.click(screen.getByText('申込記録・回答・通知予定'))
  const row = (await screen.findByText('予約の太郎')).closest('[role="row"]') as HTMLElement
  const items = within(row).getAllByRole('listitem')
  expect(items).toHaveLength(5)
  for (const [index, label] of ['送信予定', '送信済み', '停止済み', '失敗', '失敗'].entries()) {
    expect(items[index].textContent).toContain(index === 0 ? '前日のお知らせ' : '開始前のお知らせ')
    expect(items[index].textContent).toContain(label)
    expect(items[index].textContent).toMatch(/11\D+27/)
    expect(items[index].textContent).toContain(`${String(index + 9).padStart(2, '0')}:00`)
  }
  const other = screen.getByText('予約の花子').closest('[role="row"]') as HTMLElement
  expect(within(other).getAllByRole('listitem')).toHaveLength(1)
  expect(within(other).getByRole('listitem').textContent).toContain('送信済み')
})

it.each([
  [{ requested: 2, confirmed: 1, cancelled: 1, activeSeats: 7, totalCapacity: 10 }, '対応が必要：2件を確認してください', '空いた枠を確認してください', 'あと3人で満席'],
  [{ requested: 0, confirmed: 1, cancelled: 0, activeSeats: 4, totalCapacity: 10 }, '確認待ちはありません', 'キャンセルはありません', '定員 10・残り6'],
])('集計に応じた次の行動と残席を表示する', async (summary, expectedRequest, expectedCancel, expectedCapacity) => {
  fixture.summary.mockResolvedValue(summary)
  fixture.list.mockResolvedValue({ total: 0, items: [] })
  render(<BookingRecords accountId="account-1" eventId="event-1" occurrenceId="slot-1" />)
  fireEvent.click(screen.getByText('申込記録・回答・通知予定'))
  expect(await screen.findByText(new RegExp(expectedRequest))).toBeTruthy()
  expect(screen.getByText(new RegExp(expectedCancel))).toBeTruthy()
  expect(screen.getByText(new RegExp(expectedCapacity))).toBeTruthy()
})
