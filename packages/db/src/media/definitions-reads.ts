import { jstNow } from '../utils.js';
import { getMediaStorageQuota } from './uploads.js';
import { type MediaRefKind, type MediaUsageMutationResult, type MediaKind, type Media } from './primitives.js';



const restaurantMenuPhotoUses = `(
  SELECT image_media_id, COUNT(*) AS usage_count FROM (
    SELECT id, image_media_id FROM rt_menu_items WHERE image_media_id IS NOT NULL
    UNION
    SELECT menu.id, json_extract(photo.value, '$.mediaId')
    FROM rt_menu_items menu, json_each(menu.photo_gallery_json) photo
  )
  GROUP BY image_media_id
)`;

export const LOOKUP_CHUNK = 90;
export const MEDIA_USAGE_WRITE_CHUNK = 20;

/**
 * 表が無いときの読み口失敗。
 *
 * 古い検証環境などで機能の表がまだ無いと、D1 は `no such table` で
 * 落ちる。使用先の確認は「読めなかったら例外」が原則だが、表そのものが
 * 無い読み口まで例外にすると、どの画像でも取得が失敗し、読み直しても
 * 直らない。表が無い読み口は「未確認」として残し、ほかの
 * 読み口は続ける。一時的なD1障害はここでは救わず、例外のままにする。
 */
export function isMissingTableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('no such table');
}

/**
 * 「上限に近い」は1ファイルの固定値(旧: 画像8MB等)では
 * なく、契約上限への圧迫で決める。契約上限のこの割合以上を1行で占める
 * ファイルだけを返す。分母は getMediaStorageQuota と同じ計算元の
 * limitBytes を使い、要求値や画面内推定は使わない。既定10GBの0.1%は
 * 約10MBで、旧しきい値(画像8MB級)と同じ帯に寄せている。
 */
export const MEDIA_NEAR_LIMIT_SHARE = 0.001;

/** 保存先と別のLINEアカウントのメディアが本文に含まれる。 */
export class MediaReferenceAccountError extends Error {
  constructor() {
    super('MEDIA_REFERENCE_ACCOUNT_MISMATCH');
    this.name = 'MediaReferenceAccountError';
  }
}

/**
 * 本文が指すライブURL・固定版R2キーを解決し、本体の保存と使用台帳を1原子処理で書く。
 *
 * 参照保存だけが成功して台帳が0件になる窓を作らないため、呼び出し側の
 * INSERT/UPDATEも同じ `db.batch` へ渡す。別accountのキーはbatch開始前に拒否し、
 * 台帳INSERTが失敗した場合はD1のbatch rollbackで本体も戻す。
 *
 * `usageGuard` はCAS付き更新用。更新に負けた実行が、勝った実行の台帳を
 * 古い候補で上書きしないよう、各台帳文に現在行の条件を付ける。
 */
