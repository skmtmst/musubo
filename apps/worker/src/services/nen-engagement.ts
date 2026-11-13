import { formatYen, jstCalendar as japanCalendar } from '@line-crm/shared';
import { DELIVERY_CONSENT_ALLOWED_SQL } from '@line-crm/db/src/friend-delivery-consents.js';
import { logger } from '@line-crm/shared/server';
import { currentOrderState, orderNumberFromPayload } from './nen-order-state.js';
import { EXTERNAL_DELIVERY_MAX_ATTEMPTS as MAX_DELIVERY_ATTEMPTS } from './external-delivery-retry.js';
import {
  accountFeatureOffExclusionSql,
  activeTenantLineAccountSql,
  getFriendById,
  getLineAccountById,
  isOperationCapabilityStopped,
  jstNow,
  nextVersionToken,
} from '@line-crm/db';
import { stoppedTenantLineAccountSql } from './tenant-runtime-status.js';
import { NEN_CAMPAIGN_BODY_MAX_LENGTH, effectiveAnniversaryMonthDay, type LeapYearPolicy } from '@line-crm/shared';

import type { Message } from '@line-crm/line-sdk';
import type { EcEvent } from '../features/ec-commerce/member-snapshot/index.js';
import { createFeatureJobGate, featureJobCanRun } from './feature-enforcement.js';
import { createEccubeCoupon } from './eccube-coupon.js';
import { pushViaHarnessProxy, type HarnessProxyDispatch } from './line-proxy-send.js';

const FOLLOW_UP_KEYS = ['arrival_check', 'review_request', 'cross_sell'] as const;
// 1 回の cron 実行で送る件数。cron は 5 分ごとなので、
// **ここが 1 時間に送れる件数の上限になる（30 × 12 = 360 件/時、8,640 件/日）。**
// 誕生日クーポンのように 1 日ぶんがまとめて積まれるものは、
// これを超えた分が翌日以降にずれ込む。増やすときは、この実行が
// 他の cron 処理（ウェビナーのリマインダなど）と同じ 1 回の中で動くことに注意する。
const MAX_JOBS_PER_TICK = 30;
// 送信に失敗した job を何回まで試すか。これを超えた job は拾われなくなり、
// status='failed' のまま残る（last_error に理由が入る）。
const DELIVERY_LEASE_MS = 5 * 60_000;
const RETRY_DELAYS_MS = [60_000, 300_000, 1_800_000];
// 要件 -21 §8: 1アカウントが1回の実行で送る上限。一斉配信の batch と同じく、
// 1つのアカウントが上限ぶん先頭を占めて他のアカウントを止めないようにする。
const MAX_JOBS_PER_ACCOUNT_PER_TICK = 10;
// 要件 -21 §5・§8: 深夜に送らない時間帯（JST）。この時間帯の予約は claim せず
// 朝8時前は pending のまま残し、送信可能な時刻の tick で送る。
export const NEN_QUIET_HOURS_START_JST = 21;
export const NEN_QUIET_HOURS_END_JST = 8;

function nenJstHour(now: Date): number {
  const hour = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Tokyo', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).find((item) => item.type === 'hour')?.value;
  return Number(hour ?? 0);
}

/** 深夜帯（21:00〜翌8:00 JST）なら真。 */
export function isNenQuietHours(now: Date = new Date()): boolean {
  const hour = nenJstHour(now);
  return hour >= NEN_QUIET_HOURS_START_JST || hour < NEN_QUIET_HOURS_END_JST;
}

/** 深夜帯の終わり（その日か翌日の朝8時 JST）を ISO で返す。 */
export function nenQuietHoursResumeAt(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const get = (type: string) => Number(parts.find((item) => item.type === type)?.value ?? 0);
  // 実行環境の時刻帯に左右されないよう、JST日付のままUTC日付として1日進める。
  const base = new Date(Date.UTC(
    get('year'), get('month') - 1, get('day') + (nenJstHour(now) >= NEN_QUIET_HOURS_START_JST ? 1 : 0),
  ));
  const day = base.toISOString().slice(0, 10);
  return `${day}T08:00:00+09:00`;
}
// コラム配信予約の1回のまとめ書き件数。D1 の batch は文が多すぎると
// 1 回の呼び出しが重くなるため、100件ずつに区切る。
const COLUMN_QUEUE_BATCH_SIZE = 100;

export type CampaignRow = {
  campaign_key: string;
  label: string;
  category: string;
  trigger_event?: string | null;
  delay_days: number;
  delivery_time: string;
  is_enabled: number;
  title: string;
  body_text: string;
  button_label: string | null;
  button_url: string | null;
  image_url: string | null;
  /** 0は抑止なし、それ以外は同じキャンペーンを指定日数以内に予約しない。 */
  dedup_window_days?: number;
  /** open_form が設定されている場合、既に回答した友だちは除く。 */
  exclude_form_respondents?: number;
  after_actions?: NenCampaignAfterAction[];
  /*
   * 保存済みJSONに open_form があったが必須項目欠落で parse に落ちた=1。
   * 「回答フォームを開く」つもりなのにフォーム未選択の旧設定を検出するための
   * 手掛かりで、送信内容の組み立てには使わない。
   */
  form_action_dropped?: number;
  updated_at?: string;
};

export type NenCampaignAfterAction =
  | { kind: 'open_form'; formId: string; formName: string; buttonLabel: string }
  | { kind: 'award_mileage'; amount: number; trigger: 'form_submitted' };

export function parseNenCampaignAfterActions(value: unknown): NenCampaignAfterAction[] {
  if (!Array.isArray(value) || value.length > 10) return [];
  return value.flatMap<NenCampaignAfterAction>((item) => {
    if (!item || typeof item !== 'object') return [];
    const action = item as Record<string, unknown>;
    if (
      action.kind === 'open_form'
      && typeof action.formId === 'string'
      && action.formId.trim().length > 0
      && action.formId.length <= 100
      && typeof action.formName === 'string'
      && action.formName.trim().length > 0
      && action.formName.length <= 120
      && typeof action.buttonLabel === 'string'
      && action.buttonLabel.trim().length > 0
      && action.buttonLabel.length <= 20
    ) {
      return [{
        kind: 'open_form',
        formId: action.formId.trim(),
        formName: action.formName.trim(),
        buttonLabel: action.buttonLabel.trim(),
      }];
    }
    const amount = Number(action.amount);
    if (
      action.kind === 'award_mileage'
      && action.trigger === 'form_submitted'
      && Number.isInteger(amount)
      && amount >= 1
      && amount <= 1_000_000
    ) {
      return [{ kind: 'award_mileage', amount, trigger: 'form_submitted' }];
    }
    return [];
  });
}

export type NenBirthdayCouponSettingRow = {
  is_enabled: number;
  code_prefix: string;
  benefit_label: string;
  discount_amount: number;
  validity_days: number;
  /** 2月29日生まれの平年の扱い。未保存の設定は、選ばれていない配信を増やさないよう skip とする。 */
  leap_year_policy?: LeapYearPolicy;
  updated_at: string;
};

const campaignAccountSettingKey = (campaignKey: string) => `nen.campaign.${campaignKey}`;
const BIRTHDAY_COUPON_ACCOUNT_SETTING_KEY = 'nen.birthday_coupon';

async function readAccountSetting(db: D1Database, lineAccountId: string, key: string): Promise<string | null> {
  const row = await db.prepare(
    `SELECT value FROM account_settings WHERE line_account_id = ? AND key = ?`,
  ).bind(lineAccountId, key).first<{ value: string }>();
  return row?.value ?? null;
}

