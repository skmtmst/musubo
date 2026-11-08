import type { Context } from 'hono';
import type { Env } from '../worker-env.js';
import { inputError } from '../lib/input-errors.js';
import { dbFor } from '../services/db-router.js';
import { readTableAutomation, saveTableAutomation } from '../services/restaurant-table-automation.js';
import { accountId, hasOrganizationSelector, organizationFor, requiredAccount, storeBelongsTo } from './restaurant-test-definition.js';

/** 統括・アカウント・店舗・予約設定権限を既存の飲食店ルートと同じ順に検査する。 */
export async function restaurantTableAutomationResponse(c: Context<Env>) {
  c.header('Cache-Control', 'no-store');
  if (!hasOrganizationSelector(c)) return requiredAccount(c);
  const org = await organizationFor(c), storeId = c.req.query('storeId'), account = accountId(c);
  if (!org || !storeId || !account || !await storeBelongsTo(c, org.id, storeId)) return c.json({ success: false, error: 'store_not_found' }, 404);
  const db = dbFor(c.env, storeId);
  if (!await db.prepare('SELECT 1 FROM rt_stores WHERE id=? AND line_account_id=?').bind(storeId, account).first()) return c.json({ success: false, error: 'store_not_found' }, 404);
  try {
    if (c.req.method === 'GET') return c.json({ success: true, data: await readTableAutomation(db, storeId) });
    if (c.get('staff')?.readOnly) return c.json({ success: false, error: 'forbidden' }, 403);
    const input = await c.req.json().catch(() => null);
    if (!input || typeof input.enabled !== 'boolean' || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0 || input.expectedVersion >= Number.MAX_SAFE_INTEGER)
      return inputError(c, { success: false, error: 'invalid_table_auto_assignment' }, 400, ['enabled', 'expectedVersion']);
    const saved = await saveTableAutomation(db, account, storeId, input);
    return saved ? c.json({ success: true, data: saved }) : c.json({ success: false, error: 'version_conflict' }, 409);
  } catch { return c.json({ success: false, error: 'table_auto_assignment_unavailable' }, 503); }
}
