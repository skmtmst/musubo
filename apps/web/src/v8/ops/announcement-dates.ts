function parseLocalDateTime(local: string) {
  const trimmed = local.trim()
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(trimmed)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null
  const date = new Date(year, month - 1, day)
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null
  return { month, day, hourText: match[4], minuteText: match[5], weekday: '日月火水木金土'[date.getDay()] }
}

export function shortPublishAt(local: string): string {
  const parsed = parseLocalDateTime(local)
  if (!parsed) return local.trim()
  return `${parsed.month}/${parsed.day} ${parsed.hourText}:${parsed.minuteText}`
}

export function longPublishAt(local: string): string {
  const parsed = parseLocalDateTime(local)
  if (!parsed) return local.trim()
  return `${parsed.month}/${parsed.day}（${parsed.weekday}）${parsed.hourText}:${parsed.minuteText}`
}
