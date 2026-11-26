import { describe, expect, test, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const lineClientMocks = vi.hoisted(() => ({
  getProfile: vi.fn(),
  replyMessage: vi.fn(),
  replyMessageWithRequestId: vi.fn(),
  pushMessage: vi.fn(),
}));

// Webhook の境界と初回友だち作成を試すため、DB と LINE の外部依存を差し替える。
vi.mock('@line-crm/db', () => ({
  NOTICE_LINE_ACCOUNT_KEY: 'notice_line_account_id',
  isOperationCapabilityStopped: vi.fn(async () => false),
  upsertFriend: vi.fn(),
  updateFriendFollowStatus: vi.fn(),
  getFriendByLineUserIdForAccount: vi.fn(),
  getFriendById: vi.fn(),
  getPlatformSetting: vi.fn().mockResolvedValue(null),
  consumeStaffLineLinkCode: vi.fn().mockResolvedValue(null),
  getScenarios: vi.fn(),
  enrollFriendInScenario: vi.fn(),
  getScenarioSteps: vi.fn(),
  advanceFriendScenario: vi.fn(),
  completeFriendScenario: vi.fn(),
  upsertChatOnMessage: vi.fn(),
  listLineAccountsWithTenantStatus: vi.fn().mockResolvedValue([]),
  jstNow: vi.fn(),
  computeNextDeliveryAt: vi.fn(),
  resolveStepContent: vi.fn(),
  addTagToFriend: vi.fn(),
  getEntryRouteByRefCode: vi.fn(),
  getMessageTemplateById: vi.fn(),
  getTemplateById: vi.fn(),
  reserveLineWebhookEvent: vi.fn().mockResolvedValue(true),
  markLineWebhookEventSucceeded: vi.fn().mockResolvedValue(undefined),
  markLineWebhookEventFailed: vi.fn().mockResolvedValue(undefined),
  recordFriendAddEvent: vi.fn().mockResolvedValue('friend-add-event-1'),
  captureFriendAddEventAttribution: vi.fn().mockResolvedValue(null),
  markFriendAddEventRouting: vi.fn().mockResolvedValue(undefined),
  claimFriendAddSendRight: vi.fn().mockResolvedValue({ held: true, generation: 1, previousDispatchUnknown: false }),
  touchFriendAddSendClaim: vi.fn().mockResolvedValue(true),
  releaseFriendAddSendRight: vi.fn().mockResolvedValue(undefined),
  recordAnalyticsEvent: vi.fn().mockResolvedValue({ id: 'analytics-event-1' }),
  recordIncomingLineMessage: vi.fn().mockImplementation(async (_db, input) => ({
    id: input.id, inserted: true, isUnsent: false, unsentAt: null,
  })),
  recordLineMessageUnsend: vi.fn().mockResolvedValue(undefined),
  recordAutoReplyHit: vi.fn().mockResolvedValue(undefined),
  reserveAutoReplyEvaluation: vi.fn().mockImplementation(async (_db, input) => ({
    created: true,
    row: {
      id: `evaluation-${input.incomingEventId}`,
      incoming_event_id: input.incomingEventId,
      status: 'received',
      reply_status: 'not_attempted',
    },
  })),
  ensureAutoReplyPublishedVersion: vi.fn().mockResolvedValue({ id: 'version-1' }),
  recordAutoReplyEvaluationDetail: vi.fn().mockResolvedValue(undefined),
  markAutoReplyEvaluationMatched: vi.fn().mockResolvedValue(undefined),
  markAutoReplyEvaluationSkipped: vi.fn().mockResolvedValue(undefined),
  markAutoReplyEvaluationFinished: vi.fn().mockResolvedValue(undefined),
  reserveAutoReplyActionRun: vi.fn().mockResolvedValue({ id: 'action-run-1', acquired: true }),
  finishAutoReplyActionRun: vi.fn().mockResolvedValue(undefined),
  toJstString: vi.fn().mockReturnValue('2026-08-24T12:00:00.000+09:00'),
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

vi.mock('../features/friends/friend-add-routing.js', () => ({
  applyFriendAddRouting: vi.fn().mockResolvedValue({ routed: false, suppressed: false, enrollments: [] }),
}));

vi.mock('../services/activity-mileage.js', () => ({
  awardActivityMileage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/carousel-tap.js', () => ({
  handleCarouselTap: vi.fn().mockResolvedValue({ kind: 'ran', executed: 0 }),
}));

vi.mock('../services/step-delivery.js', () => ({
  buildMessage: vi.fn(),
  expandVariables: vi.fn(),
  resolveMetadata: vi.fn(),
  messageToLogPayload: vi.fn(),
}));

import { verifySignature } from '@line-crm/line-sdk';
import {
  addTagToFriend,
  advanceFriendScenario,
  completeFriendScenario,
  computeNextDeliveryAt,
  enrollFriendInScenario,
  getEntryRouteByRefCode,
  getFriendByLineUserIdForAccount,
  getPlatformSetting,
  consumeStaffLineLinkCode,
  listLineAccountsWithTenantStatus,
  getMessageTemplateById,
  getScenarioSteps,
  getScenarios,
  jstNow,
  reserveLineWebhookEvent,
  resolveStepContent,
  updateFriendFollowStatus,
  upsertChatOnMessage,
  upsertFriend,
  recordFriendAddEvent,
  captureFriendAddEventAttribution,
  markFriendAddEventRouting,
  claimFriendAddSendRight,
  touchFriendAddSendClaim,
  releaseFriendAddSendRight,
  recordAnalyticsEvent,
  recordIncomingLineMessage,
} from '@line-crm/db';
import { fireEvent } from '../services/event-bus.js';
import { handleCarouselTap } from '../services/carousel-tap.js';
import { applyFriendAddRouting } from '../features/friends/friend-add-routing.js';
import { webhook } from './webhook.js';

function setupApp() {
  const app = new Hono();
  app.route('/', webhook);
  return app;
}

const stubDb = {
  prepare: vi.fn(() => ({
    bind: vi.fn(() => ({
      run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
      first: vi.fn().mockResolvedValue(null),
      all: vi.fn().mockResolvedValue({ results: [] }),
    })),
  })),
} as unknown as D1Database;

const baseEnv = {
  DB: stubDb,
  LINE_CHANNEL_SECRET: 'env-default-secret',
  LINE_CHANNEL_ACCESS_TOKEN: 'env-default-token',
} as Record<string, unknown>;

const baseExecutionCtx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
  props: {},
} as unknown as ExecutionContext;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getPlatformSetting).mockResolvedValue(null);
  vi.mocked(consumeStaffLineLinkCode).mockResolvedValue(null);
  vi.mocked(listLineAccountsWithTenantStatus).mockResolvedValue([{id:'account-main',channel_secret:'env-default-secret',channel_access_token:'account-token',is_active:1,tenant_status:'active'} as never]);
});

