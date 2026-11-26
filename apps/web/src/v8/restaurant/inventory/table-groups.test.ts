import { expect, it } from 'vitest'
import type { RestaurantFloor } from '@line-crm/shared'
import type { RestaurantTable } from '@/lib/restaurant-test-api'
import { groupTablesByFloor } from './table-groups'

it('階の順を保ち、それぞれの卓番号を数の順に並べる', () => {
  const table = (code: string, floor_id: string) => ({ id: code, code, label: `卓${code}`, store_id:'s', floor_id }) as RestaurantTable
  const floors = [{ id:'f2', name:'テラス' }, { id:'f1', name:'1階' }] as RestaurantFloor[]
  const groups = groupTablesByFloor([table('10','f1'), table('2','f1'), table('1','f2')], floors)
  expect(groups.map(group => group.name)).toEqual(['テラス','1階'])
  expect(groups[1].tables.map(row => row.code)).toEqual(['2','10'])
})

it('階の情報を読み込めない間も卓をまとめて表示する', () => {
  const tables = [{ id:'10', code:'10', label:'卓10', store_id:'s', floor_id:'f' }, { id:'2', code:'2', label:'卓2', store_id:'s', floor_id:'g' }] as RestaurantTable[]
  const groups = groupTablesByFloor(tables, [])
  expect(groups).toHaveLength(1)
  expect(groups[0].name).toBe('')
  expect(groups[0].tables.map(table => table.code)).toEqual(['2','10'])
})
