import { UnexpectedRouteError } from '../lib/unhandled-error.js';
import { Hono } from 'hono';
import type { StagingQaJob, StagingQaSafety, StagingQaSession, StagingQaCronReceipt } from '@line-crm/shared';
import type { Env } from '../worker-env.js';
import { requirePlatformAdminWrite } from '../middleware/platform-admin.js';
import { readBoundedText } from '../lib/input-errors.js';
import { hashPassword, validatePasswordPolicy } from '../services/password-hash.js';
import { QA_PREFIX, qaEnabled, type QaRole, type QaRun } from '../services/staging-qa-safety.js';

import { processBookingWaitlists } from '../services/waitlist-tick.js';
import { expireRestaurantHolds, applyDueRestaurantMenuPrices } from '../services/restaurant-booking.js';
import { issueSession } from '../services/admin-session.js';
import { resolveAdminAuthConfig } from '../middleware/admin-auth-config.js';
import { adminSessionTokenHashFromRequest } from '../middleware/auth.js';
import { encodeScopedFriendLineUserId, getPlatformAdminByStaffId, recordPlatformAudit, startImpersonation } from '@line-crm/db';
import { sensitiveStepUpSatisfied, stepUpRequiredResponse } from '../lib/step-up.js';

export const stagingQa = new Hono<Env>();
const BASE = '/api/ops/staging-qa';
const ROLES: QaRole[] = ['hq', 'store', 'viewer', 'impersonation'];
const JOBS: StagingQaJob[] = ['booking_waitlists', 'restaurant_holds', 'restaurant_menu_prices'];
function isQaJob(value: unknown): value is StagingQaJob {
  return typeof value === 'string' && JOBS.some(job => job === value);
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const runKey = (id: string) => `${QA_PREFIX}run:${id}`;
const lockKey = (id: string) => `${QA_PREFIX}lock:${id}`;

stagingQa.use(`${BASE}/*`, async (c, next) => {
  c.header('Cache-Control', 'no-store');
  if (!qaEnabled(c.env)) return c.json({ success: false, error: 'Not found' }, 404);
  return next();
});
stagingQa.use(`${BASE}/*`, requirePlatformAdminWrite());

async function body(c: import('hono').Context<Env>): Promise<Record<string, unknown> | null> {
  try {
    const text = await readBoundedText(c.req.raw, 16 * 1024);
    if (text === null) return null;
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

async function readRun(db: D1Database, id: string): Promise<QaRun | null> {
  if (!uuid.test(id)) return null;
  const row = await db.prepare('SELECT value FROM platform_settings WHERE key=?').bind(runKey(id)).first<{ value: string }>();
  return row ? JSON.parse(row.value) as QaRun : null;
}

async function claim(db: D1Database, id: string, owner: string): Promise<boolean> {
  const result = await db.prepare(`UPDATE platform_settings SET value=? WHERE key=? AND value='idle'`)
    .bind(owner, lockKey(id)).run();
  return result.meta.changes === 1;
}
async function release(db: D1Database, id: string, owner: string): Promise<void> {
  await db.prepare(`UPDATE platform_settings SET value='idle' WHERE key=? AND value=?`).bind(lockKey(id), owner).run();
}

stagingQa.get(`${BASE}/safety`, (c) => c.json({ success: true, data: {
  environment: 'staging', outboundStopped: true, simulatedLineOnly: true,
  jobs: JOBS,
} satisfies StagingQaSafety }));

stagingQa.get(`${BASE}/runs`, async (c) => {
  const cursor = c.req.query('after');
  if (cursor && !uuid.test(cursor)) return c.json({ success: false, error: '開始位置を確認してください' }, 400);
  const rows = await c.env.DB.prepare(`SELECT value FROM platform_settings
    WHERE key LIKE 'staging-qa:run:%' AND key>? ORDER BY key LIMIT 51`)
    .bind(cursor ? runKey(cursor) : `${QA_PREFIX}run:`).all<{ value: string }>();
  const runs = rows.results.slice(0, 50).map(row => JSON.parse(row.value) as QaRun);
  return c.json({ success: true, data: { runs, nextCursor: rows.results.length > 50 ? runs.at(-1)!.id : null } });
});

/** パスワードは呼出元が渡し、パスワード・トークン・セッション・キーは返さない。 */
stagingQa.post(`${BASE}/runs`, async (c) => {
  const input = await body(c);
  const passwords = input?.passwords;
  if (!passwords || typeof passwords !== 'object' || Array.isArray(passwords)) {
    return c.json({ success: false, error: '役ごとの試験パスワードを指定してください' }, 400);
  }
  const credentials = passwords as Record<string, unknown>;
  for (const role of ROLES) {
    if (typeof credentials[role] !== 'string' || validatePasswordPolicy(credentials[role] as string)) {
      return c.json({ success: false, error: '4役のパスワードは13〜128文字で、英大文字・英小文字・数字・特殊記号をそれぞれ1文字以上含めてください' }, 400);
    }
  }
  const id = crypto.randomUUID();
  const run: QaRun = {
    id, tenantId: `qa-tenant-${id}`, accountId: `qa-account-${id}`, organizationId: `qa-org-${id}`, storeId: `qa-store-${id}`, status: 'active', friendIds: [],
    users: ROLES.map(role => ({ id: `qa-${role}-${id}`, role, email: `qa.${id}.${role}@example.invalid` })),
  };
  const db = c.env.DB;
  const statements = [
    db.prepare(`INSERT INTO tenants(id,name,feature_packs) VALUES (?,?,'["restaurant"]')`).bind(run.tenantId, `QA ${id}`),
    db.prepare(`INSERT INTO line_accounts(id,tenant_id,channel_id,name,channel_access_token,channel_secret)
      VALUES (?,?,?,?,?,?)`).bind(run.accountId, run.tenantId, `qa-channel-${id}`, `QA ${id}`, `qa-mock:${id}:${crypto.randomUUID()}`, `qa-secret:${crypto.randomUUID()}`),
    db.prepare('INSERT INTO rt_organizations(id,account_id,tenant_id,name) VALUES (?,?,?,?)').bind(run.organizationId, run.accountId, run.tenantId, `QA ${id}`),
    db.prepare(`INSERT INTO rt_stores(id,organization_id,line_account_id,name,code,line_status) VALUES (?,?,?,?,?,'connected')`).bind(run.storeId, run.organizationId, run.accountId, `QA ${id}`, `qa-${id}`),
    db.prepare(`INSERT INTO platform_settings(key,value,updated_by) VALUES (?,?,?)`).bind(runKey(id), JSON.stringify(run), c.get('staff').id),
    db.prepare(`INSERT INTO platform_settings(key,value) VALUES (?,'idle')`).bind(lockKey(id)),
  ];
  for (const user of run.users) {
    const scoped = user.role !== 'hq';
    const readOnly = user.role === 'viewer' || user.role === 'impersonation';
    statements.push(db.prepare(`INSERT INTO staff_members
      (id,name,email,role,access_level,api_key,tenant_id,assigned_line_account_id,account_scope,password_hash,email_verified_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(user.id, `QA ${user.role}`, user.email,
      user.role === 'hq' ? 'owner' : user.role === 'store' ? 'admin' : 'staff', readOnly ? 'read_only' : 'full',
      crypto.randomUUID(), run.tenantId, scoped ? run.accountId : null, scoped ? 'accounts' : 'all',
      await hashPassword(credentials[user.role] as string), new Date().toISOString()));
    if (scoped) statements.push(db.prepare(`INSERT INTO staff_account_scopes(staff_id,line_account_id,created_at) VALUES (?,?,?)`)
      .bind(user.id, run.accountId, new Date().toISOString()));
  }
  await db.batch(statements);
  return c.json({ success: true, data: run }, 201);
});

stagingQa.get(`${BASE}/runs/:id`, async (c) => {
  const run = await readRun(c.env.DB, c.req.param('id'));
  return run ? c.json({ success: true, data: run }) : c.json({ success: false, error: 'Not found' }, 404);
});

/** 外部ログインなしで、別ブラウザ用の合成人物を運用者が準備できるようにする。 */
stagingQa.post(`${BASE}/runs/:id/session`, async (c) => {
  const db = c.env.DB, id = c.req.param('id'), input = await body(c);
  const run = await readRun(db, id);
  if (!run || run.status !== 'active') return c.json({ success: false, error: 'Not found' }, 404);
  const owner = crypto.randomUUID();
  if (!await claim(db, id, owner)) return c.json({ success: false, error: '試験処理が実行中です' }, 409);
  try {
    if ((await readRun(db, id))?.status !== 'active') return c.json({ success: false, error: 'Not found' }, 404);
    const user = run.users.find(item => item.role === input?.role);
    if (!user) return c.json({ success: false, error: '試験の役を指定してください' }, 400);
    if (user.role === 'impersonation') {
      const operator = c.get('staff');
      const sessionTokenHash = await adminSessionTokenHashFromRequest(c);
      if (!sessionTokenHash || !await getPlatformAdminByStaffId(db, operator.id)) return c.json({ success: false, error: '代理ログインには運営本人のログインが必要です' }, 403);
      if (!await sensitiveStepUpSatisfied(c, 'ops.impersonation')) return stepUpRequiredResponse(c, '代理ログインの前に本人確認してください');
      const session = await startImpersonation(db, { staffId: operator.id, tenantId: run.tenantId, sessionTokenHash });
      await recordPlatformAudit(db, { staffId: operator.id, staffName: operator.name, tenantId: run.tenantId,
        action: 'impersonation.start', detail: { sessionId: session.id }, visibleToTenant: false });
      return c.json({ success: true, data: { id: operator.id, role: user.role, tenantId: run.tenantId, mode: 'read' } satisfies StagingQaSession });
    }
    const active = await c.env.DB.prepare('SELECT id FROM staff_members WHERE id=? AND tenant_id=? AND is_active=1')
      .bind(user.id, run.tenantId).first();
    if (!active) return c.json({ success: false, error: 'Not found' }, 404);
    const config = resolveAdminAuthConfig(c.env, { requestOrigin: new URL(c.req.url).origin });
    if (config.misconfigured) return c.json({ success: false, error: '試験ログインの環境設定を確認してください' }, 503);
    // QA 専用セッションの値は Cookie に限り、通常の本番ログインと MFA は変更しない。
    await issueSession(c, user.id, config.sameSite, false, true);
    return c.json({ success: true, data: { id: user.id, role: user.role, tenantId: run.tenantId } satisfies StagingQaSession });
  } finally { await release(db, id, owner); }
});

stagingQa.post(`${BASE}/runs/:id/friends`, async (c) => {
  const db = c.env.DB, id = c.req.param('id'), input = await body(c);
  const count = input?.count;
  if (!Number.isInteger(count) || Number(count) < 1 || Number(count) > 20) return c.json({ success: false, error: '人数は1〜20人で指定してください' }, 400);
  if (!await readRun(db, id)) return c.json({ success: false, error: 'Not found' }, 404);
  const owner = crypto.randomUUID();
  if (!await claim(db, id, owner)) return c.json({ success: false, error: '試験処理が実行中です' }, 409);
  try {
    const run = (await readRun(db, id))!;
    if (run.status !== 'active' || run.friendIds.length + Number(count) > 100) return c.json({ success: false, error: '試験対象を確認してください' }, 409);
    const friends = Array.from({ length: Number(count) }, () => ({ id: `qa-friend-${crypto.randomUUID()}`, lineUserId: `U${crypto.randomUUID().replaceAll('-', '')}` }));
    run.friendIds.push(...friends.map(friend => friend.id));
    await db.batch([
      ...friends.map((friend, index) => db.prepare(`INSERT INTO friends(id,line_user_id,line_account_id,display_name,metadata)
        VALUES (?,?,?,?,'{"stagingQa":true}')`).bind(friend.id,
        encodeScopedFriendLineUserId(friend.id, friend.lineUserId, run.accountId),
        run.accountId, `QA friend ${run.friendIds.length - friends.length + index + 1}`)),
      db.prepare('UPDATE platform_settings SET value=? WHERE key=?').bind(JSON.stringify(run), runKey(id)),
    ]);
    return c.json({ success: true, data: { runId: id, accountId: run.accountId, friends } }, 201);
  } finally { await release(db, id, owner); }
});

stagingQa.delete(`${BASE}/runs/:id`, async (c) => {
  const db = c.env.DB, id = c.req.param('id');
  if (!await readRun(db, id)) return c.json({ success: false, error: 'Not found' }, 404);
  const owner = crypto.randomUUID();
  if (!await claim(db, id, owner)) return c.json({ success: false, error: '試験処理が実行中です' }, 409);
  try {
    const run = (await readRun(db, id))!;
    const users = JSON.stringify(run.users.map(user => user.id));
    run.status = 'archived';
    await db.batch([
      db.prepare('DELETE FROM admin_sessions WHERE staff_id IN (SELECT value FROM json_each(?))').bind(users),
      db.prepare('UPDATE impersonation_sessions SET ended_at=? WHERE tenant_id=? AND ended_at IS NULL').bind(new Date().toISOString(), run.tenantId),
      db.prepare(`UPDATE staff_members SET is_active=0,password_hash=NULL,api_key='qa-revoked:'||id WHERE tenant_id=? AND id IN (SELECT value FROM json_each(?))`).bind(run.tenantId, users),
      db.prepare(`UPDATE line_accounts SET is_active=0,archived_at=?,archived_reason='staging QA cleanup' WHERE id=? AND tenant_id=?`).bind(new Date().toISOString(), run.accountId, run.tenantId),
      db.prepare(`UPDATE friends SET is_following=0,is_hidden=1 WHERE line_account_id=? AND id IN (SELECT value FROM json_each(?))`).bind(run.accountId, JSON.stringify(run.friendIds)),
      db.prepare(`UPDATE tenants SET status='archived' WHERE id=?`).bind(run.tenantId),
      db.prepare(`UPDATE rt_stores SET status='archived' WHERE id=? AND organization_id=? AND line_account_id=?`).bind(run.storeId, run.organizationId, run.accountId),
      db.prepare(`UPDATE rt_organizations SET status='archived' WHERE id=? AND tenant_id=?`).bind(run.organizationId, run.tenantId),
      db.prepare('UPDATE platform_settings SET value=? WHERE key=?').bind(JSON.stringify(run), runKey(id)),
    ]);
    return c.json({ success: true, data: { id, status: 'archived' } });
  } finally { await release(db, id, owner); }
});

stagingQa.post(`${BASE}/runs/:id/cron`, async (c) => {
  const db = c.env.DB, id = c.req.param('id'), input = await body(c);
  const job = input?.job, requestId = input?.requestId;
  if (!isQaJob(job)
    || typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(requestId)) {
    return c.json({ success: false, error: '処理名と一意なrequestIdを指定してください' }, 400);
  }
  const initial = await readRun(db, id);
  if (!initial || initial.status !== 'active') return c.json({ success: false, error: 'Not found' }, 404);
  const owner = crypto.randomUUID();
  if (!await claim(db, id, owner)) return c.json({ success: false, error: '試験処理が実行中です' }, 409);
  const receiptKey = `${QA_PREFIX}cron:${id}:${requestId}`;
  try {
    const run = (await readRun(db, id))!;
    if (run.status !== 'active') return c.json({ success: false, error: 'Not found' }, 404);
    const old = await db.prepare('SELECT value FROM platform_settings WHERE key=?').bind(receiptKey).first<{ value: string }>();
    if (old) {
      const receipt = JSON.parse(old.value) as { job: string; status: string };
      if (receipt.job !== job) return c.json({ success: false, error: 'requestIdは別の処理で使用済みです' }, 409);
      return c.json({ success: receipt.status === 'completed', data: receipt, replayed: true }, receipt.status === 'completed' ? 200 : 409);
    }
    await db.prepare(`INSERT INTO platform_settings(key,value,updated_by) VALUES (?,?,?)`)
      .bind(receiptKey, JSON.stringify({ job, status: 'running' }), c.get('staff').id).run();
    try {
      if (job === 'booking_waitlists') await processBookingWaitlists(c.env, run.accountId);
      else {
        const store = await db.prepare('SELECT id FROM rt_stores WHERE id=? AND organization_id=? AND line_account_id=?')
          .bind(run.storeId, run.organizationId, run.accountId).first<{ id: string }>();
        if (!store) throw new Error('QA_SCOPE_CHANGED');
        if (job === 'restaurant_holds') await expireRestaurantHolds(db, new Date().toISOString(), store.id, run.organizationId);
        else await applyDueRestaurantMenuPrices(db, run.organizationId, store.id);
      }
      const receipt = { job, status: 'completed', accountId: run.accountId, outboundStopped: true, completedAt: new Date().toISOString() } satisfies StagingQaCronReceipt;
      await db.prepare('UPDATE platform_settings SET value=? WHERE key=?').bind(JSON.stringify(receipt), receiptKey).run();
      return c.json({ success: true, data: receipt, replayed: false });
    } catch {
      await db.prepare('UPDATE platform_settings SET value=? WHERE key=?').bind(JSON.stringify({ job, status: 'failed' }), receiptKey).run();
      throw new UnexpectedRouteError(c, { success: false, error: '試験処理に失敗しました。記録を確認してください' });
    }
  } finally { await release(db, id, owner); }
});
