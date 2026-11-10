import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { ORDER_IMPACT_KEYS, REVENUE_IMPACT_KEYS } from '@line-crm/shared';
import {
  listEcActionExecutions,
  listEcIdentityCandidates,
  listEcOrders,
  retryEcActionExecution,
  setEcActionExecutionStatus,
  upsertEcEventReadModels,
} from '../src/ec-operations.js';
import { asD1 } from './d1-test-helper.js';

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
let sqlite: Database.Database;
let db: D1Database;

beforeEach(() => {
  sqlite = new Database(':memory:');
  sqlite.exec(readFileSync(join(import.meta.dirname, '..', 'bootstrap.sql'), 'utf8'));
  sqlite.prepare(
    `INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret, tenant_id)
     VALUES (?, ?, ?, 'token', 'secret', ?)`,
  ).run('account-1', 'channel-1', '本店', TENANT_ID);
  sqlite.prepare(
    `INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret, tenant_id)
     VALUES (?, ?, ?, 'token', 'secret', ?)`,
  ).run('account-2', 'channel-2', '別店', TENANT_ID);
  sqlite.exec(`
    INSERT INTO friends (id, line_user_id, display_name, line_account_id)
    VALUES ('friend-1', 'U1', '見本 171', 'account-1'),
           ('friend-2', 'U2', '別店の人', 'account-2');
  `);
  db = asD1(sqlite);
});

