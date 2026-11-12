import { jstNow, nextVersionToken } from './utils.js';
import { resolveLineCredential } from './line-accounts.js';
// =============================================================================
// Traffic Pools — instant account switching via /pool/:slug
// =============================================================================

export interface TrafficPool {
  id: string;
  confirmation_revision: number;
  slug: string;
  name: string;
  active_account_id: string;
  is_active: number;
  created_at: string;
  updated_at: string;
}

export interface TrafficPoolWithAccount extends TrafficPool {
  account_name: string;
  liff_id: string | null;
  login_channel_id: string | null;
  login_channel_secret: string | null;
  channel_access_token: string | null;
  channel_access_token_encrypted?: string | null;
  channel_id: string | null;
}

// ── Queries ─────────────────────────────────────────────────────────────────

export async function getTrafficPools(db: D1Database): Promise<TrafficPoolWithAccount[]> {
  const result = await db
    .prepare(
      `SELECT tp.*, la.name as account_name, la.liff_id, la.login_channel_id, la.login_channel_secret, la.login_channel_secret_encrypted, la.channel_access_token, la.channel_access_token_encrypted, la.channel_id
       FROM traffic_pools tp
       JOIN line_accounts la ON la.id = tp.active_account_id
       ORDER BY tp.created_at DESC`,
    )
    .all<TrafficPoolWithAccount>();
  return Promise.all(result.results.map(hydratePoolCredential));
}

export async function getTrafficPoolById(
  db: D1Database,
  id: string,
): Promise<TrafficPoolWithAccount | null> {
  const row = await db
    .prepare(
      `SELECT tp.*, la.name as account_name, la.liff_id, la.login_channel_id, la.login_channel_secret, la.login_channel_secret_encrypted, la.channel_access_token, la.channel_access_token_encrypted, la.channel_id
       FROM traffic_pools tp
       JOIN line_accounts la ON la.id = tp.active_account_id
       WHERE tp.id = ?`,
    )
    .bind(id)
    .first<TrafficPoolWithAccount>();
  return row ? hydratePoolCredential(row) : null;
}

export async function getTrafficPoolBySlug(
  db: D1Database,
  slug: string,
): Promise<TrafficPoolWithAccount | null> {
  const row = await db
    .prepare(
      `SELECT tp.*, la.name as account_name, la.liff_id, la.login_channel_id, la.login_channel_secret, la.login_channel_secret_encrypted, la.channel_access_token, la.channel_access_token_encrypted, la.channel_id
       FROM traffic_pools tp
       JOIN line_accounts la ON la.id = tp.active_account_id
       WHERE tp.slug = ? AND tp.is_active = 1`,
    )
    .bind(slug)
    .first<TrafficPoolWithAccount>();
  return row ? hydratePoolCredential(row) : null;
}

// ── Mutations ───────────────────────────────────────────────────────────────

export interface CreateTrafficPoolInput {
  slug: string;
  name: string;
  activeAccountId: string;
  accountIds?: string[];
}

export async function createTrafficPool(
  db: D1Database,
  input: CreateTrafficPoolInput,
): Promise<TrafficPoolWithAccount> {
  const id = crypto.randomUUID();
  const now = jstNow();

  const accountIds = [...new Set(input.accountIds ?? [input.activeAccountId])];
  if (!accountIds.length || !accountIds.includes(input.activeAccountId)) throw new Error('Invalid pool membership');
  await db.batch([
    db.prepare(`INSERT INTO traffic_pools (id, slug, name, active_account_id, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, ?, ?)`)
      .bind(id, input.slug, input.name, input.activeAccountId, now, now),
    ...accountIds.map((accountId) => db.prepare(
      `INSERT INTO pool_accounts (id, pool_id, line_account_id, is_active, created_at) VALUES (?, ?, ?, 1, ?)`,
    ).bind(crypto.randomUUID(), id, accountId, now)),
  ]);

  return (await getTrafficPoolById(db, id))!;
}

export class TrafficPoolSaveConflict extends Error {
  constructor(public updatedAt: string) { super('traffic_pool_save_conflict'); }
}

export interface UpdateTrafficPoolInput {
  expectedUpdatedAt?: string;
  name?: string;
  activeAccountId?: string;
  isActive?: boolean;
}

export async function updateTrafficPool(
  db: D1Database,
  id: string,
  updates: UpdateTrafficPoolInput,
): Promise<TrafficPoolWithAccount | null> {
  const existing = await getTrafficPoolById(db, id);
  if (!existing) return null;
  if (updates.expectedUpdatedAt !== undefined && updates.expectedUpdatedAt !== existing.updated_at) {
    throw new TrafficPoolSaveConflict(existing.updated_at);
  }
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.name !== undefined) {
    fields.push('name = ?');
    values.push(updates.name);
  }
  if (updates.activeAccountId !== undefined) {
    fields.push('active_account_id = ?');
    values.push(updates.activeAccountId);
  }
  if (updates.isActive !== undefined) {
    fields.push('is_active = ?');
    values.push(updates.isActive ? 1 : 0);
  }

  if (fields.length === 0) return getTrafficPoolById(db, id);

  fields.push('updated_at = ?');
  values.push(nextVersionToken(existing.updated_at));
  values.push(id);

  values.push(existing.updated_at);
  const result = await db
    .prepare(`UPDATE traffic_pools SET confirmation_revision=confirmation_revision+1, ${fields.join(', ')} WHERE id = ? AND updated_at = ?`)
    .bind(...values)
    .run();
  if (result.meta.changes !== 1) {
    const latest = await getTrafficPoolById(db, id);
    if (!latest) return null;
    throw new TrafficPoolSaveConflict(latest.updated_at);
  }

  return getTrafficPoolById(db, id);
}

