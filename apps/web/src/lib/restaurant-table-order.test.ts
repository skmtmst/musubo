import { expect, it } from 'vitest'
import { compareRestaurantTables } from './restaurant-test-api'

it('卓番号を数で比べ、番号のない卓を名前の自然順で後ろに置く', () => {
  const tables = ['10', '2', '1', '9'].map(code => ({ id: code, store_id: 's', code, label: `卓${code}` }))
  tables.push({ id: 'b', store_id: 's', code: '', label: 'テーブル10' }, { id: 'a', store_id: 's', code: '', label: 'テーブル2' })
  expect(tables.sort(compareRestaurantTables).map(t => t.id)).toEqual(['1', '2', '9', '10', 'a', 'b'])
})

it('英字を含む番号も自然順に並べ、店舗ごとにまとめる', () => {
  const tables = [{ id: '10', store_id: 'a', code: 'T-10', label: '窓際' }, { id: 'other', store_id: 'b', code: '1', label: '卓' }, { id: '2', store_id: 'a', code: 'T-2', label: '奥' }]
  expect(tables.sort(compareRestaurantTables).map(t => t.id)).toEqual(['2', '10', 'other'])
})
