import { signedLiffState, mockLineIdToken } from '../test-utils/liff-oauth.js';
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';
import type { Env } from '../worker-env.js';

// 実DB結合テスト。停止由来の引き継ぎを次の順序で固定する。
// T0 対照: active経路は通常どおり帰属・シナリオが動く (0件主張の空振り防止)。
// T1 callback→follow: 停止callback後に別followが来ても自然流入扱いにしない。
// T2 follow→callback: intent→follow→callback の順でも抑止が共有される。
// T3 同時実行: intent後に callback と follow を同時に走らせても抑止される。
// T4 広告metadata: 停止callbackは gclid/fbclid/UTM を新規保存しない。
// T5 明示の帰属が勝つ: 停止試行の記録があっても active候補の流れは抑止しない。

const lineClientMocks = vi.hoisted(() => ({
  getProfile: vi.fn(),
  replyMessage: vi.fn(),
  replyMessageWithRequestId: vi.fn(),
  pushMessage: vi.fn(),
}));

vi.mock('@line-crm/line-sdk', async () => {
  const actual = await vi.importActual<typeof import('@line-crm/line-sdk')>('@line-crm/line-sdk');
  return {
    ...actual,
    verifySignature: vi.fn(),
    LineClient: vi.fn().mockImplementation(function () { return lineClientMocks; }),
  };
});

vi.mock('../services/event-bus.js', () => ({
  fireEvent: vi.fn().mockResolvedValue(undefined),
  logOutgoingMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/activity-mileage.js', () => ({
  awardActivityMileage: vi.fn().mockResolvedValue(undefined),
}));

// 抑止INSERTの障害注入用。既定は素通し (他はすべて実DBのまま)。
const insertFaults = vi.hoisted(() => ({ remaining: 0, calls: 0 }));
vi.mock('@line-crm/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@line-crm/db')>();
  return {
    ...actual,
    recordEntryRouteStopSuppression: async (
      db: D1Database,
      input: Parameters<typeof actual.recordEntryRouteStopSuppression>[1],
    ) => {
      insertFaults.calls += 1;
      if (insertFaults.remaining > 0) {
        insertFaults.remaining -= 1;
        throw new Error('D1 busy (injected)');
      }
      return actual.recordEntryRouteStopSuppression(db, input);
    },
  };
});

import { verifySignature } from '@line-crm/line-sdk';
import { liffRoutes } from './liff.js';
import { webhook } from './webhook.js';
import { sendAdConversions } from '../services/ad-conversion.js';

let currentSub = 'U1';

function installFetchMock() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === 'https://api.line.me/oauth2/v2.1/token') {
        return new Response(
          JSON.stringify({ access_token: 'at', id_token: 'idt', token_type: 'Bearer' }),
          { status: 200 },
        );
      }
      if (url === 'https://api.line.me/oauth2/v2.1/verify') {
        return new Response(JSON.stringify({ sub: currentSub, name: 'Tester' }), {
          status: 200,
        });
      }
      if (url === 'https://api.line.me/v2/profile') {
        return new Response(
          JSON.stringify({ userId: currentSub, displayName: 'Tester' }),
          { status: 200 },
        );
      }
      return new Response('not found', { status: 404 });
    }),
  );
}

function setupApp(d1: D1Database) {
  const app = new Hono<Env>();
  app.route('/', liffRoutes);
  app.route('/', webhook);
  const env = {
    DB: d1,
    LINE_CHANNEL_SECRET: 'sec1',
    LINE_LOGIN_CHANNEL_ID: 'login1',
    LINE_LOGIN_CHANNEL_SECRET: 'lsec1',
    LINE_CHANNEL_ACCESS_TOKEN: 'envtok',
    WORKER_URL: 'https://worker.example.com',
    LIFF_URL: 'https://liff.line.me/1000000000-DefaultAA',
  } as unknown as Env['Bindings'];
  return { app, env };
}

