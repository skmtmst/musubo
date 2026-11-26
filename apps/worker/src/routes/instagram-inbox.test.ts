import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../worker-env.js';
import type { AuthenticatedStaff } from '../middleware/auth/principal/auth.js';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';
import * as instagramService from '../services/instagram.js';
import { instagram } from './instagram.js';

let db: SqliteD1;

const owner: AuthenticatedStaff = {
  id: 'owner-1',
  name: '見本 オーナー',
  role: 'owner',
  readOnly: false,
  tenantId: 't1',
  permissionKeys: [],
};

const admin: AuthenticatedStaff = {
  id: 'admin-1',
  name: '見本 管理者',
  role: 'admin',
  readOnly: false,
  tenantId: 't1',
  permissionKeys: [],
};

const member: AuthenticatedStaff = {
  id: 'staff-1',
  name: '見本 担当者',
  role: 'staff',
  readOnly: false,
  tenantId: 't1',
  permissionKeys: ['/chats'],
};

const hqOperatorMember: AuthenticatedStaff = {
  ...member,
  id: 'staff-hq',
  hqRole: 'operator',
};

const viewer: AuthenticatedStaff = {
  ...admin,
  id: 'viewer-1',
  name: '見本 閲覧者',
  readOnly: true,
};

const config = {
  META_APP_ID: '100',
  META_APP_SECRET: 'secret_mock',
  INSTAGRAM_APP_ID: '200',
  INSTAGRAM_APP_SECRET: 'ig_secret_mock',
  META_REDIRECT_URI: 'https://worker.test/api/instagram/oauth/callback',
  META_GRAPH_API_VERSION: 'v24.0',
  META_TOKEN_ENCRYPTION_KEY: btoa('x'.repeat(32)),
  META_WEBHOOK_VERIFY_TOKEN: 'verify_mock',
};

function app(staff: AuthenticatedStaff = admin, configured = true) {
  const instance = new Hono<Env>();
  instance.use('*', async (c, next) => {
    c.env = { DB: db.db, ...(configured ? config : {}) } as Env['Bindings'];
    c.set('staff', staff);
    await next();
  });
  instance.route('/', instagram);
  return instance;
}

async function seedConnectedDmInbox() {
  const encrypted = await instagramService.encryptInstagramCredential('user_token_mock', config.META_TOKEN_ENCRYPTION_KEY);
  const now = new Date().toISOString();
  const future = new Date(Date.now() + 30 * 86400 * 1000).toISOString();
  db.raw.prepare(
    `INSERT INTO instagram_connections
       (id,line_account_id,page_id,instagram_id,page_name,username,page_token_encrypted,user_token_encrypted,expires_at,refreshed_at,connected_by,version,scopes,sort_order)
     VALUES ('igc-1','a1','20','20','見本 店舗','sample_shop',?,?,?,?,'admin-1',1,'instagram_business_basic,instagram_business_content_publish,instagram_business_manage_messages',0)`,
  ).run(encrypted, encrypted, future, now);
  db.raw.prepare(
    `INSERT INTO instagram_messages
       (id,line_account_id,instagram_id,sender_id,recipient_id,content,received_at,created_at)
     VALUES ('m1','a1','20','customer','20','在庫を教えてください',?,?)`,
  ).run(now, now);
}

function sendReply(staff: AuthenticatedStaff, key: string, text = '在庫がございます') {
  return app(staff).request('/api/instagram/messages/m1/reply?lineAccountId=a1', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify({ text }),
  });
}

function resolveReply(staff: AuthenticatedStaff, body: Record<string, unknown>) {
  return app(staff).request('/api/instagram/conversations/customer/resolve?lineAccountId=a1&instagramId=20', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  db = createTestD1();
  db.raw.exec(
    "INSERT INTO tenants(id,name) VALUES('t1','見本 組織'); INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret,tenant_id) VALUES('a1','1','見本 アカウント','','','t1');",
  );
  db.raw.exec(
    "INSERT INTO staff_members(id,name,role,api_key,tenant_id) VALUES('staff-1','見本 担当者','staff','k1','t1'),('staff-hq','見本 統括担当','staff','k2','t1');",
  );
});

afterEach(() => {
  db.raw.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function postEcho(input: { time: number; sender?: string; text?: string; mid?: string }) {
  const raw = JSON.stringify({ object: 'instagram', entry: [{ id: '20', messaging: [{ sender: { id: input.sender ?? '20' }, recipient: { id: 'customer' }, timestamp: input.time, message: { mid: input.mid ?? 'echo-test', text: input.text ?? '返信', is_echo: true } }] }] });
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(config.META_APP_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw))), x => x.toString(16).padStart(2, '0')).join('');
  return app().request('/api/instagram/webhook', { method: 'POST', headers: { 'X-Hub-Signature-256': `sha256=${signature}` }, body: raw });
}

