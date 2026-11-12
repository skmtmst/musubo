import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../worker-env.js';

const access = vi.hoisted(() => vi.fn());

vi.mock('../services/account-access.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/account-access.js')>();
  return { ...actual, canAccessAllLineAccounts: access };
});

const { ecCommerce } = await import('./ec-commerce.js');

type Row = Record<string, unknown>;

function fakeDb(rows: Row[] = []) {
  const calls: Array<{ sql: string; bindings: unknown[] }> = [];
  return {
    calls,
    prepare(sql: string) {
      const statement = {
        bindings: [] as unknown[],
        bind(...bindings: unknown[]) {
          statement.bindings = bindings;
          calls.push({ sql, bindings });
          return statement;
        },
        all: async () => ({ results: rows }),
        first: async () => sql.includes('COUNT(*)')
          ? { count: rows.length }
          : { accepted: 1, failed: 1, excluded: 1, pending: 1 },
      };
      return statement;
    },
  };
}

function app() {
  const instance = new Hono<Env>();
  instance.use('*', async (c, next) => {
    c.set('staff', {
      id: 'owner-a', name: '管理者', role: 'owner', readOnly: false, tenantId: 'tenant-a',
    });
    await next();
  });
  instance.route('/', ecCommerce);
  return instance;
}

function deliveryRow(overrides: Row = {}): Row {
  return {
    id: 'delivery-a', audience_type: 'customer', recipient_type: 'friend', recipient_id: 'friend-a',
    channel: 'line', status: 'provider_accepted', retryable: 0, attempts: 1, next_retry_at: null,
    provider_status: 'provider_accepted', error_code: null, error_message_safe: null,
    queued_at: '2026-08-28T09:00:00+09:00', accepted_at: '2026-08-28T09:00:02+09:00',
    execution_mode: 'automatic', version: 1, source_event_type: 'ec.order.confirmed',
    source_event_id: 'external-a', source_metadata_json: '{"orderNumber":"NEN-1001"}',
    definition_name: '注文完了', definition_version: 2, friend_name: '見本 48', clicked_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  access.mockReset();
  access.mockResolvedValue(true);
});

describe('GET /api/ec-commerce/notification-runs compatibility route', () => {
  it('requires an explicitly selected LINE account', async () => {
    const db = fakeDb();
    const response = await app().request('/api/ec-commerce/notification-runs', {}, { DB: db } as never);
    expect(response.status).toBe(400);
    expect(access).not.toHaveBeenCalled();
    expect(db.calls).toHaveLength(0);
  });

  it('rejects a LINE account outside the operator scope', async () => {
    access.mockResolvedValue(false);
    const db = fakeDb();
    const response = await app().request(
      '/api/ec-commerce/notification-runs?lineAccountId=account-b', {}, { DB: db } as never,
    );
    expect(response.status).toBe(403);
    expect(db.calls).toHaveLength(0);
  });

  it('reads the account-scoped common delivery ledger instead of legacy EC events', async () => {
    const db = fakeDb([deliveryRow()]);
    const response = await app().request(
      '/api/ec-commerce/notification-runs?lineAccountId=account-a', {}, { DB: db } as never,
    );
    expect(response.status).toBe(200);
    expect(access).toHaveBeenCalledWith(db, expect.anything(), ['account-a']);
    expect(db.calls).toHaveLength(4);
    for (const call of db.calls) {
      expect(call.sql).toContain('notification_deliveries');
      expect(call.sql).not.toContain('ec_events');
      expect(call.bindings[0]).toBe('account-a');
    }
    expect(db.calls[3].sql).toContain('notification_delivery_attempts');
    expect(db.calls[3].bindings).toEqual(['account-a', 'delivery-a']);
  });

  it('returns provider acceptance, attempts, clicks and the frozen definition version', async () => {
    const response = await app().request(
      '/api/ec-commerce/notification-runs?lineAccountId=account-a',
      {},
      { DB: fakeDb([deliveryRow({ clicked_at: '2026-08-28T09:05:00+09:00' })]) } as never,
    );
    const body = await response.json() as {
      data: { items: Array<Record<string, unknown>>; coverage: Record<string, unknown> };
    };
    expect(body.data.items[0]).toMatchObject({
      status: 'accepted', acceptedAt: '2026-08-28T09:00:02+09:00',
      attemptCount: 1, clickedAt: '2026-08-28T09:05:00+09:00', version: 2,
      retryAvailable: false,
    });
    expect(JSON.stringify(body)).not.toMatch(/届きました|開きました|既読/);
    expect(body.data.coverage).toMatchObject({
      source: 'notification_delivery_ledger', attemptHistoryAvailable: true, retryAvailable: true,
    });
  });

  it('exposes only safe errors and keeps excluded separate from failed', async () => {
    const rows = [
      deliveryRow({ id: 'failed', status: 'retry_wait', retryable: 1, error_message_safe: '一時的な問題です' }),
      deliveryRow({ id: 'excluded', status: 'excluded', error_message_safe: '送信対象外になりました' }),
    ];
    const response = await app().request(
      '/api/ec-commerce/notification-runs?lineAccountId=account-a', {}, { DB: fakeDb(rows) } as never,
    );
    const body = await response.json() as { data: { items: Array<Record<string, unknown>> } };
    expect(body.data.items[0]).toMatchObject({ status: 'failed', retryAvailable: true });
    expect(body.data.items[1]).toMatchObject({ status: 'excluded' });
    expect(JSON.stringify(body)).not.toContain('raw provider response');
  });

  it('limits failures view to excluded and failed/retry-wait records', async () => {
    const db = fakeDb([]);
    const response = await app().request(
      '/api/ec-commerce/notification-runs?lineAccountId=account-a&view=failures', {}, { DB: db } as never,
    );
    expect(response.status).toBe(200);
    expect(db.calls.filter((call) => /d\.status IN \('excluded', 'retry_wait', 'failed'\)/.test(call.sql)))
      .toHaveLength(2);
  });
});
