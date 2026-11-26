import { logger } from '@line-crm/shared/server';
import { accountScopeWhere, accountScopeBindings, adminAccountScope, visibleAccountNames } from '../services/profile-refresh-scope.js';
import { sqlIdSet } from '@line-crm/db/id-queries';
import { inputError, inputJsonBoundary } from '../lib/input-errors.js';
import { Hono } from 'hono';
import { LineClient } from '@line-crm/line-sdk';
import type { Env } from '../worker-env.js';
import { requireRole } from '../middleware/role-guard.js';
import { getBroadcastById, resolveLineCredential } from '@line-crm/db';
import { canAccessAllLineAccounts, getVisibleLineAccountScope } from '../services/account-access.js';
import { resolveLineToken } from '../services/line-token.js';
import { parseOffsetPaging, buildOffsetListResponse, listLimit, listQueryNumber } from '../lib/list-paging.js';
import { fail } from '../lib/fail.js';
const profileRefresh = new Hono<Env>();

/**
 * 友だち全員のプロフィール (display_name / picture_url / status_message) を
 * LINE Messaging API から再取得して messages_log の dedup 品質を維持する。
 *
 * 課題: プロフ画像 URL が時間経過で 404 化 → URL_TOKEN_SQL が NULL fallback →
 * cross-account dedup が壊れて同一人物が別人カウントされる。
 *
 * 動作: ?offset & ?limit でバッチ処理。 ?accountId で単一アカウントに絞れる。
 * 内部で account ごとに channel_access_token を選んで getProfile を呼ぶ。
 *
 * Caller (cron / curl) は hasMore=false まで offset を進めて再 POST する想定。
 */
profileRefresh.post('/api/admin/refresh-profiles', requireRole('owner'), inputJsonBoundary(), async (c) => {
  const offset = listQueryNumber(c.req.query('offset'), 0, { format: 'integer-prefix' });
  const limit = listLimit(c.req.query('limit'), 100, 500);
  const accountIdFilter = c.req.query('accountId') ?? null;

  if (!Number.isFinite(offset) || offset < 0) {
    return inputError(c, { success: false, error: 'invalid offset' }, 400, ["offset"]);
  }

  const db = c.env.DB;
  const adminScope = accountIdFilter ? null : await adminAccountScope(c);

  // 対象 friend を line_account_id 込みで取得。既に block 済 (is_following=0)
  // も含めるか? → 含めない。送信対象だけリフレッシュすれば十分で、ブロック済は
  // どうせ profile API も 403/404 で空振りする。
  const baseQuery = `
    SELECT f.id, f.line_platform_user_id AS line_user_id, f.line_account_id,
           a.channel_access_token, a.channel_access_token_encrypted
    FROM friends f
    LEFT JOIN line_accounts a ON a.id = f.line_account_id
    WHERE f.is_following = 1
      AND f.line_platform_user_id IS NOT NULL
      ${accountIdFilter ? 'AND f.line_account_id = ?' : adminScope?.where}
    ORDER BY f.id
    LIMIT ? OFFSET ?
  `;

  const stmt = db.prepare(baseQuery);
  const bound = accountIdFilter
    ? stmt.bind(accountIdFilter, limit, offset)
    : stmt.bind(...accountScopeBindings(adminScope!.scope), limit, offset);

  const batch = await bound.all<{
    id: string;
    line_user_id: string;
    line_account_id: string | null;
    channel_access_token: string | null;
    channel_access_token_encrypted: string | null;
  }>();

  const rows = batch.results ?? [];

  // デフォルトトークンを fallback として保持。Per-account token が無い古い friend を救う。
  const defaultToken = c.env.LINE_CHANNEL_ACCESS_TOKEN;

  // Concurrency: LINE API は厳しい rate limit ない (~2000 req/sec) ので
  // 50 並列で十分速い。worker CPU 制約とのバランス。
  const CONCURRENCY = 50;
  let processed = 0;
  let updated = 0;
  let notFound = 0;
  let otherErrors = 0;

  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    const chunk = rows.slice(i, i + CONCURRENCY);
    await Promise.all(chunk.map(async (row) => {
      const accountToken = row.channel_access_token
        ? await resolveLineCredential(
            row.channel_access_token_encrypted,
            row.channel_access_token,
            {
              lineAccountId: row.line_account_id ?? 'unassigned',
              field: 'channel_access_token',
            },
          )
        : null;
      const token = resolveLineToken({
        accountToken,
        defaultToken,
        accountId: row.line_account_id,
        context: 'profile-refresh.friend-profile',
      });
      const client = new LineClient(token);
      try {
        const profile = await client.getProfile(row.line_user_id);
        await db
          .prepare(
            `UPDATE friends
               SET display_name    = ?,
                   picture_url     = ?,
                   status_message  = ?,
                   updated_at      = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') || '+09:00'
             WHERE id = ?`,
          )
          .bind(
            profile.displayName ?? null,
            profile.pictureUrl ?? null,
            profile.statusMessage ?? null,
            row.id,
          )
          .run();
        updated += 1;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('404') || msg.includes('403')) {
          notFound += 1;
        } else {
          otherErrors += 1;
          logger.error("profile_refresh.admin_refresh_profiles_create_failed");
        }
      } finally {
        processed += 1;
      }
    }));
  }

  // hasMore: 今回 limit 件取れていれば次がある可能性。0 件 or limit 未満なら終わり。
  const hasMore = rows.length === limit;

  return c.json({
    success: true,
    data: {
      offset,
      limit,
      processed,
      updated,
      notFound,
      otherErrors,
      hasMore,
      nextOffset: hasMore ? offset + limit : null,
    },
  });
});

