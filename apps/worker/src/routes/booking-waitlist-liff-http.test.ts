/**
 * キャンセル待ちのお客さま側の口（M6 の LIFF 画面用）。
 *
 * - 自分の待ち一覧が返る（空き枠入りで開く・取り消しの確認に使う）。
 * - 招待ずみの待ちを取り消す（見送る）と、仮押さえが空いて次の人へすぐ回る。
 * - 本人確認は LIFF の id_token 検証（fetch を差し替える）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
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
  return { app, env };
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };
// Keep the waitlist slot in the future so the registration tests do not expire.
const SLOT = (() => {
  const date = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  date.setUTCHours(5, 0, 0, 0);
  return date.toISOString();
})();
const SLOT_END = new Date(Date.parse(SLOT) + 60 * 60 * 1000).toISOString();

let sqlite: Database.Database;
let db: D1Database;
let bookingRoute: Hono<Env>;

function selfHeaders() {
  return { ...JSON_HEADERS, Authorization: 'Bearer test-id-token' };
}

function selfUrl(path: string) {
  return `${path}?liffId=liff-a-1`;
}

beforeEach(async () => {
  sqlite = new Database(':memory:');
  sqlite.exec(readFileSync(join(import.meta.dirname, '..', '..', '..', '..', 'packages', 'db', 'bootstrap.sql'), 'utf8'));
  sqlite.pragma('foreign_keys = OFF');
  sqlite.prepare(`INSERT INTO line_accounts
    (id,channel_id,name,channel_access_token,channel_secret,liff_id,is_active)
    VALUES ('account-a','channel-a','A店','token','secret','liff-a-1',1)`).run();
  sqlite.prepare(`INSERT INTO friends (id, line_user_id, line_account_id, display_name, is_following)
    VALUES ('friend-a', 'U-a', 'account-a', '花子', 1),
           ('friend-b', 'U-b', 'account-a', '次郎', 1)`).run();
  sqlite.prepare(`INSERT INTO staff (id, line_account_id, name, display_name, is_active)
    VALUES ('staff-a', 'account-a', '太郎', '太郎', 1)`).run();
  sqlite.prepare(`INSERT INTO menus
    (id, line_account_id, name, duration_minutes, base_price, is_active)
    VALUES ('menu-a', 'account-a', 'カット', 60, 5000, 1)`).run();
  sqlite.exec(`INSERT INTO staff_menus(staff_id,menu_id,is_offered) VALUES('staff-a','menu-a',1);INSERT INTO booking_settings(id,line_account_id,business_hours_configured,cutoff_minutes_before,booking_window_days) VALUES('settings-a','account-a',1,0,365);`);
  for(let i=0;i<7;i++)sqlite.prepare(`INSERT INTO booking_business_hours(id,booking_settings_id,weekday,start_time,end_time,capacity) VALUES(?,'settings-a',?,'00:00','23:59',10)`).run('h'+i,i);
  sqlite.prepare(`INSERT INTO bookings(id,line_account_id,friend_id,staff_id,menu_id,starts_at,ends_at,block_ends_at,status,price_at_booking,requested_at) VALUES('full','account-a','friend-b','staff-a','menu-a',?,?,?,'confirmed',0,?)`).run(SLOT, SLOT_END, SLOT_END, SLOT);
  for(let i=0;i<7;i++)sqlite.prepare(`INSERT INTO staff_availability_rules(id,staff_id,weekday,start_time,end_time) VALUES(?,'staff-a',?,'00:00','23:59')`).run('staff-h'+i,i);
  db = asD1(sqlite);
  ({ default: bookingRoute } = await import('./booking.js'));
  access.canAccessAllLineAccounts.mockClear();
  cardSender.mockClear();
  vi.stubGlobal('fetch', async (url: unknown) => {
    if (String(url).includes('oauth2/v2.1/verify')) {
      return new Response(JSON.stringify({ sub: 'U-a' }), { status: 200 });
    }
    throw new Error(`想定外の外部呼び出し: ${String(url)}`);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('待ちのお客さま側の口', () => {
  test('登録・自分の待ち一覧・取り消し', async () => {
    const { app, env } = makeApp(db, bookingRoute);
    const registered = await app.request(selfUrl('/api/liff/booking/waitlist'), {
      method: 'POST',
      headers: selfHeaders(),
      body: JSON.stringify({ staff_id: 'staff-a', menu_id: 'menu-a', starts_at: SLOT }),
    }, env);
    expect(registered.status).toBe(201);
    const id = (await registered.json() as { id: string }).id;

    // 二重登録は409。
    const duplicate = await app.request(selfUrl('/api/liff/booking/waitlist'), {
      method: 'POST',
      headers: selfHeaders(),
      body: JSON.stringify({ staff_id: 'staff-a', menu_id: 'menu-a', starts_at: SLOT }),
    }, env);
    expect(duplicate.status).toBe(409);

    const listed = await app.request(selfUrl('/api/liff/booking/waitlist'), {
      headers: selfHeaders(),
    }, env);
    expect(listed.status).toBe(200);
    const body = await listed.json() as {
      waitlist: Array<{ id: string; status: string; menu_name: string; staff_name: string }>;
    };
    expect(body.waitlist).toHaveLength(1);
    expect(body.waitlist[0]).toMatchObject({ id, status: 'waiting', menu_name: 'カット' });

    const cancelled = await app.request(selfUrl(`/api/liff/booking/waitlist/${id}`), {
      method: 'DELETE', headers: selfHeaders(),
    }, env);
    expect(cancelled.status).toBe(200);
  });

  test('招待ずみの見送りで次の人へすぐ回る', async () => {
    const { app, env } = makeApp(db, bookingRoute);
    const first = await app.request(selfUrl('/api/liff/booking/waitlist'), {
      method: 'POST',
      headers: selfHeaders(),
      body: JSON.stringify({ staff_id: 'staff-a', menu_id: 'menu-a', starts_at: SLOT }),
    }, env);
    const firstId = (await first.json() as { id: string }).id;
    // 2番目は直接入れる（本人は U-a だけ）。
    sqlite.prepare(`INSERT INTO booking_waitlist
      (id, line_account_id, staff_id, menu_id, starts_at, friend_id, identity_key)
      VALUES ('wait-b', 'account-a', 'staff-a', 'menu-a', '${SLOT}', 'friend-b', 'friend:friend-b')`).run();
    // キャンセルで空いた枠を1番目へ案内。
    sqlite.exec("DELETE FROM bookings WHERE id='full'");
    sqlite.prepare(`UPDATE booking_waitlist SET status = 'invited',
      ends_at=?,block_ends_at=?,invited_at = '2026-10-04T00:00:00.000Z',
      hold_expires_at = '2099-01-01T00:00:00.000Z' WHERE id = ?`).run(SLOT_END, SLOT_END, firstId);

    const declined = await app.request(selfUrl(`/api/liff/booking/waitlist/${firstId}`), {
      method: 'DELETE', headers: selfHeaders(),
    }, env);
    expect(declined.status).toBe(200);
    // 次の人（friend-b）にカードが1通。
    expect(cardSender).toHaveBeenCalledTimes(1);
    expect(cardSender.mock.calls[0]?.[1]).toMatchObject({ to: 'U-b' });
    expect(sqlite.prepare(`SELECT status FROM booking_waitlist WHERE id = 'wait-b'`).get())
      .toMatchObject({ status: 'invited' });
  });
});
