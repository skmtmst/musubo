import { assigneeFilter } from '../services/chat-assignees.js';
import { logger } from '@line-crm/shared/server';
import { readFriendListCursor, friendListCursor, type FriendListCursor } from './friend-list-cursor.js';
import { idChunks } from '@line-crm/db/id-queries';

import { getFriendListFieldValues, getFriendAddBreakdown, getFriendTagsByFriendIds, getSavedSearchById, recordSavedSearchUsage, validateSearchConditions } from '@line-crm/db';
import type { Friend as DbFriend, Tag as DbTag } from '@line-crm/db';


import { BASIC_FRIEND_FIELDS, DEFAULT_TENANT_ID, type SavedSearchConditions } from '@line-crm/shared';

import type { Env } from '../worker-env.js';
import { hasStaffPermission } from '../middleware/role-guard.js';
import { canAccessAllLineAccounts, getVisibleLineAccountScope } from '../services/account-access.js';
import { listResponse } from '../lib/list-etag.js';
import { compileSavedSearch, friendFieldValueSql } from '../services/saved-search-filter.js';
import { parseOffsetPaging, buildOffsetListResponse } from '../lib/list-paging.js';
import { adminAccountScope, escapeLikePattern, serializeFriendListRow, serializeTag } from './friends-definition.js';
import type { Context } from 'hono';

