import type { Context } from 'hono';
import type { LineAccount, LineAccountConnectionCheck } from '@line-crm/db';
import type { Env } from '../worker-env.js';
import { expectedWebhookUrl as accountWebhookUrl } from '../lib/webhook-endpoint.js';

function trimTrailingSlash(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

/** Canonical and configured alias URLs all point to the same Worker. */
export function acceptedWebhookUrls(
  env: Pick<Env['Bindings'], 'WORKER_PUBLIC_URL' | 'WORKER_URL' | 'WORKER_ALIAS_URLS'>,
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