describe('POST /webhook — friend-add ledger', () => {
  test('再追加と今回リンクをWebhookイベント単位で記録する', async () => {
    vi.mocked(verifySignature).mockResolvedValue(true);
    vi.mocked(listLineAccountsWithTenantStatus).mockResolvedValue([{
      id: 'account-main', channel_secret: 'env-default-secret',
      channel_access_token: 'account-token', is_active: 1, tenant_status: 'active',
    } as never]);
    lineClientMocks.getProfile.mockResolvedValue({ displayName: '田中さん' });
    vi.mocked(upsertFriend).mockResolvedValue({
      id: 'friend-1', line_user_id: 'U-1', line_account_id: 'account-main',
      unfollow_count: 1, created_at: '2026-01-01T00:00:00.000+09:00',
      first_followed_at: '2026-01-01T00:00:00.000+09:00',
    } as never);
    vi.mocked(captureFriendAddEventAttribution).mockResolvedValue({
      refCode: 'summer', entryRouteId: 'route-1',
    });
    vi.mocked(getEntryRouteByRefCode).mockResolvedValue(null);
    vi.mocked(getScenarios).mockResolvedValue([]);

    const waitUntil = vi.fn();
    const response = await setupApp().request('/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Line-Signature': 'x'.repeat(44) },
      body: JSON.stringify({ destination: 'bot', events: [{
        type: 'follow', webhookEventId: 'webhook-follow-1', timestamp: 1787530800000,
        source: { type: 'user', userId: 'U-1' }, replyToken: 'reply-1',
        follow: { isUnblocked: true },
      }] }),
    }, baseEnv, { ...baseExecutionCtx, waitUntil } as ExecutionContext);
    expect(response.status).toBe(200);
    const processing = waitUntil.mock.calls[0]?.[0] as Promise<void>;
    await processing;

    expect(recordFriendAddEvent).toHaveBeenCalledWith(baseEnv.DB, expect.objectContaining({
      lineAccountId: 'account-main', friendId: 'friend-1', webhookEventId: 'webhook-follow-1',
      friendKind: 'returning', isUnblockedHint: true,
    }));
    expect(captureFriendAddEventAttribution).toHaveBeenCalledWith(baseEnv.DB, {
      eventId: 'friend-add-event-1', lineAccountId: 'account-main', friendId: 'friend-1',
    });
    expect(markFriendAddEventRouting).toHaveBeenCalledWith(baseEnv.DB, expect.objectContaining({
      eventId: 'friend-add-event-1', lineAccountId: 'account-main', status: 'partial_failed',
      errorCode: 'send_failed', scenarioEnrollmentId: null, deliveryCount: 0,
    }));
  });
});

