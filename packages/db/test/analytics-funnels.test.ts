import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { asD1 } from './d1-test-helper.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureAnalyticsEventCoverage, recordAnalyticsEvent } from '../src/analytics-events.js';
import {
  createFunnelResultAudience,
  createFunnelVersion,
  createVersionedFunnel,
  evaluateChronologicalFunnel,
  getFunnelWithCurrentVersion,
  getLatestFunnelRun,
  getCurrentFunnelVersion,
  getFunnelsWithCurrentVersions,
  runChronologicalFunnel,
  setFunnelStatus,
  validateFunnelComparisonGroups,
  validateV6FunnelSteps,
  type FunnelTimelineEvent,
  type V6FunnelStep,
} from '../src/analytics-funnels.js';
import { getLegacyFunnels } from '../src/funnels.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const STEPS: V6FunnelStep[] = [
  { stepOrder: 1, label: '友だち追加', kind: 'friend_add', match: {} },
  {
    stepOrder: 2,
    label: 'フォーム回答',
    kind: 'form',
    match: { formId: 'form-1' },
  },
  {
    stepOrder: 3,
    label: '購入',
    kind: 'purchase',
    match: { status: 'confirmed' },
  },
];

function event(
  id: string,
  friendId: string,
  eventType: FunnelTimelineEvent['eventType'],
  occurredAt: string,
  dimensions: FunnelTimelineEvent['dimensions'] = {},
): FunnelTimelineEvent {
  return { id, friendId, eventType, occurredAt, dimensions };
}

describe('時系列ファネルの判定', () => {
  it('前段より後のイベントだけを数え、購入段も実行する', () => {
    const result = evaluateChronologicalFunnel({
      steps: STEPS,
      windowDays: 7,
      cohortFrom: '2026-08-01T00:00:00.000Z',
      cohortTo: '2026-08-02T23:59:59.999Z',
      dataCutoffAt: '2026-08-20T00:00:00.000Z',
      events: [
        // 回答が追加より前なので、friend-a は1段目で止まる。
        event('a-form-before', 'friend-a', 'form_submitted', '2026-08-01T08:00:00.000Z', { formId: 'form-1' }),
        event('a-add', 'friend-a', 'friend_add', '2026-08-01T09:00:00.000Z'),
        event('b-add', 'friend-b', 'friend_add', '2026-08-01T09:00:00.000Z'),
        event('b-form', 'friend-b', 'form_submitted', '2026-08-01T10:00:00.000Z', { formId: 'form-1' }),
        event('b-buy', 'friend-b', 'ec.order.confirmed', '2026-08-01T12:00:00.000Z'),
        // 同じ元IDは再配達として1回だけ扱う。
        event('b-buy', 'friend-b', 'ec.order.confirmed', '2026-08-01T12:00:00.000Z'),
      ],
    });

    expect(result.groups[0].steps.map((step) => step.reached)).toEqual([2, 1, 1]);
    expect(result.groups[0].completed).toBe(1);
    expect(result.members.find((member) => member.friendId === 'friend-a')).toMatchObject({
      highestStepOrder: 1,
      state: 'dropped',
    });
  });

  it('判定期限前は途中、期限後だけを離脱にする', () => {
    const result = evaluateChronologicalFunnel({
      steps: STEPS.slice(0, 2),
      windowDays: 7,
      cohortFrom: '2026-08-01T00:00:00.000Z',
      cohortTo: '2026-08-08T23:59:59.999Z',
      dataCutoffAt: '2026-08-10T00:00:00.000Z',
      events: [
        event('old', 'friend-old', 'friend_add', '2026-08-01T00:00:00.000Z'),
        event('recent', 'friend-recent', 'friend_add', '2026-08-08T00:00:00.000Z'),
      ],
    });

    expect(result.groups[0].steps[0]).toMatchObject({
      reached: 2,
      droppedAfter: 1,
      inProgressAfter: 1,
    });
  });

  it('段への平均・中央値到達時間を前段から計算する', () => {
    const result = evaluateChronologicalFunnel({
      steps: STEPS.slice(0, 2),
      windowDays: 7,
      cohortFrom: '2026-08-01T00:00:00.000Z',
      cohortTo: '2026-08-01T23:59:59.999Z',
      dataCutoffAt: '2026-08-20T00:00:00.000Z',
      events: [
        event('a1', 'a', 'friend_add', '2026-08-01T00:00:00.000Z'),
        event('a2', 'a', 'form_submitted', '2026-08-01T01:00:00.000Z', { formId: 'form-1' }),
        event('b1', 'b', 'friend_add', '2026-08-01T00:00:00.000Z'),
        event('b2', 'b', 'form_submitted', '2026-08-01T03:00:00.000Z', { formId: 'form-1' }),
      ],
    });
    expect(result.groups[0].steps[1]).toMatchObject({
      averageSecondsFromPrevious: 7200,
      medianSecondsFromPrevious: 7200,
    });
  });

  it('未知の段と比較4群を0人にせず拒否する', () => {
    expect(() => validateV6FunnelSteps([
      { label: '追加', kind: 'friend_add', match: {} },
      { label: '不明', kind: 'fortune', match: {} },
    ])).toThrow('analytics_funnel_step_kind_unknown:fortune');
    expect(() => validateFunnelComparisonGroups(Array.from({ length: 4 }, (_, index) => ({
      key: `g${index}`, label: `群${index}`, filter: { kind: 'all' },
    })))).toThrow('analytics_funnel_comparison_groups_max_3');
  });
});

