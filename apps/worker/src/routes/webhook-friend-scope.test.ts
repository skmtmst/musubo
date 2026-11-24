import { describe, expect, test, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const lineClientMocks = vi.hoisted(() => ({
  getProfile: vi.fn(),
  replyMessage: vi.fn(),
  replyMessageWithRequestId: vi.fn(),
  pushMessage: vi.fn(),
}));

// 受信アカウントに該当する friend 行が無く、同一 line_user_id の
// 行が別アカウントに属するとき、webhook は相手の行を移動せず・混線した履歴を
// 作らず・イベントを静かに諦めることを証明する。
vi.mock('@line-crm/db', () => ({
  upsertFriend: vi.fn(),
  updateFriendFollowStatus: vi.fn(),
  getFriendByLineUserIdForAccount: vi.fn(),
  getFriendById: vi.fn(),
  getScenarios: vi.fn(),
  enrollFriendInScenario: vi.fn(),
  getScenarioSteps: vi.fn(),
  advanceFriendScenario: vi.fn(),
  completeFriendScenario: vi.fn(),
  upsertChatOnMessage: vi.fn(),
  listLineAccountsWithTenantStatus: vi.fn().mockResolvedValue([]),
  jstNow: vi.fn().mockReturnValue('2026-08-24T12:00:00.000+09:00'),
  computeNextDeliveryAt: vi.fn(),
  resolveStepContent: vi.fn(),
  addTagToFriend: vi.fn(),
  getEntryRouteByRefCode: vi.fn(),
  getMessageTemplateById: vi.fn(),
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
  reserveAutoReplyEvaluation: vi.fn().mockResolvedValue({ created: true, row: { id: 'evaluation-1' } }),
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
  getFriendByLineUserIdForAccount,
  listLineAccountsWithTenantStatus,
  markLineWebhookEventSucceeded,
  recordFriendAddEvent,
  recordIncomingLineMessage,
  upsertFriend,
} from '@line-crm/db';
import { webhook } from './webhook.js';

// friends.line_user_id のグローバル UNIQUE 違反 = 別アカウント所有の行が占有。
const SCOPE_CONFLICT = new Error('UNIQUE constraint failed: friends.line_user_id');

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

function setupApp() {
  const app = new Hono();
  app.route('/', webhook);
  return app;
}

async function postWebhook(events: unknown[]) {
  const waitUntil = vi.fn();
  const response = await setupApp().request(
    '/webhook',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Line-Signature': 'x'.repeat(44) },
      body: JSON.stringify({ destination: 'bot', events }),
    },
    baseEnv,
    {
      waitUntil,
      passThroughOnException: vi.fn(),
      props: {},
    } as unknown as ExecutionContext,
  );
  const processing = waitUntil.mock.calls[0]?.[0] as Promise<void> | undefined;
  await processing;
  return response;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(verifySignature).mockResolvedValue(true);
  // 受信はアカウントA。同一 line_user_id の行はアカウントBにのみ存在する想定。
  vi.mocked(listLineAccountsWithTenantStatus).mockResolvedValue([
    {
      id: 'account-a',
      channel_secret: 'env-default-secret',
      channel_access_token: 'account-a-token',
      is_active: 1, tenant_status: 'active',
    } as never,
  ]);
});

describe('POST /webhook — Issue #961 別アカウント所有の friend 行への混線防止', () => {
  test('テキスト受信: 別アカウント所有の行しか無い場合、履歴を作らずイベントを正常完了する', async () => {
    // アカウントAのスコープには行が無い
    vi.mocked(getFriendByLineUserIdForAccount).mockResolvedValue(null);
    lineClientMocks.getProfile.mockResolvedValue({ displayName: '別アカの人' });
    // friends.line_user_id はグローバルUNIQUE → B所有の行があるとA用の行は作れない
    vi.mocked(upsertFriend).mockRejectedValue(SCOPE_CONFLICT);

    const response = await postWebhook([
      {
        type: 'message',
        webhookEventId: 'webhook-scope-msg-1',
        timestamp: 1787530800000,
        source: { type: 'user', userId: 'U-shared' },
        replyToken: 'reply-1',
        message: { id: 'msg-1', type: 'text', text: 'こんにちは' },
      },
    ]);

    expect(response.status).toBe(200);
    // friend 行が無いまま諦めるので、受信履歴・自動応答評価・chat は一切作らない
    expect(recordIncomingLineMessage).not.toHaveBeenCalled();
    // 例外ではなく握り潰して処理完了扱い（LINE 再送・失敗台帳を汚さない）
    expect(markLineWebhookEventSucceeded).toHaveBeenCalled();
  });

  test('テキスト受信: 未割当を別アカウントが先に引き当て、旧制約で新規登録できないときは他店に履歴を作らない', async () => {
    vi.mocked(getFriendByLineUserIdForAccount)
      .mockResolvedValueOnce({ id: 'friend-unassigned', line_account_id: null } as never)
      .mockResolvedValueOnce(null);
    vi.mocked(upsertFriend).mockRejectedValue(SCOPE_CONFLICT);

    const response = await postWebhook([{
      type: 'message',
      webhookEventId: 'webhook-scope-adoption-race',
      timestamp: 1787530800000,
      source: { type: 'user', userId: 'U-shared' },
      message: { id: 'msg-race', type: 'text', text: '接続テスト' },
    }]);

    expect(response.status).toBe(200);
    expect(stubDb.prepare).toHaveBeenCalledWith(expect.stringContaining('WHERE id = ? AND line_account_id IS NULL'));
    expect(getFriendByLineUserIdForAccount).toHaveBeenCalledTimes(2);
    expect(upsertFriend).toHaveBeenCalledExactlyOnceWith(stubDb, expect.objectContaining({ lineUserId: 'U-shared', lineAccountId: 'account-a' }));
    expect(recordIncomingLineMessage).not.toHaveBeenCalled();
  });

  test('フォロー受信: 別アカウント所有の行しか無い場合、friend_add 台帳・通知を作らない', async () => {
    lineClientMocks.getProfile.mockResolvedValue({ displayName: '別アカの人' });
    vi.mocked(upsertFriend).mockRejectedValue(SCOPE_CONFLICT);

    const response = await postWebhook([
      {
        type: 'follow',
        webhookEventId: 'webhook-scope-follow-1',
        timestamp: 1787530800000,
        source: { type: 'user', userId: 'U-shared' },
        replyToken: 'reply-1',
      },
    ]);

    expect(response.status).toBe(200);
    // 「friend=B・送信元=A」の友だち追加台帳・通知が作られない
    expect(recordFriendAddEvent).not.toHaveBeenCalled();
    expect(markLineWebhookEventSucceeded).toHaveBeenCalled();
  });
});

vi.mock('../services/line-webhook-events.js',async()=>{
 const {unitLineEvents}=await import('../test-utils/workflow-unit.js');const ledger=await import('@line-crm/db');
 const actual=await vi.importActual<typeof import('../services/line-webhook-events.js')>('../services/line-webhook-events.js');
 return {...actual,processLineWebhookEvents:(input:any)=>unitLineEvents(input,ledger as any)};
});
vi.mock('../services/workflow-line-client.js',()=>({workflowLineClient:(client:any)=>client}));
