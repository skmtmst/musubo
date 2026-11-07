import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { registrations, hasPriorGuard, importedRouters, exportedRouters } from '../test-utils/route-guards.js';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import {requireRole} from './role-guard.js';
import { isOutputRequest } from './output-audit.js';
import { QA_STAGING_DATABASE } from '../services/staging-qa-safety.js';

const authState = vi.hoisted(() => ({ readOnly: false, role: 'staff' as 'owner' | 'admin' | 'staff', permissionKeys: [] as string[], viewKeys: [] as string[] }));
vi.mock('@line-crm/db', async (original) => ({
  ...await original<typeof import('@line-crm/db')>(),
  getStaffByAdminSession: async () => null,
  getPlatformSetting: async () => 'false', // Explicit Off fixture for route authorization.
  getStaffByApiKey: async (_db: unknown, token: string) => ({ id: `coverage-${token}`, name: 'Coverage', role: authState.role, tenant_id: 'coverage-tenant',
    access_level: authState.readOnly ? 'read_only' : 'full', permission_keys: JSON.stringify(authState.permissionKeys), view_permission_keys: JSON.stringify(authState.viewKeys), tenant_status: 'active' }),
  getActiveImpersonation: async () => null,
  getPlatformAdminByStaffId: async () => null,
  getStaffById: async () => null,
  // 権限試験がレート制限で先に止まらないよう、偽 DB では制限を分離する。共有制限は rate-limit-shared.test.ts で検証する。
  bumpAuthThrottle: async () => 1,
  getLineAccountScopeEntries: async () => [{ id: 'coverage-account', tenant_id: 'coverage-tenant', is_active: 1 }],
  recordAuditEvent: async () => undefined,
}));
import { app } from '../index.js';
import { createTestD1 } from '../test-utils/d1-sqlite.js';
import { collectSecurityRoutes, routeSourceFiles } from '../test-utils/route-security-inventory.js';
import { isLegacyGlobalApi } from './tenant-scope.js';

// 検証専用経路を有効にして権限を試す。無効時・本番時の404は実際の QA 入口の試験へ分ける。
const stagingEnvironment = {
  DEPLOY_ENV: 'staging', WORKER_NAME: 'nen-line-stg', D1_DATABASE_ID: QA_STAGING_DATABASE,
  WORKER_PUBLIC_URL: 'https://stg-api.musubo.jp', STAGING_QA_ENABLED: 'true', STAGING_QA_OUTBOUND_DISABLED: 'true',
};

beforeEach(() => { authState.role = 'staff'; authState.readOnly = false; authState.permissionKeys = []; authState.viewKeys = []; });


import {
  authMiddleware,
  gap2ReadOperation,
  isPublicApiBoundary,
  isStaffExplicitAllow,
  isStaffSelfRouteTemplate,
  permissionForApiPath,
} from './auth.js';
import { gap2SelfPreference, readOperationPermissions } from './auth/permissions/auth.js';

/** 更新ルートごとのmiddleware引数と、登録済みの親のガードを確認する。 */
const ROUTES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'routes');
type Finding = { file: string; method: string; path: string };

function collectUnguarded(fixtures?: Record<string, string>): Finding[] {
  if (!fixtures) return collectSecurityRoutes(join(ROUTES_DIR, '..'))
    .filter(route => ['POST', 'PUT', 'PATCH', 'DELETE', 'ALL'].includes(route.method)
      && route.path.startsWith('/api/') && !isPublicApiBoundary(route.method, route.path) && !route.guarded)
    .map(route => ({ file: route.file.replace(/\.ts$/, ''), method: route.method.toLowerCase(), path: route.path }));
  const sources = fixtures ?? Object.fromEntries(readdirSync(ROUTES_DIR)
    .filter((entry) => entry.endsWith('.ts') && !entry.includes('.test.'))
    .map((entry) => [entry, readFileSync(join(ROUTES_DIR, entry), 'utf8')]));
  const indexSource = fixtures ? '' : readFileSync(join(ROUTES_DIR, '..', 'index.ts'), 'utf8');
  const parentCalls = registrations(indexSource);
  const imports = importedRouters(indexSource);
  const findings: Finding[] = [];
  for (const [entry, source] of Object.entries(sources)) {
    const calls = registrations(source);
    const exports = exportedRouters(source);
    for (const route of calls.filter((call) => !['USE', 'ROUTE'].includes(call.method))) {
      if (isPublicApiBoundary(route.method, route.path)) continue;
      const mounts = parentCalls.filter((mount) => {
        if (mount.method !== 'ROUTE' || !mount.mountedRouter) return false;
        const imported = imports.get(mount.mountedRouter);
        return imported && basename(imported.module).replace(/\.js$/, '.ts') === entry
          && exports.get(imported.exported) === route.router;
      });
      const mountedPaths = mounts.map((mount) =>
        `${mount.path === '/' ? '' : mount.path.replace(/\/$/, '')}${route.path}`);
      // この検査は管理APIの共通認証を対象とする。LINE Proxy・更新エンジンの
      // 専用認証は各経路の実行試験で検証する（管理APIへ移すと必ずここで検出）。
      if (!route.path.startsWith('/api/') && !mountedPaths.some(path => path.startsWith('/api/'))) continue;
      if (route.guarded || hasPriorGuard(route, calls)) continue;
      const inherited = mounts.length > 0 && mounts.every((mount) => {
        const path = `${mount.path === '/' ? '' : mount.path.replace(/\/$/, '')}${route.path}`;
        // authMiddleware はAPI以外を通すため、親の一般認証だけでは保護済みにしない。
        return path.startsWith('/api/') && !isPublicApiBoundary(route.method, path)
          && hasPriorGuard({ ...route, router: mount.router, position: mount.position, path }, parentCalls);
      });
      if (!inherited) findings.push({ file: entry.replace(/\.ts$/, ''), method: route.method.toLowerCase(), path: route.path });
    }
  }
  return findings;
}

