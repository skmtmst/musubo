import { isLineTokenNoticeEventType, lineTokenExpiry, LINE_TOKEN_REFRESH_DAYS } from '@line-crm/shared';
import type {
  LineTokenNoticeEventType,
  LineTokenNoticeMetadata,
  LineTokenRefreshFailureReason,
} from '@line-crm/shared';

/** 取り替えの処理と同じ窓。残りがこれ未満になると cron ごとに取り替える。 */
export const LINE_TOKEN_REFRESH_WINDOW_MS = LINE_TOKEN_REFRESH_DAYS * 24 * 60 * 60_000;

type Notice = { eventType: LineTokenNoticeEventType; title: string; body: string };

export function lineTokenNoticeCopy(reason: unknown): Pick<Notice, 'title' | 'body'> {
  return reason === 'credentials'
    ? {
      title: 'LINEの接続情報を確認してください',
      body: 'LINE Developersでチャネルシークレットを確かめ、アカウントの資格情報で入れ直してください。',
    }
    : {
      title: 'LINE接続の自動更新を再試行しています',
      body: '接続状況はLINEアカウントの詳細で確認できます。',
    };
}

export function lineTokenNoticeDisplay(
  item: { event_type: string; title: string; body: string | null },
  metadata: { reason?: unknown } | null,
): { title: string; body: string | null } {
  if (!isLineTokenNoticeEventType(item.event_type)) return { title: item.title, body: item.body };
  return lineTokenNoticeCopy(metadata?.reason ?? (item.event_type === 'line_token_refresh_failed' ? 'credentials' : undefined));
}

/**
 * 取り替えに失敗した時に書く知らせを決める。自動で直る見込みのある間は何も書かない。
 * 期限の無い鍵（expiresAt が空）には「あと何日」を作らない。
 */
export function lineTokenNoticeFor(input: {
  expiresAt: string | null;
  reason: LineTokenRefreshFailureReason;
  now: number;
}): Notice | null {
  const expiry = lineTokenExpiry(input.expiresAt, input.now);
  const copy = lineTokenNoticeCopy(input.reason);
  if (expiry.status === 'expired') {
    return { eventType: 'line_token_expired', ...copy };
  }
  if (input.reason === 'credentials') {
    return { eventType: 'line_token_refresh_failed', ...copy };
  }
  if (expiry.daysLeft !== null && expiry.daysLeft < LINE_TOKEN_REFRESH_DAYS) {
    return { eventType: 'line_token_expiring', ...copy };
  }
  return null;
}

/**
 * 取り替えの失敗を、そのアカウントの知らせとして残す。
 * 5分ごとの cron で重ねないよう、同じアカウント・同じ種類・同じ期限では 1 回だけ書く。
 * 書いた時は true。
 */
export async function recordLineTokenRefreshFailure(
  db: D1Database,
  account: { id: string; token_expires_at: string | null },
  reason: LineTokenRefreshFailureReason,
  now = Date.now(),
): Promise<boolean> {
  const notice = lineTokenNoticeFor({ expiresAt: account.token_expires_at, reason, now });
  if (!notice) return false;
  const expiresAt = account.token_expires_at ?? null;
  const expiry = lineTokenExpiry(expiresAt, now);
  const metadata: LineTokenNoticeMetadata = {
    expiresAt,
    daysLeft: expiry.daysLeft,
    reason,
    failedAt: new Date(now).toISOString(),
  };
  const result = await db.prepare(
    `INSERT INTO notifications (id, event_type, title, body, channel, status, category, metadata, line_account_id)
     SELECT ?, ?, ?, ?, 'dashboard', 'sent', 'error', ?, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM notifications
         WHERE line_account_id = ? AND event_type = ?
           AND json_extract(metadata, '$.expiresAt') IS ?
      )`,
  ).bind(
    crypto.randomUUID(), notice.eventType, notice.title, notice.body, JSON.stringify(metadata), account.id,
    account.id, notice.eventType, expiresAt,
  ).run();
  return Number(result.meta.changes ?? 0) > 0;
}

/** 今の鍵（同じ期限）について、取り替えの失敗が残っているか。稼働確認の注意に使う。 */
export async function hasLineTokenRefreshFailure(
  db: D1Database,
  lineAccountId: string,
  expiresAt: string | null,
): Promise<boolean> {
  const row = await db.prepare(
    `SELECT 1 AS found FROM notifications
      WHERE line_account_id = ?
        AND event_type IN ('line_token_expiring', 'line_token_refresh_failed')
        AND json_extract(metadata, '$.expiresAt') IS ?
      LIMIT 1`,
  ).bind(lineAccountId, expiresAt).first<{ found: number }>();
  return Boolean(row);
}
