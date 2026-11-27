export function elapsedLabel(iso: string, now = Date.now()): string {
  const t = new Date(iso).getTime()
  if (Number.isNaN(t) || !Number.isFinite(now)) return '—'
  const minutes = Math.max(0, Math.round((now - t) / 60000))
  if (minutes < 1) return 'たった今'
  if (minutes < 60) return `${minutes}分前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}時間前`
  return `${Math.floor(hours / 24)}日前`
}

export function durationLabel(minutes: number | null): string {
  if (minutes === null || !Number.isFinite(minutes)) return '—'
  const total = Math.max(0, Math.round(minutes))
  if (total < 60) return `${total}分`
  const h = Math.floor(total / 60)
  const m = total % 60
  if (h < 24) return m > 0 ? `${h}時間${m}分` : `${h}時間`
  const d = Math.floor(h / 24)
  return `${d}日${h % 24}時間`
}

/** 先月との比べ方。時間は短いほど良い、割合は高いほど良い。 */
export function compareLabel(current: number | null, previous: number | null, kind: 'time' | 'rate'): string {
  if (current === null || !Number.isFinite(current)) return '今月の記録なし'
  if (previous === null || !Number.isFinite(previous) || previous === 0 || (kind === 'time' && previous < 0)) return '先月の記録なし'
  const diff = kind === 'time' ? ((previous - current) / previous) * 100 : current - previous
  const rounded = Math.round(Math.abs(diff))
  if (Math.abs(diff) < 3) return '先月とほぼ同じ'
  if (kind === 'time') return diff > 0 ? `先月より ${rounded}% 早い` : `先月より ${rounded}% 遅い`
  return diff > 0 ? `先月より ${rounded}% 改善` : `先月より ${rounded}% 低下`
}
