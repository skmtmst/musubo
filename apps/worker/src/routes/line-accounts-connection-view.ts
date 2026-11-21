import { tracedFetch } from '@line-crm/shared/server';
import type { Context } from 'hono';
import type { LineAccount, LineAccountConnectionCheck } from '@line-crm/db';
import type { Env } from '../worker-env.js';
import { expectedWebhookUrl as accountWebhookUrl } from '../lib/webhook-endpoint.js';
import { fetchBotProfile, type BotProfile } from '../lib/bot-profile.js';
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

type ConnectionCheckDraft = {
  kind: 'bot_info' | 'webhook_endpoint' | 'webhook_test' | 'liff_config';
  result: 'matched' | 'mismatched' | 'unconfigured' | 'unknown' | 'ok' | 'failed';
  expectedUrl?: string | null;
  registeredUrl?: string | null;
  webhookActive?: boolean | null;
  httpStatus?: number | null;
};

export async function collectConnectionChecks(
  account: LineAccount,
  expectedWebhookUrl: string,
  expectedLiffEndpointUrl: string | null,
  acceptedWebhook: readonly string[] = [expectedWebhookUrl],
): Promise<{ checks: ConnectionCheckDraft[]; botProfile: BotProfile | null }> {
  const checks: ConnectionCheckDraft[] = [];
  const headers = { Authorization: `Bearer ${account.channel_access_token}` };
  let botOk = false;
  let botProfile: BotProfile | null = null;
  try {
    const response = await tracedFetch('https://api.line.me/v2/bot/info', { headers });
    botOk = response.ok;
    if (response.ok) botProfile = await response.json<BotProfile>();
    checks.push({ kind: 'bot_info', result: response.ok ? 'ok' : 'failed', httpStatus: response.status });
  } catch {
    checks.push({ kind: 'bot_info', result: 'failed', httpStatus: null });
  }

  let endpointResult: ConnectionCheckDraft = {
    kind: 'webhook_endpoint',
    result: 'unknown',
    expectedUrl: expectedWebhookUrl,
    registeredUrl: null,
    webhookActive: null,
    httpStatus: null,
  };
  let mayTestWebhook = false;
  if (botOk) {
    try {
      const response = await tracedFetch('https://api.line.me/v2/bot/channel/webhook/endpoint', { headers });
      if (response.ok) {
        const payload = await response.json<{ endpoint?: string; active?: boolean }>();
        const registeredUrl = payload.endpoint?.trim() || null;
        const active = payload.active === true;
        endpointResult = {
          kind: 'webhook_endpoint',
          result: !registeredUrl
            ? 'unconfigured'
            : isAcceptedWebhookUrl(registeredUrl, acceptedWebhook) && active
              ? 'matched'
              : 'mismatched',
          expectedUrl: expectedWebhookUrl,
          registeredUrl,
          webhookActive: payload.active == null ? null : active,
          httpStatus: response.status,
        };
        mayTestWebhook = endpointResult.result === 'matched';
      } else {
        endpointResult.httpStatus = response.status;
      }
    } catch {
      // The canonical unknown state intentionally stores null for unavailable values.
    }
  }
  checks.push(endpointResult);

  if (mayTestWebhook) {
    try {
      const response = await tracedFetch('https://api.line.me/v2/bot/channel/webhook/test', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: '{}',
      });
      const payload = response.ok ? await response.json<{ success?: boolean }>() : null;
      checks.push({
        kind: 'webhook_test',
        result: response.ok && payload?.success === true ? 'ok' : 'failed',
        expectedUrl: expectedWebhookUrl,
        httpStatus: response.status,
      });
    } catch {
      checks.push({ kind: 'webhook_test', result: 'unknown', expectedUrl: expectedWebhookUrl });
    }
  } else {
    checks.push({ kind: 'webhook_test', result: 'unknown', expectedUrl: expectedWebhookUrl });
  }

  const loginMatchesLiff = Boolean(
    account.login_channel_id &&
    account.login_channel_secret &&
    account.liff_id &&
    /^\d+$/.test(account.login_channel_id) &&
    /^\d+-[A-Za-z0-9]+$/.test(account.liff_id) &&
    account.liff_id.startsWith(`${account.login_channel_id}-`),
  );
  checks.push({
    kind: 'liff_config',
    // LINE は登録済み Webhook URL の読取 API を公開しないため、ローカルの組合せが正しくても一致と断定せず不明にする。
    result: loginMatchesLiff ? 'unknown' : 'failed',
    expectedUrl: expectedLiffEndpointUrl,
    registeredUrl: null,
  });
  return { checks, botProfile };
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

type ConnectionVerification = {
  messagingApi: boolean;
  webhook: boolean;
  lineLogin: boolean;
  liff: boolean;
  webhookUrl: string | null;
  botProfile: BotProfile | null;
  errors: string[];
};

export async function verifyConnection(input: {
  channelAccessToken: string;
  loginChannelId: string;
  loginChannelSecret: string;
  liffId: string;
  expectedWebhookUrl: string | null;
  acceptedWebhookUrls?: readonly string[];
}): Promise<ConnectionVerification> {
  const result: ConnectionVerification = {
    messagingApi: false,
    webhook: false,
    lineLogin: /^\d+$/.test(input.loginChannelId),
    liff: /^\d+-[A-Za-z0-9]+$/.test(input.liffId),
    webhookUrl: null,
    botProfile: null,
    errors: [],
  };
  if (!input.loginChannelSecret.trim()) result.lineLogin = false;
  if (!result.lineLogin) result.errors.push('LINE LoginのChannel IDまたはChannel Secretを確認してください');
  if (!result.liff) result.errors.push('LIFF IDの形式を確認してください');

  const headers = { Authorization: `Bearer ${input.channelAccessToken}` };
  try {
    const botResponse = await fetch('https://api.line.me/v2/bot/info', { headers });
    result.messagingApi = botResponse.ok;
    if (botResponse.ok) result.botProfile = await botResponse.json<BotProfile>();
    if (!botResponse.ok) result.errors.push('Messaging APIのChannel Access Tokenを確認してください');
  } catch {
    result.errors.push('Messaging APIへ接続できませんでした');
  }

  if (result.messagingApi) {
    try {
      const endpointResponse = await fetch('https://api.line.me/v2/bot/channel/webhook/endpoint', {
        headers: { ...headers, 'Content-Type': 'application/json' },
      });
      if (endpointResponse.ok) {
        const endpoint = await endpointResponse.json<{ endpoint?: string; active?: boolean }>();
        result.webhookUrl = endpoint.endpoint ?? null;
        const sameEndpoint = !input.expectedWebhookUrl
          || isAcceptedWebhookUrl(endpoint.endpoint, input.acceptedWebhookUrls ?? [input.expectedWebhookUrl]);
        if (endpoint.active && sameEndpoint) {
          const testResponse = await fetch('https://api.line.me/v2/bot/channel/webhook/test', {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: '{}',
          });
          if (testResponse.ok) {
            const tested = await testResponse.json<{ success?: boolean }>();
            result.webhook = tested.success === true;
          }
        }
      }
      if (!result.webhook) {
        result.errors.push('Webhook URLの一致・利用設定・接続テストを確認してください');
      }
    } catch {
      result.errors.push('Webhookの接続確認に失敗しました');
    }
  }
  return result;
}
