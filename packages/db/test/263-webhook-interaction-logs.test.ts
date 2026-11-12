import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  claimWebhookInteractionRetry,
  claimWebhookInteractionRetryAndInsert,
  countExcludedFailedWebhookInteractions,
  countFailedWebhookInteractionsForRetry,
  countUnverifiedWebhookInteractions,
  createWebhookInteraction,
  finishWebhookInteraction,
  getWebhookInteractionById,
  hasSucceededInteractionForKey,
  listFailedWebhookInteractionsForRetry,
  listWebhookInteractions,
  markFailedInteractionsRetried,
  markStalePendingWebhookInteractions,
  restoreWebhookInteractionFailure,
} from '../src/webhooks.js';
import { asD1 } from './d1-test-helper.js';

const migration = readFileSync(
  join(import.meta.dirname, '..', 'migrations', '263_webhook_interaction_logs.sql'),
  'utf8',
);

const migration532 = readFileSync(
  join(import.meta.dirname, '..', 'migrations', '532_webhook_interaction_secret_unavailable.sql'),
  'utf8',
);

describe('migration 263 Webhookやり取り記録', () => {
  let sqlite: Database.Database;
  let db: D1Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE line_accounts (id TEXT PRIMARY KEY);
      INSERT INTO line_accounts (id) VALUES ('account-a'), ('account-b');
      -- d23b: 一覧・再送選定は送り先と自動配送台帳を JOIN する。
      -- この試験で必要な列だけの最小形を用意する。
      CREATE TABLE outgoing_webhooks (
        id TEXT PRIMARY KEY,
        line_account_id TEXT NOT NULL DEFAULT 'account-a',
        confirmation_revision INTEGER NOT NULL DEFAULT 1,
        is_active INTEGER NOT NULL DEFAULT 1,
        deleted_at TEXT
      );
      CREATE TABLE outgoing_webhook_deliveries (
        id TEXT PRIMARY KEY,
        webhook_id TEXT,
        idempotency_key TEXT,
        status TEXT,
        next_retry_at TEXT
      );
    `);
    sqlite.exec(migration);
    sqlite.exec("ALTER TABLE webhook_interaction_logs ADD COLUMN confirmation_revision INTEGER NOT NULL DEFAULT 1");
    db = asD1(sqlite);
  });

  /** 送り直せる失敗記録を1件作る。 */
  async function failedInteraction(
    id: string,
    overrides: { webhookId?: string | null; failureReason?: string; requestBodyJson?: string | null; idempotencyKey?: string } = {},
  ) {
    const row = await createWebhookInteraction(db, {
      id,
      lineAccountId: 'account-a',
      direction: 'outgoing',
      webhookId: overrides.webhookId === undefined ? 'webhook-a' : overrides.webhookId,
      webhookName: '顧客管理',
      eventType: 'friend.added',
      triggerSummary: '友だちが追加されたとき',
      requestBodyJson: overrides.requestBodyJson === undefined ? '{}' : overrides.requestBodyJson,
      idempotencyKey: overrides.idempotencyKey ?? `delivery-${id}`,
    });
    await finishWebhookInteraction(db, row.id, 'account-a', {
      status: 'failed', responseStatus: 500, attemptCount: 1, durationMs: 100,
      failureReason: (overrides.failureReason ?? 'response_5xx') as 'response_5xx',
    });
    return row;
  }

  it('接続先URLとシークレットの列を持たず、アカウント単位の索引を作る', () => {
    const columns = sqlite.prepare("PRAGMA table_info('webhook_interaction_logs')").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).not.toEqual(expect.arrayContaining(['url', 'secret']));
    expect(sqlite.prepare("PRAGMA index_list('webhook_interaction_logs')").all())
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'idx_webhook_interactions_account_created' }),
        expect.objectContaining({ name: 'idx_webhook_interactions_account_status' }),
      ]));
  });

  it('別アカウントの記録を一覧にも単一取得にも混ぜない', async () => {
    const accountA = await createWebhookInteraction(db, {
      id: 'run-a',
      lineAccountId: 'account-a',
      direction: 'outgoing',
      webhookId: 'webhook-a',
      webhookName: '顧客管理',
      eventType: 'friend.added',
      triggerSummary: '友だちが追加されたとき',
      requestBodyJson: '{"friend":"secret"}',
      idempotencyKey: 'delivery-a',
    });
    await createWebhookInteraction(db, {
      id: 'run-b',
      lineAccountId: 'account-b',
      direction: 'incoming',
      webhookName: '受注管理',
      eventType: 'incoming_webhook.order',
      triggerSummary: '注文を受け取ったとき',
      idempotencyKey: 'delivery-b',
    });
    await finishWebhookInteraction(db, accountA.id, 'account-a', {
      status: 'succeeded', responseStatus: 200, attemptCount: 1, durationMs: 380,
    });

    const result = await listWebhookInteractions(db, { lineAccountId: 'account-a' });
    expect(result.items.map((item) => item.id)).toEqual(['run-a']);
    expect(result.summary).toMatchObject({ total: 1, outgoing: 1, incoming: 0, succeeded: 1, failed: 0 });
    await expect(getWebhookInteractionById(db, 'run-b', 'account-a')).resolves.toBeNull();
  });

  it('失敗した送信だけを1回だけ再試行へ確保し、作成失敗時は戻せる', async () => {
    // 送り直せるのは生きている送り先の失敗だけ。送り先を立てる。
    sqlite.exec(`INSERT INTO outgoing_webhooks (id, is_active) VALUES ('webhook-a', 1)`);
    const row = await createWebhookInteraction(db, {
      id: 'failed-a',
      lineAccountId: 'account-a',
      direction: 'outgoing',
      webhookId: 'webhook-a',
      webhookName: '顧客管理',
      eventType: 'friend.added',
      triggerSummary: '友だちが追加されたとき',
      requestBodyJson: '{}',
      idempotencyKey: 'delivery-a',
    });
    await finishWebhookInteraction(db, row.id, 'account-a', {
      status: 'failed', responseStatus: 500, attemptCount: 3, durationMs: 900,
      failureReason: 'response_5xx',
    });

    expect((await listFailedWebhookInteractionsForRetry(db, 'account-a')).map((item) => item.id))
      .toEqual(['failed-a']);
    await expect(claimWebhookInteractionRetry(db, row.id, 'account-a')).resolves.toBe(true);
    await expect(claimWebhookInteractionRetry(db, row.id, 'account-a')).resolves.toBe(false);
    await restoreWebhookInteractionFailure(db, row.id, 'account-a');
    expect((await getWebhookInteractionById(db, row.id, 'account-a'))?.status).toBe('failed');
  });

  // 「届いたか分からない」失敗は無条件のまとめて再送に乗せない。
  // 相手先で確かめてから1件ずつやり直す対象として別に数える。
  it('届いたか分からない失敗はまとめて再送の対象と件数から外す', async () => {
    sqlite.exec(`INSERT INTO outgoing_webhooks (id, is_active) VALUES ('webhook-a', 1)`);
    for (const [id, reason] of [
      ['failed-5xx', 'response_5xx'],
      ['failed-unknown', 'unknown'],
    ] as const) {
      const row = await createWebhookInteraction(db, {
        id,
        lineAccountId: 'account-a',
        direction: 'outgoing',
        webhookId: 'webhook-a',
        webhookName: '顧客管理',
        eventType: 'friend.added',
        triggerSummary: '友だちが追加されたとき',
        requestBodyJson: '{}',
        idempotencyKey: id,
      });
      await finishWebhookInteraction(db, row.id, 'account-a', {
        status: 'failed', responseStatus: reason === 'unknown' ? null : 500,
        attemptCount: 1, durationMs: 100, failureReason: reason,
      });
    }

    expect((await listFailedWebhookInteractionsForRetry(db, 'account-a')).map((item) => item.id))
      .toEqual(['failed-5xx']);
    expect(await countFailedWebhookInteractionsForRetry(db, 'account-a')).toBe(1);
    expect(await countUnverifiedWebhookInteractions(db, 'account-a')).toBe(1);

    const result = await listWebhookInteractions(db, { lineAccountId: 'account-a' });
    expect(result.summary.failed).toBe(2);
    expect(result.summary.resultUnknown).toBe(1);
    // 送信の失敗と、まとめて送り直せる件数を分けて数える。
    expect(result.summary.outgoingFailed).toBe(2);
    expect(result.summary.retryable).toBe(1);
  });

  it('検索と状態の条件をアカウント範囲の中だけに適用する', async () => {
    for (const [id, name, status] of [
      ['run-1', '顧客管理', 'succeeded'],
      ['run-2', '予約管理', 'failed'],
    ] as const) {
      const row = await createWebhookInteraction(db, {
        id,
        lineAccountId: 'account-a',
        direction: 'outgoing',
        webhookId: id,
        webhookName: name,
        eventType: 'booking.created',
        triggerSummary: '予約が入ったとき',
        requestBodyJson: '{}',
        idempotencyKey: id,
      });
      await finishWebhookInteraction(db, row.id, 'account-a', {
        status, responseStatus: status === 'succeeded' ? 200 : 500,
        attemptCount: 1, durationMs: 100,
        failureReason: status === 'failed' ? 'response_5xx' : null,
      });
    }

    const result = await listWebhookInteractions(db, {
      lineAccountId: 'account-a', status: 'failed', search: '予約',
    });
    expect(result.items.map((item) => item.id)).toEqual(['run-2']);
    expect(result.total).toBe(1);
  });

  // ---- d23b: 再送対象の選び方・原子的な確保・滞留回収・手動/自動の照合 ----

  it('消えた・止まった送り先の失敗はまとめて再送から外し、別に数える(R405/R414)', async () => {
    sqlite.exec(`
      INSERT INTO outgoing_webhooks (id, is_active, deleted_at) VALUES
        ('wh-alive', 1, NULL),
        ('wh-stopped', 0, NULL),
        ('wh-deleted', 1, '2026-09-01T00:00:00.000+09:00')
    `);
    await failedInteraction('failed-alive', { webhookId: 'wh-alive' });
    await failedInteraction('failed-stopped', { webhookId: 'wh-stopped' });
    await failedInteraction('failed-deleted', { webhookId: 'wh-deleted' });
    // 連携先自体が消えた記録(webhook_id がNULL)も対象外。
    await failedInteraction('failed-gone', { webhookId: null });

    expect((await listFailedWebhookInteractionsForRetry(db, 'account-a')).map((item) => item.id))
      .toEqual(['failed-alive']);
    expect(await countFailedWebhookInteractionsForRetry(db, 'account-a')).toBe(1);
    // 対象外に残った分は件数を返し、画面が説明できるようにする。
    expect(await countExcludedFailedWebhookInteractions(db, 'account-a')).toBe(3);

    const result = await listWebhookInteractions(db, { lineAccountId: 'account-a' });
    expect(result.summary.retryable).toBe(1);
    expect(result.summary.outgoingFailed).toBe(4);
    // 一覧の各行には送り先の現状が付く(消えたものは NULL)。
    const byId = new Map(result.items.map((item) => [item.id, item]));
    expect(byId.get('failed-alive')?.linked_webhook_active).toBe(1);
    expect(byId.get('failed-stopped')?.linked_webhook_active).toBe(0);
    expect(byId.get('failed-deleted')?.linked_webhook_active).toBeNull();
    expect(byId.get('failed-gone')?.linked_webhook_active).toBeNull();
  });

  it('自動の送り直しが動いている・届き済みの通知はまとめて再送から外す(R412)', async () => {
    sqlite.exec(`INSERT INTO outgoing_webhooks (id, is_active) VALUES ('webhook-a', 1)`);
    await failedInteraction('failed-retrying', { idempotencyKey: 'key-retrying' });
    await failedInteraction('failed-delivered', { idempotencyKey: 'key-delivered' });
    await failedInteraction('failed-failed-auto', { idempotencyKey: 'key-failed' });
    await failedInteraction('failed-no-delivery', { idempotencyKey: 'key-none' });
    sqlite.exec(`
      INSERT INTO outgoing_webhook_deliveries (id, webhook_id, idempotency_key, status, next_retry_at) VALUES
        ('d-1', 'webhook-a', 'key-retrying', 'retry_wait', '2026-09-30T00:00:00.000+09:00'),
        ('d-2', 'webhook-a', 'key-delivered', 'delivered', NULL),
        ('d-3', 'webhook-a', 'key-failed', 'failed', NULL)
    `);

    // 自動の送り直しが尽きた(failed)・台帳に無いものだけが対象。
    expect((await listFailedWebhookInteractionsForRetry(db, 'account-a')).map((item) => item.id).sort())
      .toEqual(['failed-failed-auto', 'failed-no-delivery']);
    expect(await countExcludedFailedWebhookInteractions(db, 'account-a')).toBe(2);

    const result = await listWebhookInteractions(db, { lineAccountId: 'account-a' });
    const byId = new Map(result.items.map((item) => [item.id, item]));
    expect(byId.get('failed-retrying')?.delivery_status).toBe('retry_wait');
    expect(byId.get('failed-retrying')?.delivery_next_retry_at).toBe('2026-09-30T00:00:00.000+09:00');
    expect(byId.get('failed-delivered')?.delivery_status).toBe('delivered');
    expect(byId.get('failed-no-delivery')?.delivery_status).toBeNull();
  });

  it.each(['interaction', 'webhook'])('確保直前の%sの変更を一括更新が拒む', async kind => {
    sqlite.exec("INSERT INTO outgoing_webhooks(id,is_active) VALUES('webhook-a',1)");
    const row = await failedInteraction('race-failed');
    const batch = db.batch.bind(db);
    const spy = vi.spyOn(db, 'batch').mockImplementation(statements => {
      if (kind === 'interaction') sqlite.exec("UPDATE webhook_interaction_logs SET confirmation_revision=confirmation_revision+1 WHERE id='race-failed'");
      else sqlite.exec("UPDATE outgoing_webhooks SET confirmation_revision=confirmation_revision+1 WHERE id='webhook-a'");
      return batch(statements);
    });
    try {
      const result = await claimWebhookInteractionRetryAndInsert(db, row, { webhookId:'webhook-a', webhookName:'通知', eventType:'friend.added', triggerSummary:'test', requestBodyJson:'{}', idempotencyKey:'race', expectedInteractionRevision:2, expectedWebhookRevision:1 });
      expect(result.claimed).toBe(false);
      expect((await getWebhookInteractionById(db, row.id, 'account-a'))?.status).toBe('failed');
      expect(sqlite.prepare("SELECT COUNT(*) n FROM webhook_interaction_logs WHERE retry_of_id='race-failed'").get()).toEqual({n:0});
    } finally { spy.mockRestore(); }
  });
  it('送り先と記録の版を一度に照合し、古い版では記録を作らない', async () => {
    sqlite.exec(`INSERT INTO outgoing_webhooks (id, is_active) VALUES ('webhook-a', 1)`);
    const row = await failedInteraction('cas-failed');
    const input = { webhookId: 'webhook-a', webhookName: '顧客管理', eventType: 'friend.added', triggerSummary: 'test', requestBodyJson: '{}', idempotencyKey: 'cas-key', expectedInteractionRevision: 1, expectedWebhookRevision: 1 };
    expect((await claimWebhookInteractionRetryAndInsert(db, row, input)).claimed).toBe(false);
    expect((await getWebhookInteractionById(db, row.id, 'account-a'))?.status).toBe('failed');
    expect((await claimWebhookInteractionRetryAndInsert(db, row, { ...input, expectedInteractionRevision: 2, expectedWebhookRevision: 2 })).claimed).toBe(false);
    expect((await claimWebhookInteractionRetryAndInsert(db, row, { ...input, expectedInteractionRevision: 2 })).claimed).toBe(true);
    expect((await getWebhookInteractionById(db, row.id, 'account-a'))?.confirmation_revision).toBe(3);
    expect((await claimWebhookInteractionRetryAndInsert(db, row, { ...input, expectedInteractionRevision: 2 })).claimed).toBe(false);
  });

  it('やり直しの畳み込みと記録作成は一体で、重複した申込は何もしない(R409)', async () => {
    sqlite.exec(`INSERT INTO outgoing_webhooks (id, is_active) VALUES ('webhook-a', 1)`);
    const row = await failedInteraction('failed-a');

    const first = await claimWebhookInteractionRetryAndInsert(db, row, {
      webhookId: 'webhook-a', webhookName: '顧客管理', eventType: 'friend.added',
      triggerSummary: '友だちが追加されたとき', requestBodyJson: '{}',
      idempotencyKey: 'delivery-failed-a',
    });
    expect(first.claimed).toBe(true);
    expect((await getWebhookInteractionById(db, row.id, 'account-a'))?.status).toBe('retried');
    const inserted = await getWebhookInteractionById(db, first.retryId, 'account-a');
    expect(inserted?.status).toBe('pending');
    expect(inserted?.retry_of_id).toBe(row.id);
    expect(inserted?.idempotency_key).toBe('delivery-failed-a');

    // 二度目は元が既に畳まれているので、行も増やさず claimed=false。
    const second = await claimWebhookInteractionRetryAndInsert(db, row, {
      webhookId: 'webhook-a', webhookName: '顧客管理', eventType: 'friend.added',
      triggerSummary: '友だちが追加されたとき', requestBodyJson: '{}',
      idempotencyKey: 'delivery-failed-a',
    });
    expect(second.claimed).toBe(false);
    expect(await getWebhookInteractionById(db, second.retryId, 'account-a')).toBeNull();
  });

  it('滞留した「処理中」を期限切れとして失敗へ回収する(R409)', async () => {
    const stale = await createWebhookInteraction(db, {
      id: 'pending-stale', lineAccountId: 'account-a', direction: 'outgoing',
      webhookId: 'webhook-a', webhookName: '顧客管理', eventType: 'friend.added',
      triggerSummary: '友だちが追加されたとき', requestBodyJson: '{}',
      idempotencyKey: 'delivery-stale',
      startedAt: '2020-01-01T00:00:00.000+09:00',
    });
    const fresh = await createWebhookInteraction(db, {
      id: 'pending-fresh', lineAccountId: 'account-a', direction: 'outgoing',
      webhookId: 'webhook-a', webhookName: '顧客管理', eventType: 'friend.added',
      triggerSummary: '友だちが追加されたとき', requestBodyJson: '{}',
      idempotencyKey: 'delivery-fresh',
    });

    expect(await markStalePendingWebhookInteractions(db, 'account-a')).toBe(1);
    const staleRow = await getWebhookInteractionById(db, stale.id, 'account-a');
    expect(staleRow?.status).toBe('failed');
    expect(staleRow?.failure_reason).toBe('unknown');
    expect((await getWebhookInteractionById(db, fresh.id, 'account-a'))?.status).toBe('pending');
  });

  it('届き済みの判定と失敗記録の畳み込みが冪等キーで結ばれる(R412)', async () => {
    sqlite.exec(`INSERT INTO outgoing_webhooks (id, is_active) VALUES ('webhook-a', 1)`);
    const failed = await failedInteraction('failed-same', { idempotencyKey: 'key-same' });
    const ok = await createWebhookInteraction(db, {
      id: 'ok-same', lineAccountId: 'account-a', direction: 'outgoing',
      webhookId: 'webhook-a', webhookName: '顧客管理', eventType: 'friend.added',
      triggerSummary: '友だちが追加されたとき', requestBodyJson: '{}',
      idempotencyKey: 'key-same',
    });
    await finishWebhookInteraction(db, ok.id, 'account-a', {
      status: 'succeeded', responseStatus: 200, attemptCount: 1, durationMs: 50,
    });

    expect(await hasSucceededInteractionForKey(db, 'account-a', 'webhook-a', 'key-same')).toBe(true);
    expect(await hasSucceededInteractionForKey(db, 'account-a', 'webhook-a', 'key-other')).toBe(false);

    await markFailedInteractionsRetried(db, 'account-a', 'webhook-a', 'key-same');
    expect((await getWebhookInteractionById(db, failed.id, 'account-a'))?.status).toBe('retried');
    // 届いた記録と別キーの記録には触れない。
    expect((await getWebhookInteractionById(db, ok.id, 'account-a'))?.status).toBe('succeeded');
  });

  it('secret_unavailable を失敗理由として書ける(migration 532, R415)', async () => {
    sqlite.exec(migration532);
    sqlite.exec("ALTER TABLE webhook_interaction_logs ADD COLUMN confirmation_revision INTEGER NOT NULL DEFAULT 1");
    const row = await createWebhookInteraction(db, {
      id: 'run-secret', lineAccountId: 'account-a', direction: 'outgoing',
      webhookId: 'webhook-a', webhookName: '顧客管理', eventType: 'friend.added',
      triggerSummary: '友だちが追加されたとき', requestBodyJson: '{}',
      idempotencyKey: 'delivery-secret',
    });
    await finishWebhookInteraction(db, row.id, 'account-a', {
      status: 'failed', responseStatus: null, attemptCount: 0, durationMs: 5,
      failureReason: 'secret_unavailable',
    });
    expect((await getWebhookInteractionById(db, row.id, 'account-a'))?.failure_reason)
      .toBe('secret_unavailable');
  });
});
