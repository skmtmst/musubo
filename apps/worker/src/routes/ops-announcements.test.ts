import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../worker-env.js';
import type { AuthenticatedStaff } from '../middleware/auth/principal/auth.js';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';

const mail = vi.hoisted(() => ({ send: vi.fn(async (_env: unknown, _m: { to: string; subject: string; body: string }) => {}) }));
vi.mock('../services/plain-mail.js', () => ({ sendPlainMail: mail.send }));
const noticeConnect = vi.hoisted(() => ({ prepare: vi.fn() }));
const botProfile = vi.hoisted(() => ({ fetch: vi.fn(async () => ({} as { displayName?: string })) }));
vi.mock('../lib/bot-profile.js', () => ({ fetchBotProfile: botProfile.fetch }));
vi.mock('../services/notice-line-connect.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../services/notice-line-connect.js')>(),
  prepareNoticeLineConnection: noticeConnect.prepare,
}));
vi.mock('../lib/step-up.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/step-up.js')>(),
  sensitiveStepUpSatisfied: async () => true,
}));
const line = vi.hoisted(() => ({ pushMessage: vi.fn(async (_to: string, _messages: unknown[]) => ({})), replyMessage: vi.fn(async () => ({})) }));
vi.mock('@line-crm/line-sdk', async () => {
  const actual = await vi.importActual<typeof import('@line-crm/line-sdk')>('@line-crm/line-sdk');
  return { ...actual, LineClient: vi.fn().mockImplementation(function () { return line; }) };
});

const { opsAnnouncements } = await import('./ops-announcements.js');
const { hqNotices } = await import('./hq-notices.js');
const { processDueAnnouncements, tryLinkStaffByCode } = await import('../services/platform-announcements.js');

/**
 * 統括のお知らせ配信と契約者専用 LINE の登録案内を検証する。設計図 ★37-7 と照合する。
 */

let testDb: SqliteD1;

