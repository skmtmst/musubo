'use client'

import { isSelectableScenarioTemplate } from './question-template-model'

import { type ScenarioQuestion } from '@/components/scenarios/question-editor'
import { scenarioReferenceData } from '@/components/scenarios/scenario-reference-data'
import { useSaveFormErrors } from '@/components/shared/save-form-errors'
import { api, ApiError, type ScenarioRuns, type ScenarioTriggerItem } from '@/lib/api'
import type { ScenarioTriggerType } from '@line-crm/shared'
import type { Dispatch, RefObject, SetStateAction } from 'react'
import { useCallback, useEffect, useLayoutEffect } from 'react'
import { ScenarioStats, ScenarioWithSteps, TagOpt, TemplateOpt } from './detail-model'
import { scenarioSimulationKey, simulationForKey, type ScenarioSimulationResult } from './scenario-simulation-refresh'

export function useScenarioReads({
  setLoading, setError, setScenarioMissing, id,
  setScenario, shownUpdatedAtRef, setConflict, setEditForm,
  saveErrors, loading, scenario, setConflictLatest,
  setStats, setTemplates, setTags, setActionCounts,
  triggerCount, triggerRevision, simulationResult, setSimulationResult,
  setRuns, simRetry, setTriggerCount, setTriggerItems,
  setPreviewLabels,
}: {
  setLoading: Dispatch<SetStateAction<boolean>>
  setError: Dispatch<SetStateAction<string>>
  setScenarioMissing: Dispatch<SetStateAction<boolean>>
  id: string
  setScenario: Dispatch<SetStateAction<ScenarioWithSteps | null>>
  shownUpdatedAtRef: RefObject<string | null>
  setConflict: Dispatch<SetStateAction<boolean>>
  setEditForm: Dispatch<SetStateAction<{ name: string; description: string; triggerType: ScenarioTriggerType; isActive: boolean; allowConcurrent: boolean; folderId: string; }>>
  saveErrors: ReturnType<typeof useSaveFormErrors>
  loading: boolean
  scenario: ScenarioWithSteps | null
  setConflictLatest: Dispatch<SetStateAction<ScenarioWithSteps | null>>
  setStats: Dispatch<SetStateAction<ScenarioStats | null>>
  setTemplates: Dispatch<SetStateAction<TemplateOpt[]>>
  setTags: Dispatch<SetStateAction<TagOpt[]>>
  setActionCounts: Dispatch<SetStateAction<Record<string, number>>>
  triggerCount: number | null
  triggerRevision: number
  simulationResult: ScenarioSimulationResult | null
  setSimulationResult: Dispatch<SetStateAction<ScenarioSimulationResult | null>>
  setRuns: Dispatch<SetStateAction<ScenarioRuns | null>>
  simRetry: number
  setTriggerCount: Dispatch<SetStateAction<number | null>>
  setTriggerItems: Dispatch<SetStateAction<ScenarioTriggerItem[] | null>>
  setPreviewLabels: Dispatch<SetStateAction<Record<number, string>>>
}) {
  const loadScenario = useCallback(async (fresh = false) => {
    setLoading(true)
    setError('')
    setScenarioMissing(false)
    try {
      const res = await scenarioReferenceData.scenario(id, fresh)
      if (res.success) {
        setScenario(res.data)
        // 今見せている版を覚える。ほかの人の更新は更新日時のずれで見つける。
        shownUpdatedAtRef.current = res.data.updatedAt ?? null
        setConflict(false)
        setEditForm({
          name: res.data.name,
          description: res.data.description ?? '',
          triggerType: res.data.triggerType,
          isActive: res.data.isActive,
          allowConcurrent: res.data.allowConcurrent !== false,
          folderId: res.data.folderId ?? '',
        })
      } else {
        setError(res.error)
      }
    } catch (caught) {
      const fieldFailure = saveErrors.capture(caught);

      if (caught instanceof ApiError && caught.status === 404) {
        setScenarioMissing(true)
      } else {
        { if (!fieldFailure)

        setError('シナリオの読み込みに失敗しました。もう一度読み込んでください。') }
      }
    } finally {
      setLoading(false)
    }
  }, [id, saveErrors, setConflict, setEditForm, setError, setLoading, setScenario, setScenarioMissing, shownUpdatedAtRef])

  useEffect(() => {
    loadScenario()
  }, [loadScenario])

  /*
   * ★V8 ：別のタブから戻ってきたら更新日時だけ確かめる。
   * ずれていたら帯を出すだけで、画面は書き換えない。
   */
  useEffect(() => {
    if (loading || !scenario) return
    const recheck = () => {
      if (document.visibilityState !== 'visible') return
      void (async () => {
        try {
          const detail = await api.scenarios.get(id)
          if (!detail.success) return
          const shown = shownUpdatedAtRef.current
          const latest = detail.data.updatedAt ?? null
          if (shown !== null && latest !== null && latest !== shown) {
            setConflict(true)
            setConflictLatest(detail.data)
          }
        } catch (saveFailure) {
          saveErrors.capture(saveFailure)
          // 取れなくても今の画面は残す。次の機会に確かめる。
        }
      })()
    }
    const onVisible = () => recheck()
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', recheck)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', recheck)
    }
  }, [id, loading, scenario, saveErrors, setConflict, setConflictLatest, shownUpdatedAtRef])

  const scenarioLoaded = scenario !== null
  const referenceAccountId = scenario?.lineAccountId
  const previewUpdatedAt = scenario?.updatedAt

  // 並列で stats / templates / tags を取得（リグレッションを起こさないよう失敗は無視）
  useEffect(() => {
    if (!id || !scenarioLoaded) return
    let cancelled = false
    Promise.all([
      scenarioReferenceData.stats(id).catch(() => null),
      scenarioReferenceData.templates(referenceAccountId).catch(() => null),
      scenarioReferenceData.tags(referenceAccountId).catch(() => null),
    ]).then(([statsRes, tplRes, tagRes]) => {
      if (cancelled) return
      if (statsRes && statsRes.success) setStats(statsRes.data)
      if (tplRes && tplRes.success) {
        setTemplates(tplRes.data
          .filter(isSelectableScenarioTemplate)
          .map((t) => ({
          id: t.id,
          name: t.name,
          category: t.category,
          messageType: t.messageType,
          messageContent: t.messageContent,
          question: (t.question as ScenarioQuestion | null) ?? null,
        })))
      }
      if (tagRes && tagRes.success) {
        setTags(tagRes.data.map((t) => ({ id: t.id, name: t.name })))
      }
    })
    return () => { cancelled = true }
  }, [id, referenceAccountId, scenarioLoaded, setStats, setTags, setTemplates])

  /**
   * 通ごとのアクション件数。行に「アクション 2」と出すために引く。
   * 件数が見えないと、設定したことを忘れて二重に足す。
   */
  const reloadActionCounts = useCallback(() => {
    api.scenarios.actions
      .list(id)
      .then((res) => {
        if (!res.success) return
        const counts: Record<string, number> = Object.create(null)
        for (const action of res.data) {
          const key = action.hook === 'scenario_completed' ? '__complete__' : (action.stepId ?? '')
          if (!key) continue
          counts[key] = (counts[key] ?? 0) + 1
        }
        setActionCounts(counts)
      })
      .catch(() => {})
  }, [id, setActionCounts])

  // 初回表示とシナリオ切替時にも、未取得の識別子を数として扱わない。
  useLayoutEffect(() => { setActionCounts(Object.create(null)) }, [id, setActionCounts])
  useEffect(() => {
    if (id) reloadActionCounts()
  }, [id, reloadActionCounts])

  /*
   * SCENARIO-15: 試算の元になる設定を1つの鍵にまとめる。
   * 対象条件・同時購読・開始のきっかけ・各通の順番/時刻/絞り込みが
   * 変わると鍵が変わり、下の effect が取り直す。保存後の再読込では
   * id と lineAccountId が変わらないので、鍵を見ないと古い人数が
   * 残り続ける（以前の挙動）。
   */
  const simulationKey = scenarioSimulationKey(scenario, triggerCount === null || triggerRevision === 0 ? triggerCount : `${triggerCount}:${triggerRevision}`)
  /** 今の設定に対する試算。旧鍵の結果は確定値として出さない。 */
  const simulation = simulationForKey(simulationResult, simulationKey)
  /** 設定が変わって取り直し中か（初回の取得中も true）。 */
  const simulationRefreshing =
    Boolean(simulationKey && scenario?.lineAccountId) &&
    simulationResult?.key !== simulationKey

  /**
   * 機能5 管理画面の開始前試算と運用記録。互いに独立した読取なので並列で取得する。
   * 失敗時は旧集計を残し、0件とは表示しない。
   *
   * SCENARIO-15: 依存に simulationKey を含める。設定を保存し直すと
   * scenario が読み直されて鍵が変わり、試算を取り直す。世代の掃除
   * （cancelled）で遅れて届いた旧応答は捨てるので、遅い旧試算が
   * 新しい版を上書きしない。
   */
  useEffect(() => {
    const lineAccountId = scenario?.lineAccountId
    if (!id || !lineAccountId || !simulationKey) {
      setSimulationResult(null)
      setRuns(null)
      return
    }
    let cancelled = false
    const key = simulationKey
    void Promise.all([
      api.scenarios.simulate(id, lineAccountId).catch(() => null),
      api.scenarios.runs(id, lineAccountId, { limit: 50 }).catch(() => null),
    ]).then(([simulationResponse, runsResponse]) => {
      if (cancelled) return
      setSimulationResult({
        key,
        value: simulationResponse?.success ? simulationResponse.data : null,
      })
      setRuns(runsResponse?.success ? runsResponse.data : null)
    })
    return () => {
      cancelled = true
    }
  }, [id, scenario?.lineAccountId, simulationKey, simRetry, setRuns, setSimulationResult])

  useEffect(() => {
    if (!id) return
    api.scenarios.triggers
      .list(id)
      .then((res) => {
        if (res.success) {
          setTriggerCount(res.data.length)
          /* ★V8: 箱に「友だち追加のとき」など名前で出すので一覧も持つ。 */
          setTriggerItems(res.data)
        }
      })
      .catch(() => {})
  }, [id, triggerRevision, setTriggerCount, setTriggerItems])

  /*
   * ★V8: 各通の「届く日時の例」（行の時刻の下の青い行）は /preview の
   * 試算から取る。取れなければ出さない（時刻の行だけになる）。
   */
  useEffect(() => {
    if (!id || !scenarioLoaded) return
    let cancelled = false
    api.scenarios
      .preview(id)
      .then((res) => {
        if (cancelled || !res.success) return
        const map: Record<number, string> = {}
        for (const step of res.data.steps) map[step.stepOrder] = step.deliveryAtLabel
        setPreviewLabels(map)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [id, previewUpdatedAt, scenarioLoaded, setPreviewLabels])

  const reloadStats = useCallback(() => {
    scenarioReferenceData.stats(id, true).then((r) => { if (r.success) setStats(r.data) }).catch(() => {})
  }, [id, setStats])

  return { loadScenario, reloadStats, simulationRefreshing, simulation, reloadActionCounts }
}
