import type { BookingAvailabilitySlot } from '@/lib/api'

function finiteRemaining(slot: BookingAvailabilitySlot): number | null {
  const value = slot.remaining
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : null
}

/**
 * 指名なしの空き：担当ごとの枠を日時で合わせ、どれか1人でも空いていれば空き。
 * LIFF で「指名なし」を選んだときと同じ見え方にする。
 */
export function mergeStaffSlots(byStaff: Array<{ slots?: BookingAvailabilitySlot[] }>): BookingAvailabilitySlot[] {
  if (!Array.isArray(byStaff)) return []
  const merged = new Map<string, BookingAvailabilitySlot>()
  for (const person of byStaff) {
    if (!person || typeof person !== 'object' || !Array.isArray(person.slots)) continue
    for (const slot of person.slots) {
      if (!slot || typeof slot !== 'object') continue
      if (typeof slot.date !== 'string' || !slot.date.trim() || typeof slot.start !== 'string' || !slot.start.trim()) continue
      const key = `${slot.date} ${slot.start}`
      const current = merged.get(key)
      if (!current) {
        merged.set(key, slot)
        continue
      }
      const nextRem = finiteRemaining(slot)
      const currRem = finiteRemaining(current)
      if (nextRem !== null && (currRem === null || nextRem > currRem)) merged.set(key, slot)
    }
  }
  return [...merged.values()].sort((a, b) => (a.date === b.date ? a.start.localeCompare(b.start) : a.date.localeCompare(b.date)))
}
