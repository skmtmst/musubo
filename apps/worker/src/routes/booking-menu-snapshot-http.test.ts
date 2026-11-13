import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import Database from 'better-sqlite3';
import type { Env } from '../worker-env.js';

const access = vi.hoisted(() => ({
  canAccessAllLineAccounts: vi.fn(async (_db: unknown, _staff: unknown, ids: string[]) => (
    ids.every((id) => id === 'account-a')
  )),
}));
vi.mock('../services/account-access.js', () => access);

// 空きの再照合だけ本物そっくりに返す。T の写し・版の試験は空き計算の対象外。
const availability = vi.hoisted(() => {
  let startUtc = '';
  return {
    setStartUtc(value: string) { startUtc = value; },
    getStartUtc() { return startUtc; },
  };
});
vi.mock('../services/availability.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../services/availability.js')>();
  return {
    ...original,
    getAccountTimeZone: async () => 'Asia/Tokyo',
    getAvailability: async (_db: unknown, params: { staffId?: string; from: string }) => ({
      by_staff: [{
        staff_id: params.staffId ?? 's1',
        display_name: '担当A',
        slots: [{ startUtc: availability.getStartUtc() }],
      }],
    }),
  };
});

const { default: booking } = await import('./booking.js');

function sqliteAsD1(sqlite: Database.Database): D1Database {
  // `?1` 式の番号付きプレースホルダは名前付き扱いで渡す（booking-admin.test.ts と同じ形）。
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

let sqlite: Database.Database;
let d1: D1Database;

const execCtx = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
} as unknown as ExecutionContext;

function appFor(role: 'owner' | 'admin' | 'staff' = 'owner') {
  const app = new Hono<Env>();
  app.use('*', async (c, next) => {
    c.set('staff', { id: `${role}-1`, name: role, role, readOnly: false });
    return next();
  });
  app.route('/', booking);
  return { app, env: { DB: d1 } as Env['Bindings'] };
}

function menuBody(overrides: Record<string, unknown> = {}) {
  return {
    expectedVersion: 1,
    name: 'カット',
    duration_minutes: 60,
    base_price: 8000,
    price_mode: 'fixed',
    ...overrides,
  };
}

async function saveMenu(body: unknown, menuId = 'menu-a', role: 'owner' | 'admin' | 'staff' = 'owner') {
  const { app, env } = appFor(role);
  return app.request(`/api/booking/admin/menus/${menuId}?account_id=account-a`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }, env, execCtx);
}

async function getVersions(menuId = 'menu-a') {
  const { app, env } = appFor();
  const res = await app.request(`/api/booking/admin/menus/${menuId}/versions?account_id=account-a`, {}, env, execCtx);
  return { status: res.status, body: await res.json() as {
    versions: Array<{
      version_number: number; title: string; status: string;
      summary: string; author: string | null; at: string; lines: string[];
    }>;
  } };
}

async function revertVersion(menuId: string, version: number, expectedVersion: number, role: 'owner' | 'admin' | 'staff' = 'owner') {
  const { app, env } = appFor(role);
  return app.request(`/api/booking/admin/menus/${menuId}/versions/${version}/revert?account_id=account-a`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedVersion }),
  }, env, execCtx);
}

function futureStartsAt(): string {
  const date = new Date(Date.now() + 7 * 86400_000);
  date.setUTCHours(2, 0, 0, 0);
  return date.toISOString();
}

beforeEach(() => {
  sqlite = new Database(':memory:');
  sqlite.exec(readFileSync(join(process.cwd(), '../../packages/db/bootstrap.sql'), 'utf8'));
  sqlite.exec(`
    INSERT INTO line_accounts (id,channel_id,name,channel_access_token,channel_secret)
    VALUES ('account-a','channel-a','A店','token','secret'),
           ('account-b','channel-b','B店','token','secret');
    INSERT INTO staff (id, line_account_id, name, display_name)
    VALUES ('s1','account-a','担当A','担当A'), ('owner-1','account-a','Owner','Owner');
    INSERT INTO menus (id,line_account_id,name,duration_minutes,buffer_after_minutes,base_price)
    VALUES ('menu-a','account-a','施術A',60,0,1000),
           ('menu-b','account-b','施術B',60,0,1000);
    INSERT INTO staff_menus (staff_id, menu_id, is_offered) VALUES ('s1','menu-a',1);
    INSERT INTO menu_versions
      (id, menu_id, version_number, name, duration_minutes, buffer_after_minutes,
       base_price, price_mode, sort_order, is_active, rules_json)
    VALUES ('mv-a1','menu-a',1,'施術A',60,0,1000,'fixed',0,1,'{}'),
           ('mv-b1','menu-b',1,'施術B',60,0,1000,'fixed',0,1,'{}');
    INSERT INTO booking_customers
      (id, line_account_id, display_name, phone_normalized_hash, phone_encrypted, phone_last4)
    VALUES ('customer-1','account-a','見本 143','hash','cipher','5678');
  `);
  d1 = sqliteAsD1(sqlite);
  access.canAccessAllLineAccounts.mockClear();
  return () => { sqlite.close(); };
});

