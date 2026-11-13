import { apiContractMiddleware } from '../middleware/api-contract.js';
import { Hono } from 'hono';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ACCOUNT_STYLES, DEFAULT_TENANT_ID, type SetupAnswer } from '@line-crm/shared';

import type { Env } from '../worker-env.js';
import { createTestD1 } from '../test-utils/d1-sqlite.js';
import { initializeAccountStyle, profile, saveProfile, standardStarter, readDefinition } from '../services/style-setup.js';
import { firstRunTimes } from '../services/getting-started-first-run.js';
import type { StarterItem } from '../services/style-starter-definition.js';
import { styleMenuButtons } from '../services/style-menu-buttons.js';
import { restaurantMenuButtons } from '../services/style-restaurant-buttons.js';
import { templateSamples } from '../services/style-template-samples.js';
import { styles } from './styles.js';
import { liffRoutes } from './liff.js';

let f: ReturnType<typeof createTestD1>, app: Hono<Env>;
let role: 'owner' | 'admin' | 'staff', readOnly: boolean, permissions: string[];
vi.mock('../services/account-access.js', () => ({ canAccessAllLineAccounts: async (_db: unknown, _staff: unknown, ids: string[]) => ids.every(id => id === 'a') }));
beforeEach(() => {
  f = createTestD1();
  f.raw.pragma('foreign_keys=OFF');
  for (const id of ['a', 'b']) f.raw.prepare("INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret,liff_id,tenant_id) VALUES(?,?,?,'secret-token','secret','liff-'||?,?)").run(id,id,id,id,DEFAULT_TENANT_ID);
  f.raw.prepare("INSERT INTO staff_members(id,name,role,api_key,tenant_id) VALUES('owner','担当','owner','key',?)").run(DEFAULT_TENANT_ID);
  role = 'owner'; readOnly = false; permissions = [];
  app = new Hono<Env>();
  app.use('*',apiContractMiddleware);
  app.use('*', async (c, next) => { c.set('staff', { id: 'owner', name: '担当', tenantId: DEFAULT_TENANT_ID, role, readOnly, permissionKeys: permissions }); await next(); });
  app.route('/', styles); app.route('/', liffRoutes);
});
afterEach(() => { f.raw.close(); vi.restoreAllMocks(); });
const request = (path: string, method='GET', body?: unknown) => app.request(path, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, { DB: f.db } as Env['Bindings']);

test.each(ACCOUNT_STYLES)('%s saves a selected registration profile, remains selected, and inserts drafts once', async style => {
  const initial = await initializeAccountStyle(f.db, 'a', DEFAULT_TENANT_ID, 'owner', style);
  expect(initial.style).toBe(style);
  const stored = await profile(f.db, 'a');
  expect(stored).toMatchObject({ style, selection_mode: 'configured', version: 1 });
  expect(stored?.selected_at).toBeTruthy();
  const first = f.raw.prepare('SELECT item_key,target_id FROM style_starter_items WHERE line_account_id=? ORDER BY item_key').all('a');
  await saveProfile(f.db, 'a', DEFAULT_TENANT_ID, 'owner', { expectedVersion: 1, style });
  expect(f.raw.prepare('SELECT item_key,target_id FROM style_starter_items WHERE line_account_id=? ORDER BY item_key').all('a')).toEqual(first);
  expect(f.raw.prepare("SELECT COUNT(*) n FROM rich_menu_groups WHERE status<>'draft'").get()).toEqual({ n: 0 });
  expect(f.raw.prepare('SELECT COUNT(*) n FROM menus WHERE is_active=1').get()).toEqual({ n: 0 });
  expect(f.raw.prepare('SELECT COUNT(*) n FROM messages_log').get()).toEqual({ n: 0 });
  const response = await request('/api/liff/customer-look?liffId=liff-a&style=restaurant');
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  const body = await response.json();
  expect(body).toMatchObject({ data: { style } });
  expect(JSON.stringify(body)).not.toMatch(/answers|settings_json|secret-token|selection_mode/);
  expect(await (await request('/api/liff/customer-look?liffId=liff-b')).json()).toMatchObject({ data: { style: null } });
});

