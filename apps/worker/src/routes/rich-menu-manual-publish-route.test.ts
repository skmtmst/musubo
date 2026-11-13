import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  getRichMenuGroups: vi.fn(), getRichMenuGroupById: vi.fn(), getRichMenuGroupWithPages: vi.fn(), getRichMenuDeleteImpact: vi.fn(),
  createRichMenuGroup: vi.fn(), updateRichMenuGroupMeta: vi.fn(), replaceRichMenuPages: vi.fn(), deleteRichMenuGroup: vi.fn(), setRichMenuPageImage: vi.fn(), pageBelongsToGroup: vi.fn(),
  acquirePublishLease: vi.fn(), releasePublishLease: vi.fn(), renewPublishLease: vi.fn(), isPublishLeaseHeld: vi.fn(), setPageRichMenuId: vi.fn(), markRichMenuGroupPublished: vi.fn(), markRichMenuGroupUnpublished: vi.fn(),
  getLineAccountById: vi.fn(), getFollowingLineUserIdsByTag: vi.fn(), getTrackedLinkById: vi.fn(), getRichMenuTapStats: vi.fn(), getRichMenuAudienceStats: vi.fn(), recordRichMenuAssignmentsByLineUserIds: vi.fn(), clearRichMenuAssignmentsForGroup: vi.fn(), listRichMenuSchedulesByGroup: vi.fn(), cancelRichMenuSchedule: vi.fn(),
  createRichMenuScheduleAtomic: vi.fn(), createRichMenuManualPublishRequestAtomic: vi.fn(), getRichMenuManualPublishRequest: vi.fn(), getRichMenuManualPublishShells: vi.fn(), recordRichMenuManualPublishShells: vi.fn(), claimRichMenuManualPublishRequest: vi.fn(), markRichMenuManualPublishSucceeded: vi.fn(), markRichMenuManualPublishFailed: vi.fn(), restartRichMenuManualPublishRequest: vi.fn(), jstNow: vi.fn(() => '2026-09-16T00:00:00.000Z'),
  ensureRichMenuVersion: vi.fn(async (_db: unknown, input: { id: string }) => ({ id: input.id, version_number: 1, definition_fingerprint: 'fp', status: 'draft' })),
  markRichMenuVersionPublished: vi.fn(), recordRichMenuDeviceConfirmation: vi.fn(),
  findRichMenuDeviceConfirmation: vi.fn(async () => ({ id: 'dc1', confirmed_at: '2026-09-16T00:00:00.000Z' })),
  ensureRichMenuPublishRun: vi.fn(async (_db: unknown, input: { id: string }) => ({ id: input.id, status: 'running', last_error_code: null })),
  markRichMenuPublishRun: vi.fn(), ensureRichMenuPublishRunPages: vi.fn(), markRichMenuPublishRunPageStep: vi.fn(),
  listRichMenuPublishRunPages: vi.fn(async () => []),
}));
vi.mock('@line-crm/db', () => db);
const access = vi.hoisted(() => ({ canAccessAllLineAccounts: vi.fn(async () => true) }));
vi.mock('../services/account-access.js', () => access);
const publisher = vi.hoisted(() => ({
  createRichMenuShells: vi.fn(), switchRichMenuLive: vi.fn(), deleteRichMenuShells: vi.fn(),
  resolveSwitcherActions: vi.fn((pages: unknown[]) => pages), validateRichMenuGroupForPublish: vi.fn(),
  validateRichMenuPagesWithLine: vi.fn(),
  buildAliasId: vi.fn((groupId: string, orderIndex: number) => `lhx-${groupId.slice(0, 8)}-${orderIndex}`),
  unpublishRichMenuGroup: vi.fn(), linkRichMenuBulkChunked: vi.fn(),
  PublishLeaseLostError: class PublishLeaseLostError extends Error {},
  RichMenuValidationError: class RichMenuValidationError extends Error {},
}));
vi.mock('../lib/rich-menu-publisher.js', () => publisher);

const { richMenuGroups } = await import('./rich-menu-groups.js');

