import type { RestaurantSnapshot, RestaurantTable } from '@/lib/restaurant-test-api'

/** 既存の通常取得で確認できた卓定義。追加取得や予約可否の判定には使わない。 */
export type RestaurantTableDefinition = { accountId: string; snapshot: RestaurantSnapshot }

/** 確認済みの卓・結合の人数範囲だけで、収容できないと確定する場合の説明。 */
export function tableCapacityReason(definition: RestaurantTableDefinition | undefined, accountId: string | null, storeId: string, tables: RestaurantTable[], guests: number): string | undefined {
  if (!definition || !accountId || definition.accountId !== accountId || !definition.snapshot?.organization || !Number.isInteger(guests) || guests < 1) return
  if (!Array.isArray(definition.snapshot.stores) || !Array.isArray(definition.snapshot.tables) || !Array.isArray(tables)) return
  if (!definition.snapshot.stores.some(store => store && store.id === storeId)) return
  const configured = definition.snapshot.tables.filter(table => table && table.store_id === storeId)
  // 部分的な一覧・旧表示・停止卓混在から上限を推測しない。
  if (!configured.length || configured.length !== tables.length || new Set(configured.map(table => table.id)).size !== configured.length || configured.some(table => !tables.includes(table) || !table.is_active || !Number.isInteger(table.min_capacity) || !Number.isInteger(table.max_capacity) || table.min_capacity < 1 || table.max_capacity < table.min_capacity)) return
  const ranges = configured.map(table => ({ min: table.min_capacity, max: table.max_capacity }))
  const groups = new Map<string, RestaurantTable[]>()
  for (const table of configured) {
    if (table.join_group) groups.set(table.join_group, [...(groups.get(table.join_group) ?? []), table])
  }
  for (const members of groups.values()) {
    if (members.length < 2) return
    ranges.push({ min: members.reduce((sum, table) => sum + table.min_capacity, 0), max: members.reduce((sum, table) => sum + table.max_capacity, 0) })
  }
  if (ranges.some(range => range.min <= guests && guests <= range.max)) return
  const maximum = Math.max(...ranges.map(range => range.max))
  return guests > maximum
    ? `結合を含め最大${maximum}名のため、${guests}名は入れません。`
    : `${guests}名に対応する卓・結合がありません。`
}
