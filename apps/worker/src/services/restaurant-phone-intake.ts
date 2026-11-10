import { tzDateStr } from './availability.js';
import { restaurantCivilTime } from './restaurant-booking.js';
import { connectedGoogleProfile, googleOpeningDay } from './restaurant-google-hours-source.js';
/** 受付時の通信・端末時計のわずかなずれを許す。大きな過去日時は記録しない。 */
const REQUEST_CLOCK_TOLERANCE_MS = 60_000;

export async function phoneIntakeFailure(db: D1Database, storeId: string, startsAt: string, endsAt: string): Promise<'opening_hours_unconfigured' | 'reservation_time_past' | 'outside_opening_hours' | null> {
  const hours = await db.prepare('SELECT hours_json FROM rt_opening_hours_settings WHERE store_id = ?').bind(storeId).first<{ hours_json: string }>();
  if (!hours) return 'opening_hours_unconfigured';
  const connection = await db.prepare('SELECT status FROM rt_google_connections WHERE store_id=?').bind(storeId).first<{ status: string }>();
  const profile = connection ? await connectedGoogleProfile(db, storeId) : null;
  if (connection && !profile) return 'opening_hours_unconfigured';
  if (Date.parse(startsAt) < Date.now() - REQUEST_CLOCK_TOLERANCE_MS) return 'reservation_time_past';
  if (profile) {
    const store = await db.prepare('SELECT timezone FROM rt_stores WHERE id=?').bind(storeId).first<{ timezone: string }>();
    if (!store) return 'opening_hours_unconfigured';
    const date = tzDateStr(store.timezone, new Date(startsAt));
    const periods = googleOpeningDay(profile, date);
    if (!periods) return 'opening_hours_unconfigured';
    const minutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
    const inside = periods.some(period => {
      const open = minutes(period.opensAt);
      const close = minutes(period.closesAt) + (minutes(period.closesAt) < open ? 1440 : 0);
      return Date.parse(startsAt) >= Date.parse(restaurantCivilTime(date, open, store.timezone))
        && Date.parse(endsAt) <= Date.parse(restaurantCivilTime(date, close, store.timezone));
    });
    if (!inside) return 'outside_opening_hours';
  }
  return null;
}
