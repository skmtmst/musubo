import { Hono } from 'hono';
import { unhandledWorkerError } from '../lib/unhandled-error.js';
const report = vi.hoisted(() => vi.fn(async () => false));
vi.mock('../services/codex-slack-relay.js', () => ({ reportHarnessErrorToSlack: report }));
import type { Env } from '../worker-env.js';
import { describe, expect, test, beforeEach, vi } from 'vitest';
// 分類は純粋関数なので実物を差す。ロジックを試験側へ複写すると
// 実装と乖離しても気づけないため。
const realDb = await vi.importActual<typeof import('@line-crm/db')>('@line-crm/db');

const dbMocks = {
  getWebinars: vi.fn(),
  getWebinarList: vi.fn(),
  getWebinarById: vi.fn(),
  getWebinarBySlug: vi.fn(),
  createWebinar: vi.fn(),
  updateWebinar: vi.fn(),
  isWebinarMissedInWindow: vi.fn(async () => true),
  getWebinarWatchedSeconds: vi.fn(async () => 0),
  archiveWebinar: vi.fn(),
  getWebinarActions: vi.fn(),
  replaceWebinarActions: vi.fn(),
  countInvalidWebinarActionReferences: vi.fn(),
  insertWebinarActionExecutionIgnore: vi.fn(),
  finishWebinarActionExecution: vi.fn(),
  getWebinarComments: vi.fn(),
  getWebinarCtas: vi.fn(),
  replaceWebinarCtas: vi.fn(),
  getFormById: vi.fn(),
  replaceWebinarComments: vi.fn(),
  upsertWebinarViewer: vi.fn(),
  recordWebinarHeartbeat: vi.fn(
    async (): Promise<{ status: string; reason?: string }> => ({ status: 'recorded' }),
  ),
  parseWebinarHeartbeatPlayerState: realDb.parseWebinarHeartbeatPlayerState,
  getWebinarRetention: vi.fn(
    async (): Promise<{ bucketSeconds: number; started: number; points: Array<{ at_seconds: number; viewers: number }> }> => (
      { bucketSeconds: 60, started: 0, points: [] }
    ),
  ),
  countWebinarStartedViewers: vi.fn(async () => 0),
  countWebinarHeartbeatRejects: vi.fn(async () => 0),
  getWebinarVideoAsset: vi.fn(
    async (): Promise<{ id: string; webinar_id: string; stage: string } | null> => null,
  ),
  advanceWebinarVideoAsset: vi.fn(),
  isWebinarVideoReady: vi.fn(async () => true),
  getWebinarSession: vi.fn(async () => null),
  setWebinarSessionCapacity: vi.fn(),
  recordWebinarCtaClick: vi.fn(),
  recordWebinarFunnelEvent: vi.fn(),
  insertWebinarUserComment: vi.fn(),
  countSessionUserComments: vi.fn(),
  getWebinarUserComments: vi.fn(),
  getWebinarSessionStats: vi.fn(),
  getWebinarDropoff: vi.fn(),
  getWebinarParticipantStats: vi.fn(),
  getWebinarAnalyticsSummary: vi.fn(),
  getWebinarDailyStats: vi.fn(),
  getWebinarFormFunnelStats: vi.fn(),
  getWebinarOverview: vi.fn(),
  getFolderById: vi.fn(),
  getMediaById: vi.fn(),
  getMediaIdByR2Key: vi.fn(),
  countWebinarList: vi.fn(),
  webinarListSort: vi.fn((filters: { sort?: string }) => {
    if (filters?.sort === 'created') return [{ field: 'createdAt', direction: 'desc' }];
    if (filters?.sort === 'name') return [{ field: 'title', direction: 'asc' }];
    return [{ field: 'updatedAt', direction: 'desc' }];
  }),
  getFriendByLineUserId: vi.fn(),
  getFriendByLineUserIdForAccount: vi.fn(),
  getFriendById: vi.fn(),
  getLineAccountById: vi.fn(),
  upsertWebinarRegistration: vi.fn(),
  getUpcomingWebinarRegistration: vi.fn(),
  getWebinarRegistration: vi.fn(),
  recordWebinarPickerOpen: vi.fn(),
  applyMileageRulesForEvent: vi.fn(),
  getDueWebinarRegistrations: vi.fn(),
  markWebinarRegistrationNotified: vi.fn(),
  getWebinarEditorSettings: vi.fn(),
  saveWebinarEditorSettings: vi.fn(),
  publishWebinarEditorVersion: vi.fn(),
  publishWebinarAndActivate: vi.fn(),
  getWebinarViewSegmentCoverage: vi.fn(),
  getWebinarParticipantOperations: vi.fn(),
  classifyWebinarParticipant: realDb.classifyWebinarParticipant,
  getWebinarMonitoringSummary: vi.fn(),
  getWebinarPublicAccount: vi.fn(),
  formBelongsToLineAccount: vi.fn(),
  // 成果計測は packages/db へ移した。この差し替えに書き出しが無いと、
  // 呼び出し口が 500 になる。数えること自体は実DBの試験で見ている。
  recordConversionSourceEvent: vi.fn(async () => ({ matched: 0, recorded: 0, failed: 0, skipped: null })),
};
vi.mock('@line-crm/db', () => dbMocks);

const authMock = { verifyCallerLineUserId: vi.fn() };
vi.mock('../services/liff-auth.js', () => authMock);

const tagMock = { attachTagAndFireSideEffects: vi.fn(), detachTagAndFireSideEffects: vi.fn() };
vi.mock('../features/friends/friend-tag-attach.js', () => tagMock);

const localProxyMock = { dispatchLineProxyLocally: vi.fn() };
vi.mock('../services/local-line-proxy.js', () => localProxyMock);

const webinarNotificationMocks = {
  enqueueWebinarCompletedNotification: vi.fn(),
  getWebinarNotificationOverview: vi.fn(),
  getWebinarNotificationSettings: vi.fn(),
  registerWebinarSession: vi.fn(),
  saveWebinarNotificationSettings: vi.fn(),
  sendWebinarNotificationTest: vi.fn(),
  webinarTestRecipientPreview: vi.fn(),
  WebinarTestRecipientsChanged: class extends Error { readonly code='WEBINAR_TEST_RECIPIENT_CHANGED'; constructor(public current:{count:number;recipients:Array<{id:string;displayName:string|null}>}) {super('テスト宛先が変わりました');} },
};
vi.mock('../features/webinars/webinar-notifications.js', () => webinarNotificationMocks);

const accountAccessMock = {
  canAccessAllLineAccounts: vi.fn(async (
    _db: D1Database, _staff: unknown, _ids: Array<string | null>,
  ) => true),
  getVisibleLineAccountScope: vi.fn(async () => ({
    allowedAccountIds: ['account-a'], canSeeUnassigned: false,
  })),
};
vi.mock('../services/account-access.js', () => accountAccessMock);

const audienceMock = vi.hoisted(() => ({ countRecentWebinarViewers: vi.fn(async () => 0) }));
vi.mock('../features/webinars/webinar-audience.js', () => ({
  ...audienceMock, WEBINAR_AUDIENCE_WINDOW_SECONDS: 60,
}));

const { webinarRoutes } = await import('./webinars.js');
const { signWebinarToken } = await import('../lib/webinar-token.js');

const SECRET = 'channel-secret';
// 2026-07-29 20:00 JST 開始の once スケジュール
const SESSION_START = Math.floor(Date.UTC(2026, 6, 29, 11, 0) / 1000);

function makeWebinar(over: Record<string, unknown> = {}) {
  return {
    id: 'w1',
    account_id: null,
    title: 'テストウェビナー',
    slug: 'test-webinar',
    status: 'active',
    video_prefix: 'webinars/test-webinar',
    duration_seconds: 7200,
    schedule_json: '[{"type":"once","at":"2026-07-29T20:00:00+09:00"}]',
    cta_json: '{"label":"申込","url":"https://pay.example.com","showAtSeconds":5400}',
    tag_on_attend: 'tag-attend',
    tag_on_cta_click: null,
    folder_id: null,
    publication_starts_at: null,
    publication_ends_at: null,
    folder_name: null,
    registration_count: 0,
    viewer_count: 0,
    created_at: 'x',
    updated_at: 'x',
    ...over,
  };
}

const env = {
  DB: {} as D1Database, LINE_CHANNEL_SECRET: SECRET, IMAGES: {} as R2Bucket,
  LINE_CHANNEL_ACCESS_TOKEN: 'test-token', LIFF_URL: 'https://liff.line.me/999-test',
};
const execCtx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;

function req(path: string, init?: RequestInit) {
  return webinarRoutes.request(path, init, env, execCtx);
}
// 管理系の更新はオーナー／管理者限定になった。LIFF 側の公開経路は認証を
// 通さないままにしたいので、認証済みで叩きたいテストだけこちらを使う。
// 権限そのものの検証は middleware/role-guard.test.ts が持つ。
const adminApp = new Hono<Env>();
adminApp.use('*', async (c, next) => {
  c.set('staff', { id: 'owner-1', name: 'Owner', role: 'owner', readOnly: false });
  return next();
});
adminApp.route('/', webinarRoutes);
adminApp.onError(unhandledWorkerError);

function adminReq(path: string, init?: RequestInit) {
  if (init?.method === 'PUT' && /^\/api\/webinars\/[^/]+$/.test(path) && typeof init.body === 'string') {
    init = { ...init, body: JSON.stringify({ expectedVersion: 0, ...JSON.parse(init.body) }) };
  }
  return adminApp.request(path, init, env, execCtx);
}

