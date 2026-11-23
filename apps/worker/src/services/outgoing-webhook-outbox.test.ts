/*
 *  監査是正の直接試験。
 *
 * ここで止めたい崩れ方:
 *   1. 台帳へ積まずに送る設計に戻ると、Worker中断・cron再実行の
 *      送り残しを誰も拾わない。
 *   2. 再送をリクエスト内の数秒待ちに戻すと、長時間障害を救えない
 *。再送は next_retry_at のスケジュールで行う。
 *   3. Retry-After を無視したり上限なく信じると、混雑中の再送が
 *      空振りするか遠すぎる未来に飛ぶ。
 *   4. 連続失敗で止めず通知もしないと、壊れた送り先へ送り続ける
 *。
 *
 * 実 SQLite（本物の bootstrap.sql）に当てる。SQLが仕様なので
 * 手書きモックでは意味がない。
 */
import { describe, expect, it, vi } from 'vitest';

import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';
import {
  claimOutgoingDelivery,
  enqueueOutgoingWebhookDelivery,
  finishOutgoingDelivery,
  outgoingAttemptOf,
  outgoingDeliveryMaxAttempts,
  outgoingDeliveryNextRetryAt,
  OUTGOING_WEBHOOK_AUTO_STOP_FAILURES,
  OUTGOING_WEBHOOK_MAX_ATTEMPTS,
  OUTGOING_WEBHOOK_RETRY_WINDOW_MS,
  recordDeliveryOutcome,
  shouldRetryStatus,
  sweepOutgoingWebhookDeliveries,
  type OutgoingDeliveryRow,
} from './outgoing-webhook-delivery.js';
import { updateOutgoingWebhook } from '@line-crm/db';

const ACCOUNT = 'account-1';
const NOW = new Date('2026-11-02T03:00:00.000Z');

/** 名前引きは外へ出ない。公開IPだけ返す決め打ち。 */
const publicOnlyLookup = async (_host: string) => ['93.184.216.34'];

function seed(db: SqliteD1): void {
  db.raw.prepare(`
    INSERT INTO line_accounts
      (id, channel_id, name, channel_access_token, channel_secret, is_active)
    VALUES ('${ACCOUNT}', 'channel-1', '店舗1', 'token-1', 'secret-1', 1)
  `).run();
  db.raw.prepare(`
    INSERT INTO outgoing_webhooks
      (id, name, url, event_types, secret, is_active, max_retries,
       consecutive_failures, line_account_id, created_at, updated_at)
    VALUES ('wh-1', '顧客管理', 'https://example.com/hook', '["*"]', NULL, 1,
            3, 0, '${ACCOUNT}', '2026-11-01', '2026-11-01')
  `).run();
}

function deliveryRow(db: SqliteD1, id: string): OutgoingDeliveryRow {
  return db.raw
    .prepare('SELECT * FROM outgoing_webhook_deliveries WHERE id = ?')
    .get(id) as OutgoingDeliveryRow;
}

function webhookRow(db: SqliteD1, id: string) {
  return db.raw
    .prepare('SELECT * FROM outgoing_webhooks WHERE id = ?')
    .get(id) as { is_active: number; consecutive_failures: number; auto_stopped_at: string | null };
}

function stubFetch(responses: Array<{ status: number; retryAfter?: string } | 'throw'>) {
  let calls = 0;
  const fetchImpl = (async () => {
    const next = responses[Math.min(calls, responses.length - 1)]!;
    calls += 1;
    if (next === 'throw') throw new Error('connection refused');
    return new Response('', {
      status: next.status,
      headers: next.retryAfter ? { 'retry-after': next.retryAfter } : undefined,
    });
  }) as typeof fetch;
  return { fetchImpl, calls: () => calls };
}

describe('Webhook配送を台帳に保存し同じ要求を重複登録しない', () => {
  it('積んだ配送は pending で残り、冪等キーの重複は積み増さない', async () => {
    const testDb = createTestD1();
    seed(testDb);
    const first = await enqueueOutgoingWebhookDelivery(testDb.db, {
      lineAccountId: ACCOUNT,
      webhookId: 'wh-1',
      eventType: 'friend_add',
      body: '{"event":"friend_add"}',
      idempotencyKey: 'outgoing_webhook:wh-1:line_webhook:evt-1',
      maxAttempts: 4,
      now: NOW,
    });
    expect(first).not.toBeNull();
    expect(deliveryRow(testDb, first!.id).status).toBe('pending');

    const dup = await enqueueOutgoingWebhookDelivery(testDb.db, {
      lineAccountId: ACCOUNT,
      webhookId: 'wh-1',
      eventType: 'friend_add',
      body: '{"event":"friend_add"}',
      idempotencyKey: 'outgoing_webhook:wh-1:line_webhook:evt-1',
      maxAttempts: 4,
      now: NOW,
    });
    expect(dup).toBeNull();
    expect(
      testDb.raw.prepare('SELECT COUNT(*) AS n FROM outgoing_webhook_deliveries').get(),
    ).toEqual({ n: 1 });
  });
});

