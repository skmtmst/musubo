import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { GoogleProfile, Weekday } from './google-business-profile.js';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';
import { seedRestaurantFixture } from '../test-utils/restaurant-fixture.js';
import { connectedGoogleProfile, googleOpeningDay, googleOpeningWeek, syncGoogleOpeningWeek } from './restaurant-google-hours-source.js';
import { phoneIntakeFailure } from './restaurant-phone-intake.js';
import { restaurantRotation } from './restaurant-rotation.js';

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
afterEach(() => { vi.useRealTimers(); database.raw.close(); });

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

/*
 * 773 で互換索引（同じ店舗に接続を1件しか入れさせない UNIQUE）が無くなるため、
 * ここから下は**同じ店舗に2件目の接続が実際に入る**。入った瞬間に
 * 「store_id だけで1行読む」書き方は非決定になるため、どの接続を読むかは
 * google-connection-primary.ts の並べ方（主連携→sort_order→connected_at→id）
 * だけで決める。その並べ方をこの3本で固定する。
 */
const shibuyaLocation = 'accounts/111/locations/store-shibuya';
function secondConnection(sortOrder = 0): void {
  database.raw.prepare(`INSERT INTO rt_google_connections
    (id,store_id,location_name,refresh_token_enc,status,sort_order,connected_at) VALUES(?,?,?,?,?,?,?)`)
    .run('connection-2', 'store-ginza', shibuyaLocation, 'encrypted', 'connected', sortOrder, '2026-11-01T00:00:00Z');
}
/** 接続に紐付いた写し。773 後は接続ごとに1行入る（idx_rt_google_profiles_key_772）。 */
function cachedFor(connectionId: string, value: GoogleProfile, profileLocation: string): void {
  database.raw.prepare(`INSERT INTO rt_google_profiles
    (store_id,connection_id,location_name,profile_json,fingerprint,fetched_at,updated_at) VALUES(?,?,?,?,?,?,?)`)
    .run('store-ginza', connectionId, profileLocation, JSON.stringify({ profile: value }), value.fingerprint, '2026-11-10T00:00:00Z', '2026-11-10T00:00:00Z');
}
/** 2件の接続と、それぞれの写しを入れる。connection-2 の方が sort_order が小さい。 */
function twoConnections(): GoogleProfile {
  connection();
  database.raw.prepare("UPDATE rt_google_connections SET sort_order=1,connected_at='2026-11-02T00:00:00Z' WHERE id='connection-1'").run();
  secondConnection(0);
  cachedFor('connection-1', profile(), location);
  const shibuya = { ...profile(), name: 'locations/store-shibuya', title: '渋谷店', fingerprint: 'profile-2' };
  cachedFor('connection-2', shibuya, shibuyaLocation);
  return shibuya;
}
function markPrimary(connectionId: string): void {
  database.raw.prepare('INSERT INTO account_settings (id,line_account_id,key,value) VALUES(?,?,?,?)')
    .run('setting-primary', 'account-2', 'sns.google.primary_connection', JSON.stringify({ data: { connectionId } }));
}

it('接続が2件あるときは sort_order の小さい方の写しを読む', async () => {
  const shibuya = twoConnections();
  expect((await connectedGoogleProfile(database.db, 'store-ginza'))?.name).toBe(shibuya.name);
});

it('主連携の指定は sort_order より強い', async () => {
  twoConnections();
  markPrimary('connection-1');
  expect((await connectedGoogleProfile(database.db, 'store-ginza'))?.name).toBe(profileName);
  // 接続IDを渡したときはその接続の写しを読む（主連携の指定より呼び出し側が優先）。
  expect((await connectedGoogleProfile(database.db, 'store-ginza', 'connection-2'))?.name).toBe('locations/store-shibuya');
});

it('主連携が切れていれば、他に繋がっている接続があっても未接続として扱う', async () => {
  twoConnections();
  markPrimary('connection-1');
  database.raw.prepare("UPDATE rt_google_connections SET status='expired' WHERE id='connection-1'").run();
  // 先に1件へ決めてから状態を見る。繋がっている connection-2 へ勝手に乗り換えない。
  expect(await connectedGoogleProfile(database.db, 'store-ginza')).toBeNull();
  expect((await connectedGoogleProfile(database.db, 'store-ginza', 'connection-2'))?.name).toBe('locations/store-shibuya');
});

it('電話受付もGoogleの通常時間と特別休業日を守る', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-15T00:00:00Z'));
  const value = profile();
  connection();
  cached(value);
  await syncGoogleOpeningWeek(database.db, 'store-ginza', location, value);
  const start = '2026-11-16T01:00:00Z'; // 日本時間の月曜10時
  expect(await phoneIntakeFailure(database.db, 'store-ginza', start, '2026-11-16T03:00:00Z')).toBeNull();
  expect(await phoneIntakeFailure(database.db, 'store-ginza', '2026-11-16T08:00:00Z', '2026-11-16T10:00:00Z')).toBe('outside_opening_hours');
  value.specialHours = [{ date: '2026-11-16', closed: true, periods: [] }];
  database.raw.prepare('UPDATE rt_google_profiles SET profile_json=? WHERE store_id=?')
    .run(JSON.stringify({ profile: value }), 'store-ginza');
  expect(await phoneIntakeFailure(database.db, 'store-ginza', start, '2026-11-16T03:00:00Z')).toBe('outside_opening_hours');
});

it('前日から続くGoogleの深夜営業でも電話受付できる', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-15T00:00:00Z'));
  const value = profile();
  value.regularHours.MONDAY = [{ open: '23:00', close: '02:00' }];
  connection();
  cached(value);
  await syncGoogleOpeningWeek(database.db, 'store-ginza', location, value);
  expect(await phoneIntakeFailure(database.db, 'store-ginza', '2026-11-16T15:30:00Z', '2026-11-16T16:30:00Z')).toBeNull();
  expect(await phoneIntakeFailure(database.db, 'store-ginza', '2026-11-16T16:30:00Z', '2026-11-16T18:00:00Z')).toBe('outside_opening_hours');
  expect((await restaurantRotation(database.db, 'store-ginza', '2026-11-17')).openTableMinutes).toBe(120);
});
