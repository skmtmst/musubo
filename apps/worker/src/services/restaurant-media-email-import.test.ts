import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';
import { seedRestaurantFixture } from '../test-utils/restaurant-fixture.js';
import type { Env } from '../worker-env.js';
import { routeInboundEmail } from './inbound-email-router.js';
import { deleteExpiredRestaurantRawEmails } from './restaurant-email-intake.js';
import { drainHeldReservationEmails } from './restaurant-media-email-resume.js';
import { expireHeldReservationEmails, loadStoreMediaEmailImportStates, quarantineReservationEmailAtomically } from './restaurant-media-email-import.js';
import { processStoredRestaurantEmail, type RestaurantMediaRow } from './restaurant-reservation-email.js';

type MockStaff = {
  id: string;
  name: string;
  role: 'owner' | 'admin' | 'staff';
  access_level: 'full' | 'read_only';
  permission_keys: string;
  assigned_line_account_id: string | null;
  can_access_descendant_accounts: number;
  tenant_id?: string | null;
};

const authMocks = vi.hoisted(() => ({
  getPlatformSetting: async () => 'false',
  getStaffByApiKey: vi.fn<(_db: unknown, token: string) => Promise<MockStaff | null>>(async () => null),
  getStaffByAdminSession: vi.fn(async (): Promise<MockStaff | null> => null),
  lineAccounts: [] as Array<Record<string, unknown>>,
}));

vi.mock('@line-crm/db', async () => {
  const actual = await vi.importActual<typeof import('@line-crm/db')>('@line-crm/db');
  return {
    ...actual,
    getStaffByApiKey: authMocks.getStaffByApiKey,
    getStaffByAdminSession: authMocks.getStaffByAdminSession,
    getLineAccounts: vi.fn(async () => authMocks.lineAccounts),
    getLineAccountScopeEntries: vi.fn(async () => authMocks.lineAccounts),
  };
});

const { authMiddleware } = await import('../middleware/auth.js');
const { restaurantTest } = await import('../routes/restaurant-test.js');

const here = dirname(fileURLToPath(import.meta.url));

class TestFixedLengthStream extends TransformStream<Uint8Array, Uint8Array> {
  constructor(expectedLength: number | bigint) {
    const expected = Number(expectedLength);
    let received = 0;
    super({
      transform(chunk, controller) {
        received += chunk.byteLength;
        if (received > expected) throw new Error('fixed-length stream overflow');
        controller.enqueue(chunk);
      },
      flush() {
        if (received !== expected) throw new Error('fixed-length stream underflow');
      },
    });
  }
}

type StoredObject = { body: string; customMetadata?: Record<string, string> };

let testDb: SqliteD1;
let rawObjects: Map<string, StoredObject>;
let env: Env['Bindings'];
let executionPromises: Promise<unknown>[];

function fakeRawMailBucket(): R2Bucket {
  return {
    put: vi.fn(async (key: string, value: ReadableStream, options?: R2PutOptions) => {
      const body = await new Response(value).text();
      rawObjects.set(key, { body, customMetadata: options?.customMetadata });
      return { key } as R2Object;
    }),
    get: vi.fn(async (key: string) => {
      const stored = rawObjects.get(key);
      if (!stored) return null;
      const bytes = new TextEncoder().encode(stored.body);
      return {
        key,
        size: bytes.byteLength,
        body: new Blob([bytes]).stream(),
      } as unknown as R2ObjectBody;
    }),
    delete: vi.fn(async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) rawObjects.delete(key);
    }),
  } as unknown as R2Bucket;
}

