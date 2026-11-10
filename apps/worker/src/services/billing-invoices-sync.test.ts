import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../worker-env.js';
import type { AuthenticatedStaff } from '../middleware/auth/principal/auth.js';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';

const listInvoices = vi.hoisted(() => vi.fn());
vi.mock('./stripe-api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./stripe-api.js')>();
  return { ...actual, stripeApi: { ...actual.stripeApi, listInvoices } };
});

const { syncBillingInvoices, syncBillingInvoicesDaily } = await import('./billing-invoices-sync.js');
const { opsBilling } = await import('../routes/ops-billing.js');

let testDb: SqliteD1;

const master: AuthenticatedStaff = {
  id: 'master-1', name: '運営 太郎', role: 'owner', readOnly: false, tenantId: null,
};

function invoice(id: string, amount = 9_800) {
  return {
    id,
    number: id,
    status: 'paid',
    amount_paid: amount,
    amount_due: amount,
    amount_remaining: 0,
    currency: 'jpy',
    created: 1_760_000_000,
    customer: 'cus_a',
    subscription: 'sub_a',
    charge: { id: `ch_${id}`, amount_refunded: 0 },
    period_start: 1_760_000_000,
    period_end: 1_762_592_000,
    status_transitions: { paid_at: 1_760_000_100 },
    hosted_invoice_url: null,
    invoice_pdf: null,
    lines: { data: [{ description: 'ライト', price: { recurring: { interval: 'month' } } }] },
  };
}

beforeEach(() => {
  testDb = createTestD1();
  listInvoices.mockReset();
  testDb.raw.prepare(`INSERT INTO tenants (id, name, status, plan_status, plan_key, stripe_customer_id) VALUES
    ('tenant-a', 'A社', 'active', 'active', 'light', 'cus_a'),
    ('tenant-b', 'B社', 'active', 'active', 'standard', 'cus_b'),
    ('tenant-exempt', '対象外', 'active', 'exempt', NULL, 'cus_exempt')`).run();
  testDb.raw.prepare(`INSERT INTO staff_members (id, name, role, api_key, tenant_id) VALUES ('master-1', '運営 太郎', 'owner', 'key', NULL)`).run();
  testDb.raw.prepare(`INSERT INTO platform_admins (staff_id, is_active) VALUES ('master-1', 1)`).run();
});

