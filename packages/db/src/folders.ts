import { sqlIdSet } from './id-queries.js';
import { jstNow } from './utils.js';

/**
 * 汎用フォルダ。
 *
 * 一覧13画面すべてにフォルダがある。画面ごとに別テーブルを足すと、
 * 同じものが13個できて「フォルダの作り方が画面ごとに違う」状態になる。
 * kind で使い分ける1つの表にした。
 *
 * タグの分類（旧 tag_groups）もここへ移送済み。tag_groups と tags.group_id は
 * 列を落とせないので残っているが、読み書きしない。
 */

export const FOLDER_KINDS = [
  'tag',
  'template',
  'scenario',
  'reminder',
  'auto_reply',
  'rich_menu',
  'webinar',
  'form',
  'media',
  'common_var',
  'mileage_rule',
  'automation',
  'event',
  'entry_route',
  'broadcast',
  // 友だち情報欄の分類。友だち詳細の上に並ぶタブ（飼い主情報・ペット
  // プロフィールなど）がこれ。friend_fields.folder_id が指す先。
  'friend_field',
  // 自動化と外部連携。所属先はアカウント別に保存する。
  'common_action',
  'webhook',
  'conversion',
  'affiliate',
  'affiliate_offer',
  'mileage_reward',
  'friend_add_rule',
] as const;

export type FolderKind = (typeof FOLDER_KINDS)[number];

export interface Folder {
  id: string;
  kind: string;
  /** 所有LINE公式アカウント。null は移行前の共有フォルダ。 */
  account_id: string | null;
  name: string;
  parent_id: string | null;
  display_order: number;
  /** #RRGGBB。未設定は null（画面では灰色で出す）。115 で追加。 */
  color: string | null;
  created_at: string;
  updated_at: string;
  revision: number;
}

export function isFolderKind(value: unknown): value is FolderKind {
  return typeof value === 'string' && (FOLDER_KINDS as readonly string[]).includes(value);
}

export async function getFolders(
  db: D1Database,
  kind?: FolderKind,
  accountId?: string,
  scope?: FolderItemCountScope,
): Promise<Folder[]> {
  if (scope) {
    // Account-owned rows are never public. Only tag/webinar/template legacy rows have
    // the unassigned policy; other existing folder kinds keep their old list.
    const ids = accountId ? scope.allowedAccountIds.filter((id) => id === accountId) : scope.allowedAccountIds;
    const own = ids.length ? `account_id IN (${sqlIdSet(ids).sql})` : "0";
    const legacy = scope.canSeeUnassigned ? "account_id IS NULL" : "0";
    const result = await db.prepare(`SELECT * FROM folders WHERE (${own} OR ${legacy})${kind ? " AND kind = ?" : ""}
      ORDER BY kind ASC, display_order ASC, name ASC`).bind(...(ids.length ? sqlIdSet(ids).binds : []), ...(kind ? [kind] : [])).all<Folder>();
    return result.results;
  }
  if (kind === 'webinar' && accountId) {
    const result = await db
      .prepare(
        `SELECT * FROM folders
          WHERE kind = ? AND account_id = ?
          ORDER BY display_order ASC, name ASC`,
      )
      .bind(kind, accountId)
      .all<Folder>();
    return result.results;
  }
  if (kind) {
    const result = await db
      .prepare(
        `SELECT * FROM folders WHERE kind = ? ORDER BY display_order ASC, name ASC`,
      )
      .bind(kind)
      .all<Folder>();
    return result.results;
  }
  const result = await db
    .prepare(`SELECT * FROM folders ORDER BY kind ASC, display_order ASC, name ASC`)
    .all<Folder>();
  return result.results;
}

export async function getFolderById(db: D1Database, id: string): Promise<Folder | null> {
  return db.prepare(`SELECT * FROM folders WHERE id = ?`).bind(id).first<Folder>();
}

