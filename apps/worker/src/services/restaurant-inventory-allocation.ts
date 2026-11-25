import { tzDateStr } from './availability.js';
import { restaurantTableCapacity } from './restaurant-inventory.js';

export type InventoryAllocation = {
  otaCapacity: number;
  lineCapacity: number;
  walkInCapacity: number;
};

export type InventoryAllocationSource = 'standard' | 'day' | 'slot' | 'legacy';

export type InventoryAllocationDocument = {
  version: number;
  standard: InventoryAllocation | null;
  days: Record<string, InventoryAllocation>;
  slots: Record<string, InventoryAllocation | null>;
};

export type AllocationUpdate =
  | { scope: 'standard'; allocation: InventoryAllocation }
  | { scope: 'day'; date: string; allocation: InventoryAllocation | null }
  | { scope: 'slot'; startsAt: string; allocation: InventoryAllocation | null };

export const inventoryAllocationKey = 'restaurant.inventory_allocation:';

export function parseInventoryAllocation(value: unknown): InventoryAllocation | null {
  if (!value || typeof value !== 'object') return null;
  const { otaCapacity, lineCapacity, walkInCapacity } = value as Partial<InventoryAllocation>;
  if (typeof otaCapacity !== 'number' || typeof lineCapacity !== 'number' || typeof walkInCapacity !== 'number'
    || [otaCapacity, lineCapacity, walkInCapacity].some(count => !Number.isSafeInteger(count) || count < 0)) return null;
  return { otaCapacity, lineCapacity, walkInCapacity };
}

export function parseAllocationDocument(raw: string | null): InventoryAllocationDocument {
  if (raw === null) return { version: 0, standard: null, days: {}, slots: {} };
  const settings = JSON.parse(raw) as InventoryAllocationDocument;
  if (!Number.isSafeInteger(settings.version) || settings.version < 1 || !settings.days || !settings.slots
    || (settings.standard !== null && !parseInventoryAllocation(settings.standard))
    || Object.values(settings.days).some(value => !parseInventoryAllocation(value))
    || Object.values(settings.slots).some(value => value !== null && !parseInventoryAllocation(value))) {
    throw new Error('restaurant_inventory_allocation_invalid');
  }
  return settings;
}

export async function readInventoryAllocation(db: D1Database, storeId: string) {
  const row = await db.prepare(`SELECT s.line_account_id, s.timezone, a.value
    FROM rt_stores s LEFT JOIN account_settings a ON a.line_account_id=s.line_account_id AND a.key=?
    WHERE s.id=?`).bind(inventoryAllocationKey + storeId, storeId)
    .first<{ line_account_id: string | null; timezone: string; value: string | null }>();
  const raw = row?.value ?? null;
  return { ...parseAllocationDocument(raw), raw, accountId: row?.line_account_id ?? null, timezone: row?.timezone ?? 'Asia/Tokyo' };
}

export function selectInventoryAllocation(
  settings: InventoryAllocationDocument,
  startsAt: string,
  date: string,
  legacy: InventoryAllocation | null,
): { value: InventoryAllocation | null; source: InventoryAllocationSource } {
  const slot = settings.slots[startsAt];
  if (slot) return { value: slot, source: 'slot' };
  // 設定元が不明な実枠は、時間帯ごとに戻す操作を受けたときに共通配分へ移す。
  if (legacy && slot !== null) return { value: legacy, source: 'legacy' };
  const day = settings.days[date];
  return day ? { value: day, source: 'day' } : { value: settings.standard, source: 'standard' };
}

const sum = (allocation: InventoryAllocation): number =>
  allocation.otaCapacity + allocation.lineCapacity + allocation.walkInCapacity;

