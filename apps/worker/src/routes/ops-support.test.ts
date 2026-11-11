import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createHqSupportRequest, statusForStage } from '@line-crm/db';
import type { Env } from '../worker-env.js';
import type { AuthenticatedStaff } from '../middleware/auth/principal/auth.js';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';

const mail = vi.hoisted(() => ({
  sendPlainMail: vi.fn(async (_env: unknown, _message: { to: string; subject: string; body: string }) => {}),
}));
vi.mock('../services/plain-mail.js', () => ({ sendPlainMail: mail.sendPlainMail }));

const { opsSupport } = await import('./ops-support.js');
const { hqSupport } = await import('./hq-support.js');

/**
 * ★37-6 / 37-6-A / 37-6-B 運営コンソールのお問い合わせ（チケット）。
 * 統括の 36-3 と同じ表を使い、返信が統括の履歴にも載ることまで確かめる。
 */

let testDb: SqliteD1;

function app(staff: AuthenticatedStaff, ai?: { run: (model: string, input: unknown) => Promise<unknown> }) {
  const instance = new Hono<Env>();
  instance.use('*', async (c, next) => {
    c.set('staff', staff);
    return next();
  });
  instance.route('/', opsSupport);
  instance.route('/', hqSupport);
  return { request: (path: string, init?: RequestInit) => instance.request(path, init, environment(ai)) };
}

function environment(ai?: { run: (model: string, input: unknown) => Promise<unknown> }): Env['Bindings'] {
  return {
    DB: testDb.db,
    ADMIN_ORIGIN: 'https://admin.example.com',
    ADMIN_PUBLIC_URL: 'https://admin.example.com',
    WORKER_URL: 'https://api.example.com',
    AI: ai as unknown as Ai,
  } as Env['Bindings'];
}

const master: AuthenticatedStaff = { id: 'master-1', name: '坂本 真人', role: 'owner', readOnly: false, tenantId: null };
const readOnlyMaster: AuthenticatedStaff = { ...master, id: 'master-ro', readOnly: true };
const tenantOwner: AuthenticatedStaff = { id: 'owner-1', name: '山田 太郎', role: 'owner', readOnly: false, tenantId: 'tenant-a' };

