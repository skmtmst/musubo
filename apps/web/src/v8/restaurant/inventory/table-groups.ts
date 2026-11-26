import type { RestaurantFloor } from '@line-crm/shared'
import type { RestaurantTable } from '@/lib/restaurant-test-api'
import { compareRestaurantTables } from '@/lib/restaurant-table-order'

export function groupTablesByFloor(tables: RestaurantTable[], floors: RestaurantFloor[]) {
  if (!floors.length) return [{ id: '', name: '', tables: [...tables].sort(compareRestaurantTables) }]
  const ids = [...new Set(tables.map(table => table.floor_id ?? ''))]
  ids.sort((a, b) => {
    const ai = floors.findIndex(floor => floor.id === a), bi = floors.findIndex(floor => floor.id === b)
    return (ai < 0 ? Number.MAX_SAFE_INTEGER : ai) - (bi < 0 ? Number.MAX_SAFE_INTEGER : bi) || a.localeCompare(b)
  })
  return ids.map(id => ({ id, name: floors.find(floor => floor.id === id)?.name ?? '階・エリア未取得', tables: tables.filter(table => (table.floor_id ?? '') === id).sort(compareRestaurantTables) }))
}
