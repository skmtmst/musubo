import { UnexpectedRouteError } from '../lib/unhandled-error.js';
import { logger } from '@line-crm/shared/server';
import { sqlIdSet } from '@line-crm/db/id-queries';
import { inputError } from '../lib/input-errors.js';
import { fail } from '../lib/fail.js';
import { findRewardedAdoptedDuplicate, getEffectivePhotoRewardPolicy, jstNow } from '@line-crm/db';
import type { Env } from '../worker-env.js';

import { getFileScanBySubject, runScanForStoredObject } from '../services/file-scan.js';
import { ensureFileScanForUpload } from './file-scan.js';
import { canAccessAllLineAccounts, getVisibleLineAccountScope } from '../services/account-access.js';
import { installNenRichMenu } from '../services/nen-rich-menu.js';
import { attemptPhotoRewardForPhoto } from '../services/photo-reward-sync.js';
import { refreshAllNenTags, syncNenPhotoTags } from '../services/nen-tag-sync.js';
import { PHOTO_REVIEW_REASON_LABELS, loadPhotoReviewRecipient, isSameReviewRequest, reviewDuplicateResponse, SavedReviewEvent, ecPhotoPointClient, deliverPhotoReviewNotification, PhotoReviewReasonCode, handlePhotoRewardAction, ReviewPhotoRow, adminAccountScope } from './nen-members-definition.js';
import type { Context } from 'hono';

