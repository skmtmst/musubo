import { truncatedListLimit, truncatedListOffset } from '../lib/list-paging.js';
import { logger } from '@line-crm/shared/server';
import { petCard } from './nen-pet-card.js';
import { sqlIdSet } from '@line-crm/db/id-queries';
import { isCalendarDate as isExistingCalendarDate } from '@line-crm/shared';
import { inputError } from '../lib/input-errors.js';
import { type Context } from 'hono';
import { claimPhotoNotificationDelivery, completePhotoNotificationDelivery, getPhotoNotificationState, resolveLineCredential } from '@line-crm/db';
import * as dbPackage from '@line-crm/db';
import type { Env } from '../worker-env.js';
import { type FriendRow } from '../services/nen-member-identity.js';
import { pushViaHarnessProxy } from '../services/line-proxy-send.js';
import { classifyExternalDeliveryError } from '../services/external-delivery-retry.js';
import { dispatchLineProxyLocally } from '../services/local-line-proxy.js';
import { canAccessAllLineAccounts, getVisibleLineAccountScope } from '../services/account-access.js';
import { type FeedingPlan, type FeedingProductRow, DEFAULT_TREAT_LIMIT_PERCENT, getTreatLimitPercent, listFeedingProducts, nenProducts, productKind, stapleProducts, neuteredFromInput, neuteredFromRow, normalizeActivity, planForPetRow } from '../services/nen-feeding.js';
import { attemptPhotoRewardForPhoto, ecPhotoPointClientFromEnv, PHOTO_REWARD_REASON_LABELS, type EcPhotoPointClient } from '../services/photo-reward-sync.js';
import { petCallName, petGender } from '../services/nen-pet-name.js';
import { isFeedingSupportedAnimal, toPetAnimalType } from '../lib/nen-pet-species.js';

export const CONCERNS = new Set(['tear_stain', 'coat', 'allergy', 'appetite', 'stool', 'weight', 'other']);
export const IMAGE_TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
export /*
 * 採用1枚の点数は固定値ではなく、その時点で使っている報酬の決まりの版を
 * 見る。版が無い古いDBでは5ptへ倒す。ここに数は書かない。
 */

/*
 * ECへのポイント付与の接続先。誕生日クーポン（index.ts の cron）と同じ
 * 2変数で決める。未設定の環境では outbox は積んだままにして、
 * 「手続き中」→24時間で「要対応」と画面へ正直に出す（PHOTO-06）。
 */
function ecPhotoPointClient(c: Context<Env>): EcPhotoPointClient | undefined {
  return ecPhotoPointClientFromEnv(c.env);
}

export /** 一覧の point_sync_status を生のstatusではなく運用向けの派生状態で返すSQL。 */
const PHOTO_REWARD_STATE_CASE = `
  CASE
    WHEN o.status = 'synced' THEN 'synced'
    WHEN o.status = 'failed' AND o.last_error IN
      ('customer_unlinked', 'invalid_award', 'ec_auth_failed', 'attempts_exhausted')
      THEN 'failed_permanent'
    WHEN o.status = 'failed' THEN 'failed_retryable'
    WHEN o.updated_at < ? THEN 'stale'
    ELSE 'pending'
  END`;

export const PHOTO_REVIEW_REASON_LABELS = {
  quality: '写真が暗い・ぼやけている',
  privacy: '人の顔や個人情報が写っている',
  unrelated: 'ペットと関係のない内容が写っている',
  duplicate: '同じ写真がすでに投稿されている',
  other: 'そのほか',
} as const;
export type PhotoReviewReasonCode = keyof typeof PHOTO_REVIEW_REASON_LABELS;

export function detectedImageMime(bytes: Uint8Array): keyof typeof IMAGE_TYPES | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e
      && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a
      && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'image/png';
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF'
      && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') return 'image/webp';
  return null;
}

export function dateOnly(value: unknown): string | null {
  return isExistingCalendarDate(value) ? value : null;
}

