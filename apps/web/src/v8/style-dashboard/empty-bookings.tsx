'use client'
import { useSyncExternalStore } from 'react'
import Button from '@/components/shared/button'
import ListState from '@/components/shared/list-state'
import { PERMISSION_LOCK_REASON, permissionLockReason } from '@/components/shared/permission-lock'
import { readPermissionSessionSnapshot, SESSION_SNAPSHOT_CHANGED } from '@/lib/session-snapshot'
import type { IndustryStyle, StyleToday } from './model'

function subscribeSessionSnapshot(onStoreChange: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  window.addEventListener(SESSION_SNAPSHOT_CHANGED, onStoreChange)
  return () => window.removeEventListener(SESSION_SNAPSHOT_CHANGED, onStoreChange)
}

function isReadOnlyImpersonation(): boolean {
  return readPermissionSessionSnapshot()?.impersonation?.mode === 'read'
}

function resolveLockedReason(role: string | null, canWrite: boolean, readOnlyImpersonation: boolean): string | undefined {
  if (role === null) return undefined
  if (readOnlyImpersonation) return PERMISSION_LOCK_REASON.impersonation
  return permissionLockReason(role, canWrite, 'feature')
}

function EmptyBookingActionButton({
  role,
  canWrite,
  disabled,
  lockedReason: _initialLockedReason,
  onClick,
  children,
}: {
  role: string | null
  canWrite: boolean
  disabled: boolean
  lockedReason?: string
  onClick: () => void
  children: string
}) {
  const readOnlyImpersonation = useSyncExternalStore(subscribeSessionSnapshot, isReadOnlyImpersonation, () => false)
  const liveLockedReason = resolveLockedReason(role, canWrite, readOnlyImpersonation)
  return (
    <Button
      variant="primary"
      disabled={disabled}
      lockedReason={liveLockedReason}
      onClick={() => {
        if (role !== null && canWrite && !isReadOnlyImpersonation()) onClick()
      }}
    >
      {children}
    </Button>
  )
}

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
  const readOnlyImpersonation = isReadOnlyImpersonation()
  const lockedReason = resolveLockedReason(role, canWrite, readOnlyImpersonation)
  const label = noClasses ? 'クラスを作る' : style === 'lesson' ? '会員を予約する' : '予約を入れる'
  const handleAction = () => {
    if (role !== null && canWrite && !isReadOnlyImpersonation()) (noClasses ? onCreateClass : onBook)()
  }
  return <ListState kind="empty" title={`${day}の${noClasses ? 'クラス' : '予約'}はありません`} description={description}
    action={<EmptyBookingActionButton role={role} canWrite={canWrite} disabled={role === null} lockedReason={lockedReason} onClick={handleAction}>{label}</EmptyBookingActionButton>} />
}