describe('ファネルの版・結果・一時対象者', () => {
  let sqlite: Database.Database;
  let db: D1Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec(readFileSync(join(ROOT, 'bootstrap.sql'), 'utf8'));
    sqlite.prepare(
      `INSERT INTO line_accounts (
         id, channel_id, name, channel_access_token, channel_secret, timezone
       ) VALUES ('account-a', 'channel-a', 'A', 'token-a', 'secret-a', 'Asia/Tokyo'),
                ('account-b', 'channel-b', 'B', 'token-b', 'secret-b', 'Asia/Tokyo')`,
    ).run();
    sqlite.prepare(
      `INSERT INTO friends (id, line_user_id, line_account_id)
       VALUES ('friend-a', 'Ua', 'account-a'), ('friend-b', 'Ub', 'account-b')`,
    ).run();
    sqlite.prepare(
      `INSERT INTO forms (id, name, fields) VALUES ('form-1', '申込', '[]')`,
    ).run();
    // 未割当legacyの参照は拒否が正本。STEPSで使うform-1はaccount-aへ割当てる。
    sqlite.prepare(
      `INSERT INTO form_accounts (form_id, line_account_id) VALUES ('form-1', 'account-a')`,
    ).run();
    db = asD1(sqlite);
  });

  afterEach(() => sqlite.close());

  it('の版付き定義を現行画面の一覧へ混ぜない', async () => {
    sqlite.prepare(
      `INSERT INTO funnels (id, line_account_id, name, segment_json, window_days, created_at)
       VALUES ('legacy-1', 'account-a', '現行ファネル', NULL, 30, '2026-08-01T00:00:00.000Z')`,
    ).run();
    await createVersionedFunnel(db, {
      lineAccountId: 'account-a', name: 'V6ファネル', windowDays: 7,
      steps: STEPS, createdAt: '2026-08-02T00:00:00.000Z',
    });

    const items = await getLegacyFunnels(db, 'account-a');
    expect(items.map((item) => item.id)).toEqual(['legacy-1']);
  });

  it('205件のファネルと現在版を件数に関係なく2問い合わせでページ取得する', async () => {
    const insertFunnel = sqlite.prepare(
      `INSERT INTO funnels (id, line_account_id, name, segment_json, window_days, created_at)
       VALUES (?, 'account-a', ?, NULL, 30, ?)`,
    );
    const insertVersion = sqlite.prepare(
      `INSERT INTO analytics_funnel_versions (
         id, funnel_id, line_account_id, version_number, window_days,
         steps_json, segment_json, comparison_groups_json, created_at
       ) VALUES (?, ?, 'account-a', ?, 30, '[]', NULL, '[]', ?)`,
    );
    sqlite.transaction(() => {
      for (let index = 1; index <= 205; index += 1) {
        const id = `funnel-${String(index).padStart(3, '0')}`;
        const createdAt = `2026-08-${String(Math.ceil(index / 10)).padStart(2, '0')}T00:00:00.000Z`;
        insertFunnel.run(id, `ファネル${index}`, createdAt);
        insertVersion.run(`${id}-v1`, id, 1, createdAt);
        if (index === 205) insertVersion.run(`${id}-v2`, id, 2, '2026-09-01T00:00:00.000Z');
      }
    })();

    let queryCount = 0;
    const measuredDb = {
      ...db,
      prepare(query: string) {
        queryCount += 1;
        return db.prepare(query);
      },
    } as D1Database;

    const first = await getFunnelsWithCurrentVersions(
      measuredDb, 'account-a', { page: 1, pageSize: 200 },
    );
    expect(first).toMatchObject({ total: 205, page: 1, pageSize: 200 });
    expect(first.items).toHaveLength(200);
    expect(first.items[0]).toMatchObject({
      id: 'funnel-205', currentVersion: { id: 'funnel-205-v2', versionNumber: 2 },
    });
    expect(queryCount).toBe(2);

    queryCount = 0;
    const second = await getFunnelsWithCurrentVersions(
      measuredDb, 'account-a', { page: 2, pageSize: 200 },
    );
    expect(second.items).toHaveLength(5);
    expect(queryCount).toBe(2);
  });

  it('一覧と現在版をLINEアカウント内に閉じ、版がない既存ファネルはnullで返す', async () => {
    sqlite.exec(`
      INSERT INTO funnels (id, line_account_id, name, segment_json, window_days, created_at)
      VALUES ('legacy-a', 'account-a', 'Aの既存ファネル', NULL, 30, '2026-08-01T00:00:00.000Z'),
             ('versioned-b', 'account-b', 'Bの版付きファネル', NULL, 30, '2026-08-02T00:00:00.000Z');
      INSERT INTO analytics_funnel_versions (
        id, funnel_id, line_account_id, version_number, window_days,
        steps_json, segment_json, comparison_groups_json, created_at
      ) VALUES (
        'versioned-b-v1', 'versioned-b', 'account-b', 1, 30,
        '[]', NULL, '[]', '2026-08-02T00:00:00.000Z'
      );
    `);

    const accountA = await getFunnelsWithCurrentVersions(db, 'account-a');
    expect(accountA.total).toBe(1);
    expect(accountA.items).toEqual([
      expect.objectContaining({ id: 'legacy-a', currentVersion: null }),
    ]);

    const accountB = await getFunnelsWithCurrentVersions(db, 'account-b');
    expect(accountB.total).toBe(1);
    expect(accountB.items).toEqual([
      expect.objectContaining({
        id: 'versioned-b',
        currentVersion: { id: 'versioned-b-v1', versionNumber: 1, createdAt: '2026-08-02T00:00:00.000Z' },
      }),
    ]);
  });

  it('公開済み版を変えずに新版を作り、結果と対象者をアカウント内へ固定する', async () => {
    const created = await createVersionedFunnel(db, {
      lineAccountId: 'account-a',
      name: '購入まで',
      windowDays: 7,
      steps: STEPS,
      createdBy: 'staff-1',
      createdAt: '2026-08-01T00:00:00.000Z',
    });
    await createFunnelVersion(db, {
      lineAccountId: 'account-a',
      funnelId: created.funnelId,
      windowDays: 14,
      steps: STEPS.slice(0, 2),
      createdBy: 'staff-1',
      createdAt: '2026-08-02T00:00:00.000Z',
    });
    const versions = sqlite.prepare(
      `SELECT version_number, window_days, json_array_length(steps_json) AS steps
         FROM analytics_funnel_versions ORDER BY version_number`,
    ).all();
    expect(versions).toEqual([
      { version_number: 1, window_days: 7, steps: 3 },
      { version_number: 2, window_days: 14, steps: 2 },
    ]);
    expect((await getCurrentFunnelVersion(db, 'account-a', created.funnelId))?.versionNumber)
      .toBe(2);
    expect(() => sqlite.prepare(
      `UPDATE analytics_funnel_versions SET window_days = 1 WHERE version_number = 1`,
    ).run()).toThrow('analytics_funnel_version_immutable');

    await recordAnalyticsEvent(db, {
      lineAccountId: 'account-a', friendId: 'friend-a', eventType: 'friend_add',
      sourceKind: 'test', sourceId: 'a-add', occurredAt: '2026-08-03T00:00:00.000Z',
    });
    await recordAnalyticsEvent(db, {
      lineAccountId: 'account-a', friendId: 'friend-a', eventType: 'form_submitted',
      sourceKind: 'test', sourceId: 'a-form', occurredAt: '2026-08-03T01:00:00.000Z',
      dimensions: { formId: 'form-1' },
    });
    await recordAnalyticsEvent(db, {
      lineAccountId: 'account-b', friendId: 'friend-b', eventType: 'friend_add',
      sourceKind: 'test', sourceId: 'b-add', occurredAt: '2026-08-03T00:00:00.000Z',
    });
    await ensureAnalyticsEventCoverage(db, {
      lineAccountId: 'account-a',
      eventTypes: ['friend_add', 'form_submitted'],
      availableFrom: '2026-08-03T00:00:00.000Z',
    });

    const run = await runChronologicalFunnel(db, {
      lineAccountId: 'account-a',
      funnelId: created.funnelId,
      cohortFrom: '2026-08-03T00:00:00.000Z',
      cohortTo: '2026-08-03T00:30:00.000Z',
      dataCutoffAt: '2026-08-20T00:00:00.000Z',
      timeZone: 'Asia/Tokyo',
      createdBy: 'staff-1',
      persist: true,
    });
    expect(run).toMatchObject({ state: 'available', versionNumber: 2 });
    expect(run.groups[0].steps.map((step) => step.reached)).toEqual([1, 1]);
    expect(await getLatestFunnelRun(db, 'account-a', created.funnelId)).toMatchObject({
      runId: run.runId,
      state: 'available',
      versionNumber: 2,
    });
    expect(await getLatestFunnelRun(db, 'account-b', created.funnelId)).toBeNull();
    expect(sqlite.prepare(
      `SELECT friend_id FROM analytics_funnel_run_members WHERE run_id = ?`,
    ).all(run.runId)).toEqual([{ friend_id: 'friend-a' }]);

    const audience = await createFunnelResultAudience(db, {
      lineAccountId: 'account-a',
      runId: run.runId!,
      stepOrder: 2,
      selection: 'reached',
      createdBy: 'staff-1',
      now: new Date('2026-08-20T00:00:00.000Z'),
    });
    expect(audience).toMatchObject({ memberCount: 1, expiresAt: '2026-08-21T00:00:00.000Z' });
    expect(sqlite.prepare(
      `SELECT friend_id FROM analytics_result_audience_members WHERE audience_id = ?`,
    ).all(audience.id)).toEqual([{ friend_id: 'friend-a' }]);
    await expect(createFunnelResultAudience(db, {
      lineAccountId: 'account-b', runId: run.runId!, stepOrder: 2,
      selection: 'reached', now: new Date('2026-08-20T00:00:00.000Z'),
    })).rejects.toThrow('analytics_funnel_run_not_found');
    expect(() => sqlite.prepare(
      `UPDATE analytics_funnel_runs SET result_json = '{}' WHERE id = ?`,
    ).run(run.runId)).toThrow('analytics_funnel_run_immutable');
  });

  it('未接続のイベントを0件ではなく取得不可にする', async () => {
    const created = await createVersionedFunnel(db, {
      lineAccountId: 'account-a', name: '購入まで', windowDays: 7,
      steps: [
        { label: '追加', kind: 'friend_add', match: {} },
        { label: '購入', kind: 'purchase', match: { status: 'confirmed' } },
      ],
      createdAt: '2026-08-01T00:00:00.000Z',
    });
    await ensureAnalyticsEventCoverage(db, {
      lineAccountId: 'account-a', eventTypes: ['friend_add'],
      availableFrom: '2026-08-03T00:00:00.000Z',
    });
    const run = await runChronologicalFunnel(db, {
      lineAccountId: 'account-a', funnelId: created.funnelId,
      cohortFrom: '2026-08-03T00:00:00.000Z', cohortTo: '2026-08-03T01:00:00.000Z',
      dataCutoffAt: '2026-08-20T00:00:00.000Z', timeZone: 'Asia/Tokyo',
    });
    expect(run).toMatchObject({
      state: 'unavailable',
      stateReason: expect.stringContaining('ec.order.confirmed'),
    });
  });

  it('別アカウントの参照先を0人扱いにせず拒否する', async () => {
    sqlite.prepare(
      `INSERT INTO conversion_points (id, name, event_type, line_account_id)
       VALUES ('point-b', 'B成果', 'purchase', 'account-b')`,
    ).run();
    await expect(createVersionedFunnel(db, {
      lineAccountId: 'account-a', name: '不正な参照', windowDays: 7,
      steps: [
        { label: '追加', kind: 'friend_add', match: {} },
        { label: '成果', kind: 'conversion', match: { conversionPointId: 'point-b' } },
      ],
      createdAt: '2026-08-01T00:00:00.000Z',
    })).rejects.toThrow('analytics_funnel_reference_missing:2');
  });
});

