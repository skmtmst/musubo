import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../worker-env';
import type { AuthenticatedStaff } from '../middleware/auth/principal/auth';
import { createTestD1, insertFriend, type SqliteD1 } from '../test-utils/d1-sqlite';
import { tryReserveQuotaSlot } from '../features/broadcasts/broadcast-quota-guard.js';

const pushMessageWithRequestId = vi.hoisted(() => vi.fn());
const lineFetch = vi.hoisted(() => vi.fn());
vi.mock('@line-crm/line-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@line-crm/line-sdk')>();
  return {
    ...actual,
    LineClient: class {
      pushMessageWithRequestId = pushMessageWithRequestId;
    },
  };
});

const { lineNotifications } = await import('./line-notifications');

const owner: AuthenticatedStaff = {
  id: 'owner-1', name: 'オーナー', role: 'owner', readOnly: false, tenantId: 'tenant-1',
};
const staff: AuthenticatedStaff = {
  ...owner, id: 'staff-1', name: '担当者', role: 'staff',
};
const admin: AuthenticatedStaff = {
  ...owner, id: 'admin-1', name: '管理者', role: 'admin',
};

function app(db: D1Database, actor: AuthenticatedStaff = owner) {
  const instance = new Hono<Env>();
  instance.use('*', async (c, next) => {
    c.env = { DB: db } as Env['Bindings'];
    c.set('staff', actor);
    await next();
  });
  instance.route('/', lineNotifications);
  return instance;
}

