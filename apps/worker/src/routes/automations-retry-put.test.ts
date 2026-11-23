import { beforeEach, describe, expect, test } from 'vitest';
import { Hono } from 'hono';
import type { AuthenticatedStaff } from '../middleware/auth/principal/auth.js';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';
import {
  AutomationActionError,
  processAutomationRun,
  retryAutomationRun,
  startAutomationRun,
} from '../features/automations/automation-engine.js';
import { automations } from './automations.js';

// 実DBで旧PUTの許可/拒否と再送受け付けを確かめる。dbのからくりは使わない。
function setupApp(db: D1Database) {
  const app = new Hono<{
    Bindings: { DB: D1Database };
    Variables: { staff: AuthenticatedStaff };
  }>();
  app.use('*', async (c, next) => {
    c.env = { DB: db };
    c.set('staff', {
      id: 'staff-1',
      name: 'Staff',
      role: 'owner',
      readOnly: false,
      permissionKeys: [],
      assignedLineAccountId: null,
      canAccessDescendantAccounts: false,
      tenantId: 'tenant-1',
    });
    await next();
  });
  app.route('/', automations);
  return app;
}

function seedAccount(raw: SqliteD1['raw']) {
  raw.prepare(`INSERT OR IGNORE INTO tenants (id, name) VALUES ('tenant-1', '本部')`).run();
  raw.prepare(
    `INSERT INTO line_accounts
       (id, channel_id, name, channel_access_token, channel_secret, is_active, tenant_id)
     VALUES ('acc-1', 'channel-1', '本店', 'token', 'secret', 1, 'tenant-1')`,
  ).run();
}

function seedLegacyAutomation(raw: SqliteD1['raw']) {
  raw.prepare(
    `INSERT INTO automations
       (id, name, event_type, conditions, actions, is_active, priority, line_account_id)
     VALUES ('auto-1', '旧ルール', 'message_received', '{}', '[]', 1, 0, 'acc-1')`,
  ).run();
}

function rowOf(raw: SqliteD1['raw'], id: string) {
  return raw.prepare(
    `SELECT event_type, conditions, actions, is_active FROM automations WHERE id = ?`,
  ).get(id) as { event_type: string; conditions: string; actions: string; is_active: number };
}

describe('自動化の稼働切替だけを受け付け不正な入力を拒否する', () => {
  let testDb: SqliteD1;

  beforeEach(() => {
    testDb = createTestD1();
    seedAccount(testDb.raw);
    seedLegacyAutomation(testDb.raw);
  });

  test('isActiveだけの稼働切替は通り、書き換わる', async () => {
    const off = await setupApp(testDb.db).request('/api/automations/auto-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isActive: false }),
    });
    expect(off.status).toBe(200);
    await expect(off.json()).resolves.toMatchObject({ success: true, data: { id: 'auto-1', isActive: false } });
    expect(rowOf(testDb.raw, 'auto-1').is_active).toBe(0);

    const on = await setupApp(testDb.db).request('/api/automations/auto-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isActive: true }),
    });
    expect(on.status).toBe(200);
    expect(rowOf(testDb.raw, 'auto-1').is_active).toBe(1);
  });

  test.each([
    ['未知キー', { isActive: false, eventType: 'message_received' }],
    ['actions混入', { isActive: false, actions: [] }],
    ['空', {}],
    ['型違い文字', { isActive: 'yes' }],
    ['型違い数値', { isActive: 1 }],
    ['型違いnull', { isActive: null }],
    ['配列', ['isActive']],
  ])('%sは400で拒否し、行を変えない', async (_label, body) => {
    const res = await setupApp(testDb.db).request('/api/automations/auto-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(400);
    expect(rowOf(testDb.raw, 'auto-1')).toEqual({
      event_type: 'message_received', conditions: '{}', actions: '[]', is_active: 1,
    });
  });

  test('壊れたJSONは400で拒否する', async () => {
    const res = await setupApp(testDb.db).request('/api/automations/auto-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json{',
    });
    expect(res.status).toBe(400);
    expect(rowOf(testDb.raw, 'auto-1').is_active).toBe(1);
  });
});

