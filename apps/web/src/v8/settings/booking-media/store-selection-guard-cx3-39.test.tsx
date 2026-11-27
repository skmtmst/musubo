// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const net = vi.hoisted(() => ({ list: vi.fn(), context: vi.fn(), select: vi.fn() }))
vi.mock('@/lib/restaurant-test-api', () => ({ restaurantTestApi: { listStores: net.list, storeContext: net.context, selectStore: net.select } }))
import { useBookingMediaStoreSelection } from './use-store-selection'

function Screen() {
  const selection = useBookingMediaStoreSelection('a')
  return <><p>{selection.status}</p><p data-testid="store">{selection.storeId || '店舗未確定'}</p><button onClick={selection.refresh}>読み直す</button></>
}
const store = { id: 'one', name: '本店', line_account_id: 'a', status: 'active' }
beforeEach(() => {
  vi.resetAllMocks()
  net.list.mockResolvedValue({ data: { stores: [store] } })
  net.context.mockResolvedValue({ data: { selectedStore: null } })
})
afterEach(cleanup)

it('選択中店舗の返事が不正なら操作対象を決めず、読み直して回復する', async () => {
  net.context.mockResolvedValueOnce({ data: {} })
  render(<Screen />)
  expect(await screen.findByText('error')).toBeTruthy()
  expect(screen.getByTestId('store').textContent).toBe('店舗未確定')
  fireEvent.click(screen.getByRole('button', { name: '読み直す' }))
  expect(await screen.findByText('one')).toBeTruthy()
})

it('店舗の状態が未知なら操作対象を決めず、読み直して回復する', async () => {
  net.list.mockResolvedValueOnce({ data: { stores: [{ ...store, status: 'unknown' }] } })
  render(<Screen />)
  expect(await screen.findByText('error')).toBeTruthy()
  expect(screen.getByTestId('store').textContent).toBe('店舗未確定')
  fireEvent.click(screen.getByRole('button', { name: '読み直す' }))
  expect(await screen.findByText('one')).toBeTruthy()
})