/**
 * 既送信 broadcast を draft に戻す (再送用)。multicast/db.batch エラー等で
 * 0 件成功で完了した broadcast を試し直すための運用 endpoint。
 * messages_log がゼロ件であることを安全条件に強制する (誤って配信済の
 * broadcast を reset してしまうと送信痕跡が消えて重複配信のリスクがある)。
 */
profileRefresh.post('/api/admin/broadcasts/:id/reset-to-draft', requireRole('owner'), inputJsonBoundary(), async (c) => {
  const id = c.req.param('id');
  const db = c.env.DB;

  const broadcast = await getBroadcastById(db, id);
  if (!broadcast) return c.json({ success: false, error: 'Not found' }, 404);
  let accounts: Array<string | null> = [broadcast.line_account_id ?? null];
  if (broadcast.target_type === 'multi-account-dedup') {
    try {
      const parsed: unknown = JSON.parse(broadcast.account_ids ?? 'null');
      if (!Array.isArray(parsed) || !parsed.length || parsed.some(id => typeof id !== 'string' || !id)) {
        return c.json({ success: false, error: 'Not found' }, 404);
      }
      accounts = [...parsed, ...(broadcast.line_account_id ? [broadcast.line_account_id] : [])];
    } catch { return c.json({ success: false, error: 'Not found' }, 404); }
  }
  if (!await canAccessAllLineAccounts(db, c.get('staff'), accounts)) {
    return c.json({ success: false, error: 'Not found' }, 404);
  }

  const logged = await db
    .prepare('SELECT COUNT(*) AS cnt FROM messages_log WHERE broadcast_id = ?')
    .bind(id)
    .first<{ cnt: number }>();
  if (!logged) {
    return fail(c, 404, 'BROADCAST_NOT_FOUND_OR_QUERY_FAILED');
  }
  if (logged.cnt > 0) {
    return c.json({
      success: false,
      error: `messages_log has ${logged.cnt} entries — refusing to reset (would lose send trace)`,
    }, 409);
  }

  const result = await db
    .prepare(
      `UPDATE broadcasts
         SET status = 'draft',
             batch_offset = 0,
             total_count = 0,
             failed_account_ids = NULL,
             dedup_progress = NULL,
             success_count = 0,
             sent_at = NULL,
             batch_lock_at = NULL,
             line_request_id = NULL
       WHERE id = ?`,
    )
    .bind(id)
    .run();

  return c.json({
    success: true,
    data: { id, changes: result.meta.changes },
  });
});

/**
 * tag-vs-tag の cross-account 重複検出。tagsA に紐づく friend と tagsB に紐づく
 * friend を、profile picture URL の中間トークン (URL_TOKEN_SQL) で同一人物
 * 判定して、両方のグループに居る (= 別アカで両方のタグに紐付いてる) 人数を返す。
 *
 * 使い方: video-launch-rest が test-100/500/2000 既送ユーザーと cross-account で
 * 重複してないか確認する用。
 */
