import { logger, tracedFetch as fetch } from '@line-crm/shared/server';

import { parseRetryAfter } from '../lib/external-call/policy.js';
/**
 * 送信Webhookの配送。
 *
 * これまで fetch を投げっぱなしにしていて、次の2つが起きていた:
 *   - 相手が 500 を返しても成功として扱っていた（例外にならないため）
 *   - 一度失敗したら終わりで、送り直す手立てが無かった
 *
 * 093 で足した列を使って、送り直しと失敗の記録を入れる。
 */

import {
  createNotification,
  createWebhookInteraction,
  finishWebhookInteraction,
  hasSucceededInteractionForKey,
  markFailedInteractionsRetried,
  activeTenantLineAccountSql,
  isOperationCapabilityStopped,
  resolveWebhookSecret,
  type WebhookInteractionFailureReason,
  type WebhookKeyInput,
} from '@line-crm/db';


import { stoppedTenantLineAccountSql } from './tenant-runtime-status.js';
import { EXTERNAL_DELIVERY_RETRY_AFTER_MAX_MINUTES } from './external-delivery-retry.js';
import { signHarnessEvent } from './operations-signature.js';

// ============================================================
// 共通封筒と署名ヘッダ（要件26 §6-2 / §6-5、）
// ============================================================
//
// 送信Webhookへ届く本文とヘッダは、どの経路（イベント通知・自動化の
// send_webhook・旧式の直書きURL・管理画面の試し送信）からでも同じ形に
// する。経路ごとの差は封筒の data の中身だけに寄せ、形はここで一元化する。
//
//   { id, type, occurred_at, account_id, data, attempt }
//
//   id          … 再送しても変わらない出来事のID。X-Harness-Event-Id と
//                 同じ値で、受け手はこれで冪等に捌く。
//   type        … 出来事の種類（例: booking.confirmed.v1）。
//   occurred_at … 出来事が起きた時刻。送信時刻とは分ける。
//   account_id  … 発生したLINE公式アカウント。
//   data        … 経路ごとの明細。秘密値・アクセストークン・
//                 replyToken・内部メモは絶対に入れない。
//   attempt     … 何回目の配送か（初回は 1）。
//
// 署名ヘッダ（要件26 §6-5）:
//   X-Harness-Event-Id   … 封筒の id と同じ値。冪等キーとしても使う。
//   X-Harness-Timestamp  … 送信時刻（Unix秒）。
//   X-Harness-Signature  … v1=<HMAC-SHA256 hex>。
//                          署名入力は「タイムスタンプ.イベントID.本文」。
// secret が未設定の行は署名なしで送る（従来どおり）。secret が設定済みで
// 読めないときは呼び出し側が送らずに止める。

/** 封筒のイベントIDを運ぶヘッダ名。 */
export const HARNESS_EVENT_ID_HEADER = 'X-Harness-Event-Id';
/** 送信時刻（Unix秒）を運ぶヘッダ名。 */
export const HARNESS_TIMESTAMP_HEADER = 'X-Harness-Timestamp';
/** 署名を運ぶヘッダ名。値は `v1=<hex>`。 */
export const HARNESS_SIGNATURE_HEADER = 'X-Harness-Signature';

export interface OutgoingWebhookEnvelope {
  id: string;
  type: string;
  occurred_at: string;
  account_id: string | null;
  data: unknown;
  attempt: number;
}

export interface OutgoingWebhookEnvelopeInput {
  /** 再送・再試行で変わらない出来事のID。冪等キーと同じ値を渡す。 */
  eventId: string;
  eventType: string;
  /** 出来事が起きた時刻（ISO 8601）。分からなければ送信時刻を渡す。 */
  occurredAt: string;
  accountId: string | null;
  /** 秘密値・トークン・内部メモを含まない明細。 */
  data: unknown;
  /** 何回目の配送か。省略時は 1。 */
  attempt?: number;
}

/** 共通封筒を組み立てる。 */
export function buildOutgoingWebhookEnvelope(input: OutgoingWebhookEnvelopeInput): OutgoingWebhookEnvelope {
  return {
    id: input.eventId,
    type: input.eventType,
    occurred_at: input.occurredAt,
    account_id: input.accountId,
    data: input.data,
    attempt: Math.max(1, Math.floor(input.attempt ?? 1)),
  };
}

/** 共通封筒を JSON 本文へする。 */
export function buildOutgoingWebhookBody(input: OutgoingWebhookEnvelopeInput): string {
  return JSON.stringify(buildOutgoingWebhookEnvelope(input));
}

/**
 * 送信ヘッダを組み立てる。secret があるときだけ署名を付ける。
 * タイムスタンプは呼び出し1回につき1つで、封筒・署名と同じ材料を使う。
 */
export async function buildOutgoingWebhookHeaders(input: {
  eventId: string;
  body: string;
  secret?: string | null;
  now?: Date;
}): Promise<Record<string, string>> {
  const timestamp = String(Math.floor((input.now ?? new Date()).getTime() / 1000));
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    [HARNESS_EVENT_ID_HEADER]: input.eventId,
    [HARNESS_TIMESTAMP_HEADER]: timestamp,
  };
  if (input.secret) {
    headers[HARNESS_SIGNATURE_HEADER] = `v1=${await signHarnessEvent(input.secret, timestamp, input.eventId, input.body)}`;
  }
  return headers;
}

/** 送り直しまでの待ち時間（ミリ秒）。 */
export function retryDelayMs(attempt: number): number {
  // 1回目 0.5秒、2回目 1秒、3回目 2秒…と倍にして、8秒で頭打ちにする。
  // Worker の実行時間には限りがあるので、分単位では待たない。
  // 相手が長時間落ちている場合まで面倒を見るなら、キューに積む別の設計が要る。
  return Math.min(8000, 500 * 2 ** attempt);
}

/**
 * 無応答の宛先で処理を止め続けないよう、送信側で全経路へ既定10秒のタイムアウトを適用する。要件26 §6-4 に従う。
 */
export const WEBHOOK_FETCH_TIMEOUT_MS = 10_000;

/** 呼び出し側が延ばせる上限（ミリ秒）。要件26 §6-4 の最大30秒。 */
export const WEBHOOK_FETCH_TIMEOUT_MS_MAX = 30_000;

/**
 * Retry-After の指定どおりに Worker 内で待つ上限（ミリ秒）。
 *
 * 混雑時の再送が相手の指定を無視して空振りしていた。指定どおりに
 * 待つが、Worker の実行時間に限りがあるため、この上限を超える指定は
 * 上限まで待つ。短い指数待ちへ戻すと、相手の混雑中に再送を早めてしまう。
 */
export const WEBHOOK_RETRY_AFTER_MAX_MS = 8_000;

/** fetch の打ち切り時間を決める。不正・未指定は既定、上限超えは上限へ丸める。 */
export function webhookFetchTimeoutMs(value: unknown): number {
  const ms = typeof value === 'number' ? value : WEBHOOK_FETCH_TIMEOUT_MS;
  if (!Number.isFinite(ms) || ms <= 0) return WEBHOOK_FETCH_TIMEOUT_MS;
  return Math.min(ms, WEBHOOK_FETCH_TIMEOUT_MS_MAX);
}

/**
 * Retry-After 応答頭をミリ秒へ読み替える。秒数形式と HTTP-date 形式の両方を
 * 受け付ける。読めない・過去の指定は null を返し、呼び出し側が既定の待ちへ
 * 丸める。クランプはここでは行わず、用途ごとの上限を呼び出し側が決める
 * （リクエスト内で待つなら秒、台帳へ積む再送なら分まで許せる）。
 */
function parseRetryAfterDelayMs(header: string | null, nowMs: number): number | null {
  const at = parseRetryAfter(header, nowMs);
  return at === undefined ? null : at - nowMs;
}

