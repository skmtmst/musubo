'use client'
import { jstDate } from '@/lib/jst-datetime'
import { closedOn, closedRanges } from '../lib/closed-ranges'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react'
import Card from '@/components/shared/card'
import Button from '@/components/shared/button'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import Dialog from '@/components/shared/dialog'
import DateField from '@/components/shared/date-field'
import { ApiError, bookingApi, type BookingException, type BookingSettings } from '@/lib/api'
import { AccountIcon, StateCard, SkeletonRows, WEEKDAY_JP, addDaysStr, useV8TabEdit, type LoadStatus } from './shared'
import styles from '../settings.module.css'
import { Field } from '@/components/shared/form-controls'
import { requiredText, optionalText } from '@/lib/form-requirement'
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import HolidayBookings from './holiday-bookings'
import Notice from '@/components/shared/notice'
import { usePermissionLockReason } from '@/components/shared/use-permission-lock-reason'
import { TextField as SharedTextField } from '@/components/shared/text-field'

/* ③ 休業日（settings-v8.tsx から分割。見た目・動きは変えない） */

function monthWeeks(month: string): string[][] {
  const first = new Date(`${month}-01T00:00:00Z`)
  const start = addDaysStr(`${month}-01`, -first.getUTCDay())
  const weeks: string[][] = []
  let cursor = start
  while (cursor.slice(0, 7) <= month) {
    const week = Array.from({ length: 7 }, (_, i) => addDaysStr(cursor, i))
    weeks.push(week)
    cursor = addDaysStr(cursor, 7)
  }
  return weeks
}

function shiftMonth(month: string, delta: number): string {
  const d = new Date(`${month}-01T00:00:00Z`)
  d.setUTCMonth(d.getUTCMonth() + delta)
  return d.toISOString().slice(0, 7)
}

