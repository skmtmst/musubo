import { Hono } from 'hono';
import { sha256Hex } from '../middleware/auth.js';
import { apiContractMiddleware } from '../middleware/api-contract.js';
import type { AuthenticatedStaff } from '../middleware/auth/principal/auth.js';
import { friendAddRules } from './friend-add-rules.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { app } from '../index.js';
import type { Env } from '../worker-env.js';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';

let fixture: SqliteD1;
beforeEach(() => {
  fixture = createTestD1({ foreignKeys: true, loginPolicy: 'off' });
  fixture.raw.exec(`INSERT INTO tenants(id,name) VALUES('fixture-tenant','Fixture');
    INSERT INTO line_accounts(id,name,channel_id,channel_secret,channel_access_token,tenant_id)
      VALUES('fixture-hq','Fixture HQ','fixture-hq-channel','fixture-secret','fixture-token','fixture-tenant'),
            ('fixture-store','Fixture store','fixture-store-channel','fixture-secret','fixture-token','fixture-tenant'),
            ('fixture-sibling','Fixture sibling','fixture-sibling-channel','fixture-secret','fixture-token','fixture-tenant');
    UPDATE line_accounts SET parent_line_account_id='fixture-hq' WHERE id IN ('fixture-store','fixture-sibling');
    INSERT INTO staff_members(id,name,role,api_key,tenant_id,assigned_line_account_id,can_access_descendant_accounts)
      VALUES('fixture-admin','Fixture admin','admin','fixture-folder-admin-key','fixture-tenant','fixture-hq',1);`);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('external requests are disabled in this fixture'); }));
});
afterEach(() => { vi.unstubAllGlobals(); fixture.raw.close(); });

function create(color?: string | null, key = 'fixture-folder-request-key-0001') {
  return app.request('http://localhost/api/friend-add-rules/folders', {
    method: 'POST', headers: { Authorization: 'Bearer fixture-folder-admin-key', 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify({ accountId: 'fixture-store', name: '挨拶', color }),
  }, { DB: fixture.db, DEPLOY_ENV: 'test' } as Env['Bindings']);
}

it.each([undefined, null, '#3b82f6'])('管理者が統括の配下の店舗で色%sのフォルダを作り、同じ鍵の再試行を重ねない', async (color) => {
  const created = await create(color);
  const body = await created.json() as { data?: { id: string; name: string; color: string | null } };
  expect(created.status, JSON.stringify(body)).toBe(201);
  expect(body.data).toMatchObject({ name: '挨拶', color: color ?? null });
  const replay = await create(color);
  expect(replay.status).toBe(200);
  expect((await replay.json() as typeof body).data?.id).toBe(body.data?.id);
  expect(fixture.raw.prepare('SELECT count(*) AS n FROM friend_add_rule_folders').get()).toEqual({ n: 1 });
  expect(fixture.raw.prepare("SELECT count(*) AS n FROM folders WHERE kind='friend_add_rule' AND account_id='fixture-store'").get()).toEqual({ n: 1 });
  expect(fetch).not.toHaveBeenCalled();
});

it('同じ店舗の別種類に同名があっても作成でき、同じ種類だけは409で理由を返す', async () => {
  fixture.raw.prepare("INSERT INTO folders(id,kind,account_id,name) VALUES('scenario-folder','scenario','fixture-store',?)").run('挨拶');
  const created = await create('#16a34a');
  expect(created.status, await created.clone().text()).toBe(201);
  expect(fixture.raw.prepare("SELECT kind FROM folders WHERE account_id='fixture-store' AND name=? ORDER BY kind").all('挨拶'))
    .toEqual([{ kind: 'friend_add_rule' }, { kind: 'scenario' }]);
  const duplicate = await create('#16a34a', 'fixture-different-request-key-0002');
  expect(duplicate.status).toBe(409);
  expect(await duplicate.json()).toMatchObject({ error: { code: 'DUPLICATE_FOLDER_NAME', message: '同じ名前のフォルダがあります', fieldErrors: [{field:'name',message:'同じ名前のフォルダがあります'}] } });
  expect(fixture.raw.prepare('SELECT count(*) AS n FROM friend_add_rule_folders').get()).toEqual({ n: 1 });
});

it('別のフォルダと同じ名前への変更も項目の理由を返し、元の名前を残す', async () => {
  await create();
  const second=await app.request('http://localhost/api/friend-add-rules/folders',{
    method:'POST',headers:{Authorization:'Bearer fixture-folder-admin-key','Content-Type':'application/json','Idempotency-Key':'fixture-second-folder-key-0002'},
    body:JSON.stringify({accountId:'fixture-store',name:'別の分類'})
  },{DB:fixture.db,DEPLOY_ENV:'test'} as Env['Bindings']);
  expect(second.status).toBe(201);const id=((await second.json()) as {data:{id:string}}).data.id;
  const renamed=await app.request(`http://localhost/api/friend-add-rules/folders/${id}`,{
    method:'PATCH',headers:{Authorization:'Bearer fixture-folder-admin-key','Content-Type':'application/json'},
    body:JSON.stringify({accountId:'fixture-store',name:'挨拶'})
  },{DB:fixture.db,DEPLOY_ENV:'test'} as Env['Bindings']);
  expect(renamed.status).toBe(409);expect(await renamed.json()).toMatchObject({error:{message:'同じ名前のフォルダがあります',fieldErrors:[{field:'name',message:'同じ名前のフォルダがあります'}]}});
  expect(fixture.raw.prepare('SELECT name FROM friend_add_rule_folders WHERE id=?').get(id)).toEqual({name:'別の分類'});
});

it('担当店舗を明示された管理者も下の店舗に作成でき、担当外へは書き込まない', async () => {
  fixture.raw.exec("UPDATE staff_members SET account_scope='accounts' WHERE id='fixture-admin'; INSERT INTO staff_account_scopes(staff_id,line_account_id,created_at) VALUES('fixture-admin','fixture-store','now'),('fixture-admin','fixture-sibling','now');");
  const created = await create(null);
  expect(created.status, await created.clone().text()).toBe(201);
  fixture.raw.exec("DELETE FROM staff_account_scopes WHERE line_account_id='fixture-store';");
  const denied = await create(null, 'fixture-no-access-request-key-0003');
  expect(denied.status).toBe(403);
  expect(await denied.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
  expect(fixture.raw.prepare('SELECT count(*) AS n FROM friend_add_rule_folders').get()).toEqual({ n: 1 });
});


function isolatedRoutes(actor: AuthenticatedStaff) {
  const instance = new Hono<Env>();
  instance.use('*', apiContractMiddleware);
  instance.use('*', async (c, next) => { c.set('staff', { ...actor }); await next(); });
  instance.route('/', friendAddRules);
  return instance;
}
const routeActor: AuthenticatedStaff = {
  id: 'fixture-admin', name: 'Fixture admin', role: 'admin', readOnly: false,
  tenantId: 'fixture-tenant', assignedLineAccountId: 'fixture-hq', canAccessDescendantAccounts: true,
};
function routeBody(body: unknown) {
  return { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'fixture-route-negative-key-0001' }, body: JSON.stringify(body) };
}
function expectNoFolder() {
  expect(fixture.raw.prepare('SELECT count(*) AS n FROM friend_add_rule_folders').get()).toEqual({ n: 0 });
}

it('routeの配信権限だけでも権限のないstaffを403で止める', async () => {
  const actor: AuthenticatedStaff = { ...routeActor, role: 'staff', permissionKeys: [] };
  const response = await isolatedRoutes(actor).request('http://localhost/api/friend-add-rules/folders', routeBody({ accountId: 'fixture-store', name: '挨拶' }), { DB: fixture.db } as Env['Bindings']);
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
  expectNoFolder();
});

it('routeのアカウント確認だけでも同じ統括内の担当外を404で止める', async () => {
  fixture.raw.exec("UPDATE staff_members SET account_scope='accounts' WHERE id='fixture-admin'; INSERT INTO staff_account_scopes(staff_id,line_account_id,created_at) VALUES('fixture-admin','fixture-store','now');");
  const response = await isolatedRoutes(routeActor).request('http://localhost/api/friend-add-rules/folders', routeBody({ accountId: 'fixture-sibling', name: '挨拶' }), { DB: fixture.db } as Env['Bindings']);
  expect(response.status).toBe(404);
  expect(await response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  expectNoFolder();
});

it('実indexで型違いの名前を400の欄の理由にし、500や作成にしない', async () => {
  const response = await app.request('http://localhost/api/friend-add-rules/folders', {
    ...routeBody({ accountId: 'fixture-store', name: 1 }),
    headers: { ...routeBody({}).headers, Authorization: 'Bearer fixture-folder-admin-key' },
  }, { DB: fixture.db, DEPLOY_ENV: 'test' } as Env['Bindings']);
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: { code: 'BAD_REQUEST', fieldErrors: [{ field: 'name' }] } });
  expectNoFolder();
});

