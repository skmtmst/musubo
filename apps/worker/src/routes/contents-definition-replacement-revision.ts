import { findDirectMediaUsages } from '../features/media/index.js';
import { getPinnedMediaObject } from '../services/media-upload-storage.js';
import { logger } from '@line-crm/shared/server';
import { inputError } from '../lib/input-errors.js';
import { type Context } from 'hono';
import { getMediaById, archiveMedia, restoreMedia, getStaffNameMap, getMediaReplacementPlan, getMediaUploadSession, getCurrentMediaVersionNo, getLatestMediaVersion, evaluateMediaVersionCompat, backfillMediaVersionMetadata, type MediaMetadata, jstNow, normalizeCommonVarValidityAt, type Media, type MediaKind, type CommonVar, type CommonVarSchedule, type CommonVarExpiryBehavior, type CommonVarUsageImpact, type CommonVarUsageItem } from '@line-crm/db';
import { fail } from '../lib/fail.js';



import type { CommonVarUsageKind } from '@line-crm/shared';
import type { Env } from '../worker-env.js';
import { auditLog } from '../lib/audit-log.js';
import { canAccessAllLineAccounts } from '../services/account-access.js';
import { imageDimensions, IMAGE_METADATA_PREFIX_BYTES } from '../features/media/media-metadata/index.js';
import { scanSingleMediaUsage } from '../features/media/media-usage-scan/index.js';
import { checkMediaGate } from '../services/file-scan.js';
import type { MediaReplacementImpact } from '@line-crm/shared';

export const REPLACEMENT_BODY_MAX_BYTES = 16 * 1024;

export class RequestBodyError extends Error {
  constructor(readonly status: 400 | 413, message: string) {
    super(message);
  }
}

