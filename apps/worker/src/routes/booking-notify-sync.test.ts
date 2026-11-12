/**
 * 通知・Google 同期の同時実行と再試行で二重処理を防ぐ。booking-update-retry.test.ts と同じ実 bootstrap の隔離環境で検証する。
 */
import { Hono } from 'hono';
import { beforeEach, describe, expect, test, vi, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Env } from '../worker-env.js';

const availabilityMocks = vi.hoisted(() => ({
  computeSlots: vi.fn(() => [] as { start: string; end: string }[]),
  calls: [] as Array<Record<string, unknown>>,
  getAvailability: vi.fn(),
}));
vi.mock('../services/availability.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/availability.js')>();
  availabilityMocks.getAvailability = vi.fn(async (_db: unknown, params: {
    from: string;
    staffId?: string;
    excludeBookingId?: string;
  }) => {
    availabilityMocks.calls.push({ ...params });
    return {
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
    };
  });
  return { ...actual, getAvailability: availabilityMocks.getAvailability };
});

const notifierMocks = vi.hoisted(() => {
  const calls: Array<Record<string, unknown>> = [];
  const sendBookingNotification = vi.fn(async (params: Record<string, unknown>) => {
    calls.push(params);
  });
  return { calls, sendBookingNotification };
});
// 送る側だけ差し替える。文面の組み立て（notificationTiming・formatStartsAtForStore）は本物を使う。
vi.mock('../features/booking/booking-notifier.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../features/booking/booking-notifier.js')>()),
  ...notifierMocks,
}));

const accountAccessMocks = {
  canAccessAllLineAccounts: vi.fn(),
};
vi.mock('../services/account-access.js', () => accountAccessMocks);

const { default: booking } = await import('./booking.js');

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

function makeApp(db: D1Database) {
  const app = new Hono<Env>();
  app.use('*', async (c, next) => {
    c.set('staff', { id: 'owner-1', name: 'Owner', role: 'owner', readOnly: false });
    return next();
  });
  app.route('/', booking);
  return { app, env: { DB: db } };
}

const execCtx = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
} as unknown as ExecutionContext;

function futureStartsAt(days = 7, utcHour = 2): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  d.setUTCHours(utcHour, 0, 0, 0);
  return d.toISOString();
}

function seed(sqlite: Database.Database) {
  sqlite.exec(readFileSync(join(process.cwd(), '../../packages/db/bootstrap.sql'), 'utf8'));
  sqlite.exec(`
    INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
    VALUES ('acc1','channel-1','A店','token','secret');
    INSERT INTO staff (id, line_account_id, name, display_name)
    VALUES ('s1','acc1','担当A','担当A'),
           ('owner-1','acc1','Owner','Owner');
    INSERT INTO menus (
      id, line_account_id, name, duration_minutes, buffer_after_minutes,
      base_price, concurrent_capacity
    ) VALUES ('m1','acc1','相談',60,10,8000,1);
    INSERT INTO staff_menus (staff_id, menu_id, is_offered)
    VALUES ('s1','m1',1);
    INSERT INTO booking_settings (id, line_account_id, timezone)
    VALUES ('bs1','acc1','Asia/Tokyo');
    INSERT INTO friends (id, line_user_id, display_name, line_account_id, is_following, created_at, updated_at)
    VALUES ('f1','U1','花子','acc1',1,'2026-01-01T00:00:00.000','2026-01-01T00:00:00.000');
  `);
}