async function writeAccountSetting(db: D1Database, lineAccountId: string, key: string, value: string): Promise<void> {
  const now = jstNow();
  await db.prepare(
    `INSERT INTO account_settings (id, line_account_id, key, value, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(line_account_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).bind(crypto.randomUUID(), lineAccountId, key, value, now, now).run();
}

type DeliveryJob = {
  attempts?: number;
  id: string;
  campaign_key: string;
  friend_id: string;
  line_account_id: string | null;
  source_key: string;
  payload: string;
  campaign_snapshot: string | null;
  scheduled_at: string;
  retry_generation?: number;
};

export type NenDeliveryOptions = {
  proxyBaseUrl: string;
  defaultAccessToken: string;
  proxyDispatch?: HarnessProxyDispatch;
  /** 判定時刻。渡さないときは現在時刻。試験で昼夜を固定するためにある。 */
  now?: Date;
  /** 1回の実行で送る上限。渡さないときは MAX_JOBS_PER_TICK。 */
  maxJobsPerTick?: number;
  /** 1アカウントが1回の実行で送る上限。渡さないときは MAX_JOBS_PER_ACCOUNT_PER_TICK。 */
  maxJobsPerAccountPerTick?: number;
};

function sqliteDate(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function scheduledAfter(occurredAt: string, days: number, deliveryTime: string): string {
  const base = new Date(occurredAt);
  const jst = japanCalendar(base);
  const [hour, minute] = deliveryTime.split(':').map(Number);
  jst.setUTCDate(jst.getUTCDate() + days);
  jst.setUTCHours(Number.isFinite(hour) ? hour : 10, Number.isFinite(minute) ? minute : 0, 0, 0);
  return sqliteDate(new Date(jst.getTime() - 9 * 60 * 60 * 1000));
}

function orderSummary(event: EcEvent): string {
  const lines = (event.order?.items ?? []).slice(0, 4).map((item) => `${item.name} × ${item.quantity}`);
  if ((event.order?.items?.length ?? 0) > 4) lines.push(`ほか${(event.order?.items?.length ?? 0) - 4}点`);
  return lines.join('\n');
}

function renderCampaignCopy(value: string, payload: Record<string, unknown>): string {
  const pet = payload.pet as Record<string, unknown> | undefined;
  const coupon = payload.coupon as Record<string, unknown> | undefined;
  return value
    .replaceAll('{{pet_name}}', String(pet?.name || '大切なご家族'))
    .replaceAll('{{coupon_code}}', String(coupon?.code || ''))
    .replaceAll('{{coupon_expiry}}', String(coupon?.expires_at || '').slice(0, 10));
}

/**
 * 送信直前の多重防御としての切り詰め。保存時の上限判定が効いて
 * いれば、ここで実際に切ることは起きないはず。**発動したのなら、保存時の
 * 検査をすり抜けたか、既存データが旧仕様のまま残っているなど、どこかに
 * 不具合があるということ。** 黙って切ると、利用者が保存できた本文が
 * 送信時に無言で短くなり、誰も気づけない。`nen_delivery_failed` と同じ
 * 構造化ログの形で必ず記録する（`.catch` で握り潰さない）。
 */
function truncateForSend(value: string, maxLength: number, context: { campaignKey: string; field: string }): string {
  if (value.length <= maxLength) return value;
  logger.error("nen_body_truncated_at_send");
  return value.slice(0, maxLength);
}

function campaignSnapshot(campaign: CampaignRow): string {
  return JSON.stringify(campaign);
}

function campaignResponseFormId(campaign: CampaignRow): string | null {
  return campaign.after_actions?.find(
    (action): action is Extract<NenCampaignAfterAction, { kind: 'open_form' }> => action.kind === 'open_form',
  )?.formId ?? null;
}

/*
 * 「回答フォームを開く」配信は、つなぐフォームが使える状態に
 * あるかを保存・稼働開始・job生成の各入口で確かめる。フォームが消えた・公開を
 * 止めた・別アカウント専用になった既存の稼働中設定は「設定不足」として扱い、
 * 新しい送信jobを積まずに理由を配信履歴へ残す。
 */
export type NenCampaignFormIssue = 'form_unselected' | 'form_missing' | 'form_inactive' | 'form_other_account';

export const NEN_CAMPAIGN_FORM_ISSUE_LABELS: Record<NenCampaignFormIssue, string> = {
  form_unselected: 'つなぐ回答フォームが選ばれていません',
  form_missing: 'つなぐ回答フォームが見つかりません（削除された可能性があります）',
  form_inactive: 'つなぐ回答フォームは公開されていません',
  form_other_account: 'つなぐ回答フォームは別のLINEアカウント専用です',
};

/*
 * ボタンのURLがフォームを指しているか。LIFFの公開形 `?page=form&id=` のときだけ
 * id を取り出す。押されたあとの設定を外したあとにURLだけ残る形がありうるため、
 * 設定不足の判定はアクションとURLの両方を見る。
 */
export function campaignButtonFormId(campaign: CampaignRow): string | null {
  const url = campaign.button_url;
  if (!url || !url.includes('page=form')) return null;
  const match = /[?&]id=([^&#]+)/.exec(url);
  // `page=form` で id が取れない=「開くつもりなのに未選択」と同じ扱い。
  // 空文字を返して照合に落ちるようにし、form_missing として検出する。
  if (!match) return '';
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

export async function nenCampaignFormIssue(
  db: D1Database,
  campaign: CampaignRow,
  lineAccountId: string,
): Promise<NenCampaignFormIssue | null> {
  /*
   * 「フォームに関わるつもり」を示す手掛かりは4つ:
   *   押されたあとの設定(open_form)・ボタンのURL(page=form)・
   *   parseに落ちた旧open_form・口コミ回答者の除外ON。
   * どれかがあって指す先のフォームが使えないなら設定不足とする。
   * 除外ONだけ残った状態も、選んだはずの除外が黙って効かない
   * 設定不足なので同じ扱いにする。
   */
  const actionFormId = campaignResponseFormId(campaign);
  const buttonFormId = campaignButtonFormId(campaign);
  const intendsForm = actionFormId !== null
    || buttonFormId !== null
    || campaign.form_action_dropped === 1
    || campaign.exclude_form_respondents === 1;
  if (!intendsForm) return null;
  for (const formId of new Set(
    [actionFormId, buttonFormId].filter((id): id is string => id !== null),
  )) {
    if (formId === '') return 'form_unselected';
    const issue = await formIssueForId(db, formId, lineAccountId);
    if (issue) return issue;
  }
  if (actionFormId === null) return 'form_unselected';
  return null;
}

async function formIssueForId(
  db: D1Database,
  formId: string,
  lineAccountId: string,
): Promise<NenCampaignFormIssue | null> {
  const form = await db.prepare(
    `SELECT is_active, status FROM forms WHERE id = ?`,
  ).bind(formId).first<{ is_active: number; status: string | null }>();
  if (!form || form.status === 'archived') return 'form_missing';
  if (form.is_active !== 1) return 'form_inactive';
  // 割当のあるフォームはそのアカウント専用。未割当(どのアカウントにも
  // 属さない)のフォームは従来どおりどのアカウントからも使える。
  const assigned = await db.prepare(
    `SELECT line_account_id FROM form_accounts WHERE form_id = ?`,
  ).bind(formId).all<{ line_account_id: string }>();
  if (assigned.results.length > 0
      && !assigned.results.some((row) => row.line_account_id === lineAccountId)) {
    return 'form_other_account';
  }
  return null;
}

async function alreadyRespondedToCampaignForm(
  db: D1Database,
  campaign: CampaignRow,
  friendId: string,
): Promise<boolean> {
  if (campaign.exclude_form_respondents !== 1) return false;
  const formId = campaignResponseFormId(campaign);
  if (!formId) return false;
  const response = await db.prepare(
    `SELECT 1 AS found FROM form_submissions WHERE form_id = ? AND friend_id = ? LIMIT 1`,
  ).bind(formId, friendId).first<{ found: number }>();
  return response?.found === 1;
}

/*
 *  案2: 送信直前の窓の見直し。積む側の抑止は残したまま、claim 後に
 * 最新のアカウント別設定を正として代表1件だけを送る。
 * 代表は同一 campaign_key・friend_id の窓内 job を (scheduled_at, id) の
 * 昇順で並べた先頭。自分より先の pending/processing/sent/failed が1件でも
 * あれば後続は送らない。同時 tick で両方 send/両方 skip にならないよう、
 * 自分自身は比較対象から除く。窓の測り方（scheduled_at の近さ・日単位）は
 * 積む側の INSERT 抑止と同じにする。
 */
export async function hasEarlierWindowDelivery(
  db: D1Database,
  input: {
    campaignKey: string;
    friendId: string;
    jobId: string;
    scheduledAt: string;
    windowDays: number;
  },
): Promise<boolean> {
  if (!Number.isInteger(input.windowDays) || input.windowDays <= 0) return false;
  const earlier = await db.prepare(
    `SELECT 1 AS found FROM nen_delivery_jobs other
      WHERE other.campaign_key = ?
        AND other.friend_id = ?
        AND other.id != ?
        AND other.status IN ('pending', 'processing', 'sent', 'failed')
        AND ABS(julianday(other.scheduled_at) - julianday(?)) < ?
        AND (other.scheduled_at < ? OR (other.scheduled_at = ? AND other.id < ?))
      LIMIT 1`,
  ).bind(
    input.campaignKey, input.friendId, input.jobId,
    input.scheduledAt, input.windowDays,
    input.scheduledAt, input.scheduledAt, input.jobId,
  ).first<{ found: number }>();
  return earlier?.found === 1;
}

/**
 * 注文の取り消し・返金が届いたとき、その注文を起点に待っている
 * 発送後の案内を「送らない」へ倒す。送信時の再検証（processNenDeliveries）の
 * 手前で一覧からも外し、「これから送ります」と表示したまま不適切な案内を
 * 残さない。既に送った記録や他の注文の予約は触らない。
 *
 * payload が壊れた行を SQL が落とさないよう `json_valid` で守る。
 */
export async function cancelPendingOrderFollowUps(
  db: D1Database,
  input: { lineAccountId: string; orderNumber: string; reason: 'order_cancelled' | 'order_refunded' },
): Promise<number> {
  const orderNumber = input.orderNumber.trim();
  if (!orderNumber) return 0;
  const result = await db.prepare(
    `UPDATE nen_delivery_jobs
        SET status = 'skipped', last_error = ?, updated_at = ?
      WHERE status = 'pending'
        AND line_account_id = ?
        AND json_valid(payload)
        AND json_extract(payload, '$.event.order.number') = ?`,
  ).bind(input.reason, jstNow(), input.lineAccountId, orderNumber).run();
  return result.meta.changes ?? 0;
}

export function readNenCampaignSnapshot(value: string | null, campaignKey: string): CampaignRow | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<CampaignRow>;
    const delayDays = Number(parsed.delay_days);
    const enabled = Number(parsed.is_enabled);
    const dedupWindowDays = parsed.dedup_window_days === undefined
      ? 30
      : Number(parsed.dedup_window_days);
    const excludeFormRespondents = parsed.exclude_form_respondents === undefined
      ? (campaignKey === 'review_request' ? 1 : 0)
      : Number(parsed.exclude_form_respondents);
    if (
      parsed.campaign_key !== campaignKey
      || typeof parsed.title !== 'string'
      || typeof parsed.body_text !== 'string'
      || typeof parsed.label !== 'string'
      || typeof parsed.category !== 'string'
      || !Number.isInteger(delayDays)
      || delayDays < 0
      || delayDays > 365
      || typeof parsed.delivery_time !== 'string'
      || !/^([01]\d|2[0-3]):[0-5]\d$/.test(parsed.delivery_time)
      || ![0, 1].includes(enabled)
      || !Number.isInteger(dedupWindowDays)
      || dedupWindowDays < 0
      || dedupWindowDays > 365
      || ![0, 1].includes(excludeFormRespondents)
    ) return null;
    const afterActions = parseNenCampaignAfterActions(parsed.after_actions);
    return {
      campaign_key: parsed.campaign_key,
      label: parsed.label,
      category: parsed.category,
      trigger_event: typeof parsed.trigger_event === 'string' ? parsed.trigger_event : null,
      delay_days: delayDays,
      delivery_time: parsed.delivery_time,
      is_enabled: enabled,
      title: parsed.title,
      body_text: parsed.body_text,
      button_label: typeof parsed.button_label === 'string' ? parsed.button_label : null,
      button_url: typeof parsed.button_url === 'string' ? parsed.button_url : null,
      image_url: typeof parsed.image_url === 'string' ? parsed.image_url : null,
      dedup_window_days: dedupWindowDays,
      exclude_form_respondents: excludeFormRespondents,
      after_actions: afterActions,
      /*
       * 「回答フォームを開く」が保存JSONにはあるのに必須項目欠落で parse に
       * 落ちた=旧仕様の未選択設定。黙って捨てると設定不足が検出できないので
       * 手掛かりだけ残す。
       */
      form_action_dropped: (
        Array.isArray(parsed.after_actions)
        && parsed.after_actions.some(
          (item) => item !== null
            && typeof item === 'object'
            && (item as Record<string, unknown>).kind === 'open_form',
        )
        && !afterActions.some((action) => action.kind === 'open_form')
      ) ? 1 : 0,
      updated_at: typeof parsed.updated_at === 'string' ? parsed.updated_at : '',
    };
  } catch {
    return null;
  }
}

/*
 * 1500 の根拠は確認できていない。運用条件が変わる場合は数値の妥当性を再確認する。
 */
const NEN_COLUMN_INTRO_MAX_LENGTH = 1500;

/**
 * 保存時の多重防御としての切り詰め。入口（EC-Cube Webhookのtitle ≤120字、
 * 管理画面のtitle ≤120字・excerpt ≤500字）が効いていれば、固定文言を足しても
 * ここで実際に切ることは起きないはず。**発動したのなら、入口の検査をすり
 * 抜けたか、固定文言が伸びたなど、どこかに不具合があるということ。** 黙って
 * 切ると、紹介文の結びが途中で消えたことに誰も気づけない。`truncateForSend`
 * と同じ考え方で、切ったときだけ記録する。
 */
function truncateColumnIntro(value: string, maxLength: number, context: { title: string }): string {
  if (value.length <= maxLength) return value;
  logger.error("nen_column_intro_truncated");
  return value.slice(0, maxLength);
}

export function buildDefaultColumnIntro(title: string, excerpt: string): string {
  const summary = excerpt.trim();
  const text = [
    'こんにちは、然-NEN-です🌿',
    '',
    `今回のNENコラムでは「${title.trim()}」についてご紹介します。`,
    summary,
    '',
    '愛犬・愛猫との毎日に役立つ内容です。ぜひご覧ください。',
  ].filter((line, index, lines) => line || (index > 0 && lines[index - 1])).join('\n');
  return truncateColumnIntro(text, NEN_COLUMN_INTRO_MAX_LENGTH, { title });
}

function flexMessage(campaign: CampaignRow, payload: Record<string, unknown>): Message {
  const article = payload.article as Record<string, unknown> | undefined;
  const coupon = payload.coupon as Record<string, unknown> | undefined;
  const event = payload.event as EcEvent | undefined;
  const heroUrl = String(article?.image_url || campaign.image_url || '');
  const destination = String(article?.article_url
    || (event?.event_type === 'ec.order.shipped' ? event.shipping?.tracking_url : event?.order?.detail_url)
    || campaign.button_url || '');
  const title = renderCampaignCopy(String(article?.title || campaign.title), payload);
  // 保存時は差し込み前の本文だけを見ており、差し込み
  // 値（ペットの名前など）でここまで膨らみうる。保存時の検査だけに頼らず、
  // 実際にLINEへ送る直前でも同じ採用上限で切る（多重防御）。UTF-16 code
  // unit単位で、保存時の数え方と揃っている。発動したら記録する
  // （`truncateForSend` を参照）。
  const body = truncateForSend(
    renderCampaignCopy(String(article?.excerpt || campaign.body_text), payload),
    NEN_CAMPAIGN_BODY_MAX_LENGTH,
    { campaignKey: campaign.campaign_key, field: 'body' },
  );
  const details: Array<{ type: 'text'; text: string; size: 'sm'; color: string; wrap: true }> = [];
  if (event?.order?.number) details.push({ type: 'text', text: `注文番号：${event.order.number}`, size: 'sm', color: '#64748B', wrap: true });
  const items = event ? orderSummary(event) : '';
  if (items) details.push({ type: 'text', text: items, size: 'sm', color: '#64748B', wrap: true });
  if (typeof event?.order?.total === 'number') {
    details.push({ type: 'text', text: `合計：${formatYen(event.order.total)}`, size: 'sm', color: '#64748B', wrap: true });
  }
  if (event?.order?.delivery_date) {
    details.push({
      type: 'text',
      text: `お届け予定：${event.order.delivery_date}${event.order.delivery_time ? ` ${event.order.delivery_time}` : ''}`,
      size: 'sm', color: '#64748B', wrap: true,
    });
  }
  if (event?.shipping?.carrier) details.push({ type: 'text', text: `配送会社：${event.shipping.carrier}`, size: 'sm', color: '#64748B', wrap: true });
  if (event?.shipping?.tracking_number) details.push({ type: 'text', text: `送り状番号：${event.shipping.tracking_number}`, size: 'sm', color: '#64748B', wrap: true });
  if (coupon?.code) details.push({ type: 'text', text: `クーポンコード：${String(coupon.code)}`, size: 'sm', color: '#0F766E', wrap: true });
  if (coupon?.expires_at) details.push({ type: 'text', text: `有効期限：${String(coupon.expires_at).slice(0, 10)}`, size: 'sm', color: '#64748B', wrap: true });

  const bubble: Record<string, unknown> = {
    type: 'bubble',
    ...(heroUrl ? {
      hero: {
        type: 'image', url: heroUrl, size: 'full', aspectRatio: '3:2', aspectMode: 'cover',
        ...(destination ? { action: { type: 'uri', uri: destination } } : {}),
      },
    } : {}),
    body: {
      type: 'box', layout: 'vertical', spacing: 'md',
      contents: [
        { type: 'text', text: title, weight: 'bold', size: 'lg', color: '#123F2B', wrap: true },
        { type: 'text', text: body, size: 'sm', color: '#475569', wrap: true },
        ...details,
      ],
    },
    ...(destination && campaign.button_label ? {
      footer: {
        type: 'box', layout: 'vertical',
        contents: [{
          type: 'button', style: 'primary', color: '#0F766E',
          action: { type: 'uri', label: campaign.button_label.slice(0, 20), uri: destination },
        }],
      },
    } : {}),
  };
  return { type: 'flex', altText: title.slice(0, 400), contents: bubble } as Message;
}

export function buildNenDeliveryMessages(campaign: CampaignRow, payload: Record<string, unknown>): Message[] {
  const card = flexMessage(campaign, payload);
  if (campaign.campaign_key !== 'column') return [card];
  const article = payload.article as Record<string, unknown> | undefined;
  const title = String(article?.title || campaign.title);
  const excerpt = String(article?.excerpt || campaign.body_text);
  const intro = String(article?.intro_text || '').trim() || buildDefaultColumnIntro(title, excerpt);
  return [{ type: 'text', text: intro.slice(0, 5000) }, card];
}

export async function getNenCampaign(
  db: D1Database,
  campaignKey: string,
  lineAccountId?: string | null,
): Promise<CampaignRow | null> {
  const base = await db.prepare(
    `SELECT campaign_key, label, category, trigger_event, delay_days, delivery_time, is_enabled,
            title, body_text, button_label, button_url, image_url, updated_at
       FROM nen_campaign_settings WHERE campaign_key = ?`,
  ).bind(campaignKey).first<CampaignRow>();
  if (!base) return null;
  const normalizedBase: CampaignRow = {
    ...base,
    dedup_window_days: 30,
    exclude_form_respondents: campaignKey === 'review_request' ? 1 : 0,
  };
  if (!lineAccountId) return normalizedBase;
  const raw = await readAccountSetting(db, lineAccountId, campaignAccountSettingKey(campaignKey));
  if (!raw) return normalizedBase;
  // 壊れたアカウント別設定を共通値へ黙って戻すと、止めたはずの配信が再開する。
  // 設定が存在するのに読めない場合は null にして、送信側を停止させる。
  return readNenCampaignSnapshot(raw, campaignKey);
}

export async function saveNenCampaignAccountSetting(
  db: D1Database,
  lineAccountId: string,
  campaign: CampaignRow,
): Promise<void> {
  const key = campaignAccountSettingKey(campaign.campaign_key);
  for (let attempt = 0; attempt < 10; attempt++) {
    const previous = await readAccountSetting(db, lineAccountId, key);
    let previousVersion = campaign.updated_at;
    if (previous) {
      try { previousVersion = (JSON.parse(previous) as { updated_at?: string }).updated_at ?? previousVersion; } catch { /* use the base token */ }
    }
    const version = nextVersionToken(previousVersion);
    const value = JSON.stringify({ ...campaign, updated_at: version });
    const result = previous === null
      ? await db.prepare(`INSERT INTO account_settings (id, line_account_id, key, value, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(line_account_id, key) DO NOTHING`)
          .bind(crypto.randomUUID(), lineAccountId, key, value, version, version).run()
      : await db.prepare(`UPDATE account_settings SET value = ?, updated_at = ?
          WHERE line_account_id = ? AND key = ? AND value = ?`)
          .bind(value, version, lineAccountId, key, previous).run();
    if ((result.meta?.changes ?? 0) === 1) return;
  }
  throw new Error('campaign_setting_contention');
}

export async function getNenBirthdayCouponSetting(
  db: D1Database,
  lineAccountId?: string | null,
): Promise<NenBirthdayCouponSettingRow | null> {
  const base = await db.prepare(
    `SELECT is_enabled, code_prefix, benefit_label, discount_amount, validity_days, updated_at
       FROM nen_birthday_coupon_settings WHERE id = 'default'`,
  ).first<NenBirthdayCouponSettingRow>();
  if (!base || !lineAccountId) return base;
  const raw = await readAccountSetting(db, lineAccountId, BIRTHDAY_COUPON_ACCOUNT_SETTING_KEY);
  if (!raw) return base;
  try {
    const parsed = JSON.parse(raw) as Partial<NenBirthdayCouponSettingRow>;
    if (
      ![0, 1].includes(Number(parsed.is_enabled))
      || typeof parsed.code_prefix !== 'string'
      || parsed.code_prefix.trim().length === 0
      || typeof parsed.benefit_label !== 'string'
      || !Number.isInteger(parsed.discount_amount)
      || Number(parsed.discount_amount) < 0
      || !Number.isInteger(parsed.validity_days)
      || Number(parsed.validity_days) < 1
      || Number(parsed.validity_days) > 3650
    ) return null;
    const leapYearPolicy = parsed.leap_year_policy === 'feb28'
      || parsed.leap_year_policy === 'mar1'
      || parsed.leap_year_policy === 'skip'
      ? parsed.leap_year_policy
      : undefined;
    return {
      is_enabled: parsed.is_enabled!,
      code_prefix: parsed.code_prefix,
      benefit_label: parsed.benefit_label,
      discount_amount: parsed.discount_amount!,
      validity_days: parsed.validity_days!,
      leap_year_policy: leapYearPolicy,
      updated_at: typeof parsed.updated_at === 'string' ? parsed.updated_at : '',
    };
  } catch {
    // アカウント別設定が壊れているのに共通値で送ると、停止した配信が再開する。
    return null;
  }
}

export async function saveNenBirthdayCouponSetting(
  db: D1Database,
  lineAccountId: string,
  setting: NenBirthdayCouponSettingRow,
): Promise<void> {
  await writeAccountSetting(
    db,
    lineAccountId,
    BIRTHDAY_COUPON_ACCOUNT_SETTING_KEY,
    JSON.stringify({ ...setting, updated_at: jstNow() }),
  );
}

export async function buildNenImmediateMessage(
  db: D1Database,
  event: EcEvent,
): Promise<{ enabled: boolean; message: Message | null }> {
  const key = event.event_type === 'ec.order.confirmed'
    ? 'order_confirmed'
    : event.event_type === 'ec.order.shipped' ? 'shipping_confirmed' : null;
  if (!key) return { enabled: true, message: null };
  const campaign = await getNenCampaign(db, key);
  if (!campaign) return { enabled: true, message: null };
  return {
    enabled: campaign.is_enabled === 1,
    message: campaign.is_enabled === 1 ? flexMessage(campaign, { event }) : null,
  };
}

export async function enqueuePostShippingFollowUps(
  db: D1Database,
  event: EcEvent,
  friendId: string,
  lineAccountId: string | null,
): Promise<number> {
  if (event.event_type !== 'ec.order.shipped' || !lineAccountId) return 0;
  const campaigns = (await Promise.all(
    FOLLOW_UP_KEYS.map((key) => getNenCampaign(db, key, lineAccountId)),
  )).filter((campaign): campaign is CampaignRow => Boolean(campaign?.is_enabled === 1));
  const now = jstNow();
  let created = 0;
  for (const campaign of campaigns) {
    if (!FOLLOW_UP_KEYS.includes(campaign.campaign_key as typeof FOLLOW_UP_KEYS[number])) continue;
    const scheduledAt = scheduledAfter(
      event.shipping?.shipped_at || event.occurred_at,
      campaign.delay_days,
      campaign.delivery_time,
    );
    const formId = campaignResponseFormId(campaign);
    const dedupWindowDays = campaign.dedup_window_days ?? 30;
    const excludeFormRespondents = campaign.exclude_form_respondents ?? 0;
    /*
     * 稼働中でも「つなぐ回答フォーム」が使えない配信は新しい送信jobを
     * 積まない。本来予約されるはずだった分だけ「対象外」の記録を配信履歴へ
     * 残し、理由コードを last_error へ入れる(重複防止で積まれない分は従来
     * どおり記録もしない)。すでに予約済みの job はここでは触らない
     * (復旧の選び方は運用者が履歴から決める)。
     */
    if (await nenCampaignFormIssue(db, campaign, lineAccountId) !== null) {
      await db.prepare(
        `INSERT OR IGNORE INTO nen_delivery_jobs
          (id, campaign_key, friend_id, line_account_id, source_key, payload, campaign_snapshot,
           scheduled_at, status, attempts, last_error, created_at, updated_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'skipped', 0, 'campaign_form_unavailable', ?, ?
          WHERE (? = 0 OR NOT EXISTS (
            SELECT 1 FROM nen_delivery_jobs previous
             WHERE previous.line_account_id = ?
               AND previous.campaign_key = ?
               AND previous.friend_id = ?
               AND previous.status IN ('pending', 'processing', 'sent', 'failed')
               AND ABS(julianday(previous.scheduled_at) - julianday(?)) < ?
          ))`,
      ).bind(
        crypto.randomUUID(), campaign.campaign_key, friendId, lineAccountId,
        event.event_id, JSON.stringify({ event }), campaignSnapshot(campaign),
        scheduledAt, now, now,
        dedupWindowDays, lineAccountId, campaign.campaign_key, friendId, scheduledAt, dedupWindowDays,
      ).run();
      // 戻り値は「新しく予約した送信job」の件数だけを数える。
      continue;
    }
    const result = await db.prepare(
      `INSERT OR IGNORE INTO nen_delivery_jobs
        (id, campaign_key, friend_id, line_account_id, source_key, payload, campaign_snapshot,
         scheduled_at, status, attempts, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?
        WHERE (? = 0 OR NOT EXISTS (
          SELECT 1 FROM nen_delivery_jobs previous
           WHERE previous.line_account_id = ?
             AND previous.campaign_key = ?
             AND previous.friend_id = ?
             AND previous.status IN ('pending', 'processing', 'sent', 'failed')
             AND ABS(julianday(previous.scheduled_at) - julianday(?)) < ?
        ))
          AND (? = 0 OR ? IS NULL OR NOT EXISTS (
            SELECT 1 FROM form_submissions response
             WHERE response.form_id = ? AND response.friend_id = ?
          ))`,
    ).bind(
      crypto.randomUUID(), campaign.campaign_key, friendId, lineAccountId,
      event.event_id, JSON.stringify({ event }), campaignSnapshot(campaign),
      scheduledAt,
      now, now,
      dedupWindowDays, lineAccountId, campaign.campaign_key, friendId, scheduledAt, dedupWindowDays,
      excludeFormRespondents, formId, formId, friendId,
    ).run();
    created += result.meta.changes ?? 0;
  }
  return created;
}

export async function queueColumnDelivery(
  db: D1Database,
  columnId: string,
  lineAccountId: string,
  scheduledAt: string,
): Promise<number> {
  const column = await db.prepare(
    `SELECT id, title, excerpt, article_url, image_url, intro_text, target_mode, target_tag_id
       FROM nen_columns WHERE id = ? AND line_account_id = ?`,
  ).bind(columnId, lineAccountId).first<Record<string, unknown>>();
  if (!column) throw new Error('Column not found');
  const campaign = await getNenCampaign(db, 'column', lineAccountId);
  if (!campaign || campaign.is_enabled !== 1) throw new Error('Column campaign is disabled');
  const friends = await db.prepare(
    `SELECT f.id FROM friends f
      WHERE f.line_account_id = ? AND f.is_following = 1
        AND (? != 'tag' OR EXISTS (
          SELECT 1 FROM friend_tags ft WHERE ft.friend_id = f.id AND ft.tag_id = ?
        ))`,
  ).bind(lineAccountId, column.target_mode, column.target_tag_id).all<{ id: string }>();
  const now = jstNow();
  // 友だち1人ずつ順番に書き込むと千人規模で千回超の書き込みになる(点検  の中1)。
  // 100件ずつまとめて送る。INSERT OR IGNORE なので入り直しても重複しない。
  const articlePayload = JSON.stringify({ article: column });
  const snapshot = campaignSnapshot(campaign);
  const sourceKey = `column:${columnId}`;
  let queued = 0;
  for (let offset = 0; offset < friends.results.length; offset += COLUMN_QUEUE_BATCH_SIZE) {
    const chunk = friends.results.slice(offset, offset + COLUMN_QUEUE_BATCH_SIZE);
    const results = await db.batch(chunk.map((friend) => db.prepare(
      `INSERT OR IGNORE INTO nen_delivery_jobs
        (id, campaign_key, friend_id, line_account_id, source_key, payload, campaign_snapshot,
         scheduled_at, status, attempts, created_at, updated_at)
       VALUES (?, 'column', ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
    ).bind(
      crypto.randomUUID(), friend.id, lineAccountId, sourceKey,
      articlePayload, snapshot, scheduledAt, now, now,
    )));
    for (const result of results) queued += result.meta.changes ?? 0;
  }
  await db.prepare(
    `UPDATE nen_columns SET delivery_status = ?, delivery_at = ?, updated_at = ?
      WHERE id = ? AND line_account_id = ?`,
  ).bind(queued ? 'queued' : 'scheduled', scheduledAt, now, columnId, lineAccountId).run();
  return queued;
}

export function birthdayDeliveryTarget(now: Date): {
  issueYear: number;
  monthDay: string;
  deliveryAt: Date;
} {
  const jst = japanCalendar(now);
  const targetBirthday = new Date(Date.UTC(
    jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate() + 3,
  ));
  return {
    issueYear: targetBirthday.getUTCFullYear(),
    monthDay: `${String(targetBirthday.getUTCMonth() + 1).padStart(2, '0')}-${String(targetBirthday.getUTCDate()).padStart(2, '0')}`,
    deliveryAt: new Date(Date.UTC(
      jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate(), 1, 0, 0,
    )),
  };
}

export type NenCouponIssueFailure = {
  petId: string;
  friendId: string;
  lineAccountId: string | null;
  issueYear: number;
  couponCode: string;
  reason: string;
};

/**
 * ECに出すクーポンコードは pet×年 で決定的にする。再試行が同じコードを名乗るので、
 * EC側の「作成済み」（409）は成功と同じ意味で受け取れる。前回の走査で作成が
 * 届いたか分からなくても、次の走査が同じ行へ収束する（部分成功を誤って成功扱いしない）。
 */
async function deterministicCouponCode(secret: string, petId: string, issueYear: number, prefix: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${petId}:${issueYear}`));
  const suffix = Array.from(new Uint8Array(digest)).slice(0, 4).map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  return `${prefix}-${String(issueYear).slice(-2)}-${suffix}`;
}

/**
 * cron が 1日1回呼ぶ。対象ペットへ誕生日クーポンを1年に1枚発行し、
 * 送信jobを「3日前の朝10時」に予約する（同じ job キーなので再実行は冪等）。
 * EC側の作成に失敗した子はローカル発行行を残さず次の走査へ回し、他の子と
 * 通常のNEN配信処理を止めない（部分成功を全体失敗にしない）。
 */
export async function enqueueBirthdayCoupons(
  db: D1Database,
  now = new Date(),
  ecommerce?: { baseUrl: string; secret: string },
  onIssueFailed?: (failure: NenCouponIssueFailure) => Promise<void> | void,
): Promise<{ queued: number; failed: number }> {
  const { issueYear, monthDay, deliveryAt } = birthdayDeliveryTarget(now);
  // 誕生日は月日だけ（MM-DD）でもよいので、最後5桁で合わせる。
  const pets = await db.prepare(
    `SELECT p.id, p.friend_id, p.name, p.birthday, f.line_account_id
       FROM nen_pet_profiles p JOIN friends f ON f.id = p.friend_id
      WHERE p.archived_at IS NULL AND p.birthday IS NOT NULL AND substr(p.birthday, -5) IN (?, '02-29') AND f.is_following = 1`,
  ).bind(monthDay).all<{ id: string; friend_id: string; name: string; birthday: string; line_account_id: string | null }>();
  const issuedAt = jstNow();
  const accountConfiguration = new Map<string, {
    setting: NenBirthdayCouponSettingRow;
    campaign: CampaignRow;
  } | null>();
  let queued = 0;
  let failed = 0;
  const report = async (failure: NenCouponIssueFailure) => {
    logger.error("nen_engagement.issue_birthday_coupon_failed");
    try {
      await onIssueFailed?.(failure);
    } catch (notifyError) {
      logger.error("nen_engagement.report_failed");
    }
  };
  for (const pet of pets.results) {
    try {
      if (!pet.line_account_id) continue;
      // 機能オフ中は発行も予約もしない。再オン後の誕生日から再開する。
      if (!await featureJobCanRun(db, { accountId: pet.line_account_id, featureId: 'nen_campaigns', job: 'birthday coupon enqueue' })) {
        continue;
      }
      if (!accountConfiguration.has(pet.line_account_id)) {
        const [setting, campaign] = await Promise.all([
          getNenBirthdayCouponSetting(db, pet.line_account_id),
          getNenCampaign(db, 'birthday_coupon', pet.line_account_id),
        ]);
        accountConfiguration.set(
          pet.line_account_id,
          setting?.is_enabled === 1 && campaign?.is_enabled === 1 ? { setting, campaign } : null,
        );
      }
      const configuration = accountConfiguration.get(pet.line_account_id);
      if (!configuration) continue;
      const { setting, campaign } = configuration;
      // 2月29日生まれ: うるう年はそのまま2/29に当たる。平年はアカウントの
      // 方針（2/28・3/1・送らない）に従う。機能07リマインダと同じ共有規則（419）。
      const petMonthDay = pet.birthday.slice(-5);
      if (petMonthDay !== monthDay) {
        const effective = effectiveAnniversaryMonthDay(2, 29, issueYear, setting.leap_year_policy ?? 'skip');
        if (effective !== monthDay) continue;
      }
      const expires = new Date(deliveryAt.getTime() + setting.validity_days * 86_400_000);
      const code = ecommerce
        ? await deterministicCouponCode(ecommerce.secret, pet.id, issueYear, setting.code_prefix.replace(/-/g, '').slice(0, 8))
        : `${setting.code_prefix.replace(/-/g, '').slice(0, 8)}-${String(issueYear).slice(-2)}-${crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`;
      // 先に発行行を予約してから EC へ出す。EC が失敗したときに行だけ残ると
      // 使えないクーポンが「発行済み」に見えるので、失敗時は行を消して次回に回す。
      const issueId = crypto.randomUUID();
      const issue = await db.prepare(
        `INSERT OR IGNORE INTO nen_coupon_issues
          (id, pet_id, friend_id, issue_year, coupon_code, benefit_label, expires_at, issued_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(issueId, pet.id, pet.friend_id, issueYear, code, setting.benefit_label, sqliteDate(expires), issuedAt).run();
      if (!issue.meta.changes) {
        // 今年分のクーポンは発行済み。ここで終わるのが通常だが、予約jobだけが
        // 取消済み（誕生日の変更など）になっているときは、発行済みの同じクーポンを
        // 新しい日付へ予約し直す。UNIQUE衝突でこの分岐へ来る経路（job取消・
        // job行欠落）を問わずここで収束させる。
        const issued = await db.prepare(
          `SELECT coupon_code, expires_at FROM nen_coupon_issues WHERE pet_id = ? AND issue_year = ?`,
        ).bind(pet.id, issueYear).first<{ coupon_code: string; expires_at: string }>();
        if (issued) {
          const jobKey = `birthday:${pet.id}:${issueYear}`;
          const payload = JSON.stringify({
            pet: { id: pet.id, name: pet.name },
            coupon: { code: issued.coupon_code, expires_at: issued.expires_at, benefit_label: setting.benefit_label },
          });
          const snapshot = campaignSnapshot(campaign);
          const revived = await db.prepare(
            `UPDATE nen_delivery_jobs
             SET status = 'pending', attempts = 0, next_attempt_at = NULL, claim_token = NULL, scheduled_at = ?, payload = ?, campaign_snapshot = ?, updated_at = ?
             WHERE campaign_key = 'birthday_coupon' AND source_key = ? AND status = 'cancelled'`,
          ).bind(sqliteDate(deliveryAt), payload, snapshot, issuedAt, jobKey).run();
          if (revived.meta.changes) {
            queued++;
          } else {
            // job行自体が無い経路でも、発行済みクーポンの予約を立て直す。
            const requeued = await db.prepare(
              `INSERT OR IGNORE INTO nen_delivery_jobs
                (id, campaign_key, friend_id, line_account_id, source_key, payload, campaign_snapshot,
                 scheduled_at, status, attempts, created_at, updated_at)
               VALUES (?, 'birthday_coupon', ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
            ).bind(
              crypto.randomUUID(), pet.friend_id, pet.line_account_id, jobKey, payload, snapshot,
              sqliteDate(deliveryAt), issuedAt, issuedAt,
            ).run();
            if (requeued.meta.changes) queued++;
          }
        }
        continue;
      }
      if (ecommerce) {
        try {
          await createEccubeCoupon(ecommerce.baseUrl, ecommerce.secret, {
            code,
            name: `${pet.name} ${setting.benefit_label}`.slice(0, 50),
            discountAmount: setting.discount_amount,
            validFrom: deliveryAt.toISOString(),
            validTo: expires.toISOString(),
          });
        } catch (error) {
          // ECに届かなかった（届いたか分からない）ので発行をなかったことにして
          // 次回へ持ち越す。コードが決定的なため、重複作成（409）でも同じコードに収束する。
          await db.prepare(`DELETE FROM nen_coupon_issues WHERE id = ?`).bind(issueId).run();
          failed++;
          await report({
            petId: pet.id, friendId: pet.friend_id, lineAccountId: pet.line_account_id,
            issueYear, couponCode: code,
            reason: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
      }
      await db.prepare(
        `INSERT OR IGNORE INTO nen_delivery_jobs
          (id, campaign_key, friend_id, line_account_id, source_key, payload, campaign_snapshot,
           scheduled_at, status, attempts, created_at, updated_at)
         VALUES (?, 'birthday_coupon', ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
      ).bind(
        crypto.randomUUID(), pet.friend_id, pet.line_account_id, `birthday:${pet.id}:${issueYear}`,
        JSON.stringify({ pet: { id: pet.id, name: pet.name }, coupon: { code, expires_at: sqliteDate(expires), benefit_label: setting.benefit_label } }),
        campaignSnapshot(campaign), sqliteDate(deliveryAt), issuedAt, issuedAt,
      ).run();
      queued++;
    } catch (error) {
      // 1匹の失敗で残りの子と通常配信を止めない。行は残ったまま台帳に記録される。
      failed++;
      await report({
        petId: pet.id, friendId: pet.friend_id, lineAccountId: pet.line_account_id,
        issueYear, couponCode: '',
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { queued, failed };
}

export async function syncNenPetProfiles(
  db: D1Database,
  event: EcEvent,
  friendId: string,
): Promise<number> {
  const pets = event.profile?.pets ?? [];
  const now = jstNow();
  let synced = 0;
  for (const pet of pets.slice(0, 20)) {
    const name = pet.name?.trim();
    if (!name) continue;
    const externalId = pet.id == null ? null : `eccube:${pet.id}`;
    if (externalId) {
      await db.prepare(
        `INSERT INTO nen_pet_profiles
          (id, external_id, friend_id, customer_id, name, animal_type, gender, birthday, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(external_id) DO UPDATE SET friend_id = excluded.friend_id,
           customer_id = excluded.customer_id, name = excluded.name, animal_type = excluded.animal_type,
           gender = excluded.gender, birthday = excluded.birthday, updated_at = excluded.updated_at WHERE nen_pet_profiles.archived_at IS NULL`,
      ).bind(
        crypto.randomUUID(), externalId, friendId,
        event.customer_id == null ? null : String(event.customer_id), name,
        pet.animal_type || 'dog', pet.gender || 'unknown', pet.birthday || null, now, now,
      ).run();
    } else {
      await db.prepare(
        `INSERT INTO nen_pet_profiles
          (id, external_id, friend_id, customer_id, name, animal_type, gender, birthday, created_at, updated_at)
         VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        crypto.randomUUID(), friendId, event.customer_id == null ? null : String(event.customer_id),
        name, pet.animal_type || 'dog', pet.gender || 'unknown', pet.birthday || null, now, now,
      ).run();
    }
    synced++;
  }
  return synced;
}

export async function processNenDeliveries(
  db: D1Database,
  options: NenDeliveryOptions,
): Promise<{ sent: number; failed: number; skipped: number; deferred: number }> {
  const now = options.now ?? new Date();
  const maxJobsPerTick = options.maxJobsPerTick ?? MAX_JOBS_PER_TICK;
  const maxJobsPerAccountPerTick = options.maxJobsPerAccountPerTick ?? MAX_JOBS_PER_ACCOUNT_PER_TICK;
  // 中断後も同じプロキシの冪等キーを再利用する。
  await db.prepare(`UPDATE nen_delivery_jobs SET status='failed', next_attempt_at=?, updated_at=?
    WHERE status='processing' AND datetime(updated_at) <= datetime(?)`).bind(
      now.toISOString(), now.toISOString(), new Date(now.getTime() - DELIVERY_LEASE_MS).toISOString(),
    ).run();
  const dueWhere = `status IN ('pending', 'failed') AND attempts < ?
        AND datetime(scheduled_at) <= datetime(?)
        AND (next_attempt_at IS NULL OR datetime(next_attempt_at) <= datetime(?))`;
  await db.prepare(
    `UPDATE nen_delivery_jobs
        SET status='skipped', last_error='tenant_suspended', updated_at=?
      WHERE ${dueWhere}
        AND line_account_id IS NOT NULL
        AND ${stoppedTenantLineAccountSql('nen_delivery_jobs.line_account_id')}`,
  ).bind(jstNow(), MAX_DELIVERY_ATTEMPTS, now.toISOString(), now.toISOString()).run();
  const campaignsOff = accountFeatureOffExclusionSql('nen_delivery_jobs.line_account_id', 'nen_campaigns');
  // オフ判定は LIMIT を数える前に SQL で行う。読んでから弾くと、オフの行が
  // 上限ぶん先頭を占めたまま、後ろに並ぶ動作中アカウントの配信が進まない。
  const jobs = await db.prepare(
    `SELECT id, campaign_key, friend_id, line_account_id, source_key, payload, campaign_snapshot,
            scheduled_at, retry_generation, attempts
       FROM nen_delivery_jobs
      WHERE ${dueWhere}
        AND NOT ${campaignsOff}
        AND (line_account_id IS NULL OR ${activeTenantLineAccountSql('nen_delivery_jobs.line_account_id')})
      ORDER BY scheduled_at ASC LIMIT ?`,
  ).bind(MAX_DELIVERY_ATTEMPTS, now.toISOString(), now.toISOString(), maxJobsPerTick).all<DeliveryJob>();
  // 止めた行も同じ上限ぶんだけ読み、skipped に数えて監査を残す。
  // 読むだけで status も attempts も動かさない。
  const offJobs = await db.prepare(
    `SELECT line_account_id FROM nen_delivery_jobs
      WHERE ${dueWhere}
        AND line_account_id IS NOT NULL
        AND ${campaignsOff}
      ORDER BY scheduled_at ASC LIMIT ?`,
  ).bind(MAX_DELIVERY_ATTEMPTS, now.toISOString(), now.toISOString(), MAX_JOBS_PER_TICK).all<{ line_account_id: string }>();
  let sent = 0;
  let failed = 0;
  let skipped = 0;
  let deferred = 0;
  // 深夜帯は1件も送らない。claim せず pending のまま残し、朝の tick が送る。
  const quiet = isNenQuietHours(now);
  const perAccountSent = new Map<string, number>();
  const offGate = createFeatureJobGate();
  for (const off of offJobs.results) {
    await offGate.canRun(db, off.line_account_id, 'nen_campaigns', 'NEN campaign deliveries');
    skipped += 1;
  }
  for (const job of jobs.results) {
    if (quiet) {
      deferred += 1;
      continue;
    }
    // 1アカウントが上限ぶん先頭を占めないよう、超えた分は次回へ回す。
    // claim せず pending のまま残す。skipped には数えない（失敗ではない）。
    // 送れた分だけ数える（弾かれた分は枠を食わない）。
    if (job.line_account_id
        && (perAccountSent.get(job.line_account_id) ?? 0) >= maxJobsPerAccountPerTick) {
      deferred += 1;
      continue;
    }
    // 機能オフ中はclaimせずpendingのまま残す。再オンで再開する。
    if (job.line_account_id && !await featureJobCanRun(db, { accountId: job.line_account_id, featureId: 'nen_campaigns', job: 'NEN campaign deliveries' })) {
      skipped += 1;
      continue;
    }
    // 緊急停止 : broadcast_dispatch が止まっている統括は claim せず
    // pending のまま残す。復旧すれば次の tick が拾う。
    if (job.line_account_id &&
        await isOperationCapabilityStopped(db, job.line_account_id, 'broadcast_dispatch')) {
      continue;
    }
    const claimToken = crypto.randomUUID();
    const claim = await db.prepare(
      `UPDATE nen_delivery_jobs SET status = 'processing', attempts = attempts + 1, updated_at = ?, claim_token = ?
        WHERE id = ? AND status IN ('pending', 'failed') AND attempts = ?
          AND (next_attempt_at IS NULL OR datetime(next_attempt_at) <= datetime(?))`,
    ).bind(now.toISOString(), claimToken, job.id, Number(job.attempts ?? 0), now.toISOString()).run();
    if (!claim.meta.changes) continue;
    try {
      const [friend, currentCampaign, account] = await Promise.all([
        getFriendById(db, job.friend_id),
        getNenCampaign(db, job.campaign_key, job.line_account_id),
        job.line_account_id ? getLineAccountById(db, job.line_account_id) : Promise.resolve(null),
      ]);
      const campaign = readNenCampaignSnapshot(job.campaign_snapshot, job.campaign_key);
      const accountMismatch = Boolean(
        friend && job.line_account_id && friend.line_account_id !== job.line_account_id,
      );
      if (
        !friend || !friend.is_following || !job.line_account_id || !account?.channel_access_token || accountMismatch
        || !currentCampaign || currentCampaign.is_enabled !== 1 || !campaign
      ) {
        const reason = !friend || !friend.is_following
          ? 'friend_unavailable'
          : !job.line_account_id || !account?.channel_access_token
            ? 'line_account_unavailable'
            : accountMismatch
              ? 'line_account_mismatch'
              : !campaign
                ? 'campaign_snapshot_missing'
                : 'campaign_disabled';
        await db.prepare(
          `UPDATE nen_delivery_jobs SET status = 'skipped', last_error = ?, updated_at = ? WHERE id = ? AND claim_token = ?`,
        ).bind(reason, jstNow(), job.id, claimToken).run();
        skipped++;
        continue;
      }
      /*
       * 注文起点の案内は、送る直前に注文の現在状態を確かめる。
       * 発送をきっかけに予約された案内（到着確認・口コミ・次の商品）は、
       * あとから注文が取り消し・返金になっても payload の写しのまま残る。
       * EC台帳（ec_orders）の現在状態が取り消し・返金なら送らない。
       * 行が無い注文は「取り消しと確認できない」だけなので止めない。
       */
      const orderNumber = orderNumberFromPayload(job.payload);
      if (orderNumber) {
        const orderState = await currentOrderState(db, job.line_account_id, orderNumber);
        if (orderState === 'cancelled' || orderState === 'refunded') {
          await db.prepare(
            `UPDATE nen_delivery_jobs SET status = 'skipped', last_error = ?, updated_at = ? WHERE id = ? AND claim_token = ?`,
          ).bind(orderState === 'cancelled' ? 'order_cancelled' : 'order_refunded', jstNow(), job.id, claimToken).run();
          skipped++;
          continue;
        }
      }
      if (await alreadyRespondedToCampaignForm(db, campaign, friend.id)) {
        await db.prepare(
          `UPDATE nen_delivery_jobs SET status = 'skipped', last_error = ?, updated_at = ? WHERE id = ? AND claim_token = ?`,
        ).bind('campaign_form_already_submitted', jstNow(), job.id, claimToken).run();
        skipped++;
        continue;
      }
      //  案2: claim 後に最新のアカウント別設定を正として窓を見直す。
      // 0なら頻度抑止なし。代表より後なら新しい固定理由で skip し、監査に残す。
      const windowDays = currentCampaign.dedup_window_days ?? 30;
      if (await hasEarlierWindowDelivery(db, {
        campaignKey: job.campaign_key,
        friendId: job.friend_id,
        jobId: job.id,
        scheduledAt: job.scheduled_at,
        windowDays,
      })) {
        await db.prepare(
          `UPDATE nen_delivery_jobs SET status = 'skipped', last_error = ?, updated_at = ? WHERE id = ? AND claim_token = ?`,
        ).bind('frequency_suppressed', jstNow(), job.id, claimToken).run();
        skipped++;
        continue;
      }
      // claim と送信の間に緊急停止へ切り替わった分は、claim を pending へ
      // 差し戻す。停止を失敗として数えない (attempts を戻す)。
      if (job.line_account_id &&
          await isOperationCapabilityStopped(db, job.line_account_id, 'broadcast_dispatch')) {
        await db.prepare(
          `UPDATE nen_delivery_jobs SET status = 'pending', attempts = attempts - 1, updated_at = ?
            WHERE id = ? AND status = 'processing' AND claim_token = ?`,
        ).bind(jstNow(), job.id, claimToken).run();
        continue;
      }
      const accessToken = account.channel_access_token;
      const payload = JSON.parse(job.payload) as Record<string, unknown>;
      let recipientLineUserId = friend.line_user_id;
      if (typeof payload.expectedLineUserId === 'string') {
        const current = await db.prepare(`SELECT f.line_user_id,f.line_account_id,f.is_following,COALESCE(f.is_hidden,0) AS is_hidden,
          CASE WHEN (${DELIVERY_CONSENT_ALLOWED_SQL}) THEN 1 ELSE 0 END AS consent_allowed
          FROM friends f JOIN nen_delivery_jobs j ON j.friend_id=f.id
          WHERE j.id=? AND j.status='processing' AND j.claim_token=?`)
          .bind(job.id, claimToken).first<{ line_user_id: string; line_account_id: string | null; is_following: number; is_hidden: number; consent_allowed: number }>();
        if (!current || current.line_user_id !== payload.expectedLineUserId || current.line_account_id !== job.line_account_id || current.is_following !== 1 || current.is_hidden !== 0 || current.consent_allowed !== 1) {
          const reason = current && current.line_user_id !== payload.expectedLineUserId ? 'recipient_changed' : 'friend_unavailable';
          const changed = await db.prepare(`UPDATE nen_delivery_jobs SET status='skipped',last_error=?,updated_at=? WHERE id=? AND status='processing' AND claim_token=?`)
            .bind(reason, jstNow(), job.id, claimToken).run();
          if (changed.meta.changes) skipped++;
          continue;
        }
        recipientLineUserId = current.line_user_id;
      }
      const messages = buildNenDeliveryMessages(campaign, payload);
      const retryGeneration = Number(job.retry_generation ?? 0);
      const idempotencyKey = retryGeneration > 0
        ? `${job.id}:manual:${retryGeneration}`
        : job.id;
      await pushViaHarnessProxy(
        options.proxyBaseUrl, accessToken, recipientLineUserId, messages, idempotencyKey, options.proxyDispatch,
      );
      await db.prepare(
        `UPDATE nen_delivery_jobs SET status = 'sent', sent_at = ?, last_error = NULL, updated_at = ? WHERE id = ? AND claim_token = ?`,
      ).bind(jstNow(), jstNow(), job.id, claimToken).run();
      sent++;
      if (job.line_account_id) {
        perAccountSent.set(job.line_account_id, (perAccountSent.get(job.line_account_id) ?? 0) + 1);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : 'Unknown error';
      await db.prepare(
        `UPDATE nen_delivery_jobs SET status = 'failed', last_error = ?, next_attempt_at = ?, updated_at = ? WHERE id = ? AND claim_token = ?`,
      ).bind(message, new Date(now.getTime() + RETRY_DELAYS_MS[Math.min(Number(job.attempts ?? 0), 2)]).toISOString(), now.toISOString(), job.id, claimToken).run();
      logger.error("nen_delivery_failed");
      failed++;
    }
  }
  return { sent, failed, skipped, deferred };
}

export { flexMessage as buildNenFlexMessage };
