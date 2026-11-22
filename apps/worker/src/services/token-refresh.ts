import { lineObservationTime, jstCalendar as japanCalendar, type LineTokenRefreshFailureReason } from '@line-crm/shared';
import { tracedFetch as fetch, logger } from '@line-crm/shared/server';
/** LINE の client_credentials で有効期限30日のトークンを発行する。5分の cron ごとに、期限まで7日以内か期限不明のアカウントだけを更新し、失効前に交換する。 */

import { getLineAccounts, saveRenewedLineAccessToken, updateLineAccountFields } from '@line-crm/db';
import type { LineAccount } from '@line-crm/db';
import { fetchBotProfile } from '../lib/bot-profile.js';
import { LINE_TOKEN_REFRESH_WINDOW_MS, recordLineTokenRefreshFailure } from './line-token-notices.js';

const REFRESH_THRESHOLD_MS = LINE_TOKEN_REFRESH_WINDOW_MS; // 7 days

function jstNow(): string {
  const jst = japanCalendar();
  return jst.toISOString().slice(0, -1) + '+09:00';
}

function shouldRefresh(account: LineAccount): boolean {
  if (!account.token_expires_at) return true; // 期限が分からない場合も、一度更新して以後の期限を追えるようにする。
  const expiresAt = lineObservationTime(account.token_expires_at);
  return !Number.isFinite(expiresAt) || expiresAt - Date.now() < REFRESH_THRESHOLD_MS;
}

function shouldSyncProfile(account: LineAccount): boolean {
  if (!account.line_profile_synced_at) return true;
  const syncedAt = new Date(account.line_profile_synced_at).getTime();
  return !Number.isFinite(syncedAt) || Date.now() - syncedAt >= 24 * 60 * 60_000;
}

export interface TokenResponse {
  access_token: string;
  expires_in: number; // 単位は秒。
  token_type: string;
}

export function issuedLineTokenExpiry(expiresIn: number): string {
  const expiresAt = japanCalendar(new Date(Date.now() + expiresIn * 1000));
  return expiresAt.toISOString().slice(0, -1) + '+09:00';
}

export type LineTokenIssueFailure =
  | 'credentials'
  | 'rate_limited'
  | 'temporary'
  | 'network'
  | 'invalid_response';

export class LineTokenIssueError extends Error {
  constructor(
    public readonly reason: LineTokenIssueFailure,
    public readonly status: number | null = null,
  ) {
    super(`LINE access token could not be issued (${reason})`);
    this.name = 'LineTokenIssueError';
  }
}

/** LINE の既存 OAuth でトークンを発行する。応答本文に運用上の情報が含まれ得るため、例外へ写してログや画面へ出さない。 */
export async function issueLineAccessToken(
  channelId: string,
  channelSecret: string,
): Promise<TokenResponse> {
  let res: Response;
  try {
    res = await fetch('https://api.line.me/v2/oauth/accessToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: channelId,
        client_secret: channelSecret,
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new LineTokenIssueError('network');
  }

  if (!res.ok) {
    const reason: LineTokenIssueFailure = res.status === 400 || res.status === 401
      ? 'credentials'
      : res.status === 429
        ? 'rate_limited'
        : res.status >= 500
          ? 'temporary'
          : 'invalid_response';
    throw new LineTokenIssueError(reason, res.status);
  }

  try {
    const token = await res.json<TokenResponse>();
    if (!token.access_token || !Number.isSafeInteger(token.expires_in) || token.expires_in <= 0) {
      throw new LineTokenIssueError('invalid_response', res.status);
    }
    return token;
  } catch (error) {
    if (error instanceof LineTokenIssueError) throw error;
    throw new LineTokenIssueError('invalid_response', res.status);
  }
}

export async function refreshLineAccessTokens(
  db: D1Database,
  { credentialEncryptionKey, syncProfiles = true }: { credentialEncryptionKey?: string; syncProfiles?: boolean } = {},
): Promise<void> {
  const accounts = await getLineAccounts(db, credentialEncryptionKey);

  for (const account of accounts) {
    if (!account.is_active || account.archived_at) continue;
    let accessToken = account.channel_access_token;

    if (shouldRefresh(account)) {
      try {
        const token = await issueLineAccessToken(account.channel_id, account.channel_secret);
        const saved = await saveRenewedLineAccessToken(db, account, {
          accessToken: token.access_token,
          expiresAt: issuedLineTokenExpiry(token.expires_in),
        }, credentialEncryptionKey);
        if (!saved) continue;
        accessToken = token.access_token;

        logger.log("services_token_refresh_log");
      } catch (err) {
        const reason: LineTokenRefreshFailureReason = err instanceof LineTokenIssueError ? err.reason : 'unexpected';
        // ログは固定のイベント名と状態番号だけ。理由は知らせの記録に残す。
        logger.error(reason === 'credentials'
          ? 'token_refresh.refresh_failed.credentials'
          : 'token_refresh.refresh_failed', {
          status: err instanceof LineTokenIssueError ? err.status ?? undefined : undefined,
        });
        // 自動で直らない失敗だけを知らせに残す。書けなくても取り替えとプロフィールの同期は続ける。
        try {
          await recordLineTokenRefreshFailure(db, account, reason);
        } catch {
          logger.error("token_refresh.failure_notice_failed");
        }
      }
    }

    if (syncProfiles && shouldSyncProfile(account)) {
      try {
        const profile = await fetchBotProfile(accessToken);
        if (profile.displayName || profile.pictureUrl || profile.basicId) {
          await updateLineAccountFields(db, account.id, {
            lineDisplayName: profile.displayName ?? null,
            linePictureUrl: profile.pictureUrl ?? null,
            lineBasicId: profile.basicId ?? null,
            lineProfileSyncedAt: jstNow(),
          });
        }
      } catch (err) {
        logger.error("token_refresh.refresh_line_access_tokens_failed");
      }
    }
  }
}
