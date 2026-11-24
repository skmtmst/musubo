import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeHmacSha256Hex } from '../lib/hmac.js';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';
import type { Env } from '../worker-env.js';

// 公開受信口 /api/conversions/ingest/:id の回帰テスト。
// 管理認証を通さず、地点ごとの受信鍵で HMAC-SHA256 を照合し、
// 成否を conversion_ingestion_events(recordConversionIngestionEvent)へ残す。

const dbMocks = vi.hoisted(() => ({
  getConversionPointForIngest: vi.fn(),
  resolveConversionIngestSecret: vi.fn(),
  recordConversionIngestionEvent: vi.fn(),
  trackConversion: vi.fn(),
  consumePublicIngressReceipt: vi.fn().mockResolvedValue(true),
}));
const contractMocks = vi.hoisted(() => ({
  ConversionDefinitionError: class ConversionDefinitionError extends Error {
    constructor(
      public readonly code: string,
      message: string,
      public readonly status: 400 | 404 | 409 = 409,
    ) {
      super(message);
    }
  },
}));

vi.mock('@line-crm/db', () => ({
  ...dbMocks,
  ConversionDefinitionError: contractMocks.ConversionDefinitionError,
}));
vi.mock('../services/account-access.js', () => ({
  canAccessAllLineAccounts: vi.fn(),
  getVisibleLineAccountScope: vi.fn(),
}));
vi.mock('../services/affiliate-notifier.js', () => ({ notifyAffiliateApproval: vi.fn() }));

const { conversions } = await import('./conversions.js');

const SECRET = 'cvwhk_testsecret';
let fixture: SqliteD1;

function app() {
  const hono = new Hono<Env>();
  hono.use('*', async (c, next) => {
    c.env = {
      DB: fixture.db,
      LINE_CREDENTIAL_ENCRYPTION_KEY: 'unused-in-mocks',
    } as Env['Bindings'];
    await next();
  });
  hono.route('/', conversions);
  return hono;
}

function activePoint(overrides: Record<string, unknown> = {}) {
  return {
    id: 'point-a',
    status: 'active',
    line_account_id: 'account-a',
    tenant_id: 'tenant-a',
    ingest_disabled_at: null,
    ingest_secret_encrypted: 'k1.v1.iv.ct',
    ...overrides,
  };
}

async function signedRequest(
  body: Record<string, unknown>,
  { eventId, secret = SECRET }: { eventId?: string; secret?: string } = {},
) {
  const raw = JSON.stringify({ timestamp: Math.floor(Date.now() / 1000), nonce: crypto.randomUUID(), ...body });
  const signature = await computeHmacSha256Hex(secret, raw);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'X-Conversion-Signature': signature,
  };
  if (eventId) headers['X-Conversion-Event-Id'] = eventId;
  return app().request('/api/conversions/ingest/point-a', {
    method: 'POST', headers, body: raw,
  });
}

function lastLog() {
  const calls = dbMocks.recordConversionIngestionEvent.mock.calls;
  return calls[calls.length - 1]?.[1] as Record<string, unknown> | undefined;
}

beforeEach(() => {
    fixture = createTestD1();
    fixture.raw.exec(`
      INSERT INTO line_accounts (id, channel_id, name, channel_secret, channel_access_token, tenant_id) VALUES
        ('account-a', '1001', 'A', 'secret', 'token', 'tenant-a'),
        ('account-b', '1002', 'B', 'secret', 'token', 'tenant-a'),
        ('account-c', '1003', 'C', 'secret', 'token', 'tenant-c');
      INSERT INTO friends (id, line_account_id, line_user_id) VALUES
        ('f1', 'account-a', 'U1'), ('friend-1', 'account-a', 'U2'),
        ('friend-b', 'account-b', 'U123'),
        ('friend-from-line', 'account-a', 'musubo-scope:friend-from-line:U123'),
        ('friend-c', 'account-c', 'musubo-scope:friend-c:U123');
    `);
    vi.clearAllMocks();
    dbMocks.getConversionPointForIngest.mockResolvedValue(activePoint());
    dbMocks.resolveConversionIngestSecret.mockResolvedValue(SECRET);
    dbMocks.recordConversionIngestionEvent.mockResolvedValue(undefined);
    dbMocks.trackConversion.mockImplementation(
      async (_db: unknown, _input: unknown, _opts: unknown, outcome?: { deduplicated?: boolean }) => {
        if (outcome) outcome.deduplicated = false;
        return { id: 'evt-1' };
      },
    );
  });
