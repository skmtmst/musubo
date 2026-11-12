import { enqueueConfirmedNenColumn, NenColumnConfirmationConflict, nenColumnConfirmation } from '../services/nen-column-confirmation.js';
import { jstCalendar as japanCalendar } from '@line-crm/shared';
import { logger } from '@line-crm/shared/server';
import { verifyNenWebhook } from '../lib/hmac.js';
import { WEBHOOK_BODY_BYTES, isWebhookBodyTooLarge } from '../lib/webhook-body.js';
import { petWriteBody, petPatchBody } from './nen-pet-input.js';
import { inputError, inputJsonBoundary } from '../lib/input-errors.js';
import { Hono, type Context } from 'hono';
import { getLineAccountById, jstNow, nextVersionToken, recordConversionSourceEvent } from '@line-crm/db';
import {
  checkNenCampaignBodyLength,
  countNenCampaignBodyLength,
  NEN_CAMPAIGN_BODY_MAX_LENGTH,
  NEN_PET_NAME_MAX_LENGTH,
} from '@line-crm/shared';
import type { Env } from '../worker-env.js';
import { requireRole, requireDeliveryAccess } from '../middleware/role-guard.js';
import {
  type CampaignRow,
  NEN_CAMPAIGN_FORM_ISSUE_LABELS,
  buildDefaultColumnIntro,
  buildNenDeliveryMessages,
  campaignButtonFormId,
  getNenBirthdayCouponSetting,
  getNenCampaign,
  nenCampaignFormIssue,
  queueColumnDelivery,
  saveNenBirthdayCouponSetting,
  saveNenCampaignAccountSetting,
  parseNenCampaignAfterActions,
} from '../services/nen-engagement.js';
import { syncNenPetTags } from '../services/nen-tag-sync.js';
import { canAccessAllLineAccounts } from '../services/account-access.js';
import { isValidIdempotencyKey } from '../services/outbound-idempotency.js';
import {
  buildNenColumnStorageFields,
  isNenColumnSlugConflict,
  normalizeHttpsUrl,
  readBoundedJsonObject,
  validateNenColumnCreateBody,
} from '../services/nen-column-contract.js';
import {
  duplicateNenColumn,
  NenColumnOperationError,
  previewNenColumnAudience,
  recordNenColumnReadEvent,
  sendPendingNenDeliveriesNow,
} from '../services/nen-column-operations.js';
import {
  getNenColumnMetrics,
  getNenDeliveryDetail,
  getNenFlowMetrics,
  getNenPetMetrics,
  listNenDeliveries,
  nenDeliveryRange,
  NenCampaignMetricsError,
  nenMetricsRange,
  normalizeDeliveryStatus,
  retryNenDelivery,
} from '../services/nen-campaign-metrics.js';
import { auditLog } from '../lib/audit-log.js';
import { normalizeNenPetBirthday } from '../lib/nen-pet-birthday.js';
import { buildOffsetListResponse, listLimit, parseOffsetPaging, listQueryNumber } from '../lib/list-paging.js';
import { fail } from '../lib/fail.js';
const nenCampaigns = new Hono<Env>();
const CAMPAIGN_KEYS = new Set([
  'arrival_check', 'review_request', 'cross_sell', 'column', 'birthday_coupon',
]);
const MAX_BODY_BYTES = WEBHOOK_BODY_BYTES.ec;
const ACCOUNT_ACCESS_ERROR = 'このLINEアカウントを操作する権限がありません';

async function getTestRecipient(c: Context<Env>, accountId: string, friendId: string) {
  return c.env.DB.prepare(
    `SELECT f.id, f.line_user_id
       FROM friends f
       JOIN account_settings s ON s.line_account_id = f.line_account_id
        AND s.key = 'test_recipients' AND json_valid(s.value) AND json_type(s.value) = 'array'
      WHERE f.id = ? AND f.line_account_id = ? AND f.is_following = 1
        AND EXISTS (SELECT 1 FROM json_each(s.value) WHERE value = f.id)`,
  ).bind(friendId, accountId).first<{ id: string; line_user_id: string }>();
}

async function requireAccount(c: Context<Env>): Promise<string | Response> {
  const accountId = c.req.query('lineAccountId');
  if (!accountId) return inputError(c, { success: false, error: 'LINEアカウントを選択してください' }, 400, ["lineAccountId"]);
  if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [accountId])) {
    return c.json({ success: false, error: ACCOUNT_ACCESS_ERROR }, 403);
  }
  return accountId;
}

function metricsError(c: Context<Env>, error: unknown): Response {
  if (error instanceof NenCampaignMetricsError) {
    return inputError(c, {
      success: false,
      code: error.code,
      error: error.message,
      ...(error.field ? { field: error.field } : {}),
    }, error.status, []);
  }
  throw error;
}

function columnOperationError(c: Context<Env>, error: unknown): Response {
  if (error instanceof NenColumnOperationError) {
    return inputError(c, { success: false, code: error.code, error: error.message }, error.status, []);
  }
  throw error;
}

function cursorOffset(value: string | undefined): number {
  if (!value) return 0;
  const parsed = listQueryNumber(value, 0);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed)) {
    throw new NenCampaignMetricsError('cursor_invalid', '続きの位置が正しくありません', 400, 'cursor');
  }
  return parsed;
}

function isUrl(value: string): boolean {
  return !value || normalizeHttpsUrl(value, { allowCredentials: true }) !== null;
}

async function verifyEccubeSignature(secret: string, timestamp: string, signature: string, body: string): Promise<boolean> {
  return (await verifyNenWebhook({ profile: 'ec', secret, timestamp, signature, rawBody: body })).ok;
}

