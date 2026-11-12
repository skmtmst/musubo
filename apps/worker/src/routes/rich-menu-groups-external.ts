import { tracedFetch as fetch, logger } from '@line-crm/shared/server';
import { withStyleSampleMetadata } from '../services/style-sample-metadata.js';
import { serializeGroup } from './rich-menu-group-display.js';
import { type ExternalLineArea } from './rich-menu-external-types.js';
import { inputError } from '../lib/input-errors.js';
import { fail } from '../lib/fail.js';
import { getRichMenuGroups, createRichMenuGroup, setRichMenuPageImage, acquirePublishLease, releasePublishLease, renewPublishLease, setPageRichMenuId, markRichMenuGroupPublished, getLineAccountById, getRichMenuTapStats, getRichMenuAudienceStats, listRichMenuGroupIdsByAreaLabel, normalizeRichMenuSearchText, jstNow, type RichMenuAreaInput } from '@line-crm/db';

import { RICH_MENU_DIMENSIONS } from '@line-crm/shared';
import type { Env } from '../worker-env.js';

import { canAccessAllLineAccounts } from '../services/account-access.js';
import { currentMonthRange } from '../lib/jst-range.js';
import { buildOffsetListResponse, parseOffsetPaging } from '../lib/list-paging.js';
import { buildSegmentWhere, parseCondition } from '../services/segment-query.js';
import { PublishLeaseLostError } from '../lib/rich-menu-publisher.js';
import { serializeExternalArea } from './rich-menu-groups-definition.js';
import type { Context } from 'hono';

export const get__api_rich_menu_groups_external_richMenuId_image_1 = async (c: Context<Env, "/api/rich-menu-groups/external/:richMenuId/image">) => {
  const richMenuId = c.req.param('richMenuId');
  const accountId = c.req.query('accountId');
  if (!accountId) return fail(c, 400, 'ACCOUNT_ID_REQUIRED');
  if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [accountId])) {
    return fail(c, 404, 'LINE_ACCOUNT_NOT_FOUND');
  }
  const account = await getLineAccountById(c.env.DB, accountId);
  if (!account) return fail(c, 404, 'LINE_ACCOUNT_NOT_FOUND');
  const res = await fetch(
    `https://api-data.line.me/v2/bot/richmenu/${encodeURIComponent(richMenuId)}/content`,
    { headers: { Authorization: `Bearer ${account.channel_access_token}` } },
  );
  if (!res.ok) {
    // 中: 不正なIDでURLが化けないよう符号化し、外部の応答本文は利用者に出さない。
    return inputError(c, {
        success: false,
        error: res.status === 404
          ? 'LINE上に画像が見つかりませんでした'
          : 'LINEから画像を取得できませんでした',
      }, res.status === 404 ? 404 : 500, []);
  }
  return new Response(res.body, {
    headers: {
      'Content-Type': res.headers.get('content-type') ?? 'image/png',
      'Cache-Control': 'private, max-age=300',
    },
  });
};