/**
 * Retry-After 応答頭を読む。
 *
 * 読めない・過去の指定は fallbackMs（既定の指数待ち）へ丸める。
 * 上限超えの指定は maxMs（既定は Worker 内で待てる WEBHOOK_RETRY_AFTER_MAX_MS）
 * へ丸め、相手の指定より極端に早く再送しない。
 * 送り直しの回数は増やさない（待つ長さを変えるだけ）。
 */
export function retryAfterDelayMs(
  header: string | null,
  fallbackMs: number,
  nowMs: number = Date.now(),
  maxMs: number = WEBHOOK_RETRY_AFTER_MAX_MS,
): number {
  const parsed = parseRetryAfterDelayMs(header, nowMs);
  if (parsed === null) return fallbackMs;
  return Math.min(parsed, maxMs);
}

/**
 * 送り直す価値のある応答か（要件26 §6-4）。
 *
 * 4xx は相手が「この内容は受け取れない」と言っているので、同じものを
 * 送り直しても結果は変わらない。425（早すぎる）と 429（多すぎる）だけは
 * 時間を置けば通るので送り直す。408・409 は人手の明示再試行に限る。
 */
export function shouldRetryStatus(status: number): boolean {
  if (status === 429 || status === 425) return true;
  return status >= 500;
}

export interface WebhookRow {
  id: string;
  url: string;
  /** 旧平文。 以降の新規・更新では NULL になる。 */
  secret: string | null;
  /** AES-GCM 暗号文。 以降の正本。署名はここから復号した値で付ける。 */
  secret_encrypted?: string | null;
  max_retries: number | null;
}

/**
 * 送信直前の SSRF 再検査。
 *
 * 登録時の検査だけでは、古い設定のまま DNS が差し替わったり、
 * 転送先が内部を向いたりしたときに内部・private 宛てへ送ってしまう。
 * そのため送るたびに「HTTPSか・host/IPは公開側か・転送先の各段は安全か」
 * を確かめてから送る。DNS は送るたびに引き直し、結果は使い回さない。
 *
 * 配送の境界は2層である。アプリ層(このファイル)は fail-closed の検査で
 * 非公開宛てを送る前に止め、秘密値なしで台帳へ残す。同一 hop 内では
 * 接続直前にもう一度引いて検査時との一致を確かめ、違えば送らない。
 * 基盤層(Cloudflare)側は次の公式仕様が非公開宛てへの到達そのものを断つ。
 * staging/prod 両方の wrangler には global_fetch_strictly_public を適用し、
 * subrequest を公開インターネット経路に限定している。
 * - 自分以外のゾーンへ cf.resolveOverride は効かない(接続の固定化は不可)。
 *   https://developers.cloudflare.com/workers/runtime-apis/request/
 * - Cloudflare 所有IPへの subrequest は 1024 で拒否される。
 *   https://developers.cloudflare.com/workers/observability/errors/
 * - Workers が private origin へ届くのは VPC 等の binding 経由だけ。
 *   この Worker に private 用 binding は無い(apps/worker/wrangler.toml)。
 *   https://blog.cloudflare.com/private-origins-dns-routing/
 * 残るのは公開→公開の差し替え(誤配送のみ。秘密値は送らない)である。
 */

export type WebhookDnsLookup = (host: string) => Promise<string[]>;

export type WebhookBlockReason =
  | 'invalid_url'
  | 'non_https'
  | 'credentials_in_url'
  | 'blocked_host'
  | 'blocked_ip'
  | 'dns_unresolved'
  | 'dns_changed'
  | 'unsafe_redirect';

function parseIpv4Parts(host: string): number[] | null {
  // 10進のほか、0始まりの8進・0x始まりの16進の書き方もIPとして読む。
  // そうしないと 0x7f.0.0.1 のような書き方で抜け道になる。
  const parts = host.split('.');
  if (parts.length < 1 || parts.length > 4) return null;
  const nums: number[] = [];
  for (const part of parts) {
    if (part.length === 0) return null;
    let n: number;
    if (/^0x[0-9a-f]+$/i.test(part)) n = parseInt(part, 16);
    else if (/^0[0-7]+$/.test(part)) n = parseInt(part, 8);
    else if (/^\d+$/.test(part)) n = parseInt(part, 10);
    else return null;
    if (!Number.isSafeInteger(n) || n < 0 || n > 0xffffffff) return null;
    nums.push(n);
  }
  return nums;
}

function ipv4ToBytes(nums: number[]): number[] | null {
  if (nums.length === 0) return null;
  if (nums.length === 4) {
    return nums.every((n) => n <= 255) ? [...nums] : null;
  }
  if (nums.length === 3) {
    if (nums[0] > 255 || nums[1] > 255 || nums[2] > 65535) return null;
    return [nums[0], nums[1], (nums[2] >> 8) & 255, nums[2] & 255];
  }
  if (nums.length === 2) {
    if (nums[0] > 255 || nums[1] > 16777215) return null;
    return [nums[0], (nums[1] >> 16) & 255, (nums[1] >> 8) & 255, nums[1] & 255];
  }
  const n = nums[0];
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
}

function isBlockedIpv4Bytes(b: number[]): boolean {
  const [a, c, d] = b;
  if (a === 10) return true;
  if (a === 172 && c >= 16 && c <= 31) return true;
  if (a === 192 && c === 168) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  // link-local。クラウドの metadata (169.254.169.254) もここで止まる。
  if (a === 169 && c === 254) return true;
  if (a === 100 && c >= 64 && c <= 127) return true;
  if (a === 192 && c === 0 && d === 0) return true;
  if (a === 192 && c === 0 && d === 2) return true;
  if (a === 198 && (c === 18 || c === 19)) return true;
  if (a === 198 && c === 51 && d === 100) return true;
  if (a === 203 && c === 0 && d === 113) return true;
  if (a >= 224 && a <= 239) return true;
  if (a >= 240) return true;
  return false;
}