export const get__api_friends_1 = async (c: Context<Env, "/api/friends">) => {
  try {
    const requestedColumns = c.req.query('fieldColumns');
    let fieldColumns: string[] = [];
    if (requestedColumns) {
      if (requestedColumns.length > 2_000) return c.json({success:false,error:'表示項目が多すぎます'},422);
      try { const parsed: unknown = JSON.parse(requestedColumns);
        if (!Array.isArray(parsed) || parsed.length > 7 || parsed.some(key => typeof key !== 'string' || !(BASIC_FRIEND_FIELDS.some(field => key === `fixed:${field.key}`) || /^field:[a-zA-Z0-9_-]{1,128}$/.test(key)))) throw new Error();
        fieldColumns = [...new Set(parsed)];
      } catch { return c.json({success:false,error:'表示項目の指定を確認してください'},422); }
    }
    const rawConditions = c.req.query('conditions');
    let directConditions: SavedSearchConditions | undefined;
    if (rawConditions) {
      if (rawConditions.length > 16_000) {
        return c.json({ success: false, error: '検索条件が大きすぎます' }, 422);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawConditions);
      } catch {
        return c.json({ success: false, error: '検索条件のJSONが正しくありません' }, 422);
      }
      const validated = validateSearchConditions(parsed);
      if (!validated.ok) return c.json({ success: false, error: validated.error }, 422);
      directConditions = validated.value;
    }
    const { limit, offset } = parseOffsetPaging({ limit: c.req.query('limit'), offset: c.req.query('offset') }, { defaultLimit: directConditions?.list?.limit ?? 50 });
    const tagId = c.req.query('tagId');
    const lineAccountId = c.req.query('lineAccountId');
    const audienceId = c.req.query('audienceId')?.trim();
    const search = c.req.query('search');
    // 自動補完ではタグを描画しないため includeTags=false で行ごとの N+1 取得を省く。既存の呼出元の表示を保つため、既定は true とする。
    const includeTags = c.req.query('includeTags') !== 'false';
    // 単純一覧や自動補完を重くしないよう、最終送受信・稼働シナリオ・対応状態は includeChatStatus=true のときだけ求める。
    const includeChatStatus = c.req.query('includeChatStatus') === 'true';
    // 検索の一致度を崩さないよう、oldest は作成日時の第2順位だけを反転する。
    const requestedSort = c.req.query('sort') ?? directConditions?.list?.sort;
    const sort: 'recent' | 'oldest' = requestedSort === 'oldest' ? 'oldest' : 'recent';
    const cursorMode=c.req.query('pagination')==='cursor'||c.req.query('cursor')!==undefined;
    let cursor:FriendListCursor|undefined;
    if(cursorMode){
      if(search||offset>0)return c.json({success:false,error:'カーソルのページ送りでは検索とoffsetを同時に指定できません'},400);
      try{const raw=c.req.query('cursor');if(raw)cursor=readFriendListCursor(raw);
        if(cursor&&cursor.sort!==sort)throw new Error('invalid_list_cursor');
      }catch{return c.json({success:false,error:'ページ送りの指定を確認してください'},400);}
    }

    // 未対応の絞込は SQL で行い、ページ送りと総数を一致させる。取得後に画面で隠すだけでは総数が誤るため。
    const handledFilter: 'unhandled' | null =
      c.req.query('handled') === 'unhandled' ? 'unhandled' : null;
    const operatorId = c.req.query('operatorId');
    const scenarioId = c.req.query('scenarioId');
    const parseScoreBoundary = (name: 'scoreMin' | 'scoreMax') => {
      const raw = c.req.query(name);
      if (raw === undefined) return { provided: false, value: 0 };
      if (!/^-?\d+$/.test(raw)) return null;
      const value = Number(raw);
      return Number.isSafeInteger(value) ? { provided: true, value } : null;
    };
    const scoreMin = parseScoreBoundary('scoreMin');
    const scoreMax = parseScoreBoundary('scoreMax');
    if (!scoreMin || !scoreMax || (scoreMin.provided && scoreMax.provided && scoreMin.value > scoreMax.value)) {
      return c.json({ success: false, error: 'scoreMin and scoreMax must be integers with min <= max' }, 400);
    }
    const savedSearchId = c.req.query('savedSearchId');
    if (savedSearchId && directConditions) {
      return c.json({ success: false, error: '保存した検索と直接指定した条件は同時に使えません' }, 400);
    }

    const db = c.env.DB;
    const staff = c.get('staff');

    if (lineAccountId && !await canAccessAllLineAccounts(db, staff, [lineAccountId])) {
      return c.json({ success: false, error: 'Not found' }, 404);
    }

    if (audienceId) {
      if (staff.role !== 'owner' && staff.role !== 'admin') {
        return c.json({ success: false, error: '対象者の個人一覧を表示する権限がありません' }, 403);
      }
      if (!lineAccountId) {
        return c.json({ success: false, error: 'LINE公式アカウントを選んでください' }, 400);
      }
      const audience = await db.prepare(
        `SELECT id, expires_at FROM analytics_result_audiences
          WHERE id = ? AND line_account_id = ?`,
      ).bind(audienceId, lineAccountId).first<{ id: string; expires_at: string }>();
      if (!audience) return c.json({ success: false, error: 'Not found' }, 404);
      if (audience.expires_at <= new Date().toISOString()) {
        return c.json({ success: false, error: 'この分析結果の対象者は24時間を過ぎました。もう一度集計してください' }, 410);
      }
    }


    const conditions: string[] = [];
    const binds: unknown[] = [];
    let appliedSavedSearchRevision: number | null = null;
    if (tagId) {
      conditions.push('EXISTS (SELECT 1 FROM friend_tags ft WHERE ft.friend_id = f.id AND ft.tag_id = ?)');
      binds.push(tagId);
    }
    if (audienceId) {
      conditions.push(
        `EXISTS (
          SELECT 1 FROM analytics_result_audience_members arm
          WHERE arm.audience_id = ? AND arm.friend_id = f.id
        )`,
      );
      binds.push(audienceId);
    }
    if (lineAccountId) {
      const visibleScope = await getVisibleLineAccountScope(c.env.DB, c.get('staff'));
      if (!visibleScope.allowedAccountIds.includes(lineAccountId)) {
        return c.json({ success: false, error: '保存した検索が見つかりません' }, 404);
      }
      conditions.push('f.line_account_id = ?');
      binds.push(lineAccountId);
    } else {
      const { binds: scopeBinds, where } = await adminAccountScope(c, 'f.');
      conditions.push(where);
      binds.push(...scopeBinds);
    }
    if (savedSearchId) {
      if (!lineAccountId) {
        return c.json({ success: false, error: 'LINE公式アカウントを選んでください' }, 400);
      }
      const row = await getSavedSearchById(db, savedSearchId, lineAccountId);
      const staff = c.get('staff');
      if (!row
          || row.scope !== 'friends'
          || (!row.is_shared && row.created_by !== staff.id && staff.role !== 'owner' && staff.role !== 'admin')) {
        return c.json({ success: false, error: '保存した検索が見つかりません' }, 404);
      }
      let rawConditions: unknown;
      try {
        rawConditions = JSON.parse(row.conditions_json);
      } catch {
        return c.json({ success: false, error: '保存した検索の条件が壊れています' }, 422);
      }
      const validated = validateSearchConditions(rawConditions);
      if (!validated.ok) {
        return c.json({ success: false, error: validated.error }, 422);
      }
      const compiled = compileSavedSearch(validated.value);
      if (!compiled.ok) {
        return c.json({ success: false, error: compiled.error }, 422);
      }
      conditions.push(compiled.value.sql);
      binds.push(...compiled.value.binds);
      appliedSavedSearchRevision = Number(row.revision ?? 1);
    }
    if (directConditions) {
      const compiled = compileSavedSearch(directConditions);
      if (!compiled.ok) return c.json({ success: false, error: compiled.error }, 422);
      conditions.push(compiled.value.sql);
      binds.push(...compiled.value.binds);
    }
    if (search) {
      conditions.push(`f.display_name LIKE ? ESCAPE '\\'`);
      binds.push(`%${escapeLikePattern(search)}%`);
    }
    if (scoreMin.provided) {
      conditions.push('f.score >= ?');
      binds.push(scoreMin.value);
    }
    if (scoreMax.provided) {
      conditions.push('f.score <= ?');
      binds.push(scoreMax.value);
    }
    /*
     * 行動スコア一覧の帯は「点数がついている人」だけを数える
     * （`f.score != 0 OR 履歴あり`）。低い帯の引き継ぎ（`?scoredOnly=1`）では
     * 未採点の0点を含めず、一覧・検索・配信の対象定義をそろえる。
     * 付けない既存の呼び出しは従来どおり（点数範囲だけ）。
     */
    if (c.req.query('scoredOnly') === '1') {
      conditions.push(
        '(f.score != 0 OR EXISTS (SELECT 1 FROM friend_scores scored_only WHERE scored_only.friend_id = f.id))',
      );
    }
    // 未対応は chats.status から判定する。自動返信や postback は意図的に未読へ変えず、担当者が選んだ対応中・対応済みを優先するため、メッセージ時刻から推測しない。チャット行がなければ一覧と同じ resolved とする。
    if (handledFilter === 'unhandled') {
      conditions.push(
        `EXISTS (
          SELECT 1 FROM chats c
          WHERE c.friend_id = f.id AND c.status = 'unread'
        )`,
      );
    }
    if (operatorId) {
      const filter = assigneeFilter('c', operatorId);
      conditions.push(`EXISTS (SELECT 1 FROM chats c WHERE c.friend_id = f.id AND ${filter.sql})`);
      binds.push(...filter.binds);
    }
    if (scenarioId) {
      conditions.push(
        `EXISTS (
          SELECT 1 FROM friend_scenarios fs
          WHERE fs.friend_id = f.id
            AND fs.scenario_id = ?
            AND fs.status IN ('active', 'delivering')
        )`,
      );
      binds.push(scenarioId);
    }
    // Metadata filters: ?metadata.key=value (e.g. ?metadata.monthly_cost=〜100万円)
    // ?metadataNot.key=value is the「等しくない」side. 値を持たない人も含める
    // （項目そのものが無い人を外すと、絞り込みの意味が変わる）。
    const url = new URL(c.req.url);
    for (const [key, value] of url.searchParams.entries()) {
      if (key.startsWith('metadata.')) {
        const metaKey = key.slice('metadata.'.length);
        conditions.push(`${friendFieldValueSql()} = ?`);
        binds.push(metaKey, value);
      } else if (key.startsWith('metadataNot.')) {
        const metaKey = key.slice('metadataNot.'.length);
        conditions.push(
          `(${friendFieldValueSql()} IS NULL OR ${friendFieldValueSql()} != ?)`,
        );
        binds.push(metaKey, metaKey, value);
      }
    }

    /*
     * 詳細検索（設計 V2 2-2 の「絞り込み条件を設定」）の受け口。
     *
     * どれも足し算で、指定が無ければ何も起きない。既にある tagId / search /
     * handled はそのまま残してある（一覧やオートコンプリートが使っている）。
     */

    /** タグを複数（すべて満たす）。`?tagIds=a,b` */
    const tagIds = (c.req.query('tagIds') ?? '')
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
    for (const t of tagIds) {
      conditions.push(
        'EXISTS (SELECT 1 FROM friend_tags ft WHERE ft.friend_id = f.id AND ft.tag_id = ?)',
      );
      binds.push(t);
    }

    /** このタグが付いていない人。`?excludeTagIds=a,b` */
    const excludeTagIds = (c.req.query('excludeTagIds') ?? '')
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
    for (const t of excludeTagIds) {
      conditions.push(
        'NOT EXISTS (SELECT 1 FROM friend_tags ft WHERE ft.friend_id = f.id AND ft.tag_id = ?)',
      );
      binds.push(t);
    }

    /** ステータスメッセージに含む。`?statusMessage=...` */
    const statusMessage = c.req.query('statusMessage');
    if (statusMessage) {
      conditions.push(`f.status_message LIKE ? ESCAPE '\\'`);
      binds.push(`%${escapeLikePattern(statusMessage)}%`);
    }

    /** 友だち登録日の範囲。`?createdFrom=YYYY-MM-DD&createdTo=YYYY-MM-DD` */
    const createdFrom = c.req.query('createdFrom');
    if (createdFrom) {
      conditions.push('f.created_at >= ?');
      binds.push(createdFrom);
    }
    const createdTo = c.req.query('createdTo');
    if (createdTo) {
      // その日の終わりまで含める。日付だけで比べると当日ぶんが落ちる。
      conditions.push('f.created_at <= ?');
      binds.push(`${createdTo}T23:59:59.999`);
    }

    /**
     * 対応マーク。chats は友だちごとに1行なので、その現在値を見る。
     */
    const chatStatus = c.req.query('chatStatus');
    if (chatStatus && ['unread', 'in_progress', 'on_hold', 'resolved'].includes(chatStatus)) {
      conditions.push(
        `COALESCE(
           (SELECT status FROM chats c
            WHERE c.friend_id = f.id),
           'resolved'
         ) = ?`,
      );
      binds.push(chatStatus);
    }

    /** 表示設定。`?visibility=following|blocked` 既定は指定なし（全部） */
    const visibility = c.req.query('visibility');
    if (visibility === 'following') {
      conditions.push('f.is_following = 1');
    } else if (visibility === 'blocked') {
      conditions.push('f.is_following = 0');
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countStmt = db.prepare(`SELECT COUNT(*) as count FROM friends f ${where}`);
    const totalRow = await (binds.length > 0 ? countStmt.bind(...binds) : countStmt).first<{ count: number }>();
    const total = totalRow?.count ?? 0;

    // 検索は友だち追加の古さより一致度を優先し、完全一致・先頭一致・単語先頭・部分一致の順にする。ASCII の大小を区別しない LIKE と半角・全角スペースを使う。自動補完では不要な JOIN を省く。チャットは1人1行の制約を使い、状態・担当 ID・名前を同じ行から読む。
    const baseSelect = includeChatStatus
      ? `f.*, tl.name AS first_tracked_link_name,
         COALESCE(lc.status, 'resolved') AS chat_status,
         COALESCE(CASE WHEN lc.assignee_staff_id IS NOT NULL THEN 'staff:' || lc.assignee_staff_id END, lc.operator_id) AS operator_id,
         CASE WHEN lc.assignee_staff_id IS NOT NULL THEN COALESCE(assignee.name, '担当者不明') WHEN lc.operator_id IS NOT NULL THEN COALESCE(op.name, '担当者不明') END AS operator_name,
         sm.id AS support_mark_id,
         sm.name AS support_mark_name,
         sm.color AS support_mark_color`
      : `f.*`;
    const baseFrom = includeChatStatus
      ? `FROM friends f
         LEFT JOIN tracked_links tl ON tl.id = f.first_tracked_link_id
         LEFT JOIN chats lc ON lc.friend_id = f.id
         LEFT JOIN operators op ON op.id = lc.operator_id
         LEFT JOIN staff_members assignee ON assignee.id = lc.assignee_staff_id
         LEFT JOIN support_marks sm ON sm.id = f.support_mark_id`
      : `FROM friends f`;
    // 作成日時は通常の第1順位、検索時は一致度の次の順位とし、sort で方向を選ぶ。
    const createdOrder = sort === 'oldest' ? 'ASC' : 'DESC';
    let listStmt;
    let listBinds: unknown[];
    if (search) {
      const escapedSearch = escapeLikePattern(search);
      const exactPattern = escapedSearch;
      const prefixPattern = `${escapedSearch}%`;
      const wordStartAscii = `% ${escapedSearch}%`;
      const wordStartFullWidth = `%　${escapedSearch}%`;
      listStmt = db.prepare(
        `SELECT ${baseSelect},
                CASE
                  WHEN f.display_name LIKE ? ESCAPE '\\' THEN 0
                  WHEN f.display_name LIKE ? ESCAPE '\\' THEN 1
                  WHEN f.display_name LIKE ? ESCAPE '\\' OR f.display_name LIKE ? ESCAPE '\\' THEN 2
                  ELSE 3
                END AS match_score
         ${baseFrom} ${where}
         ORDER BY match_score ASC, f.created_at ${createdOrder}, f.id ${createdOrder}
         LIMIT ? OFFSET ?`,
      );
      listBinds = [exactPattern, prefixPattern, wordStartAscii, wordStartFullWidth, ...binds, limit, offset];
    } else {
      const compare=sort==='oldest'?'>':'<';
      const cursorWhere=cursor?`${where ? ' AND' : 'WHERE'} (f.created_at ${compare} ? OR (f.created_at=? AND f.id ${compare} ?))`:'';
      listStmt = db.prepare(
        `SELECT ${baseSelect} ${baseFrom} ${where} ${cursorWhere} ORDER BY f.created_at ${createdOrder}, f.id ${createdOrder} LIMIT ?${cursorMode?'':' OFFSET ?'}`,
      );
      listBinds = [...binds,...(cursor?[cursor.createdAt,cursor.createdAt,cursor.id]:[]),limit,...(cursorMode?[]:[offset])];
    }
    const listResult = await listStmt.bind(...listBinds).all<DbFriend>();
    const items = listResult.results;
    const fieldValues = await getFriendListFieldValues(db, {friendIds:items.map(friend => friend.id),columns:fieldColumns,
      tenantId:c.get('staff')?.tenantId ?? DEFAULT_TENANT_ID,
      canSeePersonal:hasStaffPermission(c,'attribute.personal_info.view') || hasStaffPermission(c,'attribute.personal_info.edit')});

    // 表示ページ分のタグを1回で取得する。友だちごとの問い合わせは行わない。
    // includeTags=false のオートコンプリート経路では、この1回も省略する。
    const tagsByFriendId = includeTags
      ? await getFriendTagsByFriendIds(db, items.map((friend) => friend.id))
      : new Map<string, DbTag[]>();
    let itemsWithTags = items.map((friend) => ({
      ...serializeFriendListRow(friend, includeChatStatus),
      tags: (tagsByFriendId.get(friend.id) ?? []).map(serializeTag),
      ...(fieldColumns.length ? {fieldValues:fieldValues.get(friend.id) ?? {}} : {}),
    }));

    // N×3の問い合わせを防ぐため、最終送受信とシナリオは3つの一括取得で補完する。各友だちの最新行は ROW_NUMBER で選ぶ。
    if (includeChatStatus && items.length > 0) {
      const ids = items.map((f) => f.id);

      type IncomingRow = { friend_id: string; content: string; message_type: string; created_at: string };
      type OutgoingRow = { friend_id: string; max_at: string };
      type ScenarioRow = { friend_id: string; scenario_name: string; status: string };

      const incomingRes: { results: IncomingRow[] } = { results: [] };
      const outgoingRes: { results: OutgoingRow[] } = { results: [] };
      const scenarioRes: { results: ScenarioRow[] } = { results: [] };
      for (const chunk of idChunks(ids)) {
      const placeholders = chunk.map(() => '?').join(',');
      const [incoming, outgoing, scenario] = await Promise.all([
        db
          .prepare(
            `SELECT friend_id, content, message_type, created_at FROM (
               SELECT friend_id, content, message_type, created_at,
                      ROW_NUMBER() OVER (PARTITION BY friend_id ORDER BY created_at DESC) AS rn
               FROM messages_log
               WHERE direction = 'incoming' AND friend_id IN (${placeholders})
             ) WHERE rn = 1`,
          )
          .bind(...chunk)
          .all<IncomingRow>(),
        db
          .prepare(
            // delivery_type='test' は実顧客への配信ではない (テスト送信先への
            // ブロードキャスト)。/api/chats など他のチャット系ビューも同じく
            // test 配信を除外して "活動" を判定するので、そちらと整合させる。
            // 含めると、テスト送信先に登録されたまま実 incoming を放置している
            // 友だちの handled が誤って true に変わる。
            `SELECT friend_id, MAX(created_at) AS max_at FROM messages_log
             WHERE direction = 'outgoing'
               AND (delivery_type IS NULL OR delivery_type != 'test')
               AND friend_id IN (${placeholders})
             GROUP BY friend_id`,
          )
          .bind(...chunk)
          .all<OutgoingRow>(),
        db
          .prepare(
            `SELECT fs.friend_id, s.name AS scenario_name, fs.status FROM (
               SELECT friend_id, scenario_id, status,
                      ROW_NUMBER() OVER (PARTITION BY friend_id ORDER BY started_at DESC) AS rn
               FROM friend_scenarios
               WHERE status IN ('active', 'delivering') AND friend_id IN (${placeholders})
             ) fs
             JOIN scenarios s ON s.id = fs.scenario_id
             WHERE fs.rn = 1`,
          )
          .bind(...chunk)
          .all<ScenarioRow>(),
      ]);
      incomingRes.results.push(...incoming.results);
      outgoingRes.results.push(...outgoing.results);
      scenarioRes.results.push(...scenario.results);
      }

      const incomingByFriend = new Map(incomingRes.results.map((r) => [r.friend_id, r]));
      const outgoingByFriend = new Map(outgoingRes.results.map((r) => [r.friend_id, r.max_at]));
      const scenarioByFriend = new Map(scenarioRes.results.map((r) => [r.friend_id, r]));

      // includeChatStatus 内ではシリアライザが値を補完済みだが、共用体を型が絞れないため、ここでその形を示す。
      type WithChatStatus = (typeof itemsWithTags)[number] & {
        chatStatus: 'unread' | 'in_progress' | 'resolved';
        operatorId?: string | null;
        operatorName?: string | null;
        supportMarkId?: string | null;
        supportMarkName?: string | null;
        supportMarkColor?: string | null;
      };
      itemsWithTags = (itemsWithTags as WithChatStatus[]).map((f) => {
        const inc = incomingByFriend.get(f.id);
        const outAt = outgoingByFriend.get(f.id);
        const sc = scenarioByFriend.get(f.id);
        // 対応済み判定は chats.status 一本。messages_log の出入り時刻ではなく、
        // /chats 画面が見ている persisted state を使う。silent auto-reply や
        // postback のように "incoming だが unread にしない" イベントもあるので、
        // タイムスタンプベースで推測すると /chats と乖離する。
        const handled = f.chatStatus !== 'unread';
        return {
          ...f,
          latestIncomingMessage: inc
            ? { content: inc.content, messageType: inc.message_type, createdAt: inc.created_at }
            : null,
          latestOutgoingAt: outAt ?? null,
          activeScenario: sc ? { name: sc.scenario_name, status: sc.status } : null,
          operator:
            f.operatorId && f.operatorName
              ? { id: f.operatorId, name: f.operatorName }
              : null,
          supportMark:
            f.supportMarkId && f.supportMarkName
              ? {
                  id: f.supportMarkId,
                  name: f.supportMarkName,
                  color: f.supportMarkColor ?? '#8B938D',
                }
              : null,
          handled,
        };
      });
    }

    if (savedSearchId && lineAccountId && appliedSavedSearchRevision !== null) {
      try {
        await recordSavedSearchUsage(db, {
          savedSearchId,
          lineAccountId,
          revision: appliedSavedSearchRevision,
          referenceKind: 'friends',
          usedBy: staff.id,
        });
      } catch (error) {
        // 集計台帳の一時失敗で、友だち一覧そのものを表示不能にしない。
        logger.error("friends.friends_get_failed");
      }
    }

    // 同じ中身なら304（list-etag）。本文のハッシュだけ見て個人情報は混ぜない。
    return listResponse(c, {
      success: true,
      data: buildOffsetListResponse({ items: itemsWithTags,
        ...(cursorMode?{nextCursor:items.length===limit?friendListCursor({createdAt:items.at(-1)!.created_at,id:items.at(-1)!.id,sort}):null}:{}),
        total,
        page: Math.floor(offset / limit) + 1,
        limit,
        hasNextPage: offset + limit < total, paging: { limit, ...(!cursorMode ? { offset } : {}) }, sort: [...(search ? [{ field: 'match_score', direction: 'asc' as const }] : []),{field:'createdAt',direction:createdOrder === 'ASC' ? 'asc' : 'desc'},{field:'id',direction:createdOrder === 'ASC' ? 'asc' : 'desc'}] }),
    });
  } catch (err) {
    throw err;
  }
};