export function feedingGuide(animalType: string, weightKg: number) {
  // NENの初期目安。主食商品の熱量・年齢・活動量・体調で調整する前提で、
  // LIFF画面にも必ず「医療判断ではない目安」と表示する。
  // 係数は犬・猫専用。「その他」に犬の式を当てず null を返す。
  if (!isFeedingSupportedAnimal(toPetAnimalType(animalType))) return null;
  const minPerKg = animalType === 'cat' ? 25 : 20;
  const maxPerKg = animalType === 'cat' ? 35 : 30;
  const min = Math.max(1, Math.round(weightKg * minPerKg));
  const max = Math.max(min, Math.round(weightKg * maxPerKg));
  const daily = Math.round((min + max) / 2);
  return {
    daily, min, max,
    venison: Math.max(1, Math.round(daily * 0.1)),
    cycleDays: Math.max(1, Math.round(1000 / daily)),
  };
}

export async function pushPetCard(c: Context<Env>, friend: FriendRow, pet: Record<string, unknown>) {
  if (!friend.channel_access_token) return;
  const accessToken = await resolveLineCredential(
    friend.channel_access_token_encrypted,
    friend.channel_access_token,
    {
      lineAccountId: friend.line_account_id ?? 'unassigned',
      field: 'channel_access_token',
    },
  );
  await pushViaHarnessProxy(
    c.env.WORKER_PUBLIC_URL || new URL(c.req.url).origin,
    accessToken,
    friend.line_user_id,
    [petCard(pet)],
    crypto.randomUUID(),
    (request) => dispatchLineProxyLocally(request, c.env, c.executionCtx),
  );
}

export type ReviewPhotoRow = Record<string, unknown> & {
  id: string;
  friend_id: string;
  line_user_id: string;
  line_account_id: string;
  is_following: number;
  channel_access_token: string | null;
  channel_access_token_encrypted: string | null;
};

export /*
 * 投稿者へ届く審査結果の文面。
 *
 * `pointsQueued` は EC 会員とつながっていて付与アウトボックスへ
 * 実際に積んだときだけ true。つながっていない採用に
 * 「ポイントを付ける手続きを始めました」と届けるのは、
 * できていない約束を本人へ伝えることになる。
 *
 * `resubmitInvite` は差戻し画面の「もう一度送ってもらえるようお願いする」。
 * チェックを外して保存した分には案内を添えない。
 */
function photoReviewMessage(
  status: 'adopted' | 'rejected',
  reasonCode: PhotoReviewReasonCode | null,
  reasonNote: string | null,
  options: { pointsQueued: boolean; resubmitInvite: boolean },
): string {
  if (status === 'adopted') {
    return [
      'お写真をご投稿いただきありがとうございます。',
      options.pointsQueued
        ? '今回のお写真を採用し、ポイントを付ける手続きを始めました。'
        : '今回のお写真を採用しました。',
      '公開への同意をいただいている場合だけ、公開ギャラリーへ掲載します。',
    ].join('\n');
  }
  const reason = reasonCode ? PHOTO_REVIEW_REASON_LABELS[reasonCode] : PHOTO_REVIEW_REASON_LABELS.other;
  return [
    'お写真をご投稿いただきありがとうございます。',
    `今回は「${reason}」のため、掲載を見送らせていただきました。`,
    ...(reasonNote ? [reasonNote] : []),
    ...(options.resubmitInvite
      ? ['内容をご確認のうえ、よろしければ別のお写真をご投稿ください。']
      : []),
  ].join('\n');
}

export async function sendPhotoReviewNotification(
  c: Context<Env>,
  photo: ReviewPhotoRow,
  status: 'adopted' | 'rejected',
  reasonCode: PhotoReviewReasonCode | null,
  reasonNote: string | null,
  decisionId: string,
  options: { pointsQueued: boolean; resubmitInvite: boolean },
): Promise<void> {
  if (!photo.is_following) throw new Error('LINEの友だちではないため通知できません');
  const accessToken = await resolveLineCredential(
    photo.channel_access_token_encrypted,
    photo.channel_access_token,
    { lineAccountId: photo.line_account_id, field: 'channel_access_token' },
  );
  const message = photoReviewMessage(status, reasonCode, reasonNote, options);
  // X-Line-Retry-Key はLINE仕様でUUID形式が必須のため、UUIDのdecisionIdをそのまま使う。
  // `nen-photo-review:` 接頭辞を付けると実送信が400で失敗する。
  await pushViaHarnessProxy(
    c.env.WORKER_PUBLIC_URL || new URL(c.req.url).origin,
    accessToken,
    photo.line_user_id,
    [{ type: 'text', text: message }],
    decisionId,
    (request) => dispatchLineProxyLocally(request, c.env, c.executionCtx),
  );
}

