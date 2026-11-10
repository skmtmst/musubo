import { findDirectMediaUsages } from '../features/media/index.js';
import { buildOffsetListResponse, parseOffsetPaging } from '../lib/list-paging.js';
import { getPinnedMediaObject } from '../services/media-upload-storage.js';
import { logger } from '@line-crm/shared/server';
import { getMediaVersionKeys } from '@line-crm/db';
import { getMediaById, getFolderById, updateMedia, deleteMedia, getMediaUsages, getMediaDeleteImpactSnapshot, isMissingTableError, applyMediaReplacementPlan, getMediaVersionList, getMediaLiveTarget, getMediaUsageReferenceStates, retargetMediaUsageReference, MediaUsageReferenceError, MEDIA_REF_KINDS, jstNow, getCommonVars, countCommonVars, COMMON_VARS_LIST_LIMIT, getCommonVarUsageSummaries, getCommonVarByIdIncludingArchived, getCommonVarUsageImpact, getCommonVarVersions, type CommonVar } from '@line-crm/db';
import { inputError } from '../lib/input-errors.js';
import { isWebinarSource, privateImageKey, publicDeliveryContentType, publicImageKey } from '../services/image-access.js';
import { fail } from '../lib/fail.js';


import type { Env } from '../worker-env.js';

import { auditLog } from '../lib/audit-log.js';
import { canAccessAllLineAccounts } from '../services/account-access.js';
import { claimFileDeletion, fileDeletionGuard, mediaDeletionLockId, releaseFileDeletion } from '../services/file-deletion-lock.js';
import { scanSingleMediaUsage } from '../features/media/media-usage-scan/index.js';
import { checkMediaGate, getMediaGateInfo } from '../services/file-scan.js';
import { isValidUsageExpiryDate, uploaderNameMap, serializeMedia, mediaArchiveRoute, replacementImpact, RequestBodyError, COMMON_VAR_USAGE_KIND_LABELS, serializeVar, emptyCommonVarUsageImpact, serializeCommonVarDeleteImpact } from './contents-definition.js';
import type { Context } from 'hono';

export const get__media_id_content_1 = async (c: Context<Env, "/media/:id/content">) => {
  const media = await getMediaLiveTarget(c.env.DB, c.req.param('id'));
  if (!media) return c.json({ success: false, error: 'Not found' }, 404);
  if (privateImageKey(media.r2_key) || !publicImageKey(media.r2_key)
    || !publicDeliveryContentType(media.mime_type, true) || await isWebinarSource(c.env.DB, media.r2_key)) {
    return c.json({ success: false, error: 'Not found' }, 404);
  }
  // 配信の本文に埋まる公開URLも、clean の版だけ出す。
  const liveFull = await getMediaGateInfo(c.env.DB, media.id);
  if (!liveFull) return c.json({ success: false, error: 'Not found' }, 404);
  const liveGate = await checkMediaGate(c.env.DB, c.env.IMAGES, {
    id: media.id,
    lineAccountId: liveFull.lineAccountId,
    r2Key: media.r2_key,
    filename: media.filename,
    mimeType: media.mime_type,
    sizeBytes: liveFull.sizeBytes,
    width: liveFull.width,
    height: liveFull.height,
  });
  if (!liveGate.allowed) {
    return c.json({ success: false, code: liveGate.code, error: liveGate.message }, 409);
  }
  const object = await getPinnedMediaObject(c.env.IMAGES, media.r2_key, liveGate.etag);
  if (!object) return c.json({ success: false, error: 'Not found' }, 404);
  const etag = typeof object.etag === 'string' && object.etag ? object.etag : null;
  if (etag && c.req.header('if-none-match') === etag) {
    return new Response(null, { status: 304 });
  }
  // 判別不能なまま開かせない。画像以外はそのまま表示せず添付で渡す。
  const inline = media.mime_type.toLowerCase().startsWith('image/');
  return new Response(object.body, {
    headers: {
      'Content-Type': media.mime_type,
      'Content-Disposition': inline
        ? `inline; filename*=UTF-8''${encodeURIComponent(media.filename)}`
        : `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(media.filename)}`,
      'Cache-Control': 'public, max-age=0, must-revalidate',
      'X-Content-Type-Options': 'nosniff',
      ...(etag ? { ETag: etag } : {}),
    },
  });
};

