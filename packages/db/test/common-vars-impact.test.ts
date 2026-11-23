import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getCommonVarMap, getCommonVarUsageImpact } from '../src/common-vars/index';
import { asD1 } from './d1-test-helper';

describe('common variable usage impact', () => {
  it('returns selected-account details while keeping legacy forms safe', async () => {
    const raw = new Database(':memory:');
    raw.exec(readFileSync(join(process.cwd(), 'bootstrap.sql'), 'utf8'));
    raw.exec(`
      INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
      VALUES ('a1','c1','A1','t','s'), ('a2','c2','A2','t','s');
      INSERT INTO templates (id, name, message_type, message_content, line_account_id)
      VALUES ('t1','A1テンプレート','text','営業時間は{{var.shop_hours}}','a1'),
             ('t2','A2テンプレート','text','営業時間は{{var.shop_hours}}','a2');
      INSERT INTO broadcasts (id, title, message_type, message_content, target_type, status, line_account_id, account_ids)
      VALUES ('b1','予約中','text','{{var.shop_hours}}です','all','scheduled','a1',NULL),
             ('b2','送信済み','text','{{var.shop_hours}}でした','all','sent','a1',NULL),
             ('b3','複数アカウント','text','{{var.shop_hours}}です','multi-account-dedup','draft','a2','["a2","a1"]');
      INSERT INTO scenarios (id, name, trigger_type, line_account_id)
      VALUES ('s1','来店後','manual','a1'), ('s2','別アカウント','manual','a2');
      INSERT INTO scenario_steps (id, scenario_id, step_order, delay_minutes, message_type, message_content)
      VALUES ('ss1','s1',1,0,'text','次は{{var.shop_hours}}'),
             ('ss2','s2',1,0,'text','次は{{var.shop_hours}}');
      INSERT INTO forms (id, name, fields, on_submit_message_content, layout)
      VALUES ('f1','所属未設定フォーム','[]','受付は{{var.shop_hours}}','{}'),
             ('f2','A1フォーム','[]','受付は{{var.shop_hours}}','{}'),
             ('f3','A2フォーム','[]','受付は{{var.shop_hours}}','{}');
      INSERT INTO form_accounts (form_id, line_account_id)
      VALUES ('f2','a1'), ('f3','a2');
    `);

    const impact = await getCommonVarUsageImpact(asD1(raw), 'shop_hours', 'a1');

    expect(impact).toMatchObject({
      total: 7,
      blockingTotal: 6,
      historicalTotal: 1,
      unscopedFormTotal: 1,
      byKind: { template: 1, broadcast: 3, scenario: 1, form: 2 },
    });
    expect(impact.items.map((item) => item.source_id)).toEqual([
      't1', 'b1', 'b2', 'b3', 'ss1', 'f2',
    ]);
    expect(impact.items.some((item) => item.source_name.includes('A2'))).toBe(false);
    expect(impact.items.some((item) => item.source_name.includes('所属未設定'))).toBe(false);
    raw.close();
  });

  /*
    送信を始めた配信は送信開始時点の値の写し（snapshot）を持ち、
    共通情報を直してもその配信は変わらない。「配信中だから変わる」と
    数えると画面の説明と処理がずれるので、写しの有無で分ける。
  */
  it('送信を始めた配信は値の写しの有無で「変わる側」と分ける', async () => {
    const raw = new Database(':memory:');
    raw.exec(readFileSync(join(process.cwd(), 'bootstrap.sql'), 'utf8'));
    raw.exec(`
      INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
      VALUES ('a1','c1','A1','t','s');
      INSERT INTO broadcasts
        (id, title, message_type, message_content, target_type, status, line_account_id,
         common_var_snapshot)
      VALUES
        ('b-fixed','固定済み','text','{{var.shop_hours}}です','all','sending','a1',
         '{"values":{"shop_hours":"10-18"}}'),
        ('b-live','写しなし','text','{{var.shop_hours}}です','all','sending','a1',NULL),
        ('b-scheduled','予約中','text','{{var.shop_hours}}です','all','scheduled','a1',NULL);
    `);

    const impact = await getCommonVarUsageImpact(asD1(raw), 'shop_hours', 'a1');

    expect(impact).toMatchObject({ total: 3, blockingTotal: 2, sendingFixedTotal: 1 });
    const statusById = new Map(impact.items.map((item) => [item.source_id, item.source_status]));
    expect(statusById.get('b-fixed')).toBe('sending_fixed');
    expect(statusById.get('b-live')).toBe('sending');
    expect(statusById.get('b-scheduled')).toBe('scheduled');
    raw.close();
  });

  it('送信開始時の版は対象アカウントの写しから読み、別アカウントの版を使わない', async () => {
    const raw = new Database(':memory:');
    raw.exec(readFileSync(join(process.cwd(), 'bootstrap.sql'), 'utf8'));
    raw.exec(`INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
      VALUES ('a1','c1','A1','t','s'), ('a2','c2','A2','t','s');
      INSERT INTO broadcasts (id, title, message_type, message_content, target_type, status, line_account_id, account_ids, common_var_snapshot)
      VALUES ('b', '配信', 'text', '{{var.shop_hours}}', 'multi-account-dedup', 'sending', 'a1', '["a1","a2"]',
      '{"accounts":{"a1":{"entries":[{"varKey":"shop_hours","version":3}]},"a2":{"entries":[{"varKey":"shop_hours","version":9}]}}}');`);
    expect((await getCommonVarUsageImpact(asD1(raw), 'shop_hours', 'a1')).items[0].fixed_version).toBe(3);
    expect((await getCommonVarUsageImpact(asD1(raw), 'shop_hours', 'a2')).items[0].fixed_version).toBe(9);
    raw.close();
  });

  it('下書きの固定版をアカウント別に読み、削除の使用先として残す', async () => {
    const raw = new Database(':memory:');
    raw.exec(readFileSync(join(process.cwd(), 'bootstrap.sql'), 'utf8'));
    raw.exec(`INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret) VALUES ('a1','c1','店','t','s'),('a2','c2','別','t','s');
      INSERT INTO common_vars(id,line_account_id,name,var_key,value,version) VALUES ('v1','a1','営業時間','shop_hours','新',2),('v2','a2','営業時間','shop_hours','別',1);
      INSERT INTO common_var_versions(id,common_var_id,version_no,name,value,change_reason) VALUES ('old','v1',1,'営業時間','旧','変更');
      INSERT INTO broadcasts(id,title,message_type,message_content,target_type,status,line_account_id,account_ids) VALUES ('b','案内','text','{{var.shop_hours}}','multi-account-dedup','draft','a1','["a1","a2"]');
      INSERT INTO broadcast_common_var_pins(broadcast_id,common_var_id,version_id) VALUES ('b','v1','old');`);
    const first = await getCommonVarUsageImpact(asD1(raw), 'shop_hours', 'a1');
    expect(first.items.find((item) => item.source_id === 'b')).toMatchObject({ fixed_version: 1, fixed_value: '旧' });
    expect(first.blockingTotal).toBe(1);
    expect((await getCommonVarUsageImpact(asD1(raw), 'shop_hours', 'a2')).items.find((item) => item.source_id === 'b')?.fixed_version).toBeUndefined();
    raw.close();
  });

  it('アーカイブ済みの情報に結びついた固定は現在の固定と表示しない', async () => {
    const raw = new Database(':memory:');
    raw.exec(readFileSync(join(process.cwd(), 'bootstrap.sql'), 'utf8'));
    raw.exec(`INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret) VALUES ('a','c','店','t','s');
      INSERT INTO common_vars(id,line_account_id,name,var_key,value,archived_at) VALUES ('old','a','旧','shop_hours','旧','2026-01-01');
      INSERT INTO common_var_versions(id,common_var_id,version_no,name,value,change_reason) VALUES ('old-v','old',1,'旧','旧','変更');
      INSERT INTO broadcasts(id,title,message_type,message_content,target_type,status,line_account_id) VALUES ('b','案内','text','{{var.shop_hours}}','all','draft','a');
      INSERT INTO broadcast_common_var_pins(broadcast_id,common_var_id,version_id) VALUES ('b','old','old-v');`);
    const impact = await getCommonVarUsageImpact(asD1(raw), 'shop_hours', 'a');
    expect(impact.items.find((item) => item.source_id === 'b')?.fixed_version).toBeUndefined();
    raw.close();
  });

  it('does not hide a failed scan as zero usages', async () => {
    const db = {
      prepare: vi.fn(() => ({
        bind: () => ({ all: async () => { throw new Error('table unavailable'); } }),
      })),
    } as unknown as D1Database;

    await expect(getCommonVarUsageImpact(db, 'shop_hours', 'a1')).rejects.toThrow('table unavailable');
  });

  it('counts structured messages, shared legacy rules, and value-changing actions', async () => {
    const raw = new Database(':memory:');
    raw.exec(readFileSync(join(process.cwd(), 'bootstrap.sql'), 'utf8'));
    raw.exec(`
      BEGIN;
      INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
      VALUES ('a1','c1','A1','t','s');
      INSERT INTO templates
        (id, name, message_type, message_content, question_json, line_account_id)
      VALUES
        ('template-q','質問','text','質問です',
         '{"text":"受付は{{var.shop_hours}}","tapMode":"single","choices":[]}', 'a1');
      INSERT INTO broadcasts
        (id, title, message_type, message_content, target_type, status, line_account_id,
         message_bubbles_json)
      VALUES
        ('broadcast-bubbles','複数吹き出し','text','本文','all','draft','a1',
         '[{"type":"text","text":"{{var.shop_hours}}"}]');
      INSERT INTO scenarios (id, name, trigger_type, line_account_id)
      VALUES ('scenario-1','来店後','manual','a1');
      INSERT INTO scenario_steps
        (id, scenario_id, step_order, delay_minutes, message_type, message_content, question_json)
      VALUES
        ('step-question','scenario-1',1,0,'text','本文',
         '{"text":"{{var.shop_hours}}","tapMode":"single","choices":[]}');
      INSERT INTO scenario_actions
        (id, scenario_id, hook, sort_order, action_type, config_json)
      VALUES
        ('scenario-action','scenario-1','scenario_completed',0,'common_var',
         '{"varKey":"shop_hours","op":"add","value":"1"}');
      INSERT INTO auto_replies
        (id, keyword, response_content, line_account_id, name, actions_json)
      VALUES
        ('auto-a1','受付','本文','a1','A1の自動応答',
         '[{"kind":"row","actionType":"common_var","config":{"varKey":"shop_hours","op":"add","value":"1"}}]'),
        ('auto-unscoped','受付2','本文',NULL,'所属不明の自動応答',
         '[{"kind":"row","actionType":"common_var","config":{"varKey":"shop_hours","op":"add","value":"1"}}]');
      INSERT INTO automations (id, name, event_type, actions, line_account_id)
      VALUES
        ('automation-a1','A1の旧自動化','friend_add',
         '[{"type":"common_var","varKey":"shop_hours"}]','a1'),
        ('automation-unscoped','所属不明の旧自動化','friend_add',
         '[{"type":"common_var","varKey":"shop_hours"}]',NULL);
      INSERT INTO automation_definitions (id, line_account_id, name)
      VALUES ('automation-v6','a1','V6自動化');
      INSERT INTO automation_versions
        (id, automation_id, version_number, trigger_type, action_config)
      VALUES
        ('automation-version','automation-v6',1,'manual',
         '[{"type":"common_var","varKey":"shop_hours"}]');
      UPDATE automation_definitions
         SET current_draft_version_id = 'automation-version'
       WHERE id = 'automation-v6';
      INSERT INTO account_settings (id, line_account_id, key, value)
      VALUES
        ('friend-add-setting','a1','friend_add_routing',
         '{"firstTime":{"actions":[{"kind":"row","actionType":"common_var","config":{"varKey":"shop_hours","op":"add","value":"1"}}]}}');
      INSERT INTO common_actions (id, line_account_id, name)
      VALUES ('common-action','a1','在庫を増やす');
      INSERT INTO common_action_versions
        (id, common_action_id, version_number, action_config)
      VALUES
        ('common-action-version','common-action',1,
         '[{"type":"common_var","varKey":"shop_hours"}]');
      UPDATE common_actions
         SET current_draft_version_id = 'common-action-version'
       WHERE id = 'common-action';
      COMMIT;
    `);

    const impact = await getCommonVarUsageImpact(asD1(raw), 'shop_hours', 'a1');

    expect(impact).toMatchObject({
      total: 9,
      blockingTotal: 9,
      historicalTotal: 0,
      byKind: {
        template: 1,
        broadcast: 1,
        scenario: 2,
        auto_reply: 1,
        automation: 2,
        friend_add: 1,
        common_action: 1,
      },
    });
    expect(impact.items.map((item) => item.source_id)).toEqual([
      'template-q',
      'broadcast-bubbles',
      'step-question',
      'scenario-action',
      'auto-a1',
      'automation-a1',
      'automation-v6',
      'friend-add-setting',
      'common-action',
    ]);
    expect(impact.items.some((item) => item.source_name.includes('所属不明'))).toBe(false);
    raw.close();
  });
});

