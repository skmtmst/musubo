import {getBannerUsageToday,getBannerUsageThisMonth,countRecentFailedBannerGenerations,recordBannerUsage} from './banner-generation-usage.js';
export {getBannerUsageToday,countRecentFailedBannerGenerations,getBannerUsageThisMonth,recordBannerUsage} from './banner-generation-usage.js';
import { sqlIdSet } from './id-queries.js';
import { readHqBannerFolderAssignment } from './hq-folders.js';
import { jstNow } from './utils.js';
import type { Media } from './media/primitives/index.js';
import { prepareWorkflowStep, type WorkflowStepRef } from './workflow-steps.js';

/**
 * 統括の「バナー生成」。
 *
 * プロジェクト（まとまり）→ 生成（1回の「生成する」）→ 画像（1枚ずつ）の順で並ぶ。
 * 画像の実体は media 表に置き、ここではプロジェクトとの関係と生成条件だけを持つ。
 */

export const BANNER_GENERATION_STATUSES = ['queued', 'running', 'done', 'failed', 'canceled'] as const;
export type BannerGenerationStatus = (typeof BANNER_GENERATION_STATUSES)[number];

export const BANNER_MODES = ['banner', 'free'] as const;
export type BannerMode = (typeof BANNER_MODES)[number];

export const BANNER_QUALITIES = ['low', 'medium', 'high'] as const;
export type BannerQuality = (typeof BANNER_QUALITIES)[number];

export const BANNER_PERSON_OPTIONS = ['with', 'without'] as const;
export type BannerPersonOption = (typeof BANNER_PERSON_OPTIONS)[number];

export const BANNER_IMAGE_SOURCES = ['generated', 'upload', 'edited'] as const;
export type BannerImageSource = (typeof BANNER_IMAGE_SOURCES)[number];

/**
 * 参照画像の使い方（承認済み ★BG-C `cOgWE`）。画像ごとに1つ選ぶ。
 * - `edit`    土台にする（構図と配色を残し、文字や背景だけ変える）
 * - `parts`   素材を一部使う（ロゴや商品だけ取り込んで組み立てる）
 * - `inspire` 雰囲気を参考にする（色とトーンだけ引き継ぐ）
 */
export const BANNER_REFERENCE_MODES = ['edit', 'parts', 'inspire'] as const;
export type BannerReferenceMode = (typeof BANNER_REFERENCE_MODES)[number];

/** 参照画像は1回の生成で最大3枚（承認済み ★BG-C `cOgWE`）。 */
export const BANNER_MAX_REFERENCE_IMAGES = 3;

/** 参照画像1枚とその使い方。 */
export interface BannerReference {
  imageId: string;
  mode: BannerReferenceMode;
}

export function isBannerReferenceMode(value: unknown): value is BannerReferenceMode {
  return typeof value === 'string' && (BANNER_REFERENCE_MODES as readonly string[]).includes(value);
}

/**
 * DB の列から参照画像の一覧を組み立てる。
 * 新しい `reference_images`（JSON）を優先し、無ければ古い1枚組の列から作る。
 */
export function bannerReferencesFromRow(row: {
  reference_images?: string | null;
  reference_image_id?: string | null;
  reference_mode?: string | null;
}): BannerReference[] {
  if (row.reference_images) {
    try {
      const parsed = JSON.parse(row.reference_images) as unknown;
      if (Array.isArray(parsed)) {
        return parsed
          .filter(
            (entry): entry is BannerReference =>
              !!entry &&
              typeof entry === 'object' &&
              typeof (entry as BannerReference).imageId === 'string' &&
              !!(entry as BannerReference).imageId &&
              isBannerReferenceMode((entry as BannerReference).mode),
          )
          .slice(0, BANNER_MAX_REFERENCE_IMAGES);
      }
    } catch {
      // 読めない中身は無かったものとして扱う（古い列へ落ちる）。
    }
  }
  if (row.reference_image_id) {
    return [
      { imageId: row.reference_image_id, mode: isBannerReferenceMode(row.reference_mode) ? row.reference_mode : 'inspire' },
    ];
  }
  return [];
}

