

export interface FutureEventSlotSummary {
  /** 今後の有効な開催枠の数（イベント数ではなく枠数）。 */
  upcoming_slots: number;
  /** 今後の枠への有効な申込席数（requested+confirmed+offered+accepted）。 */
  upcoming_active: number;
  /** 今後の枠の定員合計。定員なしの枠が混ざるときは null。 */
  upcoming_capacity: number | null;
  /** 申込率（%）。定員が分からないときは null。 */
  fill_rate: number | null;
  /** 残り1〜3席の今後の枠の数。 */
  nearly_full: number;
  /** 7日以内で定員の半分未満の今後の枠の数。 */
  low_applications: number;
  /** いちばん近い今後の枠の開始日時。無いときは null。 */
  nearest_upcoming_starts_at: string | null;
  /** いちばん近い「申込が少ない」枠の開始日時。無いときは null。 */
  nearest_low_starts_at: string | null;
}

/**
 * 今後の開催枠だけを数える。
 *
 * 目安の決めごとは画面の summarizeEventAttention と同じ:
 * あと少しで満席 = 残り1〜3席、申し込みが少ない = 7日以内で定員の半分未満。
 */
export function summarizeFutureEventSlots(
  slots: ReadonlyArray<{
    starts_at: string;
    capacity: number | null;
    active_count: number | null;
  }>,
  nowMs = Date.now(),
): FutureEventSlotSummary {
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  let upcomingActive = 0;
  let upcomingCapacity = 0;
  let capacityUnknown = false;
  let nearlyFull = 0;
  let lowApplications = 0;
  let nearestUpcoming: string | null = null;
  let nearestLow: string | null = null;
  for (const slot of slots) {
    const active = slot.active_count ?? 0;
    const capacity = slot.capacity;
    upcomingActive += active;
    if (capacity == null) {
      capacityUnknown = true;
    } else {
      upcomingCapacity += capacity;
    }
    if (nearestUpcoming === null || slot.starts_at < nearestUpcoming) {
      nearestUpcoming = slot.starts_at;
    }
    if (capacity != null && capacity > 0) {
      if (capacity - active >= 1 && capacity - active <= 3) nearlyFull += 1;
      const startMs = Date.parse(slot.starts_at);
      if (
        Number.isFinite(startMs) &&
        startMs <= nowMs + weekMs &&
        active / capacity < 0.5
      ) {
        lowApplications += 1;
        if (nearestLow === null || slot.starts_at < nearestLow) {
          nearestLow = slot.starts_at;
        }
      }
    }
  }
  const capacity = capacityUnknown ? null : upcomingCapacity;
  return {
    upcoming_slots: slots.length,
    upcoming_active: upcomingActive,
    upcoming_capacity: capacity,
    fill_rate:
      capacity !== null && capacity > 0
        ? Math.round((upcomingActive / capacity) * 100)
        : null,
    nearly_full: nearlyFull,
    low_applications: lowApplications,
    nearest_upcoming_starts_at: nearestUpcoming,
    nearest_low_starts_at: nearestLow,
  };
}