function json(body: unknown, method = 'POST') {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

async function seedTicket(subject = '回答フォームからタグが付かない') {
  return createHqSupportRequest(testDb.db, {
    tenantId: 'tenant-a', staffId: 'owner-1', staffName: '山田 太郎', staffEmail: 'yamada@example.com',
    kind: 'bug', subject, body: '設定したタグが友だちに付きません。', lineAccountId: null, attachmentKeys: [],
  });
}

beforeEach(() => {
  testDb = createTestD1();
  mail.sendPlainMail.mockClear();
  testDb.raw.prepare(`INSERT INTO tenants (id, name, status, plan_key, plan_status) VALUES ('tenant-a', '株式会社サンプル', 'active', 'standard', 'active')`).run();
  for (const [id, name, tenant, email] of [
    ['master-1', '坂本 真人', null, null],
    ['master-ro', '閲覧のみ', null, null],
    ['owner-1', '山田 太郎', 'tenant-a', 'yamada@example.com'],
  ] as const) {
    testDb.raw.prepare(`INSERT INTO staff_members (id, name, role, api_key, tenant_id, email) VALUES (?, ?, 'owner', ?, ?, ?)`)
      .run(id, name, `${id}-key`, tenant, email);
  }
  for (const id of ['master-1', 'master-ro']) {
    testDb.raw.prepare(`INSERT INTO platform_admins (staff_id, is_active) VALUES (?, 1)`).run(id);
  }
});

describe('返信テンプレート', () => {
  it('初期フォルダを表示し、作ったフォルダとテンプレートを読み直して引用できる', async () => {
    const initial = await app(master).request('/api/ops/support/templates');
    expect(initial.status).toBe(200);
    const initialBody = await initial.json() as { data: { folders: Array<{ id: string; name: string }>; templates: unknown[] } };
    expect(initialBody.data.folders.map((folder) => folder.name)).toEqual([
      '契約・解約', '使い方・操作', '請求・支払い', 'LINE連携・配信', '不具合・障害', 'その他',
    ]);
    expect(initialBody.data.templates).toEqual([]);

    const createdFolder = await app(master).request('/api/ops/support/template-folders', json({ name: 'キャンペーン対応' }));
    expect(createdFolder.status).toBe(201);
    const folder = (await createdFolder.json() as { data: { id: string } }).data;
    const createdTemplate = await app(master).request('/api/ops/support/templates', json({ folderId: folder.id, title: '確認のご案内', body: 'お問い合わせありがとうございます。' }));
    expect(createdTemplate.status).toBe(201);
    const reopened = await app(master).request('/api/ops/support/templates');
    const catalog = await reopened.json() as { data: { folders: Array<{ id: string }>; templates: Array<{ folderId: string; title: string; body: string }> } };
    expect(catalog.data.folders.some((item) => item.id === folder.id)).toBe(true);
    expect(catalog.data.templates).toContainEqual(expect.objectContaining({ folderId: folder.id, title: '確認のご案内', body: 'お問い合わせありがとうございます。' }));
  });

  it('閲覧のみは作成できず、重複フォルダと不明な保存先を拒否する', async () => {
    expect((await app(readOnlyMaster).request('/api/ops/support/template-folders', json({ name: '追加' }))).status).toBe(403);
    expect((await app(master).request('/api/ops/support/template-folders', json({ name: '契約・解約' }))).status).toBe(409);
    expect((await app(master).request('/api/ops/support/templates', json({ folderId: 'missing', title: '案内', body: '本文' }))).status).toBe(400);
  });
});

describe('チケット番号と一覧', () => {
  it('統括が送った問い合わせに #MB-0001 から番号が付き、運営の一覧に新規として出る', async () => {
    const first = await seedTicket('1件目');
    const second = await seedTicket('2件目');
    expect(first.ticket_no).toBe(1);
    expect(second.ticket_no).toBe(2);
    const res = await app(master).request('/api/ops/support/tickets?stage=new');
    expect(res.status).toBe(200);
    const body = await res.json() as { data: Array<{ ticketLabel: string; stage: string; tenantName: string; staffName: string }>; total: number };
    expect(body.total).toBe(2);
    expect(body.data[0].ticketLabel).toBe('#MB-0002');
    expect(body.data[0]).toMatchObject({ stage: 'new', tenantName: '株式会社サンプル', staffName: '山田 太郎' });
    const summary = await app(master).request('/api/ops/support/summary');
    const s = await summary.json() as { data: { byStage: Record<string, number>; kpis: { untouched: number } } };
    expect(s.data.byStage.new).toBe(2);
    expect(s.data.byStage.all).toBe(2);
    expect(s.data.kpis.untouched).toBe(2);
  });

  it('停止中の契約先から送った問い合わせも運営の一覧へ届く', async () => {
    testDb.raw.prepare(`UPDATE tenants SET status = 'suspended' WHERE id = 'tenant-a'`).run();
    const sent = await app(tenantOwner).request('/api/hq/support/requests', json({
      kind: 'billing',
      subject: '停止中の契約について確認したい',
      body: '復帰の手順を教えてください。',
    }));
    expect(sent.status).toBe(201);

    const listed = await app(master).request('/api/ops/support/tickets?stage=new');
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({
      total: 1,
      data: [expect.objectContaining({ tenantName: '株式会社サンプル', subject: '停止中の契約について確認したい' })],
    });
  });

  it('チケット番号・契約先名・件名で検索できる', async () => {
    const t = await seedTicket('請求書の宛名を変えたい');
    await seedTicket('別の件');
    const byNo = await app(master).request(`/api/ops/support/tickets?q=%23MB-${String(t.ticket_no).padStart(4, '0')}`);
    expect((await byNo.json() as { total: number }).total).toBe(1);
    const bySubject = await app(master).request('/api/ops/support/tickets?q=請求書');
    expect((await bySubject.json() as { total: number }).total).toBe(1);
    const byTenant = await app(master).request('/api/ops/support/tickets?q=サンプル');
    expect((await byTenant.json() as { total: number }).total).toBe(2);
  });

  it('統括のオーナーは運営のチケット API を呼べない', async () => {
    await seedTicket();
    const res = await app(tenantOwner).request('/api/ops/support/tickets');
    expect(res.status).toBe(403);
  });
});

describe('詳細・状態・優先度', () => {
  it('詳細に契約先の状況とやり取りが載り、閲覧が監査に残る', async () => {
    const t = await seedTicket();
    const res = await app(master).request(`/api/ops/support/tickets/${t.id}`);
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { ticket: { ticketLabel: string; tenantPlanKey: string; staffEmailRegistered: boolean }; tenant: { staffCount: number; staffWithLine: number; pastTickets: number }; messages: unknown[]; draft: null; ai: { available: boolean } } };
    expect(body.data.ticket.ticketLabel).toBe('#MB-0001');
    expect(body.data.ticket.tenantPlanKey).toBe('standard');
    expect(body.data.ticket.staffEmailRegistered).toBe(true);
    expect(body.data.tenant).toMatchObject({ staffCount: 1, staffWithLine: 0, pastTickets: 0 });
    expect(body.data.messages).toEqual([]);
    expect(body.data.ai).toBeUndefined();
    const audit = testDb.raw.prepare(`SELECT action, visible_to_tenant FROM platform_audit_logs WHERE tenant_id = 'tenant-a'`).all() as Array<{ action: string; visible_to_tenant: number }>;
    expect(audit).toEqual([{ action: 'ticket.view', visible_to_tenant: 0 }]);
  });

  it('解決済み・クローズにすると統括側の status も closed になり、戻すと open に戻る', async () => {
    const t = await seedTicket();
    const resolved = await app(master).request(`/api/ops/support/tickets/${t.id}`, json({ stage: 'resolved' }, 'PATCH'));
    expect(resolved.status).toBe(200);
    let row = testDb.raw.prepare('SELECT stage, status, resolved_at, closed_at FROM hq_support_requests WHERE id = ?').get(t.id) as Record<string, unknown>;
    expect(row).toMatchObject({ stage: 'resolved', status: 'closed' });
    expect(row.resolved_at).toBeTruthy();
    expect(row.closed_at).toBeNull();
    await app(master).request(`/api/ops/support/tickets/${t.id}`, json({ stage: 'closed' }, 'PATCH'));
    row = testDb.raw.prepare('SELECT stage, status, closed_at FROM hq_support_requests WHERE id = ?').get(t.id) as Record<string, unknown>;
    expect(row).toMatchObject({ stage: 'closed', status: 'closed' });
    expect(row.closed_at).toBeTruthy();
    await app(master).request(`/api/ops/support/tickets/${t.id}`, json({ stage: 'in_progress', priority: 'high' }, 'PATCH'));
    row = testDb.raw.prepare('SELECT stage, status, priority, resolved_at FROM hq_support_requests WHERE id = ?').get(t.id) as Record<string, unknown>;
    expect(row).toMatchObject({ stage: 'in_progress', status: 'open', priority: 'high', resolved_at: null });
    const audit = testDb.raw.prepare(`SELECT COUNT(*) AS n FROM platform_audit_logs WHERE action = 'ticket.stage.change'`).get() as { n: number };
    expect(audit.n).toBe(3);
  });

  it('不正な状態・優先度は 400', async () => {
    const t = await seedTicket();
    const bad = await app(master).request(`/api/ops/support/tickets/${t.id}`, json({ stage: 'done' }, 'PATCH'));
    expect(bad.status).toBe(400);
    const empty = await app(master).request(`/api/ops/support/tickets/${t.id}`, json({}, 'PATCH'));
    expect(empty.status).toBe(400);
  });

  it('読み取り専用の運営マスターは状態を変えられない', async () => {
    const t = await seedTicket();
    const res = await app(readOnlyMaster).request(`/api/ops/support/tickets/${t.id}`, json({ stage: 'closed' }, 'PATCH'));
    expect(res.status).toBe(403);
  });

  it('stage から統括向け status を導く', () => {
    expect(statusForStage('new', false)).toBe('open');
    expect(statusForStage('waiting', true)).toBe('answered');
    expect(statusForStage('resolved', false)).toBe('closed');
    expect(statusForStage('closed', true)).toBe('closed');
  });
});

