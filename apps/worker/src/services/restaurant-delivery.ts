import { jstCalendar as japanCalendar } from '@line-crm/shared';
import { jstDate as japanDate } from '@line-crm/shared';
export type { DeliveryService } from './delivery-service-types.js';
export { DELIVERY_SERVICES } from './delivery-service-types.js';
import { DELIVERY_SERVICES } from './delivery-service-types.js';
import type { DeliveryService } from './delivery-service-types.js';
import { tracedFetch as fetch } from '@line-crm/shared/server';
/** 飲食店の受注・送信は Uber Eats・出前館・ロケットナウの公式 API に限定し、この層で外部通信を管理する。急ぎ度はサーバーで決め、画面へは結果と理由だけを返す。時刻はエポック秒に統一し、ミリ秒との混在を防ぐため nowSec を使う。外部の自由文や例外は保存せず、固定分類だけを残す。menu はサービス終了のため対象外。設計図 kDQHr・hjdqV・dgeTy・OzHLO・h7OeT・XCVGd と照合する。 */
import {
  EXTERNAL_DELIVERY_MAX_ATTEMPTS,
  externalDeliveryRetryAt,
} from './external-delivery-retry.js';
import type { DeliveryWebhookEnv } from './delivery-webhook-ip.js';
import type { UberOAuthClient } from './uber-eats.js';
import { uberHosts, type UberHostEnv } from './uber-eats-hosts.js';

/** 画面に出すサービス名（D-1のカードと表のしるし、D-4の内訳、D-6の選択行）。 */
export const DELIVERY_SERVICE_LABELS: Record<DeliveryService, string> = {
  ubereats: 'Uber Eats',
  demaecan: '出前館',
  rocketnow: 'ロケットナウ',
};

export function isDeliveryService(value: unknown): value is DeliveryService {
  return typeof value === 'string' && (DELIVERY_SERVICES as readonly string[]).includes(value);
}

export type DeliveryOrderStatus =
  | 'new'
  | 'cooking'
  | 'ready'
  | 'handed_over'
  | 'canceled'
  | 'rejected';

export type DeliveryUrgency = 'urgent' | 'normal' | 'watch';

/** 状態が終わっているか。終わった注文は急ぎ度を「ふつう」で固定する。 */
export function isTerminalOrderStatus(status: DeliveryOrderStatus): boolean {
  return status === 'handed_over' || status === 'canceled' || status === 'rejected';
}

/** 画面の操作で進める次の状態（設計メモ「新着 → 調理中 → 準備完了 → 受け渡し済み」）。 */
const ORDER_TRANSITIONS: Record<DeliveryOrderStatus, DeliveryOrderStatus[]> = {
  new: ['cooking', 'rejected', 'canceled'],
  cooking: ['ready', 'canceled'],
  ready: ['handed_over', 'canceled'],
  handed_over: [],
  canceled: [],
  rejected: [],
};

export function canTransitionOrder(from: DeliveryOrderStatus, to: DeliveryOrderStatus): boolean {
  return ORDER_TRANSITIONS[from].includes(to);
}

export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

// ---------- 急ぎ度の自動判定 ----------

/**
 * しきい値。D-1の見本（9分=ふつう／12分=注意／受け取り希望まで13分=急ぎ）に合わせた。
 * 数字をここに集めておき、運用で動かすときに1か所だけ直せるようにする。
 */
export const URGENCY_WANTED_SOON_MINUTES = 15;
export const URGENCY_ELAPSED_URGENT_MINUTES = 20;
export const URGENCY_ELAPSED_WATCH_MINUTES = 12;
/** 調理待ちがこの件数以上あると、同じ待ち時間でも先に手を付けたほうがよい。 */
export const URGENCY_COOKING_BACKLOG = 3;

export interface UrgencyInput {
  status: DeliveryOrderStatus;
  /** 受信時刻（エポック秒）。 */
  receivedAt: number;
  /** 受け取り希望時刻（エポック秒）。分からなければ null。 */
  wantedAt: number | null;
  /** 品数（点）。 */
  itemCount: number;
  /** 同じ店舗で調理中の件数。 */
  cookingCount: number;
  /** 判定時刻（エポック秒）。 */
  now: number;
}

export interface UrgencyResult {
  urgency: DeliveryUrgency;
  /** D-2の帯に出す理由の文。仕組みの名称は入れない。 */
  reason: string | null;
}

