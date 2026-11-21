import type { Context } from 'hono';
import type { LineAccount, LineAccountConnectionCheck } from '@line-crm/db';
import type { Env } from '../worker-env.js';
import { expectedWebhookUrl as accountWebhookUrl } from '../lib/webhook-endpoint.js';
import { fetchBotProfile } from '../lib/bot-profile.js';
import { classifyLineMonthlyPlan, fetchLineMonthlyPlan } from '../services/line-monthly-plan.js';
import { fetchWebhookEndpointState } from '../services/line-webhook-state.js';

type WebhookOrigins = Pick<Env['Bindings'], 'WORKER_PUBLIC_URL' | 'WORKER_URL' | 'WORKER_ALIAS_URLS'>;

function trimTrailingSlash(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

/** Canonical and configured alias URLs all point to the same Worker. */
export function acceptedWebhookUrls(
  env: WebhookOrigins,
  canonicalWebhookUrl: string,
): string[] {
  const origins = [env.WORKER_PUBLIC_URL, env.WORKER_URL,
    ...(env.WORKER_ALIAS_URLS ?? '').split(',')]
    .map((value) => (value ? trimTrailingSlash(value) : ''))
    .filter((value) => /^https:\/\/[^/]+$/.test(value));
  const path = new URL(canonicalWebhookUrl).pathname.replace(/\/+$/, '');
  const urls = [trimTrailingSlash(canonicalWebhookUrl), ...origins.map((origin) => `${origin}${path}`)];
  return [...new Set(urls)];
}

export async function readLiveAccountConnection(env: WebhookOrigins, base: string, account: LineAccount) {
  const legacyWebhookUrl = accountWebhookUrl(base);
  // 旧データではアカウント固有のWebhookを確認できない。該当行だけを未確認とする。
  if (!/^\d+$/.test(account.channel_id)) {
    return {
      webhook: { expectedUrl: legacyWebhookUrl, actualUrl: null, active: null, status: 'unknown' as const },
      plan: classifyLineMonthlyPlan(null),
    };
  }

  const expectedUrl = accountWebhookUrl(base, account.channel_id);
  const aliases = [...acceptedWebhookUrls(env, expectedUrl), ...acceptedWebhookUrls(env, legacyWebhookUrl)];
  const [profile, webhook, plan] = await Promise.all([
    fetchBotProfile(account.channel_access_token),
    fetchWebhookEndpointState(account.channel_access_token, expectedUrl, aliases),
    fetchLineMonthlyPlan(account.channel_access_token),
  ]);
  return {
    displayName: profile.displayName || account.name,
    pictureUrl: profile.pictureUrl || null,
    basicId: profile.basicId || null,
    webhook,
    plan,
  };
}

export function isAcceptedWebhookUrl(registeredUrl: string | null | undefined,
  accepted: readonly string[]): boolean {
  if (!registeredUrl) return false;
  return accepted.includes(trimTrailingSlash(registeredUrl));
}

export function publicAccountUrls(c: Context<Env>, liffId: string | null, channelId: string) {
  const base = (c.env.WORKER_PUBLIC_URL || c.env.WORKER_URL || new URL(c.req.url).origin).replace(/\/$/, '');
  return {
    webhook: accountWebhookUrl(base, channelId),
    webhookAccepted: [...acceptedWebhookUrls(c.env, accountWebhookUrl(base, channelId)),
      ...acceptedWebhookUrls(c.env, `${base}/webhook`)],
    callback: `${base}/auth/callback`,
    liffEndpoint: liffId ? `${base}?liffId=${encodeURIComponent(liffId)}` : null,
  };
}

function serializeConnectionCheck(row: LineAccountConnectionCheck) {
  return {
    kind: row.check_kind, result: row.result,
    expectedUrl: row.expected_url, registeredUrl: row.registered_url,
    webhookActive: row.webhook_active == null ? null : Boolean(row.webhook_active),
    httpStatus: row.http_status,
  };
}

export function connectionCheckResponse(account: LineAccount, rows: LineAccountConnectionCheck[],
  urls: ReturnType<typeof publicAccountUrls>) {
  const first = rows[0];
  return {
    accountId: account.id, revision: first?.account_revision ?? account.revision ?? 1,
    checkedAt: first?.checked_at ?? null, correlationId: first?.correlation_id ?? null,
    expectedUrls: urls, checks: rows.map(serializeConnectionCheck),
  };
}
