import { buildCursorListResponse, listQueryNumber } from '../lib/list-paging.js';
import { checkMediaGate } from '../services/file-scan.js';
import { getPinnedMediaObject } from '../services/media-upload-storage.js';
import {serializeProject,parseTextLines,parseEmphasisLines,serializeGeneration,serializeMedia,serializeImage} from './hq-banner-serializers.js';
import {GapError,gapAccount,gapWrite} from '../services/gap-common.js';
import {requireAccountAi} from '../services/account-ai-features.js';
import { folderInputError, inputError, inputJsonBoundary } from '../lib/input-errors.js';
import { hqBannerFolders } from './hq-banner-folders.js';
import { processBannerGeneration, BannerJobFailure } from '../services/banner-jobs.js';
import { bannerGenerationOperationId, bannerGenerationRequestMatches } from '../services/banner-generation-retry.js';
import { Hono, type Context } from 'hono';
import {
  getWorkflowStep,
  HqFolderError,
  bannerReferencesFromRow,
  createBannerGeneration,
  createBannerImage,
  createBannerImageDelivery,
  createBannerProject,
  createMedia,
  getBannerGeneration,
  getBannerImage,
  getBannerImageDelivery,
  getBannerImageWithDetail,
  getBannerProject,
  getBannerStats,
  getBannerUsageThisMonth,
  getBannerUsageToday,
  getTenantBilling,
  countRecentFailedBannerGenerations,
  listBannerGenerations,
  listBannerImages,
  countBannerImages,
  listBannerProjects,
  recordBannerUsage,
  touchBannerProject,
  updateBannerGenerationProgress,
  updateBannerImage,
  updateBannerProject,
  type BannerGeneration,
  type BannerImageWithDetail,
  type BannerProject,
  type Media,
} from '@line-crm/db';
import { toJstString } from '@line-crm/db';


import { DEFAULT_TENANT_ID } from '@line-crm/shared';
import type { Env } from '../worker-env.js';
import { requireRole } from '../middleware/role-guard.js';
import { canAccessAllLineAccounts } from '../services/account-access.js';
import { resolveTenantEntitlements } from '../services/billing-plans.js';
import {
  BANNER_MAX_COUNT,
  BANNER_PRESETS,
  buildBannerPrompt,
  findBannerPreset,
  resolveBannerQuality,
  validateBannerRequest,
} from '../services/banner-prompt.js';
import {
  resolveBannerCropPosition,
  resizeBannerToPreset,
} from '../services/banner-resize.js';

import {
  DEFAULT_OPENAI_IMAGE_MODEL,
  generateOpenAIImage,
  OpenAIImageError,
  type OpenAIReferenceImage,
} from '../services/openai-images.js';

/**
 * 統括の「バナー生成」。
 *
 * 画像はここで作って統括の登録メディアに保存し、必要な店舗へ「渡す」。
 * 渡した先では店舗の登録メディアとして見えるので、配信やリッチメニューから
 * そのまま選べる。
 */
export const hqBanners = new Hono<Env>();

/**
 * 利用上限は「枚数」だけで数える。クレジットや品質の選択は運用者に見せない。
 * 月の上限は当面この環境変数で、料金プラン導入後はプランの値に置き換える。
 * 1日の上限は月の 1/5、一度に作れるのは 4 枚まで、短時間に失敗が続いたら自動で一時停止する。
 */
const DEFAULT_MONTHLY_IMAGES = 150;
const DAILY_DIVISOR = 5;
const AUTO_PAUSE_FAILURES = 3;
const AUTO_PAUSE_WINDOW_MS = 15 * 60 * 1000;
const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

/** 参照画像が実行時に見つからない（一覧から外された・実体が消えた）。 */
class ReferenceMissingError extends Error {
  constructor() {
    super('参照画像が見つかりません。ライブラリから選び直してください');
    this.name = 'ReferenceMissingError';
  }
}
const UPLOAD_ALLOWED: Record<string, { ext: string }> = {
  'image/png': { ext: 'png' },
  'image/jpeg': { ext: 'jpg' },
  'image/webp': { ext: 'webp' },
};