beforeEach(() => {
  vi.restoreAllMocks();
  audienceMock.countRecentWebinarViewers.mockClear();
  audienceMock.countRecentWebinarViewers.mockResolvedValue(0);
  vi.useFakeTimers();
  // ライブ開始3分後（予約済み本人が途中参加できる5分窓内）
  vi.setSystemTime(new Date((SESSION_START + 180) * 1000));
  authMock.verifyCallerLineUserId.mockResolvedValue('U123');
  dbMocks.getFriendByLineUserId.mockResolvedValue({ id: 'friend-1' });
  dbMocks.getFriendByLineUserIdForAccount.mockResolvedValue({ id: 'friend-1' });
  dbMocks.getWebinarBySlug.mockResolvedValue(makeWebinar());
  dbMocks.getWebinarOverview.mockResolvedValue({
    state: 'partial', registrationMode: 'people', metrics: {},
  });
  dbMocks.getWebinarList.mockResolvedValue([]);
  dbMocks.countWebinarList.mockResolvedValue(0);
  dbMocks.getFolderById.mockResolvedValue({ id: 'folder-1', kind: 'webinar', account_id: 'account-a' });
  dbMocks.getWebinarActions.mockResolvedValue([]);
  dbMocks.replaceWebinarActions.mockResolvedValue([]);
  dbMocks.countInvalidWebinarActionReferences.mockResolvedValue(0);
  dbMocks.insertWebinarActionExecutionIgnore.mockResolvedValue(true);
  dbMocks.finishWebinarActionExecution.mockResolvedValue(undefined);
  dbMocks.getWebinarComments.mockResolvedValue([
    { id: 'c1', webinar_id: 'w1', at_seconds: 10, author_name: '田中', body: '楽しみ!', created_at: 'x' },
  ]);
  dbMocks.upsertWebinarViewer.mockResolvedValue({ firstJoin: true });
  dbMocks.getWebinarCtas.mockResolvedValue([]);
  dbMocks.getWebinarEditorSettings.mockResolvedValue(null);
  dbMocks.saveWebinarEditorSettings.mockImplementation(async (_db, webinarId, expectedVersion, input) => ({
    webinar_id: webinarId, version: Number(expectedVersion) + 1,
    delivery_kind: input.deliveryKind ?? 'scheduled',
    viewing_condition_json: JSON.stringify(input.viewingCondition ?? { kind: 'registered', label: '申込者向け' }),
    public_description: input.publicDescription ?? '', registration_form_id: input.registrationFormId ?? null,
    notification_messages_json: JSON.stringify(input.notificationMessages ?? {}), notification_test_json: null,
    action_template_body: input.actionTemplateBody ?? '', missing_result_policy: input.missingResultPolicy ?? 'escalate',
    public_page_test_json: null, published_version: null, published_at: null, created_at: 'x', updated_at: 'x',
  }));
  dbMocks.getWebinarViewSegmentCoverage.mockResolvedValue([]);
  dbMocks.recordWebinarHeartbeat.mockResolvedValue({ status: 'recorded' });
  dbMocks.getWebinarRetention.mockResolvedValue({ bucketSeconds: 60, started: 0, points: [] });
  dbMocks.countWebinarStartedViewers.mockResolvedValue(0);
  dbMocks.countWebinarHeartbeatRejects.mockResolvedValue(0);
  dbMocks.getWebinarVideoAsset.mockResolvedValue(null);
  dbMocks.isWebinarVideoReady.mockResolvedValue(true);
  dbMocks.getWebinarSession.mockResolvedValue(null);
  dbMocks.getWebinarParticipantOperations.mockResolvedValue([]);
  dbMocks.getWebinarMonitoringSummary.mockResolvedValue({
    notification_failures: 0, duplicate_registrations: 0, view_segment_failures: 0, action_failures: 0,
  });
  dbMocks.getWebinarPublicAccount.mockResolvedValue({ id: 'account-a', liff_id: '999-test' });
  dbMocks.formBelongsToLineAccount.mockResolvedValue(true);
  dbMocks.recordWebinarHeartbeat.mockResolvedValue({ status: 'recorded' });
  dbMocks.getUpcomingWebinarRegistration.mockResolvedValue(null);
  dbMocks.getWebinarRegistration.mockResolvedValue({
    id: 'reg-current', webinar_id: 'w1', friend_id: 'friend-1',
    session_start_at: SESSION_START, notified_at: 'x', created_at: 'x',
  });
  localProxyMock.dispatchLineProxyLocally.mockResolvedValue(new Response(null, { status: 200 }));
  dbMocks.recordWebinarPickerOpen.mockResolvedValue(undefined);
  webinarNotificationMocks.getWebinarNotificationSettings.mockResolvedValue(null);
  webinarNotificationMocks.getWebinarNotificationOverview.mockResolvedValue({
    total: 0, pending: 0, sent: 0, failed: 0, skipped: 0, cancelled: 0,
  });
  webinarNotificationMocks.registerWebinarSession.mockResolvedValue({
    registration: {
      id: 'reg-current', webinar_id: 'w1', friend_id: 'friend-1',
      session_start_at: SESSION_START, notified_at: null, status: 'active',
      cancelled_at: null, created_at: 'x',
    },
    created: true,
    rescheduled: false,
  });
  webinarNotificationMocks.saveWebinarNotificationSettings.mockResolvedValue({
    settings: {
      webinarId: 'w1', version: 1, registrationEnabled: true,
      dayBeforeEnabled: true, dayBeforeTime: '20:00', hourBeforeEnabled: true,
      hourBeforeMinutes: 60, startEnabled: true, missedEnabled: true,
      missedTime: '10:00', completedEnabled: true, updatedAt: 'x',
    },
    queued: 4,
    cancelled: 0,
  });
  webinarNotificationMocks.sendWebinarNotificationTest.mockResolvedValue({ sent: 1, failed: 0 });
  dbMocks.applyMileageRulesForEvent.mockResolvedValue({
    event: { id: 'mileage-event-1' }, granted: [],
  });
  accountAccessMock.canAccessAllLineAccounts.mockResolvedValue(true);
  accountAccessMock.getVisibleLineAccountScope.mockResolvedValue({
    allowedAccountIds: ['account-a'], canSeeUnassigned: false,
  });
});
describe('admin webinar tenant scope', () => {
  test('概要は選択中アカウントの実測値を返す', async () => {
    dbMocks.getWebinarOverview.mockResolvedValue({
      state: 'partial',
      registrationMode: 'people',
      metrics: {
        webinars: { value: 2, state: 'available', reason: null },
        registrations: { value: 3, state: 'available', reason: null },
        viewers: { value: null, state: 'unavailable', reason: '未集計' },
      },
    });

    const res = await adminReq('/api/webinars/overview?account_id=account-a');

    expect(res.status).toBe(200);
    expect(dbMocks.getWebinarOverview).toHaveBeenCalledWith({}, 'account-a');
    expect(await res.json()).toMatchObject({
      success: true,
      data: { registrationMode: 'people', metrics: { registrations: { value: 3 } } },
    });
  });
  test('概要はaccount_id必須で、別統括のアカウントを拒否する', async () => {
    const missing = await adminReq('/api/webinars/overview');
    expect(missing.status).toBe(400);

    accountAccessMock.canAccessAllLineAccounts.mockResolvedValue(false);
    const forbidden = await adminReq('/api/webinars/overview?account_id=account-b');
    expect(forbidden.status).toBe(403);
    expect(dbMocks.getWebinarOverview).not.toHaveBeenCalled();
  });
  test('一覧はリクエスト元の統括から見えるアカウントだけをDBへ渡す', async () => {
    dbMocks.getWebinarList.mockResolvedValue([makeWebinar({ account_id: 'account-a' })]);
    dbMocks.countWebinarList.mockResolvedValue(1);

    const res = await adminReq('/api/webinars');

    expect(res.status).toBe(200);
    expect(dbMocks.getWebinarList).toHaveBeenCalledWith({}, {
      allowedAccountIds: ['account-a'],
      canSeeUnassigned: false,
      accountId: undefined,
    }, { limit: 50, offset: 0 }, { q: undefined, folderId: undefined, status: undefined, sort: 'updated' });
    const body = await res.json() as { data: { items: unknown[]; total: number; limit: number } };
    expect(body.data.items).toHaveLength(1);
    expect(body.data.total).toBe(1);
    expect(body.data.limit).toBe(50);
  });
  test('一覧で選んだLINEアカウントだけをDBへ渡す', async () => {
    dbMocks.getWebinarList.mockResolvedValue([makeWebinar({ account_id: 'account-a' })]);

    const res = await adminReq('/api/webinars?account_id=account-a');

    expect(res.status).toBe(200);
    expect(dbMocks.getWebinarList).toHaveBeenCalledWith({}, {
      allowedAccountIds: ['account-a'],
      canSeeUnassigned: false,
      accountId: 'account-a',
    }, { limit: 50, offset: 0 }, { q: undefined, folderId: undefined, status: undefined, sort: 'updated' });
  });
  test('一覧は頁ごとに区切って総件数と並び順を返す', async () => {
    dbMocks.getWebinarList.mockResolvedValue([makeWebinar({ account_id: 'account-a' })]);
    dbMocks.countWebinarList.mockResolvedValue(45);

    const res = await adminReq('/api/webinars?account_id=account-a&page=2&limit=20&sort=name&status=active&folder=folder-1&q=セミナー');

    expect(res.status).toBe(200);
    expect(dbMocks.getWebinarList).toHaveBeenCalledWith({}, {
      allowedAccountIds: ['account-a'],
      canSeeUnassigned: false,
      accountId: 'account-a',
    }, { limit: 20, offset: 20 }, { q: 'セミナー', folderId: 'folder-1', status: 'active', sort: 'name' });
    expect(await res.json()).toMatchObject({
      data: { total: 45, limit: 20, sort: [{ field: 'title', direction: 'asc' }] },
    });
  });
  test('一覧の件数指定が壊れていても既定に寄せる', async () => {
    const res = await adminReq('/api/webinars?account_id=account-a&page=0&limit=9999');

    expect(res.status).toBe(200);
    /* limit は上限200へ丸め、page は1始まりへ戻す。 */
    expect(dbMocks.getWebinarList).toHaveBeenCalledWith({}, expect.anything(), { limit: 200, offset: 0 }, expect.anything());
    expect(await res.json()).toMatchObject({ data: { limit: 200 } });
  });
  test('アーカイブの絞り込みを一覧と件数の両方へ渡す', async () => {
    const res = await adminReq('/api/webinars?account_id=account-a&status=archived');
    expect(res.status).toBe(200);
    expect(dbMocks.getWebinarList).toHaveBeenCalledWith({}, expect.objectContaining({ accountId: 'account-a' }), expect.anything(), expect.objectContaining({ status: 'archived' }));
    expect(dbMocks.countWebinarList).toHaveBeenCalledWith({}, expect.objectContaining({ accountId: 'account-a' }), expect.objectContaining({ status: 'archived' }));
  });
  test('一覧は固定契約の集計値と公開5状態を返す', async () => {
    dbMocks.getWebinarList.mockResolvedValue([
      makeWebinar({
        id: 'period', folder_id: 'folder-1', folder_name: '販売',
        registration_count: 12, viewer_count: 8,
        publication_starts_at: '2026-07-01T00:00:00.000Z',
        publication_ends_at: '2026-08-01T00:00:00.000Z',
      }),
      makeWebinar({ id: 'always', registration_count: 3, viewer_count: 2 }),
      makeWebinar({
        id: 'scheduled', status: 'draft', registration_count: 0, viewer_count: null,
        publication_starts_at: '2026-08-10T00:00:00.000Z',
      }),
      makeWebinar({ id: 'unset', status: 'draft', registration_count: 0, viewer_count: 0 }),
      makeWebinar({
        id: 'ended', registration_count: 7, viewer_count: 6,
        publication_ends_at: '2026-07-01T00:00:00.000Z',
      }),
    ]);

    const res = await adminReq('/api/webinars');
    const body = await res.json() as { data: { items: Array<Record<string, unknown>> } };

    expect(body.data.items.map((row) => row.publicationState)).toEqual([
      'period', 'always', 'scheduled', 'unset', 'ended',
    ]);
    expect(body.data.items[0]).toMatchObject({
      folderId: 'folder-1', folderName: '販売', registrationCount: 12, viewerCount: 8,
      publicationStartsAt: '2026-07-01T00:00:00.000Z',
      publicationEndsAt: '2026-08-01T00:00:00.000Z',
    });
    expect(body.data.items[2]?.viewerCount).toBeNull();
  });
  test('一覧で別統括のLINEアカウントを指定しても存在を返さない', async () => {
    const res = await adminReq('/api/webinars?account_id=account-b');
    expect(res.status).toBe(404);
  });
  test.each([
    ['GET', '/api/webinars/w-other'],
    ['PUT', '/api/webinars/w-other'],
    ['DELETE', '/api/webinars/w-other'],
    ['GET', '/api/webinars/w-other/comments'],
    ['PUT', '/api/webinars/w-other/comments'],
    ['GET', '/api/webinars/w-other/ctas'],
    ['PUT', '/api/webinars/w-other/ctas'],
    ['GET', '/api/webinars/w-other/analytics'],
    ['GET', '/api/webinars/w-other/user-comments'],
    ['GET', '/api/webinars/w-other/notifications'],
    ['PUT', '/api/webinars/w-other/notifications'],
    ['POST', '/api/webinars/w-other/notifications/test'],
    ['GET', '/api/webinars/w-other/actions'],
    ['PUT', '/api/webinars/w-other/actions'],
    ['POST', '/api/webinars/w-other/archive'],
    ['GET', '/api/webinars/w-other/participants.csv'],
  ])('%s %s は別統括のウェビナーを404にする', async (method, path) => {
    dbMocks.getWebinarById.mockResolvedValue(makeWebinar({ id: 'w-other', account_id: 'account-b' }));
    accountAccessMock.canAccessAllLineAccounts.mockResolvedValue(false);

    const res = await adminReq(path, {
      method,
      headers: method === 'PUT' ? { 'Content-Type': 'application/json' } : undefined,
      body: method === 'PUT' ? '{}' : undefined,
    });

    expect(res.status).toBe(404);
  });
  test('作成と更新は別統括のaccountIdを保存前に403にする', async () => {
    dbMocks.getWebinarById.mockResolvedValue(makeWebinar({ account_id: 'account-a' }));
    accountAccessMock.canAccessAllLineAccounts.mockImplementation(async (_db, _staff, ids) => (
      ids[0] !== 'account-b'
    ));

    const create = await adminReq('/api/webinars', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: '拒否', slug: 'denied', accountId: 'account-b', durationSeconds: 7200,
      }),
    });
    const update = await adminReq('/api/webinars/w1', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: 'account-b' }),
    });

    expect(create.status).toBe(403);
    expect(update.status).toBe(403);
    expect(dbMocks.createWebinar).not.toHaveBeenCalled();
    expect(dbMocks.updateWebinar).not.toHaveBeenCalled();
  });
});
describe('GET /api/liff/webinars/:slug', () => {
  test('ライブ中は offset とプレイリスト URL とコメントを返す', async () => {
    const res = await req('/api/liff/webinars/test-webinar', {
      headers: { Authorization: 'Bearer token' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.live).toBe(true);
    expect(body.offsetSeconds).toBe(180);
    expect(body.sessionStartAt).toBe(SESSION_START);
    expect(body.playlistUrl).toMatch(
      /^\/webinar-assets\/\d+\.[A-Za-z0-9_-]+\/test-webinar\/master\.m3u8$/,
    );
    expect(body.comments).toEqual([{ atSeconds: 10, authorName: '田中', body: '楽しみ!' }]);
    // 予約済み本人だけが動画 URL を受け取る
    expect(body.upcoming).toEqual([]);
    expect(body.registeredSessionAt).toBeNull();
    expect(body.registeredForThisSession).toBe(true);
    expect(dbMocks.upsertWebinarViewer).toHaveBeenCalledWith({}, 'w1', 'friend-1', SESSION_START);
  });
  test('friend はウェビナーのアカウント配下の行を優先解決する', async () => {
    dbMocks.getWebinarBySlug.mockResolvedValue(makeWebinar({ account_id: 'acc-b' }));
    await req('/api/liff/webinars/test-webinar', { headers: { Authorization: 'Bearer t' } });
    expect(dbMocks.getFriendByLineUserIdForAccount).toHaveBeenCalledWith(
      expect.anything(), 'U123', 'acc-b',
    );
  });
  test('この回を予約済みの本人には registeredForThisSession=true を返す', async () => {
    dbMocks.getWebinarRegistration.mockResolvedValue({
      id: 'reg-1', webinar_id: 'w1', friend_id: 'friend-1',
      session_start_at: SESSION_START, notified_at: 'x', created_at: 'x',
    });
    const res = await req('/api/liff/webinars/test-webinar', {
      headers: { Authorization: 'Bearer t' },
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.registeredForThisSession).toBe(true);
    expect(dbMocks.getWebinarRegistration).toHaveBeenCalledWith(
      expect.anything(), 'w1', 'friend-1', SESSION_START,
    );
  });
  test('開始ぴったりでも未予約者には動画URLを返さず、現在回を予約候補にする', async () => {
    vi.setSystemTime(new Date(SESSION_START * 1000));
    dbMocks.getWebinarRegistration.mockResolvedValue(null);
    const res = await req('/api/liff/webinars/test-webinar', {
      headers: { Authorization: 'Bearer t' },
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.live).toBe(false);
    expect(body.upcoming).toEqual([SESSION_START]);
    expect(body.playlistUrl).toBeUndefined();
    expect(dbMocks.upsertWebinarViewer).not.toHaveBeenCalled();
    expect(execCtx.waitUntil).not.toHaveBeenCalled();
    expect(dbMocks.recordWebinarPickerOpen).toHaveBeenCalledWith(
      expect.anything(), 'w1', 'friend-1',
    );
  });
  test('開始5分ちょうどまでは、未予約者に現在回を予約候補として出す', async () => {
    vi.setSystemTime(new Date((SESSION_START + 300) * 1000));
    dbMocks.getWebinarRegistration.mockResolvedValue(null);
    const res = await req('/api/liff/webinars/test-webinar', {
      headers: { Authorization: 'Bearer t' },
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.live).toBe(false);
    expect(body.upcoming).toEqual([SESSION_START]);
    expect(body.playlistUrl).toBeUndefined();
  });
  test('開始5分を過ぎても、その回の予約済み本人は再入場できる', async () => {
    vi.setSystemTime(new Date((SESSION_START + 301) * 1000));
    const res = await req('/api/liff/webinars/test-webinar', {
      headers: { Authorization: 'Bearer t' },
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.live).toBe(true);
    expect(body.sessionStartAt).toBe(SESSION_START);
    expect(body.offsetSeconds).toBe(301);
    expect(body.registeredForThisSession).toBe(true);
    expect(body.playlistUrl).toBeDefined();
    expect(dbMocks.upsertWebinarViewer).toHaveBeenCalledWith(
      expect.anything(), 'w1', 'friend-1', SESSION_START,
    );
  });
  test('開始5分を過ぎた未予約者は、現在回に入れず次回選択に戻る', async () => {
    vi.setSystemTime(new Date((SESSION_START + 301) * 1000));
    dbMocks.getWebinarRegistration.mockResolvedValue(null);
    const res = await req('/api/liff/webinars/test-webinar', {
      headers: { Authorization: 'Bearer t' },
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.live).toBe(false);
    expect(body.upcoming).toEqual([]);
    expect(body.playlistUrl).toBeUndefined();
    expect(dbMocks.upsertWebinarViewer).not.toHaveBeenCalled();
  });
  test('専用入場リンクは配信終了後も予約した回を再生できる', async () => {
    vi.setSystemTime(new Date((SESSION_START + 7200 + 3600) * 1000));
    dbMocks.getWebinarRegistration.mockResolvedValue({
      id: 'reg-past', webinar_id: 'w1', friend_id: 'friend-1',
      session_start_at: SESSION_START, notified_at: 'x', created_at: 'x',
    });
    const res = await req(
      `/api/liff/webinars/test-webinar?sessionStartAt=${SESSION_START}`,
      { headers: { Authorization: 'Bearer t' } },
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.live).toBe(true);
    expect(body.replay).toBe(true);
    expect(body.sessionStartAt).toBe(SESSION_START);
    expect(body.offsetSeconds).toBe(0);
    expect(body.registeredForThisSession).toBe(true);
    expect(body.playlistUrl).toBeDefined();
    expect(dbMocks.upsertWebinarViewer).toHaveBeenCalledWith(
      expect.anything(), 'w1', 'friend-1', SESSION_START,
    );
  });
  test('専用リンクの時刻を推測しても、本人の予約がなければ再生できない', async () => {
    vi.setSystemTime(new Date((SESSION_START + 7200 + 3600) * 1000));
    dbMocks.getWebinarRegistration.mockResolvedValue(null);
    const res = await req(
      `/api/liff/webinars/test-webinar?sessionStartAt=${SESSION_START}`,
      { headers: { Authorization: 'Bearer t' } },
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.live).toBe(false);
    expect(body.replay).toBeUndefined();
    expect(body.playlistUrl).toBeUndefined();
    expect(dbMocks.upsertWebinarViewer).not.toHaveBeenCalled();
  });
  test('tag_on_attend が waitUntil 経由で付与される', async () => {
    await req('/api/liff/webinars/test-webinar', { headers: { Authorization: 'Bearer t' } });
    expect(execCtx.waitUntil).toHaveBeenCalled();
  });
  test('開始10分より前は live:false と nextSessionAt のみ (待機ルームなし)', async () => {
    vi.setSystemTime(new Date((SESSION_START - 3600) * 1000));
    const res = await req('/api/liff/webinars/test-webinar', {
      headers: { Authorization: 'Bearer t' },
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.live).toBe(false);
    expect(body.waiting).toBeUndefined();
    expect(body.nextSessionAt).toBe(SESSION_START);
    expect(body.upcoming).toEqual([SESSION_START]);
    expect(body.registeredSessionAt).toBeNull();
    expect(dbMocks.upsertWebinarViewer).not.toHaveBeenCalled();
    expect(dbMocks.recordWebinarPickerOpen).toHaveBeenCalledWith(
      expect.anything(), 'w1', 'friend-1',
    );
  });
  test('すでに未来回を予約済みなら予約画面の離脱として記録しない', async () => {
    vi.setSystemTime(new Date((SESSION_START - 3600) * 1000));
    dbMocks.getUpcomingWebinarRegistration.mockResolvedValue({
      id: 'reg-future', webinar_id: 'w1', friend_id: 'friend-1',
      session_start_at: SESSION_START, notified_at: null, created_at: 'x',
    });
    await req('/api/liff/webinars/test-webinar', {
      headers: { Authorization: 'Bearer token' },
    });
    expect(dbMocks.recordWebinarPickerOpen).not.toHaveBeenCalled();
  });
  test('開始10分前でも未予約者は待機ルームへ直行せず、予約画面を出す', async () => {
    vi.setSystemTime(new Date((SESSION_START - 300) * 1000));
    dbMocks.getUpcomingWebinarRegistration.mockResolvedValue(null);
    const res = await req('/api/liff/webinars/test-webinar', {
      headers: { Authorization: 'Bearer t' },
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.live).toBe(false);
    expect(body.waiting).toBeUndefined();
    expect(body.upcoming).toEqual([SESSION_START]);
  });
  test('開始10分前から予約済み本人だけ待機ルームに入る', async () => {
    vi.setSystemTime(new Date((SESSION_START - 300) * 1000));
    dbMocks.getUpcomingWebinarRegistration.mockResolvedValue({
      id: 'reg-next', webinar_id: 'w1', friend_id: 'friend-1',
      session_start_at: SESSION_START, notified_at: null, created_at: 'x',
    });
    dbMocks.getWebinarComments.mockResolvedValue([
      { id: 'c0', webinar_id: 'w1', at_seconds: -120, author_name: 'みお', body: '楽しみ', created_at: 'x' },
    ]);
    const res = await req('/api/liff/webinars/test-webinar', {
      headers: { Authorization: 'Bearer t' },
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.live).toBe(false);
    expect(body.waiting).toBe(true);
    expect(body.offsetSeconds).toBe(-300);
    expect(body.nextSessionAt).toBe(SESSION_START);
    expect(body.comments).toEqual([{ atSeconds: -120, authorName: 'みお', body: '楽しみ' }]);
    expect(body.playlistUrl).toBeUndefined();
    // 待機中は視聴ログを作らない
    expect(dbMocks.upsertWebinarViewer).not.toHaveBeenCalled();
    expect(execCtx.waitUntil).not.toHaveBeenCalled();
  });
  test('待機窓の境界 (ちょうど600秒前) は待機ルーム', async () => {
    vi.setSystemTime(new Date((SESSION_START - 600) * 1000));
    dbMocks.getUpcomingWebinarRegistration.mockResolvedValue({
      id: 'reg-next', webinar_id: 'w1', friend_id: 'friend-1',
      session_start_at: SESSION_START, notified_at: null, created_at: 'x',
    });
    const res = await req('/api/liff/webinars/test-webinar', {
      headers: { Authorization: 'Bearer t' },
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.waiting).toBe(true);
  });
  test('id_token 検証失敗は 401', async () => {
    authMock.verifyCallerLineUserId.mockResolvedValue(null);
    const res = await req('/api/liff/webinars/test-webinar');
    expect(res.status).toBe(401);
  });
  test('未認証の場合、webinar が存在しなくても 401 が返る(存在オラクル防止)', async () => {
    authMock.verifyCallerLineUserId.mockResolvedValue(null);
    dbMocks.getWebinarBySlug.mockResolvedValue(null);
    const res = await req('/api/liff/webinars/does-not-exist');
    expect(res.status).toBe(401);
    expect(dbMocks.getWebinarBySlug).not.toHaveBeenCalled();
  });
  test('friend 未登録は 403', async () => {
    dbMocks.getFriendByLineUserIdForAccount.mockResolvedValue(null);
    const res = await req('/api/liff/webinars/test-webinar', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(403);
  });
  test('draft ウェビナーは 404', async () => {
    dbMocks.getWebinarBySlug.mockResolvedValue(makeWebinar({ status: 'draft' }));
    const res = await req('/api/liff/webinars/test-webinar', {
      headers: { Authorization: 'Bearer t' },
    });
    expect(res.status).toBe(404);
  });
});
describe('GET /webinar-assets/:token/:slug/*', () => {
  function makeR2(objects: Record<string, string>) {
    return {
      get: vi.fn(async (key: string) =>
        objects[key] !== undefined
          ? {
              body: objects[key], etag: 'etag1', httpMetadata: {},
              text: async () => objects[key],
            }
          : null,
      ),
    };
  }
  test('有効トークンでセグメント配信・content-type/cache 設定', async () => {
    const r2 = makeR2({ 'webinars/test-webinar/0/seg_0001.ts': 'DATA' });
    const token = await signWebinarToken(SECRET, 'test-webinar', SESSION_START + 99999);
    const res = await webinarRoutes.request(
      `/webinar-assets/${token}/test-webinar/0/seg_0001.ts`,
      undefined,
      { ...env, IMAGES: r2 as unknown as R2Bucket },
      execCtx,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('video/mp2t');
    expect(res.headers.get('Cache-Control')).toContain('immutable');
  });
  test('m3u8 は mpegurl・短キャッシュ', async () => {
    const r2 = makeR2({ 'webinars/test-webinar/master.m3u8': '#EXTM3U' });
    const token = await signWebinarToken(SECRET, 'test-webinar', SESSION_START + 99999);
    const res = await webinarRoutes.request(
      `/webinar-assets/${token}/test-webinar/master.m3u8`,
      undefined,
      { ...env, IMAGES: r2 as unknown as R2Bucket },
      execCtx,
    );
    expect(res.headers.get('Content-Type')).toBe('application/vnd.apple.mpegurl');
    expect(res.headers.get('Cache-Control')).toContain('max-age=3600');
  });
  test('?at= 付き master は EXT-X-START 注入 + variant URI へ at 伝播 + no-store', async () => {
    const master = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-STREAM-INF:BANDWIDTH=3506325\n0/index.m3u8\n\n#EXT-X-STREAM-INF:BANDWIDTH=1842400\n1/index.m3u8\n';
    const r2 = makeR2({ 'webinars/test-webinar/master.m3u8': master });
    const token = await signWebinarToken(SECRET, 'test-webinar', SESSION_START + 99999);
    const res = await webinarRoutes.request(
      `/webinar-assets/${token}/test-webinar/master.m3u8?at=571`,
      undefined, { ...env, IMAGES: r2 as unknown as R2Bucket }, execCtx,
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('#EXT-X-START:TIME-OFFSET=571,PRECISE=YES');
    expect(body).toContain('0/index.m3u8?at=571');
    expect(body).toContain('1/index.m3u8?at=571');
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });
  test('?at= 付き variant (media playlist) はタグ注入のみでセグメント URI は不変', async () => {
    const media = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:6.0,\nseg_00000.ts\n#EXT-X-ENDLIST\n';
    const r2 = makeR2({ 'webinars/test-webinar/0/index.m3u8': media });
    const token = await signWebinarToken(SECRET, 'test-webinar', SESSION_START + 99999);
    const res = await webinarRoutes.request(
      `/webinar-assets/${token}/test-webinar/0/index.m3u8?at=571`,
      undefined, { ...env, IMAGES: r2 as unknown as R2Bucket }, execCtx,
    );
    const body = await res.text();
    expect(body).toContain('#EXT-X-START:TIME-OFFSET=571,PRECISE=YES');
    expect(body).toContain('\nseg_00000.ts\n');
    expect(body).not.toContain('seg_00000.ts?at');
  });
  test('?at= が範囲外 (負・動画長超) は 400、セグメントの at は無視', async () => {
    const r2 = makeR2({
      'webinars/test-webinar/master.m3u8': '#EXTM3U',
      'webinars/test-webinar/0/seg_0001.ts': 'DATA',
    });
    const token = await signWebinarToken(SECRET, 'test-webinar', SESSION_START + 99999);
    const over = await webinarRoutes.request(
      `/webinar-assets/${token}/test-webinar/master.m3u8?at=999999`,
      undefined, { ...env, IMAGES: r2 as unknown as R2Bucket }, execCtx,
    );
    expect(over.status).toBe(400);
    const neg = await webinarRoutes.request(
      `/webinar-assets/${token}/test-webinar/master.m3u8?at=-5`,
      undefined, { ...env, IMAGES: r2 as unknown as R2Bucket }, execCtx,
    );
    expect(neg.status).toBe(400);
    const seg = await webinarRoutes.request(
      `/webinar-assets/${token}/test-webinar/0/seg_0001.ts?at=571`,
      undefined, { ...env, IMAGES: r2 as unknown as R2Bucket }, execCtx,
    );
    expect(seg.status).toBe(200);
    expect(await seg.text()).toBe('DATA');
  });
  test('不正トークンは 403、存在しないキーは 404、パストラバーサルは 400', async () => {
    const r2 = makeR2({});
    const token = await signWebinarToken(SECRET, 'test-webinar', SESSION_START + 99999);
    const bad = await webinarRoutes.request(
      `/webinar-assets/badtoken/test-webinar/master.m3u8`,
      undefined, { ...env, IMAGES: r2 as unknown as R2Bucket }, execCtx,
    );
    expect(bad.status).toBe(403);
    const missing = await webinarRoutes.request(
      `/webinar-assets/${token}/test-webinar/nope.ts`,
      undefined, { ...env, IMAGES: r2 as unknown as R2Bucket }, execCtx,
    );
    expect(missing.status).toBe(404);
    const traversal = await webinarRoutes.request(
      `/webinar-assets/${token}/test-webinar/..%2Fsecret.txt`,
      undefined, { ...env, IMAGES: r2 as unknown as R2Bucket }, execCtx,
    );
    expect(traversal.status).toBe(400);
  });
});

function postJson(path: string, body: unknown) {
  return req(path, {
    method: 'POST',
    headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
describe('POST /api/liff/webinars/:slug/heartbeat', () => {
  test('位置を記録する（再生中・等速が既定）', async () => {
    const res = await postJson('/api/liff/webinars/test-webinar/heartbeat', {
      sessionStartAt: SESSION_START,
      positionSeconds: 1234,
    });
    expect(res.status).toBe(200);
    expect(dbMocks.recordWebinarHeartbeat).toHaveBeenCalledWith(
      expect.anything(),
      {
        webinarId: 'w1', friendId: 'friend-1', sessionStartAt: SESSION_START,
        positionSeconds: 1234, playerState: 'playing', playbackRate: 1, clientAtMs: null,
      },
    );
  });
  test('状態・速度・申告時刻を渡す', async () => {
    const res = await postJson('/api/liff/webinars/test-webinar/heartbeat', {
      sessionStartAt: SESSION_START,
      positionSeconds: 100,
      playerState: 'buffering',
      playbackRate: 1.5,
      clientAtMs: 1720000000000,
    });
    expect(res.status).toBe(200);
    expect(dbMocks.recordWebinarHeartbeat).toHaveBeenCalledWith(
      expect.anything(),
      {
        webinarId: 'w1', friendId: 'friend-1', sessionStartAt: SESSION_START,
        positionSeconds: 100, playerState: 'buffering', playbackRate: 1.5,
        clientAtMs: 1720000000000,
      },
    );
  });
  test('不明な状態は 422', async () => {
    const res = await postJson('/api/liff/webinars/test-webinar/heartbeat', {
      sessionStartAt: SESSION_START,
      positionSeconds: 100,
      playerState: 'dancing',
    });
    expect(res.status).toBe(422);
    expect(dbMocks.recordWebinarHeartbeat).not.toHaveBeenCalled();
  });
  test('異常の除外は数えずに理由を返す', async () => {
    dbMocks.recordWebinarHeartbeat.mockResolvedValueOnce({ status: 'rejected', reason: 'position_jump' });
    const res = await postJson('/api/liff/webinars/test-webinar/heartbeat', {
      sessionStartAt: SESSION_START,
      positionSeconds: 5000,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, counted: false, reason: 'position_jump' });
  });

  test('実視聴の合計90%で完了通知を一度だけ作る処理へ渡す', async () => {
    dbMocks.getWebinarWatchedSeconds.mockResolvedValueOnce(6480);
    const res = await postJson('/api/liff/webinars/test-webinar/heartbeat', {
      sessionStartAt: SESSION_START,
      positionSeconds: 6480,
    });
    expect(res.status).toBe(200);
    expect(webinarNotificationMocks.enqueueWebinarCompletedNotification).toHaveBeenCalledWith(
      expect.anything(), 'w1', 'friend-1', SESSION_START,
    );
  });

  test('動画長+60秒を超える位置は 422', async () => {
    const res = await postJson('/api/liff/webinars/test-webinar/heartbeat', {
      sessionStartAt: SESSION_START,
      positionSeconds: 7261,
    });
    expect(res.status).toBe(422);
  });

  test('数値でない body は 422', async () => {
    const res = await postJson('/api/liff/webinars/test-webinar/heartbeat', {
      sessionStartAt: 'x', positionSeconds: 'y',
    });
    expect(res.status).toBe(422);
  });
});

describe('POST /api/liff/webinars/:slug/comments', () => {
  beforeEach(() => {
    dbMocks.countSessionUserComments.mockResolvedValue(0);
  });

  test('コメントを保存する', async () => {
    const res = await postJson('/api/liff/webinars/test-webinar/comments', {
      sessionStartAt: SESSION_START, atSeconds: 100, body: 'こんにちは',
    });
    expect(res.status).toBe(200);
    expect(dbMocks.insertWebinarUserComment).toHaveBeenCalledWith(expect.anything(), {
      webinarId: 'w1', friendId: 'friend-1', sessionStartAt: SESSION_START,
      atSeconds: 100, body: 'こんにちは',
    });
  });

  test('空文字・500字超は 422', async () => {
    const empty = await postJson('/api/liff/webinars/test-webinar/comments', {
      sessionStartAt: SESSION_START, atSeconds: 1, body: '  ',
    });
    expect(empty.status).toBe(422);
    const long = await postJson('/api/liff/webinars/test-webinar/comments', {
      sessionStartAt: SESSION_START, atSeconds: 1, body: 'あ'.repeat(501),
    });
    expect(long.status).toBe(422);
  });

  test('セッション60件超は 429', async () => {
    dbMocks.countSessionUserComments.mockResolvedValue(60);
    const res = await postJson('/api/liff/webinars/test-webinar/comments', {
      sessionStartAt: SESSION_START, atSeconds: 1, body: 'x',
    });
    expect(res.status).toBe(429);
  });

  test('待機窓より前の投稿は 409', async () => {
    vi.setSystemTime(new Date((SESSION_START - 3600) * 1000));
    const res = await postJson('/api/liff/webinars/test-webinar/comments', {
      sessionStartAt: SESSION_START, atSeconds: 1, body: 'x',
    });
    expect(res.status).toBe(409);
    expect(dbMocks.insertWebinarUserComment).not.toHaveBeenCalled();
  });

  test('待機ルーム中は次回セッション帰属で負の atSeconds を保存する', async () => {
    vi.setSystemTime(new Date((SESSION_START - 300) * 1000));
    const res = await postJson('/api/liff/webinars/test-webinar/comments', {
      sessionStartAt: SESSION_START, atSeconds: -300, body: '待機中です',
    });
    expect(res.status).toBe(200);
    expect(dbMocks.insertWebinarUserComment).toHaveBeenCalledWith(expect.anything(), {
      webinarId: 'w1', friendId: 'friend-1', sessionStartAt: SESSION_START,
      atSeconds: -300, body: '待機中です',
    });
  });

  test('待機ルーム中でも偽 sessionStartAt は 409', async () => {
    vi.setSystemTime(new Date((SESSION_START - 300) * 1000));
    const res = await postJson('/api/liff/webinars/test-webinar/comments', {
      sessionStartAt: SESSION_START - 86400, atSeconds: -300, body: 'x',
    });
    expect(res.status).toBe(409);
  });

  test('-3600 を下回る atSeconds は 422', async () => {
    const res = await postJson('/api/liff/webinars/test-webinar/comments', {
      sessionStartAt: SESSION_START, atSeconds: -4000, body: 'x',
    });
    expect(res.status).toBe(422);
  });
});

describe('POST /api/liff/webinars/:slug/cta-click', () => {
  test('クリックを記録する', async () => {
    const res = await postJson('/api/liff/webinars/test-webinar/cta-click', {
      sessionStartAt: SESSION_START,
    });
    expect(res.status).toBe(200);
    expect(dbMocks.recordWebinarCtaClick).toHaveBeenCalledWith(
      expect.anything(), 'w1', 'friend-1', SESSION_START,
    );
    expect(dbMocks.recordWebinarFunnelEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        webinarId: 'w1', friendId: 'friend-1', sessionStartAt: SESSION_START,
        eventType: 'cta_click',
      }),
    );
  });

  test('tag_on_cta_click 設定時はタグ付与が waitUntil で走る', async () => {
    dbMocks.getWebinarBySlug.mockResolvedValue(makeWebinar({ tag_on_cta_click: 'tag-cta' }));
    (execCtx.waitUntil as ReturnType<typeof vi.fn>).mockClear();
    await postJson('/api/liff/webinars/test-webinar/cta-click', {
      sessionStartAt: SESSION_START,
    });
    expect(execCtx.waitUntil).toHaveBeenCalled();
  });
});

describe('POST /api/liff/webinars/:slug/funnel-event', () => {
  test('予約済み本人のフォーム段階を記録する', async () => {
    dbMocks.getWebinarCtas.mockResolvedValue([{ id: 'cta-1', form_id: 'form-1' }]);
    const res = await postJson('/api/liff/webinars/test-webinar/funnel-event', {
      sessionStartAt: SESSION_START,
      eventType: 'field_complete',
      ctaId: 'cta-1',
      formId: 'form-1',
      fieldName: 'annual_revenue',
    });
    expect(res.status).toBe(200);
    expect(dbMocks.recordWebinarFunnelEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        webinarId: 'w1', friendId: 'friend-1', eventType: 'field_complete',
        fieldName: 'annual_revenue',
      }),
    );
  });

  test('未予約セッションは記録しない', async () => {
    dbMocks.getWebinarRegistration.mockResolvedValue(null);
    const res = await postJson('/api/liff/webinars/test-webinar/funnel-event', {
      sessionStartAt: SESSION_START,
      eventType: 'form_start',
    });
    expect(res.status).toBe(409);
    expect(dbMocks.recordWebinarFunnelEvent).not.toHaveBeenCalled();
  });
});

describe('POST /api/liff/webinars/:slug/register', () => {
  test('実在する未来セッションを予約し確認プッシュを waitUntil で送る', async () => {
    vi.setSystemTime(new Date((SESSION_START - 3600) * 1000));
    const res = await postJson('/api/liff/webinars/test-webinar/register', {
      sessionStartAt: SESSION_START,
    });
    expect(res.status).toBe(200);
    expect(webinarNotificationMocks.registerWebinarSession).toHaveBeenCalledWith(
      expect.anything(), 'w1', 'friend-1', SESSION_START,
    );
    expect(execCtx.waitUntil).toHaveBeenCalled();
  });

  test('スケジュール上に存在しない時刻は 400', async () => {
    vi.setSystemTime(new Date((SESSION_START - 3600) * 1000));
    const res = await postJson('/api/liff/webinars/test-webinar/register', {
      sessionStartAt: SESSION_START + 123,
    });
    expect(res.status).toBe(400);
    expect(webinarNotificationMocks.registerWebinarSession).not.toHaveBeenCalled();
  });

  test('開始5分ちょうどまでは現在セッションを予約できる', async () => {
    vi.setSystemTime(new Date((SESSION_START + 300) * 1000));
    const res = await postJson('/api/liff/webinars/test-webinar/register', {
      sessionStartAt: SESSION_START,
    });
    expect(res.status).toBe(200);
  });

  test('開始5分を1秒でも過ぎた現在セッションは 400', async () => {
    vi.setSystemTime(new Date((SESSION_START + 301) * 1000));
    const res = await postJson('/api/liff/webinars/test-webinar/register', {
      sessionStartAt: SESSION_START,
    });
    expect(res.status).toBe(400);
  });

  test('満員の開催回は 409（既存の申込は残る）', async () => {
    vi.setSystemTime(new Date((SESSION_START - 3600) * 1000));
    webinarNotificationMocks.registerWebinarSession.mockRejectedValueOnce(new Error('session_full'));
    const res = await postJson('/api/liff/webinars/test-webinar/register', {
      sessionStartAt: SESSION_START,
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'session_full' });
  });
});

describe('webinar video asset stages (N)', () => {
  test('段を順に進め、飛ばしは 409', async () => {
    dbMocks.getWebinarById.mockResolvedValue(makeWebinar({ account_id: 'account-a' }));
    dbMocks.getWebinarVideoAsset
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'a1', webinar_id: 'w1', stage: 'uploaded' });
    dbMocks.advanceWebinarVideoAsset.mockResolvedValue({ id: 'a1', stage: 'inspecting' });

    const ok = await adminReq('/api/webinars/w1/video-asset/advance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stage: 'uploaded' }),
    });
    expect(ok.status).toBe(200);

    dbMocks.getWebinarVideoAsset.mockResolvedValue({ id: 'a1', webinar_id: 'w1', stage: 'uploaded' });
    const skip = await adminReq('/api/webinars/w1/video-asset/advance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stage: 'ready' }),
    });
    expect(skip.status).toBe(409);
    expect(await skip.json()).toEqual({ success: false, error: 'invalid_stage_transition' });
  });

  test('知らない段名は 400', async () => {
    dbMocks.getWebinarById.mockResolvedValue(makeWebinar({ account_id: 'account-a' }));
    const res = await adminReq('/api/webinars/w1/video-asset/advance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stage: 'broadcast' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('webinar session capacity (N)', () => {
  test('定員を決めて残席を見る', async () => {
    dbMocks.getWebinarById.mockResolvedValue(makeWebinar({ account_id: 'account-a' }));
    dbMocks.setWebinarSessionCapacity.mockResolvedValue({
      session_start_at: SESSION_START, capacity: 50, reserved_count: 3, state: 'open',
    });
    const res = await adminReq(`/api/webinars/w1/sessions/${SESSION_START}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ capacity: 50 }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      data: {
        session: {
          sessionStartAt: SESSION_START, capacity: 50, reservedCount: 3,
          state: 'open', remaining: 47,
        },
      },
    });
  });

  test('0人以下の定員は 400', async () => {
    dbMocks.getWebinarById.mockResolvedValue(makeWebinar({ account_id: 'account-a' }));
    const res = await adminReq(`/api/webinars/w1/sessions/${SESSION_START}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ capacity: 0 }),
    });
    expect(res.status).toBe(400);
    expect(dbMocks.setWebinarSessionCapacity).not.toHaveBeenCalled();
  });
});

describe('webinar notification settings', () => {
  test('staff は通知設定を変更できない', async () => {
    dbMocks.getWebinarById.mockResolvedValue(makeWebinar({ account_id: 'account-a' }));
    const staffApp = new Hono<Env>();
    staffApp.use('*', async (c, next) => {
      c.set('staff', { id: 'staff-1', name: 'Staff', role: 'staff', readOnly: false });
      return next();
    });
    staffApp.route('/', webinarRoutes);

    const res = await staffApp.request('/api/webinars/w1/notifications', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }, env, execCtx);

    expect(res.status).toBe(403);
    expect(webinarNotificationMocks.saveWebinarNotificationSettings).not.toHaveBeenCalled();
  });

  test('GET は設定と実行状況を同じ応答で返す', async () => {
    dbMocks.getWebinarById.mockResolvedValue(makeWebinar({ account_id: 'account-a' }));
    webinarNotificationMocks.getWebinarNotificationSettings.mockResolvedValue({
      webinarId: 'w1', version: 2, registrationEnabled: true,
      dayBeforeEnabled: true, dayBeforeTime: '20:00', hourBeforeEnabled: true,
      hourBeforeMinutes: 60, startEnabled: true, missedEnabled: true,
      missedTime: '10:00', completedEnabled: true, updatedAt: 'x',
    });
  webinarNotificationMocks.getWebinarNotificationOverview.mockResolvedValue({
      total: 8, pending: 4, sent: 2, failed: 1, skipped: 1, cancelled: 0,
      audience: { people: 3, bookings: 4, definition: 'active_registrations' },
    });

    const res = await adminReq('/api/webinars/w1/notifications');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(expect.objectContaining({
      success: true,
      data: expect.objectContaining({
        settings: expect.objectContaining({ version: 2 }),
        overview: expect.objectContaining({
          total: 8,
          failed: 1,
          audience: { people: 3, bookings: 4, definition: 'active_registrations' },
        }),
      }),
    }));
  });

  test('PUT は全項目が揃った設定だけを保存する', async () => {
    dbMocks.getWebinarById.mockResolvedValue(makeWebinar({ account_id: 'account-a' }));
    const input = {
      registrationEnabled: true,
      dayBeforeEnabled: true,
      dayBeforeTime: '20:00',
      hourBeforeEnabled: true,
      hourBeforeMinutes: 60,
      startEnabled: true,
      missedEnabled: true,
      missedTime: '10:00',
      completedEnabled: true,
    };

    const res = await adminReq('/api/webinars/w1/notifications', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
    });

    expect(res.status).toBe(200);
    expect(webinarNotificationMocks.saveWebinarNotificationSettings).toHaveBeenCalledWith(
      expect.anything(), 'w1', input,
    );
    const invalid = await adminReq('/api/webinars/w1/notifications', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    });
    expect(invalid.status).toBe(400);
  });

  test.each(['invalid_time', 'invalid_hour_before'])(
    'PUT は設定値エラー %s を 400 で返す',
    async (message) => {
      dbMocks.getWebinarById.mockResolvedValue(makeWebinar({ account_id: 'account-a' }));
      webinarNotificationMocks.saveWebinarNotificationSettings.mockRejectedValueOnce(
        new Error(message),
      );
      const input = {
        registrationEnabled: true,
        dayBeforeEnabled: true,
        dayBeforeTime: '20:00',
        hourBeforeEnabled: true,
        hourBeforeMinutes: 60,
        startEnabled: true,
        missedEnabled: true,
        missedTime: '10:00',
        completedEnabled: true,
      };

      const res = await adminReq('/api/webinars/w1/notifications', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ success: false, code: message , fields: expect.any(Object), error: expect.any(String) });
    },
  );

  test('テスト送信は次の実在セッションと所属アカウントを使う', async () => {
    vi.setSystemTime(new Date((SESSION_START - 3600) * 1000));
    dbMocks.getWebinarById.mockResolvedValue(makeWebinar({ account_id: 'account-a' }));

    const res = await adminReq('/api/webinars/w1/notifications/test', { method: 'POST' });

    expect(res.status).toBe(200);
    expect(webinarNotificationMocks.sendWebinarNotificationTest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 'w1', accountId: 'account-a' }),
      SESSION_START,
      expect.objectContaining({ defaultLiffId: '999-test' }),
    );
  });

  test('テスト受信者の確認情報を取得し、送信時に引き継ぐ', async () => {
    vi.setSystemTime(new Date((SESSION_START - 3600) * 1000));
    dbMocks.getWebinarById.mockResolvedValue(makeWebinar({ account_id: 'account-a' }));
    webinarNotificationMocks.webinarTestRecipientPreview.mockResolvedValueOnce({count:1,recipients:[{id:'f',displayName:'確認の人'}],token:'a'.repeat(64)});
    const preview=await adminReq('/api/webinars/w1/notifications/test');
    expect(preview.status).toBe(200);
    const {data}=await preview.json() as {data:{token:string;confirmationId:string;count:number}};
    expect(data.count).toBe(1);
    const sent=await adminReq('/api/webinars/w1/notifications/test',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({expectedRecipientToken:data.token,confirmationId:data.confirmationId})});
    expect(sent.status).toBe(200);
    expect(webinarNotificationMocks.sendWebinarNotificationTest).toHaveBeenCalledWith(expect.anything(),expect.anything(),SESSION_START,expect.objectContaining({expectedRecipientToken:data.token,confirmationId:data.confirmationId}));
  });

  test('テスト受信者が変われば現在人数を409で返す', async () => {
    vi.setSystemTime(new Date((SESSION_START - 3600) * 1000));
    dbMocks.getWebinarById.mockResolvedValue(makeWebinar({ account_id: 'account-a' }));
    webinarNotificationMocks.sendWebinarNotificationTest.mockRejectedValueOnce(new webinarNotificationMocks.WebinarTestRecipientsChanged({count:2,recipients:[]}));
    const response=await adminReq('/api/webinars/w1/notifications/test',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({expectedRecipientToken:'a'.repeat(64),confirmationId:'00000000-0000-4000-8000-000000000001'})});
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({code:'WEBINAR_TEST_RECIPIENT_CHANGED',data:{count:2}});
  });

  test('存在しないウェビナーへのテスト送信は 404', async () => {
    dbMocks.getWebinarById.mockResolvedValue(null);

    const res = await adminReq('/api/webinars/missing/notifications/test', { method: 'POST' });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ success: false, error: 'Not found' });
    expect(webinarNotificationMocks.sendWebinarNotificationTest).not.toHaveBeenCalled();
  });

  test('次回開催がないウェビナーへのテスト送信は 400', async () => {
    dbMocks.getWebinarById.mockResolvedValue(makeWebinar({
      account_id: 'account-a',
      schedule_json: '[]',
    }));

    const res = await adminReq('/api/webinars/w1/notifications/test', { method: 'POST' });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ success: false, code: 'no_upcoming_session' , fields: expect.any(Object), error: expect.any(String) });
    expect(webinarNotificationMocks.sendWebinarNotificationTest).not.toHaveBeenCalled();
  });

  test.each([
    ['no_test_recipients', 400],
    ['db unavailable', 500],
  ])('テスト送信失敗 %s をHTTP %iで返す', async (message, expectedStatus) => {
    vi.setSystemTime(new Date((SESSION_START - 3600) * 1000));
    dbMocks.getWebinarById.mockResolvedValue(makeWebinar({ account_id: 'account-a' }));
    webinarNotificationMocks.sendWebinarNotificationTest.mockRejectedValueOnce(
      new Error(message),
    );

    const res = await adminReq('/api/webinars/w1/notifications/test', { method: 'POST' });

    expect(res.status).toBe(expectedStatus);
    const body = await res.json<{ incidentId?: string }>();
    expect(body).toMatchObject({ success: false });
    if (expectedStatus === 500) {
      expect(body.incidentId).toMatch(/^[0-9a-f-]{36}$/);
      expect(report).toHaveBeenCalledExactlyOnceWith(expect.anything(), expect.objectContaining({ incidentId: body.incidentId }));
    } else {
      expect(report).not.toHaveBeenCalled();
    }
  });
});

