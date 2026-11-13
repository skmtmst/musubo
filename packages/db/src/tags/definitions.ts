import { logger } from '@line-crm/shared/server';
import { sqlIdSet } from '../id-queries.js';
import { jstNow } from '../utils.js';
import { type CreateTagInput, type Tag, type CreateTagsBulkInput, type CreateTagsBulkResult, type TagGroup } from './types.js';
import { assertTagNameAvailable, normalizeTagNameForCleanup, findTagByNormalizedName } from './names.js';


// D1 は1文100バインドまで。正規化名を含む1行5個×20行、500行25文で
// 無料枠の1実行50クエリ内に収める。旧APIの作成先は未所属(global)のまま。
export const TAGS_PER_BULK_INSERT = 20;

export async function createTag(
  db: D1Database,
  input: CreateTagInput,
): Promise<Tag> {
  const id = crypto.randomUUID();
  const now = jstNow();
  const color = input.color ?? '#94a3b8';

  await assertTagNameAvailable(db, input.name, null);

  await db
    .prepare(
      // group_id は書かない。folders が正で、group_id は移送前の名残。
      `INSERT INTO tags (id, name, color, folder_id, created_at, line_account_id, normalized_name)
       VALUES (?, ?, ?, ?, ?, NULL, ?)`,
    )
    .bind(id, input.name, color, input.groupId ?? null, now, normalizeTagNameForCleanup(input.name))
    .run();

  return (await db
    .prepare(`SELECT * FROM tags WHERE id = ?`)
    .bind(id)
    .first<Tag>())!;
}

export async function findOrCreateGlobalTag(
  db: D1Database,
  input: CreateTagInput,
): Promise<Tag> {
  const existing = await findTagByNormalizedName(db, input.name, null);
  if (existing) return existing;
  try {
    return await createTag(db, input);
  } catch (error) {
    // The normalized unique index serializes concurrent writers. Recover the
    // winner so webhook retries attach the already-created tag.
    const concurrent = await findTagByNormalizedName(db, input.name, null);
    if (concurrent) return concurrent;
    throw error;
  }
}

/**
 * CSVからのタグ登録を、D1の1実行あたりのクエリ上限内でまとめて書く。
 *
 * - idを先に作り、RETURNINGで実際に入った行だけを判別する。
 * - 同名が先に作られた行はINSERT OR IGNOREで見送りにする。
 * - 確認後にフォルダが消えた場合は、外部キー違反にせず未分類で登録する。
 * - 1文が失敗しても、ほかの20行単位の文は続ける。
 */
export async function createTagsBulk(
  db: D1Database,
  inputs: CreateTagsBulkInput[],
): Promise<CreateTagsBulkResult[]> {
  const results: CreateTagsBulkResult[] = Array.from(
    { length: inputs.length },
    () => ({ status: 'failed' }),
  );
  const now = jstNow();
  const legacyNullNames = new Set(
    ((await db.prepare(
      `SELECT name FROM tags
        WHERE line_account_id IS NULL AND normalized_name IS NULL`,
    ).all<{ name: string }>()).results ?? [])
      .map((row) => normalizeTagNameForCleanup(row.name)),
  );

  for (let offset = 0; offset < inputs.length; offset += TAGS_PER_BULK_INSERT) {
    const chunk = inputs.slice(offset, offset + TAGS_PER_BULK_INSERT);
    const prepared = chunk.map((input) => ({
      id: crypto.randomUUID(),
      name: input.name,
      groupId: input.groupId ?? null,
      normalizedName: normalizeTagNameForCleanup(input.name),
    }));
    const insertable = prepared.filter((row, index) => {
      if (legacyNullNames.has(row.normalizedName)) {
        results[offset + index] = { status: 'skipped' };
        return false;
      }
      return true;
    });
    if (insertable.length === 0) continue;
    const values = insertable
      .map(() => "(?, ?, '#94a3b8', (SELECT id FROM folders WHERE kind = 'tag' AND id = ?), ?, NULL, ?)")
      .join(', ');
    const binds = insertable.flatMap((row) => [row.id, row.name, row.groupId, now, row.normalizedName]);

    try {
      const inserted = await db
        .prepare(
          `INSERT OR IGNORE INTO tags (id, name, color, folder_id, created_at, line_account_id, normalized_name)
           VALUES ${values}
           RETURNING id`,
        )
        .bind(...binds)
        .run<{ id: string }>();
      const insertedIds = new Set((inserted.results ?? []).map((row) => row.id));
      prepared.forEach((row, index) => {
        if (legacyNullNames.has(row.normalizedName)) return;
        results[offset + index] = insertedIds.has(row.id)
          ? { status: 'created', tagId: row.id }
          : { status: 'skipped' };
      });
    } catch (error) {
      logger.error("src_tags_failed");
      prepared.forEach((row, index) => {
        if (legacyNullNames.has(row.normalizedName)) return;
        results[offset + index] = { status: 'failed' };
      });
    }
  }

  return results;
}