function expandIpv6(host: string): number[] | null {
  // 8群の数値列へ展開する。書式が崩れていたら null(送らない側に倒す)。
  const halves = host.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : [];
  const parts = [...head, ...tail];
  if (parts.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  const nums = parts.map((g) => parseInt(g, 16));
  if (halves.length === 1) return nums.length === 8 ? nums : null;
  if (nums.length > 7) return null;
  return [...nums.slice(0, head.length), ...new Array(8 - nums.length).fill(0), ...nums.slice(head.length)];
}

function isBlockedIpv6Groups(g: number[]): boolean {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g;
  if (g.every((n) => n === 0)) return true;
  if (g.slice(0, 7).every((n) => n === 0) && g7 === 1) return true;
  // link-local fe80::/10。fe80〜febf の全範囲を止める。
  if ((g0 & 0xffc0) === 0xfe80) return true;
  if ((g0 & 0xffc0) === 0xfec0) return true;
  if ((g0 & 0xfe00) === 0xfc00) return true;
  if ((g0 & 0xff00) === 0xff00) return true;
  if (g0 === 0x2001 && g1 === 0x0db8) return true;
  if (g0 === 0x0064 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return true;
  const v4bytes = (hi: number, lo: number) => [(hi >> 8) & 255, hi & 255, (lo >> 8) & 255, lo & 255];
  // ffff:0:0/96 の IPv4 射影は中の IPv4 で判断する。
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return isBlockedIpv4Bytes(v4bytes(g6, g7));
  }
  // 6to4 (2002::/16) は中に IPv4 を埋め込むので同じく判断する。
  if (g0 === 0x2002) return isBlockedIpv4Bytes(v4bytes(g1, g2));
  // Teredo (2001::/32) は判別が複雑なため送らない。ISATAP は中の IPv4 で判断する。
  if (g0 === 0x2001 && g1 === 0x0000) return true;
  if (g4 === 0 && g5 === 0x5efe) return isBlockedIpv4Bytes(v4bytes(g6, g7));
  return false;
}

function isBlockedIpv6Literal(host: string): boolean {
  const h = host.toLowerCase();
  if (h.includes('.')) {
    // ffff:127.0.0.1 形式だけ受け付け、中のIPv4で判断する。
    if (!h.startsWith('::ffff:')) return true;
    const bytes = ipv4ToBytes(parseIpv4Parts(h.slice('::ffff:'.length)) ?? []);
    if (!bytes) return true;
    return isBlockedIpv4Bytes(bytes);
  }
  const groups = expandIpv6(h);
  if (!groups) return true;
  return isBlockedIpv6Groups(groups);
}

function normalizeHostname(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  return url.hostname.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
}

/** 文字面だけの検査。DNS は引かない。 */
export function webhookUrlBlockReason(value: string): WebhookBlockReason | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'invalid_url';
  }
  if (url.protocol !== 'https:') return 'non_https';
  if (url.username || url.password) return 'credentials_in_url';
  const raw = url.hostname.toLowerCase();
  if (raw.includes('%')) return 'blocked_host';
  const host = raw.replace(/\.$/, '').replace(/^\[|\]$/g, '');
  if (
    host === 'localhost'
    || host.endsWith('.localhost')
    || host.endsWith('.local')
    || host.endsWith('.internal')
    || host === 'metadata.google.internal'
    || host.endsWith('.metadata.google.internal')
    || host === 'metadata.google.com'
  ) return 'blocked_host';
  if (host.includes(':')) {
    return isBlockedIpv6Literal(host) ? 'blocked_ip' : null;
  }
  const nums = parseIpv4Parts(host);
  if (nums) {
    const bytes = ipv4ToBytes(nums);
    if (!bytes) return 'blocked_ip';
    return isBlockedIpv4Bytes(bytes) ? 'blocked_ip' : null;
  }
  // 数字・点・16進の文字だけでIPに見える書き方は、上の桁検査を
  // 通らなければ送らない(末尾が数字TLDの名前は実在しないため)。
  if (/^[0-9a-fx.]+$/i.test(host) && /\d/.test(host)) {
    return 'blocked_ip';
  }
  return null;
}

export function isSafeWebhookUrl(value: string): boolean {
  return webhookUrlBlockReason(value) === null;
}

function ipAddressBlockReason(address: string): WebhookBlockReason | null {
  const host = address.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  if (host.includes(':')) {
    return isBlockedIpv6Literal(host) ? 'blocked_ip' : null;
  }
  const bytes = ipv4ToBytes(parseIpv4Parts(host) ?? []);
  if (!bytes) return 'blocked_ip';
  return isBlockedIpv4Bytes(bytes) ? 'blocked_ip' : null;
}

async function dohQuery(host: string, type: 'A' | 'AAAA', fetchImpl: typeof fetch): Promise<string[]> {
  const res = await fetchImpl(
    `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`,
    { headers: { accept: 'application/dns-json' }, redirect: 'manual', signal: AbortSignal.timeout(5000) },
  );
  // 片系だけ失敗して他方が公開でも通さない。接続時は両系とも引けるため、
  // 見えていない系が非公開かもしれない状態で送らない(fail-closed)。
  if (!res.ok) throw new Error(`dns query failed: ${type} ${res.status}`);
  const data = (await res.json()) as { Status?: number; Answer?: Array<{ type: number; data: string }> };
  // DNS側の成功(Status===0)だけ受け付ける。失敗・欠落・非数値は
  // 送らない。片系だけ見えている状態で通すと、見えていない系の
  // 非公開宛てに繋がる恐れがある。
  if (data.Status !== 0) {
    throw new Error(`dns status: ${String(data.Status)}`);
  }
  const want = type === 'A' ? 1 : 28;
  const out: string[] = [];
  for (const answer of data.Answer ?? []) {
    if (answer.type !== want || typeof answer.data !== 'string') continue;
    out.push(answer.data.replace(/\.$/, ''));
  }
  return out;
}

async function defaultLookupHost(host: string, fetchImpl: typeof fetch): Promise<string[]> {
  // 例外時は空を返し、呼び出し側で fail-closed(送らない) にする。
  try {
    const [a, aaaa] = await Promise.all([
      dohQuery(host, 'A', fetchImpl),
      dohQuery(host, 'AAAA', fetchImpl),
    ]);
    return [...a, ...aaaa];
  } catch {
    return [];
  }
}

export interface WebhookSafetyOptions {
  lookupHost?: WebhookDnsLookup;
  fetchImpl?: typeof fetch;
}

export type WebhookSafetyVerdict = { ok: true; addresses: string[] } | { ok: false; reason: WebhookBlockReason };

async function resolveHostAddresses(
  host: string,
  opts: WebhookSafetyOptions,
): Promise<{ ok: true; addresses: string[] } | { ok: false; reason: 'dns_unresolved' }> {
  const lookup = opts.lookupHost ?? ((h) => defaultLookupHost(h, opts.fetchImpl ?? fetch));
  try {
    const addresses = await lookup(host);
    if (addresses.length === 0) return { ok: false, reason: 'dns_unresolved' };
    return { ok: true, addresses };
  } catch {
    return { ok: false, reason: 'dns_unresolved' };
  }
}

function checkResolvedAddresses(addresses: string[]): WebhookBlockReason | null {
  for (const address of addresses) {
    const reason = ipAddressBlockReason(address);
    if (reason) return reason;
  }
  return null;
}

/**
 * 送信直前の再検査。文字面の検査に加え、名前はその場で引き直して
 * 1件でも内部・private 側のIPが混ざっていたら止める。
 *
 * 名前が引けない・空のときは送らない(fail-closed)。
 * 検査したIPへ接続を固定する手段が実行環境にないため、引き直しは
 * 送る直前・送り直し・転送の各段で毎回行い、結果を使い回さない。
 * 同一 hop 内では接続直前にもう一度引いて一致を確かめる(後述)。
 */
export async function checkWebhookUrlSafety(
  value: string,
  opts: WebhookSafetyOptions = {},
): Promise<WebhookSafetyVerdict> {
  const literal = webhookUrlBlockReason(value);
  if (literal) return { ok: false, reason: literal };
  const host = normalizeHostname(value);
  if (!host) return { ok: false, reason: 'invalid_url' };
  if (host.includes(':') || ipv4ToBytes(parseIpv4Parts(host) ?? [])) return { ok: true, addresses: [] };
  const resolved = await resolveHostAddresses(host, opts);
  if (!resolved.ok) return resolved;
  const reason = checkResolvedAddresses(resolved.addresses);
  if (reason) return { ok: false, reason };
  return { ok: true, addresses: resolved.addresses };
}

export interface SafePostOptions {
  fetchImpl?: typeof fetch;
  lookupHost?: WebhookDnsLookup;
  maxRedirects?: number;
  /**
   * 1回の送信試行の打ち切り（ミリ秒）。未指定は既定10秒、上限30秒。
   * 呼び出し側が signal を渡したときも内部の打ち切りと合成する。
   */
  timeoutMs?: number;
}

export type SafePostOutcome = { response: Response } | { blocked: WebhookBlockReason };

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

function sameWebhookOrigin(a: string, b: string): boolean {
  try {
    const x = new URL(a);
    const y = new URL(b);
    const port = (u: URL) => u.port || (u.protocol === 'https:' ? '443' : u.protocol === 'http:' ? '80' : '');
    return (
      x.protocol === y.protocol
      && x.hostname.toLowerCase() === y.hostname.toLowerCase()
      && port(x) === port(y)
    );
  } catch {
    return false;
  }
}