describe('common variable account scope', () => {
  it('returns only values assigned to the requested LINE account', async () => {
    const raw = new Database(':memory:');
    raw.exec(readFileSync(join(process.cwd(), 'bootstrap.sql'), 'utf8'));
    raw.exec(`
      INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
      VALUES ('a1','c1','A1','t','s'), ('a2','c2','A2','t','s');
      INSERT INTO common_vars (id, line_account_id, name, var_key, value)
      VALUES
        ('v1','a1','営業時間','hours','10-18'),
        ('v2','a2','電話番号','phone','000'),
        ('legacy',NULL,'所属不明','legacy_key','hidden');
    `);

    await expect(getCommonVarMap(asD1(raw), 'a1')).resolves.toEqual({ hours: '10-18' });
    await expect(getCommonVarMap(asD1(raw), 'a2')).resolves.toEqual({ phone: '000' });
    await expect(getCommonVarMap(asD1(raw), null)).resolves.toEqual({});

    raw.exec(`
      INSERT INTO templates (id, line_account_id, name, category, message_type, message_content)
      VALUES
        ('t1','a1','A1の案内','general','text','{{var.hours}}'),
        ('t2','a2','A2の案内','general','text','{{var.hours}}');
    `);
    await expect(getCommonVarUsageImpact(asD1(raw), 'hours', 'a1')).resolves.toMatchObject({
      total: 1,
      byKind: { template: 1 },
    });
    await expect(getCommonVarUsageImpact(asD1(raw), 'hours', 'a2')).resolves.toMatchObject({
      total: 1,
      byKind: { template: 1 },
    });
    raw.close();
  });
});