export async function replacementRevision(
  sourceId: string,
  replacementId: string,
  usages: Array<{ ref_kind: string; ref_id: string; scanned_at: string }>,
): Promise<string> {
  const raw = [sourceId, replacementId, ...usages.map((usage) =>
    `${usage.ref_kind}:${usage.ref_id}`).sort()].join('\n');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function replacementImpact(
  c: Context<Env>,
  sourceId: string,
  replacementId: string,
  accountId: string,
): Promise<{
  plan: NonNullable<Awaited<ReturnType<typeof getMediaReplacementPlan>>>;
  impact: MediaReplacementImpact;
} | null> {
  const checkedAt = jstNow();
  const source = await getMediaById(c.env.DB, sourceId, accountId);
  const replacement = await getMediaById(c.env.DB, replacementId, accountId);
  if (!source || !replacement) return null;
  await scanSingleMediaUsage(c.env.DB, checkedAt, { id: source.id, r2_key: source.r2_key });
  const plan = await getMediaReplacementPlan(c.env.DB, {
    sourceId, replacementId, lineAccountId: accountId, checkedAt,
  });
  if (!plan) return null;
  const menuRows = await c.env.DB.prepare('SELECT id FROM rt_menu_items WHERE image_media_id = ? ORDER BY id')
    .bind(sourceId).all<{id:string}>();
  const direct = await findDirectMediaUsages(c.env.DB, source, accountId);
  const directRefs = direct.map(row => ({ kind: row.refKind, name: row.name, href: row.href, state: 'available' as const,
    scannedAt: checkedAt, replaceable: false, blocker: 'unsupported_reference' as const,
    reason: 'この使用先は編集画面から画像を変更してください。' }));
  const blockedByKind = { ...plan.impact.blockedByKind };
  for (const ref of directRefs) blockedByKind[ref.kind] = (blockedByKind[ref.kind] ?? 0) + 1;
  const allUsages = [...plan.usages, ...menuRows.results.map(row => ({ ref_kind: 'restaurant_menu', ref_id: row.id, scanned_at: checkedAt })),
    ...direct.map(row => ({ ref_kind: row.refKind, ref_id: row.refId, scanned_at: checkedAt }))];
  return {
    plan,
    impact: { ...plan.impact, usageCount: plan.impact.usageCount + direct.length,
      blockedCount: plan.impact.blockedCount + direct.length, blockedByKind,
      references: [...plan.impact.references, ...directRefs],
      blockers: direct.length ? [...new Set([...plan.impact.blockers, 'unsupported_reference' as const])] : plan.impact.blockers,
      canReplace: direct.length ? false : plan.impact.canReplace,
      canPartiallyReplace: direct.length ? false : plan.impact.canPartiallyReplace,
      revision: await replacementRevision(sourceId, replacementId, allUsages) },
  };
}

export // ── メディア ────────────────────────────────────────────────

/**
 * 受け付ける形式。MIMEと拡張子の両方を見る。
 *
 * MIMEだけだと、送る側が名乗った値をそのまま信じることになる。
 * 拡張子だけだと、中身が違うものを .png と名付けるだけで通る。
 * 両方が揃っているものだけ通す。
 */
const ALLOWED: Record<string, { kind: MediaKind; ext: string[]; maxBytes: number }> = {
  'image/png': { kind: 'image', ext: ['png'], maxBytes: 10 * 1024 * 1024 },
  'image/jpeg': { kind: 'image', ext: ['jpg', 'jpeg'], maxBytes: 10 * 1024 * 1024 },
  'image/gif': { kind: 'image', ext: ['gif'], maxBytes: 10 * 1024 * 1024 },
  'image/webp': { kind: 'image', ext: ['webp'], maxBytes: 10 * 1024 * 1024 },
  'video/mp4': { kind: 'video', ext: ['mp4'], maxBytes: 90 * 1024 * 1024 },
  'audio/mpeg': { kind: 'audio', ext: ['mp3'], maxBytes: 30 * 1024 * 1024 },
  'audio/mp4': { kind: 'audio', ext: ['m4a'], maxBytes: 30 * 1024 * 1024 },
  'application/pdf': { kind: 'file', ext: ['pdf'], maxBytes: 20 * 1024 * 1024 },
};

export const DIRECT_ALLOWED: Record<string, { kind: MediaKind; ext: string[]; maxBytes: number }> = {
  ...ALLOWED,
  'video/mp4': { kind: 'video', ext: ['mp4'], maxBytes: 200 * 1024 * 1024 },
  'audio/mpeg': { kind: 'audio', ext: ['mp3'], maxBytes: 200 * 1024 * 1024 },
  'audio/mp4': { kind: 'audio', ext: ['m4a'], maxBytes: 200 * 1024 * 1024 },
};

export /**
 * 動画の上限を 90MB にしている理由。
 *
 * 要件定義書は 200MB としているが、Cloudflare Workers が1リクエストで
 * 受け取れる本文には上限があり（プランによって 100MB 前後）、
 * 200MB は届く前に切られる。「アップロードできます」と書いておいて
 * 大きいファイルだけ黙って失敗する方が困るので、確実に通る値にした。
 *
 * それ以上を扱うなら、R2 へ直接上げる仕組み（署名付きURL）が要る。
 */

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot >= 0 ? filename.slice(dot + 1).toLowerCase() : '';
}

export /**
 * `url` は配信用の公開URLとして返す。配信本文に文字列として埋まり、
 * LINEのサーバーが認証なしで取りに行くため、公開のままにしている。
 * 管理画面の表示・ダウンロードには使わず、認証付きの
 * `/api/media/:id/content`・`/api/media/:id/download` を使う。
 * `liveUrl` はライブ参照用の公開URL。メディアIDだけを含み、
 * 配信時にその時点の最新版へ解決される。
 */
