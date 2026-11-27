'use client'

import { BasicsStageV8 } from './edit-basics'
import { ConfirmStageV8,DoneStageV8 } from './edit-confirm'
import { MessagesStageV8 } from './edit-messages'
import { StageFrame, stageFor, useNarrowBoard, countLabel, reminderAudienceCounts } from './edit-model';
import { ScheduleStageV8 } from './edit-schedule'

export { ConfirmStageV8,DoneStageV8 } from './edit-confirm'
export { reminderAudienceCounts,stageFor } from './edit-model'
export { ScheduleStageV8 } from './edit-schedule'
import { testSendConfirmDescription } from '@/components/reminders/test-recipient-guidance'
import { useReminderTestRecipient } from '@/components/reminders/use-reminder-test-recipient'
import { useReminderTestSend } from '@/components/reminders/use-reminder-test-send'
import { isForbiddenOrRateLimited,loadFailureCopy } from '@/components/shared/api-error-message'
import Button from '@/components/shared/button'
import ConditionBuilder, { findConditionDraftIssue, pruneCondition, type SegmentCondition } from '@/components/shared/condition-builder';
import ConfirmDialog from '@/components/shared/confirm-dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import { SaveConflictBand } from '@/components/shared/save-conflict'
import { SaveErrorScope, useSaveFormErrors, SaveErrorField } from '@/components/shared/save-form-errors';
import { usePageTitle } from '@/components/shell/page-chrome'
import { ApiError,api } from '@/lib/api'
import { canManageRole,useStaffRole } from '@/lib/staff-role'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { useDraftAutosave } from '@/v8/autosave/public/use-draft-autosave/index'
import {
type ReminderDraftSettings,
type ReminderDraftVersion,
type ReminderPreviewResult,
type ReminderPublishResult,
type ReminderValidationResult
} from '@line-crm/shared'
import { useCallback, useEffect, useRef, useState, ReactNode } from 'react';
import {
basicsFromDraft,
basicsToDraft,
type BasicsValue
} from './basics-form'
import { describeReminderDiff } from './conflict-diff'
import styles from './edit.module.css'
import { BackToReminders, ReminderV8Stepper, type ReminderV8StepKey, ChoiceCardV8, PhoneV8, SummaryCardV8, WizardFooterV8 } from './ui';
import Toggle from '@/components/shared/toggle';
import { reminderTriggerLabel } from '@/components/reminders/reminder-labels'
import { fillPreviewSample } from '@/components/shared/preview-sample'
import Dialog from '@/components/shared/dialog';
import { emptyValue } from '@/components/shared/empty-value';
import { CreatePage } from '@/components/templates';
import { StepContent } from '@/components/templates/steps'
import { useAccount } from '@/contexts/account-context';
import { formatNumber } from '@/lib/format';
import { ArrowRight, Filter, RefreshCw, Users } from 'lucide-react';

