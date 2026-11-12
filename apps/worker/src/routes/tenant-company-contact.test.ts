import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../worker-env.js';
import type { AuthenticatedStaff } from '../middleware/auth/principal/auth.js';
import { DEFAULT_TENANT_ID } from '../lib/tenant.js';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';
import { tenants } from './tenants.js';

let sql: SqliteD1;
const path = '/api/tenants/me/company-contact';
const valid = { legalCompanyName: '正式な会社株式会社', postalCode: '150-0001', address: '東京都渋谷区神宮前1-2-3',
  building: '', phone: '03-0000-5678', contactName: '見本 141', contactEmail: 'yamada@example.com', invoiceAddressee: null };
const actor = (role: AuthenticatedStaff['role'] = 'owner'): AuthenticatedStaff => ({
  id: 'owner', name: '管理者', role, readOnly: false, tenantId: DEFAULT_TENANT_ID,
});
async function call(method = 'GET', body?: unknown, staff: AuthenticatedStaff | null = actor(), db = sql.db) {
  const app = new Hono<Env>();
  app.use('*', async (c, next) => { if (staff) c.set('staff', staff); await next(); });
  app.route('/', tenants);
  const response = await app.request(path, { method, headers: {'Content-Type':'application/json'},
    ...(body === undefined ? {} : {body: JSON.stringify(body)}) }, {DB: db} as Env['Bindings']);
  return {status: response.status, body: await response.json() as any};
}
const persisted = () => sql.raw.prepare('SELECT legal_company_name,company_postal_code,company_address,company_building,company_phone,contact_name,contact_email,invoice_addressee,company_settings_version FROM tenants WHERE id=?').get(DEFAULT_TENANT_ID);
const audits = () => sql.raw.prepare("SELECT count(*) AS n FROM audit_events WHERE action='tenant_company_contact.updated'").get();

beforeEach(() => { sql = createTestD1(); sql.raw.exec("INSERT INTO tenants(id,name) VALUES('other','他の統括'); INSERT INTO staff_members(id,name,role,api_key,tenant_id,account_scope) VALUES('owner','管理者','owner','test-owner','"+DEFAULT_TENANT_ID+"','all')"); });
afterEach(() => sql.raw.close());

