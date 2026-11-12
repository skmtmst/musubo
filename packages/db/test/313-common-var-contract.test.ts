import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CommonVarVersionConflictError,
  applyCommonVarReplacementPlan,
  getCommonVarById,
  getCommonVarReplacementCandidates,
  getCommonVarReplacementPlan,
  getCommonVarUsageSummaries,
  getCommonVarVersions,
  updateCommonVar,
} from '../src/common-vars/index.js';

function asD1(sqlite: Database.Database): D1Database {
  const prepare = (sql: string): D1PreparedStatement => {
    const make = (params: unknown[]): D1PreparedStatement => {
      const execute = () => {
        const statement = sqlite.prepare(sql);
        if (statement.reader) {
          return { success: true, results: statement.all(...params), meta: { changes: 0 } };
        }
        const result = statement.run(...params);
        return { success: true, results: [], meta: { changes: result.changes } };
      };
      return {
        bind: (...next: unknown[]) => make(next),
        async all<T>() {
          return { success: true, results: sqlite.prepare(sql).all(...params) as T[], meta: {} };
        },
        async first<T>() {
          return (sqlite.prepare(sql).get(...params) as T | undefined) ?? null;
        },
        async run<T>() {
          return execute() as T;
        },
        raw: async () => [],
        __execute: execute,
      } as unknown as D1PreparedStatement;
    };
    return make([]);
  };
  return {
    prepare,
    async batch(statements: D1PreparedStatement[]) {
      const transaction = sqlite.transaction(() => statements.map((statement) =>
        (statement as unknown as { __execute: () => D1Result }).__execute()));
      return transaction();
    },
  } as unknown as D1Database;
}