describe('更新系の権限ガードの網羅', () => {
  it('S07 read-only exports are denied except the aggregate comparison CSV for owner/admin', async () => {
    const aggregate=new Hono();aggregate.use('*',authMiddleware as never);
    aggregate.get('/api/hq/store-comparison/exports/:id/download',requireRole('owner','admin') as never,c=>c.json({success:true}));
    const routes = [...new Map(app.routes.filter(route => route.method === 'GET'
      && route.path.startsWith('/api/') && !isPublicApiBoundary(route.method, route.path))
      .map(route => [route.path, route])).values()];
    expect(routes.length).toBeGreaterThan(100);
    authState.readOnly = true;
    let index = 80_000;
    for (const role of ['owner', 'admin', 'staff'] as const) {
      authState.role = role;
      for (const route of routes) {
        const path = route.path.replace(/:[^/]+/g, 'coverage-target').replace(/\*/g, 'coverage-target');
        const aggregateCsv=route.path==='/api/hq/store-comparison/exports/:id/download';
        const response = await (aggregateCsv?aggregate:app).request(`${path}?format=csv`, { headers: {
          Authorization: `Bearer ${String(++index).padStart(16, '0')}`,
          'CF-Connecting-IP': `s07-output-${index}`,
        } }, { ...stagingEnvironment, DB: {} } as never);
        expect(response.status, `${role} GET ${route.path}: read-only export`).toBe(aggregateCsv&&role!=='staff'?200:403);
      }
    }
  }, 120_000);

  it('S07 feature view permission permits reading but requires edit permission for exports', async () => {
    const router = new Hono();
    router.use('*', authMiddleware as never);
    router.get('/api/friends', c => c.json({ success: true }));
    router.get('/api/friends/export', c => c.json({ success: true }));
    const request = (path: string) => router.request(path, { headers: {
      Authorization: 'Bearer coverage-view-0001', 'CF-Connecting-IP': 's07-output-view',
    } }, { DB: {} });
    authState.viewKeys = ['/friends'];
    expect((await request('/api/friends')).status).toBe(200);
    expect((await request('/api/friends/export')).status).toBe(403);
    expect((await request('/api/friends?format=csv')).status).toBe(403);
    authState.permissionKeys = ['/friends'];
    expect((await request('/api/friends/export')).status).toBe(200);
    expect((await request('/api/friends?format=csv')).status).toBe(200);
  });

  it('S07/S15 lists every mounted API/LIFF route with its authentication, scope evidence, permissions and read-only boundary', () => {
    const candidates = collectSecurityRoutes(join(ROUTES_DIR, '..'));
    const sourceKeys = new Set(candidates.map(route => `${route.method} ${route.path}`));
    const runtimeKeys = new Set(app.routes.filter(route =>
      ['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS'].includes(route.method)
    ).map(route => `${route.method} ${route.path}`));
    expect([...runtimeKeys].filter(key => !sourceKeys.has(key))).toEqual([]);
    // 条件付き route が作る候補は実 Hono 登録と照合し、構文だけで存在を推測しない。ALL の登録も残す。
    const sources = candidates.filter(route => runtimeKeys.has(`${route.method} ${route.path}`) || route.method === 'ALL');
    if (process.env.SECURITY_INVENTORY_REPORT) {
      const lines = sources.map(route => {
        const admin = route.path.startsWith('/api/') && !isPublicApiBoundary(route.method, route.path);
        const readonly = admin && (!['GET','HEAD','OPTIONS'].includes(route.method) || isOutputRequest(route.path, undefined, route.method)) ? 'authMiddleware:403' : admin ? 'read_allowed;format=csv:403' : 'read_or_dedicated_auth';
        const scope = isLegacyGlobalApi(route.path) ? 'tenantScopeMiddleware:legacy_unassigned'
          : route.evidence.join(',') || 'REVIEW:see_called_helpers_or_direct_SQL';
        const permission = admin ? permissionForApiPath(route.path)
          || (isStaffSelfRouteTemplate(route.method, route.path) ? 'self'
            : isStaffExplicitAllow(route.method, route.path) ? 'explicit_allow' : 'staff_fail_closed_or_platform_guard') : 'dedicated_or_public';
        return [route.method, route.path, `${route.file}:${route.line}`, admin ? 'admin_session_or_api_key' : 'dedicated_or_public',
          scope, permission, readonly, route.calls.filter(name => /require|verify|identity|authority|visible|scope|tenant|access/i.test(name)).join(',') || '-'].join('\t');
      });
      writeFileSync(process.env.SECURITY_INVENTORY_REPORT,
        'method\tpath\tsource\tlogin\tstore_hq_scope_evidence\tstaff_permission\tread_only\tcalled_authorization_helpers\n' + lines.join('\n') + '\n');
    }
  }, 120_000);

  it('S07 all reads and exports reject a staff member with no feature permission', async () => {
    const routes = [...new Map(app.routes.filter(route =>
      route.method === 'GET' && route.path.startsWith('/api/') && !isPublicApiBoundary(route.method, route.path)
      && !isStaffSelfRouteTemplate(route.method, route.path) && !isStaffExplicitAllow(route.method, route.path)
      && !route.path.startsWith('/api/ops/') && route.path !== '/api/auth/two-factor/policy'
    ).map(route => [`${route.method} ${route.path}`, route])).values()];
    expect(routes.length).toBeGreaterThan(100);
    for (const [index, route] of routes.entries()) {
      const path = route.path.replace(/:[^/]+/g, 'coverage-target');
      const response = await app.request(path, { headers: {
        Authorization: `Bearer ${String(index + 50_000).padStart(16, '0')}`,
        'CF-Connecting-IP': `s07-read-permission-${index}`,
      } }, { DB: {} } as never);
      expect(response.status, `${route.method} ${route.path}: no read permission`).toBe(403);
    }
  });

  it('S07 全管理APIの読取・書出し・更新で未ログインと別アカウント指定を拒否する', async () => {
    const routes = [...new Map(app.routes.filter(route =>
      ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(route.method)
      && route.path.startsWith('/api/') && !isPublicApiBoundary(route.method, route.path)
    ).map(route => [`${route.method} ${route.path}`, route])).values()];
    expect(routes.length).toBeGreaterThan(100);
    let index = 10_000;
    const matrixDb = createTestD1({ foreignKeys: false });
    try {
    for (const route of routes) {
      const path = route.path.replace(/:[^/]+/g, 'coverage-target').replace(/\*/g, 'coverage-target');
      const env = { ...stagingEnvironment, DB: matrixDb.db };
      const unauthenticated = await app.request(path, { method: route.method,
        headers: { 'CF-Connecting-IP': `s07-unauth-${++index}` } }, env as never);
      expect(unauthenticated.status, `${route.method} ${route.path}: unauthenticated`).toBe(401);
      for (const role of ['owner', 'admin', 'staff'] as const) {
        authState.role = role;
        authState.readOnly = false;
        const denied = await app.request(`${path}?accountId=foreign-account`, { method: route.method,
          headers: { Authorization: `Bearer ${String(++index).padStart(16, '0')}`,
            'CF-Connecting-IP': `s07-${index}` } }, env as never);
        expect(denied.status, `${route.method} ${route.path}: ${role} outside account`).toBe(403);
      }
    }
    if (process.env.SECURITY_MATRIX_REPORT) {
      writeFileSync(process.env.SECURITY_MATRIX_REPORT,
        'method\tpath\tunauthenticated\towner_foreign_account_query\tadmin_foreign_account_query\tstaff_foreign_account_query\n'
        + routes.map(route => `${route.method}\t${route.path}\t401\t403\t403\t403`).join('\n') + '\n');
    }
    } finally { matrixDb.raw.close(); authState.role = 'staff'; }
  }, 120_000);

  it('同じファイルの保護済みルートが未保護ルートを隠さない', () => {
    const source = `import { requireRole } from '../middleware/role-guard.js';
      router.post('/api/mixed/protected', requireRole('owner'), async c => c.json({ok:true}));
      router.put('/api/mixed/unprotected', async c => c.json({ok:true}));`;
    expect(collectUnguarded({ 'mixed.ts': source })).toEqual([
      { file: 'mixed', method: 'put', path: '/api/mixed/unprotected' },
    ]);
  });

  it('import・コメント・ハンドラ内の文字だけでは保護済みにしない', () => {
    const source = `import { requireRole } from '../middleware/role-guard.js';
      // requireRole('owner')
      router.post('/api/mixed/unprotected', async c => {
        const label = 'requireRole'; return c.json({label});
      });`;
    expect(collectUnguarded({ 'mixed.ts': source })).toEqual([
      { file: 'mixed', method: 'post', path: '/api/mixed/unprotected' },
    ]);
  });

  it('同じルーター・先に登録した一致するmiddlewareだけをガードとする', () => {
    const source = `import { requireRole as role } from '../middleware/role-guard.js';
      const owner = role('owner');
      other.use('*', owner);
      router.use('/api/safe/*', owner);
      router.post('/api/safe/update', async c => c.json({ok:true}));
      router.post('/api/unsafe/update', async c => c.json({ok:true}));
      router.use('/api/unsafe/*', owner);`;
    expect(collectUnguarded({ 'mixed.ts': source })).toEqual([
      { file: 'mixed', method: 'post', path: '/api/unsafe/update' },
    ]);
  });

  it('実際に登録した非公開更新APIは未認証・閲覧のみ・機能権限なしを拒否する', async () => {
    const routes = [...new Map(app.routes.filter(route =>
      ['POST', 'PUT', 'PATCH', 'DELETE'].includes(route.method)
      && route.path.startsWith('/api/') && !isPublicApiBoundary(route.method, route.path)
    ).map(route => [`${route.method} ${route.path}`, route])).values()];
    expect(routes.length).toBeGreaterThan(100);
    const report: Array<{ method: string; path: string; unauthenticated: number; readOnly: number; withoutPermission: number | string }> = [];
    let requestIndex = 0;
    for (const route of routes) {
      const authorization = `Bearer ${String(++requestIndex).padStart(16, '0')}`;
      const path = route.path.replace(/:[^/]+/g, 'coverage-target').replace(/\*/g, 'coverage-target');
      const env = { ...stagingEnvironment, DB: {} as D1Database };
      const unauth = await app.request(path, { method: route.method,
        headers: { 'CF-Connecting-IP': `unauth-${route.method}-${path}` } }, env as never);
      expect(unauth.status, `${route.method} ${route.path}: unauthenticated`).toBe(401);
      authState.readOnly = true;
      const readOnly = await app.request(path, { method: route.method,
        headers: { Authorization: authorization, 'CF-Connecting-IP': `readonly-${path}` } }, env as never);
      expect(readOnly.status, `${route.method} ${route.path}: readonly`).toBe(403);
      authState.readOnly = false;
      const result = { method: route.method, path: route.path, unauthenticated: unauth.status,
        readOnly: readOnly.status, withoutPermission: 'self_or_explicit_or_platform' as number | string };
      report.push(result);
      // 本人系と明示許可は正当な契約。運営用は専用の登録・権限試験が守る。
      if (isStaffSelfRouteTemplate(route.method, route.path)
        || isStaffExplicitAllow(route.method, route.path) || path.startsWith('/api/ops/')) continue;
      const denied = await app.request(path, { method: route.method,
        headers: { Authorization: authorization, 'CF-Connecting-IP': `staff-${path}` } }, env as never);
      expect(denied.status, `${route.method} ${route.path}: no permission`).toBe(403);
      result.withoutPermission = denied.status;
    }
    if (process.env.WRITE_AUTHORIZATION_REPORT) writeFileSync(process.env.WRITE_AUTHORIZATION_REPORT,
      JSON.stringify(report, null, 2) + '\n');
  });

  it('編集権限が付いていても全役割の閲覧のみは業務の更新に到達しない', async () => {
    const routes = [...new Map(app.routes.filter(route =>
      ['POST', 'PUT', 'PATCH', 'DELETE'].includes(route.method)
      && route.path.startsWith('/api/') && !isPublicApiBoundary(route.method, route.path)
      // プレビューと本人の通知設定は業務更新と異なるため、専用の閲覧契約で検証する。
      && !gap2ReadOperation(route.method, route.path)
      && !gap2SelfPreference(route.method, route.path)
    ).map(route => [`${route.method} ${route.path}`, route])).values()];
    const report: string[] = [];
    authState.readOnly = true;
    let requestIndex = 100_000;
    for (const role of ['owner', 'admin', 'staff'] as const) {
      authState.role = role;
      for (const route of routes) {
        const path = route.path.replace(/:[^/]+/g, 'coverage-target').replace(/\*/g, 'coverage-target');
        const permission = permissionForApiPath(path);
        authState.permissionKeys = permission ? [permission] : [];
        const response = await app.request(path, { method: route.method, headers: {
          Authorization: `Bearer ${String(++requestIndex).padStart(16, '0')}`,
          'CF-Connecting-IP': `readonly-edit-${requestIndex}`,
        } }, { ...stagingEnvironment, DB: {} } as never);
        expect(response.status, `${role} ${route.method} ${route.path}: readonly with edit permission`).toBe(403);
        report.push(`${role}\t${route.method}\t${route.path}\t${permission ?? '-'}\t${response.status}`);
      }
    }
    expect(routes.length).toBeGreaterThan(0);
    if (process.env.READONLY_WRITE_REPORT) writeFileSync(process.env.READONLY_WRITE_REPORT,
      'role\tmethod\tpath\tedit_permission\tstatus\n' + report.join('\n') + '\n');
  });

  it('機能の閲覧キーだけでは同じ機能の業務を更新できない', async () => {
    const routes = [...new Map(app.routes.filter(route =>
      ['POST', 'PUT', 'PATCH', 'DELETE'].includes(route.method)
      && route.path.startsWith('/api/') && !isPublicApiBoundary(route.method, route.path)
      && !isStaffSelfRouteTemplate(route.method, route.path)
      && !isStaffExplicitAllow(route.method, route.path)
      && !route.path.startsWith('/api/ops/') && route.path !== '/api/auth/two-factor/policy'
      && !gap2ReadOperation(route.method, route.path)
      && permissionForApiPath(route.path) !== null
    ).map(route => [`${route.method} ${route.path}`, route])).values()];
    const report: string[] = [];
    let requestIndex = 110_000;
    for (const route of routes) {
      const path = route.path.replace(/:[^/]+/g, 'coverage-target').replace(/\*/g, 'coverage-target');
      const permission = permissionForApiPath(path)!;
      authState.viewKeys = [permission];
      const response = await app.request(path, { method: route.method, headers: {
        Authorization: `Bearer ${String(++requestIndex).padStart(16, '0')}`,
        'CF-Connecting-IP': `view-write-${requestIndex}`,
      } }, { ...stagingEnvironment, DB: {} } as never);
      expect(response.status, `${route.method} ${route.path}: view permission cannot write`).toBe(403);
      report.push(`${route.method}\t${route.path}\t${permission}\t${response.status}`);
    }
    expect(routes.length).toBeGreaterThan(0);
    if (process.env.VIEW_ONLY_WRITE_REPORT) writeFileSync(process.env.VIEW_ONLY_WRITE_REPORT,
      'method\tpath\tview_permission\tstatus\n' + report.join('\n') + '\n');
  });

  it('すべての管理更新APIはルート単位で保護されている', () => {
    const findings = collectUnguarded();
    expect(findings, findings.map(f => `${f.method.toUpperCase()} ${f.path} (${f.file})`).join('\n'))
      .toEqual([]);
  });
});

