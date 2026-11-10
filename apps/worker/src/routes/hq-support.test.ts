import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../worker-env.js';
import { DEFAULT_TENANT_ID } from '../lib/tenant.js';
import type { AuthenticatedStaff } from '../middleware/auth/principal/auth.js';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';

const mail = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('../services/plain-mail.js', () => ({ sendPlainMail: mail.send }));

const { hqSupport } = await import('./hq-support.js');

let testDb: SqliteD1;
let r2Store: Map<string, { bytes: Uint8Array; contentType: string }>;

const staffOf = (overrides: Partial<AuthenticatedStaff> = {}): AuthenticatedStaff => ({
  id: 'staff-1',
  name: '山田 太郎',
  role: 'admin',
  readOnly: false,
  tenantId: DEFAULT_TENANT_ID,
  ...overrides,
});

function app(staff: AuthenticatedStaff) {
  const instance = new Hono<Env>();
  instance.use('*', async (c, next) => {
    c.set('staff', staff);
    return next();
  });
  instance.route('/', hqSupport);
  return instance;
}

function env(overrides: Partial<Env['Bindings']> = {}): Env['Bindings'] {
  return {
    DB: testDb.db,
    IMAGES: {
      put: vi.fn(async (key: string, value: Uint8Array, opts?: { httpMetadata?: { contentType?: string } }) => {
        r2Store.set(key, { bytes: value, contentType: opts?.httpMetadata?.contentType ?? '' });
      }),
    } as unknown as R2Bucket,
    WORKER_URL: 'https://api.example.com',
    CONTACT_EMAIL: 'ops@example.com',
    ...overrides,
  } as Env['Bindings'];
}