export async function deleteTrafficPool(db: D1Database, id: string): Promise<void> {
  await db.prepare(`DELETE FROM traffic_pools WHERE id = ?`).bind(id).run();
}

// =============================================================================
// Pool Accounts — multiple LINE accounts per pool for distribution
// =============================================================================

export interface PoolAccount {
  id: string;
  pool_id: string;
  line_account_id: string;
  is_active: number;
  created_at: string;
}

export interface PoolAccountWithDetails extends PoolAccount {
  account_name: string;
  liff_id: string | null;
  login_channel_id: string | null;
  login_channel_secret: string | null;
  channel_access_token: string | null;
  channel_access_token_encrypted?: string | null;
  channel_id: string | null;
}

const POOL_ACCOUNT_JOIN = `
  SELECT pa.*, la.name as account_name, la.liff_id, la.login_channel_id, la.login_channel_secret, la.login_channel_secret_encrypted, la.channel_access_token, la.channel_access_token_encrypted, la.channel_id
  FROM pool_accounts pa
  JOIN line_accounts la ON la.id = pa.line_account_id`;

export async function getPoolAccounts(db: D1Database, poolId: string): Promise<PoolAccountWithDetails[]> {
  const result = await db
    .prepare(`${POOL_ACCOUNT_JOIN} WHERE pa.pool_id = ? ORDER BY pa.created_at ASC`)
    .bind(poolId)
    .all<PoolAccountWithDetails>();
  return Promise.all(result.results.map(hydratePoolCredential));
}

export async function getRandomPoolAccount(db: D1Database, poolId: string): Promise<PoolAccountWithDetails | null> {
  const row = await db
    .prepare(`${POOL_ACCOUNT_JOIN} WHERE pa.pool_id = ? AND pa.is_active = 1 ORDER BY RANDOM() LIMIT 1`)
    .bind(poolId)
    .first<PoolAccountWithDetails>();
  return row ? hydratePoolCredential(row) : null;
}

async function hydratePoolCredential<
  T extends {
    channel_access_token: string | null;
    channel_access_token_encrypted?: string | null;
    login_channel_secret?: string | null;
    login_channel_secret_encrypted?: string | null;
  } & ({ active_account_id: string } | { line_account_id: string }),
>(
  row: T,
): Promise<T> {
  const hasAccessToken = Boolean(row.channel_access_token || row.channel_access_token_encrypted);
  const hasLoginSecret = 'login_channel_secret_encrypted' in row
    && Boolean(row.login_channel_secret_encrypted || row.login_channel_secret);
  if (!hasAccessToken && !hasLoginSecret) return row;
  const lineAccountId = 'line_account_id' in row
    ? row.line_account_id
    : row.active_account_id;
  const next: Record<string, unknown> = { ...row };
  if (hasAccessToken) {
    next.channel_access_token = await resolveLineCredential(
      row.channel_access_token_encrypted,
      row.channel_access_token,
      { lineAccountId, field: 'channel_access_token' },
    );
  }
  if (hasLoginSecret) {
    next.login_channel_secret = await resolveLineCredential(
      row.login_channel_secret_encrypted,
      row.login_channel_secret,
      { lineAccountId, field: 'login_channel_secret' },
    );
  }
  return next as T;
}

export async function addPoolAccount(db: D1Database, poolId: string, lineAccountId: string): Promise<PoolAccount> {
  const id = crypto.randomUUID();
  const now = jstNow();
  const [inserted] = await db.batch<PoolAccount>([
    db.prepare('INSERT INTO pool_accounts (id, pool_id, line_account_id, is_active, created_at) VALUES (?, ?, ?, 1, ?) RETURNING *').bind(id,poolId,lineAccountId,now),
    db.prepare('UPDATE traffic_pools SET confirmation_revision=confirmation_revision+1 WHERE id=? AND changes()=1').bind(poolId),
  ]);
  return inserted.results[0];
}

export async function removePoolAccount(db: D1Database, id: string): Promise<boolean> {
  const pool = await db.prepare('SELECT pool_id FROM pool_accounts WHERE id=?').bind(id).first<{pool_id:string}>();
  if (!pool) return false;
  const [result] = await db.batch([db.prepare('DELETE FROM pool_accounts WHERE id=? AND pool_id=?').bind(id,pool.pool_id), db.prepare('UPDATE traffic_pools SET confirmation_revision=confirmation_revision+1 WHERE id=? AND changes()=1').bind(pool.pool_id)]);
  return Number(result.meta.changes) > 0;
}

export async function togglePoolAccount(db: D1Database, id: string, isActive: boolean): Promise<PoolAccount | null> {
  const pool = await db.prepare('SELECT pool_id FROM pool_accounts WHERE id=?').bind(id).first<{pool_id:string}>();
  if (!pool) return null;
  const [result] = await db.batch<PoolAccount>([db.prepare('UPDATE pool_accounts SET is_active=? WHERE id=? AND pool_id=? RETURNING *').bind(isActive?1:0,id,pool.pool_id), db.prepare('UPDATE traffic_pools SET confirmation_revision=confirmation_revision+1 WHERE id=? AND changes()=1').bind(pool.pool_id)]);
  return result.results[0] ?? null;
}