export const post__api_rich_menu_groups_import_2 = async (c: Context<Env, "/api/rich-menu-groups/import">) => {
  const accountId = c.req.query('accountId');
  const richMenuId = c.req.query('richMenuId');
  if (!accountId || !richMenuId) {
    return fail(c, 400, 'ACCOUNT_ID_AND_RICH_MENU_ID_QUERY_PARAMS_REQUIRED', {}, ["accountId","richMenuId"]);
  }
  if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [accountId])) {
    return fail(c, 404, 'LINE_ACCOUNT_NOT_FOUND');
  }
  const account = await getLineAccountById(c.env.DB, accountId);
  if (!account) return fail(c, 404, 'LINE_ACCOUNT_NOT_FOUND');

  // 既に admin 管理下にあるかチェック
  const existing = await c.env.DB
    .prepare(
      `SELECT g.id, g.name FROM rich_menu_pages p
         JOIN rich_menu_groups g ON g.id = p.group_id
        WHERE g.account_id = ? AND p.line_richmenu_id = ?`,
    )
    .bind(accountId, richMenuId)
    .first<{ id: string; name: string }>();
  if (existing) {
    return c.json(
      { success: false, error: `既に管理画面で管理中のメニューです: ${existing.name}` },
      409,
    );
  }

  const auth = `Bearer ${account.channel_access_token}`;

  // 1. LINE から rich menu 詳細を取得
  const detailRes = await fetch(`https://api.line.me/v2/bot/richmenu/${encodeURIComponent(richMenuId)}`, {
    headers: { Authorization: auth },
  });
  if (!detailRes.ok) {
    // 中: 外部の応答本文をそのまま利用者に返さない。固定の日本語に置き換える。
    return inputError(c, {
        success: false,
        error: detailRes.status === 404
          ? 'LINE上にメニューが見つかりませんでした'
          : 'LINEからメニューを取得できませんでした',
      }, detailRes.status === 404 ? 404 : 500, []);
  }
  type LineArea = {
    bounds: { x: number; y: number; width: number; height: number };
    action: {
      type: string;
      uri?: string;
      text?: string;
      data?: string;
      displayText?: string;
      richMenuAliasId?: string;
      // 日時を選ぶ・文字をコピーするボタンの取り込み用。
      mode?: string;
      initial?: string;
      max?: string;
      min?: string;
    };
  };
  const detail = (await detailRes.json()) as {
    name: string;
    chatBarText: string;
    size: { width: number; height: number };
    areas: LineArea[];
  };

  // 2. size 判定
  const size: 'large' | 'compact' | null =
    detail.size.width === RICH_MENU_DIMENSIONS.large.width
      && detail.size.height === RICH_MENU_DIMENSIONS.large.height
      ? 'large'
      : detail.size.width === RICH_MENU_DIMENSIONS.compact.width
        && detail.size.height === RICH_MENU_DIMENSIONS.compact.height
        ? 'compact'
        : null;
  if (!size) {
    return inputError(c, {
        success: false,
        error: `非対応サイズ ${detail.size.width}x${detail.size.height}。管理画面は ${RICH_MENU_DIMENSIONS.large.width}×${RICH_MENU_DIMENSIONS.large.height} (Large) と ${RICH_MENU_DIMENSIONS.compact.width}×${RICH_MENU_DIMENSIONS.compact.height} (Compact) のみ対応しています。`,
      }, 400, ["richMenuId","accountId"]);
  }

  // 3. action 変換 (LINE → admin)
  const convertedAreas: RichMenuAreaInput[] = [];
  for (const a of detail.areas ?? []) {
    if (a.action.type === 'uri' && typeof a.action.uri === 'string') {
      convertedAreas.push({
        boundsX: a.bounds.x, boundsY: a.bounds.y,
        boundsWidth: a.bounds.width, boundsHeight: a.bounds.height,
        actionType: 'uri',
        actionData: { uri: a.action.uri },
      });
    } else if (a.action.type === 'message' && typeof a.action.text === 'string') {
      convertedAreas.push({
        boundsX: a.bounds.x, boundsY: a.bounds.y,
        boundsWidth: a.bounds.width, boundsHeight: a.bounds.height,
        actionType: 'message',
        actionData: { text: a.action.text },
      });
    } else if (a.action.type === 'postback' && typeof a.action.data === 'string') {
      convertedAreas.push({
        boundsX: a.bounds.x, boundsY: a.bounds.y,
        boundsWidth: a.bounds.width, boundsHeight: a.bounds.height,
        actionType: 'postback',
        actionData: {
          data: a.action.data,
          ...(a.action.displayText ? { displayText: a.action.displayText } : {}),
        },
      });
    } else if (a.action.type === 'datetimepicker' && typeof a.action.mode === 'string') {
      // 日時を選ぶボタンは intent で持ち、DB へは postback に載せる。
      convertedAreas.push({
        boundsX: a.bounds.x, boundsY: a.bounds.y,
        boundsWidth: a.bounds.width, boundsHeight: a.bounds.height,
        actionType: 'postback',
        intent: 'datetime',
        actionData: {
          mode: a.action.mode,
          ...(typeof a.action.initial === 'string' ? { initial: a.action.initial } : {}),
          ...(typeof a.action.max === 'string' ? { max: a.action.max } : {}),
          ...(typeof a.action.min === 'string' ? { min: a.action.min } : {}),
        },
      });
    } else if (a.action.type === 'clipboard' && typeof a.action.text === 'string') {
      convertedAreas.push({
        boundsX: a.bounds.x, boundsY: a.bounds.y,
        boundsWidth: a.bounds.width, boundsHeight: a.bounds.height,
        actionType: 'postback',
        intent: 'clipboard',
        actionData: { text: a.action.text },
      });
    } else if (a.action.type === 'richmenuswitch') {
      return inputError(c, {
          success: false,
          error:
            'タブ切替 (richmenuswitch) を含むリッチメニューは現在インポートできません。タブ切替は管理画面で複数ページとして新規作成してください。',
        }, 400, []);
    } else {
      return inputError(c, {
          success: false,
          error: `非対応アクション「${a.action.type}」を含むリッチメニューはインポートできません。`,
        }, 400, []);
    }
  }

  // 4. 画像を LINE から取得して R2 に保存
  const imgRes = await fetch(
    `https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`,
    { headers: { Authorization: auth } },
  );
  if (!imgRes.ok) {
    return c.json(
      { success: false, error: `LINE 画像取得失敗: ${imgRes.status}` },
      500,
    );
  }
  const contentType = imgRes.headers.get('content-type') ?? 'image/png';
  const ext = contentType.includes('jpeg') ? 'jpg' : 'png';
  const imageBytes = new Uint8Array(await imgRes.arrayBuffer());

  // 5. D1 に group + page + areas を作成
  const created = await createRichMenuGroup(c.env.DB, {
    accountId,
    name: detail.name,
    chatBarText: detail.chatBarText,
    size,
    pages: [
      {
        name: 'ページ 1',
        orderIndex: 0,
        areas: convertedAreas,
      },
    ],
  });
  const newPage = created.pages[0];

  // 6. 画像を R2 に保存して page に紐付け
  const r2Key = `rich-menus/${accountId}/${created.id}/${newPage.id}/${crypto.randomUUID()}.${ext}`;
  await c.env.IMAGES.put(r2Key, imageBytes, { httpMetadata: { contentType } });
  await setRichMenuPageImage(c.env.DB, newPage.id, r2Key, contentType);

  // 7. line_richmenu_id を埋めて status='published' に
  //    作ったばかりの group だが、group の状態を変える経路は例外なく
  //    同じ lease 契約に乗せる(経路ごとに流儀が違うと穴の元になる)。
  const importOwner = `import-${crypto.randomUUID()}`;
  const importGeneration = await acquirePublishLease(
    c.env.DB, created.id, importOwner, new Date().toISOString(),
  );
  if (importGeneration === null) {
    return c.json({ success: false, error: 'failed to acquire publish lock' }, 409);
  }
  const importFence = { owner: importOwner, generation: importGeneration };
  try {
    // 8. alias を upsert (今後の再 publish 時の安定 ID として)。
    //    外部操作なので lease を持っているうちに済ませ、直前に実時刻で延ばす。
    //    確定のあとに回すと、解放後の無防備な外部操作になる。
    if (!(await renewPublishLease(c.env.DB, created.id, importFence, new Date().toISOString()))) {
      throw new PublishLeaseLostError();
    }
    const aliasId = `lhx-${created.id.slice(0, 8)}-0`;
    try {
      await fetch(`https://api.line.me/v2/bot/richmenu/alias/${aliasId}`, {
        method: 'DELETE',
        headers: { Authorization: auth },
      });
    } catch {
      // 既に無い場合は無視。作り直しは次の POST で行う。
    }
    await fetch('https://api.line.me/v2/bot/richmenu/alias', {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ richMenuAliasId: aliasId, richMenuId }),
    });

    // 9. line_richmenu_id を埋めて status='published' に。
    //    札付き書込みの false は失権。無視して成功応答にしない。
    if (!(await renewPublishLease(c.env.DB, created.id, importFence, new Date().toISOString()))) {
      throw new PublishLeaseLostError();
    }
    if (!(await setPageRichMenuId(c.env.DB, newPage.id, richMenuId, importFence))) {
      throw new PublishLeaseLostError();
    }
    if (!(await markRichMenuGroupPublished(c.env.DB, created.id, importFence))) {
      throw new PublishLeaseLostError();
    }
    // 確定と解放は別。ここまで来て初めて lease を手放す。
    await releasePublishLease(c.env.DB, created.id, importFence);
    return c.json({ success: true, data: { id: created.id, name: created.name } });
  } catch (e) {
    await releasePublishLease(c.env.DB, created.id, importFence);
    if (e instanceof PublishLeaseLostError) {
      return c.json(
        { success: false, error: '公開の担当が別の処理へ移りました。最新の状態を確認して、もう一度お試しください。' },
        409,
      );
    }
    throw e;
  }
};

