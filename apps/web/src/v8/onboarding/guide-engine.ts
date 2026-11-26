'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '@/lib/api'
import { guideProcedureTotal } from './guide-script'

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

/**
 * 案内を動かす側へ渡す操作の形。useGuideEngine の返り値がこれに当たる。
 * 画面側の表示用の型を取り込まず、ここを唯一の受け渡し口にする
 * （画面の部品と案内の入れ物が互いを読み合わないようにするため）。
 */
export type GuideControl = {
  phase: GuideEnginePhase
  loading?: boolean
  /** 今案内している段。サーバーが正本で、控えは最初の表示を速くするためだけに使う。 */
  stepKey: string | null
  /** 今案内している手順の番号（1から）。 */
  procedureIndex: number
  anchor: GuideAnchor | null
  pausedAnchor: GuideAnchor | null
  start: () => void
  restart?: () => void
  pause: () => void
  resume: () => void
  reset: () => void
  complete?: () => Promise<boolean>
  /** 同じ段の次の手順へ（1/3→2/3→3/3）。 */
  advanceProcedure: (skipRemainingProcedures?: boolean, targetIndex?: number) => void
  /** 選んだ段の手順1から始める。持たない呼び出し元もあるので任意。 */
  startAt?: (stepKey: string) => void
}

const initialState: GuideEngineState = { phase: 'idle', stepKey: null, procedureIndex: 1 }

export function guideEngineStorageKey(accountId: string, staffId?: string | null): string {
  return staffId ? `lh:v8:guide-engine:${accountId}:${staffId}` : `lh:v8:guide-engine:${accountId}`
}

/**
 * 手順番号を台本の範囲に収める。
 * 台本に無い番号（控えやサーバーに残った古い値）をそのまま使うと、
 * 吹き出しもガイド帯も出ない「案内が消えた」状態になる。
 * 段が分からない時は数を変えず、台本が読めてから収める。
 */
export function clampProcedureIndex(stepKey: string | null, procedureIndex: number): number {
  const index = Number.isInteger(procedureIndex) && procedureIndex >= 1 ? procedureIndex : 1
  const total = guideProcedureTotal(stepKey)
  return total > 0 ? Math.min(index, total) : index
}

/** 控えの状態。壊れた値・読めない時は「まだ始めていない」に戻す（勝手に案内を出さない）。 */
export function readGuideEngineState(accountId: string | null, staffId?: string | null): GuideEngineState {
  if (!accountId || typeof window === 'undefined') return initialState
  try {
    const raw = window.localStorage.getItem(guideEngineStorageKey(accountId, staffId))
    if (!raw) return initialState
    const parsed = JSON.parse(raw) as Partial<GuideEngineState> | null
    const phase = parsed?.phase
    const procedureIndex = parsed?.procedureIndex
    const stepKey = typeof parsed?.stepKey === 'string' ? parsed.stepKey : null
    return {
      phase: phase === 'active' || phase === 'paused' || phase === 'done' ? phase : 'idle',
      stepKey,
      procedureIndex: clampProcedureIndex(stepKey, Number.isInteger(procedureIndex) ? procedureIndex as number : 1),
    }
  } catch { return initialState }
}

/** 控えが変わった合図。全画面に1つ置く案内の入れ物が、案内中かどうかを知るために聞く。 */
export const GUIDE_ENGINE_EVENT = 'lh:v8:guide-engine'

export function writeGuideEngineState(accountId: string, state: GuideEngineState, staffId?: string | null): void {
  if (typeof window === 'undefined') return
  try { window.localStorage.setItem(guideEngineStorageKey(accountId, staffId), JSON.stringify(state)) } catch { /* 覚えられなくても今の操作は続ける */ }
  try {
    window.dispatchEvent(new CustomEvent(GUIDE_ENGINE_EVENT, { detail: { accountId, state } }))
  } catch { /* 合図が出せなくても案内そのものは続ける */ }
}

/**
 * 状態遷移表。許されない遷移は今の状態をそのまま返し、再開先を失わない。
 * 段が変わる時は現在手順を1に戻す（新しい段の手順1から案内する）。
 */
