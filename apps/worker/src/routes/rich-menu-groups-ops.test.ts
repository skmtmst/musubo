import { describe, expect, test, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';

// /・/・/・/ の route 契約試験。
// @line-crm/db はまるごとモックし、LINE API は fetch を止めて外部を切る。
const dbMocks = {
  getRichMenuGroups: vi.fn(),
  getRichMenuGroupById: vi.fn(),
  getRichMenuGroupWithPages: vi.fn(),
  getRichMenuDeleteImpact: vi.fn(),
  getRichMenuAudienceStats: vi.fn(),
  getRichMenuTapStats: vi.fn(),
  recordRichMenuAssignmentsByLineUserIds: vi.fn(),
  clearRichMenuAssignmentsForGroup: vi.fn(),
  jstNow: vi.fn(() => '2026-09-16T00:00:00.000Z'),
  createRichMenuGroup: vi.fn(),
  saveRichMenuGroupDraft: vi.fn(async () => ({ ok: true, version: 2 })),
  deleteRichMenuGroup: vi.fn(),
  setRichMenuPageImage: vi.fn(),
  pageBelongsToGroup: vi.fn(),
  acquirePublishLease: vi.fn(),
  renewPublishLease: vi.fn(),
  releasePublishLease: vi.fn(),
  isPublishLeaseHeld: vi.fn(),
  setPageRichMenuId: vi.fn(),
  markRichMenuGroupPublished: vi.fn(),
  markRichMenuGroupUnpublished: vi.fn(),
  getLineAccountById: vi.fn(),
  getFollowingLineUserIdsByTag: vi.fn(),
  getTrackedLinkById: vi.fn(),
  listRichMenuSchedulesByGroup: vi.fn(),
  cancelRichMenuSchedule: vi.fn(),
  createRichMenuScheduleAtomic: vi.fn(),
  createRichMenuManualPublishRequestAtomic: vi.fn(),
  getRichMenuManualPublishRequest: vi.fn(),
  getRichMenuManualPublishRequestById: vi.fn(),
  listRichMenuManualPublishRequests: vi.fn(),
  getRichMenuManualPublishShells: vi.fn(),
  markRichMenuManualPublishFailed: vi.fn(),
  markRichMenuManualPublishSucceeded: vi.fn(),
  recordRichMenuManualPublishShells: vi.fn(),
  claimRichMenuManualPublishRequest: vi.fn(),
  restartRichMenuManualPublishRequest: vi.fn(),
  normalizeRichMenuSearchText: (value: string) => value.toLowerCase().replace(/[\s　]+/g, ''),
  listRichMenuGroupIdsByAreaLabel: vi.fn(async () => new Set<string>()),
  duplicateRichMenuGroupAtomic: vi.fn(),
  createRichMenuTestApplyAtomic: vi.fn(),
  getActiveRichMenuTestApply: vi.fn(),
  getRichMenuTestApplyById: vi.fn(),
  listRichMenuTestApplies: vi.fn(),
  captureRichMenuTestApplyPrevious: vi.fn(),
  recordRichMenuTestApplyShells: vi.fn(),
  markRichMenuTestApplyApplied: vi.fn(),
  markRichMenuTestApplyFailed: vi.fn(),
  beginRichMenuTestApplyRevert: vi.fn(),
  markRichMenuTestApplyReverted: vi.fn(),
  markRichMenuTestApplyRevertFailed: vi.fn(),
  getStaffById: vi.fn(),
  getMediaById: vi.fn(),
  ensureRichMenuVersion: vi.fn(),
  markRichMenuVersionPublished: vi.fn(),
  getLatestRichMenuVersion: vi.fn(),
  recordRichMenuDeviceConfirmation: vi.fn(),
  findRichMenuDeviceConfirmation: vi.fn(),
  ensureRichMenuPublishRun: vi.fn(),
  markRichMenuPublishRun: vi.fn(),
  listRichMenuPublishRuns: vi.fn(),
  getLatestRichMenuPublishRun: vi.fn(),
  ensureRichMenuPublishRunPages: vi.fn(),
  markRichMenuPublishRunPageStep: vi.fn(),
  listRichMenuPublishRunPages: vi.fn(),
  listAccountReferencedLineRichMenuIds: vi.fn(async () => []),
  recordAuditEvent: vi.fn(async () => undefined),
  maskAuditIp: vi.fn(() => null),
  auditDeviceFamily: vi.fn(() => 'unknown'),
};
vi.mock('@line-crm/db', () => dbMocks);

const accountAccessMocks = {
  canAccessAllLineAccounts: vi.fn(),
};
vi.mock('../services/account-access.js', () => accountAccessMocks);

const { richMenuGroups } = await import('./rich-menu-groups.js');

type Staff = { id: string; role: 'owner' | 'admin' | 'staff' };

const GROUP = {
  id: 'g1', account_id: 'a1', name: 'メイン', chat_bar_text: 'menu', size: 'large',
  default_page_id: 'p1', is_default_for_all: 0, status: 'published',
  publishing_at: null, publishing_owner: null, publishing_generation: null,
  targeting_condition: null, targeting_priority: 0, targeting_enabled: 0,
  folder_id: null, display_order: 0, created_at: '2026-01-01', updated_at: '2026-01-01',
};

const GROUP_WITH_PAGES = {
  ...GROUP,
  pages: [
    {
      id: 'p1', group_id: 'g1', order_index: 0, name: 'トップ',
      alias_id: 'lhx-g1-0', line_richmenu_id: 'richmenu-p1',
      image_r2_key: 'img/p1.png', image_content_type: 'image/png',
      created_at: '2026-01-01', updated_at: '2026-01-01', areas: [],
    },
  ],
};

function makeDbStub(): D1Database {
  const empty = { results: [] };
  return {
    prepare: vi.fn(() => ({
      bind: vi.fn(() => ({
        all: vi.fn(async () => empty),
        first: vi.fn(async () => null),
        run: vi.fn(async () => ({ meta: { changes: 1 } })),
      })),
    })),
    batch: vi.fn(async () => []),
  } as unknown as D1Database;
}

function makeR2Stub(): R2Bucket {
  return { async get() { return null; }, async put() { return {} as never; } } as unknown as R2Bucket;
}

type TestEnv = {
  Variables: { staff: Staff; auditRecorded: boolean };
  Bindings: { DB: D1Database; IMAGES: R2Bucket };
};

function setupApp(opts: { staff?: Staff | null; db?: D1Database } = {}) {
  const app = new Hono<TestEnv>();
  app.use('*', async (c, next) => {
    const staff = opts.staff === undefined ? ({ id: 'staff-1', role: 'owner' } as Staff) : opts.staff;
    if (staff) c.set('staff', staff);
    c.set('auditRecorded', false);
    c.env = { DB: opts.db ?? makeDbStub(), IMAGES: makeR2Stub() };
    await next();
  });
  app.route('/', richMenuGroups);
  return app;
}

const ACCOUNT = { id: 'a1', channel_access_token: 'token', liff_id: null };

beforeEach(() => {
  for (const fn of Object.values(dbMocks)) {
    if (typeof (fn as { mockReset?: unknown }).mockReset === 'function') (fn as ReturnType<typeof vi.fn>).mockReset();
  }
  dbMocks.listRichMenuGroupIdsByAreaLabel.mockImplementation(async () => new Set<string>());
  dbMocks.jstNow.mockImplementation(() => '2026-09-16T00:00:00.000Z');
  dbMocks.listAccountReferencedLineRichMenuIds.mockImplementation(async () => []);
  // 照合の修復は実行台帳へ残す。見るだけのdryRunでは呼ばない。
  dbMocks.ensureRichMenuPublishRun.mockImplementation(
    async (_db: unknown, input: { id: string }) => ({ id: input.id, status: 'running' }),
  );
  dbMocks.recordAuditEvent.mockImplementation(async () => undefined);
  accountAccessMocks.canAccessAllLineAccounts.mockReset();
  accountAccessMocks.canAccessAllLineAccounts.mockImplementation(async (_db, staff) => Boolean(staff));
});

// =============================================================================
//  公開履歴
// =============================================================================
describe('GET /api/rich-menu-groups/:groupId/publish-runs', () => {
  test('版の要約・状態・最終エラー・ページごとのLINE IDを返す', async () => {
    dbMocks.getRichMenuGroupWithPages.mockResolvedValue(GROUP_WITH_PAGES);
    dbMocks.listRichMenuManualPublishRequests.mockResolvedValue([
      {
        id: 'req-1', group_id: 'g1', account_id: 'a1', status: 'failed', version_number: 3,
        idempotency_key: 'k1', last_error_code: 'LINE timeout',
        requested_by_staff_id: 'staff-1',
        definition_snapshot: JSON.stringify({ name: 'メイン', chatBarText: 'menu', pages: [{}, {}] }),
        result_json: null, created_at: 't1', updated_at: 't2',
      },
    ]);
    dbMocks.getRichMenuManualPublishShells.mockResolvedValue([
      { page_id: 'p1', order_index: 0, new_richmenu_id: 'richmenu-new', old_richmenu_id: 'richmenu-old' },
    ]);
    const res = await setupApp().request('/api/rich-menu-groups/g1/publish-runs');
    expect(res.status).toBe(200);
    const body = await res.json() as {
      data: {
        runs: Array<Record<string, unknown>>;
        published: unknown;
        draftDiffersFromPublished: boolean | null;
      };
    };
    expect(body.data.runs[0]).toMatchObject({
      id: 'req-1', versionNumber: 3, status: 'failed', lastErrorCode: 'LINE timeout',
      version: { name: 'メイン', chatBarText: 'menu', pageCount: 2 },
      pages: [{ pageId: 'p1', newRichMenuId: 'richmenu-new', oldRichMenuId: 'richmenu-old' }],
    });
    // 成功したrunが無いので「いま出ている版」は無し、差分も不明（断定しない）
    expect(body.data.published).toBeNull();
    expect(body.data.draftDiffersFromPublished).toBeNull();
  });

  test('最後に成功したrunを「いま出ている版」として返し、下書きとの差分を判定する', async () => {
    dbMocks.getRichMenuGroupWithPages.mockResolvedValue(GROUP_WITH_PAGES);
    // GROUP_WITH_PAGES と同じ内容のスナップショット（serializeGroupWithPages 形）
    const sameSnapshot = JSON.stringify({
      id: 'g1', accountId: 'a1', name: 'メイン', chatBarText: 'menu', size: 'large',
      defaultPageId: 'p1', isDefaultForAll: false,
      targetingCondition: null, targetingPriority: 0, targetingEnabled: false,
      folderId: null, displayOrder: 0,
      pages: [{
        id: 'p1', orderIndex: 0, name: 'トップ', aliasId: 'lhx-g1-0',
        imageR2Key: 'img/p1.png', imageContentType: 'image/png', areas: [],
      }],
    });
    const changedSnapshot = JSON.stringify({ ...JSON.parse(sameSnapshot), name: '別名' });
    dbMocks.listRichMenuManualPublishRequests.mockResolvedValue([
      {
        id: 'req-new-failed', group_id: 'g1', account_id: 'a1', status: 'failed',
        idempotency_key: 'k2', last_error_code: 'LINE timeout',
        requested_by_staff_id: 'staff-1',
        definition_snapshot: changedSnapshot,
        result_json: null, created_at: 't3', updated_at: 't3',
      },
      {
        id: 'req-ok', group_id: 'g1', account_id: 'a1', status: 'succeeded',
        idempotency_key: 'k1', last_error_code: null,
        requested_by_staff_id: 'staff-1',
        definition_snapshot: sameSnapshot,
        result_json: null, created_at: 't1', updated_at: 't2',
      },
    ]);
    dbMocks.getRichMenuManualPublishShells.mockResolvedValue([]);
    const res = await setupApp().request('/api/rich-menu-groups/g1/publish-runs');
    expect(res.status).toBe(200);
    const body = await res.json() as {
      data: {
        runs: Array<{ id: string }>;
        published: { id: string } | null;
        draftDiffersFromPublished: boolean | null;
      };
    };
    // 失敗した新しいrunではなく、最後に成功したrunが「いま出ている版」
    expect(body.data.published?.id).toBe('req-ok');
    // 公開版と同じ内容の下書き → 差分なし
    expect(body.data.draftDiffersFromPublished).toBe(false);
  });

  test('下書きが公開版と違うとき draftDiffersFromPublished=true', async () => {
    dbMocks.getRichMenuGroupWithPages.mockResolvedValue(GROUP_WITH_PAGES);
    dbMocks.listRichMenuManualPublishRequests.mockResolvedValue([
      {
        id: 'req-ok', group_id: 'g1', account_id: 'a1', status: 'succeeded',
        idempotency_key: 'k1', last_error_code: null,
        requested_by_staff_id: 'staff-1',
        // 公開時の名前は「旧名」。今の下書き（メイン）とは違う。
        definition_snapshot: JSON.stringify({
          id: 'g1', accountId: 'a1', name: '旧名', chatBarText: 'menu', size: 'large',
          defaultPageId: 'p1', isDefaultForAll: false,
          targetingCondition: null, targetingPriority: 0, targetingEnabled: false,
          folderId: null, displayOrder: 0,
          pages: [{
            id: 'p1', orderIndex: 0, name: 'トップ', aliasId: 'lhx-g1-0',
            imageR2Key: 'img/p1.png', imageContentType: 'image/png', areas: [],
          }],
        }),
        result_json: null, created_at: 't1', updated_at: 't2',
      },
    ]);
    dbMocks.getRichMenuManualPublishShells.mockResolvedValue([]);
    const res = await setupApp().request('/api/rich-menu-groups/g1/publish-runs');
    const body = await res.json() as { data: { draftDiffersFromPublished: boolean | null } };
    expect(body.data.draftDiffersFromPublished).toBe(true);
  });

  test('staffには出さない（owner/admin限定）', async () => {
    const res = await setupApp({ staff: { id: 'staff-1', role: 'staff' } })
      .request('/api/rich-menu-groups/g1/publish-runs');
    expect(res.status).toBe(403);
  });

  test('見えないアカウントのgroupは404', async () => {
    dbMocks.getRichMenuGroupWithPages.mockResolvedValue(GROUP_WITH_PAGES);
    accountAccessMocks.canAccessAllLineAccounts.mockResolvedValue(false);
    const res = await setupApp().request('/api/rich-menu-groups/g1/publish-runs');
    expect(res.status).toBe(404);
  });
});

// =============================================================================
//  失敗した公開runだけの再試行
// =============================================================================
describe('POST /api/rich-menu-groups/:groupId/publish-runs/:requestId/retry', () => {
  const baseRequest = {
    id: 'req-1', group_id: 'g1', account_id: 'a1',
    idempotency_key: 'k1', definition_snapshot: '{}', result_json: null,
    requested_by_staff_id: 'staff-1', created_at: 't', updated_at: 't',
  };

  test('実行中のrunは409で止める', async () => {
    dbMocks.getRichMenuGroupById.mockResolvedValue(GROUP);
    dbMocks.getRichMenuManualPublishRequestById.mockResolvedValue({ ...baseRequest, status: 'running' });
    const res = await setupApp().request('/api/rich-menu-groups/g1/publish-runs/req-1/retry', { method: 'POST' });
    expect(res.status).toBe(409);
  });

  test('成功済みのrunは結果を再生するだけ。LINEを再実行しない', async () => {
    dbMocks.getRichMenuGroupById.mockResolvedValue(GROUP);
    dbMocks.getRichMenuManualPublishRequestById.mockResolvedValue({
      ...baseRequest, status: 'succeeded', result_json: JSON.stringify({ pages: [] }),
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await setupApp().request('/api/rich-menu-groups/g1/publish-runs/req-1/retry', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(res.headers.get('Idempotency-Replayed')).toBe('true');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  test('別groupのrunは404（中身を跨いで触れない）', async () => {
    dbMocks.getRichMenuGroupById.mockResolvedValue(GROUP);
    dbMocks.getRichMenuManualPublishRequestById.mockResolvedValue({ ...baseRequest, group_id: 'other' });
    const res = await setupApp().request('/api/rich-menu-groups/g1/publish-runs/req-1/retry', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  test('失敗したrunは同じ鍵で再開する。公開lease保持中は409', async () => {
    dbMocks.getRichMenuGroupById.mockResolvedValue(GROUP);
    dbMocks.getRichMenuManualPublishRequestById.mockResolvedValue({ ...baseRequest, status: 'failed' });
    dbMocks.getRichMenuGroupWithPages.mockResolvedValue(GROUP_WITH_PAGES);
    dbMocks.createRichMenuManualPublishRequestAtomic.mockResolvedValue({
      outcome: 'existing',
      request: { ...baseRequest, status: 'failed' },
    });
    dbMocks.isPublishLeaseHeld.mockResolvedValue(true);
    const res = await setupApp().request('/api/rich-menu-groups/g1/publish-runs/req-1/retry', { method: 'POST' });
    expect(res.status).toBe(409);
    // 失敗runの再開として台帳が running へ戻されたこと（LINE操作の前に止まった）
    expect(dbMocks.restartRichMenuManualPublishRequest).toHaveBeenCalledWith(expect.anything(), 'req-1');
    expect(dbMocks.createRichMenuManualPublishRequestAtomic).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ idempotencyKey: 'k1' }),
    );
  });

  test('staffには出さない（owner/admin限定）', async () => {
    const res = await setupApp({ staff: { id: 'staff-1', role: 'staff' } })
      .request('/api/rich-menu-groups/g1/publish-runs/req-1/retry', { method: 'POST' });
    expect(res.status).toBe(403);
  });
});

// =============================================================================
//  DBとLINEの照合
// =============================================================================
describe('POST /api/rich-menu-groups/:groupId/reconcile', () => {
  function lineFetchStub(menus: Array<{ richMenuId: string }>, defaultId: string | null) {
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/richmenu/list')) {
        return new Response(JSON.stringify({ richmenus: menus }), { status: 200 });
      }
      if (url.endsWith('/user/all/richmenu')) {
        return defaultId
          ? new Response(JSON.stringify({ richMenuId: defaultId }), { status: 200 })
          : new Response('not found', { status: 404 });
      }
      return new Response('{}', { status: 200 });
    });
  }

  test('dryRun（既定）はずれを列挙するだけでDBもLINEも触らない', async () => {
    dbMocks.getRichMenuGroupWithPages.mockResolvedValue({
      ...GROUP_WITH_PAGES,
      // LINE上に無いIDを指している（stale）
      pages: [{ ...GROUP_WITH_PAGES.pages[0], line_richmenu_id: 'richmenu-gone' }],
    });
    dbMocks.getLineAccountById.mockResolvedValue(ACCOUNT);
    dbMocks.listRichMenuManualPublishRequests.mockResolvedValue([]);
    const fetchSpy = lineFetchStub([], null);
    const db = makeDbStub();
    const res = await setupApp({ db }).request('/api/rich-menu-groups/g1/reconcile', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dryRun: true }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { dryRun: boolean; diffs: Array<{ kind: string }> } };
    expect(body.data.dryRun).toBe(true);
    expect(body.data.diffs.map((d) => d.kind)).toContain('stale_page_richmenu_id');
    expect(body.data.diffs.map((d) => d.kind)).toContain('status_mismatch');
    // 読み取り（list/default取得）だけで書き込み系のLINE呼び出しは無い
    expect(fetchSpy.mock.calls.every((call) => {
      const init = call[1] as RequestInit | undefined;
      return !init?.method || init.method === 'GET';
    })).toBe(true);
    fetchSpy.mockRestore();
  });

  test('dryRun:false で stale ID を外し孤児メニューをLINEから消す', async () => {
    dbMocks.getRichMenuGroupWithPages.mockResolvedValue({
      ...GROUP_WITH_PAGES, status: 'draft',
      pages: [{ ...GROUP_WITH_PAGES.pages[0], line_richmenu_id: 'richmenu-gone' }],
    });
    dbMocks.getLineAccountById.mockResolvedValue(ACCOUNT);
    dbMocks.listRichMenuManualPublishRequests.mockResolvedValue([
      { id: 'req-old', group_id: 'g1', account_id: 'a1', status: 'failed' },
    ]);
    dbMocks.getRichMenuManualPublishShells.mockResolvedValue([
      { page_id: 'p1', order_index: 0, new_richmenu_id: 'richmenu-orphan', old_richmenu_id: null },
    ]);
    const fetchSpy = lineFetchStub([{ richMenuId: 'richmenu-orphan' }], null);
    const db = makeDbStub();
    const res = await setupApp({ db }).request('/api/rich-menu-groups/g1/reconcile', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dryRun: false }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { dryRun: boolean; applied: number } };
    expect(body.data.dryRun).toBe(false);
    expect(body.data.applied).toBeGreaterThan(0);
    // 孤児メニューの削除がLINEへ出た
    expect(fetchSpy.mock.calls.some((call) =>
      String(call[0]).includes('/richmenu/richmenu-orphan')
      && (call[1] as RequestInit | undefined)?.method === 'DELETE',
    )).toBe(true);
    // 修復が監査へ記録された
    expect(dbMocks.recordAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'rich_menu.reconcile' }),
    );
    fetchSpy.mockRestore();
  });

  test('staffには出さない', async () => {
    const res = await setupApp({ staff: { id: 'staff-1', role: 'staff' } })
      .request('/api/rich-menu-groups/g1/reconcile', { method: 'POST' });
    expect(res.status).toBe(403);
  });
});