describe('通知専用LINEの受信', () => {
  test('検証環境でも通常のメッセージには本番管理画面への案内だけを返し、店舗向け受信箱や自動応答へ渡さない', async () => {
    vi.mocked(verifySignature).mockResolvedValue(true);
    vi.mocked(listLineAccountsWithTenantStatus).mockResolvedValue([{
      id: 'notice-account', role: 'platform_notice', channel_secret: 'notice-secret',
      channel_access_token: 'notice-token', is_active: 1, tenant_status: 'active',
    } as never]);
    const waitUntil = vi.fn();
    const response = await setupApp().request('/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Line-Signature': 'x'.repeat(44) },
      body: JSON.stringify({ destination: 'notice-bot', events: [{
        type: 'message', webhookEventId: 'notice-message-1', timestamp: 1787530800000,
        source: { type: 'user', userId: 'U-notice' }, replyToken: 'reply-notice',
        message: { type: 'text', id: 'line-message-1', text: '問い合わせたいです' },
      }] }),
    }, { ...baseEnv, ADMIN_PUBLIC_URL: 'https://stg-admin.musubo.jp' }, { ...baseExecutionCtx, waitUntil } as ExecutionContext);
    expect(response.status).toBe(200);
    await (waitUntil.mock.calls[0]?.[0] as Promise<void>);
    expect(recordIncomingLineMessage).not.toHaveBeenCalled();
    expect(upsertChatOnMessage).not.toHaveBeenCalled();
    expect(lineClientMocks.replyMessage).toHaveBeenCalledOnce();
    expect(lineClientMocks.replyMessage).toHaveBeenCalledWith('reply-notice', [{
      type: 'text',
      text: 'こちらはmusubo契約者様向けの通知専用LINEです。\nお問い合わせはmusuboの管理画面にログインし、各店舗アカウントの「お問い合わせ」ボタンよりお送りください。\nhttps://admin.musubo.jp\nこのトークに送った内容はお問い合わせとして受け付けていません。',
    }]);
  });

  test('画像を送っても案内を返し、返信トークンがないときは送らない', async () => {
    vi.mocked(verifySignature).mockResolvedValue(true);
    vi.mocked(listLineAccountsWithTenantStatus).mockResolvedValue([{
      id: 'notice-account', role: 'platform_notice', channel_secret: 'notice-secret',
      channel_access_token: 'notice-token', is_active: 1, tenant_status: 'active',
    } as never]);
    const waitUntil = vi.fn();
    const response = await setupApp().request('/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Line-Signature': 'x'.repeat(44) },
      body: JSON.stringify({ destination: 'notice-bot', events: [
        { type: 'message', webhookEventId: 'notice-image-1', timestamp: 1787530800000,
          source: { type: 'user', userId: 'U-notice' }, replyToken: 'reply-image',
          message: { type: 'image', id: 'line-image-1', contentProvider: { type: 'line' } } },
        { type: 'message', webhookEventId: 'notice-image-2', timestamp: 1787530800001,
          source: { type: 'user', userId: 'U-notice' },
          message: { type: 'image', id: 'line-image-2', contentProvider: { type: 'line' } } },
      ] }),
    }, baseEnv, { ...baseExecutionCtx, waitUntil } as ExecutionContext);
    expect(response.status).toBe(200);
    await (waitUntil.mock.calls[0]?.[0] as Promise<void>);
    expect(lineClientMocks.replyMessage).toHaveBeenCalledOnce();
    expect(lineClientMocks.replyMessage).toHaveBeenCalledWith('reply-image', [expect.objectContaining({ type: 'text' })]);
    expect(recordIncomingLineMessage).not.toHaveBeenCalled();
  });

  test('友だち追加だけ記録し、店舗用の友だち追加配信を起動しない', async () => {
    vi.mocked(verifySignature).mockResolvedValue(true);
    vi.mocked(listLineAccountsWithTenantStatus).mockResolvedValue([{
      id: 'notice-account', role: 'platform_notice', channel_secret: 'notice-secret',
      channel_access_token: 'notice-token', is_active: 1, tenant_status: 'active',
    } as never]);
    lineClientMocks.getProfile.mockResolvedValue({ displayName: '通知を受け取る人' });
    vi.mocked(upsertFriend).mockResolvedValue({ id: 'notice-friend', line_account_id: 'notice-account' } as never);
    const waitUntil = vi.fn();
    const response = await setupApp().request('/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Line-Signature': 'x'.repeat(44) },
      body: JSON.stringify({ destination: 'notice-bot', events: [{
        type: 'follow', webhookEventId: 'notice-follow-1', timestamp: 1787530800000,
        source: { type: 'user', userId: 'U-notice' }, replyToken: 'reply-notice',
        follow: { isUnblocked: false },
      }] }),
    }, baseEnv, { ...baseExecutionCtx, waitUntil } as ExecutionContext);
    expect(response.status).toBe(200);
    await (waitUntil.mock.calls[0]?.[0] as Promise<void>);
    expect(updateFriendFollowStatus).toHaveBeenCalledWith(expect.anything(), 'U-notice', true, 'notice-account', expect.any(String));
    expect(recordFriendAddEvent).not.toHaveBeenCalled();
    expect(lineClientMocks.replyMessage).not.toHaveBeenCalled();
  });

  test('6桁の確認コードでは管理画面との紐づけを保つ', async () => {
    vi.mocked(verifySignature).mockResolvedValue(true);
    vi.mocked(listLineAccountsWithTenantStatus).mockResolvedValue([{
      id: 'notice-account', role: 'platform_notice', channel_secret: 'notice-secret',
      channel_access_token: 'notice-token', is_active: 1, tenant_status: 'active',
    } as never]);
    vi.mocked(getPlatformSetting).mockResolvedValue('notice-account');
    vi.mocked(consumeStaffLineLinkCode).mockResolvedValue({ staffId: 'staff-1', staffName: '通知を受け取る人' } as never);
    lineClientMocks.getProfile.mockResolvedValue({ displayName: '通知を受け取る人' });
    vi.mocked(upsertFriend).mockResolvedValue({ id: 'notice-friend', line_account_id: 'notice-account' } as never);
    const waitUntil = vi.fn();
    const response = await setupApp().request('/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Line-Signature': 'x'.repeat(44) },
      body: JSON.stringify({ destination: 'notice-bot', events: [{
        type: 'message', webhookEventId: 'notice-code-1', timestamp: 1787530800000,
        source: { type: 'user', userId: 'U-notice' }, replyToken: 'reply-notice',
        message: { type: 'text', id: 'line-code-1', text: '123456' },
      }] }),
    }, baseEnv, { ...baseExecutionCtx, waitUntil } as ExecutionContext);
    expect(response.status).toBe(200);
    await (waitUntil.mock.calls[0]?.[0] as Promise<void>);
    expect(consumeStaffLineLinkCode).toHaveBeenCalledWith(expect.anything(), { code: '123456', friendId: 'notice-friend' });
    expect(lineClientMocks.replyMessage).toHaveBeenCalledWith('reply-notice', expect.arrayContaining([expect.objectContaining({ type: 'text' })]));
    expect(recordIncomingLineMessage).not.toHaveBeenCalled();
  });
});

