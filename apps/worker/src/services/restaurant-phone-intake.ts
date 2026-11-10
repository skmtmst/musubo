import { connectedGoogleProfile } from './restaurant-google-hours-source.js';
/** 受付時の通信・端末時計のわずかなずれを許す。大きな過去日時は記録しない。 */
const REQUEST_CLOCK_TOLERANCE_MS = 60_000;

export async function phoneIntakeFailure(db: D1Database, storeId: string, startsAt: string): Promise<'opening_hours_unconfigured' | 'reservation_time_past' | null> {
  const hours = await db.prepare('SELECT hours_json FROM rt_opening_hours_settings WHERE store_id = ?').bind(storeId).first<{ hours_json: string }>();
  if (!hours) return 'opening_hours_unconfigured';
  const connection = await db.prepare('SELECT status FROM rt_google_connections WHERE store_id=?').bind(storeId).first<{ status: string }>();
  if (connection && !await connectedGoogleProfile(db, storeId)) return 'opening_hours_unconfigured';
  if (Date.parse(startsAt) < Date.now() - REQUEST_CLOCK_TOLERANCE_MS) return 'reservation_time_past';
  return null;
}