hqBanners.use('/api/hq/banners/*', requireRole('owner', 'admin'));
hqBanners.route('/',hqBannerFolders);
hqBanners.use('/api/hq/banners/*',async(c,next)=>{
 if(c.req.method!=='POST'||!(/\/projects\/[^/]+\/generations$/.test(c.req.path)||/\/generations\/[^/]+\/run$/.test(c.req.path)))return next();
 try{
  gapWrite(c,{admin:true});
  const a=await gapAccount(c);await requireAccountAi(c.env.DB,a,'banner',tenantOf(c));
  if(/\/run$/.test(c.req.path)){const g=await getBannerGeneration(c.env.DB,c.req.path.split('/').at(-2)!,tenantOf(c));if(g&&g.ai_account_id!==a)throw new GapError('not_found',404);}
 }catch(e){if(e instanceof GapError)return c.json({success:false,error:e.code,code:e.code,data:{enabled:false,feature:'banner'}},e.status);throw e;}
 return next();
});

function tenantOf(c: Context<Env>): string {
  return c.get('staff')?.tenantId ?? DEFAULT_TENANT_ID;
}

function workerUrl(c: Context<Env>): string {
  return c.env.WORKER_URL || new URL(c.req.url).origin;
}

/**
 * 課金対象外（運営）の統括の月間上限。`BANNER_MONTHLY_IMAGES` で上書きできる。
 * 契約中・トライアル中の統括はプランの値を使う（`resolveEntitlements`）。
 */
function exemptMonthlyImages(c: Context<Env>): number {
  const raw = Number(c.env.BANNER_MONTHLY_IMAGES ?? '');
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MONTHLY_IMAGES;
}

async function tenantEntitlements(c: Context<Env>, tenantId: string) {
  const billing = await getTenantBilling(c.env.DB, tenantId).catch(() => null);
  return resolveTenantEntitlements(c.env.DB, billing, { exemptMonthlyImages: exemptMonthlyImages(c) });
}

type UsageSnapshot = {
  month: { used: number; limit: number; remaining: number };
  today: { used: number; limit: number; remaining: number };
  paused: boolean;
  pausedReason: string | null;
  /** 課金の状態で止まっているとき（トライアル終了・解約）。理由は blockedReason。 */
  blocked: boolean;
  blockedReason: string | null;
  planState: string;
};

async function usageSnapshot(c: Context<Env>, tenantId: string): Promise<UsageSnapshot> {
  const [usedMonth, usedToday, recentFailures, entitlements] = await Promise.all([
    getBannerUsageThisMonth(c.env.DB, tenantId),
    getBannerUsageToday(c.env.DB, tenantId),
    countRecentFailedBannerGenerations(c.env.DB, tenantId, toJstString(new Date(Date.now() - AUTO_PAUSE_WINDOW_MS))),
    tenantEntitlements(c, tenantId),
  ]);
  const monthLimit = entitlements.monthlyImages;
  const dayLimit = Math.max(1, Math.ceil(monthLimit / DAILY_DIVISOR));
  const paused = recentFailures >= AUTO_PAUSE_FAILURES;
  return {
    month: { used: usedMonth, limit: monthLimit, remaining: Math.max(monthLimit - usedMonth, 0) },
    today: { used: usedToday, limit: dayLimit, remaining: Math.max(dayLimit - usedToday, 0) },
    paused,
    blocked: !entitlements.canGenerate,
    blockedReason: entitlements.blockedReason,
    planState: entitlements.state,
    pausedReason: paused ? '短時間に生成の失敗が続いたため、15分ほど生成を止めています。時間をおいてからお試しください' : null,
  };
}

/** 生成を受け付けられないときは理由を返す。受け付けられるときは null。 */
function refusal(usage: UsageSnapshot, needed: number): string | null {
  if (usage.blocked) return usage.blockedReason;
  if (usage.paused) return usage.pausedReason;
  if (needed > usage.month.remaining) {
    return `今月の生成上限（${usage.month.limit}枚）に達します（残り ${usage.month.remaining}枚、必要 ${needed}枚）。枚数を減らすか、来月までお待ちください`;
  }
  if (needed > usage.today.remaining) {
    return `今日の生成上限（1日 ${usage.today.limit}枚）に達します（残り ${usage.today.remaining}枚、必要 ${needed}枚）。明日以降にお試しください`;
  }
  return null;
}







async function readJson(c: Context<Env>): Promise<Record<string, unknown> | null> {
  return c.req.json<Record<string, unknown>>().catch(() => null);
}

function hasImageSignature(bytes: Uint8Array, mimeType: string): boolean {
  if (mimeType === 'image/png') {
    return bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  }
  if (mimeType === 'image/jpeg') {
    return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (mimeType === 'image/webp') {
    return bytes.length > 12
      && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
      && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
  }
  return false;
}

function sizeToDimensions(apiSize: string): { width: number | null; height: number | null } {
  const match = /^(\d+)x(\d+)$/.exec(apiSize);
  if (!match) return { width: null, height: null };
  return { width: Number(match[1]), height: Number(match[2]) };
}

function safeFilenameBase(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\0-]/g, '').trim();
  return (cleaned || 'banner').slice(0, 40);
}

