import { describe, expect, test, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { AuthenticatedStaff } from '../middleware/auth/principal/auth.js';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite';

// アカウント指定時は D1 へ渡る SQL と引数を検証し、未指定時の DB ヘルパ経路は別に差し替える。
const dbMocks = {
  getAutomations: vi.fn(),
  getAutomationById: vi.fn(),
  createAutomation: vi.fn(),
  updateAutomation: vi.fn(),
  deleteAutomation: vi.fn(),
  getAutomationLogs: vi.fn(),
  getAutomationExecutionRuns: vi.fn(),
  getAutomationExecutionRun: vi.fn(),
  getAutomationExecutionRunSteps: vi.fn(),
  isOperationCapabilityStopped: vi.fn(),
  getLineAccounts: vi.fn(),
  getLineAccountScopeEntries: vi.fn(),
  getStaffById: vi.fn(),
  getStaffAccountScopeIds: vi.fn(),
};
vi.mock('@line-crm/db', () => dbMocks);

// 止まっている理由を付けるために feature 状態を読む。
// 既定は「有効」にして、止まる試験だけ個別に差し替える。
const featureMocks = vi.hoisted(() => ({
  accountFeatureAvailability: vi.fn(async () => ({
    effectiveEnabled: true,
    message: null as string | null,
  })),
}));
vi.mock('../services/feature-enforcement.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/feature-enforcement.js')>()),
  accountFeatureAvailability: featureMocks.accountFeatureAvailability,
}));

const { automations } = await import('./automations.js');

/*
 * requireVisibleAutomation は先に の automation_definitions を
 * db.prepare で引く。旧テストは `{}` を渡していたため prepare が無く 500
 * になった。ここでは「には無い」= null を返す最小のD1を用意し、
 * 旧 automations 表のモック（getAutomationById）へ落ちる経路を残す。
 */
const fakeD1 = () => ({
  prepare: () => ({
    bind: () => ({
      first: async () => null,
      all: async () => ({ results: [] }),
      run: async () => ({ meta: { changes: 0 } }),
    }),
    first: async () => null,
    all: async () => ({ results: [] }),
    run: async () => ({ meta: { changes: 0 } }),
  }),
}) as unknown as D1Database;

function setupApp(db: D1Database, staff?: Partial<AuthenticatedStaff>) {
  const app = new Hono<{
    Bindings: { DB: D1Database };
    Variables: { staff: AuthenticatedStaff };
  }>();
  app.use('*', async (c, next) => {
    c.env = { DB: db };
    c.set('staff', {
      id: 'staff-1',
      name: 'Staff',
      role: 'admin',
      readOnly: false,
      permissionKeys: [],
      assignedLineAccountId: null,
      canAccessDescendantAccounts: false,
      tenantId: '00000000-0000-4000-8000-000000000001',
      ...staff,
    });
    await next();
  });
  app.route('/', automations);
  return app;
}

const STAFF_WITHOUT_KEY = { role: 'staff', permissionKeys: [] } as Partial<AuthenticatedStaff>;
const STAFF_WITH_KEY = { role: 'staff', permissionKeys: ['/automations'] } as Partial<AuthenticatedStaff>;
// 設定画面で「閲覧だけ」を許可した担当者。変更のキーは持たない。
const STAFF_WITH_VIEW_KEY = {
  role: 'staff', permissionKeys: [], viewPermissionKeys: ['/automations'],
} as Partial<AuthenticatedStaff>;
const STAFF_WITH_EXPORT_KEY = {
  role: 'staff', permissionKeys: ['/automations', 'automation.run.export'],
} as Partial<AuthenticatedStaff>;
const STAFF_WITH_RETRY_KEY = {
  role: 'staff', permissionKeys: ['/automations', 'automation.run.retry'],
} as Partial<AuthenticatedStaff>;

beforeEach(() => {
  for (const fn of Object.values(dbMocks)) fn.mockReset();
  dbMocks.isOperationCapabilityStopped.mockResolvedValue(false);
  featureMocks.accountFeatureAvailability.mockReset();
  featureMocks.accountFeatureAvailability.mockResolvedValue({
    effectiveEnabled: true, message: null,
  });
  dbMocks.getLineAccountScopeEntries.mockImplementation(async (...args: unknown[]) =>
    dbMocks.getLineAccounts(...args));
  dbMocks.getLineAccounts.mockResolvedValue([
    { id: 'acc-1', name: '本店', tenant_id: '00000000-0000-4000-8000-000000000001' },
    { id: 'acc-2', name: '二号店', tenant_id: '00000000-0000-4000-8000-000000000001' },
  ]);
  dbMocks.getStaffById.mockResolvedValue(null);
  dbMocks.getStaffAccountScopeIds.mockResolvedValue([]);
});