describe('返信', () => {
  it('返信すると登録メールへ送り、統括の履歴に載り、待ちになる', async () => {
    const t = await seedTicket();
    const res = await app(master).request(`/api/ops/support/tickets/${t.id}/reply`, json({ body: 'ご連絡ありがとうございます。確認します。', aiAssisted: false }));
    expect(res.status).toBe(201);
    const body = await res.json() as { data: { ticket: { stage: string; replyCount: number; firstRepliedAt: string | null }; message: { authorKind: string; deliveredVia: string[] }; mailSent: boolean } };
    expect(body.data.ticket.stage).toBe('waiting');
    expect(body.data.ticket.replyCount).toBe(1);
    expect(body.data.ticket.firstRepliedAt).toBeTruthy();
    expect(body.data.message.authorKind).toBe('ops');
    expect(body.data.message.deliveredVia).toEqual(['screen', 'email']);
    expect(body.data.mailSent).toBe(true);
    expect(mail.sendPlainMail).toHaveBeenCalledTimes(1);
    const sent = mail.sendPlainMail.mock.calls[0][1];
    expect(sent.to).toBe('yamada@example.com');
    expect(sent.subject).toContain('#MB-0001');
    expect(sent.body).toContain('確認します');
    expect(sent.body).toContain('https://admin.example.com/hq/support');

    // 統括側 36-3 の一覧にも同じ返信が載る
    const hq = await app(tenantOwner).request('/api/hq/support/requests');
    expect(hq.status).toBe(200);
    const list = await hq.json() as { data: Array<{ ticketLabel: string; status: string; replies: Array<{ body: string; authorName: string }> }> };
    expect(list.data[0].ticketLabel).toBe('#MB-0001');
    expect(list.data[0].status).toBe('answered');
    expect(list.data[0].replies).toHaveLength(1);
    expect(list.data[0].replies[0].authorName).toBe('坂本 真人');
    const audit = testDb.raw.prepare(`SELECT action, visible_to_tenant FROM platform_audit_logs WHERE action = 'ticket.reply'`).get() as { action: string; visible_to_tenant: number };
    expect(audit.visible_to_tenant).toBe(1);
  });

  it('返信と同時に解決済みにできる。メールが落ちても返信は残る', async () => {
    const t = await seedTicket();
    mail.sendPlainMail.mockRejectedValueOnce(new Error('relay down'));
    const res = await app(master).request(`/api/ops/support/tickets/${t.id}/reply`, json({ body: '直りました。', nextStage: 'resolved' }));
    expect(res.status).toBe(201);
    const body = await res.json() as { data: { ticket: { stage: string }; mailSent: boolean; mailSkippedReason: string | null; message: { deliveredVia: string[] } } };
    expect(body.data.ticket.stage).toBe('resolved');
    expect(body.data.mailSent).toBe(false);
    expect(body.data.mailSkippedReason).toBe('send_failed');
    expect(body.data.message.deliveredVia).toEqual(['screen']);
    const row = testDb.raw.prepare('SELECT status, resolved_at FROM hq_support_requests WHERE id = ?').get(t.id) as { status: string; resolved_at: string | null };
    expect(row.status).toBe('closed');
    expect(row.resolved_at).toBeTruthy();
  });

  it('空の返信は 400、クローズ済みには 409、読み取り専用は 403', async () => {
    const t = await seedTicket();
    expect((await app(master).request(`/api/ops/support/tickets/${t.id}/reply`, json({ body: '  ' }))).status).toBe(400);
    expect((await app(readOnlyMaster).request(`/api/ops/support/tickets/${t.id}/reply`, json({ body: 'x' }))).status).toBe(403);
    await app(master).request(`/api/ops/support/tickets/${t.id}`, json({ stage: 'closed' }, 'PATCH'));
    expect((await app(master).request(`/api/ops/support/tickets/${t.id}/reply`, json({ body: 'x' }))).status).toBe(409);
    expect(mail.sendPlainMail).not.toHaveBeenCalled();
  });
});

