import { jstCalendar as japanCalendar } from '@line-crm/shared';
import { logger } from '@line-crm/shared/server';
import { parseJsonArray } from './broadcast-json.js';
import { sqlIdSet } from '@line-crm/db/id-queries';
import { inputError } from '../lib/input-errors.js';
import { fail } from '../lib/fail.js';
import { getBroadcastById, countBroadcastLedger, countRetryableRecipients, deriveBroadcastDisplayStatus, BROADCAST_DISPLAY_STATUS_LABELS } from '@line-crm/db';
import { LineClient } from '@line-crm/line-sdk';
import { addTestLabel, assertMessagePartsResolved, autoTrackMessageParts, buildMessages, combinedMessageContent, parseBroadcastMessageParts, renderMessageParts } from '../features/broadcasts/broadcast-message-set/index.js';
import type { SegmentCondition } from '@line-crm/shared';
import { getLineAccountById } from '@line-crm/db';
import type { Env } from '../worker-env.js';
import { resolveLineToken } from '../services/line-token.js';

import { scopeSegmentQuery } from '../services/segment-query-scope.js';
import { ACCOUNT_KEYS } from '../middleware/feature-body-accounts.js';
import { ACCOUNT_QUERY_KEYS } from '../middleware/tenant-scope.js';
import { canAccessAllLineAccounts, getVisibleLineAccountScope } from '../services/account-access.js';
import { canAccessBroadcast, failedBreakdown, ACCOUNT_ACCESS_ERROR } from './broadcasts-definition.js';
import type { Context } from 'hono';

export const get__api_broadcasts_id_insight_1 = async (c: Context<Env, "/api/broadcasts/:id/insight">) => {
  const id = c.req.param('id');
  const broadcast = await getBroadcastById(c.env.DB, id);
  if (!broadcast || !await canAccessBroadcast(c.env.DB, c.get('staff'), broadcast)) {
    return fail(c, 404, 'BROADCAST_NOT_FOUND');
  }
  const insight = await c.env.DB.prepare(
    'SELECT * FROM broadcast_insights WHERE broadcast_id = ? ORDER BY created_at DESC LIMIT 1'
  ).bind(id).first<Record<string, unknown>>();
  const linkRows = await c.env.DB.prepare(
    `SELECT tl.id, btl.label, tl.original_url,
              COUNT(lc.id) AS click_count,
              COUNT(DISTINCT lc.friend_id) AS unique_click_count,
              MAX(lc.clicked_at) AS last_clicked_at
         FROM broadcast_tracked_links btl
         JOIN tracked_links tl ON tl.id = btl.tracked_link_id
         LEFT JOIN link_clicks lc ON lc.tracked_link_id = tl.id
        WHERE btl.broadcast_id = ?
        GROUP BY tl.id, btl.label, tl.original_url
        ORDER BY click_count DESC, tl.id`,
  ).bind(id).all<{
    id: string;
    label: string;
    original_url: string;
    click_count: number;
    unique_click_count: number;
    last_clicked_at: string | null;
  }>();

  if (!insight && linkRows.results.length === 0) {
    return c.json({ success: true, data: null, message: 'Insight not yet available' });
  }

  const delivered = insight?.delivered == null ? null : Number(insight.delivered);
  const links = linkRows.results.map((row) => ({
    id: row.id,
    label: row.label,
    url: row.original_url,
    clickCount: Number(row.click_count),
    uniqueClickCount: Number(row.unique_click_count),
    clickRate: delivered && delivered > 0 ? Number(row.unique_click_count) / delivered : null,
    lastClickedAt: row.last_clicked_at,
  }));

  return c.json({
    success: true,
    data: {
      broadcastId: id,
      delivered,
      uniqueImpression: insight?.unique_impression ?? null,
      uniqueClick: insight?.unique_click ?? null,
      uniqueMediaPlayed: insight?.unique_media_played ?? null,
      openRate: insight?.open_rate ?? null,
      clickRate: insight?.click_rate ?? null,
      status: insight?.status ?? 'pending',
      fetchedAt: insight?.fetched_at ?? null,
      opens: {
        count: insight?.unique_impression ?? null,
        denominator: delivered,
        rate: insight?.open_rate ?? null,
        asOf: insight?.fetched_at ?? null,
        state: insight?.status === 'ready' ? 'available' : 'unavailable',
        reason: insight?.status === 'ready' ? null : 'LINE集計をまだ取得できません',
      },
      links,
    },
  });
};

