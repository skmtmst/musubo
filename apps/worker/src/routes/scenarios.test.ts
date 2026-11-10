import { describe, expect, test, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../worker-env.js';
import { createTestD1, insertFriend } from '../test-utils/d1-sqlite.js';

const accountAccessMocks = vi.hoisted(() => ({
  canAccessAllLineAccounts: vi.fn(),
  getVisibleLineAccountScope: vi.fn(),
}));

vi.mock('../services/account-access.js', () => accountAccessMocks);

const dbMocks = {
  getScenarios: vi.fn(),
  getScenarioById: vi.fn(),
  createScenario: vi.fn(),
  updateScenario: vi.fn(),
  deleteScenario: vi.fn(),
  createScenarioStep: vi.fn(),
  updateScenarioStep: vi.fn(),
  deleteScenarioStep: vi.fn(),
  enrollFriendInScenario: vi.fn(),
  getFriendById: vi.fn(),
  computeNextDeliveryAt: vi.fn(),
  resolveStepContent: vi.fn(),
};
vi.mock('@line-crm/db', () => dbMocks);

vi.mock('../features/scenarios/scenario-stats.js', () => ({
  computeScenarioStats: vi.fn(),
}));

const { scenarios: scenariosModule } = await import('./scenarios.js');

interface ScenarioRow {
  id: string;
  name: string;
  description: string | null;
  trigger_type: string;
  trigger_tag_id: string | null;
  is_active: number;
  delivery_mode: string;
  created_at: string;
  updated_at: string;
  line_account_id: string | null;
  step_count: number;
}

function makeScenarioDb(rows: ScenarioRow[]) {
  const calls: { sql: string; binds: unknown[] }[] = [];
  const db = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          bound = args;
          return stmt;
        },
        async all<_T>() {
          calls.push({ sql, binds: bound });
          if (/SELECT s\.\*, COUNT\(ss\.id\)/i.test(sql)) {
            const [accountScope, limit, offset] = bound as [string, number, number];
            const allowed = accountScope.startsWith('[') ? JSON.parse(accountScope) as string[] : [accountScope];
            const includeGlobal = /line_account_id IS NULL/i.test(sql);
            const filtered = rows.filter((r) =>
              allowed.includes(r.line_account_id ?? '') || (includeGlobal && r.line_account_id == null));
            return { results: filtered.slice(offset, offset + limit) };
          }
          return { results: [] };
        },
        async first<_T>() {
          calls.push({ sql, binds: bound });
          if (/COUNT\(\*\) AS total FROM scenarios/i.test(sql)) {
            const [accountScope] = bound as [string];
            const allowed = accountScope.startsWith('[') ? JSON.parse(accountScope) as string[] : [accountScope];
            const includeGlobal = /line_account_id IS NULL/i.test(sql);
            return {
              total: rows.filter((r) =>
                allowed.includes(r.line_account_id ?? '') || (includeGlobal && r.line_account_id == null)).length,
            } as _T;
          }
          return null;
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
  return { db, calls };
}

function setupApp(
  db: D1Database,
  permissionKeys: string[] = ['/scenarios'],
  role: 'owner' | 'admin' | 'staff' = 'owner',
) {
  const app = new Hono<Env>();
  app.use('*', async (c, next) => {
    c.env = { DB: db } as Env['Bindings'];
    c.set('staff', {
      id: 'owner-1',
      name: '管理者',
      role,
      readOnly: false,
      tenantId: 'tenant-1',
      permissionKeys,
      assignedLineAccountId: null,
      canAccessDescendantAccounts: true,
    });
    await next();
  });
  app.route('/', scenariosModule);
  return app;
}

const rowBase = {
  description: null,
  trigger_type: 'friend_add',
  trigger_tag_id: null,
  is_active: 1,
  delivery_mode: 'relative',
  created_at: '2026-05-20T00:00:00.000',
  updated_at: '2026-05-20T00:00:00.000',
  step_count: 0,
};

beforeEach(() => {
  for (const fn of Object.values(dbMocks)) fn.mockReset();
  accountAccessMocks.canAccessAllLineAccounts.mockReset().mockResolvedValue(true);
  accountAccessMocks.getVisibleLineAccountScope.mockReset().mockResolvedValue({
    allowedAccountIds: ['acc-1'],
    canSeeUnassigned: true,
  });
});

describe('シナリオ名の長さ', () => {
  test('新規作成で60文字は受け付ける', async () => {
    const name = 'あ'.repeat(60);
    dbMocks.createScenario.mockResolvedValue({ id: 's-1', name, ...rowBase });
    const response = await setupApp({} as D1Database).request('/api/scenarios', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, triggerType: 'friend_add' }),
    });
    expect(response.status).toBe(201);
    expect(dbMocks.createScenario).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ name }));
  });

  test('新規作成で61文字以上を受け付けない', async () => {
    const response = await setupApp({} as D1Database).request('/api/scenarios', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'あ'.repeat(61), triggerType: 'friend_add' }),
    });
    expect(response.status).toBe(400);
    expect(dbMocks.createScenario).not.toHaveBeenCalled();
  });

  test.each([60, 61])('名前の変更で %i 文字を検査する', async (length) => {
    const name = 'あ'.repeat(length);
    dbMocks.getScenarioById.mockResolvedValue({ id: 's-1', line_account_id: 'acc-1', ...rowBase });
    dbMocks.updateScenario.mockResolvedValue({ id: 's-1', name, ...rowBase });
    const response = await setupApp({} as D1Database).request('/api/scenarios/s-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    expect(response.status).toBe(length === 60 ? 200 : 400);
    if (length > 60) expect(dbMocks.updateScenario).not.toHaveBeenCalled();
  });

  test('既存の長い名前を変えずに他の設定を保存できる', async () => {
    const name = '既存'.repeat(40);
    dbMocks.getScenarioById.mockResolvedValue({ id: 's-1', name, line_account_id: 'acc-1', ...rowBase });
    dbMocks.updateScenario.mockResolvedValue({ id: 's-1', name, line_account_id: 'acc-1', ...rowBase });
    const response = await setupApp({} as D1Database).request('/api/scenarios/s-1', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, folderId: 'folder-1' }),
    });
    expect(response.status).toBe(200);
    expect(dbMocks.updateScenario).toHaveBeenCalledWith(expect.anything(), 's-1', expect.objectContaining({ name: undefined, folder_id: 'folder-1' }), { accountScope: undefined, expectedRevision: undefined, expectedSubscriptions: undefined });
  });
});

