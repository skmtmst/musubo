import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../worker-env.js';

const mocks = vi.hoisted(() => ({
  recordSiteEvent: vi.fn(),
  consumePublicIngressReceipt: vi.fn(async () => true),
  getMeasurementSite: vi.fn(async () => ({ id: 'site_test', line_account_id: 'account-a', stopped_at: null })),
  siteAllowsHost: vi.fn(async () => true),
  normalizeSiteHost: (host: string) => host,
  linkVisitorToFriend: vi.fn(),
  getPageViewSummary: vi.fn(),
  getFriendSiteEvents: vi.fn(),
  getOrCreateSiteTrackingKey: vi.fn(),
  getSiteTrackingAccountId: vi.fn(),
  getSiteTrackingSummary: vi.fn(),
  getSiteConsentSummary: vi.fn(),
  recordSiteConsentDecision: vi.fn(),
  canAccess: vi.fn(),
  getVisibleScope: vi.fn(),
  SITE_EVENT_TYPES: ['page_view', 'click', 'scroll_depth', 'custom', 'purchase'],
}));
vi.mock('@line-crm/db', () => mocks);
vi.mock('../services/account-access.js', () => ({
  canAccessAllLineAccounts: mocks.canAccess,
  getVisibleLineAccountScope: mocks.getVisibleScope,
}));
// 公開収集口の機能検査はここでは on 固定にする。off の落とし方は
// feature-enforcement-site-tracking-route.test.ts が実DBで確かめる。
vi.mock('../services/feature-enforcement.js', () => ({
  accountFeatureIsEnabled: vi.fn(async () => true),
}));

const { siteTracking } = await import('./site-tracking.js');

const app = new Hono<Env>();
app.use('*', async (c, next) => {
  c.set('staff', { id: 'owner-1', name: 'Owner', role: 'owner', readOnly: false });
  await next();
});
app.route('/', siteTracking);
const env = {
  DB: {
    prepare: vi.fn(() => {
      const statement = {
        bind: vi.fn(() => statement),
        first: vi.fn(async () => ({ line_account_id: 'account-a' })),
      };
      return statement;
    }),
  } as unknown as D1Database,
  WORKER_URL: 'https://api.example.com',
};

