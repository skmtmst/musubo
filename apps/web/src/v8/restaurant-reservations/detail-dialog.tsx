'use client'
import { DetailPreview, DetailField } from '@/components/shared/detail-content'
import {ReservationDining,ReservationFacts,ReservationSource,ReservationDetailsActions} from '@/components/shared/reservation-board'
import {seatBoardEntry, withHonorific } from '@line-crm/shared'

/*
 * ★V8-B 予約台帳「予約の詳細」の窓（板 `AjZhH`）。
 *
 * 時間×卓の箱・「次の予約」の「詳細を見る」から開く。題は「{お客さま}さん・{人数}名」、
 * 灰の箱に 日時と卓・コースと予約元・アレルギー・これまでの来店、下に 閉じる・取り消す・変更する。
 * 取り消すは確かめの窓（台帳側の CancelReservationDialog）を通し、変更するは今の変更の窓へ移る。
 * 閲覧のみ（canWrite=false）には 取り消す・変更する を置かない（閉じるだけ）。動きは BEHAVIOR.md。
 */
import { formatDate as polishFormatDate } from '@/lib/format'
import { useEffect, useRef, useState } from 'react'
import Notice from '@/components/shared/notice'
import { ApiError } from '@/lib/api'
import StatusBadge from '@/components/shared/status-badge'
import { BookingStatus } from '@/components/shared/booking-presentation'
import { reservationBookingState, reservationStatusLabel } from '@/components/shared/booking-state'
import { describeApiFailure } from '@/components/shared/api-error-message'
import { Pencil, TriangleAlert, UserRoundX, X } from 'lucide-react'
import { useStaffRole } from '@/lib/staff-role'
import { permissionLockReason } from '@/components/shared/permission-lock'
import {RowActions} from '@/components/shared/row-actions'
import Button from '@/components/shared/button'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import Card from '@/components/shared/card'
import SectionHeader from '@/components/shared/section-header'
import {
  restaurantTestApi,
  type RestaurantMenuItem,
  type RestaurantReservation,
  type RestaurantTable,
} from '@/lib/restaurant-test-api'
import { RsDialog } from '@/v8/restaurant/booking-kit/public/parts/index'
import { INACTIVE_STATUSES, hm, mdWeek, sourceName, maskPhone } from '@/v8/restaurant/reservations/public/format/index'
import styles from './detail-dialog.module.css'
import { formatNumber as polishFormatNumber } from '@/lib/format'
import { formatYen as polishFormatYen } from '@/lib/format'
import { emptyValue } from '@/components/shared/empty-value'

type History = { state: 'loading' } | { state: 'none' } | { state: 'error' } | { state: 'ready'; count: number; last: string | null }

/** 「10/2（金）19:00〜21:00 ・ T4（4人卓）」。卓が無ければ「未配席」。 */
export function detailWhen(item: RestaurantReservation, table: RestaurantTable | null): string {
  const seat = table ? `${table.code}（${table.max_capacity} 人卓）` : item.table_label || '未配席'
  return `${mdWeek(new Date(item.starts_at))}${hm(item.starts_at)}〜${hm(item.ends_at)}・${seat}`
}

/** 「秋の鹿肉コース 8,800円 ・ Hot Pepper から」。コースが無ければ「席のみ」。 */
export function detailCourse(item: RestaurantReservation, course: RestaurantMenuItem | null): string {
  const name = item.course_name || course?.name || ''
  const price = course?.price ? ` ${polishFormatYen(course.price)}` : ''
  return `${name ? `${name}${price}` : '席のみ'}・${sourceName(item.source)} から`
}

function historyText(history: History): string {
  if (history.state === 'loading') return 'これまでの来店を読んでいます…'
  if (history.state === 'none') return 'これまでの来店：連絡先が無いので数えられません'
  if (history.state === 'error') return 'これまでの来店を読めませんでした'
  if (history.count === 0) return 'これまでの来店 0 回（はじめて）'
  const last = polishFormatDate(history.last, { style: 'list-day', fallback: '' })
  return `これまでの来店 ${history.count.toLocaleString('ja-JP')} 回${last ? `・前回 ${last}` : ''}`
}

