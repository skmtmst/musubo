import { createTestD1,type SqliteD1 } from '../test-utils/d1-sqlite.js';
import { signIncomingTest, receiveAndDrain } from '../test-utils/incoming-webhook-request.js';
import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';

vi.mock('@line-crm/db', async (importOriginal) => {
  // 発火種別の正本リストと判定は純粋関数なので実物を通す。
  const actual = await importOriginal<typeof import('@line-crm/db')>();
  return {
  encryptCredential:actual.encryptCredential,
  decryptCredential:actual.decryptCredential,
  KNOWN_OUTGOING_EVENT_TYPES: actual.KNOWN_OUTGOING_EVENT_TYPES,
  isKnownOutgoingEventType: actual.isKnownOutgoingEventType,
  // フォルダの所属が正しくないときの誤り（instanceof で見分けるので実物を通す）。
  FolderAssignmentError: actual.FolderAssignmentError,
  // 緊急停止の判定。個別の試験で立てる場合は mockResolvedValue で差し替える。
  isOperationCapabilityStopped: vi.fn(async () => false),
  getIncomingWebhooks: vi.fn(),
  getIncomingWebhookById: vi.fn(),
  createIncomingWebhook: vi.fn(),
  updateIncomingWebhook: vi.fn(),
  deleteIncomingWebhook: vi.fn(),
  getOutgoingWebhooks: vi.fn(),
  getOutgoingWebhookById: vi.fn(),
  createOutgoingWebhook: vi.fn(),
  updateOutgoingWebhook: vi.fn(),
  deleteOutgoingWebhook: vi.fn(),
  createWebhookInteraction: vi.fn(),
  finishWebhookInteraction: vi.fn(),
  getWebhookInteractionById: vi.fn(),
  listFailedWebhookInteractionsForRetry: vi.fn(),
  countFailedWebhookInteractionsForRetry: vi.fn().mockResolvedValue(0),
  // 結果不明の失敗件数(まとめて再送しない対象)。
  countUnverifiedWebhookInteractions: vi.fn().mockResolvedValue(0),
  // d23b : まとめて再送の対象外に残った件数(消えた・止まった送り先等)。
  countExcludedFailedWebhookInteractions: vi.fn().mockResolvedValue(0),
  listWebhookInteractions: vi.fn(),
  getOutgoingWebhookDeliverySummaries: vi.fn(),
  updateIncomingWebhookConfig: vi.fn(),
  updateIncomingWebhookMaskedSample: vi.fn(),
  backfillWebhookSecrets: vi.fn(),
  // 未照合の箱と公開APIトークンの台帳。
  listIncomingWebhookUnmatched: vi.fn().mockResolvedValue([]),
  countIncomingWebhookUnmatched: vi.fn().mockResolvedValue(0),
  getIncomingWebhookUnmatchedById: vi.fn(),
  resolveIncomingWebhookUnmatched: vi.fn(),
  listIntegrationApiTokens: vi.fn().mockResolvedValue([]),
  getIntegrationApiTokenById: vi.fn(),
  createIntegrationApiToken: vi.fn(),
  revokeIntegrationApiToken: vi.fn(),
  rotateIntegrationApiToken: vi.fn(),
  INTEGRATION_API_SCOPES: actual.INTEGRATION_API_SCOPES,
  hasWebhookSecret: vi.fn((row: { secret?: unknown; secret_encrypted?: unknown }) =>
    Boolean(row?.secret_encrypted) ||
    (typeof row?.secret === 'string' && row.secret.length >= 32)),
  resolveWebhookSecret: vi.fn(async (row: { secret?: unknown; secret_encrypted?: unknown }) => {
    if (typeof row?.secret_encrypted === 'string') {
      if (row.secret_encrypted.startsWith('v1-broken')) throw new Error('Unable to decrypt webhook secret');
      return 'r'.repeat(32);
    }
    return (row?.secret as string | null) ?? null;
  }),
  // 前の合言葉の併用。個別の試験で立てる場合は mockResolvedValue で差し替える。
  resolvePreviousWebhookSecret: vi.fn(async () => null),
  WEBHOOK_SECRET_PREVIOUS_GRACE_MS: actual.WEBHOOK_SECRET_PREVIOUS_GRACE_MS,
  WEBHOOK_SECRET_MIN_LENGTH: 32,
  // 秘密の値の登録・APIトークン操作は直前の再確認が必要。ここでは
  // 入力検証を見たいので、再確認済みとして通す。
  consumeStepUpGrant: vi.fn(async () => true),
  getAdminSessionByTokenHash: vi.fn(async () => null),
  };
});

vi.mock('../services/webhook-interactions.js', () => ({
  retryWebhookInteraction: vi.fn(),
  webhookFailureLabel: vi.fn((reason: string | null) => reason ? '安全な失敗理由' : null),
  webhookResponseLabel: vi.fn((row: { status: string }) => row.status === 'failed' ? '処理できませんでした' : '届きました'),
  // d23d : 試しの結果印。実物と同じ形で返す（ラベル化はサービス側の試験で見る）。
  incomingTestIdempotencyKey: vi.fn((outcome: string) => `incoming-test:${outcome}:uuid-1`),
}));

// 署名検証を試すため、イベントバスとその DB 依存は差し替える。
vi.mock('../services/event-bus.js', () => ({
  fireEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/incoming-webhook-actions.js', async (importOriginal) => {
  // maskedPayloadShape は純粋関数で、route が届物の見本を作るのに実物を使う。
  const actual = await importOriginal<typeof import('../services/incoming-webhook-actions.js')>();
  return {
    ...actual,
    executeIncomingWebhookActions: vi.fn().mockResolvedValue({
      matchedFriendId: null, executed: 0, failed: 0, matchStatus: 'not_found',
    }),
    previewIncomingWebhook: vi.fn(),
  };
});

vi.mock('../services/outgoing-webhook-delivery.js', async (importOriginal) => {
  // 封筒の組み立ては純粋関数なので実物を通し、実際に外へ出る本文の形を
  // この試験でも確かめられるようにする。
  const actual = await importOriginal<typeof import('../services/outgoing-webhook-delivery.js')>();
  return {
    ...actual,
    deliverWebhook: vi.fn().mockResolvedValue({ ok: true, attempts: 1, lastStatus: 204 }),
    // d23b : 試し送信は1回固定の配送経路を呼ぶ。deliverWebhook を
    // 別途モックしても内部呼び出しは通らないので、deliverOnce も差し替える。
    deliverOnce: vi.fn().mockResolvedValue({ ok: true, attempts: 1, lastStatus: 204 }),
  };
});

vi.mock('../services/account-access.js', () => ({
  canAccessAllLineAccounts: vi.fn().mockResolvedValue(true),
}));

import {
  getIncomingWebhooks,
  getIncomingWebhookById,
  createIncomingWebhook,
  updateIncomingWebhook,
  deleteIncomingWebhook,
  getOutgoingWebhooks,
  getOutgoingWebhookById,
  createOutgoingWebhook,
  updateOutgoingWebhook,
  deleteOutgoingWebhook,
  createWebhookInteraction,
  finishWebhookInteraction,
  getWebhookInteractionById,
  listFailedWebhookInteractionsForRetry,
  countFailedWebhookInteractionsForRetry,
  countUnverifiedWebhookInteractions,
  listWebhookInteractions,
  getOutgoingWebhookDeliverySummaries,
  updateIncomingWebhookConfig,
  updateIncomingWebhookMaskedSample,
  backfillWebhookSecrets,
  hasWebhookSecret,
  resolveWebhookSecret,
  resolvePreviousWebhookSecret,
  listIncomingWebhookUnmatched,
} from '@line-crm/db';
import { retryWebhookInteraction } from '../services/webhook-interactions.js';
import { canAccessAllLineAccounts } from '../services/account-access.js';
import { fireEvent } from '../services/event-bus.js';
import { executeIncomingWebhookActions, previewIncomingWebhook } from '../services/incoming-webhook-actions.js';
import { deliverWebhook, deliverOnce } from '../services/outgoing-webhook-delivery.js';
import type { Env } from '../worker-env.js';
import { webhooks } from './webhooks.js';

const VALID_SECRET = 'a'.repeat(32);
const SHORT_SECRET = 'a'.repeat(31);
const ACCOUNT_ID = 'account-a';

const incomingWebhookRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'iwh-1',
  name: 'test',
  source_type: 'custom',
  secret: VALID_SECRET,
  secret_encrypted: null,
  is_active: 1,
  line_account_id: ACCOUNT_ID,
  version: 1,
  identity_match_json: '{"methods":[],"onNotFound":"do_nothing"}',
  action_refs_json: '[]',
  latest_masked_sample_json: null,
  latest_received_at: null,
  created_at: '2026-05-08T00:00:00.000+09:00',
  updated_at: '2026-05-08T00:00:00.000+09:00',
  ...overrides,
});

function setupApp(
  tenantId?: string,
  role: 'owner' | 'admin' | 'staff' = 'owner',
  permissionKeys?: string[],
) {
  const app = new Hono<Env>();
  // Webhook の作成・更新・削除はオーナー限定になった。ここで見たいのは
  // 入力の検証なので、認証は通った状態にしてから本体へ渡す。
  // 権限そのものの検証は middleware/role-guard.test.ts にある。
  app.use('*', async (c, next) => {
    c.set('staff', {
      id: 'staff-1', name: 'Staff', role, readOnly: false, tenantId, permissionKeys,
    });
    // 大事な操作の直前再確認。ここでは入力検証を見たいので確認済みとして通す。
    c.req.raw.headers.set('x-step-up-token', 'test-step-up');
    return next();
  });
  app.route('/', webhooks);
  return app;
}

/*
 * この試験は `@line-crm/db` を丸ごとモックしているので、これまで `c.env.DB` は
 * 一度も触られず空オブジェクトで足りていた。  で受信口が
 * `incoming_webhook_receipts` へ直接 INSERT するようになったため、
 * **実 D1 と同じく `meta.changes` を返す**最小の代役を置く。
 * 1 を返す = 予約が取れた(初回)。重複時の挙動は実SQLiteで
 * webhook-incoming-replay.test.ts が見ている。
 */
const reserveRun = vi.fn(async () => ({ meta: { changes: 1 } }));
const receiptPrepare = (sql: string) => ({ bind: () => ({
  run: reserveRun,
  first: async () => sql.includes('SELECT source_event_id,status,received_at')
    ? { source_event_id: 'receipt-event-1', status: 'processing', received_at: '2026-09-12T00:00:00.000Z' }
    : null,
  // 複数一致の届物が候補の友だち名を引く口（/unmatched の一覧）。
  all: async () => ({
    results: sql.includes('display_name FROM friends')
      ? friendNameRows
      : [],
  }),
}) });
let friendNameRows: Array<{ id: string; display_name: string | null }> = [];
const baseEnv = {
  DB: {
    prepare: receiptPrepare,
  } as unknown as D1Database,
} as Record<string, unknown>;

async function webhookSignature(body:string):Promise<string>{return signIncomingTest(VALID_SECRET,body);}

