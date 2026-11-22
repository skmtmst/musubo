import { tracedFetch as fetch } from '@line-crm/shared/server';
import { expectedWebhookUrl } from '../lib/webhook-endpoint.js';
import { issueLineAccessToken, LineTokenIssueError } from './token-refresh.js';

export type LineConnectStepState = 'passed' | 'failed' | 'skipped';

export interface LineConnectStep {
  order: 1 | 2 | 3 | 4 | 5;
  state: LineConnectStepState;
  message: string;
}

export interface ConnectedBotProfile {
  displayName: string;
  pictureUrl: string | null;
  basicId: string | null;
  chatMode: string | null;
}

export interface PreparedLineConnection {
  success: boolean;
  steps: LineConnectStep[];
  channelAccessToken?: string;
  bot?: ConnectedBotProfile;
  liffId?: string;
  webhook: {
    expectedUrl: string;
    registeredUrl: string | null;
    active: boolean | null;
    testPassed: boolean | null;
  };
}

const STEP_MESSAGES = [
  'チャネルIDとシークレットでアクセストークンを発行',
  '公式アカウントの名前とアイコンを取得',
  'Webhook URLを登録して、実際に届くかテスト',
  'LINE Loginチャネルを確認して、LIFFアプリを作成',
  '認証済みアカウントかを判定',
] as const;

function step(order: LineConnectStep['order'], state: LineConnectStepState, message?: string): LineConnectStep {
  return { order, state, message: message ?? STEP_MESSAGES[order - 1] };
}

function stopped(
  completed: LineConnectStep[],
  order: LineConnectStep['order'],
  message: string,
  webhookUrl: string,
  webhook: PreparedLineConnection['webhook'],
  extra: Partial<PreparedLineConnection> = {},
): PreparedLineConnection {
  const steps = [...completed, step(order, 'failed', message)];
  for (let next = order + 1; next <= 5; next += 1) {
    steps.push(step(next as LineConnectStep['order'], 'skipped'));
  }
  return {
    success: false,
    steps,
    webhook: { ...webhook, expectedUrl: webhookUrl },
    ...extra,
  };
}

function tokenFailureMessage(error: unknown): string {
  if (!(error instanceof LineTokenIssueError)) {
    return 'LINEに接続できませんでした。時間をおいて、もう一度お試しください。';
  }
  switch (error.reason) {
    case 'credentials':
      return 'チャネルID・チャネルシークレットを確認してください。';
    case 'rate_limited':
      return 'LINEの利用回数上限に達しました。時間をおいて、もう一度お試しください。';
    case 'temporary':
    case 'network':
      return 'LINEに一時的に接続できません。時間をおいて、もう一度お試しください。';
    default:
      return 'LINEから正しい応答を受け取れませんでした。入力内容を確認してください。';
  }
}

async function lineFetch(url: string, init: RequestInit): Promise<Response | null> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  } catch {
    return null;
  }
}

async function readJson<T>(response: Response): Promise<T | null> {
  try {
    return await response.json<T>();
  } catch {
    return null;
  }
}