export default function ReservationDetailDialog({ reservation, accountId, tables, courses, busy, canWrite, onClose, onCancel, onRestore, onEdit, onAttendance, onReload, operationScope, inline = false }: {
  onAttendance?:(id:string,action:'visited'|'depart'|'undo_departure'|'undo_visit'|'no_show')=>unknown
  onReload?: () => void
  operationScope?: object
  inline?: boolean
  reservation: RestaurantReservation | null
  accountId: string
  tables: RestaurantTable[]
  courses: RestaurantMenuItem[]
  busy: boolean
  /** 予約を変えられる人か（閲覧のみは false）。 */
  canWrite: boolean
  onClose: () => void
  /** 取り消す：確かめの窓へ。 */
  onCancel: (id: string) => void
  /** 取消・無断の予約を有効に戻す。 */
  onRestore: (id: string) => void
  /** 変更する：今の変更の窓へ。 */
  onEdit: (id: string) => void
}) {
  const role = useStaffRole()
  const permissionReason = role === null ? undefined : permissionLockReason(role, canWrite)
  const [confirmNoShow, setConfirmNoShow] = useState<{ id: string; scope: object; ticket: object } | null>(null)
  const noShowTicket = useRef<object | null>(null)
  const [history, setHistory] = useState<History>({ state: 'loading' })
  const id = reservation?.id ?? ''
  const storeId = reservation?.store_id ?? ''
  const confirmationScope = useRef({ accountId, id, storeId, canWrite, status: reservation?.status, operationScope })
  if (confirmationScope.current.accountId !== accountId || confirmationScope.current.id !== id || confirmationScope.current.storeId !== storeId || confirmationScope.current.canWrite !== canWrite || confirmationScope.current.status !== reservation?.status || confirmationScope.current.operationScope !== operationScope) { confirmationScope.current = { accountId, id, storeId, canWrite, status: reservation?.status, operationScope }; noShowTicket.current = null }
  const renderedScope = confirmationScope.current
  const phone = reservation?.customer_phone ?? ''
  const lineUid = reservation?.line_uid ?? ''

  const currentScope = useRef({ id, accountId, storeId, operationScope })
  if (currentScope.current.id !== id || currentScope.current.accountId !== accountId || currentScope.current.storeId !== storeId || currentScope.current.operationScope !== operationScope) currentScope.current = { id, accountId, storeId, operationScope }
  const scope = currentScope.current
  const [failure, setFailure] = useState<{ scope: object; error: unknown } | null>(null)
  const [unread, setUnread] = useState<{ scope: object; version: number } | null>(null)
  const [stampNotice, setStampNotice] = useState<{ scope: object; message: string } | null>(null)
  const waitingForReload = unread?.scope === scope && unread.version === (reservation?.customer_version ?? 1)
  const attempt = useRef(0)
  const working = useRef(false)
  const active = useRef(true)
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  const performAttendance = async (action: 'visited' | 'depart' | 'undo_departure' | 'undo_visit' | 'no_show') => {
    if (!onAttendance || !canWrite || busy || waitingForReload || working.current || !active.current || currentScope.current !== scope) return
    const sequence = ++attempt.current
    const current = () => active.current && currentScope.current === scope && attempt.current === sequence
    working.current = true
    setFailure(null)
    setStampNotice(null)
    try {
      const result = await onAttendance(id, action)
      if (current() && result && typeof result === 'object' && 'error' in result) setFailure({ scope, error: result.error })
      if (current() && result && typeof result === 'object' && 'savedButUnread' in result && result.savedButUnread === true) setUnread({ scope, version: reservation?.customer_version ?? 1 })
      if (current() && result && typeof result === 'object' && 'stampNotice' in result && typeof result.stampNotice === 'string') setStampNotice({ scope, message: result.stampNotice })
    } catch (error) {
      if (current()) setFailure({ scope, error })
    } finally { working.current = false }
  }
  const conflict = failure?.scope === scope && failure.error instanceof ApiError && failure.error.status === 409
  const failureNotice = failure?.scope === scope ? <Notice tone="danger" role="alert" message={conflict ? 'ほかの操作で予約が変わりました。読み直してから、もう一度選んでください。' : describeApiFailure(failure.error, '来店・退店の記録')} action={onReload ? <Button type="button" variant="secondary" size="compact" onClick={onReload}>読み直す</Button> : undefined} /> : null
  const unreadNotice = waitingForReload ? <Notice tone="warn" role="alert" message="保存しましたが、最新の予約を読み込めませんでした。読み直してから続けてください。" action={onReload ? <Button type="button" variant="secondary" size="compact" onClick={onReload}>読み直す</Button> : undefined} /> : null
  const stampStatus = stampNotice?.scope === scope ? <Notice tone="info" role="status" message={stampNotice.message} /> : null
  const workingStatus = busy ? <Notice tone="info" role="status" message="予約を反映しています。完了するまでお待ちください。" /> : null

  /* これまでの来店（来店済みの数と前回）。連絡先が無い予約は数えない。遅い応答は捨てる。 */
  useEffect(() => {
    if (!id) return
    if (!phone && !lineUid) { setHistory({ state: 'none' }); return }
    let current = true
    setHistory({ state: 'loading' })
    restaurantTestApi.customerHistory(accountId, storeId, { phone: phone || undefined, lineUid: lineUid || undefined })
      .then((res) => {
        if (!current) return
        const data = res?.data
        if (!data || typeof data.visitCount !== 'number') { setHistory({ state: 'error' }); return }
        setHistory({ state: 'ready', count: data.visitCount, last: data.visits?.[0]?.starts_at ?? null })
      })
      .catch(() => { if (current) setHistory({ state: 'error' }) })
    return () => { current = false }
  }, [id, accountId, storeId, phone, lineUid])

  if (!reservation) return null
  const table = reservation.table_id ? tables.find((t) => t.id === reservation.table_id) ?? null : null
  const course = reservation.course_id ? courses.find((c) => c.id === reservation.course_id) ?? null : null
  const inactive = INACTIVE_STATUSES.includes(reservation.status)
  const allergy = reservation.allergy_note?.trim() || ''
  const hasAllergy = Boolean(allergy && allergy !== 'なし' && allergy !== '無し')

  const entry = seatBoardEntry(reservation as unknown as Record<string, unknown>)
  const knownStatus = ['confirmed', 'requested', 'pending', 'no_show', 'completed', 'done', 'cancelled', 'rejected', 'expired', 'visited', 'seated', 'active', 'in_progress', 'late', 'expiring'].includes(reservation.status) || !!entry.arrivedAt || !!entry.departedAt || !!entry.holdExpiresAt
  const state = reservationBookingState(entry)
  const currentStatus = knownStatus ? <BookingStatus state={state}>{reservationStatusLabel(entry, state)}</BookingStatus> : <StatusBadge tone="neutral">状態を確認できません</StatusBadge>

  const attendanceItems=onAttendance&&!inactive&&!reservation.hold_expires_at?reservation.departed_at?[{id:'undo-depart',label:'退店を訂正する',disabled:busy,onSelect:()=>{void performAttendance('undo_departure')}}]:['visited','seated'].includes(reservation.status)?[{id:'depart',label:'退店にする',disabled:busy,onSelect:()=>{void performAttendance('depart')}},{id:'undo-visit',label:'来店を取り消す',disabled:busy,onSelect:()=>{void performAttendance('undo_visit')}}]:[{id:'visit',label:'来店にする',disabled:busy,onSelect:()=>{void performAttendance('visited')}},{id:'no-show',label:'無断にする',disabled:busy,onSelect:()=>{ if (!canWrite || reservation.status==='pending' || renderedScope !== confirmationScope.current) return; const ticket = {}; noShowTicket.current = ticket; setConfirmNoShow({ id: reservation.id, scope: renderedScope, ticket }) }}]:[]
  /* 来店・退店・無断は「…」の奥ではなく窓の下に直接置く。訂正だけ「…」に残す。 */
  const quickAttendance=attendanceItems.filter((item)=>item.id==='visit'||item.id==='depart'||item.id==='no-show')
  const undoAttendance=attendanceItems.filter((item)=>item.id==='undo-depart'||item.id==='undo-visit')
  const noShowReason = reservation.status === 'pending' ? '承認してから無断にしてください。' : undefined
  const buttonFor = (item: typeof attendanceItems[number]) => <Button key={item.id} type="button" disabled={busy || waitingForReload || !canWrite} lockedReason={permissionReason ?? (item.id === 'no-show' ? noShowReason : undefined)} onClick={item.onSelect}>{item.label}</Button>
  const quickButton = quickAttendance.find(item => item.id === 'visit' || item.id === 'depart')
  const modalMenu = [
    ...attendanceItems.filter(item => item !== quickButton).map(item => ({ ...item, lockedReason: permissionReason ?? (item.id === 'no-show' ? noShowReason : undefined), disabled: busy || waitingForReload || !canWrite, ...(item.id === 'no-show' ? { tone: 'danger' as const } : {}) })),
    ...(inactive ? [] : [{ id: 'cancel-reservation', label: '取り消す', tone: 'danger' as const, disabled: busy || waitingForReload || !canWrite, lockedReason: permissionReason, onSelect: () => { if (canWrite) onCancel(reservation.id) } }]),
  ]
  const dining=<ReservationDining title="お客さまの食事情報" entry={seatBoardEntry(reservation as unknown as Record<string,unknown>)} />
  const confirmation = <ConfirmDialog open={canWrite && reservation.status === 'confirmed' && confirmNoShow?.id === reservation.id && confirmNoShow.scope === renderedScope && confirmNoShow.ticket === noShowTicket.current} title="無断にしますか？" description={`${withHonorific(reservation.customer_name)}・${mdWeek(new Date(reservation.starts_at))}${hm(reservation.starts_at)}〜${hm(reservation.ends_at)}。卓が空いていれば予約を有効に戻せます。送信済みの連絡は取り消せません。`} destructive titleIcon={<TriangleAlert size={20} />} confirmIcon={<UserRoundX size={16} />} confirmVariant="danger" confirmLabel="無断にする" onConfirm={() => { if (renderedScope !== confirmationScope.current || !confirmNoShow || confirmNoShow.ticket !== noShowTicket.current) return; noShowTicket.current = null; if (canWrite && reservation.status === 'confirmed') void performAttendance('no_show'); setConfirmNoShow(null) }} onCancel={() => { if (renderedScope === confirmationScope.current && confirmNoShow?.ticket === noShowTicket.current) { noShowTicket.current = null; setConfirmNoShow(null) } }}><OperationTargetSummary accounts={[{ id: accountId }]} store={{ id: reservation.store_id, name: reservation.store_name }} /></ConfirmDialog>
  if (inline) return <><DetailPreview title="予約の詳細"
    description={`${mdWeek(new Date(reservation.starts_at))}${hm(reservation.starts_at)}〜${hm(reservation.ends_at)}・${table?.code ?? '未配席'}`}
    headerActions={<><Button size="inline" variant="text" aria-label="予約の詳細を閉じる" onClick={onClose}><X size={16} aria-hidden="true" /></Button></>}
    actions={{
      primary: quickAttendance[0] ? buttonFor(quickAttendance[0]) : null,
      secondary: quickAttendance[1] ? buttonFor(quickAttendance[1]) : null,
      menuItems: [...undoAttendance.map(item => ({...item, allowed: canWrite})), {id: 'edit-reservation', label: '内容を変える', allowed: canWrite, disabled: busy || waitingForReload, onSelect: () => { if (canWrite) onEdit(reservation.id) }}, ...(!inactive ? [{id: 'change-table', label: '卓を変える', allowed: canWrite, disabled: busy || waitingForReload, onSelect: () => { if (canWrite) onEdit(reservation.id) }}] : []), {id: 'cancel-reservation', label: inactive ? '予約を有効に戻す' : '取り消す', tone: inactive ? 'default' : 'danger', allowed: canWrite, disabled: busy || waitingForReload, onSelect: () => { if (!canWrite) return; if (inactive) onRestore(reservation.id); else onCancel(reservation.id) }}],
    }}>
    <DetailField label="状態">{currentStatus}</DetailField>
    <DetailField label="お客さま">{withHonorific(reservation.customer_name, 'さま', { space: true })}</DetailField>
    <DetailField label="予約元"><ReservationSource value={reservation.source} note={reservation.note} /></DetailField>
    <DetailField label="人数・コース">{`${reservation.guest_count}名・${reservation.course_name ?? '席のみ'}${course?.price ? ` ${polishFormatYen(course.price)}` : ''}`}</DetailField>
    <DetailField label="電話">{maskPhone(reservation.customer_phone) || '電話未登録'}</DetailField>
    <ReservationDining dense presentation="detail" title="お客さまの食事情報" entry={seatBoardEntry(reservation as unknown as Record<string, unknown>)} />
    <DetailField label="来店"><span title={historyText(history)}>{history.state === 'ready' ? `${polishFormatNumber(history.count)}回` : '—'}</span></DetailField>
    {failureNotice}{unreadNotice}{stampStatus}{workingStatus}
  </DetailPreview>{confirmation}</>

  return (
    <><RsDialog
      open
      title={`${withHonorific(reservation.customer_name)}・${reservation.guest_count}名`}
      width={680}
      top={160}
      busy={busy}
      designNode="AjZhH"
      onCancel={onClose}
      actions={(
        <>
          {modalMenu.length ? <RowActions subjectName={reservation.customer_name} menuItems={modalMenu} /> : null}
          {quickButton ? buttonFor(quickButton) : null}
          {inactive ? (
            <Button type="button" variant="primary" disabled={busy || waitingForReload || !canWrite} lockedReason={permissionReason} onClick={() => { if (canWrite) onRestore(reservation.id) }}>予約を有効に戻す</Button>
          ) : (
            <Button type="button" variant="primary" disabled={busy || waitingForReload || !canWrite} lockedReason={permissionReason} onClick={() => { if (canWrite) onEdit(reservation.id) }}>
              <Pencil size={16} aria-hidden="true" />内容を変える
            </Button>
          )}
        </>
      )}
    >
      <DetailField label="状態">{currentStatus}</DetailField>
      {dining}
      <div className={styles.facts}>
        <p className={styles.fact}>{detailWhen(reservation, table)}</p>
        <p className={styles.fact}>{detailCourse(reservation, course)}</p>
        <p className={styles.fact}>{`電話：${maskPhone(reservation.customer_phone) || '電話未登録'}`}</p>
        <p className={[styles.fact, hasAllergy && styles.allergy].filter(Boolean).join(' ')}>{`アレルギー：${allergy || emptyValue('none')}`}</p>
        <p className={styles.fact}>{historyText(history)}</p>
        {inactive ? <p className={styles.fact}>{reservation.status === 'no_show' ? '無断で来なかった予約です' : '取り消した予約です'}</p> : null}
      </div>
      {failureNotice}{unreadNotice}{stampStatus}{workingStatus}
    </RsDialog>{confirmation}</>
  )
}
