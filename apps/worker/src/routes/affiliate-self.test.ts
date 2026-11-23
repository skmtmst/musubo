import { describe, it, expect, vi, beforeEach } from 'vitest';

// 実 D1 なしで冪等性・分離・20件上限を試すため、アフィリエイトの保存だけを小さなメモリストアへ差し替える。入口が即時 import する公開名も用意する。
const dbMocks = {

  listLineAccountsWithTenantStatus: vi.fn().mockResolvedValue([
    { id: 'account-main', login_channel_id: '2000000000', tenant_status: 'active', is_active: 1, archived_at: null },
  ]),
  getStaffByApiKey: vi.fn(),
  recoverStalledBroadcasts: vi.fn(),
  recoverStuckDeliveries: vi.fn(),

  getFriendByLineUserIdForAccount: vi.fn(),
  getAffiliateByFriendId: vi.fn(),
  createAffiliate: vi.fn(),
  createAffiliateLink: vi.fn(),
  listAffiliateLinks: vi.fn(),
  countAffiliateLinks: vi.fn(),
  getAffiliateLinkStats: vi.fn(),
  // リンク応答へ案件名を付ける処理も差し替える。
  listAffiliateOffers: vi.fn().mockResolvedValue([]),
  enrollAffiliateInOffer: vi.fn(),
  getMileageSummaryForFriend: vi.fn(),
  getMileageHistoryForFriend: vi.fn(),
  getMileageSelfInsights: vi.fn(),
  getMileageEarningOpportunitiesForFriend: vi.fn(),
  listMileageRewards: vi.fn(),
  getMileageRewardRedemptionCounts: vi.fn(),
  reserveMileageRewardRedemption: vi.fn(),
  encryptCredential: vi.fn(),
  getAffiliateBankProfile: vi.fn(),
  saveAffiliateBankProfile: vi.fn(),
  listAffiliateStatementsForSelf: vi.fn(),
  getAffiliateStatementDownload: vi.fn(),
  MileageRewardError: class MileageRewardError extends Error {
    constructor(public code: string, message: string, public status = 400) { super(message); }
  },
  generateRefSlug: vi.fn(() => 'slug00'),
  // URL 解決が使うアカウント設定の読込を差し替える。
  getLinkBaseUrl: vi.fn().mockResolvedValue(null),
};
vi.mock('@line-crm/db', () => dbMocks);

const deliveryMocks = { deliverMileageReward: vi.fn() };
vi.mock('../features/mileage/mileage-reward-delivery.js', () => deliveryMocks);
const mileageSourceMocks = vi.hoisted(() => ({ resolveMileageSource: vi.fn().mockResolvedValue('musubo'), getEcMileageBalance: vi.fn(), hasHeldMileageRedemption: vi.fn().mockResolvedValue(false) }));
vi.mock('../services/mileage-ec-source.js', () => mileageSourceMocks);

// 差替済みのヘルパを入口へ接続するため、モック登録後に読み込む。
const worker = (await import('../index.js')).default;

const DB = {} as D1Database;

// 別アプリのトークンでなりすまさないよう、verify の client_id が環境の既定または DB のログインチャネルに属することを検証する。
const LOGIN_CHANNEL_ID = '2000000000';

const imagesGet = vi.fn();
const imagesHead = vi.fn().mockResolvedValue({ size: 100 });
const env = {
  DB,
  API_KEY: 'fixture-download-signing-key',
  LIFF_URL: 'https://liff.line.me/1000000000-DefaultAA',
  WORKER_URL: 'https://worker.example.com',
  LINE_LOGIN_CHANNEL_ID: LOGIN_CHANNEL_ID,
  LINE_CHANNEL_SECRET: 'wallet-link-secret',
  LINE_CREDENTIAL_ENCRYPTION_KEY: 'test-encryption-key',
  IMAGES: { get: imagesGet, head: imagesHead },
} as unknown as import('../index.js').Env['Bindings'];

function call(path: string, init?: RequestInit) {
  const target = new URL(`https://worker.example.com${path}`);
  const token = target.searchParams.get('lineAccessToken');
  if (token && !target.pathname.includes('/statements/')) {
    target.searchParams.delete('lineAccessToken');
    const headers = new Headers(init?.headers); headers.set('Authorization', `Bearer ${token}`);
    init = { ...init, headers }; path = target.pathname + target.search;
  }
  return worker.fetch(
    new Request(`https://worker.example.com${path}`, init),
    env,
    { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
  );
}

// 既知のトークンは LINE 利用者 ID へ対応させ、未知のトークンは verify で401とする。トークン検証とプロフィール解決の境界を試す。
const TOKEN_TO_USER: Record<string, string> = {
  'tok-alice': 'U-alice',
  'tok-bob': 'U-bob',
};

function installLineFetchMock(clientId: string = LOGIN_CHANNEL_ID) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url.startsWith('https://api.line.me/oauth2/v2.1/verify')) {
        const token = new URL(url).searchParams.get('access_token') || '';
        if (TOKEN_TO_USER[token]) {
          return new Response(JSON.stringify({ client_id: clientId, expires_in: 100 }), {
            status: 200,
          });
        }
        return new Response('invalid', { status: 400 });
      }

      if (url === 'https://api.line.me/v2/profile') {
        const auth = (init?.headers as Record<string, string>)?.Authorization || '';
        const token = auth.replace(/^Bearer /, '');
        const userId = TOKEN_TO_USER[token];
        if (!userId) return new Response('unauthorized', { status: 401 });
        return new Response(JSON.stringify({ userId, displayName: 'ignored' }), {
          status: 200,
        });
      }

      return new Response('not found', { status: 404 });
    }),
  );
}