describe('Webhook配送の失敗は次の再送時刻と上限を台帳で管理する', () => {
  it('初回失敗は retry_wait で残り、次回は分単位の時刻へ積む', async () => {
    const testDb = createTestD1();
    seed(testDb);
    const queued = (await enqueueOutgoingWebhookDelivery(testDb.db, {
      lineAccountId: ACCOUNT,
      webhookId: 'wh-1',
      eventType: 'friend_add',
      body: '{}',
      idempotencyKey: 'key-1',
      maxAttempts: 4,
      now: NOW,
    }))!;
    const lease = (await claimOutgoingDelivery(testDb.db, queued, NOW))!;
    expect(lease).toBeTruthy();

    const outcome = await finishOutgoingDelivery(
      testDb.db, queued, lease,
      outgoingAttemptOf({ ok: false, attempts: 1, lastStatus: 500 }),
      NOW,
    );
    expect(outcome).toBe('retry_wait');
    const row = deliveryRow(testDb, queued.id);
    expect(row.status).toBe('retry_wait');
    expect(row.attempts).toBe(1);
    // 数秒待ちではなく、共通の指数バックオフ（最短1分）で積む。
    const waitMs = Date.parse(row.next_retry_at!) - NOW.getTime();
    expect(waitMs).toBeGreaterThanOrEqual(50_000); // jitter で最短でも ~54秒
    expect(waitMs).toBeLessThanOrEqual(70_000);
  });

  it('再送時刻は 1→5→30分と指数的に伸び、上限と24時間の窓で止まる', () => {
    const queuedAt = NOW.toISOString();
    const first = outgoingDeliveryNextRetryAt({
      attemptsDone: 1, maxAttempts: 8, queuedAt, now: NOW,
      responseStatus: 500, jitterKey: 'd:1',
    });
    const second = outgoingDeliveryNextRetryAt({
      attemptsDone: 2, maxAttempts: 8, queuedAt, now: NOW,
      responseStatus: 500, jitterKey: 'd:2',
    });
    expect(first!.getTime() - NOW.getTime()).toBeLessThanOrEqual(2 * 60_000);
    expect(second!.getTime() - NOW.getTime()).toBeGreaterThanOrEqual(4 * 60_000);
    expect(second!.getTime() - NOW.getTime()).toBeLessThanOrEqual(6 * 60_000);

    // 試行上限に達したら再送しない。
    expect(outgoingDeliveryNextRetryAt({
      attemptsDone: 8, maxAttempts: 8, queuedAt, now: NOW,
      responseStatus: 500, jitterKey: 'd:8',
    })).toBeNull();

    // 24時間の窓を超える再送は積まない。残り10分しかない時点で
    // 次の待ち（60分）を置くと窓を出るので null になる。
    const late = new Date(Date.parse(queuedAt) + OUTGOING_WEBHOOK_RETRY_WINDOW_MS - 10 * 60_000);
    expect(outgoingDeliveryNextRetryAt({
      attemptsDone: 4, maxAttempts: 8, queuedAt, now: late,
      responseStatus: 500, jitterKey: 'd:4',
    })).toBeNull();
  });

  it('max_retries は再送回数。合計8試行（要件26 §6-4）で頭打ち', () => {
    expect(outgoingDeliveryMaxAttempts(0)).toBe(1);
    expect(outgoingDeliveryMaxAttempts(3)).toBe(4);
    expect(outgoingDeliveryMaxAttempts(7)).toBe(OUTGOING_WEBHOOK_MAX_ATTEMPTS);
    expect(outgoingDeliveryMaxAttempts(99)).toBe(OUTGOING_WEBHOOK_MAX_ATTEMPTS);
    expect(outgoingDeliveryMaxAttempts(null)).toBe(1);
  });
});

