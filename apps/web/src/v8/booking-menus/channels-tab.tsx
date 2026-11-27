'use client'
import { formatDate as polishFormatDate, formatNumber } from '@/lib/format'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fetchApi } from '@/lib/api'
import Button from '@/components/shared/button'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import Card, { CardHeader } from '@/components/shared/card'
import Dialog from '@/components/shared/dialog'
import ListState from '@/components/shared/list-state'
import NoteBar from '@/components/shared/note-bar'
import Select from '@/components/shared/select'
import { TextField } from '@/components/shared/text-field'
import Toggle from '@/components/shared/toggle'
import { notifyToast } from '@/components/shared/toast'
import { describeApiFailure } from '@/components/shared/api-error-message'
import { bookingChannelsApi, type BookingChannelStaff, type BookingChannelsData, type BookingConflict } from './lib/booking-channels'
import type { BookingStaff } from '@/lib/api'
import styles from './settings.module.css'
import ch from './channels.module.css'
import { emptyValue } from '@/components/shared/empty-value'
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import EntitySelect, { entityOptionMetadata } from '@/components/shared/entity-select'
import Notice from '@/components/shared/notice'
import type { ChannelsSummary } from './channels-summary'
import ChannelsTables, { StaffStatusChip, formatReadAt } from './channels-tables'
import { withHonorific } from '@line-crm/shared'
type LoadStatus = 'loading' | 'ready' | 'error'
function formatConflictRange(conflict: BookingConflict): string {
  const day = polishFormatDate(conflict.startsAt, { style: 'day', fallback: '' })
  return day ? `${withHonorific(conflict.staffName)}の ${day} ${formatConflictTime(conflict.startsAt)}` : ''
}

function formatConflictTime(value: string): string {
  return polishFormatDate(value, { style: 'time' })
}

/** つながっているカレンダーの中身（「予定を見る」）。つなぎ直す口もここに置く。 */
function CalendarDetailDialog({
  staff,
  calendarId,
  canEdit,
  onClose,
  onReconnect,
}: {
  staff: BookingChannelStaff
  calendarId: string
  canEdit: boolean
  onClose: () => void
  onReconnect: () => void
}) {
  return (
    <Dialog
      open
      title={`${staff.displayName}の Google カレンダー`}
      description="カレンダーの予定は「埋まっている時間」として扱います。"
      confirmLabel="つなぎ直す"
      onConfirm={canEdit ? onReconnect : undefined}
      onCancel={onClose}
    >
      <dl className={ch.detail}>
        <div className={ch.detailRow}><dt className={ch.detailKey}>カレンダー</dt><dd className={ch.detailValue}>{calendarId || emptyValue('unknown')}</dd></div>
        <div className={ch.detailRow}><dt className={ch.detailKey}>状態</dt><dd className={ch.detailValue}><StaffStatusChip status={staff.status} /></dd></div>
        <div className={ch.detailRow}><dt className={ch.detailKey}>外の予定（今週）</dt><dd className={ch.detailValue}>{staff.externalEventsThisWeek == null ? emptyValue('unknown') : `${staff.externalEventsThisWeek}件`}</dd></div>
        <div className={ch.detailRow}><dt className={ch.detailKey}>最後に読んだ</dt><dd className={ch.detailValue}>{formatReadAt(staff.lastReadAt)}</dd></div>
        {staff.readError ? <div className={ch.detailRow}><dt className={ch.detailKey}>読めなかった理由</dt><dd className={ch.detailValue}>{staff.readError}</dd></div> : null}
      </dl>
    </Dialog>
  )
}

