/**
 * 基準日時からの差（分）の短い表示。`detail/page.tsx` の `timingLabel` と同じ約束。
 *
 * 約束：負の差は基準より「前」、正の差は「後」。0 と 1 時間未満は「当日」。
 * 一覧の行表示が差の符号を潰して一律「○日前」と出していたため（#489-21）、
 * ここに切り出して符号で「前」・「後」を分ける。
 */
export function formatTriggerOffset(offsetMinutes: number | null | undefined): string {
  if (offsetMinutes == null || !Number.isFinite(offsetMinutes)) return '当日'
  const offset = offsetMinutes
  const minutes = Math.abs(offset)
  if (minutes < 60) return '当日'
  const suffix = offset < 0 ? '前' : '後'
  if (minutes >= 1440) return `${Math.round(minutes / 1440)}日${suffix}`
  return `${Math.round(minutes / 60)}時間${suffix}`
}