function json(method: string, body: unknown) {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function seedDefinition(db: SqliteD1): void {
  db.raw.prepare(`
    INSERT INTO customer_notification_definitions
      (id, line_account_id, key, name, category, source_event_type, status,
       current_version_id, draft_config_json, version, created_by, updated_by,
       created_at, updated_at)
    VALUES ('definition-1', 'account-1', 'order-confirmed', '注文確定のお知らせ',
            'order', 'ec.order.confirmed', 'published', 'definition-version-1',
            ?, 1, 'owner-1', 'owner-1', '2026-09-07T10:00:00+09:00',
            '2026-09-07T10:00:00+09:00')
  `).run(JSON.stringify({ lineTemplate: [{ type: 'text', text: '注文を受け付けました' }] }));
  db.raw.prepare(`
    INSERT INTO customer_notification_versions
      (id, definition_id, version_number, config_json, line_template_json,
       published_by, published_at)
    VALUES ('definition-version-1', 'definition-1', 1, ?, ?, 'owner-1',
            '2026-09-07T10:00:00+09:00')
  `).run(
    JSON.stringify({ lineTemplate: [{ type: 'text', text: '注文を受け付けました' }] }),
    JSON.stringify([{ type: 'text', text: '注文を受け付けました' }]),
  );
}

function seedDelivery(
  db: SqliteD1,
  id: string,
  status: 'pending' | 'provider_accepted' | 'excluded' | 'retry_wait' | 'failed',
  overrides: { retryable?: number; accountId?: string; version?: number } = {},
): void {
  const accountId = overrides.accountId ?? 'account-1';
  db.raw.prepare(`
    INSERT INTO notification_instances
      (id, line_account_id, audience_type, definition_id, definition_version_id,
       source_event_type, source_event_id, source_metadata_json, dedupe_key,
       status, created_at, updated_at)
    VALUES (?, ?, 'customer', 'definition-1', 'definition-version-1',
            'ec.order.confirmed', ?, '{"orderNumber":"NEN-1001"}', ?, 'pending',
            '2026-09-07T10:00:00+09:00', '2026-09-07T10:00:00+09:00')
  `).run(`instance-${id}`, accountId, `event-${id}`, `dedupe-${id}`);
  db.raw.prepare(`
    INSERT INTO notification_deliveries
      (id, line_account_id, instance_id, audience_type, recipient_type, recipient_id,
       channel, idempotency_key, status, retryable, attempts, provider_status,
       error_message_safe, queued_at, accepted_at, version, updated_at)
    VALUES (?, ?, ?, 'customer', 'friend', 'friend-1', 'line', ?, ?, ?, 1, ?, ?,
            '2026-09-07T10:00:00+09:00', ?, ?, '2026-09-07T10:00:00+09:00')
  `).run(
    id,
    accountId,
    `instance-${id}`,
    `retry-key-${id}`,
    status,
    overrides.retryable ?? 0,
    status,
    status === 'retry_wait' || status === 'failed' ? '一時的な問題です' : null,
    status === 'provider_accepted' ? '2026-09-07T10:00:01+09:00' : null,
    overrides.version ?? 1,
  );
}

describe('LINE通知の手動操作（再送・テスト・単体・枠）', () => {
  let testDb: SqliteD1;

  beforeEach(() => {
    pushMessageWithRequestId.mockReset();
    pushMessageWithRequestId.mockResolvedValue({ data: {}, requestId: 'line-request-1' });
    lineFetch.mockReset();
    lineFetch.mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/quota/consumption')) return Response.json({ totalUsage: 10 });
      if (url.endsWith('/quota')) return Response.json({ type: 'limited', value: 100 });
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal('fetch', lineFetch);
    testDb = createTestD1();
    testDb.raw.prepare(`INSERT INTO tenants (id, name) VALUES ('tenant-1', '統括1')`).run();
    testDb.raw.prepare(`INSERT INTO tenants (id, name) VALUES ('tenant-2', '統括2')`).run();
    testDb.raw.prepare(`
      INSERT INTO line_accounts
        (id, channel_id, name, channel_access_token, channel_secret, is_active, tenant_id)
      VALUES ('account-1', 'channel-1', '店舗1', 'token-1', 'secret-1', 1, 'tenant-1')
    `).run();
    testDb.raw.prepare(`
      INSERT INTO line_accounts
        (id, channel_id, name, channel_access_token, channel_secret, is_active, tenant_id)
      VALUES ('account-2', 'channel-2', '店舗2', 'token-2', 'secret-2', 1, 'tenant-2')
    `).run();
    insertFriend(testDb.raw, 'friend-1', { line_account_id: 'account-1', display_name: '見本 141' });
    insertFriend(testDb.raw, 'friend-2', { line_account_id: 'account-1', display_name: '見本 122' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('1件だけの送信記録を一覧と同じ形で返す', async () => {
    seedDefinition(testDb);
    seedDelivery(testDb, 'delivery-one', 'retry_wait', { retryable: 1 });
    const response = await app(testDb.db).request(
      '/api/line-notifications/deliveries/delivery-one?lineAccountId=account-1',
    );
    expect(response.status).toBe(200);
    const body = await response.json() as { data: Record<string, unknown> };
    expect(body.data).toMatchObject({
      id: 'delivery-one',
      status: 'failed',
      friendName: '見本 141',
      orderNumber: 'NEN-1001',
      retryAvailable: true,
      attemptHistory: [],
    });

    const missing = await app(testDb.db).request(
      '/api/line-notifications/deliveries/no-such-id?lineAccountId=account-1',
    );
    expect(missing.status).toBe(404);
    const noAccount = await app(testDb.db).request(
      '/api/line-notifications/deliveries/delivery-one',
    );
    expect(noAccount.status).toBe(400);
    const forbidden = await app(testDb.db).request(
      '/api/line-notifications/deliveries/delivery-one?lineAccountId=account-2',
    );
    expect(forbidden.status).toBe(403);
    seedDelivery(testDb, 'delivery-hidden', 'failed', { accountId: 'account-2' });
    const hidden = await app(testDb.db).request(
      '/api/line-notifications/deliveries/delivery-hidden?lineAccountId=account-1',
    );
    expect(hidden.status).toBe(404);
  });

  it('送信枠だけを単体で返す', async () => {
    const response = await app(testDb.db).request(
      '/api/line-notifications/quota?lineAccountId=account-1',
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { state: 'available', total: 100, used: 10, remaining: 90, asOf: expect.any(String) },
    });
    const forbidden = await app(testDb.db).request(
      '/api/line-notifications/quota?lineAccountId=account-2',
    );
    expect(forbidden.status).toBe(403);
    const noAccount = await app(testDb.db).request('/api/line-notifications/quota');
    expect(noAccount.status).toBe(400);
  });

  it('送れなかった通知を新しい送信として送り直す（理由必須・元行は不変）', async () => {
    seedDefinition(testDb);
    seedDelivery(testDb, 'delivery-resend-src', 'failed', { retryable: 1 });
    const noReason = await app(testDb.db).request(
      '/api/line-notifications/deliveries/delivery-resend-src/resend',
      json('POST', { lineAccountId: 'account-1', expectedVersion: 1 }),
    );
    expect(noReason.status).toBe(400);

    const response = await app(testDb.db).request(
      '/api/line-notifications/deliveries/delivery-resend-src/resend',
      json('POST', { lineAccountId: 'account-1', expectedVersion: 1, reason: 'お客様からの再送依頼' }),
    );
    expect(response.status).toBe(200);
    const body = await response.json() as { data: { id: string; status: string } };
    expect(body.data.id).not.toBe('delivery-resend-src');
    expect(body.data.status).toBe('accepted');
    expect(pushMessageWithRequestId).toHaveBeenCalledTimes(1);
    const sentKey = pushMessageWithRequestId.mock.calls[0]?.[2] as string;
    expect(sentKey).not.toBe('retry-key-delivery-resend-src');

    const rows = testDb.raw.prepare(`
      SELECT id, execution_mode, status FROM notification_deliveries
       WHERE line_account_id = 'account-1' ORDER BY queued_at, id
    `).all() as Array<{ id: string; execution_mode: string; status: string }>;
    expect(rows.find((row) => row.id === 'delivery-resend-src')).toMatchObject({
      execution_mode: 'automatic', status: 'failed',
    });
    expect(rows.find((row) => row.id === body.data.id)).toMatchObject({
      execution_mode: 'resend', status: 'provider_accepted',
    });
    const audit = testDb.raw.prepare(`
      SELECT action, actor_id FROM operation_audit
       WHERE target_kind = 'notification_delivery' AND target_id = ?
    `).get(body.data.id) as { action: string; actor_id: string } | undefined;
    expect(audit).toMatchObject({ action: 'line_notification.delivery.resend', actor_id: 'owner-1' });
  });

  it('届いた通知・担当者・管理者の再送を断る', async () => {
    seedDefinition(testDb);
    seedDelivery(testDb, 'delivery-accepted-no-resend', 'provider_accepted');
    const accepted = await app(testDb.db).request(
      '/api/line-notifications/deliveries/delivery-accepted-no-resend/resend',
      json('POST', { lineAccountId: 'account-1', expectedVersion: 1, reason: '確認のため' }),
    );
    expect(accepted.status).toBe(409);
    seedDelivery(testDb, 'delivery-resend-perm', 'failed', { retryable: 1 });
    const staffResend = await app(testDb.db, staff).request(
      '/api/line-notifications/deliveries/delivery-resend-perm/resend',
      json('POST', { lineAccountId: 'account-1', expectedVersion: 1, reason: '確認のため' }),
    );
    expect(staffResend.status).toBe(403);
    const adminResend = await app(testDb.db, admin).request(
      '/api/line-notifications/deliveries/delivery-resend-perm/resend',
      json('POST', { lineAccountId: 'account-1', expectedVersion: 1, reason: '確認のため' }),
    );
    expect(adminResend.status).toBe(403);
    expect(pushMessageWithRequestId).not.toHaveBeenCalled();
  });

  it('顧客のお知らせを指定した友だちだけに試し送りする', async () => {
    seedDefinition(testDb);
    const response = await app(testDb.db).request(
      '/api/line-notifications/customer-definitions/definition-1/test',
      json('POST', { lineAccountId: 'account-1', friendIds: ['friend-2'] }),
    );
    expect(response.status).toBe(200);
    expect(pushMessageWithRequestId).toHaveBeenCalledTimes(1);
    const [to, messages] = pushMessageWithRequestId.mock.calls[0] as [string, Array<{ type: string; text?: string }>];
    expect(to).toBe('Ufriend-2');
    expect(messages[0]).toMatchObject({ type: 'text' });
    expect(String(messages[0]?.text ?? '')).toContain('テスト送信');
    expect(JSON.stringify(messages)).toContain('注文を受け付けました');

    const rows = testDb.raw.prepare(`
      SELECT execution_mode, status, recipient_id FROM notification_deliveries
       WHERE line_account_id = 'account-1' AND execution_mode = 'test'
    `).all() as Array<{ execution_mode: string; status: string; recipient_id: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      execution_mode: 'test', status: 'provider_accepted', recipient_id: 'friend-2',
    });
    const audit = testDb.raw.prepare(`
      SELECT action, actor_id, target_kind, target_id FROM operation_audit
       WHERE action = 'line_notification.definition.test'
    `).get() as { action: string; actor_id: string; target_kind: string; target_id: string } | undefined;
    expect(audit).toMatchObject({
      action: 'line_notification.definition.test', actor_id: 'owner-1',
      target_kind: 'customer_notification', target_id: 'definition-1',
    });
  });

  it('m26e R566: 枠競合の再送は未送信のまま残さず、失敗理由を履歴に残す', async () => {
    seedDefinition(testDb);
    seedDelivery(testDb, 'delivery-quota-race', 'failed', { retryable: 1 });
    // 照会時点は残り90通で通るが、予約の直前にほかの処理が90通を先取りする。
    // 照会の見本は使用10/上限100。再送の1通が入らなくなる。
    expect(await tryReserveQuotaSlot(testDb.db, 'account-1', 'other-job', 90, 10, 100)).toBe(true);
    const response = await app(testDb.db).request(
      '/api/line-notifications/deliveries/delivery-quota-race/resend',
      json('POST', { lineAccountId: 'account-1', expectedVersion: 1, reason: '枠いっぱいの確認' }),
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      success: false, code: 'quota_insufficient',
    });
    expect(pushMessageWithRequestId).not.toHaveBeenCalled();
    const rows = testDb.raw.prepare(`
      SELECT execution_mode, status, error_code, error_message_safe FROM notification_deliveries
       WHERE line_account_id = 'account-1' AND execution_mode = 'resend'
    `).all() as Array<{
      execution_mode: string; status: string; error_code: string | null;
      error_message_safe: string | null;
    }>;
    // 未送信のまま（pending）は残らない。送らなかった理由が履歴に残る。
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ execution_mode: 'resend', status: 'failed', error_code: 'quota_insufficient' });
    expect(String(rows[0]?.error_message_safe ?? '')).toContain('送信枠');
  });

  it('m26e R567: 枠競合の試し送りは空の成功記録を残さず、失敗理由を区別できる', async () => {
    seedDefinition(testDb);
    // 照会時点は残り90通で通るが、予約の直前にほかの処理が90通を先取りする。
    expect(await tryReserveQuotaSlot(testDb.db, 'account-1', 'other-job', 90, 10, 100)).toBe(true);
    const response = await app(testDb.db).request(
      '/api/line-notifications/customer-definitions/definition-1/test',
      json('POST', { lineAccountId: 'account-1', friendIds: ['friend-2'] }),
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      success: false, code: 'quota_insufficient',
    });
    expect(pushMessageWithRequestId).not.toHaveBeenCalled();
    // 送達のない成功前提の記録は残らない。instance は失敗で確定する。
    const instances = testDb.raw.prepare(`
      SELECT status FROM notification_instances WHERE line_account_id = 'account-1'
    `).all() as Array<{ status: string }>;
    expect(instances).toHaveLength(1);
    expect(instances[0]).toMatchObject({ status: 'failed' });
    const deliveryCount = testDb.raw.prepare(`
      SELECT COUNT(*) AS count FROM notification_deliveries WHERE line_account_id = 'account-1'
    `).get() as { count: number };
    expect(deliveryCount).toEqual({ count: 0 });
    // 誰が何を試して送れなかったかが監査に残り、理由を区別できる。
    const audit = testDb.raw.prepare(`
      SELECT target_kind, target_id, detail_json FROM operation_audit
       WHERE action = 'line_notification.definition.test'
    `).get() as { target_kind: string; target_id: string; detail_json: string };
    expect(audit).toMatchObject({ target_kind: 'customer_notification', target_id: 'definition-1' });
    expect(JSON.parse(audit.detail_json)).toMatchObject({
      sourceEventId: expect.any(String),
      recipientIds: ['friend-2'],
      outcome: 'quota_insufficient',
    });
  });

  it('試し送りは宛先不明・宛先なし・担当者を断る', async () => {
    seedDefinition(testDb);
    const unknown = await app(testDb.db).request(
      '/api/line-notifications/customer-definitions/definition-1/test',
      json('POST', { lineAccountId: 'account-1', friendIds: ['friend-unknown'] }),
    );
    expect(unknown.status).toBe(404);
    const empty = await app(testDb.db).request(
      '/api/line-notifications/customer-definitions/definition-1/test',
      json('POST', { lineAccountId: 'account-1', friendIds: [] }),
    );
    expect(empty.status).toBe(400);
    const staffTest = await app(testDb.db, staff).request(
      '/api/line-notifications/customer-definitions/definition-1/test',
      json('POST', { lineAccountId: 'account-1', friendIds: ['friend-2'] }),
    );
    expect(staffTest.status).toBe(403);
    expect(pushMessageWithRequestId).not.toHaveBeenCalled();
  });
});
