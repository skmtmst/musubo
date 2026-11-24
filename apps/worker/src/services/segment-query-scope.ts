import { DEFAULT_TENANT_ID } from '@line-crm/shared';
import { getLineAccountScopeEntries } from '@line-crm/db';
import { sqlIdSet } from '@line-crm/db/id-queries';

type SegmentQuery = { sql: string; bindings: unknown[] };
type FriendInputScope = { allowedAccountIds: readonly string[]; canSeeUnassigned: boolean };

/** Trusted predicates restrict the input relation before any user-supplied OR/NOT conditions. */
export function restrictSegmentInput(query: SegmentQuery, predicate: string, bindings: readonly unknown[] = []): SegmentQuery {
  if (/\b(?:UNION|WITH)\b/i.test(query.sql)) throw new Error('Segment account scope could not be applied');
  if (!/^SELECT f\.id, f\.(?:line_user_id|line_platform_user_id AS line_user_id), f\.display_name FROM (?:\(SELECT \* FROM )*friends f WHERE /.test(query.sql)) throw new Error('Segment account scope could not be applied');
  const sql = query.sql
    .replace(/^SELECT f\.id, f\.line_user_id,/, 'SELECT f.id, f.line_platform_user_id AS line_user_id,')
    .replace('FROM friends f', () => `FROM (SELECT * FROM friends f WHERE ${predicate}) f`);
  return { sql, bindings: [...bindings, ...query.bindings] };
}

export function scopeSegmentQuery(query: SegmentQuery, scope: FriendInputScope): SegmentQuery {
  if (scope.allowedAccountIds.length === 1 && !scope.canSeeUnassigned) {
    return restrictSegmentInput(query, 'f.line_account_id = ?', [scope.allowedAccountIds[0]]);
  }
  const ids = sqlIdSet([...scope.allowedAccountIds]);
  return restrictSegmentInput(query,
    `(f.line_account_id IN (${ids.sql})${scope.canSeeUnassigned ? ' OR f.line_account_id IS NULL' : ''})`, ids.binds);
}

/** Unassigned legacy broadcasts belong to the default tenant, never to every tenant. */
export async function storedBroadcastFriendScope(db: D1Database, accountId: string | null | undefined) {
  const accounts = accountId == null ? await getLineAccountScopeEntries(db, DEFAULT_TENANT_ID) : [];
  return {
    allowedAccountIds: accountId == null ? accounts.map(account => account.id) : [accountId],
    canSeeUnassigned: accountId == null,
  };
}

export function scopedFriendIds(scope: FriendInputScope): SegmentQuery {
  const query = scopeSegmentQuery({
    sql: 'SELECT f.id, f.line_platform_user_id AS line_user_id, f.display_name FROM friends f WHERE 1=1', bindings: [],
  }, scope);
  return { sql: `SELECT scoped_friends.id FROM (${query.sql}) scoped_friends`, bindings: query.bindings };
}

export async function scopeStoredBroadcastSegmentQuery(
  db: D1Database, query: SegmentQuery, accountId: string | null | undefined,
): Promise<SegmentQuery> {
  return scopeSegmentQuery(query, await storedBroadcastFriendScope(db, accountId));
}