function seedOutbound(status: string, at: string, content = '返信', resolvedAt = at) {
  const key = crypto.randomUUID();
  db.raw.prepare(`INSERT INTO instagram_outbound_messages
    (idempotency_key,line_account_id,instagram_id,sender_id,staff_id,content,status,created_at,resolved_by_staff_id,resolved_at,resolution_kind,resolution_evidence)
    VALUES (?,'a1','20','customer','owner-1',?,?,?,'owner-1',?,'reason','確認')`).run(key, content, status, at, resolvedAt);
  return key;
}

describe('Instagram DM 未送信確定と再送の制御', () => {
  it('未送信確定で行を残し、確認者・時刻・理由を記録し、同じキーを拒否して新しいキーだけ再送を許す', async () => {
    await seedConnectedDmInbox();
    const sendMock = vi.fn()
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce(Response.json({ message_id: 'meta-msg-2' }));
    vi.stubGlobal('fetch', sendMock);

    const firstKey = crypto.randomUUID();
    expect((await sendReply(member, firstKey)).status).toBe(502);

    // 未確定のままでは同じキーでも新しいキーでも送れない。
    expect((await sendReply(member, firstKey)).status).toBe(409);
    expect((await sendReply(member, crypto.randomUUID())).status).toBe(409);
    expect(sendMock).toHaveBeenCalledTimes(1);

    db.raw.prepare("UPDATE instagram_outbound_messages SET created_at=? WHERE idempotency_key=?").run(new Date(Date.now() - 360000).toISOString(), firstKey);
    sendMock.mockReset().mockResolvedValueOnce(Response.json({ data: [] })).mockResolvedValueOnce(Response.json({ message_id: 'meta-msg-2' }));
    // 管理者が理由を添えて未送信確定する。
    const resolved = await resolveReply(admin, {
      key: firstKey,
      outcome: 'not_sent',
      reason: 'Instagramアプリの受信箱で該当返信が無いことを確認',
    });
    expect(resolved.status).toBe(200);

    // 行は削除されず、status・確かめた人・時刻・根拠が残る。
    const row = db.raw.prepare(
      `SELECT staff_id,status,resolved_by_staff_id,resolved_at,resolution_kind,resolution_evidence
         FROM instagram_outbound_messages WHERE idempotency_key=?`,
    ).get(firstKey) as Record<string, string>;
    expect(row).toMatchObject({
      staff_id: 'staff-1',
      status: 'not_sent_confirmed',
      resolved_by_staff_id: 'admin-1',
      resolution_kind: 'meta_conversation_absent',
    });
    expect(Number.isFinite(Date.parse(row.resolved_at))).toBe(true);

    // 同じ送信キーは確定後も再利用できない。
    const sameKeyResend = await sendReply(member, firstKey);
    expect(sameKeyResend.status).toBe(409);
    expect(sendMock).toHaveBeenCalledTimes(1);

    // 新しい送信キーでのみ再送でき、確定済みの行もそのまま残る。
    const secondKey = crypto.randomUUID();
    const newKeyResend = await sendReply(member, secondKey);
    expect(newKeyResend.status).toBe(200);
    expect(sendMock).toHaveBeenCalledTimes(2);
    const allRows = db.raw.prepare(
      'SELECT idempotency_key,status FROM instagram_outbound_messages ORDER BY created_at,idempotency_key',
    ).all();
    expect(allRows).toEqual([
      { idempotency_key: firstKey, status: 'not_sent_confirmed' },
      { idempotency_key: secondKey, status: 'sent' },
    ]);
  });

  it('Meta側の会話を読み取って不在を確認できたときは根拠を残して確定でき、存在するときは拒否する', async () => {
    await seedConnectedDmInbox();
    const firstKey = crypto.randomUUID();
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(String(input));
      if (init?.method === 'POST' && url.pathname.endsWith('/messages')) {
        throw new Error('network_lost');
      }
      if (url.pathname.endsWith('/conversations')) {
        return Response.json({
          data: [{
            id: 'conv-1',
            messages: {
              data: [{
                id: 'm-in',
                message: '在庫を教えてください',
                created_time: '2020-01-01T00:00:00+0000',
                from: { id: 'customer' },
              }],
            },
          }],
        });
      }
      return Response.json({}, { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    expect((await sendReply(owner, firstKey)).status).toBe(502);

    db.raw.prepare("UPDATE instagram_outbound_messages SET created_at=? WHERE idempotency_key=?").run(new Date(Date.now() - 360000).toISOString(), firstKey);
    // 理由文が無くても Meta 側の会話に返信が無かった事実を確認できれば確定できる。
    const resolved = await resolveReply(owner, { key: firstKey, outcome: 'not_sent' });
    expect(resolved.status).toBe(200);
    const saved = db.raw.prepare(
      'SELECT status,resolved_by_staff_id,resolution_kind,resolution_evidence FROM instagram_outbound_messages WHERE idempotency_key=?',
    ).get(firstKey) as Record<string, string>;
    expect(saved.status).toBe('not_sent_confirmed');
    expect(saved.resolved_by_staff_id).toBe('owner-1');
    expect(saved.resolution_kind).toBe('meta_conversation_absent');
    expect(saved.resolution_evidence).toContain('meta_conversation_absent:');

    // Meta 側の会話に同じ返信が届いていた場合は未送信確定を拒み、再送も許さない。
    const deliveredKey = crypto.randomUUID();
    const createdAt = new Date(Date.now() - 360000).toISOString();
    db.raw.prepare(
      `INSERT INTO instagram_outbound_messages
         (idempotency_key,line_account_id,instagram_id,sender_id,staff_id,content,status,created_at)
       VALUES (?,'a1','20','customer','owner-1','すでに届いた返信','unknown',?)`,
    ).run(deliveredKey, createdAt);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      data: [{
        id: 'conv-1',
        messages: {
          data: [{
            id: 'meta-out-1',
            message: 'すでに届いた返信',
            created_time: createdAt,
            from: { id: '20' },
          }],
        },
      }],
    })));
    expect((await resolveReply(owner, { key: deliveredKey, outcome: 'not_sent' })).status).toBe(200);
    expect(db.raw.prepare('SELECT status FROM instagram_outbound_messages WHERE idempotency_key=?').get(deliveredKey)).toEqual({ status: 'sent' });
  });

  it('根拠を示せないとき（理由文がなくMeta側の会話取得も失敗または接続不可）は未送信確定も再送も許さない', async () => {
    await seedConnectedDmInbox();
    const key = crypto.randomUUID();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('timeout')));
    expect((await sendReply(admin, key)).status).toBe(502);

    db.raw.prepare("UPDATE instagram_outbound_messages SET created_at=? WHERE idempotency_key=?").run(new Date(Date.now() - 360000).toISOString(), key);
    // 1) Meta 会話取得が通信失敗
    const sendOrRead = vi.fn().mockRejectedValue(new Error('meta_down'));
    vi.stubGlobal('fetch', sendOrRead);
    expect((await resolveReply(admin, { key, outcome: 'not_sent' })).status).toBe(502);
    expect((await resolveReply(admin, { key, outcome: 'not_sent', reason: '   ' })).status).toBe(502);
    expect((await sendReply(admin, crypto.randomUUID())).status).toBe(409);

    // 2) Meta 会話取得が 500 応答
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { code: 2 } }, { status: 500 })));
    expect((await resolveReply(admin, { key, outcome: 'not_sent' })).status).toBe(502);
    expect((await sendReply(admin, crypto.randomUUID())).status).toBe(409);

    // 3) 接続期限切れで Meta の会話を読めない
    db.raw.exec("UPDATE instagram_connections SET expires_at='2000-01-01T00:00:00.000Z'");
    expect((await resolveReply(admin, { key, outcome: 'not_sent' })).status).toBe(409);
    expect(db.raw.prepare('SELECT status FROM instagram_outbound_messages WHERE idempotency_key=?').get(key))
      .toEqual({ status: 'unknown' });
    expect((await sendReply(admin, crypto.randomUUID())).status).toBe(409);
  });

  it('閲覧のみ・担当者では未送信と決められず、再送も解放されない', async () => {
    await seedConnectedDmInbox();
    const key = crypto.randomUUID();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('timeout')));
    expect((await sendReply(member, key)).status).toBe(502);

    const payload = { key, outcome: 'not_sent', reason: 'Instagramアプリで未送信を確認' };
    expect((await resolveReply(viewer, payload)).status).toBe(403);
    expect((await resolveReply(member, payload)).status).toBe(403);
    expect((await resolveReply(hqOperatorMember, payload)).status).toBe(403);

    expect(db.raw.prepare('SELECT status,resolved_by_staff_id FROM instagram_outbound_messages WHERE idempotency_key=?').get(key))
      .toEqual({ status: 'unknown', resolved_by_staff_id: null });
    expect((await sendReply(member, crypto.randomUUID())).status).toBe(409);
  });

  it('会話一覧とメッセージ履歴を照合下限より厳密に古い時刻まで読み切ったときだけ不在と判定する', async () => {
    await seedConnectedDmInbox();
    const key = crypto.randomUUID();
    const createdAt = '2025-05-01T00:00:00.700Z';
    db.raw.prepare(
      `INSERT INTO instagram_outbound_messages
         (idempotency_key,line_account_id,instagram_id,sender_id,staff_id,content,status,created_at)
       VALUES (?,'a1','20','customer','owner-1','在庫がございます','unknown',?)`,
    ).run(key, createdAt);

    // 1) 外側の会話一覧に未確認の次ページがあり取得できない場合は確定しない
    vi.stubGlobal('fetch', vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.searchParams.get('after') === 'conv-page-2') {
        return Response.json({ error: { code: 2 } }, { status: 500 });
      }
      return Response.json({
        data: [],
        paging: { next: 'https://graph.instagram.com/v24.0/20/conversations?after=conv-page-2' },
      });
    }));
    expect((await resolveReply(owner, { key, outcome: 'not_sent' })).status).toBe(502);
    expect((await sendReply(owner, crypto.randomUUID())).status).toBe(409);

    // 2) 1ページ目の末尾が 23:59:59Z（照合下限 23:59:55.700Z より新しい）で次ページに返信がある場合は拒否する
    let messagePageCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/conv-1/messages')) {
        messagePageCalls += 1;
        return Response.json({
          data: [{
            id: 'meta-page2-hit',
            message: '在庫がございます',
            created_time: '2025-04-30T23:59:58+0000',
            from: { id: '20' },
          }],
        });
      }
      return Response.json({
        data: [{
          id: 'conv-1',
          messages: {
            data: [{
              id: 'm-cust-1',
              message: '確認お願いします',
              created_time: '2025-04-30T23:59:59+0000',
              from: { id: 'customer' },
            }],
            paging: { next: 'https://graph.instagram.com/v24.0/conv-1/messages?after=msg-page-2' },
          },
        }],
      });
    }));
    expect((await resolveReply(owner, { key, outcome: 'not_sent' })).status).toBe(200);
    expect(messagePageCalls).toBe(1);
    expect(db.raw.prepare('SELECT status FROM instagram_outbound_messages WHERE idempotency_key=?').get(key)).toEqual({ status: 'sent' });
    db.raw.prepare("UPDATE instagram_outbound_messages SET status='unknown',meta_message_id=NULL WHERE idempotency_key=?").run(key);

    // 3) ページ数が多すぎて照合下限より古い時刻へ到達できない場合は確定しない
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      data: [{
        id: 'conv-1',
        messages: {
          data: [{
            id: 'm-recent',
            message: '最近の会話',
            created_time: '2025-05-01T00:00:00+0000',
            from: { id: 'customer' },
          }],
          paging: { next: 'https://graph.instagram.com/v24.0/conv-1/messages?after=endless' },
        },
      }],
    })));
    expect((await resolveReply(owner, { key, outcome: 'not_sent' })).status).toBe(502);
    expect((await sendReply(owner, crypto.randomUUID())).status).toBe(409);

    // 4) 同一時刻のページ境界（oldestTime === windowStartMs）でも次ページを読み、厳密に古い時刻まで確認してから確定する
    const exactBoundaryKey = crypto.randomUUID();
    db.raw.prepare('UPDATE instagram_outbound_messages SET idempotency_key=?,created_at=? WHERE idempotency_key=?')
      .run(exactBoundaryKey, '2025-05-01T00:00:00.000Z', key);
    let boundaryPage2Fetched = false;
    vi.stubGlobal('fetch', vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.searchParams.get('after') === 'conv-page-2') {
        return Response.json({
          data: [{
            id: 'conv-1',
            messages: {
              data: [{
                id: 'm-boundary',
                message: '境界時刻の受信',
                created_time: '2025-04-30T23:59:55.000Z',
                from: { id: 'customer' },
              }],
              paging: { next: 'https://graph.instagram.com/v24.0/conv-1/messages?after=boundary-page-2' },
            },
          }],
        });
      }
      if (url.pathname.endsWith('/conv-1/messages')) {
        boundaryPage2Fetched = true;
        return Response.json({
          data: [{
            id: 'm-older',
            message: 'さらに古い受信',
            created_time: '2025-04-30T23:59:54.000Z',
            from: { id: 'customer' },
          }],
          paging: { next: 'https://graph.instagram.com/v24.0/conv-1/messages?after=boundary-page-3' },
        });
      }
      return Response.json({
        data: [],
        paging: { next: 'https://graph.instagram.com/v24.0/20/conversations?after=conv-page-2' },
      });
    }));
    expect((await resolveReply(owner, { key: exactBoundaryKey, outcome: 'not_sent' })).status).toBe(200);
    expect(boundaryPage2Fetched).toBe(true);
    expect(db.raw.prepare('SELECT status,resolution_kind FROM instagram_outbound_messages WHERE idempotency_key=?').get(exactBoundaryKey))
      .toEqual({ status: 'not_sent_confirmed', resolution_kind: 'meta_conversation_absent' });
  });

  it('返信の識別子で対象を照合し、識別子で照合できない同文返信は送信済みと決めつけず保留する', async () => {
    await seedConnectedDmInbox();

    // 1) 識別子未取得（meta_message_id = null）で、後から別経路で送られた同文返信（01:00:00Z）がある場合：
    //    「送信済みとして記録してください」とは案内せず、照合不能として自動確定と再送を止める。
    const ambiguousKey = crypto.randomUUID();
    db.raw.prepare(
      `INSERT INTO instagram_outbound_messages
         (idempotency_key,line_account_id,instagram_id,sender_id,staff_id,content,status,created_at)
       VALUES (?,'a1','20','customer','owner-1','ありがとうございます','unknown','2025-05-01T00:00:00.700Z')`,
    ).run(ambiguousKey);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      data: [{
        id: 'conv-1',
        messages: {
          data: [{
            id: 'mid-manual-later',
            message: 'ありがとうございます',
            created_time: '2025-05-01T01:00:00.000Z',
            from: { id: '20' },
          }],
        },
      }],
    })));
    const ambiguousRes = await resolveReply(owner, { key: ambiguousKey, outcome: 'not_sent' });
    expect(ambiguousRes.status).toBe(200);
    const ambiguousBody = await ambiguousRes.json() as { data: { message: string } };
    expect(ambiguousBody.data.message).toContain('送信済み');
    expect(db.raw.prepare('SELECT status FROM instagram_outbound_messages WHERE idempotency_key=?').get(ambiguousKey)).toEqual({ status: 'sent' });
    db.raw.prepare("UPDATE instagram_outbound_messages SET status='unknown',meta_message_id=NULL WHERE idempotency_key=?").run(ambiguousKey);

    // 2) 過去の同文返信（照合下限より前）や、DBの別送信行で meta_message_id が既知の同文返信は対象と取り違えない
    const knownSentKey = crypto.randomUUID();
    db.raw.prepare(
      `INSERT INTO instagram_outbound_messages
         (idempotency_key,line_account_id,instagram_id,sender_id,staff_id,content,status,meta_message_id,created_at,sent_at)
       VALUES (?,'a1','20','customer','owner-1','ありがとうございます','sent','mid-known-sent','2025-05-01T00:10:00.000Z','2025-05-01T00:10:01.000Z')`,
    ).run(knownSentKey);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      data: [{
        id: 'conv-1',
        messages: {
          data: [
            {
              id: 'mid-known-sent',
              message: 'ありがとうございます',
              created_time: '2025-05-01T00:10:01.000Z',
              from: { id: '20' },
            },
            {
              id: 'mid-before-attempt',
              message: 'ありがとうございます',
              created_time: '2025-04-30T23:50:00.000Z',
              from: { id: '20' },
            },
          ],
        },
      }],
    })));
    expect((await resolveReply(owner, { key: ambiguousKey, outcome: 'not_sent' })).status).toBe(200);

    // 3) 対象行に meta_message_id がある場合は識別子の一致だけで厳密に判定する
    const withIdKey = crypto.randomUUID();
    db.raw.prepare(
      `INSERT INTO instagram_outbound_messages
         (idempotency_key,line_account_id,instagram_id,sender_id,staff_id,content,status,meta_message_id,created_at)
       VALUES (?,'a1','20','customer','owner-1','ありがとうございます','unknown','mid-target-exact','2025-05-01T00:20:00.000Z')`,
    ).run(withIdKey);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      data: [{
        id: 'conv-1',
        messages: {
          data: [{
            id: 'mid-target-exact',
            message: 'ありがとうございます',
            created_time: '2025-05-01T00:20:01.000Z',
            from: { id: '20' },
          }],
        },
      }],
    })));
    const exactHit = await resolveReply(owner, { key: withIdKey, outcome: 'not_sent' });
    expect(exactHit.status).toBe(200);
    expect(((await exactHit.json()) as { data: { message: string } }).data.message).toContain('送信済みにしました');
    db.raw.prepare("UPDATE instagram_outbound_messages SET status='unknown' WHERE idempotency_key=?").run(withIdKey);

    // 別IDでも同文があれば、未送信とは確定しない
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      data: [{
        id: 'conv-1',
        messages: {
          data: [{
            id: 'mid-different-id',
            message: 'ありがとうございます',
            created_time: '2025-05-01T00:20:02.000Z',
            from: { id: '20' },
          }],
        },
      }],
    })));
    expect((await resolveReply(owner, { key: withIdKey, outcome: 'not_sent' })).status).toBe(200);
    expect(db.raw.prepare('SELECT status FROM instagram_outbound_messages WHERE idempotency_key=?').get(withIdKey)).toEqual({ status: 'sent' });
  });

  it('Metaの反映待ちの5分間は理由を入力しても未送信を確定できない', async () => {
    await seedConnectedDmInbox();
    const key = crypto.randomUUID();
    db.raw.prepare(`INSERT INTO instagram_outbound_messages
      (idempotency_key,line_account_id,instagram_id,sender_id,staff_id,content,status,created_at)
      VALUES (?,'a1','20','customer','owner-1','返信','unknown',?)`).run(key, new Date().toISOString());
    expect((await resolveReply(owner, { key, outcome: 'not_sent', reason: '確認した' })).status).toBe(409);
  });

  it('理由があってもMetaを照合し改行と前後空白を揃えた同文を送信済みとする', async () => {
    await seedConnectedDmInbox();
    const key = crypto.randomUUID(), at = new Date(Date.now() - 360000).toISOString();
    db.raw.prepare(`INSERT INTO instagram_outbound_messages
      (idempotency_key,line_account_id,instagram_id,sender_id,staff_id,content,status,created_at)
      VALUES (?,'a1','20','customer','owner-1','返信\nです','unknown',?)`).run(key, at);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: [{ messages: { data: [
      { id: 'echo1', message: ' 返信\r\nです ', created_time: at, from: { id: '20' } },
    ] } }] })));
    expect((await resolveReply(owner, { key, outcome: 'not_sent', reason: '確認した' })).status).toBe(200);
    expect(db.raw.prepare('SELECT status,meta_message_id FROM instagram_outbound_messages WHERE idempotency_key=?').get(key))
      .toEqual({ status: 'sent', meta_message_id: 'echo1' });
  });

  it.each(['invalid', 'message-limit', 'conversation-limit'])('照合履歴を読み切れない %s は未送信と確定しない', async kind => {
    await seedConnectedDmInbox();
    const key = crypto.randomUUID(), at = new Date(Date.now() - 360000).toISOString();
    db.raw.prepare(`INSERT INTO instagram_outbound_messages
      (idempotency_key,line_account_id,instagram_id,sender_id,staff_id,content,status,created_at)
      VALUES (?,'a1','20','customer','owner-1','返信','unknown',?)`).run(key, at);
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: URL | RequestInfo) => {
      calls++;
      const next = kind === 'invalid' ? 'https://evil.example/v24.0/messages' : 'https://graph.instagram.com/v24.0/next';
      if (kind === 'conversation-limit') return Response.json({ data: [], paging: { next } });
      const box = { data: [{ id: `m${calls}`, message: '別', created_time: at, from: { id: 'customer' } }], paging: { next } };
      return Response.json(new URL(String(input)).pathname.endsWith('/conversations') ? { data: [{ messages: box }] } : box);
    }));
    expect((await resolveReply(owner, { key, outcome: 'not_sent' })).status).toBe(502);
    expect(db.raw.prepare('SELECT status FROM instagram_outbound_messages WHERE idempotency_key=?').get(key)).toEqual({ status: 'unknown' });
    expect(calls).toBe(kind === 'invalid' ? 1 : 5);
  });

  it('照合中に他の担当者が確定して更新が0件なら成功を返さない', async () => {
    await seedConnectedDmInbox();
    const key = crypto.randomUUID(), at = new Date(Date.now() - 360000).toISOString();
    db.raw.prepare(`INSERT INTO instagram_outbound_messages
      (idempotency_key,line_account_id,instagram_id,sender_id,staff_id,content,status,created_at)
      VALUES (?,'a1','20','customer','owner-1','返信','unknown',?)`).run(key, at);
    vi.stubGlobal('fetch', vi.fn(async () => {
      db.raw.prepare("UPDATE instagram_outbound_messages SET status='sent' WHERE idempotency_key=?").run(key);
      return Response.json({ data: [] });
    }));
    expect((await resolveReply(owner, { key, outcome: 'not_sent' })).status).toBe(409);
  });

  it.each(['pending','unknown','not_sent_confirmed'])('echoで%sの返信を送信済みにして遅れた証拠を残す', async status => {
    await seedConnectedDmInbox();
    const key = crypto.randomUUID(), now = Date.now(), at = new Date(now - 1000).toISOString();
    db.raw.prepare(`INSERT INTO instagram_outbound_messages
      (idempotency_key,line_account_id,instagram_id,sender_id,staff_id,content,status,created_at,resolved_by_staff_id,resolved_at,resolution_kind,resolution_evidence)
      VALUES (?,'a1','20','customer','owner-1','返信',?,?, 'owner-1',?,'reason','確認')`).run(key, status, at, at);
    if (status === 'not_sent_confirmed') {
      db.raw.prepare(`INSERT INTO instagram_outbound_messages
        (idempotency_key,line_account_id,instagram_id,sender_id,staff_id,content,status,created_at,sent_at)
        VALUES (?,'a1','20','customer','owner-1','返信','sent',?,?)`).run(crypto.randomUUID(), new Date(now + 1000).toISOString(), new Date(now + 1000).toISOString());
    }
    const raw = JSON.stringify({ object: 'instagram', entry: [{ id: '20', messaging: [{ sender: { id: '20' }, recipient: { id: 'customer' }, timestamp: now, message: { mid: 'late-mid', text: '返信', is_echo: true } }] }] });
    const cryptoKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(config.META_APP_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signature = Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(raw))), x => x.toString(16).padStart(2,'0')).join('');
    const response = await app().request('/api/instagram/webhook', { method: 'POST', headers: { 'X-Hub-Signature-256': `sha256=${signature}` }, body: raw });
    expect(response.status).toBe(200);
    const row = db.raw.prepare('SELECT status,meta_message_id,resolution_evidence FROM instagram_outbound_messages WHERE idempotency_key=?').get(key) as { status: string; meta_message_id: string; resolution_evidence: string };
    expect(row.status).toBe('sent');
    expect(row.meta_message_id).toBe('late-mid');
    expect(row.resolution_evidence.includes('[echo_after_not_sent]')).toBe(status === 'not_sent_confirmed');
    if (status === 'not_sent_confirmed') {
      const detail = await app().request('/api/instagram/conversations/customer?lineAccountId=a1&instagramId=20');
      expect(((await detail.json()) as {data: {lateEchoNotice: string}}).data.lateEchoNotice).toContain('二重送信');
    }
  });

  it('不明から3分は未送信にできず、画面にも5分経過まで不可を返す', async () => {
    await seedConnectedDmInbox();
    const key = seedOutbound('unknown', new Date(Date.now() - 180000).toISOString());
    const detail = await app().request('/api/instagram/conversations/customer?lineAccountId=a1&instagramId=20');
    const body = await detail.json() as { data: { pendingReply: { canResolveNotSent: boolean; serverNow: string; resolveAt: string } } };
    expect(body.data.pendingReply.canResolveNotSent).toBe(false);
    expect(Date.parse(body.data.pendingReply.resolveAt) - Date.parse(body.data.pendingReply.serverNow)).toBeGreaterThan(100000);
    expect((await resolveReply(owner, { key, outcome: 'not_sent', reason: '確認' })).status).toBe(409);
    db.raw.prepare('UPDATE instagram_outbound_messages SET created_at=? WHERE idempotency_key=?').run(new Date(Date.now() - 360000).toISOString(), key);
    const after = await app().request('/api/instagram/conversations/customer?lineAccountId=a1&instagramId=20');
    expect(((await after.json()) as { data: { pendingReply: { canResolveNotSent: boolean } } }).data.pendingReply.canResolveNotSent).toBe(true);
  });

  it('Metaを読めないとき理由を必須にし理由と失敗の原因を記録する', async () => {
    await seedConnectedDmInbox();
    const key = seedOutbound('unknown', new Date(Date.now() - 360000).toISOString());
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    expect((await resolveReply(owner, { key, outcome: 'not_sent' })).status).toBe(502);
    expect((await resolveReply(member, { key, outcome: 'not_sent', reason: 'アプリで未着を確認' })).status).toBe(403);
    expect((await resolveReply(owner, { key, outcome: 'not_sent', reason: 'アプリで未着を確認' })).status).toBe(200);
    const row = db.raw.prepare('SELECT resolution_kind,resolution_evidence FROM instagram_outbound_messages WHERE idempotency_key=?').get(key) as {resolution_kind: string; resolution_evidence: string};
    expect(row.resolution_kind).toBe('reason');
    expect(JSON.parse(row.resolution_evidence)).toMatchObject({ reason: 'アプリで未着を確認', failure: expect.stringContaining('取得できない') });
  });

  it('想定外の送り主番号は原因を記録して画面で知らせる', async () => {
    await seedConnectedDmInbox();
    const at = new Date(Date.now() - 360000).toISOString();
    const key = seedOutbound('unknown', at);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: [{ messages: { data: [{ id: 'x', message: '返信', created_time: at, from: { id: 'unexpected' } }] } }] })));
    const result = await resolveReply(owner, { key, outcome: 'not_sent' });
    expect(result.status).toBe(502);
    expect(await result.text()).toContain('送り主の番号の形');
    const detail = await app().request('/api/instagram/conversations/customer?lineAccountId=a1&instagramId=20');
    expect(await detail.text()).toContain('送り主の番号の形');
    expect((await resolveReply(owner, { key, outcome: 'not_sent' })).status).toBe(502);
    const evidence = db.raw.prepare('SELECT resolution_evidence FROM instagram_outbound_messages WHERE idempotency_key=?').get(key) as {resolution_evidence:string};
    expect(evidence.resolution_evidence.match(/\[sender_id_mismatch\]/g)).toHaveLength(1);
  });

  it('echoの候補が2件なら更新せず会話に確認を促す', async () => {
    await seedConnectedDmInbox();
    const now = Date.now(), at = new Date(now - 1000).toISOString();
    const first = seedOutbound('not_sent_confirmed', at), second = seedOutbound('unknown', at);
    expect((await postEcho({ time: now })).status).toBe(200);
    expect(db.raw.prepare('SELECT status FROM instagram_outbound_messages WHERE idempotency_key=?').get(first)).toEqual({ status: 'not_sent_confirmed' });
    expect(db.raw.prepare('SELECT status FROM instagram_outbound_messages WHERE idempotency_key=?').get(second)).toEqual({ status: 'unknown' });
    const detail = await app().request('/api/instagram/conversations/customer?lineAccountId=a1&instagramId=20');
    const data = await detail.json() as { data: { reconciliationWarning: string | null } };
    expect(data.data.reconciliationWarning).toContain('候補が複数');
  });

  it.each(['window','sender'])('echoの%sが違えば照合しない', async mode => {
    await seedConnectedDmInbox();
    const now = Date.now(), at = new Date(now - 1000).toISOString(), key = seedOutbound('unknown', at);
    await postEcho({ time: mode === 'window' ? now + 360000 : now, sender: mode === 'sender' ? 'other' : '20' });
    expect(db.raw.prepare('SELECT status FROM instagram_outbound_messages WHERE idempotency_key=?').get(key)).toEqual({ status: 'unknown' });
  });

  it('echoは前後の空白と改行を正規化して照合する', async () => {
    await seedConnectedDmInbox();
    const now = Date.now(), key = seedOutbound('unknown', new Date(now - 1000).toISOString(), '返信\nです');
    await postEcho({ time: now, text: ' 返信\r\nです ' });
    expect(db.raw.prepare('SELECT status FROM instagram_outbound_messages WHERE idempotency_key=?').get(key)).toEqual({ status: 'sent' });
  });

  it('担当者は送信済みの手動確定もできない', async () => {
    await seedConnectedDmInbox();
    const key = seedOutbound('unknown', new Date(Date.now() - 360000).toISOString());
    expect((await resolveReply(member, { key, outcome: 'sent' })).status).toBe(403);
  });

  it('接続の手動確認で既存の店のecho購読を追加し成功を記録する', async () => {
    await seedConnectedDmInbox();
    const attempts: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/refresh_access_token')) return Response.json({ access_token: 'new_token', expires_in: 5184000 });
      if (url.pathname.endsWith('/me/subscribed_apps')) {
        if (init?.method !== 'POST') return Response.json({ data: [{ id: config.META_APP_ID, subscribed_fields: ['messages'] }] });
        attempts.push(url.searchParams.get('subscribed_fields') ?? '');
        return Response.json({ success: true });
      }
      return Response.json({ id: '20', username: 'shop' });
    }));
    const res = await app(owner).request('/api/instagram/refresh?lineAccountId=a1&connectionId=igc-1', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    expect(res.status).toBe(200);
    expect(attempts).toEqual(['messages,message_echoes']);
    const list = await app(owner).request('/api/instagram/connections?lineAccountId=a1');
    expect(((await list.json()) as {data: {connections: Array<{echoSubscription:string}>}}).data.connections[0].echoSubscription).toBe('ready');
  });

  it('DB制約で未送信確定時の根拠種別や確認情報のNULL・空文字を拒否する', () => {
    const insertStmt = db.raw.prepare(
      `INSERT INTO instagram_outbound_messages
         (idempotency_key,line_account_id,instagram_id,sender_id,staff_id,content,status,created_at,resolved_by_staff_id,resolved_at,resolution_kind,resolution_evidence)
       VALUES (?,'a1','20','customer','owner-1','本文','not_sent_confirmed','2025-05-01T00:00:00.000Z',?,?,?,?)`,
    );
    expect(() => insertStmt.run(crypto.randomUUID(), 'owner-1', '2025-05-01T00:05:00.000Z', null, '根拠あり')).toThrow(/CHECK constraint failed/);
    expect(() => insertStmt.run(crypto.randomUUID(), null, '2025-05-01T00:05:00.000Z', 'reason', '根拠あり')).toThrow(/CHECK constraint failed/);
    expect(() => insertStmt.run(crypto.randomUUID(), 'owner-1', null, 'reason', '根拠あり')).toThrow(/CHECK constraint failed/);
    expect(() => insertStmt.run(crypto.randomUUID(), 'owner-1', '2025-05-01T00:05:00.000Z', 'reason', null)).toThrow(/CHECK constraint failed/);
    expect(() => insertStmt.run(crypto.randomUUID(), 'owner-1', '2025-05-01T00:05:00.000Z', 'reason', '   ')).toThrow(/CHECK constraint failed/);
  });
});