nenCampaigns.get('/api/nen-campaigns/overview', async (c) => {
  const accountId = await requireAccount(c);
  if (typeof accountId !== 'string') return accountId;
  const [settings, jobs, pendingByCampaignRows, columns, pets, coupons] = await Promise.all([
    Promise.all([...CAMPAIGN_KEYS].map((key) => getNenCampaign(c.env.DB, key, accountId))),
    c.env.DB.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'pending' AND datetime(scheduled_at) > datetime('now') THEN 1 ELSE 0 END) AS pending,
              SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent,
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
         FROM nen_delivery_jobs WHERE line_account_id = ?`,
    ).bind(accountId).first<{ total: number; pending: number; sent: number; failed: number }>(),
    /*
     *  編集画面が「これから届く◯通」を実数で言うため、
     * 上の pending と同じ決めごと（未来ぶんだけ数える）で配信ごとに分ける。
     */
    c.env.DB.prepare(
      `SELECT campaign_key, COUNT(*) AS count
         FROM nen_delivery_jobs
        WHERE line_account_id = ?
          AND status = 'pending' AND datetime(scheduled_at) > datetime('now')
        GROUP BY campaign_key`,
    ).bind(accountId).all<{ campaign_key: string; count: number }>(),
    c.env.DB.prepare(`SELECT COUNT(*) AS count FROM nen_columns WHERE line_account_id = ?`).bind(accountId).first<{ count: number }>(),
    c.env.DB.prepare(
      `SELECT COUNT(*) AS count FROM nen_pet_profiles p JOIN friends f ON f.id = p.friend_id WHERE p.archived_at IS NULL AND f.line_account_id = ?`,
    ).bind(accountId).first<{ count: number }>(),
    c.env.DB.prepare(
      `SELECT COUNT(*) AS count FROM nen_coupon_issues c JOIN friends f ON f.id = c.friend_id WHERE f.line_account_id = ?`,
    ).bind(accountId).first<{ count: number }>(),
  ]);
  // jobs.pending は「これから送る未来ぶん」の件数。pending-now 口の数え方と
  // 同じ決めごとにする(点検  の中2)。一覧の窓付き集計とは別物。
  return c.json({ success: true, data: {
    activeCampaigns: settings.filter((setting) => setting?.is_enabled === 1).length,
    jobs: {
      total: jobs?.total ?? 0,
      pending: jobs?.pending ?? 0,
      sent: jobs?.sent ?? 0,
      failed: jobs?.failed ?? 0,
      pendingByCampaign: Object.fromEntries(
        (pendingByCampaignRows?.results ?? []).map((row) => [row.campaign_key, Number(row.count)]),
      ),
    },
    columns: columns?.count ?? 0,
    pets: pets?.count ?? 0,
    coupons: coupons?.count ?? 0,
  } });
});

nenCampaigns.get('/api/nen-campaigns/settings', async (c) => {
  const accountId = await requireAccount(c);
  if (typeof accountId !== 'string') return accountId;
  const keys = await c.env.DB.prepare(
    `SELECT campaign_key FROM nen_campaign_settings WHERE category != 'transactional' ORDER BY rowid`,
  ).all<{ campaign_key: string }>();
  const campaigns = (await Promise.all(
    keys.results.map((row) => getNenCampaign(c.env.DB, row.campaign_key, accountId)),
  )).filter((row): row is CampaignRow => Boolean(row));
  /*
   * つなぐ回答フォームが使えなくなった稼働中設定を一覧・編集画面で
   * 「設定不足」と出せるよう、配信ごとに判定を行へ添えてから返す。
   */
  const settings = await Promise.all(campaigns.map(async (row) => ({
    ...toCampaignSettingPayload(row),
    formIssue: await nenCampaignFormIssue(c.env.DB, row, accountId),
  })));
  return c.json({ success: true, data: settings });
});

/**
 * 一覧の1行の写し。の409（data.latest）でも同じ形で最新の内容を返す。
 * formIssue は付けない（競合時は画面が読み直すため）。
 */
function toCampaignSettingPayload(row: CampaignRow) {
  return {
    campaignKey: row.campaign_key,
    label: row.label,
    category: row.category,
    triggerEvent: row.trigger_event ?? null,
    delayDays: row.delay_days,
    deliveryTime: row.delivery_time,
    isEnabled: row.is_enabled === 1,
    title: row.title,
    bodyText: row.body_text,
    buttonLabel: row.button_label,
    buttonUrl: row.button_url,
    imageUrl: row.image_url,
    dedupWindowDays: row.dedup_window_days ?? 30,
    excludeFormRespondents: row.exclude_form_respondents === 1,
    afterActions: row.after_actions ?? [],
    updatedAt: row.updated_at ?? '',
  };
}

/**
 * アカウント別設定JSONの中の版を読む。行が無い初回保存は共通設定の版を
 * 基準にする（一覧がその値を updatedAt として見せているため）。
 */
function readCampaignSettingUpdatedAt(raw: string | null, fallback: string): string {
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as { updated_at?: unknown };
    return typeof parsed.updated_at === 'string' ? parsed.updated_at : fallback;
  } catch {
    return fallback;
  }
}

nenCampaigns.put('/api/nen-campaigns/settings/:campaignKey', requireDeliveryAccess('nenCampaigns'), inputJsonBoundary(), async (c) => {
  const accountId = await requireAccount(c);
  if (typeof accountId !== 'string') return accountId;
  const key = c.req.param('campaignKey');
  if (!CAMPAIGN_KEYS.has(key)) return inputError(c, { success: false, error: 'Invalid campaign' }, 400, []);
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body || typeof body.isEnabled !== 'boolean' || typeof body.title !== 'string'
      || typeof body.bodyText !== 'string' || typeof body.deliveryTime !== 'string') {
    return inputError(c, { success: false, error: 'Invalid body' }, 400, ["isEnabled","title","bodyText","deliveryTime"]);
  }
  const delayDays = Number(body.delayDays);
  const buttonLabel = typeof body.buttonLabel === 'string' ? body.buttonLabel.trim() : '';
  const buttonUrl = typeof body.buttonUrl === 'string' ? body.buttonUrl.trim() : '';
  const imageUrl = typeof body.imageUrl === 'string' ? body.imageUrl.trim() : '';
  const afterActions = body.afterActions === undefined ? [] : parseNenCampaignAfterActions(body.afterActions);
  if (body.afterActions !== undefined
      && (!Array.isArray(body.afterActions) || afterActions.length !== body.afterActions.length)) {
    return inputError(c, { success: false, error: 'Invalid campaign actions' }, 400, ["afterActions"]);
  }
  // 本文の上限は画面と同じ採用上限（NEN_CAMPAIGN_BODY_MAX_LENGTH）。数え方も
  // 画面の残数表示と同じ関数で測り、超過時は字数を添えて理由を返す。
  const bodyCheck = checkNenCampaignBodyLength(body.bodyText);
  if (!bodyCheck.fits) {
    return inputError(c, {
      success: false,
      error: `本文は${NEN_CAMPAIGN_BODY_MAX_LENGTH.toLocaleString('ja-JP')}字以内で入力してください（現在${bodyCheck.length.toLocaleString('ja-JP')}字）`,
    }, 400, ["bodyText"]);
  }
  if (!body.title.trim() || body.title.trim().length > 120
      || !Number.isInteger(delayDays) || delayDays < 0 || delayDays > 365
      || !/^([01]\d|2[0-3]):[0-5]\d$/.test(body.deliveryTime)
      || buttonLabel.length > 20 || !isUrl(buttonUrl) || !isUrl(imageUrl)) {
    return inputError(c, { success: false, error: 'Invalid campaign values' }, 400, ["title","delayDays","deliveryTime","buttonLabel","buttonUrl","imageUrl"]);
  }
  const current = await getNenCampaign(c.env.DB, key, accountId);
  if (!current) return fail(c, 404, 'CAMPAIGN_NOT_FOUND');
  const dedupWindowDays = body.dedupWindowDays === undefined
    ? (current.dedup_window_days ?? 30)
    : Number(body.dedupWindowDays);
  const excludeFormRespondents = body.excludeFormRespondents === undefined
    ? current.exclude_form_respondents === 1
    : body.excludeFormRespondents;
  if (!Number.isInteger(dedupWindowDays) || dedupWindowDays < 0 || dedupWindowDays > 365
      || typeof excludeFormRespondents !== 'boolean') {
    return inputError(c, { success: false, error: 'Invalid delivery safeguards' }, 400, ["dedupWindowDays","excludeFormRespondents"]);
  }
  /*
   * 「回答フォームを開く」設定はつなぐフォームが今も使える
   * ことを確かめる。ボタンのURLだけフォームを指している(押されたあとの
   * 設定を外した残り・古い設定)は「開くつもりなのに未選択」と同じ扱いにして
   * 保存を止める。口コミ回答の除外も有効なフォーム選択が前提。
   */
  const formAction = afterActions.find((action) => action.kind === 'open_form');
  /*
   * 判定は「これから保存しようとする中身」で行う。除外フラグと旧open_formの
   * 残骸はリクエスト側の値を反映させないと、設定不足を解除する保存まで
   * 既存の不足判定で弾かれてしまう。
   */
  const proposed: CampaignRow = {
    ...current,
    after_actions: afterActions,
    form_action_dropped: 0,
    exclude_form_respondents: excludeFormRespondents ? 1 : 0,
    button_url: buttonUrl || null,
  };
  const buttonFormId = campaignButtonFormId(proposed);
  if (buttonFormId !== null && buttonFormId !== formAction?.formId) {
    return inputError(c, {
      success: false,
      error: 'ボタンのURLは回答フォームを指していますが、「押されたあとにすること」でフォームが選ばれていません。先にフォームを選んでください',
    }, 400, ["afterActions","excludeFormRespondents","buttonUrl"]);
  }
  if (excludeFormRespondents && !formAction) {
    return inputError(c, {
      success: false,
      error: '「すでに口コミを書いた人には送らない」には回答フォームの選択が必要です',
    }, 400, ["excludeFormRespondents","afterActions"]);
  }
  const formIssue = await nenCampaignFormIssue(c.env.DB, proposed, accountId);
  if (formIssue) {
    return inputError(c, { success: false, error: NEN_CAMPAIGN_FORM_ISSUE_LABELS[formIssue] }, 400, ["afterActions","excludeFormRespondents","buttonUrl"]);
  }
  /*
   * 配信設定の同時保存は後勝ちで先の変更が黙って消えていた。
   * 版（expectedUpdatedAt）が送られてきたときだけ、保存前の値と
   * 照合してから書く。古い画面からの保存は409で止め、最新の内容を
   * data.latest で返す。送られてこない従来の呼び出しはそのまま通す。
   * 設定はアカウント別のJSON1行なので、行全体の比べ書き（CAS）で
   * 読み→書きのすき間の割り込みも止める。migration なし。
   */
  const expectedUpdatedAt = typeof body.expectedUpdatedAt === 'string' ? body.expectedUpdatedAt : null;
  const next: CampaignRow = {
    ...current,
    is_enabled: body.isEnabled ? 1 : 0,
    title: body.title.trim(),
    body_text: body.bodyText.trim(),
    delay_days: delayDays,
    delivery_time: body.deliveryTime,
    button_label: buttonLabel || null,
    button_url: buttonUrl || null,
    image_url: imageUrl || null,
    dedup_window_days: dedupWindowDays,
    exclude_form_respondents: excludeFormRespondents ? 1 : 0,
    after_actions: afterActions,
    updated_at: jstNow(),
  };
  // 版を送らない従来の呼び出しは、以前とまったく同じ書き方で通す。
  // どちらの場合も新しい版を返す（画面が次の保存へ進めるため）。
  if (expectedUpdatedAt === null) {
    await saveNenCampaignAccountSetting(c.env.DB, accountId, next);
    auditLog(c, 'nen.campaign.save', {kind:'nen_campaign', id:key}, {lineAccountId:accountId});
    const savedSetting = await getNenCampaign(c.env.DB, key, accountId);
    return c.json({ success: true, data: { updatedAt: savedSetting?.updated_at ?? next.updated_at } });
  }
  const settingKey = `nen.campaign.${key}`;
  const saved = await c.env.DB.prepare(
    `SELECT value FROM account_settings WHERE line_account_id = ? AND key = ?`,
  ).bind(accountId, settingKey).first<{ value: string }>();
  const savedUpdatedAt = readCampaignSettingUpdatedAt(saved?.value ?? null, current.updated_at ?? '');
  // 版は必ず単調に進める。同じミリ秒の連打でも次の保存と見分けられる。
  next.updated_at = nextVersionToken(savedUpdatedAt);
  if (savedUpdatedAt !== expectedUpdatedAt) {
    const latest = await getNenCampaign(c.env.DB, key, accountId);
    return c.json({
      success: false, code: 'VERSION_CONFLICT',
      error: 'ほかの人が先に設定を変えました。最新の内容を確認してから保存し直してください。',
      data: { latest: latest ? toCampaignSettingPayload(latest) : null },
    }, 409);
  }
  const nextValue = JSON.stringify(next);
  if (!saved) {
    const inserted = await c.env.DB.prepare(
      `INSERT INTO account_settings (id, line_account_id, key, value, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(line_account_id, key) DO NOTHING`,
    ).bind(crypto.randomUUID(), accountId, settingKey, nextValue, next.updated_at, next.updated_at).run();
    if ((inserted.meta?.changes ?? 0) === 0) {
      const latest = await getNenCampaign(c.env.DB, key, accountId);
      return c.json({
        success: false, code: 'VERSION_CONFLICT',
        error: 'ほかの人が先に設定を変えました。最新の内容を確認してから保存し直してください。',
        data: { latest: latest ? toCampaignSettingPayload(latest) : null },
      }, 409);
    }
  } else {
    const written = await c.env.DB.prepare(
      `UPDATE account_settings SET value = ?, updated_at = ? WHERE line_account_id = ? AND key = ? AND value = ?`,
    ).bind(nextValue, next.updated_at, accountId, settingKey, saved.value).run();
    if ((written.meta?.changes ?? 0) === 0) {
      const latest = await getNenCampaign(c.env.DB, key, accountId);
      return c.json({
        success: false, code: 'VERSION_CONFLICT',
        error: 'ほかの人が先に設定を変えました。最新の内容を確認してから保存し直してください。',
        data: { latest: latest ? toCampaignSettingPayload(latest) : null },
      }, 409);
    }
  }
  auditLog(c, 'nen.campaign.save', {kind:'nen_campaign', id:key}, {lineAccountId:accountId});
  return c.json({ success: true, data: { updatedAt: next.updated_at } });
});

// 一覧の停止・再開（isEnabledだけの切り替え）専用の口。上のPUTと同じ口を
// 使うと、本文・題名などを送り直すことになり、保存済み本文が上限を超えて
// いる場合に停止すらできなくなる。停止は本文の長さに
// 関わらず必ず実行できる必要があるため、is_enabled以外は今の値のまま
// 変えず、本文の長さ検査も行わない。
nenCampaigns.put('/api/nen-campaigns/settings/:campaignKey/enabled', requireDeliveryAccess('nenCampaigns'), inputJsonBoundary(), async (c) => {
  const accountId = await requireAccount(c);
  if (typeof accountId !== 'string') return accountId;
  const key = c.req.param('campaignKey');
  if (!CAMPAIGN_KEYS.has(key)) return inputError(c, { success: false, error: 'Invalid campaign' }, 400, []);
  const body = await c.req.json<{ isEnabled?: unknown; expectedUpdatedAt?: unknown }>().catch(() => null);
  if (!body || typeof body.isEnabled !== 'boolean') {
    return inputError(c, { success: false, error: 'isEnabled is required' }, 400, ["isEnabled"]);
  }
  const current = await getNenCampaign(c.env.DB, key, accountId);
  if (!current) return fail(c, 404, 'CAMPAIGN_NOT_FOUND');
  /*
   * つなぐ回答フォームが使えない設定は稼働開始を止める。
   * 停止はどんな状態でも実行できる(止められなくなると復旧できない)。
   */
  if (body.isEnabled) {
    const formIssue = await nenCampaignFormIssue(c.env.DB, current, accountId);
    if (formIssue) {
      return c.json({
        success: false,
        error: `設定不足のため動かせません。${NEN_CAMPAIGN_FORM_ISSUE_LABELS[formIssue]}。編集画面でフォームを選び直してください`,
      }, 409);
    }
  }
  let writtenVersion: string | null = null;
  if (body.expectedUpdatedAt !== undefined && (typeof body.expectedUpdatedAt !== 'string' || !body.expectedUpdatedAt)) {
    return inputError(c, { success: false, error: 'Invalid expectedUpdatedAt' }, 400, ['expectedUpdatedAt']);
  }
  if (body.expectedUpdatedAt === undefined) {
    await saveNenCampaignAccountSetting(c.env.DB, accountId, { ...current, is_enabled: body.isEnabled ? 1 : 0 });
  } else {
    const settingKey = `nen.campaign.${key}`;
    const saved = await c.env.DB.prepare('SELECT value FROM account_settings WHERE line_account_id = ? AND key = ?')
      .bind(accountId, settingKey).first<{ value: string }>();
    const seen = readCampaignSettingUpdatedAt(saved?.value ?? null, current.updated_at ?? '');
    const conflict = async () => {
      const latest = await getNenCampaign(c.env.DB, key, accountId);
      return c.json({ success: false, code: 'VERSION_CONFLICT', error: '設定が変わりました。最新の内容を確認してください。', data: { latest: latest ? toCampaignSettingPayload(latest) : null } }, 409);
    };
    if (seen !== body.expectedUpdatedAt || current.updated_at !== body.expectedUpdatedAt) return conflict();
    const version = nextVersionToken(seen);
    const value = JSON.stringify({ ...current, is_enabled: body.isEnabled ? 1 : 0, updated_at: version });
    const result = saved
      ? await c.env.DB.prepare('UPDATE account_settings SET value = ?, updated_at = ? WHERE line_account_id = ? AND key = ? AND value = ?')
        .bind(value, version, accountId, settingKey, saved.value).run()
      : await c.env.DB.prepare('INSERT INTO account_settings (id, line_account_id, key, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(line_account_id, key) DO NOTHING')
        .bind(crypto.randomUUID(), accountId, settingKey, value, version, version).run();
    if ((result.meta?.changes ?? 0) !== 1) return conflict();
    writtenVersion = version;
  }
  auditLog(c, body.isEnabled ? 'nen.campaign.enable' : 'nen.campaign.stop', {kind:'nen_campaign', id:key}, {lineAccountId:accountId});
  return c.json({ success: true, data: { updatedAt: writtenVersion } });
});

type NenCampaignDraft = {
  title?: string; bodyText?: string; buttonLabel?: string; buttonUrl?: string; imageUrl?: string;
};

/**
 * テスト送信に乗せる編集中の下書き。保存済みの値を上書きするだけで、本配信の設定は変えない。
 * 保存と同じ検査を通す（監査 R65: プレビューと違う保存済み本文が飛んでいた）。
 */
function applyCampaignDraft(campaign: CampaignRow, draft: NenCampaignDraft | undefined): CampaignRow | { error: string } {
  if (!draft) return campaign;
  const title = draft.title === undefined ? campaign.title : draft.title.trim();
  const bodyText = draft.bodyText === undefined ? campaign.body_text : draft.bodyText;
  const buttonLabel = draft.buttonLabel === undefined ? campaign.button_label ?? '' : draft.buttonLabel.trim();
  const buttonUrl = draft.buttonUrl === undefined ? campaign.button_url ?? '' : draft.buttonUrl.trim();
  const imageUrl = draft.imageUrl === undefined ? campaign.image_url ?? '' : draft.imageUrl.trim();
  if (!title || title.length > 120 || !bodyText.trim()) {
    return { error: 'Invalid campaign values' };
  }
  const bodyCheck = checkNenCampaignBodyLength(bodyText);
  if (!bodyCheck.fits) {
    return { error: `本文は${NEN_CAMPAIGN_BODY_MAX_LENGTH.toLocaleString('ja-JP')}字以内で入力してください（現在${bodyCheck.length.toLocaleString('ja-JP')}字）` };
  }
  if (buttonLabel.length > 20 || !isUrl(buttonUrl) || !isUrl(imageUrl)) {
    return { error: 'Invalid campaign values' };
  }
  return { ...campaign, title, body_text: bodyText, button_label: buttonLabel, button_url: buttonUrl, image_url: imageUrl };
}

nenCampaigns.post('/api/nen-campaigns/test-send', requireDeliveryAccess('nenCampaigns'), inputJsonBoundary({"campaignKey":["string"],"accountId":["string"],"friendId":["string"],"draft":["object"]}), async (c) => {
  const body = await c.req.json<{ campaignKey?: string; accountId?: string; friendId?: string; draft?: NenCampaignDraft }>().catch(() => null);
  if (!body?.campaignKey || !CAMPAIGN_KEYS.has(body.campaignKey) || !body.accountId || !body.friendId) {
    return fail(c, 400, 'CAMPAIGN_KEY_ACCOUNT_ID_AND_FRIEND_ID_ARE_REQUIRED', {}, ["campaignKey","accountId","friendId"]);
  }
  if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [body.accountId])) {
    return c.json({ success: false, error: ACCOUNT_ACCESS_ERROR }, 403);
  }
  const [savedCampaign, account, friend] = await Promise.all([
    getNenCampaign(c.env.DB, body.campaignKey, body.accountId),
    getLineAccountById(c.env.DB, body.accountId),
    getTestRecipient(c, body.accountId, body.friendId),
  ]);
  // テスト送信先は「設定 › アカウント › テスト送信先」に登録され、かつ友だち追加中の人だけ。
  // 画面が理由を言えるよう、送信先の問題は code で分ける。
  if (!friend) return c.json({ success: false, code: 'test_recipient_unavailable', error: 'テスト送信先が登録されていないか、友だち追加されていません' }, 404);
  if (!savedCampaign || !account) return fail(c, 404, 'TEST_TARGET_NOT_FOUND');
  const campaign = applyCampaignDraft(savedCampaign, body.draft);
  if ('error' in campaign) return inputError(c, { success: false, error: campaign.error }, 400, ["draft"]);
  const sample = {
    event: {
      event_id: `test-${crypto.randomUUID()}`, event_type: 'ec.order.shipped', occurred_at: new Date().toISOString(),
      line_user_id: friend.line_user_id,
      order: { number: 'NEN-TEST-001', items: [{ name: '鹿肉ミンチ', quantity: 2 }], total: 2860, detail_url: campaign.button_url },
      shipping: { carrier: 'ヤマト運輸', tracking_number: '1234-5678-9012', tracking_url: campaign.button_url },
    },
    article: { title: '愛犬・愛猫の健康を考えるNENコラム', excerpt: campaign.body_text, article_url: campaign.button_url, image_url: campaign.image_url },
    coupon: { code: 'NEN-BIRTHDAY-TEST', expires_at: '2026-09-30' },
  };
  const messages = buildNenDeliveryMessages(campaign, sample);
  const { pushViaHarnessProxy } = await import('../services/line-proxy-send.js');
  const { dispatchLineProxyLocally } = await import('../services/local-line-proxy.js');
  await pushViaHarnessProxy(
    c.env.WORKER_PUBLIC_URL || new URL(c.req.url).origin,
    account.channel_access_token,
    friend.line_user_id,
    messages,
    crypto.randomUUID(),
    (request) => dispatchLineProxyLocally(request, c.env),
  );
  return c.json({ success: true });
});

nenCampaigns.get('/api/nen-campaigns/jobs', async (c) => {
  const accountId = await requireAccount(c);
  if (typeof accountId !== 'string') return accountId;
  const rows = await c.env.DB.prepare(
    `SELECT j.id, j.campaign_key, s.label, f.display_name, j.scheduled_at, j.status,
            j.attempts, j.last_error, j.sent_at
       FROM nen_delivery_jobs j
       JOIN nen_campaign_settings s ON s.campaign_key = j.campaign_key
       JOIN friends f ON f.id = j.friend_id
      WHERE j.line_account_id = ?
      ORDER BY j.created_at DESC LIMIT 100`,
  ).bind(accountId).all<Record<string, unknown>>();
  return c.json({ success: true, data: rows.results.map((row) => ({
    id: row.id, campaignKey: row.campaign_key, label: row.label, friendName: row.display_name,
    scheduledAt: row.scheduled_at, status: row.status, attempts: row.attempts,
    lastError: row.last_error, sentAt: row.sent_at,
  })) });
});

nenCampaigns.get('/api/nen-campaigns/metrics/flows', requireRole('owner', 'admin', 'staff'), async (c) => {
  const accountId = await requireAccount(c);
  if (typeof accountId !== 'string') return accountId;
  try {
    // ★37-6: 「今月」「先月」の数値カードは from/to で月の範囲を渡す（deliveries 口と同じ決めごと）。
    const data = await getNenFlowMetrics(c.env.DB, accountId, nenDeliveryRange({
      from: c.req.query('from'), to: c.req.query('to'), days: c.req.query('days'),
    }));
    return c.json({ success: true, data });
  } catch (error) {
    return metricsError(c, error);
  }
});

nenCampaigns.get('/api/nen-campaigns/metrics/columns', requireRole('owner', 'admin', 'staff'), async (c) => {
  const accountId = await requireAccount(c);
  if (typeof accountId !== 'string') return accountId;
  try {
    const data = await getNenColumnMetrics(c.env.DB, accountId, nenDeliveryRange({
      from: c.req.query('from'), to: c.req.query('to'), days: c.req.query('days'),
    }));
    return c.json({ success: true, data });
  } catch (error) {
    return metricsError(c, error);
  }
});

nenCampaigns.get('/api/nen-campaigns/metrics/pets', requireRole('owner', 'admin', 'staff'), async (c) => {
  const accountId = await requireAccount(c);
  if (typeof accountId !== 'string') return accountId;
  try {
    const data = await getNenPetMetrics(c.env.DB, accountId, nenMetricsRange(c.req.query('days')));
    return c.json({ success: true, data });
  } catch (error) {
    return metricsError(c, error);
  }
});

nenCampaigns.get('/api/nen-campaigns/deliveries', requireRole('owner', 'admin', 'staff'), async (c) => {
  const accountId = await requireAccount(c);
  if (typeof accountId !== 'string') return accountId;
  try {
    const data = await listNenDeliveries(c.env.DB, {
      lineAccountId: accountId,
      range: nenDeliveryRange({
        from: c.req.query('from'),
        to: c.req.query('to'),
        days: c.req.query('days'),
      }),
      status: normalizeDeliveryStatus(c.req.query('status')),
      q: c.req.query('q'),
      cursor: cursorOffset(c.req.query('cursor')),
      limit: listLimit(c.req.query('limit'), 50, 100),
    });
    return c.json({ success: true, data: buildOffsetListResponse({ ...data, items: data.deliveries, total: data.pagination.total, paging: { limit: data.pagination.limit }, sort: [{ field: 'scheduledAt', direction: 'desc' }, { field: 'id', direction: 'desc' }] }) });
  } catch (error) {
    return metricsError(c, error);
  }
});

nenCampaigns.get('/api/nen-campaigns/deliveries/:id', requireRole('owner', 'admin', 'staff'), async (c) => {
  const accountId = await requireAccount(c);
  if (typeof accountId !== 'string') return accountId;
  try {
    const data = await getNenDeliveryDetail(c.env.DB, c.req.param('id'), accountId);
    return c.json({ success: true, data });
  } catch (error) {
    return metricsError(c, error);
  }
});

nenCampaigns.post('/api/nen-campaigns/deliveries/:id/retry', requireDeliveryAccess('nenCampaigns'), inputJsonBoundary(), async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  const accountId = typeof body?.lineAccountId === 'string' ? body.lineAccountId.trim() : '';
  if (!accountId) return inputError(c, { success: false, error: 'LINEアカウントを選択してください' }, 400, ["lineAccountId"]);
  if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [accountId])) {
    return c.json({ success: false, error: ACCOUNT_ACCESS_ERROR }, 403);
  }
  try {
    const data = await retryNenDelivery(c.env.DB, {
      id: c.req.param('id'),
      lineAccountId: accountId,
      expectedVersion: Number(body?.expectedVersion),
      reason: typeof body?.reason === 'string' ? body.reason : '',
      staffId: c.get('staff').id,
    });
    auditLog(c, 'nen.delivery.retry', { kind: 'nen_delivery', id: data.id });
    return c.json({ success: true, data });
  } catch (error) {
    return metricsError(c, error);
  }
});

nenCampaigns.get('/api/nen-campaigns/columns', async (c) => {
  const accountId = await requireAccount(c);
  if (typeof accountId !== 'string') return accountId;
  // 件数制限なしの全件取得は件数が増えると重い(点検  の中6)。上限200・page送り付き。
  const { limit, offset } = parseOffsetPaging(
    { limit: c.req.query('limit'), offset: c.req.query('offset') }, { defaultLimit: 200 },
  );
  const totalRow = await c.env.DB.prepare(
    `SELECT COUNT(*) AS total FROM nen_columns WHERE line_account_id = ?`,
  ).bind(accountId).first<{ total: number }>();
  const total = Number(totalRow?.total ?? 0);
  const rows = await c.env.DB.prepare(
    `SELECT * FROM nen_columns WHERE line_account_id = ? ORDER BY published_at DESC, created_at DESC LIMIT ? OFFSET ?`,
  ).bind(accountId, limit, offset).all<Record<string, unknown>>();
  const responseItems = rows.results.map((row) => ({
    id: row.id, externalId: row.external_id, slug: row.slug, title: row.title, category: row.category,
    excerpt: row.excerpt, introText: typeof row.intro_text === 'string' && row.intro_text.trim()
      ? row.intro_text
      : buildDefaultColumnIntro(String(row.title || ''), String(row.excerpt || '')),
    articleUrl: row.article_url, imageUrl: row.image_url,
    publishedAt: row.published_at, deliveryStatus: row.delivery_status, deliveryAt: row.delivery_at,
    lineAccountId: row.line_account_id, updatedAt: row.updated_at,
    targetMode: row.target_mode === 'tag' ? 'tag' : 'all', targetTagId: row.target_tag_id ?? null,
    completionEventName: row.completion_event_name ?? null, completionTagId: row.completion_tag_id ?? null,
    sourceColumnId: row.source_column_id ?? null,
  }));
  return c.json(buildOffsetListResponse({ success: true, data: responseItems,
  pagination: { total, limit, offset }, items: responseItems, total: total, paging: { limit }, sort: [{ field: 'publishedAt', direction: 'desc' }, { field: 'createdAt', direction: 'desc' }] }));
});

nenCampaigns.get('/api/nen-campaigns/columns-preview', requireRole('owner', 'admin', 'staff'), async (c) => {
  const accountId = await requireAccount(c);
  if (typeof accountId !== 'string') return accountId;
  try {
    const targetMode = c.req.query('targetMode') === 'tag' ? 'tag' : 'all';
    const data = await previewNenColumnAudience(c.env.DB, {
      lineAccountId: accountId, targetMode, targetTagId: c.req.query('targetTagId')?.trim() || null,
    });
    return c.json({ success: true, data });
  } catch (error) {
    return columnOperationError(c, error);
  }
});

nenCampaigns.post('/api/nen-campaigns/columns', requireDeliveryAccess('nenCampaigns'), inputJsonBoundary(), async (c) => {
  const accountId = await requireAccount(c);
  if (typeof accountId !== 'string') return accountId;

  const parsed = await readBoundedJsonObject(c.req.raw);
  if (!parsed.ok) return inputError(c, { success: false, error: parsed.error }, parsed.status, []);
  const validated = validateNenColumnCreateBody(parsed.value);
  if (!validated.ok) return inputError(c, { success: false, error: validated.error }, 400, ["conditions"]);

  const input = validated.value;
  for (const tagId of new Set([input.targetTagId, input.completionTagId].filter((value): value is string => Boolean(value)))) {
    const tag = await c.env.DB.prepare(
      `SELECT id FROM tags WHERE id = ? AND line_account_id = ?`,
    ).bind(tagId, accountId).first<{ id: string }>();
    if (!tag) return inputError(c, { success: false, error: 'target_invalid' }, 400, ["targetTagId"]);
  }
  if (input.sourceColumnId) {
    const source = await c.env.DB.prepare(
      `SELECT id FROM nen_columns WHERE id = ? AND line_account_id = ?`,
    ).bind(input.sourceColumnId, accountId).first<{ id: string }>();
    if (!source) return inputError(c, { success: false, error: 'target_invalid' }, 400, ["sourceColumnId"]);
  }
  const existing = await c.env.DB.prepare(
    `SELECT id FROM nen_columns WHERE slug = ?`,
  ).bind(input.slug).first<{ id: string }>();
  if (existing) return c.json({ success: false, error: 'column_already_exists' }, 409);

  const id = crypto.randomUUID();
  const now = jstNow();
  const fields = buildNenColumnStorageFields(input);
  /*
   * 列・値・bind を一致させる（delivery_at が抜けていて INSERT が必ず失敗していた）。
   * 下書き保存はこのINSERTだけ。配信日時が入っていても配信待ち行列へは入れず、
   * 「配信したい日時」として delivery_at に残す（予約は POST /columns/:id/deliver の
   * 明示操作だけが行う）。ISO8601(Z付き)で保存し、表示側が日本時間で読める形にする。
   */
  try {
    await c.env.DB.prepare(
      `INSERT INTO nen_columns
        (id, external_id, slug, title, category, excerpt, intro_text, article_url, image_url,
         published_at, delivery_status, delivery_at, line_account_id, target_mode, target_tag_id,
         completion_event_name, completion_tag_id, source_column_id, created_at, updated_at)
       VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id, input.slug, fields.title, fields.category, fields.excerpt, fields.introText,
      fields.articleUrl, fields.imageUrl, fields.publishedAt, input.scheduledAt, accountId, input.targetMode,
      input.targetTagId, input.completionEventName, input.completionTagId, input.sourceColumnId, now, now,
    ).run();
  } catch (error) {
    if (isNenColumnSlugConflict(error)) {
      return c.json({ success: false, error: 'column_already_exists' }, 409);
    }
    throw error;
  }
  auditLog(c, 'nen.column.create', {kind:'nen_column',id}, {lineAccountId:accountId});
  return c.json({ success: true, data: { id, queued: 0 } }, 201);
});

