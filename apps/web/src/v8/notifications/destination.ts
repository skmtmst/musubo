import type { NotificationCenterItem } from '@line-crm/shared'
import { dashboardNotificationDestination } from '@/components/dashboard/notification-summary'
import { isLineTokenNotification } from './tabs'

/** 行き先を決めるのに要る、見ている人の情報。 */
export type NotificationDestinationContext = {
  /** 見ている LINE アカウント。鍵の知らせはそのアカウントの設定へ送る。 */
  accountId?: string | null
  hqOrigin?: boolean
}

/*
 * 通知の行き先。ダッシュボードの通知パネルと同じ判定（dashboardNotificationDestination）に、
 * EC連携の通知（`ec.` / `ec_` で始まる種類）だけ EC連携の画面へ送る分を足す。
 * 今までは EC連携の通知も「お知らせ一覧」へ行っていた（直す場所へ1回で行けなかった）。
 * LINE の鍵の知らせ（`line_token_`）からは、そのアカウントの接続状況を確認できる。
 */
export function notificationDestination(item: NotificationCenterItem, context: NotificationDestinationContext = {}): string {
  const eventType = typeof item.eventType === 'string' ? item.eventType : ''
  if (isLineTokenNotification(item)) {
    return context.accountId ? `/accounts/detail?id=${encodeURIComponent(context.accountId)}` : '/accounts'
  }
  if (eventType.startsWith('ec.') || eventType.startsWith('ec_')) return '/ec-commerce'
  const destination = dashboardNotificationDestination({ ...item, eventType })
  return context.hqOrigin && (destination === '/updates' || destination === '/emergency') ? `${destination}?from=hq` : destination
}

/** 行の右に出す「どこへ移るか」の言葉（「EC連携を開く →」など）。 */
export function notificationLinkLabel(item: NotificationCenterItem, context: NotificationDestinationContext = {}): string {
  if (isLineTokenNotification(item)) return 'アカウントを見る'
  const to = notificationDestination(item, context)
  if (to.startsWith('/ec-commerce')) return 'EC連携を開く'
  if (to.startsWith('/emergency')) return '運用状態を開く'
  if (to.startsWith('/broadcasts')) return '配信を開く'
  if (to.startsWith('/settings/manual-links')) return 'マニュアルの表を開く'
  // メンテナンスの予告は版の履歴ではないので「詳細を見る」（行き先は同じお知らせ一覧）。
  if (to.startsWith('/updates') && item.category === 'update' && typeof item.eventType === 'string' && item.eventType.length > 0 && !item.eventType.includes('maintenance')) return '更新履歴を見る'
  return '詳細を見る'
}