// =============================================================================
//  複製
// =============================================================================
describe('POST /api/rich-menu-groups/:groupId/duplicate', () => {
  test('Idempotency-Key 必須', async () => {
    dbMocks.getRichMenuGroupById.mockResolvedValue(GROUP);
    const res = await setupApp().request('/api/rich-menu-groups/g1/duplicate', { method: 'POST' });
    expect(res.status).toBe(400);
  });

  test('作成は201、同じ鍵のやり直しは200+Replayed、鍵違いは409', async () => {
    dbMocks.getRichMenuGroupById.mockResolvedValue(GROUP);
    dbMocks.duplicateRichMenuGroupAtomic
      .mockResolvedValueOnce({ outcome: 'created', groupId: 'g-copy' })
      .mockResolvedValueOnce({ outcome: 'existing', groupId: 'g-copy' })
      .mockResolvedValueOnce({ outcome: 'conflict' });
    dbMocks.getRichMenuGroupWithPages.mockResolvedValue({ ...GROUP_WITH_PAGES, id: 'g-copy', status: 'draft' });
    const app = setupApp();
    const created = await app.request('/api/rich-menu-groups/g1/duplicate', {
      method: 'POST', headers: { 'Idempotency-Key': 'dup-1' },
    });
    expect(created.status).toBe(201);
    const replay = await app.request('/api/rich-menu-groups/g1/duplicate', {
      method: 'POST', headers: { 'Idempotency-Key': 'dup-1' },
    });
    expect(replay.status).toBe(200);
    expect(replay.headers.get('Idempotency-Replayed')).toBe('true');
    const conflict = await app.request('/api/rich-menu-groups/g1/duplicate', {
      method: 'POST', headers: { 'Idempotency-Key': 'dup-1' },
    });
    expect(conflict.status).toBe(409);
    expect(dbMocks.recordAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'rich_menu.duplicate' }),
    );
  });

  test('staffには出さない', async () => {
    const res = await setupApp({ staff: { id: 'staff-1', role: 'staff' } })
      .request('/api/rich-menu-groups/g1/duplicate', { method: 'POST' });
    expect(res.status).toBe(403);
  });
});