let receiptDb:SqliteD1;
afterEach(()=>receiptDb.raw.close());
beforeEach(() => {
  receiptDb=createTestD1();baseEnv.DB=receiptDb.db;keyedEnv.DB=receiptDb.db;
  vi.clearAllMocks();
  vi.mocked(canAccessAllLineAccounts).mockResolvedValue(true);
  vi.mocked(createWebhookInteraction).mockResolvedValue({
    id: 'interaction-1', line_account_id: ACCOUNT_ID, direction: 'incoming',
    webhook_id: 'iwh-1', webhook_name: 'test', event_type: 'incoming_webhook.custom',
    trigger_summary: 'testから受け取った', status: 'pending', request_body_json: null,
    response_status: null, attempt_count: 0, duration_ms: null, failure_reason: null,
    idempotency_key: 'delivery-1', retry_of_id: null,
    started_at: '2026-05-08T00:00:00.000+09:00', completed_at: null,
    created_at: '2026-05-08T00:00:00.000+09:00',
  });
  vi.mocked(finishWebhookInteraction).mockResolvedValue(undefined);
  vi.mocked(listWebhookInteractions).mockResolvedValue({
    items: [], total: 0, page: 1, limit: 20,
    summary: {
      total: 0, outgoing: 0, incoming: 0, succeeded: 0, failed: 0,
      resultUnknown: 0, outgoingFailed: 0, retryable: 0, averageDurationMs: null,
    },
  });
  vi.mocked(listFailedWebhookInteractionsForRetry).mockResolvedValue([]);
  vi.mocked(getOutgoingWebhookDeliverySummaries).mockResolvedValue([]);
  vi.mocked(updateIncomingWebhookMaskedSample).mockResolvedValue(undefined);
  vi.mocked(executeIncomingWebhookActions).mockResolvedValue({
    matchedFriendId: null, executed: 0, failed: 0, matchStatus: 'not_found',
  });
  vi.mocked(deliverWebhook).mockResolvedValue({ ok: true, attempts: 1, lastStatus: 204 });
  vi.mocked(deliverOnce).mockResolvedValue({ ok: true, attempts: 1, lastStatus: 204 });
  vi.mocked(getIncomingWebhookById).mockResolvedValue(incomingWebhookRow());
  vi.mocked(getOutgoingWebhookById).mockResolvedValue({
    id: 'wh-1', name: 'test', url: 'https://example.com/hook', event_types: '["*"]',
    secret: VALID_SECRET, is_active: 1, max_retries: 0, consecutive_failures: 0,
    secret_encrypted: null,
    last_failed_at: null, created_at: '2026-05-08', updated_at: '2026-05-08',
  });
});

// =====================================================
// POST /api/webhooks/outgoing — validation
// =====================================================

describe('POST /api/webhooks/outgoing — validation', () => {
  test('WEB232 forwards inactive creation and rejects non-boolean creation state', async () => {
    vi.mocked(createOutgoingWebhook).mockResolvedValue({ id: 'draft', name: 'draft', url: 'https://example.com/hook', event_types: '["*"]', secret: null, secret_encrypted: null, is_active: 0, max_retries: 0, consecutive_failures: 0, last_failed_at: null, created_at: '2026-10-08', updated_at: '2026-10-08' });
    const body = { lineAccountId: ACCOUNT_ID, name: 'draft', url: 'https://example.com/hook', eventTypes: ['*'], secret: VALID_SECRET, isActive: false };
    const send = (payload: unknown) => receiveAndDrain(setupApp(),'/api/webhooks/outgoing', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }, baseEnv);
    const response = await send(body);
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ data: { isActive: false } });
    expect(createOutgoingWebhook).toHaveBeenCalledWith(baseEnv.DB, expect.objectContaining({ isActive: false }), expect.anything());
    expect((await send({ ...body, isActive: 'false' })).status).toBe(400);
  });

  test('rejects missing secret with 400', async () => {
    const app = setupApp();
    const res = await receiveAndDrain(app,
      '/api/webhooks/outgoing',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'test', url: 'https://example.com/hook', eventTypes: ['*'] }),
      },
      baseEnv,
    );
    expect(res.status).toBe(400);
    expect(createOutgoingWebhook).not.toHaveBeenCalled();
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain('LINEアカウント');
  });

  test('rejects secret shorter than 32 chars with 400', async () => {
    const app = setupApp();
    const res = await receiveAndDrain(app,
      '/api/webhooks/outgoing',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'test',
          url: 'https://example.com/hook',
          eventTypes: ['*'],
          secret: SHORT_SECRET,
          secret_encrypted: null,
        }),
      },
      baseEnv,
    );
    expect(res.status).toBe(400);
    expect(createOutgoingWebhook).not.toHaveBeenCalled();
  });

  test('rejects http:// URL with 400', async () => {
    const app = setupApp();
    const res = await receiveAndDrain(app,
      '/api/webhooks/outgoing',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'test',
          url: 'http://example.com/hook',
          eventTypes: ['*'],
          secret: VALID_SECRET,
          secret_encrypted: null,
          lineAccountId: ACCOUNT_ID,
        }),
      },
      baseEnv,
    );
    expect(res.status).toBe(400);
    expect(createOutgoingWebhook).not.toHaveBeenCalled();
  });

  test('rejects malformed URL with 400', async () => {
    const app = setupApp();
    const res = await receiveAndDrain(app,
      '/api/webhooks/outgoing',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'test',
          url: 'not-a-url',
          eventTypes: ['*'],
          secret: VALID_SECRET,
          secret_encrypted: null,
        }),
      },
      baseEnv,
    );
    expect(res.status).toBe(400);
    expect(createOutgoingWebhook).not.toHaveBeenCalled();
  });

  test('accepts https:// + 32-char secret with 201, returns secret only on create', async () => {
    vi.mocked(createOutgoingWebhook).mockResolvedValue({
      id: 'wh-1',
      name: 'test',
      url: 'https://example.com/hook',
      event_types: '["*"]',
      secret: VALID_SECRET,
      secret_encrypted: null,
      is_active: 1,
      max_retries: 0,
      consecutive_failures: 0,
      last_failed_at: null,
      created_at: '2026-05-08T00:00:00.000+09:00',
      updated_at: '2026-05-08T00:00:00.000+09:00',
    });

    const app = setupApp();
    const res = await receiveAndDrain(app,
      '/api/webhooks/outgoing',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'test',
          url: 'https://example.com/hook',
          eventTypes: ['*'],
          secret: VALID_SECRET,
          secret_encrypted: null,
          lineAccountId: ACCOUNT_ID,
        }),
      },
      baseEnv,
    );
    expect(res.status).toBe(201);
    expect(createOutgoingWebhook).toHaveBeenCalledOnce();
    const body = (await res.json()) as {
      success: boolean;
      data: { id: string; secret: string; name: string };
    };
    expect(body.success).toBe(true);
    expect(body.data.secret).toMatch(/^[a-f0-9]{64}$/);
    expect(body.data.secret).not.toBe(VALID_SECRET);
    expect(body.data.id).toBe('wh-1');
    expect(createOutgoingWebhook).toHaveBeenCalledWith(baseEnv.DB, expect.objectContaining({ lineAccountId: ACCOUNT_ID }), { current: undefined, previous: undefined });
  });

  test('既定でない統括はLINEアカウントを省略できない', async () => {
    const res = await setupApp('tenant-b').request('/api/webhooks/outgoing', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'test', url: 'https://example.com/hook', secret: VALID_SECRET }),
    }, baseEnv);
    expect(res.status).toBe(400);
    expect((await res.json()) as object).toMatchObject({ error: 'LINEアカウントを選択してください' });
    expect(createOutgoingWebhook).not.toHaveBeenCalled();
  });

  test('他統括のLINEアカウントは403にする', async () => {
    vi.mocked(canAccessAllLineAccounts).mockResolvedValue(false);
    const res = await setupApp('tenant-b').request('/api/webhooks/outgoing', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'test', url: 'https://example.com/hook', secret: VALID_SECRET, lineAccountId: 'account-a' }),
    }, baseEnv);
    expect(res.status).toBe(403);
    expect(createOutgoingWebhook).not.toHaveBeenCalled();
  });
});

// =====================================================
// PUT /api/webhooks/outgoing/:id — validation
// =====================================================