export const put__api_nen_members_photos_id_review_1 = async (c: Context<Env, "/api/nen-members/photos/:id/review">) => {
  const body = await c.req.json<{
    accountId?: string;
    status?: string;
    reasonCode?: string;
    reasonNote?: string;
    expectedVersion?: number;
    resubmitInvite?: boolean;
    watchSubmitter?: boolean;
    // 重複のときの「報酬なしで採用」。点数を付けずに採用だけ残す。
    withoutReward?: boolean;
  }>().catch(() => null);
  const accountId = body?.accountId?.trim();
  // 再実行キー。連打・応答ロストのやり直しが「別の担当者が更新しました」に
  // 化けないよう、一括審査や派生画像処理と同じく必須にする。
  const key = c.req.header('Idempotency-Key')?.trim() ?? '';
  if (!accountId || key.length < 8 || key.length > 200) {
    return inputError(c, { success: false, error: '対象アカウントと再実行キーを確認してください' }, 400, ["accountId"]);
  }
  if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [accountId])) {
    return c.json({ success: false, error: 'このLINEアカウントを操作する権限がありません' }, 403);
  }
  const status = String(body?.status || '');
  if (!['adopted', 'rejected'].includes(status)) return inputError(c, { success: false, error: 'Invalid review' }, 400, ["status"]);
  if (!Number.isInteger(body?.expectedVersion)) return inputError(c, { success: false, error: 'expectedVersion is required' }, 400, ["expectedVersion"]);
  const reasonCode = status === 'rejected' ? String(body?.reasonCode || '') : '';
  const reasonNote = String(body?.reasonNote || '').trim().slice(0, 500);
  if (status === 'rejected' && !Object.prototype.hasOwnProperty.call(PHOTO_REVIEW_REASON_LABELS, reasonCode)) {
    return inputError(c, { success: false, error: '見送る理由を選んでください' }, 400, ["status","reasonCode"]);
  }
  if (status === 'rejected' && reasonCode === 'other' && !reasonNote) {
    return inputError(c, { success: false, error: 'そのほかの理由を入力してください' }, 400, ["status","reasonCode","reasonNote"]);
  }
  // 「もう一度送ってもらえるようお願いする」。採用には関係しない。
  const resubmitInvite = status !== 'rejected' || body?.resubmitInvite !== false;
  const watchSubmitter = status === 'rejected' && body?.watchSubmitter === true;
  const photo = await loadPhotoReviewRecipient(
    c.env.DB, { photoId: c.req.param('id'), lineAccountId: accountId },
  );
  if (!photo) return c.json({ success: false, error: 'Not found' }, 404);
  /*
   * 同じ再実行キーの判断は、保存済みの結果をそのまま返す。
   * キーだけ合って中身が違うときは、別の操作の取り違えなので衝突として止める。
   */
  const previous = await c.env.DB.prepare(
    `SELECT to_status, reason_code, reason_note, awarded_points, notification_status
       FROM nen_photo_review_events
      WHERE photo_id = ? AND line_account_id = ? AND idempotency_key = ?`,
  ).bind(c.req.param('id'), accountId, key).first<{
    to_status: string; reason_code: string | null; reason_note: string | null;
    awarded_points: number; notification_status: string;
  }>();
  if (previous) {
    const same = isSameReviewRequest(previous, status, reasonCode, reasonNote);
    if (!same) {
      return c.json({ success: false, error: '同じ再実行キーが別の入力に使われています', code: 'IDEMPOTENCY_CONFLICT' }, 409);
    }
    return reviewDuplicateResponse(c, photo.customer_id, previous);
  }
  if (photo.status !== 'pending' || Number(photo.review_version) !== body!.expectedVersion) {
    return c.json({ success: false, error: 'Already reviewed', code: 'VERSION_CONFLICT' }, 409);
  }
  if (status === 'adopted') {
    // 検査が終わるまで採用しない。失敗時は審査へ流さない（-22 §4）。
    const targetPhotoId = c.req.param('id');
    let photoScan = await getFileScanBySubject(c.env.DB, 'photo', targetPhotoId);
    if (!photoScan) {
      const row = await c.env.DB.prepare(
        `SELECT r2_key, content_type, image_width, image_height, image_byte_size, line_account_id
           FROM nen_photo_submissions WHERE id = ?`,
      ).bind(targetPhotoId).first<{
        r2_key: string; content_type: string; image_width: number | null;
        image_height: number | null; image_byte_size: number | null; line_account_id: string;
      }>();
      // 大きさが分からない古い行では検査の記録を作れない。作らず門番に
      // 409 で止めてもらい、500 にしない。
      if (row && Number.isSafeInteger(row.image_byte_size) && (row.image_byte_size as number) >= 0) {
        try {
          const created = await ensureFileScanForUpload({
            db: c.env.DB,
            lineAccountId: row.line_account_id,
            subjectKind: 'photo',
            subjectId: targetPhotoId,
            mediaId: null,
            filename: `photo.${targetPhotoId}`,
            mimeType: row.content_type,
            sizeBytes: row.image_byte_size as number,
          });
          photoScan = await runScanForStoredObject(c.env.DB, c.env.IMAGES, created, row.r2_key, {
            width: row.image_width, height: row.image_height,
          }).catch(() => created);
        } catch {
          photoScan = null;
        }
      }
    }
    if (!photoScan || photoScan.status !== 'clean') {
      const message = !photoScan || photoScan.status === 'pending'
        ? '確かめています。確かめ終わるまで採用できません'
        : '確認のため採用できません。管理者が確かめるまで、どこにも出ません';
      return c.json({ success: false, code: 'file_scan_blocked', error: message }, 409);
    }
  }
  /*
   * 採用する時点の報酬の決まりを写す。版を変えても過去の付与は
   * 変わらない。同じ写真が2回採用されても報酬は1回だけ——報酬つきで
   * 採用済みの重複があるときは、選んだ操作に関わらず点数を付けない。
   */
  const policy = status === 'adopted' ? await getEffectivePhotoRewardPolicy(c.env.DB) : null;
  const rewardedDuplicate = status === 'adopted'
    ? await findRewardedAdoptedDuplicate(c.env.DB, {
      contentHash: typeof photo.content_hash === 'string' ? photo.content_hash as string : null,
      lineAccountId: accountId,
      excludePhotoId: c.req.param('id'),
    })
    : null;
  const withoutReward = status === 'adopted' && body?.withoutReward === true;
  const awarded = status === 'adopted' && policy && !withoutReward && !rewardedDuplicate
    ? policy.points
    : 0;
  const rewardSkipped: 'duplicate' | 'requested' | null = status !== 'adopted'
    ? null
    : rewardedDuplicate ? 'duplicate' : withoutReward ? 'requested' : null;
  const pointSync: 'pending' | 'needs_attention' | 'not_required' = awarded <= 0
    ? 'not_required'
    : photo.customer_id ? 'pending' : 'needs_attention';
  const now = jstNow();
  const decisionId = crypto.randomUUID();
  try {
    const reviewer = c.get('staff');
    const results = await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO nen_photo_review_events
          (id, photo_id, line_account_id, from_status, to_status, reason_code, reason_note,
           awarded_points, reviewed_by, reviewed_by_name, notification_status,
           idempotency_key, resubmit_invite, created_at, updated_at)
         SELECT ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?
           FROM nen_photo_submissions
          WHERE id = ? AND line_account_id = ? AND status = 'pending' AND review_version = ?`,
      ).bind(
        decisionId, c.req.param('id'), accountId, status, reasonCode || null, reasonNote || null,
        awarded, reviewer.id, reviewer.name, key, resubmitInvite ? 1 : 0, now, now,
        c.req.param('id'), accountId, body!.expectedVersion,
      ),
      c.env.DB.prepare(
        `UPDATE nen_photo_submissions
            SET status = ?, awarded_points = ?, review_reason_code = ?, review_reason_note = ?,
                reviewed_by = ?, reviewed_by_name = ?, review_notification_status = 'pending',
                reviewed_at = ?,
                public_image_url = CASE WHEN ? = 'adopted'
                  THEN COALESCE(public_image_url, review_image_url) ELSE public_image_url END,
                review_version = review_version + 1, updated_at = ?
          WHERE id = ? AND line_account_id = ? AND status = 'pending' AND review_version = ?`,
      ).bind(
        status, awarded, reasonCode || null, reasonNote || null, reviewer.id, reviewer.name,
        now, status, now, c.req.param('id'), accountId, body!.expectedVersion,
      ),
      ...(status === 'adopted' && awarded > 0 && photo.customer_id && policy ? [c.env.DB.prepare(
        `INSERT INTO nen_photo_reward_outbox
          (id, photo_id, line_account_id, friend_id, customer_id, provider_award_key,
           policy_version, points, status, next_attempt_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      ).bind(
        crypto.randomUUID(), photo.id, accountId, photo.friend_id, photo.customer_id,
        `nen-photo:${String(photo.id)}`, policy.policyKey, awarded, now, now, now,
      )] : []),
      // 「この人の次の投稿は、必ず人が見る」。確認対象の印を
      // 友だちへ残し、次に届く写真の一覧へ出す。
      ...(watchSubmitter ? [c.env.DB.prepare(
        `UPDATE friends SET photo_watch_required = 1, updated_at = ?
          WHERE id = ? AND line_account_id = ?`,
      ).bind(now, photo.friend_id, accountId)] : []),
    ]);
    if (!results[0]?.meta.changes || !results[1]?.meta.changes) {
      return c.json({ success: false, error: 'Already reviewed', code: 'VERSION_CONFLICT' }, 409);
    }
  } catch (error) {
    /*
     * 保存の失敗を「ほかの担当者により更新されました」に化けない。
     * 版の不一致だけが409で、それ以外の保存失敗は500で理由を分ける。
     * 同じ再実行キーの並行到達（UNIQUE）は保存済みを読み直して区別する。
     */
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('UNIQUE constraint failed')) {
      const saved = await c.env.DB.prepare(
        `SELECT to_status, reason_code, reason_note, awarded_points, notification_status
           FROM nen_photo_review_events
          WHERE photo_id = ? AND line_account_id = ? AND idempotency_key = ?`,
      ).bind(c.req.param('id'), accountId, key).first<SavedReviewEvent>();
      if (saved) {
        if (!isSameReviewRequest(saved, status, reasonCode, reasonNote)) {
          return c.json({ success: false, error: '同じ再実行キーが別の入力に使われています', code: 'IDEMPOTENCY_CONFLICT' }, 409);
        }
        return reviewDuplicateResponse(c, photo.customer_id, saved);
      }
      const fresh = await loadPhotoReviewRecipient(
        c.env.DB, { photoId: c.req.param('id'), lineAccountId: accountId },
      );
      if (!fresh || fresh.status !== 'pending' || Number(fresh.review_version) !== body!.expectedVersion) {
        return c.json({ success: false, error: '同じ写真がほかの担当者により更新されました', code: 'VERSION_CONFLICT' }, 409);
      }
    }
    throw new UnexpectedRouteError(c, { success: false, code: 'REVIEW_SAVE_FAILED', error: '保存できませんでした。もう一度お試しください' });
  }
  await syncNenPhotoTags(c.env.DB, String(photo.friend_id));
  /*
   * outbox を積んだら、その場でECへの付与を一度試す。
   * ここで届けば「手続き中」のまま残らない。失敗しても採用そのものは
   * 完了させ、行は pending/failed のまま残り、日次回収・手動の
   * 再試行・照合のどれかで後から進められる。
   */
  let finalPointSync: 'pending' | 'needs_attention' | 'not_required' | 'synced' = pointSync;
  const ecClient = status === 'adopted' && photo.customer_id ? ecPhotoPointClient(c) : undefined;
  if (ecClient) {
    try {
      const attempt = await attemptPhotoRewardForPhoto(
        c.env.DB,
        { photoId: String(photo.id), lineAccountId: accountId },
        ecClient,
        { now: new Date() },
      );
      if (attempt.kind === 'already_synced'
        || (attempt.kind === 'delivered' && attempt.outcome.kind === 'synced')) {
        finalPointSync = 'synced';
      }
    } catch (error) {
      logger.error("nen_members.nen_members_photos_id_review_put_failed");
    }
  }
  const delivery = await deliverPhotoReviewNotification(c.env.DB, c, photo, {
    lineAccountId: accountId,
    photoId: photo.id,
    status: status as 'adopted' | 'rejected',
    reasonCode: reasonCode ? reasonCode as PhotoReviewReasonCode : null,
    reasonNote: reasonNote || null,
    decisionId,
    resubmitInvite,
  });
  return c.json({
    success: true,
    data: {
      awardedPoints: awarded,
      pointBalance: null,
      pointSync: finalPointSync,
      notificationStatus: delivery.notificationStatus,
      rewardSkipped,
    },
  });
};