nenCampaigns.post('/api/nen-campaigns/columns/:id/duplicate', requireDeliveryAccess('nenCampaigns'), inputJsonBoundary({"accountId":["string"]}), async (c) => {
  const body = await c.req.json<{ accountId?: string }>().catch(() => null);
  if (!body?.accountId || !await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [body.accountId])) {
    return c.json({ success: false, error: ACCOUNT_ACCESS_ERROR }, 403);
  }
  /*
   * 複製の要求キー。二重押し・応答消失後の再送は同じ複製へ戻し、
   * 2本目を作らない。キーは複製行の主キーになる。
   */
  const idempotencyKey = c.req.header('Idempotency-Key')?.trim() || null;
  if (idempotencyKey && !isValidIdempotencyKey(idempotencyKey)) {
    return inputError(c, { success: false, error: 'Idempotency-Key はUUIDで送ってください' }, 400, []);
  }
  const sourceId = c.req.param('id');
  const findDuplicate = () => c.env.DB.prepare(
    `SELECT id, source_column_id FROM nen_columns WHERE id = ? AND line_account_id = ?`,
  ).bind(idempotencyKey, body.accountId).first<{ id: string; source_column_id: string | null }>();
  try {
    if (idempotencyKey) {
      const existing = await findDuplicate();
      if (existing) {
        if (existing.source_column_id !== sourceId) {
          return c.json({ success: false, error: '同じ操作で内容の違う複製が既にあります' }, 409);
        }
        c.header('Idempotency-Replayed', 'true');
        return c.json({ success: true, data: { id: existing.id, sourceColumnId: sourceId }, replayed: true }, 200);
      }
    }
    const data = await duplicateNenColumn(c.env.DB, {
      id: sourceId, lineAccountId: body.accountId, newId: idempotencyKey ?? undefined,
    });
    auditLog(c, 'nen.column.duplicate', { kind: 'nen_column', id: data.id });
    return c.json({ success: true, data }, 201);
  } catch (error) {
    // 同時実行の競合で負けた側。勝った複製を読み直して返す。
    if (idempotencyKey) {
      const raced = await findDuplicate();
      if (raced && raced.source_column_id === sourceId) {
        c.header('Idempotency-Replayed', 'true');
        return c.json({ success: true, data: { id: raced.id, sourceColumnId: sourceId }, replayed: true }, 200);
      }
    }
    return columnOperationError(c, error);
  }
});

