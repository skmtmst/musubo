import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@line-crm/db', () => ({
  isOperationCapabilityStopped: vi.fn(async () => false),
  claimWebhookInteractionRetryAndInsert: vi.fn(),
  deletePendingWebhookInteraction: vi.fn(),
  finishWebhookInteraction: vi.fn(),
  getOutgoingWebhookById: vi.fn(),
  getWebhookInteractionById: vi.fn(),
  markFailedInteractionsRetried: vi.fn(),
  resolveWebhookSecret: vi.fn(async (row: { secret?: unknown; secret_encrypted?: unknown }) => {
    if (typeof row?.secret_encrypted === 'string') {
      if (row.secret_encrypted.startsWith('v1-broken')) throw new Error('Unable to decrypt webhook secret');
      return 'r'.repeat(32);
    }
    return (row?.secret as string | null) ?? null;
  }),
  restoreWebhookInteractionFailure: vi.fn(),
}));

vi.mock('./outgoing-webhook-delivery.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./outgoing-webhook-delivery.js')>();
  return {
    ...actual,
    // 純粋な変換(failureReasonForDelivery / outgoingAttemptOf)は本物を使い、
    // 外部通信・DBだけモックへ差し替える。
    claimOutgoingDelivery: vi.fn(),
    deliverOnce: vi.fn(),
    findOutgoingDeliveryByKey: vi.fn(),
    enqueueOutgoingWebhookDelivery: vi.fn(),
    finishOutgoingDelivery: vi.fn(),
    recordDeliveryOutcome: vi.fn(),
    releaseOutgoingDelivery: vi.fn(),
  };
});

import {
  claimWebhookInteractionRetryAndInsert,
  deletePendingWebhookInteraction,
  finishWebhookInteraction,
  getOutgoingWebhookById,
  getWebhookInteractionById,
  isOperationCapabilityStopped,
  markFailedInteractionsRetried,
  resolveWebhookSecret,
  restoreWebhookInteractionFailure,
  type WebhookInteractionRow,
} from '@line-crm/db';

import {
  claimOutgoingDelivery,
  deliverOnce,
  findOutgoingDeliveryByKey,
  enqueueOutgoingWebhookDelivery,
  finishOutgoingDelivery,
  recordDeliveryOutcome,
  releaseOutgoingDelivery,
  type OutgoingDeliveryRow,
} from './outgoing-webhook-delivery.js';
import { retryWebhookInteraction, webhookFailureLabel, webhookResponseLabel } from './webhook-interactions.js';

const original: WebhookInteractionRow = {
  id: 'run-1', line_account_id: 'account-a', direction: 'outgoing',
  webhook_id: 'wh-1', webhook_name: '顧客管理', event_type: 'friend.added',
  trigger_summary: '友だちが追加されたとき', status: 'failed',
  request_body_json: '{"event":"friend.added"}', response_status: 500,
  attempt_count: 1, duration_ms: 100, failure_reason: 'response_5xx',
  idempotency_key: 'delivery-1', retry_of_id: null,
  started_at: '2026-08-29T10:00:00.000+09:00',
  completed_at: '2026-08-29T10:00:00.100+09:00',
  created_at: '2026-08-29T10:00:00.000+09:00',
};

const retryRow: WebhookInteractionRow = {
  ...original, id: 'run-2', status: 'pending', response_status: null,
  failure_reason: null, retry_of_id: 'run-1', completed_at: null,
};

function deliveryRow(overrides: Partial<OutgoingDeliveryRow> = {}): OutgoingDeliveryRow {
  return {
    id: 'del-1', line_account_id: 'account-a', webhook_id: 'wh-1',
    event_type: 'friend.added', body_json: '{"event":"friend.added"}',
    idempotency_key: 'delivery-1', status: 'retry_wait',
    attempts: 1, max_attempts: 8, next_retry_at: '2026-08-29T10:05:00.000+09:00',
    lease_token: null, lease_until: null, last_response_status: 500,
    error_code: 'response_5xx', error_message_safe: 'つなぎ先で処理できませんでした。',
    queued_at: '2026-08-29T10:00:00.000+09:00', delivered_at: null,
    failed_at: null, updated_at: '2026-08-29T10:00:00.000+09:00',
    ...overrides,
  };
}