// ================================================================ presets

hqBanners.get('/api/hq/banners/presets', async (c) => {
  const usage = await usageSnapshot(c, tenantOf(c));
  return c.json({
    success: true,
    data: {
      presets: BANNER_PRESETS.map((p) => ({
        key: p.key,
        group: p.group,
        label: p.label,
        note: p.note,
        aspectRatio: p.aspectRatio,
        apiSize: p.apiSize,
        targetWidth: p.targetWidth,
        targetHeight: p.targetHeight,
      })),
      maxCount: BANNER_MAX_COUNT,
      usage,
      engineReady: Boolean(c.env.OPENAI_API_KEY),
    },
  });
});

hqBanners.get('/api/hq/banners/usage', async (c) => {
  const usage = await usageSnapshot(c, tenantOf(c));
  return c.json({ success: true, data: usage });
});

hqBanners.get('/api/hq/banners/stats', async (c) => {
  try {
    const stats = await getBannerStats(c.env.DB, tenantOf(c));
    return c.json({ success: true, data: stats });
  } catch (err) {
    throw err;
  }
});

// =============================================================== projects

hqBanners.get('/api/hq/banners/projects', async (c) => {
  try {
    const archived = c.req.query('archived') === '1';
    const query = c.req.query('q')?.trim() || undefined;
    const items = await listBannerProjects(c.env.DB, { tenantId: tenantOf(c), archived, query, folderId: c.req.query('folderId') === '__none__' ? null : c.req.query('folderId') });
    return c.json({ success: true, data: items.map(serializeProject) });
  } catch (err) {
    throw err;
  }
});

hqBanners.post('/api/hq/banners/projects', inputJsonBoundary(), async (c) => {
  try {
    const body = await readJson(c);
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 100) {
      return inputError(c, { success: false, error: 'プロジェクト名は1〜100文字で入力してください' }, 400, ["name"]);
    }
    const description = typeof body?.description === 'string' ? body.description.trim().slice(0, 500) : '';
    const project = await createBannerProject(c.env.DB, {
      tenantId: tenantOf(c),
      name,
      description,
      createdBy: c.get('staff')?.id ?? null,
      folderId: body?.folderId as string | null | undefined,
    });
    return c.json({ success: true, data: serializeProject(project) }, 201);
  } catch (err) {
    if(err instanceof HqFolderError)return folderInputError(c, err);
    throw err;
  }
});

hqBanners.get('/api/hq/banners/projects/:id', async (c) => {
  try {
    const tenantId = tenantOf(c);
    const project = await getBannerProject(c.env.DB, c.req.param('id'), tenantId);
    if (!project) return c.json({ success: false, error: 'プロジェクトが見つかりません' }, 404);
    const [images, generations] = await Promise.all([
      listBannerImages(c.env.DB, { tenantId, projectId: project.id, limit: 100 }),
      listBannerGenerations(c.env.DB, project.id, tenantId),
    ]);
    const base = workerUrl(c);
    return c.json({
      success: true,
      data: {
        project: serializeProject(project),
        images: images.map((i) => serializeImage(i, base)),
        generations: generations.map(serializeGeneration),
      },
    });
  } catch (err) {
    throw err;
  }
});

hqBanners.patch('/api/hq/banners/projects/:id', inputJsonBoundary(), async (c) => {
  try {
    const tenantId = tenantOf(c);
    const body = await readJson(c);
    const patch: { name?: string; description?: string; isFavorite?: boolean; archived?: boolean; folderId?: string | null } = {};
    if (body && 'folderId' in body) patch.folderId = body.folderId as string | null;
    if (typeof body?.name === 'string') {
      const name = body.name.trim();
      if (!name || name.length > 100) {
        return inputError(c, { success: false, error: 'プロジェクト名は1〜100文字で入力してください' }, 400, ["name"]);
      }
      patch.name = name;
    }
    if (typeof body?.description === 'string') patch.description = body.description.trim().slice(0, 500);
    if (typeof body?.isFavorite === 'boolean') patch.isFavorite = body.isFavorite;
    if (typeof body?.archived === 'boolean') patch.archived = body.archived;
    const project = await updateBannerProject(c.env.DB, c.req.param('id'), tenantId, patch);
    if (!project) return c.json({ success: false, error: 'プロジェクトが見つかりません' }, 404);
    return c.json({ success: true, data: serializeProject(project) });
  } catch (err) {
    if(err instanceof HqFolderError)return folderInputError(c, err);
    throw err;
  }
});

