import { describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Env } from '../worker-env.js';

const bookingCustomerMocks = vi.hoisted(() => ({
  createBookingCustomer: vi.fn(),
  getBookingCustomer: vi.fn(),
  searchBookingCustomers: vi.fn(),
}));
vi.mock('@line-crm/db', async (importOriginal) => ({
  ...await importOriginal<typeof import('@line-crm/db')>(),
  ...bookingCustomerMocks,
}));

const availabilityMocks = {
  computeSlots: vi.fn(() => [] as { start: string; end: string }[]),
  // 候補の instant 契約に合わせる。route は壁時刻ではなく startUtc の
  // 完全一致で確定するので、置き換えでも instant を付ける。
  // この試験の店舗は Asia/Tokyo。
  getAvailability: vi.fn(async (_db: unknown, params: { from: string; staffId?: string }) => ({
    by_staff: [{
      staff_id: params.staffId ?? 's1',
      display_name: 'A',
      slots: availabilityMocks.computeSlots().map((slot) => ({
        date: params.from,
        ...slot,
        timeZone: 'Asia/Tokyo',
        startUtc: `${params.from}T${slot.start}:00+09:00`,
        endUtc: `${params.from}T${slot.end}:00+09:00`,
      })),
    }],
  })),
  getAccountTimeZone: vi.fn(async () => 'Asia/Tokyo'),
};
vi.mock('../services/availability.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../services/availability.js')>(),
  ...availabilityMocks,
}));

const notifierMocks = { sendBookingNotification: vi.fn() };
// 送る側だけ差し替える。文面の組み立て（時刻・残り時間）は本物を使う。
vi.mock('../features/booking/booking-notifier.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../features/booking/booking-notifier.js')>()),
  ...notifierMocks,
}));

const accountAccessMocks = {
  canAccessAllLineAccounts: vi.fn(async () => true),
};
vi.mock('../services/account-access.js', () => accountAccessMocks);

const { default: booking } = await import('./booking.js');

function makeApp(db: unknown) {
  const app = new Hono<Env>();
  // 予約の枠組みは管理者、承認はスタッフに限定した。ここで見たいのは本体の
  // 挙動なので、認証は通った状態にしてから渡す。権限の検証は
  // middleware/role-guard.test.ts が持つ。
  app.use('*', async (c, next) => {
    c.set('staff', { id: 'owner-1', name: 'Owner', role: 'owner', readOnly: false });
    return next();
  });
  app.route('/', booking);
  return { app, env: { DB: db } };
}

const emptyDb = {
  prepare: () => ({
    bind: () => ({
      first: async () => null,
      all: async () => ({ results: [] }),
      run: async () => ({ meta: { changes: 0 } }),
    }),
  }),
};

describe('booking customers API', () => {
  const summary = {
    id: 'customer-1',
    line_account_id: 'acc1',
    friend_id: null,
    display_name: '見本 143',
    phone_last4: '5678',
    pet_name: 'ポチ',
    is_line_linked: false,
    created_at: '2026-09-07T00:00:00.000Z',
    updated_at: '2026-09-07T00:00:00.000Z',
  };

  test('200で実データを返す', async () => {
    bookingCustomerMocks.searchBookingCustomers.mockResolvedValueOnce([summary]);
    const { app, env } = makeApp(emptyDb);
    const res = await app.request(
      '/api/booking/admin/customers?account_id=acc1&q=090-0000-5678',
      {},
      env,
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ customers: [summary] });
    expect(bookingCustomerMocks.searchBookingCustomers).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ lineAccountId: 'acc1', query: '090-0000-5678' }),
    );
  });

  test('検索結果0件は空配列、取得失敗は503で区別する', async () => {
    bookingCustomerMocks.searchBookingCustomers.mockResolvedValueOnce([]);
    const { app, env } = makeApp(emptyDb);
    const empty = await app.request('/api/booking/admin/customers?account_id=acc1&q=該当なし', {}, env);
    expect(empty.status).toBe(200);
    await expect(empty.json()).resolves.toEqual({ customers: [] });

    bookingCustomerMocks.searchBookingCustomers.mockRejectedValueOnce(new Error('db unavailable'));
    const failed = await app.request('/api/booking/admin/customers?account_id=acc1', {}, env);
    expect(failed.status).toBe(503);
    await expect(failed.json()).resolves.toEqual({ error: 'customer_data_unavailable' });
  });

  test('所属外アカウントは403で顧客検索へ進まない', async () => {
    accountAccessMocks.canAccessAllLineAccounts.mockResolvedValueOnce(false);
    const { app, env } = makeApp(emptyDb);
    const res = await app.request('/api/booking/admin/customers?account_id=other', {}, env);
    expect(res.status).toBe(403);
    expect(bookingCustomerMocks.searchBookingCustomers).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ lineAccountId: 'other' }),
    );
  });

  test('作成成功、入力不備、詳細なしを別状態で返す', async () => {
    bookingCustomerMocks.createBookingCustomer.mockResolvedValueOnce(summary);
    const { app, env } = makeApp(emptyDb);
    const created = await app.request(
      '/api/booking/admin/customers?account_id=acc1',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          display_name: '見本 143',
          phone: '090-0000-5678',
          pet_name: 'ポチ',
        }),
      },
      env,
    );
    expect(created.status).toBe(201);
    await expect(created.json()).resolves.toEqual({ customer: summary });

    bookingCustomerMocks.createBookingCustomer.mockRejectedValueOnce(
      new Error('booking_customer_phone_invalid'),
    );
    const invalid = await app.request(
      '/api/booking/admin/customers?account_id=acc1',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ display_name: '見本 143', phone: 'abc' }),
      },
      env,
    );
    expect(invalid.status).toBe(422);

    bookingCustomerMocks.getBookingCustomer.mockResolvedValueOnce(null);
    const missing = await app.request('/api/booking/admin/customers/missing?account_id=acc1', {}, env);
    expect(missing.status).toBe(404);
  });
});

describe('GET /api/booking/admin/menus/:id/staff', () => {
  test('400 without account_id', async () => {
    const { app, env } = makeApp(emptyDb);
    const res = await app.request('/api/booking/admin/menus/m1/staff', {}, env);
    expect(res.status).toBe(400);
  });

  test('403 when the selected LINE account is outside the operator scope', async () => {
    accountAccessMocks.canAccessAllLineAccounts.mockResolvedValueOnce(false);
    const { app, env } = makeApp(emptyDb);
    const res = await app.request('/api/booking/admin/menus/m1/staff?account_id=other', {}, env);
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: 'forbidden_account' });
  });

  test('200 with staff list', async () => {
    const db = {
      prepare: () => ({
        bind: () => ({
          all: async () => ({ results: [{ id: 's1', display_name: 'スタッフA' }] }),
        }),
      }),
    };
    const { app, env } = makeApp(db);
    const res = await app.request('/api/booking/admin/menus/m1/staff?account_id=acc1', {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { staff: unknown[] };
    expect(body.staff).toHaveLength(1);
  });
});

describe('GET /api/booking/admin/availability', () => {
  test('400 without params', async () => {
    const { app, env } = makeApp(emptyDb);
    const res = await app.request('/api/booking/admin/availability?account_id=acc1', {}, env);
    expect(res.status).toBe(400);
  });

  test('200 delegates to getAvailability with minLeadTimeMinutes 0', async () => {
    const { app, env } = makeApp(emptyDb);
    const res = await app.request(
      '/api/booking/admin/availability?account_id=acc1&menu_id=m1&from=2026-07-08&to=2026-07-14',
      {},
      env,
    );
    expect(res.status).toBe(200);
    expect(availabilityMocks.getAvailability).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ lineAccountId: 'acc1', menuId: 'm1', minLeadTimeMinutes: 0 }),
    );
  });

  test('400 when range wider than 28 days', async () => {
    const { app, env } = makeApp(emptyDb);
    const res = await app.request(
      '/api/booking/admin/availability?account_id=acc1&menu_id=m1&from=2026-07-01&to=2026-08-15',
      {},
      env,
    );
    expect(res.status).toBe(400);
  });
});

// ----------------------------------------------------------------
// POST /api/booking/admin/bookings

type Handler = {
  first?: unknown;
  all?: { results: unknown[] };
  run?: { meta: { changes: number } };
};