export function nextGuideEngineState(current: GuideEngineState, action: GuideEngineAction, stepKey: string | null = null, targetIndex?: number): GuideEngineState {
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
    case 'advanceProcedure': {
      if (current.phase !== 'active') return current
      /*
        台本の最後の手順では数を足さない。足すと台本に無い手順になり、
        吹き出しもガイド帯も出ない「案内が消えた」状態になる（枠14 の差し戻し）。
        最後の手順から先へは、段をまたぐ advance で進める。
      */
      const next = clampProcedureIndex(current.stepKey, Math.max(current.procedureIndex + 1, targetIndex ?? 1))
      return next === current.procedureIndex ? current : { ...current, procedureIndex: next }
    }
    case 'complete': return current.phase === 'done' ? current : { phase: 'done', stepKey: null, procedureIndex: 1 }
    case 'reset': return initialState
  }
}

export type GuideAnchor = { key: string; label: string; href: string }

function needsGuideReview(state: GuideEngineState): boolean {
  return state.stepKey === 'richMenu' || (state.stepKey === 'attributes' && state.procedureIndex === 3) ||
    state.stepKey === 'hours' ||
    (state.stepKey === 'scenario' && state.procedureIndex === 2)
}

function savedGuideAnchor(summary: GuideSummary | null, state: GuideEngineState): GuideAnchor | null {
  const step = summary?.steps.find(item => item.key === state.stepKey)
  return step?.href && (!step.done || needsGuideReview(state)) ? { key: step.key, label: step.label, href: step.href } : null
}

/** 見送った段（この案内の間だけ覚える）。済みにはしないので、設定画面のチェックは付かない。 */
const EMPTY_SKIPPED: ReadonlySet<string> = new Set<string>()

/** 案内できる段か。まだで、行き先が実在して、この案内で見送っていない段だけ。 */
function guidable(item: { key: string; href: string | null; done: boolean }, skipped: ReadonlySet<string>): boolean {
  return !item.done && Boolean(item.href) && !skipped.has(item.key)
}

/** 次に案内する段。行き先が実在する（href がある）まだの段だけを返し、無い段は案内しない。 */
export function guideAnchor(summary: GuideSummary | null, skipped: ReadonlySet<string> = EMPTY_SKIPPED): GuideAnchor | null {
  const step = summary?.steps.find(item => guidable(item, skipped))
  return step?.href ? { key: step.key, label: step.label, href: step.href } : null
}

/**
 * 段をまたいだ次の行き先。今の段より後ろを先に見て、無ければ前に戻って探す。
 * 済み判定は変えない（見送りは skipped で覚えるだけ）。案内できる段が無ければ null。
 */
export function nextGuidedStepKey(summary: GuideSummary | null, currentKey: string | null, skipped: ReadonlySet<string> = EMPTY_SKIPPED): string | null {
  const steps = summary?.steps ?? []
  const at = currentKey ? steps.findIndex(item => item.key === currentKey) : -1
  const after = steps.slice(at + 1).find(item => guidable(item, skipped))
  if (after) return after.key
  const before = steps.slice(0, Math.max(at, 0)).find(item => guidable(item, skipped))
  return before?.key ?? null
}

