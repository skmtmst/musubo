import {beforeEach,afterEach,expect,test,vi} from 'vitest';
import {Hono} from 'hono';
import {lineProxy} from './line-proxy.js';
import type { Env } from '../worker-env.js';
import {gapFixture} from '../test-utils/gap1.js';
import type {SqliteD1} from '../test-utils/d1-sqlite.js';
import {upsertChatOnMessage} from '@line-crm/db';
let d:SqliteD1;
beforeEach(()=>{d=gapFixture();d.raw.exec("UPDATE line_accounts SET channel_access_token='other-token' WHERE id='b'");vi.stubGlobal('fetch',vi.fn(async()=>new Response('{"sentMessages":[]}',{status:200,headers:{'Content-Type':'application/json'}})));});
afterEach(()=>{d.raw.close();vi.unstubAllGlobals();});
test('SLA-12 SLA-13: Proxyの自動pushで時計を止めず、manualヘッダの返信だけで止める',async()=>{
 const uid='U'+'a'.repeat(32);d.raw.prepare("UPDATE friends SET line_user_id=? WHERE id='f'").run(uid);
 const chat=await upsertChatOnMessage(d.db,'f'),a=new Hono<Env>();a.route('/',lineProxy);
 const send=(manual=false)=>a.request('/line-api/v2/bot/message/push',{method:'POST',headers:{Authorization:'Bearer test-token','Content-Type':'application/json','X-Line-Account-Id':'a',...(manual?{'X-Line-Harness-Source':'manual'}:{})},body:JSON.stringify({to:uid,messages:[{type:'text',text:'返信'}]})},{DB:d.db} as Env['Bindings']);
 expect((await send()).status).toBe(200);expect(d.raw.prepare('SELECT first_response_at,last_operator_message_at FROM chats WHERE id=?').get(chat.id)).toEqual({first_response_at:null,last_operator_message_at:null});
 expect((await send(true)).status).toBe(200);const row=d.raw.prepare('SELECT first_response_at,last_operator_message_at FROM chats WHERE id=?').get(chat.id) as any;expect(row.first_response_at).toBeTruthy();expect(row.first_response_at).toBe(row.last_operator_message_at);
 expect(d.raw.prepare('SELECT responder_staff_id FROM inbox_response_samples WHERE chat_id=?').get(chat.id)).toEqual({responder_staff_id:null});
});