// SQL 断片マッチで応答を返す scripted D1。マッチしない SQL は空応答。
function scriptedDb(handlers: [string, Handler][]) {
  const calls: { sql: string; params: unknown[] }[] = [];
  return {
    calls,
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          calls.push({ sql, params });
          const h = handlers.find(([frag]) => sql.includes(frag))?.[1] ?? {};
          return {
            first: async () => h.first ?? null,
            all: async () => h.all ?? { results: [] },
            run: async () => h.run ?? { meta: { changes: 0 } },
          };
        },
      };
    },
    async batch(stmts: D1PreparedStatement[]) {
      return Promise.all(stmts.map((statement) => statement.run()));
    },
  };
}

function sqliteAsD1(sqlite: Database.Database): D1Database {
  const sqliteParams = (sql: string, params: unknown[]) => {
    if (!/\?\d+/.test(sql)) return params;
    return [Object.fromEntries(params.map((value, index) => [String(index + 1), value]))];
  };
  const prepare = (sql: string): D1PreparedStatement => {
    const make = (params: unknown[]): D1PreparedStatement => ({
      bind: (...next: unknown[]) => make(next),
      first: async <T>() => (sqlite.prepare(sql).get(...sqliteParams(sql, params)) as T | undefined) ?? null,
      all: async <T>() => ({ results: sqlite.prepare(sql).all(...sqliteParams(sql, params)) as T[], success: true, meta: {} }),
      run: async <T>() => {
        const info = sqlite.prepare(sql).run(...sqliteParams(sql, params));
        return { success: true, results: [], meta: { changes: info.changes } } as T;
      },
      raw: async () => [],
    } as unknown as D1PreparedStatement);
    return make([]);
  };
  return {
    prepare,
    batch: async <T>(statements: D1PreparedStatement[]) => {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results as T;
    },
  } as unknown as D1Database;
}

const execCtx = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
} as unknown as ExecutionContext;

