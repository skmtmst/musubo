import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { gapApp, gapCall, gapFixture } from '../test-utils/gap1.js';
import { useSqliteClock } from '../test-utils/sqlite-clock.js';
import { friends } from './friends.js';

const push = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@line-crm/line-sdk', async original => ({
  ...await original<typeof import('@line-crm/line-sdk')>(),
  LineClient: class { pushMessage = push; },
}));
let fixture: ReturnType<typeof gapFixture>;
beforeEach(() => {
  vi.useFakeTimers({toFake:['Date']}); vi.setSystemTime(new Date('2026-11-18T01:00:00Z'));
  fixture=gapFixture(); useSqliteClock(fixture.raw,()=>new Date()); push.mockClear();
});
afterEach(() => { fixture.raw.close(); vi.useRealTimers(); });
it('友だちへの直接送信は未解決の共通情報を送らない',async()=>{
  const app=gapApp(fixture,[friends]);
  const send=()=>gapCall(app,'/api/friends/f/messages','POST',{content:'営業時間: {{var.hours}}',trackLinks:false},'aaaaaaaa-1111-4111-8111-111111111111');
  const missing=await send(); expect(missing.status).toBe(422);
  expect(await missing.json()).toMatchObject({code:'UNRESOLVED_TEMPLATE_VARIABLES'});
  expect(push).not.toHaveBeenCalled();
  expect(fixture.raw.prepare('SELECT var_key,reason FROM common_var_resolution_failures').all()).toEqual([{var_key:'hours',reason:'missing'}]);
  fixture.raw.prepare("INSERT INTO common_vars(id,line_account_id,name,var_key,type,value) VALUES('hours','a','営業時間','hours','text','10時')").run();
  expect((await send()).status).toBe(200);
  expect(push).toHaveBeenCalledWith('Uf',[{type:'text',text:'営業時間: 10時'}],expect.any(String));
});