describe('GET /api/scenarios?lineAccountId=X', () => {
  test('includes both account-bound and global (NULL) scenarios', async () => {
    const rows: ScenarioRow[] = [
      { id: 's-global', name: 'global', line_account_id: null, ...rowBase },
      { id: 's-acc1', name: 'acc1', line_account_id: 'acc-1', ...rowBase },
      { id: 's-acc2', name: 'acc2', line_account_id: 'acc-2', ...rowBase },
    ];
    const { db, calls } = makeScenarioDb(rows);

    const res = await setupApp(db).request('/api/scenarios?lineAccountId=acc-1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: { items: { id: string; lineAccountId: string | null }[]; total: number; limit: number } };
    expect(body.success).toBe(true);
    // 実行側と画面の対象を一致させるため、アカウント共通とそのアカウント所属のシナリオを両方返す。
    const ids = body.data.items.map((d) => d.id).sort();
    expect(ids).toEqual(['s-acc1', 's-global']);
    // 全アカウント共通と特定所属を画面で区別できるよう、所属値を返す。
    const globalRow = body.data.items.find((d) => d.id === 's-global');
    expect(globalRow?.lineAccountId).toBeNull();
    // 一覧を引くクエリは1本だけ。人数の集計は別に1本走るので、
    // 本数ではなく「一覧を引くもの」を選んで見る。
    const listCalls = calls.filter((c) => /SELECT s\.\*, COUNT\(ss\.id\)/i.test(c.sql));
    expect(listCalls).toHaveLength(1);
    expect(listCalls[0].sql).toMatch(/line_account_id IS NULL/);
    expect(listCalls[0].sql).toMatch(/s\.line_account_id = \?/);
    expect(listCalls[0].binds).toEqual(['acc-1', 50, 0]);

    // 購読中と読了済は、シナリオごとに引かず1回でまとめて数える。
    // 件数ぶん往復すると、シナリオが増えるほど一覧が遅くなる。
    const countCalls = calls.filter((c) => /FROM friend_scenarios/i.test(c.sql));
    expect(countCalls).toHaveLength(1);
    expect(countCalls[0].sql).toMatch(/f\.line_account_id IN/);
    expect(countCalls[0].binds).toEqual(expect.arrayContaining([JSON.stringify(['acc-1'])]));
  });

  test('lineAccountId が無くても可視範囲をDB側で絞ってページ化する', async () => {
    const { db, calls } = makeScenarioDb([
      { id: 's-x', name: 'x', line_account_id: 'acc-1', ...rowBase },
      { id: 's-hidden', name: 'hidden', line_account_id: 'acc-2', ...rowBase },
    ]);

    const res = await setupApp(db).request('/api/scenarios');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: { items: { id: string }[] } };
    expect(body.data.items.map((d) => d.id)).toEqual(['s-x']);
    const listCall = calls.find((call) => /SELECT s\.\*, COUNT\(ss\.id\)/i.test(call.sql));
    expect(listCall?.sql).toMatch(/s\.line_account_id IN/);
    expect(listCall?.binds).toEqual([JSON.stringify(['acc-1']), 50, 0]);
  });

  test('returns empty array when filter matches nothing and no globals exist', async () => {
    const rows: ScenarioRow[] = [
      { id: 's-other', name: 'other', line_account_id: 'acc-other', ...rowBase },
    ];
    const { db } = makeScenarioDb(rows);

    const res = await setupApp(db).request('/api/scenarios?lineAccountId=acc-1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: { items: unknown[]; total: number } };
    expect(body.data.items).toEqual([]);
    expect(body.data.total).toBe(0);
  });

  test('担当外アカウントの一覧は存在を隠す', async () => {
    const { db } = makeScenarioDb([]);
    const res = await setupApp(db).request('/api/scenarios?lineAccountId=acc-other');
    expect(res.status).toBe(404);
  });

  test('アカウント限定担当には全店共通シナリオを返さない', async () => {
    accountAccessMocks.getVisibleLineAccountScope.mockResolvedValue({
      allowedAccountIds: ['acc-1'], canSeeUnassigned: false,
    });
    const { db } = makeScenarioDb([
      { id: 's-global', name: 'global', line_account_id: null, ...rowBase },
      { id: 's-acc1', name: 'acc1', line_account_id: 'acc-1', ...rowBase },
    ]);
    const res = await setupApp(db).request('/api/scenarios?lineAccountId=acc-1');
    const body = await res.json() as { data: { items: Array<{ id: string }> } };
    expect(body.data.items.map((item) => item.id)).toEqual(['s-acc1']);
  });

  test('limit は200へ丸め、page から offset を計算する', async () => {
    const { db, calls } = makeScenarioDb([
      { id: 's-1', name: 'one', line_account_id: 'acc-1', ...rowBase },
    ]);
    const res = await setupApp(db).request('/api/scenarios?lineAccountId=acc-1&limit=999&page=3');
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { limit: number; sort: unknown[] } };
    expect(body.data.limit).toBe(200);
    expect(body.data.sort).toEqual([
      { field: 'createdAt', direction: 'desc' },
      { field: 'id', direction: 'desc' },
    ]);
    const listCall = calls.find((call) => /SELECT s\.\*, COUNT\(ss\.id\)/i.test(call.sql));
    expect(listCall?.binds).toEqual(['acc-1', 200, 400]);
  });

  test('検索と状態とフォルダをページ分割より先にDBで絞る', async () => {
    const { db, calls } = makeScenarioDb([
      { id: 's-1', name: '夏のお知らせ', line_account_id: 'acc-1', ...rowBase },
    ]);
    const res = await setupApp(db).request(
      '/api/scenarios?lineAccountId=acc-1&query=%E5%A4%8F&active=0&createdFrom=2026-09-01&folderId=folder-1',
    );
    expect(res.status).toBe(200);
    const listCall = calls.find((call) => /SELECT s\.\*, COUNT\(ss\.id\)/i.test(call.sql));
    // D1 の LIKE パターン50バイト制限を避けるため instr で部分一致する。
    // 束縛は `%夏%` ではなく検索語そのもの。
    expect(listCall?.sql).toMatch(/instr\(lower\(s\.name\), lower\(\?\)\) > 0/);
    expect(listCall?.sql).toMatch(/s\.is_active = 0/);
    expect(listCall?.sql).toMatch(/s\.created_at >= \?/);
    expect(listCall?.sql).toMatch(/s\.folder_id = \?/);
    expect(listCall?.binds).toEqual(['acc-1', '夏', '2026-09-01', 'folder-1', 50, 0]);
  });

  test('購読数は選択中のLINEアカウントだけを実DBで集計する', async () => {
    const { db, raw } = createTestD1();
    raw.prepare(`INSERT INTO scenarios
      (id, name, trigger_type, is_active, delivery_mode, line_account_id, created_at, updated_at)
      VALUES ('s-global', '全店シナリオ', 'friend_add', 1, 'relative', NULL, '2026-09-01', '2026-09-01')`).run();
    insertFriend(raw, 'friend-a', { line_account_id: 'acc-1' });
    insertFriend(raw, 'friend-b', { line_account_id: 'acc-2' });
    raw.prepare(`INSERT INTO friend_scenarios (id, friend_id, scenario_id, status)
      VALUES ('run-a', 'friend-a', 's-global', 'active'), ('run-b', 'friend-b', 's-global', 'active')`).run();

    const res = await setupApp(db).request('/api/scenarios?lineAccountId=acc-1&limit=1&page=1');
    expect(res.status).toBe(200);
    const body = await res.json() as {
      data: { items: Array<{ id: string; subscriberCount: number }>; total: number; limit: number };
    };
    expect(body.data).toMatchObject({ total: 1, limit: 1 });
    expect(body.data.items).toEqual([
      expect.objectContaining({ id: 's-global', subscriberCount: 1 }),
    ]);
  });

  test('最初の20件が0人でも次ページに人数があれば、全体の数と全ページの合計は一致する', async () => {
    const { db, raw } = createTestD1();
    try {
      const addScenario = raw.prepare(`INSERT INTO scenarios
        (id, name, trigger_type, line_account_id, created_at, updated_at)
        VALUES (?, '案内', 'manual', 'acc-1', ?, '2026-10-27')`);
      for (let index = 1; index <= 24; index++) {
        addScenario.run(`scenario-${index}`, `2026-10-${String(index).padStart(2, '0')}`);
        const completed = [2, 2, 2, 4][index - 1] ?? 0;
        for (let friend = 0; friend < completed; friend++) {
          const id = `friend-${index}-${friend}`;
          insertFriend(raw, id, { line_account_id: 'acc-1' });
          raw.prepare(`INSERT INTO friend_scenarios (id, friend_id, scenario_id, status)
            VALUES (?, ?, ?, 'completed')`).run(id, id, `scenario-${index}`);
        }
      }
      const app = setupApp(db);
      const readPage = async (page: number) => {
        const response = await app.request(`/api/scenarios?lineAccountId=acc-1&limit=20&page=${page}`);
        expect(response.status).toBe(200);
        return await response.json() as { data: { total: number; items: Array<{ completedCount: number }> } };
      };
      const first = await readPage(1);
      const second = await readPage(2);
      expect(first.data.total).toBe(24);
      expect(first.data.items).toHaveLength(20);
      expect(first.data.items.every(row => row.completedCount === 0)).toBe(true);
      const { getListStats } = await vi.importActual<typeof import('@line-crm/db')>('@line-crm/db');
      const stats = await getListStats(db, { allowedAccountIds: ['acc-1'], includeUnassigned: false });
      expect(stats.scenarios.completed).toBe(10);
      expect(second.data.items.reduce((sum, row) => sum + row.completedCount, 0)).toBe(stats.scenarios.completed);
    } finally { raw.close(); }
  });

  test('人数の集計だけ失敗しても一覧を返し、人数は0ではなく不明にする', async () => {
    const { db } = makeScenarioDb([{ id: 's-one', name: '読めるシナリオ', line_account_id: 'acc-1', ...rowBase }]);
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      if (sql.includes('FROM friend_scenarios fs')) throw new Error('counts unavailable');
      return prepare(sql);
    });
    const res = await setupApp(db).request('/api/scenarios?lineAccountId=acc-1');
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { items: Array<{ id: string; subscriberCount: number | null; completedCount: number | null }> } };
    expect(body.data.items).toEqual([expect.objectContaining({ id: 's-one', subscriberCount: null, completedCount: null })]);
  });

  test('閲覧対象のアカウントが空でも共通シナリオを残し、対象人数は実0人を返す', async () => {
    const { db, raw } = createTestD1();
    try {
      raw.prepare(`INSERT INTO scenarios (id, name, trigger_type, line_account_id)
        VALUES ('s-global', '共通の案内', 'manual', NULL)`).run();
      accountAccessMocks.getVisibleLineAccountScope.mockResolvedValue({
        allowedAccountIds: [], canSeeUnassigned: true,
      });
      const prepare = vi.spyOn(db, 'prepare');
      const response = await setupApp(db).request('/api/scenarios');
      expect(response.status).toBe(200);
      const body = await response.json() as { data: { total: number; items: unknown[] } };
      expect(body.data.total).toBe(1);
      expect(body.data.items).toEqual([expect.objectContaining({
        id: 's-global', subscriberCount: 0, completedCount: 0,
      })]);
      expect(prepare.mock.calls.some(([sql]) => sql.includes('FROM friend_scenarios fs'))).toBe(false);
    } finally { raw.close(); }
  });

  test.each([
    [null, 2, null, 2],
    [10, null, 10, null],
    [0, 0, 0, 0],
    [NaN, 2, null, 2],
    [10, -1, 10, null],
  ])('集計結果%s/%sの既知側と実0を保持する', async (active, completed, expectedActive, expectedCompleted) => {
    const { db } = makeScenarioDb([{ id: 's-one', name: '案内', line_account_id: 'acc-1', ...rowBase }]);
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      if (!sql.includes('FROM friend_scenarios fs')) return prepare(sql);
      const statement = { bind: () => statement, all: async () => ({ results: [
        { scenario_id: 's-one', active_count: active, completed_count: completed },
      ] }) };
      return statement as unknown as ReturnType<typeof db.prepare>;
    });
    const response = await setupApp(db).request('/api/scenarios?lineAccountId=acc-1');
    expect(response.status).toBe(200);
    const body = await response.json() as { data: { total: number; items: unknown[] } };
    expect(body.data.total).toBe(1);
    expect(body.data.items).toEqual([expect.objectContaining({
      id: 's-one', subscriberCount: expectedActive, completedCount: expectedCompleted,
    })]);
  });

  test('閲覧権限がない利用者には一覧を返さない', async () => {
    const { db } = makeScenarioDb([]);
    const res = await setupApp(db, [], 'staff').request('/api/scenarios');
    expect(res.status).toBe(403);
    expect(dbMocks.getScenarioById).not.toHaveBeenCalled();
  });
});