type AffRow = { id: string; name: string; code: string; commission_rate: number; is_active: number; created_at: string; friend_id: string };
type LinkRow = { id: string; affiliate_id: string; ref_code: string; label: string | null; line_account_id: string | null; is_active: number; created_at: string; click_count: number };

let affiliatesByFriend: Map<string, AffRow>;
let linksByAffiliate: Map<string, LinkRow[]>;
let statsByAffiliate: Map<string, Map<string, { friendAdds: number; conversions: number; conversionsPending: number; conversionsApproved: number }>>;
let slugCounter: number;

const FRIENDS: Record<string, { id: string; display_name: string; user_id: string; line_account_id: string }> = {
  'U-alice': { id: 'friend-alice', display_name: 'Alice', user_id: 'user-alice', line_account_id: 'account-main' },
  'U-bob': { id: 'friend-bob', display_name: 'Bob', user_id: 'user-bob', line_account_id: 'account-main' },
};

function installStore() {
  affiliatesByFriend = new Map();
  linksByAffiliate = new Map();
  statsByAffiliate = new Map();
  slugCounter = 0;

  // 新規リンクの集計は既定0とし、値を設定した試験では serializeLink が実値を返すことを確かめる。
  dbMocks.getAffiliateLinkStats.mockImplementation(async (_db: unknown, affiliateId: string) => {
    return statsByAffiliate.get(affiliateId) ?? new Map();
  });

  dbMocks.getFriendByLineUserIdForAccount.mockImplementation(async (_db: unknown, lineUserId: string) => {
    return FRIENDS[lineUserId] ?? null;
  });

  dbMocks.getAffiliateByFriendId.mockImplementation(async (_db: unknown, friendId: string) => {
    for (const aff of affiliatesByFriend.values()) {
      if (aff.friend_id === friendId) return aff;
    }
    return null;
  });

  dbMocks.createAffiliate.mockImplementation(
    async (_db: unknown, input: { name: string; code: string; friendId?: string }) => {
      const aff: AffRow = {
        id: `aff-${input.friendId ?? input.code}`,
        name: input.name,
        code: input.code,
        commission_rate: 0,
        is_active: 1,
        created_at: '2026-01-01 00:00:00',
        friend_id: input.friendId ?? '',
      };
      affiliatesByFriend.set(aff.id, aff);
      linksByAffiliate.set(aff.id, []);
      return aff;
    },
  );

  dbMocks.createAffiliateLink.mockImplementation(
    async (_db: unknown, input: { affiliateId: string; label?: string | null }) => {
      const link: LinkRow = {
        id: crypto.randomUUID(),
        affiliate_id: input.affiliateId,
        ref_code: `slug${String(slugCounter++).padStart(2, '0')}`,
        label: input.label ?? null,
        line_account_id: null,
        is_active: 1,
        created_at: '2026-01-01 00:00:00',
        click_count: 0,
      };
      const arr = linksByAffiliate.get(input.affiliateId) ?? [];
      arr.unshift(link);
      linksByAffiliate.set(input.affiliateId, arr);
      return link;
    },
  );

  dbMocks.listAffiliateLinks.mockImplementation(async (_db: unknown, affiliateId: string) => {
    return linksByAffiliate.get(affiliateId) ?? [];
  });

  dbMocks.countAffiliateLinks.mockImplementation(async (_db: unknown, affiliateId: string) => {
    return (linksByAffiliate.get(affiliateId) ?? []).length;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  imagesGet.mockReset();
  dbMocks.listLineAccountsWithTenantStatus.mockResolvedValue([
    { id: 'account-main', login_channel_id: LOGIN_CHANNEL_ID, tenant_status: 'active', is_active: 1, archived_at: null },
  ]);
  // 案件がなければ offerId/offerName は null とする。
  dbMocks.listAffiliateOffers.mockResolvedValue([]);
  dbMocks.getMileageSummaryForFriend.mockResolvedValue({
    programId: 'default',
    programName: 'Harnessマイル',
    available: 500,
    pending: 0,
    lifetimeEarned: 500,
    spent: 0,
  });
  dbMocks.getMileageHistoryForFriend.mockResolvedValue([]);
  dbMocks.getMileageSelfInsights.mockResolvedValue({
    accountCount: 2,
    rewardedActions: 12,
    referralMiles: 180,
    qualityReferralCount: 3,
    lastEarnedAt: '2026-08-09T20:00:00+09:00',
  });
  dbMocks.getMileageEarningOpportunitiesForFriend.mockResolvedValue([
    {
      id: 'webinar:webinar-1',
      type: 'webinar',
      title: 'AI活用ウェビナー',
      description: 'まず5分視聴で +5 mile',
      rewardMiles: 55,
      nextRewardMiles: 5,
      progressPercent: 0,
      ctaLabel: '今すぐ参加する',
      url: 'https://liff.line.me/123/?page=webinar&slug=ai',
    },
  ]);
  dbMocks.listMileageRewards.mockResolvedValue([]);
  dbMocks.getMileageRewardRedemptionCounts.mockResolvedValue({
    beneficiaryKey: 'user:user-alice',
    byRewardId: new Map(),
    byVersionId: new Map(),
  });
  dbMocks.reserveMileageRewardRedemption.mockResolvedValue({
    kind: 'created',
    redemption: { id: 'redemption-1' },
  });
  dbMocks.encryptCredential.mockResolvedValue('encrypted-account-number');
  dbMocks.getAffiliateBankProfile.mockResolvedValue(null);
  dbMocks.saveAffiliateBankProfile.mockResolvedValue({
    kind: 'created',
    profile: {
      affiliateId: 'aff-friend-alice', lineAccountId: 'account-main',
      bankCode: '0001', bankName: 'テスト銀行', branchCode: '001', branchName: '本店',
      accountType: 'ordinary', accountLast4: '4567', accountHolderName: 'ALICE',
      version: 1, updatedAt: '2026-09-07T00:00:00.000Z',
    },
  });
  dbMocks.listAffiliateStatementsForSelf.mockResolvedValue([]);
  dbMocks.getAffiliateStatementDownload.mockResolvedValue(null);
  deliveryMocks.deliverMileageReward.mockResolvedValue({
    status: 'succeeded',
    message: '交換しました',
  });
  installLineFetchMock();
  installStore();
});

describe('POST /api/liff/affiliate/register — idempotency', () => {
  it('(a) registers once, then returns the SAME affiliate on repeat calls', async () => {
    const res1 = await call('/api/liff/affiliate/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lineAccessToken: 'tok-alice' }),
    });
    expect(res1.status).toBe(200);
    const body1 = (await res1.json()) as { affiliate: { id: string; name: string }; links: unknown[] };
    expect(body1.affiliate.name).toBe('Alice');
    expect(dbMocks.getFriendByLineUserIdForAccount).toHaveBeenCalledWith(
      DB,
      'U-alice',
      'account-main',
    );
    // 登録時の初期リンクは1本だけ発行する。
    expect(body1.links).toHaveLength(1);

    // 再送で別の参加者を作らず、同じ ID を返す。
    const res2 = await call('/api/liff/affiliate/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lineAccessToken: 'tok-alice' }),
    });
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as { affiliate: { id: string } };
    expect(body2.affiliate.id).toBe(body1.affiliate.id);
    // 2回の登録でも createAffiliate は1回だけ呼ぶ。
    expect(dbMocks.createAffiliate).toHaveBeenCalledTimes(1);
  });
});

