'use client'
import { Inbox, Check, Download, Send } from 'lucide-react'
import { withHonorific } from '@line-crm/shared'
import { formatDate as polishFormatDate } from '@/lib/format'
import { Suspense, useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { api, eventsApi, type EventBookingItem, type EventDetail, type EventOccurrenceApplicant, type EventOccurrenceApplicants, type EventSlot } from '@/lib/api'
import { useAccount } from '@/contexts/account-context'
import { usePageTitle } from '@/components/shell/page-chrome'
import { useStaffRole, canManageRole } from '@/lib/staff-role'
import { DetailPage } from '@/components/templates'
import KpiCard from '@/components/shared/kpi-card'
import KpiBand from '@/components/shared/kpi-band'
import Button from '@/components/shared/button'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import ListState from '@/components/shared/list-state'
import Select from '@/components/shared/select'
import TargetMissing from '@/components/shared/target-missing'
import { jstShort } from './shared'
import styles from './bookings.module.css'
import { Field } from '@/components/shared/form-controls'
import { emptyValue } from '@/components/shared/empty-value'
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import EntitySelect, { entityOptionMetadata } from '@/components/shared/entity-select'
import StatusBadge from '@/components/shared/status-badge'
import { EventRosterCard, EventRosterTable, EventRosterRow, EventRosterActions, EventAttendanceSummary } from '@/components/shared/event-roster'
import { TextField, TextArea } from '@/components/shared/text-field'
import Notice from '@/components/shared/notice'
import { useBookingRequests } from './booking-requests'
import BookingRecords from './booking-records'
import { RowMenu } from '@/components/shared/row-actions'
import { usePermissionLockReason } from '@/components/shared/use-permission-lock-reason'
import { useEventAbsence } from './use-event-absence'

/*
 * ★V8 イベント予約の「申込者」（Pencil ）。
 *
 * 型（DetailPage）に、頭（題・戻る口・CSV・開催回の選び口）、数の帯（申込・承認待ち・キャンセル待ち・キャンセル）、
 * 申込者・キャンセル待ち・キャンセル・お知らせを送る の4枚をはめる。
 * 開催回の取得・確かめる窓・操作の失敗はこの画面で扱う。
 * 行の操作は絵どおり行に直接出す（承認する／断る・キャンセルにする／参加済／無断・予約に繰上げ・待ち順を変える）。
 */

/** 予約・申込の状態の見え方。色だけに頼らず、必ず文字で言う。 */
type ChipTone = 'warning' | 'success' | 'info' | 'neutral' | 'danger'
const STATUS_TONE: Record<string, ChipTone> = {
  requested: 'warning',
  confirmed: 'success',
  waiting: 'neutral',
  offered: 'info',
  accepted: 'success',
  converted: 'success',
  expired: 'neutral',
  cancelled: 'neutral',
  attended: 'success',
  no_show: 'danger',
}

const STATUS_LABELS: Record<string, string> = {
  requested: '承認待ち',
  confirmed: '確定',
  waiting: '待機中',
  offered: '案内中',
  accepted: '受諾済み',
  converted: '予約に繰上げ',
  expired: '期限切れ',
  cancelled: '本人が取消',
  attended: '参加済',
  no_show: '無断',
}

/** 開催回の選び口の表示（板：`10/12（月）14:00`）。曜日は日付から作る。 */
function formatOccurrence(iso: string): string {
  return `${polishFormatDate(iso, { style: 'list-day-weekday', fallback: iso })} ${polishFormatDate(iso, { style: 'time', fallback: '' })}`
}
function participationSub(applicant: EventOccurrenceApplicant): string {
  if (applicant.firstParticipation.isFirst === true) return '初参加'
  if (applicant.firstParticipation.isFirst === false) return '過去のイベント参加あり'
  return ''
}

type WaitlistDialog =
  | { kind: 'promote' }
  | { kind: 'reorder'; applicantId: string; direction: -1 | 1; description: string }
  | { kind: 'skip'; waitlistId: string; name: string }

export default function EventBookingsV8() {
  return (
    <Suspense fallback={<ListState kind="loading" />}>
      <BookingsEntry />
    </Suspense>
  )
}

function BookingsEntry() {
  const eventId = useSearchParams().get('id') ?? ''
  return <Bookings eventId={eventId} />
}

function Bookings({ eventId }: { eventId: string }) {
  const saveErrors = useSaveFormErrors()
  const { selectedAccountId } = useAccount()
  const staffRole = useStaffRole()
  const canChangeBookings = staffRole === 'owner' || staffRole === 'admin' || staffRole === 'staff'
  const canBroadcast = canManageRole(staffRole)
  const bookingLockReason = usePermissionLockReason(canChangeBookings)
  const broadcastLockReason = usePermissionLockReason(canBroadcast, 'manager')
  const [event, setEvent] = useState<EventDetail | null>(null)
  const [eventStatus, setEventStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [slotsStatus, setSlotsStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [slots, setSlots] = useState<EventSlot[]>([])
  const [selectedOccurrenceId, setSelectedOccurrenceId] = useState('')
  const [applicants, setApplicants] = useState<EventOccurrenceApplicants | null>(null)
  const [applicantsStatus, setApplicantsStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [recordsRevision, setRecordsRevision] = useState(0)
  const [actionError, setActionError] = useState('')
  const [busy, setBusy] = useState(false)
  const [marking, setMarking] = useState<ReadonlySet<string>>(new Set())
  const [csvBusy, setCsvBusy] = useState(false)
  const [cancelApplicant, setCancelApplicant] = useState<{ applicant: EventOccurrenceApplicant; accountId: string } | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const [cancelError, setCancelError] = useState('')
  const [rejectApplicant, setRejectApplicant] = useState<{ applicant: EventOccurrenceApplicant; accountId: string } | null>(null)
  const [rejectReason, setRejectReason] = useState('')
  const [rejectError, setRejectError] = useState('')
  const [waitlistDialog, setWaitlistState] = useState<WaitlistDialog | null>(null)
  const [waitlistAccount, setWaitlistAccount] = useState<string | null>(null)
  const setWaitlistDialog = (next: WaitlistDialog | null) => {
    if (next && !selectedAccountId) return
    setWaitlistAccount(next ? selectedAccountId : null)
    setWaitlistState(next)
  }
  const [waitlistReason, setWaitlistReason] = useState('')
  const [waitlistBusy, setWaitlistBusy] = useState(false)
  const [waitlistError, setWaitlistError] = useState('')
  const [broadcastMessage, setBroadcastMessage] = useState('')
  const [broadcastPreview, setBroadcastPreview] = useState<{ broadcastId: string; recipientCount: number; accountId: string } | null>(null)
  const [broadcastConfirmOpen, setBroadcastConfirmOpen] = useState(false)
  const [broadcastBusy, setBroadcastBusy] = useState(false)
  const [broadcastError, setBroadcastError] = useState('')

  /* お知らせの口は統括・管理者だけ（Worker の requireRole('owner','admin')）。役割はサーバーから読む。 */
  useEffect(() => {
    if (!canChangeBookings || bookingLockReason) {
      setCancelApplicant(null)
      setRejectApplicant(null)
      setWaitlistDialog(null)
    }
    if (!canBroadcast || broadcastLockReason) setBroadcastConfirmOpen(false)
  }, [canChangeBookings, bookingLockReason, canBroadcast, broadcastLockReason])

  usePageTitle(event?.name ? `${event.name} の申込者` : 'イベントの申込者')

  const scope = JSON.stringify([selectedAccountId, eventId])
  const requests = useBookingRequests(scope)
  const operationScope = JSON.stringify([selectedAccountId, eventId, selectedOccurrenceId])
  const operations = useBookingRequests(operationScope)
  const [renderedScope, setRenderedScope] = useState(scope)
  if (renderedScope !== scope) {
    setRenderedScope(scope)
    setEvent(null)
    setSlots([])
    setSelectedOccurrenceId('')
    setEventStatus('loading')
    setSlotsStatus('loading')
  }
  const [renderedOperationScope, setRenderedOperationScope] = useState(operationScope)
  if (renderedOperationScope !== operationScope) {
    setRenderedOperationScope(operationScope)
    setApplicants(null)
    setRecordsRevision(0)
    setApplicantsStatus('loading')
    setActionError('')
    setBusy(false)
    setMarking(new Set())
    setCsvBusy(false)
    setCancelApplicant(null)
    setCancelling(false)
    setCancelError('')
    setRejectApplicant(null)
    setRejectReason('')
    setRejectError('')
    setWaitlistDialog(null)
    setWaitlistReason('')
    setWaitlistBusy(false)
    setWaitlistError('')
    setBroadcastMessage('')
    setBroadcastPreview(null)
    setBroadcastConfirmOpen(false)
    setBroadcastBusy(false)
    setBroadcastError('')
  }

  const refreshEvent = useCallback(async () => {
    if (!selectedAccountId || !eventId) return
    const request = requests.start('event', true)
    if (!request) return
    setEventStatus('loading')
    try {
      const detail = await eventsApi.getEvent(selectedAccountId, eventId)
      if (!request.isCurrent()) return
      setEvent(detail)
      setEventStatus('ready')
    } catch (saveFailure) {
      if (!request.isCurrent()) return
      saveErrors.capture(saveFailure)
      setEvent(null)
      setEventStatus('error')
    } finally { request.finish() }
  }, [selectedAccountId, eventId, saveErrors, requests]);


  const refreshSlots = useCallback(async () => {
    setSlotsStatus('loading')
    if (!selectedAccountId || !eventId) {
      setSlots([])
      setSelectedOccurrenceId('')
      return
    }
    const request = requests.start('slots', true)
    if (!request) return
    try {
      const res = await eventsApi.listOccurrenceSelector(selectedAccountId, eventId)
      if (!request.isCurrent()) return
      if (!Array.isArray(res?.items)) throw new Error('malformed_slots')
      setSlots(res.items)
      setSlotsStatus('ready')
      setSelectedOccurrenceId((current) => current || res.items[0]?.id || '')
    } catch (saveFailure) {
      if (!request.isCurrent()) return
      saveErrors.capture(saveFailure)
      setSlots([])
      setSlotsStatus('error')
    } finally { request.finish() }
  }, [selectedAccountId, eventId, saveErrors, requests]);


  const refreshApplicants = useCallback(async () => {
    if (!selectedAccountId || !selectedOccurrenceId) return
    const request = operations.start('applicants', true)
    if (!request) return
    setApplicantsStatus('loading')
    try {
      const data = await eventsApi.getOccurrenceApplicants(selectedAccountId, selectedOccurrenceId)
      if (!request.isCurrent()) return
      if (!Array.isArray(data?.applicants) || !data.occurrence) throw new Error('malformed_applicants')
      setApplicants(data)
      setRecordsRevision((value) => value + 1)
      setBroadcastPreview(null)
      setBroadcastConfirmOpen(false)
      setApplicantsStatus('ready')
    } catch (saveFailure) {
      if (!request.isCurrent()) return
      saveErrors.capture(saveFailure)
      setApplicants(null)
      setApplicantsStatus('error')
    } finally { request.finish() }
  }, [selectedAccountId, selectedOccurrenceId, saveErrors, operations])

  const absence = useEventAbsence({ accountId: selectedAccountId ?? '', scope: operationScope, onSaved: () => { void refreshApplicants() } })

  useEffect(() => {
    void refreshEvent()
    setApplicants(null)
    setSelectedOccurrenceId('')
    void refreshSlots()
  }, [refreshEvent, refreshSlots])

  useEffect(() => {
    if (!selectedOccurrenceId) return
    void refreshApplicants()
  }, [refreshApplicants, selectedOccurrenceId])

  if (!eventId) {
    return (
      <SaveErrorScope errors={saveErrors}><div data-design-node="Mu8qW">
        <TargetMissing
          kind="unspecified"
          title="どのイベントの申込かが決まっていません"
          description="イベントの一覧から選び直してください。"
          backHref="/events"
          backLabel="イベント一覧へ戻る"
        />
      </div></SaveErrorScope>
    )
  }

  if (!selectedAccountId) {
    return (
      <SaveErrorScope errors={saveErrors}><div data-design-node="Mu8qW">
        <ListState kind="empty" title="LINEアカウントを選択してください" description="上のバーで運用するLINEアカウントを選んでください。" />
      </div></SaveErrorScope>
    )
  }

  const occurrence = applicants?.occurrence ?? null
  const absenceAction = (bookingId: string, name: string, startsAt: string | undefined) => startsAt && Date.parse(startsAt) > Date.now() ? <Button
    data-booking-id={bookingId} data-booking-action="absence"
    size="compact" lockedReason={absence.lockedReason} disabled={!absence.allowed || busy || marking.has(bookingId)}
    onClick={() => absence.open({ bookingId, eventId, name, startsAt })}>欠席</Button> : null
  const rows = applicants?.applicants ?? []
  const bookingRows = rows.filter((row) => row.source === 'booking')
  const waitingRows = rows.filter((row) => row.source === 'waitlist' && row.status === 'waiting')
  const summary = applicants?.summary
  const confirmedSeats = summary?.confirmedSeats ?? bookingRows.filter((row) => row.status === 'confirmed').reduce((total, row) => total + row.partySize, 0)
  const requestedSeats = summary?.requestedSeats ?? bookingRows.filter((row) => row.status === 'requested').reduce((total, row) => total + row.partySize, 0)
  const waitingSeats = summary?.waitingSeats ?? waitingRows.reduce((total, row) => total + row.partySize, 0)
  const offeredSeats = summary?.offeredSeats ?? rows.filter((row) => row.source === 'waitlist' && (row.status === 'offered' || row.status === 'accepted')).reduce((total, row) => total + row.partySize, 0)
  const capacity = occurrence?.capacity ?? null
  const history = applicants?.waitlistHistory ?? []
  const cancelledCount = history.filter((entry) => entry.status === 'cancelled').length
  const attendance = applicants?.attendance ?? null


  async function decide(applicant: EventOccurrenceApplicant, action: 'confirm' | 'reject') {
    if (!canChangeBookings || bookingLockReason) return
    if (!selectedAccountId || busy) return
    const request = operations.start('decide')
    if (!request) return
    setBusy(true)
    setActionError('')
    try {
      await eventsApi.decideBooking(selectedAccountId, eventId, applicant.id, action, action === 'reject' ? rejectReason.trim() || undefined : undefined)
      if (!request.isCurrent()) return
      if (action === 'reject') {
        setRejectApplicant(null)
        setRejectReason('')
        setRejectError('')
      }
      await refreshApplicants()
    } catch (saveFailure) {
      if (!request.isCurrent()) return
      const fieldFailure = saveErrors.capture(saveFailure);

      if (action === 'reject') {
        { if (!fieldFailure)
        setRejectError('予約を拒否できませんでした。ほかの操作で状態が変わっている場合があります。一覧を読み直してから、もう一度お試しください。')
      }
      } else {
        { if (!fieldFailure)
        setActionError('予約を確定できませんでした。ほかの操作で状態が変わっている場合があります。一覧を読み直してから、もう一度お試しください。') }
      }
    } finally {
      if (request.isCurrent()) setBusy(false)
      request.finish()
    }
  }

  async function runAdminCancel() {
    if (!canChangeBookings || bookingLockReason) return
    if (!cancelApplicant || cancelling) return
    if (cancelApplicant.accountId !== selectedAccountId) return
    const request = operations.start('cancel')
    if (!request) return
    setCancelling(true)
    setCancelError('')
    try {
      const res = await eventsApi.adminCancelBooking(cancelApplicant.accountId, eventId, cancelApplicant.applicant.id)
      if (!request.isCurrent()) return
      if (!res?.ok) throw new Error('cancel_not_applied')
      setCancelApplicant(null)
      await refreshApplicants()
    } catch (saveFailure) {
      if (!request.isCurrent()) return
      const fieldFailure = saveErrors.capture(saveFailure)

      { if (!fieldFailure)
      setCancelError('この予約をキャンセルできませんでした。ほかの操作で状態が変わっている場合があります。一覧を読み直してから、もう一度お試しください。') }
    } finally {
      if (request.isCurrent()) setCancelling(false)
      request.finish()
    }
  }

  async function markStatus(applicant: EventOccurrenceApplicant, status: 'attended' | 'no_show') {
    const accountId = selectedAccountId
    if (!canChangeBookings || bookingLockReason) return
    if (!accountId || marking.has(applicant.id)) return
    const request = operations.start(`mark:${applicant.id}`)
    if (!request) return
    setMarking((current) => new Set(current).add(applicant.id))
    try {
      await eventsApi.updateBooking(accountId, eventId, applicant.id, { status })
      if (!request.isCurrent()) return
      await refreshApplicants()
    } catch (saveFailure) {
      if (!request.isCurrent()) return
      const fieldFailure = saveErrors.capture(saveFailure)

      { if (!fieldFailure)
      setActionError('来場・不参加の記録を変えられませんでした。一覧を読み直してから、もう一度お試しください。') }
    } finally {
      if (request.isCurrent()) setMarking((current) => {
        const next = new Set(current)
        next.delete(applicant.id)
        return next
      })
      request.finish()
    }
  }

  function openReorder(applicantId: string, direction: -1 | 1) {
    const waiting = rows.filter((row) => row.source === 'waitlist' && row.status === 'waiting')
    const index = waiting.findIndex((row) => row.id === applicantId)
    const other = waiting[index + direction]
    const current = waiting[index]
    if (!current || !other) return
    const first = direction === -1 ? current : other
    const second = direction === -1 ? other : current
    setWaitlistReason('')
    setWaitlistError('')
    setWaitlistDialog({
      kind: 'reorder',
      applicantId,
      direction,
      description: `「${first.displayName ?? '待機中の方'}」と「${second.displayName ?? '待機中の方'}」の順番を入れ替えます。`,
    })
  }

  async function runWaitlistOperation() {
    if (!canChangeBookings || bookingLockReason) return
    if (!selectedAccountId || selectedAccountId !== waitlistAccount || !occurrence || !waitlistDialog || waitlistBusy) return
    const trimmed = waitlistReason.trim()
    if (trimmed === '') return
    const request = operations.start('waitlist')
    if (!request) return
    setWaitlistBusy(true)
    setWaitlistError('')
    setActionError('')
    try {
      if (waitlistDialog.kind === 'promote') {
        await eventsApi.promoteOccurrenceWaitlist(selectedAccountId, occurrence.id, occurrence.version, trimmed)
      } else if (waitlistDialog.kind === 'reorder') {
        const waiting = rows.filter((row) => row.source === 'waitlist' && row.status === 'waiting')
        const index = waiting.findIndex((row) => row.id === waitlistDialog.applicantId)
        const orderedIds = waiting.map((row) => row.id)
        const [moved] = orderedIds.splice(index, 1)
        orderedIds.splice(index + waitlistDialog.direction, 0, moved as string)
        await eventsApi.reorderOccurrenceWaitlist(selectedAccountId, occurrence.id, {
          ordered_ids: orderedIds,
          expectedVersion: occurrence.version,
          reason: trimmed,
        })
      } else {
        await eventsApi.skipOccurrenceWaitlist(selectedAccountId, occurrence.id, {
          waitlist_id: waitlistDialog.waitlistId,
          expectedVersion: occurrence.version,
          reason: trimmed,
        })
      }
      if (!request.isCurrent()) return
      setWaitlistDialog(null)
      setWaitlistReason('')
      await refreshApplicants()
    } catch (saveFailure) {
      if (!request.isCurrent()) return
      const fieldFailure = saveErrors.capture(saveFailure)
      await refreshApplicants()
      if (!request.isCurrent()) return
      { if (!fieldFailure)
      setWaitlistError('変えられませんでした。ほかの操作で順番や空席が変わった可能性があります。最新の状態を確かめてから、もう一度お試しください。') }
    } finally {
      if (request.isCurrent()) setWaitlistBusy(false)
      request.finish()
    }
  }

  async function exportCsv() {
    if (!canChangeBookings || bookingLockReason) return
    if (!selectedAccountId || !applicants || csvBusy) return
    const request = operations.start('csv')
    if (!request) return
    setCsvBusy(true)
    setActionError('')
    try {
      await eventsApi.downloadOccurrenceApplicantsCsv(selectedAccountId, applicants.occurrence.id, applicants.snapshotId)
    } catch (saveFailure) {
      if (!request.isCurrent()) return
      const fieldFailure = saveErrors.capture(saveFailure)

      { if (!fieldFailure)
      setActionError('CSVを書き出せませんでした。通信を確認して、もう一度お試しください。') }
    } finally {
      if (request.isCurrent()) setCsvBusy(false)
      request.finish()
    }
  }

  async function previewBroadcast() {
    const message = broadcastMessage.trim()
    if (!canBroadcast || broadcastLockReason) return
    if (!selectedAccountId || !occurrence || !message || broadcastBusy) return
    const request = operations.start('broadcast')
    if (!request) return
    setBroadcastBusy(true)
    setBroadcastError('')
    try {
      const result = await eventsApi.previewOccurrenceBroadcast(selectedAccountId, occurrence.id, {
        title: `${event?.name ?? 'イベント'}の申込者への案内`,
        messageContent: message,
        snapshotId: applicants?.snapshotId ?? '',
      }, crypto.randomUUID())
      if (!request.isCurrent()) return
      setBroadcastPreview({ broadcastId: result.broadcastId, recipientCount: result.recipientCount, accountId: selectedAccountId })
      setBroadcastConfirmOpen(true)
    } catch (saveFailure) {
      if (!request.isCurrent()) return
      const fieldFailure = saveErrors.capture(saveFailure)

      { if (!fieldFailure)
      setBroadcastError('対象を確定できませんでした。内容を確認して、もう一度お試しください。') }
    } finally {
      if (request.isCurrent()) setBroadcastBusy(false)
      request.finish()
    }
  }

  async function sendBroadcast() {
    if (!canBroadcast || broadcastLockReason) return
    if (!broadcastPreview || broadcastBusy) return
    const request = operations.start('broadcast')
    if (!request) return
    setBroadcastBusy(true)
    setBroadcastError('')
    try {
      await api.broadcasts.send(broadcastPreview.broadcastId)
      if (!request.isCurrent()) return
      setBroadcastConfirmOpen(false)
      setBroadcastMessage('')
      setBroadcastPreview(null)
    } catch (saveFailure) {
      if (!request.isCurrent()) return
      const fieldFailure = saveErrors.capture(saveFailure)

      { if (!fieldFailure)
      setBroadcastError('送信を開始できませんでした。まだ送られていない可能性があるため、配信一覧で状態を確認してから再試行してください。') }
    } finally {
      if (request.isCurrent()) setBroadcastBusy(false)
      request.finish()
    }
  }

  /* 区分・順位の「キャンセル待ち N 番」は、案内中も含めた並び順で数える（絵：案内中 1 番・待機中 2 番）。 */
  const queueRows = rows.filter((row) => row.source === 'waitlist' && (row.status === 'waiting' || row.status === 'offered' || row.status === 'accepted'))
  const waitlistRankAll = (id: string) => queueRows.findIndex((row) => row.id === id) + 1

  const chip = (status: string) => {
    const label = STATUS_LABELS[status] ?? status
    return <StatusBadge tone={STATUS_TONE[status] ?? 'neutral'}>{label}</StatusBadge>
  }
  const historyRows = history.filter((entry) => entry.status !== 'cancelled')
  const cancelRows = history.filter((entry) => entry.status === 'cancelled')
  const title = event?.name ? `${event.name}の申込者` : 'イベントの申込者'
  const subLine = [event?.venue_name ?? null, capacity !== null ? `定員 ${capacity} 人` : null].filter(Boolean).join('・')
  const ready = applicantsStatus === 'ready'

  return (
    <SaveErrorScope errors={saveErrors}><DetailPage
      boardId="Mu8qW"
      readOnly={Boolean(bookingLockReason)}
      title={title}
      layout="event-roster"
      help={subLine || '開催回ごとの申込・承認・キャンセル待ちを確認できます。'}
      contentPadding="var(--tpl-roster-body-pad)"
      stats={<KpiBand data-design="KPIs">
        <KpiCard presentation="band" title="申込" value={ready ? (occurrence?.activeSeats ?? confirmedSeats + requestedSeats) : null} valueText={ready ? `${occurrence?.activeSeats ?? confirmedSeats + requestedSeats}${capacity !== null ? ` / ${capacity}` : ''}` : undefined} valueTextWithUnit unit="人・この回" detail="" />
        <KpiCard presentation="band" title="承認待ち" value={ready ? requestedSeats : null} unit="件" detail="" />
        <KpiCard presentation="band" title="キャンセル待ち" value={ready ? waitingSeats + offeredSeats : null} unit="人" detail="" />
        <KpiCard presentation="band" title="キャンセル" value={ready ? cancelledCount : null} unit="件" detail="" />
      </KpiBand>}
      actions={(
        <div className={styles.headActions}>
          <Button onClick={() => void exportCsv()} lockedReason={bookingLockReason} disabled={!canChangeBookings || csvBusy || !applicants} busy={csvBusy} busyLabel="書き出しています…">
            <Download size={16} aria-hidden="true" />CSVで書き出す
          </Button>
          <div className={styles.occurrencePick}>
            <SaveErrorField names={["selectedOccurrenceId","selected_occurrence_id"]}><EntitySelect
              size="full"
              value={selectedOccurrenceId}
              onChange={setSelectedOccurrenceId}
              aria-label="開催回を選ぶ"
              valuePrefix="開催回："
              options={slots.map((slot) => ({ ...entityOptionMetadata(slot), value: slot.id, label: formatOccurrence(slot.starts_at) }))}
            /></SaveErrorField>
          </div>
        </div>
      )}
    >
      <div className={styles.body}>
      {absence.notice}
      {eventStatus === 'error' ? (
        <ListState
          kind="error"
          description="イベントは消えていません。開き直しても直らない場合はエラー報告へ。"
          action={<Button onClick={() => refreshEvent()} busyLabel="処理中…">開き直す</Button>}
        />
      ) : null}
      {actionError ? <Notice tone="danger" >{actionError}</Notice> : null}



      <EventRosterCard title="申込者" id="ev-bk-applicants" splitAction
        note="承認待ちは期限までに承認か断るを選びます。断る・キャンセルにすると LINE でお知らせが届き、枠が空きます"
        action={<EventAttendanceSummary
          attended={ready ?attendance?.attendedSeats ?? null : null}
          noShow={ready ? attendance?.noShowSeats ?? null : null}
          before={ready && attendance ? confirmedSeats : null}/>}>
        {applicantsStatus === 'loading' ? <ListState kind="loading" /> : applicantsStatus === 'error' ? (
          <ListState
            kind="error"
            description="申込者は消えていません。開き直しても直らない場合はエラー報告へ。"
            action={<Button onClick={() => refreshApplicants()} busyLabel="処理中…">開き直す</Button>}
          />
        ) : rows.length === 0 ? (
          <p className={styles.empty}>この開催回には申込者もキャンセル待ちもいません。</p>
        ) : (
          <EventRosterTable kind="applicants"label="申込者" headings={["申込者", "区分・順位", "状態", "案内期限"]}>
            {rows.map((row) => (
              <EventRosterRow key={`${row.source}:${row.id}`}>
                <span role="cell" className={styles.person}>
                  <span className={styles.personName} title={row.displayName ?? '友だちは未取得'}>{row.displayName ?? '友だちは未取得'}</span>
                  <span className={styles.personSub} title={participationSub(row)}>{participationSub(row)}</span>
                </span>
                <span role="cell" className={styles.cellText} title={row.source === 'waitlist' ? `キャンセル待ち ${waitlistRankAll(row.id)} 番` : '申込'}>
                  {row.source === 'waitlist'
                    ? row.status === 'waiting' || row.status === 'offered' || row.status === 'accepted'
                      ? `キャンセル待ち ${waitlistRankAll(row.id)} 番`
                      : 'キャンセル待ち'
                    : '申込'}
                </span>
                <span role="cell">{chip(row.status)}</span>
                <EventRosterActions deadline={<span title={row.offerExpiresAt ? jstShort(row.offerExpiresAt) : undefined}>
                  {row.offerExpiresAt ? jstShort(row.offerExpiresAt) : row.status === 'waiting' ? '案内前' : emptyValue('unknown')}
                </span>}>
                  {row.source === 'booking' && ['requested', 'confirmed'].includes(row.status) ? absenceAction(row.id, row.displayName ?? '申込者', occurrence?.startsAt) : null}
                  {row.source === 'booking' && row.status === 'requested' ? (
                    <>
                      <Button variant="primary" onClick={() => void decide(row, 'confirm')} lockedReason={bookingLockReason} disabled={!canChangeBookings || busy} busy={Boolean(busy)} busyLabel="処理中…">承認する</Button>
                      <RowMenu label={`${withHonorific(row.displayName ?? '申込者')}の操作`} triggerProps={{ 'data-booking-id': row.id, 'data-booking-action': 'menu' }} items={[{ id: 'reject', lockedReason: bookingLockReason, label: '断る', onSelect: () => {
                          setRejectReason('')
                          setRejectError('')
                          if (selectedAccountId) setRejectApplicant({ applicant: row, accountId: selectedAccountId })
                        }, disabled: !canChangeBookings || Boolean(busy), disabledReason: busy ? '処理を反映しています' : undefined}]} />
                    </>
                  ) : null}
                  {row.source === 'booking' && row.status === 'confirmed' ? (
                    <>
                      <Button data-booking-id={row.id} data-booking-action="attended" variant="primary"
                        onClick={() => void markStatus(row, 'attended')}
                        lockedReason={bookingLockReason} disabled={!canChangeBookings || marking.has(row.id)}
                      ><Check size={16} aria-hidden="true" />参加済にする</Button>
                      <RowMenu label={`${withHonorific(row.displayName ?? '申込者')}の操作`} triggerProps={{ 'data-booking-id': row.id, 'data-booking-action': 'menu' }} items={[
                        { id: 'no-show', lockedReason: bookingLockReason, label: '無断', onSelect: () => void markStatus(row, 'no_show'), disabled: !canChangeBookings || marking.has(row.id), disabledReason: marking.has(row.id) ? '処理を反映しています' : undefined },
                        { id: 'cancel', lockedReason: bookingLockReason, label: 'キャンセルにする', onSelect: () => {
                          if (!selectedAccountId) return
                          setCancelError('')
                          setCancelApplicant({ applicant: row, accountId: selectedAccountId })
                        }, disabled: !canChangeBookings || Boolean(busy), disabledReason: busy ? '処理を反映しています' : undefined },
                      ]} />
                    </>
                  ) : null}
                  {row.source === 'waitlist' && (row.status === 'offered' || row.status === 'accepted') ? (
                    <>
                      <Button
                        data-booking-id={row.id} data-booking-action="promote"
                        variant="primary"
                        onClick={() => {
                          setWaitlistReason('')
                          setWaitlistError('')
                          setWaitlistDialog({ kind: 'promote' })
                        }}
                        lockedReason={bookingLockReason} disabled={!canChangeBookings || waitlistBusy}
                      >予約に繰上げ</Button>
                      <RowMenu label={`${row.displayName ?? '待機中の方'}の操作`} triggerProps={{ 'data-booking-id': row.id, 'data-booking-action': 'menu' }} items={[{ id: 'skip', lockedReason: bookingLockReason, label: '見送る', onSelect: () => {
                        setWaitlistReason('')
                        setWaitlistError('')
                        setWaitlistDialog({ kind: 'skip', waitlistId: row.id, name: row.displayName ?? '待機中の方' })
                      }, disabled: !canChangeBookings || waitlistBusy, disabledReason: waitlistBusy ? '処理を反映しています' : undefined }]} />
                    </>
                  ) : null}
                  {row.source === 'waitlist' && row.status === 'waiting' ? (
                    <>
                      <Button variant="primary"
                        onClick={() => {
                          setWaitlistReason('')
                          setWaitlistError('')
                          const index = waitingRows.findIndex((waiting) => waiting.id === row.id)
                          openReorder(row.id, index <= 0 ? 1 : -1)
                        }}
                        lockedReason={bookingLockReason} disabled={!canChangeBookings || waitlistBusy || waitingRows.length < 2}
                        title={waitingRows.length < 2 ? '並んでいる人が2人以上いるときに使えます' : undefined}
                      >待ち順を変更する</Button>
                      <RowMenu label={`${row.displayName ?? '待機中の方'}の操作`} triggerProps={{ 'data-booking-id': row.id, 'data-booking-action': 'menu' }} items={[{ id: 'skip', lockedReason: bookingLockReason, label: '見送る', onSelect: () => {
                        setWaitlistReason('')
                        setWaitlistError('')
                        setWaitlistDialog({ kind: 'skip', waitlistId: row.id, name: row.displayName ?? '待機中の方' })
                      }, disabled: !canChangeBookings || waitlistBusy, disabledReason: waitlistBusy ? '処理を反映しています' : undefined }]} />
                    </>
                  ) : null}
                </EventRosterActions>
              </EventRosterRow>
            ))}
          </EventRosterTable>
        )}
      </EventRosterCard>

      <EventRosterCard title="キャンセル待ち" id="ev-bk-waitlist" note="空きが出たら先頭の方へ期限つきの案内を送ります。期限までに返事がなければ次の方へ" action={(
          <Button
            onClick={() => {
              setWaitlistReason('')
              setWaitlistError('')
              setWaitlistDialog({ kind: 'promote' })
            }}
            lockedReason={bookingLockReason} disabled={!canChangeBookings || waitlistBusy || waitingRows.length === 0}
          >
            <Send size={16} aria-hidden="true" />次の方へ案内する
          </Button>
        )}>
          <EventRosterTable kind="waitlist" label="キャンセル待ち" headings={["友だち", "結果", "並んだ日時", "案内日時", "終了日時"]}>
          {rows.filter((row) => row.source === 'waitlist').map((row) => (
            <EventRosterRow key={`now:${row.id}`}>
              <span role="cell" className={styles.cellName} title={row.displayName ?? '友だちは未取得'}>{row.displayName ?? '友だちは未取得'}</span>
              <span role="cell">{chip(row.status)}</span>
              <span role="cell" className={styles.cellText}>{jstShort(row.appliedAt)}</span>
              <span role="cell" className={styles.cellText}>{jstShort(row.offeredAt)}</span>
              <span role="cell" className={styles.cellText}>{emptyValue('unknown')}</span>
            </EventRosterRow>
          ))}
          {historyRows.map((entry) => (
            <EventRosterRow key={`done:${entry.id}`}>
              <span role="cell" className={styles.cellName} title={entry.displayName ?? '友だちは未取得'}>{entry.displayName ?? '友だちは未取得'}</span>
              <span role="cell">{chip(entry.status)}</span>
              <span role="cell" className={styles.cellText}>{jstShort(entry.createdAt)}</span>
              <span role="cell" className={styles.cellText}>{jstShort(entry.offeredAt)}</span>
              <span role="cell" className={styles.cellText}>{jstShort(entry.updatedAt)}</span>
            </EventRosterRow>
          ))}
          {waitingRows.length === 0 && historyRows.length === 0 && !rows.some((row) => row.source === 'waitlist') ? (
            <p className={styles.empty}>キャンセル待ちはいません。</p>
          ) : null}
        </EventRosterTable>
      </EventRosterCard>

      <EventRosterCard title="キャンセル" id="ev-bk-cancel"><EventRosterTable kind="cancel"label="キャンセル" headings={["友だち", "結果", "記録日時"]}>
          {cancelRows.map((entry) => (
            <EventRosterRow key={entry.id}>
              <span role="cell" className={styles.cellName} title={entry.displayName ?? '友だちは未取得'}>{entry.displayName ?? '友だちは未取得'}</span>
              <span role="cell">{chip('cancelled')}</span>
              <span role="cell" className={styles.cellText}>{jstShort(entry.updatedAt)}</span>
            </EventRosterRow>
          ))}
          {cancelRows.length === 0 ? <p className={styles.empty}>キャンセルはありません。</p> : null}
        </EventRosterTable>
      </EventRosterCard>

      <EventRosterCard title="お知らせを送る" id="ev-bk-broadcast" note="この回の申込者へ LINE でまとめて送ります（送ったお知らせは取り消せません）">
          <div className={styles.field}><Field label="申込者へ送るメッセージ" htmlFor="ev-bk-message"><div className={styles.broadcastRow}>
              <SaveErrorField names={["broadcastMessage","messageContent","broadcast_message"]}><TextField
                className={styles.messageInput}
                id="ev-bk-message"
                value={broadcastMessage}
                readOnly={!canBroadcast || Boolean(broadcastLockReason)}
                onChange={(e) => setBroadcastMessage(e.target.value)}
                placeholder="当日は動きやすい服装でお越しください"
              /></SaveErrorField>
              <Button onClick={() => void previewBroadcast()} lockedReason={broadcastLockReason} disabled={!canBroadcast || broadcastBusy || broadcastMessage.trim() === ''} title={broadcastMessage.trim() === '' ? 'メッセージを入力してください' : undefined} busy={broadcastBusy} busyLabel="確認中…">
                <Send size={16} aria-hidden="true" />送る
              </Button>
            </div></Field></div>
          {broadcastError ? <Notice tone="danger" >{broadcastError}</Notice> : null}
        </EventRosterCard>
      {selectedOccurrenceId ? <BookingRecords accountId={selectedAccountId} eventId={eventId} occurrenceId={selectedOccurrenceId} questionsJson={event?.questions_json} revision={`${applicants?.snapshotId}:${recordsRevision}`} renderActions={(booking) => {
        const row: EventOccurrenceApplicant = {
          source: 'booking', id: booking.id, friendId: booking.friend_id,
          displayName: booking.friend_display_name ?? booking.friend_name ?? null,
          pictureUrl: null, status: booking.status, partySize: 1 + (booking.companion_count ?? 0),
          appliedAt: booking.requested_at ?? booking.created_at ?? '', answers: null,
          firstParticipation: { isFirst: booking.is_first_time == null ? null : booking.is_first_time === 1, attendedCount: null, checkedAt: null },
          offeredAt: null, offerExpiresAt: null,
        }
        return <>{['requested', 'confirmed'].includes(booking.status) ? absenceAction(booking.id, booking.friend_display_name ?? booking.friend_name ?? '申込者', booking.slot_starts_at) : null}{booking.status === 'confirmed' ? <span className={styles.recordsActions}>
          <Button data-booking-id={booking.id} data-booking-action="attended" variant="primary" onClick={() => void markStatus(row, 'attended')} lockedReason={bookingLockReason} disabled={!canChangeBookings || marking.has(booking.id)}><Check size={16} aria-hidden="true" />参加済にする</Button>
          <RowMenu label={`${withHonorific(booking.friend_display_name ?? booking.friend_name ?? '申込者')}の操作`} triggerProps={{ 'data-booking-id': booking.id, 'data-booking-action': 'menu' }} items={[
            { id: 'no-show', lockedReason: bookingLockReason, label: '無断', onSelect: () => void markStatus(row, 'no_show'), disabled: !canChangeBookings || marking.has(booking.id), disabledReason: marking.has(booking.id) ? '処理を反映しています' : undefined },
            { id: 'cancel', lockedReason: bookingLockReason, label: 'キャンセルにする', onSelect: () => { setCancelError(''); setCancelApplicant({ applicant: row, accountId: selectedAccountId }) }, disabled: !canChangeBookings || busy, disabledReason: busy ? '処理を反映しています' : undefined },
          ]} />
        </span> : booking.status === 'requested' ? <span className={styles.recordsActions}>
          <Button variant="primary" onClick={() => void decide(row, 'confirm')} lockedReason={bookingLockReason} disabled={!canChangeBookings || busy}>承認する</Button>
          <RowMenu label={`${withHonorific(booking.friend_display_name ?? booking.friend_name ?? '申込者')}の操作`} triggerProps={{ 'data-booking-id': booking.id, 'data-booking-action': 'menu' }} items={[{ id: 'reject', lockedReason: bookingLockReason, label: '断る', onSelect: () => { setRejectReason(''); setRejectError(''); if (selectedAccountId) setRejectApplicant({ applicant: row, accountId: selectedAccountId }) }, disabled: !canChangeBookings || busy, disabledReason: busy ? '処理を反映しています' : undefined }]} />
        </span> : null}</>
      }}>
        {ready ? <>
          <p>{`申込 ${confirmedSeats + requestedSeats}人（確定 ${confirmedSeats}人・承認待ち ${requestedSeats}人）・キャンセル待ち ${waitingSeats}人・案内中 ${offeredSeats}人 / ${capacity === null ? '定員の上限なし' : occurrence && occurrence.activeSeats >= capacity ? `満席（定員 ${capacity}人）` : `残席 ${Math.max(0, capacity - (occurrence?.activeSeats ?? 0))}席（定員 ${capacity}人）`}`}</p>
          {attendance ? attendance.entries.length ? <EventRosterTable kind="cancel" label="当日の受付記録" headings={['友だち', '結果', '記録日時']}>
            {attendance.entries.map((entry) => <EventRosterRow key={entry.id}>
              <span role="cell" className={styles.cellName}>{entry.displayName ?? '友だちは未取得'}</span>
              <span role="cell">{chip(entry.status)}</span>
              <span role="cell" className={styles.cellText}>{jstShort(entry.markedAt)}</span>
            </EventRosterRow>)}
          </EventRosterTable> : null : <p>受付の記録はまだ読み込めていません。</p>}
          {applicants?.waitlistHistory === undefined ? <p>履歴はまだ読み込めていません。</p> : null}
          {rows.filter((row) => row.source === 'waitlist').map((row) => <Field key={row.id} label={row.displayName ?? '友だちは未取得'}>
            <Button href={`/chats?friend=${encodeURIComponent(row.friendId)}`}>個別トーク</Button>
            {row.status === 'waiting' ? <Button onClick={() => {
              setWaitlistReason(''); setWaitlistError(''); setWaitlistDialog({ kind: 'skip', waitlistId: row.id, name: row.displayName ?? '待機中の方' })
            }} lockedReason={bookingLockReason} disabled={!canChangeBookings || waitlistBusy}>見送る</Button> : null}
          </Field>)}
        </> : null}
      </BookingRecords> : null}
      </div>

      {absence.dialog}
      <ConfirmDialog
        key={`cancel:${operationScope}`}
        open={cancelApplicant !== null}
        destructive
        title={`「${cancelApplicant?.applicant.displayName ?? '友だちは未取得'}」の予約をキャンセルしますか？`}
        description="友だちへLINEでお知らせが届き、枠が空きます。空いた枠はキャンセル待ちの方へ回ります。この予約の通知予定も停止し、送信済みの記録は残ります。送ったお知らせは取り消せません。この操作は元に戻せません。"
        confirmLabel="キャンセルする"
        busy={cancelling}
        error={cancelError}
        onConfirm={() => runAdminCancel()}
        onCancel={() => {
          if (cancelling) return
          setCancelError('')
          setCancelApplicant(null)
        }}
      >
        {cancelApplicant ? <OperationTargetSummary accounts={[{ id: cancelApplicant.accountId }]} /> : null}
      </ConfirmDialog>

      <ConfirmDialog
        key={`reject:${operationScope}`}
        open={rejectApplicant !== null}
        destructive
        title={`「${rejectApplicant?.applicant.displayName ?? '友だちは未取得'}」の申込を断りますか？`}
        description="理由は内部にだけ残り、友だちには送りません。友だちには決まったお知らせの文が届き、断ると枠が空きます。"
        confirmLabel="断る"
        busy={busy}
        error={rejectError}
        onConfirm={() => rejectApplicant && rejectApplicant.accountId === selectedAccountId && void decide(rejectApplicant.applicant, 'reject')}
        onCancel={() => {
          if (busy) return
          setRejectError('')
          setRejectReason('')
          setRejectApplicant(null)
        }}
      >
        {rejectApplicant ? <OperationTargetSummary accounts={[{ id: rejectApplicant.accountId }]} /> : null}
        {rejectApplicant ? (
          <Field label="断る理由（・内部メモ）"><SaveErrorField names={["rejectReason","reject_reason"]}><TextArea
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              rows={2}
            /></SaveErrorField></Field>
        ) : null}
      </ConfirmDialog>

      <ConfirmDialog
        key={`waitlist:${operationScope}`}
        open={waitlistDialog !== null}
        title={
          waitlistDialog?.kind === 'promote'
            ? '次の方へ案内しますか？'
            : waitlistDialog?.kind === 'reorder'
              ? '待ち順を変えますか？'
              : '最後尾へ回しますか？'
        }
        description={
          waitlistDialog?.kind === 'promote'
            ? '先頭の方へ期限つきの案内を送ります。理由は変更の記録に残ります。'
            : waitlistDialog?.kind === 'reorder'
              ? `${waitlistDialog.description}理由は変更の記録に残ります。`
              : '行は消さず、次回の案内では後回しになります。理由は変更の記録に残ります。'
        }
        confirmLabel={waitlistDialog?.kind === 'reorder' ? '入れ替える' : '実行する'}
        busy={waitlistBusy}
        confirmDisabled={waitlistReason.trim() === ''}
        error={waitlistError}
        onConfirm={() => runWaitlistOperation()}
        onCancel={() => {
          if (waitlistBusy) return
          setWaitlistError('')
          setWaitlistReason('')
          setWaitlistDialog(null)
        }}
      >
        {waitlistDialog && waitlistAccount ? <OperationTargetSummary accounts={[{ id: waitlistAccount }]} /> : null}
        {waitlistDialog ? (
          <>
            {waitlistDialog.kind === 'reorder' ? (
              <div className={styles.dialogButtons}>
                <Button
                  size="compact"
                  onClick={() => {
                    const waiting = rows.filter((row) => row.source === 'waitlist' && row.status === 'waiting')
                    const index = waiting.findIndex((row) => row.id === waitlistDialog.applicantId)
                    const other = waiting[index - 1]
                    const current = waiting[index]
                    if (current && other) {
                      setWaitlistDialog({
                        kind: 'reorder',
                        applicantId: waitlistDialog.applicantId,
                        direction: -1,
                        description: `「${current.displayName ?? '待機中の方'}」と「${other.displayName ?? '待機中の方'}」の順番を入れ替えます。`,
                      })
                    }
                  }}
                >
                  上へ
                </Button>
                <Button
                  size="compact"
                  onClick={() => {
                    const waiting = rows.filter((row) => row.source === 'waitlist' && row.status === 'waiting')
                    const index = waiting.findIndex((row) => row.id === waitlistDialog.applicantId)
                    const other = waiting[index + 1]
                    const current = waiting[index]
                    if (current && other) {
                      setWaitlistDialog({
                        kind: 'reorder',
                        applicantId: waitlistDialog.applicantId,
                        direction: 1,
                        description: `「${current.displayName ?? '待機中の方'}」と「${other.displayName ?? '待機中の方'}」の順番を入れ替えます。`,
                      })
                    }
                  }}
                >
                  下へ
                </Button>
              </div>
            ) : null}
            <Field label="理由（・記録に残ります）" required><SaveErrorField names={["waitlistReason","reason","waitlist_reason"]}><TextArea
                value={waitlistReason}
                onChange={(e) => setWaitlistReason(e.target.value)}
                rows={2}
              /></SaveErrorField></Field>
          </>
        ) : null}
      </ConfirmDialog>

      <ConfirmDialog
        key={`broadcast:${operationScope}`}
        open={broadcastConfirmOpen && broadcastPreview !== null}
        title={`${broadcastPreview?.recipientCount ?? 0} 人に送りますか？`}
        description="この回の申込者へLINEでまとめて送ります。送ったお知らせは取り消せません。"
        confirmLabel="送る"
        busy={broadcastBusy}
        error={broadcastError}
        onConfirm={() => sendBroadcast()}
        onCancel={() => {
          if (broadcastBusy) return
          setBroadcastError('')
          setBroadcastConfirmOpen(false)
        }}
      >
        {broadcastPreview ? <OperationTargetSummary accounts={[{ id: broadcastPreview.accountId }]} /> : null}
      </ConfirmDialog>
    </DetailPage></SaveErrorScope>
  )
}