describe('予約メニューの版履歴 HTTP (T)', () => {
  test('作った時点で最初の版が残る', async () => {
    const { app, env } = appFor();
    const created = await app.request('/api/booking/admin/menus?account_id=account-a', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '新規メニュー', duration_minutes: 30, base_price: 5000 }),
    }, env, execCtx);
    expect(created.status).toBe(201);
    const { id } = await created.json() as { id: string };
    const listed = await getVersions(id);
    expect(listed.status).toBe(200);
    expect(listed.body.versions).toHaveLength(1);
    expect(listed.body.versions[0]).toMatchObject({
      version_number: 1, title: '第1版', status: 'in_use', summary: '最初の版',
    });
    expect(listed.body.versions[0].lines.join('\n')).toContain('値段：5,000円');
  });

  test('保存のたびに版が増え、前の版は変わらない', async () => {
    expect((await saveMenu(menuBody())).status).toBe(200);
    expect((await saveMenu(menuBody({ expectedVersion: 2, base_price: 9000, duration_minutes: 90 }))).status).toBe(200);
    const listed = await getVersions();
    expect(listed.status).toBe(200);
    expect(listed.body.versions.map((v) => [v.version_number, v.status])).toEqual([
      [3, 'in_use'], [2, 'past'], [1, 'past'],
    ]);
    // いちばん新しい版のひとことには値段と時間の変化が出る。
    expect(listed.body.versions[0].summary).toContain('値段');
    expect(listed.body.versions[0].summary).toContain('時間');
    expect(listed.body.versions[2].summary).toBe('最初の版');
    const v2 = sqlite.prepare(`SELECT base_price, duration_minutes FROM menu_versions
      WHERE menu_id = 'menu-a' AND version_number = 2`).get() as { base_price: number; duration_minutes: number };
    expect(v2).toMatchObject({ base_price: 8000, duration_minutes: 60 });
    const v1 = sqlite.prepare(`SELECT base_price, name FROM menu_versions
      WHERE menu_id = 'menu-a' AND version_number = 1`).get() as { base_price: number; name: string };
    expect(v1).toMatchObject({ base_price: 1000, name: '施術A' });
  });

  test('公開切替(PATCH)でも版が増える', async () => {
    const { app, env } = appFor();
    const patched = await app.request('/api/booking/admin/menus/menu-a?account_id=account-a', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedVersion: 1, is_active: false }),
    }, env, execCtx);
    expect(patched.status).toBe(200);
    const listed = await getVersions();
    expect(listed.body.versions.map((v) => v.version_number)).toEqual([2, 1]);
    expect(listed.body.versions[0].summary).toContain('休止');
  });

  test('この版に戻すと、その中身で新しい版ができる', async () => {
    expect((await saveMenu(menuBody())).status).toBe(200);
    const reverted = await revertVersion('menu-a', 1, 2);
    expect(reverted.status).toBe(200);
    await expect(reverted.json()).resolves.toMatchObject({ ok: true, version: 3 });
    const menu = sqlite.prepare(`SELECT name, base_price, version FROM menus WHERE id = 'menu-a'`).get() as {
      name: string; base_price: number; version: number;
    };
    expect(menu).toMatchObject({ name: '施術A', base_price: 1000, version: 3 });
    // 過去の版行は書き換わらない。
    const v2 = sqlite.prepare(`SELECT base_price FROM menu_versions
      WHERE menu_id = 'menu-a' AND version_number = 2`).get() as { base_price: number };
    expect(v2).toMatchObject({ base_price: 8000 });
    const listed = await getVersions();
    expect(listed.body.versions.map((v) => v.version_number)).toEqual([3, 2, 1]);
    expect(listed.body.versions[0].status).toBe('in_use');
  });

  test('古い版で戻そうとすると409で、現在版を返す', async () => {
    expect((await saveMenu(menuBody())).status).toBe(200);
    const reverted = await revertVersion('menu-a', 1, 1);
    expect(reverted.status).toBe(409);
    await expect(reverted.json()).resolves.toMatchObject({
      success: false, code: 'version_conflict', data: { currentVersion: 2 },
    });
    const menu = sqlite.prepare(`SELECT base_price, version FROM menus WHERE id = 'menu-a'`).get() as {
      base_price: number; version: number;
    };
    expect(menu).toMatchObject({ base_price: 8000, version: 2 });
  });

  test('無い版・別アカウントの版は404で存在を漏らさない', async () => {
    expect((await revertVersion('menu-a', 9, 1)).status).toBe(404);
    expect((await revertVersion('menu-b', 1, 1)).status).toBe(404);
    expect((await getVersions('menu-b')).status).toBe(404);
    expect((await getVersions('menu-missing')).status).toBe(404);
  });

  test('staffは戻せず403', async () => {
    expect((await saveMenu(menuBody())).status).toBe(200);
    expect((await revertVersion('menu-a', 1, 2, 'staff')).status).toBe(403);
  });

  test('版の詳細は行の一覧を返す', async () => {
    expect((await saveMenu(menuBody())).status).toBe(200);
    const { app, env } = appFor();
    const res = await app.request('/api/booking/admin/menus/menu-a/versions/2?account_id=account-a', {}, env, execCtx);
    expect(res.status).toBe(200);
    const body = await res.json() as { version: { lines: string[] } };
    expect(body.version.lines.join('\n')).toContain('名前：カット');
  });
});