async function call(method: string, path: string, body?: unknown, opts: { staff?: AuthenticatedStaff; env?: Partial<Env['Bindings']> } = {}) {
  return app(opts.staff ?? staffOf()).request(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, env(opts.env));
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const toB64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

const REQUEST = { kind: 'bug', subject: 'バナー生成で文字が崩れる', body: '2枚に1枚は誤字になります。' };

beforeEach(() => {
  testDb = createTestD1();
  r2Store = new Map();
  mail.send.mockReset();
  testDb.raw.prepare("INSERT INTO tenants (id, name) VALUES ('tenant-2', '別の統括')").run();
  testDb.raw.prepare(
    `INSERT INTO staff_members (id, name, email, role, api_key, tenant_id) VALUES ('staff-1', '山田 太郎', 'masato@example.com', 'admin', 'key-1', ?)`,
  ).run(DEFAULT_TENANT_ID);
  testDb.raw.prepare(
    `INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret, is_active, tenant_id)
     VALUES ('account-1', 'channel-1', '然-NEN- TEST', '', '', 1, ?)`,
  ).run(DEFAULT_TENANT_ID);
});

describe('統括からのお問い合わせ', () => {
  it('個別見積もりは申込時のメールアドレスへ確定デザインの控えを送る', async () => {
    testDb.raw.prepare(`INSERT INTO registration_applications
      (id,company_name,contact_name,email,phone,referral_source,status,tenant_id,created_at,updated_at)
      VALUES ('app-quote','サンプル株式会社','担当者','applicant@example.com','0312345678','紹介','activated',?,?,?)`)
      .run(DEFAULT_TENANT_ID, '2026-11-01T00:00:00+09:00', '2026-11-01T00:00:00+09:00');
    const res = await call('POST', '/api/hq/support/requests', {
      kind: 'billing', purpose: 'individual_quote', subject: '個別見積もりのお問い合わせ',
      body: 'LINE 11個以上、友だち2,800人',
    });
    expect(res.status).toBe(201);
    const sent = mail.send.mock.calls.map((call) => call[1] as { to: string; subject: string; body: string; html?: string });
    expect(sent).toHaveLength(2);
    expect(sent[0]?.to).toBe('ops@example.com');
    expect(sent[1]).toMatchObject({ to: 'applicant@example.com',
      subject: '【musubo】お見積もりのお問い合わせを受け付けました' });
    expect(sent[1]?.html).toContain('今後のご案内');
    expect((await call('POST', '/api/hq/support/requests', {
      kind: 'usage', purpose: 'individual_quote', subject: '不正な目的', body: '内容',
    })).status).toBe(400);
    expect((await call('POST', '/api/hq/support/requests', {
      kind: 'billing', purpose: 'individual_quote', subject: '個別見積もりのお問い合わせ', body: '内容',
    }, { staff: staffOf({ role: 'staff' }) })).status).toBe(403);
  });

  it('送ると記録が残り、運営へ知らせ、送信者に控えを送る', async () => {
    const res = await call('POST', '/api/hq/support/requests', { ...REQUEST, lineAccountId: 'account-1' });
    expect(res.status).toBe(201);
    const data = (await res.json<{ data: { id: string; kindLabel: string; notified: boolean; status: string } }>()).data;
    expect(data.kindLabel).toBe('不具合の報告');
    expect(data.notified).toBe(true);
    expect(data.status).toBe('open');

    expect(mail.send).toHaveBeenCalledTimes(2);
    const [operator, copy] = mail.send.mock.calls.map((c) => c[1] as { to: string; subject: string; body: string });
    expect(operator.to).toBe('ops@example.com');
    expect(operator.subject).toContain('不具合の報告');
    expect(operator.body).toContain('関係する店舗: 然-NEN- TEST');
    expect(operator.body).toContain('masato@example.com');
    expect(copy.to).toBe('masato@example.com');
    expect(copy.subject).toContain('受け付けました');

    const list = await call('GET', '/api/hq/support/requests');
    const items = (await list.json<{ data: Array<{ id: string; subject: string }> }>()).data;
    expect(items.map((i) => i.subject)).toEqual(['バナー生成で文字が崩れる']);
  });

  it('SUPPORT_NOTIFY_EMAIL があればそちらへ知らせる', async () => {
    await call('POST', '/api/hq/support/requests', REQUEST, { env: { SUPPORT_NOTIFY_EMAIL: 'support@example.com' } });
    expect((mail.send.mock.calls[0][1] as { to: string }).to).toBe('support@example.com');
  });

  it('メールが送れなくても記録は残り、notified が false になる', async () => {
    mail.send.mockRejectedValue(new Error('smtp down'));
    const res = await call('POST', '/api/hq/support/requests', REQUEST);
    expect(res.status).toBe(201);
    expect((await res.json<{ data: { notified: boolean } }>()).data.notified).toBe(false);
    const list = await call('GET', '/api/hq/support/requests');
    expect((await list.json<{ data: unknown[] }>()).data).toHaveLength(1);
  });

  it.each([
    [{ ...REQUEST, kind: 'spam' }, '種類'],
    [{ ...REQUEST, subject: '' }, '件名'],
    [{ ...REQUEST, body: '  ' }, '本文'],
    [{ ...REQUEST, subject: 'あ'.repeat(101) }, '100文字'],
  ])('足りない・長すぎる入力は理由つきで断る: %o', async (body, fragment) => {
    const res = await call('POST', '/api/hq/support/requests', body);
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toContain(fragment);
    expect(mail.send).not.toHaveBeenCalled();
  });

  it('画像を添付すると R2 に置き、運営への通知に URL が入る', async () => {
    const res = await call('POST', '/api/hq/support/requests', {
      ...REQUEST,
      attachments: [{ mimeType: 'image/png', data: toB64(PNG) }],
    });
    expect(res.status).toBe(201);
    const data = (await res.json<{ data: { attachments: Array<{ key: string; url: string }> } }>()).data;
    expect(data.attachments).toHaveLength(1);
    expect(data.attachments[0].key.startsWith('support/')).toBe(true);
    expect(r2Store.has(data.attachments[0].key)).toBe(true);
    expect((mail.send.mock.calls[0][1] as { body: string }).body).toContain(data.attachments[0].url);
  });

  it('形式の合わない添付や4枚以上は断る', async () => {
    let res = await call('POST', '/api/hq/support/requests', { ...REQUEST, attachments: [{ mimeType: 'image/gif', data: toB64(PNG) }] });
    expect(res.status).toBe(400);
    res = await call('POST', '/api/hq/support/requests', { ...REQUEST, attachments: [{ mimeType: 'image/jpeg', data: toB64(PNG) }] });
    expect(res.status).toBe(400);
    res = await call('POST', '/api/hq/support/requests', { ...REQUEST, attachments: Array(4).fill({ mimeType: 'image/png', data: toB64(PNG) }) });
    expect(res.status).toBe(400);
    expect(r2Store.size).toBe(0);
  });

  it('別の統括の店舗は関係する店舗に選べない', async () => {
    testDb.raw.prepare(
      `INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret, is_active, tenant_id)
       VALUES ('account-other', 'channel-x', 'よその店舗', '', '', 1, 'tenant-2')`,
    ).run();
    const res = await call('POST', '/api/hq/support/requests', { ...REQUEST, lineAccountId: 'account-other' });
    expect(res.status).toBe(404);
  });

  it('別の統括の問い合わせは見えない', async () => {
    await call('POST', '/api/hq/support/requests', REQUEST);
    const res = await call('GET', '/api/hq/support/requests', undefined, { staff: staffOf({ id: 'staff-9', tenantId: 'tenant-2' }) });
    expect((await res.json<{ data: unknown[] }>()).data).toEqual([]);
  });

  it('担当者でも送れる', async () => {
    const res = await call('POST', '/api/hq/support/requests', REQUEST, { staff: staffOf({ role: 'staff' }) });
    expect(res.status).toBe(201);
  });

  it('種類の一覧を返す', async () => {
    const res = await call('GET', '/api/hq/support/kinds');
    const data = (await res.json<{ data: Array<{ key: string; label: string }> }>()).data;
    expect(data.map((k) => k.key)).toEqual(['usage', 'bug', 'billing', 'feature', 'other']);
  });

  it('停止中でも使う問い合わせ専用contextは必要最小限の店舗・送信者・プランを返す', async () => {
    testDb.raw.prepare(`UPDATE tenants SET name = '株式会社サンプル', status = 'suspended', plan_key = 'standard', plan_status = 'active' WHERE id = ?`).run(DEFAULT_TENANT_ID);
    const res = await call('GET', '/api/hq/support/context');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      success: true,
      data: {
        kinds: expect.arrayContaining([expect.objectContaining({ key: 'billing' })]),
        accounts: [{ id: 'account-1', name: '然-NEN- TEST' }],
        sender: {
          tenantName: '株式会社サンプル',
          name: '山田 太郎',
          email: 'masato@example.com',
          planLabel: 'スタンダード',
        },
      },
    });
  });
});

