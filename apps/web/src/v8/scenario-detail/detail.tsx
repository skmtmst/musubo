'use client'

import { firstQuestionChoiceLabelProblem } from '@/components/scenarios/question-choice-label-validation'

import { emptyMessageKindState, type MessageKindState } from '@/components/scenarios/message-kind-fields'
import { describeCondition, ON_COMPLETE_LABEL, type OnCompleteMode } from '@/components/scenarios/scenario-dialogs'
import { previewOffsets } from '@/components/scenarios/step-preview'
import Button from '@/components/shared/button'
import { type SegmentCondition } from '@/components/shared/condition-builder'
import { type InsertTextFieldHandle } from '@/components/shared/insert-text-field'
import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation'
import { RowMenu } from '@/components/shared/row-actions'
import { SaveConflictBand } from '@/components/shared/save-conflict'
import { SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import StatusChip from '@/components/shared/status-chip'
import { LinePreviewFlex as FlexPreviewComponent } from '@/components/shared/line-preview'
import StickyBar, { StickyBarAction } from '@/components/shared/sticky-bar'
import TargetMissing from '@/components/shared/target-missing'
import { usePageTitle } from '@/components/shell/page-chrome'
import { DetailLoading } from '@/components/templates/detail-page'
import { PageFrame, PageHeading } from '@/components/templates/page-frame'
import { useAccount } from '@/contexts/account-context'
import { api, type ScenarioRuns, type ScenarioTriggerItem } from '@/lib/api'
import type { ScenarioConfirmation } from '@/lib/api/types/scenarios'
import { formatNumber } from '@/lib/format'
import { useStaffRole } from '@/lib/staff-role'
import { useFeatureAccess } from '@/lib/use-feature-access'
import { useFormErrors } from '@/lib/use-form-errors'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { browserDraftKey } from '@/v8/autosave/public/use-browser-draft/index'
import { scenarioDraftKey, useScenarioDraft } from '@/v8/autosave/public/use-scenario-draft/index'
import type { DeliveryMode, Folder, ScenarioStep, ScenarioTriggerType } from '@line-crm/shared'
import { BarChart3, Check, Copy, Eye, GitCompareArrows, Pencil, Send, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { describeStartTrigger, emptyStepForm, formatClock, formatSavedAt, MODE_LABEL, ScenarioStats, ScenarioWithSteps, StepFormState, TagOpt, TemplateOpt } from './detail-model'
import styles from './detail.module.css'
import { type ScenarioSimulationResult } from './scenario-simulation-refresh'
import { startChecklist } from './start-checklist'

import { ScenarioDetailBody } from './scenario-detail-body'
import { ScenarioDetailDialogs } from './scenario-detail-dialogs'
import { ScenarioStepForm } from './scenario-step-form'
import { useScenarioCopy } from './use-scenario-copy'
import { useScenarioReads } from './use-scenario-reads'
import { useScenarioSettings } from './use-scenario-settings'
import { useScenarioStepActions } from './use-scenario-step-actions'

function FlexPreview({ content }: { content: string }) {
  return <FlexPreviewComponent content={content} maxWidth={300} />
}

export default function ScenarioDetailV8({
  scenarioId,
  showStarted = false,
}: {
  scenarioId: string
  showStarted?: boolean
}) {
  const saveErrors = useSaveFormErrors()
  const id = scenarioId

  const [scenario, setScenario] = useState<ScenarioWithSteps | null>(null)
  /* ★管理画面: コンテンツ表の操作は「編集＋…」の1行に収める。…の中身は行ごとに開く。 */
  const [stepMenuId, setStepMenuId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  /** 404・空で見つからないとき。取得の失敗（error）とは分ける。 */
  const [scenarioMissing, setScenarioMissing] = useState(false)
  /*
   * ★V8 ：ほかの人が先に保存したら帯で知らせる。
   * この画面は書き換えない（読み直すまで古い内容のまま）。
   * 名前・時刻は API に無いので出さない。
   */
  const [conflict, setConflict] = useState(false)
  const [conflictLatest, setConflictLatest] = useState<ScenarioWithSteps | null>(null)
  const [compareOpen, setCompareOpen] = useState(false)
  const shownUpdatedAtRef = useRef<string | null>(null)

  const [, setEditing] = useState(false)
  const [editForm, setEditForm] = useState({ name: '', description: '', triggerType: 'friend_add' as ScenarioTriggerType, isActive: true, allowConcurrent: true, folderId: '' })
  const [folders, setFolders] = useState<Folder[]>([])
  const [folderState, setFolderState] = useState<'loading' | 'ready' | 'error'>('loading')
  const { selectedAccountId, accounts } = useAccount()

  /*
   * SCENARIO-20: フォルダはアカウント単位。無指定で全権限範囲を取ると、
   * 別アカウントの同名フォルダを選んで保存してしまう。シナリオの所属
   * アカウント（共通なら選択中のアカウント）の候補だけを出し、
   * アカウントが切り替わったら取り直す。候補を取り直せなかったときは
   * 「未分類」と決めつけず、いまは変更できない旨を示す。
   */
  const folderAccountId = scenario?.lineAccountId ?? selectedAccountId

  /*
   * 閲覧のみ（staff）：作る・保存・削除・止める/再開・複製・通の操作は
   * 押せない形で出す。役割が取れるまで null なので、そのあいだは
   * 今までどおり押せる見た目（最後の守りはサーバの 403）。
   */
  useStaffRole()
  const featureAccess = useFeatureAccess('scenarios')
  const canEdit = featureAccess
  const canTestSend = useFeatureAccess('scenarios', 'test')

  /* --- ★V8 だけの状態 --- */
  /** 右の欄のスマホに出す通。押した行が選ばれる。 */
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null)
  /** 通ごとの「届く日時の例」。/preview の試算結果（stepOrder → 日時の文）。 */
  const [previewLabels, setPreviewLabels] = useState<Record<number, string>>({})
  /** 開始のきっかけの一覧（件数だけだと箱に名前を出せない）。 */
  const [triggerItems, setTriggerItems] = useState<ScenarioTriggerItem[] | null>(null)
  /* 配信を始める前の確認（★V8 ）・止める確認（）。 */
  const [startOpen, setStartOpen] = useState(false)
  const [startBusy, setStartBusy] = useState(false)
  const [startError, setStartError] = useState('')
  const [startConfirmed, setStartConfirmed] = useState(false)
  const [stopOpen, setStopOpen] = useState(false)
  const [stopBusy, setStopBusy] = useState(false)
  const [stopError, setStopError] = useState('')
  /* 複製の窓（★V8 ：新しい名前を本人が決める）。 */
  const [duplicateOpen, setDuplicateOpen] = useState(false)
  const [duplicateName, setDuplicateName] = useState('')
  /* 名前・説明・フォルダを変える窓（題の横の鉛筆）。 */
  const [renameOpen, setRenameOpen] = useState(false)
  /* 始めた直後の知らせ（）。URL の started=1 か、この画面で始めたとき。 */
  const [justStarted, setJustStarted] = useState(showStarted)
  useEffect(() => {
    if (showStarted) setJustStarted(true)
  }, [showStarted])

  useEffect(() => {
    let cancelled = false
    setFolderState('loading')
    void api.folders.list('scenario', folderAccountId ?? undefined)
      .then((res) => {
        if (cancelled) return
        if (res.success) {
          setFolders(res.data)
          setFolderState('ready')
        } else {
          setFolderState('error')
        }
      })
      .catch(() => {
        if (!cancelled) setFolderState('error')
      })
    return () => {
      cancelled = true
    }
  }, [folderAccountId])

  /*
   * 保存済みのフォルダが、このアカウントの候補に無いか（SCENARIO-20）。
   * 無いまま「未分類」と見せると、別範囲の値を黙って上書きしてしまう。
   * 候補に無い保存値は、理由を示したうえで値そのものは保持する。
   */
  const editFolderMissing = Boolean(
    editForm.folderId && !folders.some((f) => f.id === editForm.folderId),
  )
  const scenarioFolderName = !scenario?.folderId
    ? '未分類'
    : folderState === 'loading'
      ? '読み込み中…'
      : folderState === 'error'
        ? '確認できません'
        : (folders.find((f) => f.id === scenario.folderId)?.name ?? '名前を確認できません')
  const [saving, setSaving] = useState(false)
  /* 保存ボタンの「✓ 保存しました」（★V8 サクサク感 B）。変えたら消す。 */
  const [, setSaveDone] = useState(false)

  const router = useRouter()
  const [duplicating, setDuplicating] = useState(false)
  /*
   * SCENARIO-09: 複製が途中で止まったとき、作りかけのコピーが残る。
   * 残っているコピーの所在・どこで止まったかを保持し、窓から
   * 「続きからやり直す」「コピーを削除する」「コピーを開いて見る」を
   * 選べるようにする。
   */
  const [duplicateRemainder, setDuplicateRemainder] = useState<{
    copyId: string
    copyName: string
    stage: string
    detail: string
  } | null>(null)
  const [discardDuplicateOpen, setDiscardDuplicateOpen] = useState(false)
  const [discardingDuplicate, setDiscardingDuplicate] = useState(false)
  const [discardDuplicateError, setDiscardDuplicateError] = useState('')
  /** 表の行で開いている1通ぶんのプレビュー。設計の「プレビュー」。 */
  /* ★V8: 行の「プレビュー」は右の欄のスマホに出すので、行内の展開は持たない。 */
  const [duplicatingStepId, setDuplicatingStepId] = useState<string | null>(null)
  const [deleteStepTarget, setDeleteStepTarget] = useState<ScenarioStep | null>(null)
  const [deleteStepRevision, setDeleteStepRevision] = useState<number | null>(null)
  const [deleteStepOpenedGeneration, setDeleteStepOpenedGeneration] = useState(0)
  const deleteStepGeneration = useRef(0)
  const setScopedDeleteStepTarget: typeof setDeleteStepTarget = (next) => {
    deleteStepGeneration.current += 1
    if (next && typeof next !== 'function') {
      setDeleteStepRevision(scenario?.contentRevision ?? null)
      setDeleteStepOpenedGeneration(deleteStepGeneration.current)
    }
    setDeleteStepTarget(next)
  }
  const deleteStepConfirmationValid = () => !!deleteStepTarget && deleteStepOpenedGeneration === deleteStepGeneration.current

  const [deletingStepId, setDeletingStepId] = useState<string | null>(null)
  const [deleteStepError, setDeleteStepError] = useState('')
  const [deleteScenarioOpen, setDeleteScenarioOpen] = useState(false)
  const [deletingScenario, setDeletingScenario] = useState(false)
  const [deleteScenarioError, setDeleteScenarioError] = useState('')
  const [stopConfirmation, setStopConfirmation] = useState<{ scope: string; serial: number; value: ScenarioConfirmation } | null>(null)
  const [deleteConfirmation, setDeleteConfirmation] = useState<{ scope: string; serial: number; value: ScenarioConfirmation } | null>(null)
  const confirmationScope = JSON.stringify([id, selectedAccountId, scenario?.lineAccountId, canEdit])
  const confirmationGeneration = useRef({ scope: confirmationScope, serial: 0 })
  if (confirmationGeneration.current.scope !== confirmationScope) confirmationGeneration.current = { scope: confirmationScope, serial: confirmationGeneration.current.serial + 1 }
  const prepareConfirmation = async (kind: 'stop' | 'delete') => {
    if (!scenario || !canEdit || !Number.isSafeInteger(scenario.contentRevision) || !scenario.contentRevision) { setError('画面を読み直してから、もう一度お試しください。'); return }
    const scope = confirmationScope, serial = ++confirmationGeneration.current.serial
    try {
      const result = await api.scenarios.confirmation(id, kind)
      if (confirmationGeneration.current.scope !== scope || confirmationGeneration.current.serial !== serial) return
      if (!result.success || result.data.contentRevision !== scenario.contentRevision || !Number.isSafeInteger(result.data.activeCount) || result.data.activeCount < 0 || !Number.isSafeInteger(result.data.rowIdSum) || result.data.rowIdSum < 0 || !Number.isSafeInteger(result.data.rowIdSquareSum) || result.data.rowIdSquareSum < 0 || !Number.isSafeInteger(result.data.totalCount) || result.data.totalCount < 0 || !Number.isSafeInteger(result.data.totalRowIdSum) || result.data.totalRowIdSum < 0 || !Number.isSafeInteger(result.data.totalRowIdSquareSum) || result.data.totalRowIdSquareSum < 0 || !Array.isArray(result.data.referrers)) { setError('シナリオが変わったか確認できません。画面を読み直してください。'); return }
      const value = { scope, serial, value: result.data }
      if (kind === 'stop') { setStopConfirmation(value); setStopOpen(true) }
      else { setDeleteConfirmation(value); setDeleteScenarioOpen(true) }
    } catch { if (confirmationGeneration.current.scope === scope && confirmationGeneration.current.serial === serial) setError('確認できませんでした。画面を読み直してください。') }
  }
  const currentStopConfirmation = stopConfirmation?.scope === confirmationScope && stopConfirmation.serial === confirmationGeneration.current.serial && stopConfirmation.value.contentRevision === scenario?.contentRevision ? stopConfirmation.value : null
  const currentDeleteConfirmation = deleteConfirmation?.scope === confirmationScope && deleteConfirmation.serial === confirmationGeneration.current.serial && deleteConfirmation.value.contentRevision === scenario?.contentRevision ? deleteConfirmation.value : null
  const stopConfirmationValid = () => !!currentStopConfirmation && stopConfirmation?.serial === confirmationGeneration.current.serial && stopConfirmation.scope === confirmationGeneration.current.scope
  const deleteConfirmationValid = () => !!currentDeleteConfirmation && deleteConfirmation?.serial === confirmationGeneration.current.serial && deleteConfirmation.scope === confirmationGeneration.current.scope
  const closeStopConfirmation = (next: boolean | ((previous: boolean) => boolean)) => { if (next === false) confirmationGeneration.current.serial += 1; setStopOpen(next) }
  const closeDeleteConfirmation = (next: boolean | ((previous: boolean) => boolean)) => { if (next === false) confirmationGeneration.current.serial += 1; setDeleteScenarioOpen(next) }


  const [showStepForm, setShowStepForm] = useState(false)
  /** 何通目のあとに差し込むか。末尾に足すときは null。 */
  const [insertAfter, setInsertAfter] = useState<number | null>(null)
  const [editingStepId, setEditingStepId] = useState<string | null>(null)
  const [stepForm, setStepForm] = useState<StepFormState>(() => emptyStepForm(1))
  usePageTitle(editingStepId ? `${[...(scenario?.steps ?? [])].sort((a, b) => a.stepOrder - b.stepOrder).findIndex((step) => step.id === editingStepId) + 1} 通目を編集` : (scenario?.name ?? 'シナリオ配信'))
  const [stepSaving, setStepSaving] = useState(false)
  const [stepError, setStepError] = useState('')
  /* 通の保存で落ちた欄は、その欄の真下に理由を出して移る。検査は保存の直前に1つずつ見る形なので fail で結び付ける。 */
  const stepFields = useFormErrors()
  for (const [key, label] of [['question', '質問'], ['content', 'メッセージ内容'], ['template', 'テンプレート'], ['time', '配信する時刻']] as const) stepFields.define(key, label, () => key === 'question' && stepForm.question ? firstQuestionChoiceLabelProblem(stepForm.question)?.message ?? null : null)
  const failStep = (key: 'question' | 'content' | 'template' | 'time', message: string) => {
    setStepError('')
    stepFields.fail(key, message)
  }

  /* --- 追加した窓。開いているものだけ描く --- */
  /** シナリオ全体の配信対象。 */
  const [audienceOpen, setAudienceOpen] = useState(false)
  /** 最終コンテンツ配信後の処理。 */
  const [onCompleteOpen, setOnCompleteOpen] = useState(false)
  /** 1通ごとの配信対象。編集中のフォームに対して開く。 */
  const [stepTargetOpen, setStepTargetOpen] = useState(false)
  /** テスト送信。null なら閉じている。stepId が null なら全通。 */
  const [testSend, setTestSend] = useState<{ stepId: string | null; label: string } | null>(null)
  /** アクション設定。 */
  const [actionTarget, setActionTarget] = useState<{
    hook: 'step_sent' | 'scenario_completed' | 'choice_selected'
    stepId: string | null
    choiceIndex: number | null
    title: string
  } | null>(null)
  /** 通ごとのアクション件数。バッジに出す。 */
  const [actionCounts, setActionCounts] = useState<Record<string, number>>({})
  /** 開始のきっかけ。窓の開閉と、札に出す件数。 */
  const [triggerOpen, setTriggerOpen] = useState(false)
  const [triggerCount, setTriggerCount] = useState<number | null>(null)
  /* WEB229：開始のきっかけを保存した回数。見出しの名前・試算の鍵を取り直す。 */
  const [triggerRevision, setTriggerRevision] = useState(0)
  /** 位置情報・動画・音声・スタンプの入力。 */
  const [kindState, setKindState] = useState<MessageKindState>(() => emptyMessageKindState())
  /** 通の入力欄を開いた回の番号。開くたびに「開いた直後の形」を比べる元として採り直す。 */
  const [stepFormNonce, setStepFormNonce] = useState(0)
  const [stepFormBaseline, setStepFormBaseline] = useState<{ nonce: number; value: { stepForm: StepFormState; kindState: MessageKindState } } | null>(null)
  /** 差し込みをカーソルの位置に入れるために、本文の入力欄を持つ。 */
  const stepBodyRef = useRef<InsertTextFieldHandle | HTMLTextAreaElement>(null)

  const [previewOpen, setPreviewOpen] = useState(false)

  const [stats, setStats] = useState<ScenarioStats | null>(null)
  /*
   * ★V8: 開始前の確認で試算が取れなかったときの「読み直す」。
   * simulationKey が同じままだと取り直しが走らないので、回数を足して
   * 強制的にもう一度取らせる。
   */
  const [simRetry, setSimRetry] = useState(0)
  /*
   * SCENARIO-15: 試算は「いま保存されている設定」に対する結果。
   * 結果は計算した設定の鍵と一緒に持ち、設定が変わって鍵が合わなく
   * なった旧値は確定値として出さない（取り直し中は計算中と出す）。
   */
  const [simulationResult, setSimulationResult] = useState<ScenarioSimulationResult | null>(null)
  const [runs, setRuns] = useState<ScenarioRuns | null>(null)
  const [templates, setTemplates] = useState<TemplateOpt[]>([])
  const [tags, setTags] = useState<TagOpt[]>([])

  const sortedSteps = [...(scenario?.steps ?? [])].sort((a, b) => a.stepOrder - b.stepOrder)
  const deliveryMode: DeliveryMode = (scenario?.deliveryMode ?? 'relative') as DeliveryMode
const { loadScenario, reloadStats, simulationRefreshing, simulation, reloadActionCounts } = useScenarioReads({
    setLoading, setError, setScenarioMissing,
    id, setScenario, shownUpdatedAtRef,
    setConflict, setEditForm, saveErrors,
    loading, scenario, setConflictLatest,
    setStats, setTemplates, setTags,
    setActionCounts, triggerCount, triggerRevision,
    simulationResult, setSimulationResult, setRuns,
    simRetry, setTriggerCount, setTriggerItems,
    setPreviewLabels,
  })
  /**
   * シナリオを丸ごと複製する。
   *
   * 似た流れをもう1本作るとき、通を1つずつ写すのは現実的でない。
   * 中身だけ写して、名前に「のコピー」を付け、止めた状態で作る。
   * 作った直後に配信が始まると、確かめる前に届いてしまう。
   */
const { saveErrors: copySaveErrors, handleDuplicate, handleDeleteScenario, handleDiscardDuplicate } = useScenarioCopy({
    scenario, duplicating, setDuplicating,
    setError, duplicateRemainder, saveErrors,
    sortedSteps, deliveryMode, id,
    setDuplicateRemainder, setDuplicateOpen, discardingDuplicate,
    setDiscardingDuplicate, setDiscardDuplicateError, setDiscardDuplicateOpen,
    deletingScenario, setDeletingScenario, setDeleteScenarioError, deleteConfirmation: currentDeleteConfirmation, deleteConfirmationValid,
    refreshDeleteConfirmation: () => prepareConfirmation('delete'),
    setDeleteScenarioOpen: closeDeleteConfirmation, router,
  })
  const {
  saveErrors: settingsSaveErrors, editDirty, openRenameDialog, openDuplicateDialog, acceptLatestAndContinue,
  handleSaveScenario, latestSummary, currentSummary, handleStart,
  handleStop,
} = useScenarioSettings({
    editForm, setSaving, id,
    setEditing, setRenameOpen, setSaveDone,
    loadScenario, setError, saveErrors: copySaveErrors,
    setConflict, setConflictLatest, setCompareOpen,
    scenario, conflictLatest, startBusy,
    startConfirmed, setStartBusy, setStartError,
    setStartOpen, setJustStarted, reloadStats,
    stopBusy, setStopBusy, setStopError, stopConfirmation: currentStopConfirmation, stopConfirmationValid,
    setStopOpen: closeStopConfirmation, setDuplicateName, setDuplicateOpen,
    setEditForm,
  })
  const { leaveTarget, confirmLeave, cancelLeave } = useUnsavedGuard({ dirty: editDirty, busy: saving })

  /** 追従バーの「キャンセル」。未保存があれば戻し、なければ一覧へ。 */
  const handleCancel = () => {
    if (scenario && editDirty) {
      setEditForm({
        name: scenario.name,
        description: scenario.description ?? '',
        triggerType: scenario.triggerType,
        isActive: scenario.isActive,
        allowConcurrent: scenario.allowConcurrent !== false,
        folderId: scenario.folderId ?? '',
      })
      return
    }
    router.push('/scenarios')
  }

  const stepFormPreview = previewOffsets(deliveryMode, stepForm.schedule)

  /*
   * 通の保存は配信の行へ直に入る（下書きの口が無い）。書きかけの通はこのブラウザに
   * だけ残し、同じ通を開き直したときに「前の入力を戻す」を出す。キャンセルで捨てる。
   */
  const stepFormOpen = showStepForm || editingStepId !== null
  const stepFormValue = { stepForm, kindState }
  useEffect(() => {
    if (!stepFormOpen) {
      if (stepFormBaseline !== null) setStepFormBaseline(null)
      return
    }
    if (stepFormBaseline?.nonce !== stepFormNonce) setStepFormBaseline({ nonce: stepFormNonce, value: stepFormValue })
    // 開いた直後の形だけを採る。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepFormOpen, stepFormNonce, stepFormBaseline])
  // 書きかけはシナリオの下書きの口（本物の通とは別の行・配信に使わない）へ残す。
  const stepDraft = useScenarioDraft({
    accountId: scenario?.lineAccountId ?? selectedAccountId,
    draftKey: stepFormOpen && scenario && stepFormBaseline?.nonce === stepFormNonce
      ? scenarioDraftKey(id, { stepId: editingStepId })
      : null,
    // 共通（アカウントなし）のシナリオは本物に紐づけられないので、キーだけで置く。
    scenarioId: scenario?.lineAccountId ? id : null,
    stepId: scenario?.lineAccountId ? editingStepId : null,
    legacyKey: scenario ? browserDraftKey(['scenario-step', scenario.lineAccountId, id, editingStepId ?? 'new']) : null,
    value: stepFormValue,
    baseline: stepFormBaseline?.value ?? stepFormValue,
    active: canEdit,
  })
  const {
  saveErrors: stepSaveErrors, handleSaveStep, closeStepForm, openInsertStep, openEditStep,
  handleMoveStep, handleDuplicateStep, openAddStep, openAddTemplateStep,
  openAddQuestionStep, handleDeleteStep,
} = useScenarioStepActions({
    scenario, setStepForm, setEditingStepId,
    setShowStepForm, setInsertAfter, setStepError,
    setStepFormNonce, setKindState, id,
    stepForm, failStep, kindState,
    saveErrors: settingsSaveErrors, deliveryMode, stepFields,
    setStepSaving, templates, editingStepId,
    loadScenario, insertAfter, sortedSteps,
    stepDraft, reloadStats, duplicatingStepId,
    setDuplicatingStepId, deleteStepTarget, deleteStepRevision, deleteStepConfirmationValid, deletingStepId,
    setDeletingStepId, setDeleteStepError, setDeleteStepTarget: setScopedDeleteStepTarget,
    setError,
  })
  const restoreStepDraft = () => {
    const stored = stepDraft.restore()
    if (stored) applyStepDraft(stored)
  }
  const loadLatestStepDraft = () => {
    const latest = stepDraft.loadLatest()
    if (latest) applyStepDraft(latest)
  }
  function applyStepDraft(stored: typeof stepFormValue) {
    // 新しく足す通の番号は今の並びで決める（残っていた番号は古いことがある）。
    setStepForm(editingStepId ? stored.stepForm : { ...stored.stepForm, stepOrder: stepForm.stepOrder })
    setKindState(stored.kindState)
  }

  // 新規追加（上部）とステップ編集（行直下インライン）の両方で使うフォーム。
  // 同時に開くのは常に片方だけなので、state は stepForm を共有する。
  const renderStepForm = () => (
<ScenarioStepForm
        accountName={scenario?.lineAccountId ? (accounts.find((account) => account.id === scenario.lineAccountId)?.name ?? '—（名前を読み込めません）') : undefined}
        editingStepId={editingStepId}
        stepDraft={stepDraft}
        restoreStepDraft={restoreStepDraft}
        loadLatestStepDraft={loadLatestStepDraft}
        stepForm={stepForm}
        setStepForm={setStepForm}
        stepFields={stepFields}
        deliveryMode={deliveryMode}
        scenario={scenario}
        setActionTarget={setActionTarget}
        templates={templates}
        folderAccountId={folderAccountId}
        kindState={kindState}
        setKindState={setKindState}
        stepBodyRef={stepBodyRef}
        setStepTargetOpen={setStepTargetOpen}
        tags={tags}
        stepError={stepError}
        handleSaveStep={handleSaveStep}
        stepSaving={stepSaving}
        closeStepForm={closeStepForm}
        stepFormPreview={stepFormPreview}
       />
  )

  /* ===== ここから下は ★V8 の描画（ 有効 /  始めた直後 /  停止中） ===== */

  if (loading) {
    return (
      <SaveErrorScope errors={stepSaveErrors}><div className={styles.board}>
        <DetailLoading />
      </div></SaveErrorScope>
    )
  }

  if (!scenario && (scenarioMissing || !error)) {
    return (
      <SaveErrorScope errors={stepSaveErrors}><TargetMissing
        kind="not-found"
        title="このシナリオは見つかりません"
        description="削除されたか、別の LINE アカウントのものです。一覧から選び直してください。"
        backHref="/scenarios"
        backLabel="シナリオ一覧へ戻る"
      /></SaveErrorScope>
    )
  }

  if (!scenario) {
    return (
      <SaveErrorScope errors={stepSaveErrors}><TargetMissing
        kind="error"
        title="シナリオを読み込めませんでした"
        description="通信が切れたか、サーバが応えませんでした。しばらくしてから、もう一度読み込んでください。"
        onRetry={() => void loadScenario(true)}
      /></SaveErrorScope>
    )
  }

  /**
   * 隣り合う通の間で、いちばん人が減ったところ。
   *
   * 到達人数はステップごとに集計済みだったが、画面はそれを表の中でしか
   * 使っていなかった。「どこで読まれなくなるか」は1通ずつ見比べないと
   * 分からず、通数が増えるほど気づけない。差がいちばん大きい1か所を出す。
   *
   * 減っていない（増えている）ときは出さない。分岐で人が分かれた場合など、
   * 減少として読むと誤解になる。
   */
  const biggestDrop = (() => {
    const steps = stats?.steps ?? []
    if (steps.length < 2) return null
    let worst: { fromOrder: number; toOrder: number; lost: number; rate: number } | null = null
    for (let i = 0; i < steps.length - 1; i += 1) {
      const from = steps[i]
      const to = steps[i + 1]
      const lost = from.reachedCount - to.reachedCount
      if (lost <= 0 || from.reachedCount === 0) continue
      const rate = lost / from.reachedCount
      if (!worst || lost > worst.lost) {
        worst = { fromOrder: from.stepOrder, toOrder: to.stepOrder, lost, rate }
      }
    }
    return worst
  })()
  const modeLabel = MODE_LABEL[deliveryMode]

  /*
   * 右の欄のスマホに出す通。何も選んでいなければ先頭の通。
   * 通の削除などで selectedStepId が残っていても、無ければ先頭に戻す。
   */
  const shownStepId = sortedSteps.some((s) => s.id === selectedStepId)
    ? selectedStepId
    : (sortedSteps[0]?.id ?? null)
  const shownStep = sortedSteps.find((s) => s.id === shownStepId) ?? null
  const shownTpl = shownStep?.templateId
    ? templates.find((t) => t.id === shownStep.templateId) ?? null
    : null

  /*
   * ②の箱の大きい字。TriggerEditor ではなく「開始のきっかけ」の実一覧
   * （triggerItems）から名前を組み立てる。取れなければ「確認中…」、
   * 0件なら「呼ばれたときだけ」（アクション・手動での開始）。
   */
  const tagNameById = Object.fromEntries(tags.map((t) => [t.id, t.name]))
  const triggerHeadline =
    triggerItems === null
      ? '確認中…'
      : triggerItems.length === 0
        ? '呼ばれたときだけ'
        : triggerItems
            .map((t) => describeStartTrigger(t, t.tagId ? tagNameById[t.tagId] ?? null : null))
            .join('、')
  const audienceConditionLabel = describeCondition(
    (scenario.audienceCondition as SegmentCondition | null) ?? null,
  )

  /*
   * 開始前の確認の中身。画面が常に持っている試算・運用記録・
   * きっかけ一覧をそのまま使う（窓のために取り直さない）。
   * preflight が動いているあいだは「確認中」、両方取れないときは
   * 「試算できません」として開始ボタンを止める（SCENARIO-07 と同じ判断）。
   */
  const preflightLoading = simulationRefreshing || (simulation === null && runs === null && !scenario.lineAccountId)
  const preflightFailed = !simulationRefreshing && simulation === null && runs === null
  const startChecks = startChecklist({ ...scenario, stepCount: sortedSteps.length }).map((item, index) => {
    if (index === 1 && simulation) {
      const complete = simulation.steps.length > 0
      return {
        ...item,
        state: complete ? ('ok' as const) : ('warn' as const),
        detail: complete
          ? `${simulation.steps.length} 通すべての配信日時を試算しました`
          : '配信日時を試算できない通があります',
      }
    }
    if (index === 2 && runs) {
      return {
        ...item,
        state: runs.testSends.length > 0 ? ('ok' as const) : ('warn' as const),
        detail:
          runs.testSends.length > 0
            ? `最新のテスト送信は${formatNumber(runs.testSends[0].messageCount)} 通です`
            : 'テスト送信の記録がありません',
      }
    }
    if (index === 3 && runs) {
      const enough =
        runs.quota.remaining === null
          ? runs.quota.state === 'unlimited'
          : runs.quota.remaining >= (simulation?.audience.newStartPlanned ?? 0)
      return {
        ...item,
        state: enough ? ('ok' as const) : ('warn' as const),
        detail:
          runs.quota.state === 'unlimited'
            ? '送信数の上限はありません'
            : runs.quota.remaining === null
              ? (runs.quota.reason ?? '送信枠を読み込めませんでした')
              : `残り${formatNumber(runs.quota.remaining)} 通です`,
      }
    }
    return item
  })
  const startAccountLabel =
    scenario.lineAccountId === null
      ? '全アカウント共通'
      : (accounts.find((a) => a.id === scenario.lineAccountId)?.name ?? '—（名前を読み込めません）')
  const startCompleteSummary = ON_COMPLETE_LABEL[(scenario.onCompleteMode ?? 'pause') as OnCompleteMode]
  const startedAt = formatSavedAt(runs?.subscriptions?.[0]?.startedAt)

  return (
    <SaveErrorScope errors={stepSaveErrors}><PageFrame kind="detail" boardId={conflict ? 'kz2B6' : scenario.isActive ? 'PMLkX' : 'ARuZ4'} hasFooter>
      {/* 板の頭：題＋状態の札＋鉛筆・説明の1行。右に操作（配信結果・下見・まとめてテスト・その他）。 */}
      <PageHeading title={scenario.name}
        crumbs={<><p className={styles.meta}>
            {`フォルダ：${scenarioFolderName}・配信方式：${modeLabel}（作ったあとは変えられません）・${(scenario.allowConcurrent ?? true) ? '同時購読を許可中' : '同時に1つだけ'}`}
          </p></>}
        titleAccessory={<><StatusChip status={scenario.isActive ? 'running' : 'paused'} />{canEdit ? (
              <button
                type="button"
                className={styles.iconButton}
                onClick={openRenameDialog}
                title="名前・説明・置き場を変える"
                aria-label="名前・説明・置き場を変える"
              >
                <Pencil aria-hidden />
              </button>
            ) : null}</>}
        actions={<><Button variant="secondary" href={`/scenarios/results?id=${id}`}>
            <BarChart3 aria-hidden />
            配信結果を見る
          </Button><Button
            variant="secondary"
            onClick={() => setPreviewOpen(true)}
            disabled={sortedSteps.length === 0}
            title={sortedSteps.length === 0 ? '配る内容がまだありません' : undefined}
          >
            <Eye aria-hidden />
            まとめて下見
          </Button>
          {canTestSend ? (
            <Button
              variant="secondary"
              onClick={() => setTestSend({ stepId: null, label: 'すべての通' })}
              disabled={sortedSteps.length === 0}
              title={sortedSteps.length === 0 ? '配る内容がまだありません' : undefined}
            >
              <Send aria-hidden />
              まとめてテストを送る
            </Button>
          ) : null}{canEdit ? (
            <RowMenu
                appearance="plain"
                label="このシナリオのその他操作"
                menuLabel="このシナリオの操作"
                open={stepMenuId === '__head__'}
                onOpenChange={(next) => setStepMenuId(next ? '__head__' : null)}
                items={[
                  {
                    id: 'audience',
                    label: '対象を絞る',
                    onSelect: () => setAudienceOpen(true),
                  },
                  {
                    id: 'duplicate',
                    /* 下の帯の「複製する」と同じ窓を開く。文言を変えるのは、撮影・試験が下の帯のボタンと取り違えないため。 */
                    label: 'このシナリオを複製',
                    disabled: duplicating,
                    onSelect: openDuplicateDialog,
                  },
                  {
                    id: 'delete',
                    label: 'このシナリオを削除',
                    tone: 'danger' as const,
                    dividerBefore: true,
                    onSelect: () => {
                      setDeleteScenarioError('')
                      void prepareConfirmation('delete')
                    },
                  },
                ]}
            />
          ) : null}</>} />

      {/* 競合（kz2B6）：ほかの人の保存と食い違った。板の頭のすぐ下に、幅いっぱいで出す。 */}
      {conflict && (
        <div className={styles.conflictWrap}>
          <SaveConflictBand designNode="kz2B6" title={conflictLatest
                  ? `ほかの人が ${formatClock(conflictLatest.updatedAt)} にシナリオ「${conflictLatest.name}」を保存しました`
                  : 'ほかの人がこのシナリオを保存しました'} description="あなたが直した所はまだ保存されていません。このまま保存すると、ほかの人の変更が消えます。" onCompare={() => setCompareOpen(true)} compareDisabled={!conflictLatest} onReload={() => void acceptLatestAndContinue()} />
        </div>
      )}

<ScenarioDetailBody
        FlexPreview={FlexPreview}
        canEdit={canEdit}
        justStarted={justStarted}
        stats={stats}
        simulation={simulation}
        simulationRefreshing={simulationRefreshing}
        id={id}
        startedAt={startedAt}
        error={error}
        duplicateRemainder={duplicateRemainder}
        duplicating={duplicating}
        handleDuplicate={handleDuplicate}
        discardingDuplicate={discardingDuplicate}
        setDiscardDuplicateError={setDiscardDuplicateError}
        setDiscardDuplicateOpen={setDiscardDuplicateOpen}
        editDirty={editDirty}
        scenario={scenario}
        triggerHeadline={triggerHeadline}
        audienceConditionLabel={audienceConditionLabel}
        setTriggerOpen={setTriggerOpen}
        setStopError={setStopError}
        setStopOpen={(next) => { if (next === true) void prepareConfirmation('stop'); else closeStopConfirmation(next) }}
        setStartError={setStartError}
        setStartConfirmed={setStartConfirmed}
        setStartOpen={setStartOpen}
        sortedSteps={sortedSteps}
        biggestDrop={biggestDrop}
        setOnCompleteOpen={setOnCompleteOpen}
        templates={templates}
        shownStepId={shownStepId}
        openInsertStep={openInsertStep}
        setSelectedStepId={setSelectedStepId}
        deliveryMode={deliveryMode}
        previewLabels={previewLabels}
        editingStepId={editingStepId}
        closeStepForm={closeStepForm}
        openEditStep={openEditStep}
        handleMoveStep={handleMoveStep}
        stepMenuId={stepMenuId}
        setStepMenuId={setStepMenuId}
        canTestSend={canTestSend}
        setTestSend={setTestSend}
        actionCounts={actionCounts}
        setActionTarget={setActionTarget}
        duplicatingStepId={duplicatingStepId}
        handleDuplicateStep={handleDuplicateStep}
        setDeleteStepError={setDeleteStepError}
        setDeleteStepTarget={setScopedDeleteStepTarget}
        renderStepForm={renderStepForm}
        showStepForm={showStepForm}
        tags={tags}
        openAddStep={openAddStep}
        openAddTemplateStep={openAddTemplateStep}
        openAddQuestionStep={openAddQuestionStep}
        shownStep={shownStep}
        startAccountLabel={startAccountLabel}
        shownTpl={shownTpl}
        saveErrors={saveErrors}
       />

      {/* 下の帯（追従・常に画面の下）：左端に削除、中央に「キャンセル・複製する・保存する」。 */}
      <div className={styles.footer}>
        <StickyBar
          destructive={
            canEdit ? (
              <StickyBarAction destructive
                icon={Trash2}
                label="このシナリオを削除する"
                onClick={() => {
                  setDeleteScenarioError('')
                  void prepareConfirmation('delete')
                }}
              />
            ) : undefined
          }
          actions={
            <>
              <Button variant="secondary" onClick={handleCancel} disabled={saving}>
                キャンセル
              </Button>
              {canEdit ? (
                <Button variant="secondary" onClick={openDuplicateDialog} disabled={duplicating}>
                  <Copy aria-hidden />
                  複製する
                </Button>
              ) : null}
              {canEdit ? (
                <Button
                  variant="primary" icon={conflict ? <GitCompareArrows aria-hidden /> : <Check aria-hidden />}
                  onClick={() => {
                    if (conflict) {
                      setCompareOpen(true)
                    } else {
                      void handleSaveScenario()
                    }
                  }}
                  disabled={saving || !editForm.name.trim()}
                  busy={saving}

                >
                  {conflict ? '比べてから保存' : '保存する'}
                </Button>
              ) : null}
            </>
          }
        />
      </div>

<ScenarioDetailDialogs
        renameOpen={renameOpen}
        saving={saving}
        scenario={scenario}
        setEditForm={setEditForm}
        setRenameOpen={setRenameOpen}
        handleSaveScenario={handleSaveScenario}
        editForm={editForm}
        folderState={folderState}
        folders={folders}
        canEdit={canEdit}
        setFolders={setFolders}
        editFolderMissing={editFolderMissing}
        compareOpen={compareOpen}
        setCompareOpen={setCompareOpen}
        acceptLatestAndContinue={acceptLatestAndContinue}
        latestSummary={latestSummary}
        currentSummary={currentSummary}
        leaveTarget={leaveTarget}
        confirmLeave={confirmLeave}
        cancelLeave={cancelLeave}
        startOpen={startOpen}
        startBusy={startBusy}
        startError={startError}
        preflightLoading={preflightLoading}
        preflightFailed={preflightFailed}
        handleStart={handleStart}
        startConfirmed={startConfirmed}
        setStartOpen={setStartOpen}
        setStartError={setStartError}
        startAccountLabel={startAccountLabel}
        triggerHeadline={triggerHeadline}
        simulation={simulation}
        sortedSteps={sortedSteps}
        startCompleteSummary={startCompleteSummary}
        setSimRetry={setSimRetry}
        startChecks={startChecks}
        setStartConfirmed={setStartConfirmed}
        stopOpen={stopOpen && currentStopConfirmation !== null}
        stopBusy={stopBusy}
        stopError={stopError}
        stopConfirmationCount={currentStopConfirmation?.activeCount}
        deleteConfirmationCount={currentDeleteConfirmation?.activeCount}
        setStopOpen={closeStopConfirmation}
        setStopError={setStopError}
        stats={stats}
        handleStop={handleStop}
        duplicateOpen={duplicateOpen}
        duplicating={duplicating}
        setDuplicateOpen={setDuplicateOpen}
        duplicateName={duplicateName}
        setDuplicateName={setDuplicateName}
        modeLabel={modeLabel}
        handleDuplicate={handleDuplicate}
        previewOpen={previewOpen}
        id={id}
        setPreviewOpen={setPreviewOpen}
        deleteStepTarget={deleteStepTarget}
        deletingStepId={deletingStepId}
        deleteStepError={deleteStepError}
        handleDeleteStep={handleDeleteStep}
        setDeleteStepTarget={setScopedDeleteStepTarget}
        setDeleteStepError={setDeleteStepError}
        deleteScenarioOpen={deleteScenarioOpen && currentDeleteConfirmation !== null}
        deletingScenario={deletingScenario}
        deleteScenarioError={deleteScenarioError}
        handleDeleteScenario={handleDeleteScenario}
        setDeleteScenarioOpen={closeDeleteConfirmation}
        setDeleteScenarioError={setDeleteScenarioError}
        discardDuplicateOpen={discardDuplicateOpen}
        duplicateRemainder={duplicateRemainder}
        discardingDuplicate={discardingDuplicate}
        discardDuplicateError={discardDuplicateError}
        handleDiscardDuplicate={handleDiscardDuplicate}
        setDiscardDuplicateOpen={setDiscardDuplicateOpen}
        setDiscardDuplicateError={setDiscardDuplicateError}
        audienceOpen={audienceOpen}
        loadScenario={loadScenario}
        setAudienceOpen={setAudienceOpen}
        onCompleteOpen={onCompleteOpen}
        setOnCompleteOpen={setOnCompleteOpen}
        actionCounts={actionCounts}
        setActionTarget={setActionTarget}
        stepTargetOpen={stepTargetOpen}
        stepForm={stepForm}
        setStepForm={setStepForm}
        setStepTargetOpen={setStepTargetOpen}
        canTestSend={canTestSend}
        testSend={testSend}
        deliveryMode={deliveryMode}
        templates={templates}
        setTestSend={setTestSend}
        triggerOpen={triggerOpen}
        setTriggerOpen={setTriggerOpen}
        setTriggerCount={setTriggerCount}
        setTriggerRevision={setTriggerRevision}
        actionTarget={actionTarget}
        reloadActionCounts={reloadActionCounts}
       />
    </PageFrame></SaveErrorScope>
  )
}
