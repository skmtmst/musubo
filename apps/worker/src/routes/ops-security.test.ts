import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { activatePlatformAdminIfAwaitingTotp, revealPiiForImpersonation, switchImpersonationToWrite } from '@line-crm/db';
import type { Env } from '../worker-env.js';
import { DEFAULT_TENANT_ID } from '../lib/tenant.js';
import type { AuthenticatedStaff } from '../middleware/auth/principal/auth.js';
import { sha256Hex } from '../middleware/auth.js';
import { maskPiiDeep, isForbiddenWhileImpersonating } from '../middleware/impersonation.js';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';

const mail = vi.hoisted(() => ({
  sendPlainMail: vi.fn(async (_env: unknown, _message: { to: string; subject: string; body: string }) => {}),
}));
vi.mock('../services/plain-mail.js', () => ({ sendPlainMail: mail.sendPlainMail }));

const { ops } = await import('./ops.js');
const { opsInvite } = await import('./ops-invite.js');

function publicApp() {
  const instance = new Hono<Env>();
  instance.route('/', opsInvite);
  return instance;
}

/**
 * ★37 運営コンソール。要件 §7 の合格条件のうち、境界と代理ログインの
 * 決まりを D1（sqlite）で確かめる。bootstrap.sql に 405_platform_admins.sql が
 * 入っている必要がある（`pnpm --filter @line-crm/db build`）。
 */

let testDb: SqliteD1;

function app(staff: AuthenticatedStaff) {
  const instance = new Hono<Env>();
  instance.use('*', async (c, next) => {
    c.set('staff', staff);
    return next();
  });
  instance.route('/', ops);
  return instance;
}

function environment(): Env['Bindings'] {
  return { TOTP_ENCRYPTION_KEY: 'fixture-encryption-key-longer-than-thirty-two-characters', DB: testDb.db, ADMIN_ORIGIN: 'https://admin.example.com', ADMIN_PUBLIC_URL: 'https://admin.example.com', WORKER_URL: 'https://admin.example.com' } as Env['Bindings'];
}

const master: AuthenticatedStaff = { id: 'master-1', name: '見本 25', role: 'owner', readOnly: false, tenantId: null };
const tenantOwner: AuthenticatedStaff = { id: 'owner-1', name: '見本 141', role: 'owner', readOnly: false, tenantId: 'tenant-a' };
const readOnlyMaster: AuthenticatedStaff = { ...master, id: 'master-ro', readOnly: true };

it('契約先詳細の4枠は対象組織のアカウントと保存済み値だけを集計し、未取得を0にしない',async()=>{
  testDb.raw.exec("UPDATE tenants SET plan_key='standard' WHERE id='tenant-a';INSERT INTO line_accounts(id,name,channel_id,channel_access_token,channel_secret,tenant_id) VALUES('metrics-a','A','metrics-a','fixture','fixture','tenant-a'),('metrics-z','Z','metrics-z','fixture','fixture','tenant-z');INSERT INTO friends(id,line_user_id,line_account_id) VALUES('metrics-f','Uf','metrics-a'),('metrics-other','Uother','metrics-z');INSERT INTO hq_support_requests(id,tenant_id,kind,subject,body,status) VALUES('metrics-s','tenant-a','usage','質問','本文','open'),('metrics-other','tenant-z','usage','別会社','本文','open')");
  const res=await app(readOnlyMaster).request('/api/ops/tenants/tenant-a',{},environment());expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({data:{metrics:{monthlyListPriceYen:29800,thisMonthBilledYen:null,accountCount:1,activeAccountCount:1,friendCount:1,friendChangeLastMonth:null,supportCount:1,unresolvedSupportCount:1}}});
  expect((await app(tenantOwner).request('/api/ops/tenants/tenant-a',{},environment())).status).toBe(403);
});

