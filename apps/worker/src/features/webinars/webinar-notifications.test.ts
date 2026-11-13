import { describe, expect, test, vi } from 'vitest';
import { asD1 } from '../../test-utils/d1-atomic.js';

import { createTestD1, insertFriend, type SqliteD1 } from '../../test-utils/d1-sqlite.js';
import {
  calculateWebinarNotificationSchedule,
  enqueueWebinarCompletedNotification,
  getWebinarNotificationOverview,
  processWebinarNotificationJobs,
  registerWebinarSession,
  saveWebinarNotificationSettings,
  sendWebinarNotificationTest,
  webinarTestRecipientPreview,
  type WebinarNotificationSettingsInput,
} from './webinar-notifications.js';

const SETTINGS: WebinarNotificationSettingsInput = {
  registrationEnabled: true,
  dayBeforeEnabled: true,
  dayBeforeTime: '20:00',
  hourBeforeEnabled: true,
  hourBeforeMinutes: 60,
  startEnabled: true,
  missedEnabled: true,
  missedTime: '10:00',
  completedEnabled: true,
};

const NOW = new Date('2026-08-29T00:00:00.000Z');
const SESSION = Math.floor(Date.parse('2026-09-02T02:00:00.000Z') / 1000); // JST 11:00

function seedBase(raw: import('better-sqlite3').Database) {
  raw.prepare(
    `INSERT INTO line_accounts
       (id, channel_id, name, channel_access_token, channel_secret, is_active, liff_id)
     VALUES ('account-1', 'channel-1', 'テスト', 'token-1', 'secret-1', 1, 'liff-1')`,
  ).run();
  raw.prepare(
    `INSERT INTO account_settings (id, line_account_id, key, value)
     VALUES ('feature-webinars', 'account-1', 'feature.webinars', '{"enabled":true}')`,
  ).run();
  raw.prepare(
    `INSERT INTO webinars
       (id, account_id, title, slug, status, duration_seconds, schedule_json, created_at, updated_at)
     VALUES ('webinar-1', 'account-1', '商品説明会', 'product-live', 'active', 3600, '[]', ?, ?)`,
  ).run(NOW.toISOString(), NOW.toISOString());
  insertFriend(raw, 'friend-1', { line_account_id: 'account-1', line_user_id: 'U001' });
}

