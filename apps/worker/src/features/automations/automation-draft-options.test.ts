import type Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  AUTOMATION_DRAFT_ACTION_OPTIONS,
  AUTOMATION_DRAFT_TRIGGER_OPTIONS,
} from '@line-crm/shared';
import { createTestD1, type SqliteD1 } from '../../test-utils/d1-sqlite';
import { createAutomationActionExecutors } from './automation-action-executors';
import { EVENT_TRIGGER_TYPES, SCHEDULE_TRIGGER_TYPES } from './automation-triggers';
import {
  createAutomationDraftFromTemplate,
  updateAutomationDraft,
} from './automation-drafts';

/*
 * 下書きで選べるきっかけ・処理は、共有の正本と実行門で集合として一致する。
 * 共有の一覧は本物で import し、相手側(下書きunion・実行門・実行器)は
 * 実装を読む。実行門は実際の集合を使い、配列の展開も含めて照合する。
 *
 * - S1: 共有のきっかけ10種 = 下書きunionの10種(過不足なし)
 * - S2: 共有の処理4種 = 下書きunionの4種(過不足なし)
 * - S3: 共有のきっかけ10種 ⊆ 実行門(出来事門+定期門)
 * - S4: 共有の処理 ⊆ 実行器の鍵(共通アクションは展開・待機はエンジンで処理)
 * - S5: 共有の全きっかけと全処理を下書き保存が受け付ける(実DB)
 * - S6: union外のきっかけ・処理は保存しない
 */

function draftSource(): string {
  return readFileSync(join(import.meta.dirname, "automation-drafts.ts"), 'utf8');
}

/** `| 'a'` 形式の共用体から値だけを抜く。 */
function unionMembers(source: string, typeName: string): string[] {
  const block = new RegExp(`export type ${typeName} =([\\s\\S]*?);`).exec(source);
  if (!block) throw new Error(`${typeName} が見つかりません`);
  const members = [...block[1].matchAll(/'([^']+)'/g)].map((found) => found[1]);
  if (members.length === 0) throw new Error(`${typeName} から値を拾えません`);
  return [...new Set(members)];
}

function addAccount(raw: Database.Database, id: string): void {
  raw.prepare(
    `INSERT INTO line_accounts
       (id, channel_id, name, channel_access_token, channel_secret, is_active)
     VALUES (?, ?, ?, '', '', 1)`,
  ).run(id, `channel-${id}`, id);
}

const TRIGGER_CONFIGS: Record<string, Record<string, unknown>> = {
  friend_add: {},
  message_received: { keyword: '予約' },
  tag_change: { tagId: 'tag-1', action: 'remove' },
  form_submitted: {},
  link_clicked: {},
  calendar_booked: {},
  // 固定日時は置かない (実行時点で過去になると下書き保存が「これからの日時」で弾く)。
  datetime: { at: new Date(Date.now() + 48 * 3600 * 1000).toISOString(), friendIds: ['friend-1'] },
  daily: { time: '10:00', friendIds: ['friend-1'] },
  weekly: { time: '10:00', weekdays: [1, 3], friendIds: ['friend-1'] },
  'ec.order.confirmed': {},
};

