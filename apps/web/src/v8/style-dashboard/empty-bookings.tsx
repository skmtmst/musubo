'use client'
import Button from '@/components/shared/button'
import ListState from '@/components/shared/list-state'
import { PERMISSION_LOCK_REASON, permissionLockReason } from '@/components/shared/permission-lock'
import { readPermissionSessionSnapshot } from '@/lib/session-snapshot'
import type { IndustryStyle, StyleToday } from './model'

/** 有効な予約の有無を、頭と本文で同じ判定にする。 */
export function bookingEmptyState(style: IndustryStyle, today: Pick<StyleToday, 'rows' | 'bookingCount'>): 'no-classes' | 'no-bookings' | 'has-bookings' | 'unknown' | null {
  if (style === 'lesson') {
    if (today.rows.some(row => row.booking && row.live !== false) || (today.bookingCount != null && today.bookingCount > 0)) return 'has-bookings'
    if (!today.rows.some(row => row.reservationId)) return 'no-classes'
    return today.bookingCount === 0 ? 'no-bookings' : 'unknown'
  }
  if (!['salon', 'consult'].includes(style)) return null
  return today.rows.some(row => row.booking && row.live !== false) ? 'has-bookings' : 'no-bookings'
}

/** 今日の空状態を一覧・盤・日カレンダーで共用する。 */
export function EmptyBookings({ style, today, canWrite, role, onBook, onCreateClass, day = '今日' }: {
  day?: '今日' | 'この日'
  style: IndustryStyle
  today: Pick<StyleToday, 'rows' | 'bookingCount'>
  canWrite: boolean
  role: string | null
  onBook: () => void
  onCreateClass: () => void
}) {
  const state = bookingEmptyState(style, today)
  if (state !== 'no-bookings' && state !== 'no-classes') return null
  const noClasses = state === 'no-classes'
  const description = noClasses ? 'クラスを作ると、会員が予約できるようになります。' : style === 'lesson' ? 'クラスを選んで、会員の予約を入れられます。' : today.rows.length ? '取消などの記録は下で確認できます。空いている時間に予約を入れられます。' : '空いている時間に予約を入れられます。'
  const readOnlyImpersonation = readPermissionSessionSnapshot()?.impersonation?.mode === 'read'
  const allowed = role !== null && canWrite && !readOnlyImpersonation
  const lockedReason = role === null
    ? undefined
    : readOnlyImpersonation
      ? PERMISSION_LOCK_REASON.impersonation
      : permissionLockReason(role, canWrite, 'feature')
  return <ListState kind="empty" title={`${day}の${noClasses ? 'クラス' : '予約'}はありません`} description={description}
    action={<Button variant="primary" disabled={role === null} lockedReason={lockedReason}
      onClick={() => { if (allowed) (noClasses ? onCreateClass : onBook)() }}>{noClasses ? 'クラスを作る' : style === 'lesson' ? '会員を予約する' : '予約を入れる'}</Button>} />
}