nenCampaigns.post('/api/nen-campaigns/columns/:id/test-send', requireDeliveryAccess('nenCampaigns'), inputJsonBoundary({"accountId":["string"],"friendId":["string"]}), async (c) => {
  const body = await c.req.json<{ accountId?: string; friendId?: string }>().catch(() => null);
  if (!body?.accountId || !body.friendId) {
    return fail(c, 400, 'ACCOUNT_ID_AND_FRIEND_ID_ARE_REQUIRED', {}, ["accountId","friendId"]);
  }
  if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [body.accountId])) {
    return c.json({ success: false, error: ACCOUNT_ACCESS_ERROR }, 403);
  }
  const [campaign, account, friend, column] = await Promise.all([
    getNenCampaign(c.env.DB, 'column', body.accountId),
    getLineAccountById(c.env.DB, body.accountId),
    getTestRecipient(c, body.accountId, body.friendId),
    c.env.DB.prepare(
      `SELECT title, excerpt, article_url, image_url, intro_text FROM nen_columns
        WHERE id = ? AND line_account_id = ?`,
    ).bind(c.req.param('id'), body.accountId).first<Record<string, unknown>>(),
  ]);
  if (!friend) return c.json({ success: false, code: 'test_recipient_unavailable', error: 'テスト送信先が登録されていないか、友だち追加されていません' }, 404);
  if (!campaign || !account || !column) {
    return fail(c, 404, 'TEST_TARGET_NOT_FOUND');
  }
  const { pushViaHarnessProxy } = await import('../services/line-proxy-send.js');
  const { dispatchLineProxyLocally } = await import('../services/local-line-proxy.js');
  await pushViaHarnessProxy(
    c.env.WORKER_PUBLIC_URL || new URL(c.req.url).origin,
    account.channel_access_token,
    friend.line_user_id,
    buildNenDeliveryMessages(campaign, { article: column }),
    crypto.randomUUID(),
    (request) => dispatchLineProxyLocally(request, c.env),
  );
  return c.json({ success: true });
});