export const post__api_nen_members_photos_id_point_retry_2 = (c: Context<Env, "/api/nen-members/photos/:id/point-retry">) => handlePhotoRewardAction(c, 'retry');

export const post__api_nen_members_photos_id_point_reconcile_3 = (c: Context<Env, "/api/nen-members/photos/:id/point-reconcile">) => handlePhotoRewardAction(c, 'reconcile');

export const put__api_nen_members_photos_id_rotation_4 = async (c: Context<Env, "/api/nen-members/photos/:id/rotation">) => {
  const body = await c.req.json<{
    accountId?: string;
    rotation?: number;
    expectedVersion?: number;
  }>().catch(() => null);
  const accountId = body?.accountId?.trim();
  const key = c.req.header('Idempotency-Key')?.trim() ?? '';
  if (!accountId || key.length < 8 || key.length > 200) {
    return inputError(c, { success: false, error: '対象アカウントと再実行キーを確認してください' }, 400, ["accountId"]);
  }
  if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [accountId])) {
    return c.json({ success: false, error: 'このLINEアカウントを操作する権限がありません' }, 403);
  }
  const rotation = Number(body?.rotation);
  if (![0, 90, 180, 270].includes(rotation)) {
    return inputError(c, { success: false, error: '向きは0・90・180・270のいずれかです' }, 400, ["rotation"]);
  }
  if (!Number.isInteger(body?.expectedVersion)) {
    return inputError(c, { success: false, error: 'expectedVersion is required' }, 400, ["expectedVersion"]);
  }
  const photo = await c.env.DB.prepare(
    `SELECT id, status, review_version, display_rotation, rotation_idempotency_key
       FROM nen_photo_submissions WHERE id = ? AND line_account_id = ?`,
  ).bind(c.req.param('id'), accountId).first<{
    id: string; status: string; review_version: number;
    display_rotation: number; rotation_idempotency_key: string | null;
  }>();
  if (!photo) return c.json({ success: false, error: 'Not found' }, 404);
  // 同じ再実行キーは保存済みの結果を返す。キーだけ合って向きが違うのは取り違え。
  if (photo.rotation_idempotency_key === key) {
    if (photo.display_rotation !== rotation) {
      return c.json({ success: false, error: '同じ再実行キーが別の入力に使われています', code: 'IDEMPOTENCY_CONFLICT' }, 409);
    }
    return c.json({
      success: true, duplicate: true,
      data: { rotation: photo.display_rotation, reviewVersion: Number(photo.review_version) },
    });
  }
  if (Number(photo.review_version) !== body!.expectedVersion) {
    return c.json({ success: false, error: '同じ写真がほかの担当者により更新されました', code: 'VERSION_CONFLICT' }, 409);
  }
  // 向きの保存も版を進める。直しているあいだに通された版を
  // 上書きすると、通した版と審査した見た目がずれるため。
  const updated = await c.env.DB.prepare(
    `UPDATE nen_photo_submissions
        SET display_rotation = ?, rotation_idempotency_key = ?,
            review_version = review_version + 1, updated_at = ?
      WHERE id = ? AND line_account_id = ? AND review_version = ?`,
  ).bind(rotation, key, jstNow(), c.req.param('id'), accountId, body!.expectedVersion).run();
  if (!updated.meta.changes) {
    return c.json({ success: false, error: '同じ写真がほかの担当者により更新されました', code: 'VERSION_CONFLICT' }, 409);
  }
  return c.json({
    success: true,
    data: { rotation, reviewVersion: body!.expectedVersion + 1 },
  });
};

