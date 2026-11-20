import { describe, expect, it, vi, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../worker-env.js';
import { createTestD1 } from '../test-utils/d1-sqlite.js';
import { inputJsonBoundary } from '../lib/input-errors.js';
import * as openingHours from '../services/account-opening-hours.js';
import { putScenarioCommonVarPin } from './scenario-common-var-pins.js';
import { scenarios } from './scenarios.js';

describe('シナリオの共通情報固定', () => {
  afterEach(() => vi.restoreAllMocks());
  it('対象の通の同じアカウントの版のみ固定し、競合とGoogle連携を拒む', async () => {
    const { db, raw } = createTestD1();
    raw.exec(`INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret) VALUES ('a','c','A','t','s'),('b','d','B','t','s');
      INSERT INTO scenarios(id,name,trigger_type,line_account_id) VALUES('sc','案内','manual','a');
      INSERT INTO scenario_steps(id,scenario_id,step_order,message_type,message_content) VALUES('step','sc',0,'text','{{ var.business_hours }}');
      INSERT INTO common_vars(id,line_account_id,name,var_key,value) VALUES('var','a','営業時間','business_hours','新'),('other','b','別','business_hours','別');
      INSERT INTO common_var_versions(id,common_var_id,version_no,name,value,change_reason) VALUES('old','var',1,'営業時間','旧','test'),('wrong','other',1,'別','別','test');`);
    const app = new Hono<Env>();
    app.use('*', async (c, next) => { c.env = { DB: db } as Env['Bindings']; await next(); });
    app.put('/api/scenarios/:id/steps/:stepId/common-var-pins/:varId', inputJsonBoundary({ accountId: ['string'], versionId: ['string','null'], expectedVersion: ['number'] }), putScenarioCommonVarPin);
    const put = (versionId: string | null, expectedVersion: number) => app.request('/api/scenarios/sc/steps/step/common-var-pins/var', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accountId: 'a', versionId, expectedVersion }) });
    expect((await put('wrong',1)).status).toBe(409);
    vi.spyOn(openingHours, 'accountOpeningHours').mockResolvedValueOnce({ source: 'google_unavailable', profile: null });
    expect((await put('old',1)).status).toBe(409);
    expect((await put('old',1)).status).toBe(200);
    expect((await put(null,1)).status).toBe(409);
    expect((await put(null,2)).status).toBe(200);
    expect(raw.prepare('SELECT count(*) AS n FROM scenario_step_common_var_pins').get()).toEqual({ n: 0 });
    const scopedApp = new Hono<Env>();
    scopedApp.use('*', async (c, next) => { c.env = { DB: db } as Env['Bindings']; c.set('staff', { id:'scoped',name:'Scoped',role:'owner',readOnly:false,featureEnabledLineAccountIds:['b'] }); await next(); });
    scopedApp.route('/', scenarios);
    const forbidden = await scopedApp.request('/api/scenarios/sc/steps/step/common-var-pins/var', {method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({accountId:'a',versionId:'old',expectedVersion:3})});
    expect(forbidden.status).toBe(404);
    expect(raw.prepare('SELECT count(*) AS n FROM scenario_step_common_var_pins').get()).toEqual({ n: 0 });
    raw.close();
  });
});