export const get__api_rich_menu_groups_external_3 = async (c: Context<Env, "/api/rich-menu-groups/external">) => {
  const accountId = c.req.query('accountId');
  if (!accountId) return fail(c, 400, 'ACCOUNT_ID_REQUIRED');
  if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [accountId])) {
    return fail(c, 404, 'LINE_ACCOUNT_NOT_FOUND');
  }
  const account = await getLineAccountById(c.env.DB, accountId);
  if (!account) return fail(c, 404, 'LINE_ACCOUNT_NOT_FOUND');
  const auth = `Bearer ${account.channel_access_token}`;

  type LineMenu = {
    richMenuId: string;
    name: string;
    chatBarText: string;
    selected: boolean;
    size: { width: number; height: number };
    areas: ExternalLineArea[];
  };

  // 並列に問い合わせる
  const [listRes, defRes] = await Promise.all([
    fetch('https://api.line.me/v2/bot/richmenu/list', { headers: { Authorization: auth } }),
    fetch('https://api.line.me/v2/bot/user/all/richmenu', { headers: { Authorization: auth } }),
  ]);
  if (!listRes.ok) {
    const code = listRes.status === 401 ? 'INVALID_LINE_ACCESS_TOKEN'
      : listRes.status === 429 ? 'LINE_RATE_LIMITED' : 'LINE_RICH_MENU_LIST_FAILED';
    const error = listRes.status === 401 ? 'LINE連携の認証情報を確認できません。連携の設定を確認してください。'
      : listRes.status === 429 ? 'LINEへの問い合わせが集中しています。少し待ってから、もう一度読み込んでください。'
        : 'LINEのリッチメニューを取得できませんでした。連携の状態を確認してください。';
    return fail(c, 500, code, { error });
  }
  const listJson = (await listRes.json()) as { richmenus?: LineMenu[] };
  const lineMenus = listJson.richmenus ?? [];

  let currentDefault: string | null = null;
  if (defRes.status === 200) {
    const j = (await defRes.json()) as { richMenuId?: string };
    currentDefault = j.richMenuId ?? null;
  }
  // 404 = default 未設定、それ以外の error は warn として無視 (画面が止まらないように)

  // admin 管理の line_richmenu_id を引いて、各 line menu に admin 情報を付与
  const adminRows = (
    await c.env.DB
      .prepare(
        `SELECT p.line_richmenu_id, p.name AS page_name,
                g.id AS group_id, g.name AS group_name, g.status AS group_status
           FROM rich_menu_pages p
           JOIN rich_menu_groups g ON g.id = p.group_id
          WHERE g.account_id = ? AND p.line_richmenu_id IS NOT NULL`,
      )
      .bind(accountId)
      .all<{
        line_richmenu_id: string;
        page_name: string;
        group_id: string;
        group_name: string;
        group_status: string;
      }>()
  ).results ?? [];
  const adminByRichMenuId = new Map(adminRows.map((r) => [r.line_richmenu_id, r]));

  return c.json({
    success: true,
    data: {
      currentDefault,
      lineMenus: lineMenus.map((m) => {
        const admin = adminByRichMenuId.get(m.richMenuId);
        return {
          richMenuId: m.richMenuId,
          name: m.name,
          chatBarText: m.chatBarText,
          size: m.size,
          areasCount: Array.isArray(m.areas) ? m.areas.length : 0,
          areas: Array.isArray(m.areas) ? m.areas.map(serializeExternalArea) : [],
          isCurrentDefault: currentDefault === m.richMenuId,
          adminManaged: !!admin,
          adminInfo: admin
            ? {
                groupId: admin.group_id,
                groupName: admin.group_name,
                pageName: admin.page_name,
                groupStatus: admin.group_status,
              }
            : null,
        };
      }),
    },
  });
};

