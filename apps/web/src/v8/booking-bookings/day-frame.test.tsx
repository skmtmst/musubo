// @vitest-environment happy-dom
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { BookingRequest } from '@/lib/api'
import PeopleDayFrame, { dayBookingSummary } from './day-frame'

afterEach(() => { cleanup(); vi.useRealTimers() })
const row = { id: 'r1', status: 'confirmed', source: 'liff', friend_name: '花子', menu_name: 'カット', staff_name: '担当A', starts_at: '2026-10-15T02:00:00Z', ends_at: '2026-10-15T03:00:00Z', price_at_booking: 5000 } as BookingRequest
const slot = { staffId: 'a', date: '2026-10-15', start: '14:00', remaining: 1, state: 'available' }

test('取消履歴を有効予約から外し、売上は確定分、同時刻のメニュー違いは1枠と数える', () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-15T01:00:00Z'))
  const result = dayBookingSummary([row, { ...row, id: 'cancelled', status: 'cancelled' }, { ...row, id: 'pending', source: 'phone', status: 'requested' }], '2026-10-15', { status: 'ready', slots: [slot, slot, { ...slot, start: '15:00', remaining: 0 }] })
  expect(result).toMatchObject({ active: 2, line: 1, phone: 1, requested: 1, cancelled: 1, sales: 5000, available: 1 })
  expect(result.next?.id).toBe('r1')
  expect(dayBookingSummary([row], '2026-10-15', { status: 'error', slots: [] }).available).toBeNull()
  expect(dayBookingSummary([row], '2026-10-15', { status: 'unconfigured', slots: [] }).available).toBeNull()
})

test.each(['requested', 'cancelled', 'rejected', 'expired', 'no_show', 'completed'])('売上見込みは確定分だけを数え、%sの料金を混ぜない', status => {
  const result = dayBookingSummary([row, { ...row, id: status, status, price_at_booking: 1000 }], '2026-10-15', { status: 'ready', slots: [] })
  expect(result.sales).toBe(5000)
})

test.each(['counter', 'operator', 'import'] as const)('%sの予約を電話に混ぜず、その他の受付として見せる', source => {
  const rows = [row, { ...row, id: 'phone', source: 'phone' as const }, { ...row, id: source, source }]
  expect(dayBookingSummary(rows, '2026-10-15', { status: 'ready', slots: [] })).toMatchObject({ active: 3, line: 1, phone: 1, other: 1 })
  const { container } = render(<PeopleDayFrame view="day" date="2026-10-15" rows={rows} ready availability={{ status: 'ready', slots: [] }} actions={null} canWrite={false} onOpen={() => {}}>盤</PeopleDayFrame>)
  expect(container.textContent).toContain('LINE 1・電話 1・その他 1')
  expect(container.textContent).toContain('その他の受付')
})

test('次の予約は実データから詳細を開き、狭い板の入口からも同じ内容を読める', () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-15T01:00:00Z'))
  const open = vi.fn()
  render(<PeopleDayFrame view="day" date="2026-10-15" rows={[row]} ready availability={{ status: 'ready', slots: [slot] }} actions={<button>電話の予約を入れる</button>} canWrite onOpen={open}>盤</PeopleDayFrame>)
  fireEvent.click(screen.getByRole('button', { name: '詳細を見る' }))
  expect(open).toHaveBeenCalledWith('r1')
  expect(screen.getByRole('link', { name: '日時を変更する' }).getAttribute('href')).toBe('/booking/bookings/detail?id=r1')
  fireEvent.click(screen.getByRole('button', { name: '次の予約・内訳', exact: true }))
  expect(screen.getByRole('dialog', { name: '次の予約・内訳' }).textContent).toContain('花子')
})

test('未取得の一覧に前の数と次の予約を出さず、閲覧者の変更入口を隠す', () => {
  verifiedStaffRole('viewer')
  render(<PeopleDayFrame view="day" date="2026-10-15" rows={[row]} ready={false} availability={{ status: 'error', slots: [] }} actions={null} canWrite={false} onOpen={() => {}}>盤</PeopleDayFrame>)
  expect(screen.queryByRole('button', { name: '詳細を見る' })).toBeNull()
  expect(screen.queryByRole('link', { name: '日時を変更する' })).toBeNull()
  expect(screen.getByText(/閲覧のみで見ています/)).toBeTruthy()
  expect(screen.getByText('読み込めませんでした')).toBeTruthy()
})

test('日付やアカウントを読み直している間は、前の空き枠の数も残さない', () => {
  const { container } = render(<PeopleDayFrame view="day" date="2026-10-15" rows={[row]} ready={false} availability={{ status: 'ready', slots: [slot] }} actions={null} canWrite={false} onOpen={() => {}}>盤</PeopleDayFrame>)
  expect([...container.querySelectorAll('[data-kpi-number]')].map(node => node.textContent)).toEqual(['—', '—', '—', '—'])
})

test('pending表記も承認が必要な件数へ含め、売上の確定分へ混ぜない', () => {
  const result = dayBookingSummary([{ ...row, status: 'pending' }], '2026-10-15', { status: 'ready', slots: [] })
  expect(result.requested).toBe(1)
  expect(result.sales).toBe(0)
})

test.each(['マロン さん', 'マロン様', 'マロンさま'])('次の予約で %s の敬称を重ねない', name => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-15T01:00:00Z'))
  const { container } = render(<PeopleDayFrame view="day" date="2026-10-15" rows={[{ ...row, friend_name: name }]} ready availability={{ status: 'ready', slots: [] }} actions={null} canWrite={false} onOpen={() => {}}>盤</PeopleDayFrame>)
  expect(container.querySelector(`[title="${name}"]`)?.textContent).toBe(name)
  expect(container.textContent).not.toMatch(/(?:さん|様|さま)\s*(?:さん|様|さま)/)
})
afterEach(() => { verifiedStaffRole(null) })
