import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { gapApp, gapCall, gapFixture } from '../test-utils/gap1.js';
import { useSqliteClock } from '../test-utils/sqlite-clock.js';

const effects=vi.hoisted(()=>({fireEvent:vi.fn(async(..._args:unknown[])=>undefined),pushMessage:vi.fn(async()=>({sentMessages:[{}]}))}));
vi.mock('../services/event-bus.js',async original=>({...await original<typeof import('../services/event-bus.js')>(),fireEvent:effects.fireEvent}));
vi.mock('@line-crm/line-sdk',async original=>({...await original<typeof import('@line-crm/line-sdk')>(),LineClient:class {pushMessage=effects.pushMessage}}));
const {chats}=await import('./chats.js');
let fixture:ReturnType<typeof gapFixture>;
beforeEach(()=>{
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-11-18T01:00:00Z'));
 fixture=gapFixture();useSqliteClock(fixture.raw,()=>new Date());vi.clearAllMocks();
 fixture.raw.prepare("INSERT INTO chats(id,friend_id,status,created_at,updated_at) VALUES('chat','f','unread','2026-11-18','2026-11-18')").run();
});
afterEach(()=>{fixture.raw.close();vi.useRealTimers()});
it('担当割当と手動返信の発生元は保存された識別子になる',async()=>{
 const app=gapApp(fixture,[chats]);
 const assigned=await gapCall(app,'/api/chats/chat','PUT',{operatorId:'staff:s',revision:0});expect(assigned.status).toBe(200);
 const assignment=fixture.raw.prepare("SELECT correlation_id FROM inbox_conversation_events WHERE event_type='assignment'").get() as {correlation_id:string};
 expect(assignment?.correlation_id).toBeTruthy();
 expect(effects.fireEvent.mock.calls.find(call=>call[1]==='staff_assigned')?.[2]).toMatchObject({sourceEventId:assignment.correlation_id,friendId:'f'});
 const response=await gapCall(app,'/api/chats/f/send','POST',{content:'ご連絡します',revision:1},'aaaaaaaa-1111-4111-8111-111111111111');
 expect(response.status).toBe(200);
 const message=fixture.raw.prepare("SELECT id FROM messages_log WHERE friend_id='f' AND direction='outgoing'").get() as {id:string};
 expect(message?.id).toBeTruthy();
 expect(effects.fireEvent.mock.calls.find(call=>call[1]==='manual_reply_sent')?.[2]).toMatchObject({sourceEventId:message.id,friendId:'f'});
});
