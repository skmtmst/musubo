import { assigneeFilter } from '../services/chat-assignees.js';
import { chatAssigneeId } from '../services/chat-assignees.js';
import { slaChatList, enrichSlaChats } from '../services/inbox-sla-list.js';
import { refreshInboxSla } from '../services/inbox-sla.js';
import { sqlIdSet } from '@line-crm/db/id-queries';
import { fail } from '../lib/fail.js';
import { getChatById, getFriendById, markInboxConversationRead, jstNow } from '@line-crm/db';
import type { Env } from '../worker-env.js';
import { buildCursorListResponse, listLimit, listQueryNumber } from '../lib/list-paging.js';

import { getVisibleLineAccountScope } from '../services/account-access.js';
import { resolveOrCreateChat } from './chats-definition.js';
import type { Context } from 'hono';

export const get__api_chats_1 = async (c: Context<Env, "/api/chats">) => {
  if(c.req.query('sort')==='sla_due'||['overdue','soon'].includes(c.req.query('slaState')??'')) return slaChatList(c);
  try {
    const staff = c.get('staff');
    const status = c.req.query('status') ?? undefined;
    const operatorId = c.req.query('operatorId') ?? undefined;
    const unreadOnly = c.req.query('unreadOnly') === '1' || c.req.query('unreadOnly') === 'true';
    const quickFilter = c.req.query('quickFilter');
    if (quickFilter && quickFilter !== 'reply' && quickFilter !== 'overdue') {
      return c.json({ success: false, error: 'invalid_quick_filter' }, 400);
    }
    // 並び: 既定は「未読が先 → 新しい順」。latest は未読を先にせず新しい順だけで並べる。
    const sortParam = c.req.query('sort');
    if (sortParam && sortParam !== 'unread_first' && sortParam !== 'latest') {
      return c.json({ success: false, error: 'invalid_sort' }, 400);
    }
    const unreadFirst = sortParam !== 'latest';
    const lineAccountId = c.req.query('lineAccountId') ?? undefined;
    const query = (c.req.query('q') ?? '').trim().slice(0, 200);
    const visibleScope = await getVisibleLineAccountScope(c.env.DB, staff);
    if (lineAccountId && !visibleScope.allowedAccountIds.includes(lineAccountId)) {
      return c.json({ success: false, error: '受信箱が見つかりません' }, 404);
    }
    const unansweredOnly =
      c.req.query('unansweredOnly') === 'true' || c.req.query('unansweredOnly') === '1';

    if (unansweredOnly) {
      if (unreadOnly || quickFilter || operatorId === 'unassigned') {
        return c.json({ success: false, error: 'incompatible_filters' }, 400);
      }
      const requestedLimit = listQueryNumber(c.req.query('limit'), '', { format: 'integer-prefix' });
      const limit = Number.isFinite(requestedLimit)
        ? Math.min(200, Math.max(1, requestedLimit))
        : 200;
      const { computeUnansweredInbox } = await import('../services/unanswered-inbox.js');
      const unanswered = await computeUnansweredInbox(c.env.DB, {
        q: query || undefined,
        account: lineAccountId,
        status,
        operatorId,
        page: 1,
        pageSize: limit,
        allowedAccountIds: visibleScope.allowedAccountIds,
        canSeeUnassigned: visibleScope.canSeeUnassigned,
      });
      if (unanswered.rows.length === 0) return c.json(buildCursorListResponse({ success: true, data: [], items: [], paging: { limit }, sort: [] }));

      // 未対応サービスで確定した最大200人だけの会話メタ情報を取る。
      // json_each へID配列を1 bindで渡すため、D1の100 bind上限にも当たらない。
      const chatRows = await c.env.DB.prepare(
        `SELECT f.id AS friend_id, f.display_name, f.picture_url,
                CASE WHEN json_valid(f.metadata) THEN json_extract(f.metadata, '$.__attention') = '1' ELSE 0 END AS is_attention,
                COALESCE(CASE WHEN c.assignee_staff_id IS NOT NULL THEN 'staff:' || c.assignee_staff_id END, c.operator_id) AS operator_id, CASE WHEN c.assignee_staff_id IS NOT NULL THEN COALESCE((SELECT name FROM staff_members WHERE id=c.assignee_staff_id), '担当者不明') WHEN c.operator_id IS NOT NULL THEN COALESCE((SELECT name FROM operators WHERE id=c.operator_id), '担当者不明') END AS operator_name, c.status, c.revision, c.notes,
                CASE
                  WHEN c.last_customer_message_at IS NOT NULL
                   AND (sr.last_read_at IS NULL OR c.last_customer_message_at > sr.last_read_at)
                  THEN 1 ELSE 0
                END AS is_unread_for_staff,
                c.created_at, c.updated_at
           FROM friends f
           INNER JOIN chats c ON c.friend_id = f.id
           LEFT JOIN inbox_staff_reads sr
             ON sr.channel = 'line'
            AND sr.conversation_id = f.id
            AND sr.staff_id = ?
          WHERE f.id IN (SELECT value FROM json_each(?))`,
      ).bind(staff.id, JSON.stringify(unanswered.rows.map((row) => row.friendId))).all<Record<string, unknown>>();
      const byFriend = new Map(chatRows.results.map((row) => [row.friend_id as string, row]));
      const data = unanswered.rows.flatMap((row) => {
        const chat = byFriend.get(row.friendId);
        if (!chat) return [];
        return [{
          id: row.friendId,
          friendId: row.friendId,
          friendName: row.displayName || '名前なし',
          friendPictureUrl: row.pictureUrl,
          isAttention: Boolean(chat.is_attention),
          operatorId: chat.operator_id,
          operatorName: chat.operator_name,
          status: chat.status,
          revision: Number(chat.revision ?? 0),
          notes: chat.notes,
          lastMessageAt: row.lastIncomingAt,
          lastMessageContent: row.lastIncomingType === 'text' ? row.lastIncomingContent : null,
          lastMessageDirection: 'incoming' as const,
          lastMessageType: row.lastIncomingType,
          isUnread: Boolean(chat.is_unread_for_staff),
          createdAt: chat.created_at,
          updatedAt: chat.updated_at,
        }];
      });
      const responseItems = data;
      return c.json(buildCursorListResponse({ success: true, data, items: responseItems, paging: { limit }, sort: [] }));
    }

    // 送受信履歴と chats の和集合で、初回メッセージ前のチャットも一覧へ含める。履歴の最大値と MATERIALIZED CTE を使い、ページの友だちを先に確定してからプレビューを求める。大きな応答を防ぐため、テキストだけ先頭200文字へ制限し、アカウント指定時はその友だちへ絞る。並びは未読・最終日時・友だち ID の降順で安定させる。
    for(const account of visibleScope.allowedAccountIds) await refreshInboxSla(c.env.DB,account);
    const accountFilterBindings: string[] = [];
    let accountFilterSql: string;
    if (lineAccountId) {
      accountFilterSql = `friend_id IN (SELECT id FROM friends WHERE line_account_id = ?)`;
      accountFilterBindings.push(lineAccountId);
    } else {
      const accountClauses: string[] = [];
      if (visibleScope.allowedAccountIds.length > 0) {
        accountClauses.push(
          `line_account_id IN (${sqlIdSet(visibleScope.allowedAccountIds).sql})`,
        );
        accountFilterBindings.push(...(visibleScope.allowedAccountIds.length ? sqlIdSet(visibleScope.allowedAccountIds).binds : []));
      }
      if (visibleScope.canSeeUnassigned) accountClauses.push('line_account_id IS NULL');
      accountFilterSql = accountClauses.length > 0
        ? `friend_id IN (SELECT id FROM friends WHERE ${accountClauses.join(' OR ')})`
        : '0=1';
    }

    // 不正値や負値を SQLite の「LIMIT 無制限」に渡さず、未対応絞り込みも含めて
    // 1回の応答を最大200件に止める。未対応一覧は上の専用DBページングで扱う。
    const limit = listLimit(c.req.query('limit'), 200);
    // カーソルページング: (未読, last_message_at, friend_id) の複合カーソルより後の行を返す。
    // 一覧は「未読が先 → 最新の受信・送信が新しい順」。offset 方式は「取得の合間に
    // 新着で行が押し下げられた分が欠落する」構造問題があるため採用しない。
    // friend_id は同時刻 (broadcast 一斉配信等) のタイブレーク。
    // beforeUnread が無い古い渡し方は、時刻だけの従来条件に倒す。
    // sort=latest のカーソルは (last_message_at, friend_id) だけで、beforeUnread は見ない。
    const beforeAt = c.req.query('beforeAt') || undefined;
    const beforeId = c.req.query('beforeId') || undefined;
    const beforeUnreadRaw = c.req.query('beforeUnread');
    const beforeUnread = !unreadFirst ? null : beforeUnreadRaw === '1' || beforeUnreadRaw === 'true'
      ? 1
      : beforeUnreadRaw === '0' || beforeUnreadRaw === 'false' ? 0 : null;
    const useCursor = Boolean(beforeAt && beforeId);

    const conditions: string[] = [];
    const conditionBindings: unknown[] = [];
    if (status) {
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
    if (quickFilter) {
      conditions.push(`COALESCE(c.status, 'resolved') = 'unread'`);
      if (quickFilter === 'overdue') {
        // 一覧に表示する最新時刻と同じ定義（受信時刻 line_event_at があれば
        // そちらを正とし、無ければ保存時刻。件数側の overdue_count と共通）。
        // created_at だけを見ると、遅れて届いた受信の待ち時間を短く数え、
        // 札の件数を押しても対象が一覧に出なくなる。
        conditions.push(`julianday(COALESCE((
          SELECT MAX(COALESCE(latest.line_event_at, latest.created_at)) FROM messages_log latest
          WHERE latest.friend_id = f.id
            AND (latest.delivery_type IS NULL OR latest.delivery_type != 'test')
        ), d.last_message_at)) <= julianday(?)`);
        conditionBindings.push(new Date(Date.now() - 60 * 60 * 1000).toISOString());
      }
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
    // status / operator filter は chats を参照するので、その時だけ page CTE 側でも
    // chats を lookup する (無条件時は 全friend × chats lookup を省く)。
    const pageNeedsChats = Boolean(status || operatorId || quickFilter);

    // preview は **最新の incoming (ユーザー発)** を優先する。auto_reply / scenario 等の
    // outbound が直後に書き込まれて preview を上書きすると「ユーザーが何と言ったか」が
    // 一覧から見えなくなる (operator triage の主目的が損なわれる)。
    // incoming が無い (broadcast push など outbound only) chat は最新 outbound にフォールバック。
    // text 以外 (flex/image/sticker 等) は content を NULL にして payload size を抑える
    // (フロントは type で 📋 Flex / 📷 画像 等のラベルを出すので content は不要)。
    // any_agg の bare column (content 等) は「単一 MAX を含む集約は max 行の
    // 値を返す」という SQLite の documented 挙動で argmax として使っている。
    // 集約は page 確定後の friend に絞って実行する (全 friend 分の content を
    // materialize しない)。last_any は並び順決定専用のスリムな全走査 1 回のみ。
    // 一覧の並びは「未読が先 → 最新の受信・送信が新しい順」。
    // 未読は担当者ごとの既読位置で決まる (最後の受信より既読が古い = 未読)。
    // page 確定の前に要るので、受信の最新は last_any の集計から取る。
    // 最終段の is_unread_for_staff と同じ定義 (受信なしは既読扱い)。
    const unreadExpr = `CASE
      WHEN la.last_incoming_at IS NOT NULL
       AND (sr.last_read_at IS NULL OR la.last_incoming_at > sr.last_read_at)
      THEN 1 ELSE 0
    END`;
    const sql = `
      WITH last_any AS MATERIALIZED (
        SELECT friend_id,
          MAX(COALESCE(line_event_at, created_at)) AS last_message_at,
          MAX(CASE WHEN direction = 'incoming' THEN created_at END) AS last_incoming_at
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
      ),
      page AS MATERIALIZED (
        SELECT d.friend_id, d.last_message_at, ${unreadExpr} AS is_unread
        FROM deduped d
        INNER JOIN friends f ON f.id = d.friend_id
        LEFT JOIN last_any la ON la.friend_id = d.friend_id
        LEFT JOIN inbox_staff_reads sr
          ON sr.channel = 'line'
         AND sr.conversation_id = d.friend_id
         AND sr.staff_id = ?
        ${pageNeedsChats ? `LEFT JOIN chats c ON c.id = (
          SELECT id FROM chats WHERE friend_id = f.id ORDER BY created_at DESC LIMIT 1
        )` : ''}
        WHERE 1=1
        ${conditions.length > 0 ? 'AND ' + conditions.join(' AND ') : ''}
        ${useCursor
          ? beforeUnread == null
            ? 'AND (d.last_message_at < ? OR (d.last_message_at = ? AND d.friend_id < ?))'
            : `AND (${unreadExpr} < ? OR (${unreadExpr} = ? AND (d.last_message_at < ? OR (d.last_message_at = ? AND d.friend_id < ?))))`
          : ''}
        ORDER BY ${unreadFirst ? 'is_unread DESC, ' : ''}d.last_message_at DESC, d.friend_id DESC
        LIMIT ?
      ),
      any_agg AS (
        SELECT friend_id,
          CASE
            WHEN unsent_at IS NOT NULL THEN NULL
            WHEN message_type = 'text' THEN SUBSTR(content, 1, 200)
            ELSE NULL
          END AS content,
          direction,
          CASE WHEN unsent_at IS NOT NULL THEN 'unsent' ELSE message_type END AS message_type,
          MAX(created_at) AS created_at
        FROM messages_log
        WHERE (delivery_type IS NULL OR delivery_type != 'test')
          AND friend_id IN (SELECT friend_id FROM page)
        GROUP BY friend_id
      ),
      latest_incoming AS (
        SELECT friend_id, MAX(created_at) AS last_incoming_at
        FROM messages_log
        WHERE direction = 'incoming'
          AND (delivery_type IS NULL OR delivery_type != 'test')
          AND friend_id IN (SELECT friend_id FROM page)
        GROUP BY friend_id
      ),
      /*
       * 一覧に出す1行は「最後のメッセージ」。送信でも受信でも、いちばん新しいもの。
       *
       * 以前は受信を優先していた（incoming があればそちらを出す）。そのせいで、
       * こちらが返信したあとも一覧には古い受信が出たままで、返したのかどうかが
       * 一覧から読めなかった。
       *
       * 「返信を待っている人」の判定は unanswered-inbox サービスが別に持っている
       * ので、ここを最新に変えても未対応の数え方は変わらない。
       */
      recent_msg AS (
        SELECT a.friend_id,
          a.content AS content,
          a.direction AS direction,
          a.message_type AS message_type,
          a.created_at AS preview_at
        FROM any_agg a
      )
      SELECT
        f.id AS id,
        f.id AS friend_id,
        f.display_name,
        f.picture_url,
        CASE WHEN json_valid(f.metadata) THEN json_extract(f.metadata, '$.__attention') = '1' ELSE 0 END AS is_attention,
        f.line_platform_user_id AS line_user_id,
        f.line_account_id,
        COALESCE(CASE WHEN c.assignee_staff_id IS NOT NULL THEN 'staff:' || c.assignee_staff_id END, c.operator_id) AS operator_id, CASE WHEN c.assignee_staff_id IS NOT NULL THEN COALESCE((SELECT name FROM staff_members WHERE id=c.assignee_staff_id), '担当者不明') WHEN c.operator_id IS NOT NULL THEN COALESCE((SELECT name FROM operators WHERE id=c.operator_id), '担当者不明') END AS operator_name,
        COALESCE(c.status, 'resolved') AS status,
        COALESCE(c.revision, 0) AS revision,
        c.notes,
        COALESCE(rm.preview_at, d.last_message_at) AS last_message_at,
        rm.content AS last_message_content,
        rm.direction AS last_message_direction,
        rm.message_type AS last_message_type,
        CASE
          WHEN ri.last_incoming_at IS NOT NULL
           AND (sr.last_read_at IS NULL OR ri.last_incoming_at > sr.last_read_at)
          THEN 1 ELSE 0
        END AS is_unread_for_staff,
        COALESCE(c.created_at, d.last_message_at) AS created_at,
        COALESCE(c.updated_at, d.last_message_at) AS updated_at
      FROM page d
      INNER JOIN friends f ON f.id = d.friend_id
      LEFT JOIN chats c ON c.id = (
        SELECT id FROM chats WHERE friend_id = f.id ORDER BY created_at DESC LIMIT 1
      )
      LEFT JOIN recent_msg rm ON rm.friend_id = f.id
      LEFT JOIN latest_incoming ri ON ri.friend_id = f.id
      LEFT JOIN inbox_staff_reads sr
        ON sr.channel = 'line'
       AND sr.conversation_id = f.id
       AND sr.staff_id = ?
      ORDER BY ${unreadFirst ? 'is_unread_for_staff DESC, ' : ''}d.last_message_at DESC, d.friend_id DESC
    `;

    // placeholder 順 = SQL 出現順: last_any(account) → deduped 内 chats(account) →
    // page の未読判定 (sr 用 staff) → page 条件 → cursor
    // (beforeUnread あり: unread ×2 + beforeAt ×2 + beforeId / なし: beforeAt ×2 + beforeId) →
    // LIMIT → 最終段の未読判定 (sr 用 staff)。
    // any_agg は page で friend が確定済みのため account filter 不要。
    const allBindings: unknown[] = [];
    allBindings.push(...accountFilterBindings, ...accountFilterBindings);
    allBindings.push(staff.id);
    allBindings.push(...conditionBindings);
    if (useCursor) {
      if (beforeUnread == null) allBindings.push(beforeAt, beforeAt, beforeId);
      else allBindings.push(beforeUnread, beforeUnread, beforeAt, beforeAt, beforeId);
    }
    allBindings.push(limit, staff.id);
    const result = await c.env.DB.prepare(sql).bind(...allBindings).all();

    const data = result.results.map((ch: Record<string, unknown>) => ({
      id: ch.id as string,
      friendId: ch.friend_id,
      friendName: ch.display_name || '名前なし',
      friendPictureUrl: ch.picture_url || null,
      isAttention: Boolean(ch.is_attention),
      operatorId: ch.operator_id,
      operatorName: ch.operator_name,
      status: ch.status,
      revision: Number(ch.revision ?? 0),
      notes: ch.notes,
      lastMessageAt: ch.last_message_at,
      lastMessageContent: ch.last_message_content || null,
      lastMessageDirection: ch.last_message_direction || null,
      lastMessageType: ch.last_message_type || null,
      isUnread: Boolean(ch.is_unread_for_staff),
      createdAt: ch.created_at,
      updatedAt: ch.updated_at,
    }));

    const responseItems = await enrichSlaChats(c.env.DB,data);
    return c.json(buildCursorListResponse({ success: true, data: responseItems, items: responseItems, paging: { limit }, sort: [] }));
  } catch (err) {
    throw err;
  }
};

export const get__api_chats_id_2 = async (c: Context<Env, "/api/chats/:id">) => {
  try {
    const rawId = c.req.param('id')!;

    // id は chats.id または friend.id のどちらでもOK。
    // 優先順: chats.id 一致 → friend.id のとき chats.friend_id 最新行 → 何も無ければ friend のみで synthetic
    let chatRow = await getChatById(c.env.DB, rawId);
    let friendId: string | null = null;

    if (!chatRow) {
      const friendRow = await getFriendById(c.env.DB, rawId);
      if (!friendRow) return fail(c, 404, 'CHAT_NOT_FOUND');
      friendId = friendRow.id;
      // 同じ friend に紐づく chats 行があれば採用（lazy-create 後の再読みで status/notes を拾うため）
      const existing = await c.env.DB
        .prepare(`SELECT * FROM chats WHERE friend_id = ? ORDER BY created_at DESC LIMIT 1`)
        .bind(friendRow.id)
        .first<{ id: string; friend_id: string; operator_id: string | null; status: string; notes: string | null; last_message_at: string | null; created_at: string; updated_at: string; revision: number }>();
      if (existing) {
        chatRow = existing as Awaited<ReturnType<typeof getChatById>>;
      }
    }

    const resolvedFriendId = chatRow?.friend_id ?? friendId!;
    // 公開 ID は常に friend_id に統一する（lazy-create で ID が変わるのを防ぐため）。
    const responseId = resolvedFriendId;
    const operatorId = chatRow ? chatAssigneeId(chatRow) : null;
    const operatorName = chatRow?.assignee_staff_id ? (await c.env.DB.prepare('SELECT name FROM staff_members WHERE id=?').bind(chatRow.assignee_staff_id).first<{name:string}>())?.name ?? '担当者不明' : chatRow?.operator_id ? (await c.env.DB.prepare('SELECT name FROM operators WHERE id=?').bind(chatRow.operator_id).first<{name:string}>())?.name ?? '担当者不明' : null;
    const status = chatRow?.status ?? 'resolved';
    const notes = chatRow?.notes ?? null;
    const revision = chatRow?.revision ?? 0;
    const lastMessageAt = chatRow?.last_message_at ?? null;
    const createdAt = chatRow?.created_at ?? null;

    const friend = await c.env.DB
      .prepare(`SELECT display_name, real_name, picture_url, line_platform_user_id AS line_user_id, metadata FROM friends WHERE id = ?`)
      .bind(resolvedFriendId)
      .first<{
        display_name: string | null;
        real_name: string | null;
        picture_url: string | null;
        line_user_id: string;
        metadata: string | null;
      }>();
    let friendMetadata: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(friend?.metadata || '{}') as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        friendMetadata = parsed as Record<string, unknown>;
      }
    } catch {
      // 壊れた任意項目があっても受信箱そのものは開ける。
    }

    // 直近から limit 件ずつ返すカーソルページング。全文一括(LIMIT 1000)だと長期の
    // 会話で応答が重くなり、画像/Flex再描画時のスクロール追従も高コストになる。
    // 1件多めに取って「続きがあるか」だけ見て捨てる(limit+1方式)。
    const rawMessageLimit = listQueryNumber(c.req.query('limit'), '', { format: 'integer-prefix' });
    const messageLimit = Number.isSafeInteger(rawMessageLimit)
      ? Math.min(1000, Math.max(1, rawMessageLimit))
      : 100;
    const beforeAt = c.req.query('beforeAt') || undefined;
    const beforeId = c.req.query('beforeId') || undefined;
    const useMessageCursor = Boolean(beforeAt && beforeId);
    const messageBindings: unknown[] = [resolvedFriendId];
    if (useMessageCursor) messageBindings.push(beforeAt, beforeAt, beforeId);
    messageBindings.push(messageLimit + 1);
    const messages = await c.env.DB
      .prepare(
        `SELECT messages_log.id, messages_log.friend_id, messages_log.direction, messages_log.message_type,
                CASE WHEN messages_log.unsent_at IS NOT NULL THEN '' ELSE messages_log.content END AS content,
                CASE WHEN messages_log.unsent_at IS NOT NULL THEN 1 ELSE 0 END AS is_unsent,
                messages_log.source, messages_log.origin_kind,
                messages_log.sent_by_staff_id,
                (SELECT name FROM staff_members sm WHERE sm.id = messages_log.sent_by_staff_id) AS sent_by_staff_name,
                (SELECT s.name FROM scenario_steps ss
                  JOIN scenarios s ON s.id = ss.scenario_id
                  WHERE ss.id = messages_log.scenario_step_id) AS scenario_name,
                messages_log.quoted_message_id,
                messages_log.correction_of_message_id, messages_log.sender_id, messages_log.sender_snapshot_json,
                (SELECT json_group_array(json_object('id', corr.id, 'createdAt', corr.created_at, 'staffId', corr.sent_by_staff_id))
                 FROM messages_log corr WHERE corr.correction_of_message_id=messages_log.id) AS corrections_json,
                q.direction AS quoted_direction,
                q.message_type AS quoted_message_type,
                CASE WHEN q.unsent_at IS NOT NULL THEN '' ELSE q.content END AS quoted_content,
                CASE WHEN q.unsent_at IS NOT NULL THEN 1 ELSE 0 END AS quoted_is_unsent,
                q.created_at AS quoted_created_at,
                messages_log.created_at,
                messages_log.line_event_at,
                COALESCE(messages_log.line_event_at, messages_log.created_at) AS sort_at
         FROM messages_log
         LEFT JOIN messages_log q ON q.id = messages_log.quoted_message_id
         WHERE messages_log.friend_id = ? AND (messages_log.delivery_type IS NULL OR messages_log.delivery_type != 'test')
         ${useMessageCursor ? 'AND (COALESCE(messages_log.line_event_at, messages_log.created_at) < ? OR (COALESCE(messages_log.line_event_at, messages_log.created_at) = ? AND messages_log.id < ?))' : ''}
         ORDER BY sort_at DESC, messages_log.id DESC LIMIT ?`,
      )
      .bind(...messageBindings)
      .all();
    // 新しい push の欠落を防ぐため DESC で取って昇順に戻す(従来どおり)。
    const messageRows = messages.results as Record<string, unknown>[];
    const hasMoreMessages = messageRows.length > messageLimit;
    if (hasMoreMessages) messageRows.pop();
    messageRows.reverse();

    return c.json({
      success: true,
      data: {
        id: responseId,
        friendId: resolvedFriendId,
        friendName: friend?.display_name || '名前なし',
        friendRealName: friend?.real_name || null,
        friendPictureUrl: friend?.picture_url || null,
        isAttention: friendMetadata.__attention === '1',
        operatorId,
        operatorName,
        status,
        notes,
        revision,
        lastMessageAt,
        createdAt,
        // 古い履歴が残っているか。画面は「前のメッセージ」ボタンで遡る。
        hasMoreMessages,
        total: (await c.env.DB.prepare("SELECT COUNT(*) total FROM messages_log WHERE friend_id=? AND (delivery_type IS NULL OR delivery_type!='test')").bind(resolvedFriendId).first<{total:number}>())!.total,
        messages: messageRows.map((m) => ({
          id: m.id,
          direction: m.direction,
          messageType: m.message_type,
          content: m.content,
          isUnsent: Boolean(m.is_unsent),
          source: m.source || null,
          originKind: m.origin_kind || null,
          sentByStaffId: m.sent_by_staff_id || null,
          sentByStaffName: m.sent_by_staff_name || null,
          scenarioName: m.scenario_name || null,
          senderId: m.sender_id ?? null,
          sender: m.sender_snapshot_json ? JSON.parse(String(m.sender_snapshot_json)) : null,
          correctionOfMessageId: m.correction_of_message_id ?? null,
          corrections: JSON.parse(String(m.corrections_json ?? '[]')),
          quoted: m.quoted_message_id
            ? {
                id: m.quoted_message_id,
                direction: m.quoted_direction,
                messageType: m.quoted_message_type,
                content: m.quoted_content,
                isUnsent: Boolean(m.quoted_is_unsent),
                createdAt: m.quoted_created_at,
              }
            : null,
          createdAt: m.created_at,
          eventAt: (m.line_event_at as string | null) ?? null,
        })),
      },
    });
  } catch (err) {
    throw err;
  }
};

