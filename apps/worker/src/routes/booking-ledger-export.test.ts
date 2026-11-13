// GET /api/booking/admin/bookings.csv（台帳CSV）と
// GET /api/booking/admin/requests の担当者・種別絞り込み、
// /o の view=history 通過の route 試験。
//
// 実SQLite (bootstrap.sql) で動かし、絞り込み・CSV・権限の実挙動を見る。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { Env } from '../worker-env.js';

const availabilityMocks = vi.hoisted(() => ({
  getAvailability: vi.fn(async () => ({ by_staff: [] })),
}));
vi.mock('../services/availability.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/availability.js')>();
  return { ...actual, getAvailability: availabilityMocks.getAvailability };
});

const notifierMocks = vi.hoisted(() => ({
  sendBookingNotification: vi.fn(async () => undefined),
}));
// 送る側だけ差し替える。文面の組み立て（時刻・残り時間）は本物を使う。
vi.mock('../features/booking/booking-notifier.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../features/booking/booking-notifier.js')>()),
  ...notifierMocks,
}));

const accountAccessMocks = vi.hoisted(() => ({
  canAccessAllLineAccounts: vi.fn(async () => true),
}));
vi.mock('../services/account-access.js', () => accountAccessMocks);

const { default: booking } = await import('./booking.js');
const { app: rootApp } = await import('../index.js');

