export const JST_LOCAL = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Tokyo',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
})

export function dateTimeLocalJst(value: string): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (!trimmed) return ''
  // SQLite のオフセットなし日時は UTC。端末のタイムゾーンに左右されないよう補う。
  const normalized = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(trimmed) && !/Z$|[+-]\d{2}:?\d{2}$/i.test(trimmed)
    ? `${trimmed.replace(' ', 'T')}Z`
    : trimmed
  const date = new Date(normalized)
  if (Number.isNaN(date.getTime())) return ''
  const parts = Object.fromEntries(JST_LOCAL.formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]))
  const hour = parts.hour === '24' ? '00' : parts.hour
  return `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}`
}
