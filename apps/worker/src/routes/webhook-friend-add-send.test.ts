/*
 * 友だち追加の送信は1回だけ・送れなかったら再送可能。
 *
 * 実DB・実振り分け・実送信権予約で確かめる。外部LINEへは送らない
 *（line-sdk だけ差し替える）。DBはテスト用D1（better-sqlite3）を使う。
 */
import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type Database from 'better-sqlite3';
import type { Env } from '../worker-env.js';
import { createTestD1, insertFriend, type SqliteD1 } from '../test-utils/d1-sqlite.js';
import { useSqliteClock } from '../test-utils/sqlite-clock.js';
import { publishScenarioVersion } from '@line-crm/db';
import { isFriendAddResendSuppressed } from '../features/friends/friend-add-routing.js';

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

const eccubeMocks = vi.hoisted(() => ({ createEccubeCoupon: vi.fn() }));
vi.mock('../services/eccube-coupon.js', () => eccubeMocks);

import { verifySignature } from '@line-crm/line-sdk';
import { webhook } from './webhook.js';

let testDb: SqliteD1;
let raw: Database.Database;
let db: D1Database;

const env = () => ({
  DB: db,
  LINE_CHANNEL_SECRET: 'secret-1',
  LINE_CHANNEL_ACCESS_TOKEN: 'token-1',
}) as Record<string, unknown>;

async function seedBase(): Promise<void> {
  raw.prepare(
    `INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret, is_active)
     VALUES ('account-1', 'channel-1', '店舗1', 'token-1', 'secret-1', 1)`,
  ).run();
  raw.prepare(
    `INSERT INTO scenarios (id, name, trigger_type, is_active, delivery_mode, allow_concurrent, line_account_id)
     VALUES ('scenario-1', '初回案内', 'friend_add', 1, 'relative', 1, 'account-1')`,
  ).run();
  raw.prepare(
    `INSERT INTO scenario_steps (id, scenario_id, step_order, delay_minutes, message_type, message_content)
     VALUES ('step-1', 'scenario-1', 0, 0, 'text', 'ようこそ')`,
  ).run();
  raw.prepare(
    `INSERT INTO entry_routes (id, name, ref_code, is_active, line_account_id)
     VALUES ('route-1', '紹介QR', 'REF001', 1, 'account-1')`,
  ).run();
  const definition = JSON.stringify({
    routeIds: ['route-1'], scenarioId: 'scenario-1', messageType: 'scenario',
    messageText: '', timing: 'immediate', actions: [], friendCondition: '',
    activeFrom: null, activeUntil: null, weekdays: [], timeWindows: [],
    resendSuppressionHours: 24,
  });
  raw.prepare(
    `INSERT INTO friend_add_rules
      (id, line_account_id, friend_kind, name, priority, is_unknown_route_fallback,
       status, current_version_id, created_at, updated_at)
     VALUES ('rule-1', 'account-1', 'first_time', '初回案内', 1, 0,
       'published', 'version-1', '2026-09-01T00:00:00.000', '2026-09-01T00:00:00.000')`,
  ).run();
  raw.prepare(
    `INSERT INTO friend_add_rule_versions
      (id, rule_id, version_number, definition_snapshot, status)
     VALUES ('version-1', 'rule-1', 1, ?, 'published')`,
  ).run(definition);
  insertFriend(raw, 'friend-1', {
    line_user_id: 'U-1', line_account_id: 'account-1', unfollow_count: 0, ref_code: 'REF001',
  });
  // 参加には明示公開が要る。公開していないシナリオへは登録
  // しないので、ここで1度だけ公開して稼働中の状態にする。
  await publishScenarioVersion(db, 'scenario-1', {
    staffId: null,
    idempotencyKey: 'friend-add-send-seed',
  });
}

async function postFollow(
  webhookEventId: string,
  useDb: D1Database = db,
  extraEnv: Record<string, unknown> = {},
  timestamp = Date.now(),
): Promise<void> {
  const app = new Hono();
  app.route('/', webhook);
  const waitUntil = vi.fn();
  const response = await app.request('/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Line-Signature': 'x'.repeat(44) },
    body: JSON.stringify({
      destination: 'bot',
      events: [{
        type: 'follow', webhookEventId, timestamp,
        source: { type: 'user', userId: 'U-1' }, replyToken: `reply-${webhookEventId}`,
        follow: { isUnblocked: false },
      }],
    }),
  }, { ...env(), ...extraEnv, DB: useDb }, { waitUntil, passThroughOnException: vi.fn(), props: {} } as unknown as ExecutionContext);
  expect(response.status).toBe(200);
  await waitUntil.mock.calls[0]?.[0];
}

function sendCount(): number {
  return lineClientMocks.replyMessage.mock.calls.length + lineClientMocks.pushMessage.mock.calls.length;
}

/**
 * 実D1のまま、指定のSQLに当たった最初の呼び出しだけ壊す差し替え。
 * 「送信はできたがその後のDBが落ちた」を再現する。
 */
function breakOnceOn(useDb: D1Database, needle: string, error: Error): { db: D1Database; calls: () => number } {
  let armed = true;
  let calls = 0;
  const proxy = new Proxy(useDb, {
    get(target, prop, receiver) {
      if (prop !== 'prepare') return Reflect.get(target, prop, receiver);
      return (sql: string) => {
        const statement = ((target.prepare as unknown) as (query: string) => {
          bind: (...args: unknown[]) => Record<string, unknown>;
        })(sql);
        if (!armed || !sql.includes(needle)) return statement;
        return {
          ...statement,
          bind: (...args: unknown[]) => {
            const bound = statement.bind(...args);
            const fail = async () => {
              calls += 1;
              armed = false;
              throw error;
            };
            // RETURNING を使う文は first で走るので、両方を壊す。
            return { ...bound, run: fail, first: fail, all: fail };
          },
        };
      };
    },
  }) as D1Database;
  return { db: proxy, calls: () => calls };
}

function eventRows(): Array<{ routing_status: string; delivery_count: number; error_code: string | null }> {
  return raw.prepare(
    `SELECT routing_status, delivery_count, error_code FROM friend_add_events ORDER BY id`,
  ).all() as Array<{ routing_status: string; delivery_count: number; error_code: string | null }>;
}