describe('Stripe請求書同期', () => {
  it('新料金の契約は旧plan_statusがexemptでも同期対象に含める', async () => {
    testDb.raw.prepare(`INSERT INTO musubo_tenant_billing
      (tenant_id,pricing_snapshot_json,billing_interval,status,core_subscription_id,created_at,updated_at)
      VALUES ('tenant-exempt','{}','month','active','sub_new','2026-11-09','2026-11-09')`).run();
    listInvoices.mockResolvedValue({ data: [], has_more: false });
    const result = await syncBillingInvoices(
      { DB: testDb.db, STRIPE_SECRET_KEY: 'sk_test_x' },
      { since: new Date('2026-11-01T00:00:00Z'), now: new Date('2026-11-09T00:00:00Z') },
    );
    expect(result).toMatchObject({ tenants: 3, failed: 0 });
    expect(listInvoices.mock.calls.map((call) => call[1])).toContain('cus_exempt');
  });

  it('3ページを最後まで取り込み、再実行しても請求書が重複しない', async () => {
    listInvoices.mockImplementation(async (_env, customer: string, options: { startingAfter?: string; createdGte?: number }) => {
      if (customer === 'cus_b') return { data: [], has_more: false };
      if (!options.startingAfter) return { data: [invoice('in_1')], has_more: true };
      if (options.startingAfter === 'in_1') return { data: [invoice('in_2')], has_more: true };
      return { data: [invoice('in_3')], has_more: false };
    });
    const since = new Date('2025-09-25T00:00:00.000Z');
    const first = await syncBillingInvoices({ DB: testDb.db, STRIPE_SECRET_KEY: 'sk_test_x' }, { since, now: new Date('2026-09-25T00:00:00.000Z') });
    const second = await syncBillingInvoices({ DB: testDb.db, STRIPE_SECRET_KEY: 'sk_test_x' }, { since, now: new Date('2026-09-25T00:01:00.000Z') });
    expect(first).toMatchObject({ imported: 3, failed: 0, completed: true, tenants: 2 });
    expect(second).toMatchObject({ imported: 3, failed: 0, completed: true });
    expect(testDb.raw.prepare('SELECT COUNT(*) AS n FROM billing_invoices').get()).toMatchObject({ n: 3 });
    expect(listInvoices.mock.calls[0]?.[2]).toMatchObject({ createdGte: Math.floor(since.getTime() / 1000) });
    expect(listInvoices.mock.calls.some((call) => call[2]?.startingAfter === 'in_2')).toBe(true);
  });

  it('1契約先が失敗しても次を続け、同期時刻を進めない', async () => {
    listInvoices.mockImplementation(async (_env, customer: string) => {
      if (customer === 'cus_a') throw new TypeError('network');
      return { data: [{ ...invoice('in_b'), customer: 'cus_b' }], has_more: false };
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await syncBillingInvoices(
      { DB: testDb.db, STRIPE_SECRET_KEY: 'sk_test_x' },
      { since: new Date('2025-09-25T00:00:00.000Z'), now: new Date('2026-09-25T00:00:00.000Z') },
    );
    expect(result).toMatchObject({ imported: 1, failed: 1, completed: false, syncedAt: null });
    expect(testDb.raw.prepare(`SELECT value FROM platform_settings WHERE key = 'billing_invoices_last_synced_at'`).get()).toBeUndefined();
    expect(warn.mock.calls.join(' ')).toContain('billing_invoice_sync_failed');
    expect(warn.mock.calls.join(' ')).not.toContain('tenant-a');
    expect(warn.mock.calls.join(' ')).not.toContain('9,800');
    warn.mockRestore();
  });

  it('Stripe未設定の手動同期は503で、外部通信しない', async () => {
    const app = new Hono<Env>();
    app.use('*', async (c, next) => { c.set('staff', master); return next(); });
    app.route('/', opsBilling);
    const res = await app.request('/api/ops/billing/sync', { method: 'POST', body: JSON.stringify({ months: 12 }), headers: { 'Content-Type': 'application/json' } }, { DB: testDb.db } as Env['Bindings']);
    expect(res.status).toBe(503);
    expect(listInvoices).not.toHaveBeenCalled();
  });

  it('Stripe未設定の定期同期はDBも外部通信も使わず静かに止まる', async () => {
    const result = await syncBillingInvoicesDaily({ DB: testDb.db });
    expect(result).toBeNull();
    expect(listInvoices).not.toHaveBeenCalled();
  });

  it('手動同期は1〜12か月を受け付け、件数だけを監査する', async () => {
    listInvoices.mockResolvedValue({ data: [], has_more: false });
    const app = new Hono<Env>();
    app.use('*', async (c, next) => { c.set('staff', master); return next(); });
    app.route('/', opsBilling);
    const bindings = { DB: testDb.db, STRIPE_SECRET_KEY: 'sk_test_x' } as Env['Bindings'];
    const invalid = await app.request('/api/ops/billing/sync', { method: 'POST', body: JSON.stringify({ months: 13 }), headers: { 'Content-Type': 'application/json' } }, bindings);
    expect(invalid.status).toBe(400);
    const res = await app.request('/api/ops/billing/sync', { method: 'POST', body: JSON.stringify({ months: 6 }), headers: { 'Content-Type': 'application/json' } }, bindings);
    expect(res.status).toBe(200);
    expect((await res.json<{ data: { tenants: number; imported: number; failed: number } }>()).data).toMatchObject({ tenants: 2, imported: 0, failed: 0 });
    const audit = testDb.raw.prepare(`SELECT action, detail FROM platform_audit_logs WHERE action = 'billing.sync'`).get() as { action: string; detail: string };
    expect(audit.action).toBe('billing.sync');
    expect(JSON.parse(audit.detail)).toMatchObject({ months: 6, imported: 0, failed: 0, tenants: 2 });
  });
});