/**
 * タグの所属分類を変える。null で「未分類」に戻す。
 *
 * 名前や色の変更と分けているのは、分類の付け替えが一覧の画面から
 * 一括で行われる操作で、名前の編集とは使われ方が違うため。
 */
export async function assignTagToGroup(
  db: D1Database,
  id: string,
  groupId: string | null,
): Promise<Tag | null> {
  const result = await db
    .prepare(`UPDATE tags SET folder_id = ?, updated_at = ?, version = version + 1 WHERE id = ?
      AND (? IS NULL OR EXISTS (SELECT 1 FROM folders f WHERE f.id = ? AND f.kind = 'tag' AND f.account_id IS tags.line_account_id))`)
    .bind(groupId, jstNow(), id, groupId, groupId)
    .run();
  if (Number(result.meta?.changes ?? 0) !== 1) return null;
  return (
    (await db.prepare(`SELECT * FROM tags WHERE id = ?`).bind(id).first<Tag>()) ??
    null
  );
}

/**
 * 並び順をまとめて書く。
 *
 * 1件ずつ当てると、10件動かしたときに10往復する。その途中で誰かが
 * 一覧を開くと、半分だけ入れ替わった並びが見える。まとめて送る。
 *
 * 絞り込み中は、画面に見えているタグのIDだけが渡る。指定されたタグが
 * 現在占めている位置だけを入れ替え、指定されていないタグはその場に残す。
 * 最後に全体へ一意の順番を振るので、部分的な並び替えでも順番が重複しない。
 */
export async function reorderTags(db: D1Database, ids: string[], scope?: { allowedAccountIds: string[]; canSeeUnassigned: boolean }): Promise<void> {
  if (ids.length < 2) return;

  const allowed = scope?.allowedAccountIds ?? [];
  const where = scope ? `WHERE (${allowed.length ? `t.line_account_id IN (${sqlIdSet(allowed).sql})` : '0'} OR ${scope.canSeeUnassigned ? 't.line_account_id IS NULL' : '0'})` : '';
  const current = await db
    .prepare(
      `SELECT t.id
         FROM tags t
         LEFT JOIN friend_tags ft ON ft.tag_id = t.id
        ${where}
        GROUP BY t.id
        ORDER BY t.display_order ASC, COUNT(ft.friend_id) DESC, t.name ASC`,
    )
    .bind(...(allowed.length ? sqlIdSet(allowed).binds : []))
    .all<{ id: string }>();

  const existing = new Set(current.results.map((tag) => tag.id));
  const requested = ids.filter((id) => existing.has(id));
  if (requested.length < 2) return;

  const requestedSet = new Set(requested);
  let requestedIndex = 0;
  const nextOrder = current.results.map((tag) =>
    requestedSet.has(tag.id) ? requested[requestedIndex++] : tag.id,
  );

  await db.batch(
    nextOrder.map((id, i) =>
      db.prepare(`UPDATE tags SET display_order = ? WHERE id = ?`).bind(i, id),
    ),
  );
}

