import { tracedFetch as fetch } from '@line-crm/shared/server';
/**
 * 予約配信を送る直前に、残りの送信枠を確かめる。
 *
 * 設計 `Bw0zt`（6-1-E 送信設定）の注意書きは
 * 「**予約時刻の直前に対象人数と送信枠を再確認します。**」と約束している。
 * 対象人数は `processSegmentSend` が送信時に数え直していたが、
 * **送信枠は誰も見ていなかった。**
 *
 * 予約したあとに枠を使い切ると、**予約は実行されるが途中で失敗する。**
 * 送った人と送れなかった人が混ざり、運用者は結果を見るまで気づけない。
 * 足りないと分かった時点で送らないほうが、あとから追いかけやすい。
 *
 * **上限を指定しない配信は、取れないときは止めない。** LINE の口が落ちているだけで予約を潰すと、
 * 送れるはずの配信が届かなくなる。分からないものは分からないと記録して
 * 通す（`state: 'unknown'`）。
 */

export type QuotaCheck =
  | { state: 'ok'; limit: number; used: number; remaining: number }
  | { state: 'short'; limit: number; used: number; remaining: number; shortfall: number }
  /** 上限が無い（無制限）か、口が答えなかった。**止める理由にしない。** */
  | { state: 'unknown'; reason: string };

type QuotaFetch = {
  /** `GET /v2/bot/message/quota` */
  limit: number | null;
  /** `GET /v2/bot/message/quota/consumption` */
  used: number | null;
};

/**
 * 残りの枠と、これから送る通数を突き合わせる。
 *
 * **1人につき1回分で数える。** 1つの送信リクエストに吹き出しが
 * 複数あっても重ねて数えず、送る宛先の人数を渡す。
 */
export function evaluateQuota(fetched: QuotaFetch, planned: number): QuotaCheck {
  if (fetched.limit === null) {
    return { state: 'unknown', reason: '送信枠の上限を取得できませんでした' };
  }
  if (fetched.used === null) {
    return { state: 'unknown', reason: '今月の送信数を取得できませんでした' };
  }
  const remaining = Math.max(0, fetched.limit - fetched.used);
  if (planned > remaining) {
    return {
      state: 'short',
      limit: fetched.limit,
      used: fetched.used,
      remaining,
      shortfall: planned - remaining,
    };
  }
  return { state: 'ok', limit: fetched.limit, used: fetched.used, remaining };
}

/**
 * 足りないときに運用者へ出す文。
 *
 * **内部の語も番号も出さない。** 何通足りないか、次に何をすればよいかを書く。
 */
export function shortfallMessage(check: Extract<QuotaCheck, { state: 'short' }>, planned: number): string {
  return (
    `送ろうとした ${planned.toLocaleString('ja-JP')}通 に対して、`
    + `今月の残りが ${check.remaining.toLocaleString('ja-JP')}通 しかありません`
    + `（${check.shortfall.toLocaleString('ja-JP')}通 足りません）。`
    + 'この配信は送らずに下書きへ戻しました。'
    + '送る相手を減らすか、来月に予約し直してください。'
  )
}

export type QuotaFailure = { endpoint: 'quota' | 'consumption'; code: 'not_connected' | 'authentication' | 'rate_limit' | 'unavailable' | 'invalid_response' };
export type QuotaDetails = QuotaFetch & { unlimited: boolean; failures: QuotaFailure[]; reason: string | null };

