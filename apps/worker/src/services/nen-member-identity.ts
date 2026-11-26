import type { Context } from 'hono';
import type { Env } from '../worker-env.js';
import { getFriendByLineUserIdForAccount, activeTenantLineAccountSql } from '@line-crm/db';
import { verifyCallerLineIdentity } from './liff-auth.js';

export type FriendRow = {
  id: string; line_user_id: string; display_name: string | null; user_id: string | null;
  line_account_id: string | null; channel_access_token: string | null;
  channel_access_token_encrypted: string | null;
};

export async function currentFriend(c: Context<Env>): Promise<FriendRow | null> {
  const identity = await verifyCallerLineIdentity(c.req.header('Authorization'), c.env);
  if (!identity) return null;
  const friend = await getFriendByLineUserIdForAccount(
    c.env.DB,
    identity.lineUserId,
    identity.lineAccountId,
  );
  if (!friend?.is_following) return null;
  return c.env.DB.prepare(
    `SELECT f.id, f.line_platform_user_id AS line_user_id, f.display_name, f.user_id, f.line_account_id,
            a.channel_access_token, a.channel_access_token_encrypted
       FROM friends f LEFT JOIN line_accounts a ON a.id = f.line_account_id
      WHERE f.id = ? AND f.is_following = 1
        AND (f.line_account_id IS NULL OR (a.is_active = 1 AND a.archived_at IS NULL
          AND ${activeTenantLineAccountSql('a.id')})) LIMIT 1`,
  ).bind(friend.id).first<FriendRow>();
}