/**
 * 通知先の1行を取る。単票・一括どちらも同じ絞り込み
 *（写真ID＋LINEアカウント＋友だちの所属アカウント）で、他アカウントへは届けない。
 */
export async function loadPhotoReviewRecipient(
  db: D1Database,
  input: { photoId: string; lineAccountId: string },
): Promise<ReviewPhotoRow | null> {
  return db.prepare(
    `SELECT ps.*, s.customer_id, f.line_platform_user_id AS line_user_id, f.line_account_id, f.is_following,
            a.channel_access_token, a.channel_access_token_encrypted
       FROM nen_photo_submissions ps
       JOIN friends f ON f.id = ps.friend_id
       JOIN line_accounts a ON a.id = f.line_account_id
       LEFT JOIN nen_ec_member_snapshots s ON s.friend_id = ps.friend_id
      WHERE ps.id = ? AND ps.line_account_id = ? AND f.line_account_id = ?`,
  ).bind(input.photoId, input.lineAccountId, input.lineAccountId).first<ReviewPhotoRow>();
}

/**
 * 通知leaseの有効期間。確定に失敗した送信中は、切れた後に同じ安定keyで
 * 再送・再照合できる（送達状態機械）。
 */
export const PHOTO_NOTIFICATION_LEASE_TTL_MS = 5 * 60 * 1000;

export async function mirrorReviewNotificationStatus(
  db: D1Database,
  input: { photoId: string; lineAccountId: string; status: 'pending' | 'sent' | 'failed'; now?: string },
): Promise<void> {
  try {
    await db.prepare(
      `UPDATE nen_photo_submissions SET review_notification_status = ?, updated_at = ?
        WHERE id = ? AND line_account_id = ?`,
    ).bind(
      input.status, input.now ?? new Date().toISOString(), input.photoId, input.lineAccountId,
    ).run();
  } catch (error) {
    logger.error("nen_members.mirror_review_notification_status_failed");
  }
}

/*
 * 通知の送達オーケストレーション。claim→送信（安定key）→世代条件付き確定。
 * 確定に失敗したら送達不明のまま残し、lease切れ後の再送で復旧できる。
 * relayed は今回の呼び出しが実際に送信したかどうか。
 */