profileRefresh.post('/api/admin/tag-leak-check', requireRole('owner'), inputJsonBoundary({"tagsA":["array"],"tagsB":["array"]}), async (c) => {
  const body = await c.req.json<{ tagsA: string[]; tagsB: string[] }>();
  if (!Array.isArray(body.tagsA) || !Array.isArray(body.tagsB)) {
    return inputError(c, { success: false, error: 'tagsA/tagsB must be string arrays' }, 400, ["tagsA","tagsB"]);
  }
  const db = c.env.DB;
  const scope = await getVisibleLineAccountScope(db, c.get('staff'));
  const friendScope = accountScopeWhere(scope, 'f.line_account_id');
  const bindings = accountScopeBindings(scope);

  const buildIdentSql = (tagNames: string[]) => {
    const placeholders = sqlIdSet(tagNames).sql;
    return `
      SELECT DISTINCT COALESCE(
        CASE
          WHEN f.picture_url LIKE 'https://sprofile.line-scdn.net/%' THEN SUBSTR(f.picture_url, 42, 80)
          WHEN f.picture_url LIKE 'https://profile.line-scdn.net/%' THEN SUBSTR(f.picture_url, 41, 80)
          ELSE NULL
        END, 'uid:' || f.user_id, 'solo:' || f.id) AS ident_key
      FROM friends f
      INNER JOIN friend_tags ft ON ft.friend_id = f.id
      INNER JOIN tags t ON t.id = ft.tag_id
      WHERE t.name IN (${placeholders})
        AND f.is_following = 1 ${friendScope}
    `;
  };

  // tagsA / tagsB の ident_key set を計算 → intersection 数 = leak 数
  const sql = `
    WITH a AS (${buildIdentSql(body.tagsA)}),
         b AS (${buildIdentSql(body.tagsB)})
    SELECT
      (SELECT COUNT(*) FROM a) AS unique_a,
      (SELECT COUNT(*) FROM b) AS unique_b,
      (SELECT COUNT(*) FROM a WHERE ident_key IN (SELECT ident_key FROM b)) AS leaked
  `;
  const row = await db.prepare(sql).bind(...sqlIdSet(body.tagsA).binds, ...bindings, ...sqlIdSet(body.tagsB).binds, ...bindings).first<{
    unique_a: number;
    unique_b: number;
    leaked: number;
  }>();

  return c.json({
    success: true,
    data: row,
  });
});

/**
 * tag に居る人の中で、messages_log.content に特定文字列を含むメッセージを既に受信
 * している人数を返す。「同一友だちが過去に同じ告知を別経路 (test broadcast / 直送り
 * / scenario) で受け取ってないか」を確実に検出する用。
 *
 * cross-account 相当の人物単位検出も含めるため、tag 内 friend の ident_key と
 * 同一の ident_key を持つ別 friend が既受信なら counted (= 別アカで受信済 person)。
 */
