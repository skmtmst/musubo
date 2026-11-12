import { sqlIdSet } from '@line-crm/db/id-queries';
import { inputError, inputJsonBoundary } from '../lib/input-errors.js';
import type { CreateTrafficPoolRequest } from '@line-crm/shared';
import { Hono, type Context } from 'hono';
import {
  getTrafficPools,
  getTrafficPoolById,
  getTrafficPoolBySlug,
  createTrafficPool,
  updateTrafficPool,
  TrafficPoolSaveConflict,
  deleteTrafficPool,
  getPoolAccounts,
  addPoolAccount,
  removePoolAccount,
  togglePoolAccount,
} from '@line-crm/db';
import type { TrafficPoolWithAccount, PoolAccountWithDetails } from '@line-crm/db';
import type { Env } from '../worker-env.js';
import { requireRole } from '../middleware/role-guard.js';
import { canAccessAllLineAccounts, getVisibleLineAccountScope } from '../services/account-access.js';
import { fail } from '../lib/fail.js';
const trafficPools = new Hono<Env>();

async function requireVisibleTrafficPool(c: Context<Env>, next: () => Promise<void>) {
  const pool = await getTrafficPoolById(c.env.DB, c.req.param('id')!);
  if (!pool || !await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [pool.active_account_id])) {
    return fail(c, 404, 'TRAFFIC_POOL_NOT_FOUND');
  }
  await next();
}

function serialize(pool: TrafficPoolWithAccount) {
  return {
    id: pool.id,
    slug: pool.slug,
    name: pool.name,
    activeAccountId: pool.active_account_id,
    accountName: pool.account_name,
    liffId: pool.liff_id,
    isActive: Boolean(pool.is_active),
    confirmationRevision: pool.confirmation_revision,
    createdAt: pool.created_at,
    updatedAt: pool.updated_at,
  };
}



trafficPools.get('/pool/:slug', async (c) => {
  const slug = c.req.param('slug');
  const pool = await getTrafficPoolBySlug(c.env.DB, slug);

  if (!pool) {
    return fail(c, 404, 'POOL_NOT_FOUND');
  }

  const baseUrl = new URL(c.req.url).origin;
  const params = new URLSearchParams();
  params.set('pool', slug);
  // プールの迂回を防ぐため account は転送せず、安全な ref/form などだけを引き継ぐ。
  const blocked = new Set(['pool', 'account']);
  for (const [key, value] of new URL(c.req.url).searchParams) {
    if (!blocked.has(key)) params.set(key, value);
  }
  return c.redirect(`${baseUrl}/auth/line?${params.toString()}`, 302);
});

// ── Admin API ───────────────────────────────────────────────────────────────

// GET /api/traffic-pools — list all
trafficPools.get('/api/traffic-pools', async (c) => {
  try {
    const pools = await getTrafficPools(c.env.DB);
    const scope = await getVisibleLineAccountScope(c.env.DB, c.get('staff'));
    return c.json({ success: true, data: pools.filter(pool => scope.allowedAccountIds.includes(pool.active_account_id)).map(serialize) });
  } catch (err) {
    throw err;
  }
});

// GET /api/traffic-pools/accounts?ids=pool-1,pool-2 — list members in one request
trafficPools.get('/api/traffic-pools/accounts', async (c) => {
  try {
    const ids = [...new Set((c.req.query('ids') ?? '').split(',').map((id) => id.trim()).filter(Boolean))];
    if (ids.length === 0) {
      return c.json({ success: false, error: 'ids is required' }, 400);
    }
    if (ids.length > 200) {
      return c.json({ success: false, error: 'ids must contain at most 200 traffic pools' }, 400);
    }

    const placeholders = sqlIdSet(ids).sql;
    const pools = await c.env.DB.prepare(
      `SELECT id, active_account_id FROM traffic_pools WHERE id IN (${placeholders})`,
    ).bind(...(ids.length ? sqlIdSet(ids).binds : [])).all<{ id: string; active_account_id: string }>();
    if (pools.results.length !== ids.length
      || !await canAccessAllLineAccounts(
        c.env.DB,
        c.get('staff'),
        pools.results.map((pool) => pool.active_account_id),
      )) {
      return fail(c, 404, 'TRAFFIC_POOL_NOT_FOUND');
    }

    const accounts = await c.env.DB.prepare(
      `SELECT
         pa.id, pa.pool_id, pa.line_account_id, pa.is_active, pa.created_at,
         la.name AS account_name, la.liff_id,
         NULL AS login_channel_id, NULL AS login_channel_secret,
         NULL AS channel_access_token, NULL AS channel_access_token_encrypted,
         NULL AS channel_id
       FROM pool_accounts pa
       JOIN line_accounts la ON la.id = pa.line_account_id
       WHERE pa.pool_id IN (${placeholders})
       ORDER BY pa.pool_id, pa.created_at, pa.id`,
    ).bind(...(ids.length ? sqlIdSet(ids).binds : [])).all<PoolAccountWithDetails>();

    return c.json({
      success: true,
      data: ids.map((poolId) => ({
        poolId,
        accounts: accounts.results
          .filter((account) => account.pool_id === poolId)
          .map(serializePoolAccount),
      })),
    });
  } catch (err) {
    throw err;
  }
});

