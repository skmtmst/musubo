// @vitest-environment happy-dom
import React, { useLayoutEffect, useRef } from 'react'
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RestaurantStore, RestaurantStoreGroup } from '@/lib/restaurant-test-api'

const mocks = vi.hoisted(() => ({
  storeGroups: vi.fn(),
  updateStoreGroupMember: vi.fn(),
}))

vi.mock('@/lib/restaurant-test-api', () => ({
  restaurantTestApi: {
    storeGroups: (...args: unknown[]) => mocks.storeGroups(...args),
    updateStoreGroupMember: (...args: unknown[]) => mocks.updateStoreGroupMember(...args),
  },
}))

import StoreGroups from './store-groups'

const STORES_A: RestaurantStore[] = [
  { id: 'store-a', name: '渋谷本店', line_account_id: 'acc-a', line_account_name: 'Aアカウント' } as RestaurantStore,
]
const STORES_B: RestaurantStore[] = [
  { id: 'store-b', name: '新宿支店', line_account_id: 'acc-b', line_account_name: 'Bアカウント' } as RestaurantStore,
]

const GROUPS_A: RestaurantStoreGroup[] = [
  {
    id: 'grp-a',
    name: '渋谷エリア組',
    members: [{ store_id: 'store-a', referral_enabled: 1, max_distance: 5, version: 1 }],
  } as RestaurantStoreGroup,
]

beforeEach(() => {
  mocks.storeGroups.mockReset()
  mocks.updateStoreGroupMember.mockReset()
})

afterEach(cleanup)

describe('StoreGroups のアカウント切替と配列確認', () => {
  it('accountId を切り替えた直後の最初の描画で前のアカウントの店の組を一瞬も出さない', async () => {
    const pendingB = new Promise<{ success: true; data: RestaurantStoreGroup[] }>(() => {})
    mocks.storeGroups
      .mockResolvedValueOnce({ success: true, data: GROUPS_A })
      .mockReturnValueOnce(pendingB)

    const committed: Array<{ accountId: string; hadOldGroup: boolean }> = []
    function Wrapper({ accountId, stores }: { accountId: string; stores: RestaurantStore[] }) {
      const hostRef = useRef<HTMLDivElement>(null)
      useLayoutEffect(() => {
        const text = hostRef.current?.textContent ?? ''
        committed.push({ accountId, hadOldGroup: text.includes('渋谷エリア組') || text.includes('渋谷本店') })
      })
      return (
        <div ref={hostRef}>
          <StoreGroups accountId={accountId} stores={stores} readOnly={false} />
        </div>
      )
    }

    const view = render(<Wrapper accountId="acc-a" stores={STORES_A} />)
    await waitFor(() => expect(view.getByText('渋谷エリア組')).toBeTruthy())

    view.rerender(<Wrapper accountId="acc-b" stores={STORES_B} />)
    const firstBFrame = committed.find(entry => entry.accountId === 'acc-b')
    expect(firstBFrame).toEqual({ accountId: 'acc-b', hadOldGroup: false })
  })

  it('storeGroups の戻り値が配列でない場合や success:false の場合はエラー状態として表示する', async () => {
    mocks.storeGroups.mockResolvedValueOnce({ success: true, data: null })

    const view = render(<StoreGroups accountId="acc-a" stores={STORES_A} readOnly={false} />)
    expect(await view.findByRole('button', { name: 'もう一度読み込む' })).toBeTruthy()
  })
})