/** 外部の応答本文や秘密値を残さず、接続設定で直せる失敗を区別する。 */
export async function fetchQuotaDetails(channelAccessToken: string): Promise<QuotaDetails> {
  const failures: QuotaFailure[] = [];
  const failed = (endpoint: QuotaFailure['endpoint'], code: QuotaFailure['code']) => { failures.push({ endpoint, code }); return null; };
  const read = async (endpoint: QuotaFailure['endpoint']): Promise<Record<string, unknown> | null> => {
    if (!channelAccessToken?.trim()) return failed(endpoint, 'not_connected');
    try {
      const response = await fetch(`https://api.line.me/v2/bot/message/${endpoint === 'quota' ? 'quota' : 'quota/consumption'}`, {
        headers: { Authorization: `Bearer ${channelAccessToken}` }, signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return failed(endpoint, response.status === 401 || response.status === 403 ? 'authentication'
        : response.status === 429 ? 'rate_limit' : 'unavailable');
      const data: unknown = await response.json();
      if (!data || typeof data !== 'object' || Array.isArray(data)) return failed(endpoint, 'invalid_response');
      return data as Record<string, unknown>;
    } catch { return failed(endpoint, 'unavailable'); }
  };
  const [quota, consumption] = await Promise.all([read('quota'), read('consumption')]);
  const unlimited = quota?.type === 'none';
  const validNumber = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  const limit = quota?.type === 'limited' && validNumber(quota.value) ? quota.value : null;
  const used = consumption && validNumber(consumption.totalUsage) ? consumption.totalUsage : null;
  if (quota && !unlimited && limit === null) failed('quota', 'invalid_response');
  if (consumption && used === null) failed('consumption', 'invalid_response');
  const reason = failures.some(failure => failure.code === 'not_connected')
    ? 'LINEの接続に必要な鍵が未設定です。LINEの設定で発行し、接続設定に入れてください。'
    : failures.some(failure => failure.code === 'authentication')
      ? 'LINEの接続用の鍵が受け付けられていません。LINEの設定で鍵を発行し直し、接続設定に入れ直してください。'
    : failures.some(failure => failure.code === 'rate_limit')
      ? 'LINEへの確認が混み合っています。少し待って、もう一度確かめてください。'
      : failures.length ? 'LINEから送信枠を確認できませんでした。時間を置いて、もう一度確かめてください。' : null;
  return { limit, used, unlimited, failures, reason };
}

/** 従来の呼び出し口は数だけを返し、失敗を例外にしない。 */
export async function fetchQuota(channelAccessToken: string): Promise<QuotaFetch> {
  const { limit, used } = await fetchQuotaDetails(channelAccessToken);
  return { limit, used };
}

/*
 *  REJECT対応: アカウント単位の送信枠の予約台帳。
 * 配信単位の claim は行を排他するが、アカウント残枠を別配信間で排他しない。
 * 残枠1を読んだ2配信が同時に進む TOCTOU を止めるため、送る前に枠を予約する。
 * 置き場所は既存の `account_settings` の1行（migration なし）。
 * 値は [{broadcastId, planned, reservedAt}] の JSON。CAS（値の一致条件つき
 * UPDATE）で書き換え、競合したら読み直して最大3回まで試す。
 * 予約は送信の成否に関わらず送り終わったら外す。壊れた値は空とみなす。
 * 30分を超えた予約は置き去りとみなして数えない（外す）。
 */
const QUOTA_RESERVATION_KEY = 'broadcast_quota_reservations';
const QUOTA_RESERVATION_TTL_MS = 30 * 60 * 1000;
const QUOTA_RESERVATION_RETRIES = 3;

type QuotaReservation = { broadcastId: string; planned: number; reservedAt: number };

function parseQuotaReservations(raw: unknown): QuotaReservation[] {
  if (typeof raw !== 'string') return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is QuotaReservation =>
        typeof entry === 'object' && entry !== null &&
        typeof (entry as QuotaReservation).broadcastId === 'string' &&
        typeof (entry as QuotaReservation).planned === 'number' &&
        typeof (entry as QuotaReservation).reservedAt === 'number',
    );
  } catch {
    return [];
  }
}

