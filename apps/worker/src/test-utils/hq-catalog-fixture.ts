import { Hono } from 'hono';
import { vi } from 'vitest';
import type { HqCatalogTemplateType } from '@line-crm/shared';
import { createTestD1, type SqliteD1 } from './d1-sqlite.js';
import { useSqliteClock } from './sqlite-clock.js';
import { hqTemplates } from '../routes/hq-templates.js';
import { scoring } from '../routes/scoring.js';
import booking from '../routes/booking.js';
import type { Env } from '../worker-env.js';

/** 統括のひな形を作り、店へ配り、店の画面から操作するまでを本物の入口と SQLite で動かす準備。 */
export const catalogDefinitions = {
  booking_menu: { schemaVersion: 1, settings: { name: '初回相談', duration_minutes: 60, base_price: 3000 } },
  mileage_reward: { schemaVersion: 1, settings: { name: 'お礼', rewardKind: 'coupon', requiredMiles: 100 } },
} as const;

export interface CatalogPreflight {
  preflightId: string;
  expiresAt: string;
  stores: Array<{ accountId: string; items: Array<{ sourceId: string; allowedModes: string[]; operation?: string }>; redistribution?: { bound: boolean; outcome: string; code: string | null; notices: string[] } }>;
}
export interface RedistributionJobView {
  jobId: string; status: string; templateVersionId: string; notificationId: string | null; skippedAccountIds: string[];
  counts: { total: number; finished: number; applied: number; notified: number; unchanged: number; failed: number };
  stores: Array<{ accountId: string; status: string; outcome: string; code: string | null; attempts: number }>;
}
type Staff = Env['Variables']['staff'];
type Response<T> = { status: number; body: { success?: boolean; data: T; code?: string; error?: string } };

export function createCatalogFixture(options: { file?: string } = {}) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-16T00:00:00Z'));
  const f: SqliteD1 = createTestD1({ foreignKeys: true, ...(options.file ? { file: options.file } : {}) });
  useSqliteClock(f.raw, () => new Date());
  f.raw.exec(`INSERT INTO mileage_programs(id,code,name,status,created_at,updated_at) VALUES('default','default','マイル','active','2026-10-15','2026-10-15');
    INSERT INTO tenants(id,name) VALUES('t','HQ'),('other','Other');
    INSERT INTO staff_members(id,name,role,api_key,tenant_id) VALUES('owner','Owner','owner','unused','t'),('other-owner','Other','owner','unused-other','other');
    INSERT INTO line_accounts(id,name,channel_id,channel_secret,channel_access_token,tenant_id) VALUES('a','Store','a','x','x','t'),('b','Store2','b','x','x','t'),('other','Hidden','other','x','x','other');`);
  let staff: Staff = { id: 'owner', name: 'Owner', role: 'owner', tenantId: 't', readOnly: false };
  let impersonation: { mode: 'read' | 'write' } | null = null;
  const app = new Hono<Env>();
  app.use('*', async (c, next) => {
    c.set('staff', staff);
    if (impersonation) c.set('impersonation', { id: 'im', tenantId: 't', mode: impersonation.mode, piiRevealed: true, startedAt: '2026-10-16' });
    await next();
  });
  app.route('/', hqTemplates); app.route('/', scoring); app.route('/', booking);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No external requests'); }));

  async function request<T>(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}): Promise<Response<T>> {
    const response = await app.request(path, { method, headers: { 'Content-Type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, { DB: f.db } as Env['Bindings']);
    return { status: response.status, body: await response.json() as Response<T>['body'] };
  }
  const hq = <T = unknown>(suffix: string, method = 'GET', body?: unknown, headers?: Record<string, string>) => request<T>(`/api/hq/templates${suffix}`, method, body, headers);
  return {
    f,
    setStaff(next: Partial<Staff>) { staff = { ...staff, ...next } as Staff; },
    setImpersonation(mode: 'read' | 'write' | null) { impersonation = mode ? { mode } : null; },
    request,
    hq,
    async create(type: HqCatalogTemplateType, definition: unknown = catalogDefinitions[type]) {
      const result = await hq<{ template: { id: string } }>('', 'POST', { type, name: '配るひな形', definition, requestId: crypto.randomUUID() });
      if (result.status !== 201) throw new Error(JSON.stringify(result.body));
      return result.body.data.template.id;
    },
    async save(id: string, definition: unknown) {
      const detail = await hq<{ template: { revision: number } }>(`/${id}`);
      const result = await hq(`/${id}`, 'PATCH', { name: '配るひな形', definition, expectedRevision: detail.body.data.template.revision });
      if (result.status !== 200) throw new Error(JSON.stringify(result.body));
      return this.versionId(id);
    },
    versionId(id: string) {
      return (f.raw.prepare('SELECT current_version_id FROM hq_templates WHERE id=?').get(id) as { current_version_id: string }).current_version_id;
    },
    async check(id: string, accountIds = ['a']) {
      const result = await hq<CatalogPreflight>(`/${id}/preflight`, 'POST', { accountIds });
      if (result.status !== 200) throw new Error(JSON.stringify(result.body));
      return result.body.data;
    },
    run(id: string, p: CatalogPreflight, mode = 'create') {
      return hq<{ status: string; stores: Array<{ accountId: string; status: string }> }>(`/${id}/distribute`, 'POST', { preflightId: p.preflightId,
        resolutions: p.stores.flatMap(s => s.items.map(i => ({ accountId: s.accountId, sourceId: i.sourceId, mode: i.operation === 'reuse' ? 'overwrite' : mode }))) });
    },
    redistribute(id: string, preflightIds: string[], requestKey = `request-${crypto.randomUUID()}`) {
      return hq<RedistributionJobView>(`/${id}/redistributions`, 'POST', { preflightIds, requestKey });
    },
    binding(templateId: string, accountId: string) {
      return f.raw.prepare('SELECT * FROM hq_template_store_bindings WHERE template_id=? AND target_account_id=?').get(templateId, accountId) as
        { target_id: string; applied_version_id: string; pending_version_id: string | null; dismissed_version_id: string | null; applied_snapshot_hash: string; hash_version: number; row_version: number; kind: string } | undefined;
    },
    close() { f.raw.close(); vi.useRealTimers(); vi.unstubAllGlobals(); },
  };
}
export type CatalogFixture = ReturnType<typeof createCatalogFixture>;
