'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { AccountStyle } from '@line-crm/shared'
import { ACCOUNT_STYLE_UPDATED } from '@/hooks/use-account-style'
import { FEATURE_SETTINGS_UPDATED_EVENT, type FeatureSettingsUpdate } from '@/lib/feature-settings-event'
import type { StyleSetupProgress } from '@/v8/settings/public/getting-started-steps/index'
import { loadStyleSetupProgress, unknownStyleSetupProgress } from './style-setup-progress'

type Revalidation =
  | { scope: string; status: 'loading'; error: null }
  | { scope: string; status: 'error'; error: unknown }

/** 店とスタイルを切り替えた直後に、前の設定を「済み」として見せない。 */
export function useStyleSetupProgress(accountId: string | null, style: AccountStyle | null, enabled = true, storeId?: string | null) {
  const scope = JSON.stringify([accountId, style, storeId])
  const activeScope = enabled && accountId && style ? scope : null
  const [snapshot, setSnapshot] = useState<{ scope: string; progress: StyleSetupProgress } | null>(null)
  const [revalidation, setRevalidation] = useState<Revalidation | null>(null)
  const [tick, setTick] = useState(0)
  const generation = useRef(0)
  const pendingReload = useRef(false)
  const prevScope = useRef<string | null>(activeScope)
  const markStale = useCallback(() => {
    if (!activeScope) return
    generation.current += 1
    setRevalidation({ scope: activeScope, status: 'loading', error: null })
  }, [activeScope])
  const invalidate = useCallback(() => { generation.current += 1; setRevalidation(null); setSnapshot(null) }, [])
  const reload = useCallback(() => { pendingReload.current = true; invalidate(); setTick(value => value + 1) }, [invalidate])
  const refresh = useCallback(() => {
    if (!enabled || !accountId || !style || pendingReload.current) return
    const currentScope = JSON.stringify([accountId, style, storeId])
    const at = ++generation.current
    void loadStyleSetupProgress(accountId, style, storeId).then(progress => {
      if (generation.current === at) {
        setRevalidation(null)
        setSnapshot({ scope: currentScope, progress })
      }
    }).catch((error: unknown) => {
      if (generation.current !== at) return
      setRevalidation(prev => (prev?.scope === currentScope ? { scope: currentScope, status: 'error', error } : null))
      setSnapshot(prev => (prev?.scope === currentScope ? prev : { scope: currentScope, progress: unknownStyleSetupProgress(style, '設定を読み込めていません。もう一度読み直してください') }))
    })
  }, [accountId, enabled, storeId, style])
  useEffect(() => {
    pendingReload.current = false
    let active = true
    const at = ++generation.current
    if (prevScope.current !== activeScope) {
      prevScope.current = activeScope
      setRevalidation(null)
      setSnapshot(null)
    }
    if (!activeScope || !accountId || !style) return
    void loadStyleSetupProgress(accountId, style, storeId).then(progress => {
      if (active && generation.current === at) {
        setRevalidation(null)
        setSnapshot({ scope: activeScope, progress })
      }
    }).catch(() => {
      if (active && generation.current === at) {
        setRevalidation(null)
        setSnapshot({ scope: activeScope, progress: unknownStyleSetupProgress(style, '設定を読み込めていません。もう一度読み直してください') })
      }
    })
    return () => { active = false; generation.current += 1 }
  }, [accountId, style, enabled, activeScope, tick, storeId])
  useEffect(() => {
    const onStyleOrVisible = (event: Event) => {
      if (event.type === 'visibilitychange' ? document.visibilityState === 'visible' : (event as CustomEvent<{ accountId: string }>).detail?.accountId === accountId) refresh()
    }
    const onFeatureSaved = (event: Event) => {
      const detail = (event as CustomEvent<FeatureSettingsUpdate>).detail
      if (detail?.source !== 'account-style' && (!detail?.accountId || detail.accountId === accountId)) refresh()
    }
    window.addEventListener(ACCOUNT_STYLE_UPDATED, onStyleOrVisible)
    window.addEventListener(FEATURE_SETTINGS_UPDATED_EVENT, onFeatureSaved)
    document.addEventListener('visibilitychange', onStyleOrVisible)
    return () => {
      window.removeEventListener(ACCOUNT_STYLE_UPDATED, onStyleOrVisible)
      window.removeEventListener(FEATURE_SETTINGS_UPDATED_EVENT, onFeatureSaved)
      document.removeEventListener('visibilitychange', onStyleOrVisible)
    }
  }, [accountId, refresh])
  const currentRevalidation = activeScope && revalidation?.scope === activeScope ? revalidation : null
  return {
    status: !activeScope ? 'idle' as const : snapshot?.scope === activeScope ? 'ready' as const : 'loading' as const,
    revalidating: currentRevalidation?.status === 'loading',
    revalidationStatus: currentRevalidation?.status ?? 'idle' as const,
    revalidationError: currentRevalidation?.status === 'error' ? currentRevalidation.error : null,
    progress: activeScope && snapshot?.scope === activeScope ? snapshot.progress : style ? unknownStyleSetupProgress(style) : undefined,
    invalidate,
    markStale,
    refresh,
    reload,
  }
}
