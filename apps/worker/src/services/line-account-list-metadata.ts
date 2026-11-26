import { getLineAccountFoldersByAccountIds, getLineAccountListStats, getLineAccountTagsByAccountIds } from '@line-crm/db';

/** 同じ可視一覧を使う独立した読取を並行し、一覧の補足情報をそろえる。 */
export async function readLineAccountListMetadata(db: D1Database, tenantId: string, accountIds: string[]) {
  const [tagsByAccount, foldersByAccount, statsByAccount, emailSettings] = await Promise.all([
    getLineAccountTagsByAccountIds(db, tenantId, accountIds),
    getLineAccountFoldersByAccountIds(db, tenantId, accountIds),
    getLineAccountListStats(db, accountIds),
    db.prepare("SELECT line_account_id, key FROM account_settings WHERE key IN ('inbox_email_legacy_enabled','inbox_email_forwarding_connected') AND value = 'true'")
      .all<{ line_account_id: string; key: string }>(),
  ]);
  const visibleIds = new Set(accountIds);
  const enabledAccounts = (key: string) => new Set(emailSettings.results
    .filter(row => row.key === key && visibleIds.has(row.line_account_id))
    .map(row => row.line_account_id));
  const legacy = enabledAccounts('inbox_email_legacy_enabled');
  const connected = enabledAccounts('inbox_email_forwarding_connected');
  return { tagsByAccount, foldersByAccount, statsByAccount,
    emailCapabilities: (id: string) => ({emailInboxEnabled:legacy.has(id), accountEmailInboxEnabled:connected.has(id)}) };

}