const group = {
  id: 'g1', account_id: 'a1', name: 'menu', chat_bar_text: 'menu', size: 'large', default_page_id: null,
  is_default_for_all: 0, status: 'draft', targeting_condition: null, targeting_priority: 0, targeting_enabled: 0,
  folder_id: null, display_order: 0, version:2, created_at: '', updated_at: '', pages: [{
    id: 'p1', order_index: 0, name: 'page', alias_id: 'alias', line_richmenu_id: 'old', image_r2_key: 'image', image_content_type: 'image/png', areas: [{
      id: 'area-1', bounds_x: 0, bounds_y: 0, bounds_width: 2500, bounds_height: 1686,
      action_type: 'uri', actionData: { uri: 'https://example.com' }, intent: 'url', label: 'サイトを開く',
      tag_ids: null, score_change: null, template_id: null, form_id: null, tracked_link_id: null,
    }],
  }],
};

function app() {
  const instance = new Hono<any>();
  instance.use('*', async (c, next) => { c.set('staff', { id: 's1', role: 'owner' }); c.env = { DB: {}, IMAGES: { get: vi.fn() } }; await next(); });
  instance.route('/', richMenuGroups);
  return instance;
}
function post() { return app().request('/api/rich-menu-groups/g1/publish', { method: 'POST', headers: { 'Idempotency-Key': 'key-1' } }); }

