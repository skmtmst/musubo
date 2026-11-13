import { jstNow } from '../utils.js';
import { type RichMenuPageInput, type PageKeepMeta, type RichMenuAreaInput } from './types.js';
import { buildRichMenuAliasId, buildAreaInsert } from './reads.js';


// pages 配列を「id 維持型」全置換する。
// - 入力 page.id が既存 rich_menu_pages.id にマッチした場合、そのページの
//   image_r2_key / image_content_type / line_richmenu_id / created_at は引き継ぐ。
//   richmenuswitch.actionData.targetPageId が PATCH を跨いでも安定して解決できる。
// - 入力にない既存 page は削除。新規 page は新 UUID で挿入。
// - 実装: UNIQUE (group_id, order_index) 制約衝突を避けるため、
//   一旦 group の全 page を DELETE → 新構成で INSERT し直す。保持対象のメタは
//   事前に取得しておいて INSERT 時に復元する。
// - areas は常に全置換 (cascade DELETE で消えた後 INSERT)。
export async function replaceRichMenuPages(
  db: D1Database,
  groupId: string,
  pages: RichMenuPageInput[],
): Promise<void> {
  const now = jstNow();
  const keep = await loadPageKeepMeta(db, groupId);
  const stmts = buildPageReplaceStatements(db, groupId, pages, keep, now);
  await db.batch([db.prepare(`UPDATE rich_menu_groups SET confirmation_revision = confirmation_revision + 1 WHERE id = ?`).bind(groupId), ...stmts]);
}

/**
 * ページ置換で引き継ぐ既存メタ (image / line_richmenu_id / created_at と
 * area id) を読む。押された回数は area id を軸に数えるので、保存のたびに
 * 振り直すと、同じボタンの記録がそこで途切れてしまう。
 * 引き継ぐのは「この group に今ある id」だけ。別 group の id や消えた id を
 * そのまま挿すと PK が衝突する (page 側と同じ考え方)。
 */
export async function loadPageKeepMeta(db: D1Database, groupId: string): Promise<PageKeepMeta> {
  // 既存 page のメタ (image / line_richmenu_id / created_at) を保持するため事前取得。
  const existing = (
    (
      await db
        .prepare(
          `SELECT id, image_r2_key, image_content_type, line_richmenu_id, created_at
             FROM rich_menu_pages WHERE group_id = ?`,
        )
        .bind(groupId)
        .all<{
          id: string;
          image_r2_key: string | null;
          image_content_type: string | null;
          line_richmenu_id: string | null;
          created_at: string;
        }>()
    ).results ?? []
  );
  const existingMap = new Map(existing.map((p) => [p.id, p]));

  const existingAreaIds = new Set(
    (
      (
        await db
          .prepare(
            `SELECT a.id AS id
               FROM rich_menu_areas a
               JOIN rich_menu_pages p ON p.id = a.page_id
              WHERE p.group_id = ?`,
          )
          .bind(groupId)
          .all<{ id: string }>()
      ).results ?? []
    ).map((r) => r.id),
  );
  return { existingMap, existingAreaIds };
}

/**
 * ページ置換の書き込み文を作る (DELETE → 復元 INSERT)。
 * 呼び出し側が 1 batch で流す。meta 更新と束ねるときは同じ batch へ足す。
 */
export function buildPageReplaceStatements(
  db: D1Database,
  groupId: string,
  pages: RichMenuPageInput[],
  keep: PageKeepMeta,
  now: string,
): D1PreparedStatement[] {
  const { existingMap, existingAreaIds } = keep;
  const claimedAreaIds = new Set<string>();
  const resolveAreaId = (a: RichMenuAreaInput): string => {
    if (a.id && existingAreaIds.has(a.id) && !claimedAreaIds.has(a.id)) {
      claimedAreaIds.add(a.id);
      return a.id;
    }
    return crypto.randomUUID();
  };

  // 入力を「保持 vs 新規」に振り分けつつメタを復元。
  // 重要: p.id を流用するのは「current group の existingMap に一致した時だけ」。
  // それ以外 (別 group の id / stale id / undefined) は新 UUID を割り当てる。
  // current group 外の id をそのまま INSERT すると rich_menu_pages.id が PK 衝突する。
  //
  // 同じ existing id が input 内に 2 回以上現れた場合 (route 側でも reject されるが
  // 防御として)、最初の出現だけメタを継承し、後続は新規扱いにして PK 衝突を回避する。
  const claimedReusedIds = new Set<string>();
  const newPageRecords = pages.map((p) => {
    let reused = p.id ? existingMap.get(p.id) : undefined;
    if (reused && claimedReusedIds.has(reused.id)) {
      reused = undefined;
    }
    if (reused) claimedReusedIds.add(reused.id);
    return {
      id: reused?.id ?? crypto.randomUUID(),
      orderIndex: p.orderIndex,
      name: p.name,
      aliasId: buildRichMenuAliasId(groupId, p.orderIndex),
      imageR2Key: reused?.image_r2_key ?? null,
      imageContentType: reused?.image_content_type ?? null,
      lineRichMenuId: reused?.line_richmenu_id ?? null,
      createdAt: reused?.created_at ?? now,
      areas: p.areas,
    };
  });

  const stmts: D1PreparedStatement[] = [];
  // UNIQUE 制約衝突を避けるため、いったん DELETE → 復元 INSERT。
  stmts.push(db.prepare(`DELETE FROM rich_menu_pages WHERE group_id = ?`).bind(groupId));

  for (const p of newPageRecords) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO rich_menu_pages
             (id, group_id, order_index, name, alias_id,
              image_r2_key, image_content_type, line_richmenu_id,
              created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          p.id,
          groupId,
          p.orderIndex,
          p.name,
          p.aliasId,
          p.imageR2Key,
          p.imageContentType,
          p.lineRichMenuId,
          p.createdAt,
          now,
        ),
    );
    for (const a of p.areas) {
      stmts.push(buildAreaInsert(db, resolveAreaId(a), p.id, a, now));
    }
  }

  if (newPageRecords.length > 0) {
    const firstPage =
      newPageRecords.find((p) => p.orderIndex === 0) ?? newPageRecords[0];
    stmts.push(
      db
        .prepare(
          `UPDATE rich_menu_groups SET default_page_id = ?, updated_at = ? WHERE id = ?`,
        )
        .bind(firstPage.id, now, groupId),
    );
  }

  return stmts;
}