/** Google カレンダーをつなぐ窓（カレンダー ID を入れて確かめる）。 */
function ConnectDialog({
  accountId,
  staff,
  onClose,
  onDone,
}: {
  accountId: string
  staff: BookingChannelStaff
  onClose: () => void
  onDone: () => void
}) {
  const saveErrors = useSaveFormErrors()

  const [calendarId, setCalendarId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const save = async () => {
    const id = calendarId.trim()
    if (!id) {
      setError('カレンダーの ID を入れてください。')
      return
    }
    setBusy(true)
    setError('')
    try {
      await bookingChannelsApi.connectCalendar(accountId, staff.staffId, id)
      notifyToast(`${staff.displayName}の Google カレンダーをつなぎました。`)
      onDone()
    } catch (e) {
      const fieldFailure = saveErrors.capture(e)

      { if (!fieldFailure)

      setError(describeApiFailure(e, 'つなげませんでした。ID を確かめてやり直してください。')) }
    } finally {
      setBusy(false)
    }
  }
  return (
    <SaveErrorScope errors={saveErrors}><Dialog
      open
      title={`${staff.displayName}の Google カレンダーをつなぐ`}
      description="Google カレンダーの ID（メールアドレスの形）を入れると、その予定を「埋まっている時間」として扱います。"
      confirmLabel="つないで確かめる"
      cancelLabel="やめる"
      busy={busy}
      error={error || undefined}
      onConfirm={() => save()}
      onCancel={onClose}
    >
      <SaveErrorField names={["calendarId","calendar_id"]}><TextField aria-label="カレンダーの ID" value={calendarId} onChange={(e) => setCalendarId(e.target.value)} placeholder="例：shop@example.com" /></SaveErrorField>
    </Dialog></SaveErrorScope>
  )
}

/** 予約が重なったときの知らせ。移す先を選び、移して知らせる。 */
export function ConflictDialog({
  canEdit = true,
  accountId,
  conflict,
  staff,
  onClose,
  onDone,
}: {
  canEdit?: boolean
  accountId: string
  conflict: BookingConflict
  staff: BookingChannelStaff[]
  onClose: () => void
  onDone: () => void
}) {
  const scopeKey = JSON.stringify([accountId, conflict.bookingId])
  const scope = useRef({ key: scopeKey })
  if (scope.current.key !== scopeKey) scope.current = { key: scopeKey }
  const openedScope = useRef(scope.current)
  const currentScope = openedScope.current === scope.current
  const targets = useMemo(() => staff.filter((s) => s.staffId !== conflict.staffId), [staff, conflict.staffId])
  const [targetId, setTargetId] = useState(targets[0]?.staffId ?? '')
  const [notify, setNotify] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const targetName = targets.find((t) => t.staffId === targetId)?.displayName ?? ''
  const move = async () => {
    if (!canEdit || busy || openedScope.current !== scope.current) return
    const requestScope = scope.current
    if (!targetId) {
      setError('移す先のスタッフを選んでください。')
      return
    }
    setBusy(true)
    setError('')
    try {
      await bookingChannelsApi.reassign(accountId, conflict.bookingId, { staffId: targetId, notifyCustomer: notify })
      if (requestScope !== scope.current) return
      notifyToast(notify ? `${targetName}へ移して知らせました。` : `${targetName}へ移しました。`)
      onDone()
    } catch (e) {
      if (requestScope !== scope.current) return
      setError(`${describeApiFailure(e, '予約の移動')} 空きを確かめてやり直してください。`)
    } finally {
      if (requestScope === scope.current) setBusy(false)
    }
  }
  return (
    <div data-design-node="DFl3Q">
      <Dialog
        open={currentScope}
        designNode="DFl3Q"
        designWidth={560}
        designTop={200}
        title={`${formatConflictRange(conflict)}に予約が重なりました`}
        confirmLabel={notify ? '移して知らせる' : '移す'}
        cancelLabel="あとで"
        busy={busy}
        error={error || undefined}
        onConfirm={canEdit ? () => move() : undefined}
        onCancel={onClose}
      >
        <OperationTargetSummary accounts={[{ id: accountId }]} />
        {conflict.bookings?.length ? (
          <div className={ch.detail}>
            {conflict.bookings.map((booking, index) => (
              <p key={booking.bookingId} className={ch.conflictBooking}>
                {index === 0 ? '①' : '②'} {booking.sourceLabel}・{withHonorific(booking.customerName)}・{booking.menuName}・{formatConflictTime(booking.startsAt)}〜{formatConflictTime(booking.endsAt)}
              </p>
            ))}
          </div>
        ) : null}
        {conflict.reason ? <p className={ch.conflictReason}>{conflict.reason}</p> : null}
        {canEdit ? <>
        <p className={ch.conflictLabel}>①の予約を移す先のスタッフ</p>
        <SaveErrorField names={["targetId","staffId","target_id"]}><EntitySelect
          aria-label="移す先のスタッフ"
          size="full"
          disabled={busy}
          value={targetId}
          onChange={setTargetId}
          options={[
            { value: '', label: '移す先を選ぶ' },
            ...targets.map((t) => ({ ...entityOptionMetadata(t), value: t.staffId, label: `${t.displayName}へ移す` })),
          ]}
        /></SaveErrorField>
        <div className={ch.detailRow}>
          <SaveErrorField names={["notify","notifyCustomer"]}><Toggle label="移したことを、お客さまに知らせる" checked={notify} disabled={busy} onChange={setNotify} /></SaveErrorField>
          <span className={ch.conflictReason}>移したことを、お客さまに知らせる（LINE の友だちなら LINE、そうでなければ電話の案内を出す）</span>
        </div>
        </> : null}
        {conflict.guidance ? <NoteBar tone="warn">{conflict.guidance}</NoteBar> : null}
      </Dialog>
    </div>
  )
}

/** 予約経路の連携タブ。スタッフの Google カレンダーと予約経路の一覧。 */
export default function ChannelsTabV8({ accountId, canEdit, staff = [], onSummaryChange }: { accountId: string; canEdit: boolean; staff?: BookingStaff[]; onSummaryChange?: (summary: ChannelsSummary) => void }) {
  const saveErrors = useSaveFormErrors()

  const [status, setStatus] = useState<LoadStatus>('loading')
  const [error, setError] = useState('')
  const [data, setData] = useState<BookingChannelsData | null>(null)
  const loadedAccountId = useRef('')
  const [calendars, setCalendars] = useState<Record<string, string>>({})
  const [conflicts, setConflicts] = useState<BookingConflict[]>([])
  const [conflictsError, setConflictsError] = useState(false)
  const [calendarDetailsError, setCalendarDetailsError] = useState(false)
  const [reloading, setReloading] = useState(false)
  const [connectTarget, setConnectTarget] = useState<BookingChannelStaff | null>(null)
  const [detailTarget, setDetailTarget] = useState<BookingChannelStaff | null>(null)
  const [conflictOpen, setConflictOpen] = useState(false)
  const [savingAssign, setSavingAssign] = useState(false)
  const [assignError, setAssignError] = useState('')
  const assignBusy = useRef(false)
  const loadInFlightRef = useRef(false)
  const latestAccountId = useRef(accountId)
  latestAccountId.current = accountId
  /* 名前の下の1行（役割）。予約設定の担当スタッフと同じ人だけ出す。 */
  const roles = useMemo(() => Object.fromEntries(staff.map((person) => [person.id, person.role ?? ''])), [staff])

  async function saveAutoAssign(next: boolean) {
    if (!canEdit || assignBusy.current || !data) return
    assignBusy.current = true
    setSavingAssign(true)
    setAssignError('')
    try {
      await fetchApi(
        `/api/booking/admin/channels/settings?account_id=${encodeURIComponent(accountId)}`,
        { method: 'PUT', body: JSON.stringify({ autoAssign: next }) },
      )
      if (latestAccountId.current !== accountId) return
      setData((current) => current ? { ...current, autoAssign: next } : current)
      notifyToast(next ? '自動割り当てを入れました。' : '自動割り当てを止めました。')
    } catch (e) {
      const fieldFailure = saveErrors.capture(e);

      if (latestAccountId.current === accountId) {
        { if (!fieldFailure)
        setAssignError(describeApiFailure(e, '自動割り当てを保存できませんでした。')) }
      }
    } finally {
      assignBusy.current = false
      setSavingAssign(false)
    }
  }
  /* WEB058：アカウントを変えたら、前のアカウントの遅い応答（一覧・重なり・カレンダー）を捨てる。 */
  const loadGeneration = useRef(0)
  useEffect(() => {
    setData(null)
    setCalendars({})
    setConflicts([])
    setConflictsError(false)
    setCalendarDetailsError(false)
    setConflictOpen(false)
    loadInFlightRef.current = false
    return () => {
      loadGeneration.current += 1
      loadInFlightRef.current = false
    }
  }, [accountId])

  const load = useCallback(async (options?: { force?: boolean; keepVisible?: boolean }) => {
    if (!options?.force && loadInFlightRef.current) return
    const generation = ++loadGeneration.current
    const alive = () => generation === loadGeneration.current
    loadInFlightRef.current = true
    setReloading(true)
    if (!options?.keepVisible) setStatus('loading')
    setError('')
    try {
      const [channelsResult, conflictsResult] = await Promise.allSettled([
        bookingChannelsApi.channels(accountId),
        bookingChannelsApi.conflicts(accountId),
      ])
      if (!alive()) return
      if (channelsResult.status !== 'fulfilled') throw channelsResult.reason
      if (!channelsResult.value.success) throw new Error(channelsResult.value.error)
      loadedAccountId.current = accountId
      setData(channelsResult.value.data)
      if (conflictsResult.status === 'fulfilled' && conflictsResult.value.success) {
        setConflicts(conflictsResult.value.data.conflicts)
        setConflictsError(false)
      } else {
        setConflicts([])
        setConflictsError(true)
      }
      setStatus('ready')
      // つながっている分だけカレンダーの ID を読む（失敗しても表は出し、案内で知らせる）。
      const linked = channelsResult.value.data.staff.filter((s) => s.status !== 'not_connected')
      let anyDetailFailed = false
      const details = await Promise.all(linked.map(async (s) => {
        try {
          const d = await bookingChannelsApi.calendarDetail(accountId, s.staffId)
          return [s.staffId, d?.connection?.calendar_id ?? ''] as const
        } catch {
          anyDetailFailed = true
          return [s.staffId, ''] as const
        }
      }))

      if (!alive()) return
      setCalendars(Object.fromEntries(details.filter(([, id]) => id)))
      setCalendarDetailsError(anyDetailFailed)
    } catch (e) {
      if (!alive()) return
      const fieldFailure = saveErrors.capture(e)
      { if (!fieldFailure)

      setError(describeApiFailure(e, '予約経路の読み込み')) }
      setStatus('error')
    } finally {
      if (alive()) {
        loadInFlightRef.current = false
        setReloading(false)
      }
    }
  }, [accountId, saveErrors])

  useEffect(() => {
    void load({ force: true })
  }, [load])

  useEffect(() => {
    onSummaryChange?.({
      accountId: data ? loadedAccountId.current : accountId,
      status,
      data,
      conflicts: conflictsError ? null : conflicts.length,
    })
  }, [accountId, status, data, conflicts.length, conflictsError, onSummaryChange])

  const firstConflict = conflicts[0] ?? null

  if (status === 'loading') return <SaveErrorScope errors={saveErrors}><ListState kind="loading" /></SaveErrorScope>
  if (status === 'error' || !data) {
    return <SaveErrorScope errors={saveErrors}><ListState kind="error" title="予約経路を読み込めませんでした" description={error} onRetry={() => void load()} /></SaveErrorScope>
  }

  return (
    <SaveErrorScope errors={saveErrors}><div className={styles.tabStack}>
      {firstConflict ? (
        <NoteBar tone="warn">
          予約が {formatNumber(conflicts.length)} 件重なっています。
          {/* WEB059：閲覧のみには、付け替え（書き込み）へ進む口を置かない。重なりの知らせは出す。 */}
          <Button size="compact" onClick={() => setConflictOpen(true)}>{canEdit ? '重なりを解消する' : '重なりを見る'}</Button>
        </NoteBar>
      ) : null}
      {conflictsError ? (
        <Notice tone="info" action={<Button onClick={() => void load({ keepVisible: true })} disabled={reloading} busy={reloading} busyLabel="読み込み中…">もう一度読み込む</Button>}>
          予約の重なりを確認できませんでした。もう一度読み込むと最新の状態を確認できます。
        </Notice>
      ) : null}
      {calendarDetailsError ? (
        <Notice tone="info" action={<Button onClick={() => void load({ keepVisible: true })} disabled={reloading} busy={reloading} busyLabel="読み込み中…">もう一度読み込む</Button>}>
          一部のカレンダー詳細を読み込めませんでした。もう一度読み込むと最新の状態を確認できます。
        </Notice>
      ) : null}

      <ChannelsTables data={data} canEdit={canEdit} roles={roles} calendars={calendars} onDetail={setDetailTarget} onConnect={setConnectTarget} />

      <Card padding="roomy" layout="vertical" gap="normal" data-design-node="wJYQb" aria-labelledby="channels-assign-heading">
        <CardHeader size="content" titleId="channels-assign-heading" title="外から予約が入ったとき" />
        {canEdit ? (
          <fieldset disabled={savingAssign} className={styles.ruleLine}>
            <span className={styles.ruleLineLabel}>指名なしの予約は、その時間に空いているスタッフへ自動で割り当て</span>
            <SaveErrorField names={["autoAssign","data.autoAssign","auto_assign","data.auto_assign"]}><Toggle
              label="指名なしの予約は、その時間に空いているスタッフへ自動で割り当て"
              checked={data.autoAssign}
              onChange={(next) => void saveAutoAssign(next)}
            /></SaveErrorField>
          </fieldset>
        ) : (
          // 閲覧のみ：つまみは置かず、いまの設定を文字で見せる（2026-10-06 オーナー決定）。
          <p className={styles.ruleLine}>
            <span className={styles.ruleLineLabel}>指名なしの予約は、その時間に空いているスタッフへ自動で割り当て</span>
            <span className={ch.cardDesc}>{data.autoAssign ? 'オン' : 'オフ'}</span>
          </p>
        )}
        {assignError ? <Notice tone="danger" className={ch.cardDescNoticePlacement} >{assignError}</Notice> : null}
      </Card>

      {detailTarget ? (
        <CalendarDetailDialog
          staff={detailTarget}
          calendarId={calendars[detailTarget.staffId] ?? ''}
          canEdit={canEdit}
          onClose={() => setDetailTarget(null)}
          onReconnect={() => { setConnectTarget(detailTarget); setDetailTarget(null) }}
        />
      ) : null}
      {connectTarget ? (
        <ConnectDialog accountId={accountId} staff={connectTarget} onClose={() => setConnectTarget(null)} onDone={() => { setConnectTarget(null); void load({ force: true }) }} />
      ) : null}
      {conflictOpen && firstConflict ? (
        <ConflictDialog canEdit={canEdit} accountId={accountId} conflict={firstConflict} staff={data.staff} onClose={() => setConflictOpen(false)} onDone={() => { setConflictOpen(false); void load({ force: true }) }} />
      ) : null}
    </div></SaveErrorScope>
  )
}
