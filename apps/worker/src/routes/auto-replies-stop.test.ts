import { beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { updateAutoReply, deleteAutoReply, restoreAutoReply, ensureAutoReplyPublishedVersion, getAutoReplyById } from '@line-crm/db';
import type { Env } from '../worker-env.js';
import type { AuthenticatedStaff } from '../middleware/auth/principal/auth.js';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';
import { autoReplies } from './auto-replies.js';

const admin: AuthenticatedStaff = {
  id: 'admin-1',
  name: '管理者',
  role: 'admin',
  readOnly: false,
  tenantId: 'tenant-1',
};

const staff: AuthenticatedStaff = { ...admin, id: 'staff-1', name: '担当', role: 'staff' };

function app(db: D1Database, currentStaff: AuthenticatedStaff = admin) {
  const instance = new Hono<Env>();
  instance.use('*', async (c, next) => {
    c.set('staff', currentStaff);
    await next();
  });
  instance.route('/', autoReplies);
  return { instance, bindings: { DB: db, WORKER_URL: 'https://worker.test' } as Env['Bindings'] };
}

function insertRule(raw: SqliteD1['raw'], id: string, keyword: string, isActive = 1) {
  raw.prepare(
    `INSERT INTO auto_replies
       (id, keyword, match_type, response_content, line_account_id, is_active,
        priority, lifecycle_status, name, created_at)
     VALUES (?, ?, 'contains', '返信', 'account-1', ?, 1, 'published', ?, '2026-09-01T00:00:00.000')`,
  ).run(id, keyword, isActive, `${keyword}受付`);
}

describe('機能08 点検: 自動応答の専用停止口と履歴を残す削除', () => {
  let testDb: SqliteD1;

  beforeEach(() => {
    testDb = createTestD1();
    testDb.raw.prepare(`INSERT INTO tenants (id, name) VALUES ('tenant-1', '統括1')`).run();
    testDb.raw.prepare(
      `INSERT INTO line_accounts
         (id, channel_id, name, channel_access_token, channel_secret, is_active, tenant_id)
       VALUES ('account-1', 'channel-1', '店舗1', '', '', 1, 'tenant-1')`,
    ).run();
    testDb.raw.prepare(
      `INSERT INTO staff_members
         (id, name, role, api_key, permission_keys, tenant_id, account_scope)
       VALUES ('admin-1', '管理者', 'admin', 'admin-key', '[]', 'tenant-1', 'all')`,
    ).run();
    testDb.raw.prepare(
      `INSERT INTO staff_members
         (id, name, role, api_key, permission_keys, tenant_id, account_scope)
       VALUES ('staff-1', '担当', 'staff', 'staff-key', '["/auto-replies"]', 'tenant-1', 'all')`,
    ).run();
    insertRule(testDb.raw, 'rule-1', '予約');
    insertRule(testDb.raw, 'rule-2', '変更');
  });

  const stop = (target: ReturnType<typeof app>, id: string, init: RequestInit = {}) =>
    target.instance.request(`/api/auto-replies/${id}/stop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
      ...init,
    }, target.bindings);

  const revision = () => (testDb.raw.prepare("SELECT confirmation_revision AS v FROM auto_replies WHERE id='rule-1'").get() as {v:number}).v;

  it('自動応答の設定更新で確認版を進める', async () => {
    const before = revision();
    await updateAutoReply(testDb.db, 'rule-1', {name:'変更後'});
    expect(revision()).toBe(before + 1);
  });

  it('自動応答の削除で確認版を進める', async () => {
    const before = revision();
    await deleteAutoReply(testDb.db, 'rule-1', 'admin-1');
    expect(revision()).toBe(before + 1);
  });

  it('自動応答の復元で確認版を進める', async () => {
    await deleteAutoReply(testDb.db, 'rule-1', 'admin-1');
    const before = revision();
    await restoreAutoReply(testDb.db, 'rule-1');
    expect(revision()).toBe(before + 1);
  });

  it('確認版の不一致は409、一致と版なしは停止できる', async () => {
    const target=app(testDb.db);
    testDb.raw.prepare("UPDATE auto_replies SET confirmation_revision=3 WHERE id='rule-1'").run();
    const invoke=(id:string,key:string,expectedVersion?:number)=>stop(target,id,{headers:{'Idempotency-Key':key},body:JSON.stringify({expectedVersion})});
    const conflict = await invoke('rule-1','version-stale-001',1);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({code:'auto_reply_confirmation_conflict',data:{confirmationRevision:3}});
    expect(testDb.raw.prepare("SELECT is_active FROM auto_replies WHERE id='rule-1'").get()).toEqual({is_active:1});
    expect((await invoke('rule-1','version-current-002',3)).status).toBe(200);
    expect(testDb.raw.prepare("SELECT confirmation_revision FROM auto_replies WHERE id='rule-1'").get()).toEqual({confirmation_revision:4});
    expect((await invoke('rule-2','version-legacy-003')).status).toBe(200);
  });

  it('実行版が作り直されても確認した停止を受け付ける', async () => {
    const row = (await getAutoReplyById(testDb.db, 'rule-1'))!;
    await ensureAutoReplyPublishedVersion(testDb.db, row);
    expect(revision()).toBe(1);
    const response = await stop(app(testDb.db), 'rule-1', {headers:{'Idempotency-Key':'runtime-version-01'},body:JSON.stringify({expectedVersion:1})});
    expect(response.status).toBe(200);
    expect(testDb.raw.prepare("SELECT is_active FROM auto_replies WHERE id='rule-1'").get()).toEqual({is_active:0});
  });

  it('JSON以外の版指定は拒み、版のない従来本文は受け付ける', async () => {
    const target = app(testDb.db);
    const response = await stop(target, 'rule-1', {headers:{'Idempotency-Key':'non-json-version-01','content-type':'application/x-www-form-urlencoded'},body:'expectedVersion=1'});
    expect(response.status).toBe(400);
    expect(testDb.raw.prepare("SELECT is_active FROM auto_replies WHERE id='rule-1'").get()).toEqual({is_active:1});
    expect((await stop(target, 'rule-1', {headers:{'Idempotency-Key':'legacy-plain-0001','content-type':'text/plain'},body:'legacy'})).status).toBe(200);
  });

  it('読み取り後に別の更新が割り込んだら停止しない', async () => {
    let interrupted = false;
    const db = new Proxy(testDb.db, { get(target, prop) {
      if (prop !== 'prepare') return Reflect.get(target, prop);
      return (sql: string) => {
        const statement = target.prepare(sql);
        if (!sql.includes('UPDATE auto_replies') || !sql.includes('stop_idempotency_key')) return statement;
        return new Proxy(statement, { get(stmt, key) {
          if (key !== 'bind') return Reflect.get(stmt, key);
          return (...args: unknown[]) => {
            const bound = stmt.bind(...args);
            return new Proxy(bound, { get(prepared, method) {
              if (method !== 'run') return Reflect.get(prepared, method);
              return async () => {
                if (!interrupted) { interrupted = true; testDb.raw.prepare("UPDATE auto_replies SET name='割り込み', confirmation_revision=confirmation_revision+1 WHERE id='rule-1'").run(); }
                return prepared.run();
              };
            } });
          };
        } });
      };
    } });
    const response = await stop(app(db), 'rule-1', { headers: { 'Idempotency-Key': 'version-race-0001' }, body: JSON.stringify({ expectedVersion: 1 }) });
    expect(response.status).toBe(409);
    expect(testDb.raw.prepare("SELECT name, is_active, confirmation_revision FROM auto_replies WHERE id='rule-1'").get()).toEqual({name:'割り込み',is_active:1,confirmation_revision:2});
  });

  it('E-01: 停止口が理由・停止者・停止日時を記録し、一覧へ返す', async () => {
    const target = app(testDb.db);
    const response = await stop(target, 'rule-1', {
      headers: { 'Idempotency-Key': 'stop-key-0001' },
      body: JSON.stringify({ reason: 'キャンペーンが終わったので' }),
    });

    expect(response.status).toBe(200);
    const body = await response.json() as {
      data: {
        isActive: boolean;
        stoppedAt: string | null;
        stoppedByStaffId: string | null;
        stoppedByStaffName: string | null;
        stopReason: string | null;
      };
    };
    expect(body.data.isActive).toBe(false);
    expect(body.data.stoppedAt).not.toBeNull();
    expect(body.data.stoppedByStaffId).toBe('admin-1');
    expect(body.data.stoppedByStaffName).toBe('管理者');
    expect(body.data.stopReason).toBe('キャンペーンが終わったので');

    const row = testDb.raw.prepare(
      `SELECT is_active, lifecycle_status, stopped_at, stopped_by_staff_id, stop_reason
         FROM auto_replies WHERE id = 'rule-1'`,
    ).get() as Record<string, unknown>;
    expect(row.is_active).toBe(0);
    expect(row.lifecycle_status).toBe('stopped');
    expect(row.stopped_at).not.toBeNull();
    expect(row.stopped_by_staff_id).toBe('admin-1');
    expect(row.stop_reason).toBe('キャンペーンが終わったので');

    // 一覧でも停止の記録が読める。
    const list = await target.instance.request('/api/auto-replies', {}, target.bindings);
    const listBody = await list.json() as { data: Array<{ id: string; stopReason: string | null }> };
    expect(listBody.data.find((item) => item.id === 'rule-1')?.stopReason)
      .toBe('キャンペーンが終わったので');
  });

  it('E-01: 停止は確認キー必須。同じキーの再送は新しい停止として残さない', async () => {
    const target = app(testDb.db);
    expect((await stop(target, 'rule-1', { body: JSON.stringify({}) })).status).toBe(400);

    const first = await stop(target, 'rule-1', {
      headers: { 'Idempotency-Key': 'stop-key-0002' },
      body: JSON.stringify({ reason: '最初の理由' }),
    });
    expect(first.status).toBe(200);
    const firstRow = testDb.raw.prepare(
      `SELECT stopped_at FROM auto_replies WHERE id = 'rule-1'`,
    ).get() as { stopped_at: string };

    // 同じキー・別の理由で再送しても、記録は最初の停止のまま。
    const replay = await stop(target, 'rule-1', {
      headers: { 'Idempotency-Key': 'stop-key-0002' },
      body: JSON.stringify({ reason: '書き換えようとした理由' }),
    });
    expect(replay.status).toBe(200);
    const replayRow = testDb.raw.prepare(
      `SELECT stopped_at, stop_reason FROM auto_replies WHERE id = 'rule-1'`,
    ).get() as { stopped_at: string; stop_reason: string };
    expect(replayRow.stopped_at).toBe(firstRow.stopped_at);
    expect(replayRow.stop_reason).toBe('最初の理由');
  });

  it('E-01: 長すぎる理由・文字列でない理由は400でDBを叩かない', async () => {
    const target = app(testDb.db);
    const tooLong = await stop(target, 'rule-1', {
      headers: { 'Idempotency-Key': 'stop-key-0003' },
      body: JSON.stringify({ reason: 'あ'.repeat(501) }),
    });
    expect(tooLong.status).toBe(400);
    const notString = await stop(target, 'rule-1', {
      headers: { 'Idempotency-Key': 'stop-key-0003' },
      body: JSON.stringify({ reason: 123 }),
    });
    expect(notString.status).toBe(400);
    const row = testDb.raw.prepare(
      `SELECT is_active, stopped_at FROM auto_replies WHERE id = 'rule-1'`,
    ).get() as { is_active: number; stopped_at: string | null };
    expect(row.is_active).toBe(1);
    expect(row.stopped_at).toBeNull();
  });

  it('E-01: staffは停止も再開相当の更新もできず、権限の境界を越えない', async () => {
    const target = app(testDb.db, staff);
    const response = await stop(target, 'rule-1', {
      headers: { 'Idempotency-Key': 'stop-key-0004' },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(403);
    const row = testDb.raw.prepare(
      `SELECT is_active FROM auto_replies WHERE id = 'rule-1'`,
    ).get() as { is_active: number };
    expect(row.is_active).toBe(1);
  });

  it('N-086相当: 再開は更新口で戻せ、lifecycle_status も published へ戻る', async () => {
    const target = app(testDb.db);
    await stop(target, 'rule-1', {
      headers: { 'Idempotency-Key': 'stop-key-0005' },
      body: JSON.stringify({ reason: '一時停止' }),
    });
    const resume = await target.instance.request('/api/auto-replies/rule-1', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ isActive: true }),
    }, target.bindings);
    expect(resume.status).toBe(200);
    const row = testDb.raw.prepare(
      `SELECT is_active, lifecycle_status, stopped_at, stop_reason
         FROM auto_replies WHERE id = 'rule-1'`,
    ).get() as Record<string, unknown>;
    expect(row.is_active).toBe(1);
    expect(row.lifecycle_status).toBe('published');
    // 停止の記録は「最後に止めた記録」として残る。
    expect(row.stopped_at).not.toBeNull();
    expect(row.stop_reason).toBe('一時停止');
  });

  it('N-085: 削除は行を残して deleted_at を記録し、一覧と検索から外れる', async () => {
    const target = app(testDb.db);
    const response = await target.instance.request('/api/auto-replies/rule-1', {
      method: 'DELETE',
    }, target.bindings);
    expect(response.status).toBe(200);

    // 物理削除ではなく行が残り、誰が消したかも記録される。
    const row = testDb.raw.prepare(
      `SELECT id, is_active, deleted_at, deleted_by_staff_id, lifecycle_status
         FROM auto_replies WHERE id = 'rule-1'`,
    ).get() as Record<string, unknown> | undefined;
    expect(row).toBeDefined();
    expect(row?.deleted_at).not.toBeNull();
    expect(row?.deleted_by_staff_id).toBe('admin-1');
    expect(row?.is_active).toBe(0);
    expect(row?.lifecycle_status).toBe('stopped');

    // 一覧・詳細・再操作の対象からは外れる。
    const list = await target.instance.request('/api/auto-replies', {}, target.bindings);
    const listBody = await list.json() as { data: Array<{ id: string }> };
    expect(listBody.data.some((item) => item.id === 'rule-1')).toBe(false);
    expect(
      (await target.instance.request('/api/auto-replies/rule-1', {}, target.bindings)).status,
    ).toBe(404);
    expect(
      (await stop(target, 'rule-1', {
        headers: { 'Idempotency-Key': 'stop-key-0006' },
        body: JSON.stringify({}),
      })).status,
    ).toBe(404);
    // 同じ id の再削除は 404（履歴は二度消えない）。
    expect(
      (await target.instance.request('/api/auto-replies/rule-1', { method: 'DELETE' }, target.bindings)).status,
    ).toBe(404);
  });

  it('N-085: 削除しても過去の一致記録と実行版の履歴は残る', async () => {
    testDb.raw.prepare(
      `INSERT INTO auto_reply_hits (id, auto_reply_id, matched_keyword)
       VALUES ('hit-1', 'rule-1', '予約')`,
    ).run();
    const target = app(testDb.db);
    await target.instance.request('/api/auto-replies/rule-1', { method: 'DELETE' }, target.bindings);

    expect(
      testDb.raw.prepare(`SELECT COUNT(*) AS count FROM auto_reply_hits WHERE auto_reply_id = 'rule-1'`).get(),
    ).toEqual({ count: 1 });
    // hits 集計の JOIN では削除済みを数えない（一覧に出さないものを数えない）。
    const list = await target.instance.request('/api/auto-replies', {}, target.bindings);
    const listBody = await list.json() as { data: Array<{ id: string; hits?: { total: number } }> };
    expect(listBody.data.every((item) => item.id !== 'rule-1')).toBe(true);
  });
});
