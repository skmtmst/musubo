// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ReservationBoardEntry, RestaurantFloor } from '@line-crm/shared'
import ReservationBoard from './reservation-board'

const entry: ReservationBoardEntry = {
  id: 'reservation-unassigned', kind: 'seats', version: 1, scopeId: 'store-1',
  startsAt: '2026-10-31T12:00:00Z', endsAt: '2026-10-31T14:00:00Z',
  status: 'confirmed', customerName: '見本 114', guestCount: 2,
  resourceIds: [], resourceLabel: null, source: 'phone', courseName: null,
  note: null, dining: null, holdExpiresAt: null,
}
const floor: RestaurantFloor = { id: 'floor-1', storeId: 'store-1', name: '1階', width: 600, height: 400, version: 1, outline: [], fixtures: [], tables: [] }

afterEach(cleanup)

it.each(['resource', 'floor'] as const)('席の%s表示では見出しで未配席を示し、札には名前・時刻・人数を残す', axis => {
  const open = vi.fn()
  render(<ReservationBoard entries={[entry]} resources={[]} dates={['2026-10-31']} axis={axis} floor={floor} onOpen={open} />)
  const section = screen.getByRole('region', { name: '未配席の予約' })
  expect(section.previousElementSibling?.textContent).toBe('未配席')
  const button = within(section).getByRole('button', { name: '見本 114・21:00〜23:00・2名' })
  expect(button.textContent).not.toContain('未配席')
  fireEvent.click(button)
  expect(open).toHaveBeenCalledExactlyOnceWith('reservation-unassigned')
})

it('人の予約には未配席の見出しがないため、札に未配席を残す', () => {
  const open = vi.fn()
  render(<ReservationBoard kind="people" entries={[{ ...entry, kind: 'people' }]} resources={[]} dates={['2026-10-31']} onOpen={open} />)
  expect(screen.queryByRole('region', { name: '未配席の予約' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '見本 114・未配席' }))
  expect(open).toHaveBeenCalledExactlyOnceWith('reservation-unassigned')
})
