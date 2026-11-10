/**
 * 予約の追加機能の LIFF 向けの口（前回と同じ・自分のキャンセル待ち）。
 *
 * 実 Worker + 実 D1（better-sqlite3 に bootstrap.sql を流したもの）で検証する。
 * 本人認証は idToken 検証の fetch stub（sub 固定）で行い、staff 無しの
 * 公開経路から叩く。
 *
 * - 前回の予約（取り消し・却下・期限切れを除く最新）のメニューと担当を返す。
 * - 前回の担当が辞めた・メニューが止まっているときは返さない。
 * - 履歴が無ければ available=false。他人の履歴は見えない。
 * - 枠を指定して自分の待ち登録があれば返し、無ければ null。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { beforeEach, afterEach, describe, expect, test, vi } from 'vitest';
import type { Env } from '../worker-env.js';

vi.mock('../services/account-access.js', () => ({
  canAccessAllLineAccounts: vi.fn(async () => true),
}));

const { default: booking } = await import('./booking.js');

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

let sqlite: Database.Database;
let db: D1Database;
let selfApp: Hono<Env>;
let env: Env['Bindings'];
const execCtx = {
  waitUntil: (promise: Promise<unknown>) => { promise.catch(() => {}); },
  passThroughOnException: () => undefined,
} as unknown as ExecutionContext;

// Keep the waitlist slot in the future so the registration tests do not expire.
const SLOT = (() => {
  const date = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  date.setUTCHours(5, 0, 0, 0);
  return date.toISOString();
})();
const SLOT_END = new Date(Date.parse(SLOT) + 60 * 60 * 1000).toISOString();

function seed() {
  sqlite.exec(`
    INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret, liff_id)
    VALUES ('account-a', 'channel-a', 'A店', 'token', 'secret', 'liff-a-1');
    INSERT INTO menus (id, line_account_id, name, duration_minutes, base_price, is_active)
    VALUES ('menu-a', 'account-a', 'カット', 60, 5000, 1);
    INSERT INTO staff (id, line_account_id, name, display_name, profile_image_url, is_active)
    VALUES ('staff-a', 'account-a', '太郎', '太郎', 'https://example.com/taro.jpg', 1);
    INSERT INTO staff_menus (staff_id, menu_id, is_offered)
    VALUES ('staff-a', 'menu-a', 1);
    INSERT INTO friends (id, line_user_id, line_account_id, display_name, is_following)
    VALUES ('friend-a', 'U-a', 'account-a', '花子', 1),
           ('friend-b', 'U-b', 'account-a', '次郎', 1);
  `);
}

function seedBooking(id: string, friendId: string, status: string, startsAt = SLOT) {
  sqlite.prepare(`INSERT INTO bookings
    (id, line_account_id, friend_id, staff_id, menu_id, starts_at, ends_at, block_ends_at,
     status, price_at_booking, requested_at)
    VALUES (?, 'account-a', ?, 'staff-a', 'menu-a', ?, ?, ?, ?, 5000, '2026-10-01T00:00:00.000Z')`)
    .run(id, friendId, startsAt, startsAt, startsAt, status);
}

function selfGet(path: string, token = 'token-a') {
  const separator = path.includes('?') ? '&' : '?';
  return selfApp.request(
    `${path}${separator}liffId=liff-a-1`,
    { headers: { Authorization: `Bearer ${token}` } },
    env,
    execCtx,
  );
}

function selfPost(path: string, body: unknown, token = 'token-a') {
  return selfApp.request(
    `${path}?liffId=liff-a-1`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    },
    env,
    execCtx,
  );
}

beforeEach(() => {
  sqlite = new Database(':memory:');
  sqlite.exec(readFileSync(join(import.meta.dirname, '..', '..', '..', '..', 'packages', 'db', 'bootstrap.sql'), 'utf8'));
  sqlite.pragma('foreign_keys = OFF');
  seed();
  db = asD1(sqlite);
  selfApp = new Hono<Env>();
  selfApp.route('/', booking);
  env = { DB: db } as Env['Bindings'];
  // idToken 検証は sub を U-a で返す。本人=花子（friend-a）になる。
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('api.line.me/oauth2/v2.1/verify')) {
      return new Response(JSON.stringify({ sub: 'U-a' }), { status: 200 });
    }
    throw new Error(`想定外の外部呼び出し: ${url}`);
  }));
});

afterEach(() => {
  sqlite.close();
  vi.unstubAllGlobals();
});

describe('LIFF 前回と同じで予約', () => {
  test('最新の予約のメニュー・担当・写真・前回日を返す', async () => {
    seedBooking('booking-old', 'friend-a', 'completed', '2026-09-01T05:00:00.000Z');
    seedBooking('booking-new', 'friend-a', 'confirmed', SLOT);

    const res = await selfGet('/api/liff/booking/last-booking');
    expect(res.status).toBe(200);
    const body = await res.json() as {
      available: boolean;
      booking: {
        id: string; starts_at: string;
        menu: { id: string; name: string };
        staff: { id: string; display_name: string; profile_image_url: string | null };
      };
    };
    expect(body.available).toBe(true);
    expect(body.booking.id).toBe('booking-new');
    expect(body.booking.menu).toMatchObject({ id: 'menu-a', name: 'カット' });
    expect(body.booking.staff).toMatchObject({
      id: 'staff-a', display_name: '太郎', profile_image_url: 'https://example.com/taro.jpg',
    });
    expect(body.booking.starts_at).toBe(SLOT);
  });

  test('履歴が無ければ available=false', async () => {
    const res = await selfGet('/api/liff/booking/last-booking');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ available: false, reason: 'no_history' });
  });

  test('取り消しだけの履歴は数えない', async () => {
    seedBooking('booking-cancelled', 'friend-a', 'cancelled');
    const res = await selfGet('/api/liff/booking/last-booking');
    expect(await res.json()).toMatchObject({ available: false, reason: 'no_history' });
  });

  test('他人の履歴は見えない', async () => {
    seedBooking('booking-other', 'friend-b', 'confirmed');
    const res = await selfGet('/api/liff/booking/last-booking');
    expect(await res.json()).toMatchObject({ available: false, reason: 'no_history' });
  });

  test('担当が辞めたら返さない', async () => {
    seedBooking('booking-1', 'friend-a', 'confirmed');
    sqlite.prepare(`UPDATE staff SET is_active = 0 WHERE id = 'staff-a'`).run();
    const res = await selfGet('/api/liff/booking/last-booking');
    expect(await res.json()).toMatchObject({ available: false, reason: 'staff_inactive' });
  });
});

describe('LIFF 自分のキャンセル待ち', () => {
  // キャンセル待ちは「埋まっている枠」だけ受け付ける。営業時間・担当の出勤を置き、別の人の予約で枠を埋める。
  function fillSlot() {
    sqlite.exec(`INSERT INTO booking_settings(id,line_account_id,business_hours_configured,cutoff_minutes_before,booking_window_days) VALUES('settings-a','account-a',1,0,365);`);
    for (let i = 0; i < 7; i++) {
      sqlite.prepare(`INSERT INTO booking_business_hours(id,booking_settings_id,weekday,start_time,end_time,capacity) VALUES(?,'settings-a',?,'00:00','23:59',10)`).run('h' + i, i);
      sqlite.prepare(`INSERT INTO staff_availability_rules(id,staff_id,weekday,start_time,end_time) VALUES(?,'staff-a',?,'00:00','23:59')`).run('staff-h' + i, i);
    }
    sqlite.prepare(`INSERT INTO bookings
      (id, line_account_id, friend_id, staff_id, menu_id, starts_at, ends_at, block_ends_at,
       status, price_at_booking, requested_at)
      VALUES ('full', 'account-a', 'friend-b', 'staff-a', 'menu-a', ?, ?, ?, 'confirmed', 0, ?)`)
      .run(SLOT, SLOT_END, SLOT_END, SLOT);
  }

  test('空いている枠には登録できない', async () => {
    const res = await selfPost('/api/liff/booking/waitlist', {
      staff_id: 'staff-a', menu_id: 'menu-a', starts_at: SLOT,
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'slot_not_full' });
  });

  test('登録・自分の枠の照会・取り消し', async () => {
    fillSlot();
    const registered = await selfPost('/api/liff/booking/waitlist', {
      staff_id: 'staff-a', menu_id: 'menu-a', starts_at: SLOT,
    });
    expect(registered.status, await registered.clone().text()).toBe(201);
    const { id } = await registered.json() as { id: string };

    const mine = await selfGet(
      `/api/liff/booking/waitlist/mine?staff_id=staff-a&menu_id=menu-a&starts_at=${encodeURIComponent(SLOT)}`,
    );
    expect(mine.status).toBe(200);
    const mineBody = await mine.json() as { entry: { id: string; status: string } | null };
    expect(mineBody.entry).toMatchObject({ id, status: 'waiting' });

    const cancelled = await selfApp.request(
      `/api/liff/booking/waitlist/${id}?liffId=liff-a-1`,
      { method: 'DELETE', headers: { Authorization: 'Bearer token-a' } },
      env,
      execCtx,
    );
    expect(cancelled.status).toBe(200);

    const gone = await selfGet(
      `/api/liff/booking/waitlist/mine?staff_id=staff-a&menu_id=menu-a&starts_at=${encodeURIComponent(SLOT)}`,
    );
    expect(await gone.json()).toMatchObject({ entry: null });
  });

  test('登録が無ければ null', async () => {
    const res = await selfGet(
      `/api/liff/booking/waitlist/mine?staff_id=staff-a&menu_id=menu-a&starts_at=${encodeURIComponent(SLOT)}`,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ entry: null });
  });
});