export async function deleteTag(db: D1Database, id: string): Promise<void> {
  await db.batch([
    db.prepare(`UPDATE scenarios SET content_revision=content_revision+1 WHERE trigger_tag_id=?
      OR id IN (SELECT scenario_id FROM scenario_steps WHERE on_reach_tag_id=?)
      OR id IN (SELECT scenario_id FROM scenario_triggers WHERE tag_id=?)`).bind(id, id, id),
    db.prepare(`DELETE FROM tags WHERE id = ?`).bind(id),
  ]);
}

// --- タグの親分類 -----------------------------------------------------------
//
// 「お悩み」「ペット」のような分類でタグをまとめる。分類は入れ子にしない。
// 二段で足りることが分かっているし、階層を許すと画面もクエリも一気に複雑になる。

export async function getTagGroups(db: D1Database, scope?: { allowedAccountIds: string[]; canSeeUnassigned: boolean }): Promise<TagGroup[]> {
  const ids = scope?.allowedAccountIds ?? [];
  const own = ids.length ? `account_id IN (${sqlIdSet(ids).sql})` : "0";
  const condition = `(${own} OR ${scope?.canSeeUnassigned !== false ? "account_id IS NULL" : "0"})`;
  const result = await db
    .prepare(
      `SELECT id, account_id, name, display_order AS sort_order, color, created_at, updated_at
         FROM folders WHERE kind = 'tag' AND ${condition}
        ORDER BY display_order ASC, name ASC`,
    )
    .bind(...(ids.length ? sqlIdSet(ids).binds : []))
    .all<TagGroup>();
  return result.results;
}

export async function createTagGroup(
  db: D1Database,
  input: { name: string; sortOrder?: number; color?: string | null; accountId?: string | null },
): Promise<TagGroup> {
  const id = crypto.randomUUID();
  const now = jstNow();
  await db
    .prepare(
      `INSERT INTO folders (id, kind, name, display_order, color, account_id, created_at, updated_at)
       VALUES (?, 'tag', ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, input.name, input.sortOrder ?? 0, input.color ?? null, input.accountId ?? null, now, now)
    .run();
  return (await db
    .prepare(
      `SELECT id, account_id, name, display_order AS sort_order, color, created_at, updated_at
         FROM folders WHERE id = ?`,
    )
    .bind(id)
    .first<TagGroup>())!;
}

export async function updateTagGroup(
  db: D1Database,
  id: string,
  input: { name?: string; sortOrder?: number; color?: string | null },
): Promise<TagGroup | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (input.name !== undefined) {
    sets.push('name = ?');
    values.push(input.name);
  }
  if (input.sortOrder !== undefined) {
    sets.push('display_order = ?');
    values.push(input.sortOrder);
  }
  if (input.color !== undefined) {
    sets.push('color = ?');
    values.push(input.color);
  }
  if (sets.length > 0) {
    sets.push('updated_at = ?');
    values.push(jstNow(), id);
    await db
      .prepare(`UPDATE folders SET ${sets.join(', ')} WHERE id = ? AND kind = 'tag'`)
      .bind(...values)
      .run();
  }
  return (
    (await db
      .prepare(
        `SELECT id, account_id, name, display_order AS sort_order, color, created_at, updated_at
           FROM folders WHERE id = ? AND kind = 'tag'`,
      )
      .bind(id)
      .first<TagGroup>()) ?? null
  );
}

/**
 * 分類を消す。属していたタグは消さず「未分類」に戻る
 * （tags.folder_id は ON DELETE SET NULL）。
 *
 * 分類は入れ物であって、タグそのものではない。入れ物を捨てたら中身も
 * 捨てる、では友だちに付いたタグまで巻き込まれる。
 */
export async function deleteTagGroup(db: D1Database, id: string): Promise<void> {
  await db.prepare(`DELETE FROM folders WHERE id = ? AND kind = 'tag'`).bind(id).run();
}
