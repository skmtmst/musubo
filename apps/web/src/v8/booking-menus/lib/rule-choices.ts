/* 選ぶ欄の候補。今の値が候補に無ければ並びの中に足す（保存済みの値を消さない）。 */
export const WINDOW_DAY_CHOICES = [7, 14, 30, 60, 90, 180, 365]
export const BEFORE_MINUTE_CHOICES = [0, 30, 60, 120, 180, 360, 720, 1440, 2880, 4320]
export const MAX_ACTIVE_CHOICES = [1, 2, 3, 4, 5, 10]

export function withCurrent(choices: number[], current: number): number[] {
  if (!Array.isArray(choices)) {
    return typeof current === 'number' && Number.isFinite(current) ? [current] : []
  }
  const allFinite = choices.every((item) => typeof item === 'number' && Number.isFinite(item))
  const safeChoices = allFinite ? choices : choices.filter((item) => typeof item === 'number' && Number.isFinite(item))
  if (typeof current !== 'number' || !Number.isFinite(current)) return safeChoices
  return safeChoices.includes(current) ? safeChoices : [...safeChoices, current].sort((a, b) => a - b)
}

/** 「3 時間前まで」「30 分前まで」「直前まで」。 */
export function beforeLabel(minutes: number): string {
  if (typeof minutes !== 'number' || !Number.isFinite(minutes)) return '—'
  if (minutes <= 0) return '直前まで'
  if (minutes % 60 !== 0) return `${minutes} 分前まで`
  return `${minutes / 60} 時間前まで`
}