export const delete__api_rich_menu_groups_external_richMenuId_4 = async (c: Context<Env, "/api/rich-menu-groups/external/:richMenuId">) => {
  const richMenuId = c.req.param('richMenuId');
  const accountId = c.req.query('accountId');
  if (!accountId) return fail(c, 400, 'ACCOUNT_ID_REQUIRED');
  if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [accountId])) {
    return fail(c, 404, 'LINE_ACCOUNT_NOT_FOUND');
  }
  const account = await getLineAccountById(c.env.DB, accountId);
  if (!account) return fail(c, 404, 'LINE_ACCOUNT_NOT_FOUND');

  // admin 管理下の richmenu はここでは削除させない
  const adminRow = await c.env.DB
    .prepare(
      `SELECT g.id, g.name FROM rich_menu_pages p
         JOIN rich_menu_groups g ON g.id = p.group_id
        WHERE g.account_id = ? AND p.line_richmenu_id = ?`,
    )
    .bind(accountId, richMenuId)
    .first<{ id: string; name: string }>();
  if (adminRow) {
    return c.json(
      {
        success: false,
        error: `この richMenu は admin 管理下のメニュー「${adminRow.name}」に紐づいています。編集画面の「LINE から取り下げ」を使ってください。`,
      },
      409,
    );
  }

  const auth = `Bearer ${account.channel_access_token}`;
  const res = await fetch(`https://api.line.me/v2/bot/richmenu/${encodeURIComponent(richMenuId)}`, {
    method: 'DELETE',
    headers: { Authorization: auth },
  });
  if (!res.ok && res.status !== 404) {
    // 中: 外部の応答本文をそのまま利用者に返さない。固定の日本語に置き換える。
    return c.json(
      { success: false, error: 'LINE上のメニューを削除できませんでした' },
      500,
    );
  }
  return c.json({ success: true });
};