profileRefresh.post('/api/admin/content-leak-check', requireRole('owner'), inputJsonBoundary({"tagName":["string"],"contentSubstring":["string"]}), async (c) => {
  const body = await c.req.json<{ tagName: string; contentSubstring: string }>();
  if (typeof body.tagName !== 'string' || typeof body.contentSubstring !== 'string' || !body.contentSubstring) {
    return inputError(c, { success: false, error: 'tagName + contentSubstring required' }, 400, ["tagName","contentSubstring"]);
  }
  const db = c.env.DB;
  const scope = await getVisibleLineAccountScope(db, c.get('staff'));
  const friendScope = accountScopeWhere(scope, 'f.line_account_id');
  const messageScope = accountScopeWhere(scope, 'COALESCE(ml.line_account_id, f.line_account_id)');
  const bindings = accountScopeBindings(scope);
  const idCol = `COALESCE(
    CASE
      WHEN f.picture_url LIKE 'https://sprofile.line-scdn.net/%' THEN SUBSTR(f.picture_url, 42, 80)
      WHEN f.picture_url LIKE 'https://profile.line-scdn.net/%' THEN SUBSTR(f.picture_url, 41, 80)
      ELSE NULL
    END, 'uid:' || f.user_id, 'solo:' || f.id)`;
  const sql = `
    WITH tag_friends AS (
      SELECT f.id AS friend_id, ${idCol} AS ident_key
      FROM friends f
      INNER JOIN friend_tags ft ON ft.friend_id = f.id
      INNER JOIN tags t ON t.id = ft.tag_id
      WHERE t.name = ? AND f.is_following = 1 ${friendScope}
    ),
    received AS (
      -- 任意の friend_id (同一 + 別人物含む) で content マッチした受信者
      SELECT DISTINCT f.id AS friend_id, ${idCol} AS ident_key
      FROM friends f
      INNER JOIN messages_log ml ON ml.friend_id = f.id
      WHERE ml.direction = 'outgoing' AND ml.content LIKE ? ${friendScope} ${messageScope}
    )
    SELECT
      (SELECT COUNT(DISTINCT ident_key) FROM tag_friends) AS unique_in_tag,
      (SELECT COUNT(DISTINCT ident_key) FROM tag_friends
        WHERE friend_id IN (SELECT friend_id FROM received)) AS same_friend_overlap,
      (SELECT COUNT(DISTINCT ident_key) FROM tag_friends
        WHERE ident_key IN (SELECT ident_key FROM received)) AS person_overlap
  `;
  const row = await db
    .prepare(sql)
    .bind(body.tagName, ...bindings, '%' + body.contentSubstring + '%', ...bindings, ...bindings)
    .first<{
      unique_in_tag: number;
      same_friend_overlap: number;
      person_overlap: number;
    }>();

  return c.json({ success: true, data: row });
});

/**
 * 配信状況の包括メトリクスを返す。account 別の friend 数 / 受信済人数、人物単位
 * (ident_key) の重複/未到達数、rest 配信時の重複予測などを一発で出す。
 */