export const post__api_nen_members_photos_id_notification_retry_5 = async (c: Context<Env, "/api/nen-members/photos/:id/notification/retry">) => {
  const body = await c.req.json<{ accountId?: string }>().catch(() => null);
  const accountId = body?.accountId?.trim();
  // 再実行キー。送達が確定した再送を、同じキーのやり直しが
  // もう一度送らないよう、使ったキーを写真へ記録する。
  const key = c.req.header('Idempotency-Key')?.trim() ?? '';
  if (!accountId || key.length < 8 || key.length > 200) {
    return inputError(c, { success: false, error: '対象アカウントと再実行キーを確認してください' }, 400, ["accountId"]);
  }
  if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [accountId])) {
    return c.json({ success: false, error: 'このLINEアカウントを操作する権限がありません' }, 403);
  }
  const photoMeta = await c.env.DB.prepare(
    `SELECT id, review_notification_status, notification_retry_key
       FROM nen_photo_submissions WHERE id = ? AND line_account_id = ?`,
  ).bind(c.req.param('id'), accountId).first<{
    id: string; review_notification_status: string | null; notification_retry_key: string | null;
  }>();
  if (!photoMeta) return c.json({ success: false, error: 'Not found' }, 404);
  if (photoMeta.notification_retry_key === key) {
    // 同じ再実行キーは送らず、記録済みの結果だけを返す。
    return c.json({
      success: true,
      duplicate: true,
      data: {
        notificationStatus: photoMeta.review_notification_status === 'sent' ? 'sent' : 'failed',
        resent: false,
      },
    });
  }
  const now = new Date().toISOString();
  // 拾い上げる状態は claimPhotoNotificationDelivery の送信権条件と揃える。
  // pending（一括の通知準備で落ちた対象など、まだ一度も送れていないもの）を
  // 外すと、画面に失敗と出ているのに再送だけ 409 で断る食い違いが起きる。
  const row = await c.env.DB.prepare(
    `SELECT ps.id, ps.friend_id, f.line_platform_user_id AS line_user_id, f.line_account_id, f.is_following,
            a.channel_access_token, a.channel_access_token_encrypted,
            e.id decision_id, e.to_status, e.reason_code, e.reason_note, e.resubmit_invite,
            s.customer_id
       FROM nen_photo_submissions ps
       JOIN friends f ON f.id = ps.friend_id
       JOIN line_accounts a ON a.id = f.line_account_id
       JOIN nen_photo_review_events e ON e.photo_id = ps.id
       LEFT JOIN nen_ec_member_snapshots s ON s.friend_id = ps.friend_id
      WHERE ps.id = ? AND ps.line_account_id = ? AND f.line_account_id = ?
        AND (e.notification_status IN ('pending', 'failed')
          OR (e.notification_status = 'sending'
            AND (e.notification_lease_expires_at IS NULL OR e.notification_lease_expires_at <= ?)))
      ORDER BY e.created_at DESC LIMIT 1`,
  ).bind(c.req.param('id'), accountId, accountId, now).first<ReviewPhotoRow & {
    decision_id: string;
    to_status: 'adopted' | 'rejected';
    reason_code: PhotoReviewReasonCode | null;
    reason_note: string | null;
    resubmit_invite: number;
  }>();
  if (!row) {
    const settled = await c.env.DB.prepare(
      `SELECT e.notification_status AS notification_status
         FROM nen_photo_review_events e
        WHERE e.photo_id = ? AND e.line_account_id = ?
        ORDER BY e.created_at DESC LIMIT 1`,
    ).bind(c.req.param('id'), accountId).first<{ notification_status: string }>();
    if (settled?.notification_status === 'sent') {
      return c.json({ success: true, data: { notificationStatus: 'sent', resent: false } });
    }
    return c.json({ success: false, error: '再送する通知がありません' }, 409);
  }
  const delivery = await deliverPhotoReviewNotification(c.env.DB, c, row, {
    lineAccountId: accountId,
    photoId: row.id,
    status: row.to_status,
    reasonCode: row.reason_code,
    reasonNote: row.reason_note,
    decisionId: row.decision_id,
    // 差戻し時に選んだ再投稿案内の有無を、審査イベントから復元する。
    resubmitInvite: row.resubmit_invite !== 0,
  });
  if (delivery.notificationStatus === 'sent') {
    // 送達できた再送に限りキーを記録する。失敗した試行は同じキーでやり直せる。
    await c.env.DB.prepare(
      `UPDATE nen_photo_submissions SET notification_retry_key = ? WHERE id = ? AND line_account_id = ?`,
    ).bind(key, row.id, accountId).run();
    return c.json({ success: true, data: { notificationStatus: 'sent', resent: delivery.relayed } });
  }
  if (delivery.busy) {
    return c.json({ success: false, error: delivery.notificationError }, 409);
  }
  return c.json({ success: false, error: delivery.notificationError }, 502);
};

