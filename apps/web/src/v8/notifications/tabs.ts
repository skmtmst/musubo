import type { NotificationCenterData, NotificationCenterItem } from '@line-crm/shared'

/*
 * ベルの小窓と通知の一覧のタブ「すべて・未読・システム」。
 * 「アップデート」のタブは外し、「すべて」の中にだけ出す。
 *   - 未読：口の `unread=1`（担当者ごとの既読で口が絞る。先頭の数件に切っても未読が埋もれない）
 *   - システム：運用の異常の知らせ。口の `category=error`（LINE の鍵の知らせも error で書く）
 */
export type NotificationTab = 'all' | 'unread' | 'system'

export const NOTIFICATION_TABS: { value: NotificationTab; label: string }[] = [
  { value: 'all', label: 'すべて' },
  { value: 'unread', label: '未読' },
  { value: 'system', label: 'システム' },
]

/** 一覧の URL `?category=` からタブへ。前の `error` はシステム、`update` はすべてとして読む。 */
export function notificationTabFromParam(value: string | null | undefined): NotificationTab {
  if (value === 'unread') return 'unread'
  if (value === 'system' || value === 'error') return 'system'
  return 'all'
}

/** タブから一覧の口の指定へ。 */
export function notificationQueryForTab(tab: NotificationTab): { category?: 'error'; unread?: boolean } {
  if (tab === 'unread') return { unread: true }
  if (tab === 'system') return { category: 'error' }
  return {}
}

/** まとめて既読の範囲。未読のタブはすべての未読と同じなので全部。 */
export function markAllCategoryForTab(tab: NotificationTab): 'all' | 'error' {
  return tab === 'system' ? 'error' : 'all'
}

/** タブの件数（口の数）。システムは error の数。 */
export function notificationTabCount(counts: NotificationCenterData['counts'], tab: NotificationTab): number {
  if (tab === 'unread') return counts.unread
  if (tab === 'system') return counts.error
  return counts.all
}

/** LINE の鍵（チャネルアクセストークン）の知らせ。行き先はそのアカウントの接続の設定。 */
export function isLineTokenNotification(item: Pick<NotificationCenterItem, 'eventType'>): boolean {
  return typeof item.eventType === 'string' && item.eventType.startsWith('line_token_')
}

/** 行の印。システムの知らせは三角、それ以外は光。 */
export function isSystemNotification(item: Pick<NotificationCenterItem, 'category' | 'eventType'>): boolean {
  return item.category === 'error' || isLineTokenNotification(item)
}
