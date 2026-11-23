import { DEFAULT_TENANT_ID } from '../lib/tenant.js';

/** Prepare the internal zero-capacity store in the style save transaction. */
export function restaurantWorkspaceStatements(db: D1Database, accountId: string, tenantId: string | null) {
  const tenant = tenantId ?? DEFAULT_TENANT_ID;
  const storeId = crypto.randomUUID();
  const unassignedAccount = `a.id = ? AND COALESCE(a.tenant_id, ?) = ?
    AND a.is_active = 1 AND a.archived_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM rt_stores WHERE line_account_id = a.id)`;
  return [
    db.prepare(`INSERT INTO rt_organizations (id, account_id, tenant_id, name, status)
      SELECT ?, t.id, t.id, t.name, 'active'
      FROM line_accounts a JOIN tenants t ON t.id = COALESCE(a.tenant_id, ?)
      WHERE ${unassignedAccount}
      ON CONFLICT(tenant_id) DO NOTHING`)
      .bind(crypto.randomUUID(), DEFAULT_TENANT_ID, accountId, DEFAULT_TENANT_ID, tenant),
    db.prepare(`INSERT INTO rt_stores (id, organization_id, name, code, capacity, timezone, line_account_id)
      SELECT ?, o.id, a.name,
        CASE WHEN EXISTS (
          SELECT 1 FROM rt_stores WHERE organization_id = o.id AND code = 'line-' || a.id
        ) THEN ? ELSE 'line-' || a.id END,
        0, 'Asia/Tokyo', a.id
      FROM line_accounts a JOIN rt_organizations o ON o.tenant_id = COALESCE(a.tenant_id, ?)
      WHERE ${unassignedAccount}`)
      .bind(storeId, `line-${storeId}`, DEFAULT_TENANT_ID, accountId, DEFAULT_TENANT_ID, tenant),
  ];
}