export default function ReminderEditV8({ reminderId, stage }: { reminderId: string; stage: string | null }) {
  const saveErrors = useSaveFormErrors()

  const v8stage = stageFor(stage)
  const narrowBoard = useNarrowBoard()
  usePageTitle(
    v8stage === 'basics' ? 'リマインダを作成・基本設定'
      : v8stage === 'target' ? 'リマインダを作成・対象者と止める条件'
        : v8stage === 'messages' ? 'リマインダを作成・通知の中身'
          : v8stage === 'schedule' ? 'リマインダを作成・配信予定'
            : v8stage === 'confirm' ? 'リマインダを作成・確認'
              : 'リマインダ・有効化完了',
  )
  const router = useRouter()
  const [draft, setDraft] = useState<ReminderDraftVersion | null>(null)
  const [settings, setSettings] = useState<ReminderDraftSettings | null>(null)
  /*
   * 基本設定の入力値はここで持つ。basicsToDraft は保存の直前にだけ通す
   * （trim が打鍵を消すため）。dirty は「いまの値」対「保存済みから戻した値」。
   */
  const [basics, setBasics] = useState<BasicsValue | null>(null)
  const [preview, setPreview] = useState<ReminderPreviewResult | null>(null)
  const [previewState, setPreviewState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [previewRetryToken, setPreviewRetryToken] = useState(0)
  const [validation, setValidation] = useState<ReminderValidationResult | null>(null)
  const [validationState, setValidationState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [validationRetryToken, setValidationRetryToken] = useState(0)
  const [published, setPublished] = useState<ReminderPublishResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadMissing, setLoadMissing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [loadError, setLoadError] = useState<unknown>(null)
  const [conflict, setConflict] = useState(false)
  const [compareTarget, setCompareTarget] = useState<ReminderDraftSettings | null>(null)
  const [compareBusy, setCompareBusy] = useState(false)
  const [compareError, setCompareError] = useState('')
  const [testConfirm, setTestConfirm] = useState(false)
  const requestSeq = useRef(0)

  // テスト送信の口は確認の段だけ開く。ほかの段で余計な GET を打たない。
  const testRecipient = useReminderTestRecipient(v8stage === 'confirm' ? reminderId : null)
  const testSend = useReminderTestSend(v8stage === 'confirm' ? reminderId : null)

  const go = useCallback(
    (next: string | null) => router.push(`/reminders/edit?id=${encodeURIComponent(reminderId)}${next ? `&stage=${next}` : ''}`),
    [reminderId, router],
  )

  const loadDraft = useCallback(async () => {
    const seq = ++requestSeq.current
    setLoading(true)
    setError('')
    setLoadError(null)
    setLoadMissing(false)
    try {
      const response = await api.reminders.getDraft(reminderId)
      if (seq !== requestSeq.current) return
      if (!response.success) throw new Error(response.error)
      if (response.data.reminderId !== reminderId) throw new Error('下書きを読み込めませんでした。')
      setDraft(response.data)
      setSettings(response.data.settings)
      setBasics(basicsFromDraft(response.data.settings))
      setConflict(false)
    } catch (caught) {
      if (seq !== requestSeq.current) return
      setLoadError(caught)
      const fieldFailure = saveErrors.capture(caught);

      if (caught instanceof ApiError && caught.status === 404) setLoadMissing(true)
      else { if (!fieldFailure)
 setError('下書きを読み込めませんでした。') }
    } finally {
      if (seq === requestSeq.current) setLoading(false)
    }
  }, [reminderId, saveErrors])

  useEffect(() => {
    setDraft(null)
    setSettings(null)
    setBasics(null)
    setPreview(null)
    setValidation(null)
    setPublished(null)
    setTestConfirm(false)
    setPreviewState('idle')
    setValidationState('idle')
    void loadDraft()
  }, [loadDraft])

  // 競合「最新を読み込んで続ける」。入力中の内容は最新の版で置き換わる。
  const reloadAfterConflict = async () => {
    setCompareTarget(null)
    setCompareError('')
    setError('')
    await loadDraft()
  }

  // 競合「違いを比べる」。最新を取って比べるだけで、画面は書き換えない。
  const openCompare = async () => {
    if (compareBusy) return
    setCompareBusy(true)
    setCompareError('')
    try {
      const response = await api.reminders.getDraft(reminderId)
      if (!response.success || response.data.reminderId !== reminderId) {
        setCompareError('最新の内容を取れませんでした。もう一度お試しください。')
        return
      }
      setCompareTarget(response.data.settings)
    } catch (saveFailure) {
      const fieldFailure = saveErrors.capture(saveFailure)

      { if (!fieldFailure)
      setCompareError('最新の内容を取れませんでした。もう一度お試しください。') }
    } finally {
      setCompareBusy(false)
    }
  }

  // 配信予定は「配信予定」「確認」「完了」で読む。
  useEffect(() => {
    if (!settings || (v8stage !== 'schedule' && v8stage !== 'confirm' && v8stage !== 'done')) return
    let active = true
    setPreviewState('loading')
    void api.reminders.previewDraft(reminderId).then((response) => {
      if (!active) return
      if (response.success) {
        setPreview(response.data)
        setPreviewState('ready')
      } else {
        setPreviewState('error')
      }
    }).catch(() => { if (active) setPreviewState('error') })
    return () => { active = false }
  }, [reminderId, settings, v8stage, previewRetryToken])

  // 公開前チェックは対象・確認・完了で読む。
  useEffect(() => {
    if (!settings || (v8stage !== 'target' && v8stage !== 'confirm' && v8stage !== 'done')) return
    let active = true
    setValidationState('loading')
    void api.reminders.validateDraft(reminderId).then((response) => {
      if (!active) return
      if (response.success) {
        setValidation(response.data)
        setValidationState('ready')
      } else {
        setValidationState('error')
      }
    }).catch(() => { if (active) setValidationState('error') })
    return () => { active = false }
  }, [reminderId, settings, v8stage, validationRetryToken])

  const retryPreview = useCallback(() => setPreviewRetryToken((value) => value + 1), [])
  const retryValidation = useCallback(() => setValidationRetryToken((value) => value + 1), [])

  // 入力を持つ段（基本・対象・通知）は書きかけを「未保存の変更あり」として守る。
  const basicsDirty = v8stage === 'basics'
    && draft !== null && basics !== null
    && JSON.stringify(basics) !== JSON.stringify(basicsFromDraft(draft.settings))
  const settingsDirty = (v8stage === 'target' || v8stage === 'messages')
    && draft !== null && settings !== null
    && JSON.stringify(settings) !== JSON.stringify(draft.settings)
  const dirty = basicsDirty || settingsDirty
  const draftRef = useRef(draft)
  draftRef.current = draft
  const { leaveTarget, confirmLeave, cancelLeave } = useUnsavedGuard({
    dirty,
    busy,
    onDiscard: () => {
      const saved = draftRef.current
      if (saved) {
        setSettings(saved.settings)
        setBasics(basicsFromDraft(saved.settings))
      }
    },
  })

  /*
   * 自動保存と手の保存が重なると、同じ版を2回送って競合に見える。
   * 送っている途中の保存を待ち、最新の版（draftRef）で送る。
   */
  const saveInFlight = useRef<Promise<unknown> | null>(null)
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const basicsRef = useRef(basics)
  basicsRef.current = basics

  /**
   * 下書きを保存する。409 は読み直しの帯へ出す。
   * silent は自動保存：押せない印・赤い帯は出さない。保存中に打ち足した入力は
   * 応答で上書きせず、そのまま残す（次の自動保存で追って送る）。
   */
  async function saveSettings(next: ReminderDraftSettings, { silent = false }: { silent?: boolean } = {}): Promise<boolean> {
    if (next.targetCondition && (!pruneCondition(next.targetCondition as SegmentCondition) || findConditionDraftIssue(next.targetCondition as SegmentCondition))) {
      if (!silent) setError('対象者の条件を完成させてください。')
      return false
    }
    if (!silent) {
      setBusy(true)
      setError('')
      setConflict(false)
    }
    while (saveInFlight.current) await saveInFlight.current.catch(() => undefined)
    const base = draftRef.current
    const sentSettings = settingsRef.current
    const sentBasics = basicsRef.current
    const request = api.reminders.saveDraft(
      reminderId,
      next,
      // 開いたときの版 ID と版の時刻を送り、別の画面の先勝ちを止める。
      base ? { expectedVersionId: base.versionId, expectedUpdatedAt: base.updatedAt } : {},
    )
    saveInFlight.current = request
    try {
      const response = await request
      if (!response.success) throw new Error(response.error)
      draftRef.current = response.data
      setDraft(response.data)
      setConflict(false)
      const untouched = settingsRef.current === sentSettings && basicsRef.current === sentBasics
      if (untouched) {
        setSettings(response.data.settings)
        setBasics(basicsFromDraft(response.data.settings))
      }
      return true
    } catch (caught) {
      const fieldFailure = saveErrors.capture(caught);

      if (caught instanceof ApiError && caught.status === 409) {
        setConflict(true)
      } else if (!silent) {
        { if (!fieldFailure)

        setError('保存できませんでした。時間をおいて、もう一度お試しください。') }
      }
      return false
    } finally {
      if (saveInFlight.current === request) saveInFlight.current = null
      if (!silent) setBusy(false)
    }
  }

  /*
   * 入力を持つ段（基本・対象・通知）は、入力が止まって2秒で下書きへ静かに保存する
   * （一斉配信と同じ）。下書きなので有効中の配信は変わらない。閲覧のみの人には動かさない。
   */
  const role = useStaffRole()
  const autosave = useDraftAutosave({
    fingerprint: JSON.stringify(v8stage === 'basics' ? basics : settings),
    dirty,
    active: canManageRole(role),
    enabled: !loading && !conflict && draft !== null && settings !== null
      && (v8stage !== 'basics' || Boolean(basics?.name.trim())),
    paused: leaveTarget !== null || busy,
    save: async () => {
      const current = settingsRef.current
      if (!current) return false
      const currentBasics = basicsRef.current
      return saveSettings(v8stage === 'basics' && currentBasics ? basicsToDraft(current, currentBasics) : current, { silent: true })
    },
  })
  /** 手で「下書きを保存」したとき。保存できたら帯を「保存済み」にする。 */
  async function saveDraftByHand(next: ReminderDraftSettings) {
    if (await saveSettings(next)) autosave.markSaved()
  }

  async function sendTest() {
    const outcome = await testSend.send()
    if (outcome.kind === 'succeeded') {
      setDraft((current) => current ? { ...current, lastTestStatus: 'succeeded', lastTestedAt: outcome.testedAt } : current)
      setTestConfirm(false)
      return
    }
    if (outcome.kind === 'failed' && outcome.recipientFault) {
      void testRecipient.reload()
      setTestConfirm(false)
    }
    // 確定した失敗・結果不明は窓を開いたままにし、エラーは窓の中に出す。
  }

  async function publishDraft() {
    if (!validation?.valid || draft?.lastTestStatus !== 'succeeded') return
    setBusy(true)
    try {
      const response = await api.reminders.publishDraft(reminderId)
      if (!response.success) throw new Error(response.error)
      setPublished(response.data)
      go('done')
    } catch (saveFailure) {
      const fieldFailure = saveErrors.capture(saveFailure)

      { if (!fieldFailure)

      setError('リマインダを有効化できませんでした。時間をおいて、もう一度お試しください。') }
    } finally {
      setBusy(false)
    }
  }

  const subjectDraft = draft && draft.reminderId === reminderId ? draft : null
  const subjectSettings = subjectDraft ? settings : null

  if (loading) return <SaveErrorScope errors={saveErrors}><ListState kind="loading" title="下書きを読み込んでいます" /></SaveErrorScope>
  if (loadMissing) {
    return (
      <SaveErrorScope errors={saveErrors}><ListState kind="empty" title="このリマインダは見つかりません" description="削除されたか、別の記録です。一覧から選び直してください。" action={<Button href="/reminders">リマインダ一覧へ戻る</Button>} /></SaveErrorScope>
    )
  }
  if (!subjectDraft || !subjectSettings) {
    const failure = isForbiddenOrRateLimited(loadError) ? loadFailureCopy(loadError, 'リマインダ') : null
    return <SaveErrorScope errors={saveErrors}><ListState kind="error" title={failure?.title ?? '下書きを表示できませんでした'} description={failure?.description ?? (error || '下書きを読み込めませんでした。')} error={loadError ?? undefined} onRetry={() => void loadDraft()} /></SaveErrorScope>
  }

  const testIssue = testSend.phase.kind === 'failed' || testSend.phase.kind === 'unknown' ? testSend.phase.message : ''
  const sendBusy = testSend.phase.kind === 'sending'
  const sentName = testSend.phase.kind === 'succeeded' ? testSend.phase.recipientName : null
  const sentKind = testSend.phase.kind === 'succeeded' ? testSend.phase.recipientKind : null

  const currentKey: ReminderV8StepKey | 'done' = v8stage

  // 外枠に板 ID を持たせる（見本と突き合わせる目印）。
  const designNode = conflict ? 'k32cn'
    : v8stage === 'basics' ? 'VE1u5'
      : v8stage === 'target' ? 'YChR6'
        : v8stage === 'messages' ? (narrowBoard ? 'r1l0bT' : 'p5YuP')
          : v8stage === 'schedule' ? 'T0nis'
            : v8stage === 'confirm' ? 'ltAaq'
              : 'hjNpJ'

  /*
   * 競合の帯は頭の線の下・本文の上、板の幅いっぱい。型の「帯の段」
   * （notice・noticeSpacing='band'）に入れる。
   */
  const conflictBand = conflict ? (
    <SaveConflictBand title={<>ほかの人が先にリマインダ「{subjectSettings.name}」を保存しました</>} description="あなたが直した所はまだ保存されていません。このまま保存すると、相手の変更が消えます。" onCompare={() => void openCompare()} compareDisabled={compareBusy} onReload={() => void reloadAfterConflict()} />
  ) : null

  const frame: StageFrame = {
    boardId: designNode,
    title: 'リマインダを作る',
    identity: <BackToReminders />,
    steps: <ReminderV8Stepper current={currentKey} reminderId={reminderId} settings={subjectSettings} readOnly={!canManageRole(role)} />,
    help: (
      <>
        {v8stage === 'basics'
          ? 'いまは下書きとして作ります。最後の「確認」で有効にします。'
          : v8stage === 'done'
            ? `名前：${subjectSettings.name}`
            : `名前：${subjectSettings.name}・いまは下書きです`}
      </>
    ),
    notice: conflictBand,
    noticeSpacing: 'band',
    status: autosave.label ? <span aria-live="polite" data-autosave-status>{autosave.label}</span> : undefined,
  }

  const stageError = (error || (!testConfirm && testIssue && v8stage === 'confirm'))
    ? <Notice tone="danger">{error || testIssue}</Notice>
    : null

  return (
    <SaveErrorScope errors={saveErrors}><fieldset disabled={busy} className="contents"><StepContent step={["basics", "target", "messages", "schedule", "confirm", "done"].indexOf(v8stage)}>
      {v8stage === 'basics' ? (
        <BasicsStageV8
          frame={frame}
          notice={stageError}
          value={basics ?? basicsFromDraft(subjectSettings)}
          onChange={setBasics}
          onTemplate={(template) => setSettings(current => current ? {...current, steps: [{stableStepId: crypto.randomUUID(), messageType: 'text', ...template.step}]} : current)}
          stepCount={subjectSettings.steps.length}
          busy={busy}
          onSave={async (value) => {
            const saved = await saveSettings(basicsToDraft(subjectSettings, value))
            if (saved) go('target')
          }}
          onSaveDraft={async (value) => { await saveDraftByHand(basicsToDraft(subjectSettings, value)) }}
          onCancel={() => router.push('/reminders')}
        />
      ) : null}

      {v8stage === 'target' ? (
        <TargetStageV8
          frame={frame}
          notice={stageError}
          reminderId={reminderId}
          settings={subjectSettings}
          validation={validation}
          validationFailed={validationState === 'error'}
          onRetryValidation={retryValidation}
          onChange={setSettings}
          busy={busy}
          onNext={async () => {
            // 保存したら通知の中身（手順3）へ。配信予定は通知のあと。
            const saved = await saveSettings(subjectSettings)
            if (saved) go(null)
          }}
          onSaveDraft={async () => { await saveDraftByHand(subjectSettings) }}
          onCancel={() => router.push('/reminders')}
        />
      ) : null}

      {v8stage === 'messages' ? (
        <MessagesStageV8
          frame={frame}
          notice={stageError}
          narrow={narrowBoard}
          settings={subjectSettings}
          onChange={setSettings}
          busy={busy}
          onNext={async () => {
            const saved = await saveSettings(subjectSettings)
            if (saved) go('preview')
          }}
          onSaveDraft={async () => { await saveDraftByHand(subjectSettings) }}
          onCancel={() => router.push('/reminders')}
        />
      ) : null}

      {v8stage === 'schedule' ? (
        <ScheduleStageV8
          frame={frame}
          notice={stageError}
          reminderId={reminderId}
          settings={subjectSettings}
          preview={preview}
          previewFailed={previewState === 'error'}
          onRetryPreview={retryPreview}
          onNext={() => go('confirm')}
          onSaveDraft={async () => { await saveDraftByHand(subjectSettings) }}
          busy={busy}
          onCancel={() => router.push('/reminders')}
        />
      ) : null}

      {v8stage === 'confirm' ? (
        <ConfirmStageV8
          frame={frame}
          notice={stageError}
          reminderId={reminderId}
          draft={subjectDraft}
          settings={subjectSettings}
          validation={validation}
          validationFailed={validationState === 'error'}
          onRetryValidation={retryValidation}
          preview={preview}
          previewFailed={previewState === 'error'}
          recipientView={testRecipient.view}
          onRecipientRecheck={() => void testRecipient.reload()}
          sentName={sentName}
          sentKind={sentKind}
          sendBusy={sendBusy}
          onSend={() => { testSend.beginAttempt(); setTestConfirm(true) }}
          busy={busy}
          publishReady={Boolean(validation?.valid) && subjectDraft.lastTestStatus === 'succeeded'}
          onPublish={() => void publishDraft()}
          onSaveDraft={async () => { await saveDraftByHand(subjectSettings) }}
          onCancel={() => router.push('/reminders')}
        />
      ) : null}

      {v8stage === 'done' ? (
        <DoneStageV8 frame={frame} reminderId={reminderId} settings={subjectSettings} published={published} preview={preview} />
      ) : null}

      </StepContent><ConfirmDialog
        open={testConfirm && v8stage === 'confirm'}
        title="テスト送信しますか？"
        description={testSend.phase.kind === 'unknown' ? '前回の送信結果を確認できていません。再試行しても二重には送られません。' : testSendConfirmDescription(testRecipient.view, sentName, sentKind)}
        confirmLabel={testIssue ? 'もう一度送信' : 'テスト送信'}
        cancelLabel="閉じる"
        busy={sendBusy}
        error={testIssue}
        onConfirm={() => sendTest()}
        onCancel={() => setTestConfirm(false)}
      ><OperationTargetSummary accounts={[{ id: subjectDraft.settings.lineAccountId }]} /></ConfirmDialog>
      <UnsavedLeaveDialog open={leaveTarget !== null} subject="この手順への変更" onConfirm={confirmLeave} onCancel={cancelLeave} />
      <ConfirmDialog
        open={compareTarget !== null || compareError !== ''}
        title="最新の保存と比べる"
        description="あなたの下書きと、相手が保存した最新の内容の違いです。読み込むまでは画面は変わりません。"
        confirmLabel="最新を読み込んで続ける"
        busy={compareBusy}
        error={compareError || undefined}
        onConfirm={() => reloadAfterConflict()}
        onCancel={() => {
          setCompareTarget(null)
          setCompareError('')
        }}
      >
        {compareTarget && settings && (() => {
          const mine = basics ? basicsToDraft(settings, basics) : settings
          const lines = describeReminderDiff(mine, compareTarget)
          return lines.length === 0 ? (
            <p className={styles.fieldNote}>違いは見つかりませんでした。そのまま読み込めます。</p>
          ) : (
            <ul className={styles.diffList}>
              {lines.map((line, index) => (
                <li key={index}>{line}</li>
              ))}
            </ul>
          )
        })()}
      </ConfirmDialog>
    </fieldset></SaveErrorScope>
  )
}


/* ---------------- 手順2：対象者と止める条件 ---------------- */
export function TargetStageV8({
  frame,
  notice,
  reminderId,
  settings,
  validation,
  validationFailed = false,
  onRetryValidation,
  onChange,
  busy,
  onNext,
  onSaveDraft,
  onCancel,
}: {
  frame: StageFrame
  notice: ReactNode
  reminderId: string
  settings: ReminderDraftSettings
  validation: ReminderValidationResult | null
  validationFailed?: boolean
  onRetryValidation?: () => void
  onChange: (value: ReminderDraftSettings) => void
  busy: boolean
  onNext: () => void
  onSaveDraft: () => void
  onCancel: () => void
}) {
  const { selectedAccount } = useAccount()
  const stop = settings.stopConditions
  const condition = (settings.targetCondition ?? null) as SegmentCondition | null
  const mode = condition !== null ? 'condition' : 'all'

  // 保存前の条件で数え直した人数。条件が空なら保存済みの検査結果を出す。
  const [recount, setRecount] = useState<{ matched: number; excluded: number; sample: Array<{ id: string; displayName: string }> } | null>(null)
  const [counting, setCounting] = useState(false)
  const [recountError, setRecountError] = useState('')
  const [recountRetryToken, setRecountRetryToken] = useState(0)
  const [facesOpen, setFacesOpen] = useState(false)
  const [faces, setFaces] = useState<{ loading: boolean; error: string; sample: Array<{ id: string; displayName: string }>; matched: number | null } | null>(null)

  useEffect(() => {
    const pruned = pruneCondition(condition)
    if (!pruned) {
      setRecount(null)
      setRecountError('')
      setCounting(false)
      return
    }
    setCounting(true)
    setRecountError('')
    let active = true
    const timer = setTimeout(() => {
      void api.reminders.audience(reminderId, pruned).then((response) => {
        if (!active) return
        setCounting(false)
        if (response.success) setRecount(response.data)
        else setRecountError(response.error)
      }).catch(() => {
        if (!active) return
        setCounting(false)
        setRecountError('対象者を数え直せませんでした。')
      })
    }, 400)
    return () => {
      active = false
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reminderId, JSON.stringify(condition), recountRetryToken])

  const savedAudience = reminderAudienceCounts(validation)
  const matched = recount ? recount.matched : savedAudience.matched
  const total = recount ? recount.matched + recount.excluded : savedAudience.total
  const excluded = recount ? recount.excluded : savedAudience.excluded

  const facesLoadingRef = useRef(false)
  useEffect(() => () => {
    facesLoadingRef.current = false
  }, [reminderId])

  function openFaces() {
    if (recount) {
      facesLoadingRef.current = false
      setFaces({ loading: false, error: '', sample: recount.sample, matched: recount.matched })
    } else if (!facesLoadingRef.current) {
      facesLoadingRef.current = true
      setFaces({ loading: true, error: '', sample: [], matched: null })
      void api.reminders.audience(reminderId).then((response) => {
        if (response.success) setFaces({ loading: false, error: '', sample: response.data.sample, matched: response.data.matched })
        else setFaces({ loading: false, error: response.error, sample: [], matched: null })
      }).catch(() => setFaces({ loading: false, error: '対象者を確認できませんでした。', sample: [], matched: null }))
        .finally(() => { facesLoadingRef.current = false })
    }
    setFacesOpen(true)
  }

  const allLabel = settings.triggerType === 'friend_field' ? '基準日が入っている人すべて' : '予約がある人すべて'
  const allNote = settings.triggerType === 'friend_field' ? '情報欄に日付が入った人' : '予約日時が入った人'
  const audienceNote = settings.triggerType === 'friend_field' ? '基準日が入っている友だちに送ります' : '予約日時が入っている友だちに送ります'
  const firstStep = settings.steps[0] ?? null

  const stopRows: Array<{ key: string; title: string; note: string; label: string; checked: boolean; locked?: boolean; onChange?: (next: boolean) => void }> = [
    { key: 'cancel', title: '予約がキャンセルされた', note: 'すぐ止める', label: '予約がキャンセルされたら止める', checked: stop.bookingCancelled, onChange: (next) => onChange({ ...settings, stopConditions: { ...stop, bookingCancelled: next } }) },
    { key: 'done', title: '対応マークが「完了」になった', note: '残りを止める', label: '対応マークが完了になったら止める', checked: stop.supportMarkCompleted, onChange: (next) => onChange({ ...settings, stopConditions: { ...stop, supportMarkCompleted: next } }) },
    { key: 'days', title: '基準日を7日過ぎた', note: '自動で終わる', label: '基準日を7日過ぎたら自動で終わる', checked: stop.daysAfterTarget != null, onChange: (next) => onChange({ ...settings, stopConditions: { ...stop, daysAfterTarget: next ? 7 : null } }) },
    // ブロックは LINE 側で止まる。切っても届かないので、変えられない入口として出す。
    { key: 'block', title: '友だちがブロックした', note: 'すぐ止める（変えられません）', label: '友だちがブロックしたら止める', checked: true, locked: true },
  ]

  return (
    <CreatePage
      {...frame}
      preview={(
        <>
          <SummaryCardV8
            rows={[
              { key: '基準日', value: reminderTriggerLabel(settings.triggerType) },
              { key: '対象者', value: matched == null ? emptyValue('unknown') : `${formatNumber(matched)}人に送る予定` },
              { key: '通知', value: settings.steps.length > 0 ? `${settings.steps.length}通` : '手順3で作る' },
              { key: '状態', value: '下書き' },
            ]}
          />
          <PhoneV8
            accountName={selectedAccount?.name ?? 'LINE公式アカウント'}
            chip={firstStep ? '1通目の通知' : '通知は手順3で作ります'}
            empty={!firstStep}
            hasSampledBody={Boolean(firstStep?.messageContent.trim())}
            message={firstStep ? fillPreviewSample(firstStep.messageContent || '本文はまだありません').text : undefined}
          />
        </>
      )}
      footerActions={(
        <WizardFooterV8
          onCancel={onCancel}
          cancelDisabled={busy}
          onDraft={onSaveDraft}
          draftBusy={busy}
          nextLabel="次へ：通知の中身"
          nextIcon={<ArrowRight size={16} aria-hidden="true" />}
          onNext={onNext}
          nextDisabled={busy}
        />
      )} dirty={false}
    >
      {notice}
      <section className={styles.card} aria-labelledby="rm-target-title">
        <div className={styles.cardHead}>
          <h2 id="rm-target-title" className={styles.cardTitle}>対象者</h2>
          <p className={styles.cardNote}>{audienceNote}</p>
        </div>
        <div className={styles.choiceRow} role="radiogroup" aria-label="対象者">
          <SaveErrorField names={["reminder-v8-audience","mode"]}><ChoiceCardV8
            name="reminder-v8-audience"
            value="all"
            checked={mode === 'all'}
            onChange={() => onChange({ ...settings, targetCondition: null })}
            icon={<Users size={20} />}
            title={allLabel}
            note={allNote}
          /></SaveErrorField>
          <SaveErrorField names={["reminder-v8-audience","mode"]}><ChoiceCardV8
            name="reminder-v8-audience"
            value="condition"
            checked={mode === 'condition'}
            onChange={() => onChange({ ...settings, targetCondition: condition ?? { operator: 'AND', rules: [], groups: [] } })}
            icon={<Filter size={20} />}
            title="条件に合う人だけ"
            note="タグ・友だち情報などで絞る"
          /></SaveErrorField>
        </div>
        {mode === 'condition' ? (
          <ConditionBuilder value={condition} showCount={false} onChange={(next) => onChange({ ...settings, targetCondition: next })} />
        ) : null}
        <div className={styles.countBand} aria-label={`対象人数：当てはまる ${countLabel(total, '人')}・送る予定 ${countLabel(matched, '人')}・除く ${countLabel(excluded, '人')}`}>
          <div className={styles.countItem}>
            <span className={styles.countLabel}>当てはまる人</span>
            <strong className={styles.countValue}>{`${counting ? '…' : total == null ? emptyValue('unknown') : formatNumber(total)} 人`}</strong>
          </div>
          <div className={styles.countItem}>
            <span className={styles.countLabel}>送る予定（ブロックを除く）</span>
            <strong className={styles.countValue}>{`${counting ? '…' : matched == null ? emptyValue('unknown') : formatNumber(matched)} 人`}</strong>
          </div>
          <span className={styles.spacer} aria-hidden="true" />
          <Button type="button" variant="text" onClick={openFaces} disabled={counting}>
            <Users size={16} aria-hidden="true" />顔ぶれを見る
          </Button>
          <Button
            type="button"
            variant="text"
            disabled={counting}
            onClick={() => (mode === 'condition' ? setRecountRetryToken((value) => value + 1) : onRetryValidation?.())}
          >
            <RefreshCw size={16} aria-hidden="true" />数え直す
          </Button>
          <span className={styles.countNote} title="数え直しにかかる時間：数秒〜1分（1,000人ごとに約10秒）">数秒〜1分</span>
        </div>
        {recountError ? <p className={styles.fieldNote}>対象者を数え直せませんでした。保存済みの人数を表示しています。</p> : null}
        {validationFailed ? <p className={styles.fieldNote}>公開前チェックを実行できませんでした。人数は未取得のままです。</p> : null}
        <p className={styles.cardNote}>基準日が登録・変更されたときに、対象かどうかを自動で見直します。</p>
      </section>

      <section className={styles.card} aria-labelledby="rm-stop-title">
        <div className={styles.cardHead}>
          <h2 id="rm-stop-title" className={styles.cardTitle}>止める条件</h2>
          <p className={styles.cardNote}>当てはまったら、その人への残りの通知を止めます</p>
        </div>
        <div className={styles.stopList}>
          {stopRows.map((row, saveFieldIndex) => (
            <div key={row.key} className={styles.stopRow}>
              <span className={styles.stopText}>
                <span className={styles.stopTitle}>{row.title}</span>
                <span className={styles.stopNote}>{row.note}</span>
              </span>
              {row.locked
                ? <Toggle label={row.label} checked locked />
                : <SaveErrorField names={[`stopRows.${saveFieldIndex}.checked`,"checked","row.checked"]}><Toggle label={row.label} checked={row.checked} onChange={(next) => row.onChange?.(next)} /></SaveErrorField>}
            </div>
          ))}
        </div>
      </section>

      <section className={styles.card} aria-labelledby="rm-rule-title">
        <div className={styles.cardHead}>
          <h2 id="rm-rule-title" className={styles.cardTitle}>いつも守る決まり</h2>
          <p className={styles.ruleText}>
            ・基準日が空欄の人には始めない<br />
            ・過去の日時になった通知は送らない<br />
            ・同じ時刻に重なった通知は1通にまとめる
          </p>
        </div>
      </section>

      <Dialog
        open={facesOpen}
        title="対象者を確認"
        description={faces?.matched != null ? `送る予定 ${countLabel(faces.matched, '人')}の先頭${formatNumber(faces.sample.length)} 人です。` : undefined}
        onCancel={() => {
          facesLoadingRef.current = false
          setFacesOpen(false)
        }}
      >
        {!faces || faces.loading
          ? <p className={styles.fieldNote}>数えています…</p>
          : faces.error
            ? <Notice tone="danger" action={<Button variant="text" size="inline" onClick={openFaces} disabled={faces.loading} busy={faces.loading}>もう一度読み込む</Button>}>{faces.error}</Notice>
            : faces.sample.length === 0
              ? <p className={styles.fieldNote}>条件に当てはまる人がまだいません。条件をゆるめるとここに出ます。</p>
              : <ul className={styles.diffList}>{faces.sample.map((friend) => <li key={friend.id}>{friend.displayName}</li>)}</ul>}
      </Dialog>
    </CreatePage>
  )
}