/**
 * 待ち時間・品数・調理待ち件数から急ぎ度を決める。
 * 画面（D-2 `hjdqV`）に出るのはここで作る結果と理由だけ。
 */
export function judgeUrgency(input: UrgencyInput): UrgencyResult {
  if (isTerminalOrderStatus(input.status)) {
    return { urgency: 'normal', reason: null };
  }
  const elapsedMinutes = Math.max(0, Math.floor((input.now - input.receivedAt) / 60));
  const untilWantedMinutes =
    input.wantedAt === null ? null : Math.floor((input.wantedAt - input.now) / 60);

  const parts: string[] = [];
  if (untilWantedMinutes !== null) {
    parts.push(
      untilWantedMinutes >= 0
        ? `受け取り希望まで${untilWantedMinutes}分`
        : `受け取り希望を${Math.abs(untilWantedMinutes)}分超過`,
    );
  } else {
    parts.push(`受信から${elapsedMinutes}分`);
  }
  parts.push(`品数${input.itemCount}点`);
  parts.push(`調理待ち${input.cookingCount}件`);
  const basis = parts.join('・');

  const wantedSoon =
    untilWantedMinutes !== null && untilWantedMinutes <= URGENCY_WANTED_SOON_MINUTES;
  const waitedTooLong = elapsedMinutes >= URGENCY_ELAPSED_URGENT_MINUTES;
  if (wantedSoon || waitedTooLong) {
    return { urgency: 'urgent', reason: `${basis}のため、先に調理を始めるのがおすすめです` };
  }

  const nearWatch = elapsedMinutes >= URGENCY_ELAPSED_WATCH_MINUTES;
  const backlogged = input.cookingCount >= URGENCY_COOKING_BACKLOG && input.itemCount >= 4;
  if (nearWatch || backlogged) {
    return { urgency: 'watch', reason: `${basis}のため、進み具合を確認してください` };
  }

  return { urgency: 'normal', reason: null };
}

// ---------- 画面に出す要約 ----------

export interface DeliveryItemLike {
  name: string;
  quantity: number;
}

/**
 * D-1／D-4の「注文内容」列の要約。
 * 見本：2品までは並べる（「バターチキンカレー×2 ナン×2」）、3品以上は
 * 先頭だけ出して残りの**品数（行数）**を添える（「唐揚げ弁当×2 ほか3点」）。
 * 「点」は数量の合計ではなく品目の数。D-2の「品数4点」と同じ数え方にそろえる。
 */
export const SUMMARY_INLINE_ITEM_LIMIT = 2;

export function summarizeOrderItems(items: DeliveryItemLike[]): string {
  if (items.length === 0) return '';
  const text = (item: DeliveryItemLike) => `${item.name}×${item.quantity}`;
  if (items.length <= SUMMARY_INLINE_ITEM_LIMIT) return items.map(text).join(' ');
  return `${text(items[0])} ほか${items.length - 1}点`;
}

/** 受付停止の長さ（D-6の「30分」「60分」「90分」「本日中」）。 */
export type IntakeStopPreset = '30m' | '60m' | '90m' | 'today';

export const INTAKE_STOP_PRESETS: IntakeStopPreset[] = ['30m', '60m', '90m', 'today'];

export function isIntakeStopPreset(value: unknown): value is IntakeStopPreset {
  return typeof value === 'string' && (INTAKE_STOP_PRESETS as string[]).includes(value);
}

/**
 * 自動再開の時刻（エポック秒）。「本日中」は店舗の時間帯で当日の終わりまで。
 * 時間帯は Asia/Tokyo 固定。サービス側の締めも日本時間で動くため合わせる。
 */
export function intakeStopUntil(preset: IntakeStopPreset, now: number): number {
  if (preset === '30m') return now + 30 * 60;
  if (preset === '60m') return now + 60 * 60;
  if (preset === '90m') return now + 90 * 60;
  // 「本日中」= 日本時間のその日の 23:59:59 まで。
  const jst = japanCalendar(new Date((now) * 1000));
  const endOfDayJst = Date.UTC(
    jst.getUTCFullYear(),
    jst.getUTCMonth(),
    jst.getUTCDate(),
    23,
    59,
    59,
  );
  return Math.floor(endOfDayJst / 1000) - 9 * 3600;
}

// ---------- 日本時間の1日 ----------

/** 日本時間の時差。サービス側の締めも日本時間で動くため固定で合わせる。 */
const JST_OFFSET_SECONDS = 9 * 3600;

