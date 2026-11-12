'use client'

import { validateScenarioStep } from './step-validation'

import { emptyMessageKindState, parseMessageKind, type MessageKind, type MessageKindState } from '@/components/scenarios/message-kind-fields'
import { emptyQuestion, planChoiceActionRemap, withChoiceKeys, type ScenarioQuestion } from '@/components/scenarios/question-editor'
import { buildSchedulePayload, uiFromOffsetMinutes } from '@/components/scenarios/schedule-input'
import { type SegmentCondition } from '@/components/shared/condition-builder'
import { useSaveFormErrors } from '@/components/shared/save-form-errors'
import { api, ApiError } from '@/lib/api'
import { useFormErrors } from '@/lib/use-form-errors'
import { useScenarioDraft } from '@/v8/autosave/public/use-scenario-draft/index'
import type { DeliveryMode, MessageType, ScenarioStep } from '@line-crm/shared'
import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react'
import { useAccount } from '@/contexts/account-context'
import { readStaffIdentity } from '@/lib/staff-identity-state'
import { captureScenarioWriteAccess } from '@/v8/scenarios'
import { emptyStepForm, isStructuredKind, nextStepOrder, ScenarioWithSteps, StepFormState, stepScheduleForClone, TemplateOpt } from './detail-model'

export function useScenarioStepActions({
  scenario, setStepForm, setEditingStepId, setShowStepForm,
  setInsertAfter, setStepError, setStepFormNonce, setKindState,
  id, stepForm, failStep, kindState,
  saveErrors, deliveryMode, stepFields, setStepSaving,
  templates, editingStepId, loadScenario, insertAfter,
  sortedSteps, stepDraft, reloadStats, duplicatingStepId,
  setDuplicatingStepId, deleteStepTarget, deleteStepRevision, deleteStepConfirmationValid, deletingStepId, setDeletingStepId,
  setDeleteStepError, setDeleteStepTarget, setError,
}: {
  scenario: ScenarioWithSteps | null
  setStepForm: Dispatch<SetStateAction<StepFormState>>
  setEditingStepId: Dispatch<SetStateAction<string | null>>
  setShowStepForm: Dispatch<SetStateAction<boolean>>
  setInsertAfter: Dispatch<SetStateAction<number | null>>
  setStepError: Dispatch<SetStateAction<string>>
  setStepFormNonce: Dispatch<SetStateAction<number>>
  setKindState: Dispatch<SetStateAction<MessageKindState>>
  id: string
  stepForm: StepFormState
  failStep: (key: "question" | "content" | "template" | "time", message: string) => void
  kindState: MessageKindState
  saveErrors: ReturnType<typeof useSaveFormErrors>
  deliveryMode: DeliveryMode
  stepFields: ReturnType<typeof useFormErrors>
  setStepSaving: Dispatch<SetStateAction<boolean>>
  templates: TemplateOpt[]
  editingStepId: string | null
  loadScenario: (fresh?: boolean) => Promise<void>
  insertAfter: number | null
  sortedSteps: ScenarioStep[]
  stepDraft: ReturnType<typeof useScenarioDraft>
  reloadStats: () => void
  duplicatingStepId: string | null
  setDuplicatingStepId: Dispatch<SetStateAction<string | null>>
  deleteStepTarget: ScenarioStep | null
  deleteStepRevision: number | null
  deleteStepConfirmationValid: () => boolean
  deletingStepId: string | null
  setDeletingStepId: Dispatch<SetStateAction<string | null>>
  setDeleteStepError: Dispatch<SetStateAction<string>>
  setDeleteStepTarget: Dispatch<SetStateAction<ScenarioStep | null>>
  setError: Dispatch<SetStateAction<string>>
}) {
  const { selectedAccountId, loading: accountLoading } = useAccount()
  const mounted = useRef(true)
  const scope = useRef({ id, accountId: selectedAccountId, scenarioAccountId: scenario?.lineAccountId, accountLoading })
  if (scope.current.id !== id || scope.current.accountId !== selectedAccountId
    || scope.current.scenarioAccountId !== scenario?.lineAccountId || scope.current.accountLoading !== accountLoading) {
    scope.current = { id, accountId: selectedAccountId, scenarioAccountId: scenario?.lineAccountId, accountLoading }
  }
  const renderedScope = scope.current
  const currentScope = () => mounted.current && scope.current === renderedScope
  const access = captureScenarioWriteAccess()
  const checkWrite = (report: (message: string) => void = setStepError) => {
    if (!currentScope()) return false
    if (accountLoading || scenario?.id !== id) {
      report('画面の読み込みが終わるまで、この操作はできません。')
      return false
    }
    if (access()) return true
    report(readStaffIdentity()
      ? '権限が変わったため中止しました。入力内容は残っています。'
      : '本人の確認が終わるまで、この操作はできません。')
    return false
  }
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  useEffect(() => {
    setStepSaving(false)
    setDuplicatingStepId(null)
    setDeletingStepId(null)
  }, [renderedScope, setStepSaving, setDuplicatingStepId, setDeletingStepId])

  const openAddStep = () => {
    const nextOrder = nextStepOrder(scenario?.steps ?? [])
    setStepForm(emptyStepForm(nextOrder))
    setEditingStepId(null)
    setShowStepForm(true)
    setInsertAfter(null)
    setStepError('')
    setStepFormNonce((n) => n + 1)
  }

  /**
   * テンプレートから1通足す。
   *
   * 中身を直に書くのと同じフォームを、最初からテンプレート選択の状態で
   * 開くだけ。別のフォームを作ると、あとから入力欄が片方にしか
   * 足されない形でずれていく。
   */
  /**
   * 質問（分岐）の通を新しく足す。
   *
   * 質問は本文を持たないので、messageContent は空のまま。配信側は
   * question_json があればそちらを組み立てる。
   */
  const openAddQuestionStep = () => {
    const nextOrder = nextStepOrder(scenario?.steps ?? [])
    setStepForm({ ...emptyStepForm(nextOrder), question: emptyQuestion() })
    setEditingStepId(null)
    setShowStepForm(true)
    setInsertAfter(null)
    setStepError('')
    setStepFormNonce((n) => n + 1)
  }

  const openAddTemplateStep = () => {
    const nextOrder = nextStepOrder(scenario?.steps ?? [])
    setStepForm({ ...emptyStepForm(nextOrder), inputMode: 'template' })
    setEditingStepId(null)
    setShowStepForm(true)
    setInsertAfter(null)
    setStepError('')
    setStepFormNonce((n) => n + 1)
  }

  /**
   * 通と通のあいだに差し込む。
   *
   * 末尾にしか足せないと、3通目と4通目のあいだに1通入れたいときに、
   * 後ろを全部作り直すことになる。あいだの「ここに挿入」から開くと、
   * その位置の番号で新しい通を作る。
   */
  const openInsertStep = (afterOrder: number) => {
    setStepForm(emptyStepForm(afterOrder + 1))
    setEditingStepId(null)
    setShowStepForm(true)
    setInsertAfter(afterOrder)
    setStepError('')
    setStepFormNonce((n) => n + 1)
  }

  const openEditStep = (step: ScenarioStep) => {
    const ui = uiFromOffsetMinutes(step.offsetMinutes)
    setStepForm({
      stepOrder: step.stepOrder,
      schedule: {
        delayMinutes: step.delayMinutes,
        offsetDays: step.offsetDays ?? 0,
        offsetHours: ui.offsetHours,
        offsetMinutesRemainder: ui.offsetMinutesRemainder,
        deliveryTime: step.deliveryTime ?? '09:00',
      },
      messageType: step.messageType,
      messageContent: step.messageContent,
      templateId: step.templateId ?? null,
      onReachTagId: step.onReachTagId ?? null,
      afterSend: step.afterSend ?? 'continue',
      inputMode: step.templateId ? 'template' : 'direct',
      targetCondition: (step.targetCondition as SegmentCondition | null) ?? null,
      /* R246: 開くときに鍵を振る。削除・追加の追跡に使う。 */
      question: step.question ? withChoiceKeys(step.question as ScenarioQuestion) : null,
      isDraft: step.isDraft === true,
    })
    // 専用の欄で書く種別は、保存されている JSON を欄の形に戻す。
    setKindState(
      isStructuredKind(step.messageType)
        ? parseMessageKind(step.messageType as MessageKind, step.messageContent)
        : emptyMessageKindState(),
    )
    setEditingStepId(step.id)
    // 編集はステップ行直下にインライン表示するので、上部の新規追加フォームは閉じる
    setShowStepForm(false)
    setInsertAfter(null)
    setStepError('')
    setStepFormNonce((n) => n + 1)
  }

  const closeStepForm = () => {
    setShowStepForm(false)
    setEditingStepId(null)
    setStepError('')
  }

  /*
   * R246: 選択肢別アクションの紐づけを、位置ではなく選択肢の鍵で付け替える。
   * 口に choiceIndex の書き換えが無いため、移動は「消して作り直し」で行う
   * （中身・条件・繰り返しは引き継ぐ）。失敗時は文を返し、呼び出し側が
   * 画面を閉じずに知らせる。成功・対象なしは null。
   */
  const remapChoiceActions = async (
    stepId: string,
    nextQuestion: ScenarioQuestion | null,
  ): Promise<string | null> => {
    const prevStep = scenario?.steps.find((step) => step.id === stepId)
    const prevQuestion = (prevStep?.question as ScenarioQuestion | null) ?? null
    if (!prevQuestion && !nextQuestion) return null
    const list = await api.scenarios.actions.list(id)
    if (!list.success) return '選択肢の動作を読み直せませんでした。画面を開き直して対応を確認してください。'
    const rows = list.data.filter(
      (action) => action.hook === 'choice_selected' && (action.stepId ?? null) === stepId,
    )
    if (rows.length === 0) return null
    const plan = planChoiceActionRemap(prevQuestion?.choices ?? [], nextQuestion?.choices ?? [], rows)
    if (plan.removeIds.length === 0 && plan.moveTo.length === 0) return null
    const moveById = new Map(plan.moveTo.map((move) => [move.id, move.choiceIndex]))
    for (const row of rows) {
      const moveTo = moveById.get(row.id)
      if (moveTo === undefined && !plan.removeIds.includes(row.id)) continue
      if (!checkWrite()) return '権限が変わったため、選択肢の動作の付け替えを中止しました。画面を開き直して対応を確認してください。'
      const removed = await api.scenarios.actions.remove(id, row.id)
      if (!removed.success) return '選択肢の動作の付け替えに失敗しました。画面を開き直して対応を確認してください。'
      if (moveTo !== undefined) {
        if (!checkWrite()) return '権限が変わったため、選択肢の動作の付け替えを中止しました。画面を開き直して対応を確認してください。'
        const recreated = await api.scenarios.actions.create(id, {
          hook: row.hook,
          stepId: row.stepId,
          choiceIndex: moveTo,
          actionType: row.actionType,
          config: row.config ?? {},
          condition: row.condition ?? null,
          repeatOnRefire: row.repeatOnRefire,
          sortOrder: row.sortOrder,
        })
        if (!recreated.success) return '選択肢の動作の付け替えに失敗しました。画面を開き直して対応を確認してください。'
      }
    }
    return null
  }

  const handleSaveStep = async () => {
    if (!checkWrite()) return
    const problem = validateScenarioStep(stepForm, kindState, deliveryMode)
    if (problem) {
      if (problem.field === 'question' && stepFields.submit().length > 0) {
        setStepError('')
        return
      }
      if (problem.cause !== undefined) saveErrors.capture(problem.cause)
      if (problem.field) failStep(problem.field, problem.message)
      else setStepError(problem.message)
      return
    }
    stepFields.reset()
    setStepSaving(true)
    setStepError('')
    try {
      const schedulePayload = buildSchedulePayload(deliveryMode, stepForm.schedule)
      // テンプレモード保存時は、選択中テンプレ内容を scenario_steps の messageType /
      // messageContent にスナップショットコピーする。テンプレ削除時に resolveStepContent
      // がここから正しい内容にフォールバックできるため。
      let payloadMessageType: MessageType = stepForm.messageType
      let payloadMessageContent: string = stepForm.messageContent || ' '
      if (stepForm.inputMode === 'template' && stepForm.templateId) {
        const tpl = templates.find((t) => t.id === stepForm.templateId)
        if (tpl) {
          // messageType: テンプレが image/carousel のときは scenario_steps の CHECK に
          // ('text','image','flex') の制約があるため text/image/flex のみ許容。
          // carousel が来る可能性は低いが念のため text にフォールバック。
          payloadMessageType = (['text', 'image', 'flex'].includes(tpl.messageType)
            ? tpl.messageType
            : 'text') as MessageType
          payloadMessageContent = tpl.messageContent || ' '
        }
      }
      /* R246: 保存直前にも鍵を振る。削除・追加の追跡に使う。 */
      const keyedQuestion = stepForm.question ? withChoiceKeys(stepForm.question) : null
      const payload = {
        stepOrder: stepForm.stepOrder,
        ...schedulePayload,
        messageType: payloadMessageType,
        messageContent: payloadMessageContent,
        templateId: stepForm.inputMode === 'template' ? stepForm.templateId : null,
        onReachTagId: stepForm.onReachTagId,
        afterSend: stepForm.afterSend,
        // null を渡すと「絞り込みなし」に戻る。undefined だと据え置きになるので、
        // 外したつもりが残るのを防ぐために必ず値を送る。
        targetCondition: stepForm.targetCondition,
        question: keyedQuestion,
        isDraft: stepForm.isDraft,
      }
      if (editingStepId) {
        if (!checkWrite()) return
        const res = await api.scenarios.updateStep(id, editingStepId, payload)
        if (!checkWrite()) return
        if (!res.success) {
          setStepError(res.error)
          return
        }
        /*
         * R246: 質問と動作の更新を一緒に確定する。選択肢の削除・追加で
         * 位置がずれても、残る選択肢の動作を保持し、消えた選択肢の動作
         * だけを消す。新しい選択肢は行が無い（0件から始める）。
         */
        const remapError = await remapChoiceActions(editingStepId, keyedQuestion)
        if (!currentScope()) return
        if (remapError) {
          setStepError(remapError)
          await loadScenario(true)
          return
        }
      } else {
        /*
         * あいだに差し込むときは、後ろの通の番号を先に1つずつ送る。
         * 送らずに同じ番号で足すと、並び順が重なってどちらが先か決まらない。
         * 後ろから順に動かすのは、途中で番号がぶつからないようにするため。
         */
        if (insertAfter !== null) {
          const moving = sortedSteps
            .filter((st) => st.stepOrder > insertAfter)
            .sort((a, b) => b.stepOrder - a.stepOrder)
          if (moving.length > 0) {
            const orders = moving.map((st) => ({ stepId: st.id, stepOrder: st.stepOrder + 1 }))
            if (!checkWrite()) return
            const moved = await api.scenarios.reorderSteps(id, orders)
            if (!moved.success) {
              setStepError('あいだに入れるための並べ替えに失敗しました。通信を確かめて、もう一度お試しください。')
              return
            }
          }
        }
        if (!checkWrite()) return
        const res = await api.scenarios.addStep(id, payload)
        if (!checkWrite()) return
        if (!res.success) {
          setStepError(res.error)
          return
        }
      }
      if (!checkWrite()) return
      stepDraft.clear()
      closeStepForm()
      loadScenario(true)
      reloadStats()
    } catch (error) {
      if (!checkWrite()) return
      const fieldFailure = saveErrors.capture(error)
      /*
       * R235: 入力の不備（400番台）と通信・サーバーの失敗を分ける。
       * 時刻の空などの入力エラーまで「通信を確かめて」と出すと、
       * 直せるものを直せず再試行を繰り返すことになる。
       */
      { if (!fieldFailure)
      setStepError(error instanceof ApiError && error.status >= 400 && error.status < 500
        ? '入力内容に不備があります。時刻・本文を確かめて、もう一度お試しください。'
        : 'ステップの保存に失敗しました。通信を確かめて、もう一度お試しください。') }
    } finally {
      if (currentScope()) setStepSaving(false)
    }
  }

  /**
   * この通を複製する（設計の行の操作）。
   *
   * 同じ中身の通を、すぐ下（stepOrder + 1）に作る。あいだに入れるので、
   * 後ろの通は「ここに挿入」と同じ経路で押し出される。
   */
  const handleDuplicateStep = async (step: ScenarioStep) => {
    if (duplicatingStepId || !checkWrite()) return
    setDuplicatingStepId(step.id)
    setStepError('')
    try {
      /*
       * あいだに差し込むので、後ろの通を先に1つずつ送る。
       * 送らずに同じ番号で足すと、並び順が重なってどちらが先か決まらない。
       * 後ろから順に動かすのは、途中で番号がぶつからないようにするため。
       * （handleSaveStep の insertAfter 経路と同じ）
       */
      const moving = sortedSteps
        .filter((st) => st.stepOrder > step.stepOrder)
        .sort((a, b) => b.stepOrder - a.stepOrder)
      if (moving.length > 0) {
        if (!checkWrite()) return
        const moved = await api.scenarios.reorderSteps(
          id,
          moving.map((st) => ({ stepId: st.id, stepOrder: st.stepOrder + 1 })),
        )
        if (!moved.success) {
          setStepError('あいだに入れるための並べ替えに失敗しました。通信を確かめて、もう一度お試しください。')
          return
        }
      }
      if (!checkWrite()) return
      const res = await api.scenarios.addStep(id, {
        stepOrder: step.stepOrder + 1,
        messageType: step.messageType,
        messageContent: step.messageContent,
        // 方式に合う時刻の欄だけ送る。余分な欄があると口が 400 で止める。
        ...stepScheduleForClone(deliveryMode, step),
        templateId: step.templateId ?? null,
        onReachTagId: step.onReachTagId ?? null,
        afterSend: step.afterSend,
        targetCondition: (step.targetCondition as SegmentCondition | null) ?? null,
        question: (step.question as ScenarioQuestion | null) ?? null,
        isDraft: step.isDraft === true,
      })
      if (!checkWrite()) return
      if (!res.success) {
        setStepError(res.error)
        return
      }
      loadScenario(true)
      reloadStats()
    } catch (saveFailure) {
      if (!checkWrite()) return
      const fieldFailure = saveErrors.capture(saveFailure)

      { if (!fieldFailure)
      setStepError('この通を複製できませんでした。時間をおいて、もう一度お試しください。') }
    } finally {
      if (currentScope()) setDuplicatingStepId(null)
    }
  }

  const handleDeleteStep = async () => {
    if (!deleteStepTarget || deletingStepId || !deleteStepConfirmationValid() || !checkWrite(setDeleteStepError)) return
    if (!Number.isSafeInteger(deleteStepRevision) || !deleteStepRevision || deleteStepRevision < 1) { setDeleteStepError('画面を読み直してから、もう一度お試しください。'); return }
    const stepId = deleteStepTarget.id
    setDeletingStepId(stepId)
    setDeleteStepError('')
    try {
      if (!deleteStepConfirmationValid() || !checkWrite(setDeleteStepError)) return
      const result = await api.scenarios.deleteStep(id, stepId, deleteStepRevision)
      if (!checkWrite(setDeleteStepError)) return
      if (!result.success) throw new Error(result.error)
      if (editingStepId === stepId) closeStepForm()
      setDeleteStepTarget(null)
      void loadScenario(true)
      void reloadStats()
    } catch (saveFailure) {
      if (!checkWrite(setDeleteStepError)) return
      const fieldFailure = saveErrors.capture(saveFailure)

      { if (!fieldFailure)
      setDeleteStepError('この通を削除できませんでした。状態を読み直してから、もう一度お試しください。') }
    } finally {
      if (currentScope()) setDeletingStepId(null)
    }
  }

  const handleMoveStep = async (stepId: string, direction: 'up' | 'down') => {
    if (!scenario || !checkWrite(setError)) return
    const sorted = [...scenario.steps].sort((a, b) => a.stepOrder - b.stepOrder)
    const idx = sorted.findIndex((s) => s.id === stepId)
    const swap = direction === 'up' ? idx - 1 : idx + 1
    if (idx < 0 || swap < 0 || swap >= sorted.length) return
    const a = sorted[idx]
    const b = sorted[swap]
    try {
      if (!checkWrite(setError)) return
      await api.scenarios.reorderSteps(id, [
        { stepId: a.id, stepOrder: b.stepOrder },
        { stepId: b.id, stepOrder: a.stepOrder },
      ])
      if (!checkWrite(setError)) return
      loadScenario(true)
      // 到達率バッジは stepOrder ベースでマッチングするので、並び替え後は stats も再取得
      reloadStats()
    } catch (saveFailure) {
      if (!checkWrite(setError)) return
      const fieldFailure = saveErrors.capture(saveFailure)

      { if (!fieldFailure)

      setError('並び替えに失敗しました。通信を確かめて、もう一度お試しください。') }
    }
  }

  /*
   * 通の編集フォームの右の柱（「配信の流れ」「設定サマリー」）へ渡す
   * 日・時間・分。方式ごとの持ち方（relative の合計分 / elapsed の
   * 日・時間・分）を previewOffsets 1か所でそろえる。分だけ渡し忘れると、
   * 設定内容は「1分後」なのにプレビューが「すぐに」のまま残る（#616 SC-02b）。
   */

  return { saveErrors, handleSaveStep, closeStepForm, openInsertStep, openEditStep, handleMoveStep, handleDuplicateStep, openAddStep, openAddTemplateStep, openAddQuestionStep, handleDeleteStep }
}