describe('admin CRUD', () => {
  test('POST /api/webinars — 作成して serialize して返す', async () => {
    // beforeEach は slug 既存の mock を入れているので、新規作成用に null に戻す
    dbMocks.getWebinarBySlug.mockResolvedValue(null);
    dbMocks.createWebinar.mockResolvedValue(makeWebinar());
    const res = await adminReq('/api/webinars', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId: 'account-a',
        title: 'テストウェビナー',
        slug: 'test-webinar',
        durationSeconds: 7200,
        schedule: [{ type: 'once', at: '2026-07-29T20:00:00+09:00' }],
        cta: { label: '申込', url: 'https://pay.example.com', showAtSeconds: 5400 },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: Record<string, unknown> };
    expect(body.success).toBe(true);
    expect(body.data.slug).toBe('test-webinar');
    expect(body.data.cta).toEqual({ label: '申込', url: 'https://pay.example.com', showAtSeconds: 5400 });
    expect(body.data.schedule).toEqual([{ type: 'once', at: '2026-07-29T20:00:00+09:00' }]);
  });

  test.each([
    ['0秒', 0],
    ['負数', -1],
    ['数値文字列', '60'],
    ['null', null],
  ])('POST — 視聴時間が%sなら400/422で保存しない', async (_label, durationSeconds) => {
    dbMocks.getWebinarBySlug.mockResolvedValue(null);

    const res = await adminReq('/api/webinars', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId: 'account-a', title: '境界確認', slug: 'duration-boundary', durationSeconds,
      }),
    });

    expect(res.status).toBe(typeof durationSeconds === 'number' ? 422 : 400);
    await expect(res.json()).resolves.toMatchObject({ success: false, fields: { durationSeconds: expect.any(String) }, error: expect.any(String) });
    expect(dbMocks.createWebinar).not.toHaveBeenCalled();
  });

  test('POST — 視聴時間省略は422で保存しない', async () => {
    dbMocks.getWebinarBySlug.mockResolvedValue(null);

    const res = await adminReq('/api/webinars', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId: 'account-a', title: '省略確認', slug: 'duration-omitted',
      }),
    });

    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toMatchObject({ success: false, code: 'invalid_duration' , fields: expect.any(Object), error: expect.any(String) });
    expect(dbMocks.createWebinar).not.toHaveBeenCalled();
  });

  test('POST — 視聴時間1秒は保存できる', async () => {
    dbMocks.getWebinarBySlug.mockResolvedValue(null);
    dbMocks.createWebinar.mockResolvedValue(makeWebinar({ duration_seconds: 1 }));

    const res = await adminReq('/api/webinars', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId: 'account-a', title: '1秒ウェビナー', slug: 'one-second', durationSeconds: 1,
      }),
    });

    expect(res.status).toBe(200);
    expect(dbMocks.createWebinar).toHaveBeenCalledWith(
      expect.anything(), expect.objectContaining({ durationSeconds: 1 }),
    );
  });

  test('POST — 別アカウント指定は視聴時間を検証・保存しない', async () => {
    accountAccessMock.canAccessAllLineAccounts.mockResolvedValue(false);

    const res = await adminReq('/api/webinars', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId: 'account-other', title: '別アカウント', slug: 'other-account', durationSeconds: 1,
      }),
    });

    expect(res.status).toBe(403);
    expect(dbMocks.createWebinar).not.toHaveBeenCalled();
  });

  test('POST — ウェビナーフォルダと公開期間を検証して保存する', async () => {
    dbMocks.getWebinarBySlug.mockResolvedValue(null);
    dbMocks.createWebinar.mockResolvedValue(makeWebinar({
      folder_id: 'folder-1',
      publication_starts_at: '2026-08-01T00:00:00.000Z',
      publication_ends_at: '2026-08-31T00:00:00.000Z',
    }));

    const res = await adminReq('/api/webinars', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId: 'account-a', title: '期間公開', slug: 'period-webinar',
        durationSeconds: 7200,
        folderId: 'folder-1',
        publicationStartsAt: '2026-08-01T00:00:00.000Z',
        publicationEndsAt: '2026-08-31T00:00:00.000Z',
      }),
    });

    expect(res.status).toBe(200);
    expect(dbMocks.getFolderById).toHaveBeenCalledWith({}, 'folder-1');
    expect(dbMocks.createWebinar).toHaveBeenCalledWith({}, expect.objectContaining({
      folderId: 'folder-1',
      publicationStartsAt: '2026-08-01T00:00:00.000Z',
      publicationEndsAt: '2026-08-31T00:00:00.000Z',
    }));
  });

  test('POST — 別種類のフォルダと逆転した公開期間を拒否する', async () => {
    dbMocks.getWebinarBySlug.mockResolvedValue(null);
    dbMocks.getFolderById.mockResolvedValue({ id: 'folder-1', kind: 'template' });
    const invalidFolder = await adminReq('/api/webinars', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId: 'account-a', title: '不正', slug: 'invalid-folder', durationSeconds: 7200,
        folderId: 'folder-1',
      }),
    });
    const invalidPeriod = await adminReq('/api/webinars', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId: 'account-a', title: '不正', slug: 'invalid-period', durationSeconds: 7200,
        publicationStartsAt: '2026-09-01T00:00:00.000Z',
        publicationEndsAt: '2026-08-01T00:00:00.000Z',
      }),
    });

    expect(invalidFolder.status).toBe(400);
    expect(invalidPeriod.status).toBe(400);
    expect(dbMocks.createWebinar).not.toHaveBeenCalled();
  });

  test('POST — 別アカウントのウェビナーフォルダへの付け替えを拒否する', async () => {
    dbMocks.getWebinarBySlug.mockResolvedValue(null);
    dbMocks.getFolderById.mockResolvedValue({
      id: 'folder-other', kind: 'webinar', account_id: 'account-other',
    });
    const res = await adminReq('/api/webinars', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId: 'account-a', title: '不正', slug: 'wrong-account-folder',
        durationSeconds: 7200, folderId: 'folder-other',
      }),
    });

    expect(res.status).toBe(400);
    expect(dbMocks.createWebinar).not.toHaveBeenCalled();
  });

  test('POST — title/slug 欠落・slug 形式違反は 400', async () => {
    dbMocks.getWebinarBySlug.mockResolvedValue(null);
    const noTitle = await adminReq('/api/webinars', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: 'account-a', slug: 'x', durationSeconds: 7200 }),
    });
    expect(noTitle.status).toBe(400);
    const badSlug = await adminReq('/api/webinars', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId: 'account-a', title: 't', slug: 'Bad Slug!', durationSeconds: 7200,
      }),
    });
    expect(badSlug.status).toBe(400);
  });

  test('POST — LINEアカウント未指定は保存しない', async () => {
    dbMocks.getWebinarBySlug.mockResolvedValue(null);
    const res = await adminReq('/api/webinars', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '未所属', slug: 'missing-account', durationSeconds: 7200 }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'account_id_required' , fields: expect.any(Object), error: expect.any(String) });
    expect(dbMocks.createWebinar).not.toHaveBeenCalled();
  });

  test('PUT /api/webinars/:id/comments — 一括置換', async () => {
    dbMocks.getWebinarById.mockResolvedValue(makeWebinar());
    dbMocks.replaceWebinarComments.mockResolvedValue(2);
    const res = await adminReq('/api/webinars/w1/comments', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        comments: [
          { atSeconds: 10, authorName: '田中', body: 'こんばんは!' },
          { atSeconds: 30, authorName: '鈴木', body: '楽しみです' },
        ],
      }),
    });
    expect(res.status).toBe(200);
    expect(dbMocks.replaceWebinarComments).toHaveBeenCalledWith(expect.anything(), 'w1', [
      { atSeconds: 10, authorName: '田中', body: 'こんばんは!' },
      { atSeconds: 30, authorName: '鈴木', body: '楽しみです' },
    ]);
  });

  test('PUT /api/webinars/:id/comments — 201件以上は400で止めて書かない', async () => {
    dbMocks.getWebinarById.mockResolvedValue(makeWebinar());
    const comments = Array.from({ length: 201 }, (_, index) => ({
      atSeconds: index, authorName: '田中', body: `コメント${index}`,
    }));
    const res = await adminReq('/api/webinars/w1/comments', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ comments }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'too_many_comments' , fields: expect.any(Object), error: expect.any(String) });
    expect(dbMocks.replaceWebinarComments).not.toHaveBeenCalled();
  });

  test('PUT comments — 負の atSeconds (待機ルーム) は -3600 まで許容', async () => {
    dbMocks.getWebinarById.mockResolvedValue(makeWebinar());
    dbMocks.replaceWebinarComments.mockResolvedValue(1);
    const ok = await adminReq('/api/webinars/w1/comments', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        comments: [{ atSeconds: -300, authorName: 'みお', body: '楽しみです' }],
      }),
    });
    expect(ok.status).toBe(200);
    expect(dbMocks.replaceWebinarComments).toHaveBeenCalledWith(expect.anything(), 'w1', [
      { atSeconds: -300, authorName: 'みお', body: '楽しみです' },
    ]);
    const tooEarly = await adminReq('/api/webinars/w1/comments', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        comments: [{ atSeconds: -4000, authorName: 'みお', body: 'x' }],
      }),
    });
    expect(tooEarly.status).toBe(400);
  });

  test('PUT comments — 不正要素があれば 400 で何も書かない', async () => {
    dbMocks.getWebinarById.mockResolvedValue(makeWebinar());
    const res = await adminReq('/api/webinars/w1/comments', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ comments: [{ atSeconds: -1, authorName: '', body: '' }] }),
    });
    expect(res.status).toBe(400);
    expect(dbMocks.replaceWebinarComments).not.toHaveBeenCalled();
  });

  test('GET editor — 視聴条件・フォーム詳細・LIFF・監視結果を同じ版で返す', async () => {
    dbMocks.getWebinarById.mockResolvedValue(makeWebinar({ account_id: 'account-a' }));
    dbMocks.getWebinarEditorSettings.mockResolvedValue({
      webinar_id: 'w1', version: 4, delivery_kind: 'on_demand',
      viewing_condition_json: '{"kind":"registered","label":"申込済みの友だち"}',
      public_description: '説明', registration_form_id: 'form-1',
      notification_messages_json: '{"registration":"申込完了です"}',
      notification_test_json: '{"status":"passed"}', action_template_body: '視聴後メッセージ',
      missing_result_policy: 'escalate', public_page_test_json: '{"status":"passed"}',
      published_version: 3, published_at: '2026-09-07T00:00:00.000Z', created_at: 'x', updated_at: 'x',
    });
    dbMocks.getFormById.mockResolvedValue({
      id: 'form-1', name: '申込フォーム', is_active: 1,
      fields: '[{"label":"お名前"},{"label":"会社名"}]',
      on_submit_tag_id: 'tag-1', on_submit_scenario_id: 'scenario-1',
      on_submit_message_type: 'text', on_submit_webhook_url: null,
    });
    // カード方式のCTAが2件 → 段の印・最終確認が見る件数として返る。
    dbMocks.getWebinarCtas.mockResolvedValue([{ id: 'cta-1' }, { id: 'cta-2' }]);

    const res = await adminReq('/api/webinars/w1/editor');
    const body = (await res.json()) as { data: Record<string, unknown> };

    expect(res.status).toBe(200);
    expect(body.data).toMatchObject({
      version: 4, deliveryKind: 'on_demand', publicDescription: '説明',
      ctaCount: 2,
      updatedAt: expect.any(String) as unknown as string,
      viewingCondition: { kind: 'registered', label: '申込済みの友だち' },
      publicPage: {
        liffId: '999-test', form: {
          name: '申込フォーム', fields: ['お名前', '会社名'],
          completionActions: ['タグを付ける', 'シナリオを開始する', '完了メッセージを送る'],
        },
      },
      monitoring: { notificationFailures: 0, duplicateRegistrations: 0 },
    });
  });

  test('PUT editor — expectedVersion を必須にして保存結果を返す', async () => {
    dbMocks.getWebinarById.mockResolvedValue(makeWebinar({ account_id: 'account-a' }));
    dbMocks.getFormById.mockResolvedValue({ id: 'form-1', is_active: 1 });
    const missingVersion = await adminReq('/api/webinars/w1/editor', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ publicDescription: '更新' }),
    });
    const saved = await adminReq('/api/webinars/w1/editor', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedVersion: 4, registrationFormId: 'form-1', publicDescription: '更新' }),
    });

    expect(missingVersion.status).toBe(400);
    expect(saved.status).toBe(200);
    expect(dbMocks.saveWebinarEditorSettings).toHaveBeenCalledWith(
      expect.anything(), 'w1', 4, expect.objectContaining({ publicDescription: '更新' }),
    );
  });

  test('POST public-page/test — LIFF・動画・フォームを検査して結果を版付き保存する', async () => {
    dbMocks.getWebinarById.mockResolvedValue(makeWebinar({ account_id: 'account-a' }));
    dbMocks.getWebinarEditorSettings.mockResolvedValue({
      webinar_id: 'w1', version: 4, delivery_kind: 'scheduled',
      viewing_condition_json: '{}', public_description: '', registration_form_id: 'form-1',
      notification_messages_json: '{}', notification_test_json: null,
      action_template_body: '', missing_result_policy: 'escalate', public_page_test_json: null,
      published_version: null, published_at: null, created_at: 'x', updated_at: 'x',
    });
    dbMocks.getFormById.mockResolvedValue({ id: 'form-1', name: '申込フォーム', is_active: 1, fields: '[]' });

    const res = await adminReq('/api/webinars/w1/public-page/test', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedVersion: 4 }),
    });

    expect(res.status).toBe(200);
    expect(dbMocks.saveWebinarEditorSettings).toHaveBeenCalledWith(
      expect.anything(), 'w1', 4,
      expect.objectContaining({ publicPageTest: expect.objectContaining({ status: 'passed', failures: [] }) }),
    );
  });

  test('GET publish-validation — 公開ページ・通知・重複を検査する', async () => {
    dbMocks.getWebinarById.mockResolvedValue(makeWebinar({ account_id: 'account-a' }));
    dbMocks.getWebinarEditorSettings.mockResolvedValue({
      webinar_id: 'w1', version: 4, delivery_kind: 'scheduled',
      viewing_condition_json: '{}', public_description: '', registration_form_id: 'form-1',
      notification_messages_json: '{}', notification_test_json: '{"status":"passed"}',
      action_template_body: '', missing_result_policy: 'escalate',
      public_page_test_json: '{"status":"passed"}', published_version: null, published_at: null,
      created_at: 'x', updated_at: 'x',
    });
    dbMocks.getFormById.mockResolvedValue({ id: 'form-1', name: '申込フォーム', is_active: 1, fields: '[]' });
    dbMocks.getWebinarCtas.mockResolvedValue([{ at_seconds: 300, kind: 'url', url: 'https://example.com' }]);
    dbMocks.getWebinarActions.mockResolvedValue([{ id: 'action-1' }]);

    const res = await adminReq('/api/webinars/w1/publish-validation');
    const body = (await res.json()) as { data: { blockers: string[]; checks: Array<{ key: string; status: string }> } };

    expect(res.status).toBe(200);
    expect(body.data.blockers).toEqual([]);
    expect(body.data.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'public_page_test', status: 'passed' }),
      expect.objectContaining({ key: 'notification_test', status: 'passed' }),
      expect.objectContaining({ key: 'notification_duplicates', status: 'passed' }),
    ]));
  });

  test('公開時の版競合は現在の版を返し、無条件の状態更新をしない', async () => {
    dbMocks.getWebinarById.mockResolvedValue(makeWebinar({ account_id: 'account-a' }));
    dbMocks.getWebinarEditorSettings.mockResolvedValue({
      webinar_id:'w1', version:4, delivery_kind:'scheduled', viewing_condition_json:'{}', public_description:'', registration_form_id:'form-1',
      notification_messages_json:'{}', notification_test_json:'{"status":"passed"}', action_template_body:'', missing_result_policy:'escalate',
      public_page_test_json:'{"status":"passed"}', published_version:null, published_at:null, created_at:'x', updated_at:'x',
    });
    dbMocks.getFormById.mockResolvedValue({id:'form-1', name:'申込フォーム', is_active:1, fields:'[]'});
    dbMocks.getWebinarCtas.mockResolvedValue([{at_seconds:300, kind:'url', url:'https://example.com'}]);
    dbMocks.getWebinarActions.mockResolvedValue([{id:'action-1'}]);
    dbMocks.publishWebinarAndActivate.mockResolvedValue(false);
    const res=await adminReq('/api/webinars/w1/publish',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({expectedVersion:4})});
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({error:'version_conflict',currentVersion:4});
    expect(dbMocks.publishWebinarAndActivate).toHaveBeenCalledWith(expect.anything(),'w1',4);
    expect(dbMocks.updateWebinar).not.toHaveBeenCalled();
  });

  test('GET participants — 実行エラーと担当者連携状態をカーソル付きで返す', async () => {
    dbMocks.getWebinarById.mockResolvedValue(makeWebinar());
    dbMocks.getWebinarParticipantOperations.mockResolvedValue([{
      friend_id: 'friend-1', friend_name: '山田太郎', picture_url: null, sessions: 1,
      first_joined_at: '2026-09-07T00:00:00.000Z', latest_joined_at: '2026-09-07T00:30:00.000Z',
      max_watched_seconds: 1200, cta_clicked_at: null, registered: 1, form_submitted_at: null,
      action_status: 'failed', action_error: 'シナリオ開始に失敗', integration_status: 'needs_attention',
    }]);

    const res = await adminReq('/api/webinars/w1/participants?limit=20');
    const body = (await res.json()) as { data: { items: Array<Record<string, unknown>>; nextCursor: string | null } };

    expect(res.status).toBe(200);
    expect(body.data.items[0]).toMatchObject({
      friendId: 'friend-1', actionStatus: 'failed', errorDetail: 'シナリオ開始に失敗',
      staffIntegrationStatus: 'needs_attention',
    });
    expect(body.data.nextCursor).toBeNull();
  });

  test('GET /api/webinars/:id/analytics — summary + trend + participants', async () => {
    dbMocks.getWebinarById.mockResolvedValue(makeWebinar());
    dbMocks.getWebinarSessionStats.mockResolvedValue([
      { session_start_at: SESSION_START, viewers: 10, avg_watched_seconds: 3600, cta_clicks: 3 },
    ]);
    dbMocks.getWebinarDropoff.mockResolvedValue([{ bucket_start: 0, viewers: 4 }]);
    dbMocks.getWebinarAnalyticsSummary.mockResolvedValue({
      reservations: 12,
      viewers: 2,
      registered_and_joined: 1,
      watched_5m: 2,
      watched_15m: 1,
      completed: 1,
      avg_watched_seconds: 3550,
      cta_clicks: 1,
      form_submissions: 1,
    });
    dbMocks.getWebinarParticipantStats.mockResolvedValue([
      {
        friend_id: 'friend-1', friend_name: '山田太郎', picture_url: 'https://example.com/u.jpg',
        sessions: 2, first_joined_at: '2026-08-05T10:00:00+09:00',
        latest_joined_at: '2026-08-06T10:00:00+09:00', max_watched_seconds: 6500,
        cta_clicked_at: '2026-08-06T11:00:00+09:00', registered: 1,
        form_submitted_at: '2026-08-06T11:01:00+09:00',
      },
      {
        friend_id: 'friend-2', friend_name: '佐藤花子', picture_url: null,
        sessions: 1, first_joined_at: '2026-08-06T10:00:00+09:00',
        latest_joined_at: '2026-08-06T10:00:00+09:00', max_watched_seconds: 600,
        cta_clicked_at: null, registered: 0, form_submitted_at: null,
      },
    ]);
    dbMocks.getWebinarDailyStats.mockResolvedValue([
      { stat_date: '2026-08-06', reservations: 5, viewers: 4, cta_clicks: 2, form_submissions: 1 },
    ]);
    dbMocks.getWebinarFormFunnelStats.mockResolvedValue({
      cta_impressions: 10,
      cta_clicks: 8,
      form_opens: 7,
      form_starts: 6,
      submit_attempts: 5,
      submit_successes: 4,
      submit_errors: 1,
      field_completions: [{ field_name: 'annual_revenue', users: 6 }],
    });
    const res = await adminReq('/api/webinars/w1/analytics');
    const body = (await res.json()) as {
      data: {
        sessions: unknown;
        dropoff: unknown;
        summary: unknown;
        daily: unknown;
        participants: Array<Record<string, unknown>>;
        formFunnel: Record<string, unknown>;
      };
    };
    expect(body.data.sessions).toEqual([
      { sessionStartAt: SESSION_START, viewers: 10, avgWatchedSeconds: 3600, ctaClicks: 3 },
    ]);
    expect(body.data.dropoff).toEqual([{ bucketStart: 0, viewers: 4 }]);
    expect(body.data.summary).toEqual({
      reservations: 12,
      viewers: 2,
      registeredAndJoined: 1,
      watched5m: 2,
      watched15m: 1,
      completed: 1,
      avgWatchedSeconds: 3550,
      ctaClicks: 1,
      formSubmissions: 1,
    });
    expect(body.data.daily).toEqual([
      { date: '2026-08-06', reservations: 5, viewers: 4, ctaClicks: 2, formSubmissions: 1 },
    ]);
    expect(body.data.participants).toHaveLength(2);
    expect(body.data.participants[0]).toMatchObject({
      friendId: 'friend-1', friendName: '山田太郎', registered: true,
      pictureUrl: 'https://example.com/u.jpg', formSubmittedAt: '2026-08-06T11:01:00+09:00',
    });
    expect(body.data.formFunnel).toEqual({
      ctaImpressions: 10,
      ctaClicks: 8,
      formOpens: 7,
      formStarts: 6,
      submitAttempts: 5,
      submitSuccesses: 4,
      submitErrors: 1,
      fieldCompletions: [{ fieldName: 'annual_revenue', users: 6 }],
    });
  });

  test('分析に維持率・視聴開始・申込ボタンの時刻を返す (J-1)', async () => {
    dbMocks.getWebinarById.mockResolvedValue(makeWebinar({ account_id: 'account-a' }));
    dbMocks.getWebinarSessionStats.mockResolvedValue([]);
    dbMocks.getWebinarDropoff.mockResolvedValue([]);
    dbMocks.getWebinarParticipantStats.mockResolvedValue([]);
    dbMocks.getWebinarAnalyticsSummary.mockResolvedValue({
      reservations: 150, viewers: 112, registered_and_joined: 110,
      watched_5m: 100, watched_15m: 80, completed: 41,
      avg_watched_seconds: 1800, cta_clicks: 30, form_submissions: 10,
    });
    dbMocks.getWebinarDailyStats.mockResolvedValue([]);
    dbMocks.getWebinarFormFunnelStats.mockResolvedValue({
      cta_impressions: 100, cta_clicks: 30, form_opens: 20, form_starts: 15,
      submit_attempts: 12, submit_successes: 10, submit_errors: 1, field_completions: [],
    });
    dbMocks.getWebinarViewSegmentCoverage.mockResolvedValue([]);
    dbMocks.getWebinarEditorSettings.mockResolvedValue(null);
    dbMocks.getWebinarRetention.mockResolvedValue({
      bucketSeconds: 60,
      started: 112,
      points: [
        { at_seconds: 0, viewers: 112 },
        { at_seconds: 60, viewers: 90 },
      ],
    });
    dbMocks.countWebinarStartedViewers.mockResolvedValue(112);
    dbMocks.countWebinarHeartbeatRejects.mockResolvedValue(3);
    dbMocks.getWebinarCtas.mockResolvedValue([
      { id: 'cta-1', at_seconds: 1500, kind: 'form', title: '申し込む', body: null, button_label: '申し込む', auto_open: 0, form_id: 'f1', url: null },
    ]);
    const res = await adminReq('/api/webinars/w1/analytics');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        retention: { bucketSeconds: number; started: number; points: Array<{ atSeconds: number; viewers: number }> };
        startedViewers: number;
        heartbeatRejects: number;
        ctaAtSeconds: number | null;
      };
    };
    expect(body.data.retention).toEqual({
      bucketSeconds: 60,
      started: 112,
      points: [
        { atSeconds: 0, viewers: 112 },
        { atSeconds: 60, viewers: 90 },
      ],
    });
    expect(body.data.startedViewers).toBe(112);
    expect(body.data.heartbeatRejects).toBe(3);
    expect(body.data.ctaAtSeconds).toBe(1500);
  });

  test('POST /api/webinars/:id/archive は履歴を消さずアーカイブする', async () => {
    const archived = makeWebinar({ status: 'archived' });
    dbMocks.getWebinarById.mockResolvedValue(makeWebinar({ status: 'draft' }));
    dbMocks.archiveWebinar.mockResolvedValue(archived);
    const res = await adminReq('/api/webinars/w1/archive', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(dbMocks.archiveWebinar).toHaveBeenCalledWith(expect.anything(), 'w1');
    await expect(res.json()).resolves.toMatchObject({ data: { status: 'archived' } });
  });

  test('公開中は停止前にアーカイブできない', async () => {
    dbMocks.getWebinarById.mockResolvedValue(makeWebinar({ status: 'active' }));
    const res = await adminReq('/api/webinars/w1/archive', { method: 'POST' });
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: 'webinar_pause_required' });
    expect(dbMocks.archiveWebinar).not.toHaveBeenCalled();
  });

  test('旧DELETE経路も物理削除せずアーカイブする', async () => {
    dbMocks.getWebinarById.mockResolvedValue(makeWebinar({ status: 'draft' }));
    dbMocks.archiveWebinar.mockResolvedValue(makeWebinar({ status: 'archived' }));
    const res = await adminReq('/api/webinars/w1', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(dbMocks.archiveWebinar).toHaveBeenCalledWith(expect.anything(), 'w1');
  });

  test('視聴後アクションを共通アクション名で保存する', async () => {
    dbMocks.getWebinarById.mockResolvedValue(makeWebinar({ status: 'draft' }));
    dbMocks.replaceWebinarActions.mockResolvedValue([{
      id: 'action-1', webinar_id: 'w1', trigger: 'completed', action_type: 'add_tag',
      config_json: '{"tagId":"tag-1"}', position: 0, version: 2, enabled: 1,
      created_at: 'x', updated_at: 'x',
    }]);
    const res = await adminReq('/api/webinars/w1/actions', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actions: [{ trigger: 'completed', actionType: 'add_tag', config: { tagId: 'tag-1' } }] }),
    });
    expect(res.status).toBe(200);
    expect(dbMocks.replaceWebinarActions).toHaveBeenCalledWith(expect.anything(), 'w1', [{
      trigger: 'completed', actionType: 'add_tag', config: { tagId: 'tag-1' },
    }]);
    await expect(res.json()).resolves.toMatchObject({ data: [{ actionType: 'add_tag', version: 2 }] });
  });

  test('未知の視聴後アクションは保存しない', async () => {
    dbMocks.getWebinarById.mockResolvedValue(makeWebinar({ status: 'draft' }));
    const res = await adminReq('/api/webinars/w1/actions', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actions: [{ trigger: 'completed', actionType: 'run_sql', config: {} }] }),
    });
    expect(res.status).toBe(400);
    expect(dbMocks.replaceWebinarActions).not.toHaveBeenCalled();
  });

  test('視聴後アクションは参照先が無効なら422で保存しない', async () => {
    dbMocks.getWebinarById.mockResolvedValue(makeWebinar({ status: 'draft' }));
    dbMocks.countInvalidWebinarActionReferences.mockResolvedValue(1);
    const res = await adminReq('/api/webinars/w1/actions', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        actions: [{ trigger: 'completed', actionType: 'add_tag', config: { tagId: '  ' } }],
      }),
    });
    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toMatchObject({ code: 'invalid_action_reference' , fields: expect.any(Object), error: expect.any(String) });
    expect(dbMocks.replaceWebinarActions).not.toHaveBeenCalled();
  });

  test('参加者CSVは個人データを式として実行させず書き出す', async () => {
    dbMocks.getWebinarById.mockResolvedValue(makeWebinar());
    dbMocks.getWebinarParticipantOperations.mockResolvedValue([{
      friend_id: 'friend-1', friend_name: '=HYPERLINK("https://bad.example")', picture_url: null,
      sessions: 1, first_joined_at: '2026-09-06T10:00:00+09:00', latest_joined_at: '2026-09-06T10:30:00+09:00',
      max_watched_seconds: 1800, cta_clicked_at: null, registered: 1, form_submitted_at: null,
      action_status: null, action_error: null, integration_status: 'pending',
      live_sessions: 1, replay_sessions: 0, last_join_kind: 'live',
    }]);
    const res = await adminReq('/api/webinars/w1/participants.csv');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    const text = await res.text();
    expect(text).toContain("'=HYPERLINK")
    // 分類・ライブ/録画の列が出る（: 分類の根拠と区別をCSVでも確認できる）。
    expect(text).toContain('分類');
    expect(text).toContain('途中離脱');
  });

  test('PUT /api/webinars/:id — 空 title は 400 で updateWebinar が呼ばれない', async () => {
    dbMocks.getWebinarById.mockResolvedValue(makeWebinar());
    const res = await adminReq('/api/webinars/w1', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '  ' }),
    });
    expect(res.status).toBe(400);
    expect(dbMocks.updateWebinar).not.toHaveBeenCalled();
  });

  test.each([
    ['0秒', 0],
    ['負数', -1],
    ['数値文字列', '60'],
    ['null', null],
  ])('PUT /api/webinars/:id — 視聴時間が%sなら400/422で更新しない', async (_label, durationSeconds) => {
    dbMocks.getWebinarById.mockResolvedValue(makeWebinar({ account_id: 'account-a' }));

    const res = await adminReq('/api/webinars/w1', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ durationSeconds }),
    });

    expect(res.status).toBe(typeof durationSeconds === 'number' ? 422 : 400);
    await expect(res.json()).resolves.toMatchObject({ success: false, fields: { durationSeconds: expect.any(String) }, error: expect.any(String) });
    expect(dbMocks.updateWebinar).not.toHaveBeenCalled();
  });

  test('PUT /api/webinars/:id — 視聴時間1秒は更新できる', async () => {
    dbMocks.getWebinarById.mockResolvedValue(makeWebinar({ account_id: 'account-a' }));
    dbMocks.updateWebinar.mockResolvedValue(makeWebinar({ account_id: 'account-a', duration_seconds: 1 }));

    const res = await adminReq('/api/webinars/w1', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ durationSeconds: 1 }),
    });

    expect(res.status).toBe(200);
    expect(dbMocks.updateWebinar).toHaveBeenCalledWith(
      expect.anything(), 'w1', expect.objectContaining({ durationSeconds: 1 }), 0,
    );
  });

  test('PUT /api/webinars/:id — 視聴時間省略は既存の正値を保つ', async () => {
    dbMocks.getWebinarById.mockResolvedValue(makeWebinar({
      account_id: 'account-a', duration_seconds: 7200,
    }));
    dbMocks.updateWebinar.mockResolvedValue(makeWebinar({
      account_id: 'account-a', title: '名称だけ更新', duration_seconds: 7200,
    }));

    const res = await adminReq('/api/webinars/w1', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '名称だけ更新' }),
    });

    expect(res.status).toBe(200);
    expect(dbMocks.updateWebinar).toHaveBeenCalledWith(
      expect.anything(), 'w1', expect.not.objectContaining({ durationSeconds: expect.anything() }), 0,
    );
    await expect(res.json()).resolves.toMatchObject({
      success: true, data: { durationSeconds: 7200 },
    });
  });

  test('PUT /api/webinars/:id — 別アカウントの実在IDは404で更新しない', async () => {
    dbMocks.getWebinarById.mockResolvedValue(makeWebinar({ id: 'other-webinar', account_id: 'account-other' }));
    accountAccessMock.canAccessAllLineAccounts.mockResolvedValue(false);

    const res = await adminReq('/api/webinars/other-webinar', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ durationSeconds: 1 }),
    });

    expect(res.status).toBe(404);
    expect(dbMocks.updateWebinar).not.toHaveBeenCalled();
  });
});