describe('Webhookの再送は応答の待機指定と再試行可能な失敗を判定する', () => {
  it('429 の指定どおりに待ち、読めない指定だけ既定の指数待ちへ', () => {
    const queuedAt = NOW.toISOString();
    const respected = outgoingDeliveryNextRetryAt({
      attemptsDone: 1, maxAttempts: 8, queuedAt, now: NOW,
      responseStatus: 429, retryAfterMs: 20 * 60_000, jitterKey: 'd:1',
    });
    expect(respected!.getTime() - NOW.getTime()).toBe(20 * 60_000);

    // 30分を超える指定は短縮せず、自動再送を止める。
    const clamped = outgoingDeliveryNextRetryAt({
      attemptsDone: 1, maxAttempts: 8, queuedAt, now: NOW,
      responseStatus: 429, retryAfterMs: 6 * 60 * 60_000, jitterKey: 'd:1',
    });
    expect(clamped).toBeNull();
  });

  it('自動再送は 425・429・5xx・接続失敗だけ。408/409/その他4xxは恒久失敗', () => {
    expect(shouldRetryStatus(425)).toBe(true);
    expect(shouldRetryStatus(429)).toBe(true);
    expect(shouldRetryStatus(500)).toBe(true);
    expect(shouldRetryStatus(408)).toBe(false);
    expect(shouldRetryStatus(409)).toBe(false);
    expect(shouldRetryStatus(400)).toBe(false);
  });
});