describe('GET /api/liff/mileage/me — generic wallet', () => {
  it('ECの店では顧客にもECの残高を返す', async () => {
    mileageSourceMocks.resolveMileageSource.mockResolvedValueOnce('ec');
    mileageSourceMocks.getEcMileageBalance.mockResolvedValueOnce(29);
    const res = await call('/api/liff/mileage/me?lineAccessToken=tok-alice');
    expect((await res.json() as any).mileage).toMatchObject({ available: 29, balanceSource: 'ec' });
  });
  it('EC残高未取得はmusubo残高や0にしない', async () => {
    mileageSourceMocks.resolveMileageSource.mockResolvedValueOnce('ec');
    mileageSourceMocks.getEcMileageBalance.mockResolvedValueOnce(null);
    const res = await call('/api/liff/mileage/me?lineAccessToken=tok-alice');
    expect((await res.json() as any).mileage).toMatchObject({ available: null, balanceSource: 'ec' });
  });
  it('取得元を判定できないときはmusubo残高を返さない', async () => {
    mileageSourceMocks.resolveMileageSource.mockRejectedValueOnce(new Error('unreadable'));
    const res = await call('/api/liff/mileage/me?lineAccessToken=tok-alice');
    expect(res.status).toBeGreaterThanOrEqual(500);
  });
  it('returns mileage without requiring affiliate registration', async () => {
    const res = await call('/api/liff/mileage/me?lineAccessToken=tok-alice&limit=10');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      mileage: { available: number };
      history: unknown[];
      insights: { accountCount: number; referralMiles: number; qualityReferralCount: number };
      opportunities: Array<{ type: string; rewardMiles: number; ctaLabel: string }>;
    };
    expect(body.mileage.available).toBe(500);
    expect(body.insights).toMatchObject({
      accountCount: 2,
      referralMiles: 180,
      qualityReferralCount: 3,
    });
    expect(body.opportunities[0]).toMatchObject({
      type: 'webinar',
      rewardMiles: 55,
      ctaLabel: '今すぐ参加する',
    });
    expect(dbMocks.getMileageSummaryForFriend).toHaveBeenCalledWith(DB, 'friend-alice');
    expect(dbMocks.getMileageHistoryForFriend).toHaveBeenCalledWith(
      DB,
      'friend-alice',
      { limit: 10 },
    );
    expect(dbMocks.getMileageSelfInsights).toHaveBeenCalledWith(DB, 'friend-alice');
    expect(dbMocks.getMileageEarningOpportunitiesForFriend).toHaveBeenCalledWith(
      DB,
      'friend-alice',
    );
    expect(dbMocks.getAffiliateByFriendId).not.toHaveBeenCalled();
  });

  it('signs cross-account friend-add missions for the verified wallet owner', async () => {
    dbMocks.getMileageEarningOpportunitiesForFriend.mockResolvedValueOnce([
      {
        id: 'friend-add:account-2',
        type: 'friend_add',
        title: '公式②を友だち追加',
        description: '友だち追加で +5 mile',
        rewardMiles: 5,
        nextRewardMiles: 5,
        progressPercent: 0,
        ctaLabel: '友だち追加する',
        url: 'https://liff.line.me/2000000000-Second/?page=affiliate',
        targetAccountId: 'account-2',
      },
    ]);

    const res = await call('/api/liff/mileage/me?lineAccessToken=tok-alice');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { opportunities: Array<{ url: string }> };
    const missionUrl = new URL(body.opportunities[0].url);
    expect(missionUrl.searchParams.get('crossAccountToken')).toMatch(/^v2\./u);
  });
});

