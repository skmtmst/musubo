import type { NotificationCenterData, NotificationCenterItem } from '@line-crm/shared'
import type { NotificationFilter, NotificationItem } from '@/components/shared/notification-panel'
import { formatDateTime } from '@/lib/format'

export type DashboardNotificationFilter = 'all' | 'error' | 'update'

export function isDashboardNotificationData(value: unknown): value is NotificationCenterData {
  if (!value || typeof value !== 'object') return false
  const data = value as Partial<NotificationCenterData>
  const counts = data.counts
  return Array.isArray(data.items)
    && Boolean(counts)
    && Number.isFinite(counts?.all)
    && Number.isFinite(counts?.error)
    && Number.isFinite(counts?.update)
    && Number.isFinite(counts?.unread)
    && Number.isFinite(data.unreadCount)
}

export function dashboardNotificationFilters(
  data: NotificationCenterData | null,
): NotificationFilter[] {
  return [
    { id: 'all', label: 'すべて', count: data?.counts?.all ?? null },
    { id: 'error', label: 'エラー', count: data?.counts?.error ?? null },
    { id: 'update', label: 'アップデート', count: data?.counts?.update ?? null },
  ]
}

export function notificationTime(createdAt: string): string {
  const time = new Date(createdAt)
  if (Number.isNaN(time.getTime())) return '日時不明'
  // 「9月2日 10:04」。月は long（9月）、日は numeric（2日）で出す。
  return formatDateTime(time)
}

export function dashboardNotificationItems(
  items: NotificationCenterItem[],
  onSelect: (item: NotificationCenterItem) => void,
): NotificationItem[] {
  return items.map((item) => ({
    id: item.id,
    title: item.title,
    meta: `${item.body}｜${notificationTime(item.createdAt)}`,
    unread: !item.isRead,
    filterId: item.category,
    onSelect: () => onSelect(item),
  }))
}

export function dashboardNotificationDestination(
  item: NotificationCenterItem,
): string {
  if (item.eventType.startsWith('account_health_')) return '/emergency'
  // 二者承認の通知は配信の詳細へ（承認・差し戻しをその場でできる）。
  if (item.eventType.startsWith('broadcast.approval')) {
    const broadcastId = item.metadata && typeof item.metadata.broadcastId === 'string'
      ? item.metadata.broadcastId
      : null
    return broadcastId ? `/broadcasts/detail?id=${encodeURIComponent(broadcastId)}` : '/broadcasts'
  }
  // 一斉配信(送信枠不足を含む)の通知は配信一覧へ。
  if (item.eventType.startsWith('broadcast')) return '/broadcasts'
  // マニュアル導線の切断は正本表へ。直す場所が押してすぐ分かるようにする。
  if (item.eventType === 'manual_link_broken') return '/settings/manual-links'
  // 外部の予定・会議の確認は、運用状態の健全性チェックの一覧で相手先の片づけを記録する。
  if (item.eventType === 'booking_external_cleanup_review') return '/emergency'
  /*
    知らない種類はお知らせ一覧へ。行き先なし(null)にすると、
    押したのに何も起きない(既読だけ付く)死に tap になる。
  */
  return '/updates'
}

export function markDashboardNotificationRead(
  data: NotificationCenterData,
  notificationId: string,
): NotificationCenterData {
  const target = data.items.find((item) => item.id === notificationId)
  if (!target || target.isRead) return data
  return {
    ...data,
    items: data.items.map((item) => item.id === notificationId ? { ...item, isRead: true } : item),
    counts: {
      ...data.counts,
      unread: Math.max(0, data.counts.unread - 1),
    },
    unreadCount: Math.max(0, data.unreadCount - 1),
  }
}