describe('POST /api/scenarios/:id/test-send', () => {
  function testSendDb() {
    let stepReads = 0;
    const db = {
      prepare(sql: string) {
        const statement = {
          bind() {
            return statement;
          },
          async first() {
            if (/SELECT id, line_account_id FROM scenarios/i.test(sql)) {
              return { id: 'scenario-1', line_account_id: 'account-1' };
            }
            return null;
          },
          async all() {
            stepReads += 1;
            return { results: [] };
          },
        };
        return statement;
      },
    } as unknown as D1Database;
    return { db, stepReads: () => stepReads };
  }

  test('別LINEアカウントの友だちには送信処理を始めない', async () => {
    dbMocks.getScenarioById.mockResolvedValue({ id: 'scenario-1', line_account_id: 'account-1' });
    dbMocks.getFriendById.mockResolvedValue({ id: 'friend-2', line_account_id: 'account-2' });
    const { db, stepReads } = testSendDb();

    const response = await setupApp(db).request('/api/scenarios/scenario-1/test-send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ friendId: 'friend-2' }),
    });

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ success: false });
    expect(stepReads()).toBe(0);
  });

  test('担当者から見えない友だちは存在を隠して送信処理を始めない', async () => {
    dbMocks.getScenarioById.mockResolvedValue({ id: 'scenario-1', line_account_id: 'account-1' });
    dbMocks.getFriendById.mockResolvedValue({ id: 'friend-hidden', line_account_id: 'account-1' });
    accountAccessMocks.canAccessAllLineAccounts
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const { db, stepReads } = testSendDb();

    const response = await setupApp(db).request('/api/scenarios/scenario-1/test-send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ friendId: 'friend-hidden' }),
    });

    expect(response.status).toBe(404);
    expect(stepReads()).toBe(0);
  });
});