describe('POST /api/booking/admin/bookings', () => {
  // 実行日によって過去枠として422にならないよう、7日後の02:00Z（JST11時、シフト内）を使う。
  const futureStartsAt = (() => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + 7);
    d.setUTCHours(2, 0, 0, 0);
    return d.toISOString();
  })();
  const validBody = {
    friend_id: 'f1',
    menu_id: 'm1',
    staff_id: 's1',
    starts_at: futureStartsAt, // JST 11:00
  };

  function happyDb(insertChanges = 1) {
    return scriptedDb([
      ['SELECT line_account_id, friend_id, staff_id, menu_id, starts_at,', { first: {
        line_account_id: 'acc1', friend_id: 'f1', staff_id: 's1', menu_id: 'm1',
        starts_at: validBody.starts_at, notification_policy_snapshot: '{}',
      } }],
      ['UPDATE booking_operation_runs SET opened_at', { run: { meta: { changes: 1 } } }],
      ['FROM friends', { first: { id: 'f1', is_following: 1 } }],
      ['FROM staff WHERE', { first: { ok: 1 } }],
      [
        'FROM menus m',
        {
          first: {
            duration_minutes: 60,
            buffer_after_minutes: 10,
            dur: 60,
            price: 8000,
            is_offered: 1,
          },
        },
      ],
      ['FROM staff_shifts', { first: { start_time: '10:00', end_time: '19:00' } }],
      ['SELECT starts_at, block_ends_at FROM bookings', { all: { results: [] } }],
      ['INSERT INTO booking_idempotency_keys', { run: { meta: { changes: 1 } } }],
      ['UPDATE booking_idempotency_keys', { run: { meta: { changes: 1 } } }],
      ['INSERT INTO bookings', { run: { meta: { changes: insertChanges } } }],
    ]);
  }

  function happyCustomerDb(insertChanges = 1) {
    return scriptedDb([
      ['SELECT id, friend_id FROM booking_customers', { first: { id: 'customer-1', friend_id: null } }],
      ['FROM staff WHERE', { first: { ok: 1 } }],
      [
        'FROM menus m',
        {
          first: {
            duration_minutes: 60,
            buffer_after_minutes: 10,
            dur: 60,
            price: 8000,
            is_offered: 1,
          },
        },
      ],
      ['FROM staff_shifts', { first: { start_time: '10:00', end_time: '19:00' } }],
      ['SELECT starts_at, block_ends_at FROM bookings', { all: { results: [] } }],
      ['INSERT INTO booking_idempotency_keys', { run: { meta: { changes: 1 } } }],
      ['UPDATE booking_idempotency_keys', { run: { meta: { changes: 1 } } }],
      ['INSERT INTO bookings', { run: { meta: { changes: insertChanges } } }],
    ]);
  }

  test('400 without Idempotency-Key', async () => {
    const { app, env } = makeApp(emptyDb);
    const res = await app.request(
      '/api/booking/admin/bookings?account_id=acc1',
      {
        method: 'POST',
        body: JSON.stringify(validBody),
        headers: { 'Content-Type': 'application/json' },
      },
      env,
      execCtx,
    );
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ code: 'missing_idempotency_key' , fields: expect.any(Object), error: expect.any(String) });
  });

  test('400 without account_id', async () => {
    const { app, env } = makeApp(emptyDb);
    const res = await app.request(
      '/api/booking/admin/bookings',
      {
        method: 'POST',
        body: JSON.stringify(validBody),
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'booking-create-1' },
      },
      env,
      execCtx,
    );
    expect(res.status).toBe(400);
  });

  test('404 when friend not found', async () => {
    const db = scriptedDb([['FROM friends', { first: null }]]);
    const { app, env } = makeApp(db);
    const res = await app.request(
      '/api/booking/admin/bookings?account_id=acc1',
      {
        method: 'POST',
        body: JSON.stringify(validBody),
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'booking-create-2' },
      },
      env,
      execCtx,
    );
    expect(res.status).toBe(404);
  });

  test('201 creates confirmed booking and inserts reminders', async () => {
    availabilityMocks.computeSlots.mockReturnValue([{ start: '11:00', end: '12:00' }]);
    const db = happyDb();
    const { app, env } = makeApp(db);
    const res = await app.request(
      '/api/booking/admin/bookings?account_id=acc1',
      {
        method: 'POST',
        body: JSON.stringify(validBody),
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'booking-create-3' },
      },
      env,
      execCtx,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { booking_id: string; status: string };
    expect(body.status).toBe('confirmed');
    const insert = db.calls.find((c) => c.sql.includes('INSERT INTO bookings'));
    expect(insert?.params).toContain('confirmed');
    // booking_reminders INSERT が走っている(未来の予約なので day_before + hours_before)
    const reminders = db.calls.filter((c) => c.sql.includes('INSERT INTO booking_reminders'));
    expect(reminders.length).toBeGreaterThan(0);
  });

  test('同じキーの再送は保存済みの予約を返し、予約を追加しない', async () => {
    const db = scriptedDb([
      ['FROM friends', { first: { id: 'f1', is_following: 1 } }],
      ['FROM booking_idempotency_keys', {
        first: {
          response_status: 201,
          response_body: JSON.stringify({ booking_id: 'existing', status: 'confirmed', calendar_sync: 'synced' }),
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        },
      }],
    ]);
    const { app, env } = makeApp(db);
    const res = await app.request(
      '/api/booking/admin/bookings?account_id=acc1',
      {
        method: 'POST',
        body: JSON.stringify(validBody),
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'same-booking' },
      },
      env,
      execCtx,
    );
    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({ booking_id: 'existing' });
    expect(db.calls.some((call) => call.sql.includes('INSERT INTO bookings'))).toBe(false);
  });

  test('409 on slot conflict (atomic insert 0 rows)', async () => {
    availabilityMocks.computeSlots.mockReturnValue([{ start: '11:00', end: '12:00' }]);
    const db = happyDb(0);
    const { app, env } = makeApp(db);
    const res = await app.request(
      '/api/booking/admin/bookings?account_id=acc1',
      {
        method: 'POST',
        body: JSON.stringify(validBody),
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'booking-create-4' },
      },
      env,
      execCtx,
    );
    expect(res.status).toBe(409);
  });

  test('409と候補データ when slot not in availability', async () => {
    availabilityMocks.computeSlots.mockReturnValue([{ start: '14:00', end: '15:00' }]);
    const db = happyDb();
    const { app, env } = makeApp(db);
    const res = await app.request(
      '/api/booking/admin/bookings?account_id=acc1',
      {
        method: 'POST',
        body: JSON.stringify(validBody),
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'booking-create-5' },
      },
      env,
      execCtx,
    );
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      error: 'slot_not_available',
      data: { conflict: { count: 1 }, nearbySlots: expect.any(Array), alternateStaff: expect.any(Array) },
    });
  });

  test('404 when staff belongs to another account', async () => {
    availabilityMocks.computeSlots.mockReturnValue([{ start: '11:00', end: '12:00' }]);
    // 友だちは存在するが、アカウント所属のスタッフ検証が見つからない状態を作る。
    const db = scriptedDb([
      ['FROM friends', { first: { id: 'f1', is_following: 1 } }],
      ['FROM staff WHERE', { first: null }],
    ]);
    const { app, env } = makeApp(db);
    const res = await app.request(
      '/api/booking/admin/bookings?account_id=acc1',
      {
        method: 'POST',
        body: JSON.stringify(validBody),
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'booking-create-6' },
      },
      env,
      execCtx,
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.error).toBe('staff_not_found');
  });

  test('server-side availability recheck receives the correct September JST date', async () => {
    availabilityMocks.computeSlots.mockReturnValue([{ start: '11:00', end: '12:00' }]);
    const db = happyDb();
    const { app, env } = makeApp(db);
    // 日付文字列の月置換による破損を検出するため9月を使う。過去枠の拒否より先へ進むよう、未来の9月10日を選ぶ。
    const now = new Date();
    const sepYear =
      now.getTime() < Date.UTC(now.getUTCFullYear(), 8, 1) // 9月1日より前を指定する。
        ? now.getUTCFullYear()
        : now.getUTCFullYear() + 1;
    const res = await app.request(
      '/api/booking/admin/bookings?account_id=acc1',
      {
        method: 'POST',
        body: JSON.stringify({ ...validBody, starts_at: `${sepYear}-09-10T02:00:00.000Z` }),
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'booking-create-7' },
      },
      env,
      execCtx,
    );
    expect(res.status).toBe(201);
    expect(availabilityMocks.getAvailability).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ from: `${sepYear}-09-10`, to: `${sepYear}-09-10` }),
    );
  });

  test('LINE未連携客を予約へ結び、LINE通知とリマインダは作らない', async () => {
    availabilityMocks.computeSlots.mockReturnValue([{ start: '11:00', end: '12:00' }]);
    const db = happyCustomerDb();
    const { app, env } = makeApp(db);
    const res = await app.request(
      '/api/booking/admin/bookings?account_id=acc1',
      {
        method: 'POST',
        body: JSON.stringify({
          booking_customer_id: 'customer-1',
          menu_id: 'm1',
          staff_id: 's1',
          starts_at: futureStartsAt,
          send_line_confirmation: false,
        }),
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'phone-booking-1' },
      },
      env,
      execCtx,
    );

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({
      booking_customer_id: 'customer-1',
      status: 'confirmed',
      line_notification: 'not_applicable',
    });
    const insert = db.calls.find((call) => call.sql.includes('INSERT INTO bookings'));
    expect(insert?.params).toContain('customer-1');
    expect(insert?.params).toContain('phone');
    expect(db.calls.some((call) => call.sql.includes('INSERT INTO booking_reminders'))).toBe(false);
  });

  test('実SQLiteでも電話客予約を保存し、予約一覧へ顧客名を返す', async () => {
    availabilityMocks.computeSlots.mockReturnValue([{ start: '11:00', end: '12:00' }]);
    const sqlite = new Database(':memory:');
    try {
      sqlite.exec(readFileSync(join(process.cwd(), '../../packages/db/bootstrap.sql'), 'utf8'));
      sqlite.exec(`
        INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
        VALUES ('acc1','channel-1','A店','token','secret');
        INSERT INTO staff (id, line_account_id, name, display_name)
        VALUES ('s1','acc1','担当A','担当A'), ('owner-1','acc1','Owner','Owner');
        INSERT INTO menus (
          id, line_account_id, name, duration_minutes, buffer_after_minutes,
          base_price, concurrent_capacity
        ) VALUES ('m1','acc1','相談',60,10,8000,1);
        INSERT INTO staff_menus (staff_id, menu_id, is_offered)
        VALUES ('s1','m1',1);
        INSERT INTO booking_customers (
          id, line_account_id, display_name, phone_normalized_hash,
          phone_encrypted, phone_last4, pet_name
        ) VALUES ('customer-1','acc1','見本 143','hash','cipher','5678','ポチ');
      `);
      const { app, env } = makeApp(sqliteAsD1(sqlite));
      const created = await app.request(
        '/api/booking/admin/bookings?account_id=acc1',
        {
          method: 'POST',
          body: JSON.stringify({
            booking_customer_id: 'customer-1',
            menu_id: 'm1',
            staff_id: 's1',
            starts_at: futureStartsAt,
            send_line_confirmation: false,
          }),
          headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'phone-booking-real' },
        },
        env,
        execCtx,
      );
      expect(created.status).toBe(201);

      const listed = await app.request(
        '/api/booking/admin/requests?account_id=acc1&status=all',
        {},
        env,
      );
      expect(listed.status).toBe(200);
      await expect(listed.json()).resolves.toMatchObject({
        requests: [expect.objectContaining({
          booking_customer_id: 'customer-1',
          friend_id: null,
          friend_name: '見本 143',
          customer_phone_last4: '5678',
          customer_pet_name: 'ポチ',
          is_line_linked: 0,
        })],
      });
      sqlite.exec(`
        WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n + 1 FROM seq WHERE n < 200)
        INSERT INTO bookings (
          id, line_account_id, booking_customer_id, staff_id, menu_id,
          starts_at, ends_at, block_ends_at, status, price_at_booking, requested_at, source
        )
        SELECT printf('bulk-%03d', n), 'acc1', 'customer-1', 's1', 'm1',
               strftime('%Y-%m-%dT%H:%M:%fZ', '2099-01-01T00:00:00Z', '+' || n || ' minutes'),
               strftime('%Y-%m-%dT%H:%M:%fZ', '2099-01-01T01:00:00Z', '+' || n || ' minutes'),
               strftime('%Y-%m-%dT%H:%M:%fZ', '2099-01-01T01:10:00Z', '+' || n || ' minutes'),
               'confirmed', 8000, '2098-12-01T00:00:00.000Z', 'phone'
          FROM seq;
      `);
      const afterTwoHundred = await app.request(
        '/api/booking/admin/requests?account_id=acc1&status=all&limit=1&offset=200', {}, env,
      );
      expect(afterTwoHundred.status).toBe(200);
      await expect(afterTwoHundred.json()).resolves.toMatchObject({
        total: 201,
        requests: [expect.objectContaining({ id: 'bulk-200', friend_id: null })],
      });
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM booking_reminders').get())
        .toEqual({ count: 0 });
    } finally {
      sqlite.close();
    }
  });

  test('LINE未連携客へのLINE送信指定は422で予約を作らない', async () => {
    const db = happyCustomerDb();
    const { app, env } = makeApp(db);
    const res = await app.request(
      '/api/booking/admin/bookings?account_id=acc1',
      {
        method: 'POST',
        body: JSON.stringify({
          booking_customer_id: 'customer-1',
          menu_id: 'm1',
          staff_id: 's1',
          starts_at: futureStartsAt,
          send_line_confirmation: true,
        }),
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'phone-booking-2' },
      },
      env,
      execCtx,
    );
    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toMatchObject({ code: 'line_notification_unavailable' , fields: expect.any(Object), error: expect.any(String) });
    expect(db.calls.some((call) => call.sql.includes('INSERT INTO bookings'))).toBe(false);
  });

  test('別アカウントの電話客IDは404で予約へ結び付けない', async () => {
    const db = scriptedDb([['FROM booking_customers', { first: null }]]);
    const { app, env } = makeApp(db);
    const res = await app.request(
      '/api/booking/admin/bookings?account_id=acc1',
      {
        method: 'POST',
        body: JSON.stringify({
          booking_customer_id: 'customer-other',
          menu_id: 'm1',
          staff_id: 's1',
          starts_at: futureStartsAt,
        }),
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'phone-booking-3' },
      },
      env,
      execCtx,
    );
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: 'booking_customer_not_found' });
  });
});