export async function deliverPhotoReviewNotification(
  db: D1Database,
  c: Context<Env>,
  recipient: ReviewPhotoRow,
  input: {
    lineAccountId: string;
    photoId: string;
    status: 'adopted' | 'rejected';
    reasonCode: PhotoReviewReasonCode | null;
    reasonNote: string | null;
    decisionId: string;
    /** 差戻しメッセージへ再投稿の案内を添えるか。省略時は添える。 */
    resubmitInvite?: boolean;
  },
): Promise<{ notificationStatus: 'sent' | 'failed'; notificationError: string | null; busy: boolean; relayed: boolean }> {
  const now = new Date().toISOString();
  const claimed = await claimPhotoNotificationDelivery(db, {
    decisionId: input.decisionId, lineAccountId: input.lineAccountId,
    leaseId: crypto.randomUUID(),
    leaseExpiresAt: new Date(Date.now() + PHOTO_NOTIFICATION_LEASE_TTL_MS).toISOString(),
    now,
  });
  if (!claimed) {
    const state = await getPhotoNotificationState(db, {
      decisionId: input.decisionId, lineAccountId: input.lineAccountId,
    }).catch(() => null);
    if (state?.status === 'sent') {
      await mirrorReviewNotificationStatus(db, {
        photoId: input.photoId, lineAccountId: input.lineAccountId, status: 'sent',
      });
      return { notificationStatus: 'sent', notificationError: null, busy: false, relayed: false };
    }
    if (state?.status === 'sending') {
      return {
        notificationStatus: 'failed', busy: true, relayed: false,
        notificationError: 'ほかの処理が通知を実行中です。しばらくしてから再送してください。',
      };
    }
    return {
      notificationStatus: 'failed', busy: false, relayed: false,
      notificationError: '通知の送信権を確保できませんでした。再送してください。',
    };
  }
  let sendError: string | null = null;
  let relayed = false;
  try {
    await sendPhotoReviewNotification(
      c, recipient, input.status, input.reasonCode, input.reasonNote, input.decisionId,
      {
        // EC 会員とつながっている投稿者へだけ「手続きを始めた」と伝える。
        pointsQueued: input.status === 'adopted' && Boolean(recipient.customer_id),
        resubmitInvite: input.resubmitInvite !== false,
      },
    );
    relayed = true;
  } catch (error) {
    /*
     * LINE 側の応答本文や内部情報を画面へ漏らさないよう、送信失敗は共通の安全な理由へ分類する。原因調査用の生の本文はログだけで扱う。
     */
    logger.error("nen_members.deliver_photo_review_notification_failed");
    sendError = classifyExternalDeliveryError(error).message;
  }
  try {
    const completed = await completePhotoNotificationDelivery(db, {
      decisionId: input.decisionId, lineAccountId: input.lineAccountId,
      generation: claimed.generation, status: sendError ? 'failed' : 'sent', error: sendError,
    });
    if (completed) {
      const finalStatus = sendError ? 'failed' : 'sent';
      await mirrorReviewNotificationStatus(db, {
        photoId: input.photoId, lineAccountId: input.lineAccountId, status: finalStatus,
      });
      return { notificationStatus: finalStatus, notificationError: sendError, busy: false, relayed };
    }
  } catch (error) {
    logger.error("nen_members.deliver_photo_review_notification_failed");
  }
  const state = await getPhotoNotificationState(db, {
    decisionId: input.decisionId, lineAccountId: input.lineAccountId,
  }).catch(() => null);
  if (state?.status === 'sent') {
    await mirrorReviewNotificationStatus(db, {
      photoId: input.photoId, lineAccountId: input.lineAccountId, status: 'sent',
    });
    return { notificationStatus: 'sent', notificationError: null, busy: false, relayed };
  }
  return {
    notificationStatus: 'failed', busy: false, relayed,
    notificationError: '送達の記録を確定できませんでした。しばらくしてから再送してください。',
  };
}

export /**
 * LIFF マイページ（★37-2）に出す会員ランク・マイル。
 * 設定（nen_rank_settings）とECから届いた値（nen_ec_member_snapshots）から組み立てる。
 * ECの値が無い友だちは、これまでの足し算（purchase_amount）を通年の代わりに使う（暫定）。
 * お客様に見せる呼び名は「マイル」。ここに「ポイント」は出さない。
 */
type RankLookup = { rank_key: string; name: string; annual_threshold_yen: number; mile_rate_percent: number };
export type MilestoneLookup = { threshold_yen: number; title: string };

export async function loadRankSetup(db: D1Database, lineAccountId: string | null): Promise<{ ranks: RankLookup[]; milestones: MilestoneLookup[]; rankConfigured: boolean }> {
  if (!lineAccountId) return { ranks: [], milestones: [], rankConfigured: false };
  {
    const pkg = dbPackage as {
      getNenRankSettings?: (db: D1Database, id: string) => Promise<RankLookup[]>;
      getNenLifetimeMilestones?: (db: D1Database, id: string) => Promise<MilestoneLookup[]>;
    };
    const load = pkg.getNenRankSettings;
    if (typeof load !== 'function') return { ranks: [], milestones: [], rankConfigured: false };
    const ranks = await load(db, lineAccountId);
    const milestones = (await pkg.getNenLifetimeMilestones?.(db, lineAccountId)) ?? [];
    // D-48：ランク表が空のときは決めていない予備のランクで組み立てない。呼び出し側が EC の値だけを使う。
    if (!ranks.length) return { ranks: [], milestones, rankConfigured: false };
    return { ranks, milestones, rankConfigured: true };
  }
}