hqBanners.post('/api/hq/banners/projects/:id/duplicate', inputJsonBoundary(), async (c) => {
  try {
    const tenantId = tenantOf(c);
    const source = await getBannerProject(c.env.DB, c.req.param('id'), tenantId);
    if (!source) return c.json({ success: false, error: 'プロジェクトが見つかりません' }, 404);
    const staffId = c.get('staff')?.id ?? null;
    const copy = await createBannerProject(c.env.DB, {
      tenantId,
      name: `${source.name} のコピー`.slice(0, 100),
      description: source.description,
      createdBy: staffId,
    });
    const images = await listBannerImages(c.env.DB, { tenantId, projectId: source.id, limit: 100 });
    for (const image of images) {
      await createBannerImage(c.env.DB, {
        tenantId,
        projectId: copy.id,
        generationId: image.generation_id,
        mediaId: image.media_id,
        sequence: image.sequence,
        source: image.source,
        parentImageId: image.id,
        createdBy: staffId,
      });
    }
    const refreshed = await getBannerProject(c.env.DB, copy.id, tenantId);
    return c.json({ success: true, data: serializeProject(refreshed ?? copy) }, 201);
  } catch (err) {
    throw err;
  }
});

// ============================================================ generations

hqBanners.post('/api/hq/banners/projects/:id/generations', inputJsonBoundary(), async (c) => {
  try {
    const tenantId = tenantOf(c);
    const project = await getBannerProject(c.env.DB, c.req.param('id'), tenantId);
    if (!project) return c.json({ success: false, error: 'プロジェクトが見つかりません' }, 404);
    const key = c.req.header('Idempotency-Key');
    if (key !== undefined && (!key.trim() || key.length > 200 || /[^\x21-\x7e]/.test(key))) {
      return inputError(c, { success: false, error: 'Idempotency-Key is invalid' }, 400, []);
    }
    const requestBody=await readJson(c);
    const crop=resolveBannerCropPosition(requestBody?.cropPosition ?? requestBody?.gravity);
    if(!crop)return inputError(c, {success:false,error:'切り抜きの位置は中央・上・下から選んでください'}, 400, ["cropPosition"]);
    const validation = validateBannerRequest(requestBody);
    if (!validation.ok || !validation.value) {
      return inputError(c, { success: false, error: validation.error, field: validation.field }, 400, []);
    }
    const v = validation.value;
    const operationId = key ? await bannerGenerationOperationId(tenantId, project.id, key) : undefined;
    if (operationId) {
      const previous = await getBannerGeneration(c.env.DB, operationId, tenantId);
      if (previous) {
        if (previous.ai_account_id!==c.req.query('account_id') || !bannerGenerationRequestMatches(previous, v) || (previous.crop_gravity ?? 'center')!==crop) {
          return c.json({ success: false, code: 'idempotency_conflict', error: '同じ操作キーで生成条件が変わっています' }, 409);
        }
        return c.json({ success: true, data: serializeGeneration(previous) }, 201);
      }
    }
    if (project.archived_at) {
      return c.json({ success: false, error: 'アーカイブ済みのプロジェクトでは生成できません。復元してからお試しください' }, 409);
    }
    if (!c.env.OPENAI_API_KEY) {
      return c.json({ success: false, error: '画像生成の接続設定がまだありません。運営にお問い合わせください' }, 503);
    }

    const usage = await usageSnapshot(c, tenantId);
    const refused = refusal(usage, v.count);
    if (refused) {
      return c.json({ success: false, error: refused, data: { usage, needed: v.count } }, 409);
    }
    const quality = resolveBannerQuality(c.env.BANNER_IMAGE_QUALITY);

    // 参照画像はこの統括のライブラリにある、消していない画像だけ（最大3枚）。
    for (const entry of v.references) {
      const reference = await getBannerImageWithDetail(c.env.DB, entry.imageId, tenantId);
      if (!reference || reference.deleted_at) {
        return inputError(c, { success: false, error: '参照画像が見つかりません。ライブラリから選び直してください' }, 400, ["referenceImageId"]);
      }
      if (!(reference.media.mime_type in UPLOAD_ALLOWED)) {
        return inputError(c, { success: false, error: '参照画像は PNG・JPEG・WebP の画像だけ使えます' }, 400, ["referenceImageId"]);
      }
    }

    const finalPrompt = buildBannerPrompt({
      mode: v.mode,
      preset: v.preset,
      references: v.references,
      textLines: v.textLines,
      emphasisLines: v.emphasisLines,
      baseColor: v.baseColor,
      mainColor: v.mainColor,
      subColor: v.subColor,
      accentColor: v.accentColor,
      personOption: v.personOption,
      customPrompt: v.customPrompt,
      freePrompt: v.freePrompt,
    });
    const generation = await createBannerGeneration(c.env.DB, {
      operationId,
      aiAccountId:c.req.query('account_id'),
      tenantId,
      projectId: project.id,
      mode: v.mode,
      presetKey: v.preset.key,
      aspectRatio: v.preset.aspectRatio,
      apiSize: v.preset.apiSize,
      quality,
      textLines: v.textLines,
      emphasisLines: v.emphasisLines,
      baseColor: v.baseColor,
      mainColor: v.mainColor,
      subColor: v.subColor,
      accentColor: v.accentColor,
      personOption: v.personOption,
      customPrompt: v.customPrompt,
      freePrompt: v.freePrompt,
      finalPrompt,
      engine: 'openai',
      modelName: c.env.OPENAI_IMAGE_MODEL || DEFAULT_OPENAI_IMAGE_MODEL,
      requestedCount: v.count,
      unitsPerImage: 1,
      cropGravity: crop,
      references: v.references,
      createdBy: c.get('staff')?.id ?? null,
    });
    // 同時要求は主キーを共有し、最初に確定した選択を正本として保つ。
    if (operationId && (generation.ai_account_id!==c.req.query('account_id') || !bannerGenerationRequestMatches(generation, v) || (generation.crop_gravity ?? 'center')!==crop)) {
      return c.json({ success: false, code: 'idempotency_conflict', error: '同じ操作キーで生成条件が変わっています' }, 409);
    }
    await touchBannerProject(c.env.DB, project.id);
    return c.json({ success: true, data: serializeGeneration(generation) }, 201);
  } catch (err) {
    throw err;
  }
});

