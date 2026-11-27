import type { WebinarNotificationSettings } from '@/lib/api'
import StatusBadge from '@/components/shared/status-badge'
import { formatNumber } from '@/lib/format'
import { emptyValue } from '@/components/shared/empty-value'

export function audienceText(audience: { people: number; bookings: number; definition: string } | undefined): string {
  if (!audience) return emptyValue('unknown')
  if (!Number.isFinite(audience.people) || audience.people < 0 || !Number.isFinite(audience.bookings) || audience.bookings < 0) {
    return emptyValue('unknown')
  }
  return `${formatNumber(audience.people)}人（取消を除いた有効な申込。延べ予約は${formatNumber(audience.bookings)}件）`
}

export type NotificationRowState = 'configured' | 'unset' | 'pending' | 'failed'
export const NOTIFICATION_ROW_STATE = {
  configured: { label: '設定済み', tone: 'success' },
  unset: { label: '未設定', tone: 'neutral' },
  pending: { label: '—（確認中）', tone: 'info' },
  failed: { label: '読み込めませんでした', tone: 'danger' },
} as const

export function NotificationStateBadge({ state }: { state: NotificationRowState }) {
  const view = NOTIFICATION_ROW_STATE[state]
  return <StatusBadge tone={view.tone}>{view.label}</StatusBadge>
}

export function notificationRowState(
  value: boolean | undefined,
  ready: boolean,
  failed: boolean,
): NotificationRowState {
  if (!ready) return 'pending'
  if (failed) return 'failed'
  return value ? 'configured' : 'unset'
}

/*
  「当日・見逃し案内」の要約文は、時刻の有無ではなく保存された
  各通知の有効フラグから組み立てる（監査 WEBINAR-10）。
  全OFFで保存しても時刻の既定値は残るので、値だけ見ると
  切った通知まで「送る」と読めてしまう。読み込み中・取得失敗・
  まだ設定が無いのも「送る」ではないので、状態ごとに分ける。
  説明は概要バッジと同じ NOTIFICATION_ROW_STATE の言葉を使う。
*/
export function deliveryTimingSummary(
  settings: WebinarNotificationSettings | null,
  ready: boolean,
  failed: boolean,
): string {
  if (!ready) return NOTIFICATION_ROW_STATE.pending.label
  if (failed) return NOTIFICATION_ROW_STATE.failed.label
  if (!settings) return NOTIFICATION_ROW_STATE.unset.label
  const parts: string[] = []
  const dayBeforeTime = settings.dayBeforeTime?.trim()
  const hourBeforeMinutes = typeof settings.hourBeforeMinutes === 'number' && Number.isFinite(settings.hourBeforeMinutes) && settings.hourBeforeMinutes > 0
    ? Math.floor(settings.hourBeforeMinutes)
    : null
  if (settings.dayBeforeEnabled) parts.push(`前日 ${dayBeforeTime || '—'}`)
  if (settings.hourBeforeEnabled) parts.push(hourBeforeMinutes ? `${hourBeforeMinutes}分前` : '開始前')
  if (settings.startEnabled) parts.push('開始時')
  return parts.length > 0 ? parts.join('／') : '送りません'
}

export function missedNoticeSummary(
  settings: WebinarNotificationSettings | null,
  ready: boolean,
  failed: boolean,
): string {
  if (!ready) return NOTIFICATION_ROW_STATE.pending.label
  if (failed) return NOTIFICATION_ROW_STATE.failed.label
  if (!settings) return NOTIFICATION_ROW_STATE.unset.label
  const missedTime = settings.missedTime?.trim()
  const windowDays = typeof settings.missedWindowDays === 'number' && Number.isFinite(settings.missedWindowDays) && settings.missedWindowDays > 0
    ? Math.floor(settings.missedWindowDays)
    : 7
  return settings.missedEnabled
    ? `未視聴者へ翌日${missedTime || '—'}に送信（期限${windowDays}日）`
    : '送りません'
}

export function completedNoticeSummary(
  settings: WebinarNotificationSettings | null,
  ready: boolean,
  failed: boolean,
): string {
  if (!ready) return NOTIFICATION_ROW_STATE.pending.label
  if (failed) return NOTIFICATION_ROW_STATE.failed.label
  if (!settings) return NOTIFICATION_ROW_STATE.unset.label
  return settings.completedEnabled ? '見終わった人へお礼を送信' : '送りません'
}
