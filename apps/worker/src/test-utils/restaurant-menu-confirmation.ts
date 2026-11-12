import { expect, it } from 'vitest';
import type { SqliteD1 } from './d1-sqlite.js';
import type { Env } from '../index.js';

/** メニューの照合は実SQLiteで版・割込み・価格の反映を確かめる。 */
export function registerRestaurantMenuConfirmationTests(context: {
  testDb: () => SqliteD1;
  env: () => Env['Bindings'];
  seedRestaurantFixture: () => void;
  request: (path: string, body?: unknown) => Response | Promise<Response>;
  requestWithMethod: (path: string, method: string, body?: unknown, token?: string) => Response | Promise<Response>;
  rawDelete: (path: string, body: string) => Response | Promise<Response>;
}) {
  const { seedRestaurantFixture, request, requestWithMethod } = context;
  const menuPath = '/api/restaurant-test/menus/menu-ginza?account_id=account-1';
  it('確認した版が古いメニューの変更と削除は拒否し、一致と版なしは受け付ける', async () => {
    const testDb = context.testDb();
    seedRestaurantFixture();
    const create = () => request('/api/restaurant-test/menu?account_id=account-1', { storeId: 'store-ginza', kind: 'course', name: '確認用', price: 1000, status: 'draft' });
    const id = (await (await create()).json() as any).data.id;
    const path = `/api/restaurant-test/menus/${id}?account_id=account-1`;
    expect((await requestWithMethod(path, 'PATCH', { name: '新しい名前', expectedVersion: 1 })).status).toBe(200);
    const conflict = await requestWithMethod(path, 'PATCH', { name: '古い名前', expectedVersion: 1 });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({code:'menu_confirmation_conflict',data:{name:'新しい名前',confirmation_revision:2}});
    const deleteConflict = await requestWithMethod(path, 'DELETE', { expectedVersion: 1 });
    expect(deleteConflict.status).toBe(409);
    expect(await deleteConflict.json()).toMatchObject({code:'menu_confirmation_conflict',data:{name:'新しい名前',confirmation_revision:2}});
    expect(testDb.raw.prepare('SELECT name, confirmation_revision FROM rt_menu_items WHERE id=?').get(id)).toEqual({name: '新しい名前', confirmation_revision: 2});
    expect((await requestWithMethod(path, 'PATCH', { status: 'active' })).status).toBe(200);
    expect((await requestWithMethod(path, 'DELETE', { expectedVersion: 3 })).status).toBe(200);
  });
  it('読み取り後の割り込みは価格を含む変更全体を取り消す', async () => {
    const testDb = context.testDb();
    seedRestaurantFixture();
    const original = testDb.db;
    let interrupted = false;
    context.env().DB = new Proxy(original, { get(target, key) {
      if (key !== 'batch') return Reflect.get(target, key);
      return async (statements: D1PreparedStatement[]) => {
        if (!interrupted && statements.some(statement => String((statement as unknown as {sql?: string}).sql).includes('UPDATE rt_menu_items'))) {
          interrupted = true;
          testDb.raw.prepare("UPDATE rt_menu_items SET name='割り込み', confirmation_revision=confirmation_revision+1 WHERE id='menu-ginza'").run();
        }
        return target.batch(statements);
      };
    } });
    const response = await requestWithMethod(menuPath, 'PATCH', { name: '古い名前', price: 9900, expectedVersion: 1 });
    expect(response.status).toBe(409);
    expect(testDb.raw.prepare("SELECT name, price, confirmation_revision FROM rt_menu_items WHERE id='menu-ginza'").get()).toEqual({name:'割り込み',price:8800,confirmation_revision:2});
    expect(testDb.raw.prepare('SELECT COUNT(*) AS n FROM rt_menu_change_requests').get()).toEqual({n:0});
  });

  it('削除の読み取り後に版が変われば消さない', async () => {
    const testDb = context.testDb();
    seedRestaurantFixture();
    const create = await request('/api/restaurant-test/menu?account_id=account-1', {storeId:'store-ginza',kind:'course',name:'削除候補',price:1000,status:'draft'});
    const id = (await create.json() as any).data.id;
    const prepare = testDb.db.prepare.bind(testDb.db);
    testDb.db.prepare = (sql: string) => {
      const statement = prepare(sql);
      if (!sql.includes('DELETE FROM rt_menu_items')) return statement;
      const bind = statement.bind.bind(statement);
      statement.bind = (...args: unknown[]) => {
        const bound = bind(...args), run = bound.run.bind(bound);
        bound.run = async () => {
          testDb.raw.prepare("UPDATE rt_menu_items SET name='割り込み', confirmation_revision=confirmation_revision+1 WHERE id=?").run(id);
          return run();
        };
        return bound;
      };
      return statement;
    };
    expect((await requestWithMethod(`/api/restaurant-test/menus/${id}?account_id=account-1`, 'DELETE', {expectedVersion:1})).status).toBe(409);
    expect(testDb.raw.prepare('SELECT name, confirmation_revision FROM rt_menu_items WHERE id=?').get(id)).toEqual({name:'割り込み',confirmation_revision:2});
  });

  it('すでに削除済み、または読み取り後に削除されたメニューは404を返す', async () => {
    const testDb = context.testDb();
    seedRestaurantFixture();
    const path = '/api/restaurant-test/menus/missing?account_id=account-1';
    const missing = await requestWithMethod(path, 'DELETE', {expectedVersion:1});
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({error:'すでに削除されています'});
    const create = await request('/api/restaurant-test/menu?account_id=account-1', {storeId:'store-ginza',kind:'course',name:'削除候補',price:1000,status:'draft'});
    const id = (await create.json() as {data:{id:string}}).data.id;
    const prepare = testDb.db.prepare.bind(testDb.db);
    testDb.db.prepare = (sql: string) => {
      const statement = prepare(sql);
      if (!sql.includes('DELETE FROM rt_menu_items')) return statement;
      const bind = statement.bind.bind(statement);
      statement.bind = (...args: unknown[]) => {
        const bound = bind(...args), run = bound.run.bind(bound);
        bound.run = async () => { testDb.raw.prepare('DELETE FROM rt_menu_items WHERE id=?').run(id); return run(); };
        return bound;
      };
      return statement;
    };
    const raced = await requestWithMethod(`/api/restaurant-test/menus/${id}?account_id=account-1`, 'DELETE', {expectedVersion:1});
    expect(raced.status).toBe(404);
    expect(await raced.json()).toMatchObject({error:'すでに削除されています'});
  });

  it('版なしの従来本文は受け付け、読めない版の指定は拒む', async () => {
    context.seedRestaurantFixture();
    const create = async () => (await (await context.request('/api/restaurant-test/menu?account_id=account-1', {storeId:'store-ginza',kind:'course',name:'本文の互換',price:1000,status:'draft'})).json() as {data:{id:string}}).data.id;
    const first = await create();
    expect((await context.rawDelete(`/api/restaurant-test/menus/${first}?account_id=account-1`, 'legacy body')).status).toBe(200);
    const second = await create();
    expect((await context.rawDelete(`/api/restaurant-test/menus/${second}?account_id=account-1`, 'expectedVersion=1')).status).toBe(400);
    expect(context.testDb().raw.prepare('SELECT id FROM rt_menu_items WHERE id=?').get(second)).toEqual({id:second});
  });

  it('即時価格更新はメニューの確認版も進める', async () => {
    const testDb = context.testDb();
    seedRestaurantFixture();
    expect((await requestWithMethod(menuPath, 'PATCH', {price: 9900, expectedVersion: 1})).status).toBe(200);
    expect(testDb.raw.prepare("SELECT price, confirmation_revision FROM rt_menu_items WHERE id='menu-ginza'").get()).toEqual({price:9900, confirmation_revision:3});
    expect((await requestWithMethod(menuPath, 'PATCH', {status:'archived', expectedVersion:2})).status).toBe(409);
  });

}
