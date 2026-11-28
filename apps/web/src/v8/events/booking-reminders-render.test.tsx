// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
const fixture = vi.hoisted(() => ({ list: vi.fn(), summary: vi.fn() }))
vi.mock('@/lib/api', async (original: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await original()
  return { ...actual, eventsApi: { ...actual.eventsApi, listBookings: fixture.list, getBookingSummary: fixture.summary } }
})
import BookingRecords from './booking-records'
afterEach(cleanup)
it('予約の行に通知の種類・日時・状態を表示する', async () => {
  fixture.summary.mockResolvedValue({ requested: 0, confirmed: 1 })
  fixture.list.mockResolvedValue({ total: 1, items: [{ id: 'booking-1', friend_id: 'friend-1', friend_display_name: '試験の友だち', status: 'confirmed', created_at: '2026-11-27T00:00:00Z', slot_starts_at: '2026-11-28T00:00:00Z', reminders: [
    { kind: 'day_before', status: 'sent', scheduled_at: '2026-11-27T00:00:00Z' },
    { kind: 'hours_before', status: 'cancelled', scheduled_at: '2026-11-27T03:00:00Z' },
  ] }] })
  render(<BookingRecords accountId="account-1" eventId="event-1" occurrenceId="slot-1" />)
  fireEvent.click(screen.getByText('申込記録・回答・通知予定'))
  const name = await screen.findByText('試験の友だち')
  const row = name.closest('[role="row"]') as HTMLElement
  const reminders = within(row).getByText(/前日のお知らせ/)
  expect(reminders.textContent).toContain('送信済み')
  expect(reminders.textContent).toMatch(/11\D+27/)
  expect(within(row).getByText(/開始前のお知らせ/).textContent).toContain('停止済み')
})