export const post__api_broadcasts_id_fetch_insight_2 = async (c: Context<Env, "/api/broadcasts/:id/fetch-insight">) => {
  const id = c.req.param('id');
  const broadcast = await getBroadcastById(c.env.DB, id);
  if (broadcast?.hq_run_id) return c.json({ success: false, error: '統括からの配信は、統括の配信画面で操作してください' }, 403);
  if (!broadcast) {
    return fail(c, 404, 'BROADCAST_NOT_FOUND');
  }
  if (!await canAccessBroadcast(c.env.DB, c.get('staff'), broadcast)) {
    return fail(c, 404, 'BROADCAST_NOT_FOUND');
  }
  if (broadcast.status !== 'sent') {
    return inputError(c, { success: false, error: 'Broadcast has not been sent yet' }, 400, []);
  }

  // DBから直接取得してline_request_id/aggregation_unit/account_ids/failed_account_idsを確実に読む
  const rawBroadcast = await c.env.DB.prepare(
    'SELECT line_request_id, aggregation_unit, line_account_id, target_type, account_ids, failed_account_ids FROM broadcasts WHERE id = ?',
  ).bind(id).first<Record<string, string | null>>();
  const lineRequestId = rawBroadcast?.line_request_id || null;
  const aggregationUnit = rawBroadcast?.aggregation_unit || null;
  const targetType = rawBroadcast?.target_type || null;

  if (!lineRequestId && !aggregationUnit) {
    return inputError(c, { success: false, error: 'No line_request_id or aggregation_unit available for this broadcast' }, 400, []);
  }

  let delivered: number | null = null;
  let uniqueImpression: number | null = null;
  let uniqueClick: number | null = null;
  let uniqueMediaPlayed: number | null = null;
  let rawResponse: string = '{}';

  const sentDate = broadcast.sent_at!.slice(0, 10).replace(/-/g, '');

  if (lineRequestId) {
    // broadcast API ('all') 経由の insight: 単一 lineRequestId で取れる
    const accountId = rawBroadcast?.line_account_id || null;
    let accountToken: string | null = null;
    if (accountId) {
      const { getLineAccountById } = await import('@line-crm/db');
      const account = await getLineAccountById(c.env.DB, accountId);
      accountToken = account?.channel_access_token ?? null;
    }
    const accessToken = resolveLineToken({
      accountToken,
      defaultToken: c.env.LINE_CHANNEL_ACCESS_TOKEN,
      accountId,
      context: 'broadcasts.message-insight',
    });
    const lineClient = new LineClient(accessToken);
    const response = await lineClient.getMessageEventInsight(lineRequestId) as Record<string, unknown>;
    const overview = response.overview as Record<string, unknown> | undefined;
    delivered = (overview?.delivered as number) ?? null;
    uniqueImpression = (overview?.uniqueImpression as number) ?? null;
    uniqueClick = (overview?.uniqueClick as number) ?? null;
    uniqueMediaPlayed = (overview?.uniqueMediaPlayed as number) ?? null;
    rawResponse = JSON.stringify(response);
  } else if (aggregationUnit && targetType === 'multi-account-dedup') {
    // 多アカ dedup: 同じ unit 名を全アカウントの multicast で共有しているが、
    // LINE 側のカウントはチャネルごとに独立しているため、各アカウントの
    // channel_access_token で getUnitInsight を呼んで合算する。
    // failed_account_ids は除外しない: アカウントは途中バッチで例外を出しても
    // それ以前のバッチは送信成功している可能性があるため、部分配信の insight も
    // 拾うべき。
    const accountIds = parseJsonArray(rawBroadcast?.account_ids) ?? [];

    const { getLineAccountById } = await import('@line-crm/db');
    const responses: Array<{ accountId: string; data: Record<string, unknown> }> = [];

    let aggImpression = 0;
    let aggClick = 0;
    let aggMedia = 0;
    let hasAnyData = false;
    let allCallsFailed = true;

    for (const aid of accountIds) {
      // is_active は意図的にチェックしない: 送信時にアクティブだったアカウントが
      // insight 取得時に deactivate されてる可能性がある。token があれば LINE
      // API は叩けるので、過去配信の集計を欠損させない。
      const account = await getLineAccountById(c.env.DB, aid);
      if (!account) continue;
      const client = new LineClient(account.channel_access_token);
      try {
        const response = await client.getUnitInsight(aggregationUnit, sentDate, sentDate) as Record<string, unknown>;
        responses.push({ accountId: aid, data: response });
        allCallsFailed = false;
        const messages = response.messages as Array<Record<string, unknown>> | undefined;
        const overview = messages?.[0] || {};
        aggImpression += (overview.uniqueImpression as number) ?? 0;
        aggClick += (overview.uniqueClick as number) ?? 0;
        aggMedia += (overview.uniqueMediaPlayed as number) ?? 0;
        if (messages && messages.length > 0) hasAnyData = true;
      } catch (err) {
        logger.error("broadcasts.broadcasts_id_fetch_insight_post_failed");
        responses.push({ accountId: aid, data: { error: String(err) } });
      }
    }

    if (allCallsFailed && accountIds.length > 0) {
      // 全アカウントの API 呼び出しが失敗した場合、blank insight を保存して
      // retry ボタンを潰さないように 502 を返す (ユーザーが再試行できる状態)。
      return c.json({
        success: false,
        error: 'All account insight fetches failed; please retry later',
      }, 502);
    }

    if (hasAnyData) {
      uniqueImpression = aggImpression;
      uniqueClick = aggClick;
      uniqueMediaPlayed = aggMedia;
    }
    // delivered は unit insight には含まれない (LINE 仕様)。dedup の場合は
    // broadcasts.success_count を delivered として採用する (送達数の近似値)。
    delivered = (broadcast as unknown as Record<string, number | null>).success_count ?? null;
    rawResponse = JSON.stringify({ perAccount: responses });
  } else if (aggregationUnit) {
    // tag broadcast (単一アカ): 既存パス
    const accountId = rawBroadcast?.line_account_id || null;
    let accountToken: string | null = null;
    if (accountId) {
      const { getLineAccountById } = await import('@line-crm/db');
      const account = await getLineAccountById(c.env.DB, accountId);
      accountToken = account?.channel_access_token ?? null;
    }
    const accessToken = resolveLineToken({
      accountToken,
      defaultToken: c.env.LINE_CHANNEL_ACCESS_TOKEN,
      accountId,
      context: 'broadcasts.unit-insight',
    });
    const lineClient = new LineClient(accessToken);
    const response = await lineClient.getUnitInsight(aggregationUnit, sentDate, sentDate) as Record<string, unknown>;
    const messages = response.messages as Array<Record<string, unknown>> | undefined;
    const overview = messages?.[0] || {};
    uniqueImpression = (overview.uniqueImpression as number) ?? null;
    uniqueClick = (overview.uniqueClick as number) ?? null;
    uniqueMediaPlayed = (overview.uniqueMediaPlayed as number) ?? null;
    rawResponse = JSON.stringify(response);
  }

  const openRate = (delivered && uniqueImpression) ? uniqueImpression / delivered : null;
  const clickRate = (delivered && uniqueClick) ? uniqueClick / delivered : null;

  // 旧コードの `ON CONFLICT(broadcast_id)` は broadcast_insights.broadcast_id に
  // UNIQUE 制約がないため D1 が `SQLITE_ERROR: ON CONFLICT clause does not match
  // any PRIMARY KEY or UNIQUE constraint` を返して 500 化していた。
  // SELECT で既存の pending 行を探して UPDATE、なければ INSERT する明示的 upsert に置き換え。
  const { jstNow } = await import('@line-crm/db');
  const now = jstNow();
  const existing = await c.env.DB.prepare(
    'SELECT id FROM broadcast_insights WHERE broadcast_id = ? ORDER BY created_at DESC LIMIT 1',
  ).bind(id).first<{ id: string }>();

  if (existing) {
    await c.env.DB.prepare(
      `UPDATE broadcast_insights SET
           delivered = ?, unique_impression = ?, unique_click = ?, unique_media_played = ?,
           open_rate = ?, click_rate = ?, raw_response = ?, status = 'ready', fetched_at = ?
         WHERE id = ?`,
    ).bind(delivered, uniqueImpression, uniqueClick, uniqueMediaPlayed, openRate, clickRate, rawResponse, now, existing.id).run();
  } else {
    const insightId = crypto.randomUUID();
    await c.env.DB.prepare(
      `INSERT INTO broadcast_insights (id, broadcast_id, delivered, unique_impression, unique_click, unique_media_played, open_rate, click_rate, raw_response, status, fetched_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?)`,
    ).bind(insightId, id, delivered, uniqueImpression, uniqueClick, uniqueMediaPlayed, openRate, clickRate, rawResponse, now, now).run();
  }

  return c.json({
    success: true,
    data: { delivered, uniqueImpression, uniqueClick, uniqueMediaPlayed, openRate, clickRate },
  });
};

