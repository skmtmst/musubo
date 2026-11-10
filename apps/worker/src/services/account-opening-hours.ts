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

export function openingDay(state: AccountOpeningHours, date: string): Array<{ start: string; end: string }> | null {
  if (state.source === 'manual') return null;
  if (state.source === 'google_unavailable') return [];
  const today = googleOpeningDay(state.profile, date) ?? [];
  if (state.profile.specialHours.some(day => day.date === date && day.closed)) return [];
  const previousDate = new Date(`${date}T00:00:00Z`);
  previousDate.setUTCDate(previousDate.getUTCDate() - 1);
  const previous = googleOpeningDay(state.profile, previousDate.toISOString().slice(0, 10)) ?? [];
  const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
  const carry = previous.filter(period => minutes(period.closesAt) < minutes(period.opensAt))
    .map(period => ({ start: '00:00', end: period.closesAt }));
  const current = today.map(period => ({ start: period.opensAt,
    end: minutes(period.closesAt) < minutes(period.opensAt) ? '24:00' : period.closesAt }));
  return [...carry, ...current].sort((a, b) => a.start.localeCompare(b.start));
}

export function openingWeek(state: AccountOpeningHours): Array<{ weekday: number; intervals: Array<{ start: string; end: string }> }> | null {
  if (state.source === 'manual') return null;
  if (state.source === 'google_unavailable') return Array.from({ length: 7 }, (_, weekday) => ({ weekday, intervals: [] }));
  return (googleOpeningWeek(state.profile) ?? []).map(day => ({
    weekday: day.weekday,
    intervals: day.periods.map(period => ({ start: period.opensAt, end: period.closesAt })),
  }));
}