describe('緊急停止と通知取得・送信の競合 (#745)', () => {
  const epoch = Math.floor(NOW.getTime() / 1000);
  const deliveryOptions = {
    now: NOW, proxyBaseUrl: 'https://worker.example.com',
    defaultAccessToken: 'fallback', defaultLiffId: null,
  };

  async function fixture(count = 1) {
    const store = createTestD1();
    seedBase(store.raw);
    await saveWebinarNotificationSettings(store.db, 'webinar-1', SETTINGS, NOW);
    for (let index = 1; index <= count; index++) {
      if (index > 1) insertFriend(store.raw, `friend-${index}`, {
        line_account_id: 'account-1', line_user_id: `U${index}`,
      });
      await registerWebinarSession(store.db, 'webinar-1', `friend-${index}`, SESSION, NOW);
    }
    store.raw.prepare(`UPDATE webinar_notification_jobs SET scheduled_at=?, next_retry_at=? WHERE kind='day_before'`)
      .run(epoch, epoch);
    store.raw.prepare(`INSERT INTO operation_control_sets
      (scope_key, line_account_id, version, states_json, updated_at)
      VALUES ('account-1', 'account-1', 1, '{"reminder_dispatch":"running"}', ?)`)
      .run(NOW.toISOString());
    return store;
  }

  function stop(store: SqliteD1, stopped = true) {
    store.raw.prepare(`UPDATE operation_control_sets SET states_json=? WHERE scope_key='account-1'`)
      .run(JSON.stringify({ reminder_dispatch: stopped ? 'stopped' : 'running' }));
  }

  function state(store: SqliteD1) {
    return store.raw.prepare(`SELECT status, attempt_count, lease_expires_at, next_retry_at, last_error_code
      FROM webinar_notification_jobs WHERE kind='day_before'`).get();
  }

  // 故障点だけを差し込む。SELECT/UPDATE/changesはすべて実SQLiteの結果を使う。
  function intercept(
    db: D1Database,
    hook: (sql: string, method: string, run: () => Promise<unknown>) => Promise<unknown>,
  ): D1Database {
    const wrap = (sql: string, statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, {
      get(target, key) {
        if (key === 'bind') return (...args: unknown[]) => wrap(sql, target.bind(...args));
        if (key === 'run' || key === 'all' || key === 'first') {
          return () => hook(sql, key, () => target[key]());
        }
        return Reflect.get(target, key);
      },
    });
    return new Proxy(db, {
      get(target, key) {
        if (key === 'prepare') return (sql: string) => wrap(sql, target.prepare(sql));
        return Reflect.get(target, key);
      },
    });
  }

  // 本物のProxy認証・友だち検索・初回チャット作成・履歴保存も同じDBへ通す。
  // 外部LINEだけ代役にし、waitUntilの記録まで待って全SQL文を数える。
  async function proxyFixture(count: number) {
    const store = await fixture(count);
    for (let index = 1; index <= count; index++) {
      store.raw.prepare('UPDATE friends SET line_user_id=? WHERE id=?')
        .run(`U${index.toString(16).padStart(32, '0')}`, `friend-${index}`);
    }
    const { lineProxy } = await import('../../routes/line-proxy.js');
    let queries = 0;
    const countedDb = intercept(store.db, async (_sql, _method, run) => {
      queries++;
      if (queries > 1000) throw new Error('D1 1000 queries per invocation exceeded');
      return run();
    });
    return {
      store,
      async tick(now = NOW) {
        queries = 0;
        // この通知専用の1000枠ではない。他cron用に500文を先に消費して検証する。
        for (let i = 0; i < 500; i++) await countedDb.prepare('SELECT 1').first();
        const pending: Promise<unknown>[] = [];
        const result = await processWebinarNotificationJobs(countedDb, {
          ...deliveryOptions,
          now,
          proxyDispatch: (request) => Promise.resolve(lineProxy.fetch(request, {
            DB: countedDb, LINE_CHANNEL_ACCESS_TOKEN: 'fallback',
          }, {
            waitUntil(promise: Promise<unknown>) { pending.push(promise); },
            passThroughOnException() {},
            props: {},
          })),
        });
        await Promise.all(pending);
        expect(queries).toBeLessThanOrEqual(1000);
        // 実経路が増えても、500文の共通枠を削って黙って通さない。
        expect(queries - 500).toBeLessThanOrEqual(400);
        return { result, queries: queries - 500 };
      },
    };
  }

  test.each([0, 20, 21])('通知%s件を20件以内ずつ処理し、続きと履歴を残す', async count => {
    const real = await proxyFixture(count);
    const upstream = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', upstream);
    try {
      expect((await real.tick()).result.sent).toBe(Math.min(count, 20));
      expect((await real.tick()).result.sent).toBe(Math.max(0, count - 20));
      expect((await real.tick()).result.sent).toBe(0);
      expect(upstream).toHaveBeenCalledTimes(count);
      expect(real.store.raw.prepare("SELECT COUNT(*) AS n FROM messages_log").get()).toEqual({ n: count });
    } finally { vi.unstubAllGlobals(); real.store.raw.close(); }
  });

  test('実Proxy込み100件をD1上限内の複数tickに分け、送信と履歴を各1回にする', async () => {
    const real = await proxyFixture(100);
    const upstream = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', upstream);
    try {
      const counts: number[] = [];
      const queries: number[] = [];
      for (let tick = 0; tick < 5; tick++) {
        const result = await real.tick();
        counts.push(result.result.sent);
        queries.push(result.queries);
        expect(result.result).toMatchObject({ failed: 0, skipped: 0, heldByStop: 0 });
      }
      expect(counts).toEqual([20, 20, 20, 20, 20]);
      // 送信直前の緊急停止判定で1件につき1問い合わせ増える。統括の停止状態は tick ごとの一括読込で取得する。
      expect(queries).toEqual([302, 302, 302, 302, 302]);
      expect((await real.tick()).result.sent).toBe(0);
      expect(upstream).toHaveBeenCalledTimes(100);
      expect(new Set(upstream.mock.calls.map(([, init]) => new Headers(init?.headers).get('X-Line-Retry-Key'))).size).toBe(100);
      expect(real.store.raw.prepare(`SELECT COUNT(*) AS n FROM webinar_notification_jobs
        WHERE kind='day_before' AND status='succeeded' AND attempt_count=1 AND lease_expires_at IS NULL`).get()).toEqual({ n: 100 });
      expect(real.store.raw.prepare('SELECT COUNT(*) AS n FROM messages_log').get()).toEqual({ n: 100 });
      expect(real.store.raw.prepare('SELECT COUNT(*) AS n FROM chats').get()).toEqual({ n: 100 });
    } finally {
      vi.unstubAllGlobals();
      real.store.raw.close();
    }
  });

  async function addAccount(store: SqliteD1, account: number, firstFriend: number, count: number) {
    store.raw.prepare(`INSERT INTO line_accounts
      (id, channel_id, name, channel_access_token, channel_secret, is_active, liff_id)
      VALUES (?, ?, '別店舗', ?, 'secret', 1, ?)`)
      .run(`account-${account}`, `channel-${account}`, `token-${account}`, `liff-${account}`);
    store.raw.prepare(`INSERT INTO account_settings (id, line_account_id, key, value)
      VALUES (?, ?, 'feature.webinars', '{"enabled":true}')`)
      .run(`feature-${account}`, `account-${account}`);
    store.raw.prepare(`INSERT INTO webinars
      (id, account_id, title, slug, status, duration_seconds, schedule_json, created_at, updated_at)
      VALUES (?, ?, '別店舗説明会', ?, 'active', 3600, '[]', ?, ?)`)
      .run(`webinar-${account}`, `account-${account}`, `live-${account}`, NOW.toISOString(), NOW.toISOString());
    await saveWebinarNotificationSettings(store.db, `webinar-${account}`, SETTINGS, NOW);
    for (let index = firstFriend; index < firstFriend + count; index++) {
      insertFriend(store.raw, `friend-${index}`, {
        line_account_id: `account-${account}`, line_user_id: `U${index.toString(16).padStart(32, '0')}`,
      });
      await registerWebinarSession(store.db, `webinar-${account}`, `friend-${index}`, SESSION, NOW);
      store.raw.prepare(`UPDATE webinar_notification_jobs SET scheduled_at=?, next_retry_at=?
        WHERE friend_id=? AND kind='day_before'`).run(epoch + 1 + index % 7, epoch + 1, `friend-${index}`);
    }
  }

  test('停止20件があっても別2アカウントへ進み、100件を予算内で予定順に各1回送る', async () => {
    const real = await proxyFixture(20);
    await addAccount(real.store, 2, 21, 40);
    await addAccount(real.store, 3, 61, 40);
    stop(real.store);
    const before = real.store.raw.prepare(`SELECT * FROM webinar_notification_jobs WHERE webinar_id='webinar-1' ORDER BY id`).all();
    const expectedOrder = (accountSql: string) => (real.store.raw.prepare(`
      SELECT f.line_user_id FROM webinar_notification_jobs j JOIN friends f ON f.id=j.friend_id
      WHERE j.kind='day_before' AND ${accountSql} ORDER BY j.scheduled_at, j.id`).all() as Array<{ line_user_id: string }>).map(row => row.line_user_id);
    const activeOrder = expectedOrder("j.webinar_id != 'webinar-1'");
    const heldOrder = expectedOrder("j.webinar_id = 'webinar-1'");
    const upstream = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', upstream);
    try {
      for (let tick = 1; tick <= 4; tick++) {
        // 実cron同様、tickの時刻も5分ずつ進める。
        expect((await real.tick(new Date(NOW.getTime() + tick * 300_000))).result)
          .toEqual({ sent: 20, failed: 0, skipped: 0, heldByStop: 0 });
      }
      expect(real.store.raw.prepare(`SELECT * FROM webinar_notification_jobs WHERE webinar_id='webinar-1' ORDER BY id`).all()).toEqual(before);
      expect(upstream.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).to)).toEqual(activeOrder);
      expect((await real.tick(new Date(NOW.getTime() + 5 * 300_000))).result)
        .toEqual({ sent: 0, failed: 0, skipped: 0, heldByStop: 20 });
      stop(real.store, false);
      expect((await real.tick(new Date(NOW.getTime() + 6 * 300_000))).result.sent).toBe(20);
      expect((await real.tick(new Date(NOW.getTime() + 7 * 300_000))).result.sent).toBe(0);
      expect(upstream.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).to)).toEqual([...activeOrder, ...heldOrder]);
      expect(new Set(upstream.mock.calls.map(([, init]) => new Headers(init?.headers).get('X-Line-Retry-Key'))).size).toBe(100);
      expect(real.store.raw.prepare(`SELECT COUNT(*) AS n FROM webinar_notification_jobs
        WHERE kind='day_before' AND status='succeeded' AND attempt_count=1 AND lease_expires_at IS NULL`).get()).toEqual({ n: 100 });
      expect(real.store.raw.prepare('SELECT COUNT(*) AS n FROM messages_log').get()).toEqual({ n: 100 });
    } finally {
      vi.unstubAllGlobals();
      real.store.raw.close();
    }
  });

  test('全体停止は全アカウントの行を保持し、全体解除後も個別停止は維持する', async () => {
    const real = await proxyFixture(20);
    await addAccount(real.store, 2, 21, 1);
    stop(real.store);
    real.store.raw.prepare(`INSERT INTO operation_control_sets
      (scope_key, line_account_id, version, states_json, updated_at)
      VALUES ('*', NULL, 1, '{"reminder_dispatch":"stopped"}', ?)`).run(NOW.toISOString());
    const before = real.store.raw.prepare('SELECT * FROM webinar_notification_jobs ORDER BY id').all();
    const upstream = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', upstream);
    try {
      const now = new Date(NOW.getTime() + 300_000);
      for (let tick = 0; tick < 2; tick++) {
        expect((await real.tick(now)).result).toEqual({ sent: 0, failed: 0, skipped: 0, heldByStop: 20 });
      }
      expect(upstream).not.toHaveBeenCalled();
      expect(real.store.raw.prepare('SELECT * FROM webinar_notification_jobs ORDER BY id').all()).toEqual(before);
      real.store.raw.prepare(`DELETE FROM operation_control_sets WHERE scope_key='*'`).run();
      expect((await real.tick(now)).result).toEqual({ sent: 1, failed: 0, skipped: 0, heldByStop: 19 });
      expect(upstream).toHaveBeenCalledTimes(1);
      expect(real.store.raw.prepare(`SELECT status, attempt_count FROM webinar_notification_jobs
        WHERE friend_id='friend-21' AND kind='day_before'`).get()).toEqual({ status: 'succeeded', attempt_count: 1 });
      expect(real.store.raw.prepare(`SELECT COUNT(*) AS n FROM webinar_notification_jobs
        WHERE webinar_id='webinar-1' AND kind='day_before' AND status='queued' AND attempt_count=0`).get()).toEqual({ n: 20 });
    } finally {
      vi.unstubAllGlobals();
      real.store.raw.close();
    }
  });

  test('停止中の正本がJSON nullでも正常アカウントを塞がず、安全側で保留する', async () => {
    const real = await proxyFixture(20);
    await addAccount(real.store, 2, 21, 1);
    real.store.raw.prepare(`UPDATE operation_control_sets
      SET states_json=' null ', active_incident_id='incident-1' WHERE scope_key='account-1'`).run();
    const before = real.store.raw.prepare(`SELECT * FROM webinar_notification_jobs WHERE webinar_id='webinar-1' ORDER BY id`).all();
    const upstream = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', upstream);
    try {
      expect((await real.tick(new Date(NOW.getTime() + 300_000))).result)
        .toEqual({ sent: 1, failed: 0, skipped: 0, heldByStop: 19 });
      expect(upstream).toHaveBeenCalledTimes(1);
      expect(real.store.raw.prepare(`SELECT * FROM webinar_notification_jobs WHERE webinar_id='webinar-1' ORDER BY id`).all()).toEqual(before);
    } finally {
      vi.unstubAllGlobals();
      real.store.raw.close();
    }
  });

  test('実Proxy送信中の停止を次tickへ持ち越し、解除後は残りだけ1回ずつ送る', async () => {
    const real = await proxyFixture(100);
    const upstream = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => {
      stop(real.store);
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', upstream);
    try {
      expect((await real.tick()).result).toEqual({ sent: 1, failed: 0, skipped: 0, heldByStop: 19 });
      expect((await real.tick()).result).toEqual({ sent: 0, failed: 0, skipped: 0, heldByStop: 20 });
      expect(upstream).toHaveBeenCalledTimes(1);
      expect(real.store.raw.prepare(`SELECT COUNT(*) AS n FROM webinar_notification_jobs
        WHERE kind='day_before' AND status='queued' AND attempt_count=0 AND lease_expires_at IS NULL`).get()).toEqual({ n: 99 });
      stop(real.store, false);
      upstream.mockImplementation(async () => new Response('{}', { status: 200 }));
      const resumed = [];
      for (let tick = 0; tick < 5; tick++) resumed.push((await real.tick()).result.sent);
      expect(resumed).toEqual([20, 20, 20, 20, 19]);
      expect((await real.tick()).result.sent).toBe(0);
      expect(upstream).toHaveBeenCalledTimes(100);
      expect(new Set(upstream.mock.calls.map(([, init]) => new Headers(init?.headers).get('X-Line-Retry-Key'))).size).toBe(100);
      expect(real.store.raw.prepare('SELECT COUNT(*) AS n FROM messages_log').get()).toEqual({ n: 100 });
    } finally {
      vi.unstubAllGlobals();
      real.store.raw.close();
    }
  });

  test('100件の1件目送信中に停止すると残り99件は未取得で残り、解除後一度ずつ届く', async () => {
    const store = await fixture(100);
    let claims = 0;
    const countedDb = intercept(store.db, async (sql, method, run) => {
      if (method === 'run' && sql.includes("SET status='claimed', attempt_count")) claims++;
      return run();
    });
    const dispatch = vi.fn(async (_request: Request) => {
      stop(store);
      return new Response('{}', { status: 200 });
    });
    expect(await processWebinarNotificationJobs(countedDb, { ...deliveryOptions, proxyDispatch: dispatch }))
      .toEqual({ sent: 1, failed: 0, skipped: 0, heldByStop: 19 });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(claims, '停止後の99件にはclaim自体を行わない').toBe(1);
    expect(store.raw.prepare(`SELECT COUNT(*) AS count FROM webinar_notification_jobs
      WHERE kind='day_before' AND status='queued' AND attempt_count=0 AND lease_expires_at IS NULL`).get())
      .toEqual({ count: 99 });
    stop(store, false);
    dispatch.mockImplementation(async () => new Response('{}', { status: 200 }));
    const resumed = [];
    for (let tick = 0; tick < 5; tick++) {
      resumed.push(await processWebinarNotificationJobs(store.db, { ...deliveryOptions, proxyDispatch: dispatch }));
    }
    expect(resumed.map((result) => result.sent)).toEqual([20, 20, 20, 20, 19]);
    expect(resumed.every((result) => result.failed + result.skipped + result.heldByStop === 0)).toBe(true);
    await processWebinarNotificationJobs(store.db, { ...deliveryOptions, proxyDispatch: dispatch });
    expect(dispatch).toHaveBeenCalledTimes(100);
    expect(new Set(dispatch.mock.calls.map(([request]) => request.headers.get('X-Line-Retry-Key'))).size).toBe(100);
    store.raw.close();
  });

  test.each(['queued', 'retry_wait', 'claimed'] as const)(
    '未停止判定後・claim直前に停止した%sは試行回数とleaseを消費せず、解除後一度だけ届く',
    async (initialStatus) => {
      const store = await fixture();
      const attempts = initialStatus === 'queued' ? 0 : 2;
      store.raw.prepare(`UPDATE webinar_notification_jobs SET status=?, attempt_count=?,
        lease_expires_at=?, last_error_code=? WHERE kind='day_before'`)
        .run(initialStatus, attempts, initialStatus === 'claimed' ? epoch - 1 : null,
          initialStatus === 'retry_wait' ? 'line_temporary_failure' : null);
      let raced = false;
      const racedDb = intercept(store.db, async (sql, method, run) => {
        if (!raced && method === 'run' && sql.includes("SET status='claimed', attempt_count")) {
          raced = true;
          stop(store);
        }
        return run();
      });
      const dispatch = vi.fn(async () => new Response('{}', { status: 200 }));
      expect(await processWebinarNotificationJobs(racedDb, { ...deliveryOptions, proxyDispatch: dispatch }))
        .toEqual({ sent: 0, failed: 0, skipped: 0, heldByStop: 1 });
      expect(raced).toBe(true);
      expect(dispatch).not.toHaveBeenCalled();
      expect(state(store)).toEqual({
        status: initialStatus === 'retry_wait' ? 'retry_wait' : 'queued',
        attempt_count: attempts, lease_expires_at: null, next_retry_at: epoch,
        last_error_code: initialStatus === 'retry_wait' ? 'line_temporary_failure' : null,
      });
      stop(store, false);
      await processWebinarNotificationJobs(store.db, { ...deliveryOptions, proxyDispatch: dispatch });
      await processWebinarNotificationJobs(store.db, { ...deliveryOptions, proxyDispatch: dispatch });
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(state(store)).toMatchObject({ status: 'succeeded', attempt_count: attempts + 1, lease_expires_at: null });
      store.raw.close();
    },
  );

  test('claim直前に停止した期限切れ通知を、停止中にskippedへ確定しない', async () => {
    const store = await fixture();
    store.raw.prepare(`UPDATE webinar_notification_jobs SET session_start_at=? WHERE kind='day_before'`)
      .run(epoch - 3601);
    const racedDb = intercept(store.db, async (sql, method, run) => {
      if (method === 'run' && sql.includes("SET status='claimed', attempt_count")) stop(store);
      return run();
    });
    const dispatch = vi.fn(async () => new Response('{}', { status: 200 }));
    expect(await processWebinarNotificationJobs(racedDb, { ...deliveryOptions, proxyDispatch: dispatch }))
      .toEqual({ sent: 0, failed: 0, skipped: 0, heldByStop: 1 });
    expect(state(store)).toMatchObject({ status: 'queued', attempt_count: 0, lease_expires_at: null });
    expect(dispatch).not.toHaveBeenCalled();
    store.raw.close();
  });

  test('claim後の設定取得中に停止しても外部送信直前に止まり、解除後一度だけ届く', async () => {
    const store = await fixture();
    let stopReads = 0;
    const racedDb = intercept(store.db, async (sql, method, run) => {
      const result = await run();
      // 実行権取得後の確認を通った後に停止へ変え、LIFF 情報の先読み後でも最後に停止状態を読み直すことを確かめる。
      if (method === 'all' && sql.includes('SELECT states_json, active_incident_id') && ++stopReads === 2) stop(store);
      return result;
    });
    const dispatch = vi.fn(async () => new Response('{}', { status: 200 }));
    expect(await processWebinarNotificationJobs(racedDb, { ...deliveryOptions, proxyDispatch: dispatch }))
      .toEqual({ sent: 0, failed: 0, skipped: 0, heldByStop: 1 });
    expect(dispatch).not.toHaveBeenCalled();
    expect(state(store)).toMatchObject({ status: 'queued', attempt_count: 0, lease_expires_at: null });
    stop(store, false);
    await processWebinarNotificationJobs(store.db, { ...deliveryOptions, proxyDispatch: dispatch });
    await processWebinarNotificationJobs(store.db, { ...deliveryOptions, proxyDispatch: dispatch });
    expect(dispatch).toHaveBeenCalledTimes(1);
    store.raw.close();
  });

  test.each(['attempt', 'lease', 'cancelled'] as const)('停止で返す直前に%sが変わった他の処理の行は上書きしない', async (changed) => {
    const store = await fixture();
    const racedDb = intercept(store.db, async (sql, method, run) => {
      if (method === 'run' && sql.includes("SET status='claimed', attempt_count")) stop(store);
      if (method === 'run' && sql.includes('attempt_count=attempt_count-1')) {
        store.raw.prepare(`UPDATE webinar_notification_jobs SET status=?, attempt_count=?, lease_expires_at=?
          WHERE kind='day_before'`).run(
          changed === 'cancelled' ? 'cancelled' : 'claimed',
          changed === 'attempt' ? 2 : 1,
          changed === 'lease' ? epoch + 601 : epoch + 300,
        );
      }
      return run();
    });
    const dispatch = vi.fn(async () => new Response('{}', { status: 200 }));
    await processWebinarNotificationJobs(racedDb, { ...deliveryOptions, proxyDispatch: dispatch });
    expect(state(store)).toMatchObject({
      status: changed === 'cancelled' ? 'cancelled' : 'claimed',
      attempt_count: changed === 'attempt' ? 2 : 1,
      lease_expires_at: changed === 'lease' ? epoch + 601 : epoch + 300,
    });
    expect(dispatch).not.toHaveBeenCalled();
    store.raw.close();
  });

  test('取得一覧の後に試行世代が変わった行を古い情報でclaimしない', async () => {
    const store = await fixture();
    const racedDb = intercept(store.db, async (sql, method, run) => {
      if (method === 'run' && sql.includes("SET status='claimed', attempt_count")) {
        store.raw.prepare(`UPDATE webinar_notification_jobs SET attempt_count=1 WHERE kind='day_before'`).run();
      }
      return run();
    });
    const dispatch = vi.fn(async () => new Response('{}', { status: 200 }));
    await processWebinarNotificationJobs(racedDb, { ...deliveryOptions, proxyDispatch: dispatch });
    expect(dispatch).not.toHaveBeenCalled();
    expect(state(store)).toMatchObject({ status: 'queued', attempt_count: 1, lease_expires_at: null });
    store.raw.close();
  });
});

