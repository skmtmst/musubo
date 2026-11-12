import { beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../worker-env.js';
import type { AuthenticatedStaff } from '../middleware/auth/principal/auth.js';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';
import { autoReplies } from './auto-replies.js';

const admin: AuthenticatedStaff = {
  id: 'env-owner',
  name: '管理者',
  role: 'admin',
  readOnly: false,
  tenantId: 'tenant-1',
};

const staff: AuthenticatedStaff = { ...admin, id: 'staff-1', role: 'staff' };

function app(db: D1Database, currentStaff: AuthenticatedStaff = admin) {
  const instance = new Hono<Env>();
  instance.use('*', async (c, next) => {
    c.set('staff', currentStaff);
    await next();
  });
  instance.route('/', autoReplies);
  return { instance, bindings: { DB: db, WORKER_URL: 'https://worker.test' } as Env['Bindings'] };
}

function request(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function settings(overrides: Record<string, unknown> = {}) {
  return {
    keyword: '予約',
    matchType: 'contains',
    responseType: 'text',
    responseContent: '承りました',
    templateId: null,
    lineAccountId: 'account-1',
    activeFrom: null,
    activeUntil: null,
    cooldownMinutes: null,
    skipWhenOperatorActive: false,
    priority: 1,
    receiveSources: ['line'],
    messageKinds: ['text'],
    friendConditions: null,
    actions: null,
    responseWeekdays: null,
    responseHolidayRule: null,
    oncePerFriend: false,
    keywords: null,
    respondToAll: false,
    name: '予約受付',
    keywordMatchMode: 'any',
    folderId: null,
    internalMemo: null,
    replyDelaySeconds: null,
    unmatchedAction: null,
    ...overrides,
  };
}

function insertRule(
  raw: SqliteD1['raw'],
  id: string,
  keyword: string,
  priority: number,
  accountId = 'account-1',
) {
  raw.prepare(
    `INSERT INTO auto_replies
       (id, keyword, match_type, response_content, line_account_id, is_active,
        priority, message_kinds_json, name, current_draft_version_id, created_at)
     VALUES (?, ?, 'contains', '返信', ?, 1, ?, '["text"]', ?, ?, ?)`,
  ).run(id, keyword, accountId, priority, `${keyword}受付`, `version-${id}`, `2026-09-01T00:00:0${priority}.000`);
  raw.prepare(
    `INSERT INTO auto_reply_versions
       (id, auto_reply_id, version_number, line_account_id, definition_snapshot,
        status, created_at, updated_at)
     VALUES (?, ?, 2, ?, ?, 'draft', '2026-09-01T00:00:00.000', '2026-09-01T00:00:00.000')`,
  ).run(`version-${id}`, id, accountId, JSON.stringify(settings({
    keyword, priority, name: `${keyword}受付`, lineAccountId: accountId,
  })));
}

describe('自動応答の一覧・競合・下書き保存口', () => {
  let testDb: SqliteD1;

  beforeEach(() => {
    testDb = createTestD1();
    testDb.raw.prepare(`INSERT INTO tenants (id, name) VALUES ('tenant-1', '統括1')`).run();
    testDb.raw.prepare(`INSERT INTO tenants (id, name) VALUES ('tenant-2', '統括2')`).run();
    testDb.raw.prepare(
      `INSERT INTO line_accounts
         (id, channel_id, name, channel_access_token, channel_secret, is_active, tenant_id)
       VALUES ('account-1', 'channel-1', '店舗1', '', '', 1, 'tenant-1'),
              ('account-2', 'channel-2', '店舗2', '', '', 1, 'tenant-2')`,
    ).run();
    insertRule(testDb.raw, 'rule-1', '予約', 1);
    insertRule(testDb.raw, 'rule-2', '予約変更', 2);
  });

  it('通知先が未選択なら下書きを残せるが公開できず、別所属の通知を保存しない',async()=>{
    const target=app(testDb.db);
    const config={notificationRuleId:'',notificationRuleVersion:0,message:'受信箱を確認してください'};
    const created=await target.instance.request('/api/auto-replies/drafts',request('POST',settings({actions:[{actionType:'notify_staff',config,onFailure:'stop'}]})),target.bindings);
    expect(created.status).toBe(201);
    const body=await created.json() as any;
    const id=body.data.id ?? body.data.autoReplyId;
    const validation=await target.instance.request(`/api/auto-replies/${id}/validate`,{method:'POST'},target.bindings);
    expect((await validation.json() as any).data).toMatchObject({valid:false,errors:expect.arrayContaining(['担当者通知の通知先を選んでください'])});
    testDb.raw.exec(`INSERT INTO notification_rules(id,name,event_type,conditions,channels,line_account_id,is_active,version) VALUES('other-rule','notify','message_received','{}','["dashboard"]','account-2',1,1)`);
    const invalid=await target.instance.request('/api/auto-replies/drafts',request('POST',settings({actions:[{actionType:'notify_staff',config:{...config,notificationRuleId:'other-rule',notificationRuleVersion:1}}]})),target.bindings);
    expect(invalid.status).toBe(400);
  });

  it('一覧へ成功アクション数と要確認の競合数を実測で返す', async () => {
    testDb.raw.prepare(
      `INSERT INTO auto_reply_evaluations
         (id, incoming_event_id, line_account_id, friend_id, message_kind,
          normalized_text_hash, evaluated_at, winning_auto_reply_id, status,
          reply_status, created_at, updated_at)
       VALUES ('evaluation-1', 'event-1', 'account-1', 'friend-1', 'text',
               'hash', '2026-09-01T01:00:00.000Z', 'rule-1', 'completed',
               'accepted', '2026-09-01T01:00:00.000Z', '2026-09-01T01:00:01.000Z')`,
    ).run();
    testDb.raw.prepare(
      `INSERT INTO auto_reply_action_runs
         (id, evaluation_id, action_stable_id, action_type, action_snapshot,
          idempotency_key, status, created_at, updated_at)
       VALUES ('action-1', 'evaluation-1', 'tag-1', 'tag_add', '{}',
               'action-key-1', 'succeeded', '2026-09-01T01:00:00.000Z', '2026-09-01T01:00:01.000Z')`,
    ).run();
    const target = app(testDb.db);
    const response = await target.instance.request(
      '/api/auto-replies?accountId=account-1', {}, target.bindings,
    );
    const body = await response.json() as { data: Array<{
      id: string; actionExecutionCount: number | null; conflictAttentionCount: number | null;
    }> };

    expect(response.status).toBe(200);
    expect(body.data.find((item) => item.id === 'rule-1')).toMatchObject({
      actionExecutionCount: 1,
      conflictAttentionCount: 1,
    });
    expect(body.data.find((item) => item.id === 'rule-2')).toMatchObject({
      actionExecutionCount: 0,
      conflictAttentionCount: 1,
    });
  });

  it('競合一覧へ件数・受信種別別件数・過去28日の一致数を返す', async () => {
    testDb.raw.prepare(
      `INSERT INTO auto_reply_evaluations
         (id, incoming_event_id, line_account_id, friend_id, message_kind,
          normalized_text_hash, evaluated_at, winning_auto_reply_id, status,
          reply_status, created_at, updated_at)
       VALUES ('evaluation-1', 'event-1', 'account-1', 'friend-1', 'text',
               'hash', datetime('now'), 'rule-1', 'completed', 'accepted',
               datetime('now'), datetime('now'))`,
    ).run();
    const target = app(testDb.db);
    const response = await target.instance.request(
      '/api/auto-replies/conflicts?accountId=account-1', {}, target.bindings,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        conflictCount: 1,
        matchedLast28Days: 1,
        receiveSourceCounts: [{ source: 'text', count: 1 }],
      },
    });
  });

  it.each(['account-1', '*'])('停止の対象が %s の場合も自動応答全体の停止を返す', async (scope) => {
    testDb.raw.prepare(`INSERT INTO operation_control_sets (scope_key, line_account_id, states_json, updated_at)
      VALUES (?, ?, ?, datetime('now'))`).run(scope, scope === '*' ? null : scope, JSON.stringify({ auto_reply_dispatch: 'stopped' }));
    const target = app(testDb.db);
    const response = await target.instance.request('/api/auto-replies/conflicts?accountId=account-1', {}, target.bindings);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ data: { dispatchStopped: true } });
  });

  it('停止情報がないときは稼働中、読めないときは不明を返す', async () => {
    const target = app(testDb.db);
    const url = '/api/auto-replies/conflicts?accountId=account-1';
    const before = await target.instance.request(url, {}, target.bindings);
    await expect(before.json()).resolves.toMatchObject({ data: { dispatchStopped: false } });
    testDb.raw.exec('DROP TABLE operation_control_sets');
    const after = await target.instance.request(url, {}, target.bindings);
    await expect(after.json()).resolves.toMatchObject({ data: { dispatchStopped: null } });
  });

  it('有効ルールも実測も無い場合は空配列と0件を返す', async () => {
    testDb.raw.prepare(`UPDATE auto_replies SET is_active = 0`).run();
    const target = app(testDb.db);
    const response = await target.instance.request(
      '/api/auto-replies/conflicts?accountId=account-1', {}, target.bindings,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        conflicts: [],
        conflictCount: 0,
        receiveSourceCounts: [],
        matchedLast28Days: 0,
      },
    });
  });

  it('実行集計だけ読めない場合は一覧を落とさずnullを返す', async () => {
    testDb.raw.exec('DROP TABLE auto_reply_action_runs');
    const target = app(testDb.db);
    const response = await target.instance.request(
      '/api/auto-replies?accountId=account-1', {}, target.bindings,
    );
    const body = await response.json() as { data: Array<{ actionExecutionCount: number | null }> };

    expect(response.status).toBe(200);
    expect(body.data.every((item) => item.actionExecutionCount === null)).toBe(true);
  });

  it('対象外アカウントは存在を隠し、staffは保存できない', async () => {
    const target = app(testDb.db);
    expect((await target.instance.request(
      '/api/auto-replies/conflicts?accountId=account-2', {}, target.bindings,
    )).status).toBe(404);

    const staffTarget = app(testDb.db, staff);
    const denied = await staffTarget.instance.request(
      '/api/auto-replies/rule-1/draft',
      request('PUT', { ...settings(), expectedVersion: 2 }),
      staffTarget.bindings,
    );
    expect(denied.status).toBe(403);
  });

  it('一覧でも対象外アカウントを隠し、アカウント名を漏らさない', async () => {
    insertRule(testDb.raw, 'rule-other', '他店限定', 3, 'account-2');
    const target = app(testDb.db);
    expect((await target.instance.request(
      '/api/auto-replies?accountId=account-2', {}, target.bindings,
    )).status).toBe(404);

    const response = await target.instance.request('/api/auto-replies', {}, target.bindings);
    const body = await response.json() as { data: Array<{
      id: string; effectiveAccounts: Array<{ accountId: string }>;
    }> };
    expect(response.status).toBe(200);
    expect(body.data.map((item) => item.id)).not.toContain('rule-other');
    expect(body.data.flatMap((item) => item.effectiveAccounts.map((account) => account.accountId)))
      .not.toContain('account-2');
  });

  it('追加設定を版へ保存し、古い版番号は409で止める', async () => {
    const target = app(testDb.db);
    const saved = await target.instance.request(
      '/api/auto-replies/rule-1/draft',
      request('PUT', {
        ...settings(),
        receiveSources: ['line', 'email'],
        expectedVersion: 2,
        internalMemo: '担当者だけが読むメモ',
        replyDelaySeconds: 30,
        unmatchedAction: { type: 'notify_operator' },
      }),
      target.bindings,
    );
    expect(saved.status).toBe(200);
    await expect(saved.json()).resolves.toMatchObject({
      data: {
        // m26c : 保存ごとに版が進む。同じ版の後続保存は競合になる。
        versionNumber: 3,
        settings: {
          receiveSources: ['line', 'email'],
          internalMemo: '担当者だけが読むメモ',
          replyDelaySeconds: 30,
          unmatchedAction: { type: 'notify_operator' },
        },
      },
    });

    const stale = await target.instance.request(
      '/api/auto-replies/rule-1/draft',
      request('PUT', { ...settings(), expectedVersion: 2 }),
      target.bindings,
    );
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({
      code: 'VERSION_CONFLICT',
      data: { currentVersion: 3 },
    });
  });
});