describe('シナリオ通の本文契約', () => {
  const visibleScenario = {
    id: 'scenario-1',
    line_account_id: 'account-1',
  };

  test('5,001文字の本文は作成前に止める', async () => {
    dbMocks.getScenarioById.mockResolvedValue(visibleScenario);
    const response = await setupApp({} as D1Database).request('/api/scenarios/scenario-1/steps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stepOrder: 1,
        delayMinutes: 0,
        messageType: 'text',
        messageContent: 'あ'.repeat(5_001),
      }),
    });

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      success: false,
      code: 'TEMPLATE_TEXT_TOO_LONG',
      actualCharacters: 5_001,
    });
    expect(dbMocks.createScenarioStep).not.toHaveBeenCalled();
  });

  test('5,001文字の本文は更新前にも止める', async () => {
    dbMocks.getScenarioById.mockResolvedValue(visibleScenario);
    const response = await setupApp({} as D1Database).request(
      '/api/scenarios/scenario-1/steps/step-1',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messageType: 'text',
          messageContent: 'あ'.repeat(5_001),
        }),
      },
    );

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      success: false,
      code: 'TEMPLATE_TEXT_TOO_LONG',
      actualCharacters: 5_001,
    });
    expect(dbMocks.updateScenarioStep).not.toHaveBeenCalled();
  });

  test('質問は空のテキスト本文を要求せず保存できる', async () => {
    dbMocks.getScenarioById.mockResolvedValue(visibleScenario);
    const db = {
      prepare(sql: string) {
        const statement = {
          bind() {
            return statement;
          },
          async first() {
            if (/SELECT delivery_mode FROM scenarios/i.test(sql)) {
              return { delivery_mode: 'relative' };
            }
            if (/SELECT id FROM scenario_steps/i.test(sql)) return null;
            return null;
          },
        };
        return statement;
      },
    } as unknown as D1Database;
    dbMocks.createScenarioStep.mockResolvedValue({
      id: 'step-1',
      scenario_id: 'scenario-1',
      step_order: 1,
      delay_minutes: 0,
      offset_days: null,
      offset_minutes: null,
      delivery_time: null,
      message_type: 'text',
      message_content: '',
      condition_type: null,
      condition_value: null,
      next_step_on_false: null,
      template_id: null,
      on_reach_tag_id: null,
      after_send: 'continue',
      target_condition_json: null,
      question_json: JSON.stringify({
        text: '体調はいかがですか？',
        tapMode: 'single',
        choices: [{ label: 'よい', behavior: 'none' }],
      }),
      is_draft: 0,
      created_at: '2026-09-02T00:00:00.000',
    });

    const response = await setupApp(db).request('/api/scenarios/scenario-1/steps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stepOrder: 1,
        delayMinutes: 0,
        messageType: 'text',
        messageContent: '',
        question: {
          text: '体調はいかがですか？',
          tapMode: 'single',
          choices: [{ label: 'よい', behavior: 'none' }],
        },
      }),
    });

    expect(response.status).toBe(201);
    expect(dbMocks.createScenarioStep).toHaveBeenCalledTimes(1);
  });

  test('R214: 質問のURL選択肢に不正なURLは 400 で止める', async () => {
    dbMocks.getScenarioById.mockResolvedValue(visibleScenario);
    const db = {
      prepare(sql: string) {
        const statement = {
          bind() {
            return statement;
          },
          async first() {
            if (/SELECT delivery_mode FROM scenarios/i.test(sql)) {
              return { delivery_mode: 'relative' };
            }
            if (/SELECT id FROM scenario_steps/i.test(sql)) return null;
            return null;
          },
        };
        return statement;
      },
    } as unknown as D1Database;

    const response = await setupApp(db).request('/api/scenarios/scenario-1/steps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stepOrder: 1,
        delayMinutes: 0,
        messageType: 'text',
        messageContent: ' ',
        question: {
          text: '体調はいかがですか？',
          tapMode: 'single',
          choices: [{ label: '詳しく見る', behavior: 'url', url: 'not-a-url' }],
        },
      }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain('選択肢1のURL');
    expect(dbMocks.createScenarioStep).not.toHaveBeenCalled();
  });

  test('R214: 正しい https のURLの質問は保存できる', async () => {
    dbMocks.getScenarioById.mockResolvedValue(visibleScenario);
    const db = {
      prepare(sql: string) {
        const statement = {
          bind() {
            return statement;
          },
          async first() {
            if (/SELECT delivery_mode FROM scenarios/i.test(sql)) {
              return { delivery_mode: 'relative' };
            }
            if (/SELECT id FROM scenario_steps/i.test(sql)) return null;
            return null;
          },
        };
        return statement;
      },
    } as unknown as D1Database;
    dbMocks.createScenarioStep.mockResolvedValue({ id: 'step-1' });

    const response = await setupApp(db).request('/api/scenarios/scenario-1/steps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stepOrder: 1,
        delayMinutes: 0,
        messageType: 'text',
        messageContent: ' ',
        question: {
          text: '体調はいかがですか？',
          tapMode: 'single',
          choices: [{ label: '詳しく見る', behavior: 'url', url: 'https://example.com/a' }],
        },
      }),
    });

    expect(response.status).toBe(201);
    expect(dbMocks.createScenarioStep).toHaveBeenCalledTimes(1);
  });
});

