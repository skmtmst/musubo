'use client'

/*
  はじめにやることの状態・保存・実測だけを置く。表示の部品はここに持たない。
  画面の部品と案内の入れ物が互いを読み合わないよう、どちらもこの層だけを読む。
*/

import { useCallback, useEffect, useRef, useState } from 'react'
import { canManageRole } from '@/lib/staff-role'
import { api } from '@/lib/api'
import { useFirstRun } from '@/v8/onboarding/public/use-first-run/index'
import { doneCount, stepsForStyle, type StepResult, type StyleSetupProgress } from '@/v8/settings/public/getting-started-steps/index'
import { useStyleSetupProgress } from '@/v8/onboarding/public/style-setup-progress/index'
import { useGuideEngine, type GuideControl } from '@/v8/onboarding/public/guide-engine/index'
import { useSharedGuide } from '@/v8/onboarding/public/guide-shared/index'
import type { AccountStyle } from '@line-crm/shared'

export type FirstStepsSummary = {
  steps: Array<{ key: string; ordinal?: string; label: string; href: string | null; link: string; done: boolean; state: StepResult['state']; reason?: string }>
  done: number
  total: number
}

/** ガイドの操作だけを受け取る。完了判定は持たず、はじめにやることの実測に従う。 */
export type FirstStepsGuide = GuideControl

/** 設定画面と同じ状態・権限・行き先を使い、別の完了条件を持たない。 */
export function summarizeFirstSteps(steps: ReadonlyArray<StepResult>, style: AccountStyle | null = null, progress?: StyleSetupProgress): FirstStepsSummary {
  const displaySteps = stepsForStyle(steps, style, progress)
  /* 行の操作名は Pen v04 どおり「開く」1つに揃える。最終確認だけ「確かめる」。 */
  return { steps: displaySteps.map((step) => ({ key: step.key, ordinal: step.ordinal, label: step.title, href: step.action?.href ?? null, link: step.action ? (step.key === 'firstMessage' ? '確かめる →' : '開く →') : step.blockedReason ?? '状態を確認する', done: step.state === 'done', state: step.state, reason: step.state === 'unknown' ? step.next : undefined })), done: doneCount(displaySteps), total: displaySteps.length }
}

export function shouldShowFirstSteps(role: string | null, summary: FirstStepsSummary | null): boolean {
  return role !== null && summary !== null
}

export function firstStepsStorageKey(accountId: string): string {
  return `lh:v8:first-steps-folded:${accountId}`
}

/** 前の「閉じる」の印。押した人は畳んだ形で出す。 */
export function firstStepsLegacyDismissedKey(accountId: string): string {
  return `lh:v8:first-steps-dismissed:${accountId}`
}

/** 畳んでいるか。'1' 畳む・'0' 開く。印が無ければ前の「閉じる」を見る。 */
export function readFirstStepsFolded(accountId: string | null): boolean {
  if (!accountId || typeof window === 'undefined') return false
  try {
    const saved = window.localStorage.getItem(firstStepsStorageKey(accountId))
    if (saved === '1' || saved === '0') return saved === '1'
    return window.localStorage.getItem(firstStepsLegacyDismissedKey(accountId)) === '1'
  } catch { return false }
}

/** 最初の1通を待っている（友だち追加の時の配信は済み、最初の1通はまだ）。 */
export function waitingForFirstMessage(steps: ReadonlyArray<StepResult>): boolean {
  return steps.find((step) => step.key === 'friendAdd')?.state === 'done' && steps.find((step) => step.key === 'firstMessage')?.state === 'todo'
}

/**
 * 最初の1通を見ている間に受け取った時と、見ていない間に済んで未通知の時に知らせる。
 */