describe('下書きの選択可能一覧(#734)', () => {
  let testDb: SqliteD1;

  beforeEach(() => {
    testDb = createTestD1();
    addAccount(testDb.raw, 'account-1');
    testDb.raw.prepare(
      "INSERT INTO tags (id, name, line_account_id) VALUES ('tag-1', '予約', 'account-1')",
    ).run();
    testDb.raw.prepare(
      `INSERT INTO scenarios (id, name, trigger_type, is_active, line_account_id)
       VALUES ('scenario-1', '予約後', 'manual', 1, 'account-1')`,
    ).run();
    testDb.raw.prepare(
      `INSERT INTO friends (id, line_user_id, line_account_id, display_name)
       VALUES ('friend-1', 'U-1', 'account-1', '一郎')`,
    ).run();
    //  共通アクションの選択肢。呼べるのは公開済みだけ。
    testDb.raw.prepare(
      `INSERT INTO common_actions (id, line_account_id, name, status, current_published_version_id)
       VALUES ('common-1', 'account-1', '会員向け一式', 'published', 'cv-1')`,
    ).run();
    // 担当者通知の選択肢。下書き保存で指せる有効なルール。
    testDb.raw.prepare(
      `INSERT INTO notification_rules
         (id, name, event_type, conditions, channels, line_account_id, is_active, version)
       VALUES ('notify-1', '担当者通知', 'booking_created', '{}', '["dashboard"]', 'account-1', 1, 1)`,
    ).run();
    testDb.raw.prepare(
      `INSERT INTO common_action_versions (id, common_action_id, version_number, status, action_config)
       VALUES ('cv-1', 'common-1', 1, 'published', '[]')`,
    ).run();
  });

  it('S1: 共有のきっかけ = 下書きunion(過不足なし)', () => {
    const union = unionMembers(draftSource(), 'AutomationDraftTriggerType');
    expect(new Set(AUTOMATION_DRAFT_TRIGGER_OPTIONS.map((option) => option.value))).toEqual(new Set(union));
  });

  it('S2: 選択肢と保持専用の待機を合わせて下書きの保存型と一致する', () => {
    const union = unionMembers(draftSource(), 'AutomationDraftActionType');
    expect(new Set([...AUTOMATION_DRAFT_ACTION_OPTIONS.map((option) => option.value), 'wait'])).toEqual(new Set(union));
    expect(AUTOMATION_DRAFT_ACTION_OPTIONS.some(option => option.value === 'wait')).toBe(false);
  });

  it('S3: 共有のきっかけ ⊆ 実行門(出来事門+定期門)', () => {
    const gates = new Set([
      ...EVENT_TRIGGER_TYPES,
      ...SCHEDULE_TRIGGER_TYPES,
    ]);
    for (const option of AUTOMATION_DRAFT_TRIGGER_OPTIONS) {
      expect(gates.has(option.value), `門に無いきっかけ: ${option.value}`).toBe(true);
    }
  });

  /*
   * `common_action` は実行器を持たない。 : 実行計画
   * （automation-engine.ts の buildExecutionPlan）が公開済みの版へ固定し、
   * `common_action_marker` と中身の処理へ展開する。だから直接の実行器鍵は
   * 持たず、計画側で `type === 'common_action'` を特別扱いする。
   */
  it('S4: 共有の処理 ⊆ 実行器の鍵（共通アクションは展開・待機はエンジンで処理）', () => {
    const keys = new Set(Object.keys(createAutomationActionExecutors({})));
    // 共通アクションの展開と版の固定は automation-engine.test.ts が実行して確かめる。
    for (const option of AUTOMATION_DRAFT_ACTION_OPTIONS) {
      if (option.value === 'common_action' || option.value === 'wait') continue;
      expect(keys.has(option.value), `実行器に無い処理: ${option.value}`).toBe(true);
    }
  });

  it('S5: 共有の全きっかけと全処理を下書き保存が受け付ける', async () => {
    for (const trigger of AUTOMATION_DRAFT_TRIGGER_OPTIONS) {
      for (const action of AUTOMATION_DRAFT_ACTION_OPTIONS) {
        const created = await createAutomationDraftFromTemplate(testDb.db, {
          templateKey: 'received-message-tag',
          lineAccountId: 'account-1',
          // 組み合わせごとに別の新規作成。同じ鍵だと同じ下書きへ戻る。
          operationKey: `op-${trigger.value}-${action.value}`,
        });
        await updateAutomationDraft(testDb.db, {
          id: created.id,
          lineAccountId: 'account-1',
          expectedDraftVersionId: created.draftVersionId,
          name: `接続確認 ${trigger.value} ${action.value}`,
          eventType: trigger.value,
          triggerConfig: TRIGGER_CONFIGS[trigger.value] ?? {},
          actions: [{
            id: 'step-1',
            type: action.value,
            params: action.value === 'wait'
              ? { durationMinutes: 5 }
              : action.value === 'add_tag'
              ? { tagId: 'tag-1' }
              : action.value === 'start_scenario'
                ? { scenarioId: 'scenario-1' }
                : action.value === 'common_action'
                  ? { commonActionId: 'common-1' }
                  : action.value === 'notify_staff'
                    ? { notificationRuleId: 'notify-1', message: '確認' }
                    : { messageType: 'text', content: '確認' },
            onFailure: 'stop',
          }],
        });
      }
    }
  });

  it('S6: union外のきっかけ・処理は保存しない', async () => {
    const created = await createAutomationDraftFromTemplate(testDb.db, {
      templateKey: 'received-message-tag',
      lineAccountId: 'account-1',
      operationKey: 'op-out-of-range',
    });
    await expect(updateAutomationDraft(testDb.db, {
      id: created.id,
      lineAccountId: 'account-1',
      expectedDraftVersionId: created.draftVersionId,
      name: '範囲外のきっかけ',
      eventType: 'postback_received',
      triggerConfig: {},
      actions: [{ id: 'step-1', type: 'send_message', params: { messageType: 'text', content: 'x' }, onFailure: 'stop' }],
    })).rejects.toMatchObject({ code: 'trigger_unsupported' });
    await expect(updateAutomationDraft(testDb.db, {
      id: created.id,
      lineAccountId: 'account-1',
      expectedDraftVersionId: created.draftVersionId,
      name: '範囲外の処理',
      eventType: 'message_received',
      triggerConfig: {},
      actions: [{ id: 'step-1', type: 'remove_tag', params: { tagId: 'tag-1' }, onFailure: 'stop' }],
    })).rejects.toMatchObject({ code: 'action_unsupported' });
  });
});