beforeEach(async () => {
  testDb = createTestD1();
  raw = testDb.raw;
  db = testDb.db;
  await seedBase();
  vi.mocked(verifySignature).mockResolvedValue(true);
  /*
   * `vi.clearAllMocks` は呼び出し記録しか消さないので、`...Once` の
   * 待ち行列が残ると次の試験へ漏れる（送れたはずの試験が送達不明になる）。
   * 送信の口だけは毎回まっさらにしてから既定を敷き直す。
   */
  lineClientMocks.replyMessage.mockReset();
  lineClientMocks.pushMessage.mockReset();
  lineClientMocks.getProfile.mockResolvedValue({ displayName: 'U-1さん' });
  lineClientMocks.replyMessage.mockResolvedValue(undefined);
  lineClientMocks.pushMessage.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
  testDb.raw.close();
});

describe('POST /webhook — 並行followの単一化 (#622)', () => {
  test('別webhook IDで並行に届いても1回だけ送る', async () => {
    // 送信を遅らせて競合の窓を広げる。それでも1回だけ送る。
    lineClientMocks.replyMessage.mockImplementation(
      async () => { await new Promise((resolve) => setTimeout(resolve, 50)); },
    );
    const occurredAt=Date.now();
    await Promise.all([postFollow('webhook-a',db,{},occurredAt), postFollow('webhook-b',db,{},occurredAt)]);

    const sends = lineClientMocks.replyMessage.mock.calls.length
      + lineClientMocks.pushMessage.mock.calls.length;
    expect(sends).toBe(1);

    const rows = eventRows();
    expect(rows).toHaveLength(2);
    const statuses = rows.map((row) => row.routing_status).sort();
    expect(statuses).toEqual(['completed', 'suppressed']);
    const completed = rows.find((row) => row.routing_status === 'completed')!;
    expect(completed.delivery_count).toBe(1);
    expect(completed.error_code).toBeNull();
    // 取れなかった側は登録自体を作らず抑止として残す
    const deferred = rows.find((row) => row.routing_status === 'suppressed')!;
    expect(deferred.delivery_count).toBe(0);
    expect(deferred.error_code).toBe('duplicate_in_flight');
    // 予約のゴミを残さない
    expect(raw.prepare(`SELECT COUNT(*) AS n FROM friend_add_send_claims`).get()).toEqual({ n: 0 });
  });
});

describe('POST /webhook — 送信後の台帳確定失敗 (#622)', () => {
  test('送ったあと確定に失敗しても別webhookは二重送信しない（送達不明契約）', async () => {
    // 最初の確定UPDATEだけ壊す。送信は通るが台帳は pending のまま残る。
    // 状態を書く大きな1文（確定）だけを壊す。送信の事実を残す1文とは別。
    const sabotage = breakOnceOn(db, 'SET routing_status', new Error('DB down after send'));
    await postFollow('webhook-a', sabotage.db);
    expect(sabotage.calls()).toBe(1);
    expect(sendCount()).toBe(1);

    // 送ったが確定できていない。予約は掴んだままにする
    const held = raw.prepare(`SELECT event_id FROM friend_add_send_claims`).get() as { event_id: string };
    const eventA = raw.prepare(
      `SELECT id FROM friend_add_events WHERE webhook_event_id = 'webhook-a'`,
    ).get() as { id: string };
    expect(held).toEqual({ event_id: eventA.id });
    const pending = raw.prepare(
      `SELECT routing_status FROM friend_add_events WHERE id = (SELECT id FROM friend_add_events WHERE webhook_event_id = 'webhook-a')`,
    ).get() as { routing_status: string };
    expect(pending).toEqual({ routing_status: 'pending' });

    // 別のwebhook IDで並行に届いても、予約が掴まれているため送らない
    await postFollow('webhook-b');
    expect(sendCount()).toBe(1);
    const rows = eventRows();
    expect(rows.map((row) => row.routing_status).sort()).toEqual(['pending', 'suppressed']);
    const deferred = rows.find((row) => row.routing_status === 'suppressed')!;
    expect(deferred).toMatchObject({ delivery_count: 0, error_code: 'duplicate_in_flight' });
    // 予約は最初の実行が掴んだまま（確定するまで解放しない）
    expect(raw.prepare(`SELECT event_id FROM friend_add_send_claims`).get()).toEqual({ event_id: eventA.id });
  });
});

describe('POST /webhook — 古い予約と予約失敗 (#622)', () => {
  test('2分過ぎた古い予約は奪い直して送る', async () => {
    raw.prepare(
      `INSERT INTO friend_add_send_claims (line_account_id, friend_id, event_id, generation, claimed_at)
       VALUES ('account-1', 'friend-1', 'webhook-crashed', 1, '2026-09-01T10:00:00.000+09:00')`,
    ).run();
    await postFollow('webhook-new');
    expect(sendCount()).toBe(1);
    const rows = eventRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ routing_status: 'completed', delivery_count: 1 });
  });

  test('予約を持つ実行がいるときは送らずに引く（旧holder確定）', async () => {
    raw.prepare(
      `INSERT INTO friend_add_send_claims (line_account_id, friend_id, event_id, generation, claimed_at)
       VALUES ('account-1', 'friend-1', 'webhook-holder', 1, '2999-01-01T00:00:00.000+09:00')`,
    ).run();
    await postFollow('webhook-new');
    expect(sendCount()).toBe(0);
    const rows = eventRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      routing_status: 'suppressed', delivery_count: 0, error_code: 'duplicate_in_flight',
    });
    // 他人の予約はそのまま
    expect(raw.prepare(`SELECT event_id FROM friend_add_send_claims`).get()).toEqual({ event_id: 'webhook-holder' });
  });

  test('予約のDB失敗は送らない（fail-closed）', async () => {
    const sabotage = breakOnceOn(db, 'friend_add_send_claims', new Error('D1 down'));
    await postFollow('webhook-new', sabotage.db);
    expect(sabotage.calls()).toBe(1);
    expect(sendCount()).toBe(0);
    const rows = eventRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      routing_status: 'suppressed', delivery_count: 0, error_code: 'send_claim_unavailable',
    });
  });
});