function json(body: unknown) {
  return { method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer lh_session:ops-fixture' }, body: JSON.stringify(body) };
}

beforeEach(async () => {
  testDb = createTestD1();
  mail.sendPlainMail.mockClear();
  testDb.raw.prepare(`INSERT INTO tenants (id, name, status) VALUES (?, ?, 'active')`).run('tenant-a', '株式会社サンプル');
  testDb.raw.prepare(`INSERT INTO tenants (id, name, status) VALUES (?, ?, 'archived')`).run('tenant-z', 'テスト法人');
  for (const [id, name, tenant] of [
    ['master-1', '見本 25', null],
    ['master-2', 'Kyohei Yamamoto', null],
    ['master-ro', '閲覧のみ', null],
    ['owner-1', '見本 141', 'tenant-a'],
  ] as const) {
    testDb.raw.prepare(`INSERT INTO staff_members (id, name, role, api_key, tenant_id) VALUES (?, ?, 'owner', ?, ?)`)
      .run(id, name, `${id}-key`, tenant);
  }
  testDb.raw.prepare('INSERT INTO admin_sessions(token_hash,staff_id,expires_at) VALUES (?,?,?)').run(await sha256Hex('ops-fixture'), 'master-1', new Date(Date.now()+3600000).toISOString());
  for (const id of ['master-1', 'master-2', 'master-ro']) {
    testDb.raw.prepare(`INSERT INTO platform_admins (staff_id, is_active) VALUES (?, 1)`).run(id);
  }
});

describe('境界', () => {
  it('統括のオーナーは /api/ops を呼べない（403、データは変わらない）', async () => {
    const res = await app(tenantOwner).request('/api/ops/tenants', {}, environment());
    expect(res.status).toBe(403);
    const patch = await app(tenantOwner).request('/api/ops/tenants/tenant-a/status', {
      ...json({ status: 'suspended', reason: 'テスト', confirmName: '株式会社サンプル' }), method: 'PATCH',
    }, environment());
    expect(patch.status).toBe(403);
    const row = testDb.raw.prepare('SELECT status FROM tenants WHERE id = ?').get('tenant-a') as { status: string };
    expect(row.status).toBe('active');
  });

  it('読み取り専用の運営マスターは書き込み系を呼べない', async () => {
    const res = await app(readOnlyMaster).request('/api/ops/impersonation/start', json({ tenantId: 'tenant-a' }), environment());
    expect(res.status).toBe(403);
  });

  it('運営マスターは契約先一覧を件数どおり読める', async () => {
    const res = await app(master).request('/api/ops/tenants', {}, environment());
    expect(res.status).toBe(200);
    const body = await res.json() as { data: Array<{ id: string }> };
    // bootstrap.sql が入れる既定の統括は除いて数える。
    expect(body.data.map((t) => t.id).filter((id) => id !== DEFAULT_TENANT_ID).sort()).toEqual(['tenant-a', 'tenant-z']);
  });
});

describe('契約先の停止', () => {
  it('名前の確認と理由が無ければ停止できない', async () => {
    const noName = await app(master).request('/api/ops/tenants/tenant-a/status', {
      ...json({ status: 'suspended', reason: '決済失敗が続いたため' }), method: 'PATCH',
    }, environment());
    expect(noName.status).toBe(400);
    const noReason = await app(master).request('/api/ops/tenants/tenant-a/status', {
      ...json({ status: 'suspended', confirmName: '株式会社サンプル' }), method: 'PATCH',
    }, environment());
    expect(noReason.status).toBe(400);
  });

  it('停止すると status が suspended になり、契約先に見える監査が 1 件増える', async () => {
    const res = await app(master).request('/api/ops/tenants/tenant-a/status', {
      ...json({ status: 'suspended', reason: '決済失敗が続いたため', confirmName: '株式会社サンプル' }), method: 'PATCH',
    }, environment());
    expect(res.status).toBe(200);
    const row = testDb.raw.prepare('SELECT status FROM tenants WHERE id = ?').get('tenant-a') as { status: string };
    expect(row.status).toBe('suspended');
    const audit = testDb.raw.prepare(`SELECT COUNT(*) AS c FROM platform_audit_logs WHERE tenant_id = ? AND action = 'tenant.status.change' AND visible_to_tenant = 1`).get('tenant-a') as { c: number };
    expect(audit.c).toBe(1);
  });
});

describe('契約先の機能パック（飲食店機能）', () => {
  it('統括のオーナーは切り替えられない（403、データは変わらない）', async () => {
    const res = await app(tenantOwner).request('/api/ops/tenants/tenant-a/feature-packs', {
      ...json({ featurePacks: ['restaurant'] }), method: 'PATCH',
    }, environment());
    expect(res.status).toBe(403);
    const row = testDb.raw.prepare('SELECT feature_packs FROM tenants WHERE id = ?').get('tenant-a') as { feature_packs: string };
    expect(row.feature_packs).toBe('[]');
  });

  it('読み取り専用の運営マスターは切り替えられない', async () => {
    const res = await app(readOnlyMaster).request('/api/ops/tenants/tenant-a/feature-packs', {
      ...json({ featurePacks: ['restaurant'] }), method: 'PATCH',
    }, environment());
    expect(res.status).toBe(403);
  });

  it('知らないパック名は400で拒否する', async () => {
    const res = await app(master).request('/api/ops/tenants/tenant-a/feature-packs', {
      ...json({ featurePacks: ['unknown-pack'] }), method: 'PATCH',
    }, environment());
    expect(res.status).toBe(400);
  });

  it('存在しない統括は404', async () => {
    const res = await app(master).request('/api/ops/tenants/no-such-tenant/feature-packs', {
      ...json({ featurePacks: ['restaurant'] }), method: 'PATCH',
    }, environment());
    expect(res.status).toBe(404);
  });

  it('オンにすると feature_packs が更新され、契約先に見える監査が1件増える', async () => {
    const res = await app(master).request('/api/ops/tenants/tenant-a/feature-packs', {
      ...json({ featurePacks: ['restaurant'] }), method: 'PATCH',
    }, environment());
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { featurePacks: string[] } };
    expect(body.data.featurePacks).toEqual(['restaurant']);
    const row = testDb.raw.prepare('SELECT feature_packs FROM tenants WHERE id = ?').get('tenant-a') as { feature_packs: string };
    expect(JSON.parse(row.feature_packs)).toEqual(['restaurant']);
    const audit = testDb.raw.prepare(`SELECT COUNT(*) AS c FROM platform_audit_logs WHERE tenant_id = ? AND action = 'tenant.feature_packs.change' AND visible_to_tenant = 1`).get('tenant-a') as { c: number };
    expect(audit.c).toBe(1);
  });

  it('オフに戻すと feature_packs が空配列になる', async () => {
    testDb.raw.prepare(`UPDATE tenants SET feature_packs = ? WHERE id = ?`).run('["restaurant"]', 'tenant-a');
    const res = await app(master).request('/api/ops/tenants/tenant-a/feature-packs', {
      ...json({ featurePacks: [] }), method: 'PATCH',
    }, environment());
    expect(res.status).toBe(200);
    const row = testDb.raw.prepare('SELECT feature_packs FROM tenants WHERE id = ?').get('tenant-a') as { feature_packs: string };
    expect(row.feature_packs).toBe('[]');
  });
});