export const post__api_nen_members_tags_resync_6 = async (c: Context<Env, "/api/nen-members/tags/resync">) => {
  const body: { limit?: number } = await c.req.json<{ limit?: number }>().catch(() => ({}));
  const limit = Number.isFinite(body.limit) ? Number(body.limit) : 500;
  const scope = await getVisibleLineAccountScope(c.env.DB, c.get('staff'));
  const result = await refreshAllNenTags(c.env.DB, [
    ...scope.allowedAccountIds,
    ...(scope.canSeeUnassigned ? [null] : []),
  ], limit);
  return c.json({ success: true, data: result });
};

export const get__api_nen_members_friends_friendId_7 = async (c: Context<Env, "/api/nen-members/friends/:friendId">) => {
  const friendId = c.req.param('friendId');
  const friend = await c.env.DB.prepare(
    `SELECT f.id, f.line_platform_user_id AS line_user_id, f.display_name, f.picture_url, f.is_following,
            f.created_at, f.updated_at, f.line_account_id, la.name AS line_account_name
       FROM friends f
       LEFT JOIN line_accounts la ON la.id = f.line_account_id
      WHERE f.id = ?`,
  ).bind(friendId).first<Record<string, unknown>>();
  if (!friend || !await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [friend.line_account_id as string | null])) return fail(c, 404, 'FRIEND_NOT_FOUND');

  const [member, pets, healthLogs, photos, pointLedger, ecEvents] = await Promise.all([
    c.env.DB.prepare(`SELECT * FROM nen_ec_member_snapshots WHERE friend_id = ?`).bind(friendId).first<Record<string, unknown>>(),
    c.env.DB.prepare(`SELECT * FROM nen_pet_profiles WHERE archived_at IS NULL AND friend_id = ? ORDER BY created_at ASC`).bind(friendId).all<Record<string, unknown>>(),
    c.env.DB.prepare(`SELECT * FROM nen_health_logs WHERE friend_id = ? ORDER BY logged_on DESC LIMIT 100`).bind(friendId).all<Record<string, unknown>>(),
    c.env.DB.prepare(
      `SELECT ps.id, ps.friend_id, ps.pet_id, ps.caption, ps.status, ps.awarded_points,
              ps.point_transaction_id, ps.created_at, ps.reviewed_at, ps.updated_at,
              ps.line_account_id, ps.publication_consent_version, ps.publication_consent_at,
              ps.publication_withdrawn_at, ps.public_pet_name, ps.review_reason_code,
              ps.review_reason_note, ps.reviewed_by, ps.reviewed_by_name,
              ps.review_notification_status, ps.review_image_url, ps.public_image_url,
              ps.image_width, ps.image_height, ps.image_byte_size, ps.captured_device,
              ps.review_version, p.name AS pet_name
         FROM nen_photo_submissions ps
         LEFT JOIN nen_pet_profiles p ON p.id = ps.pet_id
        WHERE ps.friend_id = ?
        ORDER BY ps.created_at DESC LIMIT 100`,
    ).bind(friendId).all<Record<string, unknown>>(),
    c.env.DB.prepare(`SELECT * FROM nen_point_ledger WHERE friend_id = ? ORDER BY created_at DESC LIMIT 100`).bind(friendId).all<Record<string, unknown>>(),
    c.env.DB.prepare(`SELECT id, source, external_event_id, event_type, customer_id, status, error_message, received_at, processed_at FROM ec_events WHERE friend_id = ? ORDER BY received_at DESC LIMIT 100`).bind(friendId).all<Record<string, unknown>>(),
  ]);

  return c.json({
    success: true,
    data: {
      friend,
      member: member || null,
      pets: pets.results,
      healthLogs: healthLogs.results,
      photos: photos.results,
      pointLedger: pointLedger.results,
      ecEvents: ecEvents.results,
    },
  });
};

