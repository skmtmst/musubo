import { tzDateStr } from './availability.js';
import { primaryGoogleConnection } from './google-connection-primary.js';
import { restaurantCivilTime } from './restaurant-booking.js';
import { closuresForRange, type ClosurePeriod } from './restaurant-closures.js';
import { connectedGoogleProfile, googleOpeningDay } from './restaurant-google-hours-source.js';
import { parseAllocationDocument, selectInventoryAllocation, type InventoryAllocationDocument } from './restaurant-inventory-allocation.js';
import { validateRestaurantOpeningHours, type OpeningDay } from './restaurant-inventory.js';
import type { SeatPlanState } from './restaurant-seat-plan.js';

type InventoryPeriods = (date: string) => OpeningDay['periods'] | null | undefined;
type InventoryWindow = { startsAt: string; endsAt: string; date: string };
type InventoryRule = { threshold: number; stop_line: number };

export const inventoryWindowMinutes = 30;

export function scheduledInventoryWindows(
  date: string,
  timezone: string,
  periodsFor: InventoryPeriods,
  offsets: readonly number[] = [-1, 0],
): InventoryWindow[] {
  const minutes = (time: string) => Number(time.slice(0,2))*60+Number(time.slice(3));
  const output: InventoryWindow[] = [];
  for (const offset of offsets) {
    // 暦日の曜日を進める計算。UTCの時点を店舗の今日としては使わない。
    const civilDate = tzDateStr('UTC', new Date(Date.parse(date) + offset * 86_400_000));
    for (const period of periodsFor(civilDate) ?? []) {
      const start = minutes(period.opensAt), close = minutes(period.closesAt);
      const end = close < start ? close + 1440 : close;
      for (let minute = start; minute < end; minute += inventoryWindowMinutes) {
        const startsAt = restaurantCivilTime(civilDate, minute, timezone);
        output.push({
          startsAt,
          endsAt: restaurantCivilTime(civilDate, Math.min(minute + inventoryWindowMinutes, end), timezone),
          date: tzDateStr(timezone, new Date(startsAt)),
        });
      }
    }
  }
  return output;
}

export async function readInventorySchedule(
  db: D1Database,
  storeId: string,
  timezone: string,
  date: string,
) {
  const from = restaurantCivilTime(date, 0, timezone);
  const to = restaurantCivilTime(date, 1440, timezone);
  const [opening, connection, closures] = await Promise.all([
    db.prepare('SELECT hours_json FROM rt_opening_hours_settings WHERE store_id=?').bind(storeId)
      .first<{ hours_json: string }>(),
    primaryGoogleConnection(db, storeId),
    closuresForRange(db, storeId, from, to),
  ]);
  const fullStoreClosures = closures.filter(closure => !(JSON.parse(closure.table_ids_json) as string[]).length);
  if (fullStoreClosures.some(closure => closure.all_day && closure.start_date <= date && closure.end_date >= date)) {
    return { hoursStatus: 'closed' as const, windows: [], closures };
  }
  if (!opening) return { hoursStatus: 'unconfigured' as const, windows: [], closures };
  const days = validateRestaurantOpeningHours(JSON.parse(opening.hours_json));
  const profile = connection ? await connectedGoogleProfile(db, storeId, connection.id) : null;
  if (!days || (connection && !profile)) return { hoursStatus: 'unavailable' as const, windows: [], closures };
  const periodsFor = (day: string) => profile ? googleOpeningDay(profile, day) : days.find(d => d.weekday === new Date(day).getUTCDay())?.periods;
  if (periodsFor(date) === null) return { hoursStatus: 'unavailable' as const, windows: [], closures };
  const windows = scheduledInventoryWindows(date, timezone, periodsFor).filter(window => window.date === date);
  const fullStoreClosedPeriods = fullStoreClosures.flatMap(closure => JSON.parse(closure.periods_json) as ClosurePeriod[]);
  const operatingWindows = windows.filter(window => !fullStoreClosedPeriods.some(period =>
    Date.parse(period.startsAt) <= Date.parse(window.startsAt) && Date.parse(period.endsAt) >= Date.parse(window.endsAt)));
  if (!operatingWindows.length) {
    return { hoursStatus: days.some(day => day.periods.length) || profile ? 'closed' as const : 'unconfigured' as const, windows: [], closures };
  }
  const today = tzDateStr(timezone, new Date());
  return { hoursStatus: 'open' as const, windows: date >= today ? operatingWindows : [], closures };
}