describe('Webhookの安全な送り直し', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getOutgoingWebhookById).mockResolvedValue({
      id: 'wh-1', name: '顧客管理', url: 'https://example.com/hook', event_types: '["*"]',
      secret: 'a'.repeat(32), is_active: 1, max_retries: 0,
      consecutive_failures: 0, last_failed_at: null, line_account_id: 'account-a',
      created_at: '2026-08-29', updated_at: '2026-08-29',
    });
    vi.mocked(isOperationCapabilityStopped).mockResolvedValue(false);
    vi.mocked(findOutgoingDeliveryByKey).mockResolvedValue(null);
    vi.mocked(enqueueOutgoingWebhookDelivery).mockResolvedValue(deliveryRow({status:'pending'}));
    vi.mocked(claimOutgoingDelivery).mockResolvedValue('lease:test');
    vi.mocked(claimWebhookInteractionRetryAndInsert).mockResolvedValue({ claimed: true, retryId: 'run-2' });
    vi.mocked(getWebhookInteractionById).mockResolvedValue({ ...retryRow, status: 'succeeded', response_status: 200 });
    vi.mocked(finishWebhookInteraction).mockResolvedValue(undefined);
    vi.mocked(recordDeliveryOutcome).mockResolvedValue(undefined);
    vi.mocked(deletePendingWebhookInteraction).mockResolvedValue(undefined);
    vi.mocked(restoreWebhookInteractionFailure).mockResolvedValue(undefined);
    vi.mocked(releaseOutgoingDelivery).mockResolvedValue(undefined);
    vi.mocked(markFailedInteractionsRetried).mockResolvedValue(undefined);
    vi.mocked(finishOutgoingDelivery).mockResolvedValue('delivered');
  });

  it('確認した送り先の版が古ければ送らない', async () => {
    const originalWithRevision = { ...original, confirmation_revision: 1 };
    const target = await vi.mocked(getOutgoingWebhookById)({} as D1Database, 'wh-1', 'account-a');
    vi.mocked(getOutgoingWebhookById).mockResolvedValue({ ...target!, confirmation_revision: 2 });
    await expect(retryWebhookInteraction({} as D1Database, originalWithRevision, undefined, { interactionRevision: 1, webhookRevision: 1 })).rejects.toThrow('confirmation_conflict');
    expect(deliverOnce).not.toHaveBeenCalled();
  });

  it('確保の後に送り先が変わった場合も送らず元の記録に戻す', async () => {
    const target = await vi.mocked(getOutgoingWebhookById)({} as D1Database, 'wh-1', 'account-a');
    vi.mocked(getOutgoingWebhookById).mockResolvedValueOnce({ ...target!, confirmation_revision: 1 }).mockResolvedValueOnce({ ...target!, confirmation_revision: 2 });
    await expect(retryWebhookInteraction({} as D1Database, { ...original, confirmation_revision: 1 }, undefined, { interactionRevision: 1, webhookRevision: 1 })).rejects.toThrow('confirmation_conflict');
    expect(deliverOnce).not.toHaveBeenCalled();
    expect(restoreWebhookInteractionFailure).toHaveBeenCalled();
  });

  it('両方の版が一致すれば確認した宛先へ同じ配送番号で送る', async () => {
    const target = await vi.mocked(getOutgoingWebhookById)({} as D1Database, 'wh-1', 'account-a');
    vi.mocked(getOutgoingWebhookById).mockResolvedValue({ ...target!, confirmation_revision: 2 });
    vi.mocked(deliverOnce).mockResolvedValue({ ok: true, attempts: 1, lastStatus: 200 });
    await retryWebhookInteraction({} as D1Database, { ...original, confirmation_revision: 3 }, undefined, { interactionRevision: 3, webhookRevision: 2 });
    expect(claimWebhookInteractionRetryAndInsert).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ expectedInteractionRevision: 3, expectedWebhookRevision: 2 }));
    expect(deliverOnce).toHaveBeenCalledOnce();
  });

  it.each(['future', 'legacy_missing_deadline'])('blocks manual sends while the provider wait is unresolved: %s', async mode => {
    vi.mocked(findOutgoingDeliveryByKey).mockResolvedValue(deliveryRow({
      status:'failed',error_code:'retry_after_exceeds_budget',
      next_retry_at:mode==='future'?new Date(Date.now()+3600_000).toISOString():null,
    }));
    await expect(retryWebhookInteraction({} as D1Database,original)).rejects.toThrow('retry_after_pending');
    expect(claimOutgoingDelivery).not.toHaveBeenCalled();
    expect(claimWebhookInteractionRetryAndInsert).not.toHaveBeenCalled();
    expect(deliverOnce).not.toHaveBeenCalled();
  });

  it('初回と同じ配送IDを使い、成功を新しい記録へ残す', async () => {
    vi.mocked(deliverOnce).mockResolvedValue({ ok: true, attempts: 1, lastStatus: 200 });
    const db = {} as D1Database;

    const result = await retryWebhookInteraction(db, original);

    // d23b : 畳み込みと新記録は1つのDBバッチで行う。
    expect(claimWebhookInteractionRetryAndInsert).toHaveBeenCalledWith(db, original, expect.objectContaining({
      webhookId: 'wh-1', idempotencyKey: 'delivery-1', requestBodyJson: original.request_body_json,
    }));
    expect(deliverOnce).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'wh-1' }),
      original.request_body_json,
      { idempotencyKey: 'delivery-1',credentialKeys:undefined },
    );
    expect(finishWebhookInteraction).toHaveBeenCalledWith(db, 'run-2', 'account-a', expect.objectContaining({
      status: 'succeeded', responseStatus: 200,
    }));
    expect(recordDeliveryOutcome).toHaveBeenCalledWith(db, 'wh-1', true);
    // d23b : 届いた通知と同じ失敗記録は「やり直し済み」へ畳む。
    expect(markFailedInteractionsRetried).toHaveBeenCalledWith(db, 'account-a', 'wh-1', 'delivery-1');
    expect(result.status).toBe('succeeded');
  });

  it('別アカウントのWebhook IDを使っても見つからなければ送らない', async () => {
    vi.mocked(getOutgoingWebhookById).mockResolvedValue(null);
    await expect(retryWebhookInteraction({} as D1Database, original)).rejects.toThrow('webhook_not_found');
    expect(deliverOnce).not.toHaveBeenCalled();
    expect(claimWebhookInteractionRetryAndInsert).not.toHaveBeenCalled();
  });

  it('同じ失敗を二重に確保できなければ送らない', async () => {
    vi.mocked(claimWebhookInteractionRetryAndInsert).mockResolvedValue({ claimed: false, retryId: 'run-2' });
    await expect(retryWebhookInteraction({} as D1Database, original)).rejects.toThrow('already_retried');
    expect(deliverOnce).not.toHaveBeenCalled();
  });

  it('再送記録が残らなかった場合だけ元の失敗を再試行可能へ戻す', async () => {
    vi.mocked(deliverOnce).mockRejectedValue(new Error('database unavailable'));
    vi.mocked(getWebhookInteractionById).mockResolvedValue(null);
    await expect(retryWebhookInteraction({} as D1Database, original)).rejects.toThrow('database unavailable');
    expect(restoreWebhookInteractionFailure).toHaveBeenCalledWith(expect.anything(), 'run-1', 'account-a');
  });

  it('暗号化された送り先は鍵で復号して送り直す(#650)', async () => {
    vi.mocked(getOutgoingWebhookById).mockResolvedValue({
      id: 'wh-1', name: '顧客管理', url: 'https://example.com/hook', event_types: '["*"]',
      secret: null, secret_encrypted: 'v1-enc-abc', is_active: 1, max_retries: 0,
      consecutive_failures: 0, last_failed_at: null, line_account_id: 'account-a',
      created_at: '2026-08-29', updated_at: '2026-08-29',
    });
    vi.mocked(deliverOnce).mockResolvedValue({ ok: true, attempts: 1, lastStatus: 200 });
    const db = {} as D1Database;

    await retryWebhookInteraction(db, original, 'test-key');
    expect(resolveWebhookSecret).toHaveBeenCalledWith(expect.objectContaining({ id: 'wh-1' }), 'test-key');
    // 署名用の復号は deliverOnce が行う。鍵がそのまま渡ることを固定する。
    expect(deliverOnce).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'wh-1' }),
      original.request_body_json,
      { idempotencyKey: 'delivery-1', credentialKeys: 'test-key' },
    );
  });

  it('復号できない送り先は送らずwebhook_secret_unavailableで止める(#650)', async () => {
    vi.mocked(getOutgoingWebhookById).mockResolvedValue({
      id: 'wh-1', name: '顧客管理', url: 'https://example.com/hook', event_types: '["*"]',
      secret: null, secret_encrypted: 'v1-broken-xyz', is_active: 1, max_retries: 0,
      consecutive_failures: 0, last_failed_at: null, line_account_id: 'account-a',
      created_at: '2026-08-29', updated_at: '2026-08-29',
    });
    await expect(retryWebhookInteraction({} as D1Database, original, 'test-key'))
      .rejects.toThrow('webhook_secret_unavailable');
    expect(deliverOnce).not.toHaveBeenCalled();
    expect(claimWebhookInteractionRetryAndInsert).not.toHaveBeenCalled();
  });

  // ---- d23b : 手動のやり直しと自動配送台帳の照合 ----

  it('同じ通知が自動で届き済みなら手動では重ねない', async () => {
    vi.mocked(findOutgoingDeliveryByKey).mockResolvedValue(deliveryRow({ status: 'delivered' }));
    await expect(retryWebhookInteraction({} as D1Database, original)).rejects.toThrow('already_delivered');
    expect(claimOutgoingDelivery).not.toHaveBeenCalled();
    expect(deliverOnce).not.toHaveBeenCalled();
    expect(claimWebhookInteractionRetryAndInsert).not.toHaveBeenCalled();
  });

  it('自動の送り直しを取り掛れないときは予定ありとして断る', async () => {
    vi.mocked(findOutgoingDeliveryByKey).mockResolvedValue(deliveryRow());
    vi.mocked(claimOutgoingDelivery).mockResolvedValue(null);
    await expect(retryWebhookInteraction({} as D1Database, original)).rejects.toThrow('auto_retry_scheduled');
    expect(deliverOnce).not.toHaveBeenCalled();
    expect(claimWebhookInteractionRetryAndInsert).not.toHaveBeenCalled();
  });

  it('自動の送り直しを取り掛かった場合、結果を台帳へ確定する', async () => {
    const delivery = deliveryRow();
    vi.mocked(findOutgoingDeliveryByKey).mockResolvedValue(delivery);
    vi.mocked(claimOutgoingDelivery).mockResolvedValue('lease-1');
    vi.mocked(deliverOnce).mockResolvedValue({ ok: true, attempts: 1, lastStatus: 200 });

    await retryWebhookInteraction({} as D1Database, original);

    expect(claimOutgoingDelivery).toHaveBeenCalledWith(expect.anything(), delivery);
    expect(finishOutgoingDelivery).toHaveBeenCalledWith(
      expect.anything(), delivery, 'lease-1', expect.objectContaining({ kind: 'delivered' }),
    );
    expect(releaseOutgoingDelivery).not.toHaveBeenCalled();
  });

  it('手動送信が失敗したら台帳は残りの自動送り直しへ戻る', async () => {
    const delivery = deliveryRow();
    vi.mocked(findOutgoingDeliveryByKey).mockResolvedValue(delivery);
    vi.mocked(claimOutgoingDelivery).mockResolvedValue('lease-1');
    vi.mocked(deliverOnce).mockResolvedValue({ ok: false, attempts: 1, lastStatus: 503 });

    await retryWebhookInteraction({} as D1Database, original);

    // 5xxは送り直せる失敗なので、台帳は残りの自動送り直し(retry)へ戻る。
    expect(finishOutgoingDelivery).toHaveBeenCalledWith(
      expect.anything(), delivery, 'lease-1', expect.objectContaining({ kind: 'retry', responseStatus: 503 }),
    );
  });

  // ---- d23b : 畳み込み後の緊急停止の再確認 ----

  it('畳み込み後に緊急停止へ切り替わったら送る前の状態へ戻す', async () => {
    vi.mocked(isOperationCapabilityStopped)
      .mockResolvedValueOnce(false)   // 申込時点
      .mockResolvedValueOnce(true);   // 畳み込み後の再確認
    const delivery = deliveryRow();
    vi.mocked(findOutgoingDeliveryByKey).mockResolvedValue(delivery);
    vi.mocked(claimOutgoingDelivery).mockResolvedValue('lease-1');

    await expect(retryWebhookInteraction({} as D1Database, original)).rejects.toThrow('emergency_stopped');

    expect(deliverOnce).not.toHaveBeenCalled();
    // 作ったばかりの再送記録を消し、元の記録を失敗へ戻し、台帳のleaseも外す。
    expect(deletePendingWebhookInteraction).toHaveBeenCalledWith(expect.anything(), 'run-2', 'account-a');
    expect(restoreWebhookInteractionFailure).toHaveBeenCalledWith(expect.anything(), 'run-1', 'account-a');
    expect(releaseOutgoingDelivery).toHaveBeenCalledWith(expect.anything(), delivery, 'lease-1');
  });
});

