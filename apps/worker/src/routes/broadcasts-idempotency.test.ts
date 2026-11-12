import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../worker-env.js';
import { unhandledWorkerError } from '../lib/unhandled-error.js';
const report = vi.hoisted(() => vi.fn(async () => false));
vi.mock('../services/codex-slack-relay.js', () => ({ reportHarnessErrorToSlack: report }));

const dbMocks = {
  getBroadcasts: vi.fn(),
  getBroadcastById: vi.fn(),
  createBroadcast: vi.fn(),
  updateBroadcast: vi.fn(),
  deleteBroadcast: vi.fn(),
  getLineAccountById: vi.fn(),
};
const d1Prepare = vi.fn();
const accountAccess = {
  canAccessAllLineAccounts: vi.fn(async () => true),
  getVisibleLineAccountScope: vi.fn(async () => ({
    accounts: [],
    ids: ['account-1'],
    allowedAccountIds: ['account-1'],
    canSeeUnassigned: true,
  })),
};
vi.mock('@line-crm/db', async (importOriginal) => {
  // segment-conditions は純粋関数。実体は packages/db にあり、
  // services/segment-query.js から再公開される。ここで潰すと条件の
  // 検証・評価が undefined になるため、5つだけ実物を使う。
  const real = await importOriginal<typeof import('@line-crm/db')>();
  return {
    buildPublicSegmentQuery: real.buildPublicSegmentQuery,
    buildSegmentQuery: real.buildSegmentQuery,
    buildSegmentWhere: real.buildSegmentWhere,
    matchesCondition: real.matchesCondition,
    parseCondition: real.parseCondition,
    ...dbMocks,
  };
});
vi.mock('../services/account-access.js', () => accountAccess);

const { broadcasts } = await import('./broadcasts.js');

const KEY = '11111111-2222-4333-8444-555555555555';
const requestBody = {
  title: '朝のお知らせ',
  messageType: 'text',
  messageContent: '{{name}}さん、おはようございます',
  targetType: 'all',
  scheduledAt: '2099-08-12T09:00:00.000+09:00',
  lineAccountId: 'account-1',
  trackLinks: true,
};

const row = {
  id: KEY,
  title: requestBody.title,
  message_type: requestBody.messageType,
  message_content: requestBody.messageContent,
  target_type: requestBody.targetType,
  target_tag_id: null,
  status: 'scheduled',
  scheduled_at: requestBody.scheduledAt,
  sent_at: null,
  total_count: 0,
  success_count: 0,
  created_at: '2026-08-11T12:00:00.000+09:00',
  account_ids: null,
  dedup_priority: null,
  failed_account_ids: null,
  dedup_progress: null,
  batch_lock_at: null,
  track_links: 1,
  line_account_id: requestBody.lineAccountId,
  alt_text: null,
  lock_version: 3,
};

function setupApp({
  changes = 1,
  role = 'owner',
}: { changes?: number; role?: 'owner' | 'admin' | 'staff' } = {}) {
  d1Prepare.mockImplementation(() => ({
    bind: vi.fn(() => ({ first:vi.fn(async()=>null),run: vi.fn(async () => ({ success: true, meta: { changes } })) })),
  }));
  const app = new Hono<Env>();
  app.use('*', async (c, next) => {
    c.env = {
      DB: {
        prepare: d1Prepare,
      } as unknown as D1Database,
    } as Env['Bindings'];
    // 更新系はオーナー／管理者限定になった。ここで見たいのは本体の挙動なので、
    // 認証は通った状態にしてから渡す。権限の検証は role-guard.test.ts が持つ。
    (c as unknown as { set: (k: string, v: unknown) => void }).set('staff', {
      id: `${role}-1`,
      name: role,
      role,
      readOnly: false,
    });
    await next();
  });
  app.route('/', broadcasts);
  app.onError(unhandledWorkerError);
  return app;
}

