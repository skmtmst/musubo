import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../worker-env.js';

const accountAccess = vi.hoisted(() => ({ canAccessAllLineAccounts: vi.fn(async () => true) }));
vi.mock('../services/account-access.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/account-access.js')>();
  return { ...actual, canAccessAllLineAccounts: accountAccess.canAccessAllLineAccounts };
});

const { ecCommerce } = await import('./ec-commerce.js');

function asD1(sqlite: Database.Database): D1Database {
  return {
    prepare(sql: string) {
      const statement = sqlite.prepare(sql);
      const bound = (bindings: unknown[]): D1PreparedStatement => ({
        bind: (...next: unknown[]) => bound(next),
        all: async <T>() => ({ success: true, results: statement.all(...bindings) as T[], meta: {} }),
        first: async <T>() => (statement.get(...bindings) as T | undefined) ?? null,
        run: async <T>() => {
          const result = statement.run(...bindings);
          return { success: true, results: [], meta: { changes: result.changes } } as T;
        },
        raw: async () => [],
      } as unknown as D1PreparedStatement);
      return bound([]);
    },
  } as unknown as D1Database;
}

function makeApp(db: D1Database) {
  const app = new Hono<Env>();
  app.use('*', async (c, next) => {
    c.set('staff', { id: 'owner-1', name: '管理者', role: 'owner', readOnly: false });
    await next();
  });
  app.route('/', ecCommerce);
  return { app, env: { DB: db } as Env['Bindings'] };
}

type ImportListBody = {
  data: {
    total: number;
    items: Array<{
      eventType: string;
      eventLabel: string;
      orderNumber: string | null;
      order: { orderNumber: string; orderLines: Array<{ productName: string }> } | null;
    }>;
  };
};

describe('Issue #685 EC取込一覧API', () => {
  let sqlite: Database.Database;
  let db: D1Database;

  beforeEach(() => {
    vi.clearAllMocks();
    accountAccess.canAccessAllLineAccounts.mockResolvedValue(true);
    sqlite = new Database(':memory:');
    sqlite.exec(readFileSync(join(process.cwd(), '../../packages/db/bootstrap.sql'), 'utf8'));
    sqlite.exec(`
      INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
      VALUES ('account-a', 'channel-a', '本店', 'token-a', 'secret-a');
      INSERT INTO friends (id, line_user_id, display_name, line_account_id)
      VALUES ('friend-a', 'U-a', '見本 171', 'account-a');
    `);

    const now = Date.now();
    const insertEvent = sqlite.prepare(`
      INSERT INTO ec_events
        (id, source, external_event_id, event_type, line_account_id, customer_id,
         friend_id, payload, status, received_at, processed_at, updated_at)
      VALUES (?, 'eccube:account-a', ?, ?, 'account-a', ?, 'friend-a', ?, 'processed', ?, ?, ?)
    `);
    const insertOrder = sqlite.prepare(`
      INSERT INTO ec_orders
        (id, line_account_id, source_key, external_order_id, customer_id, friend_id,
         order_number, normalized_status, provider_status, currency, total_amount_minor,
         refunded_amount_minor, ordered_at, detail_url, last_event_id, version, created_at, updated_at)
      VALUES (?, 'account-a', 'eccube:account-a', ?, ?, 'friend-a', ?, 'current',
              'paid', 'JPY', ?, NULL, ?, NULL, ?, 1, ?, ?)
    `);
    const insertLine = sqlite.prepare(`
      INSERT INTO ec_order_lines
        (id, order_id, line_index, external_product_id, product_name, quantity,
         unit_amount_minor, line_amount_minor, product_url, created_at)
      VALUES (?, ?, 0, ?, ?, 1, ?, ?, NULL, ?)
    `);
    const insertAction = sqlite.prepare(`
      INSERT INTO ec_action_executions
        (id, event_id, line_account_id, action_type, rule_version, idempotency_key,
         status, attempt_count, max_attempts, version, created_at, updated_at)
      VALUES (?, ?, 'account-a', 'line_notification', 'v1', ?, 'succeeded', 1, 3, 1, ?, ?)
    `);

    sqlite.transaction(() => {
      for (let index = 1; index <= 21; index += 1) {
        const id = String(index).padStart(2, '0');
        const eventId = `event-${id}`;
        const orderId = `order-${id}`;
        const orderNumber = `NEN-${id}`;
        const receivedAt = new Date(now - index * 60_000).toISOString();
        const occurredAt = new Date(Date.parse(receivedAt) - 30_000).toISOString();
        const eventType = index === 21 ? 'ec.partner.custom_event' : 'ec.order.confirmed';
        const payload = JSON.stringify({ occurred_at: occurredAt, order: { number: orderNumber } });
        insertEvent.run(eventId, `external-${id}`, eventType, `customer-${id}`, payload, receivedAt, receivedAt, receivedAt);
        insertOrder.run(orderId, orderNumber, `customer-${id}`, orderNumber, index * 100, receivedAt, eventId, receivedAt, receivedAt);
        insertLine.run(`line-${id}`, orderId, `product-${id}`, `商品${index}`, index * 100, index * 100, receivedAt);
        insertAction.run(`action-${id}`, eventId, `action-key-${id}`, receivedAt, receivedAt);
      }
    })();
    db = asD1(sqlite);
  });

  it('21件目の商品明細を同じ取込行へ結び、未知種別を元の値で返す', async () => {
    const { app, env } = makeApp(db);
    const response = await app.request(
      '/api/ec-commerce/events?lineAccountId=account-a&view=actions&limit=20&offset=20',
      {}, env,
    );
    expect(response.status).toBe(200);
    const body = await response.json() as ImportListBody;
    expect(body.data.total).toBe(21);
    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0]).toMatchObject({
      eventType: 'ec.partner.custom_event',
      eventLabel: 'ec.partner.custom_event',
      orderNumber: 'NEN-21',
      order: { orderNumber: 'NEN-21', orderLines: [{ productName: '商品21' }] },
    });
  });

  it('検索をLIMIT/OFFSETより前に適用し、ページ外の商品でも見つける', async () => {
    const { app, env } = makeApp(db);
    const response = await app.request(
      '/api/ec-commerce/events?lineAccountId=account-a&view=actions&limit=20&offset=0&query=%E5%95%86%E5%93%8121',
      {}, env,
    );
    expect(response.status).toBe(200);
    const body = await response.json() as ImportListBody;
    expect(body.data.total).toBe(1);
    expect(body.data.items[0]).toMatchObject({
      orderNumber: 'NEN-21',
      order: { orderLines: [{ productName: '商品21' }] },
    });
  });

  it('直近24時間の実測到着時間と測定件数を返す', async () => {
    const { app, env } = makeApp(db);
    const response = await app.request('/api/ec-commerce/overview?lineAccountId=account-a', {}, env);
    expect(response.status).toBe(200);
    const body = await response.json() as { data: { averageDeliverySeconds: number | null; latencySampleCount: number } };
    expect(body.data.averageDeliverySeconds).toBe(30);
    expect(body.data.latencySampleCount).toBe(21);
  });
});