describe('POST /webhook — 台帳が作れないときは送らない (#622)', () => {
  test('台帳の行を作れなかった実行は外部送信もしない（fail-closed）', async () => {
    // 台帳が無ければ送信権も持てず、結果も残せない。送ると二重に届いたうえ
    // 誰も気づけない。
    const sabotage = breakOnceOn(db, 'INSERT OR IGNORE INTO friend_add_events', new Error('D1 down'));
    await postFollow('webhook-no-ledger', sabotage.db);

    expect(sabotage.calls()).toBe(1);
    expect(sendCount()).toBe(0);
    expect(eventRows()).toHaveLength(0);
    expect(raw.prepare(`SELECT COUNT(*) AS n FROM friend_scenarios`).get()).toEqual({ n: 0 });
    expect(raw.prepare(`SELECT COUNT(*) AS n FROM friend_add_send_claims`).get()).toEqual({ n: 0 });
  });
});

describe('POST /webhook — 送信の結末を分ける (#622)', () => {
  test('LINEが断った送信（4xx）は send_failed で残し、次の追加を止めない', async () => {
    const rejected = Object.assign(new Error('LINE API error: 400'), { status: 400 });
    lineClientMocks.replyMessage.mockRejectedValueOnce(rejected);
    lineClientMocks.pushMessage.mockRejectedValue(rejected);
    await postFollow('webhook-fail');

    const sends = lineClientMocks.replyMessage.mock.calls.length
      + lineClientMocks.pushMessage.mock.calls.length;
    expect(sends).toBeGreaterThan(0);
    const rows = eventRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      routing_status: 'partial_failed', delivery_count: 0, error_code: 'send_failed',
    });

    // 届いていないので cron の再試行に載せる（claim を返す）
    expect(raw.prepare(
      `SELECT status FROM friend_scenarios WHERE friend_id = 'friend-1'`,
    ).get()).toEqual({ status: 'active' });
    // 届いていないと言い切れるので、再送制限は数えない。次の追加で送り直せる。
    await expect(isFriendAddResendSuppressed(db, {
      lineAccountId: 'account-1', friendId: 'friend-1',
      resendSuppressionHours: 24, now: new Date(),
    })).resolves.toBe(false);
    // 予約は返す（次の実行が取れる）
    expect(raw.prepare(`SELECT COUNT(*) AS n FROM friend_add_send_claims`).get()).toEqual({ n: 0 });
  });

  test('通信断のように結末が分からない送信は delivery_unknown にし、自動で送り直さない', async () => {
    // status を持たない例外＝こちらが結果を知らないだけで、届いたかもしれない。
    lineClientMocks.replyMessage.mockRejectedValueOnce(new Error('network timeout'));
    lineClientMocks.pushMessage.mockRejectedValue(new Error('network timeout'));
    await postFollow('webhook-unknown');

    const rows = eventRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      routing_status: 'partial_failed', delivery_count: 0, error_code: 'delivery_unknown',
    });

    // 自動再送の対象から外す。送り直すと二重に届く。
    await expect(isFriendAddResendSuppressed(db, {
      lineAccountId: 'account-1', friendId: 'friend-1',
      resendSuppressionHours: 24, now: new Date(),
    })).resolves.toBe(true);
    // cron に送り直させない（届いていたら2通目になる）。1通目は送り終えた扱い。
    // 1通しかないシナリオなので「読み終えた」へ進む。active/delivering に
    // 戻さない＝cronが1通目を拾い直さない。
    expect(raw.prepare(
      `SELECT status FROM friend_scenarios WHERE friend_id = 'friend-1'`,
    ).get()).toEqual({ status: 'completed' });
    // 予約は掴んだまま残す（TTLまで別の実行を止める）
    const claim = raw.prepare(`SELECT event_id FROM friend_add_send_claims`).get() as { event_id: string };
    const event = raw.prepare(
      `SELECT id FROM friend_add_events WHERE webhook_event_id = 'webhook-unknown'`,
    ).get() as { id: string };
    expect(claim).toEqual({ event_id: event.id });
  });

  test('送達不明のあとの再追加は送らず、理由を残す', async () => {
    lineClientMocks.replyMessage.mockRejectedValueOnce(new Error('network timeout'));
    lineClientMocks.pushMessage.mockRejectedValueOnce(new Error('network timeout'));
    await postFollow('webhook-unknown');
    const before = sendCount();

    // 予約のTTLを過ぎさせて「別の実行が取れる」状態にしても、
    // 台帳の送達不明が再送制限として効く。
    raw.prepare(
      `UPDATE friend_add_send_claims SET claimed_at = '2026-09-01T10:00:00.000+09:00'`,
    ).run();
    lineClientMocks.replyMessage.mockResolvedValue(undefined);
    lineClientMocks.pushMessage.mockResolvedValue(undefined);
    await postFollow('webhook-after-unknown');

    expect(sendCount()).toBe(before);
    // 奪い直せても、前の持ち主の「送り始めた」印が残っているので送らない。
    const rows = eventRows();
    const latest = rows.find((row) => row.error_code === 'delivery_unknown' && row.routing_status === 'suppressed');
    expect(latest).toMatchObject({ routing_status: 'suppressed', delivery_count: 0 });
  });
});

/*
 * 1回のfollowで複数の送信を行う。**1通でも結末が分からなければ送達不明。**
 * 別の1通が送れたからといって「送れた」に丸めると、予約を返してしまい、
 * 不明だった通を次のfollowが送り直す（届いていたら2通目になる）。
 */
/*
 * クーポンの本文送信も外部送信なので、**送るひとつ手前**で関門を通す。
 * まとめて1回だけ確認していると、クーポンの作成（外部API）に時間がかかった
 * 間に予約を奪われても気づけず、奪った側と両方が送ってしまう。
 */
/*
 * 送達不明は予約を解放できず、送信開始印を無期限にすると以後の友だち追加も届かなくなる。
 * 印に期限を設け、期限後の追加操作では再び送信できるようにする。
 */
/*
 * 振り分けの登録・アクションも、外部送信と同じ予約の下で行う。
 * ここが関門の外にあると、回収されたあとの実行が購読を作ってしまい、
 * cron がそれを拾って勝った側と二重に配信する。
 */