describe('GET /api/automation-runs', () => {
  test('既存の機能固有状態を共通状態へ読み替え、未取得値を作らない', async () => {
    dbMocks.getAutomationExecutionRuns.mockResolvedValue({
      rows: [
        {
          id: 'run-1', line_account_id: 'acc-1', account_name: '本店',
          automation_id: 'automation-1', automation_name: '予約案内', automation_version_id: 'version-1',
          friend_id: 'friend-1', friend_name: '田中さん', source_event_id: 'event-1',
          trigger_type: 'message_received', status: 'partial',
          started_at: '2026-08-28T01:00:00.000Z', completed_at: '2026-08-28T01:00:01.200Z',
          created_at: '2026-08-28T01:00:00.000Z', duration_ms: 1200,
          successful_actions: 'send_message', skipped_actions: null,
          failed_action: 'send_webhook', failure_code: 'webhook_timeout',
        },
        {
          id: 'run-2', line_account_id: 'acc-1', account_name: '本店',
          automation_id: 'automation-1', automation_name: '予約案内', automation_version_id: 'version-1',
          friend_id: null, friend_name: null, source_event_id: 'event-2',
          trigger_type: 'message_received', status: 'skipped_condition',
          started_at: null, completed_at: null, created_at: '2026-08-28T00:00:00.000Z', duration_ms: null,
          successful_actions: null, skipped_actions: null, failed_action: null, failure_code: null,
        },
      ],
      total: 2,
      summary: { total: 2, executed: 1, skipped: 1, failed: 0, most_run_name: '予約案内', most_run_count: 1 },
    });

    const res = await setupApp(fakeD1()).request('/api/automation-runs?lineAccountId=acc-1&status=executed&limit=20&offset=0');
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { items: Array<Record<string, unknown>> } };
    expect(body.data.items[0]).toMatchObject({
      // 一部だけ成功は失敗とは別の状態で返す。
      ownerKind: 'automation', status: 'partial', subject: '田中さん', accountLabel: '本店',
      triggerLabel: 'メッセージが届いたとき', detail: 'メッセージを送信。外部連携先が応答しませんでした',
      durationMs: 1200, canRetry: true,
    });
    expect(body.data.items[1]).toMatchObject({
      status: 'skipped', subject: null, detail: '条件に合わなかったため、何もしていません', durationMs: null,
    });
    expect(dbMocks.getAutomationExecutionRuns).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      allowedAccountIds: ['acc-1'],
      status: ['success', 'partial', 'failed'],
      limit: 20,
      offset: 0,
    }));
  });

  test('閲覧できないLINEアカウントは空表示にせず403で止める', async () => {
    const res = await setupApp(fakeD1()).request('/api/automation-runs?lineAccountId=outside');
    expect(res.status).toBe(403);
    expect(dbMocks.getAutomationExecutionRuns).not.toHaveBeenCalled();
  });

  test('見送った処理だけの部分成功に、存在しない失敗理由を作らない', async () => {
    dbMocks.getAutomationExecutionRuns.mockResolvedValue({
      rows: [{
        id: 'run-partial', line_account_id: 'acc-1', account_name: '本店',
        automation_id: 'automation-1', automation_name: '予約案内', automation_version_id: 'version-1',
        friend_id: 'friend-1', friend_name: '田中さん', source_event_id: 'event-1',
        trigger_type: 'message_received', status: 'partial',
        started_at: '2026-08-28T01:00:00.000Z', completed_at: '2026-08-28T01:00:01.000Z',
        created_at: '2026-08-28T01:00:00.000Z', duration_ms: 1000,
        successful_actions: 'send_message', skipped_actions: 'add_tag',
        failed_action: null, failure_code: null,
      }],
      total: 1,
      summary: { total: 1, executed: 1, skipped: 0, failed: 1, most_run_name: '予約案内', most_run_count: 1 },
    });

    const res = await setupApp(fakeD1()).request('/api/automation-runs?lineAccountId=acc-1');
    const body = await res.json() as { data: { items: Array<Record<string, unknown>> } };
    expect(body.data.items[0]).toMatchObject({
      status: 'partial',
      detail: 'メッセージを送信。タグを追加は見送り',
      failureReason: null,
    });
  });

  /*
   * 「待っています」と「止まっています」を区別する。
   * 運用停止・機能無効で claim できない実行は queued のまま残るが、
   * 理由を人の言葉で detail / holdReason に出す。
   */
  test('運用停止で動けない実行には止まっている理由を付ける', async () => {
    dbMocks.isOperationCapabilityStopped.mockResolvedValue(true);
    dbMocks.getAutomationExecutionRuns.mockResolvedValue({
      rows: [runRow({ status: 'queued', completed_at: null, duration_ms: null, successful_actions: null })],
      total: 1,
      summary: { total: 1, executed: 0, skipped: 0, failed: 0, most_run_name: null, most_run_count: null },
    });

    const res = await setupApp(fakeD1()).request('/api/automation-runs?lineAccountId=acc-1');
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { items: Array<Record<string, unknown>> } };
    expect(body.data.items[0]).toMatchObject({
      status: 'queued',
      detail: '運用停止中のため、いまは動かせません。再開されると動きます',
      holdReason: '運用停止中のため、いまは動かせません。再開されると動きます',
    });
    expect(dbMocks.isOperationCapabilityStopped)
      .toHaveBeenCalledWith(expect.anything(), 'acc-1', 'automation_actions');
  });

  test('機能が無効なアカウントの実行には、その旨を理由として付ける', async () => {
    featureMocks.accountFeatureAvailability.mockResolvedValue({
      effectiveEnabled: false, message: 'この機能は設定でオフになっています',
    });
    dbMocks.getAutomationExecutionRuns.mockResolvedValue({
      rows: [runRow({ status: 'queued', completed_at: null, duration_ms: null, successful_actions: null })],
      total: 1,
      summary: { total: 1, executed: 0, skipped: 0, failed: 0, most_run_name: null, most_run_count: null },
    });

    const res = await setupApp(fakeD1()).request('/api/automation-runs?lineAccountId=acc-1');
    const body = await res.json() as { data: { items: Array<Record<string, unknown>> } };
    expect(body.data.items[0]).toMatchObject({
      status: 'queued',
      holdReason: 'この機能は設定でオフになっています',
      detail: 'この機能は設定でオフになっています',
    });
  });

  test('待機(wait)と再試行待ちを区別し、終わった実行には止まる理由を付けない', async () => {
    dbMocks.getAutomationExecutionRuns.mockResolvedValue({
      rows: [
        runRow({ id: 'run-wait', status: 'waiting', has_retry_wait: 0, successful_actions: 'add_tag' }),
        runRow({ id: 'run-retry', status: 'waiting', has_retry_wait: 1, successful_actions: 'add_tag' }),
        runRow({ id: 'run-done' }),
      ],
      total: 3,
      summary: { total: 3, executed: 1, skipped: 0, failed: 0, most_run_name: '予約案内', most_run_count: 1 },
    });

    const res = await setupApp(fakeD1()).request('/api/automation-runs?lineAccountId=acc-1');
    const body = await res.json() as { data: { items: Array<Record<string, unknown>> } };
    expect(body.data.items[0]).toMatchObject({
      status: 'waiting', detail: 'タグを追加。設定した時刻まで待っています', holdReason: null,
    });
    expect(body.data.items[1]).toMatchObject({
      status: 'retry_wait', detail: 'タグを追加。失敗した処理の再試行を待っています',
    });
    expect(body.data.items[2]).toMatchObject({ status: 'succeeded', holdReason: null });
  });

  test('実行した版といまの公開版の区別が分かる値を返す', async () => {
    dbMocks.getAutomationExecutionRuns.mockResolvedValue({
      rows: [
        runRow({ id: 'run-old', version_number: 2, current_published_version_id: 'ver-2', current_version_number: 4 }),
        runRow({ id: 'run-now' }),
      ],
      total: 2,
      summary: { total: 2, executed: 2, skipped: 0, failed: 0, most_run_name: '予約案内', most_run_count: 2 },
    });

    const res = await setupApp(fakeD1()).request('/api/automation-runs?lineAccountId=acc-1');
    const body = await res.json() as { data: { items: Array<Record<string, unknown>> } };
    // run-old は ver-1 で動いたが、いまの公開版は ver-2（=v4）。
    expect(body.data.items[0]).toMatchObject({
      versionNumber: 2, isCurrentVersion: false, currentVersionNumber: 4,
    });
    expect(body.data.items[1]).toMatchObject({
      versionNumber: 3, isCurrentVersion: true, currentVersionNumber: 3,
    });
  });

  test('include_test を付けたときだけテスト実行を含める口へ渡す', async () => {
    dbMocks.getAutomationExecutionRuns.mockResolvedValue({
      rows: [],
      total: 0,
      summary: { total: 0, executed: 0, skipped: 0, failed: 0, most_run_name: null, most_run_count: null },
    });
    const app = setupApp(fakeD1());
    await app.request('/api/automation-runs?lineAccountId=acc-1');
    expect(dbMocks.getAutomationExecutionRuns).toHaveBeenLastCalledWith(expect.anything(),
      expect.objectContaining({ includeTest: false }));
    await app.request('/api/automation-runs?lineAccountId=acc-1&include_test=1');
    expect(dbMocks.getAutomationExecutionRuns).toHaveBeenLastCalledWith(expect.anything(),
      expect.objectContaining({ includeTest: true }));
  });
});

