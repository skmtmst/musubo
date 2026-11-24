import { storeEmailFilter, accountEmailMode } from '../services/account-email-filter.js';
import { sqlIdSet } from '@line-crm/db/id-queries';
import { type InboxSavedViewConditions } from '@line-crm/db';

export async function countInboxSavedViewMatches(
  db: D1Database,
  input: {
    lineAccountId: string;
    staffId: string;
    canSeeUnassigned: boolean;
    conditions: InboxSavedViewConditions;
  },
): Promise<{ matchCount: number; matchCountCapped: boolean }> {
  const where: string[] = [
    'f.line_account_id = ?',
    `(c.id IS NOT NULL OR EXISTS (
      SELECT 1 FROM messages_log existing
       WHERE existing.friend_id = f.id
         AND (existing.delivery_type IS NULL OR existing.delivery_type != 'test')
    ))`,
  ];
  const bindings: unknown[] = [input.lineAccountId];
  const conditions = input.conditions;

  if (conditions.statuses.length < 4) {
    where.push(`COALESCE(c.status, 'resolved') IN (${conditions.statuses.map(() => '?').join(', ')})`);
    bindings.push(...conditions.statuses);
  }
  if (conditions.assignees.length > 0) {
    const clauses: string[] = [];
    const staffIds = conditions.assignees.filter(id => id.startsWith('staff:')).map(id => id.slice(6));
    const legacyIds = conditions.assignees.filter(id => id !== 'unassigned' && !id.startsWith('staff:'));
    if (conditions.assignees.includes('unassigned')) clauses.push('(c.assignee_staff_id IS NULL AND c.operator_id IS NULL)');
    if (staffIds.length) {
      const set = sqlIdSet(staffIds);
      clauses.push(`c.assignee_staff_id IN (${set.sql})`);
      bindings.push(...set.binds);
    }
    if (legacyIds.length) {
      const set = sqlIdSet(legacyIds);
      clauses.push(`(c.assignee_staff_id IS NULL AND c.operator_id IN (${set.sql}))`);
      bindings.push(...set.binds);
    }
    where.push(`(${clauses.join(' OR ')})`);
  }
  if (conditions.query) {
    /*
     * LIKE ではなく instr で部分一致する。
     * D1 の LIKE/GLOB パターンは最大50バイトのため、長い検索語で500になっていた。
     */
    where.push(`(instr(lower(f.display_name), lower(?)) > 0 OR EXISTS (
      SELECT 1 FROM messages_log searched
       WHERE searched.friend_id = f.id
         AND (searched.delivery_type IS NULL OR searched.delivery_type != 'test')
         AND instr(lower(searched.content), lower(?)) > 0
    ))`);
    bindings.push(conditions.query, conditions.query);
  }
  if (conditions.unread === 'mine') {
    where.push(`EXISTS (
      SELECT 1 FROM messages_log incoming
       WHERE incoming.friend_id = f.id AND incoming.direction = 'incoming'
         AND (incoming.delivery_type IS NULL OR incoming.delivery_type != 'test')
         AND (sr.last_read_at IS NULL OR incoming.created_at > sr.last_read_at)
    )`);
  }
  if (conditions.messageTypes.length > 0) {
    where.push(`(
      SELECT latest.message_type FROM messages_log latest
       WHERE latest.friend_id = f.id
         AND (latest.delivery_type IS NULL OR latest.delivery_type != 'test')
       ORDER BY latest.created_at DESC LIMIT 1
    ) IN (${conditions.messageTypes.map(() => '?').join(', ')})`);
    bindings.push(...conditions.messageTypes);
  }
  if (conditions.receivedFrom) {
    where.push(`EXISTS (
      SELECT 1 FROM messages_log received
       WHERE received.friend_id = f.id AND received.direction = 'incoming'
         AND received.created_at >= ?
         AND (received.delivery_type IS NULL OR received.delivery_type != 'test')
    )`);
    bindings.push(conditions.receivedFrom);
  }
  if (conditions.receivedTo) {
    where.push(`EXISTS (
      SELECT 1 FROM messages_log received
       WHERE received.friend_id = f.id AND received.direction = 'incoming'
         AND received.created_at <= ?
         AND (received.delivery_type IS NULL OR received.delivery_type != 'test')
    )`);
    bindings.push(conditions.receivedTo);
  }
  // 「要返信」は一覧APIの quickFilter=reply と同じく対応状況=未対応で数える。
  if (conditions.quickFilter === 'reply') {
    where.push(`COALESCE(c.status, 'resolved') = 'unread'`);
  }
  // quickFilter=overdue と due=overdue は同じ条件。古い行は due だけを持つ。
  if (conditions.due === 'overdue' || conditions.quickFilter === 'overdue') {
    where.push(`COALESCE(c.status, 'resolved') = 'unread'`);
    where.push(`COALESCE(c.last_customer_message_at, c.last_message_at) < datetime('now', '-1 hour')`);
  }

  const lineRow = input.conditions.channels.includes('line') ? await db.prepare(
    `SELECT COUNT(*) AS count FROM (
       SELECT f.id
         FROM friends f
         LEFT JOIN chats c ON c.id = (
           SELECT id FROM chats WHERE friend_id = f.id ORDER BY created_at DESC LIMIT 1
         )
         LEFT JOIN inbox_staff_reads sr
           ON sr.channel = 'line' AND sr.conversation_id = f.id AND sr.staff_id = ?
        WHERE ${where.join(' AND ')}
        LIMIT 1001
     )`,
  ).bind(input.staffId, ...bindings).first<{ count: number }>() : null;

  const resultCount = (count: number) => ({matchCount:Math.min(count,1000),matchCountCapped:count>1000});
  if (!conditions.channels.includes('email')) return resultCount(Number(lineRow?.count ?? 0));
  const mode = await accountEmailMode(db,input.lineAccountId,input.canSeeUnassigned);
  if (mode === 'none') return resultCount(Number(lineRow?.count ?? 0));
  let storeCount = 0;
  if (mode === 'store' || mode === 'both') {
    const filter = storeEmailFilter({
      statuses:conditions.messageTypes.length && !conditions.messageTypes.includes('text') ? [] : conditions.statuses,
      needsReply:conditions.quickFilter==='reply',
      matchUnassigned:!conditions.assignees.length || conditions.assignees.includes('unassigned'),
      query:conditions.query,unreadOnly:conditions.unread==='mine',overdue:conditions.due==='overdue' || conditions.quickFilter==='overdue',
      from:conditions.receivedFrom,to:conditions.receivedTo,
    });
    const row = await db.prepare(`SELECT COUNT(*) AS count FROM (SELECT t.id ${filter.sql} LIMIT 1001)`)
      .bind(input.staffId,input.lineAccountId,...filter.binds).first<{count:number}>();
    storeCount = Number(row?.count ?? 0);
    if (mode === 'store') return resultCount(Number(lineRow?.count ?? 0) + storeCount);
  }
  const emailWhere: string[] = [];
  const emailBindings: unknown[] = [];
  if (conditions.statuses.length < 4) {
    emailWhere.push(`t.status IN (${conditions.statuses.map(() => '?').join(', ')})`);
    emailBindings.push(...conditions.statuses);
  }
  if (conditions.assignees.length > 0) {
    const named = conditions.assignees.filter((id) => id !== 'unassigned').map(id => id.startsWith('staff:') ? id.slice(6) : id);
    const clauses: string[] = [];
    if (conditions.assignees.includes('unassigned')) clauses.push('t.assigned_staff_id IS NULL');
    if (named.length > 0) {
      clauses.push(`t.assigned_staff_id IN (${sqlIdSet(named).sql})`);
      emailBindings.push(...(named.length ? sqlIdSet(named).binds : []));
    }
    emailWhere.push(`(${clauses.join(' OR ')})`);
  }
  if (conditions.query) {
    // LIKE ではなく instr。D1 の LIKE 50バイト制限で長い検索語が500になっていた。
    emailWhere.push(`(instr(lower(t.customer_email), lower(?)) > 0
      OR instr(lower(t.customer_name), lower(?)) > 0
      OR instr(lower(t.subject), lower(?)) > 0
      OR EXISTS (
      SELECT 1 FROM support_email_messages searched
       WHERE searched.thread_id = t.id AND instr(lower(searched.body_text), lower(?)) > 0
    ))`);
    emailBindings.push(conditions.query, conditions.query, conditions.query, conditions.query);
  }
  if (conditions.unread === 'mine') {
    emailWhere.push('(sr.last_read_at IS NULL OR t.last_incoming_at > sr.last_read_at)');
  }
  if (conditions.messageTypes.length > 0 && !conditions.messageTypes.includes('text')) {
    emailWhere.push('0=1');
  }
  if (conditions.receivedFrom) {
    emailWhere.push('t.last_incoming_at >= ?');
    emailBindings.push(conditions.receivedFrom);
  }
  if (conditions.receivedTo) {
    emailWhere.push('t.last_incoming_at <= ?');
    emailBindings.push(conditions.receivedTo);
  }
  if (conditions.quickFilter === 'reply') {
    emailWhere.push(`t.status = 'unread'`);
  }
  if (conditions.due === 'overdue' || conditions.quickFilter === 'overdue') {
    emailWhere.push(`t.status = 'unread'`);
    emailWhere.push(`t.last_incoming_at < datetime('now', '-1 hour')`);
  }
  const emailRow = input.conditions.channels.includes('email') && input.canSeeUnassigned
    ? await db.prepare(
      `SELECT COUNT(*) AS count FROM (
         SELECT t.id
           FROM support_email_threads t
           LEFT JOIN inbox_staff_reads sr
             ON sr.channel = 'email' AND sr.conversation_id = t.id AND sr.staff_id = ?
          ${emailWhere.length > 0 ? `WHERE ${emailWhere.join(' AND ')}` : ''}
          LIMIT 1001
       )`,
    ).bind(input.staffId,...emailBindings).first<{ count: number }>()
    : null;
  const rawCount = Number(lineRow?.count ?? 0) + storeCount + Number(emailRow?.count ?? 0);
  return { matchCount: Math.min(rawCount, 1000), matchCountCapped: rawCount > 1000 };
}