export function inventoryWindowOccupancy(state: SeatPlanState, startsAt: string, endsAt: string) {
  const applies = (range: { startsAt: string; endsAt: string }) =>
    Date.parse(range.startsAt) < Date.parse(endsAt) && Date.parse(range.endsAt) > Date.parse(startsAt);
  const reservations = state.reservations.filter(applies);
  const occupiedIds = new Set(reservations.flatMap(reservation => reservation.tableIds));
  const active = state.tables.filter(table => table.active === 1);
  const sum = (tables: typeof active) => tables.reduce((count, table) => count + table.maxCapacity, 0);
  const occupied = active.filter(table => occupiedIds.has(table.id));
  const closed = active.filter(table => state.closures.some(closure =>
    (!closure.tableIds.length || closure.tableIds.includes(table.id)) && closure.periods.some(applies)));
  const unassignedGuests = reservations.filter(reservation => !reservation.tableIds.length).reduce((count, reservation) => count + reservation.guestCount, 0);
  const total = sum(active);
  const occupiedSeats = sum(occupied);
  const free = Math.max(0, total - occupiedSeats - unassignedGuests);
  return {
    lineGuests: reservations.filter(reservation => reservation.source === 'line').reduce((count, reservation) => count + reservation.guestCount, 0),
    guests: reservations.reduce((count, reservation) => count + reservation.guestCount, 0),
    total,
    occupiedSeats,
    unassignedGuests,
    occupiedIds: occupied.map(table => table.id),
    closedIds: closed.map(table => table.id),
    freeSeats: Math.max(0, free - sum(closed.filter(table => !occupiedIds.has(table.id)))),
    freeForRule: free,
  };
}

export function stopsInventoryLine(rule: InventoryRule | null, free: number): boolean {
  return rule?.stop_line === 1 && free <= rule.threshold;
}

/** 実枠が覆っていない時間にも配分を適用し、同じ空き照会内では残数計算を繰り返さない。 */
export function inventoryLineCapacityCheck(
  settings: InventoryAllocationDocument,
  windows: readonly InventoryWindow[],
  state: SeatPlanState,
  excludedOfferId?: string,
): (startsAt: string, endsAt: string, guestCount: number) => boolean {
  const invited = settings.version ? state.waiting.filter(offer => offer.source === 'line' && offer.id !== excludedOfferId) : [];
  const invitedGuests = (from: number, to: number) => invited.reduce((count, offer) =>
    Date.parse(offer.startsAt) < to && Date.parse(offer.endsAt) > from ? count + offer.guestCount : count, 0);
  const saved = (state.inventorySlots ?? []).map(slot => {
    const from = Date.parse(slot.starts_at);
    const to = from + slot.slot_minutes * 60_000;
    const used = inventoryWindowOccupancy(state, slot.starts_at, new Date(to).toISOString()).lineGuests;
    return { from, to, remaining: slot.line_capacity - used - invitedGuests(from, to) };
  }).sort((a,b) => a.from - b.from);
  const limits = [...saved];
  for (const window of windows) {
    const { value } = selectInventoryAllocation(settings, window.startsAt, window.date, null);
    if (!value) continue;
    const end = Date.parse(window.endsAt);
    let start = Date.parse(window.startsAt);
    const occupancy = inventoryWindowOccupancy(state, window.startsAt, window.endsAt);
    const remaining = stopsInventoryLine(state.inventoryRule ?? null, occupancy.freeForRule) ? 0
      : value.lineCapacity - occupancy.lineGuests - invitedGuests(start, end);
    for (const interval of saved) {
      if (interval.from >= end || start >= end) break;
      if (interval.to <= start) continue;
      if (start < interval.from) limits.push({ from: start, to: interval.from, remaining });
      start = interval.to;
    }
    if (start < end) limits.push({ from: start, to: end, remaining });
  }
  return (startsAt, endsAt, guestCount) => {
    const start = Date.parse(startsAt), end = Date.parse(endsAt);
    return !limits.some(limit => limit.from < end && limit.to > start && limit.remaining < guestCount);
  };
}

/** キャンセル待ちの案内にも、通常のLINE予約と同じ受付配分を適用する。 */
export async function waitlistLineCapacityAvailable(
  db: D1Database,
  storeId: string,
  slot: { startsAt: string; endsAt: string; guestCount: number },
  state: SeatPlanState,
  excludedOfferId?: string,
): Promise<boolean> {
  const settings = parseAllocationDocument(state.inventoryAllocation ?? null);
  if (!settings.version) {
    return inventoryLineCapacityCheck(settings, [], state, excludedOfferId)(slot.startsAt, slot.endsAt, slot.guestCount);
  }
  const store = await db.prepare('SELECT timezone FROM rt_stores WHERE id=?').bind(storeId).first<{ timezone: string }>();
  if (!store) return false;
  const start = Date.parse(slot.startsAt), end = Date.parse(slot.endsAt);
  const dates = new Set([tzDateStr(store.timezone, new Date(start)), tzDateStr(store.timezone, new Date(end - 1))]);
  const calendars = await Promise.all([...dates].map(date => readInventorySchedule(db, storeId, store.timezone, date)));
  const windows = calendars.flatMap(day => day.windows).sort((a,b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  let covered = start;
  for (const window of windows) {
    if (Date.parse(window.startsAt) > covered || covered >= end) break;
    covered = Math.max(covered, Date.parse(window.endsAt));
  }
  return covered >= end && inventoryLineCapacityCheck(settings, windows, state, excludedOfferId)(slot.startsAt, slot.endsAt, slot.guestCount);
}
