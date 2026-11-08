import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../worker-env.js';
import { requireRole } from './role-guard.js';
import { isHqAdministratorOperation, isHqBusinessOperation } from './hq-role-policy.js';

describe('統括の担当者と管理者の境界', () => {
  it('業務APIだけを担当者に開き、メンバー・契約・返金を閉じる', () => {
    expect(isHqBusinessOperation('POST', '/api/hq/templates/items', 'operator-1')).toBe(true);
    expect(isHqBusinessOperation('POST', '/api/booking/admin/menus', 'operator-1')).toBe(true);
    expect(isHqBusinessOperation('POST', '/api/mcp-connections', 'operator-1')).toBe(true);
    for (const path of ['/api/staff', '/api/hq/billing/checkout', '/api/integrations/stripe/connect', '/api/booking/admin/payment-connection', '/api/booking/admin/payment-config', '/api/booking/admin/menus/menu-1/payment', '/api/events/admin/events/event-1/payment', '/api/restaurant-test/menus/menu-1/payment', '/api/booking/payments/pay-1/refund', '/api/booking/admin/charges/charge-1/refund', '/api/affiliate-payments/pay-1/confirm', '/api/affiliate-payout-batches/batch-1/download']) {
      expect(isHqAdministratorOperation('POST', path, 'operator-1')).toBe(true);
      expect(isHqBusinessOperation('POST', path, 'operator-1')).toBe(false);
    }
  });

  it('管理者を要求する業務は統括の担当者だけに開き、店舗スタッフと閲覧者には開かない', async () => {
    const request = async (hqRole: 'operator' | 'viewer' | null, method: 'GET' | 'POST', path: string) => {
      const app = new Hono<Env>();
      app.use('*', async (c, next) => {
        c.set('staff', { id: 'operator-1', name: '担当者', role: 'staff', readOnly: hqRole === 'viewer', hqRole });
        await next();
      });
      app.on(['GET', 'POST'], '*', requireRole('owner', 'admin'), c => c.text('ok'));
      return app.request(path, { method });
    };
    expect((await request('operator', 'POST', '/api/hq/templates/items')).status).toBe(200);
    expect((await request(null, 'POST', '/api/hq/templates/items')).status).toBe(403);
    expect((await request('viewer', 'POST', '/api/hq/templates/items')).status).toBe(403);
    expect((await request('viewer', 'GET', '/api/hq/templates/items')).status).toBe(200);
    expect((await request('operator', 'POST', '/api/hq/billing/checkout')).status).toBe(403);
    expect((await request('operator', 'POST', '/api/staff')).status).toBe(403);
  });
});