export const patch__api_media_id_2 = async (c: Context<Env, "/api/media/:id">) => {
  const id = c.req.param('id');
  const accountId = c.req.query('accountId')?.trim();
  if (!accountId) return fail(c, 400, 'ACCOUNT_ID_REQUIRED', {}, ["accountId"]);
  if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [accountId])) {
    return c.json({ success: false, error: 'Not found' }, 404);
  }
  const existing = await getMediaById(c.env.DB, id, accountId);
  if (!existing) return c.json({ success: false, error: 'Not found' }, 404);
  const body = await c.req.json<{
    filename?: string;
    folderId?: string | null;
    usageExpiresAt?: unknown;
    usageConsentNote?: unknown;
    usageReference?: {
      refKind?: unknown;
      refId?: unknown;
      mode?: unknown;
      versionNo?: unknown;
    };
  }>();
  const revisionHeader = c.req.header('If-Match')?.replace(/^"|"$/g, '');
  const expectedRevision = Number(revisionHeader);
  if (!revisionHeader || !Number.isInteger(expectedRevision) || expectedRevision < 1) return inputError(c, { success: false, code: 'EXPECTED_VERSION_REQUIRED', error: 'If-Match に確認した版が必要です' }, 400, []);
  if (expectedRevision !== (existing.revision ?? 1)) return c.json({ success: false, code: 'VERSION_CONFLICT', error: 'ほかの人が先に保存しました。読み直してください' }, 409);
  // 名前は空・長すぎ・制御文字を受け付けない（直接アップロードの申告時と同じ決まり）。
  const filename = body.filename === undefined ? undefined : String(body.filename).trim();
  if (filename !== undefined) {
    if (!filename) return inputError(c, { success: false, error: 'ファイル名を入力してください' }, 400, ["filename"]);
    if (filename.length > 255) {
      return inputError(c, { success: false, error: 'ファイル名は255文字までで入力してください' }, 400, ["filename"]);
    }
    if (/[\u0000-\u001f]/.test(filename)) {
      return inputError(c, { success: false, error: 'ファイル名に使えない文字が含まれています' }, 400, ["filename"]);
    }
  }
  // 存在しない・別種のフォルダを指すと、一覧の絞り込みから消える。
  let folderId: string | null | undefined;
  if ('folderId' in body) {
    folderId = body.folderId ? String(body.folderId) : null;
    if (folderId) {
      const folder = await getFolderById(c.env.DB, folderId);
      if (!folder || folder.kind !== 'media') {
        return inputError(c, { success: false, error: '指定のフォルダが見つかりません。フォルダを選び直してください' }, 400, ["folderId"]);
      }
    }
  }
  /*
    既知の利用期限・同意情報の記録。
    日付は実在する YYYY-MM-DD だけを受け付け、null/空で消す。
    推測で値を作らないので、形式が合わない入力は書き込まず拒否する。
  */
  let usageExpiresAt: string | null | undefined;
  if ('usageExpiresAt' in body) {
    const raw = body.usageExpiresAt;
    if (raw === null || raw === undefined || raw === '') {
      usageExpiresAt = null;
    } else if (typeof raw === 'string' && isValidUsageExpiryDate(raw.trim())) {
      usageExpiresAt = raw.trim();
    } else {
      return inputError(c, { success: false, error: '利用期限は日付（YYYY-MM-DD）で入力してください' }, 400, ["usageExpiresAt"]);
    }
  }
  let usageConsentNote: string | null | undefined;
  if ('usageConsentNote' in body) {
    const raw = body.usageConsentNote;
    if (raw === null || raw === undefined) {
      usageConsentNote = null;
    } else if (typeof raw === 'string') {
      const note = raw.trim();
      if (note.length > 500) {
        return inputError(c, { success: false, error: '同意・権利の記録は500文字までで入力してください' }, 400, ["usageConsentNote"]);
      }
      usageConsentNote = note || null;
    } else {
      return inputError(c, { success: false, error: '同意・権利の記録は文字列で入力してください' }, 400, ["usageConsentNote"]);
    }
  }
  const workerUrl = c.env.WORKER_URL || new URL(c.req.url).origin;
  if (body.usageReference === undefined) {
    const media = await updateMedia(c.env.DB, id, accountId, {
      expectedRevision,
      ...(filename !== undefined ? { filename } : {}),
      ...(folderId !== undefined ? { folderId } : {}),
      ...(usageExpiresAt !== undefined ? { usageExpiresAt } : {}),
      ...(usageConsentNote !== undefined ? { usageConsentNote } : {}),
    });
    if (!media) return c.json({ success: false, code: 'VERSION_CONFLICT', error: 'ほかの人が先に保存しました。読み直してください' }, 409);
    const names = await uploaderNameMap(c.env.DB, [media!]);
    return c.json({ success: true, data: serializeMedia(media!, workerUrl, names) });
  }

  /*
    使用先ごとの参照切替。指定した1か所の本文だけを書き換え、
    他の使用先には触れない。切り替え後は走査し直して使用先の記録を
    新しい参照の形へ合わせる。
  */
  const usageReference = body.usageReference;
  const refKind = typeof usageReference?.refKind === 'string' ? usageReference.refKind : '';
  const refId = typeof usageReference?.refId === 'string' ? usageReference.refId.trim() : '';
  if (!refId || !(MEDIA_REF_KINDS as readonly string[]).includes(refKind)) {
    return inputError(c, { success: false, error: '切り替える使用先を指定してください' }, 400, ["usageReference"]);
  }
  const versionNo = usageReference?.versionNo;
  const target = usageReference?.mode === 'live'
    ? { mode: 'live' as const }
    : usageReference?.mode === 'pinned'
      && Number.isInteger(versionNo)
      && Number(versionNo) >= 1
      ? { mode: 'pinned' as const, versionNo: Number(versionNo) }
      : null;
  if (!target) {
    return inputError(c, { success: false, error: '参照方法（常に最新・固定する版）を指定してください' }, 400, ["usageReference"]);
  }
  try {
    const result = await retargetMediaUsageReference(c.env.DB, {
      media: existing,
      lineAccountId: accountId,
      refKind,
      refId,
      target,
      mediaUpdate: {
        expectedRevision,
        ...(filename !== undefined ? { filename } : {}),
        ...(folderId !== undefined ? { folderId } : {}),
      },
    });
    try {
      await scanSingleMediaUsage(c.env.DB, jstNow(), {
        id: existing.id,
        r2_key: existing.r2_key,
      });
    } catch (scanError) {
      // 切替自体は確定済み。記録の更新は次の走査でも追いつく。
      logger.error("contents.media_id_patch_failed");
    }
    const fresh = await getMediaById(c.env.DB, id, accountId);
    const names = await uploaderNameMap(c.env.DB, [fresh ?? existing]);
    return c.json({
      success: true,
      data: {
        ...serializeMedia(fresh ?? existing, workerUrl, names),
        usageReference: {
          refKind,
          refId,
          mode: result.state.mode,
          versionNo: result.state.versionNo,
          changed: result.changed,
        },
      },
    });
  } catch (error) {
    if (error instanceof MediaUsageReferenceError) {
      switch (error.code) {
        case 'media_metadata_conflict':
          return c.json({ success: false, code: 'VERSION_CONFLICT', error: 'ほかの人が先に保存しました。読み直してください' }, 409);
        case 'media_usage_not_found':
          return c.json({ success: false, error: 'その使用先は見つかりませんでした' }, 404);
        case 'media_version_not_found':
          return c.json({ success: false, error: '指定の版が見つかりませんでした' }, 404);
        case 'media_usage_shared':
          return c.json({
            success: false,
            code: 'media_reference_shared',
            error: '複数のLINEアカウントで共有しているため、この画面からは切り替えられません',
          }, 409);
        case 'media_reference_unsupported':
          return c.json({
            success: false,
            code: 'media_reference_unsupported',
            error: 'この使用先ではその参照方法を使えません',
          }, 409);
        default:
          return c.json({
            success: false,
            code: 'media_reference_changed',
            error: '使用先の内容が変わりました。読み直してから、もう一度お試しください',
          }, 409);
      }
    }
    throw error;
  }
};