function trimTrailingSlash(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

/**
 * LINE に登録されている Webhook URL が musubo の受け口かどうか。
 * 既存アカウントの確認（routes/line-accounts.ts の acceptedWebhookUrls）と
 * 同じく、別名URL（WORKER_ALIAS_URLS。stagingのworkers.devなど）も同じ
 * Worker なので一致とみなす。末尾スラッシュの違いは無視する。
 */
function webhookUrlMatches(
  registeredUrl: string | null | undefined,
  canonicalUrl: string,
  accepted?: readonly string[],
): boolean {
  if (!registeredUrl) return false;
  const list = (accepted && accepted.length > 0 ? accepted : [canonicalUrl]).map(trimTrailingSlash);
  return list.includes(trimTrailingSlash(registeredUrl));
}

/**
 * LINE側の自動設定を順番に行う。DBは一切触らず、秘密値は成功時も呼び出し元にだけ返す。
 * 呼び出し元はこの値をHTTPレスポンスへ含めてはならない。
 */
export async function prepareLineConnection(input: {
  channelId: string;
  channelSecret: string;
  loginChannelId: string;
  loginChannelSecret: string;
  baseUrl: string;
  liffId?: string;
  /** 同じ Worker を指す別名URLの受け口。既存アカウントの確認と同じ一覧を渡す。 */
  acceptedWebhookUrls?: readonly string[];
}): Promise<PreparedLineConnection> {
  const completed: LineConnectStep[] = [];
  const webhookUrl = expectedWebhookUrl(input.baseUrl, input.channelId);
  const webhook: PreparedLineConnection['webhook'] = {
    expectedUrl: webhookUrl,
    registeredUrl: null,
    active: null,
    testPassed: null,
  };

  let channelAccessToken: string;
  try {
    channelAccessToken = (await issueLineAccessToken(input.channelId, input.channelSecret)).access_token;
    completed.push(step(1, 'passed'));
  } catch (error) {
    return stopped(completed, 1, tokenFailureMessage(error), webhookUrl, webhook);
  }

  const messagingHeaders = { Authorization: `Bearer ${channelAccessToken}` };
  const botResponse = await lineFetch('https://api.line.me/v2/bot/info', { headers: messagingHeaders });
  const bot = botResponse?.ok ? await readJson<Partial<ConnectedBotProfile>>(botResponse) : null;
  if (!botResponse?.ok || !bot?.displayName) {
    return stopped(completed, 2, '公式アカウント情報を取得できませんでした。Messaging APIの設定を確認してください。', webhookUrl, webhook);
  }
  const profile: ConnectedBotProfile = {
    displayName: bot.displayName,
    pictureUrl: bot.pictureUrl ?? null,
    basicId: bot.basicId ?? null,
    chatMode: bot.chatMode ?? null,
  };
  completed.push(step(2, 'passed'));

  const webhookHeaders = { ...messagingHeaders, 'Content-Type': 'application/json' };
  const setWebhook = await lineFetch('https://api.line.me/v2/bot/channel/webhook/endpoint', {
    method: 'PUT',
    headers: webhookHeaders,
    body: JSON.stringify({ endpoint: webhookUrl }),
  });
  if (!setWebhook?.ok) {
    return stopped(completed, 3, 'Webhook URLを登録できませんでした。Messaging APIの設定を確認してください。', webhookUrl, webhook, { bot: profile });
  }
  const getWebhook = await lineFetch('https://api.line.me/v2/bot/channel/webhook/endpoint', { headers: webhookHeaders });
  const endpoint = getWebhook?.ok
    ? await readJson<{ endpoint?: string; active?: boolean }>(getWebhook)
    : null;
  webhook.registeredUrl = endpoint?.endpoint ?? null;
  webhook.active = typeof endpoint?.active === 'boolean' ? endpoint.active : null;
  if (!getWebhook?.ok || !webhookUrlMatches(endpoint?.endpoint, webhookUrl, input.acceptedWebhookUrls)) {
    return stopped(completed, 3, 'Webhook URLを確認できませんでした。もう一度お試しください。', webhookUrl, webhook, { bot: profile });
  }
  if (endpoint?.active !== true) {
    return stopped(completed, 3, 'LINE Developersで「Webhookの利用」をオンにしてください（設定方法を見る）。', webhookUrl, webhook, { bot: profile });
  }
  const testWebhook = await lineFetch('https://api.line.me/v2/bot/channel/webhook/test', {
    method: 'POST',
    headers: webhookHeaders,
    body: '{}',
  });
  const tested = testWebhook?.ok ? await readJson<{ success?: boolean }>(testWebhook) : null;
  webhook.testPassed = tested?.success === true;
  if (!webhook.testPassed) {
    return stopped(completed, 3, 'Webhookへ届きませんでした。公開URLとWebhookの利用設定を確認してください。', webhookUrl, webhook, { bot: profile });
  }
  completed.push(step(3, 'passed'));

  let loginAccessToken: string;
  try {
    loginAccessToken = (await issueLineAccessToken(input.loginChannelId, input.loginChannelSecret)).access_token;
  } catch {
    return stopped(completed, 4, 'LoginチャネルID・シークレットを確認してください。', webhookUrl, webhook, { bot: profile });
  }
  const liffHeaders = { Authorization: `Bearer ${loginAccessToken}`, 'Content-Type': 'application/json' };
  const liffListResponse = await lineFetch('https://api.line.me/liff/v1/apps', { headers: liffHeaders });
  const liffList = liffListResponse?.ok
    ? await readJson<{ apps?: Array<{ liffId?: string; description?: string }> }>(liffListResponse)
    : null;
  // LINE returns 404 for an empty LIFF app list.
  const liffApps = liffListResponse?.status === 404 ? [] : liffList?.apps;
  if (!Array.isArray(liffApps)) {
    return stopped(completed, 4, 'LIFFアプリを確認できませんでした。LINE Loginチャネルの設定を確認してください。', webhookUrl, webhook, { bot: profile });
  }
  if (input.liffId && !liffApps.some((app) => app.liffId === input.liffId)) {
    return stopped(completed, 4, '指定したLIFFはこのLINE Loginチャネルにありません。LIFF IDを確認してください。', webhookUrl, webhook, { bot: profile });
  }
  let liffId = input.liffId ?? liffApps.find((app) => app.description === 'musubo' && app.liffId)?.liffId;
  const liffView = { type: 'full', url: input.baseUrl.replace(/\/$/, '') } as const;
  if (!liffId) {
    const createLiff = await lineFetch('https://api.line.me/liff/v1/apps', {
      method: 'POST',
      headers: liffHeaders,
      body: JSON.stringify({
        view: liffView,
        description: 'musubo',
        scope: ['openid', 'profile', 'chat_message.write'],
        botPrompt: 'aggressive',
      }),
    });
    const created = createLiff?.ok ? await readJson<{ liffId?: string }>(createLiff) : null;
    liffId = created?.liffId;
    if (!createLiff?.ok || !liffId) {
      return stopped(completed, 4, 'LIFFアプリを作成できませんでした。LINE Loginチャネルの権限を確認してください。', webhookUrl, webhook, { bot: profile });
    }
  }
  const endpointUrl = `${input.baseUrl.replace(/\/$/, '')}?liffId=${encodeURIComponent(liffId)}`;
  const updateLiff = await lineFetch(`https://api.line.me/liff/v1/apps/${encodeURIComponent(liffId)}`, {
    method: 'PUT',
    headers: liffHeaders,
    body: JSON.stringify({
      view: { type: 'full', url: endpointUrl },
      description: 'musubo',
      scope: ['openid', 'profile', 'chat_message.write'],
      botPrompt: 'aggressive',
    }),
  });
  if (!updateLiff?.ok) {
    return stopped(completed, 4, 'LIFFアプリの接続先を更新できませんでした。もう一度お試しください。', webhookUrl, webhook, { bot: profile, liffId });
  }
  completed.push(step(4, 'passed'));

  return {
    success: true,
    steps: [...completed, step(5, 'skipped')],
    channelAccessToken,
    bot: profile,
    liffId,
    webhook,
  };
}

export const lineConnectStep = step;
