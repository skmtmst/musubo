import { storeEmailFilter, emailStatuses, accountEmailMode } from '../services/account-email-filter.js';
import { assigneeFilter } from '../services/chat-assignees.js';
import { listChatAssignees } from '../services/chat-assignees.js';
import { DEFAULT_TENANT_ID } from '@line-crm/shared';
import { sqlIdSet } from '@line-crm/db/id-queries';
import { inputError } from '../lib/input-errors.js';

import { getOperatorById, createOperator, updateOperator, deleteOperator } from '@line-crm/db';
import type { Env } from '../worker-env.js';
import { parseOffsetPaging, buildOffsetListResponse } from '../lib/list-paging.js';

import { listOutboundSendFailures } from '../services/outbound-idempotency.js';
import { canAccessAllLineAccounts, getVisibleLineAccountScope } from '../services/account-access.js';
import type { Context } from 'hono';
import { instagramInboxCounts } from '../services/instagram-inbox-list.js';

export const get__api_operators_1 = async (c: Context<Env, "/api/operators">) => {
  try {
    const scope = await getVisibleLineAccountScope(c.env.DB, c.get('staff'));
    const requested = c.req.query('lineAccountId');
    if (requested && !scope.allowedAccountIds.includes(requested)) return c.json({success:false,error:'アカウントが見つかりません'}, 404);
    if (c.req.query('channel') === 'email' && !scope.canSeeUnassigned) return c.json({success:false,error:'受信箱が見つかりません'}, 404);
    const sharedInbox = c.req.query('channel') === 'email';
    const accounts = requested ? [requested] : scope.allowedAccountIds;
    const items = await listChatAssignees(c.env.DB, c.get('staff')?.tenantId ?? DEFAULT_TENANT_ID, accounts, sharedInbox);
    return c.json({
      success: true,
      data: items.map((o) => ({
        id: o.id,
        name: o.name,
      })),
    });
  } catch (err) {
    throw err;
  }
};

export const post__api_operators_2 = async (c: Context<Env, "/api/operators">) => {
  try {
    const body = await c.req.json<{ name: string; email: string; role?: string }>();
    if (!body.name || !body.email) return inputError(c, { success: false, error: 'name and email are required' }, 400, ["name","email"]);
    const item = await createOperator(c.env.DB, body);
    return c.json({ success: true, data: { id: item.id, name: item.name, email: item.email, role: item.role } }, 201);
  } catch (err) {
    throw err;
  }
};

export const put__api_operators_id_3 = async (c: Context<Env, "/api/operators/:id">) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json();
    await updateOperator(c.env.DB, id, body);
    const updated = await getOperatorById(c.env.DB, id);
    if (!updated) return c.json({ success: false, error: 'Not found' }, 404);
    return c.json({ success: true, data: { id: updated.id, name: updated.name, email: updated.email, role: updated.role, isActive: Boolean(updated.is_active) } });
  } catch (err) {
    throw err;
  }
};

export const delete__api_operators_id_4 = async (c: Context<Env, "/api/operators/:id">) => {
  try {
    await deleteOperator(c.env.DB, c.req.param('id'));
    return c.json({ success: true, data: null });
  } catch (err) {
    throw err;
  }
};

export const get__api_chats_stats_5 = async (c: Context<Env, "/api/chats/stats">) => {
  try {
    const { getInboxStats } = await import('@line-crm/db');
    const { getVisibleLineAccountScope } = await import('../services/account-access.js');
    const staff = c.get('staff');
    const accountScope = await getVisibleLineAccountScope(c.env.DB, staff);
    const requested = c.req.query('lineAccountId');
    if (requested && !accountScope.allowedAccountIds.includes(requested)) return c.json({ success: false, error: '受信箱が見つかりません' }, 404);
    const stats = await getInboxStats(c.env.DB, staff?.id ?? null, {
      allowedAccountIds: requested ? [requested] : accountScope.allowedAccountIds,
      includeUnassigned: requested ? false : accountScope.canSeeUnassigned,
    });
    return c.json({ success: true as const, data: stats });
  } catch (err) {
    throw err;
  }
};

