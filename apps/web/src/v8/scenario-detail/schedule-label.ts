export function formatDelay(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return '即時'
  const safe = Math.floor(minutes)
  if (safe === 0) return '即時'
  if (safe < 60) return `${safe}分後`
  if (safe < 1440) {
    const h = Math.floor(safe / 60)
    const m = safe % 60
    return m === 0 ? `${h}時間後` : `${h}時間${m}分後`
  }
  const d = Math.floor(safe / 1440)
  const remaining = safe % 1440
  if (remaining === 0) return `${d}日後`
  const h = Math.floor(remaining / 60)
  return h > 0 ? `${d}日${h}時間後` : `${d}日${remaining}分後`
}