/**
 * 入れた人の表示名を添える（R35）。
 *
 * `uploaded_by` は内部ID（UUID）のまま残し、画面には `uploadedByName`
 * を出す。退職・削除済みで引けないときは null（画面が「削除された
 * 担当者」と出す）。`env-owner`（環境の API キー）は staff 表に無いため、
 * 認証と同じ呼び名 'Owner' を添える。
 */
async function uploaderNameMap(
  db: D1Database,
  rows: Array<{ uploaded_by?: string | null }>,
): Promise<Map<string, string>> {
  const names = await getStaffNameMap(db, rows.map((row) => row.uploaded_by));
  names.set('env-owner', 'Owner');
  return names;
}

export function serializeMedia(row: Media, workerUrl: string, uploaderNames?: Map<string, string>) {
  return {
    revision: row.revision ?? 1,
    id: row.id,
    lineAccountId: row.line_account_id,
    folderId: row.folder_id,
    kind: row.kind,
    filename: row.filename,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    width: row.width,
    height: row.height,
    durationMs: row.duration_ms,
    url: row.public_url ?? `${workerUrl}/images/${row.r2_key}`,
    liveUrl: `${workerUrl}/media/${row.id}/content`,
    uploadedBy: row.uploaded_by,
    uploadedByName: row.uploaded_by ? (uploaderNames?.get(row.uploaded_by) ?? null) : null,
    createdAt: row.created_at,
    archivedAt: row.archived_at ?? null,
    archivedBy: row.archived_by ?? null,
    archiveReason: row.archive_reason ?? null,
    // 記録された値だけを返す。未記録は null（画面では「不明」と出す）。
    usageExpiresAt: row.usage_expires_at ?? null,
    usageConsentNote: row.usage_consent_note ?? null,
    usageCount: row.usage_count === undefined ? undefined : Number(row.usage_count),
  };
}

export function directUploadConfig(env: Env['Bindings']) {
  const accountId = env.CF_ACCOUNT_ID?.trim();
  const accessKeyId = env.MEDIA_R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.MEDIA_R2_SECRET_ACCESS_KEY?.trim();
  const bucketName = env.MEDIA_R2_BUCKET_NAME?.trim();
  if (!accountId || !accessKeyId || !secretAccessKey || !bucketName) return null;
  return { accountId, accessKeyId, secretAccessKey, bucketName };
}

export function normalizedEtag(value: string): string {
  return value.trim().replace(/^"|"$/g, '');
}

export /** 実在する日付の YYYY-MM-DD だけを利用期限として受け付ける。 */
function isValidUsageExpiryDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

export /**
 * アップロード予約に載せる内容情報。省略は null、型が違えば undefined で
 * 呼び出し側が 400 にする。版追加の互換判定はここに保存した値を正本にする。
 */