describe('POST /webhook — 分析イベント', () => {
  test('友だち解除をWebhookの発生時刻とIDで記録する', async () => {
    vi.mocked(verifySignature).mockResolvedValue(true);
    vi.mocked(listLineAccountsWithTenantStatus).mockResolvedValue([{
      id: 'account-main', channel_secret: 'env-default-secret',
      channel_access_token: 'account-token', is_active: 1, tenant_status: 'active',
    } as never]);
    vi.mocked(getFriendByLineUserIdForAccount).mockResolvedValue({
      id: 'friend-1', line_user_id: 'U-1', line_account_id: 'account-main',
    } as never);
    const waitUntil = vi.fn();

    const response = await setupApp().request('/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Line-Signature': 'x'.repeat(44) },
      body: JSON.stringify({ destination: 'bot', events: [{
        type: 'unfollow', webhookEventId: 'webhook-unfollow-1', timestamp: 1787530800000,
        source: { type: 'user', userId: 'U-1' },
      }] }),
    }, baseEnv, { ...baseExecutionCtx, waitUntil } as ExecutionContext);
    expect(response.status).toBe(200);
    await (waitUntil.mock.calls[0]?.[0] as Promise<void>);

    expect(updateFriendFollowStatus).toHaveBeenCalledWith(
      baseEnv.DB, 'U-1', false, 'account-main', '2026-08-24T12:00:00.000+09:00',
    );
    expect(recordAnalyticsEvent).toHaveBeenCalledWith(baseEnv.DB, {
      lineAccountId: 'account-main',
      friendId: 'friend-1',
      eventType: 'friend_unfollow',
      sourceKind: 'line_webhook',
      sourceId: 'webhook-unfollow-1',
      occurredAt: new Date(1787530800000).toISOString(),
      dimensions: undefined,
    });
  });
});

describe('POST /webhook — 停止中の契約先', () => {
  test('受信メッセージは保存するが返信・自動化を発火しない', async () => {
    vi.mocked(verifySignature).mockResolvedValue(true);
    vi.mocked(listLineAccountsWithTenantStatus).mockResolvedValue([{
      id: 'account-stopped', channel_secret: 'env-default-secret',
      channel_access_token: 'account-token', is_active: 1, tenant_status: 'suspended',
    } as never]);
    vi.mocked(getFriendByLineUserIdForAccount).mockResolvedValue({
      id: 'friend-stopped', line_user_id: 'U-stopped', line_account_id: 'account-stopped',
      is_following: 1,
    } as never);
    const waitUntil = vi.fn();

    const response = await setupApp().request('/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Line-Signature': 'x'.repeat(44) },
      body: JSON.stringify({ destination: 'stopped-destination', events: [{
        type: 'message', webhookEventId: 'stopped-message-1', timestamp: 1787530800000,
        source: { type: 'user', userId: 'U-stopped' }, replyToken: 'reply-stopped',
        message: { id: 'line-message-stopped', type: 'text', text: '問い合わせです' },
      }] }),
    }, baseEnv, { ...baseExecutionCtx, waitUntil } as ExecutionContext);
    expect(response.status).toBe(200);
    await (waitUntil.mock.calls[0]?.[0] as Promise<void>);

    expect(recordIncomingLineMessage).toHaveBeenCalledWith(baseEnv.DB, expect.objectContaining({
      friendId: 'friend-stopped', content: '問い合わせです', lineAccountId: 'account-stopped',
    }));
    expect(upsertChatOnMessage).toHaveBeenCalledWith(baseEnv.DB, 'friend-stopped', '2026-08-24T12:00:00.000+09:00');
    expect(lineClientMocks.replyMessage).not.toHaveBeenCalled();
    expect(lineClientMocks.pushMessage).not.toHaveBeenCalled();
    expect(fireEvent).not.toHaveBeenCalled();
    expect(applyFriendAddRouting).not.toHaveBeenCalled();
    expect(handleCarouselTap).not.toHaveBeenCalled();
  });
});

describe('POST /webhook — DoS defenses (#104)', () => {
  test('rejects with 413 when Content-Length declares an oversized body', async () => {
    const app = setupApp();
    const res = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(2 * 1024 * 1024), // 2 MiB > 1 MiB cap
          'X-Line-Signature': 'whatever',
        },
        body: JSON.stringify({ destination: 'bot', events: [] }),
      },
      baseEnv,
      baseExecutionCtx,
    );
    expect(res.status).toBe(413);
    // 上限超過の本文では、署名検証まで実行しない。
    expect(verifySignature).not.toHaveBeenCalled();
  });

  test('rejects with 413 when actual body exceeds the cap even if Content-Length is absent', async () => {
    const app = setupApp();
    const oversizedBody = 'x'.repeat(1024 * 1024 + 1);
    const res = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Line-Signature': 'whatever',
        },
        body: oversizedBody,
      },
      baseEnv,
      baseExecutionCtx,
    );
    expect(res.status).toBe(413);
    expect(verifySignature).not.toHaveBeenCalled();
  });

  test('verifies signature before parsing JSON — malformed body with invalid signature never reaches the parser', async () => {
    vi.mocked(verifySignature).mockResolvedValue(false);

    const app = setupApp();
    // 長さは正しい署名と壊れた JSON を使い、JSON 解析より先に署名が拒まれることを確かめる。
    const validShapedSignature = 'A'.repeat(43) + '=';
    const res = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Line-Signature': validShapedSignature,
        },
        body: '{not valid json',
      },
      baseEnv,
      baseExecutionCtx,
    );
    expect(res.status).toBe(200);
    // 署名の拒否は JSON 解析より先に起きる。
    expect(verifySignature).toHaveBeenCalled();
    expect(verifySignature).toHaveBeenCalledWith('env-default-secret', '{not valid json', validShapedSignature);
  });

  test('rejects unsigned or malformed-signature requests without hitting verifySignature or D1', async () => {
    const app = setupApp();
    const res = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Missing X-Line-Signature header entirely.
        },
        body: JSON.stringify({ destination: 'bot', events: [] }),
      },
      baseEnv,
      baseExecutionCtx,
    );
    expect(res.status).toBe(200);
    // 不正形は暗号処理・DB より前に拒む。
    expect(verifySignature).not.toHaveBeenCalled();
  });

  test('台帳の初回記録が失敗しても再試行し、LINEへの応答は200のまま', async () => {
    vi.mocked(verifySignature).mockResolvedValue(true);
    vi.mocked(reserveLineWebhookEvent).mockRejectedValueOnce(new Error('raw database details'));
    const executionCtx = {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
      props: {},
    } as unknown as ExecutionContext;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const res = await setupApp().request(
      '/webhook',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Line-Signature': 'A'.repeat(43) + '=',
        },
        body: JSON.stringify({
          destination: 'bot',
          events: [{
            type: 'unfollow',
            timestamp: 0,
            source: { type: 'user', userId: 'U-sensitive' },
            webhookEventId: 'evt-ledger-failure',
            deliveryContext: { isRedelivery: false },
            mode: 'active',
          }],
        }),
      },
      baseEnv,
      executionCtx,
    );

    expect(res.status).toBe(200);
    const processing = vi.mocked(executionCtx.waitUntil).mock.calls[0]?.[0] as Promise<unknown>;
    await expect(processing).resolves.toBeUndefined();
    expect(reserveLineWebhookEvent).toHaveBeenCalledTimes(2);
    expect(updateFriendFollowStatus).toHaveBeenCalledOnce();
    const output = JSON.stringify(errorSpy.mock.calls);
    expect(output).not.toContain('raw database details');
    expect(output).not.toContain('U-sensitive');
    errorSpy.mockRestore();
  });
});