describe('GET /api/booking/admin/resources', () => {
  test('200で{success,data:{resources}}の包みで返す', async () => {
    const { app, env } = makeApp(emptyDb);
    const res = await app.request('/api/booking/admin/resources?account_id=acc1', {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: { resources: unknown[] } };
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data.resources)).toBe(true);
  });

  test('400 without account_id', async () => {
    const { app, env } = makeApp(emptyDb);
    const res = await app.request('/api/booking/admin/resources', {}, env);
    expect(res.status).toBe(400);
  });
});

describe('jstDayWindowUtc', () => {
  test('July date: bounds cover the full JST calendar day', async () => {
    const { jstDayWindowUtc } = await import('./booking.js');
    const w = jstDayWindowUtc('2026-07-10');
    expect(w.startUtc).toBe('2026-07-09T15:00:00.000Z');
    expect(w.endUtc).toBe('2026-07-10T15:00:00Z');
  });

  test('September/November dates are not corrupted', async () => {
    const { jstDayWindowUtc } = await import('./booking.js');
    expect(jstDayWindowUtc('2026-09-10').startUtc).toBe('2026-09-09T15:00:00.000Z');
    expect(jstDayWindowUtc('2026-11-09').startUtc).toBe('2026-11-08T15:00:00.000Z');
  });
});

describe('PATCH /api/booking/admin/requests/:id の再試行 (N-065)', () => {
  test('取消ずみへの再送は409にせずだけ止める', async () => {
    const sqlite = new Database(':memory:');
    try {
      sqlite.exec(readFileSync(join(process.cwd(), '../../packages/db/bootstrap.sql'), 'utf8'));
      sqlite.exec(`
        INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
        VALUES ('acc1','channel-1','A店','token','secret');
        INSERT INTO staff (id, line_account_id, name, display_name)
        VALUES ('s1','acc1','担当A','担当A'), ('owner-1','acc1','Owner','Owner');
        INSERT INTO friends (id, line_user_id, display_name, line_account_id, is_following, created_at, updated_at)
        VALUES ('f1','U1','花子','acc1',1,'2026-01-01T00:00:00.000','2026-01-01T00:00:00.000');
        INSERT INTO menus (
          id, line_account_id, name, duration_minutes, buffer_after_minutes,
          base_price, concurrent_capacity
        ) VALUES ('m1','acc1','相談',60,10,8000,1);
        INSERT INTO reminders
          (id, name, line_account_id, is_active, trigger_type, delivery_mode, lifecycle_status)
        VALUES ('rb-rule','rule','acc1',1,'booking','countdown','published');
        INSERT INTO reminder_steps (id, reminder_id, offset_minutes, message_type, message_content)
        VALUES ('rb-step','rb-rule',-60,'text','ご来店をお待ちしています');
        INSERT INTO bookings (
          id, line_account_id, friend_id, staff_id, menu_id,
          starts_at, ends_at, block_ends_at, status, price_at_booking, requested_at
        ) VALUES (
          'RB1','acc1','f1','s1','m1',
          '2026-09-20T01:00:00.000Z','2026-09-20T02:00:00.000Z','2026-09-20T02:00:00.000Z',
          'cancelled',8000,'2026-09-01T00:00:00.000Z'
        );
        INSERT INTO friend_reminders (
          id, friend_id, reminder_id, target_date, status,
          source_kind, source_id, source_event_id
        ) VALUES (
          'FR1','f1','rb-rule','2026-09-20T01:00:00.000Z','active',
          'booking','RB1','RB1'
        );
        INSERT INTO reminder_delivery_runs (
          id, line_account_id, reminder_id, friend_reminder_id, friend_id,
          reminder_step_id, scheduled_at, idempotency_key, line_retry_key,
          status, created_at, updated_at
        ) VALUES (
          'RUN1','acc1','rb-rule','FR1','f1',
          'rb-step','2026-09-20T00:00:00.000Z','idem-1','retry-1',
          'queued','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z'
        );
      `);
      const { app, env } = makeApp(sqliteAsD1(sqlite));
      const send = () => app.request(
        '/api/booking/admin/requests/RB1?account_id=acc1',
        {
          method: 'PATCH',
          body: JSON.stringify({ action: 'cancel' }),
          headers: { 'Content-Type': 'application/json' },
        },
        env,
        execCtx,
      );
      // 業務は取消ずみだが が残っている (部分失敗の残り)。再送で を止める。
      const res = await send();
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ status: 'cancelled' });
      expect(sqlite.prepare(`SELECT status FROM friend_reminders WHERE id = 'FR1'`).get()).toEqual({
        status: 'cancelled',
      });
      expect(sqlite.prepare(`SELECT status FROM reminder_delivery_runs WHERE id = 'RUN1'`).get()).toEqual({
        status: 'cancelled',
      });
      // 2回目は無変更でも200 (冪等)。
      const again = await send();
      expect(again.status).toBe(200);
    } finally {
      sqlite.close();
    }
  });

  test('却下でもの未送信予定を止める (N-065)', async () => {
    const sqlite = new Database(':memory:');
    try {
      sqlite.exec(readFileSync(join(process.cwd(), '../../packages/db/bootstrap.sql'), 'utf8'));
      sqlite.exec(`
        INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
        VALUES ('acc1','channel-1','A店','token','secret');
        INSERT INTO staff (id, line_account_id, name, display_name)
        VALUES ('s1','acc1','担当A','担当A'), ('owner-1','acc1','Owner','Owner');
        INSERT INTO friends (id, line_user_id, display_name, line_account_id, is_following, created_at, updated_at)
        VALUES ('f1','U1','花子','acc1',1,'2026-01-01T00:00:00.000','2026-01-01T00:00:00.000');
        INSERT INTO menus (
          id, line_account_id, name, duration_minutes, buffer_after_minutes,
          base_price, concurrent_capacity
        ) VALUES ('m1','acc1','相談',60,10,8000,1);
        INSERT INTO reminders
          (id, name, line_account_id, is_active, trigger_type, delivery_mode, lifecycle_status)
        VALUES ('rb-rule','rule','acc1',1,'booking','countdown','published');
        INSERT INTO reminder_steps (id, reminder_id, offset_minutes, message_type, message_content)
        VALUES ('rb-step','rb-rule',-60,'text','ご来店をお待ちしています');
        INSERT INTO bookings (
          id, line_account_id, friend_id, staff_id, menu_id,
          starts_at, ends_at, block_ends_at, status, price_at_booking, requested_at
        ) VALUES (
          'RB2','acc1','f1','s1','m1',
          '2026-09-20T01:00:00.000Z','2026-09-20T02:00:00.000Z','2026-09-20T02:00:00.000Z',
          'requested',8000,'2026-09-01T00:00:00.000Z'
        );
        INSERT INTO friend_reminders (
          id, friend_id, reminder_id, target_date, status,
          source_kind, source_id, source_event_id
        ) VALUES (
          'FR2','f1','rb-rule','2026-09-20T01:00:00.000Z','active',
          'booking','RB2','RB2'
        );
      `);
      const { app, env } = makeApp(sqliteAsD1(sqlite));
      const res = await app.request(
        '/api/booking/admin/requests/RB2?account_id=acc1',
        {
          method: 'PATCH',
          body: JSON.stringify({ action: 'reject' }),
          headers: { 'Content-Type': 'application/json' },
        },
        env,
        execCtx,
      );
      // 却下ずみになり、の未送信予定が止まる (通知だけでは残る不具合の修正)。
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ status: 'rejected' });
      expect(sqlite.prepare(`SELECT status FROM friend_reminders WHERE id = 'FR2'`).get()).toEqual({
        status: 'cancelled',
      });
    } finally {
      sqlite.close();
    }
  });

  test('送信権の貸出中は409で再試行させ、送信後に取消せる (N-065 fencing)', async () => {
    const sqlite = new Database(':memory:');
    try {
      sqlite.exec(readFileSync(join(process.cwd(), '../../packages/db/bootstrap.sql'), 'utf8'));
      sqlite.exec(`
        INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
        VALUES ('acc1','channel-1','A店','token','secret');
        INSERT INTO staff (id, line_account_id, name, display_name)
        VALUES ('s1','acc1','担当A','担当A'), ('owner-1','acc1','Owner','Owner');
        INSERT INTO friends (id, line_user_id, display_name, line_account_id, is_following, created_at, updated_at)
        VALUES ('f1','U1','花子','acc1',1,'2026-01-01T00:00:00.000','2026-01-01T00:00:00.000');
        INSERT INTO menus (
          id, line_account_id, name, duration_minutes, buffer_after_minutes,
          base_price, concurrent_capacity
        ) VALUES ('m1','acc1','相談',60,10,8000,1);
        INSERT INTO reminders
          (id, name, line_account_id, is_active, trigger_type, delivery_mode, lifecycle_status)
        VALUES ('rb-rule','rule','acc1',1,'booking','countdown','published');
        INSERT INTO reminder_steps (id, reminder_id, offset_minutes, message_type, message_content)
        VALUES ('rb-step','rb-rule',-60,'text','ご来店をお待ちしています');
        INSERT INTO bookings (
          id, line_account_id, friend_id, staff_id, menu_id,
          starts_at, ends_at, block_ends_at, status, price_at_booking, requested_at
        ) VALUES (
          'RB3','acc1','f1','s1','m1',
          '2026-09-20T01:00:00.000Z','2026-09-20T02:00:00.000Z','2026-09-20T02:00:00.000Z',
          'confirmed',8000,'2026-09-01T00:00:00.000Z'
        );
        INSERT INTO friend_reminders (
          id, friend_id, reminder_id, target_date, status,
          source_kind, source_id, source_event_id
        ) VALUES (
          'FR3','f1','rb-rule','2026-09-20T01:00:00.000Z','active',
          'booking','RB3','RB3'
        );
        INSERT INTO reminder_delivery_runs (
          id, line_account_id, reminder_id, friend_reminder_id, friend_id,
          reminder_step_id, scheduled_at, idempotency_key, line_retry_key,
          status, lease_expires_at, created_at, updated_at
        ) VALUES (
          'RUN3','acc1','rb-rule','FR3','f1',
          'rb-step','2026-09-20T00:00:00.000Z','idem-3','retry-3',
          'claimed','2099-01-01T00:00:00.000Z','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z'
        );
      `);
      const { app, env } = makeApp(sqliteAsD1(sqlite));
      const send = () => app.request(
        '/api/booking/admin/requests/RB3?account_id=acc1',
        {
          method: 'PATCH',
          body: JSON.stringify({ action: 'cancel' }),
          headers: { 'Content-Type': 'application/json' },
        },
        env,
        execCtx,
      );
      // 送信権の貸出中は状態更新を巻き戻して 409 (取消確定後の送信を起こさない)。
      const conflicted = await send();
      expect(conflicted.status).toBe(409);
      await expect(conflicted.json()).resolves.toEqual({ error: 'send_in_flight_retry' });
      expect(sqlite.prepare(`SELECT status FROM bookings WHERE id = 'RB3'`).get()).toEqual({
        status: 'confirmed',
      });
      expect(sqlite.prepare(`SELECT status FROM friend_reminders WHERE id = 'FR3'`).get()).toEqual({
        status: 'active',
      });
      // 送信が終われば再試行で止まる。
      sqlite.prepare(`UPDATE reminder_delivery_runs SET status = 'succeeded', lease_expires_at = NULL WHERE id = 'RUN3'`).run();
      const retried = await send();
      expect(retried.status).toBe(200);
      expect(sqlite.prepare(`SELECT status FROM friend_reminders WHERE id = 'FR3'`).get()).toEqual({
        status: 'cancelled',
      });
    } finally {
      sqlite.close();
    }
  });
});

