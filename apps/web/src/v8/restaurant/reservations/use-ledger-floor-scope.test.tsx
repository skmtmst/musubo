// @vitest-environment happy-dom
import React, { useLayoutEffect } from 'react'
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RestaurantFloor } from '@line-crm/shared'

const mocks = vi.hoisted(() => ({
  floors: vi.fn(),
}))

vi.mock('@/lib/api/helpers/reservation-board', () => ({
  reservationBoardApi: {
    floors: (...args: unknown[]) => mocks.floors(...args),
  },
}))

import { useLedgerFloor } from './use-ledger-floor'

function sampleFloor(id: string, name: string): RestaurantFloor {
  return {
    id,
    name,
    kind: 'floor',
    parentFloorId: null,
    sortOrder: 0,
    version: 1,
    width: 1000,
    height: 600,
    tables: [],
  }
}

beforeEach(() => {
  mocks.floors.mockReset()
})

afterEach(cleanup)

describe('useLedgerFloor の店舗切替と失敗扱い', () => {
  it('店舗やアカウントを切り替えた直後の最初の描画で、前の店舗の座席表を一瞬も出さない', async () => {
    const floorA = sampleFloor('floor-a', '1階メイン')
    const floorB = sampleFloor('floor-b', '2階個室')
    const pendingB = new Promise<{ success: true; data: RestaurantFloor[] }>(() => {})
    mocks.floors
      .mockResolvedValueOnce({ success: true, data: [floorA] })
      .mockReturnValueOnce(pendingB)

    const committed: Array<{ storeId: string; floorId: string | null; hasError: boolean }> = []
    function Probe({ accountId, storeId }: { accountId: string; storeId: string }) {
      const { floor, error } = useLedgerFloor(accountId, storeId)
      useLayoutEffect(() => {
        committed.push({ storeId, floorId: floor?.id ?? null, hasError: Boolean(error) })
      })
      return <div>{floor?.name ?? 'none'}</div>
    }

    const view = render(<Probe accountId="acc-1" storeId="store-a" />)
    await waitFor(() => expect(view.getByText('1階メイン')).toBeTruthy())

    view.rerender(<Probe accountId="acc-1" storeId="store-b" />)
    const firstStoreBFrame = committed.find(entry => entry.storeId === 'store-b')
    expect(firstStoreBFrame).toEqual({ storeId: 'store-b', floorId: null, hasError: false })
    expect(floorB.id).toBe('floor-b')
  })

  it('floors API が success:false を返した場合は未設定扱いにせずエラーとして扱う', async () => {
    mocks.floors.mockResolvedValueOnce({ success: false, data: [] })

    function Probe() {
      const { floor, error } = useLedgerFloor('acc-1', 'store-a')
      return <div data-testid="state">{error ? 'error' : floor ? floor.name : 'empty'}</div>
    }

    const view = render(<Probe />)
    await waitFor(() => expect(view.getByTestId('state').textContent).toBe('error'))
  })
})