export async function createFolder(
  db: D1Database,
  input: {
    kind: FolderKind;
    name: string;
    parentId?: string | null;
    displayOrder?: number;
    color?: string | null;
    accountId?: string | null;
  },
): Promise<Folder> {
  const id = crypto.randomUUID();
  const now = jstNow();
  try { await db
    .prepare(
      `INSERT INTO folders (id, kind, name, parent_id, display_order, color, account_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.kind,
      input.name,
      input.parentId ?? null,
      input.displayOrder ?? 0,
      input.color ?? null,
      input.accountId ?? null,
      now,
      now,
    )
    .run(); } catch (error) {
      if (/UNIQUE/.test(String(error))) throw new FolderConflictError();
      throw error;
    }
  return (await getFolderById(db, id))!;
}

export async function updateFolder(
  db: D1Database,
  id: string,
  input: { name?: string; parentId?: string | null; displayOrder?: number; color?: string | null; expectedRevision?: number },
): Promise<Folder | null> {
  const current = await getFolderById(db, id);
  if (!current) return null;
  const revision = input.expectedRevision ?? current.revision;
  if (revision !== current.revision) throw new FolderConflictError();
  const sets: string[] = [];
  const values: unknown[] = [];
  if (input.color !== undefined) {
    sets.push('color = ?');
    values.push(input.color);
  }
  if (input.name !== undefined) {
    sets.push('name = ?');
    values.push(input.name);
  }
  if ('parentId' in input) {
    sets.push('parent_id = ?');
    values.push(input.parentId ?? null);
  }
  if (input.displayOrder !== undefined) {
    sets.push('display_order = ?');
    values.push(input.displayOrder);
  }
  if (sets.length > 0) {
    sets.push('updated_at = ?', 'revision = revision + 1');
    values.push(jstNow(), id);
    await folderBatch(db, [folderRevisionGuard(db, id, revision),
      db.prepare(`UPDATE folders SET ${sets.join(', ')} WHERE id = ?`).bind(...values)]);
  }
  return getFolderById(db, id);
}

/**
 * 隣り合う2つのフォルダの並びを入れ替える（V6R-S2-c）。
 *
 * 画面が2つのフォルダを別々に更新すると、1回目だけ成功したとき
 * 同じ番号のフォルダが2つ残る。2つの更新を1回のまとめ書き（batch）にする。
 *
 * 一覧は display_order → name の順に並ぶ。番号が同じ2つは名前で並んでいるので、
 * 番号を交換しても並びが変わらない。そのときは「後ろへ行くほう」を +1 する。
 * 全部の兄弟を振り直さないのは、同時に触った人の並びを上書きしないため。
 */
export async function swapFolderOrder(db: D1Database, a: Folder, b: Folder): Promise<void> {
  let aOrder = b.display_order;
  let bOrder = a.display_order;
  if (a.display_order === b.display_order) {
    const aIsFirst = a.name <= b.name;
    aOrder = aIsFirst ? a.display_order + 1 : a.display_order;
    bOrder = aIsFirst ? b.display_order : b.display_order + 1;
  }
  const now = jstNow();
  await folderBatch(db, [folderRevisionGuard(db,a.id,a.revision),folderRevisionGuard(db,b.id,b.revision),
    db.prepare('UPDATE folders SET display_order = ?, updated_at = ?, revision = revision + 1 WHERE id = ?').bind(aOrder, now, a.id),
    db.prepare('UPDATE folders SET display_order = ?, updated_at = ?, revision = revision + 1 WHERE id = ?').bind(bOrder, now, b.id),
  ]);
}

/**
 * フォルダを消す。中身は消えず「未分類」に戻る。
 *
 * どの参照も ON DELETE SET NULL にしてある。フォルダは入れ物であって
 * 中身ではないので、入れ物を捨てて中身まで捨てると、テンプレートや
 * シナリオが黙って消えることになる。
 *
 * 子フォルダだけは ON DELETE CASCADE で一緒に消える。空の入れ物が
 * 親を失って一覧の最上位に湧いてくる方が分かりにくいため。
 */
export async function deleteFolder(db: D1Database, id: string, expectedRevision?: number): Promise<boolean> {
  const current = await getFolderById(db,id);
  if (!current) return false;
  const revision = expectedRevision ?? current.revision;
  if (revision !== current.revision) throw new FolderConflictError();
  // Older data may have a foreign-account descendant. Never cascade across it.
  const result = await folderBatch(db, [folderRevisionGuard(db,id,revision), db.prepare(`WITH RECURSIVE children(id, account_id, kind) AS (
    SELECT id, account_id, kind FROM folders WHERE id = ?
    UNION SELECT f.id, f.account_id, f.kind FROM folders f JOIN children c ON f.parent_id = c.id
  ) UPDATE automation_definitions SET confirmation_revision = confirmation_revision + 1
    WHERE folder_id IN (SELECT id FROM children)
      AND EXISTS (SELECT 1 FROM folders root WHERE root.id = ? AND root.kind = 'automation'
        AND NOT EXISTS (SELECT 1 FROM children c WHERE c.account_id IS NOT root.account_id OR c.kind <> root.kind))`).bind(id,id), db.prepare(`WITH RECURSIVE children(id, account_id, kind) AS (
    SELECT id, account_id, kind FROM folders WHERE id = ?
    UNION SELECT f.id, f.account_id, f.kind FROM folders f JOIN children c ON f.parent_id = c.id
  ) UPDATE rich_menu_groups SET confirmation_revision = confirmation_revision + 1
    WHERE folder_id IN (SELECT id FROM children)
      AND EXISTS (SELECT 1 FROM folders root WHERE root.id = ? AND root.kind = 'rich_menu'
        AND NOT EXISTS (SELECT 1 FROM children c WHERE c.account_id IS NOT root.account_id OR c.kind <> root.kind))`).bind(id,id), db.prepare(`WITH RECURSIVE children(id, account_id, kind) AS (
    SELECT id, account_id, kind FROM folders WHERE id = ?
    UNION SELECT f.id, f.account_id, f.kind FROM folders f JOIN children c ON f.parent_id = c.id
  ) UPDATE templates SET confirmation_revision = confirmation_revision + 1
    WHERE folder_id IN (SELECT id FROM children)
      AND EXISTS (SELECT 1 FROM folders root WHERE root.id = ? AND root.kind = 'template'
        AND NOT EXISTS (SELECT 1 FROM children c WHERE c.account_id IS NOT root.account_id OR c.kind <> root.kind))`).bind(id,id), db.prepare(`WITH RECURSIVE children(id, account_id, kind) AS (
    SELECT id, account_id, kind FROM folders WHERE id = ?
    UNION SELECT f.id, f.account_id, f.kind FROM folders f JOIN children c ON f.parent_id = c.id
  ) UPDATE scenarios SET content_revision = content_revision + 1
    WHERE folder_id IN (SELECT id FROM children)
      AND EXISTS (SELECT 1 FROM folders root WHERE root.id = ? AND root.kind = 'scenario'
        AND NOT EXISTS (SELECT 1 FROM children c WHERE c.account_id IS NOT root.account_id OR c.kind <> root.kind))`).bind(id,id), db.prepare(`WITH RECURSIVE children(id, account_id, kind) AS (
    SELECT id, account_id, kind FROM folders WHERE id = ?
    UNION SELECT f.id, f.account_id, f.kind FROM folders f JOIN children c ON f.parent_id = c.id
  ) UPDATE outgoing_webhooks SET confirmation_revision = confirmation_revision + 1
    WHERE folder_id IN (SELECT id FROM children)
      AND EXISTS (SELECT 1 FROM folders root WHERE root.id = ? AND root.kind = 'webhook'
        AND NOT EXISTS (SELECT 1 FROM children c WHERE c.account_id IS NOT root.account_id OR c.kind <> root.kind))`).bind(id,id), db.prepare(`WITH RECURSIVE children(id, account_id, kind) AS (
    SELECT id, account_id, kind FROM folders WHERE id = ?
    UNION SELECT f.id, f.account_id, f.kind FROM folders f JOIN children c ON f.parent_id = c.id
  ) UPDATE incoming_webhooks SET confirmation_revision = confirmation_revision + 1
    WHERE folder_id IN (SELECT id FROM children)
      AND EXISTS (SELECT 1 FROM folders root WHERE root.id = ? AND root.kind = 'webhook'
        AND NOT EXISTS (SELECT 1 FROM children c WHERE c.account_id IS NOT root.account_id OR c.kind <> root.kind))`).bind(id,id), db.prepare(`WITH RECURSIVE children(id, account_id, kind) AS (
    SELECT id, account_id, kind FROM folders WHERE parent_id = ?
    UNION SELECT f.id, f.account_id, f.kind FROM folders f JOIN children c ON f.parent_id = c.id
  ) DELETE FROM folders WHERE id = ? AND NOT EXISTS (
    SELECT 1 FROM children c WHERE c.account_id IS NOT folders.account_id OR c.kind <> folders.kind
  ) AND (kind <> 'tag' OR NOT EXISTS (
    SELECT 1 FROM tags t WHERE (t.folder_id = folders.id OR t.folder_id IN (SELECT id FROM children))
      AND t.line_account_id IS NOT folders.account_id
  ))`).bind(id, id)]);
  return Number(result[7].meta?.changes ?? 0) > 0;
}

/** kind ごとの件数。画面のタブに数字を出すため。 */
export async function countFoldersByKind(db: D1Database): Promise<Record<string, number>> {
  const result = await db
    .prepare(`SELECT kind, COUNT(*) AS c FROM folders GROUP BY kind`)
    .all<{ kind: string; c: number }>();
  const out: Record<string, number> = {};
  for (const row of result.results) out[row.kind] = Number(row.c);
  return out;
}

/**
 * `GET /api/folders` がフォルダごとの件数を返すための、kind→対象テーブル対応表。
 *
 * ここに載っているのは、一覧画面のアカウント可視範囲が
 * `allowedAccountIds`（配列）＋`canSeeUnassigned`（未割当を含むか）という
 * 同じ形で揃っている6種別だけ。**残り9種別（`webinar` を除く）は、機械的に
 * 数えると母集団を誤るため、意図して対応表に入れていない。**
 *
 * 対応表に無い理由:
 * - `friend_field`: scope 表（`friend_field_scopes`）基準が正しいことは確定しているが
 *   現時点では件数の利用先が無い。利用画面を作る時に接続する。
 *   テナント全体の無条件集計は採らない（他テナント混入のため）。
 * - `entry_route` / `mileage_rule`: `folder_id` 列を
 *   持つテーブルが存在せず、どの画面からも `kind` 指定で呼ばれていない
 *   （汎用フォルダ機構が未使用の種別）
 * - `form`: `forms.folder_id` はある（migration 395）が、所属先は
 *   `form_accounts` の結合で決まるため、この表の単一列の数え方では
 *   母集団がずれる。件数が要るときは一覧と同じ結合で数える別口にする。
 *
 * `webinar` はここには含めない。`getWebinarFolderCounts`（`webinars.ts`）が
 * 既にアカウント境界込みで実装済みで、呼び出し側（`GET /api/folders`）が
 * 種別で分岐してそちらを使う。
 */
export const FOLDER_ITEM_COUNT_TABLES: Partial<Record<FolderKind, {
  table: string;
  accountColumn: string;
  /**
   * 一覧が既定で掛けている絞り込み。件数も同じ母集団で数えるために要る。
   * ここが無いと、一覧に出ない行がフォルダ件数にだけ残る。
   *
   * 残りの種別には付けない。いま一覧側が何も絞っていないため、付けると
   * 逆に母集団がずれる。一覧側の絞り込みが増えたら、そのときここへ足す。
   */
  listFilter?: string;
}>> = {
  // 一覧は deleted_at IS NULL で絞る(apps/worker/src/routes/reminders.ts:425)。
  affiliate: { table: 'affiliates', accountColumn: 'line_account_id' },
  affiliate_offer: { table: 'affiliate_offers', accountColumn: 'line_account_id' },
  mileage_reward: { table: 'mileage_rewards', accountColumn: 'line_account_id', listFilter: "status <> 'archived'" },
  friend_add_rule: { table: 'friend_add_rules', accountColumn: 'line_account_id', listFilter: 'archived_at IS NULL' },
  reminder: { table: 'reminders', accountColumn: 'line_account_id', listFilter: 'deleted_at IS NULL' },
  scenario: { table: 'scenarios', accountColumn: 'line_account_id' },
  tag: { table: 'tags', accountColumn: 'line_account_id' },
  // 一覧は deleted_at IS NULL で絞る(packages/db/src/templates.ts の getTemplatesWithUsageCount)。
  template: { table: 'templates', accountColumn: 'line_account_id', listFilter: 'deleted_at IS NULL' },
  // 一覧は deleted_at IS NULL で絞る(packages/db/src/auto-replies.ts:76)。
  auto_reply: { table: 'auto_replies', accountColumn: 'line_account_id', listFilter: 'deleted_at IS NULL' },
  broadcast: { table: 'broadcasts', accountColumn: 'line_account_id' },
  // media / common_var / rich_menu は一覧が単一アカウントに閉じて
  // いるため、単一アカウント方式で数える。common_var は一覧と同じく
  // archived（archived_at IS NOT NULL）を除く。media の kind 等の追加絞りは
  // 件数へ入れず、選択中アカウント内のフォルダ総数にする。
  media: { table: 'media', accountColumn: 'line_account_id' },
  common_var: { table: 'common_vars', accountColumn: 'line_account_id', listFilter: 'archived_at IS NULL' },
  rich_menu: { table: 'rich_menu_groups', accountColumn: 'account_id' },
  automation: { table: 'automation_definitions', accountColumn: 'line_account_id', listFilter: "status <> 'archived'" },
  common_action: { table: 'common_actions', accountColumn: 'line_account_id', listFilter: "status <> 'archived'" },
  conversion: { table: 'conversion_points', accountColumn: 'line_account_id' },
};

export interface FolderItemCountScope {
  allowedAccountIds: string[];
  canSeeUnassigned: boolean;
}

export interface FolderItemCounts {
  /** フォルダIDごとの件数。0件のフォルダはキー自体が無い（GROUP BYの性質）。 */
  byFolderId: Record<string, number>;
  /** `folder_id IS NULL`（未分類）の件数。一覧の「未分類」タブと同じ母集団。 */
  unfiled: number;
}

/**
 * フォルダ内訳の件数を、一覧画面と同じ母集団（アカウント可視範囲）で数える。
 *
 * `kind` が {@link FOLDER_ITEM_COUNT_TABLES} に無ければ `undefined` を返す。
 * **`undefined` は「0件」ではなく「数えていない」。**呼び出し側はこれを
 * `0` へ読み替えず、「件数不明（—）」として扱うこと。
 */
export async function getFolderItemCounts(
  db: D1Database,
  kind: FolderKind,
  scope: FolderItemCountScope,
): Promise<FolderItemCounts | undefined> {
  if (kind === 'webhook') {
    const [incoming, outgoing] = await Promise.all(
      ['incoming_webhooks', 'outgoing_webhooks'].map(async table => {
        if (!scope.allowedAccountIds.length) return [] as { folder_id: string | null; item_count: number }[];
        const rows = await db.prepare(`SELECT folder_id, COUNT(*) AS item_count FROM ${table}
          WHERE deleted_at IS NULL AND line_account_id IN (${sqlIdSet(scope.allowedAccountIds).sql})
          GROUP BY folder_id`).bind(...(scope.allowedAccountIds.length ? sqlIdSet(scope.allowedAccountIds).binds : [])).all<{ folder_id: string | null; item_count: number }>();
        return rows.results;
      }),
    );
    const counts: FolderItemCounts = { byFolderId: {}, unfiled: 0 };
    for (const row of [...incoming, ...outgoing]) {
      if (row.folder_id === null) counts.unfiled += Number(row.item_count);
      else counts.byFolderId[row.folder_id] = (counts.byFolderId[row.folder_id] ?? 0) + Number(row.item_count);
    }
    return counts;
  }
  if (kind === 'event') {
    // 複数アカウント向けは sentinel ではなく account_ids を読む。EXISTS で重複を数えない。
    const ids = scope.allowedAccountIds;
    const slots = sqlIdSet(ids).sql;
    const visible = ids.length ? `((target_type = 'single' AND line_account_id IN (${slots}))
      OR (target_type = 'multi-account-dedup' AND EXISTS (
        SELECT 1 FROM json_each(events.account_ids) WHERE value IN (${slots})
      )))` : '0';
    const { results } = await db.prepare(`SELECT folder_id, COUNT(*) AS item_count FROM events
      WHERE deleted_at IS NULL AND ${visible} GROUP BY folder_id`).bind(...(ids.length ? sqlIdSet(ids).binds : []), ...(ids.length ? sqlIdSet(ids).binds : []))
      .all<{ folder_id: string | null; item_count: number }>();
    return {
      byFolderId: Object.fromEntries(results.filter(row => row.folder_id !== null).map(row => [row.folder_id, Number(row.item_count)])),
      unfiled: Number(results.find(row => row.folder_id === null)?.item_count ?? 0),
    };
  }
  if (['affiliate', 'affiliate_offer', 'mileage_reward', 'friend_add_rule'].includes(kind)) {
    scope = { ...scope, canSeeUnassigned: false };
  }
  const target = FOLDER_ITEM_COUNT_TABLES[kind];
  if (!target) return undefined;
  const { table, accountColumn, listFilter } = target;
  const accountSql = scope.allowedAccountIds.length > 0
    ? `${accountColumn} IN (${sqlIdSet(scope.allowedAccountIds).sql})`
    : null;
  let scopeSql: string;
  let bindings: string[];
  if (accountSql && scope.canSeeUnassigned) {
    scopeSql = `(${accountSql} OR ${accountColumn} IS NULL)`;
    bindings = sqlIdSet(scope.allowedAccountIds).binds;
  } else if (accountSql) {
    scopeSql = accountSql;
    bindings = sqlIdSet(scope.allowedAccountIds).binds;
  } else {
    scopeSql = scope.canSeeUnassigned ? `${accountColumn} IS NULL` : '1 = 0';
    bindings = [];
  }
  // folder_id ごとの内訳と未分類は別の集計（GROUP BY は NULL を1グループ
  // として返さないため、未分類だけ別クエリが要る）。Promise.all で
  // 並列に投げ、直列2往復にはしない。
  const listSql = listFilter ? ` AND ${listFilter}` : '';
  const [byFolderResult, unfiledResult] = await Promise.all([
    db.prepare(
      `SELECT folder_id, COUNT(*) AS item_count FROM ${table}
        WHERE folder_id IS NOT NULL AND ${scopeSql}${listSql}
        GROUP BY folder_id`,
    ).bind(...bindings).all<{ folder_id: string; item_count: number }>(),
    db.prepare(
      `SELECT COUNT(*) AS unfiled_count FROM ${table}
        WHERE folder_id IS NULL AND ${scopeSql}${listSql}`,
    ).bind(...bindings).first<{ unfiled_count: number }>(),
  ]);
  const byFolderId = Object.fromEntries(
    (byFolderResult.results ?? []).map((row) => [row.folder_id, Number(row.item_count)]),
  );
  return { byFolderId, unfiled: Number(unfiledResult?.unfiled_count ?? 0) };
}

export class FolderConflictError extends Error { constructor() { super('FOLDER_CONFLICT'); } }
export function folderRevisionGuard(db: D1Database, id: string, revision: number) {
  return db.prepare("SELECT json(CASE WHEN EXISTS(SELECT 1 FROM folders WHERE id=? AND revision=?) THEN '{}' ELSE 'FOLDER_CONFLICT' END)").bind(id,revision);
}
export async function folderBatch(db: D1Database, statements: D1PreparedStatement[]) {
  try { return await db.batch(statements); }
  catch (error) { if (/malformed JSON|FOLDER_CONFLICT|UNIQUE/i.test(String(error))) throw new FolderConflictError(); throw error; }
}