describe('統括の会社と連絡先（実SQL）', () => {
  it('既存の統括は8欄がNULL、版は既存の0を返す', async () => {
    expect(await call()).toEqual({status:200, body:{success:true,data:{legalCompanyName:null,postalCode:null,address:null,
      building:null,phone:null,contactName:null,contactEmail:null,invoiceAddressee:null,revision:0}}});
  });
  it.each(['owner','admin'] as const)('%sは8欄を自分の統括に保存し、再取得できる', async role => {
    const saved = await call('PATCH', {...valid,expectedRevision:0,tenantId:'other'}, actor(role));
    expect(saved.status).toBe(200);
    expect(saved.body.data).toEqual({...valid,phone:'0300005678',postalCode:'1500001',building:null,revision:1});
    expect((await call()).body.data).toEqual(saved.body.data);
    expect(persisted()).toEqual({legal_company_name:valid.legalCompanyName,company_postal_code:'1500001',company_address:valid.address,
      company_building:null,company_phone:'0300005678',contact_name:valid.contactName,contact_email:valid.contactEmail,
      invoice_addressee:null,company_settings_version:1});
    expect(sql.raw.prepare("SELECT name,legal_company_name FROM tenants WHERE id='other'").get()).toEqual({name:'他の統括',legal_company_name:null});
    expect(sql.raw.prepare('SELECT name FROM tenants WHERE id=?').get(DEFAULT_TENANT_ID)).toEqual({name:'既定の統括'});
  });
  it.each(['GET','PATCH'])('%sは通常メンバー・未認証を拒否し、連絡先を返さない', async method => {
    for (const who of [actor('staff'), null]) {
      const response = await call(method, method==='PATCH'? {...valid,expectedRevision:0}: undefined,who);
      expect(response.status).toBe(403);
      expect(response.body.data).toBeUndefined();
    }
  });
  it('閲覧のみの管理者は読み取れるが保存は403', async () => {
    const staff = {...actor('admin'),readOnly:true};
    expect((await call('GET',undefined,staff)).status).toBe(200);
    expect((await call('PATCH',{...valid,expectedRevision:0},staff)).status).toBe(403);
  });
  it.each(['legalCompanyName','postalCode','address','phone','contactName','contactEmail'])('%sは必須（NULL・欠落・空白を拒否）', async key => {
    const before = persisted();
    for (const value of [null,undefined,'   ']) {
      expect((await call('PATCH',{...valid,[key]:value,expectedRevision:0})).status).toBe(400);
      expect(persisted()).toEqual(before);
    }
  });
  it.each([['postalCode','123'],['postalCode','１２３４５６７'],['phone','123'],['phone','03-abc-1234'],
    ['contactEmail','abc'],['contactEmail','a@b'],['contactEmail','a@@b.com'],['address',42],['building','a\nb'],
    ['legalCompanyName','a'.repeat(201)]])('不正な%s=%sはSQLを変更しない', async (key,value) => {
    const before = persisted();
    expect((await call('PATCH',{...valid,[key]:value,expectedRevision:0})).status).toBe(400);
    expect(persisted()).toEqual(before);
  });
  it.each([undefined,-1,0.5,'0'])('版%sを拒否する', async expectedRevision => {
    expect((await call('PATCH',{...valid,expectedRevision})).status).toBe(400);
  });
  it('同じ保存を再送しても版と監査は増えない', async () => {
    const input = {...valid,expectedRevision:0};
    const first = await call('PATCH',input);
    const before = persisted();
    sql.raw.exec("UPDATE tenants SET updated_at='再送前の日時' WHERE id='"+DEFAULT_TENANT_ID+"'");
    expect(await call('PATCH',input)).toEqual(first);
    expect(persisted()).toEqual(before);
    expect(audits()).toEqual({n:1});
    expect(sql.raw.prepare('SELECT updated_at FROM tenants WHERE id=?').get(DEFAULT_TENANT_ID)).toEqual({updated_at:'再送前の日時'});
  });
  it('古い版は409で止め、先に保存された値と監査を守る', async () => {
    await call('PATCH',{...valid,expectedRevision:0});
    const before = persisted();
    expect((await call('PATCH',{...valid,contactName:'遅れた保存',expectedRevision:0})).status).toBe(409);
    expect(persisted()).toEqual(before);
    expect(audits()).toEqual({n:1});
  });
  it('未来の版は同じ内容でも409で止める', async () => {
    await call('PATCH',{...valid,expectedRevision:0});
    expect((await call('PATCH',{...valid,expectedRevision:2})).status).toBe(409);
    expect(audits()).toEqual({n:1});
  });
  it('読み取り後・更新直前の競合でもSQLの版比較で上書きを防ぐ', async () => {
    const db = {...sql.db,batch: async (statements: D1PreparedStatement[]) => {
      sql.raw.prepare('UPDATE tenants SET contact_name=?,company_settings_version=company_settings_version+1 WHERE id=?').run('先に保存した人',DEFAULT_TENANT_ID);
      return sql.db.batch(statements);
    }} as D1Database;
    expect((await call('PATCH',{...valid,expectedRevision:0},actor(),db)).status).toBe(409);
    expect(sql.raw.prepare('SELECT contact_name FROM tenants WHERE id=?').get(DEFAULT_TENANT_ID)).toEqual({contact_name:'先に保存した人'});
    expect(audits()).toEqual({n:0});
  });
  it('通常の名前APIへ個人の連絡先を混ぜない', async () => {
    await call('PATCH',{...valid,expectedRevision:0});
    const app = new Hono<Env>(); app.use('*',async(c,next)=>{c.set('staff',actor('staff'));await next()});app.route('/',tenants);
    expect(await (await app.request('/api/tenants/me',{}, {DB:sql.db} as Env['Bindings'])).json())
      .toEqual({success:true,data:{name:'既定の統括'}});
  });
});

it('全角の会社電話を正規化し、既存番号は読んでも書き換えない', async () => {
  expect((await call('PATCH',{...valid,phone:'（０３）００００－５６７８',expectedRevision:0})).status).toBe(200);
  expect(persisted()).toMatchObject({company_phone:'0300005678'});
  sql.raw.prepare('UPDATE tenants SET company_phone=? WHERE id=?').run('０３－００００－５６７８',DEFAULT_TENANT_ID);
  expect((await call()).body.data.phone).toBe('0300005678');
  expect(persisted()).toMatchObject({company_phone:'０３－００００－５６７８'});
});
