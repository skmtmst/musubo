/**
 * F6 core（本人LIFF日時変更・取消）の局所mock試験。
 *
 * 実 SQLite（bootstrap.sql）＋実 route/DB で通し、外部だけを置き換える。
 * - LINE idToken 検証は fetch stub（sub を切替可能）
 * - 空き枠計算 getAvailability だけ mock（他は本物）
 * - 送信 sendBookingNotification は mock（実送信0）
 * - Google 同期 runBookingGoogleSync は既定で skipped の mock。
 *   実 runner 結合は別 test で real に戻し、provider（fetch の googleapis）だけを
 *   有限失敗→成功させる
 * - 自動通知の許可 bookingAutomaticNotificationAllowed は mock で true
 * - 管理者 fixture 用 app と本人リクエスト用 app を分ける。
 *   本人 app には staff を設定しない（公開認証経路の証拠）
 *
 * 見ること: 本人/越境/期限/CAS/空き/再送冪等/Meet取消/通知（manual印なし）。
 * 待ち列は扱わない。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { Env } from '../worker-env.js';

const notifierMocks = { sendBookingNotification: vi.fn() };
vi.mock('../features/booking/booking-notifier.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../features/booking/booking-notifier.js')>()),
  ...notifierMocks,
}));
vi.mock('../services/account-access.js', () => ({
  canAccessAllLineAccounts: vi.fn(async () => true),
}));

const availabilityMocks = { getAvailability: vi.fn() };
vi.mock('../services/availability.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/availability.js')>()),
  ...availabilityMocks,
}));

const calendarState: { real?: (...args: never[]) => Promise<unknown> } = {};
const calendarSyncMocks = { runBookingGoogleSync: vi.fn() };
vi.mock('../features/booking/booking-calendar-sync.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../features/booking/booking-calendar-sync.js')>();
  calendarState.real = orig.runBookingGoogleSync as unknown as typeof calendarState.real;
  return {
    ...orig,
    runBookingGoogleSync: (...args: Parameters<typeof orig.runBookingGoogleSync>) =>
      calendarSyncMocks.runBookingGoogleSync(...args),
  };
});

const triggerState: { real?: (...args: never[]) => Promise<unknown> } = {};
const triggerMocks = { cancelByTrigger: vi.fn() };
const triggerGate: {
  enrollHook: (() => Promise<void>) | null;
  reconcileHook: (() => Promise<void>) | null;
} = { enrollHook: null, reconcileHook: null };
vi.mock('../services/reminder-trigger.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../services/reminder-trigger.js')>();
  triggerState.real = orig.cancelByTrigger as unknown as typeof triggerState.real;
  return {
    ...orig,
    cancelByTrigger: (...args: Parameters<typeof orig.cancelByTrigger>) =>
      triggerMocks.cancelByTrigger(...args),
    enrollByTrigger: async (...args: Parameters<typeof orig.enrollByTrigger>) => {
      if (triggerGate.enrollHook) await triggerGate.enrollHook();
      return orig.enrollByTrigger(...args);
    },
    reconcileV6ToStartsAt: async (...args: Parameters<typeof orig.reconcileV6ToStartsAt>) => {
      if (triggerGate.reconcileHook) await triggerGate.reconcileHook();
      return orig.reconcileV6ToStartsAt(...args);
    },
  };
});

const meetState: {
  realRegister?: (...args: never[]) => Promise<unknown>;
  realCancel?: (...args: never[]) => Promise<unknown>;
} = {};
const meetGate: { hook: (() => Promise<void>) | null; afterHook: (() => Promise<void>) | null } = {
  hook: null,
  afterHook: null,
};
const meetCtl: { failCancelOnce: boolean } = { failCancelOnce: false };
vi.mock('../services/meet-consultation-reminders.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../services/meet-consultation-reminders.js')>();
  meetState.realRegister = orig.registerMeetConsultation as unknown as typeof meetState.realRegister;
  meetState.realCancel = orig.cancelMeetConsultation as unknown as typeof meetState.realCancel;
  return {
    ...orig,
    registerMeetConsultation: async (...args: Parameters<typeof orig.registerMeetConsultation>) => {
      if (meetGate.hook) await meetGate.hook();
      const out = await (meetState.realRegister as (...a: unknown[]) => Promise<unknown>)(...args);
      if (meetGate.afterHook) await meetGate.afterHook();
      return out;
    },
    cancelMeetConsultation: async (...args: Parameters<typeof orig.cancelMeetConsultation>) => {
      if (meetCtl.failCancelOnce) {
        meetCtl.failCancelOnce = false;
        throw new Error('COMPENSATION_INJECTED_FAILURE');
      }
      return (meetState.realCancel as (...a: unknown[]) => Promise<unknown>)(...args);
    },
  };
});

vi.mock('../features/booking/booking-channels.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../features/booking/booking-channels.js')>()),
  bookingAutomaticNotificationAllowed: vi.fn(async () => true),
}));
vi.mock('../services/feature-enforcement.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/feature-enforcement.js')>()),
  featureJobCanRun: vi.fn(async () => true),
}));

const { default: booking } = await import('./booking.js');

function asD1(sqlite: Database.Database): D1Database {
  function call<T>(run: (...args: unknown[]) => T, params: unknown[]): T {
    try {
      return run(...params);
    } catch (error) {
      if (!/parameter/i.test(String((error as Error)?.message))) throw error;
      return run(Object.fromEntries(params.map((value, index) => [String(index + 1), value])));
    }
  }
  const db = {
    prepare(sql: string) {
      const statement = sqlite.prepare(sql);
      const bound = (params: unknown[]): D1PreparedStatement => ({
        bind: (...next: unknown[]) => bound(next),
        all: async <T>() => ({
          success: true,
          results: call((...a) => statement.all(...a), params) as T[],
          meta: {},
        }),
        first: async <T>() => (call((...a) => statement.get(...a), params) as T | undefined) ?? null,
        run: async <T>() => {
          const changes = statement.reader
            ? (call((...a) => statement.all(...a), params) as unknown[]).length
            : call((...a) => statement.run(...a), params).changes;
          return { success: true, results: [], meta: { changes } } as T;
        },
        raw: async () => [],
      } as unknown as D1PreparedStatement);
      return bound([]);
    },
    async batch(statements: D1PreparedStatement[]) {
      const out = [];
      for (const statement of statements) out.push(await statement.run());
      return out;
    },
  };
  return db as unknown as D1Database;
}

let waited: Array<Promise<unknown>> = [];
const execCtx = {
  waitUntil: (promise: Promise<unknown>) => {
    waited.push(Promise.resolve(promise));
  },
  passThroughOnException: () => undefined,
} as unknown as ExecutionContext;

async function drainWaits() {
  const pending = waited;
  waited = [];
  await Promise.all(pending);
}

/** 送信は mock 受信側で見る。fetch へ出た物はすべて記録する。 */
let fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
let googleFailCreate = 0;
const googleEvents = new Map<string,Record<string,unknown>>();

function mockFetch() {
  fetchCalls = [];
  googleFailCreate = 0;
  googleEvents.clear();
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('api.line.me/oauth2/v2.1/verify')) {
      return new Response(JSON.stringify({ sub: lineSub }), { status: 200 });
    }
    if (url.includes('www.googleapis.com/calendar/v3')) {
      fetchCalls.push({ url, init });
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'DELETE') return new Response(null, { status: 204 });
      if (method === 'POST' && url.endsWith('/events')) {
        if (googleFailCreate > 0) {
          googleFailCreate -= 1;
          return new Response('provider error', { status: 500 });
        }
        const body = JSON.parse(String(init?.body ?? '{}')) as { id?: string };
        googleEvents.set(body.id ?? 'evt-new',body);
        return new Response(JSON.stringify({ id: body.id ?? 'evt-new' }), { status: 200 });
      }
      if(method==='GET'&&url.includes('/events/'))return new Response(JSON.stringify(googleEvents.get(decodeURIComponent(url.split('/events/')[1]))??{}),{status:googleEvents.has(decodeURIComponent(url.split('/events/')[1]))?200:404});
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    }
    fetchCalls.push({ url, init });
    throw new Error(`想定外の外部呼び出し: ${url}`);
  }));
}

function headerOf(init?: RequestInit, name?: string): string | null {
  if (!init?.headers || !name) return null;
  if (typeof (init.headers as Headers).get === 'function') {
    return (init.headers as Headers).get(name);
  }
  const record = init.headers as Record<string, string>;
  const key = Object.keys(record).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? record[key] : null;
}

/** 自動送信の fetch に manual 印が無いこと。 */
function expectNoManualHeader() {
  for (const call of fetchCalls) {
    expect(headerOf(call.init, 'X-Line-Harness-Source')).toBeNull();
  }
}

/** provider（googleapis）への外部呼出し回数。 */
function googleCallCount() {
  return fetchCalls.filter((call) => call.url.includes('www.googleapis.com')).length;
}

const NY = 'America/New_York';
/** 基準時 2026-10-20T12:00Z。menu-ok の期限1h・締切1h。 */
const T1 = '2026-11-02T15:00:00.000Z';
const T2 = '2026-11-02T16:00:00.000Z';
const T3 = '2026-11-02T17:00:00.000Z';
/** 基準時の12時間後。menu-strict（期限48h）の内側。 */
const T_SOON = '2026-10-21T00:00:00.000Z';

let lineSub = 'U-self-1';

function slotAt(startUtc: string, date: string, start: string, end: string) {
  return {
    date, start, end, timeZone: NY, startUtc,
    endUtc: startUtc, capacity: 1, remaining: 1, state: 'available',
  };
}

function mockSlots(entries: Array<{ iso: string; date: string; start: string; end: string }>) {
  availabilityMocks.getAvailability.mockResolvedValue({
    by_staff: [{
      staff_id: 'staff-ny', display_name: '担当NY',
      slots: entries.map((e) => slotAt(e.iso, e.date, e.start, e.end)),
    }],
  });
}

