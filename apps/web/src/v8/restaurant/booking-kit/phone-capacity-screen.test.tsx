// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import PhoneReservation from '../reservations/phone'
import PhoneReservationDrawer from '../front-desk/phone-drawer'
import WalkInDialog from '../front-desk/walk-in-dialog'
import { snapshotOf, tables } from './test-data'
import type { RestaurantSnapshot } from '@/lib/restaurant-test-api'

const api = vi.hoisted(() => ({ snapshot: vi.fn(), openingHours: vi.fn(), reservationsDay: vi.fn(), customerSearch: vi.fn(), customerHistory: vi.fn(), createReservation: vi.fn() }))
vi.mock('@/lib/api/helpers/reservation-board', () => ({ reservationBoardApi: { floors: vi.fn(async () => ({ data: [] })) } }))
vi.mock('@/lib/restaurant-test-api', () => ({ restaurantTestApi: api }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'account-1' }) }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => '/restaurant-test/reservations', useSearchParams: () => new URLSearchParams() }))

type Entry = 'page' | 'drawer' | 'walk-in'
const capacityTables = tables.filter(t => t.is_active).map(t => ({ ...t, max_capacity: Math.min(t.max_capacity, 6) }))
const definition = { accountId: 'account-1', snapshot: snapshotOf({ tables: capacityTables }) as unknown as RestaurantSnapshot }
const message = '結合を含め最大6名のため、7名は入れません。'
const onSave = vi.fn()
function open(entry: Entry, proof: typeof definition | null = definition) {
  const props = { tableDefinition: proof ?? undefined }
  const shownTables = proof?.snapshot.tables ?? capacityTables
  if (entry === 'page') render(<PhoneReservation accountStyle="restaurant" staffRole="owner" {...props} storeId="store-1" storeName="模擬店舗" tables={shownTables} menuItems={[]} busy={false} preset={{ date: new Date('2026-10-11T00:00:00+09:00') }} onBack={vi.fn()} onSave={onSave} />)
  else if (entry === 'drawer') render(<PhoneReservationDrawer staffRole="owner" storeName="人工店舗" {...props} open accountId="account-1" storeId="store-1" tables={shownTables} onClose={vi.fn()} onSaved={vi.fn()} />)
  else render(<WalkInDialog {...props} open accountId="account-1" storeId="store-1" tables={shownTables} onClose={vi.fn()} onSaved={vi.fn()} />)
}
function changeCount(entry: Entry, count: number) {
  if (entry === 'page') fireEvent.change(screen.getByLabelText('人数'), { target: { value: String(count) } })
  else for (let i = 2; i < count; i++) fireEvent.click(screen.getByRole('button', { name: '人数を増やす' }))
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-10T12:00:00+09:00'))
  api.openingHours.mockResolvedValue({ data: { hours: Array.from({ length: 7 }, (_, weekday) => ({ weekday, periods: [{ opensAt: '17:00', closesAt: '23:00' }] })) } })
  api.reservationsDay.mockResolvedValue({ data: { reservations: [] } })
  api.customerSearch.mockResolvedValue({ data: [] }); api.customerHistory.mockResolvedValue({ data: { visitCount: 0, visits: [] } })
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks() })

it.each<Entry>(['page', 'drawer', 'walk-in'])('%s: 卓と結合の上限を超えた理由を1つ出し、人数を戻すと消す', async entry => {
  open(entry)
  if (entry !== 'walk-in') await screen.findByRole('button', { name: '19:00' })
  else await screen.findByText('T1')
  changeCount(entry, 7)
  expect(await screen.findAllByText(message)).toHaveLength(1)
  if (entry === 'page') expect((screen.getByRole('button', { name: '19:00' }) as HTMLButtonElement).disabled).toBe(true)
  else if (entry === 'drawer') expect(screen.queryByRole('button', { name: '19:00' })).toBeNull()
  if (entry === 'page') changeCount(entry, 2)
  else for (let i = 0; i < 5; i++) fireEvent.click(screen.getByRole('button', { name: '人数を減らす' }))
  await waitFor(() => expect(screen.queryByText(message)).toBeNull())
  if (entry !== 'walk-in') expect((screen.getByRole('button', { name: '19:00' }) as HTMLButtonElement).disabled).toBe(false)
  expect(api.snapshot).not.toHaveBeenCalled()
  expect(api.createReservation).not.toHaveBeenCalled(); expect(onSave).not.toHaveBeenCalled()
})

for (const entry of ['page', 'drawer', 'walk-in'] as const) {
  it.each(['unspecified', 'join-fits', 'stopped', 'partial-join'] as const)(`${entry}: %s の時は上限を断定せず既存の可否と取得回数を保つ`, async variant => {
    const rows = variant === 'join-fits' ? capacityTables.map(t => t.id === 't3' ? { ...t, max_capacity: 5 } : t)
      : variant === 'stopped' ? [...capacityTables, tables.find(t => !t.is_active)!]
      : capacityTables.filter(t => t.id !== 't2')
    const proof = variant === 'unspecified' ? null : { accountId: 'account-1', snapshot: snapshotOf({ tables: rows }) as RestaurantSnapshot }
    open(entry, proof)
    if (entry !== 'walk-in') await screen.findByRole('button', { name: '19:00' })
    else await screen.findByText('T1')
    changeCount(entry, 7)
    expect(screen.queryByText(/結合を含め最大/)).toBeNull()
    if (entry === 'page') expect((screen.getByRole('button', { name: '19:00' }) as HTMLButtonElement).disabled).toBe(true)
    else if (entry === 'drawer') expect(screen.queryByRole('button', { name: '19:00' })).toBeNull()
    expect(api.snapshot).not.toHaveBeenCalled(); expect(api.createReservation).not.toHaveBeenCalled(); expect(onSave).not.toHaveBeenCalled()
  })
}

it.each<Entry>(['page', 'drawer', 'walk-in'])('%s: 店舗accountから元の組織accountを返す正当な応答でも、理由を出す', async entry => {
  const snapshot = { ...definition.snapshot, organization: { ...definition.snapshot.organization!, account_id: 'organization-primary' } }
  open(entry, { accountId: 'account-1', snapshot })
  if (entry !== 'walk-in') await screen.findByRole('button', { name: '19:00' })
  else await screen.findByText('T1')
  changeCount(entry, 7)
  expect(await screen.findAllByText(message)).toHaveLength(1)
  expect(api.snapshot).not.toHaveBeenCalled(); expect(api.createReservation).not.toHaveBeenCalled(); expect(onSave).not.toHaveBeenCalled()
})