export function useFirstMessageArrived(accountId: string | null, steps: ReadonlyArray<StepResult>, ready: boolean, firstRun?: { doneSeenAt: string | null; doneSeenTracked: boolean } | null) {
  const seen = useRef<{ accountId: string | null; state: StepResult['state'] | null }>({ accountId: null, state: null })
  const [arrived, setArrived] = useState(false)
  useEffect(() => {
    if (!ready) return
    const state = steps.find((step) => step.key === 'firstMessage')?.state ?? null
    const before = seen.current
    seen.current = { accountId, state }
    if (before.accountId === accountId && before.state === 'todo' && state === 'done') setArrived(true)
  }, [accountId, steps, ready])
  useEffect(() => { setArrived(false) }, [accountId])
  const missedNotice = ready && firstRun?.doneSeenTracked === true && firstRun.doneSeenAt === null && steps.find(step => step.key === 'firstMessage')?.state === 'done'
  useEffect(() => { if (missedNotice) setArrived(true) }, [missedNotice, accountId])
  return { arrived, dismiss: useCallback(() => setArrived(false), []) }
}

export function useFirstSteps(accountId: string | null, role: string | null, options: { qrOpen?: boolean; style?: AccountStyle | null; storeId?: string | null } = {}) {
  const enabled = Boolean(accountId) && role !== null
  const [folded, setFolded] = useState(false)
  const [waiting, setWaiting] = useState(false)
  const state = useFirstRun(accountId, enabled, canManageRole(role) && (Boolean(options.qrOpen) || waiting))
  const style = options.style === undefined ? 'standard' : options.style
  const progress = useStyleSetupProgress(accountId, style, enabled, options.storeId)
  const displaySteps = stepsForStyle(state.steps, style, progress.progress)
  const summary = state.status === 'ready' && style ? summarizeFirstSteps(state.steps, style, progress.progress) : null
  /* 待つ帯（はじめにやること）が開いて見えている間だけ、最初の1通を待って読み直す。 */
  const visibleWaiting = canManageRole(role) && state.status === 'ready' && !folded && waitingForFirstMessage(state.steps)
  useEffect(() => { setWaiting(visibleWaiting) }, [visibleWaiting])
  const done = useFirstMessageArrived(accountId, state.steps, state.status === 'ready', state.firstRun)
  const recorded = useRef<string | null>(null)
  useEffect(() => {
    if (!canManageRole(role) || !done.arrived || !accountId || !state.firstRun?.doneSeenTracked || recorded.current === accountId) return
    recorded.current = accountId
    void api.gettingStarted.markFirstRunDoneSeen(accountId).catch(() => { recorded.current = null })
  }, [role, done.arrived, accountId, state.firstRun?.doneSeenTracked])
  /*
    ガイドの持ち主は全画面で1つ（GuideHost）。貸してもらえる時はそれを使い、
    同じ状態を2つの持ち主がサーバーへ書かないように自前の持ち主は動かさない。
  */
  const shared = useSharedGuide()
  const ownGuide = useGuideEngine(shared ? null : accountId, canManageRole(role) ? summary : null)
  const guide = shared?.guide ?? ownGuide
  useEffect(() => { setFolded(readFirstStepsFolded(accountId)) }, [accountId])
  const toggle = useCallback(() => {
    setFolded((current) => {
      const next = !current
      if (accountId) {
        try { window.localStorage.setItem(firstStepsStorageKey(accountId), next ? '1' : '0') } catch { /* 覚えられなくても今は畳む・開く */ }
      }
      return next
    })
  }, [accountId])
  return {
    status: !enabled ? 'idle' as const : state.status === 'loading' || progress.status === 'loading' ? 'loading' as const : state.status,
    summary: shouldShowFirstSteps(role, summary) ? summary : null, folded, toggle, error: state.error, reload: () => { state.reload(); progress.reload() },
    steps: displaySteps, progress: progress.progress, firstRun: state.firstRun, starter: state.starter, watchExpired: state.watchExpired, rewatch: state.rewatch,
    arrived: canManageRole(role) && done.arrived, dismissArrived: done.dismiss, guide,
  }
}

/** 次にやる 1 つ。まだで、行き先があるうちの最初の段。 */
export function nextFirstStepKey(summary: FirstStepsSummary): string | null {
  return summary.steps.find((step) => !step.done && step.href)?.key ?? null
}