function insertEvent(input: {
  id: string;
  accountId: string;
  eventType?: string;
  status?: string;
  payload: Record<string, unknown>;
}) {
  sqlite.prepare(
    `INSERT INTO ec_events
       (id, source, external_event_id, event_type, line_account_id, customer_id,
        friend_id, payload, status, received_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id, `eccube:${input.accountId}`, `external-${input.id}`,
    input.eventType ?? 'ec.order.confirmed', input.accountId, `customer-${input.id}`,
    input.accountId === 'account-1' ? 'friend-1' : 'friend-2', JSON.stringify(input.payload),
    input.status ?? 'received', '2026-09-07T00:00:00.000Z', '2026-09-07T00:00:00.000Z',
  );
}

describe('migration 320 EC order and action read models', () => {
  it('注文と商品明細をaccount単位で正規化し、返金状態へ版付きで更新する', async () => {
    const payload = {
      occurred_at: '2026-09-07T00:00:00.000Z',
      order: {
        number: 'NEN-1001', total: 4200, currency: 'JPY',
        items: [{ product_id: 'food-1', name: '鹿肉フード', quantity: 2, unit_amount: 2100 }],
      },
    };
    insertEvent({ id: 'event-1', accountId: 'account-1', payload });
    await upsertEcEventReadModels(db, {
      eventId: 'event-1', sourceKey: 'eccube:account-1', externalEventId: 'external-event-1',
      eventType: 'ec.order.confirmed', lineAccountId: 'account-1', customerId: 'customer-1',
      friendId: 'friend-1', occurredAt: '2026-09-07T00:00:00.000Z', order: payload.order,
    });
    const orders = await listEcOrders(db, { lineAccountId: 'account-1', limit: 20, offset: 0 });
    expect(orders).toMatchObject({
      total: 1,
      items: [{
        orderNumber: 'NEN-1001', customerName: '見本 171', totalAmount: 4200,
        version: 1, orderLines: [{ productName: '鹿肉フード', quantity: 2, lineAmount: 4200 }],
      }],
    });
    expect(await listEcOrders(db, {
      lineAccountId: 'account-1', from: '2026-09-07T00:00:00.000Z', to: '2026-09-08T00:00:00.000Z',
      limit: 20, offset: 0,
    })).toMatchObject({ total: 1, summary: { total: 1, current: 1 } });
    expect(await listEcOrders(db, {
      lineAccountId: 'account-1', from: '2026-09-08T00:00:00.000Z', to: '2026-09-09T00:00:00.000Z',
      limit: 20, offset: 0,
    })).toMatchObject({ total: 0, summary: { total: 0, current: 0 } });
    // 終端の瞬間を含めず、UTCと+09:00が混在していても同じ瞬間で比較する。
    expect(await listEcOrders(db, {
      lineAccountId: 'account-1', from: '2026-09-06T00:00:00.000Z', to: '2026-09-07T00:00:00.000Z', limit: 20, offset: 0,
    })).toMatchObject({ total: 0, summary: { current: 0 } });
    sqlite.prepare('UPDATE ec_orders SET ordered_at = ?').run('2026-09-07T09:00:00+09:00');
    expect(await listEcOrders(db, {
      lineAccountId: 'account-1', from: '2026-09-07T00:00:00.000Z', to: '2026-09-08T00:00:00.000Z', limit: 20, offset: 0,
    })).toMatchObject({ total: 1, summary: { current: 1 } });
    expect(await listEcOrders(db, { lineAccountId: 'account-2', limit: 20, offset: 0 }))
      .toMatchObject({ total: 0, items: [] });

    insertEvent({
      id: 'event-2', accountId: 'account-1', eventType: 'ec.order.refunded',
      payload: { ...payload, refund: { amount: 4200 } },
    });
    await upsertEcEventReadModels(db, {
      eventId: 'event-2', sourceKey: 'eccube:account-1', externalEventId: 'external-event-2',
      eventType: 'ec.order.refunded', lineAccountId: 'account-1', customerId: 'customer-1',
      friendId: 'friend-1', occurredAt: '2026-09-08T00:00:00.000Z',
      order: payload.order, refund: { amount: 4200 },
    });
    expect(await listEcOrders(db, {
      lineAccountId: 'account-1', status: 'refunded', limit: 20, offset: 0,
    })).toMatchObject({ items: [{ status: 'refunded', refundedAmount: 4200, version: 2 }] });
  });

  it('失敗actionだけを版・冪等キー付きで再実行待ちへ戻す', async () => {
    insertEvent({
      id: 'event-action', accountId: 'account-1',
      payload: { occurred_at: '2026-09-07', order: { number: 'NEN-2001', total: 8600 } },
    });
    await upsertEcEventReadModels(db, {
      eventId: 'event-action', sourceKey: 'eccube:account-1', externalEventId: 'external-action',
      eventType: 'ec.order.confirmed', lineAccountId: 'account-1', customerId: 'customer-1',
      occurredAt: '2026-09-07T00:00:00.000Z', order: { number: 'NEN-2001', total: 8600 },
    });
    await setEcActionExecutionStatus(db, {
      eventId: 'event-action', lineAccountId: 'account-1', status: 'retryable_failed',
      errorCode: 'temporary_failure', errorMessageSafe: '一時的な問題です',
      now: '2026-09-07T00:01:00.000Z',
    });
    const failed = await listEcActionExecutions(db, {
      lineAccountId: 'account-1', status: 'retryable_failed', limit: 20, offset: 0,
    });
    expect(failed.items[0]).toMatchObject({ attemptCount: 1, version: 2, retryAvailable: true });
    const actionId = failed.items[0]!.id;
    const retryInput = {
      id: actionId, lineAccountId: 'account-1', expectedVersion: 2,
      idempotencyKey: 'retry-request-1', requestFingerprint: 'fingerprint-1',
      requestedBy: 'staff-1', now: '2026-09-07T00:02:00.000Z',
    };
    expect(await retryEcActionExecution(db, retryInput))
      .toMatchObject({ kind: 'queued', execution: { status: 'pending', attemptCount: 2, version: 3 } });
    expect(await retryEcActionExecution(db, retryInput))
      .toMatchObject({ kind: 'duplicate', execution: { status: 'pending', version: 3 } });
    expect(await retryEcActionExecution(db, { ...retryInput, requestFingerprint: 'different' }))
      .toEqual({ kind: 'changed' });
    expect(await retryEcActionExecution(db, { ...retryInput, lineAccountId: 'account-2' }))
      .toEqual({ kind: 'not_found' });
  });

  it('EC会員候補をaccount単位で集計し、平文emailと電話をマスクする', async () => {
    insertEvent({
      id: 'event-candidate', accountId: 'account-1', status: 'identity_pending',
      payload: { occurred_at: '2026-09-07' },
    });
    sqlite.prepare(
      `INSERT INTO identity_candidates (
         id, tenant_id, kind, status, version, confidence_score, detector_version,
         left_subject_kind, left_subject_id, left_line_account_id, left_shop_key, left_snapshot_json,
         right_subject_kind, right_subject_id, right_line_account_id, right_shop_key, right_snapshot_json,
         source_key, external_customer_id, evidence_fingerprint, evidence_json, impact_json,
         detected_at, created_at, updated_at
       ) VALUES (?, ?, 'ec_member', 'pending', 1, 88, 'ec-v1',
         'ec_event', ?, ?, 'shop-1', ?, 'friend', 'friend-1', ?, 'shop-1', ?,
         'eccube:account-1', 'customer-1', 'fingerprint', ?, ?, ?, ?, ?)`,
    ).run(
      'candidate-1', TENANT_ID, 'event-candidate', 'account-1',
      JSON.stringify({ label: '田中', attributes: [{ label: 'メール', valuePreview: 'tanaka@example.com' }] }),
      'account-1',
      JSON.stringify({ label: '見本 171', attributes: [{ label: '電話', valuePreview: '09000001234' }] }),
      JSON.stringify([{ key: 'email', label: 'メール', valuePreview: 'tanaka@example.com' }]),
      JSON.stringify([{ key: 'order_amount', label: '売上', value: 4200, unit: '円' }]),
      '2026-09-07T00:00:00.000Z', '2026-09-07T00:00:00.000Z', '2026-09-07T00:00:00.000Z',
    );
    const result = await listEcIdentityCandidates(db, {
      tenantId: TENANT_ID, lineAccountId: 'account-1', status: 'pending', limit: 20, offset: 0,
    });
    expect(result).toMatchObject({
      total: 1,
      summary: { unmatched: 1, candidates: 1, candidateExternalCustomers: 1, potentialRevenue: 4200 },
    });
    const text = JSON.stringify(result);
    expect(text).toContain('ta***@example.com');
    expect(text).toContain('***1234');
    expect(text).not.toContain('tanaka@example.com');
    expect(text).not.toContain('09000001234');
    expect(await listEcIdentityCandidates(db, {
      tenantId: TENANT_ID, lineAccountId: 'account-2', status: 'pending', limit: 20, offset: 0,
    })).toMatchObject({ total: 0, items: [] });
  });

  it('未知の計量キーは売上集計に入れず、既知のキーは共有の一覧どおりに数える', async () => {
    // キー名がずれても画面は黙って「—」になる。共有の一覧を本物で
    // import し、未知キーの除外と既知キーの集計を両方見張る。共有からキーを
    // 抜く・ずらす逆変異は、ここで赤になる。
    expect(ORDER_IMPACT_KEYS).toContain('orders');
    expect(REVENUE_IMPACT_KEYS).toContain('order_amount');
    insertEvent({
      id: 'event-unknown-key', accountId: 'account-1', status: 'identity_pending',
      payload: { occurred_at: '2026-09-07' },
    });
    sqlite.prepare(
      `INSERT INTO identity_candidates (
         id, tenant_id, kind, status, version, confidence_score, detector_version,
         left_subject_kind, left_subject_id, left_line_account_id, left_shop_key, left_snapshot_json,
         right_subject_kind, right_subject_id, right_line_account_id, right_shop_key, right_snapshot_json,
         source_key, external_customer_id, evidence_fingerprint, evidence_json, impact_json,
         detected_at, created_at, updated_at
       ) VALUES (?, ?, 'ec_member', 'pending', 1, 88, 'ec-v1',
         'ec_event', ?, ?, 'shop-1', ?, 'friend', 'friend-1', ?, 'shop-1', ?,
         'eccube:account-1', 'customer-1', 'fingerprint', ?, ?, ?, ?, ?)`,
    ).run(
      'candidate-unknown-key', TENANT_ID, 'event-unknown-key', 'account-1',
      JSON.stringify({ label: '田中', attributes: [] }),
      'account-1',
      JSON.stringify({ label: '見本 171', attributes: [] }),
      JSON.stringify([]),
      JSON.stringify([
        { key: 'order_amount', label: '売上', value: 4200, unit: '円' },
        { key: 'orders', label: '注文', value: 6, unit: '件' },
        { key: 'revenue_next', label: '未知の売上', value: 9999, unit: '円' },
      ]),
      '2026-09-07T00:00:00.000Z', '2026-09-07T00:00:00.000Z', '2026-09-07T00:00:00.000Z',
    );
    const result = await listEcIdentityCandidates(db, {
      tenantId: TENANT_ID, lineAccountId: 'account-1', status: 'pending', limit: 20, offset: 0,
    });
    // 未知キー 9999 は足さない。既知の order_amount 4200 だけを数える。
    expect(result).toMatchObject({ summary: { potentialRevenue: 4200 } });
  });
});
