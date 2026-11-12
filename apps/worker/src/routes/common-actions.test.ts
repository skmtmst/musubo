import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite';
import type { Env } from '../worker-env';
import type { AuthenticatedStaff } from '../middleware/auth/principal/auth';
import { commonActions } from './common-actions';
import {
  createCommonAction,
  createCommonActionDraft,
  publishCommonActionDraft,
  updateCommonActionDraft,
} from '../services/common-actions.js';

function setupApp(db: D1Database, staff: AuthenticatedStaff) {
  const app = new Hono<Env>();
  app.use('*', async (c, next) => {
    c.env = { DB: db } as Env['Bindings'];
    c.set('staff', staff);
    await next();
  });
  app.route('/', commonActions);
  return app;
}

const action = [{
  id: 'wait', type: 'wait', params: { minutes: 5 }, onFailure: 'stop',
}];

describe('共通アクションAPI', () => {
  let testDb: SqliteD1;
  const admin: AuthenticatedStaff = {
    id: 'admin-1', name: '管理者', role: 'admin', readOnly: false, tenantId: 'tenant-1',
  };

  beforeEach(() => {
    testDb = createTestD1();
    testDb.raw.prepare(
      `INSERT INTO tenants (id, name) VALUES ('tenant-1', '統括1')`,
    ).run();
    testDb.raw.prepare(
      `INSERT INTO tenants (id, name) VALUES ('tenant-2', '統括2')`,
    ).run();
    testDb.raw.prepare(
      `INSERT INTO line_accounts
         (id, channel_id, name, channel_access_token, channel_secret, is_active, tenant_id)
       VALUES ('account-1', 'channel-1', '店舗1', '', '', 1, 'tenant-1')`,
    ).run();
    testDb.raw.prepare(
      `INSERT INTO line_accounts
         (id, channel_id, name, channel_access_token, channel_secret, is_active, tenant_id)
       VALUES ('account-2', 'channel-2', '店舗2', '', '', 1, 'tenant-2')`,
    ).run();
  });

  it('アカウント指定なしを既定店舗へ黙って保存しない', async () => {
    const response = await setupApp(testDb.db, admin).request('/api/common-actions');
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ success: false });
  });

  it('利用先の古い確認版は409と現在値を返し、一致版と旧呼び出しは通る', async () => {
    const created = await createCommonAction(testDb.db, { lineAccountId: 'account-1', name: '確認', actions: action });
    await publishCommonActionDraft(testDb.db, { id: created.id, lineAccountId: 'account-1', draftVersionId: created.draftVersionId, expectedDraftRevision: 1 });
    testDb.raw.prepare(`INSERT INTO common_action_bindings
      (id,line_account_id,common_action_id,common_action_version_id,consumer_type,consumer_id,consumer_path)
      VALUES ('binding','account-1',?,?,'automation','auto','step')`).run(created.id, created.draftVersionId);
    const app = setupApp(testDb.db, admin);
    const change = (expectedConfirmationRevision?: number) => app.request(`/api/common-actions/${created.id}/bindings/binding/version?account_id=account-1`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ versionId: created.draftVersionId, expectedVersionId: created.draftVersionId, expectedConfirmationRevision }),
    });
    const stale = await change(2);
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({ current: { id: 'binding', confirmationRevision: 1, versionId: created.draftVersionId } });
    expect((await change(1)).status).toBe(200);
    expect((await change()).status).toBe(200);
  });

  it('別統括のアカウントは存在も明かさない', async () => {
    const response = await setupApp(testDb.db, admin)
      .request('/api/common-actions?account_id=account-2');
    expect(response.status).toBe(404);
  });

  it('担当者は一覧を見られるが作成できない', async () => {
    const staff: AuthenticatedStaff = {
      ...admin, id: 'staff-1', role: 'staff', name: '担当者',
    };
    const app = setupApp(testDb.db, staff);
    expect((await app.request('/api/common-actions?account_id=account-1')).status).toBe(200);
    const response = await app.request('/api/common-actions?account_id=account-1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '担当者作成', actions: action }),
    });
    expect(response.status).toBe(403);
  });

  it('管理者は選択中アカウントへ下書きを作成できる', async () => {
    const response = await setupApp(testDb.db, admin)
      .request('/api/common-actions?account_id=account-1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '5分待つ', actions: action }),
      });
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: { versionNumber: 1 },
    });
    expect(testDb.raw.prepare(
      `SELECT line_account_id, status FROM common_actions`,
    ).get()).toEqual({ line_account_id: 'account-1', status: 'draft' });
  });

  it('一覧はページ情報を返し、CSVは担当者の個別権限を再確認する', async () => {
    const adminApp = setupApp(testDb.db, admin);
    for (const name of ['先に作成', 'あとに作成']) {
      const response = await adminApp.request('/api/common-actions?account_id=account-1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, actions: action }),
      });
      expect(response.status).toBe(201);
    }
    testDb.raw.prepare(
      `UPDATE common_actions
          SET updated_at = CASE name
            WHEN '先に作成' THEN '2026-09-07T00:00:00.000Z'
            ELSE '2026-09-07T00:01:00.000Z'
          END`,
    ).run();
    const page = await adminApp.request('/api/common-actions?account_id=account-1&limit=1&offset=1');
    expect(page.status).toBe(200);
    await expect(page.json()).resolves.toMatchObject({
      success: true,
      data: [{ name: '先に作成', executionCountThisMonth: 0, failureCountThisMonth: 0, lastRunAt: null }],
      pagination: { total: 2, limit: 1, offset: 1 },
      freshness: 'available',
    });

    const staff: AuthenticatedStaff = {
      ...admin, id: 'staff-1', name: '担当者', role: 'staff', permissionKeys: [],
    };
    const denied = await setupApp(testDb.db, staff)
      .request('/api/common-actions?account_id=account-1&format=csv');
    expect(denied.status).toBe(403);
    const csv = await setupApp(testDb.db, {
      ...staff, permissionKeys: ['automation.run.export'],
    }).request('/api/common-actions?account_id=account-1&format=csv');
    expect(csv.status).toBe(200);
    expect(csv.headers.get('content-type')).toContain('text/csv');
    expect(await csv.text()).toContain('今月の実行');
  });

  it('CSVは一覧と同じ検索・絞り込みで絞られる（監査 R464）', async () => {
    const adminApp = setupApp(testDb.db, admin);
    const created: Array<{ id: string; draftVersionId: string }> = [];
    for (const name of ['対象アクション', '別のアクション']) {
      const response = await adminApp.request('/api/common-actions?account_id=account-1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, actions: action }),
      });
      expect(response.status).toBe(201);
      const body = await response.json() as { data: { id: string; draftVersionId: string } };
      created.push(body.data);
    }
    // 「対象アクション」だけ公開し、「別のアクション」は下書きのままにする。
    const publish = await adminApp.request(
      `/api/common-actions/${created[0].id}/versions/${created[0].draftVersionId}/publish?account_id=account-1`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedDraftRevision: 1 }),
      },
    );
    expect(publish.status).toBe(200);

    const byQuery = await adminApp.request(
      '/api/common-actions?account_id=account-1&format=csv&query=%E5%AF%BE%E8%B1%A1',
    );
    expect(byQuery.status).toBe(200);
    const byQueryText = await byQuery.text();
    expect(byQueryText).toContain('対象アクション');
    expect(byQueryText).not.toContain('別のアクション');

    const byStatus = await adminApp.request(
      '/api/common-actions?account_id=account-1&format=csv&status=published',
    );
    expect(byStatus.status).toBe(200);
    const byStatusText = await byStatus.text();
    expect(byStatusText).toContain('対象アクション');
    expect(byStatusText).not.toContain('別のアクション');

    const empty = await adminApp.request(
      '/api/common-actions?account_id=account-1&format=csv&query=%E8%A9%B2%E5%BD%93%E3%81%AA%E3%81%97',
    );
    expect(empty.status).toBe(200);
    // 見出し1行だけ。0件の条件で対象外の行を混ぜない。
    expect((await empty.text()).trim().split('\r\n')).toHaveLength(1);
  });

  it('古い改訂の保存・公開は409で止まる（監査 R473・R477）', async () => {
    const adminApp = setupApp(testDb.db, admin);
    const created = await adminApp.request('/api/common-actions?account_id=account-1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '競合する下書き', actions: action }),
    });
    const createdBody = await created.json() as { data: { id: string; draftVersionId: string } };
    const put = (revision: number) => adminApp.request(
      `/api/common-actions/${createdBody.data.id}/draft?account_id=account-1`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expectedDraftVersionId: createdBody.data.draftVersionId,
          expectedDraftRevision: revision,
          name: '競合する下書き',
          actions: action,
        }),
      },
    );
    expect((await put(1)).status).toBe(200);
    // 改訂が進んだ後の古い番号では409。成功済みの保存は残る。
    const stale = await put(1);
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({
      success: false, code: 'draft_revision_conflict',
    });
    const publish = await adminApp.request(
      `/api/common-actions/${createdBody.data.id}/versions/${createdBody.data.draftVersionId}/publish?account_id=account-1`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedDraftRevision: 1 }),
      },
    );
    expect(publish.status).toBe(409);
  });

  it('同じ作成鍵の再送は同じ作成へ戻る（監査 R475）', async () => {
    const adminApp = setupApp(testDb.db, admin);
    const post = () => adminApp.request('/api/common-actions?account_id=account-1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '再試行する作成', actions: action, clientRequestKey: 'req-route-1' }),
    });
    const first = await post();
    expect(first.status).toBe(201);
    const firstBody = await first.json() as { data: { id: string } };
    // 応答消失後の再試行も201で同じIDへ戻り、二重作成にしない。
    const retry = await post();
    expect(retry.status).toBe(201);
    const retryBody = await retry.json() as { data: { id: string } };
    expect(retryBody.data.id).toBe(firstBody.data.id);
    expect(testDb.raw.prepare(`SELECT COUNT(*) AS count FROM common_actions`).get())
      .toEqual({ count: 1 });
  });

  it('確認後の参照先更新がある公開は409で止まる（監査 R479）', async () => {
    const adminApp = setupApp(testDb.db, admin);
    const wait5 = [{ id: 'wait', type: 'wait', params: { minutes: 5 }, onFailure: 'stop' }];
    const leaf = await createCommonAction(testDb.db, {
      lineAccountId: 'account-1', name: '参照される処理', actions: wait5,
    });
    await publishCommonActionDraft(testDb.db, {
      id: leaf.id, lineAccountId: 'account-1',
      draftVersionId: leaf.draftVersionId, expectedDraftRevision: 1,
    });
    const caller = await createCommonAction(testDb.db, {
      lineAccountId: 'account-1', name: '呼び出す処理',
      actions: [{ id: 'call', type: 'common_action', params: { commonActionId: leaf.id }, onFailure: 'stop' }],
    });
    const leafDraft = await createCommonActionDraft(testDb.db, {
      id: leaf.id, lineAccountId: 'account-1',
    });
    await updateCommonActionDraft(testDb.db, {
      id: leaf.id, lineAccountId: 'account-1',
      expectedDraftVersionId: leafDraft.draftVersionId, expectedDraftRevision: 1,
      name: '参照される処理',
      actions: [{ id: 'wait', type: 'wait', params: { minutes: 60 }, onFailure: 'stop' }],
    });
    await publishCommonActionDraft(testDb.db, {
      id: leaf.id, lineAccountId: 'account-1',
      draftVersionId: leafDraft.draftVersionId, expectedDraftRevision: 2,
    });
    const response = await adminApp.request(
      `/api/common-actions/${caller.id}/versions/${caller.draftVersionId}/publish?account_id=account-1`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedDraftRevision: 1 }),
      },
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      success: false, code: 'reference_updated',
    });
  });

  it('保管は未使用なら成功し利用中は422・権限なしは403（監査 R480）', async () => {
    const adminApp = setupApp(testDb.db, admin);
    const staffApp = setupApp(testDb.db, { role: 'staff' } as AuthenticatedStaff);
    const created = await adminApp.request('/api/common-actions?account_id=account-1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '要らない試作', actions: action }),
    });
    const createdBody = await created.json() as { data: { id: string; draftVersionId: string } };
    const id = createdBody.data.id;

    // 権限なしの担当者はサーバでも拒否される。
    expect((await staffApp.request(`/api/common-actions/${id}/archive?account_id=account-1`, {
      method: 'POST',
    })).status).toBe(403);

    // 未使用なら保管でき、通常一覧から外れる。
    const archived = await adminApp.request(`/api/common-actions/${id}/archive?account_id=account-1`, {
      method: 'POST',
    });
    expect(archived.status).toBe(200);
    await expect(archived.json()).resolves.toMatchObject({ success: true, data: { archived: true } });
    const list = await adminApp.request('/api/common-actions?account_id=account-1');
    const listBody = await list.json() as { data: Array<{ id: string }> };
    expect(listBody.data.map((item) => item.id)).not.toContain(id);

    // 戻すと通常一覧に戻る。
    const unarchived = await adminApp.request(`/api/common-actions/${id}/unarchive?account_id=account-1`, {
      method: 'POST',
    });
    expect(unarchived.status).toBe(200);
    const relist = await adminApp.request('/api/common-actions?account_id=account-1');
    const relistBody = await relist.json() as { data: Array<{ id: string }> };
    expect(relistBody.data.map((item) => item.id)).toContain(id);

    // 利用中は422で利用先を示す。
    testDb.raw.prepare(
      `INSERT INTO common_action_bindings
         (id, line_account_id, common_action_id, common_action_version_id,
          consumer_type, consumer_id, consumer_path)
       VALUES ('b-route-used', 'account-1', ?, ?, 'automation', 'auto-1', 'root')`,
    ).run(id, createdBody.data.draftVersionId);
    const inUse = await adminApp.request(`/api/common-actions/${id}/archive?account_id=account-1`, {
      method: 'POST',
    });
    expect(inUse.status).toBe(422);
    await expect(inUse.json()).resolves.toMatchObject({ success: false, code: 'binding_exists' });
  });

  it('タグ付与の連動ドロワーへ13種類のschemaと範囲内選択肢を返す', async () => {
    testDb.raw.prepare(
      `INSERT INTO tags (id, name, line_account_id) VALUES ('tag-1', '会員', 'account-1')`,
    ).run();
    testDb.raw.prepare(
      `INSERT INTO tags (id, name, line_account_id) VALUES ('tag-2', '別統括', 'account-2')`,
    ).run();
    const response = await setupApp(testDb.db, admin).request(
      '/api/common-actions/resources?lineAccountId=account-1&trigger=tag.added',
    );
    expect(response.status).toBe(200);
    const body = await response.json() as {
      data: {
        trigger: string;
        actionTypes: Array<{ id: string; schema: { type: string } }>;
        tags: Array<{ id: string }>;
      };
    };
    expect(body.data.trigger).toBe('tag.added');
    expect(body.data.actionTypes).toHaveLength(13);
    expect(body.data.actionTypes.every((item) => item.schema.type === 'object')).toBe(true);
    expect(body.data.tags).toEqual([{ id: 'tag-1', name: '会員' }]);
  });
});