export const post__api_media_id_archive_3 = async (c: Context<Env, "/api/media/:id/archive">) => {
  return await mediaArchiveRoute(c, true, c.req.param('id'));
};

export const post__api_media_id_restore_4 = async (c: Context<Env, "/api/media/:id/restore">) => {
  return await mediaArchiveRoute(c, false, c.req.param('id'));
};

export const get__api_media_id_delete_impact_5 = async (c: Context<Env, "/api/media/:id/delete-impact">) => {
  try {
    const accountId = c.req.query('accountId')?.trim();
    if (!accountId) return fail(c, 400, 'ACCOUNT_ID_REQUIRED');
    if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [accountId])) {
      return c.json({ success: false, error: 'Not found' }, 404);
    }
    const existing = await getMediaById(c.env.DB, c.req.param('id'), accountId);
    if (!existing) return c.json({ success: false, error: 'Not found' }, 404);
    const checkedAt = jstNow();
    const scan = await scanSingleMediaUsage(c.env.DB, checkedAt, {
      id: existing.id,
      r2_key: existing.r2_key,
    });
    const snapshot = await getMediaDeleteImpactSnapshot(c.env.DB, c.req.param('id'), accountId, checkedAt);
    if (!snapshot) return c.json({ success: false, error: 'Not found' }, 404);
    const { impact, usages } = snapshot;
    const direct = await findDirectMediaUsages(c.env.DB, existing, accountId);
    const directReferences = direct.map(row => ({ kind: row.refKind, name: row.name, href: row.href, state: 'available' as const, scannedAt: checkedAt, refKind: row.refKind, refId: row.refId, reference: null }));
    /*
      R34: 版の表が無い環境では版の一覧が読めない。全体を503にせず、
      版なしで続けて「未確認」として返す。
    */
    let versions: Awaited<ReturnType<typeof getMediaVersionList>> = [];
    let versionsReady = true;
    try {
      versions = await getMediaVersionList(c.env.DB, existing.id, accountId);
    } catch (err) {
      if (!isMissingTableError(err)) throw err;
      logger.error("contents.media_id_delete_impact_get_failed");
      versionsReady = false;
    }
    /*
      R34: 読み残しがあるときは「どこでも使っていない」にしない。
      usageCount 0 でも未確認として返し、削除も止める（canDelete false）。
      確かめられないものは消させない。
    */
    const verified = versionsReady && (scan.skippedTables ?? []).length === 0;
    const verifiedImpact = verified ? impact : {
      ...impact,
      canDelete: false,
      recommendedAction: 'review_references' as const,
    };
    /*
      使用先ごとの参照モード（ライブ参照・固定する版）と、切替に使う
      版の一覧も一緒に返す。references と usages は同じsnapshotから
      作られているので、index対応中に別走査の行が混ざらない。
    */
    const states = await getMediaUsageReferenceStates(c.env.DB, {
      media: existing,
      usages,
      versions,
      lineAccountId: accountId,
    });
    const workerUrl = c.env.WORKER_URL || new URL(c.req.url).origin;
    return c.json({
      success: true,
      data: {
        ...verifiedImpact,
        usageCount: verifiedImpact.usageCount + direct.length,
        canDelete: verifiedImpact.canDelete && direct.length === 0,
        recommendedAction: direct.length ? 'review_references' : verifiedImpact.recommendedAction,
        verified,
        references: [...verifiedImpact.references.map((reference, index) => ({
          ...reference,
          refKind: usages[index]?.ref_kind ?? reference.kind,
          refId: usages[index]?.ref_id ?? null,
          reference: states[index] ?? null,
        })), ...directReferences],
        versions: versions.map((version) => ({
          versionNo: Number(version.version_no),
          mimeType: version.mime_type,
          sizeBytes: Number(version.size_bytes),
          changeReason: version.change_reason,
          createdAt: version.created_at,
          publishedAt: version.published_at,
          isCurrent: version.r2_key === existing.r2_key,
        })),
        liveUrl: `${workerUrl}/media/${existing.id}/content`,
      },
    });
  } catch (err) {
    logger.error("contents.media_id_delete_impact_get_failed");
    return c.json(
      { success: false, error: '削除したときの影響を確認できませんでした' },
      503,
    );
  }
};