describe('GET /api/automations/:id/logs', () => {
  test.each([
    ['999999', 200],
    ['-1', 100],
    ['NaN', 100],
  ])('limit=%s を最大200件以内へ直す', async (raw, expected) => {
    dbMocks.getAutomationById.mockResolvedValue({ id: 'automation-1', line_account_id: null });
    dbMocks.getAutomationLogs.mockResolvedValue([]);
    const res = await setupApp(fakeD1()).request(`/api/automations/automation-1/logs?limit=${raw}`);
    expect(res.status).toBe(200);
    expect(dbMocks.getAutomationLogs).toHaveBeenCalledWith(
      expect.anything(),
      'automation-1',
      expected,
    );
  });
});

describe('旧作成口の削除（#554 点検#519中6）', () => {
  test('POST /api/automations は404を返し、何も作らない', async () => {
    const res = await setupApp(fakeD1()).request('/api/automations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x', eventType: 'message_received', actions: [] }),
    });
    expect(res.status).toBe(404);
    expect(dbMocks.createAutomation).not.toHaveBeenCalled();
  });
});

describe('権限キー検査（#554 点検#519中4・中5）', () => {
  test('実行記録の一覧は権限キーのないstaffに403を返す', async () => {
    const res = await setupApp(fakeD1(), STAFF_WITHOUT_KEY)
      .request('/api/automation-runs?lineAccountId=acc-1');
    expect(res.status).toBe(403);
    expect(dbMocks.getAutomationExecutionRuns).not.toHaveBeenCalled();
  });

  test('実行記録の一覧は権限キーを持つstaffに200を返す', async () => {
    dbMocks.getAutomationExecutionRuns.mockResolvedValue({
      rows: [],
      total: 0,
      summary: { total: 0, executed: 0, skipped: 0, failed: 0, most_run_name: null, most_run_count: null },
    });
    const res = await setupApp(fakeD1(), STAFF_WITH_KEY)
      .request('/api/automation-runs?lineAccountId=acc-1');
    expect(res.status).toBe(200);
  });

  // 「閲覧だけ」の権限で保存した担当者が履歴を読めなかった不具合。
  // 一覧・詳細は読めるが、書き出し・再試行・取消は従来どおり拒否する。
  test('閲覧だけの権限のstaffは一覧・詳細を読め、変更系は拒否される', async () => {
    dbMocks.getAutomationExecutionRuns.mockResolvedValue({
      rows: [],
      total: 0,
      summary: { total: 0, executed: 0, skipped: 0, failed: 0, most_run_name: null, most_run_count: null },
    });
    const list = await setupApp(fakeD1(), STAFF_WITH_VIEW_KEY)
      .request('/api/automation-runs?lineAccountId=acc-1');
    expect(list.status).toBe(200);

    dbMocks.getAutomationExecutionRun.mockResolvedValue(runRow({
      id: 'run-1', status: 'success', version_number: 2,
      completed_at: '2026-08-28T01:00:01.000Z', duration_ms: 1000,
    }));
    dbMocks.getAutomationExecutionRunSteps.mockResolvedValue([]);
    const detail = await setupApp(fakeD1(), STAFF_WITH_VIEW_KEY)
      .request('/api/automation-runs/run-1');
    expect(detail.status).toBe(200);

    // CSV書き出しは automation.run.export が別途要る。
    const csv = await setupApp(fakeD1(), STAFF_WITH_VIEW_KEY)
      .request('/api/automation-runs?lineAccountId=acc-1&format=csv');
    expect(csv.status).toBe(403);
  });

  test('閲覧だけの権限のstaffは再試行・取消を実行できない', async () => {
    const testDb = realAutomationDb();
    addRun(testDb.raw, { id: 'run-1', status: 'failed' });
    addRun(testDb.raw, { id: 'run-2', status: 'waiting' });
    const retry = await setupApp(testDb.db, STAFF_WITH_VIEW_KEY)
      .request('/api/automation-runs/run-1/retry', { method: 'POST' });
    expect(retry.status).toBe(403);
    const cancel = await setupApp(testDb.db, STAFF_WITH_VIEW_KEY)
      .request('/api/automation-runs/run-2/cancel', { method: 'POST' });
    expect(cancel.status).toBe(403);
  });

  test('詳細は権限キーのないstaffに403を返す（アカウント範囲内でも）', async () => {
    dbMocks.getAutomationById.mockResolvedValue({ id: 'automation-1', line_account_id: 'acc-1' });
    const res = await setupApp(fakeD1(), STAFF_WITHOUT_KEY)
      .request('/api/automations/automation-1');
    expect(res.status).toBe(403);
  });

  test('ログは権限キーのないstaffに403を返す', async () => {
    dbMocks.getAutomationById.mockResolvedValue({ id: 'automation-1', line_account_id: 'acc-1' });
    const res = await setupApp(fakeD1(), STAFF_WITHOUT_KEY)
      .request('/api/automations/automation-1/logs');
    expect(res.status).toBe(403);
    expect(dbMocks.getAutomationLogs).not.toHaveBeenCalled();
  });

  test('ログは権限キーを持つstaffに200を返す', async () => {
    dbMocks.getAutomationById.mockResolvedValue({ id: 'automation-1', line_account_id: 'acc-1' });
    dbMocks.getAutomationLogs.mockResolvedValue([]);
    const res = await setupApp(fakeD1(), STAFF_WITH_KEY)
      .request('/api/automations/automation-1/logs');
    expect(res.status).toBe(200);
  });
});

