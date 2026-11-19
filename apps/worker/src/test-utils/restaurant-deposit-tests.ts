import { expect, it } from 'vitest';
import type { SqliteD1 } from './d1-sqlite.js';

export function registerRestaurantDepositTests(getDb: () => SqliteD1, seedRestaurantFixture: () => void, request: (path: string) => Response | Promise<Response>, requestWithMethod: (path: string, method: string, body: unknown) => Response | Promise<Response>) {
it('飲食コースの予約金は版を守り、通常メニューの設定と混ざらない',async()=>{
 seedRestaurantFixture();
 const path='/api/restaurant-test/menus/menu-ginza/deposit?account_id=account-2';
 const body={kind:'percent',value:30,conditions:{always:true,minPeople:null,weekdays:null,timeBand:null},inherit:false,expectedVersion:0};
 expect((await requestWithMethod(path,'PUT',body)).status).toBe(409);
 getDb().raw.prepare("INSERT INTO booking_cancellation_policies(line_account_id,enabled,tiers_json,no_show_percent,updated_by,updated_at) VALUES(?,1,?,100,'staff',datetime('now'))").run('account-2',JSON.stringify([{beforeHours:24,percent:0},{beforeHours:0,percent:50}]));
 const saved=await requestWithMethod(path,'PUT',body);expect(saved.status,await saved.text()).toBe(200);
 expect((await requestWithMethod(path,'PUT',body)).status).toBe(409);
 expect(await (await request(path)).json()).toMatchObject({data:{kind:'percent',value:30,version:1}});
 expect(getDb().raw.prepare("SELECT scope_id FROM booking_deposit_rules WHERE account_id='account-2'").all()).toEqual([{scope_id:'course:menu-ginza'}]);
});
}