function parseUploadMetadata(raw: unknown): MediaMetadata | null | undefined {
  if (raw == null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const readInt = (value: unknown): number | null | undefined => {
    if (value == null) return null;
    return Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : undefined;
  };
  const width = readInt(record.width);
  const height = readInt(record.height);
  const durationMs = readInt(record.durationMs);
  const pageCount = readInt(record.pageCount);
  if (width === undefined || height === undefined
    || durationMs === undefined || pageCount === undefined) return undefined;
  const codecRaw = record.codec;
  const codec = codecRaw == null ? null
    : typeof codecRaw === 'string' && codecRaw.trim().length > 0 && codecRaw.trim().length <= 100
      ? codecRaw.trim() : undefined;
  if (codec === undefined) return undefined;
  return { width, height, duration_ms: durationMs, page_count: pageCount, codec };
}

export async function measureStoredImageMetadata(
  c: Context<Env>,
  media: { r2_key: string; mime_type: string },
): Promise<{ width: number; height: number } | null> {
  try {
    const object = await c.env.IMAGES.get(media.r2_key, {
      range: { offset: 0, length: IMAGE_METADATA_PREFIX_BYTES },
    });
    if (!object) return null;
    const bytes = new Uint8Array(await object.arrayBuffer());
    return imageDimensions(bytes, media.mime_type);
  } catch (err) {
    logger.error("contents.measure_stored_image_metadata_failed");
    return null;
  }
}

export async function mediaVersionPreview(
  c: Context<Env>,
  mediaId: string,
  uploadSessionId: string,
  accountId: string,
) {
  const [media, session, currentVersionNo] = await Promise.all([
    getMediaById(c.env.DB, mediaId, accountId),
    getMediaUploadSession(c.env.DB, uploadSessionId, accountId),
    getCurrentMediaVersionNo(c.env.DB, mediaId, accountId),
  ]);
  if (!media || !session || currentVersionNo === null || session.target_media_id !== mediaId) {
    return null;
  }
  const latestVersion = await getLatestMediaVersion(c.env.DB, mediaId, accountId);
  // 旧データには版の内容情報が無い。画像は実体の先頭から寸法を測って補い、
  // それでも足りなければ互換とみなさず明示的に拒否する。
  let currentMetadata: MediaMetadata = {
    width: latestVersion?.width ?? media.width,
    height: latestVersion?.height ?? media.height,
    duration_ms: latestVersion?.duration_ms ?? media.duration_ms,
    page_count: latestVersion?.page_count ?? null,
    codec: latestVersion?.codec ?? null,
  };
  if (media.kind === 'image' && (currentMetadata.width == null || currentMetadata.height == null)) {
    const measured = await measureStoredImageMetadata(c, media);
    if (measured) {
      currentMetadata = { ...currentMetadata, ...measured };
      await backfillMediaVersionMetadata(c.env.DB, media, latestVersion, measured);
    }
  }
  const incomingMetadata: MediaMetadata = {
    width: session.width,
    height: session.height,
    duration_ms: session.duration_ms,
    page_count: session.page_count,
    codec: session.codec,
  };
  const blockers: string[] = session.status !== 'verified'
    ? ['upload_not_verified']
    : evaluateMediaVersionCompat(
      { kind: media.kind, ...currentMetadata },
      { kind: session.kind, ...incomingMetadata },
    );
  const raw = [
    media.id, media.r2_key, String(currentVersionNo), session.id, session.r2_key,
    session.etag ?? '', session.kind, session.expected_mime, String(session.expected_size),
    String(session.width ?? ''), String(session.height ?? ''),
    String(session.duration_ms ?? ''), String(session.page_count ?? ''),
    session.codec ?? '',
    String(currentMetadata.width ?? ''), String(currentMetadata.height ?? ''),
    String(currentMetadata.duration_ms ?? ''), String(currentMetadata.page_count ?? ''),
    currentMetadata.codec ?? '',
    ...blockers,
  ].join('\n');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  const previewToken = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return {
    media,
    session,
    currentVersionNo,
    previewToken,
    blockers,
    currentMetadata,
    incomingMetadata,
    canReplace: blockers.length === 0,
  };
}

export /**
 * 管理画面がメディアの中身を読むための共通処理。
 *
 * 一覧が返す `url` は配信用の公開URL（配信本文に文字列として埋まり、
 * LINEが取りに行くため公開のまま）で、管理画面の表示には使わない。
 * こちらは担当者の役割とLINEアカウントの可視範囲を毎回確認する。
 * 監査行は download の成功・拒否だけに絞り、一覧の縮小表示のような
 * 閲覧のたびには残さない。
 */
async function serveMediaFile(
  c: Context<Env>,
  opts: { auditDownload: boolean; disposition: 'attachment' | 'inline' },
) {
  const id = c.req.param('id');
  const accountId = c.req.query('accountId')?.trim();
  if (!id) return c.json({ success: false, error: 'Not found' }, 404);
  if (!accountId) return fail(c, 400, 'ACCOUNT_ID_REQUIRED', {}, ["accountId"]);
  if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [accountId])) {
    if (opts.auditDownload) {
      auditLog(c, 'media.download', { kind: 'media', id }, { result: 'denied', lineAccountId: accountId });
    }
    return c.json({ success: false, error: 'Not found' }, 404);
  }
  const media = await getMediaById(c.env.DB, id, accountId);
  if (!media) {
    if (opts.auditDownload) {
      auditLog(c, 'media.download', { kind: 'media', id }, { result: 'denied', lineAccountId: accountId });
    }
    return c.json({ success: false, error: 'Not found' }, 404);
  }
  // 検査が終わるまで中身は出さない。URL だけ返して中身を渡さない、はしない。
  const gate = await checkMediaGate(c.env.DB, c.env.IMAGES, {
    id: media.id,
    lineAccountId: media.line_account_id,
    r2Key: media.r2_key,
    filename: media.filename,
    mimeType: media.mime_type,
    sizeBytes: media.size_bytes,
    width: media.width,
    height: media.height,
  });
  if (!gate.allowed) {
    if (opts.auditDownload) {
      auditLog(c, 'media.download', { kind: 'media', id }, { result: 'denied', lineAccountId: accountId });
    }
    return c.json({ success: false, code: gate.code, error: gate.message }, 409);
  }
  const object = await getPinnedMediaObject(c.env.IMAGES, media.r2_key, gate.etag);
  if (!object) return c.json({ success: false, error: 'Not found' }, 404);
  if (opts.auditDownload) {
    auditLog(c, 'media.download', { kind: 'media', id }, { result: 'success', lineAccountId: accountId });
  }
  const disposition = opts.disposition === 'attachment'
    ? `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(media.filename)}`
    : `inline; filename="view"; filename*=UTF-8''${encodeURIComponent(media.filename)}`;
  return new Response(object.body, {
    headers: {
      'Content-Type': media.mime_type,
      'Content-Disposition': disposition,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

export /**
 * アーカイブ／復元。消去ではなく一覧・新規選択から隠すだけなので、本文や
 * 過去配信からの参照は切れない。理由を必須にして、いつ・誰が・なぜを
 * 監査行へ残す。二重実行は既に目的側の状態なので 409 で引き返す。
 */
async function mediaArchiveRoute(c: Context<Env>, archive: boolean, mediaId: string) {
  const raw = await c.req.json().catch(() => null);
  const body = raw && typeof raw === 'object'
    ? raw as { accountId?: unknown; reason?: unknown }
    : null;
  const bodyAccountId = typeof body?.accountId === 'string' ? body.accountId.trim() : '';
  const accountId = c.req.query('accountId')?.trim() || bodyAccountId;
  if (!accountId) return fail(c, 400, 'ACCOUNT_ID_REQUIRED', {}, ["accountId"]);
  if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [accountId])) {
    return c.json({ success: false, error: 'Not found' }, 404);
  }
  const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
  if (!reason) {
    return inputError(c, { success: false, code: 'media_reason_required', error: '理由を入力してください' }, 400, ["reason"]);
  }
  const fn = archive ? archiveMedia : restoreMedia;
  const result = await fn(c.env.DB, {
    id: mediaId,
    lineAccountId: accountId,
    actorId: c.get('staff').id,
    reason,
  });
  if (result.status === 'not_found') return c.json({ success: false, error: 'Not found' }, 404);
  if (result.status === 'archived' || result.status === 'restored') {
    const workerUrl = c.env.WORKER_URL || new URL(c.req.url).origin;
    const names = await uploaderNameMap(c.env.DB, [result.media]);
    return c.json({ success: true, data: serializeMedia(result.media, workerUrl, names) });
  }
  return c.json({
    success: false,
    code: result.status,
    error: archive ? 'このメディアは既にアーカイブ済みです' : 'このメディアは既に一覧へ戻っています',
  }, 409);
}

export // ── 共通情報 ────────────────────────────────────────────────

function serializeVar(row: CommonVar) {
  return {
    id: row.id,
    lineAccountId: row.line_account_id,
    folderId: row.folder_id,
    name: row.name,
    varKey: row.var_key,
    type: row.type,
    value: row.value,
    memo: row.memo ?? '',
    validFrom: row.valid_from ?? null,
    validUntil: row.valid_until ?? null,
    fallbackValue: row.fallback_value ?? null,
    expiryBehavior: row.expiry_behavior ?? 'stop',
    version: Number(row.version ?? 1),
    archivedAt: row.archived_at ?? null,
    // 「期限切れ」は時刻からその都度計算する。画面は state を見るだけでよい。
    status: row.status ?? 'active',
    stoppedAt: row.stopped_at ?? null,
    state: row.status === 'stopped'
      ? 'stopped'
      : row.status === 'draft'
        ? 'draft'
        : row.valid_until !== null && Date.parse(row.valid_until) <= Date.now()
          ? 'expired'
          : 'active',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    nextSchedule: row.next_effective_from
      ? { effectiveFrom: row.next_effective_from, value: row.next_value ?? '' }
      : null,
    pendingScheduleCount: Number(row.pending_schedule_count ?? 0),
    usageCount: Number(row.usage_count ?? 0),
    usageByKind: row.usage_by_kind ?? null,
  };
}

export function parseCommonVarValidity(body: Record<string, unknown>, existing?: CommonVar) {
  const parseAt = (key: 'validFrom' | 'validUntil', current: string | null = null) => {
    if (!(key in body)) return { value: current, present: false };
    const raw = body[key];
    if (raw === null || raw === '') return { value: null, present: true };
    const value = normalizeCommonVarValidityAt(raw);
    if (!value) throw new RequestBodyError(400, `${key === 'validFrom' ? '有効開始' : '有効終了'}の日時が正しくありません`);
    return { value, present: true };
  };
  const validFrom = parseAt('validFrom', existing?.valid_from ?? null);
  const validUntil = parseAt('validUntil', existing?.valid_until ?? null);
  if (validFrom.value && validUntil.value && validFrom.value >= validUntil.value) {
    throw new RequestBodyError(400, '有効終了は有効開始より後にしてください');
  }
  const expiryRaw = body.expiryBehavior ?? existing?.expiry_behavior ?? 'stop';
  if (expiryRaw !== 'stop' && expiryRaw !== 'fallback') {
    throw new RequestBodyError(400, '期限切れ時の動作が正しくありません');
  }
  const expiryBehavior = expiryRaw as CommonVarExpiryBehavior;
  const fallbackPresent = 'fallbackValue' in body;
  const fallbackRaw = fallbackPresent ? body.fallbackValue : existing?.fallback_value;
  const fallbackValue = fallbackRaw === null || fallbackRaw === undefined || fallbackRaw === ''
    ? null
    : String(fallbackRaw);
  if (expiryBehavior === 'fallback' && fallbackValue === null) {
    throw new RequestBodyError(400, '期限切れ時に使う代替値を入力してください');
  }
  return { validFrom, validUntil, expiryBehavior, fallbackValue, fallbackPresent };
}

export function serializeSchedule(row: CommonVarSchedule) {
  return {
    id: row.id,
    varId: row.var_id,
    effectiveFrom: row.effective_from,
    value: row.value,
    appliedAt: row.applied_at,
  };
}

export const COMMON_VAR_USAGE_KIND_LABELS: Record<CommonVarUsageKind, string> = {
  template: 'テンプレート',
  broadcast: '一斉配信',
  scenario: 'シナリオ配信',
  reminder: 'リマインダ',
  auto_reply: '自動応答',
  form: '回答フォーム',
  automation: 'オートメーション',
  friend_add: '友だち追加時の配信',
  common_action: '共通アクション',
};

export function emptyCommonVarUsageImpact(): CommonVarUsageImpact {
  return {
    total: 0,
    blockingTotal: 0,
    historicalTotal: 0,
    sendingFixedTotal: 0,
    unscopedFormTotal: 0,
    byKind: Object.fromEntries(
      Object.keys(COMMON_VAR_USAGE_KIND_LABELS).map((kind) => [kind, 0]),
    ) as Record<CommonVarUsageKind, number>,
    items: [],
  };
}

export function collectReadableStrings(value: unknown, token: string, out: string[]): void {
  if (typeof value === 'string') {
    if (value.includes(token)) out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectReadableStrings(item, token, out);
    return;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) {
      collectReadableStrings(item, token, out);
    }
  }
}

