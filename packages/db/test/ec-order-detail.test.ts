/*
 * 注文1件の処理状況ビュー（getEcOrderDetail）の固定。
 *
 * 見る点:
 *  - 注文に届いた出来事・個別処理・購読配送・共通送信台帳・発送後の案内・
 *    成果/マイル/スコアが1回の問い合わせで揃う
 *  - アカウントをまたぐ注文・出来事・送達は返さない
 *  - 失敗分類が「未連携／権限・認証／通信失敗」などへ分かれる
 *  - 生のエラーメッセージ（台帳の last_error 等）は外へ出ない
 */
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  classifyEcErrorCode,
  classifyEcRawError,
  getEcOrderDetail,
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
  sqlite.exec(`
    INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret, tenant_id)
    VALUES ('account-1', 'channel-1', '本店', 'token', 'secret', '${TENANT_ID}'),
           ('account-2', 'channel-2', '別店', 'token', 'secret', '${TENANT_ID}');
    INSERT INTO friends (id, line_user_id, display_name, line_account_id)
    VALUES ('friend-1', 'U1', '見本 171', 'account-1'),
           ('friend-2', 'U2', '別店の人', 'account-2');
    INSERT INTO mileage_programs (id, code, name, status, created_at, updated_at)
    VALUES ('default', 'default', '標準', 'active', '2026-01-01', '2026-01-01');
    INSERT INTO nen_campaign_settings
      (campaign_key, label, category, trigger_event, delay_days, delivery_time, is_enabled, title, created_at, updated_at)
    VALUES ('arrival_check', '到着確認の案内', 'follow_up', 'ec.order.shipped', 3, '10:00', 1, '到着確認', '2026-01-01', '2026-01-01');
    INSERT INTO conversion_points
      (id, name, event_type, value, status, line_account_id, tenant_id)
    VALUES ('point-1', '初回購入', 'ec_order_confirmed', 100, 'active', 'account-1', '${TENANT_ID}');
  `);
  db = asD1(sqlite);
});