describe('POST /webhook — postback events', () => {
  test('records a carousel tap without firing catch-all automations', async () => {
    vi.mocked(verifySignature).mockResolvedValue(true);
    vi.mocked(listLineAccountsWithTenantStatus).mockResolvedValue([{
      id: 'account-main', channel_secret: 'env-default-secret',
      channel_access_token: 'account-token', is_active: 1, tenant_status: 'active',
    } as never]);
    vi.mocked(getFriendByLineUserIdForAccount).mockResolvedValue({
      id: 'friend-1', line_user_id: 'U-existing', line_account_id: 'account-main',
    } as never);
    const waitUntil = vi.fn();
    const timestamp = 1787530800000;

    const response = await setupApp().request('/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Line-Signature': 'x'.repeat(44) },
      body: JSON.stringify({ destination: 'bot', events: [{
        type: 'postback',
        replyToken: 'reply-token-carousel',
        postback: { data: 'ctpl=template-1&c=0&a=1' },
        timestamp,
        source: { type: 'user', userId: 'U-existing' },
        webhookEventId: 'event-carousel-1',
        deliveryContext: { isRedelivery: false },
        mode: 'active',
      }] }),
    }, baseEnv, { ...baseExecutionCtx, waitUntil } as ExecutionContext);

    expect(response.status).toBe(200);
    await (waitUntil.mock.calls[0]?.[0] as Promise<void>);
    expect(handleCarouselTap).toHaveBeenCalledOnce();
    expect(recordAnalyticsEvent).toHaveBeenCalledWith(baseEnv.DB, {
      lineAccountId: 'account-main',
      friendId: 'friend-1',
      eventType: 'postback_received',
      sourceKind: 'line_webhook',
      sourceId: 'event-carousel-1',
      occurredAt: new Date(timestamp).toISOString(),
      dimensions: { matched: true },
    });
    expect(fireEvent).not.toHaveBeenCalled();
  });

  test('fires postback_received with postback.data so IF-THEN automations run on rich menu taps', async () => {
    vi.mocked(verifySignature).mockResolvedValue(true);
    vi.mocked(jstNow).mockReturnValue('2026-07-19T12:00:00.000+09:00');
    vi.mocked(getFriendByLineUserIdForAccount).mockResolvedValue({
      id: 'friend-1',
      line_user_id: 'U-existing',
      display_name: 'Existing Friend',
      picture_url: null,
      status_message: null,
      is_following: 1,
      user_id: null,
      line_account_id: 'account-main',
      metadata: '{}',
      first_tracked_link_id: null,
      created_at: '2026-07-19T12:00:00.000+09:00',
      updated_at: '2026-07-19T12:00:00.000+09:00',
    });

    const stmt = {
      bind: vi.fn(),
      first: vi.fn().mockResolvedValue(null),
      run: vi.fn().mockResolvedValue({}),
      all: vi.fn().mockResolvedValue({ results: [] }), // no auto_reply match
    };
    stmt.bind.mockReturnValue(stmt);
    const db = { prepare: vi.fn().mockReturnValue(stmt) } as unknown as D1Database;

    const executionCtx = {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
      props: {},
    } as unknown as ExecutionContext;

    const app = setupApp();
    const validShapedSignature = 'A'.repeat(43) + '=';
    const res = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Line-Signature': validShapedSignature,
        },
        body: JSON.stringify({
          destination: 'bot',
          events: [
            {
              type: 'postback',
              replyToken: 'reply-token-postback',
              postback: { data: 'tag:premium' },
              timestamp: Date.now(),
              source: { type: 'user', userId: 'U-existing' },
              webhookEventId: 'event-postback-1',
              deliveryContext: { isRedelivery: false },
              mode: 'active',
            },
          ],
        }),
      },
      { ...baseEnv, DB: db },
      executionCtx,
    );

    expect(res.status).toBe(200);
    const processing = vi.mocked(executionCtx.waitUntil).mock.calls[0]?.[0] as Promise<unknown>;
    await processing;

    // 自動返信が使わなかった replyToken をイベントへ渡し、自動化の無料返信に使えるようにする。
    expect(fireEvent).toHaveBeenCalledWith(
      db,
      'postback_received',
      {
        sourceEventId: 'event-postback-1',
        sourceKind: 'line_webhook',
        occurredAt: expect.any(String),
        friendId: 'friend-1',
        eventData: { text: 'tag:premium', matched: false },
        replyToken: 'reply-token-postback',
      },
      'account-token',
      'account-main',
      expect.objectContaining({sourceEventId:expect.any(String)}),
    );
    expect(lineClientMocks.replyMessage).not.toHaveBeenCalled();
  });

  test('silent auto-reply rule suppresses the reply but still fires postback_received as matched', async () => {
    vi.mocked(verifySignature).mockResolvedValue(true);
    vi.mocked(jstNow).mockReturnValue('2026-07-19T12:00:00.000+09:00');
    vi.mocked(getFriendByLineUserIdForAccount).mockResolvedValue({
      id: 'friend-1',
      line_user_id: 'U-existing',
      display_name: 'Existing Friend',
      picture_url: null,
      status_message: null,
      is_following: 1,
      user_id: null,
      line_account_id: 'account-main',
      metadata: '{}',
      first_tracked_link_id: null,
      created_at: '2026-07-19T12:00:00.000+09:00',
      updated_at: '2026-07-19T12:00:00.000+09:00',
    });

    const stmt = {
      bind: vi.fn(),
      first: vi.fn().mockResolvedValue(null),
      run: vi.fn().mockResolvedValue({}),
      all: vi.fn().mockResolvedValue({
        results: [
          {
            id: 'rule-1',
            keyword: 'tag:premium',
            match_type: 'exact',
            response_type: 'silent',
            response_content: '',
            template_id: null,
          },
        ],
      }),
    };
    stmt.bind.mockReturnValue(stmt);
    const db = { prepare: vi.fn().mockReturnValue(stmt) } as unknown as D1Database;

    const executionCtx = {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
      props: {},
    } as unknown as ExecutionContext;

    const app = setupApp();
    const validShapedSignature = 'A'.repeat(43) + '=';
    const res = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Line-Signature': validShapedSignature,
        },
        body: JSON.stringify({
          destination: 'bot',
          events: [
            {
              type: 'postback',
              replyToken: 'reply-token-postback',
              postback: { data: 'tag:premium' },
              timestamp: Date.now(),
              source: { type: 'user', userId: 'U-existing' },
              webhookEventId: 'event-postback-2',
              deliveryContext: { isRedelivery: false },
              mode: 'active',
            },
          ],
        }),
      },
      { ...baseEnv, DB: db },
      executionCtx,
    );

    expect(res.status).toBe(200);
    const processing = vi.mocked(executionCtx.waitUntil).mock.calls[0]?.[0] as Promise<unknown>;
    await processing;

    // 無言ルールでも未消費の replyToken はイベントへ渡し、タグ付与などの後続操作で利用できるようにする。
    expect(lineClientMocks.replyMessage).not.toHaveBeenCalled();
    expect(fireEvent).toHaveBeenCalledWith(
      db,
      'postback_received',
      {
        sourceEventId: 'event-postback-2',
        sourceKind: 'line_webhook',
        occurredAt: expect.any(String),
        friendId: 'friend-1',
        eventData: { text: 'tag:premium', matched: true },
        replyToken: 'reply-token-postback',
      },
      'account-token',
      'account-main',
      expect.objectContaining({sourceEventId:expect.any(String)}),
    );
  });
});

