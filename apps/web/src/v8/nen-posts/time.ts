import { formatDateTime } from '@/lib/format'
/** 写真が届いた時刻を、運用画面の基準である日本時間へそろえる。 */
export function formatPhotoReceivedAt(value: unknown): string {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed ? formatDateTime(trimmed, '—') : '—'
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? formatDateTime(value, '—') : '—'
  }
  if (value instanceof Date) return formatDateTime(value, '—')
  return '—'
}