export const get__api_media_id_replacement_impact_6 = async (c: Context<Env, "/api/media/:id/replacement-impact">) => {
  try {
    const accountId = c.req.query('accountId')?.trim();
    const replacementId = c.req.query('replacementId')?.trim();
    if (!accountId || !replacementId) {
      return c.json({ success: false, error: 'accountId と replacementId が必要です' }, 400);
    }
    if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [accountId])) {
      return c.json({ success: false, error: 'Not found' }, 404);
    }
    const current = await replacementImpact(c, c.req.param('id'), replacementId, accountId);
    if (!current) return c.json({ success: false, error: 'Not found' }, 404);
    return c.json({
      success: true,
      data: { ...current.impact, previewToken: current.impact.revision },
    });
  } catch (err) {
    logger.error("contents.media_id_replacement_impact_get_failed");
    return c.json({ success: false, error: '差し替えたときの影響を確認できませんでした' }, 503);
  }
};

export const post__api_media_id_replace_usages_7 = async (c: Context<Env, "/api/media/:id/replace-usages">) => {
  try {
    const accountId = c.req.query('accountId')?.trim();
    if (!accountId) return inputError(c, { success: false, error: 'accountId が必要です' }, 400, ["accountId"]);
    if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [accountId])) {
      return c.json({ success: false, error: 'Not found' }, 404);
    }
    const body = await c.req.json<Record<string, unknown>>();
    const replacementId = typeof body.replacementMediaId === 'string'
      ? body.replacementMediaId.trim()
      : '';
    const expectedRevision = typeof body.previewToken === 'string'
      ? body.previewToken.trim()
      : (typeof body.expectedRevision === 'string' ? body.expectedRevision.trim() : '');
    if (!replacementId || !expectedRevision) {
      return inputError(c, { success: false, error: '差し替え先と、確認した版が必要です' }, 400, ["replacementMediaId","previewToken","expectedRevision"]);
    }
    if (body.scope !== undefined && body.scope !== null
      && (typeof body.scope !== 'string'
        || (body.scope.trim() !== 'all' && body.scope.trim() !== 'replaceable'))) {
      return inputError(c, { success: false, error: 'scope は all か replaceable を指定してください' }, 400, ["scope"]);
    }
    const scope: 'all' | 'replaceable' =
      typeof body.scope === 'string' && body.scope.trim() === 'replaceable'
        ? 'replaceable'
        : 'all';

    const current = await replacementImpact(c, c.req.param('id'), replacementId, accountId);
    if (!current) return c.json({ success: false, error: 'Not found' }, 404);
    if (current.impact.revision !== expectedRevision) {
      return c.json({
        success: false,
        code: 'media_replacement_changed',
        error: '使用先が変わりました。最新の影響を読み直してから、もう一度お試しください。',
        data: current.impact,
      }, 409);
    }
    // 全件実行は従来どおり全使用先が置換可能なときだけ。部分実行は
    // 置換可能な使用先が1件以上あり、かつ差し替え元・先の組み合わせが
    // 正しいときだけ受け付ける（利用者が明示的に選んだ範囲だけを替える）。
    const allowed = scope === 'all'
      ? current.impact.canReplace
      : current.impact.canPartiallyReplace;
    if (!allowed || !current.plan) {
      return c.json({
        success: false,
        code: 'media_replacement_blocked',
        error: scope === 'all'
          ? '一括で差し替えられない使用先があります。差し替え可能な箇所だけの実行を選ぶか、表示された使用先を個別に確認してください。'
          : '差し替えられる使用先がありません。表示された使用先を個別に確認してください。',
        data: current.impact,
      }, 409);
    }

    const applied = await applyMediaReplacementPlan(
      c.env.DB, current.plan, accountId, { scope },
    );
    auditLog(c, 'media.replace_usages', { kind: 'media', id: current.plan.source.id }, {
      result: 'success',
      lineAccountId: accountId,
    });
    let remainingUsageCount: number | null = null;
    let verification: 'verified' | 'partial' | 'unavailable' = 'unavailable';
    const verifiedAt = jstNow();
    try {
      await Promise.all([
        scanSingleMediaUsage(c.env.DB, verifiedAt, {
          id: current.plan.source.id,
          r2_key: current.plan.source.r2_key,
        }),
        scanSingleMediaUsage(c.env.DB, verifiedAt, {
          id: current.plan.replacement.id,
          r2_key: current.plan.replacement.r2_key,
        }),
      ]);
      remainingUsageCount = (await getMediaUsages(c.env.DB, current.plan.source.id)).length;
      // 残るはずの件数は「置換不可として残した分」ちょうど。全件実行なら0、
      // 部分実行なら置換不可の件数。多くても少なくても曖昧にしない。
      const expectedRemaining = current.impact.usageCount - applied.appliedUsageCount;
      verification = remainingUsageCount === expectedRemaining
        && applied.changedRows === current.impact.replaceableCount
        ? 'verified'
        : 'partial';
    } catch (verifyError) {
      // 差し替え自体はD1のbatchで確定済み。ここで500を返すと、利用者が
      // 再実行して二重操作するため「確認できなかった」と成功レスポンスに残す。
      logger.error("contents.media_id_replace_usages_post_failed");
    }
    return c.json({
      success: true,
      data: {
        sourceId: current.plan.source.id,
        replacementId: current.plan.replacement.id,
        mode: applied.mode,
        replacedUsageCount: applied.changedRows,
        skippedUsageCount: applied.skippedUsageCount,
        remainingUsageCount,
        verification,
        checkedAt: verifiedAt,
      },
    });
  } catch (err) {
    if (err instanceof RequestBodyError) {
      return inputError(c, { success: false, error: err.message }, err.status, []);
    }
    logger.error("contents.media_id_replace_usages_post_failed");
    return c.json({ success: false, error: '使用先を差し替えられませんでした' }, 503);
  }
};

