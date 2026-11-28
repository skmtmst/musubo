import { describe, expect, it } from 'vitest'
import type { RestaurantSnapshot, RestaurantTable } from '@/lib/restaurant-test-api'
import { snapshotOf, tables } from './test-data'
import { tableCapacityReason } from './table-definition'

describe('tableCapacityReason 非配列・欠損スナップショットの防御', () => {
  it('snapshot.stores や snapshot.tables・引数 tables が非配列でも落ちずに undefined を返す', () => {
    const valid = snapshotOf({ tables }) as RestaurantSnapshot
    const missingStores = { ...valid, stores: undefined } as unknown as RestaurantSnapshot
    const missingTables = { ...valid, tables: null } as unknown as RestaurantSnapshot

    expect(tableCapacityReason({ accountId: 'account-1', snapshot: missingStores }, 'account-1', 'store-1', tables, 4)).toBeUndefined()
    expect(tableCapacityReason({ accountId: 'account-1', snapshot: missingTables }, 'account-1', 'store-1', tables, 4)).toBeUndefined()
    expect(tableCapacityReason({ accountId: 'account-1', snapshot: valid }, 'account-1', 'store-1', null as unknown as RestaurantTable[], 4)).toBeUndefined()
  })
})
