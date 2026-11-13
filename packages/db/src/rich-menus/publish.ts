import { jstNow } from '../utils.js';
import { type PublishLeaseFence } from './types.js';


// Publish lease を取る。所有者(owner=run ID等)と期限(既定10分)付き。
// 有効期限内の他人所有だけが false (HTTP 409 用)。期限切れ・未所有・
// 旧形式(publishing_atのみ)の行は回収して取り直す。停止したWorkerが
// 残したlockで再試行と手動公開が塞がれないようにする。
// 手動公開も予約実行も同じ関数を使う。
export const PUBLISH_LEASE_MS = 10 * 60_000;

/** lease期限(UTCのISO8601)を作る。 */
export function publishLeaseExpiresAt(nowIso: string, ttlMs = PUBLISH_LEASE_MS): string {
  const time = Date.parse(nowIso);
  if (!Number.isFinite(time)) throw new Error('lease timestamp must be ISO 8601');
  return new Date(time + ttlMs).toISOString();
}

/**
 * lease を取る。取れたらその世代を返し、取れなければ null。
 *
 * 有効期限内の他人所有だけが null (HTTP 409 用)。期限切れ・未所有・
 * 旧形式(publishing_atのみ)の行は回収して取り直す。停止したWorkerが
 * 残したlockで再試行と手動公開が塞がれないようにする。
 * 手動公開も予約実行も同じ関数を使う。
 */
export async function acquirePublishLease(
  db: D1Database,
  groupId: string,
  owner: string,
  nowIso: string,
  ttlMs = PUBLISH_LEASE_MS,
  expected?:{version:number;generation:number;isDefaultForAll:boolean;pages:Array<{id:string;orderIndex:number;lineRichMenuId:string|null}>},
  expectedDraft?:{version:number;generation:number;pages:Array<{orderIndex:number;imageR2Key:string|null;imageContentType:string|null}>},
  expectedGeneration?: number,
  expectedConfirmationRevision?: number,
): Promise<number | null> {
  // 取得と世代の採番を1文にする。別々にすると、間に割り込んだ取得の世代を
  // 自分のものと取り違える。
  const row = await db
    .prepare(
      `UPDATE rich_menu_groups
         SET publishing_at = ?, publishing_owner = ?, publishing_expires_at = ?,
             publishing_generation = publishing_generation + 1
       WHERE id = ?
         AND (publishing_owner IS NULL
           OR publishing_expires_at IS NULL
           OR publishing_expires_at <= ?)
         AND (? IS NULL OR publishing_generation = ?)
         AND (? IS NULL OR confirmation_revision = ?)
         ${expected ? `AND version=? AND publishing_generation=? AND status='published' AND is_default_for_all=?
           AND (SELECT COUNT(*) FROM rich_menu_pages WHERE group_id=rich_menu_groups.id)=json_array_length(?)
           AND NOT EXISTS(SELECT 1 FROM rich_menu_pages p WHERE p.group_id=rich_menu_groups.id AND NOT EXISTS
             (SELECT 1 FROM json_each(?) e WHERE json_extract(e.value,'$.id')=p.id AND json_extract(e.value,'$.orderIndex')=p.order_index AND json_extract(e.value,'$.lineRichMenuId') IS p.line_richmenu_id))` : ''}
         ${expectedDraft ? `AND version=? AND publishing_generation=? AND (SELECT COUNT(*) FROM rich_menu_pages WHERE group_id=rich_menu_groups.id)=json_array_length(?)
           AND NOT EXISTS(SELECT 1 FROM rich_menu_pages p WHERE p.group_id=rich_menu_groups.id AND NOT EXISTS
             (SELECT 1 FROM json_each(?) e WHERE json_extract(e.value,'$.orderIndex')=p.order_index AND json_extract(e.value,'$.imageR2Key') IS p.image_r2_key AND json_extract(e.value,'$.imageContentType') IS p.image_content_type))` : ''}
       RETURNING publishing_generation`,
    )
    .bind(jstNow(), owner, publishLeaseExpiresAt(nowIso, ttlMs), groupId, nowIso, expectedGeneration ?? null, expectedGeneration ?? null, expectedConfirmationRevision ?? null, expectedConfirmationRevision ?? null,...(expected?[expected.version,expected.generation,Number(expected.isDefaultForAll),JSON.stringify(expected.pages),JSON.stringify(expected.pages)]:[]),...(expectedDraft?[expectedDraft.version,expectedDraft.generation,JSON.stringify(expectedDraft.pages),JSON.stringify(expectedDraft.pages)]:[]))
    .first<{ publishing_generation: number }>();
  return row ? row.publishing_generation : null;
}