// POST /api/traffic-pools — create
trafficPools.post('/api/traffic-pools', requireRole('owner'), inputJsonBoundary({"slug":["string"],"name":["string"],"activeAccountId":["string"],"accountIds":["array"]}), async (c) => {
  let body: CreateTrafficPoolRequest;
  try { body = await c.req.json<CreateTrafficPoolRequest>(); }
  catch { return inputError(c, { success: false, error: 'Invalid JSON' }, 400, []); }
  if (!body || typeof body.slug !== 'string' || !/^[a-z0-9][a-z0-9-]{1,31}$/.test(body.slug)
    || typeof body.name !== 'string' || !body.name.trim() || body.name.length > 200
    || typeof body.activeAccountId !== 'string' || !body.activeAccountId
    || (body.accountIds !== undefined && (!Array.isArray(body.accountIds) || body.accountIds.length > 50
      || body.accountIds.some((id) => typeof id !== 'string' || !id)))) {
    return inputError(c, { success: false, error: 'プール名・URL名・受け入れ先を確認してください' }, 422, ["slug","name","activeAccountId","accountIds"]);
  }
  const accountIds = [...new Set(body.accountIds ?? [body.activeAccountId])];
  if (!accountIds.length || !accountIds.includes(body.activeAccountId)) {
    return inputError(c, { success: false, error: '受け入れ先は1件以上必要です' }, 422, ["accountIds","activeAccountId"]);
  }
  try {
    if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), accountIds)) {
      return c.json({ success: false, error: 'このLINEアカウントを操作する権限がありません' }, 403);
    }
    const accounts = await c.env.DB.prepare(`SELECT id FROM line_accounts
      WHERE id IN (${sqlIdSet(accountIds).sql}) AND is_active = 1 AND archived_at IS NULL`)
      .bind(...(accountIds.length ? sqlIdSet(accountIds).binds : [])).all<{ id: string }>();
    if (accounts.results.length !== accountIds.length) {
      return inputError(c, { success: false, error: '稼働中のアカウントを選んでください' }, 422, ["accountIds","activeAccountId"]);
    }
    const pool = await createTrafficPool(c.env.DB, {
      slug: body.slug, name: body.name.trim(), activeAccountId: body.activeAccountId, accountIds,
    });
    return c.json({ success: true, data: serialize(pool) }, 201);
  } catch (err) {
    if (String(err).includes('UNIQUE constraint failed: traffic_pools.slug')) {
      return c.json({ success: false, error: 'このURL名はすでに使われています' }, 409);
    }
    throw err;
  }
});

trafficPools.use('/api/traffic-pools/:id', requireVisibleTrafficPool);
trafficPools.use('/api/traffic-pools/:id/*', requireVisibleTrafficPool);

// 一覧と同じowner/adminの閲覧境界を維持する。staffの権限は広げない。
trafficPools.get('/api/traffic-pools/:id', requireRole('owner', 'admin'), async (c) => {
  const pool = await getTrafficPoolById(c.env.DB, c.req.param('id'));
  return pool ? c.json({ success: true, data: serialize(pool) })
    : fail(c, 404, 'TRAFFIC_POOL_NOT_FOUND');
});

// PUT /api/traffic-pools/:id — update (switch account here)
trafficPools.put('/api/traffic-pools/:id', requireRole('owner'), inputJsonBoundary({"name":["string"],"activeAccountId":["string"],"isActive":["boolean"],"expectedUpdatedAt":["string"]}), async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json<{
      expectedUpdatedAt?: string;
      name?: string;
      activeAccountId?: string;
      isActive?: boolean;
    }>();

    if (body.name !== undefined && (!body.name.trim() || body.name.length > 200)) {
      return inputError(c, { success: false, error: '名前を入力してください' }, 422, ['name']);
    }
    if (body.name !== undefined && !body.expectedUpdatedAt) {
      return inputError(c, { success: false, error: '最新のプールを読み込んでください' }, 422, ['expectedUpdatedAt']);
    }
    if (body.activeAccountId
      && !await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [body.activeAccountId])) {
      return c.json({ success: false, error: 'このLINEアカウントを操作する権限がありません' }, 403);
    }

    const updated = await updateTrafficPool(c.env.DB, id, {
      name: body.name?.trim(),
      expectedUpdatedAt: body.expectedUpdatedAt,
      activeAccountId: body.activeAccountId,
      isActive: body.isActive,
    });

    if (!updated) {
      return fail(c, 404, 'TRAFFIC_POOL_NOT_FOUND');
    }
    return c.json({ success: true, data: serialize(updated) });
  } catch (err) {
    if (err instanceof TrafficPoolSaveConflict) {
      return c.json({ success: false, code: 'save_conflict', error: 'ほかの人が先に保存しました。入力は残っています。', updatedAt: err.updatedAt, data: { updatedAt: err.updatedAt } }, 409);
    }
    throw err;
  }
});


