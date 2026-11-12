import type Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite';
import { createTemplate, publishTemplate } from '@line-crm/db';
import {
  archiveCommonAction,
  createCommonAction,
  createCommonActionDraft,
  duplicateCommonAction,
  getCommonActionDetail,
  getCommonActionsSummary,
  listCommonActionResources,
  listCommonActions,
  publishCommonActionDraft,
  unarchiveCommonAction,
  updateCommonActionBindingVersion,
  updateCommonActionDraft,
} from './common-actions';

function addAccount(raw: Database.Database, id: string): void {
  raw.prepare(
    `INSERT INTO line_accounts
       (id, channel_id, name, channel_access_token, channel_secret, is_active)
     VALUES (?, ?, ?, '', '', 1)`,
  ).run(id, `channel-${id}`, id);
}

function addTag(raw: Database.Database, id: string, accountId: string): void {
  raw.prepare(`INSERT INTO tags (id, name, line_account_id) VALUES (?, ?, ?)`)
    .run(id, id, accountId);
}

const tagAction = (tagId: string) => [{
  id: 'tag-step',
  type: 'add_tag',
  params: { tagId },
  onFailure: 'stop',
}];

describe('共通アクション', () => {
  let testDb: SqliteD1;

  beforeEach(() => {
    testDb = createTestD1();
    addAccount(testDb.raw, 'account-1');
    addAccount(testDb.raw, 'account-2');
    addTag(testDb.raw, 'tag-1', 'account-1');
    addTag(testDb.raw, 'tag-2', 'account-2');
  });

  it('下書きを作成・編集・公開し、公開版を直接変更できない', async () => {
    const created = await createCommonAction(testDb.db, {
      lineAccountId: 'account-1',
      name: '来店後フォロー',
      description: '来店済みタグを付ける',
      actions: tagAction('tag-1'),
      createdBy: 'staff-1',
    });
    await updateCommonActionDraft(testDb.db, {
      id: created.id,
      lineAccountId: 'account-1',
      expectedDraftVersionId: created.draftVersionId,
      expectedDraftRevision: 1,
      name: '来店後フォロー',
      description: '公開前の変更',
      actions: tagAction('tag-1'),
    });
    const published = await publishCommonActionDraft(testDb.db, {
      id: created.id,
      lineAccountId: 'account-1',
      draftVersionId: created.draftVersionId,
      expectedDraftRevision: 2,
    });

    expect(published).toEqual({ versionId: created.draftVersionId, versionNumber: 1 });
    const detail = await getCommonActionDetail(testDb.db, {
      id: created.id,
      lineAccountId: 'account-1',
    });
    expect(detail).toMatchObject({
      name: '来店後フォロー',
      status: 'published',
      currentDraftVersionId: null,
      currentPublishedVersionId: created.draftVersionId,
      versions: [{ versionNumber: 1, status: 'published' }],
    });
    expect(() => testDb.raw.prepare(
      `UPDATE common_action_versions SET action_config = '[]' WHERE id = ?`,
    ).run(created.draftVersionId)).toThrow(/immutable/);
  });

  it('別アカウントの参照先は保存の時点で拒否する（監査 R479）', async () => {
    // 監査 : 参照先の固定は保存時に行う。別アカウントの選択肢は
    // 下書きに残さず、保存の時点で止める（公開時の検査は維持する）。
    await expect(createCommonAction(testDb.db, {
      lineAccountId: 'account-1',
      name: '危険な下書き',
      actions: tagAction('tag-2'),
    })).rejects.toMatchObject({
      code: 'resource_not_found',
      field: 'actions.0.params.tagId',
    });
    expect(testDb.raw.prepare(
      `SELECT COUNT(*) AS count FROM common_actions WHERE line_account_id = 'account-1'`,
    ).get()).toEqual({ count: 0 });
  });

  it('未公開・別アカウントのテンプレートは結びつけられない(再審査2・3)', async () => {
    const messageAction = (templateId: string) => [{
      id: 'msg-step',
      type: 'send_message',
      params: { templateId },
      onFailure: 'stop',
    }];
    const tryPublish = async (name: string, templateId: string) => {
      const created = await createCommonAction(testDb.db, {
        lineAccountId: 'account-1', name, actions: messageAction(templateId),
      });
      return publishCommonActionDraft(testDb.db, {
        id: created.id, lineAccountId: 'account-1', draftVersionId: created.draftVersionId, expectedDraftRevision: 1,
      });
    };
    const unpublished = await createTemplate(testDb.db, {
      name: '未公開', messageType: 'text', messageContent: '未公開の本文', lineAccountId: 'account-1',
    });
    await expect(tryPublish('未公開を使う', unpublished.id)).rejects.toMatchObject(
      { code: 'resource_not_found', field: 'actions.0.params.templateId' },
    );

    const other = await createTemplate(testDb.db, {
      name: '別持ち主', messageType: 'text', messageContent: '別の本文', lineAccountId: 'account-2',
    });
    await publishTemplate(testDb.db, other.id, { idempotencyKey: 'common-other-publish' });
    await expect(tryPublish('別持ち主を使う', other.id)).rejects.toMatchObject(
      { code: 'resource_not_found', field: 'actions.0.params.templateId' },
    );

    const mine = await createTemplate(testDb.db, {
      name: '公開済み', messageType: 'text', messageContent: '公開版の本文', lineAccountId: 'account-1',
    });
    await publishTemplate(testDb.db, mine.id, { idempotencyKey: 'common-mine-publish' });
    const published = await tryPublish('公開済みを使う', mine.id);
    expect(published.versionNumber).toBe(1);
  });

  it('テンプレート候補は同一アカウントの公開版だけを返す', async () => {
    const unpublished = await createTemplate(testDb.db, {
      name: '編集中', messageType: 'text', messageContent: '下書き', lineAccountId: 'account-1',
    });
    const published = await createTemplate(testDb.db, {
      name: '公開中', messageType: 'text', messageContent: '公開版', lineAccountId: 'account-1',
    });
    const other = await createTemplate(testDb.db, {
      name: '別アカウント', messageType: 'text', messageContent: '公開版', lineAccountId: 'account-2',
    });
    await publishTemplate(testDb.db, published.id, {
      expectedVersion: 0,
      expectedDraftRevision: 1,
      idempotencyKey: 'common-resource-publish-1',
    });
    await publishTemplate(testDb.db, other.id, {
      expectedVersion: 0,
      expectedDraftRevision: 1,
      idempotencyKey: 'common-resource-publish-2',
    });

    const resources = await listCommonActionResources(testDb.db, { lineAccountId: 'account-1' });
    expect(resources.templates).toEqual([{ id: published.id, name: '公開中' }]);
    expect(resources.templates).not.toContainEqual({ id: unpublished.id, name: '編集中' });
    expect(resources.templates).not.toContainEqual({ id: other.id, name: '別アカウント' });
  });

  it('未知の処理を保存も公開もしない', async () => {
    await expect(createCommonAction(testDb.db, {
      lineAccountId: 'account-1',
      name: '未接続処理',
      actions: [{ id: 'future', type: 'future_action', params: {}, onFailure: 'stop' }],
    })).rejects.toMatchObject({ code: 'action_type_unsupported' });
  });

  it('タグ条件の分岐を検査し、両方の公開版を固定する', async () => {
    const yes = await createCommonAction(testDb.db, {
      lineAccountId: 'account-1', name: 'VIP向け', actions: tagAction('tag-1'),
    });
    await publishCommonActionDraft(testDb.db, {
      id: yes.id, lineAccountId: 'account-1', draftVersionId: yes.draftVersionId, expectedDraftRevision: 1,
    });
    const no = await createCommonAction(testDb.db, {
      lineAccountId: 'account-1', name: '通常向け', actions: tagAction('tag-1'),
    });
    await publishCommonActionDraft(testDb.db, {
      id: no.id, lineAccountId: 'account-1', draftVersionId: no.draftVersionId, expectedDraftRevision: 1,
    });
    const branched = await createCommonAction(testDb.db, {
      lineAccountId: 'account-1',
      name: 'VIPで分ける',
      actions: [{
        id: 'branch-1', type: 'branch', onFailure: 'stop',
        params: {
          condition: { operator: 'AND', rules: [{ type: 'tag_exists', value: 'tag-1' }] },
          then: [{ id: 'yes', type: 'common_action', params: { commonActionId: yes.id }, onFailure: 'stop' }],
          else: [{ id: 'no', type: 'common_action', params: { commonActionId: no.id }, onFailure: 'stop' }],
        },
      }],
    });
    await publishCommonActionDraft(testDb.db, {
      id: branched.id, lineAccountId: 'account-1', draftVersionId: branched.draftVersionId, expectedDraftRevision: 1,
    });
    const detail = await getCommonActionDetail(testDb.db, {
      id: branched.id, lineAccountId: 'account-1',
    });
    const branch = detail.versions[0].actions[0];
    expect(branch.type).toBe('branch');
    expect((branch.params.then as Array<{ params: Record<string, unknown> }>)[0].params)
      .toMatchObject({ commonActionId: yes.id, commonActionVersionId: yes.draftVersionId });
    expect((branch.params.else as Array<{ params: Record<string, unknown> }>)[0].params)
      .toMatchObject({ commonActionId: no.id, commonActionVersionId: no.draftVersionId });
  });

  it('複製は元とつながらない独立した下書きを作る', async () => {
    const source = await createCommonAction(testDb.db, {
      lineAccountId: 'account-1', name: '来店後フォロー', actions: tagAction('tag-1'),
    });
    await publishCommonActionDraft(testDb.db, {
      id: source.id, lineAccountId: 'account-1', draftVersionId: source.draftVersionId, expectedDraftRevision: 1,
    });
    const copied = await duplicateCommonAction(testDb.db, {
      id: source.id, lineAccountId: 'account-1', createdBy: 'staff-1',
    });
    expect(copied.id).not.toBe(source.id);
    const detail = await getCommonActionDetail(testDb.db, {
      id: copied.id, lineAccountId: 'account-1',
    });
    expect(detail).toMatchObject({ name: '来店後フォロー のコピー', status: 'draft' });
    expect(detail.versions[0].actions).toEqual(tagAction('tag-1'));
    expect(detail.bindings).toEqual([]);
  });

  it('空の友だち情報項目名を保存せず、待機時間を実行形式へ揃える（監査 R479）', async () => {
    // 監査 : 参照先と入力の検査は保存時に行う。不正な内容は下書きに残さない。
    await expect(createCommonAction(testDb.db, {
      lineAccountId: 'account-1',
      name: '入力不足',
      actions: [{ id: 'metadata', type: 'set_metadata', params: { values: { '': '値' } }, onFailure: 'stop' }],
    })).rejects.toMatchObject({ code: 'metadata_key_required' });

    const waiting = await createCommonAction(testDb.db, {
      lineAccountId: 'account-1',
      name: '5分待つ',
      actions: [{ id: 'wait', type: 'wait', params: { minutes: 5 }, onFailure: 'stop' }],
    });
    const detail = await getCommonActionDetail(testDb.db, {
      id: waiting.id, lineAccountId: 'account-1',
    });
    expect(detail.versions[0].actions[0].params).toEqual({ durationMinutes: 5 });
  });

  it('新版公開後も利用先は旧版のままにし、明示操作でだけ切り替える', async () => {
    const created = await createCommonAction(testDb.db, {
      lineAccountId: 'account-1', name: '固定版', actions: tagAction('tag-1'),
    });
    await publishCommonActionDraft(testDb.db, {
      id: created.id, lineAccountId: 'account-1', draftVersionId: created.draftVersionId, expectedDraftRevision: 1,
    });
    testDb.raw.prepare(
      `INSERT INTO common_action_bindings
         (id, line_account_id, common_action_id, common_action_version_id,
          consumer_type, consumer_id, consumer_path)
       VALUES ('binding-1', 'account-1', ?, ?, 'automation', 'automation-1', 'step-1')`,
    ).run(created.id, created.draftVersionId);
    const draft2 = await createCommonActionDraft(testDb.db, {
      id: created.id, lineAccountId: 'account-1', createdBy: 'staff-1',
    });
    await updateCommonActionDraft(testDb.db, {
      id: created.id,
      lineAccountId: 'account-1',
      expectedDraftVersionId: draft2.draftVersionId,
      expectedDraftRevision: 1,
      name: '固定版',
      actions: [{ id: 'wait', type: 'wait', params: { minutes: 5 }, onFailure: 'stop' }],
    });
    await publishCommonActionDraft(testDb.db, {
      id: created.id, lineAccountId: 'account-1', draftVersionId: draft2.draftVersionId, expectedDraftRevision: 2,
    });

    expect(testDb.raw.prepare(
      `SELECT common_action_version_id FROM common_action_bindings WHERE id = 'binding-1'`,
    ).get()).toEqual({ common_action_version_id: created.draftVersionId });
    let detail = await getCommonActionDetail(testDb.db, {
      id: created.id, lineAccountId: 'account-1',
    });
    expect(detail.bindings[0]).toMatchObject({ versionNumber: 1, hasNewerVersion: true });

    await expect(updateCommonActionBindingVersion(testDb.db, {
      id: created.id, bindingId: 'binding-1', lineAccountId: 'account-1',
      versionId: draft2.draftVersionId, expectedVersionId: created.draftVersionId,
      ...{ expectedConfirmationRevision: 2 },
    })).rejects.toMatchObject({ code: 'version_conflict' });
    expect(testDb.raw.prepare('SELECT COUNT(*) AS count FROM common_action_binding_migration_events').get()).toEqual({ count: 0 });
    await updateCommonActionBindingVersion(testDb.db, {
      id: created.id,
      bindingId: 'binding-1',
      lineAccountId: 'account-1',
      versionId: draft2.draftVersionId,
      expectedVersionId: created.draftVersionId,
      ...{ expectedConfirmationRevision: 1 },
      actorId: 'staff-1',
    });
    detail = await getCommonActionDetail(testDb.db, {
      id: created.id, lineAccountId: 'account-1',
    });
    expect(detail.bindings[0]).toMatchObject({ versionNumber: 2, hasNewerVersion: false, confirmationRevision: 2 });
    expect(testDb.raw.prepare(
      `SELECT from_action_version_id, to_action_version_id, actor_id
         FROM common_action_binding_migration_events`,
    ).get()).toEqual({
      from_action_version_id: created.draftVersionId,
      to_action_version_id: draft2.draftVersionId,
      actor_id: 'staff-1',
    });
    await expect(updateCommonActionBindingVersion(testDb.db, {
      id: created.id,
      bindingId: 'binding-1',
      lineAccountId: 'account-1',
      versionId: created.draftVersionId,
      expectedVersionId: created.draftVersionId,
      actorId: 'staff-2',
    })).rejects.toMatchObject({ code: 'version_conflict' });
    expect(testDb.raw.prepare(
      `SELECT COUNT(*) AS count FROM common_action_binding_migration_events`,
    ).get()).toEqual({ count: 1 });
    // 版なしの旧呼び出しで元へ戻した後も、最初の確認は再利用できない。
    await updateCommonActionBindingVersion(testDb.db, {
      id: created.id, bindingId: 'binding-1', lineAccountId: 'account-1',
      versionId: created.draftVersionId, expectedVersionId: draft2.draftVersionId,
    });
    await expect(updateCommonActionBindingVersion(testDb.db, {
      id: created.id, bindingId: 'binding-1', lineAccountId: 'account-1',
      versionId: draft2.draftVersionId, expectedVersionId: created.draftVersionId,
      expectedConfirmationRevision: 1,
    })).rejects.toMatchObject({ code: 'version_conflict' });
    expect(testDb.raw.prepare('SELECT confirmation_revision FROM common_action_bindings WHERE id = ?').get('binding-1'))
      .toEqual({ confirmation_revision: 3 });
  });

  it('共通アクション同士の循環を公開できない', async () => {
    const first = await createCommonAction(testDb.db, {
      lineAccountId: 'account-1', name: 'A', actions: tagAction('tag-1'),
    });
    const second = await createCommonAction(testDb.db, {
      lineAccountId: 'account-1', name: 'B', actions: tagAction('tag-1'),
    });
    await publishCommonActionDraft(testDb.db, {
      id: first.id, lineAccountId: 'account-1', draftVersionId: first.draftVersionId, expectedDraftRevision: 1,
    });
    await updateCommonActionDraft(testDb.db, {
      id: second.id,
      lineAccountId: 'account-1',
      expectedDraftVersionId: second.draftVersionId,
      expectedDraftRevision: 1,
      name: 'B',
      actions: [{
        id: 'call-a', type: 'common_action',
        params: { commonActionId: first.id }, onFailure: 'stop',
      }],
    });
    await publishCommonActionDraft(testDb.db, {
      id: second.id, lineAccountId: 'account-1', draftVersionId: second.draftVersionId, expectedDraftRevision: 2,
    });
    const draftA2 = await createCommonActionDraft(testDb.db, {
      id: first.id, lineAccountId: 'account-1',
    });
    // 監査 : 循環は保存の時点で止まる（公開時の検査は維持する）。
    // Bは公開済みでAを呼び、Aの下書きがBを呼ぶと循環になる。
    await expect(updateCommonActionDraft(testDb.db, {
      id: first.id,
      lineAccountId: 'account-1',
      expectedDraftVersionId: draftA2.draftVersionId,
      expectedDraftRevision: 1,
      name: 'A',
      actions: [{
        id: 'call-b', type: 'common_action',
        params: { commonActionId: second.id }, onFailure: 'stop',
      }],
    })).rejects.toMatchObject({ code: 'common_action_cycle' });
  });

  it('公開行の処理数は公開版にそろえ下書きは混ぜない（監査 R470）', async () => {
    const created = await createCommonAction(testDb.db, {
      lineAccountId: 'account-1', name: '公開と下書き', actions: tagAction('tag-1'),
    });
    await publishCommonActionDraft(testDb.db, {
      id: created.id, lineAccountId: 'account-1', draftVersionId: created.draftVersionId, expectedDraftRevision: 1,
    });
    // 公開v1は処理1個、下書きv2は処理2個にする。
    const draft2 = await createCommonActionDraft(testDb.db, {
      id: created.id, lineAccountId: 'account-1',
    });
    await updateCommonActionDraft(testDb.db, {
      id: created.id,
      lineAccountId: 'account-1',
      expectedDraftVersionId: draft2.draftVersionId,
      expectedDraftRevision: 1,
      name: '公開と下書き',
      actions: [...tagAction('tag-1'), ...tagAction('tag-1').map((step) => ({ ...step, id: 'tag-step-2' }))],
    });

    const list = await listCommonActions(testDb.db, { lineAccountId: 'account-1' });
    expect(list.items).toHaveLength(1);
    // 一覧は「公開中」「v1」と同じ版の処理数1個を出す。下書きの2個を混ぜない。
    expect(list.items[0]).toMatchObject({
      status: 'published', publishedVersion: 1, actionCount: 1,
    });
    const summary = await getCommonActionsSummary(testDb.db, 'account-1');
    expect(summary.actions).toBe(1);
  });

  it('利用先ごとの実行件数を数え旧版の残りも分ける（監査 R471・R472）', async () => {
    const created = await createCommonAction(testDb.db, {
      lineAccountId: 'account-1', name: '数える対象', actions: tagAction('tag-1'),
    });
    await publishCommonActionDraft(testDb.db, {
      id: created.id, lineAccountId: 'account-1', draftVersionId: created.draftVersionId, expectedDraftRevision: 1,
    });
    // 同じ自動化の2か所で呼ぶ。片方（never）はまだ動かしていない。
    testDb.raw.prepare(
      `INSERT INTO common_action_bindings
         (id, line_account_id, common_action_id, common_action_version_id,
          consumer_type, consumer_id, consumer_path)
       VALUES ('b-root', 'account-1', ?, ?, 'automation', 'auto-1', 'root'),
              ('b-never', 'account-1', ?, ?, 'automation', 'auto-1', 'never')`,
    ).run(created.id, created.draftVersionId, created.id, created.draftVersionId);
    testDb.raw.prepare(
      `INSERT INTO automation_definitions (id, line_account_id, name, status, current_published_version_id)
       VALUES ('auto-1', 'account-1', '呼ぶ側', 'active', 'auto-1-v1')`,
    ).run();
    testDb.raw.prepare(
      `INSERT INTO automation_versions (id, automation_id, version_number, status, trigger_type, action_config)
       VALUES ('auto-1-v1', 'auto-1', 1, 'published', 'message_received', '[]')`,
    ).run();
    for (const [id, status] of [['r-run', 'running'], ['r-wait', 'waiting']] as const) {
      testDb.raw.prepare(
        `INSERT INTO automation_runs
           (id, line_account_id, automation_id, automation_version_id,
            source_event_id, idempotency_key, status, is_test)
         VALUES (?, 'account-1', 'auto-1', 'auto-1-v1', ?, ?, ?, 0)`,
      ).run(id, `event-${id}`, `key-${id}`, status);
      // root の呼び出し箇所の目印だけがある。never 側の手順は無い。
      testDb.raw.prepare(
        `INSERT INTO automation_run_steps
           (id, automation_run_id, step_key, action_type, common_action_version_id,
            idempotency_key, status)
         VALUES (?, ?, 'root', 'common_action_marker', ?, ?, ?)`,
      ).run(`step-${id}`, id, created.draftVersionId, `step-${id}`, status);
    }

    let detail = await getCommonActionDetail(testDb.db, {
      id: created.id, lineAccountId: 'account-1',
    });
    const byId = new Map(detail.bindings.map((binding) => [binding.id, binding]));
    // 動かしていない箇所は0件。同じ実行を重ねて数えない。
    expect(byId.get('b-root')).toMatchObject({ runningCount: 1, waitingCount: 1 });
    expect(byId.get('b-never')).toMatchObject({ runningCount: 0, waitingCount: 0 });
    expect(byId.get('b-root')).toMatchObject({ consumerPath: 'root' });
    expect(byId.get('b-never')).toMatchObject({ consumerPath: 'never' });

    // v2 を公開して root の利用先だけ切り替える。実行中の2件は旧版のまま。
    const draft2 = await createCommonActionDraft(testDb.db, {
      id: created.id, lineAccountId: 'account-1',
    });
    await updateCommonActionDraft(testDb.db, {
      id: created.id,
      lineAccountId: 'account-1',
      expectedDraftVersionId: draft2.draftVersionId,
      expectedDraftRevision: 1,
      name: '数える対象',
      actions: [{ id: 'wait', type: 'wait', params: { minutes: 5 }, onFailure: 'stop' }],
    });
    await publishCommonActionDraft(testDb.db, {
      id: created.id, lineAccountId: 'account-1', draftVersionId: draft2.draftVersionId, expectedDraftRevision: 2,
    });
    await updateCommonActionBindingVersion(testDb.db, {
      id: created.id,
      bindingId: 'b-root',
      lineAccountId: 'account-1',
      versionId: draft2.draftVersionId,
      expectedVersionId: created.draftVersionId,
    });

    detail = await getCommonActionDetail(testDb.db, {
      id: created.id, lineAccountId: 'account-1',
    });
    const migrated = detail.bindings.find((binding) => binding.id === 'b-root');
    // 新版の件数は0だが、旧版で進行中の2件を見失わない。
    expect(migrated).toMatchObject({
      versionNumber: 2,
      runningCount: 0,
      waitingCount: 0,
      olderRunningCount: 1,
      olderWaitingCount: 1,
    });
  });

  it('古い読み取りからの保存・公開は改訂番号で止まる（監査 R473・R477）', async () => {
    const wait5 = [{ id: 'wait', type: 'wait', params: { minutes: 5 }, onFailure: 'stop' }] as const;
    const wait60 = [{ id: 'wait', type: 'wait', params: { minutes: 60 }, onFailure: 'stop' }] as const;
    const created = await createCommonAction(testDb.db, {
      lineAccountId: 'account-1', name: '競合する下書き',
      actions: [...wait5],
    });
    // 別担当に相当する先行保存（改訂1→2。5分が60分になる）。
    await updateCommonActionDraft(testDb.db, {
      id: created.id,
      lineAccountId: 'account-1',
      expectedDraftVersionId: created.draftVersionId,
      expectedDraftRevision: 1,
      name: '競合する下書き',
      actions: [...wait60],
    });
    // 開いたままだった古い画面の保存（名前だけでも）は409で止まる。
    await expect(updateCommonActionDraft(testDb.db, {
      id: created.id,
      lineAccountId: 'account-1',
      expectedDraftVersionId: created.draftVersionId,
      expectedDraftRevision: 1,
      name: '古い名前',
      actions: [...wait5],
    })).rejects.toMatchObject({ code: 'draft_revision_conflict' });
    // 先行保存の60分は残り、5分に戻っていない（保存時に実行形式へ揃える）。
    let detail = await getCommonActionDetail(testDb.db, {
      id: created.id, lineAccountId: 'account-1',
    });
    expect(detail.versions[0].actions[0].params).toEqual({ durationMinutes: 60 });
    expect(detail.versions[0].draftRevision).toBe(2);
    /*
     * 監査 : 409では古い画面の名前も残らない。親行と版行の
     * どちらも先行保存のまま（名前・版ポインタ・改訂番号が不変）。
     */
    expect(detail.name).toBe('競合する下書き');
    expect(detail.currentDraftVersionId).toBe(created.draftVersionId);
    expect(testDb.raw.prepare(
      `SELECT name, current_draft_version_id, draft_revision
         FROM common_actions ca
         JOIN common_action_versions cav ON cav.id = ca.current_draft_version_id
        WHERE ca.id = ?`,
    ).get(created.id)).toEqual({
      name: '競合する下書き',
      current_draft_version_id: created.draftVersionId,
      draft_revision: 2,
    });

    // 公開の読取後に保存が入った古い読取の公開も409で止まる。
    await expect(publishCommonActionDraft(testDb.db, {
      id: created.id,
      lineAccountId: 'account-1',
      draftVersionId: created.draftVersionId,
      expectedDraftRevision: 1,
    })).rejects.toMatchObject({ code: 'draft_revision_conflict' });
    /*
     * 監査 : 409では親行の版ポインタも版行の状態も変わらない。
     * 下書きのまま（公開ポインタなし・版は下書きのまま）。
     */
    expect(testDb.raw.prepare(
      `SELECT status, current_draft_version_id, current_published_version_id
         FROM common_actions WHERE id = ?`,
    ).get(created.id)).toEqual({
      status: 'draft',
      current_draft_version_id: created.draftVersionId,
      current_published_version_id: null,
    });
    expect(testDb.raw.prepare(
      `SELECT status, draft_revision FROM common_action_versions WHERE id = ?`,
    ).get(created.draftVersionId)).toEqual({ status: 'draft', draft_revision: 2 });
    // 最新の改訂での公開は成功し、保存済みの60分が公開される。
    const published = await publishCommonActionDraft(testDb.db, {
      id: created.id,
      lineAccountId: 'account-1',
      draftVersionId: created.draftVersionId,
      expectedDraftRevision: 2,
    });
    expect(published.versionNumber).toBe(1);
    detail = await getCommonActionDetail(testDb.db, {
      id: created.id, lineAccountId: 'account-1',
    });
    expect(detail.versions[0].actions[0].params).toEqual({ durationMinutes: 60 });
  });

  it('同じ作成鍵の再試行は同じ作成へ戻り二重作成にしない（監査 R475）', async () => {
    const count = () => testDb.raw.prepare(
      `SELECT COUNT(*) AS count FROM common_actions WHERE line_account_id = 'account-1'`,
    ).get() as { count: number };
    const first = await createCommonAction(testDb.db, {
      lineAccountId: 'account-1', name: '再試行する作成',
      actions: tagAction('tag-1'), clientRequestKey: 'req-1',
    });
    // 保存確定後の応答消失からの再試行（同じ鍵・同じ内容）は最初の作成へ戻る。
    const retry = await createCommonAction(testDb.db, {
      lineAccountId: 'account-1', name: '再試行する作成',
      actions: tagAction('tag-1'), clientRequestKey: 'req-1',
    });
    expect(retry).toEqual(first);
    expect(count()).toEqual({ count: 1 });
    // 別の鍵は独立した新規作成になる。
    const other = await createCommonAction(testDb.db, {
      lineAccountId: 'account-1', name: '再試行する作成',
      actions: tagAction('tag-1'), clientRequestKey: 'req-2',
    });
    expect(other.id).not.toBe(first.id);
    expect(count()).toEqual({ count: 2 });
    // 鍵なしの従来の作成もそのまま独立する。
    await createCommonAction(testDb.db, {
      lineAccountId: 'account-1', name: '再試行する作成', actions: tagAction('tag-1'),
    });
    expect(count()).toEqual({ count: 3 });
  });

  it('参照をまたぐ4段分岐の公開は理由と経路を示して止まる（監査 R478）', async () => {
    const branchOf = (id: string, thenSteps: unknown[], elseSteps: unknown[]) => ({
      id, type: 'branch', onFailure: 'stop',
      params: {
        condition: { operator: 'AND', rules: [{ type: 'tag_exists', value: 'tag-1' }] },
        then: thenSteps, else: elseSteps,
      },
    });
    const nested = (levels: number, prefix: string): unknown[] => levels === 0
      ? tagAction('tag-1')
      : [branchOf(`${prefix}-b${levels}`, nested(levels - 1, `${prefix}-t`), tagAction('tag-1'))];
    const refTo = (id: string, targetId: string) => ({
      id, type: 'common_action', params: { commonActionId: targetId }, onFailure: 'stop',
    });

    // 3段の分岐を持つLは公開できる（境界）。
    const leaf = await createCommonAction(testDb.db, {
      lineAccountId: 'account-1', name: '分岐3段', actions: nested(3, 'leaf'),
    });
    await publishCommonActionDraft(testDb.db, {
      id: leaf.id, lineAccountId: 'account-1',
      draftVersionId: leaf.draftVersionId, expectedDraftRevision: 1,
    });
    // 1段の分岐でLを呼ぶCは展開で4段になるため、実行に渡す前に止まる。
    const caller = await createCommonAction(testDb.db, {
      lineAccountId: 'account-1', name: '分岐を呼ぶ',
      actions: [branchOf('c-b', [refTo('call-leaf', leaf.id)], tagAction('tag-1'))],
    });
    await expect(publishCommonActionDraft(testDb.db, {
      id: caller.id, lineAccountId: 'account-1',
      draftVersionId: caller.draftVersionId, expectedDraftRevision: 1,
    })).rejects.toMatchObject({ code: 'branch_too_deep' });
    await expect(publishCommonActionDraft(testDb.db, {
      id: caller.id, lineAccountId: 'account-1',
      draftVersionId: caller.draftVersionId, expectedDraftRevision: 1,
    })).rejects.toThrow(/3段/);
  });

  it('呼び出し21段は公開を止め20段は通す（監査 R478）', async () => {
    const publishOne = async (name: string, childId: string | null) => {
      const created = await createCommonAction(testDb.db, {
        lineAccountId: 'account-1',
        name,
        actions: childId
          ? [{ id: `call-${name}`, type: 'common_action', params: { commonActionId: childId }, onFailure: 'stop' }]
          : tagAction('tag-1'),
      });
      await publishCommonActionDraft(testDb.db, {
        id: created.id, lineAccountId: 'account-1',
        draftVersionId: created.draftVersionId, expectedDraftRevision: 1,
      });
      return created.id;
    };
    // 20段の連鎖は公開できる（境界）。末尾から順に公開する。
    let child20: string | null = null;
    for (let i = 20; i >= 1; i--) {
      child20 = await publishOne(`連鎖20-${i}`, child20);
    }
    // 21段の連鎖は先頭の公開で止まる。末尾20段の公開は通る。
    let child21: string | null = null;
    for (let i = 21; i >= 2; i--) {
      child21 = await publishOne(`連鎖21-${i}`, child21);
    }
    const head21 = await createCommonAction(testDb.db, {
      lineAccountId: 'account-1',
      name: '連鎖21-1',
      actions: child21
        ? [{ id: 'call-21-1', type: 'common_action', params: { commonActionId: child21 }, onFailure: 'stop' }]
        : tagAction('tag-1'),
    });
    await expect(publishCommonActionDraft(testDb.db, {
      id: head21.id, lineAccountId: 'account-1',
      draftVersionId: head21.draftVersionId, expectedDraftRevision: 1,
    })).rejects.toMatchObject({ code: 'common_action_too_deep' });
  });

  it('展開1001処理は公開を止め1000処理は通す（監査 R478）', async () => {
    const waits = (count: number, prefix: string) => Array.from({ length: count }, (_, index) => ({
      id: `${prefix}-w${index}`, type: 'wait', params: { minutes: 5 }, onFailure: 'stop',
    }));
    const leaf = await createCommonAction(testDb.db, {
      lineAccountId: 'account-1', name: '待機90',
      actions: waits(90, 'leaf'),
    });
    await publishCommonActionDraft(testDb.db, {
      id: leaf.id, lineAccountId: 'account-1',
      draftVersionId: leaf.draftVersionId, expectedDraftRevision: 1,
    });
    const refs = (count: number, prefix: string) => Array.from({ length: count }, (_, index) => ({
      id: `${prefix}-call${index}`, type: 'common_action',
      params: { commonActionId: leaf.id }, onFailure: 'stop',
    }));
    /*
     * 監査 : 実行時は利用側の呼び出し1件が先に数えられる。
     * 呼び出し10回で900+10=910に89処理を足した999へ利用側1件で
     * 1000処理は公開できる（境界）。
     */
    const ok = await createCommonAction(testDb.db, {
      lineAccountId: 'account-1', name: '千処理',
      actions: [...refs(10, 'ok'), ...waits(89, 'ok')],
    });
    await publishCommonActionDraft(testDb.db, {
      id: ok.id, lineAccountId: 'account-1',
      draftVersionId: ok.draftVersionId, expectedDraftRevision: 1,
    });
    // もう1処理足して1000になると、利用側と合わせて1001で実行に渡す前に止まる。
    const over = await createCommonAction(testDb.db, {
      lineAccountId: 'account-1', name: '千一処理',
      actions: [...refs(10, 'over'), ...waits(90, 'over')],
    });
    await expect(publishCommonActionDraft(testDb.db, {
      id: over.id, lineAccountId: 'account-1',
      draftVersionId: over.draftVersionId, expectedDraftRevision: 1,
    })).rejects.toMatchObject({ code: 'execution_plan_too_large' });
  });

  it('確認後に参照先が更新されたら再確認なしでは公開しない（監査 R479）', async () => {
    const refTo = (targetId: string) => [{
      id: 'call', type: 'common_action', params: { commonActionId: targetId }, onFailure: 'stop',
    }];
    // 参照先Lのv1（5分待機）を公開する。
    const leaf = await createCommonAction(testDb.db, {
      lineAccountId: 'account-1', name: '参照される処理',
      actions: [{ id: 'wait', type: 'wait', params: { minutes: 5 }, onFailure: 'stop' }],
    });
    await publishCommonActionDraft(testDb.db, {
      id: leaf.id, lineAccountId: 'account-1',
      draftVersionId: leaf.draftVersionId, expectedDraftRevision: 1,
    });
    // Cの編集画面でL v1を確認して保存する（v1へ固定される）。
    const caller = await createCommonAction(testDb.db, {
      lineAccountId: 'account-1', name: '呼び出す処理', actions: refTo(leaf.id),
    });
    let detail = await getCommonActionDetail(testDb.db, {
      id: caller.id, lineAccountId: 'account-1',
    });
    expect(detail.versions[0].actions[0].params).toMatchObject({
      commonActionId: leaf.id, commonActionVersionId: leaf.draftVersionId,
    });
    // 別操作でLのv2（60分待機）が公開される。
    const leafDraft = await createCommonActionDraft(testDb.db, {
      id: leaf.id, lineAccountId: 'account-1',
    });
    await updateCommonActionDraft(testDb.db, {
      id: leaf.id,
      lineAccountId: 'account-1',
      expectedDraftVersionId: leafDraft.draftVersionId,
      expectedDraftRevision: 1,
      name: '参照される処理',
      actions: [{ id: 'wait', type: 'wait', params: { minutes: 60 }, onFailure: 'stop' }],
    });
    await publishCommonActionDraft(testDb.db, {
      id: leaf.id, lineAccountId: 'account-1',
      draftVersionId: leafDraft.draftVersionId, expectedDraftRevision: 2,
    });
    // Cは確認済みv1のままでも、再確認なしの公開は止まる。
    await expect(publishCommonActionDraft(testDb.db, {
      id: caller.id, lineAccountId: 'account-1',
      draftVersionId: caller.draftVersionId, expectedDraftRevision: 1,
    })).rejects.toMatchObject({ code: 'reference_updated' });
    await expect(publishCommonActionDraft(testDb.db, {
      id: caller.id, lineAccountId: 'account-1',
      draftVersionId: caller.draftVersionId, expectedDraftRevision: 1,
    })).rejects.toThrow(/新しい版があります.*v1→v2/);
    // 保存し直すとv2へ固定され、公開できる。
    await updateCommonActionDraft(testDb.db, {
      id: caller.id,
      lineAccountId: 'account-1',
      expectedDraftVersionId: caller.draftVersionId,
      expectedDraftRevision: 1,
      name: '呼び出す処理',
      actions: refTo(leaf.id),
    });
    await publishCommonActionDraft(testDb.db, {
      id: caller.id, lineAccountId: 'account-1',
      draftVersionId: caller.draftVersionId, expectedDraftRevision: 2,
    });
    detail = await getCommonActionDetail(testDb.db, {
      id: caller.id, lineAccountId: 'account-1',
    });
    expect(detail.versions[0].actions[0].params).toMatchObject({
      commonActionVersionId: leafDraft.draftVersionId,
    });
  });

  it('未公開の参照先は下書き保存の時点で止まる（監査 R479）', async () => {
    const unpublished = await createCommonAction(testDb.db, {
      lineAccountId: 'account-1', name: '未公開の参照先', actions: tagAction('tag-1'),
    });
    await expect(createCommonAction(testDb.db, {
      lineAccountId: 'account-1', name: '未公開を呼ぶ',
      actions: [{
        id: 'call', type: 'common_action',
        params: { commonActionId: unpublished.id }, onFailure: 'stop',
      }],
    })).rejects.toMatchObject({ code: 'common_action_not_published' });
  });

  it('一覧で旧版利用ありと未使用を区別する', async () => {
    const used = await createCommonAction(testDb.db, {
      lineAccountId: 'account-1', name: '利用中', actions: tagAction('tag-1'),
    });
    await publishCommonActionDraft(testDb.db, {
      id: used.id, lineAccountId: 'account-1', draftVersionId: used.draftVersionId, expectedDraftRevision: 1,
    });
    const unused = await createCommonAction(testDb.db, {
      lineAccountId: 'account-1', name: '未使用', actions: tagAction('tag-1'),
    });
    await publishCommonActionDraft(testDb.db, {
      id: unused.id, lineAccountId: 'account-1', draftVersionId: unused.draftVersionId, expectedDraftRevision: 1,
    });
    testDb.raw.prepare(
      `INSERT INTO common_action_bindings
         (id, line_account_id, common_action_id, common_action_version_id,
          consumer_type, consumer_id, consumer_path)
       VALUES ('binding-used', 'account-1', ?, ?, 'automation', 'automation-1', 'step-1')`,
    ).run(used.id, used.draftVersionId);

    const unusedRows = await listCommonActions(testDb.db, {
      lineAccountId: 'account-1', status: 'unused',
    });
    expect(unusedRows.items.map((row) => row.id)).toEqual([unused.id]);
    expect(unusedRows.total).toBe(1);
  });

  it('一覧の今月集計は実行台帳を読み、1人テストを混ぜない', async () => {
    const created = await createCommonAction(testDb.db, {
      lineAccountId: 'account-1', name: '集計対象', actions: tagAction('tag-1'),
    });
    await publishCommonActionDraft(testDb.db, {
      id: created.id, lineAccountId: 'account-1', draftVersionId: created.draftVersionId, expectedDraftRevision: 1,
    });
    testDb.raw.prepare(
      `INSERT INTO automation_definitions
         (id, line_account_id, name, status, current_published_version_id)
       VALUES ('automation-metrics', 'account-1', '集計ルール', 'active', 'automation-metrics-v1')`,
    ).run();
    testDb.raw.prepare(
      `INSERT INTO automation_versions
         (id, automation_id, version_number, status, trigger_type, action_config)
       VALUES ('automation-metrics-v1', 'automation-metrics', 1, 'published', 'message_received', '[]')`,
    ).run();
    for (const [id, status, isTest] of [
      ['run-success', 'success', 0],
      ['run-failed', 'failed', 0],
      ['run-test', 'failed', 1],
    ] as const) {
      testDb.raw.prepare(
        `INSERT INTO automation_runs
           (id, line_account_id, automation_id, automation_version_id, source_event_id,
            idempotency_key, status, is_test, created_at)
         VALUES (?, 'account-1', 'automation-metrics', 'automation-metrics-v1', ?, ?, ?, ?, datetime('now'))`,
      ).run(id, `event-${id}`, `key-${id}`, status, isTest);
      testDb.raw.prepare(
        `INSERT INTO automation_run_steps
           (id, automation_run_id, step_key, action_type, common_action_version_id,
            idempotency_key, status)
         VALUES (?, ?, 'common', 'common_action_marker', ?, ?, 'success')`,
      ).run(`step-${id}`, id, created.draftVersionId, `step-${id}`);
      testDb.raw.prepare(
        `INSERT INTO automation_run_steps
           (id, automation_run_id, step_key, action_type, idempotency_key, status)
         VALUES (?, ?, 'common/tag', 'add_tag', ?, ?)`,
      ).run(`child-${id}`, id, `child-${id}`, status === 'failed' ? 'failed' : 'success');
    }

    const result = await listCommonActions(testDb.db, { lineAccountId: 'account-1' });
    expect(result.items[0]).toMatchObject({
      executionCountThisMonth: 2,
      failureCountThisMonth: 1,
    });
    expect(result.items[0].lastRunAt).not.toBeNull();
  });

  it('編集画面の選択肢をLINE公式アカウント内に限定する', async () => {
    const published = await createCommonAction(testDb.db, {
      lineAccountId: 'account-1', name: '公開済み', actions: tagAction('tag-1'),
    });
    await publishCommonActionDraft(testDb.db, {
      id: published.id,
      lineAccountId: 'account-1',
      draftVersionId: published.draftVersionId,
      expectedDraftRevision: 1,
    });
    const resources = await listCommonActionResources(testDb.db, {
      lineAccountId: 'account-1',
    });
    expect(resources.tags).toEqual([{ id: 'tag-1', name: 'tag-1' }]);
    expect(resources.tags).not.toContainEqual(expect.objectContaining({ id: 'tag-2' }));
    expect(resources.commonActions).toContainEqual({
      id: published.id,
      name: '公開済み',
      version: 1,
      currentPublishedVersionId: published.draftVersionId,
    });
  });

  /*
   * 未使用件数の札と一覧がずれないよう、下書きも含め呼出元なしで数える。保管済みは保管の件数へ分ける。
   */
  it('「呼ばれていない」の件数は一覧の絞り込みと同じ対象を数える', async () => {
    const published = await createCommonAction(testDb.db, {
      lineAccountId: 'account-1', name: '呼ばれない公開中', actions: tagAction('tag-1'),
    });
    await publishCommonActionDraft(testDb.db, {
      id: published.id, lineAccountId: 'account-1', draftVersionId: published.draftVersionId, expectedDraftRevision: 1,
    });
    // 下書きのままのものと、保管に回したもの。どちらも呼び出し元なし。
    await createCommonAction(testDb.db, {
      lineAccountId: 'account-1', name: '呼ばれない下書き', actions: tagAction('tag-1'),
    });
    const archived = await createCommonAction(testDb.db, {
      lineAccountId: 'account-1', name: '呼ばれない保管', actions: tagAction('tag-1'),
    });
    await publishCommonActionDraft(testDb.db, {
      id: archived.id, lineAccountId: 'account-1', draftVersionId: archived.draftVersionId, expectedDraftRevision: 1,
    });
    testDb.raw.prepare(`UPDATE common_actions SET status = 'archived' WHERE id = ?`).run(archived.id);

    const [summary, unusedList] = [
      await getCommonActionsSummary(testDb.db, 'account-1'),
      await listCommonActions(testDb.db, { lineAccountId: 'account-1', status: 'unused' }),
    ];
    // 監査 : 保管済みは「保管」で見る。「呼ばれていない」には出さない。
    expect(unusedList.total).toBe(2);
    expect(summary.unused).toBe(unusedList.total);
    const all = await listCommonActions(testDb.db, { lineAccountId: 'account-1' });
    expect(all.total).toBe(2);
    expect(summary.total).toBe(2);
    expect(summary.archived).toBe(1);
    const onlyArchived = await listCommonActions(testDb.db, { lineAccountId: 'account-1', status: 'archived' });
    expect(onlyArchived.items.map((item) => item.id)).toEqual([archived.id]);
  });

  it('未使用は保管でき通常一覧から外れる（監査 R480）', async () => {
    const unused = await createCommonAction(testDb.db, {
      lineAccountId: 'account-1', name: '要らない試作', actions: tagAction('tag-1'),
    });
    await archiveCommonAction(testDb.db, { id: unused.id, lineAccountId: 'account-1' });
    // 通常一覧（すべて）から外れ、保管で見える。集計も同じ範囲。
    const all = await listCommonActions(testDb.db, { lineAccountId: 'account-1' });
    expect(all.items).toHaveLength(0);
    const onlyArchived = await listCommonActions(testDb.db, { lineAccountId: 'account-1', status: 'archived' });
    expect(onlyArchived.items.map((item) => item.id)).toEqual([unused.id]);
    expect(await getCommonActionsSummary(testDb.db, 'account-1'))
      .toMatchObject({ total: 0, archived: 1, unused: 0 });
    // 戻すと下書きとして通常一覧に戻る。
    await unarchiveCommonAction(testDb.db, { id: unused.id, lineAccountId: 'account-1' });
    const restored = await listCommonActions(testDb.db, { lineAccountId: 'account-1' });
    expect(restored.items).toMatchObject([{ id: unused.id, status: 'draft' }]);
  });

  it('利用中の保管は利用先を示して拒否する（監査 R480）', async () => {
    const used = await createCommonAction(testDb.db, {
      lineAccountId: 'account-1', name: '使っている処理', actions: tagAction('tag-1'),
    });
    await publishCommonActionDraft(testDb.db, {
      id: used.id, lineAccountId: 'account-1',
      draftVersionId: used.draftVersionId, expectedDraftRevision: 1,
    });
    testDb.raw.prepare(
      `INSERT INTO common_action_bindings
         (id, line_account_id, common_action_id, common_action_version_id,
          consumer_type, consumer_id, consumer_path)
       VALUES ('b-used', 'account-1', ?, ?, 'automation', 'auto-1', 'root')`,
    ).run(used.id, used.draftVersionId);
    await expect(archiveCommonAction(testDb.db, {
      id: used.id, lineAccountId: 'account-1',
    })).rejects.toMatchObject({ code: 'binding_exists' });
    await expect(archiveCommonAction(testDb.db, {
      id: used.id, lineAccountId: 'account-1',
    })).rejects.toThrow(/オートメーション.*1か所/);
    // 拒否されても状態は変わらない。
    expect(testDb.raw.prepare(
      `SELECT status FROM common_actions WHERE id = ?`,
    ).get(used.id)).toEqual({ status: 'published' });
  });

  /*
   * 監査 : 一覧の検索欄は「アクション名・中の処理で探す」と案内する。
   * 名前・説明だけでなく各版の処理内容（手順の本文など）も対象にする。
   */
  it('「中の処理で探す」は版の処理内容の文字にも届く', async () => {
    const created = await createCommonAction(testDb.db, {
      lineAccountId: 'account-1',
      name: '配送後のお知らせ',
      actions: [{
        id: 'msg-step',
        type: 'send_message',
        params: { content: 'synthetic notice をお送りします' },
        onFailure: 'stop',
      }],
    });
    await createCommonAction(testDb.db, {
      lineAccountId: 'account-1', name: '無関係の処理', actions: tagAction('tag-1'),
    });

    const found = await listCommonActions(testDb.db, {
      lineAccountId: 'account-1', query: 'synthetic notice',
    });
    expect(found.items.map((row) => row.id)).toEqual([created.id]);
    expect(found.total).toBe(1);
  });
});
