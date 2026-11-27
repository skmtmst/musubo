import { eventsApi, type EventBookingItem } from '@/lib/api'
import type { StyleRoster } from './model'
import { toLessonRosterMember } from './lesson-roster-state'

/** 展開表示と全員操作のため、表示用の7人に切らずページを読み切る。 */
export async function loadLessonBookings(accountId: string, eventId: string, slotId: string, signal: AbortSignal): Promise<EventBookingItem[]> {
  const items: EventBookingItem[] = []
  const seen = new Set<string>()
  let total: number | null = null
  for (let page = 1; ; page += 1) {
    if (signal.aborted) throw new Error('名簿の読み込みを中止しました')
    const response = await eventsApi.listBookings(accountId, eventId, { slot_id: slotId, limit: 50, page }, { signal })
    if (signal.aborted) throw new Error('名簿の読み込みを中止しました')
    if (!Number.isSafeInteger(response.total) || response.total < 0 || !Array.isArray(response.items)) {
      throw new Error('名簿の件数を確認できませんでした。時間をおいて、もう一度お試しください。')
    }
    if ((total !== null && total !== response.total) || items.length + response.items.length > response.total) {
      throw new Error('名簿が読み込みの途中で変わりました。もう一度読み込んでください。')
    }
    total = response.total
    for (const item of response.items) {
      if (!item || typeof item.id !== 'string' || !item.id.trim() || seen.has(item.id)) throw new Error('名簿の続きを読み込めませんでした')
      seen.add(item.id)
    }
    items.push(...response.items)
    if (items.length >= response.total) return items
    if (response.items.length === 0) throw new Error('名簿の続きを読み込めませんでした')
  }
}

export function lessonRosterMembers(items: EventBookingItem[]): StyleRoster['members'] {
  return items.map(toLessonRosterMember)
}

/** 個別更新の識別子は予約ID。名前なし・同名の人も混ざらない。 */
export function attendanceTargets(roster: StyleRoster, bookingId: string | null) {
  return roster.members.filter(m => m.attend === 'button' && (bookingId === null || m.bookingId === bookingId) && m.bookingId && m.eventId)
}