export const delete__api_media_id_8 = async (c: Context<Env, "/api/media/:id">) => {
  try {
    const id = c.req.param('id');
    const accountId = c.req.query('accountId')?.trim();
    if (!accountId) return fail(c, 400, 'ACCOUNT_ID_REQUIRED');
    if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [accountId])) {
      return c.json({ success: false, error: 'Not found' }, 404);
    }
    const existing = await getMediaById(c.env.DB, id, accountId);
    if (!existing) return c.json({ success: false, error: 'Not found' }, 404);

    const checkedAt = jstNow();
    const scan = await scanSingleMediaUsage(c.env.DB, checkedAt, {
      id: existing.id,
      r2_key: existing.r2_key,
    });
    const snapshot = await getMediaDeleteImpactSnapshot(c.env.DB, id, accountId, checkedAt);
    if (!snapshot) return c.json({ success: false, error: 'Not found' }, 404);
    const direct = await findDirectMediaUsages(c.env.DB, existing, accountId);
    // R34: 読み残しがあるときは使われていないと断定できない。確かめられ
    // ないものは消させない（ fail-closed）。読み直しを促す409で返す。
    const verified = (scan.skippedTables ?? []).length === 0;
    const baseImpact = { ...snapshot.impact, usageCount: snapshot.impact.usageCount + direct.length, references: [...snapshot.impact.references, ...direct.map(row => ({ kind:row.refKind, name:row.name, href:row.href, state:'available' as const, scannedAt:checkedAt }))], canDelete: snapshot.impact.canDelete && direct.length === 0, recommendedAction: direct.length ? 'review_references' as const : snapshot.impact.recommendedAction };
    const impact = verified ? baseImpact : {
      ...baseImpact,
      canDelete: false,
      recommendedAction: 'review_references' as const,
    };
    if (!impact.canDelete) {
      return c.json(
        verified
          ? {
            success: false,
            error: `このファイルは ${impact.usageCount} か所で使われています。先に使用先から外してください。`,
            code: 'media_delete_blocked',
            data: { ...impact, verified },
          }
          : {
            success: false,
            error: '使用先を確かめられなかったため削除できません。使用先を読み直してから、もう一度お試しください。',
            code: 'media_delete_unverified',
            data: { ...impact, verified },
          },
        409,
      );
    }

    // 実体の削除失敗は記録を保持して再試行できるようにする。
    if (!c.env.IMAGES) return c.json({ success: false, code: 'MEDIA_STORAGE_UNAVAILABLE', error: '保管庫へ接続できないため削除していません' }, 503);
    const lock = await claimFileDeletion(c.env.DB, mediaDeletionLockId(id), c.get('staff')?.id ?? 'unknown');
    if (!lock) return c.json({ success: false, error: 'ファイルの状態が変わりました。読み直してください' }, 409);
    try {
      const latest = await getMediaById(c.env.DB, id, accountId);
      if (!latest || latest.r2_key !== existing.r2_key) {
        await releaseFileDeletion(c.env.DB, lock);
        return c.json({ success: false, error: 'ファイルの状態が変わりました。読み直してください' }, 409);
      }
      const keys = await getMediaVersionKeys(c.env.DB, id);
      await fileDeletionGuard(c.env.DB, lock).first();
      await c.env.IMAGES.delete([...new Set([existing.r2_key, ...keys])]);
      await deleteMedia(c.env.DB, id, accountId, { lockId: lock.id, token: lock.token, r2Key: existing.r2_key });
    } catch {
      await releaseFileDeletion(c.env.DB, lock).catch(() => {});
      return c.json({ success: false, code: 'MEDIA_STORAGE_DELETE_FAILED', error: 'ファイルを削除できませんでした。記録を保持しているので、もう一度お試しください' }, 503);
    }
    return c.json({ success: true, data: null });
  } catch (err) {
    logger.error("contents.media_id_delete_failed");
    return c.json({ success: false, error: '削除したときの影響を確認できませんでした' }, 503);
  }
};