/*
 * 台帳の確定が落ちた実行の、**印の期限が切れたあと**。
 *
 * 確定はまとめて書く大きな1文で、そこが落ちると行は pending のまま残る。
 * pending は再送制限が数える材料のどれにも当たらないので、印が落ちたあとに
 * 次の追加がもう1通送ってしまう。しかもこの経路の2通目は replyMessage で、
 * 再試行キーが付かないので LINE 側でも弾かれない。
 * 送れた事実だけを確定とは別の1文で先に残して塞ぐ。
 */
/*
 * 観点(4)の「action」側。登録の直前の関門を通っても、そのあと購読の書き込みを
 * 挟むので奪われる窓がある。そこを抜けたアクションは、タグ付けの副作用や
 * シナリオ開始から**外へ送りえる**。アクションのひとつ手前でも関門を通す。
 */
describe('POST /webhook — アクションのひとつ手前でも関門を通す (#622)', () => {
  /** 初回案内のルールへ「タグを付ける」アクションを足す。 */
  function seedTagAction(): void {
    raw.prepare(
      `INSERT INTO tags (id, name, line_account_id) VALUES ('tag-1', '見込み客', 'account-1')`,
    ).run();
    // 公開版は書き換えられない（トリガーで不変）。新しい版を作って差し替える。
    const definition = JSON.parse(raw.prepare(
      `SELECT definition_snapshot FROM friend_add_rule_versions WHERE id = 'version-1'`,
    ).pluck().get() as string) as Record<string, unknown>;
    /*
     * 行アクション（タグ）と、行ではないアクション（マイル）の両方を置く。
     * 前者は `runActionRows` の手前、後者はアクションごとのループの手前で
     * 関門を通るので、どちらの関門も見張れる。
     */
    definition.actions = [
      { type: 'add_tag', targetId: 'tag-1' },
      { kind: 'mile', amount: 5 },
    ];
    // 公開版は1ルールに1つ。先に旧版を下書きへ落としてから新版を公開する。
    raw.prepare(
      `UPDATE friend_add_rule_versions SET status = 'draft' WHERE id = 'version-1'`,
    ).run();
    raw.prepare(
      `INSERT INTO friend_add_rule_versions
        (id, rule_id, version_number, definition_snapshot, status)
       VALUES ('version-2', 'rule-1', 2, ?, 'published')`,
    ).run(JSON.stringify(definition));
    raw.prepare(
      `UPDATE friend_add_rules SET current_version_id = 'version-2' WHERE id = 'rule-1'`,
    ).run();
  }

  function tagCount(): number {
    return (raw.prepare(
      `SELECT COUNT(*) AS n FROM friend_tags WHERE friend_id = 'friend-1' AND tag_id = 'tag-1'`,
    ).get() as { n: number }).n;
  }

  function mileCount(): number {
    return (raw.prepare(
      `SELECT COUNT(*) AS n FROM mileage_ledger WHERE beneficiary_friend_id = 'friend-1'
        AND source = 'friend_add_routing'`,
    ).get() as { n: number }).n;
  }

  test('購読を書いたあとに奪われたら、アクションは実行しない', async () => {
    seedTagAction();
    // 登録の直前の関門は通し、購読の書き込みで奪う。
    let stolen = false;
    const proxy = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== 'prepare') return Reflect.get(target, prop, receiver);
        return (sql: string) => {
          if (!stolen && sql.includes('INSERT') && sql.includes('friend_scenarios')) {
            stolen = true;
            raw.prepare(
              `UPDATE friend_add_send_claims
                  SET event_id = 'stolen-by-other', generation = generation + 1`,
            ).run();
          }
          return (target.prepare as unknown as (q: string) => unknown)(sql);
        };
      },
    }) as D1Database;

    await postFollow('webhook-action-fenced', proxy);

    expect(stolen).toBe(true);
    // 行アクションも、アクションごとのループのぶんも動かない
    expect(tagCount()).toBe(0);
    expect(mileCount()).toBe(0);
    // 送信もしない・台帳も書かない（勝った側が書く）
    expect(sendCount()).toBe(0);
    expect(raw.prepare(
      `SELECT routing_status FROM friend_add_events WHERE webhook_event_id = 'webhook-action-fenced'`,
    ).get()).toEqual({ routing_status: 'pending' });
  });

  test('奪われていなければアクションは実行する', async () => {
    seedTagAction();
    await postFollow('webhook-action-ok');
    expect(tagCount()).toBe(1);
    expect(mileCount()).toBe(1);
    expect(sendCount()).toBe(1);
  });
});

describe('POST /webhook — 確定に失敗しても、期限の先で2通目を送らない (#622)', () => {
  function ageEverything(minutesAgo: number): void {
    const at = new Date(Date.now() - minutesAgo * 60_000);
    const jst = new Date(at.getTime() + 9 * 60 * 60 * 1000)
      .toISOString().replace('Z', '+09:00');
    raw.prepare(`UPDATE friend_add_send_claims SET claimed_at = ?, dispatched_at = ?`).run(jst, jst);
    raw.prepare(`UPDATE friend_add_events SET occurred_at = ?, created_at = ?`).run(jst, jst);
  }

  test('確定が落ちても送信の事実は残り、期限切れ後の追加でも送らない', async () => {
    // 状態を書く大きな1文（確定）だけを壊す。送信は通る。
    const sabotage = breakOnceOn(db, 'SET routing_status', new Error('DB down after send'));
    await postFollow('webhook-ledger-down', sabotage.db);
    expect(sabotage.calls()).toBe(1);
    expect(sendCount()).toBe(1);

    // 台帳は pending のまま。ただし送信の事実は残っている。
    const row = raw.prepare(
      `SELECT routing_status, delivery_count, first_delivery_sent_at IS NOT NULL AS stamped
         FROM friend_add_events WHERE webhook_event_id = 'webhook-ledger-down'`,
    ).get() as { routing_status: string; delivery_count: number; stamped: number };
    expect(row).toMatchObject({ routing_status: 'pending', delivery_count: 1, stamped: 1 });

    /*
     * **印の期限（30分）は過ぎ、再送制限（24時間）の窓はまだ内側**という
     * 区間で追加し直す。ここが今回の穴。台帳に送信の記録が無いと、
     * 印が落ちた瞬間から2通目が出る。
     */
    ageEverything(60);
    lineClientMocks.replyMessage.mockResolvedValue(undefined);
    await postFollow('webhook-after-ledger-down');

    // 2通目は出ない
    expect(sendCount()).toBe(1);
    expect(raw.prepare(
      `SELECT routing_status, error_code FROM friend_add_events
        WHERE webhook_event_id = 'webhook-after-ledger-down'`,
    ).get()).toEqual({ routing_status: 'suppressed', error_code: 'resend_suppressed' });
  });

  test('送信の事実は、確定より先に残る（順序）', async () => {
    const order: string[] = [];
    const proxy = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== 'prepare') return Reflect.get(target, prop, receiver);
        return (sql: string) => {
          if (sql.includes('delivery_count = delivery_count + 1')) order.push('sent-fact');
          if (sql.includes('SET routing_status')) order.push('finalize');
          return (target.prepare as unknown as (q: string) => unknown)(sql);
        };
      },
    }) as D1Database;

    await postFollow('webhook-order', proxy);

    expect(order.indexOf('sent-fact')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('sent-fact')).toBeLessThan(order.lastIndexOf('finalize'));
  });
});

