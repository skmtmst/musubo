'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type GettingStartedFirstRun, type GettingStartedStarter } from '@/lib/api'
import { loadFeatureSettings } from '@/lib/feature-settings-cache'
import { FEATURE_SETTINGS_UPDATED_EVENT, type FeatureSettingsUpdate } from '@/lib/feature-settings-event'
import { ACCOUNT_STYLE_UPDATED } from '@/hooks/use-account-style'
import { buildStepsFromApi, featureSetEntry, insertFeatureSet, type StepResult } from '@/v8/settings/public/steps/index'

/** 最初の10分の時刻（Worker が日本時間の文字で返す）。 */
export type FirstRunTimes = GettingStartedFirstRun

/** 最初の1通を待つ間の読み直しの間隔と、止めるまでの長さ。 */
export const FIRST_RUN_WATCH_INTERVAL_MS = 10_000
export const FIRST_RUN_WATCH_LIMIT_MS = 15 * 60_000

/** ダッシュボードと設定の完了条件の正本は同じ V8 API。訪問・招待人数では判定しない。 */
type FirstRunLoad = { steps: StepResult[]; firstRun: FirstRunTimes | null; starter: GettingStartedStarter | null; dismissed: boolean }

export async function loadFirstRun(accountId: string | null): Promise<FirstRunLoad> {
  const res = await api.gettingStarted.get(accountId ?? undefined, 'v8')
  if (!res.success) throw new Error(res.error)
  const { firstRun, starter } = res.data
  const dismissed = res.data.dismissed === true
  const steps = buildStepsFromApi(res.data.steps)
  if (res.data.steps.some((step) => step.key === 'featureSet')) return { steps, firstRun, starter, dismissed }
  // 更新途中の Worker でも未取得は未確認。保存済みの機能設定だけで補う。
  let entry = null
  if (accountId) {
    const features = await loadFeatureSettings(accountId)
    if (!features.success) throw new Error(features.error)
    entry = featureSetEntry({ forbidden: false, version: features.data.version ?? 0 })
  }
  return { steps: insertFeatureSet(steps, entry), firstRun, starter, dismissed }
}

export async function loadFirstRunSteps(accountId: string | null): Promise<StepResult[]> {
  return (await loadFirstRun(accountId)).steps
}

type Snapshot =
  | ({ accountId: string | null; scope: string; status: 'ready'; error: null } & FirstRunLoad)
  | { accountId: string | null; scope: string; status: 'error'; error: unknown }

type Revalidation =
  | { accountId: string | null; scope: string; status: 'loading'; error: null }
  | { accountId: string | null; scope: string; status: 'error'; error: unknown }

/**
 * はじめにやることの状態。開いた時のほか、タブが前に戻った時・スタイルや機能の設定を保存した時に読み直す。
 * `watch` の間（QR の窓・最初の1通を待つ帯）は 10 秒ごとに読み直し、タブが裏の間は止める。
 * 15 分たったら止めて `watchExpired` を立てる（［もう一度確かめる］で `rewatch`）。
 * 後ろで読み直す時は今の表示を消さない（読み込み中に戻さない）。
 */
