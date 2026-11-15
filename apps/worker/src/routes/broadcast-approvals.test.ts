/*
 * m12a 一斉配信の二者承認（-06 §6）。
 *
 * 見張るのは「人数の境目」と「送る人と承認する人は別人」と
 * 「期限切れは送らない」の3つ。承認済みになってから既存の送信の
 * 流れに渡すことと、二重の承認・送信を作らないことを確かめる。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../worker-env';
import type { AuthenticatedStaff } from '../middleware/auth/principal/auth';
import { createTestD1, insertFriend, type SqliteD1 } from '../test-utils/d1-sqlite';
import { broadcasts } from './broadcasts';
import { broadcastApprovals } from './broadcast-approvals';
import {
  checkScheduledBroadcastApproval,
  enforceBroadcastSendApproval,
  sweepBroadcastApprovalExpiry,
} from '../features/broadcasts/broadcast-approval';
import { getBroadcastById } from '@line-crm/db';

const owner: AuthenticatedStaff = {
  id: 'owner-1', name: 'オーナー', role: 'owner', readOnly: false, tenantId: 'tenant-1',
};
const admin: AuthenticatedStaff = {
  ...owner, id: 'admin-1', name: '管理者', role: 'admin',
};
const sender: AuthenticatedStaff = {
  id: 'staff-send', name: '送る人', role: 'staff', readOnly: false, tenantId: 'tenant-1',
  permissionKeys: ['/broadcasts', 'broadcast.definition.edit', 'broadcast.definition.publish'],
};
const approver: AuthenticatedStaff = {
  id: 'staff-approve', name: '承認する人', role: 'staff', readOnly: false, tenantId: 'tenant-1',
  permissionKeys: ['/broadcasts', 'broadcast.approve'],
};
const noKeyStaff: AuthenticatedStaff = {
  id: 'staff-none', name: '鍵なし', role: 'staff', readOnly: false, tenantId: 'tenant-1',
  permissionKeys: ['/broadcasts', 'broadcast.definition.publish'],
};

function app(db: D1Database, actor: AuthenticatedStaff) {
  const instance = new Hono<Env>();
  instance.use('*', async (c, next) => {
    c.env = { DB: db, LINE_CHANNEL_ACCESS_TOKEN: 'default-token', WORKER_URL: 'https://worker.example' } as Env['Bindings'];
    c.set('staff', actor);
    await next();
  });
  // 承認の口を先に載せる。あとだと PUT /:id が approval-threshold を拾う。
  instance.route('/', broadcastApprovals);
  instance.route('/', broadcasts);
  return instance;
}

function json(method: string, body: unknown) {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

// 配信の承認は大事な操作なので直前の再確認を求める。ここでは二者承認の
// 流れを見たいため、再確認済み（10分の窓の内側）のセッションを用意して通す。
async function steppedUpSession(db: SqliteD1, staffId: string, token: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  const tokenHash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const now = new Date().toISOString();
  db.raw.prepare(
    `INSERT INTO admin_sessions (token_hash, staff_id, expires_at, created_at, step_up_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(tokenHash, staffId, new Date(Date.now() + 3_600_000).toISOString(), now, now);
  return { Authorization: `Bearer lh_session:${token}` };
}

function seedStaff(db: SqliteD1, id: string, name: string, role: string, permissionKeys: string[]) {
  db.raw.prepare(
    `INSERT INTO staff_members (id, name, role, api_key, is_active, permission_keys, invite_status)
     VALUES (?, ?, ?, ?, 1, ?, 'active')`,
  ).run(id, name, role, `key-${id}`, JSON.stringify(permissionKeys));
}

function seedBroadcast(db: SqliteD1, id: string, overrides: Record<string, unknown> = {}) {
  const row: Record<string, unknown> = {
    id,
    title: `配信${id}`,
    message_type: 'text',
    message_content: '本文',
    target_type: 'all',
    status: 'draft',
    total_count: 0,
    success_count: 0,
    line_account_id: 'account-1',
    created_at: '2026-09-25T00:00:00.000',
    ...overrides,
  };
  const columns = Object.keys(row);
  db.raw.prepare(
    `INSERT INTO broadcasts (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
  ).run(...columns.map((column) => row[column] as never));
}

function approvalOf(db: SqliteD1, id: string): string {
  const row = db.raw.prepare(`SELECT approval_status FROM broadcasts WHERE id = ?`).get(id) as {
    approval_status: string;
  };
  return row.approval_status;
}

describe('二者承認の依頼・承認・差し戻し', () => {
  let testDb: SqliteD1;

  beforeEach(() => {
    testDb = createTestD1();
    testDb.raw.prepare(`INSERT INTO tenants (id, name) VALUES ('tenant-1', '統括1')`).run();
    testDb.raw.prepare(
      `INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret, is_active, tenant_id)
       VALUES ('account-1', 'channel-1', '店舗1', 'token-1', 'secret-1', 1, 'tenant-1')`,
    ).run();
    // 運用者は2人（送る人・承認する人）。owner/admin は数に入れない運用担当だけ数える対象。
    seedStaff(testDb, 'staff-send', '送る人', 'staff', ['/broadcasts', 'broadcast.definition.edit', 'broadcast.definition.publish']);
    seedStaff(testDb, 'staff-approve', '承認する人', 'staff', ['/broadcasts', 'broadcast.approve']);
    for (let i = 1; i <= 5; i += 1) {
      insertFriend(testDb.raw, `friend-${i}`, { line_account_id: 'account-1' });
    }
    seedBroadcast(testDb, 'b1');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    testDb.raw.close();
  });

  const setLowThreshold = async () => {
    const response = await app(testDb.db, owner).request('/api/broadcasts/approval-threshold?lineAccountId=account-1', json('PUT', { lineAccountId: 'account-1', threshold: 3 }));
    expect(response.status).toBe(200);
  };
  function interleaveOnce(matches: (sql: string) => boolean, effect: () => void) {
    const prepare = testDb.db.prepare.bind(testDb.db);
    let ran = false;
    testDb.db.prepare = (sql: string) => {
      if (!ran && matches(sql)) { ran = true; effect(); }
      return prepare(sql);
    };
  }

  it('読取より新しい版を指定した編集で、新しい承認を古い本文へ転用しない', async () => {
    testDb.raw.exec("UPDATE broadcasts SET approval_status='approved' WHERE id='b1'");
    interleaveOnce(sql => /^UPDATE broadcasts SET /.test(sql) && sql.includes('message_content ='), () => {
      testDb.raw.exec("UPDATE broadcasts SET message_content='新しく承認した本文',lock_version=2,approval_status='approved' WHERE id='b1'");
    });
    const response = await app(testDb.db, sender).request('/api/broadcasts/b1', json('PUT', { messageContent: '本文', expectedVersion: 2 }));
    expect(response.status).toBe(409);
  });

  it('承認処理の途中で別の自分自身の依頼に替わったら承認しない', async () => {
    testDb.raw.exec("UPDATE broadcasts SET approval_status='pending',approval_requested_by_staff_id='staff-send',approval_requested_at='2026-10-21T00:00:00Z',approval_approver_staff_id='staff-approve' WHERE id='b1'");
    const headers = await steppedUpSession(testDb, 'staff-approve', 'requester-race');
    interleaveOnce(sql => sql.includes("SET approval_status = 'approved'"), () => {
      testDb.raw.exec("UPDATE broadcasts SET approval_requested_by_staff_id='staff-approve',approval_requested_at='2026-10-21T01:00:00Z' WHERE id='b1'");
    });
    const response = await app(testDb.db, approver).request('/api/broadcasts/b1/approval-approve', { ...json('POST', { expectedVersion: 1 }), headers: { ...json('POST', {}).headers, ...headers } });
    expect(response.status).toBe(409); expect(approvalOf(testDb, 'b1')).toBe('pending');
  });

  it('承認取消のSQLが失敗したら本文・宛先・版・承認を一体で巻き戻す', async () => {
    testDb.raw.exec(`UPDATE broadcasts SET approval_status='approved' WHERE id='b1';
      CREATE TRIGGER fail_approval_reset BEFORE UPDATE OF approval_status ON broadcasts
      WHEN OLD.approval_status='approved' AND NEW.approval_status='none'
      BEGIN SELECT RAISE(ABORT,'fixture approval reset failure'); END;`);
    const response = await app(testDb.db, sender).request('/api/broadcasts/b1', json('PUT', { messageContent: '変更した本文', expectedVersion: 1 }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'BROADCAST_SAVE_FAILED' });
    expect(testDb.raw.prepare('SELECT message_content,lock_version,approval_status FROM broadcasts WHERE id=?').get('b1')).toEqual({ message_content: '本文', lock_version: 1, approval_status: 'approved' });
  });

  it('監査記録だけが失敗しても、変更した本文に古い承認は残さない', async () => {
    testDb.raw.exec(`UPDATE broadcasts SET approval_status='approved' WHERE id='b1';
      CREATE TRIGGER fail_cancel_audit BEFORE INSERT ON broadcast_approval_events
      WHEN NEW.action='cancelled' BEGIN SELECT RAISE(ABORT,'fixture audit failure'); END;`);
    const response = await app(testDb.db, sender).request('/api/broadcasts/b1', json('PUT', { messageContent: '変更した本文', expectedVersion: 1 }));
    expect(response.status).toBe(200);
    expect(approvalOf(testDb, 'b1')).toBe('none');
    expect(await response.json()).toMatchObject({ data: { approvalStatus: 'none' } });
  });

  it('ボタンの行先変更も承認を無効にし、同じ本文・メモだけの保存は承認を保つ', async () => {
    await setLowThreshold();
    testDb.raw.exec("UPDATE broadcasts SET approval_status='approved' WHERE id='b1'");
    const unchanged = await app(testDb.db, sender).request('/api/broadcasts/b1', json('PUT', { messageContent: '本文', internalMemo: '編集メモ', expectedVersion: 1 }));
    expect(unchanged.status).toBe(200); expect(approvalOf(testDb, 'b1')).toBe('approved');
    const changed = await app(testDb.db, sender).request('/api/broadcasts/b1', json('PUT', { messageOptions: { buttons: [{ label: '予約', type: 'url', value: 'https://example.com/changed' }] }, expectedVersion: 2 }));
    expect(changed.status).toBe(200); expect(approvalOf(testDb, 'b1')).toBe('none');
    expect(await enforceBroadcastSendApproval(testDb.db, (await getBroadcastById(testDb.db, 'b1'))!)).toMatchObject({ allowed: false, code: 'APPROVAL_REQUIRED' });
  });

  it('読取後に承認依頼が入っても、保存時点の新しい承認を無効にする', async () => {
    interleaveOnce(sql => /^UPDATE broadcasts SET /.test(sql) && sql.includes('message_content ='), () => {
      testDb.raw.exec("UPDATE broadcasts SET approval_status='pending' WHERE id='b1'");
    });
    const response = await app(testDb.db, sender).request('/api/broadcasts/b1', json('PUT', { messageContent: '変更した本文', expectedVersion: 1 }));
    expect(response.status).toBe(200); expect(approvalOf(testDb, 'b1')).toBe('none');
  });

  it('送信開始が先に入ったら、古い編集から本文を変更しない', async () => {
    interleaveOnce(sql => /^UPDATE broadcasts SET /.test(sql) && sql.includes('message_content ='), () => {
      testDb.raw.exec("UPDATE broadcasts SET status='sending' WHERE id='b1'");
    });
    const response = await app(testDb.db, sender).request('/api/broadcasts/b1', json('PUT', { messageContent: '変更した本文', expectedVersion: 1 }));
    expect(response.status).toBe(409);
    expect(testDb.raw.prepare('SELECT status,message_content FROM broadcasts WHERE id=?').get('b1')).toEqual({ status: 'sending', message_content: '本文' });
  });

  it('送信判定後に本文が変わったら、即時送信を開始しない', async () => {
    await setLowThreshold();
    testDb.raw.exec("UPDATE broadcasts SET approval_status='approved' WHERE id='b1'");
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith('/message/quota')) return new Response(JSON.stringify({ type: 'limited', value: 10000 }));
      if (url.endsWith('/message/quota/consumption')) return new Response(JSON.stringify({ totalUsage: 0 }));
      throw new Error('external forbidden');
    }));
    interleaveOnce(sql => /UPDATE broadcasts/.test(sql) && sql.includes("SET status = 'sending'"), () => {
      testDb.raw.exec("UPDATE broadcasts SET message_content='同時編集',lock_version=lock_version+1,approval_status='none' WHERE id='b1'");
    });
    const headers = { ...await steppedUpSession(testDb, 'staff-send', 'send-race'), 'X-Confirm-Irreversible': 'broadcast-send' };
    const response = await app(testDb.db, sender).request('/api/broadcasts/b1/send', { ...json('POST', {}), headers: { ...json('POST', {}).headers, ...headers } });
    expect(response.status).toBe(409);
    expect(testDb.raw.prepare('SELECT status,message_content FROM broadcasts WHERE id=?').get('b1')).toEqual({ status: 'draft', message_content: '同時編集' });
    const sent = vi.mocked(fetch).mock.calls.filter(([input]) => /\/message\/(push|multicast|broadcast)/.test(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url));
    expect(sent).toHaveLength(0);
  });

  it('本文を編集して再依頼した後、古い版の承認と版なし承認を拒否する', async () => {
    await setLowThreshold();
    testDb.raw.exec("UPDATE broadcasts SET message_content='新しい本文',lock_version=2,approval_status='pending',approval_requested_by_staff_id='staff-send' WHERE id='b1'");
    const headers = await steppedUpSession(testDb, 'staff-approve', 'stale-approval');
    for (const [body, status, code] of [[{ expectedVersion: 1 }, 409, 'VERSION_CONFLICT'], [{}, 400, 'EXPECTED_VERSION_REQUIRED']] as const) {
      const response = await app(testDb.db, approver).request('/api/broadcasts/b1/approval-approve', { ...json('POST', body), headers: { ...json('POST', body).headers, ...headers } });
      expect(response.status).toBe(status); expect(await response.json()).toMatchObject({ code }); expect(approvalOf(testDb, 'b1')).toBe('pending');
    }
  });

  it('承認した全員配信を、別の絞り込み対象へ承認ごと転用しない', async () => {
    await setLowThreshold();
    testDb.raw.exec("UPDATE broadcasts SET approval_status='approved' WHERE id='b1'");
    const headers = { ...await steppedUpSession(testDb, 'staff-send', 'segment-race'), 'X-Confirm-Irreversible': 'broadcast-send' };
    const body = json('POST', { conditions: { operator: 'AND', rules: [{ type: 'is_following', value: true }] } });
    const response = await app(testDb.db, sender).request('/api/broadcasts/b1/send-segment', { ...body, headers: { ...body.headers, ...headers } });
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ code: 'APPROVAL_REQUIRED' });
    expect(testDb.raw.prepare('SELECT status,target_type FROM broadcasts WHERE id=?').get('b1')).toEqual({ status: 'draft', target_type: 'all' });
  });

  it('境目を3通にすると5人への送信は承認が要り、承認なしでは送れない', async () => {
    const saved = await app(testDb.db, owner)
      .request('/api/broadcasts/approval-threshold?lineAccountId=account-1', json('PUT', {
        lineAccountId: 'account-1', threshold: 3,
      }));
    expect(saved.status).toBe(200);

    const row = await getBroadcastById(testDb.db, 'b1');
    const gate = await enforceBroadcastSendApproval(testDb.db, row!);
    expect(gate.allowed).toBe(false);
    if (!gate.allowed) expect(gate.code).toBe('APPROVAL_REQUIRED');
  });

  it('承認を依頼すると承認する人へのお知らせが1件積まれる', async () => {
    await app(testDb.db, owner)
      .request('/api/broadcasts/approval-threshold?lineAccountId=account-1', json('PUT', {
        lineAccountId: 'account-1', threshold: 3,
      }));

    const requested = await app(testDb.db, sender)
      .request('/api/broadcasts/b1/approval-request', json('POST', {
        approverStaffId: 'staff-approve', note: '秋の案内です',
      }));
    expect(requested.status).toBe(201);
    expect(approvalOf(testDb, 'b1')).toBe('pending');

    const notices = testDb.raw.prepare(
      `SELECT event_type FROM notifications WHERE event_type = 'broadcast.approval.requested'`,
    ).all() as Array<{ event_type: string }>;
    expect(notices.length).toBe(1);

    // 二重の依頼は作らない。
    const again = await app(testDb.db, sender)
      .request('/api/broadcasts/b1/approval-request', json('POST', { approverStaffId: 'staff-approve' }));
    expect(again.status).toBe(409);
  });

  it('訂正の予約は確認した人数・版で作り、二者承認後に台帳の人へ送る', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-16T00:00:00Z'));
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    try {
      seedStaff(testDb, 'owner-1', 'オーナー', 'owner', ['/broadcasts']);
      testDb.raw.exec(`UPDATE broadcasts SET target_type='segment',status='sent',total_count=2,success_count=1 WHERE id='b1';
        INSERT INTO broadcast_send_claims(broadcast_id,friend_id,line_account_id,state) VALUES('b1','friend-1','account-1','sent'),('b1','friend-2','account-1','failed')`);
      const id='c4522a8a-a40e-43eb-860a-38238f24f131';
      expect((await app(testDb.db,sender).request('/api/broadcasts/b1/correction',{method:'POST',headers:{'Idempotency-Key':id}})).status).toBe(201);
      expect((await app(testDb.db,owner).request('/api/broadcasts/approval-threshold?lineAccountId=account-1',json('PUT',{lineAccountId:'account-1',threshold:1}))).status).toBe(200);
      const body={expectedVersion:1,confirmedRecipientCount:1,scheduledAt:'2026-11-16T01:00:00Z'};
      expect((await app(testDb.db,sender).request(`/api/broadcasts/${id}`,{...json('PUT',body),headers:{'Content-Type':'application/json','X-Confirm-Irreversible':'broadcast-send'}})).status).toBe(200);
      expect((await app(testDb.db,sender).request(`/api/broadcasts/${id}/approval-request`,json('POST',{approverStaffId:'owner-1'}))).status).toBe(201);
      const stepped=await steppedUpSession(testDb,'owner-1','owner-scheduled-approval-token');
      expect((await app(testDb.db,owner).request(`/api/broadcasts/${id}/approval-approve`,{...json('POST',{expectedVersion:2}),headers:{'Content-Type':'application/json',...stepped}})).status).toBe(200);
      vi.setSystemTime(new Date('2026-11-16T01:01:00Z'));
      const {processScheduledBroadcasts,processQueuedBroadcasts}=await import('../features/broadcasts/broadcast.js');
      await processScheduledBroadcasts(testDb.db,{} as never); await processQueuedBroadcasts(testDb.db,{} as never);
      expect(testDb.raw.prepare('SELECT friend_id,state FROM broadcast_send_claims WHERE broadcast_id=?').all(id)).toEqual([{friend_id:'friend-1',state:'sent'}]);
    } finally { vi.useRealTimers(); }
  });

  it('訂正を別の担当者が承認した後、確認した版と人数で台帳の相手にだけ送る', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-16T01:00:00Z'));
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      seedStaff(testDb, 'owner-1', 'オーナー', 'owner', ['/broadcasts']);
      testDb.raw.exec(`UPDATE broadcasts SET target_type='segment',status='sent',total_count=2,success_count=1 WHERE id='b1';
        INSERT INTO broadcast_send_claims(broadcast_id,friend_id,line_account_id,state) VALUES('b1','friend-1','account-1','sent'),('b1','friend-2','account-1','failed')`);
      const correctionId='c4522a8a-a40e-43eb-860a-38238f24f131';
      const created=await app(testDb.db,sender).request('/api/broadcasts/b1/correction',{method:'POST',headers:{'Idempotency-Key':correctionId}});
      expect(created.status).toBe(201);
      const threshold=await app(testDb.db,owner).request('/api/broadcasts/approval-threshold?lineAccountId=account-1',json('PUT',{lineAccountId:'account-1',threshold:1}));
      expect(threshold.status).toBe(200);
      const requested=await app(testDb.db,sender).request(`/api/broadcasts/${correctionId}/approval-request`,json('POST',{approverStaffId:'owner-1'}));
      expect(requested.status).toBe(201);
      const stepped=await steppedUpSession(testDb,'owner-1','owner-approval-token');
      const approved=await app(testDb.db,owner).request(`/api/broadcasts/${correctionId}/approval-approve`,{...json('POST',{expectedVersion:1}),headers:{'Content-Type':'application/json',...stepped}});
      expect(approved.status).toBe(200);
      const sending=await app(testDb.db,owner).request(`/api/broadcasts/${correctionId}/send`,{...json('POST',{expectedVersion:1,confirmedRecipientCount:1}),headers:{'Content-Type':'application/json','X-Confirm-Irreversible':'broadcast-send'}});
      expect(sending.status).toBe(202);
      const {processQueuedBroadcasts}=await import('../features/broadcasts/broadcast.js');
      await processQueuedBroadcasts(testDb.db,{} as never);
      expect(testDb.raw.prepare('SELECT friend_id,state FROM broadcast_send_claims WHERE broadcast_id=?').all(correctionId)).toEqual([{friend_id:'friend-1',state:'sent'}]);
      const calls=fetchMock.mock.calls.filter(([url])=>String(url).includes('/message/'));
      expect(calls).toHaveLength(1);
      const payload=JSON.parse(String(calls[0][1]?.body));
      expect(payload.to === 'Ufriend-1' || (Array.isArray(payload.to) && payload.to.length===1 && payload.to[0]==='Ufriend-1')).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it('自分の依頼は承認できない（API で拒否）', async () => {
    await app(testDb.db, owner)
      .request('/api/broadcasts/approval-threshold?lineAccountId=account-1', json('PUT', {
        lineAccountId: 'account-1', threshold: 3,
      }));
    // owner が頼んだものを owner 自身は承認できない。
    await app(testDb.db, owner)
      .request('/api/broadcasts/b1/approval-request', json('POST', { approverStaffId: 'staff-approve' }));
    const selfApprove = await app(testDb.db, owner)
      .request('/api/broadcasts/b1/approval-approve', json('POST', { expectedVersion: 1 }));
    expect(selfApprove.status).toBe(403);
    await expect(selfApprove.json()).resolves.toMatchObject({ code: 'SELF_APPROVAL' });

    // 承認する権限の鍵がない人は承認できない。
    const noKey = await app(testDb.db, noKeyStaff)
      .request('/api/broadcasts/b1/approval-approve', json('POST', { expectedVersion: 1 }));
    expect(noKey.status).toBe(403);

    // 別の承認する人が承認すると通る。二重押しは409。
    // 承認は大事な操作なので、再確認済みのセッションを持つ人で行う。
    const steppedUp = await steppedUpSession(testDb, 'staff-approve', 'approve-session');
    const approved = await app(testDb.db, approver)
      .request('/api/broadcasts/b1/approval-approve', { ...json('POST', { expectedVersion: 1 }), headers: { ...json('POST', { expectedVersion: 1 }).headers, ...steppedUp } });
    expect(approved.status).toBe(200);
    expect(approvalOf(testDb, 'b1')).toBe('approved');
    const again = await app(testDb.db, approver)
      .request('/api/broadcasts/b1/approval-approve', { ...json('POST', { expectedVersion: 1 }), headers: { ...json('POST', { expectedVersion: 1 }).headers, ...steppedUp } });
    expect(again.status).toBe(409);
  });

  it('差し戻しは理由が必須。理由があれば差し戻しになる', async () => {
    await app(testDb.db, owner)
      .request('/api/broadcasts/approval-threshold?lineAccountId=account-1', json('PUT', {
        lineAccountId: 'account-1', threshold: 3,
      }));
    await app(testDb.db, sender)
      .request('/api/broadcasts/b1/approval-request', json('POST', { approverStaffId: 'staff-approve' }));

    const noReason = await app(testDb.db, approver)
      .request('/api/broadcasts/b1/approval-reject', json('POST', { reason: '  ' }));
    expect(noReason.status).toBe(400);

    const rejected = await app(testDb.db, approver)
      .request('/api/broadcasts/b1/approval-reject', json('POST', { reason: '金額が古い' }));
    expect(rejected.status).toBe(200);
    expect(approvalOf(testDb, 'b1')).toBe('rejected');

    // 差し戻しのあとは頼み直せる。
    const rerequest = await app(testDb.db, sender)
      .request('/api/broadcasts/b1/approval-request', json('POST', { approverStaffId: 'staff-approve' }));
    expect(rerequest.status).toBe(201);
  });

  it('頼んだ人は依頼を取り消せる。もう一度知らせるで通知が増える', async () => {
    await app(testDb.db, owner)
      .request('/api/broadcasts/approval-threshold?lineAccountId=account-1', json('PUT', {
        lineAccountId: 'account-1', threshold: 3,
      }));
    await app(testDb.db, sender)
      .request('/api/broadcasts/b1/approval-request', json('POST', { approverStaffId: 'staff-approve' }));

    const reminded = await app(testDb.db, sender)
      .request('/api/broadcasts/b1/approval-remind', json('POST', { expectedVersion: 1 }));
    expect(reminded.status).toBe(200);
    const remindedCount = (testDb.raw.prepare(
      `SELECT COUNT(*) AS total FROM notifications WHERE event_type = 'broadcast.approval.reminded'`,
    ).get() as { total: number }).total;
    expect(remindedCount).toBe(1);

    const cancelled = await app(testDb.db, sender)
      .request('/api/broadcasts/b1/approval-cancel', json('POST', { expectedVersion: 1 }));
    expect(cancelled.status).toBe(200);
    expect(approvalOf(testDb, 'b1')).toBe('cancelled');
  });

  it('予約時刻を過ぎた未承認は期限切れになり、cron は送らない', async () => {
    await app(testDb.db, owner)
      .request('/api/broadcasts/approval-threshold?lineAccountId=account-1', json('PUT', {
        lineAccountId: 'account-1', threshold: 3,
      }));
    seedBroadcast(testDb, 'b2', {
      status: 'scheduled', scheduled_at: '2026-09-24T10:00:00+09:00',
    });
    await app(testDb.db, sender)
      .request('/api/broadcasts/b2/approval-request', json('POST', { approverStaffId: 'staff-approve' }));

    await sweepBroadcastApprovalExpiry(testDb.db, new Date('2026-09-25T00:00:00+09:00').getTime());
    expect(approvalOf(testDb, 'b2')).toBe('expired');

    const row = await getBroadcastById(testDb.db, 'b2');
    const check = await checkScheduledBroadcastApproval(testDb.db, row!);
    expect(check.sendable).toBe(false);
  });

  it('確認画面の出し分けに使う境目・人数・運用者数が取れる', async () => {
    const config = await app(testDb.db, sender)
      .request('/api/broadcasts/approval-config?lineAccountId=account-1');
    expect(config.status).toBe(200);
    await expect(config.json()).resolves.toMatchObject({
      success: true,
      data: { threshold: 1000, operatorCount: 2, singleOperator: false },
    });

    const candidates = await app(testDb.db, sender)
      .request('/api/broadcasts/approvals/candidates?lineAccountId=account-1');
    expect(candidates.status).toBe(200);
    const body = await candidates.json() as {
      success: boolean; data: Array<{ id: string }>;
    };
    // 自分は候補に出ない。承認する人だけ出る。
    expect(body.data.map((item) => item.id)).toEqual(['staff-approve']);
  });

  it('1人運用では承認の依頼は要らず、人数の一致で送れる', async () => {
    // 承認する人を消して1人運用にする。
    testDb.raw.prepare(`DELETE FROM staff_members WHERE id = 'staff-approve'`).run();
    await app(testDb.db, owner)
      .request('/api/broadcasts/approval-threshold?lineAccountId=account-1', json('PUT', {
        lineAccountId: 'account-1', threshold: 3,
      }));

    const requested = await app(testDb.db, sender)
      .request('/api/broadcasts/b1/approval-request', json('POST', { approverStaffId: 'staff-approve' }));
    expect(requested.status).toBe(409);
    await expect(requested.json()).resolves.toMatchObject({ code: 'SINGLE_OPERATOR' });


    const row = await getBroadcastById(testDb.db, 'b1');
    const mismatch = await enforceBroadcastSendApproval(testDb.db, row!, { confirmedRecipientCount: 4 });
    expect(mismatch.allowed).toBe(false);
    if (!mismatch.allowed) expect(mismatch.code).toBe('COUNT_MISMATCH');
    const matched = await enforceBroadcastSendApproval(testDb.db, row!, { confirmedRecipientCount: 5 });
    expect(matched.allowed).toBe(true);
  });
});