export async function buildMembership(db: D1Database, lineAccountId: string | null, snapshot: Record<string, unknown> | null) {
  const { ranks, milestones, rankConfigured } = await loadRankSetup(db, lineAccountId);
  const num = (value: unknown) => (Number.isFinite(Number(value)) ? Math.max(0, Math.round(Number(value))) : 0);
  const ecRankKey = typeof snapshot?.member_rank_key === 'string' && snapshot.member_rank_key ? snapshot.member_rank_key : null;
  const ecRankName = typeof snapshot?.ec_member_rank_name === 'string' && snapshot.ec_member_rank_name.trim() ? snapshot.ec_member_rank_name : null;
  const annualMilesYen = num(snapshot?.annual_miles_yen) || (ecRankKey ? 0 : num(snapshot?.purchase_amount));
  const lifetimeMilesYen = Math.max(num(snapshot?.lifetime_miles_yen), num(snapshot?.purchase_amount));
  const mileBalance = num(snapshot?.mile_balance);
  const sortedRanks = rankConfigured ? [...ranks].sort((a, b) => a.annual_threshold_yen - b.annual_threshold_yen) : [];
  const index = ecRankKey ? sortedRanks.findIndex((r) => r.rank_key === ecRankKey) : -1;
  const rank = sortedRanks[index] ?? null;
  const rankPositionKnown = index >= 0;
  const next = rankPositionKnown ? sortedRanks[index + 1] ?? null : null;
  const sortedMilestones = [...milestones].sort((a, b) => a.threshold_yen - b.threshold_yen);
  const nextMilestone = sortedMilestones.find((m) => m.threshold_yen > lifetimeMilesYen) ?? null;
  return {
    rankConfigured,
    rankPositionKnown,
    rankKey: ecRankKey ?? rank?.rank_key ?? null,
    rankName: rank?.name ?? (ecRankKey ? ecRankName : null) ?? '未設定',
    mileRatePercent: Number.isFinite(Number(snapshot?.mile_rate_percent)) && snapshot?.mile_rate_percent != null
      ? Number(snapshot.mile_rate_percent)
      : rank?.mile_rate_percent ?? null,
    annualMilesYen,
    lifetimeMilesYen,
    mileBalance,
    validUntil: typeof snapshot?.rank_valid_until === 'string' ? snapshot.rank_valid_until : null,
    next: next ? { name: next.name, thresholdYen: next.annual_threshold_yen, remainingYen: Math.max(0, next.annual_threshold_yen - annualMilesYen) } : null,
    ranks: sortedRanks.map((r) => ({ key: r.rank_key, name: r.name, thresholdYen: r.annual_threshold_yen, mileRatePercent: r.mile_rate_percent })),
    milestones: sortedMilestones.map((m) => ({ thresholdYen: m.threshold_yen, title: m.title, reached: lifetimeMilesYen >= m.threshold_yen })),
    nextMilestone: nextMilestone ? { thresholdYen: nextMilestone.threshold_yen, title: nextMilestone.title, remainingYen: nextMilestone.threshold_yen - lifetimeMilesYen } : null,
  };
}

export /**
 * LIFF に返すペット。`feeding` は NRC／FEDIAF の式で毎回計算し直す（★37-2「今日の目安」）。
 * 主食（nen_feeding_products）が無いアカウントでは kcal だけ返し、グラムは null。
 */
function mapPet(row: Record<string, unknown>, products: FeedingProductRow[] = [], treatLimitPercent = DEFAULT_TREAT_LIMIT_PERCENT) {
  const neutered = neuteredFromRow(row.neutered);
  // 「その他」の動物を犬へ変換しない。犬・猫専用の給与計算も対象外。
  const animalType = toPetAnimalType(row.animal_type);
  const feedingSupported = isFeedingSupportedAnimal(animalType);
  const plan = planForPetRow({
    id: String(row.id), animal_type: animalType, weight_kg: row.weight_kg as number | null,
    birthday: (row.birthday as string | null) ?? null, neutered: row.neutered as number | null,
    activity_level: (row.activity_level as string | null) ?? null, feeding_product_id: (row.feeding_product_id as string | null) ?? null,
  }, products, new Date(), treatLimitPercent);
  return {
    id: row.id, customerId: row.customer_id, name: row.name, callName: petCallName(String(row.name ?? ''), row.gender), animalType,
    gender: petGender(row.gender), breed: row.breed, birthday: row.birthday, weightKg: row.weight_kg,
    concerns: JSON.parse(String(row.concerns || '[]')),
    neutered: neutered === true ? 'yes' : neutered === false ? 'no' : 'unknown',
    activityLevel: normalizeActivity(row.activity_level) ?? 'normal',
    feedingProductId: row.feeding_product_id || null,
    feeding: feedingView(plan),
    // 種別が犬・猫以外のとき、過去に犬として計算・保存された目安を出さない。
    recommendedDailyGrams: feedingSupported ? row.recommended_daily_grams : null,
    recommendedDailyMinGrams: feedingSupported ? row.recommended_daily_min_grams : null,
    recommendedDailyMaxGrams: feedingSupported ? row.recommended_daily_max_grams : null,
    venisonDailyGrams: feedingSupported ? row.venison_daily_grams : null,
    foodCycleDays: feedingSupported ? row.food_cycle_days : null,
    imageUrl: row.image_url || null,
  };
}