/**
 *  staff 権限の deny-by-default の網羅。
 *
 * authMiddleware は staff に対して、公開境界・本人系・明示許可・権限表の
 * いずれにも入らない管理 API を 403 にする。新しい管理 API を足して
 * 権限の帰属を決め忘れると、下のテストが落ちて気づける。
 * 意図的な owner/admin 専用だけを SNAPSHOT に列挙する。
 * 追加・削除の際は権限の帰属を決めてから直す。追記で回避しないこと。
 */
const API_ROUTE_CALL = /\.(get|post|put|patch|delete|options|all)\(\s*['"](\/api\/[^'"]+)['"]/g;

function isStaffApiFailClosed(entry: string): boolean {
  const space = entry.indexOf(' ');
  const method = entry.slice(0, space);
  const path = entry.slice(space + 1);
  if (isPublicApiBoundary(method, path)) return false;
  if (isStaffSelfRouteTemplate(method, path)) return false;
  if (isStaffExplicitAllow(method, path)) return false;
  if (permissionForApiPath(path) !== null) return false;
  if (readOperationPermissions(method, path) !== null) return false;
  return true;
}

function collectStaffApiClassification(extraRoutes: string[] = []): { all: string[]; failClosed: string[] } {
  const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..');
  const files = routeSourceFiles(join(srcDir, 'routes'));
  files.push(join(srcDir, 'index.ts'));
  const seen = new Set<string>();
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(API_ROUTE_CALL)) {
      seen.add(`${match[1].toUpperCase()} ${match[2]}`);
    }
  }
  for (const route of extraRoutes) seen.add(route);
  const all = [...seen].sort();
  const failClosed = all.filter(isStaffApiFailClosed);
  return { all, failClosed };
}