export const get__api_chats_quick_counts_6 = async (c: Context<Env, "/api/chats/quick-counts">) => {
  try {
    const staff = c.get('staff');
    const status = c.req.query('status') ?? undefined;
    const operatorId = c.req.query('operatorId') ?? undefined;
    const assignee = c.req.query('assignee') ?? operatorId;
    const unreadOnly = c.req.query('unreadOnly') === '1' || c.req.query('unreadOnly') === 'true';
    const channel = c.req.query('channel') || 'all';
    if (channel !== 'all' && channel !== 'line' && channel !== 'email' && channel !== 'instagram') {
      return c.json({ success: false as const, error: 'invalid_channel' }, 400);
    }
    const lineAccountId = c.req.query('lineAccountId') ?? undefined;
    const query = (c.req.query('q') ?? '').trim().slice(0, 200);
    const scope = await getVisibleLineAccountScope(c.env.DB, staff);
    if (lineAccountId && !scope.allowedAccountIds.includes(lineAccountId)) {
      return c.json({ success: false as const, error: '受信箱が見つかりません' }, 404);
    }

    // 「1時間以上待ち」の基準時刻。一覧の quickFilter=overdue と同じ定義:
    // 対応状況が未対応で、表示される最後のメッセージ（受信・送信どちらでも）
    // から1時間以上。対応期限の記録はまだ無い。
    const overdueThreshold = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    let line = { all: 0, reply: 0, overdue: 0 };
    let email = { all: 0, reply: 0, overdue: 0 };

    if (channel !== 'email' && channel !== 'instagram') {
      // ── LINE 側。一覧クエリと同じ候補集合（messages_log ∪ chats）を
      // 同じ条件で数える。preview 用の集約は不要なので CTE 2本だけ。 ──
    const accountFilterBindings: string[] = [];
      let accountFilterSql: string;
      if (lineAccountId) {
        accountFilterSql = `friend_id IN (SELECT id FROM friends WHERE line_account_id = ?)`;
        accountFilterBindings.push(lineAccountId);
      } else {
        const accountClauses: string[] = [];
        if (scope.allowedAccountIds.length > 0) {
          accountClauses.push(
            `line_account_id IN (${sqlIdSet(scope.allowedAccountIds).sql})`,
          );
          accountFilterBindings.push(...(scope.allowedAccountIds.length ? sqlIdSet(scope.allowedAccountIds).binds : []));
        }
        if (scope.canSeeUnassigned) accountClauses.push('line_account_id IS NULL');
        accountFilterSql = accountClauses.length > 0
          ? `friend_id IN (SELECT id FROM friends WHERE ${accountClauses.join(' OR ')})`
          : '0=1';
      }

      const conditions: string[] = [];
      const conditionBindings: unknown[] = [];
      if (status && status !== 'all') {
        conditions.push(`COALESCE(c.status, 'resolved') = ?`);
        conditionBindings.push(status);
      }
      if (operatorId) {
        const filter = assigneeFilter('c', operatorId, true);
        conditions.push(filter.sql);
        conditionBindings.push(...filter.binds);
      }
      if (unreadOnly) {
        conditions.push(`EXISTS (
          SELECT 1 FROM messages_log incoming
          LEFT JOIN inbox_staff_reads reads
            ON reads.channel = 'line' AND reads.conversation_id = f.id AND reads.staff_id = ?
          WHERE incoming.friend_id = f.id AND incoming.direction = 'incoming'
            AND (incoming.delivery_type IS NULL OR incoming.delivery_type != 'test')
            AND (reads.last_read_at IS NULL OR incoming.created_at > reads.last_read_at)
        )`);
        conditionBindings.push(staff.id);
      }
      if (lineAccountId) {
        conditions.push('f.line_account_id = ?');
        conditionBindings.push(lineAccountId);
      }
      if (query) {
        // LIKE ではなく instr。D1 の LIKE 50バイト制限で長い検索語が500になっていた。
        conditions.push(`(
          instr(lower(f.display_name), lower(?)) > 0 OR EXISTS (
            SELECT 1 FROM messages_log mq
            WHERE mq.friend_id = f.id
              AND (mq.delivery_type IS NULL OR mq.delivery_type != 'test')
              AND instr(lower(mq.content), lower(?)) > 0
          )
        )`);
        conditionBindings.push(query, query);
      }

      const countsRow = await c.env.DB.prepare(`
        WITH last_any AS MATERIALIZED (
          SELECT friend_id, MAX(COALESCE(line_event_at, created_at)) AS last_message_at
          FROM messages_log
          WHERE (delivery_type IS NULL OR delivery_type != 'test')
            AND ${accountFilterSql}
          GROUP BY friend_id
        ),
        deduped AS MATERIALIZED (
          SELECT friend_id, MAX(last_message_at) AS last_message_at FROM (
            SELECT friend_id, last_message_at FROM last_any
            UNION ALL
            SELECT friend_id, last_message_at FROM chats WHERE ${accountFilterSql}
          ) GROUP BY friend_id
        )
        SELECT
          COUNT(*) AS all_count,
          SUM(CASE WHEN COALESCE(c.status, 'resolved') = 'unread' THEN 1 ELSE 0 END) AS reply_count,
          SUM(CASE WHEN COALESCE(c.status, 'resolved') = 'unread'
                AND julianday(COALESCE((
                  SELECT MAX(COALESCE(latest.line_event_at, latest.created_at)) FROM messages_log latest
                  WHERE latest.friend_id = f.id
                    AND (latest.delivery_type IS NULL OR latest.delivery_type != 'test')
                ), d.last_message_at)) <= julianday(?)
              THEN 1 ELSE 0 END) AS overdue_count
        FROM deduped d
        INNER JOIN friends f ON f.id = d.friend_id
        LEFT JOIN chats c ON c.id = (
          SELECT id FROM chats WHERE friend_id = f.id ORDER BY created_at DESC LIMIT 1
        )
        WHERE 1=1
        ${conditions.length > 0 ? 'AND ' + conditions.join(' AND ') : ''}
      `).bind(
        ...accountFilterBindings,
        ...accountFilterBindings,
        overdueThreshold,
        ...conditionBindings,
      ).first<{ all_count: number | null; reply_count: number | null; overdue_count: number | null }>();
      line = {
        all: countsRow?.all_count ?? 0,
        reply: countsRow?.reply_count ?? 0,
        overdue: countsRow?.overdue_count ?? 0,
      };
    }

    const mode = channel === 'line' || channel === 'instagram' ? 'none' : await accountEmailMode(c.env.DB,lineAccountId,scope.canSeeUnassigned);
    if ((mode === 'store' || mode === 'both') && lineAccountId) {
      const filter = storeEmailFilter({statuses:emailStatuses(status || 'all'),
        matchUnassigned:!assignee || assignee==='unassigned',query,unreadOnly});
      const counts = await c.env.DB.prepare(`SELECT count(*) AS total,count(CASE WHEN t.status='unread' THEN 1 END) AS reply,
        count(CASE WHEN t.status='unread' AND julianday(t.last_message_at)<=julianday(?) THEN 1 END) AS overdue ${filter.sql}`)
        .bind(overdueThreshold,staff.id,lineAccountId,...filter.binds).first<{total:number; reply:number; overdue:number}>();
      email = {all:counts?.total ?? 0,reply:counts?.reply ?? 0,overdue:counts?.overdue ?? 0};
    }
    if (mode === 'legacy' || mode === 'both') {
      const statusSql = !status || status === 'all'
        ? '1=1'
        : status === 'resolved'
          ? `t.status = 'resolved'`
          : status === 'unread' || status === 'in_progress' || status === 'on_hold'
            ? 't.status = ?'
            : `t.status != 'resolved'`;
      // SQL 上の placeholder 順は overdue閾値（SELECT内）→ staff_id（join）→ 条件値。
      const bindings: Array<string | number> = [];
      if (status === 'unread' || status === 'in_progress' || status === 'on_hold') bindings.push(status);
      let searchSql = '';
      if (query) {
        // LIKE ではなく instr。D1 の LIKE 50バイト制限で長い検索語が500になっていた。
        searchSql = `AND (
          instr(lower(t.customer_email), lower(?)) > 0
          OR instr(lower(t.customer_name), lower(?)) > 0
          OR instr(lower(t.subject), lower(?)) > 0
          OR EXISTS (
            SELECT 1 FROM support_email_messages searched
            WHERE searched.thread_id = t.id AND instr(lower(searched.body_text), lower(?)) > 0
          )
        )`;
        bindings.push(query, query, query, query);
      }
      if (assignee) {
        if (assignee === 'unassigned') searchSql += ' AND t.assigned_staff_id IS NULL';
        else {
          searchSql += ' AND t.assigned_staff_id = ?';
          bindings.push(assignee.startsWith('staff:') ? assignee.slice(6) : assignee);
        }
      }
      if (unreadOnly) {
        searchSql += ' AND (sr.last_read_at IS NULL OR t.last_incoming_at > sr.last_read_at)';
      }
      const emailCounts = await c.env.DB.prepare(
        `SELECT COUNT(*) AS all_count,
                SUM(CASE WHEN t.status = 'unread' THEN 1 ELSE 0 END) AS reply_count,
                SUM(CASE WHEN t.status = 'unread'
                      AND julianday(t.last_incoming_at) <= julianday(?)
                    THEN 1 ELSE 0 END) AS overdue_count
         FROM support_email_threads t
         LEFT JOIN inbox_staff_reads sr
           ON sr.channel = 'email'
          AND sr.conversation_id = t.id
          AND sr.staff_id = ?
         WHERE ${statusSql} ${searchSql}`,
      ).bind(overdueThreshold, staff.id, ...bindings)
        .first<{ all_count: number | null; reply_count: number | null; overdue_count: number | null }>();
      email = {
        all: email.all + (emailCounts?.all_count ?? 0),
        reply: email.reply + (emailCounts?.reply_count ?? 0),
        overdue: email.overdue + (emailCounts?.overdue_count ?? 0),
      };
    }

    const includeInstagram = (channel === 'instagram' || channel === 'all' || c.req.query('socialChannel') === 'all') && channel !== 'email' && !status && !assignee;
    const instagram = includeInstagram ? await instagramInboxCounts(c.env.DB, {
      accounts: lineAccountId ? [lineAccountId] : scope.allowedAccountIds, staffId: staff.id, query, unreadOnly,
    }) : { all: 0, reply: 0, overdue: 0 };
    return c.json({
      success: true as const,
      data: {
        all: line.all + email.all + instagram.all,
        reply: line.reply + email.reply + instagram.reply,
        overdue: line.overdue + email.overdue,
        line,
        email,
        instagram,
      },
    });
  } catch (err) {
    throw err;
  }
};

export const get__api_chats_outbound_failures_7 = async (c: Context<Env, "/api/chats/outbound-failures">) => {
  try {
    const lineAccountId = c.req.query('lineAccountId')?.trim();
    if (!lineAccountId) {
      return c.json({ success: false, error: 'LINE公式アカウントを選んでください' }, 400);
    }
    if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [lineAccountId])) {
      return c.json({ success: false, error: '送信失敗履歴が見つかりません' }, 404);
    }
    const paging = parseOffsetPaging({ limit: c.req.query('limit') }, { defaultLimit: 50, maxLimit: 100 });
    const failures = await listOutboundSendFailures(c.env.DB, { lineAccountId, limit: paging.limit });
    return c.json(buildOffsetListResponse({ success: true, data: failures, items: failures, total: null, paging, sort: [] }));
  } catch (err) {
    throw err;
  }
};