/** getAutomationExecutionRuns が返す行の、台帳・CSV共通の最小形。 */
function runRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'run-1', line_account_id: 'acc-1', account_name: '本店',
    automation_id: 'auto-1', automation_name: '予約案内', automation_version_id: 'ver-1',
    version_number: 3, is_test: 0,
    current_published_version_id: 'ver-1', current_version_number: 3,
    has_retry_wait: 0,
    friend_id: 'friend-1', friend_name: '田中さん', source_event_id: 'event-1',
    trigger_type: 'friend_add', status: 'success',
    started_at: '2026-08-28T01:00:00.000Z', completed_at: '2026-08-28T01:00:01.000Z',
    created_at: '2026-08-28T01:00:00.000Z', duration_ms: 1000,
    successful_actions: 'add_tag', skipped_actions: null,
    failed_action: null, failure_code: null,
    ...overrides,
  };
}

describe('GET /api/automation-runs/:id（#942 N-354 実行の詳細）', () => {
  test('版番号・テスト印・取消可否と、処理ごとの結果・試行数を返す', async () => {
    dbMocks.getAutomationExecutionRun.mockResolvedValue(runRow({
      // 待機中stepに retry_at があるときだけ再試行待ち。
      status: 'waiting', has_retry_wait: 1, version_number: 4, is_test: 1,
      successful_actions: null, completed_at: null, duration_ms: null,
    }));
    dbMocks.getAutomationExecutionRunSteps.mockResolvedValue([
      {
        step_key: 'shared', action_type: 'common_action_marker',
        common_action_version_id: 'cv-9', status: 'success', attempt_number: 1,
        error_code: null, error_message: null,
        started_at: '2026-08-28T01:00:00.000Z', completed_at: '2026-08-28T01:00:00.500Z',
      },
      {
        step_key: 'send', action_type: 'send_message',
        common_action_version_id: null, status: 'failed', attempt_number: 3,
        error_code: 'line_api_error', error_message: 'raw provider detail',
        started_at: '2026-08-28T01:00:00.500Z', completed_at: null,
      },
    ]);

    const res = await setupApp(fakeD1()).request('/api/automation-runs/run-1');
    expect(res.status).toBe(200);
    const body = await res.json() as {
      data: Record<string, unknown> & { steps: Array<Record<string, unknown>> };
    };
    expect(body.data).toMatchObject({
      versionNumber: 4, isTest: true, canCancel: true, status: 'retry_wait',
    });
    expect(body.data.steps).toEqual([
      {
        stepKey: 'shared', actionType: 'common_action_marker',
        actionLabel: expect.any(String), status: 'success', attemptNumber: 1,
        errorCode: null, errorMessage: null, commonActionVersionId: 'cv-9',
        startedAt: '2026-08-28T01:00:00.000Z', completedAt: '2026-08-28T01:00:00.500Z',
      },
      {
        stepKey: 'send', actionType: 'send_message',
        actionLabel: expect.any(String), status: 'failed', attemptNumber: 3,
        errorCode: 'line_api_error',
        // 生のerror_messageではなく画面と同じ言い方に揃える。
        errorMessage: 'LINEへの送信を完了できませんでした',
        commonActionVersionId: null,
        startedAt: '2026-08-28T01:00:00.500Z', completedAt: null,
      },
    ]);
    // 友だちの情報を含みうる入力・出力は出さない。
    for (const step of body.data.steps) {
      expect(Object.keys(step).sort()).toEqual([
        'actionLabel', 'actionType', 'attemptNumber', 'commonActionVersionId',
        'completedAt', 'errorCode', 'errorMessage', 'startedAt', 'status', 'stepKey',
      ]);
    }
    expect(dbMocks.getAutomationExecutionRun).toHaveBeenCalledWith(expect.anything(), {
      runId: 'run-1', allowedAccountIds: ['acc-1', 'acc-2'],
    });
  });

  test('見えない・無い実行は404、権限キーのないstaffは403', async () => {
    dbMocks.getAutomationExecutionRun.mockResolvedValue(null);
    const missing = await setupApp(fakeD1()).request('/api/automation-runs/run-9');
    expect(missing.status).toBe(404);
    const denied = await setupApp(fakeD1(), STAFF_WITHOUT_KEY)
      .request('/api/automation-runs/run-1');
    expect(denied.status).toBe(403);
    expect(dbMocks.getAutomationExecutionRun).toHaveBeenCalledTimes(1);
  });
});