describe('一覧の集計口（#554 点検#519中2）', () => {
  let testDb: SqliteD1;
  const admin: AuthenticatedStaff = {
    id: 'admin-1', name: '管理者', role: 'admin', readOnly: false, tenantId: 'tenant-1',
  };

  beforeEach(() => {
    testDb = createTestD1();
    const raw = testDb.raw;
    raw.prepare(`INSERT INTO tenants (id, name) VALUES ('tenant-1', '統括1')`).run();
    raw.prepare(
      `INSERT INTO line_accounts
         (id, channel_id, name, channel_access_token, channel_secret, is_active, tenant_id)
       VALUES ('account-1', 'channel-1', '店舗1', '', '', 1, 'tenant-1')`,
    ).run();
    // c1: 公開中・処理2・呼び出し2か所（うち古い版1）・今月2回（失敗1）
    // c2: 下書き・処理1・呼び出しなし
    // c3: 公開中・呼び出しなし（未使用）
    raw.prepare(
      `INSERT INTO common_actions (id, line_account_id, name, status, current_published_version_id)
       VALUES ('c1', 'account-1', '公開アクション', 'published', 'cv1'),
              ('c3', 'account-1', '未使用アクション', 'published', NULL)`,
    ).run();
    raw.prepare(
      `INSERT INTO common_actions (id, line_account_id, name, status, current_draft_version_id)
       VALUES ('c2', 'account-1', '下書きアクション', 'draft', 'cv2')`,
    ).run();
    raw.prepare(
      `INSERT INTO common_action_versions (id, common_action_id, version_number, status, action_config)
       VALUES ('cv1a', 'c1', 1, 'published', '[]'),
              ('cv1', 'c1', 2, 'published', '[{},{}]'),
              ('cv2', 'c2', 1, 'draft', '[{}]')`,
    ).run();
    raw.prepare(
      `INSERT INTO common_action_bindings
         (id, line_account_id, common_action_id, common_action_version_id, consumer_type, consumer_id)
       VALUES ('b-old', 'account-1', 'c1', 'cv1a', 'automation', 'd1'),
              ('b-cur', 'account-1', 'c1', 'cv1', 'automation', 'd2')`,
    ).run();
    raw.prepare(
      `INSERT INTO automation_runs
         (id, line_account_id, automation_id, automation_version_id,
          source_event_id, idempotency_key, status, is_test)
       VALUES ('r1', 'account-1', 'd1', 'v1', 'event-r1', 'key-r1', 'success', 0),
              ('r2', 'account-1', 'd1', 'v1', 'event-r2', 'key-r2', 'success', 0)`,
    ).run();
    raw.prepare(
      `INSERT INTO automation_run_steps
         (id, automation_run_id, step_key, action_type, common_action_version_id, idempotency_key, status)
       VALUES ('s1', 'r1', 's1', 'common_action_marker', 'cv1', 'step-r1', 'success'),
              ('s2', 'r2', 's1', 'common_action_marker', 'cv1', 'step-r2', 'success'),
              ('s3', 'r2', 's1/0', 'send_message', 'cv1', 'step-r2-0', 'failed')`,
    ).run();
  });

  it('ページ送りしても集計はアカウント全体のまま', async () => {
    const response = await setupApp(testDb.db, admin)
      .request('/api/common-actions?account_id=account-1&limit=1&offset=0');
    expect(response.status).toBe(200);
    const body = await response.json() as {
      success: boolean;
      data: unknown[];
      pagination: { total: number; limit: number; offset: number };
      summary: Record<string, number>;
    };
    expect(body.data).toHaveLength(1);
    expect(body.pagination).toMatchObject({ total: 3, limit: 1, offset: 0 });
    expect(body.summary).toMatchObject({
      total: 3,
      published: 2,
      draft: 1,
      oldVersion: 1,
      /* 監査 : 一覧の「呼ばれていない」は状態を問わず呼び出し元なし。
         c2（下書き・呼び出しなし）も c3 と同じく未使用なので 2 件。 */
      unused: 2,
      actions: 3,
      bindings: 2,
      outdated: 1,
      outdatedItems: 1,
      executions: 2,
      failures: 1,
    });
  });
});
