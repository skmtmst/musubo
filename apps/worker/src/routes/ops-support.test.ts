import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createHqSupportRequest, addSupportTenantMessage, statusForStage } from '@line-crm/db';
import type { Env } from '../worker-env.js';
import type { AuthenticatedStaff } from '../middleware/auth/principal/auth.js';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';

const mail = vi.hoisted(() => ({
  sendPlainMail: vi.fn(async (_env: unknown, _message: { to: string; subject: string; body: string }) => {}),
}));
vi.mock('../services/plain-mail.js', () => ({ sendPlainMail: mail.sendPlainMail }));

const { opsSupport, buildDraftPrompt } = await import('./ops-support.js');
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

const master: AuthenticatedStaff = { id: 'master-1', name: '見本 25', role: 'owner', readOnly: false, tenantId: null };
const readOnlyMaster: AuthenticatedStaff = { ...master, id: 'master-ro', readOnly: true };
const tenantOwner: AuthenticatedStaff = { id: 'owner-1', name: '見本 141', role: 'owner', readOnly: false, tenantId: 'tenant-a' };

function json(body: unknown, method = 'POST') {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

async function seedTicket(subject = '回答フォームからタグが付かない') {
  return createHqSupportRequest(testDb.db, {
    tenantId: 'tenant-a', staffId: 'owner-1', staffName: '見本 141', staffEmail: 'yamada@example.com',
    kind: 'bug', subject, body: '設定したタグが友だちに付きません。', lineAccountId: null, attachmentKeys: [],
  });
}

beforeEach(() => {
  testDb = createTestD1();
  mail.sendPlainMail.mockClear();
  testDb.raw.prepare(`INSERT INTO tenants (id, name, status, plan_key, plan_status) VALUES ('tenant-a', '株式会社サンプル', 'active', 'standard', 'active')`).run();
  for (const [id, name, tenant, email] of [
    ['master-1', '見本 25', null, null],
    ['master-ro', '閲覧のみ', null, null],
    ['owner-1', '見本 141', 'tenant-a', 'yamada@example.com'],
  ] as const) {
    testDb.raw.prepare(`INSERT INTO staff_members (id, name, role, api_key, tenant_id, email) VALUES (?, ?, 'owner', ?, ?, ?)`)
      .run(id, name, `${id}-key`, tenant, email);
  }
  for (const id of ['master-1', 'master-ro']) {
    testDb.raw.prepare(`INSERT INTO platform_admins (staff_id, is_active) VALUES (?, 1)`).run(id);
  }
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
    expect(body.data[0]).toMatchObject({ stage: 'new', tenantName: '株式会社サンプル', staffName: '見本 141' });
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
    expect(body.data.ai.available).toBe(false);
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
    expect(list.data[0].replies[0].authorName).toBe('見本 25');
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

  it('AI が未設定なら 503。設定済みなら Workers AI の結果が下書きに入る', async () => {
    const t = await seedTicket();
    const none = await app(master).request(`/api/ops/support/tickets/${t.id}/draft/ai`, json({}));
    expect(none.status).toBe(503);
    const run = vi.fn(async (_model: string, _input: unknown) => ({ response: '見本さま\nご連絡ありがとうございます。' }));
    const res = await app(master, { run }).request(`/api/ops/support/tickets/${t.id}/draft/ai`, json({}));
    expect(res.status).toBe(201);
    const body = await res.json() as { data: { body: string; aiGenerated: boolean; generatedAt: string | null } };
    expect(body.data.aiGenerated).toBe(true);
    expect(body.data.body).toContain('[匿名]さま');
    expect(body.data.generatedAt).toBeTruthy();
    expect(run).toHaveBeenCalledWith('@cf/meta/llama-3.3-70b-instruct-fp8-fast', expect.objectContaining({ messages: expect.any(Array), max_tokens: 900 }));
    const input = run.mock.calls[0][1] as { messages: Array<{ role: string; content: string }> };
    // 個人のメールアドレスは AI に渡さない
    expect(input.messages.map((m) => m.content).join('\n')).not.toContain('yamada@example.com');
    expect(input.messages.map((m) => m.content).join('\n')).not.toContain('見本');
    expect(input.messages.map((m) => m.content).join('\n')).not.toContain('株式会社サンプル');
  });

  it('AI が時間内に返らなければ 504 で、下書きは作られない', async () => {
    vi.useFakeTimers();
    try {
      const t = await seedTicket();
      const run = vi.fn(() => new Promise<unknown>(() => {}));
      const pending = app(master, { run }).request(`/api/ops/support/tickets/${t.id}/draft/ai`, json({}));
      await vi.advanceTimersByTimeAsync(46_000);
      const res = await pending;
      expect(res.status).toBe(504);
      expect((await res.json() as { error: string }).error).toContain('45 秒');
    } finally {
      vi.useRealTimers();
    }
  });
  it('最新の追加説明から根拠を探し、個別回答を生成する。除外しても記事は他の問い合わせに残る', async () => {
    const source = await seedTicket('過去に解決した請求書の問い合わせ');
    testDb.raw.prepare("UPDATE hq_support_requests SET stage = 'resolved' WHERE id = ?").run(source.id);
    const exampleSource = await seedTicket('過去の回答例');
    testDb.raw.prepare("UPDATE hq_support_requests SET stage = 'resolved' WHERE id = ?").run(exampleSource.id);
    testDb.raw.prepare(`INSERT INTO platform_knowledge_articles (id,source_request_id,source_revision,title,question,answer,kind,article_kind,review_state,status,created_at,updated_at)
      VALUES ('billing-evidence',?,0,'請求書の再発行','請求書','承認済みの対応根拠','billing','verified','approved','active','2026-09-21','2026-09-21')`).run(source.id);
    testDb.raw.prepare(`INSERT INTO platform_knowledge_articles (id,source_request_id,source_revision,title,question,answer,kind,article_kind,review_state,status,created_at,updated_at)
      VALUES ('billing-example',?,0,'請求書の再発行','請求書','未確認の回答例','billing','answer_example','approved','active','2026-09-21','2026-09-21')`).run(exampleSource.id);
    const t = await seedTicket('画面がうまく使えない');
    await addSupportTenantMessage(testDb.db, { requestId: t.id, staffId: 'owner-1', staffName: '見本 141', body: '説明を訂正します。請求書の再発行です。再ログインは実施済みです。', attachmentKeys: [] });
    const run = vi.fn(async () => ({ response: '状況を確認するため追加の情報をお願いします。' }));
    const res = await app(master, { run }).request(`/api/ops/support/tickets/${t.id}/draft/ai`, json({}));
    expect(res.status).toBe(201);
    expect((await res.json() as { data: { references: { id: string; articleKind: string }[] } }).data.references).toEqual([
      expect.objectContaining({ id: 'billing-evidence', articleKind: 'verified' }),
      expect.objectContaining({ id: 'billing-example', articleKind: 'answer_example' }),
    ]);
    const call = run.mock.calls[0] as unknown as [string, { messages: { role: string; content: string }[] }];
    expect(call[1].messages[1].content).toContain('再ログインは実施済み');
    expect(call[1].messages[1].content).toContain('承認済みの対応根拠');
    expect(call[1].messages[0].content).toContain('記事の回答文を転用せず');
    expect(call[1].messages[0].content).toContain('実施済みの操作を理由なく繰り返し勧めない');
    expect(call[1].messages[0].content).toContain('使える根拠がない場合');
    expect(call[1].messages[0].content).toContain('回答例は運営の回答内容の参考であり、解決の実績ではない');
    expect(call[1].messages[1].content).toContain('解決確認済み');
    expect(call[1].messages[1].content).toContain('回答例（お客様の確認なし）');
    const excluded = await app(master, { run }).request(`/api/ops/support/tickets/${t.id}/draft/ai`, json({ excludeArticleIds: ['billing-evidence'] }));
    expect((await excluded.json() as { data: { references: { id: string }[] } }).data.references)
      .toEqual([expect.objectContaining({ id: 'billing-example' })]);
    expect(JSON.stringify(run.mock.calls[1])).not.toContain('承認済みの対応根拠');
    expect(testDb.raw.prepare('SELECT status FROM platform_knowledge_articles WHERE id = ?').get('billing-evidence')).toEqual({ status: 'active' });
    expect(mail.sendPlainMail).not.toHaveBeenCalled();
  });

  it('AI が失敗したら 502 で、下書きは作られない', async () => {
    const t = await seedTicket();
    const run = vi.fn(async () => { throw new Error('model unavailable'); });
    const res = await app(master, { run }).request(`/api/ops/support/tickets/${t.id}/draft/ai`, json({}));
    expect(res.status).toBe(502);
    const row = testDb.raw.prepare('SELECT COUNT(*) AS n FROM hq_support_reply_drafts').get() as { n: number };
    expect(row.n).toBe(0);
  });

  it('AI へ渡す材料にはやり取りと担当者名が入り、署名の指示がある', () => {
    const prompt = buildDraftPrompt({
      ticket: { ticketLabel: '#MB-0312', subject: '件名', body: '本文', kindLabel: '不具合', staffName: '見本 141', staffRole: 'オーナー', tenantName: '株式会社サンプル', planLabel: 'スタンダード' },
      messages: [{ authorKind: 'ops', authorName: '見本 25', body: '確認します。' }],
      opsName: '見本 25',
    });
    expect(prompt.user).toContain('#MB-0312');
    expect(prompt.user).toContain('musubo 運営 ／ 見本 25');
    expect(prompt.system).toContain('署名');
  });
});

describe('運営が起票する', () => {
  it('契約先と件名・本文が必要。作ると新規・運営が起票として番号が付く', async () => {
    const bad = await app(master).request('/api/ops/support/tickets', json({ subject: 'x', body: 'y' }));
    expect(bad.status).toBe(400);
    const res = await app(master).request('/api/ops/support/tickets', json({ tenantId: 'tenant-a', subject: '電話で受けた相談', body: '配信が届かないとのこと', priority: 'high', staffId: 'owner-1' }));
    expect(res.status).toBe(201);
    const body = await res.json() as { data: { ticketLabel: string; channel: string; priority: string; stage: string; staffName: string } };
    expect(body.data).toMatchObject({ ticketLabel: '#MB-0001', channel: 'ops', priority: 'high', stage: 'new', staffName: '見本 141' });
    const audit = testDb.raw.prepare(`SELECT COUNT(*) AS n FROM platform_audit_logs WHERE action = 'ticket.create'`).get() as { n: number };
    expect(audit.n).toBe(1);
  });
});
