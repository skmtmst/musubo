import type { Context } from 'hono';
import type { Env } from '../worker-env.js';
import { inputError } from '../lib/input-errors.js';
import { tzDateStr } from '../services/availability.js';
import { restaurantCivilTime, validRestaurantDate } from '../services/restaurant-booking.js';
import { publicClosure } from '../services/restaurant-closures.js';
import { parseInventoryAllocation, readInventoryAllocation, saveInventoryAllocation, selectInventoryAllocation, type AllocationUpdate } from '../services/restaurant-inventory-allocation.js';
import { inventoryWindowOccupancy, readInventorySchedule, stopsInventoryLine } from '../services/restaurant-inventory-schedule.js';
import { restaurantSeatCapacity } from '../services/restaurant-seat-capacity.js';

type PersistedInventoryRow = Record<string, unknown> & {
  id: string;
  starts_at: string;
  slot_minutes: number;
  total_capacity: number;
  ota_capacity: number;
  line_capacity: number;
  walk_in_capacity: number;
  auto_line_original: number | null;
  occupied_table_ids_json: string;
  occupied_seats: number;
  unassigned_guests: number;
  guest_count: number;
};

export async function saveScopedInventoryAllocation(c: Context<Env>, db: D1Database, storeId: string, body: Record<string, unknown>) {
  const allocation = parseInventoryAllocation(body.allocation);
  const version = body.expectedVersion;
  const fields = ['scope', 'expectedVersion', 'allocation', 'date', 'startsAt'];
  const invalid = () => inputError(c, { success: false, error: '配分を変更する範囲と版を確認してください' }, 400, fields);
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0
    || (body.allocation !== null && !allocation)) return invalid();
  let update: AllocationUpdate;
  if (body.scope === 'standard' && allocation) {
    update = { scope: 'standard', allocation };
  } else if (body.scope === 'day' && typeof body.date === 'string' && validRestaurantDate(body.date)) {
    update = { scope: 'day', date: body.date, allocation };
  } else if (body.scope === 'slot' && typeof body.startsAt === 'string' && Number.isFinite(Date.parse(body.startsAt))) {
    update = { scope: 'slot', startsAt: new Date(body.startsAt).toISOString(), allocation };
  } else return invalid();

  if (update.scope !== 'standard') {
    const current = await readInventoryAllocation(db, storeId);
    const date = update.scope === 'day' ? update.date : tzDateStr(current.timezone, new Date(update.startsAt));
    const schedule = await readInventorySchedule(db, storeId, current.timezone, date);
    if (allocation && schedule.hoursStatus === 'closed') {
      return c.json({ success: false, code: 'inventory_closed', error: 'この日は休業です' }, 409);
    }
    if (update.scope === 'slot') {
      const stored = await db.prepare('SELECT 1 FROM rt_inventory_slots WHERE store_id=? AND julianday(starts_at)=julianday(?)')
        .bind(storeId, update.startsAt).first();
      const startsAt = update.startsAt;
      if (!stored && !schedule.windows.some(window => window.startsAt === startsAt)) return invalid();
    }
    if (update.scope === 'day' && !schedule.windows.length && allocation) {
      return c.json({ success: false, code: 'hours_not_configured', error: 'この日の営業時間を確認してください' }, 409);
    }
  }
  const result = await saveInventoryAllocation(db, storeId, c.get('staff')!.id, version, update);
  if (result === 'capacity') return inputError(c, { success: false, error: '稼働中の席数以内で配分してください' }, 400, ['allocation']);
  if (result === 'unlinked') return c.json({ success: false, code: 'line_account_not_connected', error: 'この店舗のLINEアカウントを接続してください' }, 409);
  if (result === 'conflict') return c.json({ success: false, code: 'version_conflict', error: '配分や卓が変更されました。読み直してください' }, 409);
  return c.json({ success: true, data: result });
}

export async function readScopedInventoryDay(db: D1Database, storeId: string, date: string) {
  const settings = await readInventoryAllocation(db, storeId);
  const from = restaurantCivilTime(date, 0, settings.timezone);
  const to = restaurantCivilTime(date, 1440, settings.timezone);
  const [schedule, stored, capacity] = await Promise.all([
    readInventorySchedule(db, storeId, settings.timezone, date),
    db.prepare(`SELECT v.*, sm.name AS updated_by_name FROM rt_inventory_occupancy v
      LEFT JOIN staff_members sm ON sm.id=v.updated_by
      WHERE v.store_id=? AND datetime(v.starts_at)>=datetime(?) AND datetime(v.starts_at)<datetime(?) ORDER BY v.starts_at`)
      .bind(storeId, from, to).all<PersistedInventoryRow>(),
    restaurantSeatCapacity(db, storeId, from, to),
  ]);
  const legacy = stored.results.map(row => {
    const startsAt = new Date(row.starts_at).toISOString();
    const endsAt = new Date(Date.parse(startsAt) + row.slot_minutes * 60_000).toISOString();
    const occupancy = inventoryWindowOccupancy(capacity.state, startsAt, endsAt);
    const occupiedTableIds = JSON.parse(row.occupied_table_ids_json) as string[];
    const closedSeats = capacity.state.tables.filter(table => occupancy.closedIds.includes(table.id) && !occupiedTableIds.includes(table.id))
      .reduce((count, table) => count + table.maxCapacity, 0);
    const allocationSource = selectInventoryAllocation(settings, startsAt, date, {
      otaCapacity: row.ota_capacity, lineCapacity: row.auto_line_original ?? row.line_capacity, walkInCapacity: row.walk_in_capacity,
    }).source;
    return {
      ...row, reserved_count: row.guest_count, occupiedTableIds, closedTableIds: occupancy.closedIds,
      freeSeats: Math.max(0, row.total_capacity - row.occupied_seats - row.unassigned_guests - closedSeats), allocationSource,
    };
  });
  const virtual = schedule.windows.filter(window => !legacy.some(slot => Date.parse(slot.starts_at) === Date.parse(window.startsAt))).map(window => {
    const { value, source } = selectInventoryAllocation(settings, window.startsAt, date, null);
    const occupancy = inventoryWindowOccupancy(capacity.state, window.startsAt, window.endsAt);
    const line = value?.lineCapacity ?? 0;
    const stopLine = line > 0 && stopsInventoryLine(capacity.state.inventoryRule ?? null, occupancy.freeForRule);
    return {
      id: `operating:${window.startsAt}`,
      store_id: storeId,
      starts_at: window.startsAt,
      slot_minutes: (Date.parse(window.endsAt)-Date.parse(window.startsAt)) / 60_000,
      total_capacity: occupancy.total,
      ota_capacity: value?.otaCapacity ?? 0,
      line_capacity: stopLine ? 0 : line,
      walk_in_capacity: value?.walkInCapacity ?? 0,
      same_day_capacity: 0,
      auto_line_original: stopLine ? line : null,
      auto_same_day_original: null,
      reserved_count: occupancy.guests,
      occupied_seats: occupancy.occupiedSeats,
      unassigned_guests: occupancy.unassignedGuests,
      occupiedTableIds: occupancy.occupiedIds,
      closedTableIds: occupancy.closedIds,
      freeSeats: occupancy.freeSeats,
      version: settings.version,
      allocationSource: source,
    };
  });
  return {
    success: true as const,
    allocation: { version: settings.version, standard: settings.standard, day: settings.days[date] ?? null, hoursStatus: schedule.hoursStatus },
    closures: schedule.closures.map(publicClosure),
    data: [...legacy, ...virtual].sort((a,b) => Date.parse(a.starts_at) - Date.parse(b.starts_at)),
  };
}