function makeEmail(input: {
  to: string;
  from: string;
  subject: string;
  date: string;
  body: string;
  messageId?: string;
}): ForwardableEmailMessage {
  const messageId = input.messageId ?? `<${crypto.randomUUID()}@example.test>`;
  const raw = [
    `From: ${input.from}`,
    `Date: ${input.date}`,
    `Subject: ${input.subject}`,
    `Message-ID: ${messageId}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    input.body,
  ].join('\r\n');
  return {
    from: input.from,
    to: input.to,
    raw: new Blob([raw]).stream(),
    rawSize: new TextEncoder().encode(raw).byteLength,
    headers: new Headers({
      subject: 'reservation',
      date: input.date,
      'message-id': messageId,
    }),
    setReject: vi.fn(),
    forward: vi.fn(),
    reply: vi.fn(),
  } as unknown as ForwardableEmailMessage;
}

function app() {
  const instance = new Hono<Env>();
  instance.use('*', authMiddleware);
  instance.route('/', restaurantTest);
  return instance;
}

async function apiRequest(
  path: string,
  options: { method?: string; body?: unknown; token?: string } = {},
) {
  const ctx = {
    waitUntil(promise: Promise<unknown>) {
      executionPromises.push(promise);
    },
    passThroughOnException() {},
  } as unknown as ExecutionContext;
  const method = options.method ?? (options.body === undefined ? 'GET' : 'PUT');
  const token = options.token ?? 'owner-key';
  const res = await app().fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    }),
    env,
    ctx,
  );
  await Promise.all(executionPromises.splice(0));
  return res;
}

beforeEach(() => {
  vi.stubGlobal('FixedLengthStream', TestFixedLengthStream);
  executionPromises = [];
  authMocks.getStaffByApiKey.mockReset();
  authMocks.getStaffByAdminSession.mockReset();
  authMocks.getStaffByAdminSession.mockResolvedValue(null);
  authMocks.lineAccounts = [
    { id: 'account-1', name: '統括', is_active: 1, channel_access_token: 'token-1' },
    { id: 'account-2', name: '銀座LINE', is_active: 1, channel_access_token: 'token-2' },
    { id: 'account-3', name: '渋谷LINE', is_active: 1, channel_access_token: 'token-3' },
  ];

  authMocks.getStaffByApiKey.mockImplementation(async (_db, token) => {
    if (token === 'admin-key') {
      return {
        id: 'staff-admin',
        name: '管理者',
        role: 'admin',
        access_level: 'full',
        permission_keys: '[]',
        assigned_line_account_id: null,
        can_access_descendant_accounts: 1,
        tenant_id: '00000000-0000-4000-8000-000000000001',
      };
    }
    if (token === 'staff-key') {
      return {
        id: 'staff-member',
        name: '担当者',
        role: 'staff',
        access_level: 'full',
        permission_keys: '["booking"]',
        assigned_line_account_id: null,
        can_access_descendant_accounts: 1,
        tenant_id: '00000000-0000-4000-8000-000000000001',
      };
    }
    if (token === 'readonly-admin-key') {
      return {
        id: 'staff-readonly',
        name: '閲覧管理者',
        role: 'admin',
        access_level: 'read_only',
        permission_keys: '[]',
        assigned_line_account_id: null,
        can_access_descendant_accounts: 1,
        tenant_id: '00000000-0000-4000-8000-000000000001',
      };
    }
    if (token === 'other-tenant-admin') {
      return {
        id: 'staff-other-tenant',
        name: '他組織管理者',
        role: 'admin',
        access_level: 'full',
        permission_keys: '[]',
        assigned_line_account_id: null,
        can_access_descendant_accounts: 1,
        tenant_id: 'tenant-other',
      };
    }
    return null;
  });

  testDb = createTestD1({ loginPolicy: 'off' });
  testDb.raw.exec(
    readFileSync(join(here, '../../../../packages/db/migrations/168_restaurant_test_foundation.sql'), 'utf8'),
  );
  testDb.raw.exec(
    readFileSync(join(here, '../../../../packages/db/migrations/175_restaurant_terms_agreement.sql'), 'utf8'),
  );
  testDb.raw
    .prepare(`UPDATE tenants SET feature_packs = '["restaurant"]' WHERE id = '00000000-0000-4000-8000-000000000001'`)
    .run();
  seedRestaurantFixture(testDb);
  testDb.raw.exec('DELETE FROM rt_reservations;');

  testDb.raw.exec(`
    INSERT INTO tenants (id, name, status, feature_packs)
      VALUES ('tenant-other', '別テナント', 'active', '["restaurant"]');
    INSERT INTO rt_organizations (id, account_id, tenant_id, name, status)
      VALUES ('org-other', 'account-other', 'tenant-other', '別組織', 'active');
    INSERT INTO rt_stores (id, organization_id, line_account_id, name, code, status)
      VALUES ('store-other', 'org-other', 'account-other', '別組織の店', 'OTHER', 'active');
    INSERT INTO rt_media (id, code, name, sender_addresses, parser_key, is_active, accepts_reservations) VALUES
      ('media-hotpepper', 'hotpepper', 'ホットペッパーグルメ', '["jp_kanri@hotpepper.jp"]', 'hotpepper', 1, 1),
      ('media-tabelog', 'tabelog', '食べログ', '["owner_support@tabelog.com"]', 'tabelog', 1, 1),
      ('media-gurunavi', 'gurunavi', 'ぐるなび', '["plan-reserve@gnavi.co.jp"]', 'gurunavi', 1, 1),
      ('media-retty', 'retty', 'Retty', '["reserve@retty.me"]', 'retty', 1, 1),
      ('media-ikyu', 'ikyu', '一休', '[]', 'ikyu', 0, 1),
      ('media-google', 'google_reservation', 'Google で予約', '[]', 'google_reservation', 0, 1),
      ('media-gourmet', 'gourmet_magazine', 'グルメ誌', '[]', 'gourmet_magazine', 0, 0);
    INSERT INTO rt_intake_addresses (id, local_part, store_id) VALUES
      ('addr-ginza', 'r-11111111111111111111111111111111', 'store-ginza'),
      ('addr-yokohama', 'r-22222222222222222222222222222222', 'store-yokohama');
  `);

  rawObjects = new Map();
  env = {
    DB: testDb.db,
    API_KEY: 'owner-key',
    IMAGES: {} as R2Bucket,
    RAW_MAIL: fakeRawMailBucket(),
    ASSETS: {} as Fetcher,
    RESTAURANT_INTAKE_DOMAIN: 'intake.example.test',
    DEPLOY_ENV: 'test',
    RESTAURANT_TEST_ENABLED: 'true',
    LINE_CHANNEL_SECRET: 'unused',
    LINE_CHANNEL_ACCESS_TOKEN: 'unused',
    LIFF_URL: 'https://example.test',
    LINE_CHANNEL_ID: 'unused',
    LINE_LOGIN_CHANNEL_ID: 'unused',
    LINE_LOGIN_CHANNEL_SECRET: 'unused',
    WORKER_URL: 'https://worker.example.test',
    LINE_CREDENTIAL_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const ginzaRecipient = 'r-11111111111111111111111111111111@intake.example.test';
const shibuyaRecipient = 'r-22222222222222222222222222222222@intake.example.test';

function hotpepperBookingBody(externalId: string, guests: number, dateTime = '2026年8月30日(日) 18:30'): string {
  return [
    `■予約依頼番号：${externalId}`,
    `■来店日時：${dateTime}`,
    '■代表者：テスト 太郎様',
    '■コース：季節コース',
    '■席情報：テーブル',
    `■人数：${guests}名様`,
  ].join('\n');
}

describe('店舗×媒体ごとの予約メール取り込み停止・再開', () => {
  it('既存店舗は初期状態で有効であり、店舗と媒体の境界を越えて影響しない', async () => {
    const initialChannels = (await (
      await apiRequest('/api/restaurant-test/channels?account_id=account-1&storeId=store-ginza')
    ).json()) as { data: Array<Record<string, unknown>> };
    const hpInitial = initialChannels.data.find((item) => item.code === 'hotpepper')!;
    expect(hpInitial).toMatchObject({
      emailImportSupported: true,
      emailImportEnabled: true,
      emailImportVersion: 0,
      heldCount: 0,
      expiringHeldCount: 0,
    });
    expect(initialChannels.data.find((item) => item.code === 'ikyu')).toMatchObject({
      emailImportSupported: false,
      emailImportEnabled: false,
    });
    expect(initialChannels.data.find((item) => item.code === 'google_reservation')).toMatchObject({
      emailImportSupported: false,
      emailImportEnabled: false,
    });

    const linksRes = (await (
      await apiRequest('/api/restaurant-test/media-links?account_id=account-1&storeId=store-ginza')
    ).json()) as { data: Array<Record<string, unknown>> };
    expect(linksRes.data.find((item) => item.code === 'hotpepper')?.emailImportSupported).toBe(1);
    expect(linksRes.data.find((item) => item.code === 'gourmet_magazine')?.emailImportSupported).toBe(0);
    expect(linksRes.data.find((item) => item.code === 'ikyu')?.emailImportSupported).toBe(0);

    const stopRes = await apiRequest(
      '/api/restaurant-test/media-email-import/hotpepper?account_id=account-1',
      {
        method: 'PUT',
        token: 'admin-key',
        body: { storeId: 'store-ginza', enabled: false, expectedVersion: 0 },
      },
    );
    expect(stopRes.status).toBe(200);
    expect((await stopRes.json()) as Record<string, unknown>).toMatchObject({
      success: true,
      data: {
        storeId: 'store-ginza',
        code: 'hotpepper',
        emailImportEnabled: false,
        emailImportVersion: 1,
        heldCount: 0,
      },
    });

    expect(
      testDb.raw.prepare(`SELECT is_active FROM rt_media WHERE code = 'hotpepper'`).get(),
    ).toEqual({ is_active: 1 });

    await routeInboundEmail(
      makeEmail({
        to: shibuyaRecipient,
        from: 'jp_kanri@hotpepper.jp',
        subject: '【即予約】予約の申し込み',
        date: 'Sat, 22 Aug 2026 12:00:00 +0900',
        body: hotpepperBookingBody('HP-SHIBUYA-1', 2),
      }),
      env,
    );
    await routeInboundEmail(
      makeEmail({
        to: ginzaRecipient,
        from: 'owner_support@tabelog.com',
        subject: '【新規予約】ネット予約のお知らせ',
        date: 'Sat, 22 Aug 2026 12:05:00 +0900',
        body: [
          'https://owner.tabelog.com/tn/time-schedule/2026-08-30?bookingId=TB-GINZA-1',
          '日付：8/30',
          '来店時刻：19:00',
          'お名前：食べログ 花子様',
          '人数：3名',
        ].join('\n'),
      }),
      env,
    );
    await routeInboundEmail(
      makeEmail({
        to: ginzaRecipient,
        from: 'jp_kanri@hotpepper.jp',
        subject: '【即予約】予約の申し込み',
        date: 'Sat, 22 Aug 2026 12:10:00 +0900',
        body: hotpepperBookingBody('HP-GINZA-HELD', 4),
      }),
      env,
    );

    expect(
      testDb.raw.prepare(`SELECT store_id, source, external_id FROM rt_reservations ORDER BY external_id`).all(),
    ).toEqual([
      { store_id: 'store-yokohama', source: 'hotpepper', external_id: 'HP-SHIBUYA-1' },
      { store_id: 'store-ginza', source: 'tabelog', external_id: 'TB-GINZA-1' },
    ]);

    const yokohamaChannels = (await (
      await apiRequest('/api/restaurant-test/channels?account_id=account-1&storeId=store-yokohama')
    ).json()) as { data: Array<Record<string, unknown>> };
    expect(yokohamaChannels.data.find((item) => item.code === 'hotpepper')).toMatchObject({
      emailImportEnabled: true,
      heldCount: 0,
    });
  });

  it('権限・閲覧専用・他組織・非対象媒体・版競合を検証し監査ログを残す', async () => {
    const staffAttempt = await apiRequest(
      '/api/restaurant-test/media-email-import/hotpepper?account_id=account-1',
      {
        method: 'PUT',
        token: 'staff-key',
        body: { storeId: 'store-ginza', enabled: false, expectedVersion: 0 },
      },
    );
    expect(staffAttempt.status).toBe(403);

    const readonlyAttempt = await apiRequest(
      '/api/restaurant-test/media-email-import/hotpepper?account_id=account-1',
      {
        method: 'PUT',
        token: 'readonly-admin-key',
        body: { storeId: 'store-ginza', enabled: false, expectedVersion: 0 },
      },
    );
    expect(readonlyAttempt.status).toBe(403);

    const directReadonlyApp = new Hono<Env>();
    directReadonlyApp.use('*', async (c, next) => {
      c.set('staff', {
        id: 'staff-view-only',
        name: '閲覧のみ',
        role: 'admin',
        readOnly: true,
        tenantId: '00000000-0000-4000-8000-000000000001',
      });
      await next();
    });
    directReadonlyApp.route('/', restaurantTest);
    const directReadonlyRes = await directReadonlyApp.fetch(
      new Request('http://localhost/api/restaurant-test/media-email-import/hotpepper?account_id=account-1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storeId: 'store-ginza', enabled: false, expectedVersion: 0 }),
      }),
      env,
      { waitUntil: (p: Promise<unknown>) => executionPromises.push(p), passThroughOnException() {} } as unknown as ExecutionContext,
    );
    await Promise.all(executionPromises.splice(0));
    expect(directReadonlyRes.status).toBe(403);

    const otherStoreAttempt = await apiRequest(
      '/api/restaurant-test/media-email-import/hotpepper?account_id=account-1',
      {
        method: 'PUT',
        token: 'admin-key',
        body: { storeId: 'store-other', enabled: false, expectedVersion: 0 },
      },
    );
    expect(otherStoreAttempt.status).toBe(400);
    expect(await otherStoreAttempt.json()).toMatchObject({ code: 'restaurant_store_mismatch' });

    const otherTenantAttempt = await apiRequest(
      '/api/restaurant-test/media-email-import/hotpepper?account_id=account-1',
      {
        method: 'PUT',
        token: 'other-tenant-admin',
        body: { storeId: 'store-ginza', enabled: false, expectedVersion: 0 },
      },
    );
    expect([400, 403, 404]).toContain(otherTenantAttempt.status);

    const gourmetAttempt = await apiRequest(
      '/api/restaurant-test/media-email-import/gourmet_magazine?account_id=account-1',
      {
        method: 'PUT',
        token: 'owner-key',
        body: { storeId: 'store-ginza', enabled: false, expectedVersion: 0 },
      },
    );
    expect(gourmetAttempt.status).toBe(400);

    const okStop = await apiRequest(
      '/api/restaurant-test/media-email-import/hotpepper?account_id=account-1',
      {
        method: 'PUT',
        token: 'owner-key',
        body: { storeId: 'store-ginza', enabled: false, expectedVersion: 0 },
      },
    );
    expect(okStop.status).toBe(200);

    const missingHeldAction = await apiRequest(
      '/api/restaurant-test/media-email-import/hotpepper?account_id=account-1',
      {
        method: 'PUT',
        token: 'owner-key',
        body: { storeId: 'store-ginza', enabled: true, expectedVersion: 1 },
      },
    );
    expect(missingHeldAction.status).toBe(400);

    const conflictAttempt = await apiRequest(
      '/api/restaurant-test/media-email-import/hotpepper?account_id=account-1',
      {
        method: 'PUT',
        token: 'owner-key',
        body: { storeId: 'store-ginza', enabled: true, expectedVersion: 0, heldAction: 'archive' },
      },
    );
    expect(conflictAttempt.status).toBe(409);
    expect(await conflictAttempt.json()).toMatchObject({ code: 'version_conflict' });

    const audits = testDb.raw
      .prepare(`SELECT action, result, target_id, after_json FROM audit_events WHERE action LIKE 'restaurant.media_email_import.%' ORDER BY created_at, id`)
      .all() as Array<{ action: string; result: string; target_id: string; after_json: string | null }>;
    expect(audits.some((row) => row.action === 'restaurant.media_email_import.stop' && row.result === 'denied')).toBe(true);
    expect(audits.some((row) => row.action === 'restaurant.media_email_import.stop' && row.result === 'success' && row.target_id === 'store-ginza:hotpepper')).toBe(true);
    expect(audits.some((row) => row.action === 'restaurant.media_email_import.resume' && row.result === 'failed')).toBe(true);
  });

  it('停止中の新規・変更・取消・重複メールを台帳に入れず保管し、再開時に順番どおり1回だけ取り込む', async () => {
    await apiRequest('/api/restaurant-test/media-email-import/hotpepper?account_id=account-1', {
      method: 'PUT',
      body: { storeId: 'store-ginza', enabled: false, expectedVersion: 0 },
    });

    const dupMessageId = '<hp-500-new@example.test>';
    await routeInboundEmail(
      makeEmail({
        to: ginzaRecipient,
        from: 'jp_kanri@hotpepper.jp',
        subject: '【即予約】予約の申し込み',
        date: 'Sat, 22 Aug 2026 12:00:00 +0900',
        body: hotpepperBookingBody('HP-500', 2, '2026年8月30日(日) 18:30'),
        messageId: dupMessageId,
      }),
      env,
    );
    await routeInboundEmail(
      makeEmail({
        to: ginzaRecipient,
        from: 'jp_kanri@hotpepper.jp',
        subject: '【即予約】予約の申し込み',
        date: 'Sat, 22 Aug 2026 12:00:00 +0900',
        body: hotpepperBookingBody('HP-500', 2, '2026年8月30日(日) 18:30'),
        messageId: dupMessageId,
      }),
      env,
    );
    await routeInboundEmail(
      makeEmail({
        to: ginzaRecipient,
        from: 'jp_kanri@hotpepper.jp',
        subject: '予約内容の変更処理完了のお知らせ',
        date: 'Sat, 22 Aug 2026 13:00:00 +0900',
        body: [
          '■予約依頼番号：HP-500',
          '■代表者：テスト 太郎様',
          '【変更後】',
          '■ステータス：未対応',
          '■来店日時：2026年8月30日(日) 19:00',
          '■人数：4名様',
          '■コース：特選コース',
          '■席情報：個室',
          '【変更前】',
          '■来店日時：2026年8月30日(日) 18:30',
          '■人数：2名様',
        ].join('\n'),
      }),
      env,
    );
    await routeInboundEmail(
      makeEmail({
        to: ginzaRecipient,
        from: 'jp_kanri@hotpepper.jp',
        subject: '【即予約】予約の申し込み',
        date: 'Sat, 22 Aug 2026 14:00:00 +0900',
        body: hotpepperBookingBody('HP-501', 3, '2026年8月30日(日) 20:00'),
      }),
      env,
    );
    await routeInboundEmail(
      makeEmail({
        to: ginzaRecipient,
        from: 'jp_kanri@hotpepper.jp',
        subject: '予約のキャンセル',
        date: 'Sat, 22 Aug 2026 15:00:00 +0900',
        body: [
          '■予約依頼番号：HP-501',
          '■代表者：キャンセル 次郎様',
          '■来店日時：2026年8月30日(日) 20:00',
          '■人数：3名様',
          '■キャンセル理由：都合によりキャンセル',
        ].join('\n'),
      }),
      env,
    );

    expect(testDb.raw.prepare('SELECT COUNT(*) AS count FROM rt_reservations').get()).toEqual({ count: 0 });
    expect(rawObjects.size).toBe(4);

    const stoppedChannels = (await (
      await apiRequest('/api/restaurant-test/channels?account_id=account-1&storeId=store-ginza')
    ).json()) as { data: Array<Record<string, unknown>> };
    expect(stoppedChannels.data.find((item) => item.code === 'hotpepper')).toMatchObject({
      status: 'receiving',
      emailImportEnabled: false,
      emailImportVersion: 1,
      heldCount: 4,
    });

    const resumeRes = await apiRequest(
      '/api/restaurant-test/media-email-import/hotpepper?account_id=account-1',
      {
        method: 'PUT',
        body: { storeId: 'store-ginza', enabled: true, expectedVersion: 1, heldAction: 'import' },
      },
    );
    expect(resumeRes.status).toBe(200);
    expect(await resumeRes.json()).toMatchObject({
      success: true,
      data: {
        emailImportEnabled: true,
        emailImportVersion: 2,
        heldCount: 0,
        importedCount: 4,
        failedHeldCount: 0,
      },
    });

    const reservations = testDb.raw
      .prepare(`SELECT external_id, guest_count, status, confirmation_revision FROM rt_reservations WHERE store_id = 'store-ginza' ORDER BY external_id`)
      .all() as Array<{ external_id: string; guest_count: number; status: string; confirmation_revision: number }>;
    expect(reservations).toEqual([
      { external_id: 'HP-500', guest_count: 4, status: 'pending', confirmation_revision: 2 },
      { external_id: 'HP-501', guest_count: 3, status: 'cancelled', confirmation_revision: 2 },
    ]);

    const media = testDb.raw
      .prepare(`SELECT id, code, name, parser_key FROM rt_media WHERE code = 'hotpepper'`)
      .get() as RestaurantMediaRow;
    const [secondDrainA, secondDrainB] = await Promise.all([
      drainHeldReservationEmails(env, 'store-ginza', media),
      drainHeldReservationEmails(env, 'store-ginza', media),
    ]);
    expect(secondDrainA.importedCount + secondDrainB.importedCount).toBe(0);
    expect(
      testDb.raw
        .prepare(`SELECT external_id, confirmation_revision FROM rt_reservations WHERE store_id = 'store-ginza' ORDER BY external_id`)
        .all(),
    ).toEqual([
      { external_id: 'HP-500', confirmation_revision: 2 },
      { external_id: 'HP-501', confirmation_revision: 2 },
    ]);
  });

  it('メール解析の途中で停止に切り替わった場合は原子的に書き込みを拒否し保留へ回す', async () => {
    const key = 'restaurant-intake/store-ginza/race.eml';
    rawObjects.set(key, {
      body: [
        'From: jp_kanri@hotpepper.jp',
        'Date: Sat, 22 Aug 2026 12:00:00 +0900',
        'Subject: 【即予約】予約の申し込み',
        'Message-ID: <race@example.test>',
        '',
        hotpepperBookingBody('HP-RACE-1', 2),
      ].join('\r\n'),
    });
    testDb.raw
      .prepare(`INSERT INTO rt_inbound_emails (id, message_id, store_id, r2_key, status, size_bytes)
        VALUES ('mail-race', '<race@example.test>', 'store-ginza', ?, 'stored', 200)`)
      .run(key);
    testDb.raw
      .prepare(`INSERT INTO rt_sync_events (id, store_id, provider, external_event_id, payload_json, status)
        VALUES ('ev-race', 'store-ginza', 'email', '<race@example.test>', '{"subject":"【即予約】予約の申し込み"}', 'received')`)
      .run();

    const media = testDb.raw
      .prepare(`SELECT id, code, name, parser_key FROM rt_media WHERE code = 'hotpepper'`)
      .get() as RestaurantMediaRow;

    const result = await processStoredRestaurantEmail(
      {
        env,
        storeId: 'store-ginza',
        inboundEmailId: 'mail-race',
        eventId: 'ev-race',
        objectKey: key,
        media,
        fallbackSubject: '【即予約】予約の申し込み',
        fallbackDate: 'Sat, 22 Aug 2026 12:00:00 +0900',
      },
      {
        mode: 'live',
        beforeCommitHook: async () => {
          testDb.raw
            .prepare(`INSERT INTO rt_store_media_email_settings (store_id, media_id, enabled, version, updated_by)
              VALUES ('store-ginza', 'media-hotpepper', 0, 1, 'owner')`)
            .run();
        },
      },
    );

    expect(result.outcome).toBe('held');
    expect(testDb.raw.prepare('SELECT COUNT(*) AS count FROM rt_reservations').get()).toEqual({ count: 0 });
    expect(
      testDb.raw.prepare(`SELECT state FROM rt_held_reservation_emails WHERE inbound_email_id = 'mail-race'`).get(),
    ).toEqual({ state: 'held' });
  });

  it('解析失敗の直前に停止したメールは保留し、別の処理が完了した後の古い失敗は反映しない', async () => {
    testDb.raw.prepare(`INSERT INTO rt_inbound_emails (id, message_id, store_id, r2_key, status, size_bytes)
      VALUES ('mail-failed-race', '<failed-race@example.test>', 'store-ginza', 'race.eml', 'stored', 100)`).run();
    testDb.raw.prepare(`INSERT INTO rt_sync_events (id, store_id, provider, external_event_id, payload_json, status)
      VALUES ('ev-failed-race', 'store-ginza', 'email', '<failed-race@example.test>', '{}', 'received')`).run();
    const media = testDb.raw.prepare(`SELECT id, code, name, parser_key FROM rt_media WHERE code = 'hotpepper'`).get() as RestaurantMediaRow;
    testDb.raw.prepare(`INSERT INTO rt_store_media_email_settings (store_id, media_id, enabled, version, updated_by)
      VALUES ('store-ginza', 'media-hotpepper', 0, 1, 'owner')`).run();
    const input = { env, storeId: 'store-ginza', inboundEmailId: 'mail-failed-race', eventId: 'ev-failed-race', media,
      now: new Date(), payload: {}, reason: 'unprocessed:kind_unknown' };
    expect(await quarantineReservationEmailAtomically({ ...input, mode: 'live', observedVersion: 0 })).toBe('held');
    expect(testDb.raw.prepare(`SELECT status FROM rt_inbound_emails WHERE id = 'mail-failed-race'`).get()).toEqual({ status: 'stored' });
    expect(testDb.raw.prepare(`SELECT json_extract(payload_json, '$.held') AS held FROM rt_sync_events WHERE id = 'ev-failed-race'`).get()).toEqual({ held: 1 });
    testDb.raw.prepare(`UPDATE rt_store_media_email_settings SET enabled = 1, version = 2`).run();
    testDb.raw.prepare(`UPDATE rt_held_reservation_emails SET state = 'processing', claim_token = 'old-claim', claim_expires_at = ? WHERE inbound_email_id = 'mail-failed-race'`)
      .run(new Date(input.now.getTime() - 60_000).toISOString());
    expect(await quarantineReservationEmailAtomically({ ...input, mode: 'resume', claimToken: 'old-claim' })).toBe('skipped');
    expect(testDb.raw.prepare(`SELECT status FROM rt_sync_events WHERE id = 'ev-failed-race'`).get()).toEqual({ status: 'received' });
    testDb.raw.prepare(`UPDATE rt_held_reservation_emails SET state = 'processing', claim_token = 'new-claim', claim_expires_at = ? WHERE inbound_email_id = 'mail-failed-race'`)
      .run(new Date(input.now.getTime() + 60_000).toISOString());
    expect(await quarantineReservationEmailAtomically({ ...input, mode: 'resume', claimToken: 'old-claim' })).toBe('skipped');
    expect(testDb.raw.prepare(`SELECT status FROM rt_sync_events WHERE id = 'ev-failed-race'`).get()).toEqual({ status: 'received' });
    expect(testDb.raw.prepare(`SELECT state, claim_token FROM rt_held_reservation_emails WHERE inbound_email_id = 'mail-failed-race'`).get()).toEqual({ state: 'processing', claim_token: 'new-claim' });
    testDb.raw.prepare(`UPDATE rt_held_reservation_emails SET state = 'processed', claim_token = NULL WHERE inbound_email_id = 'mail-failed-race'`).run();
    testDb.raw.prepare(`UPDATE rt_sync_events SET status = 'processed' WHERE id = 'ev-failed-race'`).run();
    expect(await quarantineReservationEmailAtomically({ ...input, mode: 'resume', claimToken: 'old-claim' })).toBe('skipped');
    expect(testDb.raw.prepare(`SELECT status FROM rt_sync_events WHERE id = 'ev-failed-race'`).get()).toEqual({ status: 'processed' });
    expect(testDb.raw.prepare(`SELECT status FROM rt_inbound_emails WHERE id = 'mail-failed-race'`).get()).toEqual({ status: 'stored' });
  });

  it('再開時の一時失敗は有効のまま保留を再試行でき、二重登録しない', async () => {
    await apiRequest('/api/restaurant-test/media-email-import/hotpepper?account_id=account-1', {
      method: 'PUT', body: { storeId: 'store-ginza', enabled: false, expectedVersion: 0 },
    });
    await routeInboundEmail(makeEmail({ to: ginzaRecipient, from: 'jp_kanri@hotpepper.jp',
      subject: '【即予約】予約の申し込み', date: 'Sat, 22 Aug 2026 12:00:00 +0900', body: hotpepperBookingBody('HP-RETRY', 2) }), env);
    vi.mocked(env.RAW_MAIL!.get).mockRejectedValueOnce(new Error('PRIVATE_EMAIL_CONTENT'));
    const first = await apiRequest('/api/restaurant-test/media-email-import/hotpepper?account_id=account-1', {
      method: 'PUT', body: { storeId: 'store-ginza', enabled: true, expectedVersion: 1, heldAction: 'import' },
    });
    expect(await first.json()).toMatchObject({ data: { emailImportEnabled: true, heldCount: 1, failedHeldCount: 1 } });
    expect(testDb.raw.prepare(`SELECT last_error FROM rt_held_reservation_emails WHERE state = 'held'`).get()).toEqual({ last_error: 'unprocessed:raw_mail_read_failed' });
    const retry = await apiRequest('/api/restaurant-test/media-email-import/hotpepper?account_id=account-1', {
      method: 'PUT', body: { storeId: 'store-ginza', enabled: true, expectedVersion: 2, heldAction: 'import' },
    });
    expect(await retry.json()).toMatchObject({ data: { emailImportVersion: 2, heldCount: 0, importedCount: 1, failedHeldCount: 0 } });
    expect(testDb.raw.prepare(`SELECT COUNT(*) AS count FROM rt_reservations WHERE external_id = 'HP-RETRY'`).get()).toEqual({ count: 1 });
  });

  it('再開時に保管だけを選んだ場合は原文を残したまま台帳へ入れず、その後の新着は通常どおり取り込む', async () => {
    await apiRequest('/api/restaurant-test/media-email-import/hotpepper?account_id=account-1', {
      method: 'PUT',
      body: { storeId: 'store-ginza', enabled: false, expectedVersion: 0 },
    });

    await routeInboundEmail(
      makeEmail({
        to: ginzaRecipient,
        from: 'jp_kanri@hotpepper.jp',
        subject: '【即予約】予約の申し込み',
        date: 'Sat, 22 Aug 2026 12:00:00 +0900',
        body: hotpepperBookingBody('HP-ARCHIVE-ONLY', 2),
      }),
      env,
    );

    const resumeArchive = await apiRequest(
      '/api/restaurant-test/media-email-import/hotpepper?account_id=account-1',
      {
        method: 'PUT',
        body: { storeId: 'store-ginza', enabled: true, expectedVersion: 1, heldAction: 'archive' },
      },
    );
    expect(resumeArchive.status).toBe(200);
    expect(await resumeArchive.json()).toMatchObject({
      data: {
        emailImportEnabled: true,
        heldCount: 0,
        importedCount: 0,
        archivedCount: 1,
      },
    });
    expect(testDb.raw.prepare('SELECT COUNT(*) AS count FROM rt_reservations').get()).toEqual({ count: 0 });
    expect(rawObjects.size).toBe(1);
    expect(
      testDb.raw.prepare(`SELECT state FROM rt_held_reservation_emails`).get(),
    ).toEqual({ state: 'archived' });
    const timing = testDb.raw.prepare(`SELECT e.received_at, h.expires_at FROM rt_held_reservation_emails h JOIN rt_inbound_emails e ON e.id = h.inbound_email_id`).get() as { received_at: string; expires_at: string };
    const receivedAt = /(?:Z|[+-]\d\d:\d\d)$/.test(timing.received_at) ? timing.received_at : `${timing.received_at.replace(' ', 'T')}Z`;
    expect(Date.parse(timing.expires_at) - Date.parse(receivedAt)).toBe(30 * 86_400_000 - 6 * 60 * 60_000 - 5 * 60_000);

    const warning = (await loadStoreMediaEmailImportStates(testDb.db, 'store-ginza', new Date(Date.now() + 24 * 86_400_000))).get('media-hotpepper');
    expect(warning).toMatchObject({ heldCount: 0, expiringHeldCount: 1, daysUntilNearestHeldExpiry: 6 });
    testDb.raw.prepare(`UPDATE rt_held_reservation_emails SET state = 'processed'`).run();
    const processedWarning = (await loadStoreMediaEmailImportStates(testDb.db, 'store-ginza', new Date(Date.now() + 24 * 86_400_000))).get('media-hotpepper');
    expect(processedWarning).toMatchObject({ heldCount: 0, expiringHeldCount: 1, daysUntilNearestHeldExpiry: 6 });
    testDb.raw.prepare(`UPDATE rt_held_reservation_emails SET state = 'archived'`).run();
    const expired = await expireHeldReservationEmails(env, { now: new Date(Date.now() + 31 * 86_400_000) });
    expect(expired.deleted).toBe(1);
    expect(rawObjects.size).toBe(0);

    await routeInboundEmail(
      makeEmail({
        to: ginzaRecipient,
        from: 'jp_kanri@hotpepper.jp',
        subject: '【即予約】予約の申し込み',
        date: 'Sat, 22 Aug 2026 16:00:00 +0900',
        body: hotpepperBookingBody('HP-AFTER-RESUME', 5),
      }),
      env,
    );
    expect(
      testDb.raw.prepare(`SELECT external_id, guest_count FROM rt_reservations WHERE store_id = 'store-ginza'`).all(),
    ).toEqual([{ external_id: 'HP-AFTER-RESUME', guest_count: 5 }]);
  });

  it('期限7日前からの警告日数を返し、30日超過分は削除と監査を記録しつつ処理中リースとは干渉しない', async () => {
    await apiRequest('/api/restaurant-test/media-email-import/hotpepper?account_id=account-1', {
      method: 'PUT',
      body: { storeId: 'store-ginza', enabled: false, expectedVersion: 0 },
    });

    const seedHeld = (
      id: string,
      receivedAt: string,
      expiresAt: string,
      state: 'held' | 'processing' | 'expiring' | 'archived' | 'processed' = 'held',
      claimToken: string | null = null,
      claimExpiresAt: string | null = null,
    ) => {
      const key = `restaurant-intake/store-ginza/${id}.eml`;
      rawObjects.set(key, {
        body: [
          'From: jp_kanri@hotpepper.jp',
          'Date: Sat, 22 Aug 2026 12:00:00 +0900',
          'Subject: 【即予約】予約の申し込み',
          `Message-ID: <${id}@example.test>`,
          '',
          hotpepperBookingBody(`HP-${id}`, 2),
        ].join('\r\n'),
      });
      testDb.raw
        .prepare(`INSERT INTO rt_inbound_emails (id, message_id, store_id, r2_key, received_at, status, size_bytes)
          VALUES (?, ?, 'store-ginza', ?, ?, 'stored', 180)`)
        .run(`mail-${id}`, `<${id}@example.test>`, key, receivedAt);
      testDb.raw
        .prepare(`INSERT INTO rt_sync_events (id, store_id, provider, external_event_id, payload_json, status)
          VALUES (?, 'store-ginza', 'email', ?, '{"media":"hotpepper","held":true}', 'received')`)
        .run(`ev-${id}`, `<${id}@example.test>`);
      testDb.raw
        .prepare(`INSERT INTO rt_held_reservation_emails
          (inbound_email_id, store_id, media_id, sync_event_id, state, claim_token, claim_expires_at, held_at, expires_at)
          VALUES (?, 'store-ginza', 'media-hotpepper', ?, ?, ?, ?, ?, ?)`)
        .run(`mail-${id}`, `ev-${id}`, state, claimToken, claimExpiresAt, receivedAt, expiresAt);
    };

    const nowMs = Date.now();
    const isoOffsetDays = (days: number) => new Date(nowMs + days * 86_400_000).toISOString();
    seedHeld('soon', isoOffsetDays(-25), isoOffsetDays(5));
    seedHeld('fresh', isoOffsetDays(-10), isoOffsetDays(20));

    const warnChannels = (await (
      await apiRequest('/api/restaurant-test/channels?account_id=account-1&storeId=store-ginza')
    ).json()) as { data: Array<Record<string, unknown>> };
    expect(warnChannels.data.find((item) => item.code === 'hotpepper')).toMatchObject({
      heldCount: 2,
      expiringHeldCount: 1,
      daysUntilNearestHeldExpiry: 5,
    });

    const sweepNow = new Date(nowMs + 6 * 86_400_000);
    seedHeld(
      'leased',
      isoOffsetDays(-25),
      isoOffsetDays(5),
      'processing',
      'active-lease-token',
      new Date(sweepNow.getTime() + 240_000).toISOString(),
    );

    const sweepResult = await deleteExpiredRestaurantRawEmails(env, { now: sweepNow });
    expect(sweepResult.deleted).toBe(1);
    expect(rawObjects.has('restaurant-intake/store-ginza/soon.eml')).toBe(false);
    expect(rawObjects.has('restaurant-intake/store-ginza/fresh.eml')).toBe(true);
    expect(rawObjects.has('restaurant-intake/store-ginza/leased.eml')).toBe(true);

    expect(
      testDb.raw.prepare(`SELECT status, r2_key FROM rt_inbound_emails WHERE id = 'mail-soon'`).get(),
    ).toEqual({ status: 'raw_deleted', r2_key: '' });
    expect(
      testDb.raw.prepare(`SELECT state FROM rt_held_reservation_emails WHERE inbound_email_id = 'mail-soon'`).get(),
    ).toEqual({ state: 'expired' });
    expect(
      testDb.raw.prepare(`SELECT state FROM rt_held_reservation_emails WHERE inbound_email_id = 'mail-leased'`).get(),
    ).toEqual({ state: 'processing' });

    const expiryAudit = testDb.raw
      .prepare(`SELECT action, result, target_id, after_json FROM audit_events WHERE action = 'restaurant.media_email_import.held_expired'`)
      .get() as { action: string; result: string; target_id: string; after_json: string };
    expect(expiryAudit).toMatchObject({
      action: 'restaurant.media_email_import.held_expired',
      result: 'success',
      target_id: 'mail-soon',
    });
    expect(JSON.parse(expiryAudit.after_json)).toMatchObject({
      storeId: 'store-ginza',
      mediaCode: 'hotpepper',
    });

    // 削除前・R2削除後に中断した処理権と、取り込み済み原文も再回収する。
    seedHeld('before-crash', isoOffsetDays(-31), isoOffsetDays(-1), 'expiring', 'old-before', isoOffsetDays(-1));
    seedHeld('after-crash', isoOffsetDays(-31), isoOffsetDays(-1), 'expiring', 'old-after', isoOffsetDays(-1));
    seedHeld('processed', isoOffsetDays(-31), isoOffsetDays(-1), 'processed');
    seedHeld('soon-again', isoOffsetDays(-20), isoOffsetDays(10));
    rawObjects.delete('restaurant-intake/store-ginza/after-crash.eml');
    const overdue = (await loadStoreMediaEmailImportStates(testDb.db, 'store-ginza', sweepNow)).get('media-hotpepper');
    expect(overdue).toMatchObject({ heldCount: 2, daysUntilNearestHeldExpiry: 0, upcomingExpiringCount: 1, daysUntilNearestUpcomingHeldExpiry: 4 });
    expect(overdue!.expiringHeldCount).toBeGreaterThanOrEqual(3);
    testDb.raw.prepare(`INSERT INTO account_settings (id, line_account_id, key, value) VALUES ('off-restaurant', 'account-2', 'feature.restaurant_test', 'false')`).run();
    const recovered = await expireHeldReservationEmails(env, { now: sweepNow });
    expect(recovered.deleted).toBe(3);
    for (const id of ['before-crash', 'after-crash', 'processed']) {
      expect(rawObjects.has(`restaurant-intake/store-ginza/${id}.eml`)).toBe(false);
      expect(testDb.raw.prepare('SELECT state FROM rt_held_reservation_emails WHERE inbound_email_id = ?').get(`mail-${id}`)).toEqual({ state: 'expired' });
      expect(testDb.raw.prepare(`SELECT COUNT(*) AS count FROM audit_events WHERE action = 'restaurant.media_email_import.held_expired' AND target_id = ?`).get(`mail-${id}`)).toEqual({ count: 1 });
    }
    expect((await expireHeldReservationEmails(env, { now: sweepNow })).deleted).toBe(0);
    seedHeld('active-expiry', isoOffsetDays(-31), isoOffsetDays(-1), 'expiring', 'active-expiry-token', new Date(sweepNow.getTime() + 240_000).toISOString());
    testDb.raw.prepare(`DELETE FROM account_settings WHERE id = 'off-restaurant'`).run();
    env.RAW_MAIL_RETENTION_DAYS = '1';
    await deleteExpiredRestaurantRawEmails(env, { now: sweepNow });
    expect(rawObjects.has('restaurant-intake/store-ginza/active-expiry.eml')).toBe(true);
    expect(testDb.raw.prepare(`SELECT status FROM rt_inbound_emails WHERE id = 'mail-active-expiry'`).get()).toEqual({ status: 'stored' });

    testDb.raw
      .prepare(`UPDATE rt_store_media_email_settings SET enabled = 1, version = 2 WHERE store_id = 'store-ginza' AND media_id = 'media-hotpepper'`)
      .run();
    const media = testDb.raw
      .prepare(`SELECT id, code, name, parser_key FROM rt_media WHERE code = 'hotpepper'`)
      .get() as RestaurantMediaRow;
    const drained = await drainHeldReservationEmails(env, 'store-ginza', media, { now: sweepNow });
    expect(drained.importedCount).toBe(2);
    expect(
      testDb.raw.prepare(`SELECT external_id FROM rt_reservations WHERE store_id = 'store-ginza' ORDER BY external_id`).all(),
    ).toEqual([{ external_id: 'HP-fresh' }, { external_id: 'HP-soon-again' }]);
  });
});