export function feedingView(plan: FeedingPlan | null) {
  if (!plan) return null;
  return {
    dailyKcal: plan.dailyKcal, dailyGrams: plan.dailyGrams, minGrams: plan.minGrams, maxGrams: plan.maxGrams,
    rerKcal: plan.rerKcal, factor: plan.factor, factorLabel: plan.factorLabel, stage: plan.stage, stageLabel: plan.stageLabel,
    ageMonths: plan.ageMonths, product: plan.product,
    venison: plan.venison,
  };
}

export /** マイページの「いつもの主食」に出すのは主食だけ。然の商品（おやつ）は目安の計算にだけ使う。 */
function feedingProductsView(products: FeedingProductRow[]) {
  return stapleProducts(products).map((p) => ({ id: p.id, name: p.name, kcalPer100g: Number(p.kcal_per_100g), isDefault: p.is_default === 1, kind: productKind(p.kind) }));
}
export function nenProductsView(products: FeedingProductRow[]) {
  return nenProducts(products).map((p) => ({ id: p.id, name: p.name, kcalPer100g: Number(p.kcal_per_100g), isDefault: p.is_default === 1, kind: productKind(p.kind) }));
}

export type FeedingCatalog = { products: FeedingProductRow[]; treatLimitPercent: number };

export async function accountFeedingProducts(c: Context<Env>, friend: FriendRow): Promise<FeedingCatalog> {
  if (!friend.line_account_id) return { products: [], treatLimitPercent: DEFAULT_TREAT_LIMIT_PERCENT };
  try {
    const [products, treatLimitPercent] = await Promise.all([listFeedingProducts(c.env.DB, friend.line_account_id), getTreatLimitPercent(c.env.DB, friend.line_account_id)]);
    return { products, treatLimitPercent };
  } catch {
    return { products: [], treatLimitPercent: DEFAULT_TREAT_LIMIT_PERCENT };
  }
}

export /**
 * ペットの登録・変更に共通の入力（体重・避妊去勢・活動量・主食）。
 * 想定外の値はエラーにせず「変更しない」（undefined）として扱う。
 */
function petFeedingInput(body: Record<string, unknown> | null, products: FeedingProductRow[]) {
  const neutered = neuteredFromInput(body?.neutered);
  const activityLevel = normalizeActivity(body?.activityLevel);
  const rawProduct = body?.feedingProductId;
  const feedingProductId = rawProduct === null || rawProduct === '' ? null
    : typeof rawProduct === 'string' && stapleProducts(products).some((p) => p.id === rawProduct) ? rawProduct : undefined;
  return { neutered, activityLevel, feedingProductId };
}

export function decodeJpegData(data: unknown): Uint8Array | null {
  if (typeof data !== 'string' || !data.startsWith('data:image/jpeg;base64,')) return null;
  const raw = data.slice('data:image/jpeg;base64,'.length);
  if (!raw || raw.length > 2_100_000) return null;
  try {
    const bytes = Uint8Array.from(atob(raw), (ch) => ch.charCodeAt(0));
    return bytes.byteLength <= 1_500_000 ? bytes : null;
  } catch {
    return null;
  }
}

export /**
 * 採用済み写真への公開同意を、管理画面と公式サイトが読む掲載台帳へ反映する。
 *
 * LIFF は「サイトへの掲載に同意する」を有効にした時点で「公式サイトに
 * 掲載中」と案内するため、同意日時だけを保存して掲載台帳を作らないと、
 * 管理画面にも EC の公開ギャラリーにも現れない。写真ごとに一意な掲載と
 * 公式サイトの掲載先を冪等に作り、同意を付け直した場合は既存行を再開する。
 */