describe('PUT /api/webhooks/outgoing/:id — validation', () => {
  test('見えない行は404で更新しない', async () => {
    vi.mocked(getOutgoingWebhookById).mockResolvedValue(null);
    const res = await setupApp('tenant-b').request(`/api/webhooks/outgoing/other?lineAccountId=${ACCOUNT_ID}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://changed.example.com', secret: 'z'.repeat(32) }),
    }, baseEnv);
    expect(res.status).toBe(404);
    expect(updateOutgoingWebhook).not.toHaveBeenCalled();
  });
  test('rejects updating to http:// URL with 400', async () => {
    const app = setupApp();
    const res = await receiveAndDrain(app,
      `/api/webhooks/outgoing/wh-1?lineAccountId=${ACCOUNT_ID}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'http://evil.example.com/' }),
      },
      baseEnv,
    );
    expect(res.status).toBe(400);
    expect(updateOutgoingWebhook).not.toHaveBeenCalled();
  });

  test('入れ替えは短い送り手の値を使わず256bitをサーバーで作る', async () => {
    const app = setupApp();
    const res = await receiveAndDrain(app,
      `/api/webhooks/outgoing/wh-1?lineAccountId=${ACCOUNT_ID}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret: SHORT_SECRET }),
      },
      baseEnv,
    );
    expect(res.status).toBe(200);
    expect(updateOutgoingWebhook).toHaveBeenCalledWith(expect.anything(),expect.any(String),ACCOUNT_ID,expect.objectContaining({secret:expect.stringMatching(/^[0-9a-f]{64}$/)}),expect.anything(),expect.anything());
  });

  test('rejects truthy non-boolean isActive with 400 (migration bypass)', async () => {
    const app = setupApp();
    const res = await receiveAndDrain(app,
      `/api/webhooks/outgoing/wh-legacy?lineAccountId=${ACCOUNT_ID}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: 1 }),
      },
      baseEnv,
    );
    expect(res.status).toBe(400);
    expect(updateOutgoingWebhook).not.toHaveBeenCalled();
    expect(getOutgoingWebhookById).not.toHaveBeenCalled();
  });

  test('rejects re-activating webhook whose stored secret is too short (migration bypass)', async () => {
    vi.mocked(getOutgoingWebhookById).mockResolvedValue({
      id: 'wh-legacy',
      name: 'legacy',
      url: 'https://example.com/hook',
      event_types: '["*"]',
      secret: null,
      secret_encrypted: null,
      is_active: 0,
      max_retries: 0,
      consecutive_failures: 0,
      last_failed_at: null,
      created_at: '2026-05-08T00:00:00.000+09:00',
      updated_at: '2026-05-08T00:00:00.000+09:00',
    });

    const app = setupApp();
    const res = await receiveAndDrain(app,
      `/api/webhooks/outgoing/wh-legacy?lineAccountId=${ACCOUNT_ID}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: true }),
      },
      baseEnv,
    );
    expect(res.status).toBe(400);
    expect(updateOutgoingWebhook).not.toHaveBeenCalled();
  });

  test('rejects re-activating webhook whose stored URL is http:// (migration bypass)', async () => {
    vi.mocked(getOutgoingWebhookById).mockResolvedValue({
      id: 'wh-legacy-http',
      name: 'legacy-http',
      url: 'http://example.com/hook',
      event_types: '["*"]',
      secret: VALID_SECRET,
      secret_encrypted: null,
      is_active: 0,
      max_retries: 0,
      consecutive_failures: 0,
      last_failed_at: null,
      created_at: '2026-05-08T00:00:00.000+09:00',
      updated_at: '2026-05-08T00:00:00.000+09:00',
    });

    const app = setupApp();
    const res = await receiveAndDrain(app,
      `/api/webhooks/outgoing/wh-legacy-http?lineAccountId=${ACCOUNT_ID}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: true }),
      },
      baseEnv,
    );
    expect(res.status).toBe(400);
    expect(updateOutgoingWebhook).not.toHaveBeenCalled();
  });

  test('accepts partial update without secret/url change', async () => {
    vi.mocked(getOutgoingWebhookById).mockResolvedValue({
      id: 'wh-1',
      name: 'renamed',
      url: 'https://example.com/hook',
      event_types: '["*"]',
      secret: VALID_SECRET,
      secret_encrypted: null,
      is_active: 1,
      max_retries: 0,
      consecutive_failures: 0,
      last_failed_at: null,
      created_at: '2026-05-08T00:00:00.000+09:00',
      updated_at: '2026-05-08T00:00:00.000+09:00',
    });

    const app = setupApp();
    const res = await receiveAndDrain(app,
      `/api/webhooks/outgoing/wh-1?lineAccountId=${ACCOUNT_ID}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'renamed' }),
      },
      baseEnv,
    );
    expect(res.status).toBe(200);
    expect(updateOutgoingWebhook).toHaveBeenCalledOnce();
  });
});

describe('DELETE /api/webhooks/outgoing/:id — tenant scope', () => {
  test.each(['other-tenant', 'missing'])('%s は404で削除しない', async () => {
    vi.mocked(getOutgoingWebhookById).mockResolvedValue(null);
    const res = await setupApp('tenant-b').request(`/api/webhooks/outgoing/hidden?lineAccountId=${ACCOUNT_ID}`, { method: 'DELETE' }, baseEnv);
    expect(res.status).toBe(404);
    expect(deleteOutgoingWebhook).not.toHaveBeenCalled();
  });
});

// =====================================================
// 送信 Webhook の GET でも秘密値を返さない。
// =====================================================

describe('GET /api/webhooks/outgoing — secret exposure', () => {
  test('does not include secret in response payload', async () => {
    vi.mocked(getOutgoingWebhooks).mockResolvedValue([
      {
        id: 'wh-1',
        name: 'test',
        url: 'https://example.com/hook',
        event_types: '["*"]',
        secret: VALID_SECRET,
        secret_encrypted: null,
        is_active: 1,
        max_retries: 0,
        consecutive_failures: 0,
        last_failed_at: null,
        created_at: '2026-05-08T00:00:00.000+09:00',
        updated_at: '2026-05-08T00:00:00.000+09:00',
      },
    ]);

    const app = setupApp();
    const res = await receiveAndDrain(app,`/api/webhooks/outgoing?lineAccountId=${ACCOUNT_ID}`, { method: 'GET' }, baseEnv);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(VALID_SECRET);
    const body = JSON.parse(text) as { data: Array<Record<string, unknown>> };
    expect(body.data[0]).not.toHaveProperty('secret');
    // 設定済みであることだけを返し、秘密値は返さない。
    expect(body.data[0].hasSecret).toBe(true);
  });

  test('hasSecret is false when secret is null in DB', async () => {
    vi.mocked(getOutgoingWebhooks).mockResolvedValue([
      {
        id: 'wh-2',
        name: 'legacy',
        url: 'https://example.com/hook',
        event_types: '["*"]',
        secret: null,
        secret_encrypted: null,
        is_active: 0,
        max_retries: 0,
        consecutive_failures: 0,
        last_failed_at: null,
        created_at: '2026-05-08T00:00:00.000+09:00',
        updated_at: '2026-05-08T00:00:00.000+09:00',
      },
    ]);

    const app = setupApp();
    const res = await receiveAndDrain(app,`/api/webhooks/outgoing?lineAccountId=${ACCOUNT_ID}`, { method: 'GET' }, baseEnv);
    const body = (await res.json()) as { data: Array<Record<string, unknown>> };
    expect(body.data[0]).not.toHaveProperty('secret');
    expect(body.data[0].hasSecret).toBe(false);
  });

  test('接続ごとの直近30日集計と、安全に再送できるかを返す', async () => {
    vi.mocked(getOutgoingWebhooks).mockResolvedValue([{
      id: 'wh-1', name: '顧客管理', url: 'https://example.com/hook', event_types: '["friend.added"]',
      secret: VALID_SECRET, is_active: 1, max_retries: 2, consecutive_failures: 1,
      secret_encrypted: null,
      last_failed_at: '2026-09-06T10:00:00.000+09:00',
      created_at: '2026-05-08T00:00:00.000+09:00', updated_at: '2026-09-06T10:00:00.000+09:00',
    }]);
    vi.mocked(getOutgoingWebhookDeliverySummaries).mockResolvedValue([{
      webhook_id: 'wh-1', total: 4, succeeded: 3, failed: 1, pending: 0,
      last_status: 'failed', last_response_status: 500,
      last_completed_at: '2026-09-06T10:00:01.000+09:00',
      last_failure_reason: 'response_5xx', can_retry: 1,
    }]);

    const res = await receiveAndDrain(setupApp(),
      `/api/webhooks/outgoing?lineAccountId=${ACCOUNT_ID}`,
      { method: 'GET' },
      baseEnv,
    );
    expect(res.status).toBe(200);
    expect(getOutgoingWebhookDeliverySummaries).toHaveBeenCalledWith(baseEnv.DB, ACCOUNT_ID, 30);
    const body = await res.json() as { data: Array<Record<string, unknown>> };
    expect(body.data[0]).toMatchObject({
      deliverySummary: {
        periodDays: 30, total: 4, succeeded: 3, failed: 1, pending: 0,
        successRate: 75, canRetry: true,
        lastResult: { status: 'failed', responseStatus: 500, failureReason: '安全な失敗理由' },
      },
    });
  });

  test('履歴がない接続は0件・成功率未計算として返す', async () => {
    vi.mocked(getOutgoingWebhooks).mockResolvedValue([{
      id: 'wh-empty', name: '未送信', url: 'https://example.com/empty', event_types: '["*"]',
      secret: VALID_SECRET, is_active: 1, max_retries: 0, consecutive_failures: 0,
      secret_encrypted: null,
      last_failed_at: null, created_at: '2026-05-08', updated_at: '2026-05-08',
    }]);

    const res = await receiveAndDrain(setupApp(),
      `/api/webhooks/outgoing?lineAccountId=${ACCOUNT_ID}`,
      { method: 'GET' },
      baseEnv,
    );
    const body = await res.json() as { data: Array<{ deliverySummary: Record<string, unknown> }> };
    expect(body.data[0].deliverySummary).toMatchObject({
      total: 0, succeeded: 0, failed: 0, pending: 0, successRate: null,
      lastResult: null, canRetry: false,
    });
  });

  test('対象外アカウントの集計を読めない', async () => {
    vi.mocked(canAccessAllLineAccounts).mockResolvedValue(false);
    const res = await receiveAndDrain(setupApp(),
      '/api/webhooks/outgoing?lineAccountId=account-b',
      { method: 'GET' },
      baseEnv,
    );
    expect(res.status).toBe(403);
    expect(getOutgoingWebhookDeliverySummaries).not.toHaveBeenCalled();
  });

  test('集計取得に失敗したら安全な500を返す', async () => {
    vi.mocked(getOutgoingWebhookDeliverySummaries).mockRejectedValue(new Error('private DB detail'));
    const res = await receiveAndDrain(setupApp(),
      `/api/webhooks/outgoing?lineAccountId=${ACCOUNT_ID}`,
      { method: 'GET' },
      baseEnv,
    );
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('private DB detail');
  });
});

// =====================================================
// POST /api/webhooks/incoming — validation
// =====================================================

describe('POST /api/webhooks/incoming — validation', () => {
  test('requires an account outside the default tenant and checks an explicit account', async () => {
    const app = setupApp('tenant-b');
    const omitted = await receiveAndDrain(app,'/api/webhooks/incoming', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'test', secret: VALID_SECRET }),
    }, baseEnv);
    expect(omitted.status).toBe(400);

    vi.mocked(canAccessAllLineAccounts).mockResolvedValueOnce(false);
    const forbidden = await receiveAndDrain(app,'/api/webhooks/incoming', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'test', secret: VALID_SECRET, lineAccountId: 'account-a' }),
    }, baseEnv);
    expect(forbidden.status).toBe(403);
    expect(canAccessAllLineAccounts).toHaveBeenCalledWith(baseEnv.DB, expect.anything(), ['account-a']);
  });

  test('rejects missing secret with 400', async () => {
    const app = setupApp();
    const res = await receiveAndDrain(app,
      '/api/webhooks/incoming',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'test' }),
      },
      baseEnv,
    );
    expect(res.status).toBe(400);
    expect(createIncomingWebhook).not.toHaveBeenCalled();
  });

  test('rejects secret shorter than 32 chars with 400', async () => {
    const app = setupApp();
    const res = await receiveAndDrain(app,
      '/api/webhooks/incoming',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'test', secret: SHORT_SECRET }),
      },
      baseEnv,
    );
    expect(res.status).toBe(400);
    expect(createIncomingWebhook).not.toHaveBeenCalled();
  });

  test('accepts 32-char secret with 201, returns secret on create only', async () => {
    vi.mocked(createIncomingWebhook).mockResolvedValue(incomingWebhookRow());

    const app = setupApp();
    const res = await receiveAndDrain(app,
      '/api/webhooks/incoming',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'test', secret: VALID_SECRET, lineAccountId: ACCOUNT_ID }),
      },
      baseEnv,
    );
    expect(res.status).toBe(201);
    expect(createIncomingWebhook).toHaveBeenCalledOnce();
    expect(createIncomingWebhook).toHaveBeenCalledWith(baseEnv.DB, expect.objectContaining({ lineAccountId: ACCOUNT_ID }), { current: undefined, previous: undefined });
    const body = (await res.json()) as { data: { id: string; secret: string } };
    expect(body.data.secret).toMatch(/^[a-f0-9]{64}$/);
    expect(body.data.secret).not.toBe(VALID_SECRET);
  });
});

// =====================================================
// PUT /api/webhooks/incoming/:id — validation
// =====================================================

describe('PUT /api/webhooks/incoming/:id — validation', () => {
  test('returns 404 before changing a webhook outside the tenant', async () => {
    vi.mocked(getIncomingWebhookById).mockResolvedValue(null);
    const res = await setupApp('tenant-b').request(`/api/webhooks/incoming/iwh-other?lineAccountId=${ACCOUNT_ID}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: VALID_SECRET }),
    }, baseEnv);
    expect(res.status).toBe(404);
    expect(updateIncomingWebhook).not.toHaveBeenCalled();
  });

  test('入れ替えは短い送り手の値を使わず256bitをサーバーで作る', async () => {
    const app = setupApp();
    const res = await receiveAndDrain(app,
      `/api/webhooks/incoming/iwh-1?lineAccountId=${ACCOUNT_ID}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret: SHORT_SECRET }),
      },
      baseEnv,
    );
    expect(res.status).toBe(200);
    expect(updateIncomingWebhook).toHaveBeenCalledWith(expect.anything(),expect.any(String),ACCOUNT_ID,expect.objectContaining({secret:expect.stringMatching(/^[0-9a-f]{64}$/)}),expect.anything(),);
  });

  test('rejects re-activating webhook whose stored secret is too short (migration bypass)', async () => {
    vi.mocked(getIncomingWebhookById).mockResolvedValue(incomingWebhookRow({
      id: 'iwh-legacy', name: 'legacy', secret: null, is_active: 0, line_account_id: null,
    }));

    const app = setupApp();
    const res = await receiveAndDrain(app,
      `/api/webhooks/incoming/iwh-legacy?lineAccountId=${ACCOUNT_ID}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: true }),
      },
      baseEnv,
    );
    expect(res.status).toBe(400);
    expect(updateIncomingWebhook).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/webhooks/incoming/:id — tenant scope', () => {
  test('returns 404 before deleting a webhook outside the tenant', async () => {
    vi.mocked(getIncomingWebhookById).mockResolvedValue(null);
    const res = await setupApp('tenant-b').request(`/api/webhooks/incoming/iwh-other?lineAccountId=${ACCOUNT_ID}`, { method: 'DELETE' }, baseEnv);
    expect(res.status).toBe(404);
    expect(deleteIncomingWebhook).not.toHaveBeenCalled();
  });
});