async function seedDb(dbs: SqliteD1) {
  const raw = dbs.raw;
  raw.exec(`
    INSERT INTO line_accounts
      (id, channel_id, name, channel_access_token, channel_secret,
       login_channel_id, login_channel_secret)
    VALUES
      ('acc1', 'ch1', 'A', 'tok1', 'sec1', 'login1', 'lsec1');
    INSERT INTO entry_routes (id, ref_code, name, is_active)
    VALUES
      ('routeB', 'B', 'stopped', 0),
      ('routeA', 'A', 'active', 1);
    INSERT INTO scenarios (id, name, trigger_type, is_active, line_account_id)
    VALUES ('sc1', 'welcome', 'friend_add', 1, NULL);
    INSERT INTO scenario_triggers (id, scenario_id, kind)
    VALUES ('tr1', 'sc1', 'friend_add');
    INSERT INTO scenario_steps
      (id, scenario_id, step_order, delay_minutes, message_type, message_content)
    VALUES ('st1', 'sc1', 0, 0, 'text', 'hello');
  `);
  // 参加には明示公開が要る。稼働中の状態にしてから試す。
  const { publishScenarioVersion } = await import('@line-crm/db');
  await publishScenarioVersion(dbs.db, 'sc1', {
    staffId: null,
    idempotencyKey: 'entry-route-stop-handover-seed',
  });
}

async function postCallback(app: Hono<Env>, env: Env['Bindings'], ref: string, extra: Record<string, string> = {}) {
  const signed = await signedLiffState(env.LINE_CHANNEL_SECRET, { ref, ...extra });
  const state = signed.state;
  return app.request(
    `/auth/callback?code=x&state=${encodeURIComponent(state)}`,
    { headers: { Cookie: signed.cookie } },
    env,
  );
}

function postLink(app: Hono<Env>, env: Env['Bindings'], ref: string) {
  return app.request(
    '/api/liff/link',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: 'tok', ref }),
    },
    env,
  );
}

