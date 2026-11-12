import { v1LocationName, type GoogleProfile } from './google-business-profile.js';
import { validateRestaurantOpeningHours, type OpeningDay } from './restaurant-inventory.js';

const weekdayNumber = { SUNDAY: 0, MONDAY: 1, TUESDAY: 2, WEDNESDAY: 3, THURSDAY: 4, FRIDAY: 5, SATURDAY: 6 } as const;
const weekdayName = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'] as const;
const closingTime = (open: string, close: string) => open === '00:00' && close === '00:00' ? '24:00' : close;

/** Google の通常営業時間だけを予約側の週形式へ写す。読めない値は旧設定へ代用しない。 */
export function googleOpeningWeek(profile: GoogleProfile): OpeningDay[] | null {
  if (profile.openStatus === 'CLOSED_TEMPORARILY' || profile.openStatus === 'CLOSED_PERMANENTLY')
    return weekdayName.map((_, weekday) => ({ weekday, periods: [] }));
  const week = Object.entries(weekdayNumber).map(([name, weekday]) => ({
    weekday,
    periods: profile.regularHours[name as keyof typeof weekdayNumber]?.map(period => ({
      opensAt: period.open,
      closesAt: closingTime(period.open, period.close),
    })) ?? [],
  }));
  return validateRestaurantOpeningHours(week);
}

type GoogleHoursRow = { status: string; location_name: string | null; profile_json: string | null; profile_location: string | null };

/** 接続した店舗と同じ Google の写しだけを採用する。 */
export async function connectedGoogleProfile(db: D1Database, storeId: string): Promise<GoogleProfile | null> {
  const row = await db.prepare(`SELECT c.status,c.location_name,p.profile_json,p.location_name AS profile_location
    FROM rt_google_connections c LEFT JOIN rt_google_profiles p ON p.store_id=c.store_id
    WHERE c.store_id=?`).bind(storeId).first<GoogleHoursRow>();
  if (!row || row.status !== 'connected' || !row.location_name || row.location_name !== row.profile_location || !row.profile_json) return null;
  try {
    const profile = (JSON.parse(row.profile_json) as { profile?: GoogleProfile }).profile;
    return profile?.name === v1LocationName(row.location_name) && googleOpeningWeek(profile) ? profile : null;
  } catch { return null; }
}

/** 特別営業時間は通常の曜日より優先する。未登録の日は通常の週時間を使う。 */
export function googleOpeningDay(profile: GoogleProfile, date: string): OpeningDay['periods'] | null {
  const special = profile.specialHours.find(day => day.date === date);
  if (!special) return googleOpeningWeek(profile)?.find(day => day.weekday === new Date(`${date}T12:00:00Z`).getUTCDay())?.periods ?? null;
  if (special.closed || profile.openStatus === 'CLOSED_TEMPORARILY' || profile.openStatus === 'CLOSED_PERMANENTLY') return [];
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  return validateRestaurantOpeningHours(weekdayName.map((_, day) => ({ weekday: day, periods: day === weekday
    ? special.periods.map(period => ({ opensAt: period.open, closesAt: closingTime(period.open, period.close) })) : [] })))?.[weekday]?.periods ?? null;
}

/** Google の取得・送信成功時に予約用の週設定を同期し、既存の遅刻設定は保持する。 */
export async function syncGoogleOpeningWeek(db: D1Database, storeId: string, locationName: string, profile: GoogleProfile): Promise<boolean> {
  const week = googleOpeningWeek(profile);
  if (!week || profile.name !== v1LocationName(locationName)) return false;
  const current = await db.prepare('SELECT status,location_name FROM rt_google_connections WHERE store_id=?')
    .bind(storeId).first<{ status: string; location_name: string | null }>();
  if (current?.status !== 'connected' || current.location_name !== locationName) return false;
  const json = JSON.stringify(week);
  const saved = await db.prepare('SELECT hours_json,updated_by FROM rt_opening_hours_settings WHERE store_id=?')
    .bind(storeId).first<{ hours_json: string; updated_by: string }>();
  if (saved?.hours_json === json && saved.updated_by === 'google_business') return true;
  await db.prepare(`INSERT INTO rt_opening_hours_settings(store_id,hours_json,updated_by)
    VALUES(?,?,'google_business') ON CONFLICT(store_id) DO UPDATE SET
      hours_json=excluded.hours_json,version=rt_opening_hours_settings.version+1,
      updated_by='google_business',updated_at=datetime('now')`)
    .bind(storeId, json).run();
  return true;
}