/** 予約を試みる。枠に入れば true、残枠超え・CAS競合の連続失敗なら false（送らない）。 */
export async function tryReserveQuotaSlot(
  db: D1Database,
  accountId: string,
  broadcastId: string,
  planned: number,
  used: number,
  limit: number,
  options?: { replaceOwn?: boolean; expectedLockVersion?: number },
): Promise<boolean> {
  const now = Date.now();
  for (let attempt = 0; attempt < QUOTA_RESERVATION_RETRIES; attempt++) {
    const row = await db.prepare(
      `SELECT value FROM account_settings WHERE line_account_id = ? AND key = ?`,
    ).bind(accountId, QUOTA_RESERVATION_KEY).first<{ value: string }>();
    const active = parseQuotaReservations(row?.value).filter(
      (entry) => now - entry.reservedAt < QUOTA_RESERVATION_TTL_MS,
    );
    const reserved = active.filter(entry => !options?.replaceOwn || entry.broadcastId !== broadcastId).reduce((sum, entry) => sum + entry.planned, 0);
    if (used + reserved + planned > limit) return false;
    const next = [
      ...active.filter((entry) => entry.broadcastId !== broadcastId),
      { broadcastId, planned, reservedAt: now },
    ];
    const encoded = JSON.stringify(next);
    if (!row) {
      try {
        const inserted = await db.prepare(
          `INSERT INTO account_settings (id, line_account_id, key, value)
           SELECT ?, ?, ?, ? WHERE ? IS NULL OR EXISTS(SELECT 1 FROM broadcasts WHERE id=? AND lock_version=?)`,
        ).bind(`quota-reservations-${accountId}`, accountId, QUOTA_RESERVATION_KEY, encoded, options?.expectedLockVersion ?? null, broadcastId, options?.expectedLockVersion ?? null).run();
        return (inserted.meta?.changes ?? 0) > 0;
      } catch {
        continue;
      }
    }
    const updated = await db.prepare(
      `UPDATE account_settings SET value = ?, updated_at = ? WHERE line_account_id = ? AND key = ? AND value = ?
       AND (? IS NULL OR EXISTS(SELECT 1 FROM broadcasts WHERE id=? AND lock_version=?))`,
    ).bind(encoded, new Date(now).toISOString(), accountId, QUOTA_RESERVATION_KEY, row.value, options?.expectedLockVersion ?? null, broadcastId, options?.expectedLockVersion ?? null).run();
    if ((updated.meta.changes ?? 0) > 0) return true;
  }
  return false;
}

/** 予約を外す。行がなくても壊れていても成功扱い（送る側を止めない）。 */
export async function releaseQuotaSlot(
  db: D1Database,
  accountId: string,
  broadcastId: string,
  options?: { expectedLockVersion: number },
): Promise<void> {
  try {
    const now = Date.now();
    for (let attempt = 0; attempt < QUOTA_RESERVATION_RETRIES; attempt++) {
      const row = await db.prepare(
        `SELECT value FROM account_settings WHERE line_account_id = ? AND key = ?`,
      ).bind(accountId, QUOTA_RESERVATION_KEY).first<{ value: string }>();
      if (!row) return;
      const next = parseQuotaReservations(row.value).filter(
        (entry) => entry.broadcastId !== broadcastId && now - entry.reservedAt < QUOTA_RESERVATION_TTL_MS,
      );
      const encoded = JSON.stringify(next);
      const updated = await db.prepare(
        `UPDATE account_settings SET value = ?, updated_at = ? WHERE line_account_id = ? AND key = ? AND value = ?
           AND (? IS NULL OR EXISTS(SELECT 1 FROM broadcasts WHERE id=? AND lock_version=?))`,
      ).bind(encoded, new Date(now).toISOString(), accountId, QUOTA_RESERVATION_KEY, row.value, options?.expectedLockVersion ?? null, broadcastId, options?.expectedLockVersion ?? null).run();
      if ((updated.meta.changes ?? 0) > 0) return;
    }
  } catch {
    // 予約行の掃除の失敗で送信結果を変えない。
  }
}