describe('POST /webhook — 振り分けの登録・アクションも関門の下 (#622)', () => {
  test('登録の直前に予約を奪われたら、購読を作らず台帳も書かない', async () => {
    // 振り分けの評価中（＝登録より前）に、別の実行が予約を奪う。
    // 評価は friend_add_rule_versions を読むので、その読み取りに割り込む。
    let stolen = false;
    const proxy = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== 'prepare') return Reflect.get(target, prop, receiver);
        return (sql: string) => {
          const stmt = (target.prepare as unknown as (q: string) => unknown)(sql) as Record<string, unknown>;
          if (!stolen && sql.includes('friend_add_rule_versions')) {
            stolen = true;
            raw.prepare(
              `UPDATE friend_add_send_claims
                  SET event_id = 'stolen-by-other', generation = generation + 1`,
            ).run();
          }
          return stmt;
        };
      },
    }) as D1Database;

    await postFollow('webhook-fenced-enroll', proxy);

    expect(stolen).toBe(true);
    // 送らない・購読を作らない
    expect(sendCount()).toBe(0);
    expect(raw.prepare(`SELECT COUNT(*) AS n FROM friend_scenarios`).get()).toEqual({ n: 0 });
    // 台帳も書かない（勝った側が書く）
    expect(raw.prepare(
      `SELECT routing_status FROM friend_add_events WHERE webhook_event_id = 'webhook-fenced-enroll'`,
    ).get()).toEqual({ routing_status: 'pending' });
    // 予約は奪った側のまま
    expect(raw.prepare(`SELECT event_id FROM friend_add_send_claims`).get())
      .toEqual({ event_id: 'stolen-by-other' });
  });

  test('奪われていなければ登録して送る', async () => {
    await postFollow('webhook-normal-enroll');
    expect(sendCount()).toBe(1);
    expect(raw.prepare(`SELECT COUNT(*) AS n FROM friend_scenarios`).get()).toEqual({ n: 1 });
  });
});

describe('POST /webhook — 送達不明からの復旧 (#622)', () => {
  /** 台帳・予約・購読・送信記録を「じゅうぶん前」の状態にする。 */
  function ageEverything(minutesAgo: number): void {
    const at = new Date(Date.now() - minutesAgo * 60_000);
    const jst = new Date(at.getTime() + 9 * 60 * 60 * 1000)
      .toISOString().replace('Z', '+09:00');
    raw.prepare(`UPDATE friend_add_send_claims SET claimed_at = ?, dispatched_at = ?`).run(jst, jst);
    raw.prepare(`UPDATE friend_add_events SET occurred_at = ?, created_at = ?`).run(jst, jst);
    raw.prepare(`DELETE FROM friend_scenarios`).run();
    raw.prepare(`DELETE FROM messages_log`).run();
  }

  async function makeDeliveryUnknown(): Promise<void> {
    lineClientMocks.replyMessage.mockRejectedValueOnce(new Error('network timeout'));
    lineClientMocks.pushMessage.mockRejectedValueOnce(new Error('network timeout'));
    await postFollow('webhook-unknown-1');
    expect(eventRows()[0]).toMatchObject({ error_code: 'delivery_unknown' });
    expect(raw.prepare(`SELECT COUNT(*) AS n FROM friend_add_send_claims`).get()).toEqual({ n: 1 });
  }

  test('印が期限内のうちは、追加し直しても送らない', async () => {
    await makeDeliveryUnknown();
    const before = sendCount();
    // 予約は奪える古さにするが、印はまだ新しい（10分前）
    ageEverything(10);
    lineClientMocks.replyMessage.mockResolvedValue(undefined);

    await postFollow('webhook-retry-soon');

    expect(sendCount()).toBe(before);
    const row = eventRows().find((r) => r.error_code === 'delivery_unknown' && r.delivery_count === 0);
    expect(row).toBeTruthy();
  });

  test('印の期限が切れたあとの追加では、ふつうに届く', async () => {
    await makeDeliveryUnknown();
    const before = sendCount();
    // 30日前まで戻す（台帳の再送制限も予約の印もじゅうぶん古い）
    ageEverything(60 * 24 * 30);
    lineClientMocks.replyMessage.mockResolvedValue(undefined);

    await postFollow('webhook-retry-later');

    // 届く
    expect(sendCount()).toBe(before + 1);
    const recovered = raw.prepare(
      `SELECT routing_status, delivery_count, error_code FROM friend_add_events
        WHERE webhook_event_id = 'webhook-retry-later'`,
    ).get();
    expect(recovered).toEqual({ routing_status: 'completed', delivery_count: 1, error_code: null });
    // 送り終えたので予約は返り、印も残らない
    expect(raw.prepare(`SELECT COUNT(*) AS n FROM friend_add_send_claims`).get()).toEqual({ n: 0 });
  });

  test('送達不明を繰り返しても、印が積み残って永久に止まることはない', async () => {
    await makeDeliveryUnknown();
    for (const id of ['webhook-again-1', 'webhook-again-2']) {
      ageEverything(60 * 24 * 30);
      lineClientMocks.replyMessage.mockRejectedValueOnce(new Error('network timeout'));
      lineClientMocks.pushMessage.mockRejectedValueOnce(new Error('network timeout'));
      await postFollow(id);
    }
    // 最後にもう一度、こんどは送れる状態で
    ageEverything(60 * 24 * 30);
    lineClientMocks.replyMessage.mockResolvedValue(undefined);
    await postFollow('webhook-again-final');

    expect(raw.prepare(
      `SELECT routing_status, delivery_count FROM friend_add_events
        WHERE webhook_event_id = 'webhook-again-final'`,
    ).get()).toEqual({ routing_status: 'completed', delivery_count: 1 });
  });
});