async function ensureConsentedPhotoSitePublication(
  db: D1Database,
  input: {
    photoId: string;
    friendId: string;
    lineAccountId: string;
    consentVersion: string;
    showPetName: boolean;
    siteUrl: string;
    now: string;
  },
): Promise<void> {
  const existing = await db.prepare(
    `SELECT id FROM nen_photo_publications WHERE photo_id = ? AND line_account_id = ?`,
  ).bind(input.photoId, input.lineAccountId).first<{ id: string }>();
  const publicationId = existing?.id ?? `photo-publication:${input.photoId}`;
  const placementId = `photo-publication-site:${input.photoId}`;
  const siteLabel = `${input.siteUrl.replace(/\/+$/, '')}/`;
  await db.batch([
    db.prepare(
      `UPDATE nen_photo_submissions
          SET publication_consent_version = ?, publication_consent_at = ?,
              publication_withdrawn_at = NULL, public_pet_name = ?,
              public_image_url = COALESCE(public_image_url, review_image_url), updated_at = ?
        WHERE id = ? AND friend_id = ? AND line_account_id = ?`,
    ).bind(
      input.consentVersion, input.now, input.showPetName ? 1 : 0, input.now,
      input.photoId, input.friendId, input.lineAccountId,
    ),
    db.prepare(
      `INSERT INTO nen_photo_publications
        (id, photo_id, line_account_id, status, show_owner_name, version,
         published_at, withdrawn_at, withdrawn_by, updated_at)
       VALUES (?, ?, ?, 'published', 0, 1, ?, NULL, NULL, ?)
       ON CONFLICT(photo_id) DO UPDATE SET
         status = 'published',
         withdrawn_at = NULL,
         withdrawn_by = NULL,
         version = CASE WHEN nen_photo_publications.status = 'withdrawn'
           THEN nen_photo_publications.version + 1 ELSE nen_photo_publications.version END,
         updated_at = excluded.updated_at`,
    ).bind(publicationId, input.photoId, input.lineAccountId, input.now, input.now),
    db.prepare(
      `INSERT INTO nen_photo_publication_placements
        (id, publication_id, line_account_id, placement_type, placement_label,
         active, created_at, removed_at)
       VALUES (?, ?, ?, 'site', ?, 1, ?, NULL)
       ON CONFLICT(publication_id, placement_type, placement_label) DO UPDATE SET
         active = 1,
         removed_at = NULL`,
    ).bind(placementId, publicationId, input.lineAccountId, siteLabel, input.now),
  ]);
}

export
async function adminAccountScope(c: Context<Env>) {
  const scope = await getVisibleLineAccountScope(c.env.DB, c.get('staff'));
  const where = scope.allowedAccountIds.length
    ? `AND (f.line_account_id IN (${sqlIdSet(scope.allowedAccountIds).sql})${scope.canSeeUnassigned ? ' OR f.line_account_id IS NULL' : ''})`
    : scope.canSeeUnassigned
      ? 'AND f.line_account_id IS NULL'
      : 'AND 1 = 0';
  return { scope, where };
}

export /** 1ページの枚数。指定なし・壊れた指定は 200。上限も 200 で頭打ちにする。 */
function photoPageSize(raw: string | undefined): number {
  return truncatedListLimit(raw, 200, 200);
}

export /** 何枚目から取るか。指定なし・負・壊れた指定は 0。 */
function photoPageOffset(raw: string | undefined): number {
  return truncatedListOffset(raw);
}

export type SavedReviewEvent = {
  to_status: string; reason_code: string | null; reason_note: string | null;
  awarded_points: number; notification_status: string;
};

export /** 同じ再実行キーで来た再送が、保存済みと「同じ操作」かの判定。 */
function isSameReviewRequest(
  previous: SavedReviewEvent,
  status: string,
  reasonCode: string,
  reasonNote: string,
): boolean {
  return previous.to_status === status
    && (previous.reason_code ?? null) === (status === 'rejected' ? reasonCode : null)
    && (previous.reason_note ?? null) === (status === 'rejected' ? (reasonNote || null) : null);
}