function insertEvent(input: {
  id: string;
  externalId: string;
  accountId?: string;
  eventType?: string;
  status?: string;
  friendId?: string | null;
  orderNumber?: string;
  receivedAt?: string;
  errorMessage?: string | null;
}) {
  sqlite.prepare(
    `INSERT INTO ec_events
       (id, source, external_event_id, event_type, line_account_id, customer_id,
        friend_id, payload, status, received_at, processed_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'customer-1', ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    `eccube:${input.accountId ?? 'account-1'}`,
    input.externalId,
    input.eventType ?? 'ec.order.confirmed',
    input.accountId ?? 'account-1',
    input.friendId === undefined ? 'friend-1' : input.friendId,
    JSON.stringify({ order: { number: input.orderNumber ?? 'NEN-1001', total: 2860 } }),
    input.status ?? 'processed',
    input.receivedAt ?? '2026-09-16T00:00:00.000Z',
    input.status === 'processed' ? '2026-09-16T00:01:00.000Z' : null,
    '2026-09-16T00:01:00.000Z',
  );
}

async function seedOrder(input: { orderNumber?: string; eventId: string; externalId: string }) {
  await upsertEcEventReadModels(db, {
    eventId: input.eventId,
    sourceKey: 'eccube:account-1',
    externalEventId: input.externalId,
    eventType: 'ec.order.confirmed',
    lineAccountId: 'account-1',
    customerId: 'customer-1',
    friendId: 'friend-1',
    occurredAt: '2026-09-16T00:00:00.000Z',
    order: {
      number: input.orderNumber ?? 'NEN-1001',
      total: 2860,
      currency: 'JPY',
      date: '2026-09-16T00:00:00.000Z',
      items: [{ product_id: 'p-1', name: '鹿肉ミンチ', quantity: 2, unit_amount: 1430 }],
    },
  });
  return sqlite
    .prepare(`SELECT id FROM ec_orders WHERE line_account_id = 'account-1' AND order_number = ?`)
    .get(input.orderNumber ?? 'NEN-1001') as { id: string };
}

describe('classifyEcErrorCode / classifyEcRawError', () => {
  it('未連携・権限不足・通信失敗を分ける', () => {
    expect(classifyEcErrorCode('line_identity_unmatched')).toBe('unlinked');
    expect(classifyEcErrorCode('line_authentication_failed')).toBe('permission');
    expect(classifyEcErrorCode('line_account_not_found')).toBe('permission');
    expect(classifyEcErrorCode('line_rate_limited')).toBe('communication');
    expect(classifyEcErrorCode('line_temporary_failure')).toBe('communication');
    expect(classifyEcErrorCode('friend_not_following')).toBe('not_following');
    expect(classifyEcErrorCode('notification_disabled')).toBe('by_setting');
    expect(classifyEcErrorCode('line_rejected')).toBe('rejected');
    expect(classifyEcErrorCode('event_processing_failed')).toBe('internal');
    expect(classifyEcErrorCode(null)).toBeNull();
  });

  it('生のエラーメッセージは分類だけ返す', () => {
    expect(classifyEcRawError('LINE API error: 403 Forbidden')).toBe('permission');
    expect(classifyEcRawError('request timeout after 30s')).toBe('communication');
    expect(classifyEcRawError('LINE API error: 400 Bad Request')).toBe('rejected');
    expect(classifyEcRawError('unexpected schema')).toBe('internal');
    expect(classifyEcRawError(null)).toBeNull();
  });
});

describe('getEcOrderDetail', () => {
  it('別アカウントや存在しない注文は null を返す', async () => {
    insertEvent({ id: 'ev-1', externalId: 'ext-1' });
    const { id } = await seedOrder({ eventId: 'ev-1', externalId: 'ext-1' });
    expect(await getEcOrderDetail(db, { lineAccountId: 'account-1', orderId: id })).not.toBeNull();
    expect(await getEcOrderDetail(db, { lineAccountId: 'account-2', orderId: id })).toBeNull();
    expect(await getEcOrderDetail(db, { lineAccountId: 'account-1', orderId: 'missing' })).toBeNull();
  });

  it('注文に届いた出来事・処理・配送・送達・案内・成果をまとめて返す', async () => {
    insertEvent({ id: 'ev-1', externalId: 'ext-1', status: 'processed' });
    const { id: orderId } = await seedOrder({ eventId: 'ev-1', externalId: 'ext-1' });

    // 個別処理を成功へ進める（初回試行の記録も残る）。
    await setEcActionExecutionStatus(db, {
      eventId: 'ev-1', lineAccountId: 'account-1', status: 'succeeded',
    });

    // 購読先別配送（通知・連携とも完了）。
    sqlite.prepare(
      `INSERT INTO ec_v6_dispatches (event_id, subscriber, status, attempt_count, idempotency_key, updated_at)
       VALUES ('ev-1', 'notification', 'sent', 1, 'k1', '2026-09-16T00:01:00.000Z'),
              ('ev-1', 'v6', 'sent', 1, 'k2', '2026-09-16T00:01:00.000Z')`,
    ).run();

    // 共通送信台帳: 顧客通知は dedupe_key='ec:<外部出来事ID>' で辿る。
    sqlite.prepare(
      `INSERT INTO notification_instances
         (id, line_account_id, audience_type, source_event_type, source_event_id, dedupe_key, status, created_at, updated_at)
       VALUES ('inst-1', 'account-1', 'customer', 'ec.order.confirmed', 'ext-1', 'ec:ext-1', 'completed', '2026-09-16T00:00:30.000Z', '2026-09-16T00:01:00.000Z')`,
    ).run();
    sqlite.prepare(
      `INSERT INTO notification_deliveries
         (id, line_account_id, instance_id, audience_type, recipient_type, recipient_id,
          channel, idempotency_key, status, retryable, attempts, queued_at, accepted_at,
          execution_mode, version, updated_at)
       VALUES ('del-1', 'account-1', 'inst-1', 'customer', 'friend', 'friend-1',
               'line', 'retry-key-1', 'provider_accepted', 0, 1, '2026-09-16T00:00:30.000Z',
               '2026-09-16T00:01:00.000Z', 'automatic', 1, '2026-09-16T00:01:00.000Z')`,
    ).run();

    // 発送後の案内（この注文へ予約されたもの）。
    sqlite.prepare(
      `INSERT INTO nen_delivery_jobs
         (id, campaign_key, friend_id, line_account_id, source_key, payload, scheduled_at, status, attempts, created_at, updated_at)
       VALUES ('job-1', 'arrival_check', 'friend-1', 'account-1', 'ext-1',
               '{"event":{"order":{"number":"NEN-1001"}}}', '2026-09-19T01:00:00.000Z', 'pending', 0,
               '2026-09-16T00:01:00.000Z', '2026-09-16T00:01:00.000Z')`,
    ).run();

    // 成果・マイル・スコア（外部出来事IDで辿れるもの）。
    sqlite.prepare(
      `INSERT INTO conversion_events
         (id, conversion_point_id, friend_id, metadata, point_name_snapshot, value_snapshot, created_at)
       VALUES ('cv-1', 'point-1', 'friend-1',
               '{"sourceType":"ec_order_confirmed","ecEventId":"ext-1","orderNumber":"NEN-1001"}',
               '初回購入', 2860, '2026-09-16T00:01:00.000Z')`,
    ).run();
    sqlite.prepare(
      `INSERT INTO mileage_ledger
         (id, program_id, beneficiary_friend_id, entry_type, status, amount, reason, source, source_event_id, idempotency_key, occurred_at, created_at)
       VALUES ('ml-1', 'default', 'friend-1', 'grant', 'available', 28, '購入マイル', 'eccube', 'ext-1', 'mile:key:1', '2026-09-16T00:01:00.000Z', '2026-09-16T00:01:00.000Z')`,
    ).run();
    sqlite.prepare(
      `INSERT INTO friend_scores
         (id, friend_id, score_change, reason, created_at, line_account_id, source, source_event_id, operation, score_before, score_after, occurred_at)
       VALUES ('fs-1', 'friend-1', 5, 'ec.order.confirmed → 購入', '2026-09-16T00:01:00.000Z', 'account-1', 'eccube', 'ext-1', 'delta', 0, 5, '2026-09-16T00:01:00.000Z')`,
    ).run();

    const detail = await getEcOrderDetail(db, { lineAccountId: 'account-1', orderId });
    expect(detail).not.toBeNull();
    expect(detail!.order.orderNumber).toBe('NEN-1001');
    expect(detail!.order.orderLines).toHaveLength(1);
    expect(detail!.order.customerName).toBe('見本 171');

    expect(detail!.events).toHaveLength(1);
    const event = detail!.events[0];
    expect(event.externalEventId).toBe('ext-1');
    expect(event.status).toBe('processed');
    expect(event.actions).toHaveLength(1);
    expect(event.actions[0].status).toBe('succeeded');
    expect(event.actions[0].attempts).toHaveLength(1);
    expect(event.actions[0].attempts[0].triggerKind).toBe('automatic');
    expect(event.dispatches).toHaveLength(2);
    expect(event.deliveries).toHaveLength(1);
    expect(event.deliveries[0].status).toBe('provider_accepted');
    expect(event.deliveries[0].failureKind).toBeNull();

    expect(detail!.followUps).toHaveLength(1);
    expect(detail!.followUps[0].campaignLabel).toBe('到着確認の案内');
    expect(detail!.followUps[0].status).toBe('pending');

    expect(detail!.outcomes.conversions).toHaveLength(1);
    expect(detail!.outcomes.conversions[0].pointName).toBe('初回購入');
    expect(detail!.outcomes.mileage).toHaveLength(1);
    expect(detail!.outcomes.mileage[0].amount).toBe(28);
    expect(detail!.outcomes.scores).toHaveLength(1);
    expect(detail!.outcomes.scores[0].scoreChange).toBe(5);
  });

  it('未連携で止まった出来事は unlinked と分かり、友だち未解決のまま注文を説明できる', async () => {
    insertEvent({ id: 'ev-1', externalId: 'ext-1', status: 'identity_pending', friendId: null, errorMessage: 'line_identity_unmatched' });
    const { id: orderId } = await seedOrder({ eventId: 'ev-1', externalId: 'ext-1' });
    sqlite.prepare(`UPDATE ec_orders SET friend_id = NULL WHERE id = ?`).run(orderId);
    await setEcActionExecutionStatus(db, {
      eventId: 'ev-1', lineAccountId: 'account-1', status: 'skipped',
      errorCode: 'line_identity_unmatched', errorMessageSafe: 'LINEの友だちが見つかりません',
    });
    const detail = await getEcOrderDetail(db, { lineAccountId: 'account-1', orderId });
    expect(detail!.order.friendId).toBeNull();
    expect(detail!.events[0].status).toBe('identity_pending');
    expect(detail!.events[0].failureKind).toBe('unlinked');
    expect(detail!.events[0].actions[0].failureKind).toBe('unlinked');
  });

  it('配送台帳の生メッセージは出さず、権限・通信の分類だけを返す', async () => {
    insertEvent({ id: 'ev-1', externalId: 'ext-1', status: 'failed' });
    const { id: orderId } = await seedOrder({ eventId: 'ev-1', externalId: 'ext-1' });
    await setEcActionExecutionStatus(db, {
      eventId: 'ev-1', lineAccountId: 'account-1', status: 'retryable_failed',
      errorCode: 'event_processing_failed', errorMessageSafe: 'ECの処理を完了できませんでした',
    });
    sqlite.prepare(
      `INSERT INTO ec_v6_dispatches (event_id, subscriber, status, attempt_count, last_error, idempotency_key, updated_at)
       VALUES ('ev-1', 'notification', 'failed', 2, 'LINE API error: 403 Forbidden: token=secret-should-not-leak', 'k1', '2026-09-16T00:01:00.000Z')`,
    ).run();

    const detail = await getEcOrderDetail(db, { lineAccountId: 'account-1', orderId });
    const dispatch = detail!.events[0].dispatches[0];
    expect(dispatch.status).toBe('failed');
    expect(dispatch.failureKind).toBe('permission');
    // 生のエラー本文（秘密値を含みうる）はレスポンス型に存在しない。
    expect(dispatch).not.toHaveProperty('lastError');
    expect(JSON.stringify(detail)).not.toContain('secret-should-not-leak');
  });

  it('別アカウント・別注文番号の出来事と送達は混ざらない', async () => {
    insertEvent({ id: 'ev-1', externalId: 'ext-1', status: 'processed' });
    insertEvent({
      id: 'ev-2', externalId: 'ext-2', accountId: 'account-2',
      status: 'processed', friendId: 'friend-2', orderNumber: 'NEN-1001',
    });
    const { id: orderId } = await seedOrder({ eventId: 'ev-1', externalId: 'ext-1' });
    // 別アカウントの送達は同じ dedupe_key でも混ざらない。
    sqlite.prepare(
      `INSERT INTO notification_instances
         (id, line_account_id, audience_type, source_event_type, source_event_id, dedupe_key, status, created_at, updated_at)
       VALUES ('inst-2', 'account-2', 'customer', 'ec.order.confirmed', 'ext-2', 'ec:ext-2', 'completed', '2026-09-16', '2026-09-16')`,
    ).run();
    sqlite.prepare(
      `INSERT INTO notification_deliveries
         (id, line_account_id, instance_id, audience_type, recipient_type, recipient_id,
          channel, idempotency_key, status, retryable, attempts, queued_at, execution_mode, version, updated_at)
       VALUES ('del-2', 'account-2', 'inst-2', 'customer', 'friend', 'friend-2',
               'line', 'rk2', 'provider_accepted', 0, 1, '2026-09-16', 'automatic', 1, '2026-09-16')`,
    ).run();
    const detail = await getEcOrderDetail(db, { lineAccountId: 'account-1', orderId });
    expect(detail!.events.map((event) => event.id)).toEqual(['ev-1']);
    expect(detail!.events[0].deliveries).toHaveLength(0);
  });

  /*
   * 注文から成果・報酬・支払い状態まで同じ行で辿れることの固定。
   * 確定後の取消（反対仕訳）と、同じ注文・同じ成果地点の重複候補も見せる。
   */
  it('成果から紹介者・確定報酬・締め・支払いCSV・支払い結果まで辿れる', async () => {
    insertEvent({ id: 'ev-1', externalId: 'ext-1', status: 'processed' });
    const { id: orderId } = await seedOrder({ eventId: 'ev-1', externalId: 'ext-1' });

    sqlite.prepare(`INSERT INTO affiliates (id, name, code) VALUES ('aff-1', '紹介者A', 'code-aff-1')`).run();
    sqlite.prepare(`INSERT OR IGNORE INTO tenants (id, name) VALUES ('${TENANT_ID}', 'テスト')`).run();
    sqlite.prepare(
      `INSERT INTO conversion_events
         (id, conversion_point_id, friend_id, affiliate_id, metadata, point_name_snapshot,
          value_snapshot, approval_status, approved_at, created_at)
       VALUES ('cv-1', 'point-1', 'friend-1', 'aff-1',
               '{"sourceType":"ec_order_confirmed","ecEventId":"ext-1","orderNumber":"NEN-1001"}',
               '初回購入', 2860, 'approved', '2026-09-16T00:02:00.000Z', '2026-09-16T00:01:00.000Z')`,
    ).run();
    sqlite.prepare(
      `INSERT INTO affiliate_reward_calculations
         (id, organization_id, line_account_id, affiliate_id, conversion_event_id, formula, amount_minor)
       VALUES ('calc-1', '${TENANT_ID}', 'account-1', 'aff-1', 'cv-1', 'fixed', 400)`,
    ).run();
    sqlite.prepare(
      `INSERT INTO affiliate_reward_entries
         (id, organization_id, line_account_id, affiliate_id, conversion_event_id,
          entry_type, amount_minor, status, idempotency_key)
       VALUES ('re-1', '${TENANT_ID}', 'account-1', 'aff-1', 'cv-1', 'credit', 400, 'settled', 'ik-credit-1'),
              ('re-2', '${TENANT_ID}', 'account-1', 'aff-1', 'cv-1', 'debit', 400, 'reversed', 'ik-debit-1')`,
    ).run();
    sqlite.prepare(
      `INSERT INTO affiliate_settlements
         (id, organization_id, line_account_id, affiliate_id, period_from, period_to,
          total_amount_minor, state, closed_by, idempotency_key)
       VALUES ('st-1', '${TENANT_ID}', 'account-1', 'aff-1', '2026-09-01', '2026-09-30',
               400, 'exported', 'staff-1', 'st-key-1')`,
    ).run();
    sqlite.prepare(
      `INSERT INTO affiliate_settlement_lines (id, settlement_id, affiliate_id, entry_id, amount_minor)
       VALUES ('sl-1', 'st-1', 'aff-1', 're-1', 400)`,
    ).run();
    sqlite.prepare(
      `INSERT INTO affiliate_payout_batches
         (id, organization_id, line_account_id, settlement_id, total_amount_minor,
          line_count, state, created_by)
       VALUES ('pb-1', '${TENANT_ID}', 'account-1', 'st-1', 400, 1, 'imported', 'staff-1')`,
    ).run();
    sqlite.prepare(
      `INSERT INTO affiliate_payout_batch_lines
         (id, batch_id, settlement_line_id, affiliate_id, amount_minor,
          bank_code, bank_name, branch_code, branch_name, account_type,
          account_number_encrypted, account_last4, account_holder_name)
       VALUES ('pbl-1', 'pb-1', 'sl-1', 'aff-1', 400,
               '0001', 'テスト銀行', '001', '本店', 'ordinary', 'enc', '1234', 'タロウ')`,
    ).run();
    sqlite.prepare(
      `INSERT INTO affiliate_payout_results
         (id, batch_id, affiliate_id, settlement_line_id, paid_amount_minor, result, imported_by)
       VALUES ('pr-1', 'pb-1', 'aff-1', 'sl-1', 400, 'paid', 'staff-1')`,
    ).run();

    const detail = await getEcOrderDetail(db, { lineAccountId: 'account-1', orderId });
    expect(detail!.outcomes.conversions).toHaveLength(1);
    expect(detail!.outcomes.conversions[0]).toMatchObject({
      id: 'cv-1',
      pointName: '初回購入',
      approvalStatus: 'approved',
      orderNumber: 'NEN-1001',
      ecEventId: 'ext-1',
      affiliateName: '紹介者A',
      rewardAmount: 400,
      rewardEntryStatus: 'settled',
      reversedAmount: 400,
      settlementState: 'exported',
      payoutBatchState: 'imported',
      payoutResult: 'paid',
      duplicateCandidate: false,
    });
  });

  it('同じ注文・同じ成果地点の成果が2件あれば両方に重複候補を立てる', async () => {
    insertEvent({ id: 'ev-1', externalId: 'ext-1', status: 'processed' });
    const { id: orderId } = await seedOrder({ eventId: 'ev-1', externalId: 'ext-1' });

    // 同じ注文が別の出来事IDで届き直した形（冪等キーが違うので別の成果が立つ）。
    for (const [id, eventId] of [['cv-1', 'ext-1'], ['cv-2', 'ext-9']] as const) {
      sqlite.prepare(
        `INSERT INTO conversion_events
           (id, conversion_point_id, friend_id, metadata, point_name_snapshot, value_snapshot, created_at)
         VALUES (?, 'point-1', 'friend-1', ?, '初回購入', 2860, '2026-09-16T00:01:00.000Z')`,
      ).run(id, `{"sourceType":"ec_order_confirmed","ecEventId":"${eventId}","orderNumber":"NEN-1001"}`);
    }

    const detail = await getEcOrderDetail(db, { lineAccountId: 'account-1', orderId });
    expect(detail!.outcomes.conversions).toHaveLength(2);
    expect(detail!.outcomes.conversions.every((row) => row.duplicateCandidate)).toBe(true);
  });

  it('別アカウントの友だちの成果は、同じ注文番号でもこの注文に混ざらない', async () => {
    insertEvent({ id: 'ev-1', externalId: 'ext-1', status: 'processed' });
    const { id: orderId } = await seedOrder({ eventId: 'ev-1', externalId: 'ext-1' });

    // account-2 の友だちの成果地点と、同じ注文番号の成果。注文番号だけで
    // 突き合わせると別店の成果がこの注文へ混ざる。
    sqlite.prepare(
      `INSERT INTO conversion_points (id, name, event_type, value, status, line_account_id, tenant_id)
       VALUES ('point-2', '購入', 'ec_order_confirmed', 100, 'active', 'account-2', '${TENANT_ID}')`,
    ).run();
    sqlite.prepare(
      `INSERT INTO conversion_events
         (id, conversion_point_id, friend_id, metadata, point_name_snapshot, value_snapshot, created_at)
       VALUES ('cv-other', 'point-2', 'friend-2',
               '{"sourceType":"ec_order_confirmed","ecEventId":"ext-2","orderNumber":"NEN-1001"}',
               '購入', 1000, '2026-09-16T00:01:00.000Z')`,
    ).run();

    const detail = await getEcOrderDetail(db, { lineAccountId: 'account-1', orderId });
    expect(detail!.outcomes.conversions.map((row) => row.id)).toEqual([]);
  });
});


describe('注文の出来事が増えた場合', () => {
  it('150件の出来事と処理履歴をD1の変数上限以内で全件返す', async () => {
    for (let i = 0; i < 150; i++) insertEvent({ id: `bulk-${i}`, externalId: `external-${i}` });
    const order = await seedOrder({ eventId: 'bulk-0', externalId: 'external-0' });
    for (let i = 0; i < 150; i++) {
      sqlite.prepare(`INSERT INTO ec_action_executions
        (id, line_account_id, event_id, action_type, rule_version, idempotency_key, status, created_at, updated_at)
        VALUES (?, 'account-1', ?, 'notification', 'ec-action-v1', ?, 'succeeded', '2026-09-16', '2026-09-16')`).run(`action-${i}`, `bulk-${i}`, `key-${i}`);
    }
    const detail = await getEcOrderDetail(db, { lineAccountId: 'account-1', orderId: order.id });
    expect(detail?.events).toHaveLength(150);
  });
});
