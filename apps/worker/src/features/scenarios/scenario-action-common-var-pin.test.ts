import { describe, expect, it, vi } from 'vitest';
import { getCommonVarUsageImpact, parseScenarioVersionActions, publishScenarioVersion } from '@line-crm/db';
import { createTestD1, insertFriend } from '../../test-utils/d1-sqlite.js';
import { runPinnedScenarioActions, runScenarioActions } from './scenario-actions.js';

describe('公開版の送信アクション', () => {
  it('固定済み本文と未固定テンプレートが混在した公開版は変わる側に数える', async () => {
    const {db,raw}=createTestD1();
    raw.exec(`INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret) VALUES('a','channel','A','token','secret');
      INSERT INTO scenarios(id,name,trigger_type,line_account_id) VALUES('sc','案内','manual','a');
      INSERT INTO scenario_steps(id,scenario_id,step_order,message_type,message_content) VALUES('step','sc',0,'text','本文');
      INSERT INTO templates(id,name,message_type,message_content,line_account_id) VALUES('tpl','案内','text','{{var.notice}}','a');
      INSERT INTO scenario_actions(id,scenario_id,hook,sort_order,action_type,config_json) VALUES
        ('a1','sc','scenario_completed',0,'send_message','{"content":"{{var.notice}}"}'),
        ('a2','sc','scenario_completed',1,'send_template','{"templateId":"tpl"}');
      INSERT INTO common_vars(id,line_account_id,name,var_key,value) VALUES('var','a','案内','notice','新');
      INSERT INTO common_var_versions(id,common_var_id,version_no,name,value,change_reason) VALUES('old','var',1,'案内','旧','test');
      INSERT INTO scenario_action_common_var_pins VALUES('a1','var','old');`);
    await publishScenarioVersion(db,'sc',{staffId:null,idempotencyKey:'mixed-actions'});
    const impact=await getCommonVarUsageImpact(db,'notice','a');
    expect(impact.items.find(item=>item.source_table==='scenario_version_actions')?.fixed_version).toBeUndefined();
    raw.close();
  });

  it('テンプレートを送る操作も固定した共通情報を使う', async () => {
    const { db, raw } = createTestD1();
    raw.exec(`INSERT INTO tenants(id,name) VALUES('t','統括');
      INSERT INTO line_accounts(id,tenant_id,channel_id,name,channel_access_token,channel_secret) VALUES('a','t','channel','A','token','secret');
      INSERT INTO scenarios(id,name,trigger_type,line_account_id) VALUES('sc','案内','manual','a');
      INSERT INTO scenario_steps(id,scenario_id,step_order,message_type,message_content) VALUES('step','sc',0,'text','本文');
      INSERT INTO templates(id,name,message_type,message_content,line_account_id) VALUES('tpl','案内','text','{{var.notice}}','a');
      INSERT INTO scenario_actions(id,scenario_id,hook,sort_order,action_type,config_json) VALUES('act','sc','scenario_completed',0,'send_template','{"templateId":"tpl"}');
      INSERT INTO common_vars(id,line_account_id,name,var_key,value) VALUES('var','a','案内','notice','新');
      INSERT INTO common_var_versions(id,common_var_id,version_no,name,value,change_reason) VALUES('old','var',1,'案内','固定した値','test');
      INSERT INTO scenario_action_common_var_pins(scenario_action_id,common_var_id,version_id) VALUES('act','var','old');`);
    insertFriend(raw,'f1',{line_account_id:'a'});
    const version = await publishScenarioVersion(db,'sc',{staffId:null,idempotencyKey:'template-pin'});
    const impact = await getCommonVarUsageImpact(db,'notice','a');
    expect(impact.items.find(item=>item.source_table==='scenario_message_actions')).toMatchObject({source_id:'act',fixed_version:1});
    const pushMessage = vi.fn(async()=>({requestId:'request'}));
    const result=await runPinnedScenarioActions(db,{actions:parseScenarioVersionActions(version),hook:'scenario_completed',friendId:'f1',accountId:'a',sourceEventId:'template-event',
      executorDependencies:{resolveLineAccessToken:async()=> 'token',createLineClient:()=>({pushMessage,linkRichMenuToUser:vi.fn(),unlinkRichMenuFromUser:vi.fn()})}});
    expect(result.executed).toBe(1);
    expect(JSON.stringify(pushMessage.mock.calls)).toContain('固定した値');
    raw.close();
  });

  it('固定した値を送り、共通情報が停止したら送らない', async () => {
    const { db, raw } = createTestD1();
    raw.exec(`INSERT INTO tenants(id,name) VALUES('t','統括');
      INSERT INTO line_accounts(id,tenant_id,channel_id,name,channel_access_token,channel_secret) VALUES('a','t','channel','A','token','secret');
      INSERT INTO scenarios(id,name,trigger_type,line_account_id) VALUES('sc','案内','manual','a');
      INSERT INTO scenario_steps(id,scenario_id,step_order,message_type,message_content) VALUES('step','sc',0,'text','本文');
      INSERT INTO scenario_actions(id,scenario_id,hook,sort_order,action_type,config_json) VALUES('act','sc','scenario_completed',0,'send_message','{"content":"{{var.notice}}"}');
      INSERT INTO common_vars(id,line_account_id,name,var_key,value) VALUES('var','a','案内','notice','新');
      INSERT INTO common_var_versions(id,common_var_id,version_no,name,value,change_reason) VALUES('old','var',1,'案内','固定した値','test');
      INSERT INTO scenario_action_common_var_pins(scenario_action_id,common_var_id,version_id) VALUES('act','var','old');`);
    insertFriend(raw, 'f1', { line_account_id: 'a' });
    const version = await publishScenarioVersion(db, 'sc', { staffId:null, idempotencyKey:'action-pin' });
    const impact = await getCommonVarUsageImpact(db, 'notice', 'a');
    expect(impact.items.find(item => item.source_table === 'scenario_message_actions')).toMatchObject({ source_id:'act', fixed_version:1 });
    expect(impact.items.find(item => item.source_table === 'scenario_version_actions')).toMatchObject({ fixed_version:1 });
    raw.prepare("INSERT INTO common_var_versions(id,common_var_id,version_no,name,value,change_reason) VALUES('next','var',2,'案内','次の値','test')").run();
    raw.prepare("UPDATE scenario_action_common_var_pins SET version_id='next' WHERE scenario_action_id='act'").run();
    raw.prepare("UPDATE scenarios SET content_revision=content_revision+1 WHERE id='sc'").run();
    const next = await publishScenarioVersion(db, 'sc', { staffId:null, idempotencyKey:'action-next' });
    expect(next.id).not.toBe(version.id);
    expect(raw.prepare('SELECT scenario_version_id,version_id FROM scenario_version_action_common_var_pins ORDER BY version_id').all()).toEqual([
      {scenario_version_id:next.id,version_id:'next'}, {scenario_version_id:version.id,version_id:'old'},
    ]);
    const actions = parseScenarioVersionActions(version);
    const pushMessage = vi.fn(async () => ({ requestId: 'request' }));
    const run = (event: string) => runPinnedScenarioActions(db, { actions, hook:'scenario_completed', friendId:'f1', accountId:'a', sourceEventId:event,
      executorDependencies: { resolveLineAccessToken: async () => 'token', createLineClient: () => ({ pushMessage, linkRichMenuToUser:vi.fn(), unlinkRichMenuFromUser:vi.fn() }) } });
    expect((await run('event-1')).executed).toBe(1);
    expect(JSON.stringify(pushMessage.mock.calls)).toContain('固定した値');
    const live = await runScenarioActions(db, { scenarioId:'sc',hook:'scenario_completed',friendId:'f1',accountId:'a',sourceEventId:'legacy-event',
      executorDependencies: { resolveLineAccessToken: async () => 'token', createLineClient: () => ({ pushMessage, linkRichMenuToUser:vi.fn(), unlinkRichMenuFromUser:vi.fn() }) } });
    expect(live.executed).toBe(1);
    expect(JSON.stringify(pushMessage.mock.calls.at(-1))).toContain('新');
    pushMessage.mockClear();
    raw.prepare("UPDATE common_vars SET status='stopped' WHERE id='var'").run();
    expect((await run('event-2')).failed).toBe(1);
    expect(pushMessage).toHaveBeenCalledTimes(0);
    raw.prepare("UPDATE common_vars SET status='active' WHERE id='var'").run();
    const before = raw.prepare('SELECT count(*) AS n FROM outbound_send_requests').get();
    const prepare = db.prepare.bind(db); let reads = 0;
    const spy = vi.spyOn(db, 'prepare').mockImplementation(query => {
      if (query.includes('FROM scenario_version_action_common_var_pins p') && ++reads === 2) raw.prepare("UPDATE common_vars SET status='stopped' WHERE id='var'").run();
      return prepare(query);
    });
    try { expect((await run('event-3')).failed).toBe(1); } finally { spy.mockRestore(); }
    expect(pushMessage).toHaveBeenCalledTimes(0);
    expect(raw.prepare('SELECT count(*) AS n FROM outbound_send_requests').get()).toEqual(before);
    raw.prepare("UPDATE common_vars SET status='active' WHERE id='var'").run();
    expect((await run('event-3')).executed).toBe(1);
    expect(pushMessage).toHaveBeenCalledTimes(1);
    raw.close();
  });
});