const D11 = { iso: T1, date: '2026-11-02', start: '10:00', end: '11:00' };
const D12 = { iso: T2, date: '2026-11-02', start: '11:00', end: '12:00' };
const D13 = { iso: T3, date: '2026-11-02', start: '12:00', end: '13:00' };
const DSOON = { iso: T_SOON, date: '2026-10-20', start: '19:00', end: '20:00' };
describe('F6 本人日時変更・取消（mock局所）', () => {
  let sqlite: Database.Database;
  let db: D1Database;
  let adminApp: Hono<Env>;
  let selfApp: Hono<Env>;
  let env: { DB: D1Database };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-20T12:00:00.000Z'));
    vi.clearAllMocks();
    lineSub = 'U-self-1';
    calendarSyncMocks.runBookingGoogleSync.mockImplementation(async () => 'skipped');
    triggerMocks.cancelByTrigger.mockImplementation((...args: unknown[]) =>
      (triggerState.real as (...a: unknown[]) => Promise<unknown>)(...args),
    );
    meetGate.hook = null;
    meetGate.afterHook = null;
    triggerGate.enrollHook = null;
    triggerGate.reconcileHook = null;
    notifierMocks.sendBookingNotification.mockResolvedValue(undefined);
    calendarSyncMocks.runBookingGoogleSync.mockImplementation(async () => 'skipped');
    meetCtl.failCancelOnce = false;

    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    sqlite.exec(readFileSync(join(process.cwd(), '../../packages/db/bootstrap.sql'), 'utf8'));
    sqlite.exec(`
      INSERT INTO line_accounts
        (id, channel_id, name, channel_access_token, channel_secret, liff_id, timezone)
      VALUES
        ('account-ny', 'channel-ny', 'NY店', 'token-ny', 'secret-ny', 'liff-ny-1', '${NY}'),
        ('account-b', 'channel-b', 'B店', 'token-b', 'secret-b', 'liff-b-1', '${NY}');
      -- 変更・取消の試験は複数予約を準備する。人数上限は専用試験で守る。
      INSERT INTO booking_settings (id, line_account_id, timezone, max_active_bookings_per_friend)
      VALUES ('settings-ny', 'account-ny', '${NY}', 10), ('settings-b', 'account-b', '${NY}', 10);
      INSERT INTO menus
        (id, line_account_id, name, duration_minutes, buffer_after_minutes, base_price,
         cancel_deadline_hours_before, cutoff_hours_before)
      VALUES
        ('menu-ok', 'account-ny', '相談', 60, 0, 8000, 1, 1),
        ('menu-strict', 'account-ny', '厳格相談', 60, 0, 8000, 48, 1);
      INSERT INTO staff (id, line_account_id, name, display_name)
      VALUES ('staff-ny', 'account-ny', '担当NY', '担当NY');
      INSERT INTO staff_menus (staff_id, menu_id, is_offered)
      VALUES ('staff-ny', 'menu-ok', 1), ('staff-ny', 'menu-strict', 1);
      INSERT INTO friends (id, line_user_id, display_name, line_account_id, is_following)
      VALUES
        ('friend-self', 'U-self-1', '本人', 'account-ny', 1),
        ('friend-other', 'U-other-1', '他人', 'account-ny', 1),
        ('friend-b', 'U-b-1', '本人B', 'account-b', 1);
    `);
    db = asD1(sqlite);
    // 管理者 fixture 用は staff あり。本人リクエスト用は staff 無し。
    // staff 無しで本人操作が通ることが、公開認証経路（authMiddleware が
    // /api/liff/ を外す＋idToken 検証）の証拠になる。
    adminApp = new Hono<Env>();
    adminApp.use('*', async (c, next) => {
      c.set('staff', { id: 'staff-ny', name: '担当NY', role: 'owner', readOnly: false });
      return next();
    });
    adminApp.route('/', booking);
    selfApp = new Hono<Env>();
    selfApp.route('/', booking);
    env = { DB: db };
    // LIFF の id_token 検証と Google provider だけ通す。ほかは落とす。
    mockFetch();
  });

  afterEach(() => {
    sqlite.close();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function adminCreate(menuId: string, startsAt: string, key: string): Promise<string> {
    const res = await adminApp.request(
      '/api/booking/admin/bookings?account_id=account-ny',
      {
        method: 'POST',
        body: JSON.stringify({
          friend_id: 'friend-self', menu_id: menuId, staff_id: 'staff-ny',
          starts_at: startsAt, send_line_confirmation: false,
        }),
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
      },
      env,
      execCtx,
    );
    expect(res.status).toBe(201);
    const body = await res.json<{ booking_id: string }>();
    return body.booking_id;
  }

  function selfPost(path: string, body: unknown, liff = 'liff-ny-1') {
    return selfApp.request(
      `${path}?liffId=${liff}`,
      {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-id-token' },
      },
      env,
      execCtx,
    );
  }

  function bookingRow(id: string) {
    return sqlite.prepare('SELECT * FROM bookings WHERE id = ?').get(id) as Record<string, unknown>;
  }

  test('店の既定期限を公開設定と履歴に返し、メニュー個別期限を優先する', async () => {
    sqlite.prepare("UPDATE booking_settings SET cancel_deadline_minutes_before = 90 WHERE line_account_id = 'account-ny'").run();
    const settings = await selfApp.request('/api/liff/booking/settings?liffId=liff-ny-1', {}, env);
    expect((await settings.json() as { cancel_deadline_minutes_before: number }).cancel_deadline_minutes_before).toBe(90);
    mockSlots([D11]);
    await adminCreate('menu-ok', T1, 'deadline-test');
    const read = () => selfApp.request('/api/liff/booking/me?liffId=liff-ny-1', { headers: { Authorization: 'Bearer idToken-self' } }, env);
    const before = await read();
    expect(before.status).toBe(200);
    const mine = await before.json() as { upcoming: Array<{ cancel_deadline_minutes_before: number; cancel_deadline_at: string }> };
    expect(mine.upcoming[0]).toMatchObject({ cancel_deadline_minutes_before: 60, cancel_deadline_at: new Date(Date.parse(T1) - 60 * 60_000).toISOString() });
    sqlite.prepare("UPDATE menus SET cancel_deadline_hours_before = NULL WHERE id = 'menu-ok'").run();
    const inherited = await read();
    expect((await inherited.json() as typeof mine).upcoming[0]).toMatchObject({ cancel_deadline_minutes_before: 90, cancel_deadline_at: new Date(Date.parse(T1) - 90 * 60_000).toISOString() });
  });

  test.each([null, '{}', '"scalar"', '{"name":null}', '{"name":""}'])('写しが無い・壊れた予約は現在の名前で履歴を読める（%s）', async (snapshot) => {
    mockSlots([D11]);
    const id = await adminCreate('menu-ok', T1, 'history-fallback');
    sqlite.prepare('UPDATE bookings SET menu_snapshot_json = ? WHERE id = ?').run(snapshot, id);
    const current = sqlite.prepare('SELECT name FROM menus WHERE id = ?').get('menu-ok') as { name: string };
    const response = await selfApp.request('/api/liff/booking/me?liffId=liff-ny-1', { headers: { Authorization: 'Bearer test-id-token' } }, env, execCtx);
    expect(response.status).toBe(200);
    const body = await response.json() as { upcoming: Array<{ id: string; menu_name: string; menu_snapshot_json?: string }> };
    expect(body.upcoming[0]).toMatchObject({ id, menu_name: current.name });
    expect(body.upcoming[0]).not.toHaveProperty('menu_snapshot_json');
  });

  test('予約後の改名は予定と過去の履歴の名前を変えない', async () => {
    mockSlots([D11]);
    const id = await adminCreate('menu-ok', T1, 'history-name');
    const original = sqlite.prepare('SELECT name FROM menus WHERE id = ?').get('menu-ok') as { name: string };
    sqlite.prepare('UPDATE menus SET name = ? WHERE id = ?').run('改名した受付メニュー', 'menu-ok');
    for (const status of ['confirmed', 'cancelled']) {
      sqlite.prepare('UPDATE bookings SET status = ? WHERE id = ?').run(status, id);
      const response = await selfApp.request('/api/liff/booking/me?liffId=liff-ny-1', { headers: { Authorization: 'Bearer test-id-token' } }, env, execCtx);
      expect(response.status).toBe(200);
      const body = await response.json() as { upcoming: Array<{ id: string; menu_name: string }>; past: Array<{ id: string; menu_name: string }> };
      expect((status === 'confirmed' ? body.upcoming : body.past)[0]).toMatchObject({ id, menu_name: original.name });
    }
  });

  test('予約履歴の版とメニュー・担当を使って日時変更と取消ができる', async () => {
    mockSlots([D11, D12]);
    const id = await adminCreate('menu-ok', T1, 'history-actions');
    sqlite.prepare('UPDATE bookings SET lock_version = 3 WHERE id = ?').run(id);
    const readHistory = async () => {
      const res = await selfApp.request('/api/liff/booking/me?liffId=liff-ny-1', {
        headers: { Authorization: 'Bearer test-id-token' },
      }, env, execCtx);
      expect(res.status).toBe(200);
      return res.json<{ upcoming: Array<{ id: string; menu_id: string; staff_id: string; lock_version: number }>; past: Array<{ id: string; lock_version: number }> }>();
    };
    const first = (await readHistory()).upcoming;
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ id, menu_id: 'menu-ok', staff_id: 'staff-ny', lock_version: 3 });
    const changed = await selfPost(`/api/liff/booking/${id}/reschedule`, {
      starts_at: T2, lock_version: first[0].lock_version,
    });
    expect(changed.status).toBe(200);
    const next = (await readHistory()).upcoming[0];
    expect(next.lock_version).toBe(4);
    const cancelled = await selfPost(`/api/liff/booking/${id}/cancel`, { lock_version: next.lock_version });
    expect(cancelled.status).toBe(200);
    const last = await readHistory();
    expect(last.upcoming).toEqual([]);
    expect(last.past[0]).toMatchObject({ id, menu_id: 'menu-ok', staff_id: 'staff-ny', lock_version: 4 });
  });

  test('日時変更が成立し、版が進み、変更通知が自動で積まれる（manual印なし）', async () => {
    mockSlots([D11, D12]);
    const id = await adminCreate('menu-ok', T1, 'rs-ok');
    const res = await selfPost(`/api/liff/booking/${id}/reschedule`, {
      starts_at: T2, lock_version: 0,
    });
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    expect(body.lock_version).toBe(1);
    expect(body.meet_sync).toBe('not_linked');
    expect(body.change_notification).toBe('queued');
    expect(bookingRow(id).starts_at).toBe(T2);
    const ops = sqlite.prepare(
      "SELECT kind, result_json FROM booking_operation_runs WHERE booking_id = ?",
    ).all(id) as Array<{ kind: string; result_json: string }>;
    const notice = ops.find((op) => op.kind === 'confirmation_line');
    expect(notice).toBeDefined();
    expect(notice!.result_json).toContain('changed');
    expect(notice!.result_json).not.toContain('manual');
    // waitUntil を回収し、mock 受信と stub 記録の範囲で自動送信に manual 印が
    // 無いことを見る（実LINE推送の確認ではない）。
    await drainWaits();
    expect(notifierMocks.sendBookingNotification).toHaveBeenCalledTimes(1);
    const sent = notifierMocks.sendBookingNotification.mock.calls[0][0] as Record<string, unknown>;
    expect(JSON.stringify(sent)).not.toContain('manual');
    expectNoManualHeader();
  });

  test('別人の予約・別店舗の予約は404で見せない', async () => {
    mockSlots([D11, D12]);
    const id = await adminCreate('menu-ok', T1, 'rs-cross');
    lineSub = 'U-other-1';
    const other = await selfPost(`/api/liff/booking/${id}/reschedule`, {
      starts_at: T2, lock_version: 0,
    });
    expect(other.status).toBe(404);
    lineSub = 'U-self-1';
    const cross = await selfPost(`/api/liff/booking/${id}/reschedule`, {
      starts_at: T2, lock_version: 0,
    }, 'liff-b-1');
    expect(cross.status).toBe(404);
    expect(bookingRow(id).starts_at).toBe(T1);
  });

  test('idTokenが無ければ401', async () => {
    const res = await selfApp.request(
      '/api/liff/booking/xxx/reschedule?liffId=liff-ny-1',
      {
        method: 'POST',
        body: JSON.stringify({ starts_at: T2, lock_version: 0 }),
        headers: { 'Content-Type': 'application/json' },
      },
      env,
      execCtx,
    );
    expect(res.status).toBe(401);
  });

  test('期限を過ぎた予約の変更は403', async () => {
    mockSlots([DSOON, D11]);
    const id = await adminCreate('menu-strict', T_SOON, 'rs-deadline');
    const res = await selfPost(`/api/liff/booking/${id}/reschedule`, {
      starts_at: T1, lock_version: 0,
    });
    expect(res.status).toBe(403);
    expect((await res.json<{ error: string }>()).error).toBe('self_deadline_passed');
  });

  test('古い版での変更は409（CAS）', async () => {
    mockSlots([D11, D12, D13]);
    const id = await adminCreate('menu-ok', T1, 'rs-cas');
    const first = await selfPost(`/api/liff/booking/${id}/reschedule`, {
      starts_at: T2, lock_version: 0,
    });
    expect(first.status).toBe(200);
    const stale = await selfPost(`/api/liff/booking/${id}/reschedule`, {
      starts_at: T3, lock_version: 0,
    });
    expect(stale.status).toBe(409);
    expect(bookingRow(id).starts_at).toBe(T2);
  });

  test('同じ日時の再送は200で二重更新しない（冪等）', async () => {
    mockSlots([D11, D12]);
    const id = await adminCreate('menu-ok', T1, 'rs-replay');
    const first = await selfPost(`/api/liff/booking/${id}/reschedule`, {
      starts_at: T2, lock_version: 0,
    });
    expect(first.status).toBe(200);
    const replay = await selfPost(`/api/liff/booking/${id}/reschedule`, {
      starts_at: T2, lock_version: 1,
    });
    expect(replay.status).toBe(200);
    const body = await replay.json<Record<string, unknown>>();
    expect(body.changed).toBe(false);
    expect(body.lock_version).toBe(1);
  });

  test('空きが無ければ409（監視表示ではなく空き正本で判定）', async () => {
    mockSlots([D11]);
    const id = await adminCreate('menu-ok', T1, 'rs-noslot');
    availabilityMocks.getAvailability.mockResolvedValue({ by_staff: [] });
    const res = await selfPost(`/api/liff/booking/${id}/reschedule`, {
      starts_at: T2, lock_version: 0,
    });
    expect(res.status).toBe(409);
  });

  test('Google失敗はcalendar_sync=failedで残し、予約は成立のまま', async () => {
    mockSlots([D11, D12]);
    calendarSyncMocks.runBookingGoogleSync.mockResolvedValue('retry_wait');
    const id = await adminCreate('menu-ok', T1, 'rs-gfail');
    const res = await selfPost(`/api/liff/booking/${id}/reschedule`, {
      starts_at: T2, lock_version: 0,
    });
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    expect(body.calendar_sync).toBe('failed');
    expect(bookingRow(id).starts_at).toBe(T2);
  });

  function linkCalendar() {
    sqlite.prepare(
      `INSERT INTO google_calendar_connections
         (id, calendar_id, line_account_id, staff_id, access_token, auth_type, is_active)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
    ).run('conn-1', 'cal-1', 'account-ny', 'staff-ny', 'tok-test', 'oauth');
    sqlite.exec("INSERT INTO booking_calendar_switches(line_account_id,scope_id,write_enabled,updated_by,updated_at) VALUES('account-ny','',1,'test',datetime('now')),('account-ny','staff-ny',1,'test',datetime('now'))");
  }

  function useRealGoogleRunner() {
    calendarSyncMocks.runBookingGoogleSync.mockImplementation((...args: never[]) =>
      (calendarState.real as (...a: never[]) => Promise<unknown>)(...args),
    );
  }

  function linkMeet(bookingId: string, eventId = 'evt-1') {
    sqlite.prepare('UPDATE bookings SET external_event_id = ? WHERE id = ?')
      .run(eventId, bookingId);
    sqlite.prepare(
      `INSERT INTO meet_consultations
         (id, external_event_id, friend_id, title, starts_at, ends_at, meet_url, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'confirmed')`,
    ).run(
      'consult-1', eventId, 'friend-self', '個別相談',
      T1, '2026-11-02T16:00:00.000Z', 'https://meet.google.com/aaa-bbbb-ccc',
    );
    sqlite.prepare(
      `INSERT INTO meet_consultation_notification_runs
         (id, consultation_id, kind, scheduled_at, status)
       VALUES (?, ?, ?, ?, 'pending'), (?, ?, ?, ?, 'pending')`,
    ).run(
      'mr-day', 'consult-1', 'day_before', '2026-11-01T15:00:00.000Z',
      'mr-hour', 'consult-1', 'hour_before', '2026-11-02T14:00:00.000Z',
    );
  }

  test('取消が成立し、予約・旧予定・Meetが止まり、カレンダー削除が台帳に残る', async () => {
    mockSlots([D11, D12]);
    const id = await adminCreate('menu-ok', T1, 'cx-ok');
    linkMeet(id);
    const res = await selfPost(`/api/liff/booking/${id}/cancel`, { lock_version: 0 });
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    expect(body.status).toBe('cancelled');
    expect(body.meet_sync).toBe('cancelled');
    expect(bookingRow(id).status).toBe('cancelled');
    const pending = sqlite.prepare(
      "SELECT COUNT(*) AS n FROM booking_reminders WHERE booking_id = ? AND status IN ('pending','failed')",
    ).get(id) as { n: number };
    expect(pending.n).toBe(0);
    const consult = sqlite.prepare(
      'SELECT status FROM meet_consultations WHERE id = ?',
    ).get('consult-1') as { status: string };
    expect(consult.status).toBe('cancelled');
    const meetPending = sqlite.prepare(
      "SELECT COUNT(*) AS n FROM meet_consultation_notification_runs WHERE consultation_id = ? AND status IN ('pending','failed')",
    ).get('consult-1') as { n: number };
    expect(meetPending.n).toBe(0);
    const calOps = sqlite.prepare(
      "SELECT status FROM booking_operation_runs WHERE booking_id = ? AND kind = 'google_calendar'",
    ).all(id) as Array<{ status: string }>;
    expect(calOps.length).toBeGreaterThan(0);
  });

  test('結び付きの無い取消はmeet_sync=not_linked（作らない）', async () => {
    mockSlots([D11]);
    const id = await adminCreate('menu-ok', T1, 'cx-nolink');
    const res = await selfPost(`/api/liff/booking/${id}/cancel`, { lock_version: 0 });
    expect(res.status).toBe(200);
    expect((await res.json<Record<string, unknown>>()).meet_sync).toBe('not_linked');
    expect((sqlite.prepare('SELECT COUNT(*) AS n FROM meet_consultations').get() as { n: number }).n).toBe(0);
  });

  test('取消ずみの再送は200で副作用をそろえる（冪等）', async () => {
    mockSlots([D11]);
    const id = await adminCreate('menu-ok', T1, 'cx-retry');
    const first = await selfPost(`/api/liff/booking/${id}/cancel`, { lock_version: 0 });
    expect(first.status).toBe(200);
    const retry = await selfPost(`/api/liff/booking/${id}/cancel`, { lock_version: 0 });
    expect(retry.status).toBe(200);
    expect((await retry.json<Record<string, unknown>>()).retried).toBe(true);
  });

  test('期限を過ぎた予約の取消は403、版違いは409', async () => {
    mockSlots([DSOON]);
    const id = await adminCreate('menu-strict', T_SOON, 'cx-deadline');
    const denied = await selfPost(`/api/liff/booking/${id}/cancel`, { lock_version: 0 });
    expect(denied.status).toBe(403);
    mockSlots([D11]);
    const id2 = await adminCreate('menu-ok', T1, 'cx-ver');
    const conflict = await selfPost(`/api/liff/booking/${id2}/cancel`, { lock_version: 9 });
    expect(conflict.status).toBe(409);
    expect(bookingRow(id2).status).not.toBe('cancelled');
  });

  test('Meetに結び付く予約の日時変更は相談の日時も移す', async () => {
    mockSlots([D11, D12]);
    const id = await adminCreate('menu-ok', T1, 'rs-meet');
    linkMeet(id);
    const res = await selfPost(`/api/liff/booking/${id}/reschedule`, {
      starts_at: T2, lock_version: 0,
    });
    expect(res.status).toBe(200);
    expect((await res.json<Record<string, unknown>>()).meet_sync).toBe('updated');
    const consult = sqlite.prepare(
      'SELECT starts_at, status FROM meet_consultations WHERE id = ?',
    ).get('consult-1') as { starts_at: string; status: string };
    expect(consult.starts_at).toBe(T2);
    expect(consult.status).toBe('confirmed');
    // 前日・1時間前の予定が新日時に組み直される。
    const reminders = sqlite.prepare(
      'SELECT kind, scheduled_at, status FROM meet_consultation_notification_runs WHERE consultation_id = ? AND schedule_revision=(SELECT schedule_revision FROM meet_consultations WHERE id=consultation_id) ORDER BY kind',
    ).all('consult-1') as Array<{ kind: string; scheduled_at: string; status: string }>;
    expect(reminders).toEqual([
      { kind: 'day_before', scheduled_at: '2026-11-01T16:00:00.000Z', status: 'pending' },
      { kind: 'hour_before', scheduled_at: '2026-11-02T15:00:00.000Z', status: 'pending' },
    ]);
  });

  test('送信中の取消再送は409で、副作用は未実施のまま残る', async () => {
    mockSlots([D11]);
    const id = await adminCreate('menu-ok', T1, 'cx-inflight');
    const first = await selfPost(`/api/liff/booking/${id}/cancel`, { lock_version: 0 });
    expect(first.status).toBe(200);
    triggerMocks.cancelByTrigger.mockRejectedValueOnce(
      new Error('REMINDER_SEND_IN_FLIGHT'),
    );
    const retry = await selfPost(`/api/liff/booking/${id}/cancel`, { lock_version: 0 });
    expect(retry.status).toBe(409);
    expect((await retry.json<{ error: string }>()).error).toBe('send_in_flight_retry');
    // 取消ずみのまま。未実施を適用対象外にしない（再送で回復できる）。
    expect(bookingRow(id).status).toBe('cancelled');
  });

  test('送信中の初回取消は409で確定を取り消す（version/state契約）', async () => {
    mockSlots([D11]);
    const id = await adminCreate('menu-ok', T1, 'cx-inflight-first');
    triggerMocks.cancelByTrigger.mockRejectedValueOnce(
      new Error('REMINDER_SEND_IN_FLIGHT'),
    );
    const res = await selfPost(`/api/liff/booking/${id}/cancel`, { lock_version: 0 });
    expect(res.status).toBe(409);
    // rollback: 状態は確定前（confirmed）のまま、版も進んでいない。
    expect(bookingRow(id).status).toBe('confirmed');
    expect(bookingRow(id).lock_version).toBe(0);
    // 送信が終われば同じ版で取消できる。
    const retry = await selfPost(`/api/liff/booking/${id}/cancel`, { lock_version: 0 });
    expect(retry.status).toBe(200);
  });

  test('失敗後の同日時再送はCalendarを回復し、二重通知を作らない', async () => {
    mockSlots([D11, D12]);
    calendarSyncMocks.runBookingGoogleSync.mockResolvedValueOnce('retry_wait');
    const id = await adminCreate('menu-ok', T1, 'rs-recover');
    const first = await selfPost(`/api/liff/booking/${id}/reschedule`, {
      starts_at: T2, lock_version: 0,
    });
    expect(first.status).toBe(200);
    expect((await first.json<Record<string, unknown>>()).calendar_sync).toBe('failed');
    calendarSyncMocks.runBookingGoogleSync.mockResolvedValue('succeeded');
    const replay = await selfPost(`/api/liff/booking/${id}/reschedule`, {
      starts_at: T2, lock_version: 1,
    });
    expect(replay.status).toBe(200);
    const body = await replay.json<Record<string, unknown>>();
    expect(body.changed).toBe(false);
    expect(body.calendar_sync).toBe('synced');
    // 通知は初回だけ。再送で二重に積まない。
    const notices = sqlite.prepare(
      "SELECT COUNT(*) AS n FROM booking_operation_runs WHERE booking_id = ? AND kind = 'confirmation_line'",
    ).get(id) as { n: number };
    expect(notices.n).toBe(1);
  });

  test('取消ずみの予約への古い日時変更は409', async () => {
    mockSlots([D11]);
    const id = await adminCreate('menu-ok', T1, 'rs-after-cancel');
    const cancelled = await selfPost(`/api/liff/booking/${id}/cancel`, { lock_version: 0 });
    expect(cancelled.status).toBe(200);
    const res = await selfPost(`/api/liff/booking/${id}/reschedule`, {
      starts_at: T2, lock_version: 0,
    });
    expect(res.status).toBe(409);
  });

  test('実runner結合: provider結果不明→同日時再送はGET照合だけ（台帳保持・重複0）', async () => {
    useRealGoogleRunner();
    linkCalendar();
    mockSlots([D11, D12]);
    const id = await adminCreate('menu-ok', T1, 'rs-real');
    const createdCalls = googleCallCount();
    googleFailCreate = 1;
    const first = await selfPost(`/api/liff/booking/${id}/reschedule`, {
      starts_at: T2, lock_version: 0,
    });
    expect(first.status).toBe(200);
    expect((await first.json<Record<string, unknown>>()).calendar_sync).toBe('failed');
    expect(bookingRow(id).external_event_id).toMatch(/^lh/);
    // 失敗時は delete＋create の2回だけ外部へ出る。
    expect(googleCallCount() - createdCalls).toBe(2);
    const replay = await selfPost(`/api/liff/booking/${id}/reschedule`, {
      starts_at: T2, lock_version: 1,
    });
    expect(replay.status).toBe(200);
    const body = await replay.json<Record<string, unknown>>();
    expect(body.changed).toBe(false);
    expect(body.calendar_sync).toBe('failed');
    const evt = bookingRow(id).external_event_id as string;
    expect(evt).toMatch(/^lh/);
    // 結果不明の再開はGETの1回だけ。404でも新しいPOSTは出さない。
    expect(googleCallCount() - createdCalls).toBe(3);
    // 版ごとの冪等キーで台帳は2行（作成v0・変更v1）。v1行は成功で閉じる。
    const calOps = sqlite.prepare(
      "SELECT idempotency_key, status FROM booking_operation_runs WHERE booking_id = ? AND kind = 'google_calendar' ORDER BY created_at",
    ).all(id) as Array<{ idempotency_key: string; status: string }>;
    expect(calOps.length).toBe(2);
    expect(new Set(calOps.map((op) => op.idempotency_key)).size).toBe(2);
    expect(calOps[1].status).toBe('retry_wait');
    // 通知は初回だけ、予定の重複なし。
    const notices = sqlite.prepare(
      "SELECT COUNT(*) AS n FROM booking_operation_runs WHERE booking_id = ? AND kind = 'confirmation_line'",
    ).get(id) as { n: number };
    expect(notices.n).toBe(1);
    const pending = sqlite.prepare(
      "SELECT kind, scheduled_at FROM booking_reminders WHERE booking_id = ? AND status = 'pending' ORDER BY kind",
    ).all(id) as Array<{ kind: string; scheduled_at: string }>;
    expect(pending.length).toBe(2);
    expect(new Set(pending.map((r) => `${r.kind}@${r.scheduled_at}`)).size).toBe(2);
    await drainWaits();
    expectNoManualHeader();
  });

  test('成功ずみ同日時再送は外部呼出し0（guard）', async () => {
    useRealGoogleRunner();
    linkCalendar();
    mockSlots([D11, D12]);
    const id = await adminCreate('menu-ok', T1, 'rs-guard');
    const createdCalls = googleCallCount();
    const first = await selfPost(`/api/liff/booking/${id}/reschedule`, {
      starts_at: T2, lock_version: 0,
    });
    expect(first.status).toBe(200);
    expect((await first.json<Record<string, unknown>>()).calendar_sync).toBe('synced');
    const evt = bookingRow(id).external_event_id as string;
    // 作成時1回＋変更時 delete/create 2回。
    expect(googleCallCount() - createdCalls).toBe(2);
    const replay = await selfPost(`/api/liff/booking/${id}/reschedule`, {
      starts_at: T2, lock_version: 1,
    });
    expect(replay.status).toBe(200);
    const body = await replay.json<Record<string, unknown>>();
    expect(body.changed).toBe(false);
    expect(body.calendar_sync).toBe('synced');
    // 成功ずみ再送は外部へ出ない。予定IDも採番し直さない。台帳も増えない。
    expect(googleCallCount() - createdCalls).toBe(2);
    expect(bookingRow(id).external_event_id).toBe(evt);
    const ops = sqlite.prepare(
      'SELECT COUNT(*) AS n FROM booking_operation_runs WHERE booking_id = ? AND kind = ?',
    ).get(id, 'google_calendar') as { n: number };
    expect(ops.n).toBe(2);
  });

  test('予定作り直しでは同一相談を新eventへ登録し直す（URL継続・両reminder）', async () => {
    useRealGoogleRunner();
    linkCalendar();
    mockSlots([D11, D12]);
    const id = await adminCreate('menu-ok', T1, 'rs-recreate');
    linkMeet(id, 'evt-old');
    const res = await selfPost(`/api/liff/booking/${id}/reschedule`, {
      starts_at: T2, lock_version: 0,
    });
    expect(res.status).toBe(200);
    expect((await res.json<Record<string, unknown>>()).meet_sync).toBe('recreated');
    const newEvt = bookingRow(id).external_event_id as string;
    expect(newEvt).not.toBe('evt-old');
    // 古い相談は止まり、新予定ID・本人・新日時・同じ Meet URL で登録される。
    const old = sqlite.prepare(
      'SELECT status FROM meet_consultations WHERE external_event_id = ?',
    ).get('evt-old') as { status: string };
    expect(old.status).toBe('cancelled');
    const next = sqlite.prepare(
      'SELECT * FROM meet_consultations WHERE external_event_id = ?',
    ).get(newEvt) as Record<string, unknown>;
    expect(next.status).toBe('confirmed');
    expect(next.friend_id).toBe('friend-self');
    expect(next.starts_at).toBe(T2);
    expect(next.meet_url).toBe('https://meet.google.com/aaa-bbbb-ccc');
    const reminders = sqlite.prepare(
      'SELECT kind, scheduled_at, status FROM meet_consultation_notification_runs WHERE consultation_id = ? AND schedule_revision=(SELECT schedule_revision FROM meet_consultations WHERE id=consultation_id) ORDER BY kind',
    ).all(next.id) as Array<{ kind: string; scheduled_at: string; status: string }>;
    expect(reminders).toEqual([
      { kind: 'day_before', scheduled_at: '2026-11-01T16:00:00.000Z', status: 'pending' },
      { kind: 'hour_before', scheduled_at: '2026-11-02T15:00:00.000Z', status: 'pending' },
    ]);
  });

  test('register直前の取消は書込み後に補償され、相談は復活しない', async () => {
    mockSlots([D11, D12]);
    const id = await adminCreate('menu-ok', T1, 'race-meet');
    linkMeet(id);
    // register の直前で取消を完走させる有限barrier。
    meetGate.hook = async () => {
      meetGate.hook = null;
      const cancelRes = await selfPost(`/api/liff/booking/${id}/cancel`, { lock_version: 1 });
      expect(cancelRes.status).toBe(200);
    };
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('race timeout')), 15000);
    });
    const res = await Promise.race([
      selfPost(`/api/liff/booking/${id}/reschedule`, { starts_at: T2, lock_version: 0 }),
      timeout,
    ]);
    expect(res.status).toBe(200);
    // 予約の変更は成立したが、間に勝った取消をMeetが覆さない。
    expect((await res.json<Record<string, unknown>>()).meet_sync).toBe('superseded');
    expect(bookingRow(id).status).toBe('cancelled');
    const consults = sqlite.prepare(
      'SELECT status FROM meet_consultations',
    ).all() as Array<{ status: string }>;
    expect(consults.every((c) => c.status === 'cancelled')).toBe(true);
    const pending = sqlite.prepare(
      "SELECT COUNT(*) AS n FROM meet_consultation_notification_runs WHERE status IN ('pending','failed')",
    ).get() as { n: number };
    expect(pending.n).toBe(0);
    await drainWaits();
  });

  test('先行失敗のrollbackは後発成功の取消を巻き戻さない', async () => {
    mockSlots([D11]);
    const id = await adminCreate('menu-ok', T1, 'race-rollback');
    let enteredFlag = false;
    let gateResolve: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { gateResolve = resolve; });
    let calls = 0;
    triggerMocks.cancelByTrigger.mockImplementation(async (...args: unknown[]) => {
      calls += 1;
      if (calls === 1) {
        enteredFlag = true;
        await gate;
        throw new Error('REMINDER_SEND_IN_FLIGHT');
      }
      return (triggerState.real as (...a: unknown[]) => Promise<unknown>)(...args);
    });
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('race timeout')), 15000);
    });
    const aPromise = selfPost(`/api/liff/booking/${id}/cancel`, { lock_version: 0 });
    for (let i = 0; i < 200; i++) {
      if (enteredFlag) break;
      await new Promise((r) => setTimeout(r, 10));
      if (i === 199) throw new Error('cancelByTrigger に到達しませんでした');
    }
    // 後発が先に成功する。時刻は Frozen のまま（同msでも uuid の主張で区別する）。
    const b = await Promise.race([
      selfPost(`/api/liff/booking/${id}/cancel`, { lock_version: 0 }),
      timeout,
    ]);
    expect(b.status).toBe(200);
    const decidedAfterB = (bookingRow(id) as Record<string, unknown>).decided_at;
    const claimAfterB = (bookingRow(id) as Record<string, unknown>).cancel_claim_id;
    expect(typeof claimAfterB).toBe('string');
    // 先行の rollback は後発の decided_at・主張を消さない。
    gateResolve();
    const a = await Promise.race([aPromise, timeout]);
    expect(a.status).toBe(409);
    expect(bookingRow(id).status).toBe('cancelled');
    expect((bookingRow(id) as Record<string, unknown>).decided_at).toBe(decidedAfterB);
    expect((bookingRow(id) as Record<string, unknown>).cancel_claim_id).toBe(claimAfterB);
  });

  test('再送の主張はuuidで回転し、同msでも上書きが区別できる', async () => {
    mockSlots([D11]);
    const id = await adminCreate('menu-ok', T1, 'cx-claim-rotate');
    const first = await selfPost(`/api/liff/booking/${id}/cancel`, { lock_version: 0 });
    expect(first.status).toBe(200);
    const c1 = bookingRow(id).cancel_claim_id;
    expect(typeof c1).toBe('string');
    const r1 = await selfPost(`/api/liff/booking/${id}/cancel`, { lock_version: 0 });
    expect(r1.status).toBe(200);
    const c2 = bookingRow(id).cancel_claim_id;
    expect(typeof c2).toBe('string');
    expect(c2).not.toBe(c1);
    const r2 = await selfPost(`/api/liff/booking/${id}/cancel`, { lock_version: 0 });
    expect(r2.status).toBe(200);
    const c3 = bookingRow(id).cancel_claim_id;
    expect(c3).not.toBe(c2);
    expect(bookingRow(id).status).toBe('cancelled');
  });

  test('同じ予定IDの古い版の補償は勝者の相談を消さない（版所有）', async () => {
    const { registerMeetConsultation, cancelMeetConsultation } = await import(
      '../services/meet-consultation-reminders.js'
    );
    mockSlots([D11, D12, D13]);
    const id = await adminCreate('menu-ok', T1, 'meet-versioned');
    const evt = 'evt-versioned';
    const base = {
      externalEventId: evt,
      friendId: 'friend-self',
      title: '個別相談',
      meetUrl: 'https://meet.google.com/aaa-bbbb-ccc',
    };
    // 旧版の登録 (版0・旧日時)。
    const r1 = await registerMeetConsultation(db, {
      ...base,
      startsAt: T1,
      endsAt: '2026-11-02T16:00:00.000Z',
      bookingId: id,
      bookingVersion: 0,
    });
    expect(r1.updated).toBe(true);
    // 勝者の登録 (同event・新版・新日時で上書き)。
    const r2 = await registerMeetConsultation(db, {
      ...base,
      startsAt: T2,
      endsAt: T3,
      bookingId: id,
      bookingVersion: 1,
    });
    expect(r2.updated).toBe(true);
    // 古い敗者の補償再開 → 版不一致で何も変えず false。
    const stale = await cancelMeetConsultation(db, evt, new Date(), {
      expectedBookingId: id,
      expectedBookingVersion: 0,
    });
    expect(stale).toBe(false);
    // 勝者の相談・最新日時・pending2が維持され、古い通知は送られない。
    const row = sqlite.prepare(
      'SELECT * FROM meet_consultations WHERE external_event_id = ?',
    ).get(evt) as Record<string, unknown>;
    expect(row.status).toBe('confirmed');
    expect(row.starts_at).toBe(T2);
    expect(row.booking_version).toBe(1);
    const pending = sqlite.prepare(
      `SELECT kind, scheduled_at, status FROM meet_consultation_notification_runs
        WHERE consultation_id = ? AND status IN ('pending','failed') ORDER BY kind`,
    ).all(row.id) as Array<{ kind: string; scheduled_at: string; status: string }>;
    expect(pending).toEqual([
      { kind: 'day_before', scheduled_at: '2026-11-01T16:00:00.000Z', status: 'pending' },
      { kind: 'hour_before', scheduled_at: '2026-11-02T15:00:00.000Z', status: 'pending' },
    ]);
    // 古い版の再登録も跳ねられ、勝者の行に触らない。
    const r3 = await registerMeetConsultation(db, {
      ...base,
      startsAt: T1,
      endsAt: '2026-11-02T16:00:00.000Z',
      bookingId: id,
      bookingVersion: 0,
    });
    expect(r3.updated).toBe(false);
    const kept = sqlite.prepare(
      'SELECT starts_at, booking_version FROM meet_consultations WHERE external_event_id = ?',
    ).get(evt) as { starts_at: string; booking_version: number };
    expect(kept.starts_at).toBe(T2);
    expect(kept.booking_version).toBe(1);
    // 正しい版の取消は通り、正当な補償は壊さない。
    const ok = await cancelMeetConsultation(db, evt, new Date(), {
      expectedBookingId: id,
      expectedBookingVersion: 1,
    });
    expect(ok).toBe(true);
    const gone = sqlite.prepare(
      'SELECT status FROM meet_consultations WHERE external_event_id = ?',
    ).get(evt) as { status: string };
    expect(gone.status).toBe('cancelled');
  });

  test('登録後に勝者が確定したら補償は正当な行だけ消す', async () => {
    // A→B→C の3段交差。B を register 直後・post-check 直前で止め、
    // C を完走させてから B を解放する有限barrier。B の補償は自分の版の
    // 行だけを消し (C が旧扱いで止めずみでも冪等に通る)、C の勝者は残す。
    const T4 = '2026-11-02T18:00:00.000Z';
    mockSlots([
      D11, D12, D13,
      { iso: T4, date: '2026-11-02', start: '13:00', end: '14:00' },
    ]);
    // 回転あり (実runner+接続)。接続は予約作成より先に置く (作成時に写すため)。
    linkCalendar();
    useRealGoogleRunner();
    const id = await adminCreate('menu-ok', T1, 'race-comp-legit');
    linkMeet(id);
    // A: T1→T2 を完走し、evtA の相談を版1で登録する。
    const aRes = await selfPost(`/api/liff/booking/${id}/reschedule`, {
      starts_at: T2, lock_version: 0,
    });
    expect(aRes.status).toBe(200);
    expect((await aRes.json<Record<string, unknown>>()).meet_sync).toBe('recreated');
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('race timeout')), 15000);
    });
    // B: T2→T3。register 直後 (post-check 前) で C (T3→T4) を完走させる。
    meetGate.afterHook = async () => {
      meetGate.afterHook = null;
      const cRes = await selfPost(`/api/liff/booking/${id}/reschedule`, {
        starts_at: T4, lock_version: 2,
      });
      expect(cRes.status).toBe(200);
    };
    const res = await Promise.race([
      selfPost(`/api/liff/booking/${id}/reschedule`, { starts_at: T3, lock_version: 1 }),
      timeout,
    ]);
    expect(res.status).toBe(200);
    // B は敗者だが、補償は自分の版の行だけを消し、C の勝者は残す。
    expect((await res.json<Record<string, unknown>>()).meet_sync).toBe('superseded');
    expect(bookingRow(id).status).toBe('confirmed');
    expect(bookingRow(id).starts_at).toBe(T4);
    // C の勝者の相談が confirmed・最新日時・pending2 で残る。
    const winnerEvt = bookingRow(id).external_event_id as string;
    const winner = sqlite.prepare(
      'SELECT * FROM meet_consultations WHERE external_event_id = ?',
    ).get(winnerEvt) as Record<string, unknown>;
    expect(winner.status).toBe('confirmed');
    expect(winner.starts_at).toBe(T4);
    expect(winner.booking_version).toBe(3);
    const pending = sqlite.prepare(
      `SELECT COUNT(*) AS n FROM meet_consultation_notification_runs
        WHERE consultation_id = ? AND status IN ('pending','failed')`,
    ).get(winner.id) as { n: number };
    expect(pending.n).toBe(2);
    // B の旧event・A の旧相談・最初の旧相談はすべて止まる。
    const olds = sqlite.prepare(
      `SELECT status FROM meet_consultations WHERE external_event_id != ?`,
    ).all(winnerEvt) as Array<{ status: string }>;
    expect(olds.length).toBe(3);
    expect(olds.every((c) => c.status === 'cancelled')).toBe(true);
    await drainWaits();
  });

  test('両者null読取の競合でも敗者は子操作へ進まない', async () => {
    const { registerMeetConsultation } = await import(
      '../services/meet-consultation-reminders.js'
    );
    // 勝者が行だけ先に書いた状態 (子pass未実施の交差)。敗者の既存確認は
    // null を見るよう DB 呼出しを絞り、upsert の競合だけを実DBで起こす。
    sqlite.prepare(
      `INSERT INTO meet_consultations
         (id, external_event_id, friend_id, title, starts_at, ends_at, meet_url,
          status, booking_id, booking_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?)`,
    ).run(
      'consult-w', 'evt-race', 'friend-self', '個別相談',
      T2, T3, 'https://meet.google.com/aaa-bbbb-ccc', 'bk-race', 2,
    );
    const frBefore = (
      sqlite.prepare('SELECT COUNT(*) AS n FROM friend_reminders').get() as { n: number }
    ).n;
    const riggedDb = {
      ...(db as unknown as Record<string, unknown>),
      prepare: (sql: string) =>
        sql.includes('FROM meet_consultations WHERE external_event_id = ?')
          ? {
              bind: () => ({
                first: async () => null,
                all: async () => ({ results: [] }),
                run: async () => ({ success: true, meta: { changes: 0 } }),
                raw: async () => [],
              }),
            }
          : (db as unknown as { prepare: (sql: string) => unknown }).prepare(sql),
    } as unknown as D1Database;
    const r = await registerMeetConsultation(riggedDb, {
      externalEventId: 'evt-race',
      friendId: 'friend-self',
      title: '個別相談',
      startsAt: T1,
      endsAt: '2026-11-02T16:00:00.000Z',
      meetUrl: 'https://meet.google.com/aaa-bbbb-ccc',
      bookingId: 'bk-race',
      bookingVersion: 1,
    });
    // upsert 0 件で敗者確定。子も も書かない。
    expect(r.updated).toBe(false);
    const kept = sqlite.prepare(
      'SELECT starts_at, booking_version, status FROM meet_consultations WHERE external_event_id = ?',
    ).get('evt-race') as { starts_at: string; booking_version: number; status: string };
    expect(kept).toEqual({ starts_at: T2, booking_version: 2, status: 'confirmed' });
    const children = sqlite.prepare(
      'SELECT COUNT(*) AS n FROM meet_consultation_notification_runs WHERE consultation_id = ?',
    ).get('consult-w') as { n: number };
    expect(children.n).toBe(0);
    const frAfter = (
      sqlite.prepare('SELECT COUNT(*) AS n FROM friend_reminders').get() as { n: number }
    ).n;
    expect(frAfter).toBe(frBefore);
  });

  test('linked相談の送信は版・日時・状態が一致するときだけ通す', async () => {
    const { registerMeetConsultation, processDueMeetConsultationReminders } = await import(
      '../services/meet-consultation-reminders.js'
    );
    const MEET = 'https://meet.google.com/aaa-bbbb-ccc';
    const dueAt = '2026-10-20T11:00:00.000Z';
    const dueify = (evt: string) => {
      sqlite.prepare(
        `UPDATE meet_consultation_notification_runs SET scheduled_at = ?
          WHERE consultation_id = (SELECT id FROM meet_consultations WHERE external_event_id = ?)`,
      ).run(dueAt, evt);
    };
    // 正当: 版・日時・状態が一致する linked 相談は送られる。
    const liveId = await adminCreate('menu-ok', T2, 'due-linked-live');
    sqlite.prepare('UPDATE bookings SET external_event_id = ? WHERE id = ?')
      .run('evt-linked-live', liveId);
    await registerMeetConsultation(db, {
      externalEventId: 'evt-linked-live', friendId: 'friend-self', title: '個別相談',
      startsAt: T2, endsAt: T3, meetUrl: MEET, bookingId: liveId, bookingVersion: 0,
    });
    dueify('evt-linked-live');
    // 拒否: 予約が版1・新日時に進み、相談が版0・旧日時のまま。claim後の
    // 古い送信内容を新日時へ再利用しない。(作成は別枠T1で重複を避ける)
    const staleId = await adminCreate('menu-ok', T1, 'due-linked-stale');
    sqlite.prepare('UPDATE bookings SET external_event_id = ? WHERE id = ?')
      .run('evt-linked-stale', staleId);
    await registerMeetConsultation(db, {
      externalEventId: 'evt-linked-stale', friendId: 'friend-self', title: '個別相談',
      startsAt: T1, endsAt: T2, meetUrl: MEET, bookingId: staleId, bookingVersion: 0,
    });
    sqlite.prepare('UPDATE bookings SET lock_version = 1, starts_at = ? WHERE id = ?')
      .run(T3, staleId);
    dueify('evt-linked-stale');
    // 互換: 版なし旧相談は従来どおり送られる。
    sqlite.prepare(
      `INSERT INTO meet_consultations
         (id, external_event_id, friend_id, title, starts_at, ends_at, meet_url, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'confirmed')`,
    ).run(
      'consult-legacy', 'evt-legacy', 'friend-other', '旧相談',
      '2026-10-21T00:00:00.000Z', '2026-10-21T01:00:00.000Z', MEET,
    );
    sqlite.prepare(
      `INSERT INTO meet_consultation_notification_runs
         (id, consultation_id, kind, scheduled_at, status)
       VALUES (?, ?, ?, ?, 'pending')`,
    ).run('mr-legacy', 'consult-legacy', 'hour_before', dueAt);
    const sent: Request[] = [];
    const dispatch = vi.fn(async (request: Request) => {
      sent.push(request);
      return new Response('{}', { status: 200 });
    });
    const result = await processDueMeetConsultationReminders(db, {
      now: new Date('2026-10-20T12:00:00.000Z'),
      proxyBaseUrl: 'https://proxy.example.com',
      proxyDispatch: dispatch,
    });
    // 正当な linked 2通 (両reminder)＋互換 1通。古い版は送らない。
    expect(result.sent).toBe(3);
    expect(dispatch).toHaveBeenCalledTimes(3);
    const recipients = await Promise.all(
      sent.map(async (request) => ((await request.json()) as { to: string }).to),
    );
    expect(recipients.sort()).toEqual(['U-other-1', 'U-self-1', 'U-self-1']);
    expect(sent[0].headers.get('x-line-harness-source')).toBeNull();
    // 古い版の通知は送られず pending のまま残る。
    const stalePending = sqlite.prepare(
      `SELECT COUNT(*) AS n FROM meet_consultation_notification_runs
        WHERE consultation_id = (SELECT id FROM meet_consultations WHERE external_event_id = ?)
          AND status IN ('pending','failed')`,
    ).get('evt-linked-stale') as { n: number };
    expect(stalePending.n).toBe(2);
  });

  test('貸出中の取消は409で何も変えず、送信後に再試行で取消せる', async () => {
    mockSlots([D11]);
    const id = await adminCreate('menu-ok', T1, 'cx-lease-restore');
    sqlite.prepare("INSERT INTO booking_groups(id,line_account_id,friend_id,version,created_at,idempotency_key,request_json) VALUES('liff-group','account-ny','friend-self',1,'now','liff-group','{}')").run();
    sqlite.prepare("UPDATE bookings SET group_id='liff-group' WHERE id=?").run(id);
    const decidedBefore = bookingRow(id).decided_at;
    sqlite.exec(`
      INSERT INTO reminders
        (id, name, line_account_id, is_active, trigger_type, delivery_mode, lifecycle_status)
      VALUES ('rb-booking','予約','account-ny',1,'booking','countdown','published');
      INSERT INTO friend_reminders
        (id, friend_id, reminder_id, target_date, status, source_kind, source_id, source_event_id)
      VALUES ('FR-bk','friend-self','rb-booking','2026-11-02','active','booking','${id}','${id}');
      INSERT INTO reminder_delivery_runs (
        id, line_account_id, reminder_id, friend_reminder_id, friend_id,
        reminder_step_id, scheduled_at, idempotency_key, line_retry_key,
        status, lease_expires_at, created_at, updated_at
      ) VALUES (
        'RUN-bk','account-ny','rb-booking','FR-bk','friend-self',
        'rb-step','2026-11-02T14:00:00.000Z','idem-bk','retry-bk',
        'claimed','2099-01-01T00:00:00.000Z','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z'
      );
    `);
    // 貸出中は確定させず 409。予約は確定前に戻り、主張も残らない。
    const res = await selfPost(`/api/liff/booking/${id}/cancel`, { lock_version: 0 });
    expect(res.status).toBe(409);
    expect((await res.json<Record<string, unknown>>()).error).toBe('send_in_flight_retry');
    expect(bookingRow(id).status).toBe('confirmed');
    expect(bookingRow(id).decided_at).toBe(decidedBefore);
    expect(bookingRow(id).cancel_claim_id).toBeNull();
    expect(sqlite.prepare("SELECT version FROM booking_groups WHERE id='liff-group'").get()).toEqual({ version: 2 });
    const active = sqlite.prepare(
      "SELECT status FROM friend_reminders WHERE id = 'FR-bk'",
    ).get() as { status: string };
    expect(active.status).toBe('active');
    // 送信が終われば再試行で取消せる (失敗truthを隠さない)。
    sqlite.prepare(
      "UPDATE reminder_delivery_runs SET status = 'succeeded', lease_expires_at = NULL WHERE id = 'RUN-bk'",
    ).run();
    const retry = await selfPost(`/api/liff/booking/${id}/cancel`, { lock_version: 0 });
    expect(retry.status).toBe(200);
    expect(bookingRow(id).status).toBe('cancelled');
    await drainWaits();
  });

  test('同版の別操作が先に取消完了しても古いrollbackは戻さない', async () => {
    const { cancelMeetConsultation } = await import(
      '../services/meet-consultation-reminders.js'
    );
    const evt = 'evt-ab-fwd';
    const frozenNow = new Date();
    sqlite.prepare(
      `INSERT INTO meet_consultations
         (id, external_event_id, friend_id, title, starts_at, ends_at, meet_url,
          status, booking_id, booking_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?)`,
    ).run(
      'consult-ab', evt, 'friend-self', '個別相談',
      T1, '2026-11-02T16:00:00.000Z', 'https://meet.google.com/aaa-bbbb-ccc',
      'bk-ab', 5,
    );
    sqlite.prepare(
      `INSERT INTO meet_consultation_notification_runs
         (id, consultation_id, kind, scheduled_at, status)
       VALUES (?, ?, ?, ?, 'pending'), (?, ?, ?, ?, 'pending')`,
    ).run(
      'mr-ab-day', 'consult-ab', 'day_before', '2026-11-01T14:00:00.000Z',
      'mr-ab-hour', 'consult-ab', 'hour_before', '2026-11-02T14:00:00.000Z',
    );
    // A を の直前で止める有限barrier。時刻は Frozen のまま進めない。
    let entered = false;
    let gateResolve: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { gateResolve = resolve; });
    let calls = 0;
    triggerMocks.cancelByTrigger.mockImplementation(async (...args: unknown[]) => {
      calls += 1;
      if (calls === 1) {
        entered = true;
        await gate;
      }
      return (triggerState.real as (...a: unknown[]) => Promise<unknown>)(...args);
    });
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('race timeout')), 15000);
    });
    // failOnSendInFlight は製品の全呼出しが true のため barrier も true にそろえる。
    const fenceOpts = {
      expectedBookingId: 'bk-ab',
      expectedBookingVersion: 5,
      failOnSendInFlight: true as const,
    };
    const aPromise = cancelMeetConsultation(db, evt, frozenNow, fenceOpts);
    for (let i = 0; i < 200; i++) {
      if (entered) break;
      await new Promise((r) => setTimeout(r, 10));
      if (i === 199) throw new Error('V6 に到達しませんでした');
    }
    // B が同版で先に取消完了する (操作 uuid_B)。
    const bOk = await Promise.race([
      cancelMeetConsultation(db, evt, frozenNow, fenceOpts),
      timeout,
    ]);
    expect(bOk).toBe(true);
    const uuidB = (
      sqlite.prepare('SELECT cancel_claim_id FROM meet_consultations WHERE id = ?').get('consult-ab') as { cancel_claim_id: string }
    ).cancel_claim_id;
    expect(typeof uuidB).toBe('string');
    // A の で貸出が来たら A は 409。復元は uuid_B に阻まれる。
    // (rule を先に置く。FK のため)
    sqlite.prepare(
      `INSERT INTO reminders
         (id, name, line_account_id, is_active, trigger_type, delivery_mode, lifecycle_status)
       VALUES ('rb-rule','予約','account-ny',1,'booking','countdown','published')`,
    ).run();
    sqlite.prepare(
      `INSERT INTO friend_reminders
         (id, friend_id, reminder_id, target_date, status, source_kind, source_id, source_event_id)
       VALUES ('FR-ab','friend-self','rb-rule','2026-11-02','active','meet','consult-ab',?)`,
    ).run(evt);
    sqlite.prepare(
      `INSERT INTO reminder_delivery_runs (
        id, line_account_id, reminder_id, friend_reminder_id, friend_id,
        reminder_step_id, scheduled_at, idempotency_key, line_retry_key,
        status, lease_expires_at, created_at, updated_at
      ) VALUES (
        'RUN-ab','account-ny','rb-rule','FR-ab','friend-self',
        'rb-step','2026-11-02T14:00:00.000Z','idem-ab','retry-ab',
        'claimed','2099-01-01T00:00:00.000Z','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z'
      )`,
    ).run();
    gateResolve();
    await expect(Promise.race([aPromise, timeout])).rejects.toThrow('REMINDER_SEND_IN_FLIGHT');
    // B の cancelled が残り、uuid_B が維持される。子も止まったまま。
    const finalRow = sqlite.prepare(
      'SELECT status, cancel_claim_id FROM meet_consultations WHERE id = ?',
    ).get('consult-ab') as { status: string; cancel_claim_id: string };
    expect(finalRow.status).toBe('cancelled');
    expect(finalRow.cancel_claim_id).toBe(uuidB);
    const pending = sqlite.prepare(
      "SELECT COUNT(*) AS n FROM meet_consultation_notification_runs WHERE consultation_id = ? AND status IN ('pending','failed')",
    ).get('consult-ab') as { n: number };
    expect(pending.n).toBe(0);
  });

  test('同版の逆順でも先行の復元は後発を戻さない', async () => {
    const { cancelMeetConsultation } = await import(
      '../services/meet-consultation-reminders.js'
    );
    const evt = 'evt-ab-rev';
    const frozenNow = new Date();
    sqlite.prepare(
      `INSERT INTO meet_consultations
         (id, external_event_id, friend_id, title, starts_at, ends_at, meet_url,
          status, booking_id, booking_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?)`,
    ).run(
      'consult-ab-rev', evt, 'friend-self', '個別相談',
      T1, '2026-11-02T16:00:00.000Z', 'https://meet.google.com/aaa-bbbb-ccc',
      'bk-ab', 5,
    );
    // B (先行claim側) を 直前で止める。
    let entered = false;
    let gateResolve: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { gateResolve = resolve; });
    let calls = 0;
    triggerMocks.cancelByTrigger.mockImplementation(async (...args: unknown[]) => {
      calls += 1;
      if (calls === 1) {
        entered = true;
        await gate;
      }
      return (triggerState.real as (...a: unknown[]) => Promise<unknown>)(...args);
    });
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('race timeout')), 15000);
    });
    const bPromise = cancelMeetConsultation(db, evt, frozenNow, {
      expectedBookingId: 'bk-ab',
      expectedBookingVersion: 5,
    });
    for (let i = 0; i < 200; i++) {
      if (entered) break;
      await new Promise((r) => setTimeout(r, 10));
      if (i === 199) throw new Error('V6 に到達しませんでした');
    }
    // A (後発) が同版で上書き claim して取消完了する。
    const aOk = await Promise.race([
      cancelMeetConsultation(db, evt, frozenNow, {
        expectedBookingId: 'bk-ab',
        expectedBookingVersion: 5,
      }),
      timeout,
    ]);
    expect(aOk).toBe(true);
    const uuidA = (
      sqlite.prepare('SELECT cancel_claim_id FROM meet_consultations WHERE id = ?').get('consult-ab-rev') as { cancel_claim_id: string }
    ).cancel_claim_id;
    gateResolve();
    // B は前確認ずみの が空振りし、復元も uuid_A に阻まれて false。
    // (に貸出なし・行は A のもののため、投げずに戻す)
    const bOk = await Promise.race([bPromise, timeout]);
    expect(bOk).toBe(false);
    const finalRow = sqlite.prepare(
      'SELECT status, cancel_claim_id FROM meet_consultations WHERE id = ?',
    ).get('consult-ab-rev') as { status: string; cancel_claim_id: string };
    expect(finalRow.status).toBe('cancelled');
    expect(finalRow.cancel_claim_id).toBe(uuidA);
  });

  test('due読取後の版更新はpush前に止まり、独立予約に干渉しない', async () => {
    const { registerMeetConsultation, processDueMeetConsultationReminders } = await import(
      '../services/meet-consultation-reminders.js'
    );
    const MEET = 'https://meet.google.com/aaa-bbbb-ccc';
    const dueify = (evt: string, at: string) => {
      sqlite.prepare(
        `UPDATE meet_consultation_notification_runs SET scheduled_at = ?
          WHERE consultation_id = (SELECT id FROM meet_consultations WHERE external_event_id = ?)`,
      ).run(at, evt);
    };
    // R1 (本人) と R2 (他人) の live linked 相談を1通ずつ due にする。
    // R2 の作成は離れた枠 (13時) で重複409を避ける。
    // 空きmockは継承せず、この試験で使う2枠を明示する (mockは試験間で残る)。
    const R2_START = '2026-11-02T13:00:00.000Z';
    const R2_END = '2026-11-02T14:00:00.000Z';
    mockSlots([D12, { iso: R2_START, date: '2026-11-02', start: '08:00', end: '09:00' }]);
    const r1 = await adminCreate('menu-ok', T2, 'due-push-r1');
    sqlite.prepare('UPDATE bookings SET external_event_id = ? WHERE id = ?')
      .run('evt-push-r1', r1);
    await registerMeetConsultation(db, {
      externalEventId: 'evt-push-r1', friendId: 'friend-self', title: '個別相談',
      startsAt: T2, endsAt: T3, meetUrl: MEET, bookingId: r1, bookingVersion: 0,
    });
    dueify('evt-push-r1', '2026-10-20T10:00:00.000Z');
    const r2 = await adminCreate('menu-ok', R2_START, 'due-push-r2');
    sqlite.prepare('UPDATE bookings SET external_event_id = ? WHERE id = ?')
      .run('evt-push-r2', r2);
    // R2 は他人名義にして独立性を確かめる (別予約・別友だち)。
    sqlite.prepare('UPDATE bookings SET friend_id = ? WHERE id = ?').run('friend-other', r2);
    await registerMeetConsultation(db, {
      externalEventId: 'evt-push-r2', friendId: 'friend-other', title: '個別相談',
      startsAt: R2_START, endsAt: R2_END, meetUrl: MEET,
      bookingId: r2, bookingVersion: 0,
    });
    dueify('evt-push-r2', '2026-10-20T11:00:00.000Z');
    const sent: Request[] = [];
    let firstDispatchDone = false;
    const dispatch = vi.fn(async (request: Request) => {
      sent.push(request);
      if (!firstDispatchDone) {
        firstDispatchDone = true;
        // R1 の push 直後に R2 の予約が新版・新日時に進む (due読取後の更新)。
        sqlite.prepare('UPDATE bookings SET lock_version = 1, starts_at = ? WHERE id = ?')
          .run(T1, r2);
      }
      return new Response('{}', { status: 200 });
    });
    const run1 = await processDueMeetConsultationReminders(db, {
      now: new Date('2026-10-20T12:00:00.000Z'),
      proxyBaseUrl: 'https://proxy.example.com',
      proxyDispatch: dispatch,
    });
    // R1 は正常に送られ (両reminder)、R2 の旧本文は 0 通。R1 の行に干渉はない。
    expect(run1.sent).toBe(2);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(((await sent[0].json()) as { to: string }).to).toBe('U-self-1');
    expect(((await sent[1].json()) as { to: string }).to).toBe('U-self-1');
    const r1sent = sqlite.prepare(
      `SELECT status FROM meet_consultation_notification_runs
        WHERE consultation_id = (SELECT id FROM meet_consultations WHERE external_event_id = ?)`,
    ).all('evt-push-r1') as Array<{ status: string }>;
    expect(r1sent.every((r) => r.status === 'sent')).toBe(true);
    // R2 の旧通知は送られず、取消として整理される (旧本文の送信0)。
    const r2all = sqlite.prepare(
      `SELECT status FROM meet_consultation_notification_runs
        WHERE consultation_id = (SELECT id FROM meet_consultations WHERE external_event_id = ?)`,
    ).all('evt-push-r2') as Array<{ status: string }>;
    expect(r2all.every((r) => r.status === 'cancelled')).toBe(true);
    // 新版の通知は保持される: 勝者が登録し直せば新日時で送られる。
    await registerMeetConsultation(db, {
      externalEventId: 'evt-push-r2', friendId: 'friend-other', title: '個別相談',
      startsAt: T1, endsAt: T2, meetUrl: MEET, bookingId: r2, bookingVersion: 1,
    });
    dueify('evt-push-r2', '2026-10-20T11:30:00.000Z');
    const sent2: Request[] = [];
    const run2 = await processDueMeetConsultationReminders(db, {
      now: new Date('2026-10-20T12:00:00.000Z'),
      proxyBaseUrl: 'https://proxy.example.com',
      proxyDispatch: vi.fn(async (request: Request) => {
        sent2.push(request);
        return new Response('{}', { status: 200 });
      }),
    });
    // 新版の両reminderが新日時で送られる。
    expect(run2.sent).toBe(2);
    expect(((await sent2[0].json()) as { to: string }).to).toBe('U-other-1');
    expect(((await sent2[1].json()) as { to: string }).to).toBe('U-other-1');
  });

  test('実再登録で両新版へ進むと旧sent確定は新版子を壊さない', async () => {
    const { registerMeetConsultation, processDueMeetConsultationReminders } = await import(
      '../services/meet-consultation-reminders.js'
    );
    const MEET = 'https://meet.google.com/aaa-bbbb-ccc';
    const T4 = '2026-11-02T18:00:00.000Z';
    mockSlots([D12]);
    const r3 = await adminCreate('menu-ok', T2, 'due-push-both');
    sqlite.prepare('UPDATE bookings SET external_event_id = ? WHERE id = ?')
      .run('evt-push-both', r3);
    await registerMeetConsultation(db, {
      externalEventId: 'evt-push-both', friendId: 'friend-self', title: '個別相談',
      startsAt: T2, endsAt: T3, meetUrl: MEET, bookingId: r3, bookingVersion: 0,
    });
    sqlite.prepare(
      `UPDATE meet_consultation_notification_runs SET scheduled_at = ?
        WHERE consultation_id = (SELECT id FROM meet_consultations WHERE external_event_id = ?)`,
    ).run('2026-10-20T10:00:00.000Z', 'evt-push-both');
    const before = sqlite.prepare(
      `SELECT id, kind FROM meet_consultation_notification_runs
        WHERE consultation_id = (SELECT id FROM meet_consultations WHERE external_event_id = ?)`,
    ).all('evt-push-both') as Array<{ id: string; kind: string }>;
    expect(before).toHaveLength(2);
    const sent: Request[] = [];
    // 最初の push の最中に実再登録で同eventが新版＋新日時へ進む。
    // 再登録は子の行IDを新版へ再利用するため、旧sent確定が新版子に
    // 当たらないことが候補写し結合の証明になる。
    const dispatch = vi.fn(async (request: Request) => {
      sent.push(request);
      sqlite.prepare('UPDATE bookings SET lock_version = 1, starts_at = ? WHERE id = ?')
        .run(T3, r3);
      const renewed = await registerMeetConsultation(db, {
        externalEventId: 'evt-push-both', friendId: 'friend-self', title: '個別相談',
        startsAt: T3, endsAt: T4, meetUrl: MEET, bookingId: r3, bookingVersion: 1,
      });
      expect(renewed.updated).toBe(true);
      return new Response('{}', { status: 200 });
    });
    const run = await processDueMeetConsultationReminders(db, {
      now: new Date('2026-10-20T12:00:00.000Z'),
      proxyBaseUrl: 'https://proxy.example.com',
      proxyDispatch: dispatch,
    });
    // 更新前に送った1通だけが残り、更新後の旧候補は送らない。
    expect(run.sent).toBe(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(((await sent[0].json()) as { to: string }).to).toBe('U-self-1');
    // 旧sent確定は新版へ再利用ずみの行に当たらず、子ID・新日時・pendingが不変。
    const after = sqlite.prepare(
      `SELECT id, kind, status, scheduled_at FROM meet_consultation_notification_runs
        WHERE consultation_id = (SELECT id FROM meet_consultations WHERE external_event_id = ?) AND schedule_revision=(SELECT schedule_revision FROM meet_consultations WHERE id=consultation_id)
        ORDER BY kind`,
    ).all('evt-push-both') as Array<{ id: string; kind: string; status: string; scheduled_at: string }>;
    expect(after).toHaveLength(2);
    expect(after.every(r=>!before.some(old=>old.id===r.id))).toBe(true);
    expect(sqlite.prepare('SELECT COUNT(*) n FROM meet_consultation_notification_runs WHERE id IN(?,?)').get(before[0].id,before[1].id)).toEqual({n:2});
    expect(after).toEqual([
      { id: after[0].id, kind: 'day_before', status: 'pending', scheduled_at: '2026-11-01T17:00:00.000Z' },
      { id: after[1].id, kind: 'hour_before', status: 'pending', scheduled_at: '2026-11-02T16:00:00.000Z' },
    ]);
    const consult = sqlite.prepare(
      'SELECT booking_version, starts_at, status FROM meet_consultations WHERE external_event_id = ?',
    ).get('evt-push-both') as { booking_version: number; starts_at: string; status: string };
    expect(consult).toEqual({ booking_version: 1, starts_at: T3, status: 'confirmed' });
  });

  test('実再登録で両新版へ進むと旧failed確定も新版子を壊さない', async () => {
    const { registerMeetConsultation, processDueMeetConsultationReminders } = await import(
      '../services/meet-consultation-reminders.js'
    );
    const MEET = 'https://meet.google.com/aaa-bbbb-ccc';
    const T4 = '2026-11-02T18:00:00.000Z';
    mockSlots([D12]);
    const r4 = await adminCreate('menu-ok', T2, 'due-push-both-fail');
    sqlite.prepare('UPDATE bookings SET external_event_id = ? WHERE id = ?')
      .run('evt-push-both-fail', r4);
    await registerMeetConsultation(db, {
      externalEventId: 'evt-push-both-fail', friendId: 'friend-self', title: '個別相談',
      startsAt: T2, endsAt: T3, meetUrl: MEET, bookingId: r4, bookingVersion: 0,
    });
    sqlite.prepare(
      `UPDATE meet_consultation_notification_runs SET scheduled_at = ?
        WHERE consultation_id = (SELECT id FROM meet_consultations WHERE external_event_id = ?)`,
    ).run('2026-10-20T10:00:00.000Z', 'evt-push-both-fail');
    const before = sqlite.prepare(
      `SELECT id FROM meet_consultation_notification_runs
        WHERE consultation_id = (SELECT id FROM meet_consultations WHERE external_event_id = ?)`,
    ).all('evt-push-both-fail') as Array<{ id: string }>;
    // push が落ちる前に実再登録で新版へ進める。旧catchのfailed確定は
    // 新版へ再利用ずみの行に当たらず、勝者の pending を残す。
    const dispatch = vi.fn(async () => {
      sqlite.prepare('UPDATE bookings SET lock_version = 1, starts_at = ? WHERE id = ?')
        .run(T3, r4);
      const renewed = await registerMeetConsultation(db, {
        externalEventId: 'evt-push-both-fail', friendId: 'friend-self', title: '個別相談',
        startsAt: T3, endsAt: T4, meetUrl: MEET, bookingId: r4, bookingVersion: 1,
      });
      expect(renewed.updated).toBe(true);
      throw new Error('proxy down');
    });
    const run = await processDueMeetConsultationReminders(db, {
      now: new Date('2026-10-20T12:00:00.000Z'),
      proxyBaseUrl: 'https://proxy.example.com',
      proxyDispatch: dispatch,
    });
    expect(run.sent).toBe(0);
    expect(run.failed).toBe(1);
    const after = sqlite.prepare(
      `SELECT id, kind, status, scheduled_at, retry_count FROM meet_consultation_notification_runs
        WHERE consultation_id = (SELECT id FROM meet_consultations WHERE external_event_id = ?) AND schedule_revision=(SELECT schedule_revision FROM meet_consultations WHERE id=consultation_id)
        ORDER BY kind`,
    ).all('evt-push-both-fail') as Array<{ id: string; kind: string; status: string; scheduled_at: string; retry_count: number }>;
    // 旧dueの2行のうち、落ちた行は新版pendingのまま (failedにしない)。
    // もう1行は旧候補のまま整理されるが、新版へ再利用ずみなら残る。
    expect(after).toHaveLength(2);
    expect(after.every(r=>!before.some(old=>old.id===r.id))).toBe(true);
    expect(sqlite.prepare('SELECT COUNT(*) n FROM meet_consultation_notification_runs WHERE id IN(?,?)').get(before[0].id,before[1].id)).toEqual({n:2});
    const failedRows = after.filter((r) => r.status === 'failed');
    expect(failedRows).toHaveLength(0);
    expect(after.every((r) => r.status === 'pending')).toBe(true);
    expect(after).toEqual([
      { id: after[0].id, kind: 'day_before', status: 'pending', scheduled_at: '2026-11-01T17:00:00.000Z', retry_count: 0 },
      { id: after[1].id, kind: 'hour_before', status: 'pending', scheduled_at: '2026-11-02T16:00:00.000Z', retry_count: 0 },
    ]);
  });

  test('旧確認→新版登録→旧共有呼出しは版ガードで止まる', async () => {
    const { registerMeetConsultation } = await import(
      '../services/meet-consultation-reminders.js'
    );
    const evt = 'evt-guard-v6';
    // rule を置く (enroll がwinnerの行を1件作る。offsetなし→target=開始時刻)。
    sqlite.exec(`
      INSERT INTO reminders
        (id, name, line_account_id, is_active, trigger_type, delivery_mode, lifecycle_status)
      VALUES ('rb-booking','予約','account-ny',1,'booking','countdown','published');
    `);
    // 旧操作を最初の共有呼出し (reconcile) の直前で止める。
    triggerGate.reconcileHook = async () => {
      triggerGate.reconcileHook = null;
      const winner = await registerMeetConsultation(db, {
        externalEventId: evt, friendId: 'friend-self', title: '個別相談',
        startsAt: T2, endsAt: T3, meetUrl: 'https://meet.google.com/aaa-bbbb-ccc',
        bookingId: 'bk-g', bookingVersion: 2,
      });
      expect(winner.updated).toBe(true);
    };
    const old = await registerMeetConsultation(db, {
      externalEventId: evt, friendId: 'friend-self', title: '個別相談',
      startsAt: T1, endsAt: '2026-11-02T16:00:00.000Z',
      meetUrl: 'https://meet.google.com/aaa-bbbb-ccc',
      bookingId: 'bk-g', bookingVersion: 1,
    });
    // 旧操作は共有呼出しを出さず stale。勝者の行・子・が残る。
    expect(old.updated).toBe(false);
    const row = sqlite.prepare(
      'SELECT starts_at, booking_version, status FROM meet_consultations WHERE external_event_id = ?',
    ).get(evt) as { starts_at: string; booking_version: number; status: string };
    expect(row).toEqual({ starts_at: T2, booking_version: 2, status: 'confirmed' });
    const cid = (
      sqlite.prepare('SELECT id FROM meet_consultations WHERE external_event_id = ?').get(evt) as { id: string }
    ).id;
    const children = sqlite.prepare(
      `SELECT kind, scheduled_at, status FROM meet_consultation_notification_runs
        WHERE consultation_id = ? AND schedule_revision=(SELECT schedule_revision FROM meet_consultations WHERE id=consultation_id) ORDER BY kind`,
    ).all(cid) as Array<{ kind: string; scheduled_at: string; status: string }>;
    expect(children).toEqual([
      { kind: 'day_before', scheduled_at: '2026-11-01T16:00:00.000Z', status: 'pending' },
      { kind: 'hour_before', scheduled_at: '2026-11-02T15:00:00.000Z', status: 'pending' },
    ]);
    const v6rows = sqlite.prepare(
      `SELECT target_date, status FROM friend_reminders
        WHERE source_kind = 'meet' AND source_id = ? AND status = 'active'`,
    ).all(cid) as Array<{ target_date: string; status: string }>;
    // 旧操作は何も残さず、勝者の 行だけが新日時に向く。
    expect(v6rows).toEqual([{ target_date: T2, status: 'active' }]);
  });

  test('補償の失敗は隠さず、取消再送で回収できる', async () => {
    mockSlots([D11, D12]);
    const id = await adminCreate('menu-ok', T1, 'race-comp-fail');
    linkMeet(id);
    // register 直前で取消を完走させ、直後の補償だけ失敗させる。
    meetGate.hook = async () => {
      meetGate.hook = null;
      const cancelRes = await selfPost(`/api/liff/booking/${id}/cancel`, { lock_version: 1 });
      expect(cancelRes.status).toBe(200);
      meetCtl.failCancelOnce = true;
    };
    const res = await selfPost(`/api/liff/booking/${id}/reschedule`, {
      starts_at: T2, lock_version: 0,
    });
    expect(res.status).toBe(200);
    expect((await res.json<Record<string, unknown>>()).meet_sync).toBe('failed');
    // 失敗は正直に残る（復活したまま）。監査に記録される。
    const consult = sqlite.prepare(
      'SELECT status FROM meet_consultations WHERE id = ?',
    ).get('consult-1') as { status: string };
    expect(consult.status).toBe('confirmed');
    const audit = sqlite.prepare(
      "SELECT COUNT(*) AS n FROM booking_audit_logs WHERE booking_id = ? AND action = 'meet_sync_failed'",
    ).get(id) as { n: number };
    expect(audit.n).toBe(1);
    // 取消再送が回収口になる。
    const retry = await selfPost(`/api/liff/booking/${id}/cancel`, { lock_version: 1 });
    expect(retry.status).toBe(200);
    const healed = sqlite.prepare(
      'SELECT status FROM meet_consultations WHERE id = ?',
    ).get('consult-1') as { status: string };
    expect(healed.status).toBe('cancelled');
    await drainWaits();
  });

  test('取消ずみ予約の相談はdue送信の対象外（可視フェンス＋spy send0）', async () => {
    const { processDueMeetConsultationReminders } = await import(
      '../services/meet-consultation-reminders.js'
    );
    mockSlots([D11, D12]);
    const deadId = await adminCreate('menu-ok', T1, 'due-dead');
    linkMeet(deadId, 'evt-dead');
    // 復活 window を再現：予約だけ取消ずみ、相談は confirmed のまま。
    sqlite.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").run(deadId);
    sqlite.prepare(
      `UPDATE meet_consultations SET starts_at = ?, ends_at = ? WHERE external_event_id = ?`,
    ).run('2026-10-21T00:00:00.000Z', '2026-10-21T01:00:00.000Z', 'evt-dead');
    sqlite.prepare(
      `UPDATE meet_consultation_notification_runs SET scheduled_at = ? WHERE consultation_id = ?`,
    ).run('2026-10-20T11:00:00.000Z', 'consult-1');
    // 対照：有効な予約の相談は送られる。
    const liveId = await adminCreate('menu-ok', T1, 'due-live');
    sqlite.prepare('UPDATE bookings SET external_event_id = ? WHERE id = ?').run('evt-live', liveId);
    sqlite.prepare(
      `INSERT INTO meet_consultations
         (id, external_event_id, friend_id, title, starts_at, ends_at, meet_url, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'confirmed')`,
    ).run(
      'consult-2', 'evt-live', 'friend-other', '対照相談',
      '2026-10-21T00:00:00.000Z', '2026-10-21T01:00:00.000Z', 'https://meet.google.com/aaa-bbbb-ccc',
    );
    sqlite.prepare(
      `INSERT INTO meet_consultation_notification_runs
         (id, consultation_id, kind, scheduled_at, status)
       VALUES (?, ?, ?, ?, 'pending')`,
    ).run('mr-live', 'consult-2', 'hour_before', '2026-10-20T11:00:00.000Z');
    const sent: Request[] = [];
    const dispatch = vi.fn(async (request: Request) => {
      sent.push(request);
      return new Response('{}', { status: 200 });
    });
    const result = await processDueMeetConsultationReminders(db, {
      now: new Date('2026-10-20T12:00:00.000Z'),
      proxyBaseUrl: 'https://proxy.example.com',
      proxyDispatch: dispatch,
    });
    expect(result.sent).toBe(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
    const body = await sent[0].json() as { to: string };
    expect(body.to).toBe('U-other-1');
    expect(sent[0].headers.get('x-line-harness-source')).toBeNull();
    // 取消ずみ側は送られず、pending のまま残る（回収は取消再送の役目）。
    const dead = sqlite.prepare(
      "SELECT COUNT(*) AS n FROM meet_consultation_notification_runs WHERE consultation_id = ? AND status IN ('pending','failed')",
    ).get('consult-1') as { n: number };
    expect(dead.n).toBe(2);
  });

  test('変更対取消の交差は片方だけ通り、敗者は副作用を残さない', async () => {
    mockSlots([D11, D12]);
    const id = await adminCreate('menu-ok', T1, 'race-1');
    linkMeet(id);
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('race timeout')), 15000);
    });
    const [a, b] = await Promise.race([
      Promise.all([
        selfPost(`/api/liff/booking/${id}/reschedule`, { starts_at: T2, lock_version: 0 }),
        selfPost(`/api/liff/booking/${id}/cancel`, { lock_version: 0 }),
      ]),
      timeout,
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    await drainWaits();
    const row = bookingRow(id);
    if (row.status === 'cancelled') {
      expect(row.starts_at).toBe(T1);
    } else {
      expect(row.starts_at).toBe(T2);
    }
    // Meet 相談は増えない。通知も最大1件。
    const consults = sqlite.prepare('SELECT COUNT(*) AS n FROM meet_consultations').get() as { n: number };
    expect(consults.n).toBe(1);
    const notices = sqlite.prepare(
      "SELECT COUNT(*) AS n FROM booking_operation_runs WHERE booking_id = ? AND kind = 'confirmation_line'",
    ).get(id) as { n: number };
    expect(notices.n).toBeLessThanOrEqual(1);
    expectNoManualHeader();
  });

  test('取消対取消再送の交差は確定を壊さず、カレンダー台帳は1行', async () => {
    mockSlots([D11]);
    const id = await adminCreate('menu-ok', T1, 'race-2');
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('race timeout')), 15000);
    });
    const [a, b] = await Promise.race([
      Promise.all([
        selfPost(`/api/liff/booking/${id}/cancel`, { lock_version: 0 }),
        selfPost(`/api/liff/booking/${id}/cancel`, { lock_version: 0 }),
      ]),
      timeout,
    ]);
    // 勝者は200。敗者は再送200か送信フェンス409。どちらも確定を壊さない。
    const sorted = [a.status, b.status].sort();
    expect([JSON.stringify([200, 200]), JSON.stringify([200, 409])]).toContain(JSON.stringify(sorted));
    for (const res of [a, b]) {
      if (res.status === 409) {
        // mockに貸出RUNが無い交差では敗者は version_conflict。実貸出がある
        // 製品経路では send_in_flight_retry になる。どちらも確定を壊さない。
        expect(['version_conflict', 'send_in_flight_retry']).toContain(
          (await res.json<{ error: string }>()).error,
        );
      }
    }
    const retry = await selfPost(`/api/liff/booking/${id}/cancel`, { lock_version: 0 });
    expect(retry.status).toBe(200);
    expect(bookingRow(id).status).toBe('cancelled');
    // 削除の安定キーは1行に集約される（作成時sync鍵と削除鍵の2鍵・各1行）。
    const calOps = sqlite.prepare(
      'SELECT idempotency_key, COUNT(*) AS n FROM booking_operation_runs WHERE booking_id = ? AND kind = ? GROUP BY idempotency_key',
    ).all(id, 'google_calendar') as Array<{ idempotency_key: string; n: number }>;
    expect(calOps.length).toBe(2);
    expect(calOps.every((op) => op.n === 1)).toBe(true);
  });
});
