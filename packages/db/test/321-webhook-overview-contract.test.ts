import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getOutgoingWebhookDeliverySummaries,
  updateIncomingWebhookConfig,
  updateIncomingWebhookMaskedSample,
} from '../src/webhooks.js';
import { asD1 } from './d1-test-helper.js';

const migration = readFileSync(
  join(import.meta.dirname, '..', 'migrations', '321_webhook_overview_contract.sql'),
  'utf8',
);

describe('migration 321 外部連携の接続別集計と受信口詳細', () => {
  let sqlite: Database.Database;
  let db: D1Database;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-07T00:00:00.000Z'));
    sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE incoming_webhooks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        source_type TEXT NOT NULL DEFAULT 'custom',
        secret TEXT,
        is_active INTEGER NOT NULL DEFAULT 1,
        line_account_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        /* #939 N-368（移行437）: 削除は履歴を残す印。読み取りは印の無い行だけ。 */
        deleted_at TEXT,
        deleted_by_staff_id TEXT
      );
      CREATE TABLE outgoing_webhooks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        event_types TEXT NOT NULL,
        secret TEXT,
        is_active INTEGER NOT NULL DEFAULT 1,
        max_retries INTEGER NOT NULL DEFAULT 0,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        last_failed_at TEXT,
        line_account_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        /* #939 N-368（移行437）: 同上 */
        deleted_at TEXT,
        deleted_by_staff_id TEXT
      );
      CREATE TABLE webhook_interaction_logs (
        id TEXT PRIMARY KEY,
        line_account_id TEXT NOT NULL,
        direction TEXT NOT NULL,
        webhook_id TEXT,
        webhook_name TEXT NOT NULL,
        event_type TEXT NOT NULL,
        trigger_summary TEXT NOT NULL,
        status TEXT NOT NULL,
        request_body_json TEXT,
        response_status INTEGER,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER,
        failure_reason TEXT,
        idempotency_key TEXT NOT NULL,
        retry_of_id TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        created_at TEXT NOT NULL
      );
      INSERT INTO incoming_webhooks
        (id, name, line_account_id, created_at, updated_at)
      VALUES
        ('incoming-a', '本店受信', 'account-a', '2026-09-01', '2026-09-01'),
        ('incoming-b', '支店受信', 'account-b', '2026-09-01', '2026-09-01');
      INSERT INTO outgoing_webhooks
        (id, name, url, event_types, is_active, line_account_id, created_at, updated_at)
      VALUES
        ('outgoing-a', '顧客管理', 'https://example.com/a', '["*"]', 1, 'account-a', '2026-09-01', '2026-09-01'),
        ('outgoing-empty', '未送信', 'https://example.com/empty', '["*"]', 1, 'account-a', '2026-09-02', '2026-09-02'),
        ('outgoing-b', '別店舗', 'https://example.com/b', '["*"]', 1, 'account-b', '2026-09-01', '2026-09-01');
    `);
    sqlite.exec(migration);
    sqlite.exec("ALTER TABLE incoming_webhooks ADD COLUMN confirmation_revision INTEGER NOT NULL DEFAULT 1");
    sqlite.exec(`
      INSERT INTO webhook_interaction_logs
        (id, line_account_id, direction, webhook_id, webhook_name, event_type,
         trigger_summary, status, request_body_json, response_status, failure_reason,
         idempotency_key, started_at, completed_at, created_at)
      VALUES
        ('a-success', 'account-a', 'outgoing', 'outgoing-a', '顧客管理', 'friend.added',
         '追加', 'succeeded', NULL, 200, NULL, 'key-1',
         '2026-09-05T10:00:00.000+09:00', '2026-09-05T10:00:01.000+09:00', '2026-09-05T10:00:00.000+09:00'),
        ('a-failed', 'account-a', 'outgoing', 'outgoing-a', '顧客管理', 'friend.added',
         '追加', 'failed', '{"internal":"retry-only"}', 500, 'response_5xx', 'key-2',
         '2026-09-06T10:00:00.000+09:00', '2026-09-06T10:00:01.000+09:00', '2026-09-06T10:00:00.000+09:00'),
        ('a-retried', 'account-a', 'outgoing', 'outgoing-a', '顧客管理', 'friend.added',
         '追加', 'retried', '{"internal":"old"}', 500, 'response_5xx', 'key-3',
         '2026-09-06T11:00:00.000+09:00', '2026-09-06T11:00:01.000+09:00', '2026-09-06T11:00:00.000+09:00'),
        ('b-failed', 'account-b', 'outgoing', 'outgoing-b', '別店舗', 'friend.added',
         '追加', 'failed', '{"internal":"other"}', 500, 'response_5xx', 'key-4',
         '2026-09-06T12:00:00.000+09:00', '2026-09-06T12:00:01.000+09:00', '2026-09-06T12:00:00.000+09:00'),
        ('a-old', 'account-a', 'outgoing', 'outgoing-a', '顧客管理', 'friend.added',
         '追加', 'failed', '{"internal":"expired"}', 500, 'response_5xx', 'key-5',
         '2026-07-01T10:00:00.000+09:00', '2026-07-01T10:00:01.000+09:00', '2026-07-01T10:00:00.000+09:00');
    `);
    db = asD1(sqlite);
  });

  afterEach(() => {
    vi.useRealTimers();
    sqlite.close();
  });

  it('既存受信口へ安全な初期設定と版を付ける', () => {
    expect(sqlite.prepare(`
      SELECT version, identity_match_json, action_refs_json,
             latest_masked_sample_json, latest_received_at
        FROM incoming_webhooks WHERE id = 'incoming-a'
    `).get()).toEqual({
      version: 1,
      identity_match_json: '{"methods":[],"onNotFound":"do_nothing"}',
      action_refs_json: '[]',
      latest_masked_sample_json: null,
      latest_received_at: null,
    });
  });

  it('接続別集計を期間・アカウントで分離し、再送可能な最新失敗だけを示す', async () => {
    const rows = await getOutgoingWebhookDeliverySummaries(db, 'account-a', 30);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.webhook_id === 'outgoing-a')).toMatchObject({
      total: 2, succeeded: 1, failed: 1, pending: 0,
      last_status: 'failed', last_response_status: 500,
      last_failure_reason: 'response_5xx', can_retry: 1,
    });
    expect(rows.find((row) => row.webhook_id === 'outgoing-empty')).toMatchObject({
      total: 0, succeeded: 0, failed: 0, pending: 0,
      last_status: null, can_retry: 0,
    });
    expect(rows.some((row) => row.webhook_id === 'outgoing-b')).toBe(false);
  });

  it('設定を同じアカウント内で版付き更新し、古い版は全体を拒否する', async () => {
    const input = {
      id: 'incoming-a',
      lineAccountId: 'account-a',
      expectedVersion: 1,
      identityMatching: {
        methods: [{ kind: 'external_customer_id' as const, path: '$.customer.id' }],
        onNotFound: 'unmatched_box' as const,
      },
      actions: [{ refKind: 'tag', refId: 'tag-a', refVersionId: null }],
    };
    await expect(updateIncomingWebhookConfig(db, input)).resolves.toMatchObject({
      status: 'updated', item: { id: 'incoming-a', version: 2 },
    });
    await expect(updateIncomingWebhookConfig(db, input)).resolves.toEqual({
      status: 'conflict', currentVersion: 2,
    });
    await expect(updateIncomingWebhookConfig(db, {
      ...input, id: 'incoming-b', expectedVersion: 1,
    })).resolves.toEqual({ status: 'not_found' });
    expect(sqlite.prepare(`
      SELECT identity_match_json, action_refs_json FROM incoming_webhooks WHERE id = 'incoming-a'
    `).get()).toEqual({
      identity_match_json: '{"methods":[{"kind":"external_customer_id","path":"$.customer.id"}],"onNotFound":"unmatched_box"}',
      action_refs_json: '[{"refKind":"tag","refId":"tag-a","refVersionId":null}]',
    });
  });

  it('最新受信は値のないマスク済み項目だけを保存する', async () => {
    const sample = {
      fields: [{ path: '$.customer.email', type: 'string', maskedValue: '••••' }],
      truncated: false,
    };
    await updateIncomingWebhookMaskedSample(
      db, 'incoming-a', 'account-a', sample, '2026-09-07T09:00:00.000+09:00',
    );
    const row = sqlite.prepare(`
      SELECT latest_masked_sample_json, latest_received_at
        FROM incoming_webhooks WHERE id = 'incoming-a'
    `).get() as { latest_masked_sample_json: string; latest_received_at: string };
    expect(JSON.parse(row.latest_masked_sample_json)).toEqual(sample);
    expect(row.latest_masked_sample_json).not.toContain('private@example.com');
    expect(row.latest_received_at).toBe('2026-09-07T09:00:00.000+09:00');
  });
});
