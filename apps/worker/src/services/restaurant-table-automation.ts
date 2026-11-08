import { getAccountSetting, saveVersionedAccountSetting } from '@line-crm/db';
import type { RestaurantTableAssignmentSettings, RestaurantTableAssignmentWrite } from '@line-crm/shared';

export const tableAutomationKey = (storeId: string) => `restaurant.table_auto_assignment:${storeId}`;

export function parseTableAutomation(raw: string | null): RestaurantTableAssignmentSettings {
  if (raw === null) return { enabled: true, version: 0 };
  const value = JSON.parse(raw);
  if (!Number.isSafeInteger(value?.version) || value.version < 1 || typeof value?.data?.enabled !== 'boolean') throw new Error('invalid_table_auto_assignment');
  return { enabled: value.data.enabled, version: value.version };
}

export async function readTableAutomation(db: D1Database, storeId: string) {
  const store = await db.prepare('SELECT line_account_id FROM rt_stores WHERE id=?').bind(storeId).first<{ line_account_id: string | null }>();
  if (!store) throw new Error('store_not_found');
  return parseTableAutomation(store.line_account_id ? await getAccountSetting(db, store.line_account_id, tableAutomationKey(storeId)) : null);
}

export async function saveTableAutomation(db: D1Database, accountId: string, storeId: string, input: RestaurantTableAssignmentWrite) {
  if (!await db.prepare('SELECT 1 FROM rt_stores WHERE id=? AND line_account_id=?').bind(storeId, accountId).first()) throw new Error('store_not_found');
  const current = await readTableAutomation(db, storeId);
  if (current.version !== input.expectedVersion) return null;
  const result = await saveVersionedAccountSetting(db, { accountId, key: tableAutomationKey(storeId), expectedVersion: input.expectedVersion, data: { enabled: input.enabled } });
  return result.status === 'saved' ? { enabled: input.enabled, version: result.setting.version } : null;
}