describe('Instagram Webhook 1MB 境界のストリーム検査', () => {
  it('Content-Length が 1MB を超えるときは本文を1チャンクも読まず署名検証の前に 413 を返す', async () => {
    const verifySpy = vi.spyOn(instagramService, 'verifyInstagramSignature');
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(1024));
        controller.close();
      },
    }, { highWaterMark: 0 });
    const request = new Request('http://worker.test/api/instagram/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(1048576 + 1),
        'X-Hub-Signature-256': 'sha256=' + '0'.repeat(64),
      },
      body: stream,
      duplex: 'half',
    } as RequestInit);

    const response = await app().fetch(request);
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ success: false, error: 'payload_too_large' });
    expect(pulls).toBe(0);
    expect(verifySpy).not.toHaveBeenCalled();
  });

  it.each([
    ['Content-Length なし', undefined],
    ['Content-Length が偽りの小さい値', '32'],
  ])('%s で本文が 1MB を超えた時点でストリームの読み取りを止めて 413 を返す', async (_label, declaredLength) => {
    const verifySpy = vi.spyOn(instagramService, 'verifyInstagramSignature');
    let pulls = 0;
    let canceled = false;
    const totalChunks = 10;
    const chunkBytes = 256 * 1024; // 4 chunks = 1MB, 5th chunk exceeds 1MB
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(chunkBytes).fill(0x78));
        if (pulls >= totalChunks) controller.close();
      },
      cancel() {
        canceled = true;
      },
    }, { highWaterMark: 0 });
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Hub-Signature-256': 'sha256=' + '0'.repeat(64),
    };
    if (declaredLength !== undefined) headers['Content-Length'] = declaredLength;
    const request = new Request('http://worker.test/api/instagram/webhook', {
      method: 'POST',
      headers,
      body: stream,
      duplex: 'half',
    } as RequestInit);

    const response = await app().fetch(request);
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ success: false, error: 'payload_too_large' });
    expect(pulls).toBe(5);
    expect(pulls).toBeLessThan(totalChunks);
    expect(canceled).toBe(true);
    expect(verifySpy).not.toHaveBeenCalled();
  });
});
