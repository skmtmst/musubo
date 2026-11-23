import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestD1, insertFriend, type SqliteD1 } from '../../test-utils/d1-sqlite.js';
import { startFriendBulkRun, processFriendBulkRun } from './friend-bulk-runs.js';
import { approveBulkMessage, getBulkMessageApproval } from './friend-bulk-message-approval.js';
import { listDueFriendBulkRunIds, createFriendBulkRun } from '@line-crm/db';

const actor = { id: 'actor-1', name: '試験担当', role: 'owner' as const, readOnly: false, tenantId: 'default' };
const approver = { ...actor, id: 'actor-2' };
const NOW = '2026-10-02T00:00:00.000Z';

describe('一括メッセージの承認', () => {
  let testDb: SqliteD1;
  beforeEach(() => {
    testDb = createTestD1();
    testDb.raw.exec("INSERT OR IGNORE INTO tenants(id,name) VALUES ('default','fixture')");
    testDb.raw.exec(`INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret, tenant_id)
      VALUES ('a1', 'channel-1', '試験店舗', '', '', 'default');
      INSERT INTO account_settings (id, line_account_id, key, value)
      VALUES ('threshold', 'a1', 'broadcast_approval_threshold', '2');
      INSERT INTO staff_members (id, name, api_key, role, is_active, invite_status)
      VALUES ('actor-1', '試験担当1', 'fixture-1', 'owner', 1, 'active'), ('actor-2', '試験担当2', 'fixture-2', 'owner', 1, 'active');`);
    insertFriend(testDb.raw, 'f1', { line_account_id: 'a1', is_following: 1 });
    insertFriend(testDb.raw, 'f2', { line_account_id: 'a1', is_following: 1 });
  });
  afterEach(() => testDb.raw.close());
  function start(friendIds = ['f1', 'f2']) {
    return startFriendBulkRun(testDb.db, actor, {
      selection: { kind: 'explicit', friendIds }, operation: { kind: 'send_message', content: '試験本文' },
      idempotencyKey: crypto.randomUUID(), confirmIrreversible: true, now: NOW,
    });
  }

  it('基準ちょうどで止まり、本人の承認を拒否し、別の担当の承認後にだけ実行する', async () => {
    const { run } = await start();
    const send = vi.fn().mockResolvedValue(undefined);
    expect(run.status).toBe('waiting');
    expect(await getBulkMessageApproval(testDb.db, run.id)).toMatchObject({ status: 'pending', recipientCount: 2, threshold: 2 });
    expect(await listDueFriendBulkRunIds(testDb.db, NOW)).toEqual([]);
    expect(await processFriendBulkRun(testDb.db, run.id, { executors: { send_message: send } })).toMatchObject({ processed: 0 });
    expect(send).not.toHaveBeenCalled();
    await expect(approveBulkMessage(testDb.db, actor, run.id)).rejects.toMatchObject({ code: 'self_approval_forbidden' });
    await approveBulkMessage(testDb.db, approver, run.id);
    await processFriendBulkRun(testDb.db, run.id, { executors: { send_message: send } });
    expect(send).toHaveBeenCalledTimes(2);
    expect(testDb.raw.prepare('SELECT action FROM friend_bulk_message_approval_events ORDER BY rowid').all())
      .toEqual([{ action: 'requested' }, { action: 'approved' }]);
  });

  it('基準未満は今までの返り値を保って実行する', async () => {
    const { run } = await start(['f1']);
    expect(run).toMatchObject({ status: 'queued', targetCount: 1, successCount: 0, excludedCount: 0 });
    expect(await getBulkMessageApproval(testDb.db, run.id)).toBeNull();
  });

  it('1人運用では人数が一致しない限り送らない', async () => {
    testDb.raw.exec("UPDATE staff_members SET is_active = 0 WHERE id = 'actor-2'");
    const { run } = await start();
    await expect(approveBulkMessage(testDb.db, actor, run.id, 1)).rejects.toMatchObject({ code: 'COUNT_MISMATCH' });
    expect(await approveBulkMessage(testDb.db, actor, run.id, 2)).toMatchObject({ status: 'confirmed' });
  });

  it('承認機能追加前の一括台帳も送信時に基準で止める', async () => {
    const { run } = await createFriendBulkRun(testDb.db, {
      tenantId: 'default', createdBy: actor.id, selection: { kind: 'explicit', friendIds: ['f1', 'f2'] },
      operation: { kind: 'send_message', content: '試験本文' }, targets: ['f1', 'f2'].map((friendId) => ({ friendId, lineAccountId: 'a1' })),
      excludedCount: 0, reversible: false, idempotencyKey: crypto.randomUUID(), now: NOW,
    });
    const send = vi.fn();
    expect(await processFriendBulkRun(testDb.db, run.id, { executors: { send_message: send } })).toMatchObject({ processed: 0 });
    expect(send).not.toHaveBeenCalled();
  });

  it('未設定の基準は1000人で止める', async () => {
    testDb.raw.exec('DELETE FROM account_settings');
    const ids = ['f1', 'f2'];
    for (let i = 2; i < 1000; i++) {
      const id = `f${i + 1}`;
      insertFriend(testDb.raw, id, { line_account_id: 'a1', is_following: 1 });
      ids.push(id);
    }
    const { run } = await start(ids);
    expect(await getBulkMessageApproval(testDb.db, run.id)).toMatchObject({ status: 'pending', recipientCount: 1000, threshold: 1000 });
    expect(testDb.raw.prepare('SELECT friend_id FROM friend_bulk_run_items WHERE run_id = ? ORDER BY ordinal').all(run.id))
      .toEqual(ids.map(friend_id => ({ friend_id })));
  });

  it('予約時刻を過ぎた承認は拒否し、その後も送らない', async () => {
    const { run } = await start();
    testDb.raw.prepare('UPDATE friend_bulk_runs SET scheduled_at = ? WHERE id = ?').run(NOW, run.id);
    await expect(approveBulkMessage(testDb.db, approver, run.id)).rejects.toMatchObject({ code: 'approval_expired' });
    await expect(approveBulkMessage(testDb.db, approver, run.id)).rejects.toMatchObject({ code: 'approval_expired' });
    const send = vi.fn();
    expect(await processFriendBulkRun(testDb.db, run.id, { executors: { send_message: send } })).toMatchObject({ processed: 0 });
    expect(send).not.toHaveBeenCalled();
  });

  it('1人で確認したあと運用者が増えたら別担当の承認まで止める', async () => {
    testDb.raw.exec("UPDATE staff_members SET is_active = 0 WHERE id = 'actor-2'");
    const { run } = await start();
    await approveBulkMessage(testDb.db, actor, run.id, 2);
    testDb.raw.exec("UPDATE staff_members SET is_active = 1 WHERE id = 'actor-2'");
    const send = vi.fn();
    expect(await processFriendBulkRun(testDb.db, run.id, { executors: { send_message: send } })).toMatchObject({ processed: 0 });
    expect(send).not.toHaveBeenCalled();
    expect(await getBulkMessageApproval(testDb.db, run.id)).toMatchObject({ status: 'pending' });
  });

  it('統括の削除開始後は新規作成せず、待機中の一括操作も実行しない', async () => {
    const {run}=await start();
    testDb.raw.exec("UPDATE tenants SET purge_started_at='2027-01-01' WHERE id='default'");
    await expect(start()).rejects.toThrow();
    expect(await listDueFriendBulkRunIds(testDb.db,NOW)).toEqual([]);
    const send=vi.fn();
    await expect(processFriendBulkRun(testDb.db,run.id,{executors:{send_message:send}})).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });

});
