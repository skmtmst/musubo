import { jstNow } from '../utils.js';
import { type SaveRichMenuGroupDraftInput, type SaveRichMenuGroupDraftResult } from './types.js';
import { buildMetaSets } from './drafts-groups.js';
import { loadPageKeepMeta, buildPageReplaceStatements } from './drafts-pages.js';


/**
 * 版の番人が落ちたときの印。番人は SELECT 1 文で、版が合わない
 * （行が無い場合も含む）ときだけ壊れた JSON を読んで batch 全体を
 * 止める。batch 内の正規文は JSON.stringify 済みしか扱わないので、
 * malformed JSON は番人以外から出ない。
 */
export function isVersionGuardTrip(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /malformed JSON/i.test(message);
}

/**
 * 下書き保存を1件の取引で確定する (M950/M951)。
 *
 * 版の検査・版上げ・書込をすべて 1 batch で流す。batch の先頭に版の
 * 番人を置き、期待の版と違うときは番人で batch 全体を失敗させて
 * 何も書かず version_conflict (route が 409 へ写す)。本番 D1 の batch は
 * 原子（試験の createTestD1 も同じく取引で包む）なので、検査と書込の
 * 間に別の保存が割り込めない。古い書込が最後に来ても黙って上書き
 * しない。失敗時は版も進まないので、読み直さずに保存し直せる。
 */
export async function saveRichMenuGroupDraft(
  db: D1Database,
  groupId: string,
  input: SaveRichMenuGroupDraftInput,
): Promise<SaveRichMenuGroupDraftResult> {
  const metaBuilt = buildMetaSets(input.meta);
  // 書くものが無ければ読むだけ。版も進めない。
  if (!metaBuilt && !input.pages) {
    const current = await db
      .prepare(`SELECT version FROM rich_menu_groups WHERE id = ?`)
      .bind(groupId)
      .first<{ version: number }>();
    if (!current || current.version !== input.expectedVersion) {
      return { ok: false, reason: 'version_conflict', currentVersion: current?.version ?? null };
    }
    return { ok: true, version: current.version };
  }
  const now = jstNow();
  const keep = input.pages ? await loadPageKeepMeta(db, groupId) : null;
  const stmts: D1PreparedStatement[] = [];
  // 版の番人。期待の版と違う（行が無い場合も含む）ときだけ1行を作り、
  // 壊れた JSON を読んで失敗し、batch 全体を戻す。合っているときは
  // 何も作らず素通りする。SELECT なので副作用は無い。
  stmts.push(
    db
      .prepare(
        `SELECT json('__RICH_MENU_VERSION_GUARD_TRIPPED__')
           WHERE (SELECT version FROM rich_menu_groups WHERE id = ?) IS DISTINCT FROM ?`,
      )
      .bind(groupId, input.expectedVersion),
  );
  if (metaBuilt) {
    stmts.push(
      db
        .prepare(
          `UPDATE rich_menu_groups SET ${metaBuilt.sets.join(', ')}, version = version + 1, confirmation_revision = confirmation_revision + 1, updated_at = ? WHERE id = ?`,
        )
        .bind(...metaBuilt.vals, now, groupId),
    );
  } else {
    stmts.push(
      db
        .prepare(`UPDATE rich_menu_groups SET version = version + 1, confirmation_revision = confirmation_revision + 1, updated_at = ? WHERE id = ?`)
        .bind(now, groupId),
    );
  }
  if (input.pages && keep) {
    stmts.push(...buildPageReplaceStatements(db, groupId, input.pages, keep, now));
  }
  try {
    await db.batch(stmts);
  } catch (error) {
    if (isVersionGuardTrip(error)) {
      const reread = await db
        .prepare(`SELECT version FROM rich_menu_groups WHERE id = ?`)
        .bind(groupId)
        .first<{ version: number }>();
      return { ok: false, reason: 'version_conflict', currentVersion: reread?.version ?? null };
    }
    throw error;
  }
  return { ok: true, version: input.expectedVersion + 1 };
}

export async function deleteRichMenuGroup(
  db: D1Database,
  id: string,
  expectedVersion?: number,
): Promise<boolean> {
  const result = await db
    .prepare(expectedVersion === undefined ? `DELETE FROM rich_menu_groups WHERE id = ?` : `DELETE FROM rich_menu_groups WHERE id = ? AND version = ? AND status = 'draft'
      AND publishing_at IS NULL AND is_default_for_all = 0
      AND NOT EXISTS (SELECT 1 FROM rich_menu_pages WHERE group_id = rich_menu_groups.id AND line_richmenu_id IS NOT NULL)`)
    .bind(...(expectedVersion === undefined ? [id] : [id, expectedVersion]))
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function setRichMenuPageImage(
  db: D1Database,
  pageId: string,
  imageR2Key: string,
  imageContentType: string,
  expectedGeneration?:number,
): Promise<void> {
  const now=jstNow();
  try{
    await db.batch([
      db.prepare(`SELECT json('__RICH_MENU_IMAGE_CONFLICT__') WHERE NOT EXISTS(SELECT 1 FROM rich_menu_pages p JOIN rich_menu_groups g ON g.id=p.group_id WHERE p.id=? AND g.status='draft' AND (g.publishing_owner IS NULL OR g.publishing_expires_at IS NULL OR g.publishing_expires_at<=?) AND (? IS NULL OR g.publishing_generation=?))`).bind(pageId,new Date().toISOString(),expectedGeneration??null,expectedGeneration??null),
      db.prepare(`UPDATE rich_menu_groups SET publishing_generation=publishing_generation+1, confirmation_revision=confirmation_revision+1 WHERE id=(SELECT group_id FROM rich_menu_pages WHERE id=?)`).bind(pageId),
      db.prepare(`UPDATE rich_menu_pages SET image_r2_key=?,image_content_type=?,updated_at=? WHERE id=?`).bind(imageR2Key,imageContentType,now,pageId),
    ]);
  }catch(error){if(isVersionGuardTrip(error))throw new Error('rich_menu_image_conflict');throw error;}
}

export async function pageBelongsToGroup(
  db: D1Database,
  groupId: string,
  pageId: string,
): Promise<boolean> {
  const row = await db
    .prepare(`SELECT 1 AS hit FROM rich_menu_pages WHERE id = ? AND group_id = ?`)
    .bind(pageId, groupId)
    .first<{ hit: number }>();
  return !!row;
}