nenCampaigns.post(
  '/api/nen-campaigns/columns/:id/read-events',
  requireRole('owner', 'admin', 'staff'),
  inputJsonBoundary(), async (c) => {
    const body = await c.req.json<Record<string, unknown>>().catch(() => null);
    if (!body || typeof body.lineAccountId !== 'string' || typeof body.friendId !== 'string'
      || (body.eventKind !== 'opened' && body.eventKind !== 'completed') || typeof body.idempotencyKey !== 'string') {
      return inputError(c, { success: false, error: 'Invalid body' }, 400, []);
    }
    if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [body.lineAccountId])) {
      return c.json({ success: false, error: ACCOUNT_ACCESS_ERROR }, 403);
    }
    try {
      const data = await recordNenColumnReadEvent(c.env.DB, {
        lineAccountId: body.lineAccountId, columnId: c.req.param('id'), friendId: body.friendId,
        eventKind: body.eventKind, idempotencyKey: body.idempotencyKey,
        occurredAt: typeof body.occurredAt === 'string' ? body.occurredAt : undefined,
      });
      return c.json({ success: true, data });
    } catch (error) {
      return columnOperationError(c, error);
    }
  },
);

nenCampaigns.post('/api/nen-campaigns/deliveries/pending-now', requireDeliveryAccess('nenCampaigns'), inputJsonBoundary({"accountId":["string"],"expectedCount":["number"]}), async (c) => {
  const body = await c.req.json<{ accountId?: string; expectedCount?: number }>().catch(() => null);
  if (!body?.accountId || !await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [body.accountId])) {
    return c.json({ success: false, error: ACCOUNT_ACCESS_ERROR }, 403);
  }
  try {
    const data = await sendPendingNenDeliveriesNow(c.env.DB, {
      lineAccountId: body.accountId, expectedCount: Number(body.expectedCount),
    });
    auditLog(c, 'nen.delivery.pending_now', { kind: 'line_account', id: body.accountId });
    return c.json({ success: true, data });
  } catch (error) {
    return columnOperationError(c, error);
  }
});

nenCampaigns.get('/api/nen-campaigns/columns/:id/send-preview', requireDeliveryAccess('nenCampaigns'), async (c) => {
  const accountId = await requireAccount(c);
  if (typeof accountId !== 'string') return accountId;
  try {
    const snapshot = await nenColumnConfirmation(c.env.DB, accountId, c.req.param('id'));
    const col = snapshot.column;
    if (snapshot.campaign.is_enabled !== 1) return c.json({ success: false, code: 'COLUMN_CONFIRMATION_CHANGED', error: 'コラム配信が停止しています。', data: { recipientCount: snapshot.recipientCount } }, 409);
    return c.json({ success: true, data: {
      recipientCount: snapshot.recipientCount, confirmationToken: snapshot.confirmationToken,
      column: { id: col.id, title: col.title, excerpt: col.excerpt, introText: col.intro_text?.trim() ? col.intro_text : buildDefaultColumnIntro(col.title, col.excerpt), articleUrl: col.article_url, imageUrl: col.image_url, targetMode: col.target_mode, targetTagId: col.target_tag_id, updatedAt: col.updated_at },
      campaign: { updatedAt: snapshot.campaign.updated_at, buttonLabel: snapshot.campaign.button_label },
      messages: buildNenDeliveryMessages(snapshot.campaign, { article: col }),
    } });
  } catch (error) { return columnOperationError(c, error); }
});

nenCampaigns.post('/api/nen-campaigns/columns/:id/deliver', requireDeliveryAccess('nenCampaigns'), inputJsonBoundary({"accountId":["string"],"scheduledAt":["string"],"recipientCount":["number"],"confirmationToken":["string"]}), async (c) => {
  const body = await c.req.json<{ accountId?: string; scheduledAt?: string; recipientCount?: unknown; confirmationToken?: unknown }>().catch(() => null);
  if (!body?.accountId) return fail(c, 400, 'ACCOUNT_ID_REQUIRED', {}, ["accountId"]);
  if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [body.accountId])) {
    return c.json({ success: false, error: ACCOUNT_ACCESS_ERROR }, 403);
  }
  /*
   *  予約日時を先に確かめる。解釈できない文字列をnowへ潰さず断り、
   * 過去の日時は「予約」の約束を守れない（次のtickで即送になる）ため断る。
   * 予約作成(POST /columns)と同じくDBを触る前に落とす。
   */
  let when: string;
  if (body.scheduledAt) {
    const parsed = Date.parse(body.scheduledAt);
    if (!Number.isFinite(parsed)) {
      return inputError(c, { success: false, error: 'scheduled_at_invalid' }, 400, ["scheduledAt"]);
    }
    if (parsed <= Date.now()) {
      return inputError(c, { success: false, error: 'past_datetime' }, 400, ["scheduledAt"]);
    }
    when = new Date(parsed).toISOString().slice(0, 19).replace('T', ' ');
  } else {
    when = new Date().toISOString().slice(0, 19).replace('T', ' ');
  }
  let queued: number;
  const confirmed = body.recipientCount !== undefined || body.confirmationToken !== undefined;
  if (confirmed && (!Number.isSafeInteger(body.recipientCount) || Number(body.recipientCount) < 0 || typeof body.confirmationToken !== 'string' || !/^[a-f0-9]{64}$/.test(body.confirmationToken))) return inputError(c, { success: false, error: '送る相手を確認し直してください' }, 400, ['recipientCount','confirmationToken']);
  try {
    queued = confirmed
      ? await enqueueConfirmedNenColumn(c.env.DB, body.accountId, c.req.param('id'), when, { recipientCount: Number(body.recipientCount), confirmationToken: body.confirmationToken as string })
      : await queueColumnDelivery(c.env.DB, c.req.param('id'), body.accountId, when);
  } catch (error) {
    if (error instanceof NenColumnConfirmationConflict) return c.json({ success: false, code: 'COLUMN_CONFIRMATION_CHANGED', error: error.message, data: { recipientCount: error.current?.recipientCount ?? null } }, 409);
    if (error instanceof NenColumnOperationError) return columnOperationError(c, error);
    throw error;
  }
  auditLog(c, 'nen.column.schedule', {kind:'nen_column',id:c.req.param('id')}, {lineAccountId:body.accountId});
  return c.json({ success: true, data: { queued } });
});