/**
 * 外部工程(LINE呼び出し)の直前に期限を延ばす。所有者か世代が変わっていたら false。
 *
 * `nowIso` は**そのときの実現在時刻**を渡す。処理の入口で一度作った時刻を
 * 使い回すと、延ばしているつもりで期限が前に進まず、長い公開の途中で
 * lease が切れて別の実行に回収される。
 * false の run は live 切替も DB 確定もしてはいけない(回収した新所有者に任せる)。
 */
export async function renewPublishLease(
  db: D1Database,
  groupId: string,
  fence: PublishLeaseFence,
  nowIso: string,
  ttlMs = PUBLISH_LEASE_MS,
  expectedConfirmationRevision?: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE rich_menu_groups
         SET publishing_at = ?, publishing_expires_at = ?
       WHERE id = ? AND publishing_owner = ? AND publishing_generation = ? AND (? IS NULL OR confirmation_revision = ?)`,
    )
    .bind(jstNow(), publishLeaseExpiresAt(nowIso, ttlMs), groupId, fence.owner, fence.generation, expectedConfirmationRevision ?? null, expectedConfirmationRevision ?? null)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

/**
 * 持ち主だけが開けられる解放。所有者か世代が変わっていたら何もせず false。
 * false は lease を失った合図で、呼び出し側は切替・確定をやめる。
 */
export async function releasePublishLease(
  db: D1Database,
  groupId: string,
  fence: PublishLeaseFence,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE rich_menu_groups
         SET publishing_at = NULL, publishing_owner = NULL, publishing_expires_at = NULL
       WHERE id = ? AND publishing_owner = ? AND publishing_generation = ?`,
    )
    .bind(groupId, fence.owner, fence.generation)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

/**
 * いま他人が有効に持っているか。手動公開の事前409判定用。
 * 期限切れ・旧形式の残留は「持っていない」扱いで、取得時に回収される。
 */
