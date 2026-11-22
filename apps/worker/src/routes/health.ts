import { parsePreviousPurgeHashSecrets } from '../services/tenant-purge-payment-hashes.js';
import { inputJsonBoundary } from '../lib/input-errors.js';
import { Hono } from 'hono';
import {
  getAccountHealthLogs,
  getLineAccountListStats,
  getAccountMigrations,
  getAccountMigrationById,
  createAccountMigration,
  updateAccountMigration,
  isLineAccountTenantActive,
} from '@line-crm/db';
import { lineConnectionRisk, DEFAULT_TENANT_ID } from '@line-crm/shared';
import type { Env } from '../worker-env.js';
import { requireRole } from '../middleware/role-guard.js';
import { getVisibleLineAccountScope } from '../services/account-access.js';
import { buildMetadata } from '../lib/build-metadata.js';
import { fail } from '../lib/fail.js';
const health = new Hono<Env>();

// Worker の起動と経路だけを確かめるため、公開の liveness は外部依存なしで200を返す。capabilities で示した /api/health を CLI の配備後確認に使う。

health.get('/health', (c) => {
  c.header('Cache-Control', 'no-store');
  return c.json({ success: true, data: { status: 'ok', ...buildMetadata(c.env) } });
});
health.get('/api/health', (c) => {
  c.header('Cache-Control', 'no-store');
  try { parsePreviousPurgeHashSecrets(c.env.PURGED_PAYMENT_HMAC_PREVIOUS_SECRETS); } catch { return c.json({success:false,error:'purged_payment_key_configuration_invalid'},503); }
  return c.json({ success: true, data: { status: 'ok', ...buildMetadata(c.env) } });
});

// ========== アカウントヘルス ==========

// サイドバーの N+1 解消用。staff 可視範囲のアカウントだけを対象に、
// 一覧と同じ接続の判定だけを1回で返す。ログ本文は含めない。
health.get('/api/accounts/health-summary', async (c) => {
  try {
    const scope = await getVisibleLineAccountScope(c.env.DB, c.get('staff'));
    const stats = await getLineAccountListStats(c.env.DB, scope.allowedAccountIds);
    const items = scope.allowedAccountIds.map((lineAccountId) => ({
      lineAccountId,
      riskLevel: lineConnectionRisk(stats[lineAccountId]?.connection),
    }));
    return c.json({
      success: true,
      data: {
        items,
        warningCount: items.filter((item) => item.riskLevel === 'warning').length,
        dangerCount: items.filter((item) => item.riskLevel === 'danger').length,
      },
    });
  } catch (err) {
    throw err;
  }
});

health.get('/api/accounts/:id/health', async (c) => {
  try {
    const lineAccountId = c.req.param('id');
    const scope = await getVisibleLineAccountScope(c.env.DB, c.get('staff'));
    if (!scope.ids.includes(lineAccountId)) {
      return fail(c, 404, 'LINE_ACCOUNT_NOT_FOUND');
    }
    const [stats, logs] = await Promise.all([
      getLineAccountListStats(c.env.DB, [lineAccountId]),
      getAccountHealthLogs(c.env.DB, lineAccountId),
    ]);
    return c.json({
      success: true,
      data: {
        lineAccountId,
        riskLevel: lineConnectionRisk(stats[lineAccountId]?.connection),
        connection: stats[lineAccountId]?.connection ?? null,
        logs: logs.map((l) => ({
          id: l.id,
          errorCode: l.error_code,
          errorCount: l.error_count,
          checkPeriod: l.check_period,
          riskLevel: l.risk_level,
          createdAt: l.created_at,
        })),
      },
    });
  } catch (err) {
    throw err;
  }
});

// ========== アカウント移行 ==========

