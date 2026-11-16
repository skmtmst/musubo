'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '@/lib/api'

/** はじめにやることの実測のうち、ガイドが見る分だけ（画面側の型を取り込まない）。 */
export type GuideSummary = { steps: ReadonlyArray<{ key: string; label: string; href: string | null; done: boolean }>; done: number; total: number }

/** ガイドの状態。idle=まだ始めていない、active=案内中、paused=一時停止、done=9項目が済み。 */
export type GuideEnginePhase = 'idle' | 'active' | 'paused' | 'done'

/*
  承認済み Pen /Users/masatosakamoto/Documents/musubo-course-media-upload-20261110.pen
  枠 14 (orKSi) の L3lP08 が持たせる3つ:
  有効/一時停止(phase)・現在ステップ(stepKey)・現在手順(procedureIndex)。
  **これはユーザー×アカウントでサーバーに置く**（`/api/getting-started/guide`）。
  localStorage は初回表示を速くするための控えで、読み込み後はサーバーの値で上書きする。

  9項目の済み判定はここに入れない。完了は常に実データ計測 (setup-progress) で、
  ガイドを使わずに設定してもチェックは付く（同 L3lP08）。
*/
export type GuideEngineState = { phase: GuideEnginePhase; stepKey: string | null; procedureIndex: number }

export type GuideEngineAction = 'start' | 'pause' | 'resume' | 'advance' | 'advanceProcedure' | 'complete' | 'reset'

const initialState: GuideEngineState = { phase: 'idle', stepKey: null, procedureIndex: 1 }

export function guideEngineStorageKey(accountId: string): string {
  return `lh:v8:guide-engine:${accountId}`
}

/** 控えの状態。壊れた値・読めない時は「まだ始めていない」に戻す（勝手に案内を出さない）。 */
export function readGuideEngineState(accountId: string | null): GuideEngineState {
  if (!accountId || typeof window === 'undefined') return initialState
  try {
    const raw = window.localStorage.getItem(guideEngineStorageKey(accountId))
    if (!raw) return initialState
    const parsed = JSON.parse(raw) as Partial<GuideEngineState> | null
    const phase = parsed?.phase
    const procedureIndex = parsed?.procedureIndex
    return {
      phase: phase === 'active' || phase === 'paused' || phase === 'done' ? phase : 'idle',
      stepKey: typeof parsed?.stepKey === 'string' ? parsed.stepKey : null,
      procedureIndex: Number.isInteger(procedureIndex) && (procedureIndex as number) >= 1 ? procedureIndex as number : 1,
    }
  } catch { return initialState }
}

/** 控えが変わった合図。全画面に1つ置く案内の入れ物が、案内中かどうかを知るために聞く。 */
export const GUIDE_ENGINE_EVENT = 'lh:v8:guide-engine'

export function writeGuideEngineState(accountId: string, state: GuideEngineState): void {
  if (typeof window === 'undefined') return
  try { window.localStorage.setItem(guideEngineStorageKey(accountId), JSON.stringify(state)) } catch { /* 覚えられなくても今の操作は続ける */ }
  try {
    window.dispatchEvent(new CustomEvent(GUIDE_ENGINE_EVENT, { detail: { accountId, state } }))
  } catch { /* 合図が出せなくても案内そのものは続ける */ }
}

/**
 * 状態遷移表。許されない遷移は今の状態をそのまま返し、再開先を失わない。
 * 段が変わる時は現在手順を1に戻す（新しい段の手順1から案内する）。
 */
export function nextGuideEngineState(current: GuideEngineState, action: GuideEngineAction, stepKey: string | null = null): GuideEngineState {
  switch (action) {
    case 'start': return current.phase === 'active' ? current : { phase: 'active', stepKey, procedureIndex: 1 }
    case 'pause': return current.phase === 'active' ? { ...current, phase: 'paused' } : current
    case 'resume': {
      if (current.phase !== 'paused') return current
      const next = stepKey ?? current.stepKey
      // 止めた段へ戻るなら手順も止めた所から。別の段へ移るなら手順1から。
      return { phase: 'active', stepKey: next, procedureIndex: next === current.stepKey ? current.procedureIndex : 1 }
    }
    case 'advance': return current.phase === 'active' ? { phase: 'active', stepKey, procedureIndex: 1 } : current
    case 'advanceProcedure': return current.phase === 'active' ? { ...current, procedureIndex: current.procedureIndex + 1 } : current
    case 'complete': return current.phase === 'done' ? current : { phase: 'done', stepKey: null, procedureIndex: 1 }
    case 'reset': return initialState
  }
}

export type GuideAnchor = { key: string; label: string; href: string }

/** 次に案内する段。行き先が実在する（href がある）まだの段だけを返し、無い段は案内しない。 */
export function guideAnchor(summary: GuideSummary | null): GuideAnchor | null {
  const step = summary?.steps.find(item => !item.done && item.href)
  return step?.href ? { key: step.key, label: step.label, href: step.href } : null
}

