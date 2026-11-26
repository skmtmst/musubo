'use client'

import { useCallback, useEffect, useState } from 'react'
import { ACCOUNT_STYLES } from '@line-crm/shared'
import { invalidateApiReads } from '@/lib/api/transport/read-cache'
import { FEATURE_SETTINGS_UPDATED_EVENT, type FeatureSettingsUpdate } from '@/lib/feature-settings-event'
import type { styleApi } from '@/lib/api/helpers/styles'

export const ACCOUNT_STYLE_UPDATED = 'musubo:account-style-updated'
export function accountStyleUpdated(accountId: string) {
  invalidateApiReads('/api/dashboard/style', accountId)
  invalidateApiReads('/api/settings/features', accountId)
  window.dispatchEvent(new CustomEvent(ACCOUNT_STYLE_UPDATED, { detail: { accountId } }))
  window.dispatchEvent(new CustomEvent<FeatureSettingsUpdate>(FEATURE_SETTINGS_UPDATED_EVENT, { detail: { accountId, source: 'account-style' } }))
}

type Data = Awaited<ReturnType<typeof styleApi.get>>['data']
let stylesModule: Promise<typeof import('@/lib/api/helpers/styles')> | null = null
function load(accountId: string): Promise<Data> {
  return (stylesModule ??= import('@/lib/api/helpers/styles')).then(module => module.styleApi.get(accountId)).then(res => {
    if (!res.success || !ACCOUNT_STYLES.includes(res.data?.style)) throw new Error('使い方のスタイルを読み込めませんでした')
    return res.data
  })
}

const REMEMBERED = 'musubo:account-style:'
/** 同じアカウントで前に読めたスタイル。読み直せない時だけ使う。 */
function remembered(accountId: string): Data | null {
  try {
    const raw = window.localStorage.getItem(REMEMBERED + accountId)
    const data = raw ? JSON.parse(raw) as Data : null
    return data && ACCOUNT_STYLES.includes(data.style) ? data : null
  } catch { return null }
}
function remember(accountId: string, data: Data) {
  try { window.localStorage.setItem(REMEMBERED + accountId, JSON.stringify(data)) } catch { /* 覚えられない端末では毎回読む */ }
}

/** 読み直せず、前に読めたスタイルで出している時の 1 行。 */
export const STALE_STYLE_TEXT = '要確認：表示の設定を読み直せていません'

/**
 * サーバーで所属を確かめた業種。切替の最初の描画から前の店を返さない。
 * 読み直せない時は、同じアカウントで前に読めたスタイルで出し `stale` を立てる（画面は STALE_STYLE_TEXT を 1 行出す）。
 * 初めてで分からない時は `error` のまま（業種の画面は開かず、予約を作る入口は止める）。
 */
export function useAccountStyle(accountId: string | null | undefined) {
  const [snapshot, setSnapshot] = useState<{ accountId: string; data: Data | null; error: unknown } | null>(null)
  const [tick, setTick] = useState(0)
  const reload = useCallback(() => { if (accountId) accountStyleUpdated(accountId) }, [accountId])
  useEffect(() => {
    setSnapshot(null)
    if (!accountId) return
    let active = true
    void load(accountId).then(data => {
      remember(accountId, data)
      if (active) setSnapshot({ accountId, data, error: null })
    }, error => { if (active) setSnapshot({ accountId, data: null, error }) })
    return () => { active = false }
  }, [accountId, tick])
  useEffect(() => {
    const changed = (event: Event) => {
      if ((event as CustomEvent<{ accountId: string }>).detail?.accountId === accountId) setTick(n => n + 1)
    }
    window.addEventListener(ACCOUNT_STYLE_UPDATED, changed)
    return () => window.removeEventListener(ACCOUNT_STYLE_UPDATED, changed)
  }, [accountId])
  const current = snapshot?.accountId === accountId ? snapshot : null
  const fallback = current?.error && accountId ? remembered(accountId) : null
  if (fallback) return { data: fallback, error: null, reload, stale: true, status: 'ready' as const }
  return { data: current?.data ?? null, error: current?.error ?? null, reload, stale: false,
    status: !accountId ? 'idle' as const : !current ? 'loading' as const : current.error ? 'error' as const : 'ready' as const }
}
