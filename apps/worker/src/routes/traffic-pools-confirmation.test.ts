import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { createTestD1 } from '../test-utils/d1-sqlite.js';
import type { Env } from '../worker-env.js';
vi.mock('../services/account-access.js', () => ({ canAccessAllLineAccounts: async () => true }));
import { trafficPools } from './traffic-pools.js';

describe('所属プール削除の確認', () => {
  function setup() {
    const { raw, db } = createTestD1();
    raw.exec("INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret) VALUES('a','a','A','token','secret'); INSERT INTO traffic_pools(id,slug,name,active_account_id,is_active,created_at,updated_at) VALUES('p','other','pool','a',1,'now','now'); INSERT INTO pool_accounts(id,pool_id,line_account_id,is_active,created_at) VALUES('pa','p','a',1,'now')");
    const app = new Hono<Env>(); app.use('*', async (c,next) => { c.set('staff',{ id:'owner',name:'Owner',role:'owner',readOnly:false }); await next(); }); app.route('/', trafficPools);
    const remove = (revision?: number, ids = ['a']) => app.request(`/api/traffic-pools/p${revision === undefined ? '' : `?expectedConfirmationRevision=${revision}&expectedAccountIds=${encodeURIComponent(JSON.stringify(ids))}`}`, { method:'DELETE' }, { DB:db });
    const request = (path: string, method: string, body?: unknown) => app.request(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }, { DB:db });
    return { raw, remove, request };
  }
  it('古い版と変わった所属を拒む', async () => {
    const { raw,remove } = setup();
    expect((await remove(2)).status).toBe(409);
    expect((await remove(1,[])).status).toBe(409);
    expect(raw.prepare("SELECT count(*) n FROM traffic_pools WHERE id='p'").get()).toEqual({n:1});
  });
  it.each(['count', 'membership'])('アカウント削除の連鎖で%sが変わると削除しない', async kind => {
    const { raw,remove } = setup();
    raw.pragma('foreign_keys = ON');
    raw.exec("INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret) VALUES('b','b','B','token','secret'),('c','c','C','token','secret'); INSERT INTO pool_accounts(id,pool_id,line_account_id,is_active,created_at) VALUES('pb','p','b',1,'now')");
    raw.exec("DELETE FROM line_accounts WHERE id='b'");
    if (kind === 'membership') raw.exec("INSERT INTO pool_accounts(id,pool_id,line_account_id,is_active,created_at) VALUES('pc','p','c',1,'now')");
    expect((await remove(1,['a','b'])).status).toBe(409);
    expect(raw.prepare("SELECT count(*) n FROM traffic_pools WHERE id='p'").get()).toEqual({n:1});
  });
  it('確認した版と所属なら削除する', async () => {
    const { raw,remove } = setup(); expect((await remove(1)).status).toBe(200);
    expect(raw.prepare("SELECT count(*) n FROM traffic_pools WHERE id='p'").get()).toEqual({n:0});
  });
  it('確認情報がない従来呼び出しも動く', async () => {
    const { raw,remove } = setup(); expect((await remove()).status).toBe(200);
    expect(raw.prepare("SELECT count(*) n FROM traffic_pools WHERE id='p'").get()).toEqual({n:0});
  });
  it('所属の変更を元に戻しても版が進み、古い確認を拒む', async () => {
    const { raw,remove,request } = setup();
    expect((await request('/api/traffic-pools/p/accounts/pa','PUT',{ isActive:false })).status).toBe(200);
    expect((await request('/api/traffic-pools/p/accounts/pa','PUT',{ isActive:true })).status).toBe(200);
    expect(raw.prepare("SELECT confirmation_revision FROM traffic_pools WHERE id='p'").get()).toEqual({ confirmation_revision:3 });
    expect((await remove(1)).status).toBe(409);
  });
  it('所属の追加と削除はそれぞれ版を進める', async () => {
    const { raw,request } = setup();
    raw.exec("INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret) VALUES('b','b','B','token','secret')");
    const response = await request('/api/traffic-pools/p/accounts','POST',{ lineAccountId:'b' });
    expect(response.status).toBe(201); const added = await response.json() as { data: { id: string } };
    expect(raw.prepare("SELECT confirmation_revision FROM traffic_pools WHERE id='p'").get()).toEqual({ confirmation_revision:2 });
    expect((await request(`/api/traffic-pools/p/accounts/${added.data.id}`,'DELETE')).status).toBe(200);
    expect(raw.prepare("SELECT confirmation_revision FROM traffic_pools WHERE id='p'").get()).toEqual({ confirmation_revision:3 });
  });
});