/** サーバーの返事を状態に直す。足りない値は既定に寄せ、案内を勝手に始めない。 */
export function guideStateFromServer(data: { phase?: unknown; stepKey?: unknown; procedureIndex?: unknown } | null | undefined): GuideEngineState {
  const phase = data?.phase
  const procedureIndex = data?.procedureIndex
  const stepKey = typeof data?.stepKey === 'string' ? data.stepKey : null
  return {
    phase: phase === 'active' || phase === 'paused' || phase === 'done' ? phase : 'idle',
    stepKey,
    procedureIndex: clampProcedureIndex(stepKey, Number.isInteger(procedureIndex) ? procedureIndex as number : 1),
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
export function useGuideEngine(accountId: string | null, summary: GuideSummary | null, scripted = true, staffId?: string | null) {
  const [state, setState] = useState<GuideEngineState>(initialState)
  const scope = accountId ? JSON.stringify([accountId, staffId]) : null
  const [loadedScope, setLoadedScope] = useState<string | null>(null)
  const loading = scope !== null && scope !== loadedScope
  /**
   * この案内の間だけ見送った段。済みにはしない（完了判定は実データ計測のまま）。
   * 覚えないと、見送った段がまた「次の案内」として選ばれて同じ所に戻ってしまう。
   */
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(EMPTY_SKIPPED)
  /** サーバーの値を受け取るまでは、控えの値で進む操作を保存しない（古い値で上書きしない）。 */
  const pending = useRef<Promise<boolean>>(Promise.resolve(true))
  const generation = useRef(0)

  useEffect(() => {
    const current = ++generation.current
    setState(readGuideEngineState(accountId, staffId))
    setLoadedScope(null)
    pending.current = Promise.resolve(true)
    if (!accountId) return
    const request = api.gettingStarted.guide.get(accountId)
      .then(response => {
        if (generation.current !== current || pending.current !== request) return
        // 読めなかった時は控えのまま続ける（案内を取り上げない）。
        if (!response?.success || !response.data) return
        const next = guideStateFromServer(response.data)
        setState(next)
        writeGuideEngineState(accountId, next, staffId)
      })
      .then(() => true, () => true)
      .finally(() => { if (generation.current === current) setLoadedScope(scope) })
    pending.current = request
    return () => { generation.current += 1 }
  }, [accountId, scope, staffId])

  const persist = useCallback((next: GuideEngineState, acknowledged = false) => {
    if (!accountId) return Promise.resolve(false)
    if (!acknowledged) writeGuideEngineState(accountId, next, staffId)
    const request = pending.current.then(async () => {
      try {
        const response = await api.gettingStarted.guide.save(accountId, {
          phase: next.phase, stepKey: next.stepKey, procedureIndex: next.procedureIndex,
        })
        if (response?.success) return true
      } catch { /* 保存されたが返答が途切れた場合に、下で読み直す。 */ }
      if (!acknowledged) return false
      try {
        const response = await api.gettingStarted.guide.get(accountId)
        return Boolean(response?.success && response.data?.phase === 'done')
      } catch { return false }
    })
    pending.current = request
    return request
  }, [accountId, staffId])

  const commit = useCallback((action: GuideEngineAction, stepKey: string | null = null, targetIndex?: number) => {
    if (loading) return
    /*
      遷移はこの場で決める。setState の関数は描画の時まで走らないことがあり、
      中で決めた値を使うと「変わっていない」と誤判定して案内が始まらない。
    */
    const previous = state
    const next = nextGuideEngineState(previous, action, stepKey, targetIndex)
    if (next === previous) return
    setState(next)
    const currentGeneration = generation.current
    const request = persist(next)
    void request.then(saved => {
      if (saved || !BLOCK_ON_SAVE_FAILURE.has(action) || generation.current !== currentGeneration || pending.current !== request) return
      setState(previous)
      if (accountId) writeGuideEngineState(accountId, previous, staffId)
    })
  }, [state, persist, accountId, loading, staffId])

  const anchor = useMemo(() => guideAnchor(summary, skipped), [summary, skipped])
  const finished = Boolean(summary && summary.total > 0 && summary.done === summary.total)
  const complete = useCallback(async () => {
    if (!accountId || loading || !finished) return false
    if (state.phase === 'done') return true
    const next = nextGuideEngineState(state, 'complete')
    const currentGeneration = generation.current
    const saved = await persist(next, true)
    if (!saved || generation.current !== currentGeneration) return false
    setState(next)
    writeGuideEngineState(accountId, next, staffId)
    return true
  }, [accountId, loading, finished, persist, staffId, state])

  /* 9項目が済んだら案内を閉じる。まだ始めていない人の記録は作らない。 */
  const reviewingCompletion = scripted && needsGuideReview(state)
  useEffect(() => {
    if (finished && !scripted && state.phase !== 'idle') commit('complete')
  }, [finished, scripted, state.phase, commit])

  /*
    済んだ段から次の段へ進める。一時停止の間は動かさない。
    今の段がまだ案内できるなら動かさない（手順の途中で別の段へ飛ばさないため）。
  */
  useEffect(() => {
    if (state.phase !== 'active' || !anchor || anchor.key === state.stepKey) return
    const current = summary?.steps.find(item => item.key === state.stepKey)
    if (current && (guidable(current, skipped) || reviewingCompletion)) return
    commit('advance', nextGuidedStepKey(summary, state.stepKey, skipped) ?? anchor.key)
  }, [state.phase, state.stepKey, reviewingCompletion, anchor, summary, skipped, commit])

  /** 手順を見送って次の段へ移る。済みにはせず、存在する次の案内へ渡す（枠14 共通ルール）。 */
  const advanceProcedure = useCallback((skipRemainingProcedures = false, targetIndex?: number) => {
    if (state.phase !== 'active') return
    const total = scripted ? guideProcedureTotal(state.stepKey) : 0
    if (state.procedureIndex < total && !skipRemainingProcedures) {
      commit('advanceProcedure', null, targetIndex)
      return
    }
    const current = state.stepKey
    const nextSkipped = current ? new Set([...skipped, current]) : skipped
    const nextKey = nextGuidedStepKey(summary, current, nextSkipped)
    if (!nextKey) {
      // 案内できる段がもう無い。完了を偽らず、再開できる形で止める。
      commit(finished ? scripted ? 'advance' : 'complete' : 'pause')
      return
    }
    if (current) setSkipped(nextSkipped)
    commit('advance', nextKey)
  }, [state, summary, skipped, commit, scripted, finished])

  return {
    loading,
    phase: loading ? 'idle' : state.phase,
    stepKey: loading ? null : state.stepKey,
    procedureIndex: loading ? 1 : state.procedureIndex,
    anchor: state.phase === 'done' ? null : anchor,
    pausedAnchor: !loading && state.phase === 'paused' ? savedGuideAnchor(summary, state) ?? anchor : null,
    /** 最初から始める時は見送りの記憶も消す（また1段目から案内する）。 */
    start: useCallback(() => { setSkipped(EMPTY_SKIPPED); commit(state.phase === 'active' ? 'advance' : 'start', guideAnchor(summary)?.key ?? null) }, [commit, summary, state.phase]),
    restart: useCallback(() => {
      const connected = summary?.steps.some(step => step.key === 'accounts' && step.done)
      const firstMenu = scripted && connected && summary?.steps.some(step => step.key === 'richMenu' && step.href)
      setSkipped(EMPTY_SKIPPED)
      commit(state.phase === 'active' ? 'advance' : 'start', firstMenu ? 'richMenu' : guideAnchor(summary)?.key ?? null)
    }, [commit, scripted, summary, state.phase]),
    /**
     * 選んだ段からガイドを始める（枠08b の行の「開く」）。
     * 止まっている時は 'start'、もう動いている時は 'advance' で段を移す。
     * どちらもその段の手順1から始まり、画面の移動は GuideHost が行う。
     */
    startAt: useCallback((stepKey: string) => {
      setSkipped(EMPTY_SKIPPED)
      commit(state.phase === 'active' ? 'advance' : 'start', stepKey)
    }, [commit, state.phase]),
    pause: useCallback(() => commit('pause'), [commit]),
    /** 続きから再開する時は見送った段を飛ばしたまま戻る。 */
    resume: useCallback(() => commit('resume', savedGuideAnchor(summary, state)?.key ?? guideAnchor(summary, skipped)?.key ?? null), [commit, summary, skipped, state]),
    complete,
    reset: useCallback(() => { setSkipped(EMPTY_SKIPPED); commit('reset') }, [commit]),
    /** 同じ段の次の手順へ。1/3→2/3→3/3。最後の手順では段をまたいで次の案内へ（枠14 の台本）。 */
    advanceProcedure,
  } satisfies GuideControl
}
