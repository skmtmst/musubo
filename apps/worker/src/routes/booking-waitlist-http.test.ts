/**
 * booking-plus 2: キャンセル待ちの口。
 *
 * 実 Worker + 実 D1（better-sqlite3 に bootstrap.sql を流したもの）で検証する。
 * LINE 送信だけ差し替える（1人ずつ1通を数えるため）。
 *
 * - 管理画面から登録・一覧・取り消しができる。
 * - 1人が同じ枠に二重登録できない（409）。
 * - 管理画面の取り消しで空いたら、登録の早い順に1人だけ LINE が1通届く。
 * - 招待ずみの人が予約を取ったら「予約になった」へ進める。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { Env } from '../worker-env.js';

const access = vi.hoisted(() => ({
  canAccessAllLineAccounts: vi.fn(async (_db: unknown, _staff: unknown, ids: string[]) => (
    ids.every((id) => id === 'account-a')
  )),
}));
vi.mock('../services/account-access.js', () => access);

vi.mock('../features/booking/booking-notifier.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../features/booking/booking-notifier.js')>();
  return { ...actual, sendBookingNotification: vi.fn(async () => {}) };
});
vi.mock('../features/booking/booking-automatic-line.js',()=>({sendAutomaticBookingLine:vi.fn(async()=>true)}));
import { sendAutomaticBookingLine } from '../features/booking/booking-automatic-line.js';

const cardSender = vi.mocked(sendAutomaticBookingLine);

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
    c.set('staff', { id: 'owner-1', name: 'owner', role: 'owner', readOnly: false, permissionKeys: [], viewPermissionKeys: [] });
    return next();
  });
  app.route('/', route);
  const env = { DB: db, LIFF_URL: 'https://liff.line.me/test123' } as Env['Bindings'];
  // 取り消し口はカレンダー削除を waitUntil へ回す。試験ではその場で捨てる。
  const execCtx = {
    waitUntil: (promise: Promise<unknown>) => { promise.catch(() => {}); },
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext;
  const rawRequest = app.request.bind(app);
  app.request = ((input: Parameters<typeof rawRequest>[0], init?: Parameters<typeof rawRequest>[1]) =>
    rawRequest(input, init, env, execCtx)) as typeof app.request;
  return { app, env };
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };
// Keep the slot within the 365-day booking window as the test suite ages.
const slotDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
slotDate.setUTCHours(5, 0, 0, 0);
const SLOT = slotDate.toISOString();
const SLOT_END = new Date(slotDate.getTime() + 60 * 60 * 1000).toISOString();

let sqlite: Database.Database;
let db: D1Database;
let bookingRoute: Hono<Env>;

function seedSlot() {
  sqlite.prepare(`INSERT INTO staff (id, line_account_id, name, display_name, is_active)
    VALUES ('staff-a', 'account-a', '太郎', '太郎', 1)`).run();
  sqlite.prepare(`INSERT INTO menus
    (id, line_account_id, name, duration_minutes, base_price, is_active)
    VALUES ('menu-a', 'account-a', 'カット', 60, 5000, 1)`).run();
  sqlite.prepare(`INSERT INTO friends (id, line_user_id, line_account_id, display_name)
    VALUES ('friend-a', 'U-a', 'account-a', '花子'), ('friend-b', 'U-b', 'account-a', '次郎')`).run();
}

function registerWaitlist(
  app: Hono<Env, never, '/'>, env: Env['Bindings'], friendId: string,
) {
  return app.request('/api/booking/admin/waitlist?account_id=account-a', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ staff_id: 'staff-a', menu_id: 'menu-a', starts_at: SLOT, friend_id: friendId }),
  }, env);
}

beforeEach(async () => {
  sqlite = new Database(':memory:');
  sqlite.exec(readFileSync(join(import.meta.dirname, '..', '..', '..', '..', 'packages', 'db', 'bootstrap.sql'), 'utf8'));
  sqlite.pragma('foreign_keys = OFF');
  sqlite.prepare(`INSERT INTO line_accounts
    (id,channel_id,name,channel_access_token,channel_secret)
    VALUES ('account-a','channel-a','A店','token','secret')`).run();
  seedSlot();
  sqlite.exec(`INSERT INTO staff_menus(staff_id,menu_id,is_offered) VALUES('staff-a','menu-a',1);INSERT INTO booking_settings(id,line_account_id,business_hours_configured,cutoff_minutes_before,booking_window_days) VALUES('settings-a','account-a',1,0,365);`);
  for(let i=0;i<7;i++)sqlite.prepare(`INSERT INTO booking_business_hours(id,booking_settings_id,weekday,start_time,end_time,capacity) VALUES(?,'settings-a',?,'00:00','23:59',10)`).run('h'+i,i);
  for(let i=0;i<7;i++)sqlite.prepare(`INSERT INTO staff_availability_rules(id,staff_id,weekday,start_time,end_time) VALUES(?,'staff-a',?,'00:00','23:59')`).run('staff-h'+i,i);
  db = asD1(sqlite);
  ({ default: bookingRoute } = await import('./booking.js'));
  access.canAccessAllLineAccounts.mockClear();
  cardSender.mockClear();
});

describe('キャンセル待ちの口', () => {
  test('登録・二重登録は409・一覧・取り消し', async () => {
    const { app, env } = makeApp(db, bookingRoute);
    const first = await registerWaitlist(app, env, 'friend-a');
    expect(first.status).toBe(201);

    const duplicate = await registerWaitlist(app, env, 'friend-a');
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({ error: 'already_waiting' });

    const list = await app.request(
      `/api/booking/admin/waitlist?account_id=account-a&staff_id=staff-a&starts_at=${encodeURIComponent(SLOT)}`,
      {}, env);
    expect(list.status).toBe(200);
    const listed = await list.json() as { waitlist: Array<{ friend_id: string; status: string }> };
    expect(listed.waitlist).toHaveLength(1);
    expect(listed.waitlist[0]).toMatchObject({ friend_id: 'friend-a', status: 'waiting' });

    const id = (await first.json() as { waitlist: { id: string } }).waitlist.id;
    const cancelled = await app.request(`/api/booking/admin/waitlist/${id}?account_id=account-a`, {
      method: 'DELETE',
    }, env);
    expect(cancelled.status).toBe(200);

    // 取り消し後は同じ枠に並び直せる。
    const again = await registerWaitlist(app, env, 'friend-a');
    expect(again.status).toBe(201);
  });

  test('管理画面の取り消しで空いたら早い順に1人だけLINEが1通', async () => {
    const { app, env } = makeApp(db, bookingRoute);
    await registerWaitlist(app, env, 'friend-a');
    await registerWaitlist(app, env, 'friend-b');
    // 埋まっている予約（取り消すと空く）。
    sqlite.prepare(`INSERT INTO bookings
      (id, line_account_id, friend_id, staff_id, menu_id, starts_at, ends_at, block_ends_at,
       status, price_at_booking, requested_at)
      VALUES ('booking-full', 'account-a', 'friend-a', 'staff-a', 'menu-a',
        '${SLOT}', '${SLOT}', '${SLOT}', 'confirmed', 5000, '2026-10-01T00:00:00.000Z')`).run();

    const cancelled = await app.request('/api/booking/admin/requests/booking-full?account_id=account-a', {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ action: 'cancel' }),
    }, env);
    expect(cancelled.status).toBe(200);

    // 早い順の1人（friend-a）にだけカードが1通。
    expect(cardSender).toHaveBeenCalledTimes(1);
    const sent = cardSender.mock.calls[0]?.[1] as { to: string; text: string };
    expect(sent.to).toBe('U-a');
    const card = sent.text;
    expect(card).toContain('この時間で予約する');
    expect(card).toContain('今回は見送る');
    expect(card).toContain('waitlist=');
    expect(card).toContain('action=decline');
    const rows = sqlite.prepare(
      `SELECT friend_id, status, notified_at FROM booking_waitlist ORDER BY created_at`).all() as Array<{
      friend_id: string; status: string; notified_at: string | null;
    }>;
    expect(rows[0]).toMatchObject({ friend_id: 'friend-a', status: 'invited' });
    expect(rows[0]?.notified_at).not.toBeNull();
    expect(rows[1]).toMatchObject({ friend_id: 'friend-b', status: 'waiting' });
  });

  test('招待ずみの人が予約を取ったら converted', async () => {
    const { app, env } = makeApp(db, bookingRoute);
    const registered = await registerWaitlist(app, env, 'friend-a');
    const id = (await registered.json() as { waitlist: { id: string } }).waitlist.id;
    sqlite.prepare(`INSERT INTO bookings
      (id, line_account_id, friend_id, staff_id, menu_id, starts_at, ends_at, block_ends_at,
       status, price_at_booking, requested_at)
      VALUES ('booking-new', 'account-a', 'friend-a', 'staff-a', 'menu-a',
        '${SLOT}', '${SLOT}', '${SLOT}', 'confirmed', 5000, '2026-10-01T00:00:00.000Z')`).run();

    sqlite.prepare(`UPDATE booking_waitlist SET status='invited',ends_at='${SLOT_END}',block_ends_at='${SLOT_END}',hold_expires_at='2099-01-01T00:00:00Z' WHERE id=?`).run(id);
    const converted = await app.request(`/api/booking/admin/waitlist/${id}/convert?account_id=account-a`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ booking_id: 'booking-new' }),
    }, env);
    expect(converted.status).toBe(200);
    expect(sqlite.prepare(`SELECT status FROM booking_waitlist WHERE id = ?`).get(id))
      .toMatchObject({ status: 'converted' });

    // 違う枠の予約では進めない。
    const mismatch = await app.request(`/api/booking/admin/waitlist/${id}/convert?account_id=account-a`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ booking_id: 'booking-new' }),
    }, env);
    expect(mismatch.status).toBe(409);
  });
});