export async function applyMediaUsageMutation(
  db: D1Database,
  input: {
    lineAccountId: string | null;
    refKind: MediaRefKind;
    refId: string;
    searchableContent: Array<string | null | undefined>;
    mutationStatements: D1PreparedStatement[];
    usageGuard?: { sql: string; binds: unknown[] };
  },
): Promise<MediaUsageMutationResult[]> {
  const content = input.searchableContent.filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  let referenced: Array<{ id: string; line_account_id: string | null }> = [];
  if (content.length > 0) {
    const matchOne = `(
      instr(?, m.r2_key) > 0
      OR (mv.r2_key IS NOT NULL AND instr(?, mv.r2_key) > 0)
      OR instr(?, '/media/' || m.id || '/content') > 0
    )`;
    const rows = await db.prepare(
      `SELECT DISTINCT m.id, m.line_account_id
         FROM media m
         LEFT JOIN media_versions mv ON mv.media_id = m.id
        WHERE ${content.map(() => matchOne).join(' OR ')}`,
    ).bind(...content.flatMap((value) => [value, value, value]))
      .all<{ id: string; line_account_id: string | null }>();
    referenced = rows.results;
  }
  if (referenced.some((row) => row.line_account_id !== input.lineAccountId)) {
    throw new MediaReferenceAccountError();
  }

  const guardSql = input.usageGuard ? ` AND (${input.usageGuard.sql})` : '';
  const guardBinds = input.usageGuard?.binds ?? [];
  const statements = [
    ...input.mutationStatements,
    db.prepare(
      `DELETE FROM media_usages
        WHERE ref_kind = ? AND ref_id = ?${guardSql}`,
    ).bind(input.refKind, input.refId, ...guardBinds),
  ];
  const scannedAt = jstNow();
  for (let index = 0; index < referenced.length; index += MEDIA_USAGE_WRITE_CHUNK) {
    const chunk = referenced.slice(index, index + MEDIA_USAGE_WRITE_CHUNK);
    if (input.usageGuard) {
      statements.push(db.prepare(
        `WITH pending(media_id, ref_kind, ref_id, scanned_at) AS (
           VALUES ${chunk.map(() => '(?, ?, ?, ?)').join(',')}
         )
         INSERT INTO media_usages (media_id, ref_kind, ref_id, scanned_at)
         SELECT media_id, ref_kind, ref_id, scanned_at FROM pending
          WHERE ${input.usageGuard.sql}`,
      ).bind(
        ...chunk.flatMap((row) => [row.id, input.refKind, input.refId, scannedAt]),
        ...guardBinds,
      ));
      continue;
    }
    statements.push(db.prepare(
      `INSERT INTO media_usages (media_id, ref_kind, ref_id, scanned_at)
       VALUES ${chunk.map(() => '(?, ?, ?, ?)').join(',')}`,
    ).bind(...chunk.flatMap((row) => [row.id, input.refKind, input.refId, scannedAt])));
  }
  return db.batch(statements) as Promise<MediaUsageMutationResult[]>;
}