export const get__api_nen_members_ranks_8 = async (c: Context<Env, "/api/nen-members/ranks">) => {
  const { scope, where } = await adminAccountScope(c);
  const rows = await c.env.DB.prepare(`SELECT s.*, f.display_name, f.line_platform_user_id AS line_user_id FROM nen_ec_member_snapshots s JOIN friends f ON f.id=s.friend_id WHERE 1 = 1 ${where} ORDER BY s.purchase_amount DESC LIMIT 300`).bind(...(scope.allowedAccountIds.length ? sqlIdSet(scope.allowedAccountIds).binds : [])).all<Record<string, unknown>>();
  return c.json({ success: true, data: rows.results });
};

export const post__api_nen_members_rich_menu_install_9 = async (c: Context<Env, "/api/nen-members/rich-menu/install">) => {
  const body = await c.req.json<{ accountId?: string }>().catch(() => null);
  if (!body?.accountId) return fail(c, 400, 'ACCOUNT_ID_REQUIRED', {}, ["accountId"]);
  if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [body.accountId])) {
    return c.json({ success: false, error: 'このLINEアカウントを操作する権限がありません' }, 403);
  }
  try {
    const result = await installNenRichMenu(c.env, body.accountId);
    return c.json({ success: true, data: result }, 201);
  } catch (error) {
    return c.json({ success: false, error: String(error) }, 409);
  }
};