export const get__api_common_vars_9 = async (c: Context<Env, "/api/common-vars">) => {
  const accountId = c.req.query('accountId')?.trim();
  if (!accountId) return fail(c, 400, 'ACCOUNT_ID_REQUIRED');
  if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [accountId])) {
    return c.json({ success: false, error: 'Not found' }, 404);
  }
  const { limit } = parseOffsetPaging({ limit: c.req.query('limit') }, { defaultLimit: COMMON_VARS_LIST_LIMIT, limitPolicy: { fallback: 'finite', truncate: true, minimum: 1, maximum: COMMON_VARS_LIST_LIMIT } });
  const folderId = c.req.query('folderId') || undefined;
  const [items, total] = await Promise.all([
    getCommonVars(c.env.DB, { lineAccountId: accountId, folderId, limit }),
    countCommonVars(c.env.DB, { lineAccountId: accountId, folderId }),
  ]);
  const usageSummaries = await getCommonVarUsageSummaries(
    c.env.DB,
    items.map((item) => item.var_key),
    accountId,
  );
  for (const item of items) {
    const summary = usageSummaries.get(item.var_key);
    item.usage_count = summary?.total ?? 0;
    item.usage_by_kind = summary?.byKind ?? Object.fromEntries(
      Object.keys(COMMON_VAR_USAGE_KIND_LABELS).map((kind) => [kind, 0]),
    ) as CommonVar['usage_by_kind'];
  }
  const responseItems = items.map(serializeVar);
  return c.json(buildOffsetListResponse({ success: true,
    data: responseItems,
    meta: { total, limited: total > items.length, limit }, items: responseItems, total: total, paging: { limit, offset: 0 }, sort: [{ field: 'name', direction: 'asc' }] }));
};