health.get('/api/accounts/migrations', async (c) => {
  try {
    const items = await getAccountMigrations(c.env.DB);
    const scope = await getVisibleLineAccountScope(c.env.DB, c.get('staff'));
    const visible = items.filter(
      (item) => scope.allowedAccountIds.includes(item.from_account_id)
        && scope.allowedAccountIds.includes(item.to_account_id),
    );
    return c.json({
      success: true,
      data: visible.map((m) => ({
        id: m.id,
        fromAccountId: m.from_account_id,
        toAccountId: m.to_account_id,
        status: m.status,
        migratedCount: m.migrated_count,
        totalCount: m.total_count,
        createdAt: m.created_at,
        completedAt: m.completed_at,
      })),
    });
  } catch (err) {
    throw err;
  }
});

health.post('/api/accounts/:id/migrate', requireRole('owner'), inputJsonBoundary({"toAccountId":["string"]}), async (c) => {
  try {
    const fromAccountId = c.req.param('id');
    const body = await c.req.json<{ toAccountId: string }>();
    if (!body.toAccountId) return fail(c, 400, 'TO_ACCOUNT_ID_IS_REQUIRED', {}, ["toAccountId"]);

    const db = c.env.DB;

    /*
     * 存在しない移行元で 201 の幽霊行を作っていた。
     * 移行前に可視範囲で有無を見て、無いときは 404 にして作らない。
     * 範囲外も 404 に倒す（詳細口と同じ fail-closed）。
     */
    const scope = await getVisibleLineAccountScope(db, c.get('staff'));
    const source = scope.accounts.find((account) => account.id === fromAccountId);
    const target = scope.accounts.find((account) => account.id === body.toAccountId);
    if (!source || !target || source.is_active !== 1 || target.is_active !== 1
      || source.archived_at || target.archived_at
      || (source.tenant_id ?? DEFAULT_TENANT_ID) !== (target.tenant_id ?? DEFAULT_TENANT_ID)
      || !await isLineAccountTenantActive(db, fromAccountId)
      || !await isLineAccountTenantActive(db, body.toAccountId)) {
      return fail(c, 404, 'LINE_ACCOUNT_NOT_FOUND');
    }

    // この移行件数に、別アカウントの友だちを含めない。
    const countResult = await db
      .prepare(`SELECT COUNT(*) as count FROM friends WHERE is_following = 1 AND line_account_id = ?`)
      .bind(fromAccountId)
      .first<{ count: number }>();
    const totalCount = countResult?.count ?? 0;

    const migration = await createAccountMigration(db, {
      fromAccountId,
      toAccountId: body.toAccountId,
      totalCount,
    });

    // 移行処理は非同期で実行（実際の移行はUUIDベースなのでユーザーが新アカウントを友だち追加した時に自動マッチされる）
    await updateAccountMigration(db, migration.id, {
      status: 'in_progress',
    });

    return c.json({
      success: true,
      data: {
        id: migration.id,
        fromAccountId: migration.from_account_id,
        toAccountId: migration.to_account_id,
        status: 'in_progress',
        totalCount: migration.total_count,
        createdAt: migration.created_at,
      },
    }, 201);
  } catch (err) {
    throw err;
  }
});

health.get('/api/accounts/migrations/:migrationId', async (c) => {
  try {
    const item = await getAccountMigrationById(c.env.DB, c.req.param('migrationId'));
    if (!item) return fail(c, 404, 'MIGRATION_NOT_FOUND');
    const scope = await getVisibleLineAccountScope(c.env.DB, c.get('staff'));
    if (!scope.allowedAccountIds.includes(item.from_account_id)
      || !scope.allowedAccountIds.includes(item.to_account_id)) {
      return fail(c, 404, 'MIGRATION_NOT_FOUND');
    }
    return c.json({
      success: true,
      data: {
        id: item.id,
        fromAccountId: item.from_account_id,
        toAccountId: item.to_account_id,
        status: item.status,
        migratedCount: item.migrated_count,
        totalCount: item.total_count,
        createdAt: item.created_at,
        completedAt: item.completed_at,
      },
    });
  } catch (err) {
    throw err;
  }
});

export { health };