describe('migration 313 共通情報の使用数・履歴・差し替え', () => {
  let sqlite: Database.Database;
  let db: D1Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    sqlite.exec(readFileSync(join(import.meta.dirname, '..', 'bootstrap.sql'), 'utf8'));
    sqlite.exec(`
      INSERT INTO line_accounts
        (id, channel_id, name, channel_access_token, channel_secret)
      VALUES ('account-1', 'channel-1', '本店', 'token', 'secret'),
             ('account-2', 'channel-2', '支店', 'token', 'secret');
      INSERT INTO common_vars
        (id, line_account_id, name, var_key, type, value, memo, version)
      VALUES ('source', 'account-1', '旧営業時間', 'old_hours', 'text', '10-19', '旧値', 1),
             ('replacement', 'account-1', '新営業時間', 'new_hours', 'text', '11-20', '新値', 2),
             ('other-account', 'account-2', '別店舗', 'other_hours', 'text', '9-18', '', 1),
             ('other-type', 'account-1', '画像', 'shop_image', 'image', 'media-1', '', 1);
      INSERT INTO common_var_versions
        (id, common_var_id, version_no, name, value, memo, change_reason)
      VALUES ('source-v1', 'source', 1, '旧営業時間', '10-19', '旧値', '作成'),
             ('replacement-v2', 'replacement', 2, '新営業時間', '11-20', '新値', '編集');
      INSERT INTO templates
        (id, line_account_id, name, message_type, message_content)
      VALUES ('template-1', 'account-1', '予約案内', 'text', '営業時間は{{var.old_hours}}です');
      INSERT INTO scenarios (id, line_account_id, name, trigger_type)
      VALUES ('scenario-1', 'account-1', '来店後', 'manual');
      INSERT INTO scenario_actions (id, scenario_id, hook, action_type, config_json)
      VALUES ('action-1', 'scenario-1', 'scenario_completed', 'common_var', '{"varKey":"old_hours","operation":"set"}');
    `);
    db = asD1(sqlite);
  });

  afterEach(() => sqlite.close());

  it('一覧用集計は種類別件数を1回で返す', async () => {
    const summaries = await getCommonVarUsageSummaries(db, ['old_hours'], 'account-1');
    expect(summaries.get('old_hours')).toMatchObject({
      total: 2,
      byKind: { template: 1, scenario: 1 },
    });
  });

  it('社内メモを版付きで更新し、古い版の更新は409用の競合になる', async () => {
    const updated = await updateCommonVar(db, 'source', 'account-1', {
      memo: '繁忙期だけ延長',
      expectedVersion: 1,
      actorId: 'staff-1',
      changeReason: '営業時間変更',
    });
    expect(updated).toMatchObject({ memo: '繁忙期だけ延長', version: 2, updated_by: 'staff-1' });
    const history = await getCommonVarVersions(db, 'source', 'account-1');
    expect(history[0]).toMatchObject({
      version_no: 2,
      memo: '繁忙期だけ延長',
      change_reason: '営業時間変更',
      actor_id: 'staff-1',
    });
    await expect(updateCommonVar(db, 'source', 'account-1', {
      value: '12-20', expectedVersion: 1,
    })).rejects.toBeInstanceOf(CommonVarVersionConflictError);
  });

  it('候補を同一アカウント・同一種類に絞り、本文と構造化参照を一括差し替える', async () => {
    const source = (await getCommonVarById(db, 'source', 'account-1'))!;
    const replacement = (await getCommonVarById(db, 'replacement', 'account-1'))!;
    const candidates = await getCommonVarReplacementCandidates(db, source);
    expect(candidates.map((item) => item.id)).toEqual(['replacement']);

    const plan = await getCommonVarReplacementPlan(db, source, replacement);
    expect(plan).toMatchObject({ replaceableTotal: 2, blockedTotal: 0, historicalTotal: 0 });
    const result = await applyCommonVarReplacementPlan(db, plan, 'staff-1', 'キー名の統一');
    expect(result.replacedUsageCount).toBe(2);
    expect(sqlite.prepare(`SELECT message_content FROM templates WHERE id = 'template-1'`).get())
      .toEqual({ message_content: '営業時間は{{var.new_hours}}です' });
    expect(JSON.parse((sqlite.prepare(`SELECT config_json FROM scenario_actions WHERE id = 'action-1'`).get() as { config_json: string }).config_json))
      .toMatchObject({ varKey: 'new_hours' });
    expect(sqlite.prepare(`SELECT archived_at, replacement_run_id FROM common_vars WHERE id = 'source'`).get())
      .toMatchObject({ archived_at: expect.any(String), replacement_run_id: result.runId });
    expect(sqlite.prepare(`SELECT replaced_usage_count, status FROM common_var_replacement_runs`).get())
      .toEqual({ replaced_usage_count: 2, status: 'completed' });
  });

  it('差し替えたテンプレート・自動応答と対象設定だけ確認版を進める', async () => {
    sqlite.exec(`INSERT INTO auto_replies(id,line_account_id,keyword,response_content,actions_json) VALUES('reply-1','account-1','受付','{{var.old_hours}}','[{"varKey":"old_hours"}]');
      INSERT INTO account_settings(id,line_account_id,key,value) VALUES('setting-1','account-1','test_recipients','{{var.old_hours}}'),('setting-2','account-1','friend_add_routing','{{var.old_hours}}');`);
    const source=(await getCommonVarById(db,'source','account-1'))!, replacement=(await getCommonVarById(db,'replacement','account-1'))!;
    const plan=await getCommonVarReplacementPlan(db,source,replacement);
    expect(plan.blockedTotal).toBe(0);
    plan.targets.push({table:'account_settings',id:'setting-1',kind:'friend_add',columns:{value:'{{var.new_hours}}'},originalColumns:{value:'{{var.old_hours}}'},fingerprint:''});
    await applyCommonVarReplacementPlan(db,plan,'staff-1','差し替え');
    expect(sqlite.prepare("SELECT confirmation_revision FROM templates WHERE id='template-1'").get()).toEqual({confirmation_revision:2});
    expect(sqlite.prepare("SELECT confirmation_revision FROM auto_replies WHERE id='reply-1'").get()).toEqual({confirmation_revision:2});
    expect(sqlite.prepare("SELECT id,confirmation_revision FROM account_settings ORDER BY id").all()).toEqual([{id:'setting-1',confirmation_revision:2},{id:'setting-2',confirmation_revision:1}]);
  });

  it('下書きから外しても現在の公開フォームが使う変数の差し替えを止める', async () => {
    sqlite.prepare(
      `INSERT INTO forms (id, name, on_submit_message_content, status)
       VALUES ('published-form', '公開中フォーム', '営業時間は{{var.old_hours}}', 'active')`,
    ).run();
    sqlite.prepare(
      `INSERT INTO form_accounts (form_id, line_account_id) VALUES ('published-form', 'account-1')`,
    ).run();
    sqlite.prepare(
      `UPDATE forms SET on_submit_message_content = '営業時間は{{var.new_hours}}' WHERE id = 'published-form'`,
    ).run();
    const source = (await getCommonVarById(db, 'source', 'account-1'))!;
    const replacement = (await getCommonVarById(db, 'replacement', 'account-1'))!;

    const plan = await getCommonVarReplacementPlan(db, source, replacement);
    expect(plan).toMatchObject({ usageTotal: 3, replaceableTotal: 2, blockedTotal: 1 });
    await expect(applyCommonVarReplacementPlan(db, plan, 'staff-1', 'キー名の統一'))
      .rejects.toThrow('Common variable replacement is blocked');
    expect(sqlite.prepare(
      `SELECT on_submit_message_content FROM form_versions WHERE form_id = 'published-form'`,
    ).get()).toEqual({ on_submit_message_content: '営業時間は{{var.old_hours}}' });
  });

  it('プレビュー後に本文が変わったら、一部だけ置換せず全体をロールバックする', async () => {
    const source = (await getCommonVarById(db, 'source', 'account-1'))!;
    const replacement = (await getCommonVarById(db, 'replacement', 'account-1'))!;
    const plan = await getCommonVarReplacementPlan(db, source, replacement);
    sqlite.prepare(`UPDATE templates SET message_content = ? WHERE id = 'template-1'`)
      .run('別の担当者が編集中 {{var.old_hours}}');

    await expect(applyCommonVarReplacementPlan(db, plan, 'staff-1', 'キー名の統一')).rejects.toThrow();
    expect(sqlite.prepare(`SELECT archived_at FROM common_vars WHERE id = 'source'`).get())
      .toEqual({ archived_at: null });
    expect(JSON.parse((sqlite.prepare(`SELECT config_json FROM scenario_actions WHERE id = 'action-1'`).get() as { config_json: string }).config_json))
      .toMatchObject({ varKey: 'old_hours' });
    expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM common_var_replacement_runs`).get())
      .toEqual({ count: 0 });
  });
});
