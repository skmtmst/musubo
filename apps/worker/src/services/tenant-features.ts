import type { Context } from 'hono';
import type { Env } from '../worker-env.js';
import { restaurantTestEnabled } from '../lib/environment-features.js';
import { DEFAULT_TENANT_ID } from '../lib/tenant.js';
import { dbFor } from './db-router.js';

/**
 * 統括（テナント）が指定の機能パックを持っているか。
 *
 * `tenants.feature_packs` はこれまで運営コンソールの表示専用ラベルだったが、
 * 統括単位で飲食店機能を実効的にオン/オフするため、ここで読む側を作る。
 */
export async function tenantHasFeaturePack(
  db: D1Database,
  tenantId: string,
  pack: string,
): Promise<boolean> {
  const row = await db
    .prepare('SELECT feature_packs FROM tenants WHERE id = ?')
    .bind(tenantId)
    .first<{ feature_packs: string }>();
  if (!row) return false;
  try {
    const packs = JSON.parse(row.feature_packs) as unknown;
    return Array.isArray(packs) && packs.includes(pack);
  } catch {
    return false;
  }
}

/** 保存済みの飲食店スタイルは、選択したLINEアカウントの基本機能だけを有効にする。 */
export async function restaurantAccessMode(
  c: Context<Env>,
  accountId: string | null,
): Promise<'legacy' | 'account' | null> {
  const staff = c.get('staff');
  if (!staff || !restaurantTestEnabled(c.env)) return null;
  const db = dbFor(c.env);
  const tenantId = staff.tenantId ?? DEFAULT_TENANT_ID;
  if (await tenantHasFeaturePack(db, tenantId, 'restaurant')) return 'legacy';
  if (!accountId) return null;
  return await hasConfiguredRestaurantStyle(db, accountId, tenantId) ? 'account' : null;
}

async function hasConfiguredRestaurantStyle(db: D1Database, accountId: string, tenantId: string): Promise<boolean> {
  const configured = await db.prepare(`SELECT 1 FROM line_accounts a
    JOIN account_styles p ON p.line_account_id = a.id
    WHERE a.id = ? AND COALESCE(a.tenant_id, ?) = ?
      AND a.is_active = 1 AND a.archived_at IS NULL
      AND p.style = 'restaurant' AND p.selection_mode = 'configured' AND p.selected_at IS NOT NULL`)
    .bind(accountId, DEFAULT_TENANT_ID, tenantId).first();
  return configured !== null;
}

export async function restaurantEffectivelyEnabledForAccount(c: Context<Env>, accountId: string): Promise<boolean> {
  return (await restaurantAccessMode(c, accountId)) !== null;
}