/**
 * fail-closed (staff 403) が意図どおりの一覧。
 *
 * 新しい管理 API はここに入るとテストが落ちる。権限の帰属を決めて
 * auth.ts の対応表か本人系に足すか、owner/admin 専用が正しければ
 * この一覧へ足す。どちらも PR の差分に残る。
 */
const STAFF_FAIL_CLOSED_SNAPSHOT: string[] = [
    // Google 接続の connect/start と同じく店舗管理者以上に限る。
    // Uber Eats のログイン連携の入口。店舗の代理で使えるトークンを得る操作なので
    // デリバリー受注のうち、店舗の売上と受付そのものを止める4操作は店舗管理者以上に限る。
    // 担当者が進める受注→準備完了→受け渡しと品切れ設定は auth.ts の対応表に載せている。
    'DELETE /api/ad-platforms/:id',
    'DELETE /api/affiliates/:id',
    'DELETE /api/broadcast-message-assets/:id',
    'DELETE /api/hq/banners/folders/:id',
    'DELETE /api/hq/banners/images/:id',
    'DELETE /api/hq/templates/:id',
    'DELETE /api/hq/templates/:id/test-tokens/:tokenId',
    'DELETE /api/hq/templates/folders/:id',
    'DELETE /api/hq/templates/media',
    'DELETE /api/hq/templates/media/upload-sessions/:id',
    'DELETE /api/hq/templates/saved-views/:viewId',
    'DELETE /api/images/:key',
    'DELETE /api/integrations/google-calendar/:id',
    'DELETE /api/line-account-folders/:id',
    'DELETE /api/line-account-tags/:id',
    'DELETE /api/line-accounts/:id',
    'DELETE /api/notifications/rules/:id',
    'DELETE /api/ops/announcements/:id',
    'DELETE /api/ops/support/tickets/:id/draft',
    'DELETE /api/restaurant-test/delivery/ubereats/connection',
    'DELETE /api/restaurant-test/floors/:id',
    'DELETE /api/restaurant-test/followups/:storeId/bindings/:stepId',
    'DELETE /api/restaurant-test/menus/:id',
    'DELETE /api/restaurant-test/tables/:id',
    'DELETE /api/staff/:id',
    'DELETE /api/traffic-pools/:id',
    'DELETE /api/traffic-pools/:id/accounts/:accountId',
    'DELETE /api/users/:id',
    'GET /api/account-handovers/:id',
    'GET /api/account-settings/allergy-options',
    'GET /api/account-settings/customer-look',
    'GET /api/account-settings/link-base-url',
    'GET /api/account-settings/test-recipient-login-users',
    'GET /api/account-settings/test-recipients',
    'GET /api/account-settings/tracked-link-base-url',
    'GET /api/accounts/migrations',
    'GET /api/accounts/migrations/:migrationId',
    'GET /api/ad-platforms',
    'GET /api/ad-platforms/:id/logs',
    'GET /api/ad-platforms/logs',
    'GET /api/admin/auto-reply-stats',
    'GET /api/admin/automations-summary',
    'GET /api/admin/friend-debug/:id',
    'GET /api/admin/recent-messages',
    'GET /api/affiliate-offers',
    'GET /api/affiliate-offers/:id',
    'GET /api/affiliate-offers/:id/cap-status',
    'GET /api/affiliate-offers/:id/versions',
    'GET /api/affiliate-payments',
    'GET /api/affiliate-payments/:id/preview',
    'GET /api/affiliate-payout-batches/:id/download',
    'GET /api/affiliate-settlements/current',
    'GET /api/affiliate-settlements/preview',
    'GET /api/affiliates',
    'GET /api/affiliates-report',
    'GET /api/affiliates/:id',
    'GET /api/affiliates/:id/archive-impact',
    'GET /api/affiliates/:id/journeys',
    'GET /api/affiliates/:id/links',
    'GET /api/affiliates/:id/report',
    'GET /api/broadcast-message-assets',
    'GET /api/broadcast-message-assets/:id/versions',
    'GET /api/broadcast-message-assets/counts',
    'GET /api/broadcast-message-assets/folders',
    'GET /api/duplicates/stats',
    'GET /api/field-migrations/:runId',
    'GET /api/friend-fields-stats',
    'GET /api/hq/banners/folders',
    'GET /api/hq/banners/generations/:id',
    'GET /api/hq/banners/images',
    'GET /api/hq/banners/images/:id',
    'GET /api/hq/banners/presets',
    'GET /api/hq/banners/projects',
    'GET /api/hq/banners/projects/:id',
    'GET /api/hq/banners/stats',
    'GET /api/hq/banners/usage',
    'GET /api/hq/billing/invoices',
    'GET /api/hq/billing/metrics',
    'GET /api/hq/billing/preview',
    'GET /api/hq/billing/summary',
    'GET /api/hq/operator-history',
    'GET /api/hq/store-comparison',
    'GET /api/hq/store-comparison/:accountId',
    'GET /api/hq/store-comparison/exports/:id',
    'GET /api/hq/store-comparison/exports/:id/download',
    'GET /api/hq/style-attention',
    'GET /api/hq/style-starter-sets',
    'GET /api/hq/style-starter-sets/catalog',
    'GET /api/hq/style-starter-sets/catalog/:templateId/versions/:versionId',
    'GET /api/hq/style-template-samples',
    'GET /api/hq/support/context',
    'GET /api/hq/support/kinds',
    'GET /api/hq/support/requests',
    'GET /api/hq/support/requests/:id',
    'GET /api/hq/templates',
    'GET /api/hq/templates/:id',
    'GET /api/hq/templates/:id/distribution-targets',
    'GET /api/hq/templates/:id/distributions/:runId',
    'GET /api/hq/templates/:id/received-versions',
    'GET /api/hq/templates/:id/versions',
    'GET /api/hq/templates/:id/versions/compare',
    'GET /api/hq/templates/accounts',
    'GET /api/hq/templates/attribute-kind-counts',
    'GET /api/hq/templates/folders',
    'GET /api/hq/templates/kind-counts',
    'GET /api/hq/templates/media',
    'GET /api/hq/templates/message-references',
    'GET /api/hq/templates/resources',
    'GET /api/hq/templates/saved-views',
    'GET /api/identity-candidates',
    'GET /api/identity-candidates/:id',
    'GET /api/images/:key',
    'GET /api/integrations/codex-monitor/status',
    'GET /api/integrations/google-calendar',
    'GET /api/integrations/google-calendar/bookings',
    'GET /api/integrations/google-calendar/slots',
    'GET /api/integrations/google-sheets/connection',
    'GET /api/integrations/google-sheets/oauth/callback',
    'GET /api/integrations/google-sheets/runs',
    'GET /api/integrations/stripe/events',
    'GET /api/integrations/tiktok-pnl/status',
    'GET /api/line-account-tags',
    'GET /api/line-accounts/:id',
    'GET /api/line-accounts/:id/credential-health',
    'GET /api/line-accounts/:id/follower-insight',
    'GET /api/line-accounts/:id/handovers',
    // 登録の接続確認は owner/admin のウィザードでのみ使う。
    'GET /api/line-accounts/:id/registration-receipt',
    'GET /api/line-accounts/:id/skipped-deliveries',
    'GET /api/line-webhook-events',
    'GET /api/list-stats',
    'GET /api/login-audit',
    'GET /api/manual-links',
    'GET /api/manual-links/lookup',
    // 店舗比較と MCP 管理は owner/admin に限る。
    'GET /api/mcp-connections',
    'GET /api/mcp-connections/logs',
    'GET /api/notifications',
    'GET /api/notifications/center',
    'GET /api/notifications/operator-deliveries.csv',
    'GET /api/notifications/operator-event-types',
    'GET /api/notifications/operator-rules',
    'GET /api/notifications/rules',
    'GET /api/notifications/rules/:id',
    'GET /api/notifications/teams',
    'GET /api/operations/alerts',
    'GET /api/operations/control',
    'GET /api/operations/control/preview',
    'GET /api/operations/health',
    'GET /api/operations/history',
    'GET /api/operations/incidents/:id',
    'GET /api/operations/security-alerts',
    'GET /api/operations/send-paths',
    'GET /api/ops/announcements',
    'GET /api/ops/applications',
    'GET /api/ops/applications/:id',
    'GET /api/ops/audit',
    'GET /api/ops/dashboard',
    'GET /api/ops/dashboard/first-run',
    'GET /api/ops/dashboard/line-unregistered',
    'GET /api/ops/impersonation/current',
    'GET /api/ops/knowledge',
    'GET /api/ops/knowledge/:id',
    'GET /api/ops/me',
    'GET /api/ops/members',
    'GET /api/ops/notice-line-account',
    'GET /api/ops/security-alerts',
    'GET /api/ops/support/summary',
    'GET /api/ops/support/tickets',
    'GET /api/ops/support/tickets/:id',
    'GET /api/ops/tenants',
    'GET /api/ops/tenants/:id',
    'GET /api/postal-code/search',
    'GET /api/recipes',
    'GET /api/recipes/:id',
    'GET /api/recipes/clone-runs/:runId',
    'GET /api/restaurant-test/delivery/ubereats/connection',
    'GET /api/restaurant-test/delivery/ubereats/stores',
    'GET /api/restaurant-test/google/oauth/callback',
    'GET /api/restaurant-test/inbound-emails',
    'GET /api/restaurant-test/intake-addresses',
    'GET /api/restaurant-test/login-members',
    'GET /api/search-console/performance',
    'GET /api/settings/features',
    'GET /api/site/pages',
    'GET /api/site/summary',
    'GET /api/site/tracking-key',
    'GET /api/staff/:id/login-summary',
    'GET /api/staff/last-logins',
    'GET /api/tenants',
    'GET /api/tenants/boundary-preview',
    'GET /api/tenants/me/company-contact',
    'GET /api/traffic-pools',
    'GET /api/traffic-pools/:id', // 最新の比較も既存の一覧と同じowner/admin専用。
    'GET /api/traffic-pools/:id/accounts',
    'GET /api/traffic-pools/accounts',
    'GET /api/users',
    'GET /api/users-grouped',
    'GET /api/users/:id',
    'GET /api/users/:id/accounts',
    'PATCH /api/hq/banners/folders/:id',
    'PATCH /api/hq/banners/images/:id',
    'PATCH /api/hq/banners/projects/:id',
    'PATCH /api/hq/templates/:id',
    'PATCH /api/hq/templates/folders/:id',
    'PATCH /api/hq/templates/saved-views/:viewId',
    'PATCH /api/line-account-folders/:id',
    'PATCH /api/line-account-tags/:id',
    'PATCH /api/line-accounts/:id',
    'PATCH /api/line-accounts/hierarchy',
    'PATCH /api/line-accounts/order',
    'PATCH /api/ops/members/:staffId',
    'PATCH /api/ops/support/tickets/:id',
    'PATCH /api/ops/tenants/:id/feature-packs',
    'PATCH /api/ops/tenants/:id/status',
    'PATCH /api/restaurant-test/approvals/:id',
    'PATCH /api/restaurant-test/followups/:storeId/bindings/:stepId',
    'PATCH /api/restaurant-test/memberships/:id',
    'PATCH /api/restaurant-test/menu/:id',
    'PATCH /api/restaurant-test/menus/:id',
    'PATCH /api/restaurant-test/store-groups/:id/members/:storeId',
    'PATCH /api/restaurant-test/stores/:id',
    'PATCH /api/restaurant-test/tables/:id',
    'PATCH /api/tenants/:id/feature-packs',
    'PATCH /api/tenants/:id/status',
    'PATCH /api/tenants/me',
    'PATCH /api/tenants/me/company-contact',
    'POST /api/account-handovers',
    'POST /api/account-handovers/:id/cancel',
    'POST /api/account-handovers/:id/execute',
    'POST /api/account-handovers/:id/preview',
    'POST /api/account-handovers/:id/rollback',
    'POST /api/account-handovers/link',
    'POST /api/accounts/:id/migrate',
    'POST /api/ad-platforms',
    'POST /api/ad-platforms/:id/connect',
    'POST /api/ad-platforms/:id/cost-import',
    'POST /api/ad-platforms/logs/:id/retry',
    'POST /api/ad-platforms/test',
    'POST /api/admin/broadcast-coverage',
    'POST /api/admin/broadcasts/:id/reset-to-draft',
    'POST /api/admin/content-leak-check',
    'POST /api/admin/refresh-profiles',
    'POST /api/admin/tag-leak-check',
    'POST /api/admin/tag-remove-content-dups',
    'POST /api/affiliate-offers',
    'POST /api/affiliate-offers/:id/versions',
    'POST /api/affiliate-payments/:id/confirm',
    'POST /api/affiliate-payout-batches',
    'POST /api/affiliate-payout-batches/:id/export',
    'POST /api/affiliate-settlements',
    'POST /api/affiliate-statements',
    'POST /api/affiliates',
    'POST /api/affiliates/:id/archive',
    'POST /api/broadcast-message-assets',
    'POST /api/broadcast-message-assets/:id/publish',
    'POST /api/broadcast-message-assets/folders',
    'POST /api/broadcast-message-assets/upload',
    'POST /api/hq/banners/folders',
    'POST /api/hq/banners/folders/:id/swap-order',
    'POST /api/hq/banners/generations/:id/cancel',
    'POST /api/hq/banners/generations/:id/run',
    'POST /api/hq/banners/images/:id/deliver',
    'POST /api/hq/banners/projects',
    'POST /api/hq/banners/projects/:id/duplicate',
    'POST /api/hq/banners/projects/:id/generations',
    'POST /api/hq/banners/projects/:id/uploads',
    'POST /api/hq/billing/checkout',
    'POST /api/hq/billing/portal',
    'POST /api/hq/store-comparison/export',
    'POST /api/hq/support/requests',
    'POST /api/hq/support/requests/:id/messages',
    'POST /api/hq/templates',
    'POST /api/hq/templates/:id/distribute',
    'POST /api/hq/templates/:id/duplicate',
    'POST /api/hq/templates/:id/preflight',
    'POST /api/hq/templates/:id/restore',
    'POST /api/hq/templates/:id/test-send',
    'POST /api/hq/templates/:id/test-token',
    'POST /api/hq/templates/:id/versions/:version/restore',
    'POST /api/hq/templates/folders',
    'POST /api/hq/templates/folders/:id/swap-order',
    'POST /api/hq/templates/media',
    'POST /api/hq/templates/media/upload-sessions',
    'POST /api/hq/templates/media/upload-sessions/:id/complete',
    'POST /api/hq/templates/rich-menu-preview',
    'POST /api/hq/templates/saved-views',
    'POST /api/identity-candidates/:id/decide',
    'POST /api/identity-candidates/:id/undo',
    'POST /api/identity-candidates/detect',
    'POST /api/integrations/google-calendar/book',
    'POST /api/integrations/google-calendar/connect',
    'POST /api/integrations/google-sheets/connect/start',
    'POST /api/integrations/google-sheets/disconnect',
    'POST /api/integrations/google-sheets/sync',
    'POST /api/integrations/ig-harness/engagement',
    'POST /api/integrations/tiktok-pnl/sync',
    'POST /api/line-account-folders',
    'POST /api/line-account-tags',
    'POST /api/line-accounts',
    'POST /api/line-accounts/:id/activate',
    'POST /api/line-accounts/:id/archive',
    'POST /api/line-accounts/:id/connection-checks',
    'POST /api/line-accounts/:id/deactivate',
    'POST /api/line-accounts/:id/follower-import/detect',
    'POST /api/line-accounts/:id/follower-import/start',
    'POST /api/line-accounts/:id/follower-import/step',
    'POST /api/line-accounts/:id/restore',
    'POST /api/line-accounts/connect',
    'POST /api/line-accounts/connect/check',
    'POST /api/line-accounts/verify-connection',
    'POST /api/line-webhook-events/:id/retry',
    'POST /api/links/wrap',
    'POST /api/manual-links/check',
    'POST /api/mcp-connections',
    'POST /api/notifications/center/:id/read',
    'POST /api/notifications/center/read-all',
    'POST /api/notifications/operator-events',
    'POST /api/notifications/operator-outbox/sweep',
    'POST /api/notifications/operator-rules/:id/publish',
    'POST /api/notifications/operator-rules/:id/test',
    'POST /api/notifications/operator-rules/recipients-preview',
    'POST /api/notifications/rules',
    'POST /api/operations/alerts/:id/acknowledge',
    'POST /api/operations/alerts/:id/notifications/retry',
    'POST /api/operations/health/runs',
    'POST /api/operations/incidents',
    'POST /api/operations/incidents/:id/restore',
    'POST /api/operations/incidents/:id/restore-preview',
    'POST /api/operations/security-alerts/:id/acknowledge',
    'POST /api/operations/security-alerts/:id/resolve',
    'POST /api/ops/announcements',
    'POST /api/ops/announcements/preview',
    'POST /api/ops/applications/:id/approve',
    'POST /api/ops/applications/:id/contact',
    'POST /api/ops/applications/:id/resend-invite',
    'POST /api/ops/billing/sync',
    'POST /api/ops/impersonation/end',
    'POST /api/ops/impersonation/pii-reveal',
    'POST /api/ops/impersonation/read',
    'POST /api/ops/impersonation/start',
    'POST /api/ops/impersonation/write',
    'POST /api/ops/knowledge/:id/feedback',
    'POST /api/ops/knowledge/:id/review',
    'POST /api/ops/knowledge/tickets/:id/process',
    'POST /api/ops/knowledge/tickets/:id/retry',
    'POST /api/ops/members',
    'POST /api/ops/members/:staffId/resend-invite',
    'POST /api/ops/notice-line-account/connect',
    'POST /api/ops/security-alerts/:id/acknowledge',
    'POST /api/ops/security-alerts/:id/resolve',
    'POST /api/ops/security-alerts/run-once',
    'POST /api/ops/support/tickets',
    'POST /api/ops/support/tickets/:id/draft/ai',
    'POST /api/ops/support/tickets/:id/reply',
    'POST /api/recipes',
    'POST /api/recipes/:id/clone',
    'POST /api/restaurant-test/delivery/intake/resume',
    'POST /api/restaurant-test/delivery/intake/stop',
    'POST /api/restaurant-test/delivery/orders/:id/cancel',
    'POST /api/restaurant-test/delivery/orders/:id/reject',
    'POST /api/restaurant-test/delivery/ubereats/connect/start',
    'POST /api/restaurant-test/delivery/ubereats/connection/check',
    'POST /api/restaurant-test/delivery/ubereats/stores/select',
    'POST /api/restaurant-test/floors',
    'POST /api/restaurant-test/followups/:storeId/bindings/:stepId',
    'POST /api/restaurant-test/followups/:storeId/request-start',
    'POST /api/restaurant-test/followups/:storeId/stop',
    'POST /api/restaurant-test/gbp/posts',
    'POST /api/restaurant-test/google/changes/:id/send',
    'POST /api/restaurant-test/google/connect/select-location',
    'POST /api/restaurant-test/google/connect/start',
    'POST /api/restaurant-test/google/disconnect',
    'POST /api/restaurant-test/google/hours/review',
    'POST /api/restaurant-test/google/posts/:id/instagram/retry',
    'POST /api/restaurant-test/google/posts/:id/publish',
    'POST /api/restaurant-test/google/posts/:id/remove',
    'POST /api/restaurant-test/google/reviews/:id/reply',
    'POST /api/restaurant-test/inbound-emails/:id/manual-import',
    'POST /api/restaurant-test/inbound/reservations',
    'POST /api/restaurant-test/intake-addresses',
    'POST /api/restaurant-test/inventory/generate',
    'POST /api/restaurant-test/memberships',
    'POST /api/restaurant-test/menu',
    'POST /api/restaurant-test/store-groups',
    'POST /api/restaurant-test/stores',
    'POST /api/restaurant-test/stores/connect',
    'POST /api/restaurant-test/tables',
    'POST /api/restaurant-test/terms-agreement',
    'POST /api/settings/features/impact',
    'POST /api/site/link',
    'POST /api/staff',
    'POST /api/staff/:id/resend-invitation',
    'POST /api/staff/:id/resend-invite',
    'POST /api/tenants',
    'POST /api/traffic-pools',
    'POST /api/traffic-pools/:id/accounts',
    'POST /api/users',
    'POST /api/users/:id/link',
    'POST /api/users/match',
    'PUT /api/account-handovers/:id/decisions',
    'PUT /api/account-settings/allergy-options',
    'PUT /api/account-settings/customer-look',
    'PUT /api/account-settings/link-base-url',
    'PUT /api/account-settings/test-recipients',
    'PUT /api/account-settings/tracked-link-base-url',
    'PUT /api/ad-platforms/:id',
    'PUT /api/affiliate-offers/:id',
    'PUT /api/affiliates/:id',
    'PUT /api/broadcast-message-assets/:id',
    'PUT /api/hq/style-starter-sets/:style',
    'PUT /api/integrations/google-calendar/bookings/:id/status',
    'PUT /api/integrations/google-sheets/target',
    'PUT /api/line-accounts/:id',
    'PUT /api/line-accounts/:id/folder',
    'PUT /api/line-accounts/:id/tags',
    'PUT /api/line-accounts/default',
    'PUT /api/manual-links',
    'PUT /api/manual-links/:key',
    'PUT /api/notifications/rules/:id',
    'PUT /api/ops/announcements/:id',
    'PUT /api/ops/knowledge/:id',
    'PUT /api/ops/notice-line-account',
    'PUT /api/ops/support/tickets/:id/draft',
    'PUT /api/restaurant-test/floors/:id',
    'PUT /api/restaurant-test/floors/order', // タブの並び替えは階・エリアの編集と同じく owner/admin 専用。
    'PUT /api/restaurant-test/followups/:storeId/setup', // 今は使わない＝店の設定なので owner/admin のみ。スタッフは拒否。
    // 新しい保存口も担当者には拒否する。許可を増やす表ではない。
    'PUT /api/restaurant-test/followups/:storeId/steps/:stepId/messages',
    'PUT /api/restaurant-test/gbp/reviews/:id/draft',
    'PUT /api/restaurant-test/google/hours/workspace',
    'PUT /api/restaurant-test/inventory/:id',
    'PUT /api/restaurant-test/inventory/allocation',
    'PUT /api/restaurant-test/line-flows/:id',
    'PUT /api/restaurant-test/memberships/:id/login',
    'PUT /api/restaurant-test/opening-hours',
    'PUT /api/restaurant-test/stores/:id/referral-location',
    'PUT /api/restaurant-test/tables/layout',
    'PUT /api/settings/company',
    'PUT /api/settings/features',
    'PUT /api/traffic-pools/:id',
    'PUT /api/traffic-pools/:id/accounts/:accountId',
    'PUT /api/users/:id',
];