test.each(ACCOUNT_STYLES)('%s content=false, later and manual never insert templates or rich menus', async style => {
  for (const content of [{ mode: 'configured', value: false }, { mode: 'later' }, { mode: 'manual' }]) {
    const current = await profile(f.db, 'a');
    await saveProfile(f.db, 'a', DEFAULT_TENANT_ID, 'owner', { expectedVersion: current?.version ?? 0, style, answers: { content } });
    expect(f.raw.prepare('SELECT COUNT(*) n FROM templates').get()).toEqual({ n: 0 });
    expect(f.raw.prepare('SELECT COUNT(*) n FROM rich_menu_groups').get()).toEqual({ n: 0 });
  }
});

test('old versions, wrong accounts, readonly and staff cannot change style', async () => {
  await initializeAccountStyle(f.db, 'a', DEFAULT_TENANT_ID, 'owner', 'consult');
  const path='/api/dashboard/style?account_id=a';
  expect((await request(path,'PUT',{ expectedVersion:0,style:'ec' })).status).toBe(409);
  expect((await request('/api/dashboard/style?account_id=b','PUT',{expectedVersion:0,style:'ec'})).status).toBe(404);
  readOnly=true;
  expect((await request(path,'PUT',{expectedVersion:1,style:'ec'})).status).toBe(403);
  readOnly=false; role='staff';
  expect((await request(path,'PUT',{expectedVersion:1,style:'ec'})).status).toBe(403);
  expect((await profile(f.db,'a'))?.style).toBe('consult');
});

test('standard and EC starter templates have no reservation messages; consult and lesson have no arrival-only directions', () => {
  for (const style of ['standard','ec'] as const) {
    const set=readDefinition(standardStarter(style),style);
    expect(set.items.length).toBeLessThanOrEqual(30);
    expect(set.items.some(item=>['reminder','booking_menu','automation'].includes(item.kind))).toBe(false);
    expect(set.items.filter(item=>item.kind==='template').map(item=>item.text).join('\n')).not.toMatch(/ご予約|ご来店|来店日/);
  }
  expect(standardStarter('ec').items.filter(item=>item.kind==='template').map(item=>item.name)).toEqual(expect.arrayContaining(['購入へのお礼','再入荷のお知らせ']));
  for (const style of ['consult','lesson'] as const) expect(templateSamples(style).map(s=>s.text).join('\n')).not.toContain('お気をつけてお越しください');
});

test('custom lesson links resolve selected events and history, tickets use MyPage, missing URLs stay unavailable', async () => {
  const menu:StarterItem={key:'custom',kind:'rich_menu',name:'店のメニュー',buttons:[{label:'クラスを予約する',feature:'booking'},{label:'予約の確認',feature:'booking',actionData:'history'},{label:'回数券',feature:'tickets'},{label:'振替',feature:'booking',actionData:'history'}]};
  f.raw.exec("INSERT INTO events(id,line_account_id,name,is_published,lifecycle_status) VALUES('class','a','クラス',1,'published'),('foreign','b','別店',1,'published')");
  const buttons=await styleMenuButtons(f.db,'a','lesson',menu,{});
  expect(buttons.find(b=>b.label==='クラスを予約する')?.actionData).toBe('https://liff.line.me/liff-a/events/class');
  expect(buttons.find(b=>b.label==='予約の確認')?.actionData).toBe('https://liff.line.me/liff-a/events/me');
  expect(buttons.find(b=>b.label==='回数券')?.actionData).toBe('https://liff.line.me/liff-a/?page=mypage');
  expect(buttons.find(b=>b.label==='振替')?.actionData).toBe('https://liff.line.me/liff-a/events/me');
  expect(JSON.stringify(buttons)).not.toContain('page=event');
  f.raw.exec("INSERT INTO events(id,line_account_id,name,is_published,lifecycle_status) VALUES('class2','a','クラス2',1,'published')");
  expect((await styleMenuButtons(f.db,'a','lesson',menu,{})).some(b=>b.label==='クラスを予約する')).toBe(false);
  expect((await styleMenuButtons(f.db,'a','lesson',menu,{booking:{mode:'configured',resourceId:'class'}})).find(b=>b.label==='クラスを予約する')?.actionData).toContain('/events/class');
  expect((await styleMenuButtons(f.db,'a','lesson',menu,{booking:{mode:'configured',resourceId:'foreign'}})).some(b=>b.label==='クラスを予約する')).toBe(false);
  const ec:StarterItem={key:'custom',kind:'rich_menu',name:'店のメニュー',buttons:[{label:'商品を見る',feature:'content'}]};
  expect((await styleMenuButtons(f.db,'a','ec',ec,{})).some(b=>b.label==='商品を見る')).toBe(false);
  ec.buttons![0]!.actionType='uri'; ec.buttons![0]!.actionData='https://shop.example/products';
  expect((await styleMenuButtons(f.db,'a','ec',ec,{}))[0]).toMatchObject({label:'商品を見る',actionType:'uri',actionData:'https://shop.example/products'});
  ec.buttons![0]!.actionData='javascript:alert(1)';
  expect(()=>readDefinition({items:[ec]},'ec')).toThrow('invalid_buttons');
  ec.buttons![0]!.actionData='https://liff.line.me/foreign/?page=mypage';
  expect((await styleMenuButtons(f.db,'a','ec',ec,{})).some(b=>b.label==='商品を見る')).toBe(false);
});