nenCampaigns.put('/api/nen-campaigns/columns/:id/message', requireDeliveryAccess('nenCampaigns'), inputJsonBoundary({"introText":["string"],"expectedUpdatedAt":["string"]}), async (c) => {
  const accountId = await requireAccount(c);
  if (typeof accountId !== 'string') return accountId;
  const body = await c.req.json<{ introText?: string; expectedUpdatedAt?: string }>().catch(() => null);
  const introText = body?.introText?.trim() || '';
  if (!introText || introText.length > 1500) {
    return inputError(c, { success: false, error: 'introText is required and must be 1500 characters or fewer' }, 400, ["introText"]);
  }
  /*
   * 紹介文の同時保存は後勝ちで先の変更が黙って消えていた。
   * 版（expectedUpdatedAt）が送られてきたときだけ照合してから書く。
   * 古い画面からの保存は409で止め、最新の紹介文を data.latest で返す。
   * 送られてこない従来の呼び出しは以前とまったく同じ書き方で通す。
   * 版は必ず単調に進める（同じミリ秒の連打でも見分けられる）。
   */
  const expectedUpdatedAt = typeof body?.expectedUpdatedAt === 'string' ? body.expectedUpdatedAt : null;
  if (expectedUpdatedAt === null) {
    const stamped = jstNow();
    const result = await c.env.DB.prepare(
      `UPDATE nen_columns SET intro_text = ?, updated_at = ? WHERE id = ? AND line_account_id = ?`,
    ).bind(introText, stamped, c.req.param('id'), accountId).run();
    if (!result.meta.changes) return fail(c, 404, 'COLUMN_NOT_FOUND');
    auditLog(c, 'nen.column.save', {kind:'nen_column',id:c.req.param('id')}, {lineAccountId:accountId});
    return c.json({ success: true, data: { updatedAt: stamped } });
  }
  const seen = await c.env.DB.prepare(
    `SELECT intro_text, updated_at FROM nen_columns WHERE id = ? AND line_account_id = ?`,
  ).bind(c.req.param('id'), accountId).first<{ intro_text: string | null; updated_at: string }>();
  if (!seen) return fail(c, 404, 'COLUMN_NOT_FOUND');
  if (seen.updated_at !== expectedUpdatedAt) {
    return c.json({
      success: false, code: 'VERSION_CONFLICT',
      error: 'ほかの人が先に紹介文を変えました。最新の内容を確認してから保存し直してください。',
      data: { latest: { introText: seen.intro_text ?? '', updatedAt: seen.updated_at } },
    }, 409);
  }
  const stamped = nextVersionToken(seen.updated_at);
  const written = await c.env.DB.prepare(
    `UPDATE nen_columns SET intro_text = ?, updated_at = ? WHERE id = ? AND line_account_id = ? AND updated_at = ?`,
  ).bind(introText, stamped, c.req.param('id'), accountId, seen.updated_at).run();
  if (!written.meta.changes) {
    const latest = await c.env.DB.prepare(
      `SELECT intro_text, updated_at FROM nen_columns WHERE id = ? AND line_account_id = ?`,
    ).bind(c.req.param('id'), accountId).first<{ intro_text: string | null; updated_at: string }>();
    if (!latest) return fail(c, 404, 'COLUMN_NOT_FOUND');
    return c.json({
      success: false, code: 'VERSION_CONFLICT',
      error: 'ほかの人が先に紹介文を変えました。最新の内容を確認してから保存し直してください。',
      data: { latest: { introText: latest.intro_text ?? '', updatedAt: latest.updated_at } },
    }, 409);
  }
  auditLog(c, 'nen.column.save', {kind:'nen_column',id:c.req.param('id')}, {lineAccountId:accountId});
  return c.json({ success: true, data: { updatedAt: stamped } });
});

nenCampaigns.get('/api/nen-campaigns/pets', requireRole('owner', 'admin', 'staff'), async (c) => {
  const accountId = await requireAccount(c);
  if (typeof accountId !== 'string') return accountId;
  const query = (c.req.query('search') || '').trim();
  const like = `%${query.replace(/[\\%_]/g, '\\$&')}%`;
  const rows = await c.env.DB.prepare(
    `SELECT p.id, p.friend_id, p.customer_id, p.name, p.animal_type, p.gender, p.birthday, p.updated_at,
            f.display_name, f.line_user_id
       FROM nen_pet_profiles p JOIN friends f ON f.id = p.friend_id
      WHERE p.archived_at IS NULL AND f.line_account_id = ?
        AND (? = '' OR p.name LIKE ? ESCAPE '\\' OR f.display_name LIKE ? ESCAPE '\\')
      ORDER BY p.updated_at DESC LIMIT 200`,
  ).bind(accountId, query, like, like).all<Record<string, unknown>>();
  return c.json({ success: true, data: rows.results.map((row) => ({
    id: row.id, friendId: row.friend_id, customerId: row.customer_id, name: row.name,
    animalType: row.animal_type, gender: row.gender, birthday: row.birthday,
    ownerName: row.display_name, lineUserId: row.line_user_id,
    // 更新の版照合に使う。無ければ送らず従来どおり通す。
    updatedAt: typeof row.updated_at === 'string' ? row.updated_at : '',
  })) });
});

/*
 * 登録ボタンの二重押し・通信再送で同じペットが2頭できないよう、
 * Idempotency-Key を行IDにする（broadcasts と同じ決めごと）。キーが無い
 * 従来の呼び出しはそのまま作る。同じキーで内容が違う再送は取り違えなので
 * 409 で止める。再送の返しは作り直さない。
 */
function samePetCreateRequest(existing: {
  friend_id: string; customer_id: string | null; name: string; animal_type: string;
  gender: string; birthday: string | null; breed: string | null; weight_kg: number | null;
}, friendId: string, customerId: string | null, input: {
  name: string; animalType: string; gender: string; birthday: string | null;
  breed: string | null; weightKg: number | null;
}): boolean {
  return existing.friend_id === friendId
    && (existing.customer_id ?? null) === (customerId ?? null)
    && existing.name === input.name
    && existing.animal_type === input.animalType
    && existing.gender === input.gender
    && (existing.birthday ?? null) === (input.birthday ?? null)
    && (existing.breed ?? null) === (input.breed ?? null)
    && (existing.weight_kg ?? null) === (input.weightKg ?? null);
}

async function findPetById(db: D1Database, id: string) {
  return db.prepare(
    `SELECT p.friend_id, p.customer_id, p.name, p.animal_type, p.gender, p.birthday, p.breed, p.weight_kg,
            f.line_account_id
       FROM nen_pet_profiles p JOIN friends f ON f.id = p.friend_id WHERE p.archived_at IS NULL AND p.id = ?`,
  ).bind(id).first<{
    friend_id: string; customer_id: string | null; name: string; animal_type: string;
    gender: string; birthday: string | null; breed: string | null; weight_kg: number | null;
    line_account_id: string | null;
  }>();
}