// 別の送り先へ持ち越さない頭。署名・冪等・本文に関するものだけ落とす。
// 旧名（x-webhook-*、idempotency-key）も残す。経路によっては呼び出し側が
// 直接組み立てた頭が渡ることがあり、旧名が残っていても漏らさないため。
const CROSS_ORIGIN_DROPPED_HEADERS = new Set([
  'content-type',
  'content-length',
  'x-harness-event-id',
  'x-harness-timestamp',
  'x-harness-signature',
  'x-webhook-signature',
  'x-webhook-delivery-id',
  'idempotency-key',
  'authorization',
  'cookie',
]);

function stripCrossOriginHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!CROSS_ORIGIN_DROPPED_HEADERS.has(name.toLowerCase())) out[name] = value;
  }
  return out;
}

/**
 * 転送を1段ずつ手で辿りながら送る。転送先も送る前に再検査する。
 * 転送の段数が上限を超えたら最後の応答をそのまま返す(3xxは失敗扱い)。
 * 別の origin への転送では署名・冪等・本文の頭を持ち越さない。
 * 本文を保ったまま別 origin へ転送する応答(307/308)は送らずに止める。
 */
export async function postWebhookSafely(
  url: string,
  init: { headers: Record<string, string>; body?: string; signal?: AbortSignal },
  opts: SafePostOptions = {},
): Promise<SafePostOutcome> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxRedirects = opts.maxRedirects ?? 5;
  // 呼び出し側の signal があっても内部timeoutを外さない。1つの
  // 合成signalを全転送段で使うため、転送を繰り返しても試行全体が上限内で止まる。
  const timeoutSignal = AbortSignal.timeout(webhookFetchTimeoutMs(opts.timeoutMs));
  const signal = init.signal
    ? AbortSignal.any([init.signal, timeoutSignal])
    : timeoutSignal;
  let current = url;
  let method = 'POST';
  let headers = { ...init.headers };
  let body: string | undefined = init.body;
  let hop = 0;
  for (;;) {
    const safety = await checkWebhookUrlSafety(current, {
      lookupHost: opts.lookupHost,
      fetchImpl,
    });
    if (!safety.ok) return { blocked: safety.reason };
    // 同一 hop の分岐対策: 接続の直前にもう一度引き、検査時と1件でも
    // 違えば送らない。差し替えはこの2回の引きの間に収まらないと通らない。
    if (safety.addresses.length > 0) {
      const host = normalizeHostname(current);
      const again = host
        ? await resolveHostAddresses(host, { lookupHost: opts.lookupHost, fetchImpl })
        : null;
      if (!again || !again.ok) return { blocked: 'dns_unresolved' };
      const before = [...safety.addresses].sort().join(',');
      const now = [...again.addresses].sort().join(',');
      if (before !== now) return { blocked: 'dns_changed' };
    }
    const response = await fetchImpl(current, {
      method,
      headers,
      body,
      redirect: 'manual',
      signal,
    });
    if (!REDIRECT_STATUS.has(response.status) || hop >= maxRedirects) return { response };
    const location = response.headers?.get?.('location');
    if (!location) return { response };
    let next: string;
    try {
      next = new URL(location, current).toString();
    } catch {
      return { response };
    }
    if (!sameWebhookOrigin(current, next)) {
      // 本文付きのまま別 origin へは送らない(再署名の材料がここに無いため)。
      if (response.status === 307 || response.status === 308) return { blocked: 'unsafe_redirect' };
      headers = stripCrossOriginHeaders(headers);
    }
    current = next;
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
      method = 'GET';
      body = undefined;
    }
    hop++;
  }
}

export interface DeliveryResult {
  ok: boolean;
  attempts: number;
  lastStatus: number | null;
  /** 最後の応答が 429 で Retry-After を読めたときの指定（ミリ秒。未クランプ）。 */
  retryAfterMs?: number;
  blocked?: boolean;
  blockReason?: WebhookBlockReason | null;
  /** secret を復号できず、署名を付けられないので送らなかった。 */
  secretUnavailable?: boolean;
  /**
   * 最後の試行が応答を受け取る前に切れた（接続失敗・タイムアウト）印。
   * 届いたかどうか分からないため、履歴の理由は「結果不明」にする
   * (d23b )。response_xxx・connection_failed に分類しない。
   */
  outcomeUnknown?: boolean;
}

/**
 * 1件のWebhookへ送る。失敗したら max_retries の回数だけ送り直す。
 *
 * 例外を投げない。呼び出し側は「送れたかどうか」を戻り値で受け取る。
 * 送信の失敗でイベント処理そのものを止めたくないため。
 *
 * 応答別の扱い（決定表。要件26 §6-4。）。
 *
 * | 応答 | 扱い | 次までの待ち |
 * | 2xx | 成功 | 待たない |
 * | 429 | 送り直す。Retry-After があれば8秒以内なら待つ。超過は次回の台帳へ返す | Retry-After／指数待ち |
 * | 5xx | 送り直す | 指数待ち（0.5→1→2→4→8秒） |
 * | タイムアウト（既定10秒）・接続失敗 | 送り直す。lastStatus=null で失敗台帳に残る | 指数待ち |
 * | その他の 4xx | 恒久失敗。残りの回数を使わずに諦める | — |
 * | 安全でない送り先 | 即時停止。送り直さない | — |
 *
 * 送り直しの回数は増やさない（最大5回）。同じ配送IDを付け直すので、
 * 受け手側の二重処理は増えない。無限の即時再送もしない。
 */
export async function deliverWebhook(
  webhook: WebhookRow,
  body: string,
  opts: {
    sleep?: (ms: number) => Promise<void>;
    idempotencyKey?: string;
    fetchImpl?: typeof fetch;
    lookupHost?: WebhookDnsLookup;
    timeoutMs?: number;
    /**
     * secret_encrypted を復号する鍵束。省略すると Worker の bindings
     * (LINE_CREDENTIAL_ENCRYPTION_KEY / LINE_CREDENTIAL_PREVIOUS_KEYS)を読む。
     */
    credentialKeys?: WebhookKeyInput | string;
  } = {},
): Promise<DeliveryResult> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const maxRetries = Math.max(0, Math.min(5, webhook.max_retries ?? 0));

  // イベントIDは冪等キーと同じ値。封筒の id と X-Harness-Event-Id が
  // 一致するので、受け手は1つの値で冪等に捌ける。
  const eventId = opts.idempotencyKey ?? crypto.randomUUID();
  // secret が暗号文で入っている行( 以降の正本)はここで復号する。
  // 呼び出し側に復号を任せると、忘れた経路が黙って署名なしで送ってしまう。
  // 設定済みの secret を読めないときは送らない(fail-open 禁止)。
  let sendSecret: string | null = null;
  if (webhook.secret_encrypted || webhook.secret) {
    try {
      sendSecret = await resolveWebhookSecret(webhook, opts.credentialKeys);
    } catch {
      sendSecret = null;
    }
    if (!sendSecret) {
      logger.error("outgoing_webhook.resolve_secret_failed");
      return { ok: false, attempts: 0, lastStatus: null, secretUnavailable: true };
    }
  }
  const headers = await buildOutgoingWebhookHeaders({ eventId, body, secret: sendSecret });

  let lastStatus: number | null = null;
  let lastRetryAfterMs: number | null = null;
  let waitMs = 0;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) await sleep(waitMs);
    // 送り直しのたびに検査し直す。古い検査結果は使い回さない。
    let outcome: SafePostOutcome;
    try {
      outcome = await postWebhookSafely(webhook.url, { headers, body }, {
        fetchImpl: opts.fetchImpl,
        lookupHost: opts.lookupHost,
        timeoutMs: opts.timeoutMs,
      });
    } catch (err) {
      // 接続そのものの失敗と、打ち切り（タイムアウト）は同じ扱い。
      // 相手が落ちている可能性が高いので送り直す。再試行可能な失敗として
      // lastStatus=null のまま残し、呼び出し側が失敗台帳へ記録する。
      logger.error("outgoing_webhook_delivery.send_request_failed");
      lastStatus = null;
      waitMs = retryDelayMs(attempt);
      continue;
    }
    if ('blocked' in outcome) {
      // 安全でない送り先。送り直しても変わらないのでその場で止める。
      // 呼び出し側が result.ok を見て失敗台帳へ残す(秘密値は渡さない)。
      return { ok: false, attempts: attempt + 1, lastStatus, blocked: true, blockReason: outcome.blocked };
    }
    const res = outcome.response;
    lastStatus = res.status;
    if (res.ok) return { ok: true, attempts: attempt + 1, lastStatus };
    if (!shouldRetryStatus(res.status)) {
      return { ok: false, attempts: attempt + 1, lastStatus };
    }
    // 429 のときは相手の Retry-After を上限付きで尊重する。
    // それ以外（5xx）の送り直しは従来どおり指数待ち。
    const retryAfterHeader = res.status === 429
      ? res.headers?.get?.('retry-after') ?? null
      : null;
    lastRetryAfterMs = retryAfterHeader === null
      ? null
      : parseRetryAfterDelayMs(retryAfterHeader, Date.now());
    if (lastRetryAfterMs !== null && lastRetryAfterMs > WEBHOOK_RETRY_AFTER_MAX_MS) {
      return { ok: false, attempts: attempt + 1, lastStatus, retryAfterMs: lastRetryAfterMs };
    }
    waitMs = retryAfterHeader === null
      ? retryDelayMs(attempt)
      : retryAfterDelayMs(retryAfterHeader, retryDelayMs(attempt));
  }
  return {
    ok: false, attempts: maxRetries + 1, lastStatus,
    retryAfterMs: lastRetryAfterMs ?? undefined,
    outcomeUnknown: lastStatus === null,
  };
}