profileRefresh.post('/api/admin/broadcast-coverage', requireRole('owner'), inputJsonBoundary({"tagName":["string"],"contentSubstring":["string"]}), async (c) => {
  const body = await c.req.json<{ tagName: string; contentSubstring: string }>();
  const db = c.env.DB;
  const scope = await getVisibleLineAccountScope(db, c.get('staff'));
  const friendScope = accountScopeWhere(scope, 'f.line_account_id');
  const messageScope = accountScopeWhere(scope, 'COALESCE(ml.line_account_id, f.line_account_id)');
  const bindings = accountScopeBindings(scope);

  const idCol = `COALESCE(
    CASE
      WHEN f.picture_url LIKE 'https://sprofile.line-scdn.net/%' THEN SUBSTR(f.picture_url, 42, 80)
      WHEN f.picture_url LIKE 'https://profile.line-scdn.net/%' THEN SUBSTR(f.picture_url, 41, 80)
      ELSE NULL
    END, 'uid:' || f.user_id, 'solo:' || f.id)`;

  // 1. アカウント別の friend rows + 受信済 rows
  const perAccountSql = `
    SELECT
      la.id AS account_id,
      la.name AS account_name,
      COUNT(DISTINCT f.id) AS friends_total,
      COUNT(DISTINCT CASE
        WHEN ml.id IS NOT NULL THEN f.id ELSE NULL END) AS friends_received
    FROM line_accounts la
    LEFT JOIN friends f ON f.line_account_id = la.id AND f.is_following = 1
    LEFT JOIN messages_log ml
      ON ml.friend_id = f.id
      AND ml.direction = 'outgoing'
      AND ml.content LIKE ? ${messageScope}
    WHERE la.is_active = 1 ${accountScopeWhere(scope, 'la.id')}
    GROUP BY la.id, la.name
    ORDER BY friends_total DESC
  `;
  const perAccount = await db
    .prepare(perAccountSql)
    .bind('%' + body.contentSubstring + '%', ...bindings, ...bindings)
    .all<{ account_id: string; account_name: string; friends_total: number; friends_received: number }>();

  // 2. 人物単位 (ident_key) の集計
  const personSql = `
    WITH all_following AS (
      SELECT f.id, f.line_account_id, ${idCol} AS ident_key
      FROM friends f
      INNER JOIN line_accounts la ON la.id = f.line_account_id
      WHERE f.is_following = 1 AND la.is_active = 1 ${friendScope}
    ),
    received AS (
      SELECT DISTINCT f.id AS friend_id, ${idCol} AS ident_key
      FROM friends f
      INNER JOIN messages_log ml ON ml.friend_id = f.id
      WHERE ml.direction = 'outgoing' AND ml.content LIKE ? ${friendScope} ${messageScope}
    )
    SELECT
      (SELECT COUNT(DISTINCT ident_key) FROM all_following) AS unique_total,
      (SELECT COUNT(DISTINCT ident_key) FROM received) AS unique_received,
      (SELECT COUNT(DISTINCT ident_key) FROM all_following
        WHERE ident_key NOT IN (SELECT ident_key FROM received)) AS unique_not_received
  `;
  const person = await db
    .prepare(personSql)
    .bind(...bindings, '%' + body.contentSubstring + '%', ...bindings, ...bindings)
    .first<{ unique_total: number; unique_received: number; unique_not_received: number }>();

  // 3. tag 内の重複漏れ詳細 — 「rest 配信したらどのアカで何人 leak するか」
  // rest tag 内の friend を ident_key でグルーピングし、各 ident_key について
  // 「他のアカで受信済の同一人物が居るか」「同一 friend が既に受信してるか」を見る。
  const tagLeakSql = `
    WITH tag_friends AS (
      SELECT f.id AS friend_id, f.line_account_id, ${idCol} AS ident_key
      FROM friends f
      INNER JOIN friend_tags ft ON ft.friend_id = f.id
      INNER JOIN tags t ON t.id = ft.tag_id
      WHERE t.name = ? AND f.is_following = 1 ${friendScope}
    ),
    received AS (
      SELECT DISTINCT f.id AS friend_id, ${idCol} AS ident_key
      FROM friends f
      INNER JOIN messages_log ml ON ml.friend_id = f.id
      WHERE ml.direction = 'outgoing' AND ml.content LIKE ? ${friendScope} ${messageScope}
    )
    SELECT
      tf.line_account_id AS account_id,
      la.name AS account_name,
      COUNT(DISTINCT tf.ident_key) AS rest_unique,
      COUNT(DISTINCT CASE WHEN tf.friend_id IN (SELECT friend_id FROM received) THEN tf.ident_key ELSE NULL END) AS same_friend_dup,
      COUNT(DISTINCT CASE WHEN tf.ident_key IN (SELECT ident_key FROM received) THEN tf.ident_key ELSE NULL END) AS person_dup
    FROM tag_friends tf
    INNER JOIN line_accounts la ON la.id = tf.line_account_id
    GROUP BY tf.line_account_id, la.name
    ORDER BY rest_unique DESC
  `;
  const tagLeakBreakdown = await db
    .prepare(tagLeakSql)
    .bind(body.tagName, ...bindings, '%' + body.contentSubstring + '%', ...bindings, ...bindings)
    .all<{ account_id: string; account_name: string; rest_unique: number; same_friend_dup: number; person_dup: number }>();

  return c.json({
    success: true,
    data: {
      perAccount: perAccount.results,
      person: person,
      tagLeakBreakdown: tagLeakBreakdown.results,
    },
  });
});

/**
 * tag から「指定 content の messages_log を持つ人物 (cross-account 含む)」を除外。
 * profile picture URL の中間トークンで人物単位 (ident_key) で照合する。
 *
 * 用途: video-launch-rest の中で、test 100/500/2000/test10/直送り 等で既に
 * 動画 URL を受け取ってる人を除外して、二重配信を防ぐ。
 */
