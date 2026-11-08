import { readTableAutomation } from '../../services/restaurant-table-automation.js';
import type { RestaurantSeatAvailability } from '@line-crm/shared';
import { tzDateStr } from '../../services/availability.js';
import { restaurantCivilTime } from '../../services/restaurant-booking.js';
import { defaultAssignmentResource, d1AssignmentSettingsStore, type AssignmentScope, type AssignmentSettingsStore } from './booking-assignment-settings.js';
import { selectAssignment, type AssignmentCandidate } from './booking-assignment-selector.js';

/** 暦日の加減で週を作る。夏時間の日にも24時間を足して境界をずらさない。 */
export function assignmentWindows(startsAt: string, timezone: string, period: 'day' | 'week') {
  const date = tzDateStr(timezone, new Date(startsAt));
  const civil = new Date(`${date}T00:00:00Z`);
  const shift = (days: number) => new Date(civil.getTime() + days * 86400000).toISOString().slice(0, 10);
  const monday = (civil.getUTCDay() + 6) % 7;
  return {
    dayFrom: restaurantCivilTime(date, 0, timezone), dayTo: restaurantCivilTime(shift(1), 0, timezone),
    from: restaurantCivilTime(period === 'week' ? shift(-monday) : date, 0, timezone),
    to: restaurantCivilTime(period === 'week' ? shift(7 - monday) : shift(1), 0, timezone),
  };
}

type Counts = { id: string; periodCount: number; dailyCount: number; lastAssignedAt: string | null };
type SelectionOptions = { store?: AssignmentSettingsStore; random?: () => number; excludeReservationId?: string };

async function assignmentCandidates(db: D1Database, scope: AssignmentScope, startsAt: string, timezone: string, ids: string[], options: SelectionOptions) {
  const settings = await (options.store ?? d1AssignmentSettingsStore(db)).read(scope);
  const rules = new Map(settings.resources.map(r => [r.resourceId, r]));
  if (!settings.storageReady) return { method: 'legacy_first' as const, candidates: ids.map(id => ({
    id, ...defaultAssignmentResource(id), dailyCount: 0, periodCount: 0, lastAssignedAt: null,
  })) };
  const w = assignmentWindows(startsAt, timezone, settings.balancePeriod);
  const countSql = `SUM(CASE WHEN julianday(r.starts_at)>=julianday(?) AND julianday(r.starts_at)<julianday(?) THEN 1 ELSE 0 END) AS periodCount,strftime('%Y-%m-%dT%H:%M:%fZ',MAX(julianday(r.requested_at))) AS lastAssignedAt,SUM(CASE WHEN julianday(r.starts_at)>=julianday(?) AND julianday(r.starts_at)<julianday(?) THEN 1 ELSE 0 END) AS dailyCount`;
  const rows = scope.kind === 'staff'
    ? await db.prepare(`SELECT r.staff_id AS id,${countSql} FROM bookings r WHERE r.line_account_id=?
        AND r.status IN ('requested','confirmed','completed') AND r.id<>?
        GROUP BY r.staff_id`)
      .bind(w.from, w.to, w.dayFrom, w.dayTo, scope.id, options.excludeReservationId ?? '').all<Counts>()
    : await db.prepare(`SELECT l.table_id AS id,${countSql.replace('r.requested_at', 'r.created_at')} FROM rt_reservations r
        JOIN rt_reservation_table_links l ON l.reservation_id=r.id WHERE r.store_id=? AND r.id<>?
        AND r.status IN ('pending','confirmed','seated','visited')
        AND (r.status<>'pending' OR r.hold_expires_at IS NULL OR julianday(r.hold_expires_at)>julianday('now'))
        GROUP BY l.table_id`)
      .bind(w.from, w.to, w.dayFrom, w.dayTo, scope.id, options.excludeReservationId ?? '').all<Counts>();
  const counts = new Map(rows.results.map(r => [r.id, r]));
  return { method: settings.method, candidates: ids.map(id => ({ id, ...(rules.get(id) ?? defaultAssignmentResource(id)),
    dailyCount: counts.get(id)?.dailyCount ?? 0, periodCount: counts.get(id)?.periodCount ?? 0, lastAssignedAt: counts.get(id)?.lastAssignedAt ?? null })) };
}

/** 空き枠に存在する本当の担当者IDだけを受け取る。 */
export async function assignBookingStaff(db: D1Database, accountId: string, startsAt: string, timezone: string, availableIds: string[], options: SelectionOptions = {}) {
  if (!availableIds.length) return null;
  const { method, candidates } = await assignmentCandidates(db, { kind: 'staff', id: accountId }, startsAt, timezone, availableIds, options);
  return selectAssignment(candidates, { method, random: options.random })?.id ?? null;
}

/** 飲食店は最小の空き卓から固定順で選ぶ。担当スタッフの均等化設定と分離する。 */
export async function assignRestaurantTable(db: D1Database, storeId: string, _startsAt: string, guestCount: number,
  tables: RestaurantSeatAvailability['tables'], _options: SelectionOptions = {}) {
  if (!tables.length || !(await readTableAutomation(db, storeId)).enabled) return null;
  return [...tables].filter(t => t.minCapacity <= guestCount && guestCount <= t.maxCapacity)
    .sort((a, b) => a.maxCapacity - b.maxCapacity || a.id.localeCompare(b.id))[0] ?? null;
}