describe('CSV書き出し（#942 N-353）', () => {
  test('絞り込み全体をCSVで返し、値は必ず囲んで引用符を重ねる', async () => {
    dbMocks.getAutomationExecutionRuns.mockResolvedValue({
      rows: [
        runRow({
          automation_name: '初回, "特別" 案内',
          friend_name: '改行\n含む',
          is_test: 1,
        }),
        runRow({ id: 'run-2', status: 'cancelled', friend_name: null, detail: null }),
      ],
      total: 2,
      summary: { total: 2, executed: 1, skipped: 0, failed: 0, most_run_name: '初回案内', most_run_count: 1 },
    });

    const res = await setupApp(fakeD1())
      .request('/api/automation-runs?lineAccountId=acc-1&format=csv');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('Content-Disposition')).toContain('automation-runs.csv');
    // Excelで日本語が化けない先頭の目印（BOM）は生のバイト列で確かめる
    // （Response.text はUTF-8のBOMを読み飛ばすため）。
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xEF, 0xBB, 0xBF]);
    const lines = new TextDecoder().decode(bytes.subarray(3)).split('\r\n');
    expect(lines[0]).toBe(
      '"実行日時","LINE公式アカウント","オートメーション","版","対象","きっかけ","状態","処理結果","テスト実行","所要時間(ミリ秒)","実行ID"',
    );
    expect(lines[1]).toContain('"初回, ""特別"" 案内"');
    expect(lines[1]).toContain('"v3"');
    expect(lines[1]).toContain('"テスト"');
    expect(lines[1]).toContain('"改行\n含む"');
    expect(lines[2]).toContain('"取消"');
    // CSVは画面の1頁ではなく絞り込み全体を出す。
    expect(dbMocks.getAutomationExecutionRuns).toHaveBeenCalledWith(expect.anything(),
      expect.objectContaining({ limit: 5000, offset: 0 }));
  });

  test('= + - @ で始まる値は引用符を前置し、Excelの数式として実行させない', async () => {
    // 友だち表示名・自動化名・アカウント名は外部入力。表計算ソフトで開いたとき
    // 数式として実行されないよう、common-actionsのCSVと同じ対策を固定する。
    dbMocks.getAutomationExecutionRuns.mockResolvedValue({
      rows: [runRow({
        automation_name: '=1+1',
        friend_name: '+SUM(1,2)',
        account_name: '-cmd',
      })],
      total: 1,
      summary: { total: 1, executed: 1, skipped: 0, failed: 0, most_run_name: null, most_run_count: null },
    });

    const res = await setupApp(fakeD1())
      .request('/api/automation-runs?lineAccountId=acc-1&format=csv');
    expect(res.status).toBe(200);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const lines = new TextDecoder().decode(bytes.subarray(3)).split('\r\n');
    expect(lines[1]).toContain(`"'=1+1"`);
    expect(lines[1]).toContain(`"'+SUM(1,2)"`);
    expect(lines[1]).toContain(`"'-cmd"`);
    // 数式そのままのセルが残っていないこと。
    expect(lines[1]).not.toContain('"=1+1"');
  });

  test('権限キーのないstaffは403', async () => {
    const res = await setupApp(fakeD1(), STAFF_WITHOUT_KEY)
      .request('/api/automation-runs?lineAccountId=acc-1&format=csv');
    expect(res.status).toBe(403);
    expect(dbMocks.getAutomationExecutionRuns).not.toHaveBeenCalled();
  });

  /*
   *  / §9: CSV書き出しは個別権限 `automation.run.export`。
   * 見るだけ（/automations）では出せず、export キーで出せる。
   */
  test('見るだけの権限ではCSVを出せず、書き出し権限のstaffは出せる', async () => {
    const denied = await setupApp(fakeD1(), STAFF_WITH_KEY)
      .request('/api/automation-runs?lineAccountId=acc-1&format=csv');
    expect(denied.status).toBe(403);
    expect(dbMocks.getAutomationExecutionRuns).not.toHaveBeenCalled();

    dbMocks.getAutomationExecutionRuns.mockResolvedValue({
      rows: [],
      total: 0,
      summary: { total: 0, executed: 0, skipped: 0, failed: 0, most_run_name: null, most_run_count: null },
    });
    const allowed = await setupApp(fakeD1(), STAFF_WITH_EXPORT_KEY)
      .request('/api/automation-runs?lineAccountId=acc-1&format=csv');
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get('Content-Type')).toBe('text/csv; charset=utf-8');
  });

  test('R495: 上限で切れたら総件数・出力件数・切れた印を頭に載せる', async () => {
    // 総件数5,001件・出力5,000件の境界を、行の数ではなく頭の数で見る。
    dbMocks.getAutomationExecutionRuns.mockResolvedValue({
      rows: [runRow({ id: 'run-1' }), runRow({ id: 'run-2' })],
      total: 5001,
      summary: { total: 5001, executed: 5001, skipped: 0, failed: 0, most_run_name: '予約案内', most_run_count: 5001 },
    });
    const res = await setupApp(fakeD1(), STAFF_WITH_EXPORT_KEY)
      .request('/api/automation-runs?lineAccountId=acc-1&format=csv');
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Csv-Total-Count')).toBe('5001');
    expect(res.headers.get('X-Csv-Returned-Count')).toBe('2');
    expect(res.headers.get('X-Csv-Truncated')).toBe('1');
  });

  test('R495: 切れていないときは切れた印を立てない', async () => {
    dbMocks.getAutomationExecutionRuns.mockResolvedValue({
      rows: [runRow({ id: 'run-1' })],
      total: 1,
      summary: { total: 1, executed: 1, skipped: 0, failed: 0, most_run_name: '予約案内', most_run_count: 1 },
    });
    const res = await setupApp(fakeD1(), STAFF_WITH_EXPORT_KEY)
      .request('/api/automation-runs?lineAccountId=acc-1&format=csv');
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Csv-Total-Count')).toBe('1');
    expect(res.headers.get('X-Csv-Returned-Count')).toBe('1');
    expect(res.headers.get('X-Csv-Truncated')).toBe('0');
  });
});