afterEach(() => fixture.raw.close());

describe('POST /api/conversions/ingest/:id (N-270)', () => {
  it('存在しない地点は404で、point_not_found を台帳へ残す', async () => {
    dbMocks.getConversionPointForIngest.mockResolvedValue(null);
    const response = await signedRequest({ friendId: 'f1' }, { eventId: 'e1' });
    expect(response.status).toBe(404);
    expect(lastLog()).toMatchObject({ conversionPointId: 'point-a', result: 'rejected', reason: 'point_not_found' });
    expect(dbMocks.trackConversion).not.toHaveBeenCalled();
  });

  it.each([
    ['draft', 'point_draft'],
    ['stopped', 'point_stopped'],
  ])('status=%s の地点は409で、%s を台帳へ残す', async (status, reason) => {
    dbMocks.getConversionPointForIngest.mockResolvedValue(activePoint({ status }));
    const response = await signedRequest({ friendId: 'f1' }, { eventId: 'e1' });
    expect(response.status).toBe(409);
    expect(lastLog()).toMatchObject({ result: 'rejected', reason });
  });

  it('外部受信を止めた地点は403で、ingest_disabled を台帳へ残す', async () => {
    dbMocks.getConversionPointForIngest.mockResolvedValue(
      activePoint({ ingest_disabled_at: '2026-09-20T00:00:00+09:00' }),
    );
    const response = await signedRequest({ friendId: 'f1' }, { eventId: 'e1' });
    expect(response.status).toBe(403);
    expect(lastLog()).toMatchObject({ result: 'rejected', reason: 'ingest_disabled' });
  });

  it('受信鍵が未発行なら503で、secret_not_issued を台帳へ残す', async () => {
    dbMocks.resolveConversionIngestSecret.mockResolvedValue(null);
    const response = await signedRequest({ friendId: 'f1' }, { eventId: 'e1' });
    expect(response.status).toBe(503);
    expect(lastLog()).toMatchObject({ result: 'rejected', reason: 'secret_not_issued' });
  });

  it('署名ヘッダが無ければ401で、signature_missing を台帳へ残す', async () => {
    const response = await app().request('/api/conversions/ingest/point-a', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ friendId: 'f1' }),
    });
    expect(response.status).toBe(401);
    expect(lastLog()).toMatchObject({ result: 'rejected', reason: 'signature_missing' });
  });

  it('署名が違えば401で、signature_mismatch と署名のSHA-256だけを台帳へ残す', async () => {
    const response = await signedRequest({ friendId: 'f1' }, { eventId: 'e1', secret: 'wrong-secret' });
    expect(response.status).toBe(401);
    const log = lastLog();
    expect(log).toMatchObject({ result: 'rejected', reason: 'signature_mismatch' });
    expect(typeof log?.signatureSha256).toBe('string');
    expect(log?.signatureSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(dbMocks.trackConversion).not.toHaveBeenCalled();
  });

  it('署名が正しくても本文がJSONでなければ400で、invalid_json を台帳へ残す', async () => {
    const raw = 'not-json';
    const signature = await computeHmacSha256Hex(SECRET, raw);
    const response = await app().request('/api/conversions/ingest/point-a', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Conversion-Signature': signature },
      body: raw,
    });
    expect(response.status).toBe(400);
    expect(lastLog()).toMatchObject({ result: 'rejected', reason: 'invalid_json' });
  });

  it('sourceEventId が無ければ400で、source_event_id_missing を台帳へ残す', async () => {
    const response = await signedRequest({ friendId: 'f1' });
    expect(response.status).toBe(400);
    expect(lastLog()).toMatchObject({ result: 'rejected', reason: 'source_event_id_missing' });
  });

  it('友だちを特定できなければ400で、friend_missing を台帳へ残す', async () => {
    const response = await signedRequest({ value: 100 }, { eventId: 'e1' });
    expect(response.status).toBe(400);
    expect(lastLog()).toMatchObject({ result: 'rejected', reason: 'friend_missing', sourceEventId: 'e1' });
  });

  it('署名・本文・友だちが揃えば成果を記録し、recorded を台帳へ残す', async () => {
    const response = await signedRequest(
      { friendId: 'friend-1', sourceEventId: 'evt-body-1', value: 500 },
    );
    expect(response.status).toBe(200);
    const json = (await response.json()) as { success: boolean; data: { received: boolean; duplicated: boolean } };
    expect(json.data).toMatchObject({ received: true, duplicated: false });
    expect(dbMocks.trackConversion).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        conversionPointId: 'point-a',
        friendId: 'friend-1',
        value: 500,
        idempotencyKey: 'cvingest:point-a:evt-body-1',
      }),
      undefined,
      expect.anything(),
    );
    expect(lastLog()).toMatchObject({
      result: 'recorded', sourceEventId: 'evt-body-1', friendId: 'friend-1',
    });
  });

  it('同じsourceEventIdの再送は duplicate として台帳へ残し、応答は duplicated:true', async () => {
    dbMocks.trackConversion.mockImplementation(
      async (_db: unknown, _input: unknown, _opts: unknown, outcome?: { deduplicated?: boolean }) => {
        if (outcome) outcome.deduplicated = true;
        return { id: 'evt-1' };
      },
    );
    const response = await signedRequest({ friendId: 'f1' }, { eventId: 'e-dup' });
    expect(response.status).toBe(200);
    const json = (await response.json()) as { data: { duplicated: boolean } };
    expect(json.data.duplicated).toBe(true);
    expect(lastLog()).toMatchObject({ result: 'duplicate', sourceEventId: 'e-dup' });
  });

  it('同じLINEユーザーが別店舗にもいる場合は地点の店舗に紐づく友だちを記録する', async () => {
    const response = await signedRequest({ lineUserId: 'U123', sourceEventId: 'e-line' });
    expect(response.status).toBe(200);
    expect(dbMocks.trackConversion).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ friendId: 'friend-from-line' }),
      undefined,
      expect.anything(),
    );
  });

  it('統括全体の地点では同じLINEユーザーが統括内に1人だけなら記録する', async () => {
    dbMocks.getConversionPointForIngest.mockResolvedValue(activePoint({ line_account_id: null, tenant_id: 'tenant-c' }));
    const response = await signedRequest({ lineUserId: 'U123', sourceEventId: 'e-tenant' });
    expect(response.status).toBe(200);
    expect(lastLog()).toMatchObject({ result: 'recorded', friendId: 'friend-c' });
  });

  it('統括全体の地点でLINEユーザーが複数店舗にいるときは友だちIDで特定する', async () => {
    dbMocks.getConversionPointForIngest.mockResolvedValue(activePoint({ line_account_id: null }));
    const ambiguous = await signedRequest({ lineUserId: 'U123', sourceEventId: 'e-ambiguous' });
    expect(ambiguous.status).toBe(422);
    expect(lastLog()).toMatchObject({ result: 'rejected', reason: 'friend_ambiguous' });
    expect(dbMocks.trackConversion).not.toHaveBeenCalled();

    const matched = await signedRequest({ friendId: 'friend-b', sourceEventId: 'e-explicit' });
    expect(matched.status).toBe(200);
    expect(lastLog()).toMatchObject({ result: 'recorded', friendId: 'friend-b' });
  });

  it('検証受信でも地点が対象外とする店舗の友だちを記録しない', async () => {
    const response = await signedRequest({ friendId: 'friend-b', sourceEventId: 'e-test', test: true });
    expect(response.status).toBe(422);
    expect(lastLog()).toMatchObject({ result: 'rejected', reason: 'friend_not_found', isTest: true });
    expect(lastLog()?.friendId).toBeUndefined();
    expect(dbMocks.trackConversion).not.toHaveBeenCalled();
  });

  it('冪等キー衝突(別内容の同ID)は409で、idempotency_conflict を台帳へ残す', async () => {
    dbMocks.trackConversion.mockRejectedValue(new Error('conversion_idempotency_conflict'));
    const response = await signedRequest({ friendId: 'f1' }, { eventId: 'e-conflict' });
    expect(response.status).toBe(409);
    expect(lastLog()).toMatchObject({ result: 'rejected', reason: 'idempotency_conflict' });
  });

  it('数えない条件に当てはまる受信は422で、excluded_by_condition を台帳へ残す(R40)', async () => {
    dbMocks.trackConversion.mockRejectedValue(new Error('conversion_excluded'));
    const response = await signedRequest({ friendId: 'f1' }, { eventId: 'e-excluded' });
    expect(response.status).toBe(422);
    expect(lastLog()).toMatchObject({ result: 'rejected', reason: 'excluded_by_condition' });
  });

  it('台帳の書き込みに失敗しても受信処理自体は止めない', async () => {
    dbMocks.recordConversionIngestionEvent.mockRejectedValue(new Error('ledger down'));
    const response = await signedRequest({ friendId: 'f1' }, { eventId: 'e1' });
    expect(response.status).toBe(200);
  });

  describe('#1037 IDEA-19: test:true の検証受信', () => {
    it('同じ検査を通すが成果表へ書かず、検証として台帳へ残す', async () => {
      const response = await signedRequest(
        { friendId: 'friend-1', sourceEventId: 'test-1', value: 500, test: true },
      );
      expect(response.status).toBe(200);
      const json = (await response.json()) as {
        success: boolean;
        data: { received: boolean; test: boolean; duplicated: boolean };
      };
      expect(json.data).toMatchObject({ received: true, test: true, duplicated: false });
      // 検証は成果表を触らない。売上・報酬・集計へ混入しないことの根拠。
      expect(dbMocks.trackConversion).not.toHaveBeenCalled();
      expect(lastLog()).toMatchObject({
        result: 'recorded', isTest: true,
        sourceEventId: 'test-1', friendId: 'friend-1',
      });
    });

    it('検証の再送でも成果表は触らず、検証の受信としてだけ残す', async () => {
      const first = await signedRequest({ friendId: 'f1', test: true }, { eventId: 'test-dup' });
      const second = await signedRequest({ friendId: 'f1', test: true }, { eventId: 'test-dup' });
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(dbMocks.trackConversion).not.toHaveBeenCalled();
      expect(lastLog()).toMatchObject({ result: 'recorded', isTest: true, sourceEventId: 'test-dup' });
    });

    it('検証でも友だちを特定できなければ400で、検証扱いの friend_missing を残す', async () => {
      const response = await signedRequest({ test: true, value: 100 }, { eventId: 'test-no-friend' });
      expect(response.status).toBe(400);
      expect(lastLog()).toMatchObject({
        result: 'rejected', reason: 'friend_missing', isTest: true, sourceEventId: 'test-no-friend',
      });
      expect(dbMocks.trackConversion).not.toHaveBeenCalled();
    });

    it('検証でもイベントIDが無ければ400で、検証扱いの source_event_id_missing を残す', async () => {
      const response = await signedRequest({ friendId: 'f1', test: true });
      expect(response.status).toBe(400);
      expect(lastLog()).toMatchObject({
        result: 'rejected', reason: 'source_event_id_missing', isTest: true,
      });
    });

    it('test が true でない値は本番の受信として扱う', async () => {
      const response = await signedRequest(
        { friendId: 'f1', sourceEventId: 'prod-1', test: 'true' },
      );
      expect(response.status).toBe(200);
      expect(dbMocks.trackConversion).toHaveBeenCalled();
      expect(lastLog()?.isTest).not.toBe(true);
    });
  });
});


describe('署名済み外部受信の新鮮さ', () => {
  it.each([0, Math.floor(Date.now() / 1000) + 600])('古い・未来すぎる時刻 %s は記録しない', async timestamp => {
    const response = await signedRequest({ timestamp, friendId: 'f1', sourceEventId: 'e1' });
    expect(response.status).toBe(401);
    expect(dbMocks.trackConversion).not.toHaveBeenCalled();
  });
  it('nonceを使い回すと別イベントIDでも記録しない', async () => {
    dbMocks.consumePublicIngressReceipt.mockResolvedValueOnce(false);
    const response = await signedRequest({ friendId: 'f1', sourceEventId: 'e2' });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'NONCE_REUSED' });
    expect(dbMocks.trackConversion).not.toHaveBeenCalled();
  });
});
