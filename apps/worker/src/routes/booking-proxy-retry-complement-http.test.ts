/**
 * 予約保存後の履歴失敗は、同じ要求の再送で補完してから成功を返す。
 *
 * 実 Worker + 実 D1（better-sqlite3 に bootstrap.sql を流したもの）で検証する。
 * 予約INSERTまでは済んだが履歴（created の監査記録）が残っていない保留状態から
 * 同じ Idempotency-Key を再送したとき、作り直さず不足の履歴を埋めて成功を返す。
 *
 * - 再送は 201 replayed で同じ予約IDを返し、created の履歴が1件残る。
 * - さらにもう一度送っても履歴は増えない（補完は重ね書きしない）。
 * - 予約も履歴も無いキーの再送は従来どおり進行中として扱う（409）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { Env } from '../worker-env.js';
import { reserveIdempotencyResponse } from '../features/booking/booking-idempotency.js';

const ENCRYPTION_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

const access = vi.hoisted(() => ({
  canAccessAllLineAccounts: vi.fn(async (_db: unknown, _staff: unknown, ids: string[]) => (
    ids.every((id) => id === 'account-a')
  )),
}));
vi.mock('../services/account-access.js', () => access);

function asD1(sqlite: Database.Database): D1Database {
  const wrap = (sql: string, params: unknown[]) => ({
    first: async <T>() => (sqlite.prepare(sql).get(...params) as T | undefined) ?? null,
    all: async <T>() => ({ success: true, results: sqlite.prepare(sql).all(...params) as T[], meta: {} }),
    run: async <T>() => {
      const info = sqlite.prepare(sql).run(...params);
      return { success: true, results: [], meta: { changes: info.changes } } as T;
    },
    raw: async () => [],
  });
  return {
    prepare: (sql: string) => {
      const bound = (params: unknown[]): D1PreparedStatement => ({
        bind: (...next: unknown[]) => bound(next),
        ...wrap(sql, params),
      } as unknown as D1PreparedStatement);
      return bound([]);
    },
    async batch<T>(statements: D1PreparedStatement[]) {
      const results = [];
      sqlite.exec('BEGIN');
      try {
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec('COMMIT');
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
      return results as T;
    },
  } as unknown as D1Database;
}

function makeApp(db: D1Database, route: Hono<Env>) {
  const app = new Hono<Env>();
  app.use('*', async (c, next) => {
    c.set('staff', {
      id: 'owner-1', name: 'owner', role: 'owner', readOnly: false,
      permissionKeys: [], viewPermissionKeys: [],
    });
    return next();
  });
  app.route('/', route);
  const env = { DB: db, LINE_CREDENTIAL_ENCRYPTION_KEY: ENCRYPTION_KEY } as unknown as Env['Bindings'];
  return { app, env };
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

let sqlite: Database.Database;
let db: D1Database;
let bookingRoute: Hono<Env>;

beforeEach(async () => {
  sqlite = new Database(':memory:');
  sqlite.exec(readFileSync(join(import.meta.dirname, '..', '..', '..', '..', 'packages', 'db', 'bootstrap.sql'), 'utf8'));
  sqlite.pragma('foreign_keys = OFF');
  sqlite.prepare(`INSERT INTO line_accounts
    (id,channel_id,name,channel_access_token,channel_secret)
    VALUES ('account-a','channel-a','A店','token','secret')`).run();
  db = asD1(sqlite);
  ({ default: bookingRoute } = await import('./booking.js'));
  access.canAccessAllLineAccounts.mockClear();
});

function auditCount(bookingId: string): number {
  const row = sqlite.prepare(
    `SELECT COUNT(*) AS n FROM booking_audit_logs WHERE booking_id = ? AND action = 'created'`,
  ).get(bookingId) as { n: number };
  return row.n;
}

const BOOKING_BODY = {
  menu_id: 'menu-1',
  staff_id: 'staff-1',
  starts_at: new Date(Date.now() + 24 * 3600_000).toISOString(),
};

describe('R560 予約後の履歴不足は再送で補完する', () => {
  test('履歴の無い保留予約への再送は履歴を埋めて201 replayed', async () => {
    const { app, env } = makeApp(db, bookingRoute);
    // 電話客の台帳を実POSTで作る。
    const customerRes = await app.request('/api/booking/admin/customers?account_id=account-a', {
      method: 'POST', headers: JSON_HEADERS,
      body: JSON.stringify({ display_name: '見本 143', phone: '090-0000-5678' }),
    }, env);
    expect(customerRes.status).toBe(201);
    const customerId = ((await customerRes.json()) as { customer: { id: string } }).customer.id;

    // 予約INSERTまでは済んだが履歴が残っていない保留状態を作る
    // （履歴書き込みの失敗で complete まで届かなかったときと同じ形）。
    const bookingId = 'booking-r560-1';
    const nowIso = new Date().toISOString();
    sqlite.prepare(`INSERT INTO bookings
      (id, line_account_id, friend_id, booking_customer_id, staff_id, menu_id,
       starts_at, ends_at, block_ends_at, status, price_at_booking,
       requested_at, decided_at, source, created_by_staff_id,
       notification_policy_snapshot)
      VALUES (?, 'account-a', NULL, ?, 'staff-1', 'menu-1',
       ?, ?, ?, 'confirmed', 5000,
       ?, ?, 'phone', 'owner-1', ?)`)
      .run(
        bookingId, customerId,
        BOOKING_BODY.starts_at, BOOKING_BODY.starts_at, BOOKING_BODY.starts_at,
        nowIso, nowIso,
        JSON.stringify({ send_line_confirmation: false, day_before: false, hours_before: false }),
      );
    await reserveIdempotencyResponse(db, {
      key: 'proxy-try-r560',
      lineAccountId: 'account-a',
      friendId: `booking-customer:${customerId}`,
      body: { error: 'request_in_progress', booking_id: bookingId },
      ttlMinutes: 5,
      now: new Date(),
    });
    expect(auditCount(bookingId)).toBe(0);

    const retry = await app.request('/api/booking/admin/bookings?account_id=account-a', {
      method: 'POST',
      headers: { ...JSON_HEADERS, 'Idempotency-Key': 'proxy-try-r560' },
      body: JSON.stringify({ booking_customer_id: customerId, ...BOOKING_BODY }),
    }, env);
    expect(retry.status).toBe(201);
    const retryBody = await retry.json() as { booking_id: string; replayed?: boolean };
    expect(retryBody.booking_id).toBe(bookingId);
    expect(retryBody.replayed).toBe(true);
    // 不足していた履歴が再送で埋まる。
    expect(auditCount(bookingId)).toBe(1);

    // もう一度送っても履歴は増えない。
    const retry2 = await app.request('/api/booking/admin/bookings?account_id=account-a', {
      method: 'POST',
      headers: { ...JSON_HEADERS, 'Idempotency-Key': 'proxy-try-r560' },
      body: JSON.stringify({ booking_customer_id: customerId, ...BOOKING_BODY }),
    }, env);
    expect(retry2.status).toBe(201);
    expect(auditCount(bookingId)).toBe(1);
  });

  test('R560残差: 取り消し済み予約への再送は副作用を積まず今の状態を返す', async () => {
    const { app, env } = makeApp(db, bookingRoute);
    const customerRes = await app.request('/api/booking/admin/customers?account_id=account-a', {
      method: 'POST', headers: JSON_HEADERS,
      body: JSON.stringify({ display_name: '見本 143', phone: '090-0000-5678' }),
    }, env);
    expect(customerRes.status).toBe(201);
    const customerId = ((await customerRes.json()) as { customer: { id: string } }).customer.id;

    // 仮応答のまま取り消された予約（取消API自体ではなく取消後の状態を再現）。
    const bookingId = 'booking-r560-cancelled';
    const nowIso = new Date().toISOString();
    sqlite.prepare(`INSERT INTO bookings
      (id, line_account_id, friend_id, booking_customer_id, staff_id, menu_id,
       starts_at, ends_at, block_ends_at, status, price_at_booking,
       requested_at, decided_at, source, created_by_staff_id,
       notification_policy_snapshot)
      VALUES (?, 'account-a', NULL, ?, 'staff-1', 'menu-1',
       ?, ?, ?, 'cancelled', 5000,
       ?, ?, 'phone', 'owner-1', ?)`)
      .run(
        bookingId, customerId,
        BOOKING_BODY.starts_at, BOOKING_BODY.starts_at, BOOKING_BODY.starts_at,
        nowIso, nowIso,
        JSON.stringify({ send_line_confirmation: false, day_before: false, hours_before: false }),
      );
    await reserveIdempotencyResponse(db, {
      key: 'proxy-try-r560-cancelled',
      lineAccountId: 'account-a',
      friendId: `booking-customer:${customerId}`,
      body: { error: 'request_in_progress', booking_id: bookingId },
      ttlMinutes: 5,
      now: new Date(),
    });
    const queuedBefore = (sqlite.prepare(
      `SELECT COUNT(*) AS n FROM booking_operation_runs WHERE booking_id = ?`,
    ).get(bookingId) as { n: number }).n;

    const retry = await app.request('/api/booking/admin/bookings?account_id=account-a', {
      method: 'POST',
      headers: { ...JSON_HEADERS, 'Idempotency-Key': 'proxy-try-r560-cancelled' },
      body: JSON.stringify({ booking_customer_id: customerId, ...BOOKING_BODY }),
    }, env);
    expect(retry.status).toBe(201);
    const retryBody = await retry.json() as { booking_id: string; status: string; replayed?: boolean };
    expect(retryBody.booking_id).toBe(bookingId);
    expect(retryBody.status).toBe('cancelled');
    expect(retryBody.replayed).toBe(true);
    // 取消済みへの再送でカレンダー作成などの副作用を積まない。
    const queuedAfter = (sqlite.prepare(
      `SELECT COUNT(*) AS n FROM booking_operation_runs WHERE booking_id = ?`,
    ).get(bookingId) as { n: number }).n;
    expect(queuedAfter).toBe(queuedBefore);
    const calendarOps = (sqlite.prepare(
      `SELECT COUNT(*) AS n FROM booking_operation_runs WHERE booking_id = ? AND kind = 'google_calendar'`,
    ).get(bookingId) as { n: number }).n;
    expect(calendarOps).toBe(0);
  });

  test('予約の無い保留キーへの再送は進行中として扱う', async () => {
    const { app, env } = makeApp(db, bookingRoute);
    const customerRes = await app.request('/api/booking/admin/customers?account_id=account-a', {
      method: 'POST', headers: JSON_HEADERS,
      body: JSON.stringify({ display_name: '見本 143', phone: '090-0000-5678' }),
    }, env);
    const customerId = ((await customerRes.json()) as { customer: { id: string } }).customer.id;
    await reserveIdempotencyResponse(db, {
      key: 'proxy-try-pending',
      lineAccountId: 'account-a',
      friendId: `booking-customer:${customerId}`,
      body: { error: 'request_in_progress', booking_id: 'booking-missing' },
      ttlMinutes: 5,
      now: new Date(),
    });
    const retry = await app.request('/api/booking/admin/bookings?account_id=account-a', {
      method: 'POST',
      headers: { ...JSON_HEADERS, 'Idempotency-Key': 'proxy-try-pending' },
      body: JSON.stringify({ booking_customer_id: customerId, ...BOOKING_BODY }),
    }, env);
    // 予約行が無い＝まだ処理中のため、成功として返さない。
    expect(retry.status).toBe(409);
  });
});