export /** JSON設定の内部構造を出さず、差し込みを含む人向けの文だけを短く返す。 */
function readableCommonVarUsage(content: string, token: string): string {
  let text = content;
  try {
    const strings: string[] = [];
    collectReadableStrings(JSON.parse(content) as unknown, token, strings);
    // 共通情報を増減する操作は varKey を内部JSONに持つ。人向けの文が
    // 無いときはJSONを見せず、下の共通文へ倒す。
    text = strings.join(' ／ ');
  } catch {
    // 通常の本文はJSONではない。
  }
  const compact = text.replace(/\s+/g, ' ').trim();
  if (!compact) return 'この設定の中で使われています';
  return compact.length > 180 ? `${compact.slice(0, 179)}…` : compact;
}

export function commonVarUsageHref(item: CommonVarUsageItem): string {
  const id = encodeURIComponent(item.source_parent_id ?? item.source_id);
  switch (item.kind) {
    case 'template': return `/templates/edit?id=${id}`;
    case 'broadcast': return `/broadcasts/detail?id=${id}`;
    case 'scenario': return item.source_table === 'scenario_steps' ? `/scenarios/detail?id=${id}&step=${encodeURIComponent(item.source_id)}` : item.source_table === 'scenario_message_actions' ? `/scenarios/detail?id=${id}&action=${encodeURIComponent(item.source_id)}` : `/scenarios/detail?id=${id}`;
    case 'reminder': return `/reminders/edit?id=${id}`;
    case 'auto_reply': return `/auto-replies/edit?id=${id}`;
    case 'form': return `/form-submissions/edit?id=${id}`;
    case 'automation': return '/automations';
    case 'friend_add': return '/friend-add-settings';
    case 'common_action': return `/common-actions/versions?id=${id}`;
    // 新しい種別が増えても画面のLinkを壊さない。一覧へ戻す。
    default: return '/contents/vars';
  }
}