function post(path: string, body: unknown, origin: string | null = 'https://shop.example.com') {
  return app.fetch(
    new Request(`https://example.com${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) },
      body: JSON.stringify({ siteId: 'site_test', sourceEventId: 'event-test-123', ...(body as object) }),
    }),
    env as unknown as Env['Bindings'],
  );
}

const VALID_ID = 'abc12345XYZ_-';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.recordSiteEvent.mockResolvedValue(undefined);
  mocks.linkVisitorToFriend.mockResolvedValue(true);
  mocks.getSiteTrackingAccountId.mockResolvedValue('account-a');
  mocks.getOrCreateSiteTrackingKey.mockResolvedValue('hk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  mocks.getSiteTrackingSummary.mockResolvedValue({});
  mocks.getSiteConsentSummary.mockResolvedValue({ granted: 0, declined: 0, suppressed: 0, grantedRate: null });
  mocks.recordSiteConsentDecision.mockResolvedValue(undefined);
  mocks.canAccess.mockResolvedValue(true);
  mocks.getVisibleScope.mockResolvedValue({
    accounts: [], allowedAccountIds: ['account-a'], canSeeUnassigned: false,
    ids: ['account-a'], isAccountScoped: false,
  });
  mocks.getPageViewSummary.mockResolvedValue([]);
  mocks.getFriendSiteEvents.mockResolvedValue([]);
});

describe('収集の受け口', () => {
  it('正しい形なら記録する', async () => {
    const res = await post('/api/site/collect', {
      visitorId: VALID_ID,
      trackingKey: 'hk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      eventType: 'page_view',
      host: 'shop.example.com',
      path: '/thanks',
    });
    expect(res.status).toBe(204);
    expect(mocks.recordSiteEvent).toHaveBeenCalledWith(env.DB, expect.objectContaining({
      visitorId: VALID_ID, lineAccountId: 'account-a', eventType: 'page_view', host: 'shop.example.com',
    }));
  });

  it('訪問者IDの形が違えば記録しない', async () => {
    const res = await post('/api/site/collect', {
      visitorId: 'x', trackingKey: 'hk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', eventType: 'page_view',
    });
    // 204 は返す。エラーの形を返すと、外から叩いて内部の様子を探れてしまう。
    expect(res.status).toBe(204);
    expect(mocks.recordSiteEvent).not.toHaveBeenCalled();
  });

  it('知らない種別は記録しない', async () => {
    const res = await post('/api/site/collect', {
      visitorId: VALID_ID,
      trackingKey: 'hk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      eventType: 'keystroke',
    });
    expect(res.status).toBe(204);
    expect(mocks.recordSiteEvent).not.toHaveBeenCalled();
  });

  it('記録に失敗しても 204 を返す', async () => {
    // 外のサイトの画面が、こちらの都合でエラーを出すべきではない。
    mocks.recordSiteEvent.mockRejectedValueOnce(new Error('DB down'));
    const res = await post('/api/site/collect', {
      visitorId: VALID_ID,
      trackingKey: 'hk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      eventType: 'page_view',
    });
    expect(res.status).toBe(204);
  });

  it('CORS の許可を返す', async () => {
    const res = await post('/api/site/collect', {
      visitorId: VALID_ID, trackingKey: 'hk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', eventType: 'page_view',
    });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://shop.example.com');
  });

  it('OPTIONS に答える', async () => {
    const res = await app.fetch(
      new Request('https://example.com/api/site/collect', { method: 'OPTIONS' }),
      env as unknown as Env['Bindings'],
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
  });

  it('数値でない valueNum は落とす', async () => {
    await post('/api/site/collect', {
      visitorId: VALID_ID,
      trackingKey: 'hk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      eventType: 'custom',
      valueNum: 'たくさん',
    });
    const [, input] = mocks.recordSiteEvent.mock.calls[0];
    expect(input.valueNum).toBeNull();
  });

  it('鍵なし・未知の鍵は記録しない', async () => {
    expect((await post('/api/site/collect', { visitorId: VALID_ID, eventType: 'page_view' })).status).toBe(204);
    expect(mocks.getSiteTrackingAccountId).not.toHaveBeenCalled();
    mocks.getSiteTrackingAccountId.mockResolvedValueOnce(null);
    expect((await post('/api/site/collect', {
      visitorId: VALID_ID,
      trackingKey: 'hk_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      eventType: 'page_view',
    })).status).toBe(204);
    expect(mocks.recordSiteEvent).not.toHaveBeenCalled();
  });
});

describe('同意 (#818)', () => {
  it('断られた・未回答の閲覧は、そのまま consent を渡して記録側に任せる', async () => {
    for (const consent of ['declined', 'unset'] as const) {
      await post('/api/site/collect', {
        visitorId: VALID_ID,
        trackingKey: 'hk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        eventType: 'page_view',
        path: '/thanks',
        consent,
      });
    }
    const sent = mocks.recordSiteEvent.mock.calls.map(([, input]) => input.consent);
    expect(sent).toEqual(['declined', 'unset']);
  });

  it('知らない同意の値は unset として渡す', async () => {
    await post('/api/site/collect', {
      visitorId: VALID_ID,
      trackingKey: 'hk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      eventType: 'page_view',
      path: '/thanks',
      consent: 'sure-i-consent',
    });
    const [, input] = mocks.recordSiteEvent.mock.calls[0];
    expect(input.consent).toBe('unset');
  });

  it('同意の答えは専用の箱に数え、行動は同意済みとして送る', async () => {
    await post('/api/site/collect', {
      visitorId: VALID_ID,
      trackingKey: 'hk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      eventType: 'page_view',
      path: '/thanks',
      consent: 'granted',
      consentDecision: 'granted',
    });
    expect(mocks.recordSiteConsentDecision).toHaveBeenCalledWith(env.DB, 'account-a', 'granted');
    expect(mocks.recordSiteEvent).toHaveBeenCalledWith(
      env.DB,
      expect.objectContaining({ consent: 'granted' }),
    );
  });
});

describe('埋め込むJS', () => {
  it('WorkerのURLが差し込まれる', async () => {
    const res = await app.fetch(
      new Request('https://example.com/api/site/script.js'),
      env as unknown as Env['Bindings'],
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('javascript');
    const body = await res.text();
    expect(body).toContain('https://api.example.com/api/site/collect');
    expect(body).toContain("getAttribute('data-key')");
    expect(body).toContain('payload.trackingKey = TRACKING_KEY');
  });

  it('クエリ文字列を送らない（パスだけ）', async () => {
    const res = await app.fetch(
      new Request('https://example.com/api/site/script.js'),
      env as unknown as Env['Bindings'],
    );
    const body = await res.text();
    // location.search を読んでいないこと。送らないに越したことはない。
    expect(body).toContain('location.pathname');
    expect(body).toContain('host: location.hostname');
    expect(body).not.toContain('location.search');
  });

  it('同意の案内と答えを送る仕組みが入っている', async () => {
    const res = await app.fetch(
      new Request('https://example.com/api/site/script.js'),
      env as unknown as Env['Bindings'],
    );
    const body = await res.text();
    // 答えるまでは consent が unset で送られ、サーバー側は記録しない。
    expect(body).toContain("readConsent() || 'unset'");
    expect(body).toContain('lh-consent');
    expect(body).toContain('window.lhConsent');
    expect(body).toContain('consentDecision');
  });
});

describe('友だちとの結びつけ', () => {
  it('形が正しければ結びつける', async () => {
    const res = await post('/api/site/link', {
      visitorId: VALID_ID,
      friendId: 'f-1',
      via: 'liff',
    });
    expect(res.status).toBe(200);
    expect(mocks.linkVisitorToFriend).toHaveBeenCalledWith(
      env.DB, VALID_ID, 'account-a', 'f-1', 'liff',
    );
  });

  it('知らない経路は manual に寄せる', async () => {
    await post('/api/site/link', { visitorId: VALID_ID, friendId: 'f-1', via: 'telepathy' });
    expect(mocks.linkVisitorToFriend).toHaveBeenCalledWith(
      env.DB, VALID_ID, 'account-a', 'f-1', 'manual',
    );
  });

  it('既に別の人と結びついていたら linked=false', async () => {
    // 上書きしない。同じ端末を家族で使う場合など、後から付け替わると
    // 過去の行動まで別人のものになる。
    mocks.linkVisitorToFriend.mockResolvedValue(false);
    const res = await post('/api/site/link', { visitorId: VALID_ID, friendId: 'f-2' });
    const body = (await res.json()) as { data: { linked: boolean } };
    expect(body.data.linked).toBe(false);
  });

  it('形が違えば400', async () => {
    const res = await post('/api/site/link', { visitorId: 'x', friendId: 'f-1' });
    expect(res.status).toBe(400);
  });
});

describe('管理画面のアカウント境界', () => {
  it('可視アカウントだけに安定した計測鍵を返す', async () => {
    const res = await app.fetch(
      new Request('https://example.com/api/site/tracking-key?accountId=account-a'),
      env as unknown as Env['Bindings'],
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      data: { accountId: 'account-a', trackingKey: 'hk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    });
    expect(mocks.getOrCreateSiteTrackingKey).toHaveBeenCalledWith(env.DB, 'account-a');
  });

  it('不可視アカウントの鍵・集計をDB処理前に隠す', async () => {
    const key = await app.fetch(
      new Request('https://example.com/api/site/tracking-key?accountId=account-b'),
      env as unknown as Env['Bindings'],
    );
    const summary = await app.fetch(
      new Request('https://example.com/api/site/summary?accountId=account-b'),
      env as unknown as Env['Bindings'],
    );
    expect(key.status).toBe(404);
    expect(summary.status).toBe(404);
    expect(mocks.getOrCreateSiteTrackingKey).not.toHaveBeenCalled();
    expect(mocks.getSiteTrackingSummary).not.toHaveBeenCalled();
  });

  it('単一の可視アカウントなら旧画面のaccountId省略を安全に補う', async () => {
    const summary = await app.fetch(
      new Request('https://example.com/api/site/summary'),
      env as unknown as Env['Bindings'],
    );

    expect(summary.status).toBe(200);
    expect(mocks.getSiteTrackingSummary).toHaveBeenCalledWith(env.DB, 'account-a');
  });

  it('複数アカウントではaccountId省略を拒否する', async () => {
    mocks.getVisibleScope.mockResolvedValue({
      accounts: [], allowedAccountIds: ['account-a', 'account-b'], canSeeUnassigned: false,
      ids: ['account-a', 'account-b'], isAccountScoped: false,
    });
    const summary = await app.fetch(
      new Request('https://example.com/api/site/summary'),
      env as unknown as Env['Bindings'],
    );

    expect(summary.status).toBe(400);
    expect(mocks.getSiteTrackingSummary).not.toHaveBeenCalled();
  });

  it('管理画面の account_id（rangeQueryの約束）で選んだアカウントを読む', async () => {
    // 監査の再現：複数アカウントの担当者が選んだ値を口が無視し、
    // 400で計測状況がエラーになっていた。account_id を受ければ直る。
    mocks.getVisibleScope.mockResolvedValue({
      accounts: [], allowedAccountIds: ['account-a', 'account-b'], canSeeUnassigned: false,
      ids: ['account-a', 'account-b'], isAccountScoped: false,
    });
    const summary = await app.fetch(
      new Request('https://example.com/api/site/summary?account_id=account-a'),
      env as unknown as Env['Bindings'],
    );
    expect(summary.status).toBe(200);
    expect(mocks.getSiteTrackingSummary).toHaveBeenCalledWith(env.DB, 'account-a');

    const pages = await app.fetch(
      new Request('https://example.com/api/site/pages?account_id=account-a'),
      env as unknown as Env['Bindings'],
    );
    expect(pages.status).toBe(200);

    const key = await app.fetch(
      new Request('https://example.com/api/site/tracking-key?account_id=account-a'),
      env as unknown as Env['Bindings'],
    );
    expect(key.status).toBe(200);
    expect(mocks.getOrCreateSiteTrackingKey).toHaveBeenCalledWith(env.DB, 'account-a');
  });

  it('集計とページ閲覧を選択アカウントで絞る', async () => {
    expect((await app.fetch(
      new Request('https://example.com/api/site/summary?accountId=account-a'),
      env as unknown as Env['Bindings'],
    )).status).toBe(200);
    expect(mocks.getSiteTrackingSummary).toHaveBeenCalledWith(env.DB, 'account-a');

    expect((await app.fetch(
      new Request('https://example.com/api/site/pages?accountId=account-a&from=2026-09-01&to=2026-09-07'),
      env as unknown as Env['Bindings'],
    )).status).toBe(200);
    expect(mocks.getPageViewSummary).toHaveBeenCalledWith(env.DB, {
      lineAccountId: 'account-a', from: '2026-09-01', to: '2026-09-07T23:59:59.999',
    });
  });

  it('ページ一覧と友だち詳細に計測先ホストを返す', async () => {
    mocks.getPageViewSummary.mockResolvedValueOnce([
      { host: 'shop.example.com', path: '/thanks', views: 4, visitors: 3 },
    ]);
    const pages = await app.fetch(
      new Request('https://example.com/api/site/pages?accountId=account-a'),
      env as unknown as Env['Bindings'],
    );
    expect(await pages.json()).toMatchObject({ data: [{ host: 'shop.example.com', path: '/thanks' }] });

    mocks.getFriendSiteEvents.mockResolvedValueOnce([{
      id: 'event-1', visitor_id: 'visitor-1', line_account_id: 'account-a', friend_id: 'friend-1',
      event_type: 'page_view', host: 'shop.example.com', path: '/thanks', label: null,
      value_num: null, referrer: null, occurred_at: '2026-09-08T10:00:00.000',
    }]);
    const detail = await app.fetch(
      new Request('https://example.com/api/friends/friend-1/site-events'),
      env as unknown as Env['Bindings'],
    );
    expect(await detail.json()).toMatchObject({ data: [{ host: 'shop.example.com', path: '/thanks' }] });
  });
});

it('API-02 rejects impossible date in page-view aggregation',async()=>{
 const res=await app.request('/api/site/pages?account_id=account-a&from=2026-02-30&to=2026-03-01',{},env as any);
 expect(res.status).toBe(400);expect(mocks.getPageViewSummary).not.toHaveBeenCalled();
});


describe('サイト計測の出どころと再送', () => {
  const body = { visitorId: VALID_ID, trackingKey: 'hk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', consent: 'granted' };
  it('許可していない送信元・送信元なしを記録しない', async () => {
    mocks.siteAllowsHost.mockResolvedValueOnce(false);
    await post('/api/site/collect', body, 'https://evil.example.com');
    await post('/api/site/collect', body, null);
    expect(mocks.recordSiteEvent).not.toHaveBeenCalled();
  });
  it('同じ受信IDを記録しない', async () => {
    mocks.consumePublicIngressReceipt.mockResolvedValueOnce(false);
    await post('/api/site/collect', body);
    expect(mocks.recordSiteEvent).not.toHaveBeenCalled();
  });
});