describe('POST /webhook — クーポン本文の送信も直前の関門をくぐる (#622)', () => {
  const EC_ENV = { NEN_EC_BASE_URL: 'https://ec.example', ECCUBE_WEBHOOK_SECRET: 'ec-secret' };

  function enableCoupon(): void {
    raw.prepare(
      `INSERT INTO account_settings (line_account_id, key, value)
       VALUES ('account-1', 'nen.friend_add_coupon', ?)`,
    ).run(JSON.stringify({
      isEnabled: true, deliveryMode: 'generated', codePrefix: 'NENLINE',
      discountRate: 5, validityDays: 31, couponName: 'LINE友だち追加 5%OFF',
    }));
  }

  function couponPushCount(): number {
    return lineClientMocks.pushMessage.mock.calls.filter(
      (call) => JSON.stringify(call[1] ?? '').includes('5%OFF'),
    ).length;
  }

  test('クーポン本文の未解決の共通情報は送らず失敗に残す', async () => {
    vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-11-18T01:00:00Z'));useSqliteClock(raw,()=>new Date());
    try {
      enableCoupon();
      raw.prepare("UPDATE account_settings SET value=json_set(value,'$.messageTemplate',?) WHERE key='nen.friend_add_coupon'")
        .run('案内 {{var.hours}} コード {coupon_code} 期限 {expires_on}');
      eccubeMocks.createEccubeCoupon.mockResolvedValue(undefined);
      await postFollow('coupon-var-missing',db,EC_ENV);
      expect(lineClientMocks.pushMessage.mock.calls.some(call=>JSON.stringify(call[1]).includes('コード'))).toBe(false);
      expect(raw.prepare("SELECT source_kind,source_id,var_key,reason FROM common_var_resolution_failures WHERE source_id='friend_add_coupon'").all())
        .toEqual([{source_kind:'notification',source_id:'friend_add_coupon',var_key:'hours',reason:'missing'}]);
    } finally {vi.useRealTimers();}
  });

  test('クーポン作成中に予約を奪われたら、本文を送らない', async () => {
    enableCoupon();
    // 作成（外部API）の最中に、別の実行が予約を奪う。
    eccubeMocks.createEccubeCoupon.mockImplementation(async () => {
      raw.prepare(
        `UPDATE friend_add_send_claims
            SET event_id = 'stolen-by-other', generation = generation + 1`,
      ).run();
    });

    await postFollow('webhook-coupon-fenced', db, EC_ENV);

    expect(eccubeMocks.createEccubeCoupon).toHaveBeenCalledTimes(1);
    // 奪われているので本文は送らない
    expect(couponPushCount()).toBe(0);
    // 台帳も奪った側のもの。旧持ち主は書かない。
    expect(raw.prepare(
      `SELECT routing_status FROM friend_add_events WHERE webhook_event_id = 'webhook-coupon-fenced'`,
    ).get()).toEqual({ routing_status: 'pending' });
    // 発行台帳は「作成済み・未送信」で残る（送っていないので sent にしない）
    expect(raw.prepare(
      `SELECT status FROM nen_friend_add_coupon_issues WHERE friend_id = 'friend-1'`,
    ).get()).toEqual({ status: 'coupon_created' });
  });

  test('奪われていなければクーポン本文を送る', async () => {
    enableCoupon();
    eccubeMocks.createEccubeCoupon.mockResolvedValue(undefined);

    await postFollow('webhook-coupon-ok', db, EC_ENV);

    expect(couponPushCount()).toBe(1);
    expect(raw.prepare(
      `SELECT status FROM nen_friend_add_coupon_issues WHERE friend_id = 'friend-1'`,
    ).get()).toEqual({ status: 'sent' });
  });
});

describe('POST /webhook — 複数送信の結末は不明を最優先 (#622)', () => {
  function seedIntroTemplateOn(raw2: typeof raw): void {
    raw2.prepare(
      `INSERT INTO message_templates (id, name, message_type, message_content)
       VALUES ('tpl-1', '紹介あいさつ', 'text', '{"text":"ご紹介ありがとうございます"}')`,
    ).run();
    raw2.prepare(`UPDATE entry_routes SET intro_template_id = 'tpl-1' WHERE id = 'route-1'`).run();
  }

  test('初回案内が不明・紹介リンクの案内が成功でも、送達不明として扱う', async () => {
    seedIntroTemplateOn(raw);
    // 初回案内（reply）は通信断。紹介リンクの案内（push）は成功。
    lineClientMocks.replyMessage.mockRejectedValueOnce(new Error('network timeout'));
    lineClientMocks.pushMessage.mockResolvedValue(undefined);

    await postFollow('webhook-mixed');

    // 紹介リンクの案内は届いている
    expect(lineClientMocks.pushMessage.mock.calls.length).toBeGreaterThan(0);
    const rows = eventRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ error_code: 'delivery_unknown' });
    // 予約は掴んだまま（返すと不明だった初回案内を次のfollowが送り直す）
    const claim = raw.prepare(`SELECT COUNT(*) AS n FROM friend_add_send_claims`).get();
    expect(claim).toEqual({ n: 1 });
    // 自動再送の対象から外れている
    await expect(isFriendAddResendSuppressed(db, {
      lineAccountId: 'account-1', friendId: 'friend-1',
      resendSuppressionHours: 24, now: new Date(),
    })).resolves.toBe(true);
  });

  test('逆順（先に成功、あとで不明）でも送達不明として扱う', async () => {
    seedIntroTemplateOn(raw);
    // 初回案内（reply）は成功。紹介リンクの案内（push）が通信断。
    lineClientMocks.replyMessage.mockResolvedValue(undefined);
    lineClientMocks.pushMessage.mockRejectedValue(new Error('network timeout'));

    await postFollow('webhook-mixed-reverse');

    const rows = eventRows();
    expect(rows).toHaveLength(1);
    // 1通は確かに送れているので送信数は残しつつ、結末は不明で残す
    expect(rows[0]).toMatchObject({ delivery_count: 1, error_code: 'delivery_unknown' });
    expect(raw.prepare(`SELECT COUNT(*) AS n FROM friend_add_send_claims`).get()).toEqual({ n: 1 });
  });

  test('すべて成功なら従来どおり completed で予約を返す', async () => {
    seedIntroTemplateOn(raw);
    lineClientMocks.replyMessage.mockResolvedValue(undefined);
    lineClientMocks.pushMessage.mockResolvedValue(undefined);

    await postFollow('webhook-all-ok');

    expect(eventRows()[0]).toMatchObject({
      routing_status: 'completed', delivery_count: 1, error_code: null,
    });
    expect(raw.prepare(`SELECT COUNT(*) AS n FROM friend_add_send_claims`).get()).toEqual({ n: 0 });
  });
});