describe('sweep: 送り残しの回収', () => {
  it('retry_wait の期限切れ行を引き取って送り、delivered で確定する', async () => {
    const testDb = createTestD1();
    seed(testDb);
    const queuedAt = new Date(NOW.getTime() - 10 * 60_000).toISOString();
    testDb.raw.prepare(`
      INSERT INTO outgoing_webhook_deliveries
        (id, line_account_id, webhook_id, event_type, body_json, idempotency_key,
         status, attempts, max_attempts, next_retry_at, queued_at, updated_at)
      VALUES ('d-1', ?, 'wh-1', 'friend_add', '{}', 'key-d1',
              'retry_wait', 1, 4, ?, ?, ?)
    `).run(ACCOUNT, NOW.toISOString(), queuedAt, queuedAt);

    const { fetchImpl, calls } = stubFetch([{ status: 200 }]);
    const result = await sweepOutgoingWebhookDeliveries(testDb.db, {
      now: NOW, fetchImpl, lookupHost: publicOnlyLookup,
    });
    expect(result).toMatchObject({ swept: 1, delivered: 1, failed: 0 });
    expect(calls()).toBe(1);
    const row = deliveryRow(testDb, 'd-1');
    expect(row.status).toBe('delivered');
    expect(row.attempts).toBe(2);
    expect(row.delivered_at).not.toBeNull();
    // やり取りの記録にも1行残る。
    expect(
      testDb.raw
        .prepare(`SELECT COUNT(*) AS n FROM webhook_interaction_logs WHERE idempotency_key = 'key-d1'`)
        .get(),
    ).toEqual({ n: 1 });
  });

  it('未来の retry_wait と新しい pending は拾わない', async () => {
    const testDb = createTestD1();
    seed(testDb);
    testDb.raw.prepare(`
      INSERT INTO outgoing_webhook_deliveries
        (id, line_account_id, webhook_id, event_type, body_json, idempotency_key,
         status, attempts, max_attempts, next_retry_at, queued_at, updated_at)
      VALUES ('d-future', ?, 'wh-1', 'friend_add', '{}', 'key-f',
              'retry_wait', 1, 4, ?, ?, ?)
    `).run(ACCOUNT, new Date(NOW.getTime() + 60_000).toISOString(), NOW.toISOString(), NOW.toISOString());
    testDb.raw.prepare(`
      INSERT INTO outgoing_webhook_deliveries
        (id, line_account_id, webhook_id, event_type, body_json, idempotency_key,
         status, attempts, max_attempts, queued_at, updated_at)
      VALUES ('d-fresh', ?, 'wh-1', 'friend_add', '{}', 'key-n',
              'pending', 0, 4, ?, ?)
    `).run(ACCOUNT, NOW.toISOString(), NOW.toISOString());

    const { fetchImpl, calls } = stubFetch([{ status: 200 }]);
    const result = await sweepOutgoingWebhookDeliveries(testDb.db, {
      now: NOW, fetchImpl, lookupHost: publicOnlyLookup,
    });
    expect(result.swept).toBe(0);
    expect(calls()).toBe(0);
  });

  it('再送が尽きたら failed で確定し連続失敗へ数える', async () => {
    const testDb = createTestD1();
    seed(testDb);
    const queuedAt = new Date(NOW.getTime() - 10 * 60_000).toISOString();
    testDb.raw.prepare(`
      INSERT INTO outgoing_webhook_deliveries
        (id, line_account_id, webhook_id, event_type, body_json, idempotency_key,
         status, attempts, max_attempts, next_retry_at, queued_at, updated_at)
      VALUES ('d-last', ?, 'wh-1', 'friend_add', '{}', 'key-last',
              'retry_wait', 3, 4, ?, ?, ?)
    `).run(ACCOUNT, NOW.toISOString(), queuedAt, queuedAt);

    const { fetchImpl } = stubFetch([{ status: 500 }]);
    const result = await sweepOutgoingWebhookDeliveries(testDb.db, {
      now: NOW, fetchImpl, lookupHost: publicOnlyLookup,
    });
    expect(result).toMatchObject({ swept: 1, failed: 1 });
    const row = deliveryRow(testDb, 'd-last');
    expect(row.status).toBe('failed');
    expect(row.error_code).toBe('retry_exhausted');
    expect(webhookRow(testDb, 'wh-1').consecutive_failures).toBe(1);
  });

  it('停止中の送り先へは出さず webhook_inactive で確定する', async () => {
    const testDb = createTestD1();
    seed(testDb);
    testDb.raw.prepare(`UPDATE outgoing_webhooks SET is_active = 0 WHERE id = 'wh-1'`).run();
    const queuedAt = new Date(NOW.getTime() - 10 * 60_000).toISOString();
    testDb.raw.prepare(`
      INSERT INTO outgoing_webhook_deliveries
        (id, line_account_id, webhook_id, event_type, body_json, idempotency_key,
         status, attempts, max_attempts, next_retry_at, queued_at, updated_at)
      VALUES ('d-stopped', ?, 'wh-1', 'friend_add', '{}', 'key-s',
              'retry_wait', 1, 4, ?, ?, ?)
    `).run(ACCOUNT, NOW.toISOString(), queuedAt, queuedAt);

    const { fetchImpl, calls } = stubFetch([{ status: 200 }]);
    const result = await sweepOutgoingWebhookDeliveries(testDb.db, {
      now: NOW, fetchImpl, lookupHost: publicOnlyLookup,
    });
    expect(result.failed).toBe(1);
    expect(calls()).toBe(0);
    expect(deliveryRow(testDb, 'd-stopped').error_code).toBe('webhook_inactive');
  });

  it('同じ行を2回掴めない（claim の楽観ロック）', async () => {
    const testDb = createTestD1();
    seed(testDb);
    const queued = (await enqueueOutgoingWebhookDelivery(testDb.db, {
      lineAccountId: ACCOUNT, webhookId: 'wh-1', eventType: 'friend_add',
      body: '{}', idempotencyKey: 'key-claim', maxAttempts: 4, now: NOW,
    }))!;
    const lease1 = await claimOutgoingDelivery(testDb.db, queued, NOW);
    expect(lease1).toBeTruthy();
    // すでに sending + lease 中の行は同じスナップショットでは掴めない。
    const lease2 = await claimOutgoingDelivery(testDb.db, queued, NOW);
    expect(lease2).toBeNull();
  });
});

