import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareLineConnection } from './line-account-connect.js';

const input = {
  channelId: '123456789',
  channelSecret: 'messaging-secret',
  loginChannelId: '2007123456',
  loginChannelSecret: 'login-secret',
  baseUrl: 'https://nen-line-stg.skmtmst.workers.dev',
};

type Failure = 'messaging-token' | 'bot' | 'webhook-inactive' | 'login-token' | 'liff-create' | null;

function installFetch({
  failure = null,
  existingLiffId,
  registeredEndpoint,
  emptyLiffListStatus = 200,
}: {
  failure?: Failure;
  existingLiffId?: string;
  registeredEndpoint?: string;
  emptyLiffListStatus?: number;
} = {}) {
  const calls: Array<{ url: string; method: string; body: string }> = [];
  let availableLiffId = existingLiffId;
  vi.stubGlobal('fetch', vi.fn(async (request: string | URL | Request, init: RequestInit = {}) => {
    const url = String(request);
    const method = init.method ?? 'GET';
    const body = init.body ? String(init.body) : '';
    calls.push({ url, method, body });
    if (url.endsWith('/v2/oauth/accessToken')) {
      const clientId = new URLSearchParams(body).get('client_id');
      if ((clientId === input.channelId && failure === 'messaging-token') ||
          (clientId === input.loginChannelId && failure === 'login-token')) {
        return new Response(null, { status: 401 });
      }
      return Response.json({ access_token: `token-${clientId}`, expires_in: 2_592_000, token_type: 'Bearer' });
    }
    if (url.endsWith('/v2/bot/info')) {
      return failure === 'bot'
        ? new Response(null, { status: 502 })
        : Response.json({ displayName: 'テスト公式', pictureUrl: 'https://example.com/icon.png', basicId: '@test', chatMode: 'bot' });
    }
    if (url.endsWith('/v2/bot/channel/webhook/endpoint') && method === 'PUT') return Response.json({});
    if (url.endsWith('/v2/bot/channel/webhook/endpoint')) {
      return Response.json({ endpoint: registeredEndpoint ?? `${input.baseUrl}/webhook/${input.channelId}`, active: failure !== 'webhook-inactive' });
    }
    if (url.endsWith('/v2/bot/channel/webhook/test')) return Response.json({ success: true });
    if (url.endsWith('/liff/v1/apps') && method === 'GET') {
      if (availableLiffId) return Response.json({ apps: [{ liffId: availableLiffId, description: 'musubo' }] });
      if (emptyLiffListStatus !== 200) return new Response(null, { status: emptyLiffListStatus });
      return Response.json({ apps: [] });
    }
    if (url.endsWith('/liff/v1/apps') && method === 'POST') {
      if (failure === 'liff-create') return new Response(null, { status: 403 });
      availableLiffId = '2007123456-auto';
      return Response.json({ liffId: availableLiffId });
    }
    if (url.includes('/liff/v1/apps/') && method === 'PUT') return Response.json({});
    return new Response(null, { status: 404 });
  }));
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe('LINEアカウント自動接続', () => {
  it.each([
    ['messaging-token', 1],
    ['bot', 2],
    ['webhook-inactive', 3],
    ['login-token', 4],
    ['liff-create', 4],
  ] as const)('%sでは指定段で止まり、後続を未確認にする', async (failure, stoppedOrder) => {
    installFetch({ failure });
    const result = await prepareLineConnection(input);
    expect(result.success).toBe(false);
    expect(result.steps.find((item) => item.state === 'failed')?.order).toBe(stoppedOrder);
    expect(result.steps.slice(stoppedOrder).every((item) => item.state === 'skipped')).toBe(true);
    expect(JSON.stringify(result)).not.toContain(input.channelSecret);
    expect(JSON.stringify(result)).not.toContain(input.loginChannelSecret);
  });

  it('LIFFを作成し、liffId付きのURLへ更新する', async () => {
    const calls = installFetch();
    const result = await prepareLineConnection(input);
    expect(result.success).toBe(true);
    expect(result.liffId).toBe('2007123456-auto');
    const update = calls.find((call) => call.url.includes('/liff/v1/apps/2007123456-auto') && call.method === 'PUT');
    expect(update?.body).toContain('https://nen-line-stg.skmtmst.workers.dev?liffId=2007123456-auto');
  });

  it('LIFFが0件の404から初回作成し、次の接続確認で再利用する', async () => {
    const calls = installFetch({ emptyLiffListStatus: 404 });

    const first = await prepareLineConnection(input);
    expect(first).toMatchObject({ success: true, liffId: '2007123456-auto' });
    const second = await prepareLineConnection(input);
    expect(second).toMatchObject({ success: true, liffId: first.liffId });
    const liffCalls = calls.filter((call) => call.url.includes('/liff/v1/apps'));
    expect(liffCalls.map((call) => call.method)).toEqual(['GET', 'POST', 'PUT', 'GET', 'PUT']);
    expect(liffCalls[2].body).toContain(`${input.baseUrl}?liffId=2007123456-auto`);
  });

  it.each([401, 429, 500])('LIFF一覧が%dの場合は作成も更新もしない', async (emptyLiffListStatus) => {
    const calls = installFetch({ emptyLiffListStatus });
    const result = await prepareLineConnection(input);
    expect(result.success).toBe(false);
    expect(result.steps.find((item) => item.state === 'failed')?.order).toBe(4);
    expect(calls.filter((call) => call.url.includes('/liff/v1/apps')).map((call) => call.method)).toEqual(['GET']);
  });

  it('指定LIFFがあり一覧が404の場合は新規作成に切り替えない', async () => {
    const calls = installFetch({ emptyLiffListStatus: 404 });
    const result = await prepareLineConnection({ ...input, liffId: '2007123456-missing' });
    expect(result.success).toBe(false);
    expect(result.steps.find((item) => item.state === 'failed')).toMatchObject({
      order: 4,
      message: '指定したLIFFはこのLINE Loginチャネルにありません。LIFF IDを確認してください。',
    });
    expect(calls.filter((call) => call.url.includes('/liff/v1/apps')).map((call) => call.method)).toEqual(['GET']);
  });

  it('指定LIFFがチャネル内にある場合だけ流用し、別チャネルのIDを拒否する',async()=>{
    const calls=installFetch({ existingLiffId: '2007123456-existing' })
    const found=await prepareLineConnection({...input,liffId:'2007123456-existing'})
    expect(found.success).toBe(true);expect(found.liffId).toBe('2007123456-existing')
    expect(calls.some(call=>call.url.endsWith('/liff/v1/apps')&&call.method==='POST')).toBe(false)
    const missing=await prepareLineConnection({...input,liffId:'2007123456-missing'})
    expect(missing.success).toBe(false);expect(missing.steps.find(s=>s.state==='failed')?.order).toBe(4)
  })

  /*
   * 既存アカウントの確認は別名URL（WORKER_ALIAS_URLS）も同じWorkerとして通すのに、
   * 新規追加だけ完全一致で止まっていた。同じ受け口一覧で判定する。
   */
  it('別名URLで登録されたWebhookも同じ受け口として通し、末尾スラッシュの違いも無視する', async () => {
    const alias = 'https://nen-line-stg-alias.skmtmst.workers.dev/webhook/123456789/';
    installFetch({ registeredEndpoint: alias });
    const accepted = await prepareLineConnection({
      ...input,
      acceptedWebhookUrls: [`${input.baseUrl}/webhook/${input.channelId}`, 'https://nen-line-stg-alias.skmtmst.workers.dev/webhook/123456789'],
    });
    expect(accepted.success).toBe(true);
    expect(accepted.webhook.registeredUrl).toBe(alias);
  });

  it('受け口一覧に無いWebhook URLは3段目で止める', async () => {
    installFetch({ registeredEndpoint: 'https://example.com/webhook' });
    const result = await prepareLineConnection({
      ...input,
      acceptedWebhookUrls: [`${input.baseUrl}/webhook/${input.channelId}`],
    });
    expect(result.success).toBe(false);
    expect(result.steps.find((item) => item.state === 'failed')?.order).toBe(3);
  });

  it('descriptionがmusuboの既存LIFFを流用する', async () => {
    const calls = installFetch({ existingLiffId: '2007123456-existing' });
    const result = await prepareLineConnection(input);
    expect(result.liffId).toBe('2007123456-existing');
    expect(calls.some((call) => call.url.endsWith('/liff/v1/apps') && call.method === 'POST')).toBe(false);
  });
});
