import { afterEach, beforeEach, expect, it } from 'vitest';
import type { GoogleProfile, Weekday } from './google-business-profile.js';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';
import { seedRestaurantFixture } from '../test-utils/restaurant-fixture.js';
import { connectedGoogleProfile, googleOpeningDay, googleOpeningWeek, syncGoogleOpeningWeek } from './restaurant-google-hours-source.js';

const location = 'accounts/111/locations/store-ginza';
const profileName = 'locations/store-ginza';
function profile(): GoogleProfile {
  const regularHours = Object.fromEntries((['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'] as Weekday[])
    .map(day => [day, day === 'MONDAY' ? [{ open: '09:00', close: '18:00' }] : []])) as GoogleProfile['regularHours'];
  return {
    name: profileName, title: '銀座店', address: null, phone: null, websiteUri: null, description: null,
    openStatus: 'OPEN', regularHours, specialHours: [], rawSpecialHours: [], mapsUri: null, fingerprint: 'profile-1',
  };
}
let database: SqliteD1;
beforeEach(() => { database = createTestD1(); seedRestaurantFixture(database); });
afterEach(() => database.raw.close());

function connection(status = 'connected', selectedLocation = location) {
  database.raw.prepare(`INSERT INTO rt_google_connections
    (id,store_id,location_name,refresh_token_enc,status) VALUES(?,?,?,?,?)`)
    .run('connection-1', 'store-ginza', selectedLocation, 'encrypted', status);
}
function cached(value: GoogleProfile, profileLocation = location) {
  database.raw.prepare(`INSERT INTO rt_google_profiles
    (store_id,location_name,profile_json,fingerprint,fetched_at,updated_at) VALUES(?,?,?,?,?,?)`)
    .run('store-ginza', profileLocation, JSON.stringify({ profile: value }), value.fingerprint, '2026-11-10T00:00:00Z', '2026-11-10T00:00:00Z');
}

it('Googleの通常・特別営業時間を予約用の時間へ写し、休業日を優先する', () => {
  const value = profile();
  value.specialHours = [
    { date: '2026-11-09', closed: true, periods: [] },
    { date: '2026-11-10', closed: false, periods: [{ open: '11:00', close: '15:00' }] },
  ];
  expect(googleOpeningWeek(value)?.[1]?.periods).toEqual([{ opensAt: '09:00', closesAt: '18:00' }]);
  expect(googleOpeningDay(value, '2026-11-09')).toEqual([]);
  expect(googleOpeningDay(value, '2026-11-10')).toEqual([{ opensAt: '11:00', closesAt: '15:00' }]);
  expect(googleOpeningDay(value, '2026-11-16')).toEqual([{ opensAt: '09:00', closesAt: '18:00' }]);
  value.regularHours.MONDAY = [{ open: '09:00', close: '09:00' }];
  expect(googleOpeningWeek(value)).toBeNull();
});

it('接続店舗と一致する写しだけを採用し、週設定を変更時だけ同期する', async () => {
  const value = profile();
  connection();
  cached(value);
  expect((await connectedGoogleProfile(database.db, 'store-ginza'))?.name).toBe(profileName);
  expect(await syncGoogleOpeningWeek(database.db, 'store-ginza', location, value)).toBe(true);
  const first = database.raw.prepare('SELECT hours_json,version,updated_by FROM rt_opening_hours_settings WHERE store_id=?').get('store-ginza') as { hours_json: string; version: number; updated_by: string };
  expect(JSON.parse(first.hours_json)[1].periods).toEqual([{ opensAt: '09:00', closesAt: '18:00' }]);
  expect(first.updated_by).toBe('google_business');
  expect(await syncGoogleOpeningWeek(database.db, 'store-ginza', location, value)).toBe(true);
  expect((database.raw.prepare('SELECT version FROM rt_opening_hours_settings WHERE store_id=?').get('store-ginza') as { version: number }).version).toBe(first.version);
  value.regularHours.MONDAY = [{ open: '10:00', close: '19:00' }];
  expect(await syncGoogleOpeningWeek(database.db, 'store-ginza', location, value)).toBe(true);
  expect((database.raw.prepare('SELECT version FROM rt_opening_hours_settings WHERE store_id=?').get('store-ginza') as { version: number }).version).toBe(first.version + 1);
  database.raw.prepare("UPDATE rt_google_connections SET status='expired' WHERE store_id=?").run('store-ginza');
  expect(await connectedGoogleProfile(database.db, 'store-ginza')).toBeNull();
  expect(await syncGoogleOpeningWeek(database.db, 'store-ginza', location, value)).toBe(false);
});

it('別のGoogle店舗の写しは使わない', async () => {
  connection();
  cached(profile(), 'locations/other');
  expect(await connectedGoogleProfile(database.db, 'store-ginza')).toBeNull();
});
