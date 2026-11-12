import { parseOffsetPaging, buildOffsetListResponse } from '../lib/list-paging.js';
import { jstCalendar as japanCalendar } from '@line-crm/shared';
import { logger } from '@line-crm/shared/server';
import { inputError, inputJsonBoundary } from '../lib/input-errors.js';
import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  addSupportReply,
  countSupportTicketsByStage,
  countRepliesForRequests,
  createSupportReplyTemplate,
  createSupportTemplateFolder,
  createSupportTicketByOps,
  deleteSupportReplyTemplate,
  deleteSupportReplyDraft,
  formatTicketNo,
  getSupportReplyDraft,
  getSupportTicket,
  HQ_SUPPORT_KINDS,
  listSupportMessages,
  listSupportTemplateCatalog,
  listSupportTickets,
  recordPlatformAudit,
  saveSupportReplyDraft,
  SUPPORT_CHANNEL_LABELS,
  SUPPORT_PRIORITIES,
  SUPPORT_PRIORITY_LABELS,
  SUPPORT_STAGE_LABELS,
  SUPPORT_STAGES,
  supportTenantContext,
  supportTicketKpis,
  updateSupportTicket,
  updateSupportReplyTemplate,
  type HqSupportKind,
  type SupportMessage,
  type SupportPriority,
  type SupportStage,
  type SupportTicketRow,
} from '@line-crm/db';


import type { Env } from '../worker-env.js';
import { requirePlatformAdmin, requirePlatformAdminWrite } from '../middleware/platform-admin.js';
import { clientIp } from '../services/admin-session.js';
import { dbFor } from '../services/db-router.js';
import { sendPlainMail } from '../services/plain-mail.js';
import { HQ_SUPPORT_KIND_LABELS } from './hq-support.js';

/**
 * 運営コンソールのお問い合わせ（チケット）★37-6 / 37-6-A / 37-6-B。
 *
 * 表は統括側 36-3 と同じ hq_support_requests。運営マスターだけが呼べる。
 * 返信は統括の登録メールへ送り、統括の画面（36-3 の履歴）にも載る。
 */
export const opsSupport = new Hono<Env>();

opsSupport.use('/api/ops/support/*', requirePlatformAdmin());

const REPLY_MAX = 4000;
const SUBJECT_MAX = 120;
const BODY_MAX = 4000;

function workerUrl(c: Context<Env>): string {
  return c.env.WORKER_URL || new URL(c.req.url).origin;
}

function safeKeys(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : [];
  } catch {
    return [];
  }
}

function jstMonthStarts(): { monthStart: string; prevMonthStart: string } {
  const now = japanCalendar();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const fmt = (yy: number, mm: number) => `${yy}-${String(mm + 1).padStart(2, '0')}-01T00:00:00.000+09:00`;
  return { monthStart: fmt(y, m), prevMonthStart: m === 0 ? fmt(y - 1, 11) : fmt(y, m - 1) };
}

