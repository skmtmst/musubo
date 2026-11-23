import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getFriendBulkRunDetail, publishScenarioVersion } from '@line-crm/db';
import type { FriendBulkOperation } from '@line-crm/shared';
import { createTestD1, insertFriend, type SqliteD1 } from '../../test-utils/d1-sqlite.js';
import { createFriendBulkUndoRun, startFriendBulkRun, processFriendBulkRun } from './friend-bulk-runs.js';

const actor = { id: 'actor', name: '試験担当', role: 'owner' as const, readOnly: false, tenantId: 'default' };
const NOW = '2026-10-02T00:00:00.000Z';

describe('一括操作の追加分の実行と結果件数', () => {
  let testDb: SqliteD1;
  beforeEach(async () => {
    testDb = createTestD1();
    testDb.raw.exec("INSERT OR IGNORE INTO tenants(id,name) VALUES ('default','fixture')");
    testDb.raw.exec(`INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret, tenant_id)
      VALUES ('a1', 'channel-1', '試験店舗', '', '', 'default');
      INSERT OR IGNORE INTO tenants(id,name) VALUES ('default','試験会社');
      INSERT INTO staff_members(id,name,role,api_key,tenant_id,permission_keys) VALUES ('operator-1','試験担当','staff','key','default','["/chats"]');
      INSERT INTO support_marks (id, name) VALUES ('mark-1', '対応中');
      INSERT INTO support_mark_scopes (mark_id, tenant_id, line_account_id, created_at)
      VALUES ('mark-1', 'default', 'a1', '${NOW}');
      INSERT INTO reminders (id, name, line_account_id) VALUES ('reminder-1', '試験通知', 'a1');
      INSERT INTO scenarios (id, name, trigger_type, line_account_id)
      VALUES ('scenario-1', '試験配信', 'manual', 'a1');
      INSERT INTO scenario_steps (id, scenario_id, step_order, message_type, message_content)
      VALUES ('step-1', 'scenario-1', 1, 'text', '試験本文');`);
    await publishScenarioVersion(testDb.db, 'scenario-1', { staffId: null, idempotencyKey: 'fixture-publish' });
    for (const id of ['f1', 'f2']) insertFriend(testDb.raw, id, { line_account_id: 'a1', is_following: 1 });
  });
  afterEach(() => testDb.raw.close());
  async function execute(operation: FriendBulkOperation) {
    const { run } = await startFriendBulkRun(testDb.db, actor, {
      selection: { kind: 'explicit', friendIds: ['f1', 'f2'] }, operation,
      idempotencyKey: crypto.randomUUID(), now: NOW,
    });
    await processFriendBulkRun(testDb.db, run.id, { now: NOW });
    return getFriendBulkRunDetail(testDb.db, run.id, 'default');
  }

  it('2人の担当者と対応マークを変え、成功件数と変更済みの件数を返す', async () => {
    expect(await execute({ kind: 'assign_operator', operatorId: 'staff:operator-1' })).toMatchObject({ successCount: 2 });
    expect(testDb.raw.prepare('SELECT assignee_staff_id FROM chats').all()).toEqual([{ assignee_staff_id: 'operator-1' }, { assignee_staff_id: 'operator-1' }]);
    expect(await execute({ kind: 'set_support', markId: 'mark-1' })).toMatchObject({ successCount: 2 });
    expect(testDb.raw.prepare('SELECT support_mark_id FROM friends').all()).toEqual([{ support_mark_id: 'mark-1' }, { support_mark_id: 'mark-1' }]);
    expect(await execute({ kind: 'set_support', markId: 'mark-1' })).toMatchObject({ successCount: 0, skippedCount: 2 });
  });

  it('別会社や別店舗の担当には一括変更しない', async () => {
    testDb.raw.exec(`INSERT INTO tenants(id,name) VALUES ('outside','別会社');
      INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret,tenant_id) VALUES ('a2','channel-2','別店舗','','','default');
      INSERT INTO staff_members(id,name,role,api_key,tenant_id,account_scope,permission_keys) VALUES
      ('outside','別会社','owner','outside-key','outside','all','[]'),
      ('other-shop','別店舗','staff','other-shop-key','default','accounts','["/chats"]');
      INSERT INTO staff_account_scopes(staff_id,line_account_id,created_at) VALUES ('other-shop','a2','2026');`);
    for (const id of ['outside','other-shop']) {
      const result = await execute({kind:'assign_operator',operatorId:`staff:${id}`});
      expect(result).toMatchObject({successCount:0});
      expect(testDb.raw.prepare('SELECT COUNT(*) n FROM chats').get()).toEqual({n:0});
    }
  });

  it('一括変更の取り消しは元の担当が権限を失っていたら復元しない', async () => {
    testDb.raw.exec(`INSERT INTO staff_members(id,name,role,api_key,tenant_id,permission_keys) VALUES ('old-staff','元の担当','staff','old-key','default','["/chats"]');
      INSERT INTO chats(id,friend_id,assignee_staff_id,created_at,updated_at) VALUES ('c1','f1','old-staff','2026','2026');`);
    const {run} = await startFriendBulkRun(testDb.db, actor, {selection:{kind:'explicit',friendIds:['f1']},operation:{kind:'assign_operator',operatorId:'staff:operator-1'},idempotencyKey:crypto.randomUUID(),now:NOW});
    await processFriendBulkRun(testDb.db,run.id,{now:NOW});
    testDb.raw.exec("UPDATE staff_members SET permission_keys='[]' WHERE id='old-staff'");
    const undo = await createFriendBulkUndoRun(testDb.db,actor,run.id,crypto.randomUUID(),'2026-10-02T00:01:00.000Z');
    await processFriendBulkRun(testDb.db,undo.run.id,{now:'2026-10-02T00:01:00.000Z'});
    expect(testDb.raw.prepare("SELECT assignee_staff_id FROM chats WHERE id='c1'").get()).toEqual({assignee_staff_id:'operator-1'});
    expect(testDb.raw.prepare('SELECT error_code FROM friend_bulk_run_items WHERE run_id=?').get(undo.run.id)).toEqual({error_code:'undo_conflict'});
  });

  it('2人にリマインダを登録し、再登録は重複せず、停止できる', async () => {
    const operation = { kind: 'set_reminder' as const, reminderId: 'reminder-1', targetDate: '2026-10-03T00:00:00.000Z' };
    expect(await execute(operation)).toMatchObject({ successCount: 2 });
    expect(await execute(operation)).toMatchObject({ successCount: 0, skippedCount: 2 });
    expect(await execute({ kind: 'cancel_reminder', reminderId: 'reminder-1' })).toMatchObject({ successCount: 2 });
    expect(testDb.raw.prepare('SELECT status FROM friend_reminders').all()).toEqual([{ status: 'cancelled' }, { status: 'cancelled' }]);
  });

  it('2人のシナリオを始めて止め、結果件数と実際の登録状態が一致する', async () => {
    expect(await execute({ kind: 'start_scenario', scenarioId: 'scenario-1' })).toMatchObject({ successCount: 2 });
    expect(testDb.raw.prepare('SELECT status FROM friend_scenarios').all()).toEqual([{ status: 'active' }, { status: 'active' }]);
    expect(await execute({ kind: 'stop_scenario', scenarioId: 'scenario-1' })).toMatchObject({ successCount: 2 });
    expect(testDb.raw.prepare('SELECT status FROM friend_scenarios').all()).toEqual([{ status: 'paused' }, { status: 'paused' }]);
  });
});