describe('手動公開のroute冪等性', () => {
  let request: { id: string; status: 'running' | 'failed' | 'succeeded'; result_json?: string };
  let shells: Array<{ request_id: string; page_id: string; order_index: number; new_richmenu_id: string; old_richmenu_id: string | null }>;
  beforeEach(() => {
    vi.clearAllMocks(); request = { id: 'r1', status: 'running' }; shells = [];
    db.getRichMenuGroupWithPages.mockResolvedValue(group); db.getLineAccountById.mockResolvedValue({ channel_access_token: 'token' });
    db.createRichMenuManualPublishRequestAtomic.mockImplementation(async () => ({ outcome: request.status === 'running' && !request.result_json ? 'created' : 'existing', request }));
    db.getRichMenuManualPublishRequest.mockImplementation(async () => request);
    db.getRichMenuManualPublishShells.mockImplementation(async () => shells);
    db.recordRichMenuManualPublishShells.mockImplementation(async (_db: unknown, requestId: string, rows: any[]) => { shells = rows.map((row) => ({ request_id: requestId, page_id: row.pageId, order_index: row.orderIndex, new_richmenu_id: row.newRichMenuId, old_richmenu_id: row.oldRichMenuId })); });
    db.claimRichMenuManualPublishRequest.mockResolvedValue(true);
    db.markRichMenuManualPublishSucceeded.mockImplementation(async (_db: unknown, _id: string, _token: string, result: string) => { request.status = 'succeeded'; request.result_json = result; return true; });
    db.markRichMenuManualPublishFailed.mockImplementation(async () => { request.status = 'failed'; return true; });
    db.restartRichMenuManualPublishRequest.mockImplementation(async () => { request.status = 'running'; return true; });
    db.isPublishLeaseHeld.mockResolvedValue(false); db.acquirePublishLease.mockResolvedValue(1); db.renewPublishLease.mockResolvedValue(true); db.releasePublishLease.mockResolvedValue(true); db.setPageRichMenuId.mockResolvedValue(true); db.markRichMenuGroupPublished.mockResolvedValue(true);
    publisher.createRichMenuShells.mockImplementation(async (_group: unknown, _line: unknown, _r2: unknown, _heartbeat: unknown, options: { onShellCreated?: (shell: { pageId: string; orderIndex: number; newRichMenuId: string }) => Promise<void>; existingShells?: Array<{ pageId: string; orderIndex: number; newRichMenuId: string }> }) => {
      if (options.existingShells?.length) return { shells: options.existingShells };
      const created = { pageId: 'p1', orderIndex: 0, newRichMenuId: 'new-1' };
      await options?.onShellCreated?.(created);
      return { shells: [created] };
    });
    publisher.switchRichMenuLive.mockResolvedValue(undefined); publisher.deleteRichMenuShells.mockResolvedValue(undefined);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === 'https://api.line.me/v2/bot/richmenu/list') return new Response(JSON.stringify({ richmenus: [] }), { status: 200 });
      throw new Error(`unexpected fetch ${url}`);
    }));
    access.canAccessAllLineAccounts.mockResolvedValue(true);
  });

  it('公開前に保存版が変わっていればLINEへ進まず409を返す',async()=>{
    const response=await app().request('/api/rich-menu-groups/g1/publish',{method:'POST',headers:{'Idempotency-Key':'key-stale','content-type':'application/json'},body:JSON.stringify({expectedVersion:1,expectedPublishGeneration:0,expectedImages:[{orderIndex:0,imageR2Key:'image',imageContentType:'image/png'}]})});
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({data:{version:2}});
    expect(db.createRichMenuManualPublishRequestAtomic).not.toHaveBeenCalled();
    expect(publisher.createRichMenuShells).not.toHaveBeenCalled();expect(publisher.switchRichMenuLive).not.toHaveBeenCalled();
  });
  it('版が同じでも確認後に画像が変われば公開しない',async()=>{
    const response=await app().request('/api/rich-menu-groups/g1/publish',{method:'POST',headers:{'Idempotency-Key':'key-stale-image','content-type':'application/json'},body:JSON.stringify({expectedVersion:2,expectedPublishGeneration:0,expectedImages:[{orderIndex:0,imageR2Key:'other-image',imageContentType:'image/png'}]})});
    expect(response.status).toBe(409);expect(publisher.createRichMenuShells).not.toHaveBeenCalled();expect(publisher.switchRichMenuLive).not.toHaveBeenCalled();
  });
  it('公開処理の途中で版が変わったら次のLINE操作をしない',async()=>{
    db.acquirePublishLease.mockImplementationOnce(async()=>{db.getRichMenuGroupWithPages.mockResolvedValue({...group,publishing_generation:1});return 1});
    publisher.validateRichMenuPagesWithLine.mockImplementationOnce(async()=>{db.getRichMenuGroupWithPages.mockResolvedValue({...group,version:3,publishing_generation:1})});
    publisher.createRichMenuShells.mockImplementationOnce(async (_group:unknown,_line:unknown,_r2:unknown,heartbeat:()=>Promise<void>)=>{await heartbeat();return {shells:[]}});
    const response=await app().request('/api/rich-menu-groups/g1/publish',{method:'POST',headers:{'Idempotency-Key':'key-mid-change','content-type':'application/json'},body:JSON.stringify({expectedVersion:2,expectedPublishGeneration:0,expectedImages:[{orderIndex:0,imageR2Key:'image',imageContentType:'image/png'}]})});
    expect(response.status).toBe(409);expect(publisher.switchRichMenuLive).not.toHaveBeenCalled();
  });

  it('同key同内容の同時要求は2本目を409にし、完了後の再試行はLINEを再実行せず再生する', async () => {
    db.isPublishLeaseHeld.mockResolvedValueOnce(true);
    await expect(post()).resolves.toHaveProperty('status', 409);
    expect(publisher.createRichMenuShells).not.toHaveBeenCalled();
    db.isPublishLeaseHeld.mockResolvedValue(false);
    await expect(post()).resolves.toHaveProperty('status', 200);
    expect(publisher.createRichMenuShells).toHaveBeenCalledTimes(1);
    const replay = await post();
    expect(replay.status).toBe(200);
    expect(replay.headers.get('Idempotency-Replayed')).toBe('true');
    expect(publisher.createRichMenuShells).toHaveBeenCalledTimes(1);
  });

  it('lease取得直前に先行要求が成功した競合でも、再読してLINEを再実行しない', async () => {
    // 最初のreadは古いrunning、lease取得後のreadだけ先行要求のsucceededを見る。
    db.getRichMenuManualPublishRequest.mockResolvedValue({
      id: 'r1', status: 'succeeded', result_json: JSON.stringify({ pages: [{ pageId: 'p1', newRichMenuId: 'new-1' }] }),
    });
    const response = await post();
    expect(response.status).toBe(200);
    expect(response.headers.get('Idempotency-Replayed')).toBe('true');
    expect(publisher.createRichMenuShells).not.toHaveBeenCalled();
    expect(publisher.switchRichMenuLive).not.toHaveBeenCalled();
  });

  it('shell作成後の切替失敗は同key再試行で作り直さずjournalのshellを使う', async () => {
    publisher.switchRichMenuLive.mockRejectedValueOnce(new Error('LINE unavailable'));
    await expect(post()).resolves.toHaveProperty('status', 500);
    expect(shells).toHaveLength(1);
    await expect(post()).resolves.toHaveProperty('status', 200);
    // 2回目は同じshellへ画像を再uploadする呼出で、new createではない。
    expect(publisher.createRichMenuShells).toHaveBeenCalledTimes(2);
    expect(publisher.createRichMenuShells.mock.calls[1][4].existingShells).toEqual([
      { pageId: 'p1', orderIndex: 0, newRichMenuId: 'new-1' },
    ]);
    expect(publisher.switchRichMenuLive).toHaveBeenCalledTimes(2);
  });

  it.each(['alias failed', 'default failed'])('alias/default切替途中の失敗もjournalから再開する: %s', async (message) => {
    publisher.switchRichMenuLive.mockRejectedValueOnce(new Error(message));
    await expect(post()).resolves.toHaveProperty('status', 500);
    await expect(post()).resolves.toHaveProperty('status', 200);
    expect(publisher.createRichMenuShells).toHaveBeenCalledTimes(2);
    const secondOptions = publisher.createRichMenuShells.mock.calls[1][4];
    expect(secondOptions.existingShells).toEqual([{ pageId: 'p1', orderIndex: 0, newRichMenuId: 'new-1' }]);
  });

  it('D1 journal失敗後も決定名のLINE shellを回収し、新規createを混ぜない', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
      if (url === 'https://api.line.me/v2/bot/richmenu/list') {
        return new Response(JSON.stringify({ richmenus: [
          { richMenuId: 'recovered-1', name: 'lhm:r1:p1' },
          { richMenuId: 'other-request', name: 'lhm:other-request:p1' },
          { richMenuId: 'legacy-name', name: 'g1 - page' },
        ] }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    db.recordRichMenuManualPublishShells.mockRejectedValueOnce(new Error('D1 unavailable'));
    await expect(post()).resolves.toHaveProperty('status', 500);
    expect(publisher.createRichMenuShells).not.toHaveBeenCalled();

    await expect(post()).resolves.toHaveProperty('status', 200);
    expect(publisher.createRichMenuShells).toHaveBeenCalledTimes(1);
    expect(publisher.createRichMenuShells.mock.calls[0][4].existingShells).toEqual([
      { pageId: 'p1', orderIndex: 0, newRichMenuId: 'recovered-1' },
    ]);
  });

  it('同一request/pageの決定名が複数なら別shellを混ぜず停止する', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
      if (url === 'https://api.line.me/v2/bot/richmenu/list') {
        return new Response(JSON.stringify({ richmenus: [
          { richMenuId: 'duplicate-1', name: 'lhm:r1:p1' },
          { richMenuId: 'duplicate-2', name: 'lhm:r1:p1' },
        ] }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    await expect(post()).resolves.toHaveProperty('status', 500);
    expect(publisher.createRichMenuShells).not.toHaveBeenCalled();
  });

  it('別accountの公開要求はLINE処理前に404で隠す', async () => {
    access.canAccessAllLineAccounts.mockResolvedValue(false);
    await expect(post()).resolves.toHaveProperty('status', 404);
    expect(db.createRichMenuManualPublishRequestAtomic).not.toHaveBeenCalled();
    expect(publisher.createRichMenuShells).not.toHaveBeenCalled();
  });

  it('live切替後にleaseを失った古い実行は、request成功を確定せず409で止まる', async () => {
    // group確定までは自分の札、request成功の直前に別keyの新しい実行へleaseが移った形。
    // 古いrequestを成功にすると、古いpagesを成功応答として再生してしまう。
    db.renewPublishLease
      .mockResolvedValueOnce(true) // page IDの確定前
      .mockResolvedValueOnce(true) // group publishedの確定前
      .mockResolvedValueOnce(false); // request成功の確定前

    const response = await post();

    expect(response.status).toBe(409);
    expect(db.markRichMenuManualPublishSucceeded).not.toHaveBeenCalled();
    expect(db.markRichMenuManualPublishFailed).toHaveBeenCalledWith(
      expect.anything(), 'r1', expect.any(String), expect.any(String), expect.objectContaining({ groupId: 'g1' }),
    );
  });
});