describe('下書きと AI', () => {
  it('下書きは保存・上書き・削除でき、返信すると消える', async () => {
    const t = await seedTicket();
    const saved = await app(master).request(`/api/ops/support/tickets/${t.id}/draft`, json({ body: '書きかけ' }, 'PUT'));
    expect(saved.status).toBe(200);
    let detail = await (await app(master).request(`/api/ops/support/tickets/${t.id}`)).json() as { data: { draft: { body: string; aiGenerated: boolean } | null } };
    expect(detail.data.draft).toMatchObject({ body: '書きかけ', aiGenerated: false });
    await app(master).request(`/api/ops/support/tickets/${t.id}/draft`, json({ body: '' }, 'PUT'));
    detail = await (await app(master).request(`/api/ops/support/tickets/${t.id}`)).json() as { data: { draft: null } };
    expect(detail.data.draft).toBeNull();
    await app(master).request(`/api/ops/support/tickets/${t.id}/draft`, json({ body: '送る前' }, 'PUT'));
    await app(master).request(`/api/ops/support/tickets/${t.id}/reply`, json({ body: '送る前' }));
    const row = testDb.raw.prepare('SELECT COUNT(*) AS n FROM hq_support_reply_drafts').get() as { n: number };
    expect(row.n).toBe(0);
  });

  it('AI 下書き API を公開せず、手動返信だけを受け付ける', async () => {
    const ticket = await seedTicket();
    const response = await app(master).request(`/api/ops/support/tickets/${ticket.id}/draft/ai`, json({}));
    expect(response.status).toBe(404);
  });

});

describe('運営が起票する', () => {
  it('契約先と件名・本文が必要。作ると新規・運営が起票として番号が付く', async () => {
    const bad = await app(master).request('/api/ops/support/tickets', json({ subject: 'x', body: 'y' }));
    expect(bad.status).toBe(400);
    const res = await app(master).request('/api/ops/support/tickets', json({ tenantId: 'tenant-a', subject: '電話で受けた相談', body: '配信が届かないとのこと', priority: 'high', staffId: 'owner-1' }));
    expect(res.status).toBe(201);
    const body = await res.json() as { data: { ticketLabel: string; channel: string; priority: string; stage: string; staffName: string } };
    expect(body.data).toMatchObject({ ticketLabel: '#MB-0001', channel: 'ops', priority: 'high', stage: 'new', staffName: '山田 太郎' });
    const audit = testDb.raw.prepare(`SELECT COUNT(*) AS n FROM platform_audit_logs WHERE action = 'ticket.create'`).get() as { n: number };
    expect(audit.n).toBe(1);
  });
});
