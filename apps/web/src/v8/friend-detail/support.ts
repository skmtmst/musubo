import type { StatusBadgeTone } from '@/components/shared/status-badge'

export type SupportStatus = 'unread' | 'in_progress' | 'on_hold' | 'resolved'

export const SUPPORT_LABELS: Record<SupportStatus, string> = Object.assign(Object.create(null), {
  unread: '未対応',
  in_progress: '対応中',
  on_hold: '保留',
  resolved: '対応済み',
})

/** 札の色は一覧の「状態の札」とそろえる（ 2.：未対応＝赤・対応中＝橙・保留＝灰・対応済み＝緑）。 */
export const SUPPORT_TONES: Record<SupportStatus, StatusBadgeTone> = Object.assign(Object.create(null), {
  unread: 'danger',
  in_progress: 'warning',
  on_hold: 'neutral',
  resolved: 'success',
})