export const post__api_broadcasts_id_test_send_3 = async (c: Context<Env, "/api/broadcasts/:id/test-send">) => {
  const id = c.req.param('id');
  const broadcast = await getBroadcastById(c.env.DB, id);
  if (broadcast?.hq_run_id) return c.json({ success: false, error: '統括からの配信は、統括の配信画面で操作してください' }, 403);
  if (!broadcast) return fail(c, 404, 'BROADCAST_NOT_FOUND');
  if (!await canAccessBroadcast(c.env.DB, c.get('staff'), broadcast)) {
    return fail(c, 404, 'BROADCAST_NOT_FOUND');
  }
  if (broadcast.status !== 'draft' && broadcast.status !== 'scheduled') {
    return inputError(c, { success: false, error: 'Only draft or scheduled broadcasts can be test-sent' }, 400, []);
  }

  const raw = broadcast as unknown as Record<string, unknown>;
  const accountId = raw.line_account_id as string | null;
  if (!accountId) return inputError(c, { success: false, error: 'Broadcast has no line_account_id' }, 400, ["accountId"]);


  const setting = await c.env.DB.prepare(
    `SELECT value FROM account_settings WHERE line_account_id = ? AND key = 'test_recipients'`
  ).bind(accountId).first<{ value: string }>();
  if (!setting) return inputError(c, { success: false, error: 'No test recipients configured' }, 400, []);

  const friendIds: string[] = JSON.parse(setting.value);
  if (friendIds.length === 0) return inputError(c, { success: false, error: 'No test recipients configured' }, 400, []);
  if (friendIds.length > 5) {
    return inputError(c, { success: false, error: 'テスト送信の送信先は5件までにしてください' }, 400, []);
  }

  const staffId = c.get('staff')!.id;
  // D027: 10秒制限の確認と記録を1文の原子書き込みにまとめる。
  // SELECT→INSERT の確認後書き込みだと、並行2件が両方確認を通り
  // 両方LINE送信する（check-then-act の窓）。記録できた件数で判定し、
  // 記録できなかった側は 429 で止める。外部送信より先に試行を記録し、
  // 二度押しも早い段階で止める点は変えない。
  const claim = await c.env.DB.prepare(
    `INSERT INTO operation_audit (id, target_kind, target_id, action, actor_id, detail_json)
       SELECT ?, 'broadcast', ?, 'test_send', ?, ?
       WHERE NOT EXISTS (
         SELECT 1 FROM operation_audit
          WHERE target_kind = 'broadcast' AND target_id = ?
            AND action = 'test_send' AND actor_id = ?
            AND datetime(created_at) >= datetime('now', '+9 hours', '-10 seconds')
       )`,
  ).bind(
    crypto.randomUUID(),
    id,
    staffId,
    JSON.stringify({ recipientCount: friendIds.length }),
    id,
    staffId,
  ).run();
  if ((claim.meta.changes ?? 0) !== 1) {
    return c.json({ success: false, error: '短時間に繰り返し送信しています。10秒待ってからやり直してください' }, { status: 429, headers: { 'Retry-After': '10' } });
  }

  const placeholders = sqlIdSet(friendIds).sql;
  const friends = await c.env.DB.prepare(
    `SELECT id, line_platform_user_id AS line_user_id, display_name FROM friends WHERE id IN (${placeholders})`
  ).bind(...(friendIds.length ? sqlIdSet(friendIds).binds : [])).all<{ id: string; line_user_id: string; display_name: string | null }>();

  const account = await getLineAccountById(c.env.DB, accountId);
  if (!account) return fail(c, 400, 'LINE_ACCOUNT_NOT_FOUND', {}, []);
  const lineClient = new LineClient(account.channel_access_token);

  let parts;
  try {
    parts = addTestLabel(parseBroadcastMessageParts({
      messageType: broadcast.message_type,
      messageContent: broadcast.message_content,
      messageBubblesJson: broadcast.message_bubbles_json,
      messageOptionsJson: broadcast.message_options_json,
      altText: raw.alt_text as string | null,
    }));
  } catch (messageError) {
    return inputError(c, {
      success: false,
      error: messageError instanceof Error ? messageError.message : '配信内容を読み取れません',
    }, 400, ["messageContent"]);
  }
  parts = await autoTrackMessageParts(
    c.env.DB,
    parts,
    c.env.WORKER_URL,
    accountId,
    broadcast.track_links !== 0,
    broadcast.id,
  );

  const liffId = (account as unknown as { liff_id?: string | null }).liff_id ?? null;
  /*
   * 差し込みの値は、本番の配信と同じものを使う。
   *
   * ここだけ {{name}} と {{liff_id}} しか渡さないと、友だち情報や共通情報を
   * 使った本文は `assertNoUnresolvedBroadcastVariables` で落ちる。
   * **確かめるための機能が、確かめたい本文だけ通らない**ことになる。
   */
  const { resolveSendCommonVars, CommonVarResolutionFailedError, contentNeedsFriendFields } = await import('../services/interpolation-context.js');
  const { getFriendFieldMap } = await import('@line-crm/db');
  const allContent = combinedMessageContent(parts);
  let commonVars: Record<string, string> | undefined;
  try {
    commonVars = await resolveSendCommonVars(c.env.DB, accountId, allContent, {
      kind: 'test_send', id: c.req.param('id'),
    });
  } catch (error) {
    if (error instanceof CommonVarResolutionFailedError) {
      return inputError(c, {
        success: false,
        error: `共通情報を解決できません: ${error.failures.map((f) => `{{var.${f.varKey}}}`).join(', ')}`,
      }, 422, ["CommonVarResolutionFailedError"]);
    }
    throw error;
  }
  // 配信日の起点は「いま」。テスト送信は今すぐ届くので、今日の日付でよい。
  const testSendAt = new Date();

  let sent = 0;
  let failed = 0;
  const now = japanCalendar().toISOString().replace('Z', '+09:00');

  for (const friend of friends.results) {
    try {
      // 共通情報は上で厳格解決済み。ここでは友だち情報欄だけを引く。
      const fields = contentNeedsFriendFields(allContent)
        ? await getFriendFieldMap(c.env.DB, friend.id)
        : undefined;
      const rendered = renderMessageParts(parts, {
        liffId,
        displayName: friend.display_name,
        fields,
        vars: commonVars,
        deliveredAt: testSendAt,
      });
      assertMessagePartsResolved(rendered);
      await lineClient.pushMessage(friend.line_user_id, buildMessages(rendered));
      sent++;
      await c.env.DB.batch(rendered.map((part) => c.env.DB.prepare(
        `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, delivery_type, source, created_at)
           VALUES (?, ?, 'outgoing', ?, ?, NULL, 'test', 'broadcast', ?)`
      ).bind(crypto.randomUUID(), friend.id, part.messageType, part.messageContent, now)));
    } catch (err) {
      logger.error("broadcasts.broadcasts_id_test_send_post_failed");
      failed++;
    }
  }

  return c.json({ success: true, sent, failed });
};

