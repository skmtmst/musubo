import { jstDateOffset as japanDateOffset } from '@line-crm/shared';
import { type DashboardFreshness, type DashboardOverview, type DashboardPeriod } from './dashboard-types.js';


export const FRESH_MINUTES = 5;
export const DELAYED_MINUTES = 15;
export const STALE_MINUTES = 60;

export function parseDashboardTime(value: string): number {
  const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)
    ? `${value.replace(' ', 'T')}+09:00`
    : value;
  return Date.parse(normalized);
}

/** 正本 §6-2 の境界をserver側で判定する。画面の時計では判定しない。 */
export function dashboardFreshness(
  asOf: string | null,
  options: {
    now?: number;
    failedSources?: number;
    totalSources?: number;
    checkIntervalMinutes?: number;
  } = {},
): DashboardFreshness {
  const failedSources = options.failedSources ?? 0;
  const totalSources = Math.max(options.totalSources ?? 1, 1);
  if (failedSources >= totalSources) return 'unavailable';
  if (failedSources > 0) return 'partial';
  if (!asOf) return 'unavailable';
  const timestamp = parseDashboardTime(asOf);
  if (!Number.isFinite(timestamp)) return 'unavailable';
  const ageMinutes = Math.max(0, ((options.now ?? Date.now()) - timestamp) / 60_000);
  if (
    (options.checkIntervalMinutes !== undefined
      && ageMinutes > options.checkIntervalMinutes * 2)
    || ageMinutes > STALE_MINUTES
  ) return 'stale';
  if (ageMinutes <= FRESH_MINUTES) return 'fresh';
  if (ageMinutes <= DELAYED_MINUTES) return 'delayed';
  // 共通状態は5種類だけなので、delayedの上限を超えた値はstaleへ送る。
  return 'stale';
}

export function oldestDashboardTime(values: Array<string | null | undefined>): string | null {
  const valid = values
    .filter((value): value is string => typeof value === 'string' && Number.isFinite(parseDashboardTime(value)))
    .sort((left, right) => parseDashboardTime(left) - parseDashboardTime(right));
  return valid[0] ?? null;
}

export function latestDashboardTime(values: Array<string | null | undefined>): string | null {
  const valid = values
    .filter((value): value is string => typeof value === 'string' && Number.isFinite(parseDashboardTime(value)))
    .sort((left, right) => parseDashboardTime(right) - parseDashboardTime(left));
  return valid[0] ?? null;
}

/** 一部だけ失敗した応答を unavailable ではなく partial としてまとめる。 */
export function summarizeDashboardFreshness(
  sections: DashboardOverview['sections'],
): { asOf: string | null; freshness: DashboardFreshness } {
  const values = Object.values(sections);
  const unavailable = values.filter((section) => section.freshness === 'unavailable').length;
  const freshness: DashboardFreshness = values.some((section) => section.freshness === 'partial')
    || (unavailable > 0 && unavailable < values.length)
    ? 'partial'
    : unavailable === values.length
      ? 'unavailable'
      : values.some((section) => section.freshness === 'stale')
        ? 'stale'
        : values.some((section) => section.freshness === 'delayed')
          ? 'delayed'
          : 'fresh';
  return {
    asOf: oldestDashboardTime(values.map((section) => section.asOf)),
    freshness,
  };
}

/** JST の「いまの日付」。D1 は UTC なので、日付の境目を跨ぐ集計は必ずずれる。 */
export function jstDate(offsetDays = 0): string {
  return japanDateOffset(offsetDays);
}

export function nextDate(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

export function nextMonth(month: string): string {
  const [year, rawMonth] = month.split('-').map(Number);
  return new Date(Date.UTC(year, rawMonth, 1)).toISOString().slice(0, 7);
}

/** 期間の始まり（JSTの日付）。 */
export function periodStart(period: DashboardPeriod): string {
  if (period === 'today') return jstDate(0);
  if (period === 'last7') return jstDate(-6);
  return jstDate(period === 'last90' ? -89 : period === 'last30' ? -29 : -27);
}

/** 今月の始まり（JSTの日付）。「今月の配信」は選んだ期間に関わらず今月1日から数える。 */
export function monthStart(): string {
  return `${jstDate(0).slice(0, 8)}01`;
}

/** 期間に含まれる日数。推移の折れ線の点の数になる。 */
export function periodDays(period: DashboardPeriod): number {
  if (period === 'today') return 1;
  if (period === 'last7') return 7;
  return period === 'last90' ? 90 : period === 'last30' ? 30 : 28;
}