function postIntent(app: Hono<Env>, env: Env['Bindings'], ref: string) {
  return app.request(
    '/api/liff/friend-add-intent',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${mockLineIdToken('login1')}` },
      body: JSON.stringify({ ref, source: 'liff' }),
    },
    env,
  );
}

async function postFollow(app: Hono<Env>, env: Env['Bindings'], userId: string, webhookEventId: string) {
  const waitUntil = vi.fn();
  const res = await app.request(
    '/webhook',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Line-Signature': 'x'.repeat(44) },
      body: JSON.stringify({
        destination: 'bot-acc1',
        events: [{
          type: 'follow',
          replyToken: 'rt1',
          source: { type: 'user', userId },
          timestamp: Date.now(),
          webhookEventId,
        }],
      }),
    },
    env,
    { waitUntil, passThroughOnException() {}, props: {} } as unknown as ExecutionContext,
  );
  expect(res.status).toBe(200);
  await waitUntil.mock.calls[0]?.[0];
  return res;
}

describe('停止由来の引き継ぎ (N-244差戻・実DB)', () => {
  let dbs: SqliteD1;

  beforeEach(async () => {
    vi.clearAllMocks();
    installFetchMock();
    insertFaults.remaining = 0;
    insertFaults.calls = 0;
    currentSub = 'U1';
    vi.mocked(verifySignature).mockResolvedValue(true);
    lineClientMocks.getProfile.mockResolvedValue({ displayName: 'Tester' });
    lineClientMocks.pushMessage.mockResolvedValue(undefined);
    lineClientMocks.replyMessage.mockResolvedValue(undefined);
    dbs = createTestD1();
    await seedDb(dbs);
  });

  afterEach(() => {
    dbs.raw.close();
  });

  function count(table: string, where = ''): number {
    const row = dbs.raw.prepare(`SELECT COUNT(*) AS c FROM ${table} ${where}`).get() as { c: number };
    return row.c;
  }

  function friendRow(userId: string) {
    return dbs.raw.prepare(`SELECT id, ref_code, metadata FROM friends
      WHERE line_account_id = 'acc1' AND line_platform_user_id = ?`)
      .get(userId) as { id: string; ref_code: string | null; metadata: string | null };
  }

  function lastEvent() {
    return dbs.raw.prepare('SELECT * FROM friend_add_events ORDER BY occurred_at DESC LIMIT 1').get() as Record<string, unknown>;
  }

  function sentCount() {
    return lineClientMocks.pushMessage.mock.calls.length
      + lineClientMocks.replyMessage.mock.calls.length;
  }

  test('T0 対照: active経路は通常どおり帰属・シナリオが動く', async () => {
    currentSub = 'U0';
    const { app, env } = setupApp(dbs.db);
    const cb = await postCallback(app, env, 'A');
    expect(cb.status).toBe(200);
    await postFollow(app, env, 'U0', 'ev-t0');

    expect(friendRow('U0').ref_code).toBe('A');
    expect(count('ref_tracking')).toBeGreaterThan(0);
    expect(lastEvent().attribution_status).toBe('captured');
    expect(count('friend_scenarios')).toBeGreaterThan(0);
    expect(sentCount()).toBeGreaterThan(0);
  });

  test('T0b production経路: LIFF連携だけでは広告同意にせず外部送信し0件', async () => {
    currentSub = 'U0b';
    const { app, env } = setupApp(dbs.db);
    const cb = await postCallback(app, env, 'A', { fbclid: 'fb-no-consent' });
    expect(cb.status).toBe(200);

    const friend = friendRow('U0b');
    const tracking = dbs.raw.prepare(`
      SELECT fbclid, ad_conversion_consent_at
      FROM ref_tracking WHERE friend_id = ? ORDER BY created_at DESC LIMIT 1
    `).get(friend.id) as { fbclid: string | null; ad_conversion_consent_at: string | null };
    expect(tracking).toEqual({ fbclid: 'fb-no-consent', ad_conversion_consent_at: null });

    dbs.raw.prepare(`
      INSERT INTO ad_platforms
        (id, name, display_name, config, is_active, line_account_id)
      VALUES ('meta-t0b', 'meta', 'Meta', ?, 1, 'acc1')
    `).run(JSON.stringify({
      pixel_id: 'pixel', access_token: 'token', click_id_validity_days: 30,
    }));
    vi.mocked(fetch).mockClear();

    await sendAdConversions(dbs.db, String(friend.id), 'Purchase', 1000, {
      idempotencyKey: 'route-no-consent', now: new Date(),
    });

    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(dbs.raw.prepare(`
      SELECT status, selection_reason, last_error
      FROM ad_conversion_outbox WHERE idempotency_key = 'route-no-consent'
    `).get()).toMatchObject({
      status: 'failed', selection_reason: 'missing_consent', last_error: 'missing_consent',
    });
  });

  test('T1 callback→follow: 停止callback後の別followは抑止される', async () => {
    currentSub = 'U1';
    const { app, env } = setupApp(dbs.db);
    const cb = await postCallback(app, env, 'B', { gclid: 'g1', fbclid: 'f1', utm_source: 's' });
    expect(cb.status).toBe(200);

    // 停止試行は台帳に残り、計測・帰属・広告metadataは増えない。
    expect(count('entry_route_stop_suppressions')).toBe(1);
    expect(count('ref_tracking')).toBe(0);
    expect(count('friend_add_attribution_candidates')).toBe(0);
    expect(count('friend_scenarios')).toBe(0);
    expect(friendRow('U1').ref_code).toBeNull();
    expect(JSON.parse(String(friendRow('U1').metadata ?? '{}'))).toEqual({});

    await postFollow(app, env, 'U1', 'ev-t1');

    const ev = lastEvent();
    expect(ev.attribution_status).toBe('unavailable');
    expect(ev.routing_status).toBe('suppressed');
    expect(ev.error_code).toBe('entry_route_stopped');
    expect(count('friend_scenarios')).toBe(0);
    expect(sentCount()).toBe(0);
    expect(friendRow('U1').ref_code).toBeNull();
  });

  test('T2 follow→callback: intent→follow→callback の順でも抑止が共有される', async () => {
    currentSub = 'U2';
    const { app, env } = setupApp(dbs.db);
    // 新規利用者のため友だち行が無く 404。抑止の記録だけ残る。
    const intent = await postIntent(app, env, 'B');
    expect(intent.status).toBe(404);
    expect(count('entry_route_stop_suppressions')).toBe(1);

    await postFollow(app, env, 'U2', 'ev-t2');
    expect(lastEvent().routing_status).toBe('suppressed');
    expect(count('friend_scenarios')).toBe(0);
    expect(sentCount()).toBe(0);

    const cb = await postCallback(app, env, 'B', { gclid: 'g1' });
    expect(cb.status).toBe(200);
    // 同一試行の重複記録は増やさない。
    expect(count('entry_route_stop_suppressions')).toBe(1);
    expect(count('friend_scenarios')).toBe(0);
    expect(sentCount()).toBe(0);
    expect(JSON.parse(String(friendRow('U2').metadata ?? '{}'))).toEqual({});
    expect(friendRow('U2').ref_code).toBeNull();
  });

  test('T3 同時実行: intent後に callback と follow を同時に走らせても抑止される', async () => {
    currentSub = 'U3';
    const { app, env } = setupApp(dbs.db);
    const intent = await postIntent(app, env, 'B');
    expect(intent.status).toBe(404);

    // 友だち行だけ先に作る (同時INSERT競合の除外。抑止の共有が対象)。
    // どちらの順序で進んでも intent の記録があるため抑止される。
    dbs.raw.exec(
      `INSERT INTO friends (id, line_user_id, display_name, line_account_id)
       VALUES ('f3', 'U3', 'T', 'acc1')`,
    );

    await Promise.all([
      postCallback(app, env, 'B'),
      postFollow(app, env, 'U3', 'ev-t3'),
    ]);

    // follow が完走し、抑止状態で終わったことを直接見る
    // (クラッシュによる空振り合格を防ぐ)。
    const ev = lastEvent();
    expect(ev.attribution_status).toBe('unavailable');
    expect(ev.routing_status).toBe('suppressed');
    expect(ev.error_code).toBe('entry_route_stopped');
    expect(count('friend_scenarios')).toBe(0);
    expect(sentCount()).toBe(0);
    expect(count('ref_tracking')).toBe(0);
    expect(friendRow('U3').ref_code).toBeNull();
    expect(JSON.parse(String(friendRow('U3').metadata ?? '{}'))).toEqual({});
  });

  test('T4 広告metadata: 停止callbackは gclid/fbclid/UTM を新規保存しない', async () => {
    currentSub = 'U4';
    const { app, env } = setupApp(dbs.db);
    const cb = await postCallback(app, env, 'B', {
      gclid: 'g1', fbclid: 'f1', twclid: 't1', ttclid: 'k1',
      utm_source: 's', utm_medium: 'm', utm_campaign: 'c',
    });
    expect(cb.status).toBe(200);

    expect(JSON.parse(String(friendRow('U4').metadata ?? '{}'))).toEqual({});
  });

  test('T6 本番順序: intentなし link→follow→callback でも抑止が共有される', async () => {
    // 新規友だちの本番LIFFは friend作成前に link のみ呼ぶ。link は行なしで
    // 404 するが、その前に停止判定・抑止記録を済ませていること。
    currentSub = 'U6';
    const { app, env } = setupApp(dbs.db);
    const li = await postLink(app, env, 'B');
    expect(li.status).toBe(404);
    expect(count('entry_route_stop_suppressions')).toBe(1);

    await postFollow(app, env, 'U6', 'ev-t6');
    expect(lastEvent().routing_status).toBe('suppressed');
    expect(lastEvent().error_code).toBe('entry_route_stopped');
    expect(count('friend_scenarios')).toBe(0);
    expect(sentCount()).toBe(0);

    const cb = await postCallback(app, env, 'B');
    expect(cb.status).toBe(200);
    expect(count('friend_scenarios')).toBe(0);
    expect(sentCount()).toBe(0);
    expect(JSON.parse(String(friendRow('U6').metadata ?? '{}'))).toEqual({});
    expect(friendRow('U6').ref_code).toBeNull();
  });

  test('T7 障害復旧: 抑止INSERTが一時失敗しても再試行で書き切り follow を抑止する', async () => {
    currentSub = 'U7';
    const { app, env } = setupApp(dbs.db);
    insertFaults.remaining = 2;

    const li = await postLink(app, env, 'B');
    expect(li.status).toBe(404);
    // 再試行 (失敗・失敗・成功) で記録が残る。
    expect(insertFaults.calls).toBe(3);
    expect(count('entry_route_stop_suppressions')).toBe(1);

    await postFollow(app, env, 'U7', 'ev-t7');
    expect(lastEvent().routing_status).toBe('suppressed');
    expect(count('friend_scenarios')).toBe(0);
    expect(sentCount()).toBe(0);
  });

  test('T8 同時記録: 同一キーの同時記録は1行に寄り、後の確定で友だちが埋まる', async () => {
    dbs.raw.exec(
      `INSERT INTO friends (id, line_user_id, display_name, line_account_id)
       VALUES ('f8', 'U8', 'T', 'acc1')`,
    );
    const { recordEntryRouteStopSuppression } = await import('@line-crm/db');

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        recordEntryRouteStopSuppression(dbs.db, {
          lineAccountId: 'acc1',
          lineUserId: 'U8',
          friendId: null,
          refCode: 'B',
          source: 'liff',
        }),
      ),
    );
    expect(count('entry_route_stop_suppressions')).toBe(1);
    expect(new Set(results.map((r) => r.id)).size).toBe(1);

    await recordEntryRouteStopSuppression(dbs.db, {
      lineAccountId: 'acc1',
      lineUserId: 'U8',
      friendId: 'f8',
      refCode: 'B',
      source: 'liff',
    });
    expect(count('entry_route_stop_suppressions')).toBe(1);
    const row = dbs.raw
      .prepare('SELECT friend_id FROM entry_route_stop_suppressions WHERE line_user_id = ?')
      .get('U8') as { friend_id: string | null };
    expect(row.friend_id).toBe('f8');
  });

  test('T9 全失敗: 記録が恒久失敗したら本線を止め、復旧後の再試行で引き継ぐ', async () => {
    currentSub = 'U9';
    const { app, env } = setupApp(dbs.db);
    insertFaults.remaining = 999;

    // 記録なしの 404/410/200 を返さず fail-closed (500) になる。
    expect((await postLink(app, env, 'B')).status).toBe(500);
    expect((await postIntent(app, env, 'B')).status).toBe(500);
    expect((await postCallback(app, env, 'B')).status).toBe(500);
    expect(count('entry_route_stop_suppressions')).toBe(0);

    // 復旧後の再試行で記録が残り、follow が抑止される (再照合)。
    // 失敗した callback が友だち行だけ作っているため、再試行の link は
    // 連携成功 (200) で記録する。
    insertFaults.remaining = 0;
    expect((await postLink(app, env, 'B')).status).toBe(200);
    expect(count('entry_route_stop_suppressions')).toBe(1);
    await postFollow(app, env, 'U9', 'ev-t9');
    expect(lastEvent().routing_status).toBe('suppressed');
    expect(count('friend_scenarios')).toBe(0);
    expect(sentCount()).toBe(0);
  });

  test('T10 複数接続: 別接続の未確定書き込みと競合しても1行に収束する', async () => {
    // 単一接続の Promise.all ではなく、同一ファイルへ複数接続する。
    // 片方が書き込みを握っている間の同一キー書き込みは競合し、
    // 確定後は upsert で1行に収束すること (真の並行の構造的保証)。
    const testDir = dirname(fileURLToPath(import.meta.url));
    const bootstrapSql = readFileSync(
      join(testDir, '../../../../packages/db/bootstrap.sql'), 'utf8',
    );
    const dir = mkdtempSync(join(tmpdir(), 'stop-'));
    const file = join(dir, 't.db');
    const norm = (args: unknown[]) =>
      args.map((a) => (a === undefined ? null : a));
    const mkConn = (busyTimeoutMs = 5000) => {
      const raw = new Database(file, { timeout: busyTimeoutMs });
      raw.pragma('journal_mode = WAL');
      const db = {
        prepare: (sql: string) => ({
          bind: (...args: unknown[]) => ({
            first: async () => raw.prepare(sql).get(...norm(args)) ?? null,
            all: async () => ({ results: raw.prepare(sql).all(...norm(args)) }),
            run: async () => {
              const info = raw.prepare(sql).run(...norm(args));
              return { meta: { changes: info.changes } };
            },
          }),
        }),
      } as unknown as D1Database;
      return { raw, db };
    };
    const conn0 = mkConn();
    conn0.raw.exec(bootstrapSql);
    conn0.raw.exec(
      `INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
       VALUES ('acc1', 'ch1', 'A', 'tok1', 'sec1')`,
    );
    conn0.raw.close();
    const A = mkConn();
    // B は短い待ちで競合を検出する (既定5秒ではテストが止まるため)。
    const B = mkConn(100);

    const cols = '(id, line_account_id, line_user_id, friend_id, ref_code, source, occurred_at, expires_at)';
    // 期限切れの行にしておく (旧コードの早道SELECTに当たらないよう)。
    A.raw.exec('BEGIN IMMEDIATE');
    A.raw.prepare(`INSERT INTO entry_route_stop_suppressions ${cols} VALUES (?,?,?,?,?,?,?,?)`).run(
      'id-a', 'acc1', 'Uc', null, 'B', 'liff',
      '2020-01-01T00:00:00.000+09:00', '2020-01-01T00:10:00.000+09:00',
    );
    // A が未確定の間、B の同一キー書き込みは競合する (壊さない)。
    await expect(
      B.db.prepare(`INSERT INTO entry_route_stop_suppressions ${cols} VALUES (?,?,?,?,?,?,?,?)`).bind(
        'id-b', 'acc1', 'Uc', null, 'B', 'liff',
        '2020-01-01T00:00:00.000+09:00', '2020-01-01T00:10:00.000+09:00',
      ).run(),
    ).rejects.toThrow(/locked|busy/i);
    A.raw.exec('COMMIT');

    // 確定後は通常の記録口で upsert し、1行に収束する。
    const { recordEntryRouteStopSuppression } = await import('@line-crm/db');
    const row = await recordEntryRouteStopSuppression(B.db, {
      lineAccountId: 'acc1',
      lineUserId: 'Uc',
      friendId: null,
      refCode: 'B',
      source: 'liff',
    });
    expect(row.refCode).toBe('B');
    const n = (B.raw.prepare('SELECT COUNT(*) AS c FROM entry_route_stop_suppressions').get() as { c: number }).c;
    expect(n).toBe(1);

    A.raw.close();
    B.raw.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('T11 移行整理: 既存重複は決定的に1行へ寄ってから一意索引ができる', async () => {
    // migration 362 の DELETE→INDEX の順序を直接固定する。
    // 重複が残ったまま索引を作ると SQLITE_CONSTRAINT で失敗するため。
    const testDir = dirname(fileURLToPath(import.meta.url));
    const migDir = join(testDir, '../../../../packages/db/migrations');
    const sql356 = readFileSync(join(migDir, '356_entry_route_stop_suppressions.sql'), 'utf8');
    const sql362 = readFileSync(join(migDir, '362_entry_route_stop_suppression_dedup.sql'), 'utf8');
    const dir = mkdtempSync(join(tmpdir(), 'stop-mig-'));
    const raw = new Database(join(dir, 'm.db'));
    // 参照整合性は本番の D1 と同じく切る (createTestD1 と同じ約束)。
    raw.pragma('foreign_keys = OFF');
    raw.exec(sql356);
    const cols = '(id, line_account_id, line_user_id, friend_id, ref_code, source, occurred_at, expires_at)';
    // 同一キーの重複2行 (発生日が異なる)。新しい方が先に入っていても古い方を残す。
    raw.prepare(`INSERT INTO entry_route_stop_suppressions ${cols} VALUES (?,?,?,?,?,?,?,?)`).run(
      'id-new', 'acc1', 'Um', null, 'B', 'liff',
      '2026-09-08T00:05:00.000+09:00', '2026-09-08T00:15:00.000+09:00',
    );
    raw.prepare(`INSERT INTO entry_route_stop_suppressions ${cols} VALUES (?,?,?,?,?,?,?,?)`).run(
      'id-old', 'acc1', 'Um', null, 'B', 'liff',
      '2026-09-08T00:00:00.000+09:00', '2026-09-08T00:10:00.000+09:00',
    );
    raw.exec(sql362);
    const rows = raw.prepare('SELECT id FROM entry_route_stop_suppressions').all() as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toEqual(['id-old']);
    // 索引が効き、以降の重複は受け付けない。
    expect(() =>
      raw.prepare(`INSERT INTO entry_route_stop_suppressions ${cols} VALUES (?,?,?,?,?,?,?,?)`).run(
        'id-dup', 'acc1', 'Um', null, 'B', 'liff',
        '2026-09-08T00:20:00.000+09:00', '2026-09-08T00:30:00.000+09:00',
      ),
    ).toThrow(/constraint/i);
    raw.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('T5 明示の帰属が勝つ: 停止試行の記録があっても active候補の流れは抑止しない', async () => {
    currentSub = 'U5';
    const { app, env } = setupApp(dbs.db);
    // 停止Bの試行記録を残した後、active Aで連携完了する。
    const intent = await postIntent(app, env, 'B');
    expect(intent.status).toBe(404);

    const cb = await postCallback(app, env, 'A');
    expect(cb.status).toBe(200);
    await postFollow(app, env, 'U5', 'ev-t5');

    expect(friendRow('U5').ref_code).toBe('A');
    expect(lastEvent().attribution_status).toBe('captured');
    expect(count('friend_scenarios')).toBeGreaterThan(0);
  });
});