const DATE_TEXT_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** エポック秒を日本時間の `YYYY-MM-DD` にする。 */
export function tokyoDateText(now: number): string {
  return japanDate(new Date(now * 1000));
}

export interface TokyoDayRange {
  dateText: string;
  /** この秒以上 */
  from: number;
  /** この秒未満 */
  to: number;
}

/**
 * 日本時間のその日の範囲。D-1の「本日」とD-4の日付指定はどちらもこれで数える。
 * 形のおかしい指定・存在しない日付は当日へ落とす（画面の操作で壊れないようにする）。
 */
export function tokyoDayRange(dateText: string | null | undefined, now: number): TokyoDayRange {
  const requested = typeof dateText === 'string' ? dateText.trim() : '';
  const text = DATE_TEXT_PATTERN.test(requested) ? requested : tokyoDateText(now);
  const [year, month, day] = text.split('-').map(Number);
  const from = Math.floor(Date.UTC(year, month - 1, day) / 1000) - JST_OFFSET_SECONDS;
  // 2026-13-45 のような日付は Date.UTC が繰り上げるため、往復で確かめて当日へ戻す。
  if (tokyoDateText(from) !== text) return tokyoDayRange(null, now);
  return { dateText: text, from, to: from + 24 * 3600 };
}

// ---------- 各サービスへの送信 ----------

export type DeliveryAction =
  | 'accept'
  | 'reject'
  | 'ready'
  | 'handed_over'
  | 'cancel'
  | 'menu_sold_out'
  | 'menu_resume'
  | 'intake_stop'
  | 'intake_resume';

/** サービス側のどの窓口を叩くか。実際のパスは各サービスの仕様に合わせて設定で差し替える。 */
const ACTION_PATHS: Record<DeliveryAction, string> = {
  accept: '/orders/accept',
  reject: '/orders/reject',
  ready: '/orders/ready',
  handed_over: '/orders/handed-over',
  cancel: '/orders/cancel',
  menu_sold_out: '/menu/sold-out',
  menu_resume: '/menu/resume',
  intake_stop: '/intake/stop',
  intake_resume: '/intake/resume',
};

export interface DeliveryEnv extends DeliveryWebhookEnv, UberHostEnv {
  RT_DELIVERY_SEND_ENABLED?: string;
  LINE_CREDENTIAL_ENCRYPTION_KEY?: string;
  RT_DELIVERY_UBEREATS_API_BASE_URL?: string;
  RT_DELIVERY_UBEREATS_API_TOKEN?: string;
  RT_DELIVERY_DEMAECAN_API_BASE_URL?: string;
  RT_DELIVERY_DEMAECAN_API_TOKEN?: string;
  RT_DELIVERY_ROCKETNOW_API_BASE_URL?: string;
  RT_DELIVERY_ROCKETNOW_API_TOKEN?: string;
  /**
   * Uber Eats のログイン連携（お店の人が設定画面から自分でつなぐ経路）。
   * ここに入るのは Uber の開発者画面で発行された値で、画面には出さない。
   */
  RT_DELIVERY_UBEREATS_CLIENT_ID?: string;
  RT_DELIVERY_UBEREATS_CLIENT_SECRET?: string;
  /** 既定では使わない。Uber 側の登録が別の文字列のときだけ上書きとして入れる。 */
  RT_DELIVERY_UBEREATS_REDIRECT_URI?: string;
  /** 戻り先URLの土台。配備の設定で環境ごとに決まる。 */
  WORKER_PUBLIC_URL?: string;
}

/** 認可画面からの戻り先の道。Uber のアプリ登録と同じ文字列にする。 */
export const UBER_OAUTH_CALLBACK_PATH = '/api/restaurant-test/delivery/ubereats/oauth/callback';

/**
 * Uber Eats のログイン連携の設定。ID と Secret がそろっていないときは連携の口を開けない。
 * 戻り先は呼び出し元のホストからは組み立てない。入口と戻り先で1文字でも違うと Uber 側で
 * はじかれるため、配備の設定（WORKER_PUBLIC_URL）に固定する（Google 接続と同じ考え方）。
 */