export interface BannerProject {
  folder_id?: string | null;
  id: string;
  tenant_id: string;
  name: string;
  description: string;
  is_favorite: number;
  archived_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  /** 一覧取得時だけ付く。 */
  image_count?: number;
  /** 一覧取得時だけ付く。生成中のジョブが残っている数。 */
  running_count?: number;
}

export interface BannerGeneration {
  ai_account_id?: string | null;
  crop_gravity?: 'center' | 'top' | 'bottom';
  stop_requested_at?: string | null;
  id: string;
  tenant_id: string;
  project_id: string;
  status: BannerGenerationStatus;
  mode: BannerMode;
  preset_key: string;
  aspect_ratio: string;
  api_size: string;
  quality: BannerQuality;
  text_lines: string;
  /**
   * 行ごとの「強調」（Pencil `g64HOD`）。
   * `text_lines` と同じ順の `[true,false,…]` の JSON 文字。
   * 列を足す前に作った生成は null で、そのときは強調なしとして読む。
   */
  emphasis_lines?: string | null;
  base_color: string | null;
  main_color: string | null;
  sub_color: string | null;
  accent_color: string | null;
  person_option: BannerPersonOption;
  custom_prompt: string;
  free_prompt: string;
  final_prompt: string;
  engine: string;
  model_name: string | null;
  requested_count: number;
  done_count: number;
  failed_count: number;
  units_per_image: number;
  error_message: string | null;
  reference_image_id?: string | null;
  reference_mode?: BannerReferenceMode | null;
  /** 参照画像の一覧（最大3枚）。`[{"imageId":"…","mode":"edit"}]` の JSON 文字。 */
  reference_images?: string | null;
  created_by: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface BannerImage {
  folder_id?: string | null;
  id: string;
  tenant_id: string;
  project_id: string;
  generation_id: string | null;
  media_id: string;
  sequence: number;
  source: BannerImageSource;
  parent_image_id: string | null;
  is_favorite: number;
  deleted_at: string | null;
  created_by: string | null;
  created_at: string;
}

/** 画像一覧で使う、media と生成条件をつないだ行。 */
export interface BannerImageWithDetail extends BannerImage {
  media: Media;
  generation: BannerGeneration | null;
  delivered_account_ids: string[];
}

export interface BannerImageDelivery {
  id: string;
  banner_image_id: string;
  line_account_id: string;
  media_id: string;
  delivered_by: string | null;
  created_at: string;
}

// ---------------------------------------------------------------- projects

export async function listBannerProjects(
  db: D1Database,
  opts: { tenantId: string; archived: boolean; query?: string; folderId?: string | null },
): Promise<BannerProject[]> {
  const conditions = ['p.tenant_id = ?', opts.archived ? 'p.archived_at IS NOT NULL' : 'p.archived_at IS NULL'];
  const values: unknown[] = [opts.tenantId];
  if (opts.folderId !== undefined) { conditions.push(opts.folderId === null ? 'p.folder_id IS NULL' : 'p.folder_id = ?'); if (opts.folderId !== null) values.push(opts.folderId); }
  if (opts.query) {
    conditions.push('(p.name LIKE ? OR p.description LIKE ?)');
    const like = `%${opts.query}%`;
    values.push(like, like);
  }
  const result = await db
    .prepare(
      `SELECT p.*,
              (SELECT COUNT(*) FROM banner_images i
                WHERE i.project_id = p.id AND i.deleted_at IS NULL) AS image_count,
              (SELECT COUNT(*) FROM banner_generations g
                WHERE g.project_id = p.id AND g.status IN ('queued', 'running')) AS running_count
         FROM banner_projects p
        WHERE ${conditions.join(' AND ')}
        ORDER BY p.is_favorite DESC, p.updated_at DESC
        LIMIT 200`,
    )
    .bind(...values)
    .all<BannerProject>();
  return result.results;
}

export async function getBannerProject(
  db: D1Database,
  id: string,
  tenantId: string,
): Promise<BannerProject | null> {
  return db
    .prepare(
      `SELECT p.*,
              (SELECT COUNT(*) FROM banner_images i
                WHERE i.project_id = p.id AND i.deleted_at IS NULL) AS image_count,
              (SELECT COUNT(*) FROM banner_generations g
                WHERE g.project_id = p.id AND g.status IN ('queued', 'running')) AS running_count
         FROM banner_projects p
        WHERE p.id = ? AND p.tenant_id = ?`,
    )
    .bind(id, tenantId)
    .first<BannerProject>();
}

export async function createBannerProject(
  db: D1Database,
  input: { tenantId: string; name: string; description?: string; createdBy?: string | null; folderId?: string | null },
): Promise<BannerProject> {
  const folderId = await readHqBannerFolderAssignment(db,input.tenantId,'project',input.folderId);
  const id = crypto.randomUUID();
  const now = jstNow();
  await db
    .prepare(
      `INSERT INTO banner_projects
         (id, tenant_id, name, description, is_favorite, archived_at, created_by, created_at, updated_at, folder_id)
       VALUES (?, ?, ?, ?, 0, NULL, ?, ?, ?, ?)`,
    )
    .bind(id, input.tenantId, input.name, input.description ?? '', input.createdBy ?? null, now, now, folderId ?? null)
    .run();
  return (await getBannerProject(db, id, input.tenantId))!;
}

export async function updateBannerProject(
  db: D1Database,
  id: string,
  tenantId: string,
  patch: { name?: string; description?: string; isFavorite?: boolean; archived?: boolean; folderId?: string | null },
): Promise<BannerProject | null> {
  const folderId=await readHqBannerFolderAssignment(db,tenantId,'project',patch.folderId);
  const sets: string[] = [];
  const values: unknown[] = [];
  if (folderId !== undefined) { sets.push('folder_id = ?'); values.push(folderId); }
  if (patch.name !== undefined) { sets.push('name = ?'); values.push(patch.name); }
  if (patch.description !== undefined) { sets.push('description = ?'); values.push(patch.description); }
  if (patch.isFavorite !== undefined) { sets.push('is_favorite = ?'); values.push(patch.isFavorite ? 1 : 0); }
  if (patch.archived !== undefined) { sets.push('archived_at = ?'); values.push(patch.archived ? jstNow() : null); }
  if (sets.length === 0) return getBannerProject(db, id, tenantId);
  sets.push('updated_at = ?');
  values.push(jstNow(), id, tenantId);
  await db
    .prepare(`UPDATE banner_projects SET ${sets.join(', ')} WHERE id = ? AND tenant_id = ?`)
    .bind(...values)
    .run();
  return getBannerProject(db, id, tenantId);
}

export async function touchBannerProject(db: D1Database, id: string): Promise<void> {
  await db.prepare('UPDATE banner_projects SET updated_at = ? WHERE id = ?').bind(jstNow(), id).run();
}

// ------------------------------------------------------------- generations

export function bannerGenerationWorkflowRef(tenantId: string, generationId: string): WorkflowStepRef {
  return { scopeId: `tenant:${tenantId}`, processKind: 'banner_generation', subjectId: generationId, stepKey: '__run' };
}

export async function createBannerGeneration(
  db: D1Database,
  input: {
    /** Deterministic operation ID supplied only by the authenticated API. */
    operationId?: string;
    aiAccountId?: string;
    tenantId: string;
    projectId: string;
    mode: BannerMode;
    presetKey: string;
    aspectRatio: string;
    apiSize: string;
    quality: BannerQuality;
    textLines: string[];
    /** 行ごとの「強調」。`textLines` と同じ順・同じ長さ（★修正案 `g64HOD`）。 */
    emphasisLines?: boolean[] | null;
    baseColor: string | null;
    mainColor: string | null;
    subColor: string | null;
    accentColor: string | null;
    personOption: BannerPersonOption;
    customPrompt: string;
    freePrompt: string;
    finalPrompt: string;
    engine: string;
    modelName: string | null;
    requestedCount: number;
    unitsPerImage: number;
    cropGravity?: 'center' | 'top' | 'bottom';
    /** 参照画像（最大3枚・画像ごとに使い方）。無ければ空配列。 */
    references?: BannerReference[] | null;
    createdBy?: string | null;
    scheduleInStaging?: boolean;
  },
): Promise<BannerGeneration> {
  const id = input.operationId ?? crypto.randomUUID();
  const references = (input.references ?? []).slice(0, BANNER_MAX_REFERENCE_IMAGES);
  const insert = db
    .prepare(
      `INSERT INTO banner_generations
         (id, tenant_id, project_id, status, mode, preset_key, aspect_ratio, api_size, quality,
          text_lines, emphasis_lines, base_color, main_color, sub_color, accent_color,
          person_option, custom_prompt, free_prompt, final_prompt,
          engine, model_name, requested_count, done_count, failed_count, units_per_image,
          error_message, reference_image_id, reference_mode, reference_images, created_by, created_at, crop_gravity, ai_account_id)
       VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, NULL, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
    )
    .bind(
      id,
      input.tenantId,
      input.projectId,
      input.mode,
      input.presetKey,
      input.aspectRatio,
      input.apiSize,
      input.quality,
      JSON.stringify(input.textLines),
      // 強調は行と同じ順で入れる（指定が無いときは全部オフと同じ扱いにする）。
      JSON.stringify(input.textLines.map((_, index) => input.emphasisLines?.[index] === true)),
      input.baseColor,
      input.mainColor,
      input.subColor,
      input.accentColor,
      input.personOption,
      input.customPrompt,
      input.freePrompt,
      input.finalPrompt,
      input.engine,
      input.modelName,
      input.requestedCount,
      input.unitsPerImage,
      // 1枚目は古い列にも入れる（前の版で作った生成と同じ形で読めるようにする）。
      references[0]?.imageId ?? null,
      references[0]?.mode ?? null,
      references.length ? JSON.stringify(references) : null,
      input.createdBy ?? null,
      jstNow(),
      input.cropGravity ?? 'center',
      input.aiAccountId ?? null,
    );
  if (input.scheduleInStaging) {
    // Record only newly accepted requests so enabling the staging schedule cannot replay the backlog.
    await db.batch([insert, prepareWorkflowStep(db, bannerGenerationWorkflowRef(input.tenantId, id), {
      afterChange: true,
      input: { stagingAccepted: true },
      maxAttempts: 50,
    })]);
  } else {
    await insert.run();
  }
  return (await getBannerGeneration(db, id, input.tenantId))!;
}

export async function getBannerGeneration(
  db: D1Database,
  id: string,
  tenantId: string,
): Promise<BannerGeneration | null> {
  return db
    .prepare('SELECT * FROM banner_generations WHERE id = ? AND tenant_id = ?')
    .bind(id, tenantId)
    .first<BannerGeneration>();
}

export async function listBannerGenerations(
  db: D1Database,
  projectId: string,
  tenantId: string,
): Promise<BannerGeneration[]> {
  const result = await db
    .prepare(
      `SELECT * FROM banner_generations
        WHERE project_id = ? AND tenant_id = ?
        ORDER BY created_at DESC LIMIT 100`,
    )
    .bind(projectId, tenantId)
    .all<BannerGeneration>();
  return result.results;
}

/**
 * 生成の進み具合を更新する。
 * 1枚できるたびに done_count を足し、最後の1枚で done にする。
 */
export async function updateBannerGenerationProgress(
  db: D1Database,
  id: string,
  patch: {
    status?: BannerGenerationStatus;
    doneDelta?: number;
    failedDelta?: number;
    errorMessage?: string | null;
    markStarted?: boolean;
    markFinished?: boolean;
  },
): Promise<void> {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (patch.status) { sets.push('status = ?'); values.push(patch.status); }
  if (patch.doneDelta) { sets.push('done_count = done_count + ?'); values.push(patch.doneDelta); }
  if (patch.failedDelta) { sets.push('failed_count = failed_count + ?'); values.push(patch.failedDelta); }
  if (patch.errorMessage !== undefined) { sets.push('error_message = ?'); values.push(patch.errorMessage); }
  if (patch.markStarted) { sets.push('started_at = COALESCE(started_at, ?)'); values.push(jstNow()); }
  if (patch.markFinished) { sets.push('finished_at = ?'); values.push(jstNow()); }
  if (sets.length === 0) return;
  values.push(id);
  await db.prepare(`UPDATE banner_generations SET ${sets.join(', ')} WHERE id = ?`).bind(...values).run();
}

// ------------------------------------------------------------------ images

export async function createBannerImage(
  db: D1Database,
  input: {
    tenantId: string;
    projectId: string;
    generationId: string | null;
    mediaId: string;
    sequence: number;
    source: BannerImageSource;
    parentImageId?: string | null;
    createdBy?: string | null;
  },
): Promise<BannerImage> {
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO banner_images
         (id, tenant_id, project_id, generation_id, media_id, sequence, source, parent_image_id,
          is_favorite, deleted_at, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)`,
    )
    .bind(
      id,
      input.tenantId,
      input.projectId,
      input.generationId,
      input.mediaId,
      input.sequence,
      input.source,
      input.parentImageId ?? null,
      input.createdBy ?? null,
      jstNow(),
    )
    .run();
  return (await getBannerImage(db, id, input.tenantId))!;
}

export async function getBannerImage(
  db: D1Database,
  id: string,
  tenantId: string,
): Promise<BannerImage | null> {
  return db
    .prepare('SELECT * FROM banner_images WHERE id = ? AND tenant_id = ?')
    .bind(id, tenantId)
    .first<BannerImage>();
}

export async function updateBannerImage(
  db: D1Database,
  id: string,
  tenantId: string,
  patch: { isFavorite?: boolean; deleted?: boolean; projectId?: string; folderId?: string | null },
): Promise<BannerImage | null> {
  const folderId=await readHqBannerFolderAssignment(db,tenantId,'image',patch.folderId);
  const sets: string[] = [];
  const values: unknown[] = [];
  if (folderId !== undefined) { sets.push('folder_id = ?'); values.push(folderId); }
  if (patch.isFavorite !== undefined) { sets.push('is_favorite = ?'); values.push(patch.isFavorite ? 1 : 0); }
  if (patch.deleted !== undefined) { sets.push('deleted_at = ?'); values.push(patch.deleted ? jstNow() : null); }
  if (patch.projectId !== undefined) { sets.push('project_id = ?'); values.push(patch.projectId); }
  if (sets.length === 0) return getBannerImage(db, id, tenantId);
  values.push(id, tenantId);
  await db
    .prepare(`UPDATE banner_images SET ${sets.join(', ')} WHERE id = ? AND tenant_id = ?`)
    .bind(...values)
    .run();
  return getBannerImage(db, id, tenantId);
}

export interface BannerImageListFilter {
  folderId?: string | null;
  tenantId: string;
  delivered?: boolean;
  projectId?: string;
  favoriteOnly?: boolean;
  presetKey?: string;
  shape?: 'square' | 'landscape' | 'portrait' | 'rich_menu';
  /** テキスト行・プロンプト・追加指示の部分一致。 */
  query?: string;
  limit?: number;
  /** created_at のこの値より古いものだけ（無限スクロール用）。 */
  before?: string;
}

function bannerImageConditions(filter: BannerImageListFilter) {
  const conditions = ['i.tenant_id = ?', 'i.deleted_at IS NULL'];
  const values: unknown[] = [filter.tenantId];
  if (filter.folderId !== undefined) { conditions.push(filter.folderId === null ? 'i.folder_id IS NULL' : 'i.folder_id = ?'); if (filter.folderId !== null) values.push(filter.folderId); }
  if (filter.projectId) { conditions.push('i.project_id = ?'); values.push(filter.projectId); }
  if (filter.favoriteOnly) conditions.push('i.is_favorite = 1');
  if (filter.delivered !== undefined) conditions.push(`${filter.delivered ? '' : 'NOT '}EXISTS (
    SELECT 1 FROM banner_image_deliveries d WHERE d.banner_image_id = i.id
  )`);
  if (filter.presetKey) { conditions.push('g.preset_key = ?'); values.push(filter.presetKey); }
  if (filter.query) {
    conditions.push('(g.text_lines LIKE ? OR g.final_prompt LIKE ? OR g.custom_prompt LIKE ? OR g.free_prompt LIKE ? OR m.filename LIKE ? OR p.name LIKE ?)');
    const like = `%${filter.query}%`;
    values.push(like, like, like, like, like, like);
  }
  if (filter.shape === 'rich_menu') conditions.push("g.preset_key LIKE 'line_rich_menu%'");
  else if (filter.shape) {
    conditions.push("g.preset_key NOT LIKE 'line_rich_menu%' AND g.api_size = ?");
    values.push(filter.shape === 'square' ? '1024x1024' : filter.shape === 'landscape' ? '1536x1024' : '1024x1536');
  }
  return { conditions, values };
}

export async function countBannerImages(db: D1Database, filter: BannerImageListFilter) {
  const { conditions, values } = bannerImageConditions({ ...filter, favoriteOnly: false, delivered: undefined });
  const row = await db.prepare(`SELECT COUNT(*) AS all_count, COALESCE(SUM(i.is_favorite),0) AS favorite,
    COALESCE(SUM(EXISTS(SELECT 1 FROM banner_image_deliveries d WHERE d.banner_image_id=i.id)),0) AS delivered
    FROM banner_images i JOIN media m ON m.id=i.media_id
    JOIN banner_projects p ON p.id=i.project_id AND p.tenant_id=i.tenant_id
    LEFT JOIN banner_generations g ON g.id=i.generation_id
    WHERE ${conditions.join(' AND ')}`).bind(...values).first<{ all_count: number; favorite: number; delivered: number }>();
  return { all: row?.all_count ?? 0, favorite: row?.favorite ?? 0, delivered: row?.delivered ?? 0, unused: (row?.all_count ?? 0) - (row?.delivered ?? 0) };
}

/** 画像一覧。media と生成条件を一緒に返す。 */
export async function listBannerImages(
  db: D1Database,
  filter: BannerImageListFilter,
): Promise<BannerImageWithDetail[]> {
  const { conditions, values } = bannerImageConditions(filter);
  if (filter.before) {
    if (filter.before.startsWith('{')) {
      const cursor = JSON.parse(filter.before) as { at: string; id: string };
      conditions.push('(i.created_at < ? OR (i.created_at = ? AND i.id < ?))');
      values.push(cursor.at, cursor.at, cursor.id);
    } else { conditions.push('i.created_at < ?'); values.push(filter.before); }
  }
  const limit = Math.min(Math.max(filter.limit ?? 30, 1), 100);
  values.push(limit);

  const rows = await db
    .prepare(
      `SELECT i.*,
              m.id AS m_id, m.line_account_id AS m_line_account_id, m.folder_id AS m_folder_id,
              m.kind AS m_kind, m.filename AS m_filename, m.mime_type AS m_mime_type,
              m.size_bytes AS m_size_bytes, m.width AS m_width, m.height AS m_height,
              m.duration_ms AS m_duration_ms, m.r2_key AS m_r2_key, m.public_url AS m_public_url,
              m.uploaded_by AS m_uploaded_by, m.created_at AS m_created_at,
              g.id AS g_id, g.status AS g_status, g.mode AS g_mode, g.preset_key AS g_preset_key,
              g.aspect_ratio AS g_aspect_ratio, g.api_size AS g_api_size, g.quality AS g_quality,
              g.text_lines AS g_text_lines, g.emphasis_lines AS g_emphasis_lines, g.base_color AS g_base_color,
              g.main_color AS g_main_color, g.sub_color AS g_sub_color, g.accent_color AS g_accent_color,
              g.person_option AS g_person_option, g.custom_prompt AS g_custom_prompt,
              g.free_prompt AS g_free_prompt, g.final_prompt AS g_final_prompt, g.engine AS g_engine,
              g.model_name AS g_model_name, g.requested_count AS g_requested_count,
              g.done_count AS g_done_count, g.failed_count AS g_failed_count,
              g.units_per_image AS g_units_per_image, g.error_message AS g_error_message,
              g.created_by AS g_created_by, g.created_at AS g_created_at, g.started_at AS g_started_at,
              g.finished_at AS g_finished_at, g.reference_images AS g_reference_images,
              g.reference_image_id AS g_reference_image_id, g.reference_mode AS g_reference_mode,
              g.tenant_id AS g_tenant_id, g.project_id AS g_project_id,
              (SELECT GROUP_CONCAT(d.line_account_id) FROM banner_image_deliveries d
                WHERE d.banner_image_id = i.id) AS delivered_ids
         FROM banner_images i
         JOIN media m ON m.id = i.media_id
         LEFT JOIN banner_generations g ON g.id = i.generation_id
         JOIN banner_projects p ON p.id = i.project_id AND p.tenant_id = i.tenant_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY i.created_at DESC, i.id DESC
        LIMIT ?`,
    )
    .bind(...values)
    .all<Record<string, unknown>>();
  return rows.results.map(rowToImageWithDetail);
}

export async function getBannerImageWithDetail(
  db: D1Database,
  id: string,
  tenantId: string,
): Promise<BannerImageWithDetail | null> {
  const rows = await listBannerImagesById(db, [id], tenantId);
  return rows[0] ?? null;
}

async function listBannerImagesById(
  db: D1Database,
  ids: string[],
  tenantId: string,
): Promise<BannerImageWithDetail[]> {
  if (ids.length === 0) return [];
  const placeholders = sqlIdSet(ids).sql;
  const rows = await db
    .prepare(
      `SELECT i.*,
              m.id AS m_id, m.line_account_id AS m_line_account_id, m.folder_id AS m_folder_id,
              m.kind AS m_kind, m.filename AS m_filename, m.mime_type AS m_mime_type,
              m.size_bytes AS m_size_bytes, m.width AS m_width, m.height AS m_height,
              m.duration_ms AS m_duration_ms, m.r2_key AS m_r2_key, m.public_url AS m_public_url,
              m.uploaded_by AS m_uploaded_by, m.created_at AS m_created_at,
              g.id AS g_id, g.status AS g_status, g.mode AS g_mode, g.preset_key AS g_preset_key,
              g.aspect_ratio AS g_aspect_ratio, g.api_size AS g_api_size, g.quality AS g_quality,
              g.text_lines AS g_text_lines, g.emphasis_lines AS g_emphasis_lines, g.base_color AS g_base_color,
              g.main_color AS g_main_color, g.sub_color AS g_sub_color, g.accent_color AS g_accent_color,
              g.person_option AS g_person_option, g.custom_prompt AS g_custom_prompt,
              g.free_prompt AS g_free_prompt, g.final_prompt AS g_final_prompt, g.engine AS g_engine,
              g.model_name AS g_model_name, g.requested_count AS g_requested_count,
              g.done_count AS g_done_count, g.failed_count AS g_failed_count,
              g.units_per_image AS g_units_per_image, g.error_message AS g_error_message,
              g.created_by AS g_created_by, g.created_at AS g_created_at, g.started_at AS g_started_at,
              g.finished_at AS g_finished_at, g.reference_images AS g_reference_images,
              g.reference_image_id AS g_reference_image_id, g.reference_mode AS g_reference_mode,
              g.tenant_id AS g_tenant_id, g.project_id AS g_project_id,
              (SELECT GROUP_CONCAT(d.line_account_id) FROM banner_image_deliveries d
                WHERE d.banner_image_id = i.id) AS delivered_ids
         FROM banner_images i
         JOIN media m ON m.id = i.media_id
         LEFT JOIN banner_generations g ON g.id = i.generation_id
         JOIN banner_projects p ON p.id = i.project_id AND p.tenant_id = i.tenant_id
        WHERE i.tenant_id = ? AND i.id IN (${placeholders})`,
    )
    .bind(tenantId, ...(ids.length ? sqlIdSet(ids).binds : []))
    .all<Record<string, unknown>>();
  return rows.results.map(rowToImageWithDetail);
}

function rowToImageWithDetail(row: Record<string, unknown>): BannerImageWithDetail {
  const pick = (prefix: string) => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      if (key.startsWith(prefix)) out[key.slice(prefix.length)] = value;
    }
    return out;
  };
  const base: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (!key.startsWith('m_') && !key.startsWith('g_') && key !== 'delivered_ids') base[key] = value;
  }
  const media = pick('m_') as unknown as Media;
  const generationRaw = pick('g_');
  const generation = generationRaw.id ? (generationRaw as unknown as BannerGeneration) : null;
  const delivered = typeof row.delivered_ids === 'string' && row.delivered_ids
    ? row.delivered_ids.split(',')
    : [];
  return {
    ...(base as unknown as BannerImage),
    media,
    generation,
    delivered_account_ids: delivered,
  };
}

