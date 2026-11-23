import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../worker-env.js';

const mocks = vi.hoisted(() => ({
  canAccess: vi.fn(),
  getRules: vi.fn(),
  getRule: vi.fn(),
  createRule: vi.fn(),
  updateRule: vi.fn(),
  deleteRule: vi.fn(),
  getNotifications: vi.fn(),
}));

vi.mock('../services/account-access.js', () => ({
  canAccessAllLineAccounts: mocks.canAccess,
}));
vi.mock('@line-crm/db', () => ({
  getNotificationRules: mocks.getRules,
  getNotificationRuleById: mocks.getRule,
  createNotificationRule: mocks.createRule,
  updateNotificationRule: mocks.updateRule,
  deleteNotificationRule: mocks.deleteRule,
  getNotifications: mocks.getNotifications,
}));

const { notifications } = await import('./notifications.js');

function app() {
  const instance = new Hono<Env>();
  instance.use('*', async (c, next) => {
    c.set('staff', {
      id: 'owner-a', name: '管理者', role: 'owner', readOnly: false, tenantId: 'tenant-a',
    });
    await next();
  });
  instance.route('/', notifications);
  return instance;
}

const env = { DB: {} as D1Database } as Env['Bindings'];
const rule = {
  id: 'rule-a', name: '予約通知', event_type: 'booking_created',
  conditions: '{}', channels: '["dashboard"]', line_account_id: 'account-a',
  is_active: 1, created_at: '2026-08-28', updated_at: '2026-08-28',
};
const draftRule = { ...rule, is_active: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.canAccess.mockResolvedValue(true);
  mocks.getRules.mockResolvedValue([rule]);
  mocks.getRule.mockResolvedValue(rule);
  mocks.createRule.mockResolvedValue(draftRule);
  mocks.getNotifications.mockResolvedValue([]);
});

describe('operator notification account boundary', () => {
  it('updates legacy LINE token instructions when displaying notification history', async () => {
    mocks.getNotifications.mockResolvedValue([{
      id: 'old-token-notice', event_type: 'line_token_expired', title: 'トークンの期限が切れています',
      body: 'LINEの接続の設定でトークンを更新してください。', metadata: '{"reason":"temporary"}',
      category: 'error', channel: 'dashboard', status: 'sent',
    }]);
    const response = await app().request('/api/notifications?lineAccountId=account-a', {}, env);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ data: [{
      id: 'old-token-notice',
      title: 'LINE接続の自動更新を再試行しています',
      body: '接続状況はLINEアカウントの詳細で確認できます。',
    }] });
  });

  it('does not provide a global rule list when no account is selected', async () => {
    const response = await app().request('/api/notifications/rules', {}, env);
    expect(response.status).toBe(400);
    expect(mocks.getRules).not.toHaveBeenCalled();
  });

  it('rejects an account outside the current operator scope', async () => {
    mocks.canAccess.mockResolvedValue(false);
    const response = await app().request(
      '/api/notifications/rules?lineAccountId=account-b', {}, env,
    );
    expect(response.status).toBe(403);
    expect(mocks.getRules).not.toHaveBeenCalled();
  });

  it('lists only rules from the selected account', async () => {
    const response = await app().request(
      '/api/notifications/rules?lineAccountId=account-a', {}, env,
    );
    expect(response.status).toBe(200);
    expect(mocks.getRules).toHaveBeenCalledWith(env.DB, 'account-a');
  });

  it('creates a rule inside the authorized account', async () => {
    const response = await app().request('/api/notifications/rules', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        lineAccountId: 'account-a', name: '予約通知', eventType: 'booking_created',
      }),
    }, env);
    expect(response.status).toBe(201);
    expect(mocks.createRule).toHaveBeenCalledWith(env.DB, expect.objectContaining({
      lineAccountId: 'account-a', name: '予約通知', eventType: 'booking_created',
      channels: ['dashboard'],
    }));
    const body = await response.json() as { data: { isActive: boolean } };
    expect(body.data.isActive).toBe(false);
  });

  it('does not publish a rule before recipient resolution and delivery are connected', async () => {
    const response = await app().request('/api/notifications/rules/rule-a', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lineAccountId: 'account-a', isActive: true }),
    }, env);
    expect(response.status).toBe(409);
    expect(mocks.updateRule).not.toHaveBeenCalled();
  });

  it('rejects an unknown delivery channel instead of saving an inert value', async () => {
    const response = await app().request('/api/notifications/rules', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        lineAccountId: 'account-a', name: '予約通知', eventType: 'booking_created',
        channels: ['slack'],
      }),
    }, env);
    expect(response.status).toBe(400);
    expect(mocks.createRule).not.toHaveBeenCalled();
  });

  it('looks up and updates the rule through the same account boundary', async () => {
    const response = await app().request('/api/notifications/rules/rule-a', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lineAccountId: 'account-a', name: '予約の運用者通知' }),
    }, env);
    expect(response.status).toBe(200);
    expect(mocks.getRule).toHaveBeenCalledWith(env.DB, 'rule-a', 'account-a');
    expect(mocks.updateRule).toHaveBeenCalledWith(
      env.DB, 'rule-a', 'account-a', expect.objectContaining({ name: '予約の運用者通知' }),
    );
  });

  it('scopes the delivery history to the selected account', async () => {
    const response = await app().request(
      '/api/notifications?lineAccountId=account-a&status=failed&limit=20', {}, env,
    );
    expect(response.status).toBe(200);
    expect(mocks.getNotifications).toHaveBeenCalledWith(env.DB, {
      lineAccountId: 'account-a', status: 'failed', limit: 20, staffId:'owner-a',
    });
  });
});
