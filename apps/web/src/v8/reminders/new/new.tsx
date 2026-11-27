'use client'

import { describeApiFailure } from '@/components/shared/api-error-message'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation'
import Link from '@/components/shared/list-navigation'
import { ArrowRight, ChevronLeft } from 'lucide-react'
import { CreatePage } from '@/components/templates'
import type { FriendField, ReminderDraftSettings, ReminderDraftStep, ReminderDraftVersion } from '@line-crm/shared'
import { ApiError, api, type EventListItem } from '@/lib/api'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { useAccount } from '@/contexts/account-context'
import Button from '@/components/shared/button'
import DetailPanel from '@/components/shared/detail-panel'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import Notice from '@/components/shared/notice'
import { notifyToast } from '@/components/shared/toast'
import { SaveConflictBand, SaveConflictCompareDialog, saveConflictTitle, useSaveConflict } from '@/components/shared/save-conflict'
import { usePageTitle } from '@/components/shell/page-chrome'
import { canManageRole, useStaffRole } from '@/lib/staff-role'
import { useFeatureAccess } from '@/lib/use-feature-access'
import { useDraftAutosave } from '@/v8/autosave/public/use-draft-autosave/index'
import {
  EMPTY_BASICS,
  basicsBaseSummary,
  basicsFromDraft,
  basicsToDraft,
  reminderTemplatesV8,
  ReminderBasicsFormV8,
  type BasicsValue,
  type ReminderTemplateV8,
} from '@/v8/reminders/basics-form'
import { SummaryCardV8, WizardFooterV8, ReminderV8Stepper } from '../wizard-ui'
import styles from '../../../app/reminders/wizard-v8.module.css'
import { humanizeErrorText } from '@/components/shared/human-error-text'
import { describeReminderDiff } from '../edit/reminder-conflict-diff'
import { SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'

/**
 * ★V8 リマインダを作る・手順1「基本設定」（板 ）。
 * 保存したら手順2（対象者と止める条件）へ進む。保存せず進むことはない——
 * 手順2以降は下書きの id が要るため。
 */
export default function NewReminderV8() {
  const saveErrors = useSaveFormErrors()

  usePageTitle('リマインダを作成・基本設定')
  const router = useRouter()
  const canEdit = useFeatureAccess('reminders')
  const { selectedAccountId, loading: accountLoading } = useAccount()
  const [previewOpen, setPreviewOpen] = useState(false)
  const [value, setValue] = useState<BasicsValue>(EMPTY_BASICS)
  const [appliedTemplateId, setAppliedTemplateId] = useState<string | null>(null)
  const [pendingTemplate, setPendingTemplate] = useState<ReminderTemplateV8 | null>(null)
  const [pendingFieldMatch, setPendingFieldMatch] = useState<string | null>(null)
  const [dateFields, setDateFields] = useState<FriendField[]>([])
  const [events, setEvents] = useState<EventListItem[]>([])
  const [fieldsState, setFieldsState] = useState<'loading' | 'ready' | 'error'>('ready')
  const [eventsState, setEventsState] = useState<'loading' | 'ready' | 'error'>('ready')
  const [saving, setSaving] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle')
  const [error, setError] = useState('')
  const [fieldError, setFieldError] = useState<{ key: 'name' | 'triggerFieldId' | 'triggerEventId'; message: string } | null>(null)
  useEffect(() => { setFieldError(null) }, [value])
  useEffect(() => {
    if (!fieldError) return
    const label = fieldError.key === 'name' ? '#v8-reminder-name' : fieldError.key === 'triggerFieldId' ? '[aria-label="基準日に使う情報欄"]' : '[aria-label="基準日にするイベント"]'
    const field = document.querySelector<HTMLElement>(label)
    field?.focus()
    field?.scrollIntoView?.({ block: 'center' })
  }, [fieldError])
  // 一度保存したら下書きの id を持ち、続けて押したときは上書き保存にする。
  const [savedId, setSavedId] = useState<string | null>(null)
  /*
   * 最後に保存した版。続けて保存するときは、この版の上に基本設定を重ね、
   * 版IDと版時刻を送る。別の画面で先に保存されていたら 409 で止まり、
   * 「違いを比べる／最新を読み込んで続ける」を出す（動きの点検 16 番）。
   * 以前は保存の直前に最新を読み直して重ねていたので、相手の基本設定を黙って上書きしていた。
   */
  const [savedDraft, setSavedDraft] = useState<ReminderDraftVersion | null>(null)
  const accountScope = useRef({ accountId: selectedAccountId, generation: 0 })
  if (accountScope.current.accountId !== selectedAccountId) {
    accountScope.current = { accountId: selectedAccountId, generation: accountScope.current.generation + 1 }
  }
  const prevAccountRef = useRef(selectedAccountId)
  const saveConflict = useSaveConflict<ReminderDraftSettings>({
    fetchLatest: async () => {
      if (!savedId) return null
      const scope = accountScope.current
      const response = await api.reminders.getDraft(savedId)
      if (accountScope.current.accountId !== scope.accountId || accountScope.current.generation !== scope.generation) return null
      if (!response.success || response.data.reminderId !== savedId) return null
      return response.data.settings
    },
    // 「最新を読み込んで続ける」。入力中の基本設定は最新の版で置き換わる。
    reload: async () => {
      if (!savedId) return
      const scope = accountScope.current
      const sameAccount = () => accountScope.current.accountId === scope.accountId && accountScope.current.generation === scope.generation
      setError('')
      try {
        const response = await api.reminders.getDraft(savedId)
        if (!sameAccount()) return
        if (!response.success) throw new Error(response.error)
        setSavedDraft(response.data)
        setValue(basicsFromDraft(response.data.settings))
        setSaving('saved')
        saveConflict.clear()
        notifyToast('最新の内容を読み込みました')
      } catch (saveFailure) {
        if (!sameAccount()) return
        const fieldFailure = saveErrors.capture(saveFailure)

        { if (!fieldFailure) setError('最新の内容を読み込めませんでした。もう一度お試しください。') }
      }
    },
  })

  const dirty = Boolean(
    value.name.trim() ||
      value.description.trim() ||
      value.triggerFieldId ||
      value.triggerEventId ||
      value.repeatYearly ||
      appliedTemplateId,
  )
  /*
   * 最後に保存した形の指紋。入れた値がこれと同じ間は「保存済み」（一斉配信と同じ）。
   * 保存したあとも入力が残る画面なので、入力の有無だけで未保存と見なさない。
   */
  const fingerprint = JSON.stringify({ value, appliedTemplateId })
  const [savedFingerprint, setSavedFingerprint] = useState<string | null>(null)
  const unsaved = dirty && fingerprint !== savedFingerprint
  const { leaveTarget, confirmLeave, cancelLeave } = useUnsavedGuard({ dirty: unsaved, busy: saving === 'saving' })
  /* 自動保存と手の保存が重なって下書きが2件できないよう、送っている途中の保存を待つ。 */
  const saveInFlight = useRef<Promise<unknown> | null>(null)
  const savedIdRef = useRef(savedId)
  savedIdRef.current = savedId
  const savedDraftRef = useRef(savedDraft)
  savedDraftRef.current = savedDraft

  useEffect(() => {
    if (prevAccountRef.current === selectedAccountId) return
    prevAccountRef.current = selectedAccountId
    savedIdRef.current = null
    savedDraftRef.current = null
    setSavedId(null)
    setSavedDraft(null)
    setSavedFingerprint(null)
    setSaving('idle')
    setError('')
    saveConflict.clear()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAccountId])

  const appliedTemplate = reminderTemplatesV8.find((template) => template.id === appliedTemplateId) ?? null

  function requestTemplate(template: ReminderTemplateV8) {
    const hasInputsToReplace =
      (appliedTemplateId !== null && appliedTemplateId !== template.id) ||
      value.triggerFieldId !== '' ||
      value.triggerEventId !== '' ||
      value.repeatYearly
    if (hasInputsToReplace) setPendingTemplate(template)
    else applyTemplate(template)
  }

  function applyTemplate(template: ReminderTemplateV8) {
    setAppliedTemplateId(template.id)
    setValue((current) => ({
      ...current,
      triggerType: template.triggerType,
      repeatYearly: Boolean(template.repeatYearly),
      triggerFieldId: '',
      triggerEventId: '',
    }))
    setPendingFieldMatch(template.triggerType === 'friend_field' ? template.fieldNameMatch ?? null : null)
  }

  // 起点カードを手で選び直したら、ひな形の適用を外す。
  function handleChange(next: BasicsValue) {
    if (appliedTemplate && appliedTemplate.triggerType !== next.triggerType) setAppliedTemplateId(null)
    if (next.triggerType !== 'friend_field') setPendingFieldMatch(null)
    setValue(next)
  }

  const onFieldsReady = useCallback((fields: FriendField[], state: 'loading' | 'ready' | 'error') => {
    setDateFields(fields)
    setFieldsState(state)
  }, [])
  const onEventsReady = useCallback((items: EventListItem[], state: 'loading' | 'ready' | 'error') => {
    setEvents(items)
    setEventsState(state)
  }, [])

  // 今のアカウントの候補が確定するまで次へ進ませない。
  const candidatesPending =
    (value.triggerType === 'friend_field' && fieldsState !== 'ready') ||
    (value.triggerType === 'event' && eventsState !== 'ready')

  function validate(): string | null {
    if (accountLoading || !selectedAccountId) return 'LINEアカウントを選んでください'
    if (!value.name.trim()) return 'リマインダ名を入力してください'
    if (value.triggerType === 'friend_field' && !value.triggerFieldId) return '基準日に使う友だち情報欄を選んでください'
    if (value.triggerType === 'event' && !value.triggerEventId) return '基準日にするイベントを選んでください'
    return null
  }

  /**
   * 下書きを保存する。作成済みなら上書きする。成功したら下書きの id を返す。
   * silent は自動保存：保存中の印・赤い帯・トーストを出さない（失敗は保存の帯に出る）。
   * 競合（409）だけは自動でも帯を出す。
   */
  async function save({ silent = false }: { silent?: boolean } = {}): Promise<string | null> {
    if (!canEdit) return null
    const message = validate()
    if (message) {
      if (!silent) {
        if (accountLoading || !selectedAccountId) setError(message)
        else { setError(''); setFieldError({ key: !value.name.trim() ? 'name' : value.triggerType === 'friend_field' ? 'triggerFieldId' : 'triggerEventId', message }) }
      }
      return null
    }
    const requestAccountId = selectedAccountId!
    const requestGeneration = accountScope.current.generation
    const stillSameAccount = () => accountScope.current.accountId === requestAccountId && accountScope.current.generation === requestGeneration
    if (!silent) {
      setSaving('saving')
      setError('')
      saveConflict.clear()
    }
    while (saveInFlight.current) await saveInFlight.current.catch(() => undefined)
    if (!stillSameAccount()) return null
    const savedId = savedIdRef.current
    const savedDraft = savedDraftRef.current
    const sentFingerprint = fingerprint
    let settle: () => void = () => {}
    saveInFlight.current = new Promise<void>((resolve) => { settle = resolve })
    try {
      if (savedId) {
        // 最後に保存した版が手元に無いとき（取れなかったなど）だけ読み直す。
        const base = savedDraft ?? await (async () => {
          const current = await api.reminders.getDraft(savedId)
          if (!current.success) throw new Error(current.error)
          return current.data
        })()
        if (!stillSameAccount()) return null
        const res = await api.reminders.saveDraft(
          savedId,
          basicsToDraft(base.settings, value),
          { expectedVersionId: base.versionId, expectedUpdatedAt: base.updatedAt },
        )
        if (!stillSameAccount()) return null
        if (!res.success) throw new Error(res.error)
        savedDraftRef.current = res.data
        setSavedDraft(res.data)
        setSavedFingerprint(sentFingerprint)
        setSaving('saved')
        if (!silent) notifyToast('下書きを保存しました')
        return savedId
      }
      /*
       * REMINDER-07: ひな形なしでは空の1通目を作らない。下書きは通知0件を
       * 許すので、通知は手順3で足す。空本文のまま公開・送信はできない。
       */
      const firstStep: ReminderDraftStep | null = appliedTemplate
        ? {
            stableStepId: crypto.randomUUID(),
            offsetMinutes: appliedTemplate.step.offsetMinutes,
            offsetDays: appliedTemplate.step.offsetDays,
            sendAtTime: appliedTemplate.step.sendAtTime,
            messageType: 'text',
            messageContent: appliedTemplate.step.messageContent,
          }
        : null
      const settings: ReminderDraftSettings = {
        name: value.name.trim(),
        description: value.description.trim() || null,
        lineAccountId: requestAccountId,
        folderId: value.folderId || null,
        triggerType: value.triggerType,
        deliveryMode: 'time',
        triggerFieldId: value.triggerType === 'friend_field' ? value.triggerFieldId || null : null,
        triggerEventId: value.triggerType === 'event' ? value.triggerEventId || null : null,
        repeatYearly: value.triggerType === 'friend_field' ? value.repeatYearly : false,
        leapYearPolicy: value.leapYearPolicy,
        triggerOffsetMinutes: null,
        sendAtTime: appliedTemplate?.step.sendAtTime ?? null,
        targetTagId: null,
        targetCondition: null,
        stopConditions: { bookingCancelled: true, supportMarkCompleted: true, daysAfterTarget: 7, friendBlocked: true },
        steps: firstStep ? [firstStep] : [],
      }
      const res = await api.reminders.createDraft(settings)
      if (!stillSameAccount()) return null
      if (!res.success) throw new Error(res.error)
      savedIdRef.current = res.data.reminderId
      savedDraftRef.current = res.data
      setSavedId(res.data.reminderId)
      setSavedDraft(res.data)
      setSavedFingerprint(sentFingerprint)
      setSaving('saved')
      if (!silent) notifyToast('下書きを保存しました')
      return res.data.reminderId
    } catch (caught) {
      if (!stillSameAccount()) return null
      const fieldFailure = saveErrors.capture(caught)

      if (!silent) setSaving('failed')
      // 作った下書きが別の画面で先に保存されていた（409）。入力は捨てず、比べる・読み込むを選んでもらう。
      if (savedId && caught instanceof ApiError && caught.status === 409) {
        const data = caught.data as { updatedAt?: unknown } | null
        saveConflict.mark(typeof data?.updatedAt === 'string' ? data.updatedAt : '')
        return null
      }
      // 機械の文（API error: 500）は出さず、何が起きた・どうすればよいかを出す（動きの点検 7 番）。
      if (!silent) { if (!fieldFailure) setError(humanizeErrorText(describeApiFailure(caught, '下書きの保存'))) }
      return null
    } finally {
      saveInFlight.current = null
      settle()
    }
  }

  /*
   * 入力が止まって2秒で下書きへ静かに保存する（一斉配信と同じ）。最初の1回で
   * 下書きを作り、あとは同じ下書きへ上書きする。閲覧のみの人には動かさない。
   */
  const role = useStaffRole()
  const autosave = useDraftAutosave({
    fingerprint,
    dirty: unsaved,
    active: canManageRole(role),
    enabled: validate() === null && !candidatesPending && !saveConflict.conflict,
    paused: leaveTarget !== null || saving === 'saving' || pendingTemplate !== null,
    save: async () => (await save({ silent: true })) !== null,
  })

  async function next() {
    const id = await save()
    if (id) router.push(`/reminders/edit?id=${encodeURIComponent(id)}&stage=target`)
  }

  const preview = <>
          <SummaryCardV8
            rows={[
              { key: '基準日', value: basicsBaseSummary(value, dateFields, events) },
              { key: '対象者', value: '手順2で決める' },
              { key: '通知', value: appliedTemplate ? `1通（${appliedTemplate.timingLabel}）` : '手順3で作る' },
              { key: '状態', value: saving === 'saved' ? '下書き' : saving === 'failed' ? '保存失敗' : '下書き' },
            ]}
          />
          <p className={styles.sideHint}>
            LINEでの見え方は、届けるメッセージを決める手順から右に出ます。
          </p>
        </>

  if (!canEdit) return <CreatePage boardId="VE1u5" title="リマインダを作る" readOnly footerActions={<Button href="/reminders">一覧へ戻る</Button>} dirty={false}>{null}</CreatePage>

  return (
    <SaveErrorScope errors={saveErrors}><>
    <CreatePage
      boardId="VE1u5"
      title="リマインダを作る"
      help="いまは下書きとして作ります。最後の「確認」で有効にします。"
      identity={<Link href="/reminders" className={styles.backLink}><ChevronLeft size={16} aria-hidden="true" />リマインダへ</Link>}
      steps={<ReminderV8Stepper current="basics" reminderId={savedId} />}
      status={autosave.label ? <span aria-live="polite" data-autosave-status>{autosave.label}</span> : undefined}
      preview={preview}
      previewToggle={<Button onClick={() => setPreviewOpen(true)}>設定内容を見る</Button>}
      footerActions={
        <WizardFooterV8 embedded
        onCancel={() => router.push('/reminders')}
        cancelDisabled={saving === 'saving'}
        onDraft={() => void save().then((id) => { if (id) autosave.markSaved() })}
        draftBusy={saving === 'saving'}
        nextLabel="次へ：対象者と止める条件"
        nextIcon={<ArrowRight size={16} aria-hidden="true" />}
        onNext={() => void next()}
        nextDisabled={candidatesPending || saving === 'saving'}
        />
      }
    >
      {saveConflict.conflict ? (
        <SaveConflictBand
          designNode="k32cn"
          title={saveConflictTitle(saveConflict.conflict.updatedAt, 'リマインダ', value.name)}
          compareBusy={saveConflict.compareBusy}
          onCompare={() => void saveConflict.compare()}
          onReload={() => void saveConflict.reloadLatest()}
        />
      ) : error ? <Notice tone="danger" message={error} /> : null}

          <ReminderBasicsFormV8
            fieldError={fieldError}
            value={value}
            onChange={handleChange}
            appliedTemplateId={appliedTemplateId}
            onRequestTemplate={requestTemplate}
            pendingFieldMatch={pendingFieldMatch}
            onFieldMatchHandled={() => setPendingFieldMatch(null)}
            onFieldsReady={onFieldsReady}
            onEventsReady={onEventsReady}
          />



      <ConfirmDialog
        open={pendingTemplate !== null}
        title="ひな形の内容で上書きしますか？"
        description="いま選んでいる基準日や繰り返しの設定は、ひな形の内容に置き換わります。"
        confirmLabel="このひな形を使う"
        onConfirm={() => {
          if (pendingTemplate) applyTemplate(pendingTemplate)
          setPendingTemplate(null)
        }}
        onCancel={() => setPendingTemplate(null)}
      />
      <UnsavedLeaveDialog open={leaveTarget !== null} subject="基本設定への変更" onConfirm={confirmLeave} onCancel={cancelLeave} />
      <SaveConflictCompareDialog
        open={saveConflict.compareOpen}
        busy={saveConflict.compareBusy}
        error={saveConflict.compareError}
        lines={saveConflict.latest && savedDraft
          ? describeReminderDiff(basicsToDraft(savedDraft.settings, value), saveConflict.latest).map((text) => ({ text }))
          : null}
        onReload={() => void saveConflict.reloadLatest()}
        onCancel={saveConflict.closeCompare}
      />
    </CreatePage>
    <DetailPanel open={previewOpen} title="設定内容" onClose={() => setPreviewOpen(false)}>{preview}</DetailPanel>
    </></SaveErrorScope>
  )
}