describe('LIFF mileage rewards — verified account and real limits', () => {
  it('EC管理の店には交換可能な使い道を返さない', async () => {
    mileageSourceMocks.resolveMileageSource.mockResolvedValueOnce('ec');
    mileageSourceMocks.getEcMileageBalance.mockResolvedValueOnce(29);
    mileageSourceMocks.hasHeldMileageRedemption.mockResolvedValueOnce(true);
    const response = await call('/api/liff/mileage/rewards?lineAccessToken=tok-alice');
    expect(await response.json()).toMatchObject({ balanceSource: 'ec', availableMiles: 29, hasHeldRedemption: true, rewards: [] });
    expect(mileageSourceMocks.hasHeldMileageRedemption).toHaveBeenCalledWith(DB, 'account-main', expect.any(String));
    expect(dbMocks.listMileageRewards).not.toHaveBeenCalled();
  });
  it('ECで管理する店は交換を拒否して台帳を変更しない', async () => {
    mileageSourceMocks.resolveMileageSource.mockResolvedValueOnce('ec');
    const response = await call('/api/liff/mileage/rewards/reward-1/redeem', {
      method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': '018f6c6e-7b37-4a2f-8a71-1e1224dbdb93' },
      body: JSON.stringify({ lineAccessToken: 'tok-alice' }),
    });
    expect(response.status).toBe(409);
    expect((await response.json() as any).error.code).toBe('MILEAGE_MANAGED_BY_EC');
    expect(dbMocks.reserveMileageRewardRedemption).not.toHaveBeenCalled();
  });
  it('取得元が読めなければ交換を拒否する', async () => {
    mileageSourceMocks.resolveMileageSource.mockRejectedValueOnce(new Error('unreadable'));
    const response = await call('/api/liff/mileage/rewards/reward-1/redeem', {
      method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': '018f6c6e-7b37-4a2f-8a71-1e1224dbdb93' },
      body: JSON.stringify({ lineAccessToken: 'tok-alice' }),
    });
    expect(response.status).toBe(503);
    expect((await response.json() as any).error.code).toBe('MILEAGE_SOURCE_UNAVAILABLE');
    expect(dbMocks.reserveMileageRewardRedemption).not.toHaveBeenCalled();
  });
  it('rejects a legacy fallback friend from a different LINE account', async () => {
    dbMocks.getFriendByLineUserIdForAccount.mockResolvedValueOnce({
      ...FRIENDS['U-alice'],
      line_account_id: 'account-other',
    });

    const response = await call('/api/liff/mileage/rewards?lineAccessToken=tok-alice');

    expect(response.status).toBe(404);
    expect(dbMocks.listMileageRewards).not.toHaveBeenCalled();
  });

  it('does not say redeemable after the per-person limit is reached', async () => {
    dbMocks.listMileageRewards.mockResolvedValueOnce([{
      id: 'reward-1',
      hqTemplateId: 'hq-private',
      rewardKind: 'coupon',
      availableCodeCount: 2,
      currentVersion: {
        id: 'reward-version-1', requiredMiles: 300, perFriendLimit: 1, stockLimit: 10,
      },
    }]);
    dbMocks.getMileageRewardRedemptionCounts.mockResolvedValueOnce({
      beneficiaryKey: 'user:user-alice',
      byRewardId: new Map([['reward-1', 1]]),
      byVersionId: new Map([['reward-version-1', 1]]),
    });

    const response = await call('/api/liff/mileage/rewards?lineAccessToken=tok-alice');
    expect(response.status).toBe(200);
    const body = await response.json() as { rewards: Array<{ canRedeem: boolean; unavailableReason: string }> };
    expect(body.rewards[0]).not.toHaveProperty('hqTemplateId');
    expect(body.rewards[0]).toMatchObject({
      canRedeem: false,
      unavailableReason: 'この使い道の交換上限に達しています',
    });
  });

  it('requires idempotency and reserves only for the friend resolved from LINE', async () => {
    const missing = await call('/api/liff/mileage/rewards/reward-1/redeem', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lineAccessToken: 'tok-alice' }),
    });
    expect(missing.status).toBe(400);

    const response = await call('/api/liff/mileage/rewards/reward-1/redeem', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': '018f6c6e-7b37-4a2f-8a71-1e1224dbdb93' },
      body: JSON.stringify({ lineAccessToken: 'tok-alice' }),
    });
    expect(response.status).toBe(200);
    expect(dbMocks.reserveMileageRewardRedemption).toHaveBeenCalledWith(DB, expect.objectContaining({
      lineAccountId: 'account-main',
      friendId: 'friend-alice',
      rewardId: 'reward-1',
      idempotencyKey: '018f6c6e-7b37-4a2f-8a71-1e1224dbdb93',
    }));
  });
});

