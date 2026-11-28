// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { BookingRequest } from '@/lib/api'
import PeopleDayList from './day-list'
import type { usePeopleVisitMarks } from './use-visit-marks'

const VISITS = {
  status: 'ready',
  mark: () => null,
  busy: () => false,
  markVisit: async () => {},
  reload: () => {},
} as unknown as ReturnType<typeof usePeopleVisitMarks>

afterEach(cleanup)

describe('PeopleDayList defensive guards', () => {
  it('falls back to 名前の登録なし for blank friend_name and — for missing menu/staff names', () => {
    const malformedRow = {
      id: 'r1',
      status: 'confirmed',
      source: 'liff',
      friend_name: '   ',
      menu_name: null,
      staff_name: undefined,
      starts_at: '2026-10-15T02:00:00Z',
      ends_at: '2026-10-15T03:00:00Z',
      price_at_booking: 5000,
    } as unknown as BookingRequest

    const { container } = render(
      <PeopleDayList rows={[null as unknown as BookingRequest, malformedRow]} canMark={false} visits={VISITS} onOpen={() => {}} />,
    )

    const items = container.querySelectorAll('li')
    expect(items).toHaveLength(1)
    const button = container.querySelector('li button')
    expect(button?.textContent).toBe('名前の登録なし')
    const subtext = container.querySelector('li span[title]')
    expect(subtext?.textContent).toBe('—・担当 —')
    expect(subtext?.getAttribute('title')).toBe('—・担当 —')
    expect(container.textContent).not.toContain('null')
    expect(container.textContent).not.toContain('undefined')
  })

  it('renders empty state safely when rows is null/malformed at runtime', () => {
    const { container } = render(
      <PeopleDayList rows={null as unknown as BookingRequest[]} canMark={false} visits={VISITS} onOpen={() => {}} />,
    )
    expect(container.textContent).toContain('この日の予約はありません')
  })
})