export /** 同じ再実行キーの再送には保存済みの結果だけを返し、作り直さない。 */
function reviewDuplicateResponse(
  c: Context<Env>,
  customerId: unknown,
  previous: SavedReviewEvent,
): Response {
  return c.json({
    success: true,
    duplicate: true,
    data: {
      awardedPoints: Number(previous.awarded_points),
      pointBalance: null,
      pointSync: Number(previous.awarded_points) > 0
        ? (customerId ? 'pending' : 'needs_attention')
        : 'not_required',
      notificationStatus: previous.notification_status === 'sent' ? 'sent' : 'failed',
    },
  });
}

export /*
 * 止まったポイント手続きを人が動かす口。
 *
 * - point-retry …「手続き中」「確認が必要」の行を今すぐ届け直す。
 * - point-reconcile … EC側に届いているかを awardKey で照合し、
 *   EC成功・管理DB失敗の食い違いを synced へ収束させる。
 *
 * どちらも中身は同じ冪等な付与呼び出し（EC側が awardKey で二重付与を
 * 防ぐ）で、入口を分けているのは「もう一度送る」と「届いたか確認する」
 * という運用者の意図を監査ログへ残すため。
 */
async function handlePhotoRewardAction(c: Context<Env>, action: 'retry' | 'reconcile') {
  const body = await c.req.json<{ accountId?: string }>().catch(() => null);
  const accountId = body?.accountId?.trim();
  if (!accountId) return inputError(c, { success: false, error: '対象アカウントを指定してください' }, 400, ["accountId"]);
  if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [accountId])) {
    return c.json({ success: false, error: 'このLINEアカウントを操作する権限がありません' }, 403);
  }
  const photo = await c.env.DB.prepare(
    `SELECT ps.id, ps.status, s.customer_id
       FROM nen_photo_submissions ps
       LEFT JOIN nen_ec_member_snapshots s ON s.friend_id = ps.friend_id
      WHERE ps.id = ? AND ps.line_account_id = ?`,
  ).bind(c.req.param('id'), accountId).first<{ id: string; status: string; customer_id: string | null }>();
  if (!photo) return c.json({ success: false, error: '写真が見つかりません' }, 404);
  if (photo.status !== 'adopted') {
    return inputError(c, { success: false, error: '採用した写真だけがポイント付与の対象です' }, 400, ["accountId"]);
  }
  if (!photo.customer_id) {
    return inputError(c, { success: false, error: 'EC会員とつながっていないためポイントを付けられません' }, 400, ["accountId"]);
  }
  const client = ecPhotoPointClient(c);
  if (!client) {
    return c.json({ success: false, error: 'ECへの接続が設定されていません' }, 503);
  }
  try {
    const attempt = await attemptPhotoRewardForPhoto(
      c.env.DB,
      { photoId: photo.id, lineAccountId: accountId },
      client,
      { now: new Date() },
    );
    if (attempt.kind === 'no_reward') {
      /*
       * outbox 行が無い古い採用には勝手に手続きを作らない。
       * 旧経路で付与済みかもしれず、ここで作ると二重付与になりうる
       * （受入条件: 既存の5ptデータを再付与しない）。
       */
      return c.json({ success: false, error: '対象のポイント手続きが見つかりません' }, 404);
    }
    if (attempt.kind === 'busy') {
      return c.json({ success: false, error: 'いま別の手続きが進行中です。少し待ってからやり直してください' }, 409);
    }
    const synced = attempt.kind === 'already_synced'
      || (attempt.kind === 'delivered' && attempt.outcome.kind === 'synced');
    const duplicate = attempt.kind === 'delivered'
      && attempt.outcome.kind === 'synced'
      && attempt.outcome.duplicate;
    const reason = attempt.kind === 'delivered' && attempt.outcome.kind !== 'synced'
      ? attempt.outcome.reason : null;
    return c.json({
      success: true,
      data: {
        action,
        state: attempt.kind === 'delivered' ? attempt.state : 'synced',
        synced,
        duplicate,
        reason,
        reasonLabel: reason ? (PHOTO_REWARD_REASON_LABELS[reason] ?? reason) : null,
      },
    });
  } catch (error) {
    throw error;
  }
}
