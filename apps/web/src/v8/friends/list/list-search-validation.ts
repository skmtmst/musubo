import type { AdvancedSearchResult } from '@/components/friends/advanced-search-dialog'
export function scoreBoundary(raw: string | null) {
  if (typeof raw !== 'string' || !/^-?\d+$/.test(raw)) return undefined
  const value = Number(raw)
  if (!Number.isSafeInteger(value)) return undefined
  return value === 0 ? 0 : value
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

export function validAdvancedSearch(value: unknown): value is AdvancedSearchResult | null {
  if (value === null) return true
  if (!isPlainRecord(value)) return false
  const result = value as Partial<AdvancedSearchResult>
  return isPlainRecord(result.params)
    && Array.isArray(result.summary)
    && Array.from(result.summary).every(item => typeof item === 'string')
}