export const get__api_broadcasts_id_progress_4 = async (c: Context<Env, "/api/broadcasts/:id/progress">) => {
  const id = c.req.param('id');
  const broadcast = await getBroadcastById(c.env.DB, id);
  if (!broadcast) return c.json({ success: false, error: 'Not found' }, 404);
  if (!await canAccessBroadcast(c.env.DB, c.get('staff'), broadcast)) {
    return c.json({ success: false, error: 'Not found' }, 404);
  }

  const raw = broadcast as unknown as Record<string, unknown>;
  const accountIds = broadcast.target_type === 'multi-account-dedup'
    ? parseJsonArray(raw.account_ids) ?? []
    : typeof raw.line_account_id === 'string' && raw.line_account_id
      ? [raw.line_account_id]
      : [];
  let perAccountStats: Array<{
    accountId: string;
    accountName: string;
    sent: number;
    uniqueImpression: null;
    uniqueClick: null;
  }> = [];
  if (accountIds.length > 0) {
    const placeholders = sqlIdSet(accountIds).sql;
    const [sentRows, accountRows] = await Promise.all([
      c.env.DB.prepare(
        `SELECT COALESCE(ml.line_account_id, f.line_account_id) AS account_id, COUNT(*) AS sent
           FROM messages_log ml
           INNER JOIN friends f ON f.id = ml.friend_id
          WHERE ml.broadcast_id = ? AND ml.direction = 'outgoing'
            AND COALESCE(ml.line_account_id, f.line_account_id) IN (${placeholders})
          GROUP BY COALESCE(ml.line_account_id, f.line_account_id)`,
      ).bind(id, ...(accountIds.length ? sqlIdSet(accountIds).binds : [])).all<{ account_id: string; sent: number }>(),
      c.env.DB.prepare(`SELECT id, name FROM line_accounts WHERE id IN (${placeholders})`)
        .bind(...(accountIds.length ? sqlIdSet(accountIds).binds : [])).all<{ id: string; name: string }>(),
    ]);
    const sentByAccount = new Map(sentRows.results.map((row) => [row.account_id, Number(row.sent)]));
    const nameByAccount = new Map(accountRows.results.map((row) => [row.id, row.name]));
    perAccountStats = accountIds.map((accountId) => ({
      accountId,
      accountName: nameByAccount.get(accountId) ?? accountId,
      sent: sentByAccount.get(accountId) ?? 0,
      uniqueImpression: null,
      uniqueClick: null,
    }));
  }
  /*
   * 送達台帳の内訳。画面はこの4つを別々に出す。
   *
   *   sent          … 届いた
   *   failed        … 届かなかった。**再送の対象**
   *   unknown       … 外へ出たかもしれないが確かめられない。再送しない
   *   inFlight      … いま送っている途中
   *
   * `successCount` だけだと「残りは失敗」と読めてしまい、送達不明の相手を
   * 再送してよいものと誤解させる。
   */
  const [ledger, breakdown, retryableCount] = await Promise.all([
    countBroadcastLedger(c.env.DB, id),
    failedBreakdown(c.env.DB, id),
    countRetryableRecipients(c.env.DB, id),
  ]);
  const ledgerRows = ledger.sent + ledger.failed + ledger.unknown + ledger.claimed;
  const displayStatus = deriveBroadcastDisplayStatus({
    status: broadcast.status,
    approvalStatus: (raw.approval_status as string | null | undefined) ?? 'none',
    scheduledAt: broadcast.scheduled_at ?? null,
    stopped: !!(raw.stopped_at),
    sent: ledger.sent,
    failed: ledger.failed,
    unknown: ledger.unknown,
    ledgerRows,
  });
  return c.json({
    success: true,
    data: {
      status: broadcast.status,
      displayStatus,
      displayStatusLabel: BROADCAST_DISPLAY_STATUS_LABELS[displayStatus],
      stopped: !!raw.stopped_at,
      stoppedAt: (raw.stopped_at as string | null | undefined) ?? null,
      sendAttemptNo: Number(raw.send_attempt_no ?? 1),
      totalCount: broadcast.total_count,
      successCount: broadcast.success_count,
      batchOffset: raw.batch_offset as number,
      ledger: {
        sent: ledger.sent,
        failed: ledger.failed,
        failedTemporary: breakdown.temporary,
        failedPermanent: breakdown.permanent,
        unknown: ledger.unknown,
        inFlight: Math.max(0, ledger.claimed - Math.max(0, retryableCount - breakdown.temporary)),
        retryableCount,
      },
      perAccountStats,
    },
  });
};