nenCampaigns.post('/api/nen-campaigns/pets', requireDeliveryAccess('nenCampaigns'), inputJsonBoundary(), async (c) => {
  const accountId = await requireAccount(c);
  if (typeof accountId !== 'string') return accountId;
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body || typeof body.friendId !== 'string') {
    return inputError(c, { success: false, error: 'friendId and name are required' }, 400, ["friendId"]);
  }
  const input = petWriteBody(body);
  if ('error' in input) return inputError(c, { success: false, error: input.error }, 400, ["name","birthday","weightKg","animalType","gender","breed"]);
  const friend = await c.env.DB.prepare(`SELECT id, line_account_id FROM friends WHERE id = ?`)
    .bind(body.friendId).first<{ id: string; line_account_id: string | null }>();
  if (!friend || friend.line_account_id !== accountId) {
    return fail(c, 404, 'FRIEND_NOT_FOUND');
  }
  const customerId = typeof body.customerId === 'string' ? body.customerId : null;
  const rawKey = c.req.header('Idempotency-Key')?.trim() || null;
  if (rawKey !== null && !isValidIdempotencyKey(rawKey)) {
    return inputError(c, { success: false, error: '再実行キーの形式が正しくありません' }, 400, []);
  }
  if (rawKey) {
    const existing = await findPetById(c.env.DB, rawKey);
    if (existing && existing.line_account_id === accountId) {
      if (!samePetCreateRequest(existing, body.friendId, customerId, input)) {
        return c.json({ success: false, code: 'IDEMPOTENCY_CONFLICT', error: '同じ再実行キーが別の内容に使われています' }, 409);
      }
      c.header('Idempotency-Replayed', 'true');
      return c.json({ success: true, duplicate: true, data: { id: rawKey } }, 200);
    }
    if (existing) {
      return c.json({ success: false, code: 'IDEMPOTENCY_CONFLICT', error: '同じ再実行キーが別の内容に使われています' }, 409);
    }
  }
  const now = jstNow();
  const id = rawKey ?? crypto.randomUUID();
  try {
    await c.env.DB.prepare(
      `INSERT INTO nen_pet_profiles (id, friend_id, customer_id, name, animal_type, gender, birthday, breed, weight_kg, created_at, updated_at, weight_updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, body.friendId, customerId,
      input.name, input.animalType, input.gender, input.birthday, input.breed, input.weightKg, now, now,
      // 体重を入れて登録したときだけ「測った日＝登録日」を記録（監査 R57）。
      input.weightKg == null ? null : now).run();
  } catch (error) {
    // 並行した再送が先に作ったときだけ保存済みを返す。それ以外は投げ直す。
    const existing = rawKey ? await findPetById(c.env.DB, rawKey) : null;
    if (!existing || existing.line_account_id !== accountId) throw error;
    if (!samePetCreateRequest(existing, body.friendId, customerId, input)) {
      return c.json({ success: false, code: 'IDEMPOTENCY_CONFLICT', error: '同じ再実行キーが別の内容に使われています' }, 409);
    }
    c.header('Idempotency-Replayed', 'true');
    return c.json({ success: true, duplicate: true, data: { id: rawKey } }, 200);
  }
  await syncNenPetTags(c.env.DB, body.friendId);
  return c.json({ success: true, data: { id } }, 201);
});

nenCampaigns.put('/api/nen-campaigns/pets/:id', requireDeliveryAccess('nenCampaigns'), inputJsonBoundary({"expectedUpdatedAt":["string"]}), async (c) => {
  const accountId = await requireAccount(c);
  if (typeof accountId !== 'string') return accountId;
  const body = await c.req.json<Record<string, unknown> & { expectedUpdatedAt?: string }>().catch(() => null);
  // 入力検証はDBを読む前に済ませる。無効な入力ではDBへ一切行かない。
  const patch = petPatchBody(body ?? {});
  if ('error' in patch) return inputError(c, { success: false, error: patch.error, field: patch.field }, 400, []);
  const pet = await c.env.DB.prepare(
    `SELECT p.friend_id, p.name, p.animal_type, p.gender, p.birthday, p.breed, p.weight_kg, p.updated_at, f.line_account_id
     FROM nen_pet_profiles p JOIN friends f ON f.id = p.friend_id WHERE p.archived_at IS NULL AND p.id = ?`,
  ).bind(c.req.param('id')).first<{
    friend_id: string; name: string; animal_type: string; gender: string;
    birthday: string | null; breed: string | null; weight_kg: number | null;
    updated_at: string; line_account_id: string | null;
  }>();
  if (!pet || pet.line_account_id !== accountId) {
    return fail(c, 404, 'PET_NOT_FOUND');
  }
  /*
   * ペット更新の同時保存は後勝ちで先の変更が黙って消えていた。
   * 版（expectedUpdatedAt）が送られてきたときだけ updated_at の一致も
   * 条件に入れる。古い画面からの保存は409で止め、最新の名前つきで返す。
   * 送られてこない従来の呼び出しはそのまま通す。
   */
  const petExpectedUpdatedAt = typeof body?.expectedUpdatedAt === 'string' ? body.expectedUpdatedAt : null;
  // 送られてこなかった項目は現値を保つ部分更新（LIFF PUT と同じ意味づけ）。
  // 既定値で上書きすると、名前だけ直す更新で他項目まで消えてしまう。
  const input = {
    name: patch.name ?? pet.name,
    animalType: patch.animalType ?? pet.animal_type,
    gender: patch.gender ?? pet.gender,
    birthday: patch.birthday === undefined ? pet.birthday : patch.birthday,
    breed: patch.breed === undefined ? pet.breed : patch.breed,
    weightKg: patch.weightKg === undefined ? pet.weight_kg : patch.weightKg,
  };
  // 監査 R57: 「体重の更新」は体重が実際に変わったときだけ動かす。
  // 名前だけの編集や同じ値の再送では日付を維持する。
  // 版つきの保存は版を必ず単調に進める（同じミリ秒の連打でも見分けられる）。
  const weightTouched = patch.weightKg !== undefined && patch.weightKg !== pet.weight_kg;
  const petNewUpdatedAt = petExpectedUpdatedAt === null ? jstNow() : nextVersionToken(pet.updated_at);
  const petWritten = await c.env.DB.prepare(
    `UPDATE nen_pet_profiles SET name = ?, animal_type = ?, gender = ?, birthday = ?, breed = ?, weight_kg = ?, updated_at = ?,
       weight_updated_at = CASE WHEN ? THEN ? ELSE weight_updated_at END
     WHERE (? IS NULL OR updated_at = ?) AND id = ?`,
  ).bind(input.name, input.animalType, input.gender, input.birthday, input.breed, input.weightKg, petNewUpdatedAt,
    weightTouched ? 1 : 0, jstNow(), petExpectedUpdatedAt, petExpectedUpdatedAt, c.req.param('id')).run();
  if (!petWritten.meta.changes) {
    const latest = await c.env.DB.prepare(
      `SELECT p.name, p.animal_type, p.gender, p.birthday, p.breed, p.weight_kg, p.updated_at, f.line_account_id
         FROM nen_pet_profiles p JOIN friends f ON f.id = p.friend_id WHERE p.archived_at IS NULL AND p.id = ?`,
    ).bind(c.req.param('id')).first<{
      name: string; animal_type: string; gender: string; birthday: string | null;
      breed: string | null; weight_kg: number | null; updated_at: string; line_account_id: string | null;
    }>();
    if (!latest || latest.line_account_id !== accountId) {
      return fail(c, 404, 'PET_NOT_FOUND');
    }
    return c.json({
      success: false, code: 'VERSION_CONFLICT',
      error: 'ほかの人が先にペットの情報を変えました。最新の内容を確認してから保存し直してください。',
      data: {
        latest: {
          name: latest.name, animalType: latest.animal_type, gender: latest.gender,
          birthday: latest.birthday, breed: latest.breed, weightKg: latest.weight_kg,
          updatedAt: latest.updated_at,
        },
      },
    }, 409);
  }
  // 誕生日を明示して変えたときだけ、古い日付へ予約済みの誕生日クーポン配信を
  // 取消し、次の日次走査で新しい誕生日から組み直させる。発行済みの今年分は残る。
  if (patch.birthday !== undefined && (pet.birthday ?? null) !== patch.birthday) {
    await c.env.DB.prepare(
      `UPDATE nen_delivery_jobs SET status = 'cancelled', updated_at = ?
       WHERE campaign_key = 'birthday_coupon' AND status = 'pending' AND source_key LIKE ?`,
    ).bind(jstNow(), `birthday:${c.req.param('id')}:%`).run();
  }
  await syncNenPetTags(c.env.DB, pet.friend_id);
  return c.json({ success: true, data: { updatedAt: petNewUpdatedAt } });
});

nenCampaigns.delete('/api/nen-campaigns/pets/:id', requireDeliveryAccess('nenCampaigns'), async (c) => {
  const accountId = await requireAccount(c);
  if (typeof accountId !== 'string') return accountId;
  const pet = await c.env.DB.prepare(`SELECT p.friend_id, f.line_account_id FROM nen_pet_profiles p JOIN friends f ON f.id = p.friend_id WHERE p.archived_at IS NULL AND p.id = ?`)
    .bind(c.req.param('id')).first<{ friend_id: string; line_account_id: string | null }>();
  if (!pet || pet.line_account_id !== accountId) {
    return fail(c, 404, 'PET_NOT_FOUND');
  }
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE nen_pet_profiles SET archived_at=?, updated_at=? WHERE id=? AND archived_at IS NULL`).bind(jstNow(), jstNow(), c.req.param('id')),
    c.env.DB.prepare(`UPDATE nen_delivery_jobs SET status='cancelled', updated_at=? WHERE source_key LIKE ? AND status IN ('pending','failed')`).bind(jstNow(), `birthday:${c.req.param('id')}:%`),
  ]);
  auditLog(c, 'nen.pet.archive', {kind:'nen_pet', id:c.req.param('id')}, {lineAccountId:accountId});
  await syncNenPetTags(c.env.DB, pet.friend_id);
  return c.json({ success: true });
});

nenCampaigns.get('/api/nen-campaigns/birthday-coupon', async (c) => {
  const accountId = await requireAccount(c);
  if (typeof accountId !== 'string') return accountId;
  const row = await getNenBirthdayCouponSetting(c.env.DB, accountId);
  return c.json({ success: true, data: {
    isEnabled: row?.is_enabled === 1, codePrefix: row?.code_prefix ?? '',
    benefitLabel: row?.benefit_label ?? '', discountAmount: row?.discount_amount ?? 0,
    validityDays: row?.validity_days ?? 0,
    // キー無しの既存設定は従来動作（平年に届かない）= 'skip'。
    // まだ保存したことが無いアカウントは要件の既定 'feb28' を見せる。
    leapYearPolicy: row ? (row.leap_year_policy ?? 'skip') : 'feb28',
    updatedAt: row?.updated_at ?? '',
  } });
});

nenCampaigns.put('/api/nen-campaigns/birthday-coupon', requireDeliveryAccess('nenCampaigns'), inputJsonBoundary(), async (c) => {
  const accountId = await requireAccount(c);
  if (typeof accountId !== 'string') return accountId;
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  const days = Number(body?.validityDays);
  const amount = Number(body?.discountAmount);
  if (!body || typeof body.isEnabled !== 'boolean' || typeof body.codePrefix !== 'string'
      || !/^[A-Z0-9-]{3,10}$/.test(body.codePrefix) || typeof body.benefitLabel !== 'string'
      || !body.benefitLabel.trim() || !Number.isInteger(amount) || amount < 1 || amount > 100000
      || !Number.isInteger(days) || days < 1 || days > 365) {
    return inputError(c, { success: false, error: 'Invalid coupon settings' }, 400, ["isEnabled","codePrefix","benefitLabel","discountAmount","validityDays"]);
  }
  // 2月29日生まれの扱い。送られてきたら検証し、省略なら既存値を守る
  // （旧クライアントからの保存で 'skip' 扱いの設定を無断で変えない）。
  let leapYearPolicy: 'feb28' | 'mar1' | 'skip' | undefined;
  if (body.leapYearPolicy !== undefined) {
    if (!['feb28', 'mar1', 'skip'].includes(body.leapYearPolicy as string)) {
      return inputError(c, { success: false, error: 'Invalid leapYearPolicy' }, 400, ["leapYearPolicy"]);
    }
    leapYearPolicy = body.leapYearPolicy as 'feb28' | 'mar1' | 'skip';
  } else {
    const existing = await getNenBirthdayCouponSetting(c.env.DB, accountId);
    leapYearPolicy = existing ? (existing.leap_year_policy ?? 'skip') : 'feb28';
  }
  await saveNenBirthdayCouponSetting(c.env.DB, accountId, {
    is_enabled: body.isEnabled ? 1 : 0,
    code_prefix: body.codePrefix,
    benefit_label: body.benefitLabel.trim(),
    discount_amount: amount,
    validity_days: days,
    leap_year_policy: leapYearPolicy,
    updated_at: jstNow(),
  });
  auditLog(c, 'nen.birthday_coupon.save', {kind:'line_account', id:accountId}, {lineAccountId:accountId});
  return c.json({ success: true });
});

// EC-CUBEのコラム保存時に自動同期する公開エンドポイント。管理者認証ではなくHMACで検証する。
/**
 * EC-CUBE が `line_account_id` を送らないときの宛先（`/events` の resolveAccountIdWithoutHeader と同じ2番目の決まり）。
 * 動いている LINE アカウントが 1 つだけならそのアカウント。決まらなければ null（未割り当てのまま保存し、
 * 管理画面の「ECのコラムを取り込む」で割り当てる）。
 */
