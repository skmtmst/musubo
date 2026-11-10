import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { Env } from '../worker-env.js';

const accountAccessMocks = vi.hoisted(() => ({
  canAccessAllLineAccounts: vi.fn(async () => true),
}));
vi.mock('../services/account-access.js', () => accountAccessMocks);

const { default: booking } = await import('./booking.js');

function asD1(sqlite: Database.Database): D1Database {
  const db = {
    prepare(sql: string) {
      const statement = sqlite.prepare(sql);
      const bound = (params: unknown[]): D1PreparedStatement => ({
        bind: (...next: unknown[]) => bound(next),
        all: async <T>() => ({ success: true, results: statement.all(...params) as T[], meta: {} }),
        first: async <T>() => (statement.get(...params) as T | undefined) ?? null,
        run: async <T>() => {
          const result = statement.run(...params);
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

function makeApp(
  db: D1Database,
  role: 'owner' | 'admin' | 'staff' = 'owner',
) {
  const app = new Hono<Env>();
  app.use('*', async (c, next) => {
    c.set('staff', { id: 'staff-1', name: '担当者', role, readOnly: false });
    return next();
  });
  app.route('/', booking);
  return { app, env: { DB: db } };
}

describe('店舗共通の予約設定API', () => {
  let sqlite: Database.Database;
  let db: D1Database;

  beforeEach(() => {
    vi.clearAllMocks();
    accountAccessMocks.canAccessAllLineAccounts.mockResolvedValue(true);
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    sqlite.exec(readFileSync(join(process.cwd(), '../../packages/db/bootstrap.sql'), 'utf8'));
    sqlite.exec(`
      INSERT INTO line_accounts
        (id, channel_id, name, channel_access_token, channel_secret)
      VALUES
        ('account-a', 'channel-a', '本店', 'token-a', 'secret-a'),
        ('account-b', 'channel-b', '支店', 'token-b', 'secret-b'),
        ('account-empty', 'channel-empty', '新店舗', 'token-empty', 'secret-empty');
      INSERT INTO booking_settings
        (id, line_account_id, booking_window_days, cutoff_minutes_before,
         cancel_deadline_minutes_before, approval_mode)
      VALUES ('settings-a', 'account-a', 60, 1440, 720, 'manual');
      INSERT INTO booking_business_hours
        (id, booking_settings_id, weekday, start_time, end_time)
      VALUES
        ('hours-a-1', 'settings-a', 1, '09:00', '12:00'),
        ('hours-a-2', 'settings-a', 1, '13:00', '19:00');
      INSERT INTO menus
        (id, line_account_id, name, duration_minutes, base_price,
         booking_window_days, cutoff_hours_before, is_active)
      VALUES
        ('menu-a', 'account-a', '相談', 60, 8000, NULL, 2, 1),
        ('menu-stop', 'account-a', '停止中', 30, 0, 30, NULL, 0),
        ('menu-b', 'account-b', '別店舗', 45, 5000, NULL, NULL, 1);
      INSERT INTO staff (id, line_account_id, name, display_name)
      VALUES ('staff-a', 'account-a', '担当A', '担当A');
      INSERT INTO staff_menus (staff_id, menu_id, is_offered)
      VALUES ('staff-a', 'menu-a', 1);
      INSERT INTO friends (id, line_user_id, display_name, line_account_id)
      VALUES ('friend-a', 'line-friend-a', '予約者', 'account-a');
      INSERT INTO bookings
        (id, line_account_id, friend_id, staff_id, menu_id, starts_at, ends_at,
         block_ends_at, status, price_at_booking, requested_at)
      VALUES
        ('booking-a', 'account-a', 'friend-a', 'staff-a', 'menu-a',
         '2026-09-20T01:00:00.000Z', '2026-09-20T02:00:00.000Z',
         '2026-09-20T02:00:00.000Z', 'confirmed', 8000,
         strftime('%Y-%m-%dT%H:%M:%f', 'now'));
      INSERT INTO booking_resources (id, line_account_id, name, resource_type, capacity)
      VALUES ('room-a', 'account-a', '相談室', 'room', 2);
      INSERT INTO booking_availability_exceptions
        (id, line_account_id, scope_kind, date_from, date_to, kind, hours_json, reason)
      VALUES
        ('exception-a', 'account-a', 'store', '2026-12-30', '2026-12-30',
         'closed', '[]', '年末休業');
    `);
    db = asD1(sqlite);
  });

  afterEach(() => sqlite.close());

  test('全業種の予約設定はGoogle営業時間を表示し、接続後の手入力を拒否する', async () => {
    sqlite.exec(`
      INSERT INTO rt_organizations(id,account_id,name,status) VALUES('org-a','account-a','相談室','active');
      INSERT INTO rt_stores(id,organization_id,name,code,line_account_id) VALUES('store-a','org-a','相談室','CONSULT','account-a');
      INSERT INTO rt_google_connections(id,store_id,line_account_id,location_name,status)
        VALUES('connection-a','store-a','account-a','accounts/1/locations/2','connected');
    `);
    const profile = { profile: { name: 'locations/2', openStatus: 'OPEN', regularHours: {
      SUNDAY: [], MONDAY: [{ open: '10:00', close: '18:00' }], TUESDAY: [], WEDNESDAY: [],
      THURSDAY: [], FRIDAY: [], SATURDAY: [],
    }, specialHours: [] } };
    sqlite.prepare(`INSERT INTO rt_google_profiles(store_id,location_name,profile_json,fingerprint,fetched_at)
      VALUES('store-a','accounts/1/locations/2',?,'fp','2026-11-11T00:00:00Z')`).run(JSON.stringify(profile));
    const { app, env } = makeApp(db);
    const read = await app.request('/api/booking/admin/settings?account_id=account-a', {}, env);
    expect(read.status).toBe(200);
    await expect(read.json()).resolves.toMatchObject({ data: {
      openingHoursSource: 'google_business', businessHoursConfigured: true,
      businessHours: expect.arrayContaining([{ weekday: 1, intervals: [{ start: '10:00', end: '18:00', capacity: 1 }] }]),
    } });
    const write = await app.request('/api/booking/admin/settings?account_id=account-a', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        expectedVersion: 1, timeZone: 'Asia/Tokyo', bookingWindowDays: 60, cutoffMinutesBefore: 1440,
        cancelDeadlineMinutesBefore: 720, maxActiveBookingsPerFriend: 1, approvalMode: 'manual',
        holdMinutes: 15, slotGranularityMinutes: 15,
        businessHours: Array.from({ length: 7 }, (_, weekday) => ({ weekday, intervals: [] })),
      }),
    }, env);
    expect(write.status).toBe(409);
  });

  test('通常設定は店舗の営業時間・例外日・実メニュー件数を返す', async () => {
    const { app, env } = makeApp(db);
    const res = await app.request('/api/booking/admin/settings?account_id=account-a', {}, env);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      success: true,
      data: {
        lineAccountId: 'account-a',
        organizationName: '本店',
        version: 1,
        bookingWindowDays: 60,
        cutoffMinutesBefore: 1440,
        cancelDeadlineMinutesBefore: 720,
        approvalMode: 'manual',
        menuCount: 2,
        activeMenuCount: 1,
        inactiveMenuCount: 1,
        businessHoursConfigured: false,
        businessHours: expect.arrayContaining([{
          weekday: 1,
          intervals: [{ start: '09:00', end: '12:00', capacity: 1 }, { start: '13:00', end: '19:00', capacity: 1 }],
        }]),
        exceptions: [expect.objectContaining({ date: '2026-12-30', kind: 'closed' })],
      },
    });
  });

  test('未設定の新店舗は安全な既定値と空の営業時間・例外日を返す', async () => {
    const { app, env } = makeApp(db);
    const res = await app.request('/api/booking/admin/settings?account_id=account-empty', {}, env);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      success: true,
      data: {
        version: 0,
        bookingWindowDays: 60,
        businessHoursConfigured: false,
        businessHours: expect.arrayContaining([{ weekday: 0, intervals: [] }]),
        exceptions: [],
        menuCount: 0,
      },
    });
  });

  test('未設定の実在店舗へ既定値を作り、版一致の更新だけを保存する', async () => {
    const { app, env } = makeApp(db);
    const initialBody = {
      expectedVersion: 0,
      timeZone: 'Asia/Tokyo',
      bookingWindowDays: 60,
      cutoffMinutesBefore: 1440,
      cancelDeadlineMinutesBefore: 1440,
      maxActiveBookingsPerFriend: 1,
      approvalMode: 'automatic',
      holdMinutes: 15,
      slotGranularityMinutes: 15,
    };
    const created = await app.request('/api/booking/admin/settings?account_id=account-empty', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(initialBody),
    }, env);
    expect(created.status).toBe(201);
    await expect(created.json()).resolves.toMatchObject({
      success: true,
      data: { lineAccountId: 'account-empty', version: 1, bookingWindowDays: 60 },
    });

    const updated = await app.request('/api/booking/admin/settings?account_id=account-empty', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...initialBody, expectedVersion: 1, bookingWindowDays: 90 }),
    }, env);
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({
      success: true,
      data: { version: 2, bookingWindowDays: 90 },
    });

    const stale = await app.request('/api/booking/admin/settings?account_id=account-empty', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...initialBody, expectedVersion: 1, bookingWindowDays: 120 }),
    }, env);
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({
      code: 'version_conflict', data: { currentVersion: 2 },
    });
    expect(sqlite.prepare(`SELECT booking_window_days, version FROM booking_settings
      WHERE line_account_id = 'account-empty'`).get()).toEqual({
      booking_window_days: 90, version: 2,
    });
  });

  test('リマインダの送信時刻を店舗ごとに保存できる (N-395)', async () => {
    const { app, env } = makeApp(db);
    const body = {
      expectedVersion: 0,
      timeZone: 'Asia/Tokyo',
      bookingWindowDays: 60,
      cutoffMinutesBefore: 1440,
      cancelDeadlineMinutesBefore: 1440,
      maxActiveBookingsPerFriend: 1,
      approvalMode: 'automatic',
      holdMinutes: 15,
      slotGranularityMinutes: 15,
      reminderDayBeforeTime: '18:30',
      reminderHoursBefore: 4,
    };
    const created = await app.request('/api/booking/admin/settings?account_id=account-empty', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, env);
    expect(created.status).toBe(201);
    await expect(created.json()).resolves.toMatchObject({
      success: true,
      data: { reminderDayBeforeTime: '18:30', reminderHoursBefore: 4 },
    });
    expect(sqlite.prepare(`SELECT reminder_day_before_time, reminder_hours_before
      FROM booking_settings WHERE line_account_id = 'account-empty'`).get())
      .toEqual({ reminder_day_before_time: '18:30', reminder_hours_before: 4 });
  });

  test('リマインダ時刻の形が違う入力は400で保存しない (N-395)', async () => {
    const { app, env } = makeApp(db);
    const base = {
      expectedVersion: 0,
      timeZone: 'Asia/Tokyo',
      bookingWindowDays: 60,
      cutoffMinutesBefore: 1440,
      cancelDeadlineMinutesBefore: 1440,
      maxActiveBookingsPerFriend: 1,
      approvalMode: 'automatic',
      holdMinutes: 15,
      slotGranularityMinutes: 15,
    };
    const badTime = await app.request('/api/booking/admin/settings?account_id=account-empty', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...base, reminderDayBeforeTime: '25:00' }),
    }, env);
    expect(badTime.status).toBe(400);

    const badHours = await app.request('/api/booking/admin/settings?account_id=account-empty', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...base, reminderHoursBefore: 99 }),
    }, env);
    expect(badHours.status).toBe(400);
    expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM booking_settings
      WHERE line_account_id = 'account-empty'`).get()).toEqual({ count: 0 });
  });

  test('週全体の営業時間を初回作成し、0行曜日を明示した休業として返す', async () => {
    const { app, env } = makeApp(db, 'admin');
    const res = await app.request('/api/booking/admin/settings?account_id=account-empty', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expectedVersion: 0,
        timeZone: 'Asia/Tokyo',
        bookingWindowDays: 60,
        cutoffMinutesBefore: 1440,
        cancelDeadlineMinutesBefore: 1440,
        maxActiveBookingsPerFriend: 1,
        approvalMode: 'automatic',
        holdMinutes: 15,
        slotGranularityMinutes: 15,
        businessHours: [
          { weekday: 6, intervals: [] },
          { weekday: 1, intervals: [
            { start: '14:00', end: '18:00', capacity: 2 },
            { start: '09:00', end: '12:00', capacity: 3 },
          ] },
          { weekday: 0, intervals: [] },
          { weekday: 2, intervals: [] },
          { weekday: 3, intervals: [] },
          { weekday: 4, intervals: [] },
          { weekday: 5, intervals: [] },
        ],
      }),
    }, env);
    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({
      success: true,
      data: {
        version: 1,
        businessHoursConfigured: true,
        businessHours: [
          { weekday: 0, intervals: [] },
          { weekday: 1, intervals: [
            { start: '09:00', end: '12:00', capacity: 3 },
            { start: '14:00', end: '18:00', capacity: 2 },
          ] },
          { weekday: 2, intervals: [] },
          { weekday: 3, intervals: [] },
          { weekday: 4, intervals: [] },
          { weekday: 5, intervals: [] },
          { weekday: 6, intervals: [] },
        ],
      },
    });
  });

  test('営業時間の古い版は409で、週全体と別店舗を一切変更しない', async () => {
    const { app, env } = makeApp(db);
    const base = {
      expectedVersion: 1,
      timeZone: 'Asia/Tokyo',
      bookingWindowDays: 60,
      cutoffMinutesBefore: 1440,
      cancelDeadlineMinutesBefore: 1440,
      maxActiveBookingsPerFriend: 1,
      approvalMode: 'automatic',
      holdMinutes: 15,
      slotGranularityMinutes: 15,
      businessHours: Array.from({ length: 7 }, (_, weekday) => ({
        weekday,
        intervals: weekday === 1 ? [{ start: '10:00', end: '18:00', capacity: 2 }] : [],
      })),
    };
    const saved = await app.request('/api/booking/admin/settings?account_id=account-a', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(base),
    }, env);
    expect(saved.status).toBe(200);

    const stale = await app.request('/api/booking/admin/settings?account_id=account-a', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...base,
        businessHours: base.businessHours.map((day) => day.weekday === 1
          ? { weekday: 1, intervals: [{ start: '08:00', end: '20:00', capacity: 9 }] }
          : day),
      }),
    }, env);
    expect(stale.status).toBe(409);
    expect(sqlite.prepare(`SELECT start_time, end_time, capacity FROM booking_business_hours
      WHERE booking_settings_id = 'settings-a'`).all())
      .toEqual([{ start_time: '10:00', end_time: '18:00', capacity: 2 }]);
    expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM booking_business_hours bh
      JOIN booking_settings bs ON bs.id = bh.booking_settings_id
      WHERE bs.line_account_id = 'account-b'`).get()).toEqual({ count: 0 });
  });

  test.each([
    ['曜日不足', Array.from({ length: 6 }, (_, weekday) => ({ weekday, intervals: [] }))],
    ['曜日重複', Array.from({ length: 7 }, () => ({ weekday: 1, intervals: [] }))],
    ['時刻形式', Array.from({ length: 7 }, (_, weekday) => ({ weekday, intervals: weekday === 1 ? [{ start: '9:00', end: '18:00', capacity: 1 }] : [] }))],
    ['開始と終了が同じ', Array.from({ length: 7 }, (_, weekday) => ({ weekday, intervals: weekday === 1 ? [{ start: '18:00', end: '18:00', capacity: 1 }] : [] }))],
    ['24:00', Array.from({ length: 7 }, (_, weekday) => ({ weekday, intervals: weekday === 1 ? [{ start: '18:00', end: '24:00', capacity: 1 }] : [] }))],
    ['日またぎ', Array.from({ length: 7 }, (_, weekday) => ({ weekday, intervals: weekday === 1 ? [{ start: '22:00', end: '02:00', capacity: 1 }] : [] }))],
    ['重複', Array.from({ length: 7 }, (_, weekday) => ({ weekday, intervals: weekday === 1 ? [
      { start: '09:00', end: '12:00', capacity: 1 },
      { start: '11:00', end: '14:00', capacity: 1 },
    ] : [] }))],
    ['capacity', Array.from({ length: 7 }, (_, weekday) => ({ weekday, intervals: weekday === 1 ? [{ start: '09:00', end: '12:00', capacity: 0 }] : [] }))],
  ])('%sの営業時間を400で拒否する', async (_label, businessHours) => {
    const { app, env } = makeApp(db);
    const res = await app.request('/api/booking/admin/settings?account_id=account-a', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expectedVersion: 1,
        timeZone: 'Asia/Tokyo',
        bookingWindowDays: 60,
        cutoffMinutesBefore: 1440,
        cancelDeadlineMinutesBefore: 1440,
        maxActiveBookingsPerFriend: 1,
        approvalMode: 'automatic',
        holdMinutes: 15,
        slotGranularityMinutes: 15,
        businessHours,
      }),
    }, env);
    expect(res.status).toBe(400);
  });

  test('隣接した営業時間は重複とせず保存できる', async () => {
    const { app, env } = makeApp(db);
    const res = await app.request('/api/booking/admin/settings?account_id=account-a', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expectedVersion: 1,
        timeZone: 'Asia/Tokyo',
        bookingWindowDays: 60,
        cutoffMinutesBefore: 1440,
        cancelDeadlineMinutesBefore: 1440,
        maxActiveBookingsPerFriend: 1,
        approvalMode: 'automatic',
        holdMinutes: 15,
        slotGranularityMinutes: 15,
        businessHours: Array.from({ length: 7 }, (_, weekday) => ({
          weekday,
          intervals: weekday === 1 ? [
            { start: '09:00', end: '12:00', capacity: 1 },
            { start: '12:00', end: '18:00', capacity: 2 },
          ] : [],
        })),
      }),
    }, env);
    expect(res.status).toBe(200);
  });

  test('存在しない店舗へ設定を作らず、担当外の店舗は保存処理前に拒否する', async () => {
    const body = JSON.stringify({
      expectedVersion: 0,
      timeZone: 'Asia/Tokyo',
      bookingWindowDays: 60,
      cutoffMinutesBefore: 1440,
      cancelDeadlineMinutesBefore: 1440,
      maxActiveBookingsPerFriend: 1,
      approvalMode: 'automatic',
      holdMinutes: 15,
      slotGranularityMinutes: 15,
    });
    const { app, env } = makeApp(db);
    const missing = await app.request('/api/booking/admin/settings?account_id=missing-account', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body,
    }, env);
    expect(missing.status).toBe(404);

    accountAccessMocks.canAccessAllLineAccounts.mockResolvedValueOnce(false);
    const forbidden = await app.request('/api/booking/admin/settings?account_id=account-b', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body,
    }, env);
    expect(forbidden.status).toBe(403);
    expect(sqlite.prepare(`SELECT booking_window_days, version FROM booking_settings
      WHERE line_account_id = 'account-b'`).get()).toBeUndefined();
  });

  test('スタッフは店舗共通の予約ルールを保存できない', async () => {
    const { app, env } = makeApp(db, 'staff');
    const res = await app.request('/api/booking/admin/settings?account_id=account-a', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}',
    }, env);
    expect(res.status).toBe(403);
  });

  test.each([
    ['expectedVersion', { expectedVersion: -1 }],
    ['受付期間', { bookingWindowDays: 0 }],
    ['受付締切', { cutoffMinutesBefore: 43_201 }],
    ['キャンセル期限', { cancelDeadlineMinutesBefore: -1 }],
    ['同時予約数', { maxActiveBookingsPerFriend: 101 }],
    ['承認方式', { approvalMode: 'sometimes' }],
    ['保持時間', { holdMinutes: 0 }],
    ['予約枠の間隔', { slotGranularityMinutes: 20 }],
    ['タイムゾーン', { timeZone: 'not/a-time-zone' }],
  ])('%sの範囲外を400で拒否する', async (_label, change) => {
    const { app, env } = makeApp(db);
    const res = await app.request('/api/booking/admin/settings?account_id=account-a', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expectedVersion: 1,
        timeZone: 'Asia/Tokyo',
        bookingWindowDays: 60,
        cutoffMinutesBefore: 1440,
        cancelDeadlineMinutesBefore: 1440,
        maxActiveBookingsPerFriend: 1,
        approvalMode: 'automatic',
        holdMinutes: 15,
        slotGranularityMinutes: 15,
        ...change,
      }),
    }, env);
    expect(res.status).toBe(400);
  });

  test('取得失敗はDB詳細を返さず、担当外アカウントは処理前に403', async () => {
    const broken = {
      prepare: () => { throw new Error('private database detail'); },
    } as unknown as D1Database;
    const failedApp = makeApp(broken);
    const failed = await failedApp.app.request(
      '/api/booking/admin/settings?account_id=account-a', {}, failedApp.env,
    );
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain('private database detail');

    accountAccessMocks.canAccessAllLineAccounts.mockResolvedValueOnce(false);
    const { app, env } = makeApp(db);
    const forbidden = await app.request(
      '/api/booking/admin/settings?account_id=account-b', {}, env,
    );
    expect(forbidden.status).toBe(403);
  });

  test('休業・短縮・臨時営業を保存し、重複時刻を拒否する', async () => {
    const { app, env } = makeApp(db, 'admin');
    const created = await app.request(
      '/api/booking/admin/exceptions?account_id=account-a',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scopeKind: 'staff',
          scopeId: 'staff-a',
          dateFrom: '2026-09-20',
          dateTo: '2026-09-21',
          kind: 'custom_hours',
          intervals: [{ start: '10:00', end: '16:00' }],
          reason: '研修期間',
        }),
      },
      env,
    );
    expect(created.status).toBe(201);
    const createdBody = await created.json() as { data: { id: string; version: number } };
    expect(createdBody.data.version).toBe(1);

    const invalid = await app.request(
      '/api/booking/admin/exceptions?account_id=account-a',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scopeKind: 'store',
          dateFrom: '2026-09-22',
          dateTo: '2026-09-22',
          kind: 'open',
          intervals: [{ start: '09:00', end: '12:00' }, { start: '11:00', end: '14:00' }],
        }),
      },
      env,
    );
    expect(invalid.status).toBe(400);

    const listed = await app.request('/api/booking/admin/exceptions?account_id=account-a', {}, env);
    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toMatchObject({
      data: { items: expect.arrayContaining([expect.objectContaining({ scopeKind: 'staff' })]) },
    });
  });

  test('例外日は版付きで部分更新し、古い版は409、別店舗IDは404', async () => {
    const { app, env } = makeApp(db);
    const body = JSON.stringify({
      expectedVersion: 1,
      kind: 'open',
      intervals: [{ start: '10:00', end: '17:00' }],
      reason: '祝日営業',
    });
    const updated = await app.request(
      '/api/booking/admin/exceptions/exception-a?account_id=account-a',
      { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body },
      env,
    );
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({ data: { version: 2, kind: 'open' } });

    const conflict = await app.request(
      '/api/booking/admin/exceptions/exception-a?account_id=account-a',
      { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body },
      env,
    );
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      code: 'version_conflict', data: { currentVersion: 2 },
    });

    const hidden = await app.request(
      '/api/booking/admin/exceptions/exception-a?account_id=account-b',
      { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body },
      env,
    );
    expect(hidden.status).toBe(404);
  });

  test('例外日は版付きで削除し、古い版は409、別店舗IDは404 (#953 E-09)', async () => {
    const { app, env } = makeApp(db);

    // 版を送らない削除は受け付けない（読み違えたまま消せないようにする）。
    const missingVersion = await app.request(
      '/api/booking/admin/exceptions/exception-a?account_id=account-a',
      { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) },
      env,
    );
    expect(missingVersion.status).toBe(400);

    // 先に別の変更が入った版で消そうとすると 409 で止まる。
    const conflict = await app.request(
      '/api/booking/admin/exceptions/exception-a?account_id=account-a',
      {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedVersion: 99 }),
      },
      env,
    );
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      code: 'version_conflict', data: { currentVersion: 1 },
    });

    // 別アカウントのIDは存在自体を隠す。
    const hidden = await app.request(
      '/api/booking/admin/exceptions/exception-a?account_id=account-b',
      {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedVersion: 1 }),
      },
      env,
    );
    expect(hidden.status).toBe(404);

    const deleted = await app.request(
      '/api/booking/admin/exceptions/exception-a?account_id=account-a',
      {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedVersion: 1 }),
      },
      env,
    );
    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toMatchObject({ data: { id: 'exception-a' } });

    const listed = await app.request('/api/booking/admin/exceptions?account_id=account-a', {}, env);
    await expect(listed.json()).resolves.toMatchObject({ data: { items: [] } });

    // 消えたIDをもう一度消しても404。
    const gone = await app.request(
      '/api/booking/admin/exceptions/exception-a?account_id=account-a',
      {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedVersion: 1 }),
      },
      env,
    );
    expect(gone.status).toBe(404);
  });

  test('スタッフは例外日を削除できない (#953 E-09)', async () => {
    const { app, env } = makeApp(db, 'staff');
    const res = await app.request(
      '/api/booking/admin/exceptions/exception-a?account_id=account-a',
      {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedVersion: 1 }),
      },
      env,
    );
    expect(res.status).toBe(403);
  });

  test('スタッフは例外日を変更できない', async () => {
    const { app, env } = makeApp(db, 'staff');
    const res = await app.request(
      '/api/booking/admin/exceptions?account_id=account-a',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      },
      env,
    );
    expect(res.status).toBe(403);
  });

  test('メニューは価格種別と店舗既定の継承元を返す', async () => {
    const { app, env } = makeApp(db);
    const res = await app.request('/api/booking/admin/menus?account_id=account-a', {}, env);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      menus: expect.arrayContaining([expect.objectContaining({
        id: 'menu-a',
        price_mode: 'fixed',
        version: 1,
        effectiveBookingRules: {
          bookingWindowDays: 60,
          cutoffMinutesBefore: 120,
          cancelDeadlineMinutesBefore: 720,
          source: {
            bookingWindowDays: 'store',
            cutoffMinutesBefore: 'menu',
            cancelDeadlineMinutesBefore: 'store',
          },
        },
        assigned_staff: [{ id: 'staff-a', display_name: '担当A' }],
        booking_count_30_days: 1,
      })]),
    });
  });

  test('下書き作成と公開切替を保存し、別店舗タグと壊れた基本値を拒否する', async () => {
    sqlite.exec(`INSERT INTO tags (id, name, line_account_id) VALUES ('tag-b', '支店タグ', 'account-b')`);
    const { app, env } = makeApp(db);
    const invalidTag = await app.request('/api/booking/admin/menus?account_id=account-a', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: '下書き', duration_minutes: 30, base_price: 0, is_active: 0, auto_tag_id: 'tag-b',
      }),
    }, env);
    expect(invalidTag.status).toBe(400);

    const invalidBase = await app.request('/api/booking/admin/menus?account_id=account-a', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: ' ', duration_minutes: 0, buffer_after_minutes: -1 }),
    }, env);
    expect(invalidBase.status).toBe(400);

    const draft = await app.request('/api/booking/admin/menus?account_id=account-a', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: ' 下書き ', duration_minutes: 30, base_price: 0, is_active: 0 }),
    }, env);
    expect(draft.status).toBe(201);
    const draftBody = await draft.json() as { id: string };
    expect(sqlite.prepare(`SELECT name, is_active FROM menus WHERE id = ?`).get(draftBody.id))
      .toEqual({ name: '下書き', is_active: 0 });

    const invalidPutTag = await app.request('/api/booking/admin/menus/menu-a?account_id=account-a', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: '相談', duration_minutes: 60, base_price: 8000, is_active: 0,
        auto_tag_id: 'tag-b', expectedVersion: 1,
      }),
    }, env);
    expect(invalidPutTag.status).toBe(400);

    const numericInactive = await app.request('/api/booking/admin/menus/menu-a?account_id=account-a', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: '相談', duration_minutes: 60, base_price: 8000, is_active: 0, expectedVersion: 1,
      }),
    }, env);
    expect(numericInactive.status).toBe(200);
    expect(sqlite.prepare(`SELECT is_active FROM menus WHERE id = 'menu-a'`).get())
      .toEqual({ is_active: 0 });

    const toggled = await app.request('/api/booking/admin/menus/menu-a?account_id=account-a', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedVersion: 2, is_active: false }),
    }, env);
    expect(toggled.status).toBe(200);
    expect(sqlite.prepare(`SELECT name, duration_minutes, base_price, is_active, version
      FROM menus WHERE id = 'menu-a'`).get()).toEqual({
      name: '相談', duration_minutes: 60, base_price: 8000, is_active: 0, version: 3,
    });
  });

  test('シフト一括保存は日付・時刻・件数を検証し、まとめて保存する', async () => {
    const { app, env } = makeApp(db);
    const valid = await app.request('/api/booking/admin/staff/staff-a/shifts?account_id=account-a', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shifts: [
        { work_date: '2026-09-20', start_time: '09:00', end_time: '18:00' },
        { work_date: '2026-09-21', start_time: '10:00', end_time: '17:00' },
      ] }),
    }, env);
    expect(valid.status).toBe(200);
    expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM staff_shifts WHERE staff_id = 'staff-a'`).get())
      .toEqual({ count: 2 });

    const invalid = await app.request('/api/booking/admin/staff/staff-a/shifts?account_id=account-a', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shifts: [
        { work_date: '2026-02-30', start_time: '18:00', end_time: '09:00' },
      ] }),
    }, env);
    expect(invalid.status).toBe(400);

    const tooMany = await app.request('/api/booking/admin/staff/staff-a/shifts?account_id=account-a', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shifts: Array.from({ length: 367 }, () => ({
        work_date: '2026-09-20', start_time: '09:00', end_time: '18:00',
      })) }),
    }, env);
    expect(tooMany.status).toBe(400);
  });

  test('SL-C02: 既存シフトを新規件数へ数えず、再生成しても既存時刻を変えない', async () => {
    const { app, env } = makeApp(db);
    sqlite.prepare(`INSERT INTO staff_shifts (id,staff_id,work_date,start_time,end_time) VALUES ('existing','staff-a','2026-09-20','10:00','17:00')`).run();
    const request = () => app.request('/api/booking/admin/staff/staff-a/shifts/generate?account_id=account-a', {
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({from_date:'2026-09-20',weeks:1,weekly_template:{sun:{start:'09:00',end:'18:00'},mon:{start:'09:00',end:'18:00'}}}),
    },env);
    await expect((await request()).json()).resolves.toEqual({inserted:1});
    await expect((await request()).json()).resolves.toEqual({inserted:0});
    expect(sqlite.prepare(`SELECT start_time,end_time FROM staff_shifts WHERE id='existing'`).get()).toEqual({start_time:'10:00',end_time:'17:00'});
    expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM staff_shifts WHERE staff_id='staff-a'`).get()).toEqual({count:2});
  });

  test('シフト自動生成は12週を上限にし、日付と時刻を検証する', async () => {
    const { app, env } = makeApp(db);
    const request = async (body: unknown): Promise<Response> => app.request(
      '/api/booking/admin/staff/staff-a/shifts/generate?account_id=account-a',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      env,
    );
    await expect(request({
      from_date: '2026-02-30', weeks: 1, weekly_template: {},
    }).then((response) => response.status)).resolves.toBe(400);
    await expect(request({
      from_date: '2026-09-20', weeks: 13, weekly_template: {},
    }).then((response) => response.status)).resolves.toBe(400);
    await expect(request({
      from_date: '2026-09-20', weeks: 1,
      weekly_template: { sun: { start: '18:00', end: '09:00' } },
    }).then((response) => response.status)).resolves.toBe(400);
    const generated = await request({
      from_date: '2026-09-20', weeks: 1,
      weekly_template: { sun: { start: '09:00', end: '18:00' } },
    });
    expect(generated.status).toBe(200);
    await expect(generated.json()).resolves.toEqual({ inserted: 1 });
  });

  test('無料・問い合わせ価格を0円と区別し、メニュー上書きを版付き更新する', async () => {
    const { app, env } = makeApp(db);
    const created = await app.request(
      '/api/booking/admin/menus?account_id=account-a',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: '料金相談', duration_minutes: 30, price_mode: 'inquiry', base_price: 9999,
          booking_window_days: null, cutoff_hours_before: null,
          cancel_deadline_hours_before: null,
        }),
      },
      env,
    );
    expect(created.status).toBe(201);
    const createdBody = await created.json() as { id: string; version: number };
    expect(createdBody.version).toBe(1);
    expect(sqlite.prepare(`SELECT price_mode, base_price FROM menus WHERE id = ?`)
      .get(createdBody.id)).toEqual({ price_mode: 'inquiry', base_price: 0 });

    const patchBody = JSON.stringify({
      expectedVersion: 1,
      price_mode: 'free',
      booking_window_days: 45,
      cutoff_hours_before: null,
      cancel_deadline_hours_before: 24,
    });
    const updated = await app.request(
      '/api/booking/admin/menus/menu-a?account_id=account-a',
      { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: patchBody },
      env,
    );
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({ data: { id: 'menu-a', version: 2 } });
    expect(sqlite.prepare(`SELECT price_mode, base_price, booking_window_days,
      cutoff_hours_before, cancel_deadline_hours_before FROM menus WHERE id = 'menu-a'`).get())
      .toEqual({
        price_mode: 'free', base_price: 0, booking_window_days: 45,
        cutoff_hours_before: null, cancel_deadline_hours_before: 24,
      });

    const conflict = await app.request(
      '/api/booking/admin/menus/menu-a?account_id=account-a',
      { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: patchBody },
      env,
    );
    expect(conflict.status).toBe(409);
  });
});