describe('staff 権限の deny-by-default の網羅 (N-423 #670)', () => {
  it('新しい管理 API は公開・本人・権限表のいずれかに入るか fail-closed で止まること', () => {
    const { failClosed } = collectStaffApiClassification();
    expect(
      failClosed,
      '権限表に無い管理 API が増えています。' +
        '権限の帰属を決めて auth.ts の対応表か本人系に足すか、' +
        '意図的な owner/admin 専用なら SNAPSHOT へ足してください。',
    ).toEqual(STAFF_FAIL_CLOSED_SNAPSHOT);
  });

  it('fail-closed の一覧に残骸が無いこと', () => {
    const { all } = collectStaffApiClassification();
    const routes = new Set(all);
    const stale = STAFF_FAIL_CLOSED_SNAPSHOT.filter((entry) => !routes.has(entry));
    expect(
      stale,
      `消えた経路が SNAPSHOT に残っています: ${stale.join(', ')}`,
    ).toEqual([]);
  });

  it('staff配下の固定1セグメント管理routeを本人用:idとして除外しないこと', () => {
    const fixedRoutes = ['GET /api/staff/export', 'PATCH /api/staff/policy'];
    const { failClosed } = collectStaffApiClassification(fixedRoutes);
    expect(failClosed).toEqual([...STAFF_FAIL_CLOSED_SNAPSHOT, ...fixedRoutes].sort());
    expect(failClosed).not.toEqual(STAFF_FAIL_CLOSED_SNAPSHOT);
  });
});

it('Connect受信の管理認証例外は共通口のPOSTだけ',()=>{
  const path='/api/booking/stripe-test/webhook';
  expect(isPublicApiBoundary('POST',path)).toBe(true);
  for(const method of ['GET','PUT','PATCH','DELETE'])expect(isPublicApiBoundary(method,path)).toBe(false);
  expect(isPublicApiBoundary('POST',path+'/unexpected')).toBe(false);
});