// =====================================================
// 受信 Webhook の GET でも秘密値を返さない。
// =====================================================

describe('GET /api/webhooks/incoming — secret exposure', () => {
  test('does not include secret in response payload', async () => {
    vi.mocked(getIncomingWebhooks).mockResolvedValue([incomingWebhookRow()]);

    const app = setupApp();
    const res = await receiveAndDrain(app,`/api/webhooks/incoming?lineAccountId=${ACCOUNT_ID}`, { method: 'GET' }, baseEnv);
    const text = await res.text();
    expect(text).not.toContain(VALID_SECRET);
    const body = JSON.parse(text) as { data: Array<Record<string, unknown>> };
    expect(body.data[0]).not.toHaveProperty('secret');
    expect(body.data[0].hasSecret).toBe(true);
  });
});

describe('受け取り口の詳細と設定', () => {
  test('値を隠した最新項目と構造化設定だけを返す', async () => {
    vi.mocked(getIncomingWebhookById).mockResolvedValue(incomingWebhookRow({
      version: 3,
      identity_match_json: '{"methods":[{"kind":"external_customer_id","path":"$.customer.id"}],"onNotFound":"unmatched_box"}',
      action_refs_json: '[{"refKind":"tag","refId":"tag-a","refVersionId":null}]',
      latest_masked_sample_json: '{"fields":[{"path":"$.customer.email","type":"string","maskedValue":"••••"}],"truncated":false}',
      latest_received_at: '2026-09-07T09:00:00.000+09:00',
    }));

    const res = await receiveAndDrain(setupApp(),
      `/api/webhooks/incoming/iwh-1?lineAccountId=${ACCOUNT_ID}`,
      { method: 'GET' },
      baseEnv,
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(VALID_SECRET);
    const body = JSON.parse(text) as { data: Record<string, unknown> };
    expect(body.data).toMatchObject({
      version: 3,
      identityMatching: {
        methods: [{ kind: 'external_customer_id', path: '$.customer.id' }],
        onNotFound: 'unmatched_box',
      },
      actions: [{ refKind: 'tag', refId: 'tag-a', refVersionId: null }],
      actionExecution: { state: 'connected' },
      latestSample: {
        receivedAt: '2026-09-07T09:00:00.000+09:00',
        fields: [{ path: '$.customer.email', type: 'string', maskedValue: '••••' }],
      },
      templateFields: [{
        path: '$.customer.email', type: 'string', token: '{{payload.customer.email}}',
      }],
    });
  });

  test('受信前は最新見本と差し込み項目を空で返す', async () => {
    const res = await receiveAndDrain(setupApp(),
      `/api/webhooks/incoming/iwh-1?lineAccountId=${ACCOUNT_ID}`,
      { method: 'GET' },
      baseEnv,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      data: {
        latestSample: null,
        templateFields: [],
        actionExecution: { state: 'not_configured', reason: null },
      },
    });
  });

  test('詳細取得に失敗したら顧客値を含まない500を返す', async () => {
    vi.mocked(getIncomingWebhookById).mockRejectedValue(new Error('private@example.com'));
    const res = await receiveAndDrain(setupApp(),
      `/api/webhooks/incoming/iwh-1?lineAccountId=${ACCOUNT_ID}`,
      { method: 'GET' },
      baseEnv,
    );
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('private@example.com');
  });

  test('対象外アカウントは存在も返さない', async () => {
    vi.mocked(canAccessAllLineAccounts).mockResolvedValue(false);
    const res = await receiveAndDrain(setupApp(),
      '/api/webhooks/incoming/iwh-1?lineAccountId=account-b',
      { method: 'GET' },
      baseEnv,
    );
    expect(res.status).toBe(404);
    expect(getIncomingWebhookById).not.toHaveBeenCalled();
  });

  test('権限キーのないスタッフは詳細を読めない', async () => {
    const res = await setupApp(undefined, 'staff', []).request(
      `/api/webhooks/incoming/iwh-1?lineAccountId=${ACCOUNT_ID}`,
      { method: 'GET' },
      baseEnv,
    );
    expect(res.status).toBe(403);
    expect(getIncomingWebhookById).not.toHaveBeenCalled();
  });

  test('オーナーは版を指定して照合方法と実行参照を保存できる', async () => {
    vi.mocked(updateIncomingWebhookConfig).mockResolvedValue({
      status: 'updated', item: incomingWebhookRow({ version: 4 }),
    });
    const res = await receiveAndDrain(setupApp(),
      `/api/webhooks/incoming/iwh-1/config?lineAccountId=${ACCOUNT_ID}`,
      {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expectedVersion: 3,
          identityMatching: {
            methods: [{ kind: 'harness_friend_id', path: '$.friend.id' }],
            onNotFound: 'do_nothing',
          },
          actions: [{ refKind: 'scenario', refId: 'scenario-a', refVersionId: 'version-a' }],
        }),
      },
      baseEnv,
    );
    expect(res.status).toBe(200);
    expect(updateIncomingWebhookConfig).toHaveBeenCalledWith(baseEnv.DB, {
      id: 'iwh-1', lineAccountId: ACCOUNT_ID, expectedVersion: 3,
      identityMatching: {
        methods: [{ kind: 'harness_friend_id', path: '$.friend.id' }],
        onNotFound: 'do_nothing',
      },
      actions: [{ refKind: 'scenario', refId: 'scenario-a', refVersionId: 'version-a' }],
    });
  });

  test('古い版の保存は409と現在版を返す', async () => {
    vi.mocked(updateIncomingWebhookConfig).mockResolvedValue({
      status: 'conflict', currentVersion: 5,
    });
    const res = await receiveAndDrain(setupApp(),
      `/api/webhooks/incoming/iwh-1/config?lineAccountId=${ACCOUNT_ID}`,
      {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expectedVersion: 4,
          identityMatching: { methods: [], onNotFound: 'do_nothing' },
          actions: [],
        }),
      },
      baseEnv,
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      success: false, code: 'version_conflict', data: { currentVersion: 5 },
    });
  });

  test('名前照合や自由記述アクションを受け付けない', async () => {
    const res = await receiveAndDrain(setupApp(),
      `/api/webhooks/incoming/iwh-1/config?lineAccountId=${ACCOUNT_ID}`,
      {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expectedVersion: 1,
          identityMatching: {
            methods: [{ kind: 'name', path: '$.name' }], onNotFound: 'do_nothing',
          },
          actions: [{ refKind: 'free_text', refId: '何かする' }],
        }),
      },
      baseEnv,
    );
    expect(res.status).toBe(400);
    expect(updateIncomingWebhookConfig).not.toHaveBeenCalled();
  });

  test('担当者は設定を更新できない', async () => {
    const res = await setupApp(undefined, 'staff').request(
      `/api/webhooks/incoming/iwh-1/config?lineAccountId=${ACCOUNT_ID}`,
      {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      },
      baseEnv,
    );
    expect(res.status).toBe(403);
    expect(updateIncomingWebhookConfig).not.toHaveBeenCalled();
  });
});

// =====================================================
// POST /api/webhooks/incoming/:id/receive — signature verification
// =====================================================

