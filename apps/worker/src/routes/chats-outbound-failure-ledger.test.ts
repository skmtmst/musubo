/*
 * 個別送信の失敗台帳と安全な再試行。
 * 実Hono route + 実SQLite(bootstrap.sql)へ当て、LINE clientだけを止める。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';
import type { Env } from '../worker-env.js';
import type { AuthenticatedStaff } from '../middleware/auth/principal/auth.js';

const mocks = vi.hoisted(() => ({ pushMessage: vi.fn() }));
vi.mock('@line-crm/line-sdk', () => ({
  LineClient: vi.fn().mockImplementation(function () { return ({ pushMessage: mocks.pushMessage }); }),
}));

const { chats } = await import('./chats.js');

const owner: AuthenticatedStaff = {
  id: 'owner-1', name: 'オーナー', role: 'owner', readOnly: false, tenantId: 'tenant-1',
};
const account2Staff: AuthenticatedStaff = {
  id: 'staff-2', name: '店舗2担当', role: 'staff', readOnly: false, tenantId: 'tenant-1',
};

const KEY1 = '11111111-2222-4333-8444-555555555555';
const KEY2 = '22222222-2222-4333-8444-555555555555';
const KEY3 = '33333333-2222-4333-8444-555555555555';
const KEY4 = '44444444-2222-4333-8444-555555555555';

let sqlite: SqliteD1;

function app(staff: AuthenticatedStaff = owner, db: D1Database = sqlite.db) {
  const instance = new Hono<Env>();
  instance.use('*', async (c, next) => {
    c.env = { DB: db, LINE_CHANNEL_ACCESS_TOKEN: 'default-token' } as Env['Bindings'];
    c.set('staff', staff);
    await next();
  });
  instance.route('/', chats);
  return instance;
}

function send(chatId: string, key: string, staff: AuthenticatedStaff = owner, db?: D1Database) {
  return app(staff, db).request(`/api/chats/${chatId}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify({ messageType: 'text', content: 'こんにちは', revision: 0 }),
  });
}

function row(key: string) {
  return sqlite.raw.prepare(
    `SELECT line_account_id, status, failure_code, attempt_count, retryable,
            next_retry_at, lease_token
       FROM outbound_send_requests WHERE idempotency_key = ?`,
  ).get(key) as {
    line_account_id: string;
    status: string;
    failure_code: string | null;
    attempt_count: number;
    retryable: number;
    next_retry_at: string | null;
    lease_token: string | null;
  };
}

function seed(): void {
  sqlite.raw.prepare(`INSERT INTO tenants (id, name) VALUES ('tenant-1', '統括1')`).run();
  sqlite.raw.prepare(`
    INSERT INTO line_accounts
      (id, channel_id, name, channel_access_token, channel_secret, is_active, tenant_id)
    VALUES ('account-1', 'channel-1', '店舗1', 'token-1', 'secret-1', 1, 'tenant-1'),
           ('account-2', 'channel-2', '店舗2', 'token-2', 'secret-2', 1, 'tenant-1')
  `).run();
  sqlite.raw.prepare(`
    INSERT INTO staff_members (id, name, role, api_key, tenant_id, account_scope, permission_keys)
    VALUES ('owner-1', 'オーナー', 'owner', 'owner-key', 'tenant-1', 'all', '[]'),
           ('staff-2', '店舗2担当', 'staff', 'staff-key', 'tenant-1', 'accounts', '[]')
  `).run();
  sqlite.raw.prepare(`
    INSERT INTO staff_account_scopes (staff_id, line_account_id, created_at)
    VALUES ('staff-2', 'account-2', '2026-09-16T00:00:00.000Z')
  `).run();
  sqlite.raw.prepare(`
    INSERT INTO friends (id, line_user_id, display_name, line_account_id)
    VALUES ('friend-1', 'U-1', '利用者1', 'account-1'),
           ('friend-2', 'U-2', '利用者2', 'account-2')
  `).run();
  sqlite.raw.prepare(`
    INSERT INTO chats (id, friend_id, status, revision, created_at, updated_at)
    VALUES ('chat-1', 'friend-1', 'unread', 0, '2026-09-16T00:00:00.000Z', '2026-09-16T00:00:00.000Z'),
           ('chat-2', 'friend-2', 'unread', 0, '2026-09-16T00:00:00.000Z', '2026-09-16T00:00:00.000Z')
  `).run();
}

beforeEach(() => {
  vi.clearAllMocks();
  sqlite = createTestD1();
  seed();
});

afterEach(() => sqlite.raw.close());

describe('N-023 個別送信失敗台帳', () => {
  test('LINE受理前の429を再試行可能で記録し、期限後は同じkeyで1回だけ再送する', async () => {
    mocks.pushMessage
      .mockRejectedValueOnce(Object.assign(new Error('秘密を含む応答'), { status: 429, retryAfter: '0' }))
      .mockResolvedValueOnce({});

    const failed = await send('chat-1', KEY1);
    expect(failed.status).toBe(429);
    await expect(failed.json()).resolves.toMatchObject({
      success: false,
      code: 'LINE_RATE_LIMITED',
      data: { retryable: true },
    });
    expect(row(KEY1)).toMatchObject({
      line_account_id: 'account-1', status: 'failed', failure_code: 'LINE_RATE_LIMITED',
      attempt_count: 1, retryable: 1, lease_token: null,
    });

    const retried = await send('chat-1', KEY1);
    expect(retried.status).toBe(200);
    expect(mocks.pushMessage).toHaveBeenCalledTimes(2);
    expect(row(KEY1)).toMatchObject({
      status: 'succeeded', failure_code: null, attempt_count: 2, retryable: 0,
    });
  });

  test('受理後に応答を失った可能性がある行はunknownにし、自動再送しない', async () => {
    mocks.pushMessage.mockRejectedValueOnce(new TypeError('network response lost'));
    const first = await send('chat-1', KEY2);
    expect(first.status).toBe(503);
    await expect(first.json()).resolves.toMatchObject({
      code: 'LINE_DELIVERY_UNKNOWN', data: { retryable: false, nextRetryAt: null },
    });
    expect(row(KEY2)).toMatchObject({
      status: 'unknown', failure_code: 'LINE_DELIVERY_UNKNOWN', retryable: 0,
    });

    const second = await send('chat-1', KEY2);
    expect(second.status).toBe(409);
    expect(mocks.pushMessage).toHaveBeenCalledTimes(1);
  });

  test('LINE受理後にDB確定が失敗した行もunknownにし、二重送信しない', async () => {
    mocks.pushMessage.mockResolvedValue({});
    let failBatch = true;
    const db = {
      prepare: (sql: string) => sqlite.db.prepare(sql),
      batch: async (statements: D1PreparedStatement[]) => {
        if (failBatch) {
          failBatch = false;
          throw new Error('database unavailable');
        }
        return sqlite.db.batch(statements);
      },
    } as unknown as D1Database;

    const first = await send('chat-1', KEY3, owner, db);
    expect(first.status).toBe(503);
    await expect(first.json()).resolves.toMatchObject({ code: 'OUTBOUND_CONFIRMATION_FAILED' });
    expect(row(KEY3)).toMatchObject({
      status: 'unknown', failure_code: 'OUTBOUND_CONFIRMATION_FAILED', retryable: 0,
    });
    expect(sqlite.raw.prepare(`SELECT COUNT(*) AS n FROM messages_log WHERE id = ?`).get(KEY3)).toEqual({ n: 0 });

    const second = await send('chat-1', KEY3, owner, db);
    expect(second.status).toBe(409);
    expect(mocks.pushMessage).toHaveBeenCalledTimes(1);
  });

  test('同時再試行はCASで1実行者だけがLINEへ進む', async () => {
    mocks.pushMessage.mockRejectedValueOnce(
      Object.assign(new Error('rate limit'), { status: 429, retryAfter: '0' }),
    );
    expect((await send('chat-1', KEY4)).status).toBe(429);

    let releasePush!: () => void;
    const held = new Promise<void>((resolve) => { releasePush = resolve; });
    mocks.pushMessage.mockImplementationOnce(() => held);
    const first = send('chat-1', KEY4);
    const second = send('chat-1', KEY4);
    // 負けた側はLINE呼出しを待たず409で返る。先にpushを解放すると負け側が
    // 成功済みをreplayして200を返すため、409側の確定を待ってから解放する。
    const loser = await Promise.race([first, second]);
    expect(loser.status).toBe(409);
    releasePush();
    const responses = await Promise.all([first, second]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(mocks.pushMessage).toHaveBeenCalledTimes(2);
    expect(row(KEY4).attempt_count).toBe(2);
  });

  test('失敗一覧はaccount境界を越えず、安全codeだけを返す', async () => {
    mocks.pushMessage.mockRejectedValueOnce(
      Object.assign(new Error('provider secret'), { status: 400 }),
    );
    expect((await send('chat-1', KEY1)).status).toBe(400);

    const visible = await app().request('/api/chats/outbound-failures?lineAccountId=account-1');
    expect(visible.status).toBe(200);
    const body = await visible.json() as { data: Array<Record<string, unknown>> };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({
      idempotencyKey: KEY1,
      status: 'failed',
      failureCode: 'LINE_REQUEST_REJECTED',
      retryable: false,
    });
    expect(JSON.stringify(body)).not.toContain('provider secret');

    const otherAccount = await app().request('/api/chats/outbound-failures?lineAccountId=account-2');
    expect(otherAccount.status).toBe(200);
    await expect(otherAccount.json()).resolves.toMatchObject({ data: [] });

    const forbidden = await app(account2Staff)
      .request('/api/chats/outbound-failures?lineAccountId=account-1');
    expect(forbidden.status).toBe(404);
  });
});

test('UNS-22: LINEが500なら失敗を記録し自動的に再送しない',async()=>{
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-11-16T00:00:00Z'));
 try{
  mocks.pushMessage.mockRejectedValueOnce(Object.assign(new Error('provider error'),{status:500}));
  const response=await send('chat-1',KEY1);
  expect(response.status).toBe(502);
  expect(await response.json()).toMatchObject({success:false,code:'LINE_TEMPORARILY_UNAVAILABLE',data:{retryable:true}});
  expect(row(KEY1)).toMatchObject({status:'failed',failure_code:'LINE_TEMPORARILY_UNAVAILABLE',attempt_count:1,retryable:1});
  expect(mocks.pushMessage).toHaveBeenCalledTimes(1);
 }finally{vi.useRealTimers();}
});
