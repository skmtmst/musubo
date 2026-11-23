import { describe, expect, test } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../worker-env.js';
import { webhooks } from './webhooks.js';

/*
 * 担当者は全操作を拒否し、管理者は定義の通常操作のみ許可する。
 * 削除・API鍵と既存secret差替えは引き続きオーナー限定。
 * 管理者のPOST/通常PUT/PATCHの成功と範囲外副作用0は、
 * webhooks-management-permissions.test.ts の実D1行列で照合する。
 * 拒否はDB・step-upより前で、内部SQLも返さない。
 */
function setupApp(role: 'owner' | 'admin' | 'staff') {
  const app = new Hono<Env>();
  app.use('*', async (c, next) => {
    c.set('staff', {
      id: 'staff-1', name: 'Staff', role, readOnly: false, tenantId: undefined,
    });
    return next();
  });
  app.route('/', webhooks);
  return app;
}

const baseEnv = { DB: {} } as Record<string, unknown>;

const OWNER_ONLY_CALLS: Array<{ method: string; path: string; body?: unknown }> = [
  { method: 'POST', path: '/api/webhooks/incoming', body: { name: 'x', secret: 's'.repeat(32), lineAccountId: 'a' } },
  { method: 'PUT', path: '/api/webhooks/incoming/iwh-1?lineAccountId=a', body: { name: 'x' } },
  { method: 'DELETE', path: '/api/webhooks/incoming/iwh-1?lineAccountId=a' },
  { method: 'PATCH', path: '/api/webhooks/incoming/iwh-1/config?lineAccountId=a', body: {} },
  { method: 'POST', path: '/api/webhooks/outgoing', body: { name: 'x' } },
  { method: 'PUT', path: '/api/webhooks/outgoing/owh-1?lineAccountId=a', body: { name: 'x' } },
  { method: 'DELETE', path: '/api/webhooks/outgoing/owh-1?lineAccountId=a' },
  { method: 'POST', path: '/api/webhooks/api-tokens', body: { name: 'x' } },
  { method: 'POST', path: '/api/webhooks/api-tokens/tok-1/reactivate?lineAccountId=a' },
];

describe('webhooks の役割ごとの操作境界（R32/D43）', () => {
  for (const role of ['admin', 'staff'] as const) {
    test(`${role} の許可外の操作は 403 になる`, async () => {
      const app = setupApp(role);
      const calls = role === 'staff' ? OWNER_ONLY_CALLS : [
        ...OWNER_ONLY_CALLS.filter(call => call.method === 'DELETE' || call.path.includes('/api-tokens')),
        ...(['incoming/iwh-1', 'outgoing/owh-1'] as const).map(path => ({
          method: 'PUT', path: `/api/webhooks/${path}?lineAccountId=a`,
          body: { name: '一部だけも保存不可', secret: 's'.repeat(32) },
        })),
      ];
      for (const call of calls) {
        const res = await app.request(call.path, {
          method: call.method,
          headers: { 'Content-Type': 'application/json' },
          body: call.body === undefined ? undefined : JSON.stringify(call.body),
        }, baseEnv);
        expect(res.status, `${role} ${call.method} ${call.path}`).toBe(403);
        const payload = await res.json() as { success: boolean; error: string };
        expect(payload.success).toBe(false);
        if (role === 'admin' && call.method === 'PUT') {
          expect(payload.error).toBe('合言葉の変更はオーナーだけができます');
        } else {
          expect(payload.error).toContain('権限');
        }
        expect(JSON.stringify(payload)).not.toContain('SELECT');
      }
    });
  }

  test('統括は門番を通る（step-up の手前で止めない）', async () => {
    const app = setupApp('owner');
    const res = await app.request('/api/webhooks/incoming', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x', secret: 's'.repeat(32), lineAccountId: 'a' }),
    }, baseEnv);
    // 本人確認（step-up）が先に求められる＝役割の門番は通った。
    expect(res.status).not.toBe(403);
  });
});