/**
 * 壊れた宛先へ送り続けないよう、要件26 §6-4 の連続失敗上限で一度だけ is_active を落とし、通知センターへ記録する。
 * 手動停止と区別する auto_stopped_at は、運用者の再有効化時に消す。
 */
export const OUTGOING_WEBHOOK_AUTO_STOP_FAILURES = 5;

/**
 * 配送の結果を記録する。
 *
 * 呼ぶのは配送が終わったとき（届いた／恒久失敗）だけ。再送待ち
 * (retry_wait) の途中経過では呼ばない。連続失敗は「配送単位」で数え、
 * 1件の配送が内部で何試行しても 1 だけ動く。
 *
 * 連続失敗が閾値に達したら送信Webhookを自動で止め、通知センターへ
 * 1件残す。止める UPDATE は `is_active = 1` の行だけに効くので、
 * 同時に失敗が重なっても通知は1回だけ出る（遷移した側だけが続く）。
 */
export async function recordDeliveryOutcome(
  db: D1Database,
  webhookId: string,
  ok: boolean,
): Promise<void> {
  if (ok) {
    await db
      .prepare(
        `UPDATE outgoing_webhooks
            SET consecutive_failures = 0, last_failed_at = NULL, confirmation_revision = confirmation_revision + 1
          WHERE id = ? AND consecutive_failures != 0 AND deleted_at IS NULL`,
      )
      .bind(webhookId)
      .run();
    return;
  }
  // d23b : 成功で0に戻ったあと、過去の失敗が遅れて確定した場合でも
  // 数を信じられるよう、履歴の実数（最後の成功以降の失敗件数）から
  // 数え直す。履歴が1件も無い送り先だけは従来どおり +1 で進める。
  await db
    .prepare(
      `UPDATE outgoing_webhooks
          SET confirmation_revision = confirmation_revision + 1, consecutive_failures = CASE
            WHEN EXISTS (
              SELECT 1 FROM webhook_interaction_logs l
               WHERE l.webhook_id = outgoing_webhooks.id AND l.direction = 'outgoing'
            ) THEN (
              SELECT COUNT(*) FROM webhook_interaction_logs l
               WHERE l.webhook_id = outgoing_webhooks.id
                 AND l.direction = 'outgoing' AND l.status = 'failed'
                 AND l.created_at > COALESCE((
                   SELECT MAX(s.created_at) FROM webhook_interaction_logs s
                    WHERE s.webhook_id = outgoing_webhooks.id
                      AND s.direction = 'outgoing' AND s.status = 'succeeded'
                 ), '')
            )
            ELSE consecutive_failures + 1
          END,
              last_failed_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')
        WHERE id = ? AND deleted_at IS NULL`,
    )
    .bind(webhookId)
    .run();
  const stopped = await db
    .prepare(
      `UPDATE outgoing_webhooks
          SET is_active = 0, confirmation_revision = confirmation_revision + 1,
              auto_stopped_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')
        WHERE id = ? AND is_active = 1
          AND consecutive_failures >= ?`,
    )
    .bind(webhookId, OUTGOING_WEBHOOK_AUTO_STOP_FAILURES)
    .run();
  if (Number(stopped.meta?.changes ?? 0) !== 1) return;
  const webhook = await db
    .prepare(`SELECT name, line_account_id FROM outgoing_webhooks WHERE id = ?`)
    .bind(webhookId)
    .first<{ name: string; line_account_id: string | null }>();
  try {
    await createNotification(db, {
      eventType: 'outgoing_webhook_auto_stopped',
      title: '送信Webhookを自動で止めました',
      body:
        `「${webhook?.name ?? webhookId}」への送信が${OUTGOING_WEBHOOK_AUTO_STOP_FAILURES}件続けて失敗したため、自動で止めました。` +
        '連携先の状態を確認して、問題なければ管理画面から再有効化してください。',
      channel: 'dashboard',
      category: 'error',
      lineAccountId: webhook?.line_account_id ?? null,
      metadata: JSON.stringify({ webhookId, consecutiveFailures: OUTGOING_WEBHOOK_AUTO_STOP_FAILURES }),
    });
  } catch (error) {
    // 通知の書き込みだけが落ちても、自動停止そのものは巻き戻さない。
    logger.error("outgoing_webhook_delivery.notify_auto_stop_failed");
  }
}

// ============================================================
// durable outbox（ /。要件26 §6-4）
// ============================================================
//
// これまではイベント発生のたびに deliverWebhook がその場で fetch を
// 逐次に投げ、送り直しもリクエスト内の数秒 sleep だけだった。
// Worker が途中で止まれば送り残しを誰も拾わず、相手が長時間落ちて
// いれば数秒待ちの再送では追いつかない。
//
// ここから下は「台帳へ先に積んでから送る」配送口である。
//   enqueueOutgoingWebhookDelivery … 台帳へ積む。冪等キーの UNIQUE で
//                                    イベント再発火・cron 再実行の
//                                    二重配送を作らない。
//   claimOutgoingDelivery           … 楽観ロックで1件だけ取り掛かる。
//   deliverOnce                      … 1回だけ送る。再送は Worker 内で
//                                    sleep せず next_retry_at へ積む。
//   finishOutgoingDelivery          … 結果で行を確定する。
//   sweepOutgoingWebhookDeliveries  … 送り残しを回収する cron 側。
//
// 配送は at-least-once。受け手は X-Harness-Event-Id で冪等に捌く前提。

/** 接続ごとの再送上限（再送回数）。合計試行は最大8回（要件26 §6-4）。 */
export const OUTGOING_WEBHOOK_MAX_RESENDS = 7;
/** 初回を含む試行の絶対上限。 */
export const OUTGOING_WEBHOOK_MAX_ATTEMPTS = OUTGOING_WEBHOOK_MAX_RESENDS + 1;
/** 積んだ時点から再送を続ける期間（要件26 §6-4 の24時間）。 */
export const OUTGOING_WEBHOOK_RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;
/**
 * 再送の待ち時間（分）。指数で増やし、要件の上限（8回・24時間）に収める。
 * 合計は約15.6時間なので、8試行すべて失敗しても窓内に収まる。
 */