describe('お問い合わせの続き（★36-3-A）', () => {
  async function seed() {
    const created = await call('POST', '/api/hq/support/requests', REQUEST);
    const body = await created.json<{ data: { id: string } }>();
    mail.send.mockReset();
    return body.data.id;
  }

  it('1 件のやり取りを読める。別の統括からは 404', async () => {
    const id = await seed();
    testDb.raw.prepare(`INSERT INTO hq_support_messages (id, request_id, author_kind, author_staff_id, author_name, body, created_at) VALUES ('m1', ?, 'ops', 'master-1', '坂本 真人', '確認します。', '2026-09-15T09:05:00.000+09:00')`).run(id);
    const res = await call('GET', `/api/hq/support/requests/${id}`);
    expect(res.status).toBe(200);
    const body = await res.json<{ data: { ticketLabel: string; stageLabel: string; messages: Array<{ authorKind: string; authorName: string }>; replies: unknown[] } }>();
    expect(body.data.ticketLabel).toBe('#MB-0001');
    expect(body.data.stageLabel).toBe('新規');
    expect(body.data.messages).toEqual([expect.objectContaining({ authorKind: 'ops', authorName: 'musubo 運営 ／ 坂本 真人' })]);
    expect(body.data.replies).toHaveLength(1);
    const other = await call('GET', `/api/hq/support/requests/${id}`, undefined, { staff: staffOf({ id: 'staff-9', tenantId: 'tenant-2' }) });
    expect(other.status).toBe(404);
  });

  it('続きを送ると運営のチケットが対応中へ戻り、運営へ通知、送信者に控えが届く', async () => {
    const id = await seed();
    testDb.raw.prepare(`UPDATE hq_support_requests SET stage = 'closed', status = 'closed', closed_at = '2026-09-15T10:00:00.000+09:00', resolved_at = '2026-09-15T10:00:00.000+09:00' WHERE id = ?`).run(id);
    const res = await call('POST', `/api/hq/support/requests/${id}/messages`, { body: '直りました。ありがとうございます。', attachments: [{ mimeType: 'image/png', data: toB64(PNG) }] });
    expect(res.status).toBe(201);
    const body = await res.json<{ data: { authorKind: string; stage: string; status: string; attachments: Array<{ url: string }> } }>();
    expect(body.data).toMatchObject({ authorKind: 'tenant', stage: 'in_progress', status: 'open' });
    expect(body.data.attachments[0].url).toContain('https://api.example.com/images/support/');
    const row = testDb.raw.prepare('SELECT stage, status, closed_at, resolved_at FROM hq_support_requests WHERE id = ?').get(id) as Record<string, unknown>;
    expect(row).toEqual({ stage: 'in_progress', status: 'open', closed_at: null, resolved_at: null });
    expect(mail.send).toHaveBeenCalledTimes(2);
    const [toOps, toStaff] = mail.send.mock.calls.map((c) => c[1] as { to: string; subject: string; body: string });
    expect(toOps.to).toBe('ops@example.com');
    expect(toOps.subject).toContain('続き #MB-0001');
    expect(toStaff.to).toBe('masato@example.com');
    expect(toStaff.subject).toContain('続きを受け付けました');
    expect(r2Store.size).toBe(1);
  });

  it('空の本文は 400、別の統括の問い合わせには送れない', async () => {
    const id = await seed();
    expect((await call('POST', `/api/hq/support/requests/${id}/messages`, { body: '  ' })).status).toBe(400);
    const other = await call('POST', `/api/hq/support/requests/${id}/messages`, { body: 'x' }, { staff: staffOf({ id: 'staff-9', tenantId: 'tenant-2' }) });
    expect(other.status).toBe(404);
    const n = testDb.raw.prepare('SELECT COUNT(*) AS n FROM hq_support_messages').get() as { n: number };
    expect(n.n).toBe(0);
  });
});
