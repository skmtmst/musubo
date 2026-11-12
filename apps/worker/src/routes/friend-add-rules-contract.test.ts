import { unhandledWorkerError } from '../lib/unhandled-error.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Env } from '../worker-env.js';
import type { AuthenticatedStaff } from '../middleware/auth/principal/auth.js';
import { createTestD1, insertFriend, type SqliteD1 } from '../test-utils/d1-sqlite.js';
import { friendAddRules } from './friend-add-rules.js';

const owner: AuthenticatedStaff = {
  id: 'owner-1', name: 'オーナー', role: 'owner', readOnly: false, tenantId: 'tenant-1',
};
const staff: AuthenticatedStaff = {
  ...owner, id: 'staff-1', name: '担当者', role: 'staff', permissionKeys: ['/friend-add-settings'],
};
const admin: AuthenticatedStaff = {
  ...owner, id: 'admin-1', name: '管理者', role: 'admin', readOnly: false,
};

function app(db: D1Database, actor: AuthenticatedStaff = owner) {
  const instance = new Hono<Env>();
  instance.use('*', async (c, next) => {
    c.env = { DB: db } as Env['Bindings'];
    c.set('staff', actor);
    await next();
  });
  instance.route('/', friendAddRules);
  instance.onError(unhandledWorkerError);
  return instance;
}

function json(method: string, body: unknown, idempotencyKey?: string) {
  return {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    body: JSON.stringify(body),
  };
}

function ensureMigration(testDb: SqliteD1): void {
  const exists = testDb.raw.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'friend_add_rule_folders'",
  ).get();
  if (!exists) {
    testDb.raw.exec(readFileSync(join(
      import.meta.dirname,
      '../../../../packages/db/migrations/308_friend_add_rule_data_contract.sql',
    ), 'utf8'));
  }
}

function seedRuleAndRun(testDb: SqliteD1): void {
  const definition = JSON.stringify({
    routeIds: ['route-1'], scenarioId: 'scenario-1', messageType: 'text',
    messageText: '友だち追加ありがとうございます', timing: 'immediate', actions: [
      { type: 'add_tag', label: '見込み客タグ', targetId: 'tag-1' },
    ],
    // 実行時も読める現在の形式で入れる。旧形式の自由文は実行時 fail-closed で
    // 止まるため、公開版のfixtureに残すとテスト・公開前確認が正しく止まる。
    friendCondition: JSON.stringify({
      operator: 'AND', rules: [{ type: 'tag_exists', value: 'tag-1' }],
    }),
    activeFrom: null, activeUntil: null,
    weekdays: [1, 2, 3], timeWindows: [{ start: '09:00', end: '18:00' }],
    resendSuppressionHours: 24,
    deliveryChoices: { sendWelcomeMessage: true, startScenario: true, runActions: true },
    unknownRouteAction: { sendCommonGuidance: true, notifyStaff: true },
  });
  testDb.raw.prepare(
    `INSERT INTO entry_routes (id, name, ref_code, is_active, line_account_id)
     VALUES ('route-1', '紹介QR', 'REF001', 1, 'account-1')`,
  ).run();
  testDb.raw.prepare(
    `INSERT INTO scenarios (id, name, trigger_type, is_active, line_account_id)
     VALUES ('scenario-1', '初回案内', 'friend_add', 1, 'account-1')`,
  ).run();
  testDb.raw.prepare("INSERT INTO tags (id, name, line_account_id) VALUES ('tag-1', '見込み客', 'account-1')").run();
  testDb.raw.prepare(
    `INSERT INTO friend_add_rules
      (id, line_account_id, friend_kind, name, priority, status, current_version_id, created_at, updated_at)
     VALUES ('rule-1', 'account-1', 'first_time', '紹介QR', 1, 'published', 'version-1',
             '2026-09-07T09:00:00.000', '2026-09-07T09:00:00.000'),
            ('rule-2', 'account-1', 'first_time', '紹介キャンペーン', 1, 'published', 'version-2',
             '2026-09-07T09:01:00.000', '2026-09-07T09:01:00.000')`,
  ).run();
  testDb.raw.prepare(
    `INSERT INTO friend_add_rule_versions
      (id, rule_id, version_number, definition_snapshot, status, published_at)
     VALUES ('version-1', 'rule-1', 3, ?, 'published', '2026-09-07T09:00:00.000'),
            ('version-2', 'rule-2', 1, ?, 'published', '2026-09-07T09:01:00.000')`,
  ).run(definition, definition);
  insertFriend(testDb.raw, 'friend-1', { line_account_id: 'account-1', display_name: '見本 141' });
  testDb.raw.prepare(
    `INSERT INTO friend_scenarios
      (id, friend_id, scenario_id, status, started_at, updated_at)
     VALUES ('enrollment-1', 'friend-1', 'scenario-1', 'active',
             '2026-09-07T10:00:01.000', '2026-09-07T10:00:01.000')`,
  ).run();
  testDb.raw.prepare(
    `INSERT INTO friend_add_events
      (id, line_account_id, friend_id, webhook_event_id, friend_kind, attribution_status,
       ref_code, entry_route_id, routing_rule_id, routing_status, occurred_at, processed_at,
       winning_rule_version_id, scenario_enrollment_id, delivery_count, first_delivery_sent_at)
     VALUES ('run-1', 'account-1', 'friend-1', 'webhook-1', 'first_time', 'captured',
             'REF001', 'route-1', 'rule-1', 'completed',
             '2026-09-07T10:00:00.000', '2026-09-07T10:00:02.000', 'version-1',
             'enrollment-1', 1, '2026-09-07T10:00:02.000')`,
  ).run();
  testDb.raw.prepare(
    `INSERT INTO friend_add_action_runs
      (id, event_id, action_stable_id, idempotency_key, status, attempt_count, created_at, updated_at)
     VALUES ('action-run-1', 'run-1', 'action-1', 'run-1:action-1', 'completed', 1,
             '2026-09-07T10:00:01.000', '2026-09-07T10:00:02.000')`,
  ).run();
}