profileRefresh.post('/api/admin/tag-remove-content-dups', requireRole('owner'), inputJsonBoundary({"tagName":["string"],"contentSubstring":["string"]}), async (c) => {
  const body = await c.req.json<{ tagName: string; contentSubstring: string }>();
  const db = c.env.DB;
  const scope = await getVisibleLineAccountScope(db, c.get('staff'));
  const friendScope = accountScopeWhere(scope, 'f.line_account_id');
  const messageScope = accountScopeWhere(scope, 'COALESCE(ml.line_account_id, f.line_account_id)');
  const bindings = accountScopeBindings(scope);

  const idCol = `COALESCE(
    CASE
      WHEN f.picture_url LIKE 'https://sprofile.line-scdn.net/%' THEN SUBSTR(f.picture_url, 42, 80)
      WHEN f.picture_url LIKE 'https://profile.line-scdn.net/%' THEN SUBSTR(f.picture_url, 41, 80)
      ELSE NULL
    END, 'uid:' || f.user_id, 'solo:' || f.id)`;

  // tag に紐付く friend_tags のうち、「同一 ident_key の friend がメッセージ既受信」
  // の行を削除する。received CTE は ident_key だけ持てば十分。
  const deleteSql = `
    DELETE FROM friend_tags
    WHERE tag_id IN (SELECT id FROM tags WHERE name = ? ${accountScopeWhere(scope, 'tags.line_account_id')})
      AND friend_id IN (
        WITH received_idents AS (
          SELECT DISTINCT ${idCol} AS ident_key
          FROM friends f
          INNER JOIN messages_log ml ON ml.friend_id = f.id
          WHERE ml.direction = 'outgoing' AND ml.content LIKE ? ${friendScope} ${messageScope}
        )
        SELECT f.id FROM friends f
        WHERE ${idCol} IN (SELECT ident_key FROM received_idents) ${friendScope}
      )
  `;
  const result = await db
    .prepare(deleteSql)
    .bind(body.tagName, ...bindings, '%' + body.contentSubstring + '%', ...bindings, ...bindings, ...bindings)
    .run();

  return c.json({
    success: true,
    data: {
      tagName: body.tagName,
      removedRows: result.meta.changes ?? 0,
    },
  });
});

/**
 * 各 LINE アカウントで auto_reply (および automation) が実際に発火した件数を返す。
 * keyword (incoming text) ごとにブレイクダウンして「どのアカでどの keyword が
 * いくら発火したか」を確認する用。directionnal: incoming + outgoing 両方を
 * 同じ friend / 同じ時間帯で見る。
 */
profileRefresh.get('/api/admin/auto-reply-stats', requireRole('owner'), async (c) => {
  const db = c.env.DB;
  const days = Number.parseInt(c.req.query('days') ?? '30', 10);
  const adminScope = await adminAccountScope(c);

  // 1. 各アカウントで「auto_replies の keyword と一致する incoming text」の件数
  //    = 「ユーザーが trigger した回数」
  const sinceDate = new Date(Date.now() - days * 24 * 60 * 60_000)
    .toISOString().slice(0, -1) + '+09:00';

  const incomingByAccount = await db
    .prepare(`
      SELECT
        f.line_account_id AS account_id,
        ml.content AS keyword,
        COUNT(*) AS incoming_count
      FROM messages_log ml
      INNER JOIN friends f ON f.id = ml.friend_id
      WHERE ml.direction = 'incoming'
        AND ml.message_type = 'text'
        AND ml.created_at >= ?
        AND ml.content IN (SELECT keyword FROM auto_replies WHERE is_active = 1 AND deleted_at IS NULL)
        ${adminScope.where}
      GROUP BY f.line_account_id, ml.content
      ORDER BY incoming_count DESC
    `)
    .bind(sinceDate, ...accountScopeBindings(adminScope.scope))
    .all<{ account_id: string | null; keyword: string; incoming_count: number }>();

  // 2. 各アカウントで auto_reply / automation source の outgoing 件数
  const outgoingByAccount = await db
    .prepare(`
      SELECT
        line_account_id AS account_id,
        source,
        COUNT(*) AS outgoing_count
      FROM messages_log
      WHERE direction = 'outgoing'
        AND source IN ('auto_reply', 'automation', 'automation_backfill')
        AND created_at >= ?
        ${accountScopeWhere(adminScope.scope, 'line_account_id')}
      GROUP BY line_account_id, source
    `)
    .bind(sinceDate, ...accountScopeBindings(adminScope.scope))
    .all<{ account_id: string | null; source: string; outgoing_count: number }>();

  // 3. アカウント名 lookup
  const accNameById = await visibleAccountNames(db, adminScope.scope.allowedAccountIds);

  return c.json({
    success: true,
    data: {
      sinceDate,
      days,
      incomingByAccount: (incomingByAccount.results ?? []).map((r) => ({
        accountId: r.account_id,
        accountName: r.account_id ? accNameById.get(r.account_id) ?? null : '(null)',
        keyword: r.keyword,
        incomingCount: r.incoming_count,
      })),
      outgoingByAccount: (outgoingByAccount.results ?? []).map((r) => ({
        accountId: r.account_id,
        accountName: r.account_id ? accNameById.get(r.account_id) ?? null : '(null/legacy)',
        source: r.source,
        outgoingCount: r.outgoing_count,
      })),
    },
  });
});