const OUTGOING_WEBHOOK_RETRY_DELAYS_MINUTES = [1, 5, 30, 60, 120, 240, 480] as const;
/** 取り掛かったまま止まった行を見放すまでの猶予（分）。 */
const OUTGOING_DELIVERY_LEASE_MINUTES = 5;
/** cron の1回で回収する配送行の上限。sweepOperatorNotifications と同じ根拠。 */
export const OUTGOING_WEBHOOK_SWEEP_LIMIT = 100;

export interface OutgoingDeliveryRow {
  id: string;
  line_account_id: string;
  webhook_id: string;
  event_type: string;
  body_json: string;
  idempotency_key: string;
  status: 'pending' | 'sending' | 'retry_wait' | 'delivered' | 'failed';
  attempts: number;
  max_attempts: number;
  next_retry_at: string | null;
  lease_token: string | null;
  lease_until: string | null;
  last_response_status: number | null;
  error_code: string | null;
  error_message_safe: string | null;
  queued_at: string;
  delivered_at: string | null;
  failed_at: string | null;
  updated_at: string;
}

/** 1配送あたりの試行上限。max_retries（再送回数）から決める。 */
export function outgoingDeliveryMaxAttempts(maxRetries: number | null | undefined): number {
  const resends = Math.max(0, Math.min(OUTGOING_WEBHOOK_MAX_RESENDS, Math.floor(maxRetries ?? 0)));
  return 1 + resends;
}

/** 配送IDから決定的な揺らぎ（±10%）を作る。全員が同じ分に殺到するのを避ける。 */
function deliveryJitterRatio(key: string): number {
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return ((hash % 21) - 10) / 100;
}

/**
 * 次の再送時刻を決める。上限・24時間の窓を超えるなら null（=諦める）。
 *
 * 429 で Retry-After をもらったときは、その指定を30分上限で尊重する。
 * 上限を超える指定では自動再送を止め、相手の指定より早く送らない。
 * それ以外は指数バックオフ＋配送ID由来の jitter。
 */
export function outgoingDeliveryNextRetryAt(input: {
  attemptsDone: number;
  maxAttempts: number;
  queuedAt: string;
  now: Date;
  responseStatus: number | null;
  retryAfterMs?: number | null;
  jitterKey: string;
}): Date | null {
  if (input.attemptsDone >= input.maxAttempts) return null;
  const nowMs = input.now.getTime();
  const deadline = Date.parse(input.queuedAt) + OUTGOING_WEBHOOK_RETRY_WINDOW_MS;
  let waitMs: number;
  if (input.responseStatus === 429 && typeof input.retryAfterMs === 'number' && input.retryAfterMs >= 0) {
    if (input.retryAfterMs > EXTERNAL_DELIVERY_RETRY_AFTER_MAX_MINUTES * 60_000) return null;
    waitMs = input.retryAfterMs;
  } else {
    const index = Math.min(
      Math.max(0, input.attemptsDone - 1),
      OUTGOING_WEBHOOK_RETRY_DELAYS_MINUTES.length - 1,
    );
    const base = OUTGOING_WEBHOOK_RETRY_DELAYS_MINUTES[index]! * 60_000;
    waitMs = Math.max(0, Math.round(base * (1 + deliveryJitterRatio(input.jitterKey))));
  }
  const at = nowMs + waitMs;
  if (at > deadline) return null;
  return new Date(at);
}

/**
 * 台帳へ配送を積む。(webhook_id, idempotency_key) の UNIQUE で
 * 同じ出来事の再発火・並行実行が二重に積まない。すでにあれば null。
 */
export async function enqueueOutgoingWebhookDelivery(
  db: D1Database,
  input: {
    lineAccountId: string;
    webhookId: string;
    eventType: string;
    body: string;
    idempotencyKey: string;
    maxAttempts: number;
    now?: Date;
  },
): Promise<OutgoingDeliveryRow | null> {
  const now = (input.now ?? new Date()).toISOString();
  const id = crypto.randomUUID();
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO outgoing_webhook_deliveries
         (id, line_account_id, webhook_id, event_type, body_json, idempotency_key,
          status, attempts, max_attempts, queued_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
    )
    .bind(
      id, input.lineAccountId, input.webhookId, input.eventType, input.body,
      input.idempotencyKey, Math.max(1, input.maxAttempts), now, now,
    )
    .run();
  if (Number(result.meta?.changes ?? 1) !== 1) return null;
  return {
    id,
    line_account_id: input.lineAccountId,
    webhook_id: input.webhookId,
    event_type: input.eventType,
    body_json: input.body,
    idempotency_key: input.idempotencyKey,
    status: 'pending',
    attempts: 0,
    max_attempts: Math.max(1, input.maxAttempts),
    next_retry_at: null,
    lease_token: null,
    lease_until: null,
    last_response_status: null,
    error_code: null,
    error_message_safe: null,
    queued_at: now,
    delivered_at: null,
    failed_at: null,
    updated_at: now,
  };
}

/**
 * 配送行を1件だけ取り掛かる。取れたら lease token を返す。
 * status・attempts・updated_at の同時一致で、別の実行が触った行は掴まない。
 * sending の行は lease が切れているものだけ取り直せる。
 */
export async function claimOutgoingDelivery(
  db: D1Database,
  delivery: Pick<OutgoingDeliveryRow, 'id' | 'status' | 'attempts' | 'updated_at'>,
  now: Date = new Date(),
): Promise<string | null> {
  const leaseToken = `lease:${crypto.randomUUID()}`;
  const leaseUntil = new Date(now.getTime() + OUTGOING_DELIVERY_LEASE_MINUTES * 60_000).toISOString();
  const nowIso = now.toISOString();
  const result = await db
    .prepare(
      `UPDATE outgoing_webhook_deliveries
          SET status = 'sending', lease_token = ?, lease_until = ?, updated_at = ?
        WHERE id = ? AND status = ? AND attempts = ? AND updated_at = ?
          AND (lease_until IS NULL OR lease_until <= ?)
          AND (next_retry_at IS NULL OR julianday(next_retry_at) <= julianday(?))
          AND NOT (COALESCE(error_code,'')='retry_after_exceeds_budget' AND next_retry_at IS NULL)`,
    )
    .bind(leaseToken, leaseUntil, nowIso, delivery.id, delivery.status, delivery.attempts, delivery.updated_at, nowIso, nowIso)
    .run();
  return Number(result.meta?.changes ?? 1) === 1 ? leaseToken : null;
}

/**
 * claim 後・送信前に緊急停止  へ切り替わった配送を、送る前の状態へ
 * 戻す。'sending' だった行は lease が切れていた分なので pending へ戻す
 * (sending + lease 無しのまま残すと sweep の条件から外れて滞留する)。
 */
export async function releaseOutgoingDelivery(
  db: D1Database,
  delivery: Pick<OutgoingDeliveryRow, 'id' | 'status'>,
  leaseToken: string,
  now: Date = new Date(),
): Promise<void> {
  const restoreStatus = delivery.status === 'sending' ? 'pending' : delivery.status;
  await db
    .prepare(
      `UPDATE outgoing_webhook_deliveries
          SET status = ?, lease_token = NULL, lease_until = NULL, updated_at = ?
        WHERE id = ? AND lease_token = ? AND status = 'sending'`,
    )
    .bind(restoreStatus, now.toISOString(), delivery.id, leaseToken)
    .run();
}

export type OutgoingAttemptFinish =
  | { kind: 'delivered'; responseStatus: number }
  | {
      kind: 'retry';
      responseStatus: number | null;
      retryAfterMs?: number | null;
      errorCode: string;
      errorMessage: string;
    }
  | {
      kind: 'failed';
      responseStatus: number | null;
      errorCode: string;
      errorMessage: string;
    };