export const get__api_rich_menu_groups_tap_stats_5 = async (c: Context<Env, "/api/rich-menu-groups/tap-stats">) => {
  const accountId = c.req.query('accountId');
  if (!accountId) return fail(c, 400, 'ACCOUNT_ID_REQUIRED');
  if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [accountId])) {
    return fail(c, 404, 'LINE_ACCOUNT_NOT_FOUND');
  }
  const range = currentMonthRange(jstNow());
  const from = c.req.query('from') || range.from;
  const to = c.req.query('to') || range.to;
  try {
    const stats = await getRichMenuTapStats(c.env.DB, accountId, from, to);
    return c.json({ success: true, data: stats });
  } catch (e) {
    throw e;
  }
};

export const get__api_rich_menu_groups_6 = async (c: Context<Env, "/api/rich-menu-groups">) => {
  const accountId = c.req.query('accountId');
  if (!accountId) return fail(c, 400, 'ACCOUNT_ID_REQUIRED');
  if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [accountId])) {
    return fail(c, 404, 'LINE_ACCOUNT_NOT_FOUND');
  }
  try {
    const wantsPaging = c.req.query('page') !== undefined || c.req.query('limit') !== undefined;
    const paging = wantsPaging
      ? parseOffsetPaging({ page: c.req.query('page'), limit: c.req.query('limit') })
      : undefined;
    const groups = await getRichMenuGroups(c.env.DB, accountId);
    const range = currentMonthRange(jstNow());
    const [audienceStats, tapStats] = groups.length > 0
      ? await Promise.all([
          getRichMenuAudienceStats(c.env.DB, accountId, range.from, range.to, groups),
          getRichMenuTapStats(c.env.DB, accountId, range.from, range.to),
        ])
      : [[], { byGroup: [] }];
    const audienceByGroup = new Map(audienceStats.map((item) => [item.groupId, item]));
    const tapsByGroup = new Map(tapStats.byGroup.map((item) => [item.groupId, item.taps]));
    const query = (c.req.query('query') ?? '').trim();
    // 検索はメニュー名・トークバー文言・ボタン名（面のラベル）の3方向へ
    // 当たる。大小文字と空白（半角・全角）を揃えて比較する。ボタン名は別表なので
    // 一致する group の id を先に引き、一覧の絞り込みに合成する。
    const normalizedQuery = normalizeRichMenuSearchText(query);
    const labelMatchedGroupIds = wantsPaging && normalizedQuery
      ? await listRichMenuGroupIdsByAreaLabel(c.env.DB, accountId, normalizedQuery)
      : new Set<string>();
    const folderId = c.req.query('folderId') ?? '';
    const savedFilter = c.req.query('filter') ?? '';
    const sortKey = c.req.query('sort') ?? 'priority';
    const allItems = groups.map((g) => ({
      ...serializeGroup(g),
      thumbnailR2Key: null as string | null,
      monthlyStats: {
        from: range.from,
        to: range.to,
        taps: tapsByGroup.get(g.id) ?? 0,
        uniqueAudience: {
          value: audienceByGroup.get(g.id)?.monthlyUniqueAudience ?? 0,
          state: 'partial' as const,
          reason: 'preexisting_assignments_not_backfilled' as const,
        },
      },
    }));
    const facets = {
      total: allItems.length,
      published: allItems.filter((item) => item.status === 'published').length,
      targeting: allItems.filter((item) => item.targetingEnabled && item.targetingCondition).length,
      folderCounts: allItems.reduce<Record<string, number>>((counts, item) => {
        const key = item.folderId ?? '__unfiled__';
        counts[key] = (counts[key] ?? 0) + 1;
        return counts;
      }, {}),
    };
    const filtered = wantsPaging
      ? allItems.filter((item) => {
          if (
            normalizedQuery
            && !normalizeRichMenuSearchText(item.name).includes(normalizedQuery)
            && !normalizeRichMenuSearchText(item.chatBarText).includes(normalizedQuery)
            && !labelMatchedGroupIds.has(item.id)
          ) return false;
          if (folderId === '__unfiled__' && item.folderId) return false;
          if (folderId && folderId !== '__unfiled__' && item.folderId !== folderId) return false;
          if (savedFilter === 'published' && item.status !== 'published') return false;
          if (savedFilter === 'scheduled' && !item.publishingAt) return false;
          if (savedFilter === 'draft' && (item.status !== 'draft' || item.publishingAt)) return false;
          if (savedFilter === 'targeting' && (!item.targetingEnabled || !item.targetingCondition)) return false;
          return true;
        })
      : allItems;
    const sorted = wantsPaging ? [...filtered].sort((a, b) => {
      if (sortKey === 'taps') return b.monthlyStats.taps - a.monthlyStats.taps || a.id.localeCompare(b.id);
      if (sortKey === 'updated') return b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);
      if (sortKey === 'name') return a.name.localeCompare(b.name, 'ja') || a.id.localeCompare(b.id);
      return a.targetingPriority - b.targetingPriority
        || a.createdAt.localeCompare(b.createdAt)
        || a.id.localeCompare(b.id);
    }) : filtered;
    const pageItems = paging ? sorted.slice(paging.offset, paging.offset + paging.limit) : sorted;
    // 各 group の代表画像 (default_page_id の image_r2_key、なければ order_index=0 の page) を取得。
    // 一覧カードでサムネを出すために 1 クエリで JOIN する。
    // ★V8 一覧の「大・6面・切替タブ 2」の表示にはページ数と代表ページの面数も要るので、
    // 同じ1クエリで数える。
    const imageByGroupId = new Map<string, { key: string; contentType: string | null }>();
    const shapeByGroupId = new Map<string, { pageCount: number; areaCount: number }>();
    if (pageItems.length > 0) {
      const result = await c.env.DB
        .prepare(
          `SELECT
            g.id AS group_id,
            COALESCE(
              (SELECT image_r2_key FROM rich_menu_pages WHERE id = g.default_page_id),
              (SELECT image_r2_key FROM rich_menu_pages WHERE group_id = g.id ORDER BY order_index LIMIT 1)
            ) AS image_r2_key,
            COALESCE(
              (SELECT image_content_type FROM rich_menu_pages WHERE id = g.default_page_id),
              (SELECT image_content_type FROM rich_menu_pages WHERE group_id = g.id ORDER BY order_index LIMIT 1)
            ) AS image_content_type,
            (SELECT COUNT(*) FROM rich_menu_pages p WHERE p.group_id = g.id) AS page_count,
            (SELECT COUNT(*) FROM rich_menu_areas a WHERE a.page_id = COALESCE(
              g.default_page_id,
              (SELECT p2.id FROM rich_menu_pages p2 WHERE p2.group_id = g.id ORDER BY p2.order_index LIMIT 1)
            )) AS default_area_count
           FROM rich_menu_groups g
          WHERE g.account_id = ? AND g.id IN (SELECT value FROM json_each(?))`,
        )
        .bind(accountId, JSON.stringify(pageItems.map((g) => g.id)))
        .all<{
          group_id: string;
          image_r2_key: string | null;
          image_content_type: string | null;
          page_count: number;
          default_area_count: number;
        }>();
      for (const r of result.results ?? []) {
        if (r.image_r2_key) {
          imageByGroupId.set(r.group_id, {
            key: r.image_r2_key,
            contentType: r.image_content_type,
          });
        }
        shapeByGroupId.set(r.group_id, {
          pageCount: r.page_count ?? 0,
          areaCount: r.default_area_count ?? 0,
        });
      }
    }
    /*
     * ★V8 一覧の「誰に出すか」列の「対象 N人」。条件で出し分けている行だけ、
     * このページに出る分を数える（ページ内で打ち切るので、行数ぶんを超える
     * 問い合わせにはならない）。条件が読めない行は null のまま残す。
     */
    const audienceByGroupId = new Map<string, number>();
    await Promise.all(pageItems.map(async (g) => {
      if (!g.targetingEnabled || !g.targetingCondition) return;
      const condition = parseCondition(g.targetingCondition);
      if (!condition) return;
      try {
        const where = buildSegmentWhere(condition);
        const row = await c.env.DB
          .prepare(
            `SELECT COUNT(*) AS count
               FROM friends f
              WHERE f.line_account_id = ?
                AND f.is_following = 1
                AND (${where.sql})`,
          )
          .bind(accountId, ...where.bindings)
          .first<{ count: number }>();
        if (row) audienceByGroupId.set(g.id, row.count);
      } catch {
        // 数えられない行があっても一覧は出す。その行だけ人数を出さない。
      }
    }));
    const items = await withStyleSampleMetadata(c.env.DB,pageItems.map((g) => ({
        ...g,
        thumbnailR2Key: imageByGroupId.get(g.id)?.key ?? null,
        pageCount: shapeByGroupId.get(g.id)?.pageCount ?? 0,
        defaultPageAreaCount: shapeByGroupId.get(g.id)?.areaCount ?? 0,
        audienceCount: audienceByGroupId.get(g.id) ?? null,
      })), 'rich_menu');
    if (paging) {
      const sort = sortKey === 'taps'
        ? [{ field: 'monthlyStats.taps', direction: 'desc' as const }, { field: 'id', direction: 'asc' as const }]
        : sortKey === 'updated'
          ? [{ field: 'updatedAt', direction: 'desc' as const }, { field: 'id', direction: 'asc' as const }]
          : sortKey === 'name'
            ? [{ field: 'name', direction: 'asc' as const }, { field: 'id', direction: 'asc' as const }]
            : [
                { field: 'targetingPriority', direction: 'asc' as const },
                { field: 'createdAt', direction: 'asc' as const },
                { field: 'id', direction: 'asc' as const },
              ];
      return c.json({
        success: true,
        data: {
          ...buildOffsetListResponse({ items, total: filtered.length, paging, sort }),
          facets,
        },
      });
    }
    return c.json({ success: true, data: items });
  } catch (error) {
    logger.error("rich_menu_groups.rich_menu_groups_get_failed");
    return c.json({ success: false, error: 'リッチメニュー一覧を取得できませんでした' }, 503);
  }
};