export const get__api_common_vars_id_10 = async (c: Context<Env, "/api/common-vars/:id">) => {
  try {
    const accountId = c.req.query('accountId')?.trim();
    if (!accountId) return fail(c, 400, 'ACCOUNT_ID_REQUIRED');
    if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [accountId])) {
      return c.json({ success: false, error: 'Not found' }, 404);
    }
    const variable = await getCommonVarByIdIncludingArchived(c.env.DB, c.req.param('id'), accountId);
    if (!variable) return c.json({ success: false, error: 'Not found' }, 404);
    const [impact, versions] = await Promise.all([
      variable.archived_at
        ? Promise.resolve(emptyCommonVarUsageImpact())
        : getCommonVarUsageImpact(c.env.DB, variable.var_key, accountId),
      getCommonVarVersions(c.env.DB, variable.id, accountId, 20),
    ]);
    const serializedImpact = serializeCommonVarDeleteImpact(variable, impact);
    variable.usage_count = impact.total;
    variable.usage_by_kind = impact.byKind;
    return c.json({
      success: true,
      data: {
        ...serializeVar(variable),
        usages: serializedImpact.items.slice(0, 15),
        usagePage: {
          total: impact.total,
          shown: Math.min(serializedImpact.items.length, 15),
          hasMore: impact.total > 15,
          unavailableCount: impact.unscopedFormTotal,
        },
        history: versions.map((version) => ({
          id: version.id,
          version: Number(version.version_no),
          name: version.name,
          value: version.value,
          memo: version.memo,
          changeReason: version.change_reason,
          actorId: version.actor_id,
          actorName: version.actor_name,
          createdAt: version.created_at,
        })),
      },
    });
  } catch (err) {
    logger.error("contents.common_vars_id_get_failed");
    return c.json({ success: false, error: '共通情報の詳細を確認できませんでした' }, 503);
  }
};
