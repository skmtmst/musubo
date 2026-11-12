import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { Hono } from 'hono';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';
import type { Env } from '../worker-env.js';
import type { AuthenticatedStaff } from '../middleware/auth/principal/auth.js';
import { scenarios } from './scenarios.js';
import { pauseFriendScenarioManual, createScenarioStep, updateScenarioStep } from '@line-crm/db';

let sqlite: SqliteD1;
const editor: AuthenticatedStaff = {
  id: 'editor', name: '担当者', role: 'staff', readOnly: false, tenantId: 'tenant-1',
  permissionKeys: ['/scenarios', 'scenario.definition.edit'],
};
const publisher: AuthenticatedStaff = { ...editor, role: 'admin', permissionKeys: [...editor.permissionKeys!, 'scenario.definition.publish'] };
function app(staff = publisher) {
  const instance = new Hono<Env>();
  instance.use('*', async (c, next) => {
    c.env = { DB: sqlite.db } as Env['Bindings'];
    c.set('staff', staff);
    await next();
  });
  instance.route('/', scenarios);
  return instance;
}
function put(body: unknown, staff = publisher, id = 'sc-1') {
  return app(staff).request(`/api/scenarios/${id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}
function rawScenarioRevision() { return (sqlite.raw.prepare('SELECT content_revision FROM scenarios WHERE id=?').get('sc-1') as { content_revision: number }).content_revision; }
function record() {
  return sqlite.raw.prepare('SELECT is_active, stopped_reason, stopped_by, stopped_at FROM scenarios WHERE id = ?').get('sc-1');
}
beforeEach(() => {
  sqlite = createTestD1();
  sqlite.raw.exec(`
    INSERT INTO tenants (id, name) VALUES ('tenant-1', '会社');
    INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret, tenant_id)
      VALUES ('acc-1', 'channel-1', '本店', 'token', 'secret', 'tenant-1'), ('acc-2', 'channel-2', '支店', 'token', 'secret', 'tenant-1');
    INSERT INTO staff_members (id, name, role, api_key, tenant_id, account_scope, permission_keys)
      VALUES ('editor', '担当者', 'staff', 'test-key', 'tenant-1', 'accounts', '["/scenarios","scenario.definition.edit"]');
    INSERT INTO staff_account_scopes (staff_id, line_account_id, created_at) VALUES ('editor', 'acc-1', '2026-10-07T00:00:00+09:00');
    INSERT INTO scenarios (id, name, trigger_type, line_account_id)
      VALUES ('sc-1', '配信', 'manual', 'acc-1'), ('sc-2', '担当外', 'manual', 'acc-2');
    INSERT INTO friends (id, line_user_id, display_name, line_account_id) VALUES ('friend-1', 'U1', '読者', 'acc-1');
    INSERT INTO friend_scenarios (id, friend_id, scenario_id, current_step_order, status, next_delivery_at)
      VALUES ('sub-1', 'friend-1', 'sc-1', 2, 'active', '2026-10-08T20:00:00+09:00');
  `);
});
afterEach(() => sqlite.raw.close());

describe('シナリオを止める理由', () => {
  test('停止の確認版が古ければ元の状態に戻っていても409、版なしは従来どおり', async () => {
    const detail = await app().request('/api/scenarios/sc-1');
    expect((await detail.json() as { data: { contentRevision: number } }).data.contentRevision).toBe(1);
    expect((await put({ isActive: false, expectedContentRevision: 1 })).status).toBe(200);
    expect((await put({ isActive: true })).status).toBe(200);
    expect((await put({ isActive: false, expectedContentRevision: 1 })).status).toBe(409);
    expect((await put({ isActive: false, expectedContentRevision: 3 })).status).toBe(200);
    expect(rawScenarioRevision()).toBe(4);
  });

  test('確認後に購読状態が変わったら停止せず409を返す', async () => {
    const preview = await app().request('/api/scenarios/sc-1/confirmation');
    expect(preview.status).toBe(200);
    const snapshot = (await preview.json() as { data: { contentRevision: number; activeCount: number; rowIdSum: number; rowIdSquareSum: number } }).data;
    expect(snapshot).toMatchObject({ contentRevision: 1, activeCount: 1, rowIdSum: 1, rowIdSquareSum: 1 });
    expect(await pauseFriendScenarioManual(sqlite.db, 'sub-1')).toBe(true);
    const response = await put({ isActive: false, expectedContentRevision: snapshot.contentRevision, expectedSubscriptions: { activeCount: snapshot.activeCount, rowIdSum: snapshot.rowIdSum, rowIdSquareSum: snapshot.rowIdSquareSum } });
    expect(response.status).toBe(409);
    expect(record()).toMatchObject({ is_active: 1 });
  });

  test('配信が1通進んでも停止でき、新しい購読が増えれば409', async () => {
    const get = async () => (await (await app().request('/api/scenarios/sc-1/confirmation')).json() as { data: { contentRevision: number; activeCount: number; rowIdSum: number; rowIdSquareSum: number } }).data;
    const before = await get();
    sqlite.raw.prepare("UPDATE friend_scenarios SET current_step_order=current_step_order+1, confirmation_revision=confirmation_revision+1 WHERE id='sub-1'").run();
    expect((await put({ isActive: false, expectedContentRevision: before.contentRevision, expectedSubscriptions: { activeCount: before.activeCount, rowIdSum: before.rowIdSum, rowIdSquareSum: before.rowIdSquareSum } })).status).toBe(200);
    await put({ isActive: true });
    const again = await get();
    sqlite.raw.exec("INSERT INTO friends(id,line_user_id,line_account_id) VALUES('friend-2','U2','acc-1'); INSERT INTO friend_scenarios(id,friend_id,scenario_id,current_step_order,status) VALUES('sub-2','friend-2','sc-1',0,'active');");
    expect((await put({ isActive: false, expectedContentRevision: again.contentRevision, expectedSubscriptions: { activeCount: again.activeCount, rowIdSum: again.rowIdSum, rowIdSquareSum: again.rowIdSquareSum } })).status).toBe(409);
  });

  test('最大以外が止まり、既存の停止中の購読が動き出せば409', async () => {
    sqlite.raw.exec("INSERT INTO friends(id,line_user_id,line_account_id) VALUES('f2','U2','acc-1'),('f3','U3','acc-1'); INSERT INTO friend_scenarios(id,friend_id,scenario_id,current_step_order,status) VALUES('paused','f2','sc-1',0,'paused'),('largest','f3','sc-1',0,'active');");
    const snap = (await (await app().request('/api/scenarios/sc-1/confirmation')).json() as { data: { contentRevision: number; activeCount: number; rowIdSum: number; rowIdSquareSum: number } }).data;
    sqlite.raw.exec("UPDATE friend_scenarios SET status='paused' WHERE id='sub-1'; UPDATE friend_scenarios SET status='active' WHERE id='paused';");
    expect((await put({ isActive: false, expectedContentRevision: snap.contentRevision, expectedSubscriptions: { activeCount: snap.activeCount, rowIdSum: snap.rowIdSum, rowIdSquareSum: snap.rowIdSquareSum } })).status).toBe(409);
  });

  test('受け取り中の購読も停止対象に含む', async () => {
    sqlite.raw.exec("INSERT INTO friends(id,line_user_id,line_account_id) VALUES('f2','U2','acc-1'); INSERT INTO friend_scenarios(id,friend_id,scenario_id,current_step_order,status) VALUES('sending','f2','sc-1',0,'delivering');");
    const snap = (await (await app().request('/api/scenarios/sc-1/confirmation?purpose=stop')).json() as { data: { contentRevision: number; activeCount: number; rowIdSum: number; rowIdSquareSum: number } }).data;
    expect(snap).toMatchObject({activeCount:2,rowIdSum:3,rowIdSquareSum:5});
    expect((await put({isActive:false,expectedContentRevision:snap.contentRevision,expectedSubscriptions:{activeCount:snap.activeCount,rowIdSum:snap.rowIdSum,rowIdSquareSum:snap.rowIdSquareSum}})).status).toBe(200);
  });

  test('削除の確認は停止中と完了済みの購読も含む', async () => {
    sqlite.raw.exec("INSERT INTO friends(id,line_user_id,line_account_id) VALUES('f2','U2','acc-1'),('f3','U3','acc-1'); INSERT INTO friend_scenarios(id,friend_id,scenario_id,current_step_order,status) VALUES('paused','f2','sc-1',0,'paused'),('done','f3','sc-1',0,'completed');");
    const data=(await (await app().request('/api/scenarios/sc-1/confirmation?purpose=delete')).json() as {data:{contentRevision:number;activeCount:number;rowIdSum:number;rowIdSquareSum:number;totalCount:number;totalRowIdSum:number;totalRowIdSquareSum:number;referrers:[]}}).data;
    expect(data).toMatchObject({totalCount:3,totalRowIdSum:6,totalRowIdSquareSum:14});
    sqlite.raw.prepare("DELETE FROM friend_scenarios WHERE id='done'").run();
    const res=await app().request('/api/scenarios/sc-1',{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({expectedContentRevision:data.contentRevision,expectedSubscriptions:{activeCount:data.totalCount,rowIdSum:data.totalRowIdSum,rowIdSquareSum:data.totalRowIdSquareSum},expectedActiveSubscriptions:{activeCount:data.activeCount,rowIdSum:data.rowIdSum,rowIdSquareSum:data.rowIdSquareSum},expectedReferrers:data.referrers})});
    expect(res.status).toBe(409);
  });

  test.each(['completed','active'] as const)('削除確認後に購読が %s へ変われば409、最新人数で再確認', async (nextStatus) => {
    if (nextStatus === 'active') sqlite.raw.prepare("UPDATE friend_scenarios SET status='paused' WHERE id='sub-1'").run();
    type Snapshot = {contentRevision:number;activeCount:number;rowIdSum:number;rowIdSquareSum:number;totalCount:number;totalRowIdSum:number;totalRowIdSquareSum:number;referrers:[]};
    const snapshot=async()=> (await (await app().request('/api/scenarios/sc-1/confirmation?purpose=delete')).json() as {data:Snapshot}).data;
    const remove=async(d:Snapshot)=>app().request('/api/scenarios/sc-1',{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({expectedContentRevision:d.contentRevision,expectedSubscriptions:{activeCount:d.totalCount,rowIdSum:d.totalRowIdSum,rowIdSquareSum:d.totalRowIdSquareSum},expectedActiveSubscriptions:{activeCount:d.activeCount,rowIdSum:d.rowIdSum,rowIdSquareSum:d.rowIdSquareSum},expectedReferrers:d.referrers})});
    const before=await snapshot();
    sqlite.raw.prepare("UPDATE friend_scenarios SET status=? WHERE id='sub-1'").run(nextStatus);
    expect((await remove(before)).status).toBe(409);
    const after=await snapshot();
    expect(after.activeCount).toBe(nextStatus === 'active' ? 1 : 0);
    expect((await remove(after)).status).toBe(200);
  });

  test('削除の確認に稼働中の購読集計がなければ拒む', async () => {
    const response = await app().request('/api/scenarios/sc-1', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedContentRevision: 1, expectedSubscriptions: { activeCount: 1, rowIdSum: 1, rowIdSquareSum: 1 }, expectedReferrers: [] }) });
    expect(response.status).toBe(400);
    expect(sqlite.raw.prepare("SELECT id FROM scenarios WHERE id='sc-1'").get()).toBeTruthy();
  });

  test('削除時は表示した稼働中購読の3つの値をそれぞれ照合する', async () => {
    const d=(await (await app().request('/api/scenarios/sc-1/confirmation?purpose=delete')).json() as {data:{contentRevision:number;activeCount:number;rowIdSum:number;rowIdSquareSum:number;totalCount:number;totalRowIdSum:number;totalRowIdSquareSum:number;referrers:[]}}).data;
    const active={activeCount:d.activeCount,rowIdSum:d.rowIdSum,rowIdSquareSum:d.rowIdSquareSum};
    for (const field of ['activeCount','rowIdSum','rowIdSquareSum'] as const) {
      const body={expectedContentRevision:d.contentRevision,expectedSubscriptions:{activeCount:d.totalCount,rowIdSum:d.totalRowIdSum,rowIdSquareSum:d.totalRowIdSquareSum},expectedActiveSubscriptions:{...active,[field]:active[field]+1},expectedReferrers:d.referrers};
      expect((await app().request('/api/scenarios/sc-1',{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).status,field).toBe(409);
    }
  });

  test.each(['stop','delete'] as const)('%s: 件数だけ・合計だけ・二乗だけが違えばそれぞれ409', async (kind) => {
    const data=(await (await app().request(`/api/scenarios/sc-1/confirmation?purpose=${kind}`)).json() as {data:{contentRevision:number;activeCount:number;rowIdSum:number;rowIdSquareSum:number;totalCount:number;totalRowIdSum:number;totalRowIdSquareSum:number;referrers:[]}}).data;
    const expected=kind==='stop' ? {activeCount:data.activeCount,rowIdSum:data.rowIdSum,rowIdSquareSum:data.rowIdSquareSum} : {activeCount:data.totalCount,rowIdSum:data.totalRowIdSum,rowIdSquareSum:data.totalRowIdSquareSum};
    for (const field of ['activeCount','rowIdSum','rowIdSquareSum'] as const) {
      const body={expectedContentRevision:data.contentRevision,expectedSubscriptions:{...expected,[field]:expected[field]+1},...(kind==='stop'?{isActive:false}:{expectedActiveSubscriptions:{activeCount:data.activeCount,rowIdSum:data.rowIdSum,rowIdSquareSum:data.rowIdSquareSum},expectedReferrers:data.referrers})};
      const res=kind==='stop' ? await put(body) : await app().request('/api/scenarios/sc-1',{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      expect(res.status,field).toBe(409);
    }
  });

  test.each(['stop','delete'] as const)('%s: 1・4から2・3への入れ替えは二乗の違いで409', async (kind) => {
    sqlite.raw.exec("INSERT INTO friends(id,line_user_id,line_account_id) VALUES('f2','U2','acc-1'),('f3','U3','acc-1'),('f4','U4','acc-1'); INSERT INTO friend_scenarios(rowid,id,friend_id,scenario_id,current_step_order,status) VALUES(2,'s2','f2','sc-2',0,'active'),(3,'s3','f3','sc-2',0,'active'),(4,'s4','f4','sc-1',0,'active');");
    const data=(await (await app().request(`/api/scenarios/sc-1/confirmation?purpose=${kind}`)).json() as {data:{contentRevision:number;activeCount:number;rowIdSum:number;rowIdSquareSum:number;totalCount:number;totalRowIdSum:number;totalRowIdSquareSum:number;referrers:[]}}).data;
    expect(data).toMatchObject({activeCount:2,rowIdSum:5,rowIdSquareSum:17,totalCount:2,totalRowIdSum:5,totalRowIdSquareSum:17});
    sqlite.raw.exec("UPDATE friend_scenarios SET scenario_id='sc-2' WHERE rowid IN (1,4); UPDATE friend_scenarios SET scenario_id='sc-1' WHERE rowid IN (2,3);");
    const expected=kind==='stop'?{activeCount:data.activeCount,rowIdSum:data.rowIdSum,rowIdSquareSum:data.rowIdSquareSum}:{activeCount:data.totalCount,rowIdSum:data.totalRowIdSum,rowIdSquareSum:data.totalRowIdSquareSum};
    const body={expectedContentRevision:data.contentRevision,expectedSubscriptions:expected,...(kind==='stop'?{isActive:false}:{expectedActiveSubscriptions:{activeCount:data.activeCount,rowIdSum:data.rowIdSum,rowIdSquareSum:data.rowIdSquareSum},expectedReferrers:data.referrers})};
    const res=kind==='stop'?await put(body):await app().request('/api/scenarios/sc-1',{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    expect(res.status).toBe(409);
  });

  test('5万購読の確認付き停止と削除は3秒以内', async () => {
    sqlite.raw.exec(`WITH RECURSIVE n(x) AS (VALUES(2) UNION ALL SELECT x+1 FROM n WHERE x<50000)
      INSERT INTO friends(id,line_user_id,line_account_id) SELECT 'f'||x,'U'||x,'acc-1' FROM n;
      WITH RECURSIVE n(x) AS (VALUES(2) UNION ALL SELECT x+1 FROM n WHERE x<50000)
      INSERT INTO friend_scenarios(rowid,id,friend_id,scenario_id,current_step_order,status) SELECT 20000000+x,'s'||x,'f'||x,'sc-1',0,'active' FROM n;`);
    const get = async () => (await (await app().request('/api/scenarios/sc-1/confirmation?purpose=delete')).json() as { data: { contentRevision: number; activeCount: number; rowIdSum: number; rowIdSquareSum: number; totalCount: number; totalRowIdSum: number; totalRowIdSquareSum: number; referrers: [] } }).data;
    const snapshot = await get();
    const rowIds = Array.from({ length: 49999 }, (_, i) => 20000002 + i);
    const rowIdSum = 1 + rowIds.reduce((sum, id) => sum + id, 0);
    const rowIdSquareSum = 1 + rowIds.reduce((sum, id) => sum + (id % 104729) ** 2, 0);
    expect(snapshot).toMatchObject({ activeCount: 50000, rowIdSum, rowIdSquareSum });
    expect(Number.isSafeInteger(snapshot.rowIdSquareSum)).toBe(true);
    let start = performance.now();
    expect((await put({ isActive: false, expectedContentRevision: snapshot.contentRevision, expectedSubscriptions: { activeCount: snapshot.activeCount, rowIdSum: snapshot.rowIdSum, rowIdSquareSum: snapshot.rowIdSquareSum } })).status).toBe(200);
    const stopMs = performance.now()-start;
    const after = await get();
    start = performance.now();
    const result = await app().request('/api/scenarios/sc-1', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedContentRevision: after.contentRevision, expectedSubscriptions: { activeCount: after.totalCount, rowIdSum: after.totalRowIdSum, rowIdSquareSum: after.totalRowIdSquareSum }, expectedActiveSubscriptions: { activeCount: after.activeCount, rowIdSum: after.rowIdSum, rowIdSquareSum: after.rowIdSquareSum }, expectedReferrers: after.referrers }) });
    const deleteMs = performance.now()-start;
    console.log(`50000 subscriptions: stop=${stopMs.toFixed(1)}ms delete=${deleteMs.toFixed(1)}ms`);
    expect(result.status).toBe(200);
    expect(stopMs).toBeLessThan(3000); expect(deleteMs).toBeLessThan(3000);
  }, 60000);

  test('確認対象が削除済みなら404', async () => {
    sqlite.raw.prepare("DELETE FROM friend_scenarios WHERE scenario_id='sc-1'").run();
    sqlite.raw.prepare("DELETE FROM scenarios WHERE id='sc-1'").run();
    expect((await put({ isActive: false, expectedContentRevision: 1 })).status).toBe(404);
    const res = await app().request('/api/scenarios/sc-1', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedContentRevision: 1, expectedSubscriptions: { activeCount: 0, rowIdSum: 0, rowIdSquareSum: 0 }, expectedReferrers: [] }) });
    expect(res.status).toBe(404);
  });

  test('通の作成と変更・復帰でも親の内容版が進む', async () => {
    const step = await createScenarioStep(sqlite.db, { scenarioId: 'sc-1', stepOrder: 0, messageType: 'text', messageContent: '元の本文' });
    expect(rawScenarioRevision()).toBe(2);
    await updateScenarioStep(sqlite.db, step.id, { message_content: '別の本文' });
    await updateScenarioStep(sqlite.db, step.id, { message_content: '元の本文' });
    expect(rawScenarioRevision()).toBe(4);
  });

  test('通削除は確認版の不一致を409にし、版なしも従来どおり', async () => {
    const step = await createScenarioStep(sqlite.db, { scenarioId: 'sc-1', stepOrder: 0, messageType: 'text', messageContent: '元' });
    const remove = (version?: number) => app().request(`/api/scenarios/sc-1/steps/${step.id}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, ...(version === undefined ? {} : { body: JSON.stringify({ expectedContentRevision: version }) }) });
    await updateScenarioStep(sqlite.db, step.id, { message_content: '別' });
    await updateScenarioStep(sqlite.db, step.id, { message_content: '元' });
    expect((await remove(2)).status).toBe(409);
    expect(sqlite.raw.prepare('SELECT id FROM scenario_steps WHERE id=?').get(step.id)).toBeTruthy();
    expect((await remove(4)).status).toBe(200);
    const legacy = await createScenarioStep(sqlite.db, { scenarioId: 'sc-1', stepOrder: 1, messageType: 'text', messageContent: '旧' });
    expect((await app().request(`/api/scenarios/sc-1/steps/${legacy.id}`, { method: 'DELETE' })).status).toBe(200);
  });

  test('シナリオ削除は購読の変更を409で拒み、一致と版なしは削除できる', async () => {
    const preview = await app().request('/api/scenarios/sc-1/confirmation');
    const snapshot = (await preview.json() as { data: { contentRevision: number; activeCount: number; rowIdSum: number; rowIdSquareSum: number; totalCount: number; totalRowIdSum: number; totalRowIdSquareSum: number } }).data;
    const remove = (body?: unknown) => app().request('/api/scenarios/sc-1', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    sqlite.raw.exec("INSERT INTO friends(id,line_user_id,line_account_id) VALUES('f2','U2','acc-1'); INSERT INTO friend_scenarios(id,friend_id,scenario_id,current_step_order,status) VALUES('paused','f2','sc-1',0,'paused');");
    expect((await remove({ expectedContentRevision: snapshot.contentRevision, expectedSubscriptions: { activeCount: snapshot.totalCount, rowIdSum: snapshot.totalRowIdSum, rowIdSquareSum: snapshot.totalRowIdSquareSum }, expectedActiveSubscriptions: { activeCount: snapshot.activeCount, rowIdSum: snapshot.rowIdSum, rowIdSquareSum: snapshot.rowIdSquareSum }, expectedReferrers: [] })).status).toBe(409);
    expect(sqlite.raw.prepare('SELECT id FROM scenarios WHERE id=?').get('sc-1')).toBeTruthy();
    const now = (await (await app().request('/api/scenarios/sc-1/confirmation')).json() as { data: typeof snapshot }).data;
    expect((await remove({ expectedContentRevision: now.contentRevision, expectedSubscriptions: { activeCount: now.totalCount, rowIdSum: now.totalRowIdSum, rowIdSquareSum: now.totalRowIdSquareSum }, expectedActiveSubscriptions: { activeCount: now.activeCount, rowIdSum: now.rowIdSum, rowIdSquareSum: now.rowIdSquareSum }, expectedReferrers: [] })).status).toBe(200);
    expect(sqlite.raw.prepare('SELECT id FROM scenarios WHERE id=?').get('sc-1')).toBeUndefined();
    sqlite.raw.prepare("INSERT INTO scenarios(id,name,trigger_type,line_account_id) VALUES('sc-legacy','旧','manual','acc-1')").run();
    expect((await app().request('/api/scenarios/sc-legacy', { method: 'DELETE' })).status).toBe(200);
  });

  test('削除対象への移動元が増えたら削除も参照解除もしない', async () => {
    const snapshot = (await (await app().request('/api/scenarios/sc-1/confirmation')).json() as { data: { contentRevision: number; activeCount: number; rowIdSum: number; rowIdSquareSum: number; totalCount: number; totalRowIdSum: number; totalRowIdSquareSum: number; referrers: Array<{ id: string; revision: number }> } }).data;
    sqlite.raw.prepare("INSERT INTO scenarios(id,name,trigger_type,line_account_id,on_complete_mode,on_complete_scenario_id) VALUES('ref','移動元','manual','acc-1','move','sc-1')").run();
    const response = await app().request('/api/scenarios/sc-1', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedContentRevision: snapshot.contentRevision, expectedSubscriptions: { activeCount: snapshot.totalCount, rowIdSum: snapshot.totalRowIdSum, rowIdSquareSum: snapshot.totalRowIdSquareSum }, expectedActiveSubscriptions: { activeCount: snapshot.activeCount, rowIdSum: snapshot.rowIdSum, rowIdSquareSum: snapshot.rowIdSquareSum }, expectedReferrers: snapshot.referrers }) });
    expect(response.status).toBe(409);
    expect(sqlite.raw.prepare("SELECT on_complete_scenario_id FROM scenarios WHERE id='ref'").get()).toEqual({ on_complete_scenario_id: 'sc-1' });
  });

  test('担当外の移動元は確認情報へ漏らさず、削除の確認を止める', async () => {
    sqlite.raw.prepare("INSERT INTO scenarios(id,name,trigger_type,line_account_id,on_complete_mode,on_complete_scenario_id) VALUES('foreign-ref','担当外','manual','acc-2','move','sc-1')").run();
    expect((await app().request('/api/scenarios/sc-1/confirmation?purpose=delete')).status).toBe(409);
    const stop = await app().request('/api/scenarios/sc-1/confirmation?purpose=stop');
    expect(stop.status).toBe(200);
    expect((await stop.json() as { data: { referrers: unknown[] } }).data.referrers).toEqual([]);
  });

  test('購読状態を更新すると確認版が進む', async () => {
    expect(await pauseFriendScenarioManual(sqlite.db, 'sub-1')).toBe(true);
    expect(sqlite.raw.prepare('SELECT status, confirmation_revision FROM friend_scenarios WHERE id=?').get('sub-1'))
      .toEqual({ status: 'paused', confirmation_revision: 2 });
  });

  test('理由・操作した本人・日本時間を詳細で読み直せ、購読の途中の記録は残る', async () => {
    const response = await put({ isActive: false, reason: '2通目の画像を差し替えるため', stoppedBy: '偽の担当者' });
    expect(response.status).toBe(200);
    const body = await response.json() as { data: Record<string, unknown> };
    expect(body.data).toMatchObject({ isActive: false, stoppedReason: '2通目の画像を差し替えるため', stoppedBy: 'editor' });
    expect(body.data.stoppedAt).toMatch(/\+09:00$/);
    const detail = await app().request('/api/scenarios/sc-1');
    expect(detail.status).toBe(200);
    expect((await detail.json() as { data: unknown }).data).toMatchObject({ ...body.data, steps: [] });
    expect(sqlite.raw.prepare('SELECT current_step_order, status, next_delivery_at FROM friend_scenarios').get())
      .toEqual({ current_step_order: 2, status: 'active', next_delivery_at: '2026-10-08T20:00:00+09:00' });
  });

  test.each([undefined, '', '   '])('理由が%jでも従来どおり止められる', async (reason) => {
    const response = await put({ isActive: false, reason });
    expect(response.status).toBe(200);
    expect((await response.json() as { data: unknown }).data).toMatchObject({ isActive: false, stoppedReason: null, stoppedBy: 'editor' });
  });

  test.each(['あ'.repeat(200), '😀'.repeat(200)])('200字の理由を保存できる', async (reason) => {
    const response = await put({ isActive: false, reason });
    expect(response.status).toBe(200);
    expect((await response.json() as { data: { stoppedReason: string } }).data.stoppedReason).toBe(reason);
  });

  test.each(['あ'.repeat(201), '😀'.repeat(201), null, 123, {}, []])('不正な理由は400で配信と記録を変えない', async (reason) => {
    const before = record();
    expect((await put({ isActive: false, reason })).status).toBe(400);
    expect(record()).toEqual(before);
  });

  test.each([{ reason: '編集' }, { isActive: true, reason: '再開' }, { isActive: 'false' }])('停止以外の理由・不正な状態入力を拒む', async (body) => {
    const before = record();
    expect((await put(body)).status).toBe(400);
    expect(record()).toEqual(before);
  });

  test('停止記録の無い詳細はnullを返す', async () => {
    const detail = await app().request('/api/scenarios/sc-1');
    expect(detail.status).toBe(200);
    expect((await detail.json() as { data: unknown }).data).toMatchObject({ stoppedReason: null, stoppedBy: null, stoppedAt: null });
  });

  test('再試行・編集・再開は記録を消さず、次の停止は理由を更新する', async () => {
    expect((await put({ isActive: false, reason: '最初' })).status).toBe(200);
    const first = record();
    expect((await put({ isActive: false, reason: '二重クリック' })).status).toBe(200);
    expect(record()).toEqual(first);
    expect((await put({ name: '名前だけ' })).status).toBe(200);
    expect(record()).toEqual(first);
    expect((await put({ isActive: true })).status).toBe(200);
    expect(record()).toEqual({ ...(first as object), is_active: 1 });
    expect((await put({ isActive: false, reason: '次の停止' })).status).toBe(200);
    expect(record()).toMatchObject({ stopped_reason: '次の停止', stopped_by: 'editor' });
  });

  test('閲覧だけ・読み取り専用・担当外では停止も記録もできない', async () => {
    const before = record();
    expect((await put({ isActive: false, reason: '停止' }, { ...editor, permissionKeys: ['/scenarios'] })).status).toBe(403);
    expect((await put({ isActive: false, reason: '停止' }, { ...editor, readOnly: true })).status).toBe(403);
    expect((await put({ isActive: false, reason: '停止' }, editor, 'sc-2')).status).toBe(404);
    expect((await app().request('/api/scenarios/sc-2')).status).toBe(404);
    expect((await put({ isActive: false }, editor, 'missing')).status).toBe(404);
    expect(record()).toEqual(before);
    expect(sqlite.raw.prepare('SELECT is_active, stopped_at FROM scenarios WHERE id = ?').get('sc-2')).toEqual({ is_active: 1, stopped_at: null });
  });
});