export const get__api_friends_add_breakdown_2 = async (c: Context<Env, "/api/friends/add-breakdown">) => {
  try {
    const days = Number(c.req.query('days') ?? '30');
    const lineAccountId = c.req.query('lineAccountId') ?? null;
    if (lineAccountId && !await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [lineAccountId])) {
      return c.json({ success: false, error: 'Not found' }, 404);
    }
    const safeDays = Number.isFinite(days) && days > 0 ? Math.min(days, 365) : 30;
    const statsScope = lineAccountId
      ? { allowedAccountIds: [lineAccountId], includeUnassigned: false }
      : await getVisibleLineAccountScope(c.env.DB, c.get('staff')).then((scope) => ({
          allowedAccountIds: scope.allowedAccountIds,
          includeUnassigned: scope.canSeeUnassigned,
        }));
    const data = await getFriendAddBreakdown(c.env.DB, safeDays, statsScope);
    return c.json({ success: true, data });
  } catch (err) {
    throw err;
  }
};

export const get__api_friends_count_3 = async (c: Context<Env, "/api/friends/count">) => {
  try {
    const lineAccountId = c.req.query('lineAccountId');
    if (lineAccountId && !await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [lineAccountId])) {
      return c.json({ success: false, error: 'Not found' }, 404);
    }
    let count: number;
    if (lineAccountId) {
      const row = await c.env.DB.prepare('SELECT COUNT(*) as count FROM friends WHERE is_following = 1 AND line_account_id = ?')
        .bind(lineAccountId).first<{ count: number }>();
      count = row?.count ?? 0;
    } else {
      const { binds: scopeBinds, where } = await adminAccountScope(c);
      const row = await c.env.DB.prepare(`SELECT COUNT(*) as count FROM friends WHERE is_following = 1 AND ${where}`)
        .bind(...scopeBinds).first<{ count: number }>();
      count = row?.count ?? 0;
    }
    return c.json({ success: true, data: { count } });
  } catch (err) {
    throw err;
  }
};

