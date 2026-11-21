import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../worker-env.js';
import type { AuthenticatedStaff } from '../middleware/auth/principal/auth.js';
import { createTestD1, insertFriend, type SqliteD1 } from '../test-utils/d1-sqlite.js';

const lineClientMocks = vi.hoisted(() => ({
  getProfile: vi.fn(),
  replyMessage: vi.fn(),
  replyMessageWithRequestId: vi.fn(),
  pushMessage: vi.fn().mockResolvedValue({ requestId: 'req-1' }),
  pushMessageWithRequestId: vi.fn().mockResolvedValue({ requestId: 'req-1' }),
}));

vi.mock('@line-crm/line-sdk', async () => {
  const actual = await vi.importActual<typeof import('@line-crm/line-sdk')>('@line-crm/line-sdk');
  return { ...actual, LineClient: vi.fn().mockImplementation(function () { return lineClientMocks; }) };
});

const { friendAddRules } = await import('./friend-add-rules.js');

/*
 * F12: 友だち追加時の配信のテスト送信は、保存済みの本文・版で固定し、
 * 操作した本人だけへ送る。実顧客へは送らない（mockで止める）。
 * 手動の扱いとして source='manual' で記録する。
 */
const owner: AuthenticatedStaff = {
  id: 'owner-1', name: 'オーナー', role: 'owner', readOnly: false, tenantId: 'tenant-1',
};

function buildApp(db: D1Database, staff: AuthenticatedStaff = owner) {
  const instance = new Hono<Env>();
  instance.use('*', async (c, next) => {
    c.set('staff', staff);
    await next();
  });
  instance.route('/', friendAddRules);
  return {
    instance,
    bindings: { DB: db, WORKER_URL: 'https://worker.test' } as Env['Bindings'],
  };
}

function jsonRequest(method: string, body: unknown, headers: Record<string, string> = {}): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  };
}

function seedBase(raw: SqliteD1['raw']): void {
  raw.prepare(`INSERT INTO tenants (id, name) VALUES ('tenant-1', '統括1')`).run();
  raw.prepare(
    `INSERT INTO line_accounts
       (id, channel_id, name, channel_access_token, channel_secret, is_active, tenant_id)
     VALUES ('account-1', 'channel-1', '店舗1', 'token-1', 'secret-1', 1, 'tenant-1')`,
  ).run();
  raw.prepare(
    `INSERT INTO staff_members (id, name, role, api_key, tenant_id, line_user_id, is_active)
     VALUES ('owner-1', 'オーナー', 'owner', 'owner-key', 'tenant-1', 'UOWNERLINEUSERID000000000000000001', 1)`,
  ).run();
  insertFriend(raw, 'friend-self', {
    line_user_id: 'UOWNERLINEUSERID000000000000000001',
    line_account_id: 'account-1',
    display_name: '担当者本人',
  });
  insertFriend(raw, 'friend-other', { line_account_id: 'account-1', display_name: '別のお客さま' });
}

function seedRule(raw: SqliteD1['raw'], messageText = 'はじめまして'): void {
  const definition = JSON.stringify({
    routeIds: [],
    scenarioId: null,
    messageType: 'text',
    messageText,
    timing: 'immediate',
    actions: [],
    friendCondition: '',
    activeFrom: null,
    activeUntil: null,
  });
  raw.prepare(
    `INSERT INTO friend_add_rules
      (id, line_account_id, friend_kind, name, priority, status, current_version_id, created_at, updated_at)
     VALUES ('rule-12', 'account-1', 'first_time', 'F12の配信', 1, 'published', 'version-12',
             '2026-10-01T09:00:00+09:00', '2026-10-01T09:00:00+09:00')`,
  ).run();
  raw.prepare(
    `INSERT INTO friend_add_rule_versions
      (id, rule_id, version_number, definition_snapshot, status, published_at)
     VALUES ('version-12', 'rule-12', 3, ?, 'published', '2026-10-01T09:00:00+09:00')`,
  ).run(definition);
}