describe('GET /api/scenarios/:id/preview', () => {
  test('軽15: 壊れた開始日時は simulate と同じく 400 で断る', async () => {
    // 前段の可視確認を通す（存在する扱い）。検証はその後ろで動く。
    dbMocks.getScenarioById.mockResolvedValue({ id: 's-1', line_account_id: 'acc-1' });
    const { db } = makeScenarioDb([]);
    const res = await setupApp(db).request(
      `/api/scenarios/s-1/preview?startAt=${encodeURIComponent('壊れた日時')}`,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { success: boolean; code: string; field: string };
    expect(body).toMatchObject({ success: false, code: 'start_at_invalid', field: 'startAt' });
  });

  test('R212: 下書きの通は isDraft 付きで返る（送られる通と見分けられる）', async () => {
    dbMocks.getScenarioById.mockResolvedValue({ id: 's-1', line_account_id: 'acc-1' });
    dbMocks.resolveStepContent.mockImplementation(
      async (_db: unknown, step: { message_content: string }) => ({
        messageType: 'text',
        messageContent: step.message_content,
        questionJson: null,
      }),
    );
    dbMocks.computeNextDeliveryAt.mockImplementation(() => new Date('2026-09-28T10:00:00+09:00'));
    const db = {
      prepare(sql: string) {
        const statement = {
          bind() {
            return statement;
          },
          async first() {
            if (/FROM scenarios/i.test(sql)) {
              return { delivery_mode: 'elapsed', line_account_id: 'acc-1' };
            }
            return null;
          },
          async all() {
            return {
              results: [
                {
                  id: 'st-1', step_order: 1, delay_minutes: 0, offset_days: 0,
                  offset_minutes: 0, delivery_time: null, template_id: null,
                  message_type: 'text', message_content: '通常の通',
                  question_json: null, is_draft: 0,
                },
                {
                  id: 'st-2', step_order: 2, delay_minutes: 0, offset_days: 1,
                  offset_minutes: 0, delivery_time: null, template_id: null,
                  message_type: 'text', message_content: '下書きの通',
                  question_json: null, is_draft: 1,
                },
              ],
            };
          },
        };
        return statement;
      },
    } as unknown as D1Database;
    const res = await setupApp(db).request(
      `/api/scenarios/s-1/preview?startAt=${encodeURIComponent('2026-09-28T10:00:00+09:00')}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: { steps: Array<{ stepOrder: number; isDraft: boolean }> };
    };
    expect(body.success).toBe(true);
    expect(body.data.steps.map((s) => [s.stepOrder, s.isDraft])).toEqual([
      [1, false],
      [2, true],
    ]);
  });

  test('R237: 公開版・通の控えのどれかと、控えの理由が返る', async () => {
    dbMocks.getScenarioById.mockResolvedValue({ id: 's-1', line_account_id: 'acc-1' });
    dbMocks.resolveStepContent.mockImplementation(
      async (_db: unknown, step: { template_id: string | null; message_content: string }) => {
        if (step.template_id === 'tpl-ok') {
          return {
            messageType: 'text', messageContent: '公開版', questionJson: null,
            templateIdAtSend: 'tpl-ok', fallbackReason: null,
          };
        }
        // 実物の resolveStepContent と同じく、参照が無い通の理由は null。
        if (step.template_id == null) {
          return {
            messageType: 'text', messageContent: step.message_content, questionJson: null,
            templateIdAtSend: null, fallbackReason: null,
          };
        }
        return {
          messageType: 'text', messageContent: step.message_content, questionJson: null,
          templateIdAtSend: null, fallbackReason: 'unpublished',
        };
      },
    );
    dbMocks.computeNextDeliveryAt.mockImplementation(() => new Date('2026-09-28T10:00:00+09:00'));
    const db = {
      prepare(sql: string) {
        const statement = {
          bind() {
            return statement;
          },
          async first() {
            if (/FROM scenarios/i.test(sql)) {
              return { delivery_mode: 'elapsed', line_account_id: 'acc-1' };
            }
            return null;
          },
          async all() {
            return {
              results: [
                {
                  id: 'st-1', step_order: 1, delay_minutes: 0, offset_days: 0,
                  offset_minutes: 0, delivery_time: null, template_id: 'tpl-ok',
                  message_type: 'text', message_content: '控え',
                  question_json: null, is_draft: 0,
                },
                {
                  id: 'st-2', step_order: 2, delay_minutes: 0, offset_days: 1,
                  offset_minutes: 0, delivery_time: null, template_id: 'tpl-draft',
                  message_type: 'text', message_content: '控え',
                  question_json: null, is_draft: 0,
                },
                {
                  id: 'st-3', step_order: 3, delay_minutes: 0, offset_days: 2,
                  offset_minutes: 0, delivery_time: null, template_id: null,
                  message_type: 'text', message_content: '直接書いた通',
                  question_json: null, is_draft: 0,
                },
              ],
            };
          },
        };
        return statement;
      },
    } as unknown as D1Database;
    const res = await setupApp(db).request(
      `/api/scenarios/s-1/preview?startAt=${encodeURIComponent('2026-09-28T10:00:00+09:00')}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: {
        steps: Array<{ stepOrder: number; contentSource: string; fallbackReason: string | null }>;
      };
    };
    expect(body.success).toBe(true);
    expect(body.data.steps.map((s) => [s.stepOrder, s.contentSource, s.fallbackReason])).toEqual([
      [1, 'template', null],
      [2, 'step-fallback', 'unpublished'],
      [3, 'step', null],
    ]);
  });
});