hqBanners.get('/api/hq/banners/generations/:id', async (c) => {
  const generation = await getBannerGeneration(c.env.DB, c.req.param('id'), tenantOf(c));
  if (!generation) return c.json({ success: false, error: '生成が見つかりません' }, 404);
  return c.json({ success: true, data: serializeGeneration(generation) });
});

/** 生成の実行権は cron と共有する。新しいクライアントは GET のポーリングだけを使い、この入口は互換用に残す。 */
hqBanners.post('/api/hq/banners/generations/:id/run',inputJsonBoundary(), async(c)=>{
  const tenantId=tenantOf(c),id=c.req.param('id');
  const generation=await getBannerGeneration(c.env.DB,id,tenantId);
  if(!generation)return c.json({success:false,error:'生成が見つかりません'},404);
  const body=await readJson(c),crop=resolveBannerCropPosition(body?.gravity);
  if(!crop)return inputError(c, {success:false,error:'切り抜きの位置は中央・上・下から選んでください'}, 400, ["gravity"]);
  if(body?.gravity!==undefined && crop!==(generation.crop_gravity ?? 'center')) {
    const changed=await c.env.DB.prepare(`UPDATE banner_generations SET crop_gravity=? WHERE id=? AND tenant_id=? AND started_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM workflow_steps WHERE scope_id=? AND process_kind='banner_generation' AND subject_id=? AND step_key='__run' AND first_attempt_at IS NOT NULL)`)
      .bind(crop,id,tenantId,`tenant:${tenantId}`,id).run();
    if(changed.meta.changes!==1)return c.json({success:false,error:'生成開始後は切り抜きの位置を変更できません'},409);
  }
  let imageId:string|null;
  try{imageId=await processBannerGeneration(c.env,id,tenantId);}
  catch(error){
    const latest=await getBannerGeneration(c.env.DB,id,tenantId);
    const status=error instanceof BannerJobFailure?error.status:502;
    return inputError(c, {success:false,error:error instanceof BannerJobFailure?error.message:'画像の保存に失敗しました。もう一度お試しください',
      data:{generation:serializeGeneration(latest!),image:null,finished:!!latest && !['queued','running'].includes(latest.status)}}, status as 400|422|502, []);
  }
  const latest=await getBannerGeneration(c.env.DB,id,tenantId);
  const image=imageId?await getBannerImageWithDetail(c.env.DB,imageId,tenantId):null;
  const finished=!!latest && !['queued','running'].includes(latest.status);
  const slot=image?await getWorkflowStep(c.env.DB,{scopeId:`tenant:${tenantId}`,processKind:'banner_generation',subjectId:id,stepKey:`image:${image.sequence}`}):null;
  const resized=slot?.result_json?JSON.parse(slot.result_json).resized:undefined;
  const preset=latest?findBannerPreset(latest.preset_key):null;
  return c.json({success:latest?.status!=='failed',error:latest?.error_message ?? undefined,
    data:{generation:serializeGeneration(latest!),image:image?serializeImage(image,workerUrl(c)):null,finished,resized,targetWidth:preset?.targetWidth ?? image?.media.width,targetHeight:preset?.targetHeight ?? image?.media.height}});
});
hqBanners.post('/api/hq/banners/generations/:id/cancel',inputJsonBoundary(), async(c)=>{
  const tenantId=tenantOf(c),id=c.req.param('id');
  const generation=await getBannerGeneration(c.env.DB,id,tenantId);
  if(!generation)return c.json({success:false,error:'生成が見つかりません'},404);
  await c.env.DB.prepare(`UPDATE banner_generations SET stop_requested_at=COALESCE(stop_requested_at,?),status='canceled',finished_at=?
    WHERE id=? AND tenant_id=? AND status IN ('queued','running')`).bind(toJstString(new Date()),toJstString(new Date()),id,tenantId).run();
  return c.json({success:true,data:serializeGeneration((await getBannerGeneration(c.env.DB,id,tenantId))!)});
});

