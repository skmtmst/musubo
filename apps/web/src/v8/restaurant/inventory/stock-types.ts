import type { RestaurantOpeningDay } from '@line-crm/shared'
import type { RestaurantInventory, RestaurantTable } from '@/lib/restaurant-test-api'

export type Alloc = { ota: number; line: number; walkin: number }
export type Hours = RestaurantOpeningDay[]

export type SlotInfo = {
  row: RestaurantInventory
  time: string
  seats: number
  tables: RestaurantTable[]
  free: number
  ratio: number
}

export type Conflict = {
  who: string
  at: string
  scope: string
  attemptedHours: Hours
  latestHours: Hours | null
}