export function uberOAuthClient(env: DeliveryEnv): UberOAuthClient | null {
  const clientId = env.RT_DELIVERY_UBEREATS_CLIENT_ID?.trim();
  const clientSecret = env.RT_DELIVERY_UBEREATS_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;

  const override = env.RT_DELIVERY_UBEREATS_REDIRECT_URI?.trim();
  const base = env.WORKER_PUBLIC_URL?.trim().replace(/\/+$/, '');
  const redirectUri = override || (base ? `${base}${UBER_OAUTH_CALLBACK_PATH}` : '');
  if (!redirectUri.startsWith('https://')) return null;
  // 設定の書き間違いは本番へ落とさず「未設定」にする（uber-eats-hosts.ts）。
  const hosts = uberHosts(env);
  if (!hosts) return null;
  return { clientId, clientSecret, redirectUri, hosts };
}

/**
 * Uber からの通知を確かめる鍵。公式仕様では client_secret そのものが署名の鍵になる。
 * 静的なトークンの経路（RT_DELIVERY_*_WEBHOOK_SECRET）とは別の値なので混ぜない。
 */
export function uberWebhookSecret(env: DeliveryEnv): string | null {
  return uberOAuthClient(env)?.clientSecret ?? null;
}

/** 'true' のときだけ各サービスへ送る。既定は送らない（読み取りと記録だけ）。 */
export function deliverySendEnabled(env: DeliveryEnv): boolean {
  return env.RT_DELIVERY_SEND_ENABLED?.trim().toLowerCase() === 'true';
}

function apiConfigFor(
  env: DeliveryEnv,
  service: DeliveryService,
): { baseUrl: string; token: string } | null {
  const baseUrl = (
    service === 'ubereats'
      ? env.RT_DELIVERY_UBEREATS_API_BASE_URL
      : service === 'demaecan'
        ? env.RT_DELIVERY_DEMAECAN_API_BASE_URL
        : env.RT_DELIVERY_ROCKETNOW_API_BASE_URL
  )?.trim();
  const token = (
    service === 'ubereats'
      ? env.RT_DELIVERY_UBEREATS_API_TOKEN
      : service === 'demaecan'
        ? env.RT_DELIVERY_DEMAECAN_API_TOKEN
        : env.RT_DELIVERY_ROCKETNOW_API_TOKEN
  )?.trim();
  if (!baseUrl || !token) return null;
  if (!baseUrl.startsWith('https://')) return null;
  return { baseUrl: baseUrl.replace(/\/+$/, ''), token };
}

