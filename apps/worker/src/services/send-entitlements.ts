import { logger } from '@line-crm/shared/server';
import { getTenantBilling } from '@line-crm/db';
import { DEFAULT_TENANT_ID } from '../lib/tenant.js';
import { resolveTenantEntitlements, type Entitlements } from './billing-plans.js';

/**
 * 「この店舗（LINE公式アカウント）の統括は、いま配信できるか」。
 *
 * 一斉配信・シナリオ・リマインダ・自動応答が送る直前に呼ぶ。
 * 止まる理由は課金の状態だけ（トライアル終了・解約）。既存の統括は
 * 課金対象外なので、この判定で止まることはない（migration 291）。
 *
 * **取れないときは止めない。** 課金の表が読めないだけで配信を潰すと、
 * 送れるはずの配信が届かなくなる。読めなかったら「送ってよい」として通す。
 */

export interface SendPermission {
  allowed: boolean;
  reason: string | null;
  tenantId: string;
  state: Entitlements['state'] | 'unknown';
}

export type SendPermissionCache = Map<string, SendPermission>;

const ALLOW_UNKNOWN: Omit<SendPermission, 'tenantId'> = { allowed: true, reason: null, state: 'unknown' };

async function tenantIdOfAccount(db: D1Database, lineAccountId: string | null): Promise<string> {
  if (!lineAccountId) return DEFAULT_TENANT_ID;
  try {
    const row = await db
      .prepare('SELECT tenant_id FROM line_accounts WHERE id = ?')
      .bind(lineAccountId)
      .first<{ tenant_id: string | null }>();
    return row?.tenant_id ?? DEFAULT_TENANT_ID;
  } catch {
    return DEFAULT_TENANT_ID;
  }
}

export async function getSendPermissionForTenant(
  db: D1Database,
  tenantId: string,
  cache?: SendPermissionCache,
): Promise<SendPermission> {
  const hit = cache?.get(tenantId);
  if (hit) return hit;
  let result: SendPermission;
  try {
    const billing = (await getTenantBilling(db, tenantId)) ?? null;
    const entitlements = await resolveTenantEntitlements(db, billing);
    result = { allowed: entitlements.canSend, reason: entitlements.blockedReason, tenantId, state: entitlements.state };
  } catch (error) {
    logger.warn("send_entitlements.get_send_permission_for_tenant_failed");
    result = { ...ALLOW_UNKNOWN, tenantId };
  }
  cache?.set(tenantId, result);
  return result;
}

/** 店舗（LINE公式アカウント）から統括を引いて判定する。 */
export async function getSendPermissionForAccount(
  db: D1Database,
  lineAccountId: string | null,
  cache?: SendPermissionCache,
): Promise<SendPermission> {
  const tenantId = await tenantIdOfAccount(db, lineAccountId);
  return getSendPermissionForTenant(db, tenantId, cache);
}
