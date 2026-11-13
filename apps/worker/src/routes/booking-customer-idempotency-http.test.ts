/**
 * 電話客の保存は応答再送で二重作成しない。
 *
 * 実 Worker + 実 D1（better-sqlite3 に bootstrap.sql を流したもの）で検証する。
 * Miniflare はこの環境で listen できないため、 と同じ better-sqlite3 方式を使う。
 *
 * - 同じ Idempotency-Key での顧客POST再送は作り直さず、作成済み顧客を返す
 *   （応答消失後の再操作で台帳が2件にならない）。
 * - キーが無ければ従来どおり毎回作成する（後方互換）。
 * - キーが違えば別顧客として作成する。
 * - キーの使い回しはアカウントを越えない（別アカウントは別物）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { Env } from '../worker-env.js';

const ENCRYPTION_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

const access = vi.hoisted(() => ({
  canAccessAllLineAccounts: vi.fn(async (_db: unknown, _staff: unknown, ids: string[]) => (
    ids.every((id) => id === 'account-a' || id === 'account-b')
  )),
}));
vi.mock('../services/account-access.js', () => access);

// 再残差: 顧客INSERTの成功後に完了書き込みだけを1回落とす仕掛け。
// 修復UPDATE・救出SELECTの故障も再現できる。
let failCompletionOnce = false;
let failRepairUpdate = false;
let failRescueRead = false;
let completionFailed = false;

function asD1(sqlite: Database.Database): D1Database {
  const wrap = (sql: string, params: unknown[]) => ({
    first: async <T>() => {
      if (failRescueRead && completionFailed && /FROM booking_customers WHERE id/.test(sql)) {
        failRescueRead = false;
        throw new Error('isolated rescue read failed');
      }
      return (sqlite.prepare(sql).get(...params) as T | undefined) ?? null;
    },
    all: async <T>() => ({ success: true, results: sqlite.prepare(sql).all(...params) as T[], meta: {} }),
    run: async <T>() => {
      if (failCompletionOnce && /UPDATE booking_idempotency_keys/.test(sql)) {
        failCompletionOnce = false;
        completionFailed = true;
        throw new Error('isolated completion write failure');
      }
      if (failRepairUpdate && completionFailed && /UPDATE booking_idempotency_keys/.test(sql)) {
        throw new Error('isolated repair update failed');
      }
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

interface StaffStub {
  id: string;
  role: 'owner' | 'admin' | 'staff';
}

function makeApp(
  db: D1Database,
  route: Hono<Env>,
  stub: StaffStub = { id: 'owner-1', role: 'owner' },
) {
  const app = new Hono<Env>();
  app.use('*', async (c, next) => {
    c.set('staff', {
      id: stub.id,
      name: stub.role,
      role: stub.role,
      readOnly: false,
      permissionKeys: [],
      viewPermissionKeys: [],
    });
    return next();
  });
  app.route('/', route);
  const env = { DB: db, LINE_CREDENTIAL_ENCRYPTION_KEY: ENCRYPTION_KEY } as unknown as Env['Bindings'];
  return { app, env };
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const CUSTOMER_BODY = { display_name: '見本 143', phone: '090-0000-5678', pet_name: 'ポチ' };

let sqlite: Database.Database;
let db: D1Database;
let bookingRoute: Hono<Env>;

beforeEach(async () => {
  failCompletionOnce = false;
  failRepairUpdate = false;
  failRescueRead = false;
  completionFailed = false;
  sqlite = new Database(':memory:');
  sqlite.exec(readFileSync(join(import.meta.dirname, '..', '..', '..', '..', 'packages', 'db', 'bootstrap.sql'), 'utf8'));
  sqlite.pragma('foreign_keys = OFF');
  for (const id of ['account-a', 'account-b']) {
    sqlite.prepare(`INSERT INTO line_accounts
      (id,channel_id,name,channel_access_token,channel_secret)
      VALUES (?,?,?, 'token','secret')`).run(id, `channel-${id}`, id);
  }
  db = asD1(sqlite);
  ({ default: bookingRoute } = await import('./booking.js'));
  access.canAccessAllLineAccounts.mockClear();
});

function customerCount(accountId: string): number {
  const row = sqlite.prepare(
    `SELECT COUNT(*) AS n FROM booking_customers WHERE line_account_id = ?`,
  ).get(accountId) as { n: number };
  return row.n;
}

async function postCustomer(
  app: Hono<Env>,
  env: Env['Bindings'],
  accountId: string,
  key: string | null,
  body: unknown = CUSTOMER_BODY,
) {
  const headers = key
    ? { ...JSON_HEADERS, 'Idempotency-Key': key }
    : { ...JSON_HEADERS };
  return app.request(`/api/booking/admin/customers?account_id=${accountId}`, {
    method: 'POST', headers, body: JSON.stringify(body),
  }, env);
}

describe('R559 電話客の保存の応答再送は作り直さない', () => {
  test('同じキーでの再送は同じ顧客を返し、台帳は1件', async () => {
    const { app, env } = makeApp(db, bookingRoute);
    const first = await postCustomer(app, env, 'account-a', 'customer-try-1');
    expect(first.status).toBe(201);
    const firstBody = await first.json() as { customer: { id: string } };

    // 応答消失後の再送。保存は済んでいるので作り直さない。
    const second = await postCustomer(app, env, 'account-a', 'customer-try-1');
    expect(second.status).toBe(201);
    const secondBody = await second.json() as { customer: { id: string } };
    expect(secondBody.customer.id).toBe(firstBody.customer.id);
    expect(customerCount('account-a')).toBe(1);
  });

  test('キーが無ければ従来どおり毎回作成する', async () => {
    const { app, env } = makeApp(db, bookingRoute);
    for (let i = 0; i < 2; i += 1) {
      const res = await postCustomer(app, env, 'account-a', null);
      expect(res.status).toBe(201);
    }
    expect(customerCount('account-a')).toBe(2);
  });

  test('キーが違えば別顧客として作成する', async () => {
    const { app, env } = makeApp(db, bookingRoute);
    const ids = new Set<string>();
    for (const key of ['customer-try-a', 'customer-try-b']) {
      const res = await postCustomer(app, env, 'account-a', key);
      expect(res.status).toBe(201);
      ids.add(((await res.json()) as { customer: { id: string } }).customer.id);
    }
    expect(ids.size).toBe(2);
    expect(customerCount('account-a')).toBe(2);
  });

  test('R559残差: 同じキーでの同時到着は1件だけ作り、もう一方は409', async () => {
    const { app, env } = makeApp(db, bookingRoute);
    const [first, second] = await Promise.all([
      postCustomer(app, env, 'account-a', 'customer-race-1'),
      postCustomer(app, env, 'account-a', 'customer-race-1'),
    ]);
    // どちらか一方が通り、もう一方は進行中ではじく。台帳は1件のまま。
    expect([first.status, second.status].sort()).toEqual([201, 409]);
    expect(customerCount('account-a')).toBe(1);
    // 仮応答が残らないので、後の再送は作成済みを返す。
    const retry = await postCustomer(app, env, 'account-a', 'customer-race-1');
    expect(retry.status).toBe(201);
    expect(customerCount('account-a')).toBe(1);
  });

  test('R559再残差: INSERT成功後の完了書き込み失敗でも再送は作り直さない', async () => {
    const { app, env } = makeApp(db, bookingRoute);
    failCompletionOnce = true;
    // 初回は503だが顧客は1件作られている。
    const first = await postCustomer(app, env, 'account-a', 'customer-rescue-1');
    expect(first.status).toBe(503);
    expect(customerCount('account-a')).toBe(1);
    // 同キー再送は修復済みの初回顧客へ届き、2件目を作らない。
    const retry = await postCustomer(app, env, 'account-a', 'customer-rescue-1');
    expect(retry.status).toBe(201);
    const retryBody = await retry.json() as { customer: { id: string } };
    expect(customerCount('account-a')).toBe(1);
    const again = await postCustomer(app, env, 'account-a', 'customer-rescue-1');
    expect(again.status).toBe(201);
    const againBody = await again.json() as { customer: { id: string } };
    expect(againBody.customer.id).toBe(retryBody.customer.id);
    expect(customerCount('account-a')).toBe(1);
  });

  test('R559再残差: 修復UPDATE失敗時は202を保持し再送は409で作り直さない', async () => {
    const { app, env } = makeApp(db, bookingRoute);
    failCompletionOnce = true;
    failRepairUpdate = true;
    const first = await postCustomer(app, env, 'account-a', 'customer-repair-fail');
    expect(first.status).toBe(503);
    expect(customerCount('account-a')).toBe(1);
    const reserve = sqlite.prepare(
      `SELECT response_status FROM booking_idempotency_keys`,
    ).get() as { response_status: number };
    expect(reserve.response_status).toBe(202);
    failRepairUpdate = false;
    const retry = await postCustomer(app, env, 'account-a', 'customer-repair-fail');
    expect(retry.status).toBe(409);
    expect(customerCount('account-a')).toBe(1);
  });

  test('R559再残差: 救出読み直しの失敗は不在とみなさず202を保持する', async () => {
    const { app, env } = makeApp(db, bookingRoute);
    failCompletionOnce = true;
    failRescueRead = true;
    const first = await postCustomer(app, env, 'account-a', 'customer-rescue-read-fail');
    expect(first.status).toBe(503);
    expect(customerCount('account-a')).toBe(1);
    const reserve = sqlite.prepare(
      `SELECT response_status FROM booking_idempotency_keys`,
    ).get() as { response_status: number } | undefined;
    expect(reserve?.response_status).toBe(202);
    const retry = await postCustomer(app, env, 'account-a', 'customer-rescue-read-fail');
    expect(retry.status).toBe(409);
    expect(customerCount('account-a')).toBe(1);
  });

  test('同じキーでも別アカウントは別顧客として作成する', async () => {
    const { app, env } = makeApp(db, bookingRoute);
    const first = await postCustomer(app, env, 'account-a', 'customer-shared-key');
    expect(first.status).toBe(201);
    const second = await postCustomer(app, env, 'account-b', 'customer-shared-key');
    expect(second.status).toBe(201);
    const firstId = ((await first.json()) as { customer: { id: string } }).customer.id;
    const secondId = ((await second.json()) as { customer: { id: string } }).customer.id;
    expect(secondId).not.toBe(firstId);
    expect(customerCount('account-a')).toBe(1);
    expect(customerCount('account-b')).toBe(1);
  });
});
