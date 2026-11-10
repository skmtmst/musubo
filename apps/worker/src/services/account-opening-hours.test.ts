import { expect, it } from 'vitest';
import { openingDay, type AccountOpeningHours } from './account-opening-hours.js';
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