beforeEach(() => {
  for (const fn of Object.values(dbMocks)) fn.mockReset();
  d1Prepare.mockReset();
  accountAccess.canAccessAllLineAccounts.mockReset();
  accountAccess.canAccessAllLineAccounts.mockResolvedValue(true);
});
describe('POST /api/broadcasts idempotency', () => {
  test('accepts five validated message bubbles and rejects six before writing', async () => {
    const five = Array.from({ length: 5 }, (_, index) => ({
      id: `bubble-${index + 1}`,
      type: 'text',
      content: { text: `本文${index + 1}` },
    }));
    dbMocks.createBroadcast.mockResolvedValueOnce({
      ...row,
      message_bubbles_json: JSON.stringify(five),
    });
    const accepted = await setupApp().request('/api/broadcasts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...requestBody, messageBubbles: five }),
    });
    expect(accepted.status).toBe(201);
    expect(dbMocks.createBroadcast).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      messageBubblesJson: JSON.stringify(five),
    }));

    dbMocks.createBroadcast.mockClear();
    const rejected = await setupApp().request('/api/broadcasts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...requestBody, messageBubbles: [...five, five[0]] }),
    });
    expect(rejected.status).toBe(400);
    expect(dbMocks.createBroadcast).not.toHaveBeenCalled();
  });

  test('rejects an unsupported bubble instead of storing content that cannot be sent', async () => {
    // coupon は配信用素材として対応済みのため、未対応種別の検証には使わない。
    const response = await setupApp().request('/api/broadcasts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...requestBody,
        messageBubbles: [{ id: 'mystery-1', type: 'mystery', content: {} }],
      }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ success: false, error: expect.stringContaining('Unsupported') });
    expect(dbMocks.createBroadcast).not.toHaveBeenCalled();
  });

  test('creates with the idempotency key as the stable broadcast id', async () => {
    dbMocks.getBroadcastById.mockResolvedValueOnce(null);
    dbMocks.createBroadcast.mockResolvedValueOnce(row);

    const response = await setupApp().request('/api/broadcasts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': KEY },
      body: JSON.stringify(requestBody),
    });

    expect(response.status).toBe(201);
    expect(dbMocks.createBroadcast).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      id: KEY,
      lineAccountId: 'account-1',
      messageContent: requestBody.messageContent,
    }));
  });

  test('returns the original row without creating a duplicate on replay', async () => {
    dbMocks.getBroadcastById.mockResolvedValueOnce(row);

    const response = await setupApp().request('/api/broadcasts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': KEY },
      body: JSON.stringify(requestBody),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Idempotency-Replayed')).toBe('true');
    expect(dbMocks.createBroadcast).not.toHaveBeenCalled();
    expect((await response.json() as { data: { id: string } }).data.id).toBe(KEY);
  });

  test('rejects reuse of the same key for different content', async () => {
    dbMocks.getBroadcastById.mockResolvedValueOnce(row);

    const response = await setupApp().request('/api/broadcasts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': KEY },
      body: JSON.stringify({ ...requestBody, messageContent: '別の内容' }),
    });

    expect(response.status).toBe(409);
    expect(dbMocks.createBroadcast).not.toHaveBeenCalled();
  });

  test('rejects a malformed key before touching the database', async () => {
    const response = await setupApp().request('/api/broadcasts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'not-a-uuid' },
      body: JSON.stringify(requestBody),
    });

    expect(response.status).toBe(400);
    expect(dbMocks.getBroadcastById).not.toHaveBeenCalled();
    expect(dbMocks.createBroadcast).not.toHaveBeenCalled();
  });
});

