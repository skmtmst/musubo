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
      resolution_kind: 'reason',
      resolution_evidence: 'Instagramアプリの受信箱で該当返信が無いことを確認',
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
    const createdAt = new Date().toISOString();
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
    expect((await resolveReply(owner, { key: deliveredKey, outcome: 'not_sent' })).status).toBe(409);
    expect((await sendReply(owner, crypto.randomUUID(), '別の返信')).status).toBe(409);
  });

  it('根拠を示せないとき（理由文がなくMeta側の会話取得も失敗または接続不可）は未送信確定も再送も許さない', async () => {
    await seedConnectedDmInbox();
    const key = crypto.randomUUID();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('timeout')));
    expect((await sendReply(admin, key)).status).toBe(502);

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
