import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../worker-env.js';
import { createTestD1 } from '../test-utils/d1-sqlite.js';
import { inputJsonBoundary } from '../lib/input-errors.js';
import { putScenarioActionCommonVarPin } from './scenario-action-common-var-pins.js';

describe('シナリオ送信アクションの固定', () => {
  it('同じアカウントの使用版だけを固定し、古い編集番号を拒む', async () => {
    const { db, raw } = createTestD1();
    raw.exec(`INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret) VALUES('a','c','A','t','s');
      INSERT INTO scenarios(id,name,trigger_type,line_account_id) VALUES('sc','案内','manual','a');
      INSERT INTO scenario_actions(id,scenario_id,hook,sort_order,action_type,config_json) VALUES('act','sc','scenario_completed',0,'send_message','{"content":"{{var.notice}}"}');
      INSERT INTO common_vars(id,line_account_id,name,var_key,value) VALUES('var','a','案内','notice','新');
      INSERT INTO common_var_versions(id,common_var_id,version_no,name,value,change_reason) VALUES('old','var',1,'案内','旧','test');`);
    const app = new Hono<Env>();
    app.use('*', async (c,next) => { c.env = { DB: db } as Env['Bindings']; await next(); });
    app.put('/api/scenarios/:id/actions/:actionId/common-var-pins/:varId', inputJsonBoundary({accountId:['string'],versionId:['string','null'],expectedVersion:['number']}), putScenarioActionCommonVarPin);
    const put = (versionId: string | null, expectedVersion: number) => app.request('/api/scenarios/sc/actions/act/common-var-pins/var', { method:'PUT', headers:{'content-type':'application/json'}, body:JSON.stringify({accountId:'a',versionId,expectedVersion}) });
    expect((await put('missing',1)).status).toBe(409);
    expect((await put('old',1)).status).toBe(200);
    expect((await put(null,1)).status).toBe(409);
    expect((await put(null,2)).status).toBe(200);
    expect(raw.prepare('SELECT count(*) AS n FROM scenario_action_common_var_pins').get()).toEqual({n:0});
    raw.close();
  });
});