/*
 * 以下は本物のSQLiteへ向ける直接試験。実行の取りやめと定義の編集・
 * 複製・状態切替はサービス層がD1へSQLを書くため、モックではなく
 * 実スキーマの行を見て固定する。
 */
function realAutomationDb(): SqliteD1 {
  const testDb = createTestD1();
  testDb.raw.prepare(
    `INSERT INTO line_accounts
       (id, channel_id, name, channel_access_token, channel_secret, is_active)
     VALUES ('acc-1', 'ch-1', '本店', '', '', 1)`,
  ).run();
  testDb.raw.prepare(
    `INSERT INTO automation_definitions
       (id, line_account_id, name, status, current_published_version_id)
     VALUES ('auto-1', 'acc-1', '予約案内', 'active', 'ver-1')`,
  ).run();
  testDb.raw.prepare(
    `INSERT INTO automation_versions
       (id, automation_id, version_number, status, trigger_type, trigger_config,
        action_config, published_at)
     VALUES ('ver-1', 'auto-1', 1, 'published', 'friend_add', '{}',
             '[{"id":"step-1","type":"add_tag","params":{"tagId":"tag-1"},"onFailure":"stop"}]',
             '2026-08-28T00:00:00.000Z')`,
  ).run();
  return testDb;
}

function addRun(raw: SqliteD1['raw'], input: { id: string; status: string }): void {
  raw.prepare(
    `INSERT INTO automation_runs
       (id, line_account_id, automation_id, automation_version_id, source_event_id,
        idempotency_key, status, input_event_json, created_at)
     VALUES (?, 'acc-1', 'auto-1', 'ver-1', ?, ?, ?, '{}', '2026-08-28T01:00:00.000Z')`,
  ).run(input.id, `event-${input.id}`, `key-${input.id}`, input.status);
}

