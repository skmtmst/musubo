import { sqlIdSet } from './id-queries.js';
import { jstNow } from './utils.js';
import type { HqSupportKind, HqSupportRequest, HqSupportStatus } from './hq-support-types.js';

/**
 * 運営コンソールのお問い合わせ（チケット）★37-6。
 *
 * 表は統括側の 36-3 と同じ hq_support_requests。運営はここに stage（進み具合）・
 * priority（優先度）・返信（hq_support_messages）・下書き（hq_support_reply_drafts）を足す。
 * 統括の画面向けの status は stage から導く（migration 421 のコメント）。
 */

export const SUPPORT_STAGES = ['new', 'in_progress', 'waiting', 'resolved', 'closed'] as const;
export type SupportStage = (typeof SUPPORT_STAGES)[number];
export const SUPPORT_PRIORITIES = ['low', 'medium', 'high'] as const;
export type SupportPriority = (typeof SUPPORT_PRIORITIES)[number];
export const SUPPORT_CHANNELS = ['admin', 'line', 'ops'] as const;
export type SupportChannel = (typeof SUPPORT_CHANNELS)[number];

export const SUPPORT_STAGE_LABELS: Record<SupportStage, string> = {
  new: '新規', in_progress: '対応中', waiting: '待ち', resolved: '解決済み', closed: 'クローズ',
};
export const SUPPORT_PRIORITY_LABELS: Record<SupportPriority, string> = { low: '低', medium: '中', high: '高' };
export const SUPPORT_CHANNEL_LABELS: Record<SupportChannel, string> = { admin: '管理画面', line: 'LINE', ops: '運営が起票' };

/** チケット番号の表示形（#MB-0312）。 */
export function formatTicketNo(no: number | null): string {
  return no === null ? '#MB-----' : `#MB-${String(no).padStart(4, '0')}`;
}

/** stage から統括の画面向けの粗い status を導く。 */
export function statusForStage(stage: SupportStage, replied: boolean): HqSupportStatus {
  if (stage === 'resolved' || stage === 'closed') return 'closed';
  return replied ? 'answered' : 'open';
}

export interface SupportTicketRow extends HqSupportRequest {
  tenant_name: string;
  tenant_plan_key: string | null;
  tenant_plan_status: string;
  tenant_status: string;
  staff_role: string | null;
}

export interface SupportMessage {
  id: string;
  request_id: string;
  author_kind: 'tenant' | 'ops';
  author_staff_id: string | null;
  author_name: string;
  body: string;
  attachment_keys: string;
  ai_assisted: number;
  delivered_via: string;
  created_at: string;
}

export interface SupportReplyDraft {
  request_id: string;
  body: string;
  ai_generated: number;
  generated_at: string | null;
  author_staff_id: string | null;
  updated_at: string;
  knowledge_references: string;
}

const TICKET_SELECT = `
  SELECT r.*, t.name AS tenant_name, t.plan_key AS tenant_plan_key, t.plan_status AS tenant_plan_status,
         t.status AS tenant_status, sm.role AS staff_role
    FROM hq_support_requests r
    JOIN tenants t ON t.id = r.tenant_id
    LEFT JOIN staff_members sm ON sm.id = r.staff_id`;

/** 通し番号を 1 つ取る。platform_counters を 1 行更新して返す。 */
export async function nextSupportTicketNo(db: D1Database): Promise<number> {
  await db
    .prepare(`INSERT OR IGNORE INTO platform_counters (name, value) VALUES ('support_ticket', 0)`)
    .run();
  const row = await db
    .prepare(`UPDATE platform_counters SET value = value + 1 WHERE name = 'support_ticket' RETURNING value`)
    .first<{ value: number }>();
  if (!row) throw new Error('support ticket counter unavailable');
  return row.value;
}

export interface SupportTicketListInput {
  stage?: SupportStage | 'all';
  priority?: SupportPriority;
  q?: string;
  sort?: 'newest' | 'oldest' | 'priority';
  limit?: number;
  offset?: number;
}

