/**
 * 追補  の回帰テスト。3点の部分失敗を本物に近い形で固定する。
 *
 * - 取消と送信claimの原子化: live確認後に別接続で実claim・最終verifyが
 *   割り込んでも、取消を成功させず送信権を守る。
 * - Calendar台帳の初期DB失敗: 先行登録の失敗は落とさず、再送で回復する。
 *   行さえあればcronも拾える。
 * - event却下・管理者取消の再送: 待機者ジョブを復旧し、二重登録しない。
 *
 * 1ファイルで2接続 (route側と割込み/cron側) を同じDBファイルに張る。
 * 外部 LINE・Google へは送らない。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import {
  cancelV6RemindersForSource,
  claimReminderDeliveryRun,
  verifyClaimedRunBeforeSend,
} from '@line-crm/db';
import type { LineClient } from '@line-crm/line-sdk';
import type { Env } from '../worker-env.js';
import { processPendingCalendarDeleteOperations } from '../features/booking/booking-calendar-sync.js';
import { processReminderDeliveries } from '../services/reminder-delivery.js';
import { processDueReminders } from '../features/booking/booking-reminders.js';
import { processDueEventReminders } from '../services/event-booking-reminders.js';

const accountAccessMocks = vi.hoisted(() => ({
  canAccessAllLineAccounts: vi.fn(async () => true),
}));
vi.mock('../services/account-access.js', () => accountAccessMocks);

const bookingCustomerMocks = vi.hoisted(() => ({
  createBookingCustomer: vi.fn(),
  getBookingCustomer: vi.fn(),
  searchBookingCustomers: vi.fn(),
}));
vi.mock('@line-crm/db', async (importOriginal) => ({
  ...await importOriginal<typeof import('@line-crm/db')>(),
  ...bookingCustomerMocks,
}));

const availabilityMocks = vi.hoisted(() => ({ computeSlots: vi.fn(() => []) }));
// 空き枠の計算だけ差し替える。通知文面の時刻・タイムゾーン変換は本物を使う。
vi.mock('../services/availability.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/availability.js')>()),
  ...availabilityMocks,
}));

const notifierMocks = vi.hoisted(() => ({ sendBookingNotification: vi.fn() }));
// 送る側だけ差し替える。文面の組み立て（時刻・残り時間）は本物を使う。
vi.mock('../features/booking/booking-notifier.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../features/booking/booking-notifier.js')>()),
  ...notifierMocks,
}));

const eventNotifierMocks = vi.hoisted(() => ({ sendEventBookingNotification: vi.fn(async () => {}) }));
vi.mock('../services/event-booking-notifier.js', () => eventNotifierMocks);

const liffAuthMocks = vi.hoisted(() => ({ verifyCallerLineUserId: vi.fn(async () => 'U9') }));
vi.mock('../services/liff-auth.js', () => liffAuthMocks);

const { default: booking } = await import('./booking.js');
const { default: events } = await import('./events.js');

// 登録は配信予定より前に済んだ固定時刻で作る。取消・送信の交差を検査する。
const BOOTSTRAP = readFileSync(
  join(process.cwd(), '../../packages/db/bootstrap.sql'),
  'utf8',
);

type Fault = (sql: string) => boolean;
/**
 * SQL文の実行直後に割り込む口。文と文の間へ別接続の操作を挟むために使う
 * (本番コードに試験専用のフックを置かずに競合順序を決められる)。
 */
type AfterRun = (sql: string) => void | Promise<void>;