describe('F12: 本人だけへのテスト送信', () => {
  let testDb: SqliteD1;

  it('自分の宛先が未連携または友だちでない場合は送信前に利用不可と分かる', async () => {
    const { instance, bindings } = buildApp(testDb.db);
    const url = '/api/friend-add-rules/rule-12/test-recipient?account_id=account-1';
    const available = await instance.request(url, {}, bindings);
    expect(await available.json()).toEqual({ success: true, data: { available: true } });
    testDb.raw.prepare("UPDATE staff_members SET line_user_id = NULL WHERE id = 'owner-1'").run();
    const missing = await instance.request(url, {}, bindings);
    expect(await missing.json()).toEqual({ success: true, data: { available: false } });
    expect(lineClientMocks.pushMessage).not.toHaveBeenCalled();
  });

  beforeEach(() => {
    testDb = createTestD1();
    seedBase(testDb.raw);
    seedRule(testDb.raw);
    vi.clearAllMocks();
    lineClientMocks.pushMessage.mockResolvedValue({ requestId: 'req-1' });
  });

  it('保存済みの本文で本人だけへ送り手動として記録する', async () => {
    const target = buildApp(testDb.db);
    const res = await target.instance.request(
      '/api/friend-add-rules/rule-12/test-send?account_id=account-1',
      jsonRequest('POST', {}, { 'Idempotency-Key': 'f12-test-key-0001' }),
      target.bindings,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { sent: number; versionNumber: number; recipientKind: string };
    };
    expect(body.data.sent).toBe(1);
    expect(body.data.versionNumber).toBe(3);
    expect(body.data.recipientKind).toBe('self');

    // 本人のLINEへ1通だけ。
    expect(lineClientMocks.pushMessage).toHaveBeenCalledTimes(1);
    const [to, messages] = lineClientMocks.pushMessage.mock.calls[0] as [string, Array<{ text: string }>];
    expect(to).toBe('UOWNERLINEUSERID000000000000000001');
    expect((messages[0] as { text: string }).text).toContain('はじめまして');

    // 手動のテストとして記録する。
    const log = testDb.raw.prepare(
      `SELECT delivery_type, source FROM messages_log WHERE friend_id = 'friend-self'`,
    ).get() as { delivery_type: string; source: string };
    expect(log.delivery_type).toBe('test');
    expect(log.source).toBe('manual');
  });

  it('本人にひも付く友だちが無いと送らず409', async () => {
    const nobody: AuthenticatedStaff = {
      id: 'owner-2', name: '未連携', role: 'owner', readOnly: false, tenantId: 'tenant-1',
    };
    testDb.raw.prepare(
      `INSERT INTO staff_members (id, name, role, api_key, tenant_id, is_active)
       VALUES ('owner-2', '未連携', 'owner', 'owner-key-2', 'tenant-1', 1)`,
    ).run();
    const target = buildApp(testDb.db, nobody);
    const res = await target.instance.request(
      '/api/friend-add-rules/rule-12/test-send?account_id=account-1',
      jsonRequest('POST', {}, { 'Idempotency-Key': 'f12-test-key-0002' }),
      target.bindings,
    );
    expect(res.status).toBe(409);
    expect(lineClientMocks.pushMessage).not.toHaveBeenCalled();
  });

  it('他人を指定する口は無い（本文で送り先を変えられない）', async () => {
    const target = buildApp(testDb.db);
    const res = await target.instance.request(
      '/api/friend-add-rules/rule-12/test-send?account_id=account-1',
      jsonRequest('POST', { friendId: 'friend-other' }, { 'Idempotency-Key': 'f12-test-key-0003' }),
      target.bindings,
    );
    expect(res.status).toBe(200);
    const [to] = lineClientMocks.pushMessage.mock.calls[0] as [string, unknown];
    // 指定があっても本人へだけ送る。
    expect(to).toBe('UOWNERLINEUSERID000000000000000001');
  });

  it('解けない共通情報がある本文は送らず422', async () => {
    const definition = JSON.stringify({
      routeIds: [],
      scenarioId: null,
      messageType: 'text',
      messageText: '残高は{{var.no_such_var}}です',
      timing: 'immediate',
      actions: [],
      friendCondition: '',
      activeFrom: null,
      activeUntil: null,
    });
    testDb.raw.prepare(
      `INSERT INTO friend_add_rules
        (id, line_account_id, friend_kind, name, priority, status, current_version_id, created_at, updated_at)
       VALUES ('rule-12c', 'account-1', 'first_time', 'F12の未解決', 3, 'draft', 'version-12c',
               '2026-10-01T09:00:00+09:00', '2026-10-01T09:00:00+09:00')`,
    ).run();
    testDb.raw.prepare(
      `INSERT INTO friend_add_rule_versions
        (id, rule_id, version_number, definition_snapshot, status)
       VALUES ('version-12c', 'rule-12c', 1, ?, 'draft')`,
    ).run(definition);
    const target = buildApp(testDb.db);
    const res = await target.instance.request(
      '/api/friend-add-rules/rule-12c/test-send?account_id=account-1',
      jsonRequest('POST', {}, { 'Idempotency-Key': 'f12-test-key-0005' }),
      target.bindings,
    );
    expect(res.status).toBe(422);
    expect(lineClientMocks.pushMessage).not.toHaveBeenCalled();
  });

  it('本文が空の版は送らず422', async () => {
    const definition = JSON.stringify({
      routeIds: [],
      scenarioId: null,
      messageType: 'text',
      messageText: '',
      timing: 'immediate',
      actions: [],
      friendCondition: '',
      activeFrom: null,
      activeUntil: null,
    });
    testDb.raw.prepare(
      `INSERT INTO friend_add_rules
        (id, line_account_id, friend_kind, name, priority, status, current_version_id, created_at, updated_at)
       VALUES ('rule-12b', 'account-1', 'first_time', 'F12の空本文', 2, 'draft', 'version-12b',
               '2026-10-01T09:00:00+09:00', '2026-10-01T09:00:00+09:00')`,
    ).run();
    testDb.raw.prepare(
      `INSERT INTO friend_add_rule_versions
        (id, rule_id, version_number, definition_snapshot, status)
       VALUES ('version-12b', 'rule-12b', 1, ?, 'draft')`,
    ).run(definition);
    const target = buildApp(testDb.db);
    const res = await target.instance.request(
      '/api/friend-add-rules/rule-12b/test-send?account_id=account-1',
      jsonRequest('POST', {}, { 'Idempotency-Key': 'f12-test-key-0004' }),
      target.bindings,
    );
    expect(res.status).toBe(422);
    expect(lineClientMocks.pushMessage).not.toHaveBeenCalled();
  });
});
