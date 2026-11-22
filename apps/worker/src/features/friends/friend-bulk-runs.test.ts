import type Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createFriendBulkRun,
  createTemplate,
  getFriendBulkRunDetail,
  publishTemplate,
} from '@line-crm/db';
import { AutomationActionError, type AutomationActionExecutor } from '../automations/automation-engine';
import { createTestD1, insertFriend, type SqliteD1 } from '../../test-utils/d1-sqlite';
import {
  createFriendBulkUndoRun,
  previewFriendBulkRun,
  processFriendBulkRun,
  requireFriendBulkRunAccess,
  retryFriendBulkRun,
  startFriendBulkRun,
} from './friend-bulk-runs';

const NOW = '2026-08-31T02:00:00.000Z';
const LATER = '2026-08-31T02:02:00.000Z';
const staff = {
  id: 'env-owner',
  name: '管理者',
  role: 'owner' as const,
  readOnly: false,
  tenantId: 'default',
};

function addAccount(raw: Database.Database, id: string): void {
  raw.prepare(
    `INSERT INTO line_accounts
       (id, channel_id, name, channel_access_token, channel_secret, is_active, tenant_id)
     VALUES (?, ?, ?, '', '', 1, 'default')`,
  ).run(id, `channel-${id}`, id);
}

describe('友だち一括操作', () => {
  let testDb: SqliteD1;

  beforeEach(() => {
    testDb = createTestD1();
    testDb.raw.exec("INSERT OR IGNORE INTO tenants(id,name) VALUES ('default','fixture')");
    addAccount(testDb.raw, 'account-1');
    addAccount(testDb.raw, 'account-2');
    insertFriend(testDb.raw, 'friend-1', { line_account_id: 'account-1', is_following: 1 });
    insertFriend(testDb.raw, 'friend-2', { line_account_id: 'account-1', is_following: 0 });
    insertFriend(testDb.raw, 'friend-3', { line_account_id: 'account-2', is_following: 1 });
  });

  it('対象をサーバで再計算し、送れない人と別アカウントを理由付きで除外する', async () => {
    testDb.raw.prepare(
      `INSERT INTO templates (id, name, message_type, message_content, line_account_id)
       VALUES ('template-1', 'お知らせ', 'text', '本文', 'account-1')`,
    ).run();
    const result = await previewFriendBulkRun(testDb.db, staff, {
      kind: 'explicit', friendIds: ['friend-1', 'friend-2', 'friend-3'],
    }, {
      kind: 'send_message', templateId: 'template-1',
    });

    expect(result.preview).toMatchObject({ selectedCount: 3, targetCount: 1, excludedCount: 2 });
    expect(result.preview.exclusions).toEqual(expect.arrayContaining([
      { reason: '現在はLINEで送信できません', count: 1 },
      { reason: '選んだ操作とLINE公式アカウントが異なります', count: 1 },
    ]));
    expect(result.targets).toEqual([{ friendId: 'friend-1', lineAccountId: 'account-1' }]);
  });

  it('未公開テンプレートは対象確定・一括実行を開始しない', async () => {
    const template = await createTemplate(testDb.db, {
      name: '編集中のお知らせ',
      messageType: 'text',
      messageContent: 'まだ公開していない本文',
      lineAccountId: 'account-1',
    });
    const operation = { kind: 'send_message' as const, templateId: template.id };

    await expect(previewFriendBulkRun(
      testDb.db,
      staff,
      { kind: 'explicit', friendIds: ['friend-1'] },
      operation,
    )).rejects.toMatchObject({ code: 'template_not_published', status: 409 });
    await expect(startFriendBulkRun(testDb.db, staff, {
      selection: { kind: 'explicit', friendIds: ['friend-1'] },
      operation,
      idempotencyKey: crypto.randomUUID(),
      confirmIrreversible: true,
      now: NOW,
    })).rejects.toMatchObject({ code: 'template_not_published', status: 409 });
    expect(testDb.raw.prepare(`SELECT COUNT(*) AS count FROM friend_bulk_runs`).get())
      .toEqual({ count: 0 });

    await publishTemplate(testDb.db, template.id, {
      expectedVersion: 0,
      expectedDraftRevision: 1,
      idempotencyKey: 'friend-bulk-publish-1',
    });
    const started = await startFriendBulkRun(testDb.db, staff, {
      selection: { kind: 'explicit', friendIds: ['friend-1'] },
      operation,
      idempotencyKey: crypto.randomUUID(),
      confirmIrreversible: true,
      now: NOW,
    });
    expect(started.run).toMatchObject({ targetCount: 1, status: 'queued' });
  });

  it('対象IDを固定してタグを冪等実行し、あとから増えた友だちは触らない', async () => {
    testDb.raw.prepare(`INSERT INTO tags (id, name, line_account_id) VALUES ('tag-1', '会員', 'account-1')`).run();
    const created = await startFriendBulkRun(testDb.db, staff, {
      selection: { kind: 'explicit', friendIds: ['friend-1'] },
      operation: { kind: 'add_tag', tagId: 'tag-1' },
      idempotencyKey: crypto.randomUUID(),
      now: NOW,
    });
    insertFriend(testDb.raw, 'friend-late', { line_account_id: 'account-1', is_following: 1 });

    expect(await processFriendBulkRun(testDb.db, created.run.id, { now: NOW })).toMatchObject({ status: 'success' });
    expect(testDb.raw.prepare(`SELECT friend_id, tag_id FROM friend_tags`).all())
      .toEqual([{ friend_id: 'friend-1', tag_id: 'tag-1' }]);

    expect(await processFriendBulkRun(testDb.db, created.run.id, { now: NOW })).toMatchObject({ processed: 0 });
    expect(testDb.raw.prepare(`SELECT attempt_count FROM friend_bulk_run_items`).get())
      .toEqual({ attempt_count: 1 });
  });

  it('同じ冪等キーの同じ内容は同じ実行を返し、異なる内容は拒否する', async () => {
    testDb.raw.prepare(`INSERT INTO tags (id, name, line_account_id) VALUES ('tag-1', '会員', 'account-1')`).run();
    const key = crypto.randomUUID();
    const first = await startFriendBulkRun(testDb.db, staff, {
      selection: { kind: 'explicit', friendIds: ['friend-1'] },
      operation: { kind: 'add_tag', tagId: 'tag-1' }, idempotencyKey: key, now: NOW,
    });
    const replay = await startFriendBulkRun(testDb.db, staff, {
      selection: { kind: 'explicit', friendIds: ['friend-1'] },
      operation: { kind: 'add_tag', tagId: 'tag-1' }, idempotencyKey: key, now: NOW,
    });
    expect(replay.created).toBe(false);
    expect(replay.run.id).toBe(first.run.id);

    await expect(startFriendBulkRun(testDb.db, staff, {
      selection: { kind: 'explicit', friendIds: ['friend-1'] },
      operation: { kind: 'remove_tag', tagId: 'tag-1' }, idempotencyKey: key, now: NOW,
    })).rejects.toMatchObject({ code: 'idempotency_conflict', status: 409 });
  });

  it('実行結果は全件を一度に返さず、総数を保ったままページで読む', async () => {
    testDb.raw.prepare(`INSERT INTO tags (id, name, line_account_id) VALUES ('tag-1', '会員', 'account-1')`).run();
    insertFriend(testDb.raw, 'friend-4', { line_account_id: 'account-1', is_following: 1 });
    const created = await startFriendBulkRun(testDb.db, staff, {
      selection: { kind: 'explicit', friendIds: ['friend-1', 'friend-2', 'friend-4'] },
      operation: { kind: 'add_tag', tagId: 'tag-1' },
      idempotencyKey: crypto.randomUUID(), now: NOW,
    });

    const detail = await getFriendBulkRunDetail(testDb.db, created.run.id, 'default', { page: 2, limit: 2 });
    expect(detail).toMatchObject({ page: 2, limit: 2, total: 3 });
    expect(detail?.items.map((item) => item.friendId)).toEqual(['friend-4']);
  });

  it('一時失敗だけを明示的な再試行でやり直す', async () => {
    const key = crypto.randomUUID();
    const created = await startFriendBulkRun(testDb.db, staff, {
      selection: { kind: 'explicit', friendIds: ['friend-1'] },
      operation: { kind: 'send_message', content: 'こんにちは' },
      idempotencyKey: key,
      confirmIrreversible: true,
      now: NOW,
    });
    const send = vi.fn<AutomationActionExecutor>()
      .mockRejectedValueOnce(new AutomationActionError('line_busy', 'ただいま送信が混み合っています', true))
      .mockResolvedValueOnce(undefined);

    expect(await processFriendBulkRun(testDb.db, created.run.id, {
      now: NOW, executors: { send_message: send },
    })).toMatchObject({ status: 'failed' });
    expect(testDb.raw.prepare(`SELECT status FROM friend_bulk_run_items`).get())
      .toEqual({ status: 'temporary_failure' });

    expect(await retryFriendBulkRun(testDb.db, created.run.id, staff, LATER)).toBe(1);
    expect(await processFriendBulkRun(testDb.db, created.run.id, {
      now: LATER, executors: { send_message: send },
    })).toMatchObject({ status: 'success' });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('一括送信を通常の自動処理と取り違えない送信元で記録する', async () => {
    const created = await startFriendBulkRun(testDb.db, staff, {
      selection: { kind: 'explicit', friendIds: ['friend-1'] },
      operation: { kind: 'send_message', content: '一括のお知らせ' },
      idempotencyKey: crypto.randomUUID(), confirmIrreversible: true, now: NOW,
    });
    await processFriendBulkRun(testDb.db, created.run.id, {
      now: NOW,
      executorDependencies: {
        resolveLineAccessToken: async () => 'token',
        createLineClient: () => ({
          pushMessage: async () => ({ requestId: 'request-1' }),
          linkRichMenuToUser: async () => undefined,
          unlinkRichMenuFromUser: async () => undefined,
        }),
        now: () => NOW,
      },
    });

    expect(testDb.raw.prepare(
      `SELECT content, source FROM messages_log WHERE friend_id = 'friend-1'`,
    ).get()).toEqual({ content: '一括のお知らせ', source: 'friend_bulk_run' });
  });

  it('共通アクションの公開版を固定し、待機後に続きから再開する', async () => {
    testDb.raw.prepare(`INSERT INTO tags (id, name, line_account_id) VALUES ('tag-1', '会員', 'account-1')`).run();
    testDb.raw.prepare(
      `INSERT INTO common_actions (id, line_account_id, name, status, current_published_version_id, created_at, updated_at)
       VALUES ('action-1', 'account-1', '待ってタグ', 'published', 'version-1', ?, ?)`,
    ).run(NOW, NOW);
    testDb.raw.prepare(
      `INSERT INTO common_action_versions
         (id, common_action_id, version_number, status, action_config, created_at, published_at)
       VALUES ('version-1', 'action-1', 1, 'published', ?, ?, ?)`,
    ).run(JSON.stringify([
      { id: 'wait', type: 'wait', params: { durationMinutes: 1 }, onFailure: 'stop' },
      { id: 'tag', type: 'add_tag', params: { tagId: 'tag-1' }, onFailure: 'stop' },
    ]), NOW, NOW);
    const created = await startFriendBulkRun(testDb.db, staff, {
      selection: { kind: 'explicit', friendIds: ['friend-1'] },
      operation: { kind: 'run_common_action', commonActionId: 'action-1' },
      idempotencyKey: crypto.randomUUID(), confirmIrreversible: true, now: NOW,
    });

    expect(await processFriendBulkRun(testDb.db, created.run.id, { now: NOW })).toMatchObject({ status: 'waiting' });
    expect(testDb.raw.prepare(`SELECT COUNT(*) AS count FROM friend_tags`).get()).toEqual({ count: 0 });
    expect(await processFriendBulkRun(testDb.db, created.run.id, { now: LATER })).toMatchObject({ status: 'success' });
    expect(testDb.raw.prepare(`SELECT friend_id, tag_id FROM friend_tags`).all())
      .toEqual([{ friend_id: 'friend-1', tag_id: 'tag-1' }]);
  });

  it('可逆操作は元の値から別の取り消し実行を作る', async () => {
    const created = await startFriendBulkRun(testDb.db, staff, {
      selection: { kind: 'explicit', friendIds: ['friend-1'] },
      operation: { kind: 'set_visibility', hidden: true },
      idempotencyKey: crypto.randomUUID(), now: NOW,
    });
    await processFriendBulkRun(testDb.db, created.run.id, { now: NOW });
    expect(testDb.raw.prepare(`SELECT is_hidden FROM friends WHERE id = 'friend-1'`).get()).toEqual({ is_hidden: 1 });

    const undo = await createFriendBulkUndoRun(testDb.db, staff, created.run.id, crypto.randomUUID(), LATER);
    await processFriendBulkRun(testDb.db, undo.run.id, { now: LATER });
    expect(testDb.raw.prepare(`SELECT is_hidden FROM friends WHERE id = 'friend-1'`).get()).toEqual({ is_hidden: 0 });
  });

  it('同じ冪等キーでも実行予定日時が違えば別の依頼として拒否する', async () => {
    testDb.raw.prepare(`INSERT INTO tags (id, name, line_account_id) VALUES ('tag-1', '会員', 'account-1')`).run();
    const key = crypto.randomUUID();
    await startFriendBulkRun(testDb.db, staff, {
      selection: { kind: 'explicit', friendIds: ['friend-1'] },
      operation: { kind: 'add_tag', tagId: 'tag-1' },
      scheduledAt: NOW,
      idempotencyKey: key,
      now: NOW,
    });

    await expect(startFriendBulkRun(testDb.db, staff, {
      selection: { kind: 'explicit', friendIds: ['friend-1'] },
      operation: { kind: 'add_tag', tagId: 'tag-1' },
      scheduledAt: LATER,
      idempotencyKey: key,
      now: NOW,
    })).rejects.toMatchObject({ code: 'idempotency_conflict', status: 409 });
  });

  it('対象の固定に失敗しても途中の実行台帳を残さない', async () => {
    await expect(createFriendBulkRun(testDb.db, {
      tenantId: 'default',
      createdBy: staff.id,
      selection: { kind: 'explicit', friendIds: ['friend-1'] },
      operation: { kind: 'set_visibility', hidden: true },
      targets: [
        { friendId: 'friend-1', lineAccountId: 'account-1' },
        { friendId: 'friend-1', lineAccountId: 'account-1' },
      ],
      excludedCount: 0,
      reversible: true,
      idempotencyKey: crypto.randomUUID(),
      now: NOW,
    })).rejects.toBeTruthy();

    expect(testDb.raw.prepare(`SELECT COUNT(*) AS count FROM friend_bulk_runs`).get())
      .toEqual({ count: 0 });
    expect(testDb.raw.prepare(`SELECT COUNT(*) AS count FROM friend_bulk_run_items`).get())
      .toEqual({ count: 0 });
  });

  it('EC側を正とする友だち情報は一括操作でも書き換えさせない', async () => {
    testDb.raw.prepare(
      `INSERT INTO friend_fields (id, name, field_key, type, ec_is_master)
       VALUES ('field-ec', '会員ランク', 'member_rank', 'text', 1)`,
    ).run();

    await expect(previewFriendBulkRun(testDb.db, staff, {
      kind: 'explicit', friendIds: ['friend-1'],
    }, {
      kind: 'set_friend_fields', values: { 'field-ec': 'ゴールド' },
    })).rejects.toMatchObject({ code: 'friend_field_ec_master', status: 409 });
  });

  it('担当外アカウントを含む実行はIDを知っていても読ませない', async () => {
    testDb.raw.prepare(
      `INSERT INTO staff_members
         (id, name, role, api_key, tenant_id, account_scope)
       VALUES ('scoped-owner', '担当者', 'owner', 'key-scoped', 'default', 'accounts')`,
    ).run();
    testDb.raw.prepare(
      `INSERT INTO staff_account_scopes (staff_id, line_account_id, created_at)
       VALUES ('scoped-owner', 'account-1', ?)`,
    ).run(NOW);
    const created = await startFriendBulkRun(testDb.db, staff, {
      selection: { kind: 'explicit', friendIds: ['friend-3'] },
      operation: { kind: 'set_visibility', hidden: true },
      idempotencyKey: crypto.randomUUID(),
      now: NOW,
    });
    const scopedStaff = { ...staff, id: 'scoped-owner' };

    await expect(requireFriendBulkRunAccess(testDb.db, scopedStaff, created.run.id))
      .rejects.toMatchObject({ code: 'run_not_found', status: 404 });
    await expect(createFriendBulkUndoRun(
      testDb.db, scopedStaff, created.run.id, crypto.randomUUID(), LATER,
    )).rejects.toMatchObject({ code: 'run_not_found', status: 404 });
  });

  it('一括操作のあとに人が変更した値は取り消しで上書きしない', async () => {
    const created = await startFriendBulkRun(testDb.db, staff, {
      selection: { kind: 'explicit', friendIds: ['friend-1'] },
      operation: { kind: 'set_visibility', hidden: true },
      idempotencyKey: crypto.randomUUID(), now: NOW,
    });
    await processFriendBulkRun(testDb.db, created.run.id, { now: NOW });
    testDb.raw.prepare(`UPDATE friends SET is_hidden = 0 WHERE id = 'friend-1'`).run();

    const undo = await createFriendBulkUndoRun(testDb.db, staff, created.run.id, crypto.randomUUID(), LATER);
    await processFriendBulkRun(testDb.db, undo.run.id, { now: LATER });

    expect(testDb.raw.prepare(`SELECT is_hidden FROM friends WHERE id = 'friend-1'`).get())
      .toEqual({ is_hidden: 0 });
    expect(testDb.raw.prepare(
      `SELECT status, error_code, error_message FROM friend_bulk_run_items WHERE run_id = ?`,
    ).get(undo.run.id)).toEqual({
      status: 'permanent_failure',
      error_code: 'undo_conflict',
      error_message: '一括操作のあとに内容が変更されているため、この対象は取り消しませんでした',
    });
  });
});

describe('一括の成果登録は主経路と同じ4つのsnapshotを凍結する（#718）', () => {
  let testDb: SqliteD1;

  beforeEach(() => {
    testDb = createTestD1();
    testDb.raw.exec("INSERT OR IGNORE INTO tenants(id,name) VALUES ('default','fixture')");
    addAccount(testDb.raw, 'account-1');
    insertFriend(testDb.raw, 'friend-1', { line_account_id: 'account-1', is_following: 1 });
    // 実装は地点作成時にアカウントの統括を tenant_id へ写す。
    // 試験データも同じ形にする(account-1 は統括 'default')。
    testDb.raw.prepare(
      `INSERT INTO conversion_points (id, name, event_type, value, line_account_id, version, tenant_id)
       VALUES ('point-718', '成約', 'manual', 5000, 'account-1', 3, 'default')`,
    ).run();
  });

  it('add_conversionで4列を控え、affiliate_idはNULLのまま件数と金額の両方に数える', async () => {
    const created = await startFriendBulkRun(testDb.db, staff, {
      selection: { kind: 'explicit', friendIds: ['friend-1'] },
      operation: { kind: 'add_conversion', conversionPointId: 'point-718' },
      idempotencyKey: crypto.randomUUID(), now: NOW,
    });
    expect(await processFriendBulkRun(testDb.db, created.run.id, { now: NOW }))
      .toMatchObject({ status: 'success' });

    const row = testDb.raw.prepare(
      `SELECT point_name_snapshot, event_type_snapshot, value_snapshot,
              point_version_snapshot, affiliate_id, tenant_id
         FROM conversion_events WHERE conversion_point_id = 'point-718'`,
    ).get() as {
      point_name_snapshot: string | null;
      event_type_snapshot: string | null;
      value_snapshot: number | null;
      point_version_snapshot: number | null;
      affiliate_id: string | null;
      tenant_id: string | null;
    };
    expect(row).toEqual({
      point_name_snapshot: '成約',
      event_type_snapshot: 'manual',
      value_snapshot: 5000,
      point_version_snapshot: 3,
      affiliate_id: null,
      // 記録した成果にも計測時の統括を写す。
      tenant_id: 'default',
    });

    const total = testDb.raw.prepare(
      `SELECT COUNT(*) AS netCount, SUM(COALESCE(value_snapshot, 0)) AS netValue
         FROM conversion_events WHERE conversion_point_id = 'point-718'`,
    ).get() as { netCount: number; netValue: number };
    expect(total).toEqual({ netCount: 1, netValue: 5000 });
  });

  it('統括の違う地点と友だちの組合せでは成果を書かない(N-263)', async () => {
    // 直接INSERTで来る経路なので、行を作る側の境界だけでなく
    // 書き込み側でも閉じる。地点の統括が友だちの所属と違えば失敗にする。
    testDb.raw.prepare(
      `INSERT INTO conversion_points (id, name, event_type, value, line_account_id, version, tenant_id)
       VALUES ('point-cross', '越境', 'manual', 100, 'account-1', 1, 'other-tenant')`,
    ).run();
    const created = await startFriendBulkRun(testDb.db, staff, {
      selection: { kind: 'explicit', friendIds: ['friend-1'] },
      operation: { kind: 'add_conversion', conversionPointId: 'point-cross' },
      idempotencyKey: crypto.randomUUID(), now: NOW,
    });
    expect(await processFriendBulkRun(testDb.db, created.run.id, { now: NOW }))
      .toMatchObject({ status: 'failed' });
    expect(testDb.raw.prepare(
      `SELECT COUNT(*) AS n FROM conversion_events WHERE conversion_point_id = 'point-cross'`,
    ).get()).toEqual({ n: 0 });
  });
});

describe('一括操作の友だち情報は型どおりに検証する（N-042）', () => {
  let testDb: SqliteD1;

  beforeEach(() => {
    testDb = createTestD1();
    testDb.raw.exec("INSERT OR IGNORE INTO tenants(id,name) VALUES ('default','fixture')");
    addAccount(testDb.raw, 'account-1');
    insertFriend(testDb.raw, 'friend-1', { line_account_id: 'account-1', is_following: 1 });
    testDb.raw.prepare(
      `INSERT INTO friend_fields (id, name, field_key, type, options_json, ec_is_master)
       VALUES ('field-num', '頭数', 'head_count', 'number', NULL, 0),
              ('field-sel', '犬種', 'breed', 'select',
               '[{"id":"opt-1","label":"柴犬"},{"id":"opt-2","label":"猫"}]', 0)`,
    ).run();
  });

  it('型に合わない値は操作の行を作る前に422で止める', async () => {
    await expect(startFriendBulkRun(testDb.db, staff, {
      selection: { kind: 'explicit', friendIds: ['friend-1'] },
      operation: { kind: 'set_friend_fields', values: { 'field-num': 'たくさん' } },
      idempotencyKey: crypto.randomUUID(), now: NOW,
    })).rejects.toMatchObject({ code: 'friend_field_value_invalid', status: 422 });

    expect(testDb.raw.prepare(`SELECT COUNT(*) AS count FROM friend_bulk_runs`).get())
      .toEqual({ count: 0 });
    expect(testDb.raw.prepare(`SELECT COUNT(*) AS count FROM friend_bulk_run_items`).get())
      .toEqual({ count: 0 });
  });

  it('選択肢外は操作の行を作る前に422で止める', async () => {
    await expect(startFriendBulkRun(testDb.db, staff, {
      selection: { kind: 'explicit', friendIds: ['friend-1'] },
      operation: { kind: 'set_friend_fields', values: { 'field-sel': 'ドラゴン' } },
      idempotencyKey: crypto.randomUUID(), now: NOW,
    })).rejects.toMatchObject({ code: 'friend_field_value_invalid', status: 422 });
  });

  it('通った値は正規化して実行時に保存する', async () => {
    const created = await startFriendBulkRun(testDb.db, staff, {
      selection: { kind: 'explicit', friendIds: ['friend-1'] },
      operation: { kind: 'set_friend_fields', values: { 'field-num': '1,000', 'field-sel': '柴犬' } },
      idempotencyKey: crypto.randomUUID(), now: NOW,
    });
    expect(await processFriendBulkRun(testDb.db, created.run.id, { now: NOW }))
      .toMatchObject({ status: 'success' });

    expect(testDb.raw.prepare(
      `SELECT field_id, value FROM friend_field_values WHERE friend_id = 'friend-1' ORDER BY field_id`,
    ).all()).toEqual([
      { field_id: 'field-num', value: '1000' },
      { field_id: 'field-sel', value: 'opt-1' },
    ]);
  });
});