export const get__api_friends_ref_stats_4 = async (c: Context<Env, "/api/friends/ref-stats">) => {
  try {
    const lineAccountId = c.req.query('lineAccountId');
    if (lineAccountId && !await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [lineAccountId])) {
      return c.json({ success: false, error: 'Not found' }, 404);
    }
    const accountScope = lineAccountId ? null : await adminAccountScope(c);
    const where = lineAccountId ? 'line_account_id = ?' : accountScope!.where;
    const binds = lineAccountId ? [lineAccountId] : accountScope!.binds;
    const stmt = c.env.DB.prepare(
      `SELECT ref_code, COUNT(*) as count FROM friends WHERE ${where} AND ref_code IS NOT NULL GROUP BY ref_code ORDER BY count DESC`,
    );
    const result = await (binds.length > 0 ? stmt.bind(...binds) : stmt).all<{ ref_code: string; count: number }>();
    const total = await c.env.DB.prepare(
      `SELECT COUNT(*) as count FROM friends WHERE ${where} AND ref_code IS NOT NULL`,
    ).bind(...binds).first<{ count: number }>();
    return c.json({
      success: true,
      data: {
        routes: result.results.map((r) => ({ refCode: r.ref_code, friendCount: r.count })),
        totalWithRef: total?.count ?? 0,
      },
    });
  } catch (err) {
    throw err;
  }
};
