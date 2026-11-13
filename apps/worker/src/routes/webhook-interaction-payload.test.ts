import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../worker-env.js';

/*
 * やり取りの本文は伏せて返す口。
 * 平文の個人情報が応答に混ざらないこと・無い記録は 404 を見る。
 * DB の読みだけ差し替え、伏せる処理は本物を使う。
 */
const ROW = {
  id: 'int-1',
  line_account_id: 'account-a',
  request_body_json: JSON.stringify({
    name: '田中明',
    phone: '090-0000-5678',
    email: 'tanaka@example.com',
    event: 'order_created',
  }),
};

vi.mock('@line-crm/db', async () => {
  const actual = await vi.importActual<typeof import('@line-crm/db')>('@line-crm/db');
  return {
    ...actual,
    getWebhookInteractionById: vi.fn(async (_db: unknown, id: string) => (
      id === 'int-1' ? ROW : null
    )),
  };
});
vi.mock('../services/account-access.js', () => ({
  canAccessAllLineAccounts: vi.fn(async () => true),
}));

const { webhooks } = await import('./webhooks.js');

function setupApp() {
  const app = new Hono<Env>();
  app.use('*', async (c, next) => {
    c.set('staff', { id: 'owner-1', name: 'Owner', role: 'owner', readOnly: false, tenantId: 'tenant-a' });
    return next();
  });
  app.route('/', webhooks);
  return app;
}

const env = { DB: {} as D1Database } as unknown as Env['Bindings'];

describe('GET /api/webhooks/interactions/:id/payload', () => {
  it('本文の個人情報を伏せて返す', async () => {
    const app = setupApp();
    const res = await app.request('/api/webhooks/interactions/int-1/payload?lineAccountId=account-a', {}, env);
    expect(res.status).toBe(200);
    const payload = await res.json() as { success: boolean; data: { id: string; body: Record<string, unknown>; available: boolean } };
    expect(payload.data.id).toBe('int-1');
    expect(payload.data.available).toBe(true);
    expect(payload.data.body).toEqual({
      name: '***',
      phone: '***',
      email: '***',
      event: 'order_created',
    });
    expect(JSON.stringify(payload)).not.toContain('田中明');
  });

  it('無い記録は 404', async () => {
    const app = setupApp();
    const res = await app.request('/api/webhooks/interactions/nope/payload?lineAccountId=account-a', {}, env);
    expect(res.status).toBe(404);
  });
});