describe('POST /webhook — 流入リンクの案内も同じ送信権の下 (#622)', () => {
  function seedIntroTemplate(): void {
    raw.prepare(
      `INSERT INTO message_templates (id, name, message_type, message_content)
       VALUES ('tpl-1', '紹介あいさつ', 'text', '{"text":"ご紹介ありがとうございます"}')`,
    ).run();
    raw.prepare(`UPDATE entry_routes SET intro_template_id = 'tpl-1' WHERE id = 'route-1'`).run();
  }

  test('並行followの負けた側は流入リンクの案内も押さない', async () => {
    seedIntroTemplate();
    lineClientMocks.replyMessage.mockImplementation(
      async () => { await new Promise((resolve) => setTimeout(resolve, 50)); },
    );
    const occurredAt=Date.now();
    await Promise.all([postFollow('webhook-a',db,{},occurredAt), postFollow('webhook-b',db,{},occurredAt)]);

    // シナリオ1通（reply）＋ 流入リンクの案内1通（push）。負けた側は0通。
    expect(lineClientMocks.replyMessage.mock.calls.length).toBe(1);
    expect(lineClientMocks.pushMessage.mock.calls.length).toBe(1);
  });

  test('送信権を持つ実行がいるときは、単独のfollowでも案内を押さない', async () => {
    seedIntroTemplate();
    raw.prepare(
      `INSERT INTO friend_add_send_claims (line_account_id, friend_id, event_id, generation, claimed_at)
       VALUES ('account-1', 'friend-1', 'webhook-holder', 1, '2999-01-01T00:00:00.000+09:00')`,
    ).run();
    await postFollow('webhook-new');
    expect(sendCount()).toBe(0);
  });

  test('回収された旧持ち主は、案内も台帳の確定もしない', async () => {
    seedIntroTemplate();
    // 送信のあいだに予約を奪われる状況を作る。
    lineClientMocks.replyMessage.mockImplementation(async () => {
      raw.prepare(
        `UPDATE friend_add_send_claims SET event_id = 'webhook-thief', generation = generation + 1`,
      ).run();
    });
    await postFollow('webhook-a');

    // 送ってしまった1通は取り消せないが、そのあとの案内は押さない
    expect(lineClientMocks.pushMessage.mock.calls.length).toBe(0);
    // 台帳は勝った側が確定する。回収された側は書かない。
    const rows = eventRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ routing_status: 'pending' });
    // 予約は奪った側のまま
    expect(raw.prepare(`SELECT event_id FROM friend_add_send_claims`).get())
      .toEqual({ event_id: 'webhook-thief' });
  });
});

describe('POST /webhook — 流入リンクの案内の共通情報 (N-189)', () => {
  // 紹介リンクの案内テンプレートにも {{var.*}} を書ける。消えた共通情報は
  // 生のまま送らず fail-closed で止め、出所を台帳へ残す。
  test('消えた共通情報を含む案内テンプレートは送らず、台帳へ残す', async () => {
    raw.prepare(
      `INSERT INTO message_templates (id, name, message_type, message_content)
       VALUES ('tpl-1', '紹介あいさつ', 'text', '{"text":"営業時間は{{var.hours}}です"}')`,
    ).run();
    raw.prepare(`UPDATE entry_routes SET intro_template_id = 'tpl-1' WHERE id = 'route-1'`).run();
    lineClientMocks.replyMessage.mockResolvedValue(undefined);
    lineClientMocks.pushMessage.mockResolvedValue(undefined);

    await postFollow('webhook-var-missing');

    // 案内のpushは送られない(シナリオの初回配信がpushを使うならそちらも
    // 未解決で止まる。いずれにせよ生の差し込み名は一切送らない)。
    for (const call of lineClientMocks.pushMessage.mock.calls) {
      const messages = call[1] as Array<{ text?: string }>;
      for (const message of messages) {
        expect(message.text ?? '').not.toContain('{{var.');
      }
    }
    expect(raw.prepare(
      `SELECT source_kind, source_id, var_key, reason FROM common_var_resolution_failures`,
    ).all()).toEqual([
      { source_kind: 'notification', source_id: 'route-1', var_key: 'hours', reason: 'missing' },
    ]);
  });

  test('定義済みの共通情報は送信時点の値へ置き換えて案内を送る', async () => {
    raw.prepare(
      `INSERT INTO message_templates (id, name, message_type, message_content)
       VALUES ('tpl-1', '紹介あいさつ', 'text', '{"text":"営業時間は{{var.hours}}です"}')`,
    ).run();
    raw.prepare(`UPDATE entry_routes SET intro_template_id = 'tpl-1' WHERE id = 'route-1'`).run();
    raw.prepare(
      `INSERT INTO common_vars (id, line_account_id, name, var_key, type, value)
       VALUES ('cv-1', 'account-1', '営業時間', 'hours', 'text', '10時から18時')`,
    ).run();
    lineClientMocks.replyMessage.mockResolvedValue(undefined);
    lineClientMocks.pushMessage.mockResolvedValue(undefined);

    await postFollow('webhook-var-ok');

    const intro = lineClientMocks.pushMessage.mock.calls.find((call) => {
      const messages = call[1] as Array<{ text?: string }>;
      return messages.some((m) => (m.text ?? '').includes('営業時間'));
    });
    expect(intro).toBeTruthy();
    const messages = intro![1] as Array<{ text?: string }>;
    // テキスト型の本文は {"text":"…"} のJSONで保持される
    expect(messages[0].text).toContain('営業時間は10時から18時です');
    expect(messages[0].text).not.toContain('{{var.');
  });
});