function jpDate(date: string): string {
  const d = new Date(`${date}T00:00:00Z`)
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}（${WEEKDAY_JP[d.getUTCDay()]}）`
}

const holidayRequirements = {
  from: requiredText('開始日を入れてください。'),
  to: requiredText('終了日を入れてください。'),
  reason: optionalText,
}

export function HolidaysTabV8({ accountId, settings, status, error, exceptions, closedWeekdays, bookingCountOnClosed, canEdit, onSaved, onReload }: {
  accountId: string
  settings: BookingSettings | null
  status: LoadStatus
  error: string | null
  exceptions: BookingException[]
  closedWeekdays: number[]
  /** 休みにした日に入っている予約の件数。null は未集計。 */
  bookingCountOnClosed: number | null
  canEdit: boolean
  onSaved: (settings: BookingSettings) => void
  onReload: () => void
}) {
  const lockedReason = usePermissionLockReason(canEdit)
  const saveErrors = useSaveFormErrors()
  const today = useMemo(() => jstDate(), [])
  const [month, setMonth] = useState(today.slice(0, 7))
  const [editing, setEditing] = useState<BookingException | 'new' | null>(null)
  const [selectedDate, setSelectedDate] = useState('')
  const [editFrom, setEditFrom] = useState('')
  const [editTo, setEditTo] = useState('')
  const [editReason, setEditReason] = useState('')
  const [dateErrors, setDateErrors] = useState<{ from?: string; to?: string }>({})
  const [editError, setEditError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<BookingException | null>(null)
  const [deleteScope, setDeleteScope] = useState<{ accountId: string; generation: number } | null>(null)
  const scope = useRef({ accountId, generation: 0 })
  if (scope.current.accountId !== accountId) scope.current = { accountId, generation: scope.current.generation + 1 }
  const renderedScope = scope.current
  const canEditRef = useRef(canEdit)
  canEditRef.current = canEdit
  const alive = useRef(false)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  /* WEB055：削除の失敗は、開いている削除の確認の中に出す（閉じた編集の窓へ書かない）。 */
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const inFlightRef = useRef(false)

  const closedExceptions = useMemo(
    () => exceptions.filter((item) => item.kind === 'closed').sort((a, b) => (a.dateFrom || '').localeCompare(b.dateFrom || '')),
    [exceptions],
  )
  /* WEB056：日付 → 例外。範囲を日ごとに広げず（31日で打ち切らず）、範囲で調べる。 */
  const ranges = useMemo(() => closedRanges(closedExceptions), [closedExceptions])
  const closedDow = new Set(closedWeekdays)

  /* 窓の中の書きかけがある間は離脱確認だけ（保存帯は出さない）。 */
  const dialogDirty = editing !== null && (editFrom !== '' || editReason.trim() !== '')
  useV8TabEdit({
    dirty: dialogDirty,
    saving: busy,
    subject: '休業日への変更',
    showBar: false,
    onSave: () => {},
    onReset: () => setEditing(null),
  })

  function openNew(date?: string) {
    if (!canEdit) return
    setSelectedDate(date ?? '')
    setEditing('new')
    setEditFrom(date ?? '')
    setEditTo(date ?? '')
    setEditReason('')
    setEditError(null)
    setDateErrors({})
  }
  function openEdit(item: BookingException, date?: string) {
    setSelectedDate(date ?? (item.dateFrom || item.date || ''))
    setEditing(item)
    setEditFrom(item.dateFrom || item.date || '')
    setEditTo(item.dateTo || item.date || '')
    setEditReason(item.reason ?? item.note ?? '')
    setEditError(null)
    setDateErrors({})
  }

  async function save() {
    if (inFlightRef.current) return
    const from = holidayRequirements.from.check(editFrom) ?? undefined
    const to = holidayRequirements.to.check(editTo) ?? (editFrom && editTo < editFrom ? '終了日は開始日以降にしてください。' : undefined)
    setDateErrors({ from, to })
    if (from || to) return
    inFlightRef.current = true
    setBusy(true)
    setEditError(null)
    try {
      if (editing === 'new') {
        const response = await bookingApi.createException(accountId, {
          scopeKind: 'store',
          dateFrom: editFrom,
          dateTo: editTo,
          kind: 'closed',
          intervals: [],
          reason: editReason.trim() || null,
        })
        if (!response.success) throw new Error(response.error)
        if (settings) onSaved({ ...settings, exceptions: [...settings.exceptions, response.data] })
      } else if (editing) {
        const response = await bookingApi.updateException(accountId, editing.id, {
          expectedVersion: editing.version,
          dateFrom: editFrom,
          dateTo: editTo,
          reason: editReason.trim() || null,
        })
        if (!response.success) throw new Error(response.error)
        if (settings) onSaved({ ...settings, exceptions: settings.exceptions.map((entry) => entry.id === editing.id ? response.data : entry) })
      }
      setEditing(null)
    } catch (cause) {
      const fieldFailure = saveErrors.capture(cause)

      { if (!fieldFailure)
      setEditError(exceptionFailureMessage(cause, '保存')) }
    } finally {
      inFlightRef.current = false
      setBusy(false)
    }
  }

  async function remove() {
    const target = deleteTarget
    if (!target || !deleteScope || !alive.current || !canEditRef.current || deleteScope.generation !== scope.current.generation || target.lineAccountId !== deleteScope.accountId || inFlightRef.current) return
    inFlightRef.current = true
    setBusy(true)
    try {
      await bookingApi.deleteException(deleteScope.accountId, target.id, target.version)
      if (!alive.current || deleteScope.generation !== scope.current.generation) return
      if (settings) onSaved({ ...settings, exceptions: settings.exceptions.filter((entry) => entry.id !== target.id) })
      setDeleteTarget(null)
      setEditing(null)
    } catch (cause) {
      if (!alive.current || !deleteScope || deleteScope.generation !== scope.current.generation) return
      const fieldFailure = saveErrors.capture(cause)

      { if (!fieldFailure)
      setDeleteError(exceptionFailureMessage(cause, '削除')) }
      // 先に変えられていた（409）ときは、今の休業日を読み直す。確認の窓は開いたまま。
      if (cause instanceof ApiError && cause.status === 409) onReload()
    } finally {
      inFlightRef.current = false
      setBusy(false)
    }
  }

  if (status === 'loading') return <SaveErrorScope errors={saveErrors}><SkeletonRows rows={6} /></SaveErrorScope>
  if (status === 'error' || !settings) {
    return (
      <SaveErrorScope errors={saveErrors}><StateCard
        icon={<AccountIcon />}
        title="休業日を読み込めませんでした"
        description={error ?? '通信状態を確認して、もう一度お試しください。'}
        action={<Button onClick={onReload}>もう一度読み込む</Button>}
      /></SaveErrorScope>
    )
  }

  const weeks = monthWeeks(month)
  const monthLabel = `${Number(month.slice(0, 4))}年${Number(month.slice(5, 7))}月`
  const reviewDate = selectedDate >= editFrom && selectedDate <= editTo ? selectedDate : editFrom

  return (
    <SaveErrorScope errors={saveErrors}><div className={styles.tabStack} data-design="Special">
      <Card layout="vertical" padding="roomy" gap="normal">
        <div className={styles.sectionHead}>
          <h2 className={styles.sectionTitle}>{monthLabel}</h2>
          <p className={styles.sectionDesc}>{canEdit ? '日にちを押すと休みにできます。' : ''}定休日（毎週）は受付枠で決めます</p>
        </div>
        <div className={styles.calNav}>
          <button type="button" className={styles.calNavButton} aria-label="前の月" onClick={() => setMonth(shiftMonth(month, -1))}><ChevronLeft size={16} aria-hidden="true" /></button>
          <span className={styles.calMonth}>{monthLabel}</span>
          <button type="button" className={styles.calNavButton} aria-label="次の月" onClick={() => setMonth(shiftMonth(month, 1))}><ChevronRight size={16} aria-hidden="true" /></button>
          <Button type="button" variant="text" disabled={!canEdit} lockedReason={lockedReason} onClick={() => openNew()}><Plus size={16} aria-hidden="true" />臨時休業を足す</Button>
        </div>

      <div className={styles.calGrid} role="grid" aria-label={`${monthLabel}の休業日`}>
        {'日月火水木金土'.split('').map((day, index) => (
          <span key={day} className={`${styles.calWeekday} ${index === 0 ? styles.calWeekdaySun : ''} ${index === 6 ? styles.calWeekdaySat : ''}`}>{day}</span>
        ))}
        {weeks.flat().map((date) => {
          const d = new Date(`${date}T00:00:00Z`)
          const inMonth = date.slice(0, 7) === month
          const exception = closedOn(ranges, date)
          const isRegularOff = settings.businessHoursConfigured && closedDow.has(d.getUTCDay())
          const isToday = date === today
          const mark = exception ? '臨時休業' : isRegularOff ? '定休' : null
          // 前後の月の日は空けておく。
          if (!inMonth) return <span key={date} className={`${styles.calDay} ${styles.calDayOutside}`} aria-hidden="true" />
          const dayLabel = `${jpDate(date)}${mark ? `（${mark}）` : ''}`
          const dayClass = [
            styles.calDay,
            !inMonth && styles.calDayOutside,
            mark && styles.calDayClosed,
            isToday && styles.calDayToday,
          ].filter(Boolean).join(' ')
          const dayBody = (
            <>
              <span>{d.getUTCDate()}</span>
              {mark ? (
                <span className={`${styles.calMark} ${exception ? styles.calMarkExtra : styles.calMarkRegular}`}>{mark}</span>
              ) : null}
            </>
          )
          if (!canEdit) return <span key={date} role="gridcell" aria-label={dayLabel} className={dayClass}>{dayBody}</span>
          return (
            <Button
              key={date}
              type="button" variant="text" textTone="ink" disabled={!canEdit} lockedReason={lockedReason}
              onClick={() => { if (!canEdit) return; if (exception) openEdit(exception, date); else openNew(date) }}
              role="gridcell"
              aria-label={dayLabel}
              className={dayClass}
            >
              {dayBody}
            </Button>
          )
        })}
      </div>
      </Card>

      <Card layout="vertical" padding="roomy" gap="normal">
        <div className={styles.sectionHead}>
          <h2 className={styles.sectionTitle}>臨時休業</h2>
        </div>
      {closedExceptions.length > 0 ? (
        <div>
          {closedExceptions.map((item) => {
            const from = item.dateFrom || item.date || ''
            const to = item.dateTo || item.date || ''
            return (
              <div key={item.id} className={styles.exceptionRow}>
                <Button type="button" variant="text" textTone="ink" size="inline" disabled={!canEdit} lockedReason={lockedReason} onClick={() => { if (canEdit) openEdit(item) }}>
                  {from !== to ? `${jpDate(from)}・${jpDate(to)}` : jpDate(from)}
                </Button>
                <span className={styles.exceptionReason} title={item.reason || item.note || '臨時休業'}>{item.reason || item.note || '臨時休業'}</span>
                <Button type="button" variant="text" textTone={canEdit ? 'danger' : undefined} size="inline" disabled={!canEdit} lockedReason={lockedReason}
                  onClick={() => { if (!canEditRef.current || !alive.current || renderedScope !== scope.current || item.lineAccountId !== accountId) return; setEditError(null); setDeleteError(null); setDeleteScope(renderedScope); setDeleteTarget(item) }}>削除</Button>
              </div>
            )
          })}
        </div>
      ) : (
        <p className={styles.noteText}>臨時休業はまだありません。</p>
      )}

      <p className={styles.closedNote}>
        {bookingCountOnClosed !== null && bookingCountOnClosed > 0
          ? `すでに入っている予約は消えません。休みにした日に予約がある人には、お店から連絡してください（${bookingCountOnClosed} 件）。`
          : 'すでに入っている予約は消えません。休みにした日に予約がある人には、お店から連絡してください。'}
      </p>
      </Card>

      <Dialog
        open={editing !== null}
        title={editing === 'new' ? '臨時休業を足す' : '休業日を直す'}
        onCancel={() => { if (!busy) setEditing(null) }}
        busy={busy}
        confirmLabel="休業日を保存する"
        onConfirm={() => void save()}
      >
        <div className="grid gap-3">
          <Field label="開始日" requirement={holidayRequirements.from} error={dateErrors.from}><SaveErrorField names={["editFrom","dateFrom","edit_from"]}><DateField aria-label="休業の開始日" value={editFrom} onChange={(value) => { setEditFrom(value); setSelectedDate(value); setDateErrors(current => ({ ...current, from: undefined })) }} disabled={busy} className="mt-1" /></SaveErrorField></Field>
          <Field label="終了日" requirement={holidayRequirements.to} error={dateErrors.to}><SaveErrorField names={["editTo","dateTo","edit_to"]}><DateField aria-label="休業の終了日" value={editTo} onChange={(value) => { setEditTo(value); setDateErrors(current => ({ ...current, to: undefined })) }} disabled={busy} className="mt-1" /></SaveErrorField></Field>
          <Field label="理由" requirement={holidayRequirements.reason}><SaveErrorField names={["editReason","reason","edit_reason"]}><SharedTextField aria-label="休業の理由" value={editReason} onChange={(event) => setEditReason(event.target.value)} disabled={busy} placeholder="例：お盆・店舗の改装" className="border-hairline rounded-control focus:ring-accent mt-1 w-full border bg-canvas px-3 h-10 text-sm focus:outline-none focus:ring-2" /></SaveErrorField></Field>
          {editing !== null && reviewDate ? <HolidayBookings key={`${accountId}:${reviewDate}`} accountId={accountId} date={reviewDate} /> : null}
          {editError ? <Notice tone="danger" >{editError}</Notice> : null}
        </div>
      </Dialog>

      <ConfirmDialog
        open={deleteTarget !== null && deleteScope?.generation === scope.current.generation}
        title="この休業日を消しますか？"
        deleteName={deleteTarget?.reason?.trim() || `${deleteTarget?.dateFrom ?? ''}〜${deleteTarget?.dateTo ?? ''}の休業日`}
        description="削除すると、その期間は曜日の決めごとどおりの受付に戻ります。すでに入っている予約はそのまま残ります。"
        confirmLabel="休業日を削除する"
        destructive
        busy={busy}
        error={deleteError ?? undefined}
        onCancel={() => { if (!busy) { setDeleteTarget(null); setDeleteError(null) } }}
        onConfirm={() => remove()}
      >{deleteScope ? <OperationTargetSummary accounts={[{ id: deleteScope.accountId }]} /> : null}</ConfirmDialog>
    </div></SaveErrorScope>
  )
}

function exceptionFailureMessage(error: unknown, action: '保存' | '削除'): string {
  if (error instanceof ApiError && error.status === 409) {
    return 'ほかの担当者が先にこの休業日を変更しました。読み直してからもう一度お試しください。'
  }
  return action === '削除'
    ? '休業日を消せませんでした。もう一度お試しください。'
    : '休業日を保存できませんでした。入力内容を確かめて、もう一度お試しください。'
}