describe('代理ログイン', () => {
  it('更新直前に終わった代理ログインは変更も個人情報の表示記録も作らない', async () => {
    const first = await app(master).request('/api/ops/impersonation/start', json({ tenantId: 'tenant-a' }), environment());
    const old = await first.json() as { data: { id: string } };
    await app(master).request('/api/ops/impersonation/end', json({}), environment());
    expect(await switchImpersonationToWrite(testDb.db, old.data.id, '問い合わせの確認')).toBe(false);
    expect(await revealPiiForImpersonation(testDb.db, { impersonationSessionId: old.data.id, staffId: master.id, tenantId: 'tenant-a', reason: '問い合わせの確認' })).toBeNull();
    expect((testDb.raw.prepare('SELECT COUNT(*) AS c FROM pii_reveal_logs').get() as { c: number }).c).toBe(0);
  });
  it.each(['/api/ops/impersonation/write', '/api/ops/impersonation/pii-reveal'])('%s は確認時と別の代理ログインを変更しない', async (path) => {
    const first = await app(master).request('/api/ops/impersonation/start', json({ tenantId: 'tenant-a' }), environment());
    const old = await first.json() as { data: { id: string } };
    const second = await app(master).request('/api/ops/impersonation/start', json({ tenantId: 'tenant-a' }), environment());
    const current = await second.json() as { data: { id: string } };
    const conflict = await app(master).request(path, json({ reason: '確認のため調べます', expectedSessionId: old.data.id }), environment());
    expect(conflict.status).toBe(409);
    const row = testDb.raw.prepare('SELECT mode, pii_revealed FROM impersonation_sessions WHERE id = ?').get(current.data.id) as { mode: string; pii_revealed: number };
    expect(row).toEqual({ mode: 'read', pii_revealed: 0 });
    expect((testDb.raw.prepare('SELECT COUNT(*) AS c FROM pii_reveal_logs').get() as { c: number }).c).toBe(0);
    const accepted = await app(master).request(path, json({ reason: '確認のため調べます', expectedSessionId: current.data.id }), environment());
    expect(accepted.status).toBe(200);
  });
  it('既定は閲覧のみで始まり、契約先側の履歴には出ない', async () => {
    const res = await app(master).request('/api/ops/impersonation/start', json({ tenantId: 'tenant-a' }), environment());
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { mode: string; tenantId: string } };
    expect(body.data.mode).toBe('read');
    expect(body.data.tenantId).toBe('tenant-a');
    const visible = testDb.raw.prepare(`SELECT COUNT(*) AS c FROM platform_audit_logs WHERE tenant_id = ? AND visible_to_tenant = 1`).get('tenant-a') as { c: number };
    expect(visible.c).toBe(0);
    const internal = testDb.raw.prepare(`SELECT COUNT(*) AS c FROM platform_audit_logs WHERE tenant_id = ? AND action = 'impersonation.start'`).get('tenant-a') as { c: number };
    expect(internal.c).toBe(1);
  });

  it('アーカイブ済みの契約先には入れない', async () => {
    const res = await app(master).request('/api/ops/impersonation/start', json({ tenantId: 'tenant-z' }), environment());
    expect(res.status).toBe(400);
  });

  it('理由を入れると書き込みに切り替わり、契約先側の履歴に出る', async () => {
    await app(master).request('/api/ops/impersonation/start', json({ tenantId: 'tenant-a' }), environment());
    const noReason = await app(master).request('/api/ops/impersonation/write', json({}), environment());
    expect(noReason.status).toBe(400);
    const res = await app(master).request('/api/ops/impersonation/write', json({ reason: '問い合わせ #2481 のフォーム設定を修正' }), environment());
    expect(res.status).toBe(200);
    const session = testDb.raw.prepare(`SELECT mode, write_reason FROM impersonation_sessions WHERE staff_id = ? AND ended_at IS NULL`).get('master-1') as { mode: string; write_reason: string };
    expect(session.mode).toBe('write');
    expect(session.write_reason).toContain('#2481');
    const visible = testDb.raw.prepare(`SELECT COUNT(*) AS c FROM platform_audit_logs WHERE tenant_id = ? AND action = 'impersonation.write' AND visible_to_tenant = 1`).get('tenant-a') as { c: number };
    expect(visible.c).toBe(1);
  });

  it('個人情報の表示は理由が要り、pii_reveal_logs が 1 件増える', async () => {
    await app(master).request('/api/ops/impersonation/start', json({ tenantId: 'tenant-a' }), environment());
    const res = await app(master).request('/api/ops/impersonation/pii-reveal', json({ reason: '配信が届かない友だちの特定' }), environment());
    expect(res.status).toBe(200);
    const logs = testDb.raw.prepare(`SELECT COUNT(*) AS c FROM pii_reveal_logs WHERE tenant_id = ?`).get('tenant-a') as { c: number };
    expect(logs.c).toBe(1);
    const session = testDb.raw.prepare(`SELECT pii_revealed FROM impersonation_sessions WHERE staff_id = ? AND ended_at IS NULL`).get('master-1') as { pii_revealed: number };
    expect(session.pii_revealed).toBe(1);
  });

  it('終えると ended_at が入り、同時に有効なものは 1 件だけ', async () => {
    await app(master).request('/api/ops/impersonation/start', json({ tenantId: 'tenant-a' }), environment());
    await app(master).request('/api/ops/impersonation/start', json({ tenantId: 'tenant-a' }), environment());
    const active = testDb.raw.prepare(`SELECT COUNT(*) AS c FROM impersonation_sessions WHERE staff_id = ? AND ended_at IS NULL`).get('master-1') as { c: number };
    expect(active.c).toBe(1);
    const end = await app(master).request('/api/ops/impersonation/end', json({}), environment());
    expect(end.status).toBe(200);
    const after = testDb.raw.prepare(`SELECT COUNT(*) AS c FROM impersonation_sessions WHERE staff_id = ? AND ended_at IS NULL`).get('master-1') as { c: number };
    expect(after.c).toBe(0);
  });

  it('契約先から見える履歴は書き込みを伴ったものだけ', async () => {
    await app(master).request('/api/ops/impersonation/start', json({ tenantId: 'tenant-a' }), environment());
    await app(master).request('/api/ops/impersonation/write', json({ reason: 'フォーム設定の修正' }), environment());
    const res = await app(tenantOwner).request('/api/hq/operator-history', {}, environment());
    expect(res.status).toBe(200);
    const body = await res.json() as { data: Array<{ action: string }> };
    expect(body.data.map((r) => r.action)).toEqual(['impersonation.write']);
  });
});

