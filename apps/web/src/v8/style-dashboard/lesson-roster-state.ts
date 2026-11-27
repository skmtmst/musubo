import type { EventBookingItem } from '@/lib/api/types/events'
import type { StyleRoster } from './model'

const STATUS_NOTES: Record<string, string> = { cancelled: '取消', no_show: '欠席', requested: '承認待ち', rejected: '拒否', expired: '期限切れ' }

/** 日時だけを取消の根拠にせず、予約の正規状態で人数と操作対象を決める。 */
export function isLiveLessonBooking(booking: Pick<EventBookingItem, 'status' | 'cancelled_at'>): boolean {
  return !booking.cancelled_at && ['requested', 'confirmed', 'attended', 'no_show'].includes(booking.status)
}

export function toLessonRosterMember(booking: EventBookingItem): StyleRoster['members'][number] {
  const cancelled = booking.status === 'cancelled' || Boolean(booking.cancelled_at)
  const name = typeof booking.friend_display_name === 'string' ? booking.friend_display_name : typeof booking.friend_name === 'string' ? booking.friend_name : '名前なし'
  const statusNote = Object.hasOwn(STATUS_NOTES, booking.status) ? STATUS_NOTES[booking.status] : null
  const sub = statusNote ?? (booking.status === 'confirmed' || booking.status === 'attended' ? (booking.is_first_time ? '初めて' : '会員') : '状態を確認できません')
  return {
    name,
    sub: cancelled ? '取消' : sub,
    pay: { label: '—', tone: 'neutral' },
    attend: cancelled ? 'cancel' : booking.status === 'attended' ? 'done' : booking.status === 'no_show' ? 'absent' : booking.status === 'confirmed' ? 'button' : 'unavailable',
    bookingId: booking.id, eventId: booking.event_id, startsAt: booking.slot_starts_at,
    canReportAbsence: !cancelled && ['requested', 'confirmed'].includes(booking.status),
  }
}
