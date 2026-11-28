'use client'
import Card, { CardHeader } from '@/components/shared/card'

import { Suspense, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation'
import { Globe, User, Users, X } from 'lucide-react'
import { ApiError, eventsApi, type EventDetail, type EventQuestion } from '@/lib/api'
import { useAccount } from '@/contexts/account-context'
import { usePageTitle } from '@/components/shell/page-chrome'
import { useStaffRole, canManageRole } from '@/lib/staff-role'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import { CreatePage } from '@/components/templates'
import Button from '@/components/shared/button'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import RadioCard, { RadioCardGroup } from '@/components/shared/radio-card'
import Notice from '@/components/shared/notice'
import Select from '@/components/shared/select'
import { TextField } from '@/components/shared/text-field'
import DateField from '@/components/shared/date-field'
import { TimeField } from '@/components/shared/date-time-field'
import ApplicationPreview from './application-preview'
import { EVENT_DEFAULT_DRAFT, ENTRY_CUTOFF_OPTIONS, NONE, jstToUtcIso } from './shared'
import { jstDateOffset } from '@/lib/jst-datetime'
import styles from './create.module.css'
import { Field, OptionalBadge, RequiredBadge } from '@/components/shared/form-controls'
import { permissionDeniedMessage, describeApiFailure } from '@/components/shared/api-error-message'
import NumberInput from '@/components/shared/number-field'
import { saveInitialSlot, type InitialSlotCache } from './save-initial-slot'
import SaveFeedback, { useSaveFeedback } from '@/components/shared/save-feedback'
import { notifyToast } from '@/components/shared/toast'
import { requiredText, type FormRequirement } from '@/lib/form-requirement'

const eventRequirements = {
  name: requiredText('イベント名を入れてください'),
  date: requiredText('日付を選んでください'),
  start: requiredText('開始の時刻を入れてください'),
  end: requiredText('終わりの時刻を入れてください'),
  capacity: { required: true, check: value => Number.isInteger(Number(value)) && Number(value) >= 1 ? null : '定員は1以上の数で入れてください' } satisfies FormRequirement,
}
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import { EVENT_NAME_MAX_LENGTH, EVENT_DESCRIPTION_MAX_LENGTH, resolveEventMultiAccountIds } from '@/components/events/event-draft-shared'
import { SettingsFormRow } from '@/components/shared/settings-form-card'
import { ToggleField } from '@/components/shared/toggle'

/*
 * ★V8 イベント予約「イベントを作る」（Pencil ）。
 *
 * 型（CreatePage）に、中身・公開対象・最初の予約枠・申し込みのきまり・聞くこと・
 * 申し込んだ人にすること のカードと、右の列（お客さまの申込ページ・保存すると起きること）、
 * 下の帯（キャンセル・下書きを保存・公開する）をはめる。
 * 今の作り（3段階のウィザード）と同じ口を使う：イベントを作る → 最初の枠を作る。
 * 公開は作るときに is_published=1 で送る。絵と今の作りの違いは BEHAVIOR.md。
 */

const PER_FRIEND_OPTIONS = [
  { value: NONE, label: '制限なし' },
  { value: '1', label: '1 回まで' },
  { value: '2', label: '2 回まで' },
  { value: '3', label: '3 回まで' },
]
/* 承認：しない／する（期限つき）。期限は今の作りと同じ 2・24・72 時間。 */
const APPROVAL_OPTIONS = [
  { value: 'off', label: '承認しないで確定' },
  { value: '2', label: '承認してから確定（期限 2 時間）' },
  { value: '24', label: '承認してから確定（期限 24 時間）' },
  { value: '72', label: '承認してから確定（期限 72 時間）' },
]
const WAITLIST_OPTIONS = [
  { value: '0', label: '締め切る（キャンセル待ちを受けない）' },
  { value: '1', label: 'キャンセル待ちを受ける（空いたら順番に案内）' },
]

function timeMinutes(value: string) {
  const [hour, minute] = value.split(':').map(Number)
  return hour * 60 + minute
}

function isPastStart(date: string, time: string): boolean {
  if (!date || !time) return false
  try { return Date.parse(jstToUtcIso(date, time)) <= Date.now() } catch { return false }
}

type QuestionDraft = { label: string; required: boolean }

/* useSearchParams は Suspense の中でしか使えない（静的書き出しのため）。 */
export default function EventsCreateV8() {
  return (
    <Suspense fallback={null}>
      <EventsCreateV8Inner />
    </Suspense>
  )
}

function EventsCreateV8Inner() {
  const saveErrors = useSaveFormErrors()
  const feedback = useSaveFeedback()
  const retryPublish = useRef(false)
  usePageTitle('イベントを作る')
  const router = useRouter()
  const searchParams = useSearchParams()
  const { selectedAccountId } = useAccount()
  const role = useStaffRole()
  const canEdit = canManageRole(role)

  /*
   * 今の作りは ①を保存すると /events/new?id=…&step=2 で続きを開く。
   * V8 は1枚で作り終えるので、作り済みのイベントは編集の画面で続ける。
   */
  const continuingId = searchParams.get('id')
  useEffect(() => {
    if (continuingId) router.replace(`/events/edit?id=${encodeURIComponent(continuingId)}`)
  }, [continuingId, router])

  const [draft, setDraft] = useState<EventDetail>(EVENT_DEFAULT_DRAFT)
  const [date, setDate] = useState(() => jstDateOffset(1))
  const [startTime, setStartTime] = useState('14:00')
  const [endTime, setEndTime] = useState('15:30')
  const [capacity, setCapacity] = useState('')
  const [questions, setQuestions] = useState<QuestionDraft[]>([])
  const [adding, setAdding] = useState<QuestionDraft | null>(null)
  const [saving, setSaving] = useState(false)
  const [savingPublished, setSavingPublished] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const focusTarget = useRef<string | null>(null)
  useEffect(() => {
    const id = focusTarget.current
    if (!id) return
    focusTarget.current = null
    const field = document.getElementById(id)
    field?.focus()
    field?.scrollIntoView({ block: 'center' })
  }, [fieldErrors])
  const clearFieldError = (id: string) => setFieldErrors((current) => {
    if (!current[id]) return current
    const next = { ...current }
    delete next[id]
    return next
  })
  const completedSlotRef = useRef<{ accountId: string; eventId: string; cache: InitialSlotCache } | null>(null)
  const createdRef = useRef<{ accountId: string; event: EventDetail; payload: string } | null>(null)
  const accountScope = useRef({ id: selectedAccountId, generation: 0 })
  if (accountScope.current.id !== selectedAccountId) accountScope.current = { id: selectedAccountId, generation: accountScope.current.generation + 1 }
  const canEditRef = useRef(canEdit)
  canEditRef.current = canEdit
  const [publishTarget, setPublishTarget] = useState<{ accountIds: string[]; generation: number } | null>(null)
  const [pastConfirmation, setPastConfirmation] = useState<{ publish: boolean; snapshot: string; accountId: string } | null>(null)
  const targetIds = selectedAccountId ? resolveEventMultiAccountIds(draft, selectedAccountId) ?? [selectedAccountId] : []
  const targetIdsRef = useRef(targetIds)
  targetIdsRef.current = targetIds
  useEffect(() => { setPublishTarget(null); setPastConfirmation(null) }, [selectedAccountId])
  const [unknownCreateAccounts, setUnknownCreateAccounts] = useState<Set<string>>(new Set())
  const unknownCreateRef = useRef(new Set<string>())
  const createUnknown = Boolean(selectedAccountId && unknownCreateAccounts.has(selectedAccountId))

  const update = <K extends keyof EventDetail>(key: K, value: EventDetail[K]) => setDraft((current) => ({ ...current, [key]: value }))

  const snapshot = JSON.stringify({ draft, date, startTime, endTime, capacity, questions })
  const initialRef = useRef(snapshot)
  const dirty = snapshot !== initialRef.current
  const { leaveTarget, confirmLeave, cancelLeave } = useUnsavedGuard({ dirty, busy: saving })

  function validateInput() {
    if (saving || !canEdit) return false
    if (!selectedAccountId) {
      setError('上のバーでLINE公式アカウントを選んでください')
      return false
    }
    const errors: Record<string, string> = {}
    const nameError = eventRequirements.name.check(draft.name)
    if (nameError) errors['ev-new-name'] = nameError
    if ((draft.description ?? '').length > EVENT_DESCRIPTION_MAX_LENGTH) errors['ev-new-desc'] = '詳細は20000字以内で入力してください'
    if (draft.venue_url) {
      try {
        const url = new URL(draft.venue_url)
        if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('protocol')
      } catch (saveFailure) {
        saveErrors.capture(saveFailure)
        errors['ev-new-url'] = 'http または https で始まる URL を入れてください'
      }
    }
    const dateError = eventRequirements.date.check(date)
    const startError = eventRequirements.start.check(startTime)
    const endError = eventRequirements.end.check(endTime)
    if (dateError) errors['ev-new-date'] = dateError
    if (startError) errors['ev-new-start'] = startError
    if (endError) errors['ev-new-end'] = endError
    else if (startTime && endTime <= startTime) errors['ev-new-end'] = '終了は開始より後にしてください'
    else if (startTime && (timeMinutes(endTime) - timeMinutes(startTime)) < 15) errors['ev-new-end'] = '開催時間は15分以上で入力してください'
    const capacityError = eventRequirements.capacity.check(capacity)
    if (capacityError) errors['ev-new-cap'] = capacityError
    setError(null)
    focusTarget.current = Object.keys(errors)[0] ?? null
    setFieldErrors(errors)
    return !focusTarget.current
  }

  async function save(publish: boolean, acceptedPastSnapshot?: string) {
    if (!selectedAccountId || unknownCreateRef.current.has(selectedAccountId) || !validateInput()) return
    if (isPastStart(date, startTime) && acceptedPastSnapshot !== snapshot) {
      setPublishTarget(null)
      setPastConfirmation({ publish, snapshot, accountId: selectedAccountId })
      return false
    }
    if (!feedback.begin('イベント')) return
    retryPublish.current = publish
    setSavingPublished(publish)
    setSaving(true)
    setError(null)
    let saved = createdRef.current?.accountId === selectedAccountId ? createdRef.current.event : null
    let eventId = saved?.id ?? null
    let stage: 'event' | 'slots' = 'event'
    let creating = false
    try {
      const qs: EventQuestion[] = questions.map((question, index) => ({
        id: `q${index + 1}`, label: question.label, type: 'text', required: question.required, options: null,
      }))
      const payload: Partial<EventDetail> = {
        ...draft,
        name: draft.name.trim(),
        is_published: publish || saved?.is_published === 1 ? 1 : 0,
        questions: qs,
        account_ids: resolveEventMultiAccountIds(draft, selectedAccountId),
      }
      delete payload.id
      delete payload.version
      if (!eventId) {
        creating = true
        const created = await eventsApi.createEvent(selectedAccountId, payload)
        if (!created?.id) throw new Error('イベントの作成結果を確認できませんでした。')
        eventId = created.id
        saved = created
      } else if (createdRef.current?.payload !== JSON.stringify(payload)) {
        saved = await eventsApi.updateEvent(selectedAccountId, eventId, payload, saved!.version ?? 1)
      }
      createdRef.current = { accountId: selectedAccountId, event: saved!, payload: JSON.stringify(payload) }
      stage = 'slots'
      const startsAt = jstToUtcIso(date, startTime)
      const endsAt = jstToUtcIso(date, endTime)
      const completedSlot = completedSlotRef.current
      await saveInitialSlot({ api: eventsApi, accountId: selectedAccountId, eventId,
        input: { starts_at: startsAt, ends_at: endsAt, capacity: Number(capacity), client_key: `first-slot:${eventId}` },
        cached: completedSlot?.accountId === selectedAccountId && completedSlot.eventId === eventId ? completedSlot.cache : null,
        capture: cache => { completedSlotRef.current = { accountId: selectedAccountId, eventId: eventId!, cache } },
      })
      feedback.success('イベントと最初の予約枠')
      initialRef.current = snapshot
      setPublishTarget(null)
      if (!publish && saved?.is_published === 0) notifyToast('下書きを保存しました', { tone: 'success' })
      router.push(`/events?highlight=${encodeURIComponent(eventId)}`)
      return true
    } catch (cause) {
      const fieldFailure = saveErrors.capture(cause);


      const unknownCreate = creating && !eventId && (!(cause instanceof ApiError) || cause.status >= 500)
      if (unknownCreate) { unknownCreateRef.current.add(selectedAccountId); setUnknownCreateAccounts(new Set(unknownCreateRef.current)) }
      const reason = unknownCreate
        ? 'イベントの作成結果を確認できませんでした。一覧で作成済みか確認してください。確認できるまで、この画面からは作り直せません。'
        : cause instanceof ApiError && cause.status === 403 ? permissionDeniedMessage('store') : describeApiFailure(cause, '保存')
      { if (!fieldFailure)
      setError(eventId
        ? `イベントは${saved?.is_published === 1 ? '公開済みですが' : '下書きで作りましたが'}、${stage === 'slots' ? '最初の予約枠を作れませんでした' : '変更を保存できませんでした'}。もう一度押すと続きから作ります。（${reason}）`
        : reason) }
      const slotKnown = completedSlotRef.current?.accountId === selectedAccountId && completedSlotRef.current.eventId === eventId
      feedback.failure(reason, eventId ? [`イベント本体（${saved?.is_published === 1 ? '公開済み' : '下書き'}）`, ...(slotKnown ? ['最初の予約枠（作成済み）'] : [])] : [],
        stage === 'slots' ? [slotKnown ? '予約枠の確認・変更' : '最初の予約枠'] : eventId ? ['イベントの変更', ...(slotKnown ? [] : ['最初の予約枠'])] : ['イベントの保存'])
      setSaving(false)
      return false
    }
  }

  const capNumber = Number(capacity)
  const previewWhen = `${formatDay(date)} ${startTime}〜${draft.venue_name ? `・${draft.venue_name}` : ''}`

  const side = (
    <div className={styles.side}>
      <Card variant="aside" aria-labelledby="ev-new-preview">
        <h2 className={styles.sideTitle} id="ev-new-preview">お客さまの申込ページ</h2>
        <Card variant="aside" surface="muted" aria-label="申込ページの見え方">
          <p className={styles.phoneName}>{draft.name.trim() || 'イベント名'}</p>
          <p className={styles.phoneWhen}>{previewWhen}</p>
          <p className={styles.phoneLeft}>{Number.isInteger(capNumber) && capNumber > 0 ? `残り ${capNumber} 席` : '残り — 席'}</p>
          <span className={styles.phoneButton} aria-hidden="true">申し込む</span>
        </Card>
        {selectedAccountId ? (
          <ApplicationPreview
            accountId={selectedAccountId}
            draft={{ ...draft, questions: questions.map((question, index) => ({ id: `q${index + 1}`, label: question.label, type: 'text', required: question.required, options: null })) }}
            date={date}
            startTime={startTime}
            endTime={endTime}
            capacity={capacity}
          />
        ) : null}
      </Card>
      <Card variant="aside" aria-labelledby="ev-new-after">
        <h2 className={styles.sideTitle} id="ev-new-after">保存すると起きること</h2>
        <p className={styles.careText}>
          ・下書きとして保存され、お客さまには見えません<br />
          ・「公開する」と申込ページの URL が使えるようになります<br />
          ・定員に達すると自動で満席になります
        </p>
      </Card>
    </div>
  )

  if (!canEdit) {
    return (
      <SaveErrorScope errors={saveErrors}><CreatePage
        boardId="d4adD4"
        title="イベントを作る"
        help="中身・回と定員・申し込みのきまりを決めます。下書きのあいだは、お客さまには見えません。"
        footerActions={<></>} dirty={false}
      >
        <Notice tone="info">{permissionDeniedMessage('store')}</Notice>
      </CreatePage></SaveErrorScope>
    )
  }

  return (
    <SaveErrorScope errors={saveErrors}><CreatePage
      boardId="d4adD4"
      title="イベントを作る"
      help="中身・回と定員・申し込みのきまりを決めます。下書きのあいだは、お客さまには見えません。"
      previewLabel="申込ページを見る"
      previewTitle="申込ページ"
      preview={side}
      status={saving ? '保存しています…' : undefined}
      footerActions={(
        <>
          <Button href="/events">キャンセル</Button>
          <Button disabled={saving || !selectedAccountId || createUnknown} busy={saving && !savingPublished} onClick={() => void save(false)}>下書きを保存</Button>
          <Button variant="primary" disabled={saving || !selectedAccountId || createUnknown} busy={saving && savingPublished} onClick={() => { if (validateInput() && selectedAccountId) setPublishTarget({ accountIds: targetIds, generation: accountScope.current.generation }) }}><Globe size={16} aria-hidden="true" />公開する</Button>
        </>
      )} dirty={false}
    >
      {feedback.state.kind === 'idle' && error ? <Notice tone="danger">{error}</Notice> : null}
      <SaveFeedback state={feedback.state} retryDisabled={createUnknown} onRetry={async () => { await save(retryPublish.current) }} />
      {!selectedAccountId ? <Notice tone="info">上のバーでLINE公式アカウントを選んでください</Notice> : null}

      <Card variant="form" gap="normal" aria-labelledby="ev-new-body">
        <CardHeader size="stacked" titleId="ev-new-body" title="イベントの中身" />
        <div className={styles.field}><Field requirement={eventRequirements.name} label="イベント名" htmlFor="ev-new-name"><SaveErrorField names={["name","draft.name"]}><TextField
            id="ev-new-name"
            value={draft.name}
            maxLength={EVENT_NAME_MAX_LENGTH}
            placeholder="例：秋のしつけ教室（第1回）"
            aria-invalid={Boolean(fieldErrors['ev-new-name']) || undefined}
            aria-describedby={fieldErrors['ev-new-name'] ? 'ev-new-name-error' : undefined}
            required
            onBlur={() => {
              const error = !draft.name.trim() ? 'イベント名を入れてください' : draft.name.length > EVENT_NAME_MAX_LENGTH ? 'イベント名は255字以内で入力してください' : null
              if (error) setFieldErrors((current) => ({ ...current, 'ev-new-name': error }))
              else clearFieldError('ev-new-name')
            }}
            onChange={(event) => {
              update('name', event.target.value)
              clearFieldError('ev-new-name')
            }}
          /></SaveErrorField>
{fieldErrors['ev-new-name'] ? <p id="ev-new-name-error" className={styles.fieldError} role="alert">{fieldErrors['ev-new-name']}</p> : null}</Field></div>
        <div className={styles.field}><Field label="説明" htmlFor="ev-new-desc"><SaveErrorField names={["description","draft.description"]}><TextField
            id="ev-new-desc"
            value={draft.description ?? ''}
            maxLength={EVENT_DESCRIPTION_MAX_LENGTH}
            placeholder="開催趣旨・注意事項・持ち物など"
            onChange={(event) => update('description', event.target.value || null)}
          /></SaveErrorField></Field></div>
        <SettingsFormRow layout="columns">
          <div className={styles.field}><Field label="場所" htmlFor="ev-new-venue"><SaveErrorField names={["venue_name","draft.venue_name"]}><TextField
              id="ev-new-venue"
              value={draft.venue_name ?? ''}
              placeholder="例：渋谷ベース 3F"
              onChange={(event) => update('venue_name', event.target.value || null)}
            /></SaveErrorField></Field></div>
          <div className={styles.field}>
            <Field label="オンラインの URL" htmlFor="ev-new-url"><SaveErrorField names={["venue_url","draft.venue_url"]}><TextField
              id="ev-new-url"
              type="url"
              value={draft.venue_url ?? ''}
              placeholder="https://…（確定した人だけに見せます）"
              aria-invalid={Boolean(fieldErrors['ev-new-url']) || undefined}
              aria-describedby={fieldErrors['ev-new-url'] ? 'ev-new-url-error' : undefined}
              onChange={(event) => { update('venue_url', event.target.value || null); clearFieldError('ev-new-url') }}
            /></SaveErrorField></Field>
            {fieldErrors['ev-new-url'] ? <p id="ev-new-url-error" className={styles.fieldError} role="alert">{fieldErrors['ev-new-url']}</p> : null}
          </div>
        </SettingsFormRow>
      </Card>

      <Card variant="form" gap="normal" aria-labelledby="ev-new-target">
        <CardHeader size="stacked" titleId="ev-new-target" title="公開対象" />
        <SaveErrorField names={["ev-new-target","target_type","draft.target_type"]}><RadioCardGroup legend="公開対象" className={styles.cardRow}>
          <RadioCard
            name="ev-new-target"
            value="single"
            checked={(draft.target_type ?? 'single') === 'single'}
            onChange={() => update('target_type', 'single')}
            icon={<User size={16} aria-hidden="true" />}
            title="1つの LINE アカウント"
            note="このアカウントの友だちに出します"
          />
          <RadioCard
            name="ev-new-target"
            value="multi-account-dedup"
            checked={draft.target_type === 'multi-account-dedup'}
            onChange={() => update('target_type', 'multi-account-dedup')}
            icon={<Users size={16} aria-hidden="true" />}
            title="複数アカウント横断"
            note="同じ人に重ねて出しません"
          />
        </RadioCardGroup></SaveErrorField>
      </Card>

      <Card variant="form" gap="normal" aria-labelledby="ev-new-slot">
        <CardHeader size="stacked" titleId="ev-new-slot" title="最初の予約枠" meta="あとから回を足せます（中身を見る → 回を足す）" />
        {isPastStart(date, startTime) && !fieldErrors['ev-new-date'] ? <Notice tone="warn">開始日時が過去です。日時を確認してください。</Notice> : null}
        <SettingsFormRow layout="columns">
          <div className={styles.field}><Field requirement={eventRequirements.date} label="日付" htmlFor="ev-new-date"><SaveErrorField names={["date"]}><DateField id="ev-new-date" value={date} invalid={Boolean(fieldErrors['ev-new-date'])} aria-describedby={fieldErrors['ev-new-date'] ? 'ev-new-date-error' : undefined} onChange={(value) => { setDate(value); clearFieldError('ev-new-date') }} /></SaveErrorField>
{fieldErrors['ev-new-date'] ? <p id="ev-new-date-error" className={styles.fieldError} role="alert">{fieldErrors['ev-new-date']}</p> : null}</Field></div>
          <Field requirement={eventRequirements.start} label={<span id="ev-new-time-label">開始</span>} htmlFor="ev-new-start" error={fieldErrors['ev-new-start'] || fieldErrors['ev-new-end']}>

            <div className={styles.timeRow} role="group" aria-labelledby="ev-new-time-label">
              <SaveErrorField names={["startTime","start_time"]}><TimeField id="ev-new-start" aria-label="開始の時刻" invalid={Boolean(fieldErrors['ev-new-start'])} aria-describedby={fieldErrors['ev-new-start'] ? 'ev-new-time-error' : undefined} value={startTime} onChange={(value) => { setStartTime(value); clearFieldError('ev-new-start'); clearFieldError('ev-new-end') }} /></SaveErrorField>
              <span className={styles.timeSep} aria-hidden="true">〜</span>
              <SaveErrorField names={["endTime","end_time"]}><TimeField id="ev-new-end" aria-label="終わりの時刻" invalid={Boolean(fieldErrors['ev-new-end'])} value={endTime} onChange={(value) => { setEndTime(value); clearFieldError('ev-new-end') }} /></SaveErrorField>
            </div>
            {fieldErrors['ev-new-start'] || fieldErrors['ev-new-end'] ? <p id="ev-new-time-error" className={styles.fieldError} role="alert">{fieldErrors['ev-new-start'] || fieldErrors['ev-new-end']}</p> : null}
          </Field>
        </SettingsFormRow>
        <SettingsFormRow layout="columns">
          <div className={styles.field}><Field requirement={eventRequirements.capacity} label="定員" htmlFor="ev-new-cap"><SaveErrorField names={["capacity"]}><NumberInput numericText
              id="ev-new-cap"
              inputMode="numeric"
              value={capacity}
              placeholder="20 人"
              aria-invalid={Boolean(fieldErrors['ev-new-cap']) || undefined}
              aria-describedby={fieldErrors['ev-new-cap'] ? 'ev-new-cap-error' : undefined}
              onChange={(event) => { setCapacity(event.target.value.replace(/[^0-9]/g, '')); clearFieldError('ev-new-cap') }}
            /></SaveErrorField>
{fieldErrors['ev-new-cap'] ? <p id="ev-new-cap-error" className={styles.fieldError} role="alert">{fieldErrors['ev-new-cap']}</p> : null}</Field></div>
          <Field label="1人あたりの予約回数" htmlFor="ev-new-per-friend">

            <SaveErrorField names={["NONE","max_bookings_per_friend","draft.max_bookings_per_friend","_n_o_n_e"]}><Select
              aria-label="1人あたりの予約回数"
              size="full"
              value={draft.max_bookings_per_friend == null ? NONE : String(draft.max_bookings_per_friend)}
              onChange={(value) => update('max_bookings_per_friend', value === NONE ? null : Number(value))}
              options={PER_FRIEND_OPTIONS}
            /></SaveErrorField>
          </Field>
        </SettingsFormRow>
      </Card>

      <Card variant="form" gap="normal" aria-labelledby="ev-new-rules">
        <CardHeader size="stacked" titleId="ev-new-rules" title="申し込みのきまり" />
        <SettingsFormRow layout="columns">
          <Field label="申し込みの上限" htmlFor="ev-new-cutoff">

            <SaveErrorField names={["NONE","entry_cutoff_hours_before","draft.entry_cutoff_hours_before","_n_o_n_e"]}><Select
              aria-label="申し込みの上限"
              size="full"
              value={draft.entry_cutoff_hours_before == null ? NONE : String(draft.entry_cutoff_hours_before)}
              onChange={(value) => update('entry_cutoff_hours_before', value === NONE ? null : Number(value))}
              options={ENTRY_CUTOFF_OPTIONS}
            /></SaveErrorField>
          </Field>
          <Field label="承認" htmlFor="ev-new-approval">

            <SaveErrorField names={["approval_deadline_hours","draft.approval_deadline_hours"]}><Select
              aria-label="承認"
              size="full"
              value={draft.requires_approval ? String(draft.approval_deadline_hours) : 'off'}
              onChange={(value) => {
                if (value === 'off') {
                  update('requires_approval', 0)
                } else {
                  setDraft((current) => ({ ...current, requires_approval: 1, approval_deadline_hours: Number(value) }))
                }
              }}
              options={APPROVAL_OPTIONS}
            /></SaveErrorField>
          </Field>
        </SettingsFormRow>
        <SettingsFormRow layout="columns">
          <Field label="満席になったとき" htmlFor="ev-new-waitlist">

            <SaveErrorField names={["waitlist_enabled","draft.waitlist_enabled"]}><Select
              aria-label="満席になったとき"
              size="full"
              value={String(draft.waitlist_enabled ?? 0)}
              onChange={(value) => update('waitlist_enabled', Number(value))}
              options={WAITLIST_OPTIONS}
            /></SaveErrorField>
          </Field>
          <span className={styles.field} aria-hidden="true" />
        </SettingsFormRow>
      </Card>

      <Card variant="form" gap="normal" aria-labelledby="ev-new-questions">
        <CardHeader size="stacked" titleId="ev-new-questions" title="申し込みのときに聞くこと" />
        {questions.length > 0 ? (
          <ul className={styles.questionList}>
            {questions.map((question, index) => (
              <li key={`${question.label}-${index}`} className={styles.questionRow}>
                <span className={styles.questionLabel}>{question.label}</span>
                {question.required ? <RequiredBadge /> : <OptionalBadge />}
                <Button
                  variant="text"
                  aria-label={`質問「${question.label}」を外す`}
                  onClick={() => setQuestions((current) => current.filter((_, at) => at !== index))}
                >
                  <X size={16} aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className={styles.questionEmpty}>まだ聞くことはありません。ペットの名前など、申し込みのたびに聞きたいことを足せます。</p>
        )}
        {adding ? (
          <div className={styles.addRow}>
            <SaveErrorField names={["label","adding.label"]}><TextField
              aria-label="聞くこと"
              placeholder="例：ペットの名前と年齢"
              value={adding.label}
              maxLength={200}
              onChange={(event) => setAdding({ ...adding, label: event.target.value })}
            /></SaveErrorField>
            <span className={styles.questionToggle}><SaveErrorField names={["required","adding.required"]}><ToggleField checked={adding.required} onChange={(checked) => setAdding({ ...adding, required: checked })}>必須</ToggleField></SaveErrorField></span>
            <Button
              disabled={!adding.label.trim()}
              disabledReason={!adding.label.trim() ? '聞くことを入力してください。' : undefined}
              onClick={() => {
                setQuestions((current) => [...current, { label: adding.label.trim(), required: adding.required }])
                setAdding(null)
              }}
            >足す</Button>
            <Button variant="text" onClick={() => setAdding(null)}>やめる</Button>
          </div>
        ) : (
          <div className={styles.linkRow}>
            <Button variant="text" onClick={() => setAdding({ label: '', required: true })}>＋ 質問を足す</Button>
          </div>
        )}
      </Card>

      <Card variant="form" gap="normal" aria-labelledby="ev-new-after-apply">
        <CardHeader size="stacked" titleId="ev-new-after-apply" title="申し込んだ人にすること" />
        <div className={styles.checks}>
            <ToggleField checked disabled description="申込の受付は、いつも LINE でお知らせします。日時・場所が届きます。" onChange={() => {}}>
              申込を受けたら LINE で知らせる
            </ToggleField>

          <SaveErrorField names={["reminder_day_before_enabled","draft.reminder_day_before_enabled"]}><ToggleField
            checked={draft.reminder_day_before_enabled === 1}
            onChange={(checked) => update('reminder_day_before_enabled', checked ? 1 : 0)}
          >
            前日に思い出してもらう
          </ToggleField></SaveErrorField>
        </div>
      </Card>

      <UnsavedLeaveDialog open={leaveTarget !== null} subject="入力したイベント" onConfirm={confirmLeave} onCancel={cancelLeave} />
      <ConfirmDialog open={pastConfirmation !== null && pastConfirmation.accountId === selectedAccountId} title="過去の日時で保存しますか？" description="開始日時が過去です。日時を確認してください。" warning confirmLabel="この日時で保存する" busy={saving} error={error || undefined} onCancel={() => setPastConfirmation(null)} onSuccess={() => setPastConfirmation(null)} onConfirm={() => {
        if (!pastConfirmation || pastConfirmation.accountId !== selectedAccountId || pastConfirmation.snapshot !== snapshot) return false
        return save(pastConfirmation.publish, pastConfirmation.snapshot)
      }} />
      <ConfirmDialog open={publishTarget !== null && publishTarget.generation === accountScope.current.generation} title="イベントを公開する" description="イベントを公開し、お客さまが申し込めるようにします。内容を確かめてください。" confirmLabel="公開する" busy={saving} confirmDisabled={createUnknown} confirmDisabledReason="閉じて一覧で作成結果を確認してください。" error={error || undefined} onSuccess={() => setPublishTarget(null)} onConfirm={() => {
        if (!publishTarget || publishTarget.generation !== accountScope.current.generation || !canEditRef.current || JSON.stringify(publishTarget.accountIds) !== JSON.stringify(targetIdsRef.current)) return
        return save(true)
      }} onCancel={() => setPublishTarget(null)}>
        {publishTarget ? <OperationTargetSummary accounts={publishTarget.accountIds.map(id => ({ id }))} /> : null}
      </ConfirmDialog>
    </CreatePage></SaveErrorScope>
  )
}

function formatDay(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return '日付未定'
  const day = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
  const week = ['日', '月', '火', '水', '木', '金', '土'][day.getUTCDay()]
  return `${Number(match[2])}/${Number(match[3])}（${week}）`
}