describe('GET /api/liff/affiliate/me — cross-affiliate isolation', () => {
  it('(b) a token only ever surfaces its own affiliate data', async () => {

    await call('/api/liff/affiliate/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lineAccessToken: 'tok-alice' }),
    });
    await call('/api/liff/affiliate/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lineAccessToken: 'tok-bob' }),
    });

    const resAlice = await call('/api/liff/affiliate/me?lineAccessToken=tok-alice');
    const alice = (await resAlice.json()) as { affiliate: { name: string; friendId?: string }; links: unknown[] };
    expect(alice.affiliate.name).toBe('Alice');

    const resBob = await call('/api/liff/affiliate/me?lineAccessToken=tok-bob');
    const bob = (await resBob.json()) as { affiliate: { name: string } };
    expect(bob.affiliate.name).toBe('Bob');

    // 本人の応答に別の参加者の ID を混ぜない。
    expect(JSON.stringify(alice)).not.toContain('friend-bob');
    expect(JSON.stringify(bob)).not.toContain('friend-alice');
  });

  it('me response shape carries refCode/label/url/clickCount/friendAdds/conversions', async () => {
    const reg = await call('/api/liff/affiliate/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lineAccessToken: 'tok-alice' }),
    });
    const regBody = (await reg.json()) as {
      affiliate: { id: string };
      links: Array<{ refCode: string }>;
    };
    const affId = regBody.affiliate.id;
    const refCode = regBody.links[0].refCode;

    // 保存したリンク別集計が、応答まで正しい値で届くことを確かめる。
    statsByAffiliate.set(affId, new Map([[refCode, { friendAdds: 3, conversions: 2, conversionsPending: 1, conversionsApproved: 1 }]]));

    const res = await call('/api/liff/affiliate/me?lineAccessToken=tok-alice');
    const body = (await res.json()) as {
      links: Array<{ refCode: string; label: string | null; url: string; clickCount: number; friendAdds: number; conversions: number; conversionsPending: number; conversionsApproved: number }>;
    };
    expect(body.links).toHaveLength(1);
    const link = body.links[0];
    expect(typeof link.refCode).toBe('string');
    expect(link.url).toBe(`https://worker.example.com/r/${link.refCode}`);
    expect(link.clickCount).toBe(0);
    // リンクの集計は仮値でなく取得した値を返す。
    expect(link.friendAdds).toBe(3);
    expect(link.conversions).toBe(2);
    expect(link.conversionsPending).toBe(1);
    expect(link.conversionsApproved).toBe(1);
  });

  it('a link with no stats entry defaults friendAdds/conversions to 0', async () => {
    await call('/api/liff/affiliate/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lineAccessToken: 'tok-alice' }),
    });
    // 集計を設定しないリンクでは、取得結果は空の対応表になる。
    const res = await call('/api/liff/affiliate/me?lineAccessToken=tok-alice');
    const body = (await res.json()) as {
      links: Array<{ friendAdds: number; conversions: number }>;
    };
    expect(body.links[0].friendAdds).toBe(0);
    expect(body.links[0].conversions).toBe(0);
  });
});

