'use client'

import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { opsCall } from '@/components/ops/ops-ui'

/** 各種類の全件数は、同じ期間のAPIのtotalから取得する。表示行数では数えない。 */
export function useAuditCounts(from: string, to: string, filters: ReadonlyArray<{ key: string; actions: string }>) {
  const scope = `${from}/${to}`
  const [result, setResult] = useState<{ scope: string; counts: Record<string, number> } | null>(null)
  useEffect(() => {
    let current = true
    void Promise.all([{ key: '', actions: '' }, ...filters].map(async filter => {
      try {
        const response = await opsCall(api.ops.audit({ action: filter.actions || undefined, from: from || undefined, to: to ? `${to}T23:59:59` : undefined, limit: 1, offset: 0 }))
        return response?.success && typeof response.total === 'number' && Number.isFinite(response.total)
          ? [filter.key, response.total] as const
          : null
      } catch {
        return null
      }
    }))
      .then(rows => { if (current) setResult({ scope, counts: Object.fromEntries(rows.filter(row => row !== null)) }) })
      .catch(() => {})
    return () => { current = false }
  }, [from, to, scope, filters])
  return result?.scope === scope ? result.counts : {}
}