export async function getMedia(
  db: D1Database,
  opts: {
    lineAccountId: string;
    kind?: MediaKind;
    folderId?: string;
    excludeId?: string;
    query?: string;
    unusedOnly?: boolean;
    nearLimitOnly?: boolean;
    /**
     * アーカイブの扱い。既定 'exclude'（一覧・選択には出さない）。
     * 'only' はアーカイブ済みだけ、'all' は全部。
     */
    archived?: 'exclude' | 'only' | 'all';
    sort?: 'newest' | 'oldest' | 'name' | 'size' | 'usage';
    limit?: number;
    offset?: number;
  },
): Promise<Media[]> {
  const conditions: string[] = ['m.line_account_id = ?'];
  const values: unknown[] = [opts.lineAccountId];
  if (opts.archived === 'only') conditions.push('m.archived_at IS NOT NULL');
  else if (opts.archived !== 'all') conditions.push('m.archived_at IS NULL');
  if (opts.kind) {
    conditions.push('kind = ?');
    values.push(opts.kind);
  }
  if (opts.folderId) {
    if (opts.folderId === '__ungrouped__') conditions.push('m.folder_id IS NULL');
    else {
      conditions.push('m.folder_id = ?');
      values.push(opts.folderId);
    }
  }
  if (opts.excludeId) {
    conditions.push('m.id != ?');
    values.push(opts.excludeId);
  }
  if (opts.query) {
    conditions.push("LOWER(m.filename) LIKE ? ESCAPE '\\'");
    values.push(`%${opts.query.toLowerCase().replace(/[\\%_]/g, '\\$&')}%`);
  }
  if (opts.unusedOnly) {
    conditions.push('(SELECT COUNT(*) FROM media_usages u WHERE u.media_id = m.id) = 0 AND COALESCE(menu_uses.usage_count, 0) = 0');
  }
  if (opts.nearLimitOnly) {
    // 一覧口と同じ計算元。INSERT OR IGNORE で上限行が無い口座にも既定値が入る。
    // 上限未設定(limit<=0)は安全側で何も返さない。壊れ値(負値・NULL)は
    // 正のしきい値との比較で自然に外れる。
    const quota = await getMediaStorageQuota(db, opts.lineAccountId);
    if (!(quota.limitBytes > 0)) return [];
    conditions.push('m.size_bytes >= ?');
    values.push(quota.limitBytes * MEDIA_NEAR_LIMIT_SHARE);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const orderBy = opts.sort === 'oldest' ? 'm.created_at ASC'
    : opts.sort === 'name' ? 'm.filename COLLATE NOCASE ASC'
      : opts.sort === 'size' ? 'm.size_bytes DESC'
        : opts.sort === 'usage' ? 'usage_count DESC, m.created_at DESC'
          : 'm.created_at DESC';
  values.push(opts.limit ?? 200, opts.offset ?? 0);
  const result = await db
    .prepare(
      `SELECT m.*,
              (SELECT COUNT(*) FROM media_usages u WHERE u.media_id = m.id) + COALESCE(menu_uses.usage_count, 0) AS usage_count
         FROM media m
         LEFT JOIN ${restaurantMenuPhotoUses} menu_uses ON menu_uses.image_media_id = m.id
         ${where}
        ORDER BY ${orderBy}
        LIMIT ? OFFSET ?`,
    )
    .bind(...values)
    .all<Media>();
  return result.results;
}

/** 一覧と同じ条件で、ページ外を含む総件数を返す。 */
export async function countMedia(
  db: D1Database,
  opts: Omit<Parameters<typeof getMedia>[1], 'limit' | 'offset' | 'sort'>,
): Promise<number> {
  const conditions = ['m.line_account_id = ?'];
  const values: unknown[] = [opts.lineAccountId];
  if (opts.kind) { conditions.push('m.kind = ?'); values.push(opts.kind); }
  if (opts.folderId === '__ungrouped__') conditions.push('m.folder_id IS NULL');
  else if (opts.folderId) { conditions.push('m.folder_id = ?'); values.push(opts.folderId); }
  if (opts.excludeId) { conditions.push('m.id != ?'); values.push(opts.excludeId); }
  if (opts.query) {
    conditions.push("LOWER(m.filename) LIKE ? ESCAPE '\\'");
    values.push(`%${opts.query.toLowerCase().replace(/[\\%_]/g, '\\$&')}%`);
  }
  if (opts.unusedOnly) conditions.push('(SELECT COUNT(*) FROM media_usages u WHERE u.media_id = m.id) = 0 AND COALESCE(menu_uses.usage_count, 0) = 0');
  if (opts.archived === 'only') conditions.push('m.archived_at IS NOT NULL');
  else if (opts.archived !== 'all') conditions.push('m.archived_at IS NULL');
  if (opts.nearLimitOnly) {
    const quota = await getMediaStorageQuota(db, opts.lineAccountId);
    if (!(quota.limitBytes > 0)) return 0;
    conditions.push('m.size_bytes >= ?');
    values.push(quota.limitBytes * MEDIA_NEAR_LIMIT_SHARE);
  }
  const row = await db.prepare(`SELECT COUNT(*) AS total FROM media m LEFT JOIN ${restaurantMenuPhotoUses} menu_uses ON menu_uses.image_media_id = m.id WHERE ${conditions.join(' AND ')}`)
    .bind(...values).first<{ total: number }>();
  return Number(row?.total ?? 0);
}

export async function getMediaById(
  db: D1Database,
  id: string,
  lineAccountId: string | null,
): Promise<Media | null> {
  if (lineAccountId === null) {
    return db.prepare(`SELECT * FROM media WHERE id = ? AND line_account_id IS NULL`)
      .bind(id).first<Media>();
  }
  return db.prepare(`SELECT * FROM media WHERE id = ? AND line_account_id = ?`)
    .bind(id, lineAccountId).first<Media>();
}