function env(): Env['Bindings'] {
  return { DB: testDb.db, ADMIN_PUBLIC_URL: 'https://admin.example.com', CONTACT_EMAIL: 'ops@example.com', WORKER_PUBLIC_URL: 'https://stg-api.musubo.jp', LINE_CREDENTIAL_ENCRYPTION_KEY: btoa('q'.repeat(32)) } as Env['Bindings'];
}
function app(staff: AuthenticatedStaff) {
  const instance = new Hono<Env>();
  instance.use('*', async (c, next) => { c.set('staff', staff); return next(); });
  instance.route('/', opsAnnouncements);
  instance.route('/', hqNotices);
  return { request: (path: string, init?: RequestInit) => instance.request(path, init, env()) };
}
function json(body: unknown, method = 'POST') {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

const master: AuthenticatedStaff = { id: 'master-1', name: '見本 25', role: 'owner', readOnly: false, tenantId: null };
const ownerA: AuthenticatedStaff = { id: 'owner-a', name: '見本 141', role: 'owner', readOnly: false, tenantId: 'tenant-a' };
const staffB: AuthenticatedStaff = { id: 'staff-b', name: '見本 148', role: 'staff', readOnly: false, tenantId: 'tenant-b' };

beforeEach(() => {
  testDb = createTestD1();
  mail.send.mockReset();
  line.pushMessage.mockReset();
  line.replyMessage.mockReset();
  noticeConnect.prepare.mockReset();
  botProfile.fetch.mockReset();
  botProfile.fetch.mockResolvedValue({});
  testDb.raw.prepare(`INSERT INTO tenants (id, name, status, plan_key, plan_status) VALUES ('tenant-a', '株式会社サンプル', 'active', 'standard', 'active')`).run();
  testDb.raw.prepare(`INSERT INTO tenants (id, name, status, plan_key, plan_status) VALUES ('tenant-b', 'カフェ ムスビ', 'active', 'light', 'trialing')`).run();
  testDb.raw.prepare(`INSERT INTO staff_members (id, name, role, api_key, tenant_id) VALUES ('master-1', '見本 25', 'owner', 'k0', NULL)`).run();
  testDb.raw.prepare(`INSERT INTO platform_admins (staff_id, is_active) VALUES ('master-1', 1)`).run();
  testDb.raw.prepare(`INSERT INTO staff_members (id, name, role, api_key, tenant_id, email) VALUES ('owner-a', '見本 141', 'owner', 'k1', 'tenant-a', 'a@example.com')`).run();
  testDb.raw.prepare(`INSERT INTO staff_members (id, name, role, api_key, tenant_id, email) VALUES ('staff-b', '見本 148', 'staff', 'k2', 'tenant-b', 'b@example.com')`).run();
  // 運営会社（既定の統括）のアカウント = 契約者専用LINE の候補
  testDb.raw.prepare(`INSERT INTO line_accounts (id, name, channel_id, channel_secret, channel_access_token, line_basic_id) VALUES ('ops-oa', 'musubo 運営（契約者専用）', 'c-ops', 's-ops', 't-ops', '@musubo')`).run();
  testDb.raw.prepare(`INSERT INTO line_accounts (id, name, channel_id, channel_secret, channel_access_token, tenant_id) VALUES ('la-a', '店舗A', 'c-a', 's-a', 't-a', 'tenant-a')`).run();
});

describe('契約者専用LINEの設定', () => {
  it('Messaging APIだけで接続した公式アカウントを指定し、正しい友だち追加URLを出す', async () => {
    noticeConnect.prepare.mockResolvedValue({ accessToken: 'fixture-token', profile: { displayName: 'musubo契約者様 問い合わせ/通知', pictureUrl: null, basicId: '@540qlkhn' } });
    const response = await app(master).request('/api/ops/notice-line-account/connect', json({ channelId: '2011579318', channelSecret: 'fixture-secret', basicId: '@540qlkhn' }));
    expect(response.status).toBe(201);
    expect(noticeConnect.prepare).toHaveBeenCalledWith(expect.objectContaining({ webhookUrl: 'https://stg-api.musubo.jp/webhook/2011579318' }));
    const account = testDb.raw.prepare('SELECT login_channel_id, liff_id, line_basic_id FROM line_accounts WHERE channel_id = ?').get('2011579318') as { login_channel_id: string | null; liff_id: string | null; line_basic_id: string };
    expect(account).toMatchObject({ login_channel_id: null, liff_id: null, line_basic_id: '@540qlkhn' });
    const after = await (await app(master).request('/api/ops/notice-line-account')).json() as { data: { current: { addFriendUrl: string } } };
    expect(after.data.current.addFriendUrl).toBe('https://line.me/R/ti/p/@540qlkhn');
  });

  it('運営会社のアカウントだけを候補にし、指定を保存する', async () => {
    const list = await (await app(master).request('/api/ops/notice-line-account')).json() as { data: { currentId: string | null; candidates: Array<{ id: string }> } };
    expect(list.data.currentId).toBeNull();
    expect(list.data.candidates.map((c) => c.id)).toEqual(['ops-oa']);
    const bad = await app(master).request('/api/ops/notice-line-account', json({ lineAccountId: 'la-a' }, 'PUT'));
    expect(bad.status).toBe(400);
    const ok = await app(master).request('/api/ops/notice-line-account', json({ lineAccountId: 'ops-oa' }, 'PUT'));
    expect(ok.status).toBe(200);
    const after = await (await app(master).request('/api/ops/notice-line-account')).json() as { data: { current: { addFriendUrl: string } } };
    expect(after.data.current.addFriendUrl).toBe('https://line.me/R/ti/p/@musubo');
    const forbidden = await app(ownerA).request('/api/ops/notice-line-account');
    expect(forbidden.status).toBe(403);
  });

  it('LINE側で通知専用の表示名を変えた後は、設定画面と登録案内へ新しい名前を返す', async () => {
    await app(master).request('/api/ops/notice-line-account', json({ lineAccountId: 'ops-oa' }, 'PUT'));
    botProfile.fetch.mockResolvedValue({ displayName: 'musubo契約者様 通知専用' });
    const settings = await (await app(master).request('/api/ops/notice-line-account')).json() as { data: { current: { name: string }; candidates: Array<{ id: string; name: string }> } };
    expect(settings.data.current.name).toBe('musubo契約者様 通知専用');
    expect(settings.data.candidates.find((candidate) => candidate.id === 'ops-oa')?.name).toBe('musubo契約者様 通知専用');
    const guide = await (await app(ownerA).request('/api/hq/notices/line-registration')).json() as { data: { accountName: string } };
    expect(guide.data.accountName).toBe('musubo契約者様 通知専用');
  });
});

describe('お知らせ', () => {
  it('宛先の見積もり：すべて／プラン別／契約先を選ぶ', async () => {
    const all = await (await app(master).request('/api/ops/announcements/preview', json({ audienceKind: 'all' }))).json() as { data: { tenants: number; staff: number; lineLinked: number; withEmail: number } };
    expect(all.data).toEqual({ tenants: 2, staff: 2, lineLinked: 0, withEmail: 2 });
    const trial = await (await app(master).request('/api/ops/announcements/preview', json({ audienceKind: 'plan', audiencePlans: ['trial'] }))).json() as { data: { staff: number } };
    expect(trial.data.staff).toBe(1);
    const std = await (await app(master).request('/api/ops/announcements/preview', json({ audienceKind: 'plan', audiencePlans: ['standard'] }))).json() as { data: { staff: number } };
    expect(std.data.staff).toBe(1);
    const picked = await (await app(master).request('/api/ops/announcements/preview', json({ audienceKind: 'tenants', audienceTenantIds: ['tenant-b'] }))).json() as { data: { staff: number } };
    expect(picked.data.staff).toBe(1);
  });

  it('下書き → 今すぐ送る：画面とメールに届き、統括の未読に出て、既読で消える', async () => {
    const draft = await app(master).request('/api/ops/announcements', json({ subject: '9月20日 深夜のメンテナンス', body: '2時〜4時に止まります。', audienceKind: 'all', channels: ['screen', 'email'], mode: 'draft' }));
    expect(draft.status).toBe(201);
    const created = (await draft.json() as { data: { id: string; status: string } }).data;
    expect(created.status).toBe('draft');
    const sent = await app(master).request(`/api/ops/announcements/${created.id}`, json({ subject: '9月20日 深夜のメンテナンス', body: '2時〜4時に止まります。', audienceKind: 'all', channels: ['screen', 'email'], mode: 'send' }, 'PUT'));
    expect(sent.status).toBe(200);
    const body = (await sent.json() as { data: { status: string; recipientsTotal: number; mailSent: number; lineSent: number; screenRead: number; screenTotal: number } }).data;
    expect(body).toMatchObject({ status: 'sent', recipientsTotal: 2, mailSent: 2, lineSent: 0, screenRead: 0, screenTotal: 2 });
    expect(mail.send).toHaveBeenCalledTimes(2);
    expect((mail.send.mock.calls[0][1] as { subject: string }).subject).toContain('9月20日');

    const unread = await (await app(ownerA).request('/api/hq/notices')).json() as { data: Array<{ id: string; subject: string }> };
    expect(unread.data).toEqual([expect.objectContaining({ id: created.id, subject: '9月20日 深夜のメンテナンス' })]);
    const read = await app(ownerA).request(`/api/hq/notices/${created.id}/read`, json({}));
    expect(read.status).toBe(200);
    const after = await (await app(ownerA).request('/api/hq/notices')).json() as { data: unknown[] };
    expect(after.data).toEqual([]);
    const stats = (await (await app(master).request('/api/ops/announcements')).json() as { data: Array<{ id: string; screenRead: number }> }).data.find((a) => a.id === created.id);
    expect(stats?.screenRead).toBe(1);
    // 担当者（staff）の未読は別に数える
    const b = await (await app(staffB).request('/api/hq/notices')).json() as { data: unknown[] };
    expect(b.data).toHaveLength(1);
  });

  it('LINE を含めるには契約者専用LINEの指定が要る。指定後は紐づいた権限者にだけ push する', async () => {
    const blocked = await app(master).request('/api/ops/announcements', json({ subject: 'x', body: 'y', audienceKind: 'all', channels: ['line'], mode: 'send' }));
    expect(blocked.status).toBe(409);
    await app(master).request('/api/ops/notice-line-account', json({ lineAccountId: 'ops-oa' }, 'PUT'));
    testDb.raw.prepare(`INSERT INTO friends (id, line_user_id, display_name, line_account_id) VALUES ('f-a', 'U-a', '山田', 'ops-oa')`).run();
    testDb.raw.prepare(`UPDATE staff_members SET notice_friend_id = 'f-a' WHERE id = 'owner-a'`).run();
    const sent = await app(master).request('/api/ops/announcements', json({ subject: '料金改定のご案内', body: '10月から変わります。', audienceKind: 'all', channels: ['line'], mode: 'send' }));
    expect(sent.status).toBe(201);
    const body = (await sent.json() as { data: { status: string; lineSent: number; recipientsTotal: number } }).data;
    expect(body).toMatchObject({ status: 'sent', lineSent: 1, recipientsTotal: 2 });
    expect(line.pushMessage).toHaveBeenCalledTimes(1);
    expect(line.pushMessage.mock.calls[0][0]).toBe('U-a');
    expect(JSON.stringify(line.pushMessage.mock.calls[0][1])).toContain('料金改定のご案内');
  });

  it('予約は公開日時が要り、cron が時刻を過ぎたものだけを送る', async () => {
    const noDate = await app(master).request('/api/ops/announcements', json({ subject: 'x', body: 'y', audienceKind: 'all', channels: ['screen'], mode: 'schedule' }));
    expect(noDate.status).toBe(400);
    const future = await app(master).request('/api/ops/announcements', json({ subject: '来週', body: 'y', audienceKind: 'all', channels: ['screen'], mode: 'schedule', publishAt: '2099-01-01T10:00:00+09:00' }));
    expect(future.status).toBe(201);
    const past = await app(master).request('/api/ops/announcements', json({ subject: '過去', body: 'y', audienceKind: 'all', channels: ['screen'], mode: 'schedule', publishAt: '2020-01-01T10:00:00+09:00' }));
    expect(past.status).toBe(201);
    const result = await processDueAnnouncements(env(), { now: '2026-09-18T12:00:00.000+09:00' });
    expect(result.sent).toBe(1);
    const rows = testDb.raw.prepare(`SELECT subject, status FROM platform_announcements ORDER BY subject`).all() as Array<{ subject: string; status: string }>;
    expect(rows).toEqual([{ subject: '来週', status: 'scheduled' }, { subject: '過去', status: 'sent' }]);
  });

  it('配信済みは変えられず消せない。読み取り専用の運営マスターは書けない', async () => {
    const sent = await app(master).request('/api/ops/announcements', json({ subject: 'a', body: 'b', audienceKind: 'all', channels: ['screen'], mode: 'send' }));
    const id = (await sent.json() as { data: { id: string } }).data.id;
    expect((await app(master).request(`/api/ops/announcements/${id}`, json({ subject: 'a2', body: 'b', audienceKind: 'all', channels: ['screen'] }, 'PUT'))).status).toBe(409);
    expect((await app(master).request(`/api/ops/announcements/${id}`, { method: 'DELETE' })).status).toBe(409);
    const ro: AuthenticatedStaff = { ...master, id: 'master-ro', readOnly: true };
    testDb.raw.prepare(`INSERT INTO staff_members (id, name, role, api_key, tenant_id) VALUES ('master-ro', '閲覧', 'owner', 'k9', NULL)`).run();
    testDb.raw.prepare(`INSERT INTO platform_admins (staff_id, is_active) VALUES ('master-ro', 1)`).run();
    expect((await app(ro).request('/api/ops/announcements', json({ subject: 'a', body: 'b', audienceKind: 'all', channels: ['screen'] }))).status).toBe(403);
  });
});

describe('契約者専用LINEの登録案内と紐づけ', () => {
  it('未設定なら available=false。設定後は友だち追加 URL と本人の 6 桁コードを返す', async () => {
    const none = await (await app(ownerA).request('/api/hq/notices/line-registration')).json() as { data: { available: boolean } };
    expect(none.data.available).toBe(false);
    await app(master).request('/api/ops/notice-line-account', json({ lineAccountId: 'ops-oa' }, 'PUT'));
    const info = await (await app(ownerA).request('/api/hq/notices/line-registration')).json() as { data: { available: boolean; addFriendUrl: string; code: string; linked: boolean } };
    expect(info.data).toMatchObject({ available: true, addFriendUrl: 'https://line.me/R/ti/p/@musubo', linked: false });
    expect(info.data.code).toMatch(/^\d{6}$/);
    const pendingStatus = await (await app(ownerA).request('/api/hq/notices/line-registration/status')).json() as { data: { linked: boolean } };
    expect(pendingStatus.data.linked).toBe(false);
    expect(botProfile.fetch).toHaveBeenCalledTimes(1);
    const again = await (await app(ownerA).request('/api/hq/notices/line-registration')).json() as { data: { code: string } };
    expect(again.data.code).toBe(info.data.code);

    // LINE で 6 桁を送る → 紐づく（他のアカウントや違うコードは何もしない）
    testDb.raw.prepare(`INSERT INTO friends (id, line_user_id, display_name, line_account_id) VALUES ('f-a', 'U-a', '山田', 'ops-oa')`).run();
    const replies: string[] = [];
    const reply = async (t: string) => { replies.push(t); };
    expect(await tryLinkStaffByCode(env(), { lineAccountId: 'la-a', friendId: 'f-a', text: info.data.code, reply })).toBe(false);
    expect(await tryLinkStaffByCode(env(), { lineAccountId: 'ops-oa', friendId: 'f-a', text: 'こんにちは', reply })).toBe(false);
    expect(await tryLinkStaffByCode(env(), { lineAccountId: 'ops-oa', friendId: 'f-a', text: '000000', reply })).toBe(true);
    expect(replies[0]).toContain('見つからない');
    expect(await tryLinkStaffByCode(env(), { lineAccountId: 'ops-oa', friendId: 'f-a', text: info.data.code, reply })).toBe(true);
    expect(replies[1]).toContain('紐づきました');
    expect(replies[1]).not.toContain(ownerA.name);
    const row = testDb.raw.prepare(`SELECT notice_friend_id FROM staff_members WHERE id = 'owner-a'`).get() as { notice_friend_id: string };
    expect(row.notice_friend_id).toBe('f-a');
    const linked = await (await app(ownerA).request('/api/hq/notices/line-registration')).json() as { data: { linked: boolean; code: string | null } };
    expect(linked.data).toMatchObject({ linked: true, code: null });
    const linkedStatus = await (await app(ownerA).request('/api/hq/notices/line-registration/status')).json() as { data: { linked: boolean } };
    expect(linkedStatus.data.linked).toBe(true);
    expect(botProfile.fetch).toHaveBeenCalledTimes(3);
  });
});
