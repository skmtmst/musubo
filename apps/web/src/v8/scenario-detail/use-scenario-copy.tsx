'use client'

import { isConflictResponse } from '@/components/shared/save-conflict'

import type { ScenarioConfirmation } from '@/lib/api/types/scenarios'

import { japaneseDetailOf } from '@/components/shared/api-error-message'

import { type ScenarioQuestion } from '@/components/scenarios/question-editor'
import { type SegmentCondition } from '@/components/shared/condition-builder'
import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation'
import { useSaveFormErrors } from '@/components/shared/save-form-errors'
import { notifyToast } from '@/components/shared/toast'
import { api } from '@/lib/api'
import type { DeliveryMode, ScenarioStep } from '@line-crm/shared'
import type { Dispatch, SetStateAction } from 'react'
import { DuplicateAborted, ScenarioWithSteps, stepScheduleForClone } from './detail-model'

export function useScenarioCopy({
  scenario, duplicating, setDuplicating, setError,
  duplicateRemainder, saveErrors, sortedSteps, deliveryMode,
  id, setDuplicateRemainder, setDuplicateOpen, discardingDuplicate,
  setDiscardingDuplicate, setDiscardDuplicateError, setDiscardDuplicateOpen, deletingScenario,
  setDeletingScenario, setDeleteScenarioError, deleteConfirmation, deleteConfirmationValid, refreshDeleteConfirmation, setDeleteScenarioOpen, router,
}: {
  scenario: ScenarioWithSteps | null
  duplicating: boolean
  setDuplicating: Dispatch<SetStateAction<boolean>>
  setError: Dispatch<SetStateAction<string>>
  duplicateRemainder: { copyId: string; copyName: string; stage: string; detail: string; } | null
  saveErrors: ReturnType<typeof useSaveFormErrors>
  sortedSteps: ScenarioStep[]
  deliveryMode: DeliveryMode
  id: string
  setDuplicateRemainder: Dispatch<SetStateAction<{ copyId: string; copyName: string; stage: string; detail: string; } | null>>
  setDuplicateOpen: Dispatch<SetStateAction<boolean>>
  discardingDuplicate: boolean
  setDiscardingDuplicate: Dispatch<SetStateAction<boolean>>
  setDiscardDuplicateError: Dispatch<SetStateAction<string>>
  setDiscardDuplicateOpen: Dispatch<SetStateAction<boolean>>
  deletingScenario: boolean
  deleteConfirmation: ScenarioConfirmation | null
  deleteConfirmationValid: () => boolean
  refreshDeleteConfirmation: () => Promise<void>
  setDeletingScenario: Dispatch<SetStateAction<boolean>>
  setDeleteScenarioError: Dispatch<SetStateAction<string>>
  setDeleteScenarioOpen: Dispatch<SetStateAction<boolean>>
  router: ReturnType<typeof useRouter>
}) {
  const handleDuplicate = async (name?: string) => {
    if (!scenario || duplicating) return
    setDuplicating(true)
    setError('')
    const copyName = (name?.trim() || `${scenario.name} のコピー`)
    /*
     * SCENARIO-09: 途中で失敗したあと新しく作り直すと、不完全なコピーが
     * 1つ増えるだけ。前回作りかけのコピーが残っていれば新しく作らず、
     * その続きから写す。
     */
    let copyId = duplicateRemainder?.copyId ?? null
    try {
      if (!copyId) {
        const created = await api.scenarios.create({
          name: copyName,
          description: scenario.description,
          triggerType: scenario.triggerType,
          triggerTagId: scenario.triggerTagId,
          lineAccountId: scenario.lineAccountId,
          isActive: false,
          deliveryMode: scenario.deliveryMode,
          allowConcurrent: scenario.allowConcurrent,
          folderId: scenario.folderId ?? null,
        })
        if (!created.success) throw new Error(created.error)
        copyId = created.data.id
      }
      const copy = copyId

      /*
       * SCENARIO-08: シナリオ全体の配信対象と、最後まで届いた人の行き先
       * （終了後の処理）も写す。通だけ写すと、同じ名前でまったく別の
       * 動きをするコピーができてしまう。create はこれらを受けないので
       * 直後の update で入れる。
       */
      try {
        const updated = await api.scenarios.update(copy, {
          audienceCondition: scenario.audienceCondition ?? null,
          onCompleteMode: scenario.onCompleteMode ?? 'pause',
          onCompleteScenarioId: scenario.onCompleteScenarioId ?? null,
        })
        if (!updated.success) throw new Error(updated.error)
      } catch (cause) {
        saveErrors.capture(cause)
        throw new DuplicateAborted(copy, 'シナリオ全体の設定（配信対象・終了後の処理）', cause)
      }

      /*
       * 再開でも同じ通を二重に足さないよう、コピーに既にある通の番号を
       * 読む。読めないと「どこまで写ったか」が分からないので止める。
       */
      const existing = await api.scenarios.get(copy).catch(() => null)
      if (!existing?.success) {
        throw new DuplicateAborted(
          copy,
          'コピー済みの内容の確認',
          new Error(existing && !existing.success ? existing.error : 'コピーの内容を読めませんでした'),
        )
      }
      const existingByOrder = new Map(existing.data.steps.map((s) => [s.stepOrder, s.id]))
      const stepIdMap = new Map<string, string>()
      // 通は順に足す。まとめて入れる口が無い。
      // 時刻・絞り込み・質問・下書きの別まで写す。落とすと別物の流れに
      // なる。時刻は方式に合う欄だけ送る（余分な欄があると 400 で止まる）。
      for (const step of sortedSteps) {
        const already = existingByOrder.get(step.stepOrder)
        if (already) {
          stepIdMap.set(step.id, already)
          continue
        }
        const copied = await api.scenarios.addStep(copy, {
          stepOrder: step.stepOrder,
          ...stepScheduleForClone(deliveryMode, step),
          messageType: step.messageType,
          messageContent: step.messageContent,
          templateId: step.templateId ?? null,
          onReachTagId: step.onReachTagId ?? null,
          // 複製先でも同じところで止まる。止まる位置が変わると流れが別物になる。
          afterSend: step.afterSend ?? 'continue',
          targetCondition: (step.targetCondition as SegmentCondition | null) ?? null,
          question: (step.question as ScenarioQuestion | null) ?? null,
          isDraft: step.isDraft === true,
        }).catch((cause) => ({ success: false as const, error: japaneseDetailOf(cause) || '通をコピーできませんでした' }))
        // 途中で止める。続けると通が欠けた別物の流れが残る。
        if (!copied.success) throw new DuplicateAborted(copy, `${step.stepOrder} 通目のコピー`, new Error(copied.error))
        stepIdMap.set(step.id, copied.data.id)
      }

      /*
       * SCENARIO-08: 開始のきっかけ。写さないと「複製したのに
       * 始まらない」コピーになる。再開時は既にあるものを足さない。
       */
      try {
        const [sourceTriggers, copyTriggers] = await Promise.all([
          api.scenarios.triggers.list(id),
          api.scenarios.triggers.list(copy),
        ])
        if (!sourceTriggers.success) throw new Error(sourceTriggers.error)
        if (!copyTriggers.success) throw new Error(copyTriggers.error)
        const have = new Set(copyTriggers.data.map((t) => `${t.kind}:${t.tagId ?? ''}`))
        for (const trigger of sourceTriggers.data) {
          if (have.has(`${trigger.kind}:${trigger.tagId ?? ''}`)) continue
          const added = await api.scenarios.triggers.add(copy, trigger.kind, trigger.tagId)
          if (!added.success) throw new Error(added.error)
        }
      } catch (cause) {
        saveErrors.capture(cause)
        throw new DuplicateAborted(copy, '開始のきっかけ', cause)
      }

      /*
       * SCENARIO-08: アクション（通を送ったとき・選択肢を押したとき・
       * 配り終えたとき）。通にぶら下がるものは写した先の通へ張り替える。
       */
      try {
        const [sourceActions, copyActions] = await Promise.all([
          api.scenarios.actions.list(id),
          api.scenarios.actions.list(copy),
        ])
        if (!sourceActions.success) throw new Error(sourceActions.error)
        if (!copyActions.success) throw new Error(copyActions.error)
        const keyOf = (
          hook: string,
          stepId: string | null,
          choiceIndex: number | null,
          actionType: string,
          sortOrder: number,
        ) => `${hook}:${stepId ?? ''}:${choiceIndex ?? ''}:${actionType}:${sortOrder}`
        const have = new Set(
          copyActions.data.map((a) => keyOf(a.hook, a.stepId, a.choiceIndex, a.actionType, a.sortOrder)),
        )
        for (const action of sourceActions.data) {
          const mappedStepId = action.stepId === null ? null : stepIdMap.get(action.stepId) ?? null
          if (action.stepId !== null && mappedStepId === null) {
            // 写せなかった通にぶら下がるアクションは足さない。
            continue
          }
          const key = keyOf(action.hook, mappedStepId, action.choiceIndex, action.actionType, action.sortOrder)
          if (have.has(key)) continue
          const createdAction = await api.scenarios.actions.create(copy, {
            hook: action.hook,
            stepId: mappedStepId,
            choiceIndex: action.choiceIndex,
            actionType: action.actionType,
            config: action.config,
            condition: action.condition,
            repeatOnRefire: action.repeatOnRefire,
            sortOrder: action.sortOrder,
          })
          if (!createdAction.success) throw new Error(createdAction.error)
          have.add(key)
        }
      } catch (cause) {
        saveErrors.capture(cause)
        throw new DuplicateAborted(copy, 'アクション', cause)
      }

      setDuplicateRemainder(null)
      setDuplicateOpen(false)
      /*  ③：複製はその場にとどまり、下書きで作ったことをトーストで知らせる。コピーは一覧に下書きで並ぶ。 */
      notifyToast(copyName === `${scenario.name} のコピー` ? `「${scenario.name}」のコピーを下書きで作りました` : `「${copyName}」を下書きで作りました`)
    } catch (e) {
      const fieldFailure = saveErrors.capture(e);

      if (e instanceof DuplicateAborted) {
        // SCENARIO-09: 不完全なコピーが残っていることを隠さない。
        // 所在・止まった段階・やり直し/削除の窓を出す。
        setDuplicateRemainder({
          copyId: e.copyId,
          copyName,
          stage: e.stage,
          detail: e.message,
        })
        { if (!fieldFailure)
        setError(`複製が「${e.stage}」で止まりました。途中まで作成されたコピーが残っています。`)
      }
      } else {
        { if (!fieldFailure)
        setError(japaneseDetailOf(e) || '複製に失敗しました。通信を確かめて、もう一度お試しください。') }
      }
    } finally {
      setDuplicating(false)
    }
  }

  /*
   * SCENARIO-09: 途中まで作られたコピーを捨てる。元のシナリオは
   * 触らない。失敗したら窓の中に理由を出して開いたままにする。
   */
  const handleDiscardDuplicate = async () => {
    if (!duplicateRemainder || discardingDuplicate) return
    setDiscardingDuplicate(true)
    setDiscardDuplicateError('')
    try {
      const res = await api.scenarios.delete(duplicateRemainder.copyId)
      if (!res.success) throw new Error(res.error)
      setDiscardDuplicateOpen(false)
      setDuplicateRemainder(null)
    } catch (saveFailure) {
      const fieldFailure = saveErrors.capture(saveFailure)

      { if (!fieldFailure)
      setDiscardDuplicateError('作りかけのコピーを削除できませんでした。コピーを開いて状態を確認し、もう一度お試しください。') }
    } finally {
      setDiscardingDuplicate(false)
    }
  }

  const handleDeleteScenario = async () => {
    if (!scenario || deletingScenario || !deleteConfirmation || !deleteConfirmationValid()) return
    setDeletingScenario(true)
    setDeleteScenarioError('')
    try {
      if (!deleteConfirmationValid()) return
      const res = await api.scenarios.delete(id, deleteConfirmation)
      if (!res.success) throw new Error(res.error)
      setDeleteScenarioOpen(false)
      router.push('/scenarios')
    } catch (saveFailure) {
      if (isConflictResponse(saveFailure) && saveFailure.code === 'scenario_confirmation_conflict') {
        await refreshDeleteConfirmation()
        setDeleteScenarioError('確認した内容が変わりました。もう一度確認してください。')
        return
      }
      const fieldFailure = saveErrors.capture(saveFailure)

      { if (!fieldFailure)
      setDeleteScenarioError('このシナリオを削除できませんでした。状態を読み直してから、もう一度お試しください。') }
    } finally {
      setDeletingScenario(false)
    }
  }

  return { saveErrors, handleDuplicate, handleDeleteScenario, handleDiscardDuplicate }
}
