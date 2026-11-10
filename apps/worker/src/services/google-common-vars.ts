import { resolveCommonVarValuesAt } from '@line-crm/db';
import { accountOpeningHours, openingWeek } from './account-opening-hours.js';

/** Existing business_hours common variables keep their identity/version for send snapshots; Google supplies their text. */
export async function resolveMusuboCommonVarsAt(
  db: D1Database, accountId: string, keys: string[], executionAt: string,
): ReturnType<typeof resolveCommonVarValuesAt> {
  const resolved = await resolveCommonVarValuesAt(db, accountId, keys, executionAt);
  if (!keys.includes('business_hours')) return resolved;
  const state = await accountOpeningHours(db, accountId);
  if (state.source === 'manual') return resolved;
  if (!resolved.ok) return resolved;
  if (state.source === 'google_unavailable') return { ok: false, failures: [{ varKey: 'business_hours', reason: 'missing' }] };
  const week = openingWeek(state);
  if (!week) return { ok: false, failures: [{ varKey: 'business_hours', reason: 'missing' }] };
  const weekdays = ['日', '月', '火', '水', '木', '金', '土'];
  const lines = week.map(day => `${weekdays[day.weekday]}：${day.intervals.length
    ? day.intervals.map(interval => `${interval.start}〜${interval.end}`).join('、') : '休業'}`);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(executionAt));
  const limit = new Date(`${today}T00:00:00Z`);
  limit.setUTCDate(limit.getUTCDate() + 30);
  const until = limit.toISOString().slice(0, 10);
  const specials = state.profile.specialHours.filter(day => today <= day.date && day.date <= until)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(day => `${day.date}：${day.closed ? '休業' : day.periods.map(period => `${period.open}〜${period.close}`).join('、')}`);
  const value = [...lines, ...specials].join('\n');
  return {
    ok: true,
    values: { ...resolved.values, business_hours: value },
    entries: resolved.entries.map(entry => entry.varKey === 'business_hours' ? { ...entry, value } : entry),
  };
}
