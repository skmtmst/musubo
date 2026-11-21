/*
 *  /  — 停止・再開・失敗分再送の口。
 *
 * 見張るのは境界と版。
 *
 *   - 役割（staff は止められない）と統括・アカウントの境界
 *   - 版（lock_version）が食い違えば 409。**画面のボタンを無効にするのは
 *     見た目の手当てで、二重の適用を止めているのはこの版**
 *   - 同じ要求を繰り返しても壊れない（冪等）
 *   - 止められない配信（全員配信）は、できないと言って断る
 *   - 誰が止めたか・何人が送達不明になったかが監査に残る
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { reopenUnsentClaims } from '@line-crm/db';
import type { Env } from '../worker-env';
import type { AuthenticatedStaff } from '../middleware/auth/principal/auth';
import { createTestD1, insertFriend, type SqliteD1 } from '../test-utils/d1-sqlite';
import { broadcasts } from './broadcasts';

const owner: AuthenticatedStaff = {
  id: 'owner-1', name: 'オーナー', role: 'owner', readOnly: false, tenantId: 'tenant-1',
};
const staff: AuthenticatedStaff = {
  ...owner, id: 'staff-1', name: '担当者', role: 'staff', permissionKeys: ['/broadcasts'],
};

const CONFIRM_HEADERS = {
  'Content-Type': 'application/json',
  'x-confirm-irreversible': 'broadcast-send',
};

function app(db: D1Database, actor: AuthenticatedStaff = owner) {
  const instance = new Hono<Env>();
  instance.use('*', async (c, next) => {
    c.env = { DB: db, LINE_CHANNEL_ACCESS_TOKEN: 'default-token', WORKER_URL: 'https://worker.example' } as Env['Bindings'];
    c.set('staff', actor);
    await next();
  });
  instance.route('/', broadcasts);
  return instance;
}

function post(body: unknown, headers: Record<string, string> = { 'Content-Type': 'application/json' }) {
  return { method: 'POST', headers, body: JSON.stringify(body) };
}

function seedBroadcast(db: SqliteD1, id: string, overrides: Record<string, unknown> = {}): void {
  const row: Record<string, unknown> = {
    id,
    title: id,
    message_type: 'text',
    message_content: 'こんにちは',
    target_type: 'segment',
    segment_conditions: JSON.stringify({ operator: 'AND', rules: [{ type: 'is_following', value: true }] }),
    status: 'sending',
    batch_offset: 0,
    total_count: 3,
    success_count: 1,
    line_account_id: 'account-1',
    lock_version: 1,
    created_at: '2026-09-11T09:00:00.000',
    ...overrides,
  };
  const columns = Object.keys(row);
  db.raw.prepare(
    `INSERT INTO broadcasts (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
  ).run(...columns.map((column) => row[column] as never));
}

function seedClaim(
  db: SqliteD1,
  friendId: string,
  state: string,
  opts: { dispatched?: boolean; broadcastId?: string; errorCode?: string | null } = {},
): void {
  db.raw.prepare(
    `INSERT INTO broadcast_send_claims
       (broadcast_id, friend_id, line_account_id, attempt_no, state, dispatched_at, settled_at, error_code, created_at, updated_at)
     VALUES (?, ?, 'account-1', 1, ?, ?, ?, ?, '2026-09-11T09:00:00.000', '2026-09-11T09:00:00.000')`,
  ).run(
    opts.broadcastId ?? 'b1',
    friendId,
    state,
    opts.dispatched === false ? null : '2026-09-11T09:30:00.000',
    state === 'claimed' ? null : '2026-09-11T09:31:00.000',
    opts.errorCode ?? null,
  );
}

function broadcastRow(db: SqliteD1, id = 'b1') {
  return db.raw.prepare(
    `SELECT status, stopped_at, stopped_by, lock_version, send_attempt_no FROM broadcasts WHERE id = ?`,
  ).get(id) as {
    status: string; stopped_at: string | null; stopped_by: string | null;
    lock_version: number; send_attempt_no: number;
  };
}

function auditActions(db: SqliteD1): Array<{ action: string; actor_principal_id: string; after_json: string | null }> {
  return db.raw.prepare(
    `SELECT action, actor_principal_id, after_json FROM audit_events ORDER BY created_at, action`,
  ).all() as Array<{ action: string; actor_principal_id: string; after_json: string | null }>;
}

describe('一斉配信の停止・再開・失敗分再送（#662）', () => {
  let testDb: SqliteD1;

  beforeEach(() => {
    testDb = createTestD1();
    testDb.raw.prepare("INSERT INTO tenants (id, name) VALUES ('tenant-1', '統括1'), ('tenant-2', '統括2')").run();
    testDb.raw.prepare(`
      INSERT INTO line_accounts
        (id, channel_id, name, channel_access_token, channel_secret, is_active, tenant_id)
      VALUES ('account-1', 'channel-1', '店舗1', 'token-1', 'secret-1', 1, 'tenant-1'),
             ('account-2', 'channel-2', '店舗2', 'token-2', 'secret-2', 1, 'tenant-2')
    `).run();
    for (const id of ['f1', 'f2', 'f3']) insertFriend(testDb.raw, id, { line_account_id: 'account-1' });
  });

  afterEach(() => testDb.raw.close());

  describe('停止', () => {
    it('担当者の役割では止められない', async () => {
      seedBroadcast(testDb, 'b1');
      const res = await app(testDb.db, staff).request('/api/broadcasts/b1/stop', post({ expectedVersion: 1 }));
      expect(res.status).toBe(403);
      expect(broadcastRow(testDb).stopped_at).toBeNull();
    });

    it('別の統括の配信は見つからない扱いで断る', async () => {
      seedBroadcast(testDb, 'b1', { line_account_id: 'account-2' });
      const res = await app(testDb.db).request('/api/broadcasts/b1/stop', post({ expectedVersion: 1 }));
      expect(res.status).toBe(404);
      expect(broadcastRow(testDb).stopped_at).toBeNull();
    });

    it('全員配信は「止められない」と理由を返す', async () => {
      seedBroadcast(testDb, 'b1', { target_type: 'all', segment_conditions: null });
      const res = await app(testDb.db).request('/api/broadcasts/b1/stop', post({ expectedVersion: 1 }));
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'BROADCAST_NOT_STOPPABLE' });
    });

    it('送信中でなければ断る', async () => {
      seedBroadcast(testDb, 'b1', { status: 'draft' });
      const res = await app(testDb.db).request('/api/broadcasts/b1/stop', post({ expectedVersion: 1 }));
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'BROADCAST_NOT_SENDING' });
    });

    it('版を送らなければ断る（誰の版で止めるのか決まらない）', async () => {
      seedBroadcast(testDb, 'b1');
      const res = await app(testDb.db).request('/api/broadcasts/b1/stop', post({}));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'EXPECTED_VERSION_REQUIRED' });
      expect(broadcastRow(testDb).stopped_at).toBeNull();
    });

    it('版が食い違えば断る', async () => {
      seedBroadcast(testDb, 'b1', { lock_version: 5 });
      const res = await app(testDb.db).request('/api/broadcasts/b1/stop', post({ expectedVersion: 4 }));
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'VERSION_MISMATCH' });
      expect(broadcastRow(testDb).stopped_at).toBeNull();
    });

    it('止めると台帳が締まり、誰が止めたかと送達不明の数が監査に残る', async () => {
      seedBroadcast(testDb, 'b1');
      seedClaim(testDb, 'f1', 'sent');
      seedClaim(testDb, 'f2', 'claimed');                          // 外へ出した → 送達不明
      seedClaim(testDb, 'f3', 'claimed', { dispatched: false });   // 出す前 → 失敗（再送できる）

      const res = await app(testDb.db).request('/api/broadcasts/b1/stop', post({ expectedVersion: 1 }));
      expect(res.status).toBe(200);
      const body = await res.json() as {
        data: { stopped: boolean; ledger: { sent: number; failed: number; unknown: number; retryableCount: number } };
        stoppedUnknownCount: number;
      };
      expect(body.data.stopped).toBe(true);
      expect(body.data.ledger).toMatchObject({ sent: 1, failed: 1, unknown: 1, retryableCount: 1 });
      expect(body.stoppedUnknownCount).toBe(1);

      const row = broadcastRow(testDb);
      expect(row).toMatchObject({ status: 'sending', stopped_by: 'owner-1', lock_version: 2 });
      expect(row.stopped_at).not.toBeNull();

      const audits = auditActions(testDb);
      expect(audits.map((a) => a.action)).toEqual(['broadcast.stop']);
      expect(audits[0].actor_principal_id).toBe('owner-1');
      expect(JSON.parse(audits[0].after_json!)).toMatchObject({ undeliveredUnknown: 1, releasedForRetry: 1 });
    });

    it('もう一度押しても壊れない（版も台帳も動かない）', async () => {
      seedBroadcast(testDb, 'b1');
      seedClaim(testDb, 'f2', 'claimed');
      const instance = app(testDb.db);
      await instance.request('/api/broadcasts/b1/stop', post({ expectedVersion: 1 }));
      const after = broadcastRow(testDb);

      // 画面は古い版のまま2度目を送る。エラーにせず、同じ結果を返す。
      const res = await instance.request('/api/broadcasts/b1/stop', post({ expectedVersion: 1 }));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ success: true, alreadyStopped: true });
      expect(broadcastRow(testDb)).toEqual(after);
      // 監査も1件のまま。
      expect(auditActions(testDb)).toHaveLength(1);
    });
  });

  describe('再開', () => {
    it('止まっていなければ断る', async () => {
      seedBroadcast(testDb, 'b1');
      const res = await app(testDb.db).request('/api/broadcasts/b1/resume', post({ expectedVersion: 1 }));
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'BROADCAST_NOT_STOPPED' });
    });

    it('版が一致すれば停止の印を外す', async () => {
      seedBroadcast(testDb, 'b1', { stopped_at: '2026-09-11T09:40:00.000', stopped_by: 'owner-1', lock_version: 2 });
      const bad = await app(testDb.db).request('/api/broadcasts/b1/resume', post({ expectedVersion: 1 }));
      expect(bad.status).toBe(409);

      const res = await app(testDb.db).request('/api/broadcasts/b1/resume', post({ expectedVersion: 2 }));
      expect(res.status).toBe(200);
      expect(broadcastRow(testDb)).toMatchObject({ stopped_at: null, stopped_by: null, lock_version: 3 });
      expect(auditActions(testDb).map((a) => a.action)).toEqual(['broadcast.resume']);
    });
  });

  describe('失敗分の再送', () => {
    it('確認の手順を経ていなければ送らない', async () => {
      seedBroadcast(testDb, 'b1', { status: 'sent', sent_at: '2026-09-11T10:00:00.000' });
      seedClaim(testDb, 'f1', 'failed');
      const res = await app(testDb.db).request('/api/broadcasts/b1/retry-failed', post({ expectedVersion: 1 }));
      expect(res.status).toBe(428);
      expect(broadcastRow(testDb).send_attempt_no).toBe(1);
    });

    it('未送信の押さえだけが残った完了配信は再送できる', async () => {
      seedBroadcast(testDb, 'b1', {status:'sent'});
      seedClaim(testDb, 'f1', 'claimed', {dispatched:false});
      const res = await app(testDb.db).request('/api/broadcasts/b1/retry-failed', post({expectedVersion:1}, CONFIRM_HEADERS));
      expect(res.status).toBe(202);
      expect(await res.json()).toMatchObject({attemptNo:2,retryTargets:1});
    });

    it('停止中の配信に残った未送信の押さえを再送する', async () => {
      seedBroadcast(testDb, 'b1', {status:'sending',stopped_at:'2026-11-21'});
      seedClaim(testDb, 'f1', 'claimed', {dispatched:false});
      seedClaim(testDb, 'f2', 'unknown');
      const response = await app(testDb.db).request('/api/broadcasts/b1/retry-failed', post({expectedVersion:1}, CONFIRM_HEADERS));
      expect(response.status).toBe(202);
      expect(await response.json()).toMatchObject({attemptNo:2,retryTargets:1});
      expect(testDb.raw.prepare("SELECT friend_id,state,attempt_no FROM broadcast_send_claims WHERE broadcast_id='b1' ORDER BY friend_id").all()).toEqual([
        {friend_id:'f1',state:'claimed',attempt_no:2},{friend_id:'f2',state:'unknown',attempt_no:1},
      ]);
    });

    it('完了後に残った未送信の押さえだけを再送し、送信済みや送信途中は触らない', async () => {
      seedBroadcast(testDb, 'b1', { status: 'sent', sent_at: '2026-09-11T10:00:00.000' });
      seedClaim(testDb, 'f1', 'claimed', { dispatched: false });
      seedClaim(testDb, 'f2', 'sent');
      seedClaim(testDb, 'f3', 'claimed', { dispatched: true });
      const detail = await app(testDb.db).request('/api/broadcasts/b1');
      expect(await detail.json()).toMatchObject({data:{ledger:{retryableCount:1}}});
      const progress = await app(testDb.db).request('/api/broadcasts/b1/progress');
      expect(await progress.json()).toMatchObject({data:{ledger:{retryableCount:1}}});
      const recipients = await app(testDb.db).request('/api/broadcasts/b1/recipients');
      expect(await recipients.json()).toMatchObject({data:{summary:{retryableCount:1,inFlight:1,pending:1},rows:expect.arrayContaining([
        expect.objectContaining({friendId:'f1',label:'未送信（再送できます）',retryable:true,group:'failed_temporary'}),
        expect.objectContaining({friendId:'f3',label:'送信中',retryable:false,group:'inflight'}),
      ])}});
      const filtered = await app(testDb.db).request('/api/broadcasts/b1/recipients?result=temporary');
      expect(await filtered.json()).toMatchObject({data:{rows:[expect.objectContaining({friendId:'f1'})]}});
      const res = await app(testDb.db).request('/api/broadcasts/b1/retry-failed', post({ expectedVersion: 1 }, CONFIRM_HEADERS));
      expect(res.status).toBe(202);
      expect(await res.json()).toMatchObject({attemptNo:2,retryTargets:1});
      expect(testDb.raw.prepare(`SELECT friend_id,state,attempt_no,dispatched_at FROM broadcast_send_claims WHERE broadcast_id='b1' ORDER BY friend_id`).all()).toEqual([
        {friend_id:'f1',state:'claimed',attempt_no:2,dispatched_at:null},
        {friend_id:'f2',state:'sent',attempt_no:1,dispatched_at:'2026-09-11T09:30:00.000'},
        {friend_id:'f3',state:'claimed',attempt_no:1,dispatched_at:'2026-09-11T09:30:00.000'},
      ]);
    });

    it('遅れた再送処理は新しい送信中の押さえを奪わない', async () => {
      seedBroadcast(testDb, 'b1', {send_attempt_no:3});
      seedClaim(testDb, 'f1', 'claimed', {dispatched:false});
      testDb.raw.exec("UPDATE broadcast_send_claims SET attempt_no=3 WHERE broadcast_id='b1' AND friend_id='f1'");
      expect(await reopenUnsentClaims(testDb.db,'b1',2)).toBe(0);
      expect(await reopenUnsentClaims(testDb.db,'b1',3)).toBe(0);
      expect(testDb.raw.prepare("SELECT state,attempt_no,dispatched_at FROM broadcast_send_claims WHERE broadcast_id='b1' AND friend_id='f1'").get())
        .toEqual({state:'claimed',attempt_no:3,dispatched_at:null});
    });

    it('送信済みの記録がある古い押さえは再送対象に数えない', async () => {
      seedBroadcast(testDb, 'b1', {status:'sent'});
      seedClaim(testDb, 'f1', 'claimed', {dispatched:false});
      testDb.raw.exec(`INSERT INTO messages_log(id,friend_id,direction,message_type,content,broadcast_id,created_at)
        VALUES('log1','f1','outgoing','text','送信済み','b1','2026-11-21')`);
      const progress=await app(testDb.db).request('/api/broadcasts/b1/progress');
      expect(await progress.json()).toMatchObject({data:{ledger:{retryableCount:0}}});
      const res=await app(testDb.db).request('/api/broadcasts/b1/retry-failed',post({expectedVersion:1},CONFIRM_HEADERS));
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({code:'NO_RETRY_TARGET'});
      expect(broadcastRow(testDb).send_attempt_no).toBe(1);
    });

    it('送信中の押さえは再送対象にせず、再送操作も断る', async () => {
      seedBroadcast(testDb, 'b1');
      seedClaim(testDb, 'f1', 'claimed', {dispatched:false});
      const progress = await app(testDb.db).request('/api/broadcasts/b1/progress');
      expect(await progress.json()).toMatchObject({data:{ledger:{retryableCount:0}}});
      const res = await app(testDb.db).request('/api/broadcasts/b1/retry-failed', post({expectedVersion:1}, CONFIRM_HEADERS));
      expect(res.status).toBe(409);
      expect(broadcastRow(testDb).send_attempt_no).toBe(1);
    });

    it('送り直せる相手がいなければ断る（送達不明だけでは送らない）', async () => {
      seedBroadcast(testDb, 'b1', { status: 'sent', sent_at: '2026-09-11T10:00:00.000' });
      seedClaim(testDb, 'f1', 'sent');
      seedClaim(testDb, 'f2', 'unknown');
      const res = await app(testDb.db).request(
        '/api/broadcasts/b1/retry-failed',
        post({ expectedVersion: 1 }, CONFIRM_HEADERS),
      );
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'NO_RETRY_TARGET' });
      expect(broadcastRow(testDb).send_attempt_no).toBe(1);
    });

    it('全員配信は宛先の一覧が無いので断る', async () => {
      seedBroadcast(testDb, 'b1', {
        status: 'sent', sent_at: '2026-09-11T10:00:00.000', target_type: 'all', segment_conditions: null,
      });
      seedClaim(testDb, 'f1', 'failed');
      const res = await app(testDb.db).request(
        '/api/broadcasts/b1/retry-failed',
        post({ expectedVersion: 1 }, CONFIRM_HEADERS),
      );
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'BROADCAST_NOT_RETRYABLE' });
    });

    it('失敗した相手だけ開け直し、送達済みと送達不明には触れない', async () => {
      seedBroadcast(testDb, 'b1', { status: 'sent', sent_at: '2026-09-11T10:00:00.000' });
      seedClaim(testDb, 'f1', 'sent');
      // 一時的な失敗（混み合い）だけ送り直す。
      seedClaim(testDb, 'f2', 'failed', { errorCode: 'line_http_429' });
      seedClaim(testDb, 'f3', 'unknown');

      const res = await app(testDb.db).request(
        '/api/broadcasts/b1/retry-failed',
        post({ expectedVersion: 1 }, CONFIRM_HEADERS),
      );
      expect(res.status).toBe(202);
      expect(await res.json()).toMatchObject({ attemptNo: 2, retryTargets: 1 });

      const row = broadcastRow(testDb);
      expect(row).toMatchObject({ status: 'sending', send_attempt_no: 2, stopped_at: null });
      const claims = testDb.raw.prepare(
        `SELECT friend_id, state, attempt_no FROM broadcast_send_claims WHERE broadcast_id = 'b1' ORDER BY friend_id`,
      ).all();
      expect(claims).toEqual([
        { friend_id: 'f1', state: 'sent', attempt_no: 1 },
        { friend_id: 'f2', state: 'claimed', attempt_no: 2 },
        { friend_id: 'f3', state: 'unknown', attempt_no: 1 },
      ]);
      const audits = auditActions(testDb);
      expect(audits.map((a) => a.action)).toEqual(['broadcast.retry_failed']);
      expect(JSON.parse(audits[0].after_json!)).toMatchObject({
        attemptNo: 2, retryTargets: 1, skippedUnknown: 1,
      });
    });

    it('版が食い違えば送らない', async () => {
      seedBroadcast(testDb, 'b1', { status: 'sent', sent_at: '2026-09-11T10:00:00.000', lock_version: 4 });
      seedClaim(testDb, 'f2', 'failed', { errorCode: 'line_http_429' });
      const res = await app(testDb.db).request(
        '/api/broadcasts/b1/retry-failed',
        post({ expectedVersion: 3 }, CONFIRM_HEADERS),
      );
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'VERSION_MISMATCH' });
      expect(broadcastRow(testDb).send_attempt_no).toBe(1);
    });
  });

  describe('進捗の表示', () => {
    it('届いた・届かなかった・送達不明・送信中を分けて返す', async () => {
      seedBroadcast(testDb, 'b1');
      seedClaim(testDb, 'f1', 'sent');
      seedClaim(testDb, 'f2', 'failed', { errorCode: 'line_http_429' });
      seedClaim(testDb, 'f3', 'unknown');

      const res = await app(testDb.db).request('/api/broadcasts/b1/progress');
      expect(res.status).toBe(200);
      const body = await res.json() as {
        data: { stopped: boolean; sendAttemptNo: number; ledger: Record<string, number> };
      };
      // 「送信成功 N人」だけだと「残りは失敗」と読めてしまい、送達不明の
      // 相手を再送してよいものと誤解させる。
      expect(body.data.ledger).toEqual({
        sent: 1, failed: 1, failedTemporary: 1, failedPermanent: 0,
        unknown: 1, inFlight: 0, retryableCount: 1,
      });
      expect(body.data.stopped).toBe(false);
      expect(body.data.sendAttemptNo).toBe(1);
    });
  });
});
