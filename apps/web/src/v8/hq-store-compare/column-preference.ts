import { METRICS, type MetricDef } from './metrics'

export function columnPreferenceKey(tenantId: string, staffId: string, accountId: string | null): string {
  return ['musubo-store-comparison-columns-v1', tenantId, staffId, accountId === null ? 'hq' : `account:${accountId}`].map(encodeURIComponent).join(':')
}

export function readColumnPreference(storage: Storage, key: string): MetricDef['key'][] | null {
  try {
    const raw: unknown = JSON.parse(storage.getItem(key) ?? 'null')
    if (!Array.isArray(raw)) return null
    const known = new Set<string>(METRICS.map(metric => metric.key))
    const keys = raw.filter((value): value is MetricDef['key'] => typeof value === 'string' && known.has(value))
    return keys.length && new Set(keys).size === keys.length ? keys : null
  } catch { return null }
}