describe('自動化の再試行を受け付けて待機に戻し重複を拒否する', () => {
  let testDb: SqliteD1;

  beforeEach(() => {
    testDb = createTestD1();
    seedAccount(testDb.raw);
    const automationId = 'automation-1';
    const versionId = 'version-1';
    testDb.raw.prepare(
      `INSERT INTO automation_definitions (id, line_account_id, name, status, current_published_version_id)
       VALUES (?, 'acc-1', 'def', 'active', NULL)`,
    ).run(automationId);
    testDb.raw.prepare(
      `INSERT INTO automation_versions
         (id, automation_id, version_number, status, trigger_type, action_config, published_at)
       VALUES (?, ?, 1, 'published', 'friend_add', ?, '2026-09-14T00:00:00.000Z')`,
    ).run(
      versionId, automationId,
      JSON.stringify([{ id: 'step-1', type: 'record', params: {}, onFailure: 'stop' }]),
    );
    testDb.raw.prepare(`UPDATE automation_definitions SET current_published_version_id = ? WHERE id = ?`)
      .run(versionId, automationId);
  });

  async function failedRunId(): Promise<string> {
    const created = await startAutomationRun(testDb.db, {
      lineAccountId: 'acc-1', automationId: 'automation-1', sourceEventId: 'event-1',
      idempotencyKey: 'key-1', friendId: null, inputEvent: { kind: 'friend_add' },
      conditionMatched: true, now: '2026-09-14T00:00:00.000Z',
    });
    if (created.kind !== 'created' || !created.runId) throw new Error('start failed');
    const status = await processAutomationRun(testDb.db, created.runId, {
      now: '2026-09-14T00:00:00.000Z',
      executors: {
        record: async () => {
          throw new AutomationActionError('permanent', '入力を直してください', false);
        },
      },
    });
    expect(status).toBe('failed');
    return created.runId;
  }

  test('1回目は即202でwaitingに戻し、cronが拾える形にする', async () => {
    const runId = await failedRunId();
    const res = await setupApp(testDb.db).request(`/api/automation-runs/${runId}/retry`, { method: 'POST' });
    expect(res.status).toBe(202);
    const body = await res.json() as {
      success: boolean; data: { runId: string; status: string; notice: string };
    };
    expect(body).toMatchObject({
      success: true,
      data: {
        runId, status: 'waiting',
        notice: '再実行を受け付けました。結果は実行記録で確認してください',
      },
    });
    // route内で実行していない: 受け付け準備の waiting のまま残る。
    // 実行していたら success/failed/partial のどれかになり、試行回数も進む。
    expect(testDb.raw.prepare(
      `SELECT status, attempt_number FROM automation_run_steps WHERE automation_run_id = ?`,
    ).get(runId)).toEqual({ status: 'waiting', attempt_number: 1 });
    // cronの拾い対象: waiting かつ resume_at 入り。
    const run = testDb.raw.prepare(
      `SELECT status, resume_at FROM automation_runs WHERE id = ?`,
    ).get(runId) as { status: string; resume_at: string | null };
    expect(run.status).toBe('waiting');
    expect(run.resume_at).not.toBeNull();
  });

  test('2回目は409で止める', async () => {
    const runId = await failedRunId();
    const first = await setupApp(testDb.db).request(`/api/automation-runs/${runId}/retry`, { method: 'POST' });
    expect(first.status).toBe(202);
    const second = await setupApp(testDb.db).request(`/api/automation-runs/${runId}/retry`, { method: 'POST' });
    expect(second.status).toBe(409);
    await expect(second.json()).resolves.toMatchObject({ success: false, code: 'not_retryable' });
    expect(testDb.raw.prepare(`SELECT status FROM automation_runs WHERE id = ?`).get(runId))
      .toEqual({ status: 'waiting' });
  });
});