trafficPools.delete('/api/traffic-pools/:id', requireRole('owner'), async (c) => {
  try {
    const id = c.req.param('id');
    const existing = await getTrafficPoolById(c.env.DB, id);
    if (!existing) {
      return fail(c, 404, 'TRAFFIC_POOL_NOT_FOUND');
    }
    // main は友だち追加の既定先なので、削除して初期設定を壊さないよう400で拒む。
    if (existing.slug === 'main') {
      return c.json({ success: false, error: 'main pool cannot be deleted' }, 400);
    }
    const rawRevision = c.req.query('expectedConfirmationRevision');
    const rawAccounts = c.req.query('expectedAccountIds');
    if ((rawRevision === undefined) !== (rawAccounts === undefined)) return c.json({ success: false, error: '確認した版と所属を指定してください' }, 400);
    if (rawRevision !== undefined) {
      let accounts: unknown;
      try { accounts = JSON.parse(rawAccounts!); } catch { return c.json({ success: false, error: '所属が正しくありません' }, 400); }
      if (!/^[1-9]\d*$/.test(rawRevision) || !Number.isSafeInteger(Number(rawRevision)) || !Array.isArray(accounts) || accounts.length > 200 || accounts.some(a => typeof a !== 'string' || !a) || new Set(accounts).size !== accounts.length) return c.json({ success: false, error: '確認した版と所属が正しくありません' }, 400);
      const changed = await c.env.DB.prepare(`DELETE FROM traffic_pools WHERE id=? AND confirmation_revision=?
        AND (SELECT COUNT(*) FROM pool_accounts WHERE pool_id=traffic_pools.id)=json_array_length(?)
        AND NOT EXISTS(SELECT 1 FROM pool_accounts a WHERE a.pool_id=traffic_pools.id AND a.line_account_id NOT IN (SELECT value FROM json_each(?)))`).bind(id,Number(rawRevision),JSON.stringify(accounts),JSON.stringify(accounts)).run();
      if (!changed.meta.changes) {
        const current = await getTrafficPoolById(c.env.DB,id);
        const members = await getPoolAccounts(c.env.DB,id);
        return c.json({ success: false, error: 'プールまたは所属が変わりました。読み直してください', current: { pool: current ? serialize(current) : null, accountIds: members.map(m => m.line_account_id).sort() } }, 409);
      }
    } else await deleteTrafficPool(c.env.DB, id);
    return c.json({ success: true, data: null });
  } catch (err) {
    throw err;
  }
});

function serializePoolAccount(pa: PoolAccountWithDetails) {
  return {
    id: pa.id,
    poolId: pa.pool_id,
    lineAccountId: pa.line_account_id,
    accountName: pa.account_name,
    liffId: pa.liff_id,
    isActive: Boolean(pa.is_active),
    createdAt: pa.created_at,
  };
}

// GET /api/traffic-pools/:id/accounts — list pool accounts
trafficPools.get('/api/traffic-pools/:id/accounts', async (c) => {
  try {
    const accounts = await getPoolAccounts(c.env.DB, c.req.param('id'));
    return c.json({ success: true, data: accounts.map(serializePoolAccount) });
  } catch (err) {
    throw err;
  }
});


trafficPools.post('/api/traffic-pools/:id/accounts', requireRole('owner'), inputJsonBoundary({"lineAccountId":["string"]}), async (c) => {
  try {
    const body = await c.req.json<{ lineAccountId: string }>();
    if (!body.lineAccountId) {
      return fail(c, 400, 'ACCOUNT_ID_REQUIRED', {}, ["lineAccountId"]);
    }
    if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [body.lineAccountId])) {
      return c.json({ success: false, error: 'このLINEアカウントを操作する権限がありません' }, 403);
    }
    const account = await addPoolAccount(c.env.DB, c.req.param('id'), body.lineAccountId);
    return c.json({ success: true, data: account }, 201);
  } catch (err: any) {
    if (err?.message?.includes('UNIQUE constraint')) {
      return c.json({ success: false, error: 'Account already in this pool' }, 409);
    }
    throw err;
  }
});

// PUT /api/traffic-pools/:id/accounts/:accountId — toggle active
trafficPools.put('/api/traffic-pools/:id/accounts/:accountId', requireRole('owner'), inputJsonBoundary({"isActive":["boolean"]}), async (c) => {
  try {
    const body = await c.req.json<{ isActive: boolean }>();
    const result = await togglePoolAccount(c.env.DB, c.req.param('accountId'), body.isActive);
    if (!result) return c.json({ success: false, error: 'Not found' }, 404);
    return c.json({ success: true, data: result });
  } catch (err) {
    throw err;
  }
});


trafficPools.delete('/api/traffic-pools/:id/accounts/:accountId', requireRole('owner'), async (c) => {
  try {
    const deleted = await removePoolAccount(c.env.DB, c.req.param('accountId'));
    if (!deleted) return c.json({ success: false, error: 'Not found' }, 404);
    return c.json({ success: true });
  } catch (err) {
    throw err;
  }
});

export { trafficPools };