describe('POST /api/webhooks/incoming/:id/receive — signature', () => {
  test('rejects request without X-Webhook-Signature with 401', async () => {
    vi.mocked(getIncomingWebhookById).mockResolvedValue(incomingWebhookRow({ line_account_id: null }));

    const app = setupApp();
    const res = await receiveAndDrain(app,
      '/api/webhooks/incoming/iwh-1/receive',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ping: true }),
      },
      baseEnv,
    );
    expect(res.status).toBe(401);
  });

  test('rejects invalid signature with 401', async () => {
    vi.mocked(getIncomingWebhookById).mockResolvedValue(incomingWebhookRow({ line_account_id: null }));

    const app = setupApp();
    const res = await receiveAndDrain(app,
      '/api/webhooks/incoming/iwh-1/receive',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': 'deadbeef',
        },
        body: JSON.stringify({ ping: true }),
      },
      baseEnv,
    );
    expect(res.status).toBe(401);
  });

  test('accepts valid HMAC-SHA256 hex signature', async () => {
    vi.mocked(getIncomingWebhookById).mockResolvedValue(incomingWebhookRow());

    const body = JSON.stringify({ ping: true });
    const hexSignature = await webhookSignature(body);

    const app = setupApp();
    const res = await receiveAndDrain(app,
      '/api/webhooks/incoming/iwh-1/receive',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': hexSignature,
        },
        body,
      },
      baseEnv,
    );
    expect(res.status).toBe(202);
    const fencedDb = vi.mocked(fireEvent).mock.calls[0]![5]!.db;
    expect(fencedDb).not.toBe(baseEnv.DB);
    expect(fireEvent).toHaveBeenCalledWith(
      fencedDb,
      'incoming_webhook.custom',
      expect.anything(),
      undefined,
      'account-a',
      expect.objectContaining({ sourceEventId: expect.any(String), step: expect.any(Function) }),
    );
    expect(createWebhookInteraction).toHaveBeenCalledWith(fencedDb, expect.objectContaining({
      lineAccountId: 'account-a',
      direction: 'incoming',
      requestBodyJson: null,
    }));
    expect(finishWebhookInteraction).toHaveBeenCalledWith(
      fencedDb,
      'interaction-1',
      'account-a',
      expect.objectContaining({ status: 'succeeded', responseStatus: 200 }),
    );
    expect(updateIncomingWebhookMaskedSample).toHaveBeenCalledWith(
      fencedDb,
      'iwh-1',
      ACCOUNT_ID,
      {
        fields: [{ path: '$.ping', type: 'boolean', maskedValue: '••••' }],
        truncated: false,
      },
    );
    expect(JSON.stringify(vi.mocked(updateIncomingWebhookMaskedSample).mock.calls)).not.toContain('true');
  });

  test('照合設定と実行参照を受信後の実行器へ渡す', async () => {
    vi.mocked(getIncomingWebhookById).mockResolvedValue(incomingWebhookRow({
      identity_match_json: '{"methods":[{"kind":"harness_friend_id","path":"$.friendId"}],"onNotFound":"do_nothing"}',
      action_refs_json: '[{"refKind":"tag","refId":"tag-a","refVersionId":null}]',
    }));
    vi.mocked(executeIncomingWebhookActions).mockResolvedValue({
      matchedFriendId: 'friend-a', executed: 1, failed: 0, matchStatus: 'matched',
    });
    const body = JSON.stringify({ friendId: 'friend-a' });
    const res = await receiveAndDrain(setupApp(),
      '/api/webhooks/incoming/iwh-1/receive',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': await webhookSignature(body),
        },
        body,
      },
      baseEnv,
    );
    expect(res.status).toBe(202);
    const fencedDb = vi.mocked(fireEvent).mock.calls[0]![5]!.db;
    expect(fencedDb).not.toBe(baseEnv.DB);
    expect(executeIncomingWebhookActions).toHaveBeenCalledWith(fencedDb, expect.objectContaining({
      lineAccountId: ACCOUNT_ID,
      webhookId: 'iwh-1',
      payload: { friendId: 'friend-a' },
      actions: [{ refKind: 'tag', refId: 'tag-a', refVersionId: null }],
    }));
    expect(fireEvent).toHaveBeenCalledWith(
      fencedDb,
      'incoming_webhook.custom',
      expect.objectContaining({ friendId: 'friend-a' }),
      undefined,
      ACCOUNT_ID,
      expect.objectContaining({ sourceEventId: expect.any(String), step: expect.any(Function) }),
    );
  });

  test('最新項目の保存が失敗しても署名済みの受信処理は止めない', async () => {
    vi.mocked(updateIncomingWebhookMaskedSample).mockRejectedValue(new Error('D1 unavailable'));
    const body = JSON.stringify({ customer: { email: 'private@example.com' } });
    const res = await receiveAndDrain(setupApp(),
      '/api/webhooks/incoming/iwh-1/receive',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': await webhookSignature(body),
        },
        body,
      },
      baseEnv,
    );
    expect(res.status).toBe(202);
    expect(fireEvent).toHaveBeenCalledOnce();
  });
});

