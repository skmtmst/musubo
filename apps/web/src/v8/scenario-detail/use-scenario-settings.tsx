'use client'

import { emptyValue } from '@/components/shared/empty-value'
import { useSaveFormErrors } from '@/components/shared/save-form-errors'
import { notifyToast } from '@/components/shared/toast'
import { api, ApiError } from '@/lib/api'
import type { ScenarioTriggerType } from '@line-crm/shared'
import type { Dispatch, SetStateAction } from 'react'
import { useEffect } from 'react'
import { ScenarioWithSteps } from './detail-model'
import type { ScenarioConfirmation } from '@/lib/api/types/scenarios'

export function useScenarioSettings({
  editForm, setSaving, id, setEditing,
  setRenameOpen, setSaveDone, loadScenario, setError,
  saveErrors, setConflict, setConflictLatest, setCompareOpen,
  scenario, conflictLatest, startBusy, startConfirmed,
  setStartBusy, setStartError, setStartOpen, setJustStarted,
  reloadStats, stopBusy, setStopBusy, setStopError, stopConfirmation, stopConfirmationValid,
  setStopOpen, setDuplicateName, setDuplicateOpen, setEditForm,
}: {
  editForm: { name: string; description: string; triggerType: ScenarioTriggerType; isActive: boolean; allowConcurrent: boolean; folderId: string; }
  setSaving: Dispatch<SetStateAction<boolean>>
  id: string
  setEditing: Dispatch<SetStateAction<boolean>>
  setRenameOpen: Dispatch<SetStateAction<boolean>>
  setSaveDone: Dispatch<SetStateAction<boolean>>
  loadScenario: (fresh?: boolean) => Promise<void>
  setError: Dispatch<SetStateAction<string>>
  saveErrors: ReturnType<typeof useSaveFormErrors>
  setConflict: Dispatch<SetStateAction<boolean>>
  setConflictLatest: Dispatch<SetStateAction<ScenarioWithSteps | null>>
  setCompareOpen: Dispatch<SetStateAction<boolean>>
  scenario: ScenarioWithSteps | null
  conflictLatest: ScenarioWithSteps | null
  startBusy: boolean
  startConfirmed: boolean
  setStartBusy: Dispatch<SetStateAction<boolean>>
  setStartError: Dispatch<SetStateAction<string>>
  setStartOpen: Dispatch<SetStateAction<boolean>>
  setJustStarted: Dispatch<SetStateAction<boolean>>
  reloadStats: () => void
  stopBusy: boolean
  stopConfirmation: ScenarioConfirmation | null
  stopConfirmationValid: () => boolean
  setStopBusy: Dispatch<SetStateAction<boolean>>
  setStopError: Dispatch<SetStateAction<string>>
  setStopOpen: Dispatch<SetStateAction<boolean>>
  setDuplicateName: Dispatch<SetStateAction<string>>
  setDuplicateOpen: Dispatch<SetStateAction<boolean>>
  setEditForm: Dispatch<SetStateAction<{ name: string; description: string; triggerType: ScenarioTriggerType; isActive: boolean; allowConcurrent: boolean; folderId: string; }>>
}) {
  const handleSaveScenario = async () => {
    if (!editForm.name.trim()) return
    setSaving(true)
    try {
      const res = await api.scenarios.update(id, {
        name: editForm.name,
        description: editForm.description || null,
        folderId: editForm.folderId || null,
        triggerType: editForm.triggerType,
        isActive: editForm.isActive,
        allowConcurrent: editForm.allowConcurrent,
      })
      if (res.success) {
        setEditing(false)
        setRenameOpen(false)
        setSaveDone(true)
        loadScenario(true)
      } else {
        setError(res.error)
      }
    } catch (caught) {
      const fieldFailure = saveErrors.capture(caught)
      /*
       * ★V8 ：ほかの人が先に保存していた（409）。入力は残し、帯で知らせて
       * 「違いを比べる」「最新を読み込んで続ける」を選んでもらう。
       */
      if (caught instanceof ApiError && caught.status === 409) {
        setConflict(true)
        try {
          const latest = await api.scenarios.get(id)
          if (latest.success) setConflictLatest(latest.data as ScenarioWithSteps)
        } catch (saveFailure) {
          saveErrors.capture(saveFailure)
          // 最新が取れなくても帯は出す。「最新を読み込んで続ける」で取り直せる。
        }
      } else {
        { if (!fieldFailure)

        setError('保存に失敗しました。通信を確かめて、もう一度お試しください。') }
      }
    } finally {
      setSaving(false)
    }
  }

  /*
   * ★V8 「最新を読み込んで続ける」。最新で入力を置き換える。
   * 比べる文は設定の要約（名前・状態・通の数）で作る。
   */
  const acceptLatestAndContinue = async () => {
    setCompareOpen(false)
    setConflict(false)
    setConflictLatest(null)
    await loadScenario(true)
  }

  const describeScenarioSummary = (input: { name: string; isActive: boolean; stepCount: number }): string =>
    [
      `名前：${input.name || emptyValue('unconfigured')}`,
      `状態：${input.isActive ? '有効' : '停止中'}`,
      `通の数：${input.stepCount}`,
    ].join('\n')

  const currentSummary = scenario
    ? describeScenarioSummary({ name: editForm.name, isActive: editForm.isActive, stepCount: scenario.steps.length })
    : ''
  const latestSummary = conflictLatest
    ? describeScenarioSummary({ name: conflictLatest.name, isActive: conflictLatest.isActive, stepCount: conflictLatest.steps.length })
    : ''

  /*
   * ★V8: 3 の箱の「配信を再開する」。開始前の確認（）で
   * 対象人数・送信枠を確かめてから動かす。試算は画面が常に持っている
   * simulation / runs をそのまま使う（確認窓で取り直さない）。
   */
  const handleStart = async () => {
    if (!scenario || startBusy || !startConfirmed) return
    setStartBusy(true)
    setStartError('')
    try {
      const res = await api.scenarios.update(id, { isActive: true })
      if (!res.success) {
        setStartError(res.error)
        return
      }
      setStartOpen(false)
      setJustStarted(true)
      notifyToast('配信を始めました')
      loadScenario(true)
      reloadStats()
    } catch (saveFailure) {
      const fieldFailure = saveErrors.capture(saveFailure)

      { if (!fieldFailure)
      setStartError('配信を始められませんでした。通信を確かめて、もう一度お試しください。') }
    } finally {
      setStartBusy(false)
    }
  }

  /*
   * ★V8: 3 の箱の「一時停止する」（ 止める確認）。
   * 止めても途中の人の記録は残る。板にある「止める理由」の欄は、
   * 受け口（保存先）が API に無いので置いていない
   * （design/v8/DEVIN-QUESTIONS.md 参照）。
   */
  const handleStop = async () => {
    if (!scenario || stopBusy || !stopConfirmation || !stopConfirmationValid()) return
    setStopBusy(true)
    setStopError('')
    try {
      if (!stopConfirmationValid()) return
      const res = await api.scenarios.update(id, { isActive: false, expectedContentRevision: stopConfirmation.contentRevision, expectedSubscriptions: { activeCount: stopConfirmation.activeCount, rowIdSum: stopConfirmation.rowIdSum, rowIdSquareSum: stopConfirmation.rowIdSquareSum } })
      if (!res.success) {
        setStopError(res.error)
        return
      }
      setStopOpen(false)
      notifyToast('配信を一時停止しました')
      loadScenario(true)
      reloadStats()
    } catch (saveFailure) {
      const fieldFailure = saveErrors.capture(saveFailure)

      { if (!fieldFailure)
      setStopError('配信を止められませんでした。通信を確かめて、もう一度お試しください。') }
    } finally {
      setStopBusy(false)
    }
  }

  /* ★V8 ：複製の窓を開く。名前は「のコピー」を下書きに持つ。 */
  const openDuplicateDialog = () => {
    if (!scenario) return
    setDuplicateName(`${scenario.name} のコピー`)
    setDuplicateOpen(true)
  }

  /** 題の横の鉛筆。フォームへ今の値を戻してから開く。 */
  const openRenameDialog = () => {
    if (!scenario) return
    setEditForm({
      name: scenario.name,
      description: scenario.description ?? '',
      triggerType: scenario.triggerType,
      isActive: scenario.isActive,
      allowConcurrent: scenario.allowConcurrent !== false,
      folderId: scenario.folderId ?? '',
    })
    setRenameOpen(true)
  }

  /*
   * 追従バーの「保存する」が何かを持つのは、鉛筆の窓で名前などが
   * 変わっているときだけ。差分を見て押せる/押せないを決める。
   */
  const editDirty = Boolean(
    scenario &&
      (editForm.name !== scenario.name ||
        editForm.description !== (scenario.description ?? '') ||
        editForm.folderId !== (scenario.folderId ?? '') ||
        editForm.allowConcurrent !== (scenario.allowConcurrent !== false)),
  )

  useEffect(() => {
    if (editDirty) setSaveDone(false)
  }, [editDirty, setSaveDone])

  /*
   * 追従バーに「未保存の変更があります」と出ている間（鉛筆の窓で変えた名前・説明・フォルダ・
   * 同時配信）は、左メニューなどで画面を離れる前に確かめる。保存すると印が消えて番兵も外れる。
   */

  return { saveErrors, editDirty, openRenameDialog, openDuplicateDialog, acceptLatestAndContinue, handleSaveScenario, latestSummary, currentSummary, handleStart, handleStop }
}