/**
 * 直近 N 件の incoming + outgoing messages_log を返す。debug 用。
 */
profileRefresh.get('/api/admin/recent-messages', requireRole('owner'), async (c) => {
  const limit = parseOffsetPaging({ limit: c.req.query('limit') }, { defaultLimit: 20, maxLimit: 100 }).limit;
  const db = c.env.DB;
  const adminScope = await adminAccountScope(c, 'COALESCE(ml.line_account_id, f.line_account_id)');

  const res = await db
    .prepare(`
      SELECT ml.id, ml.direction, ml.message_type, ml.source, ml.line_account_id,
             SUBSTR(ml.content, 1, 80) AS preview, ml.created_at,
             f.display_name, f.id AS friend_id
      FROM messages_log ml
      LEFT JOIN friends f ON f.id = ml.friend_id
      WHERE 1 = 1
        ${adminScope.where}
      ORDER BY ml.created_at DESC
      LIMIT ?
    `)
    .bind(...accountScopeBindings(adminScope.scope), limit)
    .all();

  const accNameById = await visibleAccountNames(db, adminScope.scope.allowedAccountIds);

  const responseItems = (res.results ?? []).map((r) => {
      const row = r as Record<string, unknown>;
      const accId = row.line_account_id as string | null;
      return {
        id: row.id,
        direction: row.direction,
        messageType: row.message_type,
        source: row.source,
        accountId: accId,
        accountName: accId ? accNameById.get(accId) ?? null : '(null)',
        friendName: row.display_name,
        friendId: row.friend_id,
        preview: row.preview,
        createdAt: row.created_at,
      };
    });
  return c.json(buildOffsetListResponse({ success: true, data: responseItems, items: responseItems, total: null, paging: { limit, offset: 0 }, sort: [] }));
});

/**
 * 全 automation rules を最小限で dump (account 別に何の rule があるか確認用)。
 */
profileRefresh.get('/api/admin/automations-summary', requireRole('owner'), async (c) => {
  const db = c.env.DB;
  const adminScope = await adminAccountScope(c, 'line_account_id');
  const res = await db
    .prepare(`SELECT id, name, event_type, line_account_id, is_active, conditions,
                     SUBSTR(actions, 1, 80) AS actions_preview
                FROM automations
               WHERE 1 = 1
                 ${adminScope.where}
               ORDER BY line_account_id, event_type`)
    .bind(...accountScopeBindings(adminScope.scope))
    .all();
  const accNameById = await visibleAccountNames(db, adminScope.scope.allowedAccountIds);
  return c.json({
    success: true,
    data: (res.results ?? []).map((r) => {
      const row = r as Record<string, unknown>;
      const accId = row.line_account_id as string | null;
      let conds: Record<string, unknown> = {};
      try { conds = JSON.parse(row.conditions as string); } catch {}
      return {
        id: row.id,
        name: row.name,
        eventType: row.event_type,
        accountId: accId,
        accountName: accId ? accNameById.get(accId) ?? null : '(全アカ)',
        isActive: Boolean(row.is_active),
        keyword: conds.keyword ?? conds.keyword_exact ?? null,
        actionsPreview: row.actions_preview,
      };
    }),
  });
});

profileRefresh.get('/api/admin/friend-debug/:id', requireRole('owner'), async (c) => {
  const id = c.req.param('id');
  const db = c.env.DB;
  const adminScope = await adminAccountScope(c);
  const friend = await db
    .prepare(`SELECT id, display_name, line_platform_user_id AS line_user_id, line_account_id, is_following, user_id
                FROM friends f
               WHERE id = ?
                 ${adminScope.where}`)
    .bind(id, ...accountScopeBindings(adminScope.scope))
    .first();
  if (!friend) {
    return fail(c, 404, 'FRIEND_NOT_FOUND');
  }
  const accNameById = await visibleAccountNames(db, adminScope.scope.allowedAccountIds);
  const accId = (friend as Record<string, unknown> | null)?.line_account_id as string | null | undefined;
  return c.json({
    success: true,
    data: {
      friend,
      accountName: accId ? accNameById.get(accId) ?? null : null,
    },
  });
});

export { profileRefresh };