// =============================================================================
//  staffへは合計だけ
// =============================================================================
describe('GET /api/rich-menu-groups/:groupId/audience-summary', () => {
  function countingDb(counts: Record<string, number>): D1Database {
    return {
      prepare: vi.fn((query: string) => ({
        bind: vi.fn(() => ({
          all: vi.fn(async () => ({ results: [] })),
          first: vi.fn(async () => {
            if (query.includes('AND (')) return { count: counts.matched ?? 0 };
            return { count: counts.total ?? 0 };
          }),
          run: vi.fn(async () => ({ meta: { changes: 0 } })),
        })),
      })),
      batch: vi.fn(async () => []),
    } as unknown as D1Database;
  }

  test('staffでも読めて、返すのは件数だけ（個人・条件・他メニュー名なし）', async () => {
    dbMocks.getRichMenuGroupById.mockResolvedValue(GROUP);
    const res = await setupApp({ staff: { id: 'staff-2', role: 'staff' }, db: countingDb({ total: 120, matched: 120 }) })
      .request('/api/rich-menu-groups/g1/audience-summary');
    expect(res.status).toBe(200);
    const body = await res.json() as { data: Record<string, { value: number | null; state: string }> };
    expect(Object.keys(body.data).sort()).toEqual(['effective', 'excluded', 'targeted', 'total']);
    expect(body.data.total.value).toBe(120);
    // 個人情報・条件の中身が混ざっていないことを文字列全体で確かめる
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('targeting_condition');
    expect(raw).not.toContain('line_user');
  });

  test('見えないアカウントは404', async () => {
    dbMocks.getRichMenuGroupById.mockResolvedValue(GROUP);
    accountAccessMocks.canAccessAllLineAccounts.mockResolvedValue(false);
    const res = await setupApp({ db: countingDb({}) }).request('/api/rich-menu-groups/g1/audience-summary');
    expect(res.status).toBe(404);
  });
});

