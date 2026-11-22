import { DEFAULT_TENANT_ID } from '@line-crm/shared';
import { type LineAccount, type LineAccountWithTenantStatus, type TenantRuntimeStatus, type LineAccountScopeEntry } from './line-accounts-types.js';
import { resolveCredentialEncryptionKey, decryptLineAccountCredentials, TENANT_STATUS_SELECT } from './line-accounts-credentials.js';


export async function getLineAccountById(
  db: D1Database,
  id: string,
  credentialEncryptionKey?: string,
): Promise<LineAccount | null> {
  const encryptionKey = await resolveCredentialEncryptionKey(credentialEncryptionKey);
  const row = await db
    .prepare(`SELECT * FROM line_accounts WHERE id = ? AND data_purged_at IS NULL`)
    .bind(id)
    .first<LineAccount>();
  return row ? decryptLineAccountCredentials(row, encryptionKey) : null;
}

export async function getLineAccounts(
  db: D1Database,
  credentialEncryptionKey?: string,
): Promise<LineAccount[]> {
  const encryptionKey = await resolveCredentialEncryptionKey(credentialEncryptionKey);
  const result = await db
    .prepare(`SELECT * FROM line_accounts WHERE data_purged_at IS NULL ORDER BY display_order ASC, created_at ASC`)
    .all<LineAccount>();
  return Promise.all(
    result.results.map((row) => decryptLineAccountCredentials(row, encryptionKey)),
  );
}

/**
 * Lists accounts and their owning tenant status in one D1 read. The default
 * operations tenant is always available; a missing non-default tenant row is
 * treated as archived so delivery fails closed.
 * This is an inventory, not authorization: consumers must also check is_active
 * and archived_at before allowing self-service access. Stopped accounts remain
 * visible for management; irreversible purge tombstones are excluded.
 */
export async function listLineAccountsWithTenantStatus(
  db: D1Database,
  credentialEncryptionKey?: string,
  channelId?: string,
): Promise<LineAccountWithTenantStatus[]> {
  const encryptionKey = await resolveCredentialEncryptionKey(credentialEncryptionKey);
  const result = await db
    .prepare(
      `SELECT account.*, ${TENANT_STATUS_SELECT} AS tenant_status
         FROM line_accounts account
         LEFT JOIN tenants tenant
           ON tenant.id = COALESCE(account.tenant_id, ?)
        WHERE account.data_purged_at IS NULL ${channelId === undefined ? '' : 'AND account.channel_id = ?'}
        ORDER BY account.display_order ASC, account.created_at ASC`,
    )
    .bind(DEFAULT_TENANT_ID, ...(channelId === undefined ? [] : [channelId]))
    .all<LineAccountWithTenantStatus>();
  const rows = await Promise.all(
    result.results.map((row) => decryptLineAccountCredentials(row, encryptionKey)),
  );
  return rows as LineAccountWithTenantStatus[];
}

export async function getLineAccountTenantStatus(
  db: D1Database,
  lineAccountId: string,
): Promise<TenantRuntimeStatus> {
  const row = await db
    .prepare(
      `SELECT ${TENANT_STATUS_SELECT} AS tenant_status
         FROM line_accounts account
         LEFT JOIN tenants tenant
           ON tenant.id = COALESCE(account.tenant_id, ?)
        WHERE account.id = ? AND account.data_purged_at IS NULL`,
    )
    .bind(DEFAULT_TENANT_ID, lineAccountId)
    .first<{ tenant_status: TenantRuntimeStatus }>();
  return row?.tenant_status ?? 'archived';
}

export async function isLineAccountTenantActive(
  db: D1Database,
  lineAccountId: string,
): Promise<boolean> {
  return (await getLineAccountTenantStatus(db, lineAccountId)) === 'active';
}

/**
 * Returns only the non-secret account fields used by authorization scope checks.
 * The tenant wall is applied by D1 before rows enter Worker memory.
 */
export async function getLineAccountScopeEntries(
  db: D1Database,
  tenantId: string,
): Promise<LineAccountScopeEntry[]> {
  const result = await db
    .prepare(
      `SELECT id, tenant_id, parent_line_account_id, is_active, archived_at,
              login_channel_id, liff_id
         FROM line_accounts
        WHERE COALESCE(tenant_id, ?) = ? AND data_purged_at IS NULL
        ORDER BY display_order ASC, created_at ASC`,
    )
    .bind(DEFAULT_TENANT_ID, tenantId)
    .all<LineAccountScopeEntry>();
  return result.results;
}

/** Load and decrypt only accounts that a caller has already authorized. */
export async function getLineAccountsByIds(
  db: D1Database,
  ids: readonly string[],
  credentialEncryptionKey?: string,
): Promise<LineAccount[]> {
  if (ids.length === 0) return [];
  const encryptionKey = await resolveCredentialEncryptionKey(credentialEncryptionKey);
  const result = await db
    .prepare(
      `SELECT account.*
         FROM line_accounts account
         INNER JOIN json_each(?) requested
           ON account.id = CAST(requested.value AS TEXT)
        WHERE account.data_purged_at IS NULL
        ORDER BY account.display_order ASC, account.created_at ASC`,
    )
    .bind(JSON.stringify(ids))
    .all<LineAccount>();
  return Promise.all(
    result.results.map((row) => decryptLineAccountCredentials(row, encryptionKey)),
  );
}


/** LIFF検証候補だけを検索し、送信用の秘密情報は読まない。 */
export async function getLineAccountLoginChannels(
  db: D1Database,
  lookup: { accountId?: string; loginChannelId?: string },
): Promise<Array<{ id: string; tenant_id: string | null; login_channel_id: string | null }>> {
  const value = lookup.accountId || lookup.loginChannelId;
  if (!value) return [];
  const column = lookup.accountId ? 'id' : 'login_channel_id';
  const result = await db.prepare(`
    SELECT id, tenant_id, login_channel_id FROM line_accounts
     WHERE ${column} = ? AND data_purged_at IS NULL
     ORDER BY display_order ASC, created_at ASC
  `).bind(value).all<{ id: string; tenant_id: string | null; login_channel_id: string | null }>();
  return result.results;
}