function serializeTicket(row: SupportTicketRow, base: string, replyCount: number) {
  return {
    id: row.id,
    ticketNo: row.ticket_no,
    ticketLabel: formatTicketNo(row.ticket_no),
    tenantId: row.tenant_id,
    tenantName: row.tenant_name,
    tenantPlanKey: row.tenant_plan_key,
    tenantPlanStatus: row.tenant_plan_status,
    tenantStatus: row.tenant_status,
    staffId: row.staff_id,
    staffName: row.staff_name,
    staffRole: row.staff_role,
    staffEmailRegistered: row.staff_email !== null,
    kind: row.kind,
    kindLabel: HQ_SUPPORT_KIND_LABELS[row.kind] ?? row.kind,
    subject: row.subject,
    subjectAuto: row.subject_auto === 1,
    body: row.body,
    attachments: safeKeys(row.attachment_keys).map((key) => ({ key, url: `${base}/images/${key}`, name: key.split('/').pop() ?? key })),
    stage: row.stage,
    stageLabel: SUPPORT_STAGE_LABELS[row.stage],
    priority: row.priority,
    priorityLabel: SUPPORT_PRIORITY_LABELS[row.priority],
    channel: row.channel,
    channelLabel: SUPPORT_CHANNEL_LABELS[row.channel],
    assigneeStaffId: row.assignee_staff_id,
    replyCount,
    firstRepliedAt: row.first_replied_at,
    lastMessageAt: row.last_message_at ?? row.created_at,
    resolvedAt: row.resolved_at,
    closedAt: row.closed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function serializeMessage(m: SupportMessage, base: string) {
  return {
    id: m.id,
    authorKind: m.author_kind,
    authorName: m.author_name,
    body: m.body,
    attachments: safeKeys(m.attachment_keys).map((key) => ({ key, url: `${base}/images/${key}`, name: key.split('/').pop() ?? key })),
    deliveredVia: safeKeys(m.delivered_via),
    createdAt: m.created_at,
  };
}

async function audit(c: Context<Env>, input: { action: 'ticket.view' | 'ticket.reply' | 'ticket.stage.change' | 'ticket.create'; ticket: SupportTicketRow; detail?: Record<string, unknown>; visibleToTenant: boolean }) {
  const staff = c.get('staff');
  await recordPlatformAudit(dbFor(c.env), {
    staffId: staff.id,
    staffName: staff.name,
    tenantId: input.ticket.tenant_id,
    tenantName: input.ticket.tenant_name,
    action: input.action,
    detail: { ticketNo: input.ticket.ticket_no, ...(input.detail ?? {}) },
    ip: clientIp(c),
    visibleToTenant: input.visibleToTenant,
  });
}

// ---------------------------------------------------------------------------
// 一覧・数値カード
// ---------------------------------------------------------------------------

opsSupport.get('/api/ops/support/summary', async (c) => {
  const db = dbFor(c.env);
  const [byStage, kpis] = await Promise.all([countSupportTicketsByStage(db), supportTicketKpis(db, jstMonthStarts())]);
  return c.json({ success: true, data: { byStage, kpis } });
});

opsSupport.get('/api/ops/support/templates', async (c) => {
  return c.json({ success: true, data: await listSupportTemplateCatalog(dbFor(c.env)) });
});

opsSupport.post('/api/ops/support/template-folders', requirePlatformAdminWrite(), inputJsonBoundary(), async (c) => {
  const body = await c.req.json<{ name?: unknown }>().catch(() => null);
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > 60) return inputError(c, { success: false, error: 'フォルダ名は1〜60文字で入力してください' }, 400, ['name']);
  const folder = await createSupportTemplateFolder(dbFor(c.env), name, c.get('staff').id);
  if (!folder) return inputError(c, { success: false, error: '同じ名前のフォルダがあります' }, 409, ['name']);
  return c.json({ success: true, data: folder }, 201);
});

opsSupport.post('/api/ops/support/templates', requirePlatformAdminWrite(), inputJsonBoundary(), async (c) => {
  const body = await c.req.json<{ folderId?: unknown; title?: unknown; body?: unknown }>().catch(() => null);
  const folderId = typeof body?.folderId === 'string' ? body.folderId : '';
  const title = typeof body?.title === 'string' ? body.title.trim() : '';
  const text = typeof body?.body === 'string' ? body.body.trim() : '';
  if (!title || title.length > 120) return inputError(c, { success: false, error: 'テンプレート名は1〜120文字で入力してください' }, 400, ['title']);
  if (!text || text.length > 4000) return inputError(c, { success: false, error: '本文は1〜4,000文字で入力してください' }, 400, ['body']);
  const template = await createSupportReplyTemplate(dbFor(c.env), { folderId, title, body: text }, c.get('staff').id);
  if (!template) return inputError(c, { success: false, error: '保存先のフォルダが見つかりません。読み直して選んでください' }, 400, ['folderId']);
  return c.json({ success: true, data: template }, 201);
});

opsSupport.patch('/api/ops/support/templates/:id', requirePlatformAdminWrite(), inputJsonBoundary(), async (c) => {
  const body = await c.req.json<{ folderId?: unknown; title?: unknown; body?: unknown; expectedUpdatedAt?: unknown }>().catch(() => null);
  const folderId = typeof body?.folderId === 'string' ? body.folderId : '';
  const title = typeof body?.title === 'string' ? body.title.trim() : '';
  const text = typeof body?.body === 'string' ? body.body.trim() : '';
  const expectedUpdatedAt = typeof body?.expectedUpdatedAt === 'string' ? body.expectedUpdatedAt : '';
  if (!folderId) return inputError(c, { success: false, error: '保存先フォルダを選んでください' }, 400, ['folderId']);
  if (!title || title.length > 120) return inputError(c, { success: false, error: 'テンプレート名は1〜120文字で入力してください' }, 400, ['title']);
  if (!text || text.length > 4000) return inputError(c, { success: false, error: '本文は1〜4,000文字で入力してください' }, 400, ['body']);
  if (!expectedUpdatedAt) return inputError(c, { success: false, error: 'テンプレートを読み直してください' }, 400, ['expectedUpdatedAt']);
  const result = await updateSupportReplyTemplate(dbFor(c.env), c.req.param('id'), { folderId, title, body: text, expectedUpdatedAt }, c.get('staff').id);
  if (result.status === 'missing') return c.json({ success: false, error: 'テンプレートが見つかりません。読み直してください' }, 404);
  if (result.status === 'conflict') return c.json({ success: false, error: '別の担当者が先に変更しました。テンプレートを読み直してください' }, 409);
  if (result.status === 'folder_missing') return inputError(c, { success: false, error: '保存先のフォルダが見つかりません。読み直して選んでください' }, 400, ['folderId']);
  return c.json({ success: true, data: result.template });
});

opsSupport.delete('/api/ops/support/templates/:id', requirePlatformAdminWrite(), inputJsonBoundary(), async (c) => {
  const body = await c.req.json<{ expectedUpdatedAt?: unknown }>().catch(() => null);
  const expectedUpdatedAt = typeof body?.expectedUpdatedAt === 'string' ? body.expectedUpdatedAt : '';
  if (!expectedUpdatedAt) return inputError(c, { success: false, error: 'テンプレートを読み直してください' }, 400, ['expectedUpdatedAt']);
  const result = await deleteSupportReplyTemplate(dbFor(c.env), c.req.param('id'), expectedUpdatedAt, c.get('staff').id);
  if (result === 'missing') return c.json({ success: false, error: 'テンプレートが見つかりません。読み直してください' }, 404);
  if (result === 'conflict') return c.json({ success: false, error: '別の担当者が先に変更しました。テンプレートを読み直してください' }, 409);
  return c.json({ success: true, data: null });
});

opsSupport.get('/api/ops/support/tickets', async (c) => {
  const db = dbFor(c.env);
  const stageRaw = c.req.query('stage');
  const stage = stageRaw && (SUPPORT_STAGES as readonly string[]).includes(stageRaw) ? (stageRaw as SupportStage) : 'all';
  const priorityRaw = c.req.query('priority');
  const priority = priorityRaw && (SUPPORT_PRIORITIES as readonly string[]).includes(priorityRaw) ? (priorityRaw as SupportPriority) : undefined;
  const sortRaw = c.req.query('sort');
  const sort = sortRaw === 'oldest' || sortRaw === 'priority' ? sortRaw : 'newest';
  const { limit, offset } = parseOffsetPaging({ limit: c.req.query('limit'), offset: c.req.query('offset') }, { defaultLimit: 50, limitPolicy: { fallback: 'finite', minimum: 1, maximum: 200 }, offsetPolicy: { fallback: 'finite', minimum: 0 } });
  const { rows, total } = await listSupportTickets(db, {
    stage, priority, q: c.req.query('q') ?? '', sort,
    limit, offset,
  });
  const replies = await countRepliesForRequests(db, rows.map((r) => r.id));
  const base = workerUrl(c);
  const responseItems = rows.map((r) => serializeTicket(r, base, replies.get(r.id) ?? 0));
  return c.json(buildOffsetListResponse({ success: true, data: responseItems, total, items: responseItems, paging: { limit, offset }, sort: [] }));
});

// ---------------------------------------------------------------------------
// 詳細
// ---------------------------------------------------------------------------

opsSupport.get('/api/ops/support/tickets/:id', async (c) => {
  const db = dbFor(c.env);
  const ticket = await getSupportTicket(db, c.req.param('id'));
  if (!ticket) return c.json({ success: false, error: 'チケットが見つかりません' }, 404);
  const [messages, draft, tenant] = await Promise.all([
    listSupportMessages(db, ticket.id),
    getSupportReplyDraft(db, ticket.id),
    supportTenantContext(db, ticket.tenant_id, ticket.id),
  ]);
  const base = workerUrl(c);
  // 閲覧の記録（統括には見せない）。失敗しても画面は出す。
  await audit(c, { action: 'ticket.view', ticket, visibleToTenant: false }).catch((error) => {
    logger.error("ops_support.ops_support_tickets_by_id_get_failed");
  });
  return c.json({
    success: true,
    data: {
      ticket: serializeTicket(ticket, base, messages.filter((m) => m.author_kind === 'ops').length),
      tenant,
      messages: messages.map((m) => serializeMessage(m, base)),
      draft: draft ? { body: draft.body, updatedAt: draft.updated_at } : null,
    },
  });
});

opsSupport.patch('/api/ops/support/tickets/:id', requirePlatformAdminWrite(), inputJsonBoundary(), async (c) => {
  const db = dbFor(c.env);
  const body = await c.req.json<{ stage?: unknown; priority?: unknown }>().catch(() => null);
  if (!body) return inputError(c, { success: false, error: '内容を読み取れませんでした' }, 400, []);
  const patch: { stage?: SupportStage; priority?: SupportPriority } = {};
  if (body.stage !== undefined) {
    if (typeof body.stage !== 'string' || !(SUPPORT_STAGES as readonly string[]).includes(body.stage)) {
      return inputError(c, { success: false, error: '状態の値が正しくありません' }, 400, ["stage"]);
    }
    patch.stage = body.stage as SupportStage;
  }
  if (body.priority !== undefined) {
    if (typeof body.priority !== 'string' || !(SUPPORT_PRIORITIES as readonly string[]).includes(body.priority)) {
      return inputError(c, { success: false, error: '優先度の値が正しくありません' }, 400, ["priority"]);
    }
    patch.priority = body.priority as SupportPriority;
  }
  if (!patch.stage && !patch.priority) return inputError(c, { success: false, error: '変更する項目がありません' }, 400, ["stage","priority"]);
  const before = await getSupportTicket(db, c.req.param('id'));
  if (!before) return c.json({ success: false, error: 'チケットが見つかりません' }, 404);
  const after = await updateSupportTicket(db, before.id, patch);
  if (!after) return c.json({ success: false, error: 'チケットが見つかりません' }, 404);
  if (patch.stage && patch.stage !== before.stage) {
    await audit(c, { action: 'ticket.stage.change', ticket: after, detail: { from: before.stage, to: patch.stage }, visibleToTenant: false });
  }
  const base = workerUrl(c);
  const replies = await countRepliesForRequests(db, [after.id]);
  return c.json({ success: true, data: serializeTicket(after, base, replies.get(after.id) ?? 0) });
});

// ---------------------------------------------------------------------------
// 返信・下書き
// ---------------------------------------------------------------------------

function replyMailBody(input: { staffName: string; ticketLabel: string; subject: string; reply: string; opsName: string; adminUrl: string }): string {
  return [
    `${input.staffName || 'ご担当者'} 様`,
    '',
    `お問い合わせ ${input.ticketLabel}「${input.subject}」に、musubo 運営から返信しました。`,
    '',
    '----------------------------------------',
    input.reply,
    '----------------------------------------',
    '',
    `担当: musubo 運営 ／ ${input.opsName}`,
    'この返信は管理画面の「お問い合わせ」の履歴にも載っています。',
    `${input.adminUrl}/hq/support`,
    '',
    '追加のご質問は、管理画面のお問い合わせから同じ件名でお送りください。',
  ].join('\n');
}

opsSupport.post('/api/ops/support/tickets/:id/reply', requirePlatformAdminWrite(), inputJsonBoundary(), async (c) => {
  const db = dbFor(c.env);
  const staff = c.get('staff');
  const body = await c.req.json<{ body?: unknown; nextStage?: unknown }>().catch(() => null);
  if (!body) return inputError(c, { success: false, error: '内容を読み取れませんでした' }, 400, []);
  const text = typeof body.body === 'string' ? body.body.trim() : '';
  if (!text) return inputError(c, { success: false, error: '返信を入力してください' }, 400, ["body"]);
  if (text.length > REPLY_MAX) return inputError(c, { success: false, error: `返信は${REPLY_MAX}文字以内で入力してください` }, 400, ["body"]);
  let nextStage: SupportStage | undefined;
  if (body.nextStage !== undefined) {
    if (typeof body.nextStage !== 'string' || !(SUPPORT_STAGES as readonly string[]).includes(body.nextStage)) {
      return inputError(c, { success: false, error: '状態の値が正しくありません' }, 400, ["nextStage"]);
    }
    nextStage = body.nextStage as SupportStage;
  }
  const ticket = await getSupportTicket(db, c.req.param('id'));
  if (!ticket) return c.json({ success: false, error: 'チケットが見つかりません' }, 404);
  if (ticket.stage === 'closed') return c.json({ success: false, error: 'クローズしたチケットには返信できません。先に状態を戻してください' }, 409);

  // 届け方：登録メール（あれば）＋管理画面の履歴。契約者専用LINEは 37-7 の口ができてから足す。
  const deliveredVia: string[] = ['screen'];
  const adminUrl = (c.env.ADMIN_PUBLIC_URL ?? '').replace(/\/+$/, '');
  if (ticket.staff_email) {
    try {
      await sendPlainMail(c.env, {
        to: ticket.staff_email,
        subject: `【musubo】お問い合わせへの返信 ${formatTicketNo(ticket.ticket_no)}: ${ticket.subject}`,
        body: replyMailBody({ staffName: ticket.staff_name, ticketLabel: formatTicketNo(ticket.ticket_no), subject: ticket.subject, reply: text, opsName: staff.name, adminUrl }),
      });
      deliveredVia.push('email');
    } catch (error) {
      // メールが落ちても返信は記録する。画面には「メールは送れなかった」と返す。
      logger.error("ops_support.ops_support_tickets_by_id_reply_create_failed");
    }
  }
  const message = await addSupportReply(db, {
    requestId: ticket.id,
    authorStaffId: staff.id,
    authorName: staff.name,
    body: text,
    deliveredVia,
    nextStage,
  });
  const after = (await getSupportTicket(db, ticket.id))!;
  await audit(c, { action: 'ticket.reply', ticket: after, detail: { deliveredVia }, visibleToTenant: true });
  const base = workerUrl(c);
  const replies = await countRepliesForRequests(db, [after.id]);
  return c.json({
    success: true,
    data: {
      ticket: serializeTicket(after, base, replies.get(after.id) ?? 0),
      message: serializeMessage(message, base),
      mailSent: deliveredVia.includes('email'),
      mailSkippedReason: ticket.staff_email ? (deliveredVia.includes('email') ? null : 'send_failed') : 'no_email',
    },
  }, 201);
});

opsSupport.put('/api/ops/support/tickets/:id/draft', requirePlatformAdminWrite(), inputJsonBoundary(), async (c) => {
  const db = dbFor(c.env);
  const staff = c.get('staff');
  const body = await c.req.json<{ body?: unknown }>().catch(() => null);
  const text = typeof body?.body === 'string' ? body.body : '';
  if (text.length > REPLY_MAX) return inputError(c, { success: false, error: `下書きは${REPLY_MAX}文字以内です` }, 400, ["body"]);
  const ticket = await getSupportTicket(db, c.req.param('id'));
  if (!ticket) return c.json({ success: false, error: 'チケットが見つかりません' }, 404);
  if (!text.trim()) {
    await deleteSupportReplyDraft(db, ticket.id);
    return c.json({ success: true, data: null });
  }
  const draft = await saveSupportReplyDraft(db, { requestId: ticket.id, body: text, authorStaffId: staff.id });
  return c.json({ success: true, data: { body: draft.body, updatedAt: draft.updated_at } });
});

opsSupport.delete('/api/ops/support/tickets/:id/draft', requirePlatformAdminWrite(), async (c) => {
  const db = dbFor(c.env);
  const ticket = await getSupportTicket(db, c.req.param('id'));
  if (!ticket) return c.json({ success: false, error: 'チケットが見つかりません' }, 404);
  await deleteSupportReplyDraft(db, ticket.id);
  return c.json({ success: true, data: null });
});

// ---------------------------------------------------------------------------
// 運営が起票する（＋ チケットを作る）
// ---------------------------------------------------------------------------

opsSupport.post('/api/ops/support/tickets', requirePlatformAdminWrite(), inputJsonBoundary(), async (c) => {
  const db = dbFor(c.env);
  const staff = c.get('staff');
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return inputError(c, { success: false, error: '内容を読み取れませんでした' }, 400, []);
  const tenantId = typeof body.tenantId === 'string' ? body.tenantId : '';
  const tenant = tenantId
    ? await db.prepare('SELECT id, name FROM tenants WHERE id = ?').bind(tenantId).first<{ id: string; name: string }>()
    : null;
  if (!tenant) return inputError(c, { success: false, error: '契約先を選んでください' }, 400, ["tenantId"]);
  const subject = typeof body.subject === 'string' ? body.subject.trim() : '';
  if (!subject) return inputError(c, { success: false, error: '件名を入力してください' }, 400, ["subject"]);
  if (subject.length > SUBJECT_MAX) return inputError(c, { success: false, error: `件名は${SUBJECT_MAX}文字以内で入力してください` }, 400, ["subject"]);
  const text = typeof body.body === 'string' ? body.body.trim() : '';
  if (!text) return inputError(c, { success: false, error: '本文を入力してください' }, 400, ["body"]);
  if (text.length > BODY_MAX) return inputError(c, { success: false, error: `本文は${BODY_MAX}文字以内で入力してください` }, 400, ["body"]);
  const kind = typeof body.kind === 'string' && (HQ_SUPPORT_KINDS as readonly string[]).includes(body.kind) ? (body.kind as HqSupportKind) : 'other';
  const priority = typeof body.priority === 'string' && (SUPPORT_PRIORITIES as readonly string[]).includes(body.priority) ? (body.priority as SupportPriority) : 'medium';
  const channel = body.channel === 'line' ? 'line' : 'ops';
  let staffRow: { id: string; name: string; email: string | null } | null = null;
  if (typeof body.staffId === 'string' && body.staffId) {
    staffRow = await db
      .prepare('SELECT id, name, email FROM staff_members WHERE id = ? AND tenant_id = ? AND is_active = 1')
      .bind(body.staffId, tenant.id)
      .first<{ id: string; name: string; email: string | null }>();
    if (!staffRow) return c.json({ success: false, error: '起票者が契約先の権限者に見つかりません' }, 404);
  }
  const ticket = await createSupportTicketByOps(db, {
    tenantId: tenant.id, subject, body: text, kind, priority, channel,
    createdByStaffId: staff.id, createdByName: staff.name,
    staffId: staffRow?.id ?? null, staffName: staffRow?.name ?? '', staffEmail: staffRow?.email ?? null,
  });
  await audit(c, { action: 'ticket.create', ticket, detail: { channel, priority }, visibleToTenant: false });
  return c.json({ success: true, data: serializeTicket(ticket, workerUrl(c), 0) }, 201);
});
