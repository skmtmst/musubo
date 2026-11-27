import { describe, expect, it } from 'vitest'
import { selectAccountStore } from './use-store-today'
import type { RestaurantStore } from '@/lib/restaurant-test-api'

const stores = [
  { id: 'other', line_account_id: 'b', status: 'active' },
  { id: 'own', line_account_id: 'a', status: 'active' },
  { id: 'closed', line_account_id: 'a', status: 'archived' },
] as RestaurantStore[]

describe('店舗の選択', () => {
  it('未選択ならアカウントの唯一の店舗だけを使う', () => {
    expect(selectAccountStore(stores, 'a', undefined)).toBe('own')
    expect(selectAccountStore(stores, 'c', undefined)).toBeNull()
  })
  it('別アカウントの選択や複数候補を先頭に置き換えない', () => {
    expect(() => selectAccountStore(stores, 'a', 'other')).toThrow()
    expect(() => selectAccountStore([...stores, { ...stores[1], id: 'own2' }], 'a', undefined)).toThrow()
    expect(selectAccountStore(stores, 'a', 'own')).toBe('own')
  })
})
