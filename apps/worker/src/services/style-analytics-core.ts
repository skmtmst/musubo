import { StyleError } from './style-setup.js';
import type { StyleBooking, StyleMetric } from '@line-crm/shared';
import { restaurantCivilTime, validRestaurantDate } from './restaurant-booking.js';

export const DAY = 86_400_000;
export const cancelled = (r: StyleBooking) =>
  ['cancelled', 'rejected', 'expired'].includes(r.status);
export const eligible = (r: StyleBooking) => !cancelled(r) && !r.held;
export function instant(value: string): number {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) value += 'T00:00:00';
  return Date.parse(
    /(?:Z|[+-]\d\d:\d\d)$/.test(value)
      ? value
      : value.replace(' ', 'T') + '+09:00',
  );
}
export const countMetric = (
  value: number,
  formula: string,
  unit = '件',
): StyleMetric => ({ value, formula, unit, status: 'available' });
export function ratio(
  numerator: number,
  denominator: number,
  formula: string,
  minimum = 1,
): StyleMetric {
  return {
    value: denominator >= minimum ? numerator / denominator : null,
    numerator,
    denominator,
    formula,
    unit: '割合',
    status: denominator >= minimum ? 'available' : 'insufficient_sample',
  };
}
export const missing = (formula: string): StyleMetric => ({
  value: null,
  formula,
  unit: '件',
  status: 'unconfigured',
});
const civilDateFormatters = new Map<string, Intl.DateTimeFormat>();
export function civilDate(now: number, timeZone: string) {
  let formatter = civilDateFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    // 異なるタイムゾーンが増え続けても Worker のメモリを占有しない。
    if (civilDateFormatters.size >= 128) civilDateFormatters.clear();
    civilDateFormatters.set(timeZone, formatter);
  }
  return formatter.format(new Date(now));
}
export function addDate(date: string, days: number) {
  return new Date(Date.parse(date + 'T00:00:00Z') + days * DAY)
    .toISOString()
    .slice(0, 10);
}
export function readWindow(
  query: {
    date?: string;
    range?: string;
    view?: string;
    calendar_view?: string;
    from?: string;
    to?: string;
  },
  timeZone: string,
  now: number,
) {
  const today = query.date ?? civilDate(now, timeZone);
  const calendarRange = query.calendar_view
    ? (
        { day: 'today', week: 'week', month: 'month' } as Record<string, string>
      )[query.calendar_view]
    : undefined;
  if (query.calendar_view && !calendarRange)
    throw new StyleError('invalid_display');
  const range =
    query.range ??
    (query.view === 'date' ? 'today' : query.view) ??
    calendarRange ??
    'today';
  if (
    !validRestaurantDate(today) ||
    !['today', 'week', 'month'].includes(range) ||
    (query.view && !['today', 'week', 'month', 'date'].includes(query.view))
  )
    throw new StyleError('invalid_date');
  if (
    query.range &&
    query.view &&
    query.view !== 'date' &&
    query.range !== query.view
  )
    throw new StyleError('invalid_range');
  if (calendarRange && calendarRange !== range)
    throw new StyleError('invalid_range');
  const weekday = new Date(today + 'T00:00:00Z').getUTCDay();
  const start =
    range === 'week'
      ? addDate(today, -(weekday + 6) % 7)
      : range === 'month'
        ? today.slice(0, 8) + '01'
        : today;
  const nextMonth = new Date(start + 'T00:00:00Z');
  nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1, 1);
  const fromDate = query.from ?? start;
  const toDate =
    query.to ??
    (range === 'month'
      ? nextMonth.toISOString().slice(0, 10)
      : addDate(fromDate, range === 'week' ? 7 : 1));
  if (
    !validRestaurantDate(fromDate) ||
    !validRestaurantDate(toDate) ||
    fromDate >= toDate ||
    Date.parse(toDate) - Date.parse(fromDate) > 366 * DAY
  )
    throw new StyleError('invalid_date');
  return {
    from: restaurantCivilTime(fromDate, 0, timeZone),
    to: restaurantCivilTime(toDate, 0, timeZone),
    fromDate,
    toDate,
    range: range as 'today' | 'week' | 'month',
  };
}