/** 停止中の枠を保ち、実枠のLINE予約上限と同じ配分を保存する。 */
export async function saveInventoryAllocation(
  db: D1Database,
  storeId: string,
  changedBy: string,
  expectedVersion: number,
  update: AllocationUpdate,
): Promise<'conflict' | 'unlinked' | 'capacity' | { version: number }> {
  const current = await readInventoryAllocation(db, storeId);
  if (!current.accountId) return 'unlinked';
  if (expectedVersion !== current.version) return 'conflict';
  const total = await restaurantTableCapacity(db, storeId);
  if (update.allocation && sum(update.allocation) > total) return 'capacity';

  const settings: InventoryAllocationDocument = {
    version: current.version + 1,
    standard: current.standard,
    days: current.days,
    slots: current.slots,
  };
  if (update.scope === 'standard') settings.standard = update.allocation;
  else if (update.scope === 'day') {
    if (update.allocation === null) delete settings.days[update.date];
    else settings.days[update.date] = update.allocation;
  } else settings.slots[update.startsAt] = update.allocation;

  const today = tzDateStr(current.timezone, new Date());
  const affected = Object.entries(settings.slots)
    .map(([startsAt, override]) => ({ startsAt, override, date: tzDateStr(current.timezone, new Date(startsAt)) }))
    .filter(item => update.scope === 'slot' ? item.startsAt === update.startsAt
      : item.override === null && item.date >= today && (update.scope !== 'day' || item.date === update.date))
    .map(({ startsAt, date }) => ({
      startsAt,
      allocation: selectInventoryAllocation(settings, startsAt, date, null).value
        ?? { otaCapacity: 0, lineCapacity: 0, walkInCapacity: 0 },
    }));

  const affectedJson = JSON.stringify(affected);
  const key = inventoryAllocationKey + storeId;
  const raw = JSON.stringify(settings);
  // 共通配分と実枠を同じbatchで保存する。実枠のDB制約でも最新の配分が適用される。
  const save = db.prepare(`INSERT INTO account_settings(id, line_account_id, key, value)
    SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM rt_stores WHERE id=? AND line_account_id=?)
      AND (SELECT value FROM account_settings WHERE line_account_id=? AND key=?) IS ?
      AND ? <= COALESCE((SELECT SUM(max_capacity) FROM rt_tables WHERE store_id=? AND is_active=1),0)
      AND NOT EXISTS(SELECT 1 FROM json_each(?) u JOIN rt_inventory_slots i
        ON i.store_id=? AND julianday(i.starts_at)=julianday(json_extract(u.value,'$.startsAt'))
        WHERE COALESCE(i.auto_same_day_original,i.same_day_capacity)
          + json_extract(u.value,'$.allocation.otaCapacity')
          + json_extract(u.value,'$.allocation.lineCapacity')
          + json_extract(u.value,'$.allocation.walkInCapacity') > COALESCE(
            (SELECT SUM(max_capacity) FROM rt_tables WHERE store_id=i.store_id AND is_active=1),0))
    ON CONFLICT(line_account_id,key) DO UPDATE SET value=excluded.value,
      updated_at=datetime('now'),confirmation_revision=account_settings.confirmation_revision+1`)
    .bind(crypto.randomUUID(),current.accountId,key,raw,storeId,current.accountId,current.accountId,key,current.raw,
      update.allocation ? sum(update.allocation) : 0,storeId,affectedJson,storeId);
  const sync = db.prepare(`WITH allocations AS (
    SELECT julianday(json_extract(value,'$.startsAt')) AS starts,
      json_extract(value,'$.allocation') AS allocation FROM json_each(?)
    ) UPDATE rt_inventory_slots AS i SET
      ota_capacity=json_extract(allocations.allocation,'$.otaCapacity'),
      line_capacity=CASE WHEN i.auto_line_original IS NULL THEN json_extract(allocations.allocation,'$.lineCapacity') ELSE 0 END,
      auto_line_original=CASE WHEN i.auto_line_original IS NULL THEN NULL ELSE NULLIF(json_extract(allocations.allocation,'$.lineCapacity'),0) END,
      walk_in_capacity=json_extract(allocations.allocation,'$.walkInCapacity'),
      version=i.version+1, updated_by=?,updated_at=datetime('now')
    FROM allocations WHERE i.store_id=? AND julianday(i.starts_at)=allocations.starts AND changes()=1`)
    .bind(affectedJson,changedBy,storeId);
  const [result] = await db.batch([save, sync]);
  return result.meta.changes ? { version: settings.version } : 'conflict';
}