async function resolveSoleActiveAccountId(db: D1Database): Promise<string | null> {
  const rows = await db.prepare(
    `SELECT id FROM line_accounts WHERE is_active = 1 AND archived_at IS NULL ORDER BY id LIMIT 2`,
  ).all<{ id: string }>();
  const ids = (rows.results ?? []).map((row) => String(row.id));
  return ids.length === 1 ? ids[0] : null;
}

/**
 * 未割り当て（line_account_id IS NULL）の EC コラムを、選択中の LINE アカウントへ割り当てる。
 * ★37-6-A「ECのコラムを取り込む」。EC で保存されたコラムは Webhook で自動的に届くが、
 * 宛先が決められなかった分（アカウントが複数ある・古いコラム）がここに残る。
 */
nenCampaigns.post('/api/nen-campaigns/columns/import', requireDeliveryAccess('nenCampaigns'), inputJsonBoundary(), async (c) => {
  const accountId = await requireAccount(c);
  if (typeof accountId !== 'string') return accountId;
  const account = await getLineAccountById(c.env.DB, accountId);
  if (!account) return fail(c, 404, 'LINE_ACCOUNT_NOT_FOUND');
  const result = await c.env.DB.prepare(
    `UPDATE nen_columns SET line_account_id = ?, updated_at = ? WHERE line_account_id IS NULL`,
  ).bind(accountId, jstNow()).run();
  const imported = result.meta.changes ?? 0;
  if (imported > 0) auditLog(c, 'nen.column.import', { kind: 'line_account', id: accountId }, { lineAccountId: accountId });
  return c.json({ success: true, data: { imported } });
});

nenCampaigns.post('/api/integrations/eccube/columns', inputJsonBoundary(), async (c) => {
  const secret = c.env.ECCUBE_WEBHOOK_SECRET;
  if (!secret || secret.length < 32) return c.json({ success: false, error: 'Integration is not configured' }, 503);
  const raw = await c.req.text();
  if (isWebhookBodyTooLarge(raw, MAX_BODY_BYTES)) return c.json({ success: false, error: 'Payload too large' }, 413);
  const valid = await verifyEccubeSignature(
    secret, c.req.header('x-nen-timestamp') || '', c.req.header('x-nen-signature') || '', raw,
  );
  if (!valid) return c.json({ success: false, error: 'Invalid signature' }, 401);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return inputError(c, { success: false, error: 'Invalid JSON' }, 400, []);
  }
  if (typeof body.slug !== 'string' || typeof body.title !== 'string' || typeof body.article_url !== 'string'
      || !body.slug || !body.title || !isUrl(body.article_url)
      || (body.image_url && (typeof body.image_url !== 'string' || !isUrl(body.image_url)))) {
    return inputError(c, { success: false, error: 'Invalid column' }, 400, ["slug","title","article_url","image_url"]);
  }
  // 管理画面の validateNenColumnCreateBody と同じ値で検証し、送信元の
  // EC-Cube側フォームも独立に120字で制約している（JournalController.php の
  // titleフィールド、Assert\Length(max:120)）が、それはLHが保証されたもの
  // ではない。経路ごとに異なる上限を作らず、
  // 管理画面と同じ120を採った。
  if (body.title.length > 120) {
    logger.error("nen_eccube_column_title_rejected");
    return inputError(c, { success: false, error: 'title_invalid' }, 400, ["title"]);
  }
  const requestedLineAccountId = typeof body.line_account_id === 'string' ? body.line_account_id : null;
  if (requestedLineAccountId && !await getLineAccountById(c.env.DB, requestedLineAccountId)) {
    return fail(c, 404, 'LINE_ACCOUNT_NOT_FOUND');
  }
  // EC-CUBE 標準（LineColumnSyncService）は line_account_id を送らない。アカウントが 1 つなら
  // そこへ入れる。NULL のままだと管理画面の一覧（WHERE line_account_id = ?）に出ず、
  // 「自動で取り込まれない」ように見える。
  const lineAccountId = requestedLineAccountId ?? await resolveSoleActiveAccountId(c.env.DB);
  const now = jstNow();
  const existing = await c.env.DB.prepare(
    `SELECT id, line_account_id FROM nen_columns WHERE slug = ?`,
  ).bind(body.slug).first<{ id: string; line_account_id: string | null }>();
  if (existing?.line_account_id && lineAccountId && existing.line_account_id !== lineAccountId) {
    return c.json({ success: false, error: 'Column belongs to another LINE account' }, 409);
  }
  const id = existing?.id || crypto.randomUUID();
  const fields = buildNenColumnStorageFields({
    title: body.title,
    category: typeof body.category === 'string' ? body.category : null,
    excerpt: typeof body.excerpt === 'string' ? body.excerpt.slice(0, 500) : '',
    articleUrl: body.article_url,
    imageUrl: typeof body.image_url === 'string' ? body.image_url : null,
    publishedAt: typeof body.published_at === 'string' ? body.published_at : null,
  });
  // intro_textはON CONFLICTのSET句に含めない（意図的）。EC-Cubeはintro_textを
  // 送らないので、再同期のたびに既定文で上書きすると、LHの画面で人が直した
  // 紹介文が消える。既定文のまま古くなるより、人が直した内容が消えるほうが
  // 害が大きいため、編集済みの内容を優先する。
  // https://github.com/kentavndng/line-harness-board/issues/711
  await c.env.DB.prepare(
    `INSERT INTO nen_columns
      (id, external_id, slug, title, category, excerpt, intro_text, article_url, image_url, published_at, delivery_status, line_account_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)
     ON CONFLICT(slug) DO UPDATE SET external_id = excluded.external_id, title = excluded.title,
       category = excluded.category, excerpt = excluded.excerpt, article_url = excluded.article_url,
       image_url = excluded.image_url, published_at = excluded.published_at,
       line_account_id = COALESCE(excluded.line_account_id, nen_columns.line_account_id), updated_at = excluded.updated_at`,
  ).bind(
    id, typeof body.external_id === 'string' ? body.external_id : body.slug, body.slug, fields.title,
    fields.category, fields.excerpt, fields.introText, fields.articleUrl, fields.imageUrl,
    fields.publishedAt, lineAccountId, now, now,
  ).run();
  return c.json({ success: true, data: { id } });
});

/**
 * EC-CUBE が注文確定時に呼ぶ「誕生日クーポンが使われた」の記録口。
 * 管理認証ではなく `/columns` と同じ HMAC で検証する。
 *
 * EC側のクーポン利用台帳とこちらの発行台帳は別物なので、ここが唯一の
 * `used_at` 書き込み口になる。同じコードの再送で利用日時を上書きしない
 * （冪等）。利用=注文なので成果計測にもつなげるが、計測の失敗で
 * 記録自体は止めない。
 */
nenCampaigns.post('/api/integrations/eccube/coupon-usages', inputJsonBoundary(), async (c) => {
  const secret = c.env.ECCUBE_WEBHOOK_SECRET;
  if (!secret || secret.length < 32) return c.json({ success: false, error: 'Integration is not configured' }, 503);
  const raw = await c.req.text();
  if (isWebhookBodyTooLarge(raw, MAX_BODY_BYTES)) return c.json({ success: false, error: 'Payload too large' }, 413);
  const valid = await verifyEccubeSignature(
    secret, c.req.header('x-nen-timestamp') || '', c.req.header('x-nen-signature') || '', raw,
  );
  if (!valid) return c.json({ success: false, error: 'Invalid signature' }, 401);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return inputError(c, { success: false, error: 'Invalid JSON' }, 400, []);
  }
  const code = typeof body.code === 'string' ? body.code.trim().slice(0, 64) : '';
  const usedAt = body.used_at === undefined || body.used_at === null || body.used_at === ''
    ? null
    : typeof body.used_at === 'string' && Number.isFinite(Date.parse(body.used_at))
      // issued_at と同じく日本時間の壁時計で残す（台帳の日付列をそろえる）。
      ? japanCalendar(new Date(Date.parse(body.used_at))).toISOString().slice(0, 19).replace('T', ' ')
      : 'invalid';
  const orderNumber = typeof body.order_number === 'string' && body.order_number.trim()
    ? body.order_number.trim().slice(0, 64) : null;
  const eventId = typeof body.event_id === 'string' && body.event_id.trim()
    ? body.event_id.trim().slice(0, 255) : null;
  if (!code || usedAt === 'invalid') {
    return inputError(c, { success: false, error: 'Invalid coupon usage' }, 400, ["code","used_at"]);
  }
  const when = usedAt ?? jstNow();
  // 二重報告で最初の利用日時を上書きしない（used_at IS NULL の行だけ更新）。
  const updated = await c.env.DB.prepare(
    `UPDATE nen_coupon_issues SET used_at = ? WHERE coupon_code = ? AND used_at IS NULL`,
  ).bind(when, code).run();
  if (!updated.meta.changes) {
    const known = await c.env.DB.prepare(
      `SELECT id FROM nen_coupon_issues WHERE coupon_code = ?`,
    ).bind(code).first<{ id: string }>();
    // こちらが発行していないコードは拾わない。再送は成功として返して送り止める。
    if (!known) return fail(c, 404, 'COUPON_NOT_FOUND');
    return c.json({ success: true, data: { couponCode: code, alreadyUsed: true } });
  }
  const issue = await c.env.DB.prepare(
    `SELECT ci.friend_id, f.line_account_id
       FROM nen_coupon_issues ci JOIN friends f ON f.id = ci.friend_id
      WHERE ci.coupon_code = ?`,
  ).bind(code).first<{ friend_id: string; line_account_id: string | null }>();
  if (issue) {
    try {
      await recordConversionSourceEvent(c.env.DB, {
        sourceType: 'ec_order_confirmed',
        lineAccountId: issue.line_account_id,
        friendId: issue.friend_id,
        sourceEventId: eventId ?? `nen_coupon_use:${code}`,
        metadata: { couponCode: code, orderNumber },
      });
    } catch (conversionError) {
      logger.error("nen_campaigns.record_coupon_conversion_failed");
    }
  }
  return c.json({ success: true, data: { couponCode: code, usedAt: when } });
});

export { nenCampaigns };