describe('calculateWebinarNotificationSchedule', () => {
  test('JSTの前日・開始前・開始時・翌日の時刻を固定する', () => {
    expect(calculateWebinarNotificationSchedule(SESSION, SETTINGS, NOW.getTime() / 1000)).toEqual([
      { kind: 'day_before', scheduledAt: Date.parse('2026-09-01T11:00:00.000Z') / 1000 },
      { kind: 'hour_before', scheduledAt: Date.parse('2026-09-02T01:00:00.000Z') / 1000 },
      { kind: 'session_start', scheduledAt: SESSION },
      { kind: 'missed', scheduledAt: Date.parse('2026-09-03T01:00:00.000Z') / 1000 },
    ]);
  });
});

describe('webinar notification jobs', () => {
  test('通知対象は有効予約の人数と予約枠数を分けて数える', async () => {
    const { db, raw } = createTestD1();
    seedBase(raw);
    insertFriend(raw, 'friend-2', { line_account_id: 'account-1', line_user_id: 'U002' });
    const insert = raw.prepare(
      `INSERT INTO webinar_registrations
         (id, webinar_id, friend_id, session_start_at, status, created_at)
       VALUES (?, 'webinar-1', ?, ?, ?, ?)`,
    );
    insert.run('registration-1', 'friend-1', SESSION, 'active', NOW.toISOString());
    insert.run('registration-2', 'friend-1', SESSION + 3600, 'active', NOW.toISOString());
    insert.run('registration-3', 'friend-2', SESSION, 'active', NOW.toISOString());
    insert.run('registration-4', 'friend-2', SESSION + 3600, 'cancelled', NOW.toISOString());

    const result = await getWebinarNotificationOverview(db, 'webinar-1');

    expect(result).toMatchObject({
      total: 0,
      audience: { people: 2, bookings: 3, definition: 'active_registrations' },
    });
  });

  test('設定の版を上げ、古い未送信予定を取り消して新しい予定を作る', async () => {
    const { db, raw } = createTestD1();
    seedBase(raw);
    await registerWebinarSession(db, 'webinar-1', 'friend-1', SESSION, NOW);

    const first = await saveWebinarNotificationSettings(db, 'webinar-1', SETTINGS, NOW);
    expect(first.settings.version).toBe(1);
    expect(first.queued).toBe(4);

    const second = await saveWebinarNotificationSettings(
      db,
      'webinar-1',
      { ...SETTINGS, hourBeforeMinutes: 180 },
      new Date(NOW.getTime() + 60_000),
    );
    expect(second.settings.version).toBe(2);
    expect(second.cancelled).toBe(4);
    expect(second.queued).toBe(4);
    expect(raw.prepare(
      `SELECT COUNT(*) AS count FROM webinar_notification_jobs WHERE status='cancelled'`,
    ).get()).toEqual({ count: 4 });
    expect(raw.prepare(
      `SELECT COUNT(*) AS count FROM webinar_notification_jobs WHERE status='queued'`,
    ).get()).toEqual({ count: 4 });
  });

  test('回を選び直すと前の予定を止め、同じ回への再送信は増やさない', async () => {
    const { db, raw } = createTestD1();
    seedBase(raw);
    await saveWebinarNotificationSettings(db, 'webinar-1', SETTINGS, NOW);
    const first = await registerWebinarSession(db, 'webinar-1', 'friend-1', SESSION, NOW);
    const same = await registerWebinarSession(db, 'webinar-1', 'friend-1', SESSION, NOW);
    expect(first.created).toBe(true);
    expect(same).toMatchObject({ created: false, rescheduled: false });

    const nextSession = SESSION + 3600;
    const changed = await registerWebinarSession(db, 'webinar-1', 'friend-1', nextSession, NOW);
    expect(changed.rescheduled).toBe(true);
    expect(raw.prepare(
      `SELECT COUNT(*) AS count FROM webinar_notification_jobs
        WHERE registration_id=? AND status='cancelled'`,
    ).get(first.registration.id)).toEqual({ count: 4 });
    expect(raw.prepare(
      `SELECT COUNT(*) AS count FROM webinar_notification_jobs
        WHERE registration_id=? AND status='queued'`,
    ).get(changed.registration.id)).toEqual({ count: 4 });
  });

  test('90%視聴のお礼は同じ申込へ1件だけ作る', async () => {
    const { db, raw } = createTestD1();
    seedBase(raw);
    await saveWebinarNotificationSettings(db, 'webinar-1', SETTINGS, NOW);
    await registerWebinarSession(db, 'webinar-1', 'friend-1', SESSION, NOW);
    expect(await enqueueWebinarCompletedNotification(db, 'webinar-1', 'friend-1', SESSION, NOW)).toBe(true);
    expect(await enqueueWebinarCompletedNotification(db, 'webinar-1', 'friend-1', SESSION, NOW)).toBe(false);
    expect(raw.prepare(
      `SELECT COUNT(*) AS count FROM webinar_notification_jobs WHERE kind='completed'`,
    ).get()).toEqual({ count: 1 });
  });

  test('期限の来た通知をHarness Proxyへ一度だけ渡し、retry keyを維持する', async () => {
    const { db, raw } = createTestD1();
    seedBase(raw);
    await saveWebinarNotificationSettings(db, 'webinar-1', SETTINGS, NOW);
    await registerWebinarSession(db, 'webinar-1', 'friend-1', SESSION, NOW);
    const job = raw.prepare(
      `SELECT id, line_retry_key FROM webinar_notification_jobs WHERE kind='day_before'`,
    ).get() as { id: string; line_retry_key: string };
    raw.prepare(
      `UPDATE webinar_notification_jobs SET scheduled_at=?, next_retry_at=? WHERE id=?`,
    ).run(Math.floor(NOW.getTime() / 1000), Math.floor(NOW.getTime() / 1000), job.id);
    const dispatch = vi.fn(async (_request: Request) => new Response('{}', { status: 200 }));

    expect(await processWebinarNotificationJobs(db, {
      now: NOW,
      proxyBaseUrl: 'https://worker.example.com',
      defaultAccessToken: 'fallback',
      defaultLiffId: null,
      proxyDispatch: dispatch,
    })).toEqual({ sent: 1, failed: 0, skipped: 0, heldByStop: 0 });
    expect(dispatch).toHaveBeenCalledTimes(1);
    const request = dispatch.mock.calls[0]?.[0];
    expect(request.headers.get('X-Line-Retry-Key')).toBe(job.line_retry_key);
    expect(request.headers.get('X-Line-Harness-Source')).toBeNull();
    expect(raw.prepare(`SELECT status FROM webinar_notification_jobs WHERE id=?`).get(job.id))
      .toEqual({ status: 'succeeded' });
  });

  test('機能オフ中は予約をclaimせず、再開可能なまま監査だけを残す', async () => {
    const { db, raw } = createTestD1();
    seedBase(raw);
    await saveWebinarNotificationSettings(db, 'webinar-1', SETTINGS, NOW);
    await registerWebinarSession(db, 'webinar-1', 'friend-1', SESSION, NOW);
    const job = raw.prepare(
      `SELECT id FROM webinar_notification_jobs WHERE kind='day_before'`,
    ).get() as { id: string };
    raw.prepare(
      `UPDATE webinar_notification_jobs SET scheduled_at=?, next_retry_at=? WHERE id=?`,
    ).run(Math.floor(NOW.getTime() / 1000), Math.floor(NOW.getTime() / 1000), job.id);
    raw.prepare(
      `UPDATE account_settings SET value='{"enabled":false}'
        WHERE line_account_id='account-1' AND key='feature.webinars'`,
    ).run();
    const dispatch = vi.fn(async () => new Response('{}', { status: 200 }));

    expect(await processWebinarNotificationJobs(db, {
      now: NOW,
      proxyBaseUrl: 'https://worker.example.com',
      defaultAccessToken: 'fallback',
      defaultLiffId: null,
      proxyDispatch: dispatch,
    })).toEqual({ sent: 0, failed: 0, skipped: 1, heldByStop: 0 });
    expect(dispatch).not.toHaveBeenCalled();
    expect(raw.prepare(
      `SELECT status, attempt_count FROM webinar_notification_jobs WHERE id=?`,
    ).get(job.id)).toEqual({ status: 'queued', attempt_count: 0 });
    expect(raw.prepare(
      `SELECT action, target_id FROM audit_events WHERE action='feature.execution.skipped'`,
    ).get()).toEqual({ action: 'feature.execution.skipped', target_id: 'webinar-notifications' });
  });

  test('見ている人への見逃し案内は送らず、理由のない0件にしない', async () => {
    const { db, raw } = createTestD1();
    seedBase(raw);
    await saveWebinarNotificationSettings(db, 'webinar-1', SETTINGS, NOW);
    await registerWebinarSession(db, 'webinar-1', 'friend-1', SESSION, NOW);
    raw.prepare(
      `INSERT INTO webinar_viewers
       (id, webinar_id, friend_id, session_start_at, joined_at, last_position_seconds)
       VALUES ('viewer-1', 'webinar-1', 'friend-1', ?, ?, 1)`,
    ).run(SESSION, NOW.toISOString());
    const missed = raw.prepare(
      `SELECT id FROM webinar_notification_jobs WHERE kind='missed'`,
    ).get() as { id: string };
    raw.prepare(
      `UPDATE webinar_notification_jobs SET scheduled_at=?, next_retry_at=? WHERE id=?`,
    ).run(Math.floor(NOW.getTime() / 1000), Math.floor(NOW.getTime() / 1000), missed.id);
    const dispatch = vi.fn(async (_request: Request) => new Response('{}', { status: 200 }));

    expect(await processWebinarNotificationJobs(db, {
      now: NOW,
      proxyBaseUrl: 'https://worker.example.com',
      defaultAccessToken: 'fallback',
      defaultLiffId: null,
      proxyDispatch: dispatch,
    })).toEqual({ sent: 0, failed: 0, skipped: 1, heldByStop: 0 });
    expect(dispatch).not.toHaveBeenCalled();
    expect(raw.prepare(`SELECT status FROM webinar_notification_jobs WHERE id=?`).get(missed.id))
      .toEqual({ status: 'skipped' });
  });

  test('外部API失敗は共通の1分・5分・30分だけ再試行し、安全な理由で終了する', async () => {
    const { db, raw } = createTestD1();
    seedBase(raw);
    await saveWebinarNotificationSettings(db, 'webinar-1', SETTINGS, NOW);
    await registerWebinarSession(db, 'webinar-1', 'friend-1', SESSION, NOW);
    const job = raw.prepare(
      `SELECT id FROM webinar_notification_jobs WHERE kind='day_before'`,
    ).get() as { id: string };
    raw.prepare(
      `UPDATE webinar_notification_jobs SET scheduled_at=?, next_retry_at=? WHERE id=?`,
    ).run(Math.floor(NOW.getTime() / 1000), Math.floor(NOW.getTime() / 1000), job.id);
    const dispatch = vi.fn(async () => new Response('provider-secret', { status: 500 }));
    const times = [0, 1, 6, 36].map((minutes) => new Date(NOW.getTime() + minutes * 60_000));

    for (const now of times) {
      await processWebinarNotificationJobs(db, {
        now,
        proxyBaseUrl: 'https://worker.example.com',
        defaultAccessToken: 'fallback',
        defaultLiffId: null,
        proxyDispatch: dispatch,
      });
    }

    expect(dispatch).toHaveBeenCalledTimes(4);
    expect(raw.prepare(
      `SELECT status, attempt_count, next_retry_at, last_error_code, last_error_message
         FROM webinar_notification_jobs WHERE id=?`,
    ).get(job.id)).toEqual({
      status: 'permanent_failed',
      attempt_count: 4,
      next_retry_at: null,
      last_error_code: 'retry_exhausted',
      last_error_message: '自動再試行の上限に達しました。LINE連携を確認し、必要なら手動で再試行してください。',
    });
  });

  /*
   *  の裁定で契約が変わりました。**緊急停止は「捨てる」から「止める」へ。**
   *
   * 元の表明（`status='skipped'`, `last_error_code='operation_stopped'` に
   * なること）が捕まえていた壊し方は2つです。
   *
   *   1. 緊急停止中なのに外部へ送ってしまう
   *      → 下の `expect(dispatch).not.toHaveBeenCalled` が引き続き捕まえます
   *   2. 緊急停止が判定されず、何事も無かったことにされる
   *      → 元は「skipped が1件」で見ていました。いまは `heldByStop: 1` で見ます
   *
   * そして元の表明は、**復旧しても永久に届かない**という壊れ方を
   * 通していました（`skipped` を戻す経路が無いため）。新しい表明は
   * 「行が触られていないこと」と「復旧したら実際に届くこと」まで見るので、
   * 元より強くなっています。
   */
  test('緊急停止中は行を確定させず、復旧したら実際に届く', async () => {
    const { db, raw } = createTestD1();
    seedBase(raw);
    await saveWebinarNotificationSettings(db, 'webinar-1', SETTINGS, NOW);
    await registerWebinarSession(db, 'webinar-1', 'friend-1', SESSION, NOW);
    const job = raw.prepare(
      `SELECT id FROM webinar_notification_jobs WHERE kind='day_before'`,
    ).get() as { id: string };
    raw.prepare(
      `UPDATE webinar_notification_jobs SET scheduled_at=?, next_retry_at=? WHERE id=?`,
    ).run(Math.floor(NOW.getTime() / 1000), Math.floor(NOW.getTime() / 1000), job.id);
    raw.prepare(
      `INSERT INTO operation_control_sets
         (scope_key, line_account_id, version, states_json, active_incident_id, updated_at)
       VALUES ('account-1', 'account-1', 1, ?, 'incident-1', ?)`,
    ).run(JSON.stringify({ reminder_dispatch: 'stopped' }), NOW.toISOString());
    const dispatch = vi.fn(async () => new Response('{}', { status: 200 }));
    const options = {
      now: NOW,
      proxyBaseUrl: 'https://worker.example.com',
      defaultAccessToken: 'fallback',
      defaultLiffId: null,
      proxyDispatch: dispatch,
    };

    expect(await processWebinarNotificationJobs(db, options))
      .toEqual({ sent: 0, failed: 0, skipped: 0, heldByStop: 1 });
    expect(dispatch).not.toHaveBeenCalled();
    // **行に触らない。**claim もしない（attempt_count が毎tick増えると、
    // 取り出しの上限に当たった時点でやはり黙って届かなくなる）。
    expect(raw.prepare(
      `SELECT status, attempt_count, last_error_code, lease_expires_at
         FROM webinar_notification_jobs WHERE id=?`,
    ).get(job.id)).toEqual({
      status: 'queued', attempt_count: 0, last_error_code: null, lease_expires_at: null,
    });

    // 止めている間、何tick回しても増えない。
    await processWebinarNotificationJobs(db, options);
    await processWebinarNotificationJobs(db, options);
    expect(raw.prepare(`SELECT attempt_count FROM webinar_notification_jobs WHERE id=?`).get(job.id))
      .toEqual({ attempt_count: 0 });

    // 復旧したら届く。ここが元の表明では通っていた壊れ方（永久に届かない）。
    raw.prepare(`UPDATE operation_control_sets SET states_json=?, active_incident_id=NULL WHERE scope_key='account-1'`)
      .run(JSON.stringify({ reminder_dispatch: 'running' }));
    expect(await processWebinarNotificationJobs(db, options))
      .toEqual({ sent: 1, failed: 0, skipped: 0, heldByStop: 0 });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(raw.prepare(`SELECT status FROM webinar_notification_jobs WHERE id=?`).get(job.id))
      .toEqual({ status: 'succeeded' });
  });

  /*
   * 落とす理由は「期限を過ぎた」であって「止まっていた」ではない。
   * 停止中は判断そのものを先送りし、復旧したときに、そのジョブ自身の
   * 予定時刻で改めて判断する。
   */
  test('停止をまたいで期限が切れたら、停止ではなく期限を理由に落ちる', async () => {
    const { db, raw } = createTestD1();
    seedBase(raw);
    await saveWebinarNotificationSettings(db, 'webinar-1', SETTINGS, NOW);
    await registerWebinarSession(db, 'webinar-1', 'friend-1', SESSION, NOW);
    const job = raw.prepare(
      `SELECT id FROM webinar_notification_jobs WHERE kind='day_before'`,
    ).get() as { id: string };
    raw.prepare(
      `UPDATE webinar_notification_jobs SET scheduled_at=?, next_retry_at=? WHERE id=?`,
    ).run(Math.floor(NOW.getTime() / 1000), Math.floor(NOW.getTime() / 1000), job.id);
    raw.prepare(
      `INSERT INTO operation_control_sets
         (scope_key, line_account_id, version, states_json, active_incident_id, updated_at)
       VALUES ('account-1', 'account-1', 1, ?, 'incident-1', ?)`,
    ).run(JSON.stringify({ reminder_dispatch: 'stopped' }), NOW.toISOString());
    const dispatch = vi.fn(async () => new Response('{}', { status: 200 }));

    // 停止中は落とさない。行は queued のまま。
    expect(await processWebinarNotificationJobs(db, {
      now: NOW, proxyBaseUrl: 'https://worker.example.com',
      defaultAccessToken: 'fallback', defaultLiffId: null, proxyDispatch: dispatch,
    })).toEqual({ sent: 0, failed: 0, skipped: 0, heldByStop: 1 });
    expect(raw.prepare(`SELECT status FROM webinar_notification_jobs WHERE id=?`).get(job.id))
      .toEqual({ status: 'queued' });

    // 復旧したときには、対象回が終わっている。
    raw.prepare(`UPDATE operation_control_sets SET states_json=?, active_incident_id=NULL WHERE scope_key='account-1'`)
      .run(JSON.stringify({ reminder_dispatch: 'running' }));
    const afterSession = new Date((SESSION + 3600 + 60) * 1000);
    // 前日・開始前・開始時の3件がまとめて期限切れになる（対象回が終わったため）。
    // 見逃し案内(missed)はまだ予定時刻に達していないので対象外。
    expect(await processWebinarNotificationJobs(db, {
      now: afterSession, proxyBaseUrl: 'https://worker.example.com',
      defaultAccessToken: 'fallback', defaultLiffId: null, proxyDispatch: dispatch,
    })).toEqual({ sent: 0, failed: 0, skipped: 3, heldByStop: 0 });
    expect(dispatch).not.toHaveBeenCalled();
    // 理由は notification_expired。operation_stopped ではない。
    expect(raw.prepare(
      `SELECT status, last_error_code FROM webinar_notification_jobs WHERE id=?`,
    ).get(job.id)).toEqual({ status: 'skipped', last_error_code: 'notification_expired' });
  });

  /*
   * 「見送り 5件」だけでは、取るべき行動が決まらない。
   * 視聴済み（正常）と対象回の終了（届かないまま終わった）を分けて出す。
   */
  test('見送りの内訳を理由ごとに数えて返す', async () => {
    const { db, raw } = createTestD1();
    seedBase(raw);
    const insert = raw.prepare(
      `INSERT INTO webinar_notification_jobs
         (id, webinar_id, registration_id, friend_id, session_start_at, settings_version, kind,
          scheduled_at, status, attempt_count, line_retry_key, last_error_code, created_at, updated_at)
       VALUES (?, 'webinar-1', ?, 'friend-1', ?, 1, ?, ?, 'skipped', 1, ?, ?, ?, ?)`,
    );
    raw.prepare(
      `INSERT INTO webinar_registrations (id, webinar_id, friend_id, session_start_at, status, created_at)
       VALUES ('registration-1','webinar-1','friend-1',?, 'active', ?)`,
    ).run(SESSION, NOW.toISOString());
    insert.run('j1', 'registration-1', SESSION, 'day_before', SESSION - 86400, 'rk1', 'notification_expired', NOW.toISOString(), NOW.toISOString());
    insert.run('j2', 'registration-1', SESSION, 'hour_before', SESSION - 3600, 'rk2', 'notification_expired', NOW.toISOString(), NOW.toISOString());
    insert.run('j3', 'registration-1', SESSION, 'missed', SESSION + 86400, 'rk3', 'already_viewed', NOW.toISOString(), NOW.toISOString());
    insert.run('j4', 'registration-1', SESSION, 'session_start', SESSION, 'rk4', null, NOW.toISOString(), NOW.toISOString());
    // 見送り以外の行にも理由の符号は付く。**内訳に混ぜない。**
    // 混ぜると「対象回が終了済み 2件」の隣に、送信の再試行が尽きた失敗が
    // 並び、運用者は見送りの件数を読み違える。
    raw.prepare(
      `INSERT INTO webinar_notification_jobs
         (id, webinar_id, registration_id, friend_id, session_start_at, settings_version, kind,
          scheduled_at, status, attempt_count, line_retry_key, last_error_code, created_at, updated_at)
       VALUES ('j5','webinar-1','registration-1','friend-1',?,1,'completed',?, 'permanent_failed', 3, 'rk5',
               'retry_exhausted', ?, ?)`,
    ).run(SESSION, SESSION + 7200, NOW.toISOString(), NOW.toISOString());

    const overview = await getWebinarNotificationOverview(db, 'webinar-1');
    expect(overview.skipped).toBe(4);
    expect(overview.skippedReasons).toEqual([
      { code: 'notification_expired', label: '対象回が終了済み', count: 2 },
      { code: null, label: '理由の記録なし', count: 1 },
      { code: 'already_viewed', label: 'すでに視聴済み', count: 1 },
    ]);
  });

  test('確認したテスト宛先が変わったら誰にも送らない', async () => {
    const { db, raw } = createTestD1();
    seedBase(raw);
    raw.prepare(`INSERT INTO account_settings (id,line_account_id,key,value) VALUES ('test-recipients','account-1','test_recipients','["friend-1"]')`).run();
    const dispatch = vi.fn(async (_request: Request) => new Response('{}', { status: 200 }));
    await expect(sendWebinarNotificationTest(db,
      { id: 'webinar-1', accountId: 'account-1', title: '商品説明会', slug: 'product-live' }, SESSION,
      { now: NOW, proxyBaseUrl: 'https://worker.example.com', defaultAccessToken: 'fallback', defaultLiffId: null, proxyDispatch: dispatch, expectedRecipientToken: '0'.repeat(64) },
    )).rejects.toMatchObject({ code: 'WEBINAR_TEST_RECIPIENT_CHANGED' });
    expect(dispatch).not.toHaveBeenCalled();
  });

  test('同じ人数でもLINE宛先が変われば確認後に送らない', async () => {
    const {db,raw}=createTestD1(); seedBase(raw);
    raw.prepare(`INSERT INTO account_settings(id,line_account_id,key,value) VALUES ('test-recipients','account-1','test_recipients','["friend-1"]')`).run();
    const preview=await webinarTestRecipientPreview(db,'account-1');
    raw.prepare("UPDATE friends SET line_user_id='U-new' WHERE id='friend-1'").run();
    const dispatch=vi.fn(async (_request:Request)=>new Response('{}'));
    await expect(sendWebinarNotificationTest(db,{id:'webinar-1',accountId:'account-1',title:'商品説明会',slug:'product-live'},SESSION,
      {now:NOW,proxyBaseUrl:'https://worker.example.com',defaultAccessToken:'fallback',defaultLiffId:null,proxyDispatch:dispatch,expectedRecipientToken:preview.token})).rejects.toMatchObject({code:'WEBINAR_TEST_RECIPIENT_CHANGED'});
    expect(dispatch).not.toHaveBeenCalled();
  });

  test('送信準備中にLINE宛先が変わっても新旧とも送らない', async () => {
    const {db,raw}=createTestD1(); seedBase(raw);
    raw.prepare(`INSERT INTO account_settings(id,line_account_id,key,value) VALUES ('test-recipients','account-1','test_recipients','["friend-1"]')`).run();
    const preview=await webinarTestRecipientPreview(db,'account-1');
    const prepare=db.prepare.bind(db); let reads=0;
    const spy=vi.spyOn(db,'prepare').mockImplementation(sql=>{
      if(sql.includes("key='test_recipients'") && ++reads===2)raw.prepare("UPDATE friends SET line_user_id='U-late' WHERE id='friend-1'").run();
      return prepare(sql);
    });
    const dispatch=vi.fn(async (_request:Request)=>new Response('{}'));
    try{
      await expect(sendWebinarNotificationTest(db,{id:'webinar-1',accountId:'account-1',title:'商品説明会',slug:'product-live'},SESSION,
        {now:NOW,proxyBaseUrl:'https://worker.example.com',defaultAccessToken:'fallback',defaultLiffId:null,proxyDispatch:dispatch,expectedRecipientToken:preview.token})).rejects.toMatchObject({code:'WEBINAR_TEST_RECIPIENT_CHANGED'});
      expect(reads).toBe(2);expect(dispatch).not.toHaveBeenCalled();
    }finally{spy.mockRestore();}
  });

  test('同じ確認で同時にテストを送っても一度だけ送る', async () => {
    const {db,raw}=createTestD1(); seedBase(raw);
    raw.prepare(`INSERT INTO account_settings(id,line_account_id,key,value) VALUES ('test-recipients','account-1','test_recipients','["friend-1"]')`).run();
    const preview=await webinarTestRecipientPreview(db,'account-1');
    const dispatch=vi.fn(async (_request:Request)=>new Response('{}'));
    const send=()=>sendWebinarNotificationTest(db,{id:'webinar-1',accountId:'account-1',title:'商品説明会',slug:'product-live'},SESSION,
      {now:NOW,proxyBaseUrl:'https://worker.example.com',defaultAccessToken:'fallback',defaultLiffId:null,proxyDispatch:dispatch,expectedRecipientToken:preview.token,confirmationId:'test-confirmation'});
    const results=await Promise.allSettled([send(),send()]);
    expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  test('テスト送信先だけへ自動送信として通知イメージを送る', async () => {
    const { db, raw } = createTestD1();
    seedBase(raw);
    raw.prepare(
      `INSERT INTO account_settings (id, line_account_id, key, value)
       VALUES ('test-recipients', 'account-1', 'test_recipients', '["friend-1"]')`,
    ).run();
    const dispatch = vi.fn(async (_request: Request) => new Response('{}', { status: 200 }));

    expect(await sendWebinarNotificationTest(
      db,
      { id: 'webinar-1', accountId: 'account-1', title: '商品説明会', slug: 'product-live' },
      SESSION,
      {
        now: NOW,
        proxyBaseUrl: 'https://worker.example.com',
        defaultAccessToken: 'fallback',
        defaultLiffId: null,
        proxyDispatch: dispatch,
      },
    )).toEqual({ sent: 1, failed: 0 });
    const request = dispatch.mock.calls[0]?.[0];
    expect(request.headers.get('X-Line-Harness-Source')).toBeNull();
    expect(await request.clone().json()).toEqual(expect.objectContaining({
      messages: [expect.objectContaining({ text: expect.stringContaining('【テスト送信】') })],
    }));
  });
});

describe('webinar session capacity and missed window (N)', () => {
  test('W10: 同じ人の並行申込が後から既存行を見ても席数を増やさない', async () => {
    const { db, raw } = createTestD1({ foreignKeys: true });
    try {
      seedBase(raw);
      const { setWebinarSessionCapacity } = await import('@line-crm/db');
      await setWebinarSessionCapacity(db, 'webinar-1', SESSION, 2);
      let read!: () => void;
      let release!: () => void;
      const readDone = new Promise<void>((resolve) => { read = resolve; });
      const resume = new Promise<void>((resolve) => { release = resolve; });
      // 2本目（列車で統合）の実装は事前の読み取りを持たず、1回の batch で確定する。
      // 後から来た申込の batch を先の申込が終わるまで止め、同じ競合を再現する。
      const delayed = {
        ...db,
        prepare: (sql: string) => db.prepare(sql),
        async batch(statements: D1PreparedStatement[]) {
          read();
          await resume;
          return db.batch(statements);
        },
      } as D1Database;
      const second = registerWebinarSession(delayed, 'webinar-1', 'friend-1', SESSION, NOW);
      await readDone;
      const first = await registerWebinarSession(db, 'webinar-1', 'friend-1', SESSION, NOW);
      release();
      expect((await second).registration.id).toBe(first.registration.id);
      expect(raw.prepare(`SELECT reserved_count,state FROM webinar_sessions WHERE webinar_id='webinar-1'`).get())
        .toEqual({ reserved_count: 1, state: 'open' });
      expect(raw.prepare(`SELECT COUNT(*) AS n FROM webinar_registrations WHERE status='active'`).get()).toEqual({ n: 1 });
      await registerWebinarSession(db, 'webinar-1', 'friend-1', SESSION + 3600, NOW);
      expect(raw.prepare(`SELECT reserved_count FROM webinar_sessions WHERE session_start_at=?`).get(SESSION)).toEqual({ reserved_count: 0 });
    } finally { raw.close(); }
  });

  test('定員いっぱいの開催回への申込は session_full で断る', async () => {
    const { db, raw } = createTestD1();
    seedBase(raw);
    insertFriend(raw, 'friend-2', { line_account_id: 'account-1', line_user_id: 'U002' });
    await saveWebinarNotificationSettings(db, 'webinar-1', SETTINGS, NOW);
    const { setWebinarSessionCapacity } = await import('@line-crm/db');
    await setWebinarSessionCapacity(db, 'webinar-1', SESSION, 1);
    await registerWebinarSession(db, 'webinar-1', 'friend-1', SESSION, NOW);
    await expect(registerWebinarSession(db, 'webinar-1', 'friend-2', SESSION, NOW))
      .rejects.toThrow('session_full');
  });

  test('W10: 同じ申込が並行しても登録・席・通知は1件ずつになる', async () => {
    const { db, raw } = createTestD1(); seedBase(raw);
    await saveWebinarNotificationSettings(db, 'webinar-1', SETTINGS, NOW);
    const { setWebinarSessionCapacity, getWebinarSession } = await import('@line-crm/db');
    await setWebinarSessionCapacity(db, 'webinar-1', SESSION, 2);
    const atomicDb = asD1(raw);
    const results = await Promise.all([registerWebinarSession(atomicDb, 'webinar-1', 'friend-1', SESSION, NOW),
      registerWebinarSession(atomicDb, 'webinar-1', 'friend-1', SESSION, NOW)]);
    expect(results[0].registration.id).toBe(results[1].registration.id);
    expect(results.filter(r => r.created)).toHaveLength(1);
    expect(await getWebinarSession(db, 'webinar-1', SESSION)).toMatchObject({ reserved_count: 1 });
    expect(raw.prepare("SELECT COUNT(*) n FROM webinar_registrations WHERE status='active'").get()).toEqual({ n: 1 });
    expect(raw.prepare('SELECT COUNT(*) n FROM webinar_notification_jobs').get()).toEqual({ n: 4 });
    raw.close();
  });
  test('W10: 登録保存の失敗で先に確保した席や古い登録を失わない', async () => {
    const { db, raw } = createTestD1(); seedBase(raw);
    const { setWebinarSessionCapacity, getWebinarSession } = await import('@line-crm/db');
    await setWebinarSessionCapacity(db, 'webinar-1', SESSION, 2);
    raw.exec("CREATE TRIGGER fail_registration BEFORE INSERT ON webinar_registrations BEGIN SELECT RAISE(ABORT,'storage unavailable'); END");
    await expect(registerWebinarSession(db, 'webinar-1', 'friend-1', SESSION, NOW)).rejects.toThrow();
    expect(await getWebinarSession(db, 'webinar-1', SESSION)).toMatchObject({ reserved_count: 0 });
    raw.exec('DROP TRIGGER fail_registration');
    await registerWebinarSession(db, 'webinar-1', 'friend-1', SESSION, NOW);
    expect(await getWebinarSession(db, 'webinar-1', SESSION)).toMatchObject({ reserved_count: 1 });
    raw.close();
  });

  test('選び直しで古い回の席が空く', async () => {
    const { db, raw } = createTestD1();
    seedBase(raw);
    await saveWebinarNotificationSettings(db, 'webinar-1', SETTINGS, NOW);
    const { setWebinarSessionCapacity, getWebinarSession } = await import('@line-crm/db');
    await setWebinarSessionCapacity(db, 'webinar-1', SESSION, 1);
    await registerWebinarSession(db, 'webinar-1', 'friend-1', SESSION, NOW);
    const next = SESSION + 3600;
    await registerWebinarSession(db, 'webinar-1', 'friend-1', next, NOW);
    expect(await getWebinarSession(db, 'webinar-1', SESSION)).toMatchObject({ reserved_count: 0 });
  });

  test('見逃し配信は期限切れを送らず理由を残す', async () => {
    const { db, raw } = createTestD1();
    seedBase(raw);
    await saveWebinarNotificationSettings(db, 'webinar-1', SETTINGS, NOW);
    await registerWebinarSession(db, 'webinar-1', 'friend-1', SESSION, NOW);
    const job = raw.prepare(
      `SELECT id FROM webinar_notification_jobs WHERE kind='missed'`,
    ).get() as { id: string };
    raw.prepare(
      `UPDATE webinar_notification_jobs SET scheduled_at=?, next_retry_at=? WHERE id=?`,
    ).run(Math.floor(NOW.getTime() / 1000), Math.floor(NOW.getTime() / 1000), job.id);
    raw.prepare(
      `INSERT INTO operation_control_sets
        (scope_key, line_account_id, version, states_json, updated_at)
       VALUES ('account-1', 'account-1', 1, '{"reminder_dispatch":"running"}', ?)`,
    ).run(NOW.toISOString());
    const dispatch = vi.fn(async () => new Response('{}', { status: 200 }));
    // 開催から8日後（期限7日を過ぎている）。他の3件は対象回終了で、
    // 見逃し分は期限切れで見送られる。
    const late = new Date((SESSION + 8 * 86400) * 1000);
    expect(await processWebinarNotificationJobs(db, {
      now: late,
      proxyBaseUrl: 'https://worker.example.com',
      defaultAccessToken: 'fallback',
      defaultLiffId: null,
      proxyDispatch: dispatch,
    })).toEqual({ sent: 0, failed: 0, skipped: 4, heldByStop: 0 });
    expect(dispatch).not.toHaveBeenCalled();
    expect(raw.prepare(`SELECT status, last_error_code FROM webinar_notification_jobs WHERE id=?`).get(job.id))
      .toEqual({ status: 'skipped', last_error_code: 'missed_window_expired' });
  });
});
