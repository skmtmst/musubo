'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { styleApi } from '@/lib/api/helpers/styles'
import type { StarterItemState, StyleState, StyleWarning } from './model'
import { invalidateApiReads } from '@/lib/api/transport/read-cache'

export type StyleSetupData = {
  state: StyleState
  warnings: StyleWarning[]
  items: StarterItemState[]
}

/** 取得不能と未設定を分ける。アカウント切替直後も前の店の状態を返さない。 */
export function useStyleSetup(accountId: string | null, role: string | null) {
  const [snapshot, setSnapshot] = useState<{ accountId: string; role: string; data: StyleSetupData | null; error: unknown; status: 'ready' | 'error' } | null>(null)
  const [tick, setTick] = useState(0)
  const enabled = role !== null
  const previousRole = useRef(role)
  useEffect(() => {
    setSnapshot(null)
    if (previousRole.current !== role) invalidateApiReads('/api/dashboard/style')
    previousRole.current = role
    if (!accountId || !role) return
    let cancelled = false
    void Promise.all([styleApi.get(accountId), styleApi.warnings(accountId), styleApi.starterItems(accountId)])
      .then(([state, warnings, items]) => {
        const validState = state?.success && state.data && typeof state.data === 'object' && !Array.isArray(state.data)
        const validWarnings = warnings?.success && warnings.data && typeof warnings.data === 'object' && Array.isArray(warnings.data.items)
        const validItems = items?.success && items.data && typeof items.data === 'object' && Array.isArray(items.data.items)
        if (!validState || !validWarnings || !validItems) throw new Error('初期設定の状態を読み込めませんでした')
        if (!cancelled) setSnapshot({ accountId, role, data: { state: state.data, warnings: warnings.data.items, items: items.data.items }, error: null, status: 'ready' })
      })
      .catch((error: unknown) => { if (!cancelled) setSnapshot({ accountId, role, data: null, error, status: 'error' }) })
    return () => { cancelled = true }
  }, [accountId, role, tick])
  const reload = useCallback(() => {
    invalidateApiReads('/api/dashboard/style', accountId ?? undefined)
    setTick((value) => value + 1)
  }, [accountId])
  const current = enabled && snapshot?.accountId === accountId && snapshot.role === role ? snapshot : null
  return { data: current?.data ?? null, error: current?.error ?? null, status: !enabled || !accountId ? 'idle' as const : current?.status ?? 'loading' as const, reload }
}
