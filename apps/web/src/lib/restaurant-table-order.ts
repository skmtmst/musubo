type TableOrderKey = { id: string; store_id: string; code: string; label: string }

export function compareRestaurantTables(a: TableOrderKey, b: TableOrderKey): number {
  const store = a.store_id.localeCompare(b.store_id, 'ja', { numeric: true })
  if (store) return store
  const aNumber = /[0-9０-９]/.test(a.code), bNumber = /[0-9０-９]/.test(b.code)
  if (aNumber !== bNumber) return aNumber ? -1 : 1
  const compare = (left: string, right: string) => left.localeCompare(right, 'ja', { numeric: true })
  return (aNumber ? compare(a.code, b.code) : compare(a.label, b.label)) || compare(a.code, b.code) || compare(a.id, b.id)
}
