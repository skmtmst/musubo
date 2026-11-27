import { knownValue } from '@/lib/known-value'

import { jstDate } from '@/lib/jst-datetime'
/*
 * 友だちの履歴（GET /api/friends/:id/timeline）の言葉と行き先。
 * 今の画面（app/friends/detail/page.tsx）の決まりを写した（import は不可）。
 */
import { formatDay } from '@/lib/format'
import { friendFilterHref } from '@/components/shared/friend-filter-band'

export type FriendTimelineItem = {
  id: string
  type: string
  summary: string
  /** 状態を持つ種類だけ値が入る（予約の確定/取消、注文、投稿の審査など）。 */
  status: string | null
  source: {
    kind: string
    id: string
    parentId: string | null
    url: string | null
  } | null
  occurredAt: string
  lineAccount: { id: string; name: string | null } | null
}

/** 受信箱への深いリンク。受信箱は `?friend=` を読む（#673）。 */
export function inboxHrefForFriend(friendId: string) {
  return `/chats?friend=${encodeURIComponent(friendId)}`
}

export const TIMELINE_TYPE_LABELS: Record<string, string> = {
  message_received: 'メッセージ受信',
  message_sent: 'メッセージ送信',
  form_submitted: 'フォーム回答',
  booking: '予約',
  calendar_booking: 'カレンダー予約',
  event_booking: 'イベント予約',
  reminder: 'リマインダ',
  ec_order: '注文',
  photo_submitted: '写真投稿',
  candidate: '重複候補',
  link: '名寄せ',
  unlink: '名寄せ解除',
  profile: 'プロフィール採用',
  priority: '名寄せ',
  migration: 'データ移行',
  friend_add: '友だち追加',
  friend_unfollow: 'ブロック',
  tag_change: 'タグ変更',
  field_change: '情報欄変更',
  scenario_started: 'シナリオ開始',
  scenario_completed: 'シナリオ完了',
  url_clicked: 'リンククリック',
  site_event: 'サイトイベント',
  conversion_created: 'CV登録',
  conversion_approved: 'CV承認',
  conversion_rejected: 'CV否認',
  automation_completed: 'オートメーション完了',
}

/** 知らない種別が来ても落とさず「記録」に倒す。 */
export function timelineTypeLabel(type: string) {
  return knownValue(TIMELINE_TYPE_LABELS, type, '記録')
}

const TIMELINE_STATUS_LABELS: Record<string, Record<string, string>> = {
  booking: { requested: '申込中', confirmed: '確定', rejected: '却下', expired: '期限切れ', cancelled: 'キャンセル', completed: '完了', no_show: '未来店' },
  calendar_booking: { confirmed: '確定', cancelled: 'キャンセル', completed: '完了' },
  event_booking: { requested: '申込中', confirmed: '確定', rejected: '却下', cancelled: 'キャンセル', expired: '期限切れ', no_show: '未来店', attended: '出席' },
  reminder: { active: '設定中', completed: '完了', cancelled: 'キャンセル' },
  ec_order: { current: '有効', refunded: '返金済み', cancelled: 'キャンセル' },
  photo_submitted: { pending: '確認待ち', adopted: '採用', rejected: '不採用' },
}

/** 知らない値は生の値を出す（隠すと「状態が取れたのに見えない」になる）。 */
export function timelineStatusLabel(type: string, status: string | null) {
  if (!status) return null
  const labels = knownValue(TIMELINE_STATUS_LABELS, type, {})
  return knownValue(labels, status, status)
}

function safeExternalHttpUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  try {
    const parsed = new URL(trimmed)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? trimmed : null
  } catch {
    return null
  }
}

/**
 * 元情報へのリンク。実在する画面・URLだけを出す（IDEA-03「無いデータをあるように出さない」）。
 * label は履歴タブの「元」の列の言葉（ 3. 履歴）。
 */
export function timelineSourceHref(item: FriendTimelineItem, friendId: string): { href: string; external: boolean; label: string } | null {
  const source = item?.source
  if (!source || typeof source !== 'object') return null
  if (typeof source.url === 'string' && source.url.trim() !== '') {
    const safeUrl = safeExternalHttpUrl(source.url)
    return safeUrl ? { href: safeUrl, external: true, label: item.type === 'ec_order' ? '注文' : '元の記録' } : null
  }
  switch (source.kind) {
    case 'message':
      return friendId ? { href: inboxHrefForFriend(friendId), external: false, label: '受信箱' } : null
    case 'form_submission':
      return source.parentId ? { href: `/form-submissions/responses?id=${encodeURIComponent(source.parentId)}`, external: false, label: '回答' } : null
    case 'booking':
      return source.id ? { href: `/booking/bookings/detail?id=${encodeURIComponent(source.id)}`, external: false, label: '予約' } : null
    case 'event_booking':
      return source.parentId ? { href: `/events/bookings?id=${encodeURIComponent(source.parentId)}`, external: false, label: '予約' } : null
    case 'friend_reminder':
      return friendId ? { href: friendFilterHref('/reminders', friendId), external: false, label: 'リマインダ' } : null
    default:
      return null
  }
}

/** 印の色（絵の注記：受信＝青・送信と注文＝緑・回答＝紫・シナリオ＝黄・その他＝灰）。 */
export type TimelineTone = 'info' | 'success' | 'purple' | 'warn' | 'neutral'
export function timelineTone(type: string): TimelineTone {
  if (type === 'message_received') return 'info'
  if (type === 'message_sent' || type === 'ec_order') return 'success'
  if (type === 'form_submitted') return 'purple'
  if (type === 'scenario_started' || type === 'scenario_completed') return 'warn'
  return 'neutral'
}

/** 「受信」「送信」「システム通知」の切り替え（履歴タブ）。 */
export type TimelineFilter = 'all' | 'received' | 'sent' | 'system'
export function matchesTimelineFilter(item: FriendTimelineItem, filter: TimelineFilter) {
  if (filter === 'all') return true
  if (filter === 'received') return item.type === 'message_received'
  if (filter === 'sent') return item.type === 'message_sent'
  return item.type !== 'message_received' && item.type !== 'message_sent'
}

/** 日の見出し（今日 10月1日（木）／昨日 9月30日（水）／9月26日（土））。 */
export function dayHeading(value: string, now: Date = new Date()) {
  const key = dayKey(value)
  const day = formatDay(value)
  if (!key) return day
  const nowTime = now instanceof Date ? now.getTime() : Number.NaN
  if (!Number.isFinite(nowTime)) return day
  const today = dayKey(new Date(nowTime).toISOString())
  const yesterday = dayKey(new Date(nowTime - 86_400_000).toISOString())
  if (key === today) return `今日 ${day}`
  if (key === yesterday) return `昨日 ${day}`
  return day
}

/** 日本時間の日付の鍵（日ごとにまとめるため）。 */
export function dayKey(value: string) {
  if (typeof value !== 'string' || !value.trim()) return ''
  const time = new Date(value).getTime()
  if (Number.isNaN(time)) return ''
  return jstDate(new Date(time))
}

/** 同じ元の行を二重に足さないための鍵（IDEA-03「重複なし」）。 */
export function timelineKey(item: FriendTimelineItem) {
  return `${item.source?.kind ?? item.type}:${item.id}`
}