function insertBooking(
  sqlite: Database.Database,
  input: {
    id: string;
    friend?: string | null;
    status?: string;
    startsAt?: string;
    lockVersion?: number;
    policy?: string;
  },
) {
  const startsAt = input.startsAt ?? futureStartsAt();
  const ends = new Date(new Date(startsAt).getTime() + 60 * 60_000);
  const block = new Date(ends.getTime() + 10 * 60_000);
  sqlite.prepare(`
    INSERT INTO bookings (
      id, line_account_id, friend_id, booking_customer_id, staff_id, menu_id,
      starts_at, ends_at, block_ends_at, status, price_at_booking, requested_at,
      lock_version, notification_policy_snapshot, source
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    input.id, 'acc1', input.friend ?? null, null, 's1', 'm1',
    startsAt, ends.toISOString(), block.toISOString(),
    input.status ?? 'confirmed', 8000, '2026-09-01T00:00:00.000Z',
    input.lockVersion ?? 0, input.policy ?? '{}', input.friend ? 'liff' : 'phone',
  );
  return { startsAt, endsAt: ends.toISOString(), blockEndsAt: block.toISOString() };
}

function insertConfirmOp(
  sqlite: Database.Database,
  input: { id: string; bookingId: string; status: string; kind?: string; openedAt?: string | null },
) {
  sqlite.prepare(`
    INSERT INTO booking_operation_runs (
      id, booking_id, line_account_id, kind, status, scheduled_at,
      result_json, idempotency_key, opened_at
    ) VALUES (?,?,?,?,?,?,?,?,?)
  `).run(
    input.id, input.bookingId, 'acc1', input.kind ?? 'confirmation_line',
    input.status, '2026-09-01T00:00:00.000Z',
    JSON.stringify({ notificationKind: 'approved' }),
    `${input.bookingId}:confirmation-line:approved`,
    input.openedAt ?? null,
  );
}

function api(app: ReturnType<typeof makeApp>['app'], env: unknown, path: string, init?: RequestInit) {
  return app.request(path, init, env as never, execCtx);
}

describe('通知の再試行 (R323・R324)', () => {
  let sqlite: Database.Database;
  let db: D1Database;

  beforeEach(() => {
    vi.clearAllMocks();
    notifierMocks.calls.length = 0;
    availabilityMocks.calls.length = 0;
    availabilityMocks.computeSlots.mockReturnValue([{ start: '11:00', end: '12:00' }]);
    accountAccessMocks.canAccessAllLineAccounts.mockResolvedValue(true);
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    seed(sqlite);
    db = asD1(sqlite);
  });

  afterEach(() => sqlite.close());

  test('R323: 送信中の再試行は 409 で送らない。期限切れの貸出は取り直せる', async () => {
    insertBooking(sqlite, { id: 'B1', friend: 'f1' });
    // 送信中の貸出 (opened_at が新しい)。
    insertConfirmOp(sqlite, {
      id: 'OP1', bookingId: 'B1', status: 'permanent_failed',
      openedAt: new Date().toISOString(),
    });
    const { app, env } = makeApp(db);
    const busy = await api(app, env, '/api/booking/admin/bookings/B1/notifications/OP1/retry?account_id=acc1', {
      method: 'POST',
    });
    expect(busy.status).toBe(409);
    await expect(busy.json()).resolves.toMatchObject({ error: 'retry_in_progress' });
    expect(notifierMocks.sendBookingNotification).not.toHaveBeenCalled();

    // 10分以上前の貸出は期限切れとして取り直せる。
    sqlite.prepare(`UPDATE booking_operation_runs SET opened_at = ? WHERE id = 'OP1'`)
      .run(new Date(Date.now() - 11 * 60_000).toISOString());
    const retry = await api(app, env, '/api/booking/admin/bookings/B1/notifications/OP1/retry?account_id=acc1', {
      method: 'POST',
    });
    expect(retry.status).toBe(200);
    expect(notifierMocks.sendBookingNotification).toHaveBeenCalledTimes(1);
    // 同じ行の再送は安定キーで行う。
    expect(notifierMocks.calls[0]).toMatchObject({ retryKey: 'OP1' });
  });

  test('R324: 取消ずみの確定通知は送らず、未成功行は止まる', async () => {
    insertBooking(sqlite, { id: 'B1', friend: 'f1' });
    insertConfirmOp(sqlite, { id: 'OP1', bookingId: 'B1', status: 'permanent_failed', openedAt: null });
    const { app, env } = makeApp(db);

    const cancel = await api(app, env, '/api/booking/admin/requests/B1?account_id=acc1', {
      method: 'PATCH',
      body: JSON.stringify({ action: 'cancel' }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(cancel.status).toBe(200);

    const retry = await api(app, env, '/api/booking/admin/bookings/B1/notifications/OP1/retry?account_id=acc1', {
      method: 'POST',
    });
    expect(retry.status).toBe(409);
    await expect(retry.json()).resolves.toMatchObject({
      error: 'notification_obsolete',
      notification_kind: 'approved',
      booking_status: 'cancelled',
    });
    expect(notifierMocks.sendBookingNotification).not.toHaveBeenCalled();
    // 状態変更で未成功行は cancelled になり、再送ボタンに出ない。
    const op = sqlite.prepare(`SELECT status FROM booking_operation_runs WHERE id = 'OP1'`).get() as { status: string };
    expect(op.status).toBe('cancelled');
  });

  test('R329: 送信中の取消は 409 で巻き戻し、成立していない履歴を残さない', async () => {
    insertBooking(sqlite, { id: 'B1', friend: 'f1' });
    sqlite.exec("INSERT INTO booking_groups(id,line_account_id,friend_id,version,created_at,idempotency_key,request_json) VALUES('group-race','acc1','f1',1,'now','group-race','{}'); UPDATE bookings SET group_id='group-race' WHERE id='B1'");
    // の送信権を持つ登録を用意する (liveGuard が止める)。
    // friend_reminders.reminder_id は reminders への外部キー。
    sqlite.exec(`
      INSERT INTO reminders (id, line_account_id, name, trigger_type, delivery_mode, is_active, lifecycle_status,
        trigger_offset_minutes, send_at_time)
      VALUES ('R1','acc1','前日','booking','countdown',1,'published',0,NULL);
    `);
    sqlite.exec(`
      INSERT INTO friend_reminders (id, friend_id, reminder_id, target_date, status, source_kind, source_id, source_event_id)
      VALUES ('E1','f1','R1','2026-10-05T02:00:00.000Z','active','booking','B1','B1');
      INSERT INTO reminder_delivery_runs
        (id, reminder_id, friend_reminder_id, friend_id, reminder_step_id, scheduled_at,
         idempotency_key, line_retry_key, status, lease_expires_at, created_at, updated_at)
      VALUES ('RUN1','R1','E1','f1','S1','2026-10-05T01:00:00.000Z',
         'k1','rk1','claimed','2099-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
    `);
    const { app, env } = makeApp(db);
    const res = await api(app, env, '/api/booking/admin/requests/B1?account_id=acc1', {
      method: 'PATCH',
      body: JSON.stringify({ action: 'cancel' }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({ error: 'send_in_flight_retry' });
    // 予約は元に戻り、取消の履歴は残らない。
    const booking = sqlite.prepare(`SELECT status FROM bookings WHERE id = 'B1'`).get() as { status: string };
    expect(booking.status).toBe('confirmed');
    expect(sqlite.prepare("SELECT version FROM booking_groups WHERE id='group-race'").get()).toEqual({ version: 2 });
    const audits = sqlite.prepare(
      `SELECT action, after_json FROM booking_audit_logs WHERE booking_id = 'B1'`,
    ).all() as Array<{ action: string; after_json: string }>;
    expect(audits.filter((a) => a.action === 'status_changed')).toEqual([]);
  });
});

describe('予約の変更と通知予定 (R325・R326・R335・R336)', () => {
  let sqlite: Database.Database;
  let db: D1Database;

  beforeEach(() => {
    vi.clearAllMocks();
    notifierMocks.calls.length = 0;
    availabilityMocks.calls.length = 0;
    availabilityMocks.computeSlots.mockReturnValue([{ start: '11:00', end: '12:00' }]);
    accountAccessMocks.canAccessAllLineAccounts.mockResolvedValue(true);
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    seed(sqlite);
    db = asD1(sqlite);
  });

  afterEach(() => sqlite.close());

  function patchBody(id: string, body: unknown) {
    const { app, env } = makeApp(db);
    return api(app, env, `/api/booking/admin/bookings/${id}?account_id=acc1`, {
      method: 'PATCH',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    });
  }

  test('R325: 予定の保存に失敗しても予約だけ更新されず、同じ版で再送できる', async () => {
    const { startsAt } = insertBooking(sqlite, { id: 'B1', friend: 'f1' });
    sqlite.prepare(
      `INSERT INTO booking_reminders (id, booking_id, kind, scheduled_at) VALUES ('OLD1','B1','day_before',?)`,
    ).run('2026-01-01T00:00:00.000Z');
    // 予定の INSERT だけを失敗させる。
    sqlite.exec(`CREATE TRIGGER abort_reminder_insert BEFORE INSERT ON booking_reminders
      BEGIN SELECT RAISE(ABORT, 'boom'); END;`);
    const moved = futureStartsAt(8);
    const failed = await patchBody('B1', { lock_version: 0, starts_at: moved });
    expect(failed.status).toBe(500);

    // 予約も予定も監査も巻き戻る (半端な状態を残さない)。
    const booking = sqlite.prepare(
      `SELECT starts_at, lock_version FROM bookings WHERE id = 'B1'`,
    ).get() as { starts_at: string; lock_version: number };
    expect(booking.starts_at).toBe(startsAt);
    expect(booking.lock_version).toBe(0);
    const reminders = sqlite.prepare(
      `SELECT kind, status FROM booking_reminders WHERE booking_id = 'B1' ORDER BY kind`,
    ).all() as Array<{ kind: string; status: string }>;
    expect(reminders).toEqual([{ kind: 'day_before', status: 'pending' }]);

    // 障害が直れば同じ版で保存できる。
    sqlite.exec(`DROP TRIGGER abort_reminder_insert`);
    const retry = await patchBody('B1', { lock_version: 0, starts_at: moved });
    expect(retry.status).toBe(200);
    const after = sqlite.prepare(
      `SELECT kind, status FROM booking_reminders WHERE booking_id = 'B1' ORDER BY kind, scheduled_at`,
    ).all() as Array<{ kind: string; status: string }>;
    expect(after.filter((r) => r.status === 'pending').length).toBe(2);
    expect(after.filter((r) => r.status === 'cancelled').length).toBe(1);
  });

  test('R326: 店内メモだけの保存で終了時刻を書き換えない', async () => {
    const { endsAt, blockEndsAt } = insertBooking(sqlite, { id: 'B1', friend: 'f1' });
    // メニューを改訂 (所要 120分・余裕 20分) しても、メモだけの保存では
    // 保存ずみの時刻を保つ。
    sqlite.prepare(
      `UPDATE menus SET duration_minutes = 120, buffer_after_minutes = 20 WHERE id = 'm1'`,
    ).run();
    const { app, env } = makeApp(db);
    const res = await api(app, env, '/api/booking/admin/bookings/B1?account_id=acc1', {
      method: 'PATCH',
      body: JSON.stringify({ lock_version: 0, internal_note: 'アレルギーあり' }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(200);
    const booking = sqlite.prepare(
      `SELECT ends_at, block_ends_at, internal_note FROM bookings WHERE id = 'B1'`,
    ).get() as { ends_at: string; block_ends_at: string; internal_note: string };
    expect(booking.ends_at).toBe(endsAt);
    expect(booking.block_ends_at).toBe(blockEndsAt);
    expect(booking.internal_note).toBe('アレルギーあり');
  });

  function seedBookingRule(sqlite: Database.Database) {
    sqlite.exec(`
      INSERT INTO reminders (id, line_account_id, name, trigger_type, delivery_mode, is_active, lifecycle_status,
        trigger_offset_minutes, send_at_time)
      VALUES ('R1','acc1','前日','booking','countdown',1,'published',0,NULL);
      INSERT INTO reminder_steps (id, reminder_id, offset_minutes, message_type, message_content)
      VALUES ('S1','R1',-60,'text','test');
    `);
  }

  test('R335: 日時変更と通知OFFの同時保存で、移行前の登録も止まる', async () => {
    const { startsAt } = insertBooking(sqlite, { id: 'B1', friend: 'f1' });
    seedBookingRule(sqlite);
    // 移行前の形式 (source_id なし)。起点は変更前の開始時刻。
    sqlite.prepare(
      `INSERT INTO friend_reminders (id, friend_id, reminder_id, target_date, status, source_kind, source_id, source_event_id)
       VALUES ('E1','f1','R1',?,'active','manual',NULL,NULL)`,
    ).run(startsAt);
    sqlite.prepare(
      `INSERT INTO reminder_delivery_runs
        (id, reminder_id, friend_reminder_id, friend_id, reminder_step_id, scheduled_at,
         idempotency_key, line_retry_key, status, created_at, updated_at)
       VALUES ('RUN1','R1','E1','f1','S1',?,'k1','rk1','queued','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`,
    ).run(startsAt);

    const res = await patchBody('B1', {
      lock_version: 0,
      starts_at: futureStartsAt(8),
      notification_policy: { send_line_confirmation: false, day_before: false, hours_before: false },
    });
    expect(res.status).toBe(200);
    const enrollment = sqlite.prepare(`SELECT status FROM friend_reminders WHERE id = 'E1'`).get() as { status: string };
    expect(enrollment.status).toBe('cancelled');
    const run = sqlite.prepare(`SELECT status FROM reminder_delivery_runs WHERE id = 'RUN1'`).get() as { status: string };
    expect(run.status).toBe('cancelled');
  });

  test('R336: 日時変更で登録が新日時に移る', async () => {
    const { startsAt } = insertBooking(sqlite, { id: 'B1', friend: 'f1' });
    seedBookingRule(sqlite);
    sqlite.prepare(
      `INSERT INTO friend_reminders (id, friend_id, reminder_id, target_date, status, source_kind, source_id, source_event_id)
       VALUES ('E1','f1','R1',?,'active','booking','B1','B1')`,
    ).run(startsAt);

    const moved = futureStartsAt(8);
    const res = await patchBody('B1', { lock_version: 0, starts_at: moved });
    expect(res.status).toBe(200);
    // 同期結果を応答で返す (失敗は failed になり監査にも残る)。
    await expect(res.clone().json()).resolves.toMatchObject({ v6_sync: 'synced' });
    const enrollment = sqlite.prepare(`SELECT status, target_date FROM friend_reminders WHERE id = 'E1'`).get() as {
      status: string;
      target_date: string;
    };
    expect(enrollment.status).toBe('active');
    expect(enrollment.target_date).toBe(moved);
  });
});