describe('PUT /api/broadcasts/:id', () => {
  test('updates the same draft with bubbles, segment conditions, and send pacing', async () => {
    const draft = { ...row, status: 'draft', scheduled_at: null };
    dbMocks.getBroadcastById.mockResolvedValueOnce(draft);
    dbMocks.updateBroadcast.mockResolvedValueOnce({
      ...draft,
      lock_version: draft.lock_version + 1,
      message_bubbles_json: '[{"type":"text"}]',
      segment_conditions: '{"operator":"AND","rules":[]}',
      stealth_spread_minutes: 45,
    });

    const response = await setupApp().request(`/api/broadcasts/${KEY}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messageBubbles: [{ id: 'b-1', type: 'text', content: { text: '更新後' } }],
        targetType: 'segment',
        segmentConditions: { operator: 'AND', rules: [{ type: 'tag_exists', value: 'tag-1' }] },
        stealthSpreadMinutes: 45,
        // 版を付けて更新する（版なしは400になる）。
        expectedVersion: 3,
      }),
    });

    expect(response.status).toBe(200);
    expect(dbMocks.updateBroadcast).toHaveBeenCalledWith(
      expect.anything(),
      KEY,
      expect.objectContaining({
        message_bubbles_json: expect.stringContaining('更新後'),
        target_type: 'segment',
        segment_conditions: expect.stringContaining('tag_exists'),
        stealth_spread_minutes: 45,
      }),
      3,
    );
  });

  // 版なしPUTは400で止め、更新関数を呼ばない。
  test('版なしの更新は400で止める', async () => {
    dbMocks.getBroadcastById.mockResolvedValueOnce({ ...row, status: 'draft', scheduled_at: null });
    const response = await setupApp().request(`/api/broadcasts/${KEY}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '版なし更新' }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      success: false, code: 'EXPECTED_VERSION_REQUIRED',
    });
    expect(dbMocks.updateBroadcast).not.toHaveBeenCalled();
  });

  test('does not update a segment draft when its conditions cannot be evaluated', async () => {
    dbMocks.getBroadcastById.mockResolvedValueOnce({ ...row, status: 'draft', scheduled_at: null });
    const response = await setupApp().request(`/api/broadcasts/${KEY}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetType: 'segment',
        segmentConditions: { operator: 'AND', rules: [{ type: 'unknown_rule', value: true }] },
        // 版を付けて絞り込み検証まで進める（版なしだと手前で400になる）。
        expectedVersion: 3,
      }),
    });

    expect(response.status).toBe(400);
    expect(dbMocks.updateBroadcast).not.toHaveBeenCalled();
  });
});

describe('POST /api/broadcasts/:id/cancel', () => {
  test.each([
    ['application/json', '{"expectedVersion":2}'],
    ['application/x-www-form-urlencoded', 'expectedVersion=2'],
    ['text/plain', 'expectedVersion=2'],
    ['text/plain', '{\"expectedVersion\":2}'],
  ])('古い版を本文 %s で送ると無条件に取り消さない', async (contentType, body) => {
    dbMocks.getBroadcastById.mockResolvedValue(row);
    const response = await setupApp().request(`/api/broadcasts/${KEY}/cancel`, {method:'POST',headers:{'Content-Type':contentType},body});
    expect(response.status).toBe(409);
    expect(d1Prepare).not.toHaveBeenCalled();
  });
  test('古い版を multipart で送ると取り消さない',async()=>{
    dbMocks.getBroadcastById.mockResolvedValue(row);const form=new FormData();form.set('expectedVersion','2');
    const response=await setupApp().request(`/api/broadcasts/${KEY}/cancel`,{method:'POST',body:form});
    expect(response.status).toBe(409);expect(d1Prepare).not.toHaveBeenCalled();
  });

  test('確認した版は取消更新の条件にも入れる', async () => {
    dbMocks.getBroadcastById.mockResolvedValue(row);
    const app=setupApp({changes:0});const bind=vi.fn(()=>({run:vi.fn(async()=>({meta:{changes:0}}))}));d1Prepare.mockReturnValueOnce({bind});
    const response=await app.request(`/api/broadcasts/${KEY}/cancel`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({expectedVersion:3})});
    expect(response.status).toBe(409);
    expect(d1Prepare).toHaveBeenCalledWith(expect.stringMatching(/WHERE[\s\S]*COALESCE\(lock_version, 1\)\s*=\s*\?/));
    expect(bind).toHaveBeenCalledWith(KEY,3,3);
  });
  test.each(['json','form','multipart','plain-form','plain-json'])('一致する版を%sで送ると取り消せる',async kind=>{
    dbMocks.getBroadcastById.mockResolvedValueOnce(row).mockResolvedValueOnce({...row,status:'draft',scheduled_at:null});
    const app=setupApp();const form=new FormData();form.set('expectedVersion','3');
    const init:RequestInit=kind==='json'?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({expectedVersion:3})}
      :kind==='form'?{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'expectedVersion=3'}
      :kind==='plain-form'?{method:'POST',headers:{'Content-Type':'text/plain'},body:'expectedVersion=3'}
      :kind==='plain-json'?{method:'POST',headers:{'Content-Type':'text/plain'},body:JSON.stringify({expectedVersion:3})}:{method:'POST',body:form};
    expect((await app.request(`/api/broadcasts/${KEY}/cancel`,init)).status).toBe(200);
    expect(d1Prepare).toHaveBeenCalledWith(expect.stringMatching(/WHERE[\s\S]*COALESCE\(lock_version, 1\)\s*=\s*\?/));
  });
  test.each(['expectedVersion=', 'expectedVersion=3&expectedVersion=3', 'expectedVersion=invalid'])('不正なフォームの版を拒否する: %s',async body=>{
    dbMocks.getBroadcastById.mockResolvedValueOnce(row);
    const response=await setupApp().request(`/api/broadcasts/${KEY}/cancel`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body});
    expect(response.status).toBe(400);expect(d1Prepare).not.toHaveBeenCalled();
  });
  test.each([
    ['application/json', '{"expectedVersion":3'],
    ['application/x-www-form-urlencoded', 'expectedVersion=3&other=%ZZ'],
    ['application/x-www-form-urlencoded', 'expectedVersion%ZZ=3'],
    ['application/x-www-form-urlencoded', 'expected%2556ersion=3'],
    ['text/plain', 'expected%2556ersion=3'],
    ['application/x-www-form-urlencoded', 'expected%56ersion=3&other=%ZZ'],
    ['text/plain', 'expected%56ersion=3&other=%ZZ'],
    ['text/plain', '{"expected\\u0056ersion":3'],
  ])('壊れた %s の本文に版があれば取消を拒否する', async (contentType, body) => {
    dbMocks.getBroadcastById.mockResolvedValue(row);
    const response = await setupApp().request(`/api/broadcasts/${KEY}/cancel`, {method:'POST',headers:{'Content-Type':contentType},body});
    expect(response.status).toBe(400);
    expect(d1Prepare).not.toHaveBeenCalled();
  });
  test('版付きフォームに壊れたUTF-8があれば取り消さない', async () => {
    dbMocks.getBroadcastById.mockResolvedValue(row);
    const bytes = Uint8Array.from([...new TextEncoder().encode('expectedVersion=3&other='), 0xff]);
    const response = await setupApp().request(`/api/broadcasts/${KEY}/cancel`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: bytes.buffer,
    });
    expect(response.status).toBe(400);
    expect(d1Prepare).not.toHaveBeenCalled();
  });
  test.each([
    ['application/json', '{}'],
    ['application/x-www-form-urlencoded', 'other=value'],
  ])('版なしの旧来の %s を受け付ける', async (contentType, body) => {
    dbMocks.getBroadcastById.mockResolvedValueOnce(row).mockResolvedValueOnce({...row,status:'draft',scheduled_at:null});
    const response = await setupApp().request(`/api/broadcasts/${KEY}/cancel`, {method:'POST',headers:{'Content-Type':contentType},body});
    expect(response.status).toBe(200);
  });
  test('他店の古い版より店舗境界を先に確認する', async () => {
    dbMocks.getBroadcastById.mockResolvedValue(row);
    accountAccess.canAccessAllLineAccounts.mockResolvedValueOnce(false);
    const response = await setupApp().request(`/api/broadcasts/${KEY}/cancel`, {method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'expectedVersion=2'});
    expect(response.status).toBe(404);
    expect(d1Prepare).not.toHaveBeenCalled();
  });
  test('版のない旧来のテキスト本文を受け付ける',async()=>{
    dbMocks.getBroadcastById.mockResolvedValueOnce(row).mockResolvedValueOnce({...row,status:'draft',scheduled_at:null});
    expect((await setupApp().request(`/api/broadcasts/${KEY}/cancel`,{method:'POST',headers:{'Content-Type':'text/plain'},body:'cancel'})).status).toBe(200);
  });
  test('予約中の配信だけを削除せず原子的に下書きへ戻す', async () => {
    dbMocks.getBroadcastById
      .mockResolvedValueOnce(row)
      .mockResolvedValueOnce({ ...row, status: 'draft', scheduled_at: null });

    const response = await setupApp().request(`/api/broadcasts/${KEY}/cancel`, {
      method: 'POST',
    });

    expect(response.status).toBe(200);
    expect(accountAccess.canAccessAllLineAccounts).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ role: 'owner' }),
      ['account-1'],
    );
    expect(d1Prepare).toHaveBeenCalledWith(expect.stringContaining(
      "WHERE id = ? AND status = 'scheduled' AND scheduled_at IS NOT NULL",
    ));
    expect(dbMocks.deleteBroadcast).not.toHaveBeenCalled();
    expect((await response.json() as { data: { status: string; scheduledAt: string | null } }).data)
      .toMatchObject({ status: 'draft', scheduledAt: null });
  });

  test('閲覧できないアカウントの予約には存在も更新も見せない', async () => {
    dbMocks.getBroadcastById.mockResolvedValueOnce(row);
    accountAccess.canAccessAllLineAccounts.mockResolvedValueOnce(false);

    const response = await setupApp().request(`/api/broadcasts/${KEY}/cancel`, {
      method: 'POST',
    });

    expect(response.status).toBe(404);
    expect(d1Prepare).not.toHaveBeenCalled();
  });

  test('存在しない配信は404で返し、権限確認や更新へ進まない', async () => {
    dbMocks.getBroadcastById.mockResolvedValueOnce(null);

    const response = await setupApp().request(`/api/broadcasts/${KEY}/cancel`, {
      method: 'POST',
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ success: false, code: 'BROADCAST_NOT_FOUND', error: '配信が見つかりません。一覧から開き直してください。' });
    expect(accountAccess.canAccessAllLineAccounts).not.toHaveBeenCalled();
    expect(d1Prepare).not.toHaveBeenCalled();
  });

  test('スタッフ権限では取消処理へ進まない', async () => {
    const response = await setupApp({ role: 'staff' }).request(`/api/broadcasts/${KEY}/cancel`, {
      method: 'POST',
    });

    expect(response.status).toBe(403);
    expect(dbMocks.getBroadcastById).not.toHaveBeenCalled();
    expect(d1Prepare).not.toHaveBeenCalled();
  });

  test('同じ取消要求を再実行しても更新は1回だけにする', async () => {
    dbMocks.getBroadcastById
      .mockResolvedValueOnce(row)
      .mockResolvedValueOnce({ ...row, status: 'draft', scheduled_at: null })
      .mockResolvedValueOnce({ ...row, status: 'draft', scheduled_at: null });
    const app = setupApp();

    const first = await app.request(`/api/broadcasts/${KEY}/cancel`, { method: 'POST' });
    const replay = await app.request(`/api/broadcasts/${KEY}/cancel`, { method: 'POST' });

    expect(first.status).toBe(200);
    expect(replay.status).toBe(409);
    expect(d1Prepare).toHaveBeenCalledTimes(1);
  });

  test('読み取り後に送信開始された配信を下書きへ戻さない', async () => {
    dbMocks.getBroadcastById.mockResolvedValueOnce(row);

    const response = await setupApp({ changes: 0 }).request(`/api/broadcasts/${KEY}/cancel`, {
      method: 'POST',
    });

    expect(response.status).toBe(409);
    expect(dbMocks.getBroadcastById).toHaveBeenCalledTimes(1);
    expect(dbMocks.deleteBroadcast).not.toHaveBeenCalled();
  });

  test('取消UPDATEのD1障害を成功として返さない', async () => {
    dbMocks.getBroadcastById.mockResolvedValueOnce(row);
    const app = setupApp();
    d1Prepare.mockImplementationOnce(() => ({
      bind: vi.fn(() => ({
        run: vi.fn(async () => { throw new Error('db unavailable'); }),
      })),
    }));

    const response = await app.request(`/api/broadcasts/${KEY}/cancel`, {
      method: 'POST',
    });

    expect(response.status).toBe(500);
    const body = await response.json<{ incidentId: string }>();
    expect(body).toMatchObject({ success: false, incidentId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect(report).toHaveBeenCalledExactlyOnceWith(expect.anything(), expect.objectContaining({ incidentId: body.incidentId }));
    expect(dbMocks.getBroadcastById).toHaveBeenCalledTimes(1);
  });

  test('取消後の再読込に失敗したときは成功として返さない', async () => {
    dbMocks.getBroadcastById
      .mockResolvedValueOnce(row)
      .mockResolvedValueOnce(null);

    const response = await setupApp().request(`/api/broadcasts/${KEY}/cancel`, {
      method: 'POST',
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      success: false,
      error: 'Internal Server Error',
      incidentId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(report).toHaveBeenCalledTimes(1);
    expect(d1Prepare).toHaveBeenCalledTimes(1);
  });

  test('予約中ではない配信は更新しない', async () => {
    dbMocks.getBroadcastById.mockResolvedValueOnce({ ...row, status: 'draft', scheduled_at: null });

    const response = await setupApp().request(`/api/broadcasts/${KEY}/cancel`, {
      method: 'POST',
    });

    expect(response.status).toBe(409);
    expect(d1Prepare).not.toHaveBeenCalled();
  });
});