const OUTGOING_DELIVERY_FAILURE_TEXT: Record<string, string> = {
  unsafe_url: '送り先のURLが安全でないため送信を止めました。設定を確認してください。',
  secret_unavailable: '署名に使うsecretを確認できませんでした。設定を保存し直してください。',
  rejected_4xx: '送り先が内容を受け取りませんでした。URLと受け手の設定を確認してください。',
  retry_exhausted: '自動での送り直しが上限に達しました。連携先を確認して、必要なら管理画面から再送してください。',
  retry_after_exceeds_budget: '連携先の待ち時間が自動再送の上限を超えました。連携先を確認して、必要なら管理画面から再送してください。',
  retry_window_expired: '24時間の再送期間を過ぎました。連携先を確認して、必要なら管理画面から再送してください。',
  webhook_not_found: '送信Webhookが削除されたため送りませんでした。',
  webhook_inactive: '送信Webhookが停止中のため送りませんでした。',
  connection_failed: 'つなぎ先から返事がありませんでした。',
  response_5xx: 'つなぎ先で処理できませんでした。',
  response_429: 'つなぎ先が混み合っていました。',
  response_425: 'つなぎ先がまだ受け取れる状態ではありませんでした。',
};

export function outgoingDeliverySafeMessage(code: string): string {
  return OUTGOING_DELIVERY_FAILURE_TEXT[code] ?? '送信に失敗しました。設定と連携先を確認してください。';
}

/** deliverWebhook の結果を台帳の試行結果へ写す。応答本文や秘密値は入れない。 */
export function outgoingAttemptOf(result: DeliveryResult): OutgoingAttemptFinish {
  if (result.ok) return { kind: 'delivered', responseStatus: result.lastStatus ?? 200 };
  if (result.blocked) {
    return {
      kind: 'failed', responseStatus: result.lastStatus,
      errorCode: 'unsafe_url', errorMessage: outgoingDeliverySafeMessage('unsafe_url'),
    };
  }
  if (result.secretUnavailable) {
    return {
      kind: 'failed', responseStatus: null,
      errorCode: 'secret_unavailable', errorMessage: outgoingDeliverySafeMessage('secret_unavailable'),
    };
  }
  const status = result.lastStatus;
  if (status !== null && !shouldRetryStatus(status)) {
    return {
      kind: 'failed', responseStatus: status,
      errorCode: 'rejected_4xx', errorMessage: outgoingDeliverySafeMessage('rejected_4xx'),
    };
  }
  const code = status === null ? 'connection_failed'
    : status === 429 ? 'response_429'
    : status === 425 ? 'response_425'
    : 'response_5xx';
  return {
    kind: 'retry', responseStatus: status,
    retryAfterMs: result.retryAfterMs ?? null,
    errorCode: code, errorMessage: outgoingDeliverySafeMessage(code),
  };
}

/**
 * 試行結果で配送行を確定する。retry は上限・窓内なら retry_wait、
 * 超えたら failed。lease token が合わない行（別の実行が確定済み）は
 * 'lost' を返し、何も書かない。
 */
export async function finishOutgoingDelivery(
  db: D1Database,
  delivery: Pick<OutgoingDeliveryRow, 'id' | 'attempts' | 'max_attempts' | 'queued_at' | 'idempotency_key'>,
  leaseToken: string,
  attempt: OutgoingAttemptFinish,
  now: Date = new Date(),
): Promise<'delivered' | 'retry_wait' | 'failed' | 'lost'> {
  const nowIso = now.toISOString();
  const attemptsDone = delivery.attempts + 1;
  let status: 'delivered' | 'retry_wait' | 'failed';
  let nextRetryAt: string | null = null;
  let errorCode: string | null = null;
  let errorMessage: string | null = null;
  let responseStatus: number | null = null;
  if (attempt.kind === 'delivered') {
    status = 'delivered';
    responseStatus = attempt.responseStatus;
  } else if (attempt.kind === 'failed') {
    status = 'failed';
    responseStatus = attempt.responseStatus;
    errorCode = attempt.errorCode;
    errorMessage = attempt.errorMessage;
  } else {
    const retryAt = outgoingDeliveryNextRetryAt({
      attemptsDone,
      maxAttempts: delivery.max_attempts,
      queuedAt: delivery.queued_at,
      now,
      responseStatus: attempt.responseStatus,
      retryAfterMs: attempt.retryAfterMs,
      jitterKey: `${delivery.id}:${attemptsDone}`,
    });
    responseStatus = attempt.responseStatus;
    if (retryAt === null) {
      status = 'failed';
      const overWait=attempt.responseStatus===429&&typeof attempt.retryAfterMs==='number'
        &&attempt.retryAfterMs>EXTERNAL_DELIVERY_RETRY_AFTER_MAX_MINUTES*60_000;
      errorCode = overWait?'retry_after_exceeds_budget':attemptsDone>=delivery.max_attempts?'retry_exhausted':'retry_window_expired';
      if(attempt.responseStatus===429&&typeof attempt.retryAfterMs==='number'&&attempt.retryAfterMs>=0){
        const notBefore=new Date(now.getTime()+attempt.retryAfterMs);
        if(Number.isFinite(notBefore.getTime()))nextRetryAt=notBefore.toISOString();
      }
      errorMessage = outgoingDeliverySafeMessage(errorCode);
    } else {
      status = 'retry_wait';
      nextRetryAt = retryAt.toISOString();
      errorCode = attempt.errorCode;
      errorMessage = attempt.errorMessage;
    }
  }
  const updated = await db
    .prepare(
      `UPDATE outgoing_webhook_deliveries
          SET status = ?, attempts = ?, next_retry_at = ?,
              lease_token = NULL, lease_until = NULL,
              last_response_status = ?, error_code = ?, error_message_safe = ?,
              delivered_at = CASE WHEN ? = 'delivered' THEN ? ELSE delivered_at END,
              failed_at = CASE WHEN ? = 'failed' THEN ? ELSE failed_at END,
              updated_at = ?
        WHERE id = ? AND lease_token = ? AND status = 'sending'`,
    )
    .bind(
      status, attemptsDone, nextRetryAt,
      responseStatus, errorCode, errorMessage,
      status, nowIso, status, nowIso, nowIso,
      delivery.id, leaseToken,
    )
    .run();
  if (Number(updated.meta?.changes ?? 1) !== 1) return 'lost';
  return status;
}

/** outbox の1試行。Worker 内 sleep の再送はせず、1回だけ送って終わる。 */
export function deliverOnce(
  webhook: WebhookRow,
  body: string,
  opts: Parameters<typeof deliverWebhook>[2] = {},
): Promise<DeliveryResult> {
  return deliverWebhook({ ...webhook, max_retries: 0 }, body, opts);
}

/** 全配送経路で同じ理由を残すため、結果を履歴用の固定分類へまとめる。秘密値なし・送達不明・危険な送信先・一時混雑・相手の一時失敗・恒久4xxを区別する。 */
export function failureReasonForDelivery(result: DeliveryResult): WebhookInteractionFailureReason {
  if (result.secretUnavailable) return 'secret_unavailable';
  if (result.blocked) return 'processing_failed';
  if (result.outcomeUnknown) return 'unknown';
  const status = result.lastStatus;
  if (status === null) return 'connection_failed';
  if (status === 429) return 'response_429';
  if (status >= 500) return 'response_5xx';
  if (status >= 400) return 'response_4xx';
  return 'unknown';
}

/** 同じ通知の自動配送台帳の行を引く（d23b  の手動↔自動の照合に使う）。 */
export async function findOutgoingDeliveryByKey(
  db: D1Database,
  webhookId: string,
  idempotencyKey: string,
): Promise<OutgoingDeliveryRow | null> {
  return db.prepare(
    `SELECT * FROM outgoing_webhook_deliveries WHERE webhook_id = ? AND idempotency_key = ?`,
  ).bind(webhookId, idempotencyKey).first<OutgoingDeliveryRow>();
}