describe('Webhookの連続失敗は送り先を自動停止して運用者に通知する', () => {
  it('閾値に達した連続失敗で is_active を落とし通知センターへ1件残す', async () => {
    const testDb = createTestD1();
    seed(testDb);
    for (let i = 0; i < OUTGOING_WEBHOOK_AUTO_STOP_FAILURES; i++) {
      await recordDeliveryOutcome(testDb.db, 'wh-1', false);
    }
    const webhook = webhookRow(testDb, 'wh-1');
    expect(webhook.is_active).toBe(0);
    expect(webhook.auto_stopped_at).not.toBeNull();

    const notices = testDb.raw
      .prepare(`SELECT * FROM notifications WHERE event_type = 'outgoing_webhook_auto_stopped'`)
      .all() as Array<{ channel: string; category: string; line_account_id: string }>;
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      channel: 'dashboard', category: 'error', line_account_id: ACCOUNT,
    });

    // もう止まっているので、さらに失敗しても通知は増えない。
    await recordDeliveryOutcome(testDb.db, 'wh-1', false);
    expect(
      testDb.raw
        .prepare(`SELECT COUNT(*) AS n FROM notifications WHERE event_type = 'outgoing_webhook_auto_stopped'`)
        .get(),
    ).toEqual({ n: 1 });
  });

  it('閾値に届かない失敗では止めず、成功すれば連続失敗は0に戻る', async () => {
    const testDb = createTestD1();
    seed(testDb);
    for (let i = 0; i < OUTGOING_WEBHOOK_AUTO_STOP_FAILURES - 1; i++) {
      await recordDeliveryOutcome(testDb.db, 'wh-1', false);
    }
    expect(webhookRow(testDb, 'wh-1').is_active).toBe(1);
    await recordDeliveryOutcome(testDb.db, 'wh-1', true);
    expect(webhookRow(testDb, 'wh-1').consecutive_failures).toBe(0);
    expect(
      testDb.raw.prepare(`SELECT COUNT(*) AS n FROM notifications`).get(),
    ).toEqual({ n: 0 });
  });

  it('運用者が再有効化すると自動停止の記録は消える', async () => {
    const testDb = createTestD1();
    seed(testDb);
    for (let i = 0; i < OUTGOING_WEBHOOK_AUTO_STOP_FAILURES; i++) {
      await recordDeliveryOutcome(testDb.db, 'wh-1', false);
    }
    expect(webhookRow(testDb, 'wh-1').is_active).toBe(0);
    await updateOutgoingWebhook(testDb.db, 'wh-1', ACCOUNT, { isActive: true });
    const webhook = webhookRow(testDb, 'wh-1');
    expect(webhook.is_active).toBe(1);
    expect(webhook.auto_stopped_at).toBeNull();
  });
});

it('stops an over-budget provider wait without claiming that the 24-hour window expired', async () => {
  const testDb = createTestD1(); seed(testDb);
  try {
    const queued = (await enqueueOutgoingWebhookDelivery(testDb.db, {
      lineAccountId: ACCOUNT, webhookId: 'wh-1', eventType: 'friend_add', body: '{}',
      idempotencyKey: 'retry-after-over-budget', maxAttempts: 4, now: NOW,
    }))!;
    const lease = (await claimOutgoingDelivery(testDb.db, queued, NOW))!;
    expect(await finishOutgoingDelivery(testDb.db, queued, lease, {
      kind: 'retry', responseStatus: 429, retryAfterMs: 3600000,
      errorCode: 'response_429', errorMessage: 'busy',
    }, NOW)).toBe('failed');
    expect(deliveryRow(testDb, queued.id)).toMatchObject({
      status: 'failed', attempts: 1, next_retry_at: '2026-11-02T04:00:00.000Z', error_code: 'retry_after_exceeds_budget',
      error_message_safe: expect.stringContaining('待ち時間'),
    });
    const held = deliveryRow(testDb, queued.id);
    expect(await claimOutgoingDelivery(testDb.db, held, new Date('2026-11-02T03:59:59Z'))).toBeNull();
    expect(deliveryRow(testDb, queued.id)).toMatchObject({
      status: 'failed', attempts: 1, idempotency_key: 'retry-after-over-budget',
    });
    expect(await claimOutgoingDelivery(testDb.db, held, new Date('2026-11-02T04:00:00Z'))).toBeTruthy();
  } finally { testDb.raw.close(); }
});

it('starts cron Retry-After at the response instead of the sweep snapshot',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date(NOW.getTime()+10*60_000));
 const testDb=createTestD1();seed(testDb);
 try {
  const queued=(await enqueueOutgoingWebhookDelivery(testDb.db,{lineAccountId:ACCOUNT,webhookId:'wh-1',eventType:'friend_add',body:'{}',idempotencyKey:'response-clock',maxAttempts:4,now:NOW}))!;
  const fetchImpl=vi.fn<typeof fetch>(async()=>{vi.advanceTimersByTime(100);return new Response('',{status:429,headers:{'Retry-After':'120'}});});
  await sweepOutgoingWebhookDeliveries(testDb.db,{fetchImpl,lookupHost:publicOnlyLookup});
  expect(fetchImpl).toHaveBeenCalledOnce();
  expect(deliveryRow(testDb,queued.id)).toMatchObject({status:'retry_wait',next_retry_at:'2026-11-02T03:12:00.100Z'});
 }finally{testDb.raw.close();vi.useRealTimers();}
});