export /*
 * 使用先の状態の呼び名。画面はこの語彙だけを信用するため、処理と違う
 * 言い方をしない。
 *
 * - sending_fixed: 送信を始めた配信。値は送信開始時点の写しで固定済みで、
 *   共通情報を直してもその配信は変わらない。
 * - scheduled: 配信予約中。送信を始めるときに、その時点の値で送られる。
 * - published: 公開版。次に送る・実行されるときから新しい値が入る。
 */
function commonVarUsageStatus(item: CommonVarUsageItem): string {
  if (item.is_historical === 1) return '送信済み・変わりません';
  if (item.source_status === 'sending_fixed') return '配信中（送信開始時の値で固定済み）';
  if (item.source_status === 'scheduled') return '配信予約中';
  if (item.source_status === 'sending') return '配信中';
  if (item.source_status === 'draft') return '下書き';
  if (item.source_status === 'published') return '公開中';
  if (item.source_status === 'stopped') return '停止中';
  return '使われています';
}

export /** 保存・削除でこの使用先が変わるか。送信済みと値が固定済みの配信中は変わらない。 */
function commonVarUsageChangesOnSave(item: CommonVarUsageItem): boolean {
  return item.is_historical !== 1 && item.source_status !== 'sending_fixed' && item.fixed_version == null;
}