describe('LIFF 日時表示の最初の形 (liff_date_view)', () => {
  let sqlite: Database.Database;
  let db: D1Database;

  const baseBody = {
    expectedVersion: 0,
    timeZone: 'Asia/Tokyo',
    bookingWindowDays: 60,
    cutoffMinutesBefore: 1440,
    cancelDeadlineMinutesBefore: 1440,
    maxActiveBookingsPerFriend: 1,
    approvalMode: 'automatic',
    holdMinutes: 15,
    slotGranularityMinutes: 15,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    accountAccessMocks.canAccessAllLineAccounts.mockResolvedValue(true);
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    sqlite.exec(readFileSync(join(process.cwd(), '../../packages/db/bootstrap.sql'), 'utf8'));
    sqlite.exec(`
      INSERT INTO line_accounts
        (id, channel_id, name, channel_access_token, channel_secret, liff_id)
      VALUES
        ('account-a', 'channel-a', '本店', 'token-a', 'secret-a', 'liff-a'),
        ('account-b', 'channel-b', '支店', 'token-b', 'secret-b', 'liff-b'),
        ('account-empty', 'channel-empty', '新店舗', 'token-empty', 'secret-empty', 'liff-empty');
      INSERT INTO booking_settings
        (id, line_account_id, booking_window_days, cutoff_minutes_before,
         cancel_deadline_minutes_before, approval_mode)
      VALUES ('settings-a', 'account-a', 60, 1440, 720, 'manual');
      INSERT INTO booking_business_hours
        (id, booking_settings_id, weekday, start_time, end_time)
      VALUES
        ('hours-a-1', 'settings-a', 1, '09:00', '12:00'),
        ('hours-a-2', 'settings-a', 1, '13:00', '19:00');
      INSERT INTO menus
        (id, line_account_id, name, duration_minutes, base_price, is_active)
      VALUES ('menu-a', 'account-a', '相談', 60, 8000, 1);
      INSERT INTO staff (id, line_account_id, name, display_name)
      VALUES ('staff-a', 'account-a', '担当A', '担当A');
      INSERT INTO staff_menus (staff_id, menu_id, is_offered)
      VALUES ('staff-a', 'menu-a', 1);
      INSERT INTO booking_availability_exceptions
        (id, line_account_id, scope_kind, date_from, date_to, kind, hours_json, reason)
      VALUES
        ('exception-a', 'account-a', 'store', '2026-12-30', '2026-12-30',
         'closed', '[]', '年末休業');
    `);
    db = asD1(sqlite);
  });

  afterEach(() => sqlite.close());

  test('migration 前の行は既定 list で読める', async () => {
    const { app, env } = makeApp(db);
    const res = await app.request('/api/booking/admin/settings?account_id=account-a', {}, env);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      success: true,
      data: { liffDateView: 'list' },
    });
  });

  test('calendar を保存し、そのまま読み出せる', async () => {
    const { app, env } = makeApp(db);
    const created = await app.request('/api/booking/admin/settings?account_id=account-empty', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...baseBody, liffDateView: 'calendar' }),
    }, env);
    expect(created.status).toBe(201);
    await expect(created.json()).resolves.toMatchObject({
      success: true,
      data: { liffDateView: 'calendar' },
    });
    expect(sqlite.prepare(`SELECT liff_date_view FROM booking_settings
      WHERE line_account_id = 'account-empty'`).get()).toEqual({ liff_date_view: 'calendar' });

    const reread = await app.request('/api/booking/admin/settings?account_id=account-empty', {}, env);
    await expect(reread.json()).resolves.toMatchObject({
      success: true,
      data: { liffDateView: 'calendar' },
    });
  });

  test('形が違う値は 400 で保存しない', async () => {
    const { app, env } = makeApp(db);
    const res = await app.request('/api/booking/admin/settings?account_id=account-empty', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...baseBody, liffDateView: 'grid' }),
    }, env);
    expect(res.status).toBe(400);
    expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM booking_settings
      WHERE line_account_id = 'account-empty'`).get()).toEqual({ count: 0 });
  });

  test('省いたら今の形を保つ（営業時間だけの保存で戻さない）', async () => {
    const { app, env } = makeApp(db);
    const created = await app.request('/api/booking/admin/settings?account_id=account-empty', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...baseBody, liffDateView: 'calendar' }),
    }, env);
    expect(created.status).toBe(201);
    const updated = await app.request('/api/booking/admin/settings?account_id=account-empty', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...baseBody, expectedVersion: 1, bookingWindowDays: 90 }),
    }, env);
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({
      success: true,
      data: { version: 2, bookingWindowDays: 90, liffDateView: 'calendar' },
    });
  });

  test('LIFF の設定口は自分の店舗だけ読める', async () => {
    const { app, env } = makeApp(db);
    sqlite.exec(`UPDATE booking_settings SET liff_date_view = 'calendar', booking_window_days = 45
      WHERE line_account_id = 'account-a'`);
    const own = await app.request('/api/liff/booking/settings?liffId=liff-a', {}, env);
    expect(own.status).toBe(200);
    await expect(own.json()).resolves.toEqual({
      success: true, liff_date_view: 'calendar',
      booking_window_days: 45,
      // 承認なし確定の店だけ automatic。ここは通常の店なので manual。
      approval_mode: 'manual',
      cancel_deadline_minutes_before: 720,
    });
    // 別店舗の liffId では別店舗の値にならない（設定行が無い新店舗は既定値）。
    const other = await app.request('/api/liff/booking/settings?liffId=liff-empty', {}, env);
    expect(other.status).toBe(200);
    await expect(other.json()).resolves.toEqual({
      success: true, liff_date_view: 'list',
      booking_window_days: 60,
      approval_mode: 'manual',
      cancel_deadline_minutes_before: 1440,
    });
  });

  test('LIFF の設定口は不明な liffId を 404 で断る', async () => {
    const { app, env } = makeApp(db);
    const unknown = await app.request('/api/liff/booking/settings?liffId=liff-unknown', {}, env);
    expect(unknown.status).toBe(404);
    const missing = await app.request('/api/liff/booking/settings', {}, env);
    expect(missing.status).toBe(404);
  });

  test('LIFF の空き枠口は休みの日を closed_dates で返す', async () => {
    // R92: 店舗の受付期間（60日）の内側の日で確かめる。期間の外は
    // 休み印の対象外（枠自体が出ない）になる。
    const jst = (offsetDays: number) =>
      new Date(Date.now() + offsetDays * 86_400_000 + 9 * 3_600_000).toISOString().slice(0, 10);
    const target = jst(10);
    sqlite.exec(`
      INSERT INTO booking_availability_exceptions
        (id, line_account_id, scope_kind, date_from, date_to, kind, hours_json, reason)
      VALUES
        ('exception-test-closed', 'account-a', 'store', '${target}', '${target}',
         'closed', '[]', '試験休業');
    `);
    const { app, env } = makeApp(db);
    const res = await app.request(
      `/api/liff/booking/availability?liffId=liff-a&menu_id=menu-a&staff_id=staff-a&from=${jst(9)}&to=${jst(11)}`,
      {},
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { by_staff: unknown[]; closed_dates: string[] };
    expect(Array.isArray(body.closed_dates)).toBe(true);
    // 店舗の休業日（例外日）は休み。枠の有無の判定自体は変えない。
    expect(body.closed_dates).toContain(target);
    expect(body.by_staff.length).toBeGreaterThan(0);
  });

  test('LIFF の空き枠口は28日を超える期間を 400 で断る', async () => {
    const { app, env } = makeApp(db);
    const wide = await app.request(
      '/api/liff/booking/availability?liffId=liff-a&menu_id=menu-a&staff_id=staff-a&from=2026-12-01&to=2027-01-01',
      {},
      env,
    );
    expect(wide.status).toBe(400);
    await expect(wide.json()).resolves.toMatchObject({ error: 'range_too_wide' });
    // 28日ちょうどは通る（カレンダーは月を28日ずつに割って呼ぶ）。
    const fit = await app.request(
      '/api/liff/booking/availability?liffId=liff-a&menu_id=menu-a&staff_id=staff-a&from=2026-12-01&to=2026-12-29',
      {},
      env,
    );
    expect(fit.status).toBe(200);
  });
});