test('custom restaurant buttons share the resolver and starter limits remain enforced', async () => {
  const item:StarterItem={key:'custom',kind:'rich_menu',name:'店のメニュー',buttons:[{label:'予約する',feature:'booking'},{label:'予約の確認',feature:'booking',actionData:'history'},{label:'お問い合わせ',feature:'contact'}]};
  for(const answers of ([{},{booking:{mode:'configured' as const,value:true}},{stamps:{mode:'later' as const}}] as Record<string,SetupAnswer>[])) {
    expect(await styleMenuButtons(f.db,'a','restaurant',item,answers)).toEqual(await restaurantMenuButtons(f.db,'a','restaurant',item,answers));
  }
  expect(()=>readDefinition({items:Array.from({length:31},(_,i)=>({key:`i${i}`,kind:'template',name:'見本'}))},'ec')).toThrow();
  expect(()=>readDefinition({items:[{key:'menu',kind:'rich_menu',name:'見本',buttons:Array.from({length:7},()=>({label:'お問い合わせ',feature:'contact'}))}]},'ec')).toThrow();
});

test('style read failures stay errors rather than becoming standard', async () => {
  const badDb={prepare:()=>{throw new Error('offline');}} as unknown as D1Database;
  const response=await app.request('/api/liff/customer-look?liffId=liff-a',{}, {DB:badDb} as Env['Bindings']);
  expect(response.status).toBeGreaterThanOrEqual(500);
  expect(JSON.stringify(await response.text())).not.toContain('"style":"standard"');
});