describe('画面へ出す安全な言葉', () => {
  it('内部の失敗コードを日本語へ置き換える', () => {
    expect(webhookFailureLabel('response_429')).toBe('つなぎ先が混み合っていました');
    expect(webhookFailureLabel('processing_failed')).toBe('受け取った内容を処理できませんでした');
    // d23b : こちら側で一度も送っていない失敗は言葉を分ける。
    expect(webhookFailureLabel('secret_unavailable')).toBe('署名の合言葉を確認できないため、まだ送っていません');
    expect(webhookResponseLabel(original)).toBe('つなぎ先で処理できませんでした');
  });

  // d23d : 試しは照合も実行もしていないので、実処理の
  // 「結びつきました」ではなく試算の結果をそのまま出す。
  const incomingTestRow = (idempotencyKey: string): WebhookInteractionRow => ({
    ...original,
    direction: 'incoming', event_type: 'incoming_webhook.test', status: 'succeeded',
    failure_reason: null, response_status: null, request_body_json: null,
    idempotency_key: idempotencyKey,
  });

  it.each([
    ['matched', '照合できました（試し）'],
    ['ambiguous', '照合候補が複数（試し）'],
    ['not_found', '照合相手なし（試し）'],
    ['invalid', '行動の確認で不備（試し）'],
  ])('試しの結果 %s は実際の試算結果を出す', (outcome, label) => {
    expect(webhookResponseLabel(incomingTestRow(`incoming-test:${outcome}:uuid-1`))).toBe(label);
  });

  it('結果の印が無い古い試し記録は「結びつきました」と言わない', () => {
    expect(webhookResponseLabel(incomingTestRow('plain-uuid')))
      .toBe('受け取りの試し（実行していません）');
  });

  it('実際の受信の記録は従来どおり「結びつきました」', () => {
    expect(webhookResponseLabel({
      ...incomingTestRow('key'), event_type: 'incoming_webhook.custom',
    })).toBe('結びつきました');
  });
});