export function useFirstRun(accountId: string | null, enabled = true, watch = false, cacheScope?: string, preload = false) {
  const scope = JSON.stringify([accountId, cacheScope])
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [revalidation, setRevalidation] = useState<Revalidation | null>(null)
  const [tick, setTick] = useState(0)
  const [watchRound, setWatchRound] = useState(0)
  const [watchExpired, setWatchExpired] = useState(false)
  const generation = useRef(0)
  const pendingReload = useRef(false)
  const cached = useRef<Snapshot | null>(null)
  const inFlight = useRef<{ scope: string; promise: Promise<FirstRunLoad> } | null>(null)
  const needsRefresh = useRef(false)
  const wasDisabled = useRef(!enabled)
  const markStale = useCallback(() => {
    needsRefresh.current = true
    inFlight.current = null
    if (!enabled) return
    generation.current += 1
    setRevalidation({ accountId, scope, status: 'loading', error: null })
  }, [accountId, enabled, scope])
  const invalidate = useCallback(() => { generation.current += 1; inFlight.current = null; cached.current = null; setRevalidation(null); setSnapshot(null) }, [])
  const reload = useCallback(() => { pendingReload.current = true; invalidate(); setTick((n) => n + 1) }, [invalidate])
  const refresh = useCallback(() => {
    needsRefresh.current = true
    inFlight.current = null
    if (!enabled || pendingReload.current) return
    const at = ++generation.current
    void loadFirstRun(accountId).then((loaded) => {
      if (generation.current === at) {
        needsRefresh.current = false
        cached.current = { accountId, scope, ...loaded, status: 'ready', error: null }
        setRevalidation(null)
        setSnapshot(cached.current)
      }
    }).catch((error: unknown) => {
      /* 後ろの読み直しの失敗では、札用の直前の表示は消さず、保存後の再確認と未取得は失敗として記録する。 */
      if (generation.current !== at) return
      setRevalidation((prev) => (prev?.scope === scope ? { accountId, scope, status: 'error', error } : null))
      setSnapshot((prev) => (prev?.scope === scope && prev.status === 'ready' ? prev : { accountId, scope, status: 'error', error }))
    })
  }, [accountId, enabled, scope])
  useEffect(() => {
    const at = ++generation.current
    if (!enabled) {
      wasDisabled.current = true
      if (preload && accountId && !pendingReload.current && !needsRefresh.current
        && cached.current?.scope !== scope && inFlight.current?.scope !== scope) {
        const promise = loadFirstRun(accountId)
        const currentFlight = { scope, promise }
        inFlight.current = currentFlight
        void promise.then(
          loaded => {
            if (inFlight.current === currentFlight) {
              inFlight.current = null
              cached.current = { accountId, scope, ...loaded, status: 'ready', error: null }
            }
          },
          () => {
            if (inFlight.current === currentFlight) inFlight.current = null
          },
        )
      }
      return
    }
    wasDisabled.current = false
    if (!pendingReload.current && !needsRefresh.current && cached.current?.scope === scope && cached.current.status === 'ready') {
      setSnapshot(cached.current)
      return () => { generation.current += 1 }
    }
    const flight = !pendingReload.current && !needsRefresh.current && inFlight.current?.scope === scope ? inFlight.current : null
    pendingReload.current = false
    setRevalidation(null)
    setSnapshot(null)
    cached.current = null
    const promise = flight ? flight.promise : loadFirstRun(accountId)
    if (!flight) inFlight.current = null
    void promise.then((loaded) => {
      if (inFlight.current === flight) inFlight.current = null
      if (generation.current === at) {
        needsRefresh.current = false
        cached.current = { accountId, scope, ...loaded, status: 'ready', error: null }
        setSnapshot(cached.current)
      }
    }).catch((error: unknown) => {
      if (inFlight.current === flight) inFlight.current = null
      if (generation.current === at) setSnapshot({ accountId, scope, status: 'error', error })
    })
    return () => { generation.current += 1 }
  }, [accountId, enabled, preload, tick, scope])
  useEffect(() => {
    const featureSaved = (event: Event) => {
      const detail = (event as CustomEvent<FeatureSettingsUpdate>).detail
      if (detail?.source !== 'account-style' && (!detail?.accountId || detail.accountId === accountId)) refresh()
    }
    window.addEventListener(FEATURE_SETTINGS_UPDATED_EVENT, featureSaved)
    return () => window.removeEventListener(FEATURE_SETTINGS_UPDATED_EVENT, featureSaved)
  }, [accountId, refresh])
  useEffect(() => {
    const styleSaved = (event: Event) => { if ((event as CustomEvent<{ accountId: string }>).detail?.accountId === accountId) refresh() }
    const visible = () => { if (document.visibilityState === 'visible') refresh() }
    window.addEventListener(ACCOUNT_STYLE_UPDATED, styleSaved)
    document.addEventListener('visibilitychange', visible)
    return () => {
      window.removeEventListener(ACCOUNT_STYLE_UPDATED, styleSaved)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [accountId, refresh])
  useEffect(() => { if (!watch) setWatchExpired(false) }, [watch])
  useEffect(() => {
    if (!enabled || !watch || watchExpired) return
    const startedAt = Date.now()
    let timer: ReturnType<typeof setInterval> | null = null
    const stop = () => { if (timer !== null) { clearInterval(timer); timer = null } }
    const tickOnce = () => {
      if (Date.now() - startedAt >= FIRST_RUN_WATCH_LIMIT_MS) { stop(); setWatchExpired(true); return }
      refresh()
    }
    const start = () => { if (timer === null && document.visibilityState === 'visible') timer = setInterval(tickOnce, FIRST_RUN_WATCH_INTERVAL_MS) }
    const changed = () => { if (document.visibilityState === 'visible') start(); else stop() }
    start()
    document.addEventListener('visibilitychange', changed)
    return () => { stop(); document.removeEventListener('visibilitychange', changed) }
  }, [enabled, watch, watchExpired, watchRound, refresh])
  const rewatch = useCallback(() => { setWatchExpired(false); setWatchRound((n) => n + 1); refresh() }, [refresh])
  const current = enabled && !(wasDisabled.current && (needsRefresh.current || pendingReload.current)) && snapshot?.scope === scope ? snapshot : null
  const currentRevalidation = enabled && revalidation?.scope === scope ? revalidation : null
  return {
    steps: current?.status === 'ready' ? current.steps : [],
    firstRun: current?.status === 'ready' ? current.firstRun : null,
    dismissed: current?.status === 'ready' ? current.dismissed : null,
    starter: current?.status === 'ready' ? current.starter : null,
    status: current?.status ?? 'loading' as const,
    revalidating: currentRevalidation?.status === 'loading',
    revalidationStatus: currentRevalidation?.status ?? 'idle' as const,
    revalidationError: currentRevalidation?.status === 'error' ? currentRevalidation.error : null,
    error: current?.error ?? null,
    reload,
    invalidate,
    markStale,
    refresh,
    watchExpired: watch && watchExpired,
    rewatch,
  }
}