describe('POST /webhook — first-contact existing friends', () => {
  test('auto-registers an unknown text-message sender without firing friend_add handling', async () => {
    vi.mocked(verifySignature).mockResolvedValue(true);
    vi.mocked(listLineAccountsWithTenantStatus).mockResolvedValue([{
      id: 'account-main',
      is_active: 1, tenant_status: 'active',
      channel_secret: 'env-default-secret',
      channel_access_token: 'env-default-token',
    }] as never);
    vi.mocked(getFriendByLineUserIdForAccount).mockResolvedValue(null);
    vi.mocked(jstNow).mockReturnValue('2026-06-18T12:00:00.000+09:00');
    lineClientMocks.getProfile.mockResolvedValue({
      userId: 'U-existing',
      displayName: 'Existing Friend',
      pictureUrl: 'https://example.com/profile.jpg',
      statusMessage: 'hello',
    });
    vi.mocked(upsertFriend).mockResolvedValue({
      id: 'friend-1',
      line_user_id: 'U-existing',
      display_name: 'Existing Friend',
      picture_url: 'https://example.com/profile.jpg',
      status_message: 'hello',
      is_following: 1,
      user_id: null,
      line_account_id: 'account-main',
      metadata: '{}',
      first_tracked_link_id: null,
      created_at: '2026-06-18T12:00:00.000+09:00',
      updated_at: '2026-06-18T12:00:00.000+09:00',
    });
    vi.mocked(upsertChatOnMessage).mockResolvedValue({
      id: 'chat-1',
      friend_id: 'friend-1',
      operator_id: null,
      status: 'unread',
      notes: null,
      last_message_at: '2026-06-18T12:00:00.000+09:00',
      created_at: '2026-06-18T12:00:00.000+09:00',
      updated_at: '2026-06-18T12:00:00.000+09:00',
    });

    const stmt = {
      bind: vi.fn(),
      run: vi.fn().mockResolvedValue({}),
      all: vi.fn().mockResolvedValue({ results: [] }),
      first: vi.fn().mockResolvedValue(null),
    };
    stmt.bind.mockReturnValue(stmt);
    const db = { prepare: vi.fn().mockReturnValue(stmt) } as unknown as D1Database;

    const executionCtx = {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
      props: {},
    } as unknown as ExecutionContext;

    const app = setupApp();
    const validShapedSignature = 'A'.repeat(43) + '=';
    const res = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Line-Signature': validShapedSignature,
        },
        body: JSON.stringify({
          destination: 'bot',
          events: [
            {
              type: 'message',
              replyToken: 'reply-token',
              message: { type: 'text', id: 'message-1', text: 'こんにちは' },
              timestamp: Date.now(),
              source: { type: 'user', userId: 'U-existing' },
              webhookEventId: 'event-1',
              deliveryContext: { isRedelivery: false },
              mode: 'active',
            },
          ],
        }),
      },
      { ...baseEnv, DB: db },
      executionCtx,
    );

    expect(res.status).toBe(200);
    const processing = vi.mocked(executionCtx.waitUntil).mock.calls[0]?.[0] as Promise<unknown>;
    await processing;

    expect(getFriendByLineUserIdForAccount).toHaveBeenCalledWith(
      db,
      'U-existing',
      'account-main',
    );
    expect(lineClientMocks.getProfile).toHaveBeenCalledWith('U-existing');
    expect(upsertFriend).toHaveBeenCalledWith(db, {
      lineUserId: 'U-existing',
      lineAccountId: 'account-main',
      followOccurredAt: '2026-08-24T12:00:00.000+09:00',
      displayName: 'Existing Friend',
      pictureUrl: 'https://example.com/profile.jpg',
      statusMessage: 'hello',
    });
    expect(upsertChatOnMessage).toHaveBeenCalledWith(db, 'friend-1', '2026-08-24T12:00:00.000+09:00');
    expect(fireEvent).toHaveBeenCalledWith(
      db,
      'message_received',
      expect.objectContaining({ friendId: 'friend-1' }),
      'env-default-token',
      'account-main',
      expect.objectContaining({sourceEventId:'event-1'}),
    );
    expect(getScenarios).not.toHaveBeenCalled();
    expect(enrollFriendInScenario).not.toHaveBeenCalled();

    // 関係しない DB の差替も、import した型の検査は維持する。
    expect(updateFriendFollowStatus).not.toHaveBeenCalled();
    expect(getScenarioSteps).not.toHaveBeenCalled();
    expect(advanceFriendScenario).not.toHaveBeenCalled();
    expect(completeFriendScenario).not.toHaveBeenCalled();
    expect(computeNextDeliveryAt).not.toHaveBeenCalled();
    expect(resolveStepContent).not.toHaveBeenCalled();
    expect(addTagToFriend).not.toHaveBeenCalled();
    expect(getEntryRouteByRefCode).not.toHaveBeenCalled();
    expect(getMessageTemplateById).not.toHaveBeenCalled();
  });
});

