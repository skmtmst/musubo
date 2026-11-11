import { expect, it } from 'vitest';
import { openingCapacitySegments, openingDay, shiftCalendarDate, type AccountOpeningHours } from './account-opening-hours.js';
import type { GoogleProfile } from './google-business-profile.js';

const week = Object.fromEntries(['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY']
  .map(day => [day, day === 'MONDAY' ? [{ open: '22:00', close: '02:00' }] : []])) as GoogleProfile['regularHours'];
const profile = { openStatus: 'OPEN', regularHours: week, specialHours: [] } as unknown as GoogleProfile;
const source: AccountOpeningHours = { source: 'google_business', profile };

it('Googleの深夜営業を当日と翌日に分けて共通営業時間へ渡す', () => {
  expect(openingDay(source, '2026-11-16')).toEqual([{ start: '22:00', end: '24:00' }]);
  expect(openingDay(source, '2026-11-17')).toEqual([{ start: '00:00', end: '02:00' }]);
});

it('翌日がGoogleの特別休業なら前日からの深夜営業も閉じる', () => {
  const closed: AccountOpeningHours = { source: 'google_business', profile: { ...profile,
    specialHours: [{ date: '2026-11-17', closed: true, periods: [] }] } };
  expect(openingDay(closed, '2026-11-17')).toEqual([]);
});

it('月境界と閏日をまたいでも暦日を正しくずらす', () => {
  expect(shiftCalendarDate('2024-03-01', -1)).toBe('2024-02-29');
  expect(shiftCalendarDate('2026-12-31', 30)).toBe('2027-01-30');
});

it('Googleの営業時間内だけ既存の予約定員を使い、未設定区間は定員1にする', () => {
  expect(openingCapacitySegments([{ start_time: '10:00', end_time: '12:00', capacity: 3 }],
    [{ start: '11:00', end: '13:00' }])).toEqual([
    { start: '11:00', end: '12:00', capacity: 3 },
    { start: '12:00', end: '13:00', capacity: 1 },
  ]);
});

it('Google未接続なら重なる従来の定員区間をそのまま保持する', () => {
  expect(openingCapacitySegments([
    { start_time: '10:00', end_time: '12:00', capacity: 2 },
    { start_time: '11:00', end_time: '13:00', capacity: 4 },
  ], null)).toEqual([
    { start: '10:00', end: '12:00', capacity: 2 },
    { start: '11:00', end: '13:00', capacity: 4 },
  ]);
});