it.each([true, false])('ブラウザと同じCookieセッション・Originで、CSRFの有無%sを判定する', async csrf => {
  const token = 'fixture-browser-folder-session';
  fixture.raw.prepare('INSERT INTO admin_sessions(token_hash,staff_id,expires_at) VALUES(?,?,?)').run(await sha256Hex(token), 'fixture-admin', new Date(Date.now() + 3600000).toISOString());
  const response = await app.request('http://localhost/api/friend-add-rules/folders', {
    ...routeBody({ accountId: 'fixture-store', name: '挨拶', color: '#3b82f6' }),
    headers: { ...routeBody({}).headers, Cookie: `lh_admin_session=${token}; lh_csrf=fixture-csrf`, Origin: 'http://localhost', ...(csrf ? { 'X-CSRF-Token': 'fixture-csrf' } : {}) },
  }, { DB: fixture.db, DEPLOY_ENV: 'test' } as Env['Bindings']);
  expect(response.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost');
  expect(response.status, await response.clone().text()).toBe(csrf ? 201 : 403);
  if (csrf) expect(await response.json()).toMatchObject({ data: { name: '挨拶', color: '#3b82f6' } });
  else { expect(await response.json()).toMatchObject({ error: { code: 'CSRF_TOKEN_MISMATCH' } }); expectNoFolder(); }
  expect(fetch).not.toHaveBeenCalled();
});


it('実indexで初回案内の機能が無効な店舗はFEATURE_DISABLEDで作成を拒む', async () => {
  fixture.raw.prepare('INSERT INTO account_settings(id,line_account_id,key,value) VALUES(?,?,?,?)').run('fixture-disabled-friend-add', 'fixture-store', 'feature.friend_add_routing', JSON.stringify({ enabled: false }));
  const response = await create(null);
  expect(response.status, await response.clone().text()).toBe(403);
  expect(await response.json()).toMatchObject({ error: { code: 'FEATURE_DISABLED' } });
  expectNoFolder();
});