test('初回テキストに未解決の共通情報があれば送らない', async () => {
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-11-18T01:00:00Z'));useSqliteClock(raw,()=>new Date());
  try {
    raw.prepare("UPDATE friend_add_rule_versions SET status='draft' WHERE id='version-1'").run();
    raw.prepare(`INSERT INTO friend_add_rule_versions(id,rule_id,version_number,definition_snapshot,status) SELECT 'text-version','rule-1',2,json_set(definition_snapshot,'$.messageType','text','$.messageText','こんにちは {{var.shop}}','$.scenarioId',NULL),'published' FROM friend_add_rule_versions WHERE id='version-1'`).run();
    raw.prepare("UPDATE friend_add_rules SET current_version_id='text-version' WHERE id='rule-1'").run();
    await postFollow('direct-var-missing');
    expect(lineClientMocks.pushMessage).not.toHaveBeenCalled();
    expect(raw.prepare("SELECT var_key,reason FROM common_var_resolution_failures").all()).toEqual([{var_key:'shop',reason:'missing'}]);
  } finally {vi.useRealTimers();}
});

test('公開した初回のテキストを共通情報を解決して1回だけ送り、送信履歴を残す', async () => {
  raw.prepare(`UPDATE friend_add_rule_versions SET status='draft' WHERE id='version-1'`).run();
  raw.prepare(`INSERT INTO friend_add_rule_versions(id,rule_id,version_number,definition_snapshot,status) SELECT 'text-version','rule-1',2,json_set(definition_snapshot,'$.messageType','text','$.messageText','こんにちは {{var.shop}}','$.scenarioId',NULL),'published' FROM friend_add_rule_versions WHERE id='version-1'`).run();
  raw.prepare(`UPDATE friend_add_rules SET current_version_id='text-version' WHERE id='rule-1'`).run();
  raw.prepare(`INSERT INTO common_vars(id,line_account_id,name,var_key,type,value) VALUES ('shop','account-1','店名','shop','text','お店')`).run();
  await postFollow('direct-text');
  expect(lineClientMocks.pushMessage).toHaveBeenCalledWith('U-1', [{ type: 'text', text: 'こんにちは お店' }], expect.any(String));
  expect(raw.prepare(`SELECT routing_status,delivery_count FROM friend_add_events WHERE webhook_event_id='direct-text'`).get()).toMatchObject({ routing_status: 'completed', delivery_count: 1 });
  await postFollow('direct-text');
  expect(lineClientMocks.pushMessage).toHaveBeenCalledTimes(1);
  expect(raw.prepare(`SELECT count(*) n FROM friend_scenarios`).get()).toEqual({ n: 0 });
});

describe('クーポンQRからの初回追加', () => {
  function seedEntryCoupon() {
    raw.prepare(`INSERT INTO broadcast_message_assets(id,line_account_id,kind,name,payload_json,published_version,created_at,updated_at)
      VALUES('entry-coupon','account-1','coupon','店頭10%オフ',?,1,'2026-10-01','2026-10-01')`)
      .run(JSON.stringify({ description: '10%オフ', startsAt: '2020-01-01', endsAt: '2099-01-01', oncePerFriend: true }));
    raw.exec("UPDATE entry_routes SET coupon_enabled=1,coupon_asset_id='entry-coupon' WHERE id='route-1'");
  }
  test('追加時にこの経路のクーポンを送る。別IDのfollowが再び届いても2枚目は送らない', async () => {
    seedEntryCoupon();
    await postFollow('coupon-follow');
    const coupons = () => lineClientMocks.pushMessage.mock.calls.filter((call) => JSON.stringify(call).includes('coupon_use:entry-coupon:'));
    expect(coupons()).toHaveLength(1);
    const receipt = raw.prepare('SELECT id,status FROM entry_route_coupon_receipts').get() as { id: string; status: string };
    expect(receipt.status).toBe('sent');
    expect(coupons()[0][2]).toBe(receipt.id);
    await postFollow('coupon-follow-duplicate');
    expect(coupons()).toHaveLength(1);
  });
  test.each(['draft', 'returning'])('未公開と再フォローには送らない: %s', async (kind) => {
    seedEntryCoupon();
    if (kind === 'draft') raw.exec("UPDATE broadcast_message_assets SET published_version=0 WHERE id='entry-coupon'");
    else raw.exec("UPDATE friends SET unfollow_count=1 WHERE id='friend-1'");
    await postFollow('coupon-blocked');
    expect(lineClientMocks.pushMessage.mock.calls.filter((call) => JSON.stringify(call).includes('coupon_use:entry-coupon:'))).toHaveLength(0);
    expect(raw.prepare('SELECT COUNT(*) AS n FROM entry_route_coupon_receipts').get()).toEqual({ n: 0 });
  });
  test('追加イベントの到着が遅れ、送信時に期限切れなら発行しない', async () => {
    seedEntryCoupon();
    raw.prepare("UPDATE broadcast_message_assets SET payload_json=? WHERE id='entry-coupon'")
      .run(JSON.stringify({ description: '10%オフ', startsAt: '2020-01-01', endsAt: new Date(Date.now() - 60_000).toISOString(), oncePerFriend: true }));
    await postFollow('coupon-delayed', db, {}, Date.now() - 120_000);
    expect(lineClientMocks.pushMessage.mock.calls.filter((call) => JSON.stringify(call).includes('coupon_use:entry-coupon:'))).toHaveLength(0);
    expect(raw.prepare('SELECT COUNT(*) AS n FROM entry_route_coupon_receipts').get()).toEqual({ n: 0 });
  });
});