describe('運営メンバー', () => {
  it('自分自身は加えられない。別の統括の権限者もメール招待では加えられない', async () => {
    const self = await app(master).request('/api/ops/members', json({ staffId: 'master-1' }), environment());
    expect(self.status).toBe(400);
    testDb.raw.prepare(`UPDATE staff_members SET email = 'yamada@tenant-a.example' WHERE id = 'owner-1'`).run();
    const other = await app(master).request('/api/ops/members', json({ email: 'yamada@tenant-a.example' }), environment());
    expect(other.status).toBe(409);
    expect(mail.sendPlainMail).not.toHaveBeenCalled();
  });

  it('新しいメールを招待すると、運営会社の権限者が作られ招待メールが届く。2要素認証が終わるまで運営マスターではない', async () => {
    const invited = await app(master).request('/api/ops/members', json({ email: 'Hanako@Example.com' }), environment());
    expect(invited.status).toBe(201);
    const body = await invited.json() as { data: { staffId: string; activationState: string } };
    expect(body.data.activationState).toBe('invited');
    expect(mail.sendPlainMail).toHaveBeenCalledTimes(1);
    const message = mail.sendPlainMail.mock.calls[0]![1] as { to: string; subject: string; body: string };
    expect(message.to).toBe('hanako@example.com');
    expect(message.subject).toBe('【musubo】運営コンソールへの招待');
    const token = message.body.match(/#invite=([^\s]+)/)?.[1] ?? '';
    expect(token.length).toBeGreaterThan(20);

    const staffRow = testDb.raw.prepare('SELECT tenant_id, role, is_active, invite_status FROM staff_members WHERE id = ?').get(body.data.staffId) as { tenant_id: string; role: string; is_active: number; invite_status: string };
    expect(staffRow).toEqual({ tenant_id: DEFAULT_TENANT_ID, role: 'staff', is_active: 0, invite_status: 'pending_email' });
    const admin = testDb.raw.prepare('SELECT activation_state, invited_by FROM platform_admins WHERE staff_id = ?').get(body.data.staffId) as { activation_state: string; invited_by: string };
    expect(admin).toEqual({ activation_state: 'invited', invited_by: 'master-1' });

    // 招待中の人は運営マスターではない（/api/ops/me は 403）
    const pending: AuthenticatedStaff = { id: body.data.staffId, name: 'hanako', role: 'staff', tenantId: DEFAULT_TENANT_ID, readOnly: false };
    expect((await app(pending).request('/api/ops/me', {}, environment())).status).toBe(403);

    // 一覧には招待中として出る
    const list = await app(master).request('/api/ops/members', {}, environment());
    const listed = (await list.json() as { data: Array<{ staffId: string; isActive: boolean; activationState: string }>; summary: { members: number; invited: number } });
    expect(listed.data.find((m) => m.staffId === body.data.staffId)).toMatchObject({ isActive: true, activationState: 'invited' });
    expect(listed.summary).toMatchObject({ members: 3, invited: 1 });

    // 招待を受ける（名前とパスワードを設定）→ 2要素認証待ち
    const check = await publicApp().request(`/api/auth/ops-invite/check?token=${encodeURIComponent(token)}`, {}, environment());
    expect(check.status).toBe(200);
    expect((await check.json() as { data: { needsPassword: boolean; email: string } }).data).toMatchObject({ needsPassword: true, email: 'hanako@example.com' });
    const accepted = await publicApp().request('/api/auth/ops-invite/accept', json({ token, name: '見本 143', password: 'Str0ng-Passw0rd!' }), environment());
    expect(accepted.status, await accepted.clone().text()).toBe(200);
    const acceptance = await accepted.json() as { data: { next: string; challengeToken: string } };
    expect(acceptance.data.next).toBe('two-factor-setup');
    expect(acceptance.data.challengeToken).toBeTruthy();
    expect(accepted.headers.get('set-cookie')).toBeNull();
    const afterAccept = testDb.raw.prepare('SELECT activation_state FROM platform_admins WHERE staff_id = ?').get(body.data.staffId) as { activation_state: string };
    expect(afterAccept.activation_state).toBe('awaiting_totp');
    expect((await app(pending).request('/api/ops/me', {}, environment())).status).toBe(403);
    // 同じリンクは二度使えない
    expect((await publicApp().request('/api/auth/ops-invite/accept', json({ token, name: 'x', password: 'Str0ng-Passw0rd!' }), environment())).status).toBe(410);

    // 2要素認証の登録が終わると運営マスターになる
    expect(await activatePlatformAdminIfAwaitingTotp(testDb.db, body.data.staffId)).toBe(true);
    expect((await app(pending).request('/api/ops/me', {}, environment())).status).toBe(200);
  });

  it('招待中の人には招待メールを送り直せる。登録完了の人には送れない', async () => {
    const invited = await app(master).request('/api/ops/members', json({ email: 'taro@example.com' }), environment());
    const { data } = await invited.json() as { data: { staffId: string } };
    const resent = await app(master).request(`/api/ops/members/${data.staffId}/resend-invite`, json({}), environment());
    expect(resent.status).toBe(200);
    expect(mail.sendPlainMail).toHaveBeenCalledTimes(2);
    const first = (mail.sendPlainMail.mock.calls[0]![1] as { body: string }).body.match(/#invite=([^\s]+)/)?.[1] ?? '';
    // 前のリンクは失効
    expect((await publicApp().request(`/api/auth/ops-invite/check?token=${encodeURIComponent(first)}`, {}, environment())).status).toBe(410);
    testDb.raw.prepare(`UPDATE staff_members SET email = 'kyohei@example.com' WHERE id = 'master-2'`).run();
    const done = await app(master).request('/api/ops/members/master-2/resend-invite', json({}), environment());
    expect(done.status).toBe(400);
  });

  it('platform_admins が空のときだけ、互換で入った既定の統括のオーナーが自分を最初の 1 人として登録できる', async () => {
    testDb.raw.prepare('DELETE FROM platform_admins').run();
    testDb.raw.prepare(`INSERT INTO staff_members (id, name, role, api_key, tenant_id) VALUES (?, ?, 'owner', ?, ?)`)
      .run('legacy-owner', '既定の統括のオーナー', 'legacy-owner-key', DEFAULT_TENANT_ID);
    const legacy: AuthenticatedStaff = { id: 'legacy-owner', name: '既定の統括のオーナー', role: 'owner', tenantId: DEFAULT_TENANT_ID, readOnly: false };
    const first = await app(legacy).request('/api/ops/members', json({ staffId: 'legacy-owner' }), environment());
    expect(first.status).toBe(201);
    const row = testDb.raw.prepare('SELECT approved_by FROM platform_admins WHERE staff_id = ?').get('legacy-owner') as { approved_by: string | null };
    expect(row.approved_by).toBeNull();
    // 1 人登録されたあとは、自分を加える口は閉じる
    const again = await app(legacy).request('/api/ops/members', json({ staffId: 'legacy-owner' }), environment());
    expect(again.status).toBe(400);
    // 互換判定も消える: 別の既定の統括のオーナーは入れない
    testDb.raw.prepare(`INSERT INTO staff_members (id, name, role, api_key, tenant_id) VALUES (?, ?, 'owner', ?, ?)`)
      .run('legacy-owner-2', '別のオーナー', 'legacy-owner-2-key', DEFAULT_TENANT_ID);
    const other: AuthenticatedStaff = { id: 'legacy-owner-2', name: '別のオーナー', role: 'owner', tenantId: DEFAULT_TENANT_ID, readOnly: false };
    const denied = await app(other).request('/api/ops/me', {}, environment());
    expect(denied.status).toBe(403);
  });

  it('最後の運営メンバーは停止できない', async () => {
    testDb.raw.prepare(`UPDATE platform_admins SET is_active = 0 WHERE staff_id IN ('master-2', 'master-ro')`).run();
    const res = await app(master).request('/api/ops/members/master-2', { ...json({ isActive: false }), method: 'PATCH' }, environment());
    expect(res.status).toBe(400);
  });
});

describe('伏せ字と禁止操作', () => {
  it('氏名・連絡先・本文を伏せ、構造は変えない', () => {
    const masked = maskPiiDeep({
      success: true,
      data: [{ id: 'friend-1041', display_name: '見本 141', picture_url: 'https://x/y.png', last_message: 'こんにちは', tags: [{ id: 't1', name: 'VIP' }] }],
    }) as { data: Array<{ display_name: string; picture_url: string; last_message: string; tags: Array<{ name: string }> }> };
    expect(masked.data[0].display_name).toBe('友だち#1041');
    expect(masked.data[0].picture_url).toBe('');
    expect(masked.data[0].last_message).not.toContain('こんにちは');
    expect(masked.data[0].tags[0].name).toBe('VIP');
  });

  it('解約・権限者の削除・LINE アカウントの削除は代理ログイン中に止まる', () => {
    expect(isForbiddenWhileImpersonating('DELETE', '/api/staff/abc')).toBe(true);
    expect(isForbiddenWhileImpersonating('DELETE', '/api/line-accounts/abc')).toBe(true);
    expect(isForbiddenWhileImpersonating('POST', '/api/hq/billing/portal')).toBe(true);
    expect(isForbiddenWhileImpersonating('GET', '/api/staff')).toBe(false);
    expect(isForbiddenWhileImpersonating('PATCH', '/api/tags/abc')).toBe(false);
  });
});

describe('一覧の集計（監査 R153）', () => {
  it('「契約中」は請求状態だけで数える。請求解約・課金対象外は入れない', async () => {
    // tenant-a（active・既定 exempt）→ 契約中に数えない
    // tenant-z（archived・exempt）→ 契約中に数えない
    testDb.raw.prepare(`UPDATE tenants SET plan_status = 'active' WHERE id = 'tenant-a'`).run();
    testDb.raw.prepare(`INSERT INTO tenants (id, name, status, plan_status) VALUES ('t-pd', '決済失敗の会社', 'active', 'past_due')`).run();
    testDb.raw.prepare(`INSERT INTO tenants (id, name, status, plan_status) VALUES ('t-cn', '請求解約の会社', 'active', 'canceled')`).run();
    testDb.raw.prepare(`INSERT INTO tenants (id, name, status, plan_status) VALUES ('t-tr', 'トライアルの会社', 'active', 'trialing')`).run();
    testDb.raw.prepare(`INSERT INTO tenants (id, name, status, plan_status) VALUES ('t-ex', '課金対象外の会社', 'active', 'exempt')`).run();
    const res = await app(master).request('/api/ops/tenants', {}, environment());
    expect(res.status).toBe(200);
    const body = await res.json() as { summary: { active: number; trialing: number; suspended: number; pastDue: number } };
    // 契約中＝請求が生きているもの（active＋past_due）：tenant-a と t-pd の 2 社。
    // 請求解約・課金対象外・トライアルは含めない。
    expect(body.summary).toEqual({ active: 2, trialing: 1, suspended: 0, pastDue: 1 });
  });
});


afterEach(() => vi.useRealTimers());
it.each(['2026-09-30T15:00:00Z', '2026-09-30T23:59:59Z'])('日本時間の月初に前月の代理ログインを今月へ含めない: %s', async (at) => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(at));
  for (const [id, started] of [['prev', '2026-09-30T23:59:59.000+09:00'], ['current', '2026-10-01T00:00:00.000+09:00']]) {
    testDb.raw.prepare("INSERT INTO impersonation_sessions(id,staff_id,tenant_id,mode,started_at,ended_at) VALUES(?,'master-1','tenant-a','read',?,?)").run(id, started, started);
  }
  const res = await app(master).request('/api/ops/members', {}, environment());
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ summary: { impersonationsThisMonth: 1 } });
});