describe('POST /webhook — friend-add抑止理由の台帳記録 (#622)', () => {
  async function sendFollowWithRouting(routing: unknown) {
    vi.mocked(verifySignature).mockResolvedValue(true);
    vi.mocked(listLineAccountsWithTenantStatus).mockResolvedValue([{
      id: 'account-main', channel_secret: 'env-default-secret',
      channel_access_token: 'account-token', is_active: 1, tenant_status: 'active',
    } as never]);
    lineClientMocks.getProfile.mockResolvedValue({ displayName: '田中さん' });
    vi.mocked(upsertFriend).mockResolvedValue({
      id: 'friend-1', line_user_id: 'U-1', line_account_id: 'account-main',
      unfollow_count: 1, created_at: '2026-01-01T00:00:00.000+09:00',
      first_followed_at: '2026-01-01T00:00:00.000+09:00',
    } as never);
    vi.mocked(captureFriendAddEventAttribution).mockResolvedValue(null);
    vi.mocked(getEntryRouteByRefCode).mockResolvedValue(null);
    vi.mocked(getScenarios).mockResolvedValue([]);
    vi.mocked(applyFriendAddRouting).mockResolvedValue(routing as never);

    const waitUntil = vi.fn();
    const response = await setupApp().request('/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Line-Signature': 'x'.repeat(44) },
      body: JSON.stringify({ destination: 'bot', events: [{
        type: 'follow', webhookEventId: 'webhook-follow-1', timestamp: 1787530800000,
        source: { type: 'user', userId: 'U-1' }, replyToken: 'reply-1',
        follow: { isUnblocked: false },
      }] }),
    }, baseEnv, { ...baseExecutionCtx, waitUntil } as ExecutionContext);
    expect(response.status).toBe(200);
    await (waitUntil.mock.calls[0]?.[0] as Promise<void>);
  }

  const suppressedCases = [
    'outside_weekday',
    'outside_time_window',
    'friend_condition_not_met',
    'friend_condition_unreadable',
    'resend_suppressed',
    'delivery_disabled',
  ] as const;

  test.each(suppressedCases)('抑止時は status=suppressed と理由 %s を error_code へ記録する', async (reason) => {
    await sendFollowWithRouting({
      routed: true, kind: 'returning', enrollments: [], timing: 'immediate',
      suppressed: true, suppressReason: reason, ruleId: 'rule-1', ruleVersionId: 'rule-1-v1',
    });
    expect(markFriendAddEventRouting).toHaveBeenCalledWith(baseEnv.DB, expect.objectContaining({
      eventId: 'friend-add-event-1', lineAccountId: 'account-main',
      status: 'suppressed', errorCode: reason,
    }));
  });

  test('送れなかったときは completed にせず partial_failed と send_failed を記録する', async () => {
    await sendFollowWithRouting({
      routed: true, kind: 'returning', enrollments: [], timing: 'immediate',
      suppressed: false, suppressReason: null, ruleId: 'rule-1', ruleVersionId: 'rule-1-v1',
    });
    expect(markFriendAddEventRouting).toHaveBeenCalledWith(baseEnv.DB, expect.objectContaining({
      eventId: 'friend-add-event-1', lineAccountId: 'account-main',
      status: 'partial_failed', errorCode: 'send_failed', deliveryCount: 0,
    }));
  });

  test('処理も送信も失敗したときは、処理再試行後に戻す送信結果を同時に記録する', async () => {
    await sendFollowWithRouting({
      routed: true, kind: 'returning', enrollments: [], timing: 'immediate',
      suppressed: false, suppressReason: null, ruleId: 'rule-1', ruleVersionId: 'rule-1-v1',
      actionFailureCount: 1,
    });
    expect(markFriendAddEventRouting).toHaveBeenCalledWith(baseEnv.DB, expect.objectContaining({
      eventId: 'friend-add-event-1', lineAccountId: 'account-main',
      status: 'partial_failed', errorCode: 'action_failed', deliveryCount: 0,
      actionBaseStatus: 'partial_failed', actionBaseErrorCode: 'send_failed',
    }));
  });

  test('設定なしの受け皿経路で送れなかったときも partial_failed にする', async () => {
    await sendFollowWithRouting({ routed: false, suppressed: false, enrollments: [] });
    expect(markFriendAddEventRouting).toHaveBeenCalledWith(baseEnv.DB, expect.objectContaining({
      eventId: 'friend-add-event-1', lineAccountId: 'account-main',
      status: 'partial_failed', errorCode: 'send_failed', deliveryCount: 0,
    }));
  });

  test('送信権を取れなかった実行は送らず duplicate_in_flight で引く', async () => {
    vi.mocked(claimFriendAddSendRight).mockResolvedValueOnce({ held: false, generation: 0, previousDispatchUnknown: false });
    await sendFollowWithRouting({
      routed: true, kind: 'first_time',
      enrollments: [{ scenarioId: 'scenario-1', enrollment: { id: 'enrollment-1' }, resumed: false }],
      timing: 'immediate', suppressed: false, suppressReason: null,
      ruleId: 'rule-1', ruleVersionId: 'rule-1-v1',
    });
    expect(markFriendAddEventRouting).toHaveBeenCalledWith(baseEnv.DB, expect.objectContaining({
      eventId: 'friend-add-event-1', lineAccountId: 'account-main',
      status: 'partial_failed', errorCode: 'duplicate_in_flight', deliveryCount: 0,
    }));
    expect(releaseFriendAddSendRight).not.toHaveBeenCalled();
  });

  test('送信権の予約に失敗したら送らず send_claim_unavailable で残す', async () => {
    vi.mocked(claimFriendAddSendRight).mockRejectedValueOnce(new Error('db down'));
    await sendFollowWithRouting({
      routed: true, kind: 'returning',
      enrollments: [{ scenarioId: 'scenario-1', enrollment: { id: 'enrollment-1' }, resumed: false }],
      timing: 'immediate', suppressed: false, suppressReason: null,
      ruleId: 'rule-1', ruleVersionId: 'rule-1-v1',
    });
    expect(markFriendAddEventRouting).toHaveBeenCalledWith(baseEnv.DB, expect.objectContaining({
      eventId: 'friend-add-event-1', lineAccountId: 'account-main',
      status: 'partial_failed', errorCode: 'send_claim_unavailable', deliveryCount: 0,
    }));
  });

  test('回収で旧持ち主になったら送信も確定もしない', async () => {
    vi.mocked(touchFriendAddSendClaim).mockResolvedValueOnce(false);
    await sendFollowWithRouting({
      routed: true, kind: 'returning',
      enrollments: [{ scenarioId: 'scenario-1', enrollment: { id: 'enrollment-1' }, resumed: false }],
      timing: 'immediate', suppressed: false, suppressReason: null,
      ruleId: 'rule-1', ruleVersionId: 'rule-1-v1',
    });
    expect(markFriendAddEventRouting).not.toHaveBeenCalled();
    expect(releaseFriendAddSendRight).not.toHaveBeenCalled();
  });
});

