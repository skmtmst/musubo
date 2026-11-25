import {
  threads,
  visible,
  latest,
  unread,
  storeEmailFilter,
  emailStatuses,
} from '../services/account-email-filter.js';
import { denyReadOnly } from '../middleware/role-guard.js';
import type { Context } from 'hono';
import { Hono } from 'hono';
import type { Env } from '../worker-env.js';
import { fail } from '../lib/fail.js';
import { inputJsonBoundary } from '../lib/input-errors.js';
import { parseOffsetPaging, buildCursorListResponse, buildOffsetListResponse } from '../lib/list-paging.js';

export const accountEmailInbox = new Hono<Env>();
accountEmailInbox.get('/inbox', async (c) => {
  const q = c.req.query();
  const { limit, offset } = parseOffsetPaging(q, { defaultLimit: 100, maxLimit: 200 });
  const filter = storeEmailFilter({
    statuses: emailStatuses(q.status),
    needsReply: q.quickFilter === 'reply',
    matchUnassigned: !q.assignee || ['all', 'unassigned'].includes(q.assignee),
    query: q.q,
    unreadOnly: ['1', 'true'].includes(q.unreadOnly),
    overdue: q.quickFilter === 'overdue',
  });
  const binds = [c.get('staff').id, c.req.param('accountId')!, ...filter.binds];
  const [rows, counts] = await c.env.DB.batch<Record<string, string | number | null>>([
    c.env.DB.prepare(
      `SELECT 'email:'||t.id AS id,t.id AS threadId,'email' AS channel,
      coalesce(nullif(t.customer_name,''),t.customer_email) AS customerName,t.customer_email AS customerIdentifier,
      t.subject,t.status,t.revision,NULL AS assignedStaffId,NULL AS assignedStaffName,
      t.last_message_at AS lastMessageAt,t.last_message_at AS lastIncomingAt,NULL AS lastOutgoingAt,
      ${unread} AS isUnread, (SELECT substr(body_text,1,300) FROM account_email_messages WHERE id=${latest}) AS preview
      ${filter.sql} ORDER BY isUnread DESC,t.last_message_at DESC,t.id DESC LIMIT ? OFFSET ?`,
    ).bind(...binds, limit, offset),
    c.env.DB.prepare(
      `SELECT COUNT(*) AS total,COUNT(CASE WHEN ${unread} THEN 1 END) AS unread,
      MIN(t.last_message_at) AS oldest ${filter.sql}`,
    ).bind(...binds),
  ]);
  const count = counts.results[0];
  return c.json({
    success: true,
    data: buildCursorListResponse({
      offset,
      nextOffset: offset + limit < Number(count.total) ? offset + limit : null,
      items: rows.results.map((row) => ({ ...row, isUnread: !!row.isUnread })),
      summary: {
        total: count.total,
        email: count.total,
        emailUnread: count.unread,
        line: 0,
        oldestWaitMinutes: count.oldest
          ? Math.max(0, Math.floor((Date.now() - Date.parse(String(count.oldest))) / 60_000))
          : null,
      },
      paging: { limit },
      sort: [],
    }),
  });
});
accountEmailInbox.get('/threads/:id', async (c) => {
  const account = c.req.param('accountId')!;
  const id = c.req.param('id');
  const q = c.req.query();
  const { limit } = parseOffsetPaging(q, { defaultLimit: 100, maxLimit: 200 });
  const cursor = q.before || q.after;
  const parts = cursor?.split('~');
  if ((q.before && q.after) || (parts && (parts.length !== 2 || parts.some((p) => !p || p.length > 100))))
    return fail(c, 400, '続きの位置が正しくありません');
  const db = c.env.DB;
  const threadScope = `${threads} WHERE ${visible} AND t.id=?`;
  const order = q.after ? 'ASC' : 'DESC';
  const slice = `SELECT m.id FROM account_email_messages m JOIN (SELECT t.id ${threadScope}) t ON t.id=m.thread_id
    ${parts ? 'WHERE (m.created_at,m.id) ' + (q.after ? '>' : '<') + ' (?,?)' : ''}
    ORDER BY m.created_at ${order},m.id ${order} LIMIT ?`;
  const binds = [account, id, ...(parts || [])];
  const [threadRows, messageRows, files, totals] = await db.batch<Record<string, string | number | null>>([
    db
      .prepare(
        `SELECT t.id,t.customer_email,t.customer_name,t.subject,t.status,t.revision,
      NULL AS assigned_staff_id,NULL AS notes,t.last_message_at,t.last_message_at AS last_incoming_at,
      NULL AS last_outgoing_at,NULL AS resolved_at ${threadScope}`,
      )
      .bind(account, id),
    db
      .prepare(
        `SELECT m.id,'incoming' AS direction,t.customer_email AS sender_email,t.customer_name AS sender_name,
      c.mailbox AS recipient_email,m.subject,m.body_text,NULL AS sent_by_staff_id,NULL AS sent_by_staff_name,m.created_at
      FROM account_email_messages m JOIN account_email_threads t ON t.id=m.thread_id
      JOIN account_email_connections c ON c.id=t.connection_id WHERE m.id IN (${slice}) ORDER BY m.created_at ${order},m.id ${order}`,
      )
      .bind(...binds, limit + 1),
    db
      .prepare(
        `SELECT message_id,id,filename,content_type AS contentType,size FROM account_email_attachments
      WHERE message_id IN (${slice})`,
      )
      .bind(...binds, limit),
    db
      .prepare(
        `SELECT COUNT(*) AS total,${q.after ? 'COUNT(CASE WHEN (created_at,id)<=(?,?) THEN 1 END)' : '0'} AS older FROM account_email_messages WHERE thread_id IN (SELECT t.id ${threadScope})`,
      )
      .bind(...(q.after && parts ? parts : []),account, id),
  ]);
  const thread = threadRows.results[0];
  if (!thread) return fail(c, 404, 'THREAD_NOT_FOUND');
  const page = messageRows.results.slice(0, limit);
  if (!q.after) page.reverse();
  const messages = page.map((m) => ({
    ...m,
    attachments: files.results.filter((f) => f.message_id === m.id),
  }));
  const position = (m: (typeof page)[number] | undefined) => (m ? m.created_at + '~' + m.id : null);
  return c.json({
    success: true,
    data: buildOffsetListResponse({
      thread,
      messages,
      items: messages,
      total: Number(totals.results[0].total),
      oldestCursor: position(page[0]),
      newestCursor: position(page.at(-1)),
      hasMoreOlder: q.after ? Number(totals.results[0].older) > 0 : messageRows.results.length > limit,
      paging: { limit },
      sort: [{ field: 'created_at', direction: 'asc' }],
    }),
  });
});
accountEmailInbox.get('/attachments/:id', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT a.filename,p.content FROM account_email_attachments a
      JOIN account_email_messages m ON m.id=a.message_id JOIN account_email_threads t ON t.id=m.thread_id
      JOIN account_email_connections c ON c.id=t.connection_id
      LEFT JOIN account_email_attachment_parts p ON p.attachment_id=a.id
      WHERE ${visible} AND a.id=? ORDER BY p.part`,
  )
    .bind(c.req.param('accountId'), c.req.param('id'))
    .all<{ filename: string; content: ArrayBuffer | number[] | null }>();
  const file = rows.results[0];
  if (!file) return fail(c, 404, '添付が見つかりません');
  const content = new Blob(
    rows.results.map((row) =>
      row.content instanceof ArrayBuffer ? row.content : new Uint8Array(row.content ?? []),
    ),
  );
  return new Response(content, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(file.filename),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    },
  });
});
accountEmailInbox.patch(
  '/threads/:id/status',
  denyReadOnly(),
  inputJsonBoundary({ status: ['string'], expectedRevision: ['number'] }),
  async (c) => {
    const { status, expectedRevision } = await c.req.json<{ status: string; expectedRevision: number }>();
    if (
      !emailStatuses('all').includes(status) ||
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 1
    )
      return fail(c, 400, '対応状況と版番号を確認してください');
    const account = c.req.param('accountId')!;
    const id = c.req.param('id');
    const target = `SELECT t.id ${threads} WHERE ${visible} AND t.id=?`;
    const row = await c.env.DB.prepare(
      `UPDATE account_email_threads SET status=?,revision=revision+1
    WHERE id IN (${target}) AND revision=? RETURNING status,revision`,
    )
      .bind(status, account, id, expectedRevision)
      .first();
    if (!row) {
      if (!(await c.env.DB.prepare(target).bind(account, id).first()))
        return fail(c, 404, 'THREAD_NOT_FOUND');
      return fail(c, 409, '新しいメールか変更が届いています。読み直してください');
    }
    return c.json({ success: true, data: row });
  },
);
async function markRead(c: Context<Env>) {
  const id = c.req.param('id');
  const result = await c.env.DB.prepare(
    `INSERT INTO account_email_reads(thread_id,staff_id,last_message_id)
      SELECT t.id,?,${latest} ${threads} WHERE ${visible} ${id ? 'AND t.id=?' : ''}
      ON CONFLICT(thread_id,staff_id) DO UPDATE SET last_message_id=excluded.last_message_id`,
  )
    .bind(c.get('staff').id, c.req.param('accountId'), ...(id ? [id] : []))
    .run();
  if (id && !result.meta.changes) return fail(c, 404, 'THREAD_NOT_FOUND');
  return c.json({ success: true, data: { marked: true, isUnread: false } });
}
accountEmailInbox.post('/threads/:id/read', inputJsonBoundary(), markRead);
accountEmailInbox.post('/read-all', inputJsonBoundary(), markRead);