describe('webinar CTA cards', () => {
  const CTA_ROW = {
    id: 'cta1', webinar_id: 'w1', at_seconds: 300, kind: 'form',
    title: '個別導入診断', body: '限定枠です', button_label: '診断を受ける',
    auto_open: 1, form_id: 'form-1', url: null, created_at: 'x', updated_at: 'x',
  };

  test('LIFF state に ctas が camelCase で含まれる', async () => {
    dbMocks.getWebinarCtas.mockResolvedValue([CTA_ROW]);
    const res = await req('/api/liff/webinars/test-webinar', {
      headers: { Authorization: 'Bearer t' },
    });
    const body = (await res.json()) as { ctas: unknown[] };
    expect(body.ctas).toEqual([{
      id: 'cta1', atSeconds: 300, kind: 'form', title: '個別導入診断',
      body: '限定枠です', buttonLabel: '診断を受ける', autoOpen: true, formId: 'form-1', url: null,
    }]);
  });

  test('PUT /api/webinars/:id/ctas — form kind は forms 実在チェック後に置換', async () => {
    dbMocks.getWebinarById.mockResolvedValue(makeWebinar({ account_id: 'account-a' }));
    dbMocks.getFormById.mockResolvedValue({ id: 'form-1', is_active: 1 });
    dbMocks.replaceWebinarCtas.mockResolvedValue(1);
    const res = await adminReq('/api/webinars/w1/ctas', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ctas: [{
        atSeconds: 300, kind: 'form', title: '個別導入診断',
        body: '限定枠です', buttonLabel: '診断を受ける', autoOpen: true, formId: 'form-1',
      }] }),
    });
    expect(res.status).toBe(200);
    expect(dbMocks.replaceWebinarCtas).toHaveBeenCalledWith(expect.anything(), 'w1', [{
      atSeconds: 300, kind: 'form', title: '個別導入診断', body: '限定枠です',
      buttonLabel: '診断を受ける', autoOpen: true, formId: 'form-1', url: null,
    }], { expectedVersion: 0, updatedBy: 'owner-1' });
  });

  test('PUT ctas — 存在しない form は 400 で何も書かない', async () => {
    dbMocks.getWebinarById.mockResolvedValue(makeWebinar());
    dbMocks.getFormById.mockResolvedValue(null);
    const res = await adminReq('/api/webinars/w1/ctas', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ctas: [{
        atSeconds: 0, kind: 'form', title: 't', buttonLabel: 'b', formId: 'nope',
      }] }),
    });
    expect(res.status).toBe(400);
    expect(dbMocks.replaceWebinarCtas).not.toHaveBeenCalled();
  });

  test('PUT ctas — url kind は https 必須', async () => {
    dbMocks.getWebinarById.mockResolvedValue(makeWebinar());
    const bad = await adminReq('/api/webinars/w1/ctas', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ctas: [{
        atSeconds: 0, kind: 'url', title: 't', buttonLabel: 'b', url: 'javascript:alert(1)',
      }] }),
    });
    expect(bad.status).toBe(400);
    dbMocks.replaceWebinarCtas.mockResolvedValue(1);
    const ok = await adminReq('/api/webinars/w1/ctas', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ctas: [{
        atSeconds: 0, kind: 'url', title: 't', buttonLabel: 'b', url: 'https://example.com/pay',
      }] }),
    });
    expect(ok.status).toBe(200);
  });

  test('PUT ctas — 無効化されたフォームは 400', async () => {
    dbMocks.getWebinarById.mockResolvedValue(makeWebinar());
    dbMocks.getFormById.mockResolvedValue({ id: 'form-1', is_active: 0 });
    const res = await adminReq('/api/webinars/w1/ctas', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ctas: [{
        atSeconds: 0, kind: 'form', title: 't', buttonLabel: 'b', formId: 'form-1',
      }] }),
    });
    expect(res.status).toBe(400);
    expect(dbMocks.replaceWebinarCtas).not.toHaveBeenCalled();
  });

  test('GET /api/webinars/:id/ctas — serialize して返す', async () => {
    dbMocks.getWebinarById.mockResolvedValue(makeWebinar());
    dbMocks.getWebinarCtas.mockResolvedValue([CTA_ROW]);
    const res = await adminReq('/api/webinars/w1/ctas');
    const body = (await res.json()) as { data: unknown[] };
    expect(body.data).toEqual([{
      id: 'cta1', atSeconds: 300, kind: 'form', title: '個別導入診断',
      body: '限定枠です', buttonLabel: '診断を受ける', autoOpen: true, formId: 'form-1', url: null,
    }]);
  });
});