vi.mock('../services/line-webhook-events.js',async()=>{
 const {unitLineEvents}=await import('../test-utils/workflow-unit.js');const ledger=await import('@line-crm/db');
 const actual=await vi.importActual<typeof import('../services/line-webhook-events.js')>('../services/line-webhook-events.js');
 return {...actual,processLineWebhookEvents:(input:any)=>unitLineEvents(input,ledger as any)};
});
vi.mock('../services/workflow-line-client.js',()=>({workflowLineClient:(client:any)=>client}));

test('SEC-04 env署名が正しくても受信店が不明なら友だちを変更しない',async()=>{
 vi.mocked(verifySignature).mockResolvedValue(true);
 vi.mocked(listLineAccountsWithTenantStatus).mockResolvedValue([]);
 const pending:Promise<unknown>[]=[];
 const res=await setupApp().request('/webhook',{method:'POST',headers:{'X-Line-Signature':'s'.repeat(44),'Content-Type':'application/json'},body:JSON.stringify({destination:'unknown',events:[{type:'unfollow',timestamp:Date.now(),source:{type:'user',userId:'U-other'}}]})},baseEnv,{...baseExecutionCtx,waitUntil:(p:Promise<unknown>)=>pending.push(p)});
 await Promise.all(pending);expect(res.status).toBe(200);expect(getFriendByLineUserIdForAccount).not.toHaveBeenCalled();expect(updateFriendFollowStatus).not.toHaveBeenCalled();
});