describe('ファネルの運用状態（停止・保管・編集）', () => {
  let sqlite: Database.Database;
  let db: D1Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec(readFileSync(join(ROOT, 'bootstrap.sql'), 'utf8'));
    sqlite.prepare(
      `INSERT INTO line_accounts (
         id, channel_id, name, channel_access_token, channel_secret, timezone
       ) VALUES ('account-a', 'channel-a', 'A', 'token-a', 'secret-a', 'Asia/Tokyo'),
                ('account-b', 'channel-b', 'B', 'token-b', 'secret-b', 'Asia/Tokyo')`,
    ).run();
    sqlite.prepare(
      `INSERT INTO friends (id, line_user_id, line_account_id)
       VALUES ('friend-a', 'Ua', 'account-a')`,
    ).run();
    sqlite.prepare(
      `INSERT INTO forms (id, name, fields) VALUES ('form-1', '申込', '[]')`,
    ).run();
    sqlite.prepare(
      `INSERT INTO form_accounts (form_id, line_account_id) VALUES ('form-1', 'account-a')`,
    ).run();
    db = asD1(sqlite);
  });

  afterEach(() => sqlite.close());

  async function makeFunnel(name = '購入まで') {
    return createVersionedFunnel(db, {
      lineAccountId: 'account-a', name, windowDays: 7,
      steps: STEPS, createdBy: 'staff-1', createdAt: '2026-08-01T00:00:00.000Z',
    });
  }

  function insertRun(funnelId: string, versionId: string) {
    sqlite.prepare(
      `INSERT INTO analytics_funnel_runs (
         id, line_account_id, funnel_id, funnel_version_id, cohort_from, cohort_to,
         time_zone, data_cutoff_at, state, result_json, created_by, created_at
       ) VALUES (
         'run-1', 'account-a', ?, ?, '2026-08-01T00:00:00.000Z', '2026-08-10T00:00:00.000Z',
         'Asia/Tokyo', '2026-08-10T00:00:00.000Z', 'available',
         '{"groups":[{"key":"all","label":"全体","steps":[{"stepOrder":2,"label":"フォーム回答","reached":1}]}]}',
         'staff-1', '2026-08-10T00:00:00.000Z'
       )`,
    ).run(funnelId, versionId);
    sqlite.prepare(
      `INSERT INTO analytics_funnel_run_members (
         run_id, line_account_id, friend_id, group_key, highest_step_order,
         state, started_at, last_reached_at, deadline_at
       ) VALUES (
         'run-1', 'account-a', 'friend-a', 'all', 2,
         'dropped', '2026-08-01T00:00:00.000Z', '2026-08-02T00:00:00.000Z', '2026-08-09T00:00:00.000Z'
       )`,
    ).run();
  }

  it('一覧は既定でactiveだけ、includeInactiveで停止・保管も状態つきで返す', async () => {
    const first = await makeFunnel('A');
    const second = await makeFunnel('B');
    const third = await makeFunnel('C');
    await setFunnelStatus(db, {
      lineAccountId: 'account-a', funnelId: second.funnelId,
      status: 'stopped', expectedStatus: 'active',
    });
    await setFunnelStatus(db, {
      lineAccountId: 'account-a', funnelId: third.funnelId,
      status: 'archived', expectedStatus: 'active',
    });

    const active = await getFunnelsWithCurrentVersions(db, 'account-a');
    expect(active.total).toBe(1);
    expect(active.items.map((item) => item.id)).toEqual([first.funnelId]);
    expect(active.items[0].status).toBe('active');

    const all = await getFunnelsWithCurrentVersions(db, 'account-a', { includeInactive: true });
    expect(all.total).toBe(3);
    expect(all.items.map((item) => item.status).sort()).toEqual(['active', 'archived', 'stopped']);
  });

  it('確認版の一致・不一致と旧呼び出しを扱い、状態が戻っても古い確認を拒否する', async () => {
    const { funnelId } = await makeFunnel();
    const base = { lineAccountId: 'account-a', funnelId };
    const initial = await getFunnelsWithCurrentVersions(db, 'account-a');
    expect(initial.items[0]).toMatchObject({ confirmation_revision: 1 });
    await setFunnelStatus(db, { ...base, status: 'stopped', expectedStatus: 'active', expectedRevision: 1 } as never);
    await setFunnelStatus(db, { ...base, status: 'active', expectedStatus: 'stopped' });
    await expect(setFunnelStatus(db, { ...base, status: 'stopped', expectedStatus: 'active', expectedRevision: 1 } as never)).rejects.toThrow('analytics_funnel_status_conflict');
    const result = await setFunnelStatus(db, { ...base, status: 'stopped', expectedStatus: 'active', expectedRevision: 3 } as never);
    expect(result).toMatchObject({ status: 'stopped', confirmation_revision: 4 });
  });

  it('状態遷移は現在状態を要し、保管は終端、二重操作は競合になる', async () => {
    const { funnelId } = await makeFunnel();

    await expect(setFunnelStatus(db, {
      lineAccountId: 'account-a', funnelId, status: 'stopped', expectedStatus: 'stopped',
    })).rejects.toThrow('analytics_funnel_status_conflict');

    const stopped = await setFunnelStatus(db, {
      lineAccountId: 'account-a', funnelId, status: 'stopped', expectedStatus: 'active',
    });
    expect(stopped.status).toBe('stopped');

    await expect(setFunnelStatus(db, {
      lineAccountId: 'account-a', funnelId, status: 'stopped', expectedStatus: 'active',
    })).rejects.toThrow('analytics_funnel_status_conflict');

    const resumed = await setFunnelStatus(db, {
      lineAccountId: 'account-a', funnelId, status: 'active', expectedStatus: 'stopped',
    });
    expect(resumed.status).toBe('active');

    await setFunnelStatus(db, {
      lineAccountId: 'account-a', funnelId, status: 'archived', expectedStatus: 'active',
    });
    await expect(setFunnelStatus(db, {
      lineAccountId: 'account-a', funnelId, status: 'active', expectedStatus: 'archived',
    })).rejects.toThrow('analytics_funnel_invalid_transition');

    await expect(setFunnelStatus(db, {
      lineAccountId: 'account-a', funnelId: 'missing', status: 'stopped', expectedStatus: 'active',
    })).rejects.toThrow('analytics_funnel_not_found');
    await expect(setFunnelStatus(db, {
      lineAccountId: 'account-b', funnelId, status: 'stopped', expectedStatus: 'archived',
    })).rejects.toThrow('analytics_funnel_not_found');
  });

  it('停止中は再集計と対象者づくりを拒否し、過去の結果は読める', async () => {
    const created = await makeFunnel();
    insertRun(created.funnelId, created.version.id);
    await setFunnelStatus(db, {
      lineAccountId: 'account-a', funnelId: created.funnelId,
      status: 'stopped', expectedStatus: 'active',
    });

    await expect(runChronologicalFunnel(db, {
      lineAccountId: 'account-a', funnelId: created.funnelId,
      cohortFrom: '2026-08-01T00:00:00.000Z', cohortTo: '2026-08-10T00:00:00.000Z',
      timeZone: 'Asia/Tokyo', dataCutoffAt: '2026-08-10T00:00:00.000Z', persist: true,
    })).rejects.toThrow('analytics_funnel_not_active');

    await expect(createFunnelResultAudience(db, {
      lineAccountId: 'account-a', runId: 'run-1', stepOrder: 2,
      selection: 'stopped', now: new Date('2026-08-11T00:00:00.000Z'),
    })).rejects.toThrow('analytics_funnel_not_active');

    const past = await getLatestFunnelRun(db, 'account-a', created.funnelId);
    expect(past?.runId).toBe('run-1');
  });

  it('停止中は新版を置けず、activeへ戻すと置ける', async () => {
    const created = await makeFunnel();
    await setFunnelStatus(db, {
      lineAccountId: 'account-a', funnelId: created.funnelId,
      status: 'stopped', expectedStatus: 'active',
    });
    await expect(createFunnelVersion(db, {
      lineAccountId: 'account-a', funnelId: created.funnelId,
      windowDays: 14, steps: STEPS, expectedVersionNumber: 1,
      createdAt: '2026-08-02T00:00:00.000Z',
    })).rejects.toThrow('analytics_funnel_not_active');

    await setFunnelStatus(db, {
      lineAccountId: 'account-a', funnelId: created.funnelId,
      status: 'active', expectedStatus: 'stopped',
    });
    const version = await createFunnelVersion(db, {
      lineAccountId: 'account-a', funnelId: created.funnelId,
      windowDays: 14, steps: STEPS, expectedVersionNumber: 1,
      createdAt: '2026-08-02T00:00:00.000Z',
    });
    expect(version.versionNumber).toBe(2);
  });

  it('新版保存は expectedVersionNumber でずれを拒否し、名前を同時に更新できる', async () => {
    const created = await makeFunnel('旧名');

    await expect(createFunnelVersion(db, {
      lineAccountId: 'account-a', funnelId: created.funnelId,
      windowDays: 14, steps: STEPS, expectedVersionNumber: 9,
      createdAt: '2026-08-02T00:00:00.000Z',
    })).rejects.toThrow('analytics_funnel_version_conflict');
    expect(
      (await getCurrentFunnelVersion(db, 'account-a', created.funnelId))!.versionNumber,
    ).toBe(1);

    const saved = await createFunnelVersion(db, {
      lineAccountId: 'account-a', funnelId: created.funnelId,
      windowDays: 30, steps: STEPS.slice(0, 2), name: '新しい名前',
      expectedVersionNumber: 1, createdAt: '2026-08-02T00:00:00.000Z',
    });
    expect(saved.versionNumber).toBe(2);
    const detail = await getFunnelWithCurrentVersion(db, 'account-a', created.funnelId);
    expect(detail?.funnel.name).toBe('新しい名前');
    expect(detail?.currentVersion?.versionNumber).toBe(2);
    expect(detail?.currentVersion?.steps).toHaveLength(2);
    expect(detail?.currentVersion?.windowDays).toBe(30);

    await expect(createFunnelVersion(db, {
      lineAccountId: 'account-a', funnelId: created.funnelId,
      windowDays: 14, steps: STEPS, expectedVersionNumber: 1,
      createdAt: '2026-08-03T00:00:00.000Z',
    })).rejects.toThrow('analytics_funnel_version_conflict');
  });
  it('PKG45: 保存直前の保管が勝ったら新版と名前を一切保存しない', async () => {
    const created = await makeFunnel('Original');
    const batch = db.batch.bind(db); let interleaved = false;
    db.batch = async statements => {
      if (!interleaved) { interleaved=true; sqlite.prepare("UPDATE funnels SET status='archived' WHERE id=?").run(created.funnelId); }
      return batch(statements);
    };
    await expect(createFunnelVersion(db,{ lineAccountId: 'account-a', funnelId: created.funnelId,
      windowDays: 14, steps: STEPS, name: 'Stale', expectedVersionNumber: 1, createdAt: '2026-08-02T00:00:00Z' }))
      .rejects.toThrow('analytics_funnel_not_active');
    expect(sqlite.prepare('SELECT status,name FROM funnels WHERE id=?').get(created.funnelId)).toEqual({ status: 'archived', name: 'Original' });
    expect(sqlite.prepare('SELECT COUNT(*) n FROM analytics_funnel_versions WHERE funnel_id=?').get(created.funnelId)).toEqual({ n: 1 });
  });

});