/**
 * 回収した試行も「やり取りの記録」へ残す。初回はイベント側が書き、
 * 再送はここが書く。同じ冪等キーなので画面でつながりが見える。
 * 記録の失敗で配送を巻き戻さない。
 */
async function logSweptDeliveryAttempt(
  db: D1Database,
  row: OutgoingDeliveryRow,
  webhookName: string,
  sendResult: DeliveryResult,
  durationMs: number,
): Promise<void> {
  try {
    const interaction = await createWebhookInteraction(db, {
      lineAccountId: row.line_account_id,
      direction: 'outgoing',
      webhookId: row.webhook_id,
      webhookName,
      eventType: row.event_type,
      triggerSummary: row.event_type,
      requestBodyJson: row.body_json,
      idempotencyKey: row.idempotency_key,
    });
    await finishWebhookInteraction(db, interaction.id, row.line_account_id, {
      status: sendResult.ok ? 'succeeded' : 'failed',
      responseStatus: sendResult.lastStatus,
      attemptCount: sendResult.attempts,
      durationMs,
      failureReason: sendResult.ok ? null : failureReasonForDelivery(sendResult),
    });
  } catch (error) {
    logger.error("outgoing_webhook_delivery.record_interaction_failed");
  }
}

export type OutgoingSweepResult = {
  swept: number;
  delivered: number;
  failed: number;
  retryWait: number;
  skipped: number;
};

/**
 * 送り残しの回収（delivery レーンの cron から呼ぶ）。
 *
 * 拾うのは:
 *   - pending で猶予を過ぎた行（積んでから送る前に止まった分）
 *   - sending で lease が切れた行（送る途中で止まった分）
 *   - retry_wait で再送時刻を過ぎた行
 * を楽観ロックで1件ずつ引き取り、同じ冪等キーで送り直す。
 */
export async function sweepOutgoingWebhookDeliveries(
  db: D1Database,
  input: {
    limit?: number;
    now?: Date;
    fetchImpl?: typeof fetch;
    lookupHost?: WebhookDnsLookup;
    credentialKeys?: WebhookKeyInput | string;
  } = {},
): Promise<OutgoingSweepResult> {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const stuckBefore = new Date(now.getTime() - OUTGOING_DELIVERY_LEASE_MINUTES * 60_000).toISOString();
  const limit = Math.max(1, Math.min(input.limit ?? OUTGOING_WEBHOOK_SWEEP_LIMIT, 100));
  await db.prepare(
    `UPDATE outgoing_webhook_deliveries
        SET status='failed', lease_token=NULL, lease_until=NULL,
            next_retry_at=NULL, error_code='tenant_suspended',
            error_message_safe='契約先が停止中のため送信しませんでした。',
            failed_at=?, updated_at=?
      WHERE (
        (status='pending' AND queued_at <= ?)
        OR (status='sending' AND lease_until IS NOT NULL AND lease_until <= ?)
        OR (status='retry_wait' AND next_retry_at <= ?)
      )
        AND ${stoppedTenantLineAccountSql('outgoing_webhook_deliveries.line_account_id')}`,
  ).bind(nowIso, nowIso, stuckBefore, nowIso, nowIso).run();
  const rows = await db
    .prepare(
      `SELECT * FROM outgoing_webhook_deliveries
        WHERE ((status = 'pending' AND queued_at <= ?)
           OR (status = 'sending' AND lease_until IS NOT NULL AND lease_until <= ?)
           OR (status = 'retry_wait' AND next_retry_at <= ?))
          AND ${activeTenantLineAccountSql('outgoing_webhook_deliveries.line_account_id')}
        ORDER BY queued_at, id
        LIMIT ?`,
    )
    .bind(stuckBefore, nowIso, nowIso, limit)
    .all<OutgoingDeliveryRow>();

  const result: OutgoingSweepResult = { swept: 0, delivered: 0, failed: 0, retryWait: 0, skipped: 0 };
  for (const row of rows.results ?? []) {
    // 緊急停止 : webhook_outgoing が止まっている統括は claim せず
    // pending / retry_wait のまま残す。復旧後の sweep が拾う。
    if (await isOperationCapabilityStopped(db, row.line_account_id, 'webhook_outgoing')) {
      result.skipped += 1;
      continue;
    }
    const lease = await claimOutgoingDelivery(db, row, now);
    if (!lease) {
      result.skipped += 1;
      continue;
    }
    // claim と送信のあいだに停止へ切り替わった分は、lease を外して
    // 送る前の状態へ戻す。停止を配信失敗として数えない。
    if (await isOperationCapabilityStopped(db, row.line_account_id, 'webhook_outgoing')) {
      await releaseOutgoingDelivery(db, row, lease, now);
      result.skipped += 1;
      continue;
    }
    result.swept += 1;
    const webhook = await db
      // #939 N-368: 削除は履歴を残す印。印のある送り先は「無い」として
      // 滞留分を webhook_not_found で閉じる。
      .prepare(`SELECT * FROM outgoing_webhooks WHERE id = ? AND line_account_id = ? AND deleted_at IS NULL`)
      .bind(row.webhook_id, row.line_account_id)
      .first<WebhookRow & { is_active: number; name: string }>();
    const started = Date.now();
    let attempt: OutgoingAttemptFinish;
    let sendResult: DeliveryResult | null = null;
    if (!webhook) {
      attempt = {
        kind: 'failed', responseStatus: null,
        errorCode: 'webhook_not_found', errorMessage: outgoingDeliverySafeMessage('webhook_not_found'),
      };
    } else if (!webhook.is_active) {
      // 自動停止・手動停止のどちらでも、止まっている送り先へは出さない。
      attempt = {
        kind: 'failed', responseStatus: null,
        errorCode: 'webhook_inactive', errorMessage: outgoingDeliverySafeMessage('webhook_inactive'),
      };
    } else if (await hasSucceededInteractionForKey(db, row.line_account_id, row.webhook_id, row.idempotency_key)) {
      // d23b : 手動のやり直し（または別経路）で同じ通知がすでに届いて
      // いる。自動配送は新たに送らず、台帳を「届いた」で閉じる。
      attempt = {
        kind: 'delivered', responseStatus: row.last_response_status ?? 200,
      };
    } else {
      sendResult = await deliverOnce(webhook, row.body_json, {
        idempotencyKey: row.idempotency_key,
        fetchImpl: input.fetchImpl,
        lookupHost: input.lookupHost,
        credentialKeys: input.credentialKeys,
      });
      attempt = outgoingAttemptOf(sendResult);
      await logSweptDeliveryAttempt(db, row, webhook.name, sendResult, Date.now() - started);
    }
    // Retry-After の秒数は巡回開始でなく、応答到着から数える。
    const outcome = await finishOutgoingDelivery(db, row, lease, attempt, input.now ?? new Date());
    if (outcome === 'delivered') {
      result.delivered += 1;
      try {
        await recordDeliveryOutcome(db, row.webhook_id, true);
      } catch (error) {
        logger.error("outgoing_webhook_delivery.record_delivery_outcome_failed");
      }
      // d23b : 届いた通知と同じ失敗記録が残っていれば畳む。
      // 「やり直せる」のまま残すと届いた分をもう一度送らせてしまう。
      try {
        await markFailedInteractionsRetried(
          db, row.line_account_id, row.webhook_id, row.idempotency_key,
        );
      } catch (error) {
        logger.error("outgoing_webhook_delivery.mark_interactions_retried_failed");
      }
    } else if (outcome === 'failed') {
      result.failed += 1;
      try {
        await recordDeliveryOutcome(db, row.webhook_id, false);
      } catch (error) {
        logger.error("outgoing_webhook_delivery.record_delivery_outcome_failed");
      }
    } else if (outcome === 'retry_wait') {
      result.retryWait += 1;
    } else {
      result.skipped += 1;
    }
  }
  return result;
}
