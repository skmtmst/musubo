/**
 * デリバリー連携の「通知を受け取るときの関門」だけを切り出した層。
 *
 * - 合言葉（webhook secret）の読み取りと、送信元IPの許可リストの読み取り・照合。
 * - DBも fetch も触らない。設定（env）と文字列だけを見る。
 * - 受け口（routes/restaurant-delivery.ts）はここを本文を読む前に通す。
 */
import type { DeliveryService } from './delivery-service-types.js';

/** 受け口の関門に必要な設定だけ。DeliveryEnv がこれを引き継ぐ。 */
export interface DeliveryWebhookEnv {
  RT_DELIVERY_UBEREATS_WEBHOOK_SECRET?: string;
  RT_DELIVERY_DEMAECAN_WEBHOOK_SECRET?: string;
  RT_DELIVERY_ROCKETNOW_WEBHOOK_SECRET?: string;
  /**
   * 通知を受け取る送信元IPの許可リスト（出前館QA#7）。
   * カンマ区切りで、1件ずつのIPか IPv4 の CIDR（例 203.0.113.0/24）を書く。
   * サービスごとの指定が無いときは共通の値を使う。どちらも空なら制限しない
   * （いまの動きを変えない。相手のIPが分かってから入れる運用にする）。
   */
  RT_DELIVERY_WEBHOOK_IP_ALLOWLIST?: string;
  RT_DELIVERY_UBEREATS_WEBHOOK_IP_ALLOWLIST?: string;
  RT_DELIVERY_DEMAECAN_WEBHOOK_IP_ALLOWLIST?: string;
  RT_DELIVERY_ROCKETNOW_WEBHOOK_IP_ALLOWLIST?: string;
}

export function deliveryWebhookSecret(
  env: DeliveryWebhookEnv,
  service: DeliveryService,
): string | null {
  const raw =
    service === 'ubereats'
      ? env.RT_DELIVERY_UBEREATS_WEBHOOK_SECRET
      : service === 'demaecan'
        ? env.RT_DELIVERY_DEMAECAN_WEBHOOK_SECRET
        : env.RT_DELIVERY_ROCKETNOW_WEBHOOK_SECRET;
  const secret = raw?.trim() ?? '';
  // 鍵の強度を保つため、32文字未満は受け付けない（ec-integrations.ts と同じ下限）。
  return secret.length >= 32 ? secret : null;
}

/**
 * 通知を受け取っていい送信元IPの一覧（出前館QA#7）。
 * サービスごとの指定が先。無ければ共通。どちらも空なら null＝制限しない。
 */
export function deliveryWebhookIpAllowlist(
  env: DeliveryWebhookEnv,
  service: DeliveryService,
): string[] | null {
  const perService =
    service === 'ubereats'
      ? env.RT_DELIVERY_UBEREATS_WEBHOOK_IP_ALLOWLIST
      : service === 'demaecan'
        ? env.RT_DELIVERY_DEMAECAN_WEBHOOK_IP_ALLOWLIST
        : env.RT_DELIVERY_ROCKETNOW_WEBHOOK_IP_ALLOWLIST;
  const raw = (perService?.trim() || env.RT_DELIVERY_WEBHOOK_IP_ALLOWLIST?.trim()) ?? '';
  if (!raw) return null;
  const entries = raw
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  // 書き間違いで空だけが並んだときは「制限なし」ではなく「誰も通さない」にはしない。
  // 意図が読めない空の設定では、受信がすべて止まらないよう制限なしにする。
  return entries.length > 0 ? entries : null;
}

function ipv4ToNumber(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    // 「01」のような0埋めや空欄は受け取らない。別のIPと取り違える元になる。
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

/**
 * 送信元IPが許可リストに入っているか。
 * 1件ずつのIP（IPv4・IPv6）は文字列の一致、IPv4 の CIDR は範囲で見る。
 * IPv6 の範囲指定は扱わない（入っていればその行だけ無視する）。
 */
export function isDeliveryWebhookIpAllowed(ip: string, allowlist: string[] | null): boolean {
  if (allowlist === null) return true;
  const target = ip.trim().toLowerCase();
  if (!target) return false;
  const targetNumber = ipv4ToNumber(target);
  for (const entry of allowlist) {
    if (entry === target) return true;
    const slash = entry.indexOf('/');
    if (slash === -1) continue;
    const network = ipv4ToNumber(entry.slice(0, slash));
    const bits = Number(entry.slice(slash + 1));
    if (network === null || targetNumber === null) continue;
    if (!Number.isInteger(bits) || bits < 0 || bits > 32) continue;
    // /0 は全許可。シフト演算では 32 ビット幅を超えて意図しない値になるため分ける。
    if (bits === 0) return true;
    const mask = (0xffffffff << (32 - bits)) >>> 0;
    if (((targetNumber >>> 0) & mask) === ((network >>> 0) & mask)) return true;
  }
  return false;
}

/**
 * 受け口から渡された見出しから送信元IPを取り出す。
 * Cloudflare の cf-connecting-ip が最も信頼できる。無いときだけ代わりの見出しを見る。
 */
export function webhookSourceIp(headers: {
  cfConnectingIp?: string | null;
  forwardedFor?: string | null;
  realIp?: string | null;
}): string {
  return (
    headers.cfConnectingIp ||
    headers.forwardedFor?.split(',')[0]?.trim() ||
    headers.realIp ||
    ''
  );
}