/*
 * ウェビナーの入力・公開・配信条件の境界を、失敗すべき条件も含めて確かめる。
 */
describe('R95 公開は公開専用口へ集約する', () => {
  test('PUT 基本更新で下書き→公開中は409で止まり更新しない', async () => {
    dbMocks.getWebinarById.mockResolvedValue(makeWebinar({ account_id: 'account-a', status: 'draft' }));
    const res = await adminReq('/api/webinars/w1', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'active', title: '公開する' }),
    });
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({ success: false, error: 'publish_via_publish_endpoint' });
    expect(dbMocks.updateWebinar).not.toHaveBeenCalled();
  });

  test('PUT 公開中のまま他項目の保存は通す', async () => {
    dbMocks.getWebinarById.mockResolvedValue(makeWebinar({ account_id: 'account-a', status: 'active' }));
    dbMocks.updateWebinar.mockResolvedValue(makeWebinar({ account_id: 'account-a', status: 'active', title: '名だけ直す' }));
    const res = await adminReq('/api/webinars/w1', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'active', title: '名だけ直す' }),
    });
    expect(res.status).toBe(200);
    expect(dbMocks.updateWebinar).toHaveBeenCalled();
  });

  test('POST 作成時に公開中は422で作らない', async () => {
    const res = await adminReq('/api/webinars', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId: 'account-a', title: '作ってすぐ公開', slug: 'new-webinar',
        status: 'active', durationSeconds: 3600, schedule: [],
      }),
    });
    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toMatchObject({ success: false, code: 'publish_via_publish_endpoint' , fields: expect.any(Object), error: expect.any(String) });
    expect(dbMocks.createWebinar).not.toHaveBeenCalled();
  });
});