/** 同じDBファイルへの2接続 (route側と割込み/cron側)。逐次に使う。 */
function openDualDb() {
  const dir = mkdtempSync(join(tmpdir(), 'n065-654-'));
  const file = join(dir, 'test.db');
  const raw1 = new Database(file);
  raw1.exec('PRAGMA journal_mode=WAL');
  raw1.exec(BOOTSTRAP);
  raw1.pragma('foreign_keys = OFF');
  const raw2 = new Database(file);
  raw2.pragma('foreign_keys = OFF');
  const wrap = (raw: Database.Database, fault?: Fault, afterRun?: AfterRun): D1Database => {
    const prepare = (sql: string): D1PreparedStatement => {
      const make = (params: unknown[]): D1PreparedStatement => ({
        bind: (...next: unknown[]) => make(next),
        first: async <T>() => {
          if (fault?.(sql)) throw new Error('injected-db-failure');
          const row = (raw.prepare(sql).get(...params) as T | undefined) ?? null;
          await afterRun?.(sql);
          return row;
        },
        all: async <T>() => {
          if (fault?.(sql)) throw new Error('injected-db-failure');
          const rows = raw.prepare(sql).all(...params) as T[];
          await afterRun?.(sql);
          return { results: rows, success: true, meta: {} };
        },
        run: async <T>() => {
          if (fault?.(sql)) throw new Error('injected-db-failure');
          const info = raw.prepare(sql).run(...params);
          await afterRun?.(sql);
          return { success: true, results: [], meta: { changes: info.changes } } as T;
        },
        raw: async () => [],
      } as unknown as D1PreparedStatement);
      return make([]);
    };
    return {
      prepare,
      batch: async <T>(statements: D1PreparedStatement[]) => {
        raw.exec('BEGIN IMMEDIATE');
        try {
          const results = [];
          for (const statement of statements) results.push(await statement.run());
          raw.exec('COMMIT');
          return results as T;
        } catch (error) {
          raw.exec('ROLLBACK');
          throw error;
        }
      },
    } as unknown as D1Database;
  };
  return {
    db1: wrap(raw1),
    faultyDb1: (fault: Fault) => wrap(raw1, fault),
    hookedDb1: (afterRun: AfterRun) => wrap(raw1, undefined, afterRun),
    faultyDb2: (fault: Fault) => wrap(raw2, fault),
    db2: wrap(raw2),
    raw1,
    raw2,
    cleanup: () => {
      raw1.close();
      raw2.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function seedAccountsAndFriends(raw: Database.Database) {
  raw.exec(`
    INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
    VALUES ('acc1','channel-1','A店','token','secret');
    INSERT INTO friends (id, line_user_id, display_name, line_account_id, is_following, created_at, updated_at)
    VALUES ('f1','U1','花子','acc1',1,'2026-01-01T00:00:00.000','2026-01-01T00:00:00.000');
    INSERT INTO reminders
      (id, name, line_account_id, is_active, trigger_type, delivery_mode, lifecycle_status)
    VALUES ('rb-rule','rule','acc1',1,'booking','countdown','published');
    INSERT INTO reminder_steps (id, reminder_id, offset_minutes, message_type, message_content)
    VALUES ('rb-step','rb-rule',-60,'text','ご来店をお待ちしています');
  `);
}

function seedDeliveryRun(
  raw: Database.Database,
  overrides: Record<string, string | null> = {},
) {
  const row: Record<string, string | null> = {
    id: 'RUN-1',
    line_account_id: 'acc1',
    reminder_id: 'rb-rule',
    friend_reminder_id: 'FR-1',
    friend_id: 'f1',
    reminder_step_id: 'rb-step',
    scheduled_at: '2026-09-20T00:00:00.000Z',
    idempotency_key: 'idem-1',
    line_retry_key: 'retry-1',
    status: 'claimed',
    lease_expires_at: '2099-01-01T00:00:00.000Z',
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
  const cols = Object.keys(row);
  raw.prepare(
    `INSERT INTO reminder_delivery_runs (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
  ).run(...cols.map((c) => row[c]));
}

/**
 * 取消側の live claim 確認 (この直後が「確認後 claim」の割込み窓)。
 * 取消 UPDATE との間に待つ処理は本番に無いため、割込みは試験側の
 * DB ラッパから差し込む。
 */
const LIVE_CLAIM_COUNT_SQL = 'SELECT COUNT(*) AS c FROM reminder_delivery_runs';

describe('送信権の確保と取消が競合したときに送信権を守る', () => {
  it('実claim→最終verify後の取消割込みは409相当で拒否し、push権を守る', async () => {
    const dual = openDualDb();
    try {
      seedAccountsAndFriends(dual.raw1);
      dual.raw1.exec(`
        INSERT INTO friend_reminders (id, friend_id, reminder_id, target_date, status, source_kind, source_id, source_event_id, created_at, updated_at) VALUES ('FR-1','f1','rb-rule','2026-09-20T01:00:00.000Z','active','booking','B1','B1','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');
      `);
      const pushMessageWithRequestId = vi.fn(async (..._args: unknown[]) => ({ requestId: 'REQ-1' }));
      let finalVerifyPassed = false;
      // 取消側が対象選択・live COUNT=0を済ませた後に、別接続の
      // 実配信プロトコルで claim と最終verifyを通す。取消がここから
      // 成功すると、その後のLINE pushが「取消確定後の送信」になる。
      // 取消側が対象選択と live 確認を済ませた直後に割り込む。割込み口は
      // 試験側の DB ラッパに置く (本番コードに試験専用のフックを残さない)。
      let interrupted = false;
      const cancelling = dual.hookedDb1(async (sql) => {
        if (interrupted || !sql.includes(LIVE_CLAIM_COUNT_SQL)) return;
        interrupted = true;
        const run = await claimReminderDeliveryRun(dual.db2, {
          lineAccountId: 'acc1',
          reminderId: 'rb-rule',
          friendReminderId: 'FR-1',
          friendId: 'f1',
          reminderStepId: 'rb-step',
          scheduledAt: '2026-09-09T23:00:00.000Z',
          now: '2026-09-10T00:00:00.000Z',
          leaseExpiresAt: '2026-09-10T00:05:00.000Z',
        });
        expect(run).not.toBeNull();
        finalVerifyPassed = await verifyClaimedRunBeforeSend(dual.db2, {
          id: run!.id,
          friendReminderId: 'FR-1',
          now: '2026-09-10T00:00:00.000Z',
          leaseExpiresAt: '2026-09-10T00:05:00.000Z',
          expectedLeaseExpiresAt: '2026-09-10T00:05:00.000Z',
        });
      });
      const cancellation = cancelV6RemindersForSource(cancelling, {
        sourceId: 'B1',
        sourceEventId: 'B1',
        cancelReason: 'test',
        now: '2026-09-10T00:00:00.000Z',
        failOnSendInFlight: true,
      });
      await expect(cancellation).rejects.toThrow('REMINDER_SEND_IN_FLIGHT');
      expect(finalVerifyPassed).toBe(true);
      // 取消が拒否された後だけ、最終verify済みの送信権を使える。
      await pushMessageWithRequestId('U1', [{ type: 'text', text: 'ご来店をお待ちしています' }], 'retry-1');
      expect(pushMessageWithRequestId).toHaveBeenCalledOnce();
      expect(dual.raw1.prepare(
        `SELECT status FROM friend_reminders WHERE id = 'FR-1'`,
      ).get()).toEqual({ status: 'active' });
      expect(dual.raw1.prepare(
        `SELECT status FROM reminder_delivery_runs WHERE friend_reminder_id = 'FR-1'`,
      ).get()).toEqual({ status: 'claimed' });
    } finally {
      dual.cleanup();
    }
  });

  it('複数登録の1件割込みは成功にせず投げる (部分残留)', async () => {
    const dual = openDualDb();
    try {
      seedAccountsAndFriends(dual.raw1);
      dual.raw1.exec(`
        INSERT INTO friend_reminders (id, friend_id, reminder_id, target_date, status, source_kind, source_id, source_event_id, created_at, updated_at) VALUES ('FR-1','f1','rb-rule','2026-09-20T01:00:00.000Z','active','booking','B1','EV-a','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z'),
               ('FR-2','f1','rb-rule','2026-09-20T01:00:00.000Z','active','booking','B1','EV-b','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');
      `);
      // 1件だけに割込みclaimが入る。旧実装は行単位の除外で割込み行だけ残し、
      // 1件止まった成功で残るactive+claimedを抱えたまま成功した。
      // 新実装は取消の一部確定を戻し、両方activeのまま再試行させる。
      let interrupted = false;
      const cancelling = dual.hookedDb1(async (sql) => {
        if (interrupted || !sql.includes(LIVE_CLAIM_COUNT_SQL)) return;
        interrupted = true;
        seedDeliveryRun(dual.raw2, { id: 'RUN-2', friend_reminder_id: 'FR-2' });
      });
      const cancellation = cancelV6RemindersForSource(cancelling, {
        sourceId: 'B1',
        cancelReason: 'test',
        now: '2026-09-10T00:00:00.000Z',
        failOnSendInFlight: true,
      });
      await expect(cancellation).rejects.toThrow('REMINDER_SEND_IN_FLIGHT');
      expect(dual.raw1.prepare(
        `SELECT status FROM friend_reminders WHERE id = 'FR-1'`,
      ).get()).toEqual({ status: 'active' });
      expect(dual.raw1.prepare(
        `SELECT status FROM friend_reminders WHERE id = 'FR-2'`,
      ).get()).toEqual({ status: 'active' });
      expect(dual.raw1.prepare(
        `SELECT status FROM reminder_delivery_runs WHERE id = 'RUN-2'`,
      ).get()).toEqual({ status: 'claimed' });
    } finally {
      dual.cleanup();
    }
  });

  it('UTC Zのleaseと+09:00のnowをepochで比べる (TEXT比較の見逃し)', async () => {
    const dual = openDualDb();
    try {
      seedAccountsAndFriends(dual.raw1);
      dual.raw1.exec(`
        INSERT INTO friend_reminders (id, friend_id, reminder_id, target_date, status, source_kind, source_id, source_event_id, created_at, updated_at) VALUES ('FR-1','f1','rb-rule','2026-09-20T01:00:00.000Z','active','booking','B1','B1','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');
      `);
      // 実時間で10分live (Z)。nowは+09:00書き。TEXT比較だと 'T04'<'T13' で
      // 見逃して取消成功する欠陥だった。epoch比較では投げる。
      seedDeliveryRun(dual.raw1, { lease_expires_at: '2026-09-10T04:10:00.000Z' });
      const live = cancelV6RemindersForSource(dual.db1, {
        sourceId: 'B1',
        sourceEventId: 'B1',
        cancelReason: 'test',
        now: '2026-09-10T13:00:00.000+09:00',
        failOnSendInFlight: true,
      });
      await expect(live).rejects.toThrow('REMINDER_SEND_IN_FLIGHT');
      // 実時間で切れている lease は止める (TEXTでもepochでも同じ結論)。
      dual.raw1.prepare(
        `UPDATE reminder_delivery_runs SET lease_expires_at = '2026-09-10T03:50:00.000Z' WHERE id = 'RUN-1'`,
      ).run();
      const done = await cancelV6RemindersForSource(dual.db1, {
        sourceId: 'B1',
        sourceEventId: 'B1',
        cancelReason: 'test',
        now: '2026-09-10T13:00:00.000+09:00',
        failOnSendInFlight: true,
      });
      expect(done.cancelledEnrollments).toBe(1);
    } finally {
      dual.cleanup();
    }
  });

  it('本番既定now (+09:00) でも実時間liveを見逃さない', async () => {
    const dual = openDualDb();
    try {
      seedAccountsAndFriends(dual.raw1);
      dual.raw1.exec(`
        INSERT INTO friend_reminders (id, friend_id, reminder_id, target_date, status, source_kind, source_id, source_event_id, created_at, updated_at) VALUES ('FR-1','f1','rb-rule','2026-09-20T01:00:00.000Z','active','booking','B1','B1','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');
      `);
      // nowを渡さない (本番と同じ既定: +09:00書きの現在時刻)。
      seedDeliveryRun(dual.raw1, {
        lease_expires_at: new Date(Date.now() + 3600_000).toISOString(),
      });
      const live = cancelV6RemindersForSource(dual.db1, {
        sourceId: 'B1',
        sourceEventId: 'B1',
        cancelReason: 'test',
        failOnSendInFlight: true,
      });
      await expect(live).rejects.toThrow('REMINDER_SEND_IN_FLIGHT');
    } finally {
      dual.cleanup();
    }
  });

  it('retry_wait・切れleaseの交差は止め切って成功する', async () => {
    const dual = openDualDb();
    try {
      seedAccountsAndFriends(dual.raw1);
      dual.raw1.exec(`
        INSERT INTO friend_reminders (id, friend_id, reminder_id, target_date, status, source_kind, source_id, source_event_id, created_at, updated_at) VALUES ('FR-1','f1','rb-rule','2026-09-20T01:00:00.000Z','active','booking','B1','B1','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');
      `);
      // 再試行待ちと、切れた貸出の残り。liveは無い。
      seedDeliveryRun(dual.raw1, {
        id: 'RUN-rw', status: 'retry_wait', lease_expires_at: null,
        next_retry_at: '2026-09-10T01:00:00.000Z',
      });
      seedDeliveryRun(dual.raw1, {
        id: 'RUN-old', lease_expires_at: '2020-01-01T00:00:00.000Z',
        scheduled_at: '2026-09-20T01:00:00.000Z',
        line_retry_key: 'retry-old', idempotency_key: 'idem-old',
        reminder_step_id: 'rb-step-2',
      });
      const done = await cancelV6RemindersForSource(dual.db1, {
        sourceId: 'B1',
        sourceEventId: 'B1',
        cancelReason: 'test',
        now: '2026-09-10T13:00:00.000+09:00',
        failOnSendInFlight: true,
      });
      expect(done.cancelledEnrollments).toBe(1);
      expect(done.cancelledRuns).toBe(2);
      expect(dual.raw1.prepare(
        `SELECT status FROM friend_reminders WHERE id = 'FR-1'`,
      ).get()).toEqual({ status: 'cancelled' });
    } finally {
      dual.cleanup();
    }
  });

  it('対象が無い再送は投げず0件で返す (冪等)', async () => {
    const dual = openDualDb();
    try {
      seedAccountsAndFriends(dual.raw1);
      const done = await cancelV6RemindersForSource(dual.db1, {
        sourceId: 'missing',
        sourceEventId: 'missing',
        cancelReason: 'test',
        now: '2026-09-10T00:00:00.000Z',
        failOnSendInFlight: true,
      });
      expect(done).toEqual({ cancelledEnrollments: 0, cancelledRuns: 0 });
    } finally {
      dual.cleanup();
    }
  });
});

function seedBookingCancelTarget(raw: Database.Database) {
  seedAccountsAndFriends(raw);
  raw.exec(`
    INSERT INTO staff (id, line_account_id, name, display_name)
    VALUES ('s1','acc1','担当A','担当A'), ('owner-1','acc1','Owner','Owner');
    INSERT INTO menus (
      id, line_account_id, name, duration_minutes, buffer_after_minutes,
      base_price, concurrent_capacity
    ) VALUES ('m1','acc1','相談',60,10,8000,1);
    INSERT INTO bookings (
      id, line_account_id, friend_id, staff_id, menu_id,
      starts_at, ends_at, block_ends_at, status, price_at_booking, requested_at,
      external_event_id
    ) VALUES (
      'RB9','acc1','f1','s1','m1',
      '2026-09-20T01:00:00.000Z','2026-09-20T02:00:00.000Z','2026-09-20T02:00:00.000Z',
      'confirmed',8000,'2026-09-01T00:00:00.000Z', NULL
    ),
    (
      'RB10','acc1','f1','s1','m1',
      '2026-09-21T01:00:00.000Z','2026-09-21T02:00:00.000Z','2026-09-21T02:00:00.000Z',
      'confirmed',8000,'2026-09-01T00:00:00.000Z','gcal-ev-10'
    );
  `);
}

function makeBookingApp(db: D1Database) {
  const app = new Hono<Env>();
  app.use('*', async (c, next) => {
    c.set('staff', { id: 'owner-1', name: 'Owner', role: 'owner', readOnly: false });
    return next();
  });
  app.route('/', booking);
  return { app, env: { DB: db } };
}

describe('カレンダー取消の記録が失敗しても再送で回復する', () => {
  it('fence成功後の登録の失敗は落とさず、取消再送で回復する', async () => {
    const dual = openDualDb();
    try {
      seedBookingCancelTarget(dual.raw1);
      // 台帳の作成だけ落とす初期DB失敗。1回だけ投げて止める。
      let failOnce = true;
      const faulty = dual.faultyDb1((sql) =>
        sql.includes('INTO booking_operation_runs') && failOnce
          ? (failOnce = false, true)
          : false,
      );
      const execCtx = {
        waitUntil: () => undefined,
        passThroughOnException: () => undefined,
      } as unknown as ExecutionContext;
      const first = makeBookingApp(faulty);
      const failed = await first.app.request(
        '/api/booking/admin/requests/RB9?account_id=acc1',
        {
          method: 'PATCH',
          body: JSON.stringify({ action: 'cancel' }),
          headers: { 'Content-Type': 'application/json' },
        },
        first.env,
        execCtx,
      );
      // 失敗は隠さない。予約は取消ずみだが、台帳行は無い。
      expect(failed.status).toBe(500);
      expect(dual.raw1.prepare(`SELECT status FROM bookings WHERE id = 'RB9'`).get()).toEqual({
        status: 'cancelled',
      });
      expect(dual.raw1.prepare(
        `SELECT COUNT(*) AS c FROM booking_operation_runs WHERE booking_id = 'RB9'`,
      ).get()).toEqual({ c: 0 });
      // 同じ取消要求の再送で台帳行が残り、終端まで進む (消す物が無いため skipped)。
      const second = makeBookingApp(dual.db1);
      const retried = await second.app.request(
        '/api/booking/admin/requests/RB9?account_id=acc1',
        {
          method: 'PATCH',
          body: JSON.stringify({ action: 'cancel' }),
          headers: { 'Content-Type': 'application/json' },
        },
        second.env,
        execCtx,
      );
      expect(retried.status).toBe(200);
      expect(dual.raw1.prepare(
        `SELECT status FROM booking_operation_runs WHERE booking_id = 'RB9'`,
      ).get()).toEqual({ status: 'skipped' });
    } finally {
      dual.cleanup();
    }
  });

  it('連続DB失敗でも台帳なし200にせず、回復する', async () => {
    const dual = openDualDb();
    try {
      seedBookingCancelTarget(dual.raw1);
      // 台帳の作成を2回連続で落とす。3回目で通る。
      let failuresLeft = 2;
      const faulty = dual.faultyDb1((sql) =>
        sql.includes('INTO booking_operation_runs') && failuresLeft > 0
          ? (failuresLeft--, true)
          : false,
      );
      const execCtx = {
        waitUntil: () => undefined,
        passThroughOnException: () => undefined,
      } as unknown as ExecutionContext;
      const send = (db: D1Database) => {
        const { app, env } = makeBookingApp(db);
        return app.request(
          '/api/booking/admin/requests/RB9?account_id=acc1',
          {
            method: 'PATCH',
            body: JSON.stringify({ action: 'cancel' }),
            headers: { 'Content-Type': 'application/json' },
          },
          env,
          execCtx,
        );
      };
      // 初回 (本線): 500。2回目の再送も 500。台帳なしの成功応答はしない。
      expect((await send(faulty)).status).toBe(500);
      expect((await send(faulty)).status).toBe(500);
      expect(dual.raw1.prepare(
        `SELECT COUNT(*) AS c FROM booking_operation_runs WHERE booking_id = 'RB9'`,
      ).get()).toEqual({ c: 0 });
      // 3回目で回復する。
      const recovered = await send(dual.db1);
      expect(recovered.status).toBe(200);
      expect(dual.raw1.prepare(
        `SELECT status FROM booking_operation_runs WHERE booking_id = 'RB9'`,
      ).get()).toEqual({ status: 'skipped' });
    } finally {
      dual.cleanup();
    }
  });

  it('本番既定nowの実routeでもlive見逃しで取消成功しない', async () => {
    const dual = openDualDb();
    try {
      seedBookingCancelTarget(dual.raw1);
      dual.raw1.exec(`
        INSERT INTO friend_reminders (id, friend_id, reminder_id, target_date, status, source_kind, source_id, source_event_id, created_at, updated_at) VALUES ('FR-9','f1','rb-rule','2026-09-20T01:00:00.000Z','active','booking','RB9','RB9','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');
      `);
      // 実時間でliveなZ lease。routeは既定now (+09:00書き) で比べる。
      seedDeliveryRun(dual.raw1, {
        id: 'RUN-9',
        friend_reminder_id: 'FR-9',
        lease_expires_at: new Date(Date.now() + 3600_000).toISOString(),
      });
      const execCtx = {
        waitUntil: () => undefined,
        passThroughOnException: () => undefined,
      } as unknown as ExecutionContext;
      const { app, env } = makeBookingApp(dual.db1);
      const conflicted = await app.request(
        '/api/booking/admin/requests/RB9?account_id=acc1',
        {
          method: 'PATCH',
          body: JSON.stringify({ action: 'cancel' }),
          headers: { 'Content-Type': 'application/json' },
        },
        env,
        execCtx,
      );
      // TEXT比較の旧実装は見逃して200取消成功する欠陥だった。
      expect(conflicted.status).toBe(409);
      expect(dual.raw1.prepare(`SELECT status FROM bookings WHERE id = 'RB9'`).get()).toEqual({
        status: 'confirmed',
      });
    } finally {
      dual.cleanup();
    }
  });

  it('409で巻き戻した確定予約の予定をcronが消さない', async () => {
    const dual = openDualDb();
    try {
      seedBookingCancelTarget(dual.raw1);
      dual.raw1.exec(`
        INSERT INTO friend_reminders (id, friend_id, reminder_id, target_date, status, source_kind, source_id, source_event_id, created_at, updated_at) VALUES ('FR-9','f1','rb-rule','2026-09-20T01:00:00.000Z','active','booking','RB9','RB9','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');
      `);
      seedDeliveryRun(dual.raw1, {
        id: 'RUN-9', friend_reminder_id: 'FR-9', reminder_step_id: 'rb-step',
      });
      const execCtx = {
        waitUntil: () => undefined,
        passThroughOnException: () => undefined,
      } as unknown as ExecutionContext;
      const { app, env } = makeBookingApp(dual.db1);
      // 貸出中は巻き戻して409。台帳行は残さない (fence成功後に移した)。
      const conflicted = await app.request(
        '/api/booking/admin/requests/RB9?account_id=acc1',
        {
          method: 'PATCH',
          body: JSON.stringify({ action: 'cancel' }),
          headers: { 'Content-Type': 'application/json' },
        },
        env,
        execCtx,
      );
      expect(conflicted.status).toBe(409);
      expect(dual.raw1.prepare(`SELECT status FROM bookings WHERE id = 'RB9'`).get()).toEqual({
        status: 'confirmed',
      });
      expect(dual.raw1.prepare(
        `SELECT COUNT(*) AS c FROM booking_operation_runs WHERE booking_id = 'RB9'`,
      ).get()).toEqual({ c: 0 });
      // 残留した古い queued 行があっても、確定ずみの予定は消さない。
      const { enqueueCalendarDeleteOperation } = await import(
        '../features/booking/booking-calendar-sync.js'
      );
      await enqueueCalendarDeleteOperation(dual.db1, { bookingId: 'RB9', lineAccountId: 'acc1' });
      const removed: string[] = [];
      const drained = await processPendingCalendarDeleteOperations(dual.db2, {
        now: new Date('2026-09-10T00:00:00.000Z'),
        remove: async (bookingId) => {
          removed.push(bookingId);
        },
      });
      expect(removed).toEqual([]);
      expect(drained).toEqual({ processed: 1, succeeded: 0, retrying: 0, skipped: 1 });
      expect(dual.raw1.prepare(
        `SELECT status FROM booking_operation_runs WHERE booking_id = 'RB9'`,
      ).get()).toEqual({ status: 'skipped' });
    } finally {
      dual.cleanup();
    }
  });

  it('別接続のcronが先行登録ずみの行を拾って直す', async () => {
    const dual = openDualDb();
    try {
      seedBookingCancelTarget(dual.raw1);
      // fence成功後の取消ずみ予約を想定する (実行側は取消ずみだけ消す)。
      dual.raw1.prepare(`UPDATE bookings SET status = 'cancelled' WHERE id = 'RB10'`).run();
      // route側の接続で登録 (fence成功後に残る想定)。
      const { enqueueCalendarDeleteOperation } = await import(
        '../features/booking/booking-calendar-sync.js'
      );
      await enqueueCalendarDeleteOperation(dual.db1, { bookingId: 'RB10', lineAccountId: 'acc1' });
      // cron側の別接続が回収する。外部削除は1回だけ。
      const removed: string[] = [];
      const drained = await processPendingCalendarDeleteOperations(dual.db2, {
        now: new Date('2026-09-10T00:00:00.000Z'),
        remove: async (bookingId) => {
          removed.push(bookingId);
        },
      });
      expect(drained).toEqual({ processed: 1, succeeded: 1, retrying: 0, skipped: 0 });
      expect(removed).toEqual(['RB10']);
      // もう一度回しても触らない (終端行は拾わない)。
      const again = await processPendingCalendarDeleteOperations(dual.db2, {
        now: new Date('2026-09-10T00:00:01.000Z'),
        remove: async (bookingId) => {
          removed.push(bookingId);
        },
      });
      expect(again.processed).toBe(0);
      expect(removed).toEqual(['RB10']);
    } finally {
      dual.cleanup();
    }
  });
});

function seedEventRejectTarget(raw: Database.Database) {
  raw.exec(`
    INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
    VALUES ('account-1','channel-1','本店','token','secret');
    INSERT INTO friends (id, line_user_id, display_name, line_account_id, is_following)
    VALUES ('friend-1','U-friend-1','田中さくら','account-1',1);
    INSERT INTO events (id, line_account_id, name, target_type)
    VALUES ('ev-1','account-1','体験会','single');
    INSERT INTO event_slots (id, event_id, starts_at, ends_at)
    VALUES ('slot-1','ev-1','2026-09-20T01:00:00.000Z','2026-09-20T02:00:00.000Z');
    INSERT INTO event_bookings
      (id, line_account_id, event_id, slot_id, friend_id, status, requested_at,
       decided_at, decided_by_staff_id)
    VALUES ('eb-r1','account-1','ev-1','slot-1','friend-1','rejected','2026-09-01T00:00:00.000Z',
      '2026-09-02T00:00:00.000Z','owner-1');
    INSERT INTO reminders
      (id, name, line_account_id, is_active, trigger_type, delivery_mode, lifecycle_status)
    VALUES ('rule-event-1','rule','account-1',1,'event','countdown','published');
    INSERT INTO reminder_steps
      (id, reminder_id, offset_minutes, message_type, message_content)
    VALUES ('step-rule-event-1','rule-event-1',-60,'text','お待ちしています');
  `);
}

function makeEventsApp(db: D1Database) {
  const app = new Hono<Env>();
  app.use('*', async (c, next) => {
    c.set('staff', { id: 'staff-1', name: '担当者', role: 'owner', readOnly: false });
    return next();
  });
  app.route('/', events);
  return { app, env: { DB: db } };
}

describe('イベント却下の再送は待機者登録を重複させず回復する', () => {
  it('初回の待機者登録失敗は再送で直り、二重登録しない', async () => {
    const dual = openDualDb();
    try {
      seedEventRejectTarget(dual.raw1);
      const decide = (db: D1Database) => {
        const { app, env } = makeEventsApp(db);
        return app.request(
          '/api/events/admin/events/ev-1/bookings/eb-r1/decide?account_id=account-1',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'reject' }),
          },
          env,
        );
      };
      // 初回の待機者ジョブ登録だけ落とすDB失敗。修復は通る。
      let failOnce = true;
      const faulty = dual.faultyDb1((sql) =>
        sql.includes('INSERT OR IGNORE INTO event_waitlist_promotion_jobs') && failOnce
          ? (failOnce = false, true)
          : false,
      );
      const failed = await decide(faulty);
      expect(failed.status).toBe(500);
      expect(dual.raw1.prepare(
        `SELECT COUNT(*) AS c FROM event_waitlist_promotion_jobs WHERE source_key = 'booking:eb-r1:rejected'`,
      ).get()).toEqual({ c: 0 });
      // 同じ却下要求の再送で待機者ジョブが残る。
      const retried = await decide(dual.db1);
      expect(retried.status).toBe(200);
      expect(dual.raw1.prepare(
        `SELECT status FROM event_waitlist_promotion_jobs WHERE source_key = 'booking:eb-r1:rejected'`,
      ).get()).toEqual({ status: 'pending' });
      // もう一度送っても1行のまま (二重登録なし)。
      const again = await decide(dual.db1);
      expect(again.status).toBe(200);
      expect(dual.raw1.prepare(
        `SELECT COUNT(*) AS c FROM event_waitlist_promotion_jobs WHERE source_key = 'booking:eb-r1:rejected'`,
      ).get()).toEqual({ c: 1 });
    } finally {
      dual.cleanup();
    }
  });
});

function seedLiffCancelTarget(raw: Database.Database) {
  raw.exec(`
    INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret, liff_id, is_active)
    VALUES ('account-9','channel-9','9店','token9','secret9','L9',1);
    INSERT INTO friends (id, line_user_id, display_name, line_account_id, is_following)
    VALUES ('friend-9','U9','本人','account-9',1);
    INSERT INTO events (id, line_account_id, name, target_type, cancel_deadline_hours_before)
    VALUES ('ev-9','account-9','体験会','single',24);
    INSERT INTO event_slots (id, event_id, starts_at, ends_at)
    VALUES ('slot-9','ev-9','2099-06-01T10:00:00.000Z','2099-06-01T12:00:00.000Z');
    INSERT INTO event_bookings
      (id, line_account_id, event_id, slot_id, friend_id, status, requested_at)
    VALUES ('eb-l1','account-9','ev-9','slot-9','friend-9','requested','2026-09-01T00:00:00.000Z');
    INSERT INTO reminders
      (id, name, line_account_id, is_active, trigger_type, delivery_mode, lifecycle_status)
    VALUES ('rule-event-9','rule','account-9',1,'event','countdown','published');
    INSERT INTO reminder_steps
      (id, reminder_id, offset_minutes, message_type, message_content)
    VALUES ('step-rule-event-9','rule-event-9',-60,'text','お待ちしています');
    INSERT INTO friend_reminders (id, friend_id, reminder_id, target_date, status, source_kind, source_id, source_event_id, created_at, updated_at) VALUES ('FR-l1','friend-9','rule-event-9','2099-06-01T10:00:00.000Z','active','event','eb-l1','eb-l1','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');
    INSERT INTO event_booking_reminders
      (id, booking_id, kind, scheduled_at, status, retry_count)
    VALUES ('LEG-l1','eb-l1','day_before','2099-05-31T10:00:00.000Z','pending',0);
  `);
}

function confirmLegacyEventReminder(raw: Database.Database) {
  // 承認で確定した予約の世代に対して通知予定を作る。
  raw.exec(`UPDATE event_bookings SET status='confirmed' WHERE id='eb-l1';
    UPDATE event_booking_reminders SET booking_version=(SELECT lock_version FROM event_bookings WHERE id='eb-l1')
      WHERE id='LEG-l1' AND status='pending';`);
}

it('イベント: 確定ずみでも旧版の通知は送らず、現行版の予定を回収して一度だけ送る', async () => {
  const dual = openDualDb();
  try {
    seedLiffCancelTarget(dual.raw1);
    dual.raw1.exec(`UPDATE events SET reminder_day_before_enabled=1,reminder_hours_before=NULL WHERE id='ev-9';
      UPDATE event_booking_reminders SET scheduled_at='2099-05-31T07:00:00.000Z' WHERE id='LEG-l1';
      UPDATE event_bookings SET status='confirmed' WHERE id='eb-l1'`);
    const sender=vi.fn(async()=>{});
    const params={now:new Date('2099-05-31T08:00:00.000Z'),sender};
    expect(await processDueEventReminders(dual.db1,params)).toEqual({sent:0,failed:0});
    expect(sender).not.toHaveBeenCalled();
    expect(dual.raw1.prepare("SELECT booking_version,status FROM event_booking_reminders WHERE id='LEG-l1'").get())
      .toEqual({booking_version:1,status:'pending'});
    expect(dual.raw1.prepare("SELECT booking_version,status FROM event_booking_reminders WHERE booking_id='eb-l1' AND booking_version=2").all())
      .toEqual([{booking_version:2,status:'pending'}]);
    params.now=new Date('2099-05-31T12:00:00.000Z');
    expect(await processDueEventReminders(dual.db1,params)).toEqual({sent:1,failed:0});
    expect(sender).toHaveBeenCalledTimes(1);
    expect(await processDueEventReminders(dual.db1,params)).toEqual({sent:0,failed:0});
    expect(sender).toHaveBeenCalledTimes(1);
  } finally { dual.cleanup(); }
});

describe('管理者イベント取消の待機者再登録 (再審査-3)', () => {
  it('初回のenqueue失敗を同じ取消要求の再送で復旧する', async () => {
    const dual = openDualDb();
    try {
      seedLiffCancelTarget(dual.raw1);
      const cancel = (db: D1Database) => {
        const { app, env } = makeEventsApp(db);
        return app.request(
          '/api/events/admin/events/ev-9/bookings/eb-l1/cancel?account_id=account-9',
          { method: 'POST' },
          env,
        );
      };
      let failOnce = true;
      const faulty = dual.faultyDb1((sql) =>
        sql.includes('INSERT OR IGNORE INTO event_waitlist_promotion_jobs') && failOnce
          ? (failOnce = false, true)
          : false,
      );

      const failed = await cancel(faulty);
      expect(failed.status).toBe(500);
      expect(dual.raw1.prepare(
        `SELECT status FROM event_bookings WHERE id = 'eb-l1'`,
      ).get()).toEqual({ status: 'cancelled' });
      expect(dual.raw1.prepare(
        `SELECT COUNT(*) AS c FROM event_waitlist_promotion_jobs
          WHERE source_key = 'booking:eb-l1:cancelled'`,
      ).get()).toEqual({ c: 0 });

      const retried = await cancel(dual.db1);
      expect(retried.status).toBe(200);
      expect(dual.raw1.prepare(
        `SELECT status FROM event_waitlist_promotion_jobs
          WHERE source_key = 'booking:eb-l1:cancelled'`,
      ).get()).toEqual({ status: 'pending' });

      expect((await cancel(dual.db1)).status).toBe(200);
      expect(dual.raw1.prepare(
        `SELECT COUNT(*) AS c FROM event_waitlist_promotion_jobs
          WHERE source_key = 'booking:eb-l1:cancelled'`,
      ).get()).toEqual({ c: 1 });
    } finally {
      dual.cleanup();
    }
  });
});

describe('LIFF本人取消の両分岐strict fence (再審査-2)', () => {
  it('初回も再送も貸出中は409で巻き戻し、再試行で取消せる', async () => {
    const dual = openDualDb();
    try {
      seedLiffCancelTarget(dual.raw1);
      seedDeliveryRun(dual.raw1, {
        id: 'RUN-l1',
        line_account_id: 'account-9',
        reminder_id: 'rule-event-9',
        friend_reminder_id: 'FR-l1',
        friend_id: 'friend-9',
        reminder_step_id: 'step-rule-event-9',
        scheduled_at: '2099-06-01T09:00:00.000Z',
      });
      const cancel = (db: D1Database) => {
        const { app, env } = makeEventsApp(db);
        return app.request('/api/liff/events/me/eb-l1/cancel?liffId=L9', {
          method: 'POST',
          headers: { Authorization: 'Bearer test' },
        }, env);
      };
      // 初回: 貸出中は取消を確定させず 409。状態・旧表とも巻き戻る (完全rollback)。
      const conflicted = await cancel(dual.db1);
      expect(conflicted.status).toBe(409);
      expect(dual.raw1.prepare(`SELECT status FROM event_bookings WHERE id = 'eb-l1'`).get()).toEqual({
        status: 'requested',
      });
      expect(dual.raw1.prepare(`SELECT status FROM friend_reminders WHERE id = 'FR-l1'`).get()).toEqual({
        status: 'active',
      });
      expect(dual.raw1.prepare(`SELECT status FROM event_booking_reminders WHERE id = 'LEG-l1'`).get()).toEqual({
        status: 'pending',
      });
      // 送信が終われば再試行で取消せる。待機者ジョブも残る。
      dual.raw1.prepare(
        `UPDATE reminder_delivery_runs SET status = 'succeeded', lease_expires_at = NULL WHERE id = 'RUN-l1'`,
      ).run();
      const retried = await cancel(dual.db1);
      expect(retried.status).toBe(200);
      expect(dual.raw1.prepare(`SELECT status FROM event_bookings WHERE id = 'eb-l1'`).get()).toEqual({
        status: 'cancelled',
      });
      expect(dual.raw1.prepare(`SELECT status FROM friend_reminders WHERE id = 'FR-l1'`).get()).toEqual({
        status: 'cancelled',
      });
      expect(dual.raw1.prepare(`SELECT status FROM event_booking_reminders WHERE id = 'LEG-l1'`).get()).toEqual({
        status: 'cancelled',
      });
      expect(dual.raw1.prepare(
        `SELECT COUNT(*) AS c FROM event_waitlist_promotion_jobs WHERE source_key = 'booking:eb-l1:cancelled'`,
      ).get()).toEqual({ c: 1 });
      // 再送: も待機者も冪等 (二重登録なし)。
      const again = await cancel(dual.db1);
      expect(again.status).toBe(200);
      expect(dual.raw1.prepare(
        `SELECT COUNT(*) AS c FROM event_waitlist_promotion_jobs WHERE source_key = 'booking:eb-l1:cancelled'`,
      ).get()).toEqual({ c: 1 });
    } finally {
      dual.cleanup();
    }
  });

  it('再送の貸出中も409にし、状態を変えない', async () => {
    const dual = openDualDb();
    try {
      seedLiffCancelTarget(dual.raw1);
      // 取消ずみ・未処理の残り (初回の 失敗相当) + 新しい貸出。
      dual.raw1.prepare(`UPDATE event_bookings SET status = 'cancelled', cancelled_at = ?, cancelled_by = 'friend' WHERE id = 'eb-l1'`)
        .run('2026-09-02T00:00:00.000Z');
      seedDeliveryRun(dual.raw1, {
        id: 'RUN-l2',
        line_account_id: 'account-9',
        reminder_id: 'rule-event-9',
        friend_reminder_id: 'FR-l1',
        friend_id: 'friend-9',
        reminder_step_id: 'step-rule-event-9',
        scheduled_at: '2099-06-01T09:00:00.000Z',
      });
      const cancel = (db: D1Database) => {
        const { app, env } = makeEventsApp(db);
        return app.request('/api/liff/events/me/eb-l1/cancel?liffId=L9', {
          method: 'POST',
          headers: { Authorization: 'Bearer test' },
        }, env);
      };
      const conflicted = await cancel(dual.db1);
      expect(conflicted.status).toBe(409);
      expect(dual.raw1.prepare(`SELECT status FROM event_bookings WHERE id = 'eb-l1'`).get()).toEqual({
        status: 'cancelled',
      });
      expect(dual.raw1.prepare(`SELECT status FROM friend_reminders WHERE id = 'FR-l1'`).get()).toEqual({
        status: 'active',
      });
      dual.raw1.prepare(
        `UPDATE reminder_delivery_runs SET status = 'succeeded', lease_expires_at = NULL WHERE id = 'RUN-l2'`,
      ).run();
      const retried = await cancel(dual.db1);
      expect(retried.status).toBe(200);
      expect(dual.raw1.prepare(`SELECT status FROM friend_reminders WHERE id = 'FR-l1'`).get()).toEqual({
        status: 'cancelled',
      });
    } finally {
      dual.cleanup();
    }
  });
});

// =============================================================================
// 取消後の配信抑止、部分失敗の再試行、送達不明時の再送禁止を確かめる。
//
// ここは「緑の試験を信用しない」ための独立検証。db 関数の直接呼び出しでは
// なく、実 route と実配信ループ (processReminderDeliveries) を通し、LINE へ
// 実際に push が渡ったかどうかで判定する。
// =============================================================================

/** LINE push の受け口。userId と X-Line-Retry-Key を記録する。 */
function makePushRecorder(
  behaviour: (call: number) => { requestId: string | null } | never = () => ({ requestId: 'REQ' }),
) {
  const pushes: Array<{ userId: string; retryKey: string | undefined }> = [];
  const client = {
    async pushMessageWithRequestId(userId: string, _messages: unknown[], retryKey?: string) {
      pushes.push({ userId, retryKey });
      return { data: {}, ...behaviour(pushes.length) };
    },
  } as unknown as LineClient;
  return { pushes, client };
}

const noPause = async () => undefined;

/** 登録 + 旧表の未送信を1件ずつ足す (予約 RB9 きっかけ)。 */
function seedBookingReminderPair(raw: Database.Database) {
  raw.exec(`
    INSERT INTO friend_reminders (id, friend_id, reminder_id, target_date, status, source_kind, source_id, source_event_id, created_at, updated_at) VALUES ('FR-d1','f1','rb-rule','2026-09-20T01:00:00.000Z','active','booking','RB9','RB9','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');
    INSERT INTO booking_reminders (id, booking_id, kind, scheduled_at, status, retry_count)
    VALUES ('LEG-d1','RB9','day_before','2026-09-19T01:00:00.000Z','pending',0);
  `);
}

const EXEC_CTX = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
} as unknown as ExecutionContext;

function cancelBooking(db: D1Database) {
  const { app, env } = makeBookingApp(db);
  return app.request(
    '/api/booking/admin/requests/RB9?account_id=acc1',
    {
      method: 'PATCH',
      body: JSON.stringify({ action: 'cancel' }),
      headers: { 'Content-Type': 'application/json' },
    },
    env,
    EXEC_CTX,
  );
}

// 送信予定は target_date-60分 = 2026-09-20T00:00Z。cron はその後に回る。
const SEND_AT_PASSED = new Date('2026-09-20T00:30:00.000Z');

describe('取消後に外部送信が走らない (自主検証)', () => {
  it('予約取消の後、実配信cronは1通もLINEへ渡さない', async () => {
    const dual = openDualDb();
    try {
      seedBookingCancelTarget(dual.raw1);
      seedBookingReminderPair(dual.raw1);

      expect((await cancelBooking(dual.db1)).status).toBe(200);
      expect(dual.raw1.prepare(`SELECT status FROM friend_reminders WHERE id = 'FR-d1'`).get())
        .toEqual({ status: 'cancelled' });
      expect(dual.raw1.prepare(`SELECT status FROM booking_reminders WHERE id = 'LEG-d1'`).get())
        .toEqual({ status: 'cancelled' });

      // 別接続の配信cronが送信時刻を過ぎてから回っても送らない。
      const { pushes, client } = makePushRecorder();
      const result = await processReminderDeliveries(dual.db2, client, {
        now: SEND_AT_PASSED,
        pause: noPause,
        resolveClient: async () => client,
      });
      expect(pushes).toEqual([]);
      expect(result.succeeded).toBe(0);
      expect(dual.raw1.prepare(
        `SELECT COUNT(*) AS c FROM reminder_delivery_runs WHERE status = 'succeeded'`,
      ).get()).toEqual({ c: 0 });
    } finally {
      dual.cleanup();
    }
  });

  it('イベント取消 (LIFF本人) の後も、実配信cronは1通も渡さない', async () => {
    const dual = openDualDb();
    try {
      seedLiffCancelTarget(dual.raw1);
      const { app, env } = makeEventsApp(dual.db1);
      const cancelled = await app.request('/api/liff/events/me/eb-l1/cancel?liffId=L9', {
        method: 'POST',
        headers: { Authorization: 'Bearer test' },
      }, env);
      expect(cancelled.status).toBe(200);
      expect(dual.raw1.prepare(`SELECT status FROM friend_reminders WHERE id = 'FR-l1'`).get())
        .toEqual({ status: 'cancelled' });
      expect(dual.raw1.prepare(`SELECT status FROM event_booking_reminders WHERE id = 'LEG-l1'`).get())
        .toEqual({ status: 'cancelled' });

      const { pushes, client } = makePushRecorder();
      const result = await processReminderDeliveries(dual.db2, client, {
        // FR-l1 の送信予定 (2099-06-01T09:00Z) を過ぎた時刻。
        now: new Date('2099-06-01T09:30:00.000Z'),
        pause: noPause,
        resolveClient: async () => client,
      });
      expect(pushes).toEqual([]);
      expect(result.succeeded).toBe(0);
    } finally {
      dual.cleanup();
    }
  });

  it('claim後・push直前に別接続で取消が確定したら送らずに止める', async () => {
    const dual = openDualDb();
    try {
      seedBookingCancelTarget(dual.raw1);
      seedBookingReminderPair(dual.raw1);
      const { pushes, client } = makePushRecorder();
      const result = await processReminderDeliveries(dual.db1, client, {
        now: SEND_AT_PASSED,
        pause: noPause,
        resolveClient: async () => client,
        // 送信権の再検証を通った直後に、別接続の取消が確定する。
        // (収束経路の取消。route の strict fence は貸出中を 409 で弾く)
        beforePush: async () => {
          dual.raw2.prepare(
            `UPDATE friend_reminders SET status = 'cancelled', cancel_reason = 'race'
              WHERE id = 'FR-d1'`,
          ).run();
        },
      });
      expect(pushes).toEqual([]);
      expect(result).toEqual({ succeeded: 0, skipped: 1, retrying: 0, failed: 0, held: 0 });
      expect(dual.raw1.prepare(
        `SELECT status FROM reminder_delivery_runs WHERE friend_reminder_id = 'FR-d1'`,
      ).get()).toEqual({ status: 'cancelled' });
    } finally {
      dual.cleanup();
    }
  });
});

describe('部分失敗の再実行で二重送信にならない (自主検証)', () => {
  it('確認済み429の自動再試行は同じ再送キーで送り、実行行も配信済みも1件のまま', async () => {
    const dual = openDualDb();
    try {
      seedBookingCancelTarget(dual.raw1);
      seedBookingReminderPair(dual.raw1);
      // 1回目は未受理を確認できる429。待機後だけ同じキーで再試行する。
      const { pushes, client } = makePushRecorder((call) => {
        if (call === 1) throw Object.assign(new Error('not accepted'), { status: 429 });
        return { requestId: 'REQ-2' };
      });

      const first = await processReminderDeliveries(dual.db1, client, {
        now: SEND_AT_PASSED,
        pause: noPause,
        resolveClient: async () => client,
      });
      expect(first).toEqual({ succeeded: 0, skipped: 0, retrying: 1, failed: 0, held: 0 });
      expect(dual.raw1.prepare(
        `SELECT status FROM reminder_delivery_runs WHERE friend_reminder_id = 'FR-d1'`,
      ).get()).toEqual({ status: 'retry_wait' });

      // 自動再試行。同じ X-Line-Retry-Key で送るため、LINE 側が重複を吸収する。
      const second = await processReminderDeliveries(dual.db1, client, {
        now: new Date(SEND_AT_PASSED.getTime() + 2 * 60_000),
        pause: noPause,
        resolveClient: async () => client,
      });
      expect(second).toEqual({ succeeded: 1, skipped: 0, retrying: 0, failed: 0, held: 0 });
      expect(pushes).toHaveLength(2);
      expect(pushes[0].retryKey).toBeTruthy();
      expect(pushes[1].retryKey).toBe(pushes[0].retryKey);
      // 実行行は増えない (登録・通・予定時刻の冪等キーで1本に集まる)。
      expect(dual.raw1.prepare(
        `SELECT COUNT(*) AS c FROM reminder_delivery_runs WHERE friend_reminder_id = 'FR-d1'`,
      ).get()).toEqual({ c: 1 });
      expect(dual.raw1.prepare(
        `SELECT COUNT(*) AS c FROM friend_reminder_deliveries WHERE friend_reminder_id = 'FR-d1'`,
      ).get()).toEqual({ c: 1 });

      // 送信ずみの後にもう一度回しても送らない。
      const third = await processReminderDeliveries(dual.db1, client, {
        now: new Date(SEND_AT_PASSED.getTime() + 30 * 60_000),
        pause: noPause,
        resolveClient: async () => client,
      });
      expect(third.succeeded).toBe(0);
      expect(pushes).toHaveLength(2);
    } finally {
      dual.cleanup();
    }
  });

  it('送達不明は別の実行者でも再送せず、元の行とキーを照合待ちに保つ',async()=>{
    const dual=openDualDb();
    try {
      seedBookingCancelTarget(dual.raw1);seedBookingReminderPair(dual.raw1);
      const {pushes,client}=makePushRecorder(()=>{throw new Error('network timeout');});
      const first=await processReminderDeliveries(dual.db1,client,{now:SEND_AT_PASSED,pause:noPause,resolveClient:async()=>client});
      expect(first).toEqual({succeeded:0,skipped:0,retrying:0,failed:1,held:0});
      const before=dual.raw1.prepare("SELECT id,line_retry_key,attempt_count,status,last_error_code FROM reminder_delivery_runs WHERE friend_reminder_id='FR-d1'").get();
      expect(before).toMatchObject({status:'permanent_failed',last_error_code:'delivery_unknown',attempt_count:1});
      await processReminderDeliveries(dual.db2,client,{now:new Date(SEND_AT_PASSED.getTime()+30*60_000),pause:noPause,resolveClient:async()=>client});
      expect(pushes).toHaveLength(1);
      expect(dual.raw1.prepare("SELECT id,line_retry_key,attempt_count,status,last_error_code FROM reminder_delivery_runs WHERE friend_reminder_id='FR-d1'").get()).toEqual(before);
      expect(dual.raw1.prepare("SELECT COUNT(*) AS c FROM friend_reminder_deliveries WHERE friend_reminder_id='FR-d1'").get()).toEqual({c:0});
    }finally{dual.cleanup();}
  });

  it('push後・確定前の取消は成功にせず、自動再送可能な状態にも混ぜない', async () => {
    const dual = openDualDb();
    try {
      seedBookingCancelTarget(dual.raw1);
      seedBookingReminderPair(dual.raw1);
      // 外部送信の直後・確定の直前に、別接続の取消が確定する。
      // 届いたかどうかが曖昧なため、送り直させてはいけない。
      const { pushes, client } = makePushRecorder(() => {
        dual.raw2.prepare(
          `UPDATE friend_reminders SET status = 'cancelled' WHERE id = 'FR-d1'`,
        ).run();
        return { requestId: 'REQ-1' };
      });

      await processReminderDeliveries(dual.db1, client, {
        now: SEND_AT_PASSED,
        pause: noPause,
        resolveClient: async () => client,
      });
      expect(pushes).toHaveLength(1);
      const run = dual.raw1.prepare(
        `SELECT status FROM reminder_delivery_runs WHERE friend_reminder_id = 'FR-d1'`,
      ).get() as { status: string };
      // 取消後の送信を成功として記録しない。
      expect(run.status).not.toBe('succeeded');
      // cron が拾い直す状態にも戻さない (送達不明を自動再送と混ぜない)。
      expect(['queued', 'retry_wait']).not.toContain(run.status);

      const again = await processReminderDeliveries(dual.db2, client, {
        now: new Date(SEND_AT_PASSED.getTime() + 30 * 60_000),
        pause: noPause,
        resolveClient: async () => client,
      });
      expect(pushes).toHaveLength(1);
      expect(again.succeeded).toBe(0);
    } finally {
      dual.cleanup();
    }
  });
});

describe('途中失敗の後の再実行で全通知が取消へそろう (自主検証)', () => {
  it('予約: 旧表の取消だけ落ちても、同じ取消要求の再送でそろう', async () => {
    const dual = openDualDb();
    try {
      seedBookingCancelTarget(dual.raw1);
      seedBookingReminderPair(dual.raw1);
      // 旧表の取消だけ1回落とす。fence は通り、予約は取消ずみになる。
      let failOnce = true;
      const faulty = dual.faultyDb1((sql) =>
        sql.includes('UPDATE booking_reminders') && failOnce ? (failOnce = false, true) : false,
      );
      expect((await cancelBooking(faulty)).status).toBe(500);
      expect(dual.raw1.prepare(`SELECT status FROM bookings WHERE id = 'RB9'`).get())
        .toEqual({ status: 'cancelled' });
      expect(dual.raw1.prepare(`SELECT status FROM friend_reminders WHERE id = 'FR-d1'`).get())
        .toEqual({ status: 'cancelled' });
      // 途中失敗の残り: 旧表だけ未取消。
      expect(dual.raw1.prepare(`SELECT status FROM booking_reminders WHERE id = 'LEG-d1'`).get())
        .toEqual({ status: 'pending' });

      // 同じ取消要求の再送で、旧表も取消へそろう。
      expect((await cancelBooking(dual.db1)).status).toBe(200);
      expect(dual.raw1.prepare(`SELECT status FROM booking_reminders WHERE id = 'LEG-d1'`).get())
        .toEqual({ status: 'cancelled' });
    } finally {
      dual.cleanup();
    }
  });

  it('予約: 一時失敗で failed に落ちた旧表も取消でそろう', async () => {
    const dual = openDualDb();
    try {
      seedBookingCancelTarget(dual.raw1);
      seedBookingReminderPair(dual.raw1);
      // 送信の一時失敗で failed に落ちた行 (再試行の残りあり)。
      dual.raw1.prepare(
        `UPDATE booking_reminders SET status = 'failed', retry_count = 1 WHERE id = 'LEG-d1'`,
      ).run();
      expect((await cancelBooking(dual.db1)).status).toBe(200);
      expect(dual.raw1.prepare(`SELECT status FROM booking_reminders WHERE id = 'LEG-d1'`).get())
        .toEqual({ status: 'cancelled' });
    } finally {
      dual.cleanup();
    }
  });

  it('イベント (LIFF本人): 旧表の取消だけ落ちても、再送でそろう', async () => {
    const dual = openDualDb();
    try {
      seedLiffCancelTarget(dual.raw1);
      const cancel = (db: D1Database) => {
        const { app, env } = makeEventsApp(db);
        return app.request('/api/liff/events/me/eb-l1/cancel?liffId=L9', {
          method: 'POST',
          headers: { Authorization: 'Bearer test' },
        }, env);
      };
      let failOnce = true;
      const faulty = dual.faultyDb1((sql) =>
        sql.includes('UPDATE event_booking_reminders') && failOnce
          ? (failOnce = false, true)
          : false,
      );
      expect((await cancel(faulty)).status).toBe(500);
      expect(dual.raw1.prepare(`SELECT status FROM event_bookings WHERE id = 'eb-l1'`).get())
        .toEqual({ status: 'cancelled' });
      expect(dual.raw1.prepare(`SELECT status FROM friend_reminders WHERE id = 'FR-l1'`).get())
        .toEqual({ status: 'cancelled' });
      expect(dual.raw1.prepare(`SELECT status FROM event_booking_reminders WHERE id = 'LEG-l1'`).get())
        .toEqual({ status: 'pending' });

      expect((await cancel(dual.db1)).status).toBe(200);
      expect(dual.raw1.prepare(`SELECT status FROM event_booking_reminders WHERE id = 'LEG-l1'`).get())
        .toEqual({ status: 'cancelled' });
    } finally {
      dual.cleanup();
    }
  });

  it('イベント (管理者取消): 旧表の取消だけ落ちても、再送でそろう', async () => {
    const dual = openDualDb();
    try {
      seedLiffCancelTarget(dual.raw1);
      const cancel = (db: D1Database) => {
        const { app, env } = makeEventsApp(db);
        return app.request(
          '/api/events/admin/events/ev-9/bookings/eb-l1/cancel?account_id=account-9',
          { method: 'POST' },
          env,
        );
      };
      let failOnce = true;
      const faulty = dual.faultyDb1((sql) =>
        sql.includes('UPDATE event_booking_reminders') && failOnce
          ? (failOnce = false, true)
          : false,
      );
      expect((await cancel(faulty)).status).toBe(500);
      expect(dual.raw1.prepare(`SELECT status FROM event_bookings WHERE id = 'eb-l1'`).get())
        .toEqual({ status: 'cancelled' });
      expect(dual.raw1.prepare(`SELECT status FROM event_booking_reminders WHERE id = 'LEG-l1'`).get())
        .toEqual({ status: 'pending' });

      expect((await cancel(dual.db1)).status).toBe(200);
      expect(dual.raw1.prepare(`SELECT status FROM event_booking_reminders WHERE id = 'LEG-l1'`).get())
        .toEqual({ status: 'cancelled' });
    } finally {
      dual.cleanup();
    }
  });
});

// 逆変異で赤にならなかった保護の見張りを足す。
// (C4 claim時のactive確認 / C6 配信ループ先頭のactive確認 /
//  C7 Calendar実行直前の予約状態の再確認 が素通りしていた)
describe('取消チェックの各層を個別に見張る (自主検証)', () => {
  it('取消ずみの登録には送信権を渡さない (claimの原子的確認)', async () => {
    const dual = openDualDb();
    try {
      seedBookingCancelTarget(dual.raw1);
      seedBookingReminderPair(dual.raw1);
      // 配信対象の読み出し (active) から claim までの間に取消が確定した状況。
      dual.raw2.prepare(
        `UPDATE friend_reminders SET status = 'cancelled' WHERE id = 'FR-d1'`,
      ).run();

      const run = await claimReminderDeliveryRun(dual.db1, {
        lineAccountId: 'acc1',
        reminderId: 'rb-rule',
        friendReminderId: 'FR-d1',
        friendId: 'f1',
        reminderStepId: 'rb-step',
        scheduledAt: '2026-09-20T00:00:00.000Z',
        now: '2026-09-20T00:30:00.000Z',
        leaseExpiresAt: '2026-09-20T00:35:00.000Z',
      });
      // 握れない。残った実行行はその場で止め、貸出も残さない。
      expect(run).toBeNull();
      expect(dual.raw1.prepare(
        `SELECT status, lease_expires_at FROM reminder_delivery_runs
          WHERE friend_reminder_id = 'FR-d1'`,
      ).get()).toEqual({ status: 'cancelled', lease_expires_at: null });
    } finally {
      dual.cleanup();
    }
  });

  it('claim後に取消が確定した登録は、残りの通に実行行を作らず登録ごと飛ばす', async () => {
    const dual = openDualDb();
    try {
      seedBookingCancelTarget(dual.raw1);
      dual.raw1.exec(`
        INSERT INTO friends (id, line_user_id, display_name, line_account_id, is_following)
        VALUES ('f2','U2','次郎','acc1',1);
        INSERT INTO reminders
          (id, name, line_account_id, is_active, trigger_type, delivery_mode, lifecycle_status)
        VALUES ('rb-rule2','rule2','acc1',1,'booking','countdown','published');
        INSERT INTO reminder_steps (id, reminder_id, offset_minutes, message_type, message_content)
        VALUES ('rb2-step1','rb-rule2',-120,'text','1通目'),
               ('rb2-step2','rb-rule2',-60,'text','2通目');
        INSERT INTO friend_reminders (id, friend_id, reminder_id, target_date, status, source_kind, source_id, source_event_id, created_at, updated_at) VALUES ('FR-d1','f1','rb-rule','2026-09-20T01:00:00.000Z','active','booking','RB9','RB9','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z'),
               ('FR-d2','f2','rb-rule2','2026-09-20T01:00:00.000Z','active','booking','RB10','RB10','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');
      `);
      // 1件目の送信が済んだら武装し、2件目の claim が成立した直後に
      // 別接続の取消を割り込ませる (claim と登録確認の間の窓)。
      let armed = false;
      const { pushes, client } = makePushRecorder(() => {
        armed = true;
        return { requestId: 'REQ-1' };
      });
      const hooked = dual.hookedDb1((sql) => {
        if (!armed || !sql.includes("SET status = 'claimed'")) return;
        armed = false;
        dual.raw2.prepare(
          `UPDATE friend_reminders SET status = 'cancelled' WHERE id = 'FR-d2'`,
        ).run();
      });

      const result = await processReminderDeliveries(hooked, client, {
        now: SEND_AT_PASSED,
        pause: noPause,
        resolveClient: async () => client,
      });

      expect(pushes.map((p) => p.userId)).toEqual(['U1']);
      expect(result).toEqual({ succeeded: 1, skipped: 1, retrying: 0, failed: 0, held: 0 });
      // 取消ずみの登録は残りの通へ進まない (実行行を増やさない)。
      expect(dual.raw1.prepare(
        `SELECT COUNT(*) AS c FROM reminder_delivery_runs WHERE friend_reminder_id = 'FR-d2'`,
      ).get()).toEqual({ c: 1 });
      expect(dual.raw1.prepare(
        `SELECT status FROM reminder_delivery_runs WHERE friend_reminder_id = 'FR-d2'`,
      ).get()).toEqual({ status: 'cancelled' });
      expect(dual.raw1.prepare(
        `SELECT COUNT(*) AS c FROM friend_reminder_deliveries WHERE friend_reminder_id = 'FR-d2'`,
      ).get()).toEqual({ c: 0 });
    } finally {
      dual.cleanup();
    }
  });

  it('確定のままの予約は、Calendar削除の台帳行があっても予定を消さない', async () => {
    const dual = openDualDb();
    try {
      seedBookingCancelTarget(dual.raw1);
      // RB10 は confirmed かつ外部予定つき。409 で巻き戻した後の残留台帳や、
      // 再確定した予約に古い行が残った状況を表す。
      const { enqueueCalendarDeleteOperation } = await import(
        '../features/booking/booking-calendar-sync.js'
      );
      await enqueueCalendarDeleteOperation(dual.db1, { bookingId: 'RB10', lineAccountId: 'acc1' });
      const removed: string[] = [];
      const drained = await processPendingCalendarDeleteOperations(dual.db2, {
        now: new Date('2026-09-10T00:00:00.000Z'),
        remove: async (bookingId) => {
          removed.push(bookingId);
        },
      });
      // 実行の直前に予約状態を見るため、外部削除は呼ばれない。
      expect(removed).toEqual([]);
      expect(drained).toEqual({ processed: 1, succeeded: 0, retrying: 0, skipped: 1 });
      expect(dual.raw1.prepare(
        `SELECT status FROM booking_operation_runs WHERE booking_id = 'RB10'`,
      ).get()).toEqual({ status: 'skipped' });
      expect(dual.raw1.prepare(
        `SELECT external_event_id FROM bookings WHERE id = 'RB10'`,
      ).get()).toEqual({ external_event_id: 'gcal-ev-10' });
    } finally {
      dual.cleanup();
    }
  });
});

// =============================================================================
// 旧表 (booking_reminders / event_booking_reminders) の送信直前 fence
//
// 旧表の cron は対象行を `b.status = 'confirmed'` 付きで一括読み出しするが、
// この条件は読み出し時にしか効かない。読み出しから各行の送信までの間
// (最大100件ループの全区間) に取消が確定しても止まらず、取消成功後に
// 外部送信が起きていた。の verifyClaimedRunBeforeSend と同じ形で、
// 送る直前に1文で予約 / イベント予約の状態を確かめる。
// =============================================================================

function seedLegacyBookingReminder(raw: Database.Database) {
  raw.exec(`
    INSERT INTO booking_reminders (id, booking_id, kind, scheduled_at, status, retry_count)
    VALUES ('LEG-b1','RB9','hours_before','2026-09-19T01:00:00.000Z','pending',0);
  `);
}

/** 旧表 cron の対象読み出し (この直後が取消の割込み窓)。 */
const LEGACY_BOOKING_DUE_SQL = 'FROM booking_reminders r';
const LEGACY_EVENT_DUE_SQL = 'FROM event_booking_reminders r';
// RB9 は 2026-09-20T01:00Z 開始。予定時刻を過ぎ、開始前の時刻で回す。
const LEGACY_NOW = new Date('2026-09-19T02:00:00.000Z');

describe('旧表の取消後送信 (自主検証)', () => {
  it('予約: 読み出しの後・送信の直前に取消が確定したら、外部送信しない', async () => {
    const dual = openDualDb();
    try {
      seedBookingCancelTarget(dual.raw1);
      seedLegacyBookingReminder(dual.raw1);
      const sentTo: string[] = [];
      let cancelStatus = 0;
      // 対象行の読み出しが済んだ直後に、別接続の実 route が取消を確定させる。
      const hooked = dual.hookedDb1(async (sql) => {
        if (!sql.includes(LEGACY_BOOKING_DUE_SQL) || cancelStatus !== 0) return;
        cancelStatus = (await cancelBooking(dual.db2)).status;
      });

      const result = await processDueReminders(hooked, {
        now: LEGACY_NOW,
        sender: async (p) => {
          sentTo.push(p.toLineUserId);
        },
      });

      // 取消は成功している (route は 200、予約は cancelled)。
      expect(cancelStatus).toBe(200);
      expect(dual.raw1.prepare(`SELECT status FROM bookings WHERE id = 'RB9'`).get())
        .toEqual({ status: 'cancelled' });
      // その後は1通も外部へ渡さない。
      expect(sentTo).toEqual([]);
      expect(result).toEqual({ sent: 0, failed: 0 });
      expect(dual.raw1.prepare(
        `SELECT status, sent_at FROM booking_reminders WHERE id = 'LEG-b1'`,
      ).get()).toEqual({ status: 'cancelled', sent_at: null });
    } finally {
      dual.cleanup();
    }
  });

  it('予約: 取消が無ければ従来どおり送り、送信ずみにする', async () => {
    const dual = openDualDb();
    try {
      seedBookingCancelTarget(dual.raw1);
      seedLegacyBookingReminder(dual.raw1);
      const sentTo: string[] = [];
      const result = await processDueReminders(dual.db1, {
        now: LEGACY_NOW,
        sender: async (p) => {
          sentTo.push(p.toLineUserId);
        },
      });
      expect(sentTo).toEqual(['U1']);
      expect(result).toEqual({ sent: 1, failed: 0 });
      expect(dual.raw1.prepare(
        `SELECT status FROM booking_reminders WHERE id = 'LEG-b1'`,
      ).get()).toEqual({ status: 'sent' });
    } finally {
      dual.cleanup();
    }
  });

  it('予約: 2つのcronが同時に回っても、外部送信は1回だけ', async () => {
    const dual = openDualDb();
    try {
      seedBookingCancelTarget(dual.raw1);
      seedLegacyBookingReminder(dual.raw1);
      const sentTo: string[] = [];
      const run = (db: D1Database) => processDueReminders(db, {
        now: LEGACY_NOW,
        sender: async (p) => {
          sentTo.push(p.toLineUserId);
        },
      });
      const [a, b] = await Promise.all([run(dual.db1), run(dual.db2)]);
      expect(sentTo).toEqual(['U1']);
      expect(a.sent + b.sent).toBe(1);
      expect(a.failed + b.failed).toBe(0);
    } finally {
      dual.cleanup();
    }
  });

  it('イベント: 読み出しの後・送信の直前に取消が確定したら、外部送信しない', async () => {
    const dual = openDualDb();
    try {
      seedLiffCancelTarget(dual.raw1);
      // 旧表 cron の対象は確定ずみの予約。
      confirmLegacyEventReminder(dual.raw1);
      const sentTo: string[] = [];
      let cancelStatus = 0;
      const cancelEvent = (db: D1Database) => {
        const { app, env } = makeEventsApp(db);
        return app.request(
          '/api/events/admin/events/ev-9/bookings/eb-l1/cancel?account_id=account-9',
          { method: 'POST' },
          env,
        );
      };
      const hooked = dual.hookedDb1(async (sql) => {
        if (!sql.includes(LEGACY_EVENT_DUE_SQL) || cancelStatus !== 0) return;
        cancelStatus = (await cancelEvent(dual.db2)).status;
      });

      const result = await processDueEventReminders(hooked, {
        // LEG-l1 は 2099-05-31T10:00Z 予定、開催は 2099-06-01T10:00Z。
        now: new Date('2099-05-31T12:00:00.000Z'),
        sender: async (p) => {
          sentTo.push(p.toLineUserId);
        },
      });

      expect(cancelStatus).toBe(200);
      expect(dual.raw1.prepare(`SELECT status FROM event_bookings WHERE id = 'eb-l1'`).get())
        .toEqual({ status: 'cancelled' });
      expect(sentTo).toEqual([]);
      expect(result).toEqual({ sent: 0, failed: 0 });
      expect(dual.raw1.prepare(
        `SELECT status, sent_at FROM event_booking_reminders WHERE id = 'LEG-l1'`,
      ).get()).toEqual({ status: 'cancelled', sent_at: null });
    } finally {
      dual.cleanup();
    }
  });

  it('イベント: 取消が無ければ従来どおり送り、送信ずみにする', async () => {
    const dual = openDualDb();
    try {
      seedLiffCancelTarget(dual.raw1);
      confirmLegacyEventReminder(dual.raw1);
      const sentTo: string[] = [];
      const result = await processDueEventReminders(dual.db1, {
        now: new Date('2099-05-31T12:00:00.000Z'),
        sender: async (p) => {
          sentTo.push(p.toLineUserId);
        },
      });
      expect(sentTo).toEqual(['U9']);
      expect(result).toEqual({ sent: 1, failed: 0 });
      expect(dual.raw1.prepare(
        `SELECT status FROM event_booking_reminders WHERE id = 'LEG-l1'`,
      ).get()).toEqual({ status: 'sent' });
    } finally {
      dual.cleanup();
    }
  });

  it('イベント: 結果不明は1回だけ数え、次の巡回で再送しない', async () => {
    const dual = openDualDb();
    try {
      seedLiffCancelTarget(dual.raw1);
      confirmLegacyEventReminder(dual.raw1);
      const sender = vi.fn(async () => { throw new Error('line down'); });
      const result = await processDueEventReminders(dual.db1, {
        now: new Date('2099-05-31T12:00:00.000Z'),
        sender,
      });
      expect(result).toEqual({ sent: 0, failed: 1 });
      // fence の claim で1回だけ加算する (失敗記録で二重に足さない)。
      expect(dual.raw1.prepare(
        `SELECT status, retry_count FROM event_booking_reminders WHERE id = 'LEG-l1'`,
      ).get()).toEqual({ status: 'failed_permanent', retry_count: 1 });
      expect(await processDueEventReminders(dual.db1, { now: new Date('2099-05-31T12:01:00.000Z'), sender })).toEqual({ sent: 0, failed: 0 });
      expect(sender).toHaveBeenCalledTimes(1);
    } finally {
      dual.cleanup();
    }
  });

  it('予約: 結果不明は1回だけ数え、次の巡回で再送しない', async () => {
    const dual = openDualDb();
    try {
      seedBookingCancelTarget(dual.raw1);
      seedLegacyBookingReminder(dual.raw1);
      const sender = vi.fn(async () => { throw new Error('line down'); });
      const result = await processDueReminders(dual.db1, {
        now: LEGACY_NOW,
        sender,
      });
      expect(result).toEqual({ sent: 0, failed: 1 });
      expect(dual.raw1.prepare(
        `SELECT status, retry_count FROM booking_reminders WHERE id = 'LEG-b1'`,
      ).get()).toEqual({ status: 'failed_permanent', retry_count: 1 });
      expect(await processDueReminders(dual.db1, { now: new Date(LEGACY_NOW.getTime() + 60_000), sender })).toEqual({ sent: 0, failed: 0 });
      expect(sender).toHaveBeenCalledTimes(1);
    } finally {
      dual.cleanup();
    }
  });
});

// 取消 route は「予約の状態を先に倒し、旧表の取消は fence 成功の後」に
// 置いている (409 で完全 rollback するため)。その間に旧表 cron の送信が
// 挟まると、旧表の行はまだ pending のままなので、行の状態だけでは止まらない。
// 送信直前に予約そのものの状態を見ていることを、この2件が見張る。
describe('旧表の送信直前に予約状態そのものを見る (自主検証)', () => {
  it('予約: 取消が旧表まで届く前でも、確定でなくなった予約へは送らない', async () => {
    const dual = openDualDb();
    try {
      seedBookingCancelTarget(dual.raw1);
      seedLegacyBookingReminder(dual.raw1);
      // 取消 route の旧表 UPDATE だけ落とす。予約は cancelled になり、
      // 旧表の行は pending のまま残る (途中失敗の残り)。
      let failOnce = true;
      const faultyRoute = dual.faultyDb2((sql) =>
        sql.includes('UPDATE booking_reminders') && failOnce ? (failOnce = false, true) : false,
      );
      const sentTo: string[] = [];
      let cancelStatus = 0;
      const hooked = dual.hookedDb1(async (sql) => {
        if (!sql.includes(LEGACY_BOOKING_DUE_SQL) || cancelStatus !== 0) return;
        cancelStatus = (await cancelBooking(faultyRoute)).status;
      });

      const result = await processDueReminders(hooked, {
        now: LEGACY_NOW,
        sender: async (p) => {
          sentTo.push(p.toLineUserId);
        },
      });

      expect(cancelStatus).toBe(500);
      expect(dual.raw1.prepare(`SELECT status FROM bookings WHERE id = 'RB9'`).get())
        .toEqual({ status: 'cancelled' });
      // 旧表の行はまだ未取消。行の状態だけでは止まらない状況。
      expect(dual.raw1.prepare(
        `SELECT status FROM booking_reminders WHERE id = 'LEG-b1'`,
      ).get()).toEqual({ status: 'pending' });
      // それでも外部送信はしない (送信直前に予約そのものを見ている)。
      expect(sentTo).toEqual([]);
      expect(result).toEqual({ sent: 0, failed: 0 });
      expect(dual.raw1.prepare(
        `SELECT status, sent_at, retry_count FROM booking_reminders WHERE id = 'LEG-b1'`,
      ).get()).toEqual({ status: 'pending', sent_at: null, retry_count: 0 });
    } finally {
      dual.cleanup();
    }
  });

  it('イベント: 取消が旧表まで届く前でも、確定でなくなった予約へは送らない', async () => {
    const dual = openDualDb();
    try {
      seedLiffCancelTarget(dual.raw1);
      confirmLegacyEventReminder(dual.raw1);
      let failOnce = true;
      const faultyRoute = dual.faultyDb2((sql) =>
        sql.includes('UPDATE event_booking_reminders') && failOnce
          ? (failOnce = false, true)
          : false,
      );
      const sentTo: string[] = [];
      let cancelStatus = 0;
      const hooked = dual.hookedDb1(async (sql) => {
        if (!sql.includes(LEGACY_EVENT_DUE_SQL) || cancelStatus !== 0) return;
        const { app, env } = makeEventsApp(faultyRoute);
        cancelStatus = (await app.request(
          '/api/events/admin/events/ev-9/bookings/eb-l1/cancel?account_id=account-9',
          { method: 'POST' },
          env,
        )).status;
        expect(dual.raw1.prepare(
          `SELECT status, sent_at, retry_count FROM event_booking_reminders WHERE id='LEG-l1'`,
        ).get()).toEqual({ status:'pending',sent_at:null,retry_count:0 });
      });

      const result = await processDueEventReminders(hooked, {
        now: new Date('2099-05-31T12:00:00.000Z'),
        sender: async (p) => {
          sentTo.push(p.toLineUserId);
        },
      });

      expect(cancelStatus).toBe(500);
      expect(dual.raw1.prepare(`SELECT status FROM event_bookings WHERE id = 'eb-l1'`).get())
        .toEqual({ status: 'cancelled' });
      expect(dual.raw1.prepare(
        `SELECT status FROM event_booking_reminders WHERE id = 'LEG-l1'`,
      ).get()).toEqual({ status: 'cancelled' });
      expect(sentTo).toEqual([]);
      expect(result).toEqual({ sent: 0, failed: 0 });
      expect(dual.raw1.prepare(
        `SELECT status, sent_at, retry_count FROM event_booking_reminders WHERE id = 'LEG-l1'`,
      ).get()).toEqual({ status: 'cancelled', sent_at: null, retry_count: 0 });
    } finally {
      dual.cleanup();
    }
  });
});

// =============================================================================
// 恒久失敗の打ち切り
//
// 旧表 cron の due SELECT は LIMIT 100 で ORDER BY が無い。直らない行を
// failed のまま溜めると、正常なリマインダが押し出されて送られなくなる。
// REMINDER_MAX_RETRY で failed_permanent へ打ち切る保証を見張る。
// fence の前で投げた失敗 (資格情報が復号できない等) も数に入れること。
// =============================================================================

/** 復号できない資格情報。fence より前の resolveLineCredential で投げる。 */
function breakAccountCredential(raw: Database.Database, accountId: string) {
  raw.prepare(
    `UPDATE line_accounts
        SET channel_access_token = '', channel_access_token_encrypted = 'not-decryptable'
      WHERE id = ?`,
  ).run(accountId);
}

describe('旧表の恒久失敗を上限で打ち切る (自主検証)', () => {
  it('予約: fence前の失敗でも回数を数え、上限で failed_permanent にして滞留させない', async () => {
    const dual = openDualDb();
    try {
      seedBookingCancelTarget(dual.raw1);
      seedLegacyBookingReminder(dual.raw1);
      breakAccountCredential(dual.raw1, 'acc1');
      const sentTo: string[] = [];
      const run = () => processDueReminders(dual.db1, {
        now: LEGACY_NOW,
        sender: async (p) => {
          sentTo.push(p.toLineUserId);
        },
      });
      const readRow = () => dual.raw1.prepare(
        `SELECT status, retry_count FROM booking_reminders WHERE id = 'LEG-b1'`,
      ).get();

      // 1回目・2回目は再試行余地あり。回数が伸びることが打ち切りの前提。
      expect(await run()).toEqual({ sent: 0, failed: 1 });
      expect(readRow()).toEqual({ status: 'failed', retry_count: 1 });
      expect(await run()).toEqual({ sent: 0, failed: 1 });
      expect(readRow()).toEqual({ status: 'failed', retry_count: 2 });
      // 3回目 (= REMINDER_MAX_RETRY) で打ち切る。
      expect(await run()).toEqual({ sent: 0, failed: 1 });
      expect(readRow()).toEqual({ status: 'failed_permanent', retry_count: 3 });
      // 以後は対象に入らない (滞留しない)。
      expect(await run()).toEqual({ sent: 0, failed: 0 });
      expect(readRow()).toEqual({ status: 'failed_permanent', retry_count: 3 });
      expect(sentTo).toEqual([]);
    } finally {
      dual.cleanup();
    }
  });

  it('イベント: fence前の失敗でも回数を数え、上限で failed_permanent にする', async () => {
    const dual = openDualDb();
    try {
      seedLiffCancelTarget(dual.raw1);
      confirmLegacyEventReminder(dual.raw1);
      breakAccountCredential(dual.raw1, 'account-9');
      const sentTo: string[] = [];
      let attemptTime=Date.parse('2099-05-31T12:00:00.000Z');
      const run = () => processDueEventReminders(dual.db1, {
        now: new Date((attemptTime+=60_000)),
        sender: async (p) => {
          sentTo.push(p.toLineUserId);
        },
      });
      const readRow = () => dual.raw1.prepare(
        `SELECT status, retry_count FROM event_booking_reminders WHERE id = 'LEG-l1'`,
      ).get();

      expect(await run()).toEqual({ sent: 0, failed: 1 });
      expect(readRow()).toEqual({ status: 'failed', retry_count: 1 });
      expect(await run()).toEqual({ sent: 0, failed: 1 });
      expect(readRow()).toEqual({ status: 'failed', retry_count: 2 });
      expect(await run()).toEqual({ sent: 0, failed: 1 });
      expect(readRow()).toEqual({ status: 'failed_permanent', retry_count: 3 });
      expect(await run()).toEqual({ sent: 0, failed: 0 });
      expect(sentTo).toEqual([]);
    } finally {
      dual.cleanup();
    }
  });

  it('予約: 直らない行が溜まっても、正常なリマインダを押し出さない', async () => {
    const dual = openDualDb();
    try {
      seedBookingCancelTarget(dual.raw1);
      breakAccountCredential(dual.raw1, 'acc1');
      // 直らない行を1件と、後から復旧するアカウントの正常な行を1件。
      dual.raw1.exec(`
        INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
        VALUES ('acc2','channel-2','B店','token2','secret2');
        INSERT INTO friends (id, line_user_id, display_name, line_account_id, is_following)
        VALUES ('f3','U3','三郎','acc2',1);
        INSERT INTO bookings (
          id, line_account_id, friend_id, staff_id, menu_id,
          starts_at, ends_at, block_ends_at, status, price_at_booking, requested_at
        ) VALUES (
          'RB11','acc2','f3','s1','m1',
          '2026-09-20T03:00:00.000Z','2026-09-20T04:00:00.000Z','2026-09-20T04:00:00.000Z',
          'confirmed',8000,'2026-09-01T00:00:00.000Z'
        );
        INSERT INTO booking_reminders (id, booking_id, kind, scheduled_at, status, retry_count)
        VALUES ('LEG-b1','RB9','hours_before','2026-09-19T01:00:00.000Z','pending',0),
               ('LEG-b2','RB11','hours_before','2026-09-19T01:00:00.000Z','pending',0);
      `);
      const sentTo: string[] = [];
      const run = () => processDueReminders(dual.db1, {
        now: LEGACY_NOW,
        sender: async (p) => {
          sentTo.push(p.toLineUserId);
        },
      });
      // 正常な行は初回で送れる。壊れた行だけが失敗する。
      expect(await run()).toEqual({ sent: 1, failed: 1 });
      expect(sentTo).toEqual(['U3']);
      // 壊れた行は上限まで数えて終端へ落ち、以後は対象から外れる。
      await run();
      await run();
      expect(dual.raw1.prepare(
        `SELECT status FROM booking_reminders WHERE id = 'LEG-b1'`,
      ).get()).toEqual({ status: 'failed_permanent' });
      expect(dual.raw1.prepare(
        `SELECT COUNT(*) AS c FROM booking_reminders WHERE status IN ('pending','failed')`,
      ).get()).toEqual({ c: 0 });
    } finally {
      dual.cleanup();
    }
  });
});