/** サーバーの返事を状態に直す。足りない値は既定に寄せ、案内を勝手に始めない。 */
export function guideStateFromServer(data: { phase?: unknown; stepKey?: unknown; procedureIndex?: unknown } | null | undefined): GuideEngineState {
  const phase = data?.phase
  const procedureIndex = data?.procedureIndex
  return {
    phase: phase === 'active' || phase === 'paused' || phase === 'done' ? phase : 'idle',
    stepKey: typeof data?.stepKey === 'string' ? data.stepKey : null,
    procedureIndex: Number.isInteger(procedureIndex) && (procedureIndex as number) >= 1 ? procedureIndex as number : 1,
  }
}

/** 保存に失敗したら進めない行い（枠14 共通ルール「保存・通信の失敗時は進めない」）。 */
const BLOCK_ON_SAVE_FAILURE: ReadonlySet<GuideEngineAction> = new Set(['advance', 'advanceProcedure'])

/**
 * はじめにやることの実測（summary）に沿ってガイドを進める。
 * 完了条件は設定画面と同じ判定を使い、ガイド専用の済み判定を持たない。
 *
 * 進行状態はサーバーが正本。開いた直後は控えを見せ、読み込めたらサーバーの値に合わせる。
 * 進む操作は保存できた時だけ確定し、保存に失敗した時は元の所に戻す。
 */
export function useGuideEngine(accountId: string | null, summary: GuideSummary | null) {
  const [state, setState] = useState<GuideEngineState>(initialState)
  /** サーバーの値を受け取るまでは、控えの値で進む操作を保存しない（古い値で上書きしない）。 */
  const loaded = useRef(false)

  useEffect(() => {
    loaded.current = false
    setState(readGuideEngineState(accountId))
    if (!accountId) return
    let live = true
    void api.gettingStarted.guide.get(accountId)
      .then(response => {
        if (!live) return
        // 読めなかった時は控えのまま続ける（案内を取り上げない）。
        if (!response?.success || !response.data) return
        const next = guideStateFromServer(response.data)
        setState(next)
        writeGuideEngineState(accountId, next)
      })
      .catch(() => { /* 通信できなくても控えで案内は続ける */ })
      .finally(() => { if (live) loaded.current = true })
    return () => { live = false }
  }, [accountId])

  const persist = useCallback(async (next: GuideEngineState) => {
    if (!accountId) return true
    writeGuideEngineState(accountId, next)
    if (!loaded.current) return true
    try {
      const response = await api.gettingStarted.guide.save(accountId, {
        phase: next.phase, stepKey: next.stepKey, procedureIndex: next.procedureIndex,
      })
      return Boolean(response?.success)
    } catch { return false }
  }, [accountId])

  const commit = useCallback((action: GuideEngineAction, stepKey: string | null = null) => {
    /*
      遷移はこの場で決める。setState の関数は描画の時まで走らないことがあり、
      中で決めた値を使うと「変わっていない」と誤判定して案内が始まらない。
    */
    const previous = state
    const next = nextGuideEngineState(previous, action, stepKey)
    if (next === previous) return
    setState(next)
    void persist(next).then(saved => {
      if (saved || !BLOCK_ON_SAVE_FAILURE.has(action)) return
      // 保存できなかった進行は取り消す。見た目だけ進んで記録が残らない状態を作らない。
      setState(current => (current === next ? previous : current))
      if (accountId) writeGuideEngineState(accountId, previous)
    })
  }, [state, persist, accountId])

  const anchor = useMemo(() => guideAnchor(summary), [summary])
  const finished = Boolean(summary && summary.total > 0 && summary.done === summary.total)

  /* 9項目が済んだら案内を閉じる。まだ始めていない人の記録は作らない。 */
  useEffect(() => {
    if (!finished) return
    setState(current => {
      if (current.phase === 'idle' || current.phase === 'done') return current
      const next = nextGuideEngineState(current, 'complete')
      void persist(next)
      return next
    })
  }, [finished, persist])

  /* 済んだ段から次の段へ進める。一時停止の間は動かさない。 */
  useEffect(() => {
    if (state.phase !== 'active' || !anchor || anchor.key === state.stepKey) return
    commit('advance', anchor.key)
  }, [state.phase, state.stepKey, anchor, commit])

  return {
    phase: state.phase,
    stepKey: state.stepKey,
    procedureIndex: state.procedureIndex,
    anchor: state.phase === 'done' ? null : anchor,
    pausedAnchor: state.phase === 'paused' ? anchor : null,
    start: useCallback(() => commit('start', guideAnchor(summary)?.key ?? null), [commit, summary]),
    pause: useCallback(() => commit('pause'), [commit]),
    resume: useCallback(() => commit('resume', guideAnchor(summary)?.key ?? null), [commit, summary]),
    reset: useCallback(() => commit('reset'), [commit]),
    /** 同じ段の次の手順へ。1/3→2/3→3/3（枠14 の台本）。 */
    advanceProcedure: useCallback(() => commit('advanceProcedure'), [commit]),
  }
}