/** 外部の接続先を画面へ秘匿したまま、確認後の変更を検出する。 */
export async function deliveryTargetFingerprint(env: DeliveryEnv, service: DeliveryService): Promise<string | null> {
  const secret = env.LINE_CREDENTIAL_ENCRYPTION_KEY?.trim();
  if (!secret) return null;
  const config = apiConfigFor(env, service);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const input = JSON.stringify([service, config?.baseUrl ?? '', config?.token ?? '']);
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** 画面に出す安全な失敗理由。サービスの本文は入れない。 */
export interface SafeDeliveryError {
  code: string;
  message: string;
  retryable: boolean;
}

const DELIVERY_ERROR_MESSAGES: Record<string, { message: string; retryable: boolean }> = {
  delivery_action_unsupported: {
    message: 'この操作は現在のUber Eats連携では利用できません。Uber Eats側で操作してください。',
    retryable: false,
  },
  delivery_result_unknown: {
    message: '送信結果を確認できません。重複操作を防ぐため再送を止めています。Uber Eats側の注文状態を確認してください。',
    retryable: false,
  },
  delivery_order_conflict: {
    message: 'この注文は操作中か、状態が変わっています。画面を開き直してください。',
    retryable: false,
  },
  delivery_operation_failed: {
    message: 'この操作は完了していません。Uber Eats側の注文状態と連携設定を確認してください。',
    retryable: false,
  },
  delivery_send_disabled: {
    message: 'この環境では各サービスへの送信が止まっています。設定を有効にしてからやり直してください。',
    retryable: false,
  },
  delivery_not_configured: {
    message: 'このサービスとの連携設定が未完了です。連携を設定してからやり直してください。',
    retryable: false,
  },
  delivery_authentication_failed: {
    message: 'サービス側の認証に失敗しました。連携の設定を確認してください。',
    retryable: false,
  },
  delivery_rejected: {
    message: 'サービス側で受け付けられませんでした。注文の状態を確認してください。',
    retryable: false,
  },
  delivery_rate_limited: {
    message: 'サービス側の制限に達しました。少し待ってからやり直してください。',
    retryable: true,
  },
  delivery_temporary_failure: {
    message: 'サービス側で一時的な問題が起きました。少し待ってからやり直してください。',
    retryable: true,
  },
  delivery_timeout: {
    message: 'サービスへの送信が時間内に終わりませんでした。少し待ってからやり直してください。',
    retryable: true,
  },
};

export function safeDeliveryError(code: string): SafeDeliveryError {
  const known = DELIVERY_ERROR_MESSAGES[code] ?? DELIVERY_ERROR_MESSAGES.delivery_temporary_failure;
  return { code, message: known.message, retryable: known.retryable };
}

/**
 * HTTPの様子だけを見て分類する。
 * external-delivery-retry.ts の分類はLINE向けの符号なので、ここでは配達サービス向けに作る。
 * 再試行の間隔（1分・5分・30分／最大4回）だけ共通基盤から借りる。
 */
export function classifyDeliveryStatus(status: number): SafeDeliveryError {
  if (status === 401 || status === 403) return safeDeliveryError('delivery_authentication_failed');
  if (status === 429) return safeDeliveryError('delivery_rate_limited');
  if (status >= 500) return safeDeliveryError('delivery_temporary_failure');
  return safeDeliveryError('delivery_rejected');
}

export interface DeliveryDispatchRequest {
  service: DeliveryService;
  action: DeliveryAction;
  /** サービス側の識別子（注文ID・商品ID）。サービス単位の操作では省く。 */
  externalId?: string | null;
  /** 送る本文。秘密値は入れない。 */
  body?: Record<string, unknown>;
}

export type DeliveryDispatchResult =
  | { ok: true }
  | { ok: false; error: SafeDeliveryError; nextAttemptAt: number | null };

const SEND_TIMEOUT_MS = 10_000;
/** 送る本文の上限。想定外に大きい本文を外へ出さない。 */
const MAX_SEND_BYTES = 64 * 1024;

/**
 * 1件分の送信。成功（ok:true）のときだけ呼び出し側がD1の状態を進める。
 * 失敗時は状態を変えないので、画面から押し直せる（設計メモ「送信に失敗した場合は
 * 画面にエラーを表示し、状態は変えない」）。
 */
export async function dispatchToDeliveryService(
  env: DeliveryEnv,
  request: DeliveryDispatchRequest,
  options: {
    completedAttempts: number;
    now: Date;
    fetcher?: typeof fetch;
  },
): Promise<DeliveryDispatchResult> {
  const failWith = (error: SafeDeliveryError): DeliveryDispatchResult => {
    // 再試行の間隔（1分・5分・30分／最大4回）だけ共通基盤から借りる。
    const retryAt = externalDeliveryRetryAt(
      { status: error.code === 'delivery_rate_limited' ? 429 : 500 },
      options.completedAttempts,
      options.now,
      error.retryable,
    );
    return {
      ok: false,
      error,
      nextAttemptAt: retryAt ? Math.floor(retryAt.getTime() / 1000) : null,
    };
  };

  if (!deliverySendEnabled(env)) return failWith(safeDeliveryError('delivery_send_disabled'));
  // Uber は注文ごとの実行権と公式APIを使う専用経路だけに送る。
  if (request.service === 'ubereats') return failWith(safeDeliveryError('delivery_action_unsupported'));
  const config = apiConfigFor(env, request.service);
  if (!config) return failWith(safeDeliveryError('delivery_not_configured'));
  if (options.completedAttempts >= EXTERNAL_DELIVERY_MAX_ATTEMPTS) {
    return { ok: false, error: safeDeliveryError('delivery_rejected'), nextAttemptAt: null };
  }

  const payload = JSON.stringify({
    ...(request.externalId ? { external_id: request.externalId } : {}),
    ...(request.body ?? {}),
  });
  if (new TextEncoder().encode(payload).byteLength > MAX_SEND_BYTES) {
    return failWith(safeDeliveryError('delivery_rejected'));
  }

  const fetcher = options.fetcher ?? fetch;
  let response: Response;
  try {
    response = await fetcher(`${config.baseUrl}${ACTION_PATHS[request.action]}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.token}`,
      },
      body: payload,
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  } catch (error) {
    // 例外の本文は残さない。種類だけで時間切れかどうかを分ける。
    const timedOut = error instanceof Error && /timeout|aborted/i.test(error.name + error.message);
    return failWith(safeDeliveryError(timedOut ? 'delivery_timeout' : 'delivery_temporary_failure'));
  }

  if (!response.ok) return failWith(classifyDeliveryStatus(response.status));
  return { ok: true };
}