describe('POST /api/liff/affiliate/links — 20-link cap', () => {
  it('(c) the 21st self-issued link is rejected with 400', async () => {
    await call('/api/liff/affiliate/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lineAccessToken: 'tok-alice' }),
    });
    // 初期の1本と追加19本で、上限20本ちょうどになる。
    for (let i = 0; i < 19; i++) {
      const r = await call('/api/liff/affiliate/links', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ lineAccessToken: 'tok-alice', label: `L${i}` }),
      });
      expect(r.status).toBe(200);
    }
    // 20本まで作り、21本目が拒まれることを確かめる。
    const over = await call('/api/liff/affiliate/links', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lineAccessToken: 'tok-alice', label: 'over' }),
    });
    expect(over.status).toBe(400);
  });
});

describe('LINE token verification', () => {
  it('(d) an invalid token yields 401 on every endpoint', async () => {
    const reg = await call('/api/liff/affiliate/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lineAccessToken: 'tok-nope' }),
    });
    expect(reg.status).toBe(401);

    const me = await call('/api/liff/affiliate/me?lineAccessToken=tok-nope');
    expect(me.status).toBe(401);

    const links = await call('/api/liff/affiliate/links', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lineAccessToken: 'tok-nope' }),
    });
    expect(links.status).toBe(401);

    // トークンが有効でも友だち行がなければ404とし、参加者も作らない。
    dbMocks.getFriendByLineUserIdForAccount.mockImplementationOnce(async () => null);
    const ghost = await call('/api/liff/affiliate/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lineAccessToken: 'tok-alice' }),
    });
    expect(ghost.status).toBe(404);
  });

  it('(d2) a token minted by a foreign LINE Login channel is rejected with 401', async () => {
    // トークンが実在しても、別のログインチャネルならなりすましを防ぐため拒む。
    installLineFetchMock('9999999999');

    const reg = await call('/api/liff/affiliate/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lineAccessToken: 'tok-alice' }),
    });
    expect(reg.status).toBe(401);
    // 別チャネルのトークンでは参加者を作らない。
    expect(dbMocks.createAffiliate).not.toHaveBeenCalled();

    const me = await call('/api/liff/affiliate/me?lineAccessToken=tok-alice');
    expect(me.status).toBe(401);
  });

  it('(d3) accepts a token whose client_id matches a DB account login channel', async () => {
    // 環境の既定と違っても、所属アカウントに保存したログインチャネルは許可する。
    installLineFetchMock('3000000000');
    dbMocks.listLineAccountsWithTenantStatus.mockResolvedValue([
      {
        id: 'account-main',
        login_channel_id: '3000000000',
        tenant_status: 'active', is_active: 1, archived_at: null,
      } as unknown as never,
    ]);

    const reg = await call('/api/liff/affiliate/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lineAccessToken: 'tok-alice' }),
    });
    expect(reg.status).toBe(200);
  });

  it('(d4) rejects a verified token for a suspended tenant before any write', async () => {
    dbMocks.listLineAccountsWithTenantStatus.mockResolvedValue([
      {
        id: 'account-main',
        login_channel_id: LOGIN_CHANNEL_ID,
        tenant_status: 'suspended',
      } as unknown as never,
    ]);

    const reg = await call('/api/liff/affiliate/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lineAccessToken: 'tok-alice' }),
    });

    expect(reg.status).toBe(503);
    await expect(reg.json()).resolves.toMatchObject({ success: false, error: { code: 'TENANT_SUSPENDED' } });
    expect(dbMocks.getFriendByLineUserIdForAccount).not.toHaveBeenCalled();
    expect(dbMocks.createAffiliate).not.toHaveBeenCalled();
  });
});