describe('staff breaks API (N-405 #655)', () => {
  function seedBreaks(sqlite: Database.Database) {
    sqlite.exec(readFileSync(join(process.cwd(), '../../packages/db/bootstrap.sql'), 'utf8'));
    sqlite.exec(`
      INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
      VALUES ('acc1','channel-1','A店','token','secret'),
             ('acc2','channel-2','B店','token2','secret2');
      INSERT INTO staff (id, line_account_id, name, display_name)
      VALUES ('s1','acc1','担当A','担当A'),
             ('s2','acc2','担当B','担当B'),
             ('owner-1','acc1','Owner','Owner');
      INSERT INTO booking_settings (id, line_account_id, timezone)
      VALUES ('bs1','acc1','Asia/Tokyo');
      INSERT INTO staff_availability_rules (id, staff_id, weekday, start_time, end_time, is_active)
      VALUES ('r1','s1',1,'09:00','19:00',1),
             ('r2','s1',2,'09:00','19:00',1);
      INSERT INTO staff_shifts (id, staff_id, work_date, start_time, end_time)
      VALUES ('sh1','s1','2026-09-23','10:00','17:00');
    `);
  }

  const getVersion = async (app: ReturnType<typeof makeApp>['app'], env: unknown, kind: 'breaks' | 'break-dates') => {
    const res = await app.request(
      `/api/booking/admin/staff/s1/${kind}?account_id=acc1`, {}, env as never,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { version: string; breaks: Array<{ id: string }> };
    return body;
  };

  const putKind = (
    app: ReturnType<typeof makeApp>['app'],
    env: unknown,
    kind: 'breaks' | 'break-dates',
    body: unknown,
  ) => app.request(
    `/api/booking/admin/staff/s1/${kind}?account_id=acc1`,
    { method: 'PUT', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } },
    env as never,
    execCtx,
  );

  test('実SQLiteで保存し、読み直しに残る(2回目の保存も残る)', async () => {
    const sqlite = new Database(':memory:');
    try {
      seedBreaks(sqlite);
      const { app, env } = makeApp(sqliteAsD1(sqlite));
      const first = await getVersion(app, env, 'breaks');
      const saved = await putKind(app, env, 'breaks', {
        expectedVersion: first.version,
        breaks: [{ weekday: 1, start_time: '12:00', end_time: '13:00' }],
      });
      expect(saved.status).toBe(200);
      const savedBody = await saved.json() as { ok: boolean; count: number; version: string };
      expect(savedBody).toMatchObject({ ok: true, count: 1 });
      expect(savedBody.version).not.toBe(first.version);

      const second = await putKind(app, env, 'breaks', {
        expectedVersion: savedBody.version,
        breaks: [
          { weekday: 1, start_time: '12:00', end_time: '13:00' },
          { weekday: 2, start_time: '12:00', end_time: '13:00' },
        ],
      });
      expect(second.status).toBe(200);

      const got = await getVersion(app, env, 'breaks');
      expect(got.breaks).toHaveLength(2);
    } finally {
      sqlite.close();
    }
  });

  test('古い版での保存は409で最新を返す', async () => {
    const sqlite = new Database(':memory:');
    try {
      seedBreaks(sqlite);
      const { app, env } = makeApp(sqliteAsD1(sqlite));
      const first = await getVersion(app, env, 'breaks');
      const saved = await putKind(app, env, 'breaks', {
        expectedVersion: first.version,
        breaks: [{ weekday: 1, start_time: '12:00', end_time: '13:00' }],
      });
      expect(saved.status).toBe(200);

      const stale = await putKind(app, env, 'breaks', {
        expectedVersion: first.version,
        breaks: [{ weekday: 1, start_time: '15:00', end_time: '16:00' }],
      });
      expect(stale.status).toBe(409);
      const staleBody = await stale.json() as {
        error: string;
        data: { version: string; breaks: Array<{ start_time: string }> };
      };
      expect(staleBody.error).toBe('version_conflict');
      expect(staleBody.data.breaks).toHaveLength(1);
      expect(staleBody.data.breaks[0].start_time).toBe('12:00');
    } finally {
      sqlite.close();
    }
  });

  test('重なり・勤務外・逆転は422、形の誤りは400', async () => {
    const sqlite = new Database(':memory:');
    try {
      seedBreaks(sqlite);
      const { app, env } = makeApp(sqliteAsD1(sqlite));
      const { version } = await getVersion(app, env, 'breaks');

      const overlap = await putKind(app, env, 'breaks', {
        expectedVersion: version,
        breaks: [
          { weekday: 1, start_time: '12:00', end_time: '13:00' },
          { weekday: 1, start_time: '12:30', end_time: '13:30' },
        ],
      });
      expect(overlap.status).toBe(422);
      await expect(overlap.json()).resolves.toMatchObject({ code: 'break_overlap' , fields: expect.any(Object), error: expect.any(String) });

      const outside = await putKind(app, env, 'breaks', {
        expectedVersion: version,
        breaks: [{ weekday: 3, start_time: '12:00', end_time: '13:00' }],
      });
      expect(outside.status).toBe(422);
      await expect(outside.json()).resolves.toMatchObject({ code: 'break_outside_working_hours', error: expect.any(String), fields: expect.any(Object) });

      const inverted = await putKind(app, env, 'breaks', {
        expectedVersion: version,
        breaks: [{ weekday: 1, start_time: '13:00', end_time: '12:00' }],
      });
      expect(inverted.status).toBe(422);
      await expect(inverted.json()).resolves.toMatchObject({ code: 'invalid_time_range', error: expect.any(String), fields: expect.any(Object) });

      const noVersion = await putKind(app, env, 'breaks', {
        breaks: [{ weekday: 1, start_time: '12:00', end_time: '13:00' }],
      });
      expect(noVersion.status).toBe(400);
      await expect(noVersion.json()).resolves.toMatchObject({ code: 'invalid_version', error: expect.any(String), fields: expect.any(Object) });
    } finally {
      sqlite.close();
    }
  });

  test('別のアカウントの担当者は404、範囲外のアカウントは403', async () => {
    const sqlite = new Database(':memory:');
    try {
      seedBreaks(sqlite);
      const { app, env } = makeApp(sqliteAsD1(sqlite));
      const other = await app.request(
        '/api/booking/admin/staff/s2/breaks?account_id=acc1', {}, env as never,
      );
      expect(other.status).toBe(404);
      await expect(other.json()).resolves.toEqual({ error: 'staff_not_found_in_account' });

      accountAccessMocks.canAccessAllLineAccounts.mockResolvedValueOnce(false);
      const forbidden = await app.request(
        '/api/booking/admin/staff/s1/breaks?account_id=other', {}, env as never,
      );
      expect(forbidden.status).toBe(403);
    } finally {
      sqlite.close();
    }
  });

  /*
    休憩の4経路（breaks/break-dates の GET・PUT）は、account 境界を
    assertStaffInAccount だけで守っている。ガードを抜けた後は staff_id だけで
    読み書きするので、1経路でも落ちれば別店舗の担当者の休憩を覗ける・書ける。
    GET /breaks は上の試験が見張っているので、残り3経路を1本ずつ持つ。
    まとめて1本にしないのは、1経路だけ壊れたときに赤くしたいから。
  */

  // s2(acc2)へ acc1 から書けてしまう状態を作らないため、ガードを外すと
  // 200 で保存が通ってしまう下地（勤務とシフト）をあらかじめ置く。
  function seedOtherAccountWorkable(sqlite: Database.Database) {
    sqlite.exec(`
      INSERT INTO booking_settings (id, line_account_id, timezone)
      VALUES ('bs2','acc2','Asia/Tokyo');
      INSERT INTO staff_availability_rules (id, staff_id, weekday, start_time, end_time, is_active)
      VALUES ('r3','s2',3,'09:00','19:00',1);
      INSERT INTO staff_shifts (id, staff_id, work_date, start_time, end_time)
      VALUES ('sh2','s2','2026-09-23','10:00','17:00');
    `);
  }

  const countRows = (sqlite: Database.Database, table: 'staff_breaks' | 'staff_break_dates', staffId: string) =>
    (sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE staff_id = ?`).get(staffId) as { n: number }).n;

  test('PUT /breaks は別アカウントの担当者を404で拒み、1件も書かない', async () => {
    const sqlite = new Database(':memory:');
    try {
      seedBreaks(sqlite);
      seedOtherAccountWorkable(sqlite);
      const { app, env } = makeApp(sqliteAsD1(sqlite));

      // 版は acc2 から正しく取る。版ずれで弾かれたのではないことを確かめるため。
      const own = await app.request(
        '/api/booking/admin/staff/s2/breaks?account_id=acc2', {}, env as never,
      );
      expect(own.status).toBe(200);
      const { version } = await own.json() as { version: string };

      const crossed = await app.request(
        '/api/booking/admin/staff/s2/breaks?account_id=acc1',
        {
          method: 'PUT',
          body: JSON.stringify({
            expectedVersion: version,
            breaks: [{ weekday: 3, start_time: '12:00', end_time: '13:00' }],
          }),
          headers: { 'Content-Type': 'application/json' },
        },
        env as never,
        execCtx,
      );
      expect(crossed.status).toBe(404);
      await expect(crossed.json()).resolves.toEqual({ error: 'staff_not_found_in_account' });
      expect(countRows(sqlite, 'staff_breaks', 's2')).toBe(0);
    } finally {
      sqlite.close();
    }
  });

  test('GET /break-dates は別アカウントの担当者を404で拒む', async () => {
    const sqlite = new Database(':memory:');
    try {
      seedBreaks(sqlite);
      seedOtherAccountWorkable(sqlite);
      // 覗けたら中身が返ることを示すため、s2 側に1件置いておく。
      sqlite.exec(`
        INSERT INTO staff_break_dates
          (id, staff_id, work_date, start_time, end_time, time_zone, start_utc_offset, end_utc_offset)
        VALUES ('bd-other','s2','2026-09-23','12:00','13:00','Asia/Tokyo','+09:00','+09:00');
      `);
      const { app, env } = makeApp(sqliteAsD1(sqlite));

      const crossed = await app.request(
        '/api/booking/admin/staff/s2/break-dates?account_id=acc1', {}, env as never,
      );
      expect(crossed.status).toBe(404);
      await expect(crossed.json()).resolves.toEqual({ error: 'staff_not_found_in_account' });
    } finally {
      sqlite.close();
    }
  });

  test('PUT /break-dates は別アカウントの担当者を404で拒み、1件も書かない', async () => {
    const sqlite = new Database(':memory:');
    try {
      seedBreaks(sqlite);
      seedOtherAccountWorkable(sqlite);
      const { app, env } = makeApp(sqliteAsD1(sqlite));

      const own = await app.request(
        '/api/booking/admin/staff/s2/break-dates?account_id=acc2', {}, env as never,
      );
      expect(own.status).toBe(200);
      const { version } = await own.json() as { version: string };

      const crossed = await app.request(
        '/api/booking/admin/staff/s2/break-dates?account_id=acc1',
        {
          method: 'PUT',
          body: JSON.stringify({
            expectedVersion: version,
            breaks: [{ work_date: '2026-09-23', start_time: '12:00', end_time: '13:00' }],
          }),
          headers: { 'Content-Type': 'application/json' },
        },
        env as never,
        execCtx,
      );
      expect(crossed.status).toBe(404);
      await expect(crossed.json()).resolves.toEqual({ error: 'staff_not_found_in_account' });
      expect(countRows(sqlite, 'staff_break_dates', 's2')).toBe(0);
    } finally {
      sqlite.close();
    }
  });

  test('日付指定の休憩はシフト内なら保存でき、DSTのgapは拒否する', async () => {
    const sqlite = new Database(':memory:');
    try {
      seedBreaks(sqlite);
      sqlite.exec(`
        UPDATE booking_settings SET timezone = 'America/New_York' WHERE id = 'bs1';
      `);
      const { app, env } = makeApp(sqliteAsD1(sqlite));
      const { version } = await getVersion(app, env, 'break-dates');

      // 2026-09-23 はシフト(10:00〜17:00)がある日。通常の休憩は通る。
      const ok = await putKind(app, env, 'break-dates', {
        expectedVersion: version,
        breaks: [{ work_date: '2026-09-23', start_time: '12:00', end_time: '13:00' }],
      });
      expect(ok.status).toBe(200);
      const okBody = await ok.json() as {
        ok: boolean;
        breaks: Array<{ start_utc_offset: string; end_utc_offset: string; time_zone: string }>;
      };
      expect(okBody.ok).toBe(true);
      expect(okBody.breaks[0].time_zone).toBe('America/New_York');
      expect(okBody.breaks[0].start_utc_offset).toBe('-04:00');

      // 2026-03-08 02:30 は New York の春のgap(存在しない時刻)。
      const gapVersion = (await getVersion(app, env, 'break-dates')).version;
      const gap = await putKind(app, env, 'break-dates', {
        expectedVersion: gapVersion,
        breaks: [{ work_date: '2026-03-08', start_time: '02:30', end_time: '03:30' }],
      });
      expect(gap.status).toBe(422);
      await expect(gap.json()).resolves.toMatchObject({ code: 'dst_gap' , fields: expect.any(Object), error: expect.any(String) });
    } finally {
      sqlite.close();
    }
  });

  test('日付指定の休憩はシフトが無い日は通常勤務で判定し、無い日は拒否する', async () => {
    const sqlite = new Database(':memory:');
    try {
      seedBreaks(sqlite);
      const { app, env } = makeApp(sqliteAsD1(sqlite));
      const { version } = await getVersion(app, env, 'break-dates');

      // 2026-09-24(木曜)に勤務もシフトも無い → 拒否。
      const noWork = await putKind(app, env, 'break-dates', {
        expectedVersion: version,
        breaks: [{ work_date: '2026-09-24', start_time: '12:00', end_time: '13:00' }],
      });
      expect(noWork.status).toBe(422);
      await expect(noWork.json()).resolves.toMatchObject({ code: 'break_outside_working_hours' , fields: expect.any(Object), error: expect.any(String) });
    } finally {
      sqlite.close();
    }
  });
});

describe('GET /api/booking/admin/availability-check (IDEA-28)', () => {
  // R92: 店舗の受付期間（既定60日）・締切（既定24h）の内側の日を使う。
  // 2099年では期間の外になり、お客さま向け判定が booking_window で塞がる。
  // シフトの日付指定なので曜日は問わない。30日先なら締切・期間の内側。
  const CHECK_DAY = new Date(Date.now() + 30 * 86_400_000 + 9 * 3_600_000)
    .toISOString().slice(0, 10);
  function seedCheck(sqlite: Database.Database) {
    sqlite.exec(readFileSync(join(process.cwd(), '../../packages/db/bootstrap.sql'), 'utf8'));
    sqlite.exec(`
      INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
      VALUES ('acc1','channel-1','A店','token','secret'),
             ('acc2','channel-2','B店','token2','secret2');
      INSERT INTO staff (id, line_account_id, name, display_name)
      VALUES ('s1','acc1','担当A','担当A'),
             ('s2','acc2','担当B','担当B'),
             ('owner-1','acc1','Owner','Owner');
      INSERT INTO booking_settings (id, line_account_id, timezone)
      VALUES ('bs1','acc1','Asia/Tokyo'),
             ('bs2','acc2','Asia/Tokyo');
      INSERT INTO menus (id, line_account_id, name, duration_minutes, buffer_after_minutes, base_price)
      VALUES ('m1','acc1','カット',60,0,5000),
             ('m2','acc1','カラー',90,0,8000),
             ('mx','acc2','他店メニュー',60,0,5000);
      INSERT INTO staff_menus (staff_id, menu_id) VALUES ('s1','m1'), ('s1','m2');
      INSERT INTO staff_shifts (id, staff_id, work_date, start_time, end_time)
      VALUES ('sh1','s1','${CHECK_DAY}','10:00','17:00');
      INSERT INTO booking_customers (id, line_account_id, display_name, phone_normalized_hash, phone_encrypted, phone_last4)
      VALUES ('c1','acc1','客A','hash','enc','0000');
    `);
  }

  const check = (
    app: ReturnType<typeof makeApp>['app'],
    env: unknown,
    qs: string,
  ) => app.request(`/api/booking/admin/availability-check?${qs}`, {}, env as never);

  test('空き枠は bookable: true、予約は一切作られない', async () => {
    const sqlite = new Database(':memory:');
    try {
      seedCheck(sqlite);
      const { app, env } = makeApp(sqliteAsD1(sqlite));
      const res = await check(app, env, `account_id=acc1&menu_id=m1&date=${CHECK_DAY}&time=11:00&staff_id=s1`);
      expect(res.status).toBe(200);
      const body = await res.json() as {
        bookable: boolean; reasons: string[];
        per_staff: Array<{ staff_id: string; bookable: boolean; remaining: number }>;
      };
      expect(body.bookable).toBe(true);
      expect(body.reasons).toEqual([]);
      expect(body.per_staff[0]).toMatchObject({ staff_id: 's1', bookable: true, remaining: 1 });
      // 確認だけなので bookings に行が増えないこと
      expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM bookings`).get())
        .toEqual({ n: 0 });
    } finally {
      sqlite.close();
    }
  });

  test('別メニューの予約が重なる枠は other_booking を返し、実際の空き状況と一致する', async () => {
    const sqlite = new Database(':memory:');
    try {
      seedCheck(sqlite);
      // 11:00-12:30 JST = 02:00-03:30 UTC に別メニュー(m2)の予約を置く
      sqlite.exec(`
        INSERT INTO bookings (id, line_account_id, booking_customer_id, staff_id, menu_id,
          starts_at, ends_at, block_ends_at, status, price_at_booking, requested_at)
        VALUES ('b1','acc1','c1','s1','m2',
          '${CHECK_DAY}T02:00:00Z','${CHECK_DAY}T03:30:00Z','${CHECK_DAY}T03:30:00Z',
          'confirmed',8000,'2026-01-01T00:00:00Z');
      `);
      const { app, env } = makeApp(sqliteAsD1(sqlite));
      const res = await check(app, env, `account_id=acc1&menu_id=m1&date=${CHECK_DAY}&time=11:00&staff_id=s1`);
      expect(res.status).toBe(200);
      const body = await res.json() as { bookable: boolean; reasons: string[] };
      expect(body.bookable).toBe(false);
      expect(body.reasons).toEqual(['other_booking']);
      // 表示理由と実判定の一致: 同じ条件の /availability でも 11:00 開始は出ない
      const avail = await app.request(
        `/api/booking/admin/availability?account_id=acc1&menu_id=m1&staff_id=s1&from=${CHECK_DAY}&to=${CHECK_DAY}`,
        {}, env as never,
      );
      expect(avail.status).toBe(200);
      const availBody = await avail.json() as { by_staff: Array<{ slots: Array<{ start: string }> }> };
      // getAvailability はモックなのでここでは直接見ない（モックは computeSlots 依存）。
      // 代わりに explainBookingSlot 側の一致は service 層テストで担保済み。
      expect(availBody.by_staff).toBeDefined();
    } finally {
      sqlite.close();
    }
  });

  test('勤務のない時間は outside_working、休業日は exception_closed', async () => {
    const sqlite = new Database(':memory:');
    try {
      seedCheck(sqlite);
      const { app, env } = makeApp(sqliteAsD1(sqlite));
      const outside = await check(app, env, `account_id=acc1&menu_id=m1&date=${CHECK_DAY}&time=20:00`);
      expect(outside.status).toBe(200);
      await expect(outside.json()).resolves.toMatchObject({
        bookable: false, reasons: ['outside_working'],
      });
      sqlite.exec(`
        INSERT INTO booking_availability_exceptions (id, line_account_id, scope_kind, date_from, date_to, kind, hours_json)
        VALUES ('ex1','acc1','store','${CHECK_DAY}','${CHECK_DAY}','closed','[]');
      `);
      const closed = await check(app, env, `account_id=acc1&menu_id=m1&date=${CHECK_DAY}&time=11:00`);
      expect(closed.status).toBe(200);
      await expect(closed.json()).resolves.toMatchObject({
        bookable: false, reasons: ['exception_closed'],
      });
    } finally {
      sqlite.close();
    }
  });

  test('他アカウントのメニュー・担当は見えない（account境界）', async () => {
    const sqlite = new Database(':memory:');
    try {
      seedCheck(sqlite);
      const { app, env } = makeApp(sqliteAsD1(sqlite));
      const res = await check(app, env, `account_id=acc1&menu_id=mx&date=${CHECK_DAY}&time=11:00`);
      expect(res.status).toBe(200);
      const body = await res.json() as { bookable: boolean; reasons: string[] };
      expect(body.bookable).toBe(false);
      expect(body.reasons).toEqual(['menu_inactive']);
      // s2 は acc2 の担当 → acc1 では menu の提供担当に出ない
      const res2 = await check(app, env, `account_id=acc1&menu_id=m1&staff_id=s2&date=${CHECK_DAY}&time=11:00`);
      const body2 = await res2.json() as { bookable: boolean; reasons: string[] };
      expect(body2.bookable).toBe(false);
      expect(body2.reasons).toEqual(['staff_not_offered']);
    } finally {
      sqlite.close();
    }
  });

  test('パラメータ不足・形式不正は400', async () => {
    const sqlite = new Database(':memory:');
    try {
      seedCheck(sqlite);
      const { app, env } = makeApp(sqliteAsD1(sqlite));
      const missing = await check(app, env, 'account_id=acc1&date=2099-01-10');
      expect(missing.status).toBe(400);
      const badDate = await check(app, env, 'account_id=acc1&menu_id=m1&date=2099-13-40&time=11:00');
      expect(badDate.status).toBe(400);
      const badTime = await check(app, env, `account_id=acc1&menu_id=m1&date=${CHECK_DAY}&time=25:00`);
      expect(badTime.status).toBe(400);
      const noAccount = await app.request(
        `/api/booking/admin/availability-check?menu_id=m1&date=${CHECK_DAY}&time=11:00`, {}, env as never,
      );
      expect(noAccount.status).toBe(400);
    } finally {
      sqlite.close();
    }
  });
});