describe('POST /api/automation-runs/:id/cancel（#942 N-353）', () => {
  test('待機中の実行を取りやめ、残りの処理も取消で閉じる', async () => {
    const testDb = realAutomationDb();
    addRun(testDb.raw, { id: 'run-1', status: 'queued' });
    testDb.raw.prepare(
      `INSERT INTO automation_run_steps
         (id, automation_run_id, step_key, action_type, idempotency_key, status)
       VALUES ('s1', 'run-1', 'step-1', 'add_tag', 's1', 'queued')`,
    ).run();

    const res = await setupApp(testDb.db).request('/api/automation-runs/run-1/cancel', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { status: string; alreadyCancelled: boolean } };
    expect(body.data).toMatchObject({ status: 'cancelled', alreadyCancelled: false });
    expect(testDb.raw.prepare(
      `SELECT status FROM automation_runs WHERE id = 'run-1'`,
    ).get()).toEqual({ status: 'cancelled' });
    expect(testDb.raw.prepare(
      `SELECT status FROM automation_run_steps WHERE id = 's1'`,
    ).get()).toEqual({ status: 'cancelled' });
  });

  test('終わった実行は409、取消済みはそのまま200、無い実行は404', async () => {
    const testDb = realAutomationDb();
    addRun(testDb.raw, { id: 'run-done', status: 'success' });
    addRun(testDb.raw, { id: 'run-cancelled', status: 'cancelled' });
    const app = setupApp(testDb.db);

    const done = await app.request('/api/automation-runs/run-done/cancel', { method: 'POST' });
    expect(done.status).toBe(409);
    const cancelled = await app.request('/api/automation-runs/run-cancelled/cancel', { method: 'POST' });
    expect(cancelled.status).toBe(200);
    const missing = await app.request('/api/automation-runs/no-such/cancel', { method: 'POST' });
    expect(missing.status).toBe(404);
  });

  test('権限キーのないstaffは403、持つstaffは取りやめられる', async () => {
    const testDb = realAutomationDb();
    addRun(testDb.raw, { id: 'run-1', status: 'waiting' });
    addRun(testDb.raw, { id: 'run-2', status: 'waiting' });
    const denied = await setupApp(testDb.db, STAFF_WITHOUT_KEY)
      .request('/api/automation-runs/run-1/cancel', { method: 'POST' });
    expect(denied.status).toBe(403);
    //  / §9: 取り消しは automation.run.retry の個別権限。
    // 見るだけの権限（/automations）では取りやめられない。
    const viewOnly = await setupApp(testDb.db, STAFF_WITH_KEY)
      .request('/api/automation-runs/run-1/cancel', { method: 'POST' });
    expect(viewOnly.status).toBe(403);
    const allowed = await setupApp(testDb.db, STAFF_WITH_RETRY_KEY)
      .request('/api/automation-runs/run-2/cancel', { method: 'POST' });
    expect(allowed.status).toBe(200);
  });
});