// =============================================================================
//  本人LINEへのテスト適用
// =============================================================================
describe('test-apply', () => {
  const APPLY = {
    id: 'ta-1', group_id: 'g1', account_id: 'a1', staff_id: 'staff-1',
    line_user_id: 'U-self', previous_richmenu_id: 'richmenu-prev', previous_captured: 1,
    applied_richmenu_id: 'richmenu-p1', test_shell_ids: null,
    status: 'applied', last_error_code: null,
    idempotency_key: 'apply-1', revert_idempotency_key: null,
    created_at: 't', updated_at: 't',
  };

  test('古いメニューの確認は本人への操作を始めず409にする', async () => {
    dbMocks.getRichMenuGroupWithPages.mockResolvedValue({ ...GROUP_WITH_PAGES, confirmation_revision: 2 });
    dbMocks.getStaffById.mockResolvedValue({ id: 'staff-1', line_user_id: 'U-self' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await setupApp().request('/api/rich-menu-groups/g1/test-apply', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'stale' },
      body: JSON.stringify({ confirm: true, expectedConfirmationRevision: 1 }),
    });
    expect(res.status).toBe(409);
    expect(dbMocks.createRichMenuTestApplyAtomic).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  test('宛先が送信直前に変わったら本人へのリンクを送らない', async () => {
    const group = { ...GROUP_WITH_PAGES, confirmation_revision: 1 };
    dbMocks.getRichMenuGroupWithPages.mockResolvedValue(group);
    dbMocks.getRichMenuGroupById.mockResolvedValue(group);
    dbMocks.getStaffById.mockResolvedValueOnce({ id: 'staff-1', line_user_id: 'U-self' })
      .mockResolvedValueOnce({ id: 'staff-1', line_user_id: 'U-self' })
      .mockResolvedValue({ id: 'staff-1', line_user_id: 'U-changed' });
    dbMocks.createRichMenuTestApplyAtomic.mockResolvedValue({ outcome: 'created', apply: { ...APPLY, status: 'running', previous_captured: 1 } });
    dbMocks.getActiveRichMenuTestApply.mockResolvedValue(null);
    dbMocks.getLineAccountById.mockResolvedValue(ACCOUNT);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('U-self'));
    const token = Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    const res = await setupApp().request('/api/rich-menu-groups/g1/test-apply', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'destination-change' },
      body: JSON.stringify({ confirm: true, expectedConfirmationRevision: 1, expectedDestinationToken: token }),
    });
    expect(res.status).toBe(409);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(dbMocks.markRichMenuTestApplyFailed).toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  test('確認したメニューと宛先が一致すれば本人へ適用する', async () => {
    const group = { ...GROUP_WITH_PAGES, confirmation_revision: 1 };
    dbMocks.getRichMenuGroupWithPages.mockResolvedValue(group);
    dbMocks.getRichMenuGroupById.mockResolvedValue(group);
    dbMocks.getStaffById.mockResolvedValue({ id: 'staff-1', line_user_id: 'U-self' });
    dbMocks.createRichMenuTestApplyAtomic.mockResolvedValue({ outcome: 'created', apply: { ...APPLY, status: 'running', previous_captured: 1 } });
    dbMocks.getActiveRichMenuTestApply.mockResolvedValue(null);
    dbMocks.getLineAccountById.mockResolvedValue(ACCOUNT);
    dbMocks.getRichMenuTestApplyById.mockResolvedValue(APPLY);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('U-self'));
    const token = Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    const res = await setupApp().request('/api/rich-menu-groups/g1/test-apply', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'matching' },
      body: JSON.stringify({ confirm: true, expectedConfirmationRevision: 1, expectedDestinationToken: token }),
    });
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledOnce();
    fetchSpy.mockRestore();
  });

  test('GET: 未連携の担当者には案内を返し適用を始めさせない', async () => {
    dbMocks.getRichMenuGroupById.mockResolvedValue(GROUP);
    dbMocks.getStaffById.mockResolvedValue({ id: 'staff-1', line_user_id: null });
    dbMocks.listRichMenuTestApplies.mockResolvedValue([]);
    const res = await setupApp().request('/api/rich-menu-groups/g1/test-apply');
    expect(res.status).toBe(200);
    const body = await res.json() as {
      data: { linked: boolean; linkGuidance: string | null; destination: unknown };
    };
    expect(body.data.linked).toBe(false);
    expect(body.data.linkGuidance).toContain('LINE連携');
    // 未連携では宛先を出さない
    expect(body.data.destination).toBeNull();
  });

  test('GET: 連携済みなら宛先（担当者名とマスク済みLINE ID）を返す', async () => {
    dbMocks.getRichMenuGroupById.mockResolvedValue(GROUP);
    dbMocks.getStaffById.mockResolvedValue({
      id: 'staff-1', name: '田中', line_user_id: 'U0123456789abcdef0123456789abcdef',
    });
    dbMocks.getActiveRichMenuTestApply.mockResolvedValue(null);
    dbMocks.listRichMenuTestApplies.mockResolvedValue([]);
    const res = await setupApp().request('/api/rich-menu-groups/g1/test-apply');
    expect(res.status).toBe(200);
    const body = await res.json() as {
      data: { destination: { staffName: string | null; lineUserIdMasked: string } | null };
    };
    expect(body.data.destination?.staffName).toBe('田中');
    // 宛先確認には十分だが全桁は出さない
    expect(body.data.destination?.lineUserIdMasked).toBe('U0123…cdef');
    expect(JSON.stringify(body)).not.toContain('U0123456789abcdef0123456789abcdef');
  });

  test('POST: 確認なし・鍵なし・未連携は400。任意の友だちIDを指定する口は無い', async () => {
    dbMocks.getRichMenuGroupWithPages.mockResolvedValue(GROUP_WITH_PAGES);
    const app = setupApp();
    // 鍵なし
    expect((await app.request('/api/rich-menu-groups/g1/test-apply', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true }),
    })).status).toBe(400);
    // 確認なし
    expect((await app.request('/api/rich-menu-groups/g1/test-apply', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'k' },
      body: JSON.stringify({}),
    })).status).toBe(400);
    // 連携していない
    dbMocks.getStaffById.mockResolvedValue({ id: 'staff-1', line_user_id: null });
    const unlinked = await app.request('/api/rich-menu-groups/g1/test-apply', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'k' },
      body: JSON.stringify({ confirm: true, lineUserId: 'U-someone-else' }),
    });
    expect(unlinked.status).toBe(400);
    expect((await unlinked.json() as { code: string }).code).toBe('line_not_linked');
  });

  test('POST: staffには出さない', async () => {
    const res = await setupApp({ staff: { id: 'staff-1', role: 'staff' } })
      .request('/api/rich-menu-groups/g1/test-apply', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'k' },
        body: JSON.stringify({ confirm: true }),
      });
    expect(res.status).toBe(403);
  });

  test('POST: 公開済みメニューは本人へ直リンク。適用前の表示を記録する', async () => {
    dbMocks.getRichMenuGroupWithPages.mockResolvedValue(GROUP_WITH_PAGES);
    dbMocks.getStaffById.mockResolvedValue({ id: 'staff-1', line_user_id: 'U-self' });
    dbMocks.createRichMenuTestApplyAtomic.mockResolvedValue({
      outcome: 'created',
      apply: { ...APPLY, status: 'running', previous_captured: 0, previous_richmenu_id: null, applied_richmenu_id: null },
    });
    dbMocks.getActiveRichMenuTestApply.mockResolvedValue(null);
    dbMocks.getLineAccountById.mockResolvedValue(ACCOUNT);
    dbMocks.getRichMenuTestApplyById.mockResolvedValue(APPLY);
    const calls: string[] = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      calls.push(String(input));
      if (String(input).endsWith('/user/U-self/richmenu') && !(calls.at(-1)?.includes('richmenu/'))) {
        return new Response(JSON.stringify({ richMenuId: 'richmenu-prev' }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });
    const res = await setupApp().request('/api/rich-menu-groups/g1/test-apply', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'apply-1' },
      body: JSON.stringify({ confirm: true }),
    });
    expect(res.status).toBe(200);
    // 適用前メニューの読み取りと本人へのリンクが出ている
    expect(calls.some((url) => url.endsWith('/user/U-self/richmenu'))).toBe(true);
    expect(calls.some((url) => url.endsWith('/user/U-self/richmenu/richmenu-p1'))).toBe(true);
    expect(dbMocks.captureRichMenuTestApplyPrevious).toHaveBeenCalledWith(expect.anything(), 'ta-1', 'richmenu-prev');
    expect(dbMocks.markRichMenuTestApplyApplied).toHaveBeenCalledWith(expect.anything(), 'ta-1', 'richmenu-p1');
    fetchSpy.mockRestore();
  });

  test('revert: 適用前のメニューへ戻し、戻し済みは冪等に成功', async () => {
    dbMocks.getRichMenuGroupWithPages.mockResolvedValue(GROUP_WITH_PAGES);
    dbMocks.getRichMenuTestApplyById.mockResolvedValue(APPLY);
    dbMocks.beginRichMenuTestApplyRevert.mockResolvedValue('claimed');
    dbMocks.getLineAccountById.mockResolvedValue(ACCOUNT);
    const calls: Array<{ url: string; method: string }> = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const method = (init as RequestInit | undefined)?.method ?? 'GET';
      calls.push({ url: String(input), method });
      // 本人の現在表示はテストで出したメニューのまま → 適用前へ戻す対象
      if (method === 'GET' && String(input).endsWith('/user/U-self/richmenu')) {
        return new Response(JSON.stringify({ richMenuId: 'richmenu-p1' }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });
    const res = await setupApp().request('/api/rich-menu-groups/g1/test-apply/revert', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'revert-1' },
      body: JSON.stringify({ confirm: true, applyId: 'ta-1' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { userMenuAction?: string } };
    expect(body.data.userMenuAction).toBe('restored');
    // 適用前のメニューへ張り直した
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/user/U-self/richmenu/richmenu-prev'))).toBe(true);
    expect(dbMocks.markRichMenuTestApplyReverted).toHaveBeenCalledWith(expect.anything(), 'ta-1');
    fetchSpy.mockRestore();

    // 戻し済みの再送は LINE を触らず成功
    dbMocks.beginRichMenuTestApplyRevert.mockResolvedValue('already');
    const second = await setupApp().request('/api/rich-menu-groups/g1/test-apply/revert', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'revert-1' },
      body: JSON.stringify({ confirm: true, applyId: 'ta-1' }),
    });
    expect(second.status).toBe(200);
    expect(second.headers.get('Idempotency-Replayed')).toBe('true');
  });

  test('revert: 適用後に本人の表示が変わっていたら無言で上書きしない', async () => {
    dbMocks.getRichMenuGroupWithPages.mockResolvedValue(GROUP_WITH_PAGES);
    dbMocks.getRichMenuTestApplyById.mockResolvedValue(APPLY);
    dbMocks.beginRichMenuTestApplyRevert.mockResolvedValue('claimed');
    dbMocks.getLineAccountById.mockResolvedValue(ACCOUNT);
    const calls: Array<{ url: string; method: string }> = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const method = (init as RequestInit | undefined)?.method ?? 'GET';
      calls.push({ url: String(input), method });
      // 本人の表示はテスト適用後に別メニューへ変わっている
      if (method === 'GET' && String(input).endsWith('/user/U-self/richmenu')) {
        return new Response(JSON.stringify({ richMenuId: 'richmenu-other' }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });
    const res = await setupApp().request('/api/rich-menu-groups/g1/test-apply/revert', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'revert-1' },
      body: JSON.stringify({ confirm: true, applyId: 'ta-1' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { userMenuAction?: string } };
    expect(body.data.userMenuAction).toBe('left_as_is');
    // 本人のメニューへの張り直し・解除は出していない
    expect(calls.some((c) => c.url.includes('/user/U-self/richmenu') && c.method !== 'GET')).toBe(false);
    expect(dbMocks.markRichMenuTestApplyReverted).toHaveBeenCalledWith(expect.anything(), 'ta-1');
    fetchSpy.mockRestore();
  });

  test('revert: 適用前の記録が無い失敗は本人の表示に一切触らない', async () => {
    dbMocks.getRichMenuGroupWithPages.mockResolvedValue(GROUP_WITH_PAGES);
    // previous_captured=0: 適用前の表示を記録する前に止まった apply
    dbMocks.getRichMenuTestApplyById.mockResolvedValue({
      ...APPLY, status: 'failed', previous_captured: 0,
      previous_richmenu_id: null, applied_richmenu_id: null,
    });
    dbMocks.beginRichMenuTestApplyRevert.mockResolvedValue('claimed');
    dbMocks.getLineAccountById.mockResolvedValue(ACCOUNT);
    const calls: Array<{ url: string; method: string }> = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      calls.push({ url: String(input), method: (init as RequestInit | undefined)?.method ?? 'GET' });
      return new Response('{}', { status: 200 });
    });
    const res = await setupApp().request('/api/rich-menu-groups/g1/test-apply/revert', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'revert-1' },
      body: JSON.stringify({ confirm: true, applyId: 'ta-1' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { userMenuAction?: string } };
    expect(body.data.userMenuAction).toBe('untouched');
    // 本人のメニューは一度も変えていないので読み取りも含めて触らない
    expect(calls.some((c) => c.url.includes('/user/U-self/richmenu'))).toBe(false);
    expect(dbMocks.markRichMenuTestApplyReverted).toHaveBeenCalledWith(expect.anything(), 'ta-1');
    fetchSpy.mockRestore();
  });

  test('revert: 他人の適用・確認なしは拒否', async () => {
    dbMocks.getRichMenuGroupWithPages.mockResolvedValue(GROUP_WITH_PAGES);
    const app = setupApp();
    // 確認なし
    expect((await app.request('/api/rich-menu-groups/g1/test-apply/revert', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'r' },
      body: JSON.stringify({}),
    })).status).toBe(400);
    // 他人の適用は404
    dbMocks.getRichMenuTestApplyById.mockResolvedValue({ ...APPLY, staff_id: 'staff-other' });
    expect((await app.request('/api/rich-menu-groups/g1/test-apply/revert', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'r' },
      body: JSON.stringify({ confirm: true, applyId: 'ta-1' }),
    })).status).toBe(404);
  });
});
