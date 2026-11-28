'use client'
import { useEffect, useRef, useState } from 'react'
import type { DashboardComparison, DashboardComparisonKey, DashboardComparisons } from '@line-crm/shared'
import { api, type DashboardOverview } from '@/lib/api'
import { formatDateTime } from '@/lib/format'

/**
 * 数の帯の比べる値（今日の数は先週の同じ曜日）。
 *
 * 最初の表示を遅くしないよう、概要が読めてから別の口で読む。読めない・古い口で
 * 返らない時は null のままにし、画面は差の札を出さない（0 として比べない）。
 */
export function useDashboardComparisons(accountId: string | null, start: boolean): DashboardComparisons | null {
  const scope = useRef({ accountId, start })
  if (scope.current.accountId !== accountId || scope.current.start !== start) scope.current = { accountId, start }
  const [loaded, setLoaded] = useState<{ scope: object; value: DashboardComparisons } | null>(null)
  useEffect(() => {
    if (!start || !accountId) return
    const requestScope = scope.current
    let cancelled = false
    void api.dashboard.comparisons(accountId)
      .then((response) => {
        if (cancelled) return
        setLoaded(response.success && isComparisons(response.data) ? { scope: requestScope, value: response.data } : null)
      })
      .catch(() => { if (!cancelled) setLoaded(null) })
    return () => { cancelled = true }
  }, [accountId, start])
  return loaded && loaded.scope === scope.current && start ? loaded.value : null
}

function isComparisons(value: unknown): value is DashboardComparisons {
  return typeof value === 'object' && value !== null
    && typeof (value as { comparisons?: unknown }).comparisons === 'object'
    && (value as { comparisons?: unknown }).comparisons !== null
}

/** 比べられる数だけ返す。今と前の両方が数のときだけ（記録の無い数は比べない）。 */
export function comparisonOf(data: DashboardComparisons | null, key: DashboardComparisonKey): DashboardComparison | null {
  const item = data?.comparisons[key] ?? null
  if (!item || !Number.isFinite(item.current) || !Number.isFinite(item.previous)) return null
  return item
}

/*
 * 口の時刻で時差の無い D1 の形（YYYY-MM-DD HH:MM:SS）は、ダッシュボードの決まり
 * （components/dashboard/freshness）と同じく日本時間として読む。
 */
function dashboardInstant(value: string): string {
  return /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value) ? `${value.replace(' ', 'T')}+09:00` : value
}

/**
 * 帯の上の「いつ時点か」の1行（「10月25日 17:51 時点・先週の同じ曜日と比べています」）。
 * 時刻は集計した時刻。数のもとが遅れている時は、取れた中で一番古い時刻と遅れの断りを出す。
 */
export function asOfLine(overview: Pick<DashboardOverview, 'generatedAt' | 'asOf' | 'freshness'> | null | undefined, compared: boolean): string | null {
  if (!overview) return null
  const late = overview.freshness === 'stale' || overview.freshness === 'delayed'
  const source = late && overview.asOf ? overview.asOf : overview.generatedAt
  if (!source) return null
  const time = formatDateTime(dashboardInstant(source), '')
  if (!time) return null
  return `${time} 時点${late ? '（更新が遅れています）' : ''}${compared ? '・先週の同じ曜日と比べています' : ''}`
}
