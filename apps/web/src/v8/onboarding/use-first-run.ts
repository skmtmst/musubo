'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type GettingStartedFirstRun, type GettingStartedStarter } from '@/lib/api'
import { loadFeatureSettings } from '@/lib/feature-settings-cache'
import { FEATURE_SETTINGS_UPDATED_EVENT } from '@/lib/feature-settings'
import { ACCOUNT_STYLE_UPDATED } from '@/hooks/use-account-style'
import { buildStepsFromApi, featureSetEntry, insertFeatureSet, type StepResult } from '@/v8/settings/public/steps/index'

/** 最初の10分の時刻（Worker が日本時間の文字で返す）。 */
export type FirstRunTimes = GettingStartedFirstRun

/** 最初の1通を待つ間の読み直しの間隔と、止めるまでの長さ。 */
export const FIRST_RUN_WATCH_INTERVAL_MS = 10_000
export const FIRST_RUN_WATCH_LIMIT_MS = 15 * 60_000

/** ダッシュボードと設定の完了条件の正本は同じ V8 API。訪問・招待人数では判定しない。 */
type FirstRunLoad = { steps: StepResult[]; firstRun: FirstRunTimes | null; starter: GettingStartedStarter | null }

export async function loadFirstRun(accountId: string | null): Promise<FirstRunLoad> {
  const res = await api.gettingStarted.get(accountId ?? undefined, 'v8')
  if (!res.success) throw new Error(res.error)
  const { firstRun, starter } = res.data
  const steps = buildStepsFromApi(res.data.steps)
  if (res.data.steps.some((step) => step.key === 'featureSet')) return { steps, firstRun, starter }
  // 更新途中の Worker でも未取得は未確認。保存済みの機能設定だけで補う。
  let entry = null
  if (accountId) {
    const features = await loadFeatureSettings(accountId)
    if (!features.success) throw new Error(features.error)
    entry = featureSetEntry({ forbidden: false, version: features.data.version ?? 0 })
  }
  return { steps: insertFeatureSet(steps, entry), firstRun, starter }
}

export async function loadFirstRunSteps(accountId: string | null): Promise<StepResult[]> {
  return (await loadFirstRun(accountId)).steps
}

type Snapshot =
  | ({ accountId: string | null; status: 'ready'; error: null } & FirstRunLoad)
  | { accountId: string | null; status: 'error'; error: unknown }

/**
 * はじめにやることの状態。開いた時のほか、タブが前に戻った時・スタイルや機能の設定を保存した時に読み直す。
 * `watch` の間（QR の窓・最初の1通を待つ帯）は 10 秒ごとに読み直し、タブが裏の間は止める。
 * 15 分たったら止めて `watchExpired` を立てる（［もう一度確かめる］で `rewatch`）。
 * 後ろで読み直す時は今の表示を消さない（読み込み中に戻さない）。
 */
export function useFirstRun(accountId: string | null, enabled = true, watch = false) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [tick, setTick] = useState(0)
  const [watchRound, setWatchRound] = useState(0)
  const [watchExpired, setWatchExpired] = useState(false)
  const generation = useRef(0)
  const reload = useCallback(() => { generation.current += 1; setSnapshot(null); setTick((n) => n + 1) }, [])
  const refresh = useCallback(() => {
    if (!enabled) return
    const at = ++generation.current
    void loadFirstRun(accountId).then((loaded) => {
      if (generation.current === at) setSnapshot({ accountId, ...loaded, status: 'ready', error: null })
    }).catch(() => { /* 後ろの読み直しの失敗では、読めている表示を消さない。次の読み直しで戻る。 */ })
  }, [accountId, enabled])
  useEffect(() => {
    const at = ++generation.current
    setSnapshot(null)
    if (!enabled) return
    void loadFirstRun(accountId).then((loaded) => {
      if (generation.current === at) setSnapshot({ accountId, ...loaded, status: 'ready', error: null })
    }).catch((error: unknown) => {
      if (generation.current === at) setSnapshot({ accountId, status: 'error', error })
    })
    return () => { generation.current += 1 }
  }, [accountId, enabled, tick])
  useEffect(() => {
    window.addEventListener(FEATURE_SETTINGS_UPDATED_EVENT, reload)
    return () => window.removeEventListener(FEATURE_SETTINGS_UPDATED_EVENT, reload)
  }, [reload])
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
  const current = enabled && snapshot?.accountId === accountId ? snapshot : null
  return {
    steps: current?.status === 'ready' ? current.steps : [],
    firstRun: current?.status === 'ready' ? current.firstRun : null,
    starter: current?.status === 'ready' ? current.starter : null,
    status: current?.status ?? 'loading' as const,
    error: current?.error ?? null,
    reload,
    refresh,
    watchExpired: watch && watchExpired,
    rewatch,
  }
}