export async function isPublishLeaseHeld(
  db: D1Database,
  groupId: string,
  nowIso: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS hit FROM rich_menu_groups
        WHERE id = ? AND publishing_owner IS NOT NULL
          AND (publishing_expires_at IS NULL OR publishing_expires_at > ?)`,
    )
    .bind(groupId, nowIso)
    .first<{ hit: number }>();
  return !!row;
}

/**
 * lease を持っている run だけが書けるようにする条件句。
 * 札を渡さない呼び出し(lease を取らない初期公開など)は条件なしで書く。
 */
export function fenceClause(fence: PublishLeaseFence | undefined, groupIdColumn: string): string {
  if (!fence) return '';
  return ` AND EXISTS (SELECT 1 FROM rich_menu_groups g
                        WHERE g.id = ${groupIdColumn}
                          AND g.publishing_owner = ?
                          AND g.publishing_generation = ?)`;
}

export function fenceBinds(fence: PublishLeaseFence | undefined): unknown[] {
  return fence ? [fence.owner, fence.generation] : [];
}

export async function setPageRichMenuId(
  db: D1Database,
  pageId: string,
  lineRichMenuId: string,
  fence?: PublishLeaseFence,
): Promise<boolean> {
  // 札があるときは「まだ自分が lease を持っている」ことを同じ1文の条件にする。
  // 先に確認してから書くと、確認と書込みの間に回収された旧holderが
  // 新しい所有者の反映を古いIDで上書きできてしまう。
  const results = await db.batch([
    db.prepare(
      `UPDATE rich_menu_pages SET line_richmenu_id = ?, updated_at = ?
        WHERE id = ?${fenceClause(fence, 'rich_menu_pages.group_id')}`,
    )
    .bind(lineRichMenuId, jstNow(), pageId, ...fenceBinds(fence)),
    db.prepare(`UPDATE rich_menu_groups SET confirmation_revision = confirmation_revision + 1
      WHERE id = (SELECT group_id FROM rich_menu_pages WHERE id = ? AND line_richmenu_id = ?)${fence ? ' AND publishing_owner = ? AND publishing_generation = ?' : ''}`)
      .bind(pageId, lineRichMenuId, ...fenceBinds(fence)),
  ]);
  return (results[0].meta?.changes ?? 0) > 0;
}

/**
 * 公開の確定。札があるときは持ち主だけが通る1文で、ここが唯一の分かれ目。
 *
 * lease はここでは開けない。確定と解放を1文に混ぜると、
 * (1) 解放後に続く外部操作が無防備になり、
 * (2) 「自分が開けた」と「他人に取られた」が owner=NULL で見分けられなくなる。
 * 解放は所有者付きの releasePublishLease で別に行う。
 */
export async function markRichMenuGroupPublished(
  db: D1Database,
  groupId: string,
  fence?: PublishLeaseFence,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE rich_menu_groups
         SET status = 'published', confirmation_revision = confirmation_revision + 1, updated_at = ?
       WHERE id = ?${fence ? ' AND publishing_owner = ? AND publishing_generation = ?' : ''}`,
    )
    .bind(jstNow(), groupId, ...fenceBinds(fence))
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

// Unpublish 完了時の DB 整合: 全 page の line_richmenu_id を null に戻し、
// group.status を 'draft' に戻す。is_default_for_all も 0 に戻す
// (LINE 側で default unlink された前提)。LINE 側で alias / richmenu / default
// の削除が成功した後に呼ばれる想定。
/**
 * 停止の確定。**分かれ目は group の1文だけ**にする。
 *
 * page を先に消してから group を落とすと、その間に別の接続へ
 * 引き継がれると、負けた旧holderが page ID だけ消して group はそのまま、
 * という中途半端な状態を作れてしまう(公開中の page ID が null になる)。
 * 札が合わなければ**何も書かない**ようにするため、まず group を1文で決め、
 * 通ったときだけ page を掃除する。page 側にも同じ札を付けるので、
 * 決めたあとに引き継がれても新しい所有者の反映は消さない。
 * lease はここでは開けない(所有者付きの releasePublishLease で別に開ける)。
 */
export async function markRichMenuGroupUnpublished(
  db: D1Database,
  groupId: string,
  fence?: PublishLeaseFence,
): Promise<boolean> {
  const now = jstNow();
  const decided = await db
    .prepare(
      `UPDATE rich_menu_groups
          SET status = 'draft', is_default_for_all = 0, confirmation_revision = confirmation_revision + 1, updated_at = ?
        WHERE id = ?${fence ? ' AND publishing_owner = ? AND publishing_generation = ?' : ''}`,
    )
    .bind(now, groupId, ...fenceBinds(fence))
    .run();
  if ((decided.meta?.changes ?? 0) === 0) return false;
  await db
    .prepare(
      `UPDATE rich_menu_pages
          SET line_richmenu_id = NULL, updated_at = ?
        WHERE group_id = ?${fenceClause(fence, 'rich_menu_pages.group_id')}`,
    )
    .bind(now, groupId, ...fenceBinds(fence))
    .run();
  return true;
}
