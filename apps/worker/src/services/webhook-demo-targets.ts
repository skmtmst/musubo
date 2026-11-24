import { activeTenantLineAccountSql } from '@line-crm/db';
import { DEFAULT_TENANT_ID } from '@line-crm/shared';
export interface WebhookDemoTarget {
 line_user_id: string; line_account_id: string; channel_access_token: string; channel_access_token_encrypted: string | null;
}
/** 体験送信先。通常の送信と同じく店と統括の状態を確認する境界。 */
export async function webhookDemoTargets(db: D1Database, userId: string, sourceAccountId: string): Promise<WebhookDemoTarget[]> {
 const rows=await db.prepare(`SELECT f.line_platform_user_id AS line_user_id, f.line_account_id, la.channel_access_token, la.channel_access_token_encrypted
 FROM friends f JOIN line_accounts la ON la.id=f.line_account_id
 JOIN line_accounts source ON source.id=?
 WHERE f.user_id=? AND f.line_account_id<>source.id AND f.is_following=1
 AND la.is_active=1 AND la.archived_at IS NULL
 AND source.is_active=1 AND source.archived_at IS NULL
 AND COALESCE(la.tenant_id,?)=COALESCE(source.tenant_id,?)
 AND ${activeTenantLineAccountSql('la.id')} AND ${activeTenantLineAccountSql('source.id')}`)
 .bind(sourceAccountId,userId,DEFAULT_TENANT_ID,DEFAULT_TENANT_ID).all<WebhookDemoTarget>();
 return rows.results;
}