test('EC summary distinguishes missing and zero data, uses the account period and never includes other accounts or mock sends', async () => {
  await initializeAccountStyle(f.db,'a',DEFAULT_TENANT_ID,'owner','ec');
  const path='/api/dashboard/style/ec-summary?account_id=a&range=today&date=2026-10-18';
  let response=await request(path);
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toContain('no-store');
  expect(await response.json()).toMatchObject({data:{status:'unconfigured',asOf:null,orders:{value:null,status:'unconfigured'}}});
  f.raw.exec("INSERT INTO ec_connectors(id,line_account_id,provider,shop_domain,status,created_at,updated_at) VALUES('connector','a','shopify','shop.example','connected','2026-10-18','2026-10-18')");
  response=await request(path);
  expect(await response.json()).toMatchObject({data:{status:'unavailable',orders:{value:null},repeatCustomers:{value:null,status:'unconfigured'}}});
  const insert=(id:string,account:string,customer:string|null,ordered:string,source='shop',status='current')=>f.raw.prepare(`INSERT INTO ec_orders(id,line_account_id,source_key,external_order_id,customer_id,order_number,normalized_status,provider_status,ordered_at,last_event_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'paid',?,'test-event','2026-10-18','2026-10-18')`).run(id,account,source,id,customer,id,status,ordered);
  insert('old','a','repeat','2026-10-17T00:00:00+09:00');
  insert('repeat','a','repeat','2026-10-18T00:00:00+09:00');
  insert('new','a','new','2026-10-18T23:59:59+09:00');
  insert('no-identity','a',null,'2026-10-18T10:00:00+09:00');
  insert('source','a','repeat','2026-10-18T12:00:00+09:00','different-shop');
  insert('tomorrow','a','new','2026-10-19T00:00:00+09:00');
  insert('cancelled','a','new','2026-10-18T10:00:00+09:00','shop','cancelled');
  insert('refunded','a','new','2026-10-18T10:00:00+09:00','shop','refunded');
  insert('foreign','b','new','2026-10-18T10:00:00+09:00');
  const data=(await (await request(path)).json() as {data:Record<string,unknown>}).data;
  expect(data).toMatchObject({style:'ec',dateBasis:'ordered_at',orders:{value:4,status:'available'},repeatCustomers:{numerator:1,denominator:3,value:1/3},from:'2026-10-17T15:00:00.000Z',to:'2026-10-18T15:00:00.000Z'});
  f.raw.exec("UPDATE ec_connectors SET status='paused'");
  expect(await (await request(path)).json()).toMatchObject({data:{status:'stale',orders:{value:4}}});
  expect((await request(path.replace('account_id=a','account_id=b'))).status).toBe(404);
  expect((await request(path.replace('date=2026-10-18','date=bad'))).status).toBe(400);
  role='staff';
  expect((await request(path)).status).toBe(403);
  permissions=['ec.event.view'];
  expect((await request(path)).status).toBe(200);
  role='owner';
  await saveProfile(f.db,'a',DEFAULT_TENANT_ID,'owner',{expectedVersion:1,style:'standard'});
  expect((await request(path)).status).toBe(404);
});

test('S03 normalizes new EC failures and preserves the same server request ID without leaking account data',async()=>{
 const response=await request('/api/dashboard/style/ec-summary?account_id=b');
 expect(response.status).toBe(404);
 const body=await response.json() as {error:{code:string;requestId:string;message:string;fieldErrors:unknown[]}};
 expect(body.error).toMatchObject({code:'not_found',requestId:response.headers.get('X-Request-ID'),fieldErrors:[]});
 expect(body.error.requestId).toMatch(/^[0-9a-f-]{36}$/);
 expect(JSON.stringify(body)).not.toMatch(/secret-token|answers_json|settings_json/);
});

test('first selection and first starter times survive later saves and item replacement', async () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date('2026-10-01T00:00:00Z'));
    await initializeAccountStyle(f.db, 'a', DEFAULT_TENANT_ID, 'owner', 'standard');
    const first = f.raw.prepare('SELECT first_selected_at,first_starter_at FROM account_styles WHERE line_account_id=?').get('a');
    expect(first).toEqual({ first_selected_at: '2026-10-01T00:00:00.000Z', first_starter_at: '2026-10-01T00:00:00.000Z' });
    f.raw.prepare('DELETE FROM style_starter_items WHERE line_account_id=?').run('a');
    vi.setSystemTime(new Date('2026-10-02T00:00:00Z'));
    await saveProfile(f.db, 'a', DEFAULT_TENANT_ID, 'owner', { expectedVersion: 1, style: 'standard' });
    expect(f.raw.prepare('SELECT first_selected_at,first_starter_at FROM account_styles WHERE line_account_id=?').get('a')).toEqual(first);
    expect(await firstRunTimes(f.db, 'a')).toMatchObject({ styleAt: '2026-10-01T09:00:00.000+09:00', starterAt: '2026-10-01T09:00:00.000+09:00' });
  } finally { vi.useRealTimers(); }
});