// ================================================================= images

hqBanners.get('/api/hq/banners/images', async (c) => {
  try {
    const tenantId = tenantOf(c);
    const delivered = c.req.query('delivered');
    if (delivered !== undefined && delivered !== '1' && delivered !== '0') {
      return c.json({ success: false, error: 'delivered は 1 または 0 を指定してください' }, 400);
    }
    const shape = c.req.query('shape');
    if (shape && !['square', 'landscape', 'portrait', 'rich_menu'].includes(shape)) return c.json({ success: false, error: '用途の指定を確認してください' }, 400);
    const before = c.req.query('before')?.trim() || undefined;
    if (before?.startsWith('{')) {
      try { const cursor = JSON.parse(before); if (typeof cursor.at !== 'string' || typeof cursor.id !== 'string' || !cursor.id || !Number.isFinite(Date.parse(cursor.at))) throw new Error(); }
      catch { return c.json({ success: false, error: '読み込み位置を確認してください' }, 400); }
    }
    const limitRaw = listQueryNumber(c.req.query('limit'), '30');
    const filter = {
      tenantId,
      delivered: delivered === undefined ? undefined : delivered === '1',
      shape: shape as 'square' | 'landscape' | 'portrait' | 'rich_menu' | undefined,
      projectId: c.req.query('projectId')?.trim() || undefined,
      folderId: c.req.query('folderId') === '__none__' ? null : c.req.query('folderId'),
      favoriteOnly: c.req.query('favorite') === '1',
      presetKey: c.req.query('preset')?.trim() || undefined,
      query: c.req.query('q')?.trim() || undefined,
      before,
      limit: Number.isFinite(limitRaw) ? Math.min(100, Math.max(1, Math.floor(limitRaw))) : 30,
    };
    const items = await listBannerImages(c.env.DB, filter);
    const counts = c.req.query('withCounts') === '1' ? await countBannerImages(c.env.DB, filter) : undefined;
    const base = workerUrl(c);
    const last = items[items.length - 1];
    const responseItems = items.map((i) => serializeImage(i, base));
    return c.json(buildCursorListResponse({ success: true,
      data: responseItems,
      counts,
      nextBefore: items.length >= filter.limit && last ? JSON.stringify({ at: last.created_at, id: last.id }) : null, items: responseItems, paging: { limit: filter.limit }, sort: [{ field: 'createdAt', direction: 'desc' }, { field: 'id', direction: 'desc' }] }));
  } catch (err) {
    throw err;
  }
});

hqBanners.get('/api/hq/banners/images/:id', async (c) => {
  const detail = await getBannerImageWithDetail(c.env.DB, c.req.param('id'), tenantOf(c));
  if (!detail || detail.deleted_at) return c.json({ success: false, error: '画像が見つかりません' }, 404);
  return c.json({ success: true, data: serializeImage(detail, workerUrl(c)) });
});