export const post__api_chats_id_read_3 = async (c: Context<Env, "/api/chats/:id/read">) => {
  try {
    const resolved = await resolveOrCreateChat(c.env.DB, c.req.param('id'));
    if (!resolved) return fail(c, 404, 'CHAT_NOT_FOUND');
    const latest = await c.env.DB
      .prepare(
        `SELECT MAX(created_at) AS last_read_at
         FROM messages_log
         WHERE friend_id = ? AND direction = 'incoming'
           AND (delivery_type IS NULL OR delivery_type != 'test')`,
      )
      .bind(resolved.friend_id)
      .first<{ last_read_at: string | null }>();
    if (latest?.last_read_at) {
      await markInboxConversationRead(c.env.DB, {
        staffId: c.get('staff').id,
        channel: 'line',
        conversationId: resolved.friend_id,
        lastReadAt: latest.last_read_at,
      });
    }
    return c.json({ success: true, data: { isUnread: false } });
  } catch (err) {
    throw err;
  }
};

export const post__api_chats_read_all_4 = async (c: Context<Env, "/api/chats/read-all">) => {
  try {
    const now = jstNow();
    const scope = await getVisibleLineAccountScope(c.env.DB, c.get('staff'));
    const clauses: string[] = [];
    const accountBindings: string[] = [];
    if (scope.allowedAccountIds.length > 0) {
      clauses.push(`f.line_account_id IN (${sqlIdSet(scope.allowedAccountIds).sql})`);
      accountBindings.push(...(scope.allowedAccountIds.length ? sqlIdSet(scope.allowedAccountIds).binds : []));
    }
    if (scope.canSeeUnassigned) clauses.push('f.line_account_id IS NULL');
    if (clauses.length === 0) return c.json({ success: true, data: { marked: true } });
    await c.env.DB
      .prepare(
        `INSERT INTO inbox_staff_reads
           (staff_id, channel, conversation_id, last_read_at, updated_at)
         SELECT ?, 'line', m.friend_id, MAX(m.created_at), ?
         FROM messages_log m
         INNER JOIN friends f ON f.id = m.friend_id
         WHERE m.direction = 'incoming'
           AND (m.delivery_type IS NULL OR m.delivery_type != 'test')
           AND (${clauses.join(' OR ')})
         GROUP BY m.friend_id
         ON CONFLICT(staff_id, channel, conversation_id) DO UPDATE SET
           last_read_at = excluded.last_read_at,
           updated_at = excluded.updated_at`,
      )
      .bind(c.get('staff').id, now, ...accountBindings)
      .run();
    return c.json({ success: true, data: { marked: true } });
  } catch (err) {
    throw err;
  }
};

export const get__api_chats_id_events_5 = async (c: Context<Env, "/api/chats/:id/events">) => {
    const resolved = await resolveOrCreateChat(c.env.DB, c.req.param('id'));
    if (!resolved) return fail(c, 404, 'CHAT_NOT_FOUND');
    const rows = await c.env.DB.prepare(
      `SELECT id, event_type, before_json, after_json, actor_staff_id,
              (SELECT name FROM staff_members sm WHERE sm.id = e.actor_staff_id) AS actor_staff_name,
              reason, correlation_id, created_at
       FROM inbox_conversation_events e
       WHERE channel = 'line' AND conversation_id = ?
       ORDER BY created_at DESC, id DESC LIMIT 200`,
    ).bind(resolved.friend_id).all<Record<string, unknown>>();
    return c.json({
      success: true,
      data: rows.results.map((row) => ({
        id: row.id,
        eventType: row.event_type,
        before: row.before_json ? JSON.parse(String(row.before_json)) : null,
        after: row.after_json ? JSON.parse(String(row.after_json)) : null,
        actorStaffId: row.actor_staff_id,
        actorStaffName: row.actor_staff_name,
        reason: row.reason,
        correlationId: row.correlation_id,
        createdAt: row.created_at,
      })),
    });
  };