function asD1(sqlite: Database.Database): D1Database {
  const db = {
    prepare(sql: string) {
      const order: number[] = [];
      const rewritten = sql.replace(/\?(\d+)/g, (_m, n: string) => {
        order.push(Number(n));
        return '?';
      });
      const statement = sqlite.prepare(rewritten);
      const arrange = (params: unknown[]) =>
        order.length > 0 ? order.map((index) => params[index - 1]) : params;
      const bound = (params: unknown[]): D1PreparedStatement => ({
        bind: (...next: unknown[]) => bound(next),
        all: async <T>() => ({ success: true, results: statement.all(...arrange(params)) as T[], meta: {} }),
        first: async <T>() => (statement.get(...arrange(params)) as T | undefined) ?? null,
        run: async <T>() => {
          const result = statement.run(...arrange(params));
          return { success: true, results: [], meta: { changes: result.changes } } as T;
        },
        raw: async () => [],
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
  };
  return db as unknown as D1Database;
}

type StaffLike = {
  id: string;
  name: string;
  role: 'owner' | 'admin' | 'staff';
  readOnly: boolean;
  permissionKeys?: string[];
  viewPermissionKeys?: string[];
};

function makeApp(db: D1Database, staff: StaffLike = { id: 'owner-1', name: 'Owner', role: 'owner', readOnly: false }) {
  const app = new Hono<Env>();
  app.use('*', async (c, next) => {
    c.set('staff', staff);
    return next();
  });
  app.route('/', booking);
  return { app, env: { DB: db } };
}

const execCtx = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
} as unknown as ExecutionContext;

function seed(sqlite: Database.Database) {
  sqlite.exec(readFileSync(join(process.cwd(), '../../packages/db/bootstrap.sql'), 'utf8'));
  sqlite.exec(`
    INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
    VALUES ('acc1','channel-1','A店','token','secret'),
           ('acc2','channel-2','B店','token2','secret2');
    INSERT INTO staff (id, line_account_id, name, display_name)
    VALUES ('s1','acc1','担当A','担当A'),
           ('s2','acc1','担当B','担当B'),
           ('s9','acc2','他店担当','他店担当');
    INSERT INTO menus (
      id, line_account_id, name, duration_minutes, buffer_after_minutes,
      base_price, concurrent_capacity
    ) VALUES ('m1','acc1','相談',60,10,8000,1),
             ('m2','acc1','カット',30,10,5000,1),
             ('m9','acc2','他店メニュー',30,10,3000,1);
    INSERT INTO booking_settings (id, line_account_id, timezone)
    VALUES ('bs1','acc1','Asia/Tokyo');
    INSERT INTO friends (id, line_user_id, display_name, line_account_id, is_following, created_at, updated_at)
    VALUES ('f1','U1','=HYPERLINK("http://evil.example")','acc1',1,'2026-01-01T00:00:00.000','2026-01-01T00:00:00.000'),
           ('f9','U9','他店客','acc2',1,'2026-01-01T00:00:00.000','2026-01-01T00:00:00.000');
    INSERT INTO booking_customers (
      id, line_account_id, display_name, phone_normalized_hash,
      phone_encrypted, phone_last4, pet_name
    ) VALUES ('customer-1','acc1','見本 143','hash','cipher','5678','ポチ');
  `);
}

function insertBooking(
  sqlite: Database.Database,
  input: {
    id: string;
    account?: string;
    friend?: string | null;
    customer?: string | null;
    staff?: string;
    menu?: string;
    status?: string;
    source?: string;
    startsAt?: string;
  },
) {
  const startsAt = input.startsAt ?? '2026-10-01T02:00:00.000Z';
  const ends = new Date(new Date(startsAt).getTime() + 60 * 60_000);
  const block = new Date(ends.getTime() + 10 * 60_000);
  sqlite.prepare(`
    INSERT INTO bookings (
      id, line_account_id, friend_id, booking_customer_id, staff_id, menu_id,
      starts_at, ends_at, block_ends_at, status, price_at_booking, requested_at,
      lock_version, notification_policy_snapshot, source
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    input.id,
    input.account ?? 'acc1',
    input.friend ?? null,
    input.customer ?? null,
    input.staff ?? 's1',
    input.menu ?? 'm1',
    startsAt,
    ends.toISOString(),
    block.toISOString(),
    input.status ?? 'confirmed',
    8000,
    '2026-09-01T00:00:00.000Z',
    0,
    '{}',
    input.source ?? 'liff',
  );
}

describe('GET /api/booking/admin/requests の担当者・種別絞り込み (N-398)', () => {
  let sqlite: Database.Database;
  let db: D1Database;

  beforeEach(() => {
    vi.clearAllMocks();
    accountAccessMocks.canAccessAllLineAccounts.mockResolvedValue(true);
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    seed(sqlite);
    db = asD1(sqlite);
  });

  afterEach(() => sqlite.close());

  test('staff_id と source で絞り込み、total も同じ条件で数える', async () => {
    insertBooking(sqlite, { id: 'B1', friend: 'f1', staff: 's1', source: 'liff', status: 'confirmed' });
    insertBooking(sqlite, { id: 'B2', customer: 'customer-1', staff: 's2', menu: 'm2', source: 'phone', status: 'completed' });
    insertBooking(sqlite, { id: 'B3', friend: 'f1', staff: 's2', source: 'operator', status: 'confirmed' });
    const { app, env } = makeApp(db);

    const byStaff = await app.request(
      '/api/booking/admin/requests?account_id=acc1&status=all&staff_id=s1', {}, env,
    );
    expect(byStaff.status).toBe(200);
    const byStaffBody = await byStaff.json() as { requests: Array<{ id: string }>; total: number };
    expect(byStaffBody.requests.map((r) => r.id)).toEqual(['B1']);
    // 件数も一覧と同じ条件で数える（一覧と件数がずれない）。
    expect(byStaffBody.total).toBe(1);

    const bySource = await app.request(
      '/api/booking/admin/requests?account_id=acc1&status=all&source=phone', {}, env,
    );
    const bySourceBody = await bySource.json() as { requests: Array<{ id: string }> };
    expect(bySourceBody.requests.map((r) => r.id)).toEqual(['B2']);
  });

  test('CHECK外の種別値は条件にしない（0件化で誤解させない）', async () => {
    insertBooking(sqlite, { id: 'B1', friend: 'f1', source: 'liff' });
    const { app, env } = makeApp(db);
    const res = await app.request(
      '/api/booking/admin/requests?account_id=acc1&status=all&source=bogus', {}, env,
    );
    const body = await res.json() as { total: number };
    expect(body.total).toBe(1);
  });

  test('他アカウントの予約は混ざらない', async () => {
    insertBooking(sqlite, { id: 'B1', friend: 'f1' });
    insertBooking(sqlite, { id: 'B9', account: 'acc2', friend: 'f9', staff: 's9', menu: 'm9' });
    const { app, env } = makeApp(db);
    const res = await app.request(
      '/api/booking/admin/requests?account_id=acc1&status=all', {}, env,
    );
    const body = await res.json() as { requests: Array<{ id: string }>; total: number };
    expect(body.requests.map((r) => r.id)).toEqual(['B1']);
    expect(body.total).toBe(1);
  });
});

describe('GET /api/booking/admin/bookings.csv (N-397)', () => {
  let sqlite: Database.Database;
  let db: D1Database;

  beforeEach(() => {
    vi.clearAllMocks();
    accountAccessMocks.canAccessAllLineAccounts.mockResolvedValue(true);
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    seed(sqlite);
    db = asD1(sqlite);
  });

  afterEach(() => sqlite.close());

  test('日本時間の朝も台帳の書出し名は今日の日付', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-30T15:09:00Z'));
    try {
      const { app, env } = makeApp(db);
      const res = await app.request('/api/booking/admin/bookings.csv?account_id=acc1&status=all', {}, env);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-disposition')).toBe('attachment; filename="booking-ledger-20261001-by-owner-1-20260930T150900000Z.csv"');
    } finally { vi.useRealTimers(); }
  });

  test('BOM付きCSV・注記行に絞り込みと上限を書く', async () => {
    insertBooking(sqlite, { id: 'B1', friend: 'f1', status: 'confirmed', source: 'liff' });
    insertBooking(sqlite, { id: 'B2', customer: 'customer-1', staff: 's2', menu: 'm2', status: 'completed', source: 'phone' });
    const { app, env } = makeApp(db);
    const res = await app.request(
      '/api/booking/admin/bookings.csv?account_id=acc1&status=all', {}, env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('content-disposition')).toContain('attachment');
    // BOM は text が剥がすので、生バイトで確かめる（Excelが文字化けしない印）。
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder().decode(bytes);
    const lines = text.slice(1).split('\r\n');
    // 先頭行は範囲の断り。絞り込み条件と件数上限が一目で分かる。
    expect(lines[0]).toContain('予約台帳の書出し');
    expect(lines[0]).toContain('状態=すべて');
    expect(lines[0]).toContain('5000件');
    // 2行目が見出し。
    expect(lines[1]).toContain('予約ID');
    expect(lines[1]).toContain('予約経路');
    // 2件分の行（同時刻なので順は問わない）。状態と経路は画面と同じ日本語。
    const body = lines.slice(2).join('\n');
    expect(body).toContain('B1');
    expect(body).toContain('確定');
    expect(body).toContain('LINE');
    expect(body).toContain('B2');
    expect(body).toContain('完了');
    expect(body).toContain('電話');
  });

  test('一覧と同じ絞り込みがCSVにも効く', async () => {
    insertBooking(sqlite, { id: 'B1', friend: 'f1', staff: 's1', source: 'liff' });
    insertBooking(sqlite, { id: 'B2', customer: 'customer-1', staff: 's2', menu: 'm2', source: 'phone', status: 'completed' });
    const { app, env } = makeApp(db);
    const res = await app.request(
      '/api/booking/admin/bookings.csv?account_id=acc1&status=all&staff_id=s2&source=phone', {}, env,
    );
    const text = await res.text();
    expect(text).not.toContain('B1');
    expect(text).toContain('B2');
    // 注記行に絞り込み条件が残る。
    expect(text.split('\r\n')[0]).toContain('種別=電話');
    expect(text.split('\r\n')[0]).toContain('担当者=指定');
  });

  test('=で始まる表示名は式にならないよう \' を頭に付ける', async () => {
    insertBooking(sqlite, { id: 'B1', friend: 'f1' });
    const { app, env } = makeApp(db);
    const res = await app.request(
      '/api/booking/admin/bookings.csv?account_id=acc1&status=all', {}, env,
    );
    const text = await res.text();
    expect(text).toContain(`"'=HYPERLINK(""http://evil.example"")"`);
    expect(text).not.toContain('"=HYPERLINK');
  });

  test('タブや空白で始まる表示名も式にならないよう \' を頭に付ける (#959)', async () => {
    sqlite
      .prepare("UPDATE friends SET display_name = ? WHERE id = 'f1'")
      .run('\t=SUM(1,1)');
    sqlite
      .prepare("UPDATE booking_customers SET display_name = ? WHERE id = 'customer-1'")
      .run(' =1+1');
    insertBooking(sqlite, { id: 'B1', friend: 'f1' });
    insertBooking(sqlite, { id: 'B2', customer: 'customer-1' });
    const { app, env } = makeApp(db);
    const res = await app.request(
      '/api/booking/admin/bookings.csv?account_id=acc1&status=all', {}, env,
    );
    const text = await res.text();
    expect(text).toContain('"\'\t=SUM(1,1)"');
    expect(text).toContain('"\' =1+1"');
    expect(text).not.toContain('"\t=SUM');
    expect(text).not.toContain('" =1+1');
  });

  test('注記行: 改行を仕込んだ絞り込み値は生のCSV行として混入しない (#959)', async () => {
    insertBooking(sqlite, { id: 'B1', friend: 'f1', status: 'confirmed' });
    const { app, env } = makeApp(db);
    // status は trim されず、menu_name/query は途中の改行が trim を生き残る。
    const res = await app.request(
      '/api/booking/admin/bookings.csv?account_id=acc1' +
        '&status=%0D%0A%3D1%2B1' +
        '&menu_name=x%0D%0A%3DHYPERLINK(%22http://evil%22)' +
        '&query=y%0D%0A%2B2%2B5' +
        '&from=z%0D%0A%40cmd',
      {}, env,
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    const lines = text.split('\r\n');
    // 細工値は絞り込み条件にも流れるのでデータ行は0件。改行注入が効いて
    // いれば式の行がここに生えるが、注記行+見出し+末尾空行の3つだけ。
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('予約台帳の書出し');
    expect(lines[1]).toContain('予約ID');
    expect(lines[2]).toBe('');
    // どの行も式接頭辞やタブで始まらず、行の中に改行・制御文字も残らない。
    for (const line of lines) {
      expect(line).not.toMatch(/^[\t =+\-@]/);
      expect(line).not.toMatch(/[\r\n\x00-\x1F\x7F]/);
    }
    // 値そのものは消さず改行だけ潰れて注記行に残る（状態==1+1 = 「状態=」+「=1+1」）。
    expect(lines[0]).toContain('状態==1+1');
    expect(lines[0]).toContain('メニュー=x=HYPERLINK');
  });

  test('所属外アカウントは403（CSVも中身を出さない）', async () => {
    accountAccessMocks.canAccessAllLineAccounts.mockResolvedValue(false);
    insertBooking(sqlite, { id: 'B9', account: 'acc2', friend: 'f9', staff: 's9', menu: 'm9' });
    const { app, env } = makeApp(db);
    const res = await app.request(
      '/api/booking/admin/bookings.csv?account_id=acc2&status=all', {}, env,
    );
    expect(res.status).toBe(403);
    const text = await res.text();
    expect(text).not.toContain('B9');
  });

  test('閲覧キーのみのスタッフは書き出せる（読み取りの別形式）、キー無しは403', async () => {
    insertBooking(sqlite, { id: 'B1', friend: 'f1' });
    const viewer = makeApp(db, {
      id: 'staff-1', name: 'Staff', role: 'staff', readOnly: false,
      viewPermissionKeys: ['/booking/bookings'],
    });
    const res = await viewer.app.request(
      '/api/booking/admin/bookings.csv?account_id=acc1&status=all', {}, viewer.env,
    );
    expect(res.status).toBe(200);

    const none = makeApp(db, {
      id: 'staff-2', name: 'NoKey', role: 'staff', readOnly: false,
      permissionKeys: [], viewPermissionKeys: [],
    });
    const denied = await none.app.request(
      '/api/booking/admin/bookings.csv?account_id=acc1&status=all', {}, none.env,
    );
    expect(denied.status).toBe(403);
  });
});

describe('GET /o の予約履歴URL通過 (N-396)', () => {
  test.each([
    ['page=visit-stamps&card=card-1', 'visit-stamps', 'card', 'card-1'],
    ['page=visit-stamps', 'visit-stamps', 'card', null],
    ['page=salon-book&menu_id=menu-1', 'salon-book', 'menu_id', 'menu-1'],
    ['page=salon-book&menu_id=x%26admin%3D1', 'salon-book', 'menu_id', null],
    ['page=event&card=card-1&menu_id=menu-1', 'event', 'card', null],
  ])('選んだメニュー・カードを対象ページにだけ通す: %s', async (query, page, key, expected) => {
    const res = await rootApp.request(`/o?liffId=1234-abcdef&${query}`, { headers: { 'user-agent': 'Mozilla/5.0 (Macintosh)' } }, { DB: {} } as never, execCtx);
    expect(res.status).toBe(200);
    const html = await res.text();
    const target = new URL(decodeURIComponent(html.match(/\/api\/qr\?size=240x240&data=([^"&]+)/)![1]));
    expect(target.searchParams.get('page')).toBe(page);
    expect(target.searchParams.get(key)).toBe(expected);
  });
  test('salon-book の view=history だけを LIFF 宛URLへ通す', async () => {
    // desktop UA でQRページを返す。QRの data パラメータに転送先が丸ごと入る。
    const res = await rootApp.request(
      '/o?liffId=1234-abcdef&page=salon-book&view=history',
      { headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X)' } },
      { DB: {} } as never,
      execCtx,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    const dataMatch = html.match(/\/api\/qr\?size=240x240&data=([^"&]+)/);
    expect(dataMatch).toBeTruthy();
    const target = decodeURIComponent(dataMatch![1]);
    expect(target).toContain('https://liff.line.me/1234-abcdef');
    expect(target).toContain('page=salon-book');
    expect(target).toContain('view=history');
  });

  test('salon-book 以外のページや未定義の view は通さない', async () => {
    const res = await rootApp.request(
      '/o?liffId=1234-abcdef&page=salon-book&view=admin',
      { headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X)' } },
      { DB: {} } as never,
      execCtx,
    );
    const html = await res.text();
    const target = decodeURIComponent(html.match(/data=([^"&]+)/)![1]);
    expect(target).not.toContain('view=');
  });
});