describe('予約の写し HTTP (T)', () => {
  test('代理登録で写しが残り、版を変えても写しは変わらない', async () => {
    const startsAt = futureStartsAt();
    availability.setStartUtc(startsAt);
    const { app, env } = appFor();
    const created = await app.request('/api/booking/admin/bookings?account_id=account-a', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'snapshot-booking-1' },
      body: JSON.stringify({
        booking_customer_id: 'customer-1',
        menu_id: 'menu-a',
        staff_id: 's1',
        starts_at: startsAt,
        send_line_confirmation: false,
      }),
    }, env, execCtx);
    expect(created.status).toBe(201);
    const { booking_id: bookingId } = await created.json() as { booking_id: string };

    const stored = sqlite.prepare(`SELECT menu_version_number, menu_snapshot_json, price_at_booking
      FROM bookings WHERE id = ?`).get(bookingId) as {
      menu_version_number: number; menu_snapshot_json: string; price_at_booking: number;
    };
    expect(stored?.menu_version_number).toBe(1);
    expect(stored?.price_at_booking).toBe(1000);
    expect(JSON.parse(stored?.menu_snapshot_json ?? '{}')).toMatchObject({
      version: 1, name: '施術A', duration_minutes: 60, base_price: 1000, price_mode: 'fixed',
    });

    // メニューを変える（新しい版）。予約の写しは引っ張られない。
    expect((await saveMenu(menuBody({ base_price: 8000, duration_minutes: 90 }))).status).toBe(200);
    const detail = await app.request(`/api/booking/admin/bookings/${bookingId}?account_id=account-a`, {}, env, execCtx);
    expect(detail.status).toBe(200);
    const detailBody = await detail.json() as { booking: {
      price: number; menuName: string;
      menuSnapshot: { version: number; name: string; durationMinutes: number; basePrice: number } | null;
    } };
    expect(detailBody.booking.price).toBe(1000);
    expect(detailBody.booking.menuName).toBe('施術A');
    expect(detailBody.booking.menuSnapshot).toMatchObject({
      version: 1, name: '施術A', durationMinutes: 60, basePrice: 1000,
    });
  });

  test('写しが無い古い予約の詳細は menuSnapshot が null', async () => {
    sqlite.exec(`INSERT INTO bookings
      (id, line_account_id, booking_customer_id, staff_id, menu_id,
       starts_at, ends_at, block_ends_at, status, price_at_booking, requested_at)
      VALUES ('old-booking','account-a','customer-1','s1','menu-a',
       '2099-01-01T02:00:00.000Z','2099-01-01T03:00:00.000Z','2099-01-01T03:00:00.000Z',
       'confirmed',1000,'2098-12-01T00:00:00.000Z')`);
    const { app, env } = appFor();
    const detail = await app.request('/api/booking/admin/bookings/old-booking?account_id=account-a', {}, env, execCtx);
    expect(detail.status).toBe(200);
    const body = await detail.json() as { booking: { menuSnapshot: unknown } };
    expect(body.booking.menuSnapshot).toBeNull();
  });
});