function seedFallback(
  testDb: SqliteD1,
  input: { id: string; accountId: string; status: 'published' | 'stopped' },
): void {
  const versionId = `${input.id}-version`;
  testDb.raw.prepare(
    `INSERT INTO friend_add_rules
      (id, line_account_id, friend_kind, name, priority, is_unknown_route_fallback,
       status, current_version_id, created_at, updated_at)
     VALUES (?, ?, 'first_time', '経路が分からなかった人', 9999, 1, ?, ?,
             '2026-09-07T08:00:00.000', '2026-09-07T08:00:00.000')`,
  ).run(input.id, input.accountId, input.status, versionId);
  testDb.raw.prepare(
    `INSERT INTO friend_add_rule_versions
      (id, rule_id, version_number, definition_snapshot, status, published_at)
     VALUES (?, ?, 1, ?, 'published', '2026-09-07T08:00:00.000')`,
  ).run(versionId, input.id, JSON.stringify({
    routeIds: [], scenarioId: 'scenario-1', messageType: 'scenario', messageText: '',
    timing: 'scenario', actions: [], friendCondition: '', activeFrom: null, activeUntil: null,
  }));
}

describe('friend-add rule data contracts', () => {
  let testDb: SqliteD1;

  beforeEach(() => {
    testDb = createTestD1();
    ensureMigration(testDb);
    testDb.raw.prepare("INSERT INTO tenants (id, name) VALUES ('tenant-1', '統括1'), ('tenant-2', '統括2')").run();
    testDb.raw.prepare(
      `INSERT INTO line_accounts
        (id, channel_id, name, channel_access_token, channel_secret, is_active, tenant_id)
       VALUES ('account-1', 'channel-1', '店舗1', 'token-1', 'secret-1', 1, 'tenant-1'),
              ('account-2', 'channel-2', '店舗2', 'token-2', 'secret-2', 1, 'tenant-2')`,
    ).run();
    testDb.raw.prepare(
      `INSERT INTO staff_members (id, name, role, api_key, tenant_id)
       VALUES ('owner-1', 'オーナー', 'owner', 'owner-key', 'tenant-1'),
              ('admin-1', '管理者', 'admin', 'admin-key', 'tenant-1')`,
    ).run();
  });

  afterEach(() => testDb.raw.close());

  it('友だち行がない履歴は一覧にも総数にも含めず、絞り込みとページ送りでも一致する', async () => {
    seedRuleAndRun(testDb);
    testDb.raw.pragma('foreign_keys = OFF');
    testDb.raw.exec(`INSERT INTO friend_add_events
      (id, line_account_id, friend_id, webhook_event_id, friend_kind, attribution_status, routing_status, occurred_at)
      VALUES ('orphan', 'account-1', 'missing-friend', 'webhook-missing', 'first_time', 'captured', 'completed', '2026-09-07T11:00:00.000'),
             ('run-2', 'account-1', 'friend-1', 'webhook-2', 'first_time', 'captured', 'completed', '2026-09-07T12:00:00.000')`);
    testDb.raw.pragma('foreign_keys = ON');
    const path = '/api/friend-add-runs?account_id=account-1&kind=first_time&limit=1';
    const first = await app(testDb.db).request(path);
    expect(first.status).toBe(200);
    const firstBody = await first.json() as { data: { total: number; items: Array<{ id: string }>; nextCursor: string } };
    expect(firstBody.data.total).toBe(2);
    expect(firstBody.data.items.map(item => item.id)).toEqual(['run-2']);
    expect(firstBody.data.nextCursor).toBeTruthy();
    const second = await app(testDb.db).request(`${path}&cursor=${encodeURIComponent(firstBody.data.nextCursor)}`);
    const secondBody = await second.json() as { data: { total: number; items: Array<{ id: string }>; nextCursor: string | null } };
    expect(secondBody.data.total).toBe(2);
    expect(secondBody.data.items.map(item => item.id)).toEqual(['run-1']);
    expect(secondBody.data.nextCursor).toBeNull();
  });

  it('友だちが存在しないか所属が違う記録は、総数だけでなく上部集計と失敗内訳にも含めない', async () => {
    seedRuleAndRun(testDb);
    insertFriend(testDb.raw, 'other-friend', { line_account_id: 'account-2', display_name: '他店' });
    testDb.raw.pragma('foreign_keys = OFF');
    testDb.raw.exec(`INSERT INTO friend_add_events
      (id, line_account_id, friend_id, webhook_event_id, friend_kind, attribution_status, routing_status, error_code, occurred_at, delivery_count)
      VALUES ('orphan', 'account-1', 'missing', 'missing-webhook', 'first_time', 'captured', 'failed', 'invalid_reference', '2026-09-07T11:00:00.000', 7),
             ('wrong-account', 'account-1', 'other-friend', 'other-webhook', 'first_time', 'captured', 'failed', 'invalid_reference', '2026-09-07T12:00:00.000', 9)`);
    testDb.raw.pragma('foreign_keys = ON');
    const response = await app(testDb.db).request('/api/friend-add-runs?account_id=account-1&period=all');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ data: {
      total: 1, items: [{ id: 'run-1' }], summary: { recentFriends: 1, recentEvents: 1, capturedFriends: 1, cumulativeDeliveries: 1, failed: 0, failureKinds: [] },
    } });
  });

  it('期間の絞り込みはJST境界・集計・ページ送りにも効く', async () => {
    seedRuleAndRun(testDb);
    testDb.raw.exec(`UPDATE friend_add_events SET occurred_at = '2026-09-07T00:00:00.000';
      INSERT INTO friend_add_events (id, line_account_id, friend_id, webhook_event_id, friend_kind, attribution_status, routing_status, error_code, occurred_at)
      VALUES ('run-2', 'account-1', 'friend-1', 'webhook-2', 'returning', 'captured', 'partial_failed', 'send_failed', '2026-09-07T23:59:59.000'),
             ('run-3', 'account-1', 'friend-1', 'webhook-3', 'returning', 'unavailable', 'failed', 'action_failed', '2026-09-08T00:00:00.000');`);
    const path = '/api/friend-add-runs?account_id=account-1&from=2026-09-07&to=2026-09-07&limit=1';
    const response = await app(testDb.db).request(path);
    expect(response.status).toBe(200);
    const { data } = await response.json() as { data: { total: number; items: unknown[]; nextCursor: string; summary: unknown } };
    expect(data.total).toBe(2);
    expect(data.items).toEqual([expect.objectContaining({ id: 'run-2', failureKind: 'delivery_failed' })]);
    expect(data.summary).toMatchObject({ recentFriends: 1, recentEvents: 2, capturedFriends: 1, returning: 1, testPending: null,
      failureKinds: [{ kind: 'delivery_failed', count: 1 }], cumulativeDeliveries: 1 });
    const page = await app(testDb.db).request(`${path}&cursor=${encodeURIComponent(data.nextCursor)}`);
    expect((await page.json() as { data: { items: unknown[]; summary: unknown } }).data).toMatchObject({ items: [{ id: 'run-1' }], summary: data.summary });
    for (const suffix of ['from=2026-02-30', 'period=invalid', 'from=2026-09-08&to=2026-09-07', 'period=this_month&from=2026-09-07']) {
      expect((await app(testDb.db).request(`/api/friend-add-runs?account_id=account-1&${suffix}`)).status).toBe(400);
    }
  });

  it('該当する記録が0件の集計は両方のタブで0を返す', async () => {
    seedRuleAndRun(testDb);
    testDb.raw.exec("UPDATE friend_add_events SET occurred_at = '2001-01-01T00:00:00.000'");
    for (const kind of ['first_time', 'returning']) {
      const response = await app(testDb.db).request(`/api/friend-add-rules?account_id=account-1&kind=${kind}`);
      expect(response.status).toBe(200);
      expect((await response.json() as { data: { summary: unknown } }).data.summary).toMatchObject({
        recentAdds: 0, captured: 0, unknownRoute: 0, delivered: 0, failed: 0,
      });
    }
  });

  it('通常: ルールの総件数・競合根拠・実行集計・版とアクション詳細を返す', async () => {
    seedRuleAndRun(testDb);
    const list = await app(testDb.db).request('/api/friend-add-rules?account_id=account-1&kind=first_time&limit=1');
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toMatchObject({
      data: { total: 3, items: [{ id: 'rule-1', version: 1 }], nextCursor: expect.any(String) },
    });

    const conflicts = await app(testDb.db).request('/api/friend-add-rules/conflicts?account_id=account-1&kind=first_time');
    expect(conflicts.status).toBe(200);
    await expect(conflicts.json()).resolves.toMatchObject({
      data: {
        conflicts: expect.arrayContaining([
          expect.objectContaining({ code: 'same_priority', ruleIds: ['rule-1', 'rule-2'] }),
          expect.objectContaining({ code: 'overlapping_weekday', ruleIds: ['rule-1', 'rule-2'] }),
          expect.objectContaining({ code: 'overlapping_time', ruleIds: ['rule-1', 'rule-2'] }),
          expect.objectContaining({ code: 'same_friend_condition', ruleIds: ['rule-1', 'rule-2'] }),
        ]),
      },
    });

    const runs = await app(testDb.db).request('/api/friend-add-runs?account_id=account-1');
    expect(runs.status).toBe(200);
    await expect(runs.json()).resolves.toMatchObject({
      data: {
        items: [{ id: 'run-1', rule: { versionNumber: 3 }, scenario: { started: true }, actions: { total: 1 } }],
        summary: { cumulativeDeliveries: 1, scenarioStarts: 1, averageSendTimeMs: 2000 },
      },
    });

    const detail = await app(testDb.db).request('/api/friend-add-runs/run-1?account_id=account-1');
    expect(detail.status).toBe(200);
    await expect(detail.json()).resolves.toMatchObject({
      data: { id: 'run-1', rule: { id: 'rule-1', versionId: 'version-1' }, actionRuns: [{ stableId: 'action-1' }] },
    });
  });

  it('staffの実行結果read modelは顧客名・顧客ID・メッセージ本文を返さず、adminは詳細を維持する', async () => {
    seedRuleAndRun(testDb);

    const staffList = await app(testDb.db, staff).request('/api/friend-add-runs?account_id=account-1');
    expect(staffList.status).toBe(200);
    const staffListBody = await staffList.json() as {
      data: { items: Array<{ friend: Record<string, unknown> }> };
    };
    expect(staffListBody.data.items[0].friend).toEqual({ displayName: '顧客名は非表示', redacted: true });
    expect(JSON.stringify(staffListBody)).not.toContain('見本 141');
    expect(JSON.stringify(staffListBody)).not.toContain('friend-1');

    const staffDetail = await app(testDb.db, staff).request('/api/friend-add-runs/run-1?account_id=account-1');
    expect(staffDetail.status).toBe(200);
    const staffDetailBody = await staffDetail.json() as {
      data: { friend: Record<string, unknown>; rule: Record<string, unknown>; configuredActions?: unknown };
    };
    expect(staffDetailBody.data.friend).toEqual({ displayName: '顧客名は非表示', redacted: true });
    expect(staffDetailBody.data.rule).not.toHaveProperty('definition');
    expect(staffDetailBody.data).not.toHaveProperty('configuredActions');
    expect(JSON.stringify(staffDetailBody)).not.toContain('見本 141');
    expect(JSON.stringify(staffDetailBody)).not.toContain('友だち追加ありがとうございます');

    const adminDetail = await app(testDb.db, admin).request('/api/friend-add-runs/run-1?account_id=account-1');
    expect(adminDetail.status).toBe(200);
    const adminDetailBody = await adminDetail.json() as {
      data: { friend: { id: string; displayName: string | null; redacted: boolean }; rule: { definition: { messageText: string } }; configuredActions: unknown[] };
    };
    expect(adminDetailBody.data.friend).toEqual({ id: 'friend-1', displayName: '見本 141', redacted: false });
    expect(adminDetailBody.data.rule.definition.messageText).toBe('友だち追加ありがとうございます');
    expect(adminDetailBody.data.configuredActions).toHaveLength(1);

    const ownerDetail = await app(testDb.db, owner).request('/api/friend-add-runs/run-1?account_id=account-1');
    expect(ownerDetail.status).toBe(200);
    await expect(ownerDetail.json()).resolves.toMatchObject({
      data: { friend: { id: 'friend-1', displayName: '見本 141', redacted: false } },
    });

    const otherAccount = await app(testDb.db, staff).request('/api/friend-add-runs?account_id=account-2');
    expect(otherAccount.status).toBe(404);
  });

  it('空: 実行結果が無いときも0件と未取得を区別して返す', async () => {
    const response = await app(testDb.db).request('/api/friend-add-runs?account_id=account-1');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { items: [], total: 0, summary: { cumulativeDeliveries: 0, scenarioStarts: 0, averageSendTimeMs: null } },
    });
  });

  it('別アカウントは存在を隠し、鍵のないstaffはフォルダを作れない', async () => {
    const hidden = await app(testDb.db).request('/api/friend-add-runs?account_id=account-2');
    expect(hidden.status).toBe(404);
    const forbidden = await app(testDb.db, { ...staff, permissionKeys: [] }).request('/api/friend-add-rules/folders', json(
      'POST', { accountId: 'account-1', name: '紹介' }, 'friend-add-folder-0001',
    ));
    expect(forbidden.status).toBe(403);
  });

  it('DB失敗は500として返す', async () => {
    const failingDb = {
      prepare: () => ({ bind: () => ({ all: async () => { throw new Error('db unavailable'); } }) }),
    } as unknown as D1Database;
    const response = await app(failingDb).request('/api/friend-add-runs?account_id=account-1');
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ success: false, error: 'Internal Server Error', incidentId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
  });

  it('フォルダ作成を冪等にし、下書き保存と停止の古い版を409にする', async () => {
    seedRuleAndRun(testDb);
    const folderRequest = json('POST', { accountId: 'account-1', name: '紹介' }, 'friend-add-folder-0001');
    const created = await app(testDb.db).request('/api/friend-add-rules/folders', folderRequest);
    expect(created.status).toBe(201);
    const replay = await app(testDb.db).request('/api/friend-add-rules/folders', folderRequest);
    expect(replay.status).toBe(200);
    expect((await created.json() as { data: { id: string } }).data.id)
      .toBe((await replay.json() as { data: { id: string } }).data.id);

    const definition = JSON.parse(testDb.raw.prepare(
      "SELECT definition_snapshot FROM friend_add_rule_versions WHERE id = 'version-1'",
    ).pluck().get() as string);
    const save = await app(testDb.db).request('/api/friend-add-rules/rule-1/draft', json(
      'PUT', {
        accountId: 'account-1', friendKind: 'first_time', name: '紹介QR', priority: 1,
        version: 0, definition,
      },
      'friend-add-save-000001',
    ));
    expect(save.status).toBe(409);

    const stop = await app(testDb.db).request('/api/friend-add-rules/rule-1/stop?account_id=account-1', json(
      'POST', { version: 0 }, 'friend-add-stop-000001',
    ));
    expect(stop.status).toBe(409);
  });

  it('停止routeは別account・停止済みの受け皿を数えず、公開中ルールを保つ', async () => {
    seedRuleAndRun(testDb);
    seedFallback(testDb, { id: 'fallback-other', accountId: 'account-2', status: 'published' });
    seedFallback(testDb, { id: 'fallback-stopped', accountId: 'account-1', status: 'stopped' });

    const response = await app(testDb.db).request(
      '/api/friend-add-rules/rule-1/stop?account_id=account-1',
      json('POST', { version: 1 }, 'friend-add-stop-guard-0001'),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      code: 'FALLBACK_REQUIRED',
    });
    expect(testDb.raw.prepare("SELECT status, lock_version FROM friend_add_rules WHERE id = 'rule-1'").get())
      .toEqual({ status: 'published', lock_version: 1 });
  });

  it('停止routeは同一account・同一対象の公開済み受け皿があるときだけ停止する', async () => {
    seedRuleAndRun(testDb);
    seedFallback(testDb, { id: 'fallback-own', accountId: 'account-1', status: 'published' });

    const response = await app(testDb.db).request(
      '/api/friend-add-rules/rule-1/stop?account_id=account-1',
      json('POST', { version: 1 }, 'friend-add-stop-guard-0002'),
    );

    expect(response.status).toBe(200);
    expect(testDb.raw.prepare(
      "SELECT id, status FROM friend_add_rules WHERE id IN ('rule-1', 'fallback-own') ORDER BY id",
    ).all()).toEqual([
      { id: 'fallback-own', status: 'published' },
      { id: 'rule-1', status: 'stopped' },
    ]);
  });

  it('実行結果の種類・経路の絞り込みをサーバ側で行い、不正な値は400にする', async () => {
    seedRuleAndRun(testDb);
    insertFriend(testDb.raw, 'friend-2', { line_account_id: 'account-1', display_name: '見本 122' });
    testDb.raw.prepare(
      `INSERT INTO friend_add_events
        (id, line_account_id, friend_id, webhook_event_id, friend_kind, attribution_status,
         ref_code, entry_route_id, routing_rule_id, routing_status, occurred_at, processed_at,
         winning_rule_version_id, scenario_enrollment_id, delivery_count, first_delivery_sent_at)
       VALUES ('run-2', 'account-1', 'friend-2', 'webhook-2', 'returning', 'unavailable',
               'REF002', 'route-1', 'rule-1', 'completed',
               '2026-09-07T11:00:00.000', '2026-09-07T11:00:02.000', 'version-1',
               NULL, 0, NULL)`,
    ).run();

    const returning = await app(testDb.db).request('/api/friend-add-runs?account_id=account-1&kind=returning');
    expect(returning.status).toBe(200);
    await expect(returning.json()).resolves.toMatchObject({
      data: { items: [{ id: 'run-2' }], total: 1 },
    });

    const firstTime = await app(testDb.db).request('/api/friend-add-runs?account_id=account-1&kind=first_time');
    expect(firstTime.status).toBe(200);
    await expect(firstTime.json()).resolves.toMatchObject({
      data: { items: [{ id: 'run-1' }], total: 1 },
    });

    const unavailable = await app(testDb.db).request('/api/friend-add-runs?account_id=account-1&attribution=unavailable');
    expect(unavailable.status).toBe(200);
    await expect(unavailable.json()).resolves.toMatchObject({
      data: { items: [{ id: 'run-2' }], total: 1 },
    });

    const bogusKind = await app(testDb.db).request('/api/friend-add-runs?account_id=account-1&kind=bogus');
    expect(bogusKind.status).toBe(400);
    const bogusAttribution = await app(testDb.db).request('/api/friend-add-runs?account_id=account-1&attribution=bogus');
    expect(bogusAttribution.status).toBe(400);
  });

  /*
   * 「直近28日の追加」は人数（ユニーク友だち）と回数（追加記録）を
   * 分け、期間の外・別アカウント・絞り込みの外を数えない。
   * 「最終配信」は実際に送った記録の最新日時（受信順の先頭行の
   * 処理時刻ではない）。
   */
  it('実行結果の集計は28日窓・絞り込み・実送信日時と一致する', async () => {
    insertFriend(testDb.raw, 'friend-1', { line_account_id: 'account-1', display_name: '見本 141' });
    insertFriend(testDb.raw, 'friend-2', { line_account_id: 'account-1', display_name: '見本 122' });
    insertFriend(testDb.raw, 'friend-9', { line_account_id: 'account-2', display_name: '見本 20' });
    const jst = (daysAgo: number, hour = 10) =>
      new Date(Date.now() - daysAgo * 86400000 + 9 * 3600000).toISOString().slice(0, 11) + `${String(hour).padStart(2, '0')}:00:00.000+09:00`;
    const insertRun = (row: {
      id: string; friendId: string; accountId?: string; kind?: string; status?: string;
      occurredAt: string; processedAt?: string | null; deliveries?: number; firstSentAt?: string | null;
    }) => testDb.raw.prepare(
      `INSERT INTO friend_add_events
        (id, line_account_id, friend_id, webhook_event_id, friend_kind, attribution_status,
         routing_status, occurred_at, processed_at, delivery_count, first_delivery_sent_at)
       VALUES (?, ?, ?, ?, ?, 'captured', ?, ?, ?, ?, ?)`,
    ).run(
      row.id, row.accountId ?? 'account-1', row.friendId, `webhook-${row.id}`,
      row.kind ?? 'first_time', row.status ?? 'completed', row.occurredAt,
      row.processedAt ?? row.occurredAt, row.deliveries ?? 0, row.firstSentAt ?? null,
    );

    // 直近28日内：同じ友だちへの2記録（人=1、記録=2）。先に来た記録ほど配信が古い。
    insertRun({ id: 'run-a', friendId: 'friend-1', occurredAt: jst(3, 10), processedAt: jst(3, 10), deliveries: 1, firstSentAt: jst(3, 10) });
    insertRun({ id: 'run-b', friendId: 'friend-1', occurredAt: jst(2, 9), processedAt: jst(2, 9) });
    // 28日より前：friend-2 の記録（直近28日の人数・回数に入らない）。
    insertRun({ id: 'run-c', friendId: 'friend-2', occurredAt: jst(40, 8), deliveries: 1, firstSentAt: jst(40, 8) });
    // 配信していないが処理済みの記録が最新――「最終配信」に使ってはいけない。
    insertRun({ id: 'run-d', friendId: 'friend-2', occurredAt: jst(1, 12), processedAt: jst(1, 12), status: 'suppressed' });
    // 別アカウントの記録は対象外。
    insertRun({ id: 'run-e', friendId: 'friend-9', accountId: 'account-2', occurredAt: jst(1, 11), deliveries: 1, firstSentAt: jst(1, 11) });

    const response = await app(testDb.db).request('/api/friend-add-runs?account_id=account-1');
    expect(response.status).toBe(200);
    const body = await response.json() as {
      data: {
        summary: {
          recentFriends: number; recentEvents: number; cumulativeDeliveries: number;
          failed: number; lastDeliveryAt: string | null;
        };
      };
    };
    expect(body.data.summary.recentFriends).toBe(2);   // friend-1・friend-2（run-d は28日内）
    expect(body.data.summary.recentEvents).toBe(3);    // run-a・run-b・run-d
    expect(body.data.summary.cumulativeDeliveries).toBe(2); // run-a + run-c（全期間）
    expect(body.data.summary.lastDeliveryAt).toBe(jst(3, 10)); // run-dの処理時刻ではない

    // 絞り込みは集計にも効く：該当なしの条件では上部も0になる。
    const filtered = await app(testDb.db).request('/api/friend-add-runs?account_id=account-1&kind=returning');
    const filteredBody = await filtered.json() as typeof body;
    expect(filteredBody.data.summary.recentFriends).toBe(0);
    expect(filteredBody.data.summary.recentEvents).toBe(0);
    expect(filteredBody.data.summary.cumulativeDeliveries).toBe(0);
    expect(filteredBody.data.summary.lastDeliveryAt).toBeNull();
  });

  it('送れなかった実行はpartial_failedで絞れ、要確認に数える', async () => {
    seedRuleAndRun(testDb);
    insertFriend(testDb.raw, 'friend-2', { line_account_id: 'account-1', display_name: '見本 122' });
    testDb.raw.prepare(
      `INSERT INTO friend_add_events
        (id, line_account_id, friend_id, webhook_event_id, friend_kind, attribution_status,
         routing_rule_id, routing_status, error_code, occurred_at, delivery_count)
       VALUES ('run-partial', 'account-1', 'friend-2', 'webhook-partial', 'first_time', 'unavailable',
               'rule-1', 'partial_failed', 'send_failed', '2026-09-07T11:00:00.000', 0)`,
    ).run();

    const partial = await app(testDb.db).request('/api/friend-add-runs?account_id=account-1&status=partial_failed');
    expect(partial.status).toBe(200);
    await expect(partial.json()).resolves.toMatchObject({
      data: { items: [{ id: 'run-partial', status: 'partial_failed', errorCode: 'send_failed' }], total: 1 },
    });

    const all = await app(testDb.db).request('/api/friend-add-runs?account_id=account-1');
    await expect(all.json()).resolves.toMatchObject({
      data: { summary: { failed: 1 } },
    });
  });

  it('テストの失敗も成功時と同じ器で理由を返し、別アカウントは存在を隠す', async () => {
    seedRuleAndRun(testDb);
    const brokenDefinition = JSON.stringify({
      routeIds: [], scenarioId: null, messageType: 'text', messageText: '',
      timing: 'immediate', actions: [], friendCondition: '',
      activeFrom: null, activeUntil: null, weekdays: [], timeWindows: [],
    });
    testDb.raw.prepare(
      `INSERT INTO friend_add_rules
        (id, line_account_id, friend_kind, name, priority, status, current_version_id, created_at, updated_at)
       VALUES ('rule-3', 'account-1', 'first_time', '下書き案', 5, 'draft', NULL,
               '2026-09-07T09:00:00.000', '2026-09-07T09:00:00.000')`,
    ).run();
    testDb.raw.prepare(
      `INSERT INTO friend_add_rule_versions
        (id, rule_id, version_number, definition_snapshot, status)
       VALUES ('version-3', 'rule-3', 1, ?, 'draft')`,
    ).run(brokenDefinition);

    const failed = await app(testDb.db).request('/api/friend-add-rules/test', json(
      'POST', { accountId: 'account-1', ruleId: 'rule-3' },
    ));
    // 400 にすると管理画面の共通取得部が本文を捨てるため、200 で理由を返す。
    expect(failed.status).toBe(200);
    const failedBody = await failed.json() as { success: boolean; data: { matched: boolean; reasons: string[] } };
    expect(failedBody.success).toBe(false);
    expect(failedBody.data.matched).toBe(false);
    // シナリオの欠落と、選んだ経路が無い（どこにも届かない）欠落の両方を挙げる。
    expect(failedBody.data.reasons).toEqual(expect.arrayContaining([
      '実際に配信するシナリオを決めてください。',
      '対象の流入リンクが選ばれていません。流入条件で1つ以上選んでください。',
    ]));
    expect(testDb.raw.prepare(
      "SELECT last_tested_by_staff_id FROM friend_add_rule_versions WHERE id = 'version-3'",
    ).get()).toMatchObject({ last_tested_by_staff_id: 'owner-1' });
    const detail = await app(testDb.db).request('/api/friend-add-rules/rule-3?account_id=account-1');
    expect(detail.status).toBe(200);
    await expect(detail.json()).resolves.toMatchObject({
      data: { rule: { lastTestedByStaffId: 'owner-1', lastTestedByStaffName: 'オーナー' } },
    });

    // rule-1 の曜日（月〜水）・時間帯（09:00〜18:00）の内側の時刻で確かめる。
    // 想定日時を渡さないと「実行した日の曜日・時刻」に結果が振り回される。
    const succeeded = await app(testDb.db).request('/api/friend-add-rules/test', json(
      'POST', { accountId: 'account-1', ruleId: 'rule-1', expectedAt: '2026-09-28T10:00' },
    ));
    expect(succeeded.status).toBe(200);
    await expect(succeeded.json()).resolves.toMatchObject({
      success: true,
      data: { matched: true },
    });

    const hidden = await app(testDb.db).request('/api/friend-add-rules/test', json(
      'POST', { accountId: 'account-2', ruleId: 'rule-1' },
    ));
    expect(hidden.status).toBe(404);
  });

  /*
   * 参照先の整合だけで選択可能と判定しないよう、経路・曜日・時間帯・有効期間・友だち条件・再送制限を実際の判定器へ通す。
   * rule-1 は月〜水の09:00〜18:00、route-1、見込み客タグ tag-1 を対象とする。
   */
  it('テストは経路・曜日/時間帯・期限・友だちの状態を実判定で確かめる', async () => {
    seedRuleAndRun(testDb);
    testDb.raw.prepare(
      "INSERT INTO friend_tags (friend_id, tag_id) VALUES ('friend-1', 'tag-1')",
    ).run();
    const inside = { accountId: 'account-1', ruleId: 'rule-1', expectedAt: '2026-09-28T10:00' };

    // 条件を満たす友だち・対象の経路・対象の曜日時間 → 選ばれる
    const hit = await app(testDb.db).request('/api/friend-add-rules/test', json(
      'POST', { ...inside, routeId: 'route-1', friendId: 'friend-1' },
    ));
    await expect(hit.json()).resolves.toMatchObject({ success: true, data: { matched: true } });

    // 条件を満たさない友だち（タグ無し）→ 条件不一致の理由
    insertFriend(testDb.raw, 'friend-2', { line_account_id: 'account-1', display_name: '見本 122' });
    const notMet = await app(testDb.db).request('/api/friend-add-rules/test', json(
      'POST', { ...inside, friendId: 'friend-2' },
    ));
    const notMetBody = await notMet.json() as { data: { matched: boolean; reasons: string[] } };
    expect(notMetBody.data.matched).toBe(false);
    expect(notMetBody.data.reasons).toEqual(expect.arrayContaining([
      '試した友だちは、設定した友だち条件を満たしていません。',
    ]));

    // 対象外の曜日（2026-09-27 は日曜）→ 曜日の理由
    const sunday = await app(testDb.db).request('/api/friend-add-rules/test', json(
      'POST', { accountId: 'account-1', ruleId: 'rule-1', expectedAt: '2026-09-27T10:00' },
    ));
    const sundayBody = await sunday.json() as { data: { matched: boolean; reasons: string[] } };
    expect(sundayBody.data.matched).toBe(false);
    expect(sundayBody.data.reasons).toContain('この曜日は配信対象ではありません。');

    // 対象外の流入リンク → 経路の理由
    const wrongRoute = await app(testDb.db).request('/api/friend-add-rules/test', json(
      'POST', { ...inside, routeId: 'route-9' },
    ));
    const wrongRouteBody = await wrongRoute.json() as { data: { matched: boolean; reasons: string[] } };
    expect(wrongRouteBody.data.matched).toBe(false);
    expect(wrongRouteBody.data.reasons).toContain('試した流入リンクはこの設定の対象ではありません。');

    // 他アカウントの友だちは「いない」と返す（存在を教えない）
    insertFriend(testDb.raw, 'friend-x', { line_account_id: 'account-2' });
    const foreign = await app(testDb.db).request('/api/friend-add-rules/test', json(
      'POST', { ...inside, friendId: 'friend-x' },
    ));
    const foreignBody = await foreign.json() as { data: { matched: boolean; reasons: string[] } };
    expect(foreignBody.data.matched).toBe(false);
    expect(foreignBody.data.reasons).toContain('試す友だちがこのアカウントに見つかりません。');

    // 読めない想定日時は 400（理由なしの成功にはしない）
    const badDate = await app(testDb.db).request('/api/friend-add-rules/test', json(
      'POST', { accountId: 'account-1', ruleId: 'rule-1', expectedAt: 'not-a-date' },
    ));
    expect(badDate.status).toBe(400);
  });

  /*
   * 期限切れ・リンク未選択の下書きを選択可能と誤表示しないよう、テストと公開前確認の両方で同じ理由を返す。
   */
  it('期限切れ・流入リンク未選択はテストと公開前確認の両方で止まる', async () => {
    seedRuleAndRun(testDb);
    const expired = JSON.stringify({
      routeIds: [], scenarioId: 'scenario-1', messageType: 'text',
      messageText: '終了した案内', timing: 'immediate', actions: [], friendCondition: '',
      activeFrom: null, activeUntil: '2026-08-28T10:00', weekdays: [], timeWindows: [],
    });
    testDb.raw.prepare(
      `INSERT INTO friend_add_rules
        (id, line_account_id, friend_kind, name, priority, status, current_version_id, created_at, updated_at)
       VALUES ('rule-expired', 'account-1', 'first_time', '終了した案内', 9, 'draft', NULL,
               '2026-09-07T09:00:00.000', '2026-09-07T09:00:00.000')`,
    ).run();
    testDb.raw.prepare(
      `INSERT INTO friend_add_rule_versions
        (id, rule_id, version_number, definition_snapshot, status)
       VALUES ('version-expired', 'rule-expired', 1, ?, 'draft')`,
    ).run(expired);

    const tested = await app(testDb.db).request('/api/friend-add-rules/test', json(
      'POST', { accountId: 'account-1', ruleId: 'rule-expired' },
    ));
    const testedBody = await tested.json() as { success: boolean; data: { matched: boolean; reasons: string[] } };
    expect(testedBody.success).toBe(false);
    expect(testedBody.data.matched).toBe(false);
    expect(testedBody.data.reasons).toEqual(expect.arrayContaining([
      '有効期間の終了時刻が過ぎています。終了を延ばすか、この設定を消してください。',
      '対象の流入リンクが選ばれていません。流入条件で1つ以上選んでください。',
    ]));

    const validate = await app(testDb.db).request('/api/friend-add-rules/rule-expired/validate?account_id=account-1', {
      method: 'POST',
    });
    const validateBody = await validate.json() as {
      data: { canPublish: boolean; checks: Array<{ status: string; label: string }> };
    };
    expect(validateBody.data.canPublish).toBe(false);
    expect(validateBody.data.checks.some(
      (check) => check.status === 'failed' && check.label.includes('有効期間の終了時刻が過ぎています'),
    )).toBe(true);
  });

  /*
   * 編集中の下書きは未完成でも保存できるようにし、必須項目はテストと公開前確認で検証する。
   * 未完成のまま動かないよう、公開にはテスト成功を必須とする。
   */
  it('再追加の「何も配信しない」はシナリオなしで保存でき、未完成の下書きは公開前に止まる', async () => {
    seedRuleAndRun(testDb);
    const base = {
      accountId: 'account-1', friendKind: 'returning', name: '再追加なし', priority: 5,
      definition: {
        routeIds: [], scenarioId: null, returningMode: 'none', messageType: 'text', messageText: '',
        timing: 'immediate', actions: [], friendCondition: '',
        activeFrom: null, activeUntil: null, weekdays: [], timeWindows: [],
      },
    };
    const noneOk = await app(testDb.db).request('/api/friend-add-rules/drafts', json(
      'POST', base, 'friend-add-none-00001',
    ));
    expect(noneOk.status).toBe(201);

    const incomplete = await app(testDb.db).request('/api/friend-add-rules/drafts', json(
      'POST', { ...base, name: '再追加あり', definition: { ...base.definition, returningMode: undefined } },
      'friend-add-none-00002',
    ));
    expect(incomplete.status).toBe(201);
    const draftId = ((await incomplete.json()) as { data: { id: string } }).data.id;

    const tested = await app(testDb.db).request('/api/friend-add-rules/test', json(
      'POST', { accountId: 'account-1', ruleId: draftId },
    ));
    expect(tested.status).toBe(200);
    const testedBody = (await tested.json()) as {
      success: boolean; data: { matched: boolean; reasons: string[] };
    };
    expect(testedBody.success).toBe(false);
    expect(testedBody.data.matched).toBe(false);
    expect(testedBody.data.reasons.join('\n')).toContain('実際に配信するシナリオを決めてください。');

    const published = await app(testDb.db).request(
      `/api/friend-add-rules/${draftId}/publish?account_id=account-1`,
      { method: 'POST', headers: { 'Idempotency-Key': 'friend-add-none-publish-1' } },
    );
    expect(published.status).toBe(409);
  });

  /*
   * 友だち条件の中で指しているタグ・シナリオ・友だち情報欄も、
   * このアカウントの持ち物かを保存時に確かめる。ここを見ないと、他店のタグや
   * 消えたタグで絞った設定がそのまま保存され、実行時に配信が止まる
   * （あるいは絞れていない状態で配ることになる）。
   */
  it('友だち条件が他店・消えたタグを指す設定は保存させない', async () => {
    seedRuleAndRun(testDb);
    testDb.raw.prepare(
      `INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
       VALUES ('account-9', 'channel-9', '他店', 'token-9', 'secret-9')`,
    ).run();
    testDb.raw.prepare(
      "INSERT INTO tags (id, name, line_account_id) VALUES ('tag-other', '他店タグ', 'account-9')",
    ).run();
    const base = {
      accountId: 'account-1', friendKind: 'first_time', name: '条件つき', priority: 7,
      definition: {
        routeIds: ['route-1'], scenarioId: 'scenario-1', messageType: 'text', messageText: 'ようこそ',
        timing: 'immediate', actions: [], friendCondition: '',
        activeFrom: null, activeUntil: null, weekdays: [], timeWindows: [],
      },
    };
    const condition = (tagId: string) => JSON.stringify({
      operator: 'AND', rules: [{ type: 'tag_exists', value: tagId }],
    });

    // 他店のタグ
    const foreign = await app(testDb.db).request('/api/friend-add-rules/drafts', json(
      'POST',
      { ...base, definition: { ...base.definition, friendCondition: condition('tag-other') } },
      'friend-add-ref-000001',
    ));
    expect(foreign.status).toBe(400);
    await expect(foreign.json()).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('このLINEアカウントで使えない'),
    });

    // 消えたタグ
    const missing = await app(testDb.db).request('/api/friend-add-rules/drafts', json(
      'POST',
      { ...base, definition: { ...base.definition, friendCondition: condition('tag-deleted') } },
      'friend-add-ref-000002',
    ));
    expect(missing.status).toBe(400);

    // 自分のタグなら保存できる
    const own = await app(testDb.db).request('/api/friend-add-rules/drafts', json(
      'POST',
      { ...base, definition: { ...base.definition, friendCondition: condition('tag-1') } },
      'friend-add-ref-000003',
    ));
    expect(own.status).toBe(201);
  });

  it('公開前の確認は鍵付きで返し、説明文はサーバ値をそのまま載せる', async () => {
    seedRuleAndRun(testDb);
    const validate = await app(testDb.db).request('/api/friend-add-rules/rule-1/validate?account_id=account-1', {
      method: 'POST',
    });
    expect(validate.status).toBe(200);
    await expect(validate.json()).resolves.toMatchObject({
      data: {
        checks: [
          {
            key: 'first_time', status: 'passed',
            label: '配信内容と参照先を確認できました。',
            detail: '保存済みのルールと参照先を確認できました。',
          },
          {
            key: 'duplicate_prevention', status: 'passed',
            label: '二重送信防止',
            detail: '同じ友だち追加通知は1回だけ処理します。',
          },
        ],
      },
    });
  });

  it('一覧の検索とフォルダ絞りをサーバ側で行い、フォルダ件数は全ページの合計を返す', async () => {
    seedRuleAndRun(testDb);
    testDb.raw.prepare("UPDATE friend_add_rules SET folder_name = '紹介' WHERE id = 'rule-1'").run();

    const searched = await app(testDb.db).request(
      '/api/friend-add-rules?account_id=account-1&kind=first_time&q=' + encodeURIComponent('キャンペーン'),
    );
    expect(searched.status).toBe(200);
    await expect(searched.json()).resolves.toMatchObject({
      data: { items: [{ id: 'rule-2' }], total: 1 },
    });

    const foldered = await app(testDb.db).request(
      '/api/friend-add-rules?account_id=account-1&kind=first_time&folder=' + encodeURIComponent('紹介'),
    );
    expect(foldered.status).toBe(200);
    await expect(foldered.json()).resolves.toMatchObject({
      data: { items: [{ id: 'rule-1' }], total: 1 },
    });

    const uncategorized = await app(testDb.db).request(
      '/api/friend-add-rules?account_id=account-1&kind=first_time&folder=__uncategorized',
    );
    expect(uncategorized.status).toBe(200);
    await expect(uncategorized.json()).resolves.toMatchObject({
      // rule-2 と受け皿 (first_time) の2件。rule-1 は「紹介」へ移した。
      data: { total: 2 },
    });

    const listed = await app(testDb.db).request('/api/friend-add-rules?account_id=account-1&kind=first_time');
    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toMatchObject({
      data: {
        folderCounts: expect.arrayContaining([
          expect.objectContaining({ name: '紹介', count: 1 }),
          expect.objectContaining({ name: null, count: 2 }),
        ]),
      },
    });
  });
});