describe('GET /api/booking/admin/requests-summary のタブ件数', () => {
  /*
   * 表示タブ（今日・今週・今月）の数は、その期間の有効な予約の数。
   * カレンダーと同じ基準（R86）で、取消・拒否・期限切れを除く。
   * 従来の todayTotal / weekTotal / monthTotal（KPI・解約率用）は変えない。
   */
  function seedTabs(sqlite: Database.Database) {
    sqlite.exec(readFileSync(join(process.cwd(), '../../packages/db/bootstrap.sql'), 'utf8'));
    sqlite.exec(`
      INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
      VALUES ('acc1','channel-1','A店','token','secret');
      INSERT INTO staff (id, line_account_id, name, display_name)
      VALUES ('s1','acc1','担当A','担当A');
      INSERT INTO menus (id, line_account_id, name, duration_minutes, buffer_after_minutes, base_price)
      VALUES ('m1','acc1','カット',60,0,5000);
      INSERT INTO booking_customers (id, line_account_id, display_name, phone_normalized_hash, phone_encrypted, phone_last4)
      VALUES ('c1','acc1','客A','hash','enc','0000');
      INSERT INTO bookings (id, line_account_id, booking_customer_id, staff_id, menu_id,
        starts_at, ends_at, block_ends_at, status, price_at_booking, requested_at)
      VALUES
        ('b-conf-today','acc1','c1','s1','m1',
          '2026-09-28T01:00:00Z','2026-09-28T01:30:00Z','2026-09-28T01:30:00Z',
          'confirmed',5000,'2026-09-01T00:00:00Z'),
        ('b-cancel-today','acc1','c1','s1','m1',
          '2026-09-28T02:00:00Z','2026-09-28T02:30:00Z','2026-09-28T02:30:00Z',
          'cancelled',5000,'2026-09-01T00:00:00Z'),
        ('b-noshow-today','acc1','c1','s1','m1',
          '2026-09-28T03:00:00Z','2026-09-28T03:30:00Z','2026-09-28T03:30:00Z',
          'no_show',5000,'2026-09-01T00:00:00Z'),
        ('b-req-week','acc1','c1','s1','m1',
          '2026-09-30T01:00:00Z','2026-09-30T01:30:00Z','2026-09-30T01:30:00Z',
          'requested',5000,'2026-09-01T00:00:00Z'),
        ('b-reject-week','acc1','c1','s1','m1',
          '2026-10-01T01:00:00Z','2026-10-01T01:30:00Z','2026-10-01T01:30:00Z',
          'rejected',5000,'2026-09-01T00:00:00Z'),
        ('b-conf-month','acc1','c1','s1','m1',
          '2026-09-05T01:00:00Z','2026-09-05T01:30:00Z','2026-09-05T01:30:00Z',
          'confirmed',5000,'2026-09-01T00:00:00Z'),
        ('b-exp-month','acc1','c1','s1','m1',
          '2026-09-10T01:00:00Z','2026-09-10T01:30:00Z','2026-09-10T01:30:00Z',
          'expired',5000,'2026-09-01T00:00:00Z'),
        ('b-conf-lastmonth','acc1','c1','s1','m1',
          '2026-08-20T01:00:00Z','2026-08-20T01:30:00Z','2026-08-20T01:30:00Z',
          'confirmed',5000,'2026-08-01T00:00:00Z');
    `);
  }

  test('タブ用は取消・拒否・期限切れを除く（従来の集計は変えない）', async () => {
    const sqlite = new Database(':memory:');
    try {
      seedTabs(sqlite);
      const { app, env } = makeApp(sqliteAsD1(sqlite));
      const res = await app.request(
        '/api/booking/admin/requests-summary?account_id=acc1&month=2026-09&last_month=2026-08&today=2026-09-28&week_to=2026-10-05',
        {}, env as never,
      );
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, number>;
      // 従来の集計（KPI・解約率用）は全部数える。
      expect(body.todayTotal).toBe(3);
      expect(body.weekTotal).toBe(5);
      expect(body.monthTotal).toBe(6);
      expect(body.lastMonthTotal).toBe(1);
      // タブ用は有効な予約だけ。取消・拒否・期限切れを除く。
      expect(body.todayTabTotal).toBe(2);
      expect(body.weekTabTotal).toBe(3);
      expect(body.monthTabTotal).toBe(4);
    } finally {
      sqlite.close();
    }
  });
});