describe('S: 合言葉の併用期間・受け取りの試し・複数一致の保留', () => {
  test('入れ替えから24時間は前の合言葉の署名も受け付ける', async () => {
    // 現行の合言葉では合わないが、併用期間内の前の合言葉では通る。
    vi.mocked(resolvePreviousWebhookSecret).mockResolvedValue('o'.repeat(32));
    const body = JSON.stringify({ ping: true });
    const res = await receiveAndDrain(setupApp(),
      '/api/webhooks/incoming/iwh-1/receive',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': await signedWith('o'.repeat(32), body),
        },
        body,
      },
      baseEnv,
    );
    expect(res.status).toBe(202);
    expect(resolvePreviousWebhookSecret).toHaveBeenCalled();
  });

  test('併用期間を過ぎた前の合言葉は受け付けない', async () => {
    // 期限切れ・無い前の合言葉は resolvePreviousWebhookSecret が null を返す。
    vi.mocked(resolvePreviousWebhookSecret).mockResolvedValue(null);
    const body = JSON.stringify({ ping: true });
    const res = await receiveAndDrain(setupApp(),
      '/api/webhooks/incoming/iwh-1/receive',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': await signedWith('o'.repeat(32), body),
        },
        body,
      },
      baseEnv,
    );
    expect(res.status).toBe(401);
  });

  test('受け取りの試しは照合と行動の組み立てを返し、実行はしない', async () => {
    vi.mocked(previewIncomingWebhook).mockResolvedValue({
      match: { status: 'matched', friendId: 'friend-a' },
      identityAttempts: [{ kind: 'harness_friend_id', path: '$.friendId', value: 'friend-a' }],
      actions: [{
        refIndex: 0,
        ref: { refKind: 'tag', refId: 'tag-a', refVersionId: null },
        ok: true,
        plan: [{ type: 'add_tag' }],
      }],
    });
    const res = await receiveAndDrain(setupApp(),
      `/api/webhooks/incoming/iwh-1/test?lineAccountId=${ACCOUNT_ID}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payload: { friendId: 'friend-a' } }),
      },
      baseEnv,
    );
    expect(res.status).toBe(200);
    const json = await res.json() as { data: { match: { status: string }; actions: Array<{ ok: boolean }> } };
    expect(json.data.match.status).toBe('matched');
    expect(json.data.actions[0]!.ok).toBe(true);
    // 試しは実行しない。行動の実行と受領の予約は呼ばれない。
    expect(executeIncomingWebhookActions).not.toHaveBeenCalled();
    // 結果はやり取り台帳へ test 種別で分けて残る(-26 §9)。
    // d23d : 試算の結果（照合できた）を記録へ残す。試しなので
    // 相手への応答番号は残さない（実際の受信とは分ける）。
    expect(createWebhookInteraction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: 'incoming_webhook.test',
        direction: 'incoming',
        triggerSummary: expect.stringContaining('友だちと照合できた'),
        idempotencyKey: expect.stringMatching(/^incoming-test:matched:/),
      }),
    );
    expect(finishWebhookInteraction).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), ACCOUNT_ID,
      expect.objectContaining({ status: 'succeeded', responseStatus: null }),
    );
  });

  // d23d : 照合相手がいない試しを「結びつきました」と記録しない。
  test.each([
    [
      'not_found（照合相手なし）',
      { match: { status: 'not_found' }, identityAttempts: [], actions: [] },
      '照合相手がいなかった',
      'incoming-test:not_found:',
    ],
    [
      'ambiguous（候複数）',
      { match: { status: 'ambiguous', friendIds: ['f-1', 'f-2'] }, identityAttempts: [], actions: [] },
      '照合候補が複数あった',
      'incoming-test:ambiguous:',
    ],
    [
      '行動の確認に失敗',
      {
        match: { status: 'matched', friendId: 'friend-a' },
        identityAttempts: [],
        actions: [{
          refIndex: 0,
          ref: { refKind: 'tag', refId: 'tag-x', refVersionId: null },
          ok: false,
          error: '対応していない処理です',
        }],
      },
      '行動の確認で不備があった',
      'incoming-test:invalid:',
    ],
  ])('受け取りの試しの記録は試算の結果を残す: %s', async (_name, preview, summaryPart, keyPrefix) => {
    vi.mocked(previewIncomingWebhook).mockResolvedValue(preview as never);
    const res = await receiveAndDrain(setupApp(),
      `/api/webhooks/incoming/iwh-1/test?lineAccountId=${ACCOUNT_ID}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payload: { friendId: 'missing' } }),
      },
      baseEnv,
    );
    expect(res.status).toBe(200);
    expect(createWebhookInteraction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: 'incoming_webhook.test',
        triggerSummary: expect.stringContaining(summaryPart as string),
        idempotencyKey: expect.stringMatching(new RegExp(`^${keyPrefix}`)),
      }),
    );
  });

  test('受け取りの試しは payload が無ければ400', async () => {
    const res = await receiveAndDrain(setupApp(),
      `/api/webhooks/incoming/iwh-1/test?lineAccountId=${ACCOUNT_ID}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      },
      baseEnv,
    );
    expect(res.status).toBe(400);
    expect(previewIncomingWebhook).not.toHaveBeenCalled();
  });

  test('複数一致で保留した届物は候補の友だちつきで一覧に出る', async () => {
    vi.mocked(listIncomingWebhookUnmatched).mockResolvedValue([{
      id: 'unmatched-1',
      webhook_id: 'iwh-1',
      line_account_id: ACCOUNT_ID,
      source_event_id: 'evt-1',
      kind: 'ambiguous',
      status: 'pending',
      identity_attempts_json: '[{"kind":"verified_email","path":"$.email","value":"a@example.com"}]',
      masked_shape_json: null,
      candidate_friend_ids_json: '["f-1","f-2"]',
      resolved_friend_id: null,
      resolved_by: null,
      resolved_at: null,
      received_at: '2026-09-27T00:00:00.000+09:00',
      created_at: '2026-09-27T00:00:00.000+09:00',
      updated_at: '2026-09-27T00:00:00.000+09:00',
    }]);
    friendNameRows = [
      { id: 'f-1', display_name: '田中' },
      { id: 'f-2', display_name: '佐藤' },
    ];
    for(const row of friendNameRows) receiptDb.raw.prepare('INSERT INTO friends(id,line_user_id,display_name,line_account_id) VALUES(?,?,?,?)').run(row.id,`U${row.id}`,row.display_name,ACCOUNT_ID);
    const res = await receiveAndDrain(setupApp(),
      `/api/webhooks/incoming/iwh-1/unmatched?lineAccountId=${ACCOUNT_ID}`,
      {},
      baseEnv,
    );
    expect(res.status).toBe(200);
    const json = await res.json() as { data: Array<{ kind: string; candidates: Array<{ friendId: string; displayName: string | null }> }> };
    expect(json.data[0]!.kind).toBe('ambiguous');
    expect(json.data[0]!.candidates).toEqual([
      { friendId: 'f-1', displayName: '田中' },
      { friendId: 'f-2', displayName: '佐藤' },
    ]);
  });
});

describe('POST /api/webhooks/outgoing/:id/test', () => {
  test('アカウント内の有効な送り先へ1回試し送信して記録する', async () => {
    const res = await receiveAndDrain(setupApp(),
      `/api/webhooks/outgoing/wh-1/test?lineAccountId=${ACCOUNT_ID}`,
      { method: 'POST' },
      baseEnv,
    );
    expect(res.status).toBe(200);
    // 試し送信も共通封筒 {id,type,occurred_at,account_id,data,attempt}
    // で送る。封筒の id と冪等キーは同じ値（再送しても同じ出来事）。
    // d23b : 試し送信は送り直し無しの1回固定経路(deliverOnce)を呼ぶ。
    const call = vi.mocked(deliverOnce).mock.calls[0];
    expect(call?.[0]).toMatchObject({ id: 'wh-1' });
    const sentBody = JSON.parse(call?.[1] ?? '{}') as Record<string, unknown>;
    expect(sentBody).toMatchObject({
      type: 'webhook.test',
      account_id: ACCOUNT_ID,
      attempt: 1,
      data: { test: true, source: 'line-harness-admin' },
    });
    expect(typeof sentBody.id).toBe('string');
    expect(typeof sentBody.occurred_at).toBe('string');
    expect(call?.[2]).toMatchObject({
      idempotencyKey: sentBody.id,
      credentialKeys: { current: undefined, previous: undefined },
    });
    expect(finishWebhookInteraction).toHaveBeenCalledWith(
      baseEnv.DB, 'interaction-1', ACCOUNT_ID,
      expect.objectContaining({ status: 'succeeded', responseStatus: 204 }),
    );
  });
});

describe('Webhookやり取り記録', () => {
  const failedRow = {
    id: 'run-a', line_account_id: ACCOUNT_ID, direction: 'outgoing' as const,
    webhook_id: 'wh-1', webhook_name: '顧客管理', event_type: 'friend.added',
    trigger_summary: '友だちが追加されたとき', status: 'failed' as const,
    request_body_json: '{"private":"本文"}', response_status: 500,
    attempt_count: 2, duration_ms: 820, failure_reason: 'response_5xx' as const,
    idempotency_key: 'delivery-a', retry_of_id: null,
    linked_webhook_active: 1 as const, delivery_status: null,
    delivery_next_retry_at: null,
    started_at: '2026-08-29T10:00:00.000+09:00', completed_at: '2026-08-29T10:00:00.820+09:00',
    created_at: '2026-08-29T10:00:00.000+09:00',
  };
  test('一覧はアカウントを検査し、本文・配送ID・Webhook IDを返さない', async () => {
    vi.mocked(listWebhookInteractions).mockResolvedValue({
      items: [failedRow], total: 1, page: 1, limit: 20,
      summary: {
        total: 1, outgoing: 1, incoming: 0, succeeded: 0, failed: 1,
        resultUnknown: 0, outgoingFailed: 1, retryable: 1, averageDurationMs: 820,
      },
    });
    const res = await receiveAndDrain(setupApp(),
      `/api/webhooks/interactions?lineAccountId=${ACCOUNT_ID}`,
      { method: 'GET' },
      baseEnv,
    );
    expect(res.status).toBe(200);
    expect(canAccessAllLineAccounts).toHaveBeenCalledWith(baseEnv.DB, expect.anything(), [ACCOUNT_ID]);
    const body = await res.json() as { data: { items: Array<Record<string, unknown>> } };
    expect(body.data.items[0]).toMatchObject({
      id: 'run-a', webhookName: '顧客管理', responseLabel: '処理できませんでした', canRetry: true,
      // 判定用の記号も返す。'unknown' は無条件に再送しない目印。
      failureReasonCode: 'response_5xx',
    });
    expect(body.data.items[0]).not.toHaveProperty('request_body_json');
    expect(body.data.items[0]).not.toHaveProperty('idempotency_key');
    expect(body.data.items[0]).not.toHaveProperty('webhook_id');
  });
  test('権限外のアカウントは一覧を読めない', async () => {
    vi.mocked(canAccessAllLineAccounts).mockResolvedValue(false);
    const res = await receiveAndDrain(setupApp(),
      '/api/webhooks/interactions?lineAccountId=account-b',
      { method: 'GET' },
      baseEnv,
    );
    expect(res.status).toBe(403);
    expect(listWebhookInteractions).not.toHaveBeenCalled();
  });
  test('失敗した送信だけを同じアカウントの中でやり直す', async () => {
    vi.mocked(getWebhookInteractionById).mockResolvedValue(failedRow);
    vi.mocked(retryWebhookInteraction).mockResolvedValue({ ...failedRow, id: 'retry-a', status: 'succeeded' });
    const res = await receiveAndDrain(setupApp(),
      `/api/webhooks/interactions/run-a/retry?lineAccountId=${ACCOUNT_ID}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      baseEnv,
    );
    expect(res.status).toBe(200);
    expect(getWebhookInteractionById).toHaveBeenCalledWith(baseEnv.DB, 'run-a', ACCOUNT_ID);
    expect(retryWebhookInteraction).toHaveBeenCalledWith(baseEnv.DB, failedRow, { current: undefined, previous: undefined });
  });
  test('古い版の送り直しは 409 と現在の記録を返す', async () => {
    vi.mocked(getWebhookInteractionById).mockResolvedValue({ ...failedRow, confirmation_revision: 4 });
    const res = await receiveAndDrain(setupApp(), `/api/webhooks/interactions/run-a/retry?lineAccountId=${ACCOUNT_ID}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmed: true, interactionRevision: 2, webhookRevision: 3 }) }, baseEnv);
    expect(res.status).toBe(409); expect(await res.json()).toMatchObject({ error: 'confirmation_conflict', current: { id: 'run-a', confirmationRevision: 4 } }); expect(retryWebhookInteraction).not.toHaveBeenCalled();
  });
  test('provider待機中の手動再送は409で理由を返す', async () => {
    vi.mocked(getWebhookInteractionById).mockResolvedValue(failedRow);
    vi.mocked(retryWebhookInteraction).mockRejectedValueOnce(new Error('retry_after_pending'));
    const res=await receiveAndDrain(setupApp(),`/api/webhooks/interactions/run-a/retry?lineAccountId=${ACCOUNT_ID}`,
      {method:'POST',headers:{'Content-Type':'application/json'},body:'{}'},baseEnv);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({error:expect.stringContaining('待機期限')});
  });
  test('secretを読めない送り直しは503にし、秘密値を出さない(#650)', async () => {
    vi.mocked(getWebhookInteractionById).mockResolvedValue(failedRow);
    vi.mocked(retryWebhookInteraction).mockRejectedValueOnce(new Error('webhook_secret_unavailable'));
    const res = await receiveAndDrain(setupApp(),
      `/api/webhooks/interactions/run-a/retry?lineAccountId=${ACCOUNT_ID}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      keyedEnv,
    );
    expect(res.status).toBe(503);
    expect(retryWebhookInteraction).toHaveBeenCalledWith(keyedEnv.DB, failedRow, { current: TEST_KEY, previous: undefined });
    const retryBody = (await res.json()) as { error: string };
    expect(retryBody.error).toBe('secret を確認できないため送り直しを止めました');
  });

  // 1回で処理できるのは5件まで。残りを黙って置き去りにせず、
  // 残件数(remaining)を応答へ入れて画面が明示できるようにする。
  test('まとめてやり直しは上限を超えた分を remaining として返す', async () => {
    const items = Array.from({ length: 5 }, (_, index) => ({
      ...failedRow, id: `run-${index}`,
    }));
    vi.mocked(listFailedWebhookInteractionsForRetry).mockResolvedValue(items);
    vi.mocked(countFailedWebhookInteractionsForRetry).mockResolvedValue(8);
    vi.mocked(retryWebhookInteraction).mockResolvedValue({ ...failedRow, status: 'succeeded' });
    const res = await receiveAndDrain(setupApp(),
      `/api/webhooks/interactions/retry-failed?lineAccountId=${ACCOUNT_ID}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      baseEnv,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { requested: number; succeeded: number; failed: number; skipped: number; remaining: number };
    };
    expect(body.data).toMatchObject({ requested: 5, succeeded: 5, failed: 0, skipped: 0, remaining: 3 });
    expect(retryWebhookInteraction).toHaveBeenCalledTimes(5);
  });

  test('まとめてやり直しは残りが無いとき remaining=0 を返す', async () => {
    vi.mocked(listFailedWebhookInteractionsForRetry).mockResolvedValue([failedRow]);
    vi.mocked(countFailedWebhookInteractionsForRetry).mockResolvedValue(1);
    vi.mocked(retryWebhookInteraction).mockResolvedValue({ ...failedRow, status: 'succeeded' });
    const res = await receiveAndDrain(setupApp(),
      `/api/webhooks/interactions/retry-failed?lineAccountId=${ACCOUNT_ID}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      baseEnv,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { remaining: number } };
    expect(body.data.remaining).toBe(0);
  });

  // 「届いたか分からない」失敗を無条件で再送しない。
  // 確認なしの要求は 409 で止め、確かめた旨(confirmed)を添えた要求だけ通す。
  test('届いたか分からない失敗は、確認なしの送り直しを409で止める', async () => {
    vi.mocked(getWebhookInteractionById).mockResolvedValue({ ...failedRow, failure_reason: 'unknown' });
    const res = await receiveAndDrain(setupApp(),
      `/api/webhooks/interactions/run-a/retry?lineAccountId=${ACCOUNT_ID}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      baseEnv,
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('result_unknown_needs_check');
    expect(retryWebhookInteraction).not.toHaveBeenCalled();
  });

  test('届いたか分からない失敗は、確かめた確認つきなら送り直せる', async () => {
    vi.mocked(getWebhookInteractionById).mockResolvedValue({ ...failedRow, failure_reason: 'unknown' });
    vi.mocked(retryWebhookInteraction).mockResolvedValue({ ...failedRow, id: 'retry-a', status: 'succeeded' });
    const res = await receiveAndDrain(setupApp(),
      `/api/webhooks/interactions/run-a/retry?lineAccountId=${ACCOUNT_ID}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"confirmed":true}' },
      baseEnv,
    );
    expect(res.status).toBe(200);
    expect(retryWebhookInteraction).toHaveBeenCalledWith(
      baseEnv.DB,
      expect.objectContaining({ id: 'run-a', failure_reason: 'unknown' }),
      { current: undefined, previous: undefined },
    );
  });

  test('まとめてやり直しは結果不明の件数を needsReview で返し、残数へ混ぜない', async () => {
    vi.mocked(listFailedWebhookInteractionsForRetry).mockResolvedValue([failedRow]);
    vi.mocked(countFailedWebhookInteractionsForRetry).mockResolvedValue(1);
    vi.mocked(countUnverifiedWebhookInteractions).mockResolvedValue(2);
    vi.mocked(retryWebhookInteraction).mockResolvedValue({ ...failedRow, status: 'succeeded' });
    const res = await receiveAndDrain(setupApp(),
      `/api/webhooks/interactions/retry-failed?lineAccountId=${ACCOUNT_ID}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      baseEnv,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { remaining: number; needsReview: number } };
    expect(body.data).toMatchObject({ remaining: 0, needsReview: 2 });
    expect(retryWebhookInteraction).toHaveBeenCalledTimes(1);
  });
});

// =====================================================
//  中: 壊れた event_types の1行で一覧全体を500にしない (W2)
// =====================================================

describe('GET /api/webhooks/outgoing — broken event_types (#506 W2)', () => {
  const brokenRow = {
    id: 'wh-broken', name: '壊れた送り先', url: 'https://example.com/hook',
    event_types: '{broken-json', secret: VALID_SECRET, is_active: 1,
    max_retries: 0, consecutive_failures: 0, last_failed_at: null,
    created_at: '2026-08-01', updated_at: '2026-08-01',
  };

  test('壊れた行は空の種類で返し、一覧は 200 のまま', async () => {
    vi.mocked(getOutgoingWebhooks).mockResolvedValue([brokenRow]);
    const res = await receiveAndDrain(setupApp(),
      `/api/webhooks/outgoing?lineAccountId=${ACCOUNT_ID}`,
      { method: 'GET' },
      baseEnv,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { data: Array<{ id: string; eventTypes: unknown; name: string }> };
    expect(body.data).toHaveLength(1);
    expect(body.data[0].eventTypes).toEqual([]);
    expect(body.data[0].name).toBe('壊れた送り先');
  });
});

// =====================================================
//  中: 一覧にも受信詳細と同じ権限境界を適用する (W4)
// =====================================================

describe('webhook 一覧の権限統一 (#506 W4)', () => {
  test('権限キーのないスタッフは受信一覧を読めない', async () => {
    const res = await setupApp(undefined, 'staff', []).request(
      `/api/webhooks/incoming?lineAccountId=${ACCOUNT_ID}`,
      { method: 'GET' },
      baseEnv,
    );
    expect(res.status).toBe(403);
    expect(getIncomingWebhooks).not.toHaveBeenCalled();
  });

  test('権限キーのないスタッフは送信一覧を読めない', async () => {
    const res = await setupApp(undefined, 'staff', []).request(
      `/api/webhooks/outgoing?lineAccountId=${ACCOUNT_ID}`,
      { method: 'GET' },
      baseEnv,
    );
    expect(res.status).toBe(403);
    expect(getOutgoingWebhooks).not.toHaveBeenCalled();
  });

  test('/webhooks 権限ありスタッフは両方の一覧を読める', async () => {
    vi.mocked(getIncomingWebhooks).mockResolvedValue([]);
    vi.mocked(getOutgoingWebhooks).mockResolvedValue([]);
    for (const path of [
      `/api/webhooks/incoming?lineAccountId=${ACCOUNT_ID}`,
      `/api/webhooks/outgoing?lineAccountId=${ACCOUNT_ID}`,
    ]) {
      const res = await setupApp(undefined, 'staff', ['/webhooks']).request(
        path, { method: 'GET' }, baseEnv,
      );
      expect(res.status).toBe(200);
    }
  });
});

// =====================================================
//  中: 使われない受信設定口は API 単体テストで担保する (W5)
// =====================================================

describe('PATCH /api/webhooks/incoming/:id/config (#506 W5)', () => {
  const validBody = {
    expectedVersion: 3,
    identityMatching: {
      methods: [{ kind: 'harness_friend_id', path: '$.friend.id' }],
      onNotFound: 'do_nothing',
    },
    actions: [{ refKind: 'scenario', refId: 'scenario-a', refVersionId: 'version-a' }],
  };
  const patchConfig = (body: unknown) => receiveAndDrain(setupApp(),
    `/api/webhooks/incoming/iwh-1/config?lineAccountId=${ACCOUNT_ID}`,
    { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    baseEnv,
  );

  test('版の不一致は 409 と現在の版を返す', async () => {
    vi.mocked(updateIncomingWebhookConfig).mockResolvedValue({ status: 'conflict', currentVersion: 5 });
    const res = await patchConfig(validBody);
    expect(res.status).toBe(409);
    const body = await res.json() as { code: string; data: { currentVersion: number } };
    expect(body.code).toBe('version_conflict');
    expect(body.data.currentVersion).toBe(5);
  });

  test('入力不備は保存せず 400', async () => {
    const res = await patchConfig({ ...validBody, expectedVersion: 0 });
    expect(res.status).toBe(400);
    expect(updateIncomingWebhookConfig).not.toHaveBeenCalled();
  });
});

describe('名前・種別の上限 (#506 軽)', () => {
  const post = (path: string, body: unknown) => receiveAndDrain(setupApp(),
    path,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    baseEnv,
  );
  const validOutgoing = {
    name: 'test', url: 'https://example.com/hook', eventTypes: ['friend_add'],
    secret: VALID_SECRET, lineAccountId: ACCOUNT_ID,
    secret_encrypted: null,
  };

  test('送り先の作成は名前121文字・種別21件・種別101文字を400で拒否する', async () => {
    for (const body of [
      { ...validOutgoing, name: 'あ'.repeat(121) },
      { ...validOutgoing, eventTypes: Array.from({ length: 21 }, (_, i) => `type-${i}`) },
      { ...validOutgoing, eventTypes: [`${'a'.repeat(101)}`] },
    ]) {
      const res = await post('/api/webhooks/outgoing', body);
      expect(res.status).toBe(400);
    }
    expect(createOutgoingWebhook).not.toHaveBeenCalled();
  });

  test('受け取り口の作成は名前121文字を400で拒否する', async () => {
    const res = await post('/api/webhooks/incoming', {
      name: 'あ'.repeat(121), secret: VALID_SECRET, lineAccountId: ACCOUNT_ID,
    });
    expect(res.status).toBe(400);
    expect(createIncomingWebhook).not.toHaveBeenCalled();
  });
});

// =====================================================
//  eventTypes は実際に発火する種別だけを受け付ける
// =====================================================
//
// 形だけ見ていた検査では `mesage_received` のような誤記や
// `incoming_webhook.*` のような不発パターンが無音で保存され、
// イベントは一度も送られなかった。未知の種別は一覧を添えて400で拒否する。

describe('N-383 送信eventTypesは実発火種別と照合する', () => {
  const post = (body: unknown) => receiveAndDrain(setupApp(),
    '/api/webhooks/outgoing',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    baseEnv,
  );
  const put = (body: unknown) => receiveAndDrain(setupApp(),
    `/api/webhooks/outgoing/wh-1?lineAccountId=${ACCOUNT_ID}`,
    { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    baseEnv,
  );
  const validBody = {
    name: 'test', url: 'https://example.com/hook',
    secret: VALID_SECRET, lineAccountId: ACCOUNT_ID,
  };

  test.each([
    'mesage_received',       // 誤記
    'friend.added',          // 実在しない旧形に見える誤記
    'incoming_webhook.*',    // 照合規約上どの受信イベントにも一致しない誤用
    'calendar_booked',       // 自動化専用で送信Webhookへは届かない種別
  ])('未知の種別 %j の作成は400で一覧を添えて拒否する', async (eventType) => {
    const res = await post({ ...validBody, eventTypes: [eventType] });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain(eventType);
    expect(body.error).toContain('friend_add');
    expect(createOutgoingWebhook).not.toHaveBeenCalled();
  });

  test('未知の種別への更新は400で拒否し、POSTと同じ検査を通る', async () => {
    const res = await put({ eventTypes: ['friend_add', 'mesage_received'] });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('mesage_received');
    expect(updateOutgoingWebhook).not.toHaveBeenCalled();
  });

  test.each([
    '*',                          // 全部送る明示規約
    'friend_add',                 // 実発火種別
    'form_submitted',             // R150: フォーム回答の実発火種別
    'booking_created',            // R150: 予約受付の実発火種別
    'ec.order.confirmed',         // EC連携の実発火種別
    'incoming_webhook.custom',    // 受信口ごとの実発火種別
  ])('有効な種別 %j は作成を通す', async (eventType) => {
    vi.mocked(createOutgoingWebhook).mockResolvedValueOnce({
      id: 'wh-new', name: 'test', url: 'https://example.com/hook',
      event_types: JSON.stringify([eventType]), secret: VALID_SECRET, secret_encrypted: null,
      is_active: 1, max_retries: 0, consecutive_failures: 0, last_failed_at: null,
      created_at: '2026-05-08T00:00:00.000+09:00', updated_at: '2026-05-08T00:00:00.000+09:00',
    });
    const res = await post({ ...validBody, eventTypes: [eventType] });
    expect(res.status).toBe(201);
    expect(createOutgoingWebhook).toHaveBeenCalledWith(
      baseEnv.DB, expect.objectContaining({ eventTypes: [eventType] }), expect.anything(),
    );
  });
});

// =====================================================
//  secret-backfill口の契約
// =====================================================

describe('#650 POST /api/webhooks/maintenance/secret-backfill', () => {
  const report = {
    dryRun: true, batchSize: 50, legacyTotal: 2, rekeyTotal: 0,
    processed: 0, migrated: 0, failed: [], remainingLegacy: 2, remainingRekey: 0, done: false,
  };

  test('既定はdry-runで件数だけ返し、鍵束を渡す', async () => {
    vi.mocked(backfillWebhookSecrets).mockResolvedValueOnce(report);
    const res = await receiveAndDrain(setupApp(),
      '/api/webhooks/maintenance/secret-backfill',
      {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lineAccountId: ACCOUNT_ID }),
      },
      keyedEnv,
    );
    expect(res.status).toBe(200);
    expect(backfillWebhookSecrets).toHaveBeenCalledWith(keyedEnv.DB, {
      lineAccountId: ACCOUNT_ID, dryRun: true, batchSize: 50,
      keys: { current: TEST_KEY, previous: undefined },
    });
    const body = (await res.json()) as { data: typeof report };
    expect(body.data.legacyTotal).toBe(2);
    expect(body.data.done).toBe(false);
  });

  test('dryRun=falseとbatchSizeを通し、不正値は400にする', async () => {
    vi.mocked(backfillWebhookSecrets).mockResolvedValueOnce({ ...report, dryRun: false });
    const res = await receiveAndDrain(setupApp(),
      '/api/webhooks/maintenance/secret-backfill',
      {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lineAccountId: ACCOUNT_ID, dryRun: false, batchSize: 10 }),
      },
      keyedEnv,
    );
    expect(res.status).toBe(200);
    expect(backfillWebhookSecrets).toHaveBeenCalledWith(keyedEnv.DB, expect.objectContaining({
      dryRun: false, batchSize: 10,
    }));

    const bad = await receiveAndDrain(setupApp(),
      '/api/webhooks/maintenance/secret-backfill',
      {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lineAccountId: ACCOUNT_ID, batchSize: 0 }),
      },
      keyedEnv,
    );
    expect(bad.status).toBe(400);
    const missing = await receiveAndDrain(setupApp(),
      '/api/webhooks/maintenance/secret-backfill',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) },
      keyedEnv,
    );
    expect(missing.status).toBe(400);
  });

  test('他アカウントは403にし、鍵なしは503にする', async () => {
    vi.mocked(canAccessAllLineAccounts).mockResolvedValueOnce(false);
    const forbidden = await receiveAndDrain(setupApp(),
      '/api/webhooks/maintenance/secret-backfill',
      {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lineAccountId: 'account-b' }),
      },
      keyedEnv,
    );
    expect(forbidden.status).toBe(403);
    expect(backfillWebhookSecrets).not.toHaveBeenCalled();

    const keyError = new Error('LINE_CREDENTIAL_ENCRYPTION_KEY is not configured');
    keyError.name = 'CredentialEncryptionKeyError';
    vi.mocked(backfillWebhookSecrets).mockRejectedValueOnce(keyError);
    const noKey = await receiveAndDrain(setupApp(),
      '/api/webhooks/maintenance/secret-backfill',
      {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lineAccountId: ACCOUNT_ID }),
      },
      baseEnv,
    );
    expect(noKey.status).toBe(503);
  });
});

// =====================================================
//  secret の暗号化保存 — secret-safe と fail-closed の契約
// =====================================================

const TEST_KEY = btoa('k'.repeat(32));
// baseEnv と同じ理由で、受信口の予約 INSERT を受ける代役を置く。
const keyedEnv = {
  DB: { prepare: receiptPrepare } as unknown as D1Database,
  LINE_CREDENTIAL_ENCRYPTION_KEY: TEST_KEY,
} as Record<string, unknown>;
const ENCRYPTED_ROW = {
  id: 'wh-1', name: 'test', url: 'https://example.com/hook', event_types: '["*"]',
  secret: null, secret_encrypted: 'v1-enc-abc', is_active: 1, max_retries: 0,
  consecutive_failures: 0, last_failed_at: null,
  created_at: '2026-05-08', updated_at: '2026-05-08',
};
const BROKEN_ROW = { ...ENCRYPTED_ROW, secret_encrypted: 'v1-broken-xyz' };

describe('#650 secret-safe: 平文を保存・表示しない', () => {
  test('作成は鍵を渡して暗号化保存し、平文は作成直後の1回だけ返す', async () => {
    vi.mocked(createOutgoingWebhook).mockResolvedValueOnce({ ...ENCRYPTED_ROW, id: 'wh-new' });
    const res = await receiveAndDrain(setupApp(),
      `/api/webhooks/outgoing?lineAccountId=${ACCOUNT_ID}`,
      {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'test', url: 'https://example.com/hook',
          secret: VALID_SECRET, lineAccountId: ACCOUNT_ID,
          secret_encrypted: null,
        }),
      },
      keyedEnv,
    );
    expect(res.status).toBe(201);
    expect(createOutgoingWebhook).toHaveBeenCalledWith(
      keyedEnv.DB,
      expect.objectContaining({ secret: expect.stringMatching(/^[a-f0-9]{64}$/) }),
      { current: TEST_KEY, previous: undefined },
    );
    const body = (await res.json()) as { data: { secret: string } };
    expect(body.data.secret).toMatch(/^[a-f0-9]{64}$/);
    expect(body.data.secret).not.toBe(VALID_SECRET);
  });

  test('一覧・詳細は暗号文も含めてsecretを出さず、hasSecretだけ返す', async () => {
    vi.mocked(getOutgoingWebhooks).mockResolvedValueOnce([ENCRYPTED_ROW]);
    const list = await receiveAndDrain(setupApp(),
      `/api/webhooks/outgoing?lineAccountId=${ACCOUNT_ID}`,
      { method: 'GET' },
      baseEnv,
    );
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { data: Array<Record<string, unknown>> };
    expect(listBody.data[0].hasSecret).toBe(true);
    expect(listBody.data[0]).not.toHaveProperty('secret');
    expect(listBody.data[0]).not.toHaveProperty('secret_encrypted');
    expect(JSON.stringify(listBody)).not.toContain('v1-enc-abc');

    vi.mocked(getIncomingWebhookById).mockResolvedValueOnce({
      ...incomingWebhookRow(), secret: null, secret_encrypted: 'v1-enc-abc',
    });
    const detail = await receiveAndDrain(setupApp(),
      `/api/webhooks/incoming/iwh-1?lineAccountId=${ACCOUNT_ID}`,
      { method: 'GET' },
      baseEnv,
    );
    expect(detail.status).toBe(200);
    const detailBody = await detail.text();
    expect(detailBody).not.toContain('v1-enc-abc');
    expect(JSON.stringify(JSON.parse(detailBody).data)).not.toContain('secret_encrypted');
  });

  test('secretの入れ直しは鍵付きで保存し、2回目の保存が残る', async () => {
    const rotated = 'z'.repeat(32);
    vi.mocked(getOutgoingWebhookById)
      .mockResolvedValueOnce({ ...ENCRYPTED_ROW })
      .mockResolvedValueOnce({ ...ENCRYPTED_ROW, secret_encrypted: 'v1-enc-new' })
      .mockResolvedValueOnce({ ...ENCRYPTED_ROW, secret_encrypted: 'v1-enc-new' })
      .mockResolvedValueOnce({ ...ENCRYPTED_ROW, secret_encrypted: 'v1-enc-new', name: 'renamed' });
    const first = await receiveAndDrain(setupApp(),
      `/api/webhooks/outgoing/wh-1?lineAccountId=${ACCOUNT_ID}`,
      {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret: rotated }),
      },
      keyedEnv,
    );
    expect(first.status).toBe(200);
    expect(updateOutgoingWebhook).toHaveBeenCalledWith(
      keyedEnv.DB, 'wh-1', ACCOUNT_ID, expect.objectContaining({ secret: expect.stringMatching(/^[a-f0-9]{64}$/) }), { current: TEST_KEY, previous: undefined },
      expect.objectContaining({ updatedByStaffId: expect.any(String) }),
    );
    const second = await receiveAndDrain(setupApp(),
      `/api/webhooks/outgoing/wh-1?lineAccountId=${ACCOUNT_ID}`,
      {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'renamed' }),
      },
      keyedEnv,
    );
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { data: { name: string; hasSecret: boolean } };
    expect(secondBody.data.name).toBe('renamed');
    expect(secondBody.data.hasSecret).toBe(true);
  });
});

describe('#650 fail-closed: 鍵不足・復号失敗は安全に止める', () => {
  test('鍵なしの作成は503にし、秘密値を表に出さない', async () => {
    const keyError = new Error('LINE_CREDENTIAL_ENCRYPTION_KEY is not configured');
    keyError.name = 'CredentialEncryptionKeyError';
    vi.mocked(createOutgoingWebhook).mockRejectedValueOnce(keyError);
    const res = await receiveAndDrain(setupApp(),
      `/api/webhooks/outgoing?lineAccountId=${ACCOUNT_ID}`,
      {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'test', url: 'https://example.com/hook',
          secret: VALID_SECRET, lineAccountId: ACCOUNT_ID,
          secret_encrypted: null,
        }),
      },
      baseEnv,
    );
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain(VALID_SECRET);
  });

  test('復号できない送り先の再有効化は503にし、止めたままにする', async () => {
    vi.mocked(getOutgoingWebhookById).mockResolvedValueOnce({ ...BROKEN_ROW, is_active: 0 });
    const res = await receiveAndDrain(setupApp(),
      `/api/webhooks/outgoing/wh-1?lineAccountId=${ACCOUNT_ID}`,
      {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: true }),
      },
      keyedEnv,
    );
    expect(res.status).toBe(503);
    expect(updateOutgoingWebhook).not.toHaveBeenCalled();
  });

  test('復号できない送り先の試し送信は503にし、送らない', async () => {
    vi.mocked(getOutgoingWebhookById).mockResolvedValueOnce(BROKEN_ROW);
    const res = await receiveAndDrain(setupApp(),
      `/api/webhooks/outgoing/wh-1/test?lineAccountId=${ACCOUNT_ID}`,
      { method: 'POST' },
      keyedEnv,
    );
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain('v1-broken-xyz');
    expect(deliverOnce).not.toHaveBeenCalled();
  });

  test('試し送信は復号した値で署名し、他アカウントは403にする', async () => {
    vi.mocked(getOutgoingWebhookById).mockResolvedValueOnce(ENCRYPTED_ROW);
    const res = await receiveAndDrain(setupApp(),
      `/api/webhooks/outgoing/wh-1/test?lineAccountId=${ACCOUNT_ID}`,
      { method: 'POST' },
      keyedEnv,
    );
    expect(res.status).toBe(200);
    expect(resolveWebhookSecret).toHaveBeenCalledWith(expect.objectContaining({ id: 'wh-1' }), { current: TEST_KEY, previous: undefined });
    // 署名用の復号は配送側が行う。ここでは鍵がそのまま渡ることを見る。
    // 呼び出し元で復号した値を詰め替える形に戻すと、鍵を渡し忘れた経路が
    // 黙って署名なしで送るので、鍵の受け渡しの方を固定する。
    // 本文は共通封筒で、冪等キーは封筒の id と同じ値。
    const testCall = vi.mocked(deliverOnce).mock.calls[0]!;
    const sentBody = testCall[1] as string;
    const sendOptions = testCall[2] as { idempotencyKey?: string };
    expect(deliverOnce).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'wh-1', secret_encrypted: 'v1-enc-abc' }),
      expect.stringContaining('webhook.test'),
      expect.objectContaining({ credentialKeys: { current: TEST_KEY, previous: undefined } }),
    );
    const testEnvelope = JSON.parse(sentBody) as Record<string, unknown>;
    expect(testEnvelope).toMatchObject({ type: 'webhook.test', attempt: 1 });
    expect(sendOptions.idempotencyKey).toBe(testEnvelope.id);

    vi.mocked(canAccessAllLineAccounts).mockResolvedValueOnce(false);
    const forbidden = await receiveAndDrain(setupApp(),
      `/api/webhooks/outgoing/wh-1/test?lineAccountId=account-b`,
      { method: 'POST' },
      keyedEnv,
    );
    expect(forbidden.status).toBe(403);
  });

  test('受信照合は暗号文ではなく復号値で検証し、壊れた行は503にする', async () => {
    vi.mocked(getIncomingWebhookById).mockResolvedValueOnce({
      ...incomingWebhookRow(), secret: null, secret_encrypted: 'v1-enc-abc',
    });
    const okBody = JSON.stringify({ hello: 'world' });
    const ok = await receiveAndDrain(setupApp(),
      '/api/webhooks/incoming/iwh-1/receive',
      {
        method: 'POST', headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': await signedWith('r'.repeat(32), okBody),
        },
        body: okBody,
      },
      keyedEnv,
    );
    expect(ok.status).toBe(202);

    vi.mocked(getIncomingWebhookById).mockResolvedValueOnce({
      ...incomingWebhookRow(), secret: null, secret_encrypted: 'v1-broken-xyz',
    });
    const broken = await receiveAndDrain(setupApp(),
      '/api/webhooks/incoming/iwh-1/receive',
      {
        method: 'POST', headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': await signedWith('r'.repeat(32), okBody),
        },
        body: okBody,
      },
      keyedEnv,
    );
    expect(broken.status).toBe(503);
    expect(await broken.text()).not.toContain('v1-broken-xyz');

    // 旧平文が残っている行でも、暗号文が読めないなら旧平文へ落ちない。
    // 落ちると、鍵から外した古い secret の署名がいつまでも通ってしまう。
    const staleSecret = 'l'.repeat(32);
    vi.mocked(getIncomingWebhookById).mockResolvedValueOnce({
      ...incomingWebhookRow(), secret: staleSecret, secret_encrypted: 'v1-broken-xyz',
    });
    const stale = await receiveAndDrain(setupApp(),
      '/api/webhooks/incoming/iwh-1/receive',
      {
        method: 'POST', headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': await signedWith(staleSecret, okBody),
        },
        body: okBody,
      },
      keyedEnv,
    );
    expect(stale.status).toBe(503);
    const staleBody = await stale.text();
    expect(staleBody).not.toContain(staleSecret);
    expect(staleBody).not.toContain('v1-broken-xyz');
  });
});

const signedWith=signIncomingTest;
