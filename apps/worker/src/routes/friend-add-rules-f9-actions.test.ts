import { beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../worker-env.js';
import type { AuthenticatedStaff } from '../middleware/auth/principal/auth.js';
import { createTestD1, insertFriend, type SqliteD1 } from '../test-utils/d1-sqlite.js';
import { friendAddRules } from './friend-add-rules.js';
import { applyFriendAddRouting } from '../features/friends/friend-add-routing.js';

/*
 * F9: 友だち追加時のすることへ、4つの操作を足す。
 * 友だち情報を入れる・対応マークを付ける・マイルを渡す・共通情報を使う
 * を、保存・参照・実行の全経路で扱う。
 */
const owner: AuthenticatedStaff = {
  id: 'owner-1', name: 'オーナー', role: 'owner', readOnly: false, tenantId: 'tenant-1',
};

function buildApp(db: D1Database) {
  const instance = new Hono<Env>();
  instance.use('*', async (c, next) => {
    c.set('staff', owner);
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

const ACTIONS = [
  { type: 'set_friend_field', label: '名前を入れる', targetId: 'field-1', value: 'ポチ' },
  { type: 'add_support_mark', label: '要対応にする', targetId: 'mark-1' },
  { type: 'grant_mileage', label: '初回特典', amount: 100 },
  { type: 'use_common_var', label: '紹介数を数える', targetId: 'invite_count', op: 'add', value: '1' },
];

function seedBase(raw: SqliteD1['raw']): void {
  raw.prepare(`INSERT INTO tenants (id, name) VALUES ('tenant-1', '統括1')`).run();
  raw.prepare(
    `INSERT INTO line_accounts
       (id, channel_id, name, channel_access_token, channel_secret, is_active, tenant_id)
     VALUES ('account-1', 'channel-1', '店舗1', '', '', 1, 'tenant-1')`,
  ).run();
  raw.prepare(
    `INSERT INTO staff_members (id, name, role, api_key, tenant_id)
     VALUES ('owner-1', 'オーナー', 'owner', 'owner-key', 'tenant-1')`,
  ).run();
  raw.prepare(
    `INSERT INTO entry_routes (id, name, ref_code, is_active, line_account_id)
     VALUES ('route-1', '紹介QR', 'REF001', 1, 'account-1')`,
  ).run();
  raw.prepare(
    `INSERT INTO friend_fields (id, name, field_key, type)
     VALUES ('field-1', 'ペット名', 'pet_name', 'text')`,
  ).run();
  raw.prepare(`INSERT INTO support_marks (id, name) VALUES ('mark-1', '要対応')`).run();
  raw.prepare(
    `INSERT INTO common_vars (id, name, var_key, value, line_account_id)
     VALUES ('var-1', '紹介数', 'invite_count', '10', 'account-1')`,
  ).run();
}

function seedPublishedRule(raw: SqliteD1['raw'], actions: unknown[]): void {
  const definition = JSON.stringify({
    routeIds: ['route-1'],
    scenarioId: null,
    messageType: 'text',
    messageText: 'はじめまして',
    timing: 'immediate',
    actions,
    friendCondition: '',
    activeFrom: null,
    activeUntil: null,
  });
  raw.prepare(
    `INSERT INTO friend_add_rules
      (id, line_account_id, friend_kind, name, priority, status, current_version_id, created_at, updated_at)
     VALUES ('rule-9', 'account-1', 'first_time', 'F9の配信', 1, 'published', 'version-9',
             '2026-10-01T09:00:00+09:00', '2026-10-01T09:00:00+09:00')`,
  ).run();
  raw.prepare(
    `INSERT INTO friend_add_rule_versions
      (id, rule_id, version_number, definition_snapshot, status, published_at)
     VALUES ('version-9', 'rule-9', 1, ?, 'published', '2026-10-01T09:00:00+09:00')`,
  ).run(definition);
}

describe('F9: 4つの操作の保存・参照・実行', () => {
  let testDb: SqliteD1;

  beforeEach(() => {
    testDb = createTestD1();
    seedBase(testDb.raw);
  });

  it('保存: 4つの操作が下書きに残り詳細で読める', async () => {
    const target = buildApp(testDb.db);
    const created = await target.instance.request(
      '/api/friend-add-rules/drafts',
      jsonRequest('POST', {
        accountId: 'account-1',
        name: 'F9の下書き',
        friendKind: 'first_time',
        priority: 1,
        definition: {
          routeIds: ['route-1'],
          scenarioId: null,
          messageType: 'text',
          messageText: 'はじめまして',
          timing: 'immediate',
          actions: ACTIONS,
          friendCondition: '',
        },
      }, { 'Idempotency-Key': 'f9-draft-key-0001' }),
      target.bindings,
    );
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { data: { id: string } };

    const detail = await target.instance.request(
      `/api/friend-add-rules/${createdBody.data.id}?account_id=account-1`,
      {},
      target.bindings,
    );
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as {
      data: { rule: { definition: { actions: Array<{ type: string }> } } };
    };
    expect(detailBody.data.rule.definition.actions.map((action) => action.type)).toEqual([
      'set_friend_field',
      'add_support_mark',
      'grant_mileage',
      'use_common_var',
    ]);
  });

  it('保存: 形が壊れた操作は400で止める', async () => {
    const target = buildApp(testDb.db);
    const badCases: unknown[][] = [
      [{ type: 'set_friend_field', label: 'x' }],
      [{ type: 'set_friend_field', label: 'x', targetId: 'field-1' }],
      [{ type: 'add_support_mark', label: 'x' }],
      [{ type: 'grant_mileage', label: 'x', amount: 0 }],
      [{ type: 'grant_mileage', label: 'x', amount: 1000001 }],
      [{ type: 'use_common_var', label: 'x', targetId: 'invite_count', op: 'add', value: 'abc' }],
      [{ type: 'use_common_var', label: 'x', targetId: 'invite_count', op: 'times', value: '1' }],
    ];
    for (const actions of badCases) {
      const res = await target.instance.request(
        '/api/friend-add-rules/drafts',
        jsonRequest('POST', {
          accountId: 'account-1',
          name: 'F9の壊れた下書き',
          friendKind: 'first_time',
          priority: 1,
          definition: {
            routeIds: ['route-1'],
            messageType: 'text',
            messageText: 'はじめまして',
            timing: 'immediate',
            actions,
            friendCondition: '',
          },
        }, { 'Idempotency-Key': `f9-bad-key-${Math.random().toString(36).slice(2)}` }),
        target.bindings,
      );
      expect(res.status).toBe(400);
    }
  });

  it('参照: 使えない参照先は保存時に止める', async () => {
    const target = buildApp(testDb.db);
    const created = await target.instance.request(
      '/api/friend-add-rules/drafts',
      jsonRequest('POST', {
        accountId: 'account-1',
        name: 'F9の参照切れ',
        friendKind: 'first_time',
        priority: 1,
        definition: {
          routeIds: ['route-1'],
          messageType: 'text',
          messageText: 'はじめまして',
          timing: 'immediate',
          actions: [{ type: 'set_friend_field', label: 'x', targetId: 'field-x', value: 'v' }],
          friendCondition: '',
        },
      }, { 'Idempotency-Key': 'f9-ref-draft-key-01' }),
      target.bindings,
    );
    // 保存時に止まるのが正しい（参照の保存経路）。
    expect(created.status).toBe(400);
  });

  it('参照: 公開前確認は壊れた参照先を通さない', async () => {
    // 保存をすり抜けた壊れた参照先を直接植えて、確認口で止まるか見る。
    const definition = JSON.stringify({
      routeIds: ['route-1'],
      scenarioId: null,
      messageType: 'text',
      messageText: 'はじめまして',
      timing: 'immediate',
      actions: [{ type: 'add_support_mark', label: 'x', targetId: 'mark-x' }],
      friendCondition: '',
      activeFrom: null,
      activeUntil: null,
    });
    testDb.raw.prepare(
      `INSERT INTO friend_add_rules
        (id, line_account_id, friend_kind, name, priority, status, current_version_id, created_at, updated_at)
       VALUES ('rule-9v', 'account-1', 'first_time', 'F9の確認', 1, 'draft', 'version-9v',
               '2026-10-01T09:00:00+09:00', '2026-10-01T09:00:00+09:00')`,
    ).run();
    testDb.raw.prepare(
      `INSERT INTO friend_add_rule_versions
        (id, rule_id, version_number, definition_snapshot, status)
       VALUES ('version-9v', 'rule-9v', 1, ?, 'draft')`,
    ).run(definition);

    const target = buildApp(testDb.db);
    const res = await target.instance.request(
      '/api/friend-add-rules/rule-9v/validate?account_id=account-1',
      { method: 'POST' },
      target.bindings,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { canPublish: boolean; checks: Array<{ status: string; label: string }> };
    };
    expect(body.data.canPublish).toBe(false);
    expect(body.data.checks.some((check) => check.status === 'failed')).toBe(true);
  });

  it('実行: 4つの操作が友だち追加で実際に動く', async () => {
    seedPublishedRule(testDb.raw, ACTIONS);
    insertFriend(testDb.raw, 'friend-9', { line_account_id: 'account-1', display_name: '見本 141' });

    const result = await applyFriendAddRouting(testDb.db, 'account-1', { id: 'friend-9' }, undefined, {
      entryRouteId: 'route-1',
      now: new Date('2026-10-02T10:00:00+09:00'),
    });
    expect(result.routed).toBe(true);
    expect(result.ruleId).toBe('rule-9');
    expect(result.actionFailureCount ?? 0).toBe(0);

    const fieldValue = testDb.raw.prepare(
      `SELECT value FROM friend_field_values WHERE friend_id = 'friend-9' AND field_id = 'field-1'`,
    ).get() as { value: string } | undefined;
    expect(fieldValue?.value).toBe('ポチ');

    const friend = testDb.raw.prepare(
      `SELECT support_mark_id FROM friends WHERE id = 'friend-9'`,
    ).get() as { support_mark_id: string | null };
    expect(friend.support_mark_id).toBe('mark-1');

    const mileage = testDb.raw.prepare(
      `SELECT amount FROM mileage_ledger WHERE beneficiary_friend_id = 'friend-9'`,
    ).get() as { amount: number } | undefined;
    expect(mileage?.amount).toBe(100);

    const commonVar = testDb.raw.prepare(
      `SELECT value FROM common_vars WHERE var_key = 'invite_count'`,
    ).get() as { value: string };
    expect(commonVar.value).toBe('11');
  });

  it('実行: 使えない参照先があると配信しない', async () => {
    seedPublishedRule(testDb.raw, [
      { type: 'set_friend_field', label: 'x', targetId: 'field-x', value: 'v' },
    ]);
    insertFriend(testDb.raw, 'friend-9b', { line_account_id: 'account-1', display_name: '見本 181' });

    const result = await applyFriendAddRouting(testDb.db, 'account-1', { id: 'friend-9b' }, undefined, {
      entryRouteId: 'route-1',
      now: new Date('2026-10-02T10:00:00+09:00'),
    });
    expect(result.suppressReason).toBe('reference_out_of_account');
  });
});
