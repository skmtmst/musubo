import type { GoogleProfile } from './google-business-profile.js';
import { connectedGoogleProfile, googleOpeningDay, googleOpeningWeek } from './restaurant-google-hours-source.js';

/** One LINE account maps to one Google location. An invalid connected snapshot never falls back to old hours. */
export type AccountOpeningHours =
  | { source: 'manual'; profile: null }
  | { source: 'google_business'; profile: GoogleProfile }
  | { source: 'google_unavailable'; profile: null };

export async function accountOpeningHours(db: D1Database, accountId: string): Promise<AccountOpeningHours> {
  const row = await db.prepare(`SELECT s.id AS store_id,c.status
    FROM rt_stores s LEFT JOIN rt_google_connections c ON c.store_id=s.id
    WHERE s.line_account_id=? ORDER BY s.id LIMIT 1`)
    .bind(accountId).first<{ store_id: string; status: string | null }>();
  if (!row?.status) {
    return { source: 'manual', profile: null };
  }
  const profile = await connectedGoogleProfile(db, row.store_id);
  return profile ? { source: 'google_business', profile } : { source: 'google_unavailable', profile: null };
}

/** Shift an ISO calendar day without depending on the host time zone. */
export function shiftCalendarDate(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return [value.getUTCFullYear(), String(value.getUTCMonth() + 1).padStart(2, '0'),
    String(value.getUTCDate()).padStart(2, '0')].join('-');
}

export function openingDay(state: AccountOpeningHours, date: string): Array<{ start: string; end: string }> | null {
  if (state.source === 'manual') return null;
  if (state.source === 'google_unavailable') return [];
  const today = googleOpeningDay(state.profile, date) ?? [];
  if (state.profile.specialHours.some(day => day.date === date && day.closed)) return [];
  const previous = googleOpeningDay(state.profile, shiftCalendarDate(date, -1)) ?? [];
  const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
  const carry = previous.filter(period => minutes(period.closesAt) < minutes(period.opensAt))
    .map(period => ({ start: '00:00', end: period.closesAt }));
  const current = today.map(period => ({ start: period.opensAt,
    end: minutes(period.closesAt) < minutes(period.opensAt) ? '24:00' : period.closesAt }));
  return [...carry, ...current].sort((a, b) => a.start.localeCompare(b.start));
}

/** Keep per-interval booking capacity while Google owns the open/closed boundaries. */
export function openingCapacitySegments(
  local: Array<{ start_time: string; end_time: string; capacity: number }>,
  google: Array<{ start: string; end: string }> | null,
): Array<{ start: string; end: string; capacity: number }> {
  if (google === null) return local.map(hour => ({ start: hour.start_time, end: hour.end_time, capacity: Number(hour.capacity) }));
  return google.flatMap(period => {
    const boundaries = [...new Set([period.start, period.end, ...local.flatMap(hour => [hour.start_time, hour.end_time])
      .filter(time => period.start < time && time < period.end)])].sort();
    return boundaries.slice(0, -1).map((start, index) => {
      const end = boundaries[index + 1];
      const capacity = Number(local.find(hour => hour.start_time <= start && end <= hour.end_time)?.capacity ?? 1);
      return { start, end, capacity };
    });
  });
}

export function openingWeek(state: AccountOpeningHours): Array<{ weekday: number; intervals: Array<{ start: string; end: string }> }> | null {
  if (state.source === 'manual') return null;
  if (state.source === 'google_unavailable') return Array.from({ length: 7 }, (_, weekday) => ({ weekday, intervals: [] }));
  return (googleOpeningWeek(state.profile) ?? []).map(day => ({
    weekday: day.weekday,
    intervals: day.periods.map(period => ({ start: period.opensAt, end: period.closesAt })),
  }));
}
