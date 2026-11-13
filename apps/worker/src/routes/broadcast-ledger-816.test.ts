/*
 *  — 一斉配信の宛先台帳・記録・10の状態。
 *
 * 見張るのは契約の3点。
 *
 *   - 10の状態: status の CHECK は変えられないので、承認・停止・台帳から
 *     組み立てる。二者承認（#A）の軸（承認待ち・期限切れ）とずれない。
 *   - 宛先台帳: 人の言葉の札・一時的な失敗だけの絞り込み・旧配信の捏造禁止。
 *   - 記録: 操作と承認を時刻順に混ぜて返す。追記だけ（消さない）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../worker-env';
import type { AuthenticatedStaff } from '../middleware/auth/principal/auth';
import { createTestD1, insertFriend, type SqliteD1 } from '../test-utils/d1-sqlite';
import { settleBroadcastRecipients, markBroadcastRecipientsDispatched } from '@line-crm/db';
import { broadcasts } from './broadcasts';

const owner: AuthenticatedStaff = {
  id: 'owner-1', name: 'オーナー', role: 'owner', readOnly: false, tenantId: 'tenant-1',
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
    status: 'draft',
    batch_offset: 0,
    total_count: 3,
    success_count: 0,
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
  opts: { errorCode?: string | null; requestId?: string | null; broadcastId?: string } = {},
): void {
  db.raw.prepare(
    `INSERT INTO broadcast_send_claims
       (broadcast_id, friend_id, line_account_id, attempt_no, state, dispatched_at, settled_at,
        error_code, line_request_id, created_at, updated_at)
     VALUES (?, ?, 'account-1', 1, ?, '2026-09-11T09:30:00.000', '2026-09-11T09:31:00.000', ?, ?, '2026-09-11T09:00:00.000', '2026-09-11T09:00:00.000')`,
  ).run(opts.broadcastId ?? 'b1', friendId, state, opts.errorCode ?? null, opts.requestId ?? null);
}

async function displayStatusOf(db: SqliteD1, id: string): Promise<{ displayStatus: string; label: string }> {
  const res = await app(db.db).request(`/api/broadcasts/${id}`);
  expect(res.status).toBe(200);
  const body = await res.json() as { data: { displayStatus: string; displayStatusLabel: string } };
  return { displayStatus: body.data.displayStatus, label: body.data.displayStatusLabel };
}

describe('10の状態（#816）', () => {
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

  it('下書きは下書き', async () => {
    seedBroadcast(testDb, 'b1', { status: 'draft' });
    expect(await displayStatusOf(testDb, 'b1')).toMatchObject({ displayStatus: 'draft', label: '下書き' });
  });

  it('承認を頼んだら承認待ち（status が予約済みでも承認の軸で見せる）', async () => {
    seedBroadcast(testDb, 'b1', {
      status: 'scheduled',
      scheduled_at: '2099-10-01T10:00:00+09:00',
      approval_status: 'pending',
    });
    expect(await displayStatusOf(testDb, 'b1')).toMatchObject({ displayStatus: 'pending_approval', label: '承認待ち' });
  });

  it('承認待ちのまま予約の時刻を過ぎたら期限切れ', async () => {
    seedBroadcast(testDb, 'b1', {
      status: 'scheduled',
      scheduled_at: '2020-10-01T10:00:00+09:00',
      approval_status: 'pending',
    });
    expect(await displayStatusOf(testDb, 'b1')).toMatchObject({ displayStatus: 'expired', label: '期限切れ' });
  });

  it('承認が期限切れになったら期限切れ', async () => {
    seedBroadcast(testDb, 'b1', { status: 'scheduled', approval_status: 'expired' });
    expect(await displayStatusOf(testDb, 'b1')).toMatchObject({ displayStatus: 'expired' });
  });

  it('予約済みは予約済み', async () => {
    seedBroadcast(testDb, 'b1', { status: 'scheduled', scheduled_at: '2099-10-01T10:00:00+09:00' });
    expect(await displayStatusOf(testDb, 'b1')).toMatchObject({ displayStatus: 'scheduled', label: '予約済み' });
  });

  it('送り始めた直後（台帳が空）は送信準備', async () => {
    seedBroadcast(testDb, 'b1', { status: 'sending' });
    expect(await displayStatusOf(testDb, 'b1')).toMatchObject({ displayStatus: 'preparing', label: '送信準備' });
  });

  it('台帳に手が付けば送信中', async () => {
    seedBroadcast(testDb, 'b1', { status: 'sending' });
    seedClaim(testDb, 'f1', 'sent');
    expect(await displayStatusOf(testDb, 'b1')).toMatchObject({ displayStatus: 'sending', label: '送信中' });
  });

  it('止めたら停止（status は sending のまま）', async () => {
    seedBroadcast(testDb, 'b1', { status: 'sending', stopped_at: '2026-09-11T09:40:00.000' });
    seedClaim(testDb, 'f1', 'sent');
    expect(await displayStatusOf(testDb, 'b1')).toMatchObject({ displayStatus: 'stopped', label: '停止' });
  });

  it('全部届いたら送信済み', async () => {
    seedBroadcast(testDb, 'b1', { status: 'sent' });
    seedClaim(testDb, 'f1', 'sent');
    expect(await displayStatusOf(testDb, 'b1')).toMatchObject({ displayStatus: 'sent', label: '送信済み' });
  });

  it('一部だけ失敗したら一部失敗', async () => {
    seedBroadcast(testDb, 'b1', { status: 'sent' });
    seedClaim(testDb, 'f1', 'sent');
    seedClaim(testDb, 'f2', 'failed', { errorCode: 'line_http_400' });
    expect(await displayStatusOf(testDb, 'b1')).toMatchObject({ displayStatus: 'partial_failed', label: '一部失敗' });
  });

  it('全部失敗したら失敗', async () => {
    seedBroadcast(testDb, 'b1', { status: 'sent' });
    seedClaim(testDb, 'f1', 'failed', { errorCode: 'line_http_400' });
    seedClaim(testDb, 'f2', 'failed', { errorCode: 'line_http_429' });
    expect(await displayStatusOf(testDb, 'b1')).toMatchObject({ displayStatus: 'failed', label: '失敗' });
  });

  it('SCALE-01 配信本文と宛先台帳は表示ページの分だけを読む', async () => {
    for(let i=0;i<250;i++) seedBroadcast(testDb, `synthetic-${i}`, { status: 'draft' });
    let hydrated=0;
    const ledgerBindings:number[]=[];
    const original=testDb.db.prepare.bind(testDb.db);
    vi.spyOn(testDb.db,'prepare').mockImplementation(sql=>{
      const wrap=(stmt:D1PreparedStatement):D1PreparedStatement=>new Proxy(stmt,{
        get(target,key,receiver){
          if(key==='bind')return(...args:unknown[])=>{
            if(sql.includes('GROUP BY broadcast_id'))ledgerBindings.push(args.length);
            return wrap(target.bind(...args));
          };
          if(key==='all')return async()=>{const result=await target.all<Record<string,unknown>>();
            hydrated+=result.results.filter(row=>'message_content' in row).length;
            return result;
          };
          return Reflect.get(target,key,receiver);
        },
      });
      return wrap(original(sql));
    });
    const res=await app(testDb.db).request('/api/broadcasts?limit=20');
    expect(res.status).toBe(200);
    const body=await res.json() as {data:unknown[];pagination:{total:number;nextCursor:string};statusCounts:{all:number;draft:number}};
    expect(body.data).toHaveLength(20);
    expect(body.pagination).toMatchObject({total:250,nextCursor:'20'});
    expect(body.statusCounts).toMatchObject({all:250,draft:250});
    expect(hydrated).toBe(20);
    expect(Math.max(...ledgerBindings)).toBeLessThanOrEqual(20);
  });

  it('一覧にも10の状態が載る', async () => {
    seedBroadcast(testDb, 'b1', { status: 'sent' });
    seedClaim(testDb, 'f1', 'sent');
    seedClaim(testDb, 'f2', 'failed', { errorCode: 'line_http_400' });
    const res = await app(testDb.db).request('/api/broadcasts');
    expect(res.status).toBe(200);
    const body = await res.json() as { data: Array<{ id: string; displayStatus: string }> };
    expect(body.data.find((item) => item.id === 'b1')?.displayStatus).toBe('partial_failed');
  });
});

describe('宛先台帳（#816）', () => {
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
    insertFriend(testDb.raw, 'f1', { line_account_id: 'account-1', display_name: '山田花子' });
    insertFriend(testDb.raw, 'f2', { line_account_id: 'account-1', display_name: '佐々木健' });
    insertFriend(testDb.raw, 'f3', { line_account_id: 'account-1', display_name: '鈴木一郎' });
  });

  afterEach(() => testDb.raw.close());

  it('別の統括の配信の宛先は見つからない扱いで断る', async () => {
    seedBroadcast(testDb, 'b1', { line_account_id: 'account-2' });
    const res = await app(testDb.db).request('/api/broadcasts/b1/recipients');
    expect(res.status).toBe(404);
  });

  it('宛先ごとに人の言葉の札・時刻・要求IDを返す', async () => {
    seedBroadcast(testDb, 'b1', { status: 'sending', total_count: 3 });
    seedClaim(testDb, 'f1', 'sent', { requestId: 'req-1' });
    seedClaim(testDb, 'f2', 'failed', { errorCode: 'line_http_400' });
    seedClaim(testDb, 'f3', 'failed', { errorCode: 'line_http_429' });
    const res = await app(testDb.db).request('/api/broadcasts/b1/recipients');
    expect(res.status).toBe(200);
    const body = await res.json() as {
      data: {
        rows: Array<{ displayName: string; label: string; retryable: boolean; lineRequestId: string | null; settledAt: string | null }>;
        summary: { sent: number; failedTemporary: number; failedPermanent: number; pending: number; total: number; retryableCount: number };
      };
    };
    expect(body.data.rows).toHaveLength(3);
    const byName = new Map(body.data.rows.map((row) => [row.displayName, row]));
    expect(byName.get('山田花子')).toMatchObject({ label: '届いた', retryable: false, lineRequestId: 'req-1' });
    // 400番台は「ブロック・友だち解除など」で送り直さない。
    expect(byName.get('佐々木健')).toMatchObject({ label: '失敗：届けられませんでした', retryable: false });
    // 429（混み合い）だけ送り直せる。
    expect(byName.get('鈴木一郎')?.label).toContain('一時的');
    expect(byName.get('鈴木一郎')).toMatchObject({ retryable: true });
    for (const row of body.data.rows) expect(row.settledAt).not.toBeNull();
    expect(body.data.summary).toMatchObject({
      sent: 1, failedTemporary: 1, failedPermanent: 1, pending: 0, total: 3, retryableCount: 1,
    });
  });

  it('一時的だけに絞れる', async () => {
    seedBroadcast(testDb, 'b1', { status: 'sent' });
    seedClaim(testDb, 'f1', 'failed', { errorCode: 'line_http_400' });
    seedClaim(testDb, 'f2', 'failed', { errorCode: 'line_http_429' });
    const res = await app(testDb.db).request('/api/broadcasts/b1/recipients?result=temporary');
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { rows: Array<{ displayName: string }> } };
    expect(body.data.rows.map((row) => row.displayName)).toEqual(['佐々木健']);
  });

  it('送る前は件数だけ返す（名前は捏造しない）', async () => {
    seedBroadcast(testDb, 'b1', { status: 'sending', total_count: 3 });
    seedClaim(testDb, 'f1', 'sent');
    const res = await app(testDb.db).request('/api/broadcasts/b1/recipients');
    const body = await res.json() as { data: { summary: { pending: number } } };
    expect(body.data.summary.pending).toBe(2);
  });

  it('完了済みの旧配信は集約だけ返す', async () => {
    seedBroadcast(testDb, 'b1', { status: 'sent', success_count: 120, total_count: 150 });
    const res = await app(testDb.db).request('/api/broadcasts/b1/recipients');
    expect(res.status).toBe(200);
    const body = await res.json() as {
      data: { rows: unknown[]; aggregateOnly: boolean; aggregateReason: string; legacySuccessCount: number };
    };
    expect(body.data.rows).toEqual([]);
    expect(body.data.aggregateOnly).toBe(true);
    expect(body.data.aggregateReason).toBe('legacy');
    expect(body.data.legacySuccessCount).toBe(120);
  });

  it('知らない絞り込みは断る', async () => {
    seedBroadcast(testDb, 'b1', { status: 'sent' });
    const res = await app(testDb.db).request('/api/broadcasts/b1/recipients?result=nope');
    expect(res.status).toBe(400);
  });

  it('届いた行にだけ要求IDが残る（決着の向きを間違えない）', async () => {
    seedBroadcast(testDb, 'b1', { status: 'sending' });
    await markBroadcastRecipientsDispatched(testDb.db, {
      broadcastId: 'b1', attemptNo: 1, lineAccountId: 'account-1', friendIds: ['f1', 'f2'],
    });
    await settleBroadcastRecipients(testDb.db, {
      broadcastId: 'b1', friendIds: ['f1'], state: 'sent', lineRequestId: 'req-batch-9',
    });
    await settleBroadcastRecipients(testDb.db, {
      broadcastId: 'b1', friendIds: ['f2'], state: 'failed', errorCode: 'line_http_400',
      lineRequestId: 'req-batch-9',
    });
    const saved = testDb.raw.prepare(
      `SELECT friend_id, state, line_request_id FROM broadcast_send_claims WHERE broadcast_id = 'b1' ORDER BY friend_id`,
    ).all() as Array<{ friend_id: string; state: string; line_request_id: string | null }>;
    expect(saved).toEqual([
      { friend_id: 'f1', state: 'sent', line_request_id: 'req-batch-9' },
      // 失敗の行に要求IDを書くと「送った証拠があるのに失敗」と読めるので書かない。
      { friend_id: 'f2', state: 'failed', line_request_id: null },
    ]);
  });
});

describe('再送は一時的な失敗だけ（#816）', () => {
  let testDb: SqliteD1;

  beforeEach(() => {
    testDb = createTestD1();
    testDb.raw.prepare("INSERT INTO tenants (id, name) VALUES ('tenant-1', '統括1')").run();
    testDb.raw.prepare(`
      INSERT INTO line_accounts
        (id, channel_id, name, channel_access_token, channel_secret, is_active, tenant_id)
      VALUES ('account-1', 'channel-1', '店舗1', 'token-1', 'secret-1', 1, 'tenant-1')
    `).run();
    for (const id of ['f1', 'f2', 'f3']) insertFriend(testDb.raw, id, { line_account_id: 'account-1' });
  });

  afterEach(() => testDb.raw.close());

  it('混み合いの失敗だけ開け直し、届けられなかった相手には触れない', async () => {
    seedBroadcast(testDb, 'b1', { status: 'sent', sent_at: '2026-09-11T10:00:00.000' });
    seedClaim(testDb, 'f1', 'sent');
    seedClaim(testDb, 'f2', 'failed', { errorCode: 'line_http_400' });
    seedClaim(testDb, 'f3', 'failed', { errorCode: 'line_http_429' });
    const res = await app(testDb.db).request(
      '/api/broadcasts/b1/retry-failed',
      post({ expectedVersion: 1 }, CONFIRM_HEADERS),
    );
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ attemptNo: 2, retryTargets: 1 });
    const claims = testDb.raw.prepare(
      `SELECT friend_id, state, attempt_no FROM broadcast_send_claims WHERE broadcast_id = 'b1' ORDER BY friend_id`,
    ).all();
    expect(claims).toEqual([
      { friend_id: 'f1', state: 'sent', attempt_no: 1 },
      // 恒常的な失敗は開け直さない。送り直しても通らない相手へ送らない。
      { friend_id: 'f2', state: 'failed', attempt_no: 1 },
      { friend_id: 'f3', state: 'claimed', attempt_no: 2 },
    ]);
  });

  it('恒常的な失敗だけでは送らない', async () => {
    seedBroadcast(testDb, 'b1', { status: 'sent', sent_at: '2026-09-11T10:00:00.000' });
    seedClaim(testDb, 'f1', 'failed', { errorCode: 'line_http_400' });
    const res = await app(testDb.db).request(
      '/api/broadcasts/b1/retry-failed',
      post({ expectedVersion: 1 }, CONFIRM_HEADERS),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'NO_RETRY_TARGET' });
    expect(testDb.raw.prepare(`SELECT send_attempt_no FROM broadcasts WHERE id = 'b1'`).get()).toMatchObject({
      send_attempt_no: 1,
    });
  });
});

describe('操作の記録（#816）', () => {
  let testDb: SqliteD1;

  beforeEach(() => {
    testDb = createTestD1();
    testDb.raw.prepare("INSERT INTO tenants (id, name) VALUES ('tenant-1', '統括1')").run();
    testDb.raw.prepare(`
      INSERT INTO line_accounts
        (id, channel_id, name, channel_access_token, channel_secret, is_active, tenant_id)
      VALUES ('account-1', 'channel-1', '店舗1', 'token-1', 'secret-1', 1, 'tenant-1')
    `).run();
    testDb.raw.prepare(
      `INSERT INTO staff_members (id, name, email, role, api_key) VALUES ('owner-1', '見本太郎', 'owner@example.com', 'owner', 'key-1')`,
    ).run();
    for (const id of ['f1', 'f2']) insertFriend(testDb.raw, id, { line_account_id: 'account-1' });
  });

  afterEach(() => testDb.raw.close());

  it('止めると記録に残り、名前付きで新しい順に読める', async () => {
    seedBroadcast(testDb, 'b1', { status: 'sending' });
    const stopRes = await app(testDb.db).request('/api/broadcasts/b1/stop', post({ expectedVersion: 1 }));
    expect(stopRes.status).toBe(200);

    const res = await app(testDb.db).request('/api/broadcasts/b1/activity');
    expect(res.status).toBe(200);
    const body = await res.json() as {
      data: Array<{ kind: string; action: string; label: string; actorName: string }>;
    };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({ kind: 'lifecycle', action: 'stopped', label: '送信を止めた', actorName: '見本太郎' });
  });

  it('承認の記録と混ぜて返す', async () => {
    seedBroadcast(testDb, 'b1', { status: 'sending' });
    testDb.raw.prepare(
      `INSERT INTO broadcast_approval_events (id, broadcast_id, actor_staff_id, action, reason, created_at)
       VALUES ('e1', 'b1', 'owner-1', 'requested', NULL, '2026-09-11T09:05:00.000')`,
    ).run();
    testDb.raw.prepare(
      `INSERT INTO broadcast_lifecycle_events (id, broadcast_id, actor_staff_id, action, created_at)
       VALUES ('l1', 'b1', 'owner-1', 'send_started', '2026-09-11T09:10:00.000')`,
    ).run();
    const res = await app(testDb.db).request('/api/broadcasts/b1/activity');
    const body = await res.json() as { data: Array<{ label: string; actorName: string }> };
    expect(body.data.map((entry) => entry.label)).toEqual(['送信を始めた', '承認を依頼した']);
    expect(body.data[0].actorName).toBe('見本太郎');
  });

  it('担当者のいない自動の記録は「自動」と出す', async () => {
    seedBroadcast(testDb, 'b1', { status: 'sending' });
    testDb.raw.prepare(
      `INSERT INTO broadcast_lifecycle_events (id, broadcast_id, actor_staff_id, action, created_at)
       VALUES ('l1', 'b1', NULL, 'send_started', '2026-09-11T09:10:00.000')`,
    ).run();
    const res = await app(testDb.db).request('/api/broadcasts/b1/activity');
    const body = await res.json() as { data: Array<{ actorName: string }> };
    expect(body.data[0].actorName).toBe('自動');
  });

  it('別の統括の配信の記録は見つからない扱いで断る', async () => {
    seedBroadcast(testDb, 'b1', { line_account_id: 'account-1' });
    const other: AuthenticatedStaff = { ...owner, id: 'owner-2', tenantId: 'tenant-9' };
    const res = await app(testDb.db, other).request('/api/broadcasts/b1/activity');
    expect(res.status).toBe(404);
  });
});