describe('R99 公開期間の窓を顧客入口で止める', () => {
  test('公開開始前は視聴状態を404で止める', async () => {
    dbMocks.getWebinarBySlug.mockResolvedValue(makeWebinar({
      publication_starts_at: '2099-01-01T00:00:00+09:00',
    }));
    const res = await req('/api/liff/webinars/test-webinar', {
      headers: { Authorization: 'Bearer [REDACTED]' },
    });
    expect(res.status).toBe(404);
    expect(dbMocks.upsertWebinarViewer).not.toHaveBeenCalled();
  });

  test('公開終了後は視聴状態を404で止める', async () => {
    dbMocks.getWebinarBySlug.mockResolvedValue(makeWebinar({
      publication_ends_at: '2020-01-01T00:00:00+09:00',
    }));
    const res = await req('/api/liff/webinars/test-webinar', {
      headers: { Authorization: 'Bearer [REDACTED]' },
    });
    expect(res.status).toBe(404);
    expect(dbMocks.upsertWebinarViewer).not.toHaveBeenCalled();
  });

  test('終了後も予約済み本人の録画視聴は通す', async () => {
    const pastStart = SESSION_START - 7200;
    dbMocks.getWebinarBySlug.mockResolvedValue(makeWebinar({
      publication_ends_at: '2020-01-01T00:00:00+09:00',
    }));
    dbMocks.getWebinarRegistration.mockResolvedValue({
      id: 'reg-past', webinar_id: 'w1', friend_id: 'friend-1',
      session_start_at: pastStart, notified_at: 'x', created_at: 'x',
    });
    const res = await req(`/api/liff/webinars/test-webinar?sessionStartAt=${pastStart}`, {
      headers: { Authorization: 'Bearer [REDACTED]' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.live).toBe(true);
    expect(body.replay).toBe(true);
    expect(body.sessionStartAt).toBe(pastStart);
  });

  test('終了後は予約なしの録画リンクを開いても404', async () => {
    const pastStart = SESSION_START - 7200;
    dbMocks.getWebinarBySlug.mockResolvedValue(makeWebinar({
      publication_ends_at: '2020-01-01T00:00:00+09:00',
    }));
    dbMocks.getWebinarRegistration.mockResolvedValue(null);
    const res = await req(`/api/liff/webinars/test-webinar?sessionStartAt=${pastStart}`, {
      headers: { Authorization: 'Bearer [REDACTED]' },
    });
    expect(res.status).toBe(404);
  });

  test('公開終了後は新しい申込を404で止める', async () => {
    dbMocks.getWebinarBySlug.mockResolvedValue(makeWebinar({
      publication_ends_at: '2020-01-01T00:00:00+09:00',
    }));
    const res = await postJson('/api/liff/webinars/test-webinar/register', {
      sessionStartAt: SESSION_START,
    });
    expect(res.status).toBe(404);
    expect(webinarNotificationMocks.registerWebinarSession).not.toHaveBeenCalled();
  });
});

describe('R96 オンデマンドは枠なしで視聴できる', () => {
  const ON_DEMAND_START = Math.floor(Date.parse('2026-07-01T00:00:00+09:00') / 1000);
  function onDemandWebinar(over: Record<string, unknown> = {}) {
    return makeWebinar({
      schedule_json: '[]',
      created_at: '2026-07-01T00:00:00+09:00',
      cta_json: null,
      tag_on_attend: null,
      ...over,
    });
  }

  test('枠なしオンデマンドの視聴状態は常設回をliveで返す', async () => {
    dbMocks.getWebinarBySlug.mockResolvedValue(onDemandWebinar());
    dbMocks.getWebinarEditorSettings.mockResolvedValue(null);
    const res = await req('/api/liff/webinars/test-webinar', {
      headers: { Authorization: 'Bearer [REDACTED]' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.live).toBe(true);
    expect(body.replay).toBe(true);
    expect(body.sessionStartAt).toBe(ON_DEMAND_START);
    expect(body.offsetSeconds).toBe(0);
    expect(body.upcoming).toEqual([]);
    expect(body.playlistUrl).toMatch(
      /^\/webinar-assets\/\d+\.[A-Za-z0-9_-]+\/test-webinar\/master\.m3u8$/,
    );
    expect(dbMocks.upsertWebinarViewer).toHaveBeenCalledWith(
      expect.anything(), 'w1', 'friend-1', ON_DEMAND_START,
    );
  });

  test('日時指定で枠なしの公開検証は配信方法の不足で止まる', async () => {
    dbMocks.getWebinarById.mockResolvedValue(onDemandWebinar({ account_id: 'account-a' }));
    dbMocks.getWebinarEditorSettings.mockResolvedValue({
      webinar_id: 'w1', version: 4, delivery_kind: 'scheduled',
      viewing_condition_json: '{}', public_description: '', registration_form_id: 'form-1',
      notification_messages_json: '{}', notification_test_json: '{"status":"passed"}',
      action_template_body: '', missing_result_policy: 'escalate',
      public_page_test_json: '{"status":"passed"}', published_version: null, published_at: null,
      created_at: 'x', updated_at: 'x',
    });
    dbMocks.getFormById.mockResolvedValue({ id: 'form-1', name: '申込フォーム', is_active: 1, fields: '[]' });
    dbMocks.getWebinarCtas.mockResolvedValue([{ at_seconds: 300, kind: 'url', url: 'https://example.com' }]);
    dbMocks.getWebinarActions.mockResolvedValue([]);
    const res = await adminReq('/api/webinars/w1/publish-validation');
    const body = (await res.json()) as { data: { blockers: string[] } };
    expect(res.status).toBe(200);
    expect(body.data.blockers).toContain('delivery_schedule');
  });

  test('オンデマンド枠なしの公開検証は配信方法で止まらない', async () => {
    dbMocks.getWebinarById.mockResolvedValue(onDemandWebinar({ account_id: 'account-a' }));
    dbMocks.getWebinarEditorSettings.mockResolvedValue({
      webinar_id: 'w1', version: 4, delivery_kind: 'on_demand',
      viewing_condition_json: '{}', public_description: '', registration_form_id: 'form-1',
      notification_messages_json: '{}', notification_test_json: '{"status":"passed"}',
      action_template_body: '', missing_result_policy: 'escalate',
      public_page_test_json: '{"status":"passed"}', published_version: null, published_at: null,
      created_at: 'x', updated_at: 'x',
    });
    dbMocks.getFormById.mockResolvedValue({ id: 'form-1', name: '申込フォーム', is_active: 1, fields: '[]' });
    dbMocks.getWebinarCtas.mockResolvedValue([{ at_seconds: 300, kind: 'url', url: 'https://example.com' }]);
    dbMocks.getWebinarActions.mockResolvedValue([]);
    const res = await adminReq('/api/webinars/w1/publish-validation');
    const body = (await res.json()) as { data: { blockers: string[] } };
    expect(res.status).toBe(200);
    expect(body.data.blockers).not.toContain('delivery_schedule');
    expect(body.data.blockers).toEqual([]);
  });

  test('オンデマンドの常設回への申込は確認通知なしで受ける', async () => {
    dbMocks.getWebinarBySlug.mockResolvedValue(onDemandWebinar());
    dbMocks.getWebinarEditorSettings.mockResolvedValue(null);
    const res = await postJson('/api/liff/webinars/test-webinar/register', {
      sessionStartAt: ON_DEMAND_START,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, sessionStartAt: ON_DEMAND_START, confirmationQueued: false });
    expect(webinarNotificationMocks.registerWebinarSession).toHaveBeenCalledWith(
      expect.anything(), 'w1', 'friend-1', ON_DEMAND_START,
    );
  });

  test('オンデマンドの常設回以外への申込は400', async () => {
    dbMocks.getWebinarBySlug.mockResolvedValue(onDemandWebinar());
    dbMocks.getWebinarEditorSettings.mockResolvedValue(null);
    const res = await postJson('/api/liff/webinars/test-webinar/register', {
      sessionStartAt: ON_DEMAND_START + 60,
    });
    expect(res.status).toBe(400);
    expect(webinarNotificationMocks.registerWebinarSession).not.toHaveBeenCalled();
  });

  test('オンデマンドのコメントは常設回だけ受ける', async () => {
    dbMocks.getWebinarBySlug.mockResolvedValue(onDemandWebinar());
    dbMocks.getWebinarEditorSettings.mockResolvedValue(null);
    dbMocks.countSessionUserComments.mockResolvedValue(0);
    const ok = await postJson('/api/liff/webinars/test-webinar/comments', {
      sessionStartAt: ON_DEMAND_START, atSeconds: 100, body: 'いつでも見られる',
    });
    expect(ok.status).toBe(200);
    const ng = await postJson('/api/liff/webinars/test-webinar/comments', {
      sessionStartAt: ON_DEMAND_START + 60, atSeconds: 100, body: 'x',
    });
    expect(ng.status).toBe(409);
  });

  test('オンデマンドの計測は申込なしで通し、日時指定は従来どおり止める', async () => {
    dbMocks.getWebinarRegistration.mockResolvedValue(null);
    dbMocks.getWebinarBySlug.mockResolvedValue(onDemandWebinar());
    dbMocks.getWebinarEditorSettings.mockResolvedValue(null);
    const onDemand = await postJson('/api/liff/webinars/test-webinar/funnel-event', {
      sessionStartAt: ON_DEMAND_START, eventType: 'cta_impression',
    });
    expect(onDemand.status).toBe(200);

    dbMocks.getWebinarBySlug.mockResolvedValue(makeWebinar());
    const scheduled = await postJson('/api/liff/webinars/test-webinar/funnel-event', {
      sessionStartAt: SESSION_START, eventType: 'cta_impression',
    });
    expect(scheduled.status).toBe(409);
  });
});

describe('R97 視聴後アクションを実行口へ接続する', () => {
  async function flushBackground() {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  }

  test('視聴完了で完了きっかけのタグ付けが実行され記録される', async () => {
    dbMocks.getWebinarWatchedSeconds.mockResolvedValueOnce(7200);
    dbMocks.getWebinarActions.mockResolvedValue([{
      id: 'action-1', webinar_id: 'w1', trigger: 'completed', action_type: 'add_tag',
      config_json: JSON.stringify({ tagId: 'tag-done' }), position: 0, version: 1,
      enabled: 1, created_at: 'x', updated_at: 'x',
    }]);
    const res = await postJson('/api/liff/webinars/test-webinar/heartbeat', {
      sessionStartAt: SESSION_START,
      positionSeconds: 6480,
    });
    expect(res.status).toBe(200);
    await flushBackground();
    expect(tagMock.attachTagAndFireSideEffects).toHaveBeenCalledWith(
      expect.anything(), 'friend-1', 'tag-done',
    );
    expect(dbMocks.insertWebinarActionExecutionIgnore).toHaveBeenCalledWith(
      expect.anything(), expect.objectContaining({
        webinarActionId: 'action-1', webinarId: 'w1', friendId: 'friend-1',
        sessionStartAt: SESSION_START, trigger: 'completed', status: 'queued',
      }),
    );
    expect(dbMocks.finishWebinarActionExecution).toHaveBeenCalledWith(
      expect.anything(), expect.stringContaining('w1:action-1:friend-1:'), 'succeeded', null,
    );
  });

  test('CTAクリックでクリックきっかけのタグ外しが実行される', async () => {
    dbMocks.getWebinarActions.mockResolvedValue([{
      id: 'action-2', webinar_id: 'w1', trigger: 'cta_clicked', action_type: 'remove_tag',
      config_json: JSON.stringify({ tagId: 'tag-todo' }), position: 0, version: 1,
      enabled: 1, created_at: 'x', updated_at: 'x',
    }]);
    dbMocks.getWebinarCtas.mockResolvedValue([]);
    const res = await postJson('/api/liff/webinars/test-webinar/cta-click', {
      sessionStartAt: SESSION_START, ctaId: '',
    });
    expect(res.status).toBe(200);
    await flushBackground();
    expect(tagMock.detachTagAndFireSideEffects).toHaveBeenCalledWith(
      expect.anything(), 'friend-1', 'tag-todo',
    );
    expect(dbMocks.finishWebinarActionExecution).toHaveBeenCalledWith(
      expect.anything(), expect.stringContaining(':cta_clicked'), 'succeeded', null,
    );
  });

  test('実行口のない種類は実行せず見送りとして記録する', async () => {
    dbMocks.getWebinarWatchedSeconds.mockResolvedValueOnce(7200);
    dbMocks.getWebinarActions.mockResolvedValue([{
      id: 'action-9', webinar_id: 'w1', trigger: 'completed', action_type: 'unsupported_future_action',
      config_json: JSON.stringify({ templateId: 'tmpl-1' }), position: 0, version: 1,
      enabled: 1, created_at: 'x', updated_at: 'x',
    }]);
    const res = await postJson('/api/liff/webinars/test-webinar/heartbeat', {
      sessionStartAt: SESSION_START,
      positionSeconds: 6480,
    });
    expect(res.status).toBe(200);
    await flushBackground();
    expect(tagMock.attachTagAndFireSideEffects).not.toHaveBeenCalled();
    expect(dbMocks.insertWebinarActionExecutionIgnore).toHaveBeenCalledWith(
      expect.anything(), expect.objectContaining({
        webinarActionId: 'action-9', status: 'skipped', lastError: 'unsupported_action_type',
      }),
    );
    expect(dbMocks.finishWebinarActionExecution).not.toHaveBeenCalled();
  });

  test('同じ視聴の再送は実行記録の重複で二重実行しない', async () => {
    dbMocks.getWebinarActions.mockResolvedValue([{
      id: 'action-1', webinar_id: 'w1', trigger: 'completed', action_type: 'add_tag',
      config_json: JSON.stringify({ tagId: 'tag-done' }), position: 0, version: 1,
      enabled: 1, created_at: 'x', updated_at: 'x',
    }]);
    dbMocks.insertWebinarActionExecutionIgnore.mockResolvedValue(false);
    const res = await postJson('/api/liff/webinars/test-webinar/heartbeat', {
      sessionStartAt: SESSION_START,
      positionSeconds: 6480,
    });
    expect(res.status).toBe(200);
    await flushBackground();
    expect(tagMock.attachTagAndFireSideEffects).not.toHaveBeenCalled();
    expect(dbMocks.finishWebinarActionExecution).not.toHaveBeenCalled();
  });
});

/*
 * D001: 公開完了画面の変更系の口（一時停止・通知テスト・複製）と作成は
 * owner/admin のみ。画面側で staff へ出さなくなっても、口側の門は残す。
 * staff が直接叩いても 403 で、何も書き換えない。
 */
describe('webinar published mutations role guard (D001)', () => {
  test.each([
    ['POST', '/api/webinars', {}],
    ['POST', '/api/webinars/w1/pause', { expectedVersion: 3 }],
    ['POST', '/api/webinars/w1/duplicate', { expectedVersion: 3 }],
    ['POST', '/api/webinars/w1/public-page/test', {}],
  ])('staff の %s %s は 403', async (method, path, body) => {
    dbMocks.getWebinarById.mockResolvedValue(makeWebinar({ account_id: 'account-a' }));
    const staffApp = new Hono<Env>();
    staffApp.use('*', async (c, next) => {
      c.set('staff', { id: 'staff-1', name: 'Staff', role: 'staff', readOnly: false });
      return next();
    });
    staffApp.route('/', webinarRoutes);

    const res = await staffApp.request(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, env, execCtx);

    expect(res.status).toBe(403);
  });
});

describe('GET /api/liff/webinars/:slug/audience', () => {
  test('現在回を予約した本人に視聴人数と未設定の講師名を返す', async () => {
    audienceMock.countRecentWebinarViewers.mockResolvedValue(2);
    const res = await req('/api/liff/webinars/test-webinar/audience', { headers: { Authorization: 'Bearer t' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      live: true, sessionStartAt: SESSION_START, viewerCount: 2, activeWindowSeconds: 60, lecturerName: null,
    });
    expect(audienceMock.countRecentWebinarViewers).toHaveBeenCalledWith(env.DB, 'w1', SESSION_START, SESSION_START + 180);
  });
  test('開始前と終了後は未取得のnullを返す', async () => {
    for (const offset of [-1, 7200]) {
      vi.setSystemTime((SESSION_START + offset) * 1000);
      const res = await req('/api/liff/webinars/test-webinar/audience', { headers: { Authorization: 'Bearer t' } });
      expect(await res.json()).toMatchObject({ live: false, sessionStartAt: null, viewerCount: null });
    }
    expect(audienceMock.countRecentWebinarViewers).not.toHaveBeenCalled();
  });
  test('未予約者には配信中でも人数を返さない', async () => {
    dbMocks.getWebinarRegistration.mockResolvedValue(null);
    const res = await req('/api/liff/webinars/test-webinar/audience', { headers: { Authorization: 'Bearer t' } });
    expect(await res.json()).toMatchObject({ live: false, viewerCount: null });
    expect(audienceMock.countRecentWebinarViewers).not.toHaveBeenCalled();
  });
  test('オンデマンドは共通の回を数え、外部配信は未取得', async () => {
    dbMocks.getWebinarBySlug.mockResolvedValue(makeWebinar({ created_at: new Date(SESSION_START * 1000).toISOString() }));
    dbMocks.getWebinarEditorSettings.mockResolvedValue({ delivery_kind: 'on_demand' });
    expect(await (await req('/api/liff/webinars/test-webinar/audience', { headers: { Authorization: 'Bearer t' } })).json())
      .toMatchObject({ live: true, sessionStartAt: SESSION_START, viewerCount: 0 });
    dbMocks.getWebinarEditorSettings.mockResolvedValue({ delivery_kind: 'external' });
    expect(await (await req('/api/liff/webinars/test-webinar/audience', { headers: { Authorization: 'Bearer t' } })).json())
      .toMatchObject({ live: false, viewerCount: null });
  });
  test('未認証・所属外・非公開のウェビナーを拒否する', async () => {
    authMock.verifyCallerLineUserId.mockResolvedValue(null);
    expect((await req('/api/liff/webinars/test-webinar/audience')).status).toBe(401);
    authMock.verifyCallerLineUserId.mockResolvedValue('U123');
    dbMocks.getFriendByLineUserIdForAccount.mockResolvedValue(null);
    expect((await req('/api/liff/webinars/test-webinar/audience')).status).toBe(403);
    dbMocks.getFriendByLineUserIdForAccount.mockResolvedValue({ id: 'friend-1' });
    dbMocks.getWebinarBySlug.mockResolvedValue(makeWebinar({ status: 'draft' }));
    expect((await req('/api/liff/webinars/test-webinar/audience')).status).toBe(404);
  });
  test('公開期間外なら予約者にも人数を返さない', async () => {
    dbMocks.getWebinarBySlug.mockResolvedValue(makeWebinar({ publication_ends_at: new Date(SESSION_START * 1000).toISOString() }));
    expect((await req('/api/liff/webinars/test-webinar/audience', { headers: { Authorization: 'Bearer t' } })).status).toBe(404);
    expect(audienceMock.countRecentWebinarViewers).not.toHaveBeenCalled();
  });
});


describe('ウェビナーの見逃し・完了・保存', () => {
  test('期限の切れた見逃しは専用リンクでも開けない', async () => {
    vi.setSystemTime(new Date((SESSION_START + 9 * 86400) * 1000));
    dbMocks.isWebinarMissedInWindow.mockResolvedValueOnce(false);
    dbMocks.getWebinarBySlug.mockResolvedValue(makeWebinar({ publication_ends_at: '2000-01-01T00:00:00Z' }));
    const response = await req(`/api/liff/webinars/test-webinar?sessionStartAt=${SESSION_START}`, { headers: { Authorization: 'Bearer t' } });
    expect(response.status).toBe(404);
  });
  test('移動中の位置だけでは完了の副作用を実行しない', async () => {
    dbMocks.recordWebinarHeartbeat.mockResolvedValueOnce({ status: 'moved' });
    const response = await postJson('/api/liff/webinars/test-webinar/heartbeat', { sessionStartAt: SESSION_START, positionSeconds: 6480, playerState: 'seeking' });
    expect(response.status).toBe(200);
    expect(webinarNotificationMocks.enqueueWebinarCompletedNotification).not.toHaveBeenCalled();
    expect(dbMocks.recordConversionSourceEvent).not.toHaveBeenCalled();
  });
  test('位置が90%でも実視聴が少なければ完了しない', async () => {
    dbMocks.getWebinarWatchedSeconds.mockResolvedValueOnce(15);
    await postJson('/api/liff/webinars/test-webinar/heartbeat', { sessionStartAt: SESSION_START, positionSeconds: 6480 });
    expect(webinarNotificationMocks.enqueueWebinarCompletedNotification).not.toHaveBeenCalled();
  });
  test('基本設定を版番号なしで保存できない', async () => {
    dbMocks.getWebinarById.mockResolvedValue(makeWebinar());
    const response = await adminApp.request('/api/webinars/w1', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: '上書き' }) }, env, execCtx);
    expect(response.status).toBe(400);
    expect(dbMocks.updateWebinar).not.toHaveBeenCalled();
  });
});