describe('POST /api/automations/:id/draft・duplicate・status（#942 N-352）', () => {
  test('「編集」は公開版を写した改訂用下書きをぶら下げ、再押しは同じ下書きを返す', async () => {
    const testDb = realAutomationDb();
    const app = setupApp(testDb.db);

    const first = await app.request('/api/automations/auto-1/draft', { method: 'POST' });
    expect(first.status).toBe(201);
    const firstBody = await first.json() as { data: { id: string; draftVersionId: string } };
    expect(firstBody.data.id).toBe('auto-1');

    const second = await app.request('/api/automations/auto-1/draft', { method: 'POST' });
    const secondBody = await second.json() as { data: { draftVersionId: string } };
    expect(secondBody.data.draftVersionId).toBe(firstBody.data.draftVersionId);
    expect(testDb.raw.prepare(
      `SELECT COUNT(*) AS count FROM automation_versions WHERE automation_id = 'auto-1'`,
    ).get()).toEqual({ count: 2 });
  });

  test('「複製」は「のコピー」の新しい下書きを作り、共通アクションの束も写す', async () => {
    const testDb = realAutomationDb();
    testDb.raw.prepare(
      `INSERT INTO common_actions (id, line_account_id, name, status)
       VALUES ('ca-1', 'acc-1', '共通処理', 'published')`,
    ).run();
    testDb.raw.prepare(
      `INSERT INTO common_action_versions
         (id, common_action_id, version_number, status, action_config, published_at)
       VALUES ('cv-1', 'ca-1', 1, 'published', '[]', '2026-08-28T00:00:00.000Z')`,
    ).run();
    testDb.raw.prepare(
      `INSERT INTO common_action_bindings
         (id, line_account_id, common_action_id, common_action_version_id,
          consumer_type, consumer_id, consumer_path)
       VALUES ('bind-1', 'acc-1', 'ca-1', 'cv-1', 'automation', 'auto-1', 'step-1'),
              ('bind-2', 'acc-1', 'ca-1', 'cv-1', 'automation', 'auto-1', 'step-2')`,
    ).run();

    const res = await setupApp(testDb.db).request('/api/automations/auto-1/duplicate', { method: 'POST' });
    expect(res.status).toBe(201);
    const body = await res.json() as { data: { id: string } };
    expect(body.data.id).not.toBe('auto-1');
    expect(testDb.raw.prepare(
      `SELECT name, status FROM automation_definitions WHERE id = ?`,
    ).get(body.data.id)).toEqual({ name: '予約案内 のコピー', status: 'draft' });
    // 束が2件あっても500にならず、新しい定義へ1件ずつ一意のidで写る。
    const bindings = testDb.raw.prepare(
      `SELECT id, consumer_id, common_action_version_id, consumer_path
         FROM common_action_bindings
        WHERE consumer_type = 'automation' AND consumer_id = ?
        ORDER BY consumer_path`,
    ).all(body.data.id) as Array<{
      id: string; consumer_id: string; common_action_version_id: string; consumer_path: string;
    }>;
    expect(bindings).toEqual([
      { id: expect.any(String), consumer_id: body.data.id,
        common_action_version_id: 'cv-1', consumer_path: 'step-1' },
      { id: expect.any(String), consumer_id: body.data.id,
        common_action_version_id: 'cv-1', consumer_path: 'step-2' },
    ]);
    expect(new Set(bindings.map((row) => row.id)).size).toBe(2);
  });

  test('古い確認版は409と現在の状態を返し、一致版と旧呼び出しは通る', async () => {
    const db = realAutomationDb();
    const app = setupApp(db.db);
    const change = (status: string, expectedConfirmationRevision?: number) => app.request('/api/automations/auto-1/status', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status, expectedConfirmationRevision }),
    });
    const stale = await change('stopped', 2);
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({ current: { status: 'active', confirmationRevision: 1 } });
    expect((await change('stopped', 1)).status).toBe(200);
    expect((await change('archived')).status).toBe(200);
  });

  test('「保管」は一方通行。戻す依頼は422、変な状態名は400', async () => {
    const testDb = realAutomationDb();
    const app = setupApp(testDb.db);

    const archived = await app.request('/api/automations/auto-1/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'archived' }),
    });
    expect(archived.status).toBe(200);
    expect(testDb.raw.prepare(
      `SELECT status FROM automation_definitions WHERE id = 'auto-1'`,
    ).get()).toEqual({ status: 'archived' });

    const restore = await app.request('/api/automations/auto-1/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'active' }),
    });
    expect(restore.status).toBe(422);
    const bad = await app.request('/api/automations/auto-1/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'paused' }),
    });
    expect(bad.status).toBe(400);
  });

  test('見えない・無い定義は404、権限キーのないstaffは403', async () => {
    const testDb = realAutomationDb();
    testDb.raw.prepare(
      `INSERT INTO automation_definitions
         (id, line_account_id, name, status)
       VALUES ('auto-outside', 'acc-outside', '見えない店', 'active')`,
    ).run();
    const app = setupApp(testDb.db);

    const outside = await app.request('/api/automations/auto-outside/draft', { method: 'POST' });
    expect(outside.status).toBe(404);
    const missing = await app.request('/api/automations/no-such/duplicate', { method: 'POST' });
    expect(missing.status).toBe(404);

    const deniedDraft = await setupApp(testDb.db, STAFF_WITHOUT_KEY)
      .request('/api/automations/auto-1/draft', { method: 'POST' });
    expect(deniedDraft.status).toBe(403);
    const deniedStatus = await setupApp(testDb.db, STAFF_WITHOUT_KEY)
      .request('/api/automations/auto-1/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'stopped' }),
      });
    expect(deniedStatus.status).toBe(403);
  });

  /*
   * 停止中・下書き・稼働中のどの状態でも、同じ定義 ID から編集へ進めることを確かめる。
   */
  test('止めているルールの「編集」も同じidの下書きを返し、状態は止めたまま', async () => {
    const testDb = realAutomationDb();
    testDb.raw.prepare(
      `UPDATE automation_definitions SET status = 'stopped' WHERE id = 'auto-1'`,
    ).run();
    const app = setupApp(testDb.db);

    const res = await app.request('/api/automations/auto-1/draft', { method: 'POST' });
    expect(res.status).toBe(201);
    const body = await res.json() as { data: { id: string; draftVersionId: string } };
    expect(body.data.id).toBe('auto-1');

    // そのまま下書きの編集面が開ける（同じidで読める）。
    const draft = await app.request('/api/automation-drafts/auto-1?account_id=acc-1');
    expect(draft.status).toBe(200);
    await expect(draft.json()).resolves.toMatchObject({
      success: true,
      data: { id: 'auto-1', draftVersionId: body.data.draftVersionId },
    });
    // 稼働状態・公開版・実行記録は変わっていない。
    expect(testDb.raw.prepare(
      `SELECT status, current_published_version_id FROM automation_definitions WHERE id = 'auto-1'`,
    ).get()).toEqual({ status: 'stopped', current_published_version_id: 'ver-1' });
    expect(testDb.raw.prepare(
      `SELECT COUNT(*) AS count FROM automation_runs`,
    ).get()).toEqual({ count: 0 });
  });

  test('下書きの指し先が壊れたルールも、公開版から作り直して編集できる', async () => {
    const testDb = realAutomationDb();
    testDb.raw.prepare(
      `UPDATE automation_definitions
          SET status = 'stopped', current_draft_version_id = 'ver-1' WHERE id = 'auto-1'`,
    ).run();
    const app = setupApp(testDb.db);

    const res = await app.request('/api/automations/auto-1/draft', { method: 'POST' });
    expect(res.status).toBe(201);
    const body = await res.json() as { data: { id: string } };
    expect(body.data.id).toBe('auto-1');

    // 指し先は公開版を写した新しい下書き版へ治っている。
    const definition = testDb.raw.prepare(
      `SELECT status, current_draft_version_id, current_published_version_id
         FROM automation_definitions WHERE id = 'auto-1'`,
    ).get() as {
      status: string;
      current_draft_version_id: string;
      current_published_version_id: string;
    };
    expect(definition.status).toBe('stopped');
    expect(definition.current_published_version_id).toBe('ver-1');
    expect(definition.current_draft_version_id).not.toBe('ver-1');

    const draft = await app.request('/api/automation-drafts/auto-1?account_id=acc-1');
    expect(draft.status).toBe(200);
  });

  test('下書きのルールの「編集」は、ぶら下がっている下書きをそのまま返す', async () => {
    const testDb = realAutomationDb();
    testDb.raw.prepare(
      `INSERT INTO automation_definitions
         (id, line_account_id, name, status, current_draft_version_id)
       VALUES ('draft-1', 'acc-1', '作りかけ', 'draft', 'dv-1')`,
    ).run();
    testDb.raw.prepare(
      `INSERT INTO automation_versions
         (id, automation_id, version_number, status, trigger_type, trigger_config,
          condition_config, action_config)
       VALUES ('dv-1', 'draft-1', 1, 'draft', 'friend_add', '{}', '{}', '[]')`,
    ).run();
    const app = setupApp(testDb.db);

    const res = await app.request('/api/automations/draft-1/draft', { method: 'POST' });
    expect(res.status).toBe(201);
    const body = await res.json() as { data: { id: string } };
    expect(body.data.id).toBe('draft-1');
    expect(testDb.raw.prepare(
      `SELECT COUNT(*) AS count FROM automation_versions WHERE automation_id = 'draft-1'`,
    ).get()).toEqual({ count: 1 });
  });
});