export const post__api_segments_count_5 = async (c: Context<Env, "/api/segments/count">) => {
  const body = await c.req.json<{ conditions: unknown; accountId?: string } & Record<string, unknown>>();
  try {
    const accountId = body.accountId;
    const alternateAccounts = [
      ...ACCOUNT_KEYS.filter(key => key !== 'accountId').flatMap(key => Object.hasOwn(body, key) ? [body[key]] : []),
      ...ACCOUNT_QUERY_KEYS.flatMap(key => c.req.queries(key) ?? []),
    ];
    if (['accountIds', 'lineAccountIds'].some(key => Object.hasOwn(body, key))
      || (Object.hasOwn(body, 'accountId') && (typeof accountId !== 'string' || !accountId.trim()))
      || alternateAccounts.some(value => accountId === undefined || value !== accountId)) {
      return inputError(c, { success: false, error: '集計するLINEアカウントの指定が一致していません' }, 400, ['accountId']);
    }
    if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [accountId ?? null])) {
      return c.json({ success: false, error: ACCOUNT_ACCESS_ERROR }, 403);
    }
    const { buildPublicSegmentQuery } = await import('../services/segment-query.js');
    const { sql, bindings } = buildPublicSegmentQuery(body.conditions as SegmentCondition);

    const scope = await getVisibleLineAccountScope(c.env.DB, c.get('staff'));
    const scoped = scopeSegmentQuery({ sql, bindings }, accountId
      ? { allowedAccountIds: [accountId], canSeeUnassigned: false }
      : scope);

    /*
     * 集計 SQL は副問い合わせに包んで数える。SELECT から FROM までを正規表現で置換すると、タグ条件の入れ子の FROM まで消して SQL を壊すため。
     */
    const countSql = `SELECT COUNT(*) AS count FROM (${scoped.sql}) q`;
    const result = await c.env.DB.prepare(countSql).bind(...scoped.bindings).first<{ count: number }>();

    return c.json({ success: true, count: result?.count ?? 0 });
  } catch (err) {
    logger.error("broadcasts.segments_count_post_failed");
    return inputError(c, { success: false, error: 'Invalid segment conditions' }, 400, ["conditions"]);
  }
};
