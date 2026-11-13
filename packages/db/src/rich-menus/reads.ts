import { type RichMenuAreaInput, type RichMenuGroup, type RichMenuDeleteImpact, type RichMenuDeleteImpactReferenceKind, type RichMenuGroupWithPages, type RichMenuPage, type RichMenuArea, type RichMenuAreaWithParsed } from './types.js';
import { getRichMenuCurrentAudience, parseRichMenuTagIds } from './area-writes.js';


// alias は決定論的命名: 同 group 内で order_index ごとに一意、再 publish も idempotent。
export function buildRichMenuAliasId(groupId: string, orderIndex: number): string {
  return `lhx-${groupId.slice(0, 8)}-${orderIndex}`;
}

// area の INSERT は作成時と全置換時の2か所から呼ばれる。列が増えるたびに
// 2か所直すのを避けるため、ここに集約する。
export function buildAreaInsert(
  db: D1Database,
  areaId: string,
  pageId: string,
  a: RichMenuAreaInput,
  now: string,
): D1PreparedStatement {
  const tagIds = a.tagIds && a.tagIds.length > 0 ? JSON.stringify(a.tagIds) : null;
  return db
    .prepare(
      `INSERT INTO rich_menu_areas
         (id, page_id, bounds_x, bounds_y, bounds_width, bounds_height,
          action_type, action_data, intent, label, tag_ids, score_change,
          template_id, form_id, tracked_link_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      areaId,
      pageId,
      a.boundsX,
      a.boundsY,
      a.boundsWidth,
      a.boundsHeight,
      a.actionType,
      JSON.stringify(a.actionData),
      a.intent ?? null,
      a.label ?? null,
      tagIds,
      a.scoreChange ?? null,
      a.templateId ?? null,
      a.formId ?? null,
      a.trackedLinkId ?? null,
      now,
      now,
    );
}

export async function getRichMenuGroupById(
  db: D1Database,
  id: string,
): Promise<RichMenuGroup | null> {
  return (await db
    .prepare(`SELECT * FROM rich_menu_groups WHERE id = ?`)
    .bind(id)
    .first<RichMenuGroup>()) ?? null;
}

/**
 * 削除前の影響を、保存済みの正本だけから調べる。
 *
 * - 別グループからこのグループへ入る richmenuswitch は、削除すると参照切れに
 *   なるため阻止する。同じグループ内の切替はグループと一緒に消えるため除外。
 * - 自動処理と共通アクションは、現在の下書き・公開版が対象ページを参照する時
 *   だけ数える。古い版や実行履歴は運用中の参照ではないため含めない。
 * - 次に表示されるメニューは友だちごとの条件で変わる。1件を断定せず、実際の
 *   判定順と同じ順番の候補だけ返す。
 */
export async function getRichMenuDeleteImpact(
  db: D1Database,
  groupId: string,
): Promise<RichMenuDeleteImpact | null> {
  const group = await getRichMenuGroupById(db, groupId);
  if (!group) return null;

  const [pagesResult, incomingResult, candidatesResult, referencesResult, currentAudience] = await Promise.all([
    db
      .prepare(
        `SELECT id, name, order_index, line_richmenu_id
           FROM rich_menu_pages
          WHERE group_id = ?
          ORDER BY order_index ASC`,
      )
      .bind(groupId)
      .all<{ id: string; name: string; order_index:number; line_richmenu_id: string | null }>(),
    db
      .prepare(
        `SELECT source_group.id   AS source_group_id,
                source_group.name AS source_group_name,
                source_page.id    AS source_page_id,
                source_page.name  AS source_page_name,
                area.id           AS area_id,
                area.label        AS area_label,
                target_page.id    AS target_page_id,
                target_page.name  AS target_page_name
           FROM rich_menu_areas area
           JOIN rich_menu_pages source_page ON source_page.id = area.page_id
           JOIN rich_menu_groups source_group ON source_group.id = source_page.group_id
           JOIN rich_menu_pages target_page
             ON target_page.id = json_extract(
               CASE WHEN json_valid(area.action_data) THEN area.action_data ELSE '{}' END,
               '$.targetPageId'
             )
          WHERE target_page.group_id = ?
            AND source_group.id <> ?
            AND area.action_type = 'richmenuswitch'
          ORDER BY source_group.name ASC, source_page.order_index ASC, area.id ASC`,
      )
      .bind(groupId, groupId)
      .all<{
        source_group_id: string;
        source_group_name: string;
        source_page_id: string;
        source_page_name: string;
        area_id: string;
        area_label: string | null;
        target_page_id: string;
        target_page_name: string;
      }>(),
    db
      .prepare(
        `SELECT g.id AS group_id,
                g.name AS name,
                g.targeting_priority AS targeting_priority,
                g.targeting_enabled AS targeting_enabled,
                g.is_default_for_all AS is_default_for_all
           FROM rich_menu_groups g
          WHERE g.account_id = ?
            AND g.id <> ?
            AND g.status = 'published'
            AND (g.targeting_enabled = 1 OR g.is_default_for_all = 1)
            AND EXISTS (
              SELECT 1 FROM rich_menu_pages p
               WHERE p.group_id = g.id AND p.line_richmenu_id IS NOT NULL
            )
          ORDER BY CASE WHEN g.targeting_enabled = 1 THEN 0 ELSE 1 END ASC,
                   g.targeting_priority ASC,
                   g.created_at ASC`,
      )
      .bind(group.account_id, groupId)
      .all<{
        group_id: string;
        name: string;
        targeting_priority: number;
        targeting_enabled: number;
        is_default_for_all: number;
      }>(),
    db
      .prepare(
        `WITH target_values(value) AS (
           SELECT id FROM rich_menu_pages WHERE group_id = ?
           UNION
           SELECT line_richmenu_id FROM rich_menu_pages
            WHERE group_id = ? AND line_richmenu_id IS NOT NULL
         ), current_references(kind, owner_id, owner_name) AS (
           SELECT 'common_action', action.id, action.name
             FROM common_actions action
             JOIN common_action_versions version
               ON version.id = action.current_draft_version_id
               OR version.id = action.current_published_version_id
            WHERE action.line_account_id = ?
              AND action.status <> 'archived'
              AND EXISTS (
                SELECT 1
                  FROM json_tree(CASE WHEN json_valid(version.action_config)
                                      THEN version.action_config ELSE 'null' END) node
                  JOIN target_values target ON CAST(node.value AS TEXT) = target.value
                 WHERE node.type = 'text'
              )
           UNION
           SELECT 'automation', automation.id, automation.name
             FROM automation_definitions automation
             JOIN automation_versions version
               ON version.id = automation.current_draft_version_id
               OR version.id = automation.current_published_version_id
            WHERE automation.line_account_id = ?
              AND automation.status <> 'archived'
              AND EXISTS (
                SELECT 1
                  FROM json_tree(CASE WHEN json_valid(version.action_config)
                                      THEN version.action_config ELSE 'null' END) node
                  JOIN target_values target ON CAST(node.value AS TEXT) = target.value
                 WHERE node.type = 'text'
              )
           UNION
           SELECT 'automation', legacy.id, legacy.name
             FROM automations legacy
            WHERE (legacy.line_account_id = ? OR legacy.line_account_id IS NULL)
              AND legacy.is_active = 1
              AND EXISTS (
                SELECT 1
                  FROM json_tree(CASE WHEN json_valid(legacy.actions)
                                      THEN legacy.actions ELSE 'null' END) node
                  JOIN target_values target ON CAST(node.value AS TEXT) = target.value
                 WHERE node.type = 'text'
              )
         )
         SELECT kind, owner_id, owner_name
           FROM current_references
          ORDER BY kind ASC, owner_name ASC`,
      )
      .bind(groupId, groupId, group.account_id, group.account_id, group.account_id)
      .all<{
        kind: RichMenuDeleteImpactReferenceKind;
        owner_id: string;
        owner_name: string;
      }>(),
    getRichMenuCurrentAudience(db, group.account_id, group.id, group.is_default_for_all === 1),
  ]);

  const pages = pagesResult.results ?? [];
  const incomingSwitches = (incomingResult.results ?? []).map((row) => ({
    sourceGroupId: row.source_group_id,
    sourceGroupName: row.source_group_name,
    sourcePageId: row.source_page_id,
    sourcePageName: row.source_page_name,
    areaId: row.area_id,
    areaLabel: row.area_label,
    targetPageId: row.target_page_id,
    targetPageName: row.target_page_name,
  }));
  const operationalReferences = (referencesResult.results ?? []).map((row) => ({
    kind: row.kind,
    ownerId: row.owner_id,
    ownerName: row.owner_name,
  }));
  const pagesWithLineRichMenuId = pages.filter((page) => page.line_richmenu_id !== null).length;

  const blockers: RichMenuDeleteImpact['blockers'] = [];
  if (group.status === 'published') blockers.push('published');
  if (group.publishing_at !== null) blockers.push('publishing');
  if (group.is_default_for_all === 1) blockers.push('default_for_all');
  if (pagesWithLineRichMenuId > 0) blockers.push('line_resources');
  if (incomingSwitches.length > 0) blockers.push('incoming_switches');
  if (operationalReferences.length > 0) blockers.push('operational_references');

  const hasLineState = blockers.some((blocker) =>
    blocker === 'published'
    || blocker === 'publishing'
    || blocker === 'default_for_all'
    || blocker === 'line_resources');
  const hasReferences = blockers.some((blocker) =>
    blocker === 'incoming_switches' || blocker === 'operational_references');

  return {
    group: {
      id: group.id,
      accountId: group.account_id,
      name: group.name,
      status: group.status,
      version: group.version ?? 1,
      publishingGeneration: group.publishing_generation ?? 0,
    },
    currentAudience: {
      value: currentAudience,
      state: 'partial',
      reason: 'preexisting_assignments_not_backfilled',
    },
    nextDisplay: {
      guaranteedGroupId: null,
      reason: 'friend_specific_rules',
      candidates: (candidatesResult.results ?? []).map((row) => ({
        groupId: row.group_id,
        name: row.name,
        targetingPriority: row.targeting_priority,
        isTargetingEnabled: row.targeting_enabled === 1,
        isDefaultForAll: row.is_default_for_all === 1,
      })),
    },
    incomingSwitches,
    operationalReferences,
    lineResources: {
      pageCount: pages.length,
      pagesWithLineRichMenuId,
      isDefaultForAll: group.is_default_for_all === 1,
      publishing: group.publishing_at !== null,
      pages:pages.map(page=>({id:page.id,orderIndex:page.order_index,lineRichMenuId:page.line_richmenu_id})),
    },
    blockers,
    canDelete: blockers.length === 0,
    recommendedAction: hasLineState
      ? 'unpublish'
      : hasReferences
        ? 'review_references'
        : 'delete',
  };
}

export async function getRichMenuGroupWithPages(
  db: D1Database,
  id: string,
): Promise<RichMenuGroupWithPages | null> {
  const group = await getRichMenuGroupById(db, id);
  if (!group) return null;
  const pagesResult = await db
    .prepare(
      `SELECT * FROM rich_menu_pages WHERE group_id = ? ORDER BY order_index`,
    )
    .bind(id)
    .all<RichMenuPage>();
  const pages = pagesResult.results ?? [];
  if (pages.length === 0) {
    return { ...group, pages: [] };
  }
  const placeholders = pages.map(() => '?').join(',');
  const areasResult = await db
    .prepare(
      `SELECT * FROM rich_menu_areas WHERE page_id IN (${placeholders}) ORDER BY id`,
    )
    .bind(...pages.map((p) => p.id))
    .all<RichMenuArea>();
  const areas = areasResult.results ?? [];
  const areasByPage = new Map<string, RichMenuAreaWithParsed[]>();
  for (const a of areas) {
    const list = areasByPage.get(a.page_id) ?? [];
    list.push({
      ...a,
      actionData: JSON.parse(a.action_data),
      tagIds: parseRichMenuTagIds(a.tag_ids),
    });
    areasByPage.set(a.page_id, list);
  }
  return {
    ...group,
    pages: pages.map((p) => {
      const pageAreas = areasByPage.get(p.id) ?? [];
      // 重なる既存の面は、前後の優先を変えないよう従来のID順を保つ。
      const overlapping = pageAreas.some((area, index) => pageAreas.slice(index + 1).some(other =>
        area.bounds_x < other.bounds_x + other.bounds_width && area.bounds_x + area.bounds_width > other.bounds_x
        && area.bounds_y < other.bounds_y + other.bounds_height && area.bounds_y + area.bounds_height > other.bounds_y));
      if (!overlapping) pageAreas.sort((a, b) => a.bounds_y - b.bounds_y || a.bounds_x - b.bounds_x);
      return { ...p, areas: pageAreas };
    }),
  };
}