export async function listSupportTickets(
  db: D1Database,
  input: SupportTicketListInput,
): Promise<{ rows: SupportTicketRow[]; total: number }> {
  const where: string[] = [];
  const binds: unknown[] = [];
  if (input.stage && input.stage !== 'all') { where.push('r.stage = ?'); binds.push(input.stage); }
  if (input.priority) { where.push('r.priority = ?'); binds.push(input.priority); }
  const q = (input.q ?? '').trim();
  if (q) {
    const numeric = q.replace(/^#?MB-?/i, '');
    if (/^\d+$/.test(numeric)) { where.push('r.ticket_no = ?'); binds.push(Number(numeric)); }
    else {
      where.push('(r.subject LIKE ? OR t.name LIKE ? OR r.staff_name LIKE ?)');
      const like = `%${q}%`;
      binds.push(like, like, like);
    }
  }
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const order = input.sort === 'oldest'
    ? 'ORDER BY r.last_message_at ASC, r.created_at ASC, r.ticket_no ASC'
    : input.sort === 'priority'
      ? `ORDER BY CASE r.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, r.last_message_at DESC, r.ticket_no DESC`
      : 'ORDER BY r.last_message_at DESC, r.created_at DESC, r.ticket_no DESC';
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const offset = Math.max(input.offset ?? 0, 0);
  const [list, count] = await Promise.all([
    db.prepare(`${TICKET_SELECT} ${clause} ${order} LIMIT ? OFFSET ?`).bind(...binds, limit, offset).all<SupportTicketRow>(),
    db.prepare(`SELECT COUNT(*) AS n FROM hq_support_requests r JOIN tenants t ON t.id = r.tenant_id ${clause}`).bind(...binds).first<{ n: number }>(),
  ]);
  return { rows: list.results ?? [], total: count?.n ?? 0 };
}

export async function getSupportTicket(db: D1Database, id: string): Promise<SupportTicketRow | null> {
  return db.prepare(`${TICKET_SELECT} WHERE r.id = ?`).bind(id).first<SupportTicketRow>();
}

export async function countSupportTicketsByStage(db: D1Database): Promise<Record<SupportStage | 'all', number>> {
  const { results } = await db
    .prepare(`SELECT stage, COUNT(*) AS n FROM hq_support_requests GROUP BY stage`)
    .all<{ stage: SupportStage; n: number }>();
  const out: Record<SupportStage | 'all', number> = { all: 0, new: 0, in_progress: 0, waiting: 0, resolved: 0, closed: 0 };
  for (const row of results ?? []) { out[row.stage] = row.n; out.all += row.n; }
  return out;
}

/** 数値カード帯（★37-6）の元になる集計。期間は月初からの JST 文字列で渡す。 */
export async function supportTicketKpis(
  db: D1Database,
  input: { monthStart: string; prevMonthStart: string },
): Promise<{
  untouched: number;
  untouchedFromLine: number;
  avgFirstReplyMinutes: number | null;
  prevAvgFirstReplyMinutes: number | null;
  resolutionRate: number | null;
  prevResolutionRate: number | null;
  avgResolutionMinutes: number | null;
  prevAvgResolutionMinutes: number | null;
}> {
  const untouched = await db
    .prepare(`SELECT COUNT(*) AS n, SUM(CASE WHEN channel = 'line' THEN 1 ELSE 0 END) AS line_n
                FROM hq_support_requests WHERE stage = 'new'`)
    .first<{ n: number; line_n: number | null }>();
  const period = async (from: string, to: string | null) => {
    const upper = to ? 'AND created_at < ?' : '';
    const binds = to ? [from, to] : [from];
    const row = await db
      .prepare(`SELECT
                  AVG(CASE WHEN first_replied_at IS NOT NULL
                           THEN (julianday(first_replied_at) - julianday(created_at)) * 1440 END) AS first_reply,
                  AVG(CASE WHEN resolved_at IS NOT NULL
                           THEN (julianday(resolved_at) - julianday(created_at)) * 1440 END) AS resolution,
                  COUNT(*) AS n,
                  SUM(CASE WHEN stage IN ('resolved', 'closed') THEN 1 ELSE 0 END) AS done
                FROM hq_support_requests WHERE created_at >= ? ${upper}`)
      .bind(...binds)
      .first<{ first_reply: number | null; resolution: number | null; n: number; done: number | null }>();
    return {
      firstReply: row?.first_reply ?? null,
      resolution: row?.resolution ?? null,
      rate: row && row.n > 0 ? ((row.done ?? 0) / row.n) * 100 : null,
    };
  };
  const [cur, prev] = await Promise.all([period(input.monthStart, null), period(input.prevMonthStart, input.monthStart)]);
  return {
    untouched: untouched?.n ?? 0,
    untouchedFromLine: untouched?.line_n ?? 0,
    avgFirstReplyMinutes: cur.firstReply,
    prevAvgFirstReplyMinutes: prev.firstReply,
    resolutionRate: cur.rate,
    prevResolutionRate: prev.rate,
    avgResolutionMinutes: cur.resolution,
    prevAvgResolutionMinutes: prev.resolution,
  };
}

export async function listSupportMessages(db: D1Database, requestId: string): Promise<SupportMessage[]> {
  const { results } = await db
    .prepare(`SELECT * FROM hq_support_messages WHERE request_id = ? ORDER BY created_at ASC, id ASC`)
    .bind(requestId)
    .all<SupportMessage>();
  return results ?? [];
}

export async function countRepliesForRequests(db: D1Database, requestIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (requestIds.length === 0) return out;
  const marks = sqlIdSet(requestIds).sql;
  const { results } = await db
    .prepare(`SELECT request_id, COUNT(*) AS n FROM hq_support_messages
               WHERE author_kind = 'ops' AND request_id IN (${marks}) GROUP BY request_id`)
    .bind(...sqlIdSet(requestIds).binds)
    .all<{ request_id: string; n: number }>();
  for (const row of results ?? []) out.set(row.request_id, row.n);
  return out;
}

/** 運営の返信を 1 通足す。first_replied_at・last_message_at・status も合わせて進める。 */
export async function addSupportReply(
  db: D1Database,
  input: {
    requestId: string;
    authorStaffId: string;
    authorName: string;
    body: string;
    deliveredVia: string[];
    /** 返信と同時に進める stage。省略時は waiting（相手の返事待ち）。 */
    nextStage?: SupportStage;
  },
): Promise<SupportMessage> {
  const id = crypto.randomUUID();
  const now = jstNow();
  const stage = input.nextStage ?? 'waiting';
  await db.batch([
    db.prepare(`INSERT INTO hq_support_messages
                  (id, request_id, author_kind, author_staff_id, author_name, body, attachment_keys, ai_assisted, delivered_via, created_at)
                VALUES (?, ?, 'ops', ?, ?, ?, '[]', ?, ?, ?)`)
      .bind(id, input.requestId, input.authorStaffId, input.authorName, input.body, 0, JSON.stringify(input.deliveredVia), now),
    db.prepare(`UPDATE hq_support_requests
                   SET first_replied_at = COALESCE(first_replied_at, ?),
                       last_message_at = ?,
                       stage = ?,
                       status = ?,
                       resolved_at = CASE WHEN ? IN ('resolved', 'closed') THEN COALESCE(resolved_at, ?) ELSE resolved_at END,
                       closed_at = CASE WHEN ? = 'closed' THEN COALESCE(closed_at, ?) ELSE closed_at END,
                       updated_at = ?
                 WHERE id = ?`)
      .bind(now, now, stage, statusForStage(stage, true), stage, now, stage, now, now, input.requestId),
    db.prepare(`DELETE FROM hq_support_reply_drafts WHERE request_id = ?`).bind(input.requestId),
  ]);
  return (await db.prepare('SELECT * FROM hq_support_messages WHERE id = ?').bind(id).first<SupportMessage>())!;
}

/** 統括側からの続き（★36-3-A）。待ち・解決済み・クローズは対応中へ戻す。 */
export async function addSupportTenantMessage(
  db: D1Database,
  input: { requestId: string; staffId: string | null; staffName: string; body: string; attachmentKeys: string[] },
): Promise<SupportMessage> {
  const id = crypto.randomUUID();
  const now = jstNow();
  await db.batch([
    db.prepare(`INSERT INTO hq_support_messages
                  (id, request_id, author_kind, author_staff_id, author_name, body, attachment_keys, created_at)
                VALUES (?, ?, 'tenant', ?, ?, ?, ?, ?)`)
      .bind(id, input.requestId, input.staffId, input.staffName, input.body, JSON.stringify(input.attachmentKeys), now),
    db.prepare(`UPDATE hq_support_requests
                   SET last_message_at = ?,
                       stage = CASE WHEN stage IN ('waiting', 'resolved', 'closed') THEN 'in_progress' ELSE stage END,
                       status = 'open', resolved_at = NULL, closed_at = NULL, updated_at = ?
                 WHERE id = ?`)
      .bind(now, now, input.requestId),
  ]);
  return (await db.prepare('SELECT * FROM hq_support_messages WHERE id = ?').bind(id).first<SupportMessage>())!;
}

export async function updateSupportTicket(
  db: D1Database,
  id: string,
  patch: { stage?: SupportStage; priority?: SupportPriority; assigneeStaffId?: string | null },
): Promise<SupportTicketRow | null> {
  const current = await getSupportTicket(db, id);
  if (!current) return null;
  const now = jstNow();
  const sets: string[] = ['updated_at = ?'];
  const binds: unknown[] = [now];
  if (patch.stage) {
    sets.push('stage = ?', 'status = ?');
    binds.push(patch.stage, statusForStage(patch.stage, current.first_replied_at !== null));
    if (patch.stage === 'resolved' || patch.stage === 'closed') { sets.push('resolved_at = COALESCE(resolved_at, ?)'); binds.push(now); }
    if (patch.stage === 'closed') { sets.push('closed_at = COALESCE(closed_at, ?)'); binds.push(now); }
    if (patch.stage === 'new' || patch.stage === 'in_progress' || patch.stage === 'waiting') {
      sets.push('resolved_at = NULL', 'closed_at = NULL');
    }
  }
  if (patch.priority) { sets.push('priority = ?'); binds.push(patch.priority); }
  if (patch.assigneeStaffId !== undefined) { sets.push('assignee_staff_id = ?'); binds.push(patch.assigneeStaffId); }
  binds.push(id);
  await db.prepare(`UPDATE hq_support_requests SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
  return getSupportTicket(db, id);
}

/** 運営が代わりに起票する（★37-6「＋ チケットを作る」）。 */
export async function createSupportTicketByOps(
  db: D1Database,
  input: {
    tenantId: string;
    subject: string;
    body: string;
    kind: HqSupportKind;
    priority: SupportPriority;
    channel: SupportChannel;
    createdByStaffId: string;
    createdByName: string;
    /** 起票者として記録する統括側の権限者（分かるとき）。 */
    staffId?: string | null;
    staffName?: string;
    staffEmail?: string | null;
  },
): Promise<SupportTicketRow> {
  const id = crypto.randomUUID();
  const now = jstNow();
  const ticketNo = await nextSupportTicketNo(db);
  await db
    .prepare(`INSERT INTO hq_support_requests
                (id, tenant_id, staff_id, staff_name, staff_email, kind, subject, body, line_account_id, attachment_keys,
                 status, ticket_no, stage, priority, channel, subject_auto, assignee_staff_id, last_message_at, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, '[]', 'open', ?, 'new', ?, ?, 0, ?, ?, ?, ?)`)
    .bind(id, input.tenantId, input.staffId ?? null, input.staffName ?? '', input.staffEmail ?? null, input.kind,
      input.subject, input.body, ticketNo, input.priority, input.channel, input.createdByStaffId, now, now, now)
    .run();
  return (await getSupportTicket(db, id))!;
}

export async function getSupportReplyDraft(db: D1Database, requestId: string): Promise<SupportReplyDraft | null> {
  return db.prepare('SELECT * FROM hq_support_reply_drafts WHERE request_id = ?').bind(requestId).first<SupportReplyDraft>();
}

export async function saveSupportReplyDraft(
  db: D1Database,
  input: { requestId: string; body: string; authorStaffId: string },
): Promise<SupportReplyDraft> {
  const now = jstNow();
  await db
    .prepare(`INSERT INTO hq_support_reply_drafts (request_id, body, ai_generated, generated_at, author_staff_id, updated_at, knowledge_references)
              VALUES (?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(request_id) DO UPDATE SET
                body = excluded.body, ai_generated = excluded.ai_generated,
                generated_at = excluded.generated_at, author_staff_id = excluded.author_staff_id, updated_at = excluded.updated_at,
                knowledge_references = excluded.knowledge_references`)
    .bind(input.requestId, input.body, 0, null, input.authorStaffId, now, '[]')
    .run();
  return (await getSupportReplyDraft(db, input.requestId))!;
}

export async function deleteSupportReplyDraft(db: D1Database, requestId: string): Promise<void> {
  await db.prepare('DELETE FROM hq_support_reply_drafts WHERE request_id = ?').bind(requestId).run();
}

/** 契約先の状況（★37-6「問い合わせ元」）。店舗数・LINE登録・過去のチケット。 */
export async function supportTenantContext(
  db: D1Database,
  tenantId: string,
  excludeRequestId: string,
): Promise<{ accountCount: number; staffCount: number; staffWithLine: number; pastTickets: number; pastOpen: number }> {
  const row = await db
    .prepare(`SELECT
                (SELECT COUNT(*) FROM line_accounts la WHERE la.tenant_id = ? AND la.archived_at IS NULL) AS accounts,
                (SELECT COUNT(*) FROM staff_members sm WHERE sm.tenant_id = ? AND sm.is_active = 1) AS staff,
                (SELECT COUNT(*) FROM staff_members sm WHERE sm.tenant_id = ? AND sm.is_active = 1 AND sm.line_user_id IS NOT NULL) AS staff_line,
                (SELECT COUNT(*) FROM hq_support_requests h WHERE h.tenant_id = ? AND h.id <> ?) AS past,
                (SELECT COUNT(*) FROM hq_support_requests h WHERE h.tenant_id = ? AND h.id <> ? AND h.stage NOT IN ('resolved', 'closed')) AS past_open`)
    .bind(tenantId, tenantId, tenantId, tenantId, excludeRequestId, tenantId, excludeRequestId)
    .first<{ accounts: number; staff: number; staff_line: number; past: number; past_open: number }>();
  return {
    accountCount: row?.accounts ?? 0,
    staffCount: row?.staff ?? 0,
    staffWithLine: row?.staff_line ?? 0,
    pastTickets: row?.past ?? 0,
    pastOpen: row?.past_open ?? 0,
  };
}