hqBanners.patch('/api/hq/banners/images/:id', inputJsonBoundary(), async (c) => {
  try {
    const tenantId = tenantOf(c);
    const body = await readJson(c);
    const patch: { isFavorite?: boolean; projectId?: string; folderId?: string | null } = {};
    if (body && 'folderId' in body) patch.folderId = body.folderId as string | null;
    if (typeof body?.isFavorite === 'boolean') patch.isFavorite = body.isFavorite;
    if (typeof body?.projectId === 'string') {
      const target = await getBannerProject(c.env.DB, body.projectId, tenantId);
      if (!target) return c.json({ success: false, error: '移動先のプロジェクトが見つかりません' }, 404);
      patch.projectId = target.id;
    }
    const existing = await getBannerImage(c.env.DB, c.req.param('id'), tenantId);
    if (!existing || existing.deleted_at) return c.json({ success: false, error: '画像が見つかりません' }, 404);
    await updateBannerImage(c.env.DB, existing.id, tenantId, patch);
    const detail = await getBannerImageWithDetail(c.env.DB, existing.id, tenantId);
    return c.json({ success: true, data: serializeImage(detail!, workerUrl(c)) });
  } catch (err) {
    if(err instanceof HqFolderError)return folderInputError(c, err);
    throw err;
  }
});

/** 画像を一覧から外す。実体と店舗へ渡した分は残す（渡した先の配信を壊さない）。 */
hqBanners.delete('/api/hq/banners/images/:id', async (c) => {
  const tenantId = tenantOf(c);
  const existing = await getBannerImage(c.env.DB, c.req.param('id'), tenantId);
  if (!existing || existing.deleted_at) return c.json({ success: false, error: '画像が見つかりません' }, 404);
  await updateBannerImage(c.env.DB, existing.id, tenantId, { deleted: true });
  return c.json({ success: true, data: null });
});

/** 統括が手持ちの画像をプロジェクトへ取り込む。生成画像と同じように店舗へ渡せる。 */
hqBanners.post('/api/hq/banners/projects/:id/uploads', inputJsonBoundary({}, { maxBytes: Math.ceil((10 * 1024 * 1024) / 3) * 4 + 4096 }), async (c) => {
  try {
    const tenantId = tenantOf(c);
    const project = await getBannerProject(c.env.DB, c.req.param('id'), tenantId);
    if (!project) return c.json({ success: false, error: 'プロジェクトが見つかりません' }, 404);
    const body = await readJson(c);
    const data = typeof body?.data === 'string' ? body.data : '';
    const filename = typeof body?.filename === 'string' ? body.filename.trim() : '';
    if (!data) return inputError(c, { success: false, error: 'ファイルの中身がありません' }, 400, ["data"]);
    if (!filename) return inputError(c, { success: false, error: 'ファイル名がありません' }, 400, ["filename"]);

    let base64 = data;
    let mimeType = typeof body?.mimeType === 'string' ? body.mimeType : '';
    const dataUrl = /^data:([^;]+);base64,(.+)$/.exec(base64);
    if (dataUrl) {
      mimeType = dataUrl[1];
      base64 = dataUrl[2];
    }
    const spec = UPLOAD_ALLOWED[mimeType];
    if (!spec) {
      return inputError(c, { success: false, error: '画像は PNG・JPEG・WebP のみ取り込めます' }, 400, ["mimeType"]);
    }
    let bytes: Uint8Array;
    try {
      bytes = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
    } catch {
      return inputError(c, { success: false, error: 'ファイルの中身を読み取れませんでした' }, 400, []);
    }
    if (bytes.byteLength > UPLOAD_MAX_BYTES) {
      return c.json({ success: false, error: 'ファイルが大きすぎます（上限 10MB）' }, 413);
    }
    if (!hasImageSignature(bytes, mimeType)) {
      return inputError(c, { success: false, error: 'ファイルの実際の形式が、選択された形式と一致しません' }, 400, ["mimeType"]);
    }

    const r2Key = `banner/${crypto.randomUUID()}.${spec.ext}`;
    await c.env.IMAGES.put(r2Key, bytes, {
      httpMetadata: { contentType: mimeType },
      customMetadata: { originalFilename: filename, source: 'banner-upload' },
    });
    let media: Media;
    try {
      media = await createMedia(c.env.DB, {
        lineAccountId: null,
        kind: 'image',
        filename,
        mimeType,
        sizeBytes: bytes.byteLength,
        r2Key,
        width: typeof body?.width === 'number' ? body.width : null,
        height: typeof body?.height === 'number' ? body.height : null,
        uploadedBy: c.get('staff')?.id ?? null,
      });
    } catch (error) {
      await c.env.IMAGES.delete(r2Key).catch(() => undefined);
      throw error;
    }
    const image = await createBannerImage(c.env.DB, {
      tenantId,
      projectId: project.id,
      generationId: null,
      mediaId: media.id,
      sequence: Number(project.image_count ?? 0) + 1,
      source: 'upload',
      createdBy: c.get('staff')?.id ?? null,
    });
    await touchBannerProject(c.env.DB, project.id);
    const detail = await getBannerImageWithDetail(c.env.DB, image.id, tenantId);
    return c.json({ success: true, data: serializeImage(detail!, workerUrl(c)) }, 201);
  } catch (err) {
    throw err;
  }
});