// -------------------------------------------------------------- deliveries

export async function createBannerImageDelivery(
  db: D1Database,
  input: { bannerImageId: string; lineAccountId: string; mediaId: string; deliveredBy?: string | null },
): Promise<BannerImageDelivery> {
  const id = crypto.randomUUID();
  const now = jstNow();
  await db
    .prepare(
      `INSERT INTO banner_image_deliveries
         (id, banner_image_id, line_account_id, media_id, delivered_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, input.bannerImageId, input.lineAccountId, input.mediaId, input.deliveredBy ?? null, now)
    .run();
  return {
    id,
    banner_image_id: input.bannerImageId,
    line_account_id: input.lineAccountId,
    media_id: input.mediaId,
    delivered_by: input.deliveredBy ?? null,
    created_at: now,
  };
}

export async function getBannerImageDelivery(
  db: D1Database,
  bannerImageId: string,
  lineAccountId: string,
): Promise<BannerImageDelivery | null> {
  return db
    .prepare('SELECT * FROM banner_image_deliveries WHERE banner_image_id = ? AND line_account_id = ?')
    .bind(bannerImageId, lineAccountId)
    .first<BannerImageDelivery>();
}

// -------------------------------------------------------------------- stats

export interface BannerStats {
  projects: { active: number; archived: number };
  /** 店舗へ渡した画像の数（同じ画像を複数店舗へ渡しても1と数える）。 */
  deliveredImages: number;
  /** 渡した先の店舗の数（重複なし）。 */
  deliveredAccounts: number;
}

/** 数値カード帯に出す数。プロジェクト数と、店舗へ渡した画像・店舗の数。 */
export async function getBannerStats(db: D1Database, tenantId: string): Promise<BannerStats> {
  const [projects, deliveries] = await Promise.all([
    db
      .prepare(
        `SELECT
           SUM(CASE WHEN archived_at IS NULL THEN 1 ELSE 0 END) AS active,
           SUM(CASE WHEN archived_at IS NOT NULL THEN 1 ELSE 0 END) AS archived
         FROM banner_projects WHERE tenant_id = ?`,
      )
      .bind(tenantId)
      .first<{ active: number | null; archived: number | null }>(),
    db
      .prepare(
        `SELECT
           COUNT(DISTINCT d.banner_image_id) AS images,
           COUNT(DISTINCT d.line_account_id) AS accounts
         FROM banner_image_deliveries d
         JOIN banner_images i ON i.id = d.banner_image_id
        WHERE i.tenant_id = ?`,
      )
      .bind(tenantId)
      .first<{ images: number | null; accounts: number | null }>(),
  ]);
  return {
    projects: { active: Number(projects?.active ?? 0), archived: Number(projects?.archived ?? 0) },
    deliveredImages: Number(deliveries?.images ?? 0),
    deliveredAccounts: Number(deliveries?.accounts ?? 0),
  };
}
