import { DEFAULT_TENANT_ID } from '@line-crm/shared';
import { getLineAccountById, getFriendByLineUserIdForAccount, isLineAccountTenantActive, type TrackedLink } from '@line-crm/db';
import { navigationProof, verifyNavigationProof } from '../lib/navigation-proof.js';

const MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const PURPOSE = 'tracked-click-identity:v1';

/** 所有アカウントがない古いリンクを、別のアカウントへ推測で割り当てない。 */
export async function resolveTrackedLinkAccountId(db: D1Database, link: TrackedLink): Promise<string | null | undefined> {
  if (link.line_account_id) return link.line_account_id;
  if (!link.scenario_id) return null;
  const scenario = await db.prepare('SELECT line_account_id FROM scenarios WHERE id = ?')
    .bind(link.scenario_id).first<{ line_account_id: string | null }>();
  return scenario ? scenario.line_account_id : undefined;
}

export async function trackedLinkSigningAccount(db: D1Database, accountId: string | null) {
  if (accountId) return getLineAccountById(db, accountId);
  const legacy = await db.prepare(`SELECT id FROM line_accounts WHERE is_default = 1
    AND COALESCE(tenant_id, ?) = ? AND is_active = 1 AND archived_at IS NULL LIMIT 1`)
    .bind(DEFAULT_TENANT_ID, DEFAULT_TENANT_ID).first<{ id: string }>();
  return legacy ? getLineAccountById(db, legacy.id) : null;
}

export async function trackedLinkFriendMatches(db: D1Database, friendId: string, accountId: string | null): Promise<boolean> {
  const friend = await db.prepare('SELECT line_platform_user_id AS line_user_id FROM friends WHERE id = ?')
    .bind(friendId).first<{ line_user_id: string | null }>();
  if (!friend?.line_user_id) return false;
  const scoped = await getFriendByLineUserIdForAccount(db, friend.line_user_id, accountId);
  return scoped?.id === friendId;
}

/** URLを持つ人に限る期限付き資格。リンク・友だち・店のどれも差し替えられない。 */
export async function issueTrackedLinkIdentity(db: D1Database, link: TrackedLink, friendId: string,
  maxAgeSeconds = MAX_AGE_SECONDS): Promise<string | null> {
  const accountId = await resolveTrackedLinkAccountId(db, link);
  if (accountId === undefined || !link.is_active || !await trackedLinkFriendMatches(db, friendId, accountId)) return null;
  const account = await trackedLinkSigningAccount(db, accountId);
  if (!account?.channel_secret || !account.is_active || account.archived_at
    || !await isLineAccountTenantActive(db, account.id)) return null;
  const now = Math.floor(Date.now() / 1000);
  const value = JSON.stringify({ link: link.id, friend: friendId, account: accountId,
    iat: now, exp: now + Math.min(Math.max(maxAgeSeconds, 1), MAX_AGE_SECONDS) });
  const payload = btoa(value).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  return `${payload}.${await navigationProof(account.channel_secret, PURPOSE, payload)}`;
}

export async function verifyTrackedLinkIdentity(db: D1Database, link: TrackedLink, token: string): Promise<string | null> {
  if (token.length > 4096) return null;
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra !== undefined || !/^[A-Za-z0-9_-]+$/.test(payload)) return null;
  try {
    const data = JSON.parse(atob(payload.replaceAll('-', '+').replaceAll('_', '/'))) as Record<string, unknown>;
    const now = Math.floor(Date.now() / 1000);
    const accountId = await resolveTrackedLinkAccountId(db, link);
    if (accountId === undefined || data.link !== link.id || data.account !== accountId || typeof data.friend !== 'string' || !data.friend
      || typeof data.iat !== 'number' || !Number.isSafeInteger(data.iat) || data.iat > now
      || typeof data.exp !== 'number' || !Number.isSafeInteger(data.exp) || data.exp <= now
      || data.exp <= data.iat || data.exp - data.iat > MAX_AGE_SECONDS) return null;
    const account = await trackedLinkSigningAccount(db, accountId);
    if (!account?.channel_secret || !account.is_active || account.archived_at
      || !await isLineAccountTenantActive(db, account.id)
      || !await verifyNavigationProof(account.channel_secret, PURPOSE, payload, signature)
      || !await trackedLinkFriendMatches(db, data.friend, accountId)) return null;
    return data.friend;
  } catch { return null; }
}


/** フォーム案内の帰属は稼働中の同じ店のリンクだけ。未割当の旧リンクは既定統括に限る。 */
export async function trackedLinkReferralMatchesAccount(db: D1Database, link: TrackedLink,
  friendAccountId: string | null): Promise<boolean> {
  if (!link.is_active) return false;
  const owner = await resolveTrackedLinkAccountId(db, link);
  if (owner === undefined) return false;
  if (owner === friendAccountId) return true;
  if (owner !== null || !friendAccountId) return false;
  const account = await getLineAccountById(db, friendAccountId);
  return !!account && (account.tenant_id ?? DEFAULT_TENANT_ID) === DEFAULT_TENANT_ID;
}