// ============================================================== deliveries

/**
 * 画像を店舗（LINE公式アカウント）へ渡す。
 *
 * 店舗ごとに実体を複製し、店舗の登録メディアとして1行作る。同じ店舗へ
 * 二度渡しても増えない。統括側の画像を消しても、渡した先は残る。
 */
hqBanners.post('/api/hq/banners/images/:id/deliver', inputJsonBoundary(), async (c) => {
  try {
    const tenantId = tenantOf(c);
    const staff = c.get('staff');
    const image = await getBannerImageWithDetail(c.env.DB, c.req.param('id'), tenantId);
    if (!image || image.deleted_at) return c.json({ success: false, error: '画像が見つかりません' }, 404);

    const body = await readJson(c);
    const rawIds = Array.isArray(body?.lineAccountIds) ? body.lineAccountIds : [];
    const lineAccountIds = [...new Set(rawIds.filter((v): v is string => typeof v === 'string' && v.trim() !== ''))];
    if (lineAccountIds.length === 0) {
      return inputError(c, { success: false, error: '渡す先の店舗を1つ以上選んでください' }, 400, ["lineAccountIds"]);
    }
    if (lineAccountIds.length > 50) {
      return inputError(c, { success: false, error: '一度に渡せる店舗は50件までです' }, 400, ["lineAccountIds"]);
    }
    if (!await canAccessAllLineAccounts(c.env.DB, staff, lineAccountIds)) {
      return c.json({ success: false, error: '渡す先に、この統括の店舗ではないものが含まれています' }, 404);
    }

    const sourceGate = await checkMediaGate(c.env.DB, c.env.IMAGES, {
      id: image.media.id, lineAccountId: image.media.line_account_id, r2Key: image.media.r2_key,
      filename: image.media.filename, mimeType: image.media.mime_type, sizeBytes: image.media.size_bytes,
      width: image.media.width, height: image.media.height,
    });
    if (!sourceGate.allowed) return c.json({ success: false, code: sourceGate.code, error: sourceGate.message }, 409);
    const results: Array<{ lineAccountId: string; mediaId: string; alreadyDelivered: boolean }> = [];
    for (const lineAccountId of lineAccountIds) {
      const existing = await getBannerImageDelivery(c.env.DB, image.id, lineAccountId);
      if (existing) {
        results.push({ lineAccountId, mediaId: existing.media_id, alreadyDelivered: true });
        continue;
      }
      const source = await getPinnedMediaObject(c.env.IMAGES, image.media.r2_key, sourceGate.etag);
      if (!source) {
        return c.json({ success: false, error: '画像の実体が見つかりません。もう一度生成してください' }, 409);
      }
      const bytes = new Uint8Array(await source.arrayBuffer());
      const ext = image.media.r2_key.split('.').pop() || 'jpg';
      const r2Key = `media/${crypto.randomUUID()}.${ext}`;
      await c.env.IMAGES.put(r2Key, bytes, {
        httpMetadata: { contentType: image.media.mime_type },
        customMetadata: { originalFilename: image.media.filename, source: 'banner-delivery', bannerImageId: image.id },
      });
      let media: Media;
      try {
        media = await createMedia(c.env.DB, {
          lineAccountId,
          kind: 'image',
          filename: image.media.filename,
          mimeType: image.media.mime_type,
          sizeBytes: bytes.byteLength,
          r2Key,
          width: image.media.width,
          height: image.media.height,
          uploadedBy: staff?.id ?? null,
        });
      } catch (error) {
        await c.env.IMAGES.delete(r2Key).catch(() => undefined);
        throw error;
      }
      await createBannerImageDelivery(c.env.DB, {
        bannerImageId: image.id,
        lineAccountId,
        mediaId: media.id,
        deliveredBy: staff?.id ?? null,
      });
      results.push({ lineAccountId, mediaId: media.id, alreadyDelivered: false });
    }
    const detail = await getBannerImageWithDetail(c.env.DB, image.id, tenantId);
    return c.json({
      success: true,
      data: { image: serializeImage(detail!, workerUrl(c)), deliveries: results },
    });
  } catch (err) {
    throw err;
  }
});
