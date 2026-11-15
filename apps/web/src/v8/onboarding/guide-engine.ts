'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'

/** はじめにやることの実測のうち、ガイドが見る分だけ（画面側の型を取り込まない）。 */
export type GuideSummary = { steps: ReadonlyArray<{ key: string; label: string; href: string | null; done: boolean }>; done: number; total: number }

/** ガイドの状態。idle=まだ始めていない、active=案内中、paused=一時停止、done=9項目が済み。 */
export type GuideEnginePhase = 'idle' | 'active' | 'paused' | 'done'

export type GuideEngineState = { phase: GuideEnginePhase; stepKey: string | null }

export type GuideEngineAction = 'start' | 'pause' | 'resume' | 'advance' | 'complete' | 'reset'

const initialState: GuideEngineState = { phase: 'idle', stepKey: null }

export function guideEngineStorageKey(accountId: string): string {
  return `lh:v8:guide-engine:${accountId}`
}

/** 保存した状態。壊れた値・読めない時は「まだ始めていない」に戻す（勝手に案内を出さない）。 */
export function readGuideEngineState(accountId: string | null): GuideEngineState {
  if (!accountId || typeof window === 'undefined') return initialState
  try {
    const raw = window.localStorage.getItem(guideEngineStorageKey(accountId))
    if (!raw) return initialState
    const parsed = JSON.parse(raw) as Partial<GuideEngineState> | null
    const phase = parsed?.phase
    return {
      phase: phase === 'active' || phase === 'paused' || phase === 'done' ? phase : 'idle',
      stepKey: typeof parsed?.stepKey === 'string' ? parsed.stepKey : null,
    }
  } catch { return initialState }
}

export function writeGuideEngineState(accountId: string, state: GuideEngineState): void {
  if (typeof window === 'undefined') return
  try { window.localStorage.setItem(guideEngineStorageKey(accountId), JSON.stringify(state)) } catch { /* 覚えられなくても今の操作は続ける */ }
}

/** 状態遷移表。許されない遷移は今の状態をそのまま返し、再開先を失わない。 */
export function nextGuideEngineState(current: GuideEngineState, action: GuideEngineAction, stepKey: string | null = null): GuideEngineState {
  switch (action) {
    case 'start': return current.phase === 'active' ? current : { phase: 'active', stepKey }
    case 'pause': return current.phase === 'active' ? { phase: 'paused', stepKey: current.stepKey } : current
    case 'resume': return current.phase === 'paused' ? { phase: 'active', stepKey: stepKey ?? current.stepKey } : current
    case 'advance': return current.phase === 'active' ? { phase: 'active', stepKey } : current
    case 'complete': return current.phase === 'done' ? current : { phase: 'done', stepKey: null }
    case 'reset': return initialState
  }
}

export type GuideAnchor = { key: string; label: string; href: string }

/** 次に案内する段。行き先が実在する（href がある）まだの段だけを返し、無い段は案内しない。 */
export function guideAnchor(summary: GuideSummary | null): GuideAnchor | null {
  const step = summary?.steps.find(item => !item.done && item.href)
  return step?.href ? { key: step.key, label: step.label, href: step.href } : null
}

/**
 * はじめにやることの実測（summary）に沿ってガイドを進める。
 * 完了条件は設定画面と同じ判定を使い、ガイド専用の済み判定を持たない。
 */
export function useGuideEngine(accountId: string | null, summary: GuideSummary | null) {
  const [state, setState] = useState<GuideEngineState>(initialState)
  useEffect(() => { setState(readGuideEngineState(accountId)) }, [accountId])

  const commit = useCallback((action: GuideEngineAction, stepKey: string | null = null) => {
    setState(current => {
      const next = nextGuideEngineState(current, action, stepKey)
      if (accountId && next !== current) writeGuideEngineState(accountId, next)
      return next
    })
  }, [accountId])

  const anchor = useMemo(() => guideAnchor(summary), [summary])
  const finished = Boolean(summary && summary.total > 0 && summary.done === summary.total)

  /* 9項目が済んだら案内を閉じる。まだ始めていない人の記録は作らない。 */
  useEffect(() => {
    if (!finished) return
    setState(current => {
      if (current.phase === 'idle' || current.phase === 'done') return current
      const next = nextGuideEngineState(current, 'complete')
      if (accountId) writeGuideEngineState(accountId, next)
      return next
    })
  }, [finished, accountId])

  /* 済んだ段から次の段へ進める。一時停止の間は動かさない。 */
  useEffect(() => {
    if (state.phase !== 'active' || !anchor || anchor.key === state.stepKey) return
    commit('advance', anchor.key)
  }, [state.phase, state.stepKey, anchor, commit])

  return {
    phase: state.phase,
    stepKey: state.stepKey,
    anchor: state.phase === 'done' ? null : anchor,
    pausedAnchor: state.phase === 'paused' ? anchor : null,
    start: useCallback(() => commit('start', guideAnchor(summary)?.key ?? null), [commit, summary]),
    pause: useCallback(() => commit('pause'), [commit]),
    resume: useCallback(() => commit('resume', guideAnchor(summary)?.key ?? null), [commit, summary]),
    reset: useCallback(() => commit('reset'), [commit]),
  }
}