describe('POST /api/liff/affiliate/register — concurrent double-register', () => {
  it('(e) a UNIQUE(friend_id) violation on INSERT recovers the existing affiliate', async () => {
    // 事前確認後に INSERT が一意制約で競合する形を再現し、負けた要求も勝者の保存行を返して冪等になることを確かめる。
    const winner: AffRow = {
      id: 'aff-winner',
      name: 'Alice',
      code: 'wincode',
      commission_rate: 0,
      is_active: 1,
      created_at: '2026-01-01 00:00:00',
      friend_id: 'friend-alice',
    };
    linksByAffiliate.set(winner.id, []);

    // 事前確認では未登録に見える状態を作る。
    dbMocks.getAffiliateByFriendId.mockResolvedValueOnce(null);
    // 同時 INSERT に負けた状態を作る。
    dbMocks.createAffiliate.mockRejectedValueOnce(
      new Error('D1_ERROR: UNIQUE constraint failed: affiliates.friend_id'),
    );
    // 例外後の再取得では、勝者が確定した行を返す。
    dbMocks.getAffiliateByFriendId.mockResolvedValueOnce(winner);

    const res = await call('/api/liff/affiliate/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lineAccessToken: 'tok-alice' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { affiliate: { id: string } };
    expect(body.affiliate.id).toBe('aff-winner');
    // 競合に負けた要求は初期リンクを二重発行しない。
    expect(dbMocks.createAffiliateLink).not.toHaveBeenCalled();
  });
});

describe('LIFF affiliate bank and statements', () => {
  async function registerAlice() {
    const response = await call('/api/liff/affiliate/register', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lineAccessToken: 'tok-alice' }),
    });
    expect(response.status).toBe(200);
  }

  it('誤った振込先は欄ごとの理由を400で返し、秘密値を返さない', async () => {
    const res = await call('/api/liff/affiliate/bank', { method: 'PUT', headers: { 'content-type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ lineAccessToken: 'tok-alice', bankCode: '1', bankName: '', branchCode: 'abc', branchName: '', accountType: 'invalid', accountNumber: 'secret', accountHolderName: '', expectedVersion: 0 }) });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { fieldErrors: { field: string; message: string }[] } };
    expect(body.error.fieldErrors.map(item => item.field).sort()).toEqual(['bankCode', 'bankName', 'branchCode', 'branchName', 'accountType', 'accountNumber', 'accountHolderName'].sort());
    expect(JSON.stringify(body)).not.toContain('secret');
    expect(dbMocks.saveAffiliateBankProfile).not.toHaveBeenCalled();
  });

  it('LINEで再照合した本人だけが振込先を保存し、口座番号を返さない', async () => {
    await registerAlice();
    const response = await call('/api/liff/affiliate/bank', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': '018f6c6e-7b37-4a2f-8a71-1e1224dbba01' },
      body: JSON.stringify({
        lineAccessToken: 'tok-alice', bankCode: '0001', bankName: 'テスト銀行',
        branchCode: '001', branchName: '本店', accountType: 'ordinary',
        accountNumber: '1234567', accountHolderName: 'ALICE', expectedVersion: 0,
      }),
    });
    expect(response.status).toBe(201);
    expect(dbMocks.encryptCredential).toHaveBeenCalledWith('1234567', 'test-encryption-key');
    expect(dbMocks.saveAffiliateBankProfile).toHaveBeenCalledWith(DB, expect.objectContaining({
      affiliateId: expect.stringContaining('friend-alice'), lineAccountId: 'account-main',
      accountLast4: '4567', encryptedAccountNumber: 'encrypted-account-number',
    }));
    const json = JSON.stringify(await response.json());
    expect(json).not.toContain('1234567');
    expect(json).not.toContain('encrypted-account-number');
    expect(json).toContain('4567');
  });

  it('振込先の版競合を409にし、別の紹介者IDを入力で指定させない', async () => {
    await registerAlice();
    dbMocks.saveAffiliateBankProfile.mockResolvedValueOnce({ kind: 'changed' });
    const response = await call('/api/liff/affiliate/bank', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': '018f6c6e-7b37-4a2f-8a71-1e1224dbba02' },
      body: JSON.stringify({
        lineAccessToken: 'tok-alice', affiliateId: 'affiliate-bob',
        bankCode: '0001', bankName: 'テスト銀行', branchCode: '001', branchName: '本店',
        accountType: 'ordinary', accountNumber: '1234567', accountHolderName: 'ALICE', expectedVersion: 1,
      }),
    });
    expect(response.status).toBe(409);
    expect(dbMocks.saveAffiliateBankProfile).toHaveBeenCalledWith(DB, expect.objectContaining({
      affiliateId: expect.stringContaining('friend-alice'),
    }));
  });

  it('自分の明細だけを一覧・downloadする', async () => {
    await registerAlice();
    dbMocks.listAffiliateStatementsForSelf.mockResolvedValueOnce([{ id: 'statement-1', totalAmount: 5000 }]);
    const list = await call('/api/liff/affiliate/statements', { headers: { Authorization: 'Bearer tok-alice' } });
    expect(list.status).toBe(200);
    expect(dbMocks.listAffiliateStatementsForSelf).toHaveBeenCalledWith(DB, expect.objectContaining({
      lineAccountId: 'account-main', affiliateId: expect.stringContaining('friend-alice'),
    }));

    dbMocks.getAffiliateStatementDownload.mockResolvedValue({
      statement: { id: 'statement-1' }, objectKey: 'affiliate-statements/statement-1.pdf', checksum: 'sum',
    });
    imagesGet.mockResolvedValueOnce({ body: 'pdf-body' });
    const issued = await call('/api/liff/affiliate/statements/statement-1/download?issue=1', { headers: { Authorization: 'Bearer tok-alice' } });
    expect(issued.status).toBe(200);
    const { data } = await issued.json() as { data: { url: string } };
    expect(data.url).not.toContain('tok-alice');
    const download = await call(new URL(data.url).pathname + new URL(data.url).search, { headers: { Authorization: 'Bearer tok-alice' } });
    expect(download.status).toBe(200);
    expect(download.headers.get('content-type')).toBe('application/pdf');
    expect(dbMocks.getAffiliateStatementDownload).toHaveBeenCalledWith(DB, expect.objectContaining({
      affiliateId: expect.stringContaining('friend-alice'), statementId: 'statement-1',
    }));
  });
  it('消した明細には署名を発行せず、他の本人の発行条件も自分の所属に固定する', async () => {
    await registerAlice();
    dbMocks.getAffiliateStatementDownload.mockResolvedValue({ statement: { id: 'statement-1' }, objectKey: 'missing.pdf' });
    imagesHead.mockResolvedValueOnce(null);
    const response = await call('/api/liff/affiliate/statements/statement-1/download?issue=1', { headers: { Authorization: 'Bearer tok-alice' } });
    expect(response.status).toBe(404); expect(imagesGet).not.toHaveBeenCalled();
    dbMocks.getAffiliateStatementDownload.mockResolvedValueOnce(null);
    expect((await call('/api/liff/affiliate/statements/foreign/download?issue=1&affiliateId=bob&lineAccountId=other', { headers: { Authorization: 'Bearer tok-alice' } })).status).toBe(404);
    expect(dbMocks.getAffiliateStatementDownload).toHaveBeenLastCalledWith(DB, expect.objectContaining({
      affiliateId: expect.stringContaining('friend-alice'), lineAccountId: 'account-main', statementId: 'foreign',
    }));
  });
  it('認証情報をqueryへ戻せず、別人・別明細・期限切れの署名はR2を読まない', async () => {
    await registerAlice();
    dbMocks.getAffiliateStatementDownload.mockImplementation(async (_db, input) => ({
      statement: { id: input.statementId }, objectKey: 'fixture.pdf', checksum: null,
    }));
    const path = '/api/liff/affiliate/statements/statement-1/download';
    const headers = { Authorization: 'Bearer tok-alice' };
    const legacy = await call(`${path}?lineAccessToken=tok-alice`);
    expect(legacy.status).toBe(303);
    expect(legacy.headers.get('location')).toBe('https://worker.example.com/liff/statements/statement-1');
    expect(await legacy.text()).not.toContain('pdf-body');
    expect((await call(path, { headers })).status).toBe(403);
    const issued = await call(`${path}?issue=1`, { headers });
    const { data } = await issued.json() as { data: { url: string } };
    const url = new URL(data.url);
    expect((await call(url.pathname + url.search)).status).toBe(400);
    await call('/api/liff/affiliate/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lineAccessToken: 'tok-bob' }) });
    expect((await call(url.pathname + url.search, { headers: { Authorization: 'Bearer tok-bob' } })).status).toBe(403);
    expect((await call(url.pathname.replace('statement-1', 'statement-2') + url.search, { headers })).status).toBe(403);
    const now = vi.spyOn(Date, 'now').mockReturnValue(Number(url.searchParams.get('expires')) * 1000);
    try { expect((await call(url.pathname + url.search, { headers })).status).toBe(403); }
    finally { now.mockRestore(); }
    expect(imagesGet).not.toHaveBeenCalled();
  });
});

it.each(['/api/liff/mileage/me', '/api/liff/mileage/rewards', '/api/liff/affiliate/me', '/api/liff/affiliate/bank', '/api/liff/affiliate/offers'])('rejects credentials in query even with a valid Bearer at %s', async path => {
  const res = await worker.fetch(new Request(`https://worker.example.com${path}?lineAccessToken=tok-alice`, {
    headers: { Authorization: 'Bearer tok-alice' },
  }), env, { waitUntil() {} } as unknown as ExecutionContext);
  expect(res.status).toBe(400);
  expect(res.headers.get('cache-control')).toBe('private, no-store');
  expect(res.headers.get('referrer-policy')).toBe('no-referrer');
});

it('keeps self-service credential filtering scoped when mounted alongside another LIFF API', async () => {
  const { Hono } = await import('hono');
  const { affiliateSelfRoutes } = await import('./affiliate-self.js');
  const isolated = new Hono(); isolated.route('/', affiliateSelfRoutes);
  isolated.get('/api/liff/other-feature', c => c.json({ reached: true }));
  const res = await isolated.request('/api/liff/other-feature?lineAccessToken=other-feature-token');
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ reached: true });
});