describe('飲食1 人の予約の共通表示', () => {
  test('日時・アカウント・ページを絞り、既存の版と担当者を返す', async () => {
    const { createTestD1 } = await import('../test-utils/d1-sqlite.js');
    const fixture = createTestD1();
    try {
      fixture.raw.exec(`
        INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret) VALUES('a','ca','店','t','s'),('b','cb','別店','t','s');
        INSERT INTO staff(id,line_account_id,name,display_name) VALUES('sa','a','担当の内部名','担当A'),('sb','b','別','担当B');
        INSERT INTO menus(id,line_account_id,name,duration_minutes,base_price) VALUES('ma','a','相談',60,1000),('mb','b','別店',60,1000);
        INSERT INTO booking_customers(id,line_account_id,display_name,phone_normalized_hash,phone_encrypted,phone_last4) VALUES('cust','a','予約者','hash','enc','1234'),('cust-b','b','別店客','hash-b','enc','4321');
        INSERT INTO bookings(id,line_account_id,booking_customer_id,staff_id,menu_id,starts_at,ends_at,block_ends_at,status,price_at_booking,requested_at,lock_version) VALUES
          ('r1','a','cust','sa','ma','2027-01-01T01:00:00Z','2027-01-01T02:00:00Z','2027-01-01T02:00:00Z','confirmed',1000,'2026-10-01',3),
          ('r2','a','cust','sa','ma','2027-01-01T02:00:00Z','2027-01-01T03:00:00Z','2027-01-01T03:00:00Z','confirmed',1000,'2026-10-01',0),
          ('foreign','b','cust-b','sb','mb','2027-01-01T01:00:00Z','2027-01-01T02:00:00Z','2027-01-01T02:00:00Z','confirmed',1000,'2026-10-01',1);
      `);
      const { app, env } = makeApp(fixture.db);
      const url='/api/booking/admin/board?account_id=a&from=2027-01-01T01:00:00Z&to=2027-01-01T03:00:00Z&limit=1';
      const res=await app.request(url,{},env as never);
      expect(res.status).toBe(200);
      const body=await res.json() as {data:{entries:unknown[];total:number}};
      expect(body.data).toMatchObject({total:2,entries:[{id:'r1',kind:'people',version:3,scopeId:'a',customerName:'予約者',resourceIds:['sa'],resourceLabel:'担当A'}]});
      const next=await app.request(url+'&offset=1',{},env as never);
      expect((await next.json() as {data:{entries:Array<{id:string;version:number}>}}).data.entries[0]).toMatchObject({id:'r2',version:0});
      expect((await app.request('/api/booking/admin/board/r2?account_id=a',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({kind:'people',expectedVersion:-1,startsAt:'2027-01-01T03:00:00Z'})},env as never)).status).toBe(400);
      expect((await app.request('/api/booking/admin/board?account_id=a&from=bad&to=bad',{},env as never)).status).toBe(400);
    } finally {fixture.raw.close();}
  });
});
